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

import type { LevelMark, ResultRun } from "@viewer/api-types";
import {
  type AxisSpec,
  type Better,
  COST,
  DEFAULT_BETTER,
  METRIC_KEYS,
  type Metrics,
  type RunCostReading,
  XP,
  betterCorner,
  runCostReading,
  runMetrics,
} from "./axes";
import { niceTicks, scaleLinear } from "./chart";
import { modelDisplay } from "./format";
import { chainsOf } from "@viewer/lineage";
import { OPAQUE_PAUSE_REASON, type RunStatus, statusOf as runStatusOf } from "./runs";

export function scored(runs: readonly ResultRun[]): ResultRun[] {
  return runs.filter((r) => r.unscored === null);
}

/* ----------------------------------------------------------------- filters */

/**
 * The one control above the chart that narrows on a run's own recorded fields.
 *
 * Race, class and harness were three more until the operator took them off
 * the page: every scored run is the same baseline character, so
 * race and class asked a question an episode cannot answer differently, and
 * the harness select duplicated the shell's series selector. What is left is
 * one question — does a run count as evidence we paid for. The model line and
 * company filters that replaced them are derived from the model slug rather
 * than read off a run, so they live in `lib/ladderfilter.ts` and not here.
 */

export interface LadderFilter {
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
  return runs.filter((r) => !f.excludeFree || r.billing !== "free");
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
  /**
   * Whether *this run's* records can answer the rung at all — the denominator
   * of the cell's "2 of 3", and the one thing that keeps that fraction honest.
   *
   * A run that predates the producer of a signal carries no reading for it and
   * must be treated as not recorded rather than as zero (METHODOLOGY,
   * "Scoring"). `test` already folds both cases into "not reached", which is
   * right for a cell that only says reached-or-not; a *count* cannot, because
   * "1 of 3" over a row whose other two runs could never be asked reports two
   * failures that nobody observed. So the count is out of the runs that could
   * be asked, and the cell says so when that is fewer than the row's runs.
   */
  askable: (run: ResultRun) => boolean;
}

/** A level rung can be asked of any run that recorded a level. */
const hasLevel = (r: ResultRun): boolean => r.maxLevel !== null;

/** Outland and Northrend map ids — the only continents past the first two. */
export const EXPANSION_MAPS = [530, 571];

/**
 * The eight rungs of the milestone ladder (docs/VISION.md), with the derivation each one gets from the
 * data that actually exists.
 *
 * Rungs 2 and 4 became derivable when the viewer was wired to the zone/area
 * milestone records the loop writes: `run.areas` carries the first area
 * observed, whether the run ever left it, and the first capital zone it
 * entered. Rung 4 stopped being partial soon after (issue #8): the module now
 * taps
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
 * Deaths and the level timeline joined the milestone records later
 * (`run.deaths`, `run.leveling`), but neither bears on a rung: no rung asks how
 * often a character died, and the level rungs already read `maxLevel`.
 *
 * Rung 6 stays not instrumented, and what it lacks is specifically: a record of
 * joining or leaving a party (no group milestone exists) and a record of
 * entering an instance (no instance milestone exists — a map-id change in the
 * state samples is not one, since it cannot tell a dungeon from a boat ride).
 * Even with both, the harness runs one character per session, so the rung's
 * "party of agents" clause needs multi-session work that does not exist
 * either. The framing of that rung is issue #9, and what it would take is
 * written up in docs/proposals/GROUP-PLAY.md.
 */
export const RUNGS: Rung[] = [
  {
    n: 1,
    title: "Quest chain in the starting subzone",
    rule: "level 5 observed — the starting chain ends around L5–6",
    test: (r) => (r.maxLevel ?? 0) >= 5,
    askable: hasLevel,
  },
  {
    n: 2,
    title: "Leave the starting subzone on its own initiative",
    rule: "left the first-observed area; older runs have no record of this",
    test: (r) => r.areas?.leftStartArea === true,
    askable: (r) => r.areas !== null && r.areas !== undefined,
  },
  {
    n: 3,
    title: "L10: class quest, first talent, spells trained",
    rule: "level 10 observed — the talent and class-quest half is not recorded",
    test: (r) => (r.maxLevel ?? 0) >= 10,
    askable: hasLevel,
  },
  {
    n: 4,
    title: "Reach a capital city; use a flight master",
    rule:
      "entered a capital zone AND took at least one flight (milestone records); " +
      "runs before the achievement/flight taps have no flight record and cannot pass",
    test: (r) => (r.areas?.capitalZone ?? null) !== null && (r.taxi?.flights ?? 0) >= 1,
    askable: (r) => r.areas !== null && r.areas !== undefined && r.taxi !== null && r.taxi !== undefined,
  },
  {
    n: 5,
    title: "L20 with riding skill and a mount",
    rule: "level 20 observed — riding skill and mount purchase are not recorded",
    test: (r) => (r.maxLevel ?? 0) >= 20,
    askable: hasLevel,
  },
  {
    n: 6,
    title: "A 5-man dungeon cleared by a party of agents",
    rule:
      "needs grouping and instance records; the harness runs one character per " +
      "session (docs/proposals/GROUP-PLAY.md)",
    test: null,
    askable: () => false,
  },
  {
    n: 7,
    title: "L40, L60, Outland, Northrend",
    rule: "level 40 observed, or a state sample on map 530 (Outland) or 571 (Northrend)",
    test: (r) => (r.maxLevel ?? 0) >= 40 || r.maps.some((m) => EXPANSION_MAPS.includes(m)),
    askable: (r) => hasLevel(r) || r.maps.length > 0,
  },
  {
    n: 8,
    title: "L80, heroics, Icecrown Citadel",
    rule: "level 80 observed — heroics and raid progress are not recorded",
    test: (r) => (r.maxLevel ?? 0) >= 80,
    askable: hasLevel,
  },
];

