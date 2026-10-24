/**
 * The runs table's pure layer: header/body parity, the sort, the readings.
 *
 * What matters: the default is every run newest first, the sort is stable and
 * "not recorded" sorts last, the readings are of fields the server decided,
 * and the page degrades against a viewer that predates `live`.
 */

import { describe, expect, test } from "bun:test";
import type { ResultRun } from "../../runner/viewer/api-types";
import { STALL_PAUSE } from "../../runner/src/lapse";
import { projectResults } from "../../runner/viewer/public-projection";
import {
  COLUMN_TITLES,
  DEFAULT_SORT,
  RUN_COLUMNS,
  columnClass,
  costOf,
  filterLabel,
  filterParams,
  filterRuns,
  clampPage,
  keepRowIdentity,
  kindOf,
  nextSort,
  PAGE_SIZE,
  pageCount,
  pageParam,
  pageQuery,
  pageSlice,
  pagerItems,
  runsHref,
  sortParam,
  sortQuery,
  sortRuns,
  STALL_PAUSE_REASON,
  statusOf,
  statusText,
  statusTitle,
  statusTone,
  turnsOf,
} from "../src/lib/runs";

function run(p: Partial<ResultRun> = {}): ResultRun {
  return {
    runId: "r",
    model: "m",
    platform: "openrouter",
    harnessVersion: "harness-0.5-1-gabc",
    harnessSeries: "0.5",
    extra: false,
    campaign: null,
    cell: null,
    effort: null,
    race: 1,
    raceName: "Human",
    class: 2,
    className: "Paladin",
    characterLabel: "Human Paladin",
    modelResponses: 3,
    harness: "wrathbench",
    promptHash: null,
    serverBuild: null,
    wikiCoords: false,
    toolCalls: null,
    snippets: null,
    episode: "e90",
    episodeSource: "stamped",
    episodeOverride: false,
    unscored: null,
    startedAt: 1000,
    endedAt: null,
    live: false,
    terminationReason: "episode-elapsed",
    levels: [],
    maxLevel: 4,
    xp: null,
    money: null,
    questsCompleted: 0,
    maps: [0],
    character: "Toon",
    playtimeMs: 60_000,
    tokens: null,
    actualCost: null,
    pauseReason: null,
    continuedFrom: null,
    stillborn: null,
    ...p,
  };
}

describe("columns", () => {
  test("the header order is the constant, and every column has a class the body agrees with", () => {
    expect([...RUN_COLUMNS]).toEqual([
      "started", "run", "model", "harness", "effort", "kind", "episode", "character", "status", "level", "turns", "duration", "cost",
    ]);
    for (const c of RUN_COLUMNS) expect(["", "right"]).toContain(columnClass(c));
    expect(columnClass("cost")).toBe("right");
    expect(columnClass("model")).toBe("");
    for (const c of Object.keys(COLUMN_TITLES)) expect(RUN_COLUMNS as readonly string[]).toContain(c);
  });
});

