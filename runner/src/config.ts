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
import { EPISODES, episodeIdSchema, matchesTier, watchdogsFor, type EpisodeId } from "./episodes";

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
 * A partial watchdog override, as a roster entry or fleet job may carry it
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

// --------------------------------------------------------------- run config

/** Every driver a run can be started with. `stub` never scores. */
export const DRIVERS = ["openai", "claude-code", "stub"] as const;
export type Driver = (typeof DRIVERS)[number];

export function isDriver(raw: string): raw is Driver {
  return (DRIVERS as readonly string[]).includes(raw);
}

/**
 * The driver vocabulary is closed and has one spelling per driver. A value
 * outside it is refused by name, so an old file (`claude-subscription`, the
 * pre-0.4 spelling) fails loudly rather than parsing as something else.
 */
const driverSchema = z.string().superRefine((v, ctx) => {
  if (!isDriver(v)) {
    ctx.addIssue({
      code: "custom",
      message: `driver "${v}" is not one of ${DRIVERS.join("|")} — the 0.4 shape writes driver: "claude-code" for the Claude Code CLI`,
    });
  }
}).transform((v) => v as Driver);

/**
 * The harness: what owns the agent loop and the context management (ADR-0035).
 *
 *  - `wrathbench`: our fixed loop, ADR-0012's context policy. The `openai` and
 *    `stub` drivers run under it.
 *  - `claude-code`: the Claude Code CLI scaffold, with its own history and
 *    compaction. There is no separate driver under it — the CLI is the
 *    transport.
 *
 * A comparability dimension, not a scoring penalty: `claude-code` runs score
 * within their own group and never share a chart with `wrathbench` rows.
 * Distinct from `harnessVersion`, which is the git describe of *this* repo
 * and applies to both (the SDK and MCP surface Claude Code drives is ours).
 */
export const HARNESSES = ["wrathbench", "claude-code"] as const;
export type Harness = (typeof HARNESSES)[number];

export const HARNESS_OF_DRIVER: Readonly<Record<Driver, Harness>> = {
  openai: "wrathbench",
  stub: "wrathbench",
  "claude-code": "claude-code",
};

