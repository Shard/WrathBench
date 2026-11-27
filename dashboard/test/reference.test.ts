/**
 * The ladder's two reference lines.
 *
 * What matters here is what the page is allowed to claim: the ceiling is a
 * maximum over the runs actually on hand and never a constant, the human band
 * is a band and carries its sources, and neither is offered where it would
 * compare two different budgets.
 */

import { describe, expect, test } from "bun:test";
import type { ResultRun } from "../../viewer/api-types";
import {
  HUMAN_SPEEDRUN_BANDS,
  empiricalCeiling,
  referenceScale,
  scriptedReference,
  scriptedReferenceScale,
  speedrunBand,
} from "../src/lib/reference";

/** The ninety-minute band: e90 is the tier most of the site is about. */
const E90_BAND = speedrunBand("e90")!;

function run(runId: string, maxLevel: number | null): ResultRun {
  return { runId, maxLevel } as unknown as ResultRun;
}

describe("the empirical e90 ceiling", () => {
  test("is the best level any run on hand reached, with the run and the tie count", () => {
    const c = empiricalCeiling([run("a", 6), run("b", 7), run("c", 6), run("d", 5)])!;
    expect(c.level).toBe(7);
    expect(c.runId).toBe("b");
    expect(c.at).toBe(1);
    expect(c.of).toBe(4);
    // The practical cluster below the ceiling — the shape the operator described.
    expect(c.next).toBe(6);
    expect(c.nextAt).toBe(2);
  });

  test("a run with no level reading is not recorded, not zero, and sets no ceiling", () => {
    const c = empiricalCeiling([run("a", null), run("b", 3), run("c", null)])!;
    expect(c.level).toBe(3);
    expect(c.of).toBe(1);
    expect(empiricalCeiling([run("a", null)])).toBeNull();
    // Nothing about any level is hardcoded: a run that beats it moves it.
    expect(empiricalCeiling([run("a", 6), run("b", 7), run("z", 11)])!.level).toBe(11);
    expect(empiricalCeiling([])).toBeNull();
  });
});

describe("the human speedrun band", () => {
  test("the e90 band is a band, not a point, and is stated at the e90 budget", () => {
    expect(E90_BAND.high).toBeGreaterThan(E90_BAND.low);
    // The Wrath 1–10 entry reaches 10 at 1:31, so at minute 90 the runner is topping level 9.
    expect(E90_BAND.low).toBe(9);
    expect(E90_BAND.high).toBe(10);
    expect(E90_BAND.minutes).toBe(90);
  });

  test("the e360 band is interpolated from the 1–20 entry, and says so", () => {
    const band = speedrunBand("e360")!;
    expect(band.high).toBeGreaterThan(band.low);
    expect(band.low).toBe(18);
    expect(band.high).toBe(19);
    expect(band.minutes).toBe(360);
    // 1–20 in 7:02:39 is 422 minutes, so six hours lands short of 20 — and not by division.
    expect(band.provenance).toContain("7:02:39");
    expect(band.provenance).toContain("not linear in level");
  });

  test("a tier with no figure of its own gets no band rather than the wrong budget's", () => {
    expect(speedrunBand("e30")).toBeNull();
    expect(speedrunBand("freeplay")).toBeNull();
  });

  test("the caveats that make a band an upper bound survive: routes, death warps, class", () => {
    for (const band of Object.values(HUMAN_SPEEDRUN_BANDS)) {
      const notes = band.sources.map((s) => s.note).join(" ");
      expect(notes).toContain("death warps");
      expect(notes).toContain("pre-planned routes");
      expect(notes).toContain("Dwarf Paladin");
      expect(band.provenance).toContain("upper bound");
    }
  });
});

