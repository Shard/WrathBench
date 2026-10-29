/**
 * The trace writer: the host's side of the trace (`trace-row.ts`). On every
 * state-ticker tick (`loop.ts`, `startStateTicker`) it drains what the sandbox
 * child's recorder latched (`sandbox/trace-recorder.ts`) and writes the rows
 * to run.sqlite `trace` through the trajectory, with the names the drain
 * carried to `trace_dict`.
 *
 * It is not the state sample. `sampleState` takes the full snapshot that feeds
 * the HUD, the milestones and the watchdogs, and drains the death and flight
 * signals that are the loop's record; this drains one light buffer and
 * touches none of that. It also never starts a child: `SandboxHost.traceDrain`
 * answers null when none is running, so a paused run's ticker cannot spawn a
 * sandbox for the sake of a trace.
 *
 * Its one piece of state is a fold — the latest full `TraceState`, sheet and
 * position over everything it has written — kept for the keyframes: every
 * UTC-aligned `TRACE_WINDOW_MS` window a live run spans gets a 'key' row
 * stating the fold, so a reader of one window needs that window's rows and no
 * earlier ones. The key is written before the first row of a window is folded,
 * so it states the world as of the window's start: `ts` is the window's `t0`
 * when the fold's newest observation is older than that (the ordinary case —
 * the ticker lags the clock by at most a tick, and rows observed before `t0`
 * are folded first), and the fold's newest `ts` otherwise, so a key never
 * predates an observation it already states. A window the child was idle in
 * still gets its key, from the tick that first sees it. The sheet's lists are
 * folded patch by patch into fresh arrays, never in place, because a key row
 * holds the fold's arrays until the drain is written.
 *
 * Each drain is written in `ts` order, the order every reader reads in. A
 * 'state' row observed before the newest key already written — one the child
 * stamped just before a boundary and latched after the host had keyed the
 * next window — is written at that key's `ts` instead. Left where it was
 * observed, a reader would fold it into the context and then let the key,
 * which does not state it, take it back: a change reverted for a whole
 * window. The sheet is read at most once a second, so it is the likely case,
 * but the rule is the same for every key.
 */

import type { SandboxHost } from "./sandbox/host";
import type { Trajectory } from "./trajectory";
import {
  applySheetPatch,
  emptyTraceSheet,
  emptyTraceState,
  SHEET_KEY_LEN,
  TRACE_WINDOW_MS,
  type TraceDrain,
  type TracePoint,
  type TraceRow,
  type TraceSheet,
  type TraceStateDelta,
  type TraceState,
} from "./trace-row";

export interface TraceWriterOptions {
  runId: string;
  trajectory: Pick<Trajectory, "recordTrace">;
  /** The host, or anything answering `traceDrain`; a fake without one writes nothing. */
  sandbox: Pick<SandboxHost, "traceDrain"> | { traceDrain?: undefined };
  now?: () => number;
  /** Where a dropped-row count goes: the runner's stderr by default. */
  log?: (text: string) => void;
}

/** The window a timestamp falls in, as its start. */
export function traceWindowStart(ts: number): number {
  return ts - (ts % TRACE_WINDOW_MS);
}

/** A key row's sheet: each key as it is, and `null` for one it lacks (a row from before the sheet). */
function sheetOf(data: unknown): TraceSheet {
  const s = emptyTraceSheet();
  if (data === null || typeof data !== "object") return s;
  const d = data as Record<string, unknown>;
  if (typeof d["money"] === "number") s.money = d["money"];
  for (const key of Object.keys(SHEET_KEY_LEN) as (keyof typeof SHEET_KEY_LEN)[]) {
    const v = d[key];
    if (Array.isArray(v)) (s as unknown as Record<string, unknown>)[key] = v;
  }
  return s;
}

export class TraceWriter {
  private readonly now: () => number;
  private readonly log: (text: string) => void;
  /** The latest state, sheet and position over every row written, and the newest row `ts` folded. */
  private readonly fold: { state: TraceState; sheet: TraceSheet; pos: TracePoint | null; ts: number; any: boolean } = {
    state: emptyTraceState(),
    sheet: emptyTraceSheet(),
    pos: null,
    ts: 0,
    any: false,
  };
  /** Windows that have a key row (the child's or ours), newest last; a handful is enough. */
  private readonly keyed: number[] = [];
  /** The newest key row's `ts` written: no 'state' row is written before it. */
  private keyTs = -Infinity;
  private draining: Promise<void> | null = null;

  constructor(private readonly o: TraceWriterOptions) {
    this.now = o.now ?? Date.now;
    this.log = o.log ?? ((text) => console.error(text));
  }

