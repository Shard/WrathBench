/**
 * The ladder's derivation (ADR-0018): the rung rules, the row order, and the
 * filter helpers the page's controls are made of. Pure, so what the release
 * page claims is testable without a browser or a server.
 *
 * The one rule this module exists to enforce: **a row never mixes runs that
 * are not comparable.** Scorability comes from the server's own `unscored`
 * predicate; the harness series is the shell's filter (ADR-0046) and is
 * applied before rows reach here. Until ADR-0047 this file also held the
 * results page's cost-per-level grouping; that page is now the runs table
 * and the grouping went with it.
 */

import type { ResultRun } from "@viewer/api-types";
import { niceTicks, scaleLinear } from "./chart";

export function scored(runs: readonly ResultRun[]): ResultRun[] {
  return runs.filter((r) => r.unscored === null);
}

/* ----------------------------------------------------------------- filters */

/**
 * The four controls above the chart, as pure functions.
 *
 * Race and class are separate selects rather than the one chip row of
 * `Race Class` pairs this page used to carry. The pair was the honest control
 * while the extras cycle (ADR-0034) was the only thing varying a character;
 * a probe campaign (ADR-0041) varies race and class independently, so the pair
 * had become a chip row nobody could read. Offering a combination no run has
 * is not a problem the options can create: each list is the DISTINCT values
 * actually present, and an empty result is the honest answer to a pair nothing
 * ran.
 *
 * Options are computed from the page's runs BEFORE any of these filters is
 * applied, so picking a race does not prune the class list under the reader's
 * cursor. A run that never recorded a race, a class, or a harness contributes
 * no option there: it is kept by "all" and dropped by any specific pick, which
 * is what "not recorded" has to mean if it is not to be guessed at — the same
 * rule the character chips carried.
 */

/** Null is "all". A stored choice the current runs cannot honour resolves to it. */
export type FilterChoice = string | null;

function distinct(values: readonly (string | null)[]): string[] {
  return [...new Set(values.filter((v): v is string => v !== null && v.length > 0))].sort();
}

export function raceOptions(runs: readonly ResultRun[]): string[] {
  return distinct(runs.map((r) => r.raceName));
}

export function classOptions(runs: readonly ResultRun[]): string[] {
  return distinct(runs.map((r) => r.className));
}

/** The harness tags present (ADR-0035): `wrathbench`, `claude-code`, … */
export function harnessOptions(runs: readonly ResultRun[]): string[] {
  return distinct(runs.map((r) => r.harness));
}

/**
 * A remembered choice, resolved against what this episode actually has.
 *
 * A selection restored from `localStorage` can name a class no run on the
 * current tier was played on, and an empty table with no visible cause is the
 * worst outcome of remembering anything. It falls back to "all", and the
 * control shows "all", which is the same rule `displayedChoice` applies to a
 * stale harness series in `lib/harness.ts`.
 */
export function resolveChoice(options: readonly string[], choice: FilterChoice): FilterChoice {
  return choice !== null && options.includes(choice) ? choice : null;
}

export interface LadderFilter {
  race: FilterChoice;
  klass: FilterChoice;
  harness: FilterChoice;
  /** Keep only runs we paid for. See `ResultRun.billing`. */
  excludeFree: boolean;
}

/** Whether the feed can answer the billing question at all. */
export function billingKnown(runs: readonly ResultRun[]): boolean {
  return runs.some((r) => r.billing !== undefined);
}

/**
 * The page's runs, narrowed — applied before `ladderRows`, so the ranking is
 * computed over exactly the set on screen (ADR-0043's order is untouched:
 * highest rung, then XP, then gold).
 *
 * `excludeFree` drops runs whose `billing` says `free` and keeps `undefined`:
 * a viewer that predates the field does not report that a run was free, and
 * dropping what it cannot answer would quietly shrink the ladder. The page
 * says so when that is the case rather than showing a filter that filters
 * nothing.
 */
export function filterRuns(runs: readonly ResultRun[], f: LadderFilter): ResultRun[] {
  return runs.filter(
    (r) =>
      (f.race === null || r.raceName === f.race) &&
      (f.klass === null || r.className === f.klass) &&
      (f.harness === null || r.harness === f.harness) &&
      (!f.excludeFree || r.billing !== "free"),
  );
}

