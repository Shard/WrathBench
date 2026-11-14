/**
 * Subscription usage windows, and the budget the fleet and the drivers read
 * off them (operator, 2026-10-16; on credentials since #429).
 *
 * A subscription credential — one Claude OAuth token, one Codex home, one
 * OpenCode Go key — bills a flat plan whose allowance is metered in rolling
 * windows (five hours, a week). The CLI on that credential reports how much
 * of each window is spent: the codex rollout's `token_count` lines carry
 * `rate_limits` (`codex-rollout.ts`), the Claude Code CLI's stream-json
 * carries `rate_limit_event` frames (`adapter-claude.ts`), and OpenCode Go's
 * allowance answers on its usage endpoint (`opencode-go.ts`). Each reader
 * normalises what it sees into a `SubscriptionUsage` — per window, the used
 * percent, the window's length and its reset, and NOTHING else: never a plan
 * type, a credit balance, a limit name (operator, 2026-10-16) — and records it
 * on change, as a `harness` record of kind `rate_limits` and in the run's
 * meta.json, keyed by the credential the run took (`usageKeyOf`), where the
 * fleet reads the newest observation per credential.
 *
 * Two thresholds, both the credential's own `usage` budget
 * (`runner/src/credential-slots.ts`), carried to the run in its config:
 *
 * - `scoredMaxPct` (default 80): a scored run (`e90`, `e360`) does not START
 *   on a credential while any of its windows is at or over it. A scored run
 *   already live is never paused by the budget: pausing it would spend its
 *   attempt.
 * - `freeplayMaxPct` (default 80): a freeplay run does not start or resume on
 *   a credential at or over it, and a live one pauses at its next turn
 *   boundary (`subscription-budget`), resumable, with the window's reset as
 *   `notBefore` — no rung on either ladder, no streak.
 *
 * `100` turns either off. What stays on regardless is the quota-reset rule,
 * which is not a knob: a credential whose quota is spent (a window at 100%,
 * or a `quota-exhausted` pause that marked one so) holds every launch on it —
 * scored, freeplay or probe — until the window resets, capped at seven days,
 * so no attempt is spent against a quota known to be empty.
 *
 * Staleness: a window counts until its reset; one with no reset counts until
 * its own length past the observation; one with neither never gates. A
 * credential with no observation is open.
 *
 * Nothing here is public: the percentages and reset times stay on the
 * operator's surfaces (`--status`, the run's own records), never on a public
 * page or in published data.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ARCHIVE_DIR } from "../viewer/archive-dir";

/** One usage window, normalised: what the operator decided may be recorded, and nothing more. */
export interface UsageWindow {
  /** Percent of the window's allowance spent, 0–100. */
  usedPercent: number;
  /** The window's length in minutes, or null when the source did not say. */
  windowMinutes: number | null;
  /** When the window resets (epoch ms), or null when the source did not say. */
  resetsAt: number | null;
  /**
   * The model family a per-model cap binds (`opus`, `sonnet`: a Claude weekly
   * cap that only one family's runs draw on), or absent for a window the whole
   * credential shares. A scoped window holds only the launches of a model whose id
   * names that family (`windowApplies`).
   */
  family?: string;
}

/** One observation of a credential's windows. */
export interface SubscriptionUsage {
  /** The credential the reading is of (`usageKeyOf`). */
  credential: string;
  /** When the driver observed it (epoch ms). */
  observedAt: number;
  windows: UsageWindow[];
}

/** Both thresholds' default (operator, 2026-10-16). */
export const DEFAULT_SUB_MAX_PCT = 80;
/** A window at this is spent: the quota-reset hold, whatever the thresholds say. */
export const EXHAUSTED_PCT = 100;
/** The farthest reset a pause waits for (operator, 2026-10-16: capped at seven days). */
export const SUBSCRIPTION_RESET_CEILING_MS = 7 * 24 * 60 * 60_000;

/** A credential's two usage thresholds, each a percent in (0, 100]; 100 = that one off. */
export interface SubscriptionThresholds {
  scored: number;
  freeplay: number;
}

/**
 * The thresholds a run carries (`RunConfig.usageMaxPct`, its credential's
 * `usage` budget), or the quota-reset rule alone when it carries none: a
 * credential with no usage budget holds nothing short of a spent window.
 */
