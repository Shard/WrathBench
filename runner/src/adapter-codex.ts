/**
 * The codex driver: the OpenAI Codex CLI, logged in with a ChatGPT
 * subscription, as harness and transport.
 *
 * Runs launched here belong to the `codex` harness — a comparability group of
 * their own (operator, 2026-09-05), scored against each other and never
 * against the fixed loop's (`wrathbench`) rows nor the `claude-code` ones. Not
 * a shakeout, not a penalty: a different loop, with a different unversioned
 * summarizer inside it.
 *
 * This is the exact analogue of `adapter-claude.ts`, and it deliberately
 * mirrors that file's structure, invariants and record shapes: one
 * `SandboxHost`, tools over a loopback TCP MCP server plus `mcp/src/bridge.ts`,
 * the tool-call ceiling and the watchdogs enforced at the MCP boundary, a
 * wind-down instead of a kill mid-turn, a process-group kill on stop, and the
 * child environment constructed so the CLI can bill exactly one lane. Read
 * that file's header for the reasoning behind each; this header covers only
 * where Codex differs and why.
 *
 * ## Transport: `codex exec` + `codex exec resume`, one process per turn
 *
 * Claude Code takes stream-json on a long-lived stdin. `codex exec --json`
 * (the pinned CLI, `CODEX_VERSION` in `infra/docker/runner.Dockerfile`) runs
 * ONE turn and exits, and a persisted thread is continued with `codex exec
 * resume <thread_id>`. So this driver spawns one CLI process per driver turn —
 * the first with `exec`, every later one with `exec resume <id>` — and the
 * thread lives in `$CODEX_HOME/sessions` between them. Each spawn re-pays the
 * CLI's startup and MCP handshake (a second or two), which is why the record
 * shape names the thread. A thread lives for one episode at most — a resumed
 * run starts a new one — so its rollout is deleted once the episode is off it
 * (`codex-rollout.ts`, "deletion").
 *
 * Exec is itself a client of the CLI's in-process app server: it maps the
 * server's notifications onto its eight JSONL event types and drops the rest.
 * What it drops that we want comes back from the thread's rollout instead
 * (`codex-rollout.ts`): the last call's usage, compactions, the model each
 * turn ran on (`turn_context`) and the subscription's usage windows
 * (`rate_limits` on every `token_count`; exec's own stdout never carries them,
 * and upstream declined to add them). What only the standalone
 * `codex app-server` would add is a long-lived process and typed errors
 * (`codexErrorInfo`, a retry flag, a misalignment steer); it stays parked
 * while upstream marks it experimental and unsupported for production.
 *
 * ## The prompt goes in on stdin, and stdin is closed
 *
 * The prompt positional is `-`, the context message is written to stdin and
 * stdin is ended. Two reasons. argv has a per-argument ceiling (128 KiB on
 * Linux) and a turn's context — HUD, events, the whole scratchpad — can
 * approach it; and argv is visible in `ps`. What must NOT happen is leaving
 * stdin open: when stdin is a pipe the CLI reads it to EOF and appends it as a
 * `<stdin>` block, and an open pipe hung it for 180 s on this host (2026-09-05).
 *
 * ## Fixed system prompt as the CLI's base instructions
 *
 * `-c model_instructions_file=<path>` REPLACES Codex's own base prompt (the
 * coding-agent preamble) rather than adding to it, which `developer_instructions`
 * would. Verified 2026-09-05: with both set, the model reported the codeword
 * from each, and the request carried 1.9k input tokens against 14.7k with the
 * default preamble. The file is written into the run directory, the way the
 * claude driver writes its MCP config.
 *
 * ## Tools: what stays and how they are approved
 *
 * `--disable <feature>` removes the shell, unified exec, image generation, tool
 * suggestions, multi-agent, apps, plugins, browser/computer use and the sleep
 * tool; `web_search="disabled"` removes search. What remains built in follows
 * the model's catalogue row, not these flags: `request_user_input`,
 * `view_image`, `apply_patch` and the goal tools for `gpt-5.5` — inert under
 * `sandbox_mode="read-only"` in an empty temp cwd — and, for GPT-6 models, the
 * CLI's code mode (`functions.exec`, `functions.wait`) and collaboration tools
 * as well, which no flag here removes (runner/README.md, "The codex driver"). Our nine tools arrive via `mcp_servers.wrathbench.*`
 * overrides on the command line (`--ignore-user-config` keeps the operator's
 * ~/.codex/config.toml — trusted projects, other MCP servers — out of the run;
 * auth still comes from CODEX_HOME). Codex presents them to the model as
 * `mcp__wrathbench__<tool>` (`mcp__wrathbench.<tool>` before 0.159) and calls
 * our server with the plain `<tool>` name.
 *
 * MCP tool calls need approval unless the server says otherwise, and with
 * `approval_policy="never"` an unapproved call FAILS ("MCP tool call requires
 * approval, but approval policy is never" — observed). The switch that
 * approves them is per server: `mcp_servers.wrathbench.default_tools_approval_mode="approve"`
 * (verified: `"auto"` still gates on the tool's readOnlyHint and refused).
 *
 * The CLI runs MCP servers inside its sandbox with a private /tmp, so the
 * bridge is addressed by its repository path, never a temp copy.
 *
 * ## Billing isolation
 *
 * The CLI's auth precedence is CODEX_API_KEY, then CODEX_ACCESS_TOKEN, then the
 * persisted ChatGPT login in `$CODEX_HOME/auth.json`; OPENAI_API_KEY is not
 * read for auth (telemetry only) but is the `openai` driver's credential and
 * OPENAI_BASE_URL its endpoint. So the child environment is an allowlist
 * (`childEnv`): the plumbing a process needs to run, and exactly one
 * credential — `CODEX_HOME`, set to
 * the directory the run's LANE names (`RunConfig.subscription`, an env var
 * whose VALUE is a CODEX_HOME path; default `CODEX_HOME`). One directory per
 * lane, shared by that lane's runs, never copied per run — a copied auth.json
 * carries a refresh token that whichever process refreshes first consumes,
 * after which the other fails with "refresh token was already used" (seen on
 * this host, 2026-09-05). One live session per lane is the fleet's rule, as
 * for the Claude lanes. auth.json is never read by this driver and never
 * logged.
 *
 * ## What the CLI reports, and what it does not
 *
 * `turn.completed` carries usage (`input_tokens`, `cached_input_tokens`,
 * `cache_write_input_tokens`, `output_tokens`, `reasoning_output_tokens`) and
 * nothing else. That usage is the THREAD's running total, not the turn's —
 * `exec resume` rebuilds the thread, counts included, from its rollout — so
 * the driver logs the turn's delta against the previous total of the same
 * thread and keeps the total beside it (`codex-usage.ts`). No cost (a
 * subscription has no per-turn price, so cost stays absent as on the Claude
 * lanes) and no rate-limit window on stdout (codex issue #14728): the window
 * is read off the rollout after each turn and recorded on change
 * (`subscription-usage.ts`), where the fleet's lane gate reads it.
 *
 * Exhaustion still shows up only as a failed turn, and in exec mode only as
 * words: `turn.failed` / `error` carry `{message}` alone — the server's
 * typed `codexErrorInfo` never reaches exec's stdout — so classification is
 * the message text. `detectCodexFailure` maps it: usage limit → the same
 * `quota-exhausted` pause the claude driver uses for its window, waiting for
 * the window's reset when the rollout named one; rate limit → `rate-limited`;
 * a dead login → `auth-failed`; a blown context window → the `context-limit`
 * termination; and the model's own policy monitor stopping the task (GPT-6
 * Astra's misalignment monitor, which can halt long agentic work and has
 * nobody to ask in exec mode) → `provider-policy`, with the message recorded
 * verbatim and NO automatic steer or override — that is the operator's call.
 * A server that words its policy stop without the CLI's own "misalignment
 * policy violation" sentence is not recognised: the turn is an unclassified
 * failure, a session note, and three of them end the run as `adapter-error` —
 * the known limit of classifying exec's words until typed errors reach it.
 * The CLI failing on the host under it — its thread store unwritable, a full
 * disk under `$CODEX_HOME` — is `infrastructure-failed`: a pause for the
 * operator, never a notice to the model, which can do nothing about it and
 * would otherwise keep playing on a thread that is silently losing turns.
 *
 * A retry notice is not a failure. While the CLI retries a stream it prints
 * `{"type":"error","message":"Reconnecting... 2/5 (…)"}` — exec drops the
 * server's retry flag — and a retried 429 reads exactly like a rate limit. So
 * an `error` whose message starts with the CLI's own "Reconnecting..." is
 * recorded (`codex_retry`) and never classified; if the retries run out the
 * CLI says so with a `turn.failed`, which is.
 *
 * A freeplay run whose lane's usage window reaches the freeplay threshold
 * pauses at its next turn boundary as `subscription-budget`, waiting for the
 * window's reset (operator, 2026-10-16). Nothing about it reaches the model.
 */

