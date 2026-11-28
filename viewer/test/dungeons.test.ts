/**
 * The dungeon board's derivation (`viewer/dungeons.ts`; operator,
 * 2026-11-14): attempts, what clears one and when, the bosses and wipes, the
 * order, a row's best attempt and its "k of n", and that the board's n is the
 * scheduler's count on the same runs.
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_POLICY, projectModel } from "../../runner/src/models";
import type { RunFact } from "../../runner/src/run-fact";
import { attemptOf, boardDungeon, boardOf, compareAttempts, costOf, wipesOf, type CharacterMarks, type DungeonRun } from "../dungeons";
import { dungeonById, routeOf, type Dungeon } from "../../runner/src/dungeons";
import { projectDungeons } from "../public-projection";
import type { CostFigure, ResultRun } from "../api-types";

const DM: Dungeon = dungeonById("deadmines")!;
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

/** The route's six before VanCleef, a minute apart from `from`. */
const route = (from = 10): CharacterMarks["kills"] => [644, 643, 642, 1763, 646, 647].map((e, i) => kill(e, from + i));

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
    const a = attemptOf(DM, [
      solo("a", "kill-target", [
        marks("Tankpartyb", { entered: T0 + 4 * MIN, kills: [...route(20), kill(639, 101)] }),
        marks("Healpartyc", { kills: [kill(644, 20), kill(645, 60)] }),
      ], { endedAt: T0 + 103 * MIN }),
    ]);
    expect(a).toMatchObject({ counted: true, cleared: true, timeToClearMs: 101 * MIN, enteredMs: 4 * MIN, bosses: [644, 643, 642, 1763, 646, 647, 639], cookie: true, lastBossMs: 101 * MIN, reason: "kill-target", party: null });
  });

  test("a clear is all seven route bosses: VanCleef killed past a skipped Greenskin is counted, not cleared, and ranks by bosses then the last one (operator, 2026-11-20)", () => {
    const skipped = [kill(644, 10), kill(643, 11), kill(642, 12), kill(1763, 13), kill(646, 14), kill(639, 60)];
    const a = attemptOf(DM, [solo("skip", "kill-target", [marks("x", { kills: skipped })])]);
    expect(a).toMatchObject({ counted: true, cleared: false, timeToClearMs: null, bosses: [644, 643, 642, 1763, 646, 639], lastBossMs: 60 * MIN, reason: "kill-target" });
    // A slower full clear ranks above it; among the uncleared it is six bosses, above a slower six and any five.
    const full = attemptOf(DM, [solo("full", "kill-target", [marks("x", { kills: [...route(), kill(639, 200)] })])]);
    const five = attemptOf(DM, [solo("five", "episode-limit", [marks("x", { kills: [kill(644, 1), kill(643, 2), kill(642, 3), kill(1763, 4), kill(646, 5)] })])]);
    const sixSlower = attemptOf(DM, [solo("six", "episode-limit", [marks("x", { kills: route(100) })])]);
    expect([five, sixSlower, a, full].sort(compareAttempts).map((x) => x.runIds[0])).toEqual(["full", "skip", "six", "five"]);
    // The row's k of n counts only the full clear.
    const board = boardOf("deadmines-solo", [solo("skip", "kill-target", [marks("x", { kills: skipped })]), solo("full", "kill-target", [marks("x", { kills: [...route(), kill(639, 200)] })])]);
    expect([board.rows[0]!.cleared, board.rows[0]!.n, board.rows[0]!.best.runIds[0]]).toEqual([1, 2, "full"]);
  });

  test("ending on the clock, or a member's idle or call ceiling, is counted and not cleared", () => {
    for (const reason of ["episode-limit", "idle", "tool-call-limit"]) {
      expect(attemptOf(DM, [solo("a", reason, [marks("x", { kills: [kill(644, 20)] })])])).toMatchObject({ counted: true, cleared: false, timeToClearMs: null, bosses: [644] });
    }
    expect(attemptOf(DM, party("p", "idle"))).toMatchObject({ counted: true, cleared: false, party: "p" });
  });

  test("a five-agent attempt is its party: cleared when a member ended on the kill", () => {
    const a = attemptOf(DM, party("p", "kill-target", [...route(), kill(639, 90)]));
    expect(a).toMatchObject({ counted: true, cleared: true, timeToClearMs: 90 * MIN });
    expect(a.runIds).toHaveLength(5);
  });

  test("bosses are the route's seven, counted alike, as the union over characters by victim (operator, 2026-11-20)", () => {
    const a = attemptOf(DM, [solo("a", "episode-limit", [marks("x", { kills: [kill(643, 30, "s"), kill(642, 31, "sh"), kill(100, 5)] }), marks("y", { kills: [kill(643, 30, "s")] })])]);
    expect(a.bosses).toEqual([643, 642]);
    expect(a.cookie).toBe(false);
  });

  test("Cookie is an extra: shown, never a boss counted, never the last boss's time, never the order", () => {
    const route = [kill(644, 10), kill(643, 20), kill(642, 21)];
    const withCookie = attemptOf(DM, [solo("c", "episode-limit", [marks("x", { kills: [...route, kill(645, 80)] })])]);
    expect(withCookie).toMatchObject({ bosses: [644, 643, 642], cookie: true, lastBossMs: 21 * MIN });
    const quicker = attemptOf(DM, [solo("q", "episode-limit", [marks("x", { kills: [kill(644, 5), kill(643, 15), kill(642, 18)] })])]);
    expect([withCookie, quicker].sort(compareAttempts).map((x) => x.runIds[0])).toEqual(["q", "c"]);
    // A clear at seven is the whole route, with or without Cookie.
    const all7 = routeOf(DM).map((e, i) => kill(e, 10 + i));
    expect(attemptOf(DM, [solo("s", "kill-target", [marks("x", { kills: all7 })])]).bosses).toHaveLength(7);
  });

  test("the route, the end and the extra are the dungeon's: an attempt in Shadowfang Keep clears on Arugal", () => {
    const sfk = dungeonById("shadowfang-keep")!;
    const all = routeOf(sfk).map((e, i) => kill(e, 10 + i));
    const a = attemptOf(sfk, [solo("k", "kill-target", [marks("x", { kills: [...all, kill(639, 5)] })])]);
    expect(a).toMatchObject({ cleared: true, bosses: routeOf(sfk), cookie: false, timeToClearMs: (10 + all.length - 1) * MIN });
    expect(routeOf(sfk).at(-1)).toBe(4275);
    // A Deadmines boss is no boss of the keep's, and the Deadmines attempt counts none of the keep's.
    expect(attemptOf(DM, [solo("d", "episode-limit", [marks("x", { kills: [kill(4275, 5)] })])]).bosses).toEqual([]);
  });

  test("both task episodes' boards are the Deadmines', by their staged start", () => {
    expect(boardDungeon("deadmines-solo").id).toBe("deadmines");
    expect(boardDungeon("deadmines").id).toBe("deadmines");
    expect(boardOf("deadmines-solo", []).bosses).toEqual([
      { entry: 644, name: "Rhahk'Zor" },
      { entry: 643, name: "Sneed" },
      { entry: 642, name: "Sneed's Shredder" },
      { entry: 1763, name: "Gilnid" },
      { entry: 646, name: "Mr. Smite" },
      { entry: 647, name: "Captain Greenskin" },
      { entry: 639, name: "Edwin VanCleef" },
      { entry: 645, name: "Cookie", optional: true },
    ]);
  });

  test("a wipe is every character dead at once, until the first resurrection", () => {
    const at = (m: number): number => T0 + m * MIN;
    const five = PARTY.map((c, i) => marks(c, { deaths: [at(10 + i), at(40 + i)], resurrects: [at(20)] }));
    expect(wipesOf(five, 5)).toBe(2);
    const four = PARTY.slice(0, 4).map((c) => marks(c, { deaths: [at(10)] }));
    expect(wipesOf(four, 5)).toBe(0);
  });
});

