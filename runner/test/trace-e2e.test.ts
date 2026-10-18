/**
 * The trace end to end, on the real code at every step: the sandbox child's
 * recorder over a real SDK state cache fed hand-written frames (as
 * `trace-recorder.test.ts` feeds it), the host's `TraceWriter` folding and
 * keying windows, a real `run.sqlite` written by `Trajectory.recordTrace`, the
 * viewer's `trace-db.ts` reading it back, and the codec decoding what the
 * viewer encoded. What the player gets out must be what the recorder put in.
 *
 * Also here: the storage contract has two spellings, the runner's
 * (`src/trace-row.ts`, rows with parsed `data`) and the browser-safe codec's
 * (`viewer/api-types.ts` and `viewer/trace.ts`, the sqlite row with `data` as
 * text). The codec cannot import `runner/src` — it ships to the browser over
 * `@viewer/*` and imports nothing — so the two are pinned compatible here, at
 * the type level and at runtime.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { EventStream, StateCache } from "@wrathbench/sdk";
import type { SandboxHost } from "../src/sandbox/host";
import { TraceRecorder } from "../src/sandbox/trace-recorder";
import { TraceWriter } from "../src/trace";
import {
  emptyTraceState as writerEmptyState,
  TRACE_WINDOW_MS,
  type TraceKind,
  type TraceRow as WriterRow,
  type TraceState as WriterState,
} from "../src/trace-row";
import { Trajectory } from "../src/trajectory";
import type { TraceState as ViewerState } from "../viewer/api-types";
import {
  GAP_MS,
  Q_O,
  SEG_MS,
  SETTLE_MS,
  STATE_KEYS,
  decodeSegment,
  emptyTraceState as viewerEmptyState,
  sampleAt,
  stateAt,
  unpackSegs,
  type DecodedSegment,
  type TraceRow as ViewerRow,
} from "../viewer/trace";
import { readTraceIndex, readTraceSegment } from "../viewer/trace-db";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();

/* --------------------------------------------------------- the contract --- */

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
/** A compile-time assertion: the file does not typecheck unless `T` is `true`. */
function pin<T extends true>(): T {
  return true as T;
}

describe("the two spellings of the contract", () => {
  test("the state keys are the same keys, and a state the writer folds is one the codec reads", () => {
    // Type level: identical key sets, and the writer's state assignable to the
    // codec's (the codec's auras also admit the public three-element form).
    expect(pin<Equal<keyof WriterState, keyof ViewerState>>()).toBe(true);
    expect(pin<WriterState extends ViewerState ? true : false>()).toBe(true);
    expect(pin<Equal<WriterState["target"], ViewerState["target"]>>()).toBe(true);
    expect(pin<Equal<WriterState["cast"], ViewerState["cast"]>>()).toBe(true);
    // Runtime: the same keys in the codec's order, the same empty state.
    expect<string[]>([...STATE_KEYS].sort()).toEqual(Object.keys(writerEmptyState()).sort());
    expect(viewerEmptyState()).toEqual(writerEmptyState());
  });

  test("a row the writer stores is a row the codec reads: the same columns, the same kinds, one window", () => {
    expect(pin<Equal<keyof WriterRow, keyof ViewerRow>>()).toBe(true);
    expect(pin<TraceKind extends ViewerRow["kind"] ? true : false>()).toBe(true);
    expect(pin<Equal<Exclude<WriterRow["map"], undefined>, ViewerRow["map"]>>()).toBe(true);
    expect(pin<Equal<Exclude<WriterRow["x"], undefined>, ViewerRow["x"]>>()).toBe(true);
    expect(pin<Equal<Exclude<WriterRow["o"], undefined>, ViewerRow["o"]>>()).toBe(true);
    expect(pin<Equal<WriterRow["ts"], ViewerRow["ts"]>>()).toBe(true);
    // `data` is parsed on the writer's side and the column's text on the codec's.
    expect(pin<ViewerRow["data"] extends string | null ? true : false>()).toBe(true);
    expect(TRACE_WINDOW_MS).toBe(SEG_MS);
  });
});

/* ------------------------------------------------------- end to end --- */

/** A window boundary; the run straddles W1. */
const W0 = 1_760_000_100_000;
const W1 = W0 + SEG_MS;
const RUN = "trace-e2e-run";

/** A creature guid with high type 0xF130 and entry 299, as the recorder's own test builds one. */
const CREATURE_GUID = ((0xf130n << 48n) | (299n << 24n) | 41n).toString(10);

