/**
 * Episode tiers: the named shapes a run can have, in one table.
 *
 * A run's length, its watchdogs and whether an operator may steer it were three
 * independent flags until now, which meant "a 90-minute run" was a
 * convention held in the fleet config rather than a thing the harness knew about. A
 * tier names the whole shape at once: `--episode e90` sets the budget and the
 * watchdogs together, and the id is stamped into the comparability tuple
 * so two rows on a chart can be asked whether they were given the
 * same episode, not just the same watchdog numbers.
 *
 * Three rules keep the tier honest:
 *
 * - **The table is the only source of the numbers.** Nothing else spells out
 *   90 minutes; the runner, the viewer and the dashboard all read this module
 *   (the dashboard through the wire, since `api-types.ts` stays import-free).
 * - **An explicit override does not silently un-tier the run.** Passing
 *   `--episode e90 --no-xp-ms 0` is allowed — harness development needs it —
 *   but the tuple then carries `episodeOverride: true`, so the run cannot pass
 *   as a clean tier run on a chart.
 * - **A derived tier is a label, not a membership.** Past runs are never
 *   back-labeled: they ran under the defaults of their day
 *   (idle 10m, no-XP 45m), which is not what `e90` pins. The reader still
 *   *labels* such a run so it can be found and counted
 *   (`runner/viewer/results.ts`), but only a stamped, un-overridden run is a
 *   member of a tier's comparability group, and nothing is ever written back.
 *
 * The operator-facing write-up of what each tier is
 * *for* is docs/EPISODES.md. The `summary` strings below are the short form the
 * API and the dashboard serve, and they must stay consistent both with the
 * numbers beside them and with that page.
 */

import { z } from "zod";

/** Every episode tier a run can be launched under. */
export const EPISODE_IDS = ["e90", "e360", "probing", "freeplay"] as const;
export type EpisodeId = (typeof EPISODE_IDS)[number];

export const episodeIdSchema = z.enum(EPISODE_IDS);

/** One tier: the whole shape of a run, in the units an operator thinks in. */
export interface EpisodeTier {
  id: EpisodeId;
  /** Wall-clock budget in minutes. Null = no episode limit (freeplay). */
  minutes: number | null;
  /** Idle watchdog in minutes; every tier has one, so this is never null. */
  idleMinutes: number;
  /** No-XP watchdog in minutes. Null = that watchdog is off for this tier. */
  noXpMinutes: number | null;
  /**
   * Tool calls for the whole episode. **Null means the tier does not pin one**
   * — the job's or the config's own value stands. That is not the same claim
   * as the config's own `maxToolCallsPerEpisode: null`, which says there is no
   * ceiling; a tier that pins nothing still leaves the 500-call default in
   * place for every job that names none.
   */
  toolCalls: number | null;
  /** Whether an operator objective may steer a run of this tier. */
  objectiveAllowed: boolean;
  /** Whether runs of this tier may enter a scored comparison. */
  scored: boolean;
  /** One paragraph of plain prose: the rules, as the API and dashboard serve them. */
  summary: string;
}

export const EPISODES = {
  e90: {
    id: "e90",
    minutes: 90,
    idleMinutes: 20,
    noXpMinutes: 20,
    toolCalls: 3000,
    objectiveAllowed: false,
    scored: true,
    summary:
      "The default episode, and the one every model starts on. Ninety minutes of wall clock, a " +
      "fresh level-1 character, no operator objective, idle and no-XP watchdogs at " +
      "twenty minutes each, and a 3000-call runaway ceiling — 1000 calls per thirty minutes, " +
      "a guard against a loop rather than a task budget. Short " +
      "enough that a full roster gets several episodes a night, which is what makes it the " +
      "sampling episode. Scored — and if ninety minutes turns out to be the wrong default it is " +
      "replaced by a new id, never widened in place.",
  },
  e360: {
    id: "e360",
    minutes: 360,
    idleMinutes: 20,
    noXpMinutes: null,
    // The same rate as e90's, held across four times the clock. The ceiling is
    // a runaway guard sized at 1000 calls per 30 minutes (operator, 2026-08-23),
    // not a task budget: a tier that ends on `tool-call-limit` before its wall
    // clock would be measuring the leash rather than the model.
    toolCalls: 12_000,
    objectiveAllowed: false,
    scored: true,
    summary:
      "The long scored episode: six hours of wall clock, otherwise identical to e90 — same fresh " +
      "start, same fixed prompt, same tools, no objective. Idle watchdog only; the no-XP " +
      "watchdog is deliberately off, because walking across a continent earns nothing for " +
      "hours and that is the behaviour this episode exists to permit. Scored in its own group: an " +
      "e360 row never shares a chart with an e90 row, since four times the budget is four " +
      "times the opportunity. Entry is one counted e90 reaching level 5 on the current harness " +
      "version, and the 12000-call ceiling holds e90's rate of 1000 calls per thirty minutes.",
  },
  probing: {
    id: "probing",
    minutes: 90,
    idleMinutes: 20,
    noXpMinutes: null,
    toolCalls: null,
    objectiveAllowed: true,
    scored: false,
    summary:
      "The probe-campaign episode: a commissioned run under a campaign's own objective, " +
      "cell and clock. Unscored, and never a target — a campaign is run once to completion and a " +
      "harness bump does not re-arm it, which is exactly what separates a probe from an eval. The " +
      "ninety minutes here is the default a campaign inherits when it names no clock of its own, " +
      "not a rule the episode enforces; the no-XP watchdog is off because a probe may spend its whole " +
      "budget walking somewhere in order to find out what happens there. Exploration, not evidence.",
  },
  freeplay: {
    id: "freeplay",
    minutes: null,
    idleMinutes: 20,
    noXpMinutes: null,
    toolCalls: null,
    objectiveAllowed: true,
    scored: false,
    summary:
      "Labeled and unscored. The id caps nothing — a freeplay run may set any wall clock or " +
      "none, and its watchdogs are set per experiment and recorded like everything else. It is " +
      "the only id where the operator may point the agent somewhere and where wiki " +
      "coordinates may be served, which is exactly why it can never score. e360 and " +
      "freeplay are both often six hours long: duration is not what separates them, steering " +
      "is. A freeplay run neither qualifies nor disqualifies a model for anything.",
  },
} as const satisfies Record<EpisodeId, EpisodeTier>;

