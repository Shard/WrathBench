/**
 * The run cost metric: the price table, the arithmetic over it, and the rule
 * that a reported figure always beats a reconstructed one.
 *
 * The golden case is the one run in the corpus that carries a real
 * `total_cost_usd` (`fleet-nav-probe-sonnet-20260822-c2`, §3 of `git show d752ef7:docs/COSTS.md` — the snapshot sections left the live doc on 2026-08-24):
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
import { CLAUDE_PRICES, SYNCED_PRICES, breakdownTotal, costOf, priceFor, runCost } from "../viewer/pricing";
import { reportedCostUsd, responseCostCoverage, scanRunTotals, summarize, TrajectoryTail } from "../viewer/tail";
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
  test("a paid open model is priced from the synced table by exact id, metered for real", () => {
    const run: PriceableRun = { model: "deepseek/deepseek-v4-flash-0731", apiBase: "https://openrouter.ai/api/v1", platform: "openrouter", driver: "openai", harness: "wrathbench" };
    const p = priceFor(run);
    expect(p?.id).toBe("deepseek/deepseek-v4-flash-0731");
    expect(p?.asIfMetered).toBe(false);
    // Rates are the sync's, not this test's, but they must be real dollars.
    expect(p?.input).toBeGreaterThan(0);
    expect(p?.asOf).toBe(SYNCED_PRICES.asOf);
    expect(priceFor({ ...run, model: "deepseek/deepseek-v4-pro" })).toBeNull();
  });
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

  test("a verified-free stealth id (the allowlist) prices as free", () => {
    expect(priceFor({ model: "stealth/ox-alpha", apiBase: null, platform: "openrouter", driver: "openai", harness: "wrathbench" })?.id).toBe("free-tier");
  });

  test("an unknown paid model has no price at all — tokens only, never a guess", () => {
    expect(
      priceFor({
        model: "vendor/big-paid",
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

  test("the archived COSTS.md cross-check golden case reproduces the reported figure within 2%", () => {
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
  test("actual is the provider's figure, used verbatim, and expected is still computed", () => {
    const c = runCost({
      run: sonnetRun,
      tokens: tokens({ promptTokens: 900_000_000, completionTokens: 1_000_000 }),
      reportedUsd: 43.903071,
    });
    expect(c.actual.basis).toBe("reported");
    expect(c.actual.usd).toBe(43.903071);
    expect(c.actual.breakdown).toBeNull();
    expect(c.actual.asIfMetered).toBe(true);
    // The table is applied anyway: a gap between the two is the information.
    expect(c.expected.basis).toBe("list-price");
    expect(c.expected.usd).toBeGreaterThan(0);
    // The old single-figure fields carry `expected` for one release.
    expect(c.basis).toBe(c.expected.basis);
    expect(c.usd).toBe(c.expected.usd);
  });

  test("a reported zero is a figure, not an absence", () => {
    const c = runCost({ run: sonnetRun, tokens: tokens({ promptTokens: 1_000_000 }), reportedUsd: 0 });
    expect(c.actual.basis).toBe("reported");
    expect(c.actual.usd).toBe(0);
  });

  test("a cost covering only part of a run says so — a partial sum is worse than a blank", () => {
    const run: PriceableRun = { model: "stealth/ox-alpha", apiBase: "https://openrouter.ai/api/v1", platform: "openrouter", driver: "openai", harness: "wrathbench" };
    const c = runCost({
      run,
      tokens: tokens({ promptTokens: 1_000 }),
      reportedUsd: 0.004,
      coverage: { costed: 4, uncosted: 20 },
    });
    expect(c.actual.usd).toBe(0.004);
    expect(c.actual.note).toContain("partial: 20 of 24");
    // Full coverage says nothing extra.
    const full = runCost({ run, tokens: tokens({ promptTokens: 1_000 }), reportedUsd: 0.004, coverage: { costed: 24, uncosted: 0 } });
    expect(full.actual.note).not.toContain("partial");
    // The claude figure is one number for a whole session; uncosted responses
    // are the normal case there and must not read as a partial bill.
    const claude = runCost({ run: sonnetRun, tokens: tokens({ promptTokens: 1_000 }), reportedUsd: 43.9, coverage: { costed: 0, uncosted: 900 } });
    expect(claude.actual.note).not.toContain("partial");
  });

  test("a provider that reports no cost says so, rather than borrowing the estimate", () => {
    const c = runCost({ run: sonnetRun, tokens: tokens({ promptTokens: 1_000_000 }), reportedUsd: null });
    expect(c.actual.basis).toBe("none");
    expect(c.actual.usd).toBeNull();
    expect(c.actual.note).toContain("provider reports no cost");
  });

  test("an OpenRouter cost is not read as a subscription figure", () => {
    const c = runCost({
      run: { model: "deepseek/deepseek-v4-flash-0731", apiBase: "https://openrouter.ai/api/v1", platform: "openrouter", driver: "openai", harness: "wrathbench" },
      tokens: tokens({ promptTokens: 1_000_000, completionTokens: 10_000 }),
      reportedUsd: 0.0821,
    });
    expect(c.actual.usd).toBe(0.0821);
    expect(c.actual.asIfMetered).toBe(false);
    expect(c.expected.asIfMetered).toBe(false);
    expect(c.expected.usd).toBeGreaterThan(0);
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
      run: { model: "vendor/big-paid", apiBase: null, platform: "openrouter", driver: "openai", harness: "wrathbench" },
      tokens: tokens({ promptTokens: 500_000 }),
      reportedUsd: null,
    });
    expect(c.basis).toBe("none");
    expect(c.usd).toBeNull();
    // An open model the sync has not seen is fixable, and the note says how.
    expect(c.note).toContain("sync-prices");
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
  test("one CLI session costs its LAST record, not the sum of them", () => {
    expect(reportedCostUsd([{ t: "response" }, { t: "snippet" }])).toBeNull();
    // `total_cost_usd` is cumulative within a session and lands once per
    // harness turn, so summing three records bills the session three times over
    // (on the 2026-08-25 haiku run: $69.30 for a session that charged $4.35).
    const session = [
      { t: "claude_system", session_id: "s1", subtype: "init" },
      { t: "claude_result", costUsd: 0.95, sessionId: "s1" },
      { t: "response" },
      { t: "claude_result", costUsd: 2.51, sessionId: "s1" },
      { t: "claude_result", costUsd: 4.35, sessionId: "s1" },
    ];
    expect(reportedCostUsd(session)).toBe(4.35);

    // A pause and resume opens a NEW session, which starts its own
    // accumulation — those figures are summed, and always were.
    expect(
      reportedCostUsd([
        ...session,
        { t: "pause", reason: "rate-limit" },
        { t: "claude_system", session_id: "s2", subtype: "init" },
        { t: "claude_result", costUsd: 0.4, sessionId: "s2" },
        { t: "claude_result", costUsd: 1.1, sessionId: "s2" },
      ]),
    ).toBeCloseTo(5.45, 9);
  });

  test("a backlog run gets its sessions from the claude_system envelopes", () => {
    // `sessionId` on the result record only exists from 2026-08-25. Before it,
    // the session in force is whatever the last `claude_system` said — and the
    // CLI emits one of those per harness turn, all carrying the one session id.
    expect(
      reportedCostUsd([
        { t: "claude_system", session_id: "old", subtype: "init" },
        { t: "claude_result", costUsd: 1.5 },
        { t: "claude_system", session_id: "old", subtype: "init" },
        { t: "claude_result", costUsd: 2.25 },
      ]),
    ).toBe(2.25);
    // With nothing saying otherwise, one anonymous session: the maximum, never
    // the sum. A cumulative series read as separate charges is the bug.
    expect(
      reportedCostUsd([{ t: "claude_result", costUsd: 1.5 }, { t: "claude_result", costUsd: 2.25 }]),
    ).toBe(2.25);
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

  test("scanRunTotals reads sessions the same way the entry path does", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "wrathbench-pricing-cum-")), "trajectory.jsonl");
    writeFileSync(
      path,
      [
        JSON.stringify({ t: "meta", ts: 1 }),
        JSON.stringify({ t: "driver", ts: 2, driver: "claude-code" }),
        JSON.stringify({ t: "claude_system", ts: 3, subtype: "init", session_id: "s1" }),
        JSON.stringify({ t: "request", ts: 4, turn: 1, messages: [{ role: "user", content: "hi" }] }),
        JSON.stringify({ t: "response", ts: 5, turn: 1, message: { content: "ok" }, usage: { input_tokens: 10, output_tokens: 3 } }),
        JSON.stringify({ t: "claude_result", ts: 6, turn: 1, sessionId: "s1", costUsd: 0.95, durationMs: 2, usageRaw: { output_tokens: 900 } }),
        JSON.stringify({ t: "claude_result", ts: 7, turn: 2, sessionId: "s1", costUsd: 2.51, durationMs: 2, usageRaw: { output_tokens: 800 } }),
        JSON.stringify({ t: "claude_result", ts: 8, turn: 3, sessionId: "s1", costUsd: 4.35, durationMs: 2, usageRaw: { output_tokens: 700 } }),
        "",
      ].join("\n"),
    );
    const totals = await scanRunTotals(path);
    expect(totals.reportedCostUsd).toBe(4.35);
    // And the listing agrees with the run page, which reads the other path.
    const tail = new TrajectoryTail(path);
    expect(reportedCostUsd(await tail.scan())).toBe(4.35);
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

  test("OpenRouter's per-response cost sums, and the request side is not counted twice", () => {
    const entries = [
      { t: "request", ts: 1, usage: { prompt: 100, completion: 0, cost: 99 } },
      { t: "response", ts: 2, usage: { prompt: 100, completion: 10, cost: 0.0004 } },
      { t: "response", ts: 3, usage: { prompt: 120, completion: 8, cost: 0.0006 } },
    ];
    expect(reportedCostUsd(entries)).toBeCloseTo(0.001, 9);
  });

  test("coverage counts the responses that did and did not carry a charge", () => {
    expect(
      responseCostCoverage([
        { t: "response", ts: 1, usage: { prompt: 1, completion: 1, cost: 0.1 } },
        { t: "response", ts: 2, usage: { prompt: 1, completion: 1 } },
        { t: "request", ts: 3, usage: { prompt: 1, completion: 0, cost: 9 } },
        { t: "snippet", ts: 4 },
      ]),
    ).toEqual({ costed: 1, uncosted: 1 });
  });

  test("a driver that reports no cost per response leaves the run's actual blank", () => {
    expect(reportedCostUsd([{ t: "response", ts: 1, usage: { prompt: 10, completion: 2 } }])).toBeNull();
  });

  test("the tail summariser and scanRunTotals agree on a run of OpenRouter responses", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "wrathbench-pricing-")), "trajectory.jsonl");
    const lines = [
      JSON.stringify({ t: "meta", ts: 1 }),
      JSON.stringify({
        t: "response",
        ts: 2,
        message: { content: "ok" },
        usage: { prompt_tokens: 4947, completion_tokens: 121, cost: 0.000418 },
      }),
      JSON.stringify({
        t: "response",
        ts: 3,
        message: { content: "ok" },
        usage: { prompt_tokens: 4921, completion_tokens: 100, cost: 0.000402 },
      }),
      "",
    ];
    writeFileSync(path, lines.join("\n"));
    const totals = await scanRunTotals(path);
    expect(totals.reportedCostUsd).toBeCloseTo(0.00082, 9);
    expect(totals.responseCost).toEqual({ costed: 2, uncosted: 0 });
    // The run page walks `tail.entries` instead; both paths must land on the
    // same dollars or the two pages quote different bills for one run.
    const viaSummarize = lines
      .filter((l) => l.length > 0)
      .map((l, i) => summarize(JSON.parse(l) as Record<string, unknown>, i, 0, 0));
    expect(reportedCostUsd(viaSummarize)).toBeCloseTo(0.00082, 9);
  });
});
