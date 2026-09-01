/**
 * The claude-code driver: the Claude Code CLI as harness and transport.
 *
 * Runs launched here belong to the `claude-code` harness — a comparability
 * group of their own, scored against each other and never against the fixed
 * loop's (`wrathbench`) rows. Not a shakeout, not a penalty: a different loop.
 *
 * ## Why this is an episode driver and not a `ChatAdapter`
 *
 * `ChatAdapter.complete()` is "one request, one assistant turn": the runner
 * owns the loop, the context, and the tool dispatch. `claude -p` is not that
 * shape. It runs its own agentic loop — it will call tools, read results and
 * call more tools until it decides the turn is finished. Wrapping it in
 * `complete()` would mean either throwing away its tool loop or lying about
 * what a "turn" is. So this driver replaces the inner loop instead: it owns
 * one long-lived `claude` process and feeds it the harness's context message
 * once per driver turn, while every other piece of the harness — sandbox,
 * watchdogs, trajectory, scratchpad, named termination/pause reasons, the
 * fixed system prompt, the nine tools, the fixed context assembly — is the
 * same machinery the fixed loop uses.
 *
 * ## How it is wired
 *
 * - One process, kept alive for the whole episode, via
 *   `--input-format stream-json --output-format stream-json`. Each driver turn
 *   writes one user message to its stdin and reads stream-json until the
 *   `result` message that closes the turn. (`--continue` per turn was the
 *   fallback; it is not needed and would re-pay session startup every turn.)
 * - Tools reach the runner's *single* SandboxHost over a loopback TCP MCP
 *   server plus `mcp-bridge.ts` (see that file for why the bridge exists).
 *   The MCP server is `mcp.ts`'s `McpServer` over `tools.ts` — the same six
 *   tools, the same dispatch, the same trajectory records.
 * - Billing: the child environment is constructed explicitly and every
 *   Anthropic/Bedrock/Vertex credential variable is dropped, so the CLI can
 *   only bill the subscription this run was scheduled on — its LANE, named by
 *   `RunConfig.subscription` and copied onto `CLAUDE_CODE_OAUTH_TOKEN` — or
 *   refuse. It can never silently fall back to API-key credits, and it never
 *   sees another lane's token.
 *
 * ## Measured scaffold gap (claude 2.1.238, verified against a local capture
 * proxy, no model calls)
 *
 * With `--tools ""` the request carries *only* our six MCP tools, named
 * `mcp__wrathbench__<tool>`. What remains that the fixed loop does not have:
 *
 *  1. Claude Code keeps its own conversation history across turns and applies
 *     its own compaction. The context policy's 24-message window is therefore
 *     NOT in force. This is the big one: an unversioned, model-side summarizer
 *     sits inside the scaffold, which is why these runs are their own harness
 *     group rather than `wrathbench` rows.
 *  2. Two system blocks precede our prompt: a billing header and
 *     "You are a Claude agent, built on Anthropic's Claude Agent SDK."
 *  3. Every user message is prefixed with a `<system-reminder>` block (the
 *     current date, and whatever else the CLI decides to inject).
 *  4. Skills and subagents are still registered as slash commands even though
 *     no built-in tool is exposed.
 *  5. There is no `--max-turns` in this CLI version, so `maxTurns` bounds only
 *     driver turns. The first real subscription run spent 40 minutes and 168
 *     tool calls inside ONE driver turn, which is why control is enforced at
 *     the MCP boundary instead: every tool dispatch re-checks the watchdogs
 *     and the `maxToolCallsPerEpisode` ceiling, and a coarse timer covers a
 *     turn that makes no tool calls at all.
 *
 * That list is why `harness: "claude-code"` is in the comparability tuple, and
 * why the tool-call ceiling exists at all.
 *
 * ## Winding down instead of killing mid-turn
 *
 * The whole episode is usually ONE CLI turn, and the only place the finished
 * output count, the metered cost and the turn clock ever appear is the
 * stream-json `result` envelope that closes it (`claude_result`). So killing
 * the CLI the instant a watchdog fires threw all three away: on 2026-08-25, 6
 * of 9 lane-2 runs fell back to `tokens.source: "snapshot"` — the API's
 * `message_start` snapshots, ~300× low — with no cost at all.
 *
 * So a watchdog or the tool-call ceiling firing WHILE A TURN IS IN FLIGHT no
 * longer sends SIGTERM. The termination is recorded first, exactly as before —
 * same reason, same `termination` record, and playtime closes at it — and then
 * the driver winds down:
 *
 * - every subsequent MCP `tools/call` is refused with an `isError` result that
 *   tells the model the episode is over and to stop calling tools. Nothing is
 *   dispatched to the sandbox, so no observation or action reaches the game
 *   after the termination (docs/CONTRACTS.md);
 * - the driver keeps reading the CLI's stream for a bounded grace
 *   (`windDownGraceMs`, 90s) so the closing `result` can land;
 * - it ends on that `result`, on the CLI exiting, or on the grace expiring,
 *   and tears down through the same `shutdown()` either way.
 *
 * One `wind-down` record says which of the three happened and how long it
 * waited. The grace is not playtime: the `termination` record that closes the
 * active segment was written before it started.
 *
 * Operator intent keeps the old behaviour: a signalled stop or pause
 * (`pauseEpisode`, the abort handler) kills immediately, because the operator
 * asked for the process to go, not for one more measurement.
 */

