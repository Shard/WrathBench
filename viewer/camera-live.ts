/**
 * A run's newest camera frame, for the private viewer's live still.
 *
 * The camera writes stills while a run plays (`camera/frames/000042.jpg`, the
 * seq zero-padded to six digits by `frameFile` in `infra/camera/layout.ts`,
 * the one place the name is made) and appends a line per still to
 * `camera/frames.jsonl`. Frames are never published (`docs/PUBLIC-DASHBOARD.md`,
 * "Camera video ships; frames never do"): in the viewer this file is the only
 * reader of either, a private handle serves the newest frame and nothing else,
 * and a public handle has no such route at all.
 *
 * The index grows by a line every few seconds for as long as the run plays, so
 * only its tail is read: the last `TAIL_BYTES`, the newest complete line that
 * reads, and the frame its `seq` names. The path is built from the number by
 * that same `frameFile` and never taken from the line, and every step (the run,
 * `camera/`, the index, `frames/`, the file) is a plain entry under `lstat`,
 * opened without following a link, as `camera.ts` does for clips.
 */

import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { FRAMES_DIR, FRAMES_INDEX, frameFile } from "../infra/camera/layout";
import { cameraDir, isoOrNull, plain } from "./camera";
import { isRecord } from "../runner/src/values";

/**
 * How much of the index's end is read. A line is about 100 bytes, so this holds
 * well over a hundred; a frame is looked for only among them.
 */
export const TAIL_BYTES = 16 * 1024;
/** A frame larger than this is not a 1280×720 still; it is not served. */
export const FRAME_MAX_BYTES = 8 * 1024 * 1024;

/** The newest frame, as its index line names it. */
export interface LatestFrame {
  seq: number;
  /** When the camera took it, ISO. */
  t: string;
}

/** Open a plain file without following a link, or null. */
function openPlain(path: string): number | null {
  if (plain(path, "file") === null) return null;
  try {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!fstatSync(fd).isFile()) {
      closeSync(fd);
      return null;
    }
    return fd;
  } catch {
    return null;
  }
}

/**
 * The index's complete lines at its end, newest first. A final line with no
 * newline yet is kept, since a JSON object cut short does not parse and is
 * dropped there; the first line of a window that starts mid-file is not.
 */
export function tailLines(path: string, bytes = TAIL_BYTES): string[] {
  const fd = openPlain(path);
  if (fd === null) return [];
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return [];
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    const n = readSync(fd, buf, 0, buf.length, start);
    const lines = buf.subarray(0, n).toString("utf8").split("\n");
    if (start > 0) lines.shift();
    return lines.filter((l) => l.trim() !== "").reverse();
  } catch {
    return [];
  } finally {
    closeSync(fd);
  }
}

/** One index line, checked: a whole `seq`, an ISO time, and a `file` that is that frame's own (`frameFile(seq)`) when it is there at all. */
export function readIndexLine(line: string): LatestFrame | null {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(v)) return null;
  const seq = v["seq"];
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0) return null;
  const t = isoOrNull(v["t"]);
  if (t === null) return null;
  if (v["file"] !== undefined && v["file"] !== frameFile(seq)) return null;
  return { seq, t };
}

/**
 * The run's newest frame that is on disk, with its file, or null: no camera,
 * no index, nothing in its tail that reads, or no frame it names still there.
 * A line whose file is missing (pruned, or not written yet) gives way to the
 * line before it. Never throws.
 */
export function latestFrame(runsDir: string, runId: string): (LatestFrame & { file: string }) | null {
  const dir = cameraDir(runsDir, runId);
  if (dir === null) return null;
  const lines = tailLines(join(dir, FRAMES_INDEX));
  if (lines.length === 0) return null;
  const frames = join(dir, FRAMES_DIR);
  if (plain(frames, "dir") === null) return null;
  for (const line of lines) {
    const hit = readIndexLine(line);
    if (hit === null) continue;
    const file = join(dir, frameFile(hit.seq));
    if (plain(file, "file") !== null) return { ...hit, file };
  }
  return null;
}

/** A frame's bytes, read through a descriptor that followed no link, or null. */
export function readFrame(file: string): Uint8Array | null {
  const fd = openPlain(file);
  if (fd === null) return null;
  try {
    const size = fstatSync(fd).size;
    if (size === 0 || size > FRAME_MAX_BYTES) return null;
    const buf = new Uint8Array(size);
    let at = 0;
    while (at < size) {
      const n = readSync(fd, buf, at, size - at, at);
      if (n === 0) break;
      at += n;
    }
    return at === size ? buf : buf.subarray(0, at);
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

const NO_STORE = "no-store";

/**
 * The private routes: `/camera/latest` is `{runId, seq, t}`, or `null` when
 * the run has no frame (the run page and the live map ask on every live run,
 * filmed or not, and a 404 is a console error on each), and
 * `/camera/latest.jpg` the frame itself with the same two facts in
 * `x-camera-seq` and `x-camera-time`, a 404 when there is none. All are
 * `no-store`: the newest frame is a different picture every few seconds. Null
 * for any other path.
 */
export function latestFrameResponse(req: Request, runsDir: string, runId: string, rest: string): Response | null {
  if (rest !== "/camera/latest" && rest !== "/camera/latest.jpg") return null;
  const missing = (): Response =>
    new Response(JSON.stringify({ error: "no camera frame" }), {
      status: 404,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": NO_STORE },
    });
  const frame = latestFrame(runsDir, runId);
  if (rest === "/camera/latest") {
    return new Response(JSON.stringify(frame === null ? null : { runId, seq: frame.seq, t: frame.t }), {
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": NO_STORE },
    });
  }
  if (frame === null) return missing();
  const bytes = readFrame(frame.file);
  if (bytes === null) return missing();
  const head = req.method.toUpperCase() === "HEAD";
  return new Response(head ? null : bytes, {
    headers: {
      "content-type": "image/jpeg",
      "content-length": String(bytes.length),
      "cache-control": NO_STORE,
      "x-camera-seq": String(frame.seq),
      "x-camera-time": frame.t,
    },
  });
}
