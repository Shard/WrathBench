/**
 * The read-only API surface: what it serves, and what it must never serve.
 *
 * The leak test asserts on the secret's *value*, not on the absence of a key
 * name. The bearer token reaches a client through the `meta` trajectory entry
 * (the generic summariser copies the whole run config) and through the raw
 * line, and a "no field called token" assertion would pass while the value sat
 * nested inside `config_json` or a shrunk object.
 */

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UNBUILT_NOTICE, createApi, harnessSeriesCensus, readFleet } from "../viewer/api";
import { redactRawLine, redactSecrets } from "../viewer/tail";

const SENTINEL = "sentinel-bearer-2f9c1a";
const RUN_ID = "fixture-run-1";

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "viewer-api-"));
  const runs = join(root, "runs");
  const dir = join(runs, RUN_ID);
  mkdirSync(dir, { recursive: true });

  const config = {
    runId: RUN_ID,
    moduleUrl: "http://worldserver:8086",
    token: SENTINEL,
    character: "Fixturely",
    account: "RUNNER",
    model: "test/model",
    apiBase: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_KEY",
  };
  writeFileSync(
    join(dir, "meta.json"),
    JSON.stringify({ runId: RUN_ID, harnessVersion: "harness-test", startedAt: 1000, config }),
  );
  const lines = [
    { ts: 1000, t: "meta", runId: RUN_ID, harnessVersion: "harness-test", config },
    { ts: 1100, t: "response", turn: 1, message: { role: "assistant", content: "hello" } },
    { ts: 1200, t: "snippet", turn: 1, code: "await sdk.moveTo(1, 2, 3);" },
  ];
  writeFileSync(join(dir, "trajectory.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  writeFileSync(join(dir, "scratchpad.md"), "plan: dig a hole\n");

  const db = new Database(join(dir, "run.sqlite"));
  db.run(
    `CREATE TABLE run (run_id TEXT, model TEXT, driver TEXT, shakeout TEXT,
       harness_version TEXT, started_at INTEGER, ended_at INTEGER, termination_reason TEXT,
       termination_detail TEXT, pause_reason TEXT, config_json TEXT)`,
  );
  db.run(`INSERT INTO run VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [
    RUN_ID, "test/model", "openai", null, "harness-test", 1000, null, null, null, null,
    JSON.stringify(config),
  ]);
  db.run(
    `CREATE TABLE state (run_id TEXT, ts INTEGER, level INTEGER, xp INTEGER, map INTEGER,
       x REAL, y REAL, z REAL, event_count INTEGER, last_seq INTEGER, money INTEGER,
       quests_completed INTEGER)`,
  );
  db.run(`INSERT INTO state VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [
    RUN_ID, Date.now(), 3, 400, 0, -6240, 380, 385, 12, 99, 1234, 2,
  ]);
  db.close();
  return runs;
}

function api(runs: string, publicMode = false, dashboardDir?: string, moduleUrl?: string): (r: Request) => Promise<Response> {
  // Tests never reach a real module: an unroutable loopback port stands in for "server down".
  return createApi({ runsDir: runs, tilesDir: join(runs, "..", "minimap"), publicMode, dashboardDir, moduleUrl: moduleUrl ?? "http://127.0.0.1:1" });
}

async function body(res: Response): Promise<string> {
  return await res.text();
}

describe("secret redaction", () => {
  test("redactSecrets replaces values at any depth, arrays included", () => {
    const out = redactSecrets({ a: { token: "x" }, b: [{ token: "y" }], apiKeyEnv: "OPENROUTER_KEY" }) as Record<
      string,
      unknown
    >;
    expect(JSON.stringify(out)).not.toContain('"x"');
    expect(JSON.stringify(out)).not.toContain('"y"');
    // The env var *name* is not a secret; the value never reaches the file.
    expect(JSON.stringify(out)).toContain("OPENROUTER_KEY");
  });

  test("an unparseable line that mentions a secret key is withheld, not forwarded", () => {
    expect(redactRawLine('{"token":"abc" truncated')).not.toContain("abc");
    expect(redactRawLine("not json at all")).toBe("not json at all");
  });
});

describe("no endpoint serves the bearer token", () => {
  test("every read route, checked against the value", async () => {
    const runs = fixture();
    const handle = api(runs);
    const paths = [
      "/api/info",
      "/api/runs",
      "/api/positions",
      "/api/fleet",
      `/api/run/${RUN_ID}`,
      `/api/run/${RUN_ID}/entries?from=0&limit=500`,
      `/api/run/${RUN_ID}/raw/0`,
      `/api/run/${RUN_ID}/raw/1`,
      `/api/run/${RUN_ID}/scratchpad`,
    ];
    for (const p of paths) {
      const text = await body(await handle(new Request(`http://x${p}`)));
      expect(`${p}: ${text}`).not.toContain(SENTINEL);
    }
  });

  test("the meta entry still lists its other config, so redaction is targeted", async () => {
    const runs = fixture();
    const handle = api(runs);
    const text = await body(await handle(new Request(`http://x/api/run/${RUN_ID}/entries?from=0`)));
    expect(text).toContain("Fixturely");
    expect(text).toContain("OPENROUTER_KEY");
  });
});

/**
 * A runs directory holding a resumed run that ended, and one that is still
 * being driven. No sqlite: `readRun` degrades to meta + mtime, which is exactly
 * the path a live run's liveness takes.
 */
function pausedFixture(now: number): string {
  const runs = mkdtempSync(join(tmpdir(), "viewer-playtime-"));
  const write = (id: string, startedAt: number, lines: object[]): void => {
    const dir = join(runs, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ runId: id, startedAt, config: {} }));
    writeFileSync(join(dir, "trajectory.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  };
  // Ended after two pause/resume gaps: 1s + 1s + 1s driven out of a 10s span.
  write("resumed-run", 1000, [
    { ts: 1000, t: "meta", runId: "resumed-run" },
    { ts: 2000, t: "pause", reason: "rate-limited" },
    { ts: 5000, t: "resume" },
    { ts: 6000, t: "pause", reason: "rate-limited" },
    { ts: 9000, t: "resume" },
    { ts: 10000, t: "termination", reason: "episode-limit" },
  ]);
  // Live, driving: one open segment a minute old.
  write("live-run", now - 60_000, [
    { ts: now - 60_000, t: "meta", runId: "live-run" },
    { ts: now - 1_000, t: "state", level: 2 },
  ]);
  // Live by mtime, but paused half a minute ago: the pause must not count.
  write("live-paused-run", now - 60_000, [
    { ts: now - 60_000, t: "meta", runId: "live-paused-run" },
    { ts: now - 30_000, t: "pause", reason: "rate-limited" },
  ]);
  return runs;
}

/**
 * Two runs, one of each era: a run launched since the id is stamped, and a
 * backlog run whose only record of it is inside the trajectory.
 */
function resolvedFixture(): string {
  const runs = mkdtempSync(join(tmpdir(), "viewer-resolved-"));
  const write = (id: string, meta: object, lines: object[]): void => {
    const dir = join(runs, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ runId: id, startedAt: 1000, ...meta }));
    writeFileSync(join(dir, "trajectory.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  };
  // Stamped at write time, and the trajectory disagrees — a later segment
  // resolved elsewhere. The stamp is the run's answer and must win.
  write(
    "stamped-run",
    { config: { model: "sonnet", driver: "claude-code" }, resolved: { model: "claude-sonnet-5", cliVersion: "2.1.239" } },
    [
      { ts: 1000, t: "meta", runId: "stamped-run" },
      { ts: 1100, t: "claude_system", type: "system", subtype: "init", model: "claude-opus-5", claude_code_version: "9.9.9" },
      { ts: 1200, t: "response", turn: 1, message: { role: "assistant", content: "hi" } },
    ],
  );
  // The backlog: nothing on meta, the answer only in the trajectory.
  write("backlog-run", { config: { model: "opus", driver: "claude-code" } }, [
    { ts: 1000, t: "meta", runId: "backlog-run" },
    { ts: 1100, t: "claude_system", type: "system", subtype: "init", model: "claude-opus-5", claude_code_version: "2.1.239" },
    { ts: 1200, t: "response", turn: 1, message: { role: "assistant", content: "hi" } },
  ]);
  return runs;
}

describe("the resolved model id", () => {
  test("a stamped run keeps its own answer; a backlog run is back-filled from its trajectory", async () => {
    const runs = resolvedFixture();
    const handle = api(runs);
    const listed = (await (await handle(new Request("http://x/api/runs"))).json()) as {
      runs: { runId: string; model: string | null; resolvedModel: string | null; cliVersion: string | null }[];
    };
    const by = new Map(listed.runs.map((r) => [r.runId, r]));
    // Stamped beats derived: the trajectory's later `claude-opus-5` is ignored.
    expect(by.get("stamped-run")).toMatchObject({
      model: "sonnet",
      resolvedModel: "claude-sonnet-5",
      cliVersion: "2.1.239",
    });
    // Nothing was written back — the run directory is read differently, not rewritten.
    expect(JSON.parse(readFileSync(join(runs, "backlog-run", "meta.json"), "utf8"))["resolved"]).toBeUndefined();
    expect(by.get("backlog-run")).toMatchObject({
      model: "opus",
      resolvedModel: "claude-opus-5",
      cliVersion: "2.1.239",
    });

    // The same answer on the results surface and on the run page, off the one
    // derivation: a chart and a run page may not disagree about what ran.
    const results = (await (await handle(new Request("http://x/api/results?episode=all"))).json()) as {
      runs: { runId: string; resolvedModel?: string | null }[];
    };
    expect(new Map(results.runs.map((r) => [r.runId, r.resolvedModel])).get("backlog-run")).toBe("claude-opus-5");
    const detail = (await (await handle(new Request("http://x/api/run/backlog-run"))).json()) as {
      run: { resolvedModel: string | null; cliVersion: string | null };
    };
    expect(detail.run).toMatchObject({ resolvedModel: "claude-opus-5", cliVersion: "2.1.239" });
    rmSync(runs, { recursive: true, force: true });
  });
});

describe("playtime", () => {
  test("the listing reports active time, not the span the trajectory covers", async () => {
    const now = Date.now();
    const runs = pausedFixture(now);
    const res = await api(runs)(new Request("http://x/api/runs"));
    const b = (await res.json()) as { runs: { runId: string; playtimeMs: number | null; live: boolean }[] };
    const by = new Map(b.runs.map((r) => [r.runId, r]));

    // Span 9000ms, of which 6000ms was spent paused.
    expect(by.get("resumed-run")!.playtimeMs).toBe(3000);

    const live = by.get("live-run")!;
    expect(live.live).toBe(true);
    expect(live.playtimeMs).toBeGreaterThanOrEqual(60_000);
    expect(live.playtimeMs).toBeLessThan(75_000);

    // Fresh files, but the run sits inside a pause: playtime stops at the pause.
    const paused = by.get("live-paused-run")!;
    expect(paused.live).toBe(true);
    expect(paused.playtimeMs).toBe(30_000);
  });

  test("the run page agrees with the listing", async () => {
    const now = Date.now();
    const runs = pausedFixture(now);
    const handle = api(runs);
    for (const id of ["resumed-run", "live-paused-run"]) {
      const list = (await (await handle(new Request("http://x/api/runs"))).json()) as {
        runs: { runId: string; playtimeMs: number | null }[];
      };
      const detail = (await (await handle(new Request(`http://x/api/run/${id}`))).json()) as {
        playtimeMs: number | null;
      };
      expect(detail.playtimeMs).toBe(list.runs.find((r) => r.runId === id)!.playtimeMs);
    }
  });

  test("a run with no pauses is unchanged: its whole span", async () => {
    const runs = fixture();
    const detail = (await (await api(runs)(new Request(`http://x/api/run/${RUN_ID}`))).json()) as {
      run: { live: boolean };
      playtimeMs: number | null;
    };
    // The fixture's files are fresh, so it reads live and counts to now.
    expect(detail.run.live).toBe(true);
    expect(detail.playtimeMs).toBeGreaterThan(Date.now() - 1000 - 5_000);
  });
});

describe("routes", () => {
  test("the run listing carries totals alongside the row", async () => {
    const runs = fixture();
    const res = await api(runs)(new Request("http://x/api/runs"));
    const b = (await res.json()) as { runs: { runId: string; tokens: unknown; level: number }[] };
    expect(b.runs).toHaveLength(1);
    expect(b.runs[0]!.runId).toBe(RUN_ID);
    expect(b.runs[0]!.level).toBe(3);
    expect(b.runs[0]!.tokens).not.toBeNull();
  });

  test("an unknown run is a 404, not a crash", async () => {
    const runs = fixture();
    expect((await api(runs)(new Request("http://x/api/run/nope"))).status).toBe(404);
  });

  test("a run id that tries to escape the runs directory is refused", async () => {
    const runs = fixture();
    const res = await api(runs)(new Request("http://x/api/run/..%2F..%2Fetc"));
    expect(res.status).toBe(404);
  });

  test("/api/info lists the harness series that have runs, newest first", async () => {
    const runs = fixture();
    const res = await api(runs)(new Request("http://x/api/info"));
    const b = (await res.json()) as { harnessSeries: { series: string; runs: number }[] };
    // The fixture's stamp (`harness-test`) names no series, and a run in no
    // group is never listed — only the selector's "all" shows it.
    expect(b.harnessSeries).toEqual([]);
  });

  test("the series census counts per series and orders numerically", () => {
    expect(
      harnessSeriesCensus([
        { harnessVersion: "harness-0.4-1-gaaa" },
        { harnessVersion: "harness-0.10-2-gbbb" },
        { harnessVersion: "harness-0.4-9-gccc" },
        { harnessVersion: "harness-0.9-1-gddd" },
        { harnessVersion: "0.0.0-phase0-unversioned" },
        { harnessVersion: null },
      ]),
    ).toEqual([
      { series: "0.10", runs: 1 },
      { series: "0.9", runs: 1 },
      { series: "0.4", runs: 2 },
    ]);
  });

  test("/api/info reports the mode the viewer is in", async () => {
    const runs = fixture();
    const res = await api(runs, true)(new Request("http://x/api/info"));
    const b = (await res.json()) as { publicMode: boolean; dashboard: boolean };
    expect(b.publicMode).toBe(true);
    expect(b.dashboard).toBe(false);
  });

  test("/api/info carries the worldserver build off /health, null when it is down or unstamped", async () => {
    const runs = fixture();
    // Down: the default test module URL is unroutable.
    const down = (await (await api(runs)(new Request("http://x/api/info"))).json()) as { worldserver: unknown };
    expect(down.worldserver).toBeNull();

    let hits = 0;
    let body: Record<string, unknown> = { ok: true, module: "mod-wrathbench", worldStopped: false, build: "harness-0.3-41-gabc123", startedAtMs: 1787400000000, uptimeMs: 7 };
    const stub = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => { hits++; return Response.json(body); } });
    try {
      const handle = api(runs, false, undefined, `http://127.0.0.1:${stub.port}`);
      const up = (await (await handle(new Request("http://x/api/info"))).json()) as { worldserver: unknown };
      expect(up.worldserver).toEqual({ build: "harness-0.3-41-gabc123", startedAtMs: 1787400000000 });
      // Cached: a second poll inside the window does not refetch.
      await handle(new Request("http://x/api/info"));
      expect(hits).toBe(1);
      // A module that predates the field (a fresh api, so no cache) reports null.
      body = { ok: true, module: "mod-wrathbench", worldStopped: false };
      const old = (await (await api(runs, false, undefined, `http://127.0.0.1:${stub.port}`)(new Request("http://x/api/info"))).json()) as { worldserver: unknown };
      expect(old.worldserver).toBeNull();
    } finally {
      stub.stop(true);
    }
  });
});

describe("public mode", () => {
  test("withholds raw entries, scratchpads and tiles; keeps the metadata", async () => {
    const runs = fixture();
    const handle = api(runs, true);
    expect((await handle(new Request(`http://x/api/run/${RUN_ID}/raw/0`))).status).toBe(403);
    expect((await handle(new Request(`http://x/api/run/${RUN_ID}/scratchpad`))).status).toBe(403);
    expect((await handle(new Request("http://x/tiles/0/43_31.png"))).status).toBe(403);
    expect((await handle(new Request("http://x/api/runs"))).status).toBe(200);
    expect((await handle(new Request(`http://x/api/run/${RUN_ID}/entries`))).status).toBe(200);
  });
});

describe("static hosting of the dashboard", () => {
  test("without a build, / is the not-built notice and not a fallback UI", async () => {
    const runs = fixture();
    const handle = api(runs);
    for (const path of ["/", "/run/anything", "/map"]) {
      const res = await handle(new Request(`http://x${path}`));
      expect(res.status).toBe(503);
      expect(await body(res)).toBe(UNBUILT_NOTICE);
    }
    // The API keeps serving with no build in place.
    expect((await handle(new Request("http://x/api/runs"))).status).toBe(200);
  });

  test("with a build, / serves index.html and unknown paths fall through to it", async () => {
    const runs = fixture();
    const dist = mkdtempSync(join(tmpdir(), "viewer-dist-"));
    mkdirSync(join(dist, "assets"), { recursive: true });
    writeFileSync(join(dist, "index.html"), "<html>spa</html>");
    writeFileSync(join(dist, "assets", "app-abc123.js"), "console.log(1)");
    const handle = api(runs, false, dist);

    expect(await body(await handle(new Request("http://x/")))).toBe("<html>spa</html>");
    // Client-side routing: a route with no file behind it is still the SPA.
    expect(await body(await handle(new Request("http://x/fleet")))).toBe("<html>spa</html>");
    const asset = await handle(new Request("http://x/assets/app-abc123.js"));
    expect(asset.headers.get("content-type")).toContain("javascript");
    expect(asset.headers.get("cache-control")).toContain("immutable");
    // And nothing under the dist root can be escaped out of.
    const esc = await handle(new Request("http://x/..%2F..%2Fetc%2Fpasswd"));
    expect(await body(esc)).toBe("<html>spa</html>");
  });

  test("a dashboard directory configured but not built serves the notice, not a 404", async () => {
    const runs = fixture();
    const empty = mkdtempSync(join(tmpdir(), "viewer-empty-"));
    const res = await api(runs, false, empty)(new Request("http://x/"));
    expect(res.status).toBe(503);
    expect(await body(res)).toBe(UNBUILT_NOTICE);
  });
});

/** A one-job fleet-state.json on `account`. */
function jobState(runs: string, account: string, extra: Record<string, unknown> = {}): void {
  writeFileSync(
    join(runs, "fleet-state.json"),
    JSON.stringify({
      fleetPid: 7,
      startedAt: 1,
      heartbeatAt: 2,
      containerized: true,
      stamp: "20260822",
      fleetConfig: "/wrathbench/infra/fleet.json",
      configLoadedAt: 3,
      accounts: { pinned: { SHAKEOUT: "probe-freeplay" }, pool: { [account]: "job-a" }, paid: { PAID: null } },
      jobs: {
        "job-a": {
          ref: "a",
          episode: "e90",
          account,
          source: "policy",
          attempt: 2,
          models: ["test/model", "next/model"],
          pid: 13,
          // Repo-relative and written by a container: never forwarded.
          rosterPath: "data/runs/fleet-a.roster.json",
          jsonl: "j",
          log: "l",
          spawnedAt: 1,
          exitCode: null,
          draining: false,
          alive: true,
        },
      },
      paused: [],
      ended: [],
      ...extra,
    }),
  );
}

describe("fleet state", () => {
  test("absent fleet-state.json reads as present:false, not an error", () => {
    const runs = fixture();
    const f = readFleet(runs);
    expect(f.present).toBe(false);
    expect(f.jobs).toEqual([]);
    expect(f.accounts).toEqual([]);
  });

  test("jobs are named and sorted, classed by their account, and host paths are not forwarded", () => {
    const runs = fixture();
    jobState(runs, "RUNNER", {
      jobs: {
        "z-e90": { ref: "z", episode: "e90", account: "PAID", source: "queue", models: ["z"], pid: 1, rosterPath: "r", jsonl: "j", log: "l", spawnedAt: 1, exitCode: null, draining: false, alive: true },
        "probe-freeplay": { ref: "probe", episode: "freeplay", account: "SHAKEOUT", source: "pinned", models: ["sonnet"], pid: 2, rosterPath: "r", jsonl: "j", log: "l", spawnedAt: 1, exitCode: 0, draining: true, alive: false },
      },
    });
    const f = readFleet(runs);
    expect(f.present).toBe(true);
    expect(f.jobs.map((j) => [j.name, j.accountClass])).toEqual([["probe-freeplay", "pinned"], ["z-e90", "paid"]]);
    expect(f.jobs[0]).toMatchObject({ alive: false, draining: true, exitCode: 0, pid: 2 });
    expect(f.configLoadedAt).toBe(3);
    expect(JSON.stringify(f)).not.toContain("fleet.json");
    expect(JSON.stringify(f)).not.toContain("rosterPath");
    // Accounts: pinned first (filtered against the classes), then the classes in order.
    expect(f.accounts).toEqual([
      { account: "SHAKEOUT", class: "pinned", job: "probe-freeplay" },
      { account: "RUNNER", class: "pool", job: "job-a" },
      { account: "PAID", class: "paid", job: null },
    ]);
  });

  test("each job names the run holding its account, and its models", () => {
    const runs = fixture();
    jobState(runs, "RUNNER");
    const f = readFleet(runs);
    expect(f.jobs[0]!.runId).toBe(RUN_ID);
    expect(f.jobs[0]!.model).toBe("test/model");
    expect(f.jobs[0]!.models).toEqual(["test/model", "next/model"]);
    expect(f.jobs[0]!.attempt).toBe(2);
  });

  test("a job whose account nobody holds reads as idle, not as driving a run", () => {
    const runs = fixture();
    jobState(runs, "RUNNER9");
    const f = readFleet(runs);
    expect(f.jobs[0]!.runId).toBeNull();
    expect(f.jobs[0]!.model).toBeNull();
  });

  test("a paused run has already freed its session, so it holds no account", () => {
    const runs = fixture();
    jobState(runs, "RUNNER");
    const db = new Database(join(runs, RUN_ID, "run.sqlite"));
    db.run(`UPDATE run SET pause_reason = 'deferred'`);
    db.close();
    expect(readFleet(runs).jobs[0]!.runId).toBeNull();
  });

  test("a run whose files have gone cold has let its account go", () => {
    const runs = fixture();
    jobState(runs, "RUNNER");
    const old = new Date(Date.now() - 10 * 60_000);
    for (const name of ["trajectory.jsonl", "run.sqlite"]) {
      utimesSync(join(runs, RUN_ID, name), old, old);
    }
    expect(readFleet(runs).jobs[0]!.runId).toBeNull();
  });

  test("the --status indicators ride along: session, gate, rejection, paused and ended", () => {
    const runs = fixture();
    const preflight = { at: 5, serverIdentity: "build:x@1", build: "harness-0.4-3-gabc", ok: true, results: [{ script: "infra/smoke/a.ts", ok: true, ms: 20_000, tail: "PASS" }] };
    jobState(runs, "RUNNER", {
      session: { finished: 12, ok: 11, retried: 3 },
      preflight,
      configRejected: { since: 9, error: "queue: bad", mtime: 10 },
      paused: [{ runId: "p-1", model: "m", account: "RUNNER2", reason: "rate-limited", since: 1, elapsedMs: 2, budgetMs: 3, why: "resuming after 17:00" }],
      ended: [{ runId: "e-1", model: "m", ref: "r", detail: "ended by the supervisor: model m no longer under ref r" }],
    });
    const f = readFleet(runs);
    expect(f.session).toEqual({ finished: 12, ok: 11, retried: 3 });
    expect(f.preflight).toEqual(preflight);
    // The rejection's file mtime is the supervisor's business, not the page's.
    expect(f.configRejected).toEqual({ since: 9, error: "queue: bad" });
    expect(f.paused).toHaveLength(1);
    expect(f.ended[0]!.runId).toBe("e-1");
  });

  test("a truncated fleet-state.json degrades to absent rather than throwing", () => {
    const runs = fixture();
    writeFileSync(join(runs, "fleet-state.json"), '{"jobs": {');
    expect(readFleet(runs).present).toBe(false);
  });

  test("server-state.json is served as `server`; absent, garbage or an unknown phase is `running` with nothing to say", () => {
    const runs = fixture();
    jobState(runs, "RUNNER");
    expect(readFleet(runs).server).toMatchObject({ phase: "running", build: "", detail: "" });
    writeFileSync(
      join(runs, "server-state.json"),
      JSON.stringify({ phase: "verifying", since: 1, build: "harness-0.4-52", prevBuild: "harness-0.4-3", detail: "gate smoke x (1 of 2)", pid: 123, updatedAt: 2 }),
    );
    const s = readFleet(runs).server;
    expect(s).toEqual({ phase: "verifying", since: 1, build: "harness-0.4-52", prevBuild: "harness-0.4-3", detail: "gate smoke x (1 of 2)", updatedAt: 2 });
    // The script's pid is a host fact and stays behind.
    expect(JSON.stringify(s)).not.toContain("123");
    writeFileSync(join(runs, "server-state.json"), JSON.stringify({ phase: "exploding", detail: "?" }));
    expect(readFleet(runs).server.phase).toBe("running");
    writeFileSync(join(runs, "server-state.json"), "{");
    expect(readFleet(runs).server.phase).toBe("running");
    // Served even when the fleet has never run here.
    rmSync(join(runs, "fleet-state.json"));
    writeFileSync(join(runs, "server-state.json"), JSON.stringify({ phase: "draining", since: 1, build: "b", detail: "d", updatedAt: 2 }));
    expect(readFleet(runs)).toMatchObject({ present: false, server: { phase: "draining" } });
  });
});

/**
 * The release-point surface: the comparability tuple on a run, and the two
 * derived routes the results charts and the map replay read.
 *
 * The fixture writes an old-shape `state` table with no `turn` column on
 * purpose — that is what every run recorded before this change looks like, and
 * both routes have to keep answering for it.
 */
describe("comparability, /api/results and /api/run/<id>/track", () => {
  const TUPLE = {
    harnessVersion: "harness-test",
    promptHash: "sha256:0123456789abcdef",
    promptChars: 4242,
    harness: "wrathbench",
    effort: "high",
    budget: {
      maxTurns: null,
      maxToolCalls: 500,
      idleMs: 600_000,
      noXpMs: null,
      episodeMs: 21_600_000,
      maxSandboxRestarts: 3,
    },
    objective: false,
    serverBuild: { build: "harness-test-1-gdeadbee", startedAtMs: 12_345 },
  };

  function stamped(runs: string, tuple: unknown): void {
    const path = join(runs, RUN_ID, "meta.json");
    const meta = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify({ ...meta, comparability: tuple }));
  }

  test("a stamped tuple reaches the run row; an unstamped run reads as null", async () => {
    const runs = fixture();
    const handle = api(runs);
    const before = (await (await handle(new Request(`http://x/api/run/${RUN_ID}`))).json()) as {
      run: { comparability: unknown };
    };
    expect(before.run.comparability).toBeNull();

    stamped(runs, TUPLE);
    const after = (await (await api(runs)(new Request(`http://x/api/run/${RUN_ID}`))).json()) as {
      run: { comparability: typeof TUPLE };
    };
    expect(after.run.comparability).toEqual(TUPLE);
  });

  test("a tuple this build cannot validate reads as not recorded, not as an error", async () => {
    const runs = fixture();
    stamped(runs, { harnessVersion: "v" });
    const res = await api(runs)(new Request(`http://x/api/run/${RUN_ID}`));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { run: { comparability: unknown } }).run.comparability).toBeNull();
  });

  test("states carry a turn index, null on a database written without the column", async () => {
    const runs = fixture();
    const d = (await (await api(runs)(new Request(`http://x/api/run/${RUN_ID}`))).json()) as {
      states: { turn: number | null }[];
    };
    expect(d.states).toHaveLength(1);
    expect(d.states[0]!.turn).toBeNull();
  });

  test("achievement and flight milestones cross the wire on both the results row and the run page", async () => {
    const runs = fixture();
    // Appended, not rewritten: this is what the loop adds to a live file.
    appendFileSync(
      join(runs, RUN_ID, "trajectory.jsonl"),
      [
        { ts: 1300, t: "milestone", kind: "achievements_at_login", ids: [6], points: 10, turn: 1 },
        { ts: 1400, t: "milestone", kind: "achievement", id: 12, name: "Explore Elwynn Forest", points: 10, turn: 1 },
        { ts: 1500, t: "milestone", kind: "taxi", from: { areaId: 9 }, turn: 2 },
      ]
        .map((l) => JSON.stringify(l))
        .join("\n") + "\n",
    );
    const handle = api(runs);
    const results = (await (await handle(new Request("http://x/api/results?episode=all"))).json()) as {
      runs: { runId: string; achievements: unknown; taxi: unknown }[];
    };
    const row = results.runs.find((r) => r.runId === RUN_ID)!;
    expect(row.achievements).toEqual({ earned: 2, points: 20, ids: [6, 12] });
    expect(row.taxi).toEqual({ flights: 1 });
    // The run page reads the same facts off the incremental tail, so the two
    // views of one run cannot disagree.
    const detail = (await (await handle(new Request(`http://x/api/run/${RUN_ID}`))).json()) as {
      achievements: unknown;
      taxi: unknown;
    };
    expect(detail.achievements).toEqual(row.achievements);
    expect(detail.taxi).toEqual(row.taxi);
  });

  test("a run with no milestone records reads not-recorded on both, never zero", async () => {
    const runs = fixture();
    const body = (await (await api(runs)(new Request("http://x/api/results?episode=all"))).json()) as {
      runs: { runId: string; achievements: unknown; taxi: unknown }[];
    };
    const row = body.runs.find((r) => r.runId === RUN_ID)!;
    expect(row.achievements).toBeNull();
    expect(row.taxi).toBeNull();
  });

  test("/api/results projects each run with its level marks and scorability", async () => {
    const runs = fixture();
    stamped(runs, TUPLE);
    // `?episode=all`: the default is the e90 *group*, and this fixture's tuple
    // predates episode ids, so it is labeled at most — never a member.
    const body = (await (await api(runs)(new Request("http://x/api/results?episode=all"))).json()) as {
      runs: {
        runId: string;
        effort: string | null;
        unscored: string | null;
        maxLevel: number | null;
        levels: { level: number; playtimeMs: number | null }[];
      }[];
    };
    const row = body.runs.find((r) => r.runId === RUN_ID)!;
    expect(row.effort).toBe("high");
    expect(row.unscored).toBeNull();
    expect(row.maxLevel).toBe(3);
    expect(row.levels).toHaveLength(1);
    // Active time is integrated over the trajectory's own segments, not wall clock.
    expect(row.levels[0]!.playtimeMs).not.toBeNull();
  });

  test("a results row carries the listing facts, and the actual cost only", async () => {
    const runs = fixture();
    const body = (await (await api(runs)(new Request("http://x/api/results?episode=all"))).json()) as {
      runs: {
        runId: string;
        character: string | null;
        playtimeMs: number | null;
        tokens: { totalTokens: number | null } | null;
        actualCost: { basis: string; note: string } | null;
        terminationReason: string | null;
        pauseReason: string | null;
      }[];
    };
    const row = body.runs.find((r) => r.runId === RUN_ID)!;
    expect(row.character).toBe("Fixturely");
    expect(row.playtimeMs).not.toBeNull();
    expect(row.tokens).not.toBeNull();
    // The actual figure is present as a figure — with a basis and a note — even
    // when there is nothing to bill; a blank cost must still say which nothing.
    expect(row.actualCost).not.toBeNull();
    expect(["reported", "none"]).toContain(row.actualCost!.basis);
    expect(row.actualCost!.note.length).toBeGreaterThan(0);
    // `expected` is deliberately absent: this row may not carry an estimate.
    expect(row.actualCost).not.toHaveProperty("expected");
  });

  test("?episode=all is every run /api/runs lists — the episodes page replaces the fleet's table", async () => {
    const runs = fixture();
    const listing = (await (await api(runs)(new Request("http://x/api/runs"))).json()) as {
      runs: { runId: string }[];
    };
    const results = (await (await api(runs)(new Request("http://x/api/results?episode=all"))).json()) as {
      runs: { runId: string }[];
    };
    expect(results.runs.map((r) => r.runId).sort()).toEqual(listing.runs.map((r) => r.runId).sort());
  });

  test("/api/eval is gone: a rename is a rename, with no alias behind it", async () => {
    const runs = fixture();
    expect((await api(runs)(new Request("http://x/api/eval"))).status).toBe(404);
    expect((await api(runs)(new Request("http://x/api/ladder?episode=all"))).status).toBe(200);
  });

  test("/api/results defaults to the e90 group, and says how much it dropped", async () => {
    const runs = fixture();
    stamped(runs, TUPLE); // a six-hour tuple with no episode id: not a member
    const res = await api(runs)(new Request("http://x/api/results"));
    const body = (await res.json()) as {
      runs: { runId: string }[]; episode: string; filteredOut: number; includeOverrides: boolean;
    };
    expect(body.episode).toBe("e90");
    expect(body.includeOverrides).toBe(false);
    expect(body.runs).toHaveLength(0);
    expect(body.filteredOut).toBe(1);
  });

  test("a stamped e90 run is a member; overriding its leash takes it out until asked for", async () => {
    const runs = fixture();
    const e90 = { ...TUPLE, episode: "e90", episodeOverride: false };
    stamped(runs, e90);
    const members = (await (await api(runs)(new Request("http://x/api/results"))).json()) as {
      runs: { runId: string }[]; overridesExcluded: number;
    };
    expect(members.runs.map((r) => r.runId)).toEqual([RUN_ID]);

    stamped(runs, { ...e90, episodeOverride: true });
    const without = (await (await api(runs)(new Request("http://x/api/results"))).json()) as {
      runs: unknown[]; overridesExcluded: number;
    };
    expect(without.runs).toHaveLength(0);
    expect(without.overridesExcluded).toBe(1);
    const with_ = (await (await api(runs)(new Request("http://x/api/results?includeOverrides=1"))).json()) as {
      runs: { runId: string; episodeOverride: boolean }[];
    };
    expect(with_.runs[0]!.episodeOverride).toBe(true);
  });

  test("/api/ladder is the same projection under the same filter", async () => {
    const runs = fixture();
    stamped(runs, { ...TUPLE, episode: "e360", episodeOverride: false });
    const e360 = (await (await api(runs)(new Request("http://x/api/ladder?episode=e360"))).json()) as {
      runs: { runId: string }[]; episode: string;
    };
    expect(e360.episode).toBe("e360");
    expect(e360.runs.map((r) => r.runId)).toEqual([RUN_ID]);
    const e90 = (await (await api(runs)(new Request("http://x/api/ladder"))).json()) as { runs: unknown[] };
    expect(e90.runs).toHaveLength(0);
  });

  test("harness is a tag on every results row, not a partition; ?harness= is an optional filter defaulting to all", async () => {
    const runs = fixture();
    stamped(runs, { ...TUPLE, harness: "claude-code" });

    const all = (await (await api(runs)(new Request("http://x/api/results?episode=all"))).json()) as {
      harness: string;
      runs: { runId: string; harness: string | null; unscored: string | null }[];
    };
    expect(all.harness).toBe("all");
    const row = all.runs.find((r) => r.runId === RUN_ID)!;
    expect(row.harness).toBe("claude-code");
    expect(row.unscored).toBeNull();

    const only = (await (await api(runs)(new Request("http://x/api/results?episode=all&harness=claude-code"))).json()) as {
      harness: string; runs: { runId: string }[]; filteredOut: number;
    };
    expect(only.harness).toBe("claude-code");
    expect(only.runs.map((r) => r.runId)).toContain(RUN_ID);

    const none = (await (await api(runs)(new Request("http://x/api/results?episode=all&harness=wrathbench"))).json()) as {
      runs: { runId: string }[]; filteredOut: number;
    };
    expect(none.runs.map((r) => r.runId)).not.toContain(RUN_ID);
    expect(none.filteredOut).toBeGreaterThanOrEqual(1);

    expect((await api(runs)(new Request("http://x/api/results?harness=bogus"))).status).toBe(400);
    expect((await api(runs)(new Request("http://x/api/models?harness=bogus"))).status).toBe(400);
  });

  test("an unknown ?episode= is a 400, never a silent fallback to the default", async () => {
    const res = await api(fixture())(new Request("http://x/api/results?episode=e42"));
    expect(res.status).toBe(400);
  });

  test("/api/episodes serves the table and counts members apart from labels", async () => {
    const runs = fixture();
    stamped(runs, { ...TUPLE, episode: "e90", episodeOverride: true });
    const body = (await (await api(runs)(new Request("http://x/api/episodes"))).json()) as {
      episodes: { id: string; minutes: number | null; toolCalls: number | null; summary: string;
        members: number; overrides: number; derived: number; lapsed: number }[];
      untiered: number;
    };
    expect(body.episodes.map((e) => e.id)).toEqual(["e90", "e360", "probing", "freeplay"]);
    const e90 = body.episodes[0]!;
    expect(e90.minutes).toBe(90);
    expect(e90.toolCalls).toBe(3000);
    expect(e90.summary.length).toBeGreaterThan(80);
    // `lapsed` is the attempt-not-episode bucket: stamped with the id, never
    // a recorded episode. Nothing in the fixture ended that way, so it is
    // zero here.
    expect(e90).toMatchObject({ members: 0, overrides: 1, derived: 0, lapsed: 0 });
    expect(body.untiered).toBe(0);
  });

  test("/api/run/<id>/track serves the recorded positions", async () => {
    const runs = fixture();
    const body = (await (await api(runs)(new Request(`http://x/api/run/${RUN_ID}/track`))).json()) as {
      character: string | null;
      points: { map: number; x: number; y: number }[];
    };
    expect(body.character).toBe("Fixturely");
    expect(body.points).toHaveLength(1);
    expect(body.points[0]).toMatchObject({ map: 0, x: -6240, y: 380 });
  });

  test("the new routes leak no secret either", async () => {
    const runs = fixture();
    stamped(runs, TUPLE);
    for (const p of ["/api/results", `/api/run/${RUN_ID}/track`]) {
      expect(await body(await api(runs)(new Request(`http://x${p}`)))).not.toContain(SENTINEL);
    }
  });
});
