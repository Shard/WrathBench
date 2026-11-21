/**
 * A run's camera video, as the viewer and the publisher read it.
 *
 * A camera that followed a run leaves `camera/` in the run's directory
 * (`docs/PUBLIC-DASHBOARD.md`, "Camera replays"): still frames, the run's one
 * video made from them in parts, and `camera/clips.json` (version 2), which
 * lists the parts, the chapters, the model's words and the time map, and is
 * the only file read here to find them. The frames are never published: no
 * function in this file names a path under `frames/`, and a part's video or
 * poster is served only when `clips.json` names it as `clips/<file>` with a
 * plain file name. The one frame a private handle serves, the newest, is read
 * by `camera-live.ts`.
 *
 * Every path is checked component by component with `lstat`: the run
 * directory, `camera/`, `clips/` and the file itself must each be what they
 * claim and none may be a symbolic link, so nothing under a run can point the
 * viewer or the publisher at a file outside it.
 */

import { lstatSync, readFileSync, type Stats } from "node:fs";
import { join } from "node:path";
import type { CaptionCueView, ChapterView, ClipsResponse, HighlightResponse, VideoPartView } from "./api-types";
import { isValidRunId } from "../src/run-list";
import { excerptAround, fitTimeline, totalSeconds, videoToRun } from "./video-time";

/** Under the run's directory. */
export const CAMERA_DIR = "camera";
export const CLIPS_FILE = "clips.json";

/** A part's name: `part-007` today, and nothing that could be a path. */
export const CLIP_NAME = /^[A-Za-z0-9_-]{1,80}$/;
/** A part's video and poster as `clips.json` names them: one plain file name under `clips/`. */
const CLIP_FILE = /^clips\/([A-Za-z0-9_-]{1,80})\.mp4$/;
const POSTER_FILE = /^clips\/[A-Za-z0-9_-]{1,80}\.jpg$/;

/** The two kinds of media a part has. */
export type ClipMediaKind = "mp4" | "jpg";
export const CLIP_CONTENT_TYPE: Record<ClipMediaKind, string> = { mp4: "video/mp4", jpg: "image/jpeg" };

/** One part as `clips.json` lists it, checked. `file` and `poster` are relative to `camera/`. */
export interface CameraPart {
  name: string;
  file: string;
  poster: string | null;
  from: string;
  to: string;
  seconds: number;
}