const fig = (usd: number | null, basis: CostFigure["basis"]): CostFigure => ({ usd, basis, asIfMetered: false, priceId: null, asOf: null, note: "" });

describe("an attempt's cost", () => {
  test("is each member run's cost as the ladder reads it: the provider's figure, else the list price", () => {
    expect(attemptOf(DM, [solo("a", "kill-target", [], { actualCost: fig(2.5, "reported"), expectedCost: fig(9, "list-price") })]).costUsd).toBe(2.5);
    expect(attemptOf(DM, [solo("a", "kill-target", [], { actualCost: fig(null, "none"), expectedCost: fig(1.25, "list-price") })]).costUsd).toBe(1.25);
    // A reported $0 is a reading, not a blank.
    expect(attemptOf(DM, [solo("a", "kill-target", [], { actualCost: fig(0, "reported") })]).costUsd).toBe(0);
  });

  test("an unpriced run has none, and so does a party with any member unpriced; a priced party is its members' sum", () => {
    expect(attemptOf(DM, [solo("a", "kill-target", [])]).costUsd).toBeNull();
    const priced = party("p", "kill-target", [...route(), kill(639, 90)], { actualCost: fig(0.5, "reported") });
    expect(attemptOf(DM, priced).costUsd).toBe(2.5);
    const gap = priced.map((m, i) => (i === 2 ? { ...m, run: { ...m.run, actualCost: null } } : m));
    expect(attemptOf(DM, gap).costUsd).toBeNull();
    expect(costOf([])).toBeNull();
  });

  test("a row carries its best attempt's cost, and the cost orders nothing", () => {
    const runs = [
      solo("dear", "kill-target", [marks("x", { kills: [...route(), kill(639, 90)] })], { actualCost: fig(8, "reported") }),
      solo("cheap", "kill-target", [marks("x", { kills: [...route(), kill(639, 120)] })], { actualCost: fig(1, "reported") }),
    ];
    const [row] = boardOf("deadmines-solo", runs).rows;
    expect([row!.best.runIds[0], row!.best.costUsd]).toEqual(["dear", 8]);
  });
});

