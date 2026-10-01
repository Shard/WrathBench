/**
 * New models as drafts (GitHub issue #66), below the routes: the `proposed/`
 * key space in the config store, the catalogue read, what a fetch does to the
 * drafts, and the estimate. The routes, and the proof that nothing public
 * carries a draft, are `viewer-config-drafts.test.ts`.
 *
 * Fixture-based throughout. The catalogue is `fixtures/openrouter-models.json`
 * served by an injected fetcher, so nothing here touches the network.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseFleet } from "../../infra/run-fleet-config";
import {
  ConfigRejected,
  ConfigStore,
  DraftRefused,
  isConfigKey,
  proposedKey,
  readFleetConfig,
  renderFleet,
  splitFleet,
} from "../src/config-store";
import { DEFAULT_POLICY, type RunFact, type SchedulingPolicy } from "../src/models";
import type { E90TokenProfileView, TokenTotals } from "../viewer/api-types";
import {
  CATALOGUE_URL,
  CatalogueError,
  draftRecordOf,
  e90TokenProfile,
  estimateUsd,
  parseCatalogue,
  readCatalogue,
  reconcileDrafts,
  suggestedRosterName,
  type DraftRecord,
} from "../viewer/drafts";
import { CATALOGUE_TEXT, CONFIG, PENDING, ROSTER_MODEL, catalogueFetch, fleetOf, seededStore as seeded, storeFacts } from "./fixtures/drafts";
import { tempDirs } from "./fixtures/temp-dirs";

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

  test("renderFleet renders draft rows out even when handed them, so an older reader cannot see one", () => {
    const rows = splitFleet(CONFIG);
    const withDrafts = [...rows, { key: proposedKey("z-ai/glm-6"), ord: 0, value: { ...PENDING }, updatedAt: 0 }];
    expect(renderFleet(withDrafts)).toEqual(renderFleet(rows));
    expect(parseFleet(renderFleet(withDrafts))).toEqual(parseFleet(renderFleet(rows)));
  });

  test("the generic write path cannot reach a draft", () => {
    expect(isConfigKey("proposed/z-ai/glm-6")).toBe(false);
    const db = seededStore();
    const store = new ConfigStore(db);
    expect(() => store.put("proposed/glm", { status: "draft" })).toThrow(ConfigRejected);
    store.close();
  });

  test("a store holding only drafts still reads as empty, not as an empty config", () => {
    const db = join(tempDir("drafts-empty-"), "config.sqlite");
    const store = new ConfigStore(db);
    store.writeDrafts({ put: [{ model: "z-ai/glm-6", value: { ...PENDING } }] });
    expect(store.isEmpty()).toBe(true);
    store.close();
    expect(readFleetConfig(db).status).toBe("empty");
  });

  test("the store refuses a second entry for a model the roster already runs", () => {
    const db = seededStore();
    const store = new ConfigStore(db);
    store.writeDrafts({ put: [{ model: ROSTER_MODEL, value: { status: "draft", firstSeen: 1 } }] });
    expect(() => store.promote(ROSTER_MODEL, "nemo-2", { model: ROSTER_MODEL, tier: "t0" })).toThrow(DraftRefused);
    store.close();
  });

  test("a reseed replaces the config and keeps the drafts, so an ignore survives it", () => {
    const db = seededStore();
    const store = new ConfigStore(db);
    store.writeDrafts({ put: [{ model: "fixturelab/mystery-7b", value: { status: "ignored", firstSeen: 1 } }] });
    store.seed({ ...CONFIG, roster: { nemo: CONFIG.roster.nemo } }, { force: true, actor: "fixture" });
    expect(store.draft("fixturelab/mystery-7b")).toEqual({ status: "ignored", firstSeen: 1 });
    expect(Object.keys(store.render()["roster"] as object)).toEqual(["nemo"]);
    store.close();
  });
});

// ------------------------------------------------------------- the catalogue

describe("reading the catalogue", () => {
  test("rows parse to drafts' fields; a row that does not fit is skipped and counted", () => {
    const read = parseCatalogue(CATALOGUE_TEXT);
    expect(read.skipped).toBe(1);
    const glm = read.models.find((m) => m.id === "z-ai/glm-6")!;
    expect(glm).toEqual({
      id: "z-ai/glm-6",
      name: "Z.AI: GLM 6",
      created: 1_790_000_000_000,
      tools: true,
      // Per million, through the price sync's own reading; no write tier quoted, so writes bill as input.
      price: { input: 0.6, output: 2.2, cacheRead: 0.11, cacheWrite: 0.6 },
    });
    expect(read.models.find((m) => m.id === "fixturelab/chat-only")!.tools).toBe(false);
    // A router's "-1" is not a price.
    expect(read.models.find((m) => m.id === "openrouter/auto")!.price).toBeNull();
  });

  test("an answer that is not the catalogue's shape is refused in a sentence", () => {
    expect(() => parseCatalogue("<html>")).toThrow(CatalogueError);
    expect(() => parseCatalogue(JSON.stringify({ models: [] }))).toThrow(/data/);
  });

  test("one GET of the catalogue URL, and nothing else", async () => {
    const f = catalogueFetch();
    const read = await readCatalogue(f.fetch);
    expect(f.calls).toEqual([CATALOGUE_URL]);
    expect(read.models.length).toBe(7);
  });

  test("a non-200 is refused with its status", async () => {
    const f = (async () => new Response("nope", { status: 503 })) as unknown as typeof globalThis.fetch;
    await expect(readCatalogue(f)).rejects.toThrow(/HTTP 503/);
  });

  test("a catalogue that never answers is given up on, even by a fetcher that ignores the abort", async () => {
    const hang = (() => new Promise<Response>(() => {})) as unknown as typeof globalThis.fetch;
    await expect(readCatalogue(hang, { timeoutMs: 20 })).rejects.toThrow(/did not answer/);
  });

  test("a body past the byte bound is refused, declared or streamed", async () => {
    const big = "x".repeat(4096);
    const declared = (async () =>
      new Response(big, { status: 200, headers: { "content-length": String(big.length) } })) as unknown as typeof globalThis.fetch;
    await expect(readCatalogue(declared, { maxBytes: 100 })).rejects.toThrow(/bound/);
    const streamed = (async () =>
      new Response(
        new ReadableStream({
          start(c) {
            for (let i = 0; i < 8; i++) c.enqueue(new TextEncoder().encode(big));
            c.close();
          },
        }),
        { status: 200 },
      )) as unknown as typeof globalThis.fetch;
    await expect(readCatalogue(streamed, { maxBytes: 100 })).rejects.toThrow(/bound/);
  });

  test("a network failure comes back as a catalogue error, not a crash", async () => {
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof globalThis.fetch;
    await expect(readCatalogue(down)).rejects.toThrow(/could not read the catalogue: fetch failed/);
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

  test("a pending draft's price is refreshed in place, keeping when it was first proposed", () => {
    const stale: DraftRecord = { ...PENDING, price: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } };
    const r = reconcileDrafts({ catalogue, existing: [stale], roster, now: 6 });
    expect(r.report.refreshed).toBe(1);
    expect(r.put.find((d) => d.model === "z-ai/glm-6")).toEqual({ ...PENDING, firstSeen: 1 });
  });

  test("a draft for a model the roster now runs is dropped; one missing from this read is left alone", () => {
    const gone: DraftRecord = { ...PENDING, model: "fixturelab/delisted" };
    const r = reconcileDrafts({ catalogue, existing: [PENDING, gone], roster: new Set([...roster, "z-ai/glm-6"]), now: 6 });
    expect(r.remove).toEqual(["z-ai/glm-6"]);
    expect(r.report.removed).toEqual(["z-ai/glm-6"]);
  });

  test("a stored row reads back to the record it was written from", () => {
    expect(draftRecordOf({ key: proposedKey("z-ai/glm-6"), value: { ...PENDING } })).toEqual(PENDING);
    expect(draftRecordOf({ key: "roster/x", value: {} })).toBeNull();
  });

  test("the suggested roster name is the slug, in roster-name characters", () => {
    expect(suggestedRosterName("z-ai/glm-6:free")).toBe("glm-6-free");
    expect(suggestedRosterName("fixturelab/Mystery 7B")).toBe("mystery-7b");
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
    subscription: null,
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

  test("no counted e90 to take a profile from is no profile, not a made-up one", () => {
    expect(e90TokenProfile([], POLICY)).toBeNull();
    expect(e90TokenProfile([{ fact: fact({ live: true }), harness: "wrathbench", tokens: tokens(1, 1, 0) }], POLICY)).toBeNull();
  });

  test("list price applied to the profile, through costOf: cache reads come out of the prompt", () => {
    const profile: E90TokenProfileView = { runs: 3, series: "s", promptTokens: 1_000_000, completionTokens: 100_000, cacheReadTokens: 400_000 };
    // 600k fresh at $1 + 100k out at $2 + 400k cached at $0.10, per million.
    expect(estimateUsd({ input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 }, profile)).toBeCloseTo(0.84, 10);
    expect(estimateUsd(null, profile)).toBeNull();
    expect(estimateUsd({ input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 }, null)).toBeNull();
  });
});
