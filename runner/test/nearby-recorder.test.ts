/**
 * The nearby recorder (`sandbox/nearby-recorder.ts`): the child's watch on the
 * units around the character, latched for the live map's ring.
 *
 * Two halves, as the trace recorder's test has. The unit half drives a real
 * SDK state cache and event stream with hand-written frames
 * (`fixtures/nearby-frames.ts`) and polls the recorder by hand, through a
 * source that throws on anything but the cache and the broadcast hook — so
 * a recorder that reached for an action, a raw opcode or a consuming queue
 * would fail here. The child half runs the real sandbox process and drains
 * through the host, so the wiring in entry.ts and host.ts is exercised too.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { NearbyMotion, NearbyRow, NearbyUnit } from "../src/nearby-row";
import { SandboxHost } from "../src/sandbox/host";
import { NearbyRecorder } from "../src/sandbox/nearby-recorder";
import { Scratchpad } from "@wrathbench/mcp";
import { SELF_GUID, guardedSource, nearbyRig, playerGuid, unitGuid } from "./fixtures/nearby-frames";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();

function rig(opts: { cap?: number } = {}) {
  const r = nearbyRig();
  let clock = 1_760_000_000_000;
  const g = guardedSource(r);
  const rec = new NearbyRecorder({ state: g.source.state, events: g.source.events, now: () => clock, pollMs: 60_000, ...(opts.cap !== undefined ? { cap: opts.cap } : {}) });
  return {
    r,
    rec,
    reads: g.reads,
    at: (t: number) => {
      clock = t;
    },
    rows: (): NearbyRow[] => rec.drain().rows,
  };
}

const T0 = 1_760_000_000_000;
const WOLF = 299;
const WOLF_A = unitGuid(WOLF, 41);
const WOLF_B = unitGuid(WOLF, 42);
const VENDOR = unitGuid(1250, 7);
const PET = unitGuid(416, 3, 0xf140);
const OTHER = playerGuid(88);

const wolfFields = { entry: WOLF, health: 120, maxHealth: 120, level: 6, unitFlags: 0, dynamicFlags: 0, npcFlags: 0, faction: 38, displayId: 903 };

function enterWorld(t: ReturnType<typeof rig>): void {
  t.r.login(0, { x: -9000, y: -100, z: 80 }, T0);
  t.r.selfFields({ health: 200, maxHealth: 200, level: 7 }, T0 + 1);
}

/** Into the world with the login's key polled and drained, so what follows is streamed. */
function settled(t: ReturnType<typeof rig>): void {
  enterWorld(t);
  t.at(T0 + 50);
  t.rec.poll();
  t.rows();
}

