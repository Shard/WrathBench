import { describe, expect, test } from "bun:test";
import {
  backoffMs,
  nextDefer,
  parseDefers,
  planAttempt,
  planCycle,
  planGap,
  resetDefer,
  resolve,
  retryQueueOf,
  serializeDefers,
  type DeferEntry,
} from "./run-roster";

/**
 * These pin two fixes.
 *
 * 1. The original hammering failure: a rate-limited free model (mimo-v2.5-free)
 *    was relaunched ~3x/min because a deferred spec both sat on the retry queue
 *    AND stayed in the fast --loop rotation. The fix is a per-spec backoff: a
 *    deferred spec is skipped while cooling and then resumed IN PLACE.
 * 2. The 2026-08-22 follow-on: that backoff clamped at 10m forever, so a fully
 *    saturated model (z-ai/glm-5.2:free) still burned 17 relaunches in a day,
 *    every one a 0-turn stub. The ladder now escalates to 6h and then TAINTS
 *    the spec out of the rotation.
 */

const NOW = 1_000_000;
const M = 60_000;
const H = 60 * M;

describe("backoffMs", () => {
  test("escalates 1m/3m/5m/10m/15m/30m/1h/3h/6h through consecutive defers", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9].map(backoffMs)).toEqual([1 * M, 3 * M, 5 * M, 10 * M, 15 * M, 30 * M, 1 * H, 3 * H, 6 * H]);
  });
});

describe("nextDefer", () => {
  test("the 10th consecutive defer taints instead of scheduling another retry", () => {
    const prev: DeferEntry = { runId: "r", notBefore: NOW, defers: 9, reason: "rate-limited" };
    const e = nextDefer(prev, NOW, "r", "rate-limited");
    expect(e.tainted).toBe(true);
    expect(e.defers).toBe(10);
    // Not Infinity: JSON.stringify would round-trip that to null.
    expect(Number.isFinite(e.notBefore)).toBe(true);
  });
});

describe("planAttempt", () => {
  test("a still-cooling deferred spec is skipped, not launched — kills hammering", () => {
    const entry: DeferEntry = { runId: "roster-mimo-20260101", notBefore: NOW + M, defers: 1, reason: "rate-limited" };
    expect(planAttempt(entry, NOW)).toEqual({ kind: "skip", until: NOW + M, reason: "rate-limited" });
  });

  test("a cooled-off deferred spec resumes its STORED run id in place, not a fresh -cN", () => {
    const entry: DeferEntry = { runId: "roster-mimo-20260101", notBefore: NOW - 1, defers: 1, reason: "rate-limited" };
    const plan = planAttempt(entry, NOW);
    expect(plan).toEqual({ kind: "resume", runId: "roster-mimo-20260101", reason: "rate-limited" });
    if (plan.kind === "resume") expect(plan.runId).not.toContain("-c");
  });

  test("a tainted spec never launches again, however long it has been cooling", () => {
    const entry: DeferEntry = { runId: "r", notBefore: NOW - 10 * H, defers: 10, reason: "rate-limited", tainted: true };
    expect(planAttempt(entry, NOW)).toEqual({ kind: "tainted", reason: "rate-limited", defers: 10 });
  });
});

describe("defer sidecar", () => {
  test("round-trips state keyed on the SPEC id, not the paused run id", () => {
    // The map key is the stable cycle-1 spec id; DeferEntry.runId is whatever
    // actually paused, which may be a -cN. Keying the reload on entry.runId
    // would orphan exactly these entries and reset a 6h backoff to 1m.
    const before = new Map<string, DeferEntry>([
      ["roster-glm-20260822", { runId: "roster-glm-20260822-c3", notBefore: NOW + 6 * H, defers: 9, reason: "rate-limited" }],
      ["roster-mimo-20260822", { runId: "roster-mimo-20260822", notBefore: NOW, defers: 10, reason: "quota-exhausted", tainted: true }],
    ]);
    const after = parseDefers(serializeDefers(before));
    expect(after).toEqual(before);
    expect(after.get("roster-glm-20260822")!.runId).toBe("roster-glm-20260822-c3");
    expect(planAttempt(after.get("roster-mimo-20260822"), NOW + 100 * H).kind).toBe("tainted");
  });

  test("a truncated or foreign sidecar reads as no state, never a throw", () => {
    expect(parseDefers("").size).toBe(0);
    expect(parseDefers('{"version":1,"entries":{"a":{"runId":').size).toBe(0);
    expect(parseDefers('{"version":1,"entries":{"a":{"nope":true}}}').size).toBe(0);
    expect(parseDefers("null").size).toBe(0);
  });
});