import type { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { DEFAULT_CLAUDE_TOKEN_ENV, harnessOf, type PauseReason, type RunConfig, type TerminationReason } from "./config";
import { ContextBuilder, startStateTicker, stopRequestOf, type LoopOutcome } from "./loop";
import { McpServer } from "./mcp";
import { CLAUDE_CODE_SYSTEM_PROMPT, buildSystemPrompt } from "./prompt";
import { TOOLS, type ToolContext } from "./tools";
import type { EpisodicLog } from "./episodic";
import type { HarnessNotice, SandboxHost } from "./sandbox/host";
import type { Scratchpad } from "./scratchpad";
import type { Trajectory } from "./trajectory";
import type { Watchdogs } from "./watchdogs";

/** MCP server name in the generated config; also the tool-name prefix. */
export const MCP_SERVER_NAME = "wrathbench";

/** The nine tools as `claude` names them once they arrive over MCP. */
export function mcpToolNames(): string[] {
  return TOOLS.map((t) => `mcp__${MCP_SERVER_NAME}__${t.name}`);
}

// ------------------------------------------------------------------ billing

/**
 * Credential variables that would let the CLI bill something other than the
 * subscription. Dropped by prefix so a new `ANTHROPIC_*` knob cannot appear
 * behind our back.
 */
export const BILLING_ENV_PREFIXES = ["ANTHROPIC_", "AWS_", "GOOGLE_", "GCLOUD_", "CLOUDSDK_"];
export const BILLING_ENV_EXACT = [
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
  "CLAUDE_CODE_SKIP_VERTEX_AUTH",
  "CLAUDE_CODE_API_KEY_HELPER_TTL_MS",
];

/**
 * Not billing: the database. The `runner` and `fleet` services carry
 * WRATHBENCH_DB_* so the gate's smokes can stage a fixture, and this CLI is the
 * model's own process. It is launched with `--tools ""` and only our six MCP
 * tools, so it has no Bash or Read to dump its environment with — but the
 * credential has no business being in there either way, and the snippet sandbox
 * drops it for the same reason (sandboxChildEnv in sandbox/host.ts). Root on
 * acore_characters is the server-side shortcut docs/CONTRACTS.md forbids.
 */
const DB_ENV_PREFIX = "WRATHBENCH_DB_";

/**
 * Not billing either: the CLI's thinking budget. The run's `effort` is the only
 * thing that may set it (`thinkingEnv`), so an operator's shell variable cannot
 * silently become a run dimension nobody recorded.
 */
const THINKING_ENV = "MAX_THINKING_TOKENS";

/**
 * The child environment, constructed rather than inherited.
 *
 * One credential survives, and it is the one the run's LANE names: the token in
 * `$<tokenEnv>` is copied onto `CLAUDE_CODE_OAUTH_TOKEN`, the only name the CLI
 * knows. Every other `CLAUDE_CODE_OAUTH_TOKEN*` variable is dropped by prefix,
 * so a second subscription's token (`..._2`) is never in the child's
 * environment at all — a run bills the subscription it was scheduled on, and
 * cannot see, let alone spend, the other one. The prefix also covers a third
 * lane arriving later without another edit here.
 *
 * The CLI reports `apiKeySource: "ANTHROPIC_API_KEY"` whenever that variable is
 * set, so leaving it in place would spend API credits instead of the
 * subscription; `CLAUDE_CONFIG_DIR` is redirected into the run directory so no
 * user-level settings, skills, hooks, memory or `apiKeyHelper` are read; and
 * `WRATHBENCH_DB_*` is dropped too — see `DB_ENV_PREFIX`.
 */
export function childEnv(
  parent: Record<string, string | undefined>,
  o: { configDir: string; tokenEnv?: string; extra?: Record<string, string> },
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parent)) {
    if (v === undefined) continue;
    if (BILLING_ENV_PREFIXES.some((p) => k.startsWith(p))) continue;
    if (BILLING_ENV_EXACT.includes(k)) continue;
    if (k.startsWith(DB_ENV_PREFIX)) continue;
    if (k.startsWith(DEFAULT_CLAUDE_TOKEN_ENV)) continue;
    if (k === THINKING_ENV) continue;
    out[k] = v;
  }
  const token = parent[o.tokenEnv ?? DEFAULT_CLAUDE_TOKEN_ENV];
  if (token !== undefined && token.length > 0) out[DEFAULT_CLAUDE_TOKEN_ENV] = token;
  out["CLAUDE_CONFIG_DIR"] = o.configDir;
  // Belt and braces: the CLI treats an empty string as unset for these.
  delete out["ANTHROPIC_API_KEY"];
  return { ...out, ...(o.extra ?? {}) };
}

// ------------------------------------------------------------- limit detect

const LIMIT_EPOCH = /usage limit reached\|(\d{9,13})/i;
const LIMIT_PATTERNS = [
  /usage limit reached/i,
  /(hit|reached|exceeded) your [^.\n]{0,60}limit/i,
  /limit[^.\n]{0,60}reset(s|ting)?\b/i,
  /rate[_ ]limit[^\n]{0,60}(reset|upgrade)/i,
  /out of (credits|usage)/i,
];

/**
 * Whether the episode's tool-call ceiling has been reached, given how many
 * calls it has made and the ceiling it is under.
 *
 * `cap === null` is "no ceiling" and can never be reached. Extracted because
 * the comparison this replaces was `toolCalls >= cap` with `cap` widened to
 * `number | null`, and JS coerces null to 0 there: `0 >= null` is true, so an
 * uncapped run would have terminated `tool-call-limit` on its very first tool
 * call — the exact opposite of what the null is for. Enforcement is still one
 * branch in `enforceLimits`; this is only the question it asks.
 */
export function toolCallLimitReached(toolCalls: number, cap: number | null): boolean {
  return cap !== null && toolCalls >= cap;
}

