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
 *   limit        `turn.failed` with the CLI's usage-limit message, exit 1 (the
 *                turn's rollout is written first when $WB_FAKE_ROLLOUT says).
 *   rate-limit   `error` with rate-limit wording, exit 1.
 *   auth         `error` with the spent-refresh-token message, exit 1.
 *   policy       `turn.failed` with the CLI's own fallback sentence for a
 *                misalignment stop ("…misalignment policy violation.").
 *   policy-custom
 *                every turn fails with a server-worded policy stop that names
 *                neither: what exec cannot classify without typed errors.
 *   context      `turn.failed` with a blown-context-window message.
 *   retry-429    an `error` retry notice ("Reconnecting... 1/5 (… 429 …)"),
 *                then the turn completes normally.
 *   retry-exhausted
 *                retry notices, then a `turn.failed` whose message is the last
 *                notice's (exec falls back to it when the turn names none).
 *   reroute      like tools, plus the `error` item exec prints for a
 *                server-side model reroute.
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
 *   regress      like tools, but from the third turn on the thread total
 *                reads as though the second turn never happened — LOWER at
 *                the third than at the second, as after a resume that lost
 *                turns — and grows from there.
 *   new-thread   like tools, but every turn starts a thread of its own, even
 *                when resumed (`WB_FAKE_THREAD_ID` + the turn number).
 *   enospc       like tools, but stderr carries the CLI's rollout-write
 *                failure on a full disk while the turn still completes.
 *
 * $WB_FAKE_ROLLOUT makes the default turn write the thread's rollout as well
 * (`writeRollout`), compactions, the turn's `turn_context` and the
 * subscription's `rate_limits` included.
 *
 * Failures are what real exec prints: `{type, message}` or
 * `{type:"turn.failed", error:{message}}`, details appended in parentheses —
 * never the server's `codexErrorInfo`, which exec does not carry.
 *
 * `turn.completed.usage` is the THREAD's running total, as the real CLI's
 * is: each completed turn on a thread adds `PER_TURN` to it.
 *
 * Everything it saw is written to $WB_FAKE_RECORD as JSON after every event.
 * `--version` prints a version line and exits, as the real CLI does.
 */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";

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
const baseThreadId = threadArg ?? Bun.env["WB_FAKE_THREAD_ID"] ?? "fake-thread";
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
    threadTurns: {} as Record<string, number>,
  };
}
const record = await loadRecord();
(record["pids"] as number[]).push(process.pid);
(record["argvs"] as string[][]).push(argv);
(record["threadArgs"] as (string | null)[]).push(threadArg ?? null);
record["cwd"] = process.cwd();
record["model"] = flagValue("-m") ?? null;
record["effort"] = cfg["model_reasoning_effort"] !== undefined ? unToml(cfg["model_reasoning_effort"]) : null;
// Raw, not unquoted: the CLI reads it as a TOML integer, so a quoted value is a bug.
record["autoCompactLimit"] = cfg["model_auto_compact_token_limit"] ?? null;
record["sandboxMode"] =cfg["sandbox_mode"] !== undefined ? unToml(cfg["sandbox_mode"]) : null;
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
// Every variable name the CLI was given — and so what the MCP bridge it
// launches inherits. Names only, never values.
record["envKeys"] = Object.keys(Bun.env).sort();

