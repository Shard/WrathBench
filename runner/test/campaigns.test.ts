/**
 * The campaign model: the store row joined to its published definition, the
 * refusals, and the one tally — per (assignment, arm, cell) — the scheduler
 * derives its work from and the campaigns page its progress.
 */

import { describe, expect, test } from "bun:test";
import { cellDimensions } from "../src/campaign-def";
import {
  campaignAssignments,
  campaignPairRefusals,
  campaignProgress,
  campaignSquares,
  campaignWork,
  parseCampaignBlocks,
  parseCampaignDefinitions,
  type Campaign,
  type ProbeRun,
} from "../src/campaigns";
import { checkedIn, defsBlock, definition, joined, publication } from "./fixtures/campaigns";

const one = definition({ id: "one", maxAttemptsPerCell: 3 });
const two = definition({
  id: "two",
  arms: [
    { id: "a", image: "r.example/wb:t1" },
    { id: "b", image: "r.example/wb:t2" },
  ],
  maxAttemptsPerCell: 2,
});
const CATALOG = ["m1", "m2", "m3"];

function campaign(def = one, row: Record<string, unknown> = {}): Campaign {
  const { campaigns } = joined([def], { [def.id]: { version: def.version, assignments: [{ model: "m1" }, { model: "m2" }], ...row } });
  return campaigns[0]!;
}

function run(over: Partial<ProbeRun>): ProbeRun {
  return { campaign: "one", version: 1, cell: "a", ref: "m1", arm: "base", counted: true, live: false, ...over };
}

describe("the store row", () => {
  test("a row names a published version and joins its definition", () => {
    const c = campaign(one, { account: "SHAKEOUT", excludeUnhealthy: false });
    expect(c).toMatchObject({ name: "one", version: 1, enabled: true, account: "SHAKEOUT", excludeUnhealthy: false, resume: true, maxAttemptsPerCell: 3 });
    expect(c.arms.map((a) => a.id)).toEqual(["base"]);
    expect(c.published.hash).toBe(publication(one).hash);
  });

  test("declaration order is preserved, because it is the last tie-break", () => {
    const { campaigns } = joined([one, two], { two: { version: 1 }, one: { version: 1 } });
    expect(campaigns.map((c) => c.name)).toEqual(["two", "one"]);
  });

  test("any key a row does not have is refused, generically and on the spot", () => {
    for (const key of ["cells", "objective", "models", "runsPerCell", "arms", "image"]) {
      expect(() => parseCampaignBlocks(defsBlock(one), { one: { version: 1, [key]: [] } })).toThrow(/campaign one/);
    }
    expect(() => parseCampaignBlocks(defsBlock(one), { one: { enabled: true } })).toThrow(/version/);
  });

  test("a row naming an unpublished version is refused by key, and the rest still load", () => {
    const r = parseCampaignBlocks(defsBlock(one), { one: { version: 1 }, ghost: { version: 4 } });
    expect(r.campaigns.map((c) => c.name)).toEqual(["one"]);
    expect(r.refused).toEqual([{ key: "campaigns/ghost", campaign: "ghost", reason: expect.stringContaining("ghost@4 is not published") }]);
  });

  test("a campaign keeps every published version of its id, so a paused run can follow its own", () => {
    const v2 = definition({ id: "one", version: 2 });
    const { campaigns } = joined([one, v2], { one: { version: 2 } });
    expect(campaigns[0]!.versions.map((p) => p.def.version).sort()).toEqual([1, 2]);
  });
});

describe("the published definitions", () => {
  test("a row that no longer checks out is refused by key, and never takes the rest down", () => {
    const tampered = { ...publication(one), definition: { ...one, question: "edited" } };
    const r = parseCampaignDefinitions({ "one@1": tampered, "two@1": publication(two), "x@1": { nope: true }, "one@2": publication(one) });
    expect(r.definitions.map((d) => d.ref)).toEqual(["two@1"]);
    expect(r.refused.map((x) => x.key)).toEqual(["campaign-defs/one@1", "campaign-defs/x@1", "campaign-defs/one@2"]);
    expect(r.refused[0]!.reason).toContain("edited after publication");
    expect(r.refused[2]!.reason).toContain("holds one@1");
  });

  test("the block itself must be an object", () => {
    expect(() => parseCampaignDefinitions([])).toThrow(/campaign-defs/);
  });
});

