#!/usr/bin/env bun
/**
 * Overnight roster orchestrator.
 *
 *   ./infra/run-roster.sh <roster.json> --until 07:30
 *   ./infra/run-roster.sh <roster.json> --max-hours 8 --skip nvidia/nemotron-3-ultra-550b-a55b:free
 *   ./infra/run-roster.sh <roster.json> --dry-run
 *   ./infra/run-roster.sh <roster.json> --loop --until 07:30
 *
 * The fleet supervisor (run-fleet.ts) materialises one of these per job from
 * the config store; a hand-written roster is the ad-hoc path.
 *
 * Every entry is config: `model`, `driver` (openai | claude-code),
 * `account`, `effort`, `apiBase`/`apiKeyEnv` (openai only),
 * `race`/`class`, `episodeMs`. No name: the model names its own character and
 * the run records what it chose. Everything but `model` has a default, so the old shape — a bare
 * list of `{ "model": ... }` — still means exactly what it meant before.
 *
 * One episode at a time, in roster order. On the host each is launched through
 * `infra/run-episode.sh` (so its preflight, .env handling and harness version
 * stamping all still apply — nothing here reimplements it). Inside the runner
 * image — where the fleet supervisor now lives — there is no docker
 * to exec with, so the episode is spawned as a direct `bun runner/src/run.ts`
 * child and the few things run-episode.sh contributed (harness stamp, claude
 * token check) are done here. See `inContainer()`.
 *
 * Why this exists: OpenRouter free-tier limits are per *upstream provider*, not
 * per account. When one model's pool is saturated the useful move is not to sit
 * on a backoff, it is to advance to the next model and come back later. So a
 * run that pauses `rate-limited` before it got going is deferred to a retry
 * queue and the roster moves on; a run that pauses mid-episode is worth
 * resuming in place, because its character and scratchpad are live progress.
 *
 * Two live-world facts drive the session handling here:
 *
 *  - A PAUSED run keeps its module session alive on purpose (that is what
 *    `--resume` reattaches to), and a live session holds the game account. The
 *    whole roster shares RUNNER, so the next episode would fail every
 *    createSession with `account_in_use`. Whenever the roster advances past a
 *    paused run, and defensively before every launch, we DELETE /session for
 *    that run's token, read back from its meta.json (`tokenOfRun`) now that
 *    tokens are random secrets rather than the run id. The *character*
 *    survives, so a later
 *    `--resume` still works.
 *  - A fresh (non-resumed) run wipes every character on its account first
 *    (runner/src/run.ts episode hygiene). So a run deferred to the end of the
 *    roster comes back to an empty account: `--resume` restores its trajectory
 *    and scratchpad, not its level. That is the reason mid-episode pauses are
 *    retried in place *before* being deferred.
 */

import { openRunDb } from "../runner/src/rundb";
// The one zod schema for a watchdog override lives with the run config it
// overrides (runner/src/config.ts). Importing it keeps roster, fleet and
// runner validating the same shape instead of three hand-rolled copies.
import { ARCHIVE_DIR } from "../runner/viewer/archive-dir";
import { DEFAULT_CLAUDE_TOKEN_ENV, DEFAULT_CODEX_HOME_ENV, isTokenEnvName, watchdogOverrideSchema, type WatchdogOverride } from "../runner/src/config";
import { moduleAuthHeaders } from "../runner/src/module-auth";
import { isOpenRouterBase, parseRouting, resolveRouting, routingLabel, type RoutingSpec } from "../runner/src/routing";
import { classifyLapse, resumesOnPause } from "../runner/src/lapse";
import { Trajectory } from "../runner/src/trajectory";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// ------------------------------------------------------------------ types

type Driver = "openai" | "claude-code" | "codex";

export interface RosterSpec {
  model: string;
  /** Operator override of the free/paid verdict (`runner/src/model-cost.ts`); normally absent. */
  billing?: "free" | "paid";
  /**
   * Defaults to "openai". `claude-code` runs go through the Claude Code CLI
   * and `codex` runs through the OpenAI Codex CLI, each of which is its own
   * harness — a tag on the run, not a separate benchmark.
   */
  driver?: Driver;
  /** Game account for the entry's session. Omitted -> the runner's default. */
  account?: string;
  /** Reasoning effort. Omitted -> the provider's own default, not a level. */
  effort?: string;
  apiBase?: string;
  apiKeyEnv?: string;
  /**
   * Which backend the aggregator may route this entry to (`routing.ts`).
   * `openai` driver on an OpenRouter base only — every other endpoint has one
   * machine behind it and nothing to choose. Absent means the model author's
   * own provider with fallbacks off (operator decision 2026-09-16).
   */
  routing?: RoutingSpec;
  /**
   * `claude-code` and `codex` only: the subscription LANE this entry runs on,
   * named by the env var holding its credential — the OAuth token for
   * claude-code, the CODEX_HOME directory for codex — never the credential.
   * Absent means the driver's default lane (`CLAUDE_CODE_OAUTH_TOKEN`,
   * `CODEX_HOME`), which is every roster written before there was a second
   * subscription. The fleet assigns it; a hand-written roster may set it to
   * pin an entry to one account's usage window.
   */
  tokenEnv?: string;
  runId?: string;
  race?: number;
  class?: number;
  episodeMs?: number;
  /**
   * Run dimensions, both optional and both recorded in the run's
   * metadata. `objective` is one operator-authored line rendered into the
   * fixed prompt for every model alike, and stamps the run unscored;
   * `watchdogs` is a partial threshold override where `null`/`0` disables one.
   * `maxToolCalls` bounds the whole episode's tool calls — the runner's 500
   * default is a runaway guard sized for a 90-minute episode, so a multi-hour
   * entry has to raise it or it terminates `tool-call-limit` mid-probe.
   * `null` removes the ceiling outright, which only the policy's
   * `idle: "unlimited"` freeplay lane asks for: absent still means the
   * runner's own default, so nothing else changes shape.
   */
  objective?: string;
  watchdogs?: WatchdogOverride;
  maxToolCalls?: number | null;
  /**
   * Whether `search_reference` serves wiki coordinates. Absent or
   * false is names-first, the scored default; only freeplay/unscored jobs
   * should set it. Stamped into the run's comparability tuple.
   */
  wikiCoords?: boolean;
  /**
   * Whether this entry's runs have the reference wiki at all: the
   * `search_reference` tool, its line in the prompt, and the bundle. Default
   * true — the wiki is a capability every run has unless the entry switches it
   * off (operator decision 2026-09-16, issue #61), and a run without it is a
   * different condition, stamped as one in the comparability tuple.
   */
  wiki?: boolean;
  /** An extra run past the policy target: stamped `extra: true`, never counted. */
  extra?: boolean;
  /**
   * Episode tier id: `e90`, `e360`, `probing` or `freeplay`. Passed to the
   * runner verbatim as `--episode <id>`; the explicit watchdog/maxToolCalls
   * flags the fleet derives from it travel alongside, so a runner that does
   * not know the flag yet still runs the right shape.
   */
  episode?: string;
  /**
   * The probe campaign that commissioned this entry and which of its cells it
   * is. Passed to the runner as `--campaign` / `--cell` and recorded
   * on the run, which is what a campaign's remaining work is counted from and
   * what keeps its results grouped after its config entry is deleted.
   */
  campaign?: string;
  cell?: string;
  /**
   * Whether a run of this entry that pauses is resumed. The fleet
   * writes it from the lane: `freeplay` yes, a probe campaign only if it asked
   * (`campaigns.<name>.resume`), a scored eval never. Absent falls back to
   * `resumesOnPause(episode)`, so a hand-written roster with no episode keeps
   * the lane's behaviour.
   */
  resumeOnPause?: boolean;
  /**
   * A freeplay continuation: the run id whose character and scratchpad this
   * launch carries on (`--continue-from`). The fleet sets it on the
   * `idle: "unlimited"` lane's next session when the character's previous run
   * ended; a fresh launch only, never restated on `--resume`.
   */
  continueFrom?: string;
  /**
   * Characters on this account that belong to another ref's freeplay character
   * and must survive this launch's hygiene (`--keep-characters`).
   */
  keepCharacters?: string[];
  /**
   * A character head this launch deliberately does not continue: the supervisor
   * found its account occupied by another ref's character and started fresh
   * elsewhere (`--continue-dropped`, `--continue-dropped-reason`). Record only.
   */
  continueDropped?: { runId: string; reason: string };
}

export interface Resolved {
  model: string;
  driver: Driver;
  account: string | undefined;
  effort: string | undefined;
  apiBase: string;
  apiKeyEnv: string;
  /** The declared routing block, or undefined for "the entry said nothing". */
  routing: RoutingSpec | undefined;
  /** The subscription lane, by env var NAME; undefined is the default lane. */
  tokenEnv: string | undefined;
  runId: string;
  race: number;
  class: number;
  /** Null when the episode watchdog is disabled outright. */
  episodeMs: number | null;
  objective: string | undefined;
  watchdogs: WatchdogOverride;
  /** Undefined = the runner's default; null = no ceiling at all. */
  maxToolCalls: number | null | undefined;
  wikiCoords: boolean;
  /** False only when the entry withheld the reference wiki; true by default. */
  wiki: boolean;
  extra: boolean;
  episode: string | undefined;
  campaign: string | undefined;
  cell: string | undefined;
  /** Resolved once here, so no caller has to remember the fallback. */
  resumeOnPause: boolean;
  continueFrom: string | undefined;
  keepCharacters: string[];
  continueDropped: { runId: string; reason: string } | undefined;
}

type Outcome =
  | "launch-failed"
  | "done"
  | "done-failed"
  | "retry"
  | "deferred"
  | "paused-operator"
  | "unknown"
  | "session-freed"
  | "skipped"
  | "tainted"
  | "budget-stop";

const DEFAULT_API_BASE = "https://openrouter.ai/api/v1";
const DEFAULT_API_KEY_ENV = "OPENROUTER_KEY";
const DEFAULT_EPISODE_MS = 5_400_000; // 90 minutes
// Two ladders, deliberately different shapes.
//
//  - RESUME_BACKOFF_MS is the *mid-episode* pause retry: a run with real turns
//    on the board paused; we want it back quickly, and after three tries it
//    goes to the defer queue. Unchanged from the original behaviour.
//  - DEFER_BACKOFF_MS is the *per-spec* cooling ladder for a model whose pool
//    is saturated. It used to be the same three steps, which clamped at 10m
//    forever: a fully saturated free model (z-ai/glm-5.2:free, 2026-08-22) was
//    relaunched 17 times in one day, each a 0-turn rate-limited stub. It now
//    escalates to 6h and then taints the spec out of the rotation.
const RESUME_BACKOFF_MS = [2 * 60_000, 5 * 60_000, 10 * 60_000];
const DEFER_BACKOFF_MS = [
  1 * 60_000,
  3 * 60_000,
  5 * 60_000,
  10 * 60_000,
  15 * 60_000,
  30 * 60_000,
  60 * 60_000,
  3 * 60 * 60_000,
  6 * 60 * 60_000,
];
const MAX_RETRY_CYCLES = 2;
const CYCLE_GAP_MS = 10 * 60_000;
const EARLY_TURN_THRESHOLD = 2;
/**
 * SIGTERM → SIGKILL grace for the episode child. The runner pauses on SIGTERM
 * (pause, not terminate): it abandons the request in flight, tears down a CLI child, writes
 * the pause record and releases the session; its own backstop fires at 60s.
 * This must outlast that, and stay inside the fleet container's 180s
 * `stop_grace_period` with room for the supervisor's own reap.
 */
