/**
 * A party line after a sandbox restart. `say(text, { type })` goes out in the
 * language a client speaks by default, chosen from our own race; a restarted
 * child reattaches to a session that is already in world, and nothing on that
 * path carries the race again: the same-token `POST /session` runs no login
 * flow, so no `SMSG_CHAR_ENUM` follows; `WB_SESSION_STATE` names the character
 * and its level only; and the server sends no second create block for us. So
 * the host keeps the login's character list with the client cache
 * (`runner/src/sandbox/client-cache.ts`) and seeds the new child with it.
 *
 * Fixture-based, no game stack: the real sandbox child against a stand-in
 * module that acks every request, with frames hand-written from
 * module/PROTOCOL.md's tables (names invented, nothing captured from a game).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { CLIENT_CACHE_FILE, ClientCacheStore } from "../src/sandbox/client-cache";
import { SandboxHost } from "../src/sandbox/host";
import { Scratchpad } from "../src/scratchpad";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();
const TOKEN = "say-after-restart-token-0123456789";

const hosts: SandboxHost[] = [];
const stubs: { stop(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0, hosts.length).map((h) => h.stop()));
  await Promise.all(stubs.splice(0, stubs.length).map((s) => s.stop()));
});

/** Answers `/session` as the module does for an in-world session under the same token, and acks every action. */
function startModuleStub(): { url: string; raws: string[] } {
  const raws: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/session" && req.method === "POST") {
        return Response.json({ ok: true, account: "RUNNER", character: "Fenwick", guid: "7", inWorld: true });
      }
      if (url.pathname === "/action") {
        return req.json().then((raw) => {
          const body = raw as Record<string, unknown>;
          if (body["action"] === "raw") raws.push(`${String(body["opcode"])} ${String(body["payload"])}`);
          return Response.json({ ok: true, action: String(body["action"]) });
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  stubs.push({ stop: () => server.stop(true) });
  return { url: `http://127.0.0.1:${server.port}`, raws };
}

function makeHost(moduleUrl: string, runDir: string, store: ClientCacheStore | null): SandboxHost {
  const host = new SandboxHost({
    moduleUrl,
    token: TOKEN,
    scratchpad: new Scratchpad(join(runDir, "scratchpad.md")),
    snippetTimeoutMs: 2_000,
    pingGraceMs: 300,
    ...(store !== null ? { clientCache: store } : {}),
  });
  hosts.push(host);
  return host;
}

const FEED = `
globalThis.seq ??= 1;
globalThis.feed = (opcode, opcodeId, data) => {
  events.ingest(JSON.stringify({ seq: seq++, opcode, opcodeId, ts: 1000 + seq, data }));
};
`;

/** The login the first child saw: the account's character list (we are a level 3 Human), then the session. */
const LOGIN = `${FEED}
feed("SMSG_CHAR_ENUM", 0x03b, { count: 2, characters: [
  { guid: "7", name: "Fenwick", race: 1, class: 1, gender: 0, level: 3 },
  { guid: "8", name: "Quilby", race: 2, class: 3, gender: 1, level: 11 },
] });
await sdk.createSession({ character: "Fenwick" });
await sdk.say("before", { type: "party" });
"logged in";
`;

/**
 * What the run did after its restart: `connect()` brings the reattach's
 * session state (level 9 by now), then `createSession` and a party line.
 */
const AFTER_RESTART = `${FEED}
feed("WB_SESSION_STATE", 0xff03, {
  character: "Fenwick", guid: "7", inWorld: true,
  map: 0, x: -6572, y: 405, z: 387, o: 1.7, level: 9,
  zoneId: 1, zoneName: "", areaId: 132, areaName: "",
});
await sdk.createSession({ character: "Fenwick" });
let said;
try { await sdk.say("after", { type: "party" }); said = "sent"; } catch (e) { said = String(e); }
return JSON.stringify({ said, level: state.self.level?.value ?? null });
`;

/** A party line in Common (7): `CMSG_MESSAGECHAT` with type 0x02, then the language, both u32 LE. */
const PARTY_IN_COMMON = /^CMSG_MESSAGECHAT 0200000007000000/;

async function afterRestart(host: SandboxHost): Promise<{ said: string; level: number | null }> {
  const res = await host.evalSnippet(AFTER_RESTART);
  expect(res.ok).toBe(true);
  return JSON.parse(JSON.parse(res.value!) as string) as { said: string; level: number | null };
}

describe("say after a sandbox restart", () => {
  test("a restarted child still knows its race, and the login's level does not overwrite the reattach's", async () => {
    const stub = startModuleStub();
    const dir = tempDir("wrathbench-say-restart-");
    const host = makeHost(stub.url, dir, new ClientCacheStore(join(dir, CLIENT_CACHE_FILE)));

    expect((await host.evalSnippet(LOGIN)).ok).toBe(true);
    expect(stub.raws).toHaveLength(1);
    expect(stub.raws[0]).toMatch(PARTY_IN_COMMON);

    expect((await host.evalSnippet("for (;;) {}")).restarted).toBe(true);

    expect(await afterRestart(host)).toEqual({ said: "sent", level: 9 });
    expect(stub.raws).toHaveLength(2);
    expect(stub.raws[1]).toMatch(PARTY_IN_COMMON);
  }, 20_000);

  test("a resumed run on the same run directory is seeded from the file", async () => {
    const stub = startModuleStub();
    const dir = tempDir("wrathbench-say-restart-");
    const first = makeHost(stub.url, dir, new ClientCacheStore(join(dir, CLIENT_CACHE_FILE)));
    expect((await first.evalSnippet(LOGIN)).ok).toBe(true);
    await first.stop();

    const resumed = makeHost(stub.url, dir, new ClientCacheStore(join(dir, CLIENT_CACHE_FILE)));
    expect(await afterRestart(resumed)).toEqual({ said: "sent", level: 9 });
    expect(stub.raws[1]).toMatch(PARTY_IN_COMMON);
  }, 20_000);

  test("without the kept character list the restarted child is mute — the bug this closes", async () => {
    const stub = startModuleStub();
    const host = makeHost(stub.url, tempDir("wrathbench-say-restart-"), null);
    expect((await host.evalSnippet(LOGIN)).ok).toBe(true);
    expect((await host.evalSnippet("for (;;) {}")).restarted).toBe(true);
    const { said } = await afterRestart(host);
    expect(said).toContain("your race is not known yet");
    expect(stub.raws).toHaveLength(1);
  }, 20_000);
});
