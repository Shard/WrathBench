#!/usr/bin/env bun
/**
 * A scripted stand-in for the `claude` CLI, used by the claude-subscription
 * driver tests. It speaks the same stream-json protocol on stdin/stdout and,
 * crucially, really connects to the MCP server named in `--mcp-config` — so
 * the loopback-socket bridge and the runner's tool dispatch are exercised for
 * real. No model, no network, no subscription quota.
 *
 * Behaviour is picked with $WB_FAKE_MODE:
 *   tools       (default) one assistant text block + one run_snippet tool call
 *               per user message, then a `result`.
 *   limit       first turn ends with the CLI's usage-limit `result`.
 *   limit-exit  writes the usage-limit line to stderr and exits non-zero.
 *   silent      ends the turn with a `result` and no assistant output.
 *   stubborn    pauses the run with a usage-limit result, then ignores SIGTERM
 *               and keeps running: the shape that used to leave an orphaned CLI
 *               behind, because a pause tears down through shutdown() alone.
 *               Records its own pid and its MCP child's so the test can assert
 *               both are dead once the driver returns.
 *
 * Everything it saw (argv, selected env, the system prompt, the MCP tool list,
 * the user messages) is written to $WB_FAKE_RECORD as JSON after every event.
 */

const argv = Bun.argv.slice(2);
const mode = Bun.env["WB_FAKE_MODE"] ?? "tools";
const recordPath = Bun.env["WB_FAKE_RECORD"];

function flagValue(name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function variadic(name: string): string[] {
  const i = argv.indexOf(name);
  if (i < 0) return [];
  const out: string[] = [];
  for (let j = i + 1; j < argv.length; j++) {
    const a = argv[j]!;
    if (a.startsWith("--")) break;
    out.push(a);
  }
  return out;
}

const record: Record<string, unknown> = {
  pid: process.pid,
  mcpPid: null as number | null,
  argv,
  cwd: process.cwd(),
  systemPrompt: flagValue("--system-prompt"),
  toolsFlag: argv.includes("--tools") ? (argv[argv.indexOf("--tools") + 1] ?? null) : null,
  allowedTools: variadic("--allowed-tools"),
  strictMcpConfig: argv.includes("--strict-mcp-config"),
  verbose: argv.includes("--verbose"),
  inputFormat: flagValue("--input-format"),
  outputFormat: flagValue("--output-format"),
  model: flagValue("--model"),
  env: {
    hasAnthropicApiKey: Bun.env["ANTHROPIC_API_KEY"] !== undefined,
    hasAnthropicAuthToken: Bun.env["ANTHROPIC_AUTH_TOKEN"] !== undefined,
    hasAwsBearer: Bun.env["AWS_BEARER_TOKEN_BEDROCK"] !== undefined,
    hasOauthToken: Bun.env["CLAUDE_CODE_OAUTH_TOKEN"] !== undefined,
    configDir: Bun.env["CLAUDE_CONFIG_DIR"] ?? null,
  },
  userMessages: [] as string[],
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
  const cfgPath = flagValue("--mcp-config");
  if (cfgPath === undefined) return null;
  const cfg = (await Bun.file(cfgPath).json()) as {
    mcpServers: Record<string, { command: string; args: string[] }>;
  };
  const first = Object.values(cfg.mcpServers)[0];
  if (first === undefined) return null;
  const proc = Bun.spawn({
    cmd: [first.command, ...first.args],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });
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

emit({
  type: "system",
  subtype: "init",
  session_id: "fake-session",
  tools: (record["allowedTools"] as string[]) ?? [],
  mcp_servers: [{ name: "wrathbench", status: mcp === null ? "failed" : "connected" }],
  model: record["model"] ?? "fake",
  apiKeySource: Bun.env["CLAUDE_CODE_OAUTH_TOKEN"] !== undefined ? "oauth" : "none",
});

if (mcp !== null) {
  await mcp.call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "fake-claude", version: "0" } });
  const listed = (await mcp.call("tools/list")) as { result?: { tools?: { name: string }[] } };
  record["mcpTools"] = (listed.result?.tools ?? []).map((t) => t.name);
}
saveRecord();

// ------------------------------------------------------------- turn loop

const decoder = new TextDecoder();
let buf = "";
let turn = 0;