describe("pairs that cannot launch", () => {
  const windows = definition({
    id: "w",
    arms: [
      { id: "auto", image: "r.example/wb:t1" },
      { id: "w200k", image: "r.example/wb:t1", args: ["--compact-window", "200k"] },
    ],
  });

  test("an arm setting the window refuses an entry that sets one too, and any entry off claude-code", () => {
    const roster = { plain: { driver: "claude-code" }, windowed: { driver: "claude-code", compactWindow: "100k" }, astra: { driver: "codex" }, glm: {} };
    const c = joined([windows], { w: { version: 1, assignments: ["plain", "windowed", "astra", "glm"].map((model) => ({ model })) } }).campaigns[0]!;
    const refused = campaignPairRefusals(c, roster);
    expect(refused.map((p) => `${p.ref}:${p.arm}`)).toEqual(["windowed:w200k", "astra:w200k", "glm:w200k"]);
    expect(refused[0]!.reason).toContain("already sets compactWindow 100k");
    expect(refused[1]!.reason).toContain("codex driver");
    expect(refused[2]!.reason).toContain("openai driver");
  });

  test("read with the roster, they are refused by `<id>@<v>:<ref>:<arm>` and their squares are never work", () => {
    const r = parseCampaignBlocks(defsBlock(windows), { w: { version: 1, assignments: [{ model: "windowed" }] } }, { windowed: { driver: "claude-code", compactWindow: "100k" } });
    expect(r.refused).toEqual([{ key: "w@1:windowed:w200k", reason: expect.stringContaining("already sets compactWindow") }]);
    const c = r.campaigns[0]!;
    const work = campaignWork([c], ["windowed"], []);
    expect(new Set(work.map((w) => w.arm.id))).toEqual(new Set(["auto"]));
    const squares = campaignSquares(c, ["windowed"], []);
    expect(squares.filter((s) => s.refused !== null).map((s) => s.arm.id)).toEqual(["w200k", "w200k"]);
  });
});

describe("model selection", () => {
  test("assignments are intersected with the catalog, so a stale name is dropped not fatal", () => {
    expect(campaignAssignments(campaign(one, { assignments: [{ model: "gone" }, { model: "m2" }] }), CATALOG).map((a) => a.model)).toEqual(["m2"]);
  });

  test("excludeUnhealthy filters, and turning it off keeps every name", () => {
    const sick = (n: string): boolean => n !== "m1";
    expect(campaignAssignments(campaign(), CATALOG, sick).map((a) => a.model)).toEqual(["m2"]);
    expect(campaignAssignments(campaign(one, { excludeUnhealthy: false }), CATALOG, sick).map((a) => a.model)).toEqual(["m1", "m2"]);
  });
});