describe("what the page draws", () => {
  const ceiling = empiricalCeiling([run("a", 7), run("b", 6)]);

  test("e90 gets both lines, and the ceiling's provenance names the derivation", () => {
    const scale = referenceScale({ episode: "e90", series: "0.5", ceiling, reached: 7 })!;
    expect(scale.marks.map((m) => m.id)).toEqual(["ceiling", "speedrun"]);
    expect(scale.marks[0]!.provenance).toContain("Derived");
    expect(scale.marks[0]!.provenance).toContain("L7");
    expect(scale.marks[1]!.provenance).toContain("Wrath of the Lich King Classic Archive");
    expect(scale.marks[1]!.provenance).toContain("dashboard/src/lib/reference.ts");
  });

  test("a tier with no figure of its own keeps the ceiling and draws no band; nothing at all is no strip", () => {
    const scale = referenceScale({ episode: "e30", series: "0.5", ceiling, reached: 4 })!;
    expect(scale.marks.map((m) => m.id)).toEqual(["ceiling"]);
    expect(referenceScale({ episode: "e30", series: "0.5", ceiling: null, reached: null })).toBeNull();
  });
});

describe("the scripted reference line", () => {
  const ref = (p: Partial<ResultRun>): ResultRun =>
    ({
      runId: "ref-1",
      model: "reference/elwynn-human-paladin@1",
      driver: "reference",
      episode: "e90",
      terminationReason: "episode-limit",
      maxLevel: 9,
      xp: 1200,
      startedAt: 100,
      unscored: "unscored (scripted reference)",
      ...p,
    }) as unknown as ResultRun;

  test("is the newest finished reference run of the tier in view, never a model's run", () => {
    const runs = [
      ref({ runId: "old", startedAt: 1, maxLevel: 7 }),
      ref({ runId: "new", startedAt: 2, maxLevel: 9 }),
      ref({ runId: "other-tier", startedAt: 3, episode: "e360", maxLevel: 15 }),
      ref({ runId: "a-model", startedAt: 4, maxLevel: 12, driver: "openai", unscored: null }),
    ];
    expect(scriptedReference(runs, "e90")).toEqual({ runId: "new", route: "reference/elwynn-human-paladin@1", level: 9, xp: 1200 });
    expect(scriptedReference(runs, "e360")?.runId).toBe("other-tier");
    // A live run, or one with no level reading, is no line yet.
    expect(scriptedReference([ref({ terminationReason: null })], "e90")).toBeNull();
    expect(scriptedReference([ref({ maxLevel: null })], "e90")).toBeNull();
  });

  test("is found by its driver or by its stamp, either one alone", () => {
    expect(scriptedReference([ref({ driver: null })], "e90")?.runId).toBe("ref-1");
    expect(scriptedReference([ref({ unscored: null })], "e90")?.runId).toBe("ref-1");
    expect(scriptedReference([ref({ driver: "openai", unscored: "unscored (operator objective)" })], "e90")).toBeNull();
  });

  test("with no run to read it off, the public build draws the published line, unlinked", () => {
    const lines = [
      { episode: "e90" as const, series: "0.6", route: "reference/stub-route@2", level: 10, xp: 2000 },
      { episode: "e90" as const, series: "0.5", route: "reference/stub-route@1", level: 8, xp: 900 },
      { episode: "e360" as const, series: "0.6", route: "reference/stub-route@2", level: 14, xp: null },
    ];
    expect(scriptedReference([], "e90", { lines, series: "0.5" })).toEqual({ runId: null, route: "reference/stub-route@1", level: 8, xp: 900 });
    // All series: the newest line of the tier, which the ladder lists first.
    expect(scriptedReference([], "e90", { lines, series: null })?.level).toBe(10);
    expect(scriptedReference([], "e360", { lines, series: "0.5" })).toBeNull();
    expect(scriptedReference([], "e90", { lines: undefined, series: null })).toBeNull();
    // A run in hand still wins, as on the private viewer.
    expect(scriptedReference([ref({})], "e90", { lines, series: null })?.runId).toBe("ref-1");
    const scale = scriptedReferenceScale({ episode: "e90", series: "0.5", reference: scriptedReference([], "e90", { lines, series: "0.5" }), reached: 4 })!;
    expect(scale.marks[0]!.low).toBe(8);
    expect(scale.marks[0]!.runId).toBeUndefined();
    expect(scale.marks[0]!.provenance).not.toContain("(run ");
  });
});
