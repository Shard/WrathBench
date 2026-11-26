/**
 * The dungeon board's derivation (operator, 2026-11-14; docs/METHODOLOGY.md,
 * "The Deadmines evals, and rung 6"): a Deadmines episode read as attempts,
 * one table per id, a row per model condition. Only `deadmines-solo` has a
 * table (`BOARD_EPISODE_IDS`); the five-agent id derives the same way and
 * waits, dormant, until it is an eval.
 *
 * Versioned (`DUNGEON_BOARD_VERSION`) and recomputable over every recorded
 * run, like every number here: nothing below is recorded, it is read off the
 * runs' own stamps and their session records' events.
 *
 * - **An attempt** is a launch: one run on `deadmines-solo`, the party's five
 *   member runs on `deadmines`, grouped by party id. It counts as the
 *   scheduler counts it (`partyAttempt`, the campaigns' own rule), so the
 *   board's n is the scheduler's.
 * - **Cleared** is a counted attempt that killed all seven bosses on the
 *   route (`DEADMINES_REQUIRED`) and ended on the kill of Edwin VanCleef
 *   (`kill-target`), operator 2026-11-20. One that killed VanCleef having
 *   skipped a route boss is counted and not cleared, and ranks with the rest
 *   by bosses and the time to its last; so is one that ended on the clock, or
 *   because a member went idle or reached its call ceiling.
 * - **Time to clear** runs from launch (the earliest member's start) to the
 *   VanCleef kill as the server reported it, so a run's teardown is not in it.
 * - **Bosses** are the seven on the route to Edwin VanCleef, counted alike
 *   (`DEADMINES_REQUIRED`), as the union over the party's characters by
 *   victim (operator, 2026-11-20). Cookie, the eighth Deadmines boss, is off
 *   the route and the objective names only VanCleef, so an attempt at seven
 *   never chose to skip anything: Cookie is an optional extra, shown on the
 *   attempt (`cookie`) and never counted among its bosses or in the order.
 * - **Cost** is what the attempt's member runs cost, each read as the
 *   ladder reads a run's cost (`runCostReading`: the provider's charge, else
 *   the price table over the run's own tokens), summed. An attempt with any
 *   member unpriced has none: a partial sum would put it where no attempt
 *   was. It is shown and never orders anything.
 * - **Deaths and wipes** are shown and never order anything. A wipe is a
 *   stretch in which every character of the party is dead at once: it starts
 *   when the last one alive dies and ends at the first resurrection.
 * - **A row** is a model condition on one id: its best attempt under the
 *   board's order, how many of its counted attempts cleared ("k of n"), and
 *   n, shown from 1.
 * - **The order**: cleared rows first, by time to clear; then the rest by
 *   distinct bosses killed, more first, then by time to the last boss.
 */

import { partyAttempt } from "../src/campaigns";
import { conditionKey } from "./condition";
import { canonicalModelId } from "../../infra/model-catalogue";
import { type CostedRun, runCostReading } from "./run-cost";
import { BOARD_EPISODE_IDS, type TaskEpisodeId } from "../src/episodes";
import type { DungeonAttemptView, DungeonBoardView, DungeonRowView, ResultRun } from "./api-types";

/** The derivation's version: bumped when what a row says or how rows order changes. */
export const DUNGEON_BOARD_VERSION = 4;

/**
 * Every Deadmines boss by creature entry (docs/proposals/GROUP-PLAY.md §6):
 * Rhahk'Zor, Sneed, Sneed's Shredder, Gilnid, Mr. Smite, Captain Greenskin,
 * Edwin VanCleef, Cookie. What a timeline or the camera calls a boss kill;
 * the board counts the route's seven (`DEADMINES_REQUIRED`).
 */
export const DEADMINES_BOSSES: readonly number[] = [644, 643, 642, 1763, 646, 647, 639, 645];

/** Cookie: a Deadmines boss off the route to VanCleef, an optional extra on the board. */
export const DEADMINES_EXTRA_ENTRY = 645;

/** The seven bosses on the route to VanCleef, in the board's order: the bosses an attempt is counted by. */
export const DEADMINES_REQUIRED: readonly number[] = DEADMINES_BOSSES.filter((e) => e !== DEADMINES_EXTRA_ENTRY);

/** Edwin VanCleef: the kill that clears the episode (the definitions' `end`). */
export const DEADMINES_END_ENTRY = 639;

/** The Deadmines instance map. */
export const DEADMINES_MAP = 36;

/** One character's milestones, as its session record's `events` stream holds them. */
export interface CharacterMarks {
  character: string;
  kills: { ts: number; victimGuid: string; entry: number | null }[];
  deaths: number[];
  resurrects: number[];
  /** When the character first entered the instance, or null. */
  entered: number | null;
}