describe("a provider's stated reset", () => {
  // The 2026-09-21 nemotron-super stream: a spent daily allowance, and the
  // in-place retries plus the retry cycles each adding a refused pause to the
  // streak until the ladder ran out, hours before the reset at 00:00 UTC.
  const RESET = NOW + 7 * H;

  test("holds the spec until the reset without spending a defer", () => {
    expect(resetDefer(undefined, RESET, "roster-nemotron-20260921", "quota-exhausted")).toEqual({
      runId: "roster-nemotron-20260921",
      notBefore: RESET,
      defers: 0,
      reason: "quota-exhausted",
      reset: true,
    });
    const prev: DeferEntry = { runId: "roster-nemotron-20260921", notBefore: NOW, defers: 4, reason: "rate-limited" };
    expect(resetDefer(prev, RESET, "roster-nemotron-20260921", "quota-exhausted").defers).toBe(4);
    // The next ordinary defer climbs from where the ladder stood, and is a rung again.
    const after = nextDefer(resetDefer(prev, RESET, "r", "quota-exhausted"), RESET, "r", "rate-limited");
    expect(after).toEqual({ runId: "r", notBefore: RESET + 15 * M, defers: 5, reason: "rate-limited" });
  });

  test("the retry queue leaves it to the supervisor", () => {
    const [a, b] = resolve([{ model: "nvidia/nemotron-super:free" }, { model: "z-ai/glm-5.2:free" }], "20260921");
    const roster = [
      { spec: a!, resume: false },
      { spec: b!, resume: false },
    ];
    const deferred = new Map<string, DeferEntry>([
      [a!.runId, resetDefer(undefined, RESET, a!.runId, "quota-exhausted")],
      [b!.runId, nextDefer(undefined, NOW, `${b!.runId}-c2`, "rate-limited")],
    ]);
    expect(retryQueueOf(roster, deferred).map((q) => [q.spec.runId, q.resume])).toEqual([[`${b!.runId}-c2`, true]]);
  });
});

describe("planGap", () => {
  test("a cycle where everything is cooling sleeps exactly until the earliest is due", () => {
    const g = planGap(0, 2, NOW + 42 * M, NOW, 5);
    expect(g).toMatchObject({ kind: "cooling", ms: 42 * M });
    expect(g.why).toContain("backing off");
  });

  test("a cycle that launched nothing because every entry was already terminated does NOT nap", () => {
    // The observed lie: a job whose whole roster was skipped on
    // --resume-roster slept 10m announcing "all models backing off" when
    // nothing was backing off at all.
    const g = planGap(0, 0, undefined, NOW, 2);
    expect(g.kind).toBe("none");
    expect(g.why).not.toContain("backing off");
  });
});

describe("planCycle — --resume-roster + --loop must not idle the job", () => {
  test("cycle 2 gives that same spec a fresh launch — the job keeps working", () => {
    expect(planCycle(undefined, true, 2, NOW)).toEqual({ kind: "fresh" });
    expect(planCycle(undefined, true, 7, NOW)).toEqual({ kind: "fresh" });
  });

  test("defer state still wins in later cycles — a cooling spec is not relaunched", () => {
    const entry: DeferEntry = { runId: "r", notBefore: NOW + 6 * H, defers: 9, reason: "rate-limited" };
    expect(planCycle(entry, true, 3, NOW).kind).toBe("skip");
  });
});
