/**
 * The campaigns page's numbers, as a pure derivation (`campaignsView`): one
 * entry per published version, a column per assignment × arm, a square per
 * cell, and the arms side by side per assignment.
 *
 * A reading, never a ranking: columns keep the assignments' and the arms'
 * order whatever the squares say. Progress and state come from the same tally
 * the scheduler uses, so "complete" never stands beside a short count.
 */

import { describe, expect, test } from "bun:test";
import { parseCampaignBlocks } from "../src/campaigns";
import type { CostFigure, ResultRun } from "../viewer/api-types";
import { campaignsView, type CampaignsRoster } from "../viewer/campaigns";
import { defsBlock, definition } from "./fixtures/campaigns";

const arms = definition({
  id: "wake",
  question: "Does waking on events beat polling?",
  cells: [
    { id: "orc-warrior", race: 2, class: 1 },
    { id: "human-warrior", race: 1, class: 1 },
  ],
  arms: [
    { id: "poll", image: "r.example/wb/runner:harness-0.5-931" },
    { id: "wake", image: "r.example/wb/runner:harness-0.5-931-wake", args: ["--compact-window", "200k"] },
  ],
  maxAttemptsPerCell: 2,
});

function cost(usd: number, asIfMetered = false): CostFigure {
  return { usd, basis: "reported", asIfMetered, breakdown: null, priceId: null, asOf: null, note: "" } as CostFigure;
}

/** A finished run of `wake@1` that levelled at the given minutes of play. */
function run(over: Partial<ResultRun> & { minutes?: number[] }): ResultRun {
  const minutes = over.minutes ?? [];
  const levels = minutes.map((m, i) => ({ level: i + 1, ts: 1000 + m * 60_000, turn: (i + 1) * 10, playtimeMs: m * 60_000 }));
  return {
    runId: "r",
    model: "sonnet",
    effort: "low",
    harness: "claude-code",
    harnessVersion: "harness-0.5-931",
    harnessSeries: "0.5",
    campaign: "wake",
    campaignVersion: 1,
    cell: "orc-warrior",
    arm: "poll",
    ref: "sonnet",
    race: 2,
    class: 1,
    episode: "probing",
    extra: false,
    episodeOverride: false,
    modelResponses: 10,
    terminationReason: levels.length >= 10 ? "level-target" : "episode-limit",
    startedAt: 1000,
    levels,
    maxLevel: levels.length > 0 ? levels[levels.length - 1]!.level : null,
    tokens: null,
    actualCost: null,
    ...over,
  } as unknown as ResultRun;
}

/** Ten levels, the tenth at `m` minutes. */
const toTen = (m: number): number[] => [0, 5, 12, 20, 30, 60, 100, 150, 200, m];

const MODELS: CampaignsRoster["models"] = [
  { name: "sonnet", model: "sonnet", effort: "low", driver: "claude-code" },
  { name: "haiku", model: "haiku", effort: "max", driver: "claude-code" },
];

function roster(rows: Record<string, unknown>, defs = [arms]): CampaignsRoster {
  const pairs = Object.fromEntries(MODELS.map((m) => [m.name, { driver: m.driver, compactWindow: m.compactWindow }]));
  const r = parseCampaignBlocks(defsBlock(...defs), rows, pairs);
  return { campaigns: r.campaigns, campaignDefs: r.definitions, campaignRefusals: r.refused, models: MODELS };
}

const ROW = { wake: { version: 1, assignments: [{ model: "sonnet" }, { model: "haiku" }] } };
const counted = (r: ResultRun): boolean => r.terminationReason !== null && r.modelResponses !== 0;
const view = (runs: ResultRun[], rows: Record<string, unknown> = ROW) => campaignsView(runs, roster(rows), counted).campaigns[0]!;

