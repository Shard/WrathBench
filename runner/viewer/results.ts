/**
 * The results derivations: what the charts and the ladder read.
 *
 * Everything here is a pure function of a run's state samples plus its active
 * segments, so the two questions the release-point dashboard asks — how many
 * turns did a level cost, and how much active time — are answerable without a
 * chart library and testable without a database.
 *
 * Two honesty rules are baked in and repeated in the wire types:
 *
 * - **First observation, not first reach.** Samples are taken on
 *   `stateIntervalMs` (60s), not once per turn, so a level's turn and time are
 *   those of the first sample that showed it.
 * - **Active time, not wall clock.** A run that sat `quota-exhausted` for two
 *   hours is not charged for them; the same `ActiveSegment[]` the run page's
 *   playtime comes from is what is integrated here, so the two agree.
 */

import { runBilling } from "../src/billing";
import { harnessSeries } from "../src/comparability";
import { STUB_STAMP, isDriver, isUnscoredDriver } from "../src/config";
import { badEvidenceReason } from "../src/lapse";
import { stillbornOf } from "../src/models";
import { EPISODES } from "../src/episodes";
import type {
  AchievementFacts,
  AreaFacts,
  DeathFacts,
  LevelUpFacts,
  CostFigure,
  EpisodeIdView,
  LevelMark,
  ResultRun,
  RunRow,
  SpellFacts,
  StatePoint,
  TalentFacts,
  TaxiFacts,
  TokenTotals,
  StateItemsRow,
  TrackPoint,
  TradeFacts,
} from "./api-types";
import { itemSamplesOf } from "./runs";
import type { ActiveSegment } from "./tail";

/**
 * Active time from the run's start up to `ts`.
 *
 * `playtimeMs` answers "how much in total"; this answers "how much by then",
 * which is the one a level mark needs. A segment that has not closed is charged
 * only up to the cursor, and a segment that opened after it contributes
 * nothing.
 */
export function activeMsUntil(segments: readonly ActiveSegment[], ts: number): number | null {
  if (segments.length === 0) return null;
  let total = 0;
  for (const seg of segments) {
    if (seg.start > ts) continue;
    const end = Math.min(seg.end ?? ts, ts);
    total += Math.max(0, end - seg.start);
  }
  return total;
}

/**
 * Whether a run's recorded turn indices can be read as one series.
 *
 * A run resumed by a build that predates the cumulative turn offset restarts
 * its counter, so its samples descend somewhere in the middle. Charting that
 * would credit the resumed run with the handful of turns since its last pause —
 * flattering exactly the runs that had the most trouble. A run whose series
 * ever goes backwards has no usable turn index at all, which is what the charts
 * are told rather than being handed a plausible number.
 */
export function turnsUsable(states: readonly StatePoint[]): boolean {
  let last = 0;
  for (const s of states) {
    if (s.turn === null) continue;
    if (s.turn < last) return false;
    last = s.turn;
  }
  return true;
}

/**
 * The first sample that showed each level, in ascending order.
 *
 * Levels are taken as they first appear, not as a max: a character never
 * de-levels, but a sample can carry no level at all (unobserved), and a rebuilt
 * state cache can briefly report an older reading. Taking each level's earliest
 * sighting and dropping anything at or below a level already marked is what
 * keeps the series monotone without inventing a value.
 */
export function levelMarks(
  states: readonly StatePoint[],
  segments: readonly ActiveSegment[] = [],
): LevelMark[] {
  const out: LevelMark[] = [];
  const turns = turnsUsable(states);
  let highest = 0;
  for (const s of states) {
    const level = s.level;
    if (level === null || level <= 0 || level <= highest) continue;
    highest = level;
    out.push({
      level,
      ts: s.ts,
      turn: turns ? s.turn : null,
      playtimeMs: activeMsUntil(segments, s.ts),
    });
  }
  return out;
}

/** Every map the run was observed on, ascending. Ladder rungs 7–8 read these. */
export function mapsOf(states: readonly StatePoint[]): number[] {
  const seen = new Set<number>();
  for (const s of states) if (s.map !== null) seen.add(s.map);
  return [...seen].sort((a, b) => a - b);
}

/**
 * A run's recorded track, for map replay (item 22).
 *
 * Only samples that actually carried a position: a sample may record level and
 * xp with no coordinates, and interpolating through it would draw a line the
 * character never walked.
 */
