/**
 * The ladder's derivation: the rung rules, the row order, and the
 * filter helpers the page's controls are made of. Pure, so what the release
 * page claims is testable without a browser or a server.
 *
 * The one rule this module exists to enforce: **a row never mixes runs that
 * are not comparable.** Scorability comes from the server's own `unscored`
 * predicate; the harness series is the shell's filter and is applied before
 * rows reach here. This file used to also hold the results page's
 * cost-per-level grouping; that page is now the runs table and the grouping
 * went with it.
 */

import type { ResultRun } from "@viewer/api-types";
import { niceTicks, scaleLinear } from "./chart";
import { modelDisplay } from "./format";
import { chainsOf } from "./lineage";

export function scored(runs: readonly ResultRun[]): ResultRun[] {
  return runs.filter((r) => r.unscored === null);
}

/* ----------------------------------------------------------------- filters */

/**
 * The four controls above the chart, as pure functions.
 *
 * Race and class are separate selects rather than the one chip row of
 * `Race Class` pairs this page used to carry. The pair was the honest control
 * while the extras cycle was the only thing varying a character;
 * a probe campaign varies race and class independently, so the pair
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

/** The harness tags present: `wrathbench`, `claude-code`, … */
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
 * computed over exactly the set on screen (the order is untouched:
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
 * partial later the same day (issue #8): the module now taps
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
 * Deaths and the level timeline joined the milestone records on 2026-08-29
 * (`run.deaths`, `run.leveling`), but neither bears on a rung: no rung asks how
 * often a character died, and the level rungs already read `maxLevel`.
 *
 * Rung 6 stays not instrumented, and what it lacks is specifically: a record of
 * joining or leaving a party (no group milestone exists) and a record of
 * entering an instance (no instance milestone exists — a map-id change in the
 * state samples is not one, since it cannot tell a dungeon from a boat ride).
 * Even with both, the harness runs one character per session, so the rung's
 * "party of agents" clause needs multi-session work that does not exist
 * either. The framing of that rung is issue #9.
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
  /** Harness tags among the model's scored runs, sorted. */
  harnesses: string[];
  /** Starting characters among those runs, sorted; a label, never a row key. */
  characters: string[];
  /**
   * Every id this row's runs actually resolved to, sorted — `claude-sonnet-5`
   * for a row keyed on the alias `sonnet`. The row stays keyed on the recorded
   * model string; more than one entry here is an alias that resolved two ways
   * across the row's runs, which is drift the page must show rather than
   * average. Empty when no run recorded one.
   */
  resolvedModels: string[];
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
 * this ordering and are not added to anything (highest rung, then XP, then
 * gold); they are a signal a run page displays. `highest` stays the maximum
 * reached rung, so it is unaffected by the holes below it.
 *
 * The row order is a stated derivation, versioned with this file
 * (amendment, 2026-08-23): **highest rung reached, then total XP, then gold.**
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
      resolvedModels: [
        ...new Set(
          list
            .map((r) => r.resolvedModel)
            .filter((m): m is string => typeof m === "string" && m.length > 0),
        ),
      ].sort(),
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
  /** What the chart draws: the key with the sample size the means rest on. */
  label: string;
  /**
   * At least one of the two means is a single observation. Flagged rather
   * than hidden: a mark averaged over one run is a reading, not an estimate,
   * and the two must not look alike. Both means share the same runs, so this
   * is simply `n === 1` — an entry of three runs with one carrying both
   * readings is as thin as an entry with one run.
   */
  single: boolean;
  model: string;
  effort: string | null;
  /** Mean cost per run, USD, over the `n` runs carrying both readings. */
  x: number;
  /** Mean XP earned per run, over the same `n` runs. */
  y: number;
  /** Counted runs of this entry on the tier, including those that fed neither mean. */
  runs: number;
  /** The runs both means rest on: those carrying a cost reading AND an xp reading. */
  n: number;
  /** Whether every priced run was provider-reported, every one list-priced, or both. */
  basis: "reported" | "list-price" | "mixed";
  /**
   * Some priced run was a figure nobody paid. Orthogonal to `basis`: a
   * claude-code run is `reported` (the SDK's own total) AND as-if-metered
   * (billed to a subscription); a local model's list price is list-price AND
   * as-if-metered; a metered OpenRouter charge is reported and not.
   */
  asIfMetered: boolean;
  /** The harness tags among the runs, sorted — what colours the point. */
  harnesses: string[];
}

/** An entry that could not be plotted, and the reason printed under the chart. */
export interface LadderOmission {
  key: string;
  /** The key as a reader sees it: the model's short name, provider prefix dropped. */
  label: string;
  why: "no cost reading" | "no xp reading" | "no run with both cost and xp";
}

/**
 * The entry's identity: the model string as recorded, never shortened. It is a
 * lookup key (`pareto.ts` matches a Set of these), so a display form of it is
 * built separately — see `LadderPoint.label`.
 */
export function pointKey(model: string, effort: string | null): string {
  return effort === null ? model : `${model} (${effort})`;
}

/** The drawn label is the key alone; the run count lives in the hover text (operator, 2026-08-30). */
export function pointLabel(key: string, _runs: number): string {
  return key;
}

/**
 * One point per (model, effort) over the scored runs given — the same rows
 * the ladder table draws, so the chart never shows an entry the table lacks.
 *
 * Both coordinates are means over the SAME runs: the entry's counted runs
 * that carry both a cost reading and an xp reading. A run with only one of
 * the two is left out of both means — pairing one run's price with another
 * run's xp puts a point nowhere any run was, and a label that then prints the
 * larger n overstates what the mark rests on. `n` is the number of runs the
 * means share; `runs` keeps the entry's full counted total so the hover can
 * say how many were left out. An entry with no run carrying both is omitted
 * and named, never plotted at zero — a $0 free model is a reading, a missing
 * one is not.
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
    const paired: { cost: RunCostReading; xp: number }[] = [];
    let anyCost = false;
    let anyXp = false;
    for (const r of g.runs) {
      const cost = runCostReading(r);
      const xp = xpEarnedOf(r);
      anyCost ||= cost !== null;
      anyXp ||= xp !== null;
      if (cost !== null && xp !== null) paired.push({ cost, xp });
    }
    if (paired.length === 0) {
      // Say which reading is missing when only one is; both present on
      // different runs is its own case, and named as such.
      omitted.push({
        key,
        label: pointKey(modelDisplay(g.model), g.effort),
        why: !anyCost ? "no cost reading" : !anyXp ? "no xp reading" : "no run with both cost and xp",
      });
      continue;
    }
    const costs = paired.map((p) => p.cost);
    const bases = new Set(costs.map((c) => c.basis));
    points.push({
      key,
      label: pointLabel(pointKey(modelDisplay(g.model), g.effort), paired.length),
      single: paired.length === 1,
      model: g.model,
      effort: g.effort,
      x: costs.reduce((s, c) => s + c.usd, 0) / paired.length,
      y: paired.reduce((s, p) => s + p.xp, 0) / paired.length,
      runs: g.runs.length,
      n: paired.length,
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
  /** Decade ticks on the log cost axis: 0.01, 0.1, 1, … up to the ceiling. */
  xTicks: number[];
  /** The 2× and 5× lines inside each decade — gridlines only, never labelled. */
  xMinorTicks: number[];
  yTicks: number[];
  /** The cost axis ceiling. */
  xMax: number;
  yMax: number;
  /** Where the log axis begins: the plot's left edge, or past the free gutter. */
  axisX0: number;
  /** The centre of the free gutter, where a $0 entry is drawn. */
  freeX: number;
  /** Where the divider between the gutter and the log axis is drawn. */
  dividerX: number;
  /** Whether any entry cost nothing, and so whether the gutter is there at all. */
  hasFree: boolean;
  placed: PlacedPoint[];
  /** The same value→pixel maps the points were placed with, for the chart's own tick gridlines. */
  px: (x: number) => number;
  py: (y: number) => number;
}

