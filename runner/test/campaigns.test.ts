/**
 * The campaign fan-out (ADR-0041).
 *
 * The assertions worth having here are about the three properties the design
 * rests on rather than about the plumbing: that completion is derived from runs
 * on disk (so deleting and re-adding a campaign resumes rather than restarts),
 * that a sweep spreads across models before finishing one, and that a
 * catalog-only entry — one with no tier and therefore no `ModelState` — is a
 * member rather than being silently dropped.
 */

import { describe, expect, test } from "bun:test";
import {
  campaignComplete,
  campaignModels,
  campaignWork,
  parseCampaigns,
  workDimensions,
  type Campaign,
  type ProbeRun,
} from "../src/campaigns";

const CELLS = [
  { id: "human-warrior", race: 1, class: 1 },
  { id: "dwarf-rogue", race: 3, class: 4 },
];

function campaign(over: Partial<Campaign> = {}): Campaign {
  return {
    name: "class-probe",
    enabled: true,
    objective: "play this class",
    models: "all",
    excludeUnhealthy: true,
    resume: false,
    runsPerCell: 1,
    cells: CELLS,
    ...over,
  } as Campaign;
}

const ran = (campaign: string, ref: string, cell: string): ProbeRun => ({ campaign, ref, cell });

describe("parsing", () => {
  test("declaration order is preserved, because it is the last tie-break", () => {
    const cs = parseCampaigns({
      "z-first": { objective: "z", cells: [{ id: "a" }] },
      "a-second": { objective: "a", cells: [{ id: "a" }] },
    });
    expect(cs.map((c) => c.name)).toEqual(["z-first", "a-second"]);
  });

  test("defaults are the safe ones: enabled, all models, one run per cell, skip unhealthy", () => {
    const [c] = parseCampaigns({ p: { objective: "o", cells: [{ id: "a" }] } });
    // `resume: false` with the rest: a probe that pauses is re-swept, not
    // continued, unless the campaign says otherwise (ADR-0049).
    expect(c).toMatchObject({ enabled: true, models: "all", runsPerCell: 1, excludeUnhealthy: true, resume: false });
    expect(parseCampaigns({ p: { objective: "o", cells: [{ id: "a" }], resume: true } })[0]!.resume).toBe(true);
  });

  test("an unknown key is refused rather than ignored", () => {
    // A typo'd campaign key that parsed would run the wrong sweep silently.
    expect(() => parseCampaigns({ p: { objective: "o", cells: [{ id: "a" }], runsPerCel: 3 } })).toThrow();
  });

  test("a campaign with no cells is refused: there is nothing to sweep", () => {
    expect(() => parseCampaigns({ p: { objective: "o", cells: [] } })).toThrow();
  });
});

describe("model selection", () => {
  const catalog = ["a", "b", "c"];

  test('"all" means the whole catalog, including an entry with no tier', () => {
    expect(campaignModels(campaign(), catalog)).toEqual(["a", "b", "c"]);
  });

  test("an explicit list is intersected with the catalog, so a stale name is dropped not fatal", () => {
    expect(campaignModels(campaign({ models: ["b", "gone"] }), catalog)).toEqual(["b"]);
  });

  test("excludeUnhealthy filters, and a name the projection has never heard of stays in", () => {
    // The load-bearing case: a catalog-only entry has no ModelState at all, and
    // absence from the projection means "never eval-scheduled", not "unhealthy".
    const eligible = (n: string): boolean => n !== "b";
    expect(campaignModels(campaign(), catalog, eligible)).toEqual(["a", "c"]);
    expect(campaignModels(campaign({ excludeUnhealthy: false }), catalog, eligible)).toEqual(catalog);
  });
});

