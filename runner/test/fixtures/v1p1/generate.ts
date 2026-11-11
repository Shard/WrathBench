/**
 * Generate `v1p1-solo`: one run recorded by the phase-1 v1 runner, when a v1
 * run still had both halves of its game-side record. The stack's recorders
 * wrote `session/` (trace, events, calls) and the loop's sampler wrote
 * run.sqlite's `state` rows and the trajectory's `milestone` records, both off
 * the same SDK state cache. That overlap is what the scorer's move onto the
 * record is checked against (`runner/test/record-equivalence.test.ts`), and it
 * cannot be produced again once the sampler's writers are gone, so the output
 * is frozen and this script is kept only to say how it was made.
 *
 * Run once, at WrathBench e9f6f26c (wrath-mcp 149fb163):
 *
 *     bun runner/test/fixtures/v1p1/generate.ts
 *
 * Everything runs in one process on a fake clock: a real `StateCache` fed
 * hand-written frames, the stack's `TraceRecorder` and `EventsRecorder` over
 * it drained into the stack's `SessionWriter` every five seconds, and the
 * real `ContextBuilder` sampling a snapshot of the same cache every second
 * (it writes a row every `stateIntervalMs`, 60 s) into the real `Trajectory`.
 * Twenty minutes of play: kills, loot, a new item, an equip, three turn-ins,
 * two level-ups, zone and area changes, a learned spell, an achievement, and a
 * sandbox restart (a new cache and new recorders, the character logging in
 * again) at eleven minutes. Every name and id is invented.
 */

import { Database } from "bun:sqlite";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EventStream, StateCache } from "@wrathbench/sdk";
import { Scratchpad } from "@wrathbench/mcp";
import { toJsonSafe } from "@wrathbench/mcp/jsonsafe";
import { SessionWriter } from "@wrathbench/mcp/record";
import { EventsRecorder, TraceRecorder } from "@wrathbench/mcp/record/recorder";
import { loadRunConfig } from "../../../src/config";
import { ContextBuilder } from "../../../src/loop";
import type { SandboxHost } from "../../../src/sandbox/host";
import { sessionDirOf } from "../../../src/session-record";
import { Trajectory } from "../../../src/trajectory";
import { Watchdogs } from "../../../src/watchdogs";

const RUN = "v1p1-solo";
const OUT = join(import.meta.dir, RUN);
const WORK = join(import.meta.dir, `.${RUN}-work`);
/** A window start: 1_762_000_200_000 is a multiple of 300 000. */
const T0 = 1_762_000_200_000;
const SELF = "7";
const HI = 0x4000_0000;
const itemGuid = (lo: number): string => ((BigInt(HI) << 32n) | BigInt(lo)).toString(10);
const ITEMS = { mace: 61101, pouch: 61102, stone: 61103, cloth: 61104, sword: 61105 } as const;

rmSync(WORK, { recursive: true, force: true });
rmSync(OUT, { recursive: true, force: true });
const runDir = join(WORK, RUN);
mkdirSync(runDir, { recursive: true });

const clock = { t: T0 };
const now = (): number => clock.t;

// ------------------------------------------------------------- the host side

const config = { ...loadRunConfig({ driver: "stub", stateIntervalMs: 60_000, character: "Testwick" }), runId: RUN, token: "fixture-token" };
const trajectory = new Trajectory(runDir, { now });
await trajectory.writeMeta({ runId: RUN, harnessVersion: "0.6-1", sdkVersion: "0.0.0-fixture", startedAt: T0, config });
const writer = new SessionWriter({ dir: sessionDirOf(runDir), id: "f1c7a5e5e5510001", stack: { version: "0.0.0-fixture", commit: "149fb163" }, now, log: () => {} });
writer.open();

// ------------------------------------------------------------ the child side

