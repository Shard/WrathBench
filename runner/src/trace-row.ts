/**
 * The trace: a fine-grained record of the character's own position and state,
 * written beside the 60 s `state` rows so the map can play a run back as
 * movement rather than as a slide show.
 *
 * The shapes here are the storage contract shared with the trace's readers
 * (the segment encoder, the viewer, the publisher): one row per observation in
 * run.sqlite `trace`, its only home, and the `TraceState`
 * keys a 'key' row carries whole and a 'state' row carries as a delta. They
 * are fixed by that contract; a change here is a change for every reader.
 *
 * Nothing in it is new observation. The recorder (`sandbox/trace-recorder.ts`)
 * reads the SDK's own state cache and event stream inside the sandbox child,
 * and the writer (`trace.ts`) persists what the host drains on the state
 * ticker. The model sees none of it.
 */

/** One character × one UTC-aligned window of this many ms is a segment. */
export const TRACE_WINDOW_MS = 300_000;

export type TraceKind = "key" | "pos" | "state" | "flight";

/** What the character's own target is, by the guid's high type. Never a name or a guid. */
export type TraceTargetKind = "creature" | "player" | "object" | "other";

/**
 * The character's state as the trace carries it. Every key is present in a
 * 'key' row and optional in a 'state' delta; `null` means unknown (the cache
 * has not observed it yet), never zero.
 */
export interface TraceState {
  hp: number | null;
  hpMax: number | null;
  pw: number | null;
  pwMax: number | null;
  /** The raw `powerType` field: 0 mana, 1 rage, 3 energy, 6 runic power. */
  pwType: number | null;
  level: number | null;
  xp: number | null;
  xpMax: number | null;
  /** `[spellId, stacks, expiresAt (epoch ms; 0 = no expiry), flags]`, sent whole on any change. */
  auras: [number, number, number, number][];
  combat: boolean;
  mounted: boolean;
  taxi: boolean;
  dead: boolean;
  ghost: boolean;
  resting: boolean;
  target: null | { kind: TraceTargetKind; entry?: number; hpPct?: number };
  /** The cast in progress: `endsAt` is epoch ms. Null when not casting. */
  cast: null | { spellId: number; endsAt: number };
}

/** The payload a 'flight' row carries: the spline's end and how long the ride is. */
export interface TraceFlight {
  to: { map: number; x: number; y: number; z: number };
  durationMs: number;
}

/** A position as the trace carries it (map, point and facing). */
export interface TracePoint {
  map: number;
  x: number;
  y: number;
  z: number;
  o: number;
}

/**
 * One trace row, exactly the sqlite row's columns. `ts` is the observation's
 * own time (the child's clock, `Observed.ts` where the cache has one). The
 * position columns are the last known position on a 'key' row (null before
 * one is known), the sample on a 'pos' row, the takeoff point on a 'flight'
 * row, and absent on a 'state' row.
 *
 * `data`, by kind: 'key' the full `TraceState`; 'pos' `{ jump: 1 }` when the
 * character did not travel there continuously (teleport, new world, login,
 * reattach, hearth, graveyard, dungeon port) and otherwise absent — a reader
 * never interpolates into a jump; 'state' a partial `TraceState` holding only
 * the keys that changed; 'flight' a `TraceFlight`.
 */
export interface TraceRow {
  ts: number;
  kind: TraceKind;
  map?: number | null;
  x?: number | null;
  y?: number | null;
  z?: number | null;
  o?: number | null;
  data?: TraceState | Partial<TraceState> | { jump: 1 } | TraceFlight | null;
}

/** What the sandbox child hands the host per drain: the rows, and how many the cap dropped. */
export interface TraceDrain {
  rows: TraceRow[];
  dropped: number;
}

/** A `TraceState` with nothing observed: what a key row states before the world is seen. */
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
