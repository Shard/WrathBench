/**
 * The run's one video from its camera frames (docs/ARCHITECTURE.md, "Camera"):
 * every frame kept, interval and event alike, in the order it was taken, cut
 * into parts of at most six hours of run time, each with a poster; the
 * chapters, the model's own words and the time map in `clips.json` beside
 * them, written last so a reader that finds it finds every file it names.
 *
 *   bun infra/camera/assemble.ts <run-dir> [--interval-seconds 10]
 *
 * The rate: the video runs at `VIDEO_FPS` (8) frames a second and an interval
 * frame is on screen for one of them, so at the default ten-second interval a
 * minute of video is 80 minutes of play, and a 90-minute run about a minute
 * and a half before its events. An event's burst is thinned to the twelve
 * seconds around its moment (`BURST_LEAD_MS`, `BURST_TAIL_MS`), one video
 * frame each, and the moment itself is held a second (`HOLD_TICKS`): about
 * two and a half seconds of video per level, boss kill or death
 * (`MOMENT_TYPES`). Of those a level and a boss kill are chapters in
 * `clips.json` (`CHAPTER_TYPES`); a death is shown the same and listed
 * nowhere, and an event the camera no longer takes (a turn-in, a zone, in the
 * frames of an older run) is a frame like any other.
 *
 * A part closes when the next frame would take it past six hours of run time
 * (`PART_MS`). Every part but the last is closed, and a closed part is never
 * encoded again: its file, poster, chapters, captions and time map are taken
 * from the previous `clips.json` as they were, since its frames may have been
 * pruned since (sweep.ts). Only the last, open part is rebuilt, from the first
 * frame after the last closed part, so a long freeplay run costs one part's
 * encode and one part's upload per assembly, not its whole history.
 *
 * The model's words are not burned into the picture: they are `captions` in
 * `clips.json`, which the public site redacts like any model text. The
 * picture carries only our own line: the benchmark, the model and, during an
 * event, its detail.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { modelNameOf, readRunWords, saidAt, BENCHMARK_NAME, type Said } from "./captions";
import {
  cameraDir,
  CHAPTER_TYPES,
  MOMENT_TYPES,
  CLIPS_DIR,
  CLIPS_FILE,
  FRAME_HEIGHT,
  FRAME_WIDTH,
  FRAMES_INDEX,
  PART_MS,
  parseFrames,
  partFiles,
  type CameraEvent,
  type CaptionCue,
  type Chapter,
  type ClipsFile,
  type FrameLine,
  type TimemapPoint,
  type VideoPart,
} from "./layout";

/** The video's frame rate; every frame's time on screen is a whole number of these. */
export const VIDEO_FPS = 8;
/** The event's own frame stays on screen this many video frames longer (one second). */
const HOLD_TICKS = 8;
/** Of an event's burst, the frames this long before its moment are kept whole… */
export const BURST_LEAD_MS = 8_000;
/** …and this long after; the rest of the burst is thinned like interval frames. */
export const BURST_TAIL_MS = 4_000;
/** A new caption waits until the one before has been up this long, in video seconds. */
export const CAPTION_MIN_S = 3;
/** How far the compacted time map may be off a frame's own run time. */
export const TIMEMAP_TOLERANCE_MS = 2_000;
/** Two frames of one burst are never further apart than this. */
const BURST_GAP_MS = 5_000;

/** A frame as the video shows it: for `ticks` video frames. */
interface Shot {
  frame: FrameLine;
  ticks: number;
  /** The first shot of a moment's window: its detail goes on screen here, and a chapter opens if it is one. */
  chapter?: { event: CameraEvent; moment: number };
  /** The event's own frame, held: the moment's detail is on screen until it ends. */
  moment?: true;
}

const ms = (f: FrameLine): number => Date.parse(f.t);

