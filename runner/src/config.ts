/**
 * All runner configuration in one place, validated with zod at the boundary.
 *
 * Two kinds of knob live here and the distinction is load-bearing:
 *
 *  - Run config: which model, which character, where the module is. Varies per
 *    run, recorded in the run's metadata.
 *  - Watchdog config: thresholds with fixed defaults. Overridable for harness
 *    development (a two-minute smoke run does not want a six-hour wall clock),
 *    but overrides are recorded in metadata, and a *result* run uses defaults.
 *
 * What deliberately does NOT live here: the context policy (event window,
 * message window, summary format). That is fixed in `context.ts` and written
 * down in docs/METHODOLOGY.md ("Context policy"), because it is part of the
 * harness version, not a knob.
 */

import { randomBytes } from "node:crypto";
import { z } from "zod";
import { EPISODES, episodeIdSchema, matchesTier, watchdogsFor, type EpisodeId } from "./episodes";
import { routingSchema } from "./routing";

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
  /** Episode wall-clock limit => `episode-limit`. Generous by default. Null/0 disables. */
  episodeMs: msThreshold(6 * 60 * 60_000),
  /** Consecutive sandbox restarts (event-loop-blocking snippets) => `snippet-runaway`. */
  maxSandboxRestarts: z.number().int().positive().default(3),
});
export type WatchdogConfig = z.infer<typeof watchdogConfigSchema>;

/**
 * A partial watchdog override, as a roster entry or fleet job may carry it.
 * Same vocabulary as the full config, every key optional, unknown
 * keys refused so a typo in the fleet config is a config error rather than a
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
  "stale-character", // a fresh episode found a used character (precondition violated); never the model's fault
  "manual", // operator stopped the run (SIGINT / classify CLI)
  "attempt-failed", // a scored run paused and was not resumed; the model's attempt, spent
  "stale", // nothing came back for it: the fleet was down or the host slept past its budget
  "environment-defect", // manually assigned after reading the trajectory
  // The provider's own policy layer stopped the model — GPT-6 Astra's
  // misalignment monitor can pause or end a long-running agentic task, and in
  // `codex exec` nobody is there to approve a continuation (adapter-codex.ts).
  // Named apart from adapter-error because it is a verdict about the run, not a
  // transport fault; the provider's message is recorded verbatim. Never
  // auto-overridden: what to do about it is the operator's call.
  "provider-policy",
  // The scaffold's own context window overflowed and it could not compact its
  // way out (codex `contextWindowExceeded`). The fixed loop cannot hit this —
  // its window is rebuilt every turn — so it only ever names a CLI harness.
  "context-limit",
] as const;
export type TerminationReason = (typeof TERMINATION_REASONS)[number];

/**
 * Pause reasons: the run is suspended, not judged. Resumable with `--resume`.
 * `quota-exhausted` covers exhaustion of the model API budget: paid credit,
 * or a subscription's usage window. `rate-limited` covers post-retry HTTP 429
 * without quota wording (free pools). Neither has anything to do with context
 * size — which is what the old name, `window-exhausted`, kept implying.
 * `auth-failed` is a subscription lane whose credential stopped working
 * (codex: "Your access token could not be refreshed" — a refresh token spent
 * by another process on the same CODEX_HOME, or a 401). Nothing about the
 * model; the run resumes once the operator has logged the lane back in.
 */
export const PAUSE_REASONS = ["quota-exhausted", "rate-limited", "operator-pause", "auth-failed"] as const;
export type PauseReason = (typeof PAUSE_REASONS)[number];

// --------------------------------------------------------------- run config

/**
 * The game's own character-name rules, checked before the server gets to:
 * 2-12 letters, and no three identical consecutive letters — the core refuses
 * that as CHAR_NAME_THREE_CONSECUTIVE (create result 98). One predicate for
 * every boundary that accepts or invents a name (this config, the fleet
 * roster, a campaign cell, the smokes' probeName), so a bad name is a named
 * error where it is WRITTEN, not a create-failure loop where it is played.
 * Both failure shapes happened on 2026-08-24: a 13-char roster name
 * respawn-looped the policy for two hours, and a generated triple
 * (`Bqeee…`) rolled back a worldserver deploy.
 */
export const CHARACTER_NAME_RULE = "character must be 2-12 letters with no three identical in a row (the game's own naming rules)";
export function isValidCharacterName(name: string): boolean {
  return /^[A-Za-z]{2,12}$/.test(name) && !/(.)\1\1/i.test(name);
}

/** Every driver a run can be started with. `stub` never scores. */
export const DRIVERS = ["openai", "claude-code", "codex", "stub"] as const;
export type Driver = (typeof DRIVERS)[number];

