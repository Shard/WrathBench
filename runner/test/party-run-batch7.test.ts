/**
 * The label a background routine's harness line carries: which snippet's
 * code it came from, named by the routine rather than by the snippet's
 * set-up (`let s9 = startAI.toString(); …` named nothing a model could act
 * on). Fixture-based: a stand-in module acks the real sandbox child, and the
 * snippets use invented spell ids outside the spellbook, so each cast is
 * refused as not_known with nothing sent.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { callSiteLabel, compileSnippet, Scratchpad, SNIPPET_URL } from "@wrathbench/mcp";
import { SandboxHost } from "../src/sandbox/host";
import { renderActionHints } from "../src/tools";
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

const SPELLBOOK =
  `events.ingest(JSON.stringify({ seq: 1, opcode: "SMSG_INITIAL_SPELLS", opcodeId: 0x12a, ts: 1000,` +
  ` data: { spells: [{ spellId: 133, rank: 1, name: "Ember Bolt" }], cooldowns: [] } }))`;

describe("a routine's harness line names the routine, not the snippet's set-up", () => {
  test("one child through every shape: a later snippet's routine, a drain between snippets, eval rebuilds, an IIFE, an interval, the own-call cap", async () => {
    const dir = tempDir("wrathbench-batch7-sbx-");
    const host = new SandboxHost({
      moduleUrl: startModuleStub(),
      token: TOKEN,
      scratchpad: new Scratchpad(join(dir, "scratchpad.md")),
      snippetTimeoutMs: 6_000,
      pingGraceMs: 1_000,
    });
    hosts.push(host);
    await host.evalSnippet("await connect(); await sdk.createSession({ character: 'Fenwick' });");
    await host.evalSnippet(SPELLBOOK);

    // A routine's hint under a later snippet says where it came from; the snippet's own stays bare.
    const launch = await host.evalSnippet(`globalThis.loop7 = setInterval(() => { sdk.castSpell(660).catch(() => {}); }, 100); "started"`);
    expect(launch.actionHints ?? []).toEqual([]);
    await Bun.sleep(350);
    const later = await host.evalSnippet(`clearInterval(globalThis.loop7); try { await sdk.castSpell(661) } catch {} ; 1`);
    const routine = (later.actionHints ?? []).find((h) => h.from !== undefined)!;
    expect(routine).toMatchObject({ action: "castSpell", status: "not_known", from: "globalThis.loop7 = setInterval(() => {…" });
    expect(routine.count).toBeGreaterThanOrEqual(2);
    expect((later.actionHints ?? []).find((h) => h.from === undefined)).toMatchObject({ action: "castSpell", status: "not_known", count: 1 });
    // Drained between snippets (any other tool's result): every hint there is an earlier snippet's.
    await host.evalSnippet(`globalThis.once = (async () => { await sleep(100, { wake: false }); await sdk.castSpell(662).catch(() => {}); })(); "ok"`);
    await Bun.sleep(250);
    expect(await host.drainActionHints()).toMatchObject([{ action: "castSpell", status: "not_known", from: "globalThis.once = (async () => {…" }]);

    // Rebuilt from its own source with eval, then restarted: named by the assignment.
    await host.evalSnippet(`startAI = async () => { for (let i = 0; i < 2; i++) { await sleep(20, { wake: false }); await sdk.castSpell(642).catch(() => {}); } }; "defined"`);
    await host.evalSnippet(`let s9 = startAI.toString(); const o9 = "642"; if (!s9.includes(o9)) return "no";\ns9 = s9.replace(o9, "645");\nglobalThis.startAI = eval("(" + s9 + ")"); startAI(); "ok"`);
    // Rebuilt with an indirect eval, started under another name.
    await host.evalSnippet(`ctl = async (g) => { await sleep(20, { wake: false }); await sdk.castSpell(646).catch(() => {}); }; "defined"`);
    await host.evalSnippet(
      `let src = ctl.toString(); src = src.replace("646", "647"); globalThis.ctl = (0, eval)("(" + src + ")"); ` +
        `C = { gen: 0 }; C.gen++; globalThis.ctlP = ctl(++C.gen).catch((e) => (C.err = String(e))); "ok"`,
    );
    // An anonymous IIFE, and a named interval callback.
    await host.evalSnippet(`await sleep(10); globalThis.trip2 = (async () => { for (const id of [648]) { await sleep(20, { wake: false }); await sdk.castSpell(id).catch(() => {}); } })(); "ok"`);
    await host.evalSnippet(`async function tick() { await sdk.castSpell(650).catch(() => {}); } globalThis.iv = setInterval(tick, 40); "ok"`);
    const shapes = await host.evalSnippet(`await sleep(200, { wake: false }); clearInterval(globalThis.iv); 1`);
    const from = new Map((shapes.actionHints ?? []).map((h) => [h.hint.match(/spell (\d+)/)?.[1], h.from]));
    expect(from.get("645")).toBe("startAI");
    expect(from.get("647")).toBe("ctl");
    expect(from.get("648")).toBe("globalThis.trip2 = (async () => {…");
    expect(from.get("650")).toBe("tick");

    // The snippet's own calls stay one line per status however many lines made them
    // (the SDK keeps 32 tally keys between drains), and a routine's line survives them.
    await host.evalSnippet(`globalThis.iv = setInterval(() => { sdk.castSpell(656).catch(() => {}); }, 30); "ok"`);
    const calls = Array.from({ length: 40 }, (_, i) => `await sdk.castSpell(${700 + i}).catch(() => {});`).join("\n");
    const own = await host.evalSnippet(`${calls}\nawait sleep(100, { wake: false }); clearInterval(globalThis.iv); 1`);
    const lines = (own.actionHints ?? []).map((h) => [h.status, h.from, h.count >= 1]);
    expect(lines).toContainEqual(["not_known", "globalThis.iv = setInterval(() => {…", true]);
    expect(own.actionHints?.find((h) => h.from === undefined)).toMatchObject({ count: 40 });
    expect(own.actionHints?.find((h) => h.from === undefined)?.hint).toContain("spell 739");
  }, 30_000);

  test("the line puts the origin on its head, where the hint cap cannot cut it", () => {
    const text = renderActionHints([
      { action: "moveTo", status: "superseded", count: 3, hint: "a newer moveTo replaced this one", ts: 2, from: "globalThis.walk=(async()=>{const T={x:-11202.9,…" },
      { action: "castSpell", status: "caster_dead", count: 1, hint: "Ember Bolt (133): you are dead", ts: 1, from: "" },
      { action: "castSpell", status: "not_known", count: 1, hint: "spell 642 is not in your spellbook", ts: 0 },
    ]);
    expect(text).toBe(
      [
        "--- harness ---",
        "moveTo superseded ×3 (from an earlier snippet: globalThis.walk=(async()=>{const T={x:-11202.9,…): a newer moveTo replaced this one",
        "castSpell caster_dead (from an earlier snippet): Ember Bolt (133): you are dead",
        "castSpell not_known: spell 642 is not in your spellbook",
      ].join("\n"),
    );
  });
});

describe("callSiteLabel over a stack and the compiled bodies", () => {
  const body = compileSnippet(`await onRevive();\nglobalThis.trip2 = (async () => {\n  for (const p of [1]) {\n    await sdk.moveTo(p);\n  }\n})();\n"ok"`).statementsBody;
  const bodies = new Map([[12, body]]);
  const EVAL_FILE = "file:///app/mcp/src/sandbox/child.ts";
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