/** Every frame the video shows, in order, and for how long. Pure. */
export function planShots(all: readonly FrameLine[], o: { intervalMs: number }): Shot[] {
  const frames = [...all].sort((a, b) => ms(a) - ms(b) || a.seq - b.seq);
  // Bursts: consecutive frames tagged with one event.
  const window = new Map<number, { event: CameraEvent; moment: number; from: number; to: number }>();
  let burst: number[] = [];
  const close = (): void => {
    const first = frames[burst[0] ?? -1];
    if (first?.event !== undefined && MOMENT_TYPES.includes(first.event.type)) {
      // The shutter's window is lead then tail: the event sits three quarters in.
      const moment = ms(frames[burst[Math.min(burst.length - 1, Math.floor(burst.length * 0.75))]!]!);
      const w = { event: first.event, moment, from: moment - BURST_LEAD_MS, to: moment + BURST_TAIL_MS };
      for (const i of burst) window.set(i, w);
    }
    burst = [];
  };
  frames.forEach((f, i) => {
    const prev = frames[burst.at(-1) ?? -1];
    const same = prev !== undefined && f.kind === "event" && f.event !== undefined && prev.event?.type === f.event.type && prev.event.detail === f.event.detail && ms(f) - ms(prev) <= BURST_GAP_MS;
    if (!same) close();
    if (f.kind === "event" && f.event !== undefined) burst.push(i);
  });
  close();

  const shots: Shot[] = [];
  const opened = new Set<object>();
  const held = new Set<object>();
  let last = Number.NEGATIVE_INFINITY;
  frames.forEach((f, i) => {
    const t = ms(f);
    const w = window.get(i);
    if (w !== undefined && t >= w.from && t <= w.to) {
      const shot: Shot = { frame: f, ticks: 1 };
      if (!opened.has(w)) {
        opened.add(w);
        shot.chapter = { event: w.event, moment: w.moment };
      }
      if (t >= w.moment && !held.has(w)) {
        held.add(w);
        shot.ticks += HOLD_TICKS;
        shot.moment = true;
      }
      shots.push(shot);
      last = t;
    } else if (t - last >= o.intervalMs * 0.8) {
      shots.push({ frame: f, ticks: 1 });
      last = t;
    }
  });
  return shots;
}

/** The shots cut into parts: a part closes when the next frame would take it past `PART_MS` of run time. Pure. */
function splitParts(shots: readonly Shot[], partMs: number = PART_MS): Shot[][] {
  const parts: Shot[][] = [];
  for (const s of shots) {
    const cur = parts.at(-1);
    if (cur === undefined || ms(s.frame) - ms(cur[0]!.frame) > partMs) parts.push([s]);
    else cur.push(s);
  }
  return parts;
}

/** A part's length as video, in seconds. */
export function partSeconds(part: readonly Shot[]): number {
  return part.reduce((n, s) => n + s.ticks, 0) / VIDEO_FPS;
}

export interface PartTimeline {
  chapters: Chapter[];
  captions: CaptionCue[];
  /** One point per frame shown, and one at the end of a hold; not yet compacted. */
  points: TimemapPoint[];
  /** Our own line's event details, in the part's own seconds. */
  details: { from: number; to: number; text: string }[];
}

/**
 * A part's chapters, captions and time map on the whole video's timeline,
 * `offset` seconds in. `lastCue` is the cue before the part, so a caption
 * that has not changed is not said again. Pure.
 */
export function timelineOf(part: readonly Shot[], index: number, offset: number, said: readonly Said[], lastCue: CaptionCue | null): PartTimeline {
  const out: PartTimeline = { chapters: [], captions: [], points: [], details: [] };
  let cue = lastCue;
  let tick = 0;
  let open: { from: number; text: string } | null = null;
  for (const s of part) {
    const local = tick / VIDEO_FPS;
    const v = offset + local;
    const r = ms(s.frame);
    out.points.push([v, r]);
    if (s.ticks > 1) out.points.push([offset + (tick + s.ticks - 1) / VIDEO_FPS, r]);
    if (s.chapter !== undefined) {
      if (CHAPTER_TYPES.includes(s.chapter.event.type)) {
        out.chapters.push({ t: v, part: index, type: s.chapter.event.type, detail: s.chapter.event.detail, caption: saidAt(said, s.chapter.moment) });
      }
      if (open !== null) out.details.push({ from: open.from, to: local, text: open.text });
      open = { from: local, text: s.chapter.event.detail };
    }
    const words = saidAt(said, r);
    if (words !== "" && words !== cue?.text && (cue === null || v - cue.t >= CAPTION_MIN_S)) {
      cue = { t: v, text: words };
      out.captions.push(cue);
    }
    tick += s.ticks;
    if (s.moment === true && open !== null) {
      out.details.push({ from: open.from, to: tick / VIDEO_FPS, text: open.text });
      open = null;
    }
  }
  if (open !== null) out.details.push({ from: open.from, to: tick / VIDEO_FPS, text: open.text });
  return out;
}

/**
 * The time map compacted: a point is dropped when the line between the points
 * kept around it puts every dropped frame within `tolerance` of its own run
 * time. The first and last points always stay. Pure.
 */