export function isDriver(raw: string): raw is Driver {
  return (DRIVERS as readonly string[]).includes(raw);
}

/**
 * The default subscription lane: the env var the Claude Code CLI itself knows,
 * and the only one a run names when nothing says otherwise. A second
 * subscription is a second variable (`CLAUDE_CODE_OAUTH_TOKEN_2`), never a
 * second spelling of this one — see `RunConfig.subscription`.
 */
export const DEFAULT_CLAUDE_TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN";

/**
 * The `codex` driver's default lane: the env var the Codex CLI itself reads
 * for its home directory, whose `auth.json` is the ChatGPT login. The lane
 * variable names a DIRECTORY, not a token — one directory per subscription,
 * shared by every run on that lane and never copied per run: a copied
 * `auth.json` carries a refresh token that whichever process refreshes first
 * consumes, and the other side then fails with "refresh token was already
 * used" (observed on this host, 2026-09-05). A second subscription is a second
 * variable (`CODEX_HOME_2`) pointing at a second directory.
 */
export const DEFAULT_CODEX_HOME_ENV = "CODEX_HOME";

/**
 * Whether a string is usable as a subscription lane name. An env var name and
 * nothing else: the fleet builds a concurrency key out of it and the runner
 * looks it up in `process.env`, so a value that snuck in here would be a
 * credential in a config file.
 */
export function isTokenEnvName(raw: string): boolean {
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(raw);
}

/**
 * The driver vocabulary is closed and has one spelling per driver. A value
 * outside it is refused by name, so an old file (`claude-subscription`, the
 * former spelling) fails loudly rather than parsing as something else.
 */
const driverSchema = z.string().superRefine((v, ctx) => {
  if (!isDriver(v)) {
    ctx.addIssue({
      code: "custom",
      message: `driver "${v}" is not one of ${DRIVERS.join("|")} — the current shape writes driver: "claude-code" for the Claude Code CLI and driver: "codex" for the Codex CLI`,
    });
  }
}).transform((v) => v as Driver);

/**
 * The harness: what owns the agent loop and the context management.
 *
 *  - `wrathbench`: our fixed loop, with the fixed context policy
 *    (docs/METHODOLOGY.md "Context policy"). The `openai` and
 *    `stub` drivers run under it.
 *  - `claude-code`: the Claude Code CLI scaffold, with its own history and
 *    compaction. There is no separate driver under it — the CLI is the
 *    transport.
 *  - `codex`: the OpenAI Codex CLI scaffold (operator, 2026-09-05), likewise
 *    its own history and its own compaction. A separate group from
 *    `claude-code` rather than one "CLI" group, because each scaffold is a
 *    different unversioned summarizer sitting inside the harness.
 *
 * A comparability dimension, not a scoring penalty: `claude-code` and `codex`
 * runs score within their own group and never share a chart with `wrathbench`
 * rows. Distinct from `harnessVersion`, which is the git describe of *this*
 * repo and applies to all three (the SDK and MCP surface each CLI drives is
 * ours).
 */
export const HARNESSES = ["wrathbench", "claude-code", "codex"] as const;
export type Harness = (typeof HARNESSES)[number];

