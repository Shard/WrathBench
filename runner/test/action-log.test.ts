/**
 * The action log: every `POST /action` the sandbox's SDK client dispatches,
 * with the module's answer, written as `actions` records linked to the tool
 * call that ran the snippet.
 *
 * Fixture-based, no game stack: a stand-in module answers the real sandbox
 * child's requests (one refusal among them), and the link is checked through
 * the MCP server's real `dispatchTs` stamp.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { EpisodicLog } from "../src/episodic";
import { McpServer, trajectoryToolCallWriter } from "../src/mcp";
import { ReflectGate } from "../src/reflect";
import { type ActionsFlush, SandboxHost } from "../src/sandbox/host";
import { Scratchpad } from "../src/scratchpad";
import type { ToolContext } from "../src/tools";
import { Trajectory, readTrajectory } from "../src/trajectory";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();
const TOKEN = "action-log-token-0123456789";

const hosts: SandboxHost[] = [];
const stubs: { stop(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0, hosts.length).map((h) => h.stop()));
  await Promise.all(stubs.splice(0, stubs.length).map((s) => s.stop()));
});

/** Acks every action; refuses `cast_spell` of spell 999 the way the module refuses. */
function startModuleStub(): { url: string; bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = [];
  const server = Bun.serve<{ token: string }, never>({
    port: 0,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/events") {
        return srv.upgrade(req, { data: { token: "" } }) ? undefined : new Response("no", { status: 400 });
      }
      if (url.pathname === "/session" && req.method === "POST") {
        return Response.json({ ok: true, token: TOKEN, account: "RUNNER", character: "Fenwick", guid: 7, inWorld: true });
      }
      if (url.pathname === "/action") {
        return req.json().then((raw) => {
          const body = raw as Record<string, unknown>;
          bodies.push(body);
          const action = String(body["action"]);
          if (action === "cast_spell" && body["spellId"] === 999) {
            return Response.json(
              { ok: false, error: "spell_not_known", hint: "the spellbook has no spell 999" },
              { status: 409 },
            );
          }
          return Response.json({ ok: true, action, token: TOKEN });
        });
      }
      return new Response("not found", { status: 404 });
    },
    websocket: { message() {} },
  });
  stubs.push({ stop: () => server.stop(true) });
  return { url: `http://127.0.0.1:${server.port}`, bodies };
}

function makeHost(moduleUrl: string, flushes: ActionsFlush[]): SandboxHost {
  const dir = tempDir("wrathbench-actions-sbx-");
  const host = new SandboxHost({
    moduleUrl,
    token: TOKEN,
    scratchpad: new Scratchpad(join(dir, "scratchpad.md")),
    snippetTimeoutMs: 6_000,
    pingGraceMs: 1_000,
    onActions: (f) => flushes.push(f),
  });
  hosts.push(host);
  return host;
}

const NAME_QUERY =
  `events.ingest(JSON.stringify({ seq: 1, opcode: "SMSG_NAME_QUERY_RESPONSE", opcodeId: 0x051, ts: 1000,` +
  ` data: { guid: "9", found: true, name: "Ordrick" } }))`;

