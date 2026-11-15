/**
 * The camera's clips through the viewer (`runner/viewer/camera.ts`): what is
 * served, byte ranges for a video's seeking, and what is never served — a
 * frame, a path out of the run, anything behind a symbolic link. Fixture media
 * only: a two-second `testsrc` pattern, never a game image.
 */
import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../viewer/api";
import type { ClipsResponse, ClipView, HighlightResponse } from "../viewer/api-types";
import { parseRange, pickHighlight, readClips } from "../viewer/camera";
import { projectClips, projectHighlight } from "../viewer/public-projection";
import { CLIP_MEDIA_KEY, clipMediaKey } from "../viewer/public-keys";

const MEDIA = join(import.meta.dir, "fixtures", "camera");
const MP4 = readFileSync(join(MEDIA, "clip.mp4"));
const RUN = "cam-run";

interface Layout {
  runsDir: string;
  dir: string;
}

/** A run directory with a camera: a timelapse and a level clip, a frame, and `clips.json`. */
function layout(clips?: unknown[]): Layout {
  const runsDir = mkdtempSync(join(tmpdir(), "wb-camera-"));
  const dir = join(runsDir, RUN);
  mkdirSync(join(dir, "camera", "clips"), { recursive: true });
  mkdirSync(join(dir, "camera", "frames"), { recursive: true });
  writeFileSync(join(dir, "meta.json"), JSON.stringify({ runId: RUN, startedAt: Date.parse("2026-11-15T03:00:00Z"), camera: true, config: { driver: "openai", model: "fixture/cam" } }));
  copyFileSync(join(MEDIA, "poster.jpg"), join(dir, "camera", "frames", "1.jpg"));
  for (const n of ["timelapse", "event-7-level"]) {
    copyFileSync(join(MEDIA, "clip.mp4"), join(dir, "camera", "clips", `${n}.mp4`));
    copyFileSync(join(MEDIA, "poster.jpg"), join(dir, "camera", "clips", `${n}.jpg`));
  }
  writeClips(
    dir,
    clips ?? [
      clip("timelapse", "timelapse"),
      { ...clip("event-7-level", "event"), event: { type: "level", detail: "reached level 2" } },
    ],
  );
  return { runsDir, dir };
}

function clip(name: string, kind: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name,
    kind,
    file: `clips/${name}.mp4`,
    poster: `clips/${name}.jpg`,
    from: "2026-11-15T03:03:43.915Z",
    to: "2026-11-15T03:17:45.527Z",
    seconds: 2,
    caption: `WrathBench · fixture/cam · ${name}`,
    ...over,
  };
}

function writeClips(dir: string, clips: unknown[], runId = RUN): void {
  writeFileSync(join(dir, "camera", "clips.json"), JSON.stringify({ version: 1, runId, clips }));
}

function handle(l: Layout, publicMode = false): (req: Request) => Promise<Response> {
  return createApi({ runsDir: l.runsDir, tilesDir: join(l.runsDir, "no-tiles"), publicMode, moduleUrl: "http://127.0.0.1:1" } as Parameters<typeof createApi>[0]);
}

const get = (h: (req: Request) => Promise<Response>, path: string, headers: Record<string, string> = {}, method = "GET"): Promise<Response> =>
  h(new Request(`http://127.0.0.1${path}`, { headers, method }));

