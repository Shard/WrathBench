/**
 * The camera's on-disk layout under a run's directory, `data/runs/<id>/camera/`
 * (docs/ARCHITECTURE.md, "Camera"). The director writes it and the viewer and
 * publisher read it, so its shape is fixed here and nowhere else:
 *
 *   frames/<seq>.jpg   still frames, JPEG q75, 1280×720, `<seq>` zero-padded
 *                      to six digits (`frames/000042.jpg`, `frameFile`): a
 *                      frames.jsonl line's `file` is exactly that name; kept
 *                      for the logs' retention window, never published
 *   frames.jsonl       one FrameLine per frame
 *   clips/part-<n>.mp4 the run's one video, in parts of at most six hours of
 *                      run time each: H.264, yuv420p, faststart, 1280×720,
 *                      silent; `<n>` zero-padded to three digits
 *   clips/part-<n>.jpg a poster for each part
 *   clips.json         the ClipsFile: the only file a reader opens to find the
 *                      video, its chapters, captions and time map
 *
 * and `meta.json` gains `"camera": true` when a camera followed the run
 * (`label.ts`). Absent means no camera.
 */

import { join } from "node:path";
import { CHAPTER_KINDS, MARK_KINDS } from "../../runner/src/mark-kinds";

export const CAMERA_DIR = "camera";
export const FRAMES_DIR = "frames";
export const FRAMES_INDEX = "frames.jsonl";
export const CLIPS_DIR = "clips";
export const CLIPS_FILE = "clips.json";

export const FRAME_WIDTH = 1280;
export const FRAME_HEIGHT = 720;
export const JPEG_QUALITY = 75;

/**
 * Every event a frame has ever been tagged with. `quest` and `zone` are no
 * longer taken (`shutter.ts`): they are here so the frames of a run filmed
 * before 2026-11-16 still read.
 */
export const EVENT_TYPES = ["level", "quest", "death", "zone", "boss", "start", "end"] as const;
export type CameraEventType = (typeof EVENT_TYPES)[number];
/**
 * The one rule for what a run's timeline marks (`viewer/timeline-marks.ts`,
 * its kinds in `runner/src/mark-kinds.ts`),
 * as the camera reads it. A **moment** is an event whose burst the video
 * keeps and holds: a level, a boss kill, a death. A **chapter** is a moment
 * `clips.json` lists: a level or a boss kill. A death is shown and not
 * listed; the pages mark it from the run's own records. `start` and `end`
 * only mark frames.
 */
export const MOMENT_TYPES: readonly CameraEventType[] = MARK_KINDS;
export const CHAPTER_TYPES: readonly CameraEventType[] = CHAPTER_KINDS;

export interface CameraEvent {
  type: CameraEventType;
  /** Short plain text of ours: never game prose. */
  detail: string;
}

export interface FrameLine {
  seq: number;
  /** ISO time the frame was taken. */
  t: string;
  file: string;
  kind: "interval" | "event";
  event?: CameraEvent;
}

/** One part of the run's video. `from`/`to` are the run times of its first and last frame. */
export interface VideoPart {
  file: string;
  poster: string;
  from: string;
  to: string;
  /** Its length as video. */
  seconds: number;
}

/** A moment worth a marker: `t` in seconds on the whole video's timeline, across parts. */
export interface Chapter {
  t: number;
  /** The index in `parts` it falls in. */
  part: number;
  type: CameraEventType;
  detail: string;
  /** The model's own words at that moment, or "". */
  caption: string;
}

/** The model's words from `t` (video seconds, whole timeline) until the next cue. */
export interface CaptionCue {
  t: number;
  text: string;
}

/**
 * `[videoSeconds, runTimeMs]` keypoints over the whole timeline, in order:
 * between two, run time is linear in video time. Compacted to where the rate
 * changes (within `TIMEMAP_TOLERANCE_MS`), so a steady stretch is two points.
 */
export type TimemapPoint = [number, number];

export interface ClipsFile {
  version: 2;
  runId: string;
  parts: VideoPart[];
  chapters: Chapter[];
  captions: CaptionCue[];
  timemap: TimemapPoint[];
}

export function cameraDir(runDir: string): string {
  return join(runDir, CAMERA_DIR);
}

/** `frames/000042.jpg`: zero-padded so a listing sorts in taking order. */
export function frameFile(seq: number): string {
  return `${FRAMES_DIR}/${String(seq).padStart(6, "0")}.jpg`;
}

/** frames.jsonl as written, whole lines only (a torn last line is skipped, as a reader of any JSONL here does). */
export function parseFrames(text: string): FrameLine[] {
  const out: FrameLine[] = [];
  const end = text.lastIndexOf("\n");
  if (end < 0) return out;
  for (const line of text.slice(0, end).split("\n")) {
    if (line.trim() === "") continue;
    try {
      const v = JSON.parse(line) as FrameLine;
      if (typeof v.seq === "number" && typeof v.t === "string" && typeof v.file === "string" && (v.kind === "interval" || v.kind === "event")) out.push(v);
    } catch {
      /* a torn or foreign line */
    }
  }
  return out;
}

/** The longest run time one part covers: a part closes when the next frame would take it past this. */
export const PART_MS = 6 * 3_600_000;

/** `clips/part-007.mp4` and its poster. */
export function partFiles(index: number): { file: string; poster: string } {
  const name = `part-${String(index).padStart(3, "0")}`;
  return { file: `${CLIPS_DIR}/${name}.mp4`, poster: `${CLIPS_DIR}/${name}.jpg` };
}
