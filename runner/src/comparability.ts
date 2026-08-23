/**
 * The comparability tuple: everything that has to match before two runs may be
 * put on the same chart.
 *
 * ADR-0004 says scores are comparable *within a harness version*. In practice
 * the harness version alone is not the whole story — a run also carries an
 * episode budget, a reasoning effort, a harness and possibly an operator
 * objective (ADR-0033), and each of those changes what the number means. This
 * module names that tuple once, stamps it into run metadata at launch, and is
 * the only place that decides what belongs in it.
 *
 * Two properties are deliberate:
 *
 * - **Stamped, never recomputed.** The tuple records what *this* build computed
 *   for *this* run. A viewer reading a run whose metadata predates the stamp
 *   reports "not recorded" rather than recomputing a prompt hash against
 *   today's prompt, which would be a fabricated claim of comparability.
 * - **The prompt hash is of the rendered prompt**, the bytes the model actually
 *   saw. With no objective it equals the fixed prompt's hash by construction
 *   (ADR-0024 point 2: both drivers render through `buildSystemPrompt`), so
 *   scored runs share one hash and a steered run visibly does not.
 */

import { z } from "zod";
import { HARNESSES, LEGACY_SCAFFOLD_STAMP, episodeOverrideOf, harnessOf, type Harness, type RunConfig } from "./config";
import { episodeIdSchema } from "./episodes";
import { buildSystemPrompt } from "./prompt";

/**
 * Harness as the tuple records it (ADR-0035): which machinery decided what the
 * model saw each turn. `wrathbench` applies ADR-0012 (event window, hysteretic
 * message window, regenerated per-turn context); `claude-code` is the Claude
 * Code CLI, which owns its own history and compaction. Two harnesses are two
 * comparability groups; neither is a scoring penalty.
 *
 * Tuples stamped before ADR-0035 carry `contextEngine` instead, with the
 * values below. The reader maps them to a harness and never rewrites the file.
 */
export const LEGACY_CONTEXT_ENGINES: Readonly<Record<string, Harness>> = {
  "harness-fixed-window": "wrathbench",
  "external-scaffold-claude-cli": "claude-code",
};

export const harnessSchema = z.enum(HARNESSES);

/** How long a run is allowed to be, in every unit the harness can end it by. */
export const episodeBudgetSchema = z.object({
  /** Driver turns. Null = unlimited (a result run). A claude-code turn is not
   * a fixed-loop turn: one of them has held 168 tool calls. */
  maxTurns: z.number().int().positive().nullable(),
  /** Tool calls for the whole episode; enforced at the MCP boundary. */
  maxToolCalls: z.number().int().positive(),
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

export const comparabilitySchema = z.object({
  /** `git describe` of the harness, as `version.ts` resolved it. */
  harnessVersion: z.string(),
  /** `sha256:` + the first 16 hex of the rendered system prompt's digest. */
  promptHash: z.string(),
  /** Length of that prompt, so a hash mismatch has a visible magnitude. */
  promptChars: z.number().int().nonnegative(),
  /** Which loop owned the run (ADR-0035). Old tuples' `contextEngine` maps here on read. */
  harness: harnessSchema,
  /** Reasoning effort, or null for "the field was never sent". */
  effort: z.string().nullable(),
  budget: episodeBudgetSchema,
  /**
   * Whether an operator objective steered this run (ADR-0024). Recorded as a
   * flag, never as the text: the tuple answers "is this comparable", and a run
   * with an objective is unscored whatever the objective said.
   */
  objective: z.boolean(),
  /**
   * Whether the reference surface served wiki coordinates (ADR-0028). Absent
   * on tuples stamped before the field existed; those runs are grouped as
   * "unrecorded", never as either side.
   */
  wikiCoords: z.boolean().optional(),
  /**
   * The episode tier the run was launched under (`episodes.ts`), or null for a
   * run assembled flag-by-flag. Absent on tuples stamped before the field
   * existed; a reader may derive a tier for those (viewer/eval.ts) but nothing
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
    const res = await fetch(`${moduleUrl}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const o = (await res.json()) as { build?: unknown; startedAtMs?: unknown };
    if (typeof o.build !== "string" || typeof o.startedAtMs !== "number") return null;
    return { build: o.build, startedAtMs: o.startedAtMs };
  } catch {
    return null;
  }
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
 */
export function comparabilityOf(
  config: RunConfig,
  harnessVersion: string,
  serverBuild: ServerBuild = null,
): Comparability {
  const prompt = buildSystemPrompt(config.objective);
  return {
    harnessVersion,
    promptHash: promptHash(prompt),
    promptChars: prompt.length,
    harness: harnessOf(config.driver),
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
    episode: config.episode ?? null,
    episodeOverride: episodeOverrideOf(config),
    serverBuild,
  };
}

/**
 * Parse a stored tuple. Anything that does not validate reads as "not
 * recorded": run metadata is a long-lived file written by older builds, and a
 * viewer must never turn a shape it does not know into an error the whole
 * listing pays for.
 */
export function parseComparability(raw: unknown): Comparability | null {
  const parsed = comparabilitySchema.safeParse(withHarness(raw));
  return parsed.success ? parsed.data : null;
}

/**
 * Map a pre-ADR-0035 tuple's `contextEngine` onto `harness`, in memory only.
 * A tuple that already names a harness is returned as is; one that names an
 * unknown engine is left alone and fails validation as "not recorded".
 */
function withHarness(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  const o = raw as Record<string, unknown>;
  if (o["harness"] !== undefined) return o;
  const engine = o["contextEngine"];
  if (typeof engine !== "string") return o;
  const harness = LEGACY_CONTEXT_ENGINES[engine];
  if (harness === undefined) return o;
  const { contextEngine: _dropped, ...rest } = o;
  return { ...rest, harness };
}

/**
 * The harness a run belongs to, from whatever its metadata recorded: the
 * tuple first, then a pre-ADR-0035 scaffold stamp, then the driver. Null when
 * none of those was written. Readers use this so a run launched before the
 * tuple existed still lands in the right group instead of in neither.
 */
export function harnessOfRun(meta: {
  comparability?: { harness?: string } | null;
  driver?: string | null;
  shakeout?: string | null;
}): Harness | null {
  const stamped = meta.comparability?.harness;
  if (stamped !== undefined && (HARNESSES as readonly string[]).includes(stamped)) return stamped as Harness;
  if (meta.shakeout !== null && meta.shakeout !== undefined && meta.shakeout.startsWith(LEGACY_SCAFFOLD_STAMP)) {
    return "claude-code";
  }
  const d = meta.driver;
  if (d === "claude-code" || d === "claude-subscription") return "claude-code";
  if (d === "openai" || d === "stub") return "wrathbench";
  return null;
}

/** Whether two tuples describe runs that may share a chart. Order-independent. */
export function sameComparability(a: Comparability, b: Comparability): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
