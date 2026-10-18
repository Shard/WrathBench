/**
 * The nearby codec (`viewer/nearby.ts`), the ring's reads (`viewer/nearby-ring.ts`),
 * the route, and the public boundary (`projectNearby`).
 *
 * Rows are hand-written in the ring's own shape (`runner/src/nearby-row.ts`);
 * positions, names and guids are invented.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NEARBY_DIR, NEARBY_FILE_MS, NEARBY_RING_MS, NEARBY_STATE_KEYS as ROW_KEYS, type NearbySelf, type NearbyState } from "../src/nearby-row";
import type { NearbySelfView, NearbyStateView } from "../viewer/api-types";
import { createApi } from "../viewer/api";
import {
  EASE_MS,
  NEARBY_POS_GAP_MS,
  NEARBY_STATE_KEYS,
  decodeNearby,
  encodeNearby,
  nearbyAt,
  nearbySelfAt,
  windowRows,
  type NearbyRingRow,
  type NearbyRingUnit,
  type NearbyWindow,
} from "../viewer/nearby";
import { RING_DIR, RING_FILE_MS, RING_REACH_MS, nearbyFresh, readNearbyWindow } from "../viewer/nearby-ring";
import { projectNearby } from "../viewer/public-projection";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
function pin<T extends true>(): T {
  return true as T;
}

const T0 = 1_760_000_040_000;
const SELF: NearbySelfView = { guid: "7", map: 0, target: null, down: false };
const guid = (entry: number, low: number, high = 0xf130): string => ((BigInt(high) << 48n) | (BigInt(entry) << 24n) | BigInt(low)).toString(10);
const WOLF = guid(299, 1);
const VENDOR = guid(1250, 2);
const PLAYER = "88";
const PET = guid(416, 3, 0xf140);
const OWN_PET = guid(416, 4, 0xf140);

const unit = (id: string, ty: NearbyRingUnit["ty"], s: NearbyRingUnit["s"], x: number, y = 0, t = T0 - 1000): NearbyRingUnit => ({
  id,
  ty,
  s,
  m: { k: "pos", t, p: [x, y, 0, 0] },
});
const key = (ts: number, units: NearbyRingUnit[], self: NearbySelfView = SELF): NearbyRingRow => ({ ts, kind: "key", self, units });

describe("the two spellings of the contract", () => {
  test("the codec's state and self are the recorder's, key for key, and the ring's layout is one", () => {
    expect(pin<Equal<keyof NearbyState, keyof NearbyStateView>>()).toBe(true);
    expect(pin<Equal<NearbyState, NearbyStateView>>()).toBe(true);
    expect(pin<Equal<NearbySelf, NearbySelfView>>()).toBe(true);
    expect([...NEARBY_STATE_KEYS]).toEqual([...ROW_KEYS]);
    expect([RING_DIR, RING_FILE_MS, RING_REACH_MS]).toEqual([NEARBY_DIR, NEARBY_FILE_MS, NEARBY_RING_MS]);
  });
});

describe("playback", () => {
  test("a spline is played from its start at the packet's time, faces its way, and holds at its end", () => {
    const rows: NearbyRingRow[] = [
      key(T0, [unit(WOLF, "creature", { entry: 299, name: "Invented Wolf" }, 0)]),
      // Polled 400 ms after the spline began: played from when it began.
      { ts: T0 + 1400, kind: "mv", id: WOLF, m: { k: "mv", t: T0 + 1000, p: [0, 0, 0], to: [20, 0, 0], ms: 4000 } },
      { ts: T0 + 9000, kind: "tick" },
    ];
    const d = decodeNearby(JSON.parse(JSON.stringify(encodeNearby(rows, { run: "r", from: T0 }))) as NearbyWindow);
    const at = (t: number) => nearbyAt(d, t)[0]!;
    expect(at(T0 + 500)).toMatchObject({ x: 0, moving: false });
    expect(at(T0 + 1000).x).toBeCloseTo(0, 5);
    expect(at(T0 + 3000)).toMatchObject({ moving: true });
    expect(at(T0 + 3000).x).toBeCloseTo(10, 5);
    expect(at(T0 + 3000).o).toBeCloseTo(0, 5);
    expect(at(T0 + 5000)).toMatchObject({ x: 20, moving: false });
    expect(at(T0 + 8000).x).toBe(20);
    expect(at(T0 + 3000).s).toEqual({ entry: 299, name: "Invented Wolf" });
    // Past the horizon nothing is drawn: hidden, never frozen.
    expect(nearbyAt(d, T0 + 9001)).toEqual([]);
    expect(nearbyAt(d, T0 - 1)).toEqual([]);
  });

  test("a player's samples are walked between when close in time, and held across a gap", () => {
    const rows: NearbyRingRow[] = [
      key(T0, [unit(PLAYER, "player", { name: "Wanderer" }, 0)]),
      { ts: T0 + 600, kind: "pos", id: PLAYER, m: { k: "pos", t: T0 + 500, p: [2, 0, 0, 0] } },
      { ts: T0 + 1100, kind: "pos", id: PLAYER, m: { k: "pos", t: T0 + 1000, p: [4, 0, 0, 0] } },
      { ts: T0 + 6000, kind: "pos", id: PLAYER, m: { k: "pos", t: T0 + 1000 + NEARBY_POS_GAP_MS + 1000, p: [40, 0, 0, 0] } },
      { ts: T0 + 9000, kind: "tick" },
    ];
    const d = decodeNearby(encodeNearby(rows, { run: "r", from: T0 }));
    expect(nearbyAt(d, T0 + 750)[0]!.x).toBeCloseTo(3, 5);
    // Held after the last close sample, until the far one lands.
    expect(nearbyAt(d, T0 + 2000)[0]!.x).toBeCloseTo(4, 5);
    expect(nearbyAt(d, T0 + 4500)[0]!.x).toBe(40);
  });

  test("a new motion close to where the old one left the unit eases; a far one jumps", () => {
    const rows: NearbyRingRow[] = [
      key(T0, [unit(WOLF, "creature", {}, 0), unit(VENDOR, "creature", {}, 100)]),
      { ts: T0 + 1000, kind: "mv", id: WOLF, m: { k: "mv", t: T0 + 1000, p: [2, 0, 0], to: [2, 10, 0], ms: 1000 } },
      { ts: T0 + 1000, kind: "mv", id: VENDOR, m: { k: "mv", t: T0 + 1000, p: [150, 0, 0] } },
      { ts: T0 + 5000, kind: "tick" },
    ];
    const d = decodeNearby(encodeNearby(rows, { run: "r", from: T0 }));
    const wolf = (t: number) => nearbyAt(d, t).find((u) => u.id === WOLF)!;
    // Two yards off: starts where it was and slides onto the spline.
    expect(wolf(T0 + 1000).x).toBeCloseTo(0, 5);
    expect(wolf(T0 + 1000 + EASE_MS / 2).x).toBeCloseTo(1, 5);
    expect(wolf(T0 + 1000 + EASE_MS).x).toBeCloseTo(2, 5);
    // Fifty yards off: a jump.
    expect(nearbyAt(d, T0 + 1000).find((u) => u.id === VENDOR)!.x).toBe(150);
  });

  test("who is in view, a late name, the self's target and a restart's restating key", () => {
    const rows: NearbyRingRow[] = [
      key(T0, [unit(WOLF, "creature", { entry: 299 }, 0)]),
      { ts: T0 + 1000, kind: "in", u: unit(VENDOR, "creature", { entry: 1250, nf: 0x80 }, 5, 0, T0 + 900) },
      { ts: T0 + 1500, kind: "nm", id: VENDOR, name: "Brother Invented", sub: "Weapon Merchant" },
      { ts: T0 + 2000, kind: "self", self: { target: VENDOR } },
      { ts: T0 + 3000, kind: "out", id: WOLF },
      // The child restarts: its key restates the scene, now with only the vendor.
      key(T0 + 4000, [unit(VENDOR, "creature", { entry: 1250, nf: 0x80, name: "Brother Invented", sub: "Weapon Merchant", hp: 50 }, 6, 0, T0 + 3900)], { ...SELF, target: VENDOR }),
      { ts: T0 + 5000, kind: "tick" },
    ];
    const w = encodeNearby(rows, { run: "r", from: T0 });
    const d = decodeNearby(w);
    expect(nearbyAt(d, T0 + 500).map((u) => u.id)).toEqual([WOLF]);
    expect(nearbyAt(d, T0 + 1200).map((u) => u.id).sort()).toEqual([WOLF, VENDOR].sort());
    expect(nearbyAt(d, T0 + 1200).find((u) => u.id === VENDOR)!.s.name).toBeUndefined();
    expect(nearbyAt(d, T0 + 1600).find((u) => u.id === VENDOR)!.s).toMatchObject({ name: "Brother Invented", sub: "Weapon Merchant" });
    expect(nearbySelfAt(d, T0 + 1900).target).toBeNull();
    expect(nearbySelfAt(d, T0 + 2100).target).toBe(VENDOR);
    expect(nearbyAt(d, T0 + 3500).map((u) => u.id)).toEqual([VENDOR]);
    expect(nearbyAt(d, T0 + 4500)[0]).toMatchObject({ id: VENDOR, x: 6, s: { hp: 50 } });
    // The restating key wrote only what changed: one state event and one motion.
    expect(w.ev.filter((e) => e[0] === 4000).map((e) => e[2])).toEqual(["st"]);
    expect(w.dt.length).toBe(1);
  });

  test("the keyframe at `from` is folded from the newest key before it; with none, the window starts at the first", () => {
    const rows: NearbyRingRow[] = [
      key(T0, [unit(WOLF, "creature", { entry: 299 }, 0)]),
      { ts: T0 + 10_000, kind: "st", id: WOLF, s: { hp: 40 } },
      { ts: T0 + 20_000, kind: "mv", id: WOLF, m: { k: "mv", t: T0 + 19_000, p: [0, 0, 0], to: [10, 0, 0], ms: 10_000 } },
      { ts: T0 + 30_000, kind: "tick" },
    ];
    const w = encodeNearby(rows, { run: "r", from: T0 + 25_000 });
    expect(w.t0).toBe(T0 + 25_000);
    expect(w.k.s).toEqual([{ entry: 299, hp: 40 }]);
    // The spline still under way at t0 rides the keyframe, from when it began.
    expect(w.k.m[0]!.slice(0, 2)).toEqual([1, -6000]);
    expect(nearbyAt(decodeNearby(w), T0 + 25_000)[0]!.x).toBeCloseTo(6, 5);
    const late = encodeNearby(rows, { run: "r", from: T0 - 60_000 });
    expect(late.t0).toBe(T0);
    // No ring at all: an empty window at `from`.
    expect(encodeNearby([], { run: "r", from: T0 })).toMatchObject({ t0: T0, t1: T0, ids: [], ev: [] });
  });
});

/** A busy minute: units coming and going, splines, samples, names, a restart, the self changing. */
function busyRows(): NearbyRingRow[] {
  const rows: NearbyRingRow[] = [];
  const units: NearbyRingUnit[] = Array.from({ length: 30 }, (_, i) =>
    unit(guid(300 + (i % 5), i), i % 10 === 0 ? "player" : "creature", { entry: 300 + (i % 5), level: 3 + (i % 4), hp: 100, ...(i % 7 === 0 ? { nf: 0x80, qg: 8 } : {}) }, i * 3.37, i * 1.13),
  );
  rows.push(key(T0, units));
  for (let s = 1; s <= 60; s++) {
    const ts = T0 + s * 1000;
    for (let k = 0; k < 4; k++) {
      const u = units[(s * 4 + k) % units.length]!;
      rows.push(u.ty === "player" ? { ts, kind: "pos", id: u.id, m: { k: "pos", t: ts - 120, p: [s * 0.71, k * 1.3, 0.25, (s % 6) * 0.9] } } : { ts, kind: "mv", id: u.id, m: { k: "mv", t: ts - 300, p: [s, k, 0], to: [s + 3.21, k - 2.5, 0.5], ms: 2200 } });
    }
    if (s % 9 === 0) rows.push({ ts, kind: "st", id: units[s % units.length]!.id, s: { hp: 100 - s, tg: s % 18 === 0 ? "7" : null, tgs: s % 18 === 0 ? true : null } });
    if (s === 12) rows.push({ ts, kind: "out", id: units[3]!.id });
    if (s === 15) rows.push({ ts, kind: "in", u: unit(guid(999, 1), "creature", { entry: 999 }, 50, 50, ts - 200) });
    if (s === 16) rows.push({ ts, kind: "nm", id: guid(999, 1), name: "Late Name" });
    if (s === 20) rows.push({ ts, kind: "self", self: { target: units[1]!.id } });
    if (s === 40) rows.push(key(ts, units.slice(5, 25)));
    rows.push({ ts: ts + 500, kind: "tick" });
  }
  return rows;
}

