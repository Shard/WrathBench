/**
 * The trace's private surface: the inspector's readout over a 0.5 run's `run.sqlite`
 * built in the 0.5 recorder's own schema and over a v1 run's session record
 * (`session/trace`, written by the stack's `SessionWriter`), and the routes and
 * feed fields the viewer serves from it — `/api/run/<id>/trace`,
 * `/api/run/<id>/trace/<t0>`, the track's window list and moves, and the
 * position feed's tail.
 */

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApi } from "../viewer/api";
import type { PositionsResponse, TraceIndexResponse, TraceSegment, TrackResponse } from "../viewer/api-types";
import { CONTEXT_MS, SEG_MS, SETTLE_MS, decodeSegment, unpackSegs, windowOf } from "@wrathbench/inspector/codec/trace";
import { readPositionTrace, readTraceChat, readTraceIndex, readTraceSegment, traceSegsMemo } from "./fixtures/run-readout";
import { sessionKind } from "./fixtures/run-readout";
import { emptyTraceState, type TraceRow as RecordRow } from "@wrathbench/mcp/record";
import { openTestSession, recordDrain, recordedMove, type TestSession } from "./fixtures/v1-session";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();

/** The recorder's table, exactly as the contract fixes it. */
const TRACE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS trace (
    run_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    kind TEXT NOT NULL,
    map INTEGER, x REAL, y REAL, z REAL, o REAL,
    data TEXT
  );
  CREATE INDEX IF NOT EXISTS trace_run_ts ON trace(run_id, ts);`;

type Row = [ts: number, kind: string, pos: [number, number, number, number, number] | null, data: object | null];

/** A run directory the viewer lists: meta, a trajectory, a run row, a fresh state sample and, optionally, trace rows. */
function writeRun(runs: string, runId: string, trace: Row[] | null, stateTs = Date.now()): string {
  const dir = join(runs, runId);
  mkdirSync(dir, { recursive: true });
  const config = { runId, character: "Fixturely", account: "RUNNER", model: "test/model", driver: "openai" };
  writeFileSync(join(dir, "meta.json"), JSON.stringify({ runId, harnessVersion: "harness-test", startedAt: 1000, config }));
  writeFileSync(
    join(dir, "trajectory.jsonl"),
    [{ ts: 1000, t: "meta", runId, config }, { ts: 1100, t: "response", turn: 1 }].map((l) => JSON.stringify(l)).join("\n") + "\n",
  );
  const db = new Database(join(dir, "run.sqlite"));
  db.run(
    `CREATE TABLE run (run_id TEXT, model TEXT, driver TEXT, shakeout TEXT, harness_version TEXT, started_at INTEGER,
       ended_at INTEGER, termination_reason TEXT, termination_detail TEXT, pause_reason TEXT, config_json TEXT)`,
  );
  db.run(`INSERT INTO run VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [runId, "test/model", "openai", null, "harness-test", 1000, null, null, null, null, JSON.stringify(config)]);
  db.run(`CREATE TABLE state (run_id TEXT, ts INTEGER, level INTEGER, xp INTEGER, map INTEGER, x REAL, y REAL, z REAL)`);
  db.run(`INSERT INTO state VALUES (?,?,?,?,?,?,?,?)`, [runId, stateTs, 3, 400, 0, -6240, 380, 385]);
  if (trace !== null) {
    db.exec(TRACE_SCHEMA);
    appendRows(db, runId, trace);
  }
  db.close();
  return dir;
}

function appendRows(db: Database, runId: string, rows: Row[]): void {
  const insert = db.query(`INSERT INTO trace (run_id, ts, kind, map, x, y, z, o, data) VALUES (?,?,?,?,?,?,?,?,?)`);
  for (const [ts, kind, p, data] of rows) {
    insert.run(runId, ts, kind, p?.[0] ?? null, p?.[1] ?? null, p?.[2] ?? null, p?.[3] ?? null, p?.[4] ?? null, data === null ? null : JSON.stringify(data));
  }
}

/** A walk at 1 Hz from `from` to `to`, with the host's key row at every window's start. */
function walk(from: number, to: number, extra: (ts: number) => Row[] = () => []): Row[] {
  const rows: Row[] = [];
  let x = 0;
  for (let ts = from; ts < to; ts += 1000) {
    if (ts % SEG_MS === 0 || ts === from) rows.push([ts, "key", [0, x, 0, 0, 0], { hp: 100, hpMax: 100, level: 3 }]);
    x += 7;
    rows.push([ts + 1, "pos", [0, x, 0, 0, 0], null]);
    rows.push(...extra(ts));
  }
  return rows;
}