describe("the trace end to end", () => {
  test("a walk across a window boundary, an aura, a hearth and a flight come back as recorded", async () => {
    const runs = tempDir("trace-e2e-");
    const trajectory = new Trajectory(join(runs, RUN));

    // The child: a real cache and stream, fed by hand, and the recorder over them.
    const events = new EventStream({ url: "ws://worldserver:8086/events", token: "t", reconnect: false });
    const cache = new StateCache({ seed: { guid: "7", name: "Fenwick" } });
    events.onAny((e) => cache.apply(e));
    let clock = W0 + 270_000;
    const rec = new TraceRecorder({ state: cache, events, now: () => clock, pollMs: 60_000 });
    let seq = 1;
    const feed = (opcode: string, opcodeId: number, data: unknown, ts: number): void => {
      clock = ts;
      events.ingest(JSON.stringify({ seq: seq++, opcode, opcodeId, ts, data }));
    };
    const selfFields = (fields: Record<string, unknown>, ts: number): void =>
      feed("SMSG_UPDATE_OBJECT", 0xa9, { blocks: 1, objects: [{ update: "values", guid: "7", fields }] }, ts);

    // The host: the real writer, draining the child on its ticker.
    const writer = new TraceWriter({
      runId: RUN,
      trajectory,
      sandbox: { traceDrain: () => Promise.resolve(rec.drain()) } as unknown as SandboxHost,
      now: () => clock,
      log: () => {},
    });
    let lastDrain = clock;
    const tick = async (): Promise<void> => {
      rec.poll();
      // The ticker's own cadence: a drain every 5 s of clock.
      if (clock - lastDrain >= 5_000) {
        await writer.drain();
        lastDrain = clock;
      }
    };

    rec.start();
    feed("SMSG_LOGIN_VERIFY_WORLD", 0x236, { map: 0, x: -8949, y: -132, z: 83.5, o: 1.0 }, W0 + 271_000);
    selfFields({ health: 120, maxHealth: 120, powerType: 0, power1: 80, maxPower1: 100, level: 5, xp: 300, nextLevelXp: 1400, unitFlags: 0x8 }, W0 + 271_100);
    await tick();

    // A walk east at about 7 yd/s, across the window boundary at W1.
    let x = -8949;
    for (let ts = W0 + 272_000; ts <= W1 + 20_000; ts += 1000) {
      x += 7;
      feed("WB_MOVE_PROGRESS", 0xff02, { moveId: 1, pos: { x, y: -132 + (ts - W0) / 10_000, z: 83.5, o: 1.0 } }, ts);
      // A buff lands just after the boundary, a fight takes some health.
      if (ts === W1 + 5_000) {
        feed("SMSG_AURA_UPDATE", 0x496, { targetGuid: "7", auras: [{ slot: 0, spellId: 1126, flags: 0x13, level: 5, stacks: 1, duration: 1_800_000, maxDuration: 1_800_000 }] }, ts + 10);
      }
      if (ts === W0 + 290_000) selfFields({ targetGuid: CREATURE_GUID, health: 95 }, ts + 20);
      if (ts === W0 + 295_000) selfFields({ targetGuid: "0", health: 101 }, ts + 20);
      await tick();
    }
    const beforeHearth = { x, y: -132 + (W1 + 20_000 - W0) / 10_000 };

    // A hearth: the server's teleport ack about self, then a few steps.
    const HEARTH = W1 + 25_000;
    feed("MSG_MOVE_TELEPORT_ACK", 0xc7, { guid: "7", flags: 0, pos: { x: -4821, y: -1155, z: 502, o: 1.7 } }, HEARTH);
    await tick();
    for (let i = 1; i <= 3; i++) {
      feed("WB_MOVE_PROGRESS", 0xff02, { moveId: 2, pos: { x: -4821 + i, y: -1155, z: 502, o: 1.7 } }, HEARTH + i * 1000);
      await tick();
    }

    // A flight: the spline a tick ahead of the flag, the flag, a minute aloft, the landing.
    const TAKEOFF = W1 + 40_000;
    feed("SMSG_ACTIVATETAXIREPLY", 0x1ae, { reply: 0, ok: true }, TAKEOFF - 100);
    feed("SMSG_MONSTER_MOVE", 0xdd, { guid: "7", pos: { x: -4818, y: -1155, z: 502 }, destination: { x: -5418, y: -2955, z: 352 }, durationMs: 60_000 }, TAKEOFF - 50);
    selfFields({ unitFlags: 0x100008 }, TAKEOFF);
    await tick();
    for (let ts = TAKEOFF + 5_000; ts < TAKEOFF + 60_000; ts += 5_000) {
      clock = ts;
      await tick();
    }
    selfFields({ unitFlags: 0x8 }, TAKEOFF + 60_000);
    await tick();
    clock = TAKEOFF + 70_000;
    await writer.drain();
    rec.stop();

    const stored = trajectory.traceRows(RUN);
    // The host keyed the second window at its start, from its fold.
    expect(stored.some((r) => r.kind === "key" && r.ts === W1)).toBe(true);
    expect(stored.filter((r) => r.kind === "flight")).toHaveLength(1);
    expect(stored.some((r) => r.kind === "pos" && (r.data as { jump?: number } | null)?.jump === 1 && r.ts === HEARTH)).toBe(true);

    // run.sqlite is the trace's one home: every row the viewer reads back
    // below came from there, and nothing else in the run directory holds one.
    expect(readdirSync(join(runs, RUN)).filter((f) => f !== "run.sqlite" && f !== "trajectory.jsonl")).toEqual([]);

    // The viewer, once both windows have settled.
    const now = W1 + SEG_MS + SETTLE_MS;
    const index = readTraceIndex(runs, RUN, now);
    expect(unpackSegs(index.segs)).toEqual([W0, W1]);
    expect(index.tail).toBeNull();
    const segs: DecodedSegment[] = [W0, W1].map((t0) => {
      const found = readTraceSegment(runs, RUN, t0, now)!;
      expect(found.closed).toBe(true);
      return decodeSegment(JSON.parse(JSON.stringify(found.segment)));
    });
    const frames = segs.flatMap((s) => s.frames);
    const segOf = (ts: number): DecodedSegment => segs.find((s) => ts >= s.t0 && ts < s.t1)!;

    // Every recorded position, where it was recorded.
    const samples = stored.filter((r) => r.kind === "pos" || r.kind === "flight");
    expect(samples.length).toBeGreaterThan(50);
    for (const r of samples) {
      const p = sampleAt(frames, r.ts)!;
      expect(`${r.ts - W0} map ${p.map}`).toBe(`${r.ts - W0} map ${r.map}`);
      expect(Math.abs(p.x - r.x!)).toBeLessThanOrEqual(0.05 + 1e-9);
      expect(Math.abs(p.y - r.y!)).toBeLessThanOrEqual(0.05 + 1e-9);
      expect(Math.abs(p.z - r.z!)).toBeLessThanOrEqual(0.05 + 1e-9);
      if (r.kind === "pos") expect(Math.abs(((p.o - r.o! + 3 * Math.PI) % (2 * Math.PI)) - Math.PI)).toBeLessThanOrEqual(Math.PI / Q_O + 1e-9);
    }
    // Between two walking samples the player is on the line; across the window
    // boundary too, with no stutter at the seam.
    for (const t of [W0 + 280_500, W1 - 500, W1, W1 + 500]) {
      const a = sampleAt(frames, t - 500)!;
      const b = sampleAt(frames, t + 500)!;
      const mid = sampleAt(frames, t)!;
      expect(mid.x).toBeCloseTo((a.x + b.x) / 2, 1);
    }
    // The hearth is held into, never drawn through.
    const held = sampleAt(frames, HEARTH - 1)!;
    expect(held.x).toBeCloseTo(beforeHearth.x, 1);
    expect(sampleAt(frames, HEARTH)!.x).toBeCloseTo(-4821, 1);
    // Halfway through the flight, halfway along it; then down at its end.
    const aloft = sampleAt(frames, TAKEOFF + 30_000)!;
    expect(aloft.flying).toBe(true);
    expect(aloft.x).toBeCloseTo((-4818 + -5418) / 2, 0);
    expect(aloft.y).toBeCloseTo((-1155 + -2955) / 2, 0);
    expect(sampleAt(frames, TAKEOFF + 60_000)).toMatchObject({ flying: false });
    expect(sampleAt(frames, TAKEOFF + 60_000)!.x).toBeCloseTo(-5418, 1);
    expect(GAP_MS).toBeLessThan(60_000);

    // Every recorded state, at its moment: fold the stored rows as the writer
    // does and ask the codec at each row's time.
    let fold = writerEmptyState();
    for (const r of stored) {
      if (r.kind === "key") fold = { ...writerEmptyState(), ...(r.data as WriterState) };
      else if (r.kind === "state") fold = { ...fold, ...(r.data as Partial<WriterState>) };
      else continue;
      expect(stateAt(segOf(r.ts), r.ts)).toEqual(fold);
    }
    // Spot checks against what was fed, not only against the fold.
    expect(stateAt(segOf(W1 + 6_000), W1 + 6_000).auras).toEqual([[1126, 1, W1 + 5_010 + 1_800_000, 0x13]]);
    expect(stateAt(segOf(W0 + 291_000), W0 + 291_000)).toMatchObject({ hp: 95, target: { kind: "creature", entry: 299 } });
    expect(stateAt(segOf(W0 + 296_000), W0 + 296_000)).toMatchObject({ hp: 101, target: null });
    expect(stateAt(segOf(TAKEOFF + 30_000), TAKEOFF + 30_000).taxi).toBe(true);
    expect(stateAt(segOf(TAKEOFF + 65_000), TAKEOFF + 65_000).taxi).toBe(false);
    // The second window's keyframe is the host's key: the state at W1, whole.
    expect(segs[1]!.key).toMatchObject({ hp: 101, level: 5, pwType: 0, combat: false });
  });
});
