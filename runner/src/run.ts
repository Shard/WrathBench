#!/usr/bin/env bun
/**
 * Run entry point.
 *
 *   bun runner/src/run.ts --driver openai --model <id> [--api-base URL] [--effort low] [flags]
 *   bun runner/src/run.ts --driver stub --stub <script.json> [flags]
 *   bun runner/src/run.ts --driver claude-code --model opus  [claude-code harness]
 *   bun runner/src/run.ts --driver claude-code --model opus --token-env CLAUDE_CODE_OAUTH_TOKEN_2
 *   bun runner/src/run.ts --driver codex --model gpt-6-astra --effort high  [codex harness; lane $CODEX_HOME]
 *   bun runner/src/run.ts --driver codex --model gpt-5.5 --token-env CODEX_HOME_2
 *   bun runner/src/run.ts --resume <run-id>
 *
 * Two run dimensions are recorded and never model-specific:
 * `--objective "<text>"` renders one delimited operator objective into the
 * fixed prompt and stamps the run unscored, and `--watchdogs-json '{...}'`
 * (or the individual `--idle-ms`/`--no-xp-ms`/`--episode-ms` flags) overrides
 * watchdog thresholds, where `null`/`0` disables one. A third, `--wiki-coords`,
 * serves wiki-recorded coordinates through `search_reference`;
 * the default is names-first, and the choice is stamped into the
 * comparability tuple so the two never share a chart.
 *
 * `--episode <e90|e360|probing|freeplay>` names an episode tier (`episodes.ts`): the
 * wall clock and both watchdogs come from that one flag, and the id is stamped
 * into the comparability tuple. An explicit `--idle-ms`/`--no-xp-ms`/
 * `--episode-ms`/`--watchdogs-json` on top of it still wins, and the run is
 * then stamped `episodeOverride: true` so it cannot pass as a clean tier run.
 *
 * Flags map 1:1 onto config.ts. A resumed run reloads its config from
 * meta.json, keeps its token (so a still-alive module session is reattached by
 * the model's next createSession call), keeps its scratchpad and trajectory,
 * and starts the message window empty with a harness notice saying so — the
 * scratchpad, not the chat history, is the durable memory.
 */

import { copyFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openRunDb } from "./rundb";
import { archiveIfNoResponses } from "./archive";
import { ARCHIVE_DIR } from "../viewer/archive-dir";
import { clearAccountCharacters } from "./hygiene";
import { leaseSessionSecret, releaseSessionSecret } from "./module-auth";
import { comparabilityOf, fetchServerBuild, sameComparability } from "./comparability";
import { EPISODES, EPISODE_IDS, isEpisodeId } from "./episodes";
import { openWikiBundle, wikiBundleMeta } from "./wiki";
import { OpenAiChatAdapter, StubAdapter, type ChatAdapter } from "./adapter";
import { runClaudeEpisode } from "./adapter-claude";
import { codexEffortRefusal, laneLooksLoggedIn, runCodexEpisode } from "./adapter-codex";
import {
  DEFAULT_CLAUDE_TOKEN_ENV,
  DEFAULT_CODEX_HOME_ENV,
  DRIVERS,
  episodeOverrideOf,
  isTokenEnvName,
  loadRunConfig,
  MIN_TOKEN_LENGTH,
  newRunId,
  newSessionToken,
  resolveSessionToken,
  unscoredStamp,
  watchdogOverrideSchema,
  type RunConfig,
  type WatchdogOverride,
} from "./config";
import { runLoop, type StopRequest } from "./loop";
import { continuedSessionNote, freshCharacterNote, resumeSessionNote } from "./prompt";
import { SandboxHost } from "./sandbox/host";
import { EpisodicLog } from "./episodic";
import { Scratchpad } from "./scratchpad";
import { Trajectory, readMeta, type PauseMark, type RunMeta } from "./trajectory";
import { harnessVersion } from "./version";
import { Watchdogs } from "./watchdogs";
import { className, raceName } from "../viewer/characters";

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

/**
 * A boolean flag: bare `--wiki-coords` or `--wiki-coords true|1|yes` is on,
 * `--wiki-coords false|0|no` is off, absent is undefined (the zod default).
 */
function flag(v: string | boolean | undefined): boolean | undefined {
  if (v === undefined) return undefined;
  if (typeof v === "boolean") return v;
  const t = v.trim().toLowerCase();
  if (t === "true" || t === "1" || t === "yes") return true;
  if (t === "false" || t === "0" || t === "no") return false;
  return undefined;
}

function num(v: string | boolean | undefined): number | undefined {
  return typeof v === "string" ? Number(v) : undefined;
}

/**
 * `--max-tool-calls`, where `0` means no ceiling at all.
 *
 * Argv cannot carry null, so 0 is the transport spelling — the same trick
 * `--no-xp-ms 0` already uses for a disabled watchdog — and it is normalised
 * the moment it is read. Nothing past this function ever sees the sentinel:
 * the config, meta.json, the comparability tuple and the API all hold `null`,
 * so "disabled" reads the same everywhere it is stored or compared. Undefined
 * (the flag absent) is left alone, which is what lets the stored config stand
 * on a resume and the 500 default stand on a launch.
 */
function toolCallCap(v: string | boolean | undefined): number | null | undefined {
  const n = num(v);
  if (n === undefined) return undefined;
  return n === 0 ? null : n;
}

/**
 * `--watchdogs-json '{"noXpMs":null,"idleMs":1200000}'` — the whole override
 * object in one flag. The individual `--idle-ms`/`--no-xp-ms`/`--episode-ms`
 * flags still work and are applied first; this one wins where they overlap,
 * because it is the only spelling that can carry `null` (disable) through
 * argv, and the roster emits it for exactly that reason.
 */