function saveRecord(): void {
  // Synchronously: an async write still in flight could land after a later
  // one, and the next turn's process reads this file back (`threadTurns`).
  if (recordPath !== undefined) writeFileSync(recordPath, JSON.stringify(record, null, 2));
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

const turn = (record["userMessages"] as string[]).length;
const threadId = mode === "new-thread" ? `${Bun.env["WB_FAKE_THREAD_ID"] ?? "fake-thread"}-${turn}` : baseThreadId;
emit({ type: "thread.started", thread_id: threadId });
emit({ type: "turn.started" });

/** One turn's tokens. What `turn.completed` reports is the thread's total so far (`threadUsage`). */
const PER_TURN = { input_tokens: 1916, cached_input_tokens: 1408, cache_write_input_tokens: 0, output_tokens: 157, reasoning_output_tokens: 128 };
/** The thread total after this turn: every completed turn on the thread, this one included. */
function threadUsage(): typeof PER_TURN {
  const turns = record["threadTurns"] as Record<string, number>;
  const n = (turns[threadId] ?? 0) + 1;
  turns[threadId] = n;
  saveRecord();
  // `regress`: from the third turn on, the total reads as though the second never happened.
  const k = mode === "regress" && n >= 3 ? n - 2 : n;
  return {
    input_tokens: PER_TURN.input_tokens * k,
    cached_input_tokens: PER_TURN.cached_input_tokens * k,
    cache_write_input_tokens: 0,
    output_tokens: PER_TURN.output_tokens * k,
    reasoning_output_tokens: PER_TURN.reasoning_output_tokens * k,
  };
}

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

/** A failure as exec prints one (0.159.3): the message alone, any details in parentheses. */
function fail(kind: "turn.failed" | "error", message: string, details?: string): void {
  const text = details !== undefined && details.length > 0 ? `${message} (${details})` : message;
  emit(kind === "error" ? { type: "error", message: text } : { type: "turn.failed", error: { message: text } });
}

switch (mode) {
  case "limit":
    writeRollout();
    // The CLI's own words; $WB_FAKE_LIMIT_TEXT gives the "Try again at …" a test wants.
    fail("turn.failed", Bun.env["WB_FAKE_LIMIT_TEXT"] ?? "You’ve hit your usage limit. Try again later.");
    saveRecord();
    process.exit(1);
  case "rate-limit":
    fail("error", "Rate limit reached for gpt-5.5. Please try again later.");
    process.exit(1);
  case "auth":
    fail("error", "Your access token could not be refreshed because your refresh token was already used. Run `codex login` again.");
    process.exit(1);
  case "policy":
    // The CLI's own fallback sentence (codex-api responses_error.rs).
    fail("turn.failed", "This request was blocked due to a misalignment policy violation.");
    process.exit(1);
  case "policy-custom":
    // A server-worded stop: no "misalignment", no "policy violation".
    fail("turn.failed", "This task was halted by an automated safety review and cannot continue.");
    saveRecord();
    process.exit(1);
  case "context":
    fail("turn.failed", "The conversation exceeds the model's context window and could not be compacted.");
    process.exit(1);
  case "retry-429":
    fail("error", "Reconnecting... 1/5", "unexpected status 429 Too Many Requests: rate limit reached");
    break;
  case "retry-exhausted":
    fail("error", "Reconnecting... 4/5", "unexpected status 429 Too Many Requests");
    fail("error", "Reconnecting... 5/5", "unexpected status 429 Too Many Requests");
    fail("turn.failed", "Reconnecting... 5/5", "unexpected status 429 Too Many Requests");
    saveRecord();
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
    emit({ type: "turn.completed", usage: threadUsage() });
    saveRecord();
    process.exit(0);
  case "chatty-limit": {
    const prose =
      "I reached your bag limit, and the daily quest limit resets at midnight — usage limit reached in the inn, rate limit on the auction house.";
    emit({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: prose } });
    emit({ type: "turn.completed", usage: threadUsage() });
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
        emit({ type: "turn.completed", usage: { ...threadUsage(), output_tokens: 20_000 } });
        saveRecord();
        process.exit(0);
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    process.exit(0);
  }
  case "enospc":
    process.stderr.write(
      "2026-01-01T00:00:00Z ERROR codex_core::rollout: failed to record rollout items: No space left on device (os error 28)\n",
    );
    break;
  default:
    break;
}

/** A usage window as the rollout writes it: epoch SECONDS for the reset. */
interface FakeWindow {
  used_percent: number;
  window_minutes: number | null;
  resets_at: number | null;
}

