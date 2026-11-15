/**
 * Clips from a run's camera frames (docs/ARCHITECTURE.md, "Camera"): a
 * timelapse of the interval frames and one clip per event burst, each with a
 * poster and the model's own words as its caption, and `clips.json` beside
 * them, written last so a reader that finds it finds every file it names.
 *
 *   bun infra/camera/assemble.ts <run-dir> [--interval-seconds 10]
 *
 * The director runs it when its subject's run ends; it is idempotent, so a
 * re-run (an operator's, or after a resume) rebuilds every clip.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { clipCaption, modelNameOf, readRunWords, saidAt, BENCHMARK_NAME, type Said } from "./captions";
import {
  cameraDir,
  CLIP_EVENT_TYPES,
  CLIPS_DIR,
  CLIPS_FILE,
  FRAME_HEIGHT,
  FRAME_WIDTH,
  FRAMES_INDEX,
  parseFrames,
  type CameraEvent,
  type ClipEntry,
  type ClipsFile,
  type FrameLine,
} from "./layout";

export const TIMELAPSE_FPS = 12;
export const EVENT_FPS = 4;
/** An event clip holds its last frame this long. */
export const EVENT_HOLD_S = 1.5;
/** Fewer frames than this make no event clip. */
export const MIN_EVENT_FRAMES = 4;
/** Two frames of one burst are never further apart than this. */
const BURST_GAP_MS = 5_000;

export interface ClipPlan {
  name: string;
  kind: "timelapse" | "event";
  frames: FrameLine[];
  fps: number;
  holdS: number;
  event?: CameraEvent;
  poster: FrameLine;
  /** The moment whose words caption the clip as a whole. */
  captionAt: number;
}

const ms = (f: FrameLine): number => Date.parse(f.t);

/** Which clips the frames make. Pure. */
export function planClips(all: readonly FrameLine[], o: { intervalMs: number }): ClipPlan[] {
  const frames = [...all].sort((a, b) => ms(a) - ms(b));
  const plans: ClipPlan[] = [];

  // The timelapse: one frame per interval, whatever kind it was kept as.
  const lapse: FrameLine[] = [];
  for (const f of frames) if (lapse.length === 0 || ms(f) - ms(lapse.at(-1)!) >= o.intervalMs * 0.8) lapse.push(f);
  if (lapse.length >= 2) {
    plans.push({ name: "timelapse", kind: "timelapse", frames: lapse, fps: TIMELAPSE_FPS, holdS: 0, poster: lapse[Math.floor(lapse.length / 2)]!, captionAt: ms(lapse.at(-1)!) });
  }

  // Event bursts: consecutive frames tagged with one event.
  let burst: FrameLine[] = [];
  const close = () => {
    const first = burst[0];
    if (first?.event !== undefined && CLIP_EVENT_TYPES.includes(first.event.type) && burst.length >= MIN_EVENT_FRAMES) {
      // The window is lead then tail (shutter.ts): the event sits three quarters in.
      const poster = burst[Math.min(burst.length - 1, Math.floor(burst.length * 0.75))]!;
      plans.push({ name: `event-${first.seq}-${first.event.type}`, kind: "event", frames: burst, fps: EVENT_FPS, holdS: EVENT_HOLD_S, event: first.event, poster, captionAt: ms(poster) });
    }
    burst = [];
  };
  for (const f of frames) {
    const prev = burst.at(-1);
    const same = prev !== undefined && f.kind === "event" && f.event !== undefined && prev.event?.type === f.event.type && prev.event.detail === f.event.detail && ms(f) - ms(prev) <= BURST_GAP_MS;
    if (!same) close();
    if (f.kind === "event" && f.event !== undefined) burst.push(f);
  }
  close();
  return plans;
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

/** The subtitle track: our line at the top, the model's words at the bottom, frame by frame. */
export function subtitlesOf(plan: ClipPlan, said: readonly Said[], modelName: string): string {
  const head =
    `[Script Info]\nScriptType: v4.00+\nPlayResX: ${FRAME_WIDTH}\nPlayResY: ${FRAME_HEIGHT}\nWrapStyle: 0\n\n` +
    `[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV\n` +
    `Style: Cap,DejaVu Sans,30,&H00FFFFFF,&H00000000,&H90000000,0,3,1,0,2,60,60,40\n` +
    `Style: Hud,DejaVu Sans,22,&H00E8E8E8,&H00000000,&H90000000,0,3,1,0,7,28,28,24\n\n` +
    `[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
  const hud = [BENCHMARK_NAME, modelName, ...(plan.event !== undefined ? [plan.event.detail] : [])].join(" · ");
  const dur = 1 / plan.fps;
  const total = plan.frames.length * dur + plan.holdS;
  const lines = [`Dialogue: 0,${assTime(0)},${assTime(total)},Hud,,0,0,0,,${assText(hud)}`];
  plan.frames.forEach((f, i) => {
    const words = saidAt(said, ms(f));
    if (words === "") return;
    const end = i === plan.frames.length - 1 ? total : (i + 1) * dur;
    lines.push(`Dialogue: 0,${assTime(i * dur)},${assTime(end)},Cap,,0,0,0,,${assText(words)}`);
  });
  return `${head}${lines.join("\n")}\n`;
}

/** The concat demuxer's list: each frame for one frame's time, the last held. */
export function concatListOf(plan: ClipPlan, dir: string): string {
  const dur = 1 / plan.fps;
  const quote = (p: string) => `'${p.replace(/'/g, "'\\''")}'`;
  const rows = plan.frames.map((f, i) => `file ${quote(join(dir, f.file))}\nduration ${(i === plan.frames.length - 1 ? dur + plan.holdS : dur).toFixed(4)}`);
  // The demuxer ignores the last entry's duration unless the file is listed again.
  rows.push(`file ${quote(join(dir, plan.frames.at(-1)!.file))}`);
  return `${rows.join("\n")}\n`;
}

