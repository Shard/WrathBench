/**
 * The dungeon board's display: labels and tooltips for the rows the viewer
 * derives (`runner/viewer/dungeons.ts`, where the order and the rules live).
 * Pure, so what the page claims is testable without a browser.
 */

import type { DungeonAttemptView, DungeonRowView, EpisodeIdView } from "../api/client";
import { COST } from "./axes";
import { fmtDuration, fmtPlaytimeTick, fmtUsd } from "./format";
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

/* ------------------------------------------------------------------- views */

/** One axis of the dungeon chart: what it reads off a row's best attempt, and how it is drawn. */
export interface DungeonAxis {
  /** The short name the view control uses: `time`, `cost`, `bosses`. */
  label: string;
  /** The caption on the plot. */
  caption: string;
  /** `log-cost` is the ladder's cost axis (decades, the $0 gutter); y is always linear. */
  scale: "linear" | "log-cost";
  ticks?: (max: number) => number[];
  better: "lower" | "higher";
  format: (v: number) => string;
  /** The reading off the attempt, or null when it has none. */
  read: (a: DungeonAttemptView) => number | null;
  /** Why an attempt with no reading is not plotted. */
  missing: (a: DungeonAttemptView) => string;
}

/** Time from launch: to the clear when the attempt cleared, else to its last boss. */
export const TIME_AXIS: DungeonAxis = {
  label: "time",
  caption: "time from launch to the clear, or to the last boss",
  scale: "linear",
  ticks: (max) => clearTimeTicks(max),
  better: "lower",
  format: fmtPlaytimeTick,
  read: (a) => (a.cleared ? a.timeToClearMs : a.lastBossMs),
  missing: (a) => (a.bosses.length === 0 ? "no boss killed" : "no time recorded"),
};

/** The best attempt's cost, as the ladder reads a run's (`runCostReading`, summed over a party's runs by the viewer). */
export const COST_AXIS: DungeonAxis = {
  label: "cost",
  caption: "the best attempt's cost (USD, log)",
  scale: "log-cost",
  better: "lower",
  format: COST.format,
  read: (a) => a.costUsd ?? null,
  missing: () => "no cost recorded",
};

/** Distinct bosses killed, of the eight. */
export const BOSSES_AXIS: DungeonAxis = {
  label: "bosses",
  caption: `bosses killed, of ${BOSS_NAMES.size}`,
  scale: "linear",
  ticks: () => bossTicks(),
  better: "higher",
  format: String,
  read: (a) => a.bosses.length,
  missing: () => "no bosses recorded",
};

export interface DungeonView {
  /** The `?view=` value, distinct from every ladder view's. */
  id: string;
  /** The control's text: `time × bosses`. */
  title: string;
  /** The control's tooltip. */
  hint: string;
  x: DungeonAxis;
  y: DungeonAxis;
  /** The fewest bosses an attempt must have killed to be plotted, when the view asks only about the furthest. */
  minBosses?: number;
}

/**
 * The views offered, default first. Each reads the row's best attempt as the
 * board chose it (`compareAttempts`, in the viewer), whatever the axes: a
 * view swaps what a point is placed by, never which attempt it is.
 *
 * - **time × bosses**, the default: speed against progress.
 * - **cost × bosses**: what an attempt cost against how far it got.
 * - **cost × time**: among the attempts that killed seven bosses or all
 *   eight, which is every clear (VanCleef is the seventh or the eighth), what
 *   each cost against how long it took; both lower is better.
 *
 * Cost is on x wherever it is drawn, as on the ladder: the layout's log axis
 * is x's alone (`ladderChartLayout`).
 */
export const DUNGEON_VIEWS: readonly DungeonView[] = [
  { id: "time-bosses", title: "time × bosses", hint: `${TIME_AXIS.caption} against ${BOSSES_AXIS.caption}`, x: TIME_AXIS, y: BOSSES_AXIS },
  { id: "cost-bosses", title: "cost × bosses", hint: `${COST_AXIS.caption} against ${BOSSES_AXIS.caption}`, x: COST_AXIS, y: BOSSES_AXIS },
  {
    id: "cost-time",
    title: "cost × time",
    hint: `${COST_AXIS.caption} against ${TIME_AXIS.caption}, for the attempts that killed 7 or 8 bosses`,
    x: COST_AXIS,
    y: TIME_AXIS,
    minBosses: 7,
  },
];

