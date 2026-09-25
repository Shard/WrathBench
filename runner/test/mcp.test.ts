/**
 * MCP tool dispatch, driven in-process with fixture JSON-RPC lines. The
 * sandbox is faked; the point is the protocol and the tool wiring, not eval.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MCP_RESULT_MAX_CHARS, McpServer, capMcpResult, trajectoryToolCallWriter } from "../src/mcp";
import { EpisodicLog } from "../src/episodic";
import { ReflectGate } from "../src/reflect";
import { Workspace } from "../src/workspace";
import { Trajectory, readTrajectory } from "../src/trajectory";
import type { SandboxHost, SnippetResult } from "../src/sandbox/host";
import type { ToolContext } from "../src/tools";

function fakeSandbox(): SandboxHost {
  const fake = {
    evalSnippet: (code: string): Promise<SnippetResult> =>
      Promise.resolve({ ok: true, value: `evaluated:${code}`, logs: [], durationMs: 1 }),
    // A three-event buffer, sliced like the real one: recent_events over-fetches
    // to fold ambient movement, so `limit` is no longer the count it returns.
    recentEvents: (limit: number) =>
      Promise.resolve(
        Array.from({ length: 3 }, (_, i) => ({
          seq: i,
          ts: i,
          opcode: "SMSG_MESSAGECHAT",
          data: { message: `m${i}` },
        })).slice(-limit),
      ),
    stateSnapshot: () =>
      Promise.resolve({ self: { name: "Benchy", guid: "7" }, lastSeq: 2, eventCount: 3 }),
    totalRestarts: 0,
    consecutiveRestarts: 0,
    drainNotices: () => [],
  };
  return fake as unknown as SandboxHost;
}

function makeCtx(sandbox: SandboxHost = fakeSandbox()): { ctx: ToolContext; workspace: Workspace } {
  const dir = mkdtempSync(join(tmpdir(), "wrathbench-mcp-"));
  const workspace = new Workspace(join(dir, "workspace"));
  const ctx: ToolContext = {
    sandbox,
    workspace,
    wiki: undefined,
    sessionLive: () => true,
    reflect: new ReflectGate(),
    episodic: new EpisodicLog(join(dir, "episodic.jsonl")),
    turn: () => 1,
  };
  return { ctx, workspace };
}

function makeServer(sandbox?: SandboxHost): { server: McpServer; workspace: Workspace } {
  const { ctx, workspace } = makeCtx(sandbox);
  return { server: new McpServer(ctx, { serverVersion: "test" }), workspace };
}

/** A sandbox whose snippet takes `ms` and notes the moment it started. */
function slowSandbox(ms: number): { sandbox: SandboxHost; startedAt: () => number } {
  let started = 0;
  const sandbox = {
    ...(fakeSandbox() as unknown as Record<string, unknown>),
    evalSnippet: async (code: string): Promise<SnippetResult> => {
      started = Date.now();
      await Bun.sleep(ms);
      return { ok: true, value: `evaluated:${code}`, logs: [], durationMs: ms };
    },
  } as unknown as SandboxHost;
  return { sandbox, startedAt: () => started };
}

async function call(server: McpServer, msg: unknown): Promise<Record<string, unknown> | null> {
  const line = await server.handleLine(JSON.stringify(msg));
  return line === null ? null : (JSON.parse(line) as Record<string, unknown>);
}

async function initialized(server: McpServer): Promise<void> {
  await call(server, { jsonrpc: "2.0", id: 0, method: "initialize", params: {} });
  await call(server, { jsonrpc: "2.0", method: "notifications/initialized" });
}

