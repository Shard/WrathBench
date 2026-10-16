/**
 * Subscription usage windows, and the gate the fleet and the drivers read off
 * them (operator, 2026-10-16).
 *
 * A subscription lane — one Claude OAuth token, one Codex home — bills a flat
 * plan whose allowance is metered in rolling windows (five hours, a week). The
 * CLI on that lane reports how much of each window is spent: the codex
 * rollout's `token_count` lines carry `rate_limits` (`codex-rollout.ts`), the
 * Claude Code CLI's stream-json carries `rate_limit_event` frames
 * (`adapter-claude.ts`), and OpenCode Go's allowance answers on its usage
 * endpoint (`opencode-go.ts`). Each reader normalises what it sees into a
 * `SubscriptionUsage` — per window, the used percent, the window's length and
 * its reset, and NOTHING else: never a plan type, a credit balance, a limit
 * name (operator, 2026-10-16) — and records it on change, as a `harness`
 * record of kind `rate_limits` and in the run's meta.json, where the fleet
 * reads the newest observation per lane.
 *
 * Two thresholds, two env vars, both read by the fleet and by the drivers:
 *
 * - `WRATHBENCH_SUB_SCORED_MAX_PCT` (default 80): a scored run (`e90`,
 *   `e360`) does not START on a lane while any of its windows is at or over
 *   it. A scored run already live is never paused by the gate: pausing it
 *   would spend its attempt.
 * - `WRATHBENCH_SUB_FREEPLAY_MAX_PCT` (default 80): a freeplay run does not
 *   start or resume on a lane at or over it, and a live one pauses at its next
 *   turn boundary (`subscription-budget`), resumable, with the window's reset
 *   as `notBefore` — no strike, no defer rung, no streak.
 *
 * `100` turns either gate off. What stays on regardless is the quota-reset
 * rule, which is not a knob: a lane whose quota is spent (a window at 100%,
 * or a `quota-exhausted` pause that marked one so) holds every launch on it —
 * scored, freeplay or probe — until the window resets, capped at seven days,
 * so no attempt is spent against a quota known to be empty.
 *
 * Staleness: a window counts until its reset; one with no reset counts until
 * its own length past the observation; one with neither never gates. A lane
 * with no observation is open.
 *
 * Lanes are generic strings (`subscriptionLaneOf`): `claude-code:<ENV>` (the
 * same string as the fleet's per-lane concurrency key), `codex:<ENV>` and
 * `opencode-go:<KEY ENV>`. A further subscription plugs in as one more branch
 * there plus a reader that hands its windows to a `SubscriptionUsageTracker`.
 *
 * Nothing here is public: the percentages and reset times stay on the
 * operator's surfaces (`--status`, the run's own records), never on a public
 * page or in published data.
 */
import { DEFAULT_CLAUDE_TOKEN_ENV, DEFAULT_CODEX_HOME_ENV } from "./config";

/** One usage window, normalised: what the operator decided may be recorded, and nothing more. */
export interface UsageWindow {
  /** Percent of the window's allowance spent, 0–100. */
  usedPercent: number;
  /** The window's length in minutes, or null when the source did not say. */
  windowMinutes: number | null;
  /** When the window resets (epoch ms), or null when the source did not say. */
  resetsAt: number | null;
}

/** One observation of a lane's windows. */
export interface SubscriptionUsage {
  /** The lane (`subscriptionLaneOf`). */
  lane: string;
  /** When the driver observed it (epoch ms). */
  observedAt: number;
  windows: UsageWindow[];
}

export const SUB_SCORED_MAX_ENV = "WRATHBENCH_SUB_SCORED_MAX_PCT";
export const SUB_FREEPLAY_MAX_ENV = "WRATHBENCH_SUB_FREEPLAY_MAX_PCT";
/** Both thresholds' default (operator, 2026-10-16). */
export const DEFAULT_SUB_MAX_PCT = 80;
/** A window at this is spent: the quota-reset hold, whatever the thresholds say. */
export const EXHAUSTED_PCT = 100;
/** The farthest reset a pause waits for (operator, 2026-10-16: capped at seven days). */
export const SUBSCRIPTION_RESET_CEILING_MS = 7 * 24 * 60 * 60_000;

