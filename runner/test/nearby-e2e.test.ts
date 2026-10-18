/**
 * Nearby units end to end, on the real code at every step: the sandbox
 * child's recorder over a real SDK cache fed hand-written frames, the host's
 * `ContextBuilder` draining it into the ring the way the state ticker does, a
 * real `Trajectory` writing `run.sqlite` (the trace included) and
 * `trajectory.jsonl` beside it, the viewer's ring reader and codec decoding what the map polls,
 * and the real ticker's stop.
 *
 * What it proves is the boundary, not the drawing:
 * - the recorder reads the cache and the broadcast hook and nothing else — its
 *   source throws on any action, raw opcode, consuming queue or other read;
 * - a canary name that exists only in the nearby input reaches the ring and no
 *   file outside it: not `run.sqlite`, `trajectory.jsonl` or
 *   `meta.json`, and `run.sqlite` gains no table;
 * - the ring holds at most its reach, unlinks the rest as it goes, and is gone
 *   when the ticker stops;
 * - what the viewer serves from it is what the recorder saw: every unit, its
 *   name, and each spline ending where the packet said.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadRunConfig } from "../src/config";
import { ContextBuilder, startStateTicker } from "../src/loop";
import { ringFileStart } from "../src/nearby";
import { NEARBY_FILE_MS, NEARBY_RING_MS } from "../src/nearby-row";
import type { SandboxHost } from "../src/sandbox/host";
import { NearbyRecorder } from "../src/sandbox/nearby-recorder";
import { TraceRecorder } from "../src/sandbox/trace-recorder";
import { Scratchpad } from "../src/scratchpad";
import { Trajectory } from "../src/trajectory";
import { Watchdogs } from "../src/watchdogs";
import { SELF_GUID, guardedSource, nearbyRig, playerGuid, unitGuid } from "./fixtures/nearby-frames";
import { tempDirs } from "./fixtures/temp-dirs";
import { NEARBY_SPAN_MS, decodeNearby, nearbyAt, type NearbyWindow } from "../viewer/nearby";
import { readNearbyWindow } from "../viewer/nearby-ring";

const tempDir = tempDirs();

const RUN = "nearby-e2e-run";
/** A name fed only to the nearby path; finding it anywhere else is a leak. */
const CANARY = "Canarywing Nearbyhawk";
const CANARY_PLAYER = "Canaryplayer";

/** Every file under `dir`, recursively, with its path relative to `dir`. */
function filesUnder(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(dir, rel))) {
    const p = rel === "" ? name : join(rel, name);
    if (statSync(join(dir, p)).isDirectory()) out.push(...filesUnder(dir, p));
    else out.push(p);
  }
  return out;
}

