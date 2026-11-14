/**
 * A run launched by hand (docs/RUNBOOK.md, "Ad-hoc launches", "A fan-out run,
 * by hand"), with no episode: what it costs the fleet while it runs, and what
 * it never is. It bills the credential it recorded — a slot while live, its
 * runs and spend today — and holds its accounts, a fan-out run every one of
 * its grant; it is never a fact the projection reads, so never a scored,
 * owed or counted run, an attempt or a strike. Fixture run directories only.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  modelStates,
  readFleetRuns,
  readRunFact,
  readRunFacts,
  runFactCache,
  utcDay,
  type RunFact,
  type UnstampedRun,
} from "../runner/src/models";
import { parseCredentials } from "../runner/src/credential-slots";
import { parseFleet, planTick, rosterModels, type FleetConfig } from "./run-fleet";
import { credentialGate, credentialKey, driverKey, SlotBook } from "./run-fleet-credentials";
import { countOutsideRuns, freePoolAccounts, outsideRuns } from "./run-fleet-plan";
import { localCredentialStatuses } from "./run-fleet-status";
import { accountHolderIn } from "./run-roster";
import { tempDirs } from "./temp-dirs";

const tempDir = tempDirs();
const H = 3_600_000;
const CRED = "or-free";
const MODEL = "z-ai/glm-5.3-flash:free";

interface RunSpec {
  runId: string;
  account: string;
  /** A fan-out grant; its first account is `account`. */
  fanout?: string[];
  credential?: string | null;
  episode?: string | null;
  /** Ended: its termination in meta.json and the trajectory, no heartbeat. */
  ended?: boolean;
  startedAt: number;
  cost?: number;
}