/** The run's video as `clips.json` lists it, checked. */
export interface CameraVideo {
  parts: CameraPart[];
  chapters: ChapterView[];
  captions: CaptionCueView[];
  timemap: [number, number][];
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;

/** An ISO instant as the contract writes it, or null. */
export function isoOrNull(v: unknown): string | null {
  return typeof v === "string" && ISO.test(v) && Number.isFinite(Date.parse(v)) ? v : null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const finiteAtLeast0 = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

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

/** One part entry, checked field by field; null ends the list there. */
function readPart(v: unknown): CameraPart | null {
  if (!isRecord(v)) return null;
  const file = v["file"];
  const m = typeof file === "string" ? CLIP_FILE.exec(file) : null;
  if (m === null) return null;
  const from = isoOrNull(v["from"]);
  const to = isoOrNull(v["to"]);
  const seconds = v["seconds"];
  if (from === null || to === null || !finiteAtLeast0(seconds)) return null;
  const poster = typeof v["poster"] === "string" && POSTER_FILE.test(v["poster"]) ? v["poster"] : null;
  return { name: m[1]!, file: file as string, poster, from, to, seconds };
}

/**
 * The run's video, or null when it has none: no camera, no `clips.json`, a
 * file that is not version 2, names another run or does not parse (a
 * director mid-write). The parts are read in order up to the first that does
 * not read or repeats a name, so the timeline has no gaps. Never throws: one
 * bad file must cost its run's video and nothing else, in the viewer and in a
 * publisher pass alike.
 */
export function readClips(runsDir: string, runId: string): CameraVideo | null {
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
  if (!isRecord(raw) || raw["version"] !== 2 || raw["runId"] !== runId || !Array.isArray(raw["parts"])) return null;
  const parts: CameraPart[] = [];
  const names = new Set<string>();
  for (const p of raw["parts"]) {
    const part = readPart(p);
    if (part === null || names.has(part.name)) break;
    names.add(part.name);
    parts.push(part);
  }
  if (parts.length === 0) return null;
  return { parts, ...fitTimeline(parts, { chapters: raw["chapters"], captions: raw["captions"], timemap: raw["timemap"] }) };
}

/**
 * The file behind one part's video or poster, with its stat, or null. Only a
 * part `clips.json` names, only its own `clips/<file>`, and only a plain file
 * under plain directories.
 */
export function clipMedia(
  runsDir: string,
  runId: string,
  name: string,
  kind: ClipMediaKind,
  /** The run's `readClips`, when the caller has just read it. */
  listed?: CameraVideo | null,
): { file: string; stat: Stats } | null {
  if (!CLIP_NAME.test(name)) return null;
  const part = (listed === undefined ? readClips(runsDir, runId) : listed)?.parts.find((c) => c.name === name);
  if (part === undefined) return null;
  const rel = kind === "mp4" ? part.file : part.poster;
  if (rel === null) return null;
  const dir = cameraDir(runsDir, runId);
  if (dir === null || plain(join(dir, "clips"), "dir") === null) return null;
  const file = join(dir, rel);
  const stat = plain(file, "file");
  return stat === null ? null : { file, stat };
}

/** Where the viewer serves a part's media. */
export function clipMediaRoute(runId: string, name: string, kind: ClipMediaKind): string {
  return `/api/run/${encodeURIComponent(runId)}/clip/${name}.${kind}`;
}

/** A route `clipMediaRoute` made, read back. */
export const CLIP_MEDIA_ROUTE = /^\/clip\/([A-Za-z0-9_-]{1,80})\.(mp4|jpg)$/;

/**
 * The clips route's body: each part with its media named by the viewer's own
 * routes, up to the first whose video file is missing; a missing poster is
 * null. The captions are as written; the public projection is what cuts them.
 */
export function clipsView(runsDir: string, runId: string): ClipsResponse | null {
  const video = readClips(runsDir, runId);
  if (video === null) return null;
  const parts: VideoPartView[] = [];
  for (const p of video.parts) {
    if (clipMedia(runsDir, runId, p.name, "mp4", video) === null) break;
    const poster = p.poster !== null && clipMedia(runsDir, runId, p.name, "jpg", video) !== null;
    parts.push({
      name: p.name,
      from: p.from,
      to: p.to,
      seconds: p.seconds,
      video: clipMediaRoute(runId, p.name, "mp4"),
      poster: poster ? clipMediaRoute(runId, p.name, "jpg") : null,
    });
  }
  if (parts.length === 0) return null;
  return { runId, parts, ...fitTimeline(parts, video) };
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
 * The home page's excerpt: around the newest chapter across `runs`, newest by
 * the run time the time map gives it; ties go to the run listed first. A run
 * with a video and no chapter is a candidate only when no run has one, and
 * then its video's last seconds are shown. Null when no run has a video.
 */
export function pickHighlight(runs: readonly { runId: string; model: string | null; clips: ClipsResponse }[]): HighlightResponse["highlight"] {
  let best: { at: number; chaptered: boolean; pick: NonNullable<HighlightResponse["highlight"]> } | null = null;
  for (const r of runs) {
    const { parts, chapters, timemap } = r.clips;
    if (parts.length === 0) continue;
    const chapter = chapters.at(-1) ?? null;
    const t = chapter?.t ?? Math.max(0, totalSeconds(parts) - 1);
    const win = excerptAround(parts, t);
    if (win === null) continue;
    const at = videoToRun(timemap, t) ?? Date.parse(parts.at(-1)!.to);
    const chaptered = chapter !== null;
    if (best !== null && ((best.chaptered && !chaptered) || (best.chaptered === chaptered && at <= best.at))) continue;
    best = { at, chaptered, pick: { runId: r.runId, model: r.model, part: parts[win.index]!, from: win.from, to: win.to, chapter } };
  }
  return best?.pick ?? null;
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
