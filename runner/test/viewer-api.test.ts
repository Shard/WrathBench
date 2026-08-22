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
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UNBUILT_NOTICE, createApi, readFleet } from "../viewer/api";
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
    `CREATE TABLE run (run_id TEXT, model TEXT, driver TEXT, adapter TEXT, shakeout TEXT,
       harness_version TEXT, started_at INTEGER, ended_at INTEGER, termination_reason TEXT,
       termination_detail TEXT, pause_reason TEXT, config_json TEXT)`,
  );
  db.run(`INSERT INTO run VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [
    RUN_ID, "test/model", "openai", "openai", null, "harness-test", 1000, null, null, null, null,
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

function api(runs: string, publicMode = false, dashboardDir?: string): (r: Request) => Promise<Response> {
  return createApi({ runsDir: runs, tilesDir: join(runs, "..", "minimap"), publicMode, dashboardDir });
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

  test("/api/info reports the mode the viewer is in", async () => {
    const runs = fixture();
    const res = await api(runs, true)(new Request("http://x/api/info"));
    const b = (await res.json()) as { publicMode: boolean; dashboard: boolean };
    expect(b.publicMode).toBe(true);
    expect(b.dashboard).toBe(false);
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

/** A one-lane fleet-state.json on `account`, with a roster beside it. */
function laneState(runs: string, account: string): void {
  writeFileSync(
    join(runs, "fleet-state.json"),
    JSON.stringify({
      fleetPid: 7,
      startedAt: 1,
      heartbeatAt: 2,
      containerized: true,
      stamp: "20260822",
      lanes: {
        "lane-a": {
          pid: 13,
          account,
          // Repo-relative and written by a container: only the basename is trusted.
          rosterPath: "data/runs/fleet-a.roster.json",
          jsonl: "j",
          stdoutLog: "l",
          spawnedAt: 1,
          exitCode: null,
          draining: false,
          alive: true,
        },
      },
    }),
  );
}

describe("fleet state", () => {
  test("absent fleet-state.json reads as present:false, not an error", () => {
    const runs = fixture();
    const f = readFleet(runs);
    expect(f.present).toBe(false);
    expect(f.lanes).toEqual([]);
  });

  test("lanes are flattened and named, host paths are not forwarded", () => {
    const runs = fixture();
    writeFileSync(
      join(runs, "fleet-state.json"),
      JSON.stringify({
        fleetPid: 7,
        startedAt: 1,
        heartbeatAt: 2,
        containerized: true,
        stamp: "20260822",
        fleetConfig: "/wrathbench/infra/fleet.json",
        lanes: {
          "ox-alpha": { pid: 13, account: "RUNNER", rosterPath: "r", jsonl: "j", stdoutLog: "l", spawnedAt: 1, exitCode: null, draining: false, alive: true },
        },
      }),
    );
    const f = readFleet(runs);
    expect(f.present).toBe(true);
    expect(f.lanes.map((l) => l.name)).toEqual(["ox-alpha"]);
    expect(f.lanes[0]!.account).toBe("RUNNER");
    expect(JSON.stringify(f)).not.toContain("fleet.json");
  });

  test("each lane names the run holding its account, and its roster", () => {
    const runs = fixture();
    laneState(runs, "RUNNER");
    writeFileSync(
      join(runs, "fleet-a.roster.json"),
      JSON.stringify([
        { model: "test/model", apiKeyEnv: "SECRET_ENV", apiBase: "https://x/v1" },
        { model: "next/model" },
      ]),
    );
    const f = readFleet(runs);
    expect(f.lanes[0]!.runId).toBe(RUN_ID);
    expect(f.lanes[0]!.model).toBe("test/model");
    expect(f.lanes[0]!.rosterModels).toEqual(["test/model", "next/model"]);
    // The roster is projected, never forwarded: nothing but the model names.
    expect(JSON.stringify(f)).not.toContain("SECRET_ENV");
  });

  test("a lane whose account nobody holds reads as idle, not as driving a run", () => {
    const runs = fixture();
    laneState(runs, "RUNNER9");
    const f = readFleet(runs);
    expect(f.lanes[0]!.runId).toBeNull();
    expect(f.lanes[0]!.model).toBeNull();
  });

  test("a paused run has already freed its session, so it holds no account", () => {
    const runs = fixture();
    laneState(runs, "RUNNER");
    const db = new Database(join(runs, RUN_ID, "run.sqlite"));
    db.run(`UPDATE run SET pause_reason = 'deferred'`);
    db.close();
    expect(readFleet(runs).lanes[0]!.runId).toBeNull();
  });

  test("a run whose files have gone cold has let its account go", () => {
    const runs = fixture();
    laneState(runs, "RUNNER");
    const old = new Date(Date.now() - 10 * 60_000);
    for (const name of ["trajectory.jsonl", "run.sqlite"]) {
      utimesSync(join(runs, RUN_ID, name), old, old);
    }
    expect(readFleet(runs).lanes[0]!.runId).toBeNull();
  });

  test("a truncated fleet-state.json degrades to absent rather than throwing", () => {
    const runs = fixture();
    writeFileSync(join(runs, "fleet-state.json"), '{"lanes": {');
    expect(readFleet(runs).present).toBe(false);
  });
});
