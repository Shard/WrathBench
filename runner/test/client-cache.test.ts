/**
 * The client cache survives a sandbox restart the way a client's on-disk cache
 * does (operator decision, 2026-10-18; `mcp/src/sandbox/client-cache.ts`).
 *
 * The bug it closes: a restart reattaches to the module session its
 * predecessor left, the module's "already queried" sets survive the reattach,
 * and so the module never asks for those entries again — a fresh child had no
 * name for anything the session had already been told about. These tests run
 * the real sandbox child against a fake event stream (frames hand-written from
 * module/PROTOCOL.md's tables, names invented, nothing captured from a running
 * game), kill it the two ways `host.ts` loses a child, and read the restarted
 * child's cache before any new answer reaches it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StateCache } from "@wrathbench/sdk";
import { assertRunDirFree } from "../src/run";
import { CLIENT_CACHE_FILE, ClientCacheStore, keepsAnswer, reparseFrame } from "@wrathbench/mcp";
import { SandboxHost, type HarnessNotice } from "../src/sandbox/host";
import { Scratchpad } from "@wrathbench/mcp";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();
const hosts: SandboxHost[] = [];

function makeHost(runDir: string, opts: { store?: ClientCacheStore | null; notices?: HarnessNotice[] } = {}): SandboxHost {
  mkdirSync(runDir, { recursive: true });
  const store = opts.store === null ? undefined : (opts.store ?? new ClientCacheStore(join(runDir, CLIENT_CACHE_FILE)));
  const host = new SandboxHost({
    moduleUrl: "http://worldserver:8086",
    token: "test-token",
    scratchpad: new Scratchpad(join(runDir, "scratchpad.md")),
    snippetTimeoutMs: 400,
    pingGraceMs: 300,
    ...(store !== undefined ? { clientCache: store } : {}),
    ...(opts.notices !== undefined ? { onNotice: (n: HarnessNotice) => opts.notices!.push(n) } : {}),
  });
  hosts.push(host);
  return host;
}

afterEach(async () => {
  await Promise.all(hosts.splice(0, hosts.length).map((h) => h.stop()));
});

const FEED = `
globalThis.seq ??= 1;
globalThis.feed = (opcode, opcodeId, data) => {
  events.ingest(JSON.stringify({ seq: seq++, opcode, opcodeId, ts: 1000 + seq, data }));
};
`;

/**
 * One answer of each of the eight kinds the SDK caches, then a "not found" for
 * the creature already answered — which the SDK ignores, and which must not
 * erase the answer from the kept cache either.
 */
const ANSWERS = `${FEED}
feed("SMSG_NAME_QUERY_RESPONSE", 0x051, { guid: "42", found: true, name: "Brannoc" });
feed("SMSG_CREATURE_QUERY_RESPONSE", 0x061, { entry: 299, found: true, name: "Invented Wolf", subname: "", type: 1, rank: 0 });
feed("SMSG_GAMEOBJECT_QUERY_RESPONSE", 0x05f, { entry: 1731, found: true, name: "Invented Vein", type: 3, displayId: 310 });
feed("SMSG_ITEM_QUERY_SINGLE_RESPONSE", 0x058, { itemId: 750, found: true, name: "Invented Meat", quality: 1 });
feed("SMSG_QUEST_QUERY_RESPONSE", 0x05d, { questId: 33, title: "Invented Errand", requiredNpcOrGo: [{ entry: 299, count: 8 }], requiredItems: [] });
feed("SMSG_PET_NAME_QUERY_RESPONSE", 0x053, { petNumber: 5, found: true, name: "Invented Fang" });
feed("SMSG_PAGE_TEXT_QUERY_RESPONSE", 0x05b, { pageId: 9, text: "Invented page", nextPageId: 0 });
feed("SMSG_ITEM_TEXT_QUERY_RESPONSE", 0x244, { found: true, guid: "900", text: "Invented letter" });
feed("SMSG_CREATURE_QUERY_RESPONSE", 0x061, { entry: 299, found: false });
"answered";
`;

/** Every cached answer, read off the SDK cache the way a snippet can, private maps included. */
const READ_CACHE = `JSON.stringify({
  player: state.nameOf("42") ?? null,
  creature: state.creatures.get(299)?.value.name ?? null,
  creatureSeq: state.creatures.get(299)?.seq ?? null,
  object: state.gameObjects.get(1731)?.value.name ?? null,
  item: state.items.get(750)?.value.name ?? null,
  quest: state.quests.get(33)?.value.title ?? null,
  pet: state["petNames"].get(5) ?? null,
  page: state["pageTexts"].get(9)?.text ?? null,
  letter: state["playerTexts"].get("900") ?? null,
  eventCount: state.eventCount,
  lastSeq: state.lastSeq,
  lastTs: state.lastTs,
  recent: events.recent().length,
})`;

