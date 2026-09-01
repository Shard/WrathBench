/**
 * The scatter's axes as data: what a run reads for each metric, how an axis
 * over that metric is scaled, ticked, captioned and read in the hover, and the
 * curated pairs the ladder page offers as views.
 *
 * The chart used to know two metrics — cost on x, xp on y — and every piece
 * of it (the pairing rule, the omission reasons, the tick formats, the
 * captions, the hover) was written for those two by name. An `AxisSpec` is
 * one metric's whole vocabulary in one object, so `ladderPoints`,
 * `ladderChartLayout`, `paretoRuns` and `LadderChart` can take any pair and
 * nothing about what a number means moves: the cost reading is still
 * `runCostReading` with its basis, the xp reading is still the viewer's lower
 * bound, and each spec carries its own caption and caveat with it.
 *
 * Views are curated, not free-form: a pair is offered because it asks a
 * question the roster can answer, and each is one URL (`?view=`), so a
 * reading is linkable. Nothing here is a methodological decision — no view
 * ranks by anything `docs/METHODOLOGY.md` says not to score by, and the
 * ladder table's own order is untouched.
 */

import type { ResultRun } from "@viewer/api-types";

/* ---------------------------------------------------------------- readings */

/** What one run cost, and on what basis; null when nothing prices it. */
export interface RunCostReading {
  usd: number;
  basis: "reported" | "list-price";
  /** A figure nobody paid: a free tier, local hardware, a subscription. */
  asIfMetered: boolean;
}

/**
 * The cost of one run for the chart: what the provider charged when it said,
 * else the price table applied to the run's own tokens.
 *
 * The runs table shows only the provider's figure, because a listing of what
 * runs cost may not show a guess. The chart's x-axis is an average, and a
 * free or local model has no provider figure ever — its honest cost is the
 * $0 the price table says. So the fallback is taken here, and the point
 * carries its basis so the caption can say which runs were priced how.
 */
export function runCostReading(r: Pick<ResultRun, "actualCost" | "expectedCost">): RunCostReading | null {
  const a = r.actualCost;
  if (a !== null && a.basis !== "none" && a.usd !== null) return { usd: a.usd, basis: "reported", asIfMetered: a.asIfMetered };
  const e = r.expectedCost;
  if (e !== null && e !== undefined && e.basis !== "none" && e.usd !== null) {
    return { usd: e.usd, basis: "list-price", asIfMetered: e.asIfMetered };
  }
  return null;
}

/**
 * XP earned over a run, for the chart's y-axis.
 *
 * `xpEarned` is the viewer's lower-bound reconstruction. Against a viewer that
 * predates the field, a run still on its starting level has earned exactly
 * its within-level xp, and any other run has earned an amount nothing on the
 * wire states — null, never a guess.
 */
export function xpEarnedOf(r: Pick<ResultRun, "xpEarned" | "maxLevel" | "xp">): number | null {
  if (r.xpEarned !== undefined) return r.xpEarned;
  return r.maxLevel === 1 ? r.xp : null;
}

/**
 * The metrics a point can carry. Each is a reading a run either has or does
 * not — null is "not recorded", never zero — and the set is what is cheaply
 * on `ResultRun` and reliable across the roster. Deaths are deliberately
 * absent: the record exists on a handful of runs, so a deaths axis would omit
 * nearly everything and say little about the rest.
 */
export type MetricKey = "cost" | "xp" | "tokens" | "tokensOut" | "turns" | "toolCalls" | "playtimeMs" | "level" | "quests";

export const METRIC_KEYS: readonly MetricKey[] = [
  "cost",
  "xp",
  "tokens",
  "tokensOut",
  "turns",
  "toolCalls",
  "playtimeMs",
  "level",
  "quests",
];

export type Metrics = Readonly<Record<MetricKey, number | null>>;

/**
 * One run's readings.
 *
 * Tokens count only when the provider counted them: `TokenTotals.source`
 * `estimated` is characters ÷ 4 and `snapshot` is a claude-code figure the
 * viewer itself documents as badly under-read (`tail.ts`), and an axis that
 * averaged a guess with a count would put a point nowhere any run was — the
 * same rule `runCostReading` applies by refusing a price over estimated
 * tokens. Turns are `modelResponses`, the count of response records in the
 * trajectory, which survives a resume where the turn counter does not.
 */