/** A run directory as `run.ts` leaves one, written at `now`: its files' times are `now`'s, so its liveness is the clock's. */
function writeRun(root: string, now: number, s: RunSpec): void {
  const dir = join(root, s.runId);
  mkdirSync(dir, { recursive: true });
  const config = {
    runId: s.runId,
    model: MODEL,
    driver: "openai",
    account: s.account,
    ...(s.credential !== null ? { credential: s.credential ?? CRED } : {}),
    ...(s.fanout !== undefined ? { fanout: { characters: s.fanout.length, accounts: s.fanout } } : {}),
  };
  writeFileSync(
    join(dir, "meta.json"),
    JSON.stringify({
      runId: s.runId,
      harnessVersion: "harness-0.5-1-gabc",
      startedAt: s.startedAt,
      config,
      comparability: { episode: s.episode ?? null, loop: "program", yield: true },
      ...(s.ended === true ? { termination: { reason: "episode-limit", detail: "episode wall clock" }, endedAt: s.startedAt + 2_000 } : {}),
    }),
  );
  const lines = [{ t: "response", ts: s.startedAt + 1_000, usage: { cost: s.cost ?? 0.25 } }];
  if (s.ended === true) lines.push({ t: "termination", reason: "episode-limit", ts: s.startedAt + 2_000 } as never);
  writeFileSync(join(dir, "trajectory.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const at = (now - 5_000) / 1000;
  utimesSync(join(dir, "trajectory.jsonl"), at, at);
  if (s.ended !== true) {
    writeFileSync(join(dir, "heartbeat"), "host 1\n");
    utimesSync(join(dir, "heartbeat"), at, at);
  }
}

const SINGLE = "run-20300314-110000";
const FANOUT = "run-20300314-113000";
const ENDED = "run-20300314-090000";
const FANOUT_ACCOUNTS = ["POOL01", "POOL02", "POOL03"];

/** Two live hand launches (one character on RUNNER3; three on POOL01–03) and one that ended, none with an episode; beside them a stamped fleet run. */
function handRuns(now: number): string {
  const root = tempDir("wrathbench-hand-launch-");
  writeRun(root, now, { runId: SINGLE, account: "RUNNER3", startedAt: now - H });
  writeRun(root, now, { runId: FANOUT, account: "POOL01", fanout: FANOUT_ACCOUNTS, startedAt: now - 30 * 60_000, cost: 0.5 });
  writeRun(root, now, { runId: ENDED, account: "RUNNER3", startedAt: now - 3 * H, ended: true, cost: 0.1 });
  writeRun(root, now, { runId: "fleet-glm-e90-glm-20300314-a1", account: "RUNNER", episode: "e90", startedAt: now - 2 * H, ended: true, cost: 0 });
  return root;
}

/** Noon UTC, so every instant above is the same UTC day. */
const NOW = Date.parse("2030-03-14T12:00:00Z");

function fleet(over: Record<string, unknown> = {}): FleetConfig {
  return parseFleet(
    {
      accounts: { pool: ["RUNNER", "RUNNER2", "RUNNER3", "RUNNER4"] },
      credentials: { [CRED]: { provider: "openrouter", secretEnv: "OPENROUTER_KEY", slots: 2, billing: "free", enabled: true } },
      roster: { glm: { tier: "t1", model: MODEL } },
      queue: [],
      ...over,
    },
    { env: {} },
  );
}

describe("a hand launch with no episode", () => {
  test("is no fact: the projection's readers never see it, and the fleet reads it beside them", () => {
    const root = handRuns(NOW);
    expect(readRunFact(root, SINGLE, NOW)).toBeNull();
    expect(readRunFact(root, FANOUT, NOW)).toBeNull();
    expect(readRunFacts(root, NOW, { includeArchived: true }).map((f) => f.runId)).toEqual(["fleet-glm-e90-glm-20300314-a1"]);
    const { facts, unstamped } = readFleetRuns(root, NOW, { includeArchived: true });
    expect(facts).toEqual(readRunFacts(root, NOW, { includeArchived: true }));
    expect(unstamped.map((f) => [f.runId, f.episode, f.live, f.credential, f.account, f.fanoutAccounts ?? null])).toEqual([
      [ENDED, null, false, CRED, "RUNNER3", null],
      [SINGLE, null, true, CRED, "RUNNER3", null],
      [FANOUT, null, true, CRED, "POOL01", FANOUT_ACCOUNTS],
    ]);
    expect(unstamped.find((f) => f.runId === ENDED)?.terminationReason).toBe("episode-limit");
  });

  test("is never a scored, owed or counted run: the projection is the one it would be without it", () => {
    const root = handRuns(NOW);
    const cfg = fleet();
    const project = (runs: readonly RunFact[]) => modelStates({ runsDir: root, roster: rosterModels(cfg.roster), runs, sidecar: { version: 1, cleared: {} }, now: NOW, policy: cfg.policy });
    const { facts, unstamped } = readFleetRuns(root, NOW, { includeArchived: true });
    const states = project(facts);
    // The model it shares a name with: one attempt, the fleet's; no hold, no
    // pause, no rung from the hand runs.
    expect(states[0]!.perEpisode.e90).toMatchObject({ attempts: 1, counted: 1 });
    expect(states[0]!.ladder).toBe(0);
    expect(states[0]!.paused).toBeUndefined();
    expect(states[0]!.ladder).toBe(0);
    // The same projection as a tree that never held the hand runs.
    const bare = tempDir("wrathbench-hand-launch-bare-");
    writeRun(bare, NOW, { runId: "fleet-glm-e90-glm-20300314-a1", account: "RUNNER", episode: "e90", startedAt: NOW - 2 * H, ended: true, cost: 0 });
    expect(states).toEqual(project(readRunFacts(bare, NOW, { includeArchived: true })));
    expect(unstamped).toHaveLength(3);
  });

  test("counts against its credential's runs and spend today", () => {
    const root = handRuns(NOW);
    const { facts, unstamped } = readFleetRuns(root, NOW, { includeArchived: true });
    const creds = parseCredentials({
      [CRED]: { provider: "openrouter", secretEnv: "OPENROUTER_KEY", slots: 3, budget: { kind: "spend", usdPerDay: 0.8 }, billing: "free", enabled: true },
    });
    expect(unstamped.find((f) => f.runId === FANOUT)?.spendByDay).toEqual({ [utcDay(NOW)]: 0.5 });
    // The fleet's own run is one launch and billed nothing: without the hand runs the credential is clear.
    const own = credentialGate(creds, [], facts, NOW);
    expect([own.runsToday(CRED), own.spendToday(CRED)]).toEqual([1, 0]);
    expect(own.holdOf(CRED, "e90")).toBeUndefined();
    const gate = credentialGate(creds, [], [...facts, ...unstamped], NOW);
    expect(gate.runsToday(CRED)).toBe(4);
    expect(gate.spendToday(CRED)).toBeCloseTo(0.85);
    expect(gate.holdReasonOf(CRED, "e90")?.code).toBe("spend-budget");
  });

  test("takes one slot on its credential while live, a fan-out run one for all its characters", () => {
    const root = handRuns(NOW);
    const { facts, unstamped } = readFleetRuns(root, NOW, { includeArchived: true });
    const all = [...facts, ...unstamped];
    expect(outsideRuns(all).map((f) => f.runId)).toEqual([SINGLE, FANOUT]);
    const book = new SlotBook(fleet().credentials, { openai: 1 });
    countOutsideRuns(book, outsideRuns(all));
    expect(book.inUse(credentialKey(CRED))).toBe(2);
    // On the credential only: a hand launch is not one of the host's children.
    expect(book.inUse(driverKey("openai"))).toBe(0);
    // A run of the supervisor's own processes, or on an account a live job
    // holds, is that job's and on the book through it.
    expect(outsideRuns(all, { running: new Set([SINGLE]) }).map((f) => f.runId)).toEqual([FANOUT]);
    expect(outsideRuns(all, { busyAccounts: new Set(["POOL02"]) }).map((f) => f.runId)).toEqual([SINGLE]);
    // A paused one holds no slot; nor does a fleet run no job owns, which holds its model and account only.
    const paused = { ...unstamped[1]!, live: false, pause: { reason: "rate-limited", at: NOW, count: 1, episodeElapsedMs: null } } satisfies UnstampedRun;
    expect(outsideRuns([paused, { ...facts[0]!, live: true, terminationReason: null, credential: CRED }])).toEqual([]);
  });

  test("so the plan holds a launch its credential has no room for, and says why", () => {
    const root = handRuns(NOW);
    const cfg = fleet({ credentials: { [CRED]: { provider: "openrouter", secretEnv: "OPENROUTER_KEY", slots: 2, billing: "free", enabled: true } } });
    const { unstamped } = readFleetRuns(root, NOW, { includeArchived: true });
    const states = modelStates({ runsDir: root, roster: rosterModels(cfg.roster), runs: [], sidecar: { version: 1, cleared: {} }, now: NOW, policy: cfg.policy });
    const plan = (outside: readonly UnstampedRun[]) =>
      planTick(cfg, states, () => undefined, "20300314", [], [], undefined, new Map(), new Set(), [], [], undefined, true, outsideRuns(outside));
    expect(plan([]).policy.map((p) => p.job.ref)).toEqual(["glm"]);
    const held = plan(unstamped);
    expect(held.policy).toEqual([]);
    expect(held.heldPicks.map((h) => h.why).join(" ")).toContain(`credential ${CRED} 2/2 in flight`);
  });

  test("the status's own reading counts it once, on its credential", () => {
    const root = handRuns(NOW);
    const cfg = fleet();
    const { facts, unstamped } = readFleetRuns(root, NOW, { includeArchived: true });
    const gate = credentialGate(cfg.credentials, [], [...facts, ...unstamped], NOW);
    expect(localCredentialStatuses(cfg, gate, facts, unstamped).find((c) => c.id === CRED)?.inUse).toBe(2);
    expect(localCredentialStatuses(cfg, gate, facts).find((c) => c.id === CRED)?.inUse).toBe(0);
  });

  test("is kept in the fact cache once ended, and served to the fleet's read alone", () => {
    const root = handRuns(NOW);
    const later = NOW + 10 * 60_000;
    const cachePath = join(root, "run-facts.cache.json");
    const first = readFleetRuns(root, later, { includeArchived: true, facts: runFactCache(cachePath) });
    const again = readFleetRuns(root, later, { includeArchived: true, facts: runFactCache(cachePath, { readOnly: true }) });
    expect(again).toEqual(first);
    expect(readRunFacts(root, later, { includeArchived: true, facts: runFactCache(cachePath, { readOnly: true }) }).map((f) => f.runId)).toEqual(["fleet-glm-e90-glm-20300314-a1"]);
  });

  test("holds its accounts while live, every one of a fan-out grant", () => {
    const root = handRuns(Date.now());
    const held = (a: string): string | undefined => accountHolderIn(root, a, "");
    expect(held("RUNNER3")).toBe(SINGLE);
    for (const a of FANOUT_ACCOUNTS) expect(held(a)).toBe(FANOUT);
    expect(held("POOL04")).toBeUndefined();
    // So the planner offers none of them.
    expect(freePoolAccounts({ pool: ["POOL01", "POOL02", "POOL03", "POOL04", "POOL05"], taken: new Set(), held })).toEqual(["POOL04", "POOL05"]);
    expect(freePoolAccounts({ pool: ["RUNNER", "RUNNER3"], taken: new Set(), held })).toEqual(["RUNNER"]);
  });
});
