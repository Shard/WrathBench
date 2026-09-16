/**
 * The comparability tuple.
 *
 * The load-bearing claims: a scored run's prompt hash is the fixed prompt's, an
 * objective run's is not, the tuple survives a JSON round trip through
 * meta.json, and the wire mirror in `runner/viewer/api-types.ts` still matches
 * the definition it mirrors.
 *
 * That last one is a type-level assertion, and it is caught by `bun run
 * typecheck` — NOT by `bun test`, which strips types without checking them.
 * Verified 2026-08-24 by adding a member to `EPISODE_IDS`: this file still
 * reported 16 pass, while tsc failed here and at `models.ts` in five places.
 * The pin is transitive rather than by name — `EpisodeTier.id` is an
 * `EpisodeId`, so pinning the tier to its view pins the id union too, which is
 * why grepping the tests for `EpisodeIdView` finds nothing.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  comparabilityOf,
  fetchServerBuild,
  parseComparability,
  promptHash,
  sameComparability,
  type Comparability, harnessSeries } from "../src/comparability";
import { loadRunConfig } from "../src/config";
import type { EpisodeTier } from "../src/episodes";
import { CLAUDE_CODE_SYSTEM_PROMPT, SYSTEM_PROMPT } from "../src/prompt";
import { Trajectory, readMeta } from "../src/trajectory";
import type { ComparabilityView, EpisodeTierView } from "../viewer/api-types";

/* The mirror must stay assignable in both directions; see api-types.ts. */
const _toView: ComparabilityView = {} as Comparability;
/* Same rule for the episode table `/api/episodes` serves. */
const _tierToView: EpisodeTierView = {} as EpisodeTier;
const _tierFromView: EpisodeTier = {} as EpisodeTierView;
void _tierToView;
void _tierFromView;

/**
 * Bun's `fetch` carries a `preconnect` static alongside the callable, which a
 * plain mock function lacks. This assigns a no-op stub so the mock is a
 * genuine (if partial) `typeof fetch`, rather than casting past the mismatch.
 */
function mockFetch(impl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>): typeof fetch {
  return Object.assign(impl, { preconnect: () => {} });
}
const _fromView: Comparability = {} as ComparabilityView;
void _toView;
void _fromView;

