/**
 * A runs directory poisoned the way a real one is dangerous.
 *
 * Every value in `POISON` sits in a field the public projection is supposed to
 * withhold — a bearer token, a LAN api base, the operator's objective and
 * paths, free-text pause and preflight output, game prose in a tool result,
 * the supervisor's pid. Every value in `SURVIVES` sits in a field that must
 * reach a public reader: names and ids, the runner-generated character name,
 * the model's own words (docs/DATA-AND-LEGAL.md, "Trajectory logs", operator
 * 2026-08-30).
 *
 * Written as a module rather than inline so the live public-mode handle and
 * the static snapshot renderer can be held to the same fixture; the shape
 * follows `runner/test/snapshot.test.ts`, which keeps its own copy so a change
 * to one suite's fixture cannot silently move the other's pinned addresses.
 */

import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const DEAD_RUN = "poison-run-dead";
export const LIVE_RUN = "poison-run-live";

/** The bearer token, planted in the run config the `meta` entry copies whole. */
export const SECRET = "sentinel-bearer-3d71ec";

/** The supervisor's pid: a host fact, in `fleet-state.json` and on the job. */
export const POISON_PID = 987654321;

/** Values that must appear in NO public response body. */
export const POISON = {
  /** Free text on the run row (a provider's rate-limit message). */
  pauseReason: "poison-pause-reason: provider said 429 for account RUNNER",
  /** Free text on a `pause` entry, the same rule as the column. */
  pauseDetail: "poison-pause-detail: waiting on /home/operator/quota.json",
  /** Game prose, by opcode — what `redact-prose.ts` replaces. */
  questDetails: "prose-quest-details: the kobolds have grown bold",
  questObjectives: "prose-quest-objectives: slay ten of them",
  gossipOption: "prose-gossip-option: tell me about the mine",
  pageText: "prose-page-text: dear reader, beware",
  mailBody: "prose-mail-body: your order is ready",
  /** Wiki text: a `search_reference` result is replaced whole. */
  wikiText: "poison-wiki-text: Kobolds are humanoid creatures found in Elwynn",
  /** Local filesystem paths, on the driver record, the roster and the config. */
  driverBin: "/home/operator/.bun/bin/claude",
  rosterPath: "/home/operator/poison/roster.json",
  fleetConfig: "/home/operator/poison/fleet.json",
  /** The operator's objective, and the LAN host the model was served from. */
  objective: "poison-objective-text",
  apiHost: "10.66.66.66",
  /** The wiki bundle's source is the operator's dump filename. */
  wikiSource: "poison-dump-20100901.xml.bz2",
  /** Smoke output embeds paths; the config-rejection error is an errno string. */
  preflightTail: "poison-smoke-tail: /home/operator/wrathbench/infra/smoke/a.ts",
  configRejectedError: "poison ENOENT open '/home/operator/poison/fleet.json'",
} as const;

/** The runner generates the character name, so it is not game text: it ships. */
export const CHARACTER_NAME = "Fixturely";

/** Names, ids and the model's own words: every one must reach a public body. */
export const SURVIVES = {
  itemName: "Worn Shortsword",
  terminationDetail: "episode limit reached near Goldshire",
  questTitle: "Kobold Camp Cleanup",
  npcName: "Marshal McBride",
  snippetCode: "await sdk.moveTo(1, 2, 3);",
  responseText: "I will head for the kobold camp next.",
  scratchpad: "plan: talk to Marshal McBride, then Kobold Camp Cleanup",
} as const;

/** A tuple `parseComparability` accepts, carrying the poisoned bundle source. */
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