import type { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { MCP_SERVER_NAME, toolCallLimitReached } from "./adapter-claude";
import { MessageQueue, cliBaseEnv, readLines, signalGroup } from "./adapter-shared";
import { DEFAULT_CODEX_HOME_ENV, harnessOf, type PauseReason, type RunConfig, type TerminationReason } from "./config";
import { entryOf } from "./drivers";
import { ContextBuilder, startStateTicker, stopRequestOf, type LoopOutcome, type ObservationStallHook } from "./loop";
import { MCP_BRIDGE_PATH } from "@wrathbench/mcp";
import { McpServer } from "./mcp";
import { CodexLastCallReader, CodexRolloutFollower, removeThreadRollouts, writeCodexThread, type CodexCompaction } from "./codex-rollout";
import { CompactionAsk, codexAutoCompactLimit, codexWindowCapRefusal, compactionNotice, compactWindowTokens, summaryFields, type CompactionRecord } from "./cli-compaction";
import { codexUsageDelta, codexUsageRegressed, normalizeCodexUsage, type CodexUsage } from "./codex-usage";
import { SUBSCRIPTION_PAUSE } from "./lapse";
import { SubscriptionUsageTracker, describeWindows, newestLaneUsage, subscriptionLaneOf, subscriptionThresholds } from "./subscription-usage";
import { CODEX_SYSTEM_PROMPT, buildSystemPrompt } from "./prompt";
import type { ToolContext } from "./tools";
import type { EpisodicLog } from "./episodic";
import type { HarnessNotice, SandboxHost } from "./sandbox/host";
import type { Scratchpad } from "@wrathbench/mcp";
import type { Trajectory } from "./trajectory";
import type { Watchdogs } from "./watchdogs";

// ------------------------------------------------------------------ effort

/**
 * The reasoning levels the Codex CLI knows (`model_reasoning_effort`). `ultra`
 * is what the ChatGPT catalogue advertises for gpt-6-astra. `none` and
 * `minimal` are levels of ours the CLI has no spelling for, and mapping them
 * to the nearest one would record a run at an effort it did not get — so they
 * are refused by name, never translated.
 */
export const CODEX_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;

/** Why an effort cannot be passed to this driver, or null when it can (or is absent). */
export function codexEffortRefusal(effort: string | undefined): string | null {
  if (effort === undefined) return null;
  if ((CODEX_EFFORTS as readonly string[]).includes(effort)) return null;
  return (
    `--effort ${effort} is not a Codex reasoning level (one of: ${CODEX_EFFORTS.join(", ")}); ` +
    `the codex driver does not map it to a neighbouring level, because the run would then be ` +
    `recorded at an effort the model was not asked for`
  );
}

// ------------------------------------------------------------------ billing

/**
 * The child environment: an allowlist, never the runner's own.
 *
 * `cliBaseEnv` (adapter-shared.ts) is the plumbing — PATH, HOME, temp, locale,
 * terminal. On top of it, explicitly, the run's LANE: the directory in
 * `$<laneEnv>` becomes `CODEX_HOME`, the only name the CLI reads, and the one
 * thing it authenticates with (the ChatGPT login in its `auth.json`). Then
 * `extra`, which only a test sets.
 *
 * So no `CODEX_API_KEY` or `CODEX_ACCESS_TOKEN` (the CLI's two overrides of the
 * persisted login) and no second lane's directory (`CODEX_HOME_2`) reach it;
 * no `OPENAI_*` either, which is the `openai` driver's key and base URL; and
 * nothing else the runner holds — the other providers' keys, the Claude lanes'
 * tokens, the module's port secret, the database and derived-store passwords.
 * That matters beyond the process itself: the CLI writes snapshots of its
 * environment under `$CODEX_HOME/shell_snapshots`, on the lane's volume, so
 * whatever it inherits is also written to disk.
 *
 * An unset lane leaves `CODEX_HOME` unset: the CLI then has no login to bill
 * and refuses, which is what `run.ts` checks for before it gets this far. The
 * MCP bridge the CLI launches needs nothing from here (`CLI_BASE_ENV`), so the
 * `mcp_servers` overrides carry no `env`.
 */
export function childEnv(
  parent: Record<string, string | undefined>,
  o: { laneEnv?: string; extra?: Record<string, string> },
): Record<string, string> {
  const out = cliBaseEnv(parent);
  const home = parent[o.laneEnv ?? DEFAULT_CODEX_HOME_ENV];
  if (home !== undefined && home.length > 0) out[DEFAULT_CODEX_HOME_ENV] = home;
  return { ...out, ...(o.extra ?? {}) };
}

/** Whether a lane directory looks logged in: the CLI keeps the login in auth.json there. */
export function laneLooksLoggedIn(codexHome: string | undefined): boolean {
  return codexHome !== undefined && codexHome.length > 0 && existsSync(join(codexHome, "auth.json"));
}

// ------------------------------------------------------------ failure detect

/** How a failed turn is to be treated: suspend the run, or end it by name. */
export type CodexFailure =
  | { kind: "pause"; reason: PauseReason; detail: string }
  | { kind: "terminate"; reason: TerminationReason; detail: string };

const POLICY_PATTERNS = [/misalignment/i, /policy[_ ]?violation/i];
const CONTEXT_PATTERNS = [/context[_ ]?window[_ ]?exceeded/i, /context window/i, /exceeds? the (model'?s? )?context/i];
const USAGE_PATTERNS = [/usage[_ ]?limit/i, /hit your (usage |weekly |5-hour )?limit/i, /out of (credits|usage)/i];
const RATE_PATTERNS = [/rate[_ ]?limit/i, /too many requests/i, /\b429\b/];
/**
 * The CLI failing on the host rather than at the provider: it could not write
 * the thread's rollout under `$CODEX_HOME` (observed: a full volume, where
 * every turn logged "failed to record rollout items ... No space left on
 * device" and the next resume rebuilt the thread without the lost turns), or
 * could not open its thread store at all. Matched on the CLI's own wording;
 * "state db returned stale rollout path" is NOT here — that is the CLI noting
 * an old thread's file was cleaned up, which is benign.
 */
const INFRA_PATTERNS = [
  /no space left on device/i,
  /\bENOSPC\b/,
  /failed to record rollout items/i,
  /rollout writer failed/i,
  /failed to (initiali[sz]e|resume local) thread (persistence|recorder)/i,
];
const AUTH_PATTERNS = [
  /access token could not be refreshed/i,
  /refresh token was already used/i,
  /\b401\b/,
  /unauthori[sz]ed/i,
  /not logged in/i,
  /please (log ?in|run codex login)/i,
];

/**
 * Classify CLI-originated failure text. Only ever called on what the CLI said
 * — a `turn.failed` / `error` event (stringified whole, so a `codexErrorInfo`
 * key is matched as well as the message), stderr, or an unparseable stdout
 * line. Never on assistant output: a model narrating "the daily quest limit
 * resets at midnight" must not pause the run.
 *
 * Order is specificity: the policy monitor and a blown context window name
 * the run's fate outright and win over the generic limit words their messages
 * may also contain; the host's own failure next, because its wording is
 * unambiguous and nothing the provider says will clear a full disk; usage
 * before rate because "rate limit" text is what a spent usage window is
 * sometimes wrapped in.
 */
export function detectCodexFailure(text: string | undefined | null): CodexFailure | null {
  if (text === undefined || text === null) return null;
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  const detail = trimmed.slice(0, 600);
  if (POLICY_PATTERNS.some((p) => p.test(trimmed))) return { kind: "terminate", reason: "provider-policy", detail };
  if (CONTEXT_PATTERNS.some((p) => p.test(trimmed))) return { kind: "terminate", reason: "context-limit", detail };
  if (INFRA_PATTERNS.some((p) => p.test(trimmed))) return { kind: "pause", reason: "infrastructure-failed", detail };
  if (USAGE_PATTERNS.some((p) => p.test(trimmed))) return { kind: "pause", reason: "quota-exhausted", detail };
  if (RATE_PATTERNS.some((p) => p.test(trimmed))) return { kind: "pause", reason: "rate-limited", detail };
  if (AUTH_PATTERNS.some((p) => p.test(trimmed))) return { kind: "pause", reason: "auth-failed", detail };
  return null;
}

// ------------------------------------------------------------------- stream

/** Exec JSONL envelopes we act on. Loose: an unknown field must never break a run. */
const eventSchema = z.looseObject({ type: z.string() });

// `CodexUsage` and `normalizeCodexUsage` live in `codex-usage.ts`, beside the
// per-turn delta rule the viewer shares; re-exported for the driver's readers.
export { normalizeCodexUsage, type CodexUsage } from "./codex-usage";

/**
 * The CLI's own retry notice — `Reconnecting... 2/5 (…)`, `Reconnecting...
 * waiting for network` — printed as an `error` event while it retries a
 * stream (exec drops the server's retry flag). Not a failure: a retried 429
 * would otherwise read as a rate limit and pause a run the CLI was still
 * carrying. Only the `error` type: a `turn.failed` is terminal by construction.
 */
export function isRetryNotice(msg: Record<string, unknown>): boolean {
  const m = msg["message"];
  return msg["type"] === "error" && typeof m === "string" && m.trimStart().startsWith("Reconnecting...");
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * The reset the pinned CLI's own usage-limit message names, as epoch ms, or
 * undefined. 0.159.3 and 0.163.0 end that message with "Try again at 4:05 PM." when the
 * reset falls today and "Try again at Oct 21st, 2026 9:05 AM." otherwise (or
 * "…or try again at …"), in the CLI's local time — the same clock this
 * process reads, in the same container. A stated reset is what the CLI knows
 * of the window that refused it, so it wins over the reading's guess
 * (`SubscriptionUsageTracker.quotaReset`).
 */
export function codexStatedReset(text: string | undefined | null, now = Date.now()): number | undefined {
  if (text === undefined || text === null) return undefined;
  const dated = /try again at ([A-Za-z]{3}) (\d{1,2})(?:st|nd|rd|th)?, (\d{4}) (\d{1,2}):(\d{2}) ([AP]M)/i.exec(text);
  const clock = dated === null ? /try again at (\d{1,2}):(\d{2}) ([AP]M)/i.exec(text) : null;
  const hour = (h: string, ampm: string): number => (Number(h) % 12) + (ampm.toUpperCase() === "PM" ? 12 : 0);
  let at: number;
  if (dated !== null) {
    const month = MONTHS.indexOf(dated[1]!.toLowerCase());
    if (month < 0) return undefined;
    at = new Date(Number(dated[3]), month, Number(dated[2]), hour(dated[4]!, dated[6]!), Number(dated[5])).getTime();
  } else if (clock !== null) {
    const d = new Date(now);
    at = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour(clock[1]!, clock[3]!), Number(clock[2])).getTime();
  } else {
    return undefined;
  }
  return Number.isFinite(at) && at > now ? at : undefined;
}

/**
 * A server-side reroute, which exec prints as an `error` ITEM (not an event):
 * `model rerouted: <from> -> <to> (<reason>)`. The rollout does not keep it.
 */
const REROUTED = /^model rerouted: (\S+) -> (\S+)(?: \((.*)\))?/;

/** A parsed exec event, or null for a line that is not one. */
export function parseCodexEvent(line: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  return eventSchema.safeParse(parsed).success ? (parsed as Record<string, unknown>) : null;
}

/**
 * One compaction off the rollout (`CodexRolloutFollower`) as the record both
 * CLI drivers write (`cli-compaction.ts`). The CLI names no trigger in exec
 * mode, where every compaction is its own automatic one, so `trigger` stays
 * null rather than a word it did not say.
 */
export function codexCompactionRecord(turn: number, c: CodexCompaction): CompactionRecord {
  return {
    t: "harness",
    kind: "compaction",
    turn,
    trigger: null,
    preTokens: c.preTokens,
    postTokens: c.postTokens,
    durationMs: c.durationMs,
    at: c.at,
    ...summaryFields(c.summary),
    ...(c.encryptedChars !== null ? { summaryEncrypted: true as const, encryptedChars: c.encryptedChars } : {}),
    retainedTurns: c.retainedTurns,
    window: c.window,
  };
}

/** The envelope type `wakeReader` pushes; not a CLI event, and acted on nowhere. */
const WAKE_TYPE = "__wrathbench_wake";

// -------------------------------------------------------------------- flags

/** A TOML basic string, for values handed to `-c key=value`. */
export function tomlString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Features switched off for every run. Each is a name `codex features list`
 * knows in the pinned CLI (`CODEX_VERSION` in `infra/docker/runner.Dockerfile`,
 * re-checked at every bump); an unknown one is a hard error at launch ("Unknown feature
 * flag"), which is the point of pinning the CLI version.
 */
export const DISABLED_FEATURES = [
  "shell_tool",
  "unified_exec",
  "image_generation",
  "tool_suggest",
  "multi_agent",
  "request_permissions_tool",
  "apps",
  "plugins",
  "browser_use",
  "computer_use",
  "sleep_tool",
] as const;

export interface CodexArgsOptions {
  /** Absent for the first turn (`exec`); the thread to continue for every later one (`exec resume <id>`). */
  threadId?: string | undefined;
  model?: string | undefined;
  /** `model_reasoning_effort`, when the run declares one. Must be a `CODEX_EFFORTS` level. */
  effort?: string | undefined;
  /**
   * The run's compaction window (`RunConfig.compactWindow`, canonical `100k`…`1M`),
   * passed as the integer `model_auto_compact_token_limit`. Absent is the CLI's
   * own `auto`, and nothing is sent.
   */
  compactWindow?: string | undefined;
  /** The fixed system prompt, written to disk: replaces the CLI's base instructions. */
  instructionsPath: string;
  /** The interpreter and the bridge script the CLI launches as the MCP server, plus the runner's port. */
  bunBin: string;
  bridgePath: string;
  mcpPort: number;
}

/**
 * The exact flag set, in one place so the README and the tests can assert it.
 * Every flag exists in the pinned codex-cli (`codex exec --help`, `codex exec
 * resume --help`); nothing is invented. `-s`/`-C` are exec-only in this
 * version, so the sandbox rides on `-c sandbox_mode` and the cwd on the
 * process, which keeps the first turn and every resumed one identical apart
 * from the `resume <id>` words.
 */
export function codexArgs(o: CodexArgsOptions): string[] {
  const refusal = codexEffortRefusal(o.effort);
  if (refusal !== null) throw new Error(refusal);
  const windowTokens = compactWindowTokens(o.compactWindow);
  if (o.compactWindow !== undefined && windowTokens === undefined) {
    throw new Error(`compactWindow ${JSON.stringify(o.compactWindow)} is not a canonical window (parseCompactWindow)`);
  }
  const config: string[] = [
    `web_search="disabled"`,
    `approval_policy="never"`,
    `sandbox_mode="read-only"`,
    `model_instructions_file=${tomlString(o.instructionsPath)}`,
    ...(o.effort !== undefined ? [`model_reasoning_effort=${tomlString(o.effort)}`] : []),
    // A bare TOML integer: the pinned CLI reads it as `Option<i64>` and
    // applies min(it, 90% of the catalogue window) (`codexAutoCompactLimit`).
    ...(windowTokens !== undefined ? [`model_auto_compact_token_limit=${windowTokens}`] : []),
    `mcp_servers.${MCP_SERVER_NAME}.command=${tomlString(o.bunBin)}`,
    `mcp_servers.${MCP_SERVER_NAME}.args=[${tomlString(o.bridgePath)},${tomlString(String(o.mcpPort))}]`,
    // Without this every call fails under approval_policy=never; see the header.
    `mcp_servers.${MCP_SERVER_NAME}.default_tools_approval_mode="approve"`,
    // A snippet may legitimately run to its 30 s limit and a sandbox restart
    // on top; the CLI's own default tool timeout must not cut a call short.
    `mcp_servers.${MCP_SERVER_NAME}.tool_timeout_sec=300`,
    `mcp_servers.${MCP_SERVER_NAME}.startup_timeout_sec=30`,
  ];
  return [
    "exec",
    ...(o.threadId !== undefined ? ["resume", o.threadId] : []),
    "--json",
    // the operator's ~/.codex/config.toml never leaks in; auth still uses CODEX_HOME
    "--ignore-user-config",
    // the cwd is a temp dir, deliberately not a repository
    "--skip-git-repo-check",
    ...(o.model !== undefined ? ["-m", o.model] : []),
    ...DISABLED_FEATURES.flatMap((f) => ["--disable", f]),
    ...config.flatMap((c) => ["-c", c]),
    // the prompt is read from stdin, which the driver writes and CLOSES
    "-",
  ];
}

// ------------------------------------------------------------------ episode

export interface CodexEpisodeOptions {
  config: RunConfig & { runId: string; token: string };
  runDir: string;
  sandbox: SandboxHost;
  scratchpad: Scratchpad;
  episodic: EpisodicLog;
  wiki?: Database | undefined;
  trajectory: Trajectory;
  watchdogs: Watchdogs;
  initialNotices?: HarnessNotice[];
  turnOffset?: number;
  /** Executable to run. Tests point this at a scripted fake. */
  codexBin?: string;
  /** Parent environment to derive the child environment from. */
  env?: Record<string, string | undefined>;
  /** Extra child env. Test hook only — never set from the CLI. */
  extraEnv?: Record<string, string>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  watchdogTickMs?: number;
  killGraceMs?: number;
  /** See the claude driver: grace for the CLI to close its turn after the harness ended the episode mid-turn. */
  windDownGraceMs?: number;
  signal?: AbortSignal;
  /** See `ContextBuilderOptions.onObservationStalled` (loop.ts). */
  onObservationStalled?: ObservationStallHook | undefined;
}

export const DEFAULT_WIND_DOWN_GRACE_MS = 90_000;

/**
 * Consecutive turns the CLI may fail for an unclassified reason (a dropped
 * stream, a transient 5xx it did not retry) before the run ends as
 * `adapter-error`. A single such failure is a session note and the next turn
 * resumes the same thread, as the claude driver treats an errored `result`.
 */
export const MAX_CONSECUTIVE_FAILED_TURNS = 3;

interface WindDown {
  deadline: number;
  since: number;
  reason: TerminationReason;
}

/** The CLI's version string, for `recordResolved`; null when it cannot be read. */
function cliVersion(bin: string, env: Record<string, string>): string | null {
  try {
    const r = Bun.spawnSync({ cmd: [bin, "--version"], env, stdout: "pipe", stderr: "pipe" });
    const m = /codex(?:-cli)?\s+(\S+)/i.exec(new TextDecoder().decode(r.stdout));
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

export async function runCodexEpisode(o: CodexEpisodeOptions): Promise<LoopOutcome> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const { config, trajectory, watchdogs } = o;
  const runId = config.runId;
  const windDownGraceMs = o.windDownGraceMs ?? DEFAULT_WIND_DOWN_GRACE_MS;
  const bin = o.codexBin ?? "codex";

  // ---- the single end-of-episode seam; see adapter-claude.ts
  let ended: { reason: TerminationReason; detail?: string } | null = null;
  let pausedAs: { reason: PauseReason; detail: string } | null = null;
  let killCodex: () => void = () => undefined;
  let wakeReader: () => void = () => undefined;
  let turnInFlight = false;
  let windDown: WindDown | null = null;
  const endEpisode = (
    reason: TerminationReason,
    detail?: string,
    record?: Record<string, unknown> & { t: string },
    opts?: { windDown?: boolean },
  ): void => {
    if (ended !== null) return;
    ended = { reason, detail };
    if (record !== undefined) trajectory.append(record);
    trajectory.setTermination(runId, reason, detail);
    if (opts?.windDown === true && turnInFlight && windDownGraceMs > 0) {
      const since = Date.now();
      windDown = { deadline: since + windDownGraceMs, since, reason };
      wakeReader();
      return;
    }
    killCodex();
  };
  const pauseEpisode = (reason: PauseReason, detail: string): void => {
    if (ended !== null || pausedAs !== null) return;
    pausedAs = { reason, detail };
    trajectory.setPause(runId, reason, detail, watchdogs.elapsedMs());
    killCodex();
  };
  const done = (): boolean => ended !== null || pausedAs !== null;
  const finish = (): LoopOutcome => {
    const e = ended as { reason: TerminationReason; detail?: string } | null;
    const p = pausedAs as { reason: PauseReason; detail: string } | null;
    if (e === null && p !== null) return { kind: "paused", reason: p.reason, detail: p.detail };
    if (e === null) return { kind: "terminated", reason: "harness-error", detail: "ended without a reason" };
    return e.detail === undefined
      ? { kind: "terminated", reason: e.reason }
      : { kind: "terminated", reason: e.reason, detail: e.detail };
  };
  const terminate = (reason: TerminationReason, detail?: string): LoopOutcome => {
    if (done()) return finish();
    endEpisode(reason, detail);
    return finish();
  };
  /** `notBefore`: a usage window's reset, which the supervisor waits for (`subscription-usage.ts`). */
  const pause = (reason: PauseReason, detail: string, notBefore?: number): LoopOutcome => {
    if (done()) return finish();
    trajectory.setPause(runId, reason, detail, watchdogs.elapsedMs(), notBefore);
    return notBefore !== undefined ? { kind: "paused", reason, detail, notBefore } : { kind: "paused", reason, detail };
  };

  const builder = new ContextBuilder({
    config,
    sandbox: o.sandbox,
    scratchpad: o.scratchpad,
    trajectory,
    watchdogs,
    ...(o.turnOffset !== undefined ? { turnOffset: o.turnOffset } : {}),
    ...(o.now !== undefined ? { now: o.now } : {}),
    onObservationStalled: o.onObservationStalled,
  });

  // ---- MCP over loopback TCP, dispatching into the one live sandbox
  const toolCtx: ToolContext = {
    sandbox: o.sandbox,
    scratchpad: o.scratchpad,
    wiki: o.wiki,
    wikiCoords: config.wikiCoords,
    wikiSearch: config.wiki,
    sessionLive: () => builder.sessionLive,
    reflect: builder.reflect,
    episodic: o.episodic,
    turn: () => builder.currentTurn,
    secrets: trajectory,
    // The registry's switch (`DriverEntry.snippetDelta`): what changed since
    // the previous snippet rides each snippet result on a driver that has it.
    snippetDelta: entryOf(config.driver).snippetDelta,
    onEpisodicEntry: (entry) => trajectory.append({ t: "episodic", ...entry }),
    onEventsServed: (events, folded) =>
      trajectory.append({
        t: "events_served",
        via: "tool",
        count: events.length,
        events,
        ...(folded !== undefined && folded > 0 ? { folded } : {}),
      }),
  };
  let turn = 0;
  let restartsBefore = 0;
  let toolCalls = 0;

  const enforceLimits = (): boolean => {
    if (done()) return false;
    const verdict = watchdogs.check();
    if (verdict !== null) {
      endEpisode(verdict.reason, verdict.detail, { t: "watchdog", ...verdict }, { windDown: true });
      return false;
    }
    if (toolCallLimitReached(toolCalls, config.maxToolCallsPerEpisode)) {
      const cap = config.maxToolCallsPerEpisode!;
      endEpisode(
        "tool-call-limit",
        `${toolCalls} tool calls (cap ${cap})`,
        { t: "limit", kind: "tool-call-limit", toolCalls, cap },
        { windDown: true },
      );
      return false;
    }
    return true;
  };

  const server = new McpServer(toolCtx, {
    onToolCall: (name, args, result, dispatchTs) => {
      // Codex calls with the plain tool name; the claude prefix is stripped
      // defensively so both drivers' records read alike. Appended after the
      // call ran, so `dispatchTs` carries when it started.
      const short = name.replace(`mcp__${MCP_SERVER_NAME}__`, "").replace(`mcp__${MCP_SERVER_NAME}.`, "");
      trajectory.append({ t: "tool_call", turn, call: toolCalls, name: short, args, dispatchTs });
      if (short === "run_snippet") {
        trajectory.append({ t: "snippet", turn, call: toolCalls, code: (args as { code?: string }).code ?? "" });
      }
      trajectory.append({
        t: short === "run_snippet" ? "snippet_result" : "tool_result",
        turn,
        call: toolCalls,
        name: short,
        isError: result.isError ?? false,
        text: result.text,
        ...(short === "reflect" ? { reflect: true } : {}),
      });
      if (short === "run_snippet") {
        if (o.sandbox.totalRestarts > restartsBefore) watchdogs.noteSandboxRestart();
        else if (result.isError !== true) watchdogs.noteSnippetSuccess();
      }
    },
  });

  // One process per turn means one MCP connection per turn: the CLI's client
  // sends a fresh `initialize` each time, which `McpServer` accepts again.
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket, data) {
        const text = new TextDecoder().decode(data);
        const conn = socket.data as { buf: string; chain: Promise<void> };
        conn.buf += text;
        let idx: number;
        while ((idx = conn.buf.indexOf("\n")) >= 0) {
          const line = conn.buf.slice(0, idx);
          conn.buf = conn.buf.slice(idx + 1);
          if (line.trim().length === 0) continue;
          conn.chain = conn.chain.then(async () => {
            let method: string | undefined;
            let id: unknown;
            try {
              const m = JSON.parse(line) as { method?: string; id?: unknown };
              method = m.method;
              id = m.id;
            } catch {
              // handleLine answers with a parse error
            }
            if (method === "tools/call") {
              if (!enforceLimits()) {
                // Refuse rather than run; the text is the mechanism that tells
                // the model to stop (see adapter-claude.ts for the reasoning).
                if (id !== undefined) {
                  const why =
                    pausedAs !== null && ended === null
                      ? `run paused by the harness: ${pausedAs.reason}. This call was not executed.`
                      : `run terminated by the harness: ${ended?.reason ?? "?"}. The episode is over: this call was not executed, no further tool call will be, and nothing more can be scored. Stop calling tools and end your turn now.`;
                  socket.write(
                    `${JSON.stringify({
                      jsonrpc: "2.0",
                      id,
                      result: { content: [{ type: "text", text: why }], isError: true },
                    })}\n`,
                  );
                }
                return;
              }
              toolCalls++;
              watchdogs.noteModelOutput();
            }
            restartsBefore = o.sandbox.totalRestarts;
            const response = await server.handleLine(line);
            if (response !== null) socket.write(`${response}\n`);
            if (method === "tools/call") enforceLimits();
          });
        }
      },
      open(socket) {
        socket.data = { buf: "", chain: Promise.resolve() };
      },
    },
    data: { buf: "", chain: Promise.resolve() },
  });

  // ---- files the CLI needs, all inside the run directory (absolute paths:
  // the CLI runs from a scratch temp cwd)
  const instructionsPath = resolve(o.runDir, "codex-instructions.md");
  const systemPrompt = buildSystemPrompt(config.objective, config.episode, harnessOf("codex"), config.wiki, config.watchdogs.episodeMs);
  writeFileSync(instructionsPath, systemPrompt, "utf8");
  // The bridge by its REPOSITORY path: the CLI's sandbox gives MCP servers a
  // private /tmp, so a temp copy would not be found ("Module not found").
  const bridgePath = MCP_BRIDGE_PATH;
  // A cwd outside the repo: the CLI walks parents for AGENTS.md.
  const cwd = mkdtempSync(join(tmpdir(), "wrathbench-codex-"));

  const laneEnv = config.subscription ?? DEFAULT_CODEX_HOME_ENV;
  const env = childEnv(o.env ?? process.env, {
    laneEnv,
    ...(o.extraEnv !== undefined && Object.keys(o.extraEnv).length > 0 ? { extra: o.extraEnv } : {}),
  });
  const argsFor = (threadId: string | undefined): string[] =>
    codexArgs({
      threadId,
      model: config.model,
      ...(config.effort !== undefined ? { effort: config.effort } : {}),
      ...(config.compactWindow !== undefined ? { compactWindow: config.compactWindow } : {}),
      instructionsPath,
      bunBin: process.execPath,
      bridgePath,
      mcpPort: listener.port,
    });
  const firstArgs = argsFor(undefined);

  trajectory.append({
    t: "driver",
    driver: "codex",
    harness: harnessOf("codex"),
    bin,
    args: firstArgs,
    cwd,
    // The lane by NAME (the env var whose value is the CODEX_HOME directory), never the path or its contents.
    lane: laneEnv,
    instructionsPath,
    mcpPort: listener.port,
    systemPromptChars: systemPrompt.length,
    ...(config.objective !== undefined ? { objective: config.objective } : {}),
    // Named beside its `-c` key, as the claude driver names its env-borne one.
    ...(config.compactWindow !== undefined ? { compactWindow: config.compactWindow } : {}),
  });
  const version = cliVersion(bin, env);
  if (version !== null) trajectory.recordResolved(runId, { model: null, cliVersion: version });
  /**
   * The model the CLI actually ran, off the rollout's `turn_context`, promoted
   * onto the run once (`recordResolved`, first observation wins) as the other
   * drivers do. Set once it has been.
   */
  let resolvedModel = false;

  /**
   * The lane's usage windows, off the rollout after each turn, recorded on
   * change; and the two thresholds (`subscription-usage.ts`). Only the
   * freeplay one is the driver's to act on: a scored run is never paused by
   * the gate, which holds the next launch instead.
   */
  const thresholds = subscriptionThresholds(o.env ?? process.env);
  for (const note of thresholds.notes) console.error(`[wrathbench] ${note}`);
  const usage = new SubscriptionUsageTracker(subscriptionLaneOf({ driver: "codex", lane: laneEnv })!, (u) =>
    trajectory.recordSubscriptionUsage(u, turn),
  );
  // The lane's newest reading from before this run, so a first turn that
  // meets a spent quota still knows the window it was spent in.
  usage.seed(newestLaneUsage(config.runsDir, usage.lane));

  // ---- one process at a time; the group kill and the exit net track it
  const spawnCodex = (args: string[]) =>
    Bun.spawn({ cmd: [bin, ...args], cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe", detached: true });
  type Child = ReturnType<typeof spawnCodex>;
  let current: Child | null = null;
  const onProcessExit = (): void => {
    if (current !== null) signalGroup(current, "SIGKILL");
  };
  process.on("exit", onProcessExit);
  let sigkillTimer: ReturnType<typeof setTimeout> | undefined;
  killCodex = (): void => {
    const proc = current;
    if (proc === null) return;
    signalGroup(proc, "SIGTERM");
    sigkillTimer = setTimeout(() => {
      signalGroup(proc, "SIGKILL");
    }, o.killGraceMs ?? 5_000);
    sigkillTimer.unref?.();
  };

  if (o.signal !== undefined) {
    const onAbort = (): void => {
      const req = stopRequestOf(o.signal);
      if (req?.kind === "pause") pauseEpisode(req.reason, req.detail);
      else endEpisode("manual", req?.detail ?? "aborted");
    };
    if (o.signal.aborted) onAbort();
    else o.signal.addEventListener("abort", onAbort, { once: true });
  }

  const stopTicker = startStateTicker({
    builder,
    tickMs: o.watchdogTickMs,
    stopped: done,
    onSample: () => {
      const verdict = watchdogs.check();
      if (verdict !== null)
        endEpisode(verdict.reason, verdict.detail, { t: "watchdog", ...verdict }, { windDown: true });
    },
  });

  const waitMs = (ms: number): Promise<void> =>
    new Promise<void>((r) => {
      const t = setTimeout(r, ms);
      t.unref?.();
    });
  /**
   * A bounded wait for the process to leave on its own, then SIGTERM to the
   * group, a bounded wait, SIGKILL, a bounded wait. Never blocks the episode.
   * The natural wait comes first on purpose: a turn's process exits right
   * after `turn.completed` while flushing the thread to `$CODEX_HOME/sessions`,
   * and a SIGTERM in that window would cost the next turn its resume.
   */
  const reap = async (proc: Child): Promise<void> => {
    const grace = o.killGraceMs ?? 5_000;
    const reaped = (ms: number): Promise<boolean> =>
      Promise.race([proc.exited.then(() => true).catch(() => true), waitMs(ms).then(() => false)]);
    if (await reaped(grace)) return;
    signalGroup(proc, "SIGTERM");
    if (!(await reaped(grace))) {
      trajectory.append({ t: "harness", kind: "session_note", text: "codex ignored SIGTERM; killing its process group" });
      signalGroup(proc, "SIGKILL");
      await reaped(grace);
    }
  };
  const shutdown = async (): Promise<void> => {
    flushPendingResponse();
    builder.reflect.close("run_end");
    for (const e of builder.reflect.drainEvents()) {
      trajectory.append({ t: "reflect_window", turn: builder.currentTurn, ...e });
    }
    await stopTicker();
    if (sigkillTimer !== undefined) clearTimeout(sigkillTimer);
    if (current !== null) {
      await reap(current);
      current = null;
    }
    // The last read, once no CLI is writing: a turn the episode ended inside
    // may have left a compaction, a usage reading or the served model unread,
    // and the rollout goes next.
    try {
      const last = rollout.read(threadId);
      for (const c of last.compactions) trajectory.append(codexCompactionRecord(turn, c));
      if (!resolvedModel && last.model !== undefined) {
        resolvedModel = true;
        trajectory.recordResolved(runId, { model: last.model, cliVersion: version });
      }
      // The follower answers the newest reading so far, read or not: only one
      // this read found is news (a quota pause has since marked its window spent).
      if (last.rateLimits !== undefined && last.rateLimits !== observedLimits) usage.observe(last.rateLimits, Date.now());
    } catch {
      // the reader never throws; a recorder that does must not cost the verdict
    }
    dropRollouts([...ownThreads], "exit");
    process.off("exit", onProcessExit);
    listener.stop(true);
    // The scratch cwd goes with the CLI, as in the claude driver: it holds
    // nothing of the run's, and must never throw from the episode's finally.
    try {
      rmSync(cwd, { recursive: true, force: true });
    } catch {
      // left behind; the verdict matters more than the directory
    }
  };

  const pendingNotices: HarnessNotice[] = [...(o.initialNotices ?? [])];
  /**
   * The turn's usage arrives once, on `turn.completed`, after every item. So
   * the newest `response` entry of a turn is held back until the turn closes
   * and carries that usage — counted exactly once per turn, which is what a
   * consumer summing `response` usage (viewer/tail.ts) needs. A turn with no
   * response at all still gets one entry, content null, so its tokens count.
   *
   * What it carries is the turn's DELTA, with the thread total the CLI
   * reported beside it as `usageCumulative`: the CLI's figure is the thread's
   * running total (`codex-usage.ts`), and summing it per turn read a 2,082-turn
   * run as 1.69 trillion input tokens. `usageCumulative` is also the marker
   * the viewer reads to tell this record from one written before the fix,
   * whose `usage` it derives the same delta for.
   */
  let pendingResponse: (Record<string, unknown> & { t: string }) | null = null;
  const flushPendingResponse = (usage?: Record<string, unknown>): void => {
    if (pendingResponse === null) return;
    const entry = pendingResponse;
    pendingResponse = null;
    trajectory.append(usage !== undefined ? { ...entry, ...usage } : entry);
  };
  /**
   * The last API call's prompt, from the CLI's rollout (`codex-rollout.ts`),
   * which is what "context" means for this driver. Best effort: a failure is
   * an absent `lastCall` and one harness line per run, never a slower turn.
   */
  const lastCalls = new CodexLastCallReader(env["CODEX_HOME"], (reason) => {
    trajectory.append({ t: "harness", kind: "session_note", text: `codex last-call figure unavailable: ${reason}` });
  });
  /** Each thread's last reported total: the baseline its next turn's delta is taken against. */
  const threadTotals = new Map<string, CodexUsage>();
  /**
   * The CLI's own compactions, read off the thread's rollout after each turn
   * (`CodexRolloutFollower`), and the episodic-log ask they drive
   * (`cli-compaction.ts`; METHODOLOGY, "An episodic log, asked for at each
   * trim or compaction"). Both best effort: an unreadable rollout is one
   * harness line per run, no compaction record and no ask.
   */
  const rollout = new CodexRolloutFollower(env["CODEX_HOME"], (reason) => {
    trajectory.append({ t: "harness", kind: "session_note", text: `codex compaction reader unavailable: ${reason}` });
  });
  const compactionAsk = new CompactionAsk();
  /** Whether the run's window has been checked against the first window the CLI reported (`codexWindowCapRefusal`). */
  let windowChecked = config.compactWindow === undefined;
  const pushResponse = (entry: Record<string, unknown> & { t: string }): void => {
    flushPendingResponse();
    pendingResponse = entry;
  };

  let threadId: string | undefined;
  let failedTurns = 0;
  /**
   * This episode's threads whose rollouts are still on the lane's volume, and
   * the ones it has moved off since the last turn ended. A rollout is deleted
   * once its thread is done with (`codex-rollout.ts`, "deletion"): a thread
   * left behind after that turn's read, and every one at the episode's end
   * after the last. Nothing resumes a thread across episodes, so nothing
   * here is ever needed again — and what was read off them is on the
   * trajectory.
   */
  const ownThreads = new Set<string>();
  /** The follower's newest usage reading as last observed: it repeats it on every read, new lines or none. */
  let observedLimits: unknown;
  const leftThreads: string[] = [];
  const dropRollouts = (ids: readonly string[], when: "thread-change" | "exit"): void => {
    if (ids.length === 0) return;
    try {
      let files = 0;
      let bytes = 0;
      let error: string | undefined;
      for (const id of ids) {
        const r = removeThreadRollouts(env["CODEX_HOME"], id);
        ownThreads.delete(id);
        files += r.files;
        bytes += r.bytes;
        error ??= r.error;
      }
      if (files > 0 || error !== undefined) {
        trajectory.append({ t: "harness", kind: "codex_rollouts_removed", turn, when, threads: [...ids], files, bytes, ...(error !== undefined ? { error } : {}) });
      }
    } catch {
      // best effort: the supervisor's sweep collects what is left
    }
  };

  const finishWindDown = (outcome: "result" | "exit" | "grace-expired"): void => {
    const wd = windDown as WindDown | null;
    if (wd === null) return;
    windDown = null;
    trajectory.append({
      t: "wind-down",
      turn,
      reason: wd.reason,
      outcome,
      graceMs: windDownGraceMs,
      waitedMs: Date.now() - wd.since,
    });
    // On `result` the CLI is already exiting on its own (one process per
    // turn) and is flushing the thread; the bounded reap after the read loop
    // covers it. Only a CLI that ignored the refusals is signalled.
    if (outcome === "grace-expired") killCodex();
  };
  const GRACE_EXPIRED = Symbol("wind-down grace expired");
  const nextBefore = (
    queue: MessageQueue,
    deadline: number,
  ): Promise<Record<string, unknown> | null | typeof GRACE_EXPIRED> => {
    const ms = deadline - Date.now();
    if (ms <= 0) return Promise.resolve(GRACE_EXPIRED);
    return new Promise((res) => {
      const timer = setTimeout(() => res(GRACE_EXPIRED), ms);
      timer.unref?.();
      void queue.next().then((m) => {
        clearTimeout(timer);
        res(m);
      });
    });
  };

  try {
    for (;;) {
      if (done()) return finish();
      const verdict = watchdogs.check();
      if (verdict !== null) {
        endEpisode(verdict.reason, verdict.detail, { t: "watchdog", ...verdict });
        return finish();
      }

      turn++;
      const contextText = await builder.build(turn, pendingNotices);
      trajectory.append({
        t: "request",
        turn,
        adapter: `codex:${config.model ?? "default"}`,
        messages: [{ role: "user", content: contextText }],
        ...(threadId !== undefined ? { threadId } : {}),
      });

      /**
       * `detached`: the CLI leads its own process group so a signal to -pid
       * reaches the MCP bridge it spawned as well. Observed under claude-code:
       * an orphaned CLI outliving its runner by a day.
       */
      const proc = spawnCodex(argsFor(threadId));
      current = proc;
      const startedAt = Date.now();

      // The prompt, then EOF: an open stdin is what hung the CLI (header).
      try {
        proc.stdin.write(contextText);
        proc.stdin.flush();
        proc.stdin.end();
      } catch (err) {
        await reap(proc);
        current = null;
        return terminate("adapter-error", `codex stdin closed: ${err instanceof Error ? err.message : String(err)}`);
      }

      const queue = new MessageQueue();
      wakeReader = (): void => queue.push({ type: WAKE_TYPE });
      const stderrChunks: string[] = [];
      let failure: CodexFailure | null = null;
      const failureTexts: string[] = [];
      const stdoutTask = (async () => {
        for await (const line of readLines(proc.stdout)) {
          if (line.trim().length === 0) continue;
          const parsed = parseCodexEvent(line);
          if (parsed === null) {
            trajectory.append({ t: "codex_unparseable", turn, line: line.slice(0, 500) });
            failure ??= detectCodexFailure(line);
            continue;
          }
          queue.push(parsed);
        }
        queue.end();
      })();
      const stderrTask = (async () => {
        for await (const line of readLines(proc.stderr)) {
          if (line.trim().length === 0) continue;
          stderrChunks.push(line);
          failure ??= detectCodexFailure(line);
          trajectory.append({ t: "codex_stderr", turn, text: line.slice(0, 500) });
        }
      })();

      let turnCompleted = false;
      let usageRaw: unknown;
      let sawOutput = false;
      let lastText = "";
      let items = 0;
      turnInFlight = true;
      for (;;) {
        const wd = windDown as WindDown | null;
        const msg = wd === null ? await queue.next() : await nextBefore(queue, wd.deadline);
        if (msg === GRACE_EXPIRED) {
          finishWindDown("grace-expired");
          break;
        }
        if (msg === null) {
          // The process ended: the turn is over whatever it said last.
          finishWindDown("exit");
          break;
        }
        switch (msg["type"]) {
          case "thread.started": {
            const id = msg["thread_id"];
            if (typeof id === "string" && id.length > 0) {
              if (threadId !== id) {
                trajectory.append({ t: "codex_thread", turn, threadId: id });
                // The supervisor's sweep keeps the rollout of the thread this names.
                writeCodexThread(o.runDir, id);
                if (threadId !== undefined) leftThreads.push(threadId);
                ownThreads.add(id);
              }
              threadId = id;
            }
            break;
          }
          case "item.completed": {
            const item = msg["item"] as Record<string, unknown> | undefined;
            if (item === undefined) break;
            items++;
            const kind = item["type"];
            if (kind === "agent_message" && typeof item["text"] === "string") {
              const text = item["text"] as string;
              if (text.length > 0) {
                sawOutput = true;
                watchdogs.noteModelOutput();
                lastText = text;
                pushResponse({ t: "response", turn, message: { role: "assistant", content: text } });
              }
            } else if (kind === "mcp_tool_call") {
              sawOutput = true;
              // The MCP side already recorded the call and its result
              // authoritatively; this mirrors the claude driver's tool_use
              // block on the response, and keeps a call the CLI failed
              // BEFORE it reached us (approval, timeout) on the record.
              pushResponse({
                t: "response",
                turn,
                message: {
                  role: "assistant",
                  content: null,
                  tool_uses: [{ id: item["id"] ?? "", name: `${String(item["server"] ?? "")}.${String(item["tool"] ?? "")}`, input: item["arguments"] }],
                },
              });
              if (item["error"] !== null && item["error"] !== undefined) {
                trajectory.append({ t: "codex_tool_error", turn, item });
              }
            } else if (kind === "reasoning" && typeof item["text"] === "string") {
              trajectory.append({ t: "codex_reasoning", turn, text: (item["text"] as string).slice(0, 2_000) });
            } else if (kind === "error" && typeof item["message"] === "string") {
              // The server moved the turn to another model mid-flight. The
              // run's resolved model stays the first one seen (the rule
              // every driver keeps); the reroute is on the record beside it.
              const r = REROUTED.exec(item["message"] as string);
              if (r !== null) trajectory.append({ t: "harness", kind: "model_rerouted", turn, from: r[1], to: r[2], reason: r[3] ?? null });
            }
            break;
          }
          case "turn.completed": {
            turnCompleted = true;
            usageRaw = msg["usage"];
            const cumulative = normalizeCodexUsage(usageRaw);
            let perTurn: { usage: CodexUsage; usageCumulative: CodexUsage } | undefined;
            if (cumulative !== undefined) {
              const key = threadId ?? "";
              const prev = threadTotals.get(key);
              if (codexUsageRegressed(prev, cumulative)) {
                // The thread lost turns (its rollout could not be written):
                // the delta floors at zero and the next turn counts from here.
                trajectory.append({
                  t: "harness",
                  kind: "usage_regressed",
                  turn,
                  threadId: threadId ?? null,
                  previous: prev,
                  reported: cumulative,
                });
              }
              threadTotals.set(key, cumulative);
              perTurn = { usage: codexUsageDelta(prev, cumulative), usageCumulative: cumulative };
            }
            if (pendingResponse === null) {
              // No response at all this turn: an entry so the tokens count.
              pendingResponse = { t: "response", turn, message: { role: "assistant", content: null } };
            }
            const lastCall = lastCalls.read(threadId);
            flushPendingResponse(
              perTurn === undefined && lastCall === undefined
                ? undefined
                : { ...perTurn, ...(lastCall !== undefined ? { lastCall } : {}) },
            );
            trajectory.append({
              t: "codex_result",
              turn,
              status: "completed",
              threadId: threadId ?? null,
              durationMs: Date.now() - startedAt,
              items,
              usageRaw,
              ...(perTurn !== undefined ? perTurn : {}),
              text: lastText.slice(0, 2_000),
            });
            finishWindDown("result");
            break;
          }
          case "turn.failed":
          case "error": {
            if (isRetryNotice(msg)) {
              // The CLI is retrying; its words go on the record for the
              // operator and nowhere near the classifier (header).
              trajectory.append({ t: "codex_retry", turn, message: String(msg["message"]).slice(0, 500), durationMs: Date.now() - startedAt });
              break;
            }
            const errText = JSON.stringify(msg["error"] ?? msg["message"] ?? msg).slice(0, 2_000);
            failureTexts.push(errText);
            failure ??= detectCodexFailure(errText);
            trajectory.append({
              t: "codex_result",
              turn,
              status: msg["type"] === "error" ? "error" : "failed",
              threadId: threadId ?? null,
              durationMs: Date.now() - startedAt,
              items,
              // Verbatim: a provider-policy stop is the operator's to read.
              error: msg["error"] ?? msg["message"] ?? null,
              text: lastText.slice(0, 2_000),
            });
            break;
          }
          default:
            // turn.started, item.started, item.updated, the wake marker
            break;
        }
        // A detected failure ends the read: the CLI is on its way out, and a
        // wind-down is `done()` by construction — keep reading until
        // `finishWindDown` runs, exactly as the claude driver does.
        if (failure !== null || (done() && (windDown as WindDown | null) === null)) break;
      }
      turnInFlight = false;
      finishWindDown("exit");
      // The turn's process is done with either way: let it leave (or make it),
      // then drain what it wrote, then decide.
      await reap(proc);
      current = null;
      await stdoutTask.catch(() => undefined);
      await stderrTask.catch(() => undefined);
      const exitCode = await proc.exited.catch(() => null);
      // The process has exited, so the rollout holds every line of this turn.
      const followed = rollout.read(threadId);
      for (const c of followed.compactions) trajectory.append(codexCompactionRecord(turn, c));
      if (!resolvedModel && followed.model !== undefined) {
        resolvedModel = true;
        trajectory.recordResolved(runId, { model: followed.model, cliVersion: version });
      }
      if (followed.rateLimits !== undefined) {
        observedLimits = followed.rateLimits;
        usage.observe(followed.rateLimits, Date.now());
      }
      // A thread this turn moved off was read to its end after the turn before.
      dropRollouts(leftThreads.splice(0), "thread-change");

      if (done()) return finish();
      failure ??= detectCodexFailure(stderrChunks.join("\n"));
      if (failure !== null) {
        if (failure.kind === "pause") {
          // A spent quota waits for its window's reset, when the rollout named
          // one: every attempt before it is a refusal already announced.
          const now = Date.now();
          const notBefore = failure.reason === "quota-exhausted" ? usage.quotaReset(now, codexStatedReset(failure.detail, now), config.model) : undefined;
          if (notBefore !== undefined) {
            return pause(failure.reason, `${failure.detail} (usage window resets ${new Date(notBefore).toISOString()})`, notBefore);
          }
          return pause(failure.reason, failure.detail);
        }
        return terminate(failure.reason, failure.detail);
      }
      if (!turnCompleted) {
        failedTurns++;
        const why = failureTexts[failureTexts.length - 1] ?? stderrChunks.slice(-3).join(" | ").slice(0, 300);
        if (threadId === undefined) {
          return terminate("adapter-error", `codex exited (code ${exitCode}) before starting a thread: ${why}`);
        }
        if (failedTurns >= MAX_CONSECUTIVE_FAILED_TURNS) {
          return terminate("adapter-error", `codex failed ${failedTurns} turns in a row (last exit ${exitCode}): ${why}`);
        }
        // The CLI's own words are the operator's, not the model's: they name
        // the CLI's internals, which the model cannot act on. They go on the
        // record; the model is told only that the turn ended early.
        trajectory.append({
          t: "harness",
          kind: "session_note",
          text: `turn ${turn} failed in the CLI (exit ${exitCode}): ${why.slice(0, 600)}`,
        });
        pendingNotices.push({
          ts: Date.now(),
          kind: "session_note",
          text: "the previous turn ended with an error from the CLI before it finished.",
        });
      } else {
        failedTurns = 0;
      }
      if (!sawOutput) {
        trajectory.append({ t: "harness", kind: "session_note", text: `turn ${turn} produced no assistant output` });
      }

      // A window the CLI would cap to its own limit ends the run at the first
      // turn that reports the model's window, before it records a condition
      // nothing applied (`compactWindowCapRefusal`, cli-compaction.ts).
      const reportedWindow = followed.context?.window;
      if (!windowChecked && reportedWindow !== undefined) {
        windowChecked = true;
        const capped = codexWindowCapRefusal(config.compactWindow, reportedWindow);
        if (capped !== null) return terminate("harness-error", capped);
      }
      if (config.maxTurns !== undefined && turn >= config.maxTurns) {
        return terminate("turn-limit", `${turn} turns`);
      }
      // The freeplay gate, at the turn boundary: a lane at or over the
      // freeplay threshold stops the run until the window resets. Never a
      // scored run: pausing one would spend its attempt.
      if (config.episode === "freeplay") {
        const now = Date.now();
        const hold = usage.freeplayHold(thresholds.freeplay, now, config.model);
        if (hold !== null) {
          return pause(
            SUBSCRIPTION_PAUSE,
            `subscription usage at or over the freeplay threshold (${hold.threshold}%): ${describeWindows(hold.windows, usage.current?.observedAt ?? now)}`,
            hold.until,
          );
        }
      }
      // The episodic-log ask, delivered in the next turn's context: the
      // context is the last call's input plus output as the rollout reported
      // it, the threshold the pinned CLI's rule over the window it reported,
      // never above the run's own window.
      const ask = compactionAsk.noteTurn({
        context: followed.context?.total,
        threshold:
          reportedWindow !== undefined ? codexAutoCompactLimit(reportedWindow, config.compactWindow) : compactWindowTokens(config.compactWindow),
        compactions: followed.compactions.map((c) => c.preTokens),
      });
      if (ask !== null) {
        pendingNotices.push(compactionNotice(ask.ask, Date.now()));
        trajectory.append({ t: "harness", kind: "compaction_ask", turn, ...ask });
      }
      await sleep(config.stepIntervalMs);
    }
  } catch (err) {
    return terminate("harness-error", err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  } finally {
    await shutdown();
  }
}

/** The codex render of the fixed prompt, for tests and the README. */
export { CODEX_SYSTEM_PROMPT };
