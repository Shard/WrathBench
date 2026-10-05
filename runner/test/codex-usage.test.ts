/**
 * The codex per-turn usage rule (`runner/src/codex-usage.ts`): the CLI reports
 * the thread's running total, a turn's share is the difference from the
 * previous total of the same thread, and a total that fell is a new baseline.
 */
import { describe, expect, test } from "bun:test";
import { CodexUsageCorrector, codexUsageDelta, codexUsageRegressed, type CodexUsage } from "../src/codex-usage";

const u = (prompt: number, completion: number, extra: Partial<CodexUsage> = {}): CodexUsage => ({
  prompt_tokens: prompt,
  completion_tokens: completion,
  total_tokens: prompt + completion,
  ...extra,
});

describe("codexUsageDelta", () => {
  test("the first turn of a thread is its total; later turns are the difference", () => {
    expect(codexUsageDelta(undefined, u(184, 9, { cached_tokens: 160 }))).toEqual(u(184, 9, { cached_tokens: 160 }));
    expect(codexUsageDelta(u(184, 9, { cached_tokens: 160 }), u(494, 20, { cached_tokens: 462 }))).toEqual(
      u(310, 11, { cached_tokens: 302 }),
    );
  });

  test("a field that fell counts zero, never negative; an optional field follows the current reading", () => {
    const prev = u(1_449, 963, { cached_tokens: 1_424, reasoning_tokens: 64 });
    const cur = u(1_447, 962, { cached_tokens: 1_422, reasoning_tokens: 65 });
    expect(codexUsageRegressed(prev, cur)).toBe(true);
    expect(codexUsageDelta(prev, cur)).toEqual(u(0, 0, { cached_tokens: 0, reasoning_tokens: 1 }));
    expect(codexUsageDelta(u(1, 1, { cache_write_tokens: 4 }), u(2, 2))).toEqual(u(1, 1));
    expect(codexUsageRegressed(undefined, cur)).toBe(false);
  });
});

describe("CodexUsageCorrector", () => {
  const response = (prompt: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    t: "response",
    usage: u(prompt, 1),
    ...extra,
  });

  test("leaves every record of another driver alone", () => {
    const c = new CodexUsageCorrector();
    c.note({ t: "driver", driver: "claude-code" });
    const a = response(100);
    const b = response(300);
    c.note(a);
    c.note(b);
    expect((b["usage"] as CodexUsage).prompt_tokens).toBe(300);
    expect(b["usageCumulative"]).toBeUndefined();
  });

  test("a record the fixed driver wrote is already per-turn and passes through", () => {
    const c = new CodexUsageCorrector();
    c.note({ t: "driver", driver: "codex" });
    c.note({ t: "codex_thread", threadId: "a" });
    const fixed = response(60, { usageCumulative: u(100, 5) });
    c.note(fixed);
    expect((fixed["usage"] as CodexUsage).prompt_tokens).toBe(60);
    expect(fixed["usageDerived"]).toBeUndefined();
  });

  test("an older codex record is rewritten in place, its total kept beside it", () => {
    const c = new CodexUsageCorrector();
    c.note({ t: "driver", driver: "codex" });
    c.note({ t: "codex_thread", threadId: "a" });
    const first = response(100);
    const second = response(250);
    c.note(first);
    c.note(second);
    expect((second["usage"] as CodexUsage).prompt_tokens).toBe(150);
    expect((second["usageCumulative"] as CodexUsage).prompt_tokens).toBe(250);
    expect(second["usageDerived"]).toBe(true);
    // A new thread is a new baseline.
    c.note({ t: "codex_thread", threadId: "b" });
    const fresh = response(40);
    c.note(fresh);
    expect((fresh["usage"] as CodexUsage).prompt_tokens).toBe(40);
  });
});
