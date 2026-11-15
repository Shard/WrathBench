/**
 * Clip assembly (infra/camera/assemble.ts), captions (camera/captions.ts) and
 * the run label (camera/label.ts). The frames are ffmpeg `testsrc` images made
 * in a temp directory: no game image is ever in git. The encode needs ffmpeg
 * and ffprobe on PATH; CI installs them (.github/workflows/ci.yml).
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "./temp-dirs";
import { assembleRun, concatListOf, planClips, subtitlesOf } from "./camera/assemble";
import { captionLine, clipCaption, saidAt, saidOf } from "./camera/captions";
import { hasCameraLabel, labelRun, writeCameraLabel } from "./camera/label";
import { CLIPS_FILE, frameFile, parseFrames, type ClipsFile, type FrameLine } from "./camera/layout";

const tmp = tempDirs();
const ffmpeg = Bun.which("ffmpeg");
const ffprobe = Bun.which("ffprobe");
const ENCODE_MS = 60_000;

const T0 = Date.parse("2026-11-15T10:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

/** A 1 fps capture's kept frames: interval every 10 s, and a level-up burst 30 s before to 10 s after. */
function frameLines(levelAt: number): FrameLine[] {
  const out: FrameLine[] = [];
  let seq = 0;
  let last = -Infinity;
  for (let t = T0; t <= T0 + 120_000; t += 1000) {
    const inBurst = t >= levelAt - 30_000 && t <= levelAt + 10_000;
    if (inBurst) out.push({ seq, t: iso(t), file: frameFile(seq++), kind: "event", event: { type: "level", detail: "reached level 6" } });
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
    expect(clipCaption("Onward.", "DeepSeek V4")).toBe("“Onward.” — DeepSeek V4 · WrathBench");
    expect(clipCaption("", "DeepSeek V4")).toBe("DeepSeek V4 · WrathBench");
  });
});

describe("clip planning", () => {
  test("a timelapse of one frame per interval, and one clip for the burst", () => {
    const levelAt = T0 + 60_000;
    const plans = planClips(frameLines(levelAt), { intervalMs: 10_000 });
    expect(plans.map((p) => [p.name, p.kind, p.frames.length])).toEqual([
      ["timelapse", "timelapse", 14],
      ["event-3-level", "event", 41],
    ]);
    const ev = plans[1]!;
    expect(ev.fps).toBe(4);
    expect(Date.parse(ev.poster.t)).toBe(levelAt);
    const said = saidOf(trajectory());
    const ass = subtitlesOf(ev, said, "DeepSeek V4");
    expect(ass).toContain("Hud,,0,0,0,,WrathBench · DeepSeek V4 · reached level 6");
    expect(ass).toContain("Level 6 is next; then the bandits by the mill.");
    expect(ass).not.toContain("wolf pelts");
    const list = concatListOf(ev, "/runs/x/camera");
    expect(list.split("\n").filter((l) => l.startsWith("file ")).length).toBe(42);
  });

  test("start and end marks and short bursts make no clip", () => {
    const f = (seq: number, t: number, type?: "start" | "death"): FrameLine => ({ seq, t: iso(t), file: frameFile(seq), kind: type === undefined ? "interval" : "event", ...(type !== undefined ? { event: { type, detail: type } } : {}) });
    const plans = planClips([f(0, T0, "start"), f(1, T0 + 1000, "death"), f(2, T0 + 2000, "death"), f(3, T0 + 12_000)], { intervalMs: 10_000 });
    expect(plans.map((p) => p.name)).toEqual(["timelapse"]);
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

function probe(path: string): { codec: string; pix: string; w: number; h: number; streams: number } {
  const r = Bun.spawnSync([ffprobe!, "-v", "error", "-show_entries", "stream=codec_type,codec_name,pix_fmt,width,height", "-of", "json", path], { stdout: "pipe" });
  const j = JSON.parse(r.stdout.toString()) as { streams: { codec_name: string; pix_fmt: string; width: number; height: number }[] };
  const v = j.streams[0]!;
  return { codec: v.codec_name, pix: v.pix_fmt, w: v.width, h: v.height, streams: j.streams.length };
}

describe.skipIf(ffmpeg === null || ffprobe === null)("assembly with ffmpeg", () => {
  test(
    "clips per the layout: H.264, yuv420p, 1280×720, silent, faststart, a poster each, clips.json last",
    () => {
      const dir = join(tmp("camera-assemble-"), "cam-run");
      const levelAt = T0 + 60_000;
      const frames = frameLines(levelAt);
      makeRun(dir, frames);
      expect(parseFrames(readFileSync(join(dir, "camera", "frames.jsonl"), "utf8")).length).toBe(frames.length);
      const doc = assembleRun(dir, { intervalMs: 10_000 })!;
      const onDisk = JSON.parse(readFileSync(join(dir, "camera", CLIPS_FILE), "utf8")) as ClipsFile;
      expect(onDisk).toEqual(doc);
      expect(doc.version).toBe(1);
      expect(doc.runId).toBe("cam-run");
      expect(doc.clips.map((c) => [c.name, c.kind, c.file, c.poster])).toEqual([
        ["timelapse", "timelapse", "clips/timelapse.mp4", "clips/timelapse.jpg"],
        ["event-3-level", "event", "clips/event-3-level.mp4", "clips/event-3-level.jpg"],
      ]);
      const ev = doc.clips[1]!;
      expect(ev.event).toEqual({ type: "level", detail: "reached level 6" });
      expect(ev.from).toBe(iso(levelAt - 30_000));
      expect(ev.to).toBe(iso(levelAt + 10_000));
      expect(ev.seconds).toBe(11.8);
      expect(ev.caption.startsWith("“Level 6 is next; then the bandits by the mill.” — ")).toBe(true);
      expect(ev.caption.endsWith(" · WrathBench")).toBe(true);
      expect(doc.clips[0]!.caption.startsWith("“Level six. Turning in at the abbey now.” — ")).toBe(true);
      for (const c of doc.clips) {
        const path = join(dir, "camera", c.file);
        expect(probe(path)).toEqual({ codec: "h264", pix: "yuv420p", w: 1280, h: 720, streams: 1 });
        // faststart: the index (moov) precedes the media (mdat).
        const head = readFileSync(path).subarray(0, 4096).toString("latin1");
        expect(head.indexOf("moov")).toBeGreaterThan(-1);
        expect(head.indexOf("moov")).toBeLessThan(head.indexOf("mdat") === -1 ? Infinity : head.indexOf("mdat"));
        expect(existsSync(join(dir, "camera", c.poster))).toBe(true);
      }
      expect(existsSync(join(dir, "camera", ".work"))).toBe(false);
      // Idempotent: a second pass rebuilds the same list.
      expect(assembleRun(dir, { intervalMs: 10_000 })!.clips.map((c) => c.name)).toEqual(doc.clips.map((c) => c.name));
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