function compactTimemap(points: readonly TimemapPoint[], tolerance: number = TIMEMAP_TOLERANCE_MS): TimemapPoint[] {
  if (points.length <= 2) return points.map((p) => [p[0], p[1]]);
  const out: TimemapPoint[] = [[points[0]![0], points[0]![1]]];
  let a = 0;
  const fits = (from: number, to: number): boolean => {
    const [va, ra] = points[from]!;
    const [vb, rb] = points[to]!;
    for (let i = from + 1; i < to; i++) {
      const [v, r] = points[i]!;
      const at = vb === va ? ra : ra + ((v - va) * (rb - ra)) / (vb - va);
      if (Math.abs(at - r) > tolerance) return false;
    }
    return true;
  };
  for (let j = a + 2; j < points.length; j++) {
    if (!fits(a, j)) {
      a = j - 1;
      out.push([points[a]![0], points[a]![1]]);
    }
  }
  const lastPoint = points.at(-1)!;
  out.push([lastPoint[0], lastPoint[1]]);
  return out;
}

function assTime(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = (s % 60).toFixed(2).padStart(5, "0");
  return `${h}:${String(m).padStart(2, "0")}:${sec}`;
}

/** Text safe inside an ASS dialogue line. */
function assText(s: string): string {
  return s.replace(/[{}\\]/g, "").replace(/\n/g, " ");
}

/** Our own line over a part: the benchmark and the model throughout, an event's detail while it shows. Never the model's words. */
export function subtitlesOf(seconds: number, details: PartTimeline["details"], modelName: string): string {
  const head =
    `[Script Info]\nScriptType: v4.00+\nPlayResX: ${FRAME_WIDTH}\nPlayResY: ${FRAME_HEIGHT}\nWrapStyle: 0\n\n` +
    `[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV\n` +
    `Style: Hud,DejaVu Sans,22,&H00E8E8E8,&H00000000,&H90000000,0,3,1,0,7,28,28,24\n` +
    `Style: Ev,DejaVu Sans,26,&H00FFFFFF,&H00000000,&H90000000,0,3,1,0,9,28,28,24\n\n` +
    `[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
  const lines = [`Dialogue: 0,${assTime(0)},${assTime(seconds)},Hud,,0,0,0,,${assText(`${BENCHMARK_NAME} · ${modelName}`)}`];
  for (const d of details) lines.push(`Dialogue: 0,${assTime(d.from)},${assTime(d.to)},Ev,,0,0,0,,${assText(d.text)}`);
  return `${head}${lines.join("\n")}\n`;
}

/** The concat demuxer's list: each frame for its whole number of video frames. */
function concatListOf(part: readonly Shot[], dir: string): string {
  const quote = (p: string) => `'${p.replace(/'/g, "'\\''")}'`;
  const rows = part.map((s) => `file ${quote(join(dir, s.frame.file))}\nduration ${(s.ticks / VIDEO_FPS).toFixed(4)}`);
  // The demuxer ignores the last entry's duration unless the file is listed again.
  rows.push(`file ${quote(join(dir, part.at(-1)!.frame.file))}`);
  return `${rows.join("\n")}\n`;
}