/** A boundary in the recent past, so windows on either side of a real `now` are easy to name. */
const W = windowOf(Date.now()) - 10 * SEG_MS;

describe("the trace readout: a run with no trace", () => {
  test("every run before the recorder reads as no trace at all, never as an error", async () => {
    const runs = tempDir("trace-none-");
    writeRun(runs, "r-old", null);
    const now = Date.now();
    expect(await readTraceIndex(runs, "r-old", now)).toEqual({ segMs: SEG_MS, segs: [], tail: null, now });
    expect(await readTraceSegment(runs, "r-old", W, now)).toBeNull();
    expect(await readPositionTrace(runs, "r-old", now)).toBeNull();
    expect(await traceSegsMemo()(runs, "r-old", now)).toBeNull();
    // Nor does a run with no run.sqlite at all.
    expect((await readTraceIndex(runs, "r-missing", now)).segs).toEqual([]);
  });

  test("a trace table with no rows is the same as none", async () => {
    const runs = tempDir("trace-empty-");
    writeRun(runs, "r-empty", []);
    expect((await readTraceIndex(runs, "r-empty", Date.now())).segs).toEqual([]);
    expect(await readPositionTrace(runs, "r-empty", Date.now())).toBeNull();
  });
});

describe("the trace readout: windows", () => {
  const runs = tempDir("trace-windows-");
  // Windows 0 and 1 walked, 2 empty, 3 and 4 walked.
  writeRun(runs, "r1", [...walk(W, W + 2 * SEG_MS), ...walk(W + 3 * SEG_MS, W + 5 * SEG_MS)]);

  test("the index lists the closed windows that have rows, packed, and the tail after them", async () => {
    // Thirty seconds into window 5: window 4 ended but is still settling.
    const now = W + 5 * SEG_MS + 30_000;
    const idx = await readTraceIndex(runs, "r1", now);
    expect(idx.segs).toEqual([
      [W, 2],
      [W + 3 * SEG_MS, 1],
    ]);
    // The tail spans the settling window and the open one.
    expect(idx.tail).toMatchObject({ t0: W + 4 * SEG_MS, t1: W + 6 * SEG_MS });
    expect(decodeSegment(idx.tail!).frames.length).toBeGreaterThan(250);
    // Once it settles, it is closed and the tail is empty.
    const later = await readTraceIndex(runs, "r1", W + 5 * SEG_MS + SETTLE_MS);
    expect(unpackSegs(later.segs)).toEqual([W, W + SEG_MS, W + 3 * SEG_MS, W + 4 * SEG_MS]);
    expect(later.tail).toBeNull();
  });

  test("a window is a segment once, closed or not, and an empty window is none", async () => {
    const now = W + 5 * SEG_MS + 30_000;
    expect(await readTraceSegment(runs, "r1", W + SEG_MS, now)).toMatchObject({ closed: true, segment: { t0: W + SEG_MS, t1: W + 2 * SEG_MS } });
    expect(await (await readTraceSegment(runs, "r1", W + 4 * SEG_MS, now))?.closed).toBe(false);
    expect(await readTraceSegment(runs, "r1", W + 2 * SEG_MS, now)).toBeNull();
    expect(await readTraceSegment(runs, "r1", W + 9 * SEG_MS, now)).toBeNull();
    // The context reaches back across the gap: window 3's keyframe is its own key row.
    const seg = (await readTraceSegment(runs, "r1", W + 3 * SEG_MS, now))!.segment;
    expect(seg.k.s).toMatchObject({ hp: 100, level: 3 });
  });

  test("the position feed's tail is the index's tail, and recent names the closed windows before it", async () => {
    const now = W + 5 * SEG_MS + 30_000;
    const live = (await readPositionTrace(runs, "r1", now))!;
    expect(JSON.stringify(live.tail)).toBe(JSON.stringify((await readTraceIndex(runs, "r1", now)).tail));
    // Windows 1..3 are the three before the tail; 2 has no rows.
    expect(live.recent).toEqual([W + SEG_MS, W + 3 * SEG_MS]);
    expect(CONTEXT_MS).toBe(3 * SEG_MS);
  });

  test("at every moment, every window with rows is reachable from exactly one of the list and the tail", async () => {
    const rdir = tempDir("trace-reach-");
    writeRun(rdir, "r2", walk(W, W + 4 * SEG_MS));
    for (let now = W + 1_000; now < W + 5 * SEG_MS; now += 13_000) {
      const idx = await readTraceIndex(rdir, "r2", now);
      const listed = new Set(unpackSegs(idx.segs));
      for (let w = W; w <= windowOf(Math.min(now, W + 4 * SEG_MS - 1)); w += SEG_MS) {
        const inTail = idx.tail !== null && w >= idx.tail.t0 && w < idx.tail.t1;
        expect(`${now - W} ${w - W}: ${listed.has(w)} ${inTail}`).toBe(`${now - W} ${w - W}: ${!inTail} ${inTail}`);
      }
      // And the live feed names only listed windows.
      for (const w of (await readPositionTrace(rdir, "r2", now))?.recent ?? []) expect(listed.has(w)).toBe(true);
    }
  });

  test("the window list seeks window by window across a long gap", async () => {
    const rdir = tempDir("trace-gap-");
    const far = W - 200 * SEG_MS;
    writeRun(rdir, "r3", [[far + 10, "key", null, {}], [far + SEG_MS + 5, "state", null, { hp: 1 }], [W + 7, "key", null, {}]]);
    expect((await readTraceIndex(rdir, "r3", W + 2 * SEG_MS)).segs).toEqual([
      [far, 2],
      [W, 1],
    ]);
  });

  test("the track's window list follows the file: a write moves it, and a finished run's stays put", async () => {
    const rdir = tempDir("trace-memo-");
    const dir = writeRun(rdir, "r4", walk(W, W + SEG_MS));
    const segs = traceSegsMemo();
    const now = W + 2 * SEG_MS;
    expect(await segs(rdir, "r4", now)).toEqual({ segMs: SEG_MS, segs: [[W, 1]] });
    expect(await segs(rdir, "r4", now + 10 * SEG_MS)).toEqual({ segMs: SEG_MS, segs: [[W, 1]] });
    const db = new Database(join(dir, "run.sqlite"));
    appendRows(db, "r4", walk(W + SEG_MS, W + 2 * SEG_MS));
    db.close();
    expect(await segs(rdir, "r4", now + 10 * SEG_MS)).toEqual({ segMs: SEG_MS, segs: [[W, 2]] });
  });
});

