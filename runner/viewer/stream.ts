/**
 * A freeplay stream, aggregated at read time.
 *
 * The complaint this answers: a stream's figures are not recorded across the
 * whole run. Every counter the runner keeps is per *attempt* — `questsCompleted`
 * is the session's own `completions.length`, the tokens and the cost are that
 * attempt's trajectory, the playtime is that attempt's active segments — so a
 * character on its twelfth continuation reported the twelfth session's numbers
 * and nothing of the eleven behind it.
 *
 * The fix is here and not in the runner. What the runner writes is the
 * model-visible surface and a methodology matter; an old run is read
 * differently, not relabelled (docs/METHODOLOGY.md). So the attempts stay as
 * they were recorded and the reader sums them, which also means a stream whose
 * oldest attempts predate a column reports what the attempts that have it
 * prove, and says how many that was.
 *
 * Two rules run through every total below:
 *
 * - **Null is not zero.** A sum over attempts where none recorded a kind is
 *   null; where some did, those are summed and the rest contribute nothing.
 *   The same discipline `AreaFacts` and `TaxiFacts` are emphatic about, applied
 *   one level up.
 * - **A tally is summed; a state is taken from the furthest attempt.** Quests,
 *   xp, playtime, tokens, deaths and flights happened and add up. Level, money
 *   and achievements are what the character HOLDS — the achievement tap reports
 *   the whole backlog, so the latest attempt that recorded any is already the
 *   stream's answer and summing it would count every achievement twice.
 *
 * The chain itself is `lineage.ts`, shared with the ladder and the runs table.
 * `runs` here is the **forward** stream — the deepest chain under the root, the
 * same one `streamRows` collapses to a row — not the ancestors-and-self walk:
 * a reader on attempt 11 wants to see 12, which is the whole point.
 */

import { chainsOf, hasLineage, lineageIndex } from "./lineage";
import type {
  AchievementFacts,
  CostFigure,
  DeathFacts,
  ResultRun,
  SpellFacts,
  StreamAttempt,
  StreamCost,
  StreamTotals,
  StreamView,
  TalentFacts,
  TaxiFacts,
  TokenTotals,
  TradeFacts,
} from "./api-types";

/** Sum the attempts that answered; null when none did. */
function sum(values: readonly (number | null | undefined)[]): number | null {
  let total = 0;
  let any = false;
  for (const v of values) {
    if (typeof v !== "number") continue;
    total += v;
    any = true;
  }
  return any ? total : null;
}

/** The furthest attempt that recorded a value — the character's standing now. */
function latest<T>(values: readonly (T | null | undefined)[]): T | null {
  for (let i = values.length - 1; i >= 0; i--) {
    const v = values[i];
    if (v !== null && v !== undefined) return v;
  }
  return null;
}

/**
 * The stream's token totals.
 *
 * `contextTokens` is the size of a prompt, not a tally, so it is the last
 * attempt's reading rather than a sum of context windows that never coexisted.
 * The `source` degrades to the weakest any attempt reported: a stream holding
 * one snapshot-sourced attempt is under-read as a whole, and labelling it
 * `reported` because the other eleven were would hide exactly the caveat the
 * label exists to carry.
 */
function mergeTokens(attempts: readonly (TokenTotals | null)[]): TokenTotals | null {
  const held = attempts.filter((t): t is TokenTotals => t !== null);
  if (held.length === 0) return null;
  const source: TokenTotals["source"] = held.some((t) => t.source === "snapshot")
    ? "snapshot"
    : held.some((t) => t.source === "estimated")
      ? "estimated"
      : "reported";
  return {
    source,
    contextTokens: held[held.length - 1]!.contextTokens,
    promptTokens: sum(held.map((t) => t.promptTokens)) ?? 0,
    completionTokens: sum(held.map((t) => t.completionTokens)) ?? 0,
    totalTokens: sum(held.map((t) => t.totalTokens)) ?? 0,
    cacheReadTokens: sum(held.map((t) => t.cacheReadTokens)),
    cacheWriteTokens: sum(held.map((t) => t.cacheWriteTokens)),
    turns: sum(held.map((t) => t.turns)) ?? 0,
  };
}

/** A cost figure counts toward a sum only when it actually carries a number. */
function costUsd(c: CostFigure | null | undefined): number | null {
  if (c === null || c === undefined) return null;
  return c.basis === "none" ? null : c.usd;
}

