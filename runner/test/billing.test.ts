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
import { loadRunConfig } from "../src/config";
import { billingOf } from "../src/model-cost";
import { configFromArgs } from "../src/run";

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
      run: { model: "qwen3-30b", apiBase: "http://192.168.100.20:1234/v1", harness: "wrathbench" },
      want: "free",
    },
    {
      why: "a suffixless id — a stealth id reads paid, whatever it is quoted at",
      run: { model: "stealth/ox-alpha", platform: "openrouter", harness: "wrathbench" },
      want: "paid",
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
    expect(billingOf({ model: "qwen3-30b", apiBase: "http://192.168.100.20:1234/v1" })).toBe("free");
    expect(billingOf({ model: "stealth/ox-alpha" })).toBe("paid");
  });

  test("a stealth id priced at zero with no free suffix: derived paid, free by the entry's override", () => {
    // The rules read the id alone, so the operator's `billing` on the roster
    // entry is the only way a suffixless id reads free.
    const bunny = { model: "stealth/space-bunny-alpha" };
    expect(billingOf(bunny)).toBe("paid");
    expect(billingOf({ ...bunny, billing: "free" })).toBe("free");
    // The run records the override at launch, and the reader reads it the same way.
    const stored = { ...bunny, platform: "openrouter", harness: "wrathbench", driver: "openai" };
    expect(runBilling({ ...stored, declaredBilling: "free" })).toBe("free");
    // A run that recorded none is read by the rules, exactly as before.
    expect(runBilling(stored)).toBe("paid");
    expect(runBilling({ ...stored, declaredBilling: null })).toBe("paid");
  });

  test("a recorded billing wins on the openai driver, both ways, and nowhere else", () => {
    const openai = { platform: "openrouter", harness: "wrathbench", driver: "openai" };
    expect(runBilling({ ...openai, model: "qwen/qwen3-coder:free", declaredBilling: "paid" })).toBe("paid");
    expect(runBilling({ ...openai, model: "qwen3-30b", apiBase: "http://192.168.100.20:1234/v1", declaredBilling: "paid" })).toBe("paid");
    // A subscription's bill is the subscription, whatever a run says.
    expect(runBilling({ model: "sonnet", harness: "claude-code", driver: "claude-code", declaredBilling: "free" })).toBe("paid");
    expect(runBilling({ model: "gpt-6-astra", harness: "codex", driver: "codex", declaredBilling: "free" })).toBe("paid");
    // No driver on the record: the rules decide.
    expect(runBilling({ model: "stealth/space-bunny-alpha", declaredBilling: "free" })).toBe("paid");
  });

  test("the runner records a launch's billing and a resume keeps it", () => {
    expect(configFromArgs(["--model", "stealth/space-bunny-alpha", "--billing", "free"]).billing).toBe("free");
    expect(configFromArgs(["--model", "stealth/space-bunny-alpha"]).billing).toBeUndefined();
    expect(() => configFromArgs(["--model", "m", "--billing", "cheap"])).toThrow(/billing/);
    // `--resume` rebuilds the config from meta.json through the same schema.
    const launched = configFromArgs(["--model", "stealth/space-bunny-alpha", "--billing", "free"]);
    expect(loadRunConfig(JSON.parse(JSON.stringify(launched))).billing).toBe("free");
  });

  test("an explicit billing wins over every derived rule, both ways", () => {
    expect(billingOf({ model: "qwen/qwen3-coder:free", billing: "paid" })).toBe("paid");
    expect(billingOf({ model: "qwen3-30b", apiBase: "http://192.168.100.20:1234/v1", billing: "paid" })).toBe("paid");
    expect(billingOf({ model: "claude-sonnet-4-5", driver: "claude-code", billing: "paid" })).toBe("paid");
    expect(billingOf({ model: "openai/gpt-5", billing: "free" })).toBe("free");
  });
});