function watchdogOverrides(v: string | boolean | undefined): WatchdogOverride {
  if (typeof v !== "string") return {};
  let raw: unknown;
  try {
    raw = JSON.parse(v);
  } catch {
    console.error(`--watchdogs-json is not valid JSON: ${v}`);
    process.exit(2);
  }
  const parsed = watchdogOverrideSchema.safeParse(raw);
  if (!parsed.success) {
    console.error(`--watchdogs-json rejected: ${parsed.error.message}`);
    process.exit(2);
  }
  return parsed.data;
}

/**
 * A fresh run's config, assembled from raw argv.
 *
 * Exported (and taking argv rather than a parsed object) so the whole seam —
 * `parseArgs`, the per-flag plumbing, `--watchdogs-json`, and the zod defaults
 * — is testable as one unit. A dropped flag here is invisible until a run ends
 * hours early for the wrong reason, which is exactly what the roster's
 * generated argv must be pinned against.
 */
export function configFromArgs(argv: string[]): RunConfig & { runId: string; token: string } {
  const args = parseArgs(argv);
  const runId = typeof args["run-id"] === "string" ? args["run-id"] : newRunId();
  const c = loadRunConfig({
    runId,
    moduleUrl:
      typeof args["module-url"] === "string"
        ? args["module-url"]
        : process.env["WRATHBENCH_MODULE_URL"] ?? undefined,
    token: typeof args["token"] === "string" ? args["token"] : newSessionToken(),
    account: typeof args["account"] === "string" ? args["account"] : undefined,
    race: num(args["race"]),
    class: num(args["class"]),
    episode: typeof args["episode"] === "string" ? args["episode"] : undefined,
    driver: typeof args["driver"] === "string" ? args["driver"] : undefined,
    model: typeof args["model"] === "string" ? args["model"] : undefined,
    apiBase:
      typeof args["api-base"] === "string"
        ? args["api-base"]
        : process.env["OPENAI_BASE_URL"] ?? undefined,
    apiKeyEnv: typeof args["api-key-env"] === "string" ? args["api-key-env"] : undefined,
    // The subscription lane, by env var NAME (claude-code and codex). Identity, like
    // the account: a resumed run bills the subscription it started on, so
    // --token-env is not an override on --resume.
    subscription: typeof args["token-env"] === "string" ? args["token-env"] : undefined,
    // Identity, like model and driver: a resumed run keeps the effort it was
    // launched with, so --effort is not an override on --resume.
    effort: typeof args["effort"] === "string" ? args["effort"] : undefined,
    // Identity, like model and effort: an objective steers what the whole
    // run was for, so a resumed run keeps the one it was launched with.
    objective: typeof args["objective"] === "string" ? args["objective"] : undefined,
    // Identity too: what the reference surface served is part of
    // what the run was, so a resume keeps the stored value.
    wikiCoords: flag(args["wiki-coords"]),
    // Identity as well: a resumed extra is still an extra.
    extra: flag(args["extra"]),
    // A probe campaign's identity, both or neither.
    campaign: typeof args["campaign"] === "string" ? args["campaign"] : undefined,
    cell: typeof args["cell"] === "string" ? args["cell"] : undefined,
    // A freeplay continuation: the run id whose character and scratchpad this
    // launch carries on. Validated against the predecessor in `main`.
    continuedFrom: typeof args["continue-from"] === "string" ? args["continue-from"] : undefined,
    stubScript: typeof args["stub"] === "string" ? args["stub"] : undefined,
    maxTurns: num(args["max-turns"]),
    maxToolCallsPerEpisode: toolCallCap(args["max-tool-calls"]),
    stepIntervalMs: num(args["step-interval-ms"]),
    stateIntervalMs: num(args["state-interval-ms"]),
    snippetTimeoutMs: num(args["snippet-timeout-ms"]),
    runsDir: typeof args["runs-dir"] === "string" ? args["runs-dir"] : undefined,
    wikiBundle: typeof args["wiki-bundle"] === "string" ? args["wiki-bundle"] : undefined,
    watchdogs: {
      ...(num(args["idle-ms"]) !== undefined ? { idleMs: num(args["idle-ms"]) } : {}),
      ...(num(args["no-xp-ms"]) !== undefined ? { noXpMs: num(args["no-xp-ms"]) } : {}),
      ...(num(args["episode-ms"]) !== undefined ? { episodeMs: num(args["episode-ms"]) } : {}),
      ...watchdogOverrides(args["watchdogs-json"]),
    },
  });
  return { ...c, runId: c.runId ?? runId, token: c.token ?? newSessionToken() };
}

/** What a continuation takes from its predecessor: the character's identity. */
export interface Continuation {
  from: string;
  character: string;
  race: number;
  class: number;
  /** The predecessor's run directory. */
  dir: string;
}

/**
 * `--continue-from <run-id>`: a freeplay stream coming back under a new run id
 * on its predecessor's character. Everything that would make the lineage a
 * lie is refused here, before a directory exists: the launch must be
 * `freeplay` (a scored episode is a fresh character by definition), the
 * predecessor must be a freeplay run on the SAME account (a character
 * lives on one account; a continuation elsewhere would find nothing), and
 * must have recorded a character at all. Race and class are the
 * predecessor's — they are the character's, not the launch's.
 *
 * A predecessor that has been ARCHIVED is read from `<runs>/archive/<id>`:
 * archiving parks a run so the listings stop counting it, and says nothing
 * about whether its character is still standing on the account. The stream
 * election reads archived facts too (`streamsFrom`, `includeArchived`), so
 * refusing here would break exactly the continuation the archive was meant
 * to leave alone.
 *
 * A predecessor found in NEITHER place returns null rather than throwing: the
 * run degrades to a fresh start and says so (`continue-dropped`), the same
 * answer as a character that turned out to be gone. A missing directory is
 * not a lie about lineage, it is an absent one, and killing a launch over it
 * costs the night's run.
 */
