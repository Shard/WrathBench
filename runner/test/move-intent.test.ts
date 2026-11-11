/**
 * Movement intention, end to end below the canvas: the sandbox's watched
 * `move_to` dispatch, the session record's `move` rows the stack writes for it
 * (`session/calls`), the trajectory's mirror of them, and the two viewer reads
 * the map is built on, over a v1 run's record and a 0.5 run's `move` table.
 *
 * Fixture-based, no game stack: a stand-in module acks the `move_to` the real
 * sandbox child POSTs, and the verdict is fed into the child's own event
 * stream the way `death.test.ts` feeds frames. The loop half runs the real
 * `ContextBuilder` over a fake sandbox.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadRunConfig } from "../src/config";
import { ContextBuilder } from "../src/loop";
import { SandboxHost } from "../src/sandbox/host";
import type { MoveIntentNote } from "@wrathbench/mcp";
import { Scratchpad } from "@wrathbench/mcp";
import { Trajectory, readTrajectory } from "../src/trajectory";
import { Watchdogs } from "../src/watchdogs";
import { readMoves } from "../viewer/runs";
import { sessionSource } from "../viewer/session-source";
import { SessionReader } from "@wrathbench/mcp/record";
import { openSessionRecord, sessionDirOf, type SessionRecord } from "../src/session-record";
import { TrajectoryTail } from "../viewer/tail";
import { openTestSession, recordDrain, recordedMove } from "./fixtures/v1-session";
import { readLatestMove, readPositions } from "../viewer/positions";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();

/** The snapshot the loop reads, with a `move` slot the test rewrites in place. */
function harness(slot: { move: MoveIntentNote | null }) {
  const dir = tempDir("wrathbench-move-");
  let clock = 1_000_000;
  const config = {
    ...loadRunConfig({ driver: "stub", stateIntervalMs: 60_000 }),
    runId: "run-move",
    token: "run-move",
  };
  const trajectory = new Trajectory(dir);
  trajectory.writeMeta({ runId: "run-move", harnessVersion: "t", startedAt: 1, config });
  const sandbox = {
    evalSnippet: () => Promise.resolve({ ok: true, value: "", logs: [], durationMs: 1 }),
    recentEvents: () => Promise.resolve([]),
    stateSnapshot: () =>
      Promise.resolve({ self: { guid: "7" }, lastSeq: 1, eventCount: 1, move: slot.move }),
    totalRestarts: 0,
    consecutiveRestarts: 0,
    drainNotices: () => [],
    stop: () => Promise.resolve(),
  } as unknown as SandboxHost;
  const ctx = new ContextBuilder({
    config,
    sandbox,
    scratchpad: new Scratchpad(join(dir, "scratchpad.md")),
    trajectory,
    watchdogs: new Watchdogs(config.watchdogs),
    now: () => clock,
  });
  return {
    dir,
    trajectory,
    /** One 5s tick of the state ticker — far short of the 60s row cadence. */
    tick: async (): Promise<void> => {
      clock += 5_000;
      await ctx.sampleState();
    },
  };
}

const DISPATCH: MoveIntentNote = {
  moveId: null,
  map: 0,
  x: -6100,
  y: 400,
  z: 380,
  target: "Warden Oakhollow",
  status: null,
  ts: 1_000_500,
  endedAt: null,
};

describe("the loop's samples record no movement intention", () => {
  test("a dispatch and its verdict on the snapshot write nothing: the record is the stack's", async () => {
    // The intention is recorded where it is watched, in the sandbox child, and
    // written by the stack's session writer (below). A sample that still wrote
    // one would be a second, later copy of the same dispatch.
    const slot: { move: MoveIntentNote | null } = { move: null };
    const h = harness(slot);
    await h.tick();
    slot.move = { ...DISPATCH };
    await h.tick();
    slot.move = { ...DISPATCH, moveId: 4, status: "too_far", endedAt: 1_000_900 };
    await h.tick();
    expect(readTrajectory(h.dir).filter((r) => r.t === "move")).toEqual([]);
    expect(existsSync(join(h.dir, "run.sqlite"))).toBe(false);
  });
});

