/**
 * A bare session store read beside the runs (`runner/src/session-store.ts`):
 * a standalone wrath-mcp's sessions listed and opened as runs under viewer ids
 * that never name the token's fingerprint, ingested by the collector's own
 * code, withheld from a public handle, and the API gating a viewer-only
 * deployment runs with.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionWriter, type SessionCharacter } from "@wrathbench/mcp/record";
import { createApi, INSPECTOR_BASE } from "../viewer/api";
import type { ApiInfoResponse, ResultsResponse, RunsResponse } from "../viewer/api-types";
import { runDir } from "../viewer/runs";
import { runsSource } from "../viewer/runs-source";
import { OPERATOR } from "@wrathbench/inspector";
import {
  attachSessionStore,
  bareSessionDir,
  bareSessionId,
  BARE_SESSION_PREFIX,
  isBareSessionId,
  listBareSessions,
  sessionStoreOf,
} from "../src/session-store";
import { isValidRunId } from "../viewer/runs";
import { FANOUT_SEP, parseFanoutSessionId, readRunRow } from "../src/run-reader";
import { isNotAModelRun } from "../src/drivers";
import { harnessOfRun } from "../src/comparability";
import { Collector } from "../../collector/src/collector";
import { readConfig } from "../../collector/src/config";
import { OffsetStore } from "../../collector/src/offsets";
import { recordDrain, traceOfReading } from "./fixtures/v1-session";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();

/** Two fingerprints, as `tokenFingerprint` makes them: 16 hex characters. */
const FP_A = "a1b2c3d4e5f60718";
const FP_B = "0f1e2d3c4b5a6978";
const FP_EMPTY = "deadbeefcafe0001";
const HERO: SessionCharacter = { guid: "11", name: "Bramblewick", race: 4, class: 11 };

/**
 * A session the way a standalone wrath-mcp leaves one in its store: its
 * directory named by the fingerprint, opened, a few readings in its trace,
 * and closed unless `open` is asked for.
 */
async function writeBareSession(store: string, fp: string, o: { at: number; character?: SessionCharacter | null; open?: boolean }): Promise<string> {
  const dir = join(store, fp);
  const clock = { now: o.at };
  const writer = new SessionWriter({ dir, id: fp, stack: { version: "0.0.0-test" }, now: () => clock.now, log: () => {} });
  writer.open();
  if (o.character !== null) {
    const r1 = traceOfReading({ ts: o.at + 1_000, level: 4, xp: 300, map: 1, x: 10, y: 20, z: 30, money: 55 });
    const r2 = traceOfReading({ ts: o.at + 60_000, level: 5, xp: 120, map: 1, x: 40, y: 50, z: 30, money: 80 });
    clock.now = o.at + 60_000;
    writer.ingest(recordDrain({ trace: [...r1.trace, ...r2.trace], character: o.character ?? HERO }));
  }
  if (o.open !== true) {
    clock.now = o.at + 120_000;
    await writer.close();
  }
  return dir;
}

/** Every file name and the text of every body a test fetched: what must never carry a fingerprint. */
function assertNoFingerprint(text: string): void {
  for (const fp of [FP_A, FP_B, FP_EMPTY]) expect(text).not.toContain(fp);
}

describe("viewer ids", () => {
  test("are a fixed prefix and 16 hex, stable, distinct, and never the fingerprint", () => {
    const a = bareSessionId(FP_A);
    expect(a).toMatch(/^mcp-[0-9a-f]{16}$/);
    expect(a.startsWith(BARE_SESSION_PREFIX)).toBe(true);
    expect(bareSessionId(FP_A)).toBe(a);
    expect(bareSessionId(FP_B)).not.toBe(a);
    expect(a).not.toContain(FP_A);
    expect(a.slice(BARE_SESSION_PREFIX.length)).not.toBe(FP_A);
    expect(isBareSessionId(a)).toBe(true);
    expect(isBareSessionId(FP_A)).toBe(false);
    expect(isBareSessionId("run-20261121-120000")).toBe(false);
  });

  test("are valid run ids that the fan-out split never reads as a character", () => {
    const a = bareSessionId(FP_A);
    expect(isValidRunId(a)).toBe(true);
    expect(a.includes(FANOUT_SEP)).toBe(false);
    expect(parseFanoutSessionId(a)).toBeNull();
  });

  test("do not collide across many fingerprints", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 5000; i++) ids.add(bareSessionId(i.toString(16).padStart(16, "0")));
    expect(ids.size).toBe(5000);
  });
});

