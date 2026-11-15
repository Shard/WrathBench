/**
 * A run's camera replay, as the viewer and the publisher read it.
 *
 * A camera that followed a run leaves `camera/` in the run's directory
 * (`docs/PUBLIC-DASHBOARD.md`, "Camera replays"): still frames, the clips made
 * from them, and `camera/clips.json`, which lists the clips and is the only
 * file read here to find them. The frames are never published: no function in
 * this file names a path under `frames/`, and a clip or poster is served only
 * when `clips.json` names it as `clips/<file>` with a plain file name. The one
 * frame a private handle serves, the newest, is read by `camera-live.ts`.
 *
 * Every path is checked component by component with `lstat`: the run
 * directory, `camera/`, `clips/` and the file itself must each be what they
 * claim and none may be a symbolic link, so nothing under a run can point the
 * viewer or the publisher at a file outside it.
 */

import { lstatSync, readFileSync, type Stats } from "node:fs";
import { join } from "node:path";
import type { ClipEventType, ClipView, ClipsResponse } from "./api-types";
import { isValidRunId } from "./runs";

/** Under the run's directory. */
export const CAMERA_DIR = "camera";
export const CLIPS_FILE = "clips.json";

/** A clip's name: `timelapse` or `event-<seq>-<type>` today, and nothing that could be a path. */
export const CLIP_NAME = /^[A-Za-z0-9_-]{1,80}$/;
/** A clip's video and poster as `clips.json` names them: one plain file name under `clips/`. */
const CLIP_FILE = /^clips\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,120}\.mp4$/;
const POSTER_FILE = /^clips\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,120}\.jpg$/;

export const CLIP_EVENT_TYPES: readonly ClipEventType[] = ["level", "quest", "death", "zone", "boss", "start", "end"];

/** The two kinds of media a clip has. */
export type ClipMediaKind = "mp4" | "jpg";
export const CLIP_CONTENT_TYPE: Record<ClipMediaKind, string> = { mp4: "video/mp4", jpg: "image/jpeg" };

