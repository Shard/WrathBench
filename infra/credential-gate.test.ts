/**
 * Credentials with slots, the fleet's half (#429): which credential a run
 * takes, which launches a credential's budget holds, the per-driver host cap,
 * the one account pool, where the supervisor asks, what it says, and what
 * never reaches a public surface. Synthetic figures and fake secret NAMES
 * only.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isStaleRun, liveCredentials, modelStates, readRunFact, utcDay, type ModelState, type RunFact } from "../runner/src/models";
import { loadRunConfig } from "../runner/src/config";
import { Trajectory, type RunMeta } from "../runner/src/trajectory";
import { parseCredentials } from "../runner/src/credentials";
import type { SubscriptionUsage } from "../runner/src/subscription-usage";
import { projectEntry, projectFleet, SUBSCRIPTION_WAIT_WHY } from "../runner/viewer/public-projection";
import type { EntrySummary, FleetResponse } from "../runner/viewer/api-types";
import { parseFleet, planResumes, planTick, resumeNotBefore, rosterModels, type FleetConfig } from "./run-fleet";
import type { JobSpawn } from "./run-fleet-config";
import {
  CREDENTIAL_USAGE_SIDECAR,
  credentialGate,
  credentialStatuses,
  FleetGoUsage,
  formatCredentialStatus,
  gateSpawns,
  placeRef,
  readCredentialUsage,
  resumeHoldOf,
  SlotBook,
  writeCredentialUsageSidecar,
} from "./run-fleet-credentials";
import type { GoFetch } from "../runner/src/opencode-go";
import { awaitUsageBudget } from "./run-roster";
import { tempDirs } from "./temp-dirs";

const tempDir = tempDirs();
const NOW = Date.parse("2030-03-14T12:00:00Z");
const H = 3_600_000;
const STAMP = "20300314";

const reading = (credential: string, used: number, resetIn = 5 * H, observedAt = NOW - 60_000): SubscriptionUsage => ({
  credential,
  observedAt,
  windows: [{ usedPercent: used, windowMinutes: 300, resetsAt: NOW + resetIn }],
});

const claude = (env: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  provider: "claude",
  secretEnv: env,
  slots: 1,
  budget: { kind: "usage", scoredMaxPct: 80, freeplayMaxPct: 80 },
  billing: "paid",
  enabled: true,
  ...over,
});

/** A fleet of claude models on two subscriptions, a free OpenRouter model, and four pool accounts. */
function fleet(over: Record<string, unknown> = {}): FleetConfig {
  return parseFleet(
    {
      accounts: { pool: ["RUNNER", "RUNNER2", "RUNNER3", "RUNNER4"] },
      credentials: {
        "claude-1": claude("CLAUDE_CODE_OAUTH_TOKEN"),
        "claude-2": claude("CLAUDE_CODE_OAUTH_TOKEN_2"),
        "or-free": { provider: "openrouter", secretEnv: "OPENROUTER_KEY", slots: 1, billing: "free", enabled: true },
      },
      roster: {
        opus: { tier: "t1", model: "opus", driver: "claude-code" },
        sonnet: { tier: "t1", model: "sonnet", driver: "claude-code" },
        haiku: { tier: "t1", model: "haiku", driver: "claude-code" },
        glm: { tier: "t1", model: "z-ai/glm-5.3-flash:free" },
      },
      queue: [],
      ...over,
    },
    { env: {} },
  );
}

function statesOf(cfg: FleetConfig, runs: RunFact[] = []): ModelState[] {
  return modelStates({ runsDir: "/nonexistent", roster: rosterModels(cfg.roster), runs, sidecar: { version: 1, cleared: {} }, now: NOW, policy: cfg.policy });
}

/**
 * The policy's picks for one tick: ref -> the credential it took. Every live
 * run in `runs` is a job of the supervisor's in flight, on the credential its
 * run recorded, as the tick reads it back.
 */
function picks(cfg: FleetConfig, runs: RunFact[] = [], gate = credentialGate(cfg.credentials, [], runs, NOW)) {
  const roster = rosterModels(cfg.roster);
  const inFlight = runs
    .filter((f) => f.live)
    .map((f) => ({ name: f.runId, account: f.account ?? "RUNNER4", refs: roster.filter((r) => r.model === f.model).map((r) => r.name) }));
  const plan = planTick(cfg, statesOf(cfg, runs), () => undefined, STAMP, [], [], undefined, liveCredentials(runs, roster), new Set(), inFlight, [], gate);
  return {
    plan,
    on: Object.fromEntries(plan.policy.map((p) => [p.job.ref, p.job.placed?.[p.job.ref]?.id ?? null])),
    held: Object.fromEntries(plan.heldPicks.map((h) => [h.name, h.why])),
  };
}