/*
 * The same windows over a v1 run: the rows handed to the stack's session
 * writer, which keys each five-minute segment itself from its fold, and read
 * back through `V1Source` (`traceWindowsBefore`, `withTrace`, `traceStat`,
 * `traceChat`), which answers by segment file rather than by SQL.
 */
describe("the trace readout: windows, a v1 run (session/trace)", () => {
  /** `walk`'s rows as the recorder hands them: a key at the start, then samples; the writer keys each segment. */
  function v1Rows(rows: Row[]): RecordRow[] {
    const out: RecordRow[] = [];
    for (const [ts, kind, p, data] of rows) {
      if (kind === "key" && out.length > 0) continue;
      const pos = p === null ? {} : { map: p[0], x: p[1], y: p[2], z: p[3], o: p[4] };
      if (kind === "key") out.push({ ts, kind: "key", map: p?.[0] ?? null, x: p?.[1] ?? null, y: p?.[2] ?? null, z: p?.[3] ?? null, o: p?.[4] ?? null, data: { ...emptyTraceState(), ...(data as object) } as RecordRow["data"] });
      else out.push({ ts, kind: kind as RecordRow["kind"], ...pos, ...(data === null ? {} : { data: data as RecordRow["data"] }) });
    }
    return out;
  }
  function writeV1Run(runs: string, runId: string, rows: Row[]): TestSession {
    const dir = writeRun(runs, runId, null);
    const last = rows.at(-1)?.[0] ?? W;
    const session = openTestSession(dir, last);
    session.writer.ingest(recordDrain({ trace: v1Rows(rows) }));
    expect(sessionKind(runs, runId)).toBe("v1");
    return session;
  }

  const runs = tempDir("trace-v1-windows-");
  // Windows 0 and 1 walked, 2 empty, 3 and 4 walked, as above.
  writeV1Run(runs, "r1", [...walk(W, W + 2 * SEG_MS), ...walk(W + 3 * SEG_MS, W + 5 * SEG_MS)]);

  test("the index lists the closed windows that have rows, packed, and the tail after them", async () => {
    const now = W + 5 * SEG_MS + 30_000;
    const idx = await readTraceIndex(runs, "r1", now);
    expect(idx.segs).toEqual([
      [W, 2],
      [W + 3 * SEG_MS, 1],
    ]);
    expect(idx.tail).toMatchObject({ t0: W + 4 * SEG_MS, t1: W + 6 * SEG_MS });
    expect(decodeSegment(idx.tail!).frames.length).toBeGreaterThan(250);
    const later = await readTraceIndex(runs, "r1", W + 5 * SEG_MS + SETTLE_MS);
    expect(unpackSegs(later.segs)).toEqual([W, W + SEG_MS, W + 3 * SEG_MS, W + 4 * SEG_MS]);
    expect(later.tail).toBeNull();
  });

  test("a window is a segment once, closed or not, and an empty window is none; a segment's keyframe is the writer's key", async () => {
    const now = W + 5 * SEG_MS + 30_000;
    expect(await readTraceSegment(runs, "r1", W + SEG_MS, now)).toMatchObject({ closed: true, segment: { t0: W + SEG_MS, t1: W + 2 * SEG_MS } });
    expect(await (await readTraceSegment(runs, "r1", W + 4 * SEG_MS, now))?.closed).toBe(false);
    expect(await readTraceSegment(runs, "r1", W + 2 * SEG_MS, now)).toBeNull();
    expect(await readTraceSegment(runs, "r1", W + 9 * SEG_MS, now)).toBeNull();
    // Window 3 follows a gap: its keyframe is the key the writer opened it with, from its fold.
    const seg = (await readTraceSegment(runs, "r1", W + 3 * SEG_MS, now))!.segment;
    expect(seg.k.s).toMatchObject({ hp: 100, level: 3 });
    // And it decodes alone, from its own file.
    expect(decodeSegment(JSON.parse(JSON.stringify(seg))).frames.length).toBeGreaterThan(250);
  });

  test("the position feed's tail is the index's tail, and recent names the closed windows before it", async () => {
    const now = W + 5 * SEG_MS + 30_000;
    const live = (await readPositionTrace(runs, "r1", now))!;
    expect(JSON.stringify(live.tail)).toBe(JSON.stringify((await readTraceIndex(runs, "r1", now)).tail));
    expect(live.recent).toEqual([W + SEG_MS, W + 3 * SEG_MS]);
  });

  test("the window list reaches across a long gap", async () => {
    const rdir = tempDir("trace-v1-gap-");
    const far = W - 200 * SEG_MS;
    writeV1Run(rdir, "r3", [[far + 10, "key", null, {}], [far + SEG_MS + 5, "state", null, { hp: 1 }], [W + 7, "state", null, { hp: 2 }]]);
    expect((await readTraceIndex(rdir, "r3", W + 2 * SEG_MS)).segs).toEqual([
      [far, 2],
      [W, 1],
    ]);
  });

  test("the track's window list follows the record: a write moves it, and a finished run's stays put", async () => {
    const rdir = tempDir("trace-v1-memo-");
    const session = writeV1Run(rdir, "r4", walk(W, W + SEG_MS));
    const segs = traceSegsMemo();
    const now = W + 2 * SEG_MS;
    expect(await segs(rdir, "r4", now)).toEqual({ segMs: SEG_MS, segs: [[W, 1]] });
    expect(await segs(rdir, "r4", now + 10 * SEG_MS)).toEqual({ segMs: SEG_MS, segs: [[W, 1]] });
    session.clock.now = W + 2 * SEG_MS;
    session.writer.ingest(recordDrain({ trace: v1Rows(walk(W + SEG_MS, W + 2 * SEG_MS)).filter((r) => r.kind !== "key") }));
    expect(await segs(rdir, "r4", now + 10 * SEG_MS)).toEqual({ segMs: SEG_MS, segs: [[W, 2]] });
  });

  test("the character's own lines are read back by kind, oldest first, across segments", async () => {
    const rdir = tempDir("trace-v1-chat-");
    writeV1Run(rdir, "r5", [
      [W + 10, "key", [0, 0, 0, 0, 0], { level: 3 }],
      [W + 1_000, "state", null, { chat: [["say", "first words"]] }],
      [W + SEG_MS + 1_000, "state", null, { chat: [["party", "to the group"], ["say", "second words"]] }],
    ]);
    expect(await readTraceChat(rdir, "r5", "say")).toEqual([
      { ts: W + 1_000, text: "first words" },
      { ts: W + SEG_MS + 1_000, text: "second words" },
    ]);
    expect(await readTraceChat(rdir, "r5", "party")).toEqual([{ ts: W + SEG_MS + 1_000, text: "to the group" }]);
    expect(await readTraceChat(rdir, "r5", "yell")).toEqual([]);
  });

  test("the track route carries the windows and the session's movement intentions", async () => {
    const rdir = tempDir("trace-v1-track-");
    const session = writeV1Run(rdir, "r6", walk(W, W + SEG_MS));
    session.writer.ingest(
      recordDrain({
        moves: [
          recordedMove({ ts: W + 5_000, moveId: 1, map: 0, x: 70, y: 0, z: 0 }),
          recordedMove({ ts: W + 9_000, at: W + 5_000, moveId: 1, map: 0, x: 70, y: 0, z: 0, status: "arrived" }),
        ],
      }),
    );
    const handle = createApi({ runsDir: rdir, tilesDir: join(rdir, "tiles"), moduleUrl: "http://127.0.0.1:1" });
    const track = (await (await handle(new Request("http://viewer.local/api/run/r6/track"))).json()) as TrackResponse;
    expect(unpackSegs(track.trace!.segs)).toEqual([W]);
    expect(track.moves?.map((m) => [m.ts, m.status])).toEqual([
      [W + 5_000, null],
      [W + 9_000, "arrived"],
    ]);
  });
});

