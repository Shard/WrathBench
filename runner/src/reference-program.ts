/**
 * The hook the scripted reference program is loaded through.
 *
 * The program — the tick that plays and the route it plays — is a solution
 * to the episode written against this SDK, so it is kept out of the public
 * tree (operator, 2026-10-20; docs/METHODOLOGY.md, "Scoring"). The operator's
 * build puts it at a fixed path inside the runner image,
 * `runner/src/reference/index.ts` (`infra/build-images.sh`), and a launch
 * imports it from there. That directory is gitignored, so a copy laid into a
 * checkout to test it is never committed.
 *
 * In any build without it — a public clone, a quickstart image, a local build
 * made with `--without-reference` — a `--driver reference` run is refused at
 * launch, before anything is written, with a plain message saying so. There is
 * no fallback program.
 *
 * What the program must export is `program: ReferenceProgram`: the route as
 * data (sent to the sandbox as JSON) and the tick as source text (sent as the
 * snippet's own code; `reference-adapter.ts`). The route's id, version and
 * start are all the harness reads of it.
 */

import { join } from "node:path";
import type { RunConfig } from "./config";

/** Where the program sits in a build that carries it: the runner image's `runner/src/reference/`. */
export const REFERENCE_PROGRAM_DIR = join(import.meta.dir, "reference");
export const REFERENCE_PROGRAM_PATH = join(REFERENCE_PROGRAM_DIR, "index.ts");

/**
 * Test seam only: a launch reads the program from this path instead of the
 * fixed one, so a fixture can stand in for it or a test can prove the absent
 * path. Nothing in the fleet or the chart sets it.
 */
export const REFERENCE_PROGRAM_ENV = "WRATHBENCH_REFERENCE_PROGRAM";

/** What the harness reads of a route; the rest of it is the program's own business. */
export interface ReferenceRoute {
  readonly id: string;
  readonly version: number;
  /** The start the route is written for; a launch refuses any other. */
  readonly race: number;
  readonly class: number;
  /** One per tick target; the last one never finishes. */
  readonly steps: readonly { readonly kind: string }[];
}

export interface ReferenceProgram {
  readonly route: ReferenceRoute;
  /**
   * The tick, as the source text of an async function `(env, route, args) =>
   * TickReport` (`reference-adapter.ts`). It is evaluated in the sandbox, so
   * it may use only its arguments and JavaScript built-ins.
   */
  readonly source: string;
}

export type ReferenceLoad = { ok: true; program: ReferenceProgram } | { ok: false; reason: string };

/** The `model` a reference run carries: the route's id and version, so each route is its own line. */
export function referenceModelId(route: Pick<ReferenceRoute, "id" | "version">): string {
  return `reference/${route.id}@${route.version}`;
}

/** The path a launch reads the program from: the fixed one, unless the test seam names another. */
export function referenceProgramPath(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const override = env[REFERENCE_PROGRAM_ENV];
  return override !== undefined && override !== "" ? override : REFERENCE_PROGRAM_PATH;
}

const ABSENT =
  "the scripted reference program is not in this build: it is kept out of the public repository and built into the operator's runner image " +
  "(docs/RUNBOOK.md, \"The scripted reference run\"), so --driver reference cannot run here";

/** Why an export is not a program, or null when it is one. */
function shapeRefusal(p: unknown): string | null {
  if (typeof p !== "object" || p === null) return "it exports no `program` object";
  const { route, source } = p as { route?: unknown; source?: unknown };
  if (typeof source !== "string" || source.trim() === "") return "`program.source` is not the tick's source text";
  if (typeof route !== "object" || route === null) return "`program.route` is not an object";
  const r = route as Record<string, unknown>;
  if (typeof r["id"] !== "string" || r["id"] === "") return "`program.route.id` is not a name";
  for (const k of ["version", "race", "class"] as const) {
    if (!Number.isInteger(r[k])) return `\`program.route.${k}\` is not an integer`;
  }
  const steps = r["steps"];
  if (!Array.isArray(steps) || steps.length === 0) return "`program.route.steps` is not a non-empty list";
  if (!steps.every((s) => typeof s === "object" && s !== null && typeof (s as { kind?: unknown }).kind === "string")) {
    return "a `program.route.steps` entry has no `kind`";
  }
  return null;
}

/**
 * Import the program by dynamic import. Absent is an answer, not an error: the
 * reason is the message the launch prints. A module that is there but is not
 * a program is refused by what is wrong with it.
 */
export async function loadReferenceProgram(path: string = REFERENCE_PROGRAM_PATH): Promise<ReferenceLoad> {
  if (!(await Bun.file(path).exists())) return { ok: false, reason: `${ABSENT} (no ${path})` };
  let mod: { program?: unknown };
  try {
    mod = (await import(path)) as { program?: unknown };
  } catch (err) {
    return { ok: false, reason: `the scripted reference program at ${path} failed to load: ${err instanceof Error ? err.message : String(err)}` };
  }
  const why = shapeRefusal(mod.program);
  if (why !== null) return { ok: false, reason: `the module at ${path} is not a reference program: ${why}` };
  return { ok: true, program: mod.program as ReferenceProgram };
}

/**
 * Why this config cannot play this program, or null when it can. The
 * route-independent refusals (an objective, a continuation, a campaign) are
 * `loadRunConfig`'s; these need the route.
 */
export function referenceConfigRefusal(config: Pick<RunConfig, "race" | "class" | "model">, route: ReferenceRoute): string | null {
  if (config.race !== route.race || config.class !== route.class) {
    return `the reference route ${route.id}@${route.version} is written for race ${route.race}, class ${route.class}; this run asked for race ${config.race}, class ${config.class}`;
  }
  const model = referenceModelId(route);
  if (config.model !== undefined && config.model !== model) {
    return `the reference driver's model is its route, ${model}; --model ${config.model} cannot apply to it`;
  }
  return null;
}

export type ReferenceLaunch<C> = { ok: true; config: C; program: ReferenceProgram } | { ok: false; reason: string };

/**
 * A reference launch, fresh or resumed: load the program, check the start and
 * the model against its route, and name the model. `run.ts` refuses the
 * launch on `ok: false` before the run directory exists.
 */
export async function resolveReferenceLaunch<C extends Pick<RunConfig, "race" | "class" | "model">>(
  config: C,
  path: string = REFERENCE_PROGRAM_PATH,
): Promise<ReferenceLaunch<C>> {
  const load = await loadReferenceProgram(path);
  if (!load.ok) return load;
  const refusal = referenceConfigRefusal(config, load.program.route);
  if (refusal !== null) return { ok: false, reason: refusal };
  return { ok: true, config: { ...config, model: referenceModelId(load.program.route) }, program: load.program };
}
