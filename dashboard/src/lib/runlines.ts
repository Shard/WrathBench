/**
 * The scored ladder's second chart: one line per roster entry, the mean of its
 * counted runs' xp earned against active playtime — the freeplay field's
 * reading (`CharacterChart`) for a tier, with entries in place of characters
 * and xp in place of level so progress inside a level shows. One line per
 * entry, not per run, because a tier's dozens of runs drawn singly were noise
 * the reader had to average by eye; an entry is the scatter's grouping
 * (`pointKey`), so a line and a point name the same roster entry.
 *
 * Built from what a `ResultRun` already carries — its level marks with their
 * active playtime, its `xpEarned` and its `playtimeMs` — so the chart costs no
 * request per run. A run's line is a lower bound, like everything it is drawn
 * from: a level mark is the first 60-second sample that showed the level, and
 * the xp at that mark is where the level begins, so the ding was at or before
 * the point and the xp at or above it. Between marks the line is straight,
 * which says only that the run got from one to the next. How the runs'
 * lines become the entry's is `EntryLine`'s.
 *
 * Pure, so the series and the layout are testable without a browser
 * (`test/ladder.test.ts`); `components/RunLinesChart.tsx` only draws them.
 */

import type { ResultRun } from "@viewer/api-types";
import { DEFAULT_BETTER, LEVEL_START_XP, levelOfXp, xpEarnedOf, xpLevelTicks } from "./axes";
import { scaleLinear } from "./chart";
import {
  type ChartBox,
  type ChartCue,
  type Leader,
  MARK_R,
  MARK_RING_R,
  characterIconCx,
  characterSeriesLabel,
  chartCue,
  hoverKeyOf,
  pointKey,
  puckRect,
  scored,
  timeTicks,
} from "./ladder";

/** One vertex: active playtime (ms) and xp earned by then. */
export interface RunLinePoint {
  x: number;
  y: number;
}

export interface RunLine {
  runId: string;
  model: string;
  effort: string | null;
  compactWindow: string | null;
  /** The roster entry the run belongs to, as the scatter keys it (`pointKey`). */
  entry: string;
  /** The entry's label, as the freeplay chart writes it (`characterSeriesLabel`). */
  label: string;
  /** What the page's shared highlight is keyed on (`hoverKeyOf`): the model. */
  hoverKey: string;
  harness: string | null;
  points: RunLinePoint[];
  /** Where the line stops: the run's active playtime and its xp earned. */
  endX: number;
  endY: number;
  /** The level that xp reaches from a fresh L1 — the end's reading on the axis. */
  endLevel: number;
}

export interface RunLinesModel {
  lines: RunLine[];
  /** Counted runs with no line, and why — for the chart's hover note. */
  omitted: { runId: string; why: string }[];
}

/**
 * One line per counted run that has both an xp and a playtime reading: from
 * the origin, through the start of each level the run's marks reached (offset
 * by the level it started on, so a run that did not start at L1 still starts
 * at zero), to (`playtimeMs`, `xpEarned`). A mark with no playtime reading is
 * skipped rather than placed at a guessed time; a mark past the end is held at
 * the end; and every vertex is at least the one before it, so the line never
 * runs backwards on either axis.
 */
export function runLines(runs: readonly ResultRun[]): RunLinesModel {
  const lines: RunLine[] = [];
  const omitted: RunLinesModel["omitted"] = [];
  for (const r of scored(runs)) {
    const xp = xpEarnedOf(r);
    const end = r.playtimeMs;
    if (xp === null || end === null) {
      omitted.push({ runId: r.runId, why: xp === null ? "no xp reading" : "no playtime reading" });
      continue;
    }
    const startLevel = r.levels[0]?.level ?? 1;
    const base = LEVEL_START_XP[startLevel] ?? 0;
    const points: RunLinePoint[] = [{ x: 0, y: 0 }];
    let level = startLevel;
    const marks = r.levels.filter((m) => m.playtimeMs !== null).sort((a, b) => a.playtimeMs! - b.playtimeMs!);
    for (const m of marks) {
      if (m.level <= level || m.level > 80) continue;
      level = m.level;
      const last = points[points.length - 1]!;
      points.push({ x: Math.max(last.x, Math.min(m.playtimeMs!, end)), y: Math.max(last.y, LEVEL_START_XP[m.level]! - base) });
    }
    const last = points[points.length - 1]!;
    const endX = Math.max(last.x, end);
    const endY = Math.max(last.y, xp);
    points.push({ x: endX, y: endY });
    const model = r.model ?? "(unnamed)";
    lines.push({
      runId: r.runId,
      model,
      effort: r.effort,
      compactWindow: r.compactWindow ?? null,
      entry: pointKey(model, r.effort, r.compactWindow),
      label: characterSeriesLabel(model, r.effort, r.compactWindow),
      hoverKey: hoverKeyOf(r.model),
      harness: r.harness,
      points,
      endX,
      endY,
      endLevel: levelOfXp(endY + base),
    });
  }
  // A function of the set, not of its order: entry, then run id.
  lines.sort((a, b) => a.entry.localeCompare(b.entry) || a.runId.localeCompare(b.runId));
  return { lines, omitted };
}

