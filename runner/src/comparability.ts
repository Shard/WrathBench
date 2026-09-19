/**
 * The comparability tuple: everything that has to match before two runs may be
 * put on the same chart.
 *
 * docs/METHODOLOGY.md ("What WrathBench measures") says scores are comparable
 * *within a harness version*. In practice the harness version alone is not the
 * whole story — a run also carries an episode budget, a reasoning effort, a
 * harness and possibly an operator objective, and each of those changes what
 * the number means. This module names that tuple once, stamps it into run
 * metadata at launch, and is the only place that decides what belongs in it.
 *
 * Two properties are deliberate:
 *
 * - **Stamped, never recomputed.** The tuple records what *this* build computed
 *   for *this* run. A viewer reading a run whose metadata predates the stamp
 *   reports "not recorded" rather than recomputing a prompt hash against
 *   today's prompt, which would be a fabricated claim of comparability.
 * - **The prompt hash is of the rendered prompt**, the bytes the model actually
 *   saw — including the one sentence of it that is the *harness's* rather than
 *   a constant. Both drivers render through `buildSystemPrompt`, but each
 *   passes its own harness, and `prompt.ts`'s `contextSentence` then states the
 *   context regime that harness actually applies: the fixed loop's trim, or the
 *   claude-code CLI's continuous history. So two runs alike in everything but
 *   the driver hash differently *on purpose* — the tuple already puts them in
 *   two comparability groups (`harness`), and now the prompt hash shows that
 *   the text was not the same text either. `promptChars` gives the difference a
 *   magnitude, and the claude-code driver record logs the same length as
 *   `systemPromptChars` (`adapter-claude.ts`). Within one harness, scored runs
 *   still share one hash and a steered run visibly does not.
 */

import { z } from "zod";
import { moduleAuthHeaders } from "./module-auth";
import { HARNESSES, episodeOverrideOf, harnessOf, type Harness, type RunConfig } from "./config";
import { episodeIdSchema } from "./episodes";
import { buildSystemPrompt } from "./prompt";
import { routingForRun, routingSchema } from "./routing";
import type { WikiBundleMeta } from "./wiki";

/**
 * Harness as the tuple records it: which machinery decided what the model saw
 * each turn. `wrathbench` applies its own context policy (docs/METHODOLOGY.md,
 * "Context policy": event window, hysteretic message window, regenerated
 * per-turn context); `claude-code` is the Claude Code CLI and `codex` the
 * OpenAI Codex CLI, each of which owns its own history and compaction. Three
 * harnesses are three comparability groups; none is a scoring penalty.
 */
export const harnessSchema = z.enum(HARNESSES);

/** How long a run is allowed to be, in every unit the harness can end it by. */
export const episodeBudgetSchema = z.object({
  /** Driver turns. Null = unlimited (a result run). A claude-code turn is not
   * a fixed-loop turn: one of them has held 168 tool calls. */
  maxTurns: z.number().int().positive().nullable(),
  /**
   * Tool calls for the whole episode; enforced at the MCP boundary. Null = no
   * ceiling, which is the policy's `idle: "unlimited"` freeplay lane and
   * nothing else. It is part of the budget, so a run that moved between a
   * ceiling and none restamps rather than staying comparable to itself.
   */
  maxToolCalls: z.number().int().positive().nullable(),
  /** Watchdog thresholds as they will actually be evaluated; null = disabled. */
  idleMs: z.number().int().nonnegative().nullable(),
  noXpMs: z.number().int().nonnegative().nullable(),
  episodeMs: z.number().int().nonnegative().nullable(),
  maxSandboxRestarts: z.number().int().positive(),
});
export type EpisodeBudget = z.infer<typeof episodeBudgetSchema>;

/** The module's own build identity, as `/health` reported it at launch/resume. */
export const serverBuildSchema = z
  .object({
    build: z.string(),
    startedAtMs: z.number(),
  })
  .nullable();