/* ---------- the viewer reads ---------- */

/** A run directory with the rows given, and no `move` table when `moves` is undefined. */
function runFixture(moves?: [number, number | null, number, number, number, number, string | null, string | null][]): string {
  const runsDir = tempDir("wrathbench-move-runs-");
  const dir = join(runsDir, "live-1");
  mkdirSync(dir);
  writeFileSync(
    join(dir, "meta.json"),
    JSON.stringify({
      runId: "live-1",
      harnessVersion: "harness-0.5",
      startedAt: 1,
      config: { model: "a/model", character: "Char", driver: "openai" },
    }),
  );
  writeFileSync(join(dir, "trajectory.jsonl"), "");
  const db = new Database(join(dir, "run.sqlite"));
  db.exec(`CREATE TABLE run (run_id TEXT PRIMARY KEY, harness_version TEXT, started_at INTEGER,
    ended_at INTEGER, driver TEXT, shakeout TEXT, model TEXT,
    termination_reason TEXT, termination_detail TEXT, pause_reason TEXT, config_json TEXT);
    CREATE TABLE state (run_id TEXT, ts INTEGER, level INTEGER, xp INTEGER, map INTEGER,
      x REAL, y REAL, z REAL, money INTEGER, quests_completed INTEGER);`);
  db.query(`INSERT INTO run (run_id, model, config_json) VALUES (?, ?, ?)`).run("live-1", "a/model", "{}");
  db.query(`INSERT INTO state VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    "live-1",
    Date.now() - 5_000,
    4,
    900,
    0,
    -6240,
    380,
    380,
    12,
    1,
  );
  if (moves !== undefined) {
    db.exec(`CREATE TABLE move (run_id TEXT, ts INTEGER, move_id INTEGER, map INTEGER,
      x REAL, y REAL, z REAL, target TEXT, status TEXT)`);
    for (const m of moves)
      db.query(`INSERT INTO move VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(...(["live-1", ...m] as never[]));
  }
  db.close();
  return runsDir;
}

/** A creature guid the fixture's named moves are aimed at. */
const WARDEN_GUID = ((0xf130n << 48n) | (4101n << 24n) | 9n).toString(10);

/**
 * The same run as a v1 run: the state row in run.sqlite, the moves in its
 * session record (`session/calls`), written by the stack's writer.
 */
async function v1RunFixture(moves: [number, number | null, number, number, number, number, string | null, string | null][]): Promise<string> {
  const runsDir = runFixture();
  const { writer } = openTestSession(join(runsDir, "live-1"), Date.now());
  writer.ingest(
    recordDrain({
      // Where the character stands: a v1 run's map reads it off the record's `live.json`.
      trace: [{ ts: Date.now() - 5_000, kind: "pos", map: 0, x: -6240, y: 380, z: 380, o: 0 }],
      moves: moves.map(([ts, moveId, map, x, y, z, name, status]) =>
        recordedMove({ ts, moveId, map, x, y, z, status, ...(name !== null ? { target: WARDEN_GUID, name } : {}) }),
      ),
    }),
  );
  await writer.close();
  return runsDir;
}

describe("readMoves over a v1 run's session record", () => {
  test("a session with no move rows has no intentions", async () => {
    const runsDir = await v1RunFixture([]);
    expect(sessionSource(runsDir, "live-1").kind).toBe("v1");
    expect(readMoves(runsDir, "live-1")).toEqual([]);
    expect(readLatestMove(runsDir, "live-1")).toBeNull();
  });

  test("rows come back oldest first, and the newest is the one the map draws", async () => {
    const runsDir = await v1RunFixture([
      [1000, 1, 0, -6100, 400, 380, "Warden Oakhollow", null],
      [1400, 1, 0, -6100, 400, 380, "Warden Oakhollow", "arrived"],
      [2000, 2, 0, -5000, 900, 370, null, null],
    ]);
    expect(sessionSource(runsDir, "live-1").kind).toBe("v1");
    const moves = readMoves(runsDir, "live-1");
    expect(moves.map((m) => m.ts)).toEqual([1000, 1400, 2000]);
    // The map shows the target's name, never its guid.
    expect(moves[0]).toEqual({ ts: 1000, map: 0, x: -6100, y: 400, z: 380, target: "Warden Oakhollow", status: null });
    expect(moves[1]!.status).toBe("arrived");
    expect(readLatestMove(runsDir, "live-1")).toMatchObject({ ts: 2000, target: null, x: -5000 });
  });

  test("the position feed carries the newest intention beside the pip", async () => {
    const runsDir = await v1RunFixture([[1000, 1, 0, -6100, 400, 380, "Warden Oakhollow", null]]);
    const [p] = readPositions(runsDir);
    expect(p!.move).toMatchObject({ map: 0, x: -6100, y: 400, target: "Warden Oakhollow", status: null });
  });
});