describe("comparabilityOf", () => {
  test("a plain run hashes the fixed prompt and reports no objective", () => {
    const c = comparabilityOf(loadRunConfig({ driver: "openai", model: "m" }), "harness-0.2");
    expect(c.harnessVersion).toBe("harness-0.2");
    expect(c.promptHash).toBe(promptHash(SYSTEM_PROMPT));
    expect(c.promptChars).toBe(SYSTEM_PROMPT.length);
    expect(c.objective).toBe(false);
    expect(c.wikiCoords).toBe(false); // names-first by default
    expect(c.harness).toBe("wrathbench");
    expect(c.effort).toBeNull();
  });

  test("wikiCoords is stamped and separates otherwise identical runs", () => {
    const base = loadRunConfig({ driver: "openai", model: "m" });
    const names = comparabilityOf(base, "v");
    const coords = comparabilityOf(loadRunConfig({ driver: "openai", model: "m", wikiCoords: true }), "v");
    expect(coords.wikiCoords).toBe(true);
    expect(coords.promptHash).toBe(names.promptHash); // the prompt itself is unchanged
    expect(sameComparability(names, coords)).toBe(false);
    expect(sameComparability(names, comparabilityOf(base, "v"))).toBe(true);
    // A tuple stamped before the field existed still parses; the field is absent.
    const { wikiCoords: _dropped, ...legacy } = names;
    void _dropped;
    expect(parseComparability(legacy)?.wikiCoords).toBeUndefined();
  });

  test("a run without the reference wiki is a different condition, stamped and hashed", () => {
    // Issue #61 / operator 2026-09-16: the wiki is a capability, on by default
    // and switchable off; off is a KEY, on is an absent field.
    const withWiki = comparabilityOf(loadRunConfig({ driver: "openai", model: "m" }), "v");
    const without = comparabilityOf(loadRunConfig({ driver: "openai", model: "m", wiki: false }), "v");
    expect(withWiki.wiki).toBeUndefined();
    expect(without.wiki).toBe(false);
    // The rendered prompt loses the tool's lines, so the hash moves with it.
    expect(without.promptHash).not.toBe(withWiki.promptHash);
    expect(without.promptChars).toBeLessThan(withWiki.promptChars);
    expect(sameComparability(withWiki, without)).toBe(false);
    // And a run that has the wiki stamps exactly what it stamped before the
    // field existed — byte-for-byte, key order included.
    expect(JSON.stringify(withWiki)).toBe(JSON.stringify({ ...withWiki }));
    expect(Object.keys(withWiki)).not.toContain("wiki");
    // `wiki` sits after `routing`, so no already-stamped tuple reorders.
    expect(Object.keys(without).at(-1)).toBe("wiki");
    expect(parseComparability(without)?.wiki).toBe(false);
  });

  test("the wiki bundle's identity is annotated, and a rebuild is not the same tuple", () => {
    const config = loadRunConfig({ driver: "openai", model: "m" });
    // No bundle at all: null, never an absent field on a fresh stamp.
    expect(comparabilityOf(config, "v").wikiBundle).toBeNull();

    const wrath = {
      schemaVersion: "5",
      builtAt: "2026-08-24T09:00:00.000Z",
      source: "dump.7z",
      eraCutoff: "2010-10-12",
    };
    const c = comparabilityOf(config, "v", null, wrath);
    expect(c.wikiBundle).toEqual(wrath);
    // Same dump, rebuilt: `built_at` moves, so the tuples are not identical and
    // a resume restamps. `sameComparability` is stricter than series grouping.
    const rebuilt = comparabilityOf(config, "v", null, { ...wrath, builtAt: "2026-08-24T18:00:00.000Z" });
    expect(sameComparability(c, rebuilt)).toBe(false);
    // A bundle that predates the era channel keeps working: eraCutoff is null,
    // never back-labelled as "no cutoff applied".
    const old = comparabilityOf(config, "v", null, { ...wrath, eraCutoff: null });
    expect(parseComparability(JSON.parse(JSON.stringify(old)))?.wikiBundle?.eraCutoff).toBeNull();
    // A tuple stamped before the field existed still parses whole.
    const { wikiBundle: _dropped, ...legacy } = c;
    void _dropped;
    const back = parseComparability(legacy);
    expect(back?.wikiBundle).toBeUndefined();
    expect(back?.promptHash).toBe(c.promptHash);
    // A malformed annotation must not erase the rest of the tuple... it does
    // (parseComparability is all-or-nothing), so the schema stays permissive:
    // every field nullable, nothing parsed into a number.
    expect(parseComparability({ ...c, wikiBundle: { ...wrath, schemaVersion: 5 } })).toBeNull();
  });

  test("an objective changes the prompt hash and raises the flag", () => {
    const c = comparabilityOf(
      loadRunConfig({ driver: "openai", model: "m", objective: "walk to Ironforge" }),
      "harness-0.2",
    );
    expect(c.objective).toBe(true);
    expect(c.promptHash).not.toBe(promptHash(SYSTEM_PROMPT));
    expect(c.promptChars).toBeGreaterThan(SYSTEM_PROMPT.length);
  });

  test("the claude-code driver stamps the claude-code harness", () => {
    const c = comparabilityOf(loadRunConfig({ driver: "claude-code" }), "v");
    expect(c.harness).toBe("claude-code");
    expect(comparabilityOf(loadRunConfig({ driver: "stub", stubScript: "x" }), "v").harness).toBe("wrathbench");
  });

  test("the prompt hash is per harness: the two drivers are not sent the same text", () => {
    // The prompt's sentence about older conversation is the harness's own
    // (item 8): the fixed loop trims, the CLI does not. The tuple has to show
    // that the bytes differed, not just that the loop did — otherwise a
    // cross-driver cost or score comparison looks like it is over one prompt.
    const loop = comparabilityOf(loadRunConfig({ driver: "openai", model: "m" }), "v");
    const cli = comparabilityOf(loadRunConfig({ driver: "claude-code", model: "m" }), "v");
    expect(loop.promptHash).toBe(promptHash(SYSTEM_PROMPT));
    expect(cli.promptHash).toBe(promptHash(CLAUDE_CODE_SYSTEM_PROMPT));
    expect(cli.promptHash).not.toBe(loop.promptHash);
    expect(cli.promptChars).toBe(CLAUDE_CODE_SYSTEM_PROMPT.length);
    expect(cli.promptChars).not.toBe(loop.promptChars);
    expect(sameComparability(loop, cli)).toBe(false);
  });

  test("a tuple without a harness is not recorded; a pre-0.4 contextEngine is not a harness", () => {
    const base = comparabilityOf(loadRunConfig({ driver: "openai", model: "m" }), "v");
    const { harness: _h, ...rest } = base;
    expect(parseComparability({ ...rest, contextEngine: "external-scaffold-claude-cli" })).toBeNull();
    expect(parseComparability(rest)).toBeNull();
  });

  test("the budget is the effective one, disabled watchdogs included", () => {
    const c = comparabilityOf(
      loadRunConfig({
        driver: "openai",
        maxTurns: 12,
        maxToolCallsPerEpisode: 900,
        effort: "high",
        // `0` is argv's spelling of "disable"; the tuple must record the null.
        watchdogs: { noXpMs: 0, idleMs: 60_000 },
      }),
      "v",
    );
    expect(c.budget).toEqual({
      maxTurns: 12,
      maxToolCalls: 900,
      idleMs: 60_000,
      noXpMs: null,
      episodeMs: 6 * 60 * 60_000,
      maxSandboxRestarts: 3,
    });
    expect(c.effort).toBe("high");
  });

  test("a disabled tool-call ceiling is recorded as null, the same spelling a disabled watchdog uses", () => {
    // The policy freeplay lane. The tuple has to carry it, because "no
    // ceiling" and "a 500-call ceiling" are two different budgets and a run
    // that silently changed between them would be comparable to itself.
    const c = comparabilityOf(loadRunConfig({ driver: "claude-code", episode: "freeplay", maxToolCallsPerEpisode: null }), "v");
    expect(c.budget.maxToolCalls).toBeNull();
    // And it round-trips: a stored tuple with a null ceiling still parses.
    expect(parseComparability(JSON.parse(JSON.stringify(c)))?.budget.maxToolCalls).toBeNull();
  });
});

