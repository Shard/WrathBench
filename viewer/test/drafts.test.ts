/**
 * New models as drafts (GitHub issue #66), below the routes: the `proposed/`
 * key space in the config store, what a fetch does to the drafts, and the
 * estimate. The routes, and the proof that nothing public
 * carries a draft, are `viewer-config-drafts.test.ts`.
 *
 * Fixture-based throughout. The catalogue is `fixtures/openrouter-models.json`
 * served by an injected fetcher, so nothing here touches the network.
 */

import { describe, expect, test } from "bun:test";
import { ConfigRejected, ConfigStore, isConfigKey, proposedKey } from "../../runner/src/config-store";
import { DEFAULT_POLICY, type SchedulingPolicy } from "../../runner/src/models";
import type { RunFact } from "../../runner/src/run-fact";
import type { TokenTotals } from "../api-types";
import type { E90TokenProfileView } from "../api-types-admin";
import {
  e90TokenProfile,
  estimateUsd,
  parseCatalogue,
  reconcileDrafts,
  type DraftRecord,
} from "../drafts";
import { CATALOGUE_TEXT, CONFIG, PENDING, ROSTER_MODEL, fleetOf, seededStore as seeded, storeFacts } from "../../runner/test/fixtures/drafts";
import { tempDirs } from "../../runner/test/fixtures/temp-dirs";

const tempDir = tempDirs();
const seededStore = (config: unknown = CONFIG): string => seeded(tempDir, config);

// ------------------------------------------------------------- the key space

describe("the proposed/ key space is invisible to the config", () => {
  test("the fleet's parsed config is identical with and without drafts present", () => {
    const db = seededStore();
    const before = fleetOf(db);
    const facts = storeFacts(db);
    const store = new ConfigStore(db);
    store.writeDrafts({
      put: [
        { model: "z-ai/glm-6", value: { ...PENDING } },
        { model: "fixturelab/mystery-7b", value: { model: "fixturelab/mystery-7b", status: "ignored", firstSeen: 1 } },
      ],
    });
    expect(store.drafts().map((r) => r.key)).toEqual([proposedKey("fixturelab/mystery-7b"), proposedKey("z-ai/glm-6")]);
    expect(store.rows().some((r) => r.key.startsWith("proposed"))).toBe(false);
    store.close();
    // What the supervisor reads, byte for byte and parsed; and no history moved.
    expect(fleetOf(db)).toEqual(before);
    expect(storeFacts(db)).toEqual(facts);
  });

  test("the generic write path cannot reach a draft", () => {
    expect(isConfigKey("proposed/z-ai/glm-6")).toBe(false);
    const db = seededStore();
    const store = new ConfigStore(db);
    expect(() => store.put("proposed/glm", { status: "draft" })).toThrow(ConfigRejected);
    store.close();
  });
});

// ------------------------------------------------------------- the reconcile

describe("what a fetch does to the drafts", () => {
  const catalogue = parseCatalogue(CATALOGUE_TEXT);
  const roster = new Set([ROSTER_MODEL, "sonnet"]);

  test("every tool-calling model the roster does not run is proposed; free and paid alike", () => {
    const r = reconcileDrafts({ catalogue, existing: [], roster, now: 5 });
    expect(r.report.added.sort()).toEqual(
      ["anthropic/claude-fixture-5", "fixturelab/mystery-7b", "openrouter/auto", "z-ai/glm-6", "z-ai/glm-6:free"].sort(),
    );
    expect(r.report.toolModels).toBe(6);
    expect(r.put.every((d) => d.status === "draft" && d.firstSeen === 5)).toBe(true);
  });

  test("a second fetch of the same catalogue writes nothing", () => {
    const first = reconcileDrafts({ catalogue, existing: [], roster, now: 5 });
    const second = reconcileDrafts({ catalogue, existing: first.put, roster, now: 6 });
    expect(second.put).toEqual([]);
    expect(second.remove).toEqual([]);
    expect(second.report.added).toEqual([]);
    expect(second.report.refreshed).toBe(0);
  });

  test("an ignored model is never brought back, and keeps its record as it was", () => {
    const ignored: DraftRecord = { ...PENDING, status: "ignored", price: null, ignoredAt: 9, ignoredBy: "mark" };
    const r = reconcileDrafts({ catalogue, existing: [ignored], roster, now: 6 });
    expect(r.put.find((d) => d.model === "z-ai/glm-6")).toBeUndefined();
    expect(r.report.added).not.toContain("z-ai/glm-6");
  });
});