export function thresholdsOf(usageMaxPct: { scored: number; freeplay: number } | null | undefined): SubscriptionThresholds {
  return usageMaxPct == null ? { scored: EXHAUSTED_PCT, freeplay: EXHAUSTED_PCT } : { scored: usageMaxPct.scored, freeplay: usageMaxPct.freeplay };
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
 * The key a run's usage readings are recorded under: the credential it took
 * (`RunConfig.credential`), or, for a run launched by hand with none, its
 * credential env var under an `env:` prefix — a spelling no credential id can
 * have, so a hand-launched run's readings never stand for a credential's.
 */
export function usageKeyOf(r: { credential?: string | null | undefined; credentialEnv?: string | null | undefined }, fallbackEnv?: string): string | null {
  if (typeof r.credential === "string" && r.credential.length > 0) return r.credential;
  const env = r.credentialEnv ?? fallbackEnv;
  return typeof env === "string" && env.length > 0 ? `env:${env}` : null;
}

/**
 * When a window stops counting: its reset, else its own length past the
 * observation, else never known (null) — and never later than seven days
 * past the observation, whatever the reset says. So every reading expires
 * within the ceiling of being taken: a monthly window, or a reset a source
 * mis-scaled, cannot hold a credential longer, and a held credential, on which nothing
 * launches to take a newer reading, cannot stay held for good.
 */
export function windowEndsAt(w: UsageWindow, observedAt: number): number | null {
  const end = w.resetsAt !== null ? w.resetsAt : w.windowMinutes !== null ? observedAt + w.windowMinutes * 60_000 : null;
  return end === null ? null : Math.min(end, observedAt + SUBSCRIPTION_RESET_CEILING_MS);
}

/**
 * Whether a window binds a launch of `model`: a credential-wide window binds every
 * one; a per-model cap only a model whose id names its family (`claude-opus-…`
 * and `opus` for `opus`). A scoped window binds no launch whose model is unknown.
 */
export function windowApplies(w: UsageWindow, model?: string | null): boolean {
  if (w.family === undefined) return true;
  return typeof model === "string" && model.toLowerCase().includes(w.family.toLowerCase());
}

/** The windows still in force at `now` (for `model`, when given). A window whose end is unknown never gates. */
export function liveWindows(u: SubscriptionUsage, now: number, model?: string | null): UsageWindow[] {
  return u.windows.filter((w) => {
    if (model !== undefined && !windowApplies(w, model)) return false;
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

/**
 * Whether an observation holds a launch of `model` at `threshold` percent at
 * `now`, and until when. A per-model window binds only its family's launches;
 * with no model named, only the credential-wide windows bind.
 */
export function usageHold(u: SubscriptionUsage | undefined, threshold: number, now: number, model?: string | null): UsageHold | null {
  if (u === undefined) return null;
  const over = liveWindows(u, now, model ?? null).filter((w) => w.usedPercent >= threshold);
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
export function spentWindowOf(u: SubscriptionUsage | undefined, now: number, model?: string | null): UsageWindow | undefined {
  if (u === undefined) return undefined;
  let best: UsageWindow | undefined;
  for (const w of liveWindows(u, now, model ?? null)) {
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
      return w.usedPercent === o.usedPercent && w.windowMinutes === o.windowMinutes && w.resetsAt === o.resetsAt && w.family === o.family;
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
  const family = typeof w["family"] === "string" && w["family"].length > 0 ? (w["family"] as string) : undefined;
  return { usedPercent: used, windowMinutes: minutes ?? null, resetsAt: resets ?? null, ...(family !== undefined ? { family } : {}) };
}

/** A persisted observation (meta.json's `subscriptionUsage`), read tolerantly: anything malformed is no observation. */
export function parseSubscriptionUsage(raw: unknown): SubscriptionUsage | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const u = raw as Record<string, unknown>;
  // A 0.5 reading names a `lane`, which no credential is: it is no reading here.
  const credential = u["credential"];
  const at = finite(u["observedAt"]);
  if (typeof credential !== "string" || credential.length === 0 || at === undefined || !Array.isArray(u["windows"])) return undefined;
  const windows: UsageWindow[] = [];
  for (const w of u["windows"] as unknown[]) {
    const parsed = parseWindow(w);
    if (parsed !== undefined) windows.push(parsed);
  }
  return { credential, observedAt: at, windows };
}

/**
 * A per-model cap the CLI reports only on the frame that refused a launch:
 * later readings of the credential, taken by another family's runs, do not carry it.
 * So a spent scoped window an older reading holds is kept beside a newer one
 * until it ends, unless the newer one says something of that window itself.
 */
function carrySpentScoped(newer: SubscriptionUsage, older: readonly UsageWindow[], olderAt: number): SubscriptionUsage {
  const carried = older.filter(
    (w) =>
      w.family !== undefined &&
      w.usedPercent >= EXHAUSTED_PCT &&
      (windowEndsAt(w, olderAt) ?? 0) > newer.observedAt &&
      !newer.windows.some((n) => n.family === w.family && n.windowMinutes === w.windowMinutes),
  );
  // Ended at the instant it would have: re-anchored to the newer reading's clock.
  const kept = carried.map((w) => ({ ...w, resetsAt: windowEndsAt(w, olderAt) }));
  return kept.length === 0 ? newer : { ...newer, windows: [...newer.windows, ...kept] };
}

/** The newest observation per credential, by `observedAt`, with any spent per-model cap an older one holds (`carrySpentScoped`). */
export function newestByCredential(observations: Iterable<SubscriptionUsage | null | undefined>): Map<string, SubscriptionUsage> {
  const byCredential = new Map<string, SubscriptionUsage[]>();
  for (const u of observations) {
    if (u === null || u === undefined) continue;
    const list = byCredential.get(u.credential);
    if (list === undefined) byCredential.set(u.credential, [u]);
    else list.push(u);
  }
  const out = new Map<string, SubscriptionUsage>();
  for (const [credential, list] of byCredential) {
    list.sort((a, b) => b.observedAt - a.observedAt);
    let newest = list[0]!;
    for (const older of list.slice(1)) newest = carrySpentScoped(newest, older.windows, older.observedAt);
    out.set(credential, newest);
  }
  return out;
}

/** "5h", "week", "month", "90m" — a window by its length, for the operator's lines. */
export function windowLabel(w: UsageWindow): string {
  const m = w.windowMinutes;
  const scope = w.family !== undefined ? ` ${w.family}` : "";
  if (m === null) return `window${scope}`;
  if (m === 7 * 1440) return `week${scope}`;
  if (m >= 28 * 1440 && m <= 31 * 1440) return `month${scope}`;
  if (m % 1440 === 0) return `${m / 1440}d${scope}`;
  if (m % 60 === 0) return `${m / 60}h${scope}`;
  return `${m}m${scope}`;
}

/**
 * "5h 82% (resets 2026-…Z)" — operator-only wording; never for a public
 * surface. A reset past the seven-day ceiling is named as the window's, with
 * the instant it stops counting beside it.
 */
export function describeWindows(windows: readonly UsageWindow[], observedAt: number): string {
  return windows
    .map((w) => {
      const end = windowEndsAt(w, observedAt);
      const iso = (t: number): string => new Date(t).toISOString();
      const when =
        end === null ? "" : w.resetsAt !== null && w.resetsAt > end ? ` (resets ${iso(w.resetsAt)}, counted only to ${iso(end)})` : ` (resets ${iso(end)})`;
      return `${windowLabel(w)} ${Math.round(w.usedPercent)}%${when}`;
    })
    .join(", ");
}

/**
 * Where the fleet supervisor leaves its own readings (OpenCode Go's, polled)
 * for the readers without a poller — the roster's pre-launch check, `--status`
 * and a driver seeding its tracker. Under the runs directory, operator-only
 * like everything there.
 */
export const CREDENTIAL_USAGE_SIDECAR = "fleet-credential-usage.json";

/**
 * Every run's newest usage reading, off meta.json alone (the archive's too),
 * plus the supervisor's own sidecar: the light read for a caller with no run
 * facts in hand. A directory without one, or an unreadable file, contributes
 * nothing.
 */
export function readCredentialUsage(runsDir: string): SubscriptionUsage[] {
  const out: SubscriptionUsage[] = [];
  const scan = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name === ARCHIVE_DIR) continue;
      const path = join(dir, name, "meta.json");
      if (!existsSync(path)) continue;
      try {
        const meta = JSON.parse(readFileSync(path, "utf8")) as { subscriptionUsage?: unknown };
        const u = parseSubscriptionUsage(meta.subscriptionUsage);
        if (u !== undefined) out.push(u);
      } catch {
        // a torn or foreign meta.json is no reading
      }
    }
  };
  scan(runsDir);
  scan(join(runsDir, ARCHIVE_DIR));
  try {
    const raw = JSON.parse(readFileSync(join(runsDir, CREDENTIAL_USAGE_SIDECAR), "utf8")) as { credentials?: unknown };
    for (const l of Array.isArray(raw.credentials) ? raw.credentials : []) {
      const u = parseSubscriptionUsage(l);
      if (u !== undefined) out.push(u);
    }
  } catch {
    // no sidecar yet
  }
  return out;
}

/** The newest reading of one credential in a runs directory, or undefined. Never throws. */
export function newestCredentialUsage(runsDir: string, credential: string): SubscriptionUsage | undefined {
  try {
    return newestByCredential(readCredentialUsage(runsDir)).get(credential);
  } catch {
    return undefined;
  }
}

/**
 * The driver's side: the newest reading of its credential, written when it changes,
 * and the two questions a driver asks of it — when does a quota pause wait
 * until, and does the freeplay threshold stop this run at its turn boundary.
 * `write` is the run's recorder (`Trajectory.recordSubscriptionUsage`); it is
 * called with a whole observation and must never throw into a turn.
 */
export class SubscriptionUsageTracker {
  private last: SubscriptionUsage | undefined;

  constructor(
    readonly credential: string,
    private readonly write: (u: SubscriptionUsage) => void,
  ) {}

  /** The newest observation, or undefined before the first. */
  get current(): SubscriptionUsage | undefined {
    return this.last;
  }

  /**
   * The credential's newest reading from before this run (another run's, off
   * meta.json), so a run whose first turn meets a spent quota still knows the
   * window it was spent in. Taken only before the run's own first reading,
   * and not written: the run records only what it saw itself.
   */
  seed(u: SubscriptionUsage | undefined): void {
    if (this.last === undefined && u !== undefined && u.credential === this.credential) this.last = u;
  }

  /** A fresh reading of the credential's windows. Recorded only when it differs from the last one recorded. */
  observe(windows: readonly UsageWindow[], now: number): void {
    if (windows.length === 0) return;
    const next =
      this.last === undefined
        ? { credential: this.credential, observedAt: now, windows: windows.map((w) => ({ ...w })) }
        : carrySpentScoped({ credential: this.credential, observedAt: now, windows: windows.map((w) => ({ ...w })) }, this.last.windows, this.last.observedAt);
    if (this.last !== undefined && sameWindows(this.last.windows, next.windows)) return;
    this.record(next);
  }

  /**
   * A `quota-exhausted` pause: when the spent window resets (the pause's
   * `notBefore`, capped), with that window recorded as spent so the usage budget
   * holds every launch on it until then — a scored pause ends its attempt at
   * once, and the next attempt is a fresh launch, not a resume. Undefined when
   * no window with a future reset is known: the pause then falls back to the
   * ladder, as before.
   *
   * `statedReset` is a reset the CLI's own failure text named (epoch ms). It
   * wins over the reading's guess whenever it is given — the CLI knows which
   * window refused it, the reading only which is fullest — and is recorded as
   * one spent window of unknown length ending then. `model` scopes the guess
   * to the windows that bind it (`windowApplies`).
   */
  quotaReset(now: number, statedReset?: number, model?: string | null): number | undefined {
    const u = this.last;
    const stated = statedReset === undefined ? undefined : capReset(statedReset, now);
    if (stated !== undefined) {
      this.record({
        credential: this.credential,
        observedAt: now,
        windows: [...(u?.windows ?? []).map((w) => ({ ...w })), { usedPercent: EXHAUSTED_PCT, windowMinutes: null, resetsAt: statedReset! }],
      });
      return stated;
    }
    const spent = spentWindowOf(u, now, model ?? null);
    if (u === undefined || spent === undefined) return undefined;
    const end = windowEndsAt(spent, u.observedAt);
    const notBefore = end === null ? undefined : capReset(end, now);
    if (notBefore === undefined) return undefined;
    if (spent.usedPercent < EXHAUSTED_PCT) {
      this.record({
        credential: u.credential,
        observedAt: now,
        windows: u.windows.map((w) => (w === spent ? { ...w, usedPercent: EXHAUSTED_PCT } : { ...w })),
      });
    }
    return notBefore;
  }

  /** The hold a live freeplay run of `model` stops for at its turn boundary, or null. */
  freeplayHold(threshold: number, now: number, model?: string | null): UsageHold | null {
    return usageHold(this.last, threshold, now, model ?? null);
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
