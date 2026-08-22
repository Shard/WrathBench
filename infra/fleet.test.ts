import { describe, expect, test } from "bun:test";
import {
  diffLanes,
  fillEntries,
  isAllowlistedFree,
  isClaudeFamily,
  isSharedFreePool,
  laneArgv,
  laneUntilOrFail,
  parseFleet,
  rereadFleet,
  validateEntries,
  type FleetConfig,
  type FleetLane,
  type LaneSets,
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

  test("a loop lane with no stop condition anywhere is refused", () => {
    expect(() => laneUntilOrFail(lane({ loop: true }), undefined)).toThrow(/stop condition/);
    expect(laneUntilOrFail(lane({ loop: true }), "07:00")).toBe("07:00");
    expect(laneUntilOrFail(lane({ loop: false }), undefined)).toBeUndefined();
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
    expect(byName["sub-sonnet"]).toMatchObject({ account: "SHAKEOUT", loop: true });
    expect(byName["sub-opus"]).toMatchObject({ enabled: false, account: "SHAKEOUT2" });
    // ox-alpha: the Phase-0-passing stealth model, its own account and a solo
    // lane. Free despite the suffixless id (see FREE_SUFFIXLESS_ALLOWLIST).
    expect(byName["ox-alpha"]).toMatchObject({ enabled: true, account: "RUNNER" });
    expect(byName["ox-alpha"].entries).toHaveLength(1);
    // Post-reset live free lanes (accounts RUNNER2-RUNNER6 are in the module
    // allowlist on the reclaim image).
    expect(byName["free-or-a"]).toMatchObject({ enabled: true, account: "RUNNER3" });
    expect(byName["free-or-b"]).toMatchObject({ enabled: true, account: "RUNNER4" });
    expect(byName["free-oc-a"]).toMatchObject({ enabled: true, account: "RUNNER2" });
    expect(byName["free-oc-b"]).toMatchObject({ enabled: true, account: "RUNNER5" });
    // Local lane: LM Studio on the LAN, exempt from the free-suffix rule.
    // Re-enabled now the account is harness-bound (a model can no longer land on
    // the wrong account by omitting it from createSession).
    expect(byName["local-qwen"]).toMatchObject({ enabled: true, account: "RUNNER6" });
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
