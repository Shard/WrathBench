#!/usr/bin/env bun
/**
 * The benchmark's MCP server: `@wrathbench/mcp`'s server over the runner's
 * nine tools (`tools.ts`), and its standalone stdio mode — an operator's
 * hand-driven run, as auditable as a loop-driven one.
 *
 * Usage (stdio client, e.g. an MCP-capable agent):
 *   bun runner/src/mcp.ts [--token <session-token>] [--run-id <id>]
 *
 * Tool calls are logged to the run's trajectory. Everything except the
 * trajectory, the wiki and the episodic log is the stack's: the transport
 * (`wrath-mcp/mcp/src/server.ts`), the dispatcher and the core tools
 * (`wrath-mcp/mcp/src/tools.ts`), the sandbox. The drivers serve the same `McpServer`
 * over a loopback socket and hand their CLI the stack's bridge.
 */

import { join } from "node:path";
import {
  CLIENT_CACHE_FILE,
  ClientCacheStore,
  leaseRunSecret,
  McpServer as StackMcpServer,
  Scratchpad,
  serveStdio,
  type McpServerOptions,
  type OnToolCall,
} from "@wrathbench/mcp";
import { openWikiBundle } from "./wiki";
import { EpisodicLog } from "./episodic";
import { ClosedWindowReflectGate } from "./reflect";
import { appendPendingActionHints, callTool, coerceToolArgs, toolsFor, type ToolContext } from "./tools";
import { SandboxHost } from "./sandbox/host";
import { Trajectory } from "./trajectory";
import { newRunId, newSessionToken, loadRunConfig } from "./config";
import { partyOwnGuids } from "./party";
import { openSessionRecord } from "./session-record";
import { harnessVersion, stackCommit } from "./version";
import { SDK_VERSION } from "@wrathbench/sdk";

export { MCP_PROTOCOL_VERSION } from "@wrathbench/mcp";
export type { OnToolCall } from "@wrathbench/mcp";

/**
 * The stack's server over this run's tools: the list as `toolsFor` renders it
 * for the context's wiki options, and the runner's dispatcher bound to the
 * context. `serverInfo.name` is the runner's own.
 */
export class McpServer extends StackMcpServer {
  constructor(ctx: ToolContext, opts: Omit<McpServerOptions, "serverName"> = {}) {
    super(
      {
        list: () => toolsFor(ctx),
        // A program-loop context's own tools coerce by their own schemas (`ToolContext.program`).
        coerce: (name, raw) => coerceToolArgs(name, raw, ctx.program !== undefined ? { yield: ctx.yieldWake !== undefined } : undefined),
        call: (name, args, origin) => callTool(ctx, name, args, origin),
        appendPending: (result) => appendPendingActionHints(ctx, result),
      },
      { ...opts, serverName: "wrathbench-runner" },
    );
  }
}

/**
 * The standalone server's trajectory writer: a turn-less `tool_call` and its
 * result, appended together once the call is answered. The call carries
 * `dispatchTs`, so a reader measures the call from it and never from the
 * pair's write-time spread.
 */
export function trajectoryToolCallWriter(trajectory: Trajectory): OnToolCall {
  return (name, args, result, dispatchTs) => {
    trajectory.append({ t: "tool_call", name, args, dispatchTs });
    trajectory.append({
      t: "tool_result",
      name,
      isError: result.isError ?? false,
      text: result.text,
      ...(name === "reflect" ? { reflect: true } : {}),
    });
  };
}

async function main(): Promise<void> {
  const argv = Bun.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const runId = flag("run-id") ?? newRunId();
  // Random by default, never the run id: the token is the only thing
  // authenticating `POST /action` and `DELETE /session`.
  const token = flag("token") ?? newSessionToken();
  const config = loadRunConfig({
    runId,
    token,
    moduleUrl: process.env["WRATHBENCH_MODULE_URL"] ?? undefined,
  });
  const runDir = join(config.runsDir, runId);
  const trajectory = new Trajectory(runDir);
  const scratchpad = new Scratchpad(join(runDir, "scratchpad.md"));
  // The client cache survives a sandbox restart here as in `run.ts`.
  const clientCache = new ClientCacheStore(join(runDir, CLIENT_CACHE_FILE));
  process.on("exit", () => clientCache.flush());
  trajectory.writeMeta({ runId, harnessVersion: harnessVersion(), sdkVersion: SDK_VERSION, stackCommit: stackCommit(), startedAt: Date.now(), config });

  // The session secret for this token (wrath-mcp/module/PROTOCOL.md, "Authentication");
  // the operator's port secret stays in this process. Registered for
  // redaction as it is leased: the child holds it, and a snippet can print it.
  const lease = await leaseRunSecret({ moduleUrl: config.moduleUrl, token: config.token ?? token, account: config.account }, trajectory);
  if (lease.secret === undefined) console.error(`[wrathbench-mcp] ${lease.note}`);

  // The session record, written by the stack into the run directory (`session-record.ts`).
  const session = openSessionRecord({ runDir, runsDir: config.runsDir, ownGuids: partyOwnGuids(config.party), token: config.token ?? token, scrub: (text) => trajectory.scrub(text) });

  const sandbox = new SandboxHost({
    moduleUrl: config.moduleUrl,
    token: config.token ?? token,
    secret: lease.secret,
    account: config.account,
    scratchpad,
    snippetTimeoutMs: config.snippetTimeoutMs,
    pingGraceMs: config.sandboxPingGraceMs,
    onNotice: (n) => trajectory.append({ t: "harness", ...n }),
    clientCache,
    session,
  });

  const wiki =config.wiki ? openWikiBundle(config.wikiBundle) : undefined;

  const ctx: ToolContext = {
    sandbox,
    scratchpad,
    wiki,
    wikiCoords: config.wikiCoords,
    wikiSearch: config.wiki,
    sessionLive: () => true, // MCP mode has no loop-side session tracking
    // No context builder here, so no window that could ever close: reflect
    // answers, read_log refuses. See ClosedWindowReflectGate.
    reflect: new ClosedWindowReflectGate(),
    episodic: new EpisodicLog(join(runDir, "episodic.jsonl")),
    turn: () => 0, // MCP mode has no driver turn to stamp
    secrets: trajectory,
    record: session.writer,
    onEpisodicEntry: (entry) => trajectory.append({ t: "episodic", ...entry }),
  };
  const server = new McpServer(ctx, {
    serverVersion: harnessVersion(),
    onToolCall: trajectoryToolCallWriter(trajectory),
  });

  console.error(`[wrathbench-mcp] run ${runId} — trajectory at ${runDir}`);
  await serveStdio(server);
  await sandbox.stop();
  await session.writer.close();
  trajectory.close();
}

if (import.meta.main) {
  void main();
}