function fact(over: Partial<RunFact>): RunFact {
  return {
    runId: "fleet-x",
    model: "sonnet",
    effort: null,
    episode: "e90",
    episodeOverride: false,
    harnessVersion: null,
    harnessSeries: null,
    extra: false,
    startedAt: NOW - H,
    endedAt: null,
    terminationReason: null,
    modelResponses: 3,
    bestLevel: 2,
    live: true,
    pause: null,
    account: "RUNNER",
    character: "Synth",
    episodeMs: null,
    campaign: null,
    cell: null,
    credential: null,
    driver: "claude-code",
    ...over,
  };
}

describe("a run takes a slot on the first credential that serves it and has room", () => {
  test("two credentials of one provider fill in order, and a full one is passed over", () => {
    const { on, held } = picks(fleet());
    // Three claude models, two one-slot subscriptions: the first two in
    // priority order take them in preference order, the third is held.
    expect(Object.values(on).filter((c) => c?.startsWith("claude")).sort()).toEqual(["claude-1", "claude-2"]);
    expect(on["opus"]).toBe("claude-1");
    expect(on["sonnet"]).toBe("claude-2");
    expect(held["haiku"]).toBe("no credential has room (cap: credential claude-1 1/1 in flight; cap: credential claude-2 1/1 in flight)");
    // The free model takes its own provider's credential, independently.
    expect(on["glm"]).toBe("or-free");
  });

  test("a live run holds its recorded credential's slot across a restart, so the next pick skips it", () => {
    // A live opus run on claude-1, read back off the run: the book counts it.
    const live = fact({ runId: "fleet-opus-e90", model: "opus", credential: "claude-1", account: "RUNNER4" });
    const { on, held } = picks(fleet(), [live]);
    expect(on["opus"]).toBeUndefined();
    expect(on["sonnet"]).toBe("claude-2");
    expect(held["haiku"]).toContain("credential claude-1 1/1 in flight");
  });

  test("a disabled credential is no candidate, and with none left the pick says so", () => {
    const cfg = fleet({ credentials: { "claude-1": claude("CLAUDE_CODE_OAUTH_TOKEN", { enabled: false }) } });
    const { on, held } = picks(cfg);
    expect(on).toEqual({});
    expect(held["opus"]).toBe("no enabled Claude subscription credential — add one under credentials");
    expect(held["glm"]).toBe("no enabled OpenRouter credential carries free models — add one under credentials");
  });

  test("a metered credential carries only its own billing side", () => {
    const cfg = fleet({
      credentials: { "or-paid": { provider: "openrouter", secretEnv: "OPENROUTER_KEY", slots: 2, billing: "paid", enabled: true } },
      roster: { glm: { tier: "t1", model: "z-ai/glm-5.3-flash:free" }, gem: { tier: "t1", model: "google/gemini-3.7-flash" } },
    });
    const { on, held } = picks(cfg);
    expect(on).toEqual({ gem: "or-paid" });
    expect(held["glm"]).toContain("carries free models");
  });

  test("a pinned credential is taken or waited for, never swapped for another", () => {
    const pinned = fleet({ roster: { sonnet: { tier: "t1", model: "sonnet", driver: "claude-code", credential: "claude-2" }, opus: { tier: "t1", model: "opus", driver: "claude-code" } } });
    expect(picks(pinned).on).toEqual({ sonnet: "claude-2", opus: "claude-1" });
    // With its credential busy the pick is held, though claude-1 is free.
    const busy = picks(fleet({ roster: { ...pinned.roster, haiku: { tier: "t1", model: "haiku", driver: "claude-code" } } }), [fact({ runId: "fleet-other", model: "haiku", credential: "claude-2", account: "RUNNER4" })]);
    expect(busy.on["sonnet"]).toBeUndefined();
    expect(busy.held["sonnet"]).toBe("cap: credential claude-2 1/1 in flight");
    // A pin naming a credential that cannot carry the entry refuses the entry by name.
    const wrong = fleet({ roster: { sonnet: { tier: "t1", model: "sonnet", driver: "claude-code", credential: "or-free" } } });
    expect(wrong.roster["sonnet"]!.refused).toContain("or-free is openrouter's");
    expect(wrong.refusals.map((r) => r.pin)).toContain("roster sonnet");
  });

  test("a queue job's credential pin is its runs', and one that cannot carry its ref refuses the job", () => {
    const cfg = fleet({ queue: [{ ref: "opus", episode: "freeplay", repeat: 1, credential: "claude-2" }] });
    const { plan } = picks(cfg);
    expect(plan.queue.assign.map((a) => [a.job.name, a.job.placed?.["opus"]?.id])).toEqual([["opus-freeplay", "claude-2"]]);
    const wrong = fleet({ queue: [{ ref: "glm", episode: "freeplay", repeat: 1, credential: "claude-2" }] });
    expect(wrong.jobs[0]!.enabled).toBe(false);
    expect(wrong.refusals.map((r) => r.why).join(" ")).toContain("claude-2 is claude's, and this model is served by openrouter");
  });

  test("the spawn carries the credential to the run: its id, its variable's NAME, its thresholds", () => {
    const { plan } = picks(fleet());
    const spawn = planTick(fleet(), statesOf(fleet()), () => undefined, STAMP).policy.find((p) => p.job.ref === "opus")!;
    expect(spawn.job.placed?.["opus"]).toEqual({ id: "claude-1", env: "CLAUDE_CODE_OAUTH_TOKEN", usageMaxPct: { scored: 80, freeplay: 80 } });
    expect(plan.policy.length).toBeGreaterThan(0);
  });
});