/** Label width estimate at the chart's 11px font: enough to avoid collisions, not a text measure. */
const CHAR_W = 6.3;
const LABEL_H = 12;

/**
 * The radius of a plotted mark, in viewBox units — the one place that knows it.
 *
 * The chart draws each point as the model's logo on a puck, so the
 * mark is no longer the plain 5-unit dot the label placement was written
 * against; exporting the radius is what keeps the drawing and the placement
 * from drifting apart when one of them is retuned. It is barely wider than
 * that dot on purpose: a puck sized to make the logo *comfortable* turned the
 * scatter into a field of badges and buried the shape of the data, which is
 * what the chart is for.
 */
export const MARK_R = 5.5;

/** The mark's true outer edge: the separation ring outside the puck. */
export const MARK_RING_R = MARK_R + 1.5;

/**
 * The clearance a label keeps from its point's centre, both ways.
 *
 * Derived from the mark rather than chosen: it has to leave the puck and its
 * separation ring, which is why it is the outer radius plus a little and not a
 * number of its own.
 */
export const LABEL_GAP = MARK_RING_R + 1.5;

/* ------------------------------------------------------- the cost axis */

/**
 * The cost axis is logarithmic, and these are the three numbers that make it
 * readable rather than a smear.
 *
 * A roster spans three orders of magnitude — most entries run a fraction of a
 * dollar and one reasoning model runs sixty — so on a linear axis every model
 * anyone wants to compare is crushed against the y axis by the one outlier.
 * A log axis is the honest fix, and it needs a floor: log10(0) is negative
 * infinity, and a tenth of a cent is not a distance worth a decade of the
 * plot. `COST_FLOOR` is that floor — anything positive below it is clamped
 * onto it rather than dropped, because "cheaper than a cent" is the reading
 * and the exact figure below that is noise.
 *
 * Zero is not on this axis at all. A free tier's $0 is a real reading and
 * cannot be clamped to a cent without inventing a price, so free entries get
 * their own narrow gutter to the left of the axis, divided off, labelled, and
 * never interpolated against. The gutter exists only when something is
 * actually free.
 */