describe("the window round-trips", () => {
  test("encodeNearby(windowRows(w)) is w, byte for byte, from inside the window too", () => {
    const rows = busyRows();
    for (const from of [T0, T0 + 17_250, T0 + 40_000]) {
      const w = encodeNearby(rows, { run: "r", from });
      const again = encodeNearby(windowRows(JSON.parse(JSON.stringify(w)) as NearbyWindow), { run: "r", from: w.t0 });
      expect(JSON.stringify(again)).toBe(JSON.stringify(w));
    }
  });

  test("a unit plays where its last recorded motion puts it, at every row's time", () => {
    const rows = busyRows();
    const d = decodeNearby(encodeNearby(rows, { run: "r", from: T0 }));
    for (const r of rows) {
      if (r.kind !== "mv" && r.kind !== "pos") continue;
      const got = nearbyAt(d, r.m.t + (r.kind === "pos" ? 0 : r.m.ms ?? 0) + EASE_MS).find((u) => u.id === r.id);
      if (got === undefined) continue; // left view before then
      const expectX = r.kind === "mv" && r.m.to !== undefined ? r.m.to[0] : r.m.p[0];
      // Within the quantum, or overtaken by a newer motion of the same unit.
      const newer = rows.some((o) => (o.kind === "mv" || o.kind === "pos") && o.id === r.id && o.m.t > r.m.t && o.m.t <= r.m.t + (r.m.ms ?? 0) + EASE_MS);
      if (!newer) expect(Math.abs(got.x - expectX)).toBeLessThanOrEqual(0.05 + 1e-9);
    }
  });
});

