import { describe, expect, test } from "bun:test";
import type { ResultRun } from "../src/api/client";
import { homeLadderHref, homeLadderRuns } from "../src/lib/homeladder";

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
  describe("follows the shell's series selection, as /ladder does", () => {
    const runs = [
      run("a", "harness-0.4-10-gabc", "paid"),
      run("b", "harness-0.5-2-gdef", "paid"),
      run("c", "harness-1.0-1-g456", "paid"),
      run("d", "harness-0.4-11-gfff", "free"),
    ];
    const available = ["1.0", "0.5", "0.4"];
    test("no selection is latest, never the preview", () => {
      expect(homeLadderRuns(runs, true, "1.0", {}).map((r) => r.runId)).toEqual(["b"]);
      expect(homeLadderRuns(runs, true, "1.0", { choice: "latest", available }).map((r) => r.runId)).toEqual(["b"]);
      expect(homeLadderRuns(runs, true, null, { choice: "latest", available }).map((r) => r.runId)).toEqual(["c"]);
    });
    test("an older series draws that series' runs, free ones still out", () => {
      expect(homeLadderRuns(runs, true, "1.0", { choice: "0.4", available }).map((r) => r.runId)).toEqual(["a"]);
      expect(homeLadderRuns(runs, false, "1.0", { choice: "0.4", available }).map((r) => r.runId)).toEqual(["a", "d"]);
    });
    test("the preview series, picked, is drawn", () => {
      expect(homeLadderRuns(runs, true, "1.0", { choice: "1.0", available }).map((r) => r.runId)).toEqual(["c"]);
    });
    test("all keeps every series", () => {
      expect(homeLadderRuns(runs, true, "1.0", { choice: "all", available }).map((r) => r.runId)).toEqual(["a", "b", "c"]);
    });
    test("a series no run carries falls back to latest", () => {
      expect(homeLadderRuns(runs, true, "1.0", { choice: "0.3", available }).map((r) => r.runId)).toEqual(["b"]);
    });
    test("latest is the shell's: a newer series with no e90 run yet draws nothing, as /ladder does", () => {
      expect(homeLadderRuns(runs, true, null, { choice: "latest", available: ["1.1", ...available] })).toEqual([]);
    });
    test("a shell that knows no series (an older viewer) resolves off the runs", () => {
      expect(homeLadderRuns(runs, true, null, { choice: "latest", available: [] }).map((r) => r.runId)).toEqual(["c"]);
      expect(homeLadderRuns(runs, true, null, { choice: "0.5", available: [] }).map((r) => r.runId)).toEqual(["b"]);
    });
  });
  test("the full-ladder link carries the choice", () => {
    expect(homeLadderHref("latest")).toBe("/ladder?episode=e90&series=latest");
    expect(homeLadderHref("0.4")).toBe("/ladder?episode=e90&series=0.4");
  });
  test("nothing served is nothing shown", () => {
    expect(homeLadderRuns([], true)).toEqual([]);
  });
});
