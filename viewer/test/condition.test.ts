import { describe, expect, test } from "bun:test";
import { chartGroupOf, conditionKey, conditionOf, type ConditionFacts } from "../condition";
import { OPENCODE_GO_ROUTING } from "../../runner/src/routing";

const facts = (tuple: ConditionFacts["tuple"], over: Partial<ConditionFacts> = {}): ConditionFacts => ({
  series: "0.5",
  episode: "e90",
  harness: "wrathbench",
  tuple,
  ...over,
});

describe("conditionKey — one string per condition", () => {
  test("every dimension of the operator's key separates two runs", () => {
    const base = conditionKey(facts({ effort: "low" }));
    for (const other of [
      facts({ effort: "high" }),
      facts({ effort: "low", wiki: false }),
      facts({ effort: "low", compactWindow: "100k" }),
      facts({ effort: "low", loop: "program" }),
      facts({ effort: "low", yield: true }),
      facts({ effort: "low" }, { series: "0.6" }),
      facts({ effort: "low" }, { episode: "e360" }),
      facts({ effort: "low" }, { harness: "claude-code" }),
    ]) {
      expect(conditionKey(other)).not.toBe(base);
    }
  });

  test("the prompt hash, the budget and the annotations are not in it", () => {
    const a = { effort: null, promptHash: "sha256:a", budget: { episodeMs: 1 }, resolvedModel: "x" };
    const b = { effort: null, promptHash: "sha256:b", budget: { episodeMs: 2 }, resolvedModel: "y" };
    expect(conditionKey(facts(a))).toBe(conditionKey(facts(b)));
  });

  test("an absent field is its default: an old tuple and today's snippet-loop tuple are one condition", () => {
    const old = conditionKey(facts({ effort: null }));
    expect(conditionKey(facts(null))).toBe(old);
    expect(conditionKey(facts({ effort: null, wiki: true, compactWindow: null }))).toBe(old);
  });

  test("routing is not in it: a run on any provider, pinned or not, is the same condition (operator, 2026-11-16)", () => {
    const none = conditionKey(facts({ effort: "low" }));
    for (const routing of [
      { allowFallbacks: false, order: ["Z.AI"] },
      { allowFallbacks: false, order: ["b", "a"] },
      { allowFallbacks: true },
      { ...OPENCODE_GO_ROUTING },
    ]) {
      expect(conditionKey(facts({ effort: "low", routing }))).toBe(none);
    }
  });
});

describe("conditionOf and chartGroupOf", () => {
  test("a run reads its loop, yield, pinning and wiki off the tuple", () => {
    expect(conditionOf(facts(null))).toMatchObject({ loop: "snippet", yield: false, pinned: true, wiki: true });
    expect(
      conditionOf(facts({ loop: "program", yield: true, wiki: false, routing: { allowFallbacks: true, via: "OpenCode Go" } })),
    ).toMatchObject({ loop: "program", yield: true, pinned: false, wiki: false });
  });

  test("the loop and no wiki each make a chart of their own; effort, window, yield and routing do not", () => {
    const of = (t: ConditionFacts["tuple"]) => chartGroupOf(conditionOf(facts(t))).id;
    expect(of(null)).toBe("snippet");
    expect(of({ effort: "high", compactWindow: "100k", yield: true })).toBe("snippet");
    expect(of({ loop: "program", yield: true })).toBe("program");
    expect(of({ loop: "program" })).toBe("program");
    expect(of({ routing: { allowFallbacks: true } })).toBe("snippet");
    expect(of({ routing: { ...OPENCODE_GO_ROUTING }, loop: "program" })).toBe("program");
    expect(of({ routing: { allowFallbacks: false, order: ["x"] } })).toBe("snippet");
    expect(of({ wiki: false, loop: "program" })).toBe("program-nowiki");
    expect(chartGroupOf({ loop: "program", wiki: false }).label).toBe("program loop · no wiki");
  });
});