/**
 * Subscription usage-window exhaustion, as the CLI reports it — the one place
 * where an exhausted *window* is literally what happened; it is still the same
 * spent-budget condition the API adapter's 402/quota path hits, so it shares
 * the `quota-exhausted` pause reason (see PAUSE_REASONS in config.ts). A spent
 * budget says nothing about the model, so it is a PAUSE: the run resumes when
 * the window does.
 *
 * Only ever called on CLI-originated text: stderr, an unparseable stdout line,
 * or an errored `result`. Never on assistant output — an agent narrating "the
 * daily quest limit resets at midnight" must not pause the run.
 */
export function detectLimit(text: string | undefined | null): { reason: PauseReason; detail: string } | null {
  if (text === undefined || text === null) return null;
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  if (!LIMIT_PATTERNS.some((p) => p.test(trimmed))) return null;
  const epoch = LIMIT_EPOCH.exec(trimmed);
  let detail = trimmed.slice(0, 400);
  if (epoch?.[1] !== undefined) {
    const raw = Number(epoch[1]);
    const ms = raw > 1e11 ? raw : raw * 1000;
    detail = `${detail} (resets at ${new Date(ms).toISOString()})`;
  }
  return { reason: "quota-exhausted", detail };
}

// ------------------------------------------------------------------- stream

/**
 * stream-json envelopes we act on. Loose: the CLI adds fields freely and an
 * unknown field must never break a run.
 */
const streamMessageSchema = z.looseObject({ type: z.string() });

interface AssistantBlock {
  type?: string;
  text?: string;
  name?: string;
  input?: unknown;
  id?: string;
}

function assistantBlocks(msg: Record<string, unknown>): AssistantBlock[] {
  const message = msg["message"] as { content?: unknown } | undefined;
  const content = message?.content;
  if (!Array.isArray(content)) return [];
  return content as AssistantBlock[];
}

/**
 * The CLI's token accounting, translated into the one shape the rest of the
 * harness reads.
 *
 * Every stream-json `assistant` envelope carries the usage of the API call that
 * produced it (`message.usage`), and the closing `result` envelope carries the
 * session total (`usage`). Anthropic reports `input_tokens` *excluding* what
 * came from or went into the cache, while the OpenAI-compatible `prompt_tokens`
 * the runner normalises to is the whole input with the cached part as a subset.
 * Summing the three keeps that invariant true across drivers, so a viewer can
 * do the same arithmetic either way. `cache_write_tokens` is the one field with
 * no OpenAI-compat counterpart: it is present only when the provider says so,
 * because "unknown" and "zero" must not render alike.
 */
export interface ClaudeUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cached_tokens?: number;
  cache_write_tokens?: number;
}

export function normalizeClaudeUsage(raw: unknown): ClaudeUsage | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const u = raw as Record<string, unknown>;
  const n = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const input = n(u["input_tokens"]);
  const output = n(u["output_tokens"]);
  const read = n(u["cache_read_input_tokens"]);
  const write = n(u["cache_creation_input_tokens"]);
  if (input === undefined && output === undefined && read === undefined && write === undefined) return undefined;
  const prompt = (input ?? 0) + (read ?? 0) + (write ?? 0);
  const completion = output ?? 0;
  const usage: ClaudeUsage = {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
  };
  if (read !== undefined) usage.cached_tokens = read;
  if (write !== undefined) usage.cache_write_tokens = write;
  return usage;
}

/** Usage off an `assistant` envelope, which nests it under `message`. */
function assistantUsage(msg: Record<string, unknown>): ClaudeUsage | undefined {
  const message = msg["message"] as { usage?: unknown } | undefined;
  return normalizeClaudeUsage(message?.usage);
}

/** The envelope type `wakeReader` pushes; not a CLI message, and acted on nowhere. */
const WAKE_TYPE = "__wrathbench_wake";

/** A tiny async queue: the stdout reader pushes, the turn loop pulls. */
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

export interface ClaudeArgsOptions {
  mcpConfigPath: string;
  model?: string | undefined;
  /** `--effort` level, when the run declares one. `none` is env, not a flag. */
  effort?: string | undefined;
  /** Defaults to the claude-code render of the fixed prompt, never the fixed loop's. */
  systemPrompt?: string;
}

/**
 * The effort level that means "no extended thinking".
 *
 * The CLI has no `--effort none`; it reads a thinking budget from
 * `MAX_THINKING_TOKENS`, and zero turns the feature off. Keeping this inside
 * the effort dimension rather than adding a flag of its own is what makes
 * `sonnet at none` one more row of the same (model, effort) matrix, comparable
 * to `sonnet at low` — nothing new is recorded, the run config already says it.
 */
export const NO_THINKING = "none";

/** Env the CLI needs for an effort level, where a level is not a flag. */
export function thinkingEnv(effort: string | undefined): Record<string, string> {
  return effort === NO_THINKING ? { [THINKING_ENV]: "0" } : {};
}

/**
 * Signal the CLI's whole process group, falling back to the process itself.
 *
 * The group is the point: the CLI spawns the MCP bridge, and killing only the
 * CLI leaves that grandchild reparented to init. `process.kill(-pid)` needs the
 * child to lead its own group, which is what `detached` buys.
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

/**
 * The exact flag set, in one place so the README and the tests can assert it.
 * Every flag here exists in claude 2.1.238 (`claude -p --help`); nothing is
 * invented. Notably absent: `--max-turns` (not in this CLI version — driver
 * turns are bounded by `maxTurns` in the runner instead) and
 * `--permission-mode` (`--allowed-tools` grants exactly our six, which is the
 * narrower grant).
 */