describe("the sandbox logs every action it dispatches", () => {
  test("one flush per snippet, linked to its call, token stripped, names from the cache", async () => {
    const stub = startModuleStub();
    const flushes: ActionsFlush[] = [];
    const host = makeHost(stub.url, flushes);
    await host.evalSnippet("await connect(); await sdk.createSession({ character: 'Fenwick' });", { callTs: 111, turn: 1 });
    // `/session` is not an action: nothing is logged for it.
    expect(flushes).toEqual([]);
    await host.evalSnippet(NAME_QUERY);

    const res = await host.evalSnippet(
      `await sdk.setTarget("9");
       for (let i = 0; i < 3; i++) await sdk.attackStop();
       await sdk.raw("CMSG_TEXT_EMOTE", "2200000000000000");
       try { await sdk.castSpell(999) } catch {}
       "done"`,
      { callTs: 222, turn: 2 },
    );
    expect(res.ok).toBe(true);
    // Written before the result came back, as one record for the snippet.
    expect(flushes.length).toBe(1);
    const f = flushes[0]!;
    expect(f.callTs).toBe(222);
    expect(f.turn).toBe(2);
    expect(f.routine).toBeUndefined();
    expect(f.actions.map((a) => a.action)).toEqual(["set_target", "attack_stop", "raw", "cast_spell"]);

    const [target, stop, raw, cast] = f.actions;
    expect(target).toMatchObject({ args: { guid: "9" }, status: 200, names: { target: "Ordrick" } });
    expect(typeof target!.ts).toBe("number");
    expect(typeof target!.ms).toBe("number");
    // Three identical dispatches, one note.
    expect(stop).toMatchObject({ action: "attack_stop", count: 3, status: 200 });
    expect(stop!.args).toBeUndefined();
    expect(stop!.lastTs).toBeGreaterThanOrEqual(stop!.ts);
    expect(raw!.args).toEqual({ opcode: "CMSG_TEXT_EMOTE", payload: "2200000000000000" });
    // The module's refusal, as it answered — the record invents no outcome.
    expect(cast).toMatchObject({
      args: { spellId: 999 },
      status: 409,
      error: "spell_not_known",
      hint: "the spellbook has no spell 999",
    });
    expect(cast!.names).toBeUndefined();

    // The token reached the module on every request and the log on none.
    expect(stub.bodies.every((b) => b["token"] === TOKEN)).toBe(true);
    expect(JSON.stringify(flushes)).not.toContain(TOKEN);
  });

  test("a background routine's actions keep the snippet that launched it, marked as a routine", async () => {
    const stub = startModuleStub();
    const flushes: ActionsFlush[] = [];
    const host = makeHost(stub.url, flushes);
    await host.evalSnippet("await connect(); await sdk.createSession({ character: 'Fenwick' });");
    await host.evalSnippet(
      `globalThis.later = (async () => { await sleep(150, { wake: false }); await sdk.say("later"); })(); "started"`,
      { callTs: 333, turn: 3 },
    );
    await Bun.sleep(300);
    await host.evalSnippet(`await sdk.say("now"); 1`, { callTs: 444, turn: 4 });
    const byCall = new Map(flushes.map((f) => [f.callTs, f]));
    expect(byCall.get(333)).toMatchObject({ routine: true, turn: 3, actions: [{ action: "say", args: { text: "later" } }] });
    expect(byCall.get(444)).toMatchObject({ turn: 4, actions: [{ action: "say", args: { text: "now" } }] });
    expect(byCall.get(444)!.routine).toBeUndefined();
  });

  test("past the per-flush cap the rest are counted by name, not kept", async () => {
    const stub = startModuleStub();
    const flushes: ActionsFlush[] = [];
    const host = makeHost(stub.url, flushes);
    await host.evalSnippet("await connect(); await sdk.createSession({ character: 'Fenwick' });");
    await host.evalSnippet(`for (let i = 0; i < 130; i++) await sdk.say("m" + i); 1`, { callTs: 555 });
    const f = flushes.find((x) => x.callTs === 555)!;
    expect(f.actions.length).toBe(120);
    expect(f.dropped).toEqual({ say: 10 });
  });
});

describe("the record joins its tool call", () => {
  test("an MCP-driven snippet's actions carry the call's dispatchTs as callTs", async () => {
    const stub = startModuleStub();
    const dir = tempDir("wrathbench-actions-traj-");
    const trajectory = new Trajectory(dir);
    const host = new SandboxHost({
      moduleUrl: stub.url,
      token: TOKEN,
      scratchpad: new Scratchpad(join(dir, "scratchpad.md")),
      snippetTimeoutMs: 6_000,
      pingGraceMs: 1_000,
      onActions: (flush) => trajectory.recordActions(flush),
    });
    hosts.push(host);
    const ctx: ToolContext = {
      sandbox: host,
      scratchpad: new Scratchpad(join(dir, "pad.md")),
      wiki: undefined,
      sessionLive: () => true,
      reflect: new ReflectGate(),
      episodic: new EpisodicLog(join(dir, "episodic.jsonl")),
      turn: () => 5,
    };
    const server = new McpServer(ctx, { onToolCall: trajectoryToolCallWriter(trajectory) });
    await server.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }));
    const run = (id: number, code: string) =>
      server.handleLine(
        JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "run_snippet", arguments: { code } } }),
      );
    await run(2, "await connect(); await sdk.createSession({ character: 'Fenwick' });");
    await run(3, `await sdk.say("hello"); 1`);
    trajectory.close();

    const records = readTrajectory(dir);
    const calls = records.filter((r) => r.t === "tool_call");
    const actions = records.filter((r) => r.t === "actions");
    expect(actions.length).toBe(1);
    expect(actions[0]).toMatchObject({ turn: 5, actions: [{ action: "say", args: { text: "hello" }, status: 200 }] });
    // Appended before the call it belongs to (the MCP writer records after the
    // fact), and joined by value rather than by position.
    const owner = calls.find((c) => c["dispatchTs"] === actions[0]!["callTs"]);
    expect(owner).toBeDefined();
    expect(records.indexOf(actions[0]!)).toBeLessThan(records.indexOf(owner!));
    expect(calls.map((c) => c["dispatchTs"] as number)).toEqual(
      [...new Set(calls.map((c) => c["dispatchTs"] as number))],
    );
  });
});
