/**
 * The newest camera frame through the private viewer (`viewer/camera-live.ts`):
 * the index read from its tail, a partial or empty index, a frame that is not
 * on disk, what is never served (any other frame, a path, anything behind a
 * symbolic link), and a public handle, which has no such route. Fixture media
 * only: the synthetic `testsrc` still, never a game image.
 */
import { describe, expect, test } from "bun:test";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { frameFile } from "../../infra/camera/layout";
import { createApi } from "../api";
import type { LatestFrameResponse } from "../api-types";
import { latestFrame, readIndexLine, tailLines, TAIL_BYTES } from "../camera-live";

const STILL = join(import.meta.dir, "..", "..", "runner", "test", "fixtures", "camera", "poster.jpg");
const JPG = readFileSync(STILL);
const RUN = "cam-live";

interface Layout {
  runsDir: string;
  dir: string;
  cam: string;
}

const iso = (s: number): string => new Date(Date.parse("2026-11-15T03:00:00Z") + s * 1000).toISOString();
const line = (seq: number, over: Record<string, unknown> = {}): string =>
  `${JSON.stringify({ seq, t: iso(seq * 10), file: frameFile(seq), kind: "interval", ...over })}\n`;

/** A live run with a camera: frames 1..n on disk and a line for each. */
function layout(n = 3): Layout {
  const runsDir = mkdtempSync(join(tmpdir(), "wb-camera-live-"));
  const dir = join(runsDir, RUN);
  const cam = join(dir, "camera");
  mkdirSync(join(cam, "frames"), { recursive: true });
  writeFileSync(join(dir, "meta.json"), JSON.stringify({ runId: RUN, startedAt: Date.parse("2026-11-15T03:00:00Z"), camera: true, config: { driver: "openai", model: "fixture/cam" } }));
  writeFileSync(join(cam, "frames.jsonl"), "");
  for (let seq = 1; seq <= n; seq++) frame(cam, seq);
  return { runsDir, dir, cam };
}

function frame(cam: string, seq: number, onDisk = true): void {
  if (onDisk) copyFileSync(STILL, join(cam, frameFile(seq)));
  appendFileSync(join(cam, "frames.jsonl"), line(seq));
}

function handle(l: Layout, publicMode = false): (req: Request) => Promise<Response> {
  return createApi({ runsDir: l.runsDir, tilesDir: join(l.runsDir, "no-tiles"), publicMode, moduleUrl: "http://127.0.0.1:1" } as Parameters<typeof createApi>[0]);
}

const get = (h: (req: Request) => Promise<Response>, path: string, method = "GET"): Promise<Response> =>
  h(new Request(`http://127.0.0.1${path}`, { method }));

