/**
 * The comparability tuple: everything that has to match before two runs may be
 * put on the same chart.
 *
 * ADR-0004 says scores are comparable *within a harness version*. In practice
 * the harness version alone is not the whole story — a run also carries an
 * episode budget, a reasoning effort, a context engine and possibly an operator
 * objective (ADR-0024), and each of those changes what the number means. This
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
import type { RunConfig } from "./config";
import { buildSystemPrompt } from "./prompt";

/**
 * Which machinery decided what the model saw each turn.
 *
 * The fixed loop applies ADR-0012 (event window, hysteretic message window,
 * regenerated per-turn context). The claude-subscription driver does not: the
 * CLI owns its own history and its own compaction, which is the reason those
 * runs are shakeout-only. FOLLOW-UPS 8b's labelled context engine lands here
 * when there is more than one of them.
 */
export const CONTEXT_ENGINES = {
  openai: "harness-fixed-window",
  stub: "harness-fixed-window",
  "claude-subscription": "external-scaffold-claude-cli",
} as const;

/** How long a run is allowed to be, in every unit the harness can end it by. */
export const episodeBudgetSchema = z.object({
  /** Driver turns. Null = unlimited (a result run). The claude driver's turns
   * are not the fixed loop's: one of its turns has held 168 tool calls. */
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

export const comparabilitySchema = z.object({
  /** `git describe` of the harness, as `version.ts` resolved it. */
  harnessVersion: z.string(),
  /** `sha256:` + the first 16 hex of the rendered system prompt's digest. */
  promptHash: z.string(),
  /** Length of that prompt, so a hash mismatch has a visible magnitude. */
  promptChars: z.number().int().nonnegative(),
  /** Which context machinery drove the run; see `CONTEXT_ENGINES`. */
  contextEngine: z.string(),
  /** Reasoning effort, or null for "the field was never sent". */
  effort: z.string().nullable(),
  budget: episodeBudgetSchema,
  /**
   * Whether an operator objective steered this run (ADR-0024). Recorded as a
   * flag, never as the text: the tuple answers "is this comparable", and a run
   * with an objective is unscored whatever the objective said.
   */
  objective: z.boolean(),
});
export type Comparability = z.infer<typeof comparabilitySchema>;

/** `sha256:<16 hex>` of a string. Truncated: this identifies, it does not seal. */
export function promptHash(text: string): string {
  return `sha256:${new Bun.CryptoHasher("sha256").update(text).digest("hex").slice(0, 16)}`;
}

/** The tuple for a run about to start (or resume) under `config`. */
export function comparabilityOf(config: RunConfig, harnessVersion: string): Comparability {
  const prompt = buildSystemPrompt(config.objective);
  return {
    harnessVersion,
    promptHash: promptHash(prompt),
    promptChars: prompt.length,
    contextEngine: CONTEXT_ENGINES[config.driver] ?? config.driver,
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

/** Whether two tuples describe runs that may share a chart. Order-independent. */
export function sameComparability(a: Comparability, b: Comparability): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
