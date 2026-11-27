/**
 * The camera's video from the run directory to the bucket, over the dashboard rig's
 * own fixture (`infra/shots/fixture.ts`): the ended run has a camera, and so
 * does the scripted reference run, which is never published. Synthetic media
 * only (ffmpeg's `testsrc`, `runner/test/fixtures/camera/`).
 *
 * What is pinned is exposure: a withheld run publishes no part and no list, the
 * live frames never leave the private viewer, and a published run's parts go
 * up whole, named by a projected `clips.json`, exactly once.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApi } from "../viewer/api";
import type { ClipsResponse, HighlightResponse, RunsResponse } from "../viewer/api-types";
import { createRenderer, type SnapshotResult } from "../viewer/snapshot";
import { classifyPath, emptyState, planPrune, planWithdraw, publishPass, type ObjectStore, type PublishState } from "./publish-core";
import { reprojectionFindings, scanBody, verifyPublication } from "./publish-accept";
import { ENDED_RUN, LIVE_RUN, REFERENCE_RUN, writeFixture } from "./shots/fixture";
import { tempDirs } from "./temp-dirs";

const tempDir = tempDirs();
const MP4 = readFileSync(join(import.meta.dir, "..", "runner", "test", "fixtures", "camera", "clip.mp4"));

/** A bucket in memory: bodies as bytes, every PUT recorded. */
function bucket(): { objects: Map<string, Buffer>; puts: string[]; store: ObjectStore } {
  const objects = new Map<string, Buffer>();
  const puts: string[] = [];
  return {
    objects,
    puts,
    store: {
      put: async (path, body) => {
        puts.push(path);
        objects.set(path, typeof body === "string" ? Buffer.from(body) : Buffer.from(await body.arrayBuffer()));
      },
      delete: async (path) => void objects.delete(path),
    },
  };
}

/** One fixture for the file: no test here writes to it. */
let runsDir = "";
beforeAll(async () => {
  delete process.env["CLICKHOUSE_URL"];
  runsDir = tempDir("wb-camera-replay-");
  const f = writeFixture(runsDir, Date.now());
  await f.ready;
  f.close();
}, 60_000);

const api = (dir: string, publicMode: boolean): ((req: Request) => Promise<Response>) =>
  createApi({ runsDir: dir, tilesDir: join(dir, "no-tiles"), publicMode, moduleUrl: "http://127.0.0.1:1", configDbPath: join(dir, "none.sqlite") } as Parameters<typeof createApi>[0]);

const json = <T>(b: Buffer | undefined): T => JSON.parse(b!.toString("utf8")) as T;

