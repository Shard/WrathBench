/**
 * The pi driver: the pi coding-agent CLI (earendil-works/pi, MIT) as harness
 * and transport, on a metered OpenAI-compatible endpoint.
 *
 * Runs launched here belong to the `pi` harness — a comparability group of
 * its own, like `claude-code` and `codex`, and probe-only until the operator
 * promotes it (`DriverEntry.probeOnly`; operator, 2026-10-20). pi keeps its
 * own conversation and compacts it itself, which is what makes it a harness
 * and not a `wrathbench` row.
 *
 * ## How it is wired (pi 1.3.0, the version pinned as `PI_VERSION` in
 * `infra/docker/runner.Dockerfile`)
 *
 * - **One long-lived process in RPC mode** (`pi --mode rpc`), the claude-code
 *   shape: each driver turn sends one `prompt` command carrying the harness's
 *   context message and reads the event stream until `agent_settled`, which is
 *   pi's own word for "no automatic work left" (retries, compaction, queued
 *   messages included). `--no-session` keeps the conversation in memory, so
 *   nothing persists between processes and a resume starts fresh
 *   (`resumedFresh`), as on the other CLIs.
 * - **Only our tools.** `--no-builtin-tools` and the allowlist
 *   `--tools mcp__wrathbench__*` remove read, bash, edit and write;
 *   `--no-extensions` drops every built-in extension (codemode, tool search,
 *   llama.cpp) and `-e builtin:mcp` loads back the MCP client alone. The
 *   server is declared with `exposure: "direct"` and `autoEnableCodemode:
 *   false`, so its tools are declared to the model as ordinary tools
 *   (`mcp__wrathbench__<tool>`) and pi never turns codemode on for them. The
 *   tools reach the runner's one `SandboxHost` over the loopback MCP listener
 *   and `mcp-bridge.ts`, exactly as on the other CLIs.
 * - **Our prompt, exactly.** `--system-prompt <file>` replaces pi's default
 *   prompt, and `pi-extension.ts` forces the request's system message to that
 *   text alone: without it pi appends a `<cwd>` section.
 * - **Nothing user-level.** `PI_CODING_AGENT_DIR` and `HOME` are the run's own
 *   directory (`pi/` under the run dir), holding only the settings, model and
 *   MCP files written here; `--no-skills`, `--no-prompt-templates`,
 *   `--no-themes`, `--no-context-files` and `--no-approve` turn off every
 *   other source pi reads at startup, and the cwd is an empty temp directory.
 * - **No phone-home.** `--offline` and `PI_OFFLINE=1` stop the catalogue
 *   refresh RPC mode otherwise starts (`dist/main.js`) and the version check
 *   (`dist/utils/version-check.js`); `PI_TELEMETRY=0` and
 *   `enableInstallTelemetry: false` stop install reporting and provider
 *   attribution headers (`dist/core/telemetry.js`,
 *   `dist/core/provider-attribution.js`); `cacheWarming: "off"` stops the
 *   idle cache-refresh requests a run would pay for and never see.
 * - **One credential.** The child environment is `CLI_BASE_ENV` plus the
 *   run's own key under its own name (`apiKeyEnv`, e.g. `DEEPSEEK_KEY`); the
 *   generated `models.json` points pi's built-in provider for that key
 *   (`piProviderOf`) at the run's `apiBase` and reads the key from that
 *   variable. pi's own provider variables (`DEEPSEEK_API_KEY`, …) are never
 *   set, and no other secret of the runner's reaches it.
 *
 * ## What it records
 *
 * One `response` per assistant message, with usage normalised from pi's
 * per-request figures (`normalizePiUsage`) and pi's catalogue-priced cost
 * beside it as `piCostUsd`, a cross-check only: the run is priced from its
 * tokens by the hand-held provider rows (runner/viewer/pricing.ts), which pi's
 * catalogue does not match. Each compaction is a `harness` record of kind
 * `compaction` with pi's summary, and its own summarisation call — billed, and
 * on no `message_end` — is a `response` of kind `compaction` carrying that
 * call's usage, so the run's tokens and cost include it.
 *
 * ## Failures
 *
 * A provider error ends the assistant message with `stopReason: "error"` and
 * pi's `errorMessage` (`402: {…}`), after pi's own retries (`auto_retry_*`,
 * recorded as `pi_retry`). `detectPiFailure` classifies the final one by its
 * status: 402 is `quota-exhausted`, 429 `rate-limited` (or `quota-exhausted`
 * with quota wording), 401 and 403 `auth-failed`, all pauses; an overflow pi
 * could not compact its way out of ends the run as `context-limit`. Anything
 * else is a session note, and three such turns in a row end the run as
 * `adapter-error`, as on codex.
 */

import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MCP_SERVER_NAME, toolCallLimitReached } from "./adapter-claude";
import { EXHAUSTION_HINTS } from "./adapter";
import { MessageQueue, cliBaseEnv, readLines, signalGroup } from "./adapter-shared";
import { CompactionAsk, compactionNotice, piAutoCompactLimit, piReserveTokens, piWindowCapRefusal, summaryFields, type CompactionRecord } from "./cli-compaction";
import { harnessOf, type PauseReason, type RunConfig, type TerminationReason } from "./config";
import type { EpisodicLog } from "./episodic";
import { ContextBuilder, startStateTicker, stopRequestOf, type LoopOutcome, type ObservationStallHook } from "./loop";
import { McpServer } from "./mcp";
import { buildSystemPrompt } from "./prompt";
import { PI_PROMPT_MISSING } from "./pi-extension";
import { piProviderOf } from "./providers";
import type { HarnessNotice, SandboxHost } from "./sandbox/host";
import type { Scratchpad } from "./scratchpad";
import type { ToolContext } from "./tools";
import type { Trajectory } from "./trajectory";
import type { Watchdogs } from "./watchdogs";

