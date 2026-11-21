import { describe, expect, test } from "bun:test";
import {
  compareSeriesDesc,
  defaultSeries,
  displayedChoice,
  filterBySeries,
  latestSeries,
  listingSeries,
  pageSeries,
  resolveSeries,
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

describe("a preview series (the store's site.previewSeries, operator 2026-11-15)", () => {
  const available = ["1.0", "0.5", "0.4"];

  test("unset is exactly today: latest is the newest", () => {
    expect(defaultSeries(available)).toBe("1.0");
    expect(defaultSeries(available, null)).toBe("1.0");
    expect(resolveSeries("latest", available, null)).toBe("1.0");
    expect(seriesOptions(available, "latest", null)).toEqual(seriesOptions(available, "latest"));
  });

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

  test("a series that is not there degrades to the default, not to the preview", () => {
    expect(resolveSeries("9.9", available, "1.0")).toBe("0.5");
  });

  test("when the preview is all there is, it is latest too, never an empty page", () => {
    expect(defaultSeries(["1.0"], "1.0")).toBe("1.0");
    expect(resolveSeries("latest", ["1.0"], "1.0")).toBe("1.0");
    expect(defaultSeries([], "1.0")).toBeNull();
  });

  test("options: all, latest (0.5), preview (1.0), then the other series; the preview's own number is not listed twice", () => {
    expect(seriesOptions(available, "latest", "1.0")).toEqual([
      { value: "all", label: "all" },
      { value: "latest", label: "latest (0.5)" },
      { value: "1.0", label: "preview (1.0)" },
      { value: "0.5", label: "0.5" },
      { value: "0.4", label: "0.4" },
    ]);
  });

  test("a preview with no runs yet is not offered: choosing it would show latest", () => {
    expect(seriesOptions(["0.5", "0.4"], "latest", "1.0")).toEqual([
      { value: "all", label: "all" },
      { value: "latest", label: "latest (0.5)" },
      { value: "0.5", label: "0.5" },
      { value: "0.4", label: "0.4" },
    ]);
    // A link to it before the list arrives still renders it, as the preview.
    expect(seriesOptions([], "1.0", "1.0").map((o) => o.label)).toEqual(["all", "latest (1.0)", "preview (1.0)"]);
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

describe("listingSeries — the series filter is the evals group's", () => {
  const rows = [
    { harnessSeries: "0.5", harnessVersion: "harness-0.5-1-gaaa" },
    { harnessSeries: "0.4", harnessVersion: "harness-0.4-1-gbbb" },
    { harnessSeries: null, harnessVersion: null },
  ];

  test("with evals on it is pageSeries", () => {
    expect(listingSeries(true, "latest", ["0.5", "0.4"], rows)).toBe("0.5");
    expect(listingSeries(true, "0.4", ["0.5", "0.4"], rows)).toBe("0.4");
    expect(listingSeries(true, "latest", ["0.5", "0.4"], rows, "0.6")).toBe(pageSeries("latest", ["0.5", "0.4"], rows, "0.6"));
  });

  test("with evals off nothing is filtered, whatever a link or a remembered choice says", () => {
    for (const choice of ["latest", "0.4", "all"]) {
      const series = listingSeries(false, choice, ["0.5", "0.4"], rows);
      expect(series).toBeNull();
      expect(filterBySeries(rows, series)).toHaveLength(3);
    }
  });
});

describe("displayedChoice — the control may not say 0.3 over a page showing 0.5", () => {
  test("all and latest display themselves", () => {
    expect(displayedChoice("all", ["0.5"])).toBe("all");
    expect(displayedChoice("latest", ["0.5"])).toBe("latest");
  });

  test("an available series displays itself", () => {
    expect(displayedChoice("0.4", ["0.5", "0.4"])).toBe("0.4");
  });

  test("a series no run carries displays as latest — which is what it resolves to", () => {
    expect(displayedChoice("0.3", ["0.5", "0.4"])).toBe("latest");
  });

  test("an empty list is `not known yet`, and the link is taken at its word", () => {
    expect(displayedChoice("0.3", [])).toBe("0.3");
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
});
