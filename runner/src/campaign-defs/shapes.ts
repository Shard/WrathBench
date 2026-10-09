/**
 * Run shapes more than one campaign shares. A definition spreads one of these
 * into itself, so its content hash still covers every field: changing a shared
 * shape changes the hash of every version that uses it, and the pin test says
 * which.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;

/**
 * To level 10 (operator, 2026-10-09). An e360's leash with a later ceiling:
 * idle 20 minutes, the no-XP watchdog off, the tool-call guard at e360's rate
 * of 1000 calls per thirty minutes. Twelve hours of play is enough for the
 * mid-tier models to finish (the frontier needs about five), and the run ends
 * on the first server-observed level 10, so the ceiling is paid only by runs
 * that are not getting there. No objective text: the standing goal already
 * drives levelling, and naming a level is the statistic the goal wording
 * avoids. A paused run resumes, because the measurement is on the play clock
 * and a quota pause in hour nine would otherwise discard the most expensive
 * part of the run.
 */
export const TO_LEVEL_10 = {
  objective: null,
  stopAtLevel: 10,
  budget: { episodeMs: 12 * HOUR, idleMs: 20 * MIN, noXpMs: null, maxToolCalls: 24_000 },
  wikiCoords: false,
  wiki: true,
  resume: true,
  maxAttemptsPerCell: 3,
} as const;