describe("nearby recorder: what comes into view and goes", () => {
  test("an opening key, then a creature's `in` once it can be placed, and an `out` when it leaves", () => {
    const t = rig();
    t.at(T0);
    t.rec.start();
    const opening = t.rows();
    expect(opening).toHaveLength(1);
    expect(opening[0]).toMatchObject({ ts: T0, kind: "key", units: [] });

    // Login is a rejoin: the next poll restates the scene, with the self.
    enterWorld(t);
    t.r.create(WOLF_A, "unit", { x: -8990, y: -100, z: 80, o: 1.5 }, wolfFields, T0 + 100);
    t.at(T0 + 500);
    t.rec.poll();
    let rows = t.rows();
    expect(rows.map((r) => r.kind)).toEqual(["key"]);
    const key = rows[0] as Extract<NearbyRow, { kind: "key" }>;
    expect(key.self).toEqual({ guid: SELF_GUID, map: 0, target: null, down: false });
    expect(key.units).toHaveLength(1);
    expect(key.units[0]).toMatchObject({ id: WOLF_A, ty: "creature", s: { entry: WOLF, hp: 100, level: 6, uf: 0, df: 0, nf: 0, disp: 903 } });
    expect(key.units[0]!.m).toEqual({ k: "pos", t: T0 + 100, p: [-8990, -100, 80, 1.5] });
    // The raw faction template is not carried: colour is never a DBC lookup.
    expect(JSON.stringify(key)).not.toContain("faction");

    // A second wolf arrives; the first leaves out of range.
    t.r.create(WOLF_B, "unit", { x: -8980, y: -95, z: 80 }, wolfFields, T0 + 700);
    t.r.outOfRange([WOLF_A], T0 + 800);
    t.at(T0 + 1000);
    t.rec.poll();
    rows = t.rows();
    expect(rows.map((r) => `${r.kind}:${"id" in r ? r.id : (r as { u?: NearbyUnit }).u?.id}`)).toEqual([`in:${WOLF_B}`, `out:${WOLF_A}`]);
    expect(rows.every((r) => r.ts === T0 + 1000)).toBe(true);

    // A destroy is a departure too; a game object is never a unit.
    t.r.create(unitGuid(1731, 5, 0xf110), "gameObject", { x: -8995, y: -101, z: 80 }, { entry: 1731 }, T0 + 1100);
    t.r.destroy(WOLF_B, T0 + 1200);
    t.at(T0 + 1500);
    t.rec.poll();
    expect(t.rows().map((r) => r.kind)).toEqual(["out"]);
    t.rec.stop();
    // Only the three cache reads and the broadcast hook, ever.
    expect([...t.reads].sort()).toEqual(["events.on", "state.creatures", "state.nearby", "state.self"]);
  });

  test("a unit with no position yet waits, and a values block for one never created is placed by its first movement", () => {
    const t = rig();
    t.rec.start();
    enterWorld(t);
    t.at(T0 + 500);
    t.rec.poll();
    t.rows();
    // Values for a creature whose create block this child never saw (a
    // restarted child reattaching to its session): in view, unplaceable.
    t.r.values(WOLF_A, { health: 60, maxHealth: 120 }, T0 + 600);
    t.at(T0 + 1000);
    t.rec.poll();
    expect(t.rows()).toEqual([]);
    t.r.spline(WOLF_A, { x: -8990, y: -100, z: 80 }, { x: -8970, y: -100, z: 80 }, 4000, T0 + 1100);
    t.at(T0 + 1500);
    t.rec.poll();
    const rows = t.rows();
    expect(rows).toHaveLength(1);
    // Untyped, it is still a creature by its guid, with the entry the guid packs.
    expect(rows[0]).toMatchObject({ kind: "in", u: { id: WOLF_A, ty: "creature", s: { entry: WOLF, hp: 50 } } });
  });
});