/** The CLI's executable name on PATH in the runner image. */
export const PI_BIN = "pi";

/** The extension that forces our prompt bytes (`pi-extension.ts`), by its repository path. */
export const PI_PROMPT_EXTENSION = new URL("./pi-extension.ts", import.meta.url).pathname;

// -------------------------------------------------------------------- effort

/**
 * The run's effort as pi's `--thinking` level. pi's levels are off, minimal,
 * low, medium, high, xhigh and max; `none` is thinking off, which pi spells
 * `off` (the same level, not a neighbour). `ultra` is not a pi level and is
 * refused by name (`piEffortRefusal`). Absent is pi's own default, which it
 * then clamps to what the model supports; the level pi actually runs is read
 * back at launch and recorded on the `driver` record either way.
 */
const PI_THINKING: Readonly<Record<string, string>> = {
  none: "off",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

export function piThinkingLevel(effort: string | undefined): string | undefined {
  return effort === undefined ? undefined : PI_THINKING[effort];
}

/** Why the run's effort cannot be given to pi at all, or null. */
export function piEffortRefusal(effort: string | undefined): string | null {
  if (effort === undefined || PI_THINKING[effort] !== undefined) return null;
  return `--driver pi refuses effort ${effort}: pi's thinking levels are ${[...new Set(Object.values(PI_THINKING))].join(", ")} (none is off) — it is refused, never mapped to a neighbour`;
}

/**
 * Why the level pi reports it runs is not the run's effort, or null. pi clamps
 * a level the model does not support to one it does (deepseek-flash's catalogue
 * maps `medium` to nothing, and pi runs `high`), silently; the run would record
 * an effort it never had, so it ends before its first turn.
 */
export function piThinkingClampRefusal(effort: string | undefined, reported: unknown, available: readonly string[] | undefined): string | null {
  const wanted = piThinkingLevel(effort);
  if (wanted === undefined || reported === wanted) return null;
  const levels = available !== undefined && available.length > 0 ? ` (this model's levels in pi: ${available.join(", ")})` : "";
  return `effort ${effort} is pi thinking level ${wanted}, which pi runs as ${String(reported)} on this model${levels} — the run would record an effort it never had; choose a level the model has`;
}

// --------------------------------------------------------------------- usage

/**
 * pi's per-request usage in the shape the harness reads. pi reports `input`
 * EXCLUDING the cache: on an OpenAI-compatible endpoint it is the prompt less
 * the cache hits (`prompt_tokens` 1000 with 800 cached arrives as input 200,
 * cacheRead 800). The harness's `prompt_tokens` is the whole prompt with the
 * cached part a subset, so it is the three summed, as on claude-code. pi
 * always reports both cache figures, so both are carried; `reasoning` is
 * carried when pi has it.
 */
export interface PiUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cached_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens?: number;
}

export function normalizePiUsage(raw: unknown): PiUsage | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const u = raw as Record<string, unknown>;
  const n = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const input = n(u["input"]);
  const output = n(u["output"]);
  const read = n(u["cacheRead"]);
  const write = n(u["cacheWrite"]);
  if (input === undefined && output === undefined) return undefined;
  const prompt = (input ?? 0) + (read ?? 0) + (write ?? 0);
  const completion = output ?? 0;
  const usage: PiUsage = {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    cached_tokens: read ?? 0,
    cache_write_tokens: write ?? 0,
  };
  const reasoning = n(u["reasoning"]);
  if (reasoning !== undefined) usage.reasoning_tokens = reasoning;
  return usage;
}

/** pi's own catalogue-priced figure for a call, kept as a cross-check: `usage.cost.total`. */
export function piCostOf(raw: unknown): number | undefined {
  const cost = (raw as { cost?: { total?: unknown } } | null | undefined)?.cost?.total;
  return typeof cost === "number" && Number.isFinite(cost) ? cost : undefined;
}

/** Whether a usage reports nothing at all: the message that opened a failed call. */
function emptyUsage(u: PiUsage | undefined): boolean {
  return u === undefined || u.total_tokens === 0;
}

// ------------------------------------------------------------------ failures

export type PiFailure =
  | { kind: "pause"; reason: PauseReason; detail: string }
  | { kind: "terminate"; reason: TerminationReason; detail: string };

/** A provider's own words for a prompt past the model's window, after pi's overflow recovery has had its go. */
const CONTEXT_PATTERNS = [/context[_ ]length/i, /context window/i, /maximum context/i, /prompt is too long/i, /too many tokens/i];

/**
 * The final error of a pi turn, classified. pi prefixes a provider's HTTP
 * error with its status (`429: {"message":…}` in 1.3.0), which is the
 * classification; the words decide only between quota and rate on a 429, as
 * the openai driver's `EXHAUSTION_HINTS` do. Only ever asked of pi's
 * `errorMessage`, never of model text.
 */
export function detectPiFailure(errorMessage: string | undefined | null): PiFailure | null {
  if (errorMessage === undefined || errorMessage === null) return null;
  const text = errorMessage.trim();
  if (text.length === 0) return null;
  const detail = text.slice(0, 600);
  const status = /^(\d{3})\b/.exec(text)?.[1];
  if (status === "402") return { kind: "pause", reason: "quota-exhausted", detail };
  if (status === "429") return { kind: "pause", reason: EXHAUSTION_HINTS.test(text) ? "quota-exhausted" : "rate-limited", detail };
  if (status === "401" || status === "403") return { kind: "pause", reason: "auth-failed", detail };
  if (CONTEXT_PATTERNS.some((p) => p.test(text))) return { kind: "terminate", reason: "context-limit", detail };
  return null;
}

/** Unclassified failed turns in a row that end the run, as on codex. */
export const PI_MAX_FAILED_TURNS = 3;

// --------------------------------------------------------------------- files

/**
 * The run's own pi directory: `PI_CODING_AGENT_DIR` and `HOME` both. Holds
 * only what `writePiConfig` puts there, plus pi's own MCP log.
 */
