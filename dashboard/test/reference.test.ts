/**
 * The ladder's two reference lines.
 *
 * What matters here is what the page is allowed to claim: the ceiling is a
 * maximum over the runs actually on hand and never a constant, the human band
 * is a band and carries its sources, and neither is offered where it would
 * compare two different budgets.
 */

import { describe, expect, test } from "bun:test";
import type { ResultRun } from "../../runner/viewer/api-types";
import {
  HUMAN_SPEEDRUN_BAND,
  HUMAN_SPEEDRUN_BANDS,
  ceilingLabel,
  empiricalCeiling,
  referenceScale,
  scriptedReference,
  scriptedReferenceLabel,
  scriptedReferenceScale,
  speedrunBand,
} from "../src/lib/reference";

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

  test("moves when a run beats it: nothing about 7 is hardcoded", () => {
    expect(empiricalCeiling([run("a", 6), run("b", 7)])!.level).toBe(7);
    expect(empiricalCeiling([run("a", 6), run("b", 7), run("z", 11)])!.level).toBe(11);
  });

  test("a run with no level reading is not recorded, not zero, and sets no ceiling", () => {
    const c = empiricalCeiling([run("a", null), run("b", 3), run("c", null)])!;
    expect(c.level).toBe(3);
    expect(c.of).toBe(1);
    expect(empiricalCeiling([run("a", null)])).toBeNull();
    expect(empiricalCeiling([])).toBeNull();
  });

  test("one level across every run has no next-best rather than a second line", () => {
    const c = empiricalCeiling([run("a", 6), run("b", 6)])!;
    expect(c.at).toBe(2);
    expect(c.next).toBeNull();
    expect(c.nextAt).toBe(0);
  });

  test("the label names the tier and the series it is a maximum over", () => {
    expect(ceilingLabel("e90", "0.5")).toBe("best observed e90, harness 0.5");
    expect(ceilingLabel("e360", null)).toContain("e360");
  });
});

