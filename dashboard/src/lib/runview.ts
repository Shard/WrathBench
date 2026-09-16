/**
 * The maths behind the run page's XP/level chart and its autoscroll, kept pure
 * so both are testable with no browser.
 *
 * Cumulative XP is an approximation, and a deliberate one. `StatePoint.xp` is
 * the progress bar *within* the current level and resets to zero at each
 * level-up, so a true running total is not in the served data — the ladder
 * (`ResultRun.xp` in api-types) orders runs lexicographically by
 * `(maxLevel, xp)` precisely because a total is not derivable. This chart still
 * wants one continuous curve, so it reconstructs a **lower bound**: the total
 * carried into a level is the sum of the *last observed* within-level xp of
 * every level below it. That under-counts by whatever xp was earned between a
 * level's final sample and the actual ding — real, but bounded by the sampling
 * interval, and never invented upward. The level bands are drawn at exactly
 * these reconstructed offsets, so the curve and the bands agree by construction.
 */

import type { StatePoint } from "@viewer/api-types";

/** One point on the cumulative-xp curve: sample time and reconstructed total. */
export interface XpPoint {
  ts: number;
  cum: number;
}

/** One level band: the cumulative xp at which that level's first sample landed. */
export interface LevelBand {
  level: number;
  cum: number;
  ts: number;
}

export interface XpChartModel {
  points: XpPoint[];
  bands: LevelBand[];
  /** The x-axis window (epoch ms). `t1` is `min(now|endedAt, start+episodeMs)`. */
  t0: number;
  t1: number;
  /** The y-axis top: the largest cumulative xp reached (never below 1). */
  yMax: number;
}

/**
 * Build the cumulative-xp curve and the level bands from a run's state samples.
 *
 * A sample counts only when it carries both a level and an xp reading; the two
 * are read off the *same* sample so the pairing is never broken (reading the
 * two fields into separate filtered lists, as the old sparkline did, mis-aligns
 * them the moment any sample is missing one). Samples are sorted by time, and
 * the running total is clamped monotonic so an out-of-order or noisy reading
 * cannot make a "cumulative" line dip.
 */
export function xpChartModel(
  states: readonly StatePoint[],
  opts: { startedAt: number | null; endedAt: number | null; episodeMs: number | null; now: number },
): XpChartModel {
  const samples = states
    .filter((s): s is StatePoint & { level: number; xp: number } => s.level !== null && s.level > 0 && s.xp !== null)
    .sort((a, b) => a.ts - b.ts);

  const points: XpPoint[] = [];
  const bands: LevelBand[] = [];
  let base = 0; // total carried into the current level
  let prevLevel: number | null = null;
  let lastXp = 0; // last within-level xp seen at the current level
  let cum = 0;

  for (const s of samples) {
    if (prevLevel === null) {
      prevLevel = s.level;
      bands.push({ level: s.level, cum: base, ts: s.ts });
    } else if (s.level > prevLevel) {
      // Crossed one or more level-ups: fold the last-seen xp of the old level
      // into the base, then open a band for the new level at that offset. A
      // multi-level jump between samples opens one band, at the level reached.
      base += lastXp;
      prevLevel = s.level;
      lastXp = 0;
      bands.push({ level: s.level, cum: base, ts: s.ts });
    }
    lastXp = s.xp;
    cum = Math.max(cum, base + s.xp);
    points.push({ ts: s.ts, cum });
  }

  const start = opts.startedAt ?? (points.length > 0 ? points[0]!.ts : opts.now);
  const lastTs = points.length > 0 ? points[points.length - 1]!.ts : start;
  // The window closes at the episode deadline when there is one, else at the
  // last sample. A live run's deadline is capped at "now" so the axis does not
  // run past the present into empty future time.
  const deadline = opts.episodeMs !== null ? start + opts.episodeMs : lastTs;
  const capped = opts.endedAt !== null ? Math.min(deadline, opts.endedAt) : Math.min(deadline, Math.max(opts.now, lastTs));
  const t1 = Math.max(capped, start + 1);
  const yMax = Math.max(1, ...points.map((p) => p.cum));
  return { points, bands, t0: start, t1, yMax };
}

/**
 * Whether a scroll container is pinned to (or within `threshold` px of) its
 * bottom — the decision that turns autoscroll on and off. A newly arrived entry
 * pins to the bottom only while this is true; the user scrolling up above the
 * threshold turns follow off, scrolling back within it turns it on again.
 */
export function atBottom(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  threshold = 32,
): boolean {
  return scrollHeight - clientHeight - scrollTop <= threshold;
}

/**
 * How a token total was arrived at, in words — and the caveat behind it.
 *
 * Here rather than on a page because two pages print it: a run's own card and
 * a character's, whose source degrades to the weakest any attempt reported
 * (`mergeTokens` in `runner/viewer/character.ts`). One wording, so a reader
 * moving between them is not told two different things about the same number.
 */
export function sourceLabel(source: string | undefined): string {
  if (source === "reported") return "provider-reported";
  if (source === "snapshot") return "snapshot — under-read";
  return "estimated (chars ÷ 4)";
}

export function sourceHint(source: string | undefined): string {
  if (source === "snapshot") {
    return "claude-code opening usage snapshots: this run's turns never emitted a finished output count, so the completion total and the rate below are far too low";
  }
  if (source === "reported") return "provider-reported token counts";
  return "no provider counted; characters ÷ 4";
}