/**
 * A roster entry's mean line: the average of its counted runs' lines.
 *
 * The method: each run's line is read on its own clock, as a fraction `u` of
 * that run's active playtime, and the mean at `u` is the point whose playtime
 * is the runs' mean playtime times `u` and whose xp is the mean of each run's
 * xp at `u` of its own playtime. Every run's line is straight between its
 * vertices, so the mean is straight between the union of their vertices'
 * fractions, and those are the only points it needs. It starts at the origin,
 * never runs backwards on either axis, and ends exactly at the entry's mean
 * playtime and mean xp earned. Scored runs share a budget and end within a
 * minute of each other, so their own clocks are the shared one in all but
 * name; on an absolute clock instead, a run that stopped short would have to
 * be held flat past its end, and the mean line would end below the mean xp.
 * It stays a lower bound: a mean of lower bounds is one.
 */
export interface EntryLine {
  /** The roster entry, as the scatter keys it (`pointKey`). */
  entry: string;
  model: string;
  effort: string | null;
  compactWindow: string | null;
  /** As the freeplay chart writes it (`characterSeriesLabel`). */
  label: string;
  /** What the page's shared highlight is keyed on (`hoverKeyOf`): the model. */
  hoverKey: string;
  /** Every harness the runs ran under, sorted — the scatter's `harnesses`, for the colour. */
  harnesses: string[];
  /** How many runs the mean is over. */
  n: number;
  points: RunLinePoint[];
  /** The mean playtime and mean xp earned of the entry's runs. */
  endX: number;
  endY: number;
  /** The level the mean xp reaches from a fresh L1, as the axis reads it. */
  endLevel: number;
}

/** A run's xp at fraction `u` of its own playtime: its line, read straight between vertices. */
function xpAtFraction(line: RunLine, u: number): number {
  if (line.endX <= 0) return line.endY;
  const t = u * line.endX;
  const pts = line.points;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    if (t > b.x) continue;
    // A vertical segment (two vertices at one playtime) reads at its top.
    if (b.x === a.x) return b.y;
    return a.y + ((t - a.x) / (b.x - a.x)) * (b.y - a.y);
  }
  return line.endY;
}

/**
 * One mean line per roster entry, from its runs' lines (`runLines`), in entry
 * order — the method is `EntryLine`'s.
 */
export function entryLines(lines: readonly RunLine[]): EntryLine[] {
  const groups = new Map<string, RunLine[]>();
  for (const l of lines) {
    const g = groups.get(l.entry);
    if (g === undefined) groups.set(l.entry, [l]);
    else g.push(l);
  }
  const out: EntryLine[] = [];
  for (const [entry, runs] of groups) {
    const n = runs.length;
    const endX = runs.reduce((s, r) => s + r.endX, 0) / n;
    const endY = runs.reduce((s, r) => s + r.endY, 0) / n;
    const fractions = new Set<number>([0, 1]);
    for (const r of runs) {
      if (r.endX > 0) for (const p of r.points) fractions.add(Math.min(1, p.x / r.endX));
    }
    const points: RunLinePoint[] = [...fractions]
      .sort((a, b) => a - b)
      .map((u) => ({ x: u * endX, y: runs.reduce((s, r) => s + xpAtFraction(r, u), 0) / n }));
    // Exact at the ends, whatever the floating point made of the sums.
    points[0] = { x: 0, y: 0 };
    points[points.length - 1] = { x: endX, y: endY };
    const first = runs[0]!;
    out.push({
      entry,
      model: first.model,
      effort: first.effort,
      compactWindow: first.compactWindow,
      label: first.label,
      hoverKey: first.hoverKey,
      harnesses: [...new Set(runs.map((r) => r.harness ?? "—"))].sort(),
      n,
      points,
      endX,
      endY,
      endLevel: levelOfXp(endY),
    });
  }
  return out.sort((a, b) => a.entry.localeCompare(b.entry));
}

export interface PlacedEntryLine {
  line: EntryLine;
  /** The polyline, in viewBox units. */
  d: string;
  /** The line's end. */
  endCx: number;
  endCy: number;
  /**
   * The model's logo puck: just past the end (`characterIconCx`, the freeplay
   * chart's badge offset), so a column of pucks at the budget's edge never
   * covers a neighbour's end; `markCy` is after the spread (`spreadMarks`).
   */
  markCx: number;
  markCy: number;
  /** From the line's end to the puck, when the spread moved the puck off its line. */
  leader: Leader | null;
}