/** The distinct characters in a set of runs, sorted — a row's label. */
function charactersOf(runs: readonly ResultRun[]): string[] {
  return [...new Set(runs.map((r) => r.characterLabel).filter((l): l is string => l !== null))].sort();
}

/* ------------------------------------------------------------------ ladder */

export type RungStatus = "reached" | "not-reached" | "not-instrumented";

export interface Rung {
  n: number;
  title: string;
  /**
   * The rule, printed on the page. A derived rung shows exactly what was
   * tested, so a reader can disagree with the derivation rather than having to
   * trust it; an underived rung says what is missing instead.
   */
  rule: string;
  /** Null when nothing recorded today can answer the rung. */
  test: ((run: ResultRun) => boolean) | null;
}

/** Outland and Northrend map ids — the only continents past the first two. */
export const EXPANSION_MAPS = [530, 571];

/**
 * The eight rungs of docs/VISION.md, with the derivation each one gets from the
 * data that actually exists.
 *
 * Rungs 2 and 4 became derivable on 2026-08-25, when the viewer was wired to
 * the zone/area milestone records the loop has written since 2026-08-23
 * (FOLLOW-UPS 35): `run.areas` carries the first area observed, whether the run
 * ever left it, and the first capital zone it entered. Rung 4 stopped being
 * partial later the same day (ADR-0048, issue #8): the module now taps
 * `SMSG_ACTIVATETAXIREPLY` and the taxi flag on self, the loop records a `taxi`
 * milestone per flight, and `run.taxi.flights` answers the flight-master half,
 * so the rung tests both clauses of its own title.
 *
 * A run that predates a producer carries no `areas` / `taxi` at all and reads
 * as not-reached, the same way a run with no level reading does; nothing
 * invents a result from a level threshold, and a rung's cell is "reached" as
 * soon as *any* of the model's runs passes, so an old run cannot make a
 * derivation look false — it simply says nothing.
 *
 * Rung 6 stays not instrumented: grouping and instance records do not exist,
 * and the harness runs one character per session anyway.
 */
export const RUNGS: Rung[] = [
  {
    n: 1,
    title: "Quest chain in the starting subzone",
    rule: "level 5 observed — the starting chain ends around L5–6",
    test: (r) => (r.maxLevel ?? 0) >= 5,
  },
  {
    n: 2,
    title: "Leave the starting subzone on its own initiative",
    rule: "left the first-observed area (milestone records); runs before 2026-08-23 have none",
    test: (r) => r.areas?.leftStartArea === true,
  },
  {
    n: 3,
    title: "L10: class quest, first talent, spells trained",
    rule: "level 10 observed — the talent and class-quest half is not recorded",
    test: (r) => (r.maxLevel ?? 0) >= 10,
  },
  {
    n: 4,
    title: "Reach a capital city; use a flight master",
    rule:
      "entered a capital zone AND took at least one flight (milestone records); " +
      "runs before the achievement/flight taps have no flight record and cannot pass",
    test: (r) => (r.areas?.capitalZone ?? null) !== null && (r.taxi?.flights ?? 0) >= 1,
  },
  {
    n: 5,
    title: "L20 with riding skill and a mount",
    rule: "level 20 observed — riding skill and mount purchase are not recorded",
    test: (r) => (r.maxLevel ?? 0) >= 20,
  },
  {
    n: 6,
    title: "A 5-man dungeon cleared by a party of agents",
    rule: "needs grouping and instance records; the harness runs one character per session",
    test: null,
  },
  {
    n: 7,
    title: "L40, L60, Outland, Northrend",
    rule: "level 40 observed, or a state sample on map 530 (Outland) or 571 (Northrend)",
    test: (r) => (r.maxLevel ?? 0) >= 40 || r.maps.some((m) => EXPANSION_MAPS.includes(m)),
  },
  {
    n: 8,
    title: "L80, heroics, Icecrown Citadel",
    rule: "level 80 observed — heroics and raid progress are not recorded",
    test: (r) => (r.maxLevel ?? 0) >= 80,
  },
];

export interface LadderCell {
  n: number;
  status: RungStatus;
  /** The run that got there, for a reached rung. */
  runId: string | null;
}

