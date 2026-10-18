/**
 * Trace v1: one character's movement and unit state, packed per five-minute
 * window — the codec the viewer serves, the publisher uploads and the
 * dashboard's player decodes.
 *
 * The recorder (`runner/src/`) writes rows to `run.sqlite` table `trace`:
 * `key` (full state), `pos` (a position sample, `{"jump":1}` when it was not
 * reached by travel), `state` (the changed keys only; `auras` whole) and
 * `flight` (a taxi takeoff, `{"to":{map,x,y,z},"durationMs"}`). This file turns
 * one window of them into a segment and back.
 *
 * **Segment.** One run × one UTC-aligned window `[t0, t1)`, `t1 = t0 + SEG_MS`,
 * self-contained: it decodes alone. Columnar JSON, keys in this order:
 *
 * - `v` 1; `run`; `t0`, `t1` (epoch ms); `q: {p: 10, o: 1024}` — positions in
 *   1/10 yd, orientation in 1/1024 turn. Decoders read `q`, not the constants.
 * - `k`, the keyframe. `p: [map, x, y, z, o]` quantised absolute — where the
 *   character was at `t0` (interpolated between the samples either side when
 *   they are close and continuous) or null if no position was known. `pt` is
 *   the ms from `t0` at which that position was observed, absent when 0. `s`
 *   is the full `TraceState` at `t0`. `f: [map, x, y, z, ms]` is a flight still
 *   in the air at `t0`: its destination and the ms left.
 * - `dt`, `x`, `y`, `z`, `o`: one entry per sample. `dt` is ms since the
 *   previous sample (the first since `t0`); the rest are integer deltas from
 *   the previous sample (the first from `k.p`, or from 0 when it is null),
 *   `o` wrapped to the short way round. A null z or o carries the last one.
 * - `cuts: [[i, map]]`: sample `i` was a jump or landed on another map, and
 *   `map` is the map from it on. Never interpolated into. With `k.p` null the
 *   first sample is always one.
 * - `flights: [[i, map, x, y, z, ms]]`: sample `i` is a taxi takeoff; it flies
 *   straight to the quantised absolute destination over `ms`.
 * - `ev: [[ms, kind, value]]`: state changes after the keyframe, `ms` from `t0`,
 *   `kind` a `TraceState` key, in recorded order.
 *
 * **Versioning.** A decoder ignores keys it does not know and skips events of
 * kinds it does not know, so a field or an event kind is added without a bump;
 * `v` moves only when a meaning changes, and a v1 decoder refuses anything else.
 *
 * **Playback** (`sampleAt`): positions interpolate linearly, orientation the
 * short way round. A sample is held, not interpolated out of, into a cut,
 * across a map change and across a gap longer than `GAP_MS`; a takeoff flies
 * straight to its destination over its duration and holds there until the
 * landing sample.
 *
 * Imports nothing but wire types, like `sessions.ts`: the dashboard reaches it
 * over the `@viewer/*` alias at runtime, so nothing server-side may follow it
 * into the browser bundle. The sqlite side is `trace-db.ts`.
 */

import type {
  TraceAura,
  TraceCast,
  TraceEventWire,
  TraceKeyframe,
  TraceSegment,
  TraceSegRuns,
  TraceState,
  TraceTarget,
} from "./api-types";

export type { TraceAura, TraceCast, TraceEventWire, TraceKeyframe, TraceSegment, TraceSegRuns, TraceState, TraceTarget };

export const TRACE_VERSION = 1;

/** One window. UTC-aligned, so every reader cuts the same boundaries. */
export const SEG_MS = 300_000;

/**
 * How long after its end a window is still taken to be growing.
 *
 * The recorder buffers rows in the sandbox child and the host drains them on
 * its 5 s ticker, so a row observed just before `t1` reaches `run.sqlite` up to
 * a drain later — longer when the drain waits on a busy sqlite (5 s timeout) or
 * a slow RPC, and the row's stamp is the child's clock while the reader's is
 * another pod's. A closed segment is immutable for a year at the edge, so a
 * row that landed after it was published would be lost for good; a minute is
 * twelve drains of margin and costs only that the tail is a minute longer.
 */
export const SETTLE_MS = 60_000;

/**
 * How far before `t0` a caller reads to seed the keyframe. Three windows: the
 * recorder writes a `key` row in every window it is live for, so this always
 * holds one, and a taxi flight in the air at `t0` took off inside it.
 */