export const COST_FLOOR = 0.01;

/** The gutter's width in viewBox units, when there is one. */
export const FREE_GUTTER_W = 54;

/** The narrowest the axis is allowed to be, so an all-cheap view is not a sliver. */
export const COST_CEILING_MIN = 10;

export interface CostScale {
  floor: number;
  ceiling: number;
  /** Decades from the floor to the ceiling, inclusive. */
  ticks: number[];
  /** The 2× and 5× lines strictly inside the axis. */
  minorTicks: number[];
  hasFree: boolean;
  axisX0: number;
  freeX: number;
  dividerX: number;
  /** $0 to the gutter; anything else clamped into [floor, ceiling] and logged. */
  px: (usd: number) => number;
}

/**
 * The smallest decade at or above `max` — the axis ceiling.
 *
 * "At or above", not "strictly above": a roster whose dearest entry is exactly
 * $10 puts that point on the right edge rather than leaving a whole empty
 * decade, which is the behaviour the linear axis had. `Math.log10` of an exact
 * power of ten can land a hair either side of the integer, so the exponent is
 * corrected downward rather than trusted.
 */
function decadeCeiling(max: number): number {
  if (!(max > COST_CEILING_MIN)) return COST_CEILING_MIN;
  let e = Math.ceil(Math.log10(max));
  if (10 ** (e - 1) >= max) e -= 1;
  while (10 ** e < max) e += 1;
  return 10 ** e;
}

/**
 * The log cost scale for a set of costs, mapped across `[x0, x1]`.
 *
 * Data-independent: the floor, the gutter width and the minimum ceiling are
 * fixed, and the only thing the data decides is how many decades the axis
 * spans and whether the gutter is drawn. The gutter is keyed on a $0
 * coordinate and not on the page's "exclude free" filter — a local model's
 * list price is $0 whether or not its billing said `free`, and the coordinate
 * is the honest test.
 */