export const HARNESS_OF_DRIVER: Readonly<Record<Driver, Harness>> = {
  openai: "wrathbench",
  stub: "wrathbench",
  "claude-code": "claude-code",
  codex: "codex",
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

  /**
   * The character the run is PLAYING — the name the model chose, written here
   * by `trajectory.setCharacter` once `createSession` lands and read back on
   * `--resume`. It is never a launch input: nothing suggests a name and no
   * flag sets one. Absent means the model has not named one yet, which is
   * every run's first minute.
   */
  character: z
    .string()
    .refine(isValidCharacterName, { message: CHARACTER_NAME_RULE })
    .optional(),
  /**
   * The freeplay run this one CONTINUES (`--continue-from`): a new run id on
   * the predecessor's account, character and scratchpad, stamped so the
   * lineage is readable off the run record. A freeplay character is the operator's
   * to disable and re-enable at will, and its character must survive that
   * (operator ask, 2026-08-29). Only `freeplay` may carry it — a scored
   * episode is a fresh character by definition — and run.ts refuses anything
   * else at launch. Identity on `--resume`, like `character`.
   */
  continuedFrom: z.string().min(1).optional(),
  /** Game account for this run's sessions. Parallel runs need distinct accounts
   * (the core allows one live session per account). Created via bootstrap. */
  account: z.string().min(2).max(16).default("RUNNER"),
  race: z.number().int().min(1).max(11).default(1),
  class: z.number().int().min(1).max(11).default(2),

  /**
   * Which driver reaches the model.
   *
   *  - `openai`: the fixed loop (the `wrathbench` harness) over an
   *    OpenAI-compatible endpoint.
   *  - `stub`: the fixed loop over a scripted response file. Harness testing
   *    without a model; never scores.
   *  - `claude-code`: the Claude Code CLI is both transport and harness — it
   *    owns its own history, compaction and preamble, so the run belongs to the
   *    `claude-code` harness group and is scored only against its own kind.
   *  - `codex`: the OpenAI Codex CLI, the same shape on a ChatGPT
   *    subscription: transport and harness at once, its own group.
   */
  driver: driverSchema.default("openai"),
  /** Model id passed through verbatim to the OpenAI-compatible endpoint. */
  model: z.string().optional(),
  /** e.g. https://openrouter.ai/api/v1 — or OPENAI_BASE_URL from env. */
  apiBase: z.string().optional(),
  /** Name of the env var holding the API key. The key itself is never stored. */
  apiKeyEnv: z.string().default("OPENROUTER_KEY"),
  /**
   * `claude-code` and `codex` only: the SUBSCRIPTION LANE this run bills,
   * named by the env var holding its credential — never the credential itself.
   * For claude-code that is the OAuth token (a secret, redacted out of
   * everything this run writes); for codex it is the CODEX_HOME directory
   * whose auth.json holds the ChatGPT login (`DEFAULT_CODEX_HOME_ENV`).
   *
   * A subscription is a lane, not a model dimension: the same roster entry may
   * run on either account, so this says nothing about what was measured. It is
   * recorded for two reasons. The fleet counts in-flight runs per lane to keep
   * one live session per subscription, and that count has to survive a
   * supervisor restart, so it is read back off the run rather than held in
   * memory. And a resumed run must go back to the subscription it started on —
   * `--resume` rebuilds the config from meta.json, so this field is how.
   *
   * Absent means the driver's default lane (`CLAUDE_CODE_OAUTH_TOKEN`,
   * `CODEX_HOME`); `run.ts` fills it in for every run on those drivers, so a
   * run launched by this build always names its lane.
   */
  subscription: z.string().min(1).max(128).optional(),
  /**
   * An operator-set objective for this one run — a run dimension, not a
   * per-model prompt. The same text is rendered into the same
   * place in the same fixed prompt for every model and every driver; it never
   * replaces the standing goal, it is added to it. Because a run steered at a
   * named task is not comparable with a free-play run, a run that carries one
   * is stamped unscored (`OBJECTIVE_STAMP`) exactly the way a stub run is.
   */
  objective: z.string().min(1).max(4000).optional(),
  /**
   * Whether `search_reference` serves wiki-recorded coordinates.
   * Default false — names-first: the scored tiers measure whether a model can
   * find things, and exact yards would make every model converge on
   * "search, read a number, moveTo". Freeplay/unscored jobs may turn it on.
   * Stamped into the comparability tuple so the two never share a chart.
   */
  wikiCoords: z.boolean().default(false),
  /**
   * Whether this run has the reference wiki at all — the `search_reference`
   * tool, its line in the prompt, and the bundle itself.
   *
   * A CAPABILITY, included by default and switchable off per run (operator
   * decision 2026-09-16, issue #61): the reference surface is part of the
   * fixed harness, so a run without it is a different condition, declared at
   * launch and stamped into the comparability tuple. False means the tool is
   * never registered, the prompt never names it, and no bundle is opened —
   * which is not the same thing as a bundle that failed to load, where the
   * tool exists and reports itself unavailable.
   */
  wiki: z.boolean().default(true),
  /**
   * An extra run: the scheduling policy launched it past the
   * model's target, for a free model with nothing else to do. It is a normal
   * scored run of its tier — same prompt, same leash — and it is stamped so
   * the projection can report it apart and never count it toward a target.
   */
  extra: z.boolean().default(false),

  /**
   * The probe campaign that commissioned this run, and which of its cells this
   * is. Both present or both absent; set only on a `probing` run.
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
   * something the harness knows rather than a convention held in the fleet config.
   * Absent means the run was launched flag-by-flag and belongs to no tier; the
   * reader may still *derive* one for such a run (viewer/results.ts), but nothing
   * writes it back — the tuple records what was launched, never what a reader
   * inferred.
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
   * against the 2.1.238 binary in the runner image). `codex` passes it as
   * `-c model_reasoning_effort="<level>"`, whose levels are
   * low|medium|high|xhigh|max|ultra (`ultra` is what the ChatGPT catalogue
   * advertises for gpt-6-astra, 2026-09-05) — `none` and `minimal` are not
   * Codex levels and that driver refuses them by name rather than mapping
   * them. `xhigh`/`max` are claude-and-codex; `minimal` is OpenAI-API-only.
   *
   * `none` means extended thinking OFF, which is a level like any other and
   * not the same as absent: absent is the provider's default, which for these
   * models thinks. `claude-code` reaches it by setting `MAX_THINKING_TOKENS=0`
   * in the CLI's environment and passing no `--effort` — the flag has no such
   * level; `openai` sends `reasoning_effort: "none"`, which some OpenRouter
   * models accept and others reject, as with every level here.
   */
  effort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]).optional(),
  /**
   * Which backend the aggregator may route this run to, as the fleet config
   * declared it (`routing.ts`) — the DECLARED block, not the resolved one, so
   * a resumed run re-derives against the same rules rather than freezing a
   * default that was never written down. Absent means "the entry said
   * nothing", which resolves to the model author's own provider with fallbacks
   * off. Identity, like effort: a resumed run keeps the routing it was
   * launched with, and the resolved answer is stamped in the tuple.
   */
  routing: routingSchema.optional(),
  /** Path to a JSON file of scripted stub turns (driver: "stub"). */
  stubScript: z.string().optional(),

  /** Stop after this many model steps. Unlimited when absent (result runs). */
  maxTurns: z.number().int().positive().optional(),
  /**
   * Hard ceiling on tool calls for the whole episode => `tool-call-limit`.
   *
   * `maxTurns` counts *driver* turns, which is a real bound only when the
   * driver owns the tool loop. The claude-code and codex harnesses do not: one
   * claude-code driver turn observed 168 tool calls over 40 minutes, and
   * neither CLI has a `--max-turns`. So the count that matters under those
   * harnesses is this one, enforced at the MCP boundary where the calls
   * actually arrive. Generous by default — it is a runaway guard, not a task
   * budget. Ignored by the fixed loop, whose bound is `maxTurns`.
   *
   * `null` disables it outright, and exactly one lane asks for that: the
   * policy's `idle: "unlimited"` freeplay session, which is meant to be one
   * continuous character and has no wall clock either. A guard sized for a
   * ninety-minute episode is not a guard on a session with no end — four of
   * the six sub-opus-low freeplay runs ended `tool-call-limit` at 500 and the
   * fleet started a fresh level-1 character each time. Every other launch
   * keeps the 500. Disabling it does not disable the idle watchdog, the
   * snippet-runaway guard, or any fatal path: those remain the stops.
   */
  maxToolCallsPerEpisode: z.number().int().positive().nullable().default(500),
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
 * comparison against free-play runs.
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
 * `POST /action` and `DELETE /session`: the old default — the
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
 * former `adapter` key *instead* is refused by name; one that carries both
 * (the builds that wrote the duplicate) reads `driver` and the
 * duplicate is dropped like any other unknown key.
 */
