/**
 * The camera's video from the run directory to the bucket, over the dashboard rig's
 * own fixture (`infra/shots/fixture.ts`): the ended run has a camera, and so
 * does the scripted reference run, which is never published. Synthetic media
 * only (ffmpeg's `testsrc`, `runner/test/fixtures/camera/`).
 *
 * What is pinned: a withheld run publishes no part and no list; a published
 * run's parts go up as their own objects at content-addressed keys under the
 * run, named by a projected `clips.json`; a second pass uploads none of them
 * again; the open part re-encoded gets a new key, the old one is pruned once
 * a second flip names the new, and the closed part keeps its key throughout;
 * a run without a camera keeps the keys it had.
 */
import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../viewer/api";
import type { ClipsResponse, HighlightResponse, RunsResponse } from "../viewer/api-types";
import { createRenderer, type SnapshotResult } from "../viewer/snapshot";
import { classifyPath, emptyState, needsPut, planPrune, planWithdraw, publishPass, type ObjectStore, type PublishState } from "./publish-core";
import { reprojectionFindings, scanBody, verifyPublication } from "./publish-accept";
import { ENDED_RUN, LIVE_RUN, REFERENCE_RUN, writeFixture } from "./shots/fixture";

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

async function fixture(now = Date.now()): Promise<string> {
  delete process.env["CLICKHOUSE_URL"];
  const runsDir = mkdtempSync(join(tmpdir(), "wb-camera-replay-"));
  const f = writeFixture(runsDir, now);
  await f.ready;
  f.close();
  return runsDir;
}

const api = (runsDir: string, publicMode: boolean): ((req: Request) => Promise<Response>) =>
  createApi({ runsDir, tilesDir: join(runsDir, "no-tiles"), publicMode, moduleUrl: "http://127.0.0.1:1", configDbPath: join(runsDir, "none.sqlite") } as Parameters<typeof createApi>[0]);

const json = <T>(b: Buffer | undefined): T => JSON.parse(b!.toString("utf8")) as T;