describe("readMoves over a 0.5 run's move table", () => {
  test("a run recorded before the table existed has no intentions, not an error", () => {
    const runsDir = runFixture();
    expect(readMoves(runsDir, "live-1")).toEqual([]);
    expect(readLatestMove(runsDir, "live-1")).toBeNull();
  });

  test("rows come back oldest first, and the newest is the one the map draws", () => {
    const runsDir = runFixture([
      [1000, 1, 0, -6100, 400, 380, "Warden Oakhollow", null],
      [1400, 1, 0, -6100, 400, 380, "Warden Oakhollow", "arrived"],
      [2000, 2, 0, -5000, 900, 370, null, null],
    ]);
    const moves = readMoves(runsDir, "live-1");
    expect(moves.map((m) => m.ts)).toEqual([1000, 1400, 2000]);
    expect(moves[1]!.status).toBe("arrived");
    expect(readLatestMove(runsDir, "live-1")).toMatchObject({ ts: 2000, target: null, x: -5000 });
  });

  test("the position feed carries the newest intention beside the pip", () => {
    const runsDir = runFixture([[1000, 1, 0, -6100, 400, 380, "Warden Oakhollow", null]]);
    const [p] = readPositions(runsDir);
    expect(p!.move).toMatchObject({ map: 0, x: -6100, y: 400, target: "Warden Oakhollow", status: null });
  });
});


/* ---------- the sandbox's own capture ---------- */

const hosts: SandboxHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0, hosts.length).map((h) => h.stop()));
});

