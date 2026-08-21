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

import { z } from "zod";

// ---------------------------------------------------------------- watchdogs

/**
 * Watchdog thresholds and the named reasons they terminate with.
 * See `watchdogs.ts` for the semantics of each.
 */
export const watchdogConfigSchema = z.object({
  /** No model response for this long => `idle`. */
  idleMs: z.number().int().positive().default(10 * 60_000),
  /** No level/XP progress for this long (session must exist) => `no-xp`. */
  noXpMs: z.number().int().positive().default(45 * 60_000),
  /** Episode wall-clock limit => `episode-limit`. Generous per PHASE-0. */
  episodeMs: z.number().int().positive().default(6 * 60 * 60_000),
  /** Consecutive sandbox restarts (event-loop-blocking snippets) => `snippet-runaway`. */
  maxSandboxRestarts: z.number().int().positive().default(3),
});
export type WatchdogConfig = z.infer<typeof watchdogConfigSchema>;

/** Reasons a run can end. Named, closed set; the trajectory records one. */
export const TERMINATION_REASONS = [
  "idle", // watchdog: no model output
  "no-xp", // watchdog: no XP/level progress in the window
  "episode-limit", // watchdog: wall clock
  "snippet-runaway", // watchdog: sandbox kept getting killed for blocking
  "turn-limit", // config maxTurns reached (smoke/dev runs)
  "stub-complete", // the scripted stub adapter played its last response
  "adapter-error", // fatal, non-retryable model API error
  "harness-error", // an unexpected error in the runner itself
  "manual", // operator stopped the run (SIGINT / classify CLI)
  "environment-defect", // manually assigned after reading the trajectory
] as const;
export type TerminationReason = (typeof TERMINATION_REASONS)[number];

/**
 * Pause reasons: the run is suspended, not judged. Resumable with `--resume`.
 * `window-exhausted` covers subscription/quota exhaustion on the model API.
 * `rate-limited` covers post-retry HTTP 429 without quota wording (free pools).
 */
export const PAUSE_REASONS = ["window-exhausted", "rate-limited", "operator-pause"] as const;
export type PauseReason = (typeof PAUSE_REASONS)[number];

// --------------------------------------------------------------- run config

export const runConfigSchema = z.object({
  /** Generated as `run-<timestamp>` when absent. */
  runId: z.string().min(1).optional(),
  /** Module base URL; the compose network name is the default. */
  moduleUrl: z.string().default("http://worldserver:8086"),
  /** Session token. Defaults to the run id so a resume reattaches. */
  token: z.string().min(1).optional(),

  // Character (PHASE-0: run config, default forgiving solo class — Human Paladin).
  character: z.string().min(2).max(12).default("Benchy"),
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
  /** Path to a JSON file of scripted stub turns (adapter: "stub"). */
  stubScript: z.string().optional(),

  /** Stop after this many model steps. Unlimited when absent (result runs). */
  maxTurns: z.number().int().positive().optional(),
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

/** The stamp a run gets, or undefined for a driver whose runs can score. */
export function shakeoutStamp(driver: Driver): string | undefined {
  if (driver === "claude-subscription") return SHAKEOUT_STAMP;
  if (driver === "stub") return "shakeout-only (scripted stub)";
  return undefined;
}
