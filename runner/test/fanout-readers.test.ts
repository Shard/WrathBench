/**
 * A fan-out run (`<run>/sessions/<Character>/`, one session record per
 * character) through every reader that is not the inspector's own API
 * (`viewer-inspector.test.ts` has that): the run reader answers its row and
 * no one character's reading, the private viewer lists it and names its
 * characters on the run detail, its routes that read "the run's session"
 * answer empty rather than one character or a crash, and a public pass never
 * publishes it while every other run's artifacts stay the bytes they were.
 * The roster's token is in no body anywhere.
 */

import { describe, expect, setSystemTime, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createApi } from "../viewer/api";
import { createRenderer, type SnapshotResult } from "../viewer/snapshot";
import { bestLevelOf, fanoutCharacters, isFanoutRunDir, isV1RunDir, latestReading, readRunRow, readStateSamples } from "../src/run-reader";
import { FANOUT_ROSTER_TOKEN, FANOUT_RUN, writeFanoutRun } from "./fixtures/fanout";
import { DEAD_RUN, poisonedRunsDir } from "./fixtures/poisoned-runs";
import { tempDirs } from "./fixtures/temp-dirs";
import { V1P1_RUN, materialiseV1p1 } from "./fixtures/v1p1";

const tempDir = tempDirs();

const handleFor = (runs: string, publicMode: boolean) => createApi({ runsDir: runs, tilesDir: join(runs, "no-tiles"), publicMode, moduleUrl: "http://127.0.0.1:1" });
const get = async (h: (req: Request) => Promise<Response>, path: string): Promise<Response> => await h(new Request(`http://127.0.0.1:8090${path}`));

describe("the run reader over a fan-out run", () => {
  test("its row is meta.json's, and it has no one reading: no samples, no latest reading, no best level", async () => {
    const runs = tempDir("fanout-reader-");
    const dir = await writeFanoutRun(runs);
    expect(isFanoutRunDir(dir)).toBe(true);
    expect(isV1RunDir(dir)).toBe(false);
    expect(fanoutCharacters(dir)).toEqual(["Alfa", "Bravo"]);
    expect(readRunRow(dir, FANOUT_RUN)?.["run_id"]).toBe(FANOUT_RUN);
    expect(readStateSamples(dir, FANOUT_RUN)).toEqual([]);
    expect(latestReading(dir, FANOUT_RUN)).toBeNull();
    expect(bestLevelOf(dir, FANOUT_RUN)).toBeNull();
    // A single-character run is not a fan-out run.
    expect(isFanoutRunDir(materialiseV1p1(runs))).toBe(false);
  });

  test("meta.json's launch config says fan-out before any character's record exists", async () => {
    const runs = tempDir("fanout-reader-early-");
    const dir = await writeFanoutRun(runs, { characters: [] });
    expect(existsSync(join(dir, "sessions"))).toBe(false);
    expect(isFanoutRunDir(dir)).toBe(true);
    expect(fanoutCharacters(dir)).toEqual([]);
  });
});

describe("the private viewer over a fan-out run", () => {
  test("it is listed, its detail names its characters, and a single run's detail has no such field", async () => {
    const runs = tempDir("fanout-viewer-");
    materialiseV1p1(runs);
    await writeFanoutRun(runs);
    const h = handleFor(runs, false);
    const listed = (await (await get(h, "/api/runs")).json()) as { runs: { runId: string }[] };
    expect(listed.runs.map((r) => r.runId).sort()).toEqual([FANOUT_RUN, V1P1_RUN].sort());
    const detail = (await (await get(h, `/api/run/${FANOUT_RUN}`)).json()) as { fanout?: unknown; run: { level: number | null } };
    expect(detail.fanout).toEqual([
      { id: `${FANOUT_RUN}~Alfa`, character: "Alfa" },
      { id: `${FANOUT_RUN}~Bravo`, character: "Bravo" },
    ]);
    // No one character's level stands for the run.
    expect(detail.run.level).toBeNull();
    const single = (await (await get(h, `/api/run/${V1P1_RUN}`)).json()) as Record<string, unknown>;
    expect("fanout" in single).toBe(false);
  });

  test("its routes that read the run's one session answer empty, never a character or an error", async () => {
    const runs = tempDir("fanout-viewer-routes-");
    await writeFanoutRun(runs);
    const h = handleFor(runs, false);
    for (const route of ["", "/track", "/trace", "/nearby?span=60000", "/entries?limit=10", "/scratchpad"]) {
      const res = await get(h, `/api/run/${FANOUT_RUN}${route}`);
      const text = await res.text();
      expect({ route, ok: res.status === 200 || res.status === 404 }).toEqual({ route, ok: true });
      expect({ route, leaked: text.includes(FANOUT_ROSTER_TOKEN) }).toEqual({ route, leaked: false });
    }
    const track = (await (await get(h, `/api/run/${FANOUT_RUN}/track`)).json()) as { points: unknown[]; trace?: unknown };
    expect(track.points).toEqual([]);
    expect(track.trace).toBeUndefined();
    const trace = (await (await get(h, `/api/run/${FANOUT_RUN}/trace`)).json()) as { segs: unknown[]; tail: unknown };
    expect(trace.segs).toEqual([]);
    expect(trace.tail).toBeNull();
    for (const route of ["/api/runs", "/api/positions", "/api/results?episode=all&includeOverrides=1", "/api/fleet", "/api/models"]) {
      expect({ route, leaked: (await (await get(h, route)).text()).includes(FANOUT_ROSTER_TOKEN) }).toEqual({ route, leaked: false });
    }
  });
});

describe("a public pass beside a fan-out run", () => {
  test("never publishes it, hands it back as withdrawn, and every other artifact is the bytes it was", async () => {
    const runs = poisonedRunsDir();
    // One clock for both passes, so a body's own `now` cannot tell them apart.
    const now = Date.now();
    setSystemTime(now);
    let before: SnapshotResult;
    let after: SnapshotResult;
    try {
      before = await createRenderer({ runsDir: runs })(now);
      await writeFanoutRun(runs);
      after = await createRenderer({ runsDir: runs })(now);
    } finally {
      setSystemTime();
    }
    for (const a of after.artifacts) {
      expect({ path: a.path, named: a.path.includes(FANOUT_RUN) || a.body.includes(FANOUT_RUN) }).toEqual({ path: a.path, named: false });
      expect(a.body).not.toContain(FANOUT_ROSTER_TOKEN);
    }
    expect(after.withdrawn).toEqual([...before.withdrawn, FANOUT_RUN].sort());
    const bodies = (r: SnapshotResult) => new Map(r.artifacts.map((a) => [a.path, a.body]));
    expect(bodies(after)).toEqual(bodies(before));
    // The run beside it is still published.
    expect(after.artifacts.some((a) => a.path.startsWith(`v1/run/${DEAD_RUN}/`))).toBe(true);
  });

  test("the public handle answers it as if it did not exist", async () => {
    const runs = poisonedRunsDir();
    await writeFanoutRun(runs);
    const pub = handleFor(runs, true);
    for (const route of ["", "/track", "/trace", "/entries?limit=10"]) {
      expect({ route, status: (await get(pub, `/api/run/${FANOUT_RUN}${route}`)).status }).toEqual({ route, status: 404 });
    }
    for (const route of ["/api/runs", "/api/results?episode=all&includeOverrides=1", "/api/positions", "/api/models", "/api/episodes"]) {
      expect({ route, named: (await (await get(pub, route)).text()).includes(FANOUT_RUN) }).toEqual({ route, named: false });
    }
    expect(await pub.unpublishedRuns()).toContain(FANOUT_RUN);
  });
});
