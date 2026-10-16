/**
 * The subscription usage gate, the fleet's half (operator, 2026-10-16): which
 * launches a lane's newest reading holds, where the supervisor asks, what it
 * says, and what never reaches a public surface. Synthetic figures only.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isStaleRun, modelStates, type RunFact } from "../runner/src/models";
import type { SubscriptionUsage } from "../runner/src/subscription-usage";
import { projectEntry, projectFleet, SUBSCRIPTION_WAIT_WHY } from "../runner/viewer/public-projection";
import type { EntrySummary, FleetResponse } from "../runner/viewer/api-types";
import { parseFleet, planResumes, planTick, resumeNotBefore, rosterModels } from "./run-fleet";
import type { FleetJob, JobSpawn } from "./run-fleet-config";
import {
  FleetGoUsage,
  LANE_USAGE_SIDECAR,
  formatSubscriptionGate,
  gateLanes,
  gateSpawns,
  jobHoldOf,
  readLaneUsage,
  subscriptionGate,
  writeLaneUsageSidecar,
} from "./run-fleet-gate";
import type { GoFetch } from "../runner/src/opencode-go";
import { awaitSubscriptionGate } from "./run-roster";
import { tempDirs } from "./temp-dirs";

const tempDir = tempDirs();
const NOW = 1_900_000_000_000;
const H = 3_600_000;
const T = { scored: 80, freeplay: 80 };

const reading = (lane: string, used: number, resetIn = 5 * H, observedAt = NOW - 60_000): SubscriptionUsage => ({
  lane,
  observedAt,
  windows: [{ usedPercent: used, windowMinutes: 300, resetsAt: NOW + resetIn }],
});

const LANE1 = "claude-code:CLAUDE_CODE_OAUTH_TOKEN";
const LANE2 = "claude-code:CLAUDE_CODE_OAUTH_TOKEN_2";
const CODEX = "codex:CODEX_HOME";

describe("the gate over a lane's newest reading", () => {
  test("holds a scored start at the scored threshold, freeplay at its own, a probe only on a spent window", () => {
    const gate = subscriptionGate([reading(LANE1, 85)], { scored: 80, freeplay: 90 }, NOW);
    expect(gate.holdOf(LANE1, "e90")).toBe(`subscription gate: ${LANE1} is at or over the scored threshold — held until its usage window resets`);
    expect(gate.holdOf(LANE1, "e360")).toBeDefined();
    expect(gate.holdOf(LANE1, "freeplay")).toBeUndefined();
    expect(gate.holdOf(LANE1, "probing")).toBeUndefined();
    expect(subscriptionGate([reading(LANE1, 100)], T, NOW).holdOf(LANE1, "probing")).toContain("spent usage window");
    // No reading, another lane, or a driver with no lane: open.
    expect(gate.holdOf(LANE2, "e90")).toBeUndefined();
    expect(gate.holdOf(null, "e90")).toBeUndefined();
  });

  test("100 turns a threshold off, but a spent window still holds everything until it resets", () => {
    const off = { scored: 100, freeplay: 100 };
    expect(subscriptionGate([reading(CODEX, 99)], off, NOW).holdOf(CODEX, "e90")).toBeUndefined();
    expect(subscriptionGate([reading(CODEX, 100)], off, NOW).holdOf(CODEX, "e90")).toContain("spent usage window");
    expect(subscriptionGate([reading(CODEX, 100)], off, NOW).holdOf(CODEX, "freeplay")).toBeDefined();
  });

  test("a window whose reset has passed counts as reset; the newest reading per lane wins", () => {
    expect(subscriptionGate([reading(CODEX, 95, -1)], T, NOW).holdOf(CODEX, "e90")).toBeUndefined();
    const older = reading(CODEX, 95, 5 * H, NOW - 2 * H);
    const newer = reading(CODEX, 10, 5 * H, NOW - H);
    expect(subscriptionGate([newer, older], T, NOW).holdOf(CODEX, "e90")).toBeUndefined();
  });

  test("its words name the lane and the class, never a figure or a time", () => {
    const gate = subscriptionGate([reading(LANE1, 85), reading(CODEX, 100)], T, NOW);
    for (const why of [gate.holdOf(LANE1, "e90"), gate.holdOf(LANE1, "freeplay"), gate.holdOf(CODEX, "probing")]) {
      expect(why).toBeDefined();
      expect(why!.replace(/CLAUDE_CODE_OAUTH_TOKEN(_\d)?/, "")).not.toMatch(/\d/);
    }
  });
});

describe("where the supervisor asks", () => {
  const two = {
    accounts: { pool: ["RUNNER", "RUNNER2"] },
    roster: {
      son: { tier: "t1", model: "sonnet", driver: "claude-code" },
      cx: { tier: "t1", model: "gpt-5.5", driver: "codex" },
    },
    policy: {
      maxConcurrent: { "claude-code": 2, "claude-code:CLAUDE_CODE_OAUTH_TOKEN": 1, "claude-code:CLAUDE_CODE_OAUTH_TOKEN_2": 1 },
      subscriptions: ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN_2"],
    },
  };
  const config = parseFleet(two, { env: {} });
  const states = modelStates({ runsDir: "/nonexistent", roster: rosterModels(config.roster), runs: [], sidecar: { version: 1, cleared: {} }, now: NOW, policy: config.policy });
  const plan = (observations: SubscriptionUsage[]) =>
    planTick(config, states, () => undefined, "20300101", [], [], undefined, new Map(), new Set(), [], [], subscriptionGate(observations, T, NOW));

  test("a claude pick takes the open subscription when its first is held", () => {
    const p = plan([reading(LANE1, 90)]);
    expect(p.policy.find((x) => x.job.ref === "son")?.job.subscription).toBe("CLAUDE_CODE_OAUTH_TOKEN_2");
  });

  test("with every subscription held, or the codex lane held, the pick is HELD with the gate's reason", () => {
    const p = plan([reading(LANE1, 90), reading(LANE2, 81), reading(CODEX, 80)]);
    expect(p.policy).toEqual([]);
    expect(p.heldPicks.find((h) => h.name === "son")!.why).toStartWith("subscription gate: claude-code:CLAUDE_CODE_OAUTH_TOKEN");
    expect(p.heldPicks.find((h) => h.name === "cx")!.why).toBe(`subscription gate: ${CODEX} is at or over the scored threshold — held until its usage window resets`);
    // Under the threshold, nothing is held.
    expect(plan([reading(CODEX, 79)]).policy.map((x) => x.job.ref).sort()).toEqual(["cx", "son"]);
  });

  test("a manual or pinned job is held only when every lane it could take is", () => {
    const gate = subscriptionGate([reading(LANE1, 90)], T, NOW);
    const job = (over: Partial<FleetJob>): FleetJob => ({ refs: ["son"], ref: "son", episode: "e90", repeat: 1, name: "son-e90", enabled: true, source: "queue", ...over });
    expect(jobHoldOf(job({}), config.roster, config.policy.subscriptions, gate)).toBeUndefined();
    expect(jobHoldOf(job({ subscription: "CLAUDE_CODE_OAUTH_TOKEN" }), config.roster, config.policy.subscriptions, gate)).toBeDefined();
    expect(jobHoldOf(job({ refs: ["cx"], ref: "cx" }), config.roster, config.policy.subscriptions, subscriptionGate([reading(CODEX, 85)], T, NOW))).toBeDefined();
  });

  test("spawns: a held start does not start, a running scored job drains to its boundary, a running freeplay job is its driver's", () => {
    const gate = subscriptionGate([reading(CODEX, 90)], T, NOW);
    const sp = (name: string, episode: string): JobSpawn => ({ name, enabled: true, account: "RUNNER", loop: false, entries: [{ model: "gpt-5.5", driver: "codex", episode }] });
    const { spawns, gated } = gateSpawns([sp("new-e90", "e90"), sp("live-e90", "e90"), sp("live-free", "freeplay"), sp("new-free", "freeplay")], gate, new Set(["live-e90", "live-free"]));
    expect(spawns.map((s) => [s.name, s.enabled])).toEqual([
      ["new-e90", false],
      ["live-e90", false],
      ["live-free", true],
      ["new-free", false],
    ]);
    expect(gated.map((g) => [g.name, g.drained])).toEqual([
      ["new-e90", false],
      ["live-e90", true],
      ["new-free", false],
    ]);
    // A spawn on no subscription is never touched.
    const plain: JobSpawn = { name: "glm", enabled: true, account: "RUNNER", loop: false, entries: [{ model: "z-ai/glm:free", episode: "e90" }] };
    expect(gateSpawns([plain], gate, new Set()).spawns[0]!.enabled).toBe(true);
  });
});

describe("resumes and the pause the gate writes", () => {
  const fact = (over: Partial<RunFact>): RunFact => ({
    runId: "fleet-cx-freeplay-gpt-5-5-20300101",
    model: "gpt-5.5",
    effort: null,
    episode: "freeplay",
    episodeOverride: false,
    harnessVersion: "0.0.0-phase0+gharness-0.5-1-gabc",
    harnessSeries: "0.5",
    extra: true,
    startedAt: NOW - 10 * H,
    endedAt: null,
    terminationReason: null,
    modelResponses: 40,
    bestLevel: 9,
    live: false,
    pause: { reason: "subscription-budget", at: NOW - H, count: 1, episodeElapsedMs: null, notBefore: NOW - 60_000 },
    account: "RUNNER",
    character: "Synth",
    episodeMs: null,
    campaign: null,
    cell: null,
    subscription: null,
    driver: "codex",
    lane: CODEX,
    ...over,
  });
  const config = parseFleet(
    { accounts: { pool: ["RUNNER"] }, roster: { cx: { tier: "t1", model: "gpt-5.5", driver: "codex", idle: "unlimited" } } },
    { env: {} },
  );
  const series = { ...config, policy: { ...config.policy, series: "0.5" } };

  test("a subscription-budget pause waits for its reset, on no ladder", () => {
    expect(resumeNotBefore({ reason: "subscription-budget", at: NOW, count: 9, episodeElapsedMs: null, notBefore: NOW + H })).toBe(NOW + H);
    expect(resumeNotBefore({ reason: "subscription-budget", at: NOW, count: 9, episodeElapsedMs: null })).toBeNull();
  });

  test("the resume waits while the lane is over its threshold, and is listed as a subscription wait", () => {
    const gate = subscriptionGate([reading(CODEX, 85)], T, NOW);
    const held = planResumes({ runs: [fact({})], config: series, running: new Map(), held: () => undefined, now: NOW, subscriptionHold: (f) => gate.holdOf(f.lane ?? null, f.episode) });
    expect(held.resume).toEqual([]);
    expect(held.listed).toEqual([expect.objectContaining({ reason: "subscription-budget", subscriptionWait: true, resumeAfter: null })]);
    // Before its own reset it waits for that, still a subscription wait.
    const early = planResumes({ runs: [fact({ pause: { reason: "subscription-budget", at: NOW - H, count: 1, episodeElapsedMs: null, notBefore: NOW + H } })], config: series, running: new Map(), held: () => undefined, now: NOW });
    expect(early.listed[0]).toMatchObject({ resumeAfter: NOW + H, subscriptionWait: true });
    // Reset passed and the lane open: it comes back on its account.
    const open = planResumes({ runs: [fact({})], config: series, running: new Map(), held: () => undefined, now: NOW, subscriptionHold: () => undefined });
    expect(open.resume.map((r) => [r.runId, r.account])).toEqual([["fleet-cx-freeplay-gpt-5-5-20300101", "RUNNER"]]);
  });

  test("the public fleet page gets neither the reset nor the sentence of a subscription wait", () => {
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
      now: NOW,
    } as unknown as FleetResponse;
    const out = projectFleet(input);
    expect(out.paused[0]).toMatchObject({ resumeAfter: null, why: SUBSCRIPTION_WAIT_WHY });
    expect(out.paused[1]).toMatchObject({ resumeAfter: NOW + H, why: "quota-exhausted, resuming at (provider reset)" });
    expect(JSON.stringify(out)).not.toContain("subscriptionWait");
  });

  test("a usage record and an errored claude turn's limit message never reach a public entry", () => {
    const usage = projectEntry({ i: 1, t: "harness", ts: NOW, start: 0, end: 1, kind: "rate_limits", lane: CODEX, windows: [{ usedPercent: 85, windowMinutes: 300, resetsAt: NOW }] } as EntrySummary);
    expect(usage).toMatchObject({ kind: "rate_limits" });
    expect(JSON.stringify(usage)).not.toContain("85");
    const errored = projectEntry({ i: 2, t: "claude_result", ts: NOW, start: 0, end: 1, isError: true, text: "limit · resets at a time" } as EntrySummary);
    expect(errored["text"]).toBeUndefined();
    const ok = projectEntry({ i: 3, t: "claude_result", ts: NOW, start: 0, end: 1, isError: false, text: "done" } as EntrySummary);
    expect(ok["text"]).toBe("done");
  });
});

describe("a per-model cap on a claude lane", () => {
  test("holds only that family's picks; the lane's other models still launch", () => {
    const config = parseFleet(
      {
        accounts: { pool: ["RUNNER", "RUNNER2"] },
        roster: { op: { tier: "t1", model: "claude-opus-4-8", driver: "claude-code" }, son: { tier: "t1", model: "sonnet", driver: "claude-code" } },
        policy: { maxConcurrent: { "claude-code": 2 } },
      },
      { env: {} },
    );
    const states = modelStates({ runsDir: "/nonexistent", roster: rosterModels(config.roster), runs: [], sidecar: { version: 1, cleared: {} }, now: NOW, policy: config.policy });
    const capped: SubscriptionUsage = {
      lane: LANE1,
      observedAt: NOW - 60_000,
      windows: [
        { usedPercent: 30, windowMinutes: 10_080, resetsAt: NOW + 50 * H },
        { usedPercent: 100, windowMinutes: 10_080, resetsAt: NOW + 50 * H, family: "opus" },
      ],
    };
    const plan = planTick(config, states, () => undefined, "20300101", [], [], undefined, new Map(), new Set(), [], [], subscriptionGate([capped], T, NOW));
    expect(plan.policy.map((p) => p.job.ref)).toEqual(["son"]);
    expect(plan.heldPicks.find((h) => h.name === "op")!.why).toContain("at or over the scored threshold");
    // A lane-wide spent window holds both.
    const laneWide = { ...capped, windows: [{ usedPercent: 100, windowMinutes: 10_080, resetsAt: NOW + 50 * H }] };
    expect(planTick(config, states, () => undefined, "20300101", [], [], undefined, new Map(), new Set(), [], [], subscriptionGate([laneWide], T, NOW)).policy).toEqual([]);
  });
});

describe("a resuming probe waiting on a reset", () => {
  test("is not aged into stale while its reset is ahead, however short its own budget", () => {
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
    expect(isStaleRun(probe, NOW + 3 * 24 * H + 30 * 60_000)).toBe(false);
    // Its gap starts at the reset: an hour past it with no resume is stale again.
    expect(isStaleRun(probe, NOW + 3 * 24 * H + 61 * 60_000)).toBe(true);
    // A pause with no reset ages from its own instant, as before.
    expect(isStaleRun({ ...probe, pause: { ...probe.pause, reason: "auth-failed" } }, NOW)).toBe(true);
  });
});

describe("--status", () => {
  test("shows every lane's windows, the reading's age, what is held, and the thresholds", () => {
    const config = parseFleet({ accounts: { pool: ["RUNNER"] }, roster: { son: { tier: "t1", model: "sonnet", driver: "claude-code" }, cx: { tier: "t1", model: "gpt-5.5", driver: "codex" } } }, { env: {} });
    const gate = subscriptionGate([reading(CODEX, 85)], { scored: 80, freeplay: 100 }, NOW);
    const lines = formatSubscriptionGate(gate, gateLanes(gate, config.roster, config.policy.subscriptions), { local: { scored: 70, freeplay: 100 } });
    expect(lines[0]).toContain("scored starts held at 80%, freeplay held off");
    expect(lines[1]).toContain("the fleet container's thresholds, off its state file; this shell's env reads scored 70%");
    expect(lines.find((l) => l.includes(CODEX))).toMatch(/5h 85% \(resets .*\); observed 1m ago — scored HELD until .*, freeplay open/);
    expect(lines.find((l) => l.includes(LANE1))).toContain("no observation — open");
  });
});

describe("OpenCode Go", () => {
  const roster = {
    accounts: { pool: ["RUNNER"], paid: ["PAID"] },
    roster: {
      gopaid: { tier: "t1", model: "vendor/go-paid", apiBase: "https://opencode.ai/zen/go/v1", apiKeyEnv: "OPENCODE_KEY", billing: "paid" },
      gofree: { tier: "t1", model: "vendor/go-free", apiBase: "https://opencode.ai/zen/go/v1", apiKeyEnv: "OPENCODE_KEY", billing: "free" },
    },
  };
  const config = parseFleet(roster, { env: {} });
  const GO = "opencode-go:OPENCODE_KEY";
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

  test("the supervisor reads one lane per key for the allowance entries, at most once a minute; a $0 Go model is never gated", async () => {
    let now = NOW;
    const said: string[] = [];
    const f = fetchOf([okBody(88)]);
    const go = new FleetGoUsage({ env: { OPENCODE_KEY: "fake-go-key" }, fetch: f, now: () => now, say: (l) => said.push(l) });
    await go.refresh(config.roster);
    await go.refresh(config.roster);
    expect(f.urls).toEqual(["https://opencode.ai/inference/go/v1/usage"]);
    expect(f.auth).toEqual(["Bearer fake-go-key"]);
    const gate = subscriptionGate(go.observations(), T, now);
    // The paid entry's pick is held; the $0 one picks.
    const states = modelStates({ runsDir: "/nonexistent", roster: rosterModels(config.roster), runs: [], sidecar: { version: 1, cleared: {} }, now, policy: config.policy });
    const plan = planTick(config, states, () => undefined, "20300101", [], [], undefined, new Map(), new Set(), [], [], gate);
    expect(plan.policy.map((p) => p.job.ref)).toEqual(["gofree"]);
    expect(plan.heldPicks.find((h) => h.name === "gopaid")!.why).toContain(GO);
    now += 60_000;
    await go.refresh(config.roster);
    expect(f.urls).toHaveLength(2);
    expect(said.join("\n")).not.toContain("fake-go-key");
  });

  test("an unknown shape or a missing key is no observation, said once, and holds nothing", async () => {
    const said: string[] = [];
    const odd = new FleetGoUsage({ env: { OPENCODE_KEY: "fake-go-key" }, fetch: fetchOf([{ something: "else" }]), now: () => NOW, say: (l) => said.push(l) });
    await odd.refresh(config.roster);
    expect(odd.observations()).toEqual([]);
    expect(said).toHaveLength(1);
    const nokey = new FleetGoUsage({ env: {}, fetch: fetchOf([okBody(99)]), now: () => NOW, say: (l) => said.push(l) });
    await nokey.refresh(config.roster);
    await nokey.refresh(config.roster);
    expect(nokey.observations()).toEqual([]);
    expect(said).toHaveLength(2);
    expect(said[1]).toContain("OPENCODE_KEY is not set");
  });

  test("the supervisor's readings reach the roster and --status through the sidecar beside the runs", () => {
    const runs = tempDir("wrathbench-lane-usage-");
    mkdirSync(join(runs, "fleet-a"), { recursive: true });
    writeFileSync(join(runs, "fleet-a", "meta.json"), JSON.stringify({ runId: "fleet-a", subscriptionUsage: reading(CODEX, 40) }));
    mkdirSync(join(runs, "fleet-b"), { recursive: true });
    writeFileSync(join(runs, "fleet-b", "meta.json"), "{torn");
    writeLaneUsageSidecar(runs, [reading(GO, 70)]);
    const lanes = readLaneUsage(runs).map((u) => u.lane).sort();
    expect(lanes).toEqual([CODEX, GO]);
    expect(LANE_USAGE_SIDECAR).toBe("fleet-subscription-usage.json");
  });
});

describe("the roster's pre-launch check (awaitSubscriptionGate)", () => {
  const spec = { model: "gpt-5.5", runId: "fleet-cx-e90-gpt-5-5-20300101-r2", episode: "e90", driver: "codex" as const, tokenEnv: undefined, apiBase: "", apiKeyEnv: "", billing: undefined };
  /** A runs directory holding one run whose reading puts the codex lane at `used`, resetting at `resetsAt`. */
  const runsWith = (used: number | null, resetsAt: number): string => {
    const runs = tempDir("wrathbench-roster-gate-");
    if (used !== null) {
      mkdirSync(join(runs, "fleet-a"), { recursive: true });
      writeFileSync(
        join(runs, "fleet-a", "meta.json"),
        JSON.stringify({ subscriptionUsage: { lane: CODEX, observedAt: NOW - 60_000, windows: [{ usedPercent: used, windowMinutes: 300, resetsAt }] } }),
      );
    }
    return runs;
  };

  test("a held launch waits, quietly, and goes once the window resets", async () => {
    let clock = NOW;
    const waits: number[] = [];
    const said: string[] = [];
    const recorded: string[] = [];
    const go = await awaitSubscriptionGate(spec, undefined, {
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
    // A minute at most per look, the last one exactly to the reset.
    expect(waits).toEqual([60_000, 60_000, 30_000]);
    expect(clock).toBe(NOW + 150_000);
    // One line for the whole hold, however long it lasts.
    expect(said).toHaveLength(1);
    expect(said[0]).toContain(`hold gpt-5.5 (${spec.runId}): subscription gate: ${CODEX} is at or over the scored threshold`);
    expect(recorded).toEqual(["skipped"]);
  });

  test("a lane with no reading launches at once; a stop or a drain while held launches nothing", async () => {
    const waited: number[] = [];
    const deps = { env: {}, now: () => NOW, wait: (ms: number) => (waited.push(ms), Promise.resolve()), say: () => {}, record: () => {} };
    expect(await awaitSubscriptionGate(spec, undefined, { ...deps, runsDir: runsWith(null, 0), stopped: () => false })).toBe(true);
    expect(waited).toEqual([]);
    // A spec on no subscription is never asked about.
    expect(await awaitSubscriptionGate({ ...spec, driver: "openai" }, undefined, { ...deps, runsDir: runsWith(99, NOW + H), stopped: () => false })).toBe(true);
    expect(await awaitSubscriptionGate(spec, undefined, { ...deps, runsDir: runsWith(99, NOW + H), stopped: () => true })).toBe(false);
  });
});
