/**
 * The trace writer: the host's side of the trace (`trace-row.ts`). On every
 * state-ticker tick (`loop.ts`, `startStateTicker`) it drains what the sandbox
 * child's recorder latched (`sandbox/trace-recorder.ts`) and writes the rows
 * to run.sqlite `trace` and `trace.jsonl` through the trajectory.
 *
 * It is not the state sample. `sampleState` takes the full snapshot that feeds
 * the HUD, the milestones and the watchdogs, and drains the death and flight
 * signals that are the loop's record; this drains one light buffer and
 * touches none of that. It also never starts a child: `SandboxHost.traceDrain`
 * answers null when none is running, so a paused run's ticker cannot spawn a
 * sandbox for the sake of a trace.
 *
 * Its one piece of state is a fold — the latest full `TraceState` and position
 * over everything it has written, O(1) per row — kept for the keyframes:
 * every UTC-aligned `TRACE_WINDOW_MS` window a live run spans gets a 'key' row
 * stating the fold, so a reader of one window needs that window's rows and no
 * earlier ones. The key is written before the first row of a window is folded,
 * so it states the world as of the window's start: `ts` is the window's `t0`
 * when the fold's newest observation is older than that (the ordinary case —
 * the ticker lags the clock by at most a tick, and rows observed before `t0`
 * are folded first), and the fold's newest `ts` otherwise, so a key never
 * predates an observation it already states. A window the child was idle in
 * still gets its key, from the tick that first sees it.
 */

import type { SandboxHost } from "./sandbox/host";
import type { Trajectory } from "./trajectory";
import { emptyTraceState, TRACE_WINDOW_MS, type TraceDrain, type TracePoint, type TraceRow, type TraceState } from "./trace-row";

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

export class TraceWriter {
  private readonly now: () => number;
  private readonly log: (text: string) => void;
  /** The latest state and position over every row written, and the newest row `ts` folded. */
  private readonly fold: { state: TraceState; pos: TracePoint | null; ts: number; any: boolean } = {
    state: emptyTraceState(),
    pos: null,
    ts: 0,
    any: false,
  };
  /** Windows that have a key row (the child's or ours), newest last; a handful is enough. */
  private readonly keyed: number[] = [];
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
    for (const row of drained.rows) {
      if (row.kind === "key") this.markKeyed(traceWindowStart(row.ts));
      else this.keyIfNeeded(traceWindowStart(row.ts), out);
      out.push(row);
      this.foldRow(row);
    }
    // The window the clock is in now, so an idle child still keys each window.
    this.keyIfNeeded(traceWindowStart(this.now()), out);
    if (out.length > 0) this.o.trajectory.recordTrace(this.o.runId, out);
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
    out.push({
      ts: Math.max(t0, this.fold.ts),
      kind: "key",
      map: pos?.map ?? null,
      x: pos?.x ?? null,
      y: pos?.y ?? null,
      z: pos?.z ?? null,
      o: pos?.o ?? null,
      data: { ...this.fold.state, auras: [...this.fold.state.auras] },
    });
  }

  private foldRow(row: TraceRow): void {
    const f = this.fold;
    f.any = true;
    if (row.ts > f.ts) f.ts = row.ts;
    if (row.kind === "key") {
      f.state = { ...emptyTraceState(), ...(row.data as TraceState) };
    } else if (row.kind === "state") {
      Object.assign(f.state, row.data as Partial<TraceState>);
    }
    if (row.kind !== "state" && typeof row.map === "number" && typeof row.x === "number" && typeof row.y === "number" && typeof row.z === "number") {
      f.pos = { map: row.map, x: row.x, y: row.y, z: row.z, o: typeof row.o === "number" ? row.o : (f.pos?.o ?? 0) };
    }
  }
}