export function piAgentDir(runDir: string): string {
  return resolve(runDir, "pi");
}

/**
 * pi's per-request MCP timeout for our server, in seconds. pi's default is 60,
 * and one `run_snippet` can run for its whole snippet timeout behind another
 * call (the listener serialises calls: one sandbox, one snippet at a time), so
 * a timeout would hand the model an error our trajectory never saw. Generous
 * on purpose: the watchdogs, not this, bound a stuck call.
 */
export const PI_MCP_TIMEOUT_S = 1_800;

export interface PiConfigFiles {
  agentDir: string;
  settingsPath: string;
  modelsPath: string;
  mcpPath: string;
  systemPromptPath: string;
}

/**
 * The settings, model and MCP files pi reads, all under the run's own
 * directory. `reserveTokens` is the run's compaction window as pi's reserve
 * (`piReserveTokens`); absent leaves pi's own.
 */
export function writePiConfig(o: {
  runDir: string;
  piProvider: string;
  apiBase: string;
  apiKeyEnv: string;
  bridgePath: string;
  mcpPort: number;
  systemPrompt: string;
  reserveTokens?: number | undefined;
}): PiConfigFiles {
  const agentDir = piAgentDir(o.runDir);
  mkdirSync(agentDir, { recursive: true });
  const settingsPath = join(agentDir, "settings.json");
  const settings = {
    enableInstallTelemetry: false,
    defaultProjectTrust: "never",
    cacheWarming: "off",
    enableSkillCommands: false,
    quietStartup: true,
    compaction: { enabled: true, ...(o.reserveTokens !== undefined ? { reserveTokens: o.reserveTokens } : {}) },
  };
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  const modelsPath = join(agentDir, "models.json");
  // `$NAME` is pi's env interpolation: the key stays in the child's
  // environment and never lands in a file.
  const models = { providers: { [o.piProvider]: { baseUrl: o.apiBase, apiKey: `$${o.apiKeyEnv}` } } };
  writeFileSync(modelsPath, `${JSON.stringify(models, null, 2)}\n`, "utf8");
  const mcpPath = join(agentDir, "mcp.json");
  const mcp = {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        command: process.execPath,
        args: [o.bridgePath, String(o.mcpPort)],
        exposure: "direct",
        timeout: PI_MCP_TIMEOUT_S,
      },
    },
    autoEnableCodemode: false,
  };
  writeFileSync(mcpPath, `${JSON.stringify(mcp, null, 2)}\n`, "utf8");
  const systemPromptPath = join(agentDir, "system-prompt.md");
  writeFileSync(systemPromptPath, o.systemPrompt, "utf8");
  return { agentDir, settingsPath, modelsPath, mcpPath, systemPromptPath };
}

// --------------------------------------------------------------------- flags

export interface PiArgsOptions {
  piProvider: string;
  model: string;
  systemPromptPath: string;
  /** pi's thinking level (`piThinkingLevel`), when the run declares an effort. */
  thinking?: string | undefined;
  /** The prompt extension's path; defaults to the repository's `pi-extension.ts`. */
  extensionPath?: string;
}

/**
 * The exact flag set, in one place so the README and the tests can assert it.
 * Every flag is in `pi --help` for 1.3.0 (docs/cli.md).
 */
export function piArgs(o: PiArgsOptions): string[] {
  return [
    "--mode",
    "rpc",
    "--no-session",
    "--offline",
    "--provider",
    o.piProvider,
    "--model",
    o.model,
    ...(o.thinking !== undefined ? ["--thinking", o.thinking] : []),
    "--system-prompt",
    o.systemPromptPath,
    // No built-in tool, and an allowlist that names only our server's tools.
    "--no-builtin-tools",
    "--tools",
    `mcp__${MCP_SERVER_NAME}__*`,
    // No discovered or built-in extension; the MCP client, and our prompt, back in.
    "--no-extensions",
    "-e",
    "builtin:mcp",
    "-e",
    o.extensionPath ?? PI_PROMPT_EXTENSION,
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--no-approve",
  ];
}

/**
 * The child environment: an allowlist, never the runner's own. `cliBaseEnv`
 * is the plumbing; `HOME` and `PI_CODING_AGENT_DIR` are replaced by the run's
 * own directory, and `TMPDIR` by a directory inside the episode's temp cwd,
 * so what pi saves there (the whole text of a result it truncated) goes when
 * the episode does; the phone-home switches are set; and the one credential is
 * the run's key under its own name, which `models.json` reads. In tests
 * `extra` carries the fake CLI's own variables.
 */
export function piChildEnv(
  parent: Record<string, string | undefined>,
  o: { agentDir: string; apiKeyEnv: string; tmpDir?: string; extra?: Record<string, string> },
): Record<string, string> {
  const out = cliBaseEnv(parent);
  out["HOME"] = o.agentDir;
  out["PI_CODING_AGENT_DIR"] = o.agentDir;
  if (o.tmpDir !== undefined) out["TMPDIR"] = o.tmpDir;
  out["PI_OFFLINE"] = "1";
  out["PI_TELEMETRY"] = "0";
  out["PI_SKIP_VERSION_CHECK"] = "1";
  const key = parent[o.apiKeyEnv];
  if (key !== undefined && key.length > 0) out[o.apiKeyEnv] = key;
  return { ...out, ...(o.extra ?? {}) };
}

// ------------------------------------------------------------------- stream