describe("the store", () => {
  test("lists sessions with a character, opens them by id, and hides a record that never reached the world", async () => {
    const store = tempDir("wb-store-");
    await writeBareSession(store, FP_A, { at: 1_767_225_600_000 });
    await writeBareSession(store, FP_EMPTY, { at: 1_767_225_600_000, character: null });
    // Not a session: a name that is not 16 hex, and a session-named directory with nothing in it.
    mkdirSync(join(store, "not-a-session"));
    mkdirSync(join(store, "1234567890abcdef"));
    const listed = listBareSessions(store);
    expect(listed.map((s) => s.id)).toEqual([bareSessionId(FP_A)]);
    expect(bareSessionDir(store, bareSessionId(FP_A))).toBe(join(store, FP_A));
    expect(bareSessionDir(store, bareSessionId(FP_EMPTY))).toBeNull();
    expect(bareSessionDir(store, FP_A)).toBeNull();
    expect(listBareSessions(join(store, "absent"))).toEqual([]);
  });

  test("a bare session's row is its session.json's and carries no fingerprint", async () => {
    const store = tempDir("wb-store-");
    const dir = await writeBareSession(store, FP_A, { at: 1_767_225_600_000 });
    const row = readRunRow(dir, bareSessionId(FP_A))!;
    expect(row["character"]).toBe("Bramblewick");
    expect(row["started_at"]).toBe(1_767_225_600_000);
    expect(row["ended_at"]).toBe(1_767_225_720_000);
    expect(row["driver"]).toBeNull();
    expect(row["model"]).toBeNull();
    expect(JSON.parse(row["config_json"] as string)).toEqual({ character: "Bramblewick", race: 4, class: 11 });
    assertNoFingerprint(JSON.stringify(row));
    // No driver and no stamp: what the predicates read of it, pinned.
    expect(isNotAModelRun({ driver: null, unscored: null })).toBe(false);
    expect(harnessOfRun({ comparability: null, driver: null })).toBeNull();
  });

  test("runDir resolves an id into the attached store, and a run directory of the same name wins", async () => {
    const runs = tempDir("wb-runs-");
    const store = tempDir("wb-store-");
    await writeBareSession(store, FP_A, { at: 1_767_225_600_000 });
    await writeBareSession(store, FP_B, { at: 1_767_225_700_000 });
    const idA = bareSessionId(FP_A);
    const idB = bareSessionId(FP_B);
    expect(runDir(runs, idA)).toBeNull();
    attachSessionStore(runs, store);
    expect(sessionStoreOf(runs)).toBe(store);
    expect(runDir(runs, idA)).toBe(join(store, FP_A));
    // A run named like a viewer id shadows the session, which then is not listed.
    mkdirSync(join(runs, idB));
    writeFileSync(join(runs, idB, "meta.json"), JSON.stringify({ runId: idB, startedAt: 1, config: {} }));
    expect(runDir(runs, idB)).toBe(join(runs, idB));
    const listed = await runsSource(runs).list(OPERATOR);
    expect(listed.map((e) => e.id)).toEqual([idA]);
    expect(listed[0]!.session.id).toBe(idA);
    attachSessionStore(runs, null);
    expect(runDir(runs, idA)).toBeNull();
  });
});