export function harnessOf(driver: Driver): Harness {
  return HARNESS_OF_DRIVER[driver];
}

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
   * Which driver reaches the model (ADR-0035).
   *
   *  - `openai`: the fixed loop (the `wrathbench` harness) over an
   *    OpenAI-compatible endpoint.
   *  - `stub`: the fixed loop over a scripted response file. Harness testing
   *    without a model; never scores.
   *  - `claude-code`: the Claude Code CLI is both transport and harness — it
   *    owns its own history, compaction and preamble, so the run belongs to the
   *    `claude-code` harness group and is scored only against its own kind.
   */
  driver: driverSchema.default("openai"),
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
   * is stamped unscored (`OBJECTIVE_STAMP`) exactly the way a stub run is.
   */
  objective: z.string().min(1).max(4000).optional(),
  /**
   * Whether `search_reference` serves wiki-recorded coordinates (ADR-0028).
   * Default false — names-first: the scored tiers measure whether a model can
   * find things, and exact yards would make every model converge on
   * "search, read a number, moveTo". Freeplay/unscored jobs may turn it on.
   * Stamped into the comparability tuple so the two never share a chart.
   */
  wikiCoords: z.boolean().default(false),
  /**
   * An extra run (ADR-0034): the scheduling policy launched it past the
   * model's target, for a free model with nothing else to do. It is a normal
   * scored run of its tier — same prompt, same leash — and it is stamped so
   * the projection can report it apart and never count it toward a target.
   */
  extra: z.boolean().default(false),

  /**
   * The probe campaign that commissioned this run, and which of its cells this
   * is (ADR-0041). Both present or both absent; set only on a `probing` run.
   *
   * Recorded on the run rather than derived, for two reasons. It is what the
   * scheduler counts to know what a sweep still owes, so it has to survive a
   * restart. And it is what lets a campaign's results outlive the deletion of
   * its config entry — the results surfaces read the run directory, so a
   * campaign that has been switched off and removed from the file still groups.
   *
   * Deliberately NOT `extra: true`, which means "past-target idle work" and
   * would put a commissioned run in the same bucket as a spare-account one.
   */
  campaign: z.string().min(1).max(64).optional(),
  cell: z.string().min(1).max(64).optional(),

  /**
   * The episode tier this run was launched under (`runner/src/episodes.ts`).
   *
   * A tier names the whole shape of a run at once — wall clock, watchdogs, and
   * whether an operator objective is allowed — so that "a 90-minute run" is
   * something the harness knows rather than a convention held in fleet.json.
   * Absent means the run was launched flag-by-flag and belongs to no tier; the
   * reader may still *derive* one for such a run (viewer/results.ts), but nothing
   * writes it back (ADR-0026).
   *
   * The tier supplies watchdog *defaults*: a threshold given explicitly still
   * wins, and the run is then stamped `episodeOverride` so it cannot pass as a
   * clean tier run.
   */
  episode: episodeIdSchema.optional(),

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
   * field is opt-in and never sent by default. `claude-code` passes it
   * as the CLI's `--effort`, which accepts low|medium|high|xhigh|max (verified
   * against the 2.1.238 binary in the runner image). `xhigh`/`max` are
   * claude-only; `minimal` is OpenAI-only.
   */
  effort: z.enum(["minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
  /** Path to a JSON file of scripted stub turns (driver: "stub"). */
  stubScript: z.string().optional(),

  /** Stop after this many model steps. Unlimited when absent (result runs). */
  maxTurns: z.number().int().positive().optional(),
  /**
   * Hard ceiling on tool calls for the whole episode => `tool-call-limit`.
   *
   * `maxTurns` counts *driver* turns, which is a real bound only when the
   * driver owns the tool loop. The claude-code harness does not: one
   * driver turn observed 168 tool calls over 40 minutes, and there is no
   * `--max-turns` in that CLI. So the count that matters under that harness
   * is this one, enforced at the MCP boundary where the calls
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

/**
 * The stamp carried by meta.json, run.sqlite and the timeline for a scripted
 * stub run. The storage key is still named `shakeout` (trajectory.ts); the
 * word now only ever means "this run can never score".
 */
export const STUB_STAMP = "unscored (scripted stub)";

/**
 * The stamp carried by a run with an operator objective. It is a probe, not a
 * result: the run was steered at a named task, so it can never enter a scored
 * comparison against free-play runs (ADR-0024).
 */
export const OBJECTIVE_STAMP = "unscored (operator objective)";

export type RunConfig = z.infer<typeof runConfigSchema>;

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
 * Fill a raw config's unspecified watchdogs from its episode tier.
 *
 * Done on the *raw* object, before zod: after parsing, a threshold the caller
 * gave and one zod defaulted are the same value and cannot be told apart, so
 * the tier would either be unable to move a default or would trample an
 * explicit flag. A resumed run's stored config carries every watchdog key
 * already, so this is a no-op there and the stored leash is preserved.
 */
function withEpisodeDefaults(raw: unknown): unknown {
  const o = (raw ?? {}) as Record<string, unknown>;
  const id = o["episode"];
  if (!isEpisodeIdValue(id)) return o;
  const tier = EPISODES[id];
  const given = (o["watchdogs"] ?? {}) as Record<string, unknown>;
  const want = watchdogsFor(tier);
  return {
    ...o,
    // A tier that pins a tool-call ceiling supplies it too; `null` there means
    // the tier does not name one (e360, freeplay) and the job's value stands.
    ...(tier.toolCalls !== null && o["maxToolCallsPerEpisode"] === undefined
      ? { maxToolCallsPerEpisode: tier.toolCalls }
      : {}),
    watchdogs: {
      ...(given["idleMs"] === undefined ? { idleMs: want.idleMs } : {}),
      ...(given["noXpMs"] === undefined ? { noXpMs: want.noXpMs } : {}),
      ...(given["episodeMs"] === undefined ? { episodeMs: want.episodeMs } : {}),
      ...given,
    },
  };
}

function isEpisodeIdValue(v: unknown): v is EpisodeId {
  return typeof v === "string" && v in EPISODES;
}

/**
 * Whether this run's effective leash still is its tier's.
 *
 * False for a run with no tier at all — "not a tier run" and "a tier run that
 * was overridden" are different claims, and only the second is a warning. The
 * question is asked of the *effective* thresholds, so a resume that tightened
 * the leash restamps as an override exactly the way a launch flag does.
 */
export function episodeOverrideOf(config: RunConfig): boolean {
  if (config.episode === undefined) return false;
  return !matchesTier(EPISODES[config.episode], {
    ...config.watchdogs,
    maxToolCalls: config.maxToolCallsPerEpisode,
  });
}

/**
 * Parse and default a run config object (e.g. from CLI flags or meta.json).
 *
 * `driver` is the one field that names the driver. A config that carries the
 * pre-0.4 `adapter` key *instead* is refused by name; one that carries both
 * (every 0.4 build through 0.4-30 wrote the duplicate) reads `driver` and the
 * duplicate is dropped like any other unknown key.
 */
export function loadRunConfig(raw: unknown): RunConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  if (o["driver"] === undefined && o["adapter"] !== undefined) {
    throw new Error(
      `config names the driver as "adapter" (${JSON.stringify(o["adapter"])}); the 0.4 shape is driver: "openai" | "claude-code" | "stub"`,
    );
  }
  return runConfigSchema.parse(withEpisodeDefaults(raw));
}

/** True when this driver's runs can never be read as a score (ADR-0035: only `stub`). */
export function isUnscoredDriver(driver: Driver): boolean {
  return driver === "stub";
}

/**
 * The stamp a run gets, or undefined for a run that can score.
 *
 * Two independent reasons a run never scores, and a run can carry both: the
 * driver is the scripted stub, and/or the operator steered the run with an
 * objective (ADR-0033). The driver's stamp stays the *prefix* so anything
 * matching on it keeps matching. The harness is *not* a reason: a
 * `claude-code` run scores within its own group (ADR-0035).
 */
export function unscoredStamp(driver: Driver, objective?: string | undefined): string | undefined {
  const byDriver = driver === "stub" ? STUB_STAMP : undefined;
  const byObjective = objective !== undefined && objective.length > 0 ? OBJECTIVE_STAMP : undefined;
  if (byDriver !== undefined && byObjective !== undefined) return `${byDriver}; ${byObjective}`;
  return byDriver ?? byObjective;
}