export interface LadderRow {
  model: string;
  /** The highest *derivable* rung reached; 0 when none was. */
  highest: number;
  cells: LadderCell[];
  runs: number;
  /**
   * The furthest the model's best run got, as the pair `(bestLevel, bestXp)`:
   * the highest level any counted run observed, and the highest xp *within*
   * that level. The pair travels together and comes from one run — `bestRunId`
   * names it — because an xp reading paired with another run's level would be
   * a number nothing observed. Null when nothing recorded it.
   */
  bestLevel: number | null;
  bestXp: number | null;
  bestRunId: string | null;
  /**
   * The most copper any counted run ended holding, and the run that held it.
   * Independently maxed, so it is usually *not* the `bestRunId` run — the row
   * names both so the three numbers are not misread as one run's ledger.
   */
  bestMoney: number | null;
  bestMoneyRunId: string | null;
  /** Harness tags among the model's scored runs (ADR-0035), sorted. */
  harnesses: string[];
  /** Starting characters among those runs, sorted; a label, never a row key. */
  characters: string[];
}

/**
 * Highest rung reached per model, over scored runs only.
 *
 * "Highest derivable": rung 6 can never be reached here, so a model sitting at
 * rung 7 is not claimed to have passed it — the page shows the whole row and
 * lets the gaps speak. Since rungs 2 and 4 became derivable a gap at either is
 * an observation rather than a blank: a model at rung 3 whose runs never left
 * their starting area now shows "not reached" at 2, which is a finding about
 * the model and not about the instrumentation. Achievement points are not in
 * this ordering and are not added to anything (ADR-0018/0043: highest rung,
 * then XP, then gold); they are a signal a run page displays. `highest` stays the maximum
 * reached rung, so it is unaffected by the holes below it.
 *
 * The row order is a stated derivation, versioned with this file (ADR-0018
 * amendment, 2026-08-23): **highest rung reached, then total XP, then gold.**
 * Total XP is the `(level, xp)` pair compared lexicographically — xp resets at
 * every ding and level never falls, so the pair *is* the total-XP ordering, and
 * no `level * K + xp` integer is synthesised because no XP-per-level table
 * exists in what the harness records. Both are maxima over the model's counted
 * runs; `runs` and the model name break what is left, so the order is total and
 * stable. A missing reading sorts last rather than as zero: 0 copper and 0 xp
 * are real readings, null is "never recorded". No number here is added to
 * another — there is still no aggregate score.
 */
export function ladderRows(runs: readonly ResultRun[]): LadderRow[] {
  const byModel = new Map<string, ResultRun[]>();
  for (const r of scored(runs)) {
    const model = r.model ?? "(unnamed)";
    const list = byModel.get(model);
    if (list === undefined) byModel.set(model, [r]);
    else list.push(r);
  }
  const rows: LadderRow[] = [];
  for (const [model, list] of byModel) {
    const cells = RUNGS.map((rung): LadderCell => {
      if (rung.test === null) return { n: rung.n, status: "not-instrumented", runId: null };
      const hit = list.find((r) => rung.test!(r));
      return {
        n: rung.n,
        status: hit === undefined ? "not-reached" : "reached",
        runId: hit?.runId ?? null,
      };
    });
    const reached = cells.filter((c) => c.status === "reached").map((c) => c.n);
    const furthest = furthestOf(list);
    const richest = richestOf(list);
    rows.push({
      model,
      highest: reached.length > 0 ? Math.max(...reached) : 0,
      cells,
      runs: list.length,
      bestLevel: furthest?.level ?? null,
      bestXp: furthest?.xp ?? null,
      bestRunId: furthest?.runId ?? null,
      bestMoney: richest?.money ?? null,
      bestMoneyRunId: richest?.runId ?? null,
      harnesses: [...new Set(list.map((r) => r.harness ?? "harness?"))].sort(),
      characters: charactersOf(list),
    });
  }
  rows.sort(
    (a, b) =>
      b.highest - a.highest ||
      desc(b.bestLevel, a.bestLevel) ||
      desc(b.bestXp, a.bestXp) ||
      desc(b.bestMoney, a.bestMoney) ||
      b.runs - a.runs ||
      a.model.localeCompare(b.model),
  );
  return rows;
}

/** Descending compare where "not recorded" sorts last, and 0 does not. */
function desc(x: number | null, y: number | null): number {
  return (x ?? -1) - (y ?? -1);
}

/**
 * The run that got furthest, as the `(level, xp)` pair it was observed at.
 *
 * Lexicographic: a higher level always wins, and xp only separates runs that
 * ended on the same level. A run with a level but no xp reading counts as
 * behind one with the same level and any xp, including zero.
 */