describe("the collector", () => {
  test("ingests a bare session under its viewer id, and leaves the empty one out", async () => {
    const runs = tempDir("wb-runs-");
    const store = tempDir("wb-store-");
    await writeBareSession(store, FP_A, { at: 1_767_225_600_000 });
    await writeBareSession(store, FP_EMPTY, { at: 1_767_225_600_000, character: null });
    const rows = new Map<string, Record<string, unknown>[]>();
    const sink = {
      async insert(table: string, batch: readonly unknown[]) {
        rows.set(table, [...(rows.get(table) ?? []), ...(batch as Record<string, unknown>[])]);
      },
      async exec() {},
    };
    const cfg = readConfig({ runsDir: runs, dataDir: runs, stateDb: ":memory:", sessionStore: store });
    const stats = await new Collector({ cfg, sink, offsets: new OffsetStore(":memory:"), log: () => {} }).pass();
    const id = bareSessionId(FP_A);
    expect(stats.seen).toBe(1);
    const run = rows.get("runs")!;
    expect(run.map((r) => r["run_id"])).toEqual([id]);
    expect(run[0]!["character"]).toBe("Bramblewick");
    expect(run[0]!["started_at"]).toBe(1_767_225_600_000);
    expect(run[0]!["driver"]).toBe("");
    expect(run[0]!["model"]).toBe("");
    expect(run[0]!["meta_json"]).toBe("");
    const states = rows.get("states")!;
    expect(states.length).toBeGreaterThan(0);
    expect(new Set(states.map((s) => s["run_id"]))).toEqual(new Set([id]));
    expect(Math.max(...states.map((s) => Number(s["level"])))).toBe(5);
    // No trajectory: no totals, so no `RunFact`, so the scheduler never counts it.
    expect(rows.get("run_totals")).toBeUndefined();
    assertNoFingerprint(JSON.stringify([...rows.values()]));
  });

  test("an unset store reads no sessions, whatever the env says", async () => {
    const runs = tempDir("wb-runs-");
    const cfg = readConfig({ runsDir: runs, dataDir: runs, stateDb: ":memory:", sessionStore: null });
    expect(cfg.sessionStore).toBeNull();
  });
});