interface Child {
  cache: StateCache;
  events: EventStream;
  trace: TraceRecorder;
  rec: EventsRecorder;
}
let seq = 1;
function newChild(): Child {
  const events = new EventStream({ url: "ws://worldserver:8086/events", token: "t", reconnect: false });
  const cache = new StateCache({ seed: { guid: SELF, name: "Testwick" } });
  events.onAny((e) => {
    if ("schemaError" in e && e.schemaError !== undefined) throw new Error(`fixture frame ${e.opcode} fails the SDK schema: ${e.schemaError}`);
    cache.apply(e);
  });
  const trace = new TraceRecorder({ state: cache, events, now, pollMs: 1_000 });
  const rec = new EventsRecorder({ state: cache, events, now, pollMs: 1_000 });
  rec.start();
  trace.start();
  return { cache, events, trace, rec };
}
let child = newChild();
let restarts = 0;

const feed = (opcode: string, opcodeId: number, data: unknown): void => {
  child.events.ingest(JSON.stringify({ seq: seq++, opcode, opcodeId, ts: clock.t, data }));
};
const update = (objects: unknown[]): void => feed("SMSG_UPDATE_OBJECT", 0xa9, { blocks: objects.length, objects });
const values = (guid: string, fields: Record<string, number>): void => update([{ update: "values", guid, fields }]);
const create = (guid: string, objectType: string, fields: Record<string, number>, self = false) => ({ update: "create", guid, objectType, ...(self ? { self: true } : {}), fields });

/** What the character is, carried across the restart so the re-login states it again. */
const me = {
  level: 5,
  xp: 300,
  nextLevelXp: 2800,
  money: 1000,
  health: 120,
  maxHealth: 120,
  map: 0,
  x: -9000,
  y: -100,
  z: 80,
  zone: 12,
  area: 87,
  weapon: ITEMS.mace as number,
  slot24: 0 as number,
  spells: [90001, 90002],
  achievements: [{ achievementId: 9501, date: 0, points: 10 }],
};

function login(): void {
  feed("SMSG_LOGIN_VERIFY_WORLD", 0x236, { map: me.map, x: me.x, y: me.y, z: me.z, o: 1.0 });
  update([
    create(
      SELF,
      "player",
      {
        level: me.level,
        xp: me.xp,
        nextLevelXp: me.nextLevelXp,
        money: me.money,
        health: me.health,
        maxHealth: me.maxHealth,
        powerType: 1,
        power2: 0,
        maxPower2: 1000,
        race: 1,
        class: 1,
        invSlot16Lo: 1,
        invSlot16Hi: HI,
        invSlot19Lo: 2,
        invSlot19Hi: HI,
        invSlot23Lo: 3,
        invSlot23Hi: HI,
        ...(me.slot24 !== 0 ? { invSlot24Lo: 4, invSlot24Hi: HI } : {}),
      },
      true,
    ),
    create(itemGuid(1), "item", { entry: me.weapon, stackCount: 1 }),
    create(itemGuid(2), "container", { entry: ITEMS.pouch, numSlots: 6, bagSlot0Lo: 5, bagSlot0Hi: HI }),
    create(itemGuid(3), "item", { entry: ITEMS.stone, stackCount: 1 }),
    create(itemGuid(5), "item", { entry: ITEMS.cloth, stackCount: 3 }),
    ...(me.slot24 !== 0 ? [create(itemGuid(4), "item", { entry: me.slot24, stackCount: 1 })] : []),
  ]);
  feed("WB_AREA", 0xff07, { mapId: me.map, zoneId: me.zone, zoneName: "", areaId: me.area, areaName: "", instanceType: 0 });
  feed("SMSG_INITIAL_SPELLS", 0x12a, { spells: me.spells.map((spellId) => ({ spellId })), cooldowns: [] });
  feed("SMSG_ALL_ACHIEVEMENT_DATA", 0x47d, { count: me.achievements.length, achievements: me.achievements });
  const names: [number, string, number][] = [
    [ITEMS.mace, "Testing Mace", 1],
    [ITEMS.pouch, "Testing Pouch", 1],
    [ITEMS.stone, "Testing Stone", 1],
    [ITEMS.cloth, "Testing Cloth", 1],
    [ITEMS.sword, "Testing Sword", 2],
  ];
  for (const [itemId, name, quality] of names) feed("SMSG_ITEM_QUERY_SINGLE_RESPONSE", 0x58, { itemId, found: true, name, quality });
}