function mergeCost(runs: readonly ResultRun[]): StreamCost {
  const actual = runs.map((r) => costUsd(r.actualCost));
  const expected = runs.map((r) => costUsd(r.expectedCost));
  return {
    actualUsd: sum(actual),
    actualAttempts: actual.filter((v) => v !== null).length,
    expectedUsd: sum(expected),
    expectedAttempts: expected.filter((v) => v !== null).length,
    attempts: runs.length,
    asIfMetered: runs.some((r, i) => actual[i] !== null && r.actualCost?.asIfMetered === true),
  };
}

/** Concatenate the marks of every attempt that recorded any, in attempt order. */
function concat<T>(lists: readonly (readonly T[] | undefined)[]): T[] {
  const out: T[] = [];
  for (const l of lists) if (l !== undefined) out.push(...l);
  return out;
}

function mergeDeaths(runs: readonly ResultRun[]): DeathFacts | null {
  const held = runs.map((r) => r.deaths ?? null).filter((d): d is DeathFacts => d !== null);
  if (held.length === 0) return null;
  const sites = concat(held.map((d) => d.sites));
  return {
    deaths: held.reduce((n, d) => n + d.deaths, 0),
    releases: held.reduce((n, d) => n + d.releases, 0),
    resurrects: held.reduce((n, d) => n + d.resurrects, 0),
    first: held.map((d) => d.first).find((s) => s !== null) ?? null,
    last: latest(held.map((d) => d.last)),
    sites,
  };
}

function mergeTaxi(runs: readonly ResultRun[]): TaxiFacts | null {
  const held = runs.map((r) => r.taxi ?? null).filter((t): t is TaxiFacts => t !== null);
  return held.length === 0 ? null : { flights: held.reduce((n, t) => n + t.flights, 0) };
}

function mergeSpells(runs: readonly ResultRun[]): SpellFacts | null {
  const held = runs.map((r) => r.spells ?? null).filter((s): s is SpellFacts => s !== null);
  if (held.length === 0) return null;
  return {
    // `learned` is a tally — ids that entered the book after that attempt's
    // login baseline — so it adds up. `atLogin` is a baseline and does not: the
    // second attempt logged in holding everything the first one learned, and
    // summing them would count the whole book once per continuation. The
    // stream's baseline is its OLDEST served attempt's, which is the book the
    // character carried into the history on screen.
    learned: held.reduce((n, s) => n + s.learned, 0),
    atLogin: held[0]!.atLogin,
    ids: [...new Set(concat(held.map((s) => s.ids)))].sort((a, b) => a - b),
    marks: concat(held.map((s) => s.marks)),
  };
}

function mergeTalents(runs: readonly ResultRun[]): TalentFacts | null {
  const held = runs.map((r) => r.talents ?? null).filter((t): t is TalentFacts => t !== null);
  if (held.length === 0) return null;
  const marks = concat(held.map((t) => t.marks));
  return {
    // `spends` counts records and adds up; `talents` is "distinct talents any
    // of those spends touched", so it is the distinct ids of the merged marks —
    // a talent taken to rank 3 across two attempts is one talent, not two.
    spends: held.reduce((n, t) => n + t.spends, 0),
    talents: new Set(marks.map((m) => m.id)).size,
    marks,
  };
}

function mergeTrades(runs: readonly ResultRun[]): TradeFacts | null {
  const held = runs.map((r) => r.trades ?? null).filter((t): t is TradeFacts => t !== null);
  if (held.length === 0) return null;
  const marks = concat(held.map((t) => t.marks));
  return {
    trades: held.reduce((n, t) => n + t.trades, 0),
    first: held.map((t) => t.first).find((m) => m !== null) ?? null,
    last: latest(held.map((t) => t.last)),
    marks,
  };
}

/**
 * The achievements the character holds.
 *
 * Not a sum: the tap reports the whole backlog a character has, so the latest
 * attempt that recorded any already speaks for the stream, and adding the
 * attempts would count every achievement once per continuation.
 */
function streamAchievements(runs: readonly ResultRun[]): AchievementFacts | null {
  return latest(runs.map((r) => r.achievements ?? null));
}

