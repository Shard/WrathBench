/**
 * Episode tiers: the named shapes a run can have, in one table.
 *
 * A run's length, its watchdogs and whether an operator may steer it were three
 * independent flags until now (ADR-0024), which meant "a 90-minute run" was a
 * convention held in fleet.json rather than a thing the harness knew about. A
 * tier names the whole shape at once: `--episode e90` sets the budget and the
 * watchdogs together, and the id is stamped into the comparability tuple
 * (ADR-0026) so two rows on a chart can be asked whether they were given the
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
 * - **A derived tier is a label, not a membership.** ADR-0030 is explicit that
 *   past runs are never back-labeled: they ran under the defaults of their day
 *   (idle 10m, no-XP 45m), which is not what `e90` pins. The reader still
 *   *labels* such a run so it can be found and counted
 *   (`runner/viewer/eval.ts`), but only a stamped, un-overridden run is a
 *   member of a tier's comparability group, and nothing is ever written back.
 *
 * The decision is ADR-0030; the operator-facing write-up of what each tier is
 * *for* is docs/EPISODES.md. The `summary` strings below are the short form the
 * API and the dashboard serve, and they must stay consistent both with the
 * numbers beside them and with that page.
 */

import { z } from "zod";

/** Every episode tier a run can be launched under. */
export const EPISODE_IDS = ["e90", "e360", "freeplay"] as const;
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
   * — the lane's or the config's own value stands — which is not the same as
   * "unbounded": `maxToolCallsPerEpisode` is always a positive number, because
   * it is the runaway guard.
   */
  toolCalls: number | null;
  /** Whether an operator objective (ADR-0024) may steer a run of this tier. */
  objectiveAllowed: boolean;
  /** Whether runs of this tier may enter a scored comparison. */
  scored: boolean;
  /** One paragraph of plain prose: the rules, as the API and dashboard serve them. */
  summary: string;
}

export const EPISODES: Record<EpisodeId, EpisodeTier> = {
  e90: {
    id: "e90",
    minutes: 90,
    idleMinutes: 20,
    noXpMinutes: 20,
    toolCalls: 3000,
    objectiveAllowed: false,
    scored: true,
    summary:
      "The default tier, and the one every model starts on. Ninety minutes of wall clock, a " +
      "fresh level-1 character (ADR-0006), no operator objective, idle and no-XP watchdogs at " +
      "twenty minutes each, and a 3000-call runaway ceiling — 1000 calls per thirty minutes, " +
      "a guard against a loop rather than a task budget. Short " +
      "enough that a full roster gets several episodes a night, which is what makes it the " +
      "sampling tier. Scored — and if ninety minutes turns out to be the wrong default it is " +
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
      "The long scored tier: six hours of wall clock, otherwise identical to e90 — same fresh " +
      "start, same fixed prompt, same tools, no objective. Idle watchdog only; the no-XP " +
      "watchdog is deliberately off, because walking across a continent earns nothing for " +
      "hours and that is the behaviour this tier exists to permit. Scored in its own group: an " +
      "e360 row never shares a chart with an e90 row, since four times the budget is four " +
      "times the opportunity. Entry is two qualifying e90 episodes on the current harness " +
      "version, and the 12000-call ceiling holds e90's rate of 1000 calls per thirty minutes.",
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
      "the only id where the operator may point the agent somewhere (ADR-0024) and where wiki " +
      "coordinates may be served (ADR-0028), which is exactly why it can never score. e360 and " +
      "freeplay are both often six hours long: duration is not what separates them, steering " +
      "is. A freeplay run neither qualifies nor disqualifies a model for anything.",
  },
};

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
 * goes through the launch flag path, and ADR-0026 says the tuple records what
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
    maxToolCalls?: number;
  },
): boolean {
  const want = watchdogsFor(tier);
  // A ceiling the tier does not pin cannot be departed from: e360 leaves it to
  // the lane on purpose, and comparing against a number it never named would
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