/** A Deadmines run, with its characters' milestones (one on `deadmines`, five on `deadmines-solo`). */
export interface DungeonRun {
  run: ResultRun;
  characters: CharacterMarks[];
}

/** Whether a result row counts as the scheduler counts it: scored, not overridden, no extra. */
export function countedRow(r: ResultRun): boolean {
  return r.unscored === null && !r.episodeOverride && !r.extra;
}

/**
 * What a row is keyed on: the model, whichever provider served it
 * (`canonicalModelId`, operator 2026-11-16), and the ladder's condition
 * (`condition.ts`: series, harness, effort, wiki, window, loop and `yield`)
 * with the episode left out, so a row of either id names its
 * condition as the level ladders name theirs.
 */
export function boardKey(r: Pick<ResultRun, "model" | "harnessSeries" | "harness" | "effort" | "compactWindow" | "wiki" | "condition">): string {
  const id = r.condition?.id;
  let condition: string;
  if (id !== undefined && id.startsWith("{")) {
    const { episode: _episode, ...rest } = JSON.parse(id) as Record<string, unknown>;
    condition = JSON.stringify(rest);
  } else {
    condition = conditionKey({ series: r.harnessSeries, episode: null, harness: r.harness, tuple: { effort: r.effort, compactWindow: r.compactWindow ?? null, ...(r.wiki === false ? { wiki: false } : {}) } });
  }
  return `${r.model === null ? "" : canonicalModelId(r.model)}\n${condition}`;
}

/** A run's attempts on its id: runs grouped by party id, a run with none its own attempt. */
export function attemptsOf(runs: readonly DungeonRun[]): DungeonRun[][] {
  const by = new Map<string, DungeonRun[]>();
  for (const r of runs) {
    const key = r.run.party?.id ?? `run:${r.run.runId}`;
    const list = by.get(key);
    if (list === undefined) by.set(key, [r]);
    else list.push(r);
  }
  return [...by.values()];
}

/** How many wipes the characters' deaths and resurrections make, for a party of `size`. */
export function wipesOf(characters: readonly CharacterMarks[], size: number): number {
  const events = characters.flatMap((c) => [...c.deaths.map((ts) => ({ ts, c: c.character, dead: true })), ...c.resurrects.map((ts) => ({ ts, c: c.character, dead: false }))]);
  events.sort((a, b) => a.ts - b.ts || Number(a.dead) - Number(b.dead));
  const dead = new Set<string>();
  let wipes = 0;
  let wiped = false;
  for (const e of events) {
    if (e.dead) dead.add(e.c);
    else dead.delete(e.c);
    if (!wiped && dead.size >= size) {
      wipes++;
      wiped = true;
    }
    if (wiped && dead.size < size) wiped = false;
  }
  return wipes;
}

/** An attempt's cost: its member runs' readings summed, or null when any member has none. */
export function costOf(runs: readonly CostedRun[]): number | null {
  let usd = 0;
  for (const r of runs) {
    const c = runCostReading(r);
    if (c === null) return null;
    usd += c.usd;
  }
  return runs.length === 0 ? null : usd;
}

