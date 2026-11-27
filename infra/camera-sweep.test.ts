/**
 * The camera's sweep (infra/camera/sweep.ts) over a runs tree, held to what
 * would lose something: a live or paused run's meta.json is never written,
 * and frames are pruned only once the video covers them, never the open
 * part's before the run has ended.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "./temp-dirs";
import { sweepCameraRuns } from "./camera/sweep";
import type { ClipsFile } from "./camera/layout";

const tmp = tempDirs();
const NOW = Date.parse("2026-11-20T00:00:00Z");
const DAY = 86_400_000;

/** A version-2 clips.json whose one part, the open one, starts at `openFrom`. */
function doc(openFrom: number): ClipsFile {
  return { version: 2, runId: "r", parts: [{ file: "clips/part-000.mp4", poster: "clips/part-000.jpg", from: new Date(openFrom).toISOString(), to: new Date(openFrom).toISOString(), seconds: 1 }], chapters: [], captions: [], timemap: [] };
}

function writeDoc(dir: string, at: number, openFrom: number = 0): void {
  writeFileSync(join(dir, "camera", "clips.json"), JSON.stringify(doc(openFrom)));
  utimesSync(join(dir, "camera", "clips.json"), at / 1000, at / 1000);
}

function run(runsDir: string, id: string, o: { live?: boolean; ended?: boolean; framesAgeMs?: number; clipsAfterIndex?: boolean }) {
  const dir = join(runsDir, id);
  mkdirSync(join(dir, "camera", "frames"), { recursive: true });
  writeFileSync(join(dir, "meta.json"), `${JSON.stringify({ runId: id, config: {}, ...(o.ended ? { termination: { reason: "completed" } } : {}) }, null, 2)}\n`);
  writeFileSync(join(dir, "heartbeat"), "");
  const beat = o.live ? NOW / 1000 : (NOW - DAY) / 1000;
  utimesSync(join(dir, "heartbeat"), beat, beat);
  const t = (NOW - (o.framesAgeMs ?? 0)) / 1000;
  for (const f of ["000000.jpg", "000001.jpg"]) {
    writeFileSync(join(dir, "camera", "frames", f), "x");
    utimesSync(join(dir, "camera", "frames", f), t, t);
  }
  writeFileSync(join(dir, "camera", "frames.jsonl"), "");
  utimesSync(join(dir, "camera", "frames.jsonl"), t, t);
  if (o.clipsAfterIndex) writeDoc(dir, t * 1000 + 1000);
  return dir;
}

describe("the camera sweep", () => {
  test("a live run: its frames are assembled hourly and pruned once covered; its meta.json is never written", () => {
    const runs = tmp("camera-sweep-live-");
    const dir = run(runs, "r-live-long", { live: true, framesAgeMs: 4 * DAY });
    // Its video is older than an hour and than its index: due.
    const seen: string[] = [];
    const meta = readFileSync(join(dir, "meta.json"), "utf8");
    const r = sweepCameraRuns(runs, NOW, {
      intervalMs: 10_000,
      assemble: (d) => {
        seen.push(d);
        // The open part began after the frames: they are all a closed part's.
        writeDoc(d, NOW, NOW - DAY);
        return doc(NOW - DAY);
      },
    });
    expect(seen).toEqual([dir]);
    expect(r.prunedFrames).toBe(2);
    expect(readFileSync(join(dir, "meta.json"), "utf8")).toBe(meta);
    // Assembled minutes ago: not again yet.
    const again: string[] = [];
    writeFileSync(join(dir, "camera", "frames.jsonl"), "x");
    sweepCameraRuns(runs, NOW + 60_000, { intervalMs: 10_000, assemble: (d) => (again.push(d), null) });
    expect(again).toEqual([]);
  });

  test("a paused run is assembled but never labelled: it may be resumed at any moment", () => {
    const runs = tmp("camera-sweep-paused-");
    const dir = run(runs, "r-paused", {});
    const seen: string[] = [];
    const r = sweepCameraRuns(runs, NOW, { intervalMs: 10_000, assemble: (d) => (seen.push(d), null) });
    expect(seen).toEqual([dir]);
    expect(r.labelled).toEqual([]);
    expect(JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")).camera).toBeUndefined();
  });

  test("an ended run's frames go a day after the assembly that covers them; never assembled again", () => {
    const runs = tmp("camera-sweep-prune-");
    const old = run(runs, "r-old", { ended: true, framesAgeMs: 4 * DAY, clipsAfterIndex: true });
    run(runs, "r-recent", { ended: true, framesAgeMs: DAY, clipsAfterIndex: true });
    run(runs, "r-stale-clips", { ended: true, framesAgeMs: 4 * DAY });
    const seen: string[] = [];
    const r = sweepCameraRuns(runs, NOW, { intervalMs: 10_000, assemble: (d) => (seen.push(d), null) });
    expect(r.prunedFrames).toBe(2);
    expect(readdirSync(join(old, "camera", "frames"))).toEqual([]);
    // Clips older than the index: assembled, never pruned first.
    expect(seen.map((d) => d.split("/").at(-1))).toEqual(["r-stale-clips"]);
    const again: string[] = [];
    sweepCameraRuns(runs, NOW, { intervalMs: 10_000, assemble: (d) => (again.push(d.split("/").at(-1)!), null) });
    expect(again).not.toContain("r-old");
  });

  test("the open part's frames are never pruned before the run has ended: the next assembly encodes them again", () => {
    const runs = tmp("camera-sweep-open-");
    // Paused four days in, its one part still open: nothing goes.
    const paused = run(runs, "r-paused-open", { framesAgeMs: 4 * DAY });
    writeDoc(paused, NOW - 2 * DAY, NOW - 5 * DAY);
    // Live, its open part begun after these frames were taken: they go.
    const live = run(runs, "r-live-closed", { live: true, framesAgeMs: 4 * DAY });
    writeDoc(live, NOW - 30 * 60_000, NOW - 3 * DAY);
    const r = sweepCameraRuns(runs, NOW, { intervalMs: 10_000, assemble: () => null });
    expect(readdirSync(join(paused, "camera", "frames")).length).toBe(2);
    expect(readdirSync(join(live, "camera", "frames"))).toEqual([]);
    expect(r.prunedFrames).toBe(2);
  });
});
