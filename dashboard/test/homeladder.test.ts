import { describe, expect, test } from "bun:test";
import type { ResultRun } from "../src/api/client";
import { homeLadderRuns } from "../src/lib/homeladder";

const run = (id: string, harnessVersion: string, billing?: ResultRun["billing"]): ResultRun =>
  ({ runId: id, harnessVersion, billing } as unknown as ResultRun);

describe("homeLadderRuns", () => {
  test("keeps only the latest series present, and drops free runs by default", () => {
    const runs = [run("a", "harness-0.4-10-gabc", "paid"), run("b", "harness-0.5-2-gdef", "paid"), run("c", "harness-0.5-3-g123", "free")];
    expect(homeLadderRuns(runs, true).map((r) => r.runId)).toEqual(["b"]);
    expect(homeLadderRuns(runs, false).map((r) => r.runId)).toEqual(["b", "c"]);
  });
  test("a run with no billing verdict is kept, as on the ladder page", () => {
    expect(homeLadderRuns([run("a", "harness-0.5-1-gabc")], true)).toHaveLength(1);
  });
  test("a preview series is left out: the homepage stays on the established one", () => {
    const runs = [run("a", "harness-0.5-10-gabc", "paid"), run("b", "harness-1.0-2-gdef", "paid")];
    expect(homeLadderRuns(runs, true).map((r) => r.runId)).toEqual(["b"]);
    expect(homeLadderRuns(runs, true, null).map((r) => r.runId)).toEqual(["b"]);
    expect(homeLadderRuns(runs, true, "1.0").map((r) => r.runId)).toEqual(["a"]);
    // With nothing else to show, the preview is shown rather than nothing.
    expect(homeLadderRuns([run("b", "harness-1.0-2-gdef", "paid")], true, "1.0").map((r) => r.runId)).toEqual(["b"]);
  });
  test("nothing served is nothing shown", () => {
    expect(homeLadderRuns([], true)).toEqual([]);
  });
});