export const CONTEXT_MS = 3 * SEG_MS;

/** Samples further apart than this are held, not interpolated between. */
export const GAP_MS = 5_000;

export const Q_POS = 10;
export const Q_O = 1024;

/** `TraceState`'s keys, in the order every keyframe and event list uses. */
export const STATE_KEYS = [
  "hp",
  "hpMax",
  "pw",
  "pwMax",
  "pwType",
  "level",
  "xp",
  "xpMax",
  "auras",
  "combat",
  "mounted",
  "taxi",
  "dead",
  "ghost",
  "resting",
  "target",
  "cast",
] as const;
export type TraceStateKey = (typeof STATE_KEYS)[number];

/** A row as `run.sqlite` holds it (`data` is the column's JSON text). */
export interface TraceRow {
  ts: number;
  kind: string;
  map: number | null;
  x: number | null;
  y: number | null;
  z: number | null;
  o: number | null;
  data: string | null;
}

export interface TraceWindow {
  run: string;
  t0: number;
  t1: number;
}

/* ------------------------------------------------------------- windows --- */

/** The window a timestamp falls in. */
export function windowOf(ts: number, segMs = SEG_MS): number {
  return Math.floor(ts / segMs) * segMs;
}

/**
 * The first window that is not closed at `now`: every window before it ended at
 * least `SETTLE_MS` ago. It is also where the tail starts.
 */
export function tailStart(now: number, segMs = SEG_MS): number {
  return windowOf(now - SETTLE_MS, segMs);
}

/** Whether the window at `t0` is closed — settled, so its segment never changes. */
export function isClosed(t0: number, now: number, segMs = SEG_MS): boolean {
  return t0 < tailStart(now, segMs);
}

/**
 * A closed window's object key in the public bucket, the one place it is built:
 * the publisher uploads to it and the snapshot client fetches it, so the two
 * cannot drift. The run id is encoded as every other per-run key is
 * (`snapshot.ts`), so an id with a reserved character still names one object.
 */
export function traceSegmentKey(runId: string, t0: number): string {
  return `v1/run/${encodeURIComponent(runId)}/trace/${t0}.json`;
}

/** Window `t0`s to runs of consecutive windows, sorted and deduplicated. */
export function packSegs(t0s: readonly number[], segMs = SEG_MS): TraceSegRuns {
  const out: TraceSegRuns = [];
  for (const t of [...new Set(t0s)].sort((a, b) => a - b)) {
    const last = out[out.length - 1];
    if (last !== undefined && last[0] + last[1] * segMs === t) last[1] += 1;
    else out.push([t, 1]);
  }
  return out;
}

/** Runs back to every window `t0`, ascending. */
export function unpackSegs(runs: TraceSegRuns, segMs = SEG_MS): number[] {
  const out: number[] = [];
  for (const [first, count] of runs) for (let i = 0; i < count; i++) out.push(first + i * segMs);
  return out;
}

export function segRunsHas(runs: TraceSegRuns, t0: number, segMs = SEG_MS): boolean {
  return runs.some(([first, count]) => t0 >= first && t0 < first + count * segMs && (t0 - first) % segMs === 0);
}

/** `runs` with `t0` added, as a fresh list. */
export function segRunsAdd(runs: TraceSegRuns, t0: number, segMs = SEG_MS): TraceSegRuns {
  return segRunsHas(runs, t0, segMs) ? runs.map(([a, b]): [number, number] => [a, b]) : packSegs([...unpackSegs(runs, segMs), t0], segMs);
}

/* --------------------------------------------------------------- state --- */

