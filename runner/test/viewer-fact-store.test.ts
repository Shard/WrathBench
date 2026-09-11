/**
 * The persisted per-run fact cache (`runner/viewer/fact-store.ts`).
 *
 * What is asserted here is the bargain the file makes: a cold start counts and
 * writes, a warm start reads what it wrote and does NOT touch the trajectory
 * again, a run whose files moved is the only one recounted, and every way the
 * file can be wrong — corrupt, from another version, from another corpus —
 * costs a recount and nothing else.
 *
 * The trick that proves "did not scan" is worth naming: after the cache is
 * written, a run's trajectory is overwritten with the same number of bytes at
 * the same mtime. The signature is unchanged, so a cache that is being used
 * reports the counts it stored, while any reader that actually opened the file
 * would report the garbage's counts (zero responses). One assertion, no
 * instrumentation.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../viewer/api";
import { currentSeries, readRunFactsCached, type FactCacheEntry } from "../viewer/models";
import { FACT_CACHE_VERSION, FACT_KEYS, createFactStore, defaultFactCachePath } from "../viewer/fact-store";
import type { ModelsResponse } from "../viewer/api-types";

/*
 * The real clock, not a fixed instant: the store decides what is stable enough
 * to write from `Date.now()` against each trajectory's mtime, so a fixture
 * dated to some fixed year would be either permanently live or dated into the future.
 */
const NOW = Date.now();
const HOUR = 3_600_000;
const roots: string[] = [];

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "fact-store-"));
  roots.push(root);
  const runsDir = join(root, "runs");
  mkdirSync(runsDir, { recursive: true });
  return runsDir;
}

