/**
 * The dungeon board's display: labels and tooltips for the rows the viewer
 * derives (`runner/viewer/dungeons.ts`, where the order and the rules live).
 * Pure, so what the page claims is testable without a browser.
 */

import type { DungeonAttemptView, DungeonRowView, EpisodeIdView } from "../api/client";
import { fmtDuration } from "./format";
import { characterSeriesLabel, timeTicks } from "./ladder";
import { paretoSteps } from "./pareto";
import { partyHref } from "./party";

/** The Deadmines bosses by entry, in the board's order (docs/proposals/GROUP-PLAY.md §6). */
export const BOSS_NAMES: ReadonlyMap<number, string> = new Map([
  [644, "Rhahk'Zor"],
  [643, "Sneed"],
  [642, "Sneed's Shredder"],
  [1763, "Gilnid"],
  [646, "Mr. Smite"],
  [647, "Captain Greenskin"],
  [639, "Edwin VanCleef"],
  [645, "Cookie"],
]);

/** Each id's heading on the board. */
export function boardTitle(episode: EpisodeIdView): string {
  return episode === "deadmines-solo" ? "1 agent × 5" : episode === "deadmines" ? "5 agents" : episode;
}

/** The id's own tooltip: what the arm is, in a line. */
export function boardHint(episode: EpisodeIdView): string {
  return episode === "deadmines-solo"
    ? "deadmines-solo: one agent drives all five characters of the staged level-20 party."
    : "deadmines: five agents of one model, one character each.";
}

/** "k of n": how many counted attempts cleared. */
export function clearedText(row: Pick<DungeonRowView, "cleared" | "n">): string {
  return `${row.cleared} of ${row.n}`;
}

/** The best attempt's time to clear, or a dash. */
export function clearTimeText(a: DungeonAttemptView): string {
  return a.cleared && a.timeToClearMs !== null ? fmtDuration(a.timeToClearMs) : "—";
}

/** The bosses killed, as a count of the eight. */
export function bossesText(a: DungeonAttemptView): string {
  return `${a.bosses.length}/${BOSS_NAMES.size}`;
}

/** The bosses killed by name, for the count's tooltip. */
export function bossesTitle(a: DungeonAttemptView): string {
  if (a.bosses.length === 0) return "no boss killed";
  const last = a.lastBossMs === null ? "" : `; the last ${fmtDuration(a.lastBossMs)} from launch`;
  return `${a.bosses.map((e) => BOSS_NAMES.get(e) ?? String(e)).join(", ")}${last}`;
}

/** The time column's tooltip: when the party entered, and what the attempt ended on. */
export function attemptTitle(a: DungeonAttemptView): string {
  const entered = a.enteredMs === null ? "never entered the instance" : `entered ${fmtDuration(a.enteredMs)} from launch`;
  return `${entered}; ended ${a.reason ?? "—"}`;
}

/** What a board row is keyed on, for the chart and the table to light together: the model and the condition's public dimensions. */
export function boardRowKey(row: DungeonRowView): string {
  const c = row.condition;
  return JSON.stringify([row.model ?? "", row.effort ?? "", row.compactWindow ?? "", row.harness ?? "", row.series ?? "", c.loop, c.yield, c.wiki]);
}

/** Where a row's best attempt opens: its party's page on five agents, its run on one. */
export function attemptHref(row: DungeonRowView): string {
  return row.best.party !== null ? partyHref(row.best.party) : `/run/${encodeURIComponent(row.best.runIds[0] ?? "")}`;
}

/** One board row on the chart: its best attempt's time and bosses. */
export interface DungeonPoint {
  /** `boardRowKey`. */
  key: string;
  /** As the ladder's scatter names an entry (`characterSeriesLabel`). */
  label: string;
  model: string;
  /** Time from launch: to the clear when the attempt cleared, else to its last boss. */
  x: number;
  /** Distinct bosses killed, of the eight. */
  y: number;
  row: DungeonRowView;
}

export interface DungeonPointsModel {
  points: DungeonPoint[];
  /** Rows with no point, and why: an attempt that killed no boss has no time to place it at. */
  omitted: { label: string; why: string }[];
}

/**
 * The chart's points: one per row, at its best attempt, so a point and a row
 * read the same attempt. A cleared attempt is placed at its time to clear, an
 * uncleared one at the time of its last boss: speed against progress, more
 * bosses in less time top-left. The order is the table's, which puts every
 * cleared row first; the chart does not restate it. A row whose best attempt
 * killed no boss is left off and named in the chart's note.
 */
export function dungeonPoints(rows: readonly DungeonRowView[]): DungeonPointsModel {
  const points: DungeonPoint[] = [];
  const omitted: DungeonPointsModel["omitted"] = [];
  for (const row of rows) {
    const model = row.model ?? "(unnamed)";
    const label = characterSeriesLabel(model, row.effort);
    const x = row.best.cleared ? row.best.timeToClearMs : row.best.lastBossMs;
    if (x === null) {
      omitted.push({ label, why: row.best.bosses.length === 0 ? "no boss killed" : "no time recorded" });
      continue;
    }
    points.push({ key: boardRowKey(row), label, model, x, y: row.best.bosses.length, row });
  }
  return { points, omitted };
}

/**
 * The time axis: the playtime axis's steps (`timeTicks`), carried on to the
 * first tick at or past the latest point, since the last tick is the axis's
 * end and `timeTicks` may stop short of it.
 */
export function clearTimeTicks(maxMs: number): number[] {
  const ticks = timeTicks(Math.max(60_000, maxMs));
  const step = ticks.length > 1 ? ticks[1]! - ticks[0]! : 60_000;
  while (ticks[ticks.length - 1]! < maxMs) ticks.push(ticks[ticks.length - 1]! + step);
  return ticks;
}

/** The bosses axis: every count from none to all eight, so a step is a boss. */
export const bossTicks = (): number[] => Array.from({ length: BOSS_NAMES.size + 1 }, (_, i) => i);

/**
 * The points whose labels stand: the front of the cleared points and the
 * front of the rest, each by less time and more bosses. One front over both
 * would let an uncleared attempt that got further faster hide the label of a
 * cleared one the table ranks above it.
 */
export function standingKeys(points: readonly DungeonPoint[]): Set<string> {
  const better = { x: "lower", y: "higher" } as const;
  const front = (cleared: boolean): string[] => paretoSteps(points.filter((p) => p.row.best.cleared === cleared), better).front.map((p) => p.key);
  return new Set([...front(true), ...front(false)]);
}

/** A point's hover: the row's name, its best attempt, and its k of n. */
export function pointTitle(p: DungeonPoint): string {
  const a = p.row.best;
  const reading = a.cleared && a.timeToClearMs !== null ? `cleared in ${fmtDuration(a.timeToClearMs)}` : `last boss ${fmtDuration(a.lastBossMs)} from launch`;
  return `${p.label}: ${reading}, ${bossesText(a)} bosses; ${clearedText(p.row)} counted attempts cleared`;
}