export function trackFrom(
  states: readonly StatePoint[],
  itemRows: readonly StateItemsRow[] = [],
): TrackPoint[] {
  const out: TrackPoint[] = [];
  /*
   * The inventory is on its own rows because it is read by its own query, and
   * it is published on change rather than on every point: the whole inventory
   * per sample would be most of the response and nearly all of it repetition.
   *
   * The join is "newest reading at or before this point", which also covers the
   * sample that changed the inventory without carrying a position — the change
   * surfaces on the next point that has one, instead of being dropped with the
   * sample. The comparison is on the stored text, so a sample that re-stated
   * the same inventory is not a change.
   */
  let at = 0;
  let pending: string | null = null;
  let published: string | null = null;
  for (const s of states) {
    while (at < itemRows.length && itemRows[at]!.ts <= s.ts) pending = itemRows[at++]!.items;
    if (s.map === null || s.x === null || s.y === null) continue;
    const changed = pending !== null && pending !== published;
    if (changed) published = pending;
    out.push({
      ts: s.ts,
      map: s.map,
      x: s.x,
      y: s.y,
      level: s.level,
      xp: s.xp,
      money: null,
      questsCompleted: null,
      turn: s.turn,
      // Unlike money and quests above, the frame's numbers are carried: replay
      // draws the same unit frame the live map does, and they are on the row.
      health: s.health ?? null,
      maxHealth: s.maxHealth ?? null,
      power: s.power ?? null,
      maxPower: s.maxPower ?? null,
      powerType: s.powerType ?? null,
      nextLevelXp: s.nextLevelXp ?? null,
      ...(changed ? { items: itemSamplesOf(pending!) ?? [] } : {}),
    });
  }
  return out;
}

/**
 * The highest XP reading observed *at* a given level.
 *
 * XP resets to zero at every ding, so a run's xp only means something paired
 * with the level it was read at. Taking the maximum at the run's highest
 * observed level is the furthest the character got into that level, which is
 * what the ladder's second ordering compares. Null when
 * no sample carried xp at that level — never 0, which is a real reading.
 */
export function xpAtLevel(states: readonly StatePoint[], level: number): number | null {
  let best: number | null = null;
  for (const s of states) {
    if (s.level !== level || s.xp === null) continue;
    if (best === null || s.xp > best) best = s.xp;
  }
  return best;
}

/**
 * XP earned over a run, as a lower bound (`ResultRun.xpEarned`).
 *
 * The within-level xp resets at every ding, so the total carried into a level
 * is reconstructed as the sum of the *last observed* xp of every level below
 * it — the same rule the run page's cumulative chart applies
 * (`dashboard/src/lib/runview.ts`), so the two never disagree. Samples are
 * sorted by time and read only where level and xp ride on the same sample;
 * the running total is clamped monotonic. Null when no sample qualifies.
 */
export function xpEarned(states: readonly StatePoint[]): number | null {
  const samples = states
    .filter((s): s is StatePoint & { level: number; xp: number } => s.level !== null && s.level > 0 && s.xp !== null)
    .sort((a, b) => a.ts - b.ts);
  if (samples.length === 0) return null;
  let base = 0;
  let prevLevel: number | null = null;
  let lastXp = 0;
  let cum = 0;
  for (const s of samples) {
    if (prevLevel !== null && s.level > prevLevel) {
      base += lastXp;
      lastXp = 0;
    }
    prevLevel = s.level;
    lastXp = s.xp;
    cum = Math.max(cum, base + s.xp);
  }
  return cum;
}

/**
 * Whether a run is a *member* of its episode tier's comparability group.
 *
 * Membership is stamped and un-overridden, and nothing else. Per the episode
 * policy, a run
 * that predates the tiers "reads `episode: null` and is never back-labeled",
 * because it ran under the watchdog defaults of its day; a run whose leash was
 * overridden is likewise not what the id describes. Both still carry the label
 * — that is what makes them countable and findable — and neither is a member.
 */
export function isTierMember(run: ResultRun): boolean {
  return run.episode !== null && run.episodeSource === "stamped" && !run.episodeOverride;
}

/** How a run came by its episode tier, and whether that tier is intact. */
export interface EpisodeOf {
  episode: EpisodeIdView | null;
  source: "stamped" | "derived" | "none";
  /** True only for a *stamped* tier whose watchdogs were overridden. */
  override: boolean;
}

/** The wall clock that identifies an e90 run written before the tier existed. */
const E90_MS = 90 * 60_000;