describe("the fan-out", () => {
  const catalog = ["a", "b"];

  test("every (model, cell) owes a run when nothing has been done", () => {
    const w = campaignWork([campaign()], catalog, []);
    expect(w.length).toBe(4);
    expect(w.map((x) => `${x.model}/${x.cell.id}`).sort()).toEqual([
      "a/dwarf-rogue",
      "a/human-warrior",
      "b/dwarf-rogue",
      "b/human-warrior",
    ]);
  });

  test("completion is derived from runs on disk, so re-adding a campaign resumes", () => {
    const done = [ran("class-probe", "a", "human-warrior"), ran("class-probe", "a", "dwarf-rogue")];
    const w = campaignWork([campaign()], catalog, done);
    // Model `a` is finished; nothing was written to say so.
    expect(w.every((x) => x.model === "b")).toBe(true);
    expect(w.length).toBe(2);
  });

  test("runsPerCell above one is respected and reports its own progress", () => {
    const w = campaignWork([campaign({ runsPerCell: 3 })], ["a"], [ran("class-probe", "a", "human-warrior")]);
    const hw = w.find((x) => x.cell.id === "human-warrior")!;
    expect(hw).toMatchObject({ done: 1, want: 3 });
  });

  test("a sweep spreads across models before finishing one", () => {
    // `a` has already done a cell, so `b` is picked next even though `a` still
    // owes one: breadth first is what makes an interrupted sweep informative.
    const w = campaignWork([campaign()], catalog, [ran("class-probe", "a", "human-warrior")]);
    expect(w[0]!.model).toBe("b");
  });

  test("a disabled campaign owes nothing, and its runs are not forgotten", () => {
    expect(campaignWork([campaign({ enabled: false })], catalog, [])).toEqual([]);
  });

  test("runs of another campaign never satisfy this one's cells", () => {
    const w = campaignWork([campaign()], ["a"], [ran("other", "a", "human-warrior")]);
    expect(w.length).toBe(2);
  });

  test("a run that recorded no campaign or cell is ignored rather than miscounted", () => {
    const loose: ProbeRun[] = [
      { campaign: null, cell: "human-warrior", ref: "a" },
      { campaign: "class-probe", cell: null, ref: "a" },
      { campaign: "class-probe", cell: "human-warrior", ref: null },
    ];
    expect(campaignWork([campaign()], ["a"], loose).length).toBe(2);
  });

  test("campaign declaration order breaks a tie between two campaigns", () => {
    const first = campaign({ name: "first", cells: [{ id: "x" }] });
    const second = campaign({ name: "second", cells: [{ id: "x" }] });
    const w = campaignWork([first, second], ["a"], []);
    expect(w.map((x) => x.campaign)).toEqual(["first", "second"]);
  });

  test("campaignComplete is the same question asked of one campaign", () => {
    const c = campaign({ cells: [{ id: "x" }] });
    expect(campaignComplete(c, ["a"], [])).toBe(false);
    expect(campaignComplete(c, ["a"], [ran("class-probe", "a", "x")])).toBe(true);
  });
});

describe("dimensions", () => {
  test("a cell overrides the campaign, and the campaign supplies the rest", () => {
    const c = campaign({ objective: "campaign says", wikiCoords: true, maxToolCalls: 100 });
    const d = workDimensions(c, { id: "x", objective: "cell says", race: 4 });
    expect(d).toMatchObject({ objective: "cell says", wikiCoords: true, maxToolCalls: 100, race: 4 });
  });

  test("watchdogs merge, so a cell lengthening the clock cannot re-enable a disabled watchdog", () => {
    const c = campaign({ watchdogs: { noXpMs: null, idleMs: 1_200_000 } });
    const d = workDimensions(c, { id: "x", watchdogs: { episodeMs: 7_200_000 } });
    expect(d.watchdogs).toEqual({ noXpMs: null, idleMs: 1_200_000, episodeMs: 7_200_000 });
  });

  test("nothing set anywhere yields nothing, so the episode table's defaults stand", () => {
    expect(workDimensions(campaign({ objective: undefined }) as Campaign, { id: "x" })).toEqual({});
  });
});