export const CHILD_TERM_GRACE_MS = 90_000;
const RUNS_DIR = "data/runs";
/** A trajectory touched more recently than this belongs to a live process. */
const LIVE_TRAJECTORY_MS = 3 * 60_000;
const ACCOUNT_WAIT_POLL_MS = 60_000;
const ACCOUNT_WAIT_MAX_MS = 30 * 60_000;

const REPO_ROOT = dirname(import.meta.dir);
const COMPOSE_FILE = join(REPO_ROOT, "infra", "compose.yml");
const EPISODE_SH = join(REPO_ROOT, "infra", "run-episode.sh");
const RUNNER_ENTRY = join(REPO_ROOT, "runner", "src", "run.ts");

// --------------------------------------------------------------- where am I
//
// Two homes, one code path. On the HOST the roster shells out to
// `infra/run-episode.sh`, which docker-compose-execs the runner container —
// that is how it has always worked and it stays byte-identical. Inside the
// runner image (the `fleet` compose service) there is no docker CLI
// and no container to exec into: the runner is a sibling process, so the
// roster spawns `bun runner/src/run.ts` directly, talks to the module over the
// compose network itself, and signals its own child.
//
// The flag is explicit rather than sniffed (`command -v docker` would also be
// absent on a host without Docker, which is a different situation and deserves
// a different error).

/** True when this process runs inside the runner image, not on the host. */
export function inContainer(env: Record<string, string | undefined> = process.env): boolean {
  return env["WRATHBENCH_IN_CONTAINER"] === "1";
}

const CONTAINER = inContainer();

/**
 * The honest version marker, computed the way infra/run-episode.sh computes it
 * on the host — same command, same fallback, so a stamp does not depend on
 * which side launched the episode. Per-episode, not once at supervisor start:
 * a supervisor that has been up for a week must still stamp `-dirty` the moment
 * someone edits a tracked file. `--no-optional-locks` keeps `git describe` from
 * refreshing (and writing) the index under the operator's feet.
 *
 * `WRATHBENCH_HARNESS_VERSION` wins when it is set, exactly as
 * `runner/src/version.ts` reads it. On the k8s fleet the supervisor runs from
 * a baked-in checkout with no `.git` and no git binary, so `git describe`
 * fails and the fallback claimed `0.0.0-phase0` — a stamp that names no
 * SERIES. Every run the pod launched or resumed was then out of the policy's
 * series, which made it invisible to the projection AND to `planResumes`
 * (`infra/run-fleet-plan.ts`): on 2026-09-08 a paused freeplay character head
 * (`...-20260905-a12`) was neither resumed nor listed, and the policy started
 * a fresh attempt off the older ENDED run instead. The image tag the chart
 * passes is the honest marker for a checkout that cannot describe itself.
 */
export function harnessVersion(env: Record<string, string | undefined> = process.env): string {
  const fromEnv = env["WRATHBENCH_HARNESS_VERSION"];
  if (fromEnv !== undefined && fromEnv.trim().length > 0) return fromEnv.trim();
  try {
    const p = Bun.spawnSync(
      ["git", "--no-optional-locks", "-C", REPO_ROOT, "describe", "--tags", "--always", "--dirty"],
      { stdout: "pipe", stderr: "ignore" },
    );
    if (p.exitCode === 0) {
      const out = p.stdout.toString().trim();
      if (out.length > 0) return out;
    }
  } catch {
    // no git: fall through
  }
  return "0.0.0-phase0";
}

// ------------------------------------------------------------------ args

function parseArgs(argv: string[]): {
  roster: string | undefined;
  dryRun: boolean;
  loop: boolean;
  resumeRoster: boolean;
  until: string | undefined;
  maxHours: number | undefined;
  skip: string[];
  freeTokens: string[];
  date: string | undefined;
  log: string | undefined;
} {
  let roster: string | undefined;
  let dryRun = false;
  let loop = false;
  let resumeRoster = false;
  let until: string | undefined;
  let maxHours: number | undefined;
  let log: string | undefined;
  let date: string | undefined;
  const skip: string[] = [];
  const freeTokens: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case "--dry-run":
        dryRun = true;
        break;
      case "--loop":
        loop = true;
        break;
      case "--resume-roster":
        resumeRoster = true;
        break;
      case "--until":
        until = argv[++i];
        break;
      case "--max-hours":
        maxHours = Number(argv[++i]);
        break;
      case "--skip":
        {
          const v = argv[++i];
          if (v !== undefined) skip.push(v);
        }
        break;
      case "--date":
        date = argv[++i];
        break;
      case "--free-tokens":
        {
          const v = argv[++i];
          if (v !== undefined) freeTokens.push(...v.split(",").filter((t) => t.length > 0));
        }
        break;
      case "--log":
        log = argv[++i];
        break;
      case "-h":
      case "--help":
        usage();
        process.exit(0);
        break;
      default:
        if (a.startsWith("--")) {
          console.error(`run-roster: unknown flag ${a}`);
          usage();
          process.exit(2);
        }
        roster = a;
    }
  }
  return { roster, dryRun, loop, resumeRoster, until, maxHours, skip, freeTokens, date, log };
}

function usage(): void {
  console.error(
    [
      "usage: infra/run-roster.sh <roster.json> [flags]",
      "",
      "  --until HH:MM        stop launching after this local time (tomorrow if already past)",
      "  --max-hours N        stop launching after N hours from now",
      "  --skip <model-id>    omit a model from the roster (repeatable)",
      "  --free-tokens a,b    DELETE /session for these run ids (or literal tokens) before",
      "                       starting; a run id is resolved to its stored token —",
      "                       a hand-started paused run still holds the shared game account",
      "  --loop               when the roster is exhausted, start over (cycle 2+ run ids get a",
      "                       -cN suffix so each pass is its own run). With no --until/--max-hours",
      "                       it loops until stopped — that is the fleet-service shape (see docs/RUNBOOK.md)",
      "  --resume-roster      continue a partially completed roster",
      "  --date YYYYMMDD      the stamp in derived run ids and the log name. Defaults to today —",
      "                       pass the ORIGINAL date when resuming a roster after midnight, or the",
      "                       derived run ids change and every model relaunches from scratch",
      "  --dry-run            print the plan and the exact argv per episode; launch nothing",
      "  --log <path>         roster JSONL (default data/runs/roster-<YYYYMMDD>.jsonl)",
      "",
      `  backoff: a spec that defers (pool saturated) cools for ${DEFER_LADDER} on`,
      `           consecutive defers, then is TAINTED — dropped from the rotation for the rest of`,
      `           this process — on defer ${DEFER_TAINT_AFTER}. A mid-episode pause is retried in place first`,
      `           (${RESUME_LADDER}). A successful episode clears the count.`,
      `  defer state is persisted next to --log as <log>.defer.json and reloaded under`,
      `  --resume-roster, so a supervisor restart does not reset a ${DEFER_LADDER.split("/").pop()} backoff to ${DEFER_LADDER.split("/")[0]}.`,
    ].join("\n"),
  );
}

// ------------------------------------------------------------- derivation

