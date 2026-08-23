import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PREFLIGHT,
  bootMarker,
  diffLanes,
  formatGate,
  gateDecision,
  gateOpen,
  healthDigest,
  parsePreflight,
  preflightAccounts,
  runPreflight,
  serverIdentity,
  smokePath,
  tailOf,
  fillEntries,
  isAllowlistedFree,
  isClaudeFamily,
  isSharedFreePool,
  laneArgv,
  fleetComplete,
  laneUntil,
  resolveStatePath,
  parseFleet,
  rereadFleet,
  formatConfigBanner,
  loadConfigForRead,
  nextConfigRejection,
  validateEntries,
  episodeDimensions,
  formatAccounts,
  formatQueue,
  legacyJob,
  liveJobsFromState,
  pinnedJobs,
  poolJobs,
  policyRefs,
  policyExclusion,
  planTick,
  jobLane,
  planQueue,
  planPolicy,
  policyJob,
  rosterModels,
  eligibleFrom,
  formatModels,
  runnableRefs,
  type FleetJob,
  type FleetRosterEntry,
  type FleetConfig,
  type FleetLane,
  type FleetPreflight,
  type LaneSets,
  type PreflightRecord,
  type PreflightSmoke,
  type ConfigRejection,
} from "./run-fleet";
import { modelStates, type ModelState, type RosterModel, type RunFact } from "../runner/src/models";

/**
 * The fleet is config, and the config's whole job is to become a set of
 * run-roster invocations. No spawning here: everything below the spawn
 * boundary is run-roster's, already covered by roster.test.ts.
 */

function lane(over: Partial<FleetLane> = {}): FleetLane {
  return {
    name: "l",
    enabled: true,
    account: "RUNNER",
    loop: false,
    entries: [{ model: "z-ai/glm-5.2:free" }],
    ...over,
  };
}

function fleetJson(lanes: unknown[]): unknown {
  return { _notes: ["n"], lanes };
}

describe("parseFleet", () => {
  test("the shipped shape parses and keeps lane order", () => {
    const config = parseFleet(
      fleetJson([
        lane({ name: "a", account: "SHAKEOUT", loop: true, untilDefault: "18:00", entries: [{ model: "sonnet", driver: "claude-code" }] }),
        lane({ name: "b", account: "RUNNER" }),
      ]),
    );
    expect(config.jobs.map((l) => l.name)).toEqual(["a", "b"]);
    expect(config.legacyLanes).toEqual(["a", "b"]);
    expect(config.jobs[0]!.legacy!.untilDefault).toBe("18:00");
    // A legacy lane is a pinned job: its account, its loop, its entries verbatim.
    expect(config.jobs[0]).toMatchObject({ account: "SHAKEOUT", repeat: "loop", source: "legacy", enabled: true });
    expect(jobLane(config.jobs[0]!, {}, "SHAKEOUT", "20260101")).toMatchObject({ name: "a", account: "SHAKEOUT", loop: true, untilDefault: "18:00" });
  });

  test("two enabled lanes must not share an account", () => {
    expect(() =>
      parseFleet(fleetJson([lane({ name: "a", account: "RUNNER" }), lane({ name: "b", account: "runner" })])),
    ).toThrow(/shared by enabled jobs a and b/);
  });

  test("a disabled lane may sit on a running lane's account — that is the burn switch", () => {
    const config = parseFleet(
      fleetJson([lane({ name: "a", account: "SHAKEOUT" }), lane({ name: "b", account: "SHAKEOUT", enabled: false })]),
    );
    expect(config.jobs).toHaveLength(2);
    expect(config.accounts.pinned).toEqual({ SHAKEOUT: "a" });
  });

  test("a lane needs exactly one of entries or rosterFile", () => {
    expect(() => parseFleet(fleetJson([{ name: "a", enabled: true, account: "X" }]))).toThrow(/exactly one of/);
    expect(() =>
      parseFleet(fleetJson([lane({ rosterFile: "infra/roster-example.json", entries: [{ model: "m" }] })])),
    ).toThrow(/exactly one of/);
  });

  test("malformed shapes are refused with a named lane", () => {
    expect(() => parseFleet([])).toThrow(/must be a JSON object/);
    expect(() => parseFleet(fleetJson([lane({ untilDefault: "tomorrow" })]))).toThrow(/wants HH:MM/);
    expect(() => parseFleet(fleetJson([lane({ name: "a" }), lane({ name: "a" })]))).toThrow(/duplicate lane name/);
  });
});