describe("nearby recorder: motion", () => {
  test("a spline is its start, end and duration at the packet's time, never the destination as a position", () => {
    const t = rig();
    t.rec.start();
    enterWorld(t);
    t.r.create(WOLF_A, "unit", { x: -8990, y: -100, z: 80 }, wolfFields, T0 + 100);
    t.at(T0 + 500);
    t.rec.poll();
    t.rows();

    t.r.spline(WOLF_A, { x: -8990, y: -100, z: 80 }, { x: -8960, y: -110, z: 81 }, 6000, T0 + 620);
    t.at(T0 + 1000);
    t.rec.poll();
    let rows = t.rows();
    expect(rows).toEqual([
      { ts: T0 + 1000, kind: "mv", id: WOLF_A, m: { k: "mv", t: T0 + 620, p: [-8990, -100, 80], to: [-8960, -110, 81], ms: 6000 } satisfies NearbyMotion },
    ]);
    // Nothing new, nothing written: the spline plays on its own clock.
    t.at(T0 + 1500);
    t.rec.poll();
    expect(t.rows()).toEqual([]);
    // A stop is a hold where it stopped.
    t.r.stop(WOLF_A, { x: -8975, y: -105, z: 80.5 }, T0 + 3600);
    t.at(T0 + 4000);
    t.rec.poll();
    rows = t.rows();
    expect(rows).toEqual([{ ts: T0 + 4000, kind: "mv", id: WOLF_A, m: { k: "mv", t: T0 + 3600, p: [-8975, -105, 80.5] } }]);
  });

  test("two splines inside one poll leave the newer, whose start is where the unit really was", () => {
    const t = rig();
    t.rec.start();
    enterWorld(t);
    t.r.create(WOLF_A, "unit", { x: 0, y: 0, z: 0 }, wolfFields, T0 + 100);
    t.at(T0 + 500);
    t.rec.poll();
    t.rows();
    t.r.spline(WOLF_A, { x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, 2000, T0 + 600);
    t.r.spline(WOLF_A, { x: 1, y: 0, z: 0 }, { x: 1, y: 10, z: 0 }, 2000, T0 + 800);
    t.at(T0 + 1000);
    t.rec.poll();
    const rows = t.rows();
    expect(rows).toHaveLength(1);
    expect((rows[0] as { m: NearbyMotion }).m).toMatchObject({ t: T0 + 800, p: [1, 0, 0], to: [1, 10, 0] });
  });

  test("another player's heartbeats are position samples, one per poll at most", () => {
    const t = rig();
    t.rec.start();
    settled(t);
    t.r.create(OTHER, "player", { x: 5, y: 5, z: 0, o: 0 }, { health: 300, maxHealth: 300, level: 9, race: 1, class: 2, gender: 1 }, T0 + 100);
    t.r.playerName(OTHER, "Wanderer", T0 + 150);
    t.at(T0 + 500);
    t.rec.poll();
    const entered = t.rows();
    expect(entered[0]).toMatchObject({ kind: "in", u: { id: OTHER, ty: "player", s: { name: "Wanderer", race: 1, cls: 2, gender: 1, level: 9 } } });
    t.r.heartbeat(OTHER, { x: 6, y: 5, z: 0, o: 0.1 }, T0 + 600);
    t.r.heartbeat(OTHER, { x: 7, y: 5, z: 0, o: 0.1 }, T0 + 900);
    t.at(T0 + 1000);
    t.rec.poll();
    const rows = t.rows();
    expect(rows.map((r) => r.kind)).toEqual(["pos", "st"]);
    expect((rows[0] as { m: NearbyMotion }).m).toEqual({ k: "pos", t: T0 + 900, p: [7, 5, 0, 0.1] });
    // The relayed movement flags ride along as state, for a 3D reader.
    expect(rows[1]).toMatchObject({ kind: "st", id: OTHER, s: { mf: 1 } });
  });
});

describe("nearby recorder: state and names", () => {
  test("only the keys that changed, a name that lands late, and the questgiver marker", () => {
    const t = rig();
    t.rec.start();
    settled(t);
    t.r.create(VENDOR, "unit", { x: 1, y: 1, z: 0 }, { entry: 1250, health: 500, maxHealth: 500, level: 30, npcFlags: 0x80 }, T0 + 100);
    t.at(T0 + 500);
    t.rec.poll();
    const entered = t.rows()[0] as Extract<NearbyRow, { kind: "in" }>;
    expect(entered.u.s.name).toBeUndefined();
    expect(entered.u.s.nf).toBe(0x80);

    t.r.creatureName(1250, "Brother Invented", "Weapon Merchant", 7, T0 + 600);
    t.r.questMarker(VENDOR, 8, T0 + 650);
    t.at(T0 + 1000);
    t.rec.poll();
    let rows = t.rows();
    expect(rows).toEqual([
      { ts: T0 + 1000, kind: "nm", id: VENDOR, name: "Brother Invented", sub: "Weapon Merchant" },
      { ts: T0 + 1000, kind: "st", id: VENDOR, s: { ctype: 7, qg: 8 } },
    ]);

    // Health as a client shows another unit's: a percentage.
    t.r.values(VENDOR, { health: 125 }, T0 + 1100);
    t.at(T0 + 1500);
    t.rec.poll();
    rows = t.rows();
    expect(rows).toEqual([{ ts: T0 + 1500, kind: "st", id: VENDOR, s: { hp: 25 } }]);
  });

  test("a unit that targets the character says so, and the character's own target is a self row", () => {
    const t = rig();
    t.rec.start();
    enterWorld(t);
    t.r.create(WOLF_A, "unit", { x: 1, y: 1, z: 0 }, wolfFields, T0 + 100);
    t.at(T0 + 500);
    t.rec.poll();
    t.rows();
    t.r.values(WOLF_A, { targetGuid: SELF_GUID, unitFlags: 0x80000 }, T0 + 600);
    t.r.selfFields({ targetGuid: WOLF_A }, T0 + 610);
    t.at(T0 + 1000);
    t.rec.poll();
    const rows = t.rows();
    expect(rows).toEqual([
      { ts: T0 + 1000, kind: "self", self: { target: WOLF_A } },
      { ts: T0 + 1000, kind: "st", id: WOLF_A, s: { uf: 0x80000, tg: SELF_GUID, tgs: true } },
    ]);
    // The wolf dies: health 0 and the dead dynamic flag; the character drops its target.
    t.r.values(WOLF_A, { health: 0, dynamicFlags: 0x21, targetGuid: "0" }, T0 + 1100);
    t.r.selfFields({ targetGuid: "0" }, T0 + 1110);
    t.at(T0 + 1500);
    t.rec.poll();
    expect(t.rows()).toEqual([
      { ts: T0 + 1500, kind: "self", self: { target: null } },
      { ts: T0 + 1500, kind: "st", id: WOLF_A, s: { hp: 0, df: 0x21, tg: null, tgs: null } },
    ]);
  });

  test("a pet carries its owner, and the character going down is a self row", () => {
    const t = rig();
    t.rec.start();
    settled(t);
    t.r.create(PET, "unit", { x: 2, y: 2, z: 0 }, { entry: 416, health: 90, maxHealth: 90, level: 7, summonedByGuid: OTHER, petNumber: 12 }, T0 + 100);
    t.at(T0 + 500);
    t.rec.poll();
    const entered = t.rows()[0] as Extract<NearbyRow, { kind: "in" }>;
    expect(entered.u).toMatchObject({ id: PET, ty: "pet", s: { entry: 416, ow: OTHER } });
    t.r.selfFields({ health: 0 }, T0 + 600);
    t.at(T0 + 1000);
    t.rec.poll();
    expect(t.rows()).toEqual([{ ts: T0 + 1000, kind: "self", self: { down: true } }]);
  });

  test("a new map is restated as a key, not streamed as departures", () => {
    const t = rig();
    t.rec.start();
    enterWorld(t);
    t.r.create(WOLF_A, "unit", { x: 1, y: 1, z: 0 }, wolfFields, T0 + 100);
    t.at(T0 + 500);
    t.rec.poll();
    t.rows();
    t.r.feed("SMSG_NEW_WORLD", 0x3e, { map: 1, x: 10, y: 10, z: 0, o: 0 }, T0 + 600);
    t.at(T0 + 1000);
    t.rec.poll();
    const rows = t.rows();
    expect(rows.map((r) => r.kind)).toEqual(["key"]);
    expect((rows[0] as Extract<NearbyRow, { kind: "key" }>).self.map).toBe(1);
    expect((rows[0] as Extract<NearbyRow, { kind: "key" }>).units).toEqual([]);
  });
});

describe("nearby recorder: the cap", () => {
  test("past the cap the oldest rows go and the drops are counted", () => {
    const t = rig({ cap: 4 });
    t.rec.start();
    enterWorld(t);
    for (let i = 0; i < 6; i++) t.r.create(unitGuid(WOLF, 100 + i), "unit", { x: i, y: 0, z: 0 }, wolfFields, T0 + 100 + i);
    t.at(T0 + 500);
    t.rec.poll();
    for (let i = 0; i < 6; i++) t.r.spline(unitGuid(WOLF, 100 + i), { x: i, y: 0, z: 0 }, { x: i, y: 9, z: 0 }, 1000, T0 + 600 + i);
    t.at(T0 + 1000);
    t.rec.poll();
    const d = t.rec.drain();
    expect(d.rows).toHaveLength(4);
    expect(d.dropped).toBeGreaterThan(0);
    expect(d.through).toBe(T0 + 1000);
    expect(t.rec.drain()).toEqual({ rows: [], dropped: 0, through: T0 + 1000 });
  });
});

describe("nearby recorder: cost", () => {
  test("a Stormwind-peak scene polls in well under a millisecond", () => {
    // ~170 objects in view, the busiest the HUD samples saw: creatures,
    // players and game objects, with splines and heartbeats every poll. The
    // bound is loose on purpose (the bench measures ~0.1 ms); it is here to
    // catch a recorder that started scanning something per unit per poll.
    const t = rig();
    t.rec.start();
    settled(t);
    const units = Array.from({ length: 110 }, (_, i) => unitGuid(68 + (i % 25), 5000 + i));
    const players = Array.from({ length: 20 }, (_, i) => playerGuid(900 + i));
    t.r.createMany(units.map((g, i) => ({ guid: g, objectType: "unit" as const, p: { x: i, y: 0, z: 0 }, fields: { entry: 68 + (i % 25), health: 10, maxHealth: 10, level: 30 } })), T0 + 60);
    t.r.createMany(players.map((g, i) => ({ guid: g, objectType: "player" as const, p: { x: i, y: 5, z: 0 }, fields: { health: 10, maxHealth: 10, level: 20 } })), T0 + 61);
    t.r.createMany(Array.from({ length: 40 }, (_, i) => ({ guid: unitGuid(1700 + i, 9000 + i, 0xf110), objectType: "gameObject" as const, p: { x: i, y: 9, z: 0 }, fields: { entry: 1700 + i } })), T0 + 62);
    const times: number[] = [];
    for (let n = 1; n <= 200; n++) {
      const at = T0 + 100 + n * 500;
      for (let k = 0; k < 9; k++) t.r.spline(units[(n * 9 + k) % units.length]!, { x: 0, y: 0, z: 0 }, { x: n % 7, y: k, z: 0 }, 2500, at - 100);
      for (let i = 0; i < 10; i++) t.r.heartbeat(players[i]!, { x: i + n * 0.5, y: 5, z: 0, o: 0 }, at - 50);
      t.at(at);
      const a = Bun.nanoseconds();
      t.rec.poll();
      times.push((Bun.nanoseconds() - a) / 1e6);
      if (n % 10 === 0) t.rows();
    }
    times.sort((a, b) => a - b);
    expect(t.r.state.nearby.size).toBe(170);
    expect(times[100]!).toBeLessThan(2);
  });
});

// ------------------------------------------------------------- the child

const hosts: SandboxHost[] = [];

function makeHost(): SandboxHost {
  const dir = tempDir("wrathbench-nearby-");
  const host = new SandboxHost({
    moduleUrl: "http://worldserver:8086",
    token: "test-token",
    scratchpad: new Scratchpad(join(dir, "scratchpad.md")),
    snippetTimeoutMs: 5_000,
    pingGraceMs: 1_000,
  });
  hosts.push(host);
  return host;
}

afterEach(async () => {
  await Promise.all(hosts.splice(0, hosts.length).map((h) => h.stop()));
});

/** Enter the world as guid "7" and put a creature beside it, through the child's own event stream. */
const PRELUDE = `
globalThis.seq = 1;
globalThis.feed = (opcode, opcodeId, data) => {
  events.ingest(JSON.stringify({ seq: seq++, opcode, opcodeId, ts: 1000 + seq, data }));
};
feed("WB_SESSION_STATE", 0xff03, {
  character: "Fenwick", guid: "7", inWorld: true,
  map: 0, x: -6572, y: 405, z: 387, o: 1.7, level: 7,
  zoneId: 1, zoneName: "", areaId: 132, areaName: "",
});
feed("SMSG_UPDATE_OBJECT", 0xa9, { blocks: 1, objects: [{ update: "create", guid: "${WOLF_A}", objectType: "unit",
  pos: { x: -6560, y: 405, z: 387, o: 0 }, fields: { entry: ${WOLF}, health: 120, maxHealth: 120, level: 6 } }] });
feed("SMSG_CREATURE_QUERY_RESPONSE", 0x61, { entry: ${WOLF}, found: true, name: "Invented Wolf", subname: "", type: 1, rank: 0 });
"fed";
`;

describe("sandbox child: nearby drained through the host", () => {
  test("no child, no drain: a host that was never started answers null and stays unstarted", async () => {
    const host = makeHost();
    expect(await host.nearbyDrain()).toBeNull();
    expect((host as unknown as { proc: unknown }).proc).toBeNull();
  });

  test("the child's opening key, the rejoin key with the unit, and the drain's horizon come home", async () => {
    const host = makeHost();
    expect((await host.evalSnippet(PRELUDE)).ok).toBe(true);
    // The recorder polls every 500 ms in the child; give it two.
    await Bun.sleep(1_100);
    const drained = await host.nearbyDrain();
    expect(drained).not.toBeNull();
    const keys = drained!.rows.filter((r): r is Extract<NearbyRow, { kind: "key" }> => r.kind === "key");
    expect(keys.length).toBeGreaterThanOrEqual(2);
    expect(keys[0]!.units).toEqual([]);
    const rejoin = keys[keys.length - 1]!;
    expect(rejoin.self).toMatchObject({ guid: "7", map: 0 });
    expect(rejoin.units).toHaveLength(1);
    expect(rejoin.units[0]).toMatchObject({ id: WOLF_A, ty: "creature", s: { name: "Invented Wolf", entry: WOLF } });
    expect(drained!.through).toBeGreaterThan(0);
    expect(drained!.dropped).toBe(0);
    await host.stop();
    expect(await host.nearbyDrain()).toBeNull();
  }, 15_000);
});
