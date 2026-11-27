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
 *   the driver hash differently *on purpose* — the tuple already tags them
 *   with different harnesses (`harness`), and now the prompt hash shows that
 *   the text was not the same text either. `promptChars` gives the difference a
 *   magnitude, and the claude-code driver record logs the same length as
 *   `systemPromptChars` (`adapter-claude.ts`). Within one harness, scored runs
 *   still share one hash and a steered run visibly does not.
 */

import { checkModuleProtocol } from "@wrathbench/sdk";
import { moduleAuthHeaders } from "@wrathbench/mcp/module-auth";
import { episodeOverrideOf, harnessOf, type RunConfig } from "./config";
import { isTaskEpisode } from "./episodes";
import { buildSystemPrompt, programPromptOf, steeringOf } from "./prompt";
import { routingForRun } from "./routing";
import type { SubjectKind } from "./serving";
import type { WikiBundleMeta } from "./wiki";
import { promptHash, type Comparability, type ServerBuild } from "./comparability-tuple";

/*
 * The tuple's shape and its readers (`comparability-tuple.ts`), re-exported
 * so a launch, a resume and a test read the whole tuple from here.
 */
export * from "./comparability-tuple";

/**
 * Read the worldserver's build identity off its `/health`, for the tuple.
 *
 * Mirrors `runner/viewer/api.ts`'s `worldserverIdentity` read, one layer down:
 * this one is not cached (it runs once per launch or resume, not once per
 * poll) — an unreachable module, a timeout, or a module that predates the
 * field all read as `null`, and the caller never awaits longer than
 * `timeoutMs`.
 *
 * It throws in one case only: a module that answered with a wire protocol
 * this build's SDK cannot drive (`ModuleProtocolError`, wrath-mcp/module/PROTOCOL.md,
 * "Versioning"). The launch and the resume both read this before anything is
 * written, so a mismatched pair is refused before the run starts rather than
 * found by the model as a misread event. A module that serves no `protocol`
 * predates the field and passes, as it does on the SDK's own `connect`.
 */
export async function fetchServerBuild(moduleUrl: string, timeoutMs = 2_000): Promise<ServerBuild> {
  let body: { build?: unknown; startedAtMs?: unknown; protocol?: unknown } | undefined;
  try {
    const res = await fetch(`${moduleUrl}/health`, { headers: moduleAuthHeaders(), signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    body = (await res.json()) as typeof body;
  } catch {
    return null;
  }
  if (body === null || typeof body !== "object") return null;
  checkModuleProtocol(body);
  if (typeof body.build !== "string" || typeof body.startedAtMs !== "number") return null;
  return { build: body.build, startedAtMs: body.startedAtMs };
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
  const prompt = buildSystemPrompt(steeringOf(config), config.episode, harness, config.wiki, config.watchdogs.episodeMs, programPromptOf(config));
  const routing = routingForRun(config);
  const subject = subjectOfConfig(config);
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
    // After `wiki`, for the same reason again; absent is the CLI's `auto`.
    ...(config.compactWindow !== undefined ? { compactWindow: config.compactWindow } : {}),
    // After `compactWindow`, for the same reason; absent is the snippet loop.
    ...(config.loop === "program" ? { loop: "program" as const } : {}),
    ...(config.yield === true ? { yield: true as const } : {}),
    // After `yield`, for the same reason; absent on a hosted run.
    ...(config.serving !== undefined ? { serving: config.serving } : {}),
    ...(subject !== "hosted" ? { subject } : {}),
    // Last of all, and only on a task episode: after `subject`, for the same reason.
    ...taskKeysOf(config),
  };
}

/** A task episode's keys (`agents`, `characters`, `task`), off the run's own grant; nothing on any other run. */
function taskKeysOf(config: RunConfig): Pick<Comparability, "agents" | "characters" | "task"> {
  if (!isTaskEpisode(config.episode)) return {};
  const agents = config.party !== undefined ? config.party.size : 1;
  const characters = config.fanout !== undefined ? config.fanout.characters : 1;
  return { agents, characters, ...(config.task !== undefined ? { task: { ...config.task } } : {}) };
}

/**
 * The subject kind of a run about to start: `local` when it states a build,
 * else `hosted`. A local base without one is refused at launch, so stating
 * the build is what makes a run local; a run resumed from before the key
 * existed stamps as it did, and a reader derives its kind from its platform.
 */
export function subjectOfConfig(config: Pick<RunConfig, "serving" | "driver">): SubjectKind {
  if (harnessOf(config.driver) === "external") return "external";
  return config.serving !== undefined ? "local" : "hosted";
}