describe("one entry per published version", () => {
  test("the definition, its provenance and the store row, with the effective window per column", () => {
    const v = view([]);
    expect(v).toMatchObject({ id: "wake", version: 1, key: "wake@1", question: "Does waking on events beat polling?", state: "queued" });
    expect(v.source).toMatchObject({ path: "runner/campaigns/wake@1.json", branch: ["master"] });
    expect(v.arms).toEqual([
      { id: "poll", image: "r.example/wb/runner:harness-0.5-931", command: null, args: [] },
      { id: "wake", image: "r.example/wb/runner:harness-0.5-931-wake", command: null, args: ["--compact-window", "200k"] },
    ]);
    expect(v.columns.map((c) => `${c.key}:${c.compactWindow ?? "auto"}`)).toEqual(["sonnet/poll:auto", "sonnet/wake:200k", "haiku/poll:auto", "haiku/wake:200k"]);
    expect(v.config!.assignments.map((a) => a.ref)).toEqual(["sonnet", "haiku"]);
    expect(v.progress).toEqual({ want: 2 * 2 * 2, done: 0, attempted: 0, capped: 0, live: 0 });
  });

  test("a published version no row names is listed as unassigned, with no columns", () => {
    const other = definition({ id: "zeta" });
    const r = campaignsView([], roster(ROW, [arms, other]), counted).campaigns;
    expect(r.map((c) => `${c.key}:${c.state}`)).toEqual(["wake@1:queued", "zeta@1:unassigned"]);
    expect(r[1]!.config).toBeNull();
    expect(r[1]!.columns).toEqual([]);
  });
});

describe("the squares", () => {
  test("runs are ended runs; live ones are apart; runIds holds both", () => {
    const v = view([run({ runId: "done", minutes: toTen(300) }), run({ runId: "live", terminationReason: null, startedAt: 2000 })]);
    const sq = v.grid[0]!.squares[0]!;
    expect(sq).toMatchObject({ column: "sonnet/poll", runs: 1, counted: 1, reached: 1, live: 1, bestLevel: 10, runIds: ["done", "live"] });
    expect(sq.minutesToStop).toEqual({ min: 300, median: 300, max: 300 });
    expect(v.state).toBe("running");
    // A live-only square still links.
    const onlyLive = view([run({ runId: "l", terminationReason: null })]).grid[0]!.squares[0]!;
    expect(onlyLive).toMatchObject({ runs: 0, live: 1, runIds: ["l"] });
  });

  test("a run belongs to a square by its stamps: a run with no arm is in no square", () => {
    const v = view([run({ runId: "old", arm: null }), run({ runId: "wrong-arm", arm: "nope" }), run({ runId: "ok", arm: "wake", cell: "human-warrior", race: 1 })]);
    const all = v.grid.flatMap((g) => g.squares.flatMap((s) => s.runIds));
    expect(all).toEqual(["ok"]);
    expect(v.grid[1]!.squares[1]).toMatchObject({ column: "sonnet/wake", runs: 1 });
  });

  test("builds are the harness versions the square's runs ran on; a start that is not the cell's is flagged", () => {
    const v = view([run({ runId: "a", harnessVersion: "harness-0.5-931" }), run({ runId: "b", harnessVersion: "harness-0.5-932", race: 1 })]);
    expect(v.grid[0]!.squares[0]).toMatchObject({ builds: ["harness-0.5-931", "harness-0.5-932"], mismatchedStart: 1 });
  });

  test("cost is what was billed: a subscription's as-if-metered figure is not money anyone paid", () => {
    const v = view([run({ runId: "a", actualCost: cost(1.5) }), run({ runId: "b", actualCost: cost(9, true) }), run({ runId: "c" })]);
    expect(v.grid[0]!.squares[0]!.costUsd).toBe(1.5);
    expect(v.costUsd).toBe(1.5);
    expect(view([run({ actualCost: cost(9, true) })]).costUsd).toBeNull();
  });
});