describe("the camera's video, viewer to bucket", () => {
  test("a withheld run's parts and the live frames are served only by a private handle", async () => {
    const priv = api(runsDir, false);
    const pub = api(runsDir, true);
    // The live run is one the public handle publishes; its frames are the private viewer's alone.
    expect((await pub(new Request(`http://x/api/run/${LIVE_RUN}`))).status).toBe(200);
    for (const path of [
      `/api/run/${REFERENCE_RUN}/clips`,
      `/api/run/${REFERENCE_RUN}/clip/part-000.mp4`,
      `/api/run/${LIVE_RUN}/camera/latest`,
      `/api/run/${LIVE_RUN}/camera/latest.jpg`,
    ]) {
      expect((await priv(new Request(`http://x${path}`))).status, path).toBe(200);
      expect((await pub(new Request(`http://x${path}`))).status, path).toBe(404);
    }
    const h = (await (await pub(new Request("http://x/api/highlight"))).json()) as HighlightResponse;
    expect(h.highlight?.runId).toBe(ENDED_RUN);
    // The public handle's list is projected: its media are the viewer's routes.
    const c = (await (await pub(new Request(`http://x/api/run/${ENDED_RUN}/clips`))).json()) as ClipsResponse;
    expect(c.parts.map((x) => x.video)).toEqual([`/api/run/${ENDED_RUN}/clip/part-000.mp4`, `/api/run/${ENDED_RUN}/clip/part-001.mp4`]);
  }, 60_000);

  test("a pass publishes a run's parts named by its clips.json, nothing of a withheld run or the live frames, and a second pass uploads no part again", async () => {
    const render = createRenderer({ runsDir, configDbPath: join(runsDir, "none.sqlite") });
    const b = bucket();
    const state: PublishState = emptyState();
    let result: SnapshotResult | undefined;
    await publishPass(async (sink, published) => (result = await render(undefined, { sink, batch: 3 }, published)), b.store, state);
    expect(result?.gen).not.toBe("");

    const keys = [...b.objects.keys()];
    // Nothing of the reference run, by key or in any body, and no live frame or its route.
    expect(keys.filter((k) => k.includes(REFERENCE_RUN))).toEqual([]);
    expect(keys.some((k) => k.includes(LIVE_RUN))).toBe(true);
    expect(keys.filter((k) => k.includes("frame") || k.includes("latest") || k.includes("camera"))).toEqual([]);
    for (const [k, v] of b.objects) {
      if (!k.endsWith(".json")) continue;
      const body = v.toString("utf8");
      for (const word of [REFERENCE_RUN, "camera/latest", "frames.jsonl", "frames/"]) expect(body, `${k}: ${word}`).not.toContain(word);
    }

    const manifest = json<{ artifacts: Record<string, string> }>(b.objects.get("v1/manifest.json"));
    const runs = json<RunsResponse>(b.objects.get(manifest.artifacts["runs.json"]!));
    const row = runs.runs.find((r) => r.runId === ENDED_RUN)!;
    // Only the run with a camera names a clip list.
    expect(runs.runs.filter((r) => r.snapshot?.clips !== undefined).map((r) => r.runId)).toEqual([ENDED_RUN]);
    const clips = json<ClipsResponse>(b.objects.get(row.snapshot!.clips!));
    expect(clips.parts.map((c) => c.name)).toEqual(["part-000", "part-001"]);
    for (const c of clips.parts) {
      expect(classifyPath(c.video)).toMatchObject({ kind: "clip", runId: ENDED_RUN });
      expect(b.objects.get(c.video)!.equals(MP4)).toBe(true);
      expect(b.objects.has(c.poster!)).toBe(true);
    }
    // The published list and the home page's excerpt are fixed points of their projection, with no finding.
    for (const key of [row.snapshot!.clips!, manifest.artifacts["highlight.json"]!]) {
      const body = json<Record<string, unknown>>(b.objects.get(key));
      expect(reprojectionFindings(key, body)).toEqual([]);
      expect(scanBody(key, body).findings).toEqual([]);
    }

    // The bucket's verifier walks it clean, clip files included.
    const report = await verifyPublication({
      get: async (k) => b.objects.get(k)?.toString("utf8") ?? null,
      head: async (k) => (b.objects.has(k) ? { size: b.objects.get(k)!.length } : null),
    });
    expect(report.missing).toEqual([]);
    expect(report.findings.filter((f) => f.key.includes("clip"))).toEqual([]);

    // Idempotent: a second pass over the same files uploads no part again.
    b.puts.length = 0;
    await publishPass(async (sink, published) => await render(undefined, { sink, batch: 3 }, published), b.store, state);
    expect(b.puts.filter((k) => classifyPath(k).kind === "clip")).toEqual([]);
  }, 60_000);
});

describe("the engine's clip keys", () => {
  const key = (run: string, name: string, hash: string, ext = "mp4"): string => `v1/run/${run}/clip/${name}-${hash}.${ext}`;

  test("are withdrawn with their run, and pruned only outside their slot's keep window", () => {
    const state = emptyState();
    const keep = key("r1", "part-000", "bbbbbbbbbbbb");
    const old = key("r1", "part-000", "aaaaaaaaaaaa");
    const orphan = key("r1", "event-1-level", "cccccccccccc");
    for (const k of [keep, old, orphan, key("r2", "part-000", "dddddddddddd")]) state.uploaded[k] = "h";
    state.clipVersions = { "r1/part-000.mp4": ["bbbbbbbbbbbb"], "r2/part-000.mp4": ["dddddddddddd"] };
    expect(planPrune(state)).toEqual([old, orphan].sort());
    expect(planWithdraw(state, ["r2"])).toEqual([key("r2", "part-000", "dddddddddddd")]);
    expect(state.clipVersions["r2/part-000.mp4"]).toBeUndefined();
  });

  test("a clip file that moved since it was hashed is not uploaded, and the pass does not flip", async () => {
    const dir = tempDir("wb-camera-moved-");
    const file = join(dir, "part-000.mp4");
    writeFileSync(file, MP4);
    const st = statSync(file);
    utimesSync(file, new Date(), new Date(st.mtimeMs + 5_000));
    const b = bucket();
    const state = emptyState();
    const result: SnapshotResult = {
      gen: "g",
      snap: {},
      artifacts: [{ path: "v1/manifest.json", body: "{}", contentType: "application/json", cacheControl: "x" }],
      withdrawn: [],
      media: [{ path: key("r1", "part-000", "0123456789ab"), file, hash: "h", size: st.size, mtimeMs: st.mtimeMs, contentType: "video/mp4", cacheControl: "x" }],
    };
    await expect(publishPass(async () => result, b.store, state)).rejects.toThrow(/changed since it was hashed/);
    expect(b.puts).toEqual([]);
    expect(state.lastGen).toBeUndefined();
  });
});
