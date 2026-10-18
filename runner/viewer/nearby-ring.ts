/**
 * The nearby ring as the run directory holds it: the reads behind
 * `/api/run/<id>/nearby` and the position feed's `nearby` flag.
 *
 * The codec is `nearby.ts`, import-free so the dashboard can bundle it; this
 * is its server half and the only place a ring file is opened. Read-only like
 * the rest of the viewer: the directory is listed and its files read, never
 * created. The ring is judged by age as well as by what is in it — a file that
 * ended longer ago than the ring's reach is ignored whether or not its writer
 * got to unlink it — so a run that was killed hard serves nothing stale.
 *
 * The file names and the reach are the runner's contract
 * (`runner/src/nearby-row.ts`), restated here because this file ships beside
 * the codec and must not import `runner/src`; `runner/test/viewer-nearby.test.ts`
 * pins the two equal.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { NearbyWindow } from "./api-types";
import { NEARBY_FRESH_MS, NEARBY_SPAN_MAX_MS, emptyNearbyWindow, encodeNearby, parseRingRow, type NearbyRingRow } from "./nearby";

export const RING_DIR = "nearby";
export const RING_FILE_MS = 60_000;
export const RING_REACH_MS = 15 * 60_000;

function ringFiles(runsDir: string, runId: string, now: number): { t0: number; path: string }[] {
  const dir = join(runsDir, runId, RING_DIR);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: { t0: number; path: string }[] = [];
  for (const name of names) {
    const m = /^(\d+)\.jsonl$/.exec(name);
    if (m === null) continue;
    const t0 = Number(m[1]);
    if (!Number.isSafeInteger(t0) || t0 % RING_FILE_MS !== 0) continue;
    // Past the ring's reach, as the writer prunes: ignored even if it is still there.
    if (t0 + RING_FILE_MS <= now - RING_REACH_MS) continue;
    out.push({ t0, path: join(dir, name) });
  }
  return out.sort((a, b) => a.t0 - b.t0);
}

/** One file's rows, a half-written last line and any line that does not parse left out. */
function readRows(path: string): NearbyRingRow[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const lines = text.split("\n");
  // The writer appends whole lines; a last one with no newline is still being written.
  lines.pop();
  const out: NearbyRingRow[] = [];
  for (const line of lines) {
    if (line === "") continue;
    try {
      const row = parseRingRow(JSON.parse(line) as unknown);
      if (row !== null) out.push(row);
    } catch {
      /* a torn or foreign line: skipped, never fatal */
    }
  }
  return out;
}

/**
 * `GET /api/run/<id>/nearby?span=`: the last `spanMs` (at most the ring's
 * reach) as one window, keyed at `now − spanMs` — or at the ring's first key
 * when the ring is younger than that. A run with no ring answers an empty
 * window rather than an error: no units is a state, not a fault.
 */
export function readNearbyWindow(runsDir: string, runId: string, spanMs: number, now: number): NearbyWindow {
  const span = Math.max(0, Math.min(NEARBY_SPAN_MAX_MS, spanMs));
  const from = now - span;
  // The file holding `from`, and the one before it: a file's key is stamped at
  // or just after its start, so `from` early in a minute needs the minute before.
  const first = Math.floor(from / RING_FILE_MS) * RING_FILE_MS - RING_FILE_MS;
  const files = ringFiles(runsDir, runId, now).filter((f) => f.t0 >= first);
  if (files.length === 0) return emptyNearbyWindow(runId, from);
  return encodeNearby(files.flatMap((f) => readRows(f.path)), { run: runId, from });
}

/** Whether the run's ring is being written: its newest file was touched within `NEARBY_FRESH_MS`. */
export function nearbyFresh(runsDir: string, runId: string, now: number): boolean {
  const files = ringFiles(runsDir, runId, now);
  const newest = files[files.length - 1];
  if (newest === undefined) return false;
  try {
    return now - statSync(newest.path).mtimeMs <= NEARBY_FRESH_MS;
  } catch {
    return false;
  }
}
