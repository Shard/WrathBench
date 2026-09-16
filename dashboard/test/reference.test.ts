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
