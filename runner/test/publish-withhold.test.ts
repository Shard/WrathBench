/**
 * A run whose driver is not a model is never published (operator,
 * 2026-10-20): the scripted reference plays a private program its snippets
 * carry. Over the poisoned fixture plus such runs — a live reference run with a
 * position, a nearby ring and trace windows, a finished one, and a scripted
 * stub run — each with a sentinel planted in its snippet code, its snippet
 * results and its scratchpad:
 *
 * - no artifact a pass renders names one of them or carries the sentinel:
 *   not `runs.json`, `results.json`, a ladder, a per-run object, a trace
 *   window, `live.json`'s positions or nearby windows;
 * - the public handle answers every route about them as if they did not exist,
 *   and the private handle still serves them;
 * - the pass hands their ids back as `withdrawn`, for the publisher to delete
 *   what an earlier pass published.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApi } from "../viewer/api";
import { createRenderer, type SnapshotResult } from "../viewer/snapshot";
import { REFERENCE_STAMP, STUB_STAMP } from "../src/config";
import { SEG_MS, windowOf } from "../viewer/trace";
import { DEAD_RUN, LIVE_RUN, poisonedRunsDir } from "./fixtures/poisoned-runs";

const SENTINEL = "sentinel-private-program-7c41";
const REF_LIVE = "run-ref-live";
const REF_DEAD = "run-ref-dead";
const STUB_RUN = "run-stub-dead";
const WITHHELD = [REF_DEAD, REF_LIVE, STUB_RUN].sort();

/** A copy of a fixture run under another id and driver, its program text planted where a reference run's is. */
function copyRun(runs: string, from: string, to: string, driver: string, stamp: string): void {
  const dir = join(runs, to);
  cpSync(join(runs, from), dir, { recursive: true, preserveTimestamps: true });
  const swap = (t: string): string => t.split(from).join(to).replaceAll('"driver":"openai"', `"driver":"${driver}"`);
  writeFileSync(join(dir, "meta.json"), swap(readFileSync(join(dir, "meta.json"), "utf8")));
  const lines = swap(readFileSync(join(dir, "trajectory.jsonl"), "utf8")).trimEnd().split("\n");
  lines.splice(
    2,
    0,
    JSON.stringify({ ts: 1210, t: "snippet", turn: 1, code: `globalThis.__wbReference = { tick: (async () => "${SENTINEL}") };` }),
    JSON.stringify({ ts: 1220, t: "snippet_result", turn: 1, call: 9, name: "run_snippet", isError: false, text: `ok\n[log] REF {"did":["${SENTINEL}"]}` }),
  );
  writeFileSync(join(dir, "trajectory.jsonl"), `${lines.join("\n")}\n`);
  writeFileSync(join(dir, "scratchpad.md"), `reference-cursor: 3 ${SENTINEL}\n`);
  const db = new Database(join(dir, "run.sqlite"));
  db.run("UPDATE run SET run_id = ?, driver = ?, shakeout = ?", [to, driver, stamp]);
  db.run("UPDATE state SET run_id = ?", [to]);
  db.close();
}

/** Three closed trace windows to a moment ago, in the recorder's schema. */
function addTrace(runs: string, runId: string): void {
  const db = new Database(join(runs, runId, "run.sqlite"));
  db.exec(`CREATE TABLE IF NOT EXISTS trace (run_id TEXT NOT NULL, ts INTEGER NOT NULL, kind TEXT NOT NULL,
             map INTEGER, x REAL, y REAL, z REAL, o REAL, data TEXT);`);
  const now = Date.now();
  const insert = db.query(`INSERT INTO trace (run_id, ts, kind, map, x, y, z, o, data) VALUES (?,?,?,?,?,?,?,?,?)`);
  let x = -6240;
  for (let ts = windowOf(now) - 3 * SEG_MS; ts < now - 1_000; ts += 1000) {
    if (ts % SEG_MS === 0) insert.run(runId, ts, "key", 0, x, 380, 385, 0, JSON.stringify({ hp: 100, hpMax: 100, level: 3 }));
    x += 0.7;
    insert.run(runId, ts + 1, "pos", 0, x, 380, 385, 0, null);
  }
  db.close();
}

