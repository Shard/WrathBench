/**
 * The maths behind the results charts and the ladder. Pure, so what the release
 * page claims is testable without a browser or a server.
 *
 * The one rule this module exists to enforce: **a chart never mixes runs that
 * are not comparable.** Scorability comes from the server's own `unscored`
 * predicate, and everything below groups by (model, harness series) — ADR-0004
 * makes scores comparable only within a harness version, and ADR-0034 names
 * the *series* (major.minor) as that group: a fix commit does not start a new
 * row, a minor bump does. The exact versions a row holds are listed on it.
 */

import type { ResultRun, LevelMark } from "@viewer/api-types";

/** Levels the charts offer. Chosen to line up with the ladder's rungs. */
export const CHART_LEVELS = [5, 10, 20, 40, 60, 80] as const;

export function scored(runs: readonly ResultRun[]): ResultRun[] {
  return runs.filter((r) => r.unscored === null);
}

/* --------------------------------------------------------------- character */

/**
 * The starting characters present, as chip labels: "Dwarf Hunter", sorted.
 *
 * Race and class vary only as a *pair* — the extras cycle (ADR-0034) hands out
 * `{ race, class }` combinations from a fixed list — so one chip row of pairs
 * is the filter, not two rows that would offer combinations no run can have.
 * Runs whose metadata never recorded a character contribute no option; they
 * are kept by "all" and dropped by any specific chip, which is what "not
 * recorded" has to mean if it is not to be guessed at.
 */
export function characterOptions(runs: readonly ResultRun[]): string[] {
  return [...new Set(runs.map((r) => r.characterLabel).filter((l): l is string => l !== null))].sort();
}

/** Narrow to one character label. Null (the default) keeps every run. */
export function byCharacter(runs: readonly ResultRun[], label: string | null): ResultRun[] {
  if (label === null) return [...runs];
  return runs.filter((r) => r.characterLabel === label);
}

/** The distinct characters in a set of runs, sorted — a row's label. */
function charactersOf(runs: readonly ResultRun[]): string[] {
  return [...new Set(runs.map((r) => r.characterLabel).filter((l): l is string => l !== null))].sort();
}

/** The first mark at or above `level`, or null when the run never got there. */
export function markAtLeast(run: ResultRun, level: number): LevelMark | null {
  for (const m of run.levels) if (m.level >= level) return m;
  return null;
}

export interface Reach {
  runId: string;
  /** Turn at first observation of the level. Null when the run recorded none. */
  turn: number | null;
  /** Active time to that observation. Null when the run's segments are unknown. */
  ms: number | null;
}

