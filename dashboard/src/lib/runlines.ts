/**
 * The scored ladder's second chart: every counted run as a line, xp earned
 * against active playtime — the freeplay field's reading (`CharacterChart`)
 * for a tier, with runs in place of characters and xp in place of level so a
 * run's progress inside a level shows.
 *
 * Built from what a `ResultRun` already carries — its level marks with their
 * active playtime, its `xpEarned` and its `playtimeMs` — so the chart costs no
 * request per run. A line is a lower bound, like everything it is drawn from:
 * a level mark is the first 60-second sample that showed the level, and the
 * xp at that mark is where the level begins, so the ding was at or before the
 * point and the xp at or above it. Between marks the line is straight, which
 * says only that the run got from one to the next.
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
  /** When the run started, for the hover: what tells one run of an entry from its siblings. */
  startedAt: number | null;
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
      startedAt: r.startedAt,
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

export interface PlacedRunLine {
  line: RunLine;
  /** The polyline, in viewBox units. */
  d: string;
  endCx: number;
  endCy: number;
}

export interface RunLinesLayout {
  xTicks: number[];
  yTicks: number[];
  xMax: number;
  yMax: number;
  placed: PlacedRunLine[];
  cue: ChartCue;
  px: (x: number) => number;
  py: (y: number) => number;
}

/**
 * Both axes from zero: playtime on `timeTicks`, xp on the level boundaries
 * the scatter's xp axis uses (`xpLevelTicks`), so a line's height reads as a
 * level. More xp in less time is top-left, as on the freeplay chart, and the
 * cue steps aside from the lines' ends.
 */
export function runLinesLayout(lines: readonly RunLine[], box: ChartBox): RunLinesLayout {
  const xTicks = timeTicks(Math.max(60_000, ...lines.map((l) => l.endX)));
  const xMax = Math.max(xTicks[xTicks.length - 1]!, ...lines.map((l) => l.endX));
  const yTicks = xpLevelTicks(Math.max(0, ...lines.map((l) => l.endY)));
  const yMax = yTicks[yTicks.length - 1]!;
  const px = scaleLinear([0, xMax], [box.x0, box.x1]);
  const py = scaleLinear([0, yMax], [box.y0, box.y1]);
  const placed = lines.map((line) => ({
    line,
    d: line.points.map((p, i) => `${i === 0 ? "M" : "L"}${px(p.x).toFixed(1)},${py(p.y).toFixed(1)}`).join(" "),
    endCx: px(line.endX),
    endCy: py(line.endY),
  }));
  const cue = chartCue(box, DEFAULT_BETTER, placed.map((p) => puckRect(p.endCx, p.endCy)));
  return { xTicks, yTicks, xMax, yMax, placed, cue, px, py };
}
