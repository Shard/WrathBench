/**
 * The nearby ring: the host's side of the units around the character
 * (`nearby-row.ts`), kept as a delay line for the live map and nothing more.
 *
 * On every state-ticker tick (`loop.ts`, `startStateTicker`) the writer drains
 * what the sandbox child's recorder latched (`sandbox/nearby-recorder.ts`) and
 * appends it to `data/runs/<id>/nearby/<t0>.jsonl`, one file per UTC-aligned
 * `NEARBY_FILE_MS`. Each file opens with a `key` row stating every unit in view
 * from the writer's own fold, so a reader of a minute needs that minute's file
 * and none before it; a `tick` row closes each drain with how far the child
 * had looked, so a quiet scene reads as current rather than old.
 *
 * Live only, which is a property of where it does not go as much as of how
 * long it lasts:
 * - never `run.sqlite`, `trace.jsonl` or `trajectory.jsonl` — it takes no
 *   trajectory at all — so no collector, replay, scorer or scheduler reads it;
 * - files that ended more than `NEARBY_RING_MS` ago are unlinked on every tick;
 * - the directory is removed when the ticker stops (every pause, stop and exit
 *   of a driver passes through that), on process exit (`run.ts`), and before
 *   the first write of a process, which clears what a SIGKILL left behind;
 * - the archiver drops it before moving a run (`archive.ts`).
 * A reader judges the ring by age as well, so what a hard kill leaves is
 * ignored long before anything sweeps it.
 *
 * The one piece of memory beyond the fold is the names this run's client was
 * answered, by creature entry and by player guid: a child that restarts mid
 * session starts with an empty cache, and the map keeps naming a unit the old
 * child named. That dictionary lives here, in the host, and is written only to
 * the ring — the new child, and so the model, never sees it.
 *
 * It never starts a child (`SandboxHost.nearbyDrain` answers null without
 * one) and never throws: a full or read-only disk costs the ring, never the
 * run, and a dropped-row count goes to stderr, never to the trajectory.
 */