/** One clip as `clips.json` lists it, checked. `file` and `poster` are relative to `camera/`. */
export interface CameraClip {
  name: string;
  kind: "timelapse" | "event";
  file: string;
  poster: string | null;
  event?: { type: ClipEventType; detail: string };
  from: string;
  to: string;
  seconds: number;
  caption: string;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;

/** An ISO instant as the contract writes it, or null. */
export function isoOrNull(v: unknown): string | null {
  return typeof v === "string" && ISO.test(v) && Number.isFinite(Date.parse(v)) ? v : null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Stat a path without following a link, and only when it is the kind asked
 * for: a link, a missing entry or the wrong kind is null.
 */
export function plain(path: string, kind: "dir" | "file"): Stats | null {
  let st: Stats;
  try {
    st = lstatSync(path);
  } catch {
    return null;
  }
  if (st.isSymbolicLink()) return null;
  return (kind === "dir" ? st.isDirectory() : st.isFile()) ? st : null;
}

/** `<runs>/<id>/camera`, when the run's directory and it are both plain directories. */
export function cameraDir(runsDir: string, runId: string): string | null {
  if (!isValidRunId(runId)) return null;
  const run = join(runsDir, runId);
  if (plain(run, "dir") === null) return null;
  const dir = join(run, CAMERA_DIR);
  return plain(dir, "dir") === null ? null : dir;
}

/** One clip entry, checked field by field; null drops it. */
function readClip(v: unknown): CameraClip | null {
  if (!isRecord(v)) return null;
  const name = v["name"];
  const kind = v["kind"];
  const file = v["file"];
  if (typeof name !== "string" || !CLIP_NAME.test(name)) return null;
  if (kind !== "timelapse" && kind !== "event") return null;
  if (typeof file !== "string" || !CLIP_FILE.test(file)) return null;
  const from = isoOrNull(v["from"]);
  const to = isoOrNull(v["to"]);
  const seconds = v["seconds"];
  if (from === null || to === null || typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return null;
  const poster = typeof v["poster"] === "string" && POSTER_FILE.test(v["poster"]) ? v["poster"] : null;
  const ev = v["event"];
  const event =
    isRecord(ev) && CLIP_EVENT_TYPES.includes(ev["type"] as ClipEventType)
      ? { type: ev["type"] as ClipEventType, detail: typeof ev["detail"] === "string" ? ev["detail"] : "" }
      : undefined;
  const caption = typeof v["caption"] === "string" ? v["caption"] : "";
  return { name, kind, file, poster, ...(event !== undefined ? { event } : {}), from, to, seconds, caption };
}

/**
 * The run's clips, or null when it has none: no camera, no `clips.json`, a
 * file that is not version 1, names another run or does not parse (a director
 * mid-write). An entry that does not read is dropped, and so is a second entry
 * under a name already taken. Never throws: one bad file must cost its run's
 * replay and nothing else, in the viewer and in a publisher pass alike.
 */
export function readClips(runsDir: string, runId: string): CameraClip[] | null {
  const dir = cameraDir(runsDir, runId);
  if (dir === null) return null;
  const path = join(dir, CLIPS_FILE);
  if (plain(path, "file") === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (!isRecord(raw) || raw["version"] !== 1 || raw["runId"] !== runId || !Array.isArray(raw["clips"])) return null;
  const out: CameraClip[] = [];
  const names = new Set<string>();
  for (const c of raw["clips"]) {
    const clip = readClip(c);
    if (clip === null || names.has(clip.name)) continue;
    names.add(clip.name);
    out.push(clip);
  }
  return out;
}

/**
 * The file behind one clip's video or poster, with its stat, or null. Only a
 * clip `clips.json` names, only its own `clips/<file>`, and only a plain file
 * under plain directories.
 */
export function clipMedia(
  runsDir: string,
  runId: string,
  name: string,
  kind: ClipMediaKind,
  /** The run's `readClips`, when the caller has just read it. */
  listed?: readonly CameraClip[],
): { file: string; stat: Stats } | null {
  if (!CLIP_NAME.test(name)) return null;
  const clip = (listed ?? readClips(runsDir, runId) ?? []).find((c) => c.name === name);
  if (clip === undefined) return null;
  const rel = kind === "mp4" ? clip.file : clip.poster;
  if (rel === null) return null;
  const dir = cameraDir(runsDir, runId);
  if (dir === null || plain(join(dir, "clips"), "dir") === null) return null;
  const file = join(dir, rel);
  const stat = plain(file, "file");
  return stat === null ? null : { file, stat };
}

/** Where the viewer serves a clip's media. */
export function clipMediaRoute(runId: string, name: string, kind: ClipMediaKind): string {
  return `/api/run/${encodeURIComponent(runId)}/clip/${name}.${kind}`;
}

/** A route `clipMediaRoute` made, read back. */
export const CLIP_MEDIA_ROUTE = /^\/clip\/([A-Za-z0-9_-]{1,80})\.(mp4|jpg)$/;

/**
 * The clips route's body: each clip with its media named by the viewer's own
 * routes. A clip whose video file is missing is left out; a missing poster is
 * null. The caption is as written; the public projection is what cuts it.
 */
export function clipsView(runsDir: string, runId: string): ClipsResponse | null {
  const clips = readClips(runsDir, runId);
  if (clips === null) return null;
  const out: ClipView[] = [];
  for (const c of clips) {
    if (clipMedia(runsDir, runId, c.name, "mp4", clips) === null) continue;
    const poster = c.poster !== null && clipMedia(runsDir, runId, c.name, "jpg", clips) !== null;
    out.push({
      name: c.name,
      kind: c.kind,
      ...(c.event !== undefined ? { event: c.event } : {}),
      from: c.from,
      to: c.to,
      seconds: c.seconds,
      caption: c.caption,
      video: clipMediaRoute(runId, c.name, "mp4"),
      poster: poster ? clipMediaRoute(runId, c.name, "jpg") : null,
    });
  }
  return out.length === 0 ? null : { runId, clips: out };
}

/** Whether `meta.json` says a camera followed the run (`"camera": true`). */
export function hadCamera(runsDir: string, runId: string): boolean {
  if (!isValidRunId(runId)) return false;
  const path = join(runsDir, runId, "meta.json");
  if (plain(path, "file") === null) return false;
  try {
    const meta = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return isRecord(meta) && meta["camera"] === true;
  } catch {
    return false;
  }
}

/**
 * The home page's one clip: the newest event clip across `runs`, or the newest
 * timelapse when no run has an event clip. Newest by the clip's end; ties go to
 * the run listed first. Null when there is no clip at all.
 */
export function pickHighlight(runs: readonly { runId: string; model: string | null; clips: ClipsResponse }[]): {
  runId: string;
  model: string | null;
  clip: ClipView;
} | null {
  let best: { runId: string; model: string | null; clip: ClipView } | null = null;
  const rank = (c: ClipView): [number, number] => [c.kind === "event" ? 1 : 0, Date.parse(c.to)];
  for (const r of runs) {
    for (const clip of r.clips.clips) {
      if (best === null) {
        best = { runId: r.runId, model: r.model, clip };
        continue;
      }
      const [k, t] = rank(clip);
      const [bk, bt] = rank(best.clip);
      if (k > bk || (k === bk && t > bt)) best = { runId: r.runId, model: r.model, clip };
    }
  }
  return best;
}

/**
 * Answer a GET or HEAD for a file, honouring one byte range.
 *
 * A video element seeks with `Range: bytes=<from>-`, and Safari will not play
 * an mp4 at all from a server that ignores ranges, so this answers a single
 * range with a 206 and the slice, an unsatisfiable one with a 416, and a
 * multi-range or malformed header with the whole file (which the standard
 * allows). The validators are the tiles' (size and mtime), and the browser
 * revalidates each time: a director may re-render a clip under its name.
 */
export function fileResponse(req: Request, file: string, stat: { size: number; mtimeMs: number }, contentType: string): Response {
  const etag = `"${stat.size.toString(36)}-${Math.floor(stat.mtimeMs).toString(36)}"`;
  const base: Record<string, string> = {
    "content-type": contentType,
    "accept-ranges": "bytes",
    "cache-control": "no-cache",
    etag,
  };
  const head = req.method.toUpperCase() === "HEAD";
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: base });
  const size = stat.size;
  const range = parseRange(req.headers.get("range"), size);
  if (range === "unsatisfiable") {
    return new Response(null, { status: 416, headers: { ...base, "content-range": `bytes */${size}` } });
  }
  const body = Bun.file(file);
  if (range === null) {
    return new Response(head ? null : body, { status: 200, headers: { ...base, "content-length": String(size) } });
  }
  const [start, end] = range;
  return new Response(head ? null : body.slice(start, end + 1), {
    status: 206,
    headers: { ...base, "content-length": String(end - start + 1), "content-range": `bytes ${start}-${end}/${size}` },
  });
}

/**
 * One `bytes=` range as inclusive offsets, null for "serve it whole" (no
 * header, a malformed one, several ranges), or "unsatisfiable".
 */
export function parseRange(header: string | null, size: number): [number, number] | null | "unsatisfiable" {
  if (header === null) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (m === null) return null;
  const [, a, b] = m as unknown as [string, string, string];
  if (a === "" && b === "") return null;
  if (a === "") {
    // A suffix: the last `b` bytes.
    const n = Number(b);
    if (n === 0) return "unsatisfiable";
    return size === 0 ? "unsatisfiable" : [Math.max(0, size - n), size - 1];
  }
  const start = Number(a);
  if (start >= size) return "unsatisfiable";
  const end = b === "" ? size - 1 : Math.min(Number(b), size - 1);
  return end < start ? null : [start, end];
}
