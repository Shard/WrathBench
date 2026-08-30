/*
 * What a failed fetch says to the reader.
 *
 * The private viewer is an operator tool and the URL and status are the whole
 * value of an error — `ApiError` carries `${url}: ${detail}` for exactly that.
 * The public build has no such reader: a snapshot URL is a bucket path nobody
 * outside the lab can act on, and a mid-refresh generation is the ordinary
 * cause, so the public message says what happened and nothing about where.
 * The detail is never lost, only moved: the callers log it to the console.
 *
 * `errorText` is pure so both readings are tested without a build flag;
 * `displayError` is the thin wrapper the pages call. Neither logs — a JSX
 * site re-renders, and a side effect there would fire on every render rather
 * than once per failure.
 */

import { SNAPSHOT_MODE } from "../api/client";

export const SNAPSHOT_ERROR_TEXT =
  "Couldn't load this view — the snapshot may be mid-refresh; retrying…";

/** The message a reader sees, given whether this is the public build. */
export function errorText(err: unknown, snapshot: boolean): string {
  if (snapshot) return SNAPSHOT_ERROR_TEXT;
  return String(err);
}

/** The message a reader sees in this build. */
export function displayError(err: unknown): string {
  return errorText(err, SNAPSHOT_MODE);
}

/**
 * The detail, for the console — called at the catch or the setter, never in a
 * render, so it fires once per failure rather than once per re-render.
 *
 * Only in the public build: privately the banner already carries the url and
 * the status, and "private mode unchanged" is the whole point of the split.
 */
export function logError(where: string, err: unknown): void {
  if (!SNAPSHOT_MODE) return;
  console.error(`[${where}] ${String(err)}`);
}
