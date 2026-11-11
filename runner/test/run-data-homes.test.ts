/**
 * A run as this build writes it, end to end: launched through run.ts with the
 * stub driver, then read back by the viewer and by the collector. It pins
 * where each fact a run records lives — the session record (the trace, the
 * ring, the stack's copy of the action log and the movement intentions) in
 * `session/`, written by the stack; run.sqlite holding the run row and the
 * state samples and nothing of the session's; no trace in trajectory.jsonl and
 * no `trace.jsonl` beside it; the module session token in meta.json as the
 * harness's one copy — and that the readers still get the whole run.
 *
 * The token has one other way into a trajectory, which the stub never takes:
 * the module names it in its action replies, and a snippet that logs a reply
 * records it in its result, as the model saw it. So the fixture appends such a
 * result, the way a real run carries one, and the test pins that the record
 * keeps it while neither the derived store nor a public body does.
 *
 * A public handle withholds every run whose driver is not a model (operator,
 * 2026-10-20), the stub's included, so once the stub has written the run its
 * run row is relabelled as a model's: what a public body would carry is the
 * question here, not which driver wrote the bytes.
 */
import { readRunRow } from "../src/run-reader";
import { beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApi } from "../viewer/api";
import { loadRunConfig, newSessionToken } from "../src/config";
import { EpisodicLog } from "../src/episodic";
import { Trajectory, readMeta, readTrajectory } from "../src/trajectory";
import { Collector } from "../../collector/src/collector";
import { memorySink } from "../../collector/src/sink";
import { OffsetStore } from "../../collector/src/offsets";
import { readConfig } from "../../collector/src/config";
import { SessionReader, emptyTraceState } from "@wrathbench/mcp/record";
import { tokenFingerprint } from "@wrathbench/mcp/module-auth";
import { openSessionRecord, sessionDirOf } from "../src/session-record";
import { SEG_MS, windowOf } from "../viewer/trace";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();
const RUN_TS = join(import.meta.dir, "..", "src", "run.ts");
const RUN_ID = "run-homes";
/** A run from before token hardening: its token was its own run id. */
const OLD_ID = "run-20260820-101010";
/** An unterminated run with a fresh position, so it is on the live map. */
const LIVE_ID = "run-homes-live";

let runsDir = "";
let token = "";
let liveToken = "";

/** What the live character says on its trace, beside its token, and a credential's shape the publisher's scan would refuse. */
const CHAT_SAID = "my session is";
const CHAT_KEY = `sk-ant-${"a".repeat(24)}`;

/** What a snippet that logged a `move_to` reply leaves in its result. */
const echo = (t: string): string => `[log] { ok: true, action: "move_to", token: "${t}", moveId: 23 }`;