describe("readings", () => {
  test("status is the viewer's live flag when present, and the recorded reasons when not", () => {
    expect(statusOf(run({ live: true, terminationReason: null }))).toBe("live");
    expect(statusOf(run({ live: false, terminationReason: null, pauseReason: "quota-exhausted" }))).toBe("paused");
    expect(statusOf(run({ live: false, terminationReason: "episode-elapsed" }))).toBe("ended");
    // An older viewer serves no `live`: neither reason recorded means still going.
    const old = run({ terminationReason: null });
    delete (old as Partial<ResultRun>).live;
    expect(statusOf(old)).toBe("live");
    expect(statusOf({ ...old, terminationReason: "quest-cap" })).toBe("ended");
    expect(statusText(run({ pauseReason: "quota-exhausted", terminationReason: null }))).toBe("paused: quota-exhausted");
    // The public projection's fixed token is a withheld reason, not one that reads "paused".
    expect(statusText(run({ pauseReason: "paused", terminationReason: null }))).toBe("paused");
    expect(statusText(run())).toBe("episode-elapsed");
  });

  test("a run paused because its observation stalled reads stalled, on the private and the public surface alike", () => {
    // The dashboard's copy of the reason is the runner's, verbatim.
    expect(STALL_PAUSE_REASON).toBe(STALL_PAUSE);
    const stalled = run({ live: false, terminationReason: null, pauseReason: STALL_PAUSE_REASON });
    expect(statusOf(stalled)).toBe("stalled");
    expect(statusText(stalled)).toBe("stalled");
    // A fresh directory can still read live: the pause wins, as it does for any pause.
    expect(statusOf({ ...stalled, live: true })).toBe("stalled");
    // The public projection passes the stall through as itself, so a
    // published row reads the same word rather than a bare "paused".
    const publish = (r: ResultRun): ResultRun =>
      projectResults({ runs: [r], episode: "all", harness: "all", includeOverrides: false, filteredOut: 0, overridesExcluded: 0, now: 0 }).runs[0]!;
    const published = publish(stalled);
    expect(statusText(published)).toBe("stalled");
    const cooling = publish(run({ terminationReason: null, pauseReason: "rate-limited" }));
    expect(statusText(cooling)).toBe("paused");
  });

  test("one tone per status, and only the new word carries a hover", () => {
    expect(statusTone("live")).toBe("ok");
    expect(statusTone("paused")).toBe("warn");
    expect(statusTone("stalled")).toBe("warn");
    expect(statusTone("ended")).toBe("dim");
    expect(statusTitle("stalled")).toBeString();
    for (const s of ["live", "paused", "ended"] as const) expect(statusTitle(s)).toBeUndefined();
    expect(COLUMN_TITLES.status).toContain("stalled");
  });

  test("kind reads the campaign, the tier, the unscored reason, and the extra flag, in that order", () => {
    expect(kindOf(run({ campaign: "nav", cell: "tram" }))).toBe("probe nav/tram");
    expect(kindOf(run({ episode: "freeplay", unscored: "unscored (episode freeplay)" }))).toBe("freeplay");
    expect(kindOf(run({ unscored: "unscored (operator objective)" }))).toBe("objective");
    expect(kindOf(run({ unscored: "unscored (scripted stub)" }))).toBe("unscored");
    expect(kindOf(run({ extra: true }))).toBe("scored (extra)");
    expect(kindOf(run())).toBe("scored");
  });

  test("turns prefer reported usage turns and fall back to model responses; cost is actual or nothing", () => {
    expect(turnsOf(run())).toBe(3);
    expect(turnsOf(run({ tokens: { source: "reported", contextTokens: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, cacheReadTokens: null, cacheWriteTokens: null, turns: 12 } }))).toBe(12);
    expect(costOf(run())).toBeNull();
    const fig = { usd: 1.5, basis: "reported" as const, asIfMetered: false, breakdown: null, priceId: null, asOf: null, note: "" };
    expect(costOf(run({ actualCost: fig }))).toBe(1.5);
    expect(costOf(run({ actualCost: { ...fig, basis: "none", usd: null } }))).toBeNull();
  });
});

describe("sort", () => {
  const rows = [
    run({ runId: "a", startedAt: 1, maxLevel: 7, model: "zeta" }),
    run({ runId: "b", startedAt: 3, maxLevel: null, model: "alpha" }),
    run({ runId: "c", startedAt: 2, maxLevel: 7, model: "alpha" }),
    run({ runId: "d", startedAt: null, maxLevel: 2, model: "mid" }),
  ];

  test("the default is every run, newest first, with an unknown start last", () => {
    expect(DEFAULT_SORT).toEqual({ column: "started", dir: "desc" });
    expect(sortRuns(rows, DEFAULT_SORT).map((r) => r.runId)).toEqual(["b", "c", "a", "d"]);
  });

  test("not-recorded sorts last in either direction, and ties fall through to newest first", () => {
    expect(sortRuns(rows, { column: "level", dir: "desc" }).map((r) => r.runId)).toEqual(["c", "a", "d", "b"]);
    expect(sortRuns(rows, { column: "level", dir: "asc" }).map((r) => r.runId)).toEqual(["d", "c", "a", "b"]);
    expect(sortRuns(rows, { column: "model", dir: "asc" }).map((r) => r.runId)).toEqual(["b", "c", "d", "a"]);
  });

  test("the URL round-trips, and the default spells as no params", () => {
    expect(sortParam(undefined, undefined)).toEqual(DEFAULT_SORT);
    expect(sortParam("level", "asc")).toEqual({ column: "level", dir: "asc" });
    expect(sortParam("nope", "sideways")).toEqual(DEFAULT_SORT);
    expect(sortParam("model", undefined)).toEqual({ column: "model", dir: "asc" });
    expect(sortQuery(DEFAULT_SORT)).toEqual({ sort: null, dir: null });
    expect(sortQuery({ column: "cost", dir: "desc" })).toEqual({ sort: "cost", dir: "desc" });
  });

  test("a header click flips the same column and opens a new one the expected way", () => {
    expect(nextSort(DEFAULT_SORT, "started")).toEqual({ column: "started", dir: "asc" });
    expect(nextSort(DEFAULT_SORT, "cost")).toEqual({ column: "cost", dir: "desc" });
    expect(nextSort(DEFAULT_SORT, "model")).toEqual({ column: "model", dir: "asc" });
  });
});