describe("fetchServerBuild", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("a reachable /health stamps build and startedAtMs", async () => {
    globalThis.fetch = mockFetch(async () =>
      new Response(JSON.stringify({ build: "harness-0.2-3-gabc123", startedAtMs: 555, uptimeMs: 1 }), {
        status: 200,
      }),
    );
    expect(await fetchServerBuild("http://module:8086")).toEqual({
      build: "harness-0.2-3-gabc123",
      startedAtMs: 555,
    });
  });

  test("an unreachable module never blocks launch — reads null, does not throw", async () => {
    globalThis.fetch = mockFetch(async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(fetchServerBuild("http://module:8086")).resolves.toBeNull();
  });

  test("a module that predates the field (no build/startedAtMs) also reads null", async () => {
    globalThis.fetch = mockFetch(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    expect(await fetchServerBuild("http://module:8086")).toBeNull();
  });
});

describe("meta.json stamping (run.ts's launch/resume-restamp path)", () => {
  let dir: string;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wrathbench-comparability-meta-"));
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
  });

  test("a reachable module's build ends up in meta.json's comparability tuple", async () => {
    globalThis.fetch = mockFetch(async () =>
      new Response(JSON.stringify({ build: "harness-0.3-1-gdead", startedAtMs: 42, uptimeMs: 9 }), {
        status: 200,
      }),
    );
    const config = loadRunConfig({ runId: "meta-stamp-test", driver: "openai", model: "m" });
    const serverBuild = await fetchServerBuild(config.moduleUrl);
    const comparability = comparabilityOf(config, "harness-0.3", serverBuild);

    const trajectory = new Trajectory(dir);
    trajectory.writeMeta({
      runId: "meta-stamp-test",
      harnessVersion: "harness-0.3",
      startedAt: Date.now(),
      config,
      comparability,
    });
    trajectory.close();

    const meta = readMeta(dir);
    const parsed = parseComparability(meta?.comparability);
    expect(parsed?.serverBuild).toEqual({ build: "harness-0.3-1-gdead", startedAtMs: 42 });
  });

  test("an unreachable module at launch stamps a null serverBuild, never blocking the write", async () => {
    globalThis.fetch = mockFetch(async () => {
      throw new Error("ECONNREFUSED");
    });
    const config = loadRunConfig({ runId: "meta-stamp-unreachable", driver: "openai", model: "m" });
    const serverBuild = await fetchServerBuild(config.moduleUrl);
    const comparability = comparabilityOf(config, "harness-0.3", serverBuild);

    const trajectory = new Trajectory(dir);
    trajectory.writeMeta({
      runId: "meta-stamp-unreachable",
      harnessVersion: "harness-0.3",
      startedAt: Date.now(),
      config,
      comparability,
    });
    trajectory.close();

    const meta = readMeta(dir);
    expect(parseComparability(meta?.comparability)?.serverBuild).toBeNull();
  });
});

