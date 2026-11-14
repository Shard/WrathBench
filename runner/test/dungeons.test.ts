/**
 * The dungeon board's derivation (`runner/viewer/dungeons.ts`; operator,
 * 2026-11-14): attempts, what clears one and when, the bosses and wipes, the
 * order, a row's best attempt and its "k of n", and that the board's n is the
 * scheduler's count on the same runs.
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_POLICY, projectModel, type RunFact } from "../src/models";
import { attemptOf, boardOf, compareAttempts, DEADMINES_BOSSES, wipesOf, type CharacterMarks, type DungeonRun } from "../viewer/dungeons";
import { projectDungeons } from "../viewer/public-projection";
import type { ResultRun } from "../viewer/api-types";

const T0 = Date.UTC(2026, 10, 14, 8);
const MIN = 60_000;
const PARTY = ["Tankpartyb", "Healpartyc", "Magepartyd", "Roguepartye", "Palapartyf"];
const MEMBERS = ["tank", "healer", "mage", "rogue", "paladin"];

function resultRun(over: Partial<ResultRun> = {}): ResultRun {
  return {
    runId: "r", model: "sonnet", platform: null, harnessVersion: "harness-1.0-1", harnessSeries: "1.0", extra: false, effort: "max",
    race: 1, raceName: "Human", class: 1, className: "Warrior", characterLabel: "Human Warrior",
    campaign: null, cell: null,
    harness: "claude-code", promptHash: null, serverBuild: null, wikiCoords: false,
    toolCalls: null, snippets: null, modelResponses: 50,
    episode: "deadmines-solo", episodeSource: "stamped", episodeOverride: false, unscored: null,
    startedAt: T0, endedAt: T0 + 240 * MIN, live: false, terminationReason: "episode-limit", levels: [], maxLevel: 20,
    questsCompleted: null, maps: [], xp: null, money: null,
    character: null, playtimeMs: null, tokens: null, actualCost: null, pauseReason: null,
    continuedFrom: null, stillborn: false,
    ...over,
  } as ResultRun;
}

function marks(character: string, over: Partial<CharacterMarks> = {}): CharacterMarks {
  return { character, kills: [], deaths: [], resurrects: [], entered: null, ...over };
}

const kill = (entry: number, atMin: number, guid = `g${entry}`) => ({ ts: T0 + atMin * MIN, victimGuid: guid, entry });

/** A one-agent run: five characters' marks on one run. */
function solo(id: string, reason: string, characters: CharacterMarks[], over: Partial<ResultRun> = {}): DungeonRun {
  return { run: resultRun({ runId: id, terminationReason: reason, ...over }), characters };
}

/** A five-agent attempt: one run per member, `first` ending on its own verdict, the rest party-ended. */
function party(id: string, first: string, kills: CharacterMarks["kills"] = [], over: Partial<ResultRun> = {}): DungeonRun[] {
  return MEMBERS.map((m, i) => ({
    run: resultRun({ runId: `${id}-${m}`, episode: "deadmines", party: { id, member: m, size: 5 }, terminationReason: i === 0 ? first : "party-ended", ...over }),
    characters: [marks(PARTY[i]!, i === 0 ? { kills } : {})],
  }));
}

describe("an attempt", () => {
  test("clears on the VanCleef kill, timed from launch to the kill the server reported", () => {
    const a = attemptOf([
      solo("a", "kill-target", [
        marks("Tankpartyb", { entered: T0 + 4 * MIN, kills: [kill(644, 20), kill(639, 101)] }),
        marks("Healpartyc", { kills: [kill(644, 20), kill(645, 60)] }),
      ], { endedAt: T0 + 103 * MIN }),
    ]);
    expect(a).toMatchObject({ counted: true, cleared: true, timeToClearMs: 101 * MIN, enteredMs: 4 * MIN, bosses: [644, 639, 645], lastBossMs: 101 * MIN, reason: "kill-target", party: null });
  });

  test("ending on the clock, or a member's idle or call ceiling, is counted and not cleared", () => {
    for (const reason of ["episode-limit", "idle", "tool-call-limit"]) {
      expect(attemptOf([solo("a", reason, [marks("x", { kills: [kill(644, 20)] })])])).toMatchObject({ counted: true, cleared: false, timeToClearMs: null, bosses: [644] });
    }
    expect(attemptOf(party("p", "idle"))).toMatchObject({ counted: true, cleared: false, party: "p" });
  });

  test("a five-agent attempt is its party: cleared when a member ended on the kill", () => {
    const a = attemptOf(party("p", "kill-target", [kill(639, 90)]));
    expect(a).toMatchObject({ counted: true, cleared: true, timeToClearMs: 90 * MIN });
    expect(a.runIds).toHaveLength(5);
  });

  test("bosses are the eight entries, counted alike, as the union over characters by victim", () => {
    expect(DEADMINES_BOSSES).toEqual([644, 643, 642, 1763, 646, 647, 639, 645]);
    const a = attemptOf([solo("a", "episode-limit", [marks("x", { kills: [kill(643, 30, "s"), kill(642, 31, "sh"), kill(100, 5)] }), marks("y", { kills: [kill(643, 30, "s")] })])]);
    expect(a.bosses).toEqual([643, 642]);
  });

  test("a wipe is every character dead at once, until the first resurrection", () => {
    const at = (m: number): number => T0 + m * MIN;
    const five = PARTY.map((c, i) => marks(c, { deaths: [at(10 + i), at(40 + i)], resurrects: [at(20)] }));
    expect(wipesOf(five, 5)).toBe(2);
    const four = PARTY.slice(0, 4).map((c) => marks(c, { deaths: [at(10)] }));
    expect(wipesOf(four, 5)).toBe(0);
  });
});

