/**
 * The claude-subscription driver — SHAKEOUT ONLY, never a scored result.
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
 *     inside the scaffold, which is exactly what ADR-0004 forbids in a result.
 *  2. Two system blocks precede our prompt: a billing header and
 *     "You are a Claude agent, built on Anthropic's Claude Agent SDK."
 *  3. Every user message is prefixed with a `<system-reminder>` block (the
 *     current date, and whatever else the CLI decides to inject).
 *  4. Skills and subagents are still registered as slash commands even though
 *     no built-in tool is exposed.
 *  5. There is no `--max-turns` in this CLI version, so the CLI's *inner* tool
 *     loop is bounded only by the watchdogs; `maxTurns` bounds driver turns.
 *
 * That list is why the run is stamped `shakeout-only (external scaffold)`.
 */

import type { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { SHAKEOUT_STAMP, type PauseReason, type RunConfig, type TerminationReason } from "./config";
import { ContextBuilder, type LoopOutcome } from "./loop";
import { McpServer } from "./mcp";
import { SYSTEM_PROMPT } from "./prompt";
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
 * The child environment, constructed rather than inherited.
 *
 * `CLAUDE_CODE_OAUTH_TOKEN` is the only credential that survives: the CLI
 * reports `apiKeySource: "ANTHROPIC_API_KEY"` whenever that variable is set,
 * so leaving it in place would spend API credits instead of the subscription.
 * `CLAUDE_CONFIG_DIR` is redirected into the run directory so no user-level
 * settings, skills, hooks, memory or `apiKeyHelper` are read.
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
 * Subscription window exhaustion, as the CLI reports it. A spent window says
 * nothing about the model, so it is a PAUSE — the run resumes when the window
 * does (see PAUSE_REASONS in config.ts).
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
  return { reason: "window-exhausted", detail };
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
  systemPrompt?: string;
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
  /** Executable to run. Tests point this at a scripted fake. */
  claudeBin?: string;
  /** Parent environment to derive the child environment from. */
  env?: Record<string, string | undefined>;
  /** Extra child env. Test hook only — never set from the CLI. */
  extraEnv?: Record<string, string>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** How often watchdogs are evaluated while a turn is in flight. */
  watchdogTickMs?: number;
}

export async function runClaudeEpisode(o: ClaudeEpisodeOptions): Promise<LoopOutcome> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const { config, trajectory, watchdogs } = o;
  const runId = config.runId;

  const terminate = (reason: TerminationReason, detail?: string): LoopOutcome => {
    trajectory.setTermination(runId, reason, detail);
    return { kind: "terminated", reason, detail };
  };
  const pause = (reason: PauseReason, detail: string): LoopOutcome => {
    trajectory.setPause(runId, reason, detail);
    return { kind: "paused", reason, detail };
  };

  const builder = new ContextBuilder({
    config,
    sandbox: o.sandbox,
    scratchpad: o.scratchpad,
    trajectory,
    watchdogs,
    ...(o.now !== undefined ? { now: o.now } : {}),
  });

  // ---- MCP over loopback TCP, dispatching into the one live sandbox
  const toolCtx: ToolContext = {
    sandbox: o.sandbox,
    scratchpad: o.scratchpad,
    wiki: o.wiki,
    sessionLive: () => builder.sessionLive,
    onEventsServed: (events) =>
      trajectory.append({ t: "events_served", via: "tool", count: events.length, events }),
  };
  let turn = 0;
  let restartsBefore = 0;
  const server = new McpServer(toolCtx, {
    onToolCall: (name, args, result) => {
      const short = name.replace(`mcp__${MCP_SERVER_NAME}__`, "");
      trajectory.append({ t: "tool_call", turn, name: short, args });
      if (short === "run_snippet") {
        trajectory.append({ t: "snippet", turn, code: (args as { code?: string }).code ?? "" });
      }
      trajectory.append({
        t: short === "run_snippet" ? "snippet_result" : "tool_result",
        turn,
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
            restartsBefore = o.sandbox.totalRestarts;
            const response = await server.handleLine(line);
            if (response !== null) socket.write(`${response}\n`);
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
  const configDir = join(o.runDir, "claude-config");
  mkdirSync(configDir, { recursive: true });
  const mcpConfigPath = join(o.runDir, "claude-mcp.json");
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
  const args = claudeArgs({ mcpConfigPath, model: config.model });
  const env = childEnv(o.env ?? process.env, {
    configDir,
    ...(o.extraEnv !== undefined ? { extra: o.extraEnv } : {}),
  });

  trajectory.append({
    t: "driver",
    driver: "claude-subscription",
    shakeout: SHAKEOUT_STAMP,
    bin: o.claudeBin ?? "claude",
    args,
    cwd,
    configDir,
    mcpConfigPath,
    mcpPort: listener.port,
    systemPromptChars: SYSTEM_PROMPT.length,
  });

  const proc = Bun.spawn({
    cmd: [o.claudeBin ?? "claude", ...args],
    cwd,
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

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
  let watchdogVerdict: { reason: TerminationReason; detail: string } | null = null;
  const ticker = setInterval(() => {
    const verdict = watchdogs.check();
    if (verdict === null || watchdogVerdict !== null) return;
    watchdogVerdict = verdict;
    // Unblock the turn that is waiting on the CLI.
    proc.kill();
  }, o.watchdogTickMs ?? 5_000);

  const shutdown = async (): Promise<void> => {
    clearInterval(ticker);
    try {
      stdin.end();
    } catch {
      // already closed
    }
    proc.kill();
    try {
      await proc.exited;
    } catch {
      // ignore
    }
    await stdoutTask.catch(() => undefined);
    await stderrTask.catch(() => undefined);
    listener.stop(true);
  };

  const pendingNotices: HarnessNotice[] = [...(o.initialNotices ?? [])];

  try {
    for (;;) {
      const verdict = watchdogVerdict ?? watchdogs.check();
      if (verdict !== null) {
        trajectory.append({ t: "watchdog", ...verdict });
        return terminate(verdict.reason, verdict.detail);
      }

      turn++;
      const contextText = await builder.build(turn, pendingNotices);
      trajectory.append({
        t: "request",
        turn,
        adapter: `claude-subscription:${config.model ?? "default"}`,
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
              trajectory.append({
                t: "response",
                turn,
                message: {
                  role: "assistant",
                  content: text.length > 0 ? text : null,
                  ...(toolUses.length > 0 ? { tool_uses: toolUses } : {}),
                },
              });
            }
            break;
          }
          case "result": {
            turnEnded = true;
            const resultText = typeof msg["result"] === "string" ? (msg["result"] as string) : "";
            trajectory.append({
              t: "claude_result",
              turn,
              subtype: msg["subtype"],
              isError: msg["is_error"] === true,
              numTurns: msg["num_turns"],
              durationMs: msg["duration_ms"],
              costUsd: msg["total_cost_usd"],
              usage: msg["usage"],
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
        if (limit !== null) break;
      }

      if (limit !== null) return pause(limit.reason, limit.detail);

      if (!turnEnded) {
        // The process died. A watchdog kill wins; otherwise it is an error,
        // unless the CLI told us the window is spent.
        const detected = detectLimit(stderrChunks.join("\n"));
        if (detected !== null) return pause(detected.reason, detected.detail);
        if (watchdogVerdict !== null) {
          trajectory.append({ t: "watchdog", ...(watchdogVerdict as object) });
          const v = watchdogVerdict as { reason: TerminationReason; detail: string };
          return terminate(v.reason, v.detail);
        }
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
