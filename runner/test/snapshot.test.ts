/**
 * The snapshot renderer, end to end over a real (fixture) runs directory: the
 * artifact set, the cache classes, the content addressing, and — because the
 * renderer is the last thing a byte crosses before a bucket — the same
 * value-based leak checks the projection suite makes, here against every
 * artifact body the render produces.
 *
 * The fixture is poisoned the way a real runs directory is dangerous: game
 * prose in the trajectory's tool results (quest, gossip, item and mail text),
 * a free-text pause column, a bearer token, a LAN api base, the operator's
 * paths in fleet-state.json and in the driver record, a smoke tail. None of it
 * may appear in any body — while the names beside it (an item, a quest, an
 * NPC) must, since 2026-08-30 (docs/DATA-AND-LEGAL.md, "Trajectory logs").
 */

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRenderer,
  hash12,
  IMMUTABLE_CACHE,
  MUTABLE_CACHE,
  renderSnapshot,
  type SnapshotArtifact,
  type SnapshotResult,
} from "../viewer/snapshot";
import { createApi } from "../viewer/api";
import { PUBLIC_ATTRIBUTION } from "../viewer/public-projection";

const DEAD_RUN = "snap-run-dead";
const LIVE_RUN = "snap-run-live";

const SECRET = "sentinel-bearer-9f31ab";
const POISON = {
  pauseReason: "poison-pause-reason-text",
  questDetails: "prose-quest-details: the kobolds have grown bold",
  questObjectives: "prose-quest-objectives: slay ten of them",
  gossipOption: "prose-gossip-option: tell me about the mine",
  pageText: "prose-page-text: dear reader, beware",
  mailBody: "prose-mail-body: your order is ready",
  driverBin: "/home/operator/.bun/bin/claude",
  objective: "poison-objective-text",
  apiHost: "10.66.66.66",
  wikiSource: "poison-dump-20100901.xml.bz2",
  rosterPath: "/home/operator/poison/roster.json",
  fleetConfig: "/home/operator/poison/fleet.json",
  preflightTail: "poison-smoke-tail",
} as const;
/** Published, not withheld: the runner generates the name, it is not game text. */
const CHARACTER_NAME = "Fixturely";
/** Names and ids: every one must reach the artifact it is planted in. */
const SURVIVES = {
  itemName: "Worn Shortsword",
  terminationDetail: "episode limit reached near Goldshire",
  questTitle: "Kobold Camp Cleanup",
  npcName: "Marshal McBride",
  scratchpad: "plan: talk to Marshal McBride, then Kobold Camp Cleanup",
} as const;

/**
 * A container-internal path the model wrote into its own notes. The scratchpad
 * has no projector — it is text, not a body — so the scrub reaches it by hand
 * on both sides of the render (the public handle's route, and the renderer's
 * own text read); this pins the artifact the publisher would actually write.
 */
const CONTAINER_PATH = {
  written: "the stack said /wrathbench/sdk/src/client.ts:123",
  published: "the stack said sdk/src/client.ts:123",
} as const;

const POISON_PID = 987654321;

/** A tuple `parseComparability` accepts, with the poisoned wiki-bundle source. */
const TUPLE = {
  harnessVersion: "harness-0.5-1-gabc",
  promptHash: "sha256:0123456789abcdef",
  promptChars: 4242,
  harness: "wrathbench",
  effort: "high",
  budget: {
    maxTurns: null,
    maxToolCalls: 3000,
    idleMs: 600_000,
    noXpMs: null,
    episodeMs: 5_400_000,
    maxSandboxRestarts: 3,
  },
  objective: false,
  wikiCoords: true,
  wikiBundle: { schemaVersion: "1", builtAt: "2026-08-01", source: POISON.wikiSource, eraCutoff: "2010-09-01" },
  episode: "e90",
  episodeOverride: false,
  serverBuild: { build: "harness-0.5-1-gdef", startedAtMs: 12_345 },
};

