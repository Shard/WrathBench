/**
 * The runner half of the seventh batch from the 2026-10-21 Deadmines party
 * runs (attempt a2): the label a background routine's harness line carries.
 * The line named the snippet that started the routine by its first ~48
 * characters, which in the a2 party was mostly set-up: a rogue's routine
 * stood under `let s9 = startAI.toString(); const o9 = "sdk.mo…` and four
 * siblings like it, a healer's under `let src=ctl.toString()`. Fixture-based:
 * a stand-in module acks the real sandbox child, and the snippets follow the
 * a2 snippets' shapes with invented spell ids (outside the spellbook, so each
 * cast is refused as not_known with nothing sent).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { callSiteLabel, SNIPPET_URL } from "@wrathbench/mcp";
import { SandboxHost } from "../src/sandbox/host";
import { compileSnippet } from "@wrathbench/mcp";
import { Scratchpad } from "@wrathbench/mcp";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();
const TOKEN = "batch7-token-0123456789";

const hosts: SandboxHost[] = [];
const stubs: { stop(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0, hosts.length).map((h) => h.stop()));
  await Promise.all(stubs.splice(0, stubs.length).map((s) => s.stop()));
});

/** Acks every action. */
function startModuleStub(): string {
  const server = Bun.serve<{ token: string }, never>({
    port: 0,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/events") {
        return srv.upgrade(req, { data: { token: "" } }) ? undefined : new Response("no", { status: 400 });
      }
      if (url.pathname === "/session" && req.method === "POST") {
        return Response.json({ ok: true, account: "RUNNER", character: "Fenwick", guid: 7, inWorld: true });
      }
      if (url.pathname === "/action") {
        return req.json().then((raw) => Response.json({ ok: true, action: String((raw as Record<string, unknown>)["action"]) }));
      }
      return new Response("not found", { status: 404 });
    },
    websocket: { message() {} },
  });
  stubs.push({ stop: () => server.stop(true) });
  return `http://127.0.0.1:${server.port}`;
}

function makeHost(moduleUrl: string): SandboxHost {
  const dir = tempDir("wrathbench-batch7-sbx-");
  const host = new SandboxHost({
    moduleUrl,
    token: TOKEN,
    scratchpad: new Scratchpad(join(dir, "scratchpad.md")),
    snippetTimeoutMs: 6_000,
    pingGraceMs: 1_000,
  });
  hosts.push(host);
  return host;
}

const SPELLBOOK =
  `events.ingest(JSON.stringify({ seq: 1, opcode: "SMSG_INITIAL_SPELLS", opcodeId: 0x12a, ts: 1000,` +
  ` data: { spells: [{ spellId: 133, rank: 1, name: "Ember Bolt" }], cooldowns: [] } }))`;