describe("the API", () => {
  const VIEWER_ONLY = { runner: false, evals: false, viewer: true } as const;

  async function setup() {
    const runs = tempDir("wb-runs-");
    const store = tempDir("wb-store-");
    const at = Date.now() - 10 * 60_000;
    await writeBareSession(store, FP_A, { at });
    await writeBareSession(store, FP_EMPTY, { at, character: null });
    const handle = createApi({ runsDir: runs, tilesDir: join(runs, "tiles"), moduleUrl: "http://127.0.0.1:1", groups: VIEWER_ONLY, sessionStore: store });
    const get = async (path: string): Promise<{ status: number; text: string }> => {
      const res = await handle(new Request(`http://127.0.0.1${path}`));
      return { status: res.status, text: await res.text() };
    };
    return { runs, store, handle, get, id: bareSessionId(FP_A) };
  }

  test("lists the session in the runs listing and opens its run page, never naming its fingerprint", async () => {
    const { get, id } = await setup();
    const bodies: string[] = [];

    const runsRes = await get("/api/runs");
    expect(runsRes.status).toBe(200);
    bodies.push(runsRes.text);
    const listed = (JSON.parse(runsRes.text) as RunsResponse).runs;
    expect(listed.map((r) => r.runId)).toEqual([id]);
    expect(listed[0]!.character).toBe("Bramblewick");
    expect(listed[0]!.level).toBe(5);
    expect(listed[0]!.model).toBeNull();
    expect(listed[0]!.driver).toBeNull();

    // The runs page's own call, and the default one: evals off, so every episode and no eval verdicts.
    for (const q of ["/api/results?episode=all&includeOverrides=1&harness=all", "/api/results"]) {
      const res = await get(q);
      expect(res.status).toBe(200);
      bodies.push(res.text);
      const body = JSON.parse(res.text) as ResultsResponse;
      expect(body.episode).toBe("all");
      expect(body.runs.map((r) => r.runId)).toEqual([id]);
      const row = body.runs[0]!;
      expect(row.condition).toBeUndefined();
      expect(row.wiki).toBeUndefined();
      expect(row.unscored).not.toBeNull();
      expect(row.episode).toBeNull();
      expect(row.maxLevel).toBe(5);
    }

    for (const path of [`/api/run/${id}`, `/api/run/${id}/trace`, `/api/run/${id}/track`, `/api/run/${id}/entries`, `/api/character/${id}`]) {
      const res = await get(path);
      expect({ path, status: res.status }).toEqual({ path, status: 200 });
      bodies.push(res.text);
    }
    const detail = JSON.parse((await get(`/api/run/${id}`)).text) as { run: { runId: string; character: string | null; className: string | null } };
    expect(detail.run.runId).toBe(id);
    expect(detail.run.character).toBe("Bramblewick");

    const sessions = await get(`${INSPECTOR_BASE}/sessions`);
    bodies.push(sessions.text);
    expect((JSON.parse(sessions.text) as { sessions: { id: string }[] }).sessions.map((s) => s.id)).toEqual([id]);
    const one = await get(`${INSPECTOR_BASE}/sessions/${id}`);
    expect(one.status).toBe(200);
    bodies.push(one.text);
    expect((JSON.parse(one.text) as { session: { id: string } }).session.id).toBe(id);

    // The fingerprint opens nothing, by any route.
    expect((await get(`/api/run/${FP_A}`)).status).toBe(404);
    expect((await get(`${INSPECTOR_BASE}/sessions/${FP_A}`)).status).toBe(404);
    // The empty record is neither listed nor opened.
    expect((await get(`/api/run/${bareSessionId(FP_EMPTY)}`)).status).toBe(404);

    for (const b of bodies) assertNoFingerprint(b);
  });

  test("a viewer-only deployment has no runner or evals routes", async () => {
    const { get } = await setup();
    for (const path of ["/api/tools", "/api/fleet", "/api/models", "/api/ladder", "/api/episodes"]) {
      expect({ path, status: (await get(path)).status }).toEqual({ path, status: 404 });
    }
    const info = JSON.parse((await get("/api/info")).text) as ApiInfoResponse;
    expect(info.groups).toEqual({ ...VIEWER_ONLY });
  });

  test("with evals on, an absent episode filter is still the scored tier", async () => {
    const runs = tempDir("wb-runs-");
    const store = tempDir("wb-store-");
    await writeBareSession(store, FP_A, { at: Date.now() - 600_000 });
    const handle = createApi({ runsDir: runs, tilesDir: join(runs, "tiles"), moduleUrl: "http://127.0.0.1:1", sessionStore: store });
    const body = (await (await handle(new Request("http://127.0.0.1/api/results"))).json()) as ResultsResponse;
    expect(body.episode).toBe("e90");
    expect(body.runs).toEqual([]);
    const all = (await (await handle(new Request("http://127.0.0.1/api/results?episode=all"))).json()) as ResultsResponse;
    expect(all.runs[0]!.condition).toBeDefined();
    expect((await handle(new Request("http://127.0.0.1/api/tools"))).status).toBe(200);
  });

  test("a public handle withholds every bare session", async () => {
    const runs = tempDir("wb-runs-");
    const store = tempDir("wb-store-");
    await writeBareSession(store, FP_A, { at: Date.now() - 600_000 });
    const handle = createApi({ runsDir: runs, tilesDir: join(runs, "tiles"), moduleUrl: "http://127.0.0.1:1", publicMode: true, sessionStore: store });
    const id = bareSessionId(FP_A);
    const listed = (await (await handle(new Request("http://127.0.0.1/api/runs"))).json()) as RunsResponse;
    expect(listed.runs).toEqual([]);
    expect((await handle(new Request(`http://127.0.0.1/api/run/${id}`))).status).toBe(404);
  });

  test("the store is read, never written", async () => {
    const { get, store, id } = await setup();
    const before = readdirSync(join(store, FP_A)).sort();
    await get("/api/runs");
    await get(`/api/run/${id}`);
    expect(readdirSync(join(store, FP_A)).sort()).toEqual(before);
  });
});