/**
 * $WB_FAKE_ROLLOUT, a JSON array indexed by turn: `{ total, compact?: { pre,
 * post, message? }, model?, rateLimits? }`. Each turn appends to the thread's
 * rollout under $CODEX_HOME what the real CLI writes there — the turn's
 * `turn_context` naming `model` when the entry has one, a compaction's four
 * lines when the entry has one (0.159.3's remote shape: an empty `message`
 * and an encrypted item; `message` puts a readable summary there instead),
 * then the turn's last `token_count` — so the driver's rollout follower reads
 * it after the process exits. `rateLimits` (`{ primary, secondary }`, or
 * null as the CLI sometimes writes) rides on every `token_count`, with the
 * fields the driver must never keep (`credits`, `plan_type`) beside it.
 */
function writeRollout(): void {
  const spec = Bun.env["WB_FAKE_ROLLOUT"];
  const home = Bun.env["CODEX_HOME"];
  if (spec === undefined || home === undefined) return;
  const entry = (
    JSON.parse(spec) as {
      total: number;
      compact?: { pre: number; post: number; message?: string };
      model?: string;
      rateLimits?: { primary?: FakeWindow | null; secondary?: FakeWindow | null } | null;
    }[]
  )[turn - 1];
  if (entry === undefined) return;
  const dir = `${home}/sessions/2026/10/14`;
  mkdirSync(dir, { recursive: true });
  const rateLimits =
    entry.rateLimits === undefined
      ? {}
      : {
          rate_limits:
            entry.rateLimits === null
              ? null
              : {
                  limit_id: "codex",
                  limit_name: null,
                  primary: entry.rateLimits.primary ?? null,
                  secondary: entry.rateLimits.secondary ?? null,
                  credits: { has_credits: true, unlimited: false, balance: "fake-balance" },
                  individual_limit: null,
                  spend_control_reached: null,
                  plan_type: "fake-plan",
                  rate_limit_reached_type: null,
                },
        };
  const count = (total: number, input = total): string =>
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { last_token_usage: { input_tokens: input, output_tokens: total - input, total_tokens: total }, model_context_window: 475_000 },
        ...rateLimits,
      },
    });
  const lines: string[] = [];
  if (entry.model !== undefined) {
    lines.push(JSON.stringify({ type: "turn_context", payload: { turn_id: `turn-${turn}`, cwd: "/tmp/fake", approval_policy: "never", model: entry.model, summary: "auto" } }));
  }
  if (entry.compact !== undefined) {
    lines.push(
      count(entry.compact.pre),
      JSON.stringify({
        type: "compacted",
        payload: {
          message: entry.compact.message ?? "",
          replacement_history: [
            { type: "message", role: "user", content: [{ type: "input_text", text: `[turn ${turn}] Goal: survive and level as far as you can.` }] },
            { type: "compaction", encrypted_content: "gAAAAfake" },
          ],
          window_number: 1,
          latest_token_usage_record: { usage: { input_tokens: entry.compact.pre } },
        },
      }),
      count(entry.compact.post, 0),
      JSON.stringify({ type: "event_msg", payload: { type: "item_completed", item: { type: "ContextCompaction" }, started_at_ms: 1_000, completed_at_ms: 120_000 } }),
    );
  }
  lines.push(count(entry.total));
  appendFileSync(`${dir}/rollout-2026-10-14T00-00-00-${threadId}.jsonl`, `${lines.join("\n")}\n`);
}

// tools (and flaky after its first turn): text, one tool call, text, done
emit({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: `turn ${turn}: acting` } });
if (mode === "reroute") {
  emit({ type: "item.completed", item: { id: "item_r", type: "error", message: "model rerouted: gpt-5.5 -> gpt-5.5-mini (HighRiskCyberActivity)" } });
}
if (mcp !== null) await callTool(1);
emit({ type: "item.completed", item: { id: "item_2", type: "agent_message", text: `turn ${turn} done` } });
writeRollout();
emit({ type: "turn.completed", usage: threadUsage() });
saveRecord();
process.exit(0);
