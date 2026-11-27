/**
 * The runs table's pure layer: the readings, the sort, the filter and the pages.
 *
 * What matters: the default is every run newest first, the sort is stable and
 * "not recorded" sorts last, the readings are of fields the server decided,
 * and the page degrades against a viewer that predates `live`.
 */

import { describe, expect, test } from "bun:test";
import type { ResultRun } from "../../viewer/api-types";
import { STALL_PAUSE } from "../../runner/src/lapse";
import { projectResults } from "../../viewer/public-projection";
import {
  DEFAULT_SORT,
  STALL_PAUSE_REASON,
  clampPage,
  costOf,
  filterParams,
  filterRuns,
  kindOf,
  pageCount,
  pageSlice,
  runListCost,
  runsHref,
  sortRuns,
  statusOf,
  statusText,
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

  test("kind reads the campaign, the tier, the unscored reason, and the extra flag, in that order", () => {
    expect(kindOf(run({ campaign: "nav", cell: "tram" }))).toBe("probe nav/tram");
    expect(kindOf(run({ episode: "freeplay", unscored: "unscored (episode freeplay)" }))).toBe("freeplay");
    expect(kindOf(run({ unscored: "unscored (operator objective)" }))).toBe("objective");
    expect(kindOf(run({ unscored: "unscored (scripted stub)" }))).toBe("unscored");
    expect(kindOf(run({ extra: true }))).toBe("scored (extra)");
    expect(kindOf(run())).toBe("scored");
  });

  test("cost is the actual, else the estimate (tilded), else nothing", () => {
    expect(costOf(run())).toBeNull();
    const fig = { usd: 1.5, basis: "reported" as const, asIfMetered: false, breakdown: null, priceId: null, asOf: null, note: "" };
    const est = { ...fig, usd: 0.75, basis: "list-price" as const, asIfMetered: true, asOf: "2026-11-01" };
    expect(costOf(run({ actualCost: fig, expectedCost: est }))).toBe(1.5);
    expect(costOf(run({ actualCost: { ...fig, basis: "none", usd: null }, expectedCost: est }))).toBe(0.75);
    expect(runListCost(run({ actualCost: { ...fig, basis: "none", usd: null }, expectedCost: est }))).toMatchObject({ estimate: true, text: "~$0.750" });
    expect(costOf(run({ actualCost: { ...fig, basis: "none", usd: null } }))).toBeNull();
    expect(runListCost(run())).toMatchObject({ text: "—", title: "no cost recorded for this run" });
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

  test("cost sorts on the figure the column shows: an estimate interleaves with the actuals, an unpriced run sorts last", () => {
    const fig = { usd: 0, basis: "reported" as const, asIfMetered: false, breakdown: null, priceId: null, asOf: null, note: "" };
    const none = { ...fig, basis: "none" as const, usd: null };
    const est = (usd: number) => ({ ...fig, usd, basis: "list-price" as const, asIfMetered: true, asOf: "2026-11-01" });
    const costed = [
      run({ runId: "or-actual", startedAt: 1, actualCost: { ...fig, usd: 2 }, expectedCost: est(9) }),
      run({ runId: "go-est", startedAt: 2, actualCost: none, expectedCost: est(3) }),
      run({ runId: "codex-est", startedAt: 3, actualCost: none, expectedCost: est(1) }),
      run({ runId: "unpriced", startedAt: 4, actualCost: none, expectedCost: none }),
    ];
    expect(sortRuns(costed, { column: "cost", dir: "desc" }).map((r) => r.runId)).toEqual(["go-est", "or-actual", "codex-est", "unpriced"]);
    expect(sortRuns(costed, { column: "cost", dir: "asc" }).map((r) => r.runId)).toEqual(["codex-est", "or-actual", "go-est", "unpriced"]);
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
    expect(filterRuns(rows, filterParams({ model: "m" })).map((r) => r.runId)).toEqual(["base", "probe"]);
    expect(filterRuns(rows, filterParams({ model: "m", effort: "low" })).map((r) => r.runId)).toEqual(["low"]);
  });

  test("a model link in either provider's spelling lists the model's runs on every provider", () => {
    const ds = [
      run({ runId: "go", model: "deepseek-v4.1-flash" }),
      run({ runId: "or", model: "deepseek/deepseek-v4.1-flash" }),
      run({ runId: "other", model: "deepseek/deepseek-v4-flash" }),
    ];
    // An old link from the Go row and one from the OpenRouter row land on the same runs.
    for (const model of ["deepseek-v4.1-flash", "deepseek/deepseek-v4.1-flash", "DeepSeek/DeepSeek-V4.1-Flash"]) {
      const href = runsHref({ model, episode: "e90" });
      const params = Object.fromEntries(new URL(href, "https://x.invalid").searchParams);
      expect(filterRuns(ds, filterParams(params)).map((r) => r.runId)).toEqual(["go", "or"]);
    }
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

  test("a page past the end shows the last one", () => {
    expect(pageCount(101)).toBe(2);
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
});

