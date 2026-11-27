import { describe, expect, test } from "bun:test";
import {
  compareSeriesDesc,
  defaultSeries,
  displayedChoice,
  filterBySeries,
  pageSeries,
  resolveSeries,
  seriesOf,
  seriesParam,
  seriesPresent,
} from "../src/lib/harness";

/*
 * The cases below mirror `runner/test/comparability.test.ts` on purpose: this
 * is a second implementation of one rule (the alias may not cross into
 * `runner/src/comparability.ts`), so the test is what keeps the two honest.
 */
describe("seriesOf", () => {
  test("reads major.minor off a describe stamp", () => {
    expect(seriesOf("harness-0.3-114-gda93f0a-dirty")).toBe("0.3");
    expect(seriesOf("harness-0.3-133-g6e4b5bb")).toBe("0.3");
    expect(seriesOf("harness-0.2-33-g9bba93b-dirty")).toBe("0.2");
    expect(seriesOf("harness-1.10")).toBe("1.10");
    expect(seriesOf("harness-0.3-test")).toBe("0.3");
    expect(seriesOf("0.0.0-phase0+gharness-0.3-133-g6e4b5bb-dirty")).toBe("0.3");
  });

  test("a stamp naming no series is null, never invented", () => {
    expect(seriesOf("0.0.0-phase0-unversioned")).toBeNull();
    expect(seriesOf("0.0.0-phase0+gabc1234")).toBeNull();
    expect(seriesOf("gabc1234")).toBeNull();
    expect(seriesOf(null)).toBeNull();
    expect(seriesOf(undefined)).toBeNull();
    expect(seriesOf("")).toBeNull();
  });
});

describe("ordering", () => {
  test("newest first, numerically — 0.10 outranks 0.9", () => {
    expect(["0.2", "0.10", "0.9", "1.0"].sort(compareSeriesDesc)).toEqual(["1.0", "0.10", "0.9", "0.2"]);
  });
});

describe("seriesPresent", () => {
  test("distinct series over run rows, newest first", () => {
    const rows = [
      { harnessSeries: "0.4", harnessVersion: "harness-0.4-1-gaaa" },
      { harnessSeries: "0.5", harnessVersion: "harness-0.5-2-gbbb" },
      { harnessSeries: "0.4", harnessVersion: "harness-0.4-9-gccc" },
    ];
    expect(seriesPresent(rows)).toEqual(["0.5", "0.4"]);
  });
});

describe("resolveSeries", () => {
  const available = ["0.5", "0.4", "0.3"];

  test("latest tracks the data rather than freezing", () => {
    expect(resolveSeries("latest", available)).toBe("0.5");
    expect(resolveSeries("latest", ["0.6", ...available])).toBe("0.6");
    expect(resolveSeries("latest", [])).toBeNull();
  });

  test("a named series resolves to itself; an absent one degrades to latest", () => {
    expect(resolveSeries("0.3", available)).toBe("0.3");
    expect(resolveSeries("9.9", available)).toBe("0.5");
  });
});

describe("a preview series (the store's site.previewSeries, operator 2026-11-15)", () => {
  const available = ["1.0", "0.5", "0.4"];

  test("set, latest is the newest series other than the preview", () => {
    expect(defaultSeries(available, "1.0")).toBe("0.5");
    expect(resolveSeries("latest", available, "1.0")).toBe("0.5");
    expect(pageSeries("latest", available, [], "1.0")).toBe("0.5");
    // A preview that is not the newest is still not latest.
    expect(defaultSeries(available, "0.5")).toBe("1.0");
  });

  test("the preview is selected by its own number, so ?series=1.0 means 1.0 before and after the flip", () => {
    expect(seriesParam("1.0")).toBe("1.0");
    expect(resolveSeries("1.0", available, "1.0")).toBe("1.0");
    expect(resolveSeries("1.0", available, null)).toBe("1.0");
    expect(displayedChoice("1.0", available)).toBe("1.0");
    // all is unchanged.
    expect(resolveSeries("all", available, "1.0")).toBeNull();
  });

  test("when the preview is all there is, it is latest too, never an empty page", () => {
    expect(defaultSeries(["1.0"], "1.0")).toBe("1.0");
    expect(resolveSeries("latest", ["1.0"], "1.0")).toBe("1.0");
    expect(defaultSeries([], "1.0")).toBeNull();
  });
});

describe("displayedChoice — the control may not say 0.3 over a page showing 0.5", () => {
  test("a series no run carries displays as latest — which is what it resolves to", () => {
    expect(displayedChoice("0.3", ["0.5", "0.4"])).toBe("latest");
  });
});

describe("filterBySeries", () => {
  const rows = [
    { runId: "a", harnessSeries: "0.5", harnessVersion: "harness-0.5-1-gaaa" },
    { runId: "b", harnessSeries: "0.4", harnessVersion: "harness-0.4-1-gbbb" },
    { runId: "c", harnessSeries: null, harnessVersion: "gccc" },
  ];

  test("a series keeps only its own — a seriesless run is a member of no group", () => {
    expect(filterBySeries(rows, "0.5").map((r) => r.runId)).toEqual(["a"]);
    expect(filterBySeries(rows, "0.4").map((r) => r.runId)).toEqual(["b"]);
  });

  test("derives the series when the row carries only a version", () => {
    expect(filterBySeries([{ harnessVersion: "harness-0.2-4-gddd" }], "0.2")).toHaveLength(1);
  });
});