describe("McpServer", () => {
  test("initialize handshake", async () => {
    const { server } = makeServer();
    const res = await call(server, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const result = res?.["result"] as Record<string, unknown>;
    expect(result["protocolVersion"]).toBe("2024-11-05");
    expect((result["serverInfo"] as Record<string, unknown>)["name"]).toBe("wrathbench-runner");
  });

  test("notifications produce no response", async () => {
    const { server } = makeServer();
    expect(await call(server, { jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
  });

  test("tools/list exposes exactly the eleven tools", async () => {
    const { server } = makeServer();
    await initialized(server);
    const res = await call(server, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    const listed = (res?.["result"] as { tools: { name: string; description: string }[] }).tools;
    expect(listed.map((t) => t.name)).toEqual([
      "run_snippet",
      "recent_events",
      "state_summary",
      "search_reference",
      "read_file",
      "write_file",
      "edit_file",
      "delete_file",
      "reflect",
      "log_status",
      "read_log",
    ]);
    // Every description stays under 2,000 characters.
    for (const t of listed) expect(t.description.length).toBeLessThan(2_000);
  });

  test("a result longer than the MCP cap is cut, says so, and the trajectory keeps what was served", async () => {
    const long = "L".repeat(MCP_RESULT_MAX_CHARS * 2);
    const sandbox = {
      ...(fakeSandbox() as unknown as Record<string, unknown>),
      evalSnippet: (): Promise<SnippetResult> => Promise.resolve({ ok: true, value: long, logs: [], durationMs: 1 }),
    } as unknown as SandboxHost;
    const { ctx } = makeCtx(sandbox);
    const dir = mkdtempSync(join(tmpdir(), "wrathbench-mcp-cap-"));
    const trajectory = new Trajectory(dir);
    const server = new McpServer(ctx, { serverVersion: "test", onToolCall: trajectoryToolCallWriter(trajectory) });
    await initialized(server);
    const res = await call(server, {
      jsonrpc: "2.0",
      id: 30,
      method: "tools/call",
      params: { name: "run_snippet", arguments: { code: "x" } },
    });
    const text = (res?.["result"] as { content: { text: string }[] }).content[0]!.text;
    expect(text.length).toBe(MCP_RESULT_MAX_CHARS);
    expect(text).toContain(`[result truncated by the harness: ${long.length + "ok (1ms)\n=> ".length} chars`);
    const rec = readTrajectory(dir).find((r) => r.t === "tool_result");
    expect(rec?.["text"]).toBe(text);
    expect(rec?.["truncatedFrom"]).toBe(long.length + "ok (1ms)\n=> ".length);
    trajectory.close();
    // Under the cap, nothing changes.
    expect(capMcpResult("short")).toEqual({ text: "short" });
  });

  test("tools/call run_snippet dispatches to the sandbox", async () => {
    const { server } = makeServer();
    await initialized(server);
    const res = await call(server, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "run_snippet", arguments: { code: "1+1" } },
    });
    const result = res?.["result"] as { content: { text: string }[]; isError: boolean };
    expect(result.isError).toBe(false);
    expect(result.content[0]!.text).toContain("evaluated:1+1");
  });

  test("tools/call state_summary and recent_events render fixed formats", async () => {
    const { server } = makeServer();
    await initialized(server);
    const state = await call(server, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "state_summary", arguments: {} },
    });
    expect((state?.["result"] as { content: { text: string }[] }).content[0]!.text).toContain(
      "character: Benchy (guid 7)",
    );
    const events = await call(server, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "recent_events", arguments: { limit: 2 } },
    });
    // limit 2 now means two *signal* events, taken from the newest end.
    const eventText = (events?.["result"] as { content: { text: string }[] }).content[0]!.text;
    expect(eventText.split("\n")).toHaveLength(2);
    expect(eventText).toContain("#1 SMSG_MESSAGECHAT");
    expect(eventText).toContain("#2 SMSG_MESSAGECHAT");
  });

  test("the file tools reach the workspace, and the scratchpad tools are gone", async () => {
    const { server, workspace } = makeServer();
    await initialized(server);
    const tool = async (id: number, name: string, args: unknown): Promise<{ text: string; isError: boolean }> => {
      const res = await call(server, { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
      const r = res?.["result"] as { content: { text: string }[]; isError: boolean };
      return { text: r.content[0]!.text, isError: r.isError };
    };
    expect((await tool(6, "write_file", { path: "notes.md", content: "# remembered" })).text).toBe(
      "wrote notes.md\n[0% — 12/32000 chars]",
    );
    expect(workspace.readNotes()).toBe("# remembered");
    expect(await tool(7, "read_file", { path: "notes.md" })).toEqual({ text: "# remembered", isError: false });
    expect((await tool(8, "edit_file", { path: "notes.md", old_string: "remembered", new_string: "kept" })).text).toContain(
      "edited notes.md (1 replacement)",
    );
    expect((await tool(9, "write_file", { path: "lib/a.ts", content: "export {};\n" })).text).toContain("created lib/a.ts");
    expect(await tool(10, "delete_file", { path: "lib/a.ts" })).toEqual({ text: "deleted lib/a.ts (11 bytes)", isError: false });
    // Refusals are isError, named for the tool.
    const miss = await tool(11, "edit_file", { path: "notes.md", old_string: "nope", new_string: "x" });
    expect(miss.isError).toBe(true);
    expect(miss.text).toStartWith("edit_file: old_string was not found in notes.md");
    const escape = await tool(12, "read_file", { path: "../meta.json" });
    expect(escape).toEqual({ text: 'read_file: path "../meta.json" contains ..; paths stay inside the workspace', isError: true });
    for (const gone of ["write_scratchpad", "edit_scratchpad", "read_scratchpad"]) {
      const r = await tool(13, gone, {});
      expect(r.isError).toBe(true);
      expect(r.text).toContain(`unknown tool: ${gone}`);
    }
  });

  test("the file tools take their arguments as declared: no aliases, no coercion", async () => {
    const { server } = makeServer();
    await initialized(server);
    const res = await call(server, {
      jsonrpc: "2.0",
      id: 14,
      method: "tools/call",
      params: { name: "edit_file", arguments: { file_path: "notes.md", old_string: "a", new_string: "b" } },
    });
    const text = (res?.["result"] as { content: { text: string }[] }).content[0]!.text;
    expect(text).toContain('unknown key(s) "file_path" — valid keys for edit_file: path, old_string, new_string, replace_all');
    const coerced = await call(server, {
      jsonrpc: "2.0",
      id: 15,
      method: "tools/call",
      params: { name: "edit_file", arguments: { path: "notes.md", old_string: "a", new_string: "b", replace_all: "true" } },
    });
    const r = coerced?.["result"] as { content: { text: string }[]; isError: boolean };
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("invalid arguments for edit_file: replace_all:");
  });

  test("bad tool name and bad arguments come back as isError, not protocol errors", async () => {
    const { server } = makeServer();
    await initialized(server);
    const unknown = await call(server, {
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: { name: "nope", arguments: {} },
    });
    expect((unknown?.["result"] as { isError: boolean }).isError).toBe(true);
    const bad = await call(server, {
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "run_snippet", arguments: {} },
    });
    expect((bad?.["result"] as { isError: boolean }).isError).toBe(true);
  });

  test("unknown method and parse errors are JSON-RPC errors", async () => {
    const { server } = makeServer();
    const res = await call(server, { jsonrpc: "2.0", id: 10, method: "resources/list" });
    expect((res?.["error"] as { code: number }).code).toBe(-32601);
    const parseErr = JSON.parse((await server.handleLine("{nope")) ?? "{}") as Record<string, unknown>;
    expect((parseErr["error"] as { code: number }).code).toBe(-32700);
  });

  test("tools/call accepts arguments as a JSON string, a fenced string, and repairs trailing commas", async () => {
    // Some MCP clients send `arguments` as a JSON *string* (sometimes fenced);
    // mcp.ts routes them through coerceToolArgs. Exercise that wiring, which the
    // unit-level toolargs tests never drove through the protocol.
    for (const raw of [
      '{"code":"1+1"}',
      '```json\n{"code":"1+1"}\n```',
      '{"code":"1+1",}',
    ]) {
      const { server } = makeServer();
      await initialized(server);
      const res = await call(server, {
        jsonrpc: "2.0",
        id: 20,
        method: "tools/call",
        params: { name: "run_snippet", arguments: raw },
      });
      const result = res?.["result"] as { content: { text: string }[]; isError: boolean };
      expect(result.isError).toBe(false);
      expect(result.content[0]!.text).toContain("evaluated:1+1");
    }
  });

  test("the recorded tool-call args are the parsed object, not the raw string", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wrathbench-mcp-"));
    const ctx: ToolContext = {
      sandbox: fakeSandbox(),
      workspace: new Workspace(join(dir, "workspace")),
      wiki: undefined,
      sessionLive: () => true,
      reflect: new ReflectGate(),
      episodic: new EpisodicLog(join(dir, "episodic.jsonl")),
      turn: () => 1,
    };
    let recorded: unknown;
    const server = new McpServer(ctx, {
      serverVersion: "test",
      onToolCall: (_name, args) => {
        recorded = args;
      },
    });
    await initialized(server);
    await call(server, {
      jsonrpc: "2.0",
      id: 21,
      method: "tools/call",
      params: { name: "run_snippet", arguments: '{"code":"1+1"}' },
    });
    expect(recorded).toEqual({ code: "1+1" });
  });

  // Every writer of this callback appends after the call ran, so the stamp it
  // is handed is the only start of the call a reader gets.
  test("the tool-call callback is handed the dispatch time, taken before the tool ran", async () => {
    const { sandbox, startedAt } = slowSandbox(40);
    const { ctx } = makeCtx(sandbox);
    const seen: { dispatchTs: number; at: number }[] = [];
    const server = new McpServer(ctx, {
      serverVersion: "test",
      onToolCall: (_name, _args, _result, dispatchTs) => seen.push({ dispatchTs, at: Date.now() }),
    });
    await initialized(server);
    await call(server, {
      jsonrpc: "2.0",
      id: 30,
      method: "tools/call",
      params: { name: "run_snippet", arguments: { code: "1+1" } },
    });
    expect(seen).toHaveLength(1);
    const { dispatchTs, at } = seen[0]!;
    expect(dispatchTs).toBeGreaterThan(0);
    expect(dispatchTs).toBeLessThanOrEqual(startedAt());
    // Not write time: the callback fires a whole snippet after the stamp.
    expect(at - dispatchTs).toBeGreaterThanOrEqual(30);
  });

  test("a call refused at the argument check is stamped too", async () => {
    const { ctx } = makeCtx();
    const stamps: number[] = [];
    const before = Date.now();
    const server = new McpServer(ctx, {
      serverVersion: "test",
      onToolCall: (_name, _args, result, dispatchTs) => {
        expect(result.text).toContain("not valid JSON");
        stamps.push(dispatchTs);
      },
    });
    await initialized(server);
    await call(server, {
      jsonrpc: "2.0",
      id: 31,
      method: "tools/call",
      params: { name: "run_snippet", arguments: "{not json" },
    });
    expect(stamps).toHaveLength(1);
    expect(stamps[0]!).toBeGreaterThanOrEqual(before);
  });

  test("the standalone server's writer puts the dispatch time on the tool_call record", async () => {
    const { sandbox, startedAt } = slowSandbox(40);
    const { ctx } = makeCtx(sandbox);
    const dir = mkdtempSync(join(tmpdir(), "wrathbench-mcp-traj-"));
    const trajectory = new Trajectory(dir);
    const server = new McpServer(ctx, { serverVersion: "test", onToolCall: trajectoryToolCallWriter(trajectory) });
    await initialized(server);
    await call(server, {
      jsonrpc: "2.0",
      id: 32,
      method: "tools/call",
      params: { name: "run_snippet", arguments: { code: "1+1" } },
    });
    trajectory.close();
    const records = readTrajectory(dir).filter((r) => r.t === "tool_call" || r.t === "tool_result");
    expect(records.map((r) => r.t)).toEqual(["tool_call", "tool_result"]);
    const [callRec, resultRec] = records;
    // Turn-less, as before: the stamp, not the shape, is what times it.
    expect(callRec!["turn"]).toBeUndefined();
    const dispatchTs = callRec!["dispatchTs"] as number;
    expect(typeof dispatchTs).toBe("number");
    expect(dispatchTs).toBeLessThanOrEqual(startedAt());
    expect(callRec!.ts - dispatchTs).toBeGreaterThanOrEqual(30);
    expect(resultRec!["dispatchTs"]).toBeUndefined();
  });

  test("search_reference without a bundle reports unavailability", async () => {
    const { server } = makeServer();
    await initialized(server);
    const res = await call(server, {
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: { name: "search_reference", arguments: { query: "Northshire" } },
    });
    const result = res?.["result"] as { content: { text: string }[]; isError: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("unavailable");
  });
});
