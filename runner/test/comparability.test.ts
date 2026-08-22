/**
 * The comparability tuple (ADR-0026).
 *
 * The load-bearing claims: a scored run's prompt hash is the fixed prompt's, an
 * objective run's is not, the tuple survives a JSON round trip through
 * meta.json, and the wire mirror in `runner/viewer/api-types.ts` still matches
 * the definition it mirrors — that last one is a type-level assertion, so it
 * fails at `tsc`/`bun test` parse time rather than at runtime.
 */

import { describe, expect, test } from "bun:test";
import {
  CONTEXT_ENGINES,
  comparabilityOf,
  parseComparability,
  promptHash,
  sameComparability,
  type Comparability,
} from "../src/comparability";
import { loadRunConfig } from "../src/config";
import { SYSTEM_PROMPT } from "../src/prompt";
import type { ComparabilityView } from "../viewer/api-types";

/* The mirror must stay assignable in both directions; see api-types.ts. */
const _toView: ComparabilityView = {} as Comparability;
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
    expect(c.contextEngine).toBe(CONTEXT_ENGINES.openai);
    expect(c.effort).toBeNull();
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

  test("the claude driver is a different context engine", () => {
    const c = comparabilityOf(loadRunConfig({ driver: "claude-subscription" }), "v");
    expect(c.contextEngine).toBe(CONTEXT_ENGINES["claude-subscription"]);
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