const ALL_NAMED = {
  player: "Brannoc",
  creature: "Invented Wolf",
  creatureSeq: 2,
  object: "Invented Vein",
  item: "Invented Meat",
  quest: "Invented Errand",
  pet: "Invented Fang",
  page: "Invented page",
  letter: "Invented letter",
};

const NONE_NAMED = {
  player: null,
  creature: null,
  creatureSeq: null,
  object: null,
  item: null,
  quest: null,
  pet: null,
  page: null,
  letter: null,
};

/** What a child that has folded no event reports for the stream counters the HUD prints. */
const UNTOUCHED_COUNTERS = { eventCount: 0, lastSeq: -1, lastTs: 0, recent: 0 };

async function readCache(host: SandboxHost): Promise<Record<string, unknown>> {
  const res = await host.evalSnippet(READ_CACHE);
  expect(res.ok).toBe(true);
  return JSON.parse(JSON.parse(res.value!) as string) as Record<string, unknown>;
}

/** The reattach a restarted child would see: the session state, then units in view created again by guid. */
const REVIEW = `${FEED}
feed("WB_SESSION_STATE", 0xff03, {
  character: "Fenwick", guid: "7", inWorld: true,
  map: 0, x: -6572, y: 405, z: 387, o: 1.7, level: 7,
  zoneId: 1, zoneName: "", areaId: 132, areaName: "",
});
feed("SMSG_UPDATE_OBJECT", 0xa9, { blocks: 3, objects: [
  { update: "create", guid: "101", objectType: "unit", pos: { x: -6560, y: 405, z: 387, o: 0 }, fields: { entry: 299, health: 120, maxHealth: 120, level: 6 } },
  { update: "create", guid: "42", objectType: "player", pos: { x: -6565, y: 405, z: 387, o: 0 }, fields: { health: 300, maxHealth: 300, level: 9 } },
  { update: "create", guid: "102", objectType: "gameObject", pos: { x: -6570, y: 410, z: 387, o: 0 }, fields: { entry: 1731 } },
] });
return JSON.stringify(Object.fromEntries(state.units().map((u) => [u.guid, u.name ?? null])));
`;

