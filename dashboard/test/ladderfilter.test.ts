import { describe, expect, test } from "bun:test";
import {
  companyOf,
  filterOptions,
  lineOf,
  matchesSelection,
  representativeEfforts,
  type EffortEntry,
} from "../src/lib/ladderfilter";

const e = (model: string, effort: string | null, cost: number, xp: number): EffortEntry => ({
  model,
  effort,
  cost,
  xp,
});

describe("lineOf", () => {
  test("drops the provider prefix, the free marker and every version token", () => {
    expect(lineOf("claude-fable-5")).toBe("claude-fable");
    expect(lineOf("claude-haiku-4-5-20251001")).toBe("claude-haiku");
    expect(lineOf("gpt-6-astra")).toBe("gpt-astra");
    expect(lineOf("openai/gpt-5.6-luna")).toBe("gpt-luna");
    expect(lineOf("deepseek/deepseek-v4-flash-0731")).toBe("deepseek-flash");
    expect(lineOf("poolside/laguna-s-2.1:free")).toBe("laguna-s");
    expect(lineOf("laguna-s-2.1-free")).toBe("laguna-s");
  });

  test("a bare alias is its own line", () => {
    expect(lineOf("sonnet")).toBe("sonnet");
    expect(lineOf("opus")).toBe("opus");
  });

  test("every effort of one model answers the same line", () => {
    expect(lineOf("sonnet")).toBe(lineOf("sonnet"));
    expect(lineOf("z-ai/glm-5.3-flash")).toBe(lineOf("glm-5.4-flash"));
  });

  test("a slug that is all version keeps its base name rather than becoming nothing", () => {
    expect(lineOf("qwen/qwen3.8-27b")).toBe("qwen3.8-27b");
  });

  test("total: null, undefined and empty answer rather than throwing", () => {
    expect(lineOf(null)).toBe("(unnamed)");
    expect(lineOf(undefined)).toBe("(unnamed)");
    expect(lineOf("  ")).toBe("(unnamed)");
  });
});

describe("companyOf", () => {
  test("the lineup catalog's vendor, lowercased", () => {
    expect(companyOf("sonnet")).toBe("anthropic");
    expect(companyOf("claude-fable-5")).toBe("anthropic");
    expect(companyOf("gpt-6-astra")).toBe("openai");
    expect(companyOf("google/gemini-3.8-flash")).toBe("google");
    expect(companyOf("nvidia/nemotron-3-super-120b-a12b:free")).toBe("nvidia");
  });

  test("an id the catalog does not claim falls back to its provider prefix", () => {
    expect(companyOf("dots-studio/dots-3-note-preview:free")).toBe("dots-studio");
    expect(companyOf("inclusionai/ling-3.0-flash-fin:free")).toBe("inclusionai");
  });

  test("and to `unknown` when the slug names no provider at all", () => {
    expect(companyOf("omen-alpha")).toBe("unknown");
    expect(companyOf(null)).toBe("unknown");
  });
});

describe("filterOptions", () => {
  test("derived from the rows present, commonest first", () => {
    const models = ["sonnet", "sonnet", "opus", "gpt-6-astra"];
    expect(filterOptions(models, lineOf)).toEqual([
      { key: "sonnet", n: 2 },
      { key: "gpt-astra", n: 1 },
      { key: "opus", n: 1 },
    ]);
    expect(filterOptions(models, companyOf)).toEqual([
      { key: "anthropic", n: 3 },
      { key: "openai", n: 1 },
    ]);
  });

  test("no rows, no options — never a stale list", () => {
    expect(filterOptions([], lineOf)).toEqual([]);
  });
});

describe("matchesSelection", () => {
  const none = { lines: [], companies: [] };
  test("an empty selection is no opinion, not nothing", () => {
    expect(matchesSelection("sonnet", none)).toBe(true);
    expect(matchesSelection(null, none)).toBe(true);
  });

  test("OR within a dimension", () => {
    const sel = { lines: ["sonnet", "opus"], companies: [] };
    expect(matchesSelection("sonnet", sel)).toBe(true);
    expect(matchesSelection("opus", sel)).toBe(true);
    expect(matchesSelection("gpt-6-astra", sel)).toBe(false);
  });

  test("AND across dimensions", () => {
    const sel = { lines: ["sonnet"], companies: ["openai"] };
    expect(matchesSelection("sonnet", sel)).toBe(false);
    expect(matchesSelection("gpt-6-astra", sel)).toBe(false);
    expect(matchesSelection("sonnet", { lines: ["sonnet"], companies: ["anthropic"] })).toBe(true);
  });
});

describe("representativeEfforts", () => {
  test("a model with one entry is untouched, however it reads", () => {
    const rows = [e("sonnet", null, 9, 1), e("opus", "low", 0.01, 99999)];
    expect(representativeEfforts(rows)).toEqual(rows);
  });

  test("a dominated effort — costlier and further behind — is dropped", () => {
    const good = e("sonnet", "low", 1, 500);
    const bad = e("sonnet", "high", 2, 400);
    expect(representativeEfforts([good, bad])).toEqual([good]);
  });

  test("a costlier effort that got further is kept: it is a trade, not a loss", () => {
    const cheap = e("sonnet", "low", 1, 400);
    const far = e("sonnet", "high", 2, 500);
    expect(representativeEfforts([cheap, far])).toEqual([cheap, far]);
  });

  test("ties stay — equal on both axes dominates nothing", () => {
    const a = e("sonnet", "low", 1, 400);
    const b = e("sonnet", "none", 1, 400);
    expect(representativeEfforts([a, b])).toEqual([a, b]);
  });

  test("never across models: a model is only judged against its own efforts", () => {
    const sonnetLow = e("sonnet", "low", 5, 100);
    const opus = e("opus", null, 1, 900);
    // `sonnet (low)` is dominated by `opus` on both axes and still stays.
    expect(representativeEfforts([sonnetLow, opus])).toEqual([sonnetLow, opus]);
  });

  test("null effort is an entry like any other, dominating and dominated", () => {
    const plain = e("sonnet", null, 1, 500);
    const worse = e("sonnet", "high", 3, 100);
    expect(representativeEfforts([plain, worse])).toEqual([plain]);
    const better = e("sonnet", "high", 0.5, 900);
    expect(representativeEfforts([plain, better])).toEqual([better]);
  });

  test("the whole front survives, not just its best point", () => {
    const rows = [
      e("sonnet", "low", 1, 100), // cheapest
      e("sonnet", "medium", 2, 300), // on the front
      e("sonnet", "high", 3, 500), // furthest
      e("sonnet", "xhigh", 4, 200), // dearer than every one of them, and behind two
    ];
    expect(representativeEfforts(rows).map((r) => r.effort)).toEqual(["low", "medium", "high"]);
  });

  test("input order survives the filter", () => {
    const rows = [e("b", null, 1, 1), e("a", "hi", 1, 9), e("a", "lo", 2, 1)];
    expect(representativeEfforts(rows).map((r) => r.model)).toEqual(["b", "a"]);
  });

  test("no rows, no rule", () => {
    expect(representativeEfforts([])).toEqual([]);
  });
});
