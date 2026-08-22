/**
 * All runner configuration in one place, validated with zod at the boundary.
 *
 * Two kinds of knob live here and the distinction is load-bearing (ADR-0004):
 *
 *  - Run config: which model, which character, where the module is. Varies per
 *    run, recorded in the run's metadata.
 *  - Watchdog config: thresholds with fixed defaults. Overridable for harness
 *    development (a two-minute smoke run does not want a six-hour wall clock),
 *    but overrides are recorded in metadata, and a *result* run uses defaults.
 *
 * What deliberately does NOT live here: the context policy (event window,
 * message window, summary format). That is fixed in `context.ts` and written
 * down in docs/decisions/ADR-0012-context-policy.md, because it is part of the
 * harness version, not a knob.
 */

import { randomBytes } from "node:crypto";
import { z } from "zod";

// ---------------------------------------------------------------- watchdogs

/**
 * A millisecond threshold that can be turned off.
 *
 * `null` is the internal representation of "this watchdog does not fire", and
 * `0` normalises to it — argv can only carry strings, so `--no-xp-ms 0` is the
 * disable spelling on the command line while a roster/fleet JSON can say
 * `null` outright. `watchdogs.ts` guards on `!== null`; a zero left as zero
 * would trip the threshold on the first check instead of disabling it.
 */
function msThreshold(defaultMs: number) {
  return z
    .union([z.number().int().nonnegative(), z.null()])
    .default(defaultMs)
    .transform((v) => (v === null || v === 0 ? null : v));
}

/**
 * Watchdog thresholds and the named reasons they terminate with.
 * See `watchdogs.ts` for the semantics of each.
 */
export const watchdogConfigSchema = z.object({
  /** No model response for this long => `idle`. Null/0 disables. */
  idleMs: msThreshold(10 * 60_000),
  /** No level/XP progress for this long (session must exist) => `no-xp`. Null/0 disables. */
  noXpMs: msThreshold(45 * 60_000),
  /** Episode wall-clock limit => `episode-limit`. Generous per PHASE-0. Null/0 disables. */
  episodeMs: msThreshold(6 * 60 * 60_000),
  /** Consecutive sandbox restarts (event-loop-blocking snippets) => `snippet-runaway`. */
  maxSandboxRestarts: z.number().int().positive().default(3),
});
export type WatchdogConfig = z.infer<typeof watchdogConfigSchema>;

/**
 * A partial watchdog override, as a roster entry or fleet lane may carry it
 * (ADR-0024). Same vocabulary as the full config, every key optional, unknown
 * keys refused so a typo in fleet.json is a config error rather than a
 * silently-ignored knob.
 */
export const watchdogOverrideSchema = z
  .object({
    idleMs: z.union([z.number().int().nonnegative(), z.null()]).optional(),
    noXpMs: z.union([z.number().int().nonnegative(), z.null()]).optional(),
    episodeMs: z.union([z.number().int().nonnegative(), z.null()]).optional(),
    maxSandboxRestarts: z.number().int().positive().optional(),
  })
  .strict();
export type WatchdogOverride = z.infer<typeof watchdogOverrideSchema>;

/** Reasons a run can end. Named, closed set; the trajectory records one. */
export const TERMINATION_REASONS = [
  "idle", // watchdog: no model output
  "no-xp", // watchdog: no XP/level progress in the window
  "episode-limit", // watchdog: wall clock
  "snippet-runaway", // watchdog: sandbox kept getting killed for blocking
  "turn-limit", // config maxTurns reached (smoke/dev runs)
  "tool-call-limit", // config maxToolCallsPerEpisode reached (bounds an external scaffold's inner loop)
  "stub-complete", // the scripted stub adapter played its last response
  "adapter-error", // fatal, non-retryable model API error
  "harness-error", // an unexpected error in the runner itself
  "manual", // operator stopped the run (SIGINT / classify CLI)
  "environment-defect", // manually assigned after reading the trajectory
] as const;
export type TerminationReason = (typeof TERMINATION_REASONS)[number];

/**
 * Pause reasons: the run is suspended, not judged. Resumable with `--resume`.
 * `quota-exhausted` covers exhaustion of the model API budget: paid credit,
 * or a subscription's usage window. `rate-limited` covers post-retry HTTP 429
 * without quota wording (free pools). Neither has anything to do with context
 * size — which is what the old name, `window-exhausted`, kept implying.
 */
export const PAUSE_REASONS = ["quota-exhausted", "rate-limited", "operator-pause"] as const;
export type PauseReason = (typeof PAUSE_REASONS)[number];

/**
 * Pause reasons persisted before the rename read in the current vocabulary.
 * Runs are long-lived rows in the trajectory store; nothing validates a stored
 * pause reason, so this exists purely so old rows display under one name.
 */
export function normalizePauseReason(stored: string): string {
  return stored === "window-exhausted" ? "quota-exhausted" : stored;
}

// --------------------------------------------------------------- run config