/** A live run with a busy scene, driven for `minutes` of fake clock. Shared with the viewer's half of this test. */
async function driveScene(runs: string, minutes: number, onTick?: (clock: number) => void) {
  const dir = join(runs, RUN);
  const trajectory = new Trajectory(dir);
  const config = { ...loadRunConfig({ driver: "stub", stateIntervalMs: 60_000 }), runId: RUN, token: RUN, runsDir: runs };
  trajectory.writeMeta({ runId: RUN, harnessVersion: "t", startedAt: 1, config });
  trajectory.append({ t: "harness", kind: "e2e-start" });

  let clock = 1_760_000_000_000;
  const r = nearbyRig();
  const guarded = guardedSource(r);
  const nearby = new NearbyRecorder({ state: guarded.source.state, events: guarded.source.events, now: () => clock, pollMs: 60_000 });
  const trace = new TraceRecorder({ state: r.state, events: r.events, now: () => clock, pollMs: 60_000 });
  const forbidden = (what: string) => (): never => {
    throw new Error(`the e2e touched ${what}`);
  };
  const sandbox = {
    traceDrain: () => Promise.resolve(trace.drain()),
    nearbyDrain: () => Promise.resolve(nearby.drain()),
    stateSnapshot: () => Promise.resolve({ self: { guid: SELF_GUID, level: { value: 7, seq: 1, ts: 1 } }, lastSeq: 1, eventCount: 1 }),
    drainNotices: () => [],
    totalRestarts: 0,
    consecutiveRestarts: 0,
    evalSnippet: forbidden("evalSnippet"),
    stop: () => Promise.resolve(),
  } as unknown as SandboxHost;
  const builder = new ContextBuilder({
    config,
    sandbox,
    scratchpad: new Scratchpad(join(dir, "scratchpad.md")),
    trajectory,
    watchdogs: new Watchdogs(config.watchdogs),
    now: () => clock,
  });

  // The world: a login, a field of creatures (one of them the canary), a
  // vendor with a marker, and another player walking past.
  nearby.start();
  trace.start();
  r.login(0, { x: -9000, y: -100, z: 80 }, clock);
  r.selfFields({ health: 200, maxHealth: 200, level: 7 }, clock + 1);
  const creatures = Array.from({ length: 120 }, (_, i) => ({
    guid: unitGuid(299 + (i % 6), 1000 + i),
    entry: 299 + (i % 6),
    home: { x: -9000 + (i % 12) * 8, y: -100 + Math.floor(i / 12) * 8, z: 80 },
  }));
  r.createMany(
    creatures.map((c) => ({ guid: c.guid, objectType: "unit" as const, p: c.home, fields: { entry: c.entry, health: 100, maxHealth: 100, level: 5 } })),
    clock + 10,
  );
  for (let e = 0; e < 6; e++) r.creatureName(299 + e, e === 0 ? CANARY : `Invented Beast ${e}`, "", 1, clock + 20);
  const walker = playerGuid(88);
  r.create(walker, "player", { x: -8990, y: -90, z: 80 }, { health: 300, maxHealth: 300, level: 9 }, clock + 30);
  r.playerName(walker, CANARY_PLAYER, clock + 40);

  const t0 = clock;
  const end = t0 + minutes * 60_000;
  let lastDrain = clock;
  let maxFiles = 0;
  for (clock = t0 + 500; clock <= end; clock += 500) {
    const s = (clock - t0) / 1000;
    // About 15 splines a second across the field, and the walker's heartbeats.
    for (let k = 0; k < 7; k++) {
      const c = creatures[(Math.floor(s * 2) * 7 + k) % creatures.length]!;
      const to = { x: c.home.x + 4 * Math.cos(s + k), y: c.home.y + 4 * Math.sin(s + k), z: 80 };
      r.spline(c.guid, c.home, to, 2_000, clock - 120);
    }
    r.heartbeat(walker, { x: -8990 + ((s * 3) % 60), y: -90, z: 80, o: 0 }, clock - 60);
    nearby.poll();
    trace.poll();
    if (clock - lastDrain >= 5_000) {
      await builder.drainTrace();
      await builder.drainNearby();
      lastDrain = clock;
      const ring = join(dir, "nearby");
      if (existsSync(ring)) maxFiles = Math.max(maxFiles, readdirSync(ring).length);
      onTick?.(clock);
    }
  }
  /** Move the clock on, with one more spline for the next drain to carry. */
  const advance = (ms: number): void => {
    clock += ms;
    const c = creatures[0]!;
    r.spline(c.guid, c.home, { x: c.home.x + 1, y: c.home.y, z: 80 }, 1_000, clock - 10);
    nearby.poll();
  };
  return { dir, trajectory, builder, guarded, nearby, trace, clock: () => clock, advance, maxFiles, t0, end };
}