export function costScale(costs: readonly number[], x0: number, x1: number): CostScale {
  const positive = costs.filter((c) => c > 0);
  const ceiling = decadeCeiling(positive.length === 0 ? 0 : Math.max(...positive));
  const hasFree = costs.some((c) => c <= 0);
  const axisX0 = hasFree ? x0 + FREE_GUTTER_W : x0;
  const freeX = x0 + FREE_GUTTER_W / 3;
  const dividerX = x0 + (FREE_GUTTER_W * 2) / 3;

  const ticks: number[] = [];
  for (let v = COST_FLOOR; v <= ceiling * 1.0000001; v *= 10) ticks.push(Number(v.toPrecision(12)));
  const minorTicks: number[] = [];
  for (const t of ticks) {
    for (const m of [2, 5]) {
      const v = Number((t * m).toPrecision(12));
      if (v < ceiling) minorTicks.push(v);
    }
  }

  const lo = Math.log10(COST_FLOOR);
  const hi = Math.log10(ceiling);
  const px = (usd: number): number => {
    if (!(usd > 0)) return hasFree ? freeX : axisX0;
    const v = Math.min(Math.max(usd, COST_FLOOR), ceiling);
    return axisX0 + ((Math.log10(v) - lo) / (hi - lo)) * (x1 - axisX0);
  };
  return { floor: COST_FLOOR, ceiling, ticks, minorTicks, hasFree, axisX0, freeX, dividerX, px };
}

/** A decade tick's label: cents below a dollar, dollars at and above one. */
export function fmtCostTick(usd: number): string {
  return usd < 1 ? `${Math.round(usd * 100)}\u00a2` : `$${Math.round(usd)}`;
}

/**
 * Where everything goes. Cost maps onto the log axis above (or into its
 * free gutter) and xp maps linearly; labels are placed
 * greedily, each trying right-above, right-below, left-above, left-below of
 * its point (then the same four a row further out) and taking the first slot that overlaps no label already placed
 * and stays inside the plot. Points are visited highest-y first so the
 * crowded bottom-left corner yields to the entries the reader is looking for.
 * Two labels that cannot both fit overlap rather than vanish: a hidden
 * label is worse than an ugly one.
 */
export function ladderChartLayout(points: readonly LadderPoint[], box: ChartBox): LadderChartLayout {
  const cost = costScale(points.map((p) => p.x), box.x0, box.x1);
  const yTicks = niceTicks(Math.max(0, ...points.map((p) => p.y)));
  const yMax = yTicks[yTicks.length - 1]!;
  const px = cost.px;
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
    const w = p.label.length * CHAR_W;
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
  return {
    xTicks: cost.ticks,
    xMinorTicks: cost.minorTicks,
    yTicks,
    xMax: cost.ceiling,
    yMax,
    axisX0: cost.axisX0,
    freeX: cost.freeX,
    dividerX: cost.dividerX,
    hasFree: cost.hasFree,
    placed,
    px,
    py,
  };
}

/* ------------------------------------------------------- freeplay streams */

/**
 * The freeplay ladder is a different question, and so a different derivation.
 *
 * Operator decision, 2026-08-29: it is **an overview of the top characters on
 * freeplay right now** — the whole active field, not a leaderboard of finished
 * evidence. So `scored()` is not applied here, and it is not that a filter was
 * forgotten: every freeplay run is `unscored (episode freeplay)` by definition
 * (`unscoredReason` in `runner/viewer/results.ts`), which is exactly why
 * `ladderRows` showed this page an empty table. What is dropped instead is a
 * launch that produced nothing — `stillborn`, the scheduler's own notion,
 * decided server-side — and nothing else. Live, paused and ended runs all
 * belong on this page; their state is a column, not a filter.
 *
 * And a stream is **one character across attempts** (docs/OPERATIONS.md,
 * "Freeplay streams are durable"). A row is a stream, not a run and not a
 * model: attempt 12 continues attempt 11 on the same character, so listing
 * both would show the same character twice with the older one looking behind.
 * The lineage is `continuedFrom`; the latest attempt carries the character's
 * current level and state, and the chain rides along so a reader can see how
 * many attempts are behind it.
 *
 * The scored ladders are untouched — `ladderRows` is still keyed by model and
 * still reads scored runs only.
 */

/** What a stream is doing now. */
export type StreamStatus = "live" | "paused" | "ended";