/* -------------------------------------------------------------- routes --- */

describe("the trace readout: the sheet's dictionary", () => {
  const sheetRows = (): Row[] =>
    walk(W, W + 60_000, (ts) =>
      ts === W
        ? [[ts + 2, "state", null, { money: 5, inv: [[255, 23, 61001, 2]], quests: [[0, 7001, 0, 1]] }]]
        : ts === W + 30_000
          ? [[ts + 2, "state", null, { inv: [[255, 24, 61002]] }]]
          : [],
    );

  test("a segment names exactly the items and quests it references from trace_dict; one the run never named stays an id", async () => {
    const runs = tempDir("trace-dict-");
    const dir = writeRun(runs, "r-dict", sheetRows());
    const db = new Database(join(dir, "run.sqlite"));
    db.run(`CREATE TABLE trace_dict (run_id TEXT NOT NULL, kind TEXT NOT NULL, id INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (run_id, kind, id))`);
    const put = db.query(`INSERT INTO trace_dict VALUES (?, ?, ?, ?)`);
    put.run("r-dict", "item", 61001, JSON.stringify([1, "Test Stone"]));
    put.run("r-dict", "item", 61009, JSON.stringify([1, "Test Token"]));
    put.run("r-dict", "item", 69999, JSON.stringify([4, "Test Unreferenced"]));
    put.run("r-dict", "quest", 7001, JSON.stringify([8, 0, 0, 0, [61009, 3]]));
    put.run("other-run", "item", 61002, JSON.stringify([1, "Another Run's Name"]));
    db.close();
    const seg = (await readTraceSegment(runs, "r-dict", W, W + 2 * SEG_MS))!.segment;
    expect(seg.items).toEqual({ 61001: [1, "Test Stone"], 61009: [1, "Test Token"] });
    expect(seg.qreq).toEqual({ 7001: [8, 0, 0, 0, [61009, 3]] });
    expect(JSON.stringify(seg)).not.toContain("Another Run");
    const d = decodeSegment(seg);
    expect(d.sheetEvents.map((e) => e.kind)).toEqual(["money", "inv", "quests", "inv"]);
  });

  test("a run recorded before trace_dict existed encodes its ids without names, never failing", async () => {
    const runs = tempDir("trace-dict-old-");
    writeRun(runs, "r-old-sheet", sheetRows());
    const seg = (await readTraceSegment(runs, "r-old-sheet", W, W + 2 * SEG_MS))!.segment;
    expect(seg.items).toBeUndefined();
    expect(seg.ev.some((e) => e[1] === "inv")).toBe(true);
    expect((await readPositionTrace(runs, "r-old-sheet", W + 30_000))!.tail!.items).toBeUndefined();
  });
});

