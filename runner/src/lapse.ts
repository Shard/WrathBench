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
 * The shared scoreability rule below answers the broader question — whether a
 * run is safe evidence at all — for both the scheduler and viewer. The
 * termination reason is one of its inputs, not the whole answer: paused,
 * active, and unreadable or empty trajectories are also not evidence.
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

/** Terminations this record writes. These are the runner's lapse/attempt states. */
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
  "environment-defect",
  // A transport failure ends the episode early with the model's clock unspent;
  // the evidence is tainted, not weak (operator, 2026-08-30).
  "adapter-error",
  ...ATTEMPT_FAILURE_REASONS,
]);

/**
 * The facts needed to decide whether a run can be evidence. `undefined` means
 * a metadata-only caller did not supply a response count; `null` means the
 * caller explicitly knows the response count could not be read.
 */
export interface EvidenceFacts {
  live: boolean;
  paused: boolean;
  modelResponses?: number | null;
  terminationReason: string | null;
}

/**
 * Why a run is bad evidence, or null when it is a completed model result.
 *
 * This is deliberately below both the scheduler and viewer: the scheduler's
 * counted target and the viewer's unscored reason must not grow separate lists
 * of reasons or disagree about an in-progress run. Extra/override are not
 * taint: they remain membership questions at their existing callers.
 */
export function badEvidenceReason(f: EvidenceFacts): string | null {
  // Viewer rows currently expose `live: true` for a fresh paused directory, so
  // pause wins to preserve the more useful historical reason on that surface.
  if (f.paused) return "paused";
  if (f.live) return "live";
  if (f.terminationReason !== null && NOT_THE_MODELS_FAULT.has(f.terminationReason)) {
    return f.terminationReason;
  }
  if (f.modelResponses === null) return "model responses unknown";
  if (f.modelResponses !== undefined) {
    if (f.modelResponses <= 0) return "no model responses";
    if (f.terminationReason === null) return "in-progress";
  }
  return null;
}

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