export interface StreamRow {
  /** The chain root's run id: the stream's identity across attempts. */
  streamId: string;
  model: string;
  /** The effort the latest attempt ran at, when it recorded one. */
  effort: string | null;
  /** The latest attempt — the run whose readings this row shows. */
  latest: ResultRun;
  /** Attempts in the chain, oldest first. `attempts` is its length. */
  chain: string[];
  attempts: number;
  status: StreamStatus;
  /**
   * The recorded reason behind `status`: the pause reason while paused, the
   * termination reason once ended, null while live. A stream whose ref an
   * operator disabled reads `paused (operator-pause)` or its ending — the run
   * row is the only source here and "disabled" is a fact about the roster.
   */
  statusDetail: string | null;
  character: string | null;
  characterLabel: string | null;
  harness: string | null;
  level: number | null;
  xp: number | null;
  money: number | null;
  questsCompleted: number | null;
  startedAt: number | null;
}

/**
 * The public projection replaces a pause reason's free text with the fixed
 * `paused` token, so the detail there restates the status. Dropped rather
 * than printed: `paused (paused)` reads as a defect, not as a withheld field.
 */
export const OPAQUE_PAUSE_REASON = "paused";

function statusOf(r: ResultRun): { status: StreamStatus; detail: string | null } {
  if (r.pauseReason !== null) {
    return { status: "paused", detail: r.pauseReason === OPAQUE_PAUSE_REASON ? null : r.pauseReason };
  }
  if (r.live === true) return { status: "live", detail: null };
  return { status: "ended", detail: r.terminationReason };
}

/**
 * Collapse a set of freeplay runs into one row per stream.
 *
 * The chain walk itself is `lib/lineage.ts` — shared with the runs table and
 * the run page, so the field and the inventory cannot disagree about which
 * attempts belong to one stream, and written there for the cases production
 * produces (a predecessor the set does not hold, a fork, a malformed cycle).
 * The tie-break a fork gets there is the one this row applies: the later start.
 *
 * Order: level, then xp within it, then gold — the same "furthest, then
 * richest" comparison the scored ladder uses, with a missing reading sorting
 * last rather than as zero. Ties fall back to the most recent start and then
 * the stream id, so the order is total and stable.
 */
export function streamRows(runs: readonly ResultRun[]): StreamRow[] {
  // The stillborn filter is this page's, not the walk's: the runs table is an
  // inventory and shows them, the field is a leaderboard and does not.
  const kept = runs.filter((r) => r.stillborn !== true);
  const chains = chainsOf(kept);
  // One entry per root, holding the attempt that got furthest along the chain:
  // the longest chain wins, and a tie is broken by the later start.
  const best = new Map<string, { chain: string[]; run: ResultRun }>();
  for (const r of kept) {
    const chain = chains.get(r.runId)!;
    const root = chain[0]!;
    const held = best.get(root);
    if (
      held === undefined ||
      chain.length > held.chain.length ||
      (chain.length === held.chain.length && (r.startedAt ?? 0) > (held.run.startedAt ?? 0))
    ) {
      best.set(root, { chain, run: r });
    }
  }
  const rows: StreamRow[] = [];
  for (const [streamId, { chain, run }] of best) {
    const { status, detail } = statusOf(run);
    rows.push({
      streamId,
      model: run.model ?? "(unnamed)",
      effort: run.effort ?? null,
      latest: run,
      chain,
      attempts: chain.length,
      status,
      statusDetail: detail,
      character: run.character,
      characterLabel: run.characterLabel,
      harness: run.harness,
      level: run.maxLevel,
      xp: run.xp,
      money: run.money,
      questsCompleted: run.questsCompleted,
      startedAt: run.startedAt,
    });
  }
  rows.sort(
    (a, b) =>
      desc(b.level, a.level) ||
      desc(b.xp, a.xp) ||
      desc(b.money, a.money) ||
      desc(b.startedAt, a.startedAt) ||
      a.streamId.localeCompare(b.streamId),
  );
  return rows;
}

/* ------------------------------------------------- the freeplay stream chart */