describe("the client cache across a sandbox restart", () => {
  test("a child killed for blocking its event loop comes back with every name it was given, before any new answer", async () => {
    const dir = tempDir("wrathbench-client-cache-");
    const notices: HarnessNotice[] = [];
    const store = new ClientCacheStore(join(dir, CLIENT_CACHE_FILE));
    const host = makeHost(dir, { store, notices });

    expect((await host.evalSnippet(ANSWERS)).ok).toBe(true);
    expect(await readCache(host)).toMatchObject(ALL_NAMED);
    // Forwarded as they arrived: the eval's result trails them on the same channel.
    expect(store.size).toBe(8);

    const blocked = await host.evalSnippet("for (;;) {}");
    expect(blocked.restarted).toBe(true);
    expect(host.totalRestarts).toBe(1);
    // The notice the model reads is the one it always read.
    const restart = notices.find((n) => n.kind === "sandbox_restarted");
    expect(restart?.text).toContain("All top-level bindings and routines were lost;");

    // The first thing the new child is asked, with no event fed to it.
    const after = await readCache(host);
    expect(after).toEqual({ ...ALL_NAMED, ...UNTOUCHED_COUNTERS });

    // The units the module will not ask about again are named on sight.
    const review = await host.evalSnippet(REVIEW);
    expect(JSON.parse(JSON.parse(review.value!) as string)).toEqual({
      "101": "Invented Wolf",
      "42": "Brannoc",
      "102": "Invented Vein",
    });
  }, 20_000);

  test("a child that exits on its own is seeded on the lazy respawn", async () => {
    const dir = tempDir("wrathbench-client-cache-");
    const host = makeHost(dir);
    expect((await host.evalSnippet(ANSWERS)).ok).toBe(true);
    const crashed = await host.evalSnippet("process.exit(1)");
    expect(crashed.restarted).toBe(true);
    expect(await readCache(host)).toEqual({ ...ALL_NAMED, ...UNTOUCHED_COUNTERS });
  }, 20_000);

  test("the seed is invisible to the stream: the HUD's counters and the turn's event window are an unseeded child's", async () => {
    const seededDir = tempDir("wrathbench-client-cache-");
    const seeding = makeHost(seededDir);
    expect((await seeding.evalSnippet(ANSWERS)).ok).toBe(true);
    await seeding.stop();

    const seeded = makeHost(seededDir);
    const bare = makeHost(tempDir("wrathbench-client-cache-"), { store: null });
    const [a, b] = [await seeded.stateSnapshot(), await bare.stateSnapshot()];
    expect(a["eventCount"]).toBe(b["eventCount"]);
    expect(a["lastSeq"]).toBe(b["lastSeq"]);
    expect(a["units"]).toEqual(b["units"]);
    expect(await seeded.contextEvents(50)).toEqual(await bare.contextEvents(50));
    expect(await seeded.recentEvents(50)).toEqual([]);
    // And the cache is seeded all the same.
    expect(await readCache(seeded)).toMatchObject(ALL_NAMED);
  }, 20_000);

  test("an eval sent while another caller is still starting the child waits for the seed", async () => {
    const dir = tempDir("wrathbench-client-cache-");
    const seeding = makeHost(dir);
    expect((await seeding.evalSnippet(ANSWERS)).ok).toBe(true);
    await seeding.stop();

    // A cold host: the state read spawns the child and waits for ready; the
    // eval behind it must not reach the child ahead of the seed, or its body
    // (no await in it) reads the cache before the seed is folded.
    const cold = makeHost(dir);
    const [, res] = await Promise.all([cold.stateSnapshot(), cold.evalSnippet(READ_CACHE)]);
    expect(res.ok).toBe(true);
    expect(JSON.parse(JSON.parse(res.value!) as string)).toMatchObject(ALL_NAMED);
  }, 20_000);

  test("without a kept cache a restarted child has none of them — the bug this closes", async () => {
    const host = makeHost(tempDir("wrathbench-client-cache-"), { store: null });
    expect((await host.evalSnippet(ANSWERS)).ok).toBe(true);
    expect((await host.evalSnippet("for (;;) {}")).restarted).toBe(true);
    expect(await readCache(host)).toEqual({ ...NONE_NAMED, ...UNTOUCHED_COUNTERS });
  }, 20_000);
});

describe("the client cache across a resume, and what never inherits it", () => {
  test("a resumed run — a new process on the same run directory — is seeded from the file", async () => {
    const dir = tempDir("wrathbench-client-cache-");
    const first = makeHost(dir);
    expect((await first.evalSnippet(ANSWERS)).ok).toBe(true);
    await first.stop();
    const path = join(dir, CLIENT_CACHE_FILE);
    expect(existsSync(path)).toBe(true);
    expect(existsSync(`${path}.tmp`)).toBe(false);

    // The resume's own store, read from disk, and its own host.
    const resumed = makeHost(dir, { store: new ClientCacheStore(path) });
    expect(await readCache(resumed)).toEqual({ ...ALL_NAMED, ...UNTOUCHED_COUNTERS });
  }, 20_000);

  test("a fresh run and a different character's run start empty, and the cached run's file is left alone", async () => {
    // Fenwick's run has a populated cache.
    const runsDir = tempDir("wrathbench-client-cache-runs-");
    const fenwick = join(runsDir, "run-fenwick");
    const first = makeHost(fenwick);
    expect((await first.evalSnippet(ANSWERS)).ok).toBe(true);
    await first.stop();
    const before = readFileSync(join(fenwick, CLIENT_CACHE_FILE), "utf8");

    // A fresh scored run, and another character on the same account (a run
    // of its own, as a continuation is too): each has its own directory.
    for (const id of ["run-fresh-e90", "run-brannoc"]) {
      const host = makeHost(join(runsDir, id));
      expect(await readCache(host)).toEqual({ ...NONE_NAMED, ...UNTOUCHED_COUNTERS });
      await host.stop();
      expect(existsSync(join(runsDir, id, CLIENT_CACHE_FILE))).toBe(false);
    }
    expect(readFileSync(join(fenwick, CLIENT_CACHE_FILE), "utf8")).toBe(before);
  }, 20_000);

  test("a fresh launch can never land on a directory that holds a cache", () => {
    const runsDir = tempDir("wrathbench-client-cache-runs-");
    const dir = join(runsDir, "run-x");
    const store = new ClientCacheStore(join(dir, CLIENT_CACHE_FILE));
    expect(() => assertRunDirFree(runsDir, "run-x")).not.toThrow();
    mkdirSync(dir, { recursive: true });
    store.add([{ seq: 1, opcode: "SMSG_NAME_QUERY_RESPONSE", opcodeId: 0x51, ts: 1, data: { guid: "42", found: true, name: "Brannoc" } }]);
    store.flush();
    expect(() => assertRunDirFree(runsDir, "run-x")).toThrow(/already on disk/);
  });
});

