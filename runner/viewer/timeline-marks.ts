/**
 * What a run's timeline marks, and as what: the one rule the dashboard's
 * timeline, the replay video's chapter list and the camera that cuts the
 * video all read (operator, 2026-11-16).
 *
 * - A **chapter** is a level reached or a boss killed, and nothing else. A
 *   turn-in was one until a real run's bar was a solid band of them, and a
 *   zone crossed likewise: neither says where in a run a reader is.
 * - A death is an **event**: a red tick, never a chapter.
 * - Everything else the camera once marked (`quest`, `zone`) is nothing. A
 *   `clips.json` cut before this rule still lists them and still plays; a
 *   reader drops them here rather than drawing them.
 *
 * Pure, with no imports beyond types and the import-free kinds
 * (`runner/src/mark-kinds.ts`): the camera in `infra/`, the viewer and the
 * browser bundle all load it.
 */

import type { LevelUpFacts } from "./api-types";

import { isChapter, MARK_KINDS, type MarkKind, type MarkRole } from "../src/mark-kinds";

/* The kinds and their roles, from the import-free leaf the camera's layout reads too. */
export { CHAPTER_KINDS, isChapter, MARK_KINDS, markRole, type MarkKind, type MarkRole } from "../src/mark-kinds";

/** Creature rank 3 is a boss (`creature_template.rank`). */
export const BOSS_RANK = 3;

/**
 * Whether a recorded kill is a boss kill: the creature's rank says so, or its
 * entry is one a caller names (a five-man dungeon's bosses are elites, rank 1,
 * and are known only by entry).
 */
export function isBossKill(kill: { entry?: number | null | undefined; rank?: number | null | undefined }, named: ReadonlySet<number> = new Set()): boolean {
  return kill.rank === BOSS_RANK || (typeof kill.entry === "number" && named.has(kill.entry));
}

/**
 * A run's boss kills off the kills the server reported to it: each boss once
 * (a party's kill is told to every member in range, and a recorder that
 * restarted can be told again), oldest first, named where `names` knows the
 * entry.
 */
export function bossKillsOf(
  kills: readonly { ts: number; victimGuid: string; entry: number | null; rank?: number | undefined }[],
  named: ReadonlySet<number>,
  names: ReadonlyMap<number, string> = new Map(),
): BossKill[] {
  const seen = new Set<string>();
  const out: BossKill[] = [];
  for (const k of [...kills].sort((a, b) => a.ts - b.ts)) {
    if (!isBossKill(k, named) || seen.has(k.victimGuid)) continue;
    seen.add(k.victimGuid);
    out.push({ ts: k.ts, entry: k.entry, name: k.entry === null ? null : (names.get(k.entry) ?? null) });
  }
  return out;
}

/** One mark on a run's timeline, at a run time. */
export interface TimelineMark {
  /** Run time, epoch ms. */
  ts: number;
  kind: MarkKind;
  role: MarkRole;
  /** Our own short text: numbers and ids, never game prose. */
  label: string;
  /** A level mark's level. */
  level?: number;
}

/** A boss kill as a run's detail states it. */
export interface BossKill {
  ts: number;
  entry: number | null;
  name: string | null;
}

/**
 * The levels gained across a run's state samples: one per climb between two
 * consecutive readings, at the later one. What a detail that carries no level
 * marks (a public snapshot, a run from before the marks) is read by; the
 * samples are a minute apart, so it is a minute coarser than a mark.
 */
export function levelUpsOf(states: readonly { ts: number; level: number | null }[]): { ts: number; from: number; to: number }[] {
  const out: { ts: number; from: number; to: number }[] = [];
  let level: number | null = null;
  for (const s of states) {
    if (s.level === null) continue;
    if (level !== null && s.level > level) out.push({ ts: s.ts, from: level, to: s.level });
    level = s.level;
  }
  return out;
}

/**
 * A run's marks, oldest first, from what its detail records: each level
 * gained (a recorder's first reading states a baseline and is not one), each
 * boss kill, each death that carries a time. The levels come from the level
 * marks where the detail has them and from its state samples where it does
 * not.
 */
export function runMarks(facts: {
  leveling?: Pick<LevelUpFacts, "marks"> | null | undefined;
  states?: readonly { ts: number; level: number | null }[] | undefined;
  deaths?: { sites: readonly { ts?: number | undefined }[] } | null | undefined;
  bosses?: readonly BossKill[] | null | undefined;
}): TimelineMark[] {
  const out: TimelineMark[] = [];
  const levels = facts.leveling?.marks ?? levelUpsOf(facts.states ?? []);
  for (const m of levels) {
    if (m.from === null || m.to <= m.from) continue;
    out.push({ ts: m.ts, kind: "level", role: "chapter", label: `level ${m.to}`, level: m.to });
  }
  for (const b of facts.bosses ?? []) {
    out.push({ ts: b.ts, kind: "boss", role: "chapter", label: b.name ?? (b.entry === null ? "boss killed" : `boss ${b.entry}`) });
  }
  for (const d of facts.deaths?.sites ?? []) {
    if (typeof d.ts === "number") out.push({ ts: d.ts, kind: "death", role: "event", label: "died" });
  }
  return out.sort((a, b) => a.ts - b.ts || MARK_KINDS.indexOf(a.kind) - MARK_KINDS.indexOf(b.kind));
}

/** The level a run began on: its level marks' word, else its first state sample's. */
export function startLevelOf(facts: { leveling?: Pick<LevelUpFacts, "startLevel"> | null | undefined; states?: readonly { level: number | null }[] | undefined }): number | null {
  return facts.leveling?.startLevel ?? facts.states?.find((s) => s.level !== null)?.level ?? null;
}

/** The marks that are chapters. */
export function chaptersOf<T extends { type: string }>(marks: readonly T[]): T[] {
  return marks.filter((m) => isChapter(m.type));
}

/**
 * The level a run is on at each stretch of `span`, for the timeline's bands:
 * one band per level, from the mark that reached it to the next. The first
 * band, before any level mark, carries `start` (the level the run began on)
 * or null where that is unknown.
 */
export function levelBands(marks: readonly TimelineMark[], span: { from: number; to: number }, start: number | null = null): { from: number; to: number; level: number | null }[] {
  const out: { from: number; to: number; level: number | null }[] = [];
  let at = span.from;
  let level = start;
  for (const m of marks) {
    if (m.kind !== "level" || m.level === undefined) continue;
    const ts = Math.min(span.to, Math.max(span.from, m.ts));
    if (ts > at) out.push({ from: at, to: ts, level });
    at = ts;
    level = m.level;
  }
  if (span.to > at || out.length === 0) out.push({ from: at, to: span.to, level });
  return out;
}
