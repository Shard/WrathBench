/**
 * The campaign fan-out, and the store row it reads.
 *
 * The assertions worth having are about the properties the design rests on
 * rather than the plumbing: that completion is derived from runs on disk (so
 * deleting and re-adding a campaign resumes rather than restarts), that work
 * is counted per (campaign, VERSION, roster name, cell) so a newer version is
 * never credited with an older one's runs, that a sweep spreads across models
 * before finishing one, and that the store row holds only the dynamic half —
 * every static key is refused by name and the pre-definition shape still loads.
 */

import { describe, expect, test } from "bun:test";
import type { OpenCampaignDef } from "../src/campaign-defs";
import {
  campaignComplete,
  campaignModels,
  campaignWork,
  cellDimensions,
  parseCampaigns,
  type Campaign,
  type ProbeRun,
} from "../src/campaigns";

const DEF: OpenCampaignDef = {
  id: "test-probe",
  version: 2,
  status: "open",
  question: "q",
  cells: [
    { id: "human-warrior", race: 1, class: 1 },
    { id: "dwarf-rogue", race: 3, class: 4 },
  ],
  objective: null,
  stopAtLevel: 10,
  budget: { episodeMs: 43_200_000, idleMs: 1_200_000, noXpMs: null, maxToolCalls: 24_000 },
  wikiCoords: false,
  wiki: true,
  resume: true,
  maxAttemptsPerCell: null,
};

function campaign(over: Partial<Campaign> & { def?: OpenCampaignDef } = {}): Campaign {
  const def = over.def ?? DEF;
  return {
    name: def.id,
    version: def.version,
    def,
    enabled: true,
    assignments: [
      { model: "a", runsPerCell: 1 },
      { model: "b", runsPerCell: 1 },
    ],
    excludeUnhealthy: true,
    cells: def.cells,
    resume: def.resume,
    ...(def.maxAttemptsPerCell !== null ? { maxAttemptsPerCell: def.maxAttemptsPerCell } : {}),
    ...over,
  };
}

const ran = (ref: string, cell: string, version = 2): ProbeRun => ({ campaign: "test-probe", version, ref, cell, counted: true });
/** A launch that failed: it spends an attempt and satisfies no cell. */
const failed = (ref: string, cell: string): ProbeRun => ({ campaign: "test-probe", version: 2, ref, cell, counted: false });

describe("the store row", () => {
  test("a row names a checked-in version and nothing static", () => {
    const { campaigns, refused } = parseCampaigns({
      "race-probe": { version: 1, enabled: true, assignments: [{ model: "codex-sol-61" }] },
    });
    expect(refused).toEqual([]);
    expect(campaigns).toHaveLength(1);
    const c = campaigns[0]!;
    expect(c).toMatchObject({ name: "race-probe", version: 1, enabled: true, excludeUnhealthy: true, resume: true, maxAttemptsPerCell: 3 });
    // runsPerCell defaults to one per assignment; the cells are the definition's.
    expect(c.assignments).toEqual([{ model: "codex-sol-61", runsPerCell: 1 }]);
    expect(c.cells.map((x) => x.id)).toContain("bloodelf-rogue");
  });

  test("declaration order is preserved, because it is the last tie-break", () => {
    const { campaigns } = parseCampaigns({
      "race-probe": { version: 1, enabled: false },
      "class-probe": { version: 2, enabled: false },
    });
    expect(campaigns.map((c) => c.name)).toEqual(["race-probe", "class-probe"]);
  });

  test("every static key is refused by name and pointed at the definition", () => {
    for (const key of ["cells", "objective", "watchdogs", "maxToolCalls", "wikiCoords", "race", "class", "resume", "maxAttemptsPerCell", "stopAtLevel"]) {
      expect(() => parseCampaigns({ "race-probe": { version: 1, [key]: 1 } })).toThrow(/definition's, not the store's/);
    }
  });

  test("the retired keys are refused with their replacement", () => {
    expect(() => parseCampaigns({ "race-probe": { version: 1, models: ["a"] } })).toThrow(/assignments/);
    expect(() => parseCampaigns({ "race-probe": { version: 1, runsPerCell: 2 } })).toThrow(/assignments/);
  });

  test("an unknown key is refused rather than ignored", () => {
    expect(() => parseCampaigns({ "race-probe": { version: 1, enabeld: true } })).toThrow();
    expect(() => parseCampaigns({ "race-probe": { version: 1, assignments: [{ model: "a", runs: 3 }] } })).toThrow();
  });

  test("a version this checkout has no definition for is refused by name, and the rest still load", () => {
    const { campaigns, refused } = parseCampaigns({
      "race-probe": { version: 9, enabled: true },
      "class-probe": { version: 2, enabled: true },
    });
    expect(campaigns.map((c) => `${c.name}@${c.version}`)).toEqual(["class-probe@2"]);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.why).toContain("race-probe@9 has no definition");
  });

  test("a closed definition may be named but never switched on", () => {
    expect(parseCampaigns({ "class-probe": { version: 1, enabled: false } }).campaigns).toHaveLength(1);
    const { campaigns, refused } = parseCampaigns({ "class-probe": { version: 1, enabled: true } });
    expect(campaigns).toEqual([]);
    expect(refused[0]!.why).toContain("closed");
    // The cells it would have spawned under ride the refusal, so a live run is spared.
    expect(refused[0]!.cells).toContain("nightelf-hunter");
  });

  test("the pre-definition shape loads onto the version that claims the id's unversioned runs", () => {
    // The two rows the live store held when definitions moved into git, as written.
    const { campaigns, refused } = parseCampaigns({
      "nav-probe": {
        enabled: true,
        account: "SHAKEOUT",
        models: ["sonnet"],
        objective: "Travel from Coldridge Valley to Ironforge…",
        watchdogs: { episodeMs: 21_600_000, noXpMs: null, idleMs: 1_200_000 },
        maxToolCalls: 2500,
        wikiCoords: true,
        runsPerCell: 1,
        cells: [{ id: "coldridge", race: 3, class: 2 }],
      },
      "class-probe": {
        enabled: false,
        models: ["muse-spark"],
        resume: true,
        maxAttemptsPerCell: 3,
        runsPerCell: 1,
        cells: [{ id: "human-warrior", race: 1, class: 1 }],
      },
    });
    expect(refused).toEqual([]);
    const [nav, cls] = campaigns;
    expect(nav).toMatchObject({ name: "nav-probe", version: 1, enabled: true, account: "SHAKEOUT", migrated: true });
    expect(nav!.assignments).toEqual([{ model: "sonnet", runsPerCell: 1 }]);
    // The inline shape is dropped, not merged: the definition is the shape.
    expect(nav!.def.status === "open" && nav!.def.budget.maxToolCalls).toBe(2500);
    expect(cls).toMatchObject({ name: "class-probe", version: 1, enabled: false, migrated: true });
    expect(cls!.def.status).toBe("closed");
  });

  test("an old-shape row that no definition claims is refused by name", () => {
    const { campaigns, refused } = parseCampaigns({ "adhoc-sweep": { models: ["a"], cells: [{ id: "x" }] } });
    expect(campaigns).toEqual([]);
    expect(refused[0]!.why).toContain("pre-definition shape");
  });
});

