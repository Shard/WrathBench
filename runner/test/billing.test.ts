/**
 * The reader's billing verdict (`runner/src/billing.ts`).
 *
 * The one thing this file exists to pin: `claude-code` is PAID here and FREE in
 * the scheduler's `billingOf`. Those are different questions, and a change that
 * collapses them would silently re-scope the fleet's paid-concurrency cap — so
 * both sides are asserted together, in one table.
 */

import { describe, expect, test } from "bun:test";
import { entryBilling, runBilling } from "../src/billing";
import { loadRunConfig } from "../src/config";
import { credentialCandidates, parseCredentials } from "../src/credential-slots";
import { billingOf } from "../src/model-cost";
import { DEFAULT_POLICY, outstandingWork, projectModel, type RosterModel } from "../src/models";
import { configFromArgs } from "../src/run";
import { rowOf } from "../../viewer/models";

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

/*
 * Free means literally free to a reader (operator, 2026-11-16): one row per
 * lane, the reader's verdict beside the scheduler's, which must not move.
 */
const GO = "https://opencode.ai/inference/go/openai/v1";
const ZEN = "https://opencode.ai/zen/v1";
const LANES: { lane: string; entry: Omit<RosterModel, "tier">; reader: "free" | "paid"; scheduler: "free" | "paid" }[] = [
  { lane: "claude-code subscription", entry: { name: "sub-opus", model: "claude-opus-5-5", driver: "claude-code" }, reader: "paid", scheduler: "free" },
  { lane: "codex subscription", entry: { name: "codex-sol", model: "gpt-6.1-sol", driver: "codex" }, reader: "paid", scheduler: "free" },
  { lane: "OpenCode Go usage", entry: { name: "ds-go", model: "deepseek-v4.1-flash", apiBase: GO }, reader: "paid", scheduler: "paid" },
  { lane: "OpenCode Go -free", entry: { name: "go-free", model: "hy3-free", apiBase: GO }, reader: "free", scheduler: "free" },
  { lane: "OpenRouter paid", entry: { name: "ds-or", model: "deepseek/deepseek-v4.1-flash" }, reader: "paid", scheduler: "paid" },
  { lane: "OpenRouter :free", entry: { name: "nemo", model: "nvidia/nemotron-3-super-120b-a12b:free" }, reader: "free", scheduler: "free" },
  { lane: "OpenCode Zen -free", entry: { name: "zen-free", model: "laguna-s-2.1-free", apiBase: ZEN }, reader: "free", scheduler: "free" },
  { lane: "contributor-free", entry: { name: "muse", model: "muse-spark-1.2-contributor-free", apiBase: ZEN }, reader: "free", scheduler: "free" },
  { lane: "local hardware", entry: { name: "box", model: "qwen3.8-27b", apiBase: "http://192.168.1.21:8000/v1" }, reader: "free", scheduler: "free" },
  { lane: "declared free (a stealth id)", entry: { name: "bunny", model: "stealth/space-bunny-alpha", billing: "free" }, reader: "free", scheduler: "free" },
  { lane: "declared paid on a :free id", entry: { name: "paid-free", model: "x/y:free", billing: "paid" }, reader: "paid", scheduler: "paid" },
];

describe("the reader's verdict, lane by lane", () => {
  const NOW = 1_800_000_000_000;
  for (const l of LANES) {
    test(`${l.lane}: ${l.reader} to a reader, ${l.scheduler} to the scheduler`, () => {
      const state = projectModel({ tier: "t1", ...l.entry }, [], DEFAULT_POLICY, { now: NOW });
      // The scheduler's verdict is unchanged: the projection still stamps it.
      expect(state.billing).toBe(l.scheduler);
      // The models page and the public snapshot read the reader's.
      expect(entryBilling(state)).toBe(l.reader);
      expect(rowOf(state, [], "/nowhere").billing).toBe(l.reader);
      // And a run of the entry reads the same as its row.
      expect(
        runBilling({
          model: l.entry.model,
          apiBase: l.entry.apiBase ?? null,
          platform: state.platform,
          harness: state.harness,
          driver: state.driver ?? null,
          declaredBilling: l.entry.billing ?? null,
        }),
      ).toBe(l.reader);
    });
  }
});

describe("a subscription lane's scheduling is the scheduler's verdict, not the reader's", () => {
  const NOW = 1_800_000_000_000;
  const credentials = parseCredentials({
    "claude-1": { provider: "claude", secretEnv: "CLAUDE_CODE_OAUTH_TOKEN", slots: 1, billing: "paid", enabled: true },
    "or-free": { provider: "openrouter", secretEnv: "OPENROUTER_KEY", slots: 2, billing: "free", enabled: true },
    "or-paid": { provider: "openrouter", secretEnv: "OPENROUTER_KEY", slots: 1, billing: "paid", enabled: true },
    "go-free": { provider: "opencode-go", secretEnv: "OPENCODE_KEY", slots: 1, billing: "free", enabled: true },
    "go-paid": { provider: "opencode-go", secretEnv: "OPENCODE_KEY", slots: 1, budget: { kind: "usage" }, billing: "paid", enabled: true },
  });

  test("credentials: a subscription takes its own, a Go slug the side of its slug", () => {
    expect(credentialCandidates(credentials, { model: "claude-opus-5-5", driver: "claude-code" }).candidates.map((c) => c.id)).toEqual(["claude-1"]);
    expect(credentialCandidates(credentials, { model: "deepseek-v4.1-flash", apiBase: GO }).candidates.map((c) => c.id)).toEqual(["go-paid"]);
    expect(credentialCandidates(credentials, { model: "hy3-free", apiBase: GO }).candidates.map((c) => c.id)).toEqual(["go-free"]);
  });

  test("outstanding work groups a claude-code entry under its provider, as before", () => {
    const st = (e: Omit<RosterModel, "tier">) => projectModel({ tier: "t1", ...e }, [], DEFAULT_POLICY, { now: NOW });
    const states = [st({ name: "sub-opus", model: "claude-opus-5-5", driver: "claude-code" }), st({ name: "ds-go", model: "deepseek-v4.1-flash", apiBase: GO })];
    const o = outstandingWork({ states, excluded: [], accounts: 4, credentials, maxSessions: {} });
    expect(o.breakdown.map((b) => b.group).sort()).toEqual(["claude", "opencode-go (paid)"]);
  });
});