function writeRun(
  runs: string,
  runId: string,
  opts: { terminated: boolean; stateTs: number; old: boolean; continuedFrom?: string; episode?: string },
): void {
  const dir = join(runs, runId);
  mkdirSync(dir, { recursive: true });
  const config = {
    runId,
    moduleUrl: "http://worldserver:8086",
    token: SECRET,
    character: CHARACTER_NAME,
    account: "RUNNER",
    model: "test/model",
    driver: "openai",
    race: 3,
    class: 3,
    apiBase: `http://${POISON.apiHost}:1234/v1`,
    objective: POISON.objective,
    campaign: "sweep-1",
    cell: "cell-a",
    apiKeyEnv: "OPENROUTER_KEY",
    // A freeplay continuation names its predecessor; every other run has none.
    ...(opts.continuedFrom === undefined ? {} : { continuedFrom: opts.continuedFrom }),
  };
  writeFileSync(
    join(dir, "meta.json"),
    JSON.stringify({
      runId,
      harnessVersion: "harness-0.5-1-gabc",
      startedAt: 1000,
      comparability: opts.episode === undefined ? TUPLE : { ...TUPLE, episode: opts.episode },
      config,
    }),
  );
  const lines = [
    { ts: 1000, t: "meta", runId, harnessVersion: "harness-0.5-1-gabc", config },
    { ts: 1100, t: "response", turn: 1, message: { role: "assistant", content: "hello" } },
    { ts: 1200, t: "snippet", turn: 1, code: "await sdk.moveTo(1, 2, 3);" },
    { ts: 1250, t: "driver", driver: "claude-code", harness: "wrathbench", bin: POISON.driverBin, args: [], cwd: "/x" },
    {
      ts: 1300, t: "tool_result", turn: 1, call: 1, name: "recent_events", isError: false,
      text: [
        `#1 SMSG_QUESTGIVER_QUEST_DETAILS ${JSON.stringify({ guid: "1", questId: 7, title: SURVIVES.questTitle, details: POISON.questDetails, objectives: POISON.questObjectives, choiceRewards: [], rewards: [], money: 0, xp: 0 })}`,
        `#2 SMSG_GOSSIP_MESSAGE ${JSON.stringify({ guid: "1", menuId: 3, textId: 9, options: [{ optionId: 0, icon: 0, text: POISON.gossipOption }], quests: [] })}`,
        `#3 SMSG_PAGE_TEXT_QUERY_RESPONSE ${JSON.stringify({ pageId: 1, text: POISON.pageText, nextPageId: 0 })}`,
        `#4 SMSG_CREATURE_QUERY_RESPONSE ${JSON.stringify({ entry: 197, found: true, name: SURVIVES.npcName })}`,
      ].join("\n"),
    },
    {
      ts: 1400, t: "snippet_result", turn: 1, call: 2, name: "run_snippet", isError: false,
      text: `ok (3ms)\n=> ${JSON.stringify({ mails: [{ mailId: 1, subject: SURVIVES.questTitle, body: POISON.mailBody, items: [] }] })}`,
    },
    ...(opts.terminated ? [{ ts: 2000, t: "termination", reason: "episode-limit", detail: SURVIVES.terminationDetail }] : []),
  ];
  writeFileSync(join(dir, "trajectory.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  writeFileSync(join(dir, "scratchpad.md"), `${SURVIVES.scratchpad}\n${CONTAINER_PATH.written}\n`);

  const db = new Database(join(dir, "run.sqlite"));
  db.run(
    `CREATE TABLE run (run_id TEXT, model TEXT, driver TEXT, shakeout TEXT,
       harness_version TEXT, started_at INTEGER, ended_at INTEGER, termination_reason TEXT,
       termination_detail TEXT, pause_reason TEXT, config_json TEXT)`,
  );
  db.run(`INSERT INTO run VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [
    runId,
    "test/model",
    "openai",
    null,
    "harness-0.5-1-gabc",
    1000,
    opts.terminated ? 2000 : null,
    opts.terminated ? "episode-limit" : null,
    opts.terminated ? SURVIVES.terminationDetail : null,
    opts.terminated ? POISON.pauseReason : null,
    JSON.stringify(config),
  ]);
  db.run(
    `CREATE TABLE state (run_id TEXT, ts INTEGER, level INTEGER, xp INTEGER, map INTEGER,
       x REAL, y REAL, z REAL, event_count INTEGER, last_seq INTEGER, money INTEGER,
       quests_completed INTEGER, items TEXT)`,
  );
  db.run(`INSERT INTO state VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    runId,
    opts.stateTs,
    3,
    400,
    0,
    -6240,
    380,
    385,
    12,
    99,
    1234,
    2,
    JSON.stringify([{ name: SURVIVES.itemName, count: 1, equipped: true }]),
  ]);
  db.close();

  if (opts.old) {
    // Cold files: the run reads dead and the render is byte-stable, which is
    // what lets the version-key test re-render and land on the same address.
    const past = new Date(Date.now() - 60 * 60_000);
    for (const name of ["meta.json", "trajectory.jsonl", "run.sqlite", "scratchpad.md"]) {
      utimesSync(join(dir, name), past, past);
    }
  }
}

function fixture(withLive = true): string {
  const runs = mkdtempSync(join(tmpdir(), "snapshot-"));
  writeRun(runs, DEAD_RUN, { terminated: true, stateTs: 1500, old: true });
  // A live, unterminated run with a fresh position, so live.json's positions
  // feed is non-empty and its character/items withholding is exercised. The
  // generation-stability test leaves it out: a live run's growing playtime is
  // data, and data is supposed to move the generation.
  if (withLive) writeRun(runs, LIVE_RUN, { terminated: false, stateTs: Date.now(), old: false });

  writeFileSync(
    join(runs, "fleet-state.json"),
    JSON.stringify({
      fleetPid: POISON_PID,
      startedAt: 1,
      heartbeatAt: 2,
      containerized: true,
      stamp: "20260825",
      fleetConfig: POISON.fleetConfig,
      configLoadedAt: 3,
      preflight: {
        at: 5,
        serverIdentity: "build:x@1",
        build: "harness-0.5-1-gabc",
        ok: true,
        results: [{ script: "infra/smoke/a.ts", ok: true, ms: 20_000, tail: POISON.preflightTail }],
      },
      accounts: { pool: { RUNNER: "job-a" } },
      jobs: {
        "job-a": {
          ref: "a",
          episode: "e90",
          account: "RUNNER",
          source: "policy",
          models: ["test/model"],
          pid: POISON_PID,
          rosterPath: POISON.rosterPath,
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
    }),
  );
  return runs;
}

const SNAP_NAMES = [
  "info.json",
  "runs.json",
  "results.json",
  "ladder-e90.json",
  "ladder-e360.json",
  "ladder-freeplay.json",
  "episodes.json",
  "models.json",
  "campaigns.json",
  "tools.json",
];

async function render(runs: string, now: number): Promise<SnapshotResult> {
  return await renderSnapshot({ runsDir: runs, now });
}

/** One run's published track body, parsed. */
function trackOfIn(out: SnapshotResult, runId: string): Record<string, unknown> {
  const a = out.artifacts.find((x) => x.path.startsWith(`v1/run/${runId}/`) && x.path.endsWith("track.json"))!;
  return JSON.parse(a.body) as Record<string, unknown>;
}

describe("renderSnapshot", () => {
  test("the cache-control constants are the contract's", () => {
    expect(MUTABLE_CACHE).toBe("public, max-age=30");
    expect(IMMUTABLE_CACHE).toBe("public, max-age=31536000, immutable");
  });

  test("renders the complete artifact set with the right cache classes", async () => {
    const runs = fixture();
    const out = await render(runs, 111);
    const paths = out.artifacts.map((a) => a.path);

    expect(paths).toContain("v1/manifest.json");
    expect(paths).toContain("v1/live.json");
    // Each aggregate at its own content-addressed key, exactly as the manifest names it.
    expect(Object.keys(out.snap).sort()).toEqual([...SNAP_NAMES].sort());
    for (const name of SNAP_NAMES) {
      expect(out.snap[name]).toMatch(new RegExp(`^v1/snap/[0-9a-f]{12}/${name.replace(".", "\\.")}$`));
      expect(paths).toContain(out.snap[name]!);
    }
    // Detail, track, the entries window and the scratchpad per run on disk, and nothing else.
    const runPaths = paths.filter((p) => p.startsWith("v1/run/"));
    expect(runPaths).toHaveLength(8);
    for (const id of [DEAD_RUN, LIVE_RUN]) {
      expect(runPaths.filter((p) => p.startsWith(`v1/run/${id}/`)).map((p) => p.split("/").at(-1)).sort()).toEqual([
        "detail.json",
        "entries.json",
        "scratchpad.json",
        "track.json",
      ]);
    }
    expect(paths).toHaveLength(2 + SNAP_NAMES.length + 8);

    for (const a of out.artifacts) {
      expect(a.contentType).toBe("application/json");
      const mutable = a.path === "v1/manifest.json" || a.path === "v1/live.json";
      expect(`${a.path}: ${a.cacheControl}`).toBe(`${a.path}: ${mutable ? MUTABLE_CACHE : IMMUTABLE_CACHE}`);
    }
  });

  /*
   * The published track carries the character's neighbours, so the
   * public map's transport steps between a character's attempts with the one
   * fetch a replay already makes. The version key covers it without being
   * hashed over it: an attempt's own detail carries the `character` view, so the
   * arrival of a successor moves the key and the new track lands beside it.
   */
  test("a published track names the attempts either side of it", async () => {
    const runs = mkdtempSync(join(tmpdir(), "snapshot-chain-"));
    // A freeplay chain: the root stamped freeplay, the second attempt naming it.
    writeRun(runs, DEAD_RUN, { terminated: true, stateTs: 1500, old: true, episode: "freeplay" });
    writeRun(runs, LIVE_RUN, { terminated: true, stateTs: 1600, old: true, continuedFrom: DEAD_RUN, episode: "freeplay" });
    const out = await render(runs, 111);
    const trackOf = (id: string): { character?: unknown } =>
      JSON.parse(out.artifacts.find((a) => a.path.startsWith(`v1/run/${id}/`) && a.path.endsWith("track.json"))!.body) as {
        character?: unknown;
      };
    expect(trackOf(DEAD_RUN).character).toEqual({
      characterId: DEAD_RUN,
      attempt: 1,
      attempts: 2,
      previous: null,
      next: LIVE_RUN,
    });
    expect(trackOf(LIVE_RUN).character).toEqual({
      characterId: DEAD_RUN,
      attempt: 2,
      attempts: 2,
      previous: DEAD_RUN,
      next: null,
    });
    // A snapshot of runs that form no chain publishes no field at all, which
    // is what an older snapshot looks like to the page.
    const lone = await render(fixture(false), 111);
    expect("character" in trackOfIn(lone, DEAD_RUN)).toBe(false);
    rmSync(runs, { recursive: true, force: true });
  });

  test("no artifact path names a withheld surface", async () => {
    const runs = fixture();
    const out = await render(runs, 111);
    for (const a of out.artifacts) {
      expect(a.path).not.toMatch(/tiles|raw/);
      expect(a.path.startsWith("/")).toBe(false);
    }
  });

  test("the tiles flag reaches no artifact", async () => {
    // WRATHBENCH_VIEWER_TILES_PUBLIC can open /tiles on a LIVE public viewer.
    // The static snapshot is a different surface: the renderer builds its own
    // handle without `tilesPublic` and asks for no tile, so the flag being set
    // in the publisher's environment must change nothing here.
    const key = "WRATHBENCH_VIEWER_TILES_PUBLIC";
    const before = process.env[key];
    process.env[key] = "1";
    try {
      const runs = fixture();
      const out = await render(runs, 111);
      for (const a of out.artifacts) expect(a.path).not.toContain("tiles");
      for (const a of out.artifacts) expect(a.contentType).toBe("application/json");
    } finally {
      if (before === undefined) delete process.env[key];
      else process.env[key] = before;
    }
  });

  test("every body parses and carries the envelope", async () => {
    const runs = fixture();
    const out = await render(runs, 111);
    for (const a of out.artifacts) {
      const body = JSON.parse(a.body) as { generatedAt?: unknown; attribution?: unknown };
      expect(`${a.path}: ${body.generatedAt}`).toBe(`${a.path}: 111`);
      expect(body.attribution).toBe(PUBLIC_ATTRIBUTION);
    }
    // The two mutable bodies say what they are for.
    const manifest = JSON.parse(out.artifacts.find((a) => a.path === "v1/manifest.json")!.body) as { gen: string };
    expect(manifest.gen).toBe(out.gen);
    const live = JSON.parse(out.artifacts.find((a) => a.path === "v1/live.json")!.body) as {
      fleet: { present: boolean; jobs: unknown[] };
      positions: { positions: { runId: string; character: string | null }[] };
    };
    expect(live.fleet.present).toBe(true);
    expect(live.positions.positions.map((p) => p.runId)).toEqual([LIVE_RUN]);
    expect(live.positions.positions[0]!.character).toBe(CHARACTER_NAME);
  });

  test("no poisoned value reaches any artifact body", async () => {
    const runs = fixture();
    const out = await render(runs, 111);
    for (const a of out.artifacts) {
      for (const [name, value] of Object.entries(POISON)) {
        expect(`${a.path} ${name}: ${a.body}`).not.toContain(value);
      }
      expect(`${a.path}: ${a.body}`).not.toContain(SECRET);
      expect(`${a.path}: ${a.body}`).not.toContain(String(POISON_PID));
    }
  });

  test("the entries window ships the names and the scratchpad ships whole; the prose beside them is gone", async () => {
    const runs = fixture();
    const out = await render(runs, 111);
    const entries = out.artifacts.find((a) => a.path === `v1/run/${DEAD_RUN}/` + a.path.split("/")[3] + "/entries.json");
    expect(entries).toBeDefined();
    const body = JSON.parse(entries!.body) as { from: number; total: number; entries: { t: string; text?: string }[] };
    expect(body.from).toBe(0);
    expect(body.total).toBe(body.entries.length);
    expect(body.entries.map((e) => e.t)).toEqual(["meta", "response", "snippet", "driver", "tool_result", "snippet_result", "termination"]);
    const events = body.entries[4]!.text!;
    expect(events).toContain(SURVIVES.questTitle);
    expect(events).toContain(SURVIVES.npcName);
    expect(events).toContain('"details":"[redacted]"');
    expect(events).toContain('"options":[{"optionId":0,"icon":0,"text":"[redacted]"}]');
    expect(body.entries[5]!.text).toContain('"body":"[redacted]"');
    expect(body.entries[6]).toMatchObject({ reason: "episode-limit", detail: SURVIVES.terminationDetail });
    // The `meta` entry is the skeleton plus the run's own stamps: no config.
    expect(Object.keys(body.entries[0]!).sort()).toEqual(["end", "harnessVersion", "i", "runId", "start", "t", "ts"]);

    const pad = out.artifacts.find((a) => a.path.startsWith(`v1/run/${DEAD_RUN}/`) && a.path.endsWith("/scratchpad.json"));
    expect(pad).toBeDefined();
    // Whole, and with the container install prefix stripped: the one edit the
    // boundary makes to model-authored text (operator, 2026-09-11).
    expect((JSON.parse(pad!.body) as { text: string }).text).toBe(
      `${SURVIVES.scratchpad}\n${CONTAINER_PATH.published}\n`,
    );

    // The row's item names and the position feed's carry through too.
    const live = JSON.parse(out.artifacts.find((a) => a.path === "v1/live.json")!.body) as {
      positions: { positions: { items: { name: string; count: number; equipped: boolean }[] | null }[] };
    };
    expect(live.positions.positions[0]!.items).toEqual([{ name: SURVIVES.itemName, count: 1, equipped: true }]);
  });

  test("runs.json rows point at the run artifacts; the manifest names a key per aggregate", async () => {
    const runs = fixture();
    const out = await render(runs, 111);
    const paths = new Set(out.artifacts.map((a) => a.path));
    const listed = JSON.parse(out.artifacts.find((a) => a.path === out.snap["runs.json"])!.body) as {
      runs: {
        runId: string;
        character: string | null;
        pauseReason: string | null;
        terminationDetail: string | null;
        snapshot?: { detail: string; track: string; entries?: string; scratchpad?: string };
      }[];
    };
    expect(listed.runs).toHaveLength(2);
    const dead = listed.runs.find((r) => r.runId === DEAD_RUN)!;
    expect(dead.pauseReason).toBe("paused");
    expect(dead.terminationDetail).toBe(SURVIVES.terminationDetail);
    expect(dead.character).toBe(CHARACTER_NAME);
    for (const row of listed.runs) {
      expect(row.snapshot).toBeDefined();
      for (const which of ["detail", "track", "entries", "scratchpad"] as const) {
        expect(row.snapshot![which]).toMatch(new RegExp(`^v1/run/${row.runId}/[0-9a-f]{12}/${which}\\.json$`));
        expect(paths.has(row.snapshot![which]!)).toBe(true);
      }
    }
    expect(out.gen).toMatch(/^[0-9a-f]{12}$/);

    // The manifest is the index the reader follows: every name, every key, and
    // nothing it cannot fetch.
    const manifest = JSON.parse(out.artifacts.find((a) => a.path === "v1/manifest.json")!.body) as {
      gen: string;
      artifacts: Record<string, string>;
    };
    expect(manifest.gen).toBe(out.gen);
    expect(manifest.artifacts).toEqual(out.snap);
    for (const key of Object.values(manifest.artifacts)) expect(paths.has(key)).toBe(true);
  });

  test("gen is stable across re-renders of unchanged input, and moves when the data does", async () => {
    // No live run: an idle fleet's renders must land on one generation, or the
    // publisher re-uploads the whole aggregate set every pass.
    const runs = fixture(false);
    const first = await render(runs, 111);
    const second = await render(runs, 222);
    expect(second.gen).toBe(first.gen);
    expect(second.artifacts.map((a) => a.path).sort()).toEqual(first.artifacts.map((a) => a.path).sort());
    // A data change is a new generation: the address moves with the content.
    appendFileSync(
      join(runs, DEAD_RUN, "trajectory.jsonl"),
      JSON.stringify({ ts: 2100, t: "state", level: 4 }) + "\n",
    );
    const past = new Date(Date.now() - 60 * 60_000);
    utimesSync(join(runs, DEAD_RUN, "trajectory.jsonl"), past, past);
    const third = await render(runs, 333);
    expect(third.gen).not.toBe(first.gen);
  });

  test("a live run's clock alone moves no address: playtimeMs is normalized out", async () => {
    // The fleet's steady state. `playtimeMs` advances with the wall clock on
    // every pass of a live run, and hashing it made the run's detail — and
    // every aggregate carrying the figure — claim a new key on passes where
    // nothing had happened (GitHub issue #38, operator 2026-09-04).
    const runs = fixture();
    const first = await render(runs, 111);
    await Bun.sleep(15);
    const second = await render(runs, 222);
    expect(second.gen).toBe(first.gen);
    expect(second.snap).toEqual(first.snap);
    expect(second.artifacts.map((a) => a.path).sort()).toEqual(first.artifacts.map((a) => a.path).sort());
  });

  test("a data change moves the aggregates that carry it and leaves the rest on their keys", async () => {
    // The point of per-artifact addressing: one live run taking a turn used to
    // rewrite all ten aggregates under a fresh prefix.
    const runs = fixture();
    const before = await render(runs, 111);
    appendFileSync(join(runs, DEAD_RUN, "trajectory.jsonl"), JSON.stringify({ ts: 2100, t: "state", level: 4 }) + "\n");
    const past = new Date(Date.now() - 60 * 60_000);
    utimesSync(join(runs, DEAD_RUN, "trajectory.jsonl"), past, past);
    const after = await render(runs, 222);

    const moved = SNAP_NAMES.filter((name) => after.snap[name] !== before.snap[name]);
    expect(moved).toContain("runs.json");
    expect(moved.length).toBeGreaterThan(0);
    expect(moved.length).toBeLessThan(SNAP_NAMES.length);
    // The set-shaped aggregates say nothing about a run's level, so they must
    // still be sitting on the key the last manifest named.
    for (const name of ["info.json", "episodes.json", "tools.json", "campaigns.json"]) {
      expect(`${name}: ${after.snap[name]}`).toBe(`${name}: ${before.snap[name]}`);
    }
    // The manifest itself is what changed, so `gen` moves either way.
    expect(after.gen).not.toBe(before.gen);
  });

  test("a re-render of unchanged input reuses a finished run's version key", async () => {
    const runs = fixture();
    // Different clocks on purpose: the envelope timestamp moves, the address
    // must not — generatedAt is stamped after the hash, not inside it.
    const first = await render(runs, 111);
    const second = await render(runs, 222);
    const deadPaths = (r: SnapshotResult): string[] =>
      r.artifacts
        .map((a) => a.path)
        .filter((p) => p.startsWith(`v1/run/${DEAD_RUN}/`))
        .sort();
    expect(deadPaths(first)).toEqual(deadPaths(second));
    // The bodies at that address differ only by envelope; the content is one.
    const strip = (body: string): unknown => {
      const o = JSON.parse(body) as Record<string, unknown>;
      delete o["generatedAt"];
      return o;
    };
    const detailOf = (r: SnapshotResult): unknown =>
      strip(r.artifacts.find((a) => a.path === deadPaths(r)[0])!.body);
    expect(detailOf(second)).toEqual(detailOf(first));
  });

  test("a version key is the first 12 hex of SHA-256, whatever hashes it", () => {
    // The keys under `v1/snap/` and `v1/run/` are immutable for a year, so a
    // client that cached one must land on it again after any change to the
    // hasher underneath. Pinned against a reference digest rather than against
    // yesterday's output, which no test can hold.
    for (const s of ["", "a", '{"now":0}', "poison-ünïcode-✓", "x".repeat(10_000)]) {
      expect(hash12(s)).toBe(createHash("sha256").update(s, "utf8").digest("hex").slice(0, 12));
    }
    expect(hash12("")).toBe("e3b0c44298fc");
  });
});

describe("createRenderer", () => {
  test("renders pass after pass from one handle, on one address", async () => {
    // What the publisher's loop does: build once, render every interval. The
    // handle carries the viewer's trajectory memos, so it must survive a pass
    // — and surviving must not make the second pass differ from the first.
    const runs = fixture(false);
    const render = createRenderer({ runsDir: runs });
    const first = await render(111);
    const second = await render(222);
    expect(second.gen).toBe(first.gen);
    expect(second.artifacts.map((a) => a.path).sort()).toEqual(first.artifacts.map((a) => a.path).sort());
    // Only the clock moves: `generatedAt` is stamped per pass, outside the hash.
    const stampOf = (r: SnapshotResult): unknown =>
      (JSON.parse(r.artifacts.find((a) => a.path === "v1/manifest.json")!.body) as { generatedAt: unknown })
        .generatedAt;
    expect(stampOf(first)).toBe(111);
    expect(stampOf(second)).toBe(222);
    // And the one-shot wrapper is the same render.
    const once = await renderSnapshot({ runsDir: runs, now: 333 });
    expect(once.gen).toBe(first.gen);
  });

  test("a run archived mid-pass costs its own artifacts and nothing else", async () => {
    /*
     * The runner archives a finished run by moving its directory out of the
     * runs directory, which can land between the listing and the per-run GETs
     * of one pass. Reproduced literally: the wrapped handle removes the run
     * the moment the listing has been served, so the per-run routes answer a
     * real 404 for a run that is really still on the listing this pass holds.
     */
    const runs = fixture();
    const api = createApi({
      runsDir: runs,
      tilesDir: join(runs, "tiles-unused"),
      publicMode: true,
      moduleUrl: "http://127.0.0.1:1",
    });
    let archived = false;
    const handle = async (req: Request): Promise<Response> => {
      const res = await api(req);
      if (new URL(req.url).pathname === "/api/runs") {
        rmSync(join(runs, DEAD_RUN), { recursive: true, force: true });
        archived = true;
      }
      return res;
    };
    const out = await createRenderer({ runsDir: runs, api: handle })(111);
    expect(archived).toBe(true);

    // The pass still happened: the poll keys are there, and so is the snap set.
    const paths = out.artifacts.map((a) => a.path);
    expect(paths).toContain("v1/manifest.json");
    expect(paths).toContain("v1/live.json");
    for (const name of SNAP_NAMES) expect(paths).toContain(out.snap[name]!);
    // The archived run's artifacts are gone; the surviving run's are not.
    expect(paths.filter((p) => p.startsWith(`v1/run/${DEAD_RUN}/`))).toEqual([]);
    expect(paths.filter((p) => p.startsWith(`v1/run/${LIVE_RUN}/`))).toHaveLength(4);

    /*
     * The row itself stays — the listing is the pass's, and rewriting it would
     * be inventing a listing nobody served — but pointerless, which is the
     * degrade the snapshot client already answers with its own 404.
     */
    const listed = JSON.parse(out.artifacts.find((a) => a.path === out.snap["runs.json"])!.body) as {
      runs: { runId: string; snapshot?: { detail: string; track: string } }[];
    };
    expect(listed.runs.map((r) => r.runId).sort()).toEqual([DEAD_RUN, LIVE_RUN].sort());
    expect(listed.runs.find((r) => r.runId === DEAD_RUN)!.snapshot).toBeUndefined();
    const live = listed.runs.find((r) => r.runId === LIVE_RUN)!;
    expect(paths).toContain(live.snapshot!.detail);
    expect(paths).toContain(live.snapshot!.track);
  });

  test("a per-run status that is not 404 still fails the pass", async () => {
    // Only the archive race is tolerated. A route answering 500 is a broken
    // viewer, and publishing a snapshot that quietly omits runs would hide it.
    const runs = fixture(false);
    const api = createApi({
      runsDir: runs,
      tilesDir: join(runs, "tiles-unused"),
      publicMode: true,
      moduleUrl: "http://127.0.0.1:1",
    });
    const handle = async (req: Request): Promise<Response> => {
      if (new URL(req.url).pathname.startsWith("/api/run/")) return new Response("boom", { status: 500 });
      return await api(req);
    };
    await expect(createRenderer({ runsDir: runs, api: handle })(111)).rejects.toThrow(/answered 500/);
  });

  test("a streamed pass holds no more entry indexes than one batch", async () => {
    /*
     * The point of `RunStream.release`: the viewer handle keeps one
     * `EntrySummary` per record per run, which over a thousand-run tree is the
     * largest live thing a publish pass builds.
     * A streaming caller is walking the tree once, so a run it has published is
     * one it can forget — and the proof is that the count never climbs past the
     * batch size, whatever the tree's size.
     */
    const runs = fixture();
    const api = createApi({
      runsDir: runs,
      tilesDir: join(runs, "tiles-unused"),
      publicMode: true,
      moduleUrl: "http://127.0.0.1:1",
    });
    const seen: number[] = [];
    await createRenderer({ runsDir: runs, api })(111, {
      batch: 1,
      sink: async () => void seen.push(api.cachedRuns().entries),
    });
    expect(seen.length).toBeGreaterThan(1);
    for (const held of seen) expect(held).toBeLessThanOrEqual(1);
    // And the last run is released too, so nothing is left holding the tree.
    // The entry index is the only per-run memo left: run rows, state series
    // and totals are rows in the derived store now, not caches here.
    expect(api.cachedRuns().entries).toBe(0);
  });

  test("release: false keeps the memos, which is what a small tree wants", async () => {
    const runs = fixture();
    const api = createApi({
      runsDir: runs,
      tilesDir: join(runs, "tiles-unused"),
      publicMode: true,
      moduleUrl: "http://127.0.0.1:1",
    });
    await createRenderer({ runsDir: runs, api })(111, { batch: 1, release: false, sink: async () => {} });
    expect(api.cachedRuns().entries).toBeGreaterThan(0);
  });

  test("streaming the per-run artifacts changes nothing but when they are let go of", async () => {
    /*
     * The publisher renders with a `RunStream` so it never holds the whole
     * tree. What it publishes must be byte for
     * byte what the unstreamed render produces — same keys, same bodies, same
     * generation, same `runs.json` pointers — whatever the batch size is.
     */
    const runs = fixture();
    const whole = await createRenderer({ runsDir: runs })(111);
    // Key and body, with the two wall-clock fields zeroed — `now` and a live
    // run's `playtimeMs`, which move between any two renders and are outside
    // every content version for exactly that reason (see `addressable`).
    const key = (a: { path: string; body: string }): string =>
      `${a.path}\n${a.body.replace(/"now":\d+/g, '"now":0').replace(/"playtimeMs":\d+/g, '"playtimeMs":0')}`;

    for (const batch of [1, 2, 1000]) {
      const batches: number[] = [];
      const streamed: SnapshotArtifact[] = [];
      const out = await createRenderer({ runsDir: runs })(111, {
        batch,
        sink: async (artifacts) => {
          batches.push(artifacts.length);
          streamed.push(...artifacts);
        },
      });
      // The streamed halves and the returned half, together, are the whole set.
      expect(out.artifacts.some((a) => a.path.startsWith("v1/run/"))).toBe(false);
      const compare = (artifacts: SnapshotArtifact[]): string[] =>
        // `live.json` is the one key deliberately outside the generation chain:
        // it carries the fleet clock, which moves between any two renders. Its
        // presence is checked, its body is not comparable.
        artifacts.filter((a) => a.path !== "v1/live.json").map(key).sort();
      expect(compare([...out.artifacts, ...streamed])).toEqual(compare(whole.artifacts));
      expect(out.artifacts.map((a) => a.path)).toContain("v1/live.json");
      expect(out.gen).toBe(whole.gen);
      expect(out.snap).toEqual(whole.snap);
      // A batch of one really is one run at a time, not the whole tree at once.
      if (batch === 1) expect(batches.length).toBeGreaterThan(1);
    }
  });
});