describe("the per-driver host cap", () => {
  test("caps a driver's sessions whichever credential pays; other drivers are not touched", () => {
    const cfg = fleet({ policy: { maxSessions: { "claude-code": 1 } } });
    const { on, held } = picks(cfg);
    expect(on).toEqual({ opus: "claude-1", glm: "or-free" });
    expect(held["sonnet"]).toBe("no credential has room (cap: credential claude-1 1/1 in flight; cap: claude-code 1/1 sessions on this host)");
    // A live session counts against it, whatever credential it took.
    const live = picks(cfg, [fact({ runId: "fleet-haiku", model: "haiku", credential: "claude-2", account: "RUNNER4" })]);
    expect(live.on["opus"]).toBeUndefined();
    expect(live.held["opus"]).toContain("claude-code 1/1 sessions on this host");
  });
});

describe("a credential's budget holds new starts", () => {
  test("a subscription over its scored threshold holds scored starts; the other subscription still takes them", () => {
    const cfg = fleet();
    const gate = credentialGate(cfg.credentials, [reading("claude-1", 85)], [], NOW);
    const { on, held } = picks(cfg, [], gate);
    expect(on["opus"]).toBe("claude-2");
    expect(held["sonnet"]).toBe(
      "no credential has room (credential claude-1: at or over its scored usage threshold — held until its usage window resets; cap: credential claude-2 1/1 in flight)",
    );
    // Every subscription spent: nothing claude starts, and the words carry no figure.
    const both = credentialGate(cfg.credentials, [reading("claude-1", 85), reading("claude-2", 100)], [], NOW);
    const all = picks(cfg, [], both);
    expect(Object.keys(all.on)).toEqual(["glm"]);
    expect(Object.values(all.held).join(" ")).not.toMatch(/\d+%/);
  });

  test("scored at the scored threshold, freeplay at its own, a probe only on a spent window; 100 turns one off", () => {
    const creds = parseCredentials({ c: claude("CLAUDE_CODE_OAUTH_TOKEN", { budget: { kind: "usage", scoredMaxPct: 70, freeplayMaxPct: 90 } }) });
    const at = (used: number) => credentialGate(creds, [reading("c", used)], [], NOW);
    expect(at(75).holdOf("c", "e90")).toContain("scored usage threshold");
    expect(at(75).holdOf("c", "freeplay")).toBeUndefined();
    expect(at(92).holdOf("c", "freeplay")).toContain("freeplay usage threshold");
    expect(at(92).holdOf("c", "probing")).toBeUndefined();
    expect(at(100).holdOf("c", "probing")).toBe("credential c: a usage window is spent — held until it resets");
    // No budget on a subscription is usage at 80/80.
    const unset = parseCredentials({ c: claude("CLAUDE_CODE_OAUTH_TOKEN", { budget: undefined }) });
    expect(credentialGate(unset, [reading("c", 85)], [], NOW).holdOf("c", "e90")).toContain("scored usage threshold");
    expect(credentialGate(unset, [reading("c", 85)], [], NOW).holdOf("c", "freeplay")).toContain("freeplay usage threshold");
    // Another kind of budget: only a spent window holds on usage.
    const none = parseCredentials({ c: claude("CLAUDE_CODE_OAUTH_TOKEN", { budget: { kind: "runs", perDay: 9 } }) });
    expect(credentialGate(none, [reading("c", 99)], [], NOW).holdOf("c", "e90")).toBeUndefined();
    expect(credentialGate(none, [reading("c", 100)], [], NOW).holdOf("c", "e90")).toContain("spent");
    // A reading past its reset holds nothing.
    expect(credentialGate(creds, [reading("c", 100, -1)], [], NOW).holdOf("c", "e90")).toBeUndefined();
  });

  test("runs per day count today's launches, resumes' segments included; spend per day the provider's charge since 00:00 UTC", () => {
    const creds = parseCredentials({
      r: { provider: "openrouter", secretEnv: "OPENROUTER_KEY", slots: 3, budget: { kind: "runs", perDay: 2 }, billing: "free", enabled: true },
      s: { provider: "openrouter", secretEnv: "OPENROUTER_KEY", slots: 3, budget: { kind: "spend", usdPerDay: 1 }, billing: "paid", enabled: true },
    });
    const today = utcDay(NOW);
    const yesterday = utcDay(NOW - 24 * H);
    const runs = [
      fact({ runId: "a", credential: "r", startedAt: NOW - H }),
      fact({ runId: "b", credential: "r", startedAt: NOW - 30 * H }),
      fact({ runId: "c", credential: "s", startedAt: NOW - 30 * H, spendByDay: { [yesterday]: 5, [today]: 0.6 } }),
    ];
    const g = credentialGate(creds, [], runs, NOW);
    expect(g.runsToday("r")).toBe(1);
    expect(g.holdOf("r", "e90")).toBeUndefined();
    expect(credentialGate(creds, [], [...runs, fact({ runId: "d", credential: "r", startedAt: NOW - 60_000 })], NOW).holdOf("r", "e90")).toBe(
      "credential r: its runs for the day are used — held until 00:00 UTC",
    );
    // Each segment a resume starts is a run (operator, 2026-11-11): b started
    // yesterday, and its resume today is today's second run on r.
    const resumed = [runs[0]!, { ...runs[1]!, resumesByDay: { [yesterday]: 3, [today]: 1 } }, runs[2]!];
    const used = credentialGate(creds, [], resumed, NOW);
    expect(used.runsToday("r")).toBe(2);
    expect(used.holdOf("r", "freeplay")).toBe("credential r: its runs for the day are used — held until 00:00 UTC");
    expect(resumeHoldOf(fact({ credential: "r", episode: "freeplay" }), { credentials: creds }, used)).toBe(
      "credential r: its runs for the day are used — held until 00:00 UTC",
    );
    // From disk: a run started yesterday and resumed twice today reads as two
    // of today's runs on its credential, its start counting only on its own day.
    const dir = tempDir("wrathbench-runs-today-");
    const t = new Trajectory(join(dir, "seg"), { now: () => NOW - 10 * 60_000 });
    t.writeMeta({
      runId: "seg",
      harnessVersion: "harness-0.5-1-gabc",
      startedAt: NOW - 30 * H,
      config: loadRunConfig({ runId: "seg", driver: "openai", model: "m/free", episode: "freeplay", account: "POOL01", credential: "r" }),
      comparability: { episode: "freeplay" } as unknown as RunMeta["comparability"],
    });
    t.append({ t: "resume" });
    t.append({ t: "resume" });
    t.close();
    const onDisk = readRunFact(dir, "seg", NOW)!;
    expect(onDisk.credential).toBe("r");
    expect(onDisk.resumesByDay).toEqual({ [today]: 2 });
    expect(credentialGate(creds, [], [onDisk], NOW).runsToday("r")).toBe(2);
    // Yesterday's segments count nothing today.
    expect(credentialGate(creds, [], [runs[0]!, { ...runs[1]!, resumesByDay: { [yesterday]: 3 } }], NOW).holdOf("r", "freeplay")).toBeUndefined();
    expect(g.spendToday("s")).toBeCloseTo(0.6);
    expect(g.holdOf("s", "e90")).toBeUndefined();
    const spent = credentialGate(creds, [], [...runs, fact({ runId: "e", credential: "s", spendByDay: { [today]: 0.5 } })], NOW);
    expect(spent.holdOf("s", "freeplay")).toBe("credential s: its spend budget for the day is used — held until 00:00 UTC");
    // Neither pauses a live run: the spawns gate drains only a scored job's next episode.
  });

  test("spawns: a held start does not start, a running scored job drains to its boundary, a running freeplay job is its driver's", () => {
    const cfg = fleet();
    const gate = credentialGate(cfg.credentials, [reading("claude-1", 85)], [], NOW);
    const spawn = (name: string, episode: "e90" | "freeplay"): JobSpawn => ({
      name,
      enabled: true,
      account: "RUNNER",
      loop: false,
      entries: [{ model: "opus", driver: "claude-code", episode, placedOn: { id: "claude-1", env: "CLAUDE_CODE_OAUTH_TOKEN" } }],
    });
    const out = gateSpawns([spawn("fresh", "e90"), spawn("live", "e90"), spawn("fp", "freeplay")], gate, new Set(["live", "fp"]));
    expect(out.spawns.map((s) => [s.name, s.enabled])).toEqual([["fresh", false], ["live", false], ["fp", true]]);
    expect(out.gated.map((g) => [g.name, g.drained])).toEqual([["fresh", false], ["live", true]]);
  });
});