describe("lane-policy", () => {
  test.each(["sonnet", "opus", "haiku", "claude-4-opus", "anthropic/claude-3.5-sonnet:free"])(
    "%s is claude-family",
    (m) => expect(isClaudeFamily(m)).toBe(true),
  );
  test.each(["z-ai/glm-5.2:free", "poolside/laguna-s-2.1:free", "deepseek-v4-flash-free"])(
    "%s is not claude-family",
    (m) => expect(isClaudeFamily(m)).toBe(false),
  );

  test("a claude model on an openai-driver lane is refused, citing lane-policy", () => {
    expect(() => validateEntries(lane(), [{ model: "sonnet" }])).toThrow(/lane-policy/);
    expect(() => validateEntries(lane(), [{ model: "anthropic/claude-3.5-sonnet:free", driver: "openai" }])).toThrow(
      /lane-policy/,
    );
  });

  test("the claude-code driver carries claude models only", () => {
    expect(() => validateEntries(lane(), [{ model: "z-ai/glm-5.2:free", driver: "claude-code" }])).toThrow(
      /lane-policy/,
    );
  });

  test("the pre-ADR-0035 driver spelling is read as claude-code and normalised, never written on", () => {
    const [e] = validateEntries(lane(), [{ model: "sonnet", driver: "claude-subscription" as never }]);
    expect(e!.driver).toBe("claude-code");
    expect(() => validateEntries(lane(), [{ model: "sonnet", driver: "claude-thing" as never }])).toThrow(/unknown driver/);
  });

  test("a suffixless model on a shared free pool is refused unless allowlisted", () => {
    // A paid-looking id with no free suffix on OpenRouter is a lane-policy error.
    expect(() => validateEntries(lane(), [{ model: "z-ai/glm-5.2" }])).toThrow(/lane-policy/);
    // The verified-free stealth id is allowlisted and passes.
    expect(isAllowlistedFree("stealth/ox-alpha")).toBe(true);
    expect(() => validateEntries(lane(), [{ model: "stealth/ox-alpha" }])).not.toThrow();
    // Allowlist membership does not leak to other suffixless ids.
    expect(isAllowlistedFree("stealth/anything-else")).toBe(false);
  });

  test.each([
    [undefined, true], // absent -> run-roster's OpenRouter default -> shared pool
    ["https://openrouter.ai/api/v1", true],
    ["https://opencode.ai/zen/v1", true],
    ["http://192.168.1.20:1234/v1", false], // local LM Studio box on the LAN
    ["http://localhost:1234/v1", false],
  ] as const)("isSharedFreePool(%s) === %s", (base, expected) => {
    expect(isSharedFreePool(base)).toBe(expected);
  });

  test("a shared free-cloud pool still requires a free model id", () => {
    // No apiBase -> OpenRouter default -> shared pool -> suffix required.
    expect(() => validateEntries(lane(), [{ model: "z-ai/glm-5.2" }])).toThrow(/free models only/);
    expect(() =>
      validateEntries(lane(), [{ model: "deepseek-v4-flash", apiBase: "https://opencode.ai/zen/v1" }]),
    ).toThrow(/free models only/);
    // A properly suffixed model on the pool is fine.
    expect(validateEntries(lane(), [{ model: "z-ai/glm-5.2:free" }])).toHaveLength(1);
  });

  test("a local/self-hosted openai lane is exempt from the free-suffix rule", () => {
    const local = lane({ account: "RUNNER6" });
    expect(
      validateEntries(local, [
        { model: "qwen/qwen3.8-27b", driver: "openai", apiBase: "http://192.168.1.20:1234/v1", apiKeyEnv: "LMSTUDIO_KEY" },
      ]),
    ).toHaveLength(1);
  });

  test("a claude-* id is barred on any openai lane, local or shared", () => {
    // Shared pool.
    expect(() => validateEntries(lane(), [{ model: "anthropic/claude-3.5-sonnet:free" }])).toThrow(/lane-policy/);
    // Local lane: exempt from the free-suffix rule but never from the claude bar.
    expect(() =>
      validateEntries(lane(), [{ model: "claude-4-opus", apiBase: "http://192.168.1.20:1234/v1" }]),
    ).toThrow(/lane-policy/);
  });

  test("an entry pinned to a different account than its lane is refused", () => {
    expect(() => validateEntries(lane({ account: "RUNNER" }), [{ model: "m", account: "RUNNER2" }])).toThrow(
      /one lane, one account/,
    );
    // same account, any case: fine (free-suffixed so it clears the pool rule too)
    expect(validateEntries(lane({ account: "RUNNER" }), [{ model: "m:free", account: "runner" }])).toHaveLength(1);
  });
});

describe("rereadFleet", () => {
  const good: FleetConfig = parseFleet(fleetJson([lane({ name: "keep" })]));

  test("a malformed re-read keeps the last good config and reports the error", () => {
    const r = rereadFleet("fleet.json", good, () => "{not json");
    expect(r.config).toBe(good);
    expect(r.error).toBeDefined();
  });

  test("a re-read that violates a guard keeps the last good config too", () => {
    const dupe = JSON.stringify(fleetJson([lane({ name: "a", account: "X" }), lane({ name: "b", account: "X" })]));
    const r = rereadFleet("fleet.json", good, () => dupe);
    expect(r.config).toBe(good);
    expect(r.error).toMatch(/shared by enabled jobs/);
  });

  test("a valid re-read replaces the config", () => {
    const next = JSON.stringify(fleetJson([lane({ name: "next" })]));
    const r = rereadFleet("fleet.json", good, () => next);
    expect(r.error).toBeUndefined();
    expect(r.config.jobs[0]!.name).toBe("next");
  });
});

describe("fillEntries", () => {
  test("entries get the lane account and a fleet-scoped run id", () => {
    const l = lane({ name: "free-openrouter", account: "RUNNER" });
    const [e] = fillEntries(l, [{ model: "z-ai/glm-5.2:free" }], "20260822");
    expect(e!.account).toBe("RUNNER");
    expect(e!.runId).toBe("fleet-free-openrouter-glm-5-2-20260822");
  });

  test("effort is part of the derived run id, and an explicit runId wins", () => {
    const l = lane({ name: "sub", account: "SHAKEOUT" });
    const specs = fillEntries(
      l,
      [
        { model: "sonnet", driver: "claude-code", effort: "low" },
        { model: "sonnet", driver: "claude-code", runId: "pinned" },
      ],
      "20260822",
    );
    expect(specs[0]!.runId).toBe("fleet-sub-sonnet-low-20260822");
    expect(specs[1]!.runId).toBe("pinned");
  });
});

describe("laneArgv", () => {
  test("a loop lane builds the full roster argv: file, log, date, loop, until", () => {
    const l = lane({ name: "sub-sonnet", loop: true, untilDefault: "18:00" });
    const argv = laneArgv(l, { stamp: "20260822", until: undefined });
    expect(argv[0]).toEndWith("run-roster.sh");
    expect(argv[1]).toEndWith("fleet-sub-sonnet-20260822.roster.json");
    expect(argv[argv.indexOf("--log") + 1]).toEndWith("fleet-sub-sonnet-20260822.jsonl");
    expect(argv[argv.indexOf("--date") + 1]).toBe("20260822");
    expect(argv).toContain("--loop");
    expect(argv[argv.indexOf("--until") + 1]).toBe("18:00");
  });

  test("a CLI --until overrides the lane's untilDefault", () => {
    const l = lane({ loop: true, untilDefault: "18:00" });
    const argv = laneArgv(l, { stamp: "20260822", until: "07:30" });
    expect(argv[argv.indexOf("--until") + 1]).toBe("07:30");
  });

  test("a respawn resumes the materialized roster", () => {
    const argv = laneArgv(lane(), { stamp: "20260822", until: undefined, resumeRoster: true });
    expect(argv).toContain("--resume-roster");
    expect(argv).not.toContain("--loop");
  });

  test("a loop lane with no stop condition loops forever — the fleet-service shape", () => {
    // ADR-0020: the supervisor has no deadline; steering is fleet.json.
    expect(laneUntil(lane({ loop: true }), undefined)).toBeUndefined();
    expect(laneArgv(lane({ loop: true }), { stamp: "20260822", until: undefined })).not.toContain("--until");
    expect(laneUntil(lane({ loop: true }), "07:00")).toBe("07:00");
    expect(laneUntil(lane({ loop: false }), undefined)).toBeUndefined();
  });
});