describe("the newest frame", () => {
  test("is the index's last line, with the frame its seq names", () => {
    const l = layout(3);
    expect(latestFrame(l.runsDir, RUN)).toEqual({ seq: 3, t: iso(30), file: join(l.cam, frameFile(3)) });
    frame(l.cam, 4);
    expect(latestFrame(l.runsDir, RUN)?.seq).toBe(4);
  });

  test("is found under the name the camera writes: the seq zero-padded to six digits", () => {
    // Spelled out, not built: this is the shape on disk in every filmed run.
    const l = layout(0);
    copyFileSync(STILL, join(l.cam, "frames", "000868.jpg"));
    appendFileSync(join(l.cam, "frames.jsonl"), `${JSON.stringify({ seq: 868, t: iso(8680), file: "frames/000868.jpg", kind: "interval" })}\n`);
    expect(latestFrame(l.runsDir, RUN)).toEqual({ seq: 868, t: iso(8680), file: join(l.cam, "frames", "000868.jpg") });
    // An unpadded file beside it is not that frame.
    copyFileSync(STILL, join(l.cam, "frames", "869.jpg"));
    appendFileSync(join(l.cam, "frames.jsonl"), `${JSON.stringify({ seq: 869, t: iso(8690), kind: "interval" })}\n`);
    expect(latestFrame(l.runsDir, RUN)?.seq).toBe(868);
  });

  test("is none for an empty index, no index, no frames directory or no camera", () => {
    const l = layout(0);
    expect(latestFrame(l.runsDir, RUN)).toBeNull();
    writeFileSync(join(l.cam, "frames.jsonl"), "\n\n");
    expect(latestFrame(l.runsDir, RUN)).toBeNull();
    const m = layout(2);
    rmSync(join(m.cam, "frames.jsonl"));
    expect(latestFrame(m.runsDir, RUN)).toBeNull();
    const f = layout(2);
    rmSync(join(f.cam, "frames"), { recursive: true });
    expect(latestFrame(f.runsDir, RUN)).toBeNull();
    const c = layout(2);
    rmSync(c.cam, { recursive: true });
    expect(latestFrame(c.runsDir, RUN)).toBeNull();
    expect(latestFrame(c.runsDir, "../cam-live")).toBeNull();
  });

  test("passes over a last line cut short by a writer mid-append", () => {
    const l = layout(3);
    copyFileSync(STILL, join(l.cam, frameFile(4)));
    appendFileSync(join(l.cam, "frames.jsonl"), line(4).slice(0, 25));
    expect(latestFrame(l.runsDir, RUN)?.seq).toBe(3);
    // Finished, even before its newline, it is the newest.
    appendFileSync(join(l.cam, "frames.jsonl"), line(4).slice(25, -1));
    expect(latestFrame(l.runsDir, RUN)?.seq).toBe(4);
  });

  test("gives way to the line before when its frame is not on disk, and is none when no frame is", () => {
    const l = layout(2);
    frame(l.cam, 3, false);
    expect(latestFrame(l.runsDir, RUN)?.seq).toBe(2);
    rmSync(join(l.cam, frameFile(2)));
    rmSync(join(l.cam, frameFile(1)));
    expect(latestFrame(l.runsDir, RUN)).toBeNull();
  });

  test("reads only the index's tail, whatever comes before it", () => {
    const l = layout(0);
    // A megabyte of lines that do not read, then two that do.
    writeFileSync(join(l.cam, "frames.jsonl"), `${"x".repeat(1 << 20)}\n${"{not json}\n".repeat(5000)}`);
    frame(l.cam, 7);
    frame(l.cam, 8);
    const lines = tailLines(join(l.cam, "frames.jsonl"));
    expect(lines.join("\n").length).toBeLessThanOrEqual(TAIL_BYTES);
    expect(lines[0]).toBe(line(8).trimEnd());
    expect(latestFrame(l.runsDir, RUN)?.seq).toBe(8);
  });

  test("an index line is a whole seq, an ISO time, and that frame's own file or none", () => {
    expect(readIndexLine(line(5).trimEnd())).toEqual({ seq: 5, t: iso(50) });
    expect(readIndexLine(JSON.stringify({ seq: 5, t: iso(50) }))).toEqual({ seq: 5, t: iso(50) });
    for (const bad of [
      line(5, { file: frameFile(6) }),
      // The unpadded name is not the one the camera writes.
      line(5, { file: "frames/5.jpg" }),
      line(5, { file: "../../meta.json" }),
      line(5, { file: "frames/../000005.jpg" }),
      line(5, { seq: "5" }),
      line(5, { seq: -1 }),
      line(5, { seq: 1.5 }),
      line(5, { t: "yesterday" }),
      "[1,2]",
      "null",
    ]) {
      expect(readIndexLine(bad.trimEnd()), bad).toBeNull();
    }
  });
});