describe("the account pool", () => {
  test("every unreserved account is drawn from it, one live session each, under its cap", () => {
    const cfg = fleet({ accounts: { pool: ["RUNNER", "RUNNER2", "RUNNER3", "RUNNER4"], max: 2 } });
    const { plan } = picks(cfg);
    expect(plan.policy.map((p) => p.account)).toEqual(["RUNNER", "RUNNER2"]);
    // A live pool session counts against the cap.
    const live = planTick(cfg, statesOf(cfg), () => undefined, STAMP, [], [], undefined, new Map(), new Set(), [{ name: "x", account: "RUNNER4", refs: ["haiku"] }]);
    expect(live.policy.map((p) => p.account)).toEqual(["RUNNER"]);
  });

  test("reserved accounts are never the pool's: SMOKE*, PROBE, the gate's, and an enabled pin's", () => {
    expect(() => fleet({ accounts: { pool: ["RUNNER", "SMOKE2"] } })).toThrow(/SMOKE2 is reserved/);
    expect(() => fleet({ accounts: { pool: ["PROBE"] } })).toThrow(/PROBE is reserved/);
    expect(() => fleet({ preflight: { enabled: true, account: "GATE", smokes: ["infra/smoke/preflight.ts"] }, accounts: { pool: ["GATE"] } })).toThrow(/gate's account is reserved/);
    const pinned = fleet({ queue: [{ ref: "opus", episode: "freeplay", account: "RUNNER", repeat: 1 }] });
    expect(pinned.jobs[0]!.enabled).toBe(false);
    expect(pinned.refusals[0]!.why).toContain("a pinned account is reserved");
    // The retired classes are refused by name.
    expect(() => fleet({ accounts: { pool: ["RUNNER"], paid: ["PAID"] } })).toThrow(/accounts.paid is not a v1 key/);
  });
});

describe("resumes and the pause a usage budget writes", () => {
  const paused = (over: Partial<RunFact> = {}): RunFact =>
    fact({
      runId: "fleet-cx-freeplay-gpt-5-5-20300101",
      model: "gpt-5.5",
      episode: "freeplay",
      harnessVersion: "harness-0.5-1-gabc",
      harnessSeries: "0.5",
      extra: true,
      live: false,
      pause: { reason: "subscription-budget", at: NOW - H, count: 1, episodeElapsedMs: null, notBefore: NOW - 60_000 },
      driver: "codex",
      credential: "chatgpt-1",
      ...over,
    });
  const config = parseFleet(
    {
      accounts: { pool: ["RUNNER"] },
      credentials: {
        "chatgpt-1": { provider: "chatgpt", secretEnv: "CODEX_HOME", slots: 1, budget: { kind: "usage" }, billing: "paid", enabled: true },
        "chatgpt-2": { provider: "chatgpt", secretEnv: "CODEX_HOME_2", slots: 1, budget: { kind: "usage" }, billing: "paid", enabled: true },
      },
      roster: { cx: { tier: "t1", model: "gpt-5.5", driver: "codex", idle: "unlimited" } },
    },
    { env: {} },
  );
  const series = { ...config, policy: { ...config.policy, series: "0.5" } };

  test("a subscription-budget pause waits for its reset, on no ladder", () => {
    expect(resumeNotBefore({ reason: "subscription-budget", at: NOW, count: 9, episodeElapsedMs: null, notBefore: NOW + H })).toBe(NOW + H);
    expect(resumeNotBefore({ reason: "subscription-budget", at: NOW, count: 9, episodeElapsedMs: null })).toBeNull();
  });

  test("a resume comes back only on the credential it recorded: held while that one is over its threshold, gone or disabled", () => {
    const gate = credentialGate(config.credentials, [reading("chatgpt-1", 85)], [], NOW);
    const held = planResumes({ runs: [paused()], config: series, running: new Map(), held: () => undefined, now: NOW, credentialHold: (f) => resumeHoldOf(f, config, gate) });
    expect(held.resume).toEqual([]);
    expect(held.listed).toEqual([expect.objectContaining({ reason: "subscription-budget", subscriptionWait: true, resumeAfter: null })]);
    // chatgpt-2 is open, and still no resume: a Codex home holds its threads.
    expect(gate.holdOf("chatgpt-2", "freeplay")).toBeUndefined();
    const gone = planResumes({ runs: [paused({ credential: "chatgpt-9" })], config: series, running: new Map(), held: () => undefined, now: NOW, credentialHold: (f) => resumeHoldOf(f, config, gate) });
    expect(gone.listed[0]!.why).toContain("credential chatgpt-9 is not configured");
    // Open: it comes back on its account.
    const open = planResumes({ runs: [paused()], config: series, running: new Map(), held: () => undefined, now: NOW, credentialHold: () => undefined });
    expect(open.resume.map((r) => [r.runId, r.account])).toEqual([["fleet-cx-freeplay-gpt-5-5-20300101", "RUNNER"]]);
  });

  test("the public fleet page gets neither the reset nor the sentence of a usage wait, nor any credential", () => {
    const listing = { runId: "r", model: "gpt-5.5", account: "RUNNER", reason: "quota-exhausted", since: NOW, pauseCount: 1, elapsedMs: null, budgetMs: null };
    const input = {
      present: true,
      server: { phase: "running", since: NOW, build: "b", detail: "", updatedAt: NOW },
      jobs: [],
      accounts: [],
      paused: [
        { ...listing, resumeAfter: NOW + H, why: "quota-exhausted, resuming at (usage window reset)", subscriptionWait: true as const },
        { ...listing, runId: "r2", resumeAfter: NOW + H, why: "quota-exhausted, resuming at (provider reset)" },
      ],
      ended: [],
      credentials: [
        { id: "chatgpt-1", provider: "chatgpt", billing: "paid", enabled: true, secretEnv: "CODEX_HOME", secretSet: true, slots: 1, inUse: 1, budget: "usage < 80%", used: "5h 85%", held: {}, lastError: null },
      ],
      now: NOW,
    } as unknown as FleetResponse;
    const out = projectFleet(input);
    expect(out.paused[0]).toMatchObject({ resumeAfter: null, why: SUBSCRIPTION_WAIT_WHY });
    expect(out.paused[1]).toMatchObject({ resumeAfter: NOW + H, why: "quota-exhausted, resuming at (provider reset)" });
    expect(JSON.stringify(out)).not.toContain("subscriptionWait");
    expect(JSON.stringify(out)).not.toContain("chatgpt-1");
    expect(JSON.stringify(out)).not.toContain("CODEX_HOME");
  });

  test("a usage record and an errored claude turn's limit message never reach a public entry", () => {
    const usage = projectEntry({ i: 1, t: "harness", ts: NOW, start: 0, end: 1, kind: "rate_limits", credential: "chatgpt-1", windows: [{ usedPercent: 85, windowMinutes: 300, resetsAt: NOW }] } as EntrySummary);
    expect(usage).toMatchObject({ kind: "rate_limits" });
    expect(JSON.stringify(usage)).not.toContain("85");
    const errored = projectEntry({ i: 2, t: "claude_result", ts: NOW, start: 0, end: 1, isError: true, text: "limit · resets at a time" } as EntrySummary);
    expect(errored["text"]).toBeUndefined();
  });

  test("a resuming probe waiting on a reset is not aged into stale while its reset is ahead", () => {
    const probe = {
      episode: "probing" as const,
      episodeMs: 60 * 60_000,
      live: false,
      terminationReason: null,
      startedAt: NOW - 3 * H,
      endedAt: null,
      pause: { reason: "quota-exhausted", at: NOW - 2 * H, count: 1, episodeElapsedMs: 40 * 60_000, notBefore: NOW + 3 * 24 * H },
    };
    expect(isStaleRun(probe, NOW)).toBe(false);
    expect(isStaleRun(probe, NOW + 3 * 24 * H + 61 * 60_000)).toBe(true);
  });
});

describe("a per-model cap on a Claude subscription", () => {
  test("holds only that family's picks; the subscription's other models still launch", () => {
    const cfg = fleet({ credentials: { "claude-1": claude("CLAUDE_CODE_OAUTH_TOKEN", { slots: 2 }) }, roster: { op: { tier: "t1", model: "claude-opus-4-8", driver: "claude-code" }, son: { tier: "t1", model: "sonnet", driver: "claude-code" } } });
    const capped: SubscriptionUsage = {
      credential: "claude-1",
      observedAt: NOW - 60_000,
      windows: [
        { usedPercent: 30, windowMinutes: 10_080, resetsAt: NOW + 50 * H },
        { usedPercent: 100, windowMinutes: 10_080, resetsAt: NOW + 50 * H, family: "opus" },
      ],
    };
    const { on, held } = picks(cfg, [], credentialGate(cfg.credentials, [capped], [], NOW));
    expect(on).toEqual({ son: "claude-1" });
    expect(held["op"]).toContain("a usage window is spent");
  });
});

describe("--status", () => {
  test("one line per credential: slots in use, the budget and what it used, whether its secret is set, what it holds", () => {
    const cfg = fleet({ policy: { maxSessions: { "claude-code": 2 } } });
    const book = new SlotBook(cfg.credentials, cfg.policy.maxSessions);
    book.add(book.keysOf("claude-code", "claude-1"));
    const gate = credentialGate(cfg.credentials, [reading("claude-2", 85)], [], NOW);
    const runs = [fact({ credential: "claude-2", live: false, pause: { reason: "auth-failed", at: NOW - 2 * H, count: 1, episodeElapsedMs: null } })];
    const statuses = credentialStatuses({ credentials: cfg.credentials, book, gate, runs, env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-FAKE-NEVER-PRINTED" } });
    expect(statuses.map((s) => [s.id, s.inUse, s.secretSet])).toEqual([["claude-1", 1, true], ["claude-2", 0, false], ["or-free", 0, false]]);
    expect(statuses[1]!.lastError).toEqual({ reason: "auth-failed", at: NOW - 2 * H });
    const lines = formatCredentialStatus(statuses, cfg.policy.maxSessions, NOW);
    expect(lines[1]).toContain("claude-1");
    expect(lines[1]).toContain("1/1 slots");
    expect(lines[2]).toContain("starts HELD");
    expect(lines[2]).toContain("CLAUDE_CODE_OAUTH_TOKEN_2 !! not set");
    expect(lines[2]).toContain("last auth-failed 2h ago");
    expect(lines.at(-1)).toContain("claude-code <= 2");
    expect(lines.join("\n")).not.toContain("FAKE-NEVER-PRINTED");
    expect(formatCredentialStatus([], {}, NOW)[0]).toContain("none configured — no model run can start");
  });
});

describe("the seeded example", () => {
  test("infra/fleet.example.json parses and schedules nothing: every credential it carries is disabled", () => {
    const doc = JSON.parse(readFileSync(resolve(import.meta.dir, "fleet.example.json"), "utf8")) as unknown;
    const cfg = parseFleet(doc, { env: { WRATHBENCH_POOL_SIZE: "2" } });
    expect(cfg.accounts.pool).toEqual(["POOL01", "POOL02"]);
    expect(cfg.credentials.length).toBeGreaterThan(0);
    expect(cfg.credentials.every((c) => !c.enabled)).toBe(true);
    const plan = planTick(cfg, statesOf(cfg), () => undefined, STAMP);
    expect(plan.pinned).toEqual([]);
    expect(plan.queue.assign).toEqual([]);
    expect(plan.policy).toEqual([]);
    expect(plan.heldPicks.length).toBeGreaterThan(0);
  });
});

describe("OpenCode Go", () => {
  const config = parseFleet(
    {
      accounts: { pool: ["RUNNER", "RUNNER2"] },
      credentials: {
        "go-paid": { provider: "opencode-go", secretEnv: "OPENCODE_KEY", slots: 1, budget: { kind: "usage" }, billing: "paid", enabled: true },
        "go-free": { provider: "opencode-go", secretEnv: "OPENCODE_KEY", slots: 1, billing: "free", enabled: true },
      },
      roster: {
        gopaid: { tier: "t1", model: "vendor/go-paid", apiBase: "https://opencode.ai/zen/go/v1", billing: "paid" },
        gofree: { tier: "t1", model: "vendor/go-free", apiBase: "https://opencode.ai/zen/go/v1", billing: "free" },
      },
    },
    { env: {} },
  );
  const okBody = (percent: number): Record<string, unknown> => ({
    rolling: { status: "ok", percent, resetsAt: new Date(NOW + 2 * H).toISOString() },
    weekly: { status: "ok", percent: 10, resetsAt: new Date(NOW + 40 * H).toISOString() },
  });
  const fetchOf = (bodies: unknown[]): GoFetch & { urls: string[]; auth: string[] } => {
    const urls: string[] = [];
    const auth: string[] = [];
    const f = (async (url: string, init: { headers: Record<string, string> }) => {
      urls.push(url);
      auth.push(init.headers["Authorization"] ?? "");
      const b = bodies[Math.min(urls.length - 1, bodies.length - 1)];
      return { ok: true, status: 200, json: () => Promise.resolve(b) };
    }) as unknown as GoFetch & { urls: string[]; auth: string[] };
    f.urls = urls;
    f.auth = auth;
    return f;
  };

  test("the supervisor reads each Go credential with a usage budget, at most once a minute; a $0 Go model's free credential is never held", async () => {
    let now = NOW;
    const said: string[] = [];
    const f = fetchOf([okBody(88)]);
    const go = new FleetGoUsage({ env: { OPENCODE_KEY: "fake-go-key" }, fetch: f, now: () => now, say: (l) => said.push(l) });
    await go.refresh(config.credentials, config.roster);
    await go.refresh(config.credentials, config.roster);
    expect(f.urls).toEqual(["https://opencode.ai/inference/go/v1/usage"]);
    expect(f.auth).toEqual(["Bearer fake-go-key"]);
    const { on, held } = picks(config, [], credentialGate(config.credentials, go.observations(), [], now));
    expect(on).toEqual({ gofree: "go-free" });
    expect(held["gopaid"]).toContain("credential go-paid: at or over its scored usage threshold");
    now += 60_000;
    await go.refresh(config.credentials, config.roster);
    expect(f.urls).toHaveLength(2);
    expect(said.join("\n")).not.toContain("fake-go-key");
  });

  test("an unknown shape or a missing key is no observation, said once, and holds nothing", async () => {
    const said: string[] = [];
    const odd = new FleetGoUsage({ env: { OPENCODE_KEY: "fake-go-key" }, fetch: fetchOf([{ something: "else" }]), now: () => NOW, say: (l) => said.push(l) });
    await odd.refresh(config.credentials, config.roster);
    expect(odd.observations()).toEqual([]);
    expect(said).toHaveLength(1);
    const nokey = new FleetGoUsage({ env: {}, fetch: fetchOf([okBody(99)]), now: () => NOW, say: (l) => said.push(l) });
    await nokey.refresh(config.credentials, config.roster);
    await nokey.refresh(config.credentials, config.roster);
    expect(nokey.observations()).toEqual([]);
    expect(said).toHaveLength(2);
    expect(said[1]).toContain("OPENCODE_KEY is not set");
  });

  test("the supervisor's readings reach the roster and --status through the sidecar beside the runs", () => {
    const runs = tempDir("wrathbench-credential-usage-");
    mkdirSync(join(runs, "fleet-a"), { recursive: true });
    writeFileSync(join(runs, "fleet-a", "meta.json"), JSON.stringify({ runId: "fleet-a", subscriptionUsage: reading("chatgpt-1", 40) }));
    mkdirSync(join(runs, "fleet-b"), { recursive: true });
    writeFileSync(join(runs, "fleet-b", "meta.json"), "{torn");
    writeCredentialUsageSidecar(runs, [reading("go-paid", 70)]);
    expect(readCredentialUsage(runs).map((u) => u.credential).sort()).toEqual(["chatgpt-1", "go-paid"]);
    expect(CREDENTIAL_USAGE_SIDECAR).toBe("fleet-credential-usage.json");
  });
});

describe("the roster's pre-launch check (awaitUsageBudget)", () => {
  const spec = { model: "gpt-5.5", runId: "fleet-cx-e90-gpt-5-5-20300101-r2", episode: "e90", placedOn: { id: "chatgpt-1", env: "CODEX_HOME", usageMaxPct: { scored: 80, freeplay: 80 } } };
  const runsWith = (used: number | null, resetsAt: number): string => {
    const runs = tempDir("wrathbench-roster-budget-");
    if (used !== null) {
      mkdirSync(join(runs, "fleet-a"), { recursive: true });
      writeFileSync(
        join(runs, "fleet-a", "meta.json"),
        JSON.stringify({ subscriptionUsage: { credential: "chatgpt-1", observedAt: NOW - 60_000, windows: [{ usedPercent: used, windowMinutes: 300, resetsAt }] } }),
      );
    }
    return runs;
  };

  test("a held launch waits, quietly, and goes once the window resets", async () => {
    let clock = NOW;
    const waits: number[] = [];
    const said: string[] = [];
    const recorded: string[] = [];
    const go = await awaitUsageBudget(spec, undefined, {
      runsDir: runsWith(92, NOW + 150_000),
      env: {},
      now: () => clock,
      wait: (ms) => {
        waits.push(ms);
        clock += ms;
        return Promise.resolve();
      },
      stopped: () => false,
      say: (l) => said.push(l),
      record: (e) => recorded.push(e.outcome),
    });
    expect(go).toBe(true);
    expect(waits).toEqual([60_000, 60_000, 30_000]);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain(`hold gpt-5.5 (${spec.runId}): credential chatgpt-1: at or over its scored usage threshold`);
    expect(recorded).toEqual(["skipped"]);
  });

  test("a credential with no reading launches at once; a spec on none is never asked; a stop while held launches nothing", async () => {
    const waited: number[] = [];
    const deps = { env: {}, now: () => NOW, wait: (ms: number) => (waited.push(ms), Promise.resolve()), say: () => {}, record: () => {} };
    expect(await awaitUsageBudget(spec, undefined, { ...deps, runsDir: runsWith(null, 0), stopped: () => false })).toBe(true);
    expect(waited).toEqual([]);
    const { placedOn: _p, ...bare } = spec;
    expect(await awaitUsageBudget({ ...bare, placedOn: undefined }, undefined, { ...deps, runsDir: runsWith(99, NOW + H), stopped: () => false })).toBe(true);
    expect(await awaitUsageBudget(spec, undefined, { ...deps, runsDir: runsWith(99, NOW + H), stopped: () => true })).toBe(false);
  });
});

describe("placeRef", () => {
  test("never mutates the book; a scripted run needs no credential and counts only its driver", () => {
    const cfg = fleet();
    const book = new SlotBook(cfg.credentials, { stub: 1 });
    const r = placeRef({ model: "opus", driver: "claude-code" }, "e90", { credentials: cfg.credentials, book });
    expect(r.ok).toBe(true);
    expect(book.inUse("credential:claude-1")).toBe(0);
    const stub = placeRef({ model: "x", driver: "stub" as never }, "e90", { credentials: cfg.credentials, book });
    expect(stub).toEqual({ ok: true, placement: { credential: null, keys: ["driver:stub"] } });
  });
});