// ------------------------------------------------------------- the estimate

function fact(over: Partial<RunFact>): RunFact {
  return {
    runId: "r",
    model: "m",
    effort: null,
    episode: "e90",
    episodeOverride: false,
    harnessVersion: "harness-0.5-800",
    harnessSeries: "harness-0.5",
    extra: false,
    startedAt: 0,
    endedAt: 1,
    terminationReason: "episode-limit",
    modelResponses: 50,
    bestLevel: 4,
    live: false,
    pause: null,
    account: null,
    character: null,
    episodeMs: null,
    campaign: null,
    cell: null,
    credential: null,
    ...over,
  };
}

function tokens(prompt: number, completion: number, cacheRead: number | null, source: TokenTotals["source"] = "reported"): TokenTotals {
  return {
    source,
    contextTokens: 0,
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: prompt + completion,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: null,
    turns: 10,
  };
}

const POLICY: SchedulingPolicy = { ...DEFAULT_POLICY, series: "harness-0.5" };

describe("the e90 estimate", () => {
  test("the profile is the median counted e90 of this series on the wrathbench harness, reported tokens only", () => {
    const runs = [
      { fact: fact({ runId: "a" }), harness: "wrathbench", tokens: tokens(1_000_000, 100_000, 400_000) },
      { fact: fact({ runId: "b" }), harness: "wrathbench", tokens: tokens(3_000_000, 300_000, null) },
      { fact: fact({ runId: "c" }), harness: "wrathbench", tokens: tokens(2_000_000, 200_000, 600_000) },
      // Each of these is out, for its own reason.
      { fact: fact({ runId: "cli" }), harness: "claude-code", tokens: tokens(90_000_000, 1, 89_000_000) },
      { fact: fact({ runId: "est" }), harness: "wrathbench", tokens: tokens(90_000_000, 1, 0, "estimated") },
      { fact: fact({ runId: "old", harnessSeries: "harness-0.4" }), harness: "wrathbench", tokens: tokens(90_000_000, 1, 0) },
      { fact: fact({ runId: "x", extra: true }), harness: "wrathbench", tokens: tokens(90_000_000, 1, 0) },
      { fact: fact({ runId: "long", episode: "e360" }), harness: "wrathbench", tokens: tokens(90_000_000, 1, 0) },
      { fact: fact({ runId: "live", live: true }), harness: "wrathbench", tokens: tokens(90_000_000, 1, 0) },
      { fact: fact({ runId: "none" }), harness: "wrathbench", tokens: null },
    ];
    expect(e90TokenProfile(runs, POLICY)).toEqual({
      runs: 3,
      series: "harness-0.5",
      promptTokens: 2_000_000,
      completionTokens: 200_000,
      // A run whose provider never reported cache reads reads as none, as `costOf` reads it.
      cacheReadTokens: 400_000,
    });
  });

  test("list price applied to the profile, through costOf: cache reads come out of the prompt", () => {
    const profile: E90TokenProfileView = { runs: 3, series: "s", promptTokens: 1_000_000, completionTokens: 100_000, cacheReadTokens: 400_000 };
    // 600k fresh at $1 + 100k out at $2 + 400k cached at $0.10, per million.
    expect(estimateUsd({ input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 }, profile)).toBeCloseTo(0.84, 10);
    expect(estimateUsd(null, profile)).toBeNull();
    expect(estimateUsd({ input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 }, null)).toBeNull();
  });
});
