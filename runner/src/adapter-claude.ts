/**
 * The claude-code driver: the Claude Code CLI as harness and transport (ADR-0035).
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
 * fixed system prompt, the six tools, the ADR-0012 context assembly — is the
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
 *   only bill the subscription behind `CLAUDE_CODE_OAUTH_TOKEN` or refuse.
 *   It can never silently fall back to API-key credits.
 *
 * ## Measured scaffold gap (claude 2.1.238, verified against a local capture
 * proxy, no model calls)
 *
 * With `--tools ""` the request carries *only* our six MCP tools, named
 * `mcp__wrathbench__<tool>`. What remains that the fixed loop does not have:
 *
 *  1. Claude Code keeps its own conversation history across turns and applies
 *     its own compaction. ADR-0012's 24-message window is therefore NOT in
 *     force. This is the big one: an unversioned, model-side summarizer sits
 *     inside the scaffold, which is why these runs are their own harness
 *     group rather than `wrathbench` rows (ADR-0035).
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
 */

import type { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { harnessOf, type PauseReason, type RunConfig, type TerminationReason } from "./config";
import { ContextBuilder, startStateTicker, stopRequestOf, type LoopOutcome } from "./loop";
import { McpServer } from "./mcp";
import { buildSystemPrompt, SYSTEM_PROMPT } from "./prompt";
import { TOOLS, type ToolContext } from "./tools";
import type { HarnessNotice, SandboxHost } from "./sandbox/host";
import type { Scratchpad } from "./scratchpad";
import type { Trajectory } from "./trajectory";
import type { Watchdogs } from "./watchdogs";

/** MCP server name in the generated config; also the tool-name prefix. */
export const MCP_SERVER_NAME = "wrathbench";

/** The six tools as `claude` names them once they arrive over MCP. */
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
 * The child environment, constructed rather than inherited.
 *
 * `CLAUDE_CODE_OAUTH_TOKEN` is the only credential that survives: the CLI
 * reports `apiKeySource: "ANTHROPIC_API_KEY"` whenever that variable is set,
 * so leaving it in place would spend API credits instead of the subscription.
 * `CLAUDE_CONFIG_DIR` is redirected into the run directory so no user-level
 * settings, skills, hooks, memory or `apiKeyHelper` are read. `WRATHBENCH_DB_*`
 * is dropped too — see `DB_ENV_PREFIX`.
 */
export function childEnv(
  parent: Record<string, string | undefined>,
  o: { configDir: string; extra?: Record<string, string> },
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parent)) {
    if (v === undefined) continue;
    if (BILLING_ENV_PREFIXES.some((p) => k.startsWith(p))) continue;
    if (BILLING_ENV_EXACT.includes(k)) continue;
    if (k.startsWith(DB_ENV_PREFIX)) continue;
    out[k] = v;
  }
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
  /** `--effort` level, when the run declares one. */
  effort?: string | undefined;
  systemPrompt?: string;
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
    o.systemPrompt ?? SYSTEM_PROMPT,
    "--mcp-config",
    o.mcpConfigPath,
    "--strict-mcp-config",
    // "" disables the entire built-in tool set; only MCP tools remain
    "--tools",
    "",
    ...(o.model !== undefined ? ["--model", o.model] : []),
    // `--effort <low|medium|high|xhigh|max>` in 2.1.238. Only when the run
    // declares one: absent means the CLI's own default, which is not the same
    // as any named level.
    ...(o.effort !== undefined ? ["--effort", o.effort] : []),
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
   * Aborting ends the episode as `manual` — the runner's own SIGINT/SIGTERM
   * handler, so an externally killed run still finalises its termination
   * record instead of leaving the trajectory open.
   */
  signal?: AbortSignal;
}

export async function runClaudeEpisode(o: ClaudeEpisodeOptions): Promise<LoopOutcome> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const { config, trajectory, watchdogs } = o;
  const runId = config.runId;

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
  const endEpisode = (
    reason: TerminationReason,
    detail?: string,
    record?: Record<string, unknown> & { t: string },
  ): void => {
    if (ended !== null) return;
    ended = { reason, detail };
    if (record !== undefined) trajectory.append(record);
    trajectory.setTermination(runId, reason, detail);
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
      endEpisode(verdict.reason, verdict.detail, { t: "watchdog", ...verdict });
      return false;
    }
    if (toolCalls >= config.maxToolCallsPerEpisode) {
      endEpisode(
        "tool-call-limit",
        `${toolCalls} tool calls (cap ${config.maxToolCallsPerEpisode})`,
        { t: "limit", kind: "tool-call-limit", toolCalls, cap: config.maxToolCallsPerEpisode },
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
                // Refuse rather than run: the episode is over, and a refused
                // call is honest about why. The CLI is being killed anyway.
                if (id !== undefined) {
                  socket.write(
                    `${JSON.stringify({
                      jsonrpc: "2.0",
                      id,
                      result: {
                        content: [
                          {
                            type: "text",
                            text:
                              pausedAs !== null && ended === null
                                ? `run paused by the harness: ${pausedAs.reason}`
                                : `run terminated by the harness: ${ended?.reason ?? "?"}`,
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
  const systemPrompt = buildSystemPrompt(config.objective, config.episode);
  const args = claudeArgs({
    mcpConfigPath,
    systemPrompt,
    model: config.model,
    ...(config.effort !== undefined ? { effort: config.effort } : {}),
  });
  const env = childEnv(o.env ?? process.env, {
    configDir,
    ...(o.extraEnv !== undefined ? { extra: o.extraEnv } : {}),
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
      if (verdict !== null) endEpisode(verdict.reason, verdict.detail, { t: "watchdog", ...verdict });
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
    stopTicker();
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
      while (!turnEnded) {
        const msg = await queue.next();
        if (msg === null) break; // process ended mid-turn
        switch (msg["type"]) {
          case "system": {
            trajectory.append({ t: "claude_system", turn, ...msg });
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
              // running total, not a copy: on morning-opus-1 the first envelope
              // of a message reported 1 completion token where the last reported
              // 208, and counting the first summed the run to 2,504 against a
              // real 51,044. So exactly one entry per message id carries usage,
              // and it is the LAST envelope's. The `result` envelope's session
              // total only lands at end of episode, which a run cut short by the
              // wall clock never reaches.
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
              durationMs: msg["duration_ms"],
              costUsd: msg["total_cost_usd"],
              // Raw for fidelity; normalised so a reader never has to know two
              // token vocabularies. This is a session total, not a per-turn
              // figure, so nothing sums it — the response entries carry that.
              usageRaw: msg["usage"],
              usage: normalizeClaudeUsage(msg["usage"]),
              text: resultText.slice(0, 2_000),
            });
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
        if (limit !== null || done()) break;
      }

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
