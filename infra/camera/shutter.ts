/**
 * When the camera keeps a frame: the director's decisions, kept pure so they
 * are tested against recorded event rows (infra/camera-shutter.test.ts).
 *
 * The client is asked for a frame about once a second, and every frame goes
 * into a ring that holds the last `ringMs`. A frame is decided only as it
 * leaves the ring, so an event the session record reports a few seconds late
 * still finds the lead-in it wants:
 *
 * - inside an event's window (`leadMs` before it to `tailMs` after) it is kept
 *   as an `event` frame, tagged with the nearest such event (of events at one
 *   moment, a level-up with its turn-in, the weightier);
 * - otherwise it is kept as an `interval` frame when `intervalMs` has passed
 *   since the last frame kept;
 * - otherwise it is dropped.
 *
 * So the frames kept are in time order and `seq` follows it.
 */

import type { CameraEvent, CameraEventType } from "./layout";
import { isBossKill } from "../../viewer/timeline-marks";

/** An event, at the session record's instant. */
export interface TimedEvent extends CameraEvent {
  ts: number;
}

/** A session `events` row, as much of it as the camera reads (wrath-mcp/docs/SESSION-FORMAT.md, "events"). */
export interface SessionEventRow {
  ts: number;
  kind: string;
  from?: unknown;
  to?: unknown;
  id?: unknown;
  entry?: unknown;
  rank?: unknown;
  self?: unknown;
}

/**
 * The camera event a session row is, or null: a level gained, a death, a boss
 * killed (`isBossKill`: creature rank 3, or one of the five-man bosses, which
 * are elites and named by entry). Those are what a run's timeline marks
 * (`viewer/timeline-marks.ts`), and nothing else is worth a burst: a
 * turn-in and a zone crossed were events until a real run's video was a
 * solid band of them (operator, 2026-11-16). Only gains are events: a
 * recorder's first reading (a `level` without a `from`) states a baseline and
 * is not one. Details are ours, ids and numbers only, never game text.
 */
export function cameraEventOf(row: SessionEventRow, bosses: ReadonlySet<number>): TimedEvent | null {
  const ts = row.ts;
  switch (row.kind) {
    case "level":
      if (typeof row.from !== "number" || typeof row.to !== "number" || row.to <= row.from) return null;
      return { ts, type: "level", detail: `reached level ${row.to}` };
    case "death":
      return { ts, type: "death", detail: "died" };
    case "kill": {
      const entry = typeof row.entry === "number" ? row.entry : null;
      if (!isBossKill({ entry, rank: typeof row.rank === "number" ? row.rank : null }, bosses)) return null;
      return { ts, type: "boss", detail: entry !== null ? `killed boss ${entry}` : "killed a boss" };
    }
    default:
      return null;
  }
}

/** Which of two events that land together names the burst: a level-up from a turn-in is the level-up's clip. */
const RANK: Record<CameraEventType, number> = { level: 5, boss: 4, death: 3, quest: 2, zone: 1, start: 0, end: 0 };
/** Events this close are one moment. */
const SAME_MOMENT_MS = 3_000;

/** Whether `e` names frame `t` over `best`: the nearer one, or of two at one moment the weightier. */
function closer(t: number, e: TimedEvent, best: TimedEvent): boolean {
  if (Math.abs(e.ts - best.ts) <= SAME_MOMENT_MS) return RANK[e.type] > RANK[best.type] || (RANK[e.type] === RANK[best.type] && Math.abs(t - e.ts) < Math.abs(t - best.ts));
  return Math.abs(t - e.ts) < Math.abs(t - best.ts);
}

export interface Captured {
  ts: number;
  bytes: Uint8Array;
}

export interface Kept {
  frame: Captured;
  kind: "interval" | "event";
  event?: CameraEvent;
}

export interface ShutterOptions {
  intervalMs: number;
  /** How much before an event its clip starts. */
  leadMs?: number;
  /** How much after. */
  tailMs?: number;
  /** How long a frame waits in the ring for a late event; at least `leadMs`. */
  ringMs?: number;
}