export const runConfigSchema = z.object({
  /** Generated as `run-<timestamp>` when absent. */
  runId: z.string().min(1).optional(),
  /** Module base URL; the compose network name is the default. */
  moduleUrl: z.string().default("http://worldserver:8086"),
  /**
   * Session token — the bearer secret for `POST /action`, `DELETE /session`
   * and `/events`. Generated random when absent (see `resolveSessionToken`)
   * and persisted through meta.json so a resume reattaches.
   *
   * Deliberately still `min(1)`: this schema also parses *stored* meta.json on
   * `--resume`, and a length floor here would refuse to load every run created
   * before token hardening instead of letting run.ts regenerate theirs.
   */
  token: z.string().min(1).optional(),

  // Character (PHASE-0: run config, default forgiving solo class — Human Paladin).
  character: z.string().min(2).max(12).default("Benchy"),
  /** Game account for this run's sessions. Parallel runs need distinct accounts
   * (the core allows one live session per account). Created via bootstrap. */
  account: z.string().min(2).max(16).default("RUNNER"),
  race: z.number().int().min(1).max(11).default(1),
  class: z.number().int().min(1).max(11).default(2),

  /**
   * Which driver runs the episode.
   *
   *  - `openai`: the fixed loop over an OpenAI-compatible endpoint. The only
   *    driver a *result* run may use (ADR-0004).
   *  - `stub`: the fixed loop over a scripted response file. Harness testing
   *    without a model, never to help a model.
   *  - `claude-subscription`: SHAKEOUT ONLY. Drives an episode through the
   *    `claude` CLI on a Claude subscription. The CLI is an external scaffold
   *    (its own conversation history, its own compaction, its own preamble), so
   *    the context policy of ADR-0012 does not hold and the run is stamped
   *    `shakeout-only (external scaffold)` everywhere it is recorded.
   */
  driver: z.enum(["openai", "claude-subscription", "stub"]).optional(),

  // Legacy name for the driver, kept so old meta.json files resume. `driver`
  // is authoritative and this is kept equal to it after parsing; nothing new
  // should read `adapter`.
  adapter: z.enum(["openai", "claude-subscription", "stub"]).default("openai"),
  /** Model id passed through verbatim to the OpenAI-compatible endpoint. */
  model: z.string().optional(),
  /** e.g. https://openrouter.ai/api/v1 — or OPENAI_BASE_URL from env. */
  apiBase: z.string().optional(),
  /** Name of the env var holding the API key. The key itself is never stored. */
  apiKeyEnv: z.string().default("OPENROUTER_KEY"),
  /**
   * An operator-set objective for this one run — a run dimension, not a
   * per-model prompt (ADR-0024). The same text is rendered into the same
   * place in the same fixed prompt for every model and every driver; it never
   * replaces the standing goal, it is added to it. Because a run steered at a
   * named task is not comparable with a free-play run, a run that carries one
   * is stamped unscored (`OBJECTIVE_STAMP`) exactly the way a shakeout driver's
   * runs are.
   */
  objective: z.string().min(1).max(4000).optional(),
  /**
   * Whether `search_reference` serves wiki-recorded coordinates (ADR-0028).
   * Default false — names-first: the scored lanes measure whether a model can
   * find things, and exact yards would make every model converge on
   * "search, read a number, moveTo". Freeplay/unscored lanes may turn it on.
   * Stamped into the comparability tuple so the two never share a chart.
   */
  wikiCoords: z.boolean().default(false),

  /**
   * Reasoning effort for this run — a profile-matrix dimension, not a tuning
   * knob for one model: it is set per roster entry and recorded, so `opus at
   * low` and `opus at high` are two comparable rows.
   *
   * Absent means "say nothing", which is not the same as any named level: the
   * request goes out without the field and the provider's own default applies.
   *
   * The vocabulary is the union of the two drivers'. `openai` sends it as the
   * OpenAI-compatible `reasoning_effort` (verified honoured by OpenRouter:
   * low/high moved reasoning_tokens 216/310 on the same prompt); a provider
   * that does not know the level is the operator's problem, which is why the
   * field is opt-in and never sent by default. `claude-subscription` passes it
   * as the CLI's `--effort`, which accepts low|medium|high|xhigh|max (verified
   * against the 2.1.238 binary in the runner image). `xhigh`/`max` are
   * claude-only; `minimal` is OpenAI-only.
   */
  effort: z.enum(["minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
  /** Path to a JSON file of scripted stub turns (adapter: "stub"). */
  stubScript: z.string().optional(),

  /** Stop after this many model steps. Unlimited when absent (result runs). */
  maxTurns: z.number().int().positive().optional(),
  /**
   * Hard ceiling on tool calls for the whole episode => `tool-call-limit`.
   *
   * `maxTurns` counts *driver* turns, which is a real bound only when the
   * driver owns the tool loop. The claude-subscription driver does not: one
   * driver turn observed 168 tool calls over 40 minutes, and there is no
   * `--max-turns` in that CLI. So the count that matters for an external
   * scaffold is this one, enforced at the MCP boundary where the calls
   * actually arrive. Generous by default — it is a runaway guard, not a task
   * budget. Ignored by the fixed loop, whose bound is `maxTurns`.
   */
  maxToolCallsPerEpisode: z.number().int().positive().default(500),
  /** Fixed pacing between model steps; not a tuning knob, an API courtesy. */
  stepIntervalMs: z.number().int().nonnegative().default(3_000),
  /** How often a periodic state line is recorded. */
  stateIntervalMs: z.number().int().positive().default(60_000),

  /** Per-snippet evaluation timeout. The runtime survives; the eval does not. */
  snippetTimeoutMs: z.number().int().positive().default(30_000),
  /** How long an unresponsive sandbox gets to answer a ping before restart. */
  sandboxPingGraceMs: z.number().int().positive().default(2_000),

  runsDir: z.string().default("data/runs"),
  wikiBundle: z.string().default("data/wiki/bundle.sqlite"),

  watchdogs: watchdogConfigSchema.prefault({}),
});

/** Every driver a run can be started with. `stub` and `claude-subscription` never score. */
export const DRIVERS = ["openai", "claude-subscription", "stub"] as const;
export type Driver = (typeof DRIVERS)[number];

/** Drivers whose runs are harness shakeout, never a result. */
export const SHAKEOUT_DRIVERS: readonly Driver[] = ["claude-subscription", "stub"];

/** The stamp carried by meta.json, run.sqlite and the timeline for a non-scoring driver. */
export const SHAKEOUT_STAMP = "shakeout-only (external scaffold)";

/**
 * The stamp carried by a run with an operator objective. It is a probe, not a
 * result: the run was steered at a named task, so it can never enter a scored
 * comparison against free-play runs (ADR-0024).
 */
export const OBJECTIVE_STAMP = "unscored (operator objective)";

export type RunConfig = z.infer<typeof runConfigSchema> & { driver: Driver };

export function newRunId(now: Date = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+$/, "")
    .replace("T", "-");
  return `run-${stamp}`;
}

/**
 * The minimum length of a session token the module will accept. Shorter tokens
 * are refused with `weak_token`, because a token *is* the authentication for
 * `POST /action` and `DELETE /session` (FOLLOW-UPS 19): the old default — the
 * run id, a second-granularity timestamp — was enumerable, so a snippet in one
 * run could drive or tear down a concurrent one.
 */
export const MIN_TOKEN_LENGTH = 32;

/** A fresh session secret: 16 random bytes, 32 hex characters. */
export function newSessionToken(): string {
  return randomBytes(16).toString("hex");
}

/**
 * Decide the session token for a run, given whatever was stored or passed.
 *
 * A token shorter than `MIN_TOKEN_LENGTH` is a pre-hardening run id (or a
 * hand-passed placeholder): it is replaced rather than carried forward, and
 * the caller is expected to persist the replacement and log why. Swapping the
 * token on resume cannot strand a live module session in practice — the 18:00
 * worldserver recreate clears every module session nightly, so by the time any
 * run is resumed across that boundary there is no session left to reattach to,
 * and a same-day resume of a weak-token run loses at most one still-parked
 * session that the module frees on its own account timeout.
 */
export function resolveSessionToken(stored: string | undefined): {
  token: string;
  regenerated: boolean;
} {
  if (stored !== undefined && stored.length >= MIN_TOKEN_LENGTH) {
    return { token: stored, regenerated: false };
  }
  return { token: newSessionToken(), regenerated: true };
}

/**
 * Parse and default a run config object (e.g. from CLI flags or meta.json).
 * `driver` and the legacy `adapter` are reconciled here so exactly one of them
 * has to be supplied and both are recorded.
 */
export function loadRunConfig(raw: unknown): RunConfig {
  const parsed = runConfigSchema.parse(raw ?? {});
  const explicitDriver = (raw as { driver?: unknown } | null | undefined)?.driver;
  const driver: Driver =
    parsed.driver ?? (explicitDriver === undefined && parsed.adapter === "stub" ? "stub" : "openai");
  // The legacy field tracks the driver exactly, so an old
  // `WHERE adapter = 'openai'` query cannot silently absorb a shakeout run.
  return { ...parsed, driver, adapter: driver };
}

/** True when this driver's runs must never be read as a harness score. */
export function isShakeoutDriver(driver: Driver): boolean {
  return SHAKEOUT_DRIVERS.includes(driver);
}

/**
 * The stamp a run gets, or undefined for a run that can score.
 *
 * Two independent reasons a run never scores, and a run can carry both: the
 * driver is an external scaffold, and/or the operator steered the run with an
 * objective (ADR-0024). The driver's stamp stays the *prefix* so anything
 * matching on it keeps matching.
 */
export function shakeoutStamp(driver: Driver, objective?: string | undefined): string | undefined {
  const byDriver =
    driver === "claude-subscription"
      ? SHAKEOUT_STAMP
      : driver === "stub"
        ? "shakeout-only (scripted stub)"
        : undefined;
  const byObjective = objective !== undefined && objective.length > 0 ? OBJECTIVE_STAMP : undefined;
  if (byDriver !== undefined && byObjective !== undefined) return `${byDriver}; ${byObjective}`;
  return byDriver ?? byObjective;
}