/**
 * A stream's level timeline, stitched across its attempts.
 *
 * **The axis is cumulative active playtime, not wall clock and not turns.**
 * The scored ladders' own graph (`components/LadderChart`) has no time axis at
 * all — it is a cost/xp scatter — so the family member this borrows from is the
 * run page's `XpChart`, whose x is elapsed wall clock bounded by the episode
 * deadline. That bound is exactly what a freeplay stream does not have, and
 * the three reasons the axis changes with it:
 *
 * - a freeplay stream is unbounded and spends days paused between attempts, so
 *   wall clock would draw the operator's calendar rather than the character's
 *   progress — twelve attempts over a fortnight would be mostly flat gaps;
 * - turns are not usable across a resume. `turnsUsable` in
 *   `runner/viewer/results.ts` exists because a run resumed by an older build
 *   restarts its turn counter, and a cross-attempt axis would be summing
 *   counters that each begin again;
 * - `LevelMark.playtimeMs` is pause-corrected active time from the run's start
 *   to that sample, already computed server-side (`activeMsUntil`), so the
 *   honest axis is the one the data already carries.
 *
 * Which is also why the marks come from `ResultRun.levels` rather than the
 * `leveling` facts of FOLLOW-UPS 35: `LevelUpMark` carries `ts` and `turn` and
 * no playtime at all, so it cannot be placed on this axis. Nothing new is
 * needed from the viewer — `levels` (with its per-mark `playtimeMs`) and the
 * run's own `playtimeMs` are already on `ResultRun` and already in the public
 * snapshot projection.
 *
 * The series is a **step**, never an interpolation. `levelMarks` records the
 * first sighting of each new highest level, so a diagonal from L5 to L6 would
 * claim the character was at 5.4 partway, which is not a thing: the level is
 * held flat to the next mark and rises there. A lower bound on *when*, in the
 * sense the whole milestone surface already means it.
 *
 * At a seam between attempts, attempt k's first mark is the level the character
 * already had, not a gain — the same rule `LevelUpFacts` states for its own
 * first mark. Any mark at or below the level already drawn is dropped, so a
 * twelve-attempt stream does not draw eleven phantom rises; a mark *above* it
 * is a ding that happened in the unobserved gap and draws its step at the seam.
 */
export interface StreamPoint {
  /** Cumulative active playtime across the stream, in ms. */
  x: number;
  level: number;
  /** The attempt the mark was recorded on, and its wall-clock instant. */
  runId: string;
  ts: number;
}

export interface StreamSeries {
  streamId: string;
  /** The character, falling back to the model (short, with its effort) when a run recorded no name. */
  label: string;
  model: string;
  /** The effort behind `model`, so two streams of one model are told apart. */
  effort: string | null;
  status: StreamStatus;
  attempts: number;
  /** The attempt the series ends on — where a click on the line goes. */
  latestRunId: string;
  points: StreamPoint[];
  /** Where the line stops: the stream's total active time. "Now", while live. */
  endX: number;
  /** The level it is holding there — the last point's, which is `maxLevel`. */
  endLevel: number;
  /**
   * The chain's root still names a predecessor this set does not hold, so the
   * series begins mid-history: the axis is time-since-the-oldest-attempt-served,
   * not time-since-the-character-was-made.
   */
  truncated: boolean;
}

export interface StreamChartModel {
  series: StreamSeries[];
  /** A stream that could not be drawn, and the reason, in `ladderPoints`' shape. */
  omitted: { streamId: string; label: string; why: string }[];
}

/** The total active time an attempt contributes, or null when it recorded none. */
function attemptSpan(run: ResultRun): number | null {
  if (run.playtimeMs !== null) return run.playtimeMs;
  // The run's own total is the right figure — it advances with a live run. A
  // run that never got one still contributes what its marks prove it played,
  // which is a lower bound and is documented as one at the call site.
  const marked = run.levels.map((l) => l.playtimeMs).filter((p): p is number => p !== null);
  return marked.length > 0 ? Math.max(...marked) : null;
}

/**
 * Build one series per stream from the same rows and runs the table shows.
 *
 * `rows` supplies the lineage (`streamRows` already resolved it, including the
 * malformed cases) and `runs` is the set those ids index into, so the chart and
 * the table can never disagree about which runs are on screen.
 *
 * A prior attempt with no active-time reading at all is the one case that
 * cannot be stitched: its successors' offsets would be short by an unknown
 * amount, and folding a null to zero would silently compress the axis — the
 * distinction `AreaFacts` and `TaxiFacts` are emphatic about. Such a stream is
 * omitted with its reason rather than drawn wrong. The *last* attempt is
 * different: with no span the line simply ends at its last mark.
 */
