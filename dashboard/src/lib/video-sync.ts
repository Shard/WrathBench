/**
 * The run video and the map replay on one clock (`components/Replay.tsx`'s
 * `RunVideo`, `pages/MapPage.tsx`). Two clocks could each chase the other's
 * echo forever, so one leads at a time:
 *
 * - while the video plays it is the master: its time drives the map's cursor,
 *   and the cursor's changes are never sent back to it;
 * - otherwise the map leads: a cursor change (its own playback, a scrub, a
 *   step) seeks the paused video to the frame at or before that run time,
 *   unless the change is the video's own value coming back, or the video
 *   already shows that moment (an event's held frame spans a second of video
 *   at one run time, and seeking to its start from inside it would loop).
 *
 * Starting either clock stops the other, so pausing either leaves both still.
 * Pure: the page holds the state, this decides.
 */

import { runToVideo, videoToRun, type TimemapPoint } from "@viewer/video-time";

/** Closer than this, in video seconds, a seek is not worth it: two of the video's frames. */
export const SEEK_TOLERANCE_S = 0.25;
/** A cursor this close to what the video last sent is the video's own value coming back. */
export const ECHO_TOLERANCE_MS = 1;
/** The video already shows a run time this close to the cursor: nothing to do. */
export const SHOWN_TOLERANCE_MS = 500;

/** Which clock leads: the video while it plays, the map otherwise. */
function leader(videoPlaying: boolean): "video" | "map" {
  return videoPlaying ? "video" : "map";
}

/**
 * Where the video should seek to show the map's cursor, in timeline seconds,
 * or null to leave it where it is.
 */
export function videoSeekFor(
  map: readonly TimemapPoint[],
  cursor: number,
  o: { current: number; videoPlaying: boolean; lastSent: number | null },
): number | null {
  if (leader(o.videoPlaying) === "video") return null;
  if (o.lastSent !== null && Math.abs(cursor - o.lastSent) <= ECHO_TOLERANCE_MS) return null;
  const target = runToVideo(map, cursor);
  if (target === null) return null;
  if (Math.abs(target - o.current) < SEEK_TOLERANCE_S) return null;
  const shown = videoToRun(map, o.current);
  if (shown !== null && Math.abs(shown - cursor) <= SHOWN_TOLERANCE_MS) return null;
  return target;
}

/**
 * The run time to send the map for the video at timeline time `v`, or null
 * to send nothing: only while the video plays or when its own controls moved
 * it, and only when it differs from what was sent last.
 */
export function cursorFor(map: readonly TimemapPoint[], v: number, o: { videoPlaying: boolean; ownSeek: boolean; lastSent: number | null }): number | null {
  if (!o.videoPlaying && !o.ownSeek) return null;
  const r = videoToRun(map, v);
  if (r === null) return null;
  const ms = Math.round(r);
  return o.lastSent !== null && Math.abs(ms - o.lastSent) <= ECHO_TOLERANCE_MS ? null : ms;
}
