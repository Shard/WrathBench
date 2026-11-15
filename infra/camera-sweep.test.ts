/**
 * The camera's sweep (infra/camera/sweep.ts) over a runs tree: runs a camera
 * no longer follows are labelled and assembled, live ones are left alone,
 * frames are pruned only past the window and only once the clips are up to
 * date, and a pruned run is never assembled again.
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
  if (o.clipsAfterIndex) {
    writeFileSync(join(dir, "camera", "clips.json"), "{}");
    utimesSync(join(dir, "camera", "clips.json"), t + 1, t + 1);
  }
  return dir;
}

describe("the camera sweep", () => {
  test("labels and assembles a run no one owns; leaves a live run alone", () => {
    const runs = tmp("camera-sweep-");
    const ended = run(runs, "r-ended", { ended: true });
    const live = run(runs, "r-live", { live: true });
    const seen: string[] = [];
    const r = sweepCameraRuns(runs, NOW, { intervalMs: 10_000, assemble: (d) => (seen.push(d), { version: 1, runId: "x", clips: [] } as ClipsFile) });
    expect(r.assembled).toEqual(["r-ended"]);
    expect(r.labelled).toEqual(["r-ended"]);
    expect(seen).toEqual([ended]);
    expect(JSON.parse(readFileSync(join(ended, "meta.json"), "utf8")).camera).toBe(true);
    expect(JSON.parse(readFileSync(join(live, "meta.json"), "utf8")).camera).toBeUndefined();
  });

  test("prunes frames past three days once the clips are up to date, and never assembles a pruned run again", () => {
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
});
