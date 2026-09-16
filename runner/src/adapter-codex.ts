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
 * `SandboxHost`, tools over a loopback TCP MCP server plus `mcp-bridge.ts`,
 * the tool-call ceiling and the watchdogs enforced at the MCP boundary, a
 * wind-down instead of a kill mid-turn, a process-group kill on stop, and the
 * child environment constructed so the CLI can bill exactly one lane. Read
 * that file's header for the reasoning behind each; this header covers only
 * where Codex differs and why.
 *
 * ## Transport: `codex exec` + `codex exec resume`, one process per turn
 *
 * Claude Code takes stream-json on a long-lived stdin. Codex has no such mode
 * in 0.153.4: `codex exec --json` runs ONE turn and exits, and a persisted
 * thread is continued with `codex exec resume <thread_id>`. So this driver
 * spawns one CLI process per driver turn — the first with `exec`, every later
 * one with `exec resume <id>` — and the thread lives in `$CODEX_HOME/sessions`
 * between them. Each spawn re-pays the CLI's startup and MCP handshake (a
 * second or two), which is why the record shape names the thread.
 *
 * `codex app-server` (JSON-RPC over stdio: `thread/start`, `turn/start`,
 * `thread/tokenUsage/updated`, `account/rateLimits/updated`, typed misalignment
 * steers) is the upgrade path once it leaves "experimental"; it would give a
 * long-lived process and the rate-limit surface exec mode never reports.
 * Tracked in docs/FOLLOW-UPS.md.
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
 * tool; `web_search="disabled"` removes search. What remains built in is
 * `request_user_input`, `view_image` and `apply_patch` (their config switches
 * have no effect in 0.153.4) — inert under `sandbox_mode="read-only"` in an
 * empty temp cwd. Our nine tools arrive via `mcp_servers.wrathbench.*`
 * overrides on the command line (`--ignore-user-config` keeps the operator's
 * ~/.codex/config.toml — trusted projects, other MCP servers — out of the run;
 * auth still comes from CODEX_HOME). Codex presents them to the model as
 * `mcp__wrathbench.<tool>` and calls our server with the plain `<tool>` name.
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
 * OPENAI_BASE_URL its endpoint. So the child environment drops every
 * `OPENAI_*` and `CODEX_*` variable and the whole Anthropic/Bedrock/Vertex set
 * the claude driver drops, then sets exactly one thing back: `CODEX_HOME`, to
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
 * `turn.completed` carries the turn's usage (`input_tokens`,
 * `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`,
 * `reasoning_output_tokens`) and nothing else: no cost (a subscription has no
 * per-turn price, so cost stays absent as on the Claude lanes) and — in exec
 * mode — no rate-limit window (codex issue #14728). Exhaustion therefore shows
 * up only as a failed turn: `turn.failed` / `error` with a message, sometimes
 * a `codexErrorInfo` (usageLimitExceeded, rateLimitExceeded,
 * contextWindowExceeded, sessionBudgetExceeded, misalignmentPolicyViolation).
 * `detectCodexFailure` maps those: usage limit → the same `quota-exhausted`
 * pause the claude driver uses for its window; rate limit → `rate-limited`;
 * a dead login → `auth-failed`; a blown context window → the `context-limit`
 * termination; and the model's own policy monitor stopping the task (GPT-6
 * Astra's misalignment monitor, which can halt long agentic work and has
 * nobody to ask in exec mode) → `provider-policy`, with the message recorded
 * verbatim and NO automatic steer or override — that is the operator's call.
 */

