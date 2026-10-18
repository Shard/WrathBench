/**
 * A run as this build writes it, end to end: launched through run.ts with the
 * stub driver, then read back by the viewer and by the collector. It pins
 * where each fact a run records lives — the module session token in meta.json
 * and nowhere else, the trace in run.sqlite and no `trace.jsonl` beside it —
 * and that the readers still get the whole run from those homes.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApi } from "../viewer/api";
import { readMeta, readTrajectory } from "../src/trajectory";
import { Collector } from "../../collector/src/collector";
import { memorySink } from "../../collector/src/sink";
import { OffsetStore } from "../../collector/src/offsets";
import { readConfig } from "../../collector/src/config";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();
const RUN_TS = join(import.meta.dir, "..", "src", "run.ts");
const RUN_ID = "run-homes";

let runsDir = "";
let token = "";

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
  token = readMeta(join(runsDir, RUN_ID))!.config.token!;
}, 30_000);

describe("where a run's facts live", () => {
  test("the session token is in meta.json, which --resume reads, and in no other file the run wrote", () => {
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    const dir = join(runsDir, RUN_ID);
    expect(readFileSync(join(dir, "trajectory.jsonl"), "utf8").includes(token)).toBe(false);
    const db = new Database(join(dir, "run.sqlite"), { readonly: true });
    const config = (db.query(`SELECT config_json FROM run`).get() as { config_json: string }).config_json;
    db.close();
    expect(config.includes(token)).toBe(false);
    // The rest of the config is still in both: the record and the row are complete without it.
    const metaRecord = readTrajectory(dir).find((r) => r.t === "meta")!;
    const { token: _t, ...rest } = readMeta(dir)!.config;
    expect(metaRecord["config"]).toEqual(JSON.parse(JSON.stringify(rest)));
    expect(JSON.parse(config)).toEqual(JSON.parse(JSON.stringify(rest)));
  });

  test("the run directory holds no trace.jsonl", () => {
    expect(readdirSync(join(runsDir, RUN_ID))).not.toContain("trace.jsonl");
  });
});

describe("the readers get the whole run", () => {
  test("the viewer serves every record, the meta entry included, with no token in any body", async () => {
    const api = createApi({ runsDir, tilesDir: join(runsDir, "minimap"), moduleUrl: "http://127.0.0.1:1" });
    const records = readTrajectory(join(runsDir, RUN_ID));
    const detail = await (await api(new Request(`http://x/api/run/${RUN_ID}`))).text();
    expect((JSON.parse(detail) as { total: number }).total).toBe(records.length);
    const page = await (await api(new Request(`http://x/api/run/${RUN_ID}/entries?from=0&limit=500`))).text();
    const entries = (JSON.parse(page) as { entries: { t: string }[] }).entries;
    expect(entries.map((e) => e.t)).toEqual(records.map((r) => r.t));
    expect(entries.map((e) => e.t)).toContain("meta");
    expect(entries.map((e) => e.t)).toContain("response");
    const track = await api(new Request(`http://x/api/run/${RUN_ID}/track`));
    expect(track.status).toBe(200);
    for (const body of [detail, page, await track.text()]) expect(body.includes(token)).toBe(false);
  });

  test("the collector stores every line, and no table holds the token", async () => {
    const sink = memorySink();
    const cfg = readConfig({ runsDir, dataDir: runsDir, stateDb: ":memory:" });
    await new Collector({ cfg, sink, offsets: new OffsetStore(":memory:"), log: () => {} }).pass();
    const lines = readTrajectory(join(runsDir, RUN_ID)).length;
    const stored = (sink.tables.get("turns")?.length ?? 0) + (sink.tables.get("events")?.length ?? 0);
    expect(stored).toBe(lines);
    expect(sink.tables.get("runs")).toHaveLength(1);
    expect(sink.tables.get("run_totals")).toHaveLength(1);
    for (const [table, rows] of sink.tables) expect({ table, leaked: JSON.stringify(rows).includes(token) }).toEqual({ table, leaked: false });
  });
});