describe("the human speedrun band", () => {
  test("the e90 band is a band, not a point, and is stated at the e90 budget", () => {
    expect(HUMAN_SPEEDRUN_BAND.high).toBeGreaterThan(HUMAN_SPEEDRUN_BAND.low);
    // The Wrath 1–10 entry reaches 10 at 1:31, so at minute 90 the runner is topping level 9.
    expect(HUMAN_SPEEDRUN_BAND.low).toBe(9);
    expect(HUMAN_SPEEDRUN_BAND.high).toBe(10);
    expect(HUMAN_SPEEDRUN_BAND.minutes).toBe(90);
    expect(HUMAN_SPEEDRUN_BAND).toBe(speedrunBand("e90")!);
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

  test("each label says how thin the sourcing is, without claiming it is unsourced", () => {
    expect(HUMAN_SPEEDRUN_BAND.label).toContain("one Wrath entry");
    expect(HUMAN_SPEEDRUN_BAND.label).toContain("bracketed by Classic Era and Cataclysm Classic");
    expect(speedrunBand("e360")!.label).toContain("one Wrath 1–20 entry");
    // The old label claimed no sourcing at all; there is now a confirmed Wrath-rate figure.
    for (const band of Object.values(HUMAN_SPEEDRUN_BANDS)) {
      expect(band.label).not.toContain("loosely sourced");
      expect(band.provenance).not.toContain("not confirmed in a browser");
    }
  });

  test("the Wrath entry leads the e90 sources and carries the operator's confirmation", () => {
    const first = HUMAN_SPEEDRUN_BAND.sources[0]!;
    expect(first.what).toContain("Wrath");
    expect(first.note).toContain("Orc Hunter");
    expect(first.note).toContain("1:31");
    expect(first.note).toContain("confirmed by the operator 2026-09-16");
    expect(first.url).toContain("speedrun.com");
  });

  test("every figure says what it is not, and cites a URL when there is one to cite", () => {
    for (const band of Object.values(HUMAN_SPEEDRUN_BANDS)) {
      expect(band.sources.length).toBeGreaterThanOrEqual(2);
      for (const s of band.sources) {
        if (s.url !== undefined) expect(s.url.startsWith("https://")).toBe(true);
        expect(s.note.length).toBeGreaterThan(10);
      }
      // The 1–20 figure has no run URL: it cites the board and the confirmation instead of inventing one.
      expect(band.sources.some((s) => s.note.includes("operator"))).toBe(true);
    }
    const noUrl = speedrunBand("e360")!.sources[0]!;
    expect(noUrl.url).toBeUndefined();
    expect(noUrl.note).toContain("Wrath of the Lich King Classic Archive");
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

  test("a longer tier gets its own band, not the ninety-minute one", () => {
    const scale = referenceScale({ episode: "e360", series: "0.5", ceiling, reached: 12 })!;
    expect(scale.marks.map((m) => m.id)).toEqual(["ceiling", "speedrun"]);
    expect(scale.marks[0]!.label).toContain("e360");
    expect(scale.marks[1]!.low).toBe(18);
    expect(scale.marks[1]!.provenance).toContain("360 minutes");
  });

  test("a tier with no figure of its own keeps the ceiling and draws no band", () => {
    const scale = referenceScale({ episode: "e30", series: "0.5", ceiling, reached: 4 })!;
    expect(scale.marks.map((m) => m.id)).toEqual(["ceiling"]);
  });

  test("the scale stretches past the furthest thing drawn, so no mark sits on the edge", () => {
    const scale = referenceScale({ episode: "e90", series: "0.5", ceiling, reached: 7 })!;
    expect(scale.min).toBe(1);
    expect(scale.max).toBeGreaterThan(HUMAN_SPEEDRUN_BAND.high);
    const far = referenceScale({ episode: "e360", series: "0.5", ceiling: empiricalCeiling([run("a", 22)]), reached: 22 })!;
    expect(far.max).toBeGreaterThan(22);
  });

  test("no ceiling and no band is nothing to draw, not an empty strip", () => {
    expect(referenceScale({ episode: "e30", series: "0.5", ceiling: null, reached: null })).toBeNull();
    // e90 still has the constant even before a single run exists.
    expect(referenceScale({ episode: "e90", series: null, ceiling: null, reached: null })!.marks).toHaveLength(1);
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
  });

  test("is found by its driver or by its stamp, either one alone", () => {
    expect(scriptedReference([ref({ driver: null })], "e90")?.runId).toBe("ref-1");
    expect(scriptedReference([ref({ unscored: null })], "e90")?.runId).toBe("ref-1");
    expect(scriptedReference([ref({ driver: "openai", unscored: "unscored (operator objective)" })], "e90")).toBeNull();
  });

  test("a live run, or one with no level reading, is no line yet", () => {
    expect(scriptedReference([ref({ terminationReason: null })], "e90")).toBeNull();
    expect(scriptedReference([ref({ maxLevel: null })], "e90")).toBeNull();
    expect(scriptedReference([], "e90")).toBeNull();
  });

  test("draws one labelled line, links its run, and stretches past the rows on screen", () => {
    const reference = scriptedReference([ref({})], "e90");
    const scale = scriptedReferenceScale({ episode: "e90", series: "0.9", reference, reached: 11 })!;
    expect(scale.marks).toHaveLength(1);
    expect(scale.marks[0]!.id).toBe("scripted");
    expect([scale.marks[0]!.low, scale.marks[0]!.high, scale.marks[0]!.runId]).toEqual([9, 9, "ref-1"]);
    expect(scale.marks[0]!.label).toBe(scriptedReferenceLabel("e90", "0.9"));
    expect(scale.marks[0]!.label).toContain("harness 0.9");
    expect(scale.marks[0]!.provenance).toContain("never scored");
    expect(scale.max).toBeGreaterThan(11);
    expect(scriptedReferenceScale({ episode: "e90", series: "0.9", reference: null, reached: 11 })).toBeNull();
  });
});