describe("filter", () => {
  const rows = [
    run({ runId: "base" }),
    run({ runId: "low", effort: "low" }),
    run({ runId: "probe", campaign: "nav", cell: "x", episode: "probing", harness: "claude-code" }),
    run({ runId: "dwarf", characterLabel: "Dwarf Hunter", model: "other" }),
  ];

  test("the page opens on everything, and a model without effort means the entry with none", () => {
    const none = filterParams({});
    expect(filterRuns(rows, none)).toHaveLength(4);
    expect(filterLabel(none)).toBe("");
    expect(filterRuns(rows, filterParams({ model: "m" })).map((r) => r.runId)).toEqual(["base", "probe"]);
    expect(filterRuns(rows, filterParams({ model: "m", effort: "low" })).map((r) => r.runId)).toEqual(["low"]);
  });

  test("episode, harness, character and campaign narrow; `all` is no filter", () => {
    expect(filterRuns(rows, filterParams({ episode: "probing" })).map((r) => r.runId)).toEqual(["probe"]);
    expect(filterRuns(rows, filterParams({ harness: "claude-code" })).map((r) => r.runId)).toEqual(["probe"]);
    expect(filterRuns(rows, filterParams({ character: "Dwarf Hunter" })).map((r) => r.runId)).toEqual(["dwarf"]);
    expect(filterRuns(rows, filterParams({ campaign: "nav" })).map((r) => r.runId)).toEqual(["probe"]);
    expect(filterRuns(rows, filterParams({ episode: "all", harness: "all" }))).toHaveLength(4);
    expect(filterLabel(filterParams({ model: "m", episode: "e90" }))).toBe("model=m episode=e90");
  });

  test("runsHref is one spelling for every page that links here", () => {
    expect(runsHref()).toBe("/runs");
    expect(runsHref({ episode: "all", harness: "all" })).toBe("/runs");
    expect(runsHref({ model: "vendor/alpha", effort: "low", episode: "e90" })).toBe(
      "/runs?episode=e90&model=vendor%2Falpha&effort=low",
    );
    expect(runsHref({ sort: { column: "cost", dir: "desc" } })).toBe("/runs?sort=cost&dir=desc");
    expect(runsHref({ sort: DEFAULT_SORT })).toBe("/runs");
    expect(runsHref({ episode: "e90", sort: { column: "cost", dir: "desc" }, page: 3 })).toBe("/runs?episode=e90&sort=cost&dir=desc&page=3");
    expect(runsHref({ page: 1 })).toBe("/runs");
  });

  test("a compaction window narrows like effort: absent under a model is the entry with none", () => {
    const hk = [
      run({ runId: "auto", model: "hk", effort: "max" }),
      run({ runId: "small", model: "hk", effort: "max", compactWindow: "100k" }),
    ];
    expect(filterRuns(hk, filterParams({ model: "hk", effort: "max" })).map((r) => r.runId)).toEqual(["auto"]);
    expect(filterRuns(hk, filterParams({ model: "hk", effort: "max", compactWindow: "100k" })).map((r) => r.runId)).toEqual(["small"]);
    expect(runsHref({ model: "hk", effort: "max", compactWindow: "100k", episode: "e360" })).toBe(
      "/runs?episode=e360&model=hk&effort=max&compactWindow=100k",
    );
    expect(runsHref({ model: "hk", effort: "max", compactWindow: null })).toBe("/runs?model=hk&effort=max");
  });
});

