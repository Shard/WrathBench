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
  formatPool,
  jobLane,
  planQueue,
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
        lane({ name: "a", account: "SHAKEOUT", loop: true, untilDefault: "18:00", entries: [{ model: "sonnet", driver: "claude-subscription" }] }),
        lane({ name: "b", account: "RUNNER" }),
      ]),
    );
    expect(config.lanes.map((l) => l.name)).toEqual(["a", "b"]);
    expect(config.lanes[0]!.untilDefault).toBe("18:00");
  });

  test("two enabled lanes must not share an account", () => {
    expect(() =>
      parseFleet(fleetJson([lane({ name: "a", account: "RUNNER" }), lane({ name: "b", account: "runner" })])),
    ).toThrow(/shared by enabled lanes a and b/);
  });

  test("a disabled lane may sit on a running lane's account — that is the burn switch", () => {
    const config = parseFleet(
      fleetJson([lane({ name: "a", account: "SHAKEOUT" }), lane({ name: "b", account: "SHAKEOUT", enabled: false })]),
    );
    expect(config.lanes).toHaveLength(2);
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

  test("the claude-subscription driver carries claude models only", () => {
    expect(() => validateEntries(lane(), [{ model: "z-ai/glm-5.2:free", driver: "claude-subscription" }])).toThrow(
      /lane-policy/,
    );
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
    expect(r.error).toMatch(/shared by enabled lanes/);
  });

  test("a valid re-read replaces the config", () => {
    const next = JSON.stringify(fleetJson([lane({ name: "next" })]));
    const r = rereadFleet("fleet.json", good, () => next);
    expect(r.error).toBeUndefined();
    expect(r.config.lanes[0]!.name).toBe("next");
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
        { model: "sonnet", driver: "claude-subscription", effort: "low" },
        { model: "sonnet", driver: "claude-subscription", runId: "pinned" },
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

describe("the shipped fleet.json", () => {
  test("parses, honors the lane policy, and encodes the current matrix", async () => {
    const raw = (await Bun.file(new URL("./fleet.json", import.meta.url).pathname).json()) as unknown;
    const config = parseFleet(raw);
    const byName = Object.fromEntries(config.lanes.map((l) => [l.name, l]));
    // `enabled` is deliberately NOT asserted here. It is the operator's live
    // steering knob — the supervisor re-reads this file every 60s and, since
    // ADR-0020, never exits — so a lane parked at 02:00 because a provider's
    // daily quota reset is pending must not turn the test suite red. What is
    // durable is the lane-to-account map (one account per lane is the whole
    // safety property) and the driver/pool policy below.
    expect(byName["sub-sonnet"]).toMatchObject({ account: "SHAKEOUT", loop: true });
    expect(byName["sub-opus"]).toMatchObject({ account: "SHAKEOUT2" });
    // ox-alpha: the Phase-0-passing stealth model, its own account and a solo
    // lane. Free despite the suffixless id (see FREE_SUFFIXLESS_ALLOWLIST).
    expect(byName["ox-alpha"]).toMatchObject({ account: "RUNNER" });
    expect(byName["ox-alpha"].entries).toHaveLength(1);
    // Post-reset free lanes (accounts RUNNER2-RUNNER6 are in the module
    // allowlist on the reclaim image); local-qwen is LM Studio on the LAN.
    expect(byName["free-or-a"]).toMatchObject({ account: "RUNNER3" });
    expect(byName["free-or-b"]).toMatchObject({ account: "RUNNER4" });
    expect(byName["free-oc-a"]).toMatchObject({ account: "RUNNER2" });
    expect(byName["free-oc-b"]).toMatchObject({ account: "RUNNER5" });
    expect(byName["local-qwen"]).toMatchObject({ account: "RUNNER6" });
    // nav-probe: the unscored navigation probe (ADR-0024). 6h subscription
    // episodes, looping since 6443a36 so a terminated cycle does not park the
    // lane; no-xp disabled, an operator objective on the lane.
    expect(byName["nav-probe"]).toMatchObject({ account: "SHAKEOUT", loop: true });
    expect(byName["nav-probe"].objective).toContain("Ironforge"); // the objective text changes per probe episode; only the destination is pinned
    expect(byName["nav-probe"].watchdogs).toEqual({ episodeMs: 21_600_000, noXpMs: null, idleMs: 1_200_000 });
    // The coordinates tier (ADR-0028): only the unscored probe serves wiki coords.
    expect(byName["nav-probe"].wikiCoords).toBe(true);
    for (const l of config.lanes) if (l.name !== "nav-probe") expect(l.wikiCoords).toBeUndefined();
    // One account, one lane — asserted over the file as written, not just over
    // the enabled subset parseFleet already guards. The one deliberate
    // exception is nav-probe, which borrows sub-sonnet's SHAKEOUT (the module
    // allowlist is fixed at deploy time and has no spare shakeout account):
    // the two are alternatives, and parseFleet still refuses to have both
    // enabled at once.
    const accounts = config.lanes
      .filter((l) => l.name !== "nav-probe")
      .map((l) => l.account.toUpperCase());
    expect(new Set(accounts).size).toBe(accounts.length);
    for (const l of config.lanes) {
      for (const e of l.entries ?? []) {
        // Keyed on the driver, not the lane name: nav-probe is a subscription
        // lane too and the free-suffix rule below is meaningless for it.
        if (l.name.startsWith("sub-")) expect(e.driver).toBe("claude-subscription");
        else if (e.driver === "claude-subscription") expect(isClaudeFamily(e.model)).toBe(true);
        // The suffix rule applies to shared free-cloud pools, not to a
        // local/self-hosted apiBase (local-qwen) — key it on the pool, not the
        // lane name, so a future local lane with any name is judged correctly.
        // A verified-free stealth id (ox-alpha) is allowlisted despite no suffix.
        else if (isSharedFreePool(e.apiBase) && !isAllowlistedFree(e.model))
          expect(e.model).toMatch(/(-free$|:free$)/);
      }
    }
    // One stream per model config: no model appears in two lanes. The
    // objective is part of that config — sonnet-with-a-travel-objective is a
    // different stream from free-play sonnet, and the two lanes are never
    // enabled together anyway (they share an account).
    const models = config.lanes.flatMap((l) =>
      (l.entries ?? []).map((e) => `${e.model}|${e.effort ?? ""}|${e.objective ?? l.objective ?? ""}`),
    );
    expect(new Set(models).size).toBe(models.length);
  });
});

describe("resolveStatePath", () => {
  // fleet-state.json is written by a supervisor in the container and read by
  // `--status` on the host. An absolute /wrathbench/... path in that file makes
  // every existsSync on the host false, which silently empties most of the
  // report (no run id, no `last:` line, no defer rows).
  const fallback = "/repo/data/runs/fleet-a-20260822.log";

  test("a repo-relative path resolves against the local repo root", () => {
    expect(
      resolveStatePath("data/runs/fleet-a-20260822.log", fallback, (p) => p === "/repo/data/runs/fleet-a-20260822.log", "/repo"),
    ).toBe("/repo/data/runs/fleet-a-20260822.log");
  });

  test("an absolute path from an older host-side supervisor is honoured when it exists", () => {
    const host = "/home/mark/git/wrathbench/data/runs/fleet-a-20260822.log";
    expect(resolveStatePath(host, fallback, (p) => p === host, "/repo")).toBe(host);
  });

  test("a container-absolute path that does not exist here falls back to the recomputed path", () => {
    expect(resolveStatePath("/wrathbench/data/runs/fleet-a-20260822.log", fallback, () => false, "/repo")).toBe(fallback);
  });

  test("a state with no path recorded at all falls back", () => {
    expect(resolveStatePath(undefined, fallback, () => true, "/repo")).toBe(fallback);
  });
});

describe("fleetComplete", () => {
  // The fleet service runs under restart:unless-stopped, which restarts on a
  // clean exit too. Exiting because every lane happens to be disabled — the
  // documented first step of a deploy window — would restart the supervisor
  // every 60s and take a new epoch stamp each time.
  test("a deadline-bounded run still ends when nothing is left", () => {
    expect(fleetComplete({ running: 0, toStart: 0, hasDeadline: true })).toBe(true);
  });

  test("a run with no deadline idles instead of exiting", () => {
    expect(fleetComplete({ running: 0, toStart: 0, hasDeadline: false })).toBe(false);
  });

  test("work in flight or waiting is never complete either way", () => {
    expect(fleetComplete({ running: 1, toStart: 0, hasDeadline: true })).toBe(false);
    expect(fleetComplete({ running: 0, toStart: 1, hasDeadline: true })).toBe(false);
  });
});

// ------------------------------------------------------------- preflight gate

function pf(over: Partial<FleetPreflight> = {}): FleetPreflight {
  return {
    enabled: true,
    account: "SMOKE",
    smokes: [{ script: "infra/smoke/module-quest.ts", account: "SMOKE" }],
    timeoutMs: 900_000,
    deploySmokes: [],
    deployTimeoutMs: 900_000,
    ...over,
  };
}
function rec(over: Partial<PreflightRecord> = {}): PreflightRecord {
  return { at: 1000, serverIdentity: "boot:1|module=mod-wrathbench", ok: true, results: [], ...over };
}

describe("parsePreflight", () => {
  test("an absent block is a disabled gate — an older fleet.json keeps working", () => {
    expect(parsePreflight(undefined)).toEqual(DEFAULT_PREFLIGHT);
    expect(parseFleet(fleetJson([lane()])).preflight.enabled).toBe(false);
  });

  test("the pre-2026-08-23 string form parses: every script on the default account", () => {
    const p = parsePreflight({
      enabled: true,
      account: "SMOKE",
      smokes: ["infra/smoke/module-quest.ts", "infra/smoke/quest-status.ts"],
      timeoutMs: 900000,
    });
    expect(p.account).toBe("SMOKE");
    expect(p.smokes).toEqual([
      { script: "infra/smoke/module-quest.ts", account: "SMOKE" },
      { script: "infra/smoke/quest-status.ts", account: "SMOKE" },
    ]);
    expect(p.timeoutMs).toBe(900000);
    expect(p.deploySmokes).toEqual([]);
    expect(p.deployTimeoutMs).toBe(DEFAULT_PREFLIGHT.deployTimeoutMs);
  });

  test("the shipped shape parses: per-entry accounts, deploy-only smokes, both forms mixed", () => {
    const p = parsePreflight({
      enabled: true,
      account: "SMOKE",
      smokes: [
        { script: "infra/smoke/quest-accept-status.ts", account: "SMOKE" },
        { script: "infra/smoke/kill-credit.ts", account: "SMOKE2" },
        { script: "infra/smoke/no-account.ts" },
        "infra/smoke/string-form.ts",
      ],
      timeoutMs: 130000,
      deploySmokes: [{ script: "infra/smoke/module-quest.ts", account: "SMOKE" }],
      deployTimeoutMs: 600000,
    });
    expect(p.smokes.map((s) => s.account)).toEqual(["SMOKE", "SMOKE2", "SMOKE", "SMOKE"]);
    expect(p.deploySmokes).toEqual([{ script: "infra/smoke/module-quest.ts", account: "SMOKE" }]);
    expect(p.deployTimeoutMs).toBe(600000);
    expect(preflightAccounts(p)).toEqual(["SMOKE", "SMOKE2"]);
    expect(preflightAccounts(pf({ account: "A", smokes: [], deploySmokes: [{ script: "x.ts", account: "B" }] }))).toEqual(["A", "B"]);
  });

  test("enabled with no smokes is a config error, not a silently open gate", () => {
    expect(() => parsePreflight({ enabled: true, account: "SMOKE", smokes: [] })).toThrow(/no smokes/);
  });

  test("shape errors are refused", () => {
    expect(() => parsePreflight({ account: "SMOKE", smokes: [] })).toThrow(/enabled must be/);
    expect(() => parsePreflight({ enabled: false, smokes: [] })).toThrow(/account is required/);
    expect(() => parsePreflight({ enabled: false, account: "S", smokes: "x" })).toThrow(/array of script paths/);
    expect(() => parsePreflight({ enabled: false, account: "S", smokes: [], timeoutMs: 0 })).toThrow(/positive number/);
    expect(() => parsePreflight({ enabled: false, account: "S", smokes: [{ account: "X" }] })).toThrow(/needs a script path/);
    expect(() => parsePreflight({ enabled: false, account: "S", smokes: [{ script: "a.ts", account: "" }] })).toThrow(/needs an account/);
    expect(() => parsePreflight({ enabled: false, account: "S", smokes: [], deploySmokes: "x" })).toThrow(/deploySmokes must be/);
    expect(() => parsePreflight({ enabled: false, account: "S", smokes: [], deployTimeoutMs: -1 })).toThrow(/deployTimeoutMs/);
  });

  test("the gate account may not be an enabled lane's — they would evict each other", () => {
    const withPf = (lanes: unknown[], preflight: unknown) => ({ _notes: [], lanes, preflight });
    expect(() =>
      parseFleet(withPf([lane({ account: "SMOKE" })], { enabled: true, account: "smoke", smokes: ["a.ts"] })),
    ).toThrow(/needs its own account/);
    // Every per-entry account is checked, not just the default one.
    expect(() =>
      parseFleet(
        withPf([lane({ account: "SMOKE2" })], { enabled: true, account: "SMOKE", smokes: [{ script: "a.ts", account: "smoke2" }] }),
      ),
    ).toThrow(/smoke2 is also lane/);
    expect(() =>
      parseFleet(withPf([lane({ account: "SMOKE9" })], { enabled: true, account: "SMOKE", smokes: ["a.ts"], deploySmokes: [{ script: "b.ts", account: "SMOKE9" }] })),
    ).toThrow(/SMOKE9 is also lane/);
    // Disabled gate, or a disabled lane, is no clash.
    expect(() =>
      parseFleet(withPf([lane({ account: "SMOKE", enabled: false })], { enabled: true, account: "SMOKE", smokes: ["a.ts"] })),
    ).not.toThrow();
  });
});

describe("runPreflight fan-out", () => {
  const server = { identity: "boot:1|module=x", ready: true } as Parameters<typeof runPreflight>[1];
  /** A mock runner that records start order and overlap, and sleeps `ms` per script. */
  function mockRunner(plan: Record<string, { ms: number; ok: boolean }>) {
    const started: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const run = async (smoke: PreflightSmoke, deadline: number) => {
      started.push(`${smoke.script}@${smoke.account}`);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const p = plan[smoke.script] ?? { ms: 1, ok: true };
      await Bun.sleep(p.ms);
      inFlight--;
      expect(deadline).toBeGreaterThan(Date.now() - 1);
      return { script: smoke.script, ok: p.ok, ms: p.ms, tail: p.ok ? "PASS" : "FAIL" };
    };
    return { run, started, max: () => maxInFlight };
  }

  test("distinct accounts run concurrently; results come back in config order", async () => {
    const m = mockRunner({ "a.ts": { ms: 40, ok: true }, "b.ts": { ms: 10, ok: true } });
    const p = pf({
      smokes: [
        { script: "a.ts", account: "SMOKE" },
        { script: "b.ts", account: "SMOKE2" },
      ],
    });
    const t0 = Date.now();
    const r = await runPreflight(p, server, m.run);
    expect(Date.now() - t0).toBeLessThan(80);
    expect(m.max()).toBe(2);
    expect(r.ok).toBe(true);
    expect(r.results.map((x) => x.script)).toEqual(["a.ts", "b.ts"]);
  });

  test("a shared account serialises, and a failure stops only that account's chain", async () => {
    const m = mockRunner({ "a.ts": { ms: 5, ok: false }, "b.ts": { ms: 5, ok: true }, "c.ts": { ms: 5, ok: true } });
    const p = pf({
      smokes: [
        { script: "a.ts", account: "SMOKE" },
        { script: "b.ts", account: "smoke" },
        { script: "c.ts", account: "SMOKE2" },
      ],
    });
    const r = await runPreflight(p, server, m.run);
    expect(r.ok).toBe(false);
    expect(m.started).toEqual(expect.arrayContaining(["a.ts@SMOKE", "c.ts@SMOKE2"]));
    expect(m.started).not.toContain("b.ts@smoke");
    expect(r.results.map((x) => [x.script, x.ok])).toEqual([
      ["a.ts", false],
      ["b.ts", false],
      ["c.ts", true],
    ]);
    expect(r.results[1]!.tail).toMatch(/not run: an earlier smoke on account smoke failed/);
  });

  test("every child gets the one shared deadline, and the record carries the server identity", async () => {
    const seen: number[] = [];
    const run = async (smoke: PreflightSmoke, deadline: number) => {
      seen.push(deadline);
      return { script: smoke.script, ok: true, ms: 1, tail: "" };
    };
    const p = pf({ timeoutMs: 5000, smokes: [{ script: "a.ts", account: "A" }, { script: "b.ts", account: "B" }] });
    const r = await runPreflight(p, { ...server, build: "b1" }, run, () => 1_000_000);
    expect(seen).toEqual([1_005_000, 1_005_000]);
    expect(r).toMatchObject({ at: 1_000_000, serverIdentity: "boot:1|module=x", build: "b1", ok: true });
  });
});

describe("server identity", () => {
  test("the live log's creation time is the boot marker", () => {
    expect(bootMarker(1787396829400.96, ["Server.log", "Server.log.2026-08-22 11-07-09"], 5)).toBe("boot:1787396829401");
  });

  test("a new boot changes it", () => {
    expect(bootMarker(1, [], 0)).not.toBe(bootMarker(2, [], 0));
  });

  test("without birthtime it falls back to the rotated backups", () => {
    expect(bootMarker(0, ["Server.log", "Server.log.2026-08-21 13-17-30", "Server.log.2026-08-22 11-07-09"], 5)).toBe(
      "logs:2:Server.log.2026-08-22 11-07-09",
    );
  });

  test("an unreadable log dir fails toward re-gating, not toward a frozen identity", () => {
    const a = bootMarker(undefined, undefined, 0);
    const b = bootMarker(undefined, undefined, 11 * 60_000);
    expect(a).toStartWith("unknown:");
    expect(a).not.toBe(b);
  });

  test("health digest ignores live telemetry and keeps the stable fields", () => {
    const base = { ok: true, module: "mod-wrathbench", worldStopped: false, sessions: 3, droppedPackets: 9 };
    expect(healthDigest(base)).toBe(healthDigest({ ...base, sessions: 41, droppedPackets: 12, worldStopped: true }));
    expect(healthDigest(base)).not.toBe(healthDigest({ ...base, build: "abc123" }));
    // uptime ticks every call; it must not re-gate the same boot.
    expect(healthDigest({ ...base, uptimeMs: 1 })).toBe(healthDigest({ ...base, uptimeMs: 99_999 }));
  });

  test("build + startedAtMs name the server outright; the boot marker is not even read", () => {
    let markerReads = 0;
    const marker = () => {
      markerReads++;
      return "boot:1";
    };
    const body = { ok: true, module: "mod-wrathbench", worldStopped: false, build: "harness-0.3-41-gabc123", startedAtMs: 1787400000000.4, uptimeMs: 5 };
    expect(serverIdentity(body, marker)).toEqual({ identity: "build:harness-0.3-41-gabc123@1787400000000", build: "harness-0.3-41-gabc123" });
    expect(markerReads).toBe(0);
    // Same build, new boot -> new identity (a restart re-gates).
    expect(serverIdentity({ ...body, startedAtMs: 1787400001000 }, marker).identity).not.toBe(serverIdentity(body, marker).identity);
    // "unknown" is still a build stamp: the boot is what the identity keys on.
    expect(serverIdentity({ ...body, build: "unknown" }, marker).build).toBe("unknown");
  });

  test("a module without the build field falls back to boot marker + digest", () => {
    const body = { ok: true, module: "mod-wrathbench", worldStopped: false, sessions: 2, droppedPackets: 1, droppedPacketsLive: 0 };
    const r = serverIdentity(body, () => "boot:1787396829401");
    expect(r).toEqual({ identity: "boot:1787396829401|module=mod-wrathbench" });
    expect(r.build).toBeUndefined();
    // A build with no startedAtMs (or an empty one) is not trusted as an identity.
    expect(serverIdentity({ ...body, build: "" , startedAtMs: 5 }, () => "boot:1").identity.startsWith("boot:1|")).toBe(true);
    expect(serverIdentity({ ...body, build: "x" }, () => "boot:1").identity.startsWith("boot:1|")).toBe(true);
  });
});

describe("gateDecision", () => {
  test("disabled skips — the mechanism stays installed and the gate stays open", () => {
    expect(gateDecision({ enabled: false, identity: "i", last: undefined })).toBe("skip");
    expect(gateOpen("skip", undefined)).toBe(true);
  });

  test("an unreachable or stopping server is waited on, not smoked", () => {
    expect(gateDecision({ enabled: true, identity: undefined, last: rec() })).toBe("wait");
    expect(gateOpen("wait", rec())).toBe(false);
  });

  test("no record yet: run the smokes before anything spawns", () => {
    expect(gateDecision({ enabled: true, identity: "i", last: undefined })).toBe("run");
  });

  test("a pass for this identity spawns once and is not re-run", () => {
    const last = rec({ serverIdentity: "i" });
    expect(gateDecision({ enabled: true, identity: "i", last })).toBe("pass");
    expect(gateOpen("pass", last)).toBe(true);
  });

  test("an identity change re-gates", () => {
    expect(gateDecision({ enabled: true, identity: "i2", last: rec({ serverIdentity: "i" }) })).toBe("run");
  });

  test("a failure blocks spawning and is re-checked every tick so a fix unblocks it", () => {
    const failed = rec({ serverIdentity: "i", ok: false });
    expect(gateDecision({ enabled: true, identity: "i", last: failed })).toBe("run");
    expect(gateOpen("run", failed)).toBe(false);
    expect(gateOpen("run", rec({ serverIdentity: "i" }))).toBe(true);
  });

  test("a skipped record never counts as a pass once the gate is armed", () => {
    expect(gateDecision({ enabled: true, identity: "i", last: rec({ serverIdentity: "i", skipped: true }) })).toBe("run");
  });
});

describe("gate record and rendering", () => {
  test("the record carries what a deploy needs: when, against what, and per-script detail", () => {
    const r = rec({
      at: 1_700_000_000_000,
      ok: false,
      results: [
        { script: "infra/smoke/module-quest.ts", ok: true, ms: 61_000, tail: "done" },
        { script: "infra/smoke/quest-status.ts", ok: false, ms: 2_000, tail: "FAIL: unsupported_action" },
      ],
    });
    expect(Object.keys(r).sort()).toEqual(["at", "ok", "results", "serverIdentity"]);
    const out = formatGate(r, pf()).join("\n");
    expect(out).toContain("FAIL — lanes blocked");
    expect(out).not.toContain("server build");
    expect(formatGate({ ...r, build: "harness-0.3-41-gabc123" }, pf()).join("\n")).toContain("server build harness-0.3-41-gabc123");
    expect(out).toContain("FAIL infra/smoke/quest-status.ts (2s)");
    expect(out).toContain("unsupported_action");
  });

  test("status renders the disabled case and the never-run case", () => {
    expect(formatGate(undefined, pf({ enabled: false })).join("\n")).toContain("preflight disabled");
    expect(formatGate(undefined, pf()).join("\n")).toContain("no gate result recorded yet");
    expect(formatGate(rec({ skipped: true }), pf({ enabled: false })).join("\n")).toContain("SKIPPED (gate open)");
  });

  test("tails are the last lines, bounded", () => {
    expect(tailOf("a\nb\n\nc\n")).toBe("a | b | c");
    expect(tailOf("x".repeat(900)).length).toBe(500);
  });

  test("smoke paths resolve against the repo, absolutes pass through", () => {
    expect(smokePath("infra/smoke/module-quest.ts", "/wrathbench")).toBe("/wrathbench/infra/smoke/module-quest.ts");
    expect(smokePath("/tmp/s.ts", "/wrathbench")).toBe("/tmp/s.ts");
  });
});

/**
 * Lane-level run dimensions (ADR-0024): a lane may default an objective, a
 * watchdog override and a tool-call ceiling for every entry it carries.
 */
describe("lane-level run dimensions", () => {
  const OBJECTIVE = "Travel to the nearest capital city.";

  test("a lane default reaches every entry that does not set its own", () => {
    const l = lane({
      objective: OBJECTIVE,
      watchdogs: { noXpMs: null, episodeMs: 21_600_000 },
      maxToolCalls: 2500,
      entries: [{ model: "a:free" }, { model: "b:free", objective: "Something else", maxToolCalls: 10 }],
    });
    const filled = fillEntries(l, l.entries!, "20260101");
    expect(filled[0]).toMatchObject({
      objective: OBJECTIVE,
      watchdogs: { noXpMs: null, episodeMs: 21_600_000 },
      maxToolCalls: 2500,
    });
    // Entry wins over the lane, key by key.
    expect(filled[1]).toMatchObject({ objective: "Something else", maxToolCalls: 10 });
  });

  test("wikiCoords (ADR-0028) defaults from the lane, entry wins, and must be a boolean", () => {
    const l = lane({ wikiCoords: true, entries: [{ model: "a:free" }, { model: "b:free", wikiCoords: false }] });
    const filled = fillEntries(l, l.entries!, "20260101");
    expect(filled[0]!.wikiCoords).toBe(true);
    expect(filled[1]!.wikiCoords).toBe(false);
    expect(fillEntries(lane(), lane().entries!, "20260101")[0]!.wikiCoords).toBeUndefined();
    expect(parseFleet(fleetJson([lane({ wikiCoords: true })])).lanes[0]!.wikiCoords).toBe(true);
    expect(() => parseFleet(fleetJson([lane({ wikiCoords: "yes" as never })]))).toThrow(/wikiCoords/);
    expect(() =>
      parseFleet(fleetJson([lane({ entries: [{ model: "a:free", wikiCoords: 1 as never }] })])),
    ).toThrow(/wikiCoords/);
  });

  test("entry watchdogs merge onto the lane's rather than replacing them", () => {
    const l = lane({
      watchdogs: { noXpMs: null, episodeMs: 21_600_000 },
      entries: [{ model: "a:free", watchdogs: { idleMs: 60_000 } }],
    });
    expect(fillEntries(l, l.entries!, "20260101")[0]!.watchdogs).toEqual({
      noXpMs: null,
      episodeMs: 21_600_000,
      idleMs: 60_000,
    });
  });

  test("a lane with none of them is untouched", () => {
    const l = lane();
    const filled = fillEntries(l, l.entries!, "20260101")[0]!;
    expect(filled.objective).toBeUndefined();
    expect(filled.watchdogs).toBeUndefined();
    expect(filled.maxToolCalls).toBeUndefined();
  });

  test("malformed dimensions are refused, naming the lane", () => {
    expect(() => parseFleet(fleetJson([lane({ objective: "" })]))).toThrow(/objective/);
    expect(() => parseFleet(fleetJson([lane({ watchdogs: { noXpMS: 1 } as never })]))).toThrow(/watchdogs/);
    expect(() => parseFleet(fleetJson([lane({ maxToolCalls: 0 })]))).toThrow(/maxToolCalls/);
    expect(() =>
      parseFleet(fleetJson([lane({ entries: [{ model: "a:free", watchdogs: { idleMs: -5 } }] })])),
    ).toThrow(/watchdogs/);
  });
});

/**
 * The 2026-08-22 incident: a config the running supervisor could not parse kept
 * the last good config (by design), a later edit disabling every lane was
 * therefore inert for seven hours, and `--status` said nothing about it. What
 * follows is the state and the banner that make that condition impossible to
 * miss.
 */
describe("config rejection", () => {
  test("the first failure stamps `since`, later failures keep it", () => {
    const first = nextConfigRejection(undefined, { error: "bad shape", mtime: 10 }, 1_000)!;
    expect(first).toEqual({ since: 1_000, error: "bad shape", mtime: 10 });
    const second = nextConfigRejection(first, { error: "still bad", mtime: 20 }, 9_000)!;
    expect(second.since).toBe(1_000);
    expect(second.error).toBe("still bad");
    expect(second.mtime).toBe(20);
  });

  test("a successful re-read clears it", () => {
    const rej: ConfigRejection = { since: 1_000, error: "bad", mtime: 10 };
    expect(nextConfigRejection(rej, { mtime: 30 }, 9_000)).toBeUndefined();
  });

  test("the banner names the time, the error, and that the file is not in effect", () => {
    const out = formatConfigBanner({ since: 1_700_000_000_000, error: "preflight.smokes[0]", mtime: 5 }, 1_699_000_000_000).join(
      "\n",
    );
    expect(out).toContain("fleet.json REJECTED since");
    expect(out).toContain(new Date(1_700_000_000_000).toLocaleString());
    expect(out).toContain("preflight.smokes[0]");
    expect(out).toContain("running on config loaded at " + new Date(1_699_000_000_000).toLocaleString());
    expect(out).toContain("NOT in effect");
  });

  test("no rejection means no banner, and a missing load time degrades", () => {
    expect(formatConfigBanner(undefined, 1)).toEqual([]);
    expect(formatConfigBanner({ since: 1, error: "e", mtime: 2 }, undefined).join("\n")).toContain(
      "an unrecorded time",
    );
  });

  test("a status reader gets an error back instead of throwing on a broken file", () => {
    expect(loadConfigForRead("fleet.json", () => "{not json").error).toBeDefined();
    expect(loadConfigForRead("fleet.json", () => "{not json").config).toBeUndefined();
    const dupe = JSON.stringify(fleetJson([lane({ name: "a", account: "X" }), lane({ name: "b", account: "X" })]));
    expect(loadConfigForRead("fleet.json", () => dupe).error).toMatch(/shared by enabled lanes/);
    const ok = JSON.stringify(fleetJson([lane({ name: "one" })]));
    expect(loadConfigForRead("fleet.json", () => ok).config!.lanes[0]!.name).toBe("one");
  });
});

// ------------------------------------------------------------ ADR-0031 pool + queue

describe("pool and queue (ADR-0031)", () => {
  const nextShape = (over: Record<string, unknown> = {}): unknown => ({
    _notes: ["n"],
    accounts: { pinned: { SHAKEOUT: "nav-probe" }, pool: ["RUNNER", "RUNNER2", "RUNNER3"] },
    lanes: [lane({ name: "nav-probe", account: undefined as never, loop: true, entries: [{ model: "sonnet", driver: "claude-subscription" }] })],
    roster: {
      glm: { model: "z-ai/glm-5.2:free" },
      ox: { model: "stealth/ox-alpha", tiers: ["e90", "e360"] },
      qwen: { model: "qwen/q", driver: "openai", apiBase: "http://10.0.0.1:1234/v1", apiKeyEnv: "K", tiers: ["e90"] },
    },
    queue: [
      { ref: "glm", episode: "e90", repeat: "loop" },
      { ref: "ox", episode: "e360", repeat: 2, lane: "ox-long" },
      { ref: "qwen", episode: "e360" },
      { ref: ["glm", "qwen"], episode: "e90", lane: "pair" },
    ],
    ...over,
  });

  test("the OLD shape still loads: every lane is implicitly pinned, pool and queue are empty", () => {
    const config = parseFleet(fleetJson([lane({ name: "a", account: "RUNNER" }), lane({ name: "b", account: "RUNNER2", enabled: false })]));
    expect(config.accounts).toEqual({ pinned: { RUNNER: "a", RUNNER2: "b" }, pool: [] });
    expect(config.queue).toEqual([]);
    expect(config.roster).toEqual({});
    expect(config.lanes.map((l) => l.account)).toEqual(["RUNNER", "RUNNER2"]);
  });

  test("the new shape loads: lane accounts come from accounts.pinned, refs normalise, defaults apply", () => {
    const config = parseFleet(nextShape());
    expect(config.lanes[0]!.account).toBe("SHAKEOUT");
    expect(config.accounts.pool).toEqual(["RUNNER", "RUNNER2", "RUNNER3"]);
    expect(config.roster["glm"]!.tiers).toEqual(["e90"]);
    expect(config.queue.map((j) => j.lane)).toEqual(["glm-e90", "ox-long", "qwen-e360", "pair"]);
    expect(config.queue[0]).toMatchObject({ refs: ["glm"], ref: "glm", repeat: "loop", enabled: true });
    expect(config.queue[2]).toMatchObject({ repeat: 1 });
    expect(config.queue[3]).toMatchObject({ refs: ["glm", "qwen"], ref: "glm+qwen" });
  });

  test("new-shape guards: unpinned lanes, pool/pinned overlap, bad refs, bad tiers, lane collisions", () => {
    expect(() => parseFleet(nextShape({ accounts: { pinned: {}, pool: ["RUNNER"] } }))).toThrow(/nav-probe: not in accounts.pinned/);
    expect(() => parseFleet(nextShape({ accounts: { pinned: { SHAKEOUT: "nav-probe" }, pool: ["SHAKEOUT"] } }))).toThrow(/also pinned/);
    expect(() => parseFleet(nextShape({ queue: [{ ref: "nope", episode: "e90" }] }))).toThrow(/ref nope is not in roster/);
    expect(() => parseFleet(nextShape({ queue: [{ ref: "glm", episode: "e9000" }] }))).toThrow(/episode must be one of/);
    expect(() => parseFleet(nextShape({ roster: { glm: { model: "z-ai/glm-5.2:free", tiers: ["e45"] } }, queue: [] }))).toThrow(/tiers/);
    expect(() => parseFleet(nextShape({ roster: { glm: { model: "z-ai/glm-5.2:free", account: "RUNNER" } }, queue: [] }))).toThrow(/must not pin an account/);
    expect(() => parseFleet(nextShape({ queue: [{ ref: "glm", episode: "e90", lane: "nav-probe" }] }))).toThrow(/collides with a pinned lane/);
    expect(() => parseFleet(nextShape({ queue: [{ ref: "glm", episode: "e90" }, { ref: "glm", episode: "e90" }] }))).toThrow(/share lane name/);
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
    lane: `${over.ref}-${over.episode ?? "e90"}`,
    enabled: true,
    ...over,
  });
  const base = { roster, pool: ["RUNNER", "RUNNER2"], finished: new Set<string>(), held: () => undefined, cooling: () => undefined };

  test("pool assignment: the next runnable job takes the next FREE account, in queue and pool order", () => {
    const queue = [job({ ref: "glm" }), job({ ref: "ox" }), job({ ref: "mimo" })];
    const plan = planQueue({ ...base, queue, running: new Map() });
    expect(plan.assign.map((a) => [a.job.lane, a.account])).toEqual([["glm-e90", "RUNNER"], ["ox-e90", "RUNNER2"]]);
    expect(plan.waiting.map((j) => j.lane)).toEqual(["mimo-e90"]);
    // An account a running job holds, or one held live by anything (the
    // roster's account-busy inference), is not free.
    const plan2 = planQueue({ ...base, queue, running: new Map([["glm-e90", "RUNNER"]]), held: (a) => (a === "RUNNER2" ? "hand-run" : undefined) });
    expect(plan2.assign).toEqual([]);
    expect(plan2.waiting.map((j) => j.lane)).toEqual(["ox-e90", "mimo-e90"]);
  });

  test("queue drains in order: as accounts come free the next jobs take them; finished jobs are not restarted", () => {
    const queue = [job({ ref: "glm", repeat: 1 }), job({ ref: "ox", repeat: 1 }), job({ ref: "mimo", repeat: 1 })];
    const running = new Map<string, string>();
    const finished = new Set<string>();
    const order: string[] = [];
    // Tick 1: two accounts, two jobs.
    let plan = planQueue({ ...base, queue, running, finished });
    for (const a of plan.assign) {
      running.set(a.job.lane, a.account);
      order.push(a.job.lane);
    }
    expect(order).toEqual(["glm-e90", "ox-e90"]);
    // glm exits: its account frees, mimo takes it.
    running.delete("glm-e90");
    finished.add("glm-e90");
    plan = planQueue({ ...base, queue, running, finished });
    expect(plan.assign.map((a) => [a.job.lane, a.account])).toEqual([["mimo-e90", "RUNNER"]]);
    for (const a of plan.assign) running.set(a.job.lane, a.account);
    // Everything running or finished: nothing to do, nothing waiting.
    plan = planQueue({ ...base, queue, running, finished });
    expect(plan.assign).toEqual([]);
    expect(plan.waiting).toEqual([]);
  });

  test("tiers gate: a job whose episode the model is not promoted into is skipped with a reason; freeplay bypasses", () => {
    const queue = [job({ ref: "glm", episode: "e360" }), job({ ref: "ox", episode: "e360" }), job({ ref: "glm", episode: "freeplay" })];
    const plan = planQueue({ ...base, queue, running: new Map() });
    expect(plan.skipped.map((s) => s.job.lane)).toEqual(["glm-e360"]);
    expect(plan.skipped[0]!.reason).toMatch(/not promoted into e360/);
    expect(plan.skipped[0]!.reason).toMatch(/operator decision/);
    expect(plan.assign.map((a) => a.job.lane)).toEqual(["ox-e360", "glm-freeplay"]);
    // A multi-ref job runs with the promoted subset; the gated ref is dropped.
    const pair = job({ ref: "glm", refs: ["glm", "ox"], episode: "e360", lane: "pair" });
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
    expect(plan.skipped.map((s) => s.job.lane)).toEqual(["glm-e90"]);
    expect(plan.assign.map((a) => [a.job.lane, a.account])).toEqual([["ox-e90", "RUNNER"]]);
  });

  test("a disabled job is neither assigned nor skipped — it is simply not in the plan", () => {
    const plan = planQueue({ ...base, queue: [job({ ref: "glm", enabled: false })], running: new Map() });
    expect(plan).toEqual({ assign: [], waiting: [], skipped: [] });
  });

  test("a job becomes a lane: episode dimensions fold in, repeat n is n run ids, loop is --loop, tiers never reach the roster", () => {
    const l = jobLane(job({ ref: "ox", episode: "e360", repeat: 3, lane: "ox-long" }), roster, "RUNNER2", "20260101");
    expect(l).toMatchObject({ name: "ox-long", account: "RUNNER2", loop: false, enabled: true });
    const filled = fillEntries(l, l.entries!, "20260101");
    expect(filled.map((e) => e.runId)).toEqual([
      "fleet-ox-long-ox-alpha-20260101",
      "fleet-ox-long-ox-alpha-20260101-r2",
      "fleet-ox-long-ox-alpha-20260101-r3",
    ]);
    expect(filled[0]).toMatchObject({ episode: "e360", account: "RUNNER2", maxToolCalls: 2000, watchdogs: { episodeMs: 21_600_000, idleMs: 1_200_000, noXpMs: null } });
    expect((filled[0] as Record<string, unknown>)["tiers"]).toBeUndefined();
    expect(laneArgv(jobLane(job({ ref: "ox" }), roster, "RUNNER", "20260101"), { stamp: "20260101", until: undefined })).toContain("--loop");
    expect(laneArgv(l, { stamp: "20260101", until: undefined })).not.toContain("--loop");
    // An entry's own watchdog tightening wins key by key over the tier's.
    const tight = jobLane(job({ ref: "glm" }), { glm: { model: "z-ai/glm-5.2:free", tiers: ["e90"], watchdogs: { idleMs: 60_000 } } }, "RUNNER", "20260101");
    expect(tight.entries![0]!.watchdogs).toEqual({ episodeMs: 5_400_000, idleMs: 60_000, noXpMs: 1_200_000 });
  });

  test("episode ids map to today's runner flags until the runner owns --episode", () => {
    expect(episodeDimensions("e90")).toEqual({ episode: "e90", watchdogs: { episodeMs: 5_400_000, idleMs: 1_200_000, noXpMs: 1_200_000 }, maxToolCalls: 500 });
    expect(episodeDimensions("e360").watchdogs).toEqual({ episodeMs: 21_600_000, idleMs: 1_200_000, noXpMs: null });
    expect(episodeDimensions("freeplay").watchdogs!.episodeMs).toBeNull();
  });

  test("pinned lanes are unaffected: diffLanes over pinned + job lanes keeps the old semantics", () => {
    const config = parseFleet(nextShape());
    const pinned = config.lanes[0]!;
    const jobs = config.queue.slice(0, 1).map((j) => jobLane(j, config.roster, "RUNNER", "20260101"));
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

  test("--status renders accounts (pinned vs pool, what runs where) and queue depth", () => {
    const config = parseFleet(nextShape());
    const lines = formatPool(config, {
      accounts: { pinned: { SHAKEOUT: "nav-probe" }, pool: { RUNNER: "glm-e90", RUNNER2: null, RUNNER3: null } },
      queue: { depth: 4, running: ["glm-e90"], waiting: ["pair"], finished: [], skipped: [{ lane: "qwen-e360", reason: "qwen is not promoted into e360" }] },
    }).join("\n");
    expect(lines).toContain("SHAKEOUT  pinned -> lane nav-probe");
    expect(lines).toContain("RUNNER    pool   -> job glm-e90");
    expect(lines).toContain("RUNNER2   pool   free");
    expect(lines).toContain("queue: 4 enabled job(s) of 4");
    expect(lines).toMatch(/glm-e90 .*RUNNING/);
    expect(lines).toMatch(/qwen-e360 .*skipped: qwen is not promoted/);
    expect(lines).toMatch(/pair .*waiting/);
  });

  test("the shipped fleet.next.json is today's fleet under the new schema", async () => {
    const raw = (await Bun.file(new URL("./fleet.next.json", import.meta.url).pathname).json()) as unknown;
    const config = parseFleet(raw);
    expect(config.accounts.pinned).toEqual({ SHAKEOUT: "nav-probe", SHAKEOUT2: "sub-opus" });
    expect(config.accounts.pool).toEqual(["RUNNER", "RUNNER2", "RUNNER3", "RUNNER4", "RUNNER5", "RUNNER6"]);
    const byLane = Object.fromEntries(config.queue.map((j) => [j.lane, j]));
    for (const name of ["ox-alpha", "free-or-a", "free-or-b", "free-oc-a", "free-oc-b", "local-qwen"]) {
      expect(byLane[name]).toMatchObject({ episode: "e90", repeat: "loop", enabled: true });
    }
    // Same run ids as today's lanes produce, so the switch is invisible to the eval surface.
    const ox = jobLane(byLane["ox-alpha"]!, config.roster, "RUNNER", "20260823");
    expect(fillEntries(ox, ox.entries!, "20260823")[0]!.runId).toBe("fleet-ox-alpha-ox-alpha-20260823");
    // Every model is e90-only; the e360 jobs exist, disabled, and would be tier-gated if enabled.
    for (const e of Object.values(config.roster)) expect(e.tiers).toEqual(["e90"]);
    expect(byLane["sonnet-e360"]).toMatchObject({ episode: "e360", enabled: false });
    expect(byLane["qwen-e360"]).toMatchObject({ episode: "e360", enabled: false });
    const forced = config.queue.map((j) => (j.episode === "e360" ? { ...j, enabled: true } : j));
    const plan = planQueue({ queue: forced, roster: config.roster, pool: config.accounts.pool, running: new Map(), finished: new Set(), held: () => undefined, cooling: () => undefined });
    expect(plan.skipped.map((s) => s.job.lane).sort()).toEqual(["qwen-e360", "sonnet-e360"]);
    // The nav-probe lane is byte-for-byte the pinned lane of today.
    const nav = config.lanes.find((l) => l.name === "nav-probe")!;
    expect(nav).toMatchObject({ account: "SHAKEOUT", loop: true, wikiCoords: true, maxToolCalls: 2500 });
    expect(nav.watchdogs).toEqual({ episodeMs: 21_600_000, noXpMs: null, idleMs: 1_200_000 });
  });
});