describe("ClientCacheStore", () => {
  const name = (guid: string, found: boolean, n?: string): unknown => ({
    seq: 3,
    opcode: "SMSG_NAME_QUERY_RESPONSE",
    opcodeId: 0x51,
    ts: 2000,
    data: { guid, found, ...(n !== undefined ? { name: n } : {}) },
  });

  test("keeps the newest answer per id, never a not-found, and nothing outside the eight answers", () => {
    const dir = tempDir("wrathbench-client-cache-");
    const store = new ClientCacheStore(join(dir, CLIENT_CACHE_FILE), { debounceMs: 60_000 });
    store.add([
      name("42", true, "Brannoc"),
      name("42", true, "Brannoc the Second"),
      name("42", false),
      name("43", false),
      { seq: 4, opcode: "SMSG_MESSAGECHAT", opcodeId: 0x96, ts: 1, data: { text: "hi" } },
      { seq: 5, opcode: "SMSG_CREATURE_QUERY_RESPONSE", opcodeId: 0x61, ts: 1, data: { decodeError: true } },
      // Fails the creature schema (no entry): a live frame like it would carry a schemaError and not fold.
      { seq: 6, opcode: "SMSG_CREATURE_QUERY_RESPONSE", opcodeId: 0x61, ts: 1, data: { found: true, name: "Nobody" } },
      null,
      "junk",
    ]);
    expect(store.snapshot().map((f) => (f.data as { name?: string }).name)).toEqual(["Brannoc the Second"]);
  });

  test("writes on change, debounced, through a temp file and a rename; reloads what it wrote", async () => {
    const dir = tempDir("wrathbench-client-cache-");
    const path = join(dir, CLIENT_CACHE_FILE);
    const store = new ClientCacheStore(path, { debounceMs: 30 });
    store.add([name("42", true, "Brannoc")]);
    expect(existsSync(path)).toBe(false);
    await Bun.sleep(120);
    expect(existsSync(path)).toBe(true);
    expect(existsSync(`${path}.tmp`)).toBe(false);
    const doc = JSON.parse(readFileSync(path, "utf8")) as { v: number; frames: unknown[] };
    expect(doc.v).toBe(1);
    expect(doc.frames).toHaveLength(1);
    expect(new ClientCacheStore(path).snapshot()).toEqual(store.snapshot());
  });

  test("an unreadable or foreign file starts empty and says so; a frame that no longer parses is dropped", () => {
    const dir = tempDir("wrathbench-client-cache-");
    const path = join(dir, CLIENT_CACHE_FILE);
    const lines: string[] = [];
    writeFileSync(path, "{ not json");
    expect(new ClientCacheStore(path, { log: (l) => lines.push(l) }).size).toBe(0);
    writeFileSync(path, JSON.stringify({ v: 99, frames: [name("42", true, "Brannoc")] }));
    expect(new ClientCacheStore(path, { log: (l) => lines.push(l) }).size).toBe(0);
    expect(lines).toHaveLength(2);
    writeFileSync(
      path,
      JSON.stringify({
        v: 1,
        frames: [name("42", true, "Brannoc"), { seq: 1, opcode: "SMSG_QUEST_QUERY_RESPONSE", opcodeId: 0x5d, ts: 1, data: { questId: 1 } }],
      }),
    );
    expect(new ClientCacheStore(path).size).toBe(1);
  });

  test("a seed frame folds into a StateCache exactly as the live frame did", () => {
    const frame = reparseFrame({
      seq: 12,
      opcode: "SMSG_CREATURE_QUERY_RESPONSE",
      opcodeId: 0x61,
      ts: 5000,
      data: { entry: 299, found: true, name: "Invented Wolf", subname: "", type: 1, rank: 0 },
    });
    expect(frame).not.toBeNull();
    expect(keepsAnswer(frame!)).toBe(true);
    const live = new StateCache();
    live.apply({ seq: 12, opcode: "SMSG_CREATURE_QUERY_RESPONSE", opcodeId: 0x61, ts: 5000, data: { entry: 299, found: true, name: "Invented Wolf", subname: "", type: 1, rank: 0 } });
    const seeded = new StateCache();
    seeded.apply(frame!);
    expect(seeded.creatures.get(299)).toEqual(live.creatures.get(299));
  });
});