/** A stand-in module that acks `move_to` with a move id and sends no verdict. */
function startModuleStub(): { url: string; stop(): Promise<void> } {
  let moveId = 0;
  const server = Bun.serve<{ token: string }, never>({
    port: 0,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/events") {
        return srv.upgrade(req, { data: { token: "" } }) ? undefined : new Response("no", { status: 400 });
      }
      if (url.pathname === "/session" && req.method === "POST") {
        return Response.json({ ok: true, account: "RUNNER", character: "Fenwick", guid: 7, inWorld: true });
      }
      if (url.pathname === "/action") {
        return req.json().then((body) => {
          const action = String((body as { action?: string }).action);
          return Response.json(
            action === "move_to" ? { ok: true, action, moveId: ++moveId } : { ok: true, action },
          );
        });
      }
      return new Response("not found", { status: 404 });
    },
    websocket: { message() {} },
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

function makeHost(moduleUrl: string, session?: SessionRecord): SandboxHost {
  const dir = tempDir("wrathbench-move-sbx-");
  const host = new SandboxHost({
    moduleUrl,
    token: "test-token",
    scratchpad: new Scratchpad(join(dir, "scratchpad.md")),
    snippetTimeoutMs: 4_000,
    pingGraceMs: 1_000,
    ...(session !== undefined ? { session } : {}),
  });
  hosts.push(host);
  return host;
}

describe("the sandbox watches the dispatch, not the SDK call", () => {
  test("a moveToAsync nobody awaits is on the snapshot, and its verdict ends it", async () => {
    const stub = startModuleStub();
    const host = makeHost(stub.url);
    await host.evalSnippet("await connect(); await sdk.createSession({ character: 'Fenwick' });");
    // Not awaited for a verdict: the async form is the one the SDK's own hints
    // steer long walks towards, and it is the one an in-SDK result hook would
    // never see settle.
    const sent = await host.evalSnippet("await sdk.moveToAsync({ x: -6100, y: 400, z: 380 })");
    expect(sent.ok).toBe(true);
    const walking = (await host.stateSnapshot())["move"] as Record<string, unknown>;
    expect(walking).toMatchObject({ x: -6100, y: 400, z: 380, status: null, target: null });
    expect(walking["moveId"]).toBe(1);

    // The module's verdict, on the stream the client is already listening to.
    await host.evalSnippet(
      `events.ingest(JSON.stringify({ seq: 1, opcode: "WB_MOVE_RESULT", opcodeId: 0xff02, ts: 2000,` +
        ` data: { moveId: 1, status: "too_far", pos: { x: -6200, y: 390, z: 380, o: 0 } } }))`,
    );
    const settled = (await host.stateSnapshot())["move"] as Record<string, unknown>;
    expect(settled["status"]).toBe("too_far");
    expect(settled["endedAt"]).toBe(2000);

    await stub.stop();
  });
});

describe("the stack records the intention, and the map and the feed read it there", () => {
  test("a dispatch and its verdict are two move rows in session/calls, read by the map and the feed, and not in the trajectory", async () => {
    const stub = startModuleStub();
    const runsDir = tempDir("wrathbench-move-v1-");
    const runDir = join(runsDir, "run-move-v1");
    const trajectory = new Trajectory(runDir);
    const session = openSessionRecord({ runDir, runsDir, token: "test-token", scrub: (t) => trajectory.scrub(t) });
    const host = makeHost(stub.url, session);
    await host.evalSnippet("await connect(); await sdk.createSession({ character: 'Fenwick' });");
    expect((await host.evalSnippet("await sdk.moveToAsync({ x: -6100, y: 400, z: 380 })")).ok).toBe(true);
    await host.recordDrain();
    // The verdict's own instant, after the dispatch's (which is the child's clock).
    const VERDICT = Date.now() + 500;
    await host.evalSnippet(
      `events.ingest(JSON.stringify({ seq: 1, opcode: "WB_MOVE_RESULT", opcodeId: 0xff02, ts: ${VERDICT},` +
        ` data: { moveId: 1, status: "too_far", pos: { x: -6200, y: 390, z: 380, o: 0 } } }))`,
    );
    await host.recordDrain();

    const rows = new SessionReader(sessionDirOf(runDir)).rows("calls").filter((r) => r.kind === "move");
    expect(rows.map((r) => (r as { status: string | null }).status)).toEqual([null, "too_far"]);
    // Both rows carry the dispatch's own instant.
    const at = (rows[0] as { at: number }).at;
    expect((rows[1] as { at: number }).at).toBe(at);
    expect(rows[1]).toMatchObject({ ts: VERDICT, moveId: 1, x: -6100, y: 400, z: 380, target: null });

    // The map reads the record.
    expect(sessionSource(runsDir, "run-move-v1").kind).toBe("v1");
    expect(readMoves(runsDir, "run-move-v1").map((m) => m.status)).toEqual([null, "too_far"]);
    expect(readLatestMove(runsDir, "run-move-v1")).toMatchObject({ ts: VERDICT, status: "too_far", x: -6100 });

    // The trajectory is the model side: no mirror. The run page's feed reads the record.
    expect(readTrajectory(runDir).filter((r) => r.t === "move")).toEqual([]);
    writeFileSync(join(runDir, "trajectory.jsonl"), "");
    const tail = new TrajectoryTail(join(runDir, "trajectory.jsonl"));
    await tail.scan();
    const fed = tail.entries.filter((e) => e.t === "move");
    expect(fed.map((e) => e["status"])).toEqual([null, "too_far"]);
    expect(JSON.parse((await tail.raw(fed[1]!.i))!)).toMatchObject({ t: "move", ts: VERDICT, moveId: 1, x: -6100, y: 400, z: 380 });

    await host.stop();
    await session.writer.close();
    trajectory.close();
    await stub.stop();
  });
});