beforeAll(async () => {
  runsDir = tempDir("wrathbench-homes-");
  const script = join(runsDir, "stub.json");
  writeFileSync(script, JSON.stringify([1, 2, 3].map((i) => ({ content: `turn ${i}`, toolCalls: [] }))));
  const proc = Bun.spawn({
    cmd: [
      process.execPath, RUN_TS,
      "--driver", "stub", "--stub", script,
      "--run-id", RUN_ID,
      "--episode", "e90",
      "--module-url", "http://127.0.0.1:9",
      "--step-interval-ms", "0",
      "--runs-dir", runsDir,
    ],
    cwd: runsDir,
    env: { ...process.env, WRATHBENCH_MODULE_URL: "http://127.0.0.1:9", WRATHBENCH_MODULE_SECRET: undefined },
    stdout: "ignore",
    stderr: "pipe",
  });
  const stderr = await new Response(proc.stderr).text();
  if ((await proc.exited) !== 0) throw new Error(`run.ts exited non-zero: ${stderr.slice(-2000)}`);
  const dir = join(runsDir, RUN_ID);
  token = readMeta(dir)!.config.token!;
  appendFileSync(join(dir, "trajectory.jsonl"), `${JSON.stringify({ ts: Date.now(), t: "snippet_result", turn: 3, name: "eval_snippet", isError: false, text: echo(token) })}\n`);
  writeFileSync(join(dir, "scratchpad.md"), `notes\nsession ${token}\n`);
  asModelRun(dir);

  const old = join(runsDir, OLD_ID);
  const traj = new Trajectory(old);
  traj.writeMeta({ runId: OLD_ID, harnessVersion: "0.0.0-test", startedAt: 1, config: loadRunConfig({ runId: OLD_ID, token: OLD_ID, driver: "openai", model: "test/model" }) });
  traj.append({ t: "snippet_result", turn: 1, name: "eval_snippet", isError: false, text: echo(OLD_ID) });
  traj.close();

  // A character on the map right now, whose last status line quotes its token.
  const live = join(runsDir, LIVE_ID);
  liveToken = newSessionToken();
  const lt = new Trajectory(live);
  lt.writeMeta({ runId: LIVE_ID, harnessVersion: "0.0.0-test", startedAt: Date.now() - 60_000, config: loadRunConfig({ runId: LIVE_ID, token: liveToken, driver: "openai", model: "test/model" }) });
  // Its trace, where it said its token and something shaped like a key: in a
  // window long closed, and in the tail. Written as run.ts writes a v1 run's,
  // by the stack's session writer into session/, through the run's scrub.
  const closedAt = windowOf(Date.now() - 4 * SEG_MS);
  const tailAt = Date.now() - 5_000;
  const said = `${CHAT_SAID} ${liveToken} and ${CHAT_KEY}`;
  const session = openSessionRecord({ runDir: live, runsDir, token: liveToken, scrub: (text) => lt.scrub(text) });
  session.writer.ingest({
    trace: {
      rows: [
        { ts: closedAt + 1_000, kind: "key", map: 0, x: -6240, y: 330, z: 383, o: 0, data: { ...emptyTraceState(), level: 3, xp: 120 } },
        { ts: tailAt - 1_000, kind: "pos", map: 0, x: -6240, y: 330, z: 383, o: 0 },
        { ts: closedAt + 2_000, kind: "state", data: { chat: [["party", said]] } },
        { ts: tailAt, kind: "state", data: { chat: [["say", said]] } },
      ],
      dropped: 0,
    },
    events: { rows: [], dropped: 0 },
    nearby: { rows: [], dropped: 0, through: 0 },
    moves: [],
    character: { guid: "7", name: "Homeswick", race: 1, class: 1 },
    stream: { connected: true, events: 1, seq: 1 },
  });
  await session.writer.close();
  lt.close();
  new EpisodicLog(join(live, "episodic.jsonl")).append({ turn: 4, level: 3, text: `parked, session ${liveToken} still held` });
}, 30_000);

/**
 * The stub's run, relabelled as a model's: the driver and the stamp in its
 * meta.json, which is what the readers judge a run by. The trajectory keeps
 * what the stub wrote, which the first test below reads.
 */
function asModelRun(dir: string): void {
  // The stamp and the driver, which meta.json carries and a reader judges a run by.
  const { shakeout: _stamp, ...meta } = readMeta(dir)!;
  writeFileSync(join(dir, "meta.json"), JSON.stringify({ ...meta, config: { ...meta.config, driver: "openai", model: "test/model" } }));
}