/** A path as the `subtitles` filter's option value wants it. */
function filterPath(p: string): string {
  return p.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

export function ffmpegArgs(list: string, ass: string, out: string, seconds: number): string[] {
  const vf = [
    `scale=${FRAME_WIDTH}:${FRAME_HEIGHT}:force_original_aspect_ratio=decrease:out_range=tv`,
    `pad=${FRAME_WIDTH}:${FRAME_HEIGHT}:(ow-iw)/2:(oh-ih)/2`,
    `subtitles=filename=${filterPath(ass)}`,
    `fps=${VIDEO_FPS}`,
    "format=yuv420p",
  ].join(",");
  return ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-vf", vf, "-t", seconds.toFixed(3), "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-f", "mp4", out];
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** The version-2 clips.json there is, or null (none, another version, unreadable). */
export function previousDoc(cam: string): ClipsFile | null {
  try {
    const doc = JSON.parse(readFileSync(join(cam, CLIPS_FILE), "utf8")) as unknown;
    if (!isRecord(doc) || doc["version"] !== 2) return null;
    const d = doc as unknown as ClipsFile;
    if (!Array.isArray(d.parts) || !Array.isArray(d.chapters) || !Array.isArray(d.captions) || !Array.isArray(d.timemap)) return null;
    return d;
  } catch {
    return null;
  }
}

export interface AssembleOptions {
  intervalMs: number;
  ffmpeg?: string;
  log?: (line: string) => void;
}

/**
 * Build the open part of a run's video, keep its closed parts as they were,
 * and write clips.json. Returns it, or null when there is nothing to show.
 */
export function assembleRun(runDir: string, o: AssembleOptions): ClipsFile | null {
  const log = o.log ?? (() => {});
  const cam = cameraDir(runDir);
  const index = join(cam, FRAMES_INDEX);
  if (!existsSync(index)) return null;
  const frames = parseFrames(readFileSync(index, "utf8")).filter((f) => existsSync(join(cam, f.file)));
  const prev = previousDoc(cam);

  // The closed parts: every part but the previous last, while their files are there.
  const kept: VideoPart[] = [];
  for (const p of prev?.parts.slice(0, -1) ?? []) {
    if (!existsSync(join(cam, p.file)) || !existsSync(join(cam, p.poster))) break;
    kept.push(p);
  }
  const offset = kept.reduce((n, p) => n + p.seconds, 0);
  const cutoff = kept.length > 0 ? Date.parse(kept.at(-1)!.to) : Number.NEGATIVE_INFINITY;
  const parts = splitParts(planShots(frames.filter((f) => ms(f) > cutoff), { intervalMs: o.intervalMs }));
  if (parts.length === 0) return prev;

  const runId = basename(runDir);
  const { model, said } = readRunWords(runDir);
  const modelName = modelNameOf(model);
  const keptChapters = (prev?.chapters ?? []).filter((c) => c.part < kept.length);
  const keptCaptions = (prev?.captions ?? []).filter((c) => c.t < offset);
  const keptPoints = (prev?.timemap ?? []).filter((p) => p[0] < offset);
  const doc: ClipsFile = { version: 2, runId, parts: [...kept], chapters: keptChapters, captions: keptCaptions, timemap: [] };
  const newPoints: TimemapPoint[] = [];

  const clipsDir = join(cam, CLIPS_DIR);
  const work = join(cam, ".work");
  mkdirSync(clipsDir, { recursive: true });
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const ffmpeg = o.ffmpeg ?? Bun.which("ffmpeg") ?? "ffmpeg";
  try {
    let at = offset;
    for (const [j, part] of parts.entries()) {
      const i = kept.length + j;
      const { file, poster } = partFiles(i);
      const seconds = partSeconds(part);
      const line = timelineOf(part, i, at, said, doc.captions.at(-1) ?? null);
      const list = join(work, `${i}.txt`);
      const ass = join(work, `${i}.ass`);
      const tmp = join(work, `${i}.mp4`);
      writeFileSync(list, concatListOf(part, cam));
      writeFileSync(ass, subtitlesOf(seconds, line.details, modelName));
      const r = Bun.spawnSync([ffmpeg, ...ffmpegArgs(list, ass, tmp, seconds)], { stdout: "pipe", stderr: "pipe" });
      if (r.exitCode !== 0) {
        // A part that would not encode ends the video there: the timeline has no gaps.
        log(`part ${i}: ffmpeg failed (${r.exitCode}): ${r.stderr.toString().trim().slice(0, 400)}`);
        break;
      }
      copyFileSync(join(cam, part[Math.floor(part.length / 2)]!.frame.file), join(work, `${i}.jpg`));
      renameSync(join(work, `${i}.jpg`), join(cam, poster));
      renameSync(tmp, join(cam, file));
      doc.parts.push({ file, poster, from: part[0]!.frame.t, to: part.at(-1)!.frame.t, seconds });
      doc.chapters.push(...line.chapters);
      doc.captions.push(...line.captions);
      newPoints.push(...line.points);
      log(`part ${i}: ${part.length} frames, ${seconds} s`);
      at += seconds;
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  if (doc.parts.length === 0) return null;
  doc.timemap = [...keptPoints, ...compactTimemap(newPoints)];
  const out = join(cam, CLIPS_FILE);
  writeFileSync(`${out}.tmp`, `${JSON.stringify(doc)}\n`);
  renameSync(`${out}.tmp`, out);
  // Whatever the list no longer names goes: an older layout's clips, a part that would not encode.
  const named = new Set(doc.parts.flatMap((p) => [p.file, p.poster]));
  for (const f of readdirSync(clipsDir)) if (!named.has(`${CLIPS_DIR}/${f}`)) rmSync(join(clipsDir, f), { force: true });
  return doc;
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  const dir = args.find((a) => !a.startsWith("--"));
  const i = args.indexOf("--interval-seconds");
  const intervalS = i >= 0 ? Number(args[i + 1]) : 10;
  if (dir === undefined || !Number.isFinite(intervalS) || intervalS <= 0) {
    console.error("usage: bun infra/camera/assemble.ts <run-dir> [--interval-seconds 10]");
    process.exit(2);
  }
  const doc = assembleRun(dir, { intervalMs: intervalS * 1000, log: (l) => console.log(l) });
  console.log(doc === null ? "no frames" : `${doc.parts.length} part(s), ${doc.chapters.length} chapter(s) -> ${join(cameraDir(dir), CLIPS_FILE)}`);
}
