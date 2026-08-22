import { describe, expect, test } from "bun:test";
import { backoffMs, planAttempt, type DeferEntry } from "./run-roster";

/**
 * These pin the fix for the observed hammering failure: a rate-limited free
 * model (mimo-v2.5-free) was relaunched ~3x/min because a deferred spec both
 * sat on the retry queue AND stayed in the fast --loop rotation, relaunched
 * fresh at level 1 every cycle with no backoff gap. The fix is a per-spec
 * backoff: a deferred spec is skipped while cooling and then resumed IN PLACE
 * on its own run id, never relaunched fresh.
 */

const NOW = 1_000_000;

describe("backoffMs", () => {
  test("escalates 2m/5m/10m through consecutive defers, then clamps", () => {
    expect(backoffMs(1)).toBe(2 * 60_000);
    expect(backoffMs(2)).toBe(5 * 60_000);
    expect(backoffMs(3)).toBe(10 * 60_000);
    // Out of retry steps: hold at the longest, never index past the array.
    expect(backoffMs(4)).toBe(10 * 60_000);
    expect(backoffMs(99)).toBe(10 * 60_000);
  });

  test("a nonsensical count is clamped up to the first step, not NaN", () => {
    expect(backoffMs(0)).toBe(2 * 60_000);
    expect(backoffMs(-3)).toBe(2 * 60_000);
  });
});

describe("planAttempt", () => {
  test("a spec with no defer state launches fresh (healthy burn sample)", () => {
    expect(planAttempt(undefined, NOW)).toEqual({ kind: "fresh" });
  });

  test("a still-cooling deferred spec is skipped, not launched — kills hammering", () => {
    const entry: DeferEntry = { runId: "roster-mimo-20260101", notBefore: NOW + 60_000, defers: 1, reason: "rate-limited" };
    expect(planAttempt(entry, NOW)).toEqual({ kind: "skip", until: NOW + 60_000, reason: "rate-limited" });
  });

  test("a cooled-off deferred spec resumes its STORED run id in place, not a fresh -cN", () => {
    // The run that actually paused was the base id; resume must target exactly
    // that, never a new -c2 launch (which would wipe the account and start at L1
    // for no reason and burn a run id).
    const entry: DeferEntry = { runId: "roster-mimo-20260101", notBefore: NOW - 1, defers: 1, reason: "rate-limited" };
    const plan = planAttempt(entry, NOW);
    expect(plan).toEqual({ kind: "resume", runId: "roster-mimo-20260101", reason: "rate-limited" });
    if (plan.kind === "resume") expect(plan.runId).not.toContain("-c");
  });

  test("resume targets whatever id paused, including a -cN when the defer happened mid-loop", () => {
    const entry: DeferEntry = { runId: "roster-mimo-20260101-c3", notBefore: NOW, defers: 2, reason: "quota-exhausted" };
    // notBefore === now counts as cooled off (>=), so it resumes.
    expect(planAttempt(entry, NOW)).toEqual({ kind: "resume", runId: "roster-mimo-20260101-c3", reason: "quota-exhausted" });
  });
});
