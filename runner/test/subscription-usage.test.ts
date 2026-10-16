/**
 * The subscription usage gate's rule (operator, 2026-10-16): the two
 * thresholds, the lanes, staleness, and the driver-side tracker. Synthetic
 * figures only.
 */
import { describe, expect, test } from "bun:test";
import { goKeyEnvOf, subscriptionLaneOfConfig } from "../src/models";
import {
  DEFAULT_SUB_MAX_PCT,
  SUBSCRIPTION_RESET_CEILING_MS,
  SubscriptionUsageTracker,
  capReset,
  gateClassOf,
  liveWindows,
  newestByLane,
  parseSubscriptionUsage,
  subscriptionLaneOf,
  subscriptionThresholds,
  thresholdOf,
  usageHold,
  windowLabel,
  type SubscriptionUsage,
} from "../src/subscription-usage";

const NOW = 1_900_000_000_000;
const H = 3_600_000;

describe("the two thresholds", () => {
  test("default to 80, take a percent in (0, 100], and fall back with a note on anything else", () => {
    expect(subscriptionThresholds({})).toEqual({ scored: DEFAULT_SUB_MAX_PCT, freeplay: DEFAULT_SUB_MAX_PCT, notes: [] });
    expect(subscriptionThresholds({ WRATHBENCH_SUB_SCORED_MAX_PCT: "90", WRATHBENCH_SUB_FREEPLAY_MAX_PCT: "100" })).toMatchObject({ scored: 90, freeplay: 100, notes: [] });
    expect(subscriptionThresholds({ WRATHBENCH_SUB_SCORED_MAX_PCT: "75%" }).scored).toBe(75);
    for (const bad of ["0", "-5", "150", "lots"]) {
      const t = subscriptionThresholds({ WRATHBENCH_SUB_FREEPLAY_MAX_PCT: bad });
      expect(t.freeplay).toBe(80);
      expect(t.notes).toHaveLength(1);
      expect(t.notes[0]).toContain("WRATHBENCH_SUB_FREEPLAY_MAX_PCT");
    }
  });

  test("a scored episode reads the scored threshold, freeplay its own, and a probe only a spent window", () => {
    const t = { scored: 70, freeplay: 85 };
    expect(thresholdOf(gateClassOf("e90"), t)).toBe(70);
    expect(thresholdOf(gateClassOf("e360"), t)).toBe(70);
    expect(thresholdOf(gateClassOf("freeplay"), t)).toBe(85);
    expect(thresholdOf(gateClassOf("probing"), t)).toBe(100);
    expect(thresholdOf(gateClassOf(undefined), t)).toBe(100);
  });
});

describe("lanes", () => {
  test("one per claude token, codex home and OpenCode Go key; nothing for any other run", () => {
    expect(subscriptionLaneOf({ driver: "claude-code" })).toBe("claude-code:CLAUDE_CODE_OAUTH_TOKEN");
    expect(subscriptionLaneOf({ driver: "claude-code", lane: "CLAUDE_CODE_OAUTH_TOKEN_2" })).toBe("claude-code:CLAUDE_CODE_OAUTH_TOKEN_2");
    expect(subscriptionLaneOf({ driver: "codex" })).toBe("codex:CODEX_HOME");
    expect(subscriptionLaneOf({ driver: "openai", goKeyEnv: "OPENCODE_KEY" })).toBe("opencode-go:OPENCODE_KEY");
    expect(subscriptionLaneOf({ driver: "openai" })).toBeNull();
    expect(subscriptionLaneOf({ driver: "stub" })).toBeNull();
  });

  test("an OpenCode Go entry bills a lane only when it draws the allowance down: a Go base, paid", () => {
    const go = { driver: "openai", model: "vendor/m", apiBase: "https://opencode.ai/zen/go/v1", apiKeyEnv: "OPENCODE_KEY" };
    expect(goKeyEnvOf({ ...go, billing: "paid" })).toBe("OPENCODE_KEY");
    expect(goKeyEnvOf(go)).toBe("OPENCODE_KEY");
    // A $0 Go model keeps working past the limit: no lane, never gated.
    expect(goKeyEnvOf({ ...go, billing: "free" })).toBeUndefined();
    // Zen's free tier and every other base are not Go.
    expect(goKeyEnvOf({ ...go, apiBase: "https://opencode.ai/zen/v1" })).toBeUndefined();
    expect(subscriptionLaneOfConfig({ ...go, billing: "paid" })).toBe("opencode-go:OPENCODE_KEY");
    expect(subscriptionLaneOfConfig({ driver: "codex", subscription: "CODEX_HOME_2" })).toBe("codex:CODEX_HOME_2");
    expect(subscriptionLaneOfConfig({ driver: "openai", model: "z-ai/glm:free" })).toBeNull();
  });
});