import type { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { MCP_SERVER_NAME, toolCallLimitReached } from "./adapter-claude";
import { DEFAULT_CODEX_HOME_ENV, harnessOf, type PauseReason, type RunConfig, type TerminationReason } from "./config";
import { ContextBuilder, startStateTicker, stopRequestOf, type LoopOutcome } from "./loop";
import { McpServer } from "./mcp";
import { CODEX_SYSTEM_PROMPT, buildSystemPrompt } from "./prompt";
import type { ToolContext } from "./tools";
import type { EpisodicLog } from "./episodic";
import type { HarnessNotice, SandboxHost } from "./sandbox/host";
import type { Scratchpad } from "./scratchpad";
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
 * Variable prefixes that would let the CLI authenticate or bill anything but
 * the lane, or belong to another driver. `CODEX_` covers CODEX_API_KEY and
 * CODEX_ACCESS_TOKEN (the CLI's two overrides of the persisted login) and
 * every CODEX_HOME* lane variable; the chosen lane's directory is put back
 * under the one name the CLI reads. `OPENAI_` is not an auth source for the
 * CLI but is the `openai` driver's key and base URL, dropped so the two
 * drivers can never bleed into each other. The Anthropic/cloud set is the
 * claude driver's list, kept so a run under this driver is exactly as blind to
 * those credentials as a run under that one.
 */
export const BILLING_ENV_PREFIXES = ["OPENAI_", "CODEX_", "ANTHROPIC_", "AWS_", "GOOGLE_", "GCLOUD_", "CLOUDSDK_", "CLAUDE_CODE_OAUTH_TOKEN"];
/** Named for readers and tests; every one is already covered by a prefix above. */
export const BILLING_ENV_EXACT = [
  "CODEX_API_KEY",
  "CODEX_ACCESS_TOKEN",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
  "CLAUDE_CODE_SKIP_VERTEX_AUTH",
  "CLAUDE_CODE_API_KEY_HELPER_TTL_MS",
];

/** Not billing: the database. Same reason as the claude driver's `DB_ENV_PREFIX`. */
const DB_ENV_PREFIX = "WRATHBENCH_DB_";

/**
 * The child environment, constructed rather than inherited.
 *
 * One credential survives, and it is the one the run's LANE names: the
 * directory in `$<laneEnv>` becomes `CODEX_HOME`, the only name the CLI reads.
 * Every other `CODEX_*` variable is gone, so a second lane's directory
 * (`CODEX_HOME_2`) is not in the child's environment at all, and neither is
 * an API key that would outrank the ChatGPT login. An unset lane leaves
 * `CODEX_HOME` unset: the CLI then has no login to bill and refuses, which is
 * what `run.ts` checks for before it gets this far.
 */
export function childEnv(
  parent: Record<string, string | undefined>,
  o: { laneEnv?: string; extra?: Record<string, string> },
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parent)) {
    if (v === undefined) continue;
    if (BILLING_ENV_PREFIXES.some((p) => k.startsWith(p))) continue;
    if (BILLING_ENV_EXACT.includes(k)) continue;
    if (k.startsWith(DB_ENV_PREFIX)) continue;
    out[k] = v;
  }
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
 * may also contain; usage before rate because "rate limit" text is what a
 * spent usage window is sometimes wrapped in.
 */
export function detectCodexFailure(text: string | undefined | null): CodexFailure | null {
  if (text === undefined || text === null) return null;
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  const detail = trimmed.slice(0, 600);
  if (POLICY_PATTERNS.some((p) => p.test(trimmed))) return { kind: "terminate", reason: "provider-policy", detail };
  if (CONTEXT_PATTERNS.some((p) => p.test(trimmed))) return { kind: "terminate", reason: "context-limit", detail };
  if (USAGE_PATTERNS.some((p) => p.test(trimmed))) return { kind: "pause", reason: "quota-exhausted", detail };
  if (RATE_PATTERNS.some((p) => p.test(trimmed))) return { kind: "pause", reason: "rate-limited", detail };
  if (AUTH_PATTERNS.some((p) => p.test(trimmed))) return { kind: "pause", reason: "auth-failed", detail };
  return null;
}

// ------------------------------------------------------------------- stream

/** Exec JSONL envelopes we act on. Loose: an unknown field must never break a run. */
const eventSchema = z.looseObject({ type: z.string() });

/**
 * The CLI's per-turn accounting in the one shape the harness reads. Codex
 * counts like OpenAI: `input_tokens` is the whole prompt with the cached part
 * as a subset, which is already the runner's `prompt_tokens` convention, so
 * nothing is summed. `cache_write_input_tokens` and `reasoning_output_tokens`
 * are kept only when present, because "unknown" and "zero" must not render
 * alike.
 */
export interface CodexUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cached_tokens?: number;
  cache_write_tokens?: number;
  reasoning_tokens?: number;
}