export function streamSeries(rows: readonly StreamRow[], runs: readonly ResultRun[]): StreamChartModel {
  const byId = new Map(runs.map((r) => [r.runId, r]));
  const series: StreamSeries[] = [];
  const omitted: { streamId: string; label: string; why: string }[] = [];
  /** When each stream's latest attempt started — the label's disambiguator. */
  const startedOf = new Map(rows.map((r) => [r.streamId, r.startedAt]));

  for (const row of rows) {
    const label = row.character ?? pointKey(modelDisplay(row.model), row.effort);
    const attempts = row.chain.map((id) => byId.get(id)).filter((r): r is ResultRun => r !== undefined);
    if (attempts.length === 0) {
      omitted.push({ streamId: row.streamId, label, why: "no attempt served" });
      continue;
    }
    const points: StreamPoint[] = [];
    let offset = 0;
    let endX = 0;
    let highest = 0;
    let broke: string | null = null;
    for (let i = 0; i < attempts.length; i++) {
      const run = attempts[i]!;
      for (const mark of run.levels) {
        if (mark.playtimeMs === null || mark.level <= highest) continue;
        highest = mark.level;
        points.push({ x: offset + mark.playtimeMs, level: mark.level, runId: run.runId, ts: mark.ts });
      }
      const span = attemptSpan(run);
      if (span === null) {
        if (i < attempts.length - 1) {
          broke = `attempt ${i + 1} of ${attempts.length} recorded no active time`;
          break;
        }
        // The line stops at the furthest time anything proves: the attempts
        // already counted, or a mark on this one past them. Never *behind* the
        // offset — the earlier attempts' active time is evidence we hold.
        endX = Math.max(offset, points.length > 0 ? points[points.length - 1]!.x : 0);
        break;
      }
      offset += span;
      endX = offset;
    }
    if (broke !== null) {
      omitted.push({ streamId: row.streamId, label, why: broke });
      continue;
    }
    if (points.length === 0) {
      // Two different nothings: a stream too young to have been sampled at a
      // level at all, and one whose marks carry no active time to place them on.
      const why = attempts.every((r) => r.levels.length === 0)
        ? "no level recorded yet"
        : "no level mark carries an active-time reading";
      omitted.push({ streamId: row.streamId, label, why });
      continue;
    }
    const root = attempts[0]!;
    series.push({
      streamId: row.streamId,
      label,
      model: row.model,
      effort: row.effort,
      status: row.status,
      attempts: row.attempts,
      latestRunId: row.latest.runId,
      points,
      endX: Math.max(endX, points[points.length - 1]!.x),
      endLevel: points[points.length - 1]!.level,
      /*
       * A predecessor named and not served. The `typeof` is not paranoia: a
       * viewer that predates the field omits it entirely, and `undefined !==
       * null` would mark every stream in the fleet as missing history — the
       * same "an older viewer must still work" rule `ResultRun.xpEarned` states.
       */
      truncated: typeof root.continuedFrom === "string" && !byId.has(root.continuedFrom),
    });
  }
  /*
   * A character name is not unique: a stream that lost its character is
   * re-rolled under the same name, and four ended `Qwenlocal` lines all
   * labelled `Qwenlocal` name nothing. Where the name repeats, and only there,
   * the stream's start date joins it — ISO, because a pure module has no
   * business picking a locale.
   */
  const seen = new Map<string, number>();
  for (const s of series) seen.set(s.label, (seen.get(s.label) ?? 0) + 1);
  for (const s of series) {
    if ((seen.get(s.label) ?? 0) < 2) continue;
    const started = startedOf.get(s.streamId) ?? null;
    if (started !== null) s.label = `${s.label} ${new Date(started).toISOString().slice(0, 10)}`;
  }
  // Furthest first, so the eye meets the leaders and the legend order matches
  // the table's. Ties fall back to the stream id, so the order is total.
  series.sort((a, b) => b.endLevel - a.endLevel || b.endX - a.endX || a.streamId.localeCompare(b.streamId));
  omitted.sort((a, b) => a.label.localeCompare(b.label) || a.streamId.localeCompare(b.streamId));
  return { series, omitted };
}