describe("the ring's reads", () => {
  function ringWith(files: Record<number, string>, opts: { mtime?: number } = {}) {
    const runs = tempDir("nearby-ring-");
    const dir = join(runs, "run-a", "nearby");
    mkdirSync(dir, { recursive: true });
    for (const [t0, text] of Object.entries(files)) {
      const p = join(dir, `${t0}.jsonl`);
      writeFileSync(p, text);
      if (opts.mtime !== undefined) utimesSync(p, opts.mtime / 1000, opts.mtime / 1000);
    }
    return runs;
  }
  const line = (r: unknown): string => `${JSON.stringify(r)}\n`;

  test("a half-written last line and a foreign one are left out; a file past the reach is ignored", () => {
    const now = T0 + 30_000;
    const runs = ringWith({
      [T0 - 20 * 60_000]: line(key(T0 - 20 * 60_000, [unit(PLAYER, "player", { name: "Stale" }, 0)])),
      [T0]:
        line(key(T0, [unit(WOLF, "creature", { entry: 299 }, 0)])) +
        "not json\n" +
        line({ ts: T0 + 1000, kind: "weird" }) +
        line({ ts: T0 + 2000, kind: "st", id: WOLF, s: { hp: 10 } }) +
        `{"ts":${T0 + 3000},"kind":"st","id":"${WOLF}","s":{"hp":`,
    });
    const w = readNearbyWindow(runs, "run-a", 60_000, now);
    expect(w.t0).toBe(T0);
    expect(w.ids).toEqual([WOLF]);
    expect(w.ev).toEqual([[2000, 0, "st", { hp: 10 }]]);
    expect(w.t1).toBe(T0 + 2000);
    expect(JSON.stringify(w)).not.toContain("Stale");
  });

  test("the span is clamped to the reach; a run with no ring answers an empty window", () => {
    const now = T0 + 30_000;
    const runs = ringWith({ [T0]: line(key(T0, [])) });
    expect(readNearbyWindow(runs, "run-a", 99 * 60 * 60_000, now).t0).toBe(T0);
    expect(readNearbyWindow(runs, "no-such-run", 60_000, now)).toMatchObject({ t0: now - 60_000, ids: [], ev: [] });
  });

  test("fresh means the newest file was written within the last half minute", () => {
    const now = Date.now();
    const t0 = Math.floor(now / 60_000) * 60_000;
    expect(nearbyFresh(ringWith({ [t0]: line(key(t0, [])) }), "run-a", now)).toBe(true);
    expect(nearbyFresh(ringWith({ [t0]: line(key(t0, [])) }, { mtime: now - 60_000 }), "run-a", now)).toBe(false);
    expect(nearbyFresh(tempDir("nearby-none-"), "run-a", now)).toBe(false);
  });
});

