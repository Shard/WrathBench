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

import { ApiError, SNAPSHOT_MODE } from "../api/client";

export const SNAPSHOT_ERROR_TEXT = "Couldn't load this view — the snapshot may be mid-refresh";
export const SNAPSHOT_RETRYING = "; retrying…";
/** A run the current snapshot does not publish: not a refresh, and no retry will find it. */
export const SNAPSHOT_MISSING_TEXT = "This run isn't published in the current snapshot.";
/** A route the public build withholds by design. */
export const SNAPSHOT_WITHHELD_TEXT = "Not available on the public site.";

/**
 * The message a reader sees, given whether this is the public build.
 *
 * Public failures are three different facts: a 404 is a run outside the
 * published set, a 403 is a route the public build withholds, and anything
 * else is the ordinary mid-refresh generation. "Retrying" is claimed only
 * where the caller actually re-fetches — the polled feeds do, every interval;
 * a one-shot load (the run page) does not, and must not promise it.
 */
export function errorText(err: unknown, snapshot: boolean, retries = true): string {
  if (!snapshot) return String(err);
  if (err instanceof ApiError && err.status === 404) return SNAPSHOT_MISSING_TEXT;
  if (err instanceof ApiError && err.status === 403) return SNAPSHOT_WITHHELD_TEXT;
  return retries ? `${SNAPSHOT_ERROR_TEXT}${SNAPSHOT_RETRYING}` : `${SNAPSHOT_ERROR_TEXT}.`;
}

/** The message a reader sees in this build. `retries: false` for a one-shot load. */
export function displayError(err: unknown, opts: { retries?: boolean } = {}): string {
  return errorText(err, SNAPSHOT_MODE, opts.retries ?? true);
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
