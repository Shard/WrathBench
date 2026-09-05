#!/usr/bin/env bun
/**
 * A scripted stand-in for the `codex` CLI, used by the codex driver tests. It
 * speaks `codex exec --json`'s event JSONL on stdout, reads its prompt from
 * stdin to EOF (the `-` positional), exits at the end of the turn like the
 * real CLI, honours `exec resume <thread_id>`, and — crucially — really
 * launches the MCP server named in the `-c mcp_servers.*` overrides, so the
 * loopback bridge and the runner's tool dispatch are exercised for real. No
 * model, no network, no subscription quota.
 *
 * Behaviour is picked with $WB_FAKE_MODE:
 *   tools        (default) one agent_message + one run_snippet tool call per
 *                turn, then `turn.completed` with usage, exit 0.
 *   limit        `turn.failed` with the CLI's usage-limit message, exit 1.
 *   rate-limit   `error` with rate-limit wording, exit 1.
 *   auth         `error` with the spent-refresh-token message, exit 1.
 *   policy       `turn.failed` carrying codexErrorInfo misalignmentPolicyViolation.
 *   context      `turn.failed` carrying codexErrorInfo contextWindowExceeded.
 *   flaky        the first turn fails with a transient message, later ones work.
 *   limit-stderr the usage-limit line on stderr, exit 1, no events.
 *   silent       `turn.completed` with no items at all.
 *   chatty-limit an agent_message that merely talks about limits.
 *   stubborn     a usage-limit failure, then ignores SIGTERM and never exits.
 *   long-turn    never closes its turn; keeps calling run_snippet until refused
 *                with "run terminated", then exits.
 *   wind-down    like long-turn, but a refusal saying "episode is over" makes
 *                it stop, close the turn with `turn.completed` + usage, and exit.
 *   wind-down-deaf
 *                like long-turn, but ignores refusals forever.
 *
 * Everything it saw is written to $WB_FAKE_RECORD as JSON after every event.
 * `--version` prints a version line and exits, as the real CLI does.
 */

const argv = Bun.argv.slice(2);
const mode = Bun.env["WB_FAKE_MODE"] ?? "tools";
const recordPath = Bun.env["WB_FAKE_RECORD"];

if (argv[0] === "--version") {
  console.log("codex-cli 0.0.0-fake");
  process.exit(0);
}

function flagValue(name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** Every `-c key=value` override, as a map. */
function overrides(): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "-c") continue;
    const kv = argv[i + 1] ?? "";
    const eq = kv.indexOf("=");
    if (eq > 0) out[kv.slice(0, eq)] = kv.slice(eq + 1);
  }
  return out;
}

function disabled(): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === "--disable") out.push(argv[i + 1] ?? "");
  return out;
}