import { appendFileSync, mkdirSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { SandboxHost } from "./sandbox/host";
import {
  NEARBY_DIR,
  NEARBY_FILE_MS,
  NEARBY_RING_MS,
  emptyNearbySelf,
  nearbyFileStart,
  type NearbyDrain,
  type NearbyRow,
  type NearbySelf,
  type NearbyUnit,
} from "./nearby-row";

export interface NearbyWriterOptions {
  /** The run's directory; the ring is its `nearby/`. Null writes nothing. */
  runDir: string | null;
  /** The host, or anything answering `nearbyDrain`; a fake without one writes nothing. */
  sandbox: Pick<SandboxHost, "nearbyDrain"> | { nearbyDrain?: undefined };
  now?: () => number;
  /** Where a dropped-row count or a write failure goes: the runner's stderr by default. */
  log?: (text: string) => void;
}

/** The ring's directory for a run directory. */
export function nearbyRingDir(runDir: string): string {
  return join(runDir, NEARBY_DIR);
}

/** Remove a run's ring, whatever is in it. Never throws. */
export function removeNearbyRing(runDir: string): void {
  try {
    rmSync(nearbyRingDir(runDir), { recursive: true, force: true });
  } catch {
    /* already gone, or a read-only disk the writer could not have used either */
  }
}

/** `<t0>.jsonl` → t0, or null for anything else in the directory. */
export function ringFileStart(name: string): number | null {
  const m = /^(\d+)\.jsonl$/.exec(name);
  if (m === null) return null;
  const t0 = Number(m[1]);
  return Number.isSafeInteger(t0) && t0 % NEARBY_FILE_MS === 0 ? t0 : null;
}

/** Whether the ring file starting at `t0` has aged out at `now`: it ended more than `NEARBY_RING_MS` ago. */
export function ringFileExpired(t0: number, now: number): boolean {
  return t0 + NEARBY_FILE_MS <= now - NEARBY_RING_MS;
}

export class NearbyWriter {
  private readonly ringDir: string | null;
  private readonly now: () => number;
  private readonly log: (text: string) => void;
  private swept = false;
  private closed = false;
  private made = false;
  private draining: Promise<void> | null = null;
  private failed = false;

  /** Every unit in view and the self, over every row written, and the newest row stamp. */
  private readonly fold: { self: NearbySelf; units: Map<string, NearbyUnit>; ts: number; any: boolean } = {
    self: emptyNearbySelf(),
    units: new Map(),
    ts: 0,
    any: false,
  };
  /** The file the last row went to: rows only ever go forward, so a file's lines are in the order seen. */
  private file = 0;
  /** Files that have their opening key (the child's or ours), newest last; a handful is enough. */
  private readonly keyed: number[] = [];
  /** Names this run's client was answered: by creature entry, and by player guid. */
  private readonly entryNames = new Map<number, { name: string; sub?: string }>();
  private readonly guidNames = new Map<string, string>();

  constructor(private readonly o: NearbyWriterOptions) {
    // A sandbox that cannot drain (a test's fake) gets no ring, and the
    // writer then touches no file at all: not even the sweep or the removal.
    this.ringDir = o.runDir === null || typeof o.sandbox.nearbyDrain !== "function" ? null : nearbyRingDir(o.runDir);
    this.now = o.now ?? Date.now;
    this.log = o.log ?? ((text) => console.error(text));
  }

  /**
   * One drain: the child's rows since the last, appended in order with the
   * file keys they need, then the files past the ring's reach unlinked.
   * Coalesced, so a slow drain is never raced by the next tick; one that fails
   * (the child died mid-request) leaves the fold as it was.
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

  /** Stop for good and remove the ring: the ticker's stop, so every pause, stop and exit. */
  close(): void {
    this.closed = true;
    if (this.ringDir !== null) removeNearbyRing(this.o.runDir!);
  }

  private async doDrain(): Promise<void> {
    if (this.closed || this.ringDir === null) return;
    if (!this.swept) {
      // Whatever a process before this one left: a SIGKILL skips every other cleanup.
      this.swept = true;
      removeNearbyRing(this.o.runDir!);
    }
    const drained: NearbyDrain | null = (await this.o.sandbox.nearbyDrain?.()) ?? null;
    if (this.closed) return;
    const out = new Map<number, string[]>();
    if (drained !== null) {
      for (const row of drained.rows) this.write(row, out);
      if (drained.through > this.fold.ts && this.fold.any) this.write({ ts: drained.through, kind: "tick" }, out);
      if (drained.dropped > 0) this.log(`[nearby] the sandbox buffer dropped ${drained.dropped} row(s) before this drain`);
    }
    this.flush(out);
    this.prune(this.now());
  }

  /** One row into its file (after the file's key), with names the old child knew filled in. */
  private write(row: NearbyRow, out: Map<number, string[]>): void {
    const t0 = Math.max(this.file, nearbyFileStart(row.ts));
    if (row.kind === "key") this.markKeyed(t0);
    else this.keyIfNeeded(t0, out);
    this.file = t0;
    if (row.kind === "key") for (const u of row.units) this.name(u);
    else if (row.kind === "in") this.name(row.u);
    this.learn(row);
    this.foldRow(row);
    push(out, t0, row);
  }

  private markKeyed(t0: number): void {
    if (this.keyed.includes(t0)) return;
    this.keyed.push(t0);
    if (this.keyed.length > 8) this.keyed.splice(0, this.keyed.length - 8);
  }

  /** A key for file `t0` from the fold, unless it has one or the fold has nothing to state yet. */
  private keyIfNeeded(t0: number, out: Map<number, string[]>): void {
    if (!this.fold.any || this.keyed.includes(t0)) return;
    this.markKeyed(t0);
    push(out, t0, { ts: Math.max(t0, this.fold.ts), kind: "key", self: { ...this.fold.self }, units: [...this.fold.units.values()] });
  }

  /** Fill a unit's missing name from what this run's client was told before. */
  private name(u: NearbyUnit): void {
    if (u.s.name !== undefined && u.s.name !== null) return;
    if (u.ty === "player") {
      const n = this.guidNames.get(u.id);
      if (n !== undefined) u.s = { ...u.s, name: n };
      return;
    }
    const entry = u.s.entry;
    if (typeof entry !== "number") return;
    const n = this.entryNames.get(entry);
    if (n !== undefined) u.s = { ...u.s, name: n.name, ...(n.sub !== undefined && u.s.sub == null ? { sub: n.sub } : {}) };
  }

  private remember(id: string, ty: NearbyUnit["ty"] | undefined, entry: unknown, name: unknown, sub: unknown): void {
    if (typeof name !== "string" || name === "") return;
    if (ty === "player") this.guidNames.set(id, name);
    else if (typeof entry === "number") this.entryNames.set(entry, { name, ...(typeof sub === "string" ? { sub } : {}) });
  }

  private learn(row: NearbyRow): void {
    if (row.kind === "key") for (const u of row.units) this.remember(u.id, u.ty, u.s.entry, u.s.name, u.s.sub);
    else if (row.kind === "in") this.remember(row.u.id, row.u.ty, row.u.s.entry, row.u.s.name, row.u.s.sub);
    else if (row.kind === "nm" || row.kind === "st") {
      const u = this.fold.units.get(row.id);
      if (u === undefined) return;
      const name = row.kind === "nm" ? row.name : row.s.name;
      const sub = row.kind === "nm" ? row.sub : row.s.sub;
      this.remember(row.id, u.ty, row.kind === "st" && row.s.entry != null ? row.s.entry : u.s.entry, name, sub);
    }
  }

  private foldRow(row: NearbyRow): void {
    const f = this.fold;
    f.any = true;
    if (row.ts > f.ts) f.ts = row.ts;
    switch (row.kind) {
      case "key":
        f.self = { ...row.self };
        f.units = new Map(row.units.map((u) => [u.id, u]));
        return;
      case "in":
        f.units.set(row.u.id, row.u);
        return;
      case "mv":
      case "pos": {
        const u = f.units.get(row.id);
        if (u !== undefined) f.units.set(row.id, { ...u, m: row.m });
        return;
      }
      case "st": {
        const u = f.units.get(row.id);
        if (u === undefined) return;
        const s = { ...u.s };
        for (const [k, v] of Object.entries(row.s)) {
          if (v === null) delete (s as Record<string, unknown>)[k];
          else (s as Record<string, unknown>)[k] = v;
        }
        f.units.set(row.id, { ...u, s });
        return;
      }
      case "nm": {
        const u = f.units.get(row.id);
        if (u !== undefined) f.units.set(row.id, { ...u, s: { ...u.s, name: row.name, ...(row.sub !== undefined ? { sub: row.sub } : {}) } });
        return;
      }
      case "out":
        f.units.delete(row.id);
        return;
      case "self":
        f.self = { ...f.self, ...row.self };
        return;
      case "tick":
        return;
    }
  }

  private flush(out: Map<number, string[]>): void {
    if (out.size === 0) return;
    try {
      if (!this.made) {
        mkdirSync(this.ringDir!, { recursive: true });
        this.made = true;
      }
      for (const [t0, lines] of out) appendFileSync(join(this.ringDir!, `${t0}.jsonl`), lines.join(""), "utf8");
      this.failed = false;
    } catch (err) {
      // The directory may have been removed under us (an archive, a sweep):
      // make it again next time. Logged once per failure streak.
      this.made = false;
      if (!this.failed) this.log(`[nearby] could not write the ring: ${err instanceof Error ? err.message : String(err)}`);
      this.failed = true;
    }
  }

  /** Unlink every ring file that ended more than `NEARBY_RING_MS` before `now`. */
  private prune(now: number): void {
    let names: string[];
    try {
      names = readdirSync(this.ringDir!);
    } catch {
      return;
    }
    for (const name of names) {
      const t0 = ringFileStart(name);
      if (t0 === null || !ringFileExpired(t0, now)) continue;
      try {
        unlinkSync(join(this.ringDir!, name));
      } catch {
        /* gone already */
      }
    }
  }
}

function push(out: Map<number, string[]>, t0: number, row: NearbyRow): void {
  const line = `${JSON.stringify(row)}\n`;
  const lines = out.get(t0);
  if (lines === undefined) out.set(t0, [line]);
  else lines.push(line);
}