function fixture(): string {
  const runs = poisonedRunsDir();
  copyRun(runs, LIVE_RUN, REF_LIVE, "reference", REFERENCE_STAMP);
  copyRun(runs, DEAD_RUN, REF_DEAD, "reference", REFERENCE_STAMP);
  copyRun(runs, DEAD_RUN, STUB_RUN, "stub", STUB_STAMP);
  addTrace(runs, LIVE_RUN);
  addTrace(runs, REF_LIVE);
  return runs;
}

const handleFor = (runs: string, publicMode: boolean) =>
  createApi({ runsDir: runs, tilesDir: join(runs, "no-tiles"), publicMode, moduleUrl: "http://127.0.0.1:1" });

describe("a pass never publishes a run whose driver is not a model", () => {
  test("no artifact names one or carries its program text, and the ids come back as withdrawn", async () => {
    const runs = fixture();
    const out: SnapshotResult = await createRenderer({ runsDir: runs })(Date.now());
    for (const a of out.artifacts) {
      for (const id of WITHHELD) {
        expect(a.path).not.toContain(id);
        expect(a.body).not.toContain(id);
      }
      expect(a.body).not.toContain(SENTINEL);
    }
    expect(out.withdrawn).toEqual(WITHHELD);
    // The model runs beside them are published as before, trace windows and position included.
    const paths = out.artifacts.map((a) => a.path);
    for (const id of [LIVE_RUN, DEAD_RUN]) expect(paths.some((p) => p.startsWith(`v1/run/${id}/`))).toBe(true);
    expect(paths.some((p) => p.startsWith(`v1/run/${LIVE_RUN}/trace/`))).toBe(true);
    const live = JSON.parse(out.artifacts.find((a) => a.path === "v1/live.json")!.body) as { positions: { positions: { runId: string }[] } };
    expect(live.positions.positions.map((p) => p.runId)).toContain(LIVE_RUN);
  });

  test("the public handle answers every route about one as if it did not exist; the private handle still serves it", async () => {
    const runs = fixture();
    const pub = handleFor(runs, true);
    const priv = handleFor(runs, false);
    const t0 = windowOf(Date.now()) - 3 * SEG_MS;
    for (const route of ["", "/track", "/entries?limit=10", "/scratchpad", `/trace/${t0}`, "/nearby?span=60000"]) {
      const res = await pub(new Request(`http://x/api/run/${REF_LIVE}${route}`));
      expect(`${route} ${res.status}`).toBe(`${route} 404`);
      expect(await res.text()).not.toContain(SENTINEL);
    }
    expect((await pub(new Request(`http://x/api/character/${REF_LIVE}`))).status).toBe(404);
    for (const route of ["/api/runs", "/api/results?episode=all&includeOverrides=1", "/api/ladder?episode=e90", "/api/positions", "/api/fleet", "/api/models", "/api/episodes"]) {
      const body = await (await pub(new Request(`http://x${route}`))).text();
      for (const id of WITHHELD) expect(`${route}: ${body.includes(id)}`).toBe(`${route}: false`);
    }
    expect(await pub.unpublishedRuns()).toEqual(WITHHELD);

    const listed = (await (await priv(new Request("http://x/api/runs"))).json()) as { runs: { runId: string }[] };
    for (const id of WITHHELD) expect(listed.runs.map((r) => r.runId)).toContain(id);
    // What the public handle withholds is really there: the position, the
    // window, the nearby ring and the program text in the feed.
    expect((await priv(new Request(`http://x/api/run/${REF_LIVE}`))).status).toBe(200);
    expect((await priv(new Request(`http://x/api/run/${REF_LIVE}/trace/${t0}`))).status).toBe(200);
    expect((await priv(new Request(`http://x/api/run/${REF_LIVE}/nearby?span=60000`))).status).toBe(200);
    expect(await (await priv(new Request("http://x/api/positions"))).text()).toContain(REF_LIVE);
    expect(await (await priv(new Request(`http://x/api/run/${REF_LIVE}/entries?limit=50`))).text()).toContain(SENTINEL);
  });
});
