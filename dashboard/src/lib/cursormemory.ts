/**
 * Where a replay was left off, per run, for the life of the page.
 *
 * `/map` and `/map?run=<id>` are the only two URL states, deliberately: the
 * cursor is not a parameter because the play slider would rewrite history four
 * times a second. The cost of that decision is that every route back into a
 * replay — browser back from the run page, the pip's "replay →" link, the live
 * control and in again — reloads the track and drops the cursor on the first
 * recorded sample. An operator who scrubbed to hour four and pressed back got
 * hour zero.
 *
 * So the cursor is remembered beside the route rather than in it: one
 * `Map<runId, ts>` consulted when a track loads. In memory and nowhere else —
 * `localStorage` would hand back yesterday's scrub position against a track
 * that has since grown, which is a worse bug than the one being fixed.
 *
 * The memory is not trusted: `resume` answers with the remembered timestamp
 * only when the track that actually loaded still covers it, and otherwise with
 * the first sample. That is what makes a stale entry harmless rather than an
 * out-of-range cursor — a run whose track was truncated, or a page kept open
 * long enough for the ids to mean something else, lands at the start.
 */

import type { TrackResponse } from "@viewer/api-types";
import { trackSpan } from "./replay";

export interface CursorMemory {
  /** Record where an operator moved the cursor to. Deliberate moves only. */
  remember: (runId: string, ts: number) => void;
  /** The cursor a freshly loaded track should open at. */
  resume: (track: TrackResponse) => number;
}

export function createCursorMemory(): CursorMemory {
  const at = new Map<string, number>();
  return {
    remember: (runId, ts) => {
      at.set(runId, ts);
    },
    resume: (track) => {
      const span = trackSpan(track.points);
      // A run that recorded no position has no cursor to resume to, and the
      // scrubber spans 0..0 there.
      if (span === null) return 0;
      const ts = at.get(track.runId);
      if (ts === undefined || ts < span.from || ts > span.to) return span.from;
      return ts;
    },
  };
}

/**
 * The page's own memory.
 *
 * Module scope rather than component state, and that is the whole point: the
 * case in the report is a client-side navigation to `/run/<id>` and back, which
 * unmounts `MapPage` and takes anything it owned with it. It dies with the
 * document, as intended.
 */
export const cursorMemory = createCursorMemory();