for await (const chunk of Bun.stdin.stream()) {
  buf += decoder.decode(chunk, { stream: true });
  let idx: number;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (line.trim().length === 0) continue;
    const msg = JSON.parse(line) as { message?: { content?: { text?: string }[] } };
    const text = (msg.message?.content ?? []).map((c) => c.text ?? "").join("");
    (record["userMessages"] as string[]).push(text);
    turn++;
    saveRecord();

    if (mode === "limit-exit" && turn === 1) {
      process.stderr.write("Claude AI usage limit reached|1780000000\n");
      saveRecord();
      process.exit(1);
    }

    if (mode === "stubborn" && turn === 1) {
      // Swallow the polite signal, then answer with the pause the driver acts
      // on. The pause path never calls killClaude: shutdown() is the only
      // thing standing between this process and an orphan.
      process.on("SIGTERM", () => {
        /* deliberately ignored */
      });
      emit({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        result: "Claude AI usage limit reached|1780000000",
        num_turns: 1,
        duration_ms: 5,
        session_id: "fake-session",
      });
      saveRecord();
      await new Promise(() => {
        /* never resolves: only a SIGKILL ends this */
      });
    }

    if (mode === "limit" && turn === 1) {
      emit({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        result: "Claude AI usage limit reached|1780000000",
        num_turns: 1,
        duration_ms: 5,
        session_id: "fake-session",
      });
      continue;
    }

    // One driver turn that never ends on its own and keeps calling tools —
    // the shape the first real subscription run took (168 tool calls, 40
    // minutes, one turn). Only the harness can stop it.
    if (mode === "long-turn") {
      emit({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "working" }] },
        session_id: "fake-session",
      });
      for (let i = 0; mcp !== null && i < 10_000; i++) {
        const res = (await mcp.call("tools/call", {
          name: "run_snippet",
          arguments: { code: `await sdk.say("inner ${i}")` },
        })) as { result?: { isError?: boolean; content?: { text?: string }[] } };
        if (res.result?.isError === true && (res.result.content?.[0]?.text ?? "").includes("run terminated")) {
          saveRecord();
          process.exit(0);
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      continue;
    }

    // model output that merely talks about in-game limits: must not pause
    if (mode === "chatty-limit") {
      const prose =
        "I reached your bag limit, and the daily quest limit resets at midnight — usage limit reached in the inn.";
      emit({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: prose }] },
        session_id: "fake-session",
      });
      emit({ type: "result", subtype: "success", is_error: false, result: prose, num_turns: 1, session_id: "fake-session" });
      continue;
    }

    if (mode === "silent") {
      emit({ type: "result", subtype: "success", is_error: false, result: "", num_turns: 1, session_id: "fake-session" });
      continue;
    }

    // One API reply split across two assistant envelopes sharing a message.id
    // and the SAME usage — the real CLI's shape for a text+tool_use turn. The
    // usage must be counted once, not once per envelope.
    if (mode === "split-usage") {
      const usage = {
        input_tokens: 12,
        output_tokens: 7,
        cache_creation_input_tokens: 3,
        cache_read_input_tokens: 100,
      };
      emit({
        type: "assistant",
        message: { id: `msg-${turn}`, role: "assistant", content: [{ type: "text", text: "thinking" }], usage },
        session_id: "fake-session",
      });
      emit({
        type: "assistant",
        message: {
          id: `msg-${turn}`,
          role: "assistant",
          content: [{ type: "tool_use", id: `tu-${turn}`, name: "mcp__wrathbench__run_snippet", input: { code: "1" } }],
          usage,
        },
        session_id: "fake-session",
      });
      emit({
        type: "result",
        subtype: "success",
        is_error: false,
        result: `turn ${turn} done`,
        num_turns: 1,
        usage,
        session_id: "fake-session",
      });
      continue;
    }

    emit({
      type: "assistant",
      // The real CLI hangs the usage of the API call that produced this message
      // off `message.usage`, in Anthropic's vocabulary: `input_tokens` counts
      // only what was neither read from nor written to the cache.
      message: {
        role: "assistant",
        content: [{ type: "text", text: `turn ${turn}: acting` }],
        usage: {
          input_tokens: 12,
          output_tokens: 7,
          cache_creation_input_tokens: 3,
          cache_read_input_tokens: 100,
        },
      },
      session_id: "fake-session",
    });

    if (mcp !== null) {
      emit({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: `tu-${turn}`,
              name: "mcp__wrathbench__run_snippet",
              input: { code: `await sdk.say("turn ${turn}")` },
            },
          ],
        },
        session_id: "fake-session",
      });
      const res = await mcp.call("tools/call", {
        name: "run_snippet",
        arguments: { code: `await sdk.say("turn ${turn}")` },
      });
      (record["toolResults"] as unknown[]).push(res["result"]);
      saveRecord();
      emit({
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: `tu-${turn}`, content: "ok" }] },
        session_id: "fake-session",
      });
    }

    emit({
      type: "result",
      subtype: "success",
      is_error: false,
      result: `turn ${turn} done`,
      num_turns: 2,
      duration_ms: 12,
      total_cost_usd: 0,
      usage: { input_tokens: 10, output_tokens: 5 },
      session_id: "fake-session",
    });
  }
}
saveRecord();