function furthestOf(
  runs: readonly ResultRun[],
): { runId: string; level: number; xp: number | null } | null {
  let best: { runId: string; level: number; xp: number | null } | null = null;
  for (const r of runs) {
    if (r.maxLevel === null) continue;
    if (best === null || r.maxLevel > best.level || (r.maxLevel === best.level && (r.xp ?? -1) > (best.xp ?? -1))) {
      best = { runId: r.runId, level: r.maxLevel, xp: r.xp };
    }
  }
  return best;
}

/** The run that ended holding the most copper. Zero counts; null does not. */
function richestOf(runs: readonly ResultRun[]): { runId: string; money: number } | null {
  let best: { runId: string; money: number } | null = null;
  for (const r of runs) {
    if (r.money === null) continue;
    if (best === null || r.money > best.money) best = { runId: r.runId, money: r.money };
  }
  return best;
}

/* ----------------------------------------------------------------- scatter */

/*
 * The scatter above the ladder table: one point per (model, effort), x the
 * average cost of a run, y the average XP earned, over that entry's counted
 * runs on the selected tier. Everything below is pure so the aggregation and
 * the label placement are testable without a DOM; the scale and tick maths
 * they build on is the shared `lib/chart.ts`.
 */

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

/** One entry of the roster on the chart: a model, at one effort if it has one. */
export interface LadderPoint {
  /** The label: `sonnet`, or `sonnet (low)` when effort is a roster dimension. */
  key: string;
  model: string;
  effort: string | null;
  /** Mean cost per counted run, USD. */
  x: number;
  /** Mean XP earned per counted run. */
  y: number;
  /** Counted runs of this entry on the tier, and how many of them fed each mean. */
  runs: number;
  costRuns: number;
  xpRuns: number;
  /** Whether every priced run was provider-reported, every one list-priced, or both. */
  basis: "reported" | "list-price" | "mixed";
  /** Any list-priced run was a figure nobody paid. */
  asIfMetered: boolean;
  /** The harness tags among the runs (ADR-0035), sorted — what colours the point. */
  harnesses: string[];
}

/** An entry that could not be plotted, and the reason printed under the chart. */
export interface LadderOmission {
  key: string;
  why: "no cost reading" | "no xp reading";
}

export function pointKey(model: string, effort: string | null): string {
  return effort === null ? model : `${model} (${effort})`;
}

/**
 * One point per (model, effort) over the scored runs given — the same rows
 * the ladder table draws, so the chart never shows an entry the table lacks.
 *
 * Both coordinates are means over the entry's counted runs, each over the
 * runs that carry the reading: a run with no cost figure is left out of the
 * x mean and still counts toward y, and the point records how many fed each
 * so the hover can say so. An entry with no reading on either axis is
 * omitted and named, never plotted at zero — a $0 free model is a reading,
 * a missing one is not.
 */
export function ladderPoints(runs: readonly ResultRun[]): { points: LadderPoint[]; omitted: LadderOmission[] } {
  const groups = new Map<string, { model: string; effort: string | null; runs: ResultRun[] }>();
  for (const r of scored(runs)) {
    const model = r.model ?? "(unnamed)";
    const key = pointKey(model, r.effort);
    const g = groups.get(key);
    if (g === undefined) groups.set(key, { model, effort: r.effort, runs: [r] });
    else g.runs.push(r);
  }
  const points: LadderPoint[] = [];
  const omitted: LadderOmission[] = [];
  for (const [key, g] of groups) {
    const costs = g.runs.map(runCostReading).filter((c): c is RunCostReading => c !== null);
    const xps = g.runs.map(xpEarnedOf).filter((v): v is number => v !== null);
    if (costs.length === 0) {
      omitted.push({ key, why: "no cost reading" });
      continue;
    }
    if (xps.length === 0) {
      omitted.push({ key, why: "no xp reading" });
      continue;
    }
    const bases = new Set(costs.map((c) => c.basis));
    points.push({
      key,
      model: g.model,
      effort: g.effort,
      x: costs.reduce((s, c) => s + c.usd, 0) / costs.length,
      y: xps.reduce((s, v) => s + v, 0) / xps.length,
      runs: g.runs.length,
      costRuns: costs.length,
      xpRuns: xps.length,
      basis: bases.size > 1 ? "mixed" : bases.has("reported") ? "reported" : "list-price",
      asIfMetered: costs.some((c) => c.asIfMetered),
      harnesses: [...new Set(g.runs.map((r) => r.harness ?? "harness?"))].sort(),
    });
  }
  points.sort((a, b) => a.key.localeCompare(b.key));
  omitted.sort((a, b) => a.key.localeCompare(b.key));
  return { points, omitted };
}