/**
 * Ticks for a duration axis, in ms: the first of 1/2/5/10/15/30 minutes, then
 * 1/2/4/8/12 hours, then whole days, that yields at most `want` of them.
 *
 * `niceTicks` cannot do this job. Its 1/2/5 × 10^k step over a millisecond
 * domain lands on things like 5,000,000 ms — a gridline every 1.39 hours, which
 * is a number no reader has ever wanted. Time is not decimal, so its axis needs
 * its own ladder of steps.
 */
export function timeTicks(maxMs: number, want = 6): number[] {
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const steps = [MIN, 2 * MIN, 5 * MIN, 10 * MIN, 15 * MIN, 30 * MIN, HOUR, 2 * HOUR, 4 * HOUR, 8 * HOUR, 12 * HOUR];
  const top = Math.max(maxMs, 0);
  let step = steps.find((s) => top / s <= want);
  if (step === undefined) {
    // Past half a day, whole days — a multiple, so the labels stay round.
    const day = 24 * HOUR;
    step = day * Math.max(1, Math.ceil(top / want / day));
  }
  const ticks: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(v);
  return ticks;
}

export interface PlacedStream {
  series: StreamSeries;
  /** The step path, in viewBox units, ending flat at the stream's own `endX`. */
  d: string;
  endCx: number;
  endCy: number;
  labelY: number;
}

export interface StreamChartLayout {
  xTicks: number[];
  yTicks: number[];
  xMax: number;
  yMax: number;
  placed: PlacedStream[];
  px: (x: number) => number;
  py: (y: number) => number;
}

/**
 * Place the series in a plot box: the step paths, and the end labels nudged
 * apart so two streams holding the same level do not print on top of each other.
 *
 * The y axis runs from zero rather than from the lowest level drawn. A level
 * axis with a floating base would make a character that gained two levels look
 * like the whole chart, and level 1 is a real origin — it is where every
 * character starts.
 */
export function streamChartLayout(series: readonly StreamSeries[], box: ChartBox): StreamChartLayout {
  const xMax = Math.max(1, ...series.map((s) => s.endX));
  const yTicks = niceTicks(Math.max(1, ...series.map((s) => s.endLevel)));
  const yMax = yTicks[yTicks.length - 1]!;
  const px = scaleLinear([0, xMax], [box.x0, box.x1]);
  const py = scaleLinear([0, yMax], [box.y0, box.y1]);

  const placed: PlacedStream[] = [];
  const takenY: number[] = [];
  for (const s of series) {
    const steps: string[] = [];
    for (const [i, p] of s.points.entries()) {
      const x = px(p.x);
      const y = py(p.level);
      if (i === 0) steps.push(`M${x.toFixed(1)},${y.toFixed(1)}`);
      else steps.push(`H${x.toFixed(1)}`, `V${y.toFixed(1)}`);
    }
    const endCx = px(s.endX);
    const endCy = py(s.endLevel);
    steps.push(`H${endCx.toFixed(1)}`);
    // The label sits at the end of the line, pushed down in whole label rows
    // until it clears every label already placed. Down, not up: the series are
    // placed furthest-first, so the leader keeps its natural position.
    let labelY = endCy + LABEL_H * 0.3;
    // …but never off the bottom of the plot. Once the field is crowded enough
    // that pushing down would leave the box, the label stays where it is and
    // overlaps rather than walking out of the viewBox, which is the same call
    // `ladderChartLayout`'s `inside()` guard makes.
    while (labelY + LABEL_H <= box.y0 && takenY.some((t) => Math.abs(t - labelY) < LABEL_H)) labelY += LABEL_H;
    takenY.push(labelY);
    placed.push({ series: s, d: steps.join(" "), endCx, endCy, labelY });
  }
  return { xTicks: timeTicks(xMax), yTicks, xMax, yMax, placed, px, py };
}