export function loadRunConfig(raw: unknown): RunConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  if (o["driver"] === undefined && o["adapter"] !== undefined) {
    throw new Error(
      `config names the driver as "adapter" (${JSON.stringify(o["adapter"])}); the current shape is driver: "openai" | "claude-code" | "codex" | "stub"`,
    );
  }
  const config = runConfigSchema.parse(withEpisodeDefaults(raw));
  // Refused, never ignored: `wikiCoords` is a setting *of* the reference
  // surface, so asking for coordinates from a run that has no reference
  // surface is a config that cannot mean what it says.
  if (!config.wiki && config.wikiCoords) {
    throw new Error("wikiCoords is a setting of the reference wiki, and this run has none (wiki: false)");
  }
  return config;
}

/** True when this driver's runs can never be read as a score (only `stub`). */
export function isUnscoredDriver(driver: Driver): boolean {
  return driver === "stub";
}

/**
 * The stamp a run gets, or undefined for a run that can score.
 *
 * Two independent reasons a run never scores, and a run can carry both: the
 * driver is the scripted stub, and/or the operator steered the run with an
 * objective. The driver's stamp stays the *prefix* so anything
 * matching on it keeps matching. The harness is *not* a reason: a
 * `claude-code` or `codex` run scores within its own group.
 */
export function unscoredStamp(driver: Driver, objective?: string | undefined): string | undefined {
  const byDriver = driver === "stub" ? STUB_STAMP : undefined;
  const byObjective = objective !== undefined && objective.length > 0 ? OBJECTIVE_STAMP : undefined;
  if (byDriver !== undefined && byObjective !== undefined) return `${byDriver}; ${byObjective}`;
  return byDriver ?? byObjective;
}
