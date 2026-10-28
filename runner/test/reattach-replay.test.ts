/**
 * A restarted sandbox child reattaches to the module session its predecessor
 * left, and the module answers the subscribe with the reattach replay: a
 * `WB_SESSION_STATE` saying `replay: true`, then what a connected client holds
 * — the character's own create block with its items, the login packets, a
 * create block for everything in view — closed by `WB_REPLAY_DONE`
 * (module/PROTOCOL.md, "/events"). The ambient `connect()` waits for that
 * close, so the line after `await connect()` reads a whole cache: own race
 * (so a party line goes out), health, money, bag, spellbook, the units in
 * view. That is what the restart notice promises the model.
 *
 * The replay is asked for: the child's explicit `connect()` subscribes with
 * `replay=1`, and the stream's own reconnect after a drop does not, so a live
 * child whose socket flaps keeps its view and gets the plain state frame.
 *
 * Fixture-based, no game stack: the real sandbox child against a stand-in
 * module whose `/events` pushes the login burst to its first subscriber, the
 * replay to a later one that asks, and the plain state frame to one that does
 * not, with frames hand-written from module/PROTOCOL.md's tables (names
 * invented, nothing captured from a game).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import { REATTACH_REPLAY_WAIT_MS, REATTACH_STATE_WAIT_MS } from "@wrathbench/mcp";
import { SandboxHost, STATE_LOSS_RECOVERY } from "../src/sandbox/host";
import { Scratchpad } from "@wrathbench/mcp";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();
const TOKEN = "reattach-replay-token-0123456789ab";

const hosts: SandboxHost[] = [];
const stubs: { stop(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0, hosts.length).map((h) => h.stop()));
  await Promise.all(stubs.splice(0, stubs.length).map((s) => s.stop()));
});

type Frame = { opcode: string; opcodeId: number; data: unknown };
const frame = (opcode: string, opcodeId: number, data: unknown): Frame => ({ opcode, opcodeId, data });

const SELF = "7";
const WOLF = "17365880163140632581";
const ITEM = "4096";

/** The character's own create block, as the login sends it and the replay restates it. */
const selfCreate = (level: number, health: number, money: number): Frame =>
  frame("SMSG_UPDATE_OBJECT", 0x0a9, {
    blocks: 2,
    objects: [
      { update: "create", guid: ITEM, objectType: "item", fields: { entry: 6948, stackCount: 1 } },
      {
        update: "create",
        guid: SELF,
        objectType: "player",
        self: true,
        moveFlags: 0,
        runSpeed: 7,
        pos: { x: -6572, y: 405, z: 387, o: 1.7 },
        fields: { race: 1, class: 1, gender: 0, powerType: 1, health, maxHealth: 100, level, xp: 120, money, playerFlags: 0 },
      },
    ],
  });
const wolfCreate: Frame = frame("SMSG_UPDATE_OBJECT", 0x0a9, {
  blocks: 1,
  objects: [
    {
      update: "create",
      guid: WOLF,
      objectType: "unit",
      moveFlags: 0,
      runSpeed: 7.5,
      pos: { x: -6560, y: 410, z: 387, o: 0 },
      fields: { entry: 90210, health: 40, maxHealth: 40, level: 2, faction: 7, unitFlags: 0 },
    },
  ],
});
const spellbook: Frame = frame("SMSG_INITIAL_SPELLS", 0x12a, { spells: [{ spellId: 6603 }, { spellId: 78 }], cooldowns: [] });
const sessionState = (level: number, extra: Record<string, unknown>): Frame =>
  frame("WB_SESSION_STATE", 0xff03, {
    character: "Fenwick",
    guid: SELF,
    inWorld: true,
    map: 0,
    x: -6572,
    y: 405,
    z: 387,
    o: 1.7,
    level,
    zoneId: 1,
    zoneName: "",
    areaId: 132,
    areaName: "",
    ...extra,
  });