function attemptOf(r: ResultRun): StreamAttempt {
  return {
    runId: r.runId,
    startedAt: r.startedAt,
    endedAt: r.endedAt ?? null,
    terminationReason: r.terminationReason,
    pauseReason: r.pauseReason ?? null,
    // Optional on `ResultRun` (an older viewer omits both); absent reads as
    // "not live" and "no end recorded", which is what a row that cannot say
    // means here.
    live: r.live === true,
    level: r.maxLevel,
    xpEarned: r.xpEarned ?? null,
    questsCompleted: r.questsCompleted,
    playtimeMs: r.playtimeMs,
    tokens: r.tokens,
    actualCost: r.actualCost,
    expectedCost: r.expectedCost ?? null,
    deaths: r.deaths?.deaths ?? null,
    flights: r.taxi?.flights ?? null,
    levels: r.levels,
  };
}

function totalsOf(runs: readonly ResultRun[]): StreamTotals {
  const last = runs[runs.length - 1];
  return {
    attempts: runs.length,
    startedAt: runs.map((r) => r.startedAt).find((t) => t !== null) ?? null,
    // The last attempt's end, and nothing while it is still going: a stream
    // whose newest attempt is live has not ended, whatever the older ones say.
    endedAt: last === undefined || last.live === true ? null : (last.endedAt ?? null),
    playtimeMs: sum(runs.map((r) => r.playtimeMs)),
    questsCompleted: sum(runs.map((r) => r.questsCompleted)),
    xpEarned: sum(runs.map((r) => r.xpEarned)),
    tokens: mergeTokens(runs.map((r) => r.tokens)),
    cost: mergeCost(runs),
    // The character never de-levels, so the stream's level is the highest any
    // attempt observed — not the last one's, which can be a sample short.
    level: runs.reduce<number | null>(
      (best, r) => (r.maxLevel === null ? best : best === null ? r.maxLevel : Math.max(best, r.maxLevel)),
      null,
    ),
    money: latest(runs.map((r) => r.money)),
    achievements: streamAchievements(runs),
    deaths: mergeDeaths(runs),
    taxi: mergeTaxi(runs),
    spells: mergeSpells(runs),
    talents: mergeTalents(runs),
    trades: mergeTrades(runs),
    toolCalls: sum(runs.map((r) => r.toolCalls)),
    snippets: sum(runs.map((r) => r.snippets)),
    modelResponses: sum(runs.map((r) => r.modelResponses)),
  };
}

/**
 * The stream one run belongs to, or null when it belongs to none worth printing.
 *
 * `all` is the set the walk resolves against — every run the viewer serves, the
 * same rows `/api/results` builds — so a predecessor that is archived or gone
 * makes its successor a root rather than dropping it, and the stream says it
 * begins mid-history (`truncated`).
 *
 * The chain served is the deepest one under the run's root, which is the
 * forward view: attempt 11 lists 12. A fork (two launches claiming one
 * predecessor) resolves the way `streamRows` resolves it — the longer chain,
 * then the later start — and a run that ends up on the losing branch keeps its
 * own ancestors-and-self walk rather than being shown a stream it is not on.
 */
export function streamViewOf(runId: string, all: readonly ResultRun[]): StreamView | null {
  const lineage = lineageIndex(all).get(runId);
  if (!hasLineage(lineage)) return null;

  const kept = all.filter((r) => r.stillborn !== true);
  const byId = new Map(kept.map((r) => [r.runId, r]));
  const chains = chainsOf(kept);
  let chain = lineage.chain;
  let tip = byId.get(runId);
  for (const r of kept) {
    const c = chains.get(r.runId)!;
    if (c[0] !== lineage.streamId) continue;
    if (c.length > chain.length || (c.length === chain.length && (r.startedAt ?? 0) > (tip?.startedAt ?? 0))) {
      chain = c;
      tip = r;
    }
  }
  // A fork this run is not on: its own walk is the honest answer, not a chain
  // that does not contain it.
  if (!chain.includes(runId)) chain = lineage.chain;

  const runs = chain.map((id) => byId.get(id)).filter((r): r is ResultRun => r !== undefined);
  if (runs.length === 0) return null;
  const root = runs[0]!;
  return {
    streamId: lineage.streamId,
    attempt: chain.indexOf(runId) + 1,
    attempts: chain.length,
    previous: lineage.previous,
    next: lineage.next,
    /*
     * The `typeof` is not paranoia: a row served by a viewer that predates the
     * field has no `continuedFrom` at all, and `undefined !== null` would mark
     * every stream as missing history — the rule `streamSeries` states for the
     * same flag it draws.
     */
    truncated: typeof root.continuedFrom === "string" && !byId.has(root.continuedFrom),
    runs: runs.map(attemptOf),
    totals: totalsOf(runs),
  };
}