export interface ChartBox {
  /** The plot rectangle in viewBox units: x0 < x1 left to right, y0 > y1 bottom to top. */
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

export interface PlacedPoint {
  point: LadderPoint;
  cx: number;
  cy: number;
  /** The label's anchor and start corner, in viewBox units. */
  labelX: number;
  labelY: number;
  anchor: "start" | "end";
}

export interface LadderChartLayout {
  xTicks: number[];
  yTicks: number[];
  xMax: number;
  yMax: number;
  placed: PlacedPoint[];
  /** The same value→pixel maps the points were placed with, for the chart's own tick gridlines. */
  px: (x: number) => number;
  py: (y: number) => number;
}

/** Label width estimate at the chart's 11px font: enough to avoid collisions, not a text measure. */
const CHAR_W = 6.3;
const LABEL_H = 12;
const LABEL_GAP = 7;

/**
 * Where everything goes. Points map linearly onto the plot; labels are placed
 * greedily, each trying right-above, right-below, left-above, left-below of
 * its point (then the same four a row further out) and taking the first slot that overlaps no label already placed
 * and stays inside the plot. Points are visited highest-y first so the
 * crowded bottom-left corner yields to the entries the reader is looking for.
 * Two labels that cannot both fit overlap rather than vanish: a hidden
 * label is worse than an ugly one.
 */
export function ladderChartLayout(points: readonly LadderPoint[], box: ChartBox): LadderChartLayout {
  const xTicks = niceTicks(Math.max(0, ...points.map((p) => p.x)));
  const yTicks = niceTicks(Math.max(0, ...points.map((p) => p.y)));
  const xMax = xTicks[xTicks.length - 1]!;
  const yMax = yTicks[yTicks.length - 1]!;
  const px = scaleLinear([0, xMax], [box.x0, box.x1]);
  const py = scaleLinear([0, yMax], [box.y0, box.y1]);

  type Rect = { l: number; t: number; r: number; b: number };
  const taken: Rect[] = [];
  const overlaps = (a: Rect): boolean => taken.some((b) => a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t);
  const inside = (a: Rect): boolean => a.l >= box.x0 - 2 && a.r <= box.x1 + 2 && a.t >= box.y1 - LABEL_H && a.b <= box.y0;

  const ordered = [...points].sort((a, b) => b.y - a.y || a.x - b.x);
  const placed: PlacedPoint[] = [];
  for (const p of ordered) {
    const cx = px(p.x);
    const cy = py(p.y);
    const w = p.key.length * CHAR_W;
    const above = cy - LABEL_GAP;
    const below = cy + LABEL_GAP + LABEL_H * 0.75;
    // Four slots around the point, then the same four one label-row further out.
    const slots: { anchor: "start" | "end"; labelX: number; labelY: number }[] = [
      { anchor: "start", labelX: cx + LABEL_GAP, labelY: above },
      { anchor: "start", labelX: cx + LABEL_GAP, labelY: below },
      { anchor: "end", labelX: cx - LABEL_GAP, labelY: above },
      { anchor: "end", labelX: cx - LABEL_GAP, labelY: below },
      { anchor: "start", labelX: cx + LABEL_GAP, labelY: above - LABEL_H },
      { anchor: "start", labelX: cx + LABEL_GAP, labelY: below + LABEL_H },
      { anchor: "end", labelX: cx - LABEL_GAP, labelY: above - LABEL_H },
      { anchor: "end", labelX: cx - LABEL_GAP, labelY: below + LABEL_H },
    ];
    const rectOf = (s: (typeof slots)[number]): Rect => ({
      l: s.anchor === "start" ? s.labelX : s.labelX - w,
      r: s.anchor === "start" ? s.labelX + w : s.labelX,
      t: s.labelY - LABEL_H,
      b: s.labelY,
    });
    const pick = slots.find((s) => {
      const r = rectOf(s);
      return inside(r) && !overlaps(r);
    }) ?? slots.find((s) => inside(rectOf(s))) ?? slots[0]!;
    taken.push(rectOf(pick));
    placed.push({ point: p, cx, cy, ...pick });
  }
  return { xTicks, yTicks, xMax, yMax, placed, px, py };
}