export function runMetrics(r: ResultRun): Metrics {
  const counted = r.tokens !== null && r.tokens.source === "reported" ? r.tokens : null;
  return {
    cost: runCostReading(r)?.usd ?? null,
    xp: xpEarnedOf(r),
    tokens: counted?.totalTokens ?? null,
    tokensOut: counted?.completionTokens ?? null,
    turns: r.modelResponses,
    toolCalls: r.toolCalls,
    playtimeMs: r.playtimeMs,
    level: r.maxLevel,
    quests: r.questsCompleted,
  };
}

/* ------------------------------------------------------------------- specs */

export interface AxisSpec {
  key: MetricKey;
  /** The short name the omission reasons and the view control use: `cost`, `xp`. */
  label: string;
  /** The axis caption on the plot, for one episode: `avg cost per e90 run (USD, log)`. */
  caption: (episode: string) => string;
  /** The reading off a point's bag of means. */
  accessor: (m: Metrics) => number | null;
  /** A tick's text, and the hover's reading of the mean. */
  format: (v: number) => string;
  /**
   * How the axis is scaled. `log-cost` is the decade axis with a floor and a
   * $0 gutter (`logScale` in `lib/ladder.ts`); `linear` is `niceTicks` from
   * zero. Log is cost's alone: a roster's prices span three orders of
   * magnitude, and nothing else offered here does.
   */
  scale: "linear" | "log-cost";
  /** Which way is better, for the Pareto front: cheaper is lower, further is higher. */
  better: "lower" | "higher";
  /**
   * The caveat that travels with the metric wherever it is drawn, for the
   * caption under the chart. Cost's basis sentence and xp's lower-bound note
   * live here so a view that swaps an axis swaps its caveat with it.
   */
  note: string;
}

const perRun = (what: string) => (episode: string) => `avg ${what} per ${episode} run`;

export const COST: AxisSpec = {
  key: "cost",
  label: "cost",
  caption: (episode) => `${perRun("cost")(episode)} (USD, log)`,
  accessor: (m) => m.cost,
  /** Cents below a dollar, dollars at and above one — a decade tick's label. */
  format: (usd) => (usd < 1 ? `${Math.round(usd * 100)}¢` : `$${Math.round(usd)}`),
  scale: "log-cost",
  better: "lower",
  note: "Cost is what the provider charged, otherwise a list-price estimate",
};

export const XP: AxisSpec = {
  key: "xp",
  label: "xp",
  caption: () => "avg xp earned (lower bound)",
  accessor: (m) => m.xp,
  format: (v) => (v >= 1000 ? `${v / 1000}k` : String(v)),
  scale: "linear",
  better: "higher",
  note: "XP earned is a lower bound, rebuilt from the run's 60-second samples",
};

export const TOKENS: AxisSpec = {
  key: "tokens",
  label: "tokens",
  caption: (episode) => `${perRun("tokens")(episode)} (in + out, provider-counted)`,
  accessor: (m) => m.tokens,
  /** Round ticks, so `20M` and `800k` rather than `fmtTokens`' reading-grade `20.00M`; the hover uses `fmtTokens`. */
  format: (v) => (v >= 1_000_000 ? `${Number((v / 1_000_000).toFixed(1))}M` : v >= 1000 ? `${Math.round(v / 1000)}k` : String(v)),
  scale: "linear",
  better: "lower",
  note: "Tokens are the provider's own count; a run whose tokens were estimated or snapshot-read has no reading",
};

export const TURNS: AxisSpec = {
  key: "turns",
  label: "turns",
  caption: (episode) => perRun("model turns")(episode),
  accessor: (m) => m.turns,
  format: (v) => (v >= 1000 ? `${v / 1000}k` : String(v)),
  scale: "linear",
  better: "lower",
  note: "A turn is one model response",
};