  /**
   * One drain: everything the child latched since the last, written in order
   * with the window keys they need. Coalesced, so a slow drain is never raced
   * by the next tick; a drain that fails (the child died mid-request) leaves
   * the fold as it was and the next tick tries again.
   */
  drain(): Promise<void> {
    if (this.draining !== null) return this.draining;
    const p = this.doDrain()
      .catch(() => undefined)
      .finally(() => {
        if (this.draining === p) this.draining = null;
      });
    this.draining = p;
    return p;
  }

  private async doDrain(): Promise<void> {
    const sandbox = this.o.sandbox;
    if (typeof sandbox.traceDrain !== "function") return;
    const drained: TraceDrain | null = await sandbox.traceDrain();
    if (drained === null) return;
    const out: TraceRow[] = [];
    // Stable, so rows observed at the same instant keep the child's order.
    for (const latched of [...drained.rows].sort((a, b) => a.ts - b.ts)) {
      let row = latched;
      if (row.kind === "key") this.markKeyed(traceWindowStart(row.ts));
      else {
        if (row.kind === "state" && row.ts < this.keyTs) row = { ...row, ts: this.keyTs };
        this.keyIfNeeded(traceWindowStart(row.ts), out);
      }
      out.push(row);
      if (row.kind === "key" && row.ts > this.keyTs) this.keyTs = row.ts;
      this.foldRow(row);
    }
    // The window the clock is in now, so an idle child still keys each window.
    this.keyIfNeeded(traceWindowStart(this.now()), out);
    if (out.length > 0 || drained.dict !== undefined) await this.o.trajectory.recordTrace(this.o.runId, out, drained.dict);
    if (drained.dropped > 0) {
      this.log(`[trace] the sandbox buffer dropped ${drained.dropped} trace row(s) before this drain`);
    }
  }

  private markKeyed(t0: number): void {
    if (this.keyed.includes(t0)) return;
    this.keyed.push(t0);
    if (this.keyed.length > 8) this.keyed.splice(0, this.keyed.length - 8);
  }

  /** A key for window `t0` from the fold, unless it has one or the fold has nothing to state yet. */
  private keyIfNeeded(t0: number, out: TraceRow[]): void {
    if (!this.fold.any || this.keyed.includes(t0)) return;
    this.markKeyed(t0);
    const pos = this.fold.pos;
    const ts = Math.max(t0, this.fold.ts);
    out.push({
      ts,
      kind: "key",
      map: pos?.map ?? null,
      x: pos?.x ?? null,
      y: pos?.y ?? null,
      z: pos?.z ?? null,
      o: pos?.o ?? null,
      // The sheet's lists are never mutated once folded, so they are shared, not copied.
      data: { ...this.fold.state, auras: [...this.fold.state.auras], ...this.fold.sheet },
    });
    if (ts > this.keyTs) this.keyTs = ts;
  }

  private foldRow(row: TraceRow): void {
    const f = this.fold;
    f.any = true;
    if (row.ts > f.ts) f.ts = row.ts;
    if (row.kind === "key") {
      f.state = { ...emptyTraceState(), ...(row.data as TraceState) };
      f.sheet = sheetOf(row.data);
    } else if (row.kind === "state") {
      const d = (row.data ?? {}) as TraceStateDelta;
      // Turn-ins and chat are events, never state: neither reaches a key row.
      const { money, qdone: _qdone, chat: _chat, equip, bags, inv, dur, quests, rep, skills, ...unit } = d;
      Object.assign(f.state, unit);
      // A new sheet object whenever one key moves, so a key row already out holds the old one.
      const patches = { equip, bags, inv, dur, quests, rep, skills };
      let sheet: TraceSheet | null = null;
      if (money !== undefined) (sheet ??= { ...f.sheet }).money = money;
      for (const key of Object.keys(patches) as (keyof typeof patches)[]) {
        const p = patches[key];
        if (p === undefined) continue;
        sheet ??= { ...f.sheet };
        (sheet as unknown as Record<string, unknown>)[key] = applySheetPatch(f.sheet[key], p, SHEET_KEY_LEN[key]);
      }
      if (sheet !== null) f.sheet = sheet;
    }
    if (row.kind !== "state" && typeof row.map === "number" && typeof row.x === "number" && typeof row.y === "number" && typeof row.z === "number") {
      f.pos = { map: row.map, x: row.x, y: row.y, z: row.z, o: typeof row.o === "number" ? row.o : (f.pos?.o ?? 0) };
    }
  }
}