describe("progress and state agree", () => {
  test("a capped square is settled in the count and the state alike: done + capped = want, complete", () => {
    const one = { wake: { version: 1, assignments: [{ model: "sonnet" }] } };
    const runs = [
      run({ runId: "1", minutes: toTen(100) }),
      run({ runId: "2", arm: "wake", modelResponses: 0 }),
      run({ runId: "3", arm: "wake", modelResponses: 0 }),
      run({ runId: "4", cell: "human-warrior", race: 1, minutes: toTen(100) }),
      run({ runId: "5", cell: "human-warrior", race: 1, arm: "wake", minutes: toTen(90) }),
    ];
    const v = view(runs, one);
    expect(v.progress).toEqual({ want: 4, done: 3, attempted: 5, capped: 1, live: 0 });
    expect(v.state).toBe("complete");
    expect(v.grid[0]!.squares[1]).toMatchObject({ settled: "capped", want: 1 });
  });

  test("a disabled row with work left is disabled, not complete", () => {
    expect(view([], { wake: { ...ROW.wake, enabled: false } }).state).toBe("disabled");
  });
});

describe("the arm comparison", () => {
  test("per assignment, one summary per arm: medians to the stop level over the counted runs that reached it", () => {
    const runs = [
      run({ runId: "p1", minutes: toTen(300), tokens: { promptTokens: 1000 } as never, actualCost: cost(2) }),
      run({ runId: "p2", cell: "human-warrior", race: 1, minutes: toTen(200), tokens: { promptTokens: 3000 } as never, actualCost: cost(4) }),
      run({ runId: "p3", minutes: [0, 5, 12] }),
      run({ runId: "w1", arm: "wake", minutes: toTen(120), tokens: { promptTokens: 500 } as never, actualCost: cost(1, true) }),
    ];
    const v = view(runs);
    const sonnet = v.comparison.find((c) => c.ref === "sonnet")!;
    expect(sonnet.arms.map((a) => a.arm)).toEqual(["poll", "wake"]);
    expect(sonnet.arms[0]).toMatchObject({
      runs: 3,
      reached: 2,
      medianMinutesToStop: 200,
      medianTurnsToStop: 100,
      medianCostToStop: 2,
      medianPromptTokensToStop: 1000,
      terminations: { "level-target": 2, "episode-limit": 1 },
      costAsIfMetered: 0,
    });
    // The subscription arm's as-if-metered figure is its cost to the stop, and says so.
    expect(sonnet.arms[1]).toMatchObject({ reached: 1, medianMinutesToStop: 120, medianCostToStop: 1, costAsIfMetered: 1 });
    expect(v.comparison.find((c) => c.ref === "haiku")!.arms[0]).toMatchObject({ runs: 0, reached: 0, medianMinutesToStop: null });
  });
});

describe("history and refusals", () => {
  test("a (ref, arm) only the runs remember keeps its column after the row moves on", () => {
    const v = view([run({ runId: "gone", ref: "retired-entry", model: "old/model" })], { wake: { version: 1, assignments: [{ model: "sonnet" }] } });
    expect(v.columns.map((c) => c.key)).toEqual(["sonnet/poll", "sonnet/wake", "retired-entry/poll", "retired-entry/wake"]);
    expect(v.grid[0]!.squares[2]).toMatchObject({ runs: 1, want: 0 });
    expect(v.progress.want).toBe(4);
  });

  test("a pair that cannot launch is in refused[] by `<id>@<v>:<ref>:<arm>` and on its squares", () => {
    const windowed: CampaignsRoster["models"] = [...MODELS, { name: "sonnet-1m", model: "sonnet", effort: "low", driver: "claude-code", compactWindow: "1M" }];
    const pairs = Object.fromEntries(windowed.map((m) => [m.name, { driver: m.driver, compactWindow: m.compactWindow }]));
    const r = parseCampaignBlocks(defsBlock(arms), { wake: { version: 1, assignments: [{ model: "sonnet-1m" }] } }, pairs);
    const body = campaignsView([], { campaigns: r.campaigns, campaignDefs: r.definitions, campaignRefusals: r.refused, models: windowed }, counted);
    expect(body.refused).toEqual([{ key: "wake@1:sonnet-1m:wake", reason: expect.stringContaining("already sets compactWindow 1M") }]);
    expect(body.campaigns[0]!.grid[0]!.squares[1]!.refused).toContain("already sets compactWindow");
  });
});
