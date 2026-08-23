import { describe, expect, test } from "bun:test";
import {
  backoffMs,
  DEFER_TAINT_AFTER,
  deferSidecarPath,
  isTainted,
  ladder,
  nextDefer,
  parseDefers,
  planAttempt,
  planCycle,
  planGap,
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

  test("past the last rung it clamps at 6h rather than indexing off the end", () => {
    // The spec is tainted by then (see isTainted), but the function itself must
    // never return undefined/NaN for a count nothing bothered to bound.
    expect(backoffMs(10)).toBe(6 * H);
    expect(backoffMs(99)).toBe(6 * H);
  });

  test("a nonsensical count is clamped up to the first step, not NaN", () => {
    expect(backoffMs(0)).toBe(1 * M);
    expect(backoffMs(-3)).toBe(1 * M);
  });
});

describe("isTainted", () => {
  test("every rung of the ladder is spent before a spec is dropped", () => {
    for (let d = 1; d <= 9; d++) expect(isTainted(d)).toBe(false);
  });

  test("the defer AFTER the last rung taints — the 10th", () => {
    expect(DEFER_TAINT_AFTER).toBe(10);
    expect(isTainted(10)).toBe(true);
    expect(isTainted(11)).toBe(true);
  });
});

describe("nextDefer", () => {
  test("the first defer on a healthy spec cools 1m, not the old 2m", () => {
    expect(nextDefer(undefined, NOW, "roster-glm-20260822", "rate-limited")).toEqual({
      runId: "roster-glm-20260822",
      notBefore: NOW + 1 * M,
      defers: 1,
      reason: "rate-limited",
    });
  });

  test("consecutive defers walk up the ladder and carry the id that actually paused", () => {
    const prev: DeferEntry = { runId: "roster-glm-20260822", notBefore: NOW, defers: 6, reason: "rate-limited" };
    expect(nextDefer(prev, NOW, "roster-glm-20260822-c4", "quota-exhausted")).toEqual({
      runId: "roster-glm-20260822-c4",
      notBefore: NOW + 1 * H,
      defers: 7,
      reason: "quota-exhausted",
    });
  });

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
  test("a spec with no defer state launches fresh (healthy burn sample)", () => {
    expect(planAttempt(undefined, NOW)).toEqual({ kind: "fresh" });
  });

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

  test("resume targets whatever id paused, including a -cN when the defer happened mid-loop", () => {
    const entry: DeferEntry = { runId: "roster-mimo-20260101-c3", notBefore: NOW, defers: 2, reason: "quota-exhausted" };
    expect(planAttempt(entry, NOW)).toEqual({ kind: "resume", runId: "roster-mimo-20260101-c3", reason: "quota-exhausted" });
  });

  test("a tainted spec never launches again, however long it has been cooling", () => {
    const entry: DeferEntry = { runId: "r", notBefore: NOW - 10 * H, defers: 10, reason: "rate-limited", tainted: true };
    expect(planAttempt(entry, NOW)).toEqual({ kind: "tainted", reason: "rate-limited", defers: 10 });
  });
});

describe("defer sidecar", () => {
  test("lives next to the roster jsonl", () => {
    expect(deferSidecarPath("data/runs/fleet-free-or-a-20260822.jsonl")).toBe(
      "data/runs/fleet-free-or-a-20260822.jsonl.defer.json",
    );
  });

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

describe("planGap", () => {
  test("a cycle that ran episodes takes the flat gap", () => {
    const g = planGap(3, 0, undefined, NOW, 5);
    expect(g).toMatchObject({ kind: "gap", ms: 10 * M });
    expect(g.why).toContain("cycle 5");
  });

  test("a cycle where everything is cooling sleeps exactly until the earliest is due", () => {
    const g = planGap(0, 2, NOW + 42 * M, NOW, 5);
    expect(g).toMatchObject({ kind: "cooling", ms: 42 * M });
    expect(g.why).toContain("backing off");
  });

  test("an overdue earliest naps zero rather than a negative sleep", () => {
    expect(planGap(0, 1, NOW - 5 * M, NOW, 2)).toMatchObject({ kind: "cooling", ms: 0 });
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

describe("ladder", () => {
  test("renders long rungs as hours, short ones as minutes", () => {
    expect(ladder([1 * M, 30 * M, 1 * H, 6 * H])).toBe("1m/30m/1h/6h");
  });
});

describe("planCycle — --resume-roster + --loop must not idle the job", () => {
  // Observed live 2026-08-22 16:48-17:01: five of six fleet jobs logged
  // "loop cycle N: restarting the roster (0 episode(s))" forever, because a
  // spec whose cycle-1 run had already terminated was dropped from the roster
  // instead of being carried into the next cycle.
  test("cycle 1 skips a spec whose run already terminated", () => {
    expect(planCycle(undefined, true, 1, NOW)).toEqual({ kind: "already-done" });
  });

  test("cycle 2 gives that same spec a fresh launch — the job keeps working", () => {
    expect(planCycle(undefined, true, 2, NOW)).toEqual({ kind: "fresh" });
    expect(planCycle(undefined, true, 7, NOW)).toEqual({ kind: "fresh" });
  });

  test("a whole roster of already-terminated entries relaunches in cycle 2 with NO nap", () => {
    const roster = [
      { spec: "roster-qwen-20260822", doneCycle1: true },
      { spec: "roster-glm-20260822", doneCycle1: true },
      { spec: "roster-mimo-20260822", doneCycle1: true },
    ];
    const cycle1 = roster.map((a) => planCycle(undefined, a.doneCycle1, 1, NOW));
    expect(cycle1.every((p) => p.kind === "already-done")).toBe(true);
    // Nothing launched, nothing cooling -> straight into cycle 2, no 10m lie.
    const launched = cycle1.filter((p) => p.kind !== "already-done").length;
    const cooling = cycle1.filter((p) => p.kind === "skip").length;
    expect(planGap(launched, cooling, undefined, NOW, 2).kind).toBe("none");
    const cycle2 = roster.map((a) => planCycle(undefined, a.doneCycle1, 2, NOW));
    expect(cycle2).toEqual([{ kind: "fresh" }, { kind: "fresh" }, { kind: "fresh" }]);
  });

  test("defer state still wins in later cycles — a cooling spec is not relaunched", () => {
    const entry: DeferEntry = { runId: "r", notBefore: NOW + 6 * H, defers: 9, reason: "rate-limited" };
    expect(planCycle(entry, true, 3, NOW).kind).toBe("skip");
  });
});