export interface SubscriptionThresholds {
  scored: number;
  freeplay: number;
  /** One line per variable that was set but could not be used (its default applies). */
  notes: string[];
}

function parsePct(env: Record<string, string | undefined>, name: string, notes: string[]): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return DEFAULT_SUB_MAX_PCT;
  const n = Number(raw.trim().replace(/%$/, ""));
  if (Number.isFinite(n) && n > 0 && n <= EXHAUSTED_PCT) return n;
  notes.push(`${name}=${JSON.stringify(raw)} is not a percent in (0, 100]; using ${DEFAULT_SUB_MAX_PCT}`);
  return DEFAULT_SUB_MAX_PCT;
}

/** The two thresholds from an environment: each a percent in (0, 100], default 80, 100 = that gate off. */
export function subscriptionThresholds(env: Record<string, string | undefined> = process.env): SubscriptionThresholds {
  const notes: string[] = [];
  const scored = parsePct(env, SUB_SCORED_MAX_ENV, notes);
  const freeplay = parsePct(env, SUB_FREEPLAY_MAX_ENV, notes);
  return { scored, freeplay, notes };
}

/**
 * How a launch is gated: a scored episode at the scored threshold, freeplay at
 * the freeplay one, anything else (a probe) only by the quota-reset rule —
 * the operator's decision names scored and freeplay runs, and a probe is
 * neither.
 */
export type GateClass = "scored" | "freeplay" | "spent-only";

export function gateClassOf(episode: string | null | undefined): GateClass {
  if (episode === "freeplay") return "freeplay";
  if (episode === "e90" || episode === "e360") return "scored";
  return "spent-only";
}

export function thresholdOf(cls: GateClass, t: Pick<SubscriptionThresholds, "scored" | "freeplay">): number {
  return cls === "scored" ? t.scored : cls === "freeplay" ? t.freeplay : EXHAUSTED_PCT;
}

/**
 * The subscription lane a run bills, or null for one that bills none. `lane`
 * is a CLI run's lane variable NAME (`RunConfig.subscription`, a roster spec's
 * `tokenEnv`); absent is the driver's default lane. `goKeyEnv` is set, by
 * `goKeyEnvOf` (models.ts), on an `openai` run that draws on an OpenCode Go
 * allowance: one lane per key (`opencode-go:<KEY ENV>`). A further
 * subscription is one more branch here plus an observation reader.
 */
export function subscriptionLaneOf(r: {
  driver?: string | null | undefined;
  lane?: string | null | undefined;
  goKeyEnv?: string | null | undefined;
}): string | null {
  if (r.driver === "claude-code") return `claude-code:${r.lane ?? DEFAULT_CLAUDE_TOKEN_ENV}`;
  if (r.driver === "codex") return `codex:${r.lane ?? DEFAULT_CODEX_HOME_ENV}`;
  if ((r.driver ?? "openai") === "openai" && typeof r.goKeyEnv === "string" && r.goKeyEnv.length > 0) return `opencode-go:${r.goKeyEnv}`;
  return null;
}

/** When a window stops counting: its reset, else its own length past the observation, else never known (null). */
export function windowEndsAt(w: UsageWindow, observedAt: number): number | null {
  if (w.resetsAt !== null) return w.resetsAt;
  if (w.windowMinutes !== null) return observedAt + w.windowMinutes * 60_000;
  return null;
}

/** The windows still in force at `now`. A window whose end is unknown never gates. */
export function liveWindows(u: SubscriptionUsage, now: number): UsageWindow[] {
  return u.windows.filter((w) => {
    const end = windowEndsAt(w, u.observedAt);
    return end !== null && end > now;
  });
}