export function loadContinuation(
  config: Pick<RunConfig, "episode" | "account" | "runsDir" | "continuedFrom">,
): Continuation | null {
  const from = config.continuedFrom;
  if (from === undefined) throw new Error("no --continue-from");
  if (config.episode !== "freeplay") {
    throw new Error(`--continue-from is a freeplay continuation; --episode ${config.episode ?? "(none)"} starts a fresh character`);
  }
  const live = join(config.runsDir, from);
  const archived = join(config.runsDir, ARCHIVE_DIR, from);
  const dir = readMeta(live) !== null ? live : archived;
  const meta = readMeta(dir);
  if (meta === null) return null;
  const episode = meta.comparability?.episode ?? meta.config.episode;
  if (episode !== "freeplay") throw new Error(`--continue-from ${from}: that run is ${String(episode ?? "no episode")}, not freeplay`);
  const account = meta.config.account;
  if (account.toUpperCase() !== config.account.toUpperCase()) {
    throw new Error(`--continue-from ${from}: that run was on ${account}, this launch is on ${config.account} — a character lives on one account`);
  }
  if (meta.config.character === undefined) throw new Error(`--continue-from ${from}: that run never recorded a character`);
  return { from, character: meta.config.character, race: meta.config.race, class: meta.config.class, dir };
}

