/**
 * The camera's video through the viewer (`viewer/camera.ts`): what is
 * served, byte ranges for a video's seeking, and what is never served — a
 * frame, a path out of the run, anything behind a symbolic link. Fixture media
 * only: a two-second `testsrc` pattern, never a game image.
 */
import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../api";
import type { ClipsResponse, HighlightResponse, VideoPartView } from "../api-types";
import { parseRange, pickHighlight, readClips } from "../camera";
import { projectClips, projectHighlight } from "../public-projection";
import { CLIP_MEDIA_KEY, clipMediaKey } from "../public-keys";

const MEDIA = join(import.meta.dir, "..", "..", "runner", "test", "fixtures", "camera");
const MP4 = readFileSync(join(MEDIA, "clip.mp4"));
const RUN = "cam-run";

interface Layout {
  runsDir: string;
  dir: string;
}

/** A run directory with a camera: a video in two parts, a frame, and `clips.json`. */
function layout(parts?: unknown[], extra: Record<string, unknown> = {}): Layout {
  const runsDir = mkdtempSync(join(tmpdir(), "wb-camera-"));
  const dir = join(runsDir, RUN);
  mkdirSync(join(dir, "camera", "clips"), { recursive: true });
  mkdirSync(join(dir, "camera", "frames"), { recursive: true });
  writeFileSync(join(dir, "meta.json"), JSON.stringify({ runId: RUN, startedAt: Date.parse("2026-11-15T03:00:00Z"), camera: true, config: { driver: "openai", model: "fixture/cam" } }));
  copyFileSync(join(MEDIA, "poster.jpg"), join(dir, "camera", "frames", "1.jpg"));
  for (const n of ["part-000", "part-001"]) {
    copyFileSync(join(MEDIA, "clip.mp4"), join(dir, "camera", "clips", `${n}.mp4`));
    copyFileSync(join(MEDIA, "poster.jpg"), join(dir, "camera", "clips", `${n}.jpg`));
  }
  writeClips(dir, parts ?? [part("part-000"), part("part-001", { from: "2026-11-15T09:03:43.915Z", to: "2026-11-15T09:17:45.527Z" })], RUN, extra);
  return { runsDir, dir };
}

function part(name: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    file: `clips/${name}.mp4`,
    poster: `clips/${name}.jpg`,
    from: "2026-11-15T03:03:43.915Z",
    to: "2026-11-15T03:17:45.527Z",
    seconds: 2,
    ...over,
  };
}

const T = Date.parse("2026-11-15T03:03:43.915Z");

function writeClips(dir: string, parts: unknown[], runId = RUN, extra: Record<string, unknown> = {}): void {
  writeFileSync(
    join(dir, "camera", "clips.json"),
    JSON.stringify({
      version: 2,
      runId,
      parts,
      chapters: [{ t: 2.5, part: 1, type: "level", detail: "reached level 2", caption: "heading out" }],
      captions: [{ t: 0, text: "heading out" }],
      timemap: [
        [0, T],
        [3.875, T + 6 * 3_600_000],
      ],
      ...extra,
    }),
  );
}

function handle(l: Layout, publicMode = false): (req: Request) => Promise<Response> {
  return createApi({ runsDir: l.runsDir, tilesDir: join(l.runsDir, "no-tiles"), publicMode, moduleUrl: "http://127.0.0.1:1" } as Parameters<typeof createApi>[0]);
}

const get = (h: (req: Request) => Promise<Response>, path: string, headers: Record<string, string> = {}, method = "GET"): Promise<Response> =>
  h(new Request(`http://127.0.0.1${path}`, { headers, method }));