export const DEFAULT_DUNGEON_VIEW: DungeonView = DUNGEON_VIEWS[0]!;

/** The `?view=` param on a dungeon tab: anything else, a ladder view's id included, is the default. */
export function dungeonViewParam(raw: string | string[] | undefined): DungeonView {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return DUNGEON_VIEWS.find((w) => w.id === v) ?? DEFAULT_DUNGEON_VIEW;
}

/* ------------------------------------------------------------------ points */

/** One board row on the chart: its best attempt, placed by the view's axes. */
export interface DungeonPoint {
  /** `boardRowKey`. */
  key: string;
  /** As the ladder's scatter names an entry (`characterSeriesLabel`). */
  label: string;
  model: string;
  /** The view's x reading of the best attempt. */
  x: number;
  /** The view's y reading of the best attempt. */
  y: number;
  row: DungeonRowView;
}

export interface DungeonPointsModel {
  points: DungeonPoint[];
  /** Rows with no point, and why: an attempt with no reading on an axis, or short of the view's bosses. */
  omitted: { label: string; why: string }[];
}

/**
 * The chart's points: one per row, at its best attempt, so a point and a row
 * read the same attempt. On the default view a cleared attempt is placed at
 * its time to clear, an uncleared one at the time of its last boss: speed
 * against progress, more bosses in less time top-left. The order is the
 * table's, which puts every cleared row first; the chart does not restate it.
 * A row whose best attempt has no reading on either axis, or killed fewer
 * bosses than the view asks for, is left off and named in the chart's note.
 */
export function dungeonPoints(rows: readonly DungeonRowView[], view: DungeonView = DEFAULT_DUNGEON_VIEW): DungeonPointsModel {
  const points: DungeonPoint[] = [];
  const omitted: DungeonPointsModel["omitted"] = [];
  for (const row of rows) {
    const model = row.model ?? "(unnamed)";
    const label = characterSeriesLabel(model, row.effort);
    const a = row.best;
    if (view.minBosses !== undefined && a.bosses.length < view.minBosses) {
      omitted.push({ label, why: `${a.bosses.length} of ${BOSS_NAMES.size} bosses` });
      continue;
    }
    const x = view.x.read(a);
    const y = view.y.read(a);
    if (x === null || y === null) {
      omitted.push({ label, why: x === null ? view.x.missing(a) : view.y.missing(a) });
      continue;
    }
    points.push({ key: boardRowKey(row), label, model, x, y, row });
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
 * front of the rest, each by the view's own directions (less time and more
 * bosses on the default). One front over both would let an uncleared attempt
 * that got further faster hide the label of a cleared one the table ranks
 * above it.
 */
export function standingKeys(points: readonly DungeonPoint[], view: DungeonView = DEFAULT_DUNGEON_VIEW): Set<string> {
  const better = { x: view.x.better, y: view.y.better };
  const front = (cleared: boolean): string[] => paretoSteps(points.filter((p) => p.row.best.cleared === cleared), better).front.map((p) => p.key);
  return new Set([...front(true), ...front(false)]);
}

/** A point's hover: the row's name, its best attempt, its cost when it has one, and its k of n. */
export function pointTitle(p: DungeonPoint): string {
  const a = p.row.best;
  const reading = a.cleared && a.timeToClearMs !== null ? `cleared in ${fmtDuration(a.timeToClearMs)}` : `last boss ${fmtDuration(a.lastBossMs)} from launch`;
  const cost = a.costUsd === null || a.costUsd === undefined ? "" : `, ${fmtUsd(a.costUsd)}`;
  return `${p.label}: ${reading}, ${bossesText(a)} bosses${cost}; ${clearedText(p.row)} counted attempts cleared`;
}
