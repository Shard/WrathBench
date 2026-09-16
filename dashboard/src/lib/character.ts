/**
 * One character's whole climb, laid out on an axis that is worth reading.
 *
 * `/api/character/<id>` serves every attempt's state samples end to end, each
 * naming the attempt it came from. Plotted against the wall clock that series
 * is mostly nothing: a durable character spends days paused between sessions,
 * and a week of flat line between two afternoons of play is the pause, not the
 * character.
 *
 * So the axis here is **cumulative session time**: within an attempt, the
 * elapsed time since that attempt's first sample; across attempts, laid end to
 * end. The seam between two attempts is where one session's last sample sits,
 * and the gap is closed rather than drawn — which is the same argument
 * `stitchCharacter` makes for the ladder's active-time axis, one cadence down.
 *
 * It is NOT the ladder's axis, and the two must not be confused. `stitchCharacter`
 * lays attempts out on pause-corrected *active* playtime, which is the figure a
 * run is compared on; this is sample-to-sample elapsed time within a session,
 * which includes whatever a session idled through and exists only so a curve
 * drawn from state samples has somewhere to sit. A caption saying which one is
 * on screen is not decoration.
 *
 * The attempt boundary cannot be found from timestamps: a relaunch can follow a
 * logout by a second, and two samples a second apart are not a seam. It comes
 * off `attempt`, which the server sets, which is why the wire carries it.
 */

import type { CharacterStatePoint } from "@viewer/api-types";

/** Where one attempt ends and the next begins, on the session-time axis. */
export interface CharacterSeam {
  /** The x value (ms into the character's cumulative session time). */
  at: number;
  /** The attempt that begins here: 1-based, always ≥ 2 — attempt 1 is the origin. */
  attempt: number;
  runId: string;
}

export interface CharacterSessionSeries {
  /**
   * The samples with `ts` remapped onto cumulative session time, so a chart
   * that plots `StatePoint`s against a window plots this one unchanged. The
   * `runId` and `attempt` ride along: a tooltip wants to say which session a
   * point came from, and dropping them here would mean a second lookup.
   */
  states: CharacterStatePoint[];
  seams: CharacterSeam[];
  /** The axis top: the whole character's cumulative session time, in ms. */
  totalMs: number;
}

/**
 * Remap a character's samples onto one cumulative session-time axis.
 *
 * Attempts are taken in the order the server sent them (attempt, then ts) and
 * each contributes the span between its own first and last sample. An attempt
 * with a single sample contributes nothing but still lands a seam, which is
 * the honest drawing of a session that was sampled once.
 */
export function characterSessionSeries(points: readonly CharacterStatePoint[]): CharacterSessionSeries {
  const states: CharacterStatePoint[] = [];
  const seams: CharacterSeam[] = [];
  let offset = 0;
  let i = 0;
  while (i < points.length) {
    const attempt = points[i]!.attempt;
    const runId = points[i]!.runId;
    const base = points[i]!.ts;
    if (states.length > 0) seams.push({ at: offset, attempt, runId });
    let last = base;
    while (i < points.length && points[i]!.attempt === attempt) {
      const p = points[i]!;
      // `ts` is the only field touched: everything else is the sample as the
      // server projected it, so a reader of this series reads the same numbers
      // the attempt's own page shows.
      states.push({ ...p, ts: offset + (p.ts - base) });
      last = p.ts;
      i++;
    }
    offset += last - base;
  }
  return { states, seams, totalMs: offset };
}
