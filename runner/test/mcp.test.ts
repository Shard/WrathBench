/**
 * MCP tool dispatch, driven in-process with fixture JSON-RPC lines. The
 * sandbox is faked; the point is the protocol and the tool wiring, not eval.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "../src/mcp";
import { Scratchpad } from "../src/scratchpad";
import type { SandboxHost, SnippetResult } from "../src/sandbox/host";
import type { ToolContext } from "../src/tools";

function fakeSandbox(): SandboxHost {
  const fake = {
    evalSnippet: (code: string): Promise<SnippetResult> =>
      Promise.resolve({ ok: true, value: `evaluated:${code}`, logs: [], durationMs: 1 }),
    recentEvents: (limit: number) =>
      Promise.resolve(
        Array.from({ length: Math.min(limit, 3) }, (_, i) => ({
          seq: i,
          ts: i,
          opcode: "SMSG_MESSAGECHAT",
          data: { message: `m${i}` },
        })),
      ),
    stateSnapshot: () =>
      Promise.resolve({ self: { name: "Benchy", guid: "7" }, lastSeq: 2, eventCount: 3 }),
    totalRestarts: 0,
    consecutiveRestarts: 0,
    drainNotices: () => [],
  };
  return fake as unknown as SandboxHost;
}

function makeServer(): { server: McpServer; scratchpad: Scratchpad } {
  const dir = mkdtempSync(join(tmpdir(), "wrathbench-mcp-"));
  const scratchpad = new Scratchpad(join(dir, "scratchpad.md"));
  const ctx: ToolContext = {
    sandbox: fakeSandbox(),
    scratchpad,
    wiki: undefined,
    sessionLive: () => true,
  };
  return { server: new McpServer(ctx, { serverVersion: "test" }), scratchpad };
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

  test("tools/list exposes exactly the six phase-0 tools", async () => {
    const { server } = makeServer();
    await initialized(server);
    const res = await call(server, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    const tools = (res?.["result"] as { tools: { name: string }[] }).tools.map((t) => t.name);
    expect(tools).toEqual([
      "run_snippet",
      "recent_events",
      "state_summary",
      "search_reference",
      "read_scratchpad",
      "write_scratchpad",
    ]);
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
    expect((events?.["result"] as { content: { text: string }[] }).content[0]!.text).toContain(
      "#0 SMSG_MESSAGECHAT",
    );
  });

  test("scratchpad write/read round-trips through tools", async () => {
    const { server, scratchpad } = makeServer();
    await initialized(server);
    await call(server, {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "write_scratchpad", arguments: { content: "# remembered" } },
    });
    expect(scratchpad.read()).toBe("# remembered");
    const read = await call(server, {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "read_scratchpad", arguments: {} },
    });
    expect((read?.["result"] as { content: { text: string }[] }).content[0]!.text).toBe("# remembered");
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