describe("nearby end to end: the ring is the only place the units go", () => {
  test("seventeen minutes of a busy scene: the ring keeps its reach, the record never sees a unit", async () => {
    const runs = tempDir("nearby-e2e-");
    const scene = await driveScene(runs, 17);
    const ring = join(scene.dir, "nearby");

    // The ring: at most its reach plus the minute being written, the oldest
    // minutes already unlinked, every file opening with a key.
    expect(scene.maxFiles).toBeLessThanOrEqual(NEARBY_RING_MS / NEARBY_FILE_MS + 1);
    const kept = readdirSync(ring).map((f) => ringFileStart(f)!).sort((a, b) => a - b);
    expect(kept[0]!).toBeGreaterThan(scene.t0 + 60_000);
    expect(kept[0]!).toBeGreaterThanOrEqual(scene.clock() - NEARBY_RING_MS - NEARBY_FILE_MS);
    for (const t0 of kept) {
      const first = JSON.parse(readFileSync(join(ring, `${t0}.jsonl`), "utf8").split("\n")[0]!) as { kind: string };
      expect(first.kind).toBe("key");
    }
    const ringText = kept.map((t0) => readFileSync(join(ring, `${t0}.jsonl`), "utf8")).join("");
    expect(ringText).toContain(CANARY);
    expect(ringText).toContain(CANARY_PLAYER);

    // The record: the trace (in run.sqlite, its one home) and the trajectory
    // exist and were written, and neither the canaries nor any ring row is in them.
    scene.trajectory.close();
    const outside = filesUnder(scene.dir).filter((p) => !p.startsWith("nearby/"));
    expect(outside).toContain("trajectory.jsonl");
    expect(outside).toContain("run.sqlite");
    const traced = new Database(join(scene.dir, "run.sqlite"), { readonly: true });
    try {
      expect((traced.query(`SELECT COUNT(*) AS n FROM trace`).get() as { n: number }).n).toBeGreaterThan(0);
    } finally {
      traced.close();
    }
    for (const p of outside) {
      const bytes = readFileSync(join(scene.dir, p));
      for (const needle of [CANARY, CANARY_PLAYER, "Invented Beast", '"kind":"mv"', '"kind":"tick"']) {
        expect(`${p}: ${bytes.includes(needle)}`).toBe(`${p}: false`);
      }
    }
    // `run.sqlite` holds exactly the tables a fresh trajectory creates.
    const fresh = new Trajectory(join(runs, "fresh"));
    fresh.close();
    const tables = (path: string): string[] => {
      const db = new Database(path, { readonly: true });
      try {
        return (db.query(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as { name: string }[]).map((r) => r.name);
      } finally {
        db.close();
      }
    };
    expect(tables(join(scene.dir, "run.sqlite"))).toEqual(tables(join(runs, "fresh", "run.sqlite")));

    // The recorder read the cache's three fields and the broadcast hook, and
    // nothing else: its source throws on everything else, and it never threw.
    expect([...scene.guarded.reads].sort()).toEqual(["events.on", "state.creatures", "state.nearby", "state.self"]);
    scene.nearby.stop();
    scene.trace.stop();
  }, 60_000);

  test("the viewer reads back what the recorder saw: the units, their names, and where each spline puts them", async () => {
    const runs = tempDir("nearby-e2e-viewer-");
    const seen: { clock: number; window: ReturnType<typeof readNearbyWindow> }[] = [];
    const scene = await driveScene(runs, 3, (clock) => {
      // What the live map's poll asks for, as the drains land.
      if (seen.length < 40) seen.push({ clock, window: readNearbyWindow(runs, RUN, NEARBY_SPAN_MS, clock) });
    });
    const last = readNearbyWindow(runs, RUN, NEARBY_SPAN_MS, scene.clock());
    const d = decodeNearby(JSON.parse(JSON.stringify(last)) as NearbyWindow);
    expect(d.t0).toBe(scene.clock() - NEARBY_SPAN_MS);
    expect(d.t1).toBeGreaterThanOrEqual(scene.clock() - 500);
    // 120 creatures and the walker, at the keyframe and at the horizon.
    for (const t of [d.t0, d.t1]) expect(nearbyAt(d, t)).toHaveLength(121);
    const named = nearbyAt(d, d.t1);
    expect(named.filter((u) => u.s.name === CANARY)).toHaveLength(20);
    expect(named.find((u) => u.ty === "player")!.s.name).toBe(CANARY_PLAYER);
    // Every spline the scene fed in the window, played where it ends once it has.
    const r = scene.guarded.source.state.nearby;
    let checked = 0;
    for (const obj of r.values()) {
      const m = obj.motion;
      if (m === undefined || m.value.destination === undefined || m.ts + 2_000 > d.t1 || m.ts < d.t0) continue;
      const at = nearbyAt(d, m.ts + 2_000).find((u) => u.id === obj.guid);
      expect(at).toBeDefined();
      expect(Math.abs(at!.x - m.value.destination.x)).toBeLessThanOrEqual(0.06);
      expect(Math.abs(at!.y - m.value.destination.y)).toBeLessThanOrEqual(0.06);
      checked++;
    }
    expect(checked).toBeGreaterThan(20);
    // Each poll's window was a window: decodable, keyed, never empty once the ring was.
    for (const s of seen) expect(decodeNearby(s.window).units.length).toBeGreaterThan(0);
    scene.trajectory.close();
    scene.nearby.stop();
    scene.trace.stop();
  }, 60_000);

  test("the real ticker drains the ring, and its stop removes it", async () => {
    const runs = tempDir("nearby-e2e-ticker-");
    const scene = await driveScene(runs, 1);
    const ring = join(scene.dir, "nearby");
    expect(existsSync(ring)).toBe(true);
    const before = readdirSync(ring).map((f) => readFileSync(join(ring, f), "utf8")).join("").length;
    // A change for the ticker to carry.
    scene.advance(1_000);
    const stop = startStateTicker({ builder: scene.builder, tickMs: 5, stopped: () => false });
    for (let i = 0; i < 40 && readdirSync(ring).map((f) => readFileSync(join(ring, f), "utf8")).join("").length === before; i++) await Bun.sleep(10);
    expect(readdirSync(ring).map((f) => readFileSync(join(ring, f), "utf8")).join("").length).toBeGreaterThan(before);
    await stop();
    expect(existsSync(ring)).toBe(false);
    expect(existsSync(join(scene.dir, "trajectory.jsonl"))).toBe(true);
    scene.trajectory.close();
    scene.nearby.stop();
    scene.trace.stop();
  }, 60_000);
});
