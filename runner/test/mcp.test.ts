/**
 * MCP tool dispatch, driven in-process with fixture JSON-RPC lines. The
 * sandbox is faked; the point is the protocol and the tool wiring, not eval.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { McpServer, trajectoryToolCallWriter } from "../src/mcp";
import { EpisodicLog } from "../src/episodic";
import { ReflectGate } from "../src/reflect";
import { Scratchpad } from "@wrathbench/mcp";
import { Trajectory, readTrajectory } from "../src/trajectory";
import type { SandboxHost, SnippetResult } from "../src/sandbox/host";
import type { ActionHintNote } from "@wrathbench/mcp";
import { renderActionHints, type ToolContext } from "../src/tools";
import { SecretRedactor } from "@wrathbench/mcp";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();

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

function makeCtx(sandbox: SandboxHost = fakeSandbox()): { ctx: ToolContext; scratchpad: Scratchpad } {
  const dir = tempDir("wrathbench-mcp-");
  const scratchpad = new Scratchpad(join(dir, "scratchpad.md"));
  const ctx: ToolContext = {
    sandbox,
    scratchpad,
    wiki: undefined,
    sessionLive: () => true,
    reflect: new ReflectGate(),
    episodic: new EpisodicLog(join(dir, "episodic.jsonl")),
    turn: () => 1,
    secrets: new SecretRedactor(),
  };
  return { ctx, scratchpad };
}

function makeServer(): { server: McpServer; scratchpad: Scratchpad } {
  const { ctx, scratchpad } = makeCtx();
  return { server: new McpServer(ctx, { serverVersion: "test" }), scratchpad };
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
  test("tools/list exposes exactly the nine tools", async () => {
    const { server } = makeServer();
    await initialized(server);
    const res = await call(server, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    const tools = (res?.["result"] as { tools: { name: string }[] }).tools.map((t) => t.name);
    expect(tools).toEqual([
      "run_snippet",
      "recent_events",
      "state_summary",
      "search_reference",
      "write_scratchpad",
      "edit_scratchpad",
      "reflect",
      "log_status",
      "read_log",
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
    // limit 2 now means two *signal* events, taken from the newest end.
    const eventText = (events?.["result"] as { content: { text: string }[] }).content[0]!.text;
    expect(eventText.split("\n")).toHaveLength(2);
    expect(eventText).toContain("#1 SMSG_MESSAGECHAT");
    expect(eventText).toContain("#2 SMSG_MESSAGECHAT");
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
    const dir = tempDir("wrathbench-mcp-");
    const scratchpad = new Scratchpad(join(dir, "scratchpad.md"));
    const ctx: ToolContext = {
      sandbox: fakeSandbox(),
      scratchpad,
      wiki: undefined,
      sessionLive: () => true,
      reflect: new ReflectGate(),
      episodic: new EpisodicLog(join(dir, "episodic.jsonl")),
      turn: () => 1,
      secrets: new SecretRedactor(),
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
  test("the standalone server's writer puts the dispatch time on the tool_call record", async () => {
    const { sandbox, startedAt } = slowSandbox(40);
    const { ctx } = makeCtx(sandbox);
    const dir = tempDir("wrathbench-mcp-traj-");
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

  test("pending action hints ride a CLI scaffold's next tool result, and the record carries them", async () => {
    // The CLI drivers reach the tools through this server, so this is where a
    // background routine's hint meets claude-code and codex: on the next tool
    // result of any kind, an unparseable call included, and in the record.
    const pending: ActionHintNote[] = [];
    const hint: ActionHintNote = { action: "moveTo", status: "drop", count: 2, hint: "steps off a ledge", ts: 1 };
    const block = renderActionHints([hint]) as string;
    const sandbox = fakeSandbox();
    (sandbox as unknown as { drainActionHints: () => Promise<ActionHintNote[]> }).drainActionHints = async () =>
      pending.splice(0, pending.length);
    const { ctx } = makeCtx(sandbox);
    const dir = tempDir("wrathbench-mcp-hints-");
    const trajectory = new Trajectory(dir);
    const server = new McpServer(ctx, { serverVersion: "test", onToolCall: trajectoryToolCallWriter(trajectory) });
    await initialized(server);

    pending.push({ ...hint });
    const wrote = await call(server, {
      jsonrpc: "2.0",
      id: 41,
      method: "tools/call",
      params: { name: "write_scratchpad", arguments: { content: "# hi" } },
    });
    const first = wrote?.["result"] as { content: { text: string }[]; isError: boolean };
    expect(first.content[0]!.text).toBe(`written (4 chars)\n${block}`);
    expect(first.isError).toBe(false);

    pending.push({ ...hint });
    const broken = await call(server, {
      jsonrpc: "2.0",
      id: 42,
      method: "tools/call",
      params: { name: "write_scratchpad", arguments: "{not json" },
    });
    const second = broken?.["result"] as { content: { text: string }[]; isError: boolean };
    expect(second.content[0]!.text).toContain("not valid JSON");
    expect(second.content[0]!.text.endsWith(`\n${block}`)).toBe(true);
    expect(second.isError).toBe(true);

    trajectory.close();
    const texts = readTrajectory(dir)
      .filter((r) => r.t === "tool_result")
      .map((r) => r["text"]);
    expect(texts).toEqual([first.content[0]!.text, second.content[0]!.text]);
    expect(pending).toEqual([]);
  });
});