/**
 * The episode tier of a run — read from the stamp, or derived when there is none.
 *
 * Derivation happens **in the reader** and nothing is written back (the tuple
 * is stamped, never recomputed). Two rules, both narrow on purpose:
 *
 * - a run naming a campaign is a probe; a steered run naming none is
 *   freeplay;
 * - a run whose stamped budget is exactly ninety minutes, with no objective, is
 *   the tier the whole fleet has been running since before it had a name.
 *
 * Anything else is `null` rather than a guess. A run with no tuple at all
 * cannot be derived into `e90`, because its budget was never recorded and
 * inferring one from today's defaults would assert a comparability that was
 * never established.
 */
export function episodeOf(run: RunRow): EpisodeOf {
  const stamped = run.comparability?.episode;
  if (stamped !== undefined && stamped !== null) {
    return { episode: stamped, source: "stamped", override: run.comparability?.episodeOverride === true };
  }
  // A campaign says which steered id this is; without one, a steered run is
  // freeplay. Probe runs are always launched stamped, so this branch is for a
  // run whose tuple went missing rather than the normal path — but deriving it
  // to `freeplay` would file a commissioned run in the sandbox.
  if (run.campaign !== null) return { episode: "probing", source: "derived", override: false };
  if (run.objective !== null) return { episode: "freeplay", source: "derived", override: false };
  if (run.comparability?.budget.episodeMs === E90_MS) {
    return { episode: "e90", source: "derived", override: false };
  }
  return { episode: null, source: "none", override: false };
}

/**
 * Why a run cannot enter a scored comparison, or null when it can.
 *
 * One predicate, so the charts and the ladder cannot disagree about what counts.
 * The reasons are the ones recorded: a stub run stamps unscored, and an
 * operator objective stamps unscored. The driver check is separate
 * from the stamp so a stub run launched before the stamp existed still reads
 * as one. The harness is deliberately *not* a reason (it is a tag, not a partition): a
 * `claude-code` run is a tagged row.
 *
 * The live results projection passes the response count explicitly. A direct
 * metadata-only caller may omit it, in which case response-based taint cannot
 * be inferred, but active/paused and recorded non-model terminations still can.
 */
export function unscoredReason(run: RunRow, modelResponses?: number | null): string | null {
  if (run.shakeout !== null) return run.shakeout;
  if (run.driver !== null && isDriver(run.driver) && isUnscoredDriver(run.driver)) return STUB_STAMP;
  if (run.objective !== null) return "unscored (operator objective)";
  /*
   * The tier decides too: `freeplay` is unscored by definition, whether it was
   * stamped or derived from the objective the run carried.
   *
   * An *overridden* tier run is deliberately NOT unscored here. It was given a
   * leash its tier does not describe, so it is not a member of that tier's
   * group — but that is a membership question, answered by the episode filter
   * on `/api/results` (and reversible with `?includeOverrides=1`). Folding it into
   * this predicate would make the exclusion permanent and unshowable.
   */
  const ep = episodeOf(run);
  if (ep.episode !== null && !EPISODES[ep.episode].scored) {
    return `unscored (episode ${ep.episode})`;
  }
  const taint = badEvidenceReason({
    live: run.live,
    paused: run.pauseReason !== null,
    modelResponses,
    terminationReason: run.terminationReason,
  });
  if (taint !== null) return `unscored (${taint})`;
  return null;
}