export type ServerBuild = z.infer<typeof serverBuildSchema>;

/**
 * The reference bundle's identity as the tuple annotates it (docs/METHODOLOGY.md,
 * "Episodes, lanes, and evidence"). Every field nullable: this is evidence
 * about the file the run read, and a bundle that cannot describe itself must
 * read as "not recorded" rather than making the whole tuple unparseable.
 */
export const wikiBundleSchema = z
  .object({
    schemaVersion: z.string().nullable(),
    builtAt: z.string().nullable(),
    source: z.string().nullable(),
    eraCutoff: z.string().nullable(),
  })
  .nullable();

export const comparabilitySchema = z.object({
  /** `git describe` of the harness, as `version.ts` resolved it. */
  harnessVersion: z.string(),
  /** `sha256:` + the first 16 hex of the rendered system prompt's digest. */
  promptHash: z.string(),
  /** Length of that prompt, so a hash mismatch has a visible magnitude. */
  promptChars: z.number().int().nonnegative(),
  /** Which loop owned the run. */
  harness: harnessSchema,
  /** Reasoning effort, or null for "the field was never sent". */
  effort: z.string().nullable(),
  budget: episodeBudgetSchema,
  /**
   * Whether an operator objective steered this run. Recorded as a
   * flag, never as the text: the tuple answers "is this comparable", and a run
   * with an objective is unscored whatever the objective said.
   */
  objective: z.boolean(),
  /**
   * Whether the reference surface served wiki coordinates. Absent
   * on tuples stamped before the field existed; those runs are grouped as
   * "unrecorded", never as either side.
   */
  wikiCoords: z.boolean().optional(),
  /**
   * Which reference bundle the run read, off its `meta` table: schema version,
   * build time, dump, and the era cutoff its prose was taken at. An
   * *annotation*, not a grouping key of its own — a bundle whose page text
   * changes is a behaviour change, and behaviour changes are already grouped by
   * the harness series, so a text-changing rebuild is paired with a harness
   * minor bump and this field is the evidence of what that bump was about.
   * Note that `sameComparability` compares every stamped field and so is
   * stricter: a rebuild between launch and resume restamps. Null when there
   * was no bundle; absent on tuples stamped before the field existed.
   */
  wikiBundle: wikiBundleSchema.optional(),
  /**
   * The episode tier the run was launched under (`episodes.ts`), or null for a
   * run assembled flag-by-flag. Absent on tuples stamped before the field
   * existed; a reader may derive a tier for those (viewer/results.ts) but nothing
   * rewrites the stored tuple.
   */
  episode: episodeIdSchema.nullable().optional(),
  /**
   * True when a tier run's effective watchdogs are not its tier's — the run was
   * launched (or resumed) with an explicit threshold on top of `--episode`. It
   * still names its tier, but it must not pass as a clean tier run.
   */
  episodeOverride: z.boolean().optional(),
  /**
   * The worldserver's own build identity, off its `/health` at launch (or
   * resume-restamp) time. Null when the module was unreachable — this must
   * never block a launch, so a failed fetch reads the same as "not recorded"
   * rather than failing the run.
   */
  serverBuild: serverBuildSchema,
  /**
   * Which backend the aggregator was allowed to route this run to, resolved
   * exactly as the request sent it (`routing.ts`). A KEY, not an annotation:
   * routing is stated at launch like `effort`, and two runs of one slug served
   * by two machines — six have served `glm-5.3-flash` here — are two
   * conditions, so they must not share a chart by default. Operator decision
   * 2026-09-16.
   *
   * ABSENT, never null, for a run whose endpoint has no routing to state: a
   * claude-code, codex, Cerebras, LM Studio or OpenCode Zen run has one
   * backend and nothing to record. That also keeps every such run stamping
   * byte-for-byte as it did before the field existed, so nothing already in
   * flight restamps on resume for a fact that did not change.
   */
  routing: routingSchema.optional(),
  /**
   * Present, and `false`, only on a run configured without the reference wiki
   * (`config.wiki`, issue #61). A KEY, not an annotation: the tool is part of
   * the fixed harness, so a run that had it and a run that did not are two
   * conditions and must not share a chart — the same standing `effort` and
   * `routing` have. The rendered prompt differs too, so `promptHash` already
   * separates them; this field is what makes the separation readable.
   *
   * ABSENT, never `true`, for the ordinary run: the wiki is included by
   * default, and leaving the field off keeps every run stamped before it
   * existed byte-for-byte identical to what it stamps now.
   */
  wiki: z.literal(false).optional(),
  /**
   * The model id the provider said it actually served — `claude-sonnet-5` for a
   * run launched as `sonnet`.
   *
   * An **annotation**, in exactly the sense the wiki bundle is one: it answers
   * "which model was this really", which the roster alias cannot, and it is
   * evidence rather than a grouping key. It is also the one field here that is
   * *observed*, not stamped — the CLI resolves the alias at launch and names
   * the result in its `init` event, minutes after the tuple is written — so it
   * is filled in once when first seen and is deliberately excluded from
   * `sameComparability`. Including it would make every resume of an aliased run
   * emit a `comparability_restamped` record saying nothing.
   *
   * Null when nothing named a model; absent on tuples stamped before the field
   * existed, which the viewer back-fills at read time and never rewrites.
   */
  resolvedModel: z.string().nullable().optional(),
});
export type Comparability = z.infer<typeof comparabilitySchema>;