export function normalizeCodexUsage(raw: unknown): CodexUsage | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const u = raw as Record<string, unknown>;
  const n = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const input = n(u["input_tokens"]);
  const output = n(u["output_tokens"]);
  const read = n(u["cached_input_tokens"]);
  const write = n(u["cache_write_input_tokens"]);
  const reasoning = n(u["reasoning_output_tokens"]);
  if (input === undefined && output === undefined) return undefined;
  const prompt = input ?? 0;
  const completion = output ?? 0;
  const usage: CodexUsage = { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
  if (read !== undefined) usage.cached_tokens = read;
  if (write !== undefined) usage.cache_write_tokens = write;
  if (reasoning !== undefined) usage.reasoning_tokens = reasoning;
  return usage;
}

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

/** The envelope type `wakeReader` pushes; not a CLI event, and acted on nowhere. */
const WAKE_TYPE = "__wrathbench_wake";

/** A tiny async queue: the stdout reader pushes, the turn loop pulls. Ends when the process does. */
class MessageQueue {
  private readonly items: Record<string, unknown>[] = [];
  private readonly waiters: ((v: Record<string, unknown> | null) => void)[] = [];
  private ended = false;

  push(item: Record<string, unknown>): void {
    const waiter = this.waiters.shift();
    if (waiter !== undefined) waiter(item);
    else this.items.push(item);
  }

  end(): void {
    this.ended = true;
    while (this.waiters.length > 0) this.waiters.shift()!(null);
  }

  next(): Promise<Record<string, unknown> | null> {
    const item = this.items.shift();
    if (item !== undefined) return Promise.resolve(item);
    if (this.ended) return Promise.resolve(null);
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of stream) {
    buf += decoder.decode(chunk, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      yield buf.slice(0, idx);
      buf = buf.slice(idx + 1);
    }
  }
  if (buf.trim().length > 0) yield buf;
}

// -------------------------------------------------------------------- flags

/** A TOML basic string, for values handed to `-c key=value`. */
export function tomlString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Features switched off for every run. Each is a name `codex features list`
 * knows in 0.153.4; an unknown one is a hard error at launch ("Unknown feature
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
  /** The fixed system prompt, written to disk: replaces the CLI's base instructions. */
  instructionsPath: string;
  /** The interpreter and the bridge script the CLI launches as the MCP server, plus the runner's port. */
  bunBin: string;
  bridgePath: string;
  mcpPort: number;
}

/**
 * The exact flag set, in one place so the README and the tests can assert it.
 * Every flag exists in codex-cli 0.153.4 (`codex exec --help`, `codex exec
 * resume --help`); nothing is invented. `-s`/`-C` are exec-only in this
 * version, so the sandbox rides on `-c sandbox_mode` and the cwd on the
 * process, which keeps the first turn and every resumed one identical apart
 * from the `resume <id>` words.
 */
