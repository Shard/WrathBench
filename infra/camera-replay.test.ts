/**
 * Camera clips from the run directory to the bucket, over the dashboard rig's
 * own fixture (`infra/shots/fixture.ts`): the ended run has a camera, and so
 * does the scripted reference run, which is never published. Synthetic media
 * only (ffmpeg's `testsrc`, `runner/test/fixtures/camera/`).
 *
 * What is pinned: a withheld run publishes no clip and no list; a published
 * run's clips go up as their own objects at content-addressed keys under the
 * run, named by a projected `clips.json`; a second pass uploads none of them
 * again; a re-rendered clip gets a new key and the old one is pruned once a
 * second flip names the new; a run without a camera keeps the keys it had.
 */
import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../runner/viewer/api";
import type { ClipsResponse, HighlightResponse, RunsResponse } from "../runner/viewer/api-types";
import { createRenderer, type SnapshotResult } from "../runner/viewer/snapshot";
import { classifyPath, emptyState, needsPut, planPrune, planWithdraw, publishPass, type ObjectStore, type PublishState } from "./publish-core";
import { reprojectionFindings, scanBody, verifyPublication } from "./publish-accept";
import { ENDED_RUN, REFERENCE_RUN, writeFixture } from "./shots/fixture";

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

describe("camera clips, viewer to bucket", () => {
  test("a run that is never published serves no clip to a public handle, and gets no highlight", async () => {
    const runsDir = await fixture();
    const priv = api(runsDir, false);
    const pub = api(runsDir, true);
    for (const path of [`/api/run/${REFERENCE_RUN}/clips`, `/api/run/${REFERENCE_RUN}/clip/timelapse.mp4`]) {
      expect((await priv(new Request(`http://x${path}`))).status, path).toBe(200);
      expect((await pub(new Request(`http://x${path}`))).status, path).toBe(404);
    }
    const h = (await (await pub(new Request("http://x/api/highlight"))).json()) as HighlightResponse;
    expect(h.highlight?.runId).toBe(ENDED_RUN);
    // The public handle's clip list is projected: its media are the viewer's routes.
    const c = (await (await pub(new Request(`http://x/api/run/${ENDED_RUN}/clips`))).json()) as ClipsResponse;
    expect(c.clips.map((x) => x.video)).toEqual([`/api/run/${ENDED_RUN}/clip/timelapse.mp4`, `/api/run/${ENDED_RUN}/clip/event-12-level.mp4`]);
  }, 60_000);

  test("a pass publishes a run's clips as their own objects, named by its clips.json, and a second pass uploads none again", async () => {
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
    expect(clips.clips.map((c) => c.name)).toEqual(["timelapse", "event-12-level"]);
    for (const c of clips.clips) {
      expect(classifyPath(c.video)).toMatchObject({ kind: "clip", runId: ENDED_RUN });
      expect(b.objects.get(c.video)!.equals(MP4)).toBe(true);
      expect(b.objects.has(c.poster!)).toBe(true);
    }
    // The same file under two names is two objects, one per clip.
    expect(new Set(clips.clips.map((c) => c.video)).size).toBe(2);
    // The published list is a fixed point of its projection, and its captions are the residual, not a finding.
    const body = json<Record<string, unknown>>(b.objects.get(row.snapshot!.clips!));
    expect(reprojectionFindings(row.snapshot!.clips!, body)).toEqual([]);
    expect(scanBody(row.snapshot!.clips!, body).findings).toEqual([]);
    // The home page's clip is published and names the same objects.
    const highlightKey = json<{ artifacts: Record<string, string> }>(b.objects.get("v1/manifest.json")).artifacts["highlight.json"]!;
    const highlight = json<HighlightResponse>(b.objects.get(highlightKey));
    expect(highlight.highlight?.clip.name).toBe("event-12-level");
    expect(highlight.highlight?.model).toBe("fixture/ended-model");
    expect(b.objects.has(highlight.highlight!.clip.video)).toBe(true);
    expect(result?.gen).not.toBe("");

    // The bucket's verifier walks it clean, clip files included.
    const report = await verifyPublication({
      get: async (k) => b.objects.get(k)?.toString("utf8") ?? null,
      head: async (k) => (b.objects.has(k) ? { size: b.objects.get(k)!.length } : null),
    });
    expect(report.missing).toEqual([]);
    expect(report.findings.filter((f) => f.key.includes("clip"))).toEqual([]);

    // Idempotent: a second pass over the same files uploads no clip file again.
    b.puts.length = 0;
    await publishPass(async (sink, published) => await render(undefined, { sink, batch: 3 }, published), b.store, state);
    expect(b.puts.filter((k) => classifyPath(k).kind === "clip")).toEqual([]);
  }, 60_000);

  test("a re-rendered clip goes up at a new key, and the old file is pruned once a second flip names the new", async () => {
    const runsDir = await fixture();
    const render = createRenderer({ runsDir, configDbPath: join(runsDir, "none.sqlite") });
    const b = bucket();
    const state = emptyState();
    const pass = async (): Promise<void> => {
      await publishPass(async (sink, published) => await render(undefined, { sink, batch: 4 }, published), b.store, state);
    };
    await pass();
    const before = [...b.objects.keys()].filter((k) => k.includes(`/clip/timelapse-`) && k.endsWith(".mp4"));
    expect(before).toHaveLength(1);
    const file = join(runsDir, ENDED_RUN, "camera", "clips", "timelapse.mp4");
    appendFileSync(file, Buffer.from([0, 0, 0, 8, 102, 114, 101, 101]));
    await pass();
    const after = [...b.objects.keys()].filter((k) => k.includes(`/clip/timelapse-`) && k.endsWith(".mp4"));
    expect(after).toHaveLength(2);
    await pass();
    const settled = [...b.objects.keys()].filter((k) => k.includes(`/clip/timelapse-`) && k.endsWith(".mp4"));
    expect(settled).toEqual(after.filter((k) => k !== before[0]));
    expect(state.clipVersions?.[`${ENDED_RUN}/timelapse.mp4`]).toHaveLength(1);
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

describe("the engine's clip keys", () => {
  const key = (run: string, name: string, hash: string, ext = "mp4"): string => `v1/run/${run}/clip/${name}-${hash}.${ext}`;

  test("classify as clips, never as a run object at a version called `clip`", () => {
    expect(classifyPath(key("r1", "timelapse", "0123456789ab"))).toEqual({ kind: "clip", runId: "r1", slot: "timelapse.mp4", version: "0123456789ab" });
    expect(classifyPath("v1/run/r1/clip/whatever.json")).toEqual({ kind: "other" });
    const state = emptyState();
    expect(needsPut(key("r1", "timelapse", "0123456789ab"), () => "", state, "")).toBe(true);
    state.uploaded[key("r1", "timelapse", "0123456789ab")] = "h";
    expect(needsPut(key("r1", "timelapse", "0123456789ab"), () => "", state, "")).toBe(false);
  });

  test("are withdrawn with their run, and pruned only outside their slot's keep window", () => {
    const state = emptyState();
    const keep = key("r1", "timelapse", "bbbbbbbbbbbb");
    const old = key("r1", "timelapse", "aaaaaaaaaaaa");
    const orphan = key("r1", "event-1-level", "cccccccccccc");
    for (const k of [keep, old, orphan, key("r2", "timelapse", "dddddddddddd")]) state.uploaded[k] = "h";
    state.clipVersions = { "r1/timelapse.mp4": ["bbbbbbbbbbbb"], "r2/timelapse.mp4": ["dddddddddddd"] };
    expect(planPrune(state)).toEqual([old, orphan].sort());
    expect(planWithdraw(state, ["r2"])).toEqual([key("r2", "timelapse", "dddddddddddd")]);
    expect(state.clipVersions["r2/timelapse.mp4"]).toBeUndefined();
  });

  test("a clip file that moved since it was hashed is not uploaded, and the pass does not flip", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-camera-moved-"));
    const file = join(dir, "timelapse.mp4");
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
      media: [{ path: key("r1", "timelapse", "0123456789ab"), file, hash: "h", size: st.size, mtimeMs: st.mtimeMs, contentType: "video/mp4", cacheControl: "x" }],
    };
    await expect(publishPass(async () => result, b.store, state)).rejects.toThrow(/changed since it was hashed/);
    expect(b.puts).toEqual([]);
    expect(state.lastGen).toBeUndefined();
  });
});
