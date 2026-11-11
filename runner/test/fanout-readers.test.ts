/**
 * A fan-out run (`<run>/sessions/<Character>/`, one session record per
 * character) through every reader that is not the inspector's own API
 * (`viewer-inspector.test.ts` has that): the run reader answers its row, each
 * character's reading and the lead's roll-up, and no one character's samples
 * as the run's; the private viewer lists it at its lead's level, names its
 * characters on the run detail and its track, and serves each character's
 * replay feed under its session id, while its routes that read "the run's
 * session" answer empty rather than one character or a crash; and a public
 * pass never publishes it while every other run's artifacts stay the bytes
 * they were. The roster's token is in no body anywhere.
 */

import { describe, expect, setSystemTime, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createApi } from "../viewer/api";
import { createRenderer, type SnapshotResult } from "../viewer/snapshot";
import { bestLevelOf, characterSamplesOf, fanoutCharacters, fanoutLead, fanoutReadings, isFanoutRunDir, isV1RunDir, latestReading, parseFanoutSessionId, readRunRow, readStateSamples } from "../src/run-reader";
import { withFanoutLeads } from "../viewer/clickhouse";
import { readRun } from "../viewer/runs";
import type { TrackResponse } from "../viewer/api-types";
import { FANOUT_ROSTER_TOKEN, FANOUT_RUN, writeFanoutRun } from "./fixtures/fanout";
import { DEAD_RUN, poisonedRunsDir } from "./fixtures/poisoned-runs";
import { tempDirs } from "./fixtures/temp-dirs";
import { V1P1_RUN, materialiseV1p1 } from "./fixtures/v1p1";

const tempDir = tempDirs();

const handleFor = (runs: string, publicMode: boolean) => createApi({ runsDir: runs, tilesDir: join(runs, "no-tiles"), publicMode, moduleUrl: "http://127.0.0.1:1" });
const get = async (h: (req: Request) => Promise<Response>, path: string): Promise<Response> => await h(new Request(`http://127.0.0.1:8090${path}`));