describe("the squares", () => {
  test("one per assignment × cell × arm; want = cells × arms × Σ runsPerCell", () => {
    const c = campaign(two, { assignments: [{ model: "m1", runsPerCell: 2 }, { model: "m2" }] });
    const squares = campaignSquares(c, CATALOG, []);
    expect(squares).toHaveLength(2 * 2 * 2);
    expect(campaignProgress(squares)).toEqual({ want: 2 * 2 * (2 + 1), done: 0, attempted: 0, capped: 0, live: 0 });
  });

  test("a run belongs to a square by its own stamps only: campaign, version, ref, arm and cell", () => {
    const c = campaign(two);
    const stamps: ProbeRun[] = [
      run({ campaign: "two", arm: "a" }),
      run({ campaign: "two", arm: null }), // before arms
      run({ campaign: "two", ref: null, arm: "a" }), // no roster name
      run({ campaign: "two", version: 2, arm: "a" }), // another version
      run({ campaign: "one", arm: "a" }), // another campaign
      run({ campaign: "two", arm: "nope" }), // an arm the definition lacks
    ];
    const done = campaignSquares(c, CATALOG, stamps).filter((s) => s.attempts > 0);
    expect(done.map((s) => `${s.ref}/${s.arm.id}/${s.cell.id}:${s.done}`)).toEqual(["m1/a/a:1"]);
  });

  test("`done` and `capped` settle a square in both the count and the state, so complete is done + capped = want", () => {
    const c = campaign(two, { assignments: [{ model: "m1" }] });
    const runs = [
      run({ campaign: "two", cell: "a", arm: "a" }),
      run({ campaign: "two", cell: "a", arm: "b", counted: false }),
      run({ campaign: "two", cell: "a", arm: "b", counted: false }),
      run({ campaign: "two", cell: "b", arm: "a" }),
      run({ campaign: "two", cell: "b", arm: "b" }),
    ];
    const squares = campaignSquares(c, CATALOG, runs);
    expect(squares.map((s) => s.settled)).toEqual(["done", "capped", "done", "done"]);
    const p = campaignProgress(squares);
    expect(p).toEqual({ want: 4, done: 3, attempted: 5, capped: 1, live: 0 });
    expect(p.done + p.capped).toBe(p.want);
    expect(campaignWork([c], CATALOG, runs)).toEqual([]);
  });

  test("a square at its cap with a run still in flight is not capped yet — that run may count — and is not launched again", () => {
    const c = campaign(two, { assignments: [{ model: "m1" }] });
    const runs = [run({ campaign: "two", arm: "a", counted: false }), run({ campaign: "two", arm: "a", counted: false, live: true })];
    const sq = campaignSquares(c, CATALOG, runs).find((s) => s.arm.id === "a" && s.cell.id === "a")!;
    expect(sq).toMatchObject({ attempts: 2, live: 1, settled: null });
    expect(campaignWork([c], CATALOG, runs).some((w) => w.arm.id === "a" && w.cell.id === "a")).toBe(false);
  });

  test("counted runs past runsPerCell never inflate progress", () => {
    const c = campaign(one, { assignments: [{ model: "m1" }] });
    const p = campaignProgress(campaignSquares(c, CATALOG, [run({}), run({}), run({})]));
    expect(p.done).toBe(1);
  });
});

describe("the fan-out", () => {
  test("every square owes a run when nothing has been done", () => {
    expect(campaignWork([campaign(two)], CATALOG, [])).toHaveLength(2 * 2 * 2);
  });

  test("a disabled campaign owes nothing", () => {
    expect(campaignWork([campaign(one, { enabled: false })], CATALOG, [])).toEqual([]);
  });

  test("a sweep spreads across models before finishing one, and across arms within a model", () => {
    const c = campaign(two);
    const runs = [run({ campaign: "two", ref: "m1", arm: "a", cell: "a" })];
    const order = campaignWork([c], CATALOG, runs).map((w) => `${w.model}/${w.arm.id}/${w.cell.id}`);
    // m2 has done nothing, so it goes first; within m1 the arm that has done
    // least goes before the cells of the arm that has a run.
    expect(order.slice(0, 4).every((k) => k.startsWith("m2/"))).toBe(true);
    expect(order[4]).toBe("m1/b/a");
  });

  test("a failed launch satisfies nothing, so an uncapped square is swept again", () => {
    const c = campaign(definition({ id: "one", maxAttemptsPerCell: null }), { assignments: [{ model: "m1" }] });
    const runs = [1, 2, 3, 4].map(() => run({ counted: false }));
    expect(campaignWork([c], CATALOG, runs).some((w) => w.cell.id === "a")).toBe(true);
  });

  test("healthy is asked only when excludeUnhealthy is on", () => {
    const sick = (n: string): boolean => n !== "m1";
    expect(new Set(campaignWork([campaign()], CATALOG, [], sick).map((w) => w.model))).toEqual(new Set(["m2"]));
    expect(new Set(campaignWork([campaign(one, { excludeUnhealthy: false })], CATALOG, [], sick).map((w) => w.model))).toEqual(new Set(["m1", "m2"]));
  });
});

describe("a cell's dimensions", () => {
  test("come from the definition alone: start, leash, wiki, objective and stopping rule", () => {
    const race = checkedIn("race-probe@1");
    expect(cellDimensions(race, race.cells.find((c) => c.id === "bloodelf-rogue")!)).toEqual({
      race: 10,
      class: 4,
      watchdogs: { idleMs: 1_200_000, noXpMs: null, episodeMs: 43_200_000 },
      maxToolCalls: 24_000,
      wikiCoords: false,
      wiki: true,
      stopAtLevel: 10,
    });
  });
});