/** Text, thinking and tool calls of a finished assistant message. */
function assistantParts(message: Record<string, unknown>): { text: string; thinkingChars: number; toolUses: { id: string; name: string; input: unknown }[] } {
  const content = Array.isArray(message["content"]) ? (message["content"] as Record<string, unknown>[]) : [];
  const text = content
    .filter((b) => b["type"] === "text" && typeof b["text"] === "string")
    .map((b) => b["text"] as string)
    .join("\n");
  const thinkingChars = content
    .filter((b) => b["type"] === "thinking" && typeof b["thinking"] === "string")
    .reduce((a, b) => a + (b["thinking"] as string).length, 0);
  const toolUses = content
    .filter((b) => b["type"] === "toolCall")
    .map((b) => ({ id: typeof b["id"] === "string" ? b["id"] : "", name: typeof b["name"] === "string" ? b["name"] : "", input: b["arguments"] }));
  return { text, thinkingChars, toolUses };
}

/** How pi 1.3.0 opens an MCP text result it middle-truncated (`dist/extensions/mcp/tools.js`). */
export const PI_TRUNCATION_PREFIX = "Warning: truncated output";

/** The text blocks of a `tool_execution_end` result, joined; undefined when it has none. */
export function piResultText(result: unknown): string | undefined {
  const content = (result as { content?: unknown } | null | undefined)?.content;
  if (!Array.isArray(content)) return undefined;
  const parts = content
    .filter((b): b is { type: string; text: string } => b !== null && typeof b === "object" && (b as { type?: unknown }).type === "text" && typeof (b as { text?: unknown }).text === "string")
    .map((b) => b.text);
  return parts.length > 0 ? parts.join("\n") : undefined;
}