describe("where a run's facts live", () => {
  test("the harness writes the session token to meta.json, which --resume reads, and to no other copy", () => {
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    const dir = join(runsDir, RUN_ID);
    const records = readTrajectory(dir);
    // The one record that holds it is the result the model read.
    expect(records.filter((r) => JSON.stringify(r).includes(token)).map((r) => r.t)).toEqual(["snippet_result"]);
    // The run row as its readers see it (`run-reader.ts`) carries the config without it.
    const config = String(readRunRow(dir, RUN_ID)!["config_json"]);
    expect(config.includes(token)).toBe(false);
    // The rest of the config is still in both: the record and the row are complete without it.
    // (`asModelRun` relabelled the driver and the model in meta.json after the record was written.)
    const { token: _t, driver: _d, model: _m, ...rest } = readMeta(dir)!.config;
    const { driver: _rd, model: _rm, ...recorded } = records.find((r) => r.t === "meta")!["config"] as Record<string, unknown>;
    expect(recorded).toEqual(JSON.parse(JSON.stringify(rest)));
    expect(JSON.parse(config)).toEqual(JSON.parse(JSON.stringify({ ...rest, driver: "openai", model: "test/model" })));
  });

  test("the run directory holds no trace.jsonl", () => {
    expect(readdirSync(join(runsDir, RUN_ID))).not.toContain("trace.jsonl");
  });

  test("the session record is session/, the stack's, named by the token's fingerprint and holding no token", () => {
    const dir = join(runsDir, RUN_ID);
    const reader = new SessionReader(sessionDirOf(dir));
    expect(reader.session()).toMatchObject({ format: "wrath-session/1", id: tokenFingerprint(token) });
    // The stub's run closed its record on the way out; the ring is live-only.
    expect(reader.session()!.ended).not.toBeNull();
    expect(readdirSync(sessionDirOf(dir))).not.toContain("nearby");
    for (const name of readdirSync(sessionDirOf(dir), { recursive: true }) as string[]) {
      if (!name.endsWith(".json") && !name.endsWith(".jsonl")) continue;
      expect({ name, leaked: readFileSync(join(sessionDirOf(dir), name), "utf8").includes(token) }).toEqual({ name, leaked: false });
    }
  });

  test("a v1 run directory holds no run.sqlite: the row is meta.json's, the game side is session/", () => {
    // What run.ts left: the trajectory, meta.json, and the session record.
    const files = readdirSync(join(runsDir, RUN_ID)).sort();
    expect(files).not.toContain("run.sqlite");
    expect(files).toEqual(expect.arrayContaining(["meta.json", "trajectory.jsonl", "session"]));
    expect(readMeta(join(runsDir, RUN_ID))).toMatchObject({ termination: { reason: expect.any(String) }, endedAt: expect.any(Number) });
    expect(readdirSync(join(runsDir, LIVE_ID))).not.toContain("run.sqlite");
  });

  test("the trace is in session/trace, and the trajectory is the model side: no state, milestone or move record", () => {
    const live = join(runsDir, LIVE_ID);
    const rows = new SessionReader(sessionDirOf(live)).rows("trace");
    expect(rows.filter((r) => r.kind === "state").length).toBe(2);
    for (const id of [RUN_ID, LIVE_ID]) {
      const kinds = new Set(readTrajectory(join(runsDir, id)).map((r) => r.t));
      for (const gone of ["trace", "state", "milestone", "move", "actions", "quest_complete"]) expect({ id, gone, there: kinds.has(gone) }).toEqual({ id, gone, there: false });
    }
  });
});

