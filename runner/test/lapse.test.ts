import { describe, expect, test } from "bun:test";

import { NOT_THE_MODELS_FAULT, TAINT_AFTER, classifyLapse, resumesOnPause, staleAfterMs, STALE_FALLBACK_MS, type Lapse } from "../src/lapse";

/**
 * The whole of the lapse rule, as a table. Every row is a case an operator
 * asked about by name; the answers are one function's, so the supervisor, the
 * roster and `--status` cannot drift apart on any of them.
 */
describe("what happens to a lapsed run", () => {
  const H = 3_600_000;
  const cases: {
    what: string;
    episode: string | undefined;
    campaignResume?: boolean;
    pause: { reason: string } | null;
    staleForMs?: number | null;
    want: Pick<Lapse, "kind" | "counts"> & { reason?: Lapse["reason"] };
  }[] = [
    {
      what: "an e90 the provider paused: a failed attempt, and it counts",
      episode: "e90",
      pause: { reason: "quota-exhausted" },
      want: { kind: "fail", reason: "attempt-failed", counts: true },
    },
    {
      what: "an e360 rate-limited: the same, on the long tier",
      episode: "e360",
      pause: { reason: "rate-limited" },
      want: { kind: "fail", reason: "attempt-failed", counts: true },
    },
    {
      what: "an e90 stopped by the operator (a fleet stop, a deploy): a failed attempt that does NOT count",
      episode: "e90",
      pause: { reason: "operator-pause" },
      want: { kind: "fail", reason: "manual", counts: false },
    },
    { what: "freeplay: resumed, exactly as before", episode: "freeplay", pause: { reason: "quota-exhausted" }, want: { kind: "resume", counts: false } },
    { what: "freeplay stopped by the operator: resumed", episode: "freeplay", pause: { reason: "operator-pause" }, want: { kind: "resume", counts: false } },
    { what: "a probe campaign that asked to resume", episode: "probing", campaignResume: true, pause: { reason: "rate-limited" }, want: { kind: "resume", counts: false } },
    {
      what: "a probe campaign that did not (the default): a failed attempt, swept again",
      episode: "probing",
      campaignResume: false,
      pause: { reason: "rate-limited" },
      want: { kind: "fail", reason: "attempt-failed", counts: true },
    },
    {
      what: "a stale e90 that was waiting on its provider: ended, and it counts",
      episode: "e90",
      pause: { reason: "quota-exhausted" },
      staleForMs: 12 * H,
      want: { kind: "stale", reason: "attempt-failed", counts: true },
    },
    {
      what: "a stale e90 nobody paused — the host slept: ended `stale`, harness weather",
      episode: "e90",
      pause: null,
      staleForMs: 12 * H,
      want: { kind: "stale", reason: "stale", counts: false },
    },
    {
      what: "a stale e90 that was stopped for a deploy: ended, never counted",
      episode: "e90",
      pause: { reason: "operator-pause" },
      staleForMs: 12 * H,
      want: { kind: "stale", reason: "stale", counts: false },
    },
    {
      what: "a stale freeplay session: resumed under its own run id, however long the gap (operator, 2026-09-20)",
      episode: "freeplay",
      pause: { reason: "operator-pause" },
      staleForMs: 13 * H,
      want: { kind: "resume", counts: false },
    },
    {
      what: "a freeplay session that was waiting on its provider when the lights went out: still resumed — it never counts",
      episode: "freeplay",
      pause: { reason: "rate-limited" },
      staleForMs: 13 * H,
      want: { kind: "resume", counts: false },
    },
    {
      what: "a freeplay run whose runner died before its verdict (the planner's `offline` pause): resumed",
      episode: "freeplay",
      pause: { reason: "offline" },
      want: { kind: "resume", counts: false },
    },
    {
      what: "a hand-written roster with no episode: the original behaviour, untouched",
      episode: undefined,
      pause: { reason: "quota-exhausted" },
      want: { kind: "resume", counts: false },
    },
    { what: "a current run that never paused: nothing to do", episode: "e90", pause: null, want: { kind: "resume", counts: false } },
  ];

  for (const c of cases) {
    test(c.what, () => {
      const got = classifyLapse({
        episode: c.episode,
        ...(c.campaignResume !== undefined ? { campaignResume: c.campaignResume } : {}),
        pause: c.pause,
        staleForMs: c.staleForMs ?? null,
      });
      expect(got.kind).toBe(c.want.kind);
      expect(got.counts).toBe(c.want.counts);
      expect(got.reason).toBe(c.want.reason);
      // The one predicate: counting is the reason and nothing else.
      expect(got.counts).toBe(got.reason === "attempt-failed");
      if (got.kind !== "resume") expect(got.detail).toContain(c.pause?.reason ?? "offline");
    });
  }

  test("the gap is named in the detail, in the units an operator reads", () => {
    const l = classifyLapse({ episode: "e90", pause: null, staleForMs: 12 * H + 42 * 60_000 });
    expect(l.detail).toContain("no activity for 12h42m");
  });

  test("a run is stale after its OWN budget; one with no wall clock after twice the long tier", () => {
    expect(staleAfterMs(90 * 60_000)).toBe(90 * 60_000);
    expect(staleAfterMs(null)).toBe(STALE_FALLBACK_MS);
    expect(STALE_FALLBACK_MS).toBe(12 * H);
  });

  test("which lanes resume", () => {
    expect(resumesOnPause("e90")).toBe(false);
    expect(resumesOnPause("e360")).toBe(false);
    expect(resumesOnPause("freeplay")).toBe(true);
    expect(resumesOnPause("probing")).toBe(false);
    expect(resumesOnPause("probing", true)).toBe(true);
    // A scored episode never opts in, whatever a campaign says.
    expect(resumesOnPause("e90", true)).toBe(false);
    expect(resumesOnPause(undefined)).toBe(true);
    expect(resumesOnPause("nonsense")).toBe(true);
  });

  test("three strikes", () => {
    expect(TAINT_AFTER).toBe(3);
  });
});

test("adapter-error is not the model's fault (operator, 2026-08-30)", () => {
  expect(NOT_THE_MODELS_FAULT.has("adapter-error")).toBe(true);
});