const sandbox = {
  evalSnippet: () => Promise.resolve({ ok: true, value: "", logs: [], durationMs: 1 }),
  recentEvents: () => Promise.resolve([]),
  // What the child answers: the cache's snapshot cut as the child cuts it, and the `bag()` the HUD adds.
  stateSnapshot: () => {
    const snap = toJsonSafe(child.cache.snapshot(), 6) as Record<string, unknown>;
    snap["bag"] = toJsonSafe(child.cache.bag(), 4);
    return Promise.resolve(snap);
  },
  get totalRestarts() {
    return restarts;
  },
  consecutiveRestarts: 0,
  drainNotices: () => [],
  stop: () => Promise.resolve(),
} as unknown as SandboxHost;

const builder = new ContextBuilder({
  config,
  sandbox,
  scratchpad: new Scratchpad(join(runDir, "scratchpad.md")),
  trajectory,
  watchdogs: new Watchdogs(config.watchdogs),
  now,
});

// ------------------------------------------------------------------ the play

let lastDrain = T0;
function drain(): void {
  const t = child.trace.drain();
  const e = child.rec.drain();
  writer.ingest({
    trace: { rows: t.rows, dropped: t.dropped, ...(t.dict !== undefined ? { dict: t.dict } : {}) },
    events: e,
    nearby: { rows: [], dropped: 0, through: clock.t },
    moves: [],
    character: { guid: SELF, name: "Testwick", race: 1, class: 1 },
    stream: { connected: true, events: child.cache.eventCount, seq: child.cache.lastSeq },
  });
  lastDrain = clock.t;
}

let turn = 0;
async function tick(): Promise<void> {
  child.trace.poll();
  child.rec.poll();
  if (clock.t - lastDrain >= 5_000) drain();
  await builder.sampleState();
}

async function turnAt(): Promise<void> {
  turn++;
  builder.noteTurn(turn);
  trajectory.append({ t: "request", turn, messages: [{ role: "user", content: `turn ${turn}` }] });
  trajectory.append({ t: "response", turn, message: { role: "assistant", content: "ok" }, usage: { prompt_tokens: 100, completion_tokens: 10 } });
}

const step = (dx: number): void => {
  me.x += dx;
  me.y += dx / 3;
  feed("WB_MOVE_PROGRESS", 0xff02, { moveId: 1, pos: { x: me.x, y: me.y, z: me.z, o: 1.0 } });
};