function writeRun(runs: string, runId: string, opts: { terminated: boolean; stateTs: number; old: boolean }): void {
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
  };
  writeFileSync(
    join(dir, "meta.json"),
    JSON.stringify({ runId, harnessVersion: "harness-0.5-1-gabc", startedAt: 1000, comparability: TUPLE, config }),
  );
  const lines = [
    { ts: 1000, t: "meta", runId, harnessVersion: "harness-0.5-1-gabc", config },
    { ts: 1100, t: "response", turn: 1, text: SURVIVES.responseText, message: { role: "assistant", content: SURVIVES.responseText } },
    { ts: 1200, t: "snippet", turn: 1, code: SURVIVES.snippetCode },
    { ts: 1250, t: "driver", driver: "claude-code", harness: "wrathbench", bin: POISON.driverBin, args: [], cwd: "/x" },
    {
      ts: 1300,
      t: "tool_result",
      turn: 1,
      call: 1,
      name: "recent_events",
      isError: false,
      text: [
        `#1 SMSG_QUESTGIVER_QUEST_DETAILS ${JSON.stringify({ guid: "1", questId: 7, title: SURVIVES.questTitle, details: POISON.questDetails, objectives: POISON.questObjectives, choiceRewards: [], rewards: [], money: 0, xp: 0 })}`,
        `#2 SMSG_GOSSIP_MESSAGE ${JSON.stringify({ guid: "1", menuId: 3, textId: 9, options: [{ optionId: 0, icon: 0, text: POISON.gossipOption }], quests: [] })}`,
        `#3 SMSG_PAGE_TEXT_QUERY_RESPONSE ${JSON.stringify({ pageId: 1, text: POISON.pageText, nextPageId: 0 })}`,
        `#4 SMSG_CREATURE_QUERY_RESPONSE ${JSON.stringify({ entry: 197, found: true, name: SURVIVES.npcName })}`,
      ].join("\n"),
    },
    { ts: 1320, t: "tool_result", turn: 1, call: 2, name: "search_reference", isError: false, text: POISON.wikiText },
    {
      ts: 1400,
      t: "snippet_result",
      turn: 1,
      call: 3,
      name: "run_snippet",
      isError: false,
      text: `ok (3ms)\n=> ${JSON.stringify({ mails: [{ mailId: 1, subject: SURVIVES.questTitle, body: POISON.mailBody, items: [] }] })}`,
    },
    { ts: 1500, t: "pause", reason: "rate-limit", detail: POISON.pauseDetail },
    ...(opts.terminated
      ? [{ ts: 2000, t: "termination", reason: "episode-limit", detail: SURVIVES.terminationDetail }]
      : []),
  ];
  writeFileSync(join(dir, "trajectory.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  writeFileSync(join(dir, "scratchpad.md"), `${SURVIVES.scratchpad}\n`);

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
    POISON.pauseReason,
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
    const past = new Date(Date.now() - 60 * 60_000);
    for (const name of ["meta.json", "trajectory.jsonl", "run.sqlite", "scratchpad.md"]) {
      utimesSync(join(dir, name), past, past);
    }
  }
}

/** A temp runs directory with one dead run, one live run, and a poisoned fleet state. */
export function poisonedRunsDir(): string {
  const runs = mkdtempSync(join(tmpdir(), "poisoned-runs-"));
  writeRun(runs, DEAD_RUN, { terminated: true, stateTs: 1500, old: true });
  writeRun(runs, LIVE_RUN, { terminated: false, stateTs: Date.now(), old: false });
  writeFileSync(
    join(runs, "fleet-state.json"),
    JSON.stringify({
      fleetPid: POISON_PID,
      startedAt: 1,
      heartbeatAt: Date.now(),
      containerized: true,
      stamp: "20260901",
      fleetConfig: POISON.fleetConfig,
      configLoadedAt: 3,
      configRejected: { since: 9, error: POISON.configRejectedError, mtime: 8 },
      preflight: {
        at: 5,
        serverIdentity: "build:x@1",
        build: "harness-0.5-1-gabc",
        ok: false,
        results: [{ script: "infra/smoke/a.ts", ok: false, ms: 20_000, tail: POISON.preflightTail }],
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