describe("the order", () => {
  test("cleared first by time to clear; the rest by bosses, then time to the last boss", () => {
    const A = attemptOf(DM, [solo("a", "kill-target", [marks("x", { kills: [...route(), kill(639, 120)] })])]);
    const B = attemptOf(DM, [solo("b", "kill-target", [marks("x", { kills: [...route(), kill(639, 90)] })])]);
    const C = attemptOf(DM, [solo("c", "episode-limit", [marks("x", { kills: [kill(644, 10), kill(643, 50), kill(647, 70)] })])]);
    const D = attemptOf(DM, [solo("d", "episode-limit", [marks("x", { kills: [kill(644, 10), kill(643, 40), kill(647, 60)] })])]);
    const E = attemptOf(DM, [solo("e", "episode-limit", [marks("x", { kills: [kill(644, 10)], deaths: [T0] })])]);
    expect([A, B, C, D, E].sort(compareAttempts).map((x) => x.runIds[0])).toEqual(["b", "a", "d", "c", "e"]);
  });

  test("a row is a condition's best attempt with k of n; deaths never order", () => {
    const runs = [
      solo("s1", "episode-limit", [marks("x", { kills: [kill(644, 10)] })]),
      solo("s2", "kill-target", [marks("x", { kills: [...route(), kill(639, 150)], deaths: [T0, T0, T0] })]),
      solo("s3", "attempt-failed", [], { unscored: "unscored (attempt-failed)" }),
      solo("o1", "kill-target", [marks("x", { kills: [...route(), kill(639, 200)] })], { model: "opus" }),
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
    const board = boardOf("deadmines-solo", [solo("s2", "kill-target", [marks("x", { kills: [...route(), kill(639, 150)] })], { actualCost: fig(3.5, "reported") })]);
    expect(board.rows[0]!.best.costUsd).toBe(3.5);
    const body = { version: 3, boards: [board], now: 1 };
    expect(projectDungeons(body)).toEqual(body);
  });

  test("the published bosses are the registry's names for the registry's entries, whatever the body says", () => {
    const board = { episode: "deadmines-solo" as const, bosses: [{ entry: 644, name: "Invented Foreman" }, { entry: 99999, name: "Nobody" }, { entry: 645, name: "x", optional: true as const }], rows: [] };
    expect(projectDungeons({ version: 4, boards: [board], now: 1 }).boards[0]!.bosses).toEqual([
      { entry: 644, name: "Rhahk'Zor" },
      { entry: 645, name: "Cookie", optional: true },
    ]);
    // A body from before the registry has none, and the projection adds none.
    expect("bosses" in projectDungeons({ version: 4, boards: [{ episode: "deadmines-solo", rows: [] }], now: 1 }).boards[0]!).toBe(false);
  });
});

describe("the board's n is the scheduler's count", () => {
  test("on five-agent attempts that cleared, ran out, lapsed or failed to stage", () => {
    const attempts = [party("p1", "kill-target", [...route(), kill(639, 90)]), party("p2", "episode-limit"), party("p3", "launch-failed", [], { unscored: "unscored (launch-failed)", terminationReason: "launch-failed" })];
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