describe("the public boundary", () => {
  const OTHER_PLAYER = "4242";
  /** Every kind of unit the rules name, and a self that dies and comes back. */
  function scene(): NearbyRingRow[] {
    return [
      key(T0, [
        unit(WOLF, "creature", { entry: 299, name: "Invented Wolf", sub: "Pack Leader", level: 5, hp: 100, uf: 0x80000, df: 0x4 | 0x20, disp: 903, tg: "7", tgs: true }, 0),
        unit(VENDOR, "creature", { entry: 1250, name: "Brother Invented", nf: 0x80, qg: 8 }, 5),
        unit(OTHER_PLAYER, "player", { name: "Otherplayer", level: 9, race: 1, cls: 2 }, 10),
        unit(PET, "pet", { entry: 416, name: "Otherpet", ow: OTHER_PLAYER }, 11),
        unit(OWN_PET, "pet", { entry: 416, name: "Ownpet", ow: "7" }, 12),
        unit(guid(40, 5), "creature", { entry: 40, name: "Charmed Kobold", ch: OTHER_PLAYER }, 13),
        unit(guid(41, 6), "creature", { entry: 41, name: "Driven Thing", uf: 0x8 }, 14),
        unit(guid(42, 7), "vehicle", { entry: 42, name: "Invented Cannon" }, 15),
      ]),
      // The wolf turns on the other player, then back.
      { ts: T0 + 2000, kind: "st", id: WOLF, s: { tg: OTHER_PLAYER, tgs: false } },
      { ts: T0 + 3000, kind: "mv", id: WOLF, m: { k: "mv", t: T0 + 3000, p: [0, 0, 0], to: [30, 0, 0], ms: 3000 } },
      { ts: T0 + 6000, kind: "st", id: WOLF, s: { tg: "7", tgs: true } },
      // The character dies, and is resurrected.
      { ts: T0 + 8000, kind: "self", self: { down: true } },
      { ts: T0 + 9000, kind: "mv", id: VENDOR, m: { k: "mv", t: T0 + 9000, p: [5, 0, 0], to: [5, 9, 0], ms: 2000 } },
      { ts: T0 + 12_000, kind: "self", self: { down: false } },
      { ts: T0 + 15_000, kind: "tick" },
    ];
  }
  const priv = (): NearbyWindow => JSON.parse(JSON.stringify(encodeNearby(scene(), { run: "r", from: T0 }))) as NearbyWindow;

  test("creatures only: no player, no pet, nothing another player owns, charms or drives", () => {
    const p = projectNearby(priv());
    const d = decodeNearby(p);
    expect(nearbyAt(d, T0 + 500).map((u) => u.s.name).sort()).toEqual(["Brother Invented", "Invented Cannon", "Invented Wolf"]);
    const text = JSON.stringify(p);
    for (const gone of ["Otherplayer", "Otherpet", "Ownpet", "Charmed Kobold", "Driven Thing", OTHER_PLAYER, PET, OWN_PET]) expect(text).not.toContain(gone);
  });

  test("the state is cut to its public keys: names and ids stay, guids, subnames and flags go", () => {
    const d = decodeNearby(projectNearby(priv()));
    const wolf = nearbyAt(d, T0 + 500).find((u) => u.id === WOLF)!;
    // Dead is the only dynamic flag published; the target only as "targets this character".
    expect(wolf.s).toEqual({ entry: 299, name: "Invented Wolf", level: 5, hp: 100, df: 0x20, tgs: true });
    expect(nearbySelfAt(d, T0 + 500)).toEqual({ guid: null, map: 0, target: null, down: false });
    expect(JSON.stringify(projectNearby(priv()))).not.toContain('"7"');
  });

  test("a unit is withheld while it targets another player, and the layer is empty while the character is down", () => {
    const d = decodeNearby(projectNearby(priv()));
    const ids = (t: number) => nearbyAt(d, t).map((u) => u.id).sort();
    expect(ids(T0 + 1000)).toContain(WOLF);
    expect(ids(T0 + 4000)).not.toContain(WOLF);
    // Back with its whole state and the motion it had meanwhile.
    const back = nearbyAt(d, T0 + 6500).find((u) => u.id === WOLF)!;
    expect(back.x).toBeCloseTo(30, 5);
    expect(back.s.tgs).toBe(true);
    expect(ids(T0 + 9000)).toEqual([]);
    expect(ids(T0 + 11_000)).toEqual([]);
    // Up again: the vendor is where its spline left it while the layer was dark.
    const vendor = nearbyAt(d, T0 + 12_500).find((u) => u.id === VENDOR)!;
    expect(vendor.y).toBeCloseTo(9, 5);
    expect(ids(T0 + 12_500)).toEqual([VENDOR, WOLF, guid(42, 7)].sort());
  });

  test("a fixed point: projecting a public window changes nothing, and the private one carries what it withholds", () => {
    const once = projectNearby(priv());
    expect(JSON.stringify(projectNearby(JSON.parse(JSON.stringify(once)) as NearbyWindow))).toBe(JSON.stringify(once));
    const busy = encodeNearby(busyRows(), { run: "r", from: T0 });
    const b1 = projectNearby(busy);
    expect(JSON.stringify(projectNearby(b1))).toBe(JSON.stringify(b1));
    expect(JSON.stringify(priv())).toContain("Otherplayer");
  });

  test("a window of another version is withheld whole", () => {
    expect(projectNearby({ ...priv(), v: 2 })).toMatchObject({ v: 1, ids: [], ev: [] });
  });
});