export function emptyTraceState(): TraceState {
  return {
    hp: null,
    hpMax: null,
    pw: null,
    pwMax: null,
    pwType: null,
    level: null,
    xp: null,
    xpMax: null,
    auras: [],
    combat: false,
    mounted: false,
    taxi: false,
    dead: false,
    ghost: false,
    resting: false,
    target: null,
    cast: null,
  };
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
/** `undefined` is "not a valid value for this key", and the key is then left alone. */
const numOrNull = (v: unknown): number | null | undefined => (v === null ? null : finite(v) ? v : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : v === 1 ? true : v === 0 ? false : undefined);

function aura(v: unknown): TraceAura | undefined {
  if (!Array.isArray(v) || v.length < 3) return undefined;
  const [id, stacks, expiresAt, flags] = v as unknown[];
  if (!finite(id) || !finite(stacks) || !finite(expiresAt)) return undefined;
  return finite(flags) ? [id, stacks, expiresAt, flags] : [id, stacks, expiresAt];
}

const TARGET_KINDS = new Set(["creature", "player", "object", "other"]);

/**
 * Each key's reader: the value rebuilt fresh in a fixed shape, or `undefined`
 * when the input is not one. Typed over every key, so a key added to
 * `TraceState` does not compile until it has one.
 */
const SANITIZE: { [K in TraceStateKey]: (v: unknown) => TraceState[K] | undefined } = {
  hp: numOrNull,
  hpMax: numOrNull,
  pw: numOrNull,
  pwMax: numOrNull,
  pwType: numOrNull,
  level: numOrNull,
  xp: numOrNull,
  xpMax: numOrNull,
  auras: (v) => (v === null ? [] : Array.isArray(v) ? v.map(aura).filter((a): a is TraceAura => a !== undefined) : undefined),
  combat: bool,
  mounted: bool,
  taxi: bool,
  dead: bool,
  ghost: bool,
  resting: bool,
  target: (v): TraceTarget | null | undefined => {
    if (v === null) return null;
    if (typeof v !== "object" || Array.isArray(v)) return undefined;
    const o = v as Record<string, unknown>;
    if (typeof o["kind"] !== "string" || !TARGET_KINDS.has(o["kind"])) return undefined;
    return {
      kind: o["kind"] as TraceTarget["kind"],
      ...(finite(o["entry"]) ? { entry: o["entry"] } : {}),
      ...(finite(o["hpPct"]) ? { hpPct: o["hpPct"] } : {}),
    };
  },
  cast: (v): TraceCast | null | undefined => {
    if (v === null) return null;
    if (typeof v !== "object" || Array.isArray(v)) return undefined;
    const o = v as Record<string, unknown>;
    return finite(o["spellId"]) && finite(o["endsAt"]) ? { spellId: o["spellId"], endsAt: o["endsAt"] } : undefined;
  },
};

/** Whether `kind` names a state key this decoder knows. */
export function isStateKey(kind: unknown): kind is TraceStateKey {
  return typeof kind === "string" && Object.hasOwn(SANITIZE, kind);
}

/** One key's value, sanitized; `undefined` when it is not a valid one. */
export function sanitizeStateValue<K extends TraceStateKey>(key: K, v: unknown): TraceState[K] | undefined {
  return SANITIZE[key](v) as TraceState[K] | undefined;
}

function setKey(s: TraceState, key: TraceStateKey, value: unknown): void {
  (s as unknown as Record<string, unknown>)[key] = value;
}

/** A full state from a keyframe's object: missing or invalid keys read as empty. */
export function stateOf(o: unknown): TraceState {
  const s = emptyTraceState();
  if (o === null || typeof o !== "object" || Array.isArray(o)) return s;
  for (const key of STATE_KEYS) {
    const v = SANITIZE[key]((o as Record<string, unknown>)[key]);
    if (v !== undefined) setKey(s, key, v);
  }
  return s;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function parseData(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    const v = JSON.parse(text) as unknown;
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/* ----------------------------------------------------------- positions --- */

const TURN = 2 * Math.PI;
/** `+ 0` folds a `-0` into `0`, so the wire never depends on which side a round fell. */
const int = (v: number): number => Math.round(v) + 0;
const qp = (v: number): number => int(v * Q_POS);
const qo = (rad: number): number => ((int((rad / TURN) * Q_O) % Q_O) + Q_O) % Q_O;
/** An orientation delta in units, the short way round: [−q/2, q/2). */
const wrap = (d: number, q: number): number => ((((d + q / 2) % q) + q) % q) - q / 2;

interface Pos {
  ts: number;
  map: number;
  x: number;
  y: number;
  z: number | null;
  o: number | null;
}

interface Flight {
  ts: number;
  from: Pos;
  to: { map: number; x: number; y: number; z: number | null };
  ms: number;
}

function posOf(r: TraceRow): Pos | null {
  if (!finite(r.map) || !finite(r.x) || !finite(r.y)) return null;
  return { ts: r.ts, map: r.map, x: r.x, y: r.y, z: finite(r.z) ? r.z : null, o: finite(r.o) ? r.o : null };
}

function flightOf(r: TraceRow, from: Pos): Flight | null {
  const data = parseData(r.data);
  const to = data?.["to"];
  if (to === null || typeof to !== "object" || Array.isArray(to)) return null;
  const t = to as Record<string, unknown>;
  const ms = data?.["durationMs"];
  if (!finite(t["map"]) || !finite(t["x"]) || !finite(t["y"]) || !finite(ms) || ms <= 0) return null;
  return { ts: r.ts, from, to: { map: t["map"], x: t["x"], y: t["y"], z: finite(t["z"]) ? t["z"] : null }, ms };
}

const isSample = (r: TraceRow): boolean => (r.kind === "pos" || r.kind === "flight") && posOf(r) !== null;
/** A sample the character did not travel to: `{"jump":1}` on a `pos` row. */
function isJump(r: TraceRow): boolean {
  if (r.kind !== "pos") return false;
  const j = parseData(r.data)?.["jump"];
  return j !== undefined && j !== null && j !== 0 && j !== false;
}

const lerp = (a: number, b: number, f: number): number => a + (b - a) * f;

/** Shortest-arc blend of two orientations in radians, into [0, 2π). */
function arc(a: number, b: number, f: number): number {
  let d = (b - a) % TURN;
  if (d > Math.PI) d -= TURN;
  if (d < -Math.PI) d += TURN;
  return (((a + d * f) % TURN) + TURN) % TURN;
}

/** The heading from one point to another, as WoW measures orientation; `fallback` when they coincide. */
function heading(ax: number, ay: number, bx: number, by: number, fallback: number): number {
  if (ax === bx && ay === by) return fallback;
  return (Math.atan2(by - ay, bx - ax) + TURN) % TURN;
}

/* -------------------------------------------------------------- encode --- */

/**
 * Encode one window. Deterministic: the same rows give byte-identical output.
 *
 * **The caller's contract.** `rows` are the run's rows with `ts` in
 * `[t0 − CONTEXT_MS, t1)`, in write order (`ts` ascending, ties by rowid).
 * Rows before `t0` are context: they seed the keyframe and are never emitted.
 * The keyframe is exact when the context reaches back to a `key` row (the
 * recorder writes one per live window, so `CONTEXT_MS` holds three), and a
 * flight in the air at `t0` carries on only when its takeoff is in it. With no
 * `key` row in the context the window's own first `key` row seeds the
 * keyframe, folding in the state of the rows before it inside the window (their
 * positions stay samples). Rows at or after `t1` are ignored. A window with no
 * rows of its own still encodes — to a keyframe and nothing else — so whether
 * that is worth serving is the caller's call.
 */
export function encodeSegment(rows: readonly TraceRow[], window: TraceWindow): TraceSegment {
  const { run, t0, t1 } = window;
  // Stable, so rows the caller handed over in rowid order keep it on a tie.
  const sorted = [...rows].filter((r) => finite(r.ts) && r.ts < t1).sort((a, b) => a.ts - b.ts);
  const firstIn = sorted.findIndex((r) => r.ts >= t0);
  const context = firstIn === -1 ? sorted : sorted.slice(0, firstIn);
  const inWindow = firstIn === -1 ? [] : sorted.slice(firstIn);

  // The context, folded: the state, the last position sample, a flight with no
  // sample since its takeoff, and the newest key row's position as a last resort.
  let state = emptyTraceState();
  let contextKey = false;
  let lastPos: Pos | null = null;
  let flight: Flight | null = null;
  let keyPos: Pos | null = null;
  for (const r of context) {
    if (r.kind === "key") {
      state = stateOf(parseData(r.data));
      contextKey = true;
      keyPos = posOf(r) ?? keyPos;
    } else if (r.kind === "state") {
      state = merged(state, parseData(r.data)).state;
    } else if (r.kind === "pos" || r.kind === "flight") {
      const p = posOf(r);
      if (p === null) continue;
      lastPos = p;
      flight = r.kind === "flight" ? flightOf(r, p) : null;
    }
  }

  // No key row before the window: its own first key row stands in for one.
  let eventsFrom = 0;
  if (!contextKey) {
    const at = inWindow.findIndex((r) => r.kind === "key");
    if (at !== -1) {
      // A key row is the whole state, so the state rows before it inside the
      // window are already folded into it; their positions stay samples.
      state = stateOf(parseData(inWindow[at]!.data));
      eventsFrom = at + 1;
      if (lastPos === null && keyPos === null && !inWindow.slice(0, at).some(isSample)) keyPos = posOf(inWindow[at]!);
    }
  }

  // Where the character stood at t0.
  const first = inWindow.find(isSample);
  let base: Pos | null = null;
  let pt = 0;
  let inFlight: [number, number, number, number, number] | undefined;
  if (flight !== null && flight.to.map === flight.from.map) {
    // Still in the air, or landed by the clock with no landing sample yet.
    const elapsed = t0 - flight.ts;
    const o = heading(flight.from.x, flight.from.y, flight.to.x, flight.to.y, flight.from.o ?? 0);
    const toZ = flight.to.z ?? flight.from.z;
    if (elapsed < flight.ms) {
      const f = elapsed / flight.ms;
      const z = flight.from.z === null || toZ === null ? toZ : lerp(flight.from.z, toZ, f);
      base = { ts: t0, map: flight.from.map, x: lerp(flight.from.x, flight.to.x, f), y: lerp(flight.from.y, flight.to.y, f), z, o };
      inFlight = [flight.to.map, qp(flight.to.x), qp(flight.to.y), qp(toZ ?? 0), int(flight.ms - elapsed)];
    } else {
      base = { ts: flight.ts + flight.ms, map: flight.to.map, x: flight.to.x, y: flight.to.y, z: toZ, o };
      pt = int(flight.ts + flight.ms - t0);
    }
  } else if (lastPos !== null) {
    const next = first === undefined ? null : posOf(first);
    if (next !== null && !isJump(first!) && next.map === lastPos.map && next.ts - lastPos.ts <= GAP_MS && next.ts > lastPos.ts) {
      const f = (t0 - lastPos.ts) / (next.ts - lastPos.ts);
      const z = lastPos.z === null || next.z === null ? (lastPos.z ?? next.z) : lerp(lastPos.z, next.z, f);
      const o = lastPos.o === null || next.o === null ? (lastPos.o ?? next.o) : arc(lastPos.o, next.o, f);
      base = { ts: t0, map: lastPos.map, x: lerp(lastPos.x, next.x, f), y: lerp(lastPos.y, next.y, f), z, o };
    } else {
      base = lastPos;
      pt = int(lastPos.ts - t0);
    }
  } else if (keyPos !== null) {
    base = keyPos;
    pt = int(keyPos.ts - t0);
  }

  const kp: [number, number, number, number, number] | null =
    base === null ? null : [base.map, qp(base.x), qp(base.y), qp(base.z ?? 0), qo(base.o ?? 0)];
  const s: Partial<TraceState> = {};
  for (const key of STATE_KEYS) setKey(s as TraceState, key, state[key]);
  const k: TraceKeyframe = { p: kp, ...(pt !== 0 ? { pt } : {}), s, ...(inFlight !== undefined ? { f: inFlight } : {}) };

  // The samples.
  const dt: number[] = [];
  const xs: number[] = [];
  const ys: number[] = [];
  const zs: number[] = [];
  const os: number[] = [];
  const cuts: [number, number][] = [];
  const flights: [number, number, number, number, number, number][] = [];
  let prevT = t0;
  let [prevMap, prevX, prevY, prevZ, prevO] = kp ?? [null, 0, 0, 0, 0];
  for (const r of inWindow) {
    if (!isSample(r)) continue;
    const p = posOf(r)!;
    const i = dt.length;
    const qx = qp(p.x);
    const qy = qp(p.y);
    const qz = p.z === null ? prevZ : qp(p.z);
    const qO = p.o === null ? prevO : qo(p.o);
    dt.push(int(r.ts - prevT));
    xs.push(qx - prevX);
    ys.push(qy - prevY);
    zs.push(qz - prevZ);
    os.push(wrap(qO - prevO, Q_O) + 0);
    if (prevMap === null || p.map !== prevMap || isJump(r)) cuts.push([i, p.map]);
    if (r.kind === "flight") {
      const fl = flightOf(r, p);
      if (fl !== null) flights.push([i, fl.to.map, qp(fl.to.x), qp(fl.to.y), qp(fl.to.z ?? p.z ?? 0), int(fl.ms)]);
    }
    [prevT, prevMap, prevX, prevY, prevZ, prevO] = [r.ts, p.map, qx, qy, qz, qO];
  }

  // The state changes after the keyframe.
  const ev: TraceEventWire[] = [];
  for (const r of inWindow.slice(eventsFrom)) {
    if (r.kind !== "state" && r.kind !== "key") continue;
    const data = parseData(r.data);
    // A key row mid-window (the child restarted, or reattached) is a full
    // state: what differs from the running fold is what changed.
    const whole = r.kind === "key" ? stateOf(data) : null;
    const prev = state;
    const next = whole === null ? merged(state, data) : { state: whole, changed: STATE_KEYS.filter((key) => !same(whole[key], prev[key])) };
    for (const key of next.changed) ev.push([int(r.ts - t0), key, next.state[key]]);
    state = next.state;
  }

  return { v: TRACE_VERSION, run, t0, t1, q: { p: Q_POS, o: Q_O }, k, dt, x: xs, y: ys, z: zs, o: os, cuts, flights, ev };
}

/** A partial state row applied: the new state and the keys that actually changed, in key order. */
function merged(state: TraceState, data: Record<string, unknown> | null): { state: TraceState; changed: TraceStateKey[] } {
  const next = { ...state };
  const changed: TraceStateKey[] = [];
  if (data === null) return { state: next, changed };
  for (const key of STATE_KEYS) {
    if (!Object.hasOwn(data, key)) continue;
    const v = SANITIZE[key](data[key]);
    if (v === undefined || same(v, state[key])) continue;
    setKey(next, key, v);
    changed.push(key);
  }
  return { state: next, changed };
}

/* -------------------------------------------------------------- decode --- */

/** A flight's destination and duration, on the frame that takes off. */
export interface TraceFlightTo {
  map: number;
  x: number;
  y: number;
  z: number;
  ms: number;
}

/** One position, in yards and radians, at epoch ms `t`. */
export interface TraceFrame {
  t: number;
  map: number;
  x: number;
  y: number;
  z: number;
  o: number;
  /** Reached by a jump or onto another map: never interpolated into. */
  cut: boolean;
  /** Present on a takeoff: where it flies to, and how long it takes. */
  fly?: TraceFlightTo;
}

/** A flight, listed for drawing: which frame takes off, and where to. */
export interface TraceFlight extends TraceFlightTo {
  frame: number;
  t: number;
}

export type TraceEvent = { [K in TraceStateKey]: { t: number; kind: K; value: TraceState[K] } }[TraceStateKey];

export interface DecodedSegment {
  run: string;
  t0: number;
  t1: number;
  /** The keyframe's position (when it had one) first, then every sample. */
  frames: TraceFrame[];
  flights: TraceFlight[];
  /** The state at `t0`. A key the segment does not carry reads as empty. */
  key: TraceState;
  /** State changes, by time. */
  events: TraceEvent[];
}

const numAt = (a: unknown, i: number): number => {
  const v = Array.isArray(a) ? (a as unknown[])[i] : undefined;
  return finite(v) ? v : 0;
};

/** Decode a segment (a v1 one: anything else throws, since its meaning has changed). */
export function decodeSegment(seg: TraceSegment): DecodedSegment {
  if (seg.v !== TRACE_VERSION) throw new Error(`trace segment v${String(seg.v)}: this decoder reads v${TRACE_VERSION}`);
  const qP = finite(seg.q?.p) && seg.q.p > 0 ? seg.q.p : Q_POS;
  const qO = finite(seg.q?.o) && seg.q.o > 0 ? seg.q.o : Q_O;
  const rad = (u: number): number => ((((u % qO) + qO) % qO) / qO) * TURN;
  const frames: TraceFrame[] = [];
  const flights: TraceFlight[] = [];

  const fly = (map: number, x: number, y: number, z: number, ms: number): TraceFlightTo => ({ map, x: x / qP, y: y / qP, z: z / qP, ms });
  const kp = Array.isArray(seg.k?.p) ? seg.k.p : null;
  // The running position in quantised units, from the keyframe's (or from 0).
  let map = kp === null ? 0 : numAt(kp, 0);
  let cx = kp === null ? 0 : numAt(kp, 1);
  let cy = kp === null ? 0 : numAt(kp, 2);
  let cz = kp === null ? 0 : numAt(kp, 3);
  let co = kp === null ? 0 : numAt(kp, 4);
  if (kp !== null) {
    const f = Array.isArray(seg.k.f) ? seg.k.f : null;
    const frame: TraceFrame = {
      t: seg.t0 + (finite(seg.k.pt) ? seg.k.pt : 0),
      map,
      x: cx / qP,
      y: cy / qP,
      z: cz / qP,
      o: rad(co),
      cut: false,
      ...(f === null ? {} : { fly: fly(numAt(f, 0), numAt(f, 1), numAt(f, 2), numAt(f, 3), numAt(f, 4)) }),
    };
    frames.push(frame);
    if (frame.fly !== undefined) flights.push({ frame: 0, t: frame.t, ...frame.fly });
  }

  const cuts = new Map<number, number>();
  for (const c of Array.isArray(seg.cuts) ? seg.cuts : []) if (Array.isArray(c) && finite(c[0]) && finite(c[1])) cuts.set(c[0], c[1]);
  const takeoffs = new Map<number, TraceFlightTo>();
  for (const f of Array.isArray(seg.flights) ? seg.flights : []) {
    if (Array.isArray(f) && finite(f[0])) takeoffs.set(f[0], fly(numAt(f, 1), numAt(f, 2), numAt(f, 3), numAt(f, 4), numAt(f, 5)));
  }
  const cols = [seg.dt, seg.x, seg.y, seg.z, seg.o];
  const n = Math.min(...cols.map((c) => (Array.isArray(c) ? c.length : 0)));
  let t = seg.t0;
  for (let i = 0; i < n; i++) {
    t += numAt(seg.dt, i);
    cx += numAt(seg.x, i);
    cy += numAt(seg.y, i);
    cz += numAt(seg.z, i);
    co += numAt(seg.o, i);
    const cutMap = cuts.get(i);
    if (cutMap !== undefined) map = cutMap;
    const to = takeoffs.get(i);
    const frame: TraceFrame = {
      t,
      map,
      x: cx / qP,
      y: cy / qP,
      z: cz / qP,
      o: rad(co),
      cut: cutMap !== undefined,
      ...(to === undefined ? {} : { fly: to }),
    };
    if (to !== undefined) flights.push({ frame: frames.length, t, ...to });
    frames.push(frame);
  }

  const events: TraceEvent[] = [];
  for (const e of Array.isArray(seg.ev) ? seg.ev : []) {
    if (!Array.isArray(e) || !finite(e[0]) || !isStateKey(e[1])) continue;
    const value = SANITIZE[e[1]](e[2]);
    if (value !== undefined) events.push({ t: seg.t0 + e[0], kind: e[1], value } as TraceEvent);
  }
  events.sort((a, b) => a.t - b.t);

  return { run: seg.run, t0: seg.t0, t1: seg.t1, frames, flights, key: stateOf(seg.k?.s), events };
}

/* ------------------------------------------------------------ playback --- */

export interface TracePose {
  map: number;
  x: number;
  y: number;
  z: number;
  o: number;
  /** Between a takeoff and the end of its flight. */
  flying: boolean;
}

const pose = (f: TraceFrame): TracePose => ({ map: f.map, x: f.x, y: f.y, z: f.z, o: f.o, flying: false });

/**
 * Where the character was at `t`, from frames in time order — one segment's,
 * or several laid end to end. Null before the first frame; the last one holds
 * after it.
 */
export function sampleAt(frames: readonly TraceFrame[], t: number): TracePose | null {
  let lo = 0;
  let hi = frames.length - 1;
  let i = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid]!.t <= t) {
      i = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (i === -1) return null;
  const a = frames[i]!;
  if (a.fly !== undefined && a.fly.map === a.map) {
    const f = a.fly.ms <= 0 ? 1 : Math.min(1, (t - a.t) / a.fly.ms);
    return {
      map: a.map,
      x: lerp(a.x, a.fly.x, f),
      y: lerp(a.y, a.fly.y, f),
      z: lerp(a.z, a.fly.z, f),
      o: heading(a.x, a.y, a.fly.x, a.fly.y, a.o),
      flying: f < 1,
    };
  }
  const b = frames[i + 1];
  if (b === undefined || b.cut || b.map !== a.map || b.t - a.t > GAP_MS || b.t <= a.t) return pose(a);
  const f = (t - a.t) / (b.t - a.t);
  return { map: a.map, x: lerp(a.x, b.x, f), y: lerp(a.y, b.y, f), z: lerp(a.z, b.z, f), o: arc(a.o, b.o, f), flying: false };
}

/** The state at `t`: the keyframe with every event at or before `t` applied. */
export function stateAt(seg: DecodedSegment, t: number): TraceState {
  const s: TraceState = { ...seg.key, auras: [...seg.key.auras] };
  for (const e of seg.events) {
    if (e.t > t) break;
    setKey(s, e.kind, e.value);
  }
  return s;
}