/** Project one run down to what the results surface reads. */
export function resultRunOf(
  run: RunRow,
  states: readonly StatePoint[],
  segments: readonly ActiveSegment[],
  /** Counted off the trajectory; omitted when it could not be read. */
  calls: { toolCalls: number; snippets: number; modelResponses: number } | null = null,
  /**
   * The listing facts the episodes page shows per run. Passed in rather than
   * derived here: the caller already holds the memoised trajectory totals, and
   * the cost must be the same `runCost` the fleet listing and the run page
   * quote or the pages would disagree about dollars. `actualCost` is
   * `CostView.actual` — never the expected figure (see `ResultRun`).
   */
  listing: {
    playtimeMs: number | null;
    tokens: TokenTotals | null;
    actualCost: CostFigure | null;
    /** `CostView.expected`; see `ResultRun.expectedCost`. Absent from older callers. */
    expectedCost?: CostFigure | null;
  } | null = null,
  /**
   * Where the run went, from `scanRunTotals`' pass over the zone/area
   * milestones. Its own parameter rather than a field of `listing` or `calls`:
   * it is neither a cost nor a call count, and `null` here means the run wrote
   * no milestone at all, which the ladder must be able to tell from `false`.
   */
  areas: AreaFacts | null = null,
  /**
   * Achievements and flights from the same pass. Their own
   * parameters for the same reason `areas` is one, and `null` in either means
   * the run recorded none of that kind — the ladder's rung 4 must be able to
   * tell that from "flew nowhere".
   */
  achievements: AchievementFacts | null = null,
  taxi: TaxiFacts | null = null,
  /**
   * The level timeline and the deaths from the same pass. Their own parameters
   * for the same reason `areas` is one, and `null` in either is "the run
   * recorded none of that kind" — which a reader must be able to tell from a
   * run that levelled once and never died.
   */
  leveling: LevelUpFacts | null = null,
  deaths: DeathFacts | null = null,
  /**
   * Spells learned, talent points spent and trades completed (item 35). One
   * parameter rather than three because the positional list is already long,
   * and **omitted** rather than defaulted to nulls: a caller that does not pass
   * it leaves the three fields `undefined` — "this viewer does not answer" —
   * which is not the same claim as `null`, "the run recorded none".
   */
  learning?: { spells: SpellFacts | null; talents: TalentFacts | null; trades: TradeFacts | null },
): ResultRun {
  const levels = levelMarks(states, segments);
  const ep = episodeOf(run);
  const maxLevel = levels.length > 0 ? levels[levels.length - 1]!.level : run.level;
  /*
   * `run.xp` is the newest sample's reading, so it belongs to `run.level`; it
   * is only the xp *at* `maxLevel` when those agree. Anything else stays null
   * rather than pairing an xp with a level it was not read at.
   */
  const xp =
    maxLevel === null
      ? null
      : (xpAtLevel(states, maxLevel) ?? (run.level === maxLevel ? run.xp : null));
  return {
    runId: run.runId,
    model: run.model,
    /*
     * Straight off the row, which is where the back-fill has already landed:
     * the caller merges the trajectory-derived answer into the row before
     * projecting, so this function stays a pure projection and there is one
     * place that decides stamped-beats-derived.
     */
    resolvedModel: run.resolvedModel,
    cliVersion: run.cliVersion,
    platform: run.platform,
    harnessVersion: run.harnessVersion,
    harnessSeries: harnessSeries(run.harnessVersion),
    extra: run.extra,
    race: run.race,
    raceName: run.raceName,
    class: run.class,
    className: run.className,
    characterLabel: run.characterLabel,
    campaign: run.campaign,
    cell: run.cell,
    effort: run.comparability?.effort ?? null,
    harness: run.harness,
    promptHash: run.comparability?.promptHash ?? null,
    serverBuild: run.comparability?.serverBuild?.build ?? null,
    wikiCoords: run.comparability?.wikiCoords ?? null,
    // A run without the reference surface is labelled as one, never pooled
    // with the runs that had it (issue #61); absent stamps mean it had it.
    wiki: run.comparability?.wiki !== false,
    toolCalls: calls?.toolCalls ?? null,
    snippets: calls?.snippets ?? null,
    modelResponses: calls?.modelResponses ?? null,
    episode: ep.episode,
    episodeSource: ep.source,
    episodeOverride: ep.override,
    unscored: unscoredReason(run, calls?.modelResponses ?? null),
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    live: run.live,
    terminationReason: run.terminationReason,
    levels,
    maxLevel,
    xp,
    xpEarned: xpEarned(states),
    money: run.money,
    questsCompleted: run.questsCompleted,
    maps: mapsOf(states),
    driver: run.driver,
    character: run.character,
    playtimeMs: listing?.playtimeMs ?? null,
    tokens: listing?.tokens ?? null,
    actualCost: listing?.actualCost ?? null,
    expectedCost: listing?.expectedCost ?? null,
    // Did we pay for this run? Not the scheduler's `billingOf` — see billing.ts.
    billing: runBilling({
      model: run.model,
      apiBase: run.apiBase,
      platform: run.platform,
      harness: run.harness,
      driver: run.driver,
    }),
    areas,
    achievements,
    taxi,
    leveling,
    deaths,
    ...(learning === undefined
      ? {}
      : { spells: learning.spells, talents: learning.talents, trades: learning.trades }),
    pauseReason: run.pauseReason,
    continuedFrom: run.continuedFrom,
    /*
     * The scheduler's own notion, not a second one: a launch that produced no
     * response, undecided while it is live or paused. The freeplay ladder
     * needs it because `unscored` answers "the episode" for every steered run
     * and never reaches the run's own facts.
     */
    stillborn: stillbornOf({
      live: run.live,
      pause: run.pauseReason === null ? null : { reason: run.pauseReason, at: 0, count: 0, episodeElapsedMs: null },
      modelResponses: calls?.modelResponses ?? null,
    }),
  };
}
