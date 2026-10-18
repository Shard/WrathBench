/**
 * The nearby ring writer (`nearby.ts`): the host's side of the live map's
 * units. A fake drain hands it rows the way the child's recorder shapes them
 * (`nearby-row.ts`); what is checked is the ring on disk — one file per
 * minute, each opening with a key from the writer's fold, a tick closing each
 * drain, nothing older than the ring's reach, and nothing left once it stops.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NearbyWriter, ringFileExpired, ringFileStart } from "../src/nearby";
import { NEARBY_FILE_MS, NEARBY_RING_MS, type NearbyDrain, type NearbyRow, type NearbyUnit } from "../src/nearby-row";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();

const M0 = 1_760_000_040_000; // a minute boundary
const WOLF = "77"; // ids are opaque here
const self = { guid: "7", map: 0, target: null, down: false };
const wolf = (s: NearbyUnit["s"] = { entry: 299, name: "Invented Wolf" }): NearbyUnit => ({
  id: WOLF,
  ty: "creature",
  s,
  m: { k: "pos", t: M0, p: [1, 2, 3, 0] },
});

function rig(opts: { canDrain?: boolean } = {}) {
  const runDir = tempDir("wrathbench-ring-");
  let now = M0;
  let next: NearbyDrain | null = { rows: [], dropped: 0, through: M0 };
  const logs: string[] = [];
  const sandbox = opts.canDrain === false ? {} : { nearbyDrain: () => Promise.resolve(next) };
  const writer = new NearbyWriter({ runDir, sandbox, now: () => now, log: (t) => logs.push(t) });
  const ring = join(runDir, "nearby");
  return {
    runDir,
    ring,
    writer,
    logs,
    at(t: number): void {
      now = t;
    },
    /** One tick: the child hands over these rows, polled up to `through`. */
    async tick(rows: NearbyRow[], through: number, dropped = 0): Promise<void> {
      next = { rows, dropped, through };
      now = Math.max(now, through);
      await writer.drain();
    },
    async nullTick(at: number): Promise<void> {
      next = null;
      now = at;
      await writer.drain();
    },
    files(): string[] {
      return existsSync(ring) ? readdirSync(ring).sort() : [];
    },
    lines(t0: number): NearbyRow[] {
      return readFileSync(join(ring, `${t0}.jsonl`), "utf8")
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => JSON.parse(l) as NearbyRow);
    },
  };
}