/** What the first subscriber sees: the login. */
const LOGIN: Frame[] = [
  frame("SMSG_CHAR_ENUM", 0x03b, { count: 1, characters: [{ guid: SELF, name: "Fenwick", race: 1, class: 1, gender: 0, level: 3 }] }),
  frame("SMSG_LOGIN_VERIFY_WORLD", 0x236, { map: 0, x: -6572, y: 405, z: 387, o: 1.7 }),
  spellbook,
  selfCreate(3, 80, 50),
  wolfCreate,
];
/** What every later subscriber sees: the reattach replay, the character having grown since. */
const REPLAY: Frame[] = [
  sessionState(9, { replay: true }),
  selfCreate(9, 64, 350),
  spellbook,
  wolfCreate,
  frame("WB_REPLAY_DONE", 0xff0b, { objects: 1 }),
];

/** What a later subscriber that does not ask for the replay gets: the plain state frame. */
const PLAIN_STATE: Frame[] = [sessionState(9, {})];

interface StubOptions {
  /** Frames for the first subscriber, then for each later one that asks (`replay=1`) or does not. */
  first?: Frame[];
  later?: Frame[];
  plain?: Frame[];
  /** A delay before the later subscribers' frames, as the world thread's tick is. */
  delayMs?: number;
  /** Close the first subscriber's socket after its frames, as a dropped connection would. */
  dropFirst?: boolean;
}

/** A stand-in module: `/events` pushes frames per subscribe, `/session` answers in-world, `/action` acks and keeps raws. */
function startModuleStub(opts: StubOptions = {}): { url: string; raws: string[]; subscribes: () => number; asked: () => boolean[] } {
  const raws: string[] = [];
  let seq = 0;
  let subscribes = 0;
  const asked: boolean[] = [];
  const push = (ws: ServerWebSocket<{ replay: boolean }>, frames: Frame[]) => {
    for (const f of frames) ws.send(JSON.stringify({ seq: seq++, ts: 1_000 + seq, ...f }));
  };
  const server = Bun.serve<{ replay: boolean }, never>({
    port: 0,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/events") {
        const replay = url.searchParams.get("replay") === "1";
        asked.push(replay);
        return srv.upgrade(req, { data: { replay } }) ? undefined : new Response("upgrade failed", { status: 400 });
      }
      if (url.pathname === "/session" && req.method === "POST") {
        return Response.json({ ok: true, account: "RUNNER", character: "Fenwick", guid: SELF, inWorld: true });
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
    websocket: {
      open(ws) {
        subscribes++;
        const frames = subscribes === 1 ? (opts.first ?? LOGIN) : ws.data.replay ? (opts.later ?? REPLAY) : (opts.plain ?? PLAIN_STATE);
        const first = subscribes === 1;
        setTimeout(() => {
          push(ws, frames);
          if (first && opts.dropFirst === true) ws.close();
        }, opts.delayMs ?? 30);
      },
      message() {},
    },
  });
  stubs.push({ stop: () => server.stop(true) });
  return { url: `http://127.0.0.1:${server.port}`, raws, subscribes: () => subscribes, asked: () => asked };
}

function makeHost(moduleUrl: string): SandboxHost {
  const dir = tempDir("wrathbench-reattach-");
  const host = new SandboxHost({
    moduleUrl,
    token: TOKEN,
    scratchpad: new Scratchpad(join(dir, "scratchpad.md")),
    snippetTimeoutMs: 8_000,
    pingGraceMs: 300,
  });
  hosts.push(host);
  return host;
}

/** What the model's next line reads, in the same snippet as the `connect()`. */
const READ_STATE = `
return JSON.stringify({
  race: state.self.fields.get("race")?.value ?? null,
  health: state.self.fields.get("health")?.value ?? null,
  money: state.self.fields.get("money")?.value ?? null,
  level: state.self.level?.value ?? null,
  item: state.nearby.has("${ITEM}"),
  spells: state.spells().length,
  units: state.nearbyUnits().length,
});`;