export function claudeArgs(o: ClaudeArgsOptions): string[] {
  return [
    "-p",
    // required by this CLI: -p + stream-json output demands --verbose
    "--verbose",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--system-prompt",
    o.systemPrompt ?? CLAUDE_CODE_SYSTEM_PROMPT,
    "--mcp-config",
    o.mcpConfigPath,
    "--strict-mcp-config",
    // "" disables the entire built-in tool set; only MCP tools remain
    "--tools",
    "",
    ...(o.model !== undefined ? ["--model", o.model] : []),
    // `--effort <low|medium|high|xhigh|max>` in 2.1.238. Only when the run
    // declares one: absent means the CLI's own default, which is not the same
    // as any named level. `none` is not one of the CLI's levels — it is
    // extended thinking off, which the CLI takes as `MAX_THINKING_TOKENS=0` in
    // its environment (`thinkingEnv`), so the flag stays off the line.
    ...(o.effort !== undefined && o.effort !== NO_THINKING ? ["--effort", o.effort] : []),
    // variadic, therefore last
    "--allowed-tools",
    ...mcpToolNames(),
  ];
}

// ------------------------------------------------------------------ episode

export interface ClaudeEpisodeOptions {
  config: RunConfig & { runId: string; token: string };
  runDir: string;
  sandbox: SandboxHost;
  scratchpad: Scratchpad;
  /** The run's append-only episodic log (`log_status` / `read_log`). */
  episodic: EpisodicLog;
  wiki?: Database | undefined;
  trajectory: Trajectory;
  watchdogs: Watchdogs;
  initialNotices?: HarnessNotice[];
  /** Turns this run recorded before this process; see `ContextBuilderOptions`. */
  turnOffset?: number;
  /** Executable to run. Tests point this at a scripted fake. */
  claudeBin?: string;
  /** Parent environment to derive the child environment from. */
  env?: Record<string, string | undefined>;
  /** Extra child env. Test hook only — never set from the CLI. */
  extraEnv?: Record<string, string>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** How often watchdogs are evaluated and the world sampled while a turn is in flight. */
  watchdogTickMs?: number;
  /** Grace between SIGTERM and SIGKILL when tearing the CLI down. */
  killGraceMs?: number;
  /**
   * Grace given to the CLI to close its turn with a `result` envelope after a
   * watchdog or the tool-call ceiling ended the episode mid-turn. Tool calls
   * are refused throughout; see the header. 0 restores the old immediate kill.
   */
  windDownGraceMs?: number;
  /**
   * Aborting ends the episode as `manual` — the runner's own SIGINT/SIGTERM
   * handler, so an externally killed run still finalises its termination
   * record instead of leaving the trajectory open.
   */
  signal?: AbortSignal;
}

/**
 * How long the CLI is given to close its turn after the harness has ended the
 * episode under it. Long because the point is to get the `result` envelope
 * that carries the only true output/cost figures the driver ever sees: the
 * model has to notice a refused tool call, stop, and let the API return. Not
 * the 5s SIGTERM→SIGKILL grace, which is about a process that will not die;
 * this is about a measurement that has not arrived. Nothing in it is playtime
 * and nothing in it can be scored.
 */
export const DEFAULT_WIND_DOWN_GRACE_MS = 90_000;

/**
 * A wind-down in progress: the episode is over and recorded, the CLI has NOT
 * been signalled, and the driver is reading its stream until the deadline in
 * the hope of a closing `result`.
 */
interface WindDown {
  /** Wall clock (real, not the injected `now`) at which the grace runs out. */
  deadline: number;
  since: number;
  /** The termination already on record; unchanged by anything that follows. */
  reason: TerminationReason;
}