describe("the clips route", () => {
  test("lists each part with its media named by the viewer's own routes, the frames by none", async () => {
    const l = layout();
    const res = await get(handle(l), `/api/run/${RUN}/clips`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ClipsResponse;
    expect(body.runId).toBe(RUN);
    expect(body.parts.map((c) => [c.name, c.video, c.poster])).toEqual([
      ["part-000", `/api/run/${RUN}/clip/part-000.mp4`, `/api/run/${RUN}/clip/part-000.jpg`],
      ["part-001", `/api/run/${RUN}/clip/part-001.mp4`, `/api/run/${RUN}/clip/part-001.jpg`],
    ]);
    expect(body.chapters).toEqual([{ t: 2.5, part: 1, type: "level", detail: "reached level 2", caption: "heading out" }]);
    expect(body.captions).toEqual([{ t: 0, text: "heading out" }]);
    expect(body.timemap).toHaveLength(2);
    expect(JSON.stringify(body)).not.toContain("frames");
  });

  test("a run without a camera, an unreadable list, an older layout or one naming another run has no clips: null privately, a 404 publicly, never a fault", async () => {
    const l = layout();
    const priv = handle(l);
    const pubH = handle(l, true);
    const none = async (): Promise<void> => {
      const res = await get(priv, `/api/run/${RUN}/clips`);
      expect(res.status).toBe(200);
      expect(await res.json()).toBeNull();
      expect((await get(pubH, `/api/run/${RUN}/clips`)).status).toBe(404);
    };
    writeFileSync(join(l.dir, "camera", "clips.json"), '{"version":2,"runId":"cam-run","parts":[');
    await none();
    writeFileSync(join(l.dir, "camera", "clips.json"), JSON.stringify({ version: 1, runId: RUN, clips: [{ name: "timelapse", kind: "timelapse", file: "clips/part-000.mp4" }] }));
    await none();
    writeClips(l.dir, [part("part-000")], "another-run");
    await none();
    rmSync(join(l.dir, "camera"), { recursive: true });
    await none();
    // A run that is not there is a 404 to either.
    expect((await get(priv, `/api/run/no-such-run/clips`)).status).toBe(404);
  });

  test("the parts stop at the first that names a frame, a path or a taken name; what falls past the end goes with them", async () => {
    for (const bad of [part("frame", { file: "frames/1.jpg" }), part("up", { file: "clips/../frames/1.mp4" }), part("abs", { file: "/etc/passwd.mp4" }), part("../x"), part("part-000")]) {
      const l = layout([part("part-000"), bad, part("part-001")]);
      const v = readClips(l.runsDir, RUN)!;
      expect(v.parts.map((c) => c.name)).toEqual(["part-000"]);
      // The chapter was in the second part, the time map's end past the first's two seconds.
      expect(v.chapters).toEqual([]);
      expect(v.timemap).toEqual([[0, T]]);
    }
    // A missing file ends the served list there too.
    const l = layout();
    rmSync(join(l.dir, "camera", "clips", "part-001.mp4"));
    const served = (await (await get(handle(l), `/api/run/${RUN}/clips`)).json()) as ClipsResponse;
    expect(served.parts.map((p) => p.name)).toEqual(["part-000"]);
    expect(served.chapters).toEqual([]);
  });

  test("a chapter or a cue that does not read is dropped, and a time map that runs backwards loses the point", () => {
    const l = layout(undefined, {
      // A kind that never was a chapter, two that do not fall on the video, the three a list cut before the rule holds and one that is a chapter still.
      chapters: [
        { t: 1, part: 0, type: "start", detail: "x" },
        { t: -1, part: 0, type: "level" },
        { t: 1, part: 7, type: "level" },
        { t: 1, part: 0, type: "quest", detail: "turned in quest 7" },
        { t: 1, part: 0, type: "zone", detail: "entered zone 12" },
        { t: 1, part: 0, type: "death", detail: "died" },
        { t: 1.5, part: 0, type: "boss", detail: "killed boss 644" },
      ],
      captions: [{ t: 1 }, { t: 9, text: "past the end" }, { t: 1, text: "ok" }],
      timemap: [[0, T], [1, T - 5], [2, T + 5], "x"],
    });
    const v = readClips(l.runsDir, RUN)!;
    expect(v.chapters).toEqual([{ t: 1.5, part: 0, type: "boss", detail: "killed boss 644", caption: "" }]);
    expect(v.captions).toEqual([{ t: 1, text: "ok" }]);
    expect(v.timemap).toEqual([[0, T], [2, T + 5]]);
  });
});

describe("the media route", () => {
  test("serves a part whole, with its type and the range header a video needs", async () => {
    const l = layout();
    const res = await get(handle(l), `/api/run/${RUN}/clip/part-000.mp4`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("video/mp4");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("content-length")).toBe(String(MP4.length));
    expect(Buffer.from(await res.arrayBuffer()).equals(MP4)).toBe(true);
    const poster = await get(handle(l), `/api/run/${RUN}/clip/part-000.jpg`);
    expect(poster.headers.get("content-type")).toBe("image/jpeg");
  });

  test("answers a byte range with a 206 and exactly those bytes", async () => {
    const h = handle(layout());
    const res = await get(h, `/api/run/${RUN}/clip/part-000.mp4`, { range: "bytes=100-199" });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes 100-199/${MP4.length}`);
    expect(res.headers.get("content-length")).toBe("100");
    expect(Buffer.from(await res.arrayBuffer()).equals(MP4.subarray(100, 200))).toBe(true);
    // Open-ended, as a video seeks.
    const open = await get(h, `/api/run/${RUN}/clip/part-000.mp4`, { range: "bytes=1000-" });
    expect(open.status).toBe(206);
    expect(Buffer.from(await open.arrayBuffer()).equals(MP4.subarray(1000))).toBe(true);
    // A suffix: the last 10 bytes.
    const tail = await get(h, `/api/run/${RUN}/clip/part-000.mp4`, { range: "bytes=-10" });
    expect(tail.headers.get("content-range")).toBe(`bytes ${MP4.length - 10}-${MP4.length - 1}/${MP4.length}`);
    // Past the end.
    const past = await get(h, `/api/run/${RUN}/clip/part-000.mp4`, { range: `bytes=${MP4.length}-` });
    expect(past.status).toBe(416);
    expect(past.headers.get("content-range")).toBe(`bytes */${MP4.length}`);
    // Several ranges are answered whole, as the standard allows.
    expect((await get(h, `/api/run/${RUN}/clip/part-000.mp4`, { range: "bytes=0-1,5-6" })).status).toBe(200);
    // A HEAD has the headers and no body.
    const head = await get(h, `/api/run/${RUN}/clip/part-000.mp4`, { range: "bytes=0-9" }, "HEAD");
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

  test("never serves a frame, a path out of the clips, or a part the list does not name", async () => {
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
      `/api/run/${RUN}/clip/part-000.json`,
      `/api/run/..%2F${RUN}/clip/part-000.mp4`,
    ]) {
      const res = await get(h, path);
      expect(res.status, path).not.toBe(200);
      expect(res.status, path).not.toBe(206);
      expect(res.headers.get("content-type") ?? "", path).not.toContain("image/jpeg");
    }
    // A list that names the frame as a part's poster gets no poster.
    writeClips(l.dir, [part("part-000", { poster: "frames/1.jpg" })]);
    expect((await get(h, `/api/run/${RUN}/clip/part-000.jpg`)).status).toBe(404);
    const body = (await (await get(h, `/api/run/${RUN}/clips`)).json()) as ClipsResponse;
    expect(body.parts[0]!.poster).toBeNull();
  });

  test("refuses a symbolic link anywhere on the way: the camera, the clips, the list or the file", async () => {
    const outside = mkdtempSync(join(tmpdir(), "wb-camera-outside-"));
    writeFileSync(join(outside, "secret.mp4"), "not for the viewer");
    const cases: ((l: Layout) => void)[] = [
      (l) => {
        rmSync(join(l.dir, "camera", "clips", "part-000.mp4"));
        symlinkSync(join(outside, "secret.mp4"), join(l.dir, "camera", "clips", "part-000.mp4"));
      },
      (l) => {
        rmSync(join(l.dir, "camera", "clips"), { recursive: true });
        mkdirSync(join(outside, "clips"), { recursive: true });
        copyFileSync(join(MEDIA, "clip.mp4"), join(outside, "clips", "part-000.mp4"));
        symlinkSync(join(outside, "clips"), join(l.dir, "camera", "clips"));
      },
      (l) => {
        const real = join(outside, `camera-${Math.random()}`);
        mkdirSync(join(real, "clips"), { recursive: true });
        copyFileSync(join(MEDIA, "clip.mp4"), join(real, "clips", "part-000.mp4"));
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
      const res = await get(handle(l), `/api/run/${RUN}/clip/part-000.mp4`);
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

describe("the public projection of the video", () => {
  const view = (over: Partial<VideoPartView> = {}): VideoPartView => ({
    name: "part-000",
    from: "2026-11-15T03:03:43.915Z",
    to: "2026-11-15T03:04:43.915Z",
    seconds: 2,
    video: `/api/run/${RUN}/clip/part-000.mp4`,
    poster: `/api/run/${RUN}/clip/part-000.jpg`,
    ...over,
  });
  const body = (parts: VideoPartView[], over: Partial<ClipsResponse> = {}): ClipsResponse => ({
    runId: RUN,
    parts,
    chapters: [{ t: 1, part: 0, type: "level", detail: "reached level 2", caption: "heading out" }],
    captions: [{ t: 0, text: "heading out" }],
    timemap: [[0, T], [1.5, T + 60_000]],
    ...over,
  });

  test("keeps the allowlisted fields only, and is a fixed point of itself", () => {
    const poisoned = { ...view(), file: "/data/runs/cam-run/camera/clips/x.mp4", frames: ["frames/1.jpg"], token: "x" } as unknown as VideoPartView;
    const once = projectClips({ ...body([poisoned]), extra: 1 } as unknown as ClipsResponse);
    expect(Object.keys(once)).toEqual(["runId", "parts", "chapters", "captions", "timemap"]);
    expect(Object.keys(once.parts[0]!).sort()).toEqual(["from", "name", "poster", "seconds", "to", "video"]);
    expect(Object.keys(once.chapters[0]!).sort()).toEqual(["caption", "detail", "part", "t", "type"]);
    expect(projectClips(once)).toEqual(once);
  });

  test("captions cross the model-text strikes: a credential's shape is masked, the container prefix made relative", () => {
    const key = `sk-ant-api03-${"a".repeat(90)}`;
    const p = projectClips(body([view()], { captions: [{ t: 0, text: `pasted ${key} from /wrathbench/data/x` }], chapters: [{ t: 1, part: 0, type: "level", detail: "x", caption: `pasted ${key}` }] }));
    expect(p.captions[0]!.text).not.toContain(key);
    expect(p.captions[0]!.text).toContain(" from data/x");
    expect(p.chapters[0]!.caption).not.toContain(key);
    expect(projectClips(p)).toEqual(p);
    // One line, clipped.
    const long = projectClips(body([view()], { captions: [{ t: 0, text: `a\nb ${"word ".repeat(200)}` }] })).captions[0]!.text;
    expect(long.length).toBeLessThanOrEqual(240);
    expect(long).not.toContain("\n");
  });

  test("media are named only by this part's route or its bucket key; anything else ends the parts or drops the poster", () => {
    const key = clipMediaKey(RUN, "part-000", "0123456789ab", "mp4");
    expect(CLIP_MEDIA_KEY.test(key)).toBe(true);
    const ok = projectClips(body([view({ video: key, poster: clipMediaKey(RUN, "part-000", "0123456789ab", "jpg") })]));
    expect(ok.parts).toHaveLength(1);
    for (const video of [
      "/data/runs/cam-run/camera/clips/part-000.mp4",
      "https://example.com/x.mp4",
      `/api/run/${RUN}/clip/part-001.mp4`,
      clipMediaKey("another-run", "part-000", "0123456789ab", "mp4"),
      `v1/run/${RUN}/clip/part-000.mp4`,
    ]) {
      const p = projectClips(body([view({ video })]));
      expect(p.parts, video).toHaveLength(0);
      expect(p.chapters, video).toHaveLength(0);
    }
    expect(projectClips(body([view({ poster: "frames/1.jpg" })])).parts[0]!.poster).toBeNull();
  });

  test("the home page's excerpt is around the newest chapter by run time, under the same rules", () => {
    const a = view({ name: "part-000", video: `/api/run/a/clip/part-000.mp4`, poster: null, seconds: 60 });
    const b0 = view({ name: "part-000", video: `/api/run/b/clip/part-000.mp4`, poster: null, seconds: 60 });
    const b1 = view({ name: "part-001", video: `/api/run/b/clip/part-001.mp4`, poster: null, seconds: 60 });
    const runA: ClipsResponse = { runId: "a", parts: [a], chapters: [{ t: 30, part: 0, type: "death", detail: "died", caption: "oops" }], captions: [], timemap: [[0, T], [60, T + 10 * 3_600_000]] };
    // Run b's newest chapter is in its second part, earlier in run time than a's.
    const runB: ClipsResponse = { runId: "b", parts: [b0, b1], chapters: [{ t: 70, part: 1, type: "level", detail: "reached level 3", caption: "" }], captions: [], timemap: [[0, T], [120, T + 2 * 3_600_000]] };
    const h = pickHighlight([
      { runId: "b", model: "m/b", clips: runB },
      { runId: "a", model: "m/a", clips: runA },
    ]);
    expect(h?.runId).toBe("a");
    expect([h?.part.name, h?.from, h?.to, h?.chapter?.detail]).toEqual(["part-000", 29, 36, "died"]);
    // Alone, b's excerpt is in the part its chapter is in, as offsets into that part's file.
    const hb = pickHighlight([{ runId: "b", model: "m/b", clips: runB }]);
    expect([hb?.part.name, hb?.from, hb?.to]).toEqual(["part-001", 9, 16]);
    const out: HighlightResponse = { highlight: h };
    expect(projectHighlight(out)).toEqual(out);
    expect(projectHighlight(projectHighlight(out))).toEqual(projectHighlight(out));
    // A window past its part's end is none.
    expect(projectHighlight({ highlight: { ...h!, to: 61 } }).highlight).toBeNull();
    // A chaptered run beats a newer run with none; with no chapters anywhere, the newest video's last seconds.
    const bare: ClipsResponse = { ...runB, chapters: [], timemap: [[0, T + 20 * 3_600_000]] };
    expect(pickHighlight([{ runId: "b", model: null, clips: bare }, { runId: "a", model: null, clips: runA }])?.runId).toBe("a");
    expect(pickHighlight([{ runId: "b", model: null, clips: bare }])).toMatchObject({ part: { name: "part-001" }, from: 58, to: 60, chapter: null });
    expect(pickHighlight([])).toBeNull();
  });
});
