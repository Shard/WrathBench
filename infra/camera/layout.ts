/**
 * The camera's on-disk layout under a run's directory, `data/runs/<id>/camera/`
 * (docs/ARCHITECTURE.md, "Camera"). The director writes it and the viewer and
 * publisher read it, so its shape is fixed here and nowhere else:
 *
 *   frames/<seq>.jpg   still frames, JPEG q75, 1280×720; kept for the logs'
 *                      retention window, never published
 *   frames.jsonl       one FrameLine per frame
 *   clips/<name>.mp4   H.264, yuv420p, faststart, 1280×720, silent:
 *                      `timelapse` and `event-<seq>-<type>`
 *   clips/<name>.jpg   a poster for each clip
 *   clips.json         the ClipsFile: the only file a reader opens to find clips
 *
 * and `meta.json` gains `"camera": true` when a camera followed the run
 * (`label.ts`). Absent means no camera.
 */

import { join } from "node:path";

export const CAMERA_DIR = "camera";
export const FRAMES_DIR = "frames";
export const FRAMES_INDEX = "frames.jsonl";
export const CLIPS_DIR = "clips";
export const CLIPS_FILE = "clips.json";

export const FRAME_WIDTH = 1280;
export const FRAME_HEIGHT = 720;
export const JPEG_QUALITY = 75;

export const EVENT_TYPES = ["level", "quest", "death", "zone", "boss", "start", "end"] as const;
export type CameraEventType = (typeof EVENT_TYPES)[number];
/** The event kinds that earn a clip of their own; `start` and `end` only mark frames. */
export const CLIP_EVENT_TYPES: readonly CameraEventType[] = ["level", "quest", "death", "zone", "boss"];

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

export interface ClipEntry {
  name: string;
  kind: "timelapse" | "event";
  file: string;
  poster: string;
  event?: CameraEvent;
  from: string;
  to: string;
  seconds: number;
  caption: string;
}

export interface ClipsFile {
  version: 1;
  runId: string;
  clips: ClipEntry[];
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