export interface RunLinesLayout {
  xTicks: number[];
  yTicks: number[];
  xMax: number;
  yMax: number;
  placed: PlacedEntryLine[];
  cue: ChartCue;
  px: (x: number) => number;
  py: (y: number) => number;
}

/**
 * Both axes from zero: playtime on `timeTicks`, xp on the level boundaries
 * the scatter's xp axis uses (`xpLevelTicks`), so a line's height reads as a
 * level. More xp in less time is top-left, as on the freeplay chart, and the
 * cue steps aside from the lines' ends and their pucks.
 */
export function runLinesLayout(lines: readonly EntryLine[], box: ChartBox): RunLinesLayout {
  const xTicks = timeTicks(Math.max(60_000, ...lines.map((l) => l.endX)));
  const xMax = Math.max(xTicks[xTicks.length - 1]!, ...lines.map((l) => l.endX));
  const yTicks = xpLevelTicks(Math.max(0, ...lines.map((l) => l.endY)));
  const yMax = yTicks[yTicks.length - 1]!;
  const px = scaleLinear([0, xMax], [box.x0, box.x1]);
  const py = scaleLinear([0, yMax], [box.y0, box.y1]);
  const natural = lines.map((l) => ({ cx: characterIconCx(px(l.endX)), cy: py(l.endY) }));
  const ys = spreadMarks(natural, box);
  const placed = lines.map((line, i): PlacedEntryLine => {
    const endCx = px(line.endX);
    const endCy = py(line.endY);
    const markCx = natural[i]!.cx;
    const markCy = ys[i]!;
    return {
      line,
      d: line.points.map((p, j) => `${j === 0 ? "M" : "L"}${px(p.x).toFixed(1)},${py(p.y).toFixed(1)}`).join(" "),
      endCx,
      endCy,
      markCx,
      markCy,
      // A puck nudged less than its own radius still reads as level with its
      // line; past that the eye needs the line drawn, from the end to the puck.
      leader: Math.abs(markCy - endCy) > MARK_R ? { x1: endCx, y1: endCy, x2: markCx - MARK_R, y2: markCy } : null,
    };
  });
  const cue = chartCue(box, DEFAULT_BETTER, [
    ...placed.map((p) => puckRect(p.endCx, p.endCy)),
    ...natural.map((m) => puckRect(m.cx, m.cy)),
  ]);
  return { xTicks, yTicks, xMax, yMax, placed, cue, px, py };
}

/** The vertical pitch of spread pucks: one puck and its separation ring, edge to edge. */
export const MARK_PITCH = 2 * MARK_RING_R;

/**
 * Where each puck is drawn, vertically: at its own end when that is clear,
 * and otherwise pushed apart from the pucks it would sit on, keeping their
 * order — a mark higher on the chart is never drawn below a lower one, which
 * on a ranking would be a lie — and every puck inside the box.
 *
 * Pucks share a column when they overlap across x, chained, so a column is
 * the run of pucks a vertical nudge has to clear. In each, a sweep down holds
 * every puck a pitch below the one above it, then a sweep up from the floor
 * pulls back whatever that pushed out of the box. A column with more pucks
 * than the box holds at a full pitch gets a tighter one, so they overlap like
 * a stack of coins — the separation ring still marks each edge — rather than
 * leave the plot.
 */
export function spreadMarks(marks: readonly { cx: number; cy: number }[], box: ChartBox): number[] {
  const ys = marks.map((m) => m.cy);
  const top = box.y1 + MARK_RING_R;
  const floor = box.y0 - MARK_RING_R;
  const byX = marks.map((_, i) => i).sort((a, b) => marks[a]!.cx - marks[b]!.cx || a - b);
  const columns: number[][] = [];
  let lastCx = -Infinity;
  for (const i of byX) {
    if (columns.length === 0 || marks[i]!.cx - lastCx >= MARK_PITCH) columns.push([]);
    columns[columns.length - 1]!.push(i);
    lastCx = marks[i]!.cx;
  }
  for (const column of columns) {
    // Top of the chart first; a tie goes to the input order, which is the set's.
    const order = [...column].sort((a, b) => marks[a]!.cy - marks[b]!.cy || a - b);
    const pitch = order.length < 2 ? MARK_PITCH : Math.min(MARK_PITCH, (floor - top) / (order.length - 1));
    let prev = -Infinity;
    for (const i of order) {
      ys[i] = Math.max(top, ys[i]!, prev + pitch);
      prev = ys[i]!;
    }
    let next = Infinity;
    for (const i of [...order].reverse()) {
      ys[i] = Math.min(floor, ys[i]!, next - pitch);
      next = ys[i]!;
    }
  }
  return ys;
}