const DEFAULT_LEAD_MS = 30_000;
const DEFAULT_TAIL_MS = 10_000;
/** The lead plus the session writer's drain lag, with room. */
const DEFAULT_RING_MS = DEFAULT_LEAD_MS + 15_000;

export class Shutter {
  private readonly intervalMs: number;
  private readonly leadMs: number;
  private readonly tailMs: number;
  private readonly ringMs: number;
  private ring: Captured[] = [];
  private events: TimedEvent[] = [];
  private lastKept = Number.NEGATIVE_INFINITY;

  constructor(o: ShutterOptions) {
    this.intervalMs = o.intervalMs;
    this.leadMs = o.leadMs ?? DEFAULT_LEAD_MS;
    this.tailMs = o.tailMs ?? DEFAULT_TAIL_MS;
    this.ringMs = Math.max(o.ringMs ?? DEFAULT_RING_MS, this.leadMs);
  }

  add(frame: Captured): void {
    this.ring.push(frame);
  }

  /** An event; `start` and `end` mark only the frame nearest them (no window). */
  event(e: TimedEvent): void {
    this.events.push(e);
  }

  /**
   * No event's frames are being kept: no event (other than `start` and `end`)
   * whose tail ends within the ring's span of `now`, so nothing in the ring,
   * or still to be captured, falls in a burst. A late-reported event can still
   * land after; the ring's span is the session writer's lag with room.
   */
  quiet(now: number): boolean {
    return !this.events.some((e) => this.window(e.type).lead > 0 && e.ts + this.tailMs + this.ringMs > now);
  }

  /** How many frames wait in the ring. */
  get pending(): number {
    return this.ring.length;
  }

  /** The frames that have left the ring by `now`, decided. */
  due(now: number): Kept[] {
    const out: Kept[] = [];
    while (this.ring.length > 0 && this.ring[0]!.ts <= now - this.ringMs) out.push(...this.decide(this.ring.shift()!, false));
    this.prune(now);
    return out;
  }

  /** Every frame still in the ring, decided: the subject's run ended or the camera is leaving it. */
  flush(): Kept[] {
    const out: Kept[] = [];
    const n = this.ring.length;
    for (let i = 0; i < n; i++) out.push(...this.decide(this.ring.shift()!, i === n - 1));
    this.events = [];
    return out;
  }

  private window(type: CameraEventType): { lead: number; tail: number } {
    return type === "start" || type === "end" ? { lead: 0, tail: 0 } : { lead: this.leadMs, tail: this.tailMs };
  }

  private decide(f: Captured, last: boolean): Kept[] {
    let best: TimedEvent | null = null;
    for (const e of this.events) {
      const w = this.window(e.type);
      if (w.lead === 0) continue;
      if (f.ts < e.ts - w.lead || f.ts > e.ts + w.tail) continue;
      if (best === null || closer(f.ts, e, best)) best = e;
    }
    // `start`: the first frame at or after it; `end`: the last frame the camera has.
    const mark = this.events.find((e) => (e.type === "start" && f.ts >= e.ts && e.ts > this.lastKept) || (e.type === "end" && last));
    if (best !== null) {
      this.lastKept = f.ts;
      return [{ frame: f, kind: "event", event: { type: best.type, detail: best.detail } }];
    }
    if (mark !== undefined) {
      this.lastKept = f.ts;
      if (mark.type === "start") this.events = this.events.filter((e) => e !== mark);
      return [{ frame: f, kind: "event", event: { type: mark.type, detail: mark.detail } }];
    }
    if (f.ts - this.lastKept >= this.intervalMs) {
      this.lastKept = f.ts;
      return [{ frame: f, kind: "interval" }];
    }
    return [];
  }

  /** Events whose window every frame still to come is past. */
  private prune(now: number): void {
    const oldest = this.ring[0]?.ts ?? now;
    this.events = this.events.filter((e) => e.type === "end" || e.ts + this.window(e.type).tail >= oldest || (e.type === "start" && e.ts > this.lastKept));
  }
}
