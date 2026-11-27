import { describe, expect, test } from "bun:test";
import type { ResultRun, RunCondition } from "../src/api/client";
import {
  chartGroups,
  currentModels,
  defaultLadderRuns,
  inChartGroup,
  representativeEfforts,
  type EffortEntry,
  type ModelEntry,
} from "../src/lib/ladderfilter";
import { entryKeyOf } from "../src/lib/ladder";

const e = (model: string, effort: string | null, cost: number, xp: number): EffortEntry => ({
  model,
  effort,
  cost,
  xp,
});

describe("representativeEfforts", () => {
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

  test("never across models: a model is only judged against its own efforts", () => {
    const sonnetLow = e("sonnet", "low", 5, 100);
    const opus = e("opus", null, 1, 900);
    // `sonnet (low)` is dominated by `opus` on both axes and still stays.
    expect(representativeEfforts([sonnetLow, opus])).toEqual([sonnetLow, opus]);
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
});

describe("conditions and charts", () => {
  const cond = (id: string, over: Partial<RunCondition> = {}): RunCondition => ({ id, loop: "snippet", yield: false, pinned: true, wiki: true, subject: "hosted", ...over });
  const r = (runId: string, model: string, startedAt: number, condition: RunCondition, unscored: string | null = null): ResultRun =>
    ({ runId, model, startedAt, condition, unscored, harnessSeries: "0.5", episode: "e90", effort: null, harness: "wrathbench" }) as unknown as ResultRun;
  const snippetLow = cond("s-low");
  const snippetHigh = cond("s-high");
  const program = cond("p", { loop: "program", yield: true });
  const runs = [
    r("a1", "a", 100, snippetLow),
    r("a2", "a", 300, snippetHigh),
    r("a3", "a", 200, snippetLow),
    r("b1", "b", 100, snippetLow),
    r("b2", "b", 500, program),
    r("b3", "b", 900, snippetLow, "unscored (operator objective)"),
    r("c1", "c", 50, snippetLow),
  ];

  test("every condition of a model is its own row by default, never pooled (operator, 2026-11-16)", () => {
    // Two conditions of one model on one chart: the older keeps its row beside the newer.
    const two = [r("old", "m", 100, cond("s-old")), r("new", "m", 900, cond("s-new")), r("again", "m", 50, cond("s-old"))];
    const shown = defaultLadderRuns(two);
    expect(shown.map((x) => x.runId)).toEqual(["old", "new", "again"]);
    expect([...new Set(shown.map(entryKeyOf))]).toEqual(["m\ns-old", "m\ns-new"]);
  });

  test("chart groups count entries, most first; the program loop is never charted with the snippet loop", () => {
    expect(chartGroups(runs).map((g) => [g.id, g.entries])).toEqual([["snippet", 4], ["program", 1]]);
    expect(inChartGroup(runs, "program").map((x) => x.runId)).toEqual(["b2"]);
  });

  test("the default view: every condition, on the chart holding the most entries", () => {
    // b's program-loop runs are on their own chart; its snippet runs stay on this one beside a's two conditions.
    expect(defaultLadderRuns(runs).map((x) => x.runId)).toEqual(["a1", "a2", "a3", "b1", "b3", "c1"]);
    expect(defaultLadderRuns([])).toEqual([]);
  });
});
