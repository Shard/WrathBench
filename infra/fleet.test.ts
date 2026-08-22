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
  validateEntries,
  type FleetConfig,
  type FleetLane,
  type FleetPreflight,
  type LaneSets,
  type PreflightRecord,
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
    // One account, one lane — asserted over the file as written, not just over
    // the enabled subset parseFleet already guards.
    const accounts = config.lanes.map((l) => l.account.toUpperCase());
    expect(new Set(accounts).size).toBe(accounts.length);
    for (const l of config.lanes) {
      for (const e of l.entries ?? []) {
        if (l.name.startsWith("sub-")) expect(e.driver).toBe("claude-subscription");
        // The suffix rule applies to shared free-cloud pools, not to a
        // local/self-hosted apiBase (local-qwen) — key it on the pool, not the
        // lane name, so a future local lane with any name is judged correctly.
        // A verified-free stealth id (ox-alpha) is allowlisted despite no suffix.
        else if (isSharedFreePool(e.apiBase) && !isAllowlistedFree(e.model))
          expect(e.model).toMatch(/(-free$|:free$)/);
      }
    }
    // One stream per model config: no model appears in two lanes.
    const models = config.lanes.flatMap((l) => (l.entries ?? []).map((e) => `${e.model}|${e.effort ?? ""}`));
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
  return { enabled: true, account: "SMOKE", smokes: ["infra/smoke/module-quest.ts"], timeoutMs: 900_000, ...over };
}
function rec(over: Partial<PreflightRecord> = {}): PreflightRecord {
  return { at: 1000, serverIdentity: "boot:1|module=mod-wrathbench", ok: true, results: [], ...over };
}

describe("parsePreflight", () => {
  test("an absent block is a disabled gate — an older fleet.json keeps working", () => {
    expect(parsePreflight(undefined)).toEqual(DEFAULT_PREFLIGHT);
    expect(parseFleet(fleetJson([lane()])).preflight.enabled).toBe(false);
  });

  test("the shipped shape parses", () => {
    const p = parsePreflight({
      enabled: true,
      account: "SMOKE",
      smokes: ["infra/smoke/module-quest.ts", "infra/smoke/quest-status.ts"],
      timeoutMs: 900000,
    });
    expect(p.account).toBe("SMOKE");
    expect(p.smokes).toHaveLength(2);
    expect(p.timeoutMs).toBe(900000);
  });

  test("enabled with no smokes is a config error, not a silently open gate", () => {
    expect(() => parsePreflight({ enabled: true, account: "SMOKE", smokes: [] })).toThrow(/no smokes/);
  });

  test("shape errors are refused", () => {
    expect(() => parsePreflight({ account: "SMOKE", smokes: [] })).toThrow(/enabled must be/);
    expect(() => parsePreflight({ enabled: false, smokes: [] })).toThrow(/account is required/);
    expect(() => parsePreflight({ enabled: false, account: "S", smokes: "x" })).toThrow(/array of script paths/);
    expect(() => parsePreflight({ enabled: false, account: "S", smokes: [], timeoutMs: 0 })).toThrow(/positive number/);
  });

  test("the gate account may not be an enabled lane's — they would evict each other", () => {
    const withPf = (lanes: unknown[], preflight: unknown) => ({ _notes: [], lanes, preflight });
    expect(() =>
      parseFleet(withPf([lane({ account: "SMOKE" })], { enabled: true, account: "smoke", smokes: ["a.ts"] })),
    ).toThrow(/needs its own account/);
    // Disabled gate, or a disabled lane, is no clash.
    expect(() =>
      parseFleet(withPf([lane({ account: "SMOKE", enabled: false })], { enabled: true, account: "SMOKE", smokes: ["a.ts"] })),
    ).not.toThrow();
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