describe("parseComparability", () => {
  test("round-trips through JSON, the way meta.json stores it", () => {
    const c = comparabilityOf(loadRunConfig({ driver: "openai", effort: "low" }), "v");
    const back = parseComparability(JSON.parse(JSON.stringify(c)));
    expect(back).toEqual(c);
    expect(sameComparability(c, back!)).toBe(true);
  });

  test("a missing or malformed tuple reads as not recorded, never as an error", () => {
    expect(parseComparability(undefined)).toBeNull();
    expect(parseComparability({ harnessVersion: "v" })).toBeNull();
    expect(parseComparability("nonsense")).toBeNull();
  });

  test("a different budget is a different tuple", () => {
    const a = comparabilityOf(loadRunConfig({ driver: "openai" }), "v");
    const b = comparabilityOf(loadRunConfig({ driver: "openai", maxToolCallsPerEpisode: 9 }), "v");
    expect(sameComparability(a, b)).toBe(false);
  });

  test("no ceiling is a different budget from the 500-call default", () => {
    // What the resume migration changes, and why it restamps: a6 came back
    // under a budget it had not been running under, and that is a tuple
    // difference the run has to record rather than absorb.
    const capped = comparabilityOf(loadRunConfig({ driver: "openai" }), "v");
    const uncapped = comparabilityOf(loadRunConfig({ driver: "openai", maxToolCallsPerEpisode: null }), "v");
    expect(capped.budget.maxToolCalls).toBe(500);
    expect(uncapped.budget.maxToolCalls).toBeNull();
    expect(sameComparability(capped, uncapped)).toBe(false);
  });
});

describe("harnessSeries (the schedule keys on major.minor)", () => {
  test("git-describe stamps, tagged or not, dirty or not, reduce to the series", () => {
    expect(harnessSeries("harness-0.3-114-gda93f0a-dirty")).toBe("0.3");
    expect(harnessSeries("harness-0.3-133-g6e4b5bb")).toBe("0.3");
    expect(harnessSeries("harness-0.2-33-g9bba93b-dirty")).toBe("0.2");
    expect(harnessSeries("harness-1.10")).toBe("1.10");
    expect(harnessSeries("harness-0.3-test")).toBe("0.3");
    // The host-side wrapper version.ts produces around a describe.
    expect(harnessSeries("0.0.0-phase0+gharness-0.3-133-g6e4b5bb-dirty")).toBe("0.3");
  });
  test("no recognisable series reads as null, never as a guess", () => {
    expect(harnessSeries("0.0.0-phase0-unversioned")).toBeNull();
    expect(harnessSeries("0.0.0-phase0+gabc1234")).toBeNull();
    expect(harnessSeries("gabc1234")).toBeNull();
    expect(harnessSeries(null)).toBeNull();
    expect(harnessSeries(undefined)).toBeNull();
    expect(harnessSeries("")).toBeNull();
  });
});

describe("the resolved model id", () => {
  test("annotates the tuple but is not compared: a filled one still equals its launch stamp", () => {
    const config = loadRunConfig({ driver: "claude-code", model: "sonnet" });
    const launched = comparabilityOf(config, "v");
    // Stamped at launch with nothing: the CLI has not spoken yet.
    expect(launched.resolvedModel).toBeUndefined();
    const observed: Comparability = { ...launched, resolvedModel: "claude-sonnet-5" };
    // Filling it in mid-episode must not read as a restamp on the next resume —
    // it is observed, not stamped, so it sits outside the comparison.
    expect(sameComparability(launched, observed)).toBe(true);
    expect(sameComparability(observed, { ...observed, resolvedModel: "claude-opus-5" })).toBe(true);
    // ...while a stamped field still separates two tuples.
    expect(sameComparability(observed, { ...observed, effort: "high" })).toBe(false);
    // And it survives the round trip through meta.json like any other field.
    expect(parseComparability(JSON.parse(JSON.stringify(observed)))?.resolvedModel).toBe("claude-sonnet-5");
  });
});
