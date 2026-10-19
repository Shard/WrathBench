/**
 * The runner's command line: every flag `run.ts` reads, and the parser that
 * refuses every flag it does not.
 *
 * The parser used to skip what it did not know, which was harmless while
 * every argv came from code in this repository. A probe campaign's arm carries
 * argv of its own (`runner/campaigns/*.json`, `arms[].args`), written by hand
 * and appended after the supervisor's, and a typo there would have run the
 * base harness under the arm's name with nothing on the run to say so. So an
 * unknown flag fails the launch (exit 2) before anything is written.
 *
 * Every argv builder in the repository is run through this parser by
 * `infra/run-argv.test.ts`: the roster's `episodeArgv` for each lane,
 * both `infra/run-episode.sh` launch paths, and the hand probe launch. A flag
 * a builder emits that is not listed here would turn that lane into
 * launch-failed on the first tick after a release.
 *
 * Its own module so the campaign schema can check an arm's args against the
 * same lists without importing the runner's entry point.
 */

/**
 * Every flag `run.ts` accepts, fresh launch and resume alike. `adapter` is
 * listed only so the former spelling of `--driver` reaches its own refusal
 * by name rather than this generic one.
 */
export const RUN_FLAGS = [
  "account",
  "adapter",
  "allow-character-delete",
  "api-base",
  "api-key-env",
  "billing",
  "campaign-file",
  "character",
  "class",
  "compact-window",
  "continue-dropped",
  "continue-dropped-reason",
  "continue-from",
  "driver",
  "effort",
  "episode",
  "episode-ms",
  "extra",
  "idle-ms",
  "keep-characters",
  "max-tool-calls",
  "max-turns",
  "model",
  "module-url",
  "no-xp-ms",
  "objective",
  "race",
  "ref",
  "resume",
  "routing-json",
  "run-id",
  "runs-dir",
  "snippet-timeout-ms",
  "state-interval-ms",
  "step-interval-ms",
  "stub",
  "token",
  "token-env",
  "watchdogs-json",
  "wiki",
  "wiki-bundle",
  "wiki-coords",
] as const;
export type RunFlag = (typeof RUN_FLAGS)[number];

/** The flags that set part of a run's shape, which a probe takes from its campaign file instead. */
export const PROBE_SHAPE_FLAGS = [
  "objective",
  "race",
  "class",
  "wiki-coords",
  "wiki",
  "max-tool-calls",
  "idle-ms",
  "no-xp-ms",
  "episode-ms",
  "watchdogs-json",
] as const satisfies readonly RunFlag[];

/**
 * Every flag the fleet's roster can put on a run's argv (`episodeArgv` in
 * `infra/run-roster.ts`, every lane and the resume). An arm's args come after
 * these, so an arm that restated one would either fight the supervisor for
 * the run's identity or silently win it; publishing refuses that.
 * `run-argv.test.ts` asserts this list is exactly what the builder emits.
 */
export const SUPERVISOR_FLAGS = [
  "account",
  "api-base",
  "api-key-env",
  "billing",
  "campaign-file",
  "character",
  "class",
  "compact-window",
  "continue-dropped",
  "continue-dropped-reason",
  "continue-from",
  "driver",
  "effort",
  "episode",
  "episode-ms",
  "extra",
  "keep-characters",
  "max-tool-calls",
  "model",
  "objective",
  "race",
  "ref",
  "resume",
  "routing-json",
  "run-id",
  "token-env",
  "watchdogs-json",
  "wiki",
  "wiki-coords",
] as const satisfies readonly RunFlag[];

/**
 * Flags an arm may not carry although the supervisor never emits them: where
 * the run is written, which session it holds and which server it plays on are
 * the fleet's, and the character-delete escape hatch is an operator's choice
 * on a hand launch only.
 */
export const LAUNCH_INPUT_FLAGS = ["runs-dir", "token", "module-url", "allow-character-delete", "adapter", "stub"] as const satisfies readonly RunFlag[];

/**
 * Supervisor flags an arm may set anyway, because varying them is what an arm
 * is for. The compaction window (operator, 2026-10-11): an arm sets it only
 * for an assignment whose roster entry does not, which the planner checks
 * before any launch (`campaignPairRefusals`), so the run never gets it twice.
 */
export const ARM_SETTABLE_FLAGS = ["compact-window"] as const satisfies readonly RunFlag[];

/** Every flag an arm's `args` may not name. */
export const ARM_RESERVED_FLAGS: readonly string[] = [...new Set<string>([...PROBE_SHAPE_FLAGS, ...SUPERVISOR_FLAGS, ...LAUNCH_INPUT_FLAGS])].filter(
  (f) => !(ARM_SETTABLE_FLAGS as readonly string[]).includes(f),
);

/** A command line the parser refuses. The message is the operator's whole notice. */
export class RunArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunArgsError";
  }
}

/**
 * `--flag value` and bare `--flag` into a map, refusing a flag not in
 * `RUN_FLAGS`, a flag given twice, and a word that is no flag's value. A value
 * may not start with `--`: the next such token is always the next flag, which
 * is why a boolean is written `--wiki-coords true` by every builder. A flag
 * given twice is refused rather than last-wins, because an arm's args come
 * after the supervisor's and a silent win either way would run something
 * nobody wrote down.
 */
export function parseRunArgs(argv: readonly string[], known: readonly string[] = RUN_FLAGS): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  const unknown: string[] = [];
  const stray: string[] = [];
  const twice: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--") || arg.length === 2) {
      stray.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (!known.includes(key)) unknown.push(arg);
    else if (key in out && !twice.includes(arg)) twice.push(arg);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  if (unknown.length > 0) {
    throw new RunArgsError(
      `unknown flag${unknown.length === 1 ? "" : "s"} ${unknown.join(", ")} — run.ts refuses what it does not read, so a typo cannot launch a run that ignores it`,
    );
  }
  if (twice.length > 0) {
    throw new RunArgsError(`${twice.join(", ")} given more than once — each flag is said once, so no argv can override another silently`);
  }
  if (stray.length > 0) {
    throw new RunArgsError(`${stray.map((s) => JSON.stringify(s)).join(", ")} ${stray.length === 1 ? "is" : "are"} not a flag or a flag's value`);
  }
  return out;
}

/** The flag names in an argv, in order: `--a 1 --b` → `["a", "b"]`. */
export function flagsOf(argv: readonly string[]): string[] {
  return argv.filter((a) => a.startsWith("--") && a.length > 2).map((a) => a.slice(2));
}
