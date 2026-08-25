/**
 * The reader's billing verdict (`runner/src/billing.ts`).
 *
 * The one thing this file exists to pin: `claude-code` is PAID here and FREE in
 * the scheduler's `billingOf`. Those are different questions, and a change that
 * collapses them would silently re-scope the fleet's paid-concurrency cap — so
 * both sides are asserted together, in one table.
 */

import { describe, expect, test } from "bun:test";
import { runBilling } from "../src/billing";
import { billingOf } from "../src/model-cost";

describe("runBilling", () => {
  const cases: { why: string; run: Parameters<typeof runBilling>[0]; want: "free" | "paid" }[] = [
    {
      why: "the claude-code harness is a subscription, and a subscription is a bill",
      run: { model: "claude-sonnet-4-5", harness: "claude-code" },
      want: "paid",
    },
    {
      why: "the claude-code driver, for a run that recorded no harness tag",
      run: { model: "claude-opus-4-1", driver: "claude-code" },
      want: "paid",
    },
    {
      why: "an OpenRouter :free slug",
      run: { model: "qwen/qwen3-coder:free", platform: "openrouter", harness: "wrathbench" },
      want: "free",
    },
    {
      why: "an OpenCode Zen -free slug",
      run: { model: "grok-code-free", platform: "opencode", harness: "wrathbench" },
      want: "free",
    },
    {
      why: "a contributor-free slug: the provider keeps the prompts instead",
      run: { model: "opencode/muse-spark-contributor-free", harness: "wrathbench" },
      want: "free",
    },
    {
      why: "the operator's own hardware, by the stamped platform",
      run: { model: "qwen3-30b", platform: "local", harness: "wrathbench" },
      want: "free",
    },
    {
      why: "the operator's own hardware, by the api base a run recorded",
      run: { model: "qwen3-30b", apiBase: "http://192.168.1.20:1234/v1", harness: "wrathbench" },
      want: "free",
    },
    {
      why: "a verified-free suffixless id on the allowlist",
      run: { model: "stealth/ox-alpha", platform: "openrouter", harness: "wrathbench" },
      want: "free",
    },
    {
      why: "a paid OpenRouter slug — the default side",
      run: { model: "openai/gpt-5", platform: "openrouter", harness: "wrathbench" },
      want: "paid",
    },
    {
      why: "a run that recorded no model reads paid rather than shrinking a spend",
      run: { model: null, platform: "openrouter", harness: "wrathbench" },
      want: "paid",
    },
  ];

  for (const c of cases) {
    test(`${c.want}: ${c.why}`, () => {
      expect(runBilling(c.run)).toBe(c.want);
    });
  }

  test("disagrees with the scheduler's verdict on claude-code, and only there", () => {
    const cc = { model: "claude-sonnet-4-5", harness: "claude-code" };
    expect(runBilling(cc)).toBe("paid");
    // The fleet's cap counts a subscription job as spending none of the metered
    // budget. If this ever flips, the paid-concurrency cap has changed meaning.
    expect(billingOf(cc)).toBe("free");
    // Everywhere else the two agree, so the divergence really is one clause.
    // (`platform` is this module's own input — `billingOf` reads the api base —
    // so the local case is asserted through the base both of them look at.)
    expect(billingOf({ model: "openai/gpt-5" })).toBe("paid");
    expect(billingOf({ model: "qwen/qwen3-coder:free" })).toBe("free");
    expect(billingOf({ model: "qwen3-30b", apiBase: "http://192.168.1.20:1234/v1" })).toBe("free");
    expect(billingOf({ model: "stealth/ox-alpha" })).toBe("free");
  });
});