describe("diffLanes", () => {
  const sets = (over: Partial<LaneSets> = {}): LaneSets => ({
    running: new Set(),
    draining: new Set(),
    finished: new Set(),
    ...over,
  });

  test("startup: every enabled lane starts, disabled lanes do not", () => {
    const a = diffLanes([lane({ name: "on" }), lane({ name: "off", enabled: false, account: "B" })], sets());
    expect(a.start.map((l) => l.name)).toEqual(["on"]);
    expect(a.drain).toEqual([]);
  });

  test("flipping a running lane to enabled:false drains it, exactly once", () => {
    const disabled = [lane({ name: "l", enabled: false })];
    expect(diffLanes(disabled, sets({ running: new Set(["l"]) })).drain).toEqual(["l"]);
    expect(diffLanes(disabled, sets({ running: new Set(["l"]), draining: new Set(["l"]) })).drain).toEqual([]);
  });

  test("a lane deleted from the config drains like a disabled one", () => {
    expect(diffLanes([], sets({ running: new Set(["gone"]) })).drain).toEqual(["gone"]);
  });

  test("re-enabling a draining lane keeps it running instead of respawning", () => {
    const a = diffLanes([lane({ name: "l" })], sets({ running: new Set(["l"]), draining: new Set(["l"]) }));
    expect(a.undrain).toEqual(["l"]);
    expect(a.start).toEqual([]);
  });

  test("a finished lane is not respawned while enabled, and is rearmed by disabling", () => {
    expect(diffLanes([lane({ name: "l" })], sets({ finished: new Set(["l"]) })).start).toEqual([]);
    const a = diffLanes([lane({ name: "l", enabled: false })], sets({ finished: new Set(["l"]) }));
    expect(a.rearm).toEqual(["l"]);
    // ...after which enabling starts it again
    expect(diffLanes([lane({ name: "l" })], sets()).start.map((l) => l.name)).toEqual(["l"]);
  });

  test("a newly added enabled lane starts on the tick that sees it", () => {
    const a = diffLanes([lane({ name: "old" }), lane({ name: "new", account: "B" })], sets({ running: new Set(["old"]) }));
    expect(a.start.map((l) => l.name)).toEqual(["new"]);
  });
});

describe("the shipped fleet files", () => {
  // Durable invariants only. `fleet.json` is the LIVE file: the supervisor
  // hot-reloads it, the operator prunes and adds roster models daily, and
  // `enabled` is a steering knob — none of that may turn the suite red. What
  // is durable: the shape, the pinned accounts, the probe's leash, and the
  // lane policy (claude models only through the claude-code harness,
  // ADR-0035; shared free pools carry free ids only).
  const lanePolicy = (config: FleetConfig): void => {
    const entries = [
      ...config.jobs.flatMap((j) => j.legacy?.entries ?? []),
      ...Object.values(config.roster),
    ];
    for (const e of entries) {
      const driver = e.driver ?? "openai";
      // Parse normalises the pre-ADR-0035 spelling, so assert the parsed value.
      expect(["openai", "claude-code"]).toContain(driver);
      if (isClaudeFamily(e.model)) expect(driver).toBe("claude-code");
      if (driver === "claude-code") expect(isClaudeFamily(e.model)).toBe(true);
      if (driver === "openai" && isSharedFreePool(e.apiBase)) {
        expect(/(-free$|:free$)/.test(e.model) || isAllowlistedFree(e.model)).toBe(true);
      }
    }
  };

  test("fleet.next.json: the job shape — pinned probe, sonnet back in the roster under a concurrency cap", async () => {
    const raw = (await Bun.file(new URL("./fleet.next.json", import.meta.url).pathname).json()) as unknown;
    const config = parseFleet(raw);
    expect(config.legacyLanes).toEqual([]);
    expect(config.accounts.pinned).toEqual({ SHAKEOUT: "nav-probe-freeplay", SHAKEOUT2: "sub-opus-e90" });
    expect(config.accounts.pool).toEqual(["RUNNER", "RUNNER2", "RUNNER3", "RUNNER4", "RUNNER5", "RUNNER6"]);
    expect(config.policy.runsPerEpisode).toEqual({ e90: 3, e360: 3 });
    expect(config.maxConcurrent).toEqual({ "claude-code": 2 });
    expect(Object.keys(config.roster).length).toBeGreaterThanOrEqual(5);
    // No forced tiers: every model arrives e90-eligible and earns e360.
    for (const e of Object.values(config.roster)) expect(e.tiers).toEqual([]);
    // nav-probe: the unscored navigation probe (ADR-0033) — a roster entry with
    // an objective, 6h episodes, no-xp disabled, the only entry serving wiki
    // coords — pinned to SHAKEOUT by a looping freeplay job.
    const probe = config.roster["nav-probe"]!;
    expect(probe).toMatchObject({ model: "sonnet", driver: "claude-code", wikiCoords: true, maxToolCalls: 2500 });
    expect(probe.objective).toContain("Ironforge");
    expect(probe.watchdogs).toEqual({ episodeMs: 21_600_000, noXpMs: null, idleMs: 1_200_000 });
    for (const [n, e] of Object.entries(config.roster)) if (n !== "nav-probe") expect(e.wikiCoords).toBeUndefined();
    const pinned = pinnedJobs(config);
    expect(pinned.map((j) => [j.name, j.account, j.repeat, j.enabled])).toEqual([
      ["nav-probe-freeplay", "SHAKEOUT", "loop", true],
      ["sub-opus-e90", "SHAKEOUT2", "loop", false],
    ]);
    const lane = jobLane(pinned[0]!, config.roster, "SHAKEOUT", "20260101");
    expect(lane.entries![0]).toMatchObject({ episode: "freeplay", wikiCoords: true, maxToolCalls: 2500, watchdogs: { episodeMs: 21_600_000, noXpMs: null, idleMs: 1_200_000 } });
    // The policy never touches a pinned ref; sonnet and sonnet-low are its to schedule (ADR-0035: scored, tagged).
    expect(policyRefs(config).has("nav-probe")).toBe(false);
    expect(policyRefs(config).has("sub-opus")).toBe(false);
    expect(policyRefs(config).has("sonnet")).toBe(true);
    expect(policyRefs(config).has("sonnet-low")).toBe(true);
    expect(poolJobs(config)).toEqual([]);
    // With an empty run history every policy model is "new" and e90-only.
    const states = modelStatesOf(rosterModels(config.roster));
    expect(states.every((st) => st.status === "new" && st.eligible.join() === "e90")).toBe(true);
    lanePolicy(config);
    // The cap: with the probe up, one of sonnet/sonnet-low runs, not both.
    const plan = planTick(config, states, () => undefined, "20260101");
    expect(plan.pinned.map((p) => p.job.name)).toEqual(["nav-probe-freeplay"]);
    const claude = plan.policy.filter((p) => config.roster[p.job.ref]!.driver === "claude-code");
    expect(claude).toHaveLength(1);
    expect(plan.policy.length).toBe(6);
  });

  test("fleet.json (LIVE, pool shape with a lanes list) still loads: lanes read as pinned jobs", async () => {
    const raw = (await Bun.file(new URL("./fleet.json", import.meta.url).pathname).json()) as unknown;
    const config = parseFleet(raw);
    expect(config.legacyLanes).toEqual(["nav-probe", "sub-opus"]);
    expect(config.accounts.pinned).toEqual({ SHAKEOUT: "nav-probe", SHAKEOUT2: "sub-opus" });
    expect(config.accounts.pool).toEqual(["RUNNER", "RUNNER2", "RUNNER3", "RUNNER4", "RUNNER5", "RUNNER6"]);
    const probe = config.jobs.find((j) => j.name === "nav-probe")!;
    expect(probe).toMatchObject({ account: "SHAKEOUT", repeat: "loop", source: "legacy" });
    expect(probe.legacy).toMatchObject({ loop: true, wikiCoords: true, maxToolCalls: 2500 });
    // The raw file may still spell `claude-subscription`: a supervisor started
    // before ADR-0035 rejects `claude-code`. The parsed value is what must be right.
    for (const e of probe.legacy!.entries!) expect(e.driver).toBe("claude-code");
    lanePolicy(config);
  });

  test("fleet.prev.json (pre-pool shape) still loads: every lane pinned to its own account, no pool", async () => {
    const raw = (await Bun.file(new URL("./fleet.prev.json", import.meta.url).pathname).json()) as unknown;
    const config = parseFleet(raw);
    expect(config.legacyLanes.length).toBeGreaterThan(3);
    expect(config.accounts.pool).toEqual([]);
    expect(config.roster).toEqual({});
    for (const j of config.jobs) expect(j).toMatchObject({ source: "legacy", account: expect.any(String) });
    lanePolicy(config);
  });
});