export async function runClaudeEpisode(o: ClaudeEpisodeOptions): Promise<LoopOutcome> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const { config, trajectory, watchdogs } = o;
  const runId = config.runId;
  const windDownGraceMs = o.windDownGraceMs ?? DEFAULT_WIND_DOWN_GRACE_MS;

  /**
   * The single end-of-episode seam.
   *
   * A watchdog, the tool-call ceiling or a signal can fire while the CLI is
   * deep inside its own tool loop, so ending cannot wait for the turn to come
   * back. The termination record is written FIRST and exactly once, then the
   * CLI is torn down; everything that unwinds afterwards reports the reason
   * already recorded.
   */
  let ended: { reason: TerminationReason; detail?: string } | null = null;
  /**
   * The pause twin of `ended`: the supervisor is stopping and the run is to
   * be suspended, not judged. Recorded once, then the CLI is torn down the
   * same way; the CLI's own conversation is not reattached on resume (the
   * run is restarted with a fresh CLI session and stamped `resumedFresh`).
   */
  let pausedAs: { reason: PauseReason; detail: string } | null = null;
  let killClaude: () => void = () => undefined;
  /**
   * Wake the turn's read loop when nothing is arriving on the CLI's stream.
   * A wind-down starts from a timer or a socket callback while the loop is
   * parked on `queue.next()`, and a CLI that is looping on tool calls without
   * emitting envelopes would park it there past the deadline. Assigned once
   * the queue exists, like `killClaude`.
   */
  let wakeReader: () => void = () => undefined;
  /** Whether the CLI's own `init` word has already been promoted onto the run. */
  let promotedResolved = false;
  /** Whether the driver is inside a turn's read loop, i.e. can observe a `result`. */
  let turnInFlight = false;
  /**
   * The wind-down, when one is running: the deadline the read loop races and
   * the reason it is winding down for. Non-null means the episode is over, the
   * CLI has NOT been signalled, and every tool call is being refused.
   */
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
    // The termination is on record either way. What differs is whether the CLI
    // is killed now or given a bounded chance to close its turn — see the
    // header. Only the harness's own limits wind down, and only mid-turn:
    // between turns nobody is reading the stream, and a signalled stop is the
    // operator asking for the process to go.
    if (opts?.windDown === true && turnInFlight && windDownGraceMs > 0) {
      // A real clock, deliberately: this is a bounded wait on another process,
      // not episode pacing, and the injected `now` is a test's fake clock.
      const since = Date.now();
      windDown = { deadline: since + windDownGraceMs, since, reason };
      wakeReader();
      return;
    }
    killClaude();
  };
  const pauseEpisode = (reason: PauseReason, detail: string): void => {
    if (ended !== null || pausedAs !== null) return;
    pausedAs = { reason, detail };
    trajectory.setPause(runId, reason, detail, watchdogs.elapsedMs());
    killClaude();
  };
  /** Whether an end or a pause is already on record. */
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
    if (done()) return finish(); // a recorded termination (or pause) wins over a late pause
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

  /**
   * Evaluated at every tool dispatch, which for this driver is the only place
   * control reliably passes back to the runner: one driver turn was observed
   * running 168 tool calls over 40 minutes, so a check that only happens
   * between turns is not a control at all.
   */
  const enforceLimits = (): boolean => {
    if (done()) return false;
    const verdict = watchdogs.check();
    if (verdict !== null) {
      endEpisode(verdict.reason, verdict.detail, { t: "watchdog", ...verdict }, { windDown: true });
      return false;
    }
    if (toolCallLimitReached(toolCalls, config.maxToolCallsPerEpisode)) {
      // Non-null by construction: the predicate is false for a null ceiling,
      // so reaching here means there was a number to reach.
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
      const short = name.replace(`mcp__${MCP_SERVER_NAME}__`, "");
      // `turn` is the driver turn and this driver legitimately runs one long
      // turn (the CLI owns the inner loop), so it is nearly always 1 here —
      // `call` is the monotonic tool-call index that turn-style analysis of
      // this driver should key on instead.
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
        // Same marker the fixed loop writes; see loop.ts. The trim notice has
        // no counterpart here on purpose — this driver runs no message window.
        ...(short === "reflect" ? { reflect: true } : {}),
      });
      if (short === "run_snippet") {
        if (o.sandbox.totalRestarts > restartsBefore) watchdogs.noteSandboxRestart();
        else if (result.isError !== true) watchdogs.noteSnippetSuccess();
      }
    },
  });

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
          // Serialised: one sandbox, one snippet at a time.
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
                // Refuse rather than run: the episode is over, nothing here
                // reaches the game, and a refused call is honest about why.
                //
                // The text is the mechanism, not decoration. While the driver
                // is winding down (see the header) this is the only thing that
                // tells the model to stop, and whether the closing `result`
                // arrives in seconds or never turns on it — so it is final and
                // imperative. It stays an MCP result with `isError`, never a
                // JSON-RPC error, which the CLI could read as the transport
                // failing rather than as something to tell the model.
                if (id !== undefined) {
                  // A pause is not an ending — the run resumes — so it keeps
                  // the plain sentence it always had.
                  const why =
                    pausedAs !== null && ended === null
                      ? `run paused by the harness: ${pausedAs.reason}. This call was not executed.`
                      : `run terminated by the harness: ${ended?.reason ?? "?"}. The episode is over: this call was not executed, no further tool call will be, and nothing more can be scored. Stop calling tools and end your turn now.`;
                  socket.write(
                    `${JSON.stringify({
                      jsonrpc: "2.0",
                      id,
                      result: {
                        content: [
                          {
                            type: "text",
                            text: why,
                          },
                        ],
                        isError: true,
                      },
                    })}\n`,
                  );
                }
                return;
              }
              toolCalls++;
              // A tool call IS model output. Without this the `idle` watchdog
              // would fire mid-turn on a model that is demonstrably working:
              // assistant text can be minutes apart while tool calls stream.
              watchdogs.noteModelOutput();
            }
            restartsBefore = o.sandbox.totalRestarts;
            const response = await server.handleLine(line);
            if (response !== null) socket.write(`${response}\n`);
            // A snippet can burn minutes; re-check before the next one arrives.
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

  // ---- files the CLI needs, all inside the run directory
  // Absolute: the CLI runs from a scratch temp cwd, so every path handed to it
  // must not be relative to the repo.
  const configDir = resolve(o.runDir, "claude-config");
  mkdirSync(configDir, { recursive: true });
  const mcpConfigPath = resolve(o.runDir, "claude-mcp.json");
  const bridgePath = new URL("./mcp-bridge.ts", import.meta.url).pathname;
  writeFileSync(
    mcpConfigPath,
    `${JSON.stringify(
      {
        mcpServers: {
          [MCP_SERVER_NAME]: {
            command: process.execPath,
            args: [bridgePath, String(listener.port)],
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  // A cwd outside the repo: `claude` walks parents for CLAUDE.md, and the run
  // directory lives under a checkout that has one.
  const cwd = mkdtempSync(join(tmpdir(), "wrathbench-claude-"));
  // The claude-code render: same prompt, except the sentence about older
  // conversation, which on this harness must describe the CLI's regime and not
  // the fixed loop's trim (`contextSentence`).
  const systemPrompt = buildSystemPrompt(config.objective, config.episode, harnessOf("claude-code"));
  const args = claudeArgs({
    mcpConfigPath,
    systemPrompt,
    model: config.model,
    ...(config.effort !== undefined ? { effort: config.effort } : {}),
  });
  const thinking = thinkingEnv(config.effort);
  const extra = { ...thinking, ...(o.extraEnv ?? {}) };
  const env = childEnv(o.env ?? process.env, {
    configDir,
    // The run's subscription lane (`RunConfig.subscription`): the CLI only ever
    // sees the token, under the one name it knows.
    ...(config.subscription !== undefined ? { tokenEnv: config.subscription } : {}),
    ...(Object.keys(extra).length > 0 ? { extra } : {}),
  });

  trajectory.append({
    t: "driver",
    driver: "claude-code",
    harness: harnessOf("claude-code"),
    bin: o.claudeBin ?? "claude",
    args,
    cwd,
    configDir,
    mcpConfigPath,
    mcpPort: listener.port,
    systemPromptChars: systemPrompt.length,
    ...(config.objective !== undefined ? { objective: config.objective } : {}),
  });

  /**
   * `detached` puts the CLI in its own process group, so a signal sent to
   * -pid reaches the CLI *and* everything it spawned — notably the MCP bridge
   * (`bun mcp-bridge.ts`), which the CLI starts itself and which would
   * otherwise be reparented to init and survive. Observed twice: an orphaned
   * `claude -p` outliving its runner, and one from the day before still
   * burning CPU 23 hours later.
   */
  const proc = Bun.spawn({
    cmd: [o.claudeBin ?? "claude", ...args],
    cwd,
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });

  /**
   * Last net, for the paths that never unwind: an uncaught throw, process.exit
   * from elsewhere in the runner. Registered before the first await for that
   * reason, and removed in shutdown() once the child is reaped — the closure
   * holds a pid, and a reaped pid can be recycled onto someone else's group.
   */
  const onProcessExit = (): void => {
    signalGroup(proc, "SIGKILL");
  };
  process.on("exit", onProcessExit);

  // SIGTERM first so the CLI can flush its session, SIGKILL if it will not go.
  let sigkillTimer: ReturnType<typeof setTimeout> | undefined;
  killClaude = (): void => {
    signalGroup(proc, "SIGTERM");
    sigkillTimer = setTimeout(() => {
      signalGroup(proc, "SIGKILL");
    }, o.killGraceMs ?? 5_000);
    sigkillTimer.unref?.();
  };

  // An externally killed runner must still finalise: run.ts aborts this on
  // SIGINT/SIGTERM and the episode ends as `manual`.
  // An externally stopped runner must still finalise: run.ts aborts this on
  // SIGINT/SIGTERM, and the `StopRequest` it carries says whether the run
  // pauses (the supervisor is stopping; resumable) or ends as `manual`.
  if (o.signal !== undefined) {
    const onAbort = (): void => {
      const req = stopRequestOf(o.signal);
      if (req?.kind === "pause") pauseEpisode(req.reason, req.detail);
      else endEpisode("manual", req?.detail ?? "aborted");
    };
    if (o.signal.aborted) onAbort();
    else o.signal.addEventListener("abort", onAbort, { once: true });
  }

  const queue = new MessageQueue();
  // Ignored by the turn loop's switch (`default`), and never written anywhere:
  // its only job is to unpark a reader so it re-reads the wind-down deadline.
  wakeReader = (): void => queue.push({ type: WAKE_TYPE });
  const stderrChunks: string[] = [];
  let limit: { reason: PauseReason; detail: string } | null = null;

  const stdoutTask = (async () => {
    for await (const line of readLines(proc.stdout)) {
      if (line.trim().length === 0) continue;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        trajectory.append({ t: "claude_unparseable", turn, line: line.slice(0, 500) });
        limit ??= detectLimit(line);
        continue;
      }
      if (!streamMessageSchema.safeParse(parsed).success) continue;
      queue.push(parsed);
    }
    queue.end();
  })();

  const stderrTask = (async () => {
    for await (const line of readLines(proc.stderr)) {
      if (line.trim().length === 0) continue;
      stderrChunks.push(line);
      limit ??= detectLimit(line);
      trajectory.append({ t: "claude_stderr", turn, text: line.slice(0, 500) });
    }
  })();

  const stdin = proc.stdin;
  // The shared state ticker (loop.ts), alongside the per-tool-call check: it
  // samples the world on `stateIntervalMs` so a long turn still produces state
  // rows (and so `no-xp` has data). This driver additionally *enforces* on each
  // sample — it can kill the CLI from outside the turn — which catches a
  // wall-clock watchdog during a turn that is making no tool calls at all.
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

  /**
   * The end of every path through this function, and the only place the child
   * is guaranteed to die.
   *
   * It used to send one SIGTERM and then `await proc.exited` with no bound. A
   * CLI that is slow to go, or ignores the signal while deep in its own loop,
   * parked the runner there forever; the runner was eventually killed from
   * outside and the CLI outlived it. So: SIGTERM to the group, a bounded wait,
   * then SIGKILL to the group, then a bounded wait again. Nothing here can
   * block the episode from finishing.
   */
  // A real timer, deliberately not `sleep`: the injected sleep is episode
  // pacing and tests make it instant, which would turn every SIGTERM into an
  // immediate SIGKILL and never exercise the graceful path.
  const waitMs = (ms: number): Promise<void> =>
    new Promise<void>((r) => {
      const t = setTimeout(r, ms);
      t.unref?.();
    });
  const reaped = (ms: number): Promise<boolean> =>
    Promise.race([proc.exited.then(() => true).catch(() => true), waitMs(ms).then(() => false)]);
  const shutdown = async (): Promise<void> => {
    // A turn cut short mid-message still has its newest response entry held
    // back one envelope. It goes to the trajectory, usage and all.
    flushPendingResponse();
    // A reflection window still open when the episode ends is closed on the
    // record rather than left dangling, exactly as `runLoop`'s finally does.
    // Before `stopTicker`, so the record is written while the trajectory is
    // still the live one.
    builder.reflect.close("run_end");
    for (const e of builder.reflect.drainEvents()) {
      trajectory.append({ t: "reflect_window", turn: builder.currentTurn, ...e });
    }
    await stopTicker();
    if (sigkillTimer !== undefined) clearTimeout(sigkillTimer);
    try {
      stdin.end();
    } catch {
      // already closed
    }
    const grace = o.killGraceMs ?? 5_000;
    signalGroup(proc, "SIGTERM");
    if (!(await reaped(grace))) {
      trajectory.append({ t: "harness", kind: "session_note", text: "claude ignored SIGTERM; killing its process group" });
      signalGroup(proc, "SIGKILL");
      await reaped(grace);
    }
    // Only now: the pid is reaped and could be recycled onto another group.
    process.off("exit", onProcessExit);
    await stdoutTask.catch(() => undefined);
    await stderrTask.catch(() => undefined);
    listener.stop(true);
  };

  const pendingNotices: HarnessNotice[] = [...(o.initialNotices ?? [])];
  /**
   * The CLI emits one `assistant` envelope per content block, so a text+tool_use
   * reply arrives as several envelopes sharing one message.id. Attaching usage
   * to every response entry double-counts a single API call for any consumer
   * that sums the entries (viewer/tail.ts does), so exactly one entry per id
   * carries it — and it has to be the last envelope's, because the usage grows
   * as the message streams.
   *
   * Which means the newest entry of a message is held back by one envelope: it
   * is written as soon as anything shows it was not the last (a new message id,
   * the end of the turn) and, failing that, by shutdown().
   */
  let pendingResponse:
    | { idKey: string; entry: Record<string, unknown> & { t: string }; usage: ReturnType<typeof assistantUsage> }
    | null = null;
  const flushPendingResponse = (): void => {
    if (pendingResponse === null) return;
    const { entry, usage } = pendingResponse;
    pendingResponse = null;
    trajectory.append(usage !== undefined ? { ...entry, usage } : entry);
  };

  /**
   * The wind-down's three ends, in one place: `result` (the CLI closed its
   * turn — the whole point), `grace-expired` (we waited the full grace and it
   * did not), and `exit` for everything else that stops the wait without a
   * result — the CLI's stream ending, or the read loop leaving because a
   * usage-limit line turned up on stderr. One record either way, so a reader
   * can tell a run whose figures are real from one whose CLI never came back.
   */
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
    killClaude();
  };

  /** Pulled from the queue, or the grace expiring first. */
  const GRACE_EXPIRED = Symbol("wind-down grace expired");
  const nextBefore = (deadline: number): Promise<Record<string, unknown> | null | typeof GRACE_EXPIRED> => {
    const ms = deadline - Date.now();
    if (ms <= 0) return Promise.resolve(GRACE_EXPIRED);
    return new Promise((res) => {
      // A real timer, like `waitMs` above and for the same reason: the injected
      // sleep is episode pacing and tests make it instant, which would expire
      // every grace at once and never exercise the path that gets a `result`.
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
        adapter: `claude-code:${config.model ?? "default"}`,
        messages: [{ role: "user", content: contextText }],
      });

      try {
        stdin.write(
          `${JSON.stringify({
            type: "user",
            message: { role: "user", content: [{ type: "text", text: contextText }] },
          })}\n`,
        );
        stdin.flush();
      } catch (err) {
        const detected = limit ?? detectLimit(stderrChunks.join("\n"));
        if (detected !== null) return pause(detected.reason, detected.detail);
        return terminate(
          "adapter-error",
          `claude stdin closed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // Read this turn's stream until its `result` message.
      let turnEnded = false;
      let sawOutput = false;
      // From here the driver can observe a `result`, which is what makes a
      // wind-down worth attempting rather than an immediate kill.
      turnInFlight = true;
      while (!turnEnded) {
        // Cast like `finish()` does for `ended`: it is assigned from a
        // closure the compiler does not follow, so the narrowing is a lie.
        const wd = windDown as WindDown | null;
        const msg = wd === null ? await queue.next() : await nextBefore(wd.deadline);
        if (msg === GRACE_EXPIRED) {
          finishWindDown("grace-expired");
          break;
        }
        if (msg === null) {
          // The process ended. During a wind-down that IS an ending: the CLI
          // went away rather than closing its turn.
          finishWindDown("exit");
          break; // process ended mid-turn
        }
        switch (msg["type"]) {
          case "system": {
            trajectory.append({ t: "claude_system", turn, ...msg });
            /*
             * The CLI resolves the roster's alias (`sonnet`) to a real id
             * (`claude-sonnet-5`) at launch and names it — with its own version —
             * only here. Promoted onto the run the first time it is seen, so
             * nothing downstream has to replay a trajectory to say which Claude
             * a row was. First-wins is enforced by `recordResolved`; the local
             * flag only keeps a second `system` envelope from re-reading meta.
             */
            if (!promotedResolved) {
              const resolvedModel = msg["model"];
              const cliVersion = msg["claude_code_version"];
              if (typeof resolvedModel === "string" || typeof cliVersion === "string") {
                promotedResolved = true;
                trajectory.recordResolved(runId, {
                  model: typeof resolvedModel === "string" ? resolvedModel : null,
                  cliVersion: typeof cliVersion === "string" ? cliVersion : null,
                });
              }
            }
            const servers = msg["mcp_servers"];
            if (Array.isArray(servers)) {
              const bad = (servers as { name?: string; status?: string }[]).filter(
                (s) => s.status !== "connected",
              );
              if (bad.length > 0) {
                pendingNotices.push({
                  ts: Date.now(),
                  kind: "session_note",
                  text: `MCP server not connected: ${JSON.stringify(bad)}`,
                });
              }
            }
            break;
          }
          case "assistant": {
            const blocks = assistantBlocks(msg);
            const text = blocks
              .filter((b) => b.type === "text" && typeof b.text === "string")
              .map((b) => b.text)
              .join("\n");
            const toolUses = blocks
              .filter((b) => b.type === "tool_use")
              .map((b) => ({ id: b.id ?? "", name: b.name ?? "", input: b.input }));
            if (text.length > 0 || toolUses.length > 0) {
              sawOutput = true;
              watchdogs.noteModelOutput();
              // One API reply can span several `assistant` envelopes (one per
              // content block) sharing a message.id, and the usage on each is a
              // running total for the INPUT side: on morning-opus-1 the first
              // envelope of a message reported 1 completion token where the last
              // reported 208. So exactly one entry per message id carries usage,
              // and it is the LAST envelope's. Note what that figure is and is
              // not: input is the finished count, output is the `message_start`
              // snapshot the API sends before the reply exists (1–33 tokens),
              // never what the reply ended up costing. The finished output count
              // arrives only on the turn's `result` envelope, which is where the
              // viewer reads it; a turn cut short by the wall clock never gets
              // one, and its snapshots are all anyone has.
              const messageId = (msg["message"] as { id?: unknown } | undefined)?.id;
              const idKey = typeof messageId === "string" ? messageId : undefined;
              const entry = {
                t: "response",
                turn,
                message: {
                  role: "assistant",
                  content: text.length > 0 ? text : null,
                  ...(toolUses.length > 0 ? { tool_uses: toolUses } : {}),
                },
              };
              const usage = assistantUsage(msg);
              if (idKey === undefined) {
                flushPendingResponse();
                trajectory.append(usage !== undefined ? { ...entry, usage } : entry);
              } else {
                if (pendingResponse !== null && pendingResponse.idKey !== idKey) flushPendingResponse();
                if (pendingResponse === null) {
                  pendingResponse = { idKey, entry, usage };
                } else {
                  // Same message: the earlier envelope goes out without usage,
                  // and the newest running total rides on the newest entry.
                  trajectory.append(pendingResponse.entry);
                  pendingResponse = { idKey, entry, usage: usage ?? pendingResponse.usage };
                }
              }
            }
            break;
          }
          case "result": {
            turnEnded = true;
            // the message is over: nothing more can arrive for its id
            flushPendingResponse();
            const resultText = typeof msg["result"] === "string" ? (msg["result"] as string) : "";
            trajectory.append({
              t: "claude_result",
              turn,
              subtype: msg["subtype"],
              isError: msg["is_error"] === true,
              numTurns: msg["num_turns"],
              // Which CLI session this turn belongs to. `total_cost_usd` below
              // is cumulative WITHIN a session, so a reader needs the boundary
              // to know when a figure restarts (`ClaudeCostTally` in the
              // viewer). A pause and resume opens a new one.
              sessionId: msg["session_id"],
              durationMs: msg["duration_ms"],
              // Wall clock the CLI spent inside API calls, as against
              // `duration_ms` which also covers every tool round trip the turn
              // made. The closest thing the driver reports to model time.
              durationApiMs: msg["duration_api_ms"],
              // CUMULATIVE for the session, not this turn's charge: it climbs
              // across the turns of one CLI invocation, so a run's cost is the
              // last figure per session and not the sum of the records.
              costUsd: msg["total_cost_usd"],
              // Raw for fidelity; normalised so a reader never has to know two
              // token vocabularies. This covers ONE harness turn — one CLI
              // invocation, `num_turns` API calls inside it — so a run's output
              // is the sum over these records. It is NOT the sum of the turn's
              // `response` entries: their usage is the `message_start` snapshot
              // (a token or two), never the finished count, so the viewer reads
              // output tokens from here and prompt tokens from the responses.
              usageRaw: msg["usage"],
              usage: normalizeClaudeUsage(msg["usage"]),
              text: resultText.slice(0, 2_000),
            });
            // The record this whole wind-down existed to collect. It is on
            // disk now, so stop waiting and tear down.
            finishWindDown("result");
            // Gated on is_error: a successful turn's text is model output.
            if (msg["is_error"] === true) limit ??= detectLimit(resultText);
            if (msg["is_error"] === true && limit === null) {
              pendingNotices.push({
                ts: Date.now(),
                kind: "session_note",
                text: `the previous turn ended with an error from the CLI: ${resultText.slice(0, 300)}`,
              });
            }
            break;
          }
          default:
            // user (tool results echoed back), stream_event, etc. The MCP side
            // already records tool calls and results authoritatively.
            break;
        }
        // A wind-down is `done()` by construction — the termination is already
        // recorded — and breaking here is exactly what used to throw the
        // closing `result` away. Keep reading until `finishWindDown` runs.
        if (limit !== null || (done() && (windDown as WindDown | null) === null)) break;
      }
      turnInFlight = false;
      // Nothing else can resolve a wind-down once the read loop is out.
      finishWindDown("exit");

      // A recorded termination (or pause) wins: the reason is already in the trajectory.
      if (done()) return finish();
      if (limit !== null) return pause(limit.reason, limit.detail);

      if (!turnEnded) {
        // The process died. Window exhaustion is a pause; anything else while
        // nothing has ended the episode is an adapter error.
        const detected = detectLimit(stderrChunks.join("\n"));
        if (detected !== null) return pause(detected.reason, detected.detail);
        const code = await proc.exited;
        return terminate(
          "adapter-error",
          `claude exited (code ${code}) mid-turn: ${stderrChunks.slice(-3).join(" | ").slice(0, 300)}`,
        );
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
