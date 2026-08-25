/**
 * What happens to a run that stopped without a verdict.
 *
 * A run can lapse two ways. It can **pause** — the runner wrote a pause record
 * and released or kept its session — or it can go **stale**, which
 * is nothing at all: the host slept, the fleet was down, and hours later the
 * run's trajectory has not grown and no process is behind it.
 *
 * The original answer to both was "resume it". That is right for a sandbox and
 * wrong for a measurement: a scored episode that paused for two hours and came
 * back is not a recorded ninety minutes of play, it is a broken one. So the
 * lane decides:
 *
 * - `e90` / `e360` — never resume. The run is a **failed attempt**: ended,
 *   account and character released, and the scheduler gives the model a fresh
 *   attempt with a new run id and a full clock.
 * - `freeplay` — resume, exactly as before.
 * - `probing` — resume only when the campaign says `resume: true`.
 *
 * The whole of "does this failure count against the model" is one predicate:
 * the termination reason is `attempt-failed`. An `operator-pause` is the
 * harness's own doing (a fleet stop, a deploy) and ends as `manual`, which is
 * already in `NOT_THE_MODELS_FAULT`; an offline gap ends as `stale`. Neither
 * counts. That is why the cause is not parsed back out of a detail string
 * anywhere: the reason IS the verdict, and the detail is prose.
 */

import { EPISODES, isEpisodeId } from "./episodes";

/** Failed attempts on one (model, episode, series) before the model is tainted for that episode. */
export const TAINT_AFTER = 3;

/**
 * A run with no wall clock of its own is stale after this. Twice the longest
 * tier budget (`e360`), which is the same fallback the pause logic used,
 * stated once.
 */
export const STALE_FALLBACK_MS = 12 * 60 * 60_000;

/** Pause reasons that are the provider's doing, and therefore the model's problem. */
export const PROVIDER_PAUSES: ReadonlySet<string> = new Set(["quota-exhausted", "rate-limited"]);

/** Terminations this record writes. `attempt-failed` is the only one that counts toward taint. */
export const ATTEMPT_FAILURE_REASONS: ReadonlySet<string> = new Set(["attempt-failed", "stale"]);

/**
 * Terminations that say nothing about the model: an operator cut the run or
 * stopped the fleet under it, the harness itself failed, a lapsed run was
 * ended. They still number attempts (run ids) but they are never evidence —
 * the policy reruns them, and no scored surface reads one as an episode.
 *
 * One set, read by BOTH predicates that ask the question: the scheduler's
 * `isCounted` and the viewer's `unscoredReason`. They were two lists, and a
 * reason added to one and not the other is exactly how a run the scheduler
 * had already written off would still have landed on the ladder.
 */
export const NOT_THE_MODELS_FAULT: ReadonlySet<string> = new Set([
  "manual",
  "harness-error",
  "stale-character",
  ...ATTEMPT_FAILURE_REASONS,
]);

/**
 * How long a run may show no activity before it is cooked. Its OWN recorded
 * budget, never a tier nominal: a run launched with an overridden watchdog is
 * held to the clock it actually ran under.
 */
export function staleAfterMs(episodeMs: number | null): number {
  return episodeMs ?? STALE_FALLBACK_MS;
}

/**
 * Whether a lane resumes a lapsed run. `resume` is the campaign key an
 * operator writes (`campaigns.<name>.resume`); `resumeOnPause` is the same
 * answer travelling on a roster spec. An episode the table does not know —
 * a hand-written roster with no `--episode` — keeps the original resume
 * behaviour.
 */
export function resumesOnPause(episode: string | undefined, campaignResume?: boolean): boolean {
  if (episode === undefined || !isEpisodeId(episode)) return true;
  if (EPISODES[episode].scored) return false;
  if (episode === "freeplay") return true;
  return campaignResume === true;
}

export interface Lapse {
  /** `resume` keeps the run going; the other two end it. */
  kind: "resume" | "fail" | "stale";
  /** The termination to write. Absent on `resume`. */
  reason?: "attempt-failed" | "manual" | "stale";
  detail?: string;
  /** Counts toward the model's three strikes on this episode. Always `reason === "attempt-failed"`. */
  counts: boolean;
}

/** "12h42m" — the gap named in a stale run's detail. */
function fmtGap(ms: number): string {
  const m = Math.round(ms / 60_000);
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m` : `${m}m`;
}

/**
 * What to do with a lapsed run. Pure, and the single place the rule lives:
 * the supervisor, the roster and `--status` all read this one answer.
 *
 * `pause` is the run's pause record, or null when it never paused (a run the
 * fleet lost track of). `staleForMs` is how long it has shown no activity, or
 * null when it is current.
 */
export function classifyLapse(opts: {
  episode: string | undefined;
  campaignResume?: boolean;
  pause: { reason: string } | null;
  staleForMs: number | null;
}): Lapse {
  const cause = opts.pause?.reason ?? "offline";
  const provider = PROVIDER_PAUSES.has(cause);
  if (opts.staleForMs !== null) {
    // A stale gap is the harness's weather, not the model's failure — unless
    // the run was already waiting on its provider when the lights went out.
    const gap = `no activity for ${fmtGap(opts.staleForMs)}`;
    return provider
      ? { kind: "stale", reason: "attempt-failed", detail: `${cause}: ${gap} — ended stale`, counts: true }
      : { kind: "stale", reason: "stale", detail: `${cause}: ${gap} — ended stale`, counts: false };
  }
  if (opts.pause === null) return { kind: "resume", counts: false };
  if (resumesOnPause(opts.episode, opts.campaignResume)) return { kind: "resume", counts: false };
  if (provider) {
    return {
      kind: "fail",
      reason: "attempt-failed",
      detail: `${cause}: not resumed — a scored run that pauses is a failed attempt`,
      counts: true,
    };
  }
  // An operator-pause is a fleet stop or a deploy. The attempt is spent and
  // the model gets a fresh one, but it is the harness's doing, so `manual`.
  return {
    kind: "fail",
    reason: "manual",
    detail: `${cause}: ended as a failed attempt, not counted against the model`,
    counts: false,
  };
}
