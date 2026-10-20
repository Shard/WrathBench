/**
 * The trace codec (`runner/viewer/trace.ts`): what a segment carries, what
 * decoding it gives back, and how the player reads a position and a state off
 * it. Every fixture is built in the recorder's row shape, the one `run.sqlite`
 * holds, so the codec is tested against the contract rather than against
 * itself.
 */

import { describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import {
  CONTEXT_MS,
  GAP_MS,
  Q_O,
  Q_POS,
  SEG_MS,
  SETTLE_MS,
  decodeSegment,
  emptyTraceState,
  encodeSegment,
  isClosed,
  packSegs,
  sampleAt,
  segRunsAdd,
  segRunsHas,
  stateAt,
  tailStart,
  traceSegmentKey,
  unpackSegs,
  windowOf,
  type TraceRow,
  type TraceSegment,
  type TraceState,
} from "../viewer/trace";
import { projectTraceSegment } from "../viewer/public-projection";

/** A window boundary well inside the epoch-ms range real rows carry. */
const T0 = 1_760_000_100_000;
const RUN = "trace-run-1";
const W = { run: RUN, t0: T0, t1: T0 + SEG_MS };

const pos = (ts: number, map: number, x: number, y: number, z: number | null, o: number | null, data: object | null = null): TraceRow => ({
  ts,
  kind: "pos",
  map,
  x,
  y,
  z,
  o,
  data: data === null ? null : JSON.stringify(data),
});
const state = (ts: number, data: Partial<TraceState>): TraceRow => ({
  ts,
  kind: "state",
  map: null,
  x: null,
  y: null,
  z: null,
  o: null,
  data: JSON.stringify(data),
});
const key = (ts: number, s: Partial<TraceState>, at: [number, number, number, number, number] | null = null): TraceRow => ({
  ts,
  kind: "key",
  map: at?.[0] ?? null,
  x: at?.[1] ?? null,
  y: at?.[2] ?? null,
  z: at?.[3] ?? null,
  o: at?.[4] ?? null,
  data: JSON.stringify({ ...emptyTraceState(), ...s }),
});
const flight = (ts: number, from: [number, number, number, number, number], to: { map: number; x: number; y: number; z: number }, durationMs: number): TraceRow => ({
  ts,
  kind: "flight",
  map: from[0],
  x: from[1],
  y: from[2],
  z: from[3],
  o: from[4],
  data: JSON.stringify({ to, durationMs }),
});

/** A seeded PRNG, so the "realistic" fixture is the same fixture every run. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Five minutes of play at the recorder's cadence: a walk at run speed with
 * turns and a hill, a fight in the middle (health and power ticking, a target,
 * casts, a debuff), and the buffs it started with — the window a live
 * character actually fills, not a best case.
 */
function realisticWindow(seed = 7): TraceRow[] {
  const r = rng(seed);
  const rows: TraceRow[] = [];
  const buffs: [number, number, number, number][] = [
    [1126, 1, T0 + 1_500_000, 19],
    [21562, 1, T0 + 1_700_000, 19],
    [1243, 1, T0 + 1_650_000, 19],
  ];
  rows.push(key(T0, { hp: 1200, hpMax: 1200, pw: 900, pwMax: 1000, pwType: 0, level: 14, xp: 3200, xpMax: 9800, auras: buffs }, [0, -9460.4, 62.1, 56.3, 1.2]));
  let x = -9460.4;
  let y = 62.1;
  let z = 56.3;
  let o = 1.2;
  let ts = T0;
  let hp = 1200;
  let pw = 900;
  while (ts < T0 + SEG_MS - 1200) {
    ts += 950 + Math.floor(r() * 100);
    const fighting = ts > T0 + 120_000 && ts < T0 + 165_000;
    if (!fighting) {
      o = (o + (r() - 0.5) * 0.3 + 2 * Math.PI) % (2 * Math.PI);
      const step = 7 * (ts - (rows.at(-1)?.ts ?? T0)) / 1000;
      x += Math.cos(o) * Math.min(step, 7.5);
      y += Math.sin(o) * Math.min(step, 7.5);
      z += (r() - 0.45) * 0.6;
      rows.push(pos(ts, 0, x, y, z, o));
    } else if (r() < 0.4) {
      // Shuffling about in melee: small steps and facing changes.
      o = (o + (r() - 0.5) * 1.2 + 2 * Math.PI) % (2 * Math.PI);
      rows.push(pos(ts, 0, x + (r() - 0.5), y + (r() - 0.5), z, o));
    }
    if (fighting && r() < 0.5) {
      hp = Math.max(300, hp - Math.floor(r() * 60));
      pw = Math.max(0, pw - Math.floor(r() * 40));
      rows.push(state(ts + 3, { hp, pw }));
    }
    if (ts > T0 + 120_000 && ts < T0 + 121_100) {
      rows.push(state(ts + 5, { combat: true, target: { kind: "creature", entry: 299, hpPct: 100 }, cast: { spellId: 133, endsAt: ts + 3000 } }));
    }
    if (ts > T0 + 140_000 && ts < T0 + 141_100) rows.push(state(ts + 7, { auras: [...buffs, [11366, 1, ts + 12_000, 9]] }));
    if (ts > T0 + 165_000 && ts < T0 + 166_100) {
      rows.push(state(ts + 9, { combat: false, target: null, cast: null, xp: 3460, auras: buffs }));
    }
    if (!fighting && hp < 1200 && r() < 0.3) {
      hp = Math.min(1200, hp + 40);
      rows.push(state(ts + 11, { hp }));
    }
  }
  return rows;
}

const near = (a: number, b: number, tol: number): boolean => Math.abs(a - b) <= tol + 1e-9;
/** The angular distance, the short way round. */
const angDiff = (a: number, b: number): number => {
  const d = Math.abs(a - b) % (2 * Math.PI);
  return Math.min(d, 2 * Math.PI - d);
};

/* ------------------------------------------------------------- module --- */

describe("trace module", () => {
  test("has no runtime imports, so the dashboard can bundle it", async () => {
    const src = await Bun.file(new URL("../viewer/trace.ts", import.meta.url).pathname).text();
    // Type-only imports are erased; anything else would follow it into the browser.
    expect(src).not.toMatch(/^\s*import\s+(?!type\b)/m);
    expect(src).not.toMatch(/\brequire\s*\(/);
  });
});

/* ------------------------------------------------------------ windows --- */

describe("windows", () => {
  test("a segment's public key encodes the run id like every per-run key", () => {
    expect(traceSegmentKey("fleet-a-b-20261018-a2", T0)).toBe(`v1/run/fleet-a-b-20261018-a2/trace/${T0}.json`);
    expect(traceSegmentKey("odd id/#1", T0)).toBe(`v1/run/odd%20id%2F%231/trace/${T0}.json`);
  });

  test("windows are UTC-aligned five-minute boundaries", () => {
    expect(SEG_MS).toBe(300_000);
    expect(windowOf(T0)).toBe(T0);
    expect(windowOf(T0 + SEG_MS - 1)).toBe(T0);
    expect(windowOf(T0 - 1)).toBe(T0 - SEG_MS);
  });

  test("a window closes SETTLE_MS after it ends, and the tail starts at the first one that has not", () => {
    const end = T0 + SEG_MS;
    expect(isClosed(T0, end)).toBe(false);
    expect(isClosed(T0, end + SETTLE_MS - 1)).toBe(false);
    expect(isClosed(T0, end + SETTLE_MS)).toBe(true);
    expect(tailStart(end + SETTLE_MS - 1)).toBe(T0);
    expect(tailStart(end + SETTLE_MS)).toBe(end);
    // Every window is either closed or at/after the tail's start: none is in neither.
    for (let now = T0; now < T0 + 3 * SEG_MS; now += 7_000) {
      for (let w = T0 - SEG_MS; w <= windowOf(now); w += SEG_MS) {
        expect(isClosed(w, now) !== w >= tailStart(now)).toBe(true);
      }
    }
  });

  test("window lists pack to runs of consecutive windows and back", () => {
    const t0s = [T0, T0 + SEG_MS, T0 + 2 * SEG_MS, T0 + 5 * SEG_MS, T0 + 6 * SEG_MS, T0 + 9 * SEG_MS];
    const runs = packSegs([...t0s].reverse().concat(T0));
    expect(runs).toEqual([
      [T0, 3],
      [T0 + 5 * SEG_MS, 2],
      [T0 + 9 * SEG_MS, 1],
    ]);
    expect(unpackSegs(runs)).toEqual(t0s);
    expect(segRunsHas(runs, T0 + 6 * SEG_MS)).toBe(true);
    expect(segRunsHas(runs, T0 + 7 * SEG_MS)).toBe(false);
    expect(segRunsHas(runs, T0 + 1)).toBe(false);
    // Adding the gap's two windows joins the middle runs to the last.
    expect(segRunsAdd(segRunsAdd(runs, T0 + 7 * SEG_MS), T0 + 8 * SEG_MS)).toEqual([
      [T0, 3],
      [T0 + 5 * SEG_MS, 5],
    ]);
    expect(segRunsAdd(runs, T0)).toEqual(runs);
  });
});

/* ---------------------------------------------------------- round trip --- */

describe("round trip", () => {
  test("every sample comes back where it was, and the state at every moment is the recorded one", () => {
    const rows = realisticWindow();
    const seg = encodeSegment(rows, W);
    // Through the wire, as a reader gets it.
    const back = decodeSegment(JSON.parse(JSON.stringify(seg)) as TraceSegment);
    const samples = rows.filter((r) => r.kind === "pos");
    // The keyframe's position first (the key row's, at t0), then one frame per sample.
    expect(back.frames).toHaveLength(samples.length + 1);
    expect(back.frames[0]).toMatchObject({ t: T0, map: 0, cut: false });
    samples.forEach((r, i) => {
      const f = back.frames[i + 1]!;
      expect(f.t).toBe(r.ts);
      expect(f.map).toBe(r.map!);
      expect(near(f.x, r.x!, 0.05)).toBe(true);
      expect(near(f.y, r.y!, 0.05)).toBe(true);
      expect(near(f.z, r.z!, 0.05)).toBe(true);
      expect(angDiff(f.o, r.o!) <= Math.PI / Q_O + 1e-9).toBe(true);
      expect(f.cut).toBe(false);
    });

    // State: fold the rows by hand and compare at each row's moment.
    let expected: TraceState = emptyTraceState();
    for (const r of rows) {
      const data = JSON.parse(r.data ?? "{}") as Partial<TraceState>;
      if (r.kind === "key") expected = { ...emptyTraceState(), ...data };
      else if (r.kind === "state") expected = { ...expected, ...data };
      else continue;
      expect(stateAt(back, r.ts)).toEqual(expected);
    }
    expect(back.key.level).toBe(14);
    expect(stateAt(back, T0 + 130_000).target).toEqual({ kind: "creature", entry: 299, hpPct: 100 });
    expect(stateAt(back, T0 + 200_000).combat).toBe(false);
  });

  test("a map change and a jump are cuts, carrying the map from them on", () => {
    const rows = [
      key(T0, {}, [0, 100, 100, 10, 0]),
      pos(T0 + 1000, 0, 101, 100, 10, 0),
      pos(T0 + 2000, 0, -8000, 500, 90, 1, { jump: 1 }),
      pos(T0 + 3000, 0, -8001, 500, 90, 1),
      pos(T0 + 4000, 1, 1600, -4400, 10, 2),
    ];
    const seg = encodeSegment(rows, W);
    expect(seg.cuts).toEqual([
      [1, 0],
      [3, 1],
    ]);
    const frames = decodeSegment(seg).frames;
    expect(frames.map((f) => [f.map, f.cut])).toEqual([
      [0, false],
      [0, false],
      [0, true],
      [0, false],
      [1, true],
    ]);
  });

  test("a sample with no z or o carries the last one", () => {
    const rows = [key(T0, {}, [0, 0, 0, 12, 1]), pos(T0 + 1000, 0, 5, 0, null, null), pos(T0 + 2000, 0, 10, 0, 14, null)];
    const frames = decodeSegment(encodeSegment(rows, W)).frames;
    expect(frames[1]!.z).toBe(12);
    expect(frames[2]!.z).toBe(14);
    expect(angDiff(frames[2]!.o, 1)).toBeLessThanOrEqual(Math.PI / Q_O + 1e-9);
  });
});

/* ------------------------------------------------------- quantisation --- */

describe("quantisation", () => {
  test("positions decode within half a unit (0.05 yd) and orientation within half a step, with no drift", () => {
    const r = rng(42);
    const rows: TraceRow[] = [key(T0, {}, [530, 0, 0, 0, 0])];
    // A long walk of awkward values, so error would accumulate if deltas were
    // quantised rather than positions.
    for (let i = 1; i < 290; i++) {
      rows.push(pos(T0 + i * 1000, 530, -12_000 + r() * 24_000, -12_000 + r() * 24_000, -500 + r() * 1000, r() * 2 * Math.PI));
    }
    const frames = decodeSegment(encodeSegment(rows, W)).frames;
    let worstPos = 0;
    let worstO = 0;
    rows.slice(1).forEach((row, i) => {
      const f = frames[i + 1]!;
      worstPos = Math.max(worstPos, Math.abs(f.x - row.x!), Math.abs(f.y - row.y!), Math.abs(f.z - row.z!));
      worstO = Math.max(worstO, angDiff(f.o, row.o!));
    });
    expect(worstPos).toBeLessThanOrEqual(0.5 / Q_POS + 1e-9);
    expect(worstO).toBeLessThanOrEqual(Math.PI / Q_O + 1e-9);
  });

  test("orientation deltas go the short way round, so a turn through north is one small step", () => {
    const rows = [key(T0, {}, [0, 0, 0, 0, 2 * Math.PI - 0.01]), pos(T0 + 1000, 0, 1, 0, 0, 0.01)];
    const seg = encodeSegment(rows, W);
    expect(Math.abs(seg.o[0]!)).toBeLessThanOrEqual(4);
  });
});

/* --------------------------------------------------------- determinism --- */

describe("determinism", () => {
  test("the same rows encode to byte-identical output", () => {
    const a = JSON.stringify(encodeSegment(realisticWindow(), W));
    const b = JSON.stringify(encodeSegment(realisticWindow(), W));
    expect(a).toBe(b);
    // Context and rows past the window change nothing they should not.
    const rows = realisticWindow();
    const withPast = [...rows, pos(T0 + SEG_MS + 10, 0, 1, 1, 1, 1)];
    expect(JSON.stringify(encodeSegment(withPast, W))).toBe(a);
  });

  test("keys come out in one fixed order, whatever order the row's JSON had", () => {
    const rows = [key(T0, { hp: 10, hpMax: 20 }), state(T0 + 1000, { pw: 5, hp: 9 } as Partial<TraceState>)];
    const reordered = [rows[0]!, { ...rows[1]!, data: '{"hp":9,"pw":5}' }];
    expect(JSON.stringify(encodeSegment(rows, W))).toBe(JSON.stringify(encodeSegment(reordered, W)));
    const seg = encodeSegment(rows, W);
    expect(Object.keys(seg)).toEqual(["v", "run", "t0", "t1", "q", "k", "dt", "x", "y", "z", "o", "cuts", "flights", "ev"]);
    expect(seg.ev).toEqual([
      [1000, "hp", 9],
      [1000, "pw", 5],
    ]);
  });
});

/* ----------------------------------------------------------- keyframe --- */

describe("the keyframe and the caller's contract", () => {
  test("with no key row in the window, the state is folded from the context the caller passes", () => {
    const rows = [
      key(T0 - 200_000, { hp: 100, hpMax: 100, level: 5 }),
      state(T0 - 100_000, { hp: 80, combat: true }),
      pos(T0 - 1_000, 0, 10, 10, 0, 0),
      state(T0 + 5_000, { hp: 90 }),
    ];
    const seg = encodeSegment(rows, W);
    expect(seg.k.s).toMatchObject({ hp: 80, hpMax: 100, level: 5, combat: true });
    // Context is never emitted: the only event is the window's own.
    expect(seg.ev).toEqual([[5000, "hp", 90]]);
    expect(seg.dt).toEqual([]);
    // The position held from the context, observed a second before t0.
    expect(seg.k.p).toEqual([0, 100, 100, 0, 0]);
    expect(seg.k.pt).toBe(-1000);
  });

  test("with no context at all, the window's first key row seeds the keyframe", () => {
    const rows = [state(T0 + 1_000, { hp: 50 }), key(T0 + 4_000, { hp: 60, hpMax: 100 }, [0, 5, 5, 0, 0]), state(T0 + 9_000, { hp: 70 })];
    const seg = encodeSegment(rows, W);
    expect(seg.k.s).toMatchObject({ hp: 60, hpMax: 100 });
    expect(seg.ev).toEqual([[9000, "hp", 70]]);
    expect(seg.k.p).toEqual([0, 50, 50, 0, 0]);
    expect(seg.k.pt).toBe(4_000);
  });

  test("a second key row mid-window is a change against the fold, not a second keyframe", () => {
    const rows = [key(T0, { hp: 100, level: 5 }), key(T0 + 60_000, { hp: 100, level: 6 })];
    const seg = encodeSegment(rows, W);
    expect(seg.ev).toEqual([[60_000, "level", 6]]);
  });

  test("walking across t0, the keyframe sits on the line between the samples either side", () => {
    const rows = [pos(T0 - 500, 0, 0, 0, 0, 0), pos(T0 + 500, 0, 10, 0, 0, 0)];
    const seg = encodeSegment(rows, W);
    expect(seg.k.p).toEqual([0, 50, 0, 0, 0]);
    expect(seg.k.pt).toBeUndefined();
    // Laid end to end with the window before, the walk does not stutter at the seam.
    const prev = decodeSegment(encodeSegment(rows, { run: RUN, t0: T0 - SEG_MS, t1: T0 }));
    const frames = [...prev.frames, ...decodeSegment(seg).frames];
    for (const t of [T0 - 400, T0 - 1, T0, T0 + 250]) {
      expect(sampleAt(frames, t)!.x).toBeCloseTo(((t - (T0 - 500)) / 1000) * 10, 6);
    }
  });

  test("a flight in the air at t0 continues from where it has got to", () => {
    const rows = [
      flight(T0 - 60_000, [0, 0, 0, 0, 0], { map: 0, x: 1200, y: 0, z: 100 }, 120_000),
      pos(T0 + 60_000, 0, 1200, 0, 100, 0),
    ];
    const seg = encodeSegment(rows, W);
    expect(seg.k.p).toEqual([0, 6000, 0, 500, 0]);
    expect(seg.k.f).toEqual([0, 12000, 0, 1000, 60_000]);
    const back = decodeSegment(seg);
    expect(back.flights).toEqual([{ frame: 0, t: T0, map: 0, x: 1200, y: 0, z: 100, ms: 60_000 }]);
    expect(sampleAt(back.frames, T0 + 30_000)).toMatchObject({ x: 900, flying: true });
  });
});

/* ------------------------------------------------------------ playback --- */

describe("playback", () => {
  const seg = decodeSegment(
    encodeSegment(
      [
        key(T0, {}, [0, 0, 0, 0, 0]),
        pos(T0 + 1000, 0, 7, 0, 0, 0),
        pos(T0 + 2000, 0, 14, 0, 0, 0.5),
        // A long pause, then a step.
        pos(T0 + 12_000, 0, 20, 0, 0, 0.5),
        // A hearth.
        pos(T0 + 13_000, 0, 9000, 9000, 0, 0.5, { jump: 1 }),
        pos(T0 + 14_000, 0, 9007, 9000, 0, 2 * Math.PI - 0.1),
        // Through a portal.
        pos(T0 + 15_000, 1, -500, -500, 0, 0),
        flight(T0 + 20_000, [1, -500, -500, 0, 0], { map: 1, x: 500, y: -500, z: 0 }, 100_000),
        pos(T0 + 125_000, 1, 500, -500, 0, 0),
      ],
      W,
    ),
  );

  test("positions interpolate linearly between close samples", () => {
    expect(sampleAt(seg.frames, T0 + 500)).toMatchObject({ map: 0, x: 3.5, flying: false });
    expect(sampleAt(seg.frames, T0 + 1500)!.x).toBeCloseTo(10.5, 6);
    expect(sampleAt(seg.frames, T0 + 1500)!.o).toBeCloseTo(0.25, 2);
  });

  test("orientation blends the short way round", () => {
    // From 0.5 rad to 2π − 0.1, the short way is back through north.
    const mid = sampleAt(seg.frames, T0 + 13_500)!;
    expect(angDiff(mid.o, 0.2)).toBeLessThan(0.01);
  });

  test("a gap longer than GAP_MS holds the earlier sample", () => {
    expect(GAP_MS).toBe(5_000);
    expect(sampleAt(seg.frames, T0 + 11_999)!.x).toBeCloseTo(14, 6);
    expect(sampleAt(seg.frames, T0 + 12_000)!.x).toBeCloseTo(20, 6);
  });

  test("a jump and a map change are held into, never drawn through", () => {
    expect(sampleAt(seg.frames, T0 + 12_999)!.x).toBeCloseTo(20, 6);
    expect(sampleAt(seg.frames, T0 + 13_000)!.x).toBeCloseTo(9000, 6);
    expect(sampleAt(seg.frames, T0 + 14_999)).toMatchObject({ map: 0 });
    expect(sampleAt(seg.frames, T0 + 14_999)!.x).toBeCloseTo(9007, 6);
    expect(sampleAt(seg.frames, T0 + 15_000)).toMatchObject({ map: 1, x: -500 });
  });

  test("a flight flies straight to its destination over its duration, facing it, and holds there", () => {
    expect(seg.flights).toHaveLength(1);
    expect(sampleAt(seg.frames, T0 + 70_000)).toMatchObject({ map: 1, x: 0, y: -500, flying: true });
    expect(sampleAt(seg.frames, T0 + 70_000)!.o).toBeCloseTo(0, 6);
    expect(sampleAt(seg.frames, T0 + 121_000)).toMatchObject({ x: 500, flying: false });
  });

  test("before the first frame there is no position; after the last, it holds", () => {
    expect(sampleAt(seg.frames, T0 - 1)).toBeNull();
    expect(sampleAt(seg.frames, T0 + SEG_MS)).toMatchObject({ map: 1, x: 500 });
    expect(sampleAt([], T0)).toBeNull();
  });

  test("with no position before the first sample, that sample is a cut", () => {
    const s = encodeSegment([pos(T0 + 1000, 1, 10, 10, 0, 0), pos(T0 + 2000, 1, 11, 10, 0, 0)], W);
    expect(s.k.p).toBeNull();
    expect(s.cuts).toEqual([[0, 1]]);
    expect(s.x[0]).toBe(100);
    const frames = decodeSegment(s).frames;
    expect(frames[0]).toMatchObject({ t: T0 + 1000, map: 1, x: 10, cut: true });
    expect(sampleAt(frames, T0 + 500)).toBeNull();
  });
});

/* ---------------------------------------------------------- versioning --- */

describe("versioning", () => {
  test("additive keys are ignored and unknown event kinds skipped", () => {
    const seg = encodeSegment([key(T0, { hp: 5 }), state(T0 + 1000, { hp: 6 })], W);
    const future = {
      ...seg,
      extra: { anything: true },
      k: { ...seg.k, s: { ...seg.k.s, mood: "great" }, z2: 1 },
      ev: [[500, "weather", "rain"], ...seg.ev, [2000, "hp", "not-a-number"]],
    } as unknown as TraceSegment;
    const back = decodeSegment(future);
    expect(back.events).toEqual([{ t: T0 + 1000, kind: "hp", value: 6 }]);
    expect("mood" in back.key).toBe(false);
  });

  test("a segment of another version is refused rather than misread", () => {
    const seg = encodeSegment([key(T0, {})], W);
    expect(() => decodeSegment({ ...seg, v: 2 })).toThrow(/v2/);
  });
});

/* ---------------------------------------------------------------- chat --- */

describe("chat", () => {
  const said = (ts: number, ...lines: [string, string][]): TraceRow => ({ ...state(ts, {}), data: JSON.stringify({ chat: lines }) });

  test("each line the character said is one event, in order, decoded with its kind and text; never in a keyframe", () => {
    const rows = [
      key(T0 - 10_000, { hp: 5 }),
      said(T0 - 5_000, ["say", "before the window: context, not an event"]),
      said(T0 + 1_000, ["party", "pulling"]),
      state(T0 + 1_500, { hp: 6 }),
      said(T0 + 2_000, ["yell", "run"], ["say", "twice"]),
      said(T0 + 2_000, ["say", "twice"]),
      said(T0 + 3_000, ["guild", "an unknown kind"], ["say", ""], ["whisper", "x".repeat(300)]),
    ];
    const seg = encodeSegment(rows, W);
    expect(JSON.stringify(seg.k)).not.toContain("chat");
    expect(seg.ev.filter((e) => e[1] === "chat")).toEqual([
      [1000, "chat", ["party", "pulling"]],
      [2000, "chat", ["yell", "run"]],
      [2000, "chat", ["say", "twice"]],
      [2000, "chat", ["say", "twice"]],
      [3000, "chat", ["whisper", "x".repeat(255)]],
    ]);
    const back = decodeSegment(seg);
    expect(back.chat).toEqual([
      { t: T0 + 1000, kind: "party", text: "pulling" },
      { t: T0 + 2000, kind: "yell", text: "run" },
      { t: T0 + 2000, kind: "say", text: "twice" },
      { t: T0 + 2000, kind: "say", text: "twice" },
      { t: T0 + 3000, kind: "whisper", text: "x".repeat(255) },
    ]);
    // Chat is no state: the unit events and the sheet do not see it.
    expect(back.events).toEqual([{ t: T0 + 1500, kind: "hp", value: 6 }]);
    expect(stateAt(back, T0 + 3000).hp).toBe(6);
  });

  test("a line said before a keyframe taken from inside the window is still an event", () => {
    const seg = encodeSegment([said(T0 + 500, ["say", "first"]), key(T0 + 1_000, { hp: 5 }), said(T0 + 2_000, ["say", "second"])], W);
    expect(decodeSegment(seg).chat.map((c) => c.text)).toEqual(["first", "second"]);
  });

  test("a decoder from before chat skips it, and one with chat reads a segment from before it as silence", () => {
    const seg = encodeSegment([key(T0, { hp: 5 }), said(T0 + 1_000, ["say", "hi"])], W);
    expect(decodeSegment({ ...seg, ev: seg.ev.filter((e) => e[1] !== "chat") }).chat).toEqual([]);
    // Malformed chat values are dropped, never misread.
    const odd = { ...seg, ev: [[100, "chat", "hi"], [200, "chat", ["say"]], [300, "chat", [7, "x"]], ...seg.ev] } as unknown as TraceSegment;
    expect(decodeSegment(odd).chat).toEqual([{ t: T0 + 1000, kind: "say", text: "hi" }]);
  });
});

/* ---------------------------------------------------------------- size --- */

describe("size", () => {
  test("a realistic 1 Hz five-minute window, raw and gzipped", () => {
    const rows = realisticWindow();
    const body = JSON.stringify(encodeSegment(rows, W));
    const gz = gzipSync(Buffer.from(body)).length;
    const samples = rows.filter((r) => r.kind === "pos").length;
    const events = rows.filter((r) => r.kind === "state").length;
    console.log(`trace segment: ${samples} samples, ${events} state rows -> ${body.length} B raw, ${gz} B gzipped`);
    // Generous ceilings: the point is the order of magnitude a pass uploads.
    expect(body.length).toBeLessThan(10_000);
    expect(gz).toBeLessThan(4_000);
    // The context bound the viewer reads is three windows.
    expect(CONTEXT_MS).toBe(3 * SEG_MS);
  });

  test("a window of solid combat, with the target's health re-emitted four times a second", () => {
    // The recorder re-emits `target` on every hpPct change, so a long fight is
    // the private segment's worst case; the public one drops the target whole.
    const rows = realisticWindow();
    for (let ts = T0 + 1000; ts < T0 + SEG_MS; ts += 250) {
      rows.push(state(ts + 13, { target: { kind: "creature", entry: 299, hpPct: 100 - Math.floor(((ts - T0) % 30_000) / 300) } }));
      if ((ts - T0) % 2000 === 1000) rows.push(state(ts + 17, { hp: 400 + ((ts - T0) % 700), pw: (ts - T0) % 1000 }));
    }
    const seg = encodeSegment(rows, W);
    const body = JSON.stringify(seg);
    const gz = gzipSync(Buffer.from(body)).length;
    const pub = JSON.stringify(projectTraceSegment(seg));
    const pubGz = gzipSync(Buffer.from(pub)).length;
    console.log(`trace segment, solid combat: ${seg.ev.length} events -> private ${body.length} B raw, ${gz} B gzipped; public ${pub.length} B raw, ${pubGz} B gzipped`);
    expect(body.length).toBeLessThan(120_000);
    expect(pub.length).toBeLessThan(20_000);
  });
});
