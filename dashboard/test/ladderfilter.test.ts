import { describe, expect, test } from "bun:test";
import {
  companyOf,
  currentModels,
  filterOptions,
  lineOf,
  matchesSelection,
  modelVersion,
  representativeEfforts,
  weightsOf,
  type EffortEntry,
  type ModelEntry,
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
  test("the catalogue family's company, lowercased", () => {
    expect(companyOf("sonnet")).toBe("anthropic");
    expect(companyOf("claude-fable-5")).toBe("anthropic");
    expect(companyOf("gpt-6-astra")).toBe("openai");
    expect(companyOf("google/gemini-3.8-flash")).toBe("google");
    expect(companyOf("nvidia/nemotron-3-super-120b-a12b:free")).toBe("nvidia");
    // A vendor the catalogue added names its company, not its OpenRouter prefix.
    expect(companyOf("dots-studio/dots-3-note-preview:free")).toBe("rednote");
    expect(companyOf("inclusionai/ling-3.0-flash-fin:free")).toBe("inclusionai");
  });

  test("an id the catalogue cannot place falls back to its provider prefix", () => {
    // Invented: a namespace no entry or family claims.
    expect(companyOf("acme-labs/acme-1:free")).toBe("acme-labs");
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
  const none = { lines: [], companies: [], weights: [] };
  test("an empty selection is no opinion, not nothing", () => {
    expect(matchesSelection("sonnet", none)).toBe(true);
    expect(matchesSelection(null, none)).toBe(true);
  });

  test("OR within a dimension", () => {
    const sel = { ...none, lines: ["sonnet", "opus"] };
    expect(matchesSelection("sonnet", sel)).toBe(true);
    expect(matchesSelection("opus", sel)).toBe(true);
    expect(matchesSelection("gpt-6-astra", sel)).toBe(false);
  });

  test("AND across dimensions", () => {
    const sel = { ...none, lines: ["sonnet"], companies: ["openai"] };
    expect(matchesSelection("sonnet", sel)).toBe(false);
    expect(matchesSelection("gpt-6-astra", sel)).toBe(false);
    expect(matchesSelection("sonnet", { ...none, lines: ["sonnet"], companies: ["anthropic"] })).toBe(true);
  });

  test("the weights dimension narrows like the others", () => {
    const open = { ...none, weights: ["open"] };
    expect(matchesSelection("openai/gpt-oss-120b", open)).toBe(true);
    expect(matchesSelection("gpt-6-luna", open)).toBe(false);
    expect(matchesSelection("omen-alpha", { ...none, weights: ["open", "unknown"] })).toBe(true);
    expect(matchesSelection("openai/gpt-oss-120b", { ...open, companies: ["anthropic"] })).toBe(false);
  });

  test("its options are the verdicts the rows carry, commonest first", () => {
    expect(filterOptions(["opus", "sonnet", "openai/gpt-oss-120b", "omen-alpha"], weightsOf)).toEqual([
      { key: "closed", n: 2 },
      { key: "open", n: 1 },
      { key: "unknown", n: 1 },
    ]);
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

describe("modelVersion", () => {
  test("reads the version each real id is spelled with", () => {
    expect(modelVersion("claude-opus-4-8")).toEqual([4, 8]);
    expect(modelVersion("claude-opus-5-5")).toEqual([5, 5]);
    expect(modelVersion("claude-opus-5")).toEqual([5]);
    expect(modelVersion("claude-fable-5-1")).toEqual([5, 1]);
    expect(modelVersion("claude-haiku-4-5-20251001")).toEqual([4, 5]);
    expect(modelVersion("gpt-6.1-sol")).toEqual([6, 1]);
    expect(modelVersion("openai/gpt-5.6-luna")).toEqual([5, 6]);
    expect(modelVersion("deepseek/deepseek-v4-flash-0731")).toEqual([4]);
    expect(modelVersion("deepseek-v4.1-flash")).toEqual([4, 1]);
    expect(modelVersion("kimi-k3.1-pro")).toEqual([3, 1]);
    expect(modelVersion("minimax/minimax-m3.1-flash:free")).toEqual([3, 1]);
    expect(modelVersion("qwen/qwen3.8-27b")).toEqual([3, 8]);
    expect(modelVersion("nvidia/nemotron-3-super-120b-a12b:free")).toEqual([3]);
    expect(modelVersion("nvidia/nemotron-nano-9b-v2:free")).toEqual([2]);
    expect(modelVersion("inception/mercury-2.5")).toEqual([2, 5]);
  });

  test("an alias, a stealth name or a size alone carries none", () => {
    for (const id of ["sonnet", "opus", "deepseek-flash", "stealth/ox-alpha", "openai/gpt-oss-120b", "x-preview-f-free", ""]) {
      expect(modelVersion(id)).toBeNull();
    }
  });
});

describe("currentModels", () => {
  const m = (key: string, served: string, cost: number | null, xp: number | null, firstRun: number | null = 0): ModelEntry & { key: string } => ({
    key,
    served,
    firstRun,
    cost,
    xp,
  });
  const keys = (rows: readonly (ModelEntry & { key: string })[]): string[] => currentModels(rows).map((r) => r.key);
  // One model that beats everything, so nothing below is on the front by accident.
  const top = m("top", "fixture/top-9", 0.01, 99_999);

  test("keeps each line's newest model, across the real ids' spellings and the CLI aliases", () => {
    const rows = [
      top,
      m("claude-opus-4-6", "claude-opus-4-6", 20, 100),
      m("claude-opus-4-8", "claude-opus-4-8", 20, 100),
      m("claude-opus-5-5", "claude-opus-5-5", 20, 100),
      // `opus` as the CLI resolved it: an Opus 5, older than 5.5.
      m("opus (low)", "claude-opus-5", 20, 100),
      m("claude-haiku-4-5-20251001", "claude-haiku-4-5-20251001", 20, 100),
      m("claude-haiku-5-5 (max)", "claude-haiku-5-5", 20, 100),
      m("claude-haiku-5-5 (none)", "claude-haiku-5-5", 20, 100),
      m("claude-fable-5", "claude-fable-5", 20, 100),
      m("claude-fable-5-1", "claude-fable-5-1", 20, 100),
      m("sonnet (medium)", "claude-sonnet-5", 20, 100),
      m("claude-sonnet-5-5", "claude-sonnet-5-5", 20, 100),
      m("openai/gpt-5.6-luna", "openai/gpt-5.6-luna", 20, 100),
      // One model through two routes: both are the newest.
      m("gpt-6-luna", "gpt-6-luna", 20, 100),
      m("openai/gpt-6-luna", "openai/gpt-6-luna", 20, 100),
      m("openai/gpt-5.6-sol", "openai/gpt-5.6-sol", 20, 100),
      m("gpt-6.1-sol", "gpt-6.1-sol", 20, 100),
      m("x-ai/grok-4.6", "x-ai/grok-4.6", 20, 100),
      m("x-ai/grok-4.7", "x-ai/grok-4.7", 20, 100),
      m("z-ai/glm-4.7-flash", "z-ai/glm-4.7-flash", 20, 100),
      m("z-ai/glm-5.3-flash", "z-ai/glm-5.3-flash", 20, 100),
      // A line of one is never touched, whatever it scored.
      m("gpt-6-astra", "gpt-6-astra", 20, 100),
    ];
    expect(keys(rows)).toEqual([
      "top",
      "claude-opus-5-5",
      "claude-haiku-5-5 (max)",
      "claude-haiku-5-5 (none)",
      "claude-fable-5-1",
      "claude-sonnet-5-5",
      "gpt-6-luna",
      "openai/gpt-6-luna",
      "gpt-6.1-sol",
      "x-ai/grok-4.7",
      "z-ai/glm-5.3-flash",
      "gpt-6-astra",
    ]);
  });

  test("an older model on the field's cost-against-xp front stays", () => {
    const rows = [
      top,
      m("claude-opus-5-5", "claude-opus-5-5", 20, 50_000),
      // Cheaper than anything that earned more: on the front, though older.
      m("claude-opus-4-8", "claude-opus-4-8", 0.005, 10),
      // Dominated by the top entry: older and off the front.
      m("opus (low)", "claude-opus-5", 30, 40_000),
      // No cost reading: can only be kept by being the newest.
      m("claude-opus-4-6", "claude-opus-4-6", null, 99_999_999),
    ];
    expect(keys(rows)).toEqual(["top", "claude-opus-5-5", "claude-opus-4-8"]);
  });

  test("the front is the whole field's, not one line's", () => {
    // Opus 4.8 beats Opus 5.5 on both axes, yet a Haiku beats it in turn, so it goes.
    const rows = [
      m("claude-opus-5-5", "claude-opus-5-5", 20, 100),
      m("claude-opus-4-8", "claude-opus-4-8", 10, 200),
      m("claude-haiku-5-5", "claude-haiku-5-5", 5, 300),
    ];
    expect(keys(rows)).toEqual(["claude-opus-5-5", "claude-haiku-5-5"]);
  });

  test("a line some id of which carries no version is ordered by first run in the field", () => {
    const rows = [
      top,
      m("deepseek/deepseek-v4-flash-0731", "deepseek/deepseek-v4-flash-0731", 20, 100, 1_000),
      m("deepseek/deepseek-v4.1-flash", "deepseek/deepseek-v4.1-flash", 20, 100, 2_000),
      // The same model as the line above, spelled as the catalogue's alias: one model, one first run.
      m("deepseek-v4.1-flash", "deepseek-v4.1-flash", 20, 100, 5_000),
      m("deepseek-flash", "deepseek-flash", 20, 100, 3_000),
    ];
    expect(keys(rows)).toEqual(["top", "deepseek-flash"]);
    // Without the alias, the versions decide.
    expect(keys(rows.filter((r) => r.key !== "deepseek-flash"))).toEqual(["top", "deepseek/deepseek-v4.1-flash", "deepseek-v4.1-flash"]);
  });

  test("input order survives, and no rows is no rule", () => {
    const rows = [m("b", "fixture/b-2", 1, 1), m("a", "fixture/a-1", 1, 1)];
    expect(keys(rows)).toEqual(["b", "a"]);
    expect(currentModels([])).toEqual([]);
  });
});