export const TOOL_CALLS: AxisSpec = {
  key: "toolCalls",
  label: "tool calls",
  caption: (episode) => perRun("tool calls")(episode),
  accessor: (m) => m.toolCalls,
  format: (v) => (v >= 1000 ? `${v / 1000}k` : String(v)),
  scale: "linear",
  better: "lower",
  note: "Tool calls are the unit the episode's ceiling is enforced in",
};

export const LEVEL: AxisSpec = {
  key: "level",
  label: "level",
  caption: () => "avg highest level reached",
  accessor: (m) => m.level,
  format: (v) => (v === 0 ? "0" : `L${v}`),
  scale: "linear",
  better: "higher",
  note: "Level is the highest any sample of the run recorded",
};

/** Every spec, by key — the hover's "also" line walks this. */
export const AXES: Readonly<Record<MetricKey, AxisSpec | null>> = {
  cost: COST,
  xp: XP,
  tokens: TOKENS,
  tokensOut: null,
  turns: TURNS,
  toolCalls: TOOL_CALLS,
  playtimeMs: null,
  level: LEVEL,
  quests: null,
};

/* --------------------------------------------------------------- direction */

/** Which way each axis improves — the two `better` fields of a view's specs. */
export interface Better {
  x: AxisSpec["better"];
  y: AxisSpec["better"];
}

/** Less x, more y: every offered view, and the freeplay field (level against playtime). */
export const DEFAULT_BETTER: Better = { x: "lower", y: "higher" };

/** The corner of a plot that "better" points at: a reading of the specs, so a chart's cue is right by construction. */
export interface Corner {
  h: "left" | "right";
  v: "top" | "bottom";
  /** The arrow that points there, for the cue: ↖ ↗ ↙ ↘. */
  arrow: "↖" | "↗" | "↙" | "↘";
}

export function betterCorner(better: Better): Corner {
  const h = better.x === "lower" ? "left" : "right";
  const v = better.y === "higher" ? "top" : "bottom";
  const arrow = v === "top" ? (h === "left" ? "↖" : "↗") : h === "left" ? "↙" : "↘";
  return { h, v, arrow };
}

/* ------------------------------------------------------------------- views */

export interface LadderView {
  /** The `?view=` value. */
  id: string;
  /** The control's text: `cost × xp`. */
  title: string;
  x: AxisSpec;
  y: AxisSpec;
}

const view = (id: string, x: AxisSpec, y: AxisSpec): LadderView => ({ id, title: `${x.label} × ${y.label}`, x, y });

/**
 * The views offered, default first. Each x is a resource spent and each y a
 * distance reached, so "lower x, higher y dominates" holds for every one of
 * them and the Pareto front means the same thing on each.
 *
 * Not offered: playtime. On a fixed-length tier every run that went the
 * distance played the same ninety minutes, so an active-playtime axis would
 * mostly sort runs by whether they stopped early (the tool-call ceiling, an
 * early end), and less of it is not better — the one x here that would break
 * the front's reading. It stays in the bag for the hover.
 *
 * Nor level on y (operator, 2026-09-01): a cost × level view was offered and
 * withdrawn as redundant against cost × xp — level is xp with the steps
 * quantised, so the two charts ranked the same points in the same order with
 * less resolution on one. `LEVEL` stays a spec because the hover's "also"
 * line reads it; a stale `?view=cost-level` link falls back to the default
 * through `viewParam`.
 */
export const LADDER_VIEWS: readonly LadderView[] = [
  view("cost-xp", COST, XP),
  view("tokens-xp", TOKENS, XP),
  view("turns-xp", TURNS, XP),
  view("calls-xp", TOOL_CALLS, XP),
];

export const DEFAULT_VIEW: LadderView = LADDER_VIEWS[0]!;

/**
 * The `?view=` search param, defaulted and validated the way `episodeParam`
 * is: anything unrecognised is the default view, and the control shows what
 * is actually selected, so the fallback is visible.
 */
export function viewParam(raw: string | string[] | undefined): LadderView {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return LADDER_VIEWS.find((w) => w.id === v) ?? DEFAULT_VIEW;
}
