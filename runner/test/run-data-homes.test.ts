/**
 * A run as this build writes it, end to end: launched through run.ts with the
 * stub driver, then read back by the viewer and by the collector. It pins
 * where each fact a run records lives — the trace in run.sqlite with no
 * `trace.jsonl` beside it, the module session token in meta.json as the
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
import { beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApi } from "../viewer/api";
import { loadRunConfig, newSessionToken } from "../src/config";
import { EpisodicLog } from "../src/episodic";
import { Trajectory, readMeta, readTrajectory } from "../src/trajectory";
import { Collector } from "../../collector/src/collector";
import { memorySink } from "../../collector/src/sink";
import { OffsetStore } from "../../collector/src/offsets";
import { readConfig } from "../../collector/src/config";
import { emptyTraceState } from "../src/trace-row";
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
  lt.recordState(LIVE_ID, { level: 3, xp: 120, map: 0, x: -6240, y: 330, z: 383, turn: 4 });
  // Its trace, where it said its token and something shaped like a key: in a
  // window long closed, and in the tail.
  const closedAt = windowOf(Date.now() - 4 * SEG_MS);
  const tailAt = Date.now() - 5_000;
  const said = `${CHAT_SAID} ${liveToken} and ${CHAT_KEY}`;
  lt.recordTrace(LIVE_ID, [
    { ts: closedAt + 1_000, kind: "key", map: 0, x: -6240, y: 330, z: 383, o: 0, data: { ...emptyTraceState(), level: 3 } },
    { ts: closedAt + 2_000, kind: "state", data: { chat: [["party", said]] } },
    { ts: windowOf(tailAt), kind: "key", map: 0, x: -6240, y: 330, z: 383, o: 0, data: { ...emptyTraceState(), level: 3 } },
    { ts: tailAt, kind: "state", data: { chat: [["say", said]] } },
  ]);
  lt.close();
  new EpisodicLog(join(live, "episodic.jsonl")).append({ turn: 4, level: 3, text: `parked, session ${liveToken} still held` });
}, 30_000);

/**
 * The stub's run, relabelled as a model's: its run row, and the stamp in its
 * meta.json, which is what the readers judge a run by. The config and the
 * trajectory keep what the stub wrote, which the first test below reads.
 */
function asModelRun(dir: string): void {
  const db = new Database(join(dir, "run.sqlite"));
  db.run(`UPDATE run SET driver = 'openai', shakeout = NULL, model = 'test/model'`);
  db.close();
  // And the stamp, which meta.json carries beside the config and a reader takes either way.
  const { shakeout: _stamp, ...meta } = readMeta(dir)!;
  writeFileSync(join(dir, "meta.json"), JSON.stringify(meta));
}

describe("where a run's facts live", () => {
  test("the harness writes the session token to meta.json, which --resume reads, and to no other copy", () => {
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    const dir = join(runsDir, RUN_ID);
    const records = readTrajectory(dir);
    // The one record that holds it is the result the model read.
    expect(records.filter((r) => JSON.stringify(r).includes(token)).map((r) => r.t)).toEqual(["snippet_result"]);
    const db = new Database(join(dir, "run.sqlite"), { readonly: true });
    const config = (db.query(`SELECT config_json FROM run`).get() as { config_json: string }).config_json;
    db.close();
    expect(config.includes(token)).toBe(false);
    // The rest of the config is still in both: the record and the row are complete without it.
    const { token: _t, ...rest } = readMeta(dir)!.config;
    expect(records.find((r) => r.t === "meta")!["config"]).toEqual(JSON.parse(JSON.stringify(rest)));
    expect(JSON.parse(config)).toEqual(JSON.parse(JSON.stringify(rest)));
  });

  test("the run directory holds no trace.jsonl", () => {
    expect(readdirSync(join(runsDir, RUN_ID))).not.toContain("trace.jsonl");
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

  test("the trace's chat — a closed window, the index's tail, live.json's tail — has the token struck and a key's shape masked; the operator's keeps both", async () => {
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
    for (const body of await bodiesOf(false)) expect(body).toContain(`${CHAT_SAID} ${liveToken} and ${CHAT_KEY}`);
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
