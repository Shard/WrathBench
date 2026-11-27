/**
 * The derived store with its corpus-wide reads shared over a short window:
 * what every handle reads its listings through (`createApi`, `api.ts`), and
 * so the viewer's own, whatever groups are on.
 */

import type { RunStore } from "./clickhouse";

/**
 * How long one corpus-wide store read stands in for the next.
 *
 * Seconds, and few: the fleet page polls `/api/fleet` every five seconds per
 * tab, the map polls `/api/positions` as often, and `/api/models`, `/api/runs`
 * and the per-run routes ask for the same handful of whole-table reads
 * (`runRows`, `totalsRows`, the latest readings), each of them megabytes of
 * JSON out of ClickHouse. Every caller inside the window gets the one read in
 * flight (or just finished), so N tabs and M routes cost one query. Nothing is
 * kept past it: a row can be at most this much older than the store, which is
 * itself a five-second collector poll behind the files.
 */
export const STORE_SHARE_MS = 3_000;

/**
 * The store, with its corpus-wide reads shared over `windowMs`: the pattern
 * `allResultRuns` holds a listing build on. The pending promise is what is
 * kept, so a burst shares one read; the window is stamped when the read
 * settles; a read that fails is not kept. Per-run reads pass through
 * untouched. Callers must not mutate what a shared read returns: every reader
 * in the window holds the same arrays.
 */
export function sharedStore(store: RunStore, windowMs = STORE_SHARE_MS): RunStore {
  const share = <T>(read: () => Promise<T>): (() => Promise<T>) => {
    let held: { at: number; value: Promise<T> } | undefined;
    return () => {
      if (held === undefined || Date.now() - held.at >= windowMs) {
        const value = read();
        held = { at: Date.now(), value };
        value.then(
          () => {
            if (held?.value === value) held = { at: Date.now(), value };
          },
          () => {
            if (held?.value === value) held = undefined;
          },
        );
      }
      return held.value;
    };
  };
  return {
    runRows: share(() => store.runRows()),
    runRow: (id) => store.runRow(id),
    totalsRows: share(() => store.totalsRows()),
    totalsRow: (id) => store.totalsRow(id),
    latestStates: share(() => store.latestStates()),
    latestReadings: share(() => store.latestReadings()),
    latestState: (id) => store.latestState(id),
    runListing: share(() => store.runListing()),
    factRows: share(() => store.factRows()),
    stateRows: (id) => store.stateRows(id),
    stateItemRows: (id) => store.stateItemRows(id),
    stateRowsByRun: (ids) => store.stateRowsByRun(ids),
    moveRows: (id) => store.moveRows(id),
  };
}
