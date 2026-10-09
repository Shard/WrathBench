/**
 * One character's whole climb, laid out on an axis that is worth reading.
 *
 * `/api/character/<id>` serves every attempt's state samples end to end, each
 * naming the attempt it came from, and every attempt's sessions with the
 * character. Plotted against the wall clock that series is mostly nothing: a
 * durable character spends days paused, between attempts and — since a paused
 * freeplay run is resumed in place — inside one, and a week of flat line
 * between two afternoons of play is the pause, not the character.
 *
 * So the axis here is the **session clock** (`@viewer/sessions`): within an
 * attempt, the active time before each sample, every paused stretch closed;
 * across attempts, laid end to end by each attempt's playtime. That is the
 * axis `stitchCharacter` lays the level marks on, one cadence down, so the
 * two curves on the character page share an x and the end of the line is the
 * character's playtime.
 *
 * A boundary is a recorded mark, never a gap in the samples: a relaunch can
 * follow a logout by a second, and two samples a second apart are not a seam.
 * A new attempt comes off `attempt`, which the server sets; a resume comes off
 * the attempt's sessions. An attempt served without sessions (a snapshot that
 * predates the field) is one session from its first sample to its last, which
 * is how every attempt used to be drawn.
 */

import type { ActiveSegment, CharacterStatePoint } from "@viewer/api-types";
import { sessionClock } from "@viewer/sessions";

/** Where one session begins, on the session clock. */
export interface CharacterSeam {
  /** The x value (ms into the character's cumulative active time). */
  at: number;
  /** The attempt this session belongs to: 1-based. */
  attempt: number;
  /** The session that begins here, 1-based across the whole character — always ≥ 2. */
  session: number;
  runId: string;
  /** A new attempt begins here, rather than an attempt resuming in place. */
  newAttempt: boolean;
  /** The wall clock the session began at, for the hover; null where no session was served. */
  startedAt: number | null;
}

export interface CharacterSessionSeries {
  /**
   * The samples with `ts` remapped onto the session clock, so a chart that
   * plots `StatePoint`s against a window plots this one unchanged. The `runId`
   * and `attempt` ride along: a tooltip wants to say which attempt a point
   * came from, and dropping them here would mean a second lookup.
   */
  states: CharacterStatePoint[];
  seams: CharacterSeam[];
  /** The axis top: the whole character's cumulative active time, in ms. */
  totalMs: number;
}

/** What the series needs of an attempt: its playtime and its sessions, by run id. */
export interface AttemptClock {
  runId: string;
  playtimeMs: number | null;
  sessions?: readonly ActiveSegment[];
}

/**
 * Remap a character's samples onto one cumulative session clock.
 *
 * Attempts are taken in the order the server sent them (attempt, then ts).
 * Each contributes its playtime — the same figure `stitchCharacter` offsets
 * by — or, with no sessions served, the span between its first and last
 * sample. An attempt with a single sample and nothing else to go on
 * contributes nothing but still lands a seam, which is the honest drawing of a
 * session that was sampled once.
 */
export function characterSessionSeries(
  points: readonly CharacterStatePoint[],
  attempts: readonly AttemptClock[] = [],
): CharacterSessionSeries {
  const byRun = new Map(attempts.map((a) => [a.runId, a]));
  const states: CharacterStatePoint[] = [];
  const seams: CharacterSeam[] = [];
  let offset = 0;
  let session = 0;
  let i = 0;
  while (i < points.length) {
    const attempt = points[i]!.attempt;
    const runId = points[i]!.runId;
    const group: CharacterStatePoint[] = [];
    while (i < points.length && points[i]!.attempt === attempt) group.push(points[i++]!);
    const known = byRun.get(runId);
    const sessions = known?.sessions !== undefined && known.sessions.length > 0 ? known.sessions : undefined;
    // `ts` is the only field touched: everything else is the sample as the
    // server projected it, so a reader of this series reads the same numbers
    // the attempt's own page shows.
    const clock = sessionClock(group, sessions);
    clock.starts.forEach((at, k) => {
      session++;
      if (session === 1) return;
      seams.push({
        at: offset + at,
        attempt,
        session,
        runId,
        newAttempt: k === 0,
        startedAt: sessions === undefined ? null : clock.startedAt[k]!,
      });
    });
    let last = 0;
    for (const p of clock.points) {
      states.push({ ...p, ts: offset + p.ts });
      last = Math.max(last, p.ts);
    }
    offset += sessions === undefined ? last : Math.max(last, known?.playtimeMs ?? 0);
  }
  return { states, seams, totalMs: offset };
}

/**
 * How many sessions a run or a character's attempts add up to. An attempt
 * served without sessions counts as the one it was always drawn as.
 */
export function sessionCount(attempts: readonly { sessions?: readonly ActiveSegment[] }[]): number {
  return attempts.reduce((n, a) => n + Math.max(1, a.sessions?.length ?? 1), 0);
}