/** One attempt, derived. */
export function attemptOf(members: readonly DungeonRun[]): DungeonAttemptView {
  const runs = members.map((m) => m.run);
  const verdict = partyAttempt(
    runs.map((r) => ({
      campaign: null,
      version: null,
      cell: null,
      ref: null,
      arm: null,
      counted: countedRow(r),
      live: r.live === true || r.pauseReason !== null,
      party: r.party === undefined ? null : { id: r.party.id, size: r.party.size },
      terminationReason: r.terminationReason,
    })),
  );
  const launchedAt = Math.min(...runs.map((r) => r.startedAt ?? Number.POSITIVE_INFINITY));
  const characters = members.flatMap((m) => m.characters);
  const kills = characters.flatMap((c) => c.kills);
  const bossKills = new Map<string, { entry: number; ts: number }>();
  for (const k of kills) {
    if (k.entry === null || !DEADMINES_REQUIRED.includes(k.entry)) continue;
    const prev = bossKills.get(k.victimGuid);
    if (prev === undefined || k.ts < prev.ts) bossKills.set(k.victimGuid, { entry: k.entry, ts: k.ts });
  }
  const bosses = [...new Set([...bossKills.values()].map((b) => b.entry))].sort((a, b) => DEADMINES_REQUIRED.indexOf(a) - DEADMINES_REQUIRED.indexOf(b));
  const cookie = kills.some((k) => k.entry === DEADMINES_EXTRA_ENTRY);
  const at = (ts: number | null): number | null => (ts === null || !Number.isFinite(launchedAt) ? null : Math.max(0, ts - launchedAt));
  const endKill = [...bossKills.values()].filter((b) => b.entry === DEADMINES_END_ENTRY).sort((a, b) => a.ts - b.ts)[0];
  const ended = runs.some((r) => r.terminationReason === "kill-target");
  const cleared = verdict.counted && ended && bosses.length === DEADMINES_REQUIRED.length;
  // The kill as the server reported it; the member's end when no mark says so.
  const clearTs = endKill?.ts ?? (ended ? (runs.find((r) => r.terminationReason === "kill-target")?.endedAt ?? null) : null);
  const lastBoss = bossKills.size === 0 ? null : Math.max(...[...bossKills.values()].map((b) => b.ts));
  const entered = characters.map((c) => c.entered).filter((t): t is number => t !== null);
  const size = runs[0]?.party?.size ?? Math.max(characters.length, 1);
  const own = runs.find((r) => r.terminationReason !== null && r.terminationReason !== "party-ended") ?? runs[0];
  return {
    runIds: runs.map((r) => r.runId).sort(),
    party: runs[0]?.party?.id ?? null,
    launchedAt: Number.isFinite(launchedAt) ? launchedAt : null,
    counted: verdict.counted,
    live: verdict.live,
    cleared,
    reason: own?.terminationReason ?? null,
    timeToClearMs: cleared ? at(clearTs) : null,
    bosses,
    cookie,
    lastBossMs: at(lastBoss),
    enteredMs: at(entered.length === 0 ? null : Math.min(...entered)),
    deaths: characters.reduce((n, c) => n + c.deaths.length, 0),
    wipes: wipesOf(characters, size),
    costUsd: costOf(runs),
  };
}

/**
 * The board's order over attempts: cleared first, by time to clear; then by
 * distinct bosses, more first, then by time to the last boss. Negative when
 * `a` ranks above `b`; ties are left at 0 for the caller to break.
 */
export function compareAttempts(a: DungeonAttemptView, b: DungeonAttemptView): number {
  if (a.cleared !== b.cleared) return a.cleared ? -1 : 1;
  const inf = Number.POSITIVE_INFINITY;
  if (a.cleared) return (a.timeToClearMs ?? inf) - (b.timeToClearMs ?? inf);
  return b.bosses.length - a.bosses.length || (a.lastBossMs ?? inf) - (b.lastBossMs ?? inf);
}

/** One id's table: a row per condition, ordered. Only counted attempts are a row's evidence. */
export function boardOf(episode: TaskEpisodeId, runs: readonly DungeonRun[]): DungeonBoardView {
  const mine = runs.filter((r) => r.run.episode === episode && r.run.episodeSource === "stamped");
  const byCondition = new Map<string, DungeonRun[]>();
  for (const r of mine) {
    const k = boardKey(r.run);
    const list = byCondition.get(k);
    if (list === undefined) byCondition.set(k, [r]);
    else list.push(r);
  }
  const rows: DungeonRowView[] = [];
  for (const list of byCondition.values()) {
    const attempts = attemptsOf(list).map(attemptOf).filter((a) => a.counted);
    if (attempts.length === 0) continue;
    const ranked = [...attempts].sort((a, b) => compareAttempts(a, b) || (a.launchedAt ?? 0) - (b.launchedAt ?? 0));
    const r = list[0]!.run;
    rows.push({
      // One model whichever provider served it (operator, 2026-11-16).
      model: r.model === null ? null : canonicalModelId(r.model),
      effort: r.effort,
      harness: r.harness,
      ...(r.compactWindow != null ? { compactWindow: r.compactWindow } : {}),
      series: r.harnessSeries,
      condition: {
        loop: r.condition?.loop ?? "snippet",
        yield: r.condition?.yield ?? false,
        pinned: r.condition?.pinned ?? true,
        wiki: r.condition?.wiki ?? r.wiki !== false,
      },
      n: attempts.length,
      cleared: attempts.filter((a) => a.cleared).length,
      best: ranked[0]!,
    });
  }
  rows.sort((a, b) => compareAttempts(a.best, b.best) || b.cleared - a.cleared || (a.model ?? "").localeCompare(b.model ?? "") || (a.effort ?? "").localeCompare(b.effort ?? ""));
  return { episode, rows };
}

/** Every table, one per id with one. */
export function boardsOf(runs: readonly DungeonRun[]): DungeonBoardView[] {
  return BOARD_EPISODE_IDS.map((ep) => boardOf(ep, runs));
}
