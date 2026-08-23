/**
 * Watchdogs: the named ways a run ends without the model choosing to stop.
 * Thresholds live in config.ts (one place); the semantics live here:
 *
 *   idle            no successful model response for idleMs. Guards against a
 *                   dead adapter or a model that stops producing output.
 *   no-xp           no increase in (level, xp) for noXpMs, measured from the
 *                   first observed progress value — a session that never forms
 *                   is `idle`'s problem, not this one's.
 *   episode-limit   wall clock since episode start exceeds episodeMs.
 *   snippet-runaway maxSandboxRestarts consecutive sandbox kills without an
 *                   intervening successful snippet.
 *
 * A threshold of `null` (which is what `0` normalises to at the config
 * boundary) disables that watchdog outright: it is checked for `null` here,
 * never compared, so a long-running probe job can turn off `no-xp` without
 * the threshold quietly firing on its first check.
 *
 * `environment-defect` is deliberately not detected here: it is a human
 * classification applied after reading a trajectory (classify.ts), because a
 * broken quest looks exactly like a stuck model until someone checks.
 *
 * Everything takes an injectable clock so the tests run in fake time.
 */

import type { TerminationReason, WatchdogConfig } from "./config";

export interface WatchdogVerdict {
  reason: TerminationReason;
  detail: string;
}

export class Watchdogs {
  private readonly startedAt: number;
  private lastModelOutputAt: number;
  private lastProgressAt: number | null = null;
  private lastProgress: { level: number; xp: number } | null = null;
  private sandboxRestarts = 0;

  /**
   * `elapsedBeforeMs` is the episode clock a paused run had already spent:
   * a resumed run's wall clock continues from there, not from this process's
   * start, so the 90/360-minute budget is a budget of play and not of calendar
   * time. Persisted by run.ts in meta.json at every pause.
   */
  constructor(
    private readonly cfg: WatchdogConfig,
    private readonly now: () => number = Date.now,
    elapsedBeforeMs = 0,
  ) {
    this.startedAt = this.now() - Math.max(0, elapsedBeforeMs);
    this.lastModelOutputAt = this.now();
  }

  /** Episode wall clock spent so far, including what earlier segments spent. */
  elapsedMs(): number {
    return this.now() - this.startedAt;
  }

  /** A model response arrived. */
  noteModelOutput(): void {
    this.lastModelOutputAt = this.now();
  }

  /** A state observation arrived. Progress = lexicographic (level, xp). */
  noteProgress(level: number | undefined, xp: number | undefined): void {
    if (level === undefined && xp === undefined) return;
    const current = { level: level ?? 0, xp: xp ?? 0 };
    if (
      this.lastProgress === null ||
      current.level > this.lastProgress.level ||
      (current.level === this.lastProgress.level && current.xp > this.lastProgress.xp)
    ) {
      this.lastProgress = current;
      this.lastProgressAt = this.now();
    } else if (this.lastProgressAt === null) {
      this.lastProgressAt = this.now();
    }
  }

  noteSandboxRestart(): void {
    this.sandboxRestarts++;
  }

  noteSnippetSuccess(): void {
    this.sandboxRestarts = 0;
  }

  /** Evaluate all watchdogs. First tripped wins, in severity order. */
  check(): WatchdogVerdict | null {
    const t = this.now();
    if (this.sandboxRestarts >= this.cfg.maxSandboxRestarts) {
      return {
        reason: "snippet-runaway",
        detail: `${this.sandboxRestarts} consecutive sandbox restarts`,
      };
    }
    if (this.cfg.episodeMs !== null && t - this.startedAt >= this.cfg.episodeMs) {
      return { reason: "episode-limit", detail: `episode wall clock ${t - this.startedAt}ms` };
    }
    if (this.cfg.idleMs !== null && t - this.lastModelOutputAt >= this.cfg.idleMs) {
      return { reason: "idle", detail: `no model output for ${t - this.lastModelOutputAt}ms` };
    }
    if (
      this.cfg.noXpMs !== null &&
      this.lastProgressAt !== null &&
      t - this.lastProgressAt >= this.cfg.noXpMs
    ) {
      return {
        reason: "no-xp",
        detail: `no level/XP progress for ${t - this.lastProgressAt}ms (last: level ${this.lastProgress?.level ?? "?"}, xp ${this.lastProgress?.xp ?? "?"})`,
      };
    }
    return null;
  }
}
