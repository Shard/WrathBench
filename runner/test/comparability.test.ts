/**
 * The comparability tuple (ADR-0026).
 *
 * The load-bearing claims: a scored run's prompt hash is the fixed prompt's, an
 * objective run's is not, the tuple survives a JSON round trip through
 * meta.json, and the wire mirror in `runner/viewer/api-types.ts` still matches
 * the definition it mirrors — that last one is a type-level assertion, so it
 * fails at `tsc`/`bun test` parse time rather than at runtime.
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
import { SYSTEM_PROMPT } from "../src/prompt";
import { Trajectory, readMeta } from "../src/trajectory";
import type { ComparabilityView, EpisodeTierView } from "../viewer/api-types";

/* The mirror must stay assignable in both directions; see api-types.ts. */
const _toView: ComparabilityView = {} as Comparability;
/* Same rule for the episode table `/api/episodes` serves (ADR-0030). */
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
    expect(c.wikiCoords).toBe(false); // names-first by default (ADR-0028)
    expect(c.harness).toBe("wrathbench");
    expect(c.effort).toBeNull();
  });

  test("wikiCoords is stamped and separates otherwise identical runs (ADR-0028)", () => {
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

  test("an objective changes the prompt hash and raises the flag", () => {
    const c = comparabilityOf(
      loadRunConfig({ driver: "openai", model: "m", objective: "walk to Ironforge" }),
      "harness-0.2",
    );
    expect(c.objective).toBe(true);
    expect(c.promptHash).not.toBe(promptHash(SYSTEM_PROMPT));
    expect(c.promptChars).toBeGreaterThan(SYSTEM_PROMPT.length);
  });

  test("the claude-code driver stamps the claude-code harness (ADR-0035)", () => {
    const c = comparabilityOf(loadRunConfig({ driver: "claude-code" }), "v");
    expect(c.harness).toBe("claude-code");
    expect(comparabilityOf(loadRunConfig({ driver: "stub", stubScript: "x" }), "v").harness).toBe("wrathbench");
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
});

describe("harnessSeries (ADR-0034: the schedule keys on major.minor)", () => {
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