describe("the ring on disk", () => {
  test("one file per minute, each opening with a key, each drain closed by a tick", async () => {
    const r = rig();
    await r.tick([{ ts: M0 + 100, kind: "key", self, units: [wolf()] }], M0 + 500);
    await r.tick([{ ts: M0 + 5_500, kind: "mv", id: WOLF, m: { k: "mv", t: M0 + 5_300, p: [1, 2, 3], to: [9, 2, 3], ms: 4000 } }], M0 + 10_500);
    // Quiet for a while, then across the minute.
    await r.tick([], M0 + 55_500);
    await r.tick([{ ts: M0 + 61_000, kind: "st", id: WOLF, s: { hp: 40 } }], M0 + 62_000);
    expect(r.files()).toEqual([`${M0}.jsonl`, `${M0 + NEARBY_FILE_MS}.jsonl`]);

    const first = r.lines(M0);
    expect(first.map((l) => l.kind)).toEqual(["key", "tick", "mv", "tick", "tick"]);
    expect(first.map((l) => l.ts)).toEqual([M0 + 100, M0 + 500, M0 + 5_500, M0 + 10_500, M0 + 55_500]);

    // The second minute's key is the writer's own fold: the wolf where the
    // spline left it, whole, so this file reads without the one before.
    const second = r.lines(M0 + NEARBY_FILE_MS);
    expect(second.map((l) => l.kind)).toEqual(["key", "st", "tick"]);
    const key = second[0] as Extract<NearbyRow, { kind: "key" }>;
    expect(key.ts).toBe(M0 + NEARBY_FILE_MS);
    expect(key.self).toEqual(self);
    expect(key.units).toEqual([{ ...wolf(), m: { k: "mv", t: M0 + 5_300, p: [1, 2, 3], to: [9, 2, 3], ms: 4000 } }]);
  });

  test("an idle child still keys every minute it is live for", async () => {
    const r = rig();
    await r.tick([{ ts: M0 + 100, kind: "key", self, units: [wolf()] }], M0 + 500);
    await r.tick([], M0 + NEARBY_FILE_MS + 4_000);
    await r.tick([], M0 + 2 * NEARBY_FILE_MS + 4_000);
    expect(r.files()).toHaveLength(3);
    for (const t0 of [M0 + NEARBY_FILE_MS, M0 + 2 * NEARBY_FILE_MS]) {
      expect(r.lines(t0).map((l) => l.kind)).toEqual(["key", "tick"]);
    }
  });

  test("files past the ring's reach are unlinked on every tick, a tick with no child included", async () => {
    const r = rig();
    await r.tick([{ ts: M0 + 100, kind: "key", self, units: [wolf()] }], M0 + 500);
    for (let m = 1; m <= 20; m++) await r.tick([], M0 + m * NEARBY_FILE_MS + 1_000);
    // 15 minutes of reach, plus the minute being written.
    const kept = r.files().map((f) => ringFileStart(f)!);
    expect(kept.length).toBe(NEARBY_RING_MS / NEARBY_FILE_MS + 1);
    const now = M0 + 20 * NEARBY_FILE_MS + 1_000;
    expect(kept.every((t0) => !ringFileExpired(t0, now))).toBe(true);
    expect(Math.min(...kept)).toBe(M0 + 5 * NEARBY_FILE_MS);
    // The child gone (a pause between turns): nothing new, the old still goes.
    await r.nullTick(now + 3 * NEARBY_FILE_MS);
    expect(Math.min(...r.files().map((f) => ringFileStart(f)!))).toBe(M0 + 8 * NEARBY_FILE_MS);
  });

  test("close removes the ring, and a closed writer writes nothing more", async () => {
    const r = rig();
    await r.tick([{ ts: M0 + 100, kind: "key", self, units: [wolf()] }], M0 + 500);
    expect(r.files()).toHaveLength(1);
    r.writer.close();
    expect(existsSync(r.ring)).toBe(false);
    await r.tick([{ ts: M0 + 5_000, kind: "out", id: WOLF }], M0 + 5_500);
    expect(existsSync(r.ring)).toBe(false);
    expect(existsSync(r.runDir)).toBe(true);
  });

  test("the first drain of a process sweeps what an earlier one left behind", async () => {
    const r = rig();
    mkdirSync(r.ring, { recursive: true });
    writeFileSync(join(r.ring, `${M0 - 600_000}.jsonl`), `{"ts":1,"kind":"tick"}\n`);
    writeFileSync(join(r.ring, "stray.txt"), "x");
    await r.tick([{ ts: M0 + 100, kind: "key", self, units: [wolf()] }], M0 + 500);
    expect(r.files()).toEqual([`${M0}.jsonl`]);
  });

  test("a sandbox that cannot drain gets no ring, and nothing on disk is touched", async () => {
    const r = rig({ canDrain: false });
    mkdirSync(r.ring, { recursive: true });
    writeFileSync(join(r.ring, `${M0}.jsonl`), `{"ts":1,"kind":"tick"}\n`);
    await r.tick([], M0 + 500);
    r.writer.close();
    expect(r.files()).toEqual([`${M0}.jsonl`]);
  });

  test("a dropped-row count goes to the log, never into the ring", async () => {
    const r = rig();
    await r.tick([{ ts: M0 + 100, kind: "key", self, units: [] }], M0 + 500, 3);
    expect(r.logs).toEqual(["[nearby] the sandbox buffer dropped 3 row(s) before this drain"]);
    expect(readFileSync(join(r.ring, `${M0}.jsonl`), "utf8")).not.toContain("dropped");
  });
});

describe("names across a child restart", () => {
  test("a restarted child's unnamed creature and player are named from what this run was told", async () => {
    const r = rig();
    const player: NearbyUnit = { id: "88", ty: "player", s: { name: "Wanderer", level: 9 }, m: { k: "pos", t: M0, p: [5, 5, 0, 0] } };
    await r.tick(
      [
        { ts: M0 + 100, kind: "key", self, units: [wolf({ entry: 299 }), player] },
        { ts: M0 + 600, kind: "nm", id: WOLF, name: "Invented Wolf", sub: "Pack Leader" },
      ],
      M0 + 1_000,
    );
    // The child restarts: its cache is empty, its module session is the old
    // one, and nothing is queried again — the key comes back unnamed.
    const another: NearbyUnit = { id: "78", ty: "creature", s: { entry: 299 }, m: { k: "pos", t: M0 + 9_000, p: [2, 2, 0, 0] } };
    await r.tick(
      [
        { ts: M0 + 9_500, kind: "key", self, units: [wolf({ entry: 299 }), { ...player, s: { level: 9 } }] },
        { ts: M0 + 9_900, kind: "in", u: another },
      ],
      M0 + 10_000,
    );
    const rows = r.lines(M0);
    const key = rows.filter((l): l is Extract<NearbyRow, { kind: "key" }> => l.kind === "key")[1]!;
    expect(key.units.map((u) => u.s.name)).toEqual(["Invented Wolf", "Wanderer"]);
    expect(key.units[0]!.s.sub).toBe("Pack Leader");
    const entered = rows.find((l): l is Extract<NearbyRow, { kind: "in" }> => l.kind === "in")!;
    expect(entered.u.s).toEqual({ entry: 299, name: "Invented Wolf", sub: "Pack Leader" });
  });
});
