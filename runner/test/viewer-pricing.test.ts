/**
 * The run cost metric: the price table, the arithmetic over it, and the rule
 * that a reported figure always beats a reconstructed one.
 *
 * The golden case is the one run in the corpus that carries a real
 * `total_cost_usd` (`fleet-nav-probe-sonnet-20260822-c2`, docs/COSTS.md §3):
 * its `usageRaw` priced at the Sonnet intro rates comes to $43.23 against a
 * reported $43.90. That is the pin that says the table's rates — and the
 * cache-read multiplier in particular — are the ones actually billing.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import type { PriceableRun } from "../viewer/pricing";
import { CLAUDE_PRICES, breakdownTotal, costOf, priceFor, runCost } from "../viewer/pricing";
import { reportedCostUsd, scanRunTotals, summarize } from "../viewer/tail";
import type { TokenTotals } from "../viewer/api-types";

function tokens(t: Partial<TokenTotals>): TokenTotals {
  return {
    source: "reported",
    contextTokens: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    turns: 1,
    ...t,
  };
}

const sonnetRun: PriceableRun = {
  model: "sonnet",
  apiBase: null,
  platform: "anthropic",
  driver: "claude-code",
  harness: "claude-code",
};

describe("priceFor", () => {
  test("names a claude model through the claude-code harness", () => {
    expect(priceFor(sonnetRun)?.id).toBe("claude-sonnet-5");
    expect(priceFor({ ...sonnetRun, model: "opus" })?.id).toBe("claude-opus-5");
  });

  test("a free slug is priced at zero on either platform's spelling", () => {
    const or = priceFor({ ...sonnetRun, model: "z-ai/glm-5.2:free", driver: "openai", harness: "wrathbench" });
    const oc = priceFor({ ...sonnetRun, model: "hy3-free", driver: "openai", harness: "wrathbench" });
    expect(or?.id).toBe("free-tier");
    expect(oc?.id).toBe("free-tier");
    expect(or?.input).toBe(0);
    expect(or?.note).toContain("free tier");
  });

  test("a model served from the operator's LAN is local, whatever it is called", () => {
    const p = priceFor({
      model: "qwen/qwen3.8-27b",
      apiBase: "http://192.168.1.20:1234/v1",
      platform: "192.168.1.20",
      driver: "openai",
      harness: "wrathbench",
    });
    expect(p?.id).toBe("local");
    expect(p?.output).toBe(0);
  });

  test("an unknown paid model has no price at all — tokens only, never a guess", () => {
    expect(
      priceFor({
        model: "stealth/ox-alpha",
        apiBase: "https://openrouter.ai/api/v1",
        platform: "openrouter",
        driver: "openai",
        harness: "wrathbench",
      }),
    ).toBeNull();
  });

  test("the sonnet intro rate lapses: a run started after 2026-08-31 gets standard pricing", () => {
    const intro = priceFor(sonnetRun, Date.parse("2026-08-22"))!;
    const std = priceFor(sonnetRun, Date.parse("2026-09-15"))!;
    expect(intro.input).toBe(2.0);
    expect(std.input).toBe(3.0);
    expect(std.output).toBe(15.0);
    expect(std.note).toContain("lapsed");
  });

  test("every row carries its own date and source, so a stale price is visible", () => {
    for (const p of CLAUDE_PRICES) {
      expect(p.source).toBe("list");
      expect(p.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe("costOf", () => {
  test("cache read and write come out of the prompt: they are a subset of it", () => {
    const b = costOf(
      tokens({ promptTokens: 1_000_000, completionTokens: 0, cacheReadTokens: 600_000, cacheWriteTokens: 300_000 }),
      priceFor(sonnetRun)!,
    );
    // 100k fresh @ $2/M, 600k read @ $0.20/M, 300k write @ $2.50/M
    expect(b.input).toBeCloseTo(0.2, 6);
    expect(b.cacheRead).toBeCloseTo(0.12, 6);
    expect(b.cacheWrite).toBeCloseTo(0.75, 6);
    expect(b.output).toBe(0);
  });

  test("with no cache fields the whole prompt is fresh input", () => {
    const b = costOf(tokens({ promptTokens: 2_000_000, completionTokens: 100_000 }), priceFor(sonnetRun)!);
    expect(b.input).toBeCloseTo(4.0, 6);
    expect(b.output).toBeCloseTo(1.0, 6);
    expect(b.cacheRead).toBe(0);
    expect(b.cacheWrite).toBe(0);
  });

  test("the COSTS.md §3 golden case reproduces the reported figure within 2%", () => {
    // usageRaw of fleet-nav-probe-sonnet-20260822-c2, reported $43.90307.
    const t = tokens({
      promptTokens: 1_810 + 451_039 + 201_137_815,
      completionTokens: 186_646,
      cacheReadTokens: 201_137_815,
      cacheWriteTokens: 451_039,
    });
    const usd = breakdownTotal(costOf(t, priceFor(sonnetRun)!));
    expect(usd).toBeGreaterThan(43.0);
    expect(Math.abs(usd - 43.903071) / 43.903071).toBeLessThan(0.02);
  });
});

describe("runCost", () => {
  test("a reported figure wins over the table and is used verbatim", () => {
    const c = runCost({
      run: sonnetRun,
      tokens: tokens({ promptTokens: 900_000_000, completionTokens: 1_000_000 }),
      reportedUsd: 43.903071,
    });
    expect(c.basis).toBe("reported");
    expect(c.usd).toBe(43.903071);
    expect(c.breakdown).toBeNull();
    expect(c.asIfMetered).toBe(true);
  });

  test("a reported zero is a figure, not an absence", () => {
    const c = runCost({ run: sonnetRun, tokens: tokens({ promptTokens: 1_000_000 }), reportedUsd: 0 });
    expect(c.basis).toBe("reported");
    expect(c.usd).toBe(0);
  });

  test("without a reported figure it falls back to list price, caveated", () => {
    const c = runCost({
      run: sonnetRun,
      tokens: tokens({ promptTokens: 1_000_000, completionTokens: 100_000 }),
      reportedUsd: null,
    });
    expect(c.basis).toBe("list-price");
    expect(c.usd).toBeCloseTo(3.0, 6);
    expect(c.breakdown).not.toBeNull();
    expect(c.note).toContain("COSTS.md");
    // The date rides the wire, so a display string cannot outlive the rate.
    expect(c.priceId).toBe("claude-sonnet-5");
    expect(c.asOf).toBe("2026-08-22");
  });

  test("an unknown model gets no cost and says why", () => {
    const c = runCost({
      run: { model: "stealth/ox-alpha", apiBase: null, platform: "openrouter", driver: "openai", harness: "wrathbench" },
      tokens: tokens({ promptTokens: 500_000 }),
      reportedUsd: null,
    });
    expect(c.basis).toBe("none");
    expect(c.usd).toBeNull();
    expect(c.note).toContain("no price on file");
  });

  test("estimated tokens are not priced at a non-zero rate", () => {
    const c = runCost({
      run: sonnetRun,
      tokens: tokens({ source: "estimated", promptTokens: 1_000_000 }),
      reportedUsd: null,
    });
    expect(c.basis).toBe("none");
    expect(c.note).toContain("estimated");
  });

  test("a free model is $0 even on estimated tokens, and is marked as-if-metered", () => {
    const c = runCost({
      run: { model: "hy3-free", apiBase: "https://opencode.ai/zen/v1", platform: "opencode.ai", driver: "openai", harness: "wrathbench" },
      tokens: tokens({ source: "estimated", promptTokens: 2_000_000, completionTokens: 90_000 }),
      reportedUsd: null,
    });
    expect(c.basis).toBe("list-price");
    expect(c.usd).toBe(0);
    expect(c.asIfMetered).toBe(true);
  });
});

describe("reportedCostUsd", () => {
  test("sums the claude_result records and returns null when there are none", () => {
    expect(reportedCostUsd([{ t: "response" }, { t: "snippet" }])).toBeNull();
    expect(
      reportedCostUsd([{ t: "claude_result", costUsd: 1.5 }, { t: "response" }, { t: "claude_result", costUsd: 2.25 }]),
    ).toBe(3.75);
  });

  test("a recorded zero reads as zero, not as absent", () => {
    expect(reportedCostUsd([{ t: "claude_result", costUsd: 0 }])).toBe(0);
  });

  test("the tail's summariser keeps costUsd a number, so the run page can report it", () => {
    // The detail endpoint reads `tail.entries`, not raw records: `claude_result`
    // falls through `summarize`'s generic branch, and the figure has to survive it.
    const e = summarize({ t: "claude_result", ts: 1, costUsd: 43.903071, usageRaw: { input_tokens: 1810 } }, 0, 0, 0);
    expect(e["costUsd"]).toBe(43.903071);
    expect(reportedCostUsd([e])).toBe(43.903071);
  });

  test("scanRunTotals picks it up even though the token projection drops the record", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "wrathbench-pricing-")), "trajectory.jsonl");
    writeFileSync(
      path,
      [
        JSON.stringify({ t: "meta", ts: 1 }),
        JSON.stringify({ t: "request", ts: 2, messages: [{ role: "user", content: "hi" }] }),
        JSON.stringify({ t: "response", ts: 3, message: { content: "ok" }, usage: { input_tokens: 10, output_tokens: 4 } }),
        JSON.stringify({ t: "claude_result", ts: 4, costUsd: 12.5 }),
        "",
      ].join("\n"),
    );
    const totals = await scanRunTotals(path);
    expect(totals.reportedCostUsd).toBe(12.5);
    expect(totals.tokens.promptTokens).toBe(10);
  });
});