/**
 * The ids a run can be scored under, read off the table's own `scored` flags.
 *
 * Derived rather than listed, so "which episodes are evidence" has exactly one
 * answer and flipping a flag in the table above moves the type with it. This is
 * what makes `runsPerEpisode` unable to name an unscored episode at all: the
 * landmine `targetFor` used to carry (a name check that a compiler error could
 * be silenced by widening the tier table) is closed at the type level, not by a
 * reviewer noticing.
 */
export type ScoredEpisodeId = { [K in EpisodeId]: (typeof EPISODES)[K]["scored"] extends true ? K : never }[EpisodeId];

/** Whether this episode can enter a scored comparison, narrowing the id. */
export function isScoredEpisode(id: EpisodeId): id is ScoredEpisodeId {
  return EPISODES[id].scored;
}

/** The tiers as a list, in the order they are presented. */
export const EPISODE_LIST: readonly EpisodeTier[] = EPISODE_IDS.map((id) => EPISODES[id]);

export function isEpisodeId(v: unknown): v is EpisodeId {
  return typeof v === "string" && (EPISODE_IDS as readonly string[]).includes(v);
}

/** Minutes to milliseconds, carrying `null` (a disabled watchdog) through. */
function ms(minutes: number | null): number | null {
  return minutes === null ? null : minutes * 60_000;
}

/**
 * The watchdog thresholds a tier implies, in the shape `watchdogConfigSchema`
 * takes. `null` means the watchdog is off, which is the same spelling the
 * config uses everywhere else.
 */
export function watchdogsFor(tier: EpisodeTier): {
  idleMs: number | null;
  noXpMs: number | null;
  episodeMs: number | null;
} {
  return {
    idleMs: ms(tier.idleMinutes)!,
    noXpMs: ms(tier.noXpMinutes),
    episodeMs: ms(tier.minutes),
  };
}

/**
 * Whether an effective budget still matches its tier.
 *
 * Deliberately a predicate over the *effective* thresholds rather than a record
 * of which flags were typed: a resume (`--resume … --watchdogs-json`) never
 * goes through the launch flag path, and the tuple records what
 * will actually be enforced. So the same question is asked the same way on both
 * paths, and `--episode e90 --idle-ms 1200000` — the tier's own value, spelled
 * out — correctly reads as a clean tier run.
 */
export function matchesTier(
  tier: EpisodeTier,
  effective: {
    idleMs: number | null;
    noXpMs: number | null;
    episodeMs: number | null;
    /** Undefined = not stated; null = no ceiling, which no scored tier is. */
    maxToolCalls?: number | null;
  },
): boolean {
  // An unscored tier states no budget to depart from. Its numbers are defaults
  // a campaign or an experiment inherits and then sets for itself, and they are
  // recorded like everything else — so "overridden" is a claim about a scored
  // comparison group, and there is no group here to fall out of.
  if (!tier.scored) return true;
  const want = watchdogsFor(tier);
  // A ceiling the tier does not pin cannot be departed from: e360 leaves it to
  // the job on purpose, and comparing against a number it never named would
  // read every e360 run as overridden.
  const ceilingOk =
    tier.toolCalls === null ||
    effective.maxToolCalls === undefined ||
    tier.toolCalls === effective.maxToolCalls;
  return (
    want.idleMs === effective.idleMs &&
    want.noXpMs === effective.noXpMs &&
    want.episodeMs === effective.episodeMs &&
    ceilingOk
  );
}
