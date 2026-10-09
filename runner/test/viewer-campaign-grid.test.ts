/**
 * The campaigns page's grid, as a pure derivation (`campaignsView`): cells ×
 * model identities, each square saying how many counted runs reached the
 * definition's stop level and how many minutes of play it took.
 *
 * A reading, never a ranking: columns keep the assignments' order whatever
 * the squares say, and a column never pools two harness series.
 */

import { describe, expect, test } from "bun:test";
import { parseCampaigns } from "../src/campaigns";
import type { ResultRun } from "../viewer/api-types";
import { campaignsView } from "../viewer/campaigns";

/** A finished race-probe@1 run that levelled at the given minutes of play. */
function run(over: Partial<ResultRun> & { minutes?: number[] }): ResultRun {
  const minutes = over.minutes ?? [];
  const levels = minutes.map((m, i) => ({ level: i + 1, ts: 1000 + m * 60_000, turn: null, playtimeMs: m * 60_000 }));
  return {
    runId: "r",
    model: "openai/gpt-6.1-sol",
    effort: null,
    harness: "codex",
    harnessSeries: "0.5",
    campaign: "race-probe",
    campaignVersion: 1,
    cell: "orc-warrior",
    race: 2,
    class: 1,
    episode: "probing",
    extra: false,
    episodeOverride: false,
    live: false,
    pauseReason: null,
    modelResponses: 10,
    terminationReason: levels.length >= 10 ? "level-target" : "episode-limit",
    startedAt: 1000,
    levels,
    maxLevel: levels.length > 0 ? levels[levels.length - 1]!.level : null,
    ...over,
  } as unknown as ResultRun;
}

/** Ten levels, the tenth at `m` minutes. */
const toTen = (m: number): number[] => [0, 5, 12, 20, 30, 60, 100, 150, 200, m];

const roster = (assignments: { model: string; runsPerCell?: number }[]) => ({
  campaigns: parseCampaigns({ "race-probe": { version: 1, assignments } }).campaigns,
  models: [
    { name: "codex-sol-61", model: "openai/gpt-6.1-sol" },
    { name: "codex-luna-6", model: "openai/gpt-6-luna" },
  ],
});

const counted = (r: ResultRun): boolean => r.terminationReason !== null && r.modelResponses !== 0;

describe("the campaign grid", () => {
  test("a square reads reached/counted and the minutes of play to level 10, min/median/max over the runs that got there", () => {
    const runs = [
      run({ runId: "a", minutes: toTen(287) }),
      run({ runId: "b", minutes: toTen(301) }),
      run({ runId: "c", minutes: toTen(350) }),
      // Ran out of clock at level 8: counted, not reached, adds no minute.
      run({ runId: "d", minutes: [0, 5, 12, 20, 30, 60, 100, 150] }),
    ];
    const view = campaignsView(runs, roster([{ model: "codex-sol-61", runsPerCell: 4 }]), counted);
    const r = view.campaigns.find((c) => c.campaign === "race-probe")!;
    const orc = r.grid[r.cells.findIndex((c) => c.cell === "orc-warrior")]![0]!;
    expect(orc).toEqual({
      runs: 4,
      live: 0,
      counted: 4,
      reached: 3,
      minutesToTarget: { min: 287, median: 301, max: 350 },
      bestLevel: 10,
      mismatched: 0,
    });
    // The median of an even count is the lower middle: a minute a run actually took.
    const two = campaignsView([run({ runId: "a", minutes: toTen(280) }), run({ runId: "b", minutes: toTen(300) })], roster([{ model: "codex-sol-61" }]), counted);
    const sq = two.campaigns[0]!.grid[two.campaigns[0]!.cells.findIndex((c) => c.cell === "orc-warrior")]![0]!;
    expect(sq.minutesToTarget).toEqual({ min: 280, median: 280, max: 300 });
  });

  test("columns follow the assignments' order whatever the squares say", () => {
    const runs = [
      run({ runId: "fast", model: "openai/gpt-6.1-sol", minutes: toTen(287) }),
      run({ runId: "slow", model: "openai/gpt-6-luna", minutes: [0, 5, 12, 20, 30, 60, 100] }),
    ];
    const view = campaignsView(runs, roster([{ model: "codex-luna-6" }, { model: "codex-sol-61" }]), counted);
    expect(view.campaigns[0]!.columns.map((c) => c.assignment)).toEqual(["codex-luna-6", "codex-sol-61"]);
  });

  test("a column never pools two harness series", () => {
    const runs = [run({ runId: "a", harnessSeries: "0.5", minutes: toTen(300) }), run({ runId: "b", harnessSeries: "0.6", minutes: toTen(200) })];
    const view = campaignsView(runs, roster([{ model: "codex-sol-61" }]), counted);
    expect(view.campaigns[0]!.columns.map((c) => c.series)).toEqual(["0.5", "0.6"]);
  });

  test("a windowed entry's runs are its own: the compaction window is part of the column and of the assignment match", () => {
    const windowed = {
      campaigns: parseCampaigns({ "race-probe": { version: 1, assignments: [{ model: "hk" }, { model: "hk100" }] } }).campaigns,
      models: [
        { name: "hk", model: "claude-haiku-5-5", effort: "max" },
        { name: "hk100", model: "claude-haiku-5-5", effort: "max", compactWindow: "100k" },
      ],
    };
    const runs = [
      run({ runId: "auto", model: "claude-haiku-5-5", effort: "max", harness: "claude-code", minutes: toTen(500) }),
      run({ runId: "w100", model: "claude-haiku-5-5", effort: "max", compactWindow: "100k", harness: "claude-code", minutes: toTen(450) }),
    ];
    const view = campaignsView(runs, windowed, counted);
    const r = view.campaigns.find((c) => c.campaign === "race-probe")!;
    expect(r.columns.map((c) => [c.assignment, c.compactWindow])).toEqual([
      ["hk", null],
      ["hk100", "100k"],
    ]);
    const orc = r.grid[r.cells.findIndex((c) => c.cell === "orc-warrior")]!;
    expect(orc.map((sq) => sq?.minutesToTarget?.median ?? null)).toEqual([500, 450]);
    // Each counts toward its own assignment, so both of the cell's runs are credited.
    expect(r.runs).toBe(2);
  });

  test("a run that does not count is in the square's runs and nowhere else", () => {
    const runs = [run({ runId: "a", minutes: toTen(300), terminationReason: "attempt-failed" })];
    const strict = (r: ResultRun): boolean => r.terminationReason !== "attempt-failed";
    const view = campaignsView(runs, roster([{ model: "codex-sol-61" }]), strict);
    const sq = view.campaigns[0]!.grid[view.campaigns[0]!.cells.findIndex((c) => c.cell === "orc-warrior")]![0]!;
    expect(sq).toMatchObject({ runs: 1, counted: 0, reached: 0, minutesToTarget: null, bestLevel: 10 });
    expect(view.campaigns[0]!.runs).toBe(0);
  });
});