describe("model selection", () => {
  const catalog = ["a", "b", "c"];

  test("assignments are intersected with the catalog, so a stale name is dropped not fatal", () => {
    expect(campaignModels(campaign({ assignments: [{ model: "b", runsPerCell: 1 }, { model: "gone", runsPerCell: 1 }] }), catalog)).toEqual(["b"]);
  });

  test("excludeUnhealthy filters, and a name the projection has never heard of stays in", () => {
    const eligible = (n: string): boolean => n !== "b";
    expect(campaignModels(campaign(), catalog, eligible)).toEqual(["a"]);
    expect(campaignModels(campaign({ excludeUnhealthy: false }), catalog, eligible)).toEqual(["a", "b"]);
  });
});

describe("the fan-out", () => {
  const catalog = ["a", "b"];

  test("every (assignment, cell) owes a run when nothing has been done", () => {
    const w = campaignWork([campaign()], catalog, []);
    expect(w.map((x) => `${x.model}/${x.cell.id}`).sort()).toEqual(["a/dwarf-rogue", "a/human-warrior", "b/dwarf-rogue", "b/human-warrior"]);
    expect(w.every((x) => x.version === 2)).toBe(true);
  });

  test("completion is derived from runs on disk, so re-adding a campaign resumes", () => {
    const w = campaignWork([campaign()], catalog, [ran("a", "human-warrior"), ran("a", "dwarf-rogue")]);
    expect(w.every((x) => x.model === "b")).toBe(true);
    expect(w.length).toBe(2);
  });

  test("work is counted per version: an older version's run never satisfies a newer one's cell", () => {
    // v2 reuses v1's cell ids; a v1 run of `a` on human-warrior is not v2 work.
    const w = campaignWork([campaign({ assignments: [{ model: "a", runsPerCell: 1 }] })], ["a"], [ran("a", "human-warrior", 1)]);
    expect(w.map((x) => x.cell.id)).toEqual(["human-warrior", "dwarf-rogue"]);
    expect(w[0]!.done).toBe(0);
  });

  test("a run whose version is unknown counts toward nothing", () => {
    const w = campaignWork([campaign({ assignments: [{ model: "a", runsPerCell: 1 }] })], ["a"], [{ ...ran("a", "human-warrior"), version: null }]);
    expect(w).toHaveLength(2);
  });

  test("runsPerCell is the assignment's own, and reports its progress", () => {
    const c = campaign({ assignments: [{ model: "a", runsPerCell: 3 }, { model: "b", runsPerCell: 1 }] });
    const w = campaignWork([c], catalog, [ran("a", "human-warrior")]);
    expect(w.find((x) => x.model === "a" && x.cell.id === "human-warrior")).toMatchObject({ done: 1, want: 3 });
    expect(w.find((x) => x.model === "b" && x.cell.id === "human-warrior")).toMatchObject({ done: 0, want: 1 });
  });

  test("a sweep spreads across models before finishing one", () => {
    const w = campaignWork([campaign()], catalog, [ran("a", "human-warrior")]);
    expect(w[0]!.model).toBe("b");
  });

  test("assignment order is model priority when nothing else separates them", () => {
    const c = campaign({ assignments: [{ model: "b", runsPerCell: 1 }, { model: "a", runsPerCell: 1 }] });
    expect(campaignWork([c], catalog, [])[0]!.model).toBe("b");
  });

  test("a disabled campaign owes nothing, and its runs are not forgotten", () => {
    expect(campaignWork([campaign({ enabled: false })], catalog, [])).toEqual([]);
    // Complete is about the sweep, not the switch: a disabled sweep with work left is not complete.
    expect(campaignComplete(campaign({ enabled: false }), catalog, [])).toBe(false);
  });

  test("runs of another campaign never satisfy this one's cells", () => {
    const w = campaignWork([campaign({ assignments: [{ model: "a", runsPerCell: 1 }] })], ["a"], [{ ...ran("a", "human-warrior"), campaign: "other" }]);
    expect(w.length).toBe(2);
  });

  test("a run that recorded no campaign, cell or ref is ignored rather than miscounted", () => {
    const loose: ProbeRun[] = [
      { campaign: null, version: 2, cell: "human-warrior", ref: "a", counted: true },
      { campaign: "test-probe", version: 2, cell: null, ref: "a", counted: true },
      { campaign: "test-probe", version: 2, cell: "human-warrior", ref: null, counted: true },
    ];
    expect(campaignWork([campaign({ assignments: [{ model: "a", runsPerCell: 1 }] })], ["a"], loose).length).toBe(2);
  });

  test("a closed definition launches nothing", () => {
    const { campaigns } = parseCampaigns({ "class-probe": { version: 1, enabled: false } });
    expect(campaignWork([{ ...campaigns[0]!, enabled: true, assignments: [{ model: "a", runsPerCell: 1 }] }], ["a"], [])).toEqual([]);
  });

  test("a failed launch satisfies nothing, so an uncapped cell is swept again", () => {
    const w = campaignWork([campaign({ assignments: [{ model: "a", runsPerCell: 1 }] })], ["a"], [failed("a", "human-warrior")]);
    const hw = w.find((x) => x.cell.id === "human-warrior")!;
    expect(hw).toMatchObject({ done: 0, want: 1, attempts: 1 });
    expect(hw.maxAttempts).toBeUndefined();
  });

  test("a cell that keeps failing is abandoned once it has had the definition's launches", () => {
    const c = campaign({ assignments: [{ model: "a", runsPerCell: 1 }], maxAttemptsPerCell: 3, cells: [DEF.cells[0]!] });
    const tries = (n: number): ProbeRun[] => Array.from({ length: n }, () => failed("a", "human-warrior"));
    expect(campaignWork([c], ["a"], tries(2))[0]).toMatchObject({ done: 0, attempts: 2, maxAttempts: 3 });
    expect(campaignWork([c], ["a"], tries(3))).toEqual([]);
    expect(campaignWork([c], ["a"], tries(37))).toEqual([]);
  });

  test("a capped cell that succeeds completes on its counted runs, not its attempts", () => {
    const c = campaign({ assignments: [{ model: "a", runsPerCell: 1 }], maxAttemptsPerCell: 3, cells: [DEF.cells[0]!] });
    const runs = [failed("a", "human-warrior"), ran("a", "human-warrior")];
    expect(campaignWork([c], ["a"], runs)).toEqual([]);
    expect(campaignComplete(c, ["a"], runs)).toBe(true);
  });

  test("failures do not reorder the sweep: breadth is measured in counted runs", () => {
    const w = campaignWork([campaign()], catalog, [failed("a", "human-warrior")]);
    expect(w[0]!.model).toBe("a");
  });
});

describe("a cell's dimensions", () => {
  test("come from the definition alone: start, leash, wiki, objective and stopping rule", () => {
    expect(cellDimensions(DEF, DEF.cells[1]!)).toEqual({
      race: 3,
      class: 4,
      watchdogs: { idleMs: 1_200_000, noXpMs: null, episodeMs: 43_200_000 },
      maxToolCalls: 24_000,
      wikiCoords: false,
      wiki: true,
      stopAtLevel: 10,
    });
    expect(cellDimensions({ ...DEF, objective: "go", stopAtLevel: null }, DEF.cells[0]!)).toMatchObject({ objective: "go" });
    expect(cellDimensions({ ...DEF, stopAtLevel: null }, DEF.cells[0]!).stopAtLevel).toBeUndefined();
  });
});