describe("the order", () => {
  test("cleared first by time to clear; the rest by bosses, then time to the last boss", () => {
    const A = attemptOf([solo("a", "kill-target", [marks("x", { kills: [kill(639, 120)] })])]);
    const B = attemptOf([solo("b", "kill-target", [marks("x", { kills: [kill(639, 90)] })])]);
    const C = attemptOf([solo("c", "episode-limit", [marks("x", { kills: [kill(644, 10), kill(643, 50), kill(647, 70)] })])]);
    const D = attemptOf([solo("d", "episode-limit", [marks("x", { kills: [kill(644, 10), kill(643, 40), kill(647, 60)] })])]);
    const E = attemptOf([solo("e", "episode-limit", [marks("x", { kills: [kill(644, 10)], deaths: [T0] })])]);
    expect([A, B, C, D, E].sort(compareAttempts).map((x) => x.runIds[0])).toEqual(["b", "a", "d", "c", "e"]);
  });

  test("a row is a condition's best attempt with k of n; deaths never order", () => {
    const runs = [
      solo("s1", "episode-limit", [marks("x", { kills: [kill(644, 10)] })]),
      solo("s2", "kill-target", [marks("x", { kills: [kill(639, 150)], deaths: [T0, T0, T0] })]),
      solo("s3", "attempt-failed", [], { unscored: "unscored (attempt-failed)" }),
      solo("o1", "kill-target", [marks("x", { kills: [kill(639, 200)] })], { model: "opus" }),
      solo("g1", "episode-limit", [marks("x", { kills: [kill(644, 10), kill(643, 20)] })], { model: "glm" }),
    ];
    const board = boardOf("deadmines-solo", runs);
    expect(board.rows.map((r) => [r.model, r.cleared, r.n, r.best.runIds[0]])).toEqual([
      ["sonnet", 1, 2, "s2"],
      ["opus", 1, 1, "o1"],
      ["glm", 0, 1, "g1"],
    ]);
    expect(boardOf("deadmines", runs).rows).toEqual([]);
  });

  test("the published board carries the same numbers", () => {
    const board = boardOf("deadmines-solo", [solo("s2", "kill-target", [marks("x", { kills: [kill(639, 150)] })])]);
    const body = { version: 1, boards: [board], now: 1 };
    expect(projectDungeons(body)).toEqual(body);
  });
});

describe("the board's n is the scheduler's count", () => {
  test("on five-agent attempts that cleared, ran out, lapsed or failed to stage", () => {
    const attempts = [party("p1", "kill-target", [kill(639, 90)]), party("p2", "episode-limit"), party("p3", "launch-failed", [], { unscored: "unscored (launch-failed)", terminationReason: "launch-failed" })];
    const board = boardOf("deadmines", attempts.flat());
    const facts: RunFact[] = attempts.flat().map((d) => ({
      runId: `fleet-${d.run.runId}`, model: "sonnet", effort: "max", episode: "deadmines", episodeOverride: false, harnessVersion: "harness-1.0-1", harnessSeries: "1.0",
      loop: "program", yield: true, extra: false, startedAt: T0, endedAt: T0 + MIN, terminationReason: d.run.terminationReason, modelResponses: d.run.terminationReason === "launch-failed" ? null : 50,
      bestLevel: 20, live: false, pause: null, account: null, character: null, episodeMs: 14_400_000, campaign: null, cell: null, credential: null, driver: "claude-code",
      party: { id: d.run.party!.id, member: d.run.party!.member, size: 5 },
    }) as RunFact);
    const stats = projectModel({ name: "son", model: "sonnet", effort: "max", driver: "claude-code", tier: "t2", deadmines: true }, facts, { ...DEFAULT_POLICY, series: "1.0" }, { now: T0 + 300 * MIN }).perEpisode.deadmines!;
    expect(board.rows[0]!.n).toBe(stats.counted);
    expect(board.rows[0]!.n).toBe(2);
  });
});
