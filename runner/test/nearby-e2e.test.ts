/**
 * Nearby units end to end, on the real code at every step: the stack's
 * recorders (`@wrathbench/mcp/record/recorder`) over a real SDK cache fed
 * hand-written frames, their drains handed on a 5 s record tick to the
 * stack's `SessionWriter` writing the run's `session/` (the trace and events
 * beside the ring), the viewer's ring reader and codec decoding what the map
 * polls through the run's session source, and the session closing.
 *
 * What it proves is the boundary, not the drawing:
 * - the nearby recorder reads the cache and the broadcast hook and nothing
 *   else: its source throws on any action, raw opcode, consuming queue or
 *   other read;
 * - a canary name that exists only in the nearby input reaches the ring and no
 *   file outside it: not the trace, the events, `session.json` or `live.json`;
 * - a player in view is never in the ring, by unit or by name, and a target
 *   that is a player is "player" and nothing else;
 * - the ring holds at most its reach, unlinks the rest as it goes, and is gone
 *   when the session closes;
 * - what the viewer serves from it is what the recorder saw: every creature,
 *   its name, and each spline ending where the packet said.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { NEARBY_RING_MS, SEGMENT_MS, readSegmentBytes, validateSession, type NearbyRow } from "@wrathbench/mcp/record";
import { EventsRecorder, NearbyRecorder, TraceRecorder } from "@wrathbench/mcp/record/recorder";
import { removeSessionRing } from "../src/session-record";
import { SELF_GUID, guardedSource, nearbyRig, playerGuid, unitGuid } from "./fixtures/nearby-frames";
import { tempDirs } from "./fixtures/temp-dirs";
import { openTestSession, recordDrain } from "./fixtures/v1-session";
import { NEARBY_SPAN_MS, decodeNearby, nearbyAt, type NearbyWindow } from "../viewer/nearby";
import { nearbyFresh, readNearbyWindow } from "../viewer/nearby-ring";
import { sessionSource } from "../viewer/session-source";

const tempDir = tempDirs();

const RUN = "nearby-e2e-run";
/** A name fed only to the nearby path; finding it anywhere else is a leak. */
const CANARY = "Canarywing Nearbyhawk";
/** Another player's name: it must reach no file at all. */
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

/** A live session with a busy scene, driven for `minutes` of fake clock. Shared with the viewer's half of this test. */
function driveScene(runs: string, minutes: number, onTick?: (clock: number) => void) {
  const dir = join(runs, RUN);
  let clock = 1_760_000_000_000;
  const session = openTestSession(dir, clock);
  const r = nearbyRig();
  const guarded = guardedSource(r);
  const nearby = new NearbyRecorder({ state: guarded.source.state, events: guarded.source.events, now: () => clock, pollMs: 60_000 });
  const trace = new TraceRecorder({ state: r.state, events: r.events, now: () => clock, pollMs: 60_000 });
  const events = new EventsRecorder({ state: r.state, events: r.events, now: () => clock, pollMs: 60_000 });
  /** The host's record tick: everything the recorders latched, to the writer, on the same clock. */
  const ingest = (): void => {
    session.clock.now = clock;
    const t = trace.drain();
    const n = nearby.drain();
    session.writer.ingest(
      recordDrain({ trace: t.rows, ...(t.dict !== undefined ? { dict: t.dict } : {}), events: events.drain().rows, nearby: n.rows, through: n.through }),
    );
  };

  // The world: a login, a field of creatures (one of them the canary), and
  // another player walking past, whom the character targets for a while.
  events.start();
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
    // The character targets the walker for ten seconds, then the canary's first creature.
    if (s === 20) r.selfFields({ targetGuid: walker }, clock);
    if (s === 30) r.selfFields({ targetGuid: creatures[0]!.guid }, clock);
    nearby.poll();
    trace.poll();
    events.poll();
    if (clock - lastDrain >= 5_000) {
      ingest();
      lastDrain = clock;
      const ring = join(session.dir, "nearby");
      if (existsSync(ring)) maxFiles = Math.max(maxFiles, readdirSync(ring).length);
      onTick?.(clock);
    }
  }
  /** Move the clock on, with one more spline for the next tick to carry. */
  const advance = (ms: number): void => {
    clock += ms;
    const c = creatures[0]!;
    r.spline(c.guid, c.home, { x: c.home.x + 1, y: c.home.y, z: 80 }, 1_000, clock - 10);
    nearby.poll();
  };
  const stop = (): void => {
    nearby.stop();
    trace.stop();
    events.stop();
  };
  return { dir, session, guarded, walker, creatures, clock: () => clock, advance, ingest, stop, maxFiles, t0, end };
}