/** A path as the `subtitles` filter's option value wants it. */
function filterPath(p: string): string {
  return p.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

export function ffmpegArgs(list: string, ass: string, out: string, fps: number): string[] {
  const vf = [
    `scale=${FRAME_WIDTH}:${FRAME_HEIGHT}:force_original_aspect_ratio=decrease:out_range=tv`,
    `pad=${FRAME_WIDTH}:${FRAME_HEIGHT}:(ow-iw)/2:(oh-ih)/2`,
    `subtitles=filename=${filterPath(ass)}`,
    "format=yuv420p",
  ].join(",");
  return ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-vf", vf, "-r", String(fps), "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-f", "mp4", out];
}

export interface AssembleOptions {
  intervalMs: number;
  ffmpeg?: string;
  log?: (line: string) => void;
}

/** Build every clip of a run's camera directory and write clips.json. Returns it, or null when there were no frames. */
export function assembleRun(runDir: string, o: AssembleOptions): ClipsFile | null {
  const log = o.log ?? (() => {});
  const cam = cameraDir(runDir);
  const index = join(cam, FRAMES_INDEX);
  if (!existsSync(index)) return null;
  const frames = parseFrames(readFileSync(index, "utf8")).filter((f) => existsSync(join(cam, f.file)));
  const runId = basename(runDir);
  const { model, said } = readRunWords(runDir);
  const modelName = modelNameOf(model);
  const clipsDir = join(cam, CLIPS_DIR);
  const work = join(cam, ".work");
  mkdirSync(clipsDir, { recursive: true });
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const ffmpeg = o.ffmpeg ?? Bun.which("ffmpeg") ?? "ffmpeg";
  const clips: ClipEntry[] = [];
  try {
    for (const plan of planClips(frames, { intervalMs: o.intervalMs })) {
      const list = join(work, `${plan.name}.txt`);
      const ass = join(work, `${plan.name}.ass`);
      const tmp = join(work, `${plan.name}.mp4`);
      writeFileSync(list, concatListOf(plan, cam));
      writeFileSync(ass, subtitlesOf(plan, said, modelName));
      const r = Bun.spawnSync([ffmpeg, ...ffmpegArgs(list, ass, tmp, plan.fps)], { stdout: "pipe", stderr: "pipe" });
      if (r.exitCode !== 0) {
        log(`clip ${plan.name}: ffmpeg failed (${r.exitCode}): ${r.stderr.toString().trim().slice(0, 400)}`);
        continue;
      }
      const file = `${CLIPS_DIR}/${plan.name}.mp4`;
      const poster = `${CLIPS_DIR}/${plan.name}.jpg`;
      copyFileSync(join(cam, plan.poster.file), join(work, `${plan.name}.jpg`));
      renameSync(join(work, `${plan.name}.jpg`), join(cam, poster));
      renameSync(tmp, join(cam, file));
      clips.push({
        name: plan.name,
        kind: plan.kind,
        file,
        poster,
        ...(plan.event !== undefined ? { event: plan.event } : {}),
        from: plan.frames[0]!.t,
        to: plan.frames.at(-1)!.t,
        seconds: Math.round((plan.frames.length / plan.fps + plan.holdS) * 10) / 10,
        caption: clipCaption(saidAt(said, plan.captionAt), modelName),
      });
      log(`clip ${plan.name}: ${plan.frames.length} frames`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  const doc: ClipsFile = { version: 1, runId, clips };
  const out = join(cam, CLIPS_FILE);
  writeFileSync(`${out}.tmp`, `${JSON.stringify(doc, null, 2)}\n`);
  renameSync(`${out}.tmp`, out);
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
  console.log(doc === null ? "no frames" : `${doc.clips.length} clip(s) -> ${join(cameraDir(dir), CLIPS_FILE)}`);
}
