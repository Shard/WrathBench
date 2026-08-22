#!/usr/bin/env bun
/**
 * MCP server over stdio: hand-rolled JSON-RPC, newline-delimited, per the MCP
 * stdio transport. Hand-rolled rather than the MCP SDK because the server side
 * of the protocol we need — initialize, tools/list, tools/call, ping — is a
 * few dozen lines, and the runner's dependency budget is "Bun built-ins first"
 * (CLAUDE.md). Revisit if we ever need resources, sampling, or notifications.
 *
 * Usage (stdio client, e.g. an MCP-capable agent):
 *   bun runner/src/mcp.ts [--token <session-token>] [--run-id <id>]
 *
 * Tool calls are logged to the run's trajectory so an MCP-driven session is as
 * auditable as a loop-driven one. Everything except the transport lives in
 * tools.ts, shared with the agent loop.
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { TOOLS, callTool, coerceToolArgs, type ToolContext } from "./tools";
import { SandboxHost } from "./sandbox/host";
import { Scratchpad } from "./scratchpad";
import { Trajectory } from "./trajectory";
import { newRunId, newSessionToken, loadRunConfig } from "./config";
import { harnessVersion } from "./version";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

export const MCP_PROTOCOL_VERSION = "2024-11-05";

export class McpServer {
  private initialized = false;

  constructor(
    private readonly ctx: ToolContext,
    private readonly opts: { serverVersion?: string; onToolCall?: (name: string, args: unknown, result: { text: string; isError?: boolean }) => void } = {},
  ) {}

  /** Handle one raw JSON-RPC line. Returns the response line, or null for notifications. */
  async handleLine(line: string): Promise<string | null> {
    let msg: JsonRpcRequest;
    try {
      msg = JSON.parse(line) as JsonRpcRequest;
    } catch {
      return JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "parse error" },
      } satisfies JsonRpcResponse);
    }
    const isNotification = msg.id === undefined;
    const respond = (result: unknown): string | null =>
      isNotification ? null : JSON.stringify({ jsonrpc: "2.0", id: msg.id ?? null, result } satisfies JsonRpcResponse);
    const fail = (code: number, message: string): string | null =>
      isNotification ? null : JSON.stringify({ jsonrpc: "2.0", id: msg.id ?? null, error: { code, message } } satisfies JsonRpcResponse);

    switch (msg.method) {
      case "initialize":
        this.initialized = true;
        return respond({
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "wrathbench-runner", version: this.opts.serverVersion ?? "0.0.0" },
        });
      case "notifications/initialized":
        return null;
      case "ping":
        return respond({});
      case "tools/list":
        return respond({
          tools: TOOLS.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        });
      case "tools/call": {
        if (!this.initialized) return fail(-32002, "server not initialized");
        const name = String(msg.params?.["name"] ?? "");
        // Leniency at the transport edge: some clients send `arguments` as a
        // JSON *string* (sometimes fenced); coerceToolArgs handles that.
        const raw = msg.params?.["arguments"] ?? {};
        const coerced = coerceToolArgs(name, raw);
        const result = coerced.ok
          ? await callTool(this.ctx, name, coerced.args)
          : { text: coerced.error, isError: true };
        const args = coerced.ok ? coerced.args : raw;
        this.opts.onToolCall?.(name, args, result);
        return respond({
          content: [{ type: "text", text: result.text }],
          isError: result.isError ?? false,
        });
      }
      default:
        return fail(-32601, `method not found: ${msg.method}`);
    }
  }
}

async function* lines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
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

async function main(): Promise<void> {
  const argv = Bun.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const runId = flag("run-id") ?? newRunId();
  // Random by default, never the run id: the token is the only thing
  // authenticating `POST /action` and `DELETE /session` (FOLLOW-UPS 19).
  const token = flag("token") ?? newSessionToken();
  const config = loadRunConfig({
    runId,
    token,
    moduleUrl: process.env["WRATHBENCH_MODULE_URL"] ?? undefined,
  });
  const runDir = join(config.runsDir, runId);
  const trajectory = new Trajectory(runDir);
  const scratchpad = new Scratchpad(join(runDir, "scratchpad.md"));
  trajectory.writeMeta({ runId, harnessVersion: harnessVersion(), startedAt: Date.now(), config });

  const sandbox = new SandboxHost({
    moduleUrl: config.moduleUrl,
    token: config.token ?? token,
    scratchpad,
    snippetTimeoutMs: config.snippetTimeoutMs,
    pingGraceMs: config.sandboxPingGraceMs,
    onNotice: (n) => trajectory.append({ t: "harness", ...n }),
  });

  const wiki = existsSync(config.wikiBundle)
    ? new Database(config.wikiBundle, { readonly: true })
    : undefined;

  const ctx: ToolContext = {
    sandbox,
    scratchpad,
    wiki,
    sessionLive: () => true, // MCP mode has no loop-side session tracking
    onEventsServed: (events, folded) =>
      trajectory.append({
        t: "events_served",
        count: events.length,
        events,
        ...(folded !== undefined && folded > 0 ? { folded } : {}),
      }),
  };
  const server = new McpServer(ctx, {
    serverVersion: harnessVersion(),
    onToolCall: (name, args, result) => {
      trajectory.append({ t: "tool_call", name, args });
      trajectory.append({ t: "tool_result", name, isError: result.isError ?? false, text: result.text });
    },
  });

  console.error(`[wrathbench-mcp] run ${runId} — trajectory at ${runDir}`);
  const out = Bun.stdout.writer();
  for await (const line of lines(Bun.stdin.stream())) {
    if (line.trim().length === 0) continue;
    const response = await server.handleLine(line);
    if (response !== null) {
      out.write(`${response}\n`);
      await out.flush();
    }
  }
  await sandbox.stop();
  trajectory.close();
}

if (import.meta.main) {
  void main();
}