/** A TOML basic string back to its value (only the escapes the driver emits). */
function unToml(s: string): string {
  if (!s.startsWith('"')) return s;
  return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

const cfg = overrides();
const resumed = argv[0] === "exec" && argv[1] === "resume";
const threadArg = resumed ? argv[2] : undefined;
const threadId = threadArg ?? Bun.env["WB_FAKE_THREAD_ID"] ?? "fake-thread";
const instructionsPath = cfg["model_instructions_file"] !== undefined ? unToml(cfg["model_instructions_file"]) : undefined;

/** The record accumulates ACROSS processes: each turn is a new one. */
async function loadRecord(): Promise<Record<string, unknown>> {
  if (recordPath !== undefined) {
    try {
      return (await Bun.file(recordPath).json()) as Record<string, unknown>;
    } catch {
      // first process
    }
  }
  return {
    pids: [] as number[],
    mcpPids: [] as number[],
    argvs: [] as string[][],
    threadArgs: [] as (string | null)[],
    userMessages: [] as string[],
    mcpTools: [] as string[],
    toolResults: [] as unknown[],
  };
}
const record = await loadRecord();
(record["pids"] as number[]).push(process.pid);
(record["argvs"] as string[][]).push(argv);
(record["threadArgs"] as (string | null)[]).push(threadArg ?? null);
record["cwd"] = process.cwd();
record["model"] = flagValue("-m") ?? null;
record["effort"] = cfg["model_reasoning_effort"] !== undefined ? unToml(cfg["model_reasoning_effort"]) : null;
record["sandboxMode"] = cfg["sandbox_mode"] !== undefined ? unToml(cfg["sandbox_mode"]) : null;
record["approvalPolicy"] = cfg["approval_policy"] !== undefined ? unToml(cfg["approval_policy"]) : null;
record["webSearch"] = cfg["web_search"] !== undefined ? unToml(cfg["web_search"]) : null;
record["mcpApproval"] = cfg["mcp_servers.wrathbench.default_tools_approval_mode"] !== undefined ? unToml(cfg["mcp_servers.wrathbench.default_tools_approval_mode"]) : null;
record["disabled"] = disabled();
record["json"] = argv.includes("--json");
record["ignoreUserConfig"] = argv.includes("--ignore-user-config");
record["skipGitRepoCheck"] = argv.includes("--skip-git-repo-check");
record["promptPositional"] = argv[argv.length - 1];
record["instructionsPath"] = instructionsPath ?? null;
record["instructions"] = instructionsPath !== undefined ? await Bun.file(instructionsPath).text() : null;
record["env"] = {
  codexHome: Bun.env["CODEX_HOME"] ?? null,
  hasCodexApiKey: Bun.env["CODEX_API_KEY"] !== undefined,
  hasCodexAccessToken: Bun.env["CODEX_ACCESS_TOKEN"] !== undefined,
  hasCodexHome2: Bun.env["CODEX_HOME_2"] !== undefined,
  hasOpenAiApiKey: Bun.env["OPENAI_API_KEY"] !== undefined,
  hasOpenAiBaseUrl: Bun.env["OPENAI_BASE_URL"] !== undefined,
  hasAnthropicApiKey: Bun.env["ANTHROPIC_API_KEY"] !== undefined,
  hasOauthToken: Bun.env["CLAUDE_CODE_OAUTH_TOKEN"] !== undefined,
  hasAwsBearer: Bun.env["AWS_BEARER_TOKEN_BEDROCK"] !== undefined,
  hasDbPassword: Bun.env["WRATHBENCH_DB_PASSWORD"] !== undefined,
};

function saveRecord(): void {
  if (recordPath !== undefined) Bun.write(recordPath, JSON.stringify(record, null, 2));
}

const out = Bun.stdout.writer();
function emit(obj: unknown): void {
  out.write(`${JSON.stringify(obj)}\n`);
  out.flush();
}

// ------------------------------------------------------------- the prompt

// The real CLI reads stdin to EOF when the prompt is `-`. So does this.
const prompt = await new Response(Bun.stdin.stream()).text();
(record["userMessages"] as string[]).push(prompt);
saveRecord();

// ------------------------------------------------------------- MCP client

interface McpChild {
  call(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
}

async function startMcp(): Promise<McpChild | null> {
  const command = cfg["mcp_servers.wrathbench.command"];
  const args = cfg["mcp_servers.wrathbench.args"];
  if (command === undefined || args === undefined) return null;
  const argList = (JSON.parse(args) as string[]).map(String);
  const proc = Bun.spawn({
    cmd: [unToml(command), ...argList],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });
  (record["mcpPids"] as number[]).push(proc.pid);
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
  let nextId = 0;
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
  await mcp.call("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "codex-mcp-client", title: "Codex", version: "0.0.0-fake" },
  });
  const listed = (await mcp.call("tools/list")) as { result?: { tools?: { name: string }[] } };
  record["mcpTools"] = (listed.result?.tools ?? []).map((t) => t.name);
}
saveRecord();

emit({ type: "thread.started", thread_id: threadId });
emit({ type: "turn.started" });

const turn = (record["userMessages"] as string[]).length;
const USAGE = { input_tokens: 1916, cached_input_tokens: 1408, cache_write_input_tokens: 0, output_tokens: 157, reasoning_output_tokens: 128 };

/** One MCP tool call, as the real CLI reports it: an item started, then completed. */
async function callTool(i: number): Promise<{ isError?: boolean; content?: { text?: string }[] } | undefined> {
  const args = { code: `await sdk.say("inner ${i}")` };
  emit({ type: "item.started", item: { id: `item_${i}`, type: "mcp_tool_call", server: "wrathbench", tool: "run_snippet", arguments: args, result: null, error: null, status: "in_progress" } });
  const res = (await mcp!.call("tools/call", { name: "run_snippet", arguments: args })) as {
    result?: { isError?: boolean; content?: { text?: string }[] };
  };
  (record["toolResults"] as unknown[]).push(res["result"]);
  saveRecord();
  emit({ type: "item.completed", item: { id: `item_${i}`, type: "mcp_tool_call", server: "wrathbench", tool: "run_snippet", arguments: args, result: res.result ?? null, error: null, status: "completed" } });
  return res.result;
}

function fail(kind: "turn.failed" | "error", message: string, codexErrorInfo?: string): void {
  const error = codexErrorInfo !== undefined ? { message, codexErrorInfo } : { message };
  emit(kind === "error" ? { type: "error", message, ...(codexErrorInfo !== undefined ? { codexErrorInfo } : {}) } : { type: "turn.failed", error });
}

switch (mode) {
  case "limit":
    fail("turn.failed", "You've hit your usage limit. Try again at 4:00 PM.");
    saveRecord();
    process.exit(1);
  case "rate-limit":
    fail("error", "Rate limit reached for gpt-5.5. Please try again later.");
    process.exit(1);
  case "auth":
    fail("error", "Your access token could not be refreshed because your refresh token was already used. Run `codex login` again.");
    process.exit(1);
  case "policy":
    fail("turn.failed", "The model's continued work on this task was stopped by the misalignment monitor.", "misalignmentPolicyViolation");
    process.exit(1);
  case "context":
    fail("turn.failed", "The conversation exceeds the model's context window and could not be compacted.", "contextWindowExceeded");
    process.exit(1);
  case "limit-stderr":
    process.stderr.write("ERROR: usage limit reached for this account\n");
    saveRecord();
    process.exit(1);
  case "flaky":
    if (turn === 1) {
      fail("turn.failed", "stream disconnected before completion");
      process.exit(1);
    }
    break;
  case "stubborn": {
    process.on("SIGTERM", () => {
      /* deliberately ignored */
    });
    fail("turn.failed", "You've hit your usage limit.");
    saveRecord();
    await new Promise(() => {
      /* never resolves: only a SIGKILL ends this */
    });
    break;
  }
  case "silent":
    emit({ type: "turn.completed", usage: USAGE });
    saveRecord();
    process.exit(0);
  case "chatty-limit": {
    const prose =
      "I reached your bag limit, and the daily quest limit resets at midnight — usage limit reached in the inn, rate limit on the auction house.";
    emit({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: prose } });
    emit({ type: "turn.completed", usage: USAGE });
    process.exit(0);
  }
  case "long-turn":
  case "wind-down":
  case "wind-down-deaf": {
    emit({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: "working" } });
    for (let i = 1; mcp !== null && i < 10_000; i++) {
      const res = await callTool(i);
      const text = res?.content?.[0]?.text ?? "";
      if (mode === "long-turn" && res?.isError === true && text.includes("run terminated")) {
        saveRecord();
        process.exit(0);
      }
      if (mode === "wind-down" && res?.isError === true && text.includes("episode is over")) {
        emit({ type: "item.completed", item: { id: "item_final", type: "agent_message", text: "stopping: the harness ended the episode" } });
        emit({ type: "turn.completed", usage: { ...USAGE, output_tokens: 20_000 } });
        saveRecord();
        process.exit(0);
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    process.exit(0);
  }
  default:
    break;
}

// tools (and flaky after its first turn): text, one tool call, text, done
emit({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: `turn ${turn}: acting` } });
if (mcp !== null) await callTool(1);
emit({ type: "item.completed", item: { id: "item_2", type: "agent_message", text: `turn ${turn} done` } });
emit({ type: "turn.completed", usage: USAGE });
saveRecord();
process.exit(0);