describe("the clips route", () => {
  test("lists each clip with its media named by the viewer's own routes, the frames by none", async () => {
    const l = layout();
    const res = await get(handle(l), `/api/run/${RUN}/clips`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ClipsResponse;
    expect(body.runId).toBe(RUN);
    expect(body.clips.map((c) => [c.name, c.video, c.poster])).toEqual([
      ["timelapse", `/api/run/${RUN}/clip/timelapse.mp4`, `/api/run/${RUN}/clip/timelapse.jpg`],
      ["event-7-level", `/api/run/${RUN}/clip/event-7-level.mp4`, `/api/run/${RUN}/clip/event-7-level.jpg`],
    ]);
    expect(JSON.stringify(body)).not.toContain("frames");
  });

  test("a run without a camera, an unreadable list or one naming another run is a 404, never a fault", async () => {
    const l = layout();
    const h = handle(l);
    writeFileSync(join(l.dir, "camera", "clips.json"), '{"version":1,"runId":"cam-run","clips":[');
    expect((await get(h, `/api/run/${RUN}/clips`)).status).toBe(404);
    writeClips(l.dir, [clip("timelapse", "timelapse")], "another-run");
    expect((await get(h, `/api/run/${RUN}/clips`)).status).toBe(404);
    rmSync(join(l.dir, "camera"), { recursive: true });
    expect((await get(h, `/api/run/${RUN}/clips`)).status).toBe(404);
  });

  test("an entry that names a frame, a path or a missing file is dropped, and the rest stand", () => {
    const l = layout([
      clip("timelapse", "timelapse"),
      clip("frame", "event", { file: "frames/1.jpg" }),
      clip("up", "event", { file: "clips/../frames/1.mp4" }),
      clip("abs", "event", { file: "/etc/passwd.mp4" }),
      clip("../x", "event"),
      clip("gone", "event"),
      clip("timelapse", "timelapse", { caption: "a second entry under a taken name" }),
    ]);
    expect(readClips(l.runsDir, RUN)!.map((c) => c.name)).toEqual(["timelapse", "gone"]);
  });
});

describe("the media route", () => {
  test("serves a clip whole, with its type and the range header a video needs", async () => {
    const l = layout();
    const res = await get(handle(l), `/api/run/${RUN}/clip/timelapse.mp4`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("video/mp4");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("content-length")).toBe(String(MP4.length));
    expect(Buffer.from(await res.arrayBuffer()).equals(MP4)).toBe(true);
    const poster = await get(handle(l), `/api/run/${RUN}/clip/timelapse.jpg`);
    expect(poster.headers.get("content-type")).toBe("image/jpeg");
  });

  test("answers a byte range with a 206 and exactly those bytes", async () => {
    const h = handle(layout());
    const res = await get(h, `/api/run/${RUN}/clip/timelapse.mp4`, { range: "bytes=100-199" });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes 100-199/${MP4.length}`);
    expect(res.headers.get("content-length")).toBe("100");
    expect(Buffer.from(await res.arrayBuffer()).equals(MP4.subarray(100, 200))).toBe(true);
    // Open-ended, as a video seeks.
    const open = await get(h, `/api/run/${RUN}/clip/timelapse.mp4`, { range: "bytes=1000-" });
    expect(open.status).toBe(206);
    expect(Buffer.from(await open.arrayBuffer()).equals(MP4.subarray(1000))).toBe(true);
    // A suffix: the last 10 bytes.
    const tail = await get(h, `/api/run/${RUN}/clip/timelapse.mp4`, { range: "bytes=-10" });
    expect(tail.headers.get("content-range")).toBe(`bytes ${MP4.length - 10}-${MP4.length - 1}/${MP4.length}`);
    // Past the end.
    const past = await get(h, `/api/run/${RUN}/clip/timelapse.mp4`, { range: `bytes=${MP4.length}-` });
    expect(past.status).toBe(416);
    expect(past.headers.get("content-range")).toBe(`bytes */${MP4.length}`);
    // Several ranges are answered whole, as the standard allows.
    expect((await get(h, `/api/run/${RUN}/clip/timelapse.mp4`, { range: "bytes=0-1,5-6" })).status).toBe(200);
    // A HEAD has the headers and no body.
    const head = await get(h, `/api/run/${RUN}/clip/timelapse.mp4`, { range: "bytes=0-9" }, "HEAD");
    expect(head.status).toBe(206);
    expect((await head.arrayBuffer()).byteLength).toBe(0);
  });

  test("parseRange reads one range and nothing else", () => {
    expect(parseRange(null, 100)).toBeNull();
    expect(parseRange("bytes=0-0", 100)).toEqual([0, 0]);
    expect(parseRange("bytes=90-500", 100)).toEqual([90, 99]);
    expect(parseRange("bytes=-500", 100)).toEqual([0, 99]);
    expect(parseRange("bytes=-0", 100)).toBe("unsatisfiable");
    expect(parseRange("bytes=100-", 100)).toBe("unsatisfiable");
    expect(parseRange("bytes=9-3", 100)).toBeNull();
    expect(parseRange("items=0-1", 100)).toBeNull();
  });

  test("never serves a frame, a path out of the clips, or a clip the list does not name", async () => {
    const l = layout();
    const h = handle(l);
    for (const path of [
      `/api/run/${RUN}/clip/1.jpg`,
      `/api/run/${RUN}/frames/1.jpg`,
      `/api/run/${RUN}/camera/frames/1.jpg`,
      `/api/run/${RUN}/clip/../frames/1.jpg`,
      `/api/run/${RUN}/clip/%2e%2e/frames/1.jpg`,
      `/api/run/${RUN}/clip/..%2Fframes%2F1.jpg`,
      `/api/run/${RUN}/clip/%2E%2E%2Fcamera%2Fframes%2F1.jpg`,
      `/api/run/${RUN}/clip/frames%2F1.jpg`,
      `/api/run/${RUN}/clip/nope.mp4`,
      `/api/run/${RUN}/clip/timelapse.json`,
      `/api/run/..%2F${RUN}/clip/timelapse.mp4`,
    ]) {
      const res = await get(h, path);
      expect(res.status, path).not.toBe(200);
      expect(res.status, path).not.toBe(206);
      expect(res.headers.get("content-type") ?? "", path).not.toContain("image/jpeg");
    }
    // A list that names the frame as a clip's poster gets no poster.
    writeClips(l.dir, [clip("timelapse", "timelapse", { poster: "frames/1.jpg" })]);
    expect((await get(h, `/api/run/${RUN}/clip/timelapse.jpg`)).status).toBe(404);
    const body = (await (await get(h, `/api/run/${RUN}/clips`)).json()) as ClipsResponse;
    expect(body.clips[0]!.poster).toBeNull();
  });

  test("refuses a symbolic link anywhere on the way: the camera, the clips, the list or the file", async () => {
    const outside = mkdtempSync(join(tmpdir(), "wb-camera-outside-"));
    writeFileSync(join(outside, "secret.mp4"), "not for the viewer");
    const cases: ((l: Layout) => void)[] = [
      (l) => {
        rmSync(join(l.dir, "camera", "clips", "timelapse.mp4"));
        symlinkSync(join(outside, "secret.mp4"), join(l.dir, "camera", "clips", "timelapse.mp4"));
      },
      (l) => {
        rmSync(join(l.dir, "camera", "clips"), { recursive: true });
        mkdirSync(join(outside, "clips"), { recursive: true });
        copyFileSync(join(MEDIA, "clip.mp4"), join(outside, "clips", "timelapse.mp4"));
        symlinkSync(join(outside, "clips"), join(l.dir, "camera", "clips"));
      },
      (l) => {
        const real = join(outside, `camera-${Math.random()}`);
        mkdirSync(join(real, "clips"), { recursive: true });
        copyFileSync(join(MEDIA, "clip.mp4"), join(real, "clips", "timelapse.mp4"));
        copyFileSync(join(l.dir, "camera", "clips.json"), join(real, "clips.json"));
        rmSync(join(l.dir, "camera"), { recursive: true });
        symlinkSync(real, join(l.dir, "camera"));
      },
      (l) => {
        const list = join(outside, `clips-${Math.random()}.json`);
        copyFileSync(join(l.dir, "camera", "clips.json"), list);
        rmSync(join(l.dir, "camera", "clips.json"));
        symlinkSync(list, join(l.dir, "camera", "clips.json"));
      },
    ];
    for (const [i, link] of cases.entries()) {
      const l = layout();
      link(l);
      const res = await get(handle(l), `/api/run/${RUN}/clip/timelapse.mp4`);
      expect(res.status, `case ${i}`).toBe(404);
    }
  });
});

describe("the camera label", () => {
  test("rides the run's detail, privately and publicly, only when meta.json says so", async () => {
    const l = layout();
    const read = async (publicMode: boolean): Promise<Record<string, unknown>> =>
      (await (await get(handle(l, publicMode), `/api/run/${RUN}`)).json()) as Record<string, unknown>;
    expect((await read(false))["camera"]).toBe(true);
    expect((await read(true))["camera"]).toBe(true);
    writeFileSync(join(l.dir, "meta.json"), JSON.stringify({ runId: RUN, startedAt: Date.parse("2026-11-15T03:00:00Z"), config: { driver: "openai" } }));
    expect("camera" in (await read(false))).toBe(false);
  });
});

describe("the public projection of clips", () => {
  const view = (over: Partial<ClipView> = {}): ClipView => ({
    name: "event-7-level",
    kind: "event",
    event: { type: "level", detail: "reached level 2" },
    from: "2026-11-15T03:03:43.915Z",
    to: "2026-11-15T03:04:43.915Z",
    seconds: 2,
    caption: "WrathBench · fixture/cam · heading out",
    video: `/api/run/${RUN}/clip/event-7-level.mp4`,
    poster: `/api/run/${RUN}/clip/event-7-level.jpg`,
    ...over,
  });

  test("keeps the allowlisted fields only, and is a fixed point of itself", () => {
    const poisoned = { ...view(), file: "/data/runs/cam-run/camera/clips/x.mp4", frames: ["frames/1.jpg"], token: "x" } as unknown as ClipView;
    const once = projectClips({ runId: RUN, clips: [poisoned], extra: 1 } as unknown as ClipsResponse);
    expect(Object.keys(once)).toEqual(["runId", "clips"]);
    expect(Object.keys(once.clips[0]!).sort()).toEqual(["caption", "event", "from", "kind", "name", "poster", "seconds", "to", "video"]);
    expect(projectClips(once)).toEqual(once);
  });

  test("captions cross the model-text strikes: a credential's shape is masked, the container prefix made relative", () => {
    const key = `sk-ant-api03-${"a".repeat(90)}`;
    const p = projectClips({ runId: RUN, clips: [view({ caption: `pasted ${key} from /wrathbench/data/x` })] });
    expect(p.clips[0]!.caption).not.toContain(key);
    expect(p.clips[0]!.caption).toContain(" from data/x");
    expect(projectClips(p)).toEqual(p);
    // One line, clipped.
    const long = projectClips({ runId: RUN, clips: [view({ caption: `a\nb ${"word ".repeat(200)}` })] }).clips[0]!.caption;
    expect(long.length).toBeLessThanOrEqual(240);
    expect(long).not.toContain("\n");
  });

  test("media are named only by this clip's route or its bucket key; anything else drops the clip or the poster", () => {
    const key = clipMediaKey(RUN, "event-7-level", "0123456789ab", "mp4");
    expect(CLIP_MEDIA_KEY.test(key)).toBe(true);
    const ok = projectClips({ runId: RUN, clips: [view({ video: key, poster: clipMediaKey(RUN, "event-7-level", "0123456789ab", "jpg") })] });
    expect(ok.clips).toHaveLength(1);
    for (const video of [
      "/data/runs/cam-run/camera/clips/event-7-level.mp4",
      "https://example.com/x.mp4",
      `/api/run/${RUN}/clip/timelapse.mp4`,
      clipMediaKey("another-run", "event-7-level", "0123456789ab", "mp4"),
      `v1/run/${RUN}/clip/event-7-level.mp4`,
    ]) {
      expect(projectClips({ runId: RUN, clips: [view({ video })] }).clips, video).toHaveLength(0);
    }
    expect(projectClips({ runId: RUN, clips: [view({ poster: "frames/1.jpg" })] }).clips[0]!.poster).toBeNull();
  });

  test("the home page's clip is the newest event clip, under the same rules", () => {
    const older = view({ name: "event-1-level", video: `/api/run/a/clip/event-1-level.mp4`, poster: null, to: "2026-11-15T01:00:00.000Z" });
    const newer = view({ name: "event-9-quest", video: `/api/run/b/clip/event-9-quest.mp4`, poster: null, to: "2026-11-15T05:00:00.000Z" });
    const lapse = view({ name: "timelapse", kind: "timelapse", video: `/api/run/b/clip/timelapse.mp4`, poster: null, to: "2026-11-15T09:00:00.000Z" });
    const h = pickHighlight([
      { runId: "a", model: "m/a", clips: { runId: "a", clips: [older] } },
      { runId: "b", model: "m/b", clips: { runId: "b", clips: [lapse, newer] } },
    ]);
    expect(h?.clip.name).toBe("event-9-quest");
    const body: HighlightResponse = { highlight: h };
    expect(projectHighlight(body)).toEqual(body);
    expect(projectHighlight(projectHighlight(body))).toEqual(projectHighlight(body));
    expect(pickHighlight([{ runId: "b", model: null, clips: { runId: "b", clips: [lapse] } }])?.clip.name).toBe("timelapse");
    expect(pickHighlight([])).toBeNull();
  });
});
