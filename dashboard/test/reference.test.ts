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
  ceilingLabel,
  empiricalCeiling,
  referenceScale,
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
  test("is a band, not a point, and is stated at the e90 budget", () => {
    expect(HUMAN_SPEEDRUN_BAND.high).toBeGreaterThan(HUMAN_SPEEDRUN_BAND.low);
    expect(HUMAN_SPEEDRUN_BAND.low).toBe(10);
    expect(HUMAN_SPEEDRUN_BAND.high).toBe(11);
    expect(HUMAN_SPEEDRUN_BAND.minutes).toBe(90);
  });

  test("says in its own label that it is loosely sourced", () => {
    expect(HUMAN_SPEEDRUN_BAND.label).toContain("loosely sourced");
  });

  test("every figure carries a URL and what it is not", () => {
    expect(HUMAN_SPEEDRUN_BAND.sources.length).toBeGreaterThanOrEqual(3);
    for (const s of HUMAN_SPEEDRUN_BAND.sources) {
      expect(s.url.startsWith("https://")).toBe(true);
      expect(s.note.length).toBeGreaterThan(10);
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
    expect(scale.marks[1]!.provenance).toContain("not confirmed in a browser");
  });

  test("a longer tier keeps the ceiling and drops the band: 90 minutes is not 360", () => {
    const scale = referenceScale({ episode: "e360", series: "0.5", ceiling, reached: 12 })!;
    expect(scale.marks.map((m) => m.id)).toEqual(["ceiling"]);
    expect(scale.marks[0]!.label).toContain("e360");
  });

  test("the scale stretches past the furthest thing drawn, so no mark sits on the edge", () => {
    const scale = referenceScale({ episode: "e90", series: "0.5", ceiling, reached: 7 })!;
    expect(scale.min).toBe(1);
    expect(scale.max).toBeGreaterThan(HUMAN_SPEEDRUN_BAND.high);
    const far = referenceScale({ episode: "e360", series: "0.5", ceiling: empiricalCeiling([run("a", 22)]), reached: 22 })!;
    expect(far.max).toBeGreaterThan(22);
  });

  test("no ceiling and no band is nothing to draw, not an empty strip", () => {
    expect(referenceScale({ episode: "e360", series: "0.5", ceiling: null, reached: null })).toBeNull();
    // e90 still has the constant even before a single run exists.
    expect(referenceScale({ episode: "e90", series: null, ceiling: null, reached: null })!.marks).toHaveLength(1);
  });
});
