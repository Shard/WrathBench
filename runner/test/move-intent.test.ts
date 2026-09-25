/**
 * Movement intention, end to end below the canvas: the sandbox's watched
 * `move_to` dispatch, the rows the loop writes for it, and the two viewer
 * reads the map is built on.
 *
 * Fixture-based, no game stack: a stand-in module acks the `move_to` the real
 * sandbox child POSTs, and the verdict is fed into the child's own event
 * stream the way `death.test.ts` feeds frames. The loop half runs the real
 * `ContextBuilder` over a fake sandbox.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRunConfig } from "../src/config";
import { ContextBuilder } from "../src/loop";
import { SandboxHost } from "../src/sandbox/host";
import type { MoveIntentNote } from "../src/sandbox/ipc";
import { Workspace } from "../src/workspace";
import { Trajectory, readTrajectory } from "../src/trajectory";
import { Watchdogs } from "../src/watchdogs";
import { readMoves } from "../viewer/runs";
import { readLatestMove, readPositions } from "../viewer/positions";

/** The snapshot the loop reads, with a `move` slot the test rewrites in place. */
function harness(slot: { move: MoveIntentNote | null }) {
  const dir = mkdtempSync(join(tmpdir(), "wrathbench-move-"));
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
    workspace: new Workspace(join(dir, "workspace")),
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

function moveRows(dir: string): Record<string, unknown>[] {
  const db = new Database(join(dir, "run.sqlite"), { readonly: true });
  try {
    return db.query(`SELECT * FROM move ORDER BY rowid`).all() as Record<string, unknown>[];
  } finally {
    db.close();
  }
}

const DISPATCH: MoveIntentNote = {
  moveId: null,
  map: 0,
  x: -6100,
  y: 400,
  z: 380,
  target: "Marshal McBride",
  status: null,
  ts: 1_000_500,
  endedAt: null,
};

describe("the loop records what the sandbox is trying to reach", () => {
  test("a dispatch and its verdict are two rows, and the samples between them are none", async () => {
    const slot: { move: MoveIntentNote | null } = { move: null };
    const h = harness(slot);
    await h.tick();
    expect(moveRows(h.dir)).toEqual([]);

    slot.move = { ...DISPATCH };
    await h.tick();
    // Re-reported unchanged on every 5s tick: the intent is one slot in the
    // child, not an event, so the row must not be written again.
    await h.tick();
    await h.tick();
    expect(moveRows(h.dir).length).toBe(1);

    // The ack arriving names the move without re-recording the dispatch.
    slot.move = { ...DISPATCH, moveId: 4 };
    await h.tick();
    expect(moveRows(h.dir).length).toBe(1);

    slot.move = { ...DISPATCH, moveId: 4, status: "too_far", endedAt: 1_000_900 };
    await h.tick();
    const rows = moveRows(h.dir);
    expect(rows.length).toBe(2);
    expect(rows[0]).toMatchObject({ ts: 1_000_500, status: null, target: "Marshal McBride", map: 0 });
    expect(rows[1]).toMatchObject({ ts: 1_000_900, status: "too_far", move_id: 4 });
    // Ungated by `stateIntervalMs`: every tick above was 5s, and the run has
    // not written a single state row yet.
    const db = new Database(join(h.dir, "run.sqlite"), { readonly: true });
    const states = db.query(`SELECT COUNT(*) AS n FROM state`).get() as { n: number };
    db.close();
    expect(states.n).toBe(1); // the first sample only, which starts the clock

    // The same facts in the trajectory, for a reader with no sqlite.
    const records = readTrajectory(h.dir).filter((r) => r.t === "move");
    expect(records.length).toBe(2);
    expect(records[1]).toMatchObject({ status: "too_far", x: -6100, y: 400 });
  });

  test("a move dispatched with no verdict yet is recorded as walking", async () => {
    const slot: { move: MoveIntentNote | null } = { move: { ...DISPATCH, target: null } };
    const h = harness(slot);
    await h.tick();
    expect(moveRows(h.dir)[0]).toMatchObject({ status: null, target: null });
  });
});

/* ---------- the viewer reads ---------- */

/** A run directory with the rows given, and no `move` table when `moves` is undefined. */
function runFixture(moves?: [number, number | null, number, number, number, number, string | null, string | null][]): string {
  const runsDir = mkdtempSync(join(tmpdir(), "wrathbench-move-runs-"));
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

describe("readMoves", () => {
  test("a run recorded before the table existed has no intentions, not an error", () => {
    const runsDir = runFixture();
    expect(readMoves(runsDir, "live-1")).toEqual([]);
    expect(readLatestMove(runsDir, "live-1")).toBeNull();
  });

  test("rows come back oldest first, and the newest is the one the map draws", () => {
    const runsDir = runFixture([
      [1000, 1, 0, -6100, 400, 380, "Marshal McBride", null],
      [1400, 1, 0, -6100, 400, 380, "Marshal McBride", "arrived"],
      [2000, 2, 0, -5000, 900, 370, null, null],
    ]);
    const moves = readMoves(runsDir, "live-1");
    expect(moves.map((m) => m.ts)).toEqual([1000, 1400, 2000]);
    expect(moves[1]!.status).toBe("arrived");
    expect(readLatestMove(runsDir, "live-1")).toMatchObject({ ts: 2000, target: null, x: -5000 });
  });

  test("the position feed carries the newest intention beside the pip", () => {
    const runsDir = runFixture([[1000, 1, 0, -6100, 400, 380, "Marshal McBride", null]]);
    const [p] = readPositions(runsDir);
    expect(p!.move).toMatchObject({ map: 0, x: -6100, y: 400, target: "Marshal McBride", status: null });
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
        return Response.json({ ok: true, token: "t", account: "RUNNER", character: "Fenwick", guid: 7, inWorld: true });
      }
      if (url.pathname === "/action") {
        return req.json().then((body) => {
          const action = String((body as { action?: string }).action);
          return Response.json(
            action === "move_to" ? { ok: true, action, token: "t", moveId: ++moveId } : { ok: true, action, token: "t" },
          );
        });
      }
      return new Response("not found", { status: 404 });
    },
    websocket: { message() {} },
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

function makeHost(moduleUrl: string): SandboxHost {
  const dir = mkdtempSync(join(tmpdir(), "wrathbench-move-sbx-"));
  const host = new SandboxHost({
    moduleUrl,
    token: "test-token",
    workspace: new Workspace(join(dir, "workspace")),
    snippetTimeoutMs: 4_000,
    pingGraceMs: 1_000,
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
