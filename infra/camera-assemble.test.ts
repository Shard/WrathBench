/**
 * The run's video (infra/camera/assemble.ts), captions (camera/captions.ts)
 * and the run label (camera/label.ts). The planner is tested on fake
 * timestamps alone; the part bookkeeping with a stub ffmpeg that writes a
 * byte and logs what it was asked for; and one real encode with ffmpeg
 * `testsrc` images made in a temp directory: no game image is ever in git.
 * The real encode needs ffmpeg and ffprobe on PATH; CI installs them
 * (.github/workflows/ci.yml).
 */
import { describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "./temp-dirs";
import { assembleRun, compactTimemap, concatListOf, HOLD_TICKS, planShots, splitParts, subtitlesOf, timelineOf, VIDEO_FPS, type Shot } from "./camera/assemble";
import { captionLine, saidAt, saidOf } from "./camera/captions";
import { hasCameraLabel, labelRun, writeCameraLabel } from "./camera/label";
import { CLIPS_FILE, frameFile, parseFrames, PART_MS, type ClipsFile, type FrameLine } from "./camera/layout";

const tmp = tempDirs();
const ffmpeg = Bun.which("ffmpeg");
const ffprobe = Bun.which("ffprobe");
const ENCODE_MS = 60_000;

const T0 = Date.parse("2026-11-15T10:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

/** A 1 fps capture's kept frames: interval every 10 s, and a level-up burst 30 s before to 10 s after. */
function frameLines(levelAt: number, event: NonNullable<FrameLine["event"]> = { type: "level", detail: "reached level 6" }): FrameLine[] {
  const out: FrameLine[] = [];
  let seq = 0;
  let last = -Infinity;
  for (let t = T0; t <= T0 + 120_000; t += 1000) {
    const inBurst = t >= levelAt - 30_000 && t <= levelAt + 10_000;
    if (inBurst) out.push({ seq, t: iso(t), file: frameFile(seq++), kind: "event", event });
    else if (t - last >= 10_000) out.push({ seq, t: iso(t), file: frameFile(seq++), kind: "interval" });
    else continue;
    last = t;
  }
  return out;
}

function trajectory(): string {
  const rows = [
    { ts: T0 - 5_000, t: "meta", runId: "cam-run" },
    { ts: T0 + 1_000, t: "response", message: { role: "assistant", content: "## Plan\nHead to the **wolves** east of the abbey and clear them for the quest." } },
    { ts: T0 + 2_000, t: "tool_result", name: "run_snippet", text: "Quest text the game wrote: Bring me 8 wolf pelts, brave hero." },
    { ts: T0 + 50_000, t: "tool_call", name: "mcp__wrathbench__write_scratchpad", args: { content: "# Pad\n- Level 6 is next; then the bandits by the mill." } },
    { ts: T0 + 90_000, t: "response", message: { role: "assistant", content: [{ type: "text", text: "Level six. Turning in at the abbey now." }] } },
  ];
  return `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
}

describe("captions", () => {
  test("only the model's own words: responses and pad lines, never a tool result", () => {
    const said = saidOf(trajectory());
    expect(said.map((s) => s.text)).toEqual(["Plan Head to the wolves east of the abbey and clear them for the quest.", "Level 6 is next; then the bandits by the mill.", "Level six. Turning in at the abbey now."]);
    expect(said.some((s) => /wolf pelts/.test(s.text))).toBe(false);
    expect(saidAt(said, T0)).toBe("");
    expect(saidAt(said, T0 + 60_000)).toBe("Level 6 is next; then the bandits by the mill.");
  });

  test("trimmed to about 120 characters on a word", () => {
    const long = "word ".repeat(60);
    const line = captionLine(long);
    expect(line.length).toBeLessThanOrEqual(120);
    expect(line.endsWith("…")).toBe(true);
  });
});

const HOUR = 3_600_000;

/** Interval frames every `everyMs` from `from` to `to` (inclusive), numbered on from `seq`. */
function intervals(from: number, to: number, everyMs: number, seq = 0): FrameLine[] {
  const out: FrameLine[] = [];
  for (let t = from; t <= to; t += everyMs) out.push({ seq, t: iso(t), file: frameFile(seq++), kind: "interval" });
  return out;
}

describe("the video's plan", () => {
  test("every frame in time order: intervals one video frame each, a burst thinned to its moment, the moment held", () => {
    const levelAt = T0 + 60_000;
    const shots = planShots(frameLines(levelAt), { intervalMs: 10_000 });
    const at = (s: Shot) => Date.parse(s.frame.t);
    // In order, and nothing taken twice.
    expect(shots.map(at)).toEqual([...shots.map(at)].sort((a, b) => a - b));
    // The burst's twelve seconds around the moment whole: 8 s before to 4 s after, at the capture's 1 fps.
    const dense = shots.filter((s) => at(s) >= levelAt - 8_000 && at(s) <= levelAt + 4_000);
    expect(dense.length).toBe(13);
    // One chapter, opening the window; the moment held a second.
    const chapters = shots.filter((s) => s.chapter !== undefined);
    expect(chapters.length).toBe(1);
    expect(at(chapters[0]!)).toBe(levelAt - 8_000);
    expect(chapters[0]!.chapter).toEqual({ event: { type: "level", detail: "reached level 6" }, moment: levelAt });
    const held = shots.filter((s) => s.ticks > 1);
    expect(held.map((s) => [at(s), s.ticks])).toEqual([[levelAt, 1 + HOLD_TICKS]]);
    // Outside the window, the burst's frames are thinned like interval frames: about one per interval.
    const lead = shots.filter((s) => at(s) >= levelAt - 30_000 && at(s) < levelAt - 8_000);
    expect(lead.length).toBeLessThanOrEqual(3);
  });

  test("a death is a moment the video holds and no chapter lists; a boss kill is both", () => {
    const moment = T0 + 60_000;
    const said = saidOf(trajectory());
    const death = planShots(frameLines(moment, { type: "death", detail: "died" }), { intervalMs: 10_000 });
    // Shown as a level is: the window whole, the moment held, its detail on our own line.
    expect(death.filter((s) => s.ticks > 1).map((s) => s.ticks)).toEqual([1 + HOLD_TICKS]);
    const line = timelineOf(death, 0, 0, said, null);
    expect(line.details.map((d) => d.text)).toEqual(["died"]);
    expect(line.chapters).toEqual([]);
    const boss = timelineOf(planShots(frameLines(moment, { type: "boss", detail: "killed boss 644" }), { intervalMs: 10_000 }), 0, 0, said, null);
    expect(boss.chapters.map((c) => [c.type, c.detail])).toEqual([["boss", "killed boss 644"]]);
  });

  test("the frames of a run filmed before the rule: a turn-in's and a zone's bursts are frames like any other", () => {
    const moment = T0 + 60_000;
    for (const event of [{ type: "quest" as const, detail: "turned in quest 33" }, { type: "zone" as const, detail: "entered zone 12" }]) {
      const shots = planShots(frameLines(moment, event), { intervalMs: 10_000 });
      expect(shots.some((s) => s.chapter !== undefined || s.ticks > 1)).toBe(false);
      // Thinned to about one a capture interval, as if the camera had never burst.
      expect(shots.length).toBeLessThanOrEqual(14);
      const line = timelineOf(shots, 0, 0, [], null);
      expect(line.chapters).toEqual([]);
      expect(line.details).toEqual([]);
    }
  });

  test("start and end marks make no chapter", () => {
    const f = (seq: number, t: number, type?: "start" | "end"): FrameLine => ({ seq, t: iso(t), file: frameFile(seq), kind: type === undefined ? "interval" : "event", ...(type !== undefined ? { event: { type, detail: type } } : {}) });
    const shots = planShots([f(0, T0, "start"), f(1, T0 + 10_000), f(2, T0 + 20_000, "end")], { intervalMs: 10_000 });
    expect(shots.length).toBe(3);
    expect(shots.some((s) => s.chapter !== undefined || s.ticks > 1)).toBe(false);
  });

  test("parts of at most six hours of run time; a pause longer than that starts a new one", () => {
    // Fifteen hours of play, a frame every ten minutes.
    const long = splitParts(planShots(intervals(T0, T0 + 15 * HOUR, 600_000), { intervalMs: 600_000 }));
    expect(long.map((p) => [p[0]!.frame.t, p.at(-1)!.frame.t])).toEqual([
      [iso(T0), iso(T0 + 6 * HOUR)],
      [iso(T0 + 6 * HOUR + 600_000), iso(T0 + 12 * HOUR + 600_000)],
      [iso(T0 + 12 * HOUR + 1_200_000), iso(T0 + 15 * HOUR)],
    ]);
    for (const p of long) expect(Date.parse(p.at(-1)!.frame.t) - Date.parse(p[0]!.frame.t)).toBeLessThanOrEqual(PART_MS);
    // Two hours, two days paused, an hour more: two parts, and no empty one between.
    const frames = [...intervals(T0, T0 + 2 * HOUR, 600_000), ...intervals(T0 + 50 * HOUR, T0 + 51 * HOUR, 600_000, 100)];
    const paused = splitParts(planShots(frames, { intervalMs: 600_000 }));
    expect(paused.map((p) => p.length)).toEqual([13, 7]);
  });

  test("chapters, captions and the time map on the whole timeline, across parts", () => {
    const said = saidOf(trajectory());
    const levelAt = T0 + 60_000;
    const shots = planShots(frameLines(levelAt), { intervalMs: 10_000 });
    const seconds = shots.reduce((n, s) => n + s.ticks, 0) / VIDEO_FPS;
    // As the second part, 100 s into the video.
    const line = timelineOf(shots, 1, 100, said, null);
    expect(line.chapters.length).toBe(1);
    const ch = line.chapters[0]!;
    expect(ch.part).toBe(1);
    expect(ch.type).toBe("level");
    expect(ch.caption).toBe("Level 6 is next; then the bandits by the mill.");
    // The chapter's time is the part's offset plus the video before its first frame.
    const before = shots.slice(0, shots.findIndex((s) => s.chapter !== undefined)).reduce((n, s) => n + s.ticks, 0) / VIDEO_FPS;
    expect(ch.t).toBe(100 + before);
    // The time map: a point per frame shown, one more at the end of the hold, inside the part's span.
    expect(line.points.length).toBe(shots.length + 1);
    expect(line.points[0]).toEqual([100, T0]);
    expect(line.points.at(-1)![0]).toBeLessThan(100 + seconds);
    // The model's words, each when it changes, never game text; at least CAPTION_MIN_S apart, so
    // the last line, said with under a second of video left, is not shown.
    expect(line.captions.map((c) => c.text)).toEqual(["Plan Head to the wolves east of the abbey and clear them for the quest.", "Level 6 is next; then the bandits by the mill."]);
    for (let i = 1; i < line.captions.length; i++) expect(line.captions[i]!.t - line.captions[i - 1]!.t).toBeGreaterThanOrEqual(3);
    // A cue that carries over from the part before is not said again.
    expect(timelineOf(shots, 1, 100, said, { t: 99, text: "Plan Head to the wolves east of the abbey and clear them for the quest." }).captions[0]!.text).toBe("Level 6 is next; then the bandits by the mill.");
    // Our own line: the detail while the event shows, never the model's words.
    const ass = subtitlesOf(seconds, line.details, "DeepSeek V4");
    expect(ass).toContain("Hud,,0,0,0,,WrathBench · DeepSeek V4");
    expect(ass).toContain(",Ev,,0,0,0,,reached level 6");
    expect(ass).not.toContain("bandits");
    expect(ass).not.toContain("wolf pelts");
    const list = concatListOf(shots, "/runs/x/camera");
    expect(list.split("\n").filter((l) => l.startsWith("file ")).length).toBe(shots.length + 1);
    expect(list).toContain(`duration ${((1 + HOLD_TICKS) / VIDEO_FPS).toFixed(4)}`);
  });

  test("the time map compacts a steady stretch to its ends and keeps a hold and a pause", () => {
    const steady: [number, number][] = Array.from({ length: 100 }, (_, i) => [i / 8, T0 + i * 10_000 + (i % 2) * 500]);
    expect(compactTimemap(steady)).toEqual([steady[0]!, steady[99]!]);
    // A hold (run time stands while video runs), then a two-day pause.
    const shaped: [number, number][] = [[0, T0], [1, T0 + 10_000], [2, T0 + 20_000], [3, T0 + 20_000], [3.125, T0 + 30_000], [3.25, T0 + 2 * 86_400_000], [3.375, T0 + 2 * 86_400_000 + 10_000]];
    const c = compactTimemap(shaped);
    expect(c).toContainEqual([2, T0 + 20_000]);
    expect(c).toContainEqual([3, T0 + 20_000]);
    expect(c).toContainEqual([3.125, T0 + 30_000]);
    expect(c).toContainEqual([3.25, T0 + 2 * 86_400_000]);
    // Every point dropped is within the tolerance of the line kept.
    expect(c.length).toBeLessThan(shaped.length);
  });
});

/** A run whose frames are tiny stand-in files: the stub ffmpeg never reads them. */
function stubRun(dir: string, frames: FrameLine[]): void {
  const cam = join(dir, "camera");
  mkdirSync(join(cam, "frames"), { recursive: true });
  if (!existsSync(join(dir, "meta.json"))) writeFileSync(join(dir, "meta.json"), `${JSON.stringify({ runId: "cam-run", config: { model: "deepseek/deepseek-v4" } })}\n`);
  for (const f of frames) writeFileSync(join(cam, f.file), "x");
  appendFileSync(join(cam, "frames.jsonl"), frames.map((f) => `${JSON.stringify(f)}\n`).join(""));
}

/** An ffmpeg that writes one byte to its output and logs the part it was asked for. */
function stubFfmpeg(root: string): { bin: string; calls: () => string[]; reset: () => void } {
  const bin = join(root, "ffmpeg-stub");
  const log = join(root, "ffmpeg.log");
  writeFileSync(bin, `#!/bin/sh\nfor a; do last="$a"; done\nprintf x > "$last"\nbasename "$last" >> '${log}'\n`);
  chmodSync(bin, 0o755);
  writeFileSync(log, "");
  return { bin, calls: () => readFileSync(log, "utf8").split("\n").filter((l) => l !== ""), reset: () => writeFileSync(log, "") };
}

describe("parts", () => {
  test("a closed part is never encoded again: its file, poster, chapters, captions and time map stand as they were", () => {
    const root = tmp("camera-parts-");
    const dir = join(root, "cam-run");
    const ff = stubFfmpeg(root);
    const cam = join(dir, "camera");
    // Thirteen hours of play, a frame a minute, a level at 3 h.
    const first = intervals(T0, T0 + 13 * HOUR, 60_000);
    const lv = first.findIndex((f) => Date.parse(f.t) === T0 + 3 * HOUR);
    Object.assign(first[lv]!, { kind: "event", event: { type: "level", detail: "reached level 9" } });
    stubRun(dir, first);
    // An older layout's clips go with the first assembly.
    mkdirSync(join(cam, "clips"), { recursive: true });
    writeFileSync(join(cam, "clips", "timelapse.mp4"), "old");
    writeFileSync(join(cam, "clips.json"), JSON.stringify({ version: 1, runId: "cam-run", clips: [] }));
    const a = assembleRun(dir, { intervalMs: 60_000, ffmpeg: ff.bin })!;
    expect(a.version).toBe(2);
    expect(a.parts.map((p) => p.file)).toEqual(["clips/part-000.mp4", "clips/part-001.mp4", "clips/part-002.mp4"]);
    expect(ff.calls()).toEqual(["0.mp4", "1.mp4", "2.mp4"]);
    expect(readdirSync(join(cam, "clips")).sort()).toEqual(["part-000.jpg", "part-000.mp4", "part-001.jpg", "part-001.mp4", "part-002.jpg", "part-002.mp4"]);
    expect(a.chapters).toEqual([expect.objectContaining({ part: 0, type: "level", detail: "reached level 9" })]);
    const stamp = (f: string) => {
      const st = statSync(join(cam, f));
      return [st.ino, st.mtimeMs];
    };
    const closed = a.parts.slice(0, 2).flatMap((p) => [p.file, p.poster]);
    const before = closed.map(stamp);

    // An hour more, and the closed parts' frames pruned: only the open part is encoded again.
    ff.reset();
    stubRun(dir, intervals(T0 + 13 * HOUR + 60_000, T0 + 14 * HOUR, 60_000, first.length));
    for (const f of first.filter((f) => Date.parse(f.t) < Date.parse(a.parts[2]!.from))) rmSync(join(cam, f.file));
    const b = assembleRun(dir, { intervalMs: 60_000, ffmpeg: ff.bin })!;
    expect(ff.calls()).toEqual(["2.mp4"]);
    expect(closed.map(stamp)).toEqual(before);
    expect(b.parts.slice(0, 2)).toEqual(a.parts.slice(0, 2));
    expect(b.chapters).toEqual(a.chapters);
    expect(b.parts[2]!.from).toBe(a.parts[2]!.from);
    expect(b.parts[2]!.to).toBe(iso(T0 + 14 * HOUR));
    expect(b.timemap.filter((p) => p[0] < a.parts[0]!.seconds + a.parts[1]!.seconds)).toEqual(a.timemap.filter((p) => p[0] < a.parts[0]!.seconds + a.parts[1]!.seconds));
    expect(b.captions).toEqual(a.captions);

    // Past six hours of the open part: it is encoded a last time, closed, and a new one opens.
    ff.reset();
    const more = intervals(T0 + 14 * HOUR + 60_000, T0 + 19 * HOUR, 60_000, first.length + 60);
    stubRun(dir, more);
    const c = assembleRun(dir, { intervalMs: 60_000, ffmpeg: ff.bin })!;
    expect(ff.calls()).toEqual(["2.mp4", "3.mp4"]);
    expect(c.parts.length).toBe(4);
    ff.reset();
    stubRun(dir, intervals(T0 + 19 * HOUR + 60_000, T0 + 19 * HOUR + 60_000, 60_000, first.length + 60 + more.length));
    assembleRun(dir, { intervalMs: 60_000, ffmpeg: ff.bin });
    expect(ff.calls()).toEqual(["3.mp4"]);
  });

  test("a part that will not encode ends the video there, and the list names only what is on disk", () => {
    const root = tmp("camera-parts-fail-");
    const dir = join(root, "cam-run");
    const bin = join(root, "ffmpeg-fail");
    writeFileSync(bin, "#!/bin/sh\nexit 1\n");
    chmodSync(bin, 0o755);
    stubRun(dir, intervals(T0, T0 + HOUR, 60_000));
    expect(assembleRun(dir, { intervalMs: 60_000, ffmpeg: bin })).toBeNull();
    expect(existsSync(join(dir, "camera", CLIPS_FILE))).toBe(false);
  });
});

function makeRun(dir: string, frames: FrameLine[]): void {
  const cam = join(dir, "camera");
  mkdirSync(join(cam, "frames"), { recursive: true });
  writeFileSync(join(dir, "meta.json"), `${JSON.stringify({ runId: "cam-run", startedAt: T0 - 5_000, config: { model: "deepseek/deepseek-v4", character: "Testwick" } }, null, 2)}\n`);
  writeFileSync(join(dir, "trajectory.jsonl"), trajectory());
  // testsrc, one still per frame, at the camera's size: a counter shows each frame's number.
  const r = Bun.spawnSync([ffmpeg!, "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `testsrc=size=1280x720:rate=1:duration=${frames.length}`, "-q:v", "5", join(cam, "frames", "%06d.jpg")], { stdout: "pipe", stderr: "pipe" });
  expect(r.exitCode, r.stderr.toString()).toBe(0);
  // ffmpeg numbers from 1; the layout numbers from 0.
  for (let i = frames.length; i >= 1; i--) {
    const from = join(cam, "frames", `${String(i).padStart(6, "0")}.jpg`);
    writeFileSync(join(cam, frameFile(i - 1)), readFileSync(from));
  }
  writeFileSync(join(cam, "frames.jsonl"), frames.map((f) => `${JSON.stringify(f)}\n`).join(""));
}

function probe(path: string): { codec: string; pix: string; w: number; h: number; streams: number; frames: number; seconds: number } {
  const r = Bun.spawnSync([ffprobe!, "-v", "error", "-count_frames", "-show_entries", "stream=codec_type,codec_name,pix_fmt,width,height,nb_read_frames:format=duration", "-of", "json", path], { stdout: "pipe" });
  const j = JSON.parse(r.stdout.toString()) as { streams: { codec_name: string; pix_fmt: string; width: number; height: number; nb_read_frames: string }[]; format: { duration: string } };
  const v = j.streams[0]!;
  return { codec: v.codec_name, pix: v.pix_fmt, w: v.width, h: v.height, streams: j.streams.length, frames: Number(v.nb_read_frames), seconds: Number(j.format.duration) };
}

describe.skipIf(ffmpeg === null || ffprobe === null)("assembly with ffmpeg", () => {
  test(
    "the video per the layout: H.264, yuv420p, 1280×720, silent, faststart, exactly as long as its time map says",
    () => {
      const dir = join(tmp("camera-assemble-"), "cam-run");
      const levelAt = T0 + 60_000;
      const frames = frameLines(levelAt);
      makeRun(dir, frames);
      expect(parseFrames(readFileSync(join(dir, "camera", "frames.jsonl"), "utf8")).length).toBe(frames.length);
      const doc = assembleRun(dir, { intervalMs: 10_000 })!;
      const onDisk = JSON.parse(readFileSync(join(dir, "camera", CLIPS_FILE), "utf8")) as ClipsFile;
      expect(onDisk).toEqual(doc);
      expect(doc.version).toBe(2);
      expect(doc.runId).toBe("cam-run");
      expect(doc.parts.length).toBe(1);
      const part = doc.parts[0]!;
      expect([part.file, part.poster]).toEqual(["clips/part-000.mp4", "clips/part-000.jpg"]);
      expect(part.from).toBe(iso(T0));
      expect(part.to).toBe(frames.at(-1)!.t);
      const shots = planShots(frames, { intervalMs: 10_000 });
      const ticks = shots.reduce((n, s) => n + s.ticks, 0);
      expect(part.seconds).toBe(ticks / VIDEO_FPS);
      const p = probe(join(dir, "camera", part.file));
      expect([p.codec, p.pix, p.w, p.h, p.streams]).toEqual(["h264", "yuv420p", 1280, 720, 1]);
      // Every frame on screen for whole video frames: the encode is exactly the plan.
      expect(p.frames).toBe(ticks);
      expect(Math.abs(p.seconds - part.seconds)).toBeLessThan(0.05);
      // faststart: the index (moov) precedes the media (mdat).
      const head = readFileSync(join(dir, "camera", part.file)).subarray(0, 4096).toString("latin1");
      expect(head.indexOf("moov")).toBeGreaterThan(-1);
      expect(head.indexOf("moov")).toBeLessThan(head.indexOf("mdat") === -1 ? Infinity : head.indexOf("mdat"));
      expect(existsSync(join(dir, "camera", part.poster))).toBe(true);
      expect(doc.chapters).toEqual([expect.objectContaining({ part: 0, type: "level", detail: "reached level 6", caption: "Level 6 is next; then the bandits by the mill." })]);
      expect(doc.timemap[0]).toEqual([0, T0]);
      expect(existsSync(join(dir, "camera", ".work"))).toBe(false);
      // Idempotent: a second pass makes the same list.
      expect(assembleRun(dir, { intervalMs: 10_000 })).toEqual(doc);
    },
    ENCODE_MS,
  );
});

describe("the camera label", () => {
  test("written beside the run's own fields, and held", async () => {
    const dir = tmp("camera-label-");
    writeFileSync(join(dir, "meta.json"), `${JSON.stringify({ runId: "r", config: { model: "m" }, termination: { reason: "completed" } }, null, 2)}\n`);
    expect(hasCameraLabel(dir)).toBe(false);
    expect(await labelRun(dir, { settleMs: 0, sleep: async () => {} })).toBe(true);
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as Record<string, unknown>;
    expect(meta).toEqual({ runId: "r", config: { model: "m" }, termination: { reason: "completed" }, camera: true });
  });

  test("no meta.json, no label", () => {
    expect(writeCameraLabel(tmp("camera-label-none-"))).toBe(false);
  });
});