/**
 * Read the worldserver's build identity off its `/health`, for the tuple.
 *
 * Mirrors `runner/viewer/api.ts`'s `worldserverIdentity` read, one layer down:
 * this one is not cached (it runs once per launch or resume, not once per
 * poll) and never throws — an unreachable module, a timeout, or a module that
 * predates the field all read as `null`, and the caller never awaits longer
 * than `timeoutMs`.
 */
export async function fetchServerBuild(moduleUrl: string, timeoutMs = 2_000): Promise<ServerBuild> {
  try {
    const res = await fetch(`${moduleUrl}/health`, { headers: moduleAuthHeaders(), signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const o = (await res.json()) as { build?: unknown; startedAtMs?: unknown };
    if (typeof o.build !== "string" || typeof o.startedAtMs !== "number") return null;
    return { build: o.build, startedAtMs: o.startedAtMs };
  } catch {
    return null;
  }
}

/**
 * The harness *series* of a version stamp: `harness-0.3-114-gda93f0a-dirty`
 * is series `"0.3"`. Commits within a series are fixes and instrumentation;
 * a minor bump is a change to what the run measures. The scheduler keys its
 * targets on the series of the checkout it runs from (a bump restarts the
 * evidence, a fix commit does not), and the results surface groups
 * by it, labelling rows with the exact versions they hold. Null when the
 * stamp has no recognisable major.minor (the unversioned fallback included),
 * so a reader says "no series" rather than inventing one.
 */
export function harnessSeries(version: string | null | undefined): string | null {
  if (version === null || version === undefined) return null;
  let v = version.trim();
  // `version.ts` on a host wraps `git describe` as `0.0.0-phase0+g<describe>`;
  // the container path stamps the describe bare. Both name the same series.
  const wrapped = /^0\.0\.0-phase0\+g(.+)$/.exec(v);
  if (wrapped !== null) v = wrapped[1]!;
  // The runner's own fallback stamps (`0.0.0-phase0...`) name no series.
  if (v.startsWith("0.0.0")) return null;
  const m = /^(?:harness-)?v?(\d+)\.(\d+)(?:[.-]|$)/.exec(v);
  return m === null ? null : `${m[1]}.${m[2]}`;
}

/** `sha256:<16 hex>` of a string. Truncated: this identifies, it does not seal. */
export function promptHash(text: string): string {
  return `sha256:${new Bun.CryptoHasher("sha256").update(text).digest("hex").slice(0, 16)}`;
}

/**
 * The tuple for a run about to start (or resume) under `config`.
 *
 * `serverBuild` is passed in rather than fetched here: this function stays a
 * pure projection of `config`, testable without a network, and the caller
 * (`run.ts`) is the one place that actually has a launch or resume to gate on
 * `fetchServerBuild`'s timeout. Omit it (or pass `null`) for "not recorded".
 * `wikiBundle` arrives the same way, read off the bundle `run.ts` just opened.
 */
export function comparabilityOf(
  config: RunConfig,
  harnessVersion: string,
  serverBuild: ServerBuild = null,
  wikiBundle: WikiBundleMeta | null = null,
): Comparability {
  const harness = harnessOf(config.driver);
  // Rendered for THIS run's harness: the prompt's context sentence differs
  // between them, so the hash below is per-harness by design.
  const prompt = buildSystemPrompt(config.objective, config.episode, harness, config.wiki);
  const routing = routingForRun(config);
  return {
    harnessVersion,
    promptHash: promptHash(prompt),
    promptChars: prompt.length,
    harness,
    effort: config.effort ?? null,
    budget: {
      maxTurns: config.maxTurns ?? null,
      maxToolCalls: config.maxToolCallsPerEpisode,
      idleMs: config.watchdogs.idleMs,
      noXpMs: config.watchdogs.noXpMs,
      episodeMs: config.watchdogs.episodeMs,
      maxSandboxRestarts: config.watchdogs.maxSandboxRestarts,
    },
    objective: config.objective !== undefined,
    wikiCoords: config.wikiCoords,
    wikiBundle,
    episode: config.episode ?? null,
    episodeOverride: episodeOverrideOf(config),
    serverBuild,
    // Last, and conditional: `sameComparability` compares stringified tuples,
    // so a field that appears in the middle for some runs and not others would
    // reorder the rest. Resolved by the same function the adapter is handed.
    ...(routing !== null ? { routing } : {}),
    // After `routing`, for that same stringified-tuple reason: a field inserted
    // ahead of it would reorder the routing of every already-stamped run.
    ...(config.wiki ? {} : { wiki: false as const }),
  };
}

/**
 * Parse a stored tuple. Anything that does not validate reads as "not
 * recorded": run metadata is a long-lived file written by older builds, and a
 * viewer must never turn a shape it does not know into an error the whole
 * listing pays for.
 */
export function parseComparability(raw: unknown): Comparability | null {
  const parsed = comparabilitySchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * The harness a run belongs to, from whatever its metadata recorded: the
 * tuple first, then the driver. Null when neither was written.
 */
export function harnessOfRun(meta: {
  comparability?: { harness?: string } | null;
  driver?: string | null;
}): Harness | null {
  const stamped = meta.comparability?.harness;
  if (stamped !== undefined && (HARNESSES as readonly string[]).includes(stamped)) return stamped as Harness;
  const d = meta.driver;
  if (d === "claude-code") return "claude-code";
  if (d === "codex") return "codex";
  if (d === "openai" || d === "stub") return "wrathbench";
  return null;
}

/**
 * The tuple minus the fields that are observed rather than stamped.
 *
 * `resolvedModel` is filled in mid-episode from what the driver reports, so a
 * launch tuple and the same run's tuple an hour later differ in it by
 * construction. Comparing on it would turn every resume of an aliased run into
 * a restamp, which is noise in a record whose whole job is signal.
 */
function stamped(t: Comparability): Omit<Comparability, "resolvedModel"> {
  const { resolvedModel: _observed, ...rest } = t;
  return rest;
}

/** Whether two tuples describe runs that may share a chart. Order-independent. */
export function sameComparability(a: Comparability, b: Comparability): boolean {
  return JSON.stringify(stamped(a)) === JSON.stringify(stamped(b));
}
