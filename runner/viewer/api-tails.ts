/**
 * The viewer's per-run tails (`TrajectoryTail`): one per run, shared by every
 * reader of that run, scans serialised, least-recently-used and bounded, and
 * pinned while a stream reads one; beside them the settled runs' track cores,
 * which go when their run's tail does. One cache per `createApi` handle, which
 * hands the run routes (`api-run.ts`) what they read and the publisher
 * `release` and `cachedRuns`.
 */

import { join } from "node:path";
import type { EntrySummary, TrackResponse } from "./api-types";
import { TrajectoryTail } from "./tail";

/**
 * How long a run's entry index (`TrajectoryTail`) outlives its last reader.
 * Ten minutes covers an operator flipping between a handful of run pages; past
 * it the next visit re-reads the file, which is what the first visit cost.
 */
export const TAIL_IDLE_MS = 10 * 60_000;

/**
 * How many trajectory bytes the tails nobody is streaming may index between
 * them. Measured on the fleet's runs, a tail holds roughly a third of its
 * file's size as live objects (~200 MB for a 500–800 MB freeplay trajectory),
 * so a GiB of trajectory is a few hundred MB of heap in a 3 GiB pod, beside
 * whatever the open streams pin.
 */
export const TAIL_CACHE_BYTES = 1024 ** 3;

export type TrackCore = Pick<TrackResponse, "points" | "inv" | "moves">;

/** A handle's tail cache; see the module comment. */
export function createTailCache() {
  /**
   * One tail per run, shared by every reader; scans are serialised per run.
   *
   * Held least-recently-used first (a `Map` keeps insertion order, and an
   * access re-inserts), and bounded: a tail is the whole entry index of a
   * trajectory, ~200 MB of live objects for a big freeplay run, so a viewer
   * that kept every run it was ever asked about would OOM its pod after a
   * dozen. See `evictTails` for what is dropped and when.
   */
  const tails = new Map<string, TrajectoryTail>();
  const scans = new Map<string, Promise<EntrySummary[]>>();
  const tailUsedAt = new Map<string, number>();
  /** Settled runs' track cores, least-recently-used first (`trackCoreOf`). */
  const trackCores = new Map<string, TrackCore>();
  /** Open SSE streams per run: a pinned tail is never evicted. */
  const tailPins = new Map<string, number>();

  function tailFor(runId: string, dir: string): TrajectoryTail {
    let t = tails.get(runId);
    if (t === undefined) t = new TrajectoryTail(join(dir, "trajectory.jsonl"));
    else tails.delete(runId);
    tails.set(runId, t);
    tailUsedAt.set(runId, Date.now());
    evictTails(runId);
    return t;
  }

  function pin(runId: string, tail: TrajectoryTail): void {
    // Re-seat the tail this stream reads, in case it was dropped between the
    // route's `tailFor` and here; a stream must read the tail the map holds.
    if (tails.get(runId) !== tail) tails.set(runId, tail);
    tailPins.set(runId, (tailPins.get(runId) ?? 0) + 1);
  }

  function unpin(runId: string): void {
    const n = (tailPins.get(runId) ?? 0) - 1;
    if (n > 0) tailPins.set(runId, n);
    else tailPins.delete(runId);
    tailUsedAt.set(runId, Date.now());
  }

  /** Forget one run's tail and everything keyed to it. */
  function dropTail(runId: string): void {
    tails.delete(runId);
    scans.delete(runId);
    tailUsedAt.delete(runId);
    trackCores.delete(runId);
  }

  /**
   * Drop the tails nobody is reading. A tail with an open stream is kept
   * whatever its age or size — that is a live run being watched, and dropping
   * it would cost the next tick a whole-file re-read. Of the rest, newest use
   * first, a tail goes when it has sat unasked for `TAIL_IDLE_MS`, or once the
   * trajectories the kept ones index pass `TAIL_CACHE_BYTES` between them.
   * The one just asked for (`keep`) always stays, even alone over budget.
   *
   * Run on every request rather than on a timer: a viewer with any tab open is
   * polled every few seconds, and one with none is not paying for anything
   * but the memory it already holds. What eviction costs is the next visit's
   * re-read of that file, which is what the first visit paid.
   */
  function evictTails(keep: string | null = null): void {
    const now = Date.now();
    let bytes = 0;
    for (const id of [...tails.keys()].reverse()) {
      if ((tailPins.get(id) ?? 0) > 0) continue;
      bytes += tails.get(id)!.size;
      if (id === keep) continue;
      if (now - (tailUsedAt.get(id) ?? 0) >= TAIL_IDLE_MS || bytes > TAIL_CACHE_BYTES) dropTail(id);
    }
  }

  /** Serialise scans: two concurrent readers must not both consume the same bytes. */
  function scan(runId: string, tail: TrajectoryTail): Promise<EntrySummary[]> {
    const prev = scans.get(runId) ?? Promise.resolve([] as EntrySummary[]);
    const next = prev.then(
      () => tail.scan(),
      () => tail.scan(),
    );
    scans.set(runId, next);
    return next;
  }

  /**
   * See `ApiHandle.release`. The entry index, its scan lock and the run's
   * settled track core, and nothing else — because the entry index is both the
   * heavy memo and the only one a pass is genuinely finished with when it has
   * published a run.
   *
   * A `TrajectoryTail` keeps one `EntrySummary` per record for the whole file:
   * on the 1,016-run tree that was ~570 MB of live objects at the end of a
   * pass, against ~8 MB for the run rows and rather less for the totals. It is
   * also per-run in the strict sense — only `/api/run/<id>` and its feed touch
   * one — so dropping it costs nothing else this pass.
   *
   * It is the heaviest per-run memo this handle holds, beside the settled
   * track cores (`trackCoreOf`), which only a run that can no longer change
   * gets. The run rows, the state series and the per-run totals used to be
   * memoised here because each one cost a file open or a whole-file scan; they
   * are rows in the derived store now, shared only over a few seconds
   * (`sharedStore`). The one other, the trace window
   * list (`closedWindowsMemo`), is a few numbers per run and is kept on purpose:
   * it is what spares a pass a `run.sqlite` open per run.
   */
  const release = (runId: string): void => {
    tailPins.delete(runId);
    dropTail(runId);
  };

  const cachedRuns = (): { entries: number } => ({ entries: tails.size });

  return { tailFor, pin, unpin, evictTails, scan, trackCores, release, cachedRuns };
}

export type TailCache = ReturnType<typeof createTailCache>;