describe("the camera's video, viewer to bucket", () => {
  test("a run that is never published serves no part to a public handle, and gets no highlight", async () => {
    const runsDir = await fixture();
    const priv = api(runsDir, false);
    const pub = api(runsDir, true);
    for (const path of [`/api/run/${REFERENCE_RUN}/clips`, `/api/run/${REFERENCE_RUN}/clip/part-000.mp4`]) {
      expect((await priv(new Request(`http://x${path}`))).status, path).toBe(200);
      expect((await pub(new Request(`http://x${path}`))).status, path).toBe(404);
    }
    const h = (await (await pub(new Request("http://x/api/highlight"))).json()) as HighlightResponse;
    expect(h.highlight?.runId).toBe(ENDED_RUN);
    // The public handle's list is projected: its media are the viewer's routes.
    const c = (await (await pub(new Request(`http://x/api/run/${ENDED_RUN}/clips`))).json()) as ClipsResponse;
    expect(c.parts.map((x) => x.video)).toEqual([`/api/run/${ENDED_RUN}/clip/part-000.mp4`, `/api/run/${ENDED_RUN}/clip/part-001.mp4`]);
    // The fixture's list was cut before the chapter rule: its zone, turn-in and death are not served.
    expect(c.chapters.map((x) => x.type)).toEqual(["level", "boss"]);
  }, 60_000);

  test("a pass publishes a run's parts as their own objects, named by its clips.json, and a second pass uploads none again", async () => {
    const runsDir = await fixture();
    const render = createRenderer({ runsDir, configDbPath: join(runsDir, "none.sqlite") });
    const b = bucket();
    const state: PublishState = emptyState();
    let result: SnapshotResult | undefined;
    await publishPass(async (sink, published) => (result = await render(undefined, { sink, batch: 3 }, published)), b.store, state);

    const keys = [...b.objects.keys()];
    // Nothing of the reference run, by key or in any body.
    expect(keys.filter((k) => k.includes(REFERENCE_RUN))).toEqual([]);
    for (const [k, v] of b.objects) if (k.endsWith(".json")) expect(v.toString("utf8"), k).not.toContain(REFERENCE_RUN);
    // The frames never leave.
    expect(keys.filter((k) => k.includes("frames"))).toEqual([]);

    const runs = json<RunsResponse>(b.objects.get(json<{ artifacts: Record<string, string> }>(b.objects.get("v1/manifest.json")).artifacts["runs.json"]!));
    const row = runs.runs.find((r) => r.runId === ENDED_RUN)!;
    expect(row.snapshot?.clips).toMatch(new RegExp(`^v1/run/${ENDED_RUN}/[0-9a-f]{12}/clips\\.json$`));
    // Only the run with a camera names a clip list.
    expect(runs.runs.filter((r) => r.snapshot?.clips !== undefined).map((r) => r.runId)).toEqual([ENDED_RUN]);
    const clips = json<ClipsResponse>(b.objects.get(row.snapshot!.clips!));
    expect(clips.parts.map((c) => c.name)).toEqual(["part-000", "part-001"]);
    expect(clips.chapters).toHaveLength(2);
    expect(clips.timemap.length).toBeGreaterThan(1);
    for (const c of clips.parts) {
      expect(classifyPath(c.video)).toMatchObject({ kind: "clip", runId: ENDED_RUN });
      expect(b.objects.get(c.video)!.equals(MP4)).toBe(true);
      expect(b.objects.has(c.poster!)).toBe(true);
    }
    // The same file under two names is two objects, one per part.
    expect(new Set(clips.parts.map((c) => c.video)).size).toBe(2);
    // The published list is a fixed point of its projection, and its captions are the residual, not a finding.
    const body = json<Record<string, unknown>>(b.objects.get(row.snapshot!.clips!));
    expect(reprojectionFindings(row.snapshot!.clips!, body)).toEqual([]);
    expect(scanBody(row.snapshot!.clips!, body).findings).toEqual([]);
    // The home page's excerpt is published, around the newest chapter, and names the same objects.
    const highlightKey = json<{ artifacts: Record<string, string> }>(b.objects.get("v1/manifest.json")).artifacts["highlight.json"]!;
    const highlight = json<HighlightResponse>(b.objects.get(highlightKey));
    expect(highlight.highlight?.part.name).toBe("part-001");
    expect(highlight.highlight?.chapter?.type).toBe("boss");
    expect(highlight.highlight?.model).toBe("fixture/ended-model");
    expect(b.objects.has(highlight.highlight!.part.video)).toBe(true);
    expect(highlight.highlight!.part.video).toBe(clips.parts[1]!.video);
    expect(reprojectionFindings(highlightKey, json<Record<string, unknown>>(b.objects.get(highlightKey)))).toEqual([]);
    expect(scanBody(highlightKey, json<Record<string, unknown>>(b.objects.get(highlightKey))).findings).toEqual([]);
    expect(result?.gen).not.toBe("");

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

  test("the open part re-encoded goes up at a new key, its old file is pruned once a second flip names the new, and the closed part keeps its key", async () => {
    const runsDir = await fixture();
    const render = createRenderer({ runsDir, configDbPath: join(runsDir, "none.sqlite") });
    const b = bucket();
    const state = emptyState();
    const pass = async (): Promise<void> => {
      await publishPass(async (sink, published) => await render(undefined, { sink, batch: 4 }, published), b.store, state);
    };
    const keysOf = (name: string): string[] => [...b.objects.keys()].filter((k) => k.includes(`/clip/${name}-`) && k.endsWith(".mp4"));
    await pass();
    const closed = keysOf("part-000");
    const before = keysOf("part-001");
    expect(closed).toHaveLength(1);
    expect(before).toHaveLength(1);
    // The assembly re-encodes only the open part: a new file under its name.
    const file = join(runsDir, ENDED_RUN, "camera", "clips", "part-001.mp4");
    appendFileSync(file, Buffer.from([0, 0, 0, 8, 102, 114, 101, 101]));
    b.puts.length = 0;
    await pass();
    const after = keysOf("part-001");
    expect(after).toHaveLength(2);
    // Only the open part went up again; the closed part's key never moved.
    expect(b.puts.filter((k) => classifyPath(k).kind === "clip" && k.endsWith(".mp4"))).toEqual(after.filter((k) => k !== before[0]));
    expect(keysOf("part-000")).toEqual(closed);
    await pass();
    expect(keysOf("part-001")).toEqual(after.filter((k) => k !== before[0]));
    expect(keysOf("part-000")).toEqual(closed);
    expect(state.clipVersions?.[`${ENDED_RUN}/part-001.mp4`]).toHaveLength(1);
    expect(state.clipVersions?.[`${ENDED_RUN}/part-000.mp4`]).toEqual([closed[0]!.match(/-([0-9a-f]{12})\.mp4$/)![1]!]);
  }, 60_000);

  test("a run without a camera keeps the keys it had", async () => {
    const now = Date.now();
    const withCamera = await fixture(now);
    const without = await fixture(now);
    // The ended run without its camera, as it was before one followed it.
    rmSync(join(without, ENDED_RUN, "camera"), { recursive: true });
    const meta = join(without, ENDED_RUN, "meta.json");
    const { camera: _c, ...rest } = JSON.parse(readFileSync(meta, "utf8")) as Record<string, unknown>;
    writeFileSync(meta, JSON.stringify(rest));
    const pointers = async (runsDir: string): Promise<Map<string, unknown>> => {
      const r = await createRenderer({ runsDir, configDbPath: join(runsDir, "none.sqlite") })(now);
      const runsKey = r.snap["runs.json"]!;
      const runs = JSON.parse(r.artifacts.find((a) => a.path === runsKey)!.body) as RunsResponse;
      return new Map(runs.runs.map((x) => [x.runId, x.snapshot]));
    };
    const [a, b] = [await pointers(withCamera), await pointers(without)];
    for (const [id, snap] of b) {
      if (id === ENDED_RUN) {
        expect(a.get(id)).not.toEqual(snap);
        expect((snap as Record<string, unknown>)["clips"]).toBeUndefined();
      } else expect(a.get(id), id).toEqual(snap);
    }
  }, 60_000);
});

describe("the live camera frame", () => {
  /*
   * Live viewing is the private viewer's alone (operator, 2026-11-15): the
   * fixture's live run is published and has stills under `camera/frames/`, and
   * neither a public handle nor a publisher pass may carry one, or the route.
   */
  test("is served by a private handle, and by no public handle or publisher pass", async () => {
    const runsDir = await fixture();
    const frames = readFileSync(join(runsDir, LIVE_RUN, "camera", "frames.jsonl"), "utf8").trim().split("\n");
    expect(frames.length).toBeGreaterThan(0);
    const priv = api(runsDir, false);
    const pub = api(runsDir, true);
    // The live run is one the public handle publishes.
    expect((await pub(new Request(`http://x/api/run/${LIVE_RUN}`))).status).toBe(200);
    for (const path of [`/api/run/${LIVE_RUN}/camera/latest`, `/api/run/${LIVE_RUN}/camera/latest.jpg`]) {
      expect((await priv(new Request(`http://x${path}`))).status, path).toBe(200);
      expect((await pub(new Request(`http://x${path}`))).status, path).toBe(404);
    }

    const render = createRenderer({ runsDir, configDbPath: join(runsDir, "none.sqlite") });
    const b = bucket();
    await publishPass(async (sink, published) => await render(undefined, { sink, batch: 3 }, published), b.store, emptyState());
    const keys = [...b.objects.keys()];
    expect(keys.some((k) => k.includes(LIVE_RUN))).toBe(true);
    expect(keys.filter((k) => k.includes("frame") || k.includes("latest") || k.includes("camera"))).toEqual([]);
    for (const [k, v] of b.objects) {
      if (!k.endsWith(".json")) continue;
      const body = v.toString("utf8");
      for (const word of ["camera/latest", "frames.jsonl", "frames/"]) expect(body, `${k}: ${word}`).not.toContain(word);
    }
  }, 60_000);
});

describe("the engine's clip keys", () => {
  const key = (run: string, name: string, hash: string, ext = "mp4"): string => `v1/run/${run}/clip/${name}-${hash}.${ext}`;

  test("classify as clips, never as a run object at a version called `clip`", () => {
    expect(classifyPath(key("r1", "part-000", "0123456789ab"))).toEqual({ kind: "clip", runId: "r1", slot: "part-000.mp4", version: "0123456789ab" });
    expect(classifyPath("v1/run/r1/clip/whatever.json")).toEqual({ kind: "other" });
    const state = emptyState();
    expect(needsPut(key("r1", "part-000", "0123456789ab"), () => "", state, "")).toBe(true);
    state.uploaded[key("r1", "part-000", "0123456789ab")] = "h";
    expect(needsPut(key("r1", "part-000", "0123456789ab"), () => "", state, "")).toBe(false);
  });

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
    const dir = mkdtempSync(join(tmpdir(), "wb-camera-moved-"));
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