/** One finished run: meta, a trajectory with `responses` model turns, a db. */
function writeRun(
  runsDir: string,
  id: string,
  opts: { model?: string; responses: number; endedAt?: number },
): void {
  const dir = join(runsDir, id);
  mkdirSync(dir, { recursive: true });
  const model = opts.model ?? "vendor/alpha";
  const startedAt = NOW - 2 * HOUR;
  const endedAt = opts.endedAt ?? NOW - HOUR;
  const config = { model };
  writeFileSync(
    join(dir, "meta.json"),
    JSON.stringify({
      runId: id,
      harnessVersion: `harness-${currentSeries() ?? "0.0"}-test`,
      startedAt,
      config,
      comparability: { effort: null, episode: "e90" },
    }),
  );
  const lines = [`{"t":"meta","ts":${startedAt}}`];
  for (let i = 0; i < opts.responses; i++) {
    lines.push(JSON.stringify({ ts: startedAt + 1 + i, t: "response", text: "x" }));
  }
  lines.push(JSON.stringify({ ts: endedAt, t: "termination", reason: "goal-reached", detail: "" }));
  writeFileSync(join(dir, "trajectory.jsonl"), lines.join("\n") + "\n");
  const secs = endedAt / 1000;
  utimesSync(join(dir, "trajectory.jsonl"), secs, secs);

  // A rewritten run is its own fixture here, so the database is replaced
  // rather than added to.
  rmSync(join(dir, "run.sqlite"), { force: true });
  const db = new Database(join(dir, "run.sqlite"));
  db.run(
    `CREATE TABLE run (run_id TEXT, model TEXT, driver TEXT, shakeout TEXT,
       harness_version TEXT, started_at INTEGER, ended_at INTEGER, termination_reason TEXT,
       termination_detail TEXT, pause_reason TEXT, config_json TEXT)`,
  );
  db.run(`INSERT INTO run VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [
    id, model, "openai", null, "harness-test", startedAt, endedAt,
    "goal-reached", null, null, JSON.stringify(config),
  ]);
  db.run(
    `CREATE TABLE state (run_id TEXT, ts INTEGER, level INTEGER, xp INTEGER, map INTEGER,
       x REAL, y REAL, z REAL, event_count INTEGER, last_seq INTEGER, money INTEGER,
       quests_completed INTEGER)`,
  );
  db.close();
}

/**
 * Replace a trajectory with the same number of bytes at the same mtime: the
 * signature does not move, so only a reader that skipped the file still counts
 * what was there before.
 */
function scrambleKeepingSignature(runsDir: string, id: string): void {
  const path = join(runsDir, id, "trajectory.jsonl");
  const st = statSync(path);
  writeFileSync(path, "x".repeat(st.size - 1) + "\n");
  utimesSync(path, st.mtimeMs / 1000, st.mtimeMs / 1000);
}

function fill(runsDir: string, path: string | undefined, now = NOW): { store: ReturnType<typeof createFactStore>; responses: Map<string, number | null> } {
  const store = createFactStore(runsDir, path);
  const facts = readRunFactsCached(runsDir, store.cache, now, store.onChange);
  store.flush();
  return { store, responses: new Map(facts.map((f) => [f.runId, f.modelResponses])) };
}

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

describe("persisted fact cache", () => {
  test("a cold start counts and writes the file", () => {
    const runsDir = fixture();
    writeRun(runsDir, "run-a", { responses: 3 });
    writeRun(runsDir, "run-b", { responses: 5 });
    const path = join(runsDir, "..", "fact-cache.json");

    const cold = fill(runsDir, path);
    expect(cold.store.loaded).toBe(0);
    expect(cold.responses.get("run-a")).toBe(3);
    expect(cold.responses.get("run-b")).toBe(5);

    const file = JSON.parse(readFileSync(path, "utf8")) as {
      version: number;
      runsDir: string;
      entries: Record<string, FactCacheEntry>;
    };
    expect(file.version).toBe(FACT_CACHE_VERSION);
    expect(file.runsDir).toBe(runsDir);
    expect(Object.keys(file.entries).sort()).toEqual(["run-a", "run-b"]);
  });

  test("a warm start reads the file and never opens the trajectories", () => {
    const runsDir = fixture();
    writeRun(runsDir, "run-a", { responses: 3 });
    writeRun(runsDir, "run-b", { responses: 5 });
    const path = join(runsDir, "..", "fact-cache.json");
    fill(runsDir, path);

    // Both files now say something else at the same size and mtime.
    scrambleKeepingSignature(runsDir, "run-a");
    scrambleKeepingSignature(runsDir, "run-b");

    const warm = fill(runsDir, path);
    expect(warm.store.loaded).toBe(2);
    expect(warm.responses.get("run-a")).toBe(3);
    expect(warm.responses.get("run-b")).toBe(5);

    // The control: no cache, same scrambled files, and the counts are gone.
    const none = fill(runsDir, undefined);
    expect(none.responses.get("run-a")).toBe(0);
  });

  test("a moved signature recomputes that run and only that run", () => {
    const runsDir = fixture();
    writeRun(runsDir, "run-a", { responses: 3 });
    writeRun(runsDir, "run-b", { responses: 5 });
    const path = join(runsDir, "..", "fact-cache.json");
    fill(runsDir, path);

    // run-a keeps its signature and loses its content; run-b is rewritten
    // shorter, an hour before `now` so it is still not live.
    scrambleKeepingSignature(runsDir, "run-a");
    writeRun(runsDir, "run-b", { responses: 1 });

    const warm = fill(runsDir, path);
    expect(warm.responses.get("run-a")).toBe(3); // served from the file
    expect(warm.responses.get("run-b")).toBe(1); // recounted, because it moved
  });

  test("a corrupt, mis-versioned or foreign file falls back to counting", () => {
    const runsDir = fixture();
    writeRun(runsDir, "run-a", { responses: 3 });
    const path = join(runsDir, "..", "fact-cache.json");

    for (const body of [
      "{ not json at all",
      JSON.stringify({ version: FACT_CACHE_VERSION + 99, runsDir, entries: {} }),
      JSON.stringify({ version: FACT_CACHE_VERSION, runsDir: "/somewhere/else", entries: { "run-a": { sig: "x", mtime: 1, fact: null } } }),
      JSON.stringify({ version: FACT_CACHE_VERSION, runsDir, entries: { "run-a": { sig: "x" } } }),
      JSON.stringify({ version: FACT_CACHE_VERSION, runsDir, entries: { "run-a": { sig: "x", mtime: 1, fact: { runId: "run-a", stray: 1 } } } }),
    ]) {
      writeFileSync(path, body);
      const read = fill(runsDir, path);
      expect(read.store.loaded).toBe(0);
      expect(read.responses.get("run-a")).toBe(3);
    }
  });

  test("a missing file is a normal cold start, and an unwritable one is not fatal", () => {
    const runsDir = fixture();
    writeRun(runsDir, "run-a", { responses: 2 });
    // A path whose parent is a file: mkdir and write both fail.
    const blocked = join(runsDir, "run-a", "meta.json", "cache.json");
    const read = fill(runsDir, blocked);
    expect(read.responses.get("run-a")).toBe(2);
  });

  test("a live run is never written down", () => {
    const runsDir = fixture();
    writeRun(runsDir, "run-a", { responses: 3 });
    writeRun(runsDir, "run-live", { responses: 4, endedAt: NOW - 1_000 });
    const path = join(runsDir, "..", "fact-cache.json");
    fill(runsDir, path);
    const file = JSON.parse(readFileSync(path, "utf8")) as { entries: Record<string, unknown> };
    expect(Object.keys(file.entries)).toEqual(["run-a"]);
  });

  /**
   * The one case a change-driven write misses on its own: a run that was live
   * when its signature last moved is not written then, and its signature never
   * moves again once the process writing it stops — so nothing tells the store
   * about it a second time. A flush writes the whole map, which is what sweeps
   * it in; the viewer flushes on SIGTERM.
   */
  test("a run that goes quiet while the viewer is up is swept in by a flush", () => {
    const runsDir = fixture();
    writeRun(runsDir, "run-live", { responses: 4, endedAt: NOW - 1_000 });
    const path = join(runsDir, "..", "fact-cache.json");
    // The store's own clock, so the run can age past the live window without
    // the test waiting two minutes for it.
    let clock = NOW;
    const store = createFactStore(runsDir, path, { now: () => clock });
    readRunFactsCached(runsDir, store.cache, NOW, store.onChange);
    store.flush();
    const early = JSON.parse(readFileSync(path, "utf8")) as { entries: Record<string, unknown> };
    expect(Object.keys(early.entries)).toEqual([]);

    // Time passes; the file does not move, so nothing calls `onChange` again.
    clock = NOW + 10 * 60_000;
    readRunFactsCached(runsDir, store.cache, clock, store.onChange);
    store.flush();
    const later = JSON.parse(readFileSync(path, "utf8")) as { entries: Record<string, unknown> };
    expect(Object.keys(later.entries)).toEqual(["run-live"]);
  });

  test("a run that went away leaves the file", () => {
    const runsDir = fixture();
    writeRun(runsDir, "run-a", { responses: 3 });
    writeRun(runsDir, "run-b", { responses: 5 });
    const path = join(runsDir, "..", "fact-cache.json");
    fill(runsDir, path);
    rmSync(join(runsDir, "run-b"), { recursive: true, force: true });
    fill(runsDir, path);
    const file = JSON.parse(readFileSync(path, "utf8")) as { entries: Record<string, unknown> };
    expect(Object.keys(file.entries)).toEqual(["run-a"]);
  });

  test("no path is memory-only: nothing is written anywhere", () => {
    const runsDir = fixture();
    writeRun(runsDir, "run-a", { responses: 3 });
    const store = createFactStore(runsDir);
    readRunFactsCached(runsDir, store.cache, NOW, store.onChange);
    store.flush();
    expect(store.path).toBeUndefined();
    expect(() => statSync(defaultFactCachePath(runsDir))).toThrow();
  });

  /**
   * The version stamp is the only thing that invalidates the file when the
   * code changes rather than the files. Nobody editing `readRunFact` will
   * remember it unaided, so a change to what a fact holds fails here, naming
   * the constant to bump.
   */
  test("RunFact's shape is pinned to FACT_CACHE_VERSION", () => {
    const runsDir = fixture();
    writeRun(runsDir, "run-a", { responses: 1 });
    const store = createFactStore(runsDir);
    const [fact] = readRunFactsCached(runsDir, store.cache, NOW, store.onChange);
    expect(fact).toBeDefined();
    expect(Object.keys(fact as object).sort()).toEqual([...FACT_KEYS]);
  });
});

describe("the viewer's handle", () => {
  test("/api/models fills the cache, and a second handle serves from it", async () => {
    const runsDir = fixture();
    writeRun(runsDir, "run-a", { responses: 3 });
    const path = join(runsDir, "..", "api-fact-cache.json");
    const fleetPath = join(runsDir, "..", "fleet.json");
    writeFileSync(fleetPath, JSON.stringify({ roster: { alpha: { model: "vendor/alpha", tier: "t1" } } }));

    const first = createApi({ runsDir, tilesDir: join(runsDir, "tiles"), fleetConfigPath: fleetPath, factCachePath: path });
    expect((await first(new Request("http://x/api/models"))).status).toBe(200);
    first.flushFacts();
    expect(statSync(path).size).toBeGreaterThan(0);

    // Same trick as above: the trajectory now says nothing, at the same
    // signature, so only a handle reading the file still sees three responses.
    scrambleKeepingSignature(runsDir, "run-a");
    const second = createApi({ runsDir, tilesDir: join(runsDir, "tiles"), fleetConfigPath: fleetPath, factCachePath: path });
    const body = (await (await second(new Request("http://x/api/models"))).json()) as ModelsResponse;
    const runs = body.models.flatMap((m) => m.runs);
    // The count itself is not on the view; what it decides is. Three responses
    // make the run counted, where the scrambled file's zero would make it
    // stillborn — which is exactly what the control below reads.
    expect(runs.find((r) => r.runId === "run-a")?.counted).toBe(true);

    const control = createApi({ runsDir, tilesDir: join(runsDir, "tiles"), fleetConfigPath: fleetPath });
    const cold = (await (await control(new Request("http://x/api/models"))).json()) as ModelsResponse;
    expect(cold.models.flatMap((m) => m.runs).find((r) => r.runId === "run-a")?.counted).toBe(false);
  });

  test("a handle with no cache path writes nothing", async () => {
    const runsDir = fixture();
    writeRun(runsDir, "run-a", { responses: 3 });
    const handle = createApi({ runsDir, tilesDir: join(runsDir, "tiles") });
    expect((await handle(new Request("http://x/api/models"))).status).toBe(200);
    handle.flushFacts();
    expect(() => statSync(defaultFactCachePath(runsDir))).toThrow();
  });
});
