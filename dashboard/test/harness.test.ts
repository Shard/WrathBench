import { describe, expect, test } from "bun:test";
import {
  compareSeriesDesc,
  filterBySeries,
  latestSeries,
  pageSeries,
  resolveSeries,
  seriesFilteredOut,
  seriesOf,
  seriesOptions,
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

  test("latest is the highest, and empty has none", () => {
    expect(latestSeries(["0.3", "0.5", "0.4"])).toBe("0.5");
    expect(latestSeries([])).toBeNull();
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

  test("falls back to the version stamp when no series field is carried", () => {
    expect(seriesPresent([{ harnessVersion: "harness-0.3-1-gaaa" }])).toEqual(["0.3"]);
  });

  test("runs with no series contribute nothing", () => {
    expect(seriesPresent([{ harnessSeries: null, harnessVersion: "gabc" }])).toEqual([]);
  });
});

describe("seriesParam", () => {
  test("all and latest are always valid", () => {
    expect(seriesParam("all")).toBe("all");
    expect(seriesParam("latest")).toBe("latest");
  });

  test("anything shaped like a series is taken, availability decided later", () => {
    expect(seriesParam("0.4")).toBe("0.4");
    // The list arrives on a poll; rejecting an unknown series here would
    // rewrite a cold-opened link in its first frame.
    expect(seriesParam("9.9")).toBe("9.9");
  });

  test("absent or malformed yields null, so the caller falls back", () => {
    expect(seriesParam(undefined)).toBeNull();
    expect(seriesParam("")).toBeNull();
    expect(seriesParam("nonsense")).toBeNull();
    expect(seriesParam("0")).toBeNull();
  });

  test("a repeated param takes the first", () => {
    expect(seriesParam(["0.4", "0.5"])).toBe("0.4");
  });
});

describe("resolveSeries", () => {
  const available = ["0.5", "0.4", "0.3"];

  test("all filters nothing", () => {
    expect(resolveSeries("all", available)).toBeNull();
  });

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

describe("seriesOptions", () => {
  test("all, then latest labelled with what it means, then every series descending", () => {
    // The newest appears twice on purpose: `latest` tracks a bump, `0.5` pins.
    expect(seriesOptions(["0.4", "0.5", "0.3"])).toEqual([
      { value: "all", label: "all" },
      { value: "latest", label: "latest (0.5)" },
      { value: "0.5", label: "0.5" },
      { value: "0.4", label: "0.4" },
      { value: "0.3", label: "0.3" },
    ]);
  });

  test("with no data at all it is still a usable control", () => {
    expect(seriesOptions([])).toEqual([
      { value: "all", label: "all" },
      { value: "latest", label: "latest" },
    ]);
  });

  test("a selection the list does not hold is still an option, never a blank control", () => {
    expect(seriesOptions([], "0.4")).toEqual([
      { value: "all", label: "all" },
      { value: "latest", label: "latest (0.4)" },
      { value: "0.4", label: "0.4" },
    ]);
    expect(seriesOptions(["0.5"], "all").map((o) => o.value)).toEqual(["all", "latest", "0.5"]);
  });
});

describe("pageSeries — degrading against a viewer that predates /api/info's list", () => {
  const rows = [
    { harnessSeries: "0.5", harnessVersion: "harness-0.5-1-gaaa" },
    { harnessSeries: "0.4", harnessVersion: "harness-0.4-1-gbbb" },
  ];

  test("latest resolves off the page's own rows when the shell knows nothing", () => {
    expect(pageSeries("latest", [], rows)).toBe("0.5");
  });

  test("all still filters nothing", () => {
    expect(pageSeries("all", [], rows)).toBeNull();
  });

  test("the shell's list and the page's rows are unioned", () => {
    expect(pageSeries("latest", ["0.6"], rows)).toBe("0.6");
    expect(pageSeries("0.4", ["0.6"], rows)).toBe("0.4");
  });

  test("with neither source there is nothing to filter to", () => {
    expect(pageSeries("latest", [], [])).toBeNull();
  });
});

describe("filterBySeries", () => {
  const rows = [
    { runId: "a", harnessSeries: "0.5", harnessVersion: "harness-0.5-1-gaaa" },
    { runId: "b", harnessSeries: "0.4", harnessVersion: "harness-0.4-1-gbbb" },
    { runId: "c", harnessSeries: null, harnessVersion: "gccc" },
  ];

  test("null keeps everything, including the seriesless run", () => {
    expect(filterBySeries(rows, null).map((r) => r.runId)).toEqual(["a", "b", "c"]);
  });

  test("a series keeps only its own — a seriesless run is a member of no group", () => {
    expect(filterBySeries(rows, "0.5").map((r) => r.runId)).toEqual(["a"]);
    expect(filterBySeries(rows, "0.4").map((r) => r.runId)).toEqual(["b"]);
  });

  test("derives the series when the row carries only a version", () => {
    expect(filterBySeries([{ harnessVersion: "harness-0.2-4-gddd" }], "0.2")).toHaveLength(1);
  });

  test("what it removed is countable, so a page can say so", () => {
    expect(seriesFilteredOut(rows.length, filterBySeries(rows, "0.5").length)).toBe(2);
    expect(seriesFilteredOut(3, 3)).toBe(0);
  });
});