/** The latest of two optional instants. */
const later = (a: number | null, b: number | null): number | null => (a === null ? b : b === null ? a : Math.max(a, b));

export interface UsageHold {
  /** The threshold that holds, in percent. */
  threshold: number;
  /** The windows in force at or over it. */
  windows: UsageWindow[];
  /** When the last of them resets, capped at seven days out. */
  until: number;
}

/** Whether an observation holds a launch at `threshold` percent at `now`, and until when. */
export function usageHold(u: SubscriptionUsage | undefined, threshold: number, now: number): UsageHold | null {
  if (u === undefined) return null;
  const over = liveWindows(u, now).filter((w) => w.usedPercent >= threshold);
  if (over.length === 0) return null;
  let until: number | null = null;
  for (const w of over) until = later(until, windowEndsAt(w, u.observedAt));
  return { threshold, windows: over, until: Math.min(until!, now + SUBSCRIPTION_RESET_CEILING_MS) };
}

/** A reset as a pause's `notBefore`: in the future, and no farther than the ceiling. */
export function capReset(resetAt: number, now: number): number | undefined {
  if (!Number.isFinite(resetAt) || resetAt <= now) return undefined;
  return Math.min(resetAt, now + SUBSCRIPTION_RESET_CEILING_MS);
}

/**
 * The window a `quota-exhausted` pause is put down to: of those in force with
 * a known end, the most used (the latest reset on a tie). Neither CLI says
 * which window ran out in a form the driver keeps — codex exec drops the
 * typed error, Claude's `rejected` frame names it only sometimes — so this is
 * the reading's best answer, and undefined when it has none.
 */
export function spentWindowOf(u: SubscriptionUsage | undefined, now: number): UsageWindow | undefined {
  if (u === undefined) return undefined;
  let best: UsageWindow | undefined;
  for (const w of liveWindows(u, now)) {
    if (
      best === undefined ||
      w.usedPercent > best.usedPercent ||
      (w.usedPercent === best.usedPercent && (windowEndsAt(w, u.observedAt) ?? 0) > (windowEndsAt(best, u.observedAt) ?? 0))
    ) {
      best = w;
    }
  }
  return best;
}

/** Two observations' windows read alike: what "on change" means for the record. */
export function sameWindows(a: readonly UsageWindow[], b: readonly UsageWindow[]): boolean {
  return (
    a.length === b.length &&
    a.every((w, i) => {
      const o = b[i]!;
      return w.usedPercent === o.usedPercent && w.windowMinutes === o.windowMinutes && w.resetsAt === o.resetsAt;
    })
  );
}

const finite = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** One persisted window, or undefined when it is not one. */
function parseWindow(raw: unknown): UsageWindow | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const w = raw as Record<string, unknown>;
  const used = finite(w["usedPercent"]);
  if (used === undefined) return undefined;
  const minutes = finite(w["windowMinutes"]);
  const resets = finite(w["resetsAt"]);
  return { usedPercent: used, windowMinutes: minutes ?? null, resetsAt: resets ?? null };
}

/** A persisted observation (meta.json's `subscriptionUsage`), read tolerantly: anything malformed is no observation. */
export function parseSubscriptionUsage(raw: unknown): SubscriptionUsage | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const u = raw as Record<string, unknown>;
  const lane = u["lane"];
  const at = finite(u["observedAt"]);
  if (typeof lane !== "string" || lane.length === 0 || at === undefined || !Array.isArray(u["windows"])) return undefined;
  const windows: UsageWindow[] = [];
  for (const w of u["windows"] as unknown[]) {
    const parsed = parseWindow(w);
    if (parsed !== undefined) windows.push(parsed);
  }
  return { lane, observedAt: at, windows };
}

/** The newest observation per lane, by `observedAt`. */
export function newestByLane(observations: Iterable<SubscriptionUsage | null | undefined>): Map<string, SubscriptionUsage> {
  const out = new Map<string, SubscriptionUsage>();
  for (const u of observations) {
    if (u === null || u === undefined) continue;
    const have = out.get(u.lane);
    if (have === undefined || u.observedAt > have.observedAt) out.set(u.lane, u);
  }
  return out;
}