describe("the trace routes", () => {
  const now = Date.now();
  const open = windowOf(now);
  const runs = tempDir("trace-routes-");
  // A live run walking through the last three windows, dying in the first of them.
  writeRun(
    runs,
    "r-live",
    walk(open - 3 * SEG_MS, now - 1_000, (ts) =>
      ts === open - 3 * SEG_MS + 60_000
        ? [[ts + 2, "state", null, { hp: 0, dead: true, target: { kind: "player" } }]]
        : ts === open - 3 * SEG_MS + 90_000
          ? [[ts + 2, "state", null, { hp: 50, dead: false, target: null }]]
          : [],
    ),
  );
  writeRun(runs, "r-old", null);
  const handle = createApi({ runsDir: runs, tilesDir: join(runs, "tiles"), moduleUrl: "http://127.0.0.1:1" });
  const publicHandle = createApi({ runsDir: runs, tilesDir: join(runs, "tiles"), moduleUrl: "http://127.0.0.1:1", publicMode: true });
  const get = (h: typeof handle, path: string): Promise<Response> => h(new Request(`http://viewer.local${path}`));

  test("the index answers for a run with a trace and for one without", async () => {
    const res = await get(handle, "/api/run/r-live/trace");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const idx = (await res.json()) as TraceIndexResponse;
    expect(idx.segMs).toBe(SEG_MS);
    expect(unpackSegs(idx.segs)).toContain(open - 3 * SEG_MS);
    expect(idx.tail).not.toBeNull();
    const old = (await (await get(handle, "/api/run/r-old/trace")).json()) as TraceIndexResponse;
    expect(old).toMatchObject({ segMs: SEG_MS, segs: [], tail: null });
  });

  test("a closed window is cached as immutable; the open one is not; an empty or misaligned one is a 404", async () => {
    const closed = await get(handle, `/api/run/r-live/trace/${open - 3 * SEG_MS}`);
    expect(closed.status).toBe(200);
    expect(closed.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const seg = (await closed.json()) as TraceSegment;
    expect(seg.ev.some((e) => e[1] === "dead")).toBe(true);
    const current = await get(handle, `/api/run/r-live/trace/${open}`);
    expect(current.headers.get("cache-control")).toBe("no-store");
    expect((await get(handle, `/api/run/r-live/trace/${open - 9 * SEG_MS}`)).status).toBe(404);
    expect((await get(handle, `/api/run/r-live/trace/${open + 1}`)).status).toBe(404);
    expect((await get(handle, `/api/run/r-old/trace/${open}`)).status).toBe(404);
    expect((await get(handle, `/api/run/no-such-run/trace/${open}`)).status).toBe(404);
  });

  test("in public mode a segment crosses the projection: the death is there, the target is not", async () => {
    const res = await get(publicHandle, `/api/run/r-live/trace/${open - 3 * SEG_MS}`);
    const body = await res.text();
    const seg = JSON.parse(body) as TraceSegment;
    // Deaths are public (operator, 2026-10-18).
    expect(seg.ev.some((e) => e[1] === "dead" && e[2] === true)).toBe(true);
    expect(seg.ev.some((e) => e[1] === "hp" && e[2] === 0)).toBe(true);
    expect(body).not.toContain('"target"');
    expect(body).not.toContain("player");
    const idx = await (await get(publicHandle, "/api/run/r-live/trace")).text();
    expect(idx).not.toContain('"target"');
  });

  test("the track lists the closed windows, and a run with no trace carries no field", async () => {
    const track = (await (await get(handle, "/api/run/r-live/track")).json()) as TrackResponse;
    expect(track.trace?.segMs).toBe(SEG_MS);
    expect(unpackSegs(track.trace!.segs)).toContain(open - 3 * SEG_MS);
    const old = (await (await get(handle, "/api/run/r-old/track")).json()) as TrackResponse;
    expect("trace" in old).toBe(false);
  });

  test("a live position carries its trace; one with none carries no field", async () => {
    const { positions } = (await (await get(handle, "/api/positions")).json()) as PositionsResponse;
    const live = positions.find((p) => p.runId === "r-live")!;
    expect(live.trace?.segMs).toBe(SEG_MS);
    expect(live.trace!.recent.length).toBeGreaterThan(0);
    expect(live.trace!.recent.length).toBeLessThanOrEqual(3);
    expect(live.trace!.tail).not.toBeNull();
    const old = positions.find((p) => p.runId === "r-old")!;
    expect("trace" in old).toBe(false);
  });
});
