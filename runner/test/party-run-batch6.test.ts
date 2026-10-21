/**
 * The runner half of the sixth batch from the 2026-10-20 Deadmines party
 * runs (attempt a7): a harness line raised by a background routine says which
 * snippet's code it came from, and the HUD's nearby line names a creature's
 * rank and a player's corpse. Fixture-based: a stand-in module answers the
 * real sandbox child, and the HUD is fed a hand-written snapshot with
 * invented names.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { formatStateSummary } from "../src/context";
import { SandboxHost } from "../src/sandbox/host";
import { Scratchpad } from "../src/scratchpad";
import { renderActionHints } from "../src/tools";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();
const TOKEN = "batch6-token-0123456789";

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
  const dir = tempDir("wrathbench-batch6-sbx-");
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

/** A spellbook, so a cast of an id outside it is refused as `not_known` with nothing sent. */
const SPELLBOOK =
  `events.ingest(JSON.stringify({ seq: 1, opcode: "SMSG_INITIAL_SPELLS", opcodeId: 0x12a, ts: 1000,` +
  ` data: { spells: [{ spellId: 133, rank: 1, name: "Ember Bolt" }], cooldowns: [] } }))`;

describe("a background routine's harness line names the snippet that started it", () => {
  test("a routine's hint under a later snippet says so; the snippet's own hint stays as it is", async () => {
    const host = makeHost(startModuleStub());
    await host.evalSnippet("await connect(); await sdk.createSession({ character: 'Fenwick' });");
    await host.evalSnippet(SPELLBOOK);
    const launch = await host.evalSnippet(
      `globalThis.loop7 = setInterval(() => { sdk.castSpell(642).catch(() => {}); }, 100); "started"`,
    );
    expect(launch.actionHints ?? []).toEqual([]);
    await Bun.sleep(350);
    const later = await host.evalSnippet(`clearInterval(globalThis.loop7); try { await sdk.castSpell(643) } catch {} ; 1`);
    const hints = later.actionHints ?? [];
    const routine = hints.find((h) => h.from !== undefined)!;
    expect(routine).toMatchObject({ action: "castSpell", status: "not_known", from: "globalThis.loop7 = setInterval(() => {…" });
    expect(routine.count).toBeGreaterThanOrEqual(2);
    const own = hints.find((h) => h.from === undefined)!;
    expect(own).toMatchObject({ action: "castSpell", status: "not_known", count: 1 });
    expect(own.hint).toContain("spell 643");

    // Drained between snippets (any other tool's result): every hint there is an earlier snippet's.
    await host.evalSnippet(`globalThis.once = (async () => { await sleep(100, { wake: false }); await sdk.castSpell(644).catch(() => {}); })(); "ok"`);
    await Bun.sleep(250);
    expect(await host.drainActionHints()).toMatchObject([
      { action: "castSpell", status: "not_known", from: "globalThis.once = (async () => {…" },
    ]);
  });

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

describe("the HUD's nearby line: rank and corpses", () => {
  test("the sandbox names a corpse by its owner's name query answer", async () => {
    const host = makeHost(startModuleStub());
    await host.evalSnippet("await connect(); await sdk.createSession({ character: 'Fenwick' });");
    await host.evalSnippet(
      `events.ingest(JSON.stringify({ seq: 1, opcode: "SMSG_UPDATE_OBJECT", opcodeId: 0x0a9, ts: 1000, data: { blocks: 1, objects: [` +
        `{ update: "create", guid: "17366161638117343239", objectType: "corpse", pos: { x: 1, y: 2, z: 3, o: 0 }, fields: { scale: 1, corpseOwnerGuid: "965" } },` +
        `{ update: "create", guid: "17366161638117343240", objectType: "corpse", pos: { x: 1, y: 3, z: 3, o: 0 }, fields: { scale: 1 } }] } }));` +
        `events.ingest(JSON.stringify({ seq: 2, opcode: "SMSG_NAME_QUERY_RESPONSE", opcodeId: 0x051, ts: 1001, data: { guid: "965", found: true, name: "Palafriend" } }))`,
    );
    const snap = await host.stateSnapshot();
    const text = formatStateSummary(snap, { sessionLive: true });
    expect(text).toMatch(/nearby: .*Palafriend's corpse \(\?y\), a corpse \(\?y\)/);
  });

  test("an elite says so, a normal creature says nothing more, a corpse is named by its owner or as a corpse", () => {
    const text = formatStateSummary(
      {
        self: { guid: { value: "7" } },
        units: [
          { guid: "9", name: "Ridge Overseer", type: "unit", distance: 8, dead: false, rank: "elite" },
          { guid: "10", name: "Ridge Digger", type: "unit", distance: 9, dead: true, rank: "normal" },
          { guid: "11", type: "corpse", distance: 12, dead: true, ownerName: "Palafriend" },
          { guid: "12", type: "corpse", distance: 14, dead: true },
        ],
      },
      { sessionLive: true },
    );
    expect(text).toContain("nearby: Ridge Overseer elite (8y), Ridge Digger dead (9y), Palafriend's corpse (12y), a corpse (14y)");
  });
});