/** "5h", "7d", "90m" — a window by its length, for the operator's lines. */
export function windowLabel(w: UsageWindow): string {
  const m = w.windowMinutes;
  if (m === null) return "window";
  if (m % 1440 === 0) return `${m / 1440}d`;
  if (m % 60 === 0) return `${m / 60}h`;
  return `${m}m`;
}

/** "5h 82% (resets 2026-…Z)" — operator-only wording; never for a public surface. */
export function describeWindows(windows: readonly UsageWindow[], observedAt: number): string {
  return windows
    .map((w) => {
      const end = windowEndsAt(w, observedAt);
      return `${windowLabel(w)} ${Math.round(w.usedPercent)}%${end !== null ? ` (resets ${new Date(end).toISOString()})` : ""}`;
    })
    .join(", ");
}

/**
 * The driver's side: the newest reading on its lane, written when it changes,
 * and the two questions a driver asks of it — when does a quota pause wait
 * until, and does the freeplay threshold stop this run at its turn boundary.
 * `write` is the run's recorder (`Trajectory.recordSubscriptionUsage`); it is
 * called with a whole observation and must never throw into a turn.
 */
export class SubscriptionUsageTracker {
  private last: SubscriptionUsage | undefined;

  constructor(
    readonly lane: string,
    private readonly write: (u: SubscriptionUsage) => void,
  ) {}

  /** The newest observation, or undefined before the first. */
  get current(): SubscriptionUsage | undefined {
    return this.last;
  }

  /** A fresh reading of the lane's windows. Recorded only when it differs from the last one recorded. */
  observe(windows: readonly UsageWindow[], now: number): void {
    if (windows.length === 0) return;
    if (this.last !== undefined && sameWindows(this.last.windows, windows)) return;
    this.record({ lane: this.lane, observedAt: now, windows: windows.map((w) => ({ ...w })) });
  }

  /**
   * A `quota-exhausted` pause: when the spent window resets (the pause's
   * `notBefore`, capped), with that window recorded as spent so the lane gate
   * holds every launch on it until then — a scored pause ends its attempt at
   * once, and the next attempt is a fresh launch, not a resume. Undefined when
   * no window with a future reset is known: the pause then falls back to the
   * ladder, as before.
   *
   * `statedReset` is a reset the CLI's own failure text named (epoch ms), for
   * when no window was observed: it is recorded as one spent window of
   * unknown length ending then.
   */
  quotaReset(now: number, statedReset?: number): number | undefined {
    const u = this.last;
    const spent = spentWindowOf(u, now);
    if (u === undefined || spent === undefined) {
      const notBefore = statedReset === undefined ? undefined : capReset(statedReset, now);
      if (notBefore === undefined) return undefined;
      this.record({
        lane: this.lane,
        observedAt: now,
        windows: [...(u?.windows ?? []).map((w) => ({ ...w })), { usedPercent: EXHAUSTED_PCT, windowMinutes: null, resetsAt: statedReset! }],
      });
      return notBefore;
    }
    const end = windowEndsAt(spent, u.observedAt);
    const notBefore = end === null ? undefined : capReset(end, now);
    if (notBefore === undefined) return undefined;
    if (spent.usedPercent < EXHAUSTED_PCT) {
      this.record({
        lane: u.lane,
        observedAt: now,
        windows: u.windows.map((w) => (w === spent ? { ...w, usedPercent: EXHAUSTED_PCT } : { ...w })),
      });
    }
    return notBefore;
  }

  /** The hold a live freeplay run stops for at its turn boundary, or null. */
  freeplayHold(threshold: number, now: number): UsageHold | null {
    return usageHold(this.last, threshold, now);
  }

  private record(u: SubscriptionUsage): void {
    this.last = u;
    try {
      this.write(u);
    } catch {
      // a record never costs a turn
    }
  }
}
