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
 * - `freeplay` — resume, exactly as before, and however long the gap: a
 *   freeplay run has no budget for a stale gap to spend, and the trajectory
 *   is the character's whole life, so a session that went quiet for a day is
 *   resumed under its own run id rather than ended `stale` and continued
 *   under the next attempt (operator requirement, 2026-09-20: a freeplay run
 *   continues from where it left off after any infrastructure restart).
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

/**
 * The pause a run takes when its observation stops arriving: the sandbox
 * child's event stream is closed and the sampler has found the cursor
 * standing still for long enough to write `observation_stalled` (loop.ts). A
 * run that went on past that point would record the last reading repeated as
 * though it were the world, so it stops and waits instead, under the rules
 * every other pause keeps (operator, 2026-09-25): a lane that resumes brings
 * it back on the same defer ladder a provider pause cools on, with a fresh
 * sandbox and session, and a scored lane ends it. It is not in
 * `PROVIDER_PAUSES`, so on a scored lane it ends as `manual` and is no strike.
 *
 * Declared here rather than beside `PAUSE_REASONS` because the viewer's public
 * projection reads it, and this module is the light one: it must keep
 * importing nothing but `./episodes`.
 */
export const STALL_PAUSE = "observation-stalled";

/**
 * The pause a run never got to write. A fleet run with no termination, no
 * pause row and no live process behind it is a run whose runner died before
 * its verdict — a SIGKILL inside the stop grace, a host that lost power. The
 * supervisor treats it as paused for this reason (`implicitPauses` in
 * infra/run-fleet-plan.ts), never as nothing: on 2026-09-20 such a freeplay
 * run sat invisible to the resume planner for the whole twelve-hour stale
 * window while the policy started a fresh character over the one it was
 * playing. Nothing on disk ever carries this reason; it is derived.
 */
export const OFFLINE_PAUSE = "offline";

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
 * The lane a gap cannot cook. Freeplay has no clock, so nothing elapsed while
 * nobody was playing it: the gap is a gap in the character's life, not a
 * broken measurement. One answer for every reader — the lapse rule below, the
 * stale predicate (`isStaleRun`), and through it the model hold, the resume
 * planner and the status listing — so none of them can drop a freeplay run the
 * others still intend to resume.
 */
export function neverStale(episode: string | null | undefined): boolean {
  return episode === "freeplay";
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
  const cause = opts.pause?.reason ?? OFFLINE_PAUSE;
  const provider = PROVIDER_PAUSES.has(cause);
  if (neverStale(opts.episode)) return { kind: "resume", counts: false };
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