export interface LadderCell {
  n: number;
  status: RungStatus;
  /**
   * The run that got there, for a reached rung: the first of the row's runs
   * that passes the test, which is not necessarily the furthest one. It stays
   * the cell's link — the count below is what tells a model that cleared the
   * rung once from one that cleared it every time.
   */
  runId: string | null;
  /** How many of the row's runs passed the rung's test. */
  reached: number;
  /**
   * How many of the row's runs could be asked (`Rung.askable`) — the
   * denominator. Below `LadderRow.runs` when some of the row's runs predate
   * the record the rung reads; the page says so rather than counting a run
   * that was never asked as a failure.
   */
  askable: number;
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
  /**
   * How far apart the row's runs finished, in levels. Null when no counted run
   * recorded a level — never a zero, which is a reading.
   */
  levelRange: LevelRange | null;
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
 * The spread of levels a row's counted runs finished at.
 *
 * The row's headline numbers are maxima and the file has always been plain
 * about it. A maximum over three runs is still one reading of three, so the
 * row also carries what those three cost the fleet to buy: the tier is an
 * evidence budget (METHODOLOGY, "The tier is the evidence budget" — `t1` buys
 * e90 ×3) and the dispersion is already paid for.
 *
 * The median is an *observed* level, never an interpolation: on an even count
 * it is the lower of the two middles. Levels are integers the game handed out,
 * and half a level is a number no run was at — the same rule that keeps the
 * `(level, xp)` pair from being flattened into a synthetic total.
 *
 * Runs with no level reading are left out entirely rather than counted as
 * zero, so `n` is the runs this range actually rests on and may be fewer than
 * the row's runs.
 */
export interface LevelRange {
  min: number;
  median: number;
  max: number;
  /** How many counted runs carried a level reading. */
  n: number;
}

export function levelRangeOf(runs: readonly ResultRun[]): LevelRange | null {
  const levels = runs.map((r) => r.maxLevel).filter((l): l is number => l !== null);
  if (levels.length === 0) return null;
  const sorted = [...levels].sort((a, b) => a - b);
  // Lower of the two middles on an even count: an observed level, not a mean.
  const median = sorted[Math.floor((sorted.length - 1) / 2)]!;
  return { min: sorted[0]!, median, max: sorted[sorted.length - 1]!, n: sorted.length };
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
 * (as amended): **highest rung reached, then total XP, then gold.**
 * Total XP is the `(level, xp)` pair compared lexicographically — xp resets at
 * every ding and level never falls, so the pair *is* the total-XP ordering, and
 * no `level * K + xp` integer is synthesised because no XP-per-level table
 * exists in what the harness records. Both are maxima over the model's counted
 * runs; `runs` and the model name break what is left, so the order is total and
 * stable. A missing reading sorts last rather than as zero: 0 copper and 0 xp
 * are real readings, null is "never recorded". No number here is added to
 * another — there is still no aggregate score.
 *
 * The row also carries its own dispersion: every cell
 * counts how many of the row's askable runs passed the rung, and `levelRange`
 * is the min/median/max of the levels the counted runs reached. The maxima
 * stay exactly what they were — they are honest about being maxima — and the
 * spread sits beside them rather than replacing them, so a model that reached
 * a rung once in three no longer renders identically to one that reached it
 * three times. It is pure derivation over the same list: no new recording, no
 * re-runs, and nothing here enters the ordering.
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
      if (rung.test === null)
        return { n: rung.n, status: "not-instrumented", runId: null, reached: 0, askable: 0 };
      const hit = list.find((r) => rung.test!(r));
      return {
        n: rung.n,
        status: hit === undefined ? "not-reached" : "reached",
        runId: hit?.runId ?? null,
        reached: list.filter((r) => rung.test!(r)).length,
        askable: list.filter((r) => rung.askable(r)).length,
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
      levelRange: levelRangeOf(list),
      harnesses: [...new Set(list.map((r) => r.harness ?? "—"))].sort(),
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

/*
 * The readings themselves — `runCostReading`, `xpEarnedOf`, and the rest of
 * the metric bag — live in `lib/axes.ts` with the axis specs that name them.
 * Re-exported here because this is where callers learned to find them.
 */
export { runCostReading, xpEarnedOf, type RunCostReading } from "./axes";

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
  /** The mean of the x axis's metric, over the `n` runs carrying both axes' readings. */
  x: number;
  /** The mean of the y axis's metric, over the same `n` runs. */
  y: number;
  /**
   * The mean of every metric over those same `n` runs — null where none of
   * them carries it. `x` and `y` are two of these; the rest are what the hover
   * can add without a run being counted twice or a mean resting on a
   * different set than the mark does.
   */
  metrics: Metrics;
  /** Counted runs of this entry on the tier, including those that fed neither mean. */
  runs: number;
  /** The runs both means rest on: those carrying a reading for the x axis AND for the y axis. */
  n: number;
  /**
   * Whether every priced run among the `n` was provider-reported, every one
   * list-priced, or both; null when none of them carries a price, which
   * cannot happen while cost is an axis.
   */
  basis: "reported" | "list-price" | "mixed" | null;
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
  /** `no cost reading`, `no xp reading`, `no run with both cost and xp` — worded from the axes in view. */
  why: string;
}

/**
 * The entry's identity: the model string as recorded, never shortened. It is a
 * lookup key (`pareto.ts` matches a Set of these), so a display form of it is
 * built separately — see `LadderPoint.label`.
 */
/**
 * What a hovered pin and a hovered table row have in common.
 *
 * The scatter draws one point per (model, effort) and the table draws one row
 * per model — deliberately, on both sides: a model's row is its best run
 * whatever effort it was played at, and a point is a mean that only means
 * something within one effort. So the thing the two can agree on is the model,
 * and hovering either end lights the row and every one of its pins.
 *
 * The fallback matters: both derivations key an unrecorded model as
 * `(unnamed)`, and a hover that used the raw null on one side and the string
 * on the other would light nothing on exactly the rows nobody can name.
 */
export function hoverKeyOf(model: string | null | undefined): string {
  return model ?? "(unnamed)";
}

export function pointKey(model: string, effort: string | null): string {
  return effort === null ? model : `${model} (${effort})`;
}

/** The drawn label is the key alone; the run count lives in the hover text. */
export function pointLabel(key: string, _runs: number): string {
  return key;
}

/**
 * One point per (model, effort) over the scored runs given — the same rows
 * the ladder table draws, so the chart never shows an entry the table lacks.
 *
 * Both coordinates are means over the SAME runs: the entry's counted runs
 * that carry a reading for both axes. A run with only one of the two is left
 * out of both means — pairing one run's price with another run's xp puts a
 * point nowhere any run was, and a label that then prints the larger n
 * overstates what the mark rests on. `n` is the number of runs the means
 * share; `runs` keeps the entry's full counted total so the hover can say how
 * many were left out. An entry with no run carrying both is omitted and
 * named, never plotted at zero — a $0 free model is a reading, a missing one
 * is not. The axes default to cost and xp; any pair of `AxisSpec`s applies
 * the same rule to its own two readings.
 */
export function ladderPoints(
  runs: readonly ResultRun[],
  x: AxisSpec = COST,
  y: AxisSpec = XP,
): { points: LadderPoint[]; omitted: LadderOmission[] } {
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
    const paired: { run: ResultRun; m: Metrics; xv: number; yv: number }[] = [];
    let anyX = false;
    let anyY = false;
    for (const run of g.runs) {
      const m = runMetrics(run);
      const xv = x.accessor(m);
      const yv = y.accessor(m);
      anyX ||= xv !== null;
      anyY ||= yv !== null;
      if (xv !== null && yv !== null) paired.push({ run, m, xv, yv });
    }
    if (paired.length === 0) {
      // Say which reading is missing when only one is; both present on
      // different runs is its own case, and named as such.
      omitted.push({
        key,
        label: pointKey(modelDisplay(g.model), g.effort),
        why: !anyX ? `no ${x.label} reading` : !anyY ? `no ${y.label} reading` : `no run with both ${x.label} and ${y.label}`,
      });
      continue;
    }
    const n = paired.length;
    const mean = (vs: readonly number[]): number => vs.reduce((s, v) => s + v, 0) / vs.length;
    const metrics = Object.fromEntries(
      METRIC_KEYS.map((k) => {
        const vs = paired.map((p) => p.m[k]).filter((v): v is number => v !== null);
        return [k, vs.length === 0 ? null : mean(vs)];
      }),
    ) as Metrics;
    const costs = paired.map((p) => runCostReading(p.run)).filter((c): c is RunCostReading => c !== null);
    const bases = new Set(costs.map((c) => c.basis));
    points.push({
      key,
      label: pointLabel(pointKey(modelDisplay(g.model), g.effort), n),
      single: n === 1,
      model: g.model,
      effort: g.effort,
      x: mean(paired.map((p) => p.xv)),
      y: mean(paired.map((p) => p.yv)),
      metrics,
      runs: g.runs.length,
      n,
      basis: bases.size === 0 ? null : bases.size > 1 ? "mixed" : bases.has("reported") ? "reported" : "list-price",
      asIfMetered: costs.some((c) => c.asIfMetered),
      harnesses: [...new Set(g.runs.map((r) => r.harness ?? "—"))].sort(),
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

/** One straight segment in viewBox units, from a mark towards its label. */
export interface Leader {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** An axis-aligned box in viewBox units: `l < r`, `t < b` (SVG y grows downward). */
export interface Rect {
  l: number;
  t: number;
  r: number;
  b: number;
}

export interface PlacedPoint {
  point: LadderPoint;
  cx: number;
  cy: number;
  /** The label's anchor point and baseline, in viewBox units. */
  labelX: number;
  labelY: number;
  anchor: "start" | "middle" | "end";
  /** The label's box — descenders and `LABEL_PAD` included — as the collision pass saw it. */
  rect: Rect;
  /** Which ring the slot came from: 1 adjacent to the mark, 2 and 3 one and two rows further out. */
  ring: 1 | 2 | 3 | 4 | 5;
  /**
   * From the mark's edge to the label's nearest edge, when the label is not
   * adjacent (ring 2 or 3) or is `crowded` — the line that says which mark a
   * displaced label belongs to. Null for an adjacent label, which needs none.
   */
  leader: Leader | null;
  /**
   * Every candidate collided with something. This is the in-box slot with the
   * least overlap, drawn anyway: a hidden label is worse than an ugly one.
   */
  crowded: boolean;
}

export interface LadderChartLayout {
  /** The x axis's scale, as its spec chose: the rest of the x fields read differently under each. */
  xScale: AxisSpec["scale"];
  /** Decade ticks on a log axis (0.01, 0.1, 1, … up to the ceiling); `niceTicks` from zero on a linear one. */
  xTicks: number[];
  /** The 2× and 5× lines inside each decade — gridlines only, never labelled. Empty on a linear axis. */
  xMinorTicks: number[];
  yTicks: number[];
  /** The x axis ceiling: the top decade, or the top linear tick. */
  xMax: number;
  yMax: number;
  /** Where the log axis begins: the plot's left edge, or past the free gutter. The plot's left edge on a linear axis. */
  axisX0: number;
  /** The centre of the free gutter, where a $0 entry is drawn. */
  freeX: number;
  /** Where the divider between the gutter and the log axis is drawn. */
  dividerX: number;
  /** Whether any entry cost nothing, and so whether the gutter is there at all. Never on a linear axis. */
  hasFree: boolean;
  placed: PlacedPoint[];
  /** The reading-direction cue in the better corner, placed before any label and kept clear of every mark. */
  cue: ChartCue;
  /** The same value→pixel maps the points were placed with, for the chart's own tick gridlines. */
  px: (x: number) => number;
  py: (y: number) => number;
}

/* ----------------------------------------------------------- label metrics */

/**
 * Point labels and the character chart's end labels are set at 10 viewBox units;
 * axis tick labels stay at 11. The viewBox is 1000 wide, so at a 600px render
 * a 10-unit label is 6 CSS px and an 11-unit one 6.6 — both already at the
 * floor of legibility, which is why the page scrolls the chart inside a 640px
 * floor below 720px rather than shrinking it further (`.wide-scroll`). The
 * unit down on the labels buys about a tenth more room for the placement in
 * exactly the crowded corner that needs it; the ticks keep the extra unit
 * because there are few of them and they are the axis a reader anchors to.
 */
export const LABEL_FONT = 10;
export const TICK_FONT = 11;

/**
 * Label width estimate: `CHAR_W` per character.
 *
 * The label font is the body's monospace stack (`ui-monospace, SFMono-Regular,
 * Menlo, monospace`), so a label's width really is its length times one
 * advance. The advance of those faces is 0.6 em: Menlo and its parent DejaVu
 * Sans Mono (the usual Linux fallback) set it at 1233/2048 = 0.602 em, and SF
 * Mono at 1229/2048 = 0.600 em. At 10 units that is 6.0. A bound the
 * placement can trust rather than a text measure, which a DOM-free layout
 * cannot take.
 */
export const CHAR_W = 0.6 * LABEL_FONT;
/** The label box above its baseline: one em covers ascenders and the internal leading. */
export const LABEL_H = LABEL_FONT;
/**
 * …and below it: a quarter em, the descender depth of g, p, q and y. The
 * previous box stopped at the baseline, so a label's descenders were free to
 * sit on the row beneath.
 */
export const LABEL_DESC = 0.25 * LABEL_FONT;
/** One label row — the box's full height, the pitch the outer rings and the character chart's stack step by. */
export const LABEL_ROW = LABEL_H + LABEL_DESC;
/** Breathing room either side of the letters, so two labels on one row never touch. */
export const LABEL_PAD = 2;
/** Cap height, 0.7 em: what a label centred on a mark is centred by. */
const CAP_H = 0.7 * LABEL_FONT;

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

/* -------------------------------------------------------- the log axis */

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

/**
 * What a log axis is parameterised by. Cost's values are the constants above;
 * `logScale` takes them as an argument so that a second log axis, should a
 * metric ever earn one, states its own floor rather than borrowing a cent's.
 */
export interface LogAxisOptions {
  floor: number;
  ceilingMin: number;
  gutterW: number;
}

export const COST_LOG: LogAxisOptions = { floor: COST_FLOOR, ceilingMin: COST_CEILING_MIN, gutterW: FREE_GUTTER_W };

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
function decadeCeiling(max: number, ceilingMin: number): number {
  if (!(max > ceilingMin)) return ceilingMin;
  let e = Math.ceil(Math.log10(max));
  if (10 ** (e - 1) >= max) e -= 1;
  while (10 ** e < max) e += 1;
  return 10 ** e;
}

/**
 * A log scale with a floor and a zero gutter for a set of values, mapped
 * across `[x0, x1]`.
 *
 * Data-independent: the floor, the gutter width and the minimum ceiling are
 * fixed, and the only thing the data decides is how many decades the axis
 * spans and whether the gutter is drawn. The gutter is keyed on a zero
 * coordinate and not on the page's "exclude free" filter — a local model's
 * list price is $0 whether or not its billing said `free`, and the coordinate
 * is the honest test.
 */
export function logScale(values: readonly number[], x0: number, x1: number, opts: LogAxisOptions): CostScale {
  const positive = values.filter((c) => c > 0);
  const ceiling = decadeCeiling(positive.length === 0 ? 0 : Math.max(...positive), opts.ceilingMin);
  const hasFree = values.some((c) => c <= 0);
  const axisX0 = hasFree ? x0 + opts.gutterW : x0;
  const freeX = x0 + opts.gutterW / 3;
  const dividerX = x0 + (opts.gutterW * 2) / 3;

  const ticks: number[] = [];
  for (let v = opts.floor; v <= ceiling * 1.0000001; v *= 10) ticks.push(Number(v.toPrecision(12)));
  const minorTicks: number[] = [];
  for (const t of ticks) {
    for (const m of [2, 5]) {
      const v = Number((t * m).toPrecision(12));
      if (v < ceiling) minorTicks.push(v);
    }
  }

  const lo = Math.log10(opts.floor);
  const hi = Math.log10(ceiling);
  const px = (v: number): number => {
    if (!(v > 0)) return hasFree ? freeX : axisX0;
    const c = Math.min(Math.max(v, opts.floor), ceiling);
    return axisX0 + ((Math.log10(c) - lo) / (hi - lo)) * (x1 - axisX0);
  };
  return { floor: opts.floor, ceiling, ticks, minorTicks, hasFree, axisX0, freeX, dividerX, px };
}

/** The cost axis: `logScale` at cost's floor, ceiling and gutter. */
export function costScale(costs: readonly number[], x0: number, x1: number): CostScale {
  return logScale(costs, x0, x1, COST_LOG);
}

/** A decade tick's label: cents below a dollar, dollars at and above one. `COST.format`, kept under the name callers know. */
export function fmtCostTick(usd: number): string {
  return COST.format(usd);
}

/* ------------------------------------------------------- label placement */

/** Whether two boxes share any area. Touching edges do not count. */
export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t;
}

/** The area two boxes share; zero when they do not. */
function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.r, b.r) - Math.max(a.l, b.l);
  const h = Math.min(a.b, b.b) - Math.max(a.t, b.t);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * Whether two segments properly cross — meet at one interior point of each.
 * The standard orientation test; collinear or end-touching pairs do not count,
 * which for two leaders is the right call: only a genuine X misleads the eye.
 */
export function segmentsCross(a: Leader, b: Leader): boolean {
  const orient = (px: number, py: number, qx: number, qy: number, rx: number, ry: number): number =>
    Math.sign((qx - px) * (ry - py) - (qy - py) * (rx - px));
  const o1 = orient(a.x1, a.y1, a.x2, a.y2, b.x1, b.y1);
  const o2 = orient(a.x1, a.y1, a.x2, a.y2, b.x2, b.y2);
  const o3 = orient(b.x1, b.y1, b.x2, b.y2, a.x1, a.y1);
  const o4 = orient(b.x1, b.y1, b.x2, b.y2, a.x2, a.y2);
  return o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0 && o1 !== o2 && o3 !== o4;
}

/** Whether a segment passes through a box: an endpoint inside it, or a crossing of one of its edges. */
function segmentHitsRect(s: Leader, r: Rect): boolean {
  const inside = (x: number, y: number): boolean => x > r.l && x < r.r && y > r.t && y < r.b;
  if (inside(s.x1, s.y1) || inside(s.x2, s.y2)) return true;
  const edges: Leader[] = [
    { x1: r.l, y1: r.t, x2: r.r, y2: r.t },
    { x1: r.r, y1: r.t, x2: r.r, y2: r.b },
    { x1: r.r, y1: r.b, x2: r.l, y2: r.b },
    { x1: r.l, y1: r.b, x2: r.l, y2: r.t },
  ];
  return edges.some((e) => segmentsCross(s, e));
}

/** The square a mark occupies for collision purposes: its outer ring, bounding-boxed. */
export function puckRect(cx: number, cy: number): Rect {
  return { l: cx - MARK_RING_R, t: cy - MARK_RING_R, r: cx + MARK_RING_R, b: cy + MARK_RING_R };
}

/* ------------------------------------------------------ the direction cue */

/** The small "↖ better" in the corner of a comparison chart: where it is drawn, and the box it keeps. */
export interface ChartCue {
  text: string;
  /** The text's anchor point and baseline. */
  x: number;
  y: number;
  anchor: "start" | "end";
  /** The box the label placers treat as taken. */
  rect: Rect;
}

/** The cue's inset from the plot's edges. */
export const CUE_PAD = 6;

/**
 * Where a chart's reading-direction cue goes: the corner `better` points at,
 * read off the axes (`betterCorner`), so a view whose axes ran the other way
 * would move the cue and its arrow with them rather than leave a lie in the
 * corner. Set in the tick font, since it is axis furniture and not a label.
 *
 * It is an obstacle before it is a mark: the caller seeds its label placer
 * with `rect`, so no point label is ever printed over it. A mark itself can
 * land in the corner — the cheapest, furthest entry sits exactly there — and
 * the cue is the one that gives way, sliding inward along the top or bottom
 * edge past every mark it overlaps; the marks are data and the cue is not.
 *
 * The width is estimated the way labels are (`CHAR_W` scaled to the tick
 * font), with one advance spare for the arrow glyph, which the monospace
 * stack's fallbacks do not all set at one advance.
 */
export function chartCue(box: ChartBox, better: Better, marks: readonly Rect[]): ChartCue {
  const corner = betterCorner(better);
  const text = `${corner.arrow} better`;
  const wide = (text.length + 1) * 0.6 * TICK_FONT + 2 * LABEL_PAD;
  const tall = 1.25 * TICK_FONT;
  const t = corner.v === "top" ? box.y1 + CUE_PAD : box.y0 - CUE_PAD - tall;
  let l = corner.h === "left" ? box.x0 + CUE_PAD : box.x1 - CUE_PAD - wide;
  let rect: Rect = { l, t, r: l + wide, b: t + tall };
  // Slide inward past any mark under it; bounded by the number of marks.
  for (let i = 0; i <= marks.length; i++) {
    const hit = marks.find((m) => rectsOverlap(rect, m));
    if (hit === undefined) break;
    l = corner.h === "left" ? hit.r + LABEL_PAD : hit.l - LABEL_PAD - wide;
    rect = { l, t, r: l + wide, b: t + tall };
  }
  return {
    text,
    x: corner.h === "left" ? rect.l + LABEL_PAD : rect.r - LABEL_PAD,
    y: rect.b - 0.25 * TICK_FONT,
    anchor: corner.h === "left" ? "start" : "end",
    rect,
  };
}

/**
 * The directions a label may sit in, in preference order. Directly above
 * first: a 2024 perceptual study (arXiv:2407.11996) found readers prefer a
 * label centred above its mark to Imhof's classic top-right; then the four
 * diagonals, right before left as Imhof ranks them; then the two horizontal
 * neighbours, whose labels sit on the mark's own row and so cost the most
 * room in a crowded band; then directly below, last because it is the slot
 * the mark's own descent into the next row makes hardest to read.
 */
const SLOT_DIRS: readonly { dx: -1 | 0 | 1; dy: -1 | 0 | 1 }[] = [
  { dx: 0, dy: -1 },
  { dx: 1, dy: -1 },
  { dx: -1, dy: -1 },
  { dx: 1, dy: 1 },
  { dx: -1, dy: 1 },
  { dx: 1, dy: 0 },
  { dx: -1, dy: 0 },
  { dx: 0, dy: 1 },
];

const RINGS = [1, 2, 3, 4, 5] as const;

interface Slot {
  ring: 1 | 2 | 3 | 4 | 5;
  rect: Rect;
  anchor: "start" | "middle" | "end";
  labelX: number;
  labelY: number;
}

/**
 * The candidate boxes for one label of width `w` around a mark at (`cx`,
 * `cy`): the eight directions at each ring's distance. Ring 1 sits
 * `LABEL_GAP` from the centre — clear of the ring around the puck — and each
 * ring after it one label row further out along the same ray, so a diagonal
 * slot steps out diagonally and its leader, if it needs one, is the ray
 * itself. A horizontal slot is centred on the mark by cap height rather than
 * by box, so the letters and not the descender room line up with the puck.
 */
function slotsAround(cx: number, cy: number, w: number): Slot[] {
  const slots: Slot[] = [];
  for (const ring of RINGS) {
    const off = LABEL_GAP + (ring - 1) * LABEL_ROW;
    const wide = w + 2 * LABEL_PAD;
    for (const { dx, dy } of SLOT_DIRS) {
      const l = dx > 0 ? cx + off : dx < 0 ? cx - off - wide : cx - wide / 2;
      const t = dy < 0 ? cy - off - LABEL_ROW : dy > 0 ? cy + off : cy - LABEL_H + CAP_H / 2;
      const rect = { l, t, r: l + wide, b: t + LABEL_ROW };
      slots.push({
        ring,
        rect,
        anchor: dx > 0 ? "start" : dx < 0 ? "end" : "middle",
        labelX: dx > 0 ? rect.l + LABEL_PAD : dx < 0 ? rect.r - LABEL_PAD : cx,
        labelY: rect.b - LABEL_DESC,
      });
    }
  }
  return slots;
}

/**
 * The leader from a mark to a label box: from the ring's edge, along the ray
 * to the box's nearest point, stopping a unit short of the letters.
 */
function leaderTo(cx: number, cy: number, rect: Rect): Leader {
  const qx = Math.min(Math.max(cx, rect.l), rect.r);
  const qy = Math.min(Math.max(cy, rect.t), rect.b);
  const dx = qx - cx;
  const dy = qy - cy;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  return { x1: cx + ux * MARK_RING_R, y1: cy + uy * MARK_RING_R, x2: qx - ux, y2: qy - uy };
}

/**
 * Where everything goes. The x axis is whichever scale its spec names — the
 * log axis above with its free gutter for cost, `niceTicks` from zero for
 * anything else — and y is always linear from zero; then the labels.
 *
 * Labels are placed greedily in importance order — highest xp first, then
 * cheapest, then by label and key so the result is a function of the set and
 * not of the order the runs arrived in — against a collision set that starts
 * out holding every mark (`puckRect`), because a label over a neighbour's
 * puck hides a point, which is worse than hiding a name. Each label tries the
 * candidates of `slotsAround` in order and takes the first that is inside the
 * plot, overlaps nothing placed, and — past ring 1 — whose leader crosses no
 * leader already drawn and passes through no label or mark. Failing that, a
 * leader that crosses is tolerated before a label is; failing that too, the
 * in-box candidate overlapping the least area is taken and flagged `crowded`,
 * with its leader, rather than the label being dropped or the cluster
 * collapsed: the operator's rule is that a hidden label is worse than an ugly
 * one, and the flag is what lets the chart say so.
 */
export function ladderChartLayout(
  points: readonly LadderPoint[],
  box: ChartBox,
  xSpec: AxisSpec = COST,
  ySpec: AxisSpec = XP,
): LadderChartLayout {
  const xs = points.map((p) => p.x);
  let xAxis: Pick<LadderChartLayout, "xTicks" | "xMinorTicks" | "xMax" | "axisX0" | "freeX" | "dividerX" | "hasFree" | "px">;
  if (xSpec.scale === "log-cost") {
    const cost = costScale(xs, box.x0, box.x1);
    xAxis = {
      xTicks: cost.ticks,
      xMinorTicks: cost.minorTicks,
      xMax: cost.ceiling,
      axisX0: cost.axisX0,
      freeX: cost.freeX,
      dividerX: cost.dividerX,
      hasFree: cost.hasFree,
      px: cost.px,
    };
  } else {
    // Linear, from zero, like y: a count of turns or tokens has a real origin
    // and no gutter to keep — zero is on the axis.
    const xTicks = niceTicks(Math.max(0, ...xs));
    const xMax = xTicks[xTicks.length - 1]!;
    xAxis = {
      xTicks,
      xMinorTicks: [],
      xMax,
      axisX0: box.x0,
      freeX: box.x0,
      dividerX: box.x0,
      hasFree: false,
      px: scaleLinear([0, xMax], [box.x0, box.x1]),
    };
  }
  const px = xAxis.px;
  // y is linear from zero whatever the metric; the spec's part is the format
  // and the caption, which the component reads from it directly.
  const yTicks = niceTicks(Math.max(0, ...points.map((p) => p.y)));
  const yMax = yTicks[yTicks.length - 1]!;
  const py = scaleLinear([0, yMax], [box.y0, box.y1]);

  const ordered = [...points].sort(
    (a, b) => b.y - a.y || a.x - b.x || a.label.localeCompare(b.label) || a.key.localeCompare(b.key),
  );
  const marks = ordered.map((p) => ({ p, cx: px(p.x), cy: py(p.y) }));
  // Every mark is in the way before any label is — and so is the corner cue,
  // which has already stepped aside from the marks itself. It is appended,
  // not prepended: `taken[i]` is mark i's own box below.
  const markRects = marks.map((m) => puckRect(m.cx, m.cy));
  const cue = chartCue(box, { x: xSpec.better, y: ySpec.better }, markRects);
  const taken: Rect[] = [...markRects, cue.rect];
  const leaders: Leader[] = [];
  const overlaps = (a: Rect): boolean => taken.some((b) => rectsOverlap(a, b));
  // A label may rise into the top margin by its own height (the axis label
  // is not there) but never below the baseline, where the tick labels live.
  const inside = (a: Rect): boolean =>
    a.l >= box.x0 - 2 && a.r <= box.x1 + 2 && a.t >= box.y1 - LABEL_H && a.b <= box.y0;

  const placed: PlacedPoint[] = [];
  for (const [i, { p, cx, cy }] of marks.entries()) {
    const own = taken[i]!;
    const slots = slotsAround(cx, cy, p.label.length * CHAR_W);
    const leaderOf = (s: Slot): Leader | null => (s.ring === 1 ? null : leaderTo(cx, cy, s.rect));
    const leaderClean = (l: Leader | null): boolean =>
      l === null || (!leaders.some((o) => segmentsCross(l, o)) && !taken.some((r) => r !== own && segmentHitsRect(l, r)));
    const free = slots.filter((s) => inside(s.rect) && !overlaps(s.rect));
    let pick = free.find((s) => leaderClean(leaderOf(s))) ?? free[0];
    let crowded = false;
    if (pick === undefined) {
      crowded = true;
      const inBox = slots.filter((s) => inside(s.rect));
      const pool = inBox.length > 0 ? inBox : slots;
      let least = Infinity;
      for (const s of pool) {
        const area = taken.reduce((sum, r) => sum + overlapArea(s.rect, r), 0);
        if (area < least) {
          least = area;
          pick = s;
        }
      }
    }
    const slot = pick!;
    const leader = crowded ? leaderTo(cx, cy, slot.rect) : leaderOf(slot);
    taken.push(slot.rect);
    if (leader !== null) leaders.push(leader);
    placed.push({
      point: p,
      cx,
      cy,
      labelX: slot.labelX,
      labelY: slot.labelY,
      anchor: slot.anchor,
      rect: slot.rect,
      ring: slot.ring,
      leader,
      crowded,
    });
  }
  return { xScale: xSpec.scale, ...xAxis, yTicks, yMax, placed, cue, py };
}

/* ------------------------------------------------------- freeplay characters */

/**
 * The freeplay ladder is a different question, and so a different derivation.
 *
 * It is **an overview of the top characters on freeplay right now** — the
 * whole active field, not a leaderboard of finished evidence. So `scored()` is not applied here, and it is not that a filter was
 * forgotten: every freeplay run is `unscored (episode freeplay)` by definition
 * (`unscoredReason` in `runner/viewer/results.ts`), which is exactly why
 * `ladderRows` showed this page an empty table. What is dropped instead is a
 * launch that produced nothing — `stillborn`, the scheduler's own notion,
 * decided server-side — and nothing else. Live, paused and ended runs all
 * belong on this page; their state is a column, not a filter.
 *
 * And a character is **one character across attempts** (docs/RUNBOOK.md,
 * "Freeplay characters are durable"). A row is a character, not a run and not a
 * model: attempt 12 continues attempt 11 on the same character, so listing
 * both would show the same character twice with the older one looking behind.
 * The lineage is `continuedFrom`; the latest attempt carries the character's
 * current level and state, the tallies are summed over the chain, and the chain
 * rides along so a reader can see how many attempts are behind it.
 *
 * The scored ladders are untouched — `ladderRows` is still keyed by model and
 * still reads scored runs only.
 */

/** What a character is doing now. */
/** The same three states `lib/runs.ts` reads; one verdict, two pages. */
export type CharacterStatus = RunStatus;

export interface CharacterRow {
  /** The chain root's run id: the character's identity across attempts. */
  characterId: string;
  model: string;
  /** The effort the latest attempt ran at, when it recorded one. */
  effort: string | null;
  /** The latest attempt — the run whose readings this row shows. */
  latest: ResultRun;
  /** Attempts in the chain, oldest first. `attempts` is its length. */
  chain: string[];
  attempts: number;
  status: CharacterStatus;
  /**
   * The recorded reason behind `status`: the pause reason while paused, the
   * termination reason once ended, null while live. A character whose ref an
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
  /**
   * Quests completed by the CHARACTER, summed over the chain.
   *
   * The runner's counter is per attempt (`completions.length`, which starts
   * again at every continuation), so the latest attempt's reading is the last
   * session's tally and not the character's. Summed here for the same reason the
   * run page's `character.totals` sums it server-side, with the same rule: an
   * attempt that recorded none contributes nothing, and a character where NONE
   * did stays null rather than claiming zero.
   *
   * Level, xp and money above are deliberately not summed: they are what the
   * character holds now, and the furthest attempt is the one that knows.
   */
  questsCompleted: number | null;
  startedAt: number | null;
}


function statusOf(r: ResultRun): { status: CharacterStatus; detail: string | null } {
  const status = runStatusOf(r);
  if (status === "paused") return { status, detail: r.pauseReason === OPAQUE_PAUSE_REASON ? null : r.pauseReason };
  if (status === "ended") return { status, detail: r.terminationReason };
  return { status, detail: null };
}

/**
 * Collapse a set of freeplay runs into one row per character.
 *
 * The chain walk itself is `runner/viewer/lineage.ts` — shared with the runs table and
 * the run page, so the field and the inventory cannot disagree about which
 * attempts belong to one character, and written there for the cases production
 * produces (a predecessor the set does not hold, a fork, a malformed cycle).
 * The tie-break a fork gets there is the one this row applies: the later start.
 *
 * Order: level, then xp within it, then gold — the same "furthest, then
 * richest" comparison the scored ladder uses, with a missing reading sorting
 * last rather than as zero. Ties fall back to the most recent start and then
 * the character id, so the order is total and stable.
 */
export function characterRows(runs: readonly ResultRun[]): CharacterRow[] {
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
  const byId = new Map(kept.map((r) => [r.runId, r]));
  /** A tally over the chain's attempts: null only when none of them recorded one. */
  const overChain = (chain: readonly string[], of: (r: ResultRun) => number | null): number | null => {
    let total = 0;
    let any = false;
    for (const id of chain) {
      const v = byId.get(id);
      const n = v === undefined ? null : of(v);
      if (n === null) continue;
      total += n;
      any = true;
    }
    return any ? total : null;
  };
  const rows: CharacterRow[] = [];
  for (const [characterId, { chain, run }] of best) {
    const { status, detail } = statusOf(run);
    rows.push({
      characterId,
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
      questsCompleted: overChain(chain, (r) => r.questsCompleted),
      startedAt: run.startedAt,
    });
  }
  rows.sort(
    (a, b) =>
      desc(b.level, a.level) ||
      desc(b.xp, a.xp) ||
      desc(b.money, a.money) ||
      desc(b.startedAt, a.startedAt) ||
      a.characterId.localeCompare(b.characterId),
  );
  return rows;
}

/* ------------------------------------------------- the freeplay character chart */

/**
 * A character's level timeline, stitched across its attempts.
 *
 * **The axis is cumulative active playtime, not wall clock and not turns.**
 * The scored ladders' own graph (`components/LadderChart`) has no time axis at
 * all — it is a cost/xp scatter — so the family member this borrows from is the
 * run page's `XpChart`, whose x is elapsed wall clock bounded by the episode
 * deadline. That bound is exactly what a freeplay character does not have, and
 * the three reasons the axis changes with it:
 *
 * - a freeplay character is unbounded and spends days paused between attempts, so
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
 * `leveling` facts of the milestone series: `LevelUpMark` carries `ts` and `turn` and
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
 * twelve-attempt character does not draw eleven phantom rises; a mark *above* it
 * is a ding that happened in the unobserved gap and draws its step at the seam.
 */
export interface CharacterPoint {
  /** Cumulative active playtime across the character, in ms. */
  x: number;
  level: number;
  /** The attempt the mark was recorded on, and its wall-clock instant. */
  runId: string;
  ts: number;
}

export interface CharacterSeries {
  characterId: string;
  /**
   * What the line is labelled with: the model, and its effort where the entry
   * has one. It was the character name until then, and
   * a character name answers a question nobody brought to this chart — freeplay
   * is one character per model and effort, so the name is a synonym for the
   * label at best and a riddle at worst.
   */
  label: string;
  /** The character's own name, for the hover; null when no run recorded one. */
  character: string | null;
  model: string;
  /** The effort behind `model`, so two characters of one model are told apart. */
  effort: string | null;
  status: CharacterStatus;
  attempts: number;
  /** The attempt the series ends on — where a click on the line goes. */
  latestRunId: string;
  points: CharacterPoint[];
  /** Where the line stops: the character's total active time. "Now", while live. */
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

export interface CharacterChartModel {
  series: CharacterSeries[];
  /** A character that could not be drawn, and the reason, in `ladderPoints`' shape. */
  omitted: { characterId: string; label: string; why: string }[];
}

/**
 * What the stitching needs of an attempt: its id, its level marks and the
 * active time it contributed. `ResultRun` has these and so does
 * `CharacterAttempt` (the run page's own view of a character), so one function draws
 * the field's twelve lines and the run page's one.
 */
export interface CharacterAttemptLike {
  runId: string;
  levels: readonly LevelMark[];
  playtimeMs: number | null;
}

/** The total active time an attempt contributes, or null when it recorded none. */
function attemptSpan(run: CharacterAttemptLike): number | null {
  if (run.playtimeMs !== null) return run.playtimeMs;
  // The run's own total is the right figure — it advances with a live run. A
  // run that never got one still contributes what its marks prove it played,
  // which is a lower bound and is documented as one at the call site.
  const marked = run.levels.map((l) => l.playtimeMs).filter((p): p is number => p !== null);
  return marked.length > 0 ? Math.max(...marked) : null;
}

/** One character's stitched line, or the reason it cannot be drawn. */
export interface StitchedCharacter {
  points: CharacterPoint[];
  /** Where the line stops: the character's total active time. */
  endX: number;
  /**
   * Why the character is not drawable, or null. A prior attempt with no
   * active-time reading is the one case that cannot be stitched: its
   * successors' offsets would be short by an unknown amount, and folding the
   * null to zero would silently compress the axis. The LAST attempt is
   * different — with no span the line simply ends at its last mark.
   */
  broke: string | null;
}

/**
 * Lay a character's attempts end to end on one cumulative-active-time axis.
 *
 * The step rule and the seam rule are `CharacterPoint`'s: a mark at or below the
 * level already drawn is not a gain (attempt k opens holding what k-1 ended
 * with), and a mark above it is a ding that happened in the unobserved gap and
 * draws its step at the seam.
 */
export function stitchCharacter(attempts: readonly CharacterAttemptLike[]): StitchedCharacter {
  const points: CharacterPoint[] = [];
  let offset = 0;
  let endX = 0;
  let highest = 0;
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
        return { points, endX, broke: `attempt ${i + 1} of ${attempts.length} recorded no active time` };
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
  return { points, endX, broke: null };
}

/**
 * Build one series per character from the same rows and runs the table shows.
 *
 * `rows` supplies the lineage (`characterRows` already resolved it, including the
 * malformed cases) and `runs` is the set those ids index into, so the chart and
 * the table can never disagree about which runs are on screen.
 *
 * The stitching itself is `stitchCharacter`, shared with the run page's own
 * single-character chart; a character it cannot lay out is omitted here with the
 * reason it gave, rather than drawn wrong.
 */
/**
 * What a freeplay line is called: the model, and its effort where it has one.
 *
 * `sonnet`, `sonnet (medium)`, `claude-fable-5 (high)` — `pointKey` over
 * `modelDisplay`, which is exactly the scatter's own entry key, so the two
 * charts on this page name the same thing the same way. The character's name
 * is not in it: the question a reader brings to the
 * freeplay chart is which model is which line.
 */
export function characterSeriesLabel(model: string, effort: string | null): string {
  return pointKey(modelDisplay(model), effort);
}

export function characterSeries(rows: readonly CharacterRow[], runs: readonly ResultRun[]): CharacterChartModel {
  const byId = new Map(runs.map((r) => [r.runId, r]));
  const series: CharacterSeries[] = [];
  const omitted: { characterId: string; label: string; why: string }[] = [];
  /** When each character's latest attempt started — the label's disambiguator. */
  const startedOf = new Map(rows.map((r) => [r.characterId, r.startedAt]));

  for (const row of rows) {
    const label = characterSeriesLabel(row.model, row.effort);
    const attempts = row.chain.map((id) => byId.get(id)).filter((r): r is ResultRun => r !== undefined);
    if (attempts.length === 0) {
      omitted.push({ characterId: row.characterId, label, why: "no attempt served" });
      continue;
    }
    const { points, endX, broke } = stitchCharacter(attempts);
    if (broke !== null) {
      omitted.push({ characterId: row.characterId, label, why: broke });
      continue;
    }
    if (points.length === 0) {
      // Two different nothings: a character too young to have been sampled at a
      // level at all, and one whose marks carry no active time to place them on.
      const why = attempts.every((r) => r.levels.length === 0)
        ? "no level recorded yet"
        : "no level mark carries an active-time reading";
      omitted.push({ characterId: row.characterId, label, why });
      continue;
    }
    const root = attempts[0]!;
    series.push({
      characterId: row.characterId,
      label,
      character: row.character,
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
       * null` would mark every character in the fleet as missing history — the
       * same "an older viewer must still work" rule `ResultRun.xpEarned` states.
       */
      truncated: typeof root.continuedFrom === "string" && !byId.has(root.continuedFrom),
    });
  }
  /*
   * A label is not unique either. Freeplay is one character per model and
   * effort, so two lines sharing a label are the same entry's older, archived
   * characters — and three `sonnet (low)` lines all labelled `sonnet (low)`
   * name nothing. Where the label repeats, and only there, the character's
   * start date joins it — ISO, because a pure module has no business picking a
   * locale. (This was the character-name rule before the label replaced it;
   * the reason it exists is unchanged, only what it disambiguates.)
   */
  const seen = new Map<string, number>();
  for (const s of series) seen.set(s.label, (seen.get(s.label) ?? 0) + 1);
  for (const s of series) {
    if ((seen.get(s.label) ?? 0) < 2) continue;
    const started = startedOf.get(s.characterId) ?? null;
    if (started !== null) s.label = `${s.label} ${new Date(started).toISOString().slice(0, 10)}`;
  }
  // Furthest first, so the eye meets the leaders and the legend order matches
  // the table's. Ties fall back to the character id, so the order is total.
  series.sort((a, b) => b.endLevel - a.endLevel || b.endX - a.endX || a.characterId.localeCompare(b.characterId));
  omitted.sort((a, b) => a.label.localeCompare(b.label) || a.characterId.localeCompare(b.characterId));
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

/*
 * The end-of-line furniture, left to right: the status marker at `endCx`, the
 * model's badge (a puck of `MARK_R`), then the character label. The offsets
 * live here rather than in the component because the label's leader has to
 * know where the label starts, and the layout is what emits the leader.
 */
/** Marker → badge, and badge → label. */
export const CHARACTER_ICON_GAP = 8;
export const CHARACTER_LABEL_GAP = 4;
export const characterIconCx = (endCx: number): number => endCx + CHARACTER_ICON_GAP + MARK_R;
export const characterLabelX = (endCx: number): number => endCx + CHARACTER_ICON_GAP + MARK_R * 2 + CHARACTER_LABEL_GAP;

export interface PlacedCharacter {
  series: CharacterSeries;
  /** The step path, in viewBox units, ending flat at the character's own `endX`. */
  d: string;
  endCx: number;
  endCy: number;
  /** The label's start and baseline. `labelX` is `characterLabelX(endCx)`, carried so the drawing and the leader agree. */
  labelX: number;
  labelY: number;
  /** From the badge to the label, when the label was pushed more than one row off its line. */
  leader: Leader | null;
}

export interface CharacterChartLayout {
  xTicks: number[];
  yTicks: number[];
  xMax: number;
  yMax: number;
  placed: PlacedCharacter[];
  /** The reading-direction cue: more level for less playtime is top-left, and a label never prints over it. */
  cue: ChartCue;
  px: (x: number) => number;
  py: (y: number) => number;
}

/**
 * Place the series in a plot box: the step paths, and the end labels nudged
 * apart so two characters holding the same level do not print on top of each other.
 *
 * The y axis runs from zero rather than from the lowest level drawn. A level
 * axis with a floating base would make a character that gained two levels look
 * like the whole chart, and level 1 is a real origin — it is where every
 * character starts.
 *
 * The series are re-sorted here by the order `characterSeries` already gives them
 * — furthest first, then longest, then label, then character id — so the stack is
 * a function of the set and not of the array's order, the same rule
 * `ladderChartLayout` follows.
 */
export function characterChartLayout(series: readonly CharacterSeries[], box: ChartBox, better: Better = DEFAULT_BETTER): CharacterChartLayout {
  const xMax = Math.max(1, ...series.map((s) => s.endX));
  const yTicks = niceTicks(Math.max(1, ...series.map((s) => s.endLevel)));
  const yMax = yTicks[yTicks.length - 1]!;
  const px = scaleLinear([0, xMax], [box.x0, box.x1]);
  const py = scaleLinear([0, yMax], [box.y0, box.y1]);

  const ordered = [...series].sort(
    (a, b) => b.endLevel - a.endLevel || b.endX - a.endX || a.label.localeCompare(b.label) || a.characterId.localeCompare(b.characterId),
  );
  // The cue gives way to the badges, as it does to the scatter's pucks; then
  // it is in every label's way. A label reaches the corner only when a character
  // at the top level has next to no playtime, but the placer does not get to
  // assume that.
  const cue = chartCue(box, better, ordered.map((s) => puckRect(characterIconCx(px(s.endX)), py(s.endLevel))));
  const placed: PlacedCharacter[] = [];
  const takenY: number[] = [];
  for (const s of ordered) {
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
    // The label sits at the end of the line, its cap height centred on it, and
    // is pushed down in whole label rows until it clears every label already
    // placed. Down, not up: the series are placed furthest-first, so the
    // leader keeps its natural position.
    const natural = endCy + CAP_H / 2;
    let labelY = natural;
    // …but never off the bottom of the plot. Once the field is crowded enough
    // that pushing down would take the descenders past the axis, the label
    // stays where it is and overlaps rather than walking out of the viewBox,
    // which is the same call `ladderChartLayout`'s `inside()` guard makes.
    const labelX = characterLabelX(endCx);
    // The label's box at a candidate baseline, generously: the name plus the
    // "…" and " ×N" it may carry, which is a bound and not a measure.
    const labelRect = (y: number): Rect => ({ l: labelX, t: y - LABEL_H, r: labelX + (s.label.length + 4) * CHAR_W, b: y + LABEL_DESC });
    const collides = (y: number): boolean =>
      takenY.some((t) => Math.abs(t - y) < LABEL_ROW) || rectsOverlap(labelRect(y), cue.rect);
    while (collides(labelY) && labelY + LABEL_ROW + LABEL_DESC <= box.y0) labelY += LABEL_ROW;
    takenY.push(labelY);
    // One row down still reads as the line's own label; two or more needs the
    // line drawn, from the badge's edge to the label's leading mid-height.
    const leader: Leader | null =
      labelY - natural > LABEL_ROW
        ? { x1: characterIconCx(endCx) + MARK_R + 1, y1: endCy, x2: labelX - 1.5, y2: labelY - CAP_H / 2 }
        : null;
    placed.push({ series: s, d: steps.join(" "), endCx, endCy, labelX, labelY, leader });
  }
  return { xTicks: timeTicks(xMax), yTicks, xMax, yMax, placed, cue, px, py };
}
