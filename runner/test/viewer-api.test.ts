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
import { comparabilityOf } from "../src/comparability";
import { ConfigStore } from "../src/config-store";
import { configFromArgs } from "../src/run";
import { RESULT_RUNS_CACHE_MS, UNBUILT_NOTICE, createApi, harnessSeriesCensus, readFleet } from "../viewer/api";
import { type RunStore, localRunStore } from "../viewer/clickhouse";
import { redactRawLine, redactSecrets } from "../viewer/tail";
import { readRun } from "../viewer/runs";

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

/** A results/episodes fixture covering every scoreability boundary. */
function scoreabilityFixture(): string {
  const runs = mkdtempSync(join(tmpdir(), "viewer-scoreability-"));
  const now = Date.now();
  const comparability = comparabilityOf(configFromArgs(["--episode", "e90", "--model", "m"]), "harness-0.5");
  const write = (id: string, responses: number, terminationReason: string | null, pauseReason: string | null): void => {
    const dir = join(runs, id);
    mkdirSync(dir, { recursive: true });
    const startedAt = now - 10_000;
    writeFileSync(
      join(dir, "meta.json"),
      JSON.stringify({ runId: id, harnessVersion: "harness-0.5", startedAt, config: { model: "m", driver: "openai" }, comparability }),
    );
    if (responses >= 0) {
      const lines = [{ ts: startedAt, t: "meta", runId: id }, ...Array.from({ length: responses }, (_, i) => ({ ts: startedAt + i + 1, t: "response", turn: i + 1 }))];
      writeFileSync(join(dir, "trajectory.jsonl"), lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
    }
    const db = new Database(join(dir, "run.sqlite"));
    db.run(`CREATE TABLE run (run_id TEXT PRIMARY KEY, model TEXT, driver TEXT, harness_version TEXT, started_at INTEGER, ended_at INTEGER, termination_reason TEXT, pause_reason TEXT, config_json TEXT)`);
    db.run(`CREATE TABLE state (run_id TEXT, ts INTEGER, level INTEGER, xp INTEGER, map INTEGER, x REAL, y REAL, z REAL, event_count INTEGER, last_seq INTEGER, turn INTEGER)`);
    db.run(`INSERT INTO run VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [id, "m", "openai", "harness-0.5", startedAt, terminationReason === null ? null : now - 1_000, terminationReason, pauseReason, null]);
    db.close();
  };
  write("paused-response", 2, null, "rate-limited");
  write("paused-zero", 0, null, "rate-limited");
  write("zero-response", 0, "episode-limit", null);
  write("unknown-response", -1, "episode-limit", null);
  write("live-response", 2, null, null);
  write("environment-defect", 2, "environment-defect", null);
  return runs;
}

/** Put two rows from the scoreability fixture on one campaign for API coverage. */
function campaignizeScoreabilityFixture(runs: string): string {
  for (const id of ["live-response", "environment-defect"]) {
    const path = join(runs, id, "meta.json");
    const meta = JSON.parse(readFileSync(path, "utf8")) as { config: Record<string, unknown> };
    writeFileSync(
      path,
      JSON.stringify({ ...meta, config: { ...meta.config, campaign: "scoreability", cell: "cell" } }),
    );
  }
  const fleetPath = join(runs, "config.sqlite");
  const store = new ConfigStore(fleetPath);
  store.seed({
    accounts: { pool: ["RUNNER"] },
    roster: { m: { model: "m:free", tier: "t1" } },
    campaigns: {
      scoreability: { enabled: true, models: ["m"], runsPerCell: 1, cells: [{ id: "cell" }] },
    },
  });
  store.close();
  return fleetPath;
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

/**
 * A claude-code run whose CLI forwarded its running thinking-token estimate:
 * one `init`, several `thinking_tokens`, and the records around them.
 */
function thinkingFixture(): string {
  const runs = mkdtempSync(join(tmpdir(), "viewer-thinking-"));
  const dir = join(runs, "claude-run");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "meta.json"), JSON.stringify({ runId: "claude-run", startedAt: 1000, config: { driver: "claude-code" } }));
  const lines: object[] = [
    { ts: 1000, t: "meta", runId: "claude-run" },
    { ts: 1100, t: "claude_system", turn: 1, type: "system", subtype: "init", session_id: "s-1", model: "claude-opus-5", claude_code_version: "2.1.239" },
    { ts: 1150, t: "claude_system", turn: 1, type: "system", subtype: "thinking_tokens", session_id: "s-1", estimated_tokens: 50, estimated_tokens_delta: 50 },
    { ts: 1160, t: "claude_system", turn: 1, type: "system", subtype: "thinking_tokens", session_id: "s-1", estimated_tokens: 120, estimated_tokens_delta: 70 },
    { ts: 1170, t: "claude_system", turn: 1, type: "system", subtype: "thinking_tokens", session_id: "s-1", estimated_tokens: 300, estimated_tokens_delta: 180 },
    { ts: 1200, t: "response", turn: 1, message: { role: "assistant", content: "hello from the CLI" } },
    // No `sessionId` of its own (the shape written before 2026-08-25): the
    // tally has to have taken the session from the `init` envelope.
    { ts: 1300, t: "claude_result", turn: 1, costUsd: 0.25, usageRaw: { output_tokens: 400 } },
  ];
  writeFileSync(join(dir, "trajectory.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return runs;
}

describe("the thinking-token envelopes", () => {
  test("never reach the feed, while the init envelope and the raw lines behind it do", async () => {
    const runs = thinkingFixture();
    const handle = api(runs);
    const page = (await (await handle(new Request("http://x/api/run/claude-run/entries?from=0&limit=200"))).json()) as {
      from: number;
      total: number;
      entries: { i: number; t: string; subtype?: string }[];
    };
    // Three of seven records are dropped; `total` counts what is served.
    expect(page.entries.map((e) => e.t)).toEqual(["meta", "claude_system", "response", "claude_result"]);
    expect(page.entries.filter((e) => e.subtype === "thinking_tokens")).toEqual([]);
    expect(page.entries.find((e) => e.t === "claude_system")!.subtype).toBe("init");
    expect(page.total).toBe(4);
    expect(page.entries.length).toBe(page.total);
    // The index each entry carries is the one the raw link uses, and it still
    // reads the right line for an entry sitting after three dropped ones.
    expect(page.entries.map((e) => e.i)).toEqual([0, 1, 2, 3]);
    const raw = (await (await handle(new Request("http://x/api/run/claude-run/raw/2"))).json()) as { t: string; message: { content: string } };
    expect(raw.t).toBe("response");
    expect(raw.message.content).toBe("hello from the CLI");
    const rawInit = (await (await handle(new Request("http://x/api/run/claude-run/raw/1"))).json()) as { subtype: string };
    expect(rawInit.subtype).toBe("init");

    // Nothing derived from the feed leans on the dropped envelopes: the cost
    // tally still finds its session, and the run page's totals still land.
    const detail = (await (await handle(new Request("http://x/api/run/claude-run"))).json()) as {
      total: number;
      cost: { actual: { usd: number | null } };
      tokens: { completionTokens: number };
      run: { resolvedModel: string | null; cliVersion: string | null };
    };
    expect(detail.total).toBe(4);
    expect(detail.cost.actual.usd).toBe(0.25);
    expect(detail.tokens.completionTokens).toBe(400);
    expect(detail.run).toMatchObject({ resolvedModel: "claude-opus-5", cliVersion: "2.1.239" });
    rmSync(runs, { recursive: true, force: true });
  });

  test("a run whose last record is a dropped envelope keeps its playtime", async () => {
    const runs = thinkingFixture();
    // The common claude ending: the watchdog cuts the run mid-thinking, so the
    // file's last line is one the feed does not serve.
    appendFileSync(
      join(runs, "claude-run", "trajectory.jsonl"),
      JSON.stringify({ ts: 9000, t: "claude_system", turn: 2, type: "system", subtype: "thinking_tokens", session_id: "s-1", estimated_tokens: 7 }) + "\n",
    );
    // Old enough that the run reads as finished: a live run's segment closes
    // on `now` and the two figures would agree for the wrong reason.
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(join(runs, "claude-run", "trajectory.jsonl"), old, old);
    const handle = api(runs);
    const listed = (await (await handle(new Request("http://x/api/runs"))).json()) as {
      runs: { runId: string; playtimeMs: number | null }[];
    };
    const detail = (await (await handle(new Request("http://x/api/run/claude-run"))).json()) as { playtimeMs: number | null };
    // The listing reads every line; the run page must not close the segment on
    // the last SERVED one and report a shorter run than the listing does.
    expect(detail.playtimeMs).toBe(new Map(listed.runs.map((r) => [r.runId, r.playtimeMs])).get("claude-run")!);
    expect(detail.playtimeMs).toBe(8000);
    rmSync(runs, { recursive: true, force: true });
  });

  test("the live tail forwards the same filtered batches", async () => {
    const runs = thinkingFixture();
    const handle = api(runs);
    // Prime the tail, then append the shape a live claude run appends.
    await handle(new Request("http://x/api/run/claude-run/entries?from=0"));
    appendFileSync(
      join(runs, "claude-run", "trajectory.jsonl"),
      [
        { ts: 1400, t: "claude_system", turn: 2, type: "system", subtype: "thinking_tokens", session_id: "s-1", estimated_tokens: 9 },
        { ts: 1500, t: "response", turn: 2, message: { role: "assistant", content: "second" } },
      ]
        .map((l) => JSON.stringify(l))
        .join("\n") + "\n",
    );
    const res = await handle(new Request("http://x/api/run/claude-run/stream"));
    const reader = res.body!.getReader();
    const hello = new TextDecoder().decode((await reader.read()).value!);
    await reader.cancel();
    // The SSE hello carries the served count, which the new envelope did not grow.
    expect(JSON.parse(hello.replace(/^data: /, "").trim())).toMatchObject({ hello: "claude-run", total: 5 });
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

describe("scoreability projection", () => {
  test("results keep every invalid historical row visible but episodes exclude all tainted members", async () => {
    const runs = scoreabilityFixture();
    try {
      const handle = api(runs);
      const results = (await (await handle(new Request("http://x/api/results?episode=all"))).json()) as {
        runs: { runId: string; unscored: string | null }[];
      };
      expect(results.runs).toHaveLength(6);
      expect(Object.fromEntries(results.runs.map((r) => [r.runId, r.unscored]))).toEqual({
        "paused-response": "unscored (paused)",
        "paused-zero": "unscored (paused)",
        "zero-response": "unscored (no model responses)",
        "unknown-response": "unscored (model responses unknown)",
        "live-response": "unscored (live)",
        "environment-defect": "unscored (environment-defect)",
      });

      const episodes = (await (await handle(new Request("http://x/api/episodes"))).json()) as {
        episodes: { id: string; members: number }[];
      };
      expect(episodes.episodes.find((episode) => episode.id === "e90")!.members).toBe(0);
    } finally {
      rmSync(runs, { recursive: true, force: true });
    }
  });

  test("/api/ladder keeps tainted e90 rows visible with their explicit unscored reasons", async () => {
    const runs = scoreabilityFixture();
    try {
      const ladder = (await (await api(runs)(new Request("http://x/api/ladder?episode=e90"))).json()) as {
        episode: string;
        runs: { runId: string; unscored: string | null }[];
      };
      expect(ladder.episode).toBe("e90");
      expect(ladder.runs).toHaveLength(6);
      expect(Object.fromEntries(ladder.runs.map((r) => [r.runId, r.unscored]))).toEqual({
        "paused-response": "unscored (paused)",
        "paused-zero": "unscored (paused)",
        "zero-response": "unscored (no model responses)",
        "unknown-response": "unscored (model responses unknown)",
        "live-response": "unscored (live)",
        "environment-defect": "unscored (environment-defect)",
      });
    } finally {
      rmSync(runs, { recursive: true, force: true });
    }
  });

  test("/api/campaigns leaves a live and environment-defect probe out of counted completion", async () => {
    const runs = scoreabilityFixture();
    try {
      const fleetPath = campaignizeScoreabilityFixture(runs);
      const handle = createApi({
        runsDir: runs,
        tilesDir: join(runs, "..", "minimap"),
        configDbPath: fleetPath,
      });
      const res = await handle(new Request("http://x/api/campaigns"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        campaigns: {
          campaign: string;
          runs: number;
          live: number;
          config: { complete: boolean } | null;
          cells: { cell: string; runs: number; models: string[] }[];
        }[];
      };
      const row = body.campaigns.find((campaign) => campaign.campaign === "scoreability")!;
      // `runs` is the counted numerator: the ended environment-defect row reaches
      // campaignComplete as counted:false through the production taintOf path and
      // so counts for nothing here either; the live row remains visible separately.
      expect(row).toMatchObject({ campaign: "scoreability", runs: 0, live: 1 });
      expect(row.config).toMatchObject({ complete: false });
      expect(row.cells).toHaveLength(1);
      expect(row.cells).toMatchObject([{ cell: "cell", runs: 2, models: ["m"] }]);
    } finally {
      rmSync(runs, { recursive: true, force: true });
    }
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
  test("withholds raw entries and tiles; serves the scratchpad and the metadata", async () => {
    const runs = fixture();
    const handle = api(runs, true);
    expect((await handle(new Request(`http://x/api/run/${RUN_ID}/raw/0`))).status).toBe(403);
    // The model's own notes: published as written since 2026-08-30.
    expect((await handle(new Request(`http://x/api/run/${RUN_ID}/scratchpad`))).status).toBe(200);
    expect((await handle(new Request("http://x/tiles/0/43_31.png"))).status).toBe(403);
    expect((await handle(new Request("http://x/api/runs"))).status).toBe(200);
    expect((await handle(new Request(`http://x/api/run/${RUN_ID}/entries`))).status).toBe(200);
  });

  test("entries cross the public projection: the meta entry sheds its config", async () => {
    const runs = fixture();
    const priv = (await (await api(runs, false)(new Request(`http://x/api/run/${RUN_ID}/entries?from=0`))).json()) as {
      entries: Record<string, unknown>[];
    };
    const pub = (await (await api(runs, true)(new Request(`http://x/api/run/${RUN_ID}/entries?from=0`))).json()) as {
      entries: Record<string, unknown>[];
    };
    expect(priv.entries[0]!["t"]).toBe("meta");
    expect(priv.entries[0]!["config"]).toBeDefined();
    expect(pub.entries[0]!["t"]).toBe("meta");
    expect(pub.entries[0]!["config"]).toBeUndefined();
    expect(pub.entries).toHaveLength(priv.entries.length);
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

  test("level and death milestones cross the wire on both the results row and the run page", async () => {
    const runs = fixture();
    appendFileSync(
      join(runs, RUN_ID, "trajectory.jsonl"),
      [
        { ts: 1300, t: "milestone", kind: "level", to: 1, xp: 0, turn: 1 },
        {
          ts: 1600,
          t: "milestone",
          kind: "death",
          observedTs: 1550,
          position: { map: 0, x: 1, y: 2, z: 3, source: "death_spot" },
          zone: { id: 12 },
          area: { id: 9 },
          released: false,
          turn: 2,
        },
        { ts: 1700, t: "milestone", kind: "level", from: 1, to: 2, xp: 40, turn: 3 },
      ]
        .map((l) => JSON.stringify(l))
        .join("\n") + "\n",
    );
    const handle = api(runs);
    const results = (await (await handle(new Request("http://x/api/results?episode=all"))).json()) as {
      runs: { runId: string; leveling: { levelUps: number } | null; deaths: { deaths: number } | null }[];
    };
    const row = results.runs.find((r) => r.runId === RUN_ID)!;
    expect(row.leveling!.levelUps).toBe(1);
    expect(row.deaths!.deaths).toBe(1);
    // The run page reads the same facts off the incremental tail, so the two
    // views of one run cannot disagree.
    const detail = (await (await handle(new Request(`http://x/api/run/${RUN_ID}`))).json()) as {
      leveling: unknown;
      deaths: unknown;
    };
    expect(detail.leveling).toEqual(row.leveling);
    expect(detail.deaths).toEqual(row.deaths);
  });

  test("a run with no milestone records reads not-recorded on both, never zero", async () => {
    const runs = fixture();
    const body = (await (await api(runs)(new Request("http://x/api/results?episode=all"))).json()) as {
      runs: { runId: string; achievements: unknown; taxi: unknown; leveling: unknown; deaths: unknown }[];
    };
    const row = body.runs.find((r) => r.runId === RUN_ID)!;
    expect(row.achievements).toBeNull();
    expect(row.taxi).toBeNull();
    expect(row.leveling).toBeNull();
    expect(row.deaths).toBeNull();
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
    expect(row.unscored).toBe("unscored (live)");
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

  test("a freeplay continuation's lineage reaches the row and the results projection", async () => {
    const runs = fixture();
    // The fixture's run.sqlite predates the column, so this is also the
    // "written before the durable character existed" path: meta answers.
    const dir = join(runs, RUN_ID);
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as {
      config: Record<string, unknown>;
    };
    meta.config["continuedFrom"] = "fixture-run-0";
    writeFileSync(join(dir, "meta.json"), JSON.stringify(meta));
    expect(readRun(runs, RUN_ID).continuedFrom).toBe("fixture-run-0");
    const body = (await (await api(runs)(new Request("http://x/api/results?episode=all"))).json()) as {
      runs: { runId: string; continuedFrom: string | null; stillborn: boolean | null }[];
    };
    const row = body.runs.find((r) => r.runId === RUN_ID)!;
    expect(row.continuedFrom).toBe("fixture-run-0");
    // The fixture run has not terminated, so "produced nothing" is undecided —
    // which is the scheduler's own answer for a launch still in progress.
    expect(row.stillborn).toBeNull();
  });

  test("the freeplay ladder holds an overridden run: an id that pins nothing has no membership to lose", async () => {
    const runs = fixture();
    stamped(runs, { ...TUPLE, episode: "freeplay", episodeOverride: true });
    const field = (await (await api(runs)(new Request("http://x/api/ladder?episode=freeplay"))).json()) as {
      runs: { runId: string }[]; includeOverrides: boolean; overridesExcluded: number;
    };
    expect(field.runs.map((r) => r.runId)).toEqual([RUN_ID]);
    expect(field.overridesExcluded).toBe(0);
    // The scored ladders are unchanged: there, an override is a real exclusion.
    stamped(runs, { ...TUPLE, episode: "e90", episodeOverride: true });
    const e90 = (await (await api(runs)(new Request("http://x/api/ladder?episode=e90"))).json()) as {
      runs: unknown[]; overridesExcluded: number;
    };
    expect(e90.runs).toHaveLength(0);
    expect(e90.overridesExcluded).toBe(1);
  });

  test("probing has no ladder (operator, 2026-08-29), but its runs still list", async () => {
    const runs = fixture();
    stamped(runs, { ...TUPLE, episode: "probing", episodeOverride: false });
    expect((await api(runs)(new Request("http://x/api/ladder?episode=probing"))).status).toBe(400);
    // The id is untouched everywhere else: the runs are listed, not hidden.
    const listed = (await (await api(runs)(new Request("http://x/api/results?episode=probing"))).json()) as {
      runs: { runId: string }[];
    };
    expect(listed.runs.map((r) => r.runId)).toEqual([RUN_ID]);
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
    expect(row.unscored).toBe("unscored (live)");

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

  /**
   * A freeplay chain a1 → a2 → a3, each attempt a run directory of its own.
   * Enough of one for the lineage walk and the episode gate: the stamped
   * episode, the predecessor, a started-at, and one state row so the track has
   * a point to serve.
   */
  function chainFixture(): string {
    const runs = mkdtempSync(join(tmpdir(), "viewer-track-character-"));
    const comparability = comparabilityOf(
      configFromArgs(["--episode", "freeplay", "--model", "m"]),
      "harness-0.5",
    );
    const ids = ["a1", "a2", "a3"];
    ids.forEach((id, i) => {
      const dir = join(runs, id);
      mkdirSync(dir, { recursive: true });
      const startedAt = (i + 1) * 1000;
      const config = { model: "m", driver: "openai", character: "Bromdir", ...(i === 0 ? {} : { continuedFrom: ids[i - 1] }) };
      writeFileSync(
        join(dir, "meta.json"),
        JSON.stringify({ runId: id, harnessVersion: "harness-0.5", startedAt, config, comparability }),
      );
      // One model response apiece: a launch that produced nothing is stillborn,
      // and a stillborn launch is not an attempt at the character.
      writeFileSync(
        join(dir, "trajectory.jsonl"),
        [
          JSON.stringify({ ts: startedAt, t: "meta", runId: id }),
          JSON.stringify({ ts: startedAt + 1, t: "response", turn: 1 }),
        ].join("\n") + "\n",
      );
      const db = new Database(join(dir, "run.sqlite"));
      db.run(`CREATE TABLE run (run_id TEXT PRIMARY KEY, model TEXT, driver TEXT, harness_version TEXT, started_at INTEGER, ended_at INTEGER, termination_reason TEXT, pause_reason TEXT, config_json TEXT)`);
      db.run(`INSERT INTO run VALUES (?,?,?,?,?,?,?,?,?)`, [id, "m", "openai", "harness-0.5", startedAt, startedAt + 100, "idle", null, JSON.stringify(config)]);
      db.run(`CREATE TABLE state (run_id TEXT, ts INTEGER, level INTEGER, xp INTEGER, map INTEGER, x REAL, y REAL, z REAL, event_count INTEGER, last_seq INTEGER, turn INTEGER)`);
      db.run(`INSERT INTO state VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [id, startedAt + 10, 5, 100, 0, -6240, 380, 385, 1, 1, 1]);
      db.close();
    });
    return runs;
  }

  /*
   * Item 119: the map's transport steps between a character's attempts, so the
   * track carries the neighbours the run page's `character` names — not the
   * chain, not its totals, which would make a replay's fetch a run page's.
   */
  test("a freeplay attempt's track names the attempts either side of it", async () => {
    const runs = chainFixture();
    const handle = api(runs);
    const trackOf = async (id: string): Promise<Record<string, unknown> | undefined> =>
      ((await (await handle(new Request(`http://x/api/run/${id}/track`))).json()) as {
        character?: Record<string, unknown>;
      }).character;

    expect(await trackOf("a2")).toEqual({
      characterId: "a1",
      attempt: 2,
      attempts: 3,
      previous: "a1",
      next: "a3",
    });
    // The ends of the chain have one way each, and the same identity.
    expect(await trackOf("a1")).toMatchObject({ attempt: 1, previous: null, next: "a2" });
    expect(await trackOf("a3")).toMatchObject({ attempt: 3, previous: "a2", next: null });
  });

  test("the track's neighbours are the ones /api/run/<id> serves, from the same walk", async () => {
    const runs = chainFixture();
    const handle = api(runs);
    const detail = (await (await handle(new Request("http://x/api/run/a2"))).json()) as {
      character: { characterId: string; attempt: number; attempts: number; previous: string | null; next: string | null };
    };
    const track = (await (await handle(new Request("http://x/api/run/a2/track"))).json()) as {
      character: typeof detail.character;
    };
    const { characterId, attempt, attempts, previous, next } = detail.character;
    expect(track.character).toEqual({ characterId, attempt, attempts, previous, next });
  });

  test("a run that is no character carries no field, and pays nothing to find out", async () => {
    const runs = fixture();
    const body = (await (await api(runs)(new Request(`http://x/api/run/${RUN_ID}/track`))).json()) as Record<
      string,
      unknown
    >;
    expect("character" in body).toBe(false);
  });

  /*
   * Item 128: `/api/character/<id>` is the whole chain — the view every
   * attempt's page carries a card of, plus the level and XP series across all
   * of it, each sample told from the attempt it came from so a chart can mark
   * the session boundaries.
   */
  test("/api/character/<id> serves the whole chain and its stitched series", async () => {
    const runs = chainFixture();
    const body = (await (await api(runs)(new Request("http://x/api/character/a1"))).json()) as {
      character: { characterId: string; attempts: number; runs: { runId: string }[] };
      states: { runId: string; attempt: number; ts: number; level: number | null }[];
    };
    expect(body.character.characterId).toBe("a1");
    expect(body.character.attempts).toBe(3);
    expect(body.character.runs.map((r) => r.runId)).toEqual(["a1", "a2", "a3"]);
    // One state row per attempt in the fixture, in attempt order, each naming
    // its own run: that pairing is the only thing that marks a seam.
    expect(body.states.map((p) => [p.runId, p.attempt])).toEqual([
      ["a1", 1],
      ["a2", 2],
      ["a3", 3],
    ]);
    expect(body.states.every((p) => p.level === 5)).toBe(true);
  });

  test("/api/character/<id> answers for any attempt, not only the head", async () => {
    const runs = chainFixture();
    const handle = api(runs);
    const idOf = async (id: string): Promise<string> =>
      ((await (await handle(new Request(`http://x/api/character/${id}`))).json()) as {
        character: { characterId: string };
      }).character.characterId;
    expect(await idOf("a3")).toBe("a1");
    expect(await idOf("a2")).toBe("a1");
  });

  /* Universal, not freeplay-only: a scored run is a character of one attempt. */
  test("/api/character/<id> answers for a scored run as a chain of one", async () => {
    const runs = fixture();
    const body = (await (await api(runs)(new Request(`http://x/api/character/${RUN_ID}`))).json()) as {
      character: { characterId: string; attempt: number; attempts: number; previous: string | null };
    };
    expect(body.character).toMatchObject({ characterId: RUN_ID, attempt: 1, attempts: 1, previous: null });
  });

  test("/api/character/<id> 404s on an id no run answers to", async () => {
    const runs = fixture();
    const res = await api(runs)(new Request("http://x/api/character/no-such-run"));
    expect(res.status).toBe(404);
  });

  test("/api/run/<id>/track serves the recorded positions", async () => {
    const runs = fixture();
    const body = (await (await api(runs)(new Request(`http://x/api/run/${RUN_ID}/track`))).json()) as {
      characterName: string | null;
      points: { map: number; x: number; y: number }[];
    };
    expect(body.characterName).toBe("Fixturely");
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

/**
 * The whole-fleet listing, and the two per-run routes that ask for it.
 *
 * `/api/run/<id>` and its `/track` build the character view from the listing
 * on a freeplay run, and the publisher fetches both for every run with eight
 * parallel workers. Unmemoised that was a fleet-wide store query per run —
 * hundreds in a few seconds, which is what ran ClickHouse out of memory. The
 * two facts pinned here are the ones the fix rests on: a burst shares one
 * build, and the window does expire.
 */
describe("the listing is built once per window", () => {
  const FREE_RUN = "freeplay-run-1";

  /** One freeplay run, which is what makes the per-run routes read the listing. */
  function freeplayFixture(): string {
    const runs = mkdtempSync(join(tmpdir(), "viewer-listing-"));
    const dir = join(runs, FREE_RUN);
    mkdirSync(dir, { recursive: true });
    const startedAt = Date.now() - 10_000;
    const comparability = comparabilityOf(
      configFromArgs(["--episode", "freeplay", "--model", "m"]),
      "harness-test",
    );
    writeFileSync(
      join(dir, "meta.json"),
      JSON.stringify({
        runId: FREE_RUN,
        harnessVersion: "harness-test",
        startedAt,
        config: { model: "m", driver: "openai", character: "Freely" },
        comparability,
      }),
    );
    writeFileSync(
      join(dir, "trajectory.jsonl"),
      [
        { ts: startedAt, t: "meta", runId: FREE_RUN, harnessVersion: "harness-test" },
        { ts: startedAt + 1, t: "response", turn: 1, message: { role: "assistant", content: "hi" } },
      ]
        .map((l) => JSON.stringify(l))
        .join("\n") + "\n",
    );
    const db = new Database(join(dir, "run.sqlite"));
    db.run(
      `CREATE TABLE run (run_id TEXT PRIMARY KEY, model TEXT, driver TEXT, harness_version TEXT,
         started_at INTEGER, ended_at INTEGER, termination_reason TEXT, pause_reason TEXT, config_json TEXT)`,
    );
    db.run(`INSERT INTO run VALUES (?,?,?,?,?,?,?,?,?)`, [
      FREE_RUN, "m", "openai", "harness-test", startedAt, startedAt + 5_000, "episode-limit", null, null,
    ]);
    db.close();
    return runs;
  }

  /**
   * The real local store, counting the two fleet-wide reads a build makes.
   *
   * `tick` is how long the build is made to appear to take: the fixture builds
   * in a millisecond, so without it a window stamped when the build *starts*
   * and one stamped when it *settles* are indistinguishable, and the second is
   * what the fleet needs.
   */
  function countingStore(
    runsDir: string,
    onRead: () => void = () => {},
  ): { store: RunStore; counts: { runRows: number; latestStates: number } } {
    const inner = localRunStore(runsDir);
    const counts = { runRows: 0, latestStates: 0 };
    const store: RunStore = {
      ...inner,
      runRows: () => {
        counts.runRows += 1;
        onRead();
        return inner.runRows();
      },
      latestStates: () => {
        counts.latestStates += 1;
        return inner.latestStates();
      },
    };
    return { store, counts };
  }

  test("a burst of run pages pays for one build, and a later one rebuilds", async () => {
    const runs = freeplayFixture();
    const { store, counts } = countingStore(runs);
    const handle = createApi({
      runsDir: runs,
      tilesDir: join(runs, "..", "minimap"),
      moduleUrl: "http://127.0.0.1:1",
      store,
    });
    // `createApi` has no clock of its own to inject, and the window is measured
    // in seconds a test must not spend. The global clock is the injection
    // point, restored whatever happens.
    const realNow = Date.now;
    let clock = realNow();
    Date.now = () => clock;
    try {
      const burst = await Promise.all(
        Array.from({ length: 16 }, () => handle(new Request(`http://x/api/run/${FREE_RUN}`))),
      );
      expect(burst.map((r) => r.status)).toEqual(Array.from({ length: 16 }, () => 200));
      expect(counts.runRows).toBe(1);
      expect(counts.latestStates).toBe(1);

      // Back-to-back inside the window, and the other route that reads it.
      await handle(new Request(`http://x/api/run/${FREE_RUN}`));
      await handle(new Request(`http://x/api/run/${FREE_RUN}/track`));
      expect(counts.runRows).toBe(1);

      clock += RESULT_RUNS_CACHE_MS;
      await handle(new Request(`http://x/api/run/${FREE_RUN}`));
      expect(counts.runRows).toBe(2);
      expect(counts.latestStates).toBe(2);
    } finally {
      Date.now = realNow;
      rmSync(runs, { recursive: true, force: true });
    }
  });

  test("the window starts when the build finishes, not when it starts", async () => {
    const runs = freeplayFixture();
    // A build that takes the whole window: stamped at its start, the rows it
    // produced would already be stale the moment they existed.
    const { store, counts } = countingStore(runs, () => {
      clock += RESULT_RUNS_CACHE_MS;
    });
    const handle = createApi({
      runsDir: runs,
      tilesDir: join(runs, "..", "minimap"),
      moduleUrl: "http://127.0.0.1:1",
      store,
    });
    const realNow = Date.now;
    let clock = realNow();
    Date.now = () => clock;
    try {
      await handle(new Request(`http://x/api/run/${FREE_RUN}`));
      await handle(new Request(`http://x/api/run/${FREE_RUN}`));
      expect(counts.runRows).toBe(1);
    } finally {
      Date.now = realNow;
      rmSync(runs, { recursive: true, force: true });
    }
  });
});