/** Every ring row on disk, oldest segment first. */
function ringRows(scene: ReturnType<typeof driveScene>): NearbyRow[] {
  return scene.session.reader.rows("nearby");
}

describe("nearby end to end: the ring is the only place the units go", () => {
  test("seventeen minutes of a busy scene: the ring keeps its reach, the record never sees a unit, no player is in either", async () => {
    const runs = tempDir("nearby-e2e-");
    const scene = driveScene(runs, 17);
    const reader = scene.session.reader;

    // The ring: at most its reach plus the segment being written, the oldest
    // segments already unlinked, every segment opening with a key.
    expect(scene.maxFiles).toBeLessThanOrEqual(NEARBY_RING_MS / SEGMENT_MS + 1);
    const kept = reader.segments("nearby").map((s) => s.t0);
    expect(kept[0]!).toBeGreaterThan(scene.t0);
    expect(kept[0]!).toBeGreaterThanOrEqual(scene.clock() - NEARBY_RING_MS - SEGMENT_MS);
    for (const seg of reader.segments("nearby")) expect(reader.segment("nearby", seg)[0]!.kind).toBe("key");
    const ringText = reader.segments("nearby").map((s) => readFileSync(s.path, "utf8")).join("");
    expect(ringText).toContain(CANARY);

    // No player in the ring: not the walker as a unit, not its name, and the
    // character's target on it is "player" only. The creatures are there.
    const rows = ringRows(scene);
    const unitIds = new Set<string>();
    const selfTargets: (string | null)[] = [];
    for (const row of rows) {
      if (row.kind === "key") {
        for (const u of row.units) unitIds.add(u.id);
        selfTargets.push(row.self.target);
      } else if (row.kind === "in") unitIds.add(row.u.id);
      else if (row.kind === "self" && row.self.target !== undefined) selfTargets.push(row.self.target);
      if ("id" in row) expect(row.id).not.toBe(scene.walker);
    }
    expect(unitIds.has(scene.creatures[0]!.guid)).toBe(true);
    expect(unitIds.size).toBe(scene.creatures.length);
    expect(unitIds.has(scene.walker)).toBe(false);
    expect(ringText).not.toContain(CANARY_PLAYER);
    expect(selfTargets).not.toContain(scene.walker);

    // The record: the trace and events were written, and neither the canaries
    // nor any ring row is in them, nor in the session's own files.
    const traced = reader.rows("trace");
    expect(traced.length).toBeGreaterThan(0);
    const outside = filesUnder(scene.session.dir).filter((p) => !p.startsWith("nearby/"));
    expect(outside).toContain("session.json");
    expect(outside).toContain("live.json");
    expect(outside.some((p) => p.startsWith("trace/"))).toBe(true);
    for (const p of outside) {
      // A closed segment is compressed: read it as a reader does.
      const bytes = p.endsWith(".zst") || p.endsWith(".jsonl") ? readSegmentBytes(join(scene.session.dir, p)) : readFileSync(join(scene.session.dir, p));
      const text = new TextDecoder().decode(bytes);
      for (const needle of [CANARY, CANARY_PLAYER, "Invented Beast", '"kind":"mv"', '"kind":"tick"']) {
        expect(`${p}: ${text.includes(needle)}`).toBe(`${p}: false`);
      }
    }
    // The trace's target on the walker is its kind only.
    const traceTargets = traced.map((r) => (r.data as { target?: unknown } | null | undefined)?.target).filter((t) => t !== undefined && t !== null);
    expect(traceTargets).toContainEqual({ kind: "player" });
    expect(traceTargets).toContainEqual(expect.objectContaining({ kind: "creature" }));
    // The session record is the run directory's only content: no run.sqlite, no ring beside it.
    expect(readdirSync(scene.dir)).toEqual(["session"]);

    // The recorder read the cache's three fields and the broadcast hook, and
    // nothing else: its source throws on everything else, and it never threw.
    expect([...scene.guarded.reads].sort()).toEqual(["events.on", "state.creatures", "state.nearby", "state.self"]);
    scene.stop();
    scene.session.clock.now = scene.clock();
    await scene.session.writer.close();
    expect(validateSession(scene.session.dir).errors).toEqual([]);
  }, 60_000);

  test("the viewer reads back what the recorder saw: the creatures, their names, and where each spline puts them", async () => {
    const runs = tempDir("nearby-e2e-viewer-");
    const seen: { clock: number; window: ReturnType<typeof readNearbyWindow> }[] = [];
    const scene = driveScene(runs, 3, (clock) => {
      // What the live map's poll asks for, as the drains land.
      if (seen.length < 40) seen.push({ clock, window: readNearbyWindow(runs, RUN, NEARBY_SPAN_MS, clock) });
    });
    expect(sessionSource(runs, RUN).kind).toBe("v1");
    const last = readNearbyWindow(runs, RUN, NEARBY_SPAN_MS, scene.clock());
    const d = decodeNearby(JSON.parse(JSON.stringify(last)) as NearbyWindow);
    expect(d.t0).toBe(scene.clock() - NEARBY_SPAN_MS);
    expect(d.t1).toBeGreaterThanOrEqual(scene.clock() - 500);
    // 120 creatures, at the keyframe and at the horizon; the walker at neither.
    for (const t of [d.t0, d.t1]) {
      const units = nearbyAt(d, t);
      expect(units).toHaveLength(120);
      expect(units.some((u) => u.id === scene.walker || (u.ty as string) === "player")).toBe(false);
    }
    const named = nearbyAt(d, d.t1);
    expect(named.filter((u) => u.s.name === CANARY)).toHaveLength(20);
    expect(JSON.stringify(last)).not.toContain(CANARY_PLAYER);
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
    expect(seen.length).toBeGreaterThan(10);
    for (const s of seen) expect(decodeNearby(s.window).units.length).toBeGreaterThan(0);
    // The character's target on the walker is "player" in the ring, never its
    // guid; on a creature it is the creature's (nothing is pruned in three minutes).
    const selfTargets = scene.session.reader
      .rows("nearby")
      .flatMap((row) => (row.kind === "key" ? [row.self.target] : row.kind === "self" && row.self.target !== undefined ? [row.self.target] : []));
    expect(selfTargets).toContain("player");
    expect(selfTargets).toContain(scene.creatures[0]!.guid);
    expect(selfTargets).not.toContain(scene.walker);
    // A window read from a later segment alone decodes: the segment's key restates the scene.
    const segs = scene.session.reader.segments("nearby");
    expect(segs.length).toBeGreaterThanOrEqual(1);
    const lastKey = scene.session.reader.segment("nearby", segs[segs.length - 1]!)[0]!;
    expect(lastKey.kind).toBe("key");
    if (lastKey.kind === "key") {
      expect(lastKey.self.guid).toBe(SELF_GUID);
      expect(lastKey.units.filter((u) => u.s.name === CANARY)).toHaveLength(20);
    }
    scene.stop();
    scene.session.clock.now = scene.clock();
    await scene.session.writer.close();
    expect(validateSession(scene.session.dir).errors).toEqual([]);
  }, 60_000);

  test("the record tick carries the ring on, the session's close removes it, and the runner's backstop does too", async () => {
    const runs = tempDir("nearby-e2e-close-");
    const scene = driveScene(runs, 1);
    const ring = join(scene.session.dir, "nearby");
    expect(existsSync(ring)).toBe(true);
    const size = (): number => readdirSync(ring).map((f) => readFileSync(join(ring, f), "utf8")).join("").length;
    const before = size();
    // A change for the next tick to carry.
    scene.advance(1_000);
    scene.ingest();
    expect(size()).toBeGreaterThan(before);
    scene.stop();
    scene.session.clock.now = scene.clock();
    await scene.session.writer.close();
    // The ring is gone; the record stays, closed, and reads as an empty window.
    expect(existsSync(ring)).toBe(false);
    expect(scene.session.reader.rows("trace").length).toBeGreaterThan(0);
    expect(scene.session.reader.session()?.ended).toBe(scene.clock());
    expect(readNearbyWindow(runs, RUN, NEARBY_SPAN_MS, scene.clock()).ids).toEqual([]);
    expect(validateSession(scene.session.dir).errors).toEqual([]);

    // A writer that never closes (a backstop exit) leaves its ring: the runner's
    // `removeSessionRing` takes it away, and the map stops calling it fresh.
    const runs2 = tempDir("nearby-e2e-backstop-");
    const dead = driveScene(runs2, 1);
    dead.stop();
    expect(existsSync(join(dead.session.dir, "nearby"))).toBe(true);
    expect(nearbyFresh(runs2, RUN, Date.now())).toBe(true);
    removeSessionRing(dead.dir);
    expect(existsSync(join(dead.session.dir, "nearby"))).toBe(false);
    expect(nearbyFresh(runs2, RUN, Date.now())).toBe(false);
    expect(existsSync(join(dead.session.dir, "session.json"))).toBe(true);
  }, 60_000);
});