describe("the run reader over a fan-out run", () => {
  test("its row is meta.json's, each character has its own reading, and the run's one figure is its lead's", async () => {
    const runs = tempDir("fanout-reader-");
    const dir = await writeFanoutRun(runs);
    expect(isFanoutRunDir(dir)).toBe(true);
    expect(isV1RunDir(dir)).toBe(false);
    expect(fanoutCharacters(dir)).toEqual(["Alfa", "Bravo"]);
    expect(readRunRow(dir, FANOUT_RUN)).toMatchObject({ run_id: FANOUT_RUN, character: null });
    // No one character's curve or reading is the run's: a resume note reads `latestReading`.
    expect(readStateSamples(dir, FANOUT_RUN)).toEqual([]);
    expect(latestReading(dir, FANOUT_RUN)).toBeNull();
    expect(fanoutReadings(dir)).toEqual([
      { character: "Alfa", level: 5, xp: 900, ts: 1762000200000 },
      { character: "Bravo", level: 3, xp: 120, ts: 1762000300000 },
    ]);
    expect(characterSamplesOf(dir, "Bravo").map((r) => r.level)).toEqual([3]);
    expect(characterSamplesOf(dir, "Nobody")).toEqual([]);
    expect(characterSamplesOf(dir, "../Alfa")).toEqual([]);
    expect(fanoutLead(fanoutReadings(dir))).toMatchObject({ character: "Alfa", level: 5, xp: 900 });
    // The scheduler's best level: the highest any character reached.
    expect(bestLevelOf(dir, FANOUT_RUN)).toBe(5);
    // A single-character run is not a fan-out run, and reads as it did.
    const single = materialiseV1p1(runs);
    expect(isFanoutRunDir(single)).toBe(false);
    expect(fanoutReadings(single)).toEqual([]);
  });

  test("the lead is the highest level, then the higher xp, then the first by name; a character with no level is never it", () => {
    const r = (character: string, level: number | null, xp: number | null) => ({ character, level, xp });
    expect(fanoutLead([])).toBeNull();
    expect(fanoutLead([r("Alfa", null, null)])).toBeNull();
    expect(fanoutLead([r("Bravo", 4, 10), r("Alfa", 6, 0)])?.character).toBe("Alfa");
    expect(fanoutLead([r("Alfa", 6, 10), r("Bravo", 6, 50)])?.character).toBe("Bravo");
    expect(fanoutLead([r("Bravo", 6, 50), r("Alfa", 6, 50)])?.character).toBe("Alfa");
    expect(fanoutLead([r("Alfa", 6, null), r("Bravo", 6, 0)])?.character).toBe("Bravo");
  });

  test("a session id names its run and character only when the name is a character's", () => {
    expect(parseFanoutSessionId(`${FANOUT_RUN}~Alfa`)).toEqual({ runId: FANOUT_RUN, character: "Alfa" });
    expect(parseFanoutSessionId(FANOUT_RUN)).toBeNull();
    expect(parseFanoutSessionId("~Alfa")).toBeNull();
    expect(parseFanoutSessionId(`${FANOUT_RUN}~../x`)).toBeNull();
  });

  test("the store's readings roll up to the same lead, under the run's id, with no one character's money", () => {
    const reading = (level: number | null, xp: number | null) => ({ level, xp, money: 7, questsCompleted: 2 });
    const out = withFanoutLeads(
      new Map([
        [`${FANOUT_RUN}~Bravo`, reading(3, 120)],
        [`${FANOUT_RUN}~Alfa`, reading(5, 900)],
        [V1P1_RUN, reading(2, 10)],
      ]),
    );
    expect(out.get(FANOUT_RUN)).toEqual({ level: 5, xp: 900, money: null, questsCompleted: null });
    expect(out.get(V1P1_RUN)).toEqual(reading(2, 10));
    expect(out.get(`${FANOUT_RUN}~Alfa`)).toEqual(reading(5, 900));
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
    const detail = (await (await get(h, `/api/run/${FANOUT_RUN}`)).json()) as { fanout?: unknown; states: unknown[]; run: { level: number | null; xp: number | null; money: number | null; character: string | null } };
    expect(detail.fanout).toEqual([
      { id: `${FANOUT_RUN}~Alfa`, character: "Alfa" },
      { id: `${FANOUT_RUN}~Bravo`, character: "Bravo" },
    ]);
    // The run reads its lead's level and xp, and no one character's name, money or curve.
    expect(detail.run).toMatchObject({ level: 5, xp: 900, money: null, character: null });
    expect(detail.states).toEqual([]);
    // The listing off the store and the run read off its files agree.
    const row = (listed.runs as unknown as { runId: string; level: number | null; xp: number | null }[]).find((r) => r.runId === FANOUT_RUN);
    expect(row).toMatchObject({ level: 5, xp: 900 });
    expect(readRun(runs, FANOUT_RUN)).toMatchObject({ level: 5, xp: 900, character: null });
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

describe("a fan-out character's replay feed", () => {
  test("its run's track names the characters; each character's track, trace and windows are its own record's", async () => {
    const runs = tempDir("fanout-viewer-track-");
    await writeFanoutRun(runs, { closed: true });
    const h = handleFor(runs, false);
    const own = (await (await get(h, `/api/run/${FANOUT_RUN}/track`)).json()) as TrackResponse;
    expect(own.points).toEqual([]);
    expect(own.fanout).toEqual([
      { id: `${FANOUT_RUN}~Alfa`, character: "Alfa" },
      { id: `${FANOUT_RUN}~Bravo`, character: "Bravo" },
    ]);
    for (const [character, level, x] of [["Alfa", 5, -9460], ["Bravo", 3, -9450]] as const) {
      const id = `${FANOUT_RUN}~${character}`;
      const res = await get(h, `/api/run/${id}/track`);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).not.toContain(FANOUT_ROSTER_TOKEN);
      const t = JSON.parse(text) as TrackResponse;
      expect({ runId: t.runId, characterName: t.characterName, travel: t.travel }).toEqual({ runId: id, characterName: character, travel: [] });
      expect(t.points.map((p) => [p.level, p.x])).toEqual([[level, x]]);
      expect(t.model).toBe(own.model);
      const index = (await (await get(h, `/api/run/${id}/trace`)).json()) as { segs: [number, number][] };
      const t0 = index.segs[0]?.[0];
      expect(t0).toBeNumber();
      expect((await get(h, `/api/run/${id}/trace/${t0}`)).status).toBe(200);
    }
    // A name that is not one of its characters, and any other route under a character's id, open nothing.
    for (const path of [`/api/run/${FANOUT_RUN}~Nobody/track`, `/api/run/${FANOUT_RUN}~Alfa`, `/api/run/${FANOUT_RUN}~Alfa/entries`, `/api/run/${FANOUT_RUN}~Alfa/nearby`, `/api/run/nosuchrun~Alfa/track`]) {
      expect({ path, status: (await get(h, path)).status }).toEqual({ path, status: 404 });
    }
  });

  test("a single run's track carries no fanout field", async () => {
    const runs = tempDir("fanout-viewer-single-");
    materialiseV1p1(runs);
    const t = (await (await get(handleFor(runs, false), `/api/run/${V1P1_RUN}/track`)).json()) as Record<string, unknown>;
    expect("fanout" in t).toBe(false);
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
    // Nor its characters, under their own ids.
    for (const route of ["/track", "/trace"]) {
      expect({ route, status: (await get(pub, `/api/run/${FANOUT_RUN}~Alfa${route}`)).status }).toEqual({ route, status: 404 });
    }
    for (const route of ["/api/runs", "/api/results?episode=all&includeOverrides=1", "/api/positions", "/api/models", "/api/episodes"]) {
      expect({ route, named: (await (await get(pub, route)).text()).includes(FANOUT_RUN) }).toEqual({ route, named: false });
    }
    expect(await pub.unpublishedRuns()).toContain(FANOUT_RUN);
  });
});