export function slug(model: string): string {
  const tail = model.split("/").pop() ?? model;
  return tail
    .replace(/:free$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** `0` is the argv-expressible spelling of "disabled"; `null` is the internal one. */
function normalizeMs(v: number | null | undefined): number | null | undefined {
  return v === 0 ? null : v;
}

function dateStamp(d: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

export function resolve(specs: RosterSpec[], stamp: string): Resolved[] {
  const out: Resolved[] = [];
  for (const s of specs) {
    if (typeof s.model !== "string" || s.model.length === 0) {
      throw new Error(`roster entry without a model: ${JSON.stringify(s)}`);
    }
    const driver = s.driver ?? "openai";
    if (driver !== "openai" && driver !== "claude-code" && driver !== "codex") {
      throw new Error(`roster entry ${s.model}: unknown driver ${String(s.driver)} (openai | claude-code | codex)`);
    }
    const parsedWatchdogs = watchdogOverrideSchema.safeParse(s.watchdogs ?? {});
    if (!parsedWatchdogs.success) {
      throw new Error(`roster entry ${s.model}: watchdogs — ${parsedWatchdogs.error.message}`);
    }
    const watchdogs = parsedWatchdogs.data;
    if (s.objective !== undefined && (typeof s.objective !== "string" || s.objective.length === 0)) {
      throw new Error(`roster entry ${s.model}: objective must be a non-empty string`);
    }
    if (s.wikiCoords !== undefined && typeof s.wikiCoords !== "boolean") {
      throw new Error(`roster entry ${s.model}: wikiCoords must be a boolean`);
    }
    if (s.wiki !== undefined && typeof s.wiki !== "boolean") {
      throw new Error(`roster entry ${s.model}: wiki must be a boolean`);
    }
    // Refused, not silently won by either side: coordinates are a setting of
    // the reference surface, so asking for them from a run that has none is a
    // config that cannot mean what it says (the runner refuses it too).
    if (s.wiki === false && s.wikiCoords === true) {
      throw new Error(`roster entry ${s.model}: wikiCoords needs the reference wiki, and this entry has wiki: false`);
    }
    if (s.tokenEnv !== undefined && !isTokenEnvName(s.tokenEnv)) {
      // A NAME, never a token: the value would end up in argv, and argv is
      // visible in `ps` to anything sharing the container.
      throw new Error(`roster entry ${s.model}: tokenEnv must be an environment variable name, not a token`);
    }
    const apiBase = s.apiBase ?? DEFAULT_API_BASE;
    if (s.routing !== undefined) {
      // Refused, not ignored. A routing block on a Cerebras, LM Studio,
      // OpenCode Zen or CLI entry would be config that does nothing, and an
      // operator who wrote one believed the run was pinned.
      if (driver !== "openai" || !isOpenRouterBase(apiBase)) {
        throw new Error(
          `roster entry ${s.model}: routing is an OpenRouter setting — this entry runs on ${driver === "openai" ? apiBase : `the ${driver} CLI`}, which has one backend and nothing to route between`,
        );
      }
    }
    out.push({
      model: s.model,
      driver,
      account: s.account,
      effort: s.effort,
      apiBase,
      apiKeyEnv: s.apiKeyEnv ?? DEFAULT_API_KEY_ENV,
      // Normalised here too: a hand-written roster passed straight to
      // `run-roster.ts` never went through `parseFleet`, and the shorthands
      // must mean the same thing on both paths.
      routing: s.routing === undefined ? undefined : parseRouting(s.routing, `roster entry ${s.model}`),
      // Only the subscription drivers (claude-code, codex) have a lane to bill.
      tokenEnv: driver === "claude-code" || driver === "codex" ? s.tokenEnv : undefined,
      // Effort is part of the run's identity, so it is part of the derived id:
      // opus at low and opus at high are two rows in the matrix, and a shared
      // run id would make them one run appended to twice.
      runId: s.runId ?? `roster-${slug(s.model)}${s.effort !== undefined ? `-${slug(s.effort)}` : ""}-${stamp}`,
      race: s.race ?? 1,
      class: s.class ?? 2,
      // Precedence, fixed and tested: `watchdogs.episodeMs` wins over the
      // entry's own `episodeMs`, which wins over the roster default. They are
      // the same threshold under two names, and only the watchdog spelling can
      // say `null` (no wall clock at all).
      episodeMs:
        watchdogs.episodeMs !== undefined
          ? normalizeMs(watchdogs.episodeMs) ?? null
          : s.episodeMs ?? DEFAULT_EPISODE_MS,
      objective: s.objective,
      watchdogs,
      maxToolCalls: s.maxToolCalls,
      wikiCoords: s.wikiCoords === true,
      wiki: s.wiki !== false,
      extra: s.extra === true,
      episode: s.episode,
      campaign: s.campaign,
      cell: s.cell,
      resumeOnPause: s.resumeOnPause ?? resumesOnPause(s.episode),
      continueFrom: s.continueFrom,
      keepCharacters: s.keepCharacters ?? [],
      continueDropped: s.continueDropped,
    });
  }
  return out;
}

/**
 * The api-base/api-key-env pair is meaningless to the claude-code and codex
 * drivers (each authenticates through its CLI's own login), so those entries
 * get neither flag. Everything else is driver-independent.
 */
/**
 * The watchdog overrides that cannot ride their own flag: everything but
 * `episodeMs` (which has `--episode-ms`), plus `episodeMs: null` when the wall
 * clock is disabled. Undefined when there is nothing to say.
 */
export function watchdogsJson(spec: Resolved): string | undefined {
  const out: WatchdogOverride = {};
  if (spec.watchdogs.idleMs !== undefined) out.idleMs = normalizeMs(spec.watchdogs.idleMs) ?? null;
  if (spec.watchdogs.noXpMs !== undefined) out.noXpMs = normalizeMs(spec.watchdogs.noXpMs) ?? null;
  if (spec.watchdogs.maxSandboxRestarts !== undefined) {
    out.maxSandboxRestarts = spec.watchdogs.maxSandboxRestarts;
  }
  if (spec.episodeMs === null) out.episodeMs = null;
  return Object.keys(out).length === 0 ? undefined : JSON.stringify(out);
}

/**
 * The runtime leash: the limit and watchdog flags `run.ts` accepts as EXPLICIT
 * overrides, on a fresh launch and on a resume alike.
 *
 * A resume takes its identity from the stored meta.json, but not its leash. The
 * runner reloads the stored config and only replaces a watchdog when the flag
 * is present, so a run stored under an older policy comes back under the older
 * policy's clock: a freeplay run created before the six-hour cap was removed
 * kept `episodeMs: 21600000` through every automatic resume, and the absence of
 * `--episode-ms` said nothing — only `--watchdogs-json {"episodeMs":null}`
 * migrates it. One helper for both paths, so the two can never drift again.
 */
function leashArgv(spec: Resolved): string[] {
  const argv: string[] = [];
  // 0 is the argv spelling of "no ceiling": a flag value cannot be null, and
  // run.ts normalises the sentinel back to null the moment it reads it.
  if (spec.maxToolCalls !== undefined) {
    argv.push("--max-tool-calls", spec.maxToolCalls === null ? "0" : String(spec.maxToolCalls));
  }
  // The wall clock keeps its own flag when it is a number (that is what every
  // existing job emits); a disabled one can only travel in the JSON.
  if (spec.episodeMs !== null) argv.push("--episode-ms", String(spec.episodeMs));
  const watchdogs = watchdogsJson(spec);
  if (watchdogs !== undefined) argv.push("--watchdogs-json", watchdogs);
  return argv;
}

export function episodeArgv(spec: Resolved, resume: boolean, opts: { container?: boolean } = {}): string[] {
  // Everything after the launcher is identical: run-episode.sh passes its
  // unknown flags through to `bun runner/src/run.ts` verbatim, so the two heads
  // are interchangeable and only one of them needs docker.
  const head = opts.container === true ? ["bun", RUNNER_ENTRY] : [EPISODE_SH];
  // Identity — driver, model, account, effort, objective, wiki, race/class,
  // episode, campaign/cell — is the resumed run's own and is never restated.
  if (resume) return [...head, "--resume", spec.runId, ...leashArgv(spec)];
  const argv = [...head, "--driver", spec.driver, "--model", spec.model, "--run-id", spec.runId];
  if (spec.driver === "openai") {
    argv.push("--api-base", spec.apiBase, "--api-key-env", spec.apiKeyEnv);
    // Only when the entry stated one: the runner derives the same default from
    // the model slug, so an unstated routing produces the argv it always did
    // and every pinned roster.test expectation stays what it was.
    if (spec.routing !== undefined) argv.push("--routing-json", JSON.stringify(spec.routing));
  }
  // The subscription lane, by NAME. Emitted only when it is not the default, so
  // every argv a pre-lane roster produced is unchanged.
  if (spec.tokenEnv !== undefined) argv.push("--token-env", spec.tokenEnv);
  if (spec.account !== undefined) argv.push("--account", spec.account);
  if (spec.effort !== undefined) argv.push("--effort", spec.effort);
  // A freeplay character's lineage and the other refs' characters on this
  // account: launch inputs, so a fresh launch only (a resume keeps the stored
  // identity and the account's hygiene does not run).
  if (spec.continueFrom !== undefined) argv.push("--continue-from", spec.continueFrom);
  if (spec.keepCharacters.length > 0) argv.push("--keep-characters", spec.keepCharacters.join(","));
  if (spec.continueDropped !== undefined) {
    argv.push("--continue-dropped", spec.continueDropped.runId, "--continue-dropped-reason", spec.continueDropped.reason);
  }
  if (spec.objective !== undefined) argv.push("--objective", spec.objective);
  // Explicit value rather than a bare flag, so the runner's argv parser never
  // has to guess whether the next token is this flag's value.
  if (spec.wikiCoords) argv.push("--wiki-coords", "true");
  // Only when the wiki is withheld: the runner defaults it on, so every argv a
  // pre-#61 roster produced is unchanged.
  if (!spec.wiki) argv.push("--wiki", "false");
  if (spec.extra) argv.push("--extra", "true");
  // The tier id rides its own flag (a string, never interpreted here); the
  // runner's argv parser ignores flags it does not know, so this is safe to
  // emit before the runner learns it.
  if (spec.episode !== undefined) argv.push("--episode", spec.episode);
  // A probe's identity. Recorded on the run rather than derived: the
  // scheduler counts these to know what a sweep still owes, and they are what
  // keeps a campaign's results grouped once its config entry is gone.
  if (spec.campaign !== undefined) argv.push("--campaign", spec.campaign);
  if (spec.cell !== undefined) argv.push("--cell", spec.cell);
  // Race and class only: the name is the model's, and the runner records it.
  argv.push("--race", String(spec.race), "--class", String(spec.class));
  return [...argv, ...leashArgv(spec)];
}

export type FreshPlan = { kind: "launch" } | { kind: "skip"; reason: string };

/**
 * Whether a spec that is NOT resuming may be launched onto its projected run
 * id. The id is a projection off the run facts the fleet can see, so a run
 * directory that yields no fact (unparseable meta.json or run.sqlite, or a
 * directory moved by hand) is invisible to the counter and the next launch
 * projects the id that is already there. The runner refuses that outright
 * (`assertRunDirFree`), so launching anyway would only turn a collision into a
 * crashed child the supervisor has to interpret.
 *
 * Gated on the DIRECTORY, not on the run row: the row being unreadable is
 * exactly the case this exists for. The spec stays in the rotation — cycle 1
 * is skipped with a reason in the log, and `freeCycle` hands it a clean `-cN`
 * on the next cycle.
 */
export function planFreshLaunch(opts: { runId: string; dirExists: boolean; resumeRoster: boolean }): FreshPlan {
  if (!opts.dirExists) return { kind: "launch" };
  return {
    kind: "skip",
    reason:
      `${opts.runId} is already a run directory on disk` +
      (opts.resumeRoster
        ? ", but it yielded no readable run row (unparseable meta.json or run.sqlite)"
        : ", and this is not --resume-roster") +
      "; not launching a second run onto the same id (the runner refuses to open it)",
  };
}

/** A cycle-2+ copy of a spec: same identity, its own run id. */
export function forCycle(spec: Resolved, cycle: number): Resolved {
  return cycle <= 1 ? spec : { ...spec, runId: `${spec.runId}-c${cycle}` };
}

/**
 * Cycle numbering restarts at 1 with the roster process, so a relaunch after a
 * ctrl-C would hand cycle 2 the run id an earlier process already used —
 * appending to its trajectory and overwriting the row classify() reads. Skip
 * forward past any cycle id that already exists on disk.
 */
function freeCycle(specs: Resolved[], cycle: number): number {
  for (let c = cycle; c < cycle + 100; c++) {
    if (specs.every((s) => !existsSync(runDir(forCycle(s, c).runId)))) return c;
  }
  return cycle;
}

// ------------------------------------------------------------- defer backoff
//
// Why a per-spec backoff instead of dropping deferred specs onto the retry
// queue: the retry queue at the end of main() is only reachable in NON-loop
// runs — under `--loop` the main cycle loop exits only on stop or deadline, and
// both disable the retry loop. So an overnight `--loop` fleet has to back a
// rate-limited model off *within* the rotation, or it either never retries
// (dropped) or hammers the saturated provider (relaunched fresh every cycle
// with no gap — the observed mimo-v2.5-free failure: 3 launches/min, all 429).
//
// A deferred spec therefore stays in the rotation but carries a `notBefore`:
// cycles before it are skipped with no launch and no session churn; the first
// cycle after it *resumes the same run id* rather than spawning a fresh L1
// `-cN`. Backoff escalates through DEFER_BACKOFF_MS on consecutive defers and
// is cleared the moment the spec finishes (`done`). After the whole ladder is
// spent the spec is TAINTED: dropped from the rotation for the rest of this
// process, because a pool that has refused for 6h is not coming back today.

export interface DeferEntry {
  /** The run id that actually paused — resume targets this, never a new -cN. */
  runId: string;
  /** now + backoff; cycles before this skip the spec without launching. */
  notBefore: number;
  /** Consecutive defers, indexes DEFER_BACKOFF_MS (clamped to the last step). */
  defers: number;
  /** The pause reason carried for the log and operator lines. */
  reason: string;
  /**
   * Out of rungs: the spec is removed from the rotation for the rest of this
   * roster process. `notBefore` is meaningless once this is set (and must not
   * be Infinity — JSON round-trips that to null), so every read gates on this
   * flag first.
   */
  tainted?: boolean;
}

export type AttemptPlan =
  | { kind: "skip"; until: number; reason: string }
  | { kind: "resume"; runId: string; reason: string }
  | { kind: "tainted"; reason: string; defers: number }
  | { kind: "fresh" };

/** Escalating backoff for the Nth consecutive defer (1-based), clamped. */
export function backoffMs(defers: number): number {
  const i = Math.min(Math.max(defers, 1) - 1, DEFER_BACKOFF_MS.length - 1);
  return DEFER_BACKOFF_MS[i]!;
}

/**
 * True once a spec has deferred more times than there are rungs — i.e. it sat
 * out the whole ladder up to 6h and still could not get a turn on the board.
 * At that point relaunching is pure noise: the pool is not coming back today.
 */
export function isTainted(defers: number): boolean {
  return defers > DEFER_BACKOFF_MS.length;
}

/** Human-readable rungs for --help and the dry-run plan ("1m/3m/.../6h"). */
export function ladder(rungs: number[]): string {
  return rungs
    .map((m) => (m >= 60 * 60_000 ? `${m / (60 * 60_000)}h` : `${m / 60_000}m`))
    .join("/");
}

export const DEFER_LADDER = ladder(DEFER_BACKOFF_MS);
export const RESUME_LADDER = ladder(RESUME_BACKOFF_MS);
export const DEFER_TAINT_AFTER = DEFER_BACKOFF_MS.length + 1;

/**
 * What a loop cycle should do with one spec, given its defer state.
 *
 *  - no entry            -> `fresh` (a healthy spec; the caller applies forCycle
 *                           for its own -cN burn sample, preserving loop semantics)
 *  - tainted entry        -> `tainted` (never launch again this process)
 *  - entry, still cooling -> `skip` (do not launch; this is what kills hammering,
 *                           and it is per-spec so a rotation-mate failing in seconds
 *                           cannot drag this spec back into a fast relaunch)
 *  - entry, cooled off    -> `resume` the *stored* run id in place
 */
export function planAttempt(entry: DeferEntry | undefined, now: number): AttemptPlan {
  if (entry === undefined) return { kind: "fresh" };
  if (entry.tainted === true) return { kind: "tainted", reason: entry.reason, defers: entry.defers };
  if (now < entry.notBefore) return { kind: "skip", until: entry.notBefore, reason: entry.reason };
  return { kind: "resume", runId: entry.runId, reason: entry.reason };
}

export type CyclePlan = AttemptPlan | { kind: "already-done" };

/**
 * planAttempt plus the one thing that is cycle-dependent: a spec whose cycle-1
 * run was already terminated when --resume-roster started. That is a statement
 * about cycle 1 only — the spec stays in the rotation and cycle 2+ launches it
 * fresh under a -cN id. Dropping it instead is what idled the jobs.
 */
export function planCycle(
  entry: DeferEntry | undefined,
  doneCycle1: boolean,
  cycle: number,
  now: number,
): CyclePlan {
  if (cycle === 1 && doneCycle1) return { kind: "already-done" };
  return planAttempt(entry, now);
}

/**
 * Record one defer against a spec's existing state and return the new entry.
 * Pure so the ladder and the taint threshold are testable without a live run.
 */
export function nextDefer(
  prev: DeferEntry | undefined,
  now: number,
  runId: string,
  reason: string,
): DeferEntry {
  const defers = (prev?.defers ?? 0) + 1;
  if (isTainted(defers)) return { runId, notBefore: now, defers, reason, tainted: true };
  return { runId, notBefore: now + backoffMs(defers), defers, reason };
}

// ------------------------------------------------------------ defer sidecar
//
// Defer state has to outlive the process: a supervisor restart or a config
// edit respawns the job, and without this a spec sitting on a 6h backoff would
// come back as `fresh` and start hammering again from rung 1. The sidecar sits
// next to the roster's --log jsonl and is keyed on the SPEC's stable cycle-1
// run id — NOT on DeferEntry.runId, which may be a -cN from a mid-loop defer.

export function deferSidecarPath(log: string): string {
  return `${log}.defer.json`;
}

export function serializeDefers(map: Map<string, DeferEntry>): string {
  return JSON.stringify({ version: 1, entries: Object.fromEntries(map) }, null, 2);
}

/** Tolerant by design: a truncated or foreign sidecar means "no state", never a crash. */
export function parseDefers(text: string): Map<string, DeferEntry> {
  const out = new Map<string, DeferEntry>();
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return out;
  }
  const entries = (raw as { entries?: unknown } | null)?.entries;
  if (entries === null || typeof entries !== "object") return out;
  for (const [key, v] of Object.entries(entries as Record<string, unknown>)) {
    const e = v as Partial<DeferEntry>;
    if (typeof e?.runId !== "string" || typeof e.defers !== "number") continue;
    out.set(key, {
      runId: e.runId,
      notBefore: typeof e.notBefore === "number" ? e.notBefore : 0,
      defers: e.defers,
      reason: typeof e.reason === "string" ? e.reason : "unknown",
      ...(e.tainted === true ? { tainted: true } : {}),
    });
  }
  return out;
}

function loadDefers(log: string): Map<string, DeferEntry> {
  const path = deferSidecarPath(log);
  if (!existsSync(path)) return new Map();
  try {
    return parseDefers(readFileSync(path, "utf8"));
  } catch {
    return new Map();
  }
}

/** Written via tmp+rename: `--status` may read this while a job is writing it. */
function saveDefers(log: string, map: Map<string, DeferEntry>, dryRun: boolean): void {
  if (dryRun || log === "") return;
  const path = deferSidecarPath(log);
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, serializeDefers(map));
    renameSync(tmp, path);
  } catch (e) {
    say(`warning: could not write defer sidecar ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// -------------------------------------------------------------- cycle gap
//
// Three distinct reasons a cycle can end, and they want different waits.

export type GapPlan =
  | { kind: "gap"; ms: number; why: string }
  | { kind: "cooling"; ms: number; why: string }
  | { kind: "none"; why: string };

/**
 * `launched` episodes ran this cycle; `cooling` specs were held on a backoff
 * with the earliest due at `earliest`. Nothing launched AND nothing cooling
 * means the cycle was a no-op (every entry already terminated under
 * --resume-roster, or tainted out) — sleeping 10m there just wastes the night,
 * and the old code printed "all models backing off", which was a lie.
 */
export function planGap(
  launched: number,
  cooling: number,
  earliest: number | undefined,
  now: number,
  nextCycle: number,
): GapPlan {
  if (launched > 0) return { kind: "gap", ms: CYCLE_GAP_MS, why: `gap before cycle ${nextCycle}` };
  if (cooling > 0 && earliest !== undefined) {
    return {
      kind: "cooling",
      ms: Math.max(0, earliest - now),
      why: `all remaining models backing off before cycle ${nextCycle}`,
    };
  }
  return { kind: "none", why: `nothing launched and nothing cooling — starting cycle ${nextCycle} immediately` };
}

// ------------------------------------------------------------------- run state

interface RunRow {
  termination_reason: string | null;
  termination_detail: string | null;
  pause_reason: string | null;
}

/**
 * A run's directory. The archive is a fallback, not a second home: the runner
 * archives a run that terminated without a single model response, and the
 * roster's own post-episode reads (the termination row, the level, the turn
 * count) happen after the child has exited — so they have to look where the
 * run actually is, or a launch that did not happen would read as one that
 * left no database at all.
 */
function runDir(runId: string): string {
  const live = join(REPO_ROOT, RUNS_DIR, runId);
  if (existsSync(live)) return live;
  const archived = join(REPO_ROOT, RUNS_DIR, ARCHIVE_DIR, runId);
  return existsSync(archived) ? archived : live;
}

function readRunRow(runId: string): RunRow | undefined {
  const path = join(runDir(runId), "run.sqlite");
  if (!existsSync(path)) return undefined;
  try {
    const db = openRunDb(path, { readonly: true });
    try {
      const row = db
        .query("SELECT termination_reason, termination_detail, pause_reason FROM run WHERE run_id = ?")
        .get(runId) as RunRow | null;
      return row ?? undefined;
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}

/** The character a resumed run will actually use, per its stored meta.json. */
function metaCharacter(runId: string): string | undefined {
  const path = join(runDir(runId), "meta.json");
  if (!existsSync(path)) return undefined;
  try {
    const meta = JSON.parse(readFileSync(path, "utf8")) as { config?: { character?: string } };
    return meta.config?.character;
  } catch {
    return undefined;
  }
}

/**
 * The session token a run actually holds. Tokens used to equal the run id;
 * since token hardening they are random secrets, so the only
 * way to address a run's module session is to read the token back out of the
 * meta.json the runner persisted. The run-id fallback covers pre-hardening
 * runs, whose token *was* the run id.
 */
function tokenOfRun(runId: string): string {
  const path = join(runDir(runId), "meta.json");
  if (!existsSync(path)) return runId;
  try {
    const meta = JSON.parse(readFileSync(path, "utf8")) as { config?: { token?: string } };
    return meta.config?.token ?? runId;
  } catch {
    return runId;
  }
}

function readLevel(runId: string): number | undefined {
  const path = join(runDir(runId), "run.sqlite");
  if (!existsSync(path)) return undefined;
  try {
    const db = openRunDb(path, { readonly: true });
    try {
      const row = db.query("SELECT MAX(level) AS lvl FROM state WHERE run_id = ?").get(runId) as
        | { lvl: number | null }
        | null;
      return row?.lvl ?? undefined;
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}

/**
 * Turns made by *this* attempt. A resumed run appends to the same trajectory,
 * so a whole-file count would read "one turn, twice" as a healthy two-turn run
 * and retry something that never got off the ground. Not available from sqlite
 * at all — the run table has no turn column.
 */
function turnsSince(runId: string, sinceTs: number): number {
  const path = join(runDir(runId), "trajectory.jsonl");
  if (!existsSync(path)) return 0;
  let n = 0;
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (line.length === 0 || !line.includes('"response"')) continue;
      try {
        const ev = JSON.parse(line) as { t?: string; ts?: number };
        if (ev.t === "response" && typeof ev.ts === "number" && ev.ts >= sinceTs) n++;
      } catch {
        // a torn last line while the runner is still writing: ignore
      }
    }
  } catch {
    return n;
  }
  return n;
}

// ------------------------------------------------------------- account guard

/**
 * The core allows one live session per game account, and the module answers
 * `account_in_use` to the second createSession. Two roster processes (the
 * two-wide pattern) or a hand-started run therefore have to stay off each
 * other's account.
 *
 * `freeSession` cannot be the answer here: it is keyed on the run's own stored
 * token, so it only ever frees the session of the very run the roster is about to launch
 * or resume — never someone else's. Freeing another run's session would kick a
 * *running* process out of the world. So the guard only reads, and waits.
 *
 * "Live" is inferred from the run's own files: no termination row and a write
 * in the last few minutes. A crashed run — no termination row, cold files — is
 * not live and is not waited on. Deliberately no process scan: the
 * only pattern available for one (`*run.ts*<runId>*`, as in signalInContainer)
 * is a substring match, and `roster-x-<date>` is a prefix of the loop's
 * `roster-x-<date>-c2`, so cycle 2 would see cycle 1 as forever alive.
 * The spec's own run id is always excluded — a `--resume` attempt would
 * otherwise refuse to launch the entry it is guarding, forever.
 */
function accountOfRun(runId: string): string | undefined {
  const path = join(runDir(runId), "meta.json");
  if (!existsSync(path)) return undefined;
  try {
    const meta = JSON.parse(readFileSync(path, "utf8")) as { config?: { account?: string } };
    return meta.config?.account;
  } catch {
    return undefined;
  }
}

/** Age of the most recently touched artefact of a run, whichever it is. */
function activityAgeMs(runId: string): number | undefined {
  let newest: number | undefined;
  for (const name of ["trajectory.jsonl", "run.sqlite"]) {
    try {
      const m = statSync(join(runDir(runId), name)).mtimeMs;
      if (newest === undefined || m > newest) newest = m;
    } catch {
      // not written yet
    }
  }
  return newest === undefined ? undefined : Date.now() - newest;
}

/** @returns the run id holding `account`, or undefined when it is free. */
export function accountHeldBy(account: string | undefined, ownRunId: string): string | undefined {
  const want = (account ?? "RUNNER").toUpperCase();
  let dirs: string[];
  try {
    dirs = readdirSync(join(REPO_ROOT, RUNS_DIR));
  } catch {
    return undefined;
  }
  for (const id of dirs) {
    if (id === ownRunId) continue;
    /*
     * The age test first, because it is two stats and every other test is a
     * file parse or a database open. A run whose newest artefact is colder
     * than LIVE_TRAJECTORY_MS cannot be the holder however it ended, so
     * hoisting the cheapest term of the conjunction skips the meta.json read
     * and the run.sqlite open for every finished run in the directory —
     * which is all of them but a handful (item 24). The answer is
     * unchanged: same conjunction, same readdir order, same first match.
     */
    const age = activityAgeMs(id);
    if (age === undefined || age >= LIVE_TRAJECTORY_MS) continue;
    const acct = accountOfRun(id);
    if (acct === undefined || acct.toUpperCase() !== want) continue;
    const row = readRunRow(id);
    if (row !== undefined && row.termination_reason !== null && row.termination_reason !== "") continue;
    // A pause row means the session is already gone: every path in attemptSpec
    // that leaves a paused run behind frees its session first, and
    // pause_reason is only cleared by --resume. Without this skip, the
    // activity-age test parks the job for LIVE_TRAJECTORY_MS behind
    // its own just-deferred run's still-warm trajectory (fleet-free-or-a
    // waited 3m behind its deferred glm run, 2026-08-22). A hand-paused run
    // whose operator kept the session alive is the module's to defend: the
    // next createSession fails loudly with account_owned_by_other_token.
    if (row !== undefined && row.pause_reason !== null && row.pause_reason !== "") continue;
    return id;
  }
  return undefined;
}

/** @returns true when the account came free (or was never held). */
async function awaitAccount(
  spec: Resolved,
  deadline: number | undefined,
  dryRun: boolean,
): Promise<boolean> {
  if (dryRun) return true;
  const giveUp = Date.now() + ACCOUNT_WAIT_MAX_MS;
  for (;;) {
    const holder = accountHeldBy(spec.account, spec.runId);
    if (holder === undefined) return true;
    if (stopping || Date.now() >= giveUp || (deadline !== undefined && Date.now() >= deadline)) {
      say(`account ${spec.account ?? "RUNNER"} still held by ${holder} — skipping ${spec.runId}`);
      record({
        runId: spec.runId,
        model: spec.model,
        outcome: "skipped",
        detail: `account ${spec.account ?? "RUNNER"} in use by ${holder}`,
      });
      return false;
    }
    say(`account ${spec.account ?? "RUNNER"} is live under ${holder} — waiting before ${spec.runId}`);
    await nap(ACCOUNT_WAIT_POLL_MS, deadline, `account ${spec.account ?? "RUNNER"} held by ${holder}`);
  }
}

// ------------------------------------------------------------------ output

let logPath = "";

function stamp(ts: number = Date.now()): string {
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function say(line: string): void {
  console.log(`[${stamp()}] ${line}`);
}

function record(entry: {
  runId: string;
  model: string;
  outcome: Outcome;
  level?: number;
  detail?: string;
}): void {
  if (logPath === "") return;
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, JSON.stringify({ ts: Date.now(), ...entry }) + "\n");
}

// ------------------------------------------------------------------ process

let stopping = false;
let child: ReturnType<typeof Bun.spawn> | undefined;
let childRunId: string | undefined;
const wakeups: (() => void)[] = [];

/**
 * Signal the runner *inside* the container.
 *
 * Verified by hand: SIGTERM to the local `docker compose exec` process does NOT
 * reach the process it started in the container — the exec'd command survives
 * and would be orphaned. So the signal has to be delivered on the other side.
 * Scoped to the run id (which appears in the runner's argv as `--run-id` or
 * `--resume`) so a parallel claude-code run in the same container is never hit.
 *
 * A no-op when the roster is itself inside the container: there the episode is
 * our direct child, so `child.kill()` reaches it and there is no docker CLI to
 * exec with anyway.
 */
function signalInContainer(runId: string, signal: "TERM" | "KILL"): void {
  if (CONTAINER) return;
  const sh =
    `for d in /proc/[0-9]*; do c=$(tr "\\0" " " < $d/cmdline 2>/dev/null); ` +
    `case "$c" in *run.ts*${runId}*) kill -${signal} "\${d#/proc/}" 2>/dev/null ;; esac; done`;
  try {
    Bun.spawnSync(["docker", "compose", "-f", COMPOSE_FILE, "exec", "-T", "runner", "sh", "-c", sh], {
      cwd: REPO_ROOT,
      stdout: "ignore",
      stderr: "ignore",
    });
  } catch {
    // best effort
  }
}

function requestStop(sig: string): void {
  if (stopping) process.exit(130);
  stopping = true;
  say(`${sig}: no further episodes will be launched`);
  for (const w of wakeups.splice(0)) w();
  if (child !== undefined) {
    const c = child;
    const id = childRunId;
    say(`${sig}: pausing the running episode — the runner pauses as operator-pause on SIGTERM (grace ${CHILD_TERM_GRACE_MS / 1000}s)`);
    c.kill("SIGTERM");
    if (id !== undefined) signalInContainer(id, "TERM");
    setTimeout(() => {
      if (id !== undefined) signalInContainer(id, "KILL");
      try {
        c.kill("SIGKILL");
      } catch {
        // already gone
      }
    }, CHILD_TERM_GRACE_MS).unref();
  }
}

/** Sleep that wakes early on stop, and never sleeps past the budget. */
async function nap(ms: number, deadline: number | undefined, why: string): Promise<void> {
  let capped = ms;
  if (deadline !== undefined) capped = Math.min(capped, Math.max(0, deadline - Date.now()));
  if (capped <= 0 || stopping) return;
  say(`waiting ${Math.round(capped / 60_000)}m — ${why}`);
  await new Promise<void>((res) => {
    const timer = setTimeout(res, capped);
    wakeups.push(() => {
      clearTimeout(timer);
      res();
    });
  });
}

async function runEpisode(spec: Resolved, resume: boolean): Promise<number> {
  const argv = episodeArgv(spec, resume, { container: CONTAINER });
  childRunId = spec.runId;
  child = Bun.spawn(argv, {
    cwd: REPO_ROOT,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit", // the runner's operator lines all go to stderr
    // On the host run-episode.sh stamps this; in the container we are the
    // launcher, so we stamp it. Secrets still never travel via argv or env
    // from here: Bun loads /wrathbench/.env in the child itself.
    ...(CONTAINER ? { env: { ...process.env, WRATHBENCH_HARNESS_VERSION: harnessVersion() } } : {}),
  });
  const code = await child.exited;
  child = undefined;
  childRunId = undefined;
  return code;
}

/**
 * Free the game account held by a paused run's still-live module session.
 * Best effort: the module is only reachable from inside the compose network.
 */
async function freeSession(spec: { runId: string; model: string }, why: string, dryRun: boolean): Promise<void> {
  if (dryRun) {
    say(`dry-run: would free module session for ${spec.runId} (${why})`);
    return;
  }
  const detail = await releaseRunSession(spec.runId);
  if (detail.startsWith("failed:")) {
    say(`could not free session for ${spec.runId}: ${detail}`);
    record({ runId: spec.runId, model: spec.model, outcome: "session-freed", detail });
    return;
  }
  say(`freed session for ${spec.runId} (${why}) — ${detail}`);
  record({ runId: spec.runId, model: spec.model, outcome: "session-freed", detail: `${why}; ${detail}` });
}

/**
 * DELETE the module session a run's token names, and return what happened.
 *
 * The transport only — no roster logging, no defer bookkeeping — so the fleet
 * supervisor can release the account of a run it just ended without
 * pulling the roster's own log with it. Best effort by construction: a failure
 * comes back as a `failed: …` string rather than throwing, because the caller
 * is always doing something else that matters more.
 */
export async function releaseRunSession(runId: string): Promise<string> {
  // Inside the container the module is one fetch away; on the host it is only
  // reachable from the compose network, hence the exec hop.
  if (CONTAINER) {
    const url = (process.env.WRATHBENCH_MODULE_URL ?? "http://worldserver:8086") + "/session";
    try {
      const r = await fetch(url, {
        method: "DELETE",
        // Operator class: the roster holds the port secret, not the run's lease.
        headers: { "content-type": "application/json", ...moduleAuthHeaders() },
        body: JSON.stringify({ token: tokenOfRun(runId) }),
      });
      return `delete-session ${r.status} ${(await r.text()).trim()}`;
    } catch (e) {
      return `failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // The exec'd bun autoloads /wrathbench/.env, which is where the port secret
  // lives (module/PROTOCOL.md "Authentication").
  const code = `const url=(process.env.WRATHBENCH_MODULE_URL??"http://worldserver:8086")+"/session";
const s=process.env.WRATHBENCH_MODULE_SECRET;const h={"content-type":"application/json",...(s?{authorization:"Bearer "+s}:{})};
const r=await fetch(url,{method:"DELETE",headers:h,body:JSON.stringify({token:process.env.WB_TOKEN})});
console.log("delete-session",r.status,await r.text());`;
  try {
    const p = Bun.spawn(
      ["docker", "compose", "-f", COMPOSE_FILE, "exec", "-T", "-e", `WB_TOKEN=${tokenOfRun(runId)}`, "runner", "bun", "-e", code],
      { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" },
    );
    const out = (await new Response(p.stdout).text()).trim();
    const err = (await new Response(p.stderr).text()).trim();
    const rc = await p.exited;
    return rc === 0 ? out || "no output" : `failed: exit ${rc}: ${err || out}`;
  } catch (e) {
    return `failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}

// ------------------------------------------------------------------ classify

type Verdict =
  | { kind: "launch-failed"; detail: string }
  | { kind: "terminated"; reason: string; detail: string | undefined }
  | { kind: "paused"; reason: string }
  | { kind: "unknown"; detail: string };

function classify(spec: Resolved, exitCode: number): Verdict {
  const row = readRunRow(spec.runId);
  if (row === undefined) {
    return { kind: "launch-failed", detail: `exit ${exitCode}, no run.sqlite for ${spec.runId}` };
  }
  // Termination first: `--resume` clears the pause row, but checking in this
  // order is correct either way.
  if (row.termination_reason !== null && row.termination_reason !== "") {
    return {
      kind: "terminated",
      reason: row.termination_reason,
      detail: row.termination_detail ?? undefined,
    };
  }
  if (row.pause_reason !== null && row.pause_reason !== "") {
    return { kind: "paused", reason: row.pause_reason };
  }
  return { kind: "unknown", detail: `exit ${exitCode}, run row has neither termination nor pause` };
}

const RATE_PAUSES = new Set(["rate-limited", "quota-exhausted", "window-exhausted"]);

// ------------------------------------------------------------------ main

interface Attempt {
  spec: Resolved;
  resume: boolean;
  /**
   * --resume-roster found this spec's cycle-1 run already terminated. Cycle 1
   * is done for it; later loop cycles still give it a fresh -cN. It used to be
   * dropped from `pending` outright, which idled a whole job: five of six
   * fleet jobs spent 2026-08-22 16:48-17:01 logging "restarting the roster
   * (0 episode(s))" every cycle because every entry had finished cycle 1.
   */
  doneCycle1?: boolean;
}

/** @returns true when the spec is finished with (done or given up on). */
async function attemptSpec(
  spec: Resolved,
  opts: { resume: boolean; deadline: number | undefined; dryRun: boolean },
): Promise<"done" | "defer"> {
  let resume = opts.resume;
  // run-episode.sh's driver preflight does not run on the in-container path, and
  // its one load-bearing check is this: without the token every claude episode
  // burns a session setup to fail at the first turn.
  if (CONTAINER && spec.driver === "codex" && !opts.dryRun) {
    // Same shape for the Codex lane: the variable names a CODEX_HOME directory,
    // and without it the CLI has no login to bill.
    const laneEnv = spec.tokenEnv ?? DEFAULT_CODEX_HOME_ENV;
    const home = process.env[laneEnv];
    if (home === undefined || home.trim().length === 0) {
      const detail =
        `${laneEnv} is not visible to the fleet container — put it in /wrathbench/.env as the path of a ` +
        "logged-in Codex home (`codex login`); it is loaded by Bun there and never passed via argv";
      say(`launch-failed ${spec.runId}: ${detail}`);
      record({ runId: spec.runId, model: spec.model, outcome: "launch-failed", detail });
      return "done";
    }
  }
  if (CONTAINER && spec.driver === "claude-code" && !opts.dryRun) {
    // The CHOSEN lane's variable, and the message names it: with two
    // subscriptions the useful sentence is which one is missing.
    const tokenEnv = spec.tokenEnv ?? DEFAULT_CLAUDE_TOKEN_ENV;
    const token = process.env[tokenEnv];
    if (token === undefined || token.trim().length === 0) {
      const detail =
        `${tokenEnv} is not visible to the fleet container — put it in /wrathbench/.env ` +
        "(`claude setup-token`), it is loaded by Bun there and never passed via argv";
      say(`launch-failed ${spec.runId}: ${detail}`);
      record({ runId: spec.runId, model: spec.model, outcome: "launch-failed", detail });
      return "done";
    }
  }
  for (let retry = 0; ; retry++) {
    if (!(await awaitAccount(spec, opts.deadline, opts.dryRun))) return "done";
    await freeSession(spec, resume ? "pre-resume hygiene" : "pre-launch hygiene", opts.dryRun);
    const launchTs = Date.now();
    // The name is the model's own and is not known until it creates the
    // character, so the launch line has none to print.
    say(`launch ${spec.model} as ${spec.runId}${resume ? " (--resume)" : ""}`);
    const code = await runEpisode(spec, resume);
    const verdict = classify(spec, code);
    const level = readLevel(spec.runId);
    const turns = turnsSince(spec.runId, launchTs);

    if (verdict.kind === "launch-failed") {
      say(`launch-failed ${spec.runId}: ${verdict.detail}`);
      record({ runId: spec.runId, model: spec.model, outcome: "launch-failed", detail: verdict.detail });
      return "done";
    }
    if (verdict.kind === "unknown") {
      say(`unknown outcome ${spec.runId}: ${verdict.detail} — advancing`);
      record({
        runId: spec.runId,
        model: spec.model,
        outcome: "unknown",
        ...(level !== undefined ? { level } : {}),
        detail: verdict.detail,
      });
      await freeSession(spec, "unknown outcome", opts.dryRun);
      return "done";
    }
    if (verdict.kind === "terminated") {
      const failed =
        verdict.reason === "adapter-error" || verdict.reason === "harness-error" || verdict.reason === "stale-character";
      say(
        `done ${spec.runId}: terminated ${verdict.reason}${level !== undefined ? `, level ${level}` : ""}`,
      );
      record({
        runId: spec.runId,
        model: spec.model,
        outcome: failed ? "done-failed" : "done",
        ...(level !== undefined ? { level } : {}),
        detail: `${verdict.reason}${verdict.detail !== undefined ? `: ${verdict.detail}` : ""}; turns ${turns}`,
      });
      return "done";
    }

    // paused
    //
    // A run of a lane that does not resume is a FAILED ATTEMPT, not
    // a suspension. It is ended here — through the runner's own termination
    // writer, the one path anything writes a termination on — its session is
    // freed so the account and character go back, and the scheduler gives the
    // model a fresh attempt with a new run id and a full clock. That covers
    // every pause reason at once, so none of the branches below (the operator
    // pause, the claude-code no-defer rule, the in-place retry, the defer
    // ladder) is reachable for a scored eval any more: each of them ends in
    // `--resume <this run id>`, which is exactly what this record forbids.
    if (!spec.resumeOnPause) {
      const lapse = classifyLapse({ episode: spec.episode, pause: { reason: verdict.reason }, staleForMs: null });
      const reason = lapse.reason ?? "attempt-failed";
      say(`failed attempt ${spec.runId}: ${verdict.reason} — ${lapse.detail ?? reason}`);
      await freeSession(spec, `failed attempt (${verdict.reason})`, opts.dryRun);
      try {
        const t = new Trajectory(runDir(spec.runId));
        try {
          t.setTermination(spec.runId, reason, lapse.detail);
        } finally {
          t.close();
        }
      } catch (e) {
        say(`could not write the termination for ${spec.runId}: ${e instanceof Error ? e.message : String(e)}`);
      }
      record({
        runId: spec.runId,
        model: spec.model,
        outcome: "done-failed",
        ...(level !== undefined ? { level } : {}),
        detail: `${reason}: ${lapse.detail ?? verdict.reason}; turns ${turns}`,
      });
      return "done";
    }
    if (verdict.reason === "operator-pause") {
      // The supervisor stopped under it (or an operator SIGTERMed the runner):
      // the run is suspended with its clock and session released by the
      // runner itself. The fleet resumes it on its next boot — same
      // run id, same account, same character. Nothing to free, nothing to
      // retry here.
      say(
        `paused ${spec.runId}: operator-pause${level !== undefined ? `, level ${level}` : ""} — ` +
          (stopping ? "stopping; the fleet resumes it on boot" : "left for the supervisor to resume, advancing"),
      );
      record({
        runId: spec.runId,
        model: spec.model,
        outcome: "paused-operator",
        ...(level !== undefined ? { level } : {}),
        detail: `operator-pause; ${stopping ? "supervisor stop" : "runner was signalled"}; resumable with --resume; turns ${turns}`,
      });
      return "done";
    }
    if (!RATE_PAUSES.has(verdict.reason)) {
      say(`paused ${spec.runId}: ${verdict.reason} — leaving it for the operator, advancing`);
      record({
        runId: spec.runId,
        model: spec.model,
        outcome: "paused-operator",
        ...(level !== undefined ? { level } : {}),
        detail: verdict.reason,
      });
      await freeSession(spec, `paused ${verdict.reason}`, opts.dryRun);
      return "done";
    }

    // The defer/retry queue exists for OpenRouter's per-provider free-tier
    // pools: another model's pool may be open while this one is saturated, so
    // advancing and coming back is the useful move. A Claude subscription has
    // no such per-provider structure — its episodes end at the episode or
    // tool-call limit, and a pause that does happen will not be cleared by
    // running a different model first. So a claude entry never defers: it is
    // recorded and the roster advances.
    if (spec.driver === "claude-code" || spec.driver === "codex") {
      say(`paused ${spec.runId}: ${verdict.reason} (${spec.driver} — no defer queue), advancing`);
      record({
        runId: spec.runId,
        model: spec.model,
        outcome: "paused-operator",
        ...(level !== undefined ? { level } : {}),
        detail: `${verdict.reason}; ${spec.driver} entries are not deferred; turns ${turns}`,
      });
      await freeSession(spec, `paused ${verdict.reason}`, opts.dryRun);
      return "done";
    }

    const early = turns < EARLY_TURN_THRESHOLD;
    const outOfRetries = retry >= RESUME_BACKOFF_MS.length;
    if (early || outOfRetries || stopping) {
      const why = stopping
        ? "stopping"
        : early
          ? `early saturation (${turns} turn(s) this attempt)`
          : `still ${verdict.reason} after ${retry} retries`;
      say(`defer ${spec.model} (${spec.runId}): ${why}`);
      record({
        runId: spec.runId,
        model: spec.model,
        outcome: "deferred",
        ...(level !== undefined ? { level } : {}),
        detail: `${verdict.reason}; ${why}; deferred runs resume onto a wiped account (character recreated at level 1)`,
      });
      // The paused session still holds the shared account. Free it before the
      // next model starts, or every createSession there fails account_in_use.
      await freeSession(spec, `deferred while ${verdict.reason}`, opts.dryRun);
      return "defer";
    }

    const backoff = RESUME_BACKOFF_MS[retry]!;
    say(
      `retry ${spec.runId} in ${backoff / 60_000}m (${verdict.reason} mid-episode, ${turns} turns this attempt, attempt ${retry + 1}/${RESUME_BACKOFF_MS.length})`,
    );
    record({
      runId: spec.runId,
      model: spec.model,
      outcome: "retry",
      ...(level !== undefined ? { level } : {}),
      detail: `${verdict.reason}; backoff ${backoff}ms; attempt ${retry + 1}/${RESUME_BACKOFF_MS.length}`,
    });
    await nap(backoff, opts.deadline, `backoff before resuming ${spec.runId}`);
    if (stopping || (opts.deadline !== undefined && Date.now() >= opts.deadline)) {
      say(`budget reached during backoff — deferring ${spec.runId}`);
      record({ runId: spec.runId, model: spec.model, outcome: "deferred", detail: "budget reached during backoff" });
      await freeSession(spec, "budget reached during backoff", opts.dryRun);
      return "defer";
    }
    resume = true;
  }
}

function computeDeadline(until: string | undefined, maxHours: number | undefined): number | undefined {
  const now = Date.now();
  const candidates: number[] = [];
  if (until !== undefined) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(until);
    if (m === null) throw new Error(`--until wants HH:MM, got ${until}`);
    const d = new Date();
    d.setHours(Number(m[1]), Number(m[2]), 0, 0);
    // Overnight script: a time already past means tomorrow.
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    candidates.push(d.getTime());
  }
  if (maxHours !== undefined) {
    if (!Number.isFinite(maxHours) || maxHours <= 0) throw new Error(`--max-hours wants a positive number`);
    candidates.push(now + maxHours * 3_600_000);
  }
  return candidates.length === 0 ? undefined : Math.min(...candidates);
}

async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2));
  if (args.roster === undefined) {
    console.error("run-roster: a roster JSON file path is required");
    usage();
    process.exit(2);
  }
  const rosterPath = args.roster;
  if (!existsSync(rosterPath)) {
    console.error(`run-roster: no such roster file: ${rosterPath}`);
    process.exit(2);
  }
  const raw = JSON.parse(readFileSync(rosterPath, "utf8")) as unknown;
  if (!Array.isArray(raw)) {
    console.error(`run-roster: ${rosterPath} must contain a JSON array of specs`);
    process.exit(2);
  }
  if (args.date !== undefined && !/^\d{8}$/.test(args.date)) {
    console.error(`run-roster: --date wants YYYYMMDD, got ${args.date}`);
    process.exit(2);
  }
  const stampToday = args.date ?? dateStamp();
  let specs = resolve(raw as RosterSpec[], stampToday);
  const skip = new Set(args.skip);
  if (skip.size > 0) {
    const before = specs.length;
    specs = specs.filter((s) => !skip.has(s.model));
    say(`skipping ${before - specs.length} model(s): ${[...skip].join(", ")}`);
  }
  const deadline = computeDeadline(args.until, args.maxHours);
  // --loop with no deadline used to be refused, on the theory that an
  // unbounded loop is always an operator mistake. The fleet-as-a-service shape
  // makes it the normal case: the supervisor is up while the machine
  // is up and steering is done through the config store, not by a wall clock. The
  // stop conditions remain available as optional caps.
  if (args.loop && deadline === undefined) {
    say("--loop with no --until/--max-hours: looping until stopped (SIGTERM/SIGINT, or the job is disabled)");
  }
  logPath = args.log ?? join(REPO_ROOT, RUNS_DIR, `roster-${stampToday}.jsonl`);

  let pending: Attempt[] = [];
  for (const spec of specs) {
    const row = readRunRow(spec.runId);
    if (args.resumeRoster && row !== undefined) {
      if (row.termination_reason !== null && row.termination_reason !== "") {
        say(
          `skip ${spec.model} (${spec.runId}): already terminated ${row.termination_reason}` +
            ` (cycle 1 only — under --loop it gets a fresh -cN next cycle)`,
        );
        if (!args.dryRun) {
          record({
            runId: spec.runId,
            model: spec.model,
            outcome: "skipped",
            ...(readLevel(spec.runId) !== undefined ? { level: readLevel(spec.runId)! } : {}),
            detail: `resume-roster: already terminated ${row.termination_reason}; kept in the rotation for later loop cycles`,
          });
        }
        pending.push({ spec, resume: false, doneCycle1: true });
        continue;
      }
      say(
        `resume-roster: ${spec.model} (${spec.runId}) will continue with --resume` +
          (row.pause_reason !== null && row.pause_reason !== "" ? ` (paused ${row.pause_reason})` : ""),
      );
      pending.push({ spec, resume: true });
      continue;
    }
    const fresh = planFreshLaunch({
      runId: spec.runId,
      dirExists: existsSync(runDir(spec.runId)),
      resumeRoster: args.resumeRoster === true,
    });
    if (fresh.kind === "skip") {
      say(`skip ${spec.model} (${spec.runId}): ${fresh.reason} (cycle 1 only — under --loop it gets a fresh -cN next cycle)`);
      if (!args.dryRun) {
        record({ runId: spec.runId, model: spec.model, outcome: "skipped", detail: fresh.reason });
      }
      pending.push({ spec, resume: false, doneCycle1: true });
      continue;
    }
    if (args.resumeRoster && row === undefined) {
      say(
        `resume-roster: no existing run for ${spec.runId} — launching fresh` +
          ` (if you expected a resume, the date stamp moved: pass --date <the original YYYYMMDD>)`,
      );
    }
    pending.push({ spec, resume: false });
  }

  const doneAlready = pending.filter((a) => a.doneCycle1 === true).length;
  say(
    `roster ${rosterPath}: ${pending.length} episode(s)` +
      (doneAlready > 0 ? ` (${doneAlready} skipped for cycle 1 — already terminated, or the run id is taken; kept for later --loop cycles)` : "") +
      `, log ${logPath}` +
      (deadline !== undefined ? `, stop launching at ${new Date(deadline).toLocaleString()}` : ", no wall-clock budget"),
  );

  if (args.dryRun) {
    console.log("\n--- plan (dry run; nothing launched, nothing logged) ---");
    for (const [i, a] of pending.entries()) {
      const s = a.spec;
      // A resumed episode reloads identity from meta.json; the derived values
      // here would be a lie, so show what it will actually use.
      const endpoint =
        s.driver === "openai"
          ? `   apiBase   ${s.apiBase} (key env ${s.apiKeyEnv})\n` +
            (isOpenRouterBase(s.apiBase)
              ? `   routing   ${routingLabel(resolveRouting(s.routing, undefined, s.model, { effort: s.effort }))}${s.routing === undefined ? " [default: the model author's own provider]" : ""}\n`
              : "")
          : s.driver === "codex"
            ? `   endpoint  codex CLI subscription, lane ${s.tokenEnv ?? DEFAULT_CODEX_HOME_ENV} (no api-base/api-key-env)\n`
            : `   endpoint  claude CLI subscription (no api-base/api-key-env)\n`;
      const cycle1 = a.doneCycle1 === true ? " [cycle 1 skipped (already terminated, or its run id is taken) — launches fresh from cycle 2 under --loop]" : "";
      const identity = a.resume
        ? `   identity  from ${join(RUNS_DIR, s.runId, "meta.json")} (character ${metaCharacter(s.runId) ?? "unknown"})`
        : `   driver    ${s.driver}, account ${s.account ?? "RUNNER (runner default)"}, effort ${s.effort ?? "unset (provider default)"}\n` +
          `   character named by the model at createSession; race ${s.race}, class ${s.class} fixed\n` +
          endpoint +
          `   episodeMs ${s.episodeMs === null ? "disabled (no wall clock)" : `${s.episodeMs} (${s.episodeMs / 60_000}m)`}` +
          (s.objective !== undefined ? `\n   objective ${s.objective}  [UNSCORED]` : "") +
          (s.wikiCoords ? `\n   wiki coords served (unscored-lane setting; see docs/METHODOLOGY.md)` : "") +
          (s.wiki ? "" : `\n   NO reference wiki: no search_reference tool, and the prompt does not name it`) +
          (watchdogsJson(s) !== undefined ? `\n   watchdogs ${watchdogsJson(s)}` : "") +
          (s.maxToolCalls !== undefined ? `\n   maxTools  ${s.maxToolCalls}` : "");
      console.log(
        `\n${i + 1}. ${s.model}${cycle1}\n   runId     ${s.runId}\n${identity}\n   pre-launch: DELETE /session with ${s.runId}'s stored token ${CONTAINER ? "(direct fetch to the module)" : "via docker compose exec -T runner"}\n   argv      ${episodeArgv(s, a.resume, { container: CONTAINER }).join(" ")}`,
      );
    }
    if (args.freeTokens.length > 0) {
      console.log(`\npre-roster: DELETE /session for tokens ${args.freeTokens.join(", ")}`);
    }
    if (args.loop) {
      console.log(
        `\nloop: after the last entry the roster starts over until the budget is spent, with a` +
          `\n      ${CYCLE_GAP_MS / 60_000}m gap between cycles (never spins faster than the backoff).` +
          `\n      A HEALTHY spec gets a fresh burn sample under a -cN run id each cycle:` +
          `\n      ${pending.map((a) => forCycle(a.spec, 2).runId).join(", ")}` +
          `\n      A spec that deferred rate-limited does NOT get a fresh -cN: it is skipped while` +
          `\n      cooling and then RESUMED on its own run id in place (backoff ${DEFER_LADDER}, escalating;` +
          `\n      tainted out of the rotation after ${DEFER_TAINT_AFTER} consecutive defers).`,
      );
    }
    console.log(
      `\nguard:  an entry waits (poll ${ACCOUNT_WAIT_POLL_MS / 60_000}m, give up after ${ACCOUNT_WAIT_MAX_MS / 60_000}m)` +
        ` while another run holds its account — no termination row\n        and a write in the last` +
        ` ${LIVE_TRAJECTORY_MS / 60_000}m. Never frees another run's session.` +
        `\n        accounts in this roster: ${[...new Set(pending.map((a) => a.spec.account ?? "RUNNER (default)"))].join(", ")}`,
    );
    console.log(
      `\npolicy: terminated -> done | paused rate-limited/quota-exhausted with <${EARLY_TURN_THRESHOLD} turns -> defer` +
        `\n        claude-code and codex entries never defer (no per-provider pools to wait on)` +
        `\n        mid-episode pause -> --resume with backoff ${RESUME_LADDER}, then defer` +
        `\n        deferred spec -> per-spec backoff (${DEFER_LADDER}, escalating): skipped while cooling,` +
        `\n        then RESUMED in place on its own run id (never relaunched fresh at L1); TAINTED` +
        `\n        (dropped from the rotation) on consecutive defer ${DEFER_TAINT_AFTER}. Resume` +
        `\n        restores trajectory + scratchpad but NOT level — a rotation-mate's fresh launch wipes` +
        `\n        the shared account, so a resumed character is recreated at level 1.` +
        `\n        non-loop retry queue: up to ${MAX_RETRY_CYCLES} cycle(s), ${CYCLE_GAP_MS / 60_000}m gap before each (loop mode` +
        `\n        resumes in the rotation instead)` +
        `\n        roster log: ${logPath}`,
    );
    return;
  }

  process.on("SIGINT", () => requestStop("SIGINT"));
  process.on("SIGTERM", () => requestStop("SIGTERM"));

  // Stale sessions from hand-started runs hold the shared account too.
  for (const token of args.freeTokens) {
    await freeSession({ runId: token, model: "(external)" }, "pre-roster account release", false);
  }

  // Defer state, keyed on each spec's stable (cycle-1) run id. This is the one
  // source of truth for what is backed off: the retry queue below is derived
  // from it at loop exit, so a spec can never be both relaunched fresh AND
  // retried (the old code pushed to `queue` while the spec also stayed in the
  // rotation — double-booking that spawned a fresh L1 -cN every cycle).
  // Persisted across process restarts (see the defer sidecar section): without
  // this, a supervisor restart or a config edit would hand a spec sitting
  // on a 6h backoff a `fresh` plan and start the hammering over at rung 1.
  // Loaded unconditionally, not just under --resume-roster: the sidecar is
  // scoped by the --log path (which carries the date stamp), so it can only
  // exist if a previous process for THIS roster and date wrote it — and the
  // fleet's respawn path decides --resume-roster from the jsonl's existence,
  // which is exactly the case we must not miss.
  const deferred = loadDefers(logPath);
  if (deferred.size > 0) {
    say(
      `reloaded defer state for ${deferred.size} spec(s) from ${deferSidecarPath(logPath)}` +
        ` (${[...deferred.values()].filter((e) => e.tainted === true).length} tainted)`,
    );
  }
  const roster: Attempt[] = [...pending];
  /** Dropped from the rotation this process; reported at exit. */
  const taintedModels = new Set<string>();

  /** Prune tainted specs out of the rotation, once, loudly. */
  const pruneTainted = (): void => {
    const keep: Attempt[] = [];
    for (const a of pending) {
      const entry = deferred.get(a.spec.runId);
      if (entry?.tainted === true) {
        if (!taintedModels.has(a.spec.model)) {
          taintedModels.add(a.spec.model);
          say(
            `TAINTED ${a.spec.model} (${a.spec.runId}): ${entry.defers} consecutive defers (${entry.reason})` +
              ` — the whole ${DEFER_LADDER} ladder is spent, dropping it from the rotation for this roster process`,
          );
          record({
            runId: entry.runId,
            model: a.spec.model,
            outcome: "tainted",
            detail: `${entry.defers} consecutive defers; last reason ${entry.reason}; removed from the rotation`,
          });
        }
        continue;
      }
      keep.push(a);
    }
    pending = keep;
  };

  pruneTainted();
  for (let cycle = 1; ; cycle++) {
    // Cycle 1 is the roster as written (so a non-loop run is byte-identical to
    // before; the map is empty, so every spec plans `fresh`). Later cycles give
    // each *healthy* spec a fresh run under a -cN run id — reusing the id would
    // append to one trajectory and overwrite the run row classify() reads.
    // A fresh episode wipes the account's characters first, so a cycle-N burn
    // sample starts at level 1 whatever the model names its new one. Loop mode
    // burns tokens; it does not accumulate progress.
    //
    // A spec that deferred (rate-limited) does NOT get a fresh -cN here: it is
    // either skipped (still cooling) or resumed in place. freeCycle only needs
    // to dodge collisions among the specs that will actually launch fresh.
    const freshBases = pending.filter((a) => !deferred.has(a.spec.runId)).map((a) => a.spec);
    const n = cycle === 1 ? 1 : freeCycle(freshBases.length > 0 ? freshBases : pending.map((a) => a.spec), cycle);
    if (cycle > 1) say(`loop cycle ${n}: restarting the roster (${pending.length} episode(s))`);
    let launched = 0;
    let cooling = 0;
    let earliest: number | undefined;
    for (const a of pending) {
      if (stopping) break;
      const plan = planCycle(deferred.get(a.spec.runId), a.doneCycle1 === true, cycle, Date.now());
      // Cycle 1 already ran for this spec (--resume-roster found it terminated).
      // No nap is owed for it either: planGap only counts cooling specs.
      if (plan.kind === "already-done") continue;
      // Belt and braces: pruneTainted() normally removes these before the cycle
      // starts, but an explicit guard here means a tainted plan can never fall
      // through the fresh/resume ternary below and launch the model anyway.
      if (plan.kind === "tainted") continue;
      if (plan.kind === "skip") {
        cooling++;
        earliest = earliest === undefined ? plan.until : Math.min(earliest, plan.until);
        say(`hold ${a.spec.model} (${a.spec.runId}): ${plan.reason}, backing off until ${stamp(plan.until)}`);
        // Positive evidence in the log that the spec was HELD (not silently
        // dropped, not relaunched) — otherwise the fix is invisible to post-run
        // analysis, which would only see fewer `deferred` rows than before.
        record({
          runId: a.spec.runId,
          model: a.spec.model,
          outcome: "skipped",
          detail: `held ${plan.reason}; backing off until ${stamp(plan.until)}`,
        });
        continue;
      }
      // A deferred spec resumes its stored run id in place instead of spawning
      // a fresh L1 -cN — this is the "resume, don't recreate" Mark asked for.
      // Honesty (§C): resume restores that run's trajectory and scratchpad, but
      // NOT its level — a rotation-mate's fresh launch wipes every character on the
      // shared account (run.ts hygiene, which we cannot change from here), so a
      // resumed run recreates its character at level 1. For a 0-turn rate-limit
      // there was nothing to preserve anyway; for a real-turns pause the model
      // keeps its own context but restarts its climb.
      const target =
        plan.kind === "resume" ? { ...a.spec, runId: plan.runId } : cycle === 1 ? a.spec : forCycle(a.spec, n);
      const resume = plan.kind === "resume" ? true : cycle === 1 ? a.resume : false;
      // The deadline check goes *after* the plan so a budget-stop logs the id
      // that would actually have launched (the -cN in a later loop cycle), not
      // the base id.
      if (deadline !== undefined && Date.now() >= deadline) {
        say(`wall-clock budget reached — not launching ${a.spec.model}`);
        record({ runId: target.runId, model: a.spec.model, outcome: "budget-stop", detail: "not launched" });
        continue;
      }
      if (plan.kind === "resume") {
        say(`resume ${a.spec.model}: retrying paused run ${plan.runId} in place (was ${plan.reason})`);
        record({
          runId: target.runId,
          model: a.spec.model,
          outcome: "retry",
          detail: `resuming in place after ${plan.reason}; resume restores trajectory + scratchpad, not level`,
        });
      }
      launched++;
      const res = await attemptSpec(target, { resume, deadline, dryRun: false });
      if (res === "defer") {
        const reason = readRunRow(target.runId)?.pause_reason ?? "rate-limited";
        deferred.set(a.spec.runId, nextDefer(deferred.get(a.spec.runId), Date.now(), target.runId, reason));
      } else {
        // A completed episode clears the count: the ladder measures CONSECUTIVE
        // defers, so a model that gets one turn on the board starts over at 1m.
        deferred.delete(a.spec.runId);
      }
      saveDefers(logPath, deferred, false);
    }
    pruneTainted();
    if (!args.loop || stopping) break;
    if (deadline !== undefined && Date.now() >= deadline) break;
    if (pending.length === 0) {
      say("nothing left to run (every entry already terminated or tainted) — ending the loop");
      break;
    }
    // A gap between cycles so the main loop can never spin faster than the
    // backoff: without it, a whole roster of saturated free models would 429 in
    // seconds and immediately loop. When every remaining spec is cooling, sleep
    // exactly until the earliest is due; when the cycle was a pure no-op (every
    // entry skipped as already-terminated) there is nothing to wait FOR, so go
    // straight round again instead of napping 10m against a lie.
    const gap = planGap(launched, cooling, earliest, Date.now(), cycle + 1);
    if (gap.kind === "none") say(gap.why);
    else await nap(gap.ms, deadline, gap.why);
    if (stopping || (deadline !== undefined && Date.now() >= deadline)) break;
  }

  // The retry queue is the deferred map, materialised. It is only *reached* in
  // non-loop runs (a --loop run exits this point only on stop or deadline, both
  // of which disable the loop below); a looped run has already been resuming
  // these in place, cycle after cycle. Resume targets the stored run id.
  let queue: Attempt[] = [];
  for (const a of roster) {
    const entry = deferred.get(a.spec.runId);
    if (entry === undefined || entry.tainted === true) continue;
    queue.push({ spec: { ...a.spec, runId: entry.runId }, resume: true });
  }

  for (let cycle = 1; cycle <= MAX_RETRY_CYCLES && queue.length > 0 && !stopping; cycle++) {
    if (deadline !== undefined && Date.now() >= deadline) break;
    say(`retry cycle ${cycle}/${MAX_RETRY_CYCLES}: ${queue.length} deferred model(s)`);
    await nap(CYCLE_GAP_MS, deadline, `gap before retry cycle ${cycle}`);
    const next: Attempt[] = [];
    for (const a of queue) {
      if (stopping) {
        next.push(a);
        continue;
      }
      if (deadline !== undefined && Date.now() >= deadline) {
        say(`wall-clock budget reached — not retrying ${a.spec.model}`);
        record({ runId: a.spec.runId, model: a.spec.model, outcome: "budget-stop", detail: "retry not launched" });
        next.push(a);
        continue;
      }
      const res = await attemptSpec(a.spec, { resume: true, deadline, dryRun: false });
      if (res === "defer") next.push(a);
    }
    queue = next;
  }

  saveDefers(logPath, deferred, false);
  if (queue.length > 0) {
    say(`still deferred at exit: ${queue.map((a) => a.spec.model).join(", ")}`);
  }
  if (taintedModels.size > 0) {
    say(
      `tainted at exit (out of the rotation after ${DEFER_TAINT_AFTER} consecutive defers each): ` +
        [...taintedModels].join(", "),
    );
  }
  say("roster complete");
}

if (import.meta.main) {
  void main().catch((e: unknown) => {
    console.error(`run-roster: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