describe("pages of a hundred", () => {
  /** 250 runs over two models, a third of them with a cost, newest first by index. */
  const many = Array.from({ length: 250 }, (_, i) =>
    run({
      runId: `r${String(i).padStart(3, "0")}`,
      model: i % 2 === 0 ? "even" : "odd",
      startedAt: 1_000_000 - i,
      actualCost: i % 3 === 0 ? { usd: i / 100, basis: "reported", note: null } as never : null,
    }),
  );

  test("the page param: a number from 1, anything else page 1, page 1 spelled as nothing", () => {
    expect(PAGE_SIZE).toBe(100);
    expect(pageParam(undefined)).toBe(1);
    expect(pageParam("3")).toBe(3);
    expect(pageParam(["2", "5"])).toBe(2);
    for (const bad of ["0", "-1", "2.5", "x", ""]) expect(pageParam(bad)).toBe(1);
    expect(pageQuery(1)).toEqual({ page: null });
    expect(pageQuery(4)).toEqual({ page: "4" });
  });

  test("counts are the whole set's and a page past the end shows the last one", () => {
    expect(pageCount(0)).toBe(1);
    expect(pageCount(100)).toBe(1);
    expect(pageCount(101)).toBe(2);
    expect(pageCount(1566)).toBe(16);
    expect(clampPage(9, 250)).toBe(3);
    expect(clampPage(0, 250)).toBe(1);
    expect(pageSlice(many, 3).map((r) => r.runId)).toEqual(many.slice(200).map((r) => r.runId));
    expect(pageSlice(many, 99)).toEqual(pageSlice(many, 3));
    expect(pageSlice([], 2)).toEqual([]);
  });

  test("the sort and the filter run over every row before the page is cut", () => {
    // Page 1 of the cost sort is the 84 costed runs, most expensive first —
    // including the ones that sat on pages 2 and 3 of the default order.
    const byCost = sortRuns(many, { column: "cost", dir: "desc" });
    const first = pageSlice(byCost, 1);
    expect(first[0]!.runId).toBe("r249");
    expect(first.slice(0, 84).every((r) => costOf(r) !== null)).toBe(true);
    expect(first.slice(84).every((r) => costOf(r) === null)).toBe(true);
    // Narrowed to one model: 125 rows, two pages, every row on them that model.
    const odd = sortRuns(filterRuns(many, filterParams({ model: "odd" })), DEFAULT_SORT);
    expect(odd).toHaveLength(125);
    expect(pageCount(odd.length)).toBe(2);
    expect(pageSlice(odd, 2)).toHaveLength(25);
    expect([...pageSlice(odd, 1), ...pageSlice(odd, 2)].every((r) => r.model === "odd")).toBe(true);
    expect(pageSlice(odd, 1)[0]!.runId).toBe("r001");
  });

  test("the pager: both ends, the current page and its neighbours, a gap only where it hides pages", () => {
    expect(pagerItems(1, 1)).toEqual([1]);
    expect(pagerItems(1, 2)).toEqual([1, 2]);
    expect(pagerItems(1, 16)).toEqual([1, 2, null, 16]);
    expect(pagerItems(8, 16)).toEqual([1, null, 7, 8, 9, null, 16]);
    expect(pagerItems(16, 16)).toEqual([1, null, 15, 16]);
    // 1 … 3 would hide only 2, so 2 is drawn.
    expect(pagerItems(4, 16)).toEqual([1, 2, 3, 4, 5, null, 16]);
    expect(pagerItems(3, 5)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("row identity across polls", () => {
  test("an unchanged run keeps its object; a changed or new one is the new object", () => {
    const a = run({ runId: "a" });
    const b = run({ runId: "b", maxLevel: 3 });
    const first = keepRowIdentity([], [a, b]);
    expect(first[0]).toBe(a);
    // The next poll parses every row afresh.
    const a2 = run({ runId: "a" });
    const b2 = run({ runId: "b", maxLevel: 4 });
    const c2 = run({ runId: "c" });
    const second = keepRowIdentity(first, [c2, a2, b2]);
    expect(second[0]).toBe(c2);
    expect(second[1]).toBe(a);
    expect(second[2]).toBe(b2);
    // So the sorted, paged rows the table draws hold the same objects too.
    expect(pageSlice(sortRuns(second, DEFAULT_SORT), 1)).toContain(a);
  });
});