describe("the private routes", () => {
  test("serve the newest frame's seq and time, and its picture with both in headers, never stored", async () => {
    const l = layout(3);
    const h = handle(l);
    const meta = await get(h, `/api/run/${RUN}/camera/latest`);
    expect(meta.status).toBe(200);
    expect(meta.headers.get("cache-control")).toBe("no-store");
    expect((await meta.json()) as LatestFrameResponse).toEqual({ runId: RUN, seq: 3, t: iso(30) });

    const pic = await get(h, `/api/run/${RUN}/camera/latest.jpg?seq=3`);
    expect(pic.status).toBe(200);
    expect(pic.headers.get("content-type")).toBe("image/jpeg");
    expect(pic.headers.get("cache-control")).toBe("no-store");
    expect(pic.headers.get("x-camera-seq")).toBe("3");
    expect(pic.headers.get("x-camera-time")).toBe(iso(30));
    expect(Buffer.from(await pic.arrayBuffer()).equals(JPG)).toBe(true);

    const head = await get(h, `/api/run/${RUN}/camera/latest.jpg`, "HEAD");
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(JPG.length));
    expect((await head.arrayBuffer()).byteLength).toBe(0);
  });

  test("for a run with no frame: null for its seq and time, a 404 for the picture, never a fault", async () => {
    // Asked on every live run's page, filmed or not: no frame is an answer, not a console error.
    for (const l of [layout(0), (() => {
      const bare = layout(0);
      rmSync(bare.cam, { recursive: true });
      return bare;
    })()]) {
      const meta = await get(handle(l), `/api/run/${RUN}/camera/latest`);
      expect(meta.status).toBe(200);
      expect(await meta.json()).toBeNull();
      expect(meta.headers.get("cache-control")).toBe("no-store");
      const pic = await get(handle(l), `/api/run/${RUN}/camera/latest.jpg`);
      expect(pic.status).toBe(404);
      expect(pic.headers.get("cache-control")).toBe("no-store");
    }
    // A run that is not there is still not there.
    const l = layout(0);
    for (const p of ["latest", "latest.jpg"]) expect((await get(handle(l), `/api/run/no-such-run/camera/${p}`)).status, p).toBe(404);
  });

  test("serve no other frame, by name or by any path", async () => {
    const l = layout(3);
    const h = handle(l);
    for (const path of [
      `/api/run/${RUN}/camera/1.jpg`,
      `/api/run/${RUN}/camera/frames/1.jpg`,
      `/api/run/${RUN}/camera/frames/000001.jpg`,
      `/api/run/${RUN}/camera/latest/../frames/1.jpg`,
      `/api/run/${RUN}/camera/%2e%2e/camera/frames/1.jpg`,
      `/api/run/${RUN}/camera/frames%2F1.jpg`,
      `/api/run/${RUN}/camera/frames.jsonl`,
      `/api/run/${RUN}/camera/latest.jpg/`,
      `/api/run/${RUN}/frames/1.jpg`,
      `/api/run/..%2F${RUN}/camera/latest.jpg`,
    ]) {
      const res = await get(h, path);
      expect(res.status, path).not.toBe(200);
      expect(res.headers.get("content-type") ?? "", path).not.toContain("image/jpeg");
    }
  });

  test("refuse a symbolic link anywhere on the way: the camera, the index, the frames or the frame", async () => {
    const outside = mkdtempSync(join(tmpdir(), "wb-camera-live-outside-"));
    writeFileSync(join(outside, "secret.jpg"), "not for the viewer");
    const cases: ((l: Layout) => void)[] = [
      (l) => {
        rmSync(join(l.cam, frameFile(3)));
        symlinkSync(join(outside, "secret.jpg"), join(l.cam, frameFile(3)));
        rmSync(join(l.cam, frameFile(2)));
        rmSync(join(l.cam, frameFile(1)));
      },
      (l) => {
        const real = join(outside, `frames-${Math.random()}`);
        mkdirSync(real);
        copyFileSync(STILL, join(real, basename(frameFile(3))));
        rmSync(join(l.cam, "frames"), { recursive: true });
        symlinkSync(real, join(l.cam, "frames"));
      },
      (l) => {
        const index = join(outside, `index-${Math.random()}.jsonl`);
        copyFileSync(join(l.cam, "frames.jsonl"), index);
        rmSync(join(l.cam, "frames.jsonl"));
        symlinkSync(index, join(l.cam, "frames.jsonl"));
      },
      (l) => {
        const real = join(outside, `camera-${Math.random()}`);
        mkdirSync(join(real, "frames"), { recursive: true });
        copyFileSync(STILL, join(real, frameFile(3)));
        copyFileSync(join(l.cam, "frames.jsonl"), join(real, "frames.jsonl"));
        rmSync(l.cam, { recursive: true });
        symlinkSync(real, l.cam);
      },
    ];
    for (const [i, link] of cases.entries()) {
      const l = layout(3);
      link(l);
      expect(latestFrame(l.runsDir, RUN), `case ${i}`).toBeNull();
      // No frame is reachable: none named, and no picture served.
      expect(await (await get(handle(l), `/api/run/${RUN}/camera/latest`)).json(), `case ${i}`).toBeNull();
      expect((await get(handle(l), `/api/run/${RUN}/camera/latest.jpg`)).status, `case ${i}`).toBe(404);
    }
  });
});

describe("a public handle", () => {
  test("has no live frame route: a 404 before anything is read, for a run that has frames", async () => {
    const l = layout(3);
    const h = handle(l, true);
    // The run itself is published to this handle: the 404 is the route's, not the run's.
    expect((await get(h, `/api/run/${RUN}`)).status).toBe(200);
    for (const p of ["latest", "latest.jpg"]) {
      for (const method of ["GET", "HEAD"]) {
        const res = await get(h, `/api/run/${RUN}/camera/${p}`, method);
        expect(res.status, `${method} ${p}`).toBe(404);
        expect(res.headers.get("content-type") ?? "", p).not.toContain("image/jpeg");
        expect(res.headers.get("x-camera-seq"), p).toBeNull();
      }
    }
  });
});