describe("jobs, pinned and pool (ADR-0034)", () => {
  const nextShape = (over: Record<string, unknown> = {}): unknown => ({
    _notes: ["n"],
    accounts: { pinned: { SHAKEOUT: "nav-probe" }, pool: ["RUNNER", "RUNNER2", "RUNNER3"] },
    lanes: [lane({ name: "nav-probe", account: undefined as never, loop: true, entries: [{ model: "sonnet", driver: "claude-code" }] })],
    roster: {
      glm: { model: "z-ai/glm-5.2:free" },
      ox: { model: "stealth/ox-alpha", tiers: ["e90", "e360"] },
      qwen: { model: "qwen/q", driver: "openai", apiBase: "http://10.0.0.1:1234/v1", apiKeyEnv: "K", tiers: ["e90"] },
    },
    queue: [
      { ref: "glm", episode: "e90", repeat: "loop" },
      { ref: "ox", episode: "e360", repeat: 2, lane: "ox-long" },
      { ref: "qwen", episode: "e360" },
      { ref: ["glm", "qwen"], episode: "e360", lane: "pair" },
    ],
    ...over,
  });

  test("the pre-pool shape still loads: every lane is a pinned job on its own account, pool and queue are empty", () => {
    const config = parseFleet(fleetJson([lane({ name: "a", account: "RUNNER" }), lane({ name: "b", account: "RUNNER2", enabled: false })]));
    expect(config.accounts).toEqual({ pinned: { RUNNER: "a", RUNNER2: "b" }, pool: [] });
    expect(poolJobs(config)).toEqual([]);
    expect(config.roster).toEqual({});
    expect(pinnedJobs(config).map((j) => j.account)).toEqual(["RUNNER", "RUNNER2"]);
    expect(config.legacyLanes).toEqual(["a", "b"]);
  });

  test("the pool shape still loads: lanes beside accounts.pinned are pinned jobs, the vestigial `lane` field is ignored", () => {
    const config = parseFleet(nextShape());
    expect(config.legacyLanes).toEqual(["nav-probe"]);
    expect(pinnedJobs(config).map((j) => [j.name, j.account])).toEqual([["nav-probe", "SHAKEOUT"]]);
    expect(config.accounts.pool).toEqual(["RUNNER", "RUNNER2", "RUNNER3"]);
    // No tiers in the file means no force; e90 eligibility is the policy's, not the field's.
    expect(config.roster["glm"]!.tiers).toEqual([]);
    expect(config.policy).toEqual({ runsPerEpisode: { e90: 3, e360: 3 }, promoteAtLevel: 5 });
    expect(config.maxConcurrent).toEqual({});
    // Names are derived, never authored: `lane` is read and dropped.
    expect(poolJobs(config).map((j) => j.name)).toEqual(["glm-e90", "ox-e360", "qwen-e360", "glm-e360"]);
    expect(poolJobs(config)[0]).toMatchObject({ refs: ["glm"], ref: "glm", repeat: "loop", enabled: true, source: "queue" });
    expect(poolJobs(config)[2]).toMatchObject({ repeat: 1 });
    expect(poolJobs(config)[3]).toMatchObject({ refs: ["glm", "qwen"], ref: "glm+qwen" });
  });

  test("the job shape: a job with an account is pinned, accounts.pinned is derived, the probe is a roster entry", () => {
    const config = parseFleet({
      accounts: { pool: ["RUNNER", "RUNNER2"] },
      roster: {
        probe: { model: "sonnet", driver: "claude-code", objective: "walk to Ironforge", wikiCoords: true, watchdogs: { episodeMs: 21_600_000 } },
        son: { model: "sonnet", driver: "claude-code" },
        glm: { model: "z-ai/glm-5.2:free" },
      },
      policy: { maxConcurrent: { "claude-subscription": 2 } },
      queue: [
        { ref: "probe", episode: "freeplay", account: "SHAKEOUT", repeat: "loop" },
        { ref: "glm", episode: "e90", repeat: 2, lane: "ignored" },
      ],
    });
    expect(config.legacyLanes).toEqual([]);
    expect(config.accounts.pinned).toEqual({ SHAKEOUT: "probe-freeplay" });
    expect(config.maxConcurrent).toEqual({ "claude-code": 2 });
    expect(config.jobs.map((j) => [j.name, j.source])).toEqual([["probe-freeplay", "pinned"], ["glm-e90", "queue"]]);
    // The pinned job materialises exactly as a lane did: the entry's own dimensions on the tier's.
    const l = jobLane(config.jobs[0]!, config.roster, "SHAKEOUT", "20260101");
    expect(l).toMatchObject({ name: "probe-freeplay", account: "SHAKEOUT", loop: true });
    expect(fillEntries(l, l.entries!, "20260101")[0]).toMatchObject({
      runId: "fleet-probe-freeplay-sonnet-20260101",
      objective: "walk to Ironforge",
      wikiCoords: true,
      episode: "freeplay",
      watchdogs: { episodeMs: 21_600_000, idleMs: 1_200_000, noXpMs: null },
    });
    // The policy's roster: not the pinned ref, not a probe; `son` (same model, no objective) is in.
    expect([...policyRefs(config)]).toEqual(["son", "glm"]);
    expect(policyExclusion(config, "probe")).toMatch(/pinned to SHAKEOUT by job probe-freeplay/);
    expect(policyExclusion(config, "son")).toBeUndefined();
    // Guards: two enabled jobs on one account; a pinned account in the pool; a legacy map that disagrees.
    const pin = (over: Record<string, unknown>) => ({ accounts: { pool: ["RUNNER"] }, roster: { glm: { model: "z-ai/glm-5.2:free" }, ox: { model: "stealth/ox-alpha" } }, ...over });
    expect(() => parseFleet(pin({ queue: [{ ref: "glm", episode: "e90", account: "S" }, { ref: "ox", episode: "e90", account: "s" }] }))).toThrow(/shared by enabled jobs/);
    expect(parseFleet(pin({ queue: [{ ref: "glm", episode: "e90", account: "S" }, { ref: "ox", episode: "e90", account: "s", enabled: false }] })).accounts.pinned).toEqual({ S: "glm-e90" });
    expect(() => parseFleet(pin({ queue: [{ ref: "glm", episode: "e90", account: "RUNNER" }] }))).toThrow(/also pinned to job glm-e90/);
    expect(() => parseFleet(pin({ accounts: { pinned: { S: "glm-e90" }, pool: ["RUNNER"] }, queue: [{ ref: "glm", episode: "e90", account: "T" }] }))).toThrow(/disagrees/);
    expect(() => parseFleet(pin({ accounts: { pinned: { S: "glm-e90" }, pool: ["RUNNER"] }, queue: [{ ref: "glm", episode: "e90" }] }))).toThrow(/carries no account/);
    expect(() => parseFleet(pin({ queue: [{ ref: "glm", episode: "e90" }, { ref: "glm", episode: "e90" }] }))).toThrow(/share the name glm-e90/);
    expect(() => parseFleet(pin({ policy: { maxConcurrent: { warp: 1 } } }))).toThrow(/unknown driver warp/);
    expect(() => parseFleet(pin({ policy: { maxConcurrent: { openai: 0 } } }))).toThrow(/positive integer/);
  });

  test("new-shape guards: unpinned lanes, pool/pinned overlap, bad refs, bad tiers, lane collisions", () => {
    expect(() => parseFleet(nextShape({ accounts: { pinned: {}, pool: ["RUNNER"] } }))).toThrow(/nav-probe: not in accounts.pinned/);
    expect(() => parseFleet(nextShape({ accounts: { pinned: { SHAKEOUT: "nav-probe" }, pool: ["SHAKEOUT"] } }))).toThrow(/also pinned/);
    expect(() => parseFleet(nextShape({ queue: [{ ref: "nope", episode: "e90" }] }))).toThrow(/ref nope is not in roster/);
    expect(() => parseFleet(nextShape({ queue: [{ ref: "glm", episode: "e9000" }] }))).toThrow(/episode must be one of/);
    expect(() => parseFleet(nextShape({ roster: { glm: { model: "z-ai/glm-5.2:free", tiers: ["e45"] } }, queue: [] }))).toThrow(/tiers/);
    expect(() => parseFleet(nextShape({ roster: { glm: { model: "z-ai/glm-5.2:free", account: "RUNNER" } }, queue: [] }))).toThrow(/must not pin an account/);
    expect(() => parseFleet(nextShape({ queue: [{ ref: "glm", episode: "e90" }], accounts: { pinned: { SHAKEOUT: "nav-probe" }, pool: [] } }))).toThrow(/pool is empty/);
    expect(() => parseFleet(nextShape({ roster: { glm: { model: "z-ai/glm-5.2:free", runsPerEpisode: { e45: 1 } } }, queue: [] }))).toThrow(/unknown episode e45/);
    expect(() => parseFleet(nextShape({ policy: { runsPerEpisode: { e90: -1 } } }))).toThrow(/non-negative/);
    expect(parseFleet(nextShape({ policy: { runsPerEpisode: { e90: 5 } } })).policy.runsPerEpisode).toEqual({ e90: 5, e360: 3 });
    expect(() => parseFleet(nextShape({ queue: [{ ref: "glm", episode: "e90" }, { ref: "glm", episode: "e90" }] }))).toThrow(/share the name/);
    // Lane policy still applies to roster entries.
    expect(() => parseFleet(nextShape({ roster: { bad: { model: "sonnet" } }, queue: [] }))).toThrow(/lane-policy/);
    // The gate may not borrow a pool account.
    expect(() =>
      parseFleet(nextShape({ preflight: { enabled: true, account: "RUNNER", smokes: ["x.ts"] } })),
    ).toThrow(/also in accounts.pool/);
  });

  const roster: Record<string, FleetRosterEntry> = {
    glm: { model: "z-ai/glm-5.2:free", tiers: ["e90"] },
    ox: { model: "stealth/ox-alpha", tiers: ["e90", "e360"] },
    mimo: { model: "mimo-v2.5-free", tiers: ["e90"] },
  };
  const job = (over: Partial<FleetJob> & { ref: string }): FleetJob => ({
    refs: [over.ref],
    episode: "e90",
    repeat: "loop",
    name: `${over.ref}-${over.episode ?? "e90"}`,
    enabled: true,
    source: "queue",
    ...over,
  });
  const base = { roster, pool: ["RUNNER", "RUNNER2"], finished: new Set<string>(), held: () => undefined, cooling: () => undefined };

  test("pool assignment: the next runnable job takes the next FREE account, in queue and pool order", () => {
    const queue = [job({ ref: "glm" }), job({ ref: "ox" }), job({ ref: "mimo" })];
    const plan = planQueue({ ...base, queue, running: new Map() });
    expect(plan.assign.map((a) => [a.job.name, a.account])).toEqual([["glm-e90", "RUNNER"], ["ox-e90", "RUNNER2"]]);
    expect(plan.waiting.map((j) => j.name)).toEqual(["mimo-e90"]);
    // An account a running job holds, or one held live by anything (the
    // roster's account-busy inference), is not free.
    const plan2 = planQueue({ ...base, queue, running: new Map([["glm-e90", "RUNNER"]]), held: (a) => (a === "RUNNER2" ? "hand-run" : undefined) });
    expect(plan2.assign).toEqual([]);
    expect(plan2.waiting.map((j) => j.name)).toEqual(["ox-e90", "mimo-e90"]);
  });

  test("queue drains in order: as accounts come free the next jobs take them; finished jobs are not restarted", () => {
    const queue = [job({ ref: "glm", repeat: 1 }), job({ ref: "ox", repeat: 1 }), job({ ref: "mimo", repeat: 1 })];
    const running = new Map<string, string>();
    const finished = new Set<string>();
    const order: string[] = [];
    // Tick 1: two accounts, two jobs.
    let plan = planQueue({ ...base, queue, running, finished });
    for (const a of plan.assign) {
      running.set(a.job.name, a.account);
      order.push(a.job.name);
    }
    expect(order).toEqual(["glm-e90", "ox-e90"]);
    // glm exits: its account frees, mimo takes it.
    running.delete("glm-e90");
    finished.add("glm-e90");
    plan = planQueue({ ...base, queue, running, finished });
    expect(plan.assign.map((a) => [a.job.name, a.account])).toEqual([["mimo-e90", "RUNNER"]]);
    for (const a of plan.assign) running.set(a.job.name, a.account);
    // Everything running or finished: nothing to do, nothing waiting.
    plan = planQueue({ ...base, queue, running, finished });
    expect(plan.assign).toEqual([]);
    expect(plan.waiting).toEqual([]);
  });

  test("tiers gate: a job whose episode the model is not promoted into is skipped with a reason; freeplay bypasses", () => {
    const queue = [job({ ref: "glm", episode: "e360" }), job({ ref: "ox", episode: "e360" }), job({ ref: "glm", episode: "freeplay" })];
    const plan = planQueue({ ...base, queue, running: new Map() });
    expect(plan.skipped.map((s) => s.job.name)).toEqual(["glm-e360"]);
    expect(plan.skipped[0]!.reason).toMatch(/not eligible for e360/);
    expect(plan.skipped[0]!.reason).toMatch(/level 5/);
    expect(plan.assign.map((a) => a.job.name)).toEqual(["ox-e360", "glm-freeplay"]);
    // A multi-ref job runs with the promoted subset; the gated ref is dropped.
    const pair = job({ ref: "glm", refs: ["glm", "ox"], episode: "e360", name: "pair" });
    expect(runnableRefs(pair, roster)).toEqual(["ox"]);
    expect(jobLane(pair, roster, "RUNNER", "20260101").entries!.map((e) => e.model)).toEqual(["stealth/ox-alpha"]);
  });

  test("one stream per model: a ref already running under one job is not started under another", () => {
    const queue = [job({ ref: "ox", episode: "e90" }), job({ ref: "ox", episode: "e360" })];
    const plan = planQueue({ ...base, queue, running: new Map([["ox-e90", "RUNNER"]]) });
    expect(plan.skipped.map((s) => s.reason)).toEqual([expect.stringMatching(/already running under another job/)]);
  });

  test("the defer ladder is honoured: a cooling or tainted job does not take an account", () => {
    const queue = [job({ ref: "glm" }), job({ ref: "ox" })];
    const plan = planQueue({ ...base, queue, running: new Map(), cooling: (j) => (j.ref === "glm" ? "glm cooling until 03:00" : undefined) });
    expect(plan.skipped.map((s) => s.job.name)).toEqual(["glm-e90"]);
    expect(plan.assign.map((a) => [a.job.name, a.account])).toEqual([["ox-e90", "RUNNER"]]);
  });

  test("a disabled job is neither assigned nor skipped — it is simply not in the plan", () => {
    const plan = planQueue({ ...base, queue: [job({ ref: "glm", enabled: false })], running: new Map() });
    expect(plan).toEqual({ assign: [], waiting: [], skipped: [] });
  });

  test("a job becomes a lane: episode dimensions fold in, repeat n is n run ids, loop is --loop, tiers never reach the roster", () => {
    const l = jobLane(job({ ref: "ox", episode: "e360", repeat: 3, name: "ox-long" }), roster, "RUNNER2", "20260101");
    expect(l).toMatchObject({ name: "ox-long", account: "RUNNER2", loop: false, enabled: true });
    const filled = fillEntries(l, l.entries!, "20260101");
    expect(filled.map((e) => e.runId)).toEqual([
      "fleet-ox-long-ox-alpha-20260101",
      "fleet-ox-long-ox-alpha-20260101-r2",
      "fleet-ox-long-ox-alpha-20260101-r3",
    ]);
    expect(filled[0]).toMatchObject({ episode: "e360", account: "RUNNER2", maxToolCalls: 12000, watchdogs: { episodeMs: 21_600_000, idleMs: 1_200_000, noXpMs: null } });
    expect((filled[0] as Record<string, unknown>)["tiers"]).toBeUndefined();
    expect(laneArgv(jobLane(job({ ref: "ox" }), roster, "RUNNER", "20260101"), { stamp: "20260101", until: undefined })).toContain("--loop");
    expect(laneArgv(l, { stamp: "20260101", until: undefined })).not.toContain("--loop");
    // An entry's own watchdog tightening wins key by key over the tier's.
    const tight = jobLane(job({ ref: "glm" }), { glm: { model: "z-ai/glm-5.2:free", tiers: ["e90"], watchdogs: { idleMs: 60_000 } } }, "RUNNER", "20260101");
    expect(tight.entries![0]!.watchdogs).toEqual({ episodeMs: 5_400_000, idleMs: 60_000, noXpMs: 1_200_000 });
  });

  test("episode ids map to today's runner flags until the runner owns --episode", () => {
    expect(episodeDimensions("e90")).toEqual({ episode: "e90", watchdogs: { episodeMs: 5_400_000, idleMs: 1_200_000, noXpMs: 1_200_000 }, maxToolCalls: 3000 });
    expect(episodeDimensions("e360").watchdogs).toEqual({ episodeMs: 21_600_000, idleMs: 1_200_000, noXpMs: null });
    expect(episodeDimensions("freeplay").watchdogs!.episodeMs).toBeNull();
  });

  test("a pinned job and a pool job are the same thing to diffLanes: one set of drain/rearm semantics", () => {
    const config = parseFleet(nextShape());
    const pinned = jobLane(pinnedJobs(config)[0]!, config.roster, "SHAKEOUT", "20260101");
    const jobs = poolJobs(config).slice(0, 1).map((j) => jobLane(j, config.roster, "RUNNER", "20260101"));
    const sets: LaneSets = { running: new Set(), draining: new Set(), finished: new Set() };
    expect(diffLanes([pinned, ...jobs], sets).start.map((l) => [l.name, l.account])).toEqual([["nav-probe", "SHAKEOUT"], ["glm-e90", "RUNNER"]]);
    // The pinned lane finishes (exit 0): not respawned while enabled, rearmed by disabling — exactly as before.
    sets.finished.add("nav-probe");
    expect(diffLanes([pinned, ...jobs], sets).start.map((l) => l.name)).toEqual(["glm-e90"]);
    expect(diffLanes([{ ...pinned, enabled: false }, ...jobs], sets).rearm).toEqual(["nav-probe"]);
    // A running job that is disabled drains like a lane.
    sets.running.add("glm-e90");
    expect(diffLanes([pinned, { ...jobs[0]!, enabled: false }], sets).drain).toEqual(["glm-e90"]);
  });

  test("--status: the accounts table (pinned first, what runs where, free/cooling) and the queue block", () => {
    const lines = formatAccounts([
      { account: "SHAKEOUT", kind: "pinned", job: { name: "probe-freeplay", models: ["sonnet"], episode: "freeplay", runId: "fleet-probe-freeplay-sonnet-20260101", level: 5, xp: 120, elapsedMs: 3_900_000 } },
      { account: "RUNNER", kind: "pool", job: { name: "glm-e90", models: ["z-ai/glm-5.2:free"], episode: "e90", attempt: 2, runId: "r", cooling: "cooling until 03:00 (429)" } },
      { account: "RUNNER2", kind: "pool", free: true },
      { account: "RUNNER3", kind: "pool", free: true, note: "held by run x — not fleet-managed" },
    ]).join("\n");
    expect(lines).toContain("accounts: 1 pinned, 3 pool");
    expect(lines).toMatch(/SHAKEOUT +pinned +probe-freeplay: sonnet freeplay — fleet-probe-freeplay-sonnet-20260101 — L5 120xp, 1h05m/);
    expect(lines).toMatch(/RUNNER +pool +glm-e90: z-ai\/glm-5.2:free e90 attempt 2 — r — no state rows yet — cooling until 03:00/);
    expect(lines).toMatch(/RUNNER2 +pool +free$/m);
    expect(lines).toMatch(/RUNNER3 +pool +free — held by run x/);
    // The queue block exists only when a manual queue does.
    expect(formatQueue([], undefined)).toEqual([]);
    const config = parseFleet(nextShape());
    const q = formatQueue(poolJobs(config), { depth: 4, running: ["glm-e90"], waiting: ["glm-e360"], finished: [], skipped: [{ name: "qwen-e360", reason: "qwen is not promoted into e360" }] }).join("\n");
    expect(q).toContain("queue: 4 enabled manual job(s) of 4");
    expect(q).toMatch(/glm-e90 .*RUNNING/);
    expect(q).toMatch(/qwen-e360 .*skipped: qwen is not promoted/);
    expect(q).toMatch(/glm-e360 .*waiting/);
  });

  test("--status reads a pre-job supervisor's state (lanes + policy.jobs) as jobs until the restart", () => {
    const config = parseFleet(nextShape());
    const lanes = { "nav-probe": { pid: 1, account: "SHAKEOUT", rosterPath: "", jsonl: "", stdoutLog: "", spawnedAt: 0, exitCode: null, draining: false, alive: true },
      "ox-e90": { pid: 2, account: "RUNNER", rosterPath: "", jsonl: "", stdoutLog: "", spawnedAt: 0, exitCode: null, draining: false, alive: true },
      "gone": { pid: 3, account: "RUNNER2", rosterPath: "", jsonl: "", stdoutLog: "", spawnedAt: 0, exitCode: 0, draining: false, alive: false } };
    const old = liveJobsFromState({ lanes, policy: { jobs: { "ox-e90": { ref: "ox", episode: "e90", account: "RUNNER", attempt: 2 } } } }, config);
    expect([...old.keys()]).toEqual(["nav-probe", "ox-e90"]);
    expect(old.get("nav-probe")).toMatchObject({ account: "SHAKEOUT", source: "legacy", models: ["sonnet"] });
    expect(old.get("ox-e90")).toMatchObject({ ref: "ox", source: "policy", attempt: 2, models: ["stealth/ox-alpha"] });
    // A job-era state is taken as written.
    const jobs = { "glm-e90": { ref: "glm", episode: "e90" as const, account: "RUNNER", source: "queue" as const, models: ["z-ai/glm-5.2:free"] } };
    expect([...liveJobsFromState({ lanes, jobs }, config).entries()]).toEqual([["glm-e90", jobs["glm-e90"]]]);
  });

  test("planTick: pinned jobs spawn on their accounts, the queue then the policy fill the pool, per-driver cap counts the pinned stream", () => {
    const config = parseFleet({
      accounts: { pool: ["RUNNER", "RUNNER2", "RUNNER3"] },
      roster: {
        probe: { model: "sonnet", driver: "claude-code", objective: "x" },
        son: { model: "sonnet", driver: "claude-code" },
        sonlo: { model: "sonnet", driver: "claude-code", effort: "low" },
        glm: { model: "z-ai/glm-5.2:free" },
      },
      policy: { maxConcurrent: { "claude-code": 2 } },
      queue: [{ ref: "probe", episode: "freeplay", account: "SHAKEOUT", repeat: "loop" }],
    });
    const states = modelStatesOf(rosterModels(config.roster));
    const plan = planTick(config, states, () => undefined, "20260101");
    expect(plan.pinned.map((p) => [p.job.name, p.lane.account])).toEqual([["probe-freeplay", "SHAKEOUT"]]);
    expect(plan.queue.assign).toEqual([]);
    // Three free accounts, three policy models — but only one more claude-code stream fits beside the probe.
    expect(plan.policy.map((p) => [p.job.ref, p.account])).toEqual([["son", "RUNNER"], ["glm", "RUNNER2"]]);
    // Without the cap, both sonnets go.
    const uncapped = planTick({ ...config, maxConcurrent: {} }, states, () => undefined, "20260101");
    expect(uncapped.policy.map((p) => p.job.ref)).toEqual(["son", "sonlo", "glm"]);
    // A held pool account is not free; a disabled pinned job does not spawn and does not count.
    const held = planTick({ ...config, jobs: config.jobs.map((j) => ({ ...j, enabled: false })) }, states, (a) => (a === "RUNNER" ? "hand" : undefined), "20260101");
    expect(held.pinned).toEqual([]);
    expect(held.policy.map((p) => [p.job.ref, p.account])).toEqual([["son", "RUNNER2"], ["sonlo", "RUNNER3"]]);
  });

});