describe("the readers get the whole run", () => {
  const get = async (api: ReturnType<typeof createApi>, path: string): Promise<string> =>
    await (await api(new Request(`http://x${path}`))).text();

  test("the operator's viewer serves every record as written, the model's view of the echo included", async () => {
    const api = createApi({ runsDir, tilesDir: join(runsDir, "minimap"), moduleUrl: "http://127.0.0.1:1" });
    const records = readTrajectory(join(runsDir, RUN_ID));
    const detail = await get(api, `/api/run/${RUN_ID}`);
    expect((JSON.parse(detail) as { total: number }).total).toBe(records.length);
    const page = await get(api, `/api/run/${RUN_ID}/entries?from=0&limit=500`);
    const entries = (JSON.parse(page) as { entries: { t: string; text?: string }[] }).entries;
    expect(entries.map((e) => e.t)).toEqual(records.map((r) => r.t));
    expect(entries.map((e) => e.t)).toContain("meta");
    expect(entries.at(-1)!.text).toBe(echo(token));
    expect((await api(new Request(`http://x/api/run/${RUN_ID}/track`))).status).toBe(200);
  });

  test("a public handle — what the snapshot publishes — serves the same run with the token struck from every body", async () => {
    const api = createApi({ runsDir, tilesDir: join(runsDir, "minimap"), moduleUrl: "http://127.0.0.1:1", publicMode: true });
    const bodies = await Promise.all(
      ["", "/entries?from=0&limit=500", "/track", "/scratchpad"].map((p) => get(api, `/api/run/${RUN_ID}${p}`)),
    );
    for (const body of bodies) expect(body.includes(token)).toBe(false);
    const entries = (JSON.parse(bodies[1]!) as { entries: { t: string; text?: string }[] }).entries;
    expect(entries.at(-1)!.text).toBe(echo("[redacted]"));
    expect(bodies[3]).toContain("session [redacted]");
    // A pre-hardening run's "token" is its run id, which is never struck.
    const old = await get(api, `/api/run/${OLD_ID}/entries?from=0&limit=500`);
    expect((JSON.parse(old) as { entries: { text?: string }[] }).entries.at(-1)!.text).toBe(echo(OLD_ID));
  });

  test("the live map's status text — what live.json publishes — has the character's token struck; the operator's map keeps it", async () => {
    const statusOf = async (publicMode: boolean): Promise<{ body: string; text: string | undefined }> => {
      const api = createApi({ runsDir, tilesDir: join(runsDir, "minimap"), moduleUrl: "http://127.0.0.1:1", publicMode });
      const body = await get(api, "/api/positions");
      const p = (JSON.parse(body) as { positions: { runId: string; status?: { text: string } | null }[] }).positions;
      return { body, text: p.find((x) => x.runId === LIVE_ID)?.status?.text };
    };
    const pub = await statusOf(true);
    expect(pub.text).toBe("parked, session [redacted] still held");
    expect(pub.body.includes(liveToken)).toBe(false);
    expect((await statusOf(false)).text).toBe(`parked, session ${liveToken} still held`);
  });

  test("the trace's chat — a closed window, the index's tail, live.json's tail — has the token struck and a key's shape masked; the operator's keeps the key, and the record never held the token", async () => {
    const bodiesOf = async (publicMode: boolean): Promise<string[]> => {
      const api = createApi({ runsDir, tilesDir: join(runsDir, "minimap"), moduleUrl: "http://127.0.0.1:1", publicMode });
      const index = JSON.parse(await get(api, `/api/run/${LIVE_ID}/trace`)) as { segs: [number, number][] };
      const t0 = index.segs[0]![0];
      return [await get(api, `/api/run/${LIVE_ID}/trace/${t0}`), await get(api, `/api/run/${LIVE_ID}/trace`), await get(api, "/api/positions")];
    };
    const pub = await bodiesOf(true);
    expect(pub).toHaveLength(3);
    for (const body of pub) {
      expect(body).toContain(`${CHAT_SAID} [redacted] and [redacted]`);
      expect(body.includes(liveToken)).toBe(false);
      expect(body.includes(CHAT_KEY)).toBe(false);
    }
    // The stack's writer strikes the session's own token from every line it
    // writes (an agent can print it), so not even the operator's reads hold it;
    // the key's shape is not the session's secret and is masked only publicly.
    // (The operator's positions body still quotes the token, from the episodic status line above.)
    const priv = await bodiesOf(false);
    for (const body of priv) expect(body).toContain(`${CHAT_SAID} [redacted] and ${CHAT_KEY}`);
    for (const body of priv.slice(0, 2)) expect(body.includes(liveToken)).toBe(false);
  });

  test("the collector stores every line, and no table holds the token", async () => {
    const sink = memorySink();
    const cfg = readConfig({ runsDir, dataDir: runsDir, stateDb: ":memory:" });
    await new Collector({ cfg, sink, offsets: new OffsetStore(":memory:"), log: () => {} }).pass();
    const rows = (table: string): Record<string, unknown>[] =>
      ((sink.tables.get(table) ?? []) as Record<string, unknown>[]).filter((r) => r["run_id"] === RUN_ID);
    expect(rows("turns").length + rows("events").length).toBe(readTrajectory(join(runsDir, RUN_ID)).length);
    expect(rows("runs")).toHaveLength(1);
    expect(rows("run_totals")).toHaveLength(1);
    for (const [table, all] of sink.tables) {
      const text = JSON.stringify(all);
      expect({ table, leaked: text.includes(token) || text.includes(liveToken) }).toEqual({ table, leaked: false });
    }
    // The live run's status line, struck and stored as the entry it is.
    const status = ((sink.tables.get("episodic") ?? []) as Record<string, unknown>[]).find((r) => r["run_id"] === LIVE_ID);
    expect(status).toMatchObject({ kind: "entry", turn: 4 });
    expect(String(status?.["raw"])).toContain("session [redacted] still held");
    const echoed = rows("turns").find((r) => r["kind"] === "snippet_result" && String(r["raw"]).includes("move_to"));
    expect((JSON.parse(String(echoed?.["raw"])) as { text: string }).text).toBe(echo("[redacted]"));
    // The old run keeps its id wherever it is written.
    const oldTurn = ((sink.tables.get("turns") ?? []) as Record<string, unknown>[]).find((r) => r["run_id"] === OLD_ID);
    expect((JSON.parse(String(oldTurn?.["raw"])) as { text: string }).text).toBe(echo(OLD_ID));
  });
});