/** One row of the charts: a model on a harness series, and what it managed. */
export interface ResultGroup {
  key: string;
  model: string;
  /**
   * The series the row is keyed on (`"0.3"`), or the exact version when the
   * run carried no recognisable series (it then groups alone, never guessed in).
   */
  harnessVersion: string;
  /** Every exact version stamp in the row, sorted — the label's detail. */
  harnessVersions: string[];
  effort: string | null;
  /** Whether wiki coordinates were served (ADR-0028); null when not recorded. */
  wikiCoords: boolean | null;
  /**
   * The starting characters the group's runs were played on, sorted. A *label*,
   * not part of the key: the baseline character is the comparison set, and an
   * extras run (ADR-0034) is compared against it rather than charted apart.
   * More than one entry means the group mixes characters, and the row says so.
   */
  characters: string[];
  /**
   * The harness tags present in the group (ADR-0035), sorted. Not part of the
   * key: the operator chose to tag rather than partition, so a group may hold
   * both loops and the column says so.
   */
  harnesses: string[];
  /** Runs in the group that reached the level, fastest first by turns. */
  reached: Reach[];
  /** How many runs of this group were considered at all. */
  attempts: number;
  bestTurn: number | null;
  bestMs: number | null;
  medianTurn: number | null;
  medianMs: number | null;
  /**
   * Median tool calls across the group's runs, whether or not they reached the
   * level. The episode ceiling is a runaway guard, not a task budget, and this
   * is the number it has to be sized against — a group whose median approaches
   * its tier's ceiling is being ended by the guard rather than by the clock.
   */
  medianToolCalls: number | null;
  /** The largest single run's tool calls, which is what a ceiling must clear. */
  maxToolCalls: number | null;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

/**
 * Group scored runs by (model, harness series, effort, server build) and
 * report what each group cost to reach `level`.
 *
 * Effort is part of the key rather than averaged over: ADR-0024 calls it a
 * dimension, so `opus at low` and `opus at high` are two rows, not one blurred
 * one. A group with no run that reached the level is still returned — "twelve
 * attempts, none reached L10" is a result, and dropping it would flatter the
 * chart. Server build folds in the same way (ADR-0026): the worldserver
 * commit is pinned and changed deliberately, same as the harness version, so
 * two runs on different builds are two rows, and a run with no recorded build
 * groups on its own rather than silently joining one it may not have run
 * against. The wiki-coordinates tier (ADR-0028) is a dimension the same way:
 * a names-first run and a coords run are not the same task, and a run that
 * never recorded the field groups on its own.
 */
export function groupsForLevel(runs: readonly ResultRun[], level: number): ResultGroup[] {
  const byKey = new Map<string, ResultGroup>();
  /** Per-group tool-call counts, kept aside so the group stays a plain shape. */
  const calls = new Map<string, number[]>();
  for (const run of scored(runs)) {
    const model = run.model ?? "(unnamed)";
    const harness = run.harnessSeries ?? run.harnessVersion ?? "(unversioned)";
    const coordsKey = run.wikiCoords === null ? "coords?" : run.wikiCoords ? "coords" : "names";
    const key = `${model} ${harness} ${run.effort ?? ""} ${run.serverBuild ?? ""} ${coordsKey}`;
    let g = byKey.get(key);
    if (g === undefined) {
      g = {
        key,
        model,
        harnessVersion: harness,
        harnessVersions: [],
        effort: run.effort,
        wikiCoords: run.wikiCoords,
        characters: [],
        harnesses: [],
        reached: [],
        attempts: 0,
        bestTurn: null,
        bestMs: null,
        medianTurn: null,
        medianMs: null,
        medianToolCalls: null,
        maxToolCalls: null,
      };
      byKey.set(key, g);
      calls.set(key, []);
    }
    g.attempts += 1;
    const exact = run.harnessVersion ?? "(unversioned)";
    if (!g.harnessVersions.includes(exact)) g.harnessVersions.push(exact);
    const tag = run.harness ?? "harness?";
    if (!g.harnesses.includes(tag)) g.harnesses.push(tag);
    if (run.characterLabel !== null && !g.characters.includes(run.characterLabel)) {
      g.characters.push(run.characterLabel);
    }
    if (run.toolCalls !== null) calls.get(g.key)!.push(run.toolCalls);
    const mark = markAtLeast(run, level);
    if (mark !== null) g.reached.push({ runId: run.runId, turn: mark.turn, ms: mark.playtimeMs });
  }
  const out = [...byKey.values()];
  for (const g of out) {
    g.harnesses.sort();
    g.characters.sort();
    g.harnessVersions.sort();
    g.reached.sort((a, b) => (a.turn ?? Infinity) - (b.turn ?? Infinity));
    const turns = g.reached.map((r) => r.turn).filter((v): v is number => v !== null);
    const times = g.reached.map((r) => r.ms).filter((v): v is number => v !== null);
    g.bestTurn = turns.length > 0 ? Math.min(...turns) : null;
    g.bestMs = times.length > 0 ? Math.min(...times) : null;
    g.medianTurn = median(turns);
    g.medianMs = median(times);
    const used = calls.get(g.key) ?? [];
    g.medianToolCalls = median(used);
    g.maxToolCalls = used.length > 0 ? Math.max(...used) : null;
  }
  // Groups that got there first lead; groups that never did sort to the bottom
  // in attempt order, so a model with many failed attempts is still visible.
  out.sort(
    (a, b) =>
      (a.bestTurn ?? Infinity) - (b.bestTurn ?? Infinity) ||
      (a.bestMs ?? Infinity) - (b.bestMs ?? Infinity) ||
      b.attempts - a.attempts ||
      a.model.localeCompare(b.model),
  );
  return out;
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
 * Rungs 2, 4 and 6 are not derivable: zone and area changes, flight paths and
 * group joins are none of them recorded (FOLLOW-UPS 35 is the milestone-record
 * work that would make 2 and 4 answerable). They read "not instrumented" rather
 * than being approximated by a level threshold that would quietly invent a
 * result.
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
    rule: "needs zone/area change records (FOLLOW-UPS 35); map id alone cannot tell subzones apart",
    test: null,
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
    rule: "needs zone entry and taxi records (FOLLOW-UPS 35)",
    test: null,
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
 * "Highest derivable": rungs 2, 4 and 6 can never be reached here, so a model
 * sitting at rung 3 is not claimed to have passed rung 2 — the page shows the
 * whole row and lets the gaps speak.
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