describe("a routine's harness line names the routine, not the snippet's set-up", () => {
  test("the a2 shapes: a function rebuilt with eval, one restarted later, an IIFE, a named interval callback", async () => {
    const host = makeHost(startModuleStub());
    await host.evalSnippet("await connect(); await sdk.createSession({ character: 'Fenwick' });");
    await host.evalSnippet(SPELLBOOK);
    // The routine as first written: an assignment names it.
    await host.evalSnippet(
      `startAI = async () => { for (let i = 0; i < 2; i++) { await sleep(20, { wake: false }); await sdk.castSpell(642).catch(() => {}); } }; "defined"`,
    );
    // a2 rogue #282: rebuilt from its own source with eval, then restarted.
    // Before: "let s9 = startAI.toString(); const o9 = "642"; …"
    await host.evalSnippet(
      `let s9 = startAI.toString(); const o9 = "642"; if (!s9.includes(o9)) return "no";\n` +
        `s9 = s9.replace(o9, "645");\nglobalThis.startAI = eval("(" + s9 + ")"); startAI(); "ok"`,
    );
    // a2 healer: rebuilt with an indirect eval, started under another name.
    // Before: "let src = ctl.toString(); src = src.replace("64…"
    await host.evalSnippet(`ctl = async (g) => { await sleep(20, { wake: false }); await sdk.castSpell(646).catch(() => {}); }; "defined"`);
    await host.evalSnippet(
      `let src = ctl.toString(); src = src.replace("646", "647"); globalThis.ctl = (0, eval)("(" + src + ")"); ` +
        `C = { gen: 0 }; C.gen++; globalThis.ctlP = ctl(++C.gen).catch((e) => (C.err = String(e))); "ok"`,
    );
    // a2 paladin: an anonymous IIFE.
    // Before: "await sleep(10); globalThis.trip2 = (async () =>…"
    await host.evalSnippet(
      `await sleep(10); globalThis.trip2 = (async () => { for (const id of [648]) { await sleep(20, { wake: false }); ` +
        `await sdk.castSpell(id).catch(() => {}); } })(); "ok"`,
    );
    // A named interval callback.
    // Before: "async function tick() { await sdk.castSpell(650)…"
    await host.evalSnippet(`async function tick() { await sdk.castSpell(650).catch(() => {}); } globalThis.iv = setInterval(tick, 40); "ok"`);
    const later = await host.evalSnippet(`await sleep(200, { wake: false }); clearInterval(globalThis.iv); 1`);
    const from = new Map((later.actionHints ?? []).map((h) => [h.hint.match(/spell (\d+)/)?.[1], h.from]));
    expect(from.get("645")).toBe("startAI");
    expect(from.get("647")).toBe("ctl");
    expect(from.get("648")).toBe("globalThis.trip2 = (async () => {…");
    expect(from.get("650")).toBe("tick");
  });

  test("a mage-shaped restart: the eval-built routine started by a later snippet is named by its call", async () => {
    const host = makeHost(startModuleStub());
    await host.evalSnippet("await connect(); await sdk.createSession({ character: 'Fenwick' });");
    await host.evalSnippet(SPELLBOOK);
    await host.evalSnippet(`globalThis.startAI = eval("(async () => { await sleep(20, { wake: false }); await sdk.castSpell(651).catch(() => {}); })"); "built"`);
    // a2 mage: "AI.gen++; await sleep(200,{wake:false}); while(…" started it.
    await host.evalSnippet(`AI = { gen: 0 }; AI.gen++; await sleep(5, { wake: false }); startAI(); "ok"`);
    const later = await host.evalSnippet(`await sleep(150, { wake: false }); 1`);
    expect(later.actionHints?.map((h) => h.from)).toEqual(["startAI"]);
  });

  test("a named function a snippet built with eval is named by its own name", async () => {
    const host = makeHost(startModuleStub());
    await host.evalSnippet("await connect(); await sdk.createSession({ character: 'Fenwick' });");
    await host.evalSnippet(SPELLBOOK);
    await host.evalSnippet(
      `globalThis.go = eval("(async function rogueLoop() { await sleep(20, { wake: false }); await sdk.castSpell(655).catch(() => {}); })"); go(); "ok"`,
    );
    const later = await host.evalSnippet(`await sleep(150, { wake: false }); 1`);
    expect(later.actionHints?.map((h) => h.from)).toEqual(["rogueLoop"]);
  });

  test("the current snippet's own calls stay one line per status, however many lines made them, and a routine's line survives them", async () => {
    const host = makeHost(startModuleStub());
    await host.evalSnippet("await connect(); await sdk.createSession({ character: 'Fenwick' });");
    await host.evalSnippet(SPELLBOOK);
    await host.evalSnippet(`globalThis.iv = setInterval(() => { sdk.castSpell(656).catch(() => {}); }, 30); "ok"`);
    // Forty statements, each its own line: the SDK keeps 32 tally keys between drains.
    const calls = Array.from({ length: 40 }, (_, i) => `await sdk.castSpell(${700 + i}).catch(() => {});`).join("\n");
    const own = await host.evalSnippet(`${calls}\nawait sleep(100, { wake: false }); clearInterval(globalThis.iv); 1`);
    const lines = (own.actionHints ?? []).map((h) => [h.status, h.from, h.count >= 1]);
    expect(lines).toContainEqual(["not_known", undefined, true]);
    expect(lines).toContainEqual(["not_known", "globalThis.iv = setInterval(() => {…", true]);
    expect(own.actionHints?.find((h) => h.from === undefined)).toMatchObject({ count: 40 });
    expect(own.actionHints?.find((h) => h.from === undefined)?.hint).toContain("spell 739");
  });
});

describe("callSiteLabel over a stack and the compiled bodies", () => {
  const body = compileSnippet(`await onRevive();\nglobalThis.trip2 = (async () => {\n  for (const p of [1]) {\n    await sdk.moveTo(p);\n  }\n})();\n"ok"`).statementsBody;
  const bodies = new Map([[12, body]]);
  const EVAL_FILE = "file:///app/runner/src/sandbox/entry.ts";
  test("the outermost frame's statement, or its name, or the routine the snippet built", () => {
    const line = body.split("\n").findIndex((l) => l.includes("sdk.moveTo")) + 1;
    const stack = `Error\n    at moveTo (/app/sdk/src/client.ts:1:1)\n    at async <anonymous> (${SNIPPET_URL}12:${line + 2}:20)`;
    expect(callSiteLabel(stack, 12, bodies, EVAL_FILE)).toBe("globalThis.trip2 = (async () => {…");
    expect(callSiteLabel(`Error\n    at async tick (${SNIPPET_URL}9:3:1)\n    at async loop (${SNIPPET_URL}8:3:1)`, 12, bodies, EVAL_FILE)).toBe("loop");
    const rebuilt = new Map([[13, compileSnippet(`let s9 = startAI.toString(); globalThis.startAI = eval("(" + s9 + ")"); startAI(); "ok"`).statementsBody]]);
    expect(callSiteLabel(`Error\n    at async <anonymous> (${EVAL_FILE}:4:23)`, 13, rebuilt, EVAL_FILE)).toBe("startAI");
    // A snippet's own top level is no routine; nothing to go on keeps the snippet's opening.
    expect(callSiteLabel(`Error\n    at castSpell (/app/sdk/src/client.ts:1:1)\n    at anonymous (${SNIPPET_URL}12:3:9)`, 12, bodies, EVAL_FILE)).toBeUndefined();
    expect(callSiteLabel("Error\n    at moveTo (/app/sdk/src/client.ts:1:1)", 12, bodies, EVAL_FILE)).toBeUndefined();
  });
});