login();
for (let s = 0; s <= 1200; s++) {
  clock.t = T0 + s * 1000 + 250;
  if (s % 90 === 5) await turnAt();
  if (s > 0 && s % 3 === 0) step(4);
  // A kill every twenty seconds: experience, some health lost and regained.
  if (s > 0 && s % 20 === 0) {
    me.xp += 45;
    values(SELF, { xp: me.xp, health: me.maxHealth - 30 });
  }
  if (s % 20 === 8) values(SELF, { health: me.maxHealth });
  // Loot: money, and at 95 s a new stack into the backpack's second slot.
  if (s % 50 === 25) {
    me.money += 37;
    values(SELF, { money: me.money });
  }
  if (s === 95) {
    me.slot24 = ITEMS.sword;
    update([create(itemGuid(4), "item", { entry: ITEMS.sword, stackCount: 1 })]);
    values(SELF, { invSlot24Lo: 4, invSlot24Hi: HI });
  }
  // Turn-ins at 200 s, 480 s and (after the restart) 720 s.
  if (s === 200 || s === 480 || s === 720) {
    const questId = s === 200 ? 101 : s === 480 ? 102 : 103;
    feed("SMSG_QUESTGIVER_QUEST_COMPLETE", 0x191, { questId, xp: 250, money: 150 });
    me.xp += 250;
    me.money += 150;
    values(SELF, { xp: me.xp, money: me.money });
  }
  // Level-ups at 330 s and 900 s: the bar resets, the denominator grows.
  if (s === 330 || s === 900) {
    me.xp = me.xp - me.nextLevelXp + 600;
    if (me.xp < 0) me.xp = 120;
    me.level++;
    me.nextLevelXp += 500;
    me.maxHealth += 15;
    values(SELF, { level: me.level, xp: me.xp, nextLevelXp: me.nextLevelXp, maxHealth: me.maxHealth, health: me.maxHealth });
  }
  if (s === 340) {
    me.spells.push(90003);
    feed("SMSG_LEARNED_SPELL", 0x12b, { spellId: 90003 });
  }
  if (s === 345) {
    me.achievements.push({ achievementId: 9502, date: 0, points: 10 });
    feed("SMSG_ACHIEVEMENT_EARNED", 0x468, { guid: SELF, self: true, achievement: { achievementId: 9502, date: 0, name: "Invented Feat", points: 10, categoryId: 92 } });
  }
  // Areas and a zone.
  if (s === 400) {
    me.area = 88;
    feed("WB_AREA", 0xff07, { mapId: me.map, zoneId: me.zone, zoneName: "", areaId: me.area, areaName: "", instanceType: 0 });
  }
  if (s === 600) {
    me.zone = 40;
    me.area = 120;
    feed("WB_AREA", 0xff07, { mapId: me.map, zoneId: me.zone, zoneName: "", areaId: me.area, areaName: "", instanceType: 0 });
  }
  // Equip the sword: the mace goes to the backpack's second slot.
  if (s === 540) {
    me.weapon = ITEMS.sword;
    me.slot24 = ITEMS.mace;
    update([create(itemGuid(1), "item", { entry: ITEMS.sword, stackCount: 1 }), create(itemGuid(4), "item", { entry: ITEMS.mace, stackCount: 1 })]);
    values(SELF, { invSlot16Lo: 1, invSlot16Hi: HI, invSlot24Lo: 4, invSlot24Hi: HI });
  }
  // The sandbox restarts at 660 s: what the old child latched is drained, a new
  // cache and new recorders start, and the character logs in again.
  if (s === 660) {
    drain();
    child.trace.stop();
    child.rec.stop();
    restarts++;
    child = newChild();
    clock.t += 500;
    login();
  }
  await tick();
}
drain();
child.trace.stop();
child.rec.stop();
clock.t += 1000;
await trajectory.setTermination(RUN, "episode-limit", "fixture");
await trajectory.finish();
await writer.close();

// ----------------------------------------------------------------- freeze it

mkdirSync(OUT, { recursive: true });
for (const f of ["meta.json", "trajectory.jsonl", "session"]) cpSync(join(runDir, f), join(OUT, f), { recursive: true });
// run.sqlite as text: its schema, then every row of `run` and `state` in rowid order.
const db = new Database(join(runDir, "run.sqlite"), { readonly: true });
const lines: string[] = [];
for (const r of db.query(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name IN ('run', 'state') ORDER BY name`).all() as { sql: string }[]) lines.push(`${r.sql};`);
const lit = (v: unknown): string => (v === null ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replaceAll("'", "''")}'`);
for (const table of ["run", "state"]) {
  for (const row of db.query(`SELECT * FROM ${table} ORDER BY rowid`).all() as Record<string, unknown>[]) {
    lines.push(`INSERT INTO ${table} (${Object.keys(row).join(", ")}) VALUES (${Object.values(row).map(lit).join(", ")});`);
  }
}
db.close();
writeFileSync(join(OUT, "run.sql"), `${lines.join("\n")}\n`);
rmSync(WORK, { recursive: true, force: true });
console.log(`wrote ${OUT}`);