describe("windows, staleness and holds", () => {
  const usage = (windows: SubscriptionUsage["windows"], observedAt = NOW): SubscriptionUsage => ({ lane: "codex:CODEX_HOME", observedAt, windows });

  test("a window counts until its reset; one without a reset until its own length past the reading; one with neither never", () => {
    const u = usage(
      [
        { usedPercent: 90, windowMinutes: 300, resetsAt: NOW + H },
        { usedPercent: 90, windowMinutes: 300, resetsAt: NOW - 1 },
        { usedPercent: 90, windowMinutes: 60, resetsAt: null },
        { usedPercent: 90, windowMinutes: null, resetsAt: null },
      ],
      NOW - 30 * 60_000,
    );
    expect(liveWindows(u, NOW).map((w) => w.resetsAt ?? w.windowMinutes)).toEqual([NOW + H, 60]);
    expect(liveWindows(u, NOW + 2 * H)).toEqual([]);
  });

  test("a hold names the windows at or over the threshold, until the last of them resets, capped at seven days", () => {
    const u = usage([
      { usedPercent: 82, windowMinutes: 300, resetsAt: NOW + H },
      { usedPercent: 85, windowMinutes: 10_080, resetsAt: NOW + 20 * H },
      { usedPercent: 10, windowMinutes: 43_200, resetsAt: NOW + 400 * H },
    ]);
    expect(usageHold(u, 80, NOW)).toMatchObject({ threshold: 80, until: NOW + 20 * H });
    expect(usageHold(u, 80, NOW)!.windows).toHaveLength(2);
    expect(usageHold(u, 90, NOW)).toBeNull();
    expect(usageHold(undefined, 80, NOW)).toBeNull();
    expect(usageHold(usage([{ usedPercent: 100, windowMinutes: null, resetsAt: NOW + 900 * H }]), 100, NOW)!.until).toBe(NOW + SUBSCRIPTION_RESET_CEILING_MS);
    expect(capReset(NOW - 1, NOW)).toBeUndefined();
    expect(capReset(NOW + H, NOW)).toBe(NOW + H);
  });

  test("the newest reading per lane wins; a malformed one is no reading", () => {
    const a = usage([{ usedPercent: 10, windowMinutes: 300, resetsAt: NOW + H }], NOW - H);
    const b = usage([{ usedPercent: 50, windowMinutes: 300, resetsAt: NOW + H }], NOW);
    expect(newestByLane([b, a, null]).get("codex:CODEX_HOME")).toBe(b);
    expect(parseSubscriptionUsage(JSON.parse(JSON.stringify(b)))).toEqual(b);
    expect(parseSubscriptionUsage({ lane: "x", observedAt: "soon", windows: [] })).toBeUndefined();
    expect(parseSubscriptionUsage({ lane: "x", observedAt: 1, windows: [{ usedPercent: "lots" }] })).toEqual({ lane: "x", observedAt: 1, windows: [] });
    expect(windowLabel({ usedPercent: 1, windowMinutes: 10_080, resetsAt: null })).toBe("7d");
    expect(windowLabel({ usedPercent: 1, windowMinutes: 300, resetsAt: null })).toBe("5h");
  });
});

describe("SubscriptionUsageTracker", () => {
  test("records a reading only when it changed", () => {
    const written: SubscriptionUsage[] = [];
    const t = new SubscriptionUsageTracker("codex:CODEX_HOME", (u) => written.push(u));
    const w = [{ usedPercent: 20, windowMinutes: 10_080, resetsAt: NOW + H }];
    t.observe(w, NOW);
    t.observe(w.map((x) => ({ ...x })), NOW + 1);
    t.observe([{ ...w[0]!, usedPercent: 21 }], NOW + 2);
    t.observe([], NOW + 3);
    expect(written.map((u) => u.windows[0]!.usedPercent)).toEqual([20, 21]);
  });

  test("a spent quota waits for the most-used window's reset, recorded as spent; a stated reset stands in when none was seen", () => {
    const written: SubscriptionUsage[] = [];
    const t = new SubscriptionUsageTracker("claude-code:CLAUDE_CODE_OAUTH_TOKEN", (u) => written.push(u));
    t.observe(
      [
        { usedPercent: 40, windowMinutes: 300, resetsAt: NOW + H },
        { usedPercent: 97, windowMinutes: 10_080, resetsAt: NOW + 30 * H },
      ],
      NOW,
    );
    expect(t.quotaReset(NOW + 5)).toBe(NOW + 30 * H);
    expect(written.at(-1)!.windows.map((w) => w.usedPercent)).toEqual([40, 100]);

    const fresh = new SubscriptionUsageTracker("claude-code:CLAUDE_CODE_OAUTH_TOKEN", (u) => written.push(u));
    expect(fresh.quotaReset(NOW)).toBeUndefined();
    expect(fresh.quotaReset(NOW, NOW + 2 * H)).toBe(NOW + 2 * H);
    expect(fresh.current!.windows).toEqual([{ usedPercent: 100, windowMinutes: null, resetsAt: NOW + 2 * H }]);
    // A past reset is no wait at all.
    expect(new SubscriptionUsageTracker("l", () => {}).quotaReset(NOW, NOW - 1)).toBeUndefined();
  });

  test("a writer that throws never reaches the turn", () => {
    const t = new SubscriptionUsageTracker("l", () => {
      throw new Error("disk");
    });
    expect(() => t.observe([{ usedPercent: 1, windowMinutes: 300, resetsAt: NOW + H }], NOW)).not.toThrow();
    expect(t.freeplayHold(80, NOW)).toBeNull();
  });
});