/** pi's `compaction_end`, as the harness's compaction record. Null when it carries no result (aborted, failed). */
export function piCompactionRecord(turn: number, ev: Record<string, unknown>, startedAt: number | undefined): CompactionRecord | null {
  const result = ev["result"];
  if (result === null || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const now = Date.now();
  return {
    t: "harness",
    kind: "compaction",
    turn,
    trigger: typeof ev["reason"] === "string" ? ev["reason"] : null,
    preTokens: n(r["tokensBefore"]),
    postTokens: n(r["estimatedTokensAfter"]),
    durationMs: startedAt !== undefined ? now - startedAt : null,
    at: startedAt ?? now,
    ...summaryFields(typeof r["summary"] === "string" ? r["summary"] : null),
  };
}

// ------------------------------------------------------------------ episode

export interface PiEpisodeOptions {
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
  piBin?: string;
  /** Parent environment to derive the child environment from. */
  env?: Record<string, string | undefined>;
  /** Extra child env. Test hook only — never set from the CLI. */
  extraEnv?: Record<string, string>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  watchdogTickMs?: number;
  killGraceMs?: number;
  /** See `ClaudeEpisodeOptions.windDownGraceMs`; the closing event here is `agent_settled`. */
  windDownGraceMs?: number;
  /** How long pi may take to answer its startup state queries. */
  startupTimeoutMs?: number;
  signal?: AbortSignal;
  onObservationStalled?: ObservationStallHook | undefined;
}

export const DEFAULT_WIND_DOWN_GRACE_MS = 90_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 60_000;

interface WindDown {
  deadline: number;
  since: number;
  reason: TerminationReason;
}

/** What pi says about itself before the first turn. */
interface PiStartupState {
  model: Record<string, unknown> | undefined;
  thinkingLevel: unknown;
  levels: string[] | undefined;
}

/** A pi process speaking RPC on stdout: its event queue and a way to wait for one command's response. */
interface PiProcess {
  proc: ReturnType<typeof Bun.spawn> & { stdin: import("bun").FileSink; stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array> };
  queue: MessageQueue;
  stdout: Promise<void>;
  stderr: Promise<void>;
  stderrLines: string[];
}

function spawnPi(bin: string, args: string[], cwd: string, env: Record<string, string>, onStderr: (line: string) => void, onUnparseable: (line: string) => void): PiProcess {
  // Detached, so the group kill reaches the MCP bridge pi spawns (see
  // adapter-claude.ts, where an orphaned bridge was observed).
  const proc = Bun.spawn({ cmd: [bin, ...args], cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe", detached: true });
  const queue = new MessageQueue();
  const stderrLines: string[] = [];
  const stdout = (async () => {
    for await (const line of readLines(proc.stdout)) {
      if (line.trim().length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        onUnparseable(line);
        continue;
      }
      if (parsed !== null && typeof parsed === "object" && typeof (parsed as { type?: unknown }).type === "string") {
        queue.push(parsed as Record<string, unknown>);
      }
    }
    queue.end();
  })();
  const stderr = (async () => {
    for await (const line of readLines(proc.stderr)) {
      if (line.trim().length === 0) continue;
      stderrLines.push(line);
      if (stderrLines.length > 50) stderrLines.shift();
      onStderr(line);
    }
  })();
  return { proc: proc as PiProcess["proc"], queue, stdout, stderr, stderrLines };
}

/** The response to command `id`, skipping events; null when the process ends or the deadline passes first. */
async function responseTo(p: PiProcess, id: string, timeoutMs: number, onEvent?: (e: Record<string, unknown>) => void): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ms = deadline - Date.now();
    if (ms <= 0) return null;
    const next = await Promise.race([
      p.queue.next(),
      new Promise<"timeout">((r) => {
        const t = setTimeout(() => r("timeout"), ms);
        t.unref?.();
      }),
    ]);
    if (next === "timeout" || next === null) return null;
    if (next["type"] === "response" && next["id"] === id) return next;
    onEvent?.(next);
  }
}

/** Ask a running pi for its model, thinking level and the model's levels. */
async function piStartupState(p: PiProcess, timeoutMs: number): Promise<PiStartupState | { error: string }> {
  p.proc.stdin.write(`${JSON.stringify({ id: "wb-state", type: "get_state" })}\n`);
  p.proc.stdin.write(`${JSON.stringify({ id: "wb-levels", type: "get_available_thinking_levels" })}\n`);
  p.proc.stdin.flush();
  const state = await responseTo(p, "wb-state", timeoutMs);
  if (state === null || state["success"] !== true) {
    return { error: state === null ? "pi did not answer get_state" : `get_state failed: ${String(state["error"] ?? "?")}` };
  }
  const levels = await responseTo(p, "wb-levels", timeoutMs);
  const data = (state["data"] ?? {}) as Record<string, unknown>;
  const model = data["model"];
  const lv = ((levels?.["data"] ?? {}) as { levels?: unknown }).levels;
  return {
    model: model !== null && typeof model === "object" ? (model as Record<string, unknown>) : undefined,
    thinkingLevel: data["thinkingLevel"],
    levels: Array.isArray(lv) ? lv.filter((x): x is string => typeof x === "string") : undefined,
  };
}

/** `pi --version`, as the binary says it; null when it cannot. Bounded: it is one line from a local binary. */
export function piVersion(bin: string, cwd: string, env: Record<string, string>): string | null {
  try {
    const r = Bun.spawnSync({ cmd: [bin, "--version"], cwd, env, stdout: "pipe", stderr: "pipe", timeout: 10_000 });
    const out = r.stdout.toString().trim();
    return r.exitCode === 0 && /^\d+\.\d+\.\d+\S*$/.test(out) ? out : null;
  } catch {
    return null;
  }
}

async function stopPi(p: PiProcess, graceMs: number): Promise<boolean> {
  try {
    p.proc.stdin.end();
  } catch {
    // already closed
  }
  const reaped = (ms: number): Promise<boolean> =>
    Promise.race([
      p.proc.exited.then(() => true).catch(() => true),
      new Promise<boolean>((r) => {
        const t = setTimeout(() => r(false), ms);
        t.unref?.();
      }),
    ]);
  // Closing stdin is pi's orderly shutdown; the group signal follows if it lingers.
  if (await reaped(Math.min(graceMs, 2_000))) return true;
  signalGroup(p.proc, "SIGTERM");
  if (await reaped(graceMs)) return true;
  signalGroup(p.proc, "SIGKILL");
  await reaped(graceMs);
  return false;
}

export async function runPiEpisode(o: PiEpisodeOptions): Promise<LoopOutcome> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const { config, trajectory, watchdogs } = o;
  const runId = config.runId;
  const windDownGraceMs = o.windDownGraceMs ?? DEFAULT_WIND_DOWN_GRACE_MS;
  const killGraceMs = o.killGraceMs ?? 5_000;
  const bin = o.piBin ?? PI_BIN;

  // ---- the end-of-episode seam, as in adapter-claude.ts
  let ended: { reason: TerminationReason; detail?: string } | null = null;
  let pausedAs: { reason: PauseReason; detail: string } | null = null;
  let killPi: () => void = () => undefined;
  let wakeReader: () => void = () => undefined;
  let turnInFlight = false;
  let windDown: WindDown | null = null;
  const endEpisode = (reason: TerminationReason, detail?: string, record?: Record<string, unknown> & { t: string }, opts?: { windDown?: boolean }): void => {
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
    killPi();
  };
  const pauseEpisode = (reason: PauseReason, detail: string): void => {
    if (ended !== null || pausedAs !== null) return;
    pausedAs = { reason, detail };
    trajectory.setPause(runId, reason, detail, watchdogs.elapsedMs());
    killPi();
  };
  const done = (): boolean => ended !== null || pausedAs !== null;
  const finish = (): LoopOutcome => {
    const e = ended as { reason: TerminationReason; detail?: string } | null;
    const p = pausedAs as { reason: PauseReason; detail: string } | null;
    if (e === null && p !== null) return { kind: "paused", reason: p.reason, detail: p.detail };
    if (e === null) return { kind: "terminated", reason: "harness-error", detail: "ended without a reason" };
    return e.detail === undefined ? { kind: "terminated", reason: e.reason } : { kind: "terminated", reason: e.reason, detail: e.detail };
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
    onEpisodicEntry: (entry) => trajectory.append({ t: "episodic", ...entry }),
    onEventsServed: (events, folded) =>
      trajectory.append({ t: "events_served", via: "tool", count: events.length, events, ...(folded !== undefined && folded > 0 ? { folded } : {}) }),
  };
  let turn = 0;
  let restartsBefore = 0;
  let toolCalls = 0;

  /** Every tool dispatch is where control comes back to the runner (runner/README.md, "The driver contract"). */
  const enforceLimits = (): boolean => {
    if (done()) return false;
    const verdict = watchdogs.check();
    if (verdict !== null) {
      endEpisode(verdict.reason, verdict.detail, { t: "watchdog", ...verdict }, { windDown: true });
      return false;
    }
    if (toolCallLimitReached(toolCalls, config.maxToolCallsPerEpisode)) {
      const cap = config.maxToolCallsPerEpisode!;
      endEpisode("tool-call-limit", `${toolCalls} tool calls (cap ${cap})`, { t: "limit", kind: "tool-call-limit", toolCalls, cap }, { windDown: true });
      return false;
    }
    return true;
  };

  const server = new McpServer(toolCtx, {
    onToolCall: (name, args, result, dispatchTs) => {
      const short = name.replace(`mcp__${MCP_SERVER_NAME}__`, "");
      trajectory.append({ t: "tool_call", turn, call: toolCalls, name: short, args, dispatchTs });
      if (short === "run_snippet") trajectory.append({ t: "snippet", turn, call: toolCalls, code: (args as { code?: string }).code ?? "" });
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

  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket, data) {
        const conn = socket.data as { buf: string; chain: Promise<void> };
        conn.buf += new TextDecoder().decode(data);
        let idx: number;
        while ((idx = conn.buf.indexOf("\n")) >= 0) {
          const line = conn.buf.slice(0, idx);
          conn.buf = conn.buf.slice(idx + 1);
          if (line.trim().length === 0) continue;
          // Serialised: one sandbox, one snippet at a time. pi may run the
          // calls of one assistant message in parallel; they queue here.
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
                // The fixed wind-down text, the same bytes as the other CLIs'.
                if (id !== undefined) {
                  const why =
                    pausedAs !== null && ended === null
                      ? `run paused by the harness: ${pausedAs.reason}. This call was not executed.`
                      : `run terminated by the harness: ${ended?.reason ?? "?"}. The episode is over: this call was not executed, no further tool call will be, and nothing more can be scored. Stop calling tools and end your turn now.`;
                  socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: why }], isError: true } })}\n`);
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

  // ---- the endpoint, by the provider table
  const apiBase = config.apiBase ?? "";
  const provider = piProviderOf(config.apiKeyEnv);
  const bridgePath = new URL("./mcp-bridge.ts", import.meta.url).pathname;
  const systemPrompt = buildSystemPrompt(config.objective, config.episode, harnessOf("pi"), config.wiki, config.watchdogs.episodeMs);
  const cwd = mkdtempSync(join(tmpdir(), "wrathbench-pi-"));
  const thinking = piThinkingLevel(config.effort);
  let pi: PiProcess | null = null;
  let onProcessExit: (() => void) | null = null;

  const pendingNotices: HarnessNotice[] = [...(o.initialNotices ?? [])];
  const compactionAsk = new CompactionAsk();
  let turnCompactions: (number | null)[] = [];
  let lastContext: number | undefined;
  let contextWindow: number | undefined;
  let failedTurns = 0;

  const stopTicker = startStateTicker({
    builder,
    tickMs: o.watchdogTickMs,
    stopped: done,
    onSample: () => {
      const verdict = watchdogs.check();
      if (verdict !== null) endEpisode(verdict.reason, verdict.detail, { t: "watchdog", ...verdict }, { windDown: true });
    },
  });

  const shutdown = async (): Promise<void> => {
    builder.reflect.close("run_end");
    for (const e of builder.reflect.drainEvents()) trajectory.append({ t: "reflect_window", turn: builder.currentTurn, ...e });
    await stopTicker();
    if (pi !== null) {
      if (!(await stopPi(pi, killGraceMs))) trajectory.append({ t: "harness", kind: "session_note", text: "pi ignored SIGTERM; killed its process group" });
      await pi.stdout.catch(() => undefined);
      await pi.stderr.catch(() => undefined);
    }
    if (onProcessExit !== null) process.off("exit", onProcessExit);
    listener.stop(true);
    try {
      rmSync(cwd, { recursive: true, force: true });
    } catch {
      // left behind; the verdict matters more than the directory
    }
  };

  const startPi = (args: string[], env: Record<string, string>): PiProcess => {
    const p = spawnPi(
      bin,
      args,
      cwd,
      env,
      (line) => trajectory.append({ t: "pi_stderr", turn, text: line.slice(0, 500) }),
      (line) => trajectory.append({ t: "pi_unparseable", turn, line: line.slice(0, 500) }),
    );
    onProcessExit = (): void => signalGroup(p.proc, "SIGKILL");
    process.on("exit", onProcessExit);
    return p;
  };

  try {
    if ("refusal" in provider) return terminate("harness-error", provider.refusal);
    if (config.model === undefined) return terminate("harness-error", "--driver pi needs --model");

    // ---- the config, then a first look at the model pi resolved. A run with
    // a window needs the model's context window before pi starts, because the
    // reserve that sets it is read at startup: one short process asks pi for
    // it first, with the same flags and files.
    const writeConfig = (reserveTokens?: number): PiConfigFiles =>
      writePiConfig({ runDir: o.runDir, piProvider: provider.provider, apiBase, apiKeyEnv: config.apiKeyEnv, bridgePath, mcpPort: listener.port, systemPrompt, reserveTokens });
    let files = writeConfig();
    const args = piArgs({ piProvider: provider.provider, model: config.model, systemPromptPath: files.systemPromptPath, thinking });
    const tmpDir = join(cwd, "tmp");
    mkdirSync(tmpDir, { recursive: true });
    const env = piChildEnv(o.env ?? process.env, { agentDir: files.agentDir, apiKeyEnv: config.apiKeyEnv, tmpDir, ...(o.extraEnv !== undefined ? { extra: o.extraEnv } : {}) });
    const startupTimeout = o.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;

    let reserveTokens: number | undefined;
    if (config.compactWindow !== undefined) {
      const probe = startPi(args, env);
      const seen = await piStartupState(probe, startupTimeout);
      await stopPi(probe, killGraceMs);
      if (onProcessExit !== null) process.off("exit", onProcessExit);
      if ("error" in seen) return terminate("adapter-error", `pi failed to start: ${seen.error}: ${probe.stderrLines.slice(-3).join(" | ").slice(0, 300)}`);
      const cw = seen.model?.["contextWindow"];
      if (typeof cw !== "number" || !(cw > 0)) return terminate("harness-error", "pi reported no context window for the model, so the compaction window cannot be set");
      const capped = piWindowCapRefusal(config.compactWindow, cw);
      if (capped !== null) return terminate("harness-error", capped);
      reserveTokens = piReserveTokens(cw, config.compactWindow);
      files = writeConfig(reserveTokens);
    }

    const cliVersion = piVersion(bin, cwd, env);
    trajectory.append({
      t: "driver",
      driver: "pi",
      harness: harnessOf("pi"),
      bin,
      cliVersion,
      args,
      cwd,
      agentDir: files.agentDir,
      piProvider: provider.provider,
      apiBase,
      apiKeyEnv: config.apiKeyEnv,
      mcpPort: listener.port,
      systemPromptChars: systemPrompt.length,
      ...(config.objective !== undefined ? { objective: config.objective } : {}),
      // The dimension that travels in a file rather than argv: the window, and the reserve it became.
      ...(config.compactWindow !== undefined ? { compactWindow: config.compactWindow, reserveTokens } : {}),
    });

    pi = startPi(args, env);
    const live = pi;
    // SIGTERM first so pi can close its MCP server, SIGKILL if it will not go.
    let sigkillTimer: ReturnType<typeof setTimeout> | undefined;
    killPi = (): void => {
      signalGroup(live.proc, "SIGTERM");
      sigkillTimer = setTimeout(() => signalGroup(live.proc, "SIGKILL"), killGraceMs);
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
    wakeReader = (): void => live.queue.push({ type: "__wrathbench_wake" });

    const state = await piStartupState(live, startupTimeout);
    if (done()) return finish();
    if ("error" in state) return terminate("adapter-error", `pi failed to start: ${state.error}: ${live.stderrLines.slice(-3).join(" | ").slice(0, 300)}`);
    const model = state.model ?? {};
    contextWindow = typeof model["contextWindow"] === "number" ? (model["contextWindow"] as number) : undefined;
    trajectory.append({
      t: "harness",
      kind: "pi_state",
      model: typeof model["id"] === "string" ? model["id"] : null,
      provider: typeof model["provider"] === "string" ? model["provider"] : null,
      baseUrl: typeof model["baseUrl"] === "string" ? model["baseUrl"] : null,
      contextWindow: contextWindow ?? null,
      maxTokens: typeof model["maxTokens"] === "number" ? model["maxTokens"] : null,
      thinkingLevel: typeof state.thinkingLevel === "string" ? state.thinkingLevel : null,
      thinkingLevels: state.levels ?? null,
    });
    // pi names the model it will call; the endpoint names the one that
    // answered, on the first response (`responseModel` below).
    const clamped = piThinkingClampRefusal(config.effort, state.thinkingLevel, state.levels);
    if (clamped !== null) return terminate("harness-error", clamped);
    if (model["baseUrl"] !== apiBase) {
      return terminate("harness-error", `pi resolved base ${String(model["baseUrl"])} for the model, not the run's ${apiBase}`);
    }

    let promotedResolved = false;
    const GRACE_EXPIRED = Symbol("wind-down grace expired");
    const nextBefore = (deadline: number): Promise<Record<string, unknown> | null | typeof GRACE_EXPIRED> => {
      const ms = deadline - Date.now();
      if (ms <= 0) return Promise.resolve(GRACE_EXPIRED);
      return new Promise((res) => {
        const timer = setTimeout(() => res(GRACE_EXPIRED), ms);
        timer.unref?.();
        void live.queue.next().then((m) => {
          clearTimeout(timer);
          res(m);
        });
      });
    };
    const finishWindDown = (outcome: "settled" | "exit" | "grace-expired"): void => {
      const wd = windDown as WindDown | null;
      if (wd === null) return;
      windDown = null;
      trajectory.append({ t: "wind-down", turn, reason: wd.reason, outcome, graceMs: windDownGraceMs, waitedMs: Date.now() - wd.since });
      killPi();
    };

    for (;;) {
      if (done()) return finish();
      const verdict = watchdogs.check();
      if (verdict !== null) {
        endEpisode(verdict.reason, verdict.detail, { t: "watchdog", ...verdict });
        return finish();
      }

      turn++;
      const contextText = await builder.build(turn, pendingNotices);
      trajectory.append({ t: "request", turn, adapter: `pi:${config.model}`, messages: [{ role: "user", content: contextText }] });
      const promptId = `turn-${turn}`;
      try {
        live.proc.stdin.write(`${JSON.stringify({ id: promptId, type: "prompt", message: contextText })}\n`);
        live.proc.stdin.flush();
      } catch (err) {
        return terminate("adapter-error", `pi stdin closed: ${err instanceof Error ? err.message : String(err)}`);
      }

      let settled = false;
      let sawOutput = false;
      /** The last assistant message's error, cleared by any message that succeeded. */
      let lastError: string | undefined;
      const compactionStarts: number[] = [];
      turnInFlight = true;
      while (!settled) {
        const wd = windDown as WindDown | null;
        const msg = wd === null ? await live.queue.next() : await nextBefore(wd.deadline);
        if (msg === GRACE_EXPIRED) {
          finishWindDown("grace-expired");
          break;
        }
        if (msg === null) {
          finishWindDown("exit");
          break;
        }
        switch (msg["type"]) {
          case "response": {
            if (msg["id"] === promptId) {
              if (msg["success"] !== true) {
                turnInFlight = false;
                return terminate("adapter-error", `pi refused the turn's prompt: ${String(msg["error"] ?? "?")}`);
              }
              // `handled`: no run started, so no `agent_settled` will come.
              if ((msg["data"] as { disposition?: unknown } | undefined)?.disposition === "handled") settled = true;
            }
            break;
          }
          case "message_end": {
            const m = msg["message"] as Record<string, unknown> | undefined;
            if (m === undefined || m["role"] !== "assistant") break;
            const usage = normalizePiUsage(m["usage"]);
            const piCostUsd = piCostOf(m["usage"]);
            const { text, thinkingChars, toolUses } = assistantParts(m);
            const stopReason = typeof m["stopReason"] === "string" ? m["stopReason"] : null;
            if (stopReason === "error" || stopReason === "aborted") {
              if (stopReason === "error") lastError = typeof m["errorMessage"] === "string" ? m["errorMessage"] : "error";
            } else {
              lastError = undefined;
            }
            if (text.length > 0 || toolUses.length > 0) {
              sawOutput = true;
              watchdogs.noteModelOutput();
            }
            if (usage !== undefined) lastContext = usage.total_tokens;
            trajectory.append({
              t: "response",
              turn,
              message: { role: "assistant", content: text.length > 0 ? text : null, ...(toolUses.length > 0 ? { tool_uses: toolUses } : {}) },
              ...(stopReason !== null ? { stopReason } : {}),
              ...(thinkingChars > 0 ? { thinkingChars } : {}),
              ...(typeof m["responseId"] === "string" ? { responseId: m["responseId"] } : {}),
              ...(!emptyUsage(usage) ? { usage, usageRaw: m["usage"] } : {}),
              ...(piCostUsd !== undefined && piCostUsd > 0 ? { piCostUsd } : {}),
              ...(stopReason === "error" ? { error: String(m["errorMessage"] ?? "").slice(0, 600) } : {}),
            });
            // The model that answered: pi keeps the endpoint's own id as
            // `responseModel` only when it differs from the one it asked for
            // (`dist/api/openai-completions.js` in pi-ai 1.3.0), else `model`.
            if (!promotedResolved && stopReason !== "error") {
              const served = typeof m["responseModel"] === "string" ? m["responseModel"] : typeof m["model"] === "string" ? m["model"] : undefined;
              if (served !== undefined) {
                promotedResolved = true;
                trajectory.recordResolved(runId, { model: served, cliVersion });
              }
            }
            break;
          }
          case "compaction_start":
            compactionStarts.push(Date.now());
            break;
          case "compaction_end": {
            const record = piCompactionRecord(turn, msg, compactionStarts.shift());
            if (record !== null) {
              trajectory.append(record);
              turnCompactions.push(record.preTokens);
              // The summarisation call: billed, and on no `message_end`.
              const r = msg["result"] as { usage?: unknown };
              const usage = normalizePiUsage(r.usage);
              if (!emptyUsage(usage)) {
                const piCostUsd = piCostOf(r.usage);
                trajectory.append({
                  t: "response",
                  turn,
                  kind: "compaction",
                  message: { role: "assistant", content: null },
                  usage,
                  usageRaw: r.usage,
                  ...(piCostUsd !== undefined && piCostUsd > 0 ? { piCostUsd } : {}),
                });
              }
            } else {
              trajectory.append({
                t: "harness",
                kind: "compaction_failed",
                turn,
                trigger: typeof msg["reason"] === "string" ? msg["reason"] : null,
                aborted: msg["aborted"] === true,
                error: typeof msg["errorMessage"] === "string" ? msg["errorMessage"].slice(0, 600) : null,
              });
            }
            break;
          }
          case "entry_appended": {
            // Our extension found no prompt to force (`pi-extension.ts`) and
            // aborted the run before any request: it never plays on pi's own
            // default prompt, and it is never evidence.
            const entry = msg["entry"] as { customType?: unknown } | undefined;
            if (entry?.customType === PI_PROMPT_MISSING) {
              turnInFlight = false;
              return terminate(
                "harness-error",
                "pi's system prompt could not be forced to the harness's bytes (the prompt extension found no --system-prompt text), so the run was stopped before a request rather than played on pi's default prompt",
              );
            }
            break;
          }
          case "tool_execution_end": {
            // pi cuts the middle out of an MCP text result over 20 KB before
            // the model reads it (`MCP_OUTPUT_MAX_BYTES`, pi 1.3.0), and saves
            // the whole text to a temp file the model has no tool to open. The
            // `snippet_result`/`tool_result` above holds what our server
            // answered; this holds what the model was shown instead.
            const seen = piResultText(msg["result"]);
            if (seen !== undefined && seen.startsWith(PI_TRUNCATION_PREFIX)) {
              trajectory.append({
                t: "pi_tool_result_truncated",
                turn,
                toolCallId: typeof msg["toolCallId"] === "string" ? msg["toolCallId"] : null,
                name: typeof msg["toolName"] === "string" ? msg["toolName"].replace(`mcp__${MCP_SERVER_NAME}__`, "") : null,
                text: seen,
              });
            }
            break;
          }
          case "auto_retry_start":
          case "auto_retry_end":
          case "summarization_retry_scheduled":
            trajectory.append({ t: "pi_retry", turn, ...msg });
            break;
          case "agent_settled":
            settled = true;
            finishWindDown("settled");
            break;
          default:
            // message_update, tool_execution_*, turn_*: the MCP side records
            // tool calls and results authoritatively, and message_end the reply.
            break;
        }
        if (done() && (windDown as WindDown | null) === null) break;
      }
      turnInFlight = false;
      finishWindDown("exit");
      if (done()) return finish();

      if (!settled) {
        const code = await live.proc.exited;
        return terminate("adapter-error", `pi exited (code ${code}) mid-turn: ${live.stderrLines.slice(-3).join(" | ").slice(0, 300)}`);
      }
      if (lastError !== undefined) {
        const failure = detectPiFailure(lastError);
        // Verbatim, and private like codex's `codex_result.error`: the provider's words are the operator's.
        trajectory.append({ t: "pi_error", turn, error: lastError.slice(0, 600), classified: failure?.reason ?? null });
        if (failure?.kind === "pause") return pause(failure.reason, failure.detail);
        // A termination's detail is public (the run page shows it), so it names the
        // record that holds pi's words rather than repeating them.
        if (failure?.kind === "terminate") return terminate(failure.reason, `pi could not recover from the provider's error (pi_error, turn ${turn})`);
        failedTurns++;
        if (failedTurns >= PI_MAX_FAILED_TURNS) return terminate("adapter-error", `${failedTurns} failed turns in a row (pi_error, turns ${turn - failedTurns + 1}–${turn})`);
        // The model is told only that the turn failed, in codex's bytes; pi's words are the operator's (`pi_error`).
        pendingNotices.push({ ts: Date.now(), kind: "session_note", text: "the previous turn ended with an error from the CLI before it finished." });
      } else {
        failedTurns = 0;
      }
      if (!sawOutput) trajectory.append({ t: "harness", kind: "session_note", text: `turn ${turn} produced no assistant output` });
      if (config.maxTurns !== undefined && turn >= config.maxTurns) return terminate("turn-limit", `${turn} turns`);

      const ask = compactionAsk.noteTurn({
        context: lastContext,
        threshold: contextWindow !== undefined ? piAutoCompactLimit(contextWindow, config.compactWindow) : undefined,
        compactions: turnCompactions,
      });
      turnCompactions = [];
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
