#!/usr/bin/env bun
/**
 * A scripted stand-in for the `pi` CLI (1.3.0) in RPC mode, used by the pi
 * driver tests. It speaks pi's RPC protocol on stdin/stdout — commands in,
 * `response` records and session events out, strict JSONL — with the event
 * shapes the pinned binary emits (captured against a stub endpoint: the
 * `message_end` usage vocabulary, `compaction_start`/`compaction_end`, an
 * error turn's `stopReason: "error"` and `errorMessage: "<status>: {…}"`), and
 * it really connects to the MCP server named in the agent directory's
 * `mcp.json`, so the loopback bridge and the runner's tool dispatch run for
 * real. No model, no network.
 *
 * `pi --version` prints $WB_FAKE_CLI_VERSION (default 1.3.0).
 *
 * Behaviour is picked with $WB_FAKE_MODE:
 *   tools       (default) per prompt: one assistant message calling
 *               run_snippet, the tool result, one assistant text message, then
 *               agent_settled.
 *   error402 / error429 / error500
 *               the turn's assistant message fails with that status.
 *   crash       exits mid-turn without settling.
 *   long-turn   one turn that keeps calling tools until a call is refused.
 *   wind-down   like long-turn, but on the refusal it stops and settles.
 *
 * $WB_FAKE_CONTEXT_WINDOW sets the model's context window `get_state`
 * reports (default 1000000); $WB_FAKE_CLAMP=<asked>:<runs> makes pi run a
 * different thinking level than `--thinking` named; $WB_FAKE_COMPACT_TURN=<n>
 * compacts after turn n's run, with its summary and its summarisation usage.
 *
 * Everything it saw is written to $WB_FAKE_RECORD as JSON after every event.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const argv = Bun.argv.slice(2);
if (argv.includes("--version")) {
  console.log(Bun.env["WB_FAKE_CLI_VERSION"] ?? "1.3.0");
  process.exit(0);
}
const mode = Bun.env["WB_FAKE_MODE"] ?? "tools";
const recordPath = Bun.env["WB_FAKE_RECORD"];
const agentDir = Bun.env["PI_CODING_AGENT_DIR"] ?? "";

function flagValue(name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}
function allValues(name: string): string[] {
  return argv.flatMap((a, i) => (a === name && argv[i + 1] !== undefined ? [argv[i + 1]!] : []));
}
function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(join(agentDir, file), "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const settings = readJson("settings.json");
const models = readJson("models.json");
const mcpConfig = readJson("mcp.json");
const provider = flagValue("--provider") ?? "deepseek";
const modelId = flagValue("--model") ?? "fake";
const providerCfg = ((models?.["providers"] as Record<string, { baseUrl?: string; apiKey?: string }> | undefined) ?? {})[provider];
const apiKeyRef = providerCfg?.apiKey ?? "";
const asked = flagValue("--thinking") ?? "medium";
const clamp = (Bun.env["WB_FAKE_CLAMP"] ?? "").split(":");
const thinkingLevel = clamp[0] === asked && clamp[1] !== undefined ? clamp[1] : asked;
const contextWindow = Number(Bun.env["WB_FAKE_CONTEXT_WINDOW"] ?? 1_000_000);
const systemPromptPath = flagValue("--system-prompt");

const record: Record<string, unknown> = {
  pid: process.pid,
  mcpPid: null as number | null,
  argv,
  cwd: process.cwd(),
  extensions: allValues("-e"),
  systemPrompt: systemPromptPath !== undefined ? readFileSync(systemPromptPath, "utf8") : null,
  settings,
  models,
  mcpConfig,
  // Whether the key named by models.json's `$NAME` is in the environment, and nothing of its value.
  keyResolves: apiKeyRef.startsWith("$") && (Bun.env[apiKeyRef.slice(1)] ?? "").length > 0,
  env: {
    home: Bun.env["HOME"] ?? null,
    agentDir,
    offline: Bun.env["PI_OFFLINE"] ?? null,
    telemetry: Bun.env["PI_TELEMETRY"] ?? null,
    skipVersionCheck: Bun.env["PI_SKIP_VERSION_CHECK"] ?? null,
  },
  envKeys: Object.keys(Bun.env).sort(),
  commands: [] as unknown[],
  prompts: [] as string[],
  mcpTools: [] as string[],
  toolResults: [] as unknown[],
};
function saveRecord(): void {
  if (recordPath !== undefined) Bun.write(recordPath, JSON.stringify(record, null, 2));
}

const out = Bun.stdout.writer();
function emit(obj: unknown): void {
  out.write(`${JSON.stringify(obj)}\n`);
  out.flush();
}

// ------------------------------------------------------------- MCP client

interface McpChild {
  call(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
}

async function startMcp(): Promise<McpChild | null> {
  const servers = (mcpConfig?.["mcpServers"] as Record<string, { command: string; args: string[] }> | undefined) ?? {};
  const first = Object.values(servers)[0];
  if (first === undefined) return null;
  const proc = Bun.spawn({ cmd: [first.command, ...first.args], stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  record["mcpPid"] = proc.pid;
  const pending = new Map<number, (v: Record<string, unknown>) => void>();
  void (async () => {
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of proc.stdout) {
      buf += decoder.decode(chunk, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.trim().length === 0) continue;
        const msg = JSON.parse(line) as { id?: number };
        if (typeof msg.id === "number") pending.get(msg.id)?.(msg as Record<string, unknown>);
      }
    }
  })();
  let nextId = 1;
  return {
    call(method, params) {
      const id = nextId++;
      const promise = new Promise<Record<string, unknown>>((resolve) => pending.set(id, resolve));
      proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      proc.stdin.flush();
      return promise;
    },
  };
}

const mcp = await startMcp();
if (mcp !== null) {
  await mcp.call("initialize", { protocolVersion: "2025-11-25", capabilities: { roots: {} }, clientInfo: { name: "pi", version: "1.3.0" } });
  const listed = (await mcp.call("tools/list")) as { result?: { tools?: { name: string }[] } };
  record["mcpTools"] = (listed.result?.tools ?? []).map((t) => t.name);
}
saveRecord();

// ------------------------------------------------------------- the stream

const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function usage(input: number, output: number, cacheRead: number): Record<string, unknown> {
  return {
    input,
    output,
    cacheRead,
    cacheWrite: 0,
    reasoning: 0,
    totalTokens: input + output + cacheRead,
    cost: { input: input * 3e-7, output: output * 1.2e-6, cacheRead: cacheRead * 6e-9, cacheWrite: 0, total: input * 3e-7 + output * 1.2e-6 + cacheRead * 6e-9 },
  };
}
function assistant(content: unknown[], u: Record<string, unknown>, stopReason: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { role: "assistant", content, api: "openai-completions", provider, model: modelId, usage: u, stopReason, timestamp: Date.now(), responseId: `c${Date.now()}`, thinkingLevel, ...extra };
}

async function callSnippet(code: string): Promise<{ isError?: boolean; content?: { text?: string }[] } | undefined> {
  if (mcp === null) return undefined;
  const res = (await mcp.call("tools/call", { name: "run_snippet", arguments: { code } })) as { result?: { isError?: boolean; content?: { text?: string }[] } };
  (record["toolResults"] as unknown[]).push(res.result);
  saveRecord();
  return res.result;
}

let turn = 0;

async function runPrompt(text: string): Promise<void> {
  turn++;
  (record["prompts"] as string[]).push(text);
  saveRecord();
  emit({ type: "agent_start" });
  emit({ type: "turn_start" });
  emit({ type: "message_end", message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() } });

  const status = /^error(\d{3})$/.exec(mode)?.[1];
  if (status !== undefined) {
    const failed = assistant([], ZERO, "error", { errorMessage: `${status}: {"message":"fake error ${status}","code":${status}}` });
    emit({ type: "message_end", message: failed });
    emit({ type: "turn_end", message: failed, toolResults: [] });
    emit({ type: "agent_end", messages: [failed], willRetry: false });
    emit({ type: "agent_settled", aborted: false });
    return;
  }
  if (mode === "crash") {
    saveRecord();
    process.exit(3);
  }
  if (mode === "long-turn" || mode === "wind-down") {
    for (let i = 0; i < 10_000; i++) {
      const call = assistant([{ type: "toolCall", id: `call-${i}`, name: "mcp__wrathbench__run_snippet", arguments: { code: `inner ${i}` } }], usage(10, 2, 100), "toolUse");
      emit({ type: "message_end", message: call });
      const res = await callSnippet(`await sdk.say("inner ${i}")`);
      const refused = res?.isError === true && (res.content?.[0]?.text ?? "").includes("episode is over");
      if (refused) {
        if (mode === "wind-down") {
          const last = assistant([{ type: "text", text: "stopping" }], usage(10, 3, 200), "stop");
          emit({ type: "message_end", message: last });
          emit({ type: "agent_end", messages: [last], willRetry: false });
          emit({ type: "agent_settled", aborted: false });
          return;
        }
        process.exit(0);
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    return;
  }

  // The default turn: one tool call, its result, one closing text.
  const call = assistant(
    [
      { type: "thinking", thinking: "plan" },
      { type: "toolCall", id: `call-${turn}`, name: "mcp__wrathbench__run_snippet", arguments: { code: `await sdk.say("turn ${turn}")` } },
    ],
    usage(200, 20, 800 * turn),
    "toolUse",
  );
  emit({ type: "message_end", message: call });
  emit({ type: "tool_execution_start", toolCallId: `call-${turn}`, toolName: "mcp__wrathbench__run_snippet", args: {} });
  const res = await callSnippet(`await sdk.say("turn ${turn}")`);
  emit({ type: "tool_execution_end", toolCallId: `call-${turn}`, toolName: "mcp__wrathbench__run_snippet", result: { content: res?.content ?? [] }, isError: res?.isError === true });
  emit({ type: "turn_end", message: call, toolResults: [] });
  emit({ type: "turn_start" });
  const done = assistant([{ type: "text", text: `turn ${turn}: acting` }], usage(100, 5, 1000 * turn), "stop");
  emit({ type: "message_end", message: done });
  emit({ type: "turn_end", message: done, toolResults: [] });
  emit({ type: "agent_end", messages: [call, done], willRetry: false });
  if (Bun.env["WB_FAKE_COMPACT_TURN"] === String(turn)) {
    emit({ type: "compaction_start", reason: "threshold" });
    emit({
      type: "compaction_end",
      reason: "threshold",
      result: {
        summary: "## Goal\nlevel up\n",
        firstKeptEntryId: "abc",
        tokensBefore: 301_234,
        estimatedTokensAfter: 21_000,
        usage: usage(300_000, 1_500, 0),
        details: { readFiles: [], modifiedFiles: [] },
      },
      aborted: false,
      willRetry: false,
    });
  }
  emit({ type: "agent_settled", aborted: false });
}

// ------------------------------------------------------------- commands

const decoder = new TextDecoder();
let buf = "";
for await (const chunk of Bun.stdin.stream()) {
  buf += decoder.decode(chunk, { stream: true });
  let idx: number;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (line.trim().length === 0) continue;
    const cmd = JSON.parse(line) as { id?: string; type: string; message?: string };
    (record["commands"] as unknown[]).push({ id: cmd.id, type: cmd.type });
    saveRecord();
    if (cmd.type === "get_state") {
      emit({
        id: cmd.id,
        type: "response",
        command: "get_state",
        success: true,
        data: {
          model: { id: modelId, provider, api: "openai-completions", baseUrl: providerCfg?.baseUrl ?? "https://api.deepseek.com", contextWindow, maxTokens: 384_000 },
          thinkingLevel,
          isStreaming: false,
          isCompacting: false,
          autoCompactionEnabled: true,
          messageCount: 0,
        },
      });
    } else if (cmd.type === "get_available_thinking_levels") {
      emit({ id: cmd.id, type: "response", command: cmd.type, success: true, data: { levels: ["off", "low", "high", "max"] } });
    } else if (cmd.type === "prompt") {
      emit({ id: cmd.id, type: "response", command: "prompt", success: true, data: { disposition: "started" } });
      await runPrompt(cmd.message ?? "");
    } else {
      emit({ id: cmd.id, type: "response", command: cmd.type, success: true });
    }
  }
}
saveRecord();
