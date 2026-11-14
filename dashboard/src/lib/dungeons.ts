/**
 * The dungeon board's display: labels and tooltips for the rows the viewer
 * derives (`runner/viewer/dungeons.ts`, where the order and the rules live).
 * Pure, so what the page claims is testable without a browser.
 */

import type { DungeonAttemptView, DungeonRowView, EpisodeIdView } from "../api/client";
import { fmtDuration } from "./format";

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