/** The predecessor's last recorded level/xp, read-only; null when there is none. */
function lastStateIn(dir: string, runId: string): { level?: number; xp?: number } | null {
  const path = join(dir, "run.sqlite");
  if (!existsSync(path)) return null;
  let db: Database | null = null;
  try {
    db = openRunDb(path, { readonly: true });
    const r = db.query(`SELECT level, xp FROM state WHERE run_id = ? ORDER BY ts DESC LIMIT 1`).get(runId) as
      | { level?: unknown; xp?: unknown }
      | null;
    if (r === null) return null;
    return {
      ...(typeof r.level === "number" ? { level: r.level } : {}),
      ...(typeof r.xp === "number" ? { xp: r.xp } : {}),
    };
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

async function main(): Promise<void> {
  const rawArgs = Bun.argv.slice(2);
  const args = parseArgs(rawArgs);
  const resumeId = typeof args["resume"] === "string" ? args["resume"] : undefined;
  /**
   * `--keep-characters a,b`: names on this account that belong to another
   * ref's freeplay stream and must survive this launch's hygiene. A launch
   * input, not identity — nothing about this run is different for it except
   * that those names are taken.
   */
  const keepCharacters =
    typeof args["keep-characters"] === "string"
      ? args["keep-characters"].split(",").map((n) => n.trim()).filter((n) => n.length > 0)
      : [];
  /**
   * `--continue-dropped <run-id> --continue-dropped-reason <why>`: the stream
   * head the supervisor chose NOT to continue (its account is occupied by
   * another ref's stream), so this launch is a fresh start by decision. A
   * launch input for the record only — the run carries no lineage, exactly as
   * a `continue-dropped` that the runner itself decides.
   */
  const droppedHead = typeof args["continue-dropped"] === "string" ? args["continue-dropped"] : undefined;
  const droppedReason = typeof args["continue-dropped-reason"] === "string" ? args["continue-dropped-reason"] : "unspecified";
  if (typeof args["driver"] === "string" && !(DRIVERS as readonly string[]).includes(args["driver"])) {
    console.error(`unknown --driver ${args["driver"]} (one of: ${DRIVERS.join(", ")})`);
    process.exit(2);
  }
  if (args["episode"] !== undefined && !isEpisodeId(args["episode"])) {
    console.error(`unknown --episode ${String(args["episode"])} (one of: ${EPISODE_IDS.join(", ")})`);
    process.exit(2);
  }
  /*
   * A tier that forbids an objective forbids it at launch, not on the chart.
   * The alternative — accepting the pair and stamping the run unscored — would
   * quietly turn a scored run into an unscored one, which is exactly the kind
   * of silent downgrade the tuple exists to prevent.
   */
  if (
    isEpisodeId(args["episode"]) &&
    typeof args["objective"] === "string" &&
    !EPISODES[args["episode"]].objectiveAllowed
  ) {
    console.error(
      `--episode ${args["episode"]} does not allow --objective; a steered run is --episode probing (a campaign) or --episode freeplay`,
    );
    process.exit(2);
  }

  let config: RunConfig & { runId: string; token: string };
  let resumed = false;
  /** The meta.json a resume loaded, kept so a regenerated token can be persisted. */
  let resumedMeta: RunMeta | undefined;
  /** The pause mark the resumed meta carried, read before the mark is consumed. */
  let resumedPause: PauseMark | undefined;
  let tokenRegenerated = false;
  if (resumeId !== undefined) {
    const runsDir = typeof args["runs-dir"] === "string" ? args["runs-dir"] : "data/runs";
    const meta = readMeta(join(runsDir, resumeId));
    if (meta === null) {
      console.error(`no meta.json for run ${resumeId} under ${runsDir}`);
      process.exit(2);
    }
    const c = loadRunConfig(meta.config);
    // Explicit limit/watchdog flags override the stored config: resuming a
    // runaway with a tighter leash is the whole point of passing them here.
    // Identity (character, token, driver, model) stays as stored.
    const overrides = {
      ...(num(args["max-turns"]) !== undefined ? { maxTurns: num(args["max-turns"])! } : {}),
      // `--max-tool-calls 0` migrates a run stored under the old 500 onto the
      // uncapped lane, the same way `--watchdogs-json {"episodeMs":null}`
      // migrates one stored under the old six-hour clock. Absence of the flag
      // leaves the stored ceiling standing, so this is never implicit.
      ...(toolCallCap(args["max-tool-calls"]) !== undefined
        ? { maxToolCallsPerEpisode: toolCallCap(args["max-tool-calls"]) as number | null }
        : {}),
      watchdogs: {
        ...c.watchdogs,
        ...(num(args["idle-ms"]) !== undefined ? { idleMs: num(args["idle-ms"])! } : {}),
        ...(num(args["no-xp-ms"]) !== undefined ? { noXpMs: num(args["no-xp-ms"])! } : {}),
        ...(num(args["episode-ms"]) !== undefined ? { episodeMs: num(args["episode-ms"])! } : {}),
        ...watchdogOverrides(args["watchdogs-json"]),
      },
    };
    // A stored token shorter than the module's floor is a pre-hardening run's
    // (it was the run id): replace it and persist the replacement below.
    const session = resolveSessionToken(c.token);
    config = { ...c, ...overrides, runId: resumeId, token: session.token };
    resumedMeta = meta;
    resumedPause = meta.pause;
    tokenRegenerated = session.regenerated;
    resumed = true;
  } else {
    config = configFromArgs(rawArgs);
  }
  /** The freeplay run this launch continues, once its predecessor checks out. */
  let continuation: Continuation | undefined;
  /** A predecessor named on the command line that is on disk nowhere. */
  let missingPredecessor: string | undefined;
  if (!resumed && config.continuedFrom !== undefined) {
    let loaded: Continuation | null = null;
    try {
      loaded = loadContinuation(config);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(2);
    }
    if (loaded === null) {
      // Nothing to read: start fresh and record the drop once the trajectory
      // exists. The lineage leaves the config here, before meta.json is
      // written, so no record ever claims a predecessor that is not there.
      missingPredecessor = config.continuedFrom;
      console.error(`[wrathbench] --continue-from ${missingPredecessor}: no such run under ${config.runsDir} — starting fresh`);
      config = { ...config, continuedFrom: undefined };
    } else {
      continuation = loaded;
      // The character's identity is the predecessor's; the launch's race/class
      // flags are the fleet restating the entry, and they must not disagree.
      config = { ...config, character: loaded.character, race: loaded.race, class: loaded.class };
    }
  }
  // Deliberately NOT registered with `trajectory.redact`: meta.json is scrubbed
  // with the same secret list, and a redacted token could never be read back by
  // `--resume`. Trajectories are gitignored and stay on the operator's disk.

  // Before the run directory, the trajectory and the session: a stale bundle is
  // a deploy mistake, and failing here leaves no half-run behind — the roster
  // sees an exit with no run.sqlite and calls it `launch-failed`.
  const wiki = openWikiBundle(config.wikiBundle);
  if (wiki === undefined) {
    console.error(`warning: wiki bundle not found at ${config.wikiBundle}; search_reference will report unavailable`);
  }
  // What was *in* that file, for the tuple: the config records only the path,
  // and the path holds a different reference surface after every rebuild.
  const wikiBundle = wikiBundleMeta(wiki);

  const runDir = join(config.runsDir, config.runId);
  const trajectory = new Trajectory(runDir);
  const scratchpad = new Scratchpad(join(runDir, "scratchpad.md"));
  // The episodic log lives beside the scratchpad and survives a pause the same
  // way: it is append-only, so a resumed run reads its own past back.
  const episodic = new EpisodicLog(join(runDir, "episodic.jsonl"));
  // The predecessor's notes come along: the scratchpad is the durable memory,
  // and a continuation that started with an empty one would be a stranger to
  // its own character. Only into an empty run directory — a re-launch of a
  // continuation that already wrote notes keeps its own.
  if (continuation !== undefined && !existsSync(scratchpad.path) && existsSync(join(continuation.dir, "scratchpad.md"))) {
    copyFileSync(join(continuation.dir, "scratchpad.md"), scratchpad.path);
  }

  // driver
  let adapter: ChatAdapter | undefined;
  if (config.driver === "stub") {
    if (config.stubScript === undefined) {
      console.error("--driver stub requires --stub <script.json>");
      process.exit(2);
    }
    adapter = StubAdapter.fromScriptFile(config.stubScript);
  } else if (config.driver === "claude-code") {
    // The subscription lane: a var NAME, defaulting to the one the CLI itself
    // knows. Everything below says the CHOSEN name, so an operator reading a
    // refusal is told which of two subscriptions is missing.
    const tokenEnv = config.subscription ?? DEFAULT_CLAUDE_TOKEN_ENV;
    if (!isTokenEnvName(tokenEnv)) {
      console.error(`--token-env ${tokenEnv} is not an environment variable name (it must not be the token itself)`);
      process.exit(2);
    }
    const token = process.env[tokenEnv];
    if (token === undefined || token.trim().length === 0) {
      console.error(
        `--driver claude-code needs $${tokenEnv}.\n` +
          "  generate one with:  claude setup-token\n" +
          `  then put it in .env as ${tokenEnv}=... (.env is gitignored)\n` +
          "  and start the run through infra/run-episode.sh, which exports it for you.",
      );
      process.exit(2);
    }
    trajectory.redact(token);
    // Recorded, so the run names its lane rather than leaving a reader (or the
    // fleet's per-lane count) to infer the default. The NAME, never the value.
    config = { ...config, subscription: tokenEnv };
  } else if (config.driver === "codex") {
    // The subscription lane, by var NAME: its VALUE is a CODEX_HOME directory
    // whose auth.json holds the ChatGPT login (config.ts, DEFAULT_CODEX_HOME_ENV).
    // Checked here for the same reason the claude token is: a missing lane
    // must fail in a second, naming the variable, not after the sandbox and the
    // game session are up. The directory is never copied and auth.json never read.
    const laneEnv = config.subscription ?? DEFAULT_CODEX_HOME_ENV;
    if (!isTokenEnvName(laneEnv)) {
      console.error(`--token-env ${laneEnv} is not an environment variable name (for codex it names the var holding a CODEX_HOME path)`);
      process.exit(2);
    }
    const home = process.env[laneEnv];
    if (!laneLooksLoggedIn(home)) {
      console.error(
        `--driver codex needs $${laneEnv} to name a Codex home directory containing auth.json` +
          (home === undefined || home.trim().length === 0 ? " (it is unset)." : ` (${home} has none).`) +
          "\n  log in once with:  codex login   (a ChatGPT subscription; the login lands in ~/.codex/auth.json)\n" +
          `  then put the directory in .env as ${laneEnv}=/home/<you>/.codex (.env is gitignored)\n` +
          "  and start the run through infra/run-episode.sh, which exports it for you.\n" +
          "  One directory per lane, shared by that lane's runs — never a per-run copy: a copied\n" +
          "  refresh token is spent by whichever process refreshes first.",
      );
      process.exit(2);
    }
    // `none`/`minimal` are not Codex levels; refused by name, never mapped.
    const refusal = codexEffortRefusal(config.effort);
    if (refusal !== null) {
      console.error(refusal);
      process.exit(2);
    }
    if (config.model === undefined) {
      console.error("--driver codex needs --model (e.g. gpt-6-astra, gpt-5.5 — the ChatGPT catalogue's ids)");
      process.exit(2);
    }
    config = { ...config, subscription: laneEnv };
  } else {
    const apiKey = process.env[config.apiKeyEnv];
    const apiBase = config.apiBase ?? process.env["OPENAI_BASE_URL"];
    if (config.model === undefined || apiKey === undefined || apiBase === undefined) {
      console.error(
        `openai driver needs --model, --api-base (or OPENAI_BASE_URL), and $${config.apiKeyEnv} set`,
      );
      process.exit(2);
    }
    trajectory.redact(apiKey);
    adapter = new OpenAiChatAdapter({
      baseUrl: apiBase,
      apiKey,
      model: config.model,
      ...(config.effort !== undefined ? { effort: config.effort } : {}),
    });
  }

  const shakeout = unscoredStamp(config.driver, config.objective);
  const version = harnessVersion();
  // Never blocks launch: an unreachable module (or one that predates the
  // field) reads as `null`, same as "not recorded" everywhere else in the
  // tuple. Fetched fresh on every launch and every resume-restamp, so a
  // resumed run's tuple names the build it is actually resuming against.
  const serverBuild = await fetchServerBuild(config.moduleUrl);
  const comparability = comparabilityOf(config, version, serverBuild, wikiBundle);
  if (!resumed) {
    trajectory.writeMeta({
      runId: config.runId,
      harnessVersion: version,
      startedAt: Date.now(),
      config,
      comparability,
      ...(shakeout !== undefined ? { shakeout } : {}),
    });
    // The lineage never reached meta.json or the run row (it left the config
    // above), so the record is all there is to write — and it names the id, so
    // an operator reading the trajectory knows which predecessor went missing.
    if (missingPredecessor !== undefined) {
      trajectory.append({
        t: "harness",
        kind: "continue-dropped",
        detail: `--continue-from ${missingPredecessor}: no run directory, live or archived — starting a fresh character`,
      });
    }
    // The supervisor's own drop (`--continue-dropped`): the head it left
    // behind and why, so the trajectory says this fresh start was a decision.
    if (droppedHead !== undefined) {
      trajectory.append({
        t: "harness",
        kind: "continue-dropped",
        detail: `${droppedHead} not continued (${droppedReason}) — starting a fresh character on ${config.account}`,
      });
    }
  } else {
    trajectory.clearPause(config.runId);
    trajectory.append({
      t: "resume",
      harnessVersion: version,
      ...(resumedPause !== undefined ? { after: resumedPause.reason, episodeElapsedMs: resumedPause.episodeElapsedMs } : {}),
    });
    /*
     * The pause mark is consumed: meta.json says "paused" only while the run
     * is. The claude-code driver cannot reattach the CLI's own conversation
     * (the CLI owns that history; the runner starts a fresh session with the
     * same fixed prompt and the scratchpad), so such a resume is stamped
     * `resumedFresh` in meta.json — sticky: the run had at least one fresh
     * restart in its life, which a reader of its turns should know.
     */
    if (resumedMeta !== undefined) {
      const { pause: _pause, ...rest } = resumedMeta;
      resumedMeta = {
        ...rest,
        // Codex could resume its own thread, but the runner starts a fresh one
        // on purpose: the thread id is not run identity and a resumed run's
        // conversation should be exactly what the scratchpad note says it is.
        ...(config.driver === "claude-code" || config.driver === "codex" ? { resumedFresh: true } : {}),
      };
      trajectory.writeMeta({ ...resumedMeta, harnessVersion: version, config, comparability });
    }
    /*
     * A resume may tighten the leash (`--max-turns`, `--watchdogs-json`), and a
     * budget stamped at launch would then describe a run that no longer exists.
     * The tuple is re-stamped to what will actually be enforced, and the change
     * is recorded so the earlier portion is still readable in the trajectory.
     */
    if (
      resumedMeta !== undefined &&
      (resumedMeta.comparability === undefined ||
        !sameComparability(resumedMeta.comparability, comparability))
    ) {
      /*
       * The harness version moves with the tuple. A resumed run is driven by
       * the build that resumed it, and leaving the top-level stamp at the
       * launch build would have the run row and its own tuple naming two
       * different versions — on charts whose entire claim is comparability.
       */
      trajectory.writeMeta({ ...resumedMeta, harnessVersion: version, config, comparability });
      trajectory.append({
        t: "harness",
        kind: "comparability_restamped",
        // Whether anything but the build stamp moved: a resume onto a newer
        // commit always restamps, and only this says the leash actually changed.
        leashChanged:
          resumedMeta.comparability !== undefined &&
          !sameComparability(
            { ...resumedMeta.comparability, harnessVersion: version },
            comparability,
          ),
        before: resumedMeta.comparability ?? null,
        after: comparability,
      });
    }
    if (tokenRegenerated && resumedMeta !== undefined) {
      // Persist the new secret, or the next resume would regenerate again and
      // orphan this one. Everything else about the stored meta is preserved:
      // only `config` is replaced, and only its token differs.
      console.error(
        `[wrathbench] session token regenerated: the stored one was shorter than ` +
          `${MIN_TOKEN_LENGTH} chars (a pre-hardening run id, which the module now refuses as ` +
          `weak_token). No live session is stranded — the nightly worldserver recreate clears ` +
          `every module session.`,
      );
      trajectory.writeMeta({ ...resumedMeta, harnessVersion: version, config, comparability });
      trajectory.append({ t: "harness", kind: "token_regenerated", reason: "weak_stored_token" });
    }
  }

  /*
   * Where this episode's turn numbering continues from. `maxTurns` still counts
   * this process's turns; only the recorded index is cumulative, so a resumed
   * run's turns-to-level is the run's cost and not this episode's.
   */
  const turnOffset = resumed ? trajectory.maxTurn(config.runId) : 0;

  /*
   * Lease this token on the module before the child exists: binds it to the
   * run's account and yields the session secret the child authenticates with
   * (module/PROTOCOL.md, "Authentication"). The host keeps the port secret;
   * the child gets only this. A resume re-leases the stored token, which
   * rotates the secret and keeps the character binding.
   */
  const lease = await leaseSessionSecret({ moduleUrl: config.moduleUrl, token: config.token, account: config.account });
  if (lease.secret === undefined) console.error(`[wrathbench] ${lease.note}`);

  const sandbox = new SandboxHost({
    moduleUrl: config.moduleUrl,
    token: config.token,
    secret: lease.secret,
    account: config.account,
    scratchpad,
    snippetTimeoutMs: config.snippetTimeoutMs,
    pingGraceMs: config.sandboxPingGraceMs,
    onNotice: (n) => trajectory.append({ t: "harness", ...n }),
  });
  /*
   * The episode clock continues from where the last segment left it: a
   * paused run's meta.json carries the wall clock it had spent, so a 90-minute
   * budget is 90 minutes of play however many times the fleet restarted
   * underneath it. A pause written before the mark existed resumes at zero.
   */
  const elapsedBeforeMs = resumedPause?.episodeElapsedMs ?? 0;
  const watchdogs = new Watchdogs(config.watchdogs, Date.now, elapsedBeforeMs);
  if (resumed && elapsedBeforeMs > 0) {
    console.error(`[wrathbench] episode clock resumes at ${Math.round(elapsedBeforeMs / 60_000)}m`);
  }

  // A stopped runner must still leave a run that says what happened to it.
  // Two signals, two meanings:
  //  - SIGTERM is what a supervisor sends — `docker compose stop`, a drain, a
  //    recreate. The run PAUSES as `operator-pause`: clock stopped, session
  //    released, resumable with --resume. The fleet's stop must not cost a run.
  //  - SIGINT is the operator's Ctrl-C on a hand-started run: `manual`.
  // Either way the driver is asked to unwind cooperatively (the request in
  // flight is abandoned, the CLI child torn down) and the record is written
  // by the loop; a backstop writes it if the unwind wedges.
  let stopping = false;
  const abort = new AbortController();
  const onSignal = (sig: "SIGINT" | "SIGTERM"): void => {
    if (stopping) process.exit(130);
    stopping = true;
    const req: StopRequest =
      sig === "SIGTERM"
        ? { kind: "pause", reason: "operator-pause", detail: `${sig}: supervisor stop` }
        : { kind: "terminate", detail: sig };
    console.error(
      req.kind === "pause"
        ? `\n${sig}: pausing run as \`operator-pause\` (resume with --resume ${config.runId})`
        : `\n${sig}: terminating run as \`manual\``,
    );
    abort.abort(req);
    // Backstop: never hang forever waiting for a wedged child or snippet. If
    // the loop has not written its record by then, write it here so the run
    // is never left with neither a termination nor a pause.
    setTimeout(() => {
      const row = trajectory.runRow(config.runId);
      const recorded = row !== null && ((row["termination_reason"] ?? null) !== null || (row["pause_reason"] ?? null) !== null);
      if (!recorded) {
        if (req.kind === "pause") {
          trajectory.setPause(config.runId, req.reason, `${req.detail} (backstop)`, watchdogs.elapsedMs());
          trajectory.writeMeta({ ...(readMeta(runDir) ?? metaNow()), pause: pauseMark(req) });
        } else {
          trajectory.setTermination(config.runId, "manual", `${req.detail} (backstop)`);
        }
      }
      process.exit(130);
    }, req.kind === "pause" ? 60_000 : 20_000).unref();
  };
  const metaNow = (): RunMeta => ({
    runId: config.runId,
    harnessVersion: version,
    startedAt: Date.now(),
    config,
    comparability,
    ...(shakeout !== undefined ? { shakeout } : {}),
  });
  const pauseMark = (p: { reason: PauseMark["reason"]; detail?: string | undefined }): PauseMark => ({
    reason: p.reason,
    ...(p.detail !== undefined ? { detail: p.detail } : {}),
    at: Date.now(),
    episodeElapsedMs: watchdogs.elapsedMs(),
  });
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  console.error(
    `[wrathbench] run ${config.runId} (${resumed ? "resumed" : "new"}) — driver ${config.driver}${adapter !== undefined ? ` (${adapter.label})` : ""}, harness ${version}`,
  );
  if (config.episode !== undefined) {
    console.error(
      `[wrathbench] episode ${config.episode}${episodeOverrideOf(config) ? " (OVERRIDDEN — not a clean tier run)" : ""}`,
    );
  }
  if (shakeout !== undefined) {
    console.error(`[wrathbench] ${shakeout.toUpperCase()} — this run is NOT a scored result`);
  }
  console.error(`[wrathbench] trajectory: ${runDir}`);

  // Names still standing on the account after hygiene (slot-eaters it could
  // not delete). The model chooses its own name, so these are the
  // ones it must not choose: `createSession` REUSES an existing character of
  // that name, and landing on one is a `stale-character` attempt burned.
  let takenNames: string[] = [];
  if (!resumed) {
    // Episode hygiene (fresh character per episode): the account has
    // ~10 character slots and every character on it is disposable between
    // episodes. Clear them so whatever name the model picks is free.
    //
    // Best-effort on what it deletes, strict on what it BELIEVES: the run
    // starts only once an OK listing has actually been read (hygiene.ts has
    // the 2026-08-24 history — a refused listing during the core's post-logout
    // linger used to read as "clear", and three scored e90s started on their
    // predecessor's character). A refusal terminates the run as a
    // zero-response `stale-character`, which the stillborn path below
    // archives and the scheduler's defer ladder retries in a minute — after
    // the core has released the account. The guids hygiene saw arm the
    // watchdogs' first-observation tripwire, the belt to this braces.
    const hygiene = await clearAccountCharacters({
      moduleUrl: config.moduleUrl,
      token: config.token,
      account: config.account,
      log: (line) => console.error(`[wrathbench] ${line}`),
      // A continuation keeps its predecessor's character, and every launch
      // keeps another stream's character it shares the account with;
      // everything else on the account is the usual leftover.
      keep: [...(continuation !== undefined ? [continuation.character] : []), ...keepCharacters],
    });
    if (!hygiene.ok) {
      console.error(`[wrathbench] ${hygiene.reason}`);
      trajectory.setTermination(config.runId, "stale-character", hygiene.reason);
      trajectory.close();
      try {
        const moved = archiveIfNoResponses(config.runsDir, config.runId);
        if (moved !== null) console.error(`[wrathbench] no model response — archived to ${moved}`);
      } catch (err) {
        console.error(`[wrathbench] could not archive ${config.runId}: ${err instanceof Error ? err.message : String(err)}`);
      }
      wiki?.close();
      process.exit(1);
    }
    if (hygiene.cleared > 0) {
      console.error(`[wrathbench] hygiene: cleared ${hygiene.cleared} leftover character(s)`);
      trajectory.append({ t: "harness", kind: "hygiene", cleared: hygiene.cleared });
    }
    // A kept character is as taken as a slot-eater: `createSession` on its
    // name would reuse it, and the tripwire below would end the run.
    const keptOthers = hygiene.kept.filter((k) => continuation === undefined || k.name.toLowerCase() !== continuation.character.toLowerCase());
    takenNames = [...hygiene.leftover, ...keptOthers.map((k) => k.name)];
    if (keptOthers.length > 0) {
      console.error(`[wrathbench] hygiene: kept ${keptOthers.map((k) => k.name).join(", ")} (another freeplay stream's character on this account)`);
    }
    if (hygiene.leftover.length > 0) {
      console.error(
        `[wrathbench] hygiene: ${hygiene.leftover.length} leftover character(s) not cleared (${hygiene.leftover.join(", ")}) — proceeding, the model is told not to pick them`,
      );
    }
    const own = continuation === undefined ? undefined : hygiene.kept.find((k) => k.name.toLowerCase() === continuation!.character.toLowerCase());
    if (continuation !== undefined && own !== undefined) {
      // The character is there: the stream goes on, and the freshness belt
      // stays off, as on a resume — this character is meant to have history.
      console.error(`[wrathbench] continuing ${continuation.from}: ${own.name} (guid ${own.guid}) is on ${config.account}`);
      trajectory.append({ t: "continue", from: continuation.from, character: own.name, guid: own.guid });
    } else {
      if (continuation !== undefined) {
        // The predecessor's character is gone (deleted by hand, or by another
        // account's hygiene): nothing to continue. The run goes on as a fresh
        // one and says so everywhere the lineage was written, and the copied
        // notes go with it — they describe a character that no longer exists.
        const detail = `${continuation.character} is not on ${config.account} any more — starting a fresh character instead of continuing ${continuation.from}`;
        console.error(`[wrathbench] ${detail}`);
        trajectory.dropContinuation(config.runId, detail);
        config = { ...config, character: undefined, continuedFrom: undefined };
        if (existsSync(scratchpad.path)) rmSync(scratchpad.path);
        continuation = undefined;
      }
      watchdogs.expectFreshCharacter(new Set(hygiene.seen.values()));
    }
  }

  /* The resumed run's session note (prompt.ts owns the wording). */
  const resumeNote = (): string => {
    const spentM = Math.round(elapsedBeforeMs / 60_000);
    const budgetMs = config.watchdogs.episodeMs;
    const clock =
      budgetMs !== null && budgetMs !== undefined
        ? `${spentM} minutes elapsed of ${Math.round(budgetMs / 60_000)}`
        : `${spentM} minutes elapsed`;
    const last = trajectory.lastState(config.runId);
    const seen =
      last === null || (last.level === undefined && last.xp === undefined)
        ? ""
        : ` It was last observed at level ${last.level ?? "?"}` +
          (last.xp !== undefined ? ` with ${last.xp} xp` : "") +
          `, and that progress is still there.`;
    return resumeSessionNote({
      character: config.character,
      race: config.race,
      class: config.class,
      clock,
      seen,
      raceName: raceName(config.race),
      className: className(config.class),
    });
  };

  /* The continued run's session note: the predecessor's character, as it was last seen there. */
  const continueNote = (c: Continuation): string => {
    const last = lastStateIn(c.dir, c.from);
    const seen =
      last === null || (last.level === undefined && last.xp === undefined)
        ? ""
        : ` It was last observed at level ${last.level ?? "?"}` +
          (last.xp !== undefined ? ` with ${last.xp} xp` : "") +
          `, and that progress is still there.`;
    return continuedSessionNote({
      character: c.character,
      race: c.race,
      class: c.class,
      from: c.from,
      seen,
      raceName: raceName(c.race),
      className: className(c.class),
    });
  };

  const initialNotices = resumed
      ? [
          {
            ts: Date.now(),
            kind: "session_note",
            text: resumeNote(),
          } as const,
        ]
      : continuation !== undefined
        ? [
            {
              ts: Date.now(),
              kind: "session_note",
              text: continueNote(continuation),
            } as const,
          ]
        : [
          {
            ts: Date.now(),
            kind: "session_note",
            text: freshCharacterNote({
              race: config.race,
              class: config.class,
              taken: takenNames,
            }),
          } as const,
        ];

  const outcome =
    config.driver === "claude-code"
      ? await runClaudeEpisode({
          config,
          runDir,
          sandbox,
          scratchpad,
          episodic,
          wiki,
          trajectory,
          watchdogs,
          initialNotices,
          turnOffset,
          signal: abort.signal,
        })
      : config.driver === "codex"
        ? await runCodexEpisode({
            config,
            runDir,
            sandbox,
            scratchpad,
            episodic,
            wiki,
            trajectory,
            watchdogs,
            initialNotices,
            turnOffset,
            signal: abort.signal,
          })
        : await runLoop({
          config,
          adapter: adapter!,
          sandbox,
          scratchpad,
          episodic,
          wiki,
          trajectory,
          watchdogs,
          initialNotices,
          turnOffset,
          signal: abort.signal,
        });

  if (outcome.kind === "paused") {
    /*
     * The pause mark: what a supervisor reads to find resumable runs, and
     * what the next --resume continues the episode clock from. Written before
     * the session is touched so a crash in the release still leaves a
     * resumable run.
     */
    trajectory.writeMeta({ ...(readMeta(runDir) ?? metaNow()), pause: pauseMark(outcome) });
  }
  if (outcome.kind === "terminated" || outcome.reason === "operator-pause") {
    // A finished run frees its module session so the account is not held
    // (the realm caps characters/sessions per account). So does a run the
    // supervisor paused: the fleet is going down, and the account must be
    // free for the resume (same character — logout, never a wipe). A run
    // paused by its provider keeps the session alive on purpose: that is
    // the in-place retry path, and the roster frees it when it moves on.
    try {
      await sandbox.evalSnippet(
        "if (typeof sdk !== 'undefined' && sdk) { try { await sdk.deleteSession(); } catch {} }",
      );
    } catch {
      // Best-effort: a dead sandbox or module leaves the session to the
      // module's own logout path.
    }
  }
  await sandbox.stop();
  if (outcome.kind === "paused") {
    console.error(`[wrathbench] paused: ${outcome.reason} — resume with --resume ${config.runId}`);
  } else {
    // The token's lease goes with the run; a resume never follows a
    // termination, so nothing will present that secret again.
    await releaseSessionSecret({ moduleUrl: config.moduleUrl, token: config.token });
    console.error(`[wrathbench] terminated: ${outcome.reason}${outcome.detail !== undefined ? ` (${outcome.detail})` : ""}`);
  }
  trajectory.close();
  /*
   * A launch that did not happen does not become a run. A terminated run with
   * zero `response` records — the provider was dead on the first request, the
   * key was refused, the adapter threw before a turn existed — is moved into
   * `data/runs/archive/` right here, after the termination row is written and
   * the trajectory is closed, so no listing ever counts it. A PAUSE is not a
   * termination: a paused run with no response yet is resumed, not buried.
   */
  if (outcome.kind === "terminated") {
    try {
      const moved = archiveIfNoResponses(config.runsDir, config.runId);
      if (moved !== null) console.error(`[wrathbench] no model response — archived to ${moved}`);
    } catch (err) {
      console.error(`[wrathbench] could not archive ${config.runId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (stopping) {
    wiki?.close();
    process.exit(130);
  }
  wiki?.close();
}

if (import.meta.main) {
  void main();
}