async function readState(host: SandboxHost, before: string): Promise<Record<string, unknown>> {
  const res = await host.evalSnippet(`${before}\n${READ_STATE}`);
  expect(res.ok).toBe(true);
  return JSON.parse(JSON.parse(res.value!) as string) as Record<string, unknown>;
}

/** A party line in Common (7): `CMSG_MESSAGECHAT` with type 0x02, then the language, both u32 LE. */
const PARTY_IN_COMMON = /^CMSG_MESSAGECHAT 0200000007000000/;

describe("the reattach replay after a sandbox restart", () => {
  test("connect() returns with the replay folded: own state, items, spells and the view are whole", async () => {
    const stub = startModuleStub();
    const host = makeHost(stub.url);

    const login = await readState(host, 'await connect(); await sdk.createSession({ character: "Fenwick" });');
    expect(login).toEqual({ race: 1, health: 80, money: 50, level: 3, item: true, spells: 2, units: 1 });

    expect((await host.evalSnippet("for (;;) {}")).restarted).toBe(true);
    const notice = host.drainNotices().find((n) => n.kind === "sandbox_restarted");
    expect(notice?.text).toContain(STATE_LOSS_RECOVERY);

    // The restart notice's promise, line for line: `await connect()`, and the
    // next line reads a whole cache — no createSession in between.
    const t0 = Date.now();
    const after = await readState(host, "await connect();");
    expect(after).toEqual({ race: 1, health: 64, money: 350, level: 9, item: true, spells: 2, units: 1 });
    expect(Date.now() - t0).toBeLessThan(REATTACH_STATE_WAIT_MS + REATTACH_REPLAY_WAIT_MS);
    expect(stub.subscribes()).toBe(2);
    // Both of the child's own connects asked; a fresh run's first ask is simply unanswered.
    expect(stub.asked()).toEqual([true, true]);

    // And the race the replayed create block carries picks the party line's language.
    const said = await host.evalSnippet('await sdk.say("after", { type: "party" }); "sent"');
    expect(said.ok).toBe(true);
    expect(stub.raws).toHaveLength(1);
    expect(stub.raws[0]).toMatch(PARTY_IN_COMMON);
  }, 30_000);

  test("the stream's own reconnect after a drop does not ask: the live child keeps its view and gets the plain frame", async () => {
    const stub = startModuleStub({ dropFirst: true });
    const host = makeHost(stub.url);
    const login = await readState(host, 'await connect(); await sdk.createSession({ character: "Fenwick" });');
    expect(login["units"]).toBe(1);
    // The ladder reconnects on its own; the module answers with the plain state frame.
    const deadline = Date.now() + 5_000;
    while (stub.subscribes() < 2 && Date.now() < deadline) await Bun.sleep(20);
    expect(stub.asked()).toEqual([true, false]);
    await Bun.sleep(200);
    const after = await readState(host, "");
    expect(after).toEqual({ race: 1, health: 80, money: 50, level: 9, item: true, spells: 2, units: 1 });
  }, 20_000);

  test("a subscribe the module answers with nothing (no session yet) returns after the bounded wait", async () => {
    const stub = startModuleStub({ first: [], later: [] });
    const host = makeHost(stub.url);
    const t0 = Date.now();
    const res = await host.evalSnippet('await connect(); "connected"');
    expect(res.ok).toBe(true);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(REATTACH_STATE_WAIT_MS - 50);
    expect(elapsed).toBeLessThan(REATTACH_STATE_WAIT_MS + 2_000);
  }, 15_000);

  test("a state frame without replay (a module from before it) does not hold connect() for the replay's wait", async () => {
    const stub = startModuleStub({ first: [sessionState(9, {})], later: [sessionState(9, {})] });
    const host = makeHost(stub.url);
    const t0 = Date.now();
    const state = await readState(host, "await connect();");
    expect(state["level"]).toBe(9);
    expect(Date.now() - t0).toBeLessThan(REATTACH_REPLAY_WAIT_MS);
  }, 15_000);
});