// ------------------------------------------------------------ ADR-0032 policy

/** The projection over an in-memory history, so no run directory is needed. */
function modelStatesOf(roster: RosterModel[], runs: RunFact[] = [], now = 1_800_000_000_000): ModelState[] {
  return modelStates({ runsDir: "/nonexistent", roster, runs, sidecar: { version: 1, cleared: {} }, now });
}

describe("scheduling policy (ADR-0032)", () => {
  const NOW = 1_800_000_000_000;
  const run = (model: string, episode: "e90" | "e360", i: number, over: Partial<RunFact> = {}): RunFact => ({
    runId: `${model}-${episode}-${i}`,
    model,
    effort: null,
    episode,
    episodeOverride: false,
    harnessVersion: null,
    startedAt: NOW - (50 - i) * 3_600_000,
    endedAt: NOW - (49 - i) * 3_600_000,
    terminationReason: "episode-limit",
    modelResponses: 20,
    bestLevel: 3,
    live: false,
    ...over,
  });
  const roster: Record<string, FleetRosterEntry> = {
    glm: { model: "z-ai/glm-5.2:free", tiers: [] },
    ox: { model: "stealth/ox-alpha", tiers: [] },
    mimo: { model: "mimo-v2.5-free", tiers: [] },
  };
  const job = (over: Partial<FleetJob> & { ref: string }): FleetJob => ({
    refs: [over.ref],
    episode: "e90",
    repeat: 1,
    name: `${over.ref}-${over.episode ?? "e90"}`,
    enabled: true,
    source: "queue",
    ...over,
  });
  const empty = { assign: [], waiting: [], skipped: [] };

  test("e90 is every model's on arrival; e360 is earned by a level-5 e90 run or forced by tiers", () => {
    const states = modelStatesOf(rosterModels(roster), [run("stealth/ox-alpha", "e90", 1, { bestLevel: 5 })]);
    const eligible = eligibleFrom(states);
    expect(eligible("glm", "e90")).toBe(true);
    expect(eligible("glm", "e360")).toBe(false);
    expect(eligible("ox", "e360")).toBe(true);
    expect(eligible("nobody", "freeplay")).toBe(true);
    // The queue's gate reads the same answer.
    const queue = [job({ ref: "glm", episode: "e360" }), job({ ref: "ox", episode: "e360" })];
    const plan = planQueue({ queue, roster, pool: ["RUNNER", "RUNNER2"], running: new Map(), finished: new Set(), held: () => undefined, cooling: () => undefined, eligible });
    expect(plan.assign.map((a) => a.job.name)).toEqual(["ox-e360"]);
    expect(plan.skipped.map((s) => s.job.name)).toEqual(["glm-e360"]);
    // Without the projection, only a forced tier opens e360.
    expect(runnableRefs(job({ ref: "glm", episode: "e360" }), roster)).toEqual([]);
    expect(runnableRefs(job({ ref: "glm", episode: "e360" }), { glm: { model: "z-ai/glm-5.2:free", tiers: ["e360"] } })).toEqual(["glm"]);
    expect(runnableRefs(job({ ref: "glm" }), roster)).toEqual(["glm"]);
  });

  test("the policy fills the accounts the queue leaves free, never while a manual job waits, never a second stream", () => {
    const states = modelStatesOf(rosterModels(roster));
    // Two accounts, one taken by a manual job: the policy gets the other.
    let picks = planPolicy({ states, pool: ["RUNNER", "RUNNER2"], running: new Map([["glm-e90", "RUNNER"]]), held: () => undefined, queuePlan: empty, runningRefs: new Set(["glm"]) });
    expect(picks.map((p) => [p.job.name, p.account, p.job.attempt])).toEqual([["ox-e90", "RUNNER2", 1]]);
    // A manual job waiting outranks the policy even with accounts free.
    picks = planPolicy({ states, pool: ["RUNNER", "RUNNER2"], running: new Map(), held: () => undefined, queuePlan: { ...empty, waiting: [job({ ref: "mimo" })] }, runningRefs: new Set() });
    expect(picks).toEqual([]);
    // Accounts the queue just assigned this tick, or held live by anything, are not free.
    picks = planPolicy({ states, pool: ["RUNNER", "RUNNER2", "RUNNER3"], running: new Map(), held: (a) => (a === "RUNNER3" ? "hand-run" : undefined), queuePlan: { ...empty, assign: [{ job: job({ ref: "glm" }), account: "RUNNER" }] }, runningRefs: new Set() });
    expect(picks.map((p) => [p.job.ref, p.account])).toEqual([["ox", "RUNNER2"]]);
  });

  test("a policy job is a one-run lane named <ref>-<episode>; attempts after the first suffix the run id", () => {
    const first = policyJob({ name: "ox", episode: "e90", account: "RUNNER", attempt: 1, why: "" });
    expect(first).toMatchObject({ refs: ["ox"], ref: "ox", episode: "e90", repeat: 1, name: "ox-e90", enabled: true, source: "policy", attempt: 1 });
    const l1 = jobLane(first, roster, "RUNNER", "20260101");
    expect(fillEntries(l1, l1.entries!, "20260101").map((e) => e.runId)).toEqual(["fleet-ox-e90-ox-alpha-20260101"]);
    expect(laneArgv(l1, { stamp: "20260101", until: undefined })).not.toContain("--loop");
    const l3 = jobLane(policyJob({ name: "ox", episode: "e360", account: "RUNNER", attempt: 3, why: "" }), roster, "RUNNER", "20260101");
    expect(fillEntries(l3, l3.entries!, "20260101")[0]).toMatchObject({ runId: "fleet-ox-e360-ox-alpha-20260101-a3", episode: "e360", maxToolCalls: 12000 });
  });

  test("priority and the ladder flow through: stillborn attempts cool a model, a promoted model gets e360 after the fresh ones", () => {
    const runs = [
      // ox: promoted, e90 target met.
      run("stealth/ox-alpha", "e90", 1, { bestLevel: 5 }),
      run("stealth/ox-alpha", "e90", 2),
      run("stealth/ox-alpha", "e90", 3),
      // glm: one stillborn attempt a minute ago -> cooling rung 1.
      run("z-ai/glm-5.2:free", "e90", 1, { modelResponses: 0, terminationReason: "adapter-error", endedAt: NOW - 30_000 }),
    ];
    const states = modelStatesOf(rosterModels(roster), runs);
    const picks = planPolicy({ states, pool: ["RUNNER", "RUNNER2", "RUNNER3"], running: new Map(), held: () => undefined, queuePlan: empty, runningRefs: new Set() });
    expect(picks.map((p) => [p.job.name, p.account])).toEqual([["mimo-e90", "RUNNER"], ["ox-e360", "RUNNER2"]]);
    const text = formatModels(states, new Set(), NOW).join("\n");
    expect(text).toMatch(/ox +promoted +3\/3 L5 +0\/3 +yes: schedulable on e360/);
    expect(text).toMatch(/glm +cooling +0\/3\+1sb L3 +- +no: cooling rung 1\/9/);
    expect(text).toMatch(/mimo +new +0\/3 +- +yes/);
    // A pinned or probe entry is outside the policy and says so instead of a verdict.
    expect(formatModels(states, new Set(), NOW, new Map([["ox", "pinned to X by job ox-freeplay"]])).join("\n")).toMatch(/ox +pinned .*no: pinned to X by job ox-freeplay/);
  });
});