describe("the route", () => {
  function runsWithRing(): string {
    const runs = tempDir("nearby-route-");
    const now = Date.now();
    const ts = now - 3_000;
    const t0 = Math.floor(ts / 60_000) * 60_000;
    mkdirSync(join(runs, "live-run", "nearby"), { recursive: true });
    mkdirSync(join(runs, "quiet-run"), { recursive: true });
    writeFileSync(
      join(runs, "live-run", "nearby", `${t0}.jsonl`),
      [key(ts, [unit(WOLF, "creature", { entry: 299, name: "Invented Wolf" }, 0, 0, ts), unit(PLAYER, "player", { name: "Wanderer" }, 3, 0, ts)]), { ts: ts + 1000, kind: "tick" }]
        .map((r) => `${JSON.stringify(r)}\n`)
        .join(""),
    );
    return runs;
  }
  const handle = (runs: string, publicMode: boolean) => createApi({ runsDir: runs, tilesDir: join(runs, "tiles"), publicMode, moduleUrl: "http://127.0.0.1:1" });
  const get = (h: (r: Request) => Promise<Response>, path: string) => h(new Request(`http://viewer.local${path}`));

  test("serves the window uncached, privately whole and publicly projected", async () => {
    const runs = runsWithRing();
    const res = await get(handle(runs, false), "/api/run/live-run/nearby?span=60000");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const w = (await res.json()) as NearbyWindow;
    expect(nearbyAt(decodeNearby(w), w.t0).map((u) => u.s.name).sort()).toEqual(["Invented Wolf", "Wanderer"]);
    const pub = (await (await get(handle(runs, true), "/api/run/live-run/nearby")).json()) as NearbyWindow;
    expect(nearbyAt(decodeNearby(pub), pub.t0).map((u) => u.s.name)).toEqual(["Invented Wolf"]);
  });

  test("a run with no ring is an empty window, a run that does not exist a 404, a junk span the default", async () => {
    const runs = runsWithRing();
    const h = handle(runs, false);
    const quiet = await get(h, "/api/run/quiet-run/nearby");
    expect(quiet.status).toBe(200);
    expect(((await quiet.json()) as NearbyWindow).ids).toEqual([]);
    expect((await get(h, "/api/run/no-such-run/nearby")).status).toBe(404);
    expect((await get(h, "/api/run/live-run/nearby?span=junk")).status).toBe(200);
  });

  test("the position feed flags a run whose ring is being written", async () => {
    const runs = runsWithRing();
    // The flag rides a live position, which needs a state row; that is the
    // position suite's business, so the flag's own reader is asked here.
    expect(nearbyFresh(runs, "live-run", Date.now())).toBe(true);
    expect(nearbyFresh(runs, "quiet-run", Date.now())).toBe(false);
  });
});