export function codexArgs(o: CodexArgsOptions): string[] {
  const refusal = codexEffortRefusal(o.effort);
  if (refusal !== null) throw new Error(refusal);
  const config: string[] = [
    `web_search="disabled"`,
    `approval_policy="never"`,
    `sandbox_mode="read-only"`,
    `model_instructions_file=${tomlString(o.instructionsPath)}`,
    ...(o.effort !== undefined ? [`model_reasoning_effort=${tomlString(o.effort)}`] : []),
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

/**
 * Signal the CLI's whole process group, falling back to the process itself.
 * Same reason as the claude driver's: the CLI spawns the MCP bridge, and a
 * signal to the CLI alone leaves that grandchild reparented to init.
 */
function signalGroup(proc: { pid: number; kill: (sig: NodeJS.Signals) => void }, sig: NodeJS.Signals): void {
  try {
    process.kill(-proc.pid, sig);
    return;
  } catch {
    // no such group (already reaped, or not detached): fall through
  }
  try {
    proc.kill(sig);
  } catch {
    // already gone
  }
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
  const pause = (reason: PauseReason, detail: string): LoopOutcome => {
    if (done()) return finish();
    trajectory.setPause(runId, reason, detail, watchdogs.elapsedMs());
    return { kind: "paused", reason, detail };
  };

  const builder = new ContextBuilder({
    config,
    sandbox: o.sandbox,
    scratchpad: o.scratchpad,
    trajectory,
    watchdogs,
    ...(o.turnOffset !== undefined ? { turnOffset: o.turnOffset } : {}),
    ...(o.now !== undefined ? { now: o.now } : {}),
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
    onToolCall: (name, args, result) => {
      // Codex calls with the plain tool name; the claude prefix is stripped
      // defensively so both drivers' records read alike.
      const short = name.replace(`mcp__${MCP_SERVER_NAME}__`, "").replace(`mcp__${MCP_SERVER_NAME}.`, "");
      trajectory.append({ t: "tool_call", turn, call: toolCalls, name: short, args });
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
  const systemPrompt = buildSystemPrompt(config.objective, config.episode, harnessOf("codex"), config.wiki);
  writeFileSync(instructionsPath, systemPrompt, "utf8");
  // The bridge by its REPOSITORY path: the CLI's sandbox gives MCP servers a
  // private /tmp, so a temp copy would not be found ("Module not found").
  const bridgePath = new URL("./mcp-bridge.ts", import.meta.url).pathname;
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
  });
  const version = cliVersion(bin, env);
  if (version !== null) trajectory.recordResolved(runId, { model: null, cliVersion: version });

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
    process.off("exit", onProcessExit);
    listener.stop(true);
  };

  const pendingNotices: HarnessNotice[] = [...(o.initialNotices ?? [])];
  /**
   * The turn's usage arrives once, on `turn.completed`, after every item. So
   * the newest `response` entry of a turn is held back until the turn closes
   * and carries that usage — counted exactly once per turn, which is what a
   * consumer summing `response` usage (viewer/tail.ts) needs. A turn with no
   * response at all still gets one entry, content null, so its tokens count.
   */
  let pendingResponse: (Record<string, unknown> & { t: string }) | null = null;
  const flushPendingResponse = (usage?: CodexUsage): void => {
    if (pendingResponse === null) return;
    const entry = pendingResponse;
    pendingResponse = null;
    trajectory.append(usage !== undefined ? { ...entry, usage } : entry);
  };
  const pushResponse = (entry: Record<string, unknown> & { t: string }): void => {
    flushPendingResponse();
    pendingResponse = entry;
  };

  let threadId: string | undefined;
  let failedTurns = 0;

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
      let usage: CodexUsage | undefined;
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
              if (threadId !== id) trajectory.append({ t: "codex_thread", turn, threadId: id });
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
            }
            break;
          }
          case "turn.completed": {
            turnCompleted = true;
            usageRaw = msg["usage"];
            usage = normalizeCodexUsage(usageRaw);
            if (pendingResponse === null) {
              // No response at all this turn: an entry so the tokens count.
              pendingResponse = { t: "response", turn, message: { role: "assistant", content: null } };
            }
            flushPendingResponse(usage);
            trajectory.append({
              t: "codex_result",
              turn,
              status: "completed",
              threadId: threadId ?? null,
              durationMs: Date.now() - startedAt,
              items,
              usageRaw,
              usage,
              text: lastText.slice(0, 2_000),
            });
            finishWindDown("result");
            break;
          }
          case "turn.failed":
          case "error": {
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

      if (done()) return finish();
      failure ??= detectCodexFailure(stderrChunks.join("\n"));
      if (failure !== null) {
        if (failure.kind === "pause") return pause(failure.reason, failure.detail);
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
        pendingNotices.push({
          ts: Date.now(),
          kind: "session_note",
          text: `the previous turn ended with an error from the CLI: ${why.slice(0, 300)}`,
        });
      } else {
        failedTurns = 0;
      }
      if (!sawOutput) {
        trajectory.append({ t: "harness", kind: "session_note", text: `turn ${turn} produced no assistant output` });
      }

      if (config.maxTurns !== undefined && turn >= config.maxTurns) {
        return terminate("turn-limit", `${turn} turns`);
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
