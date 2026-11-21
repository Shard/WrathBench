/**
 * What `createApi` (`api.ts`) shares with the route modules it mounts: one
 * object, built once per handle, so a module reads the handle's own store,
 * memos and projection rather than a module-level global. Functions only, and
 * values fixed at construction: a memo lives in the closure that owns it, and
 * a module reaches it through the function that reads it.
 */

import type { RunFact } from "../src/models";
import type { RunTotals } from "../src/run-totals";
import type { HarnessView, ResultRun, RunListRow, RunRow } from "./api-types";
import type { RunStore } from "./clickhouse";
import type { Groups } from "./groups";
import type { readFleetRoster } from "./models";

export interface ApiContext {
  runsDir: string;
  /** The derived store, its corpus-wide reads shared (`sharedStore`). */
  store: RunStore;
  publicMode: boolean;
  groups: Groups;
  /** Serve a body, through the public projection when the handle is public. */
  pub: <T>(body: T, project: (b: T) => unknown, runIds?: readonly string[]) => Response;
  /** The fleet config, read as the supervisor reads it, on a short window. */
  fleetRoster: () => ReturnType<typeof readFleetRoster>;
  harnessFilter: (url: URL) => HarnessView | "all" | null;
  runRows: (now?: number) => Promise<RunRow[]>;
  allTotals: () => Promise<Map<string, RunTotals>>;
  withResolved: (row: RunRow, totals: RunTotals | null) => RunRow;
  runFacts: (now: number) => Promise<RunFact[]>;
  unpublishedRuns: () => Promise<string[]>;
  runRowOne: (runId: string, now?: number) => Promise<RunRow>;
  runTotals: (runId: string) => Promise<RunTotals | null>;
  listRowOf: (raw: RunRow, totals: RunTotals | null) => RunListRow;
  /** The listing this handle serves: a public handle's leaves out what it withholds. */
  resultRuns: () => Promise<ResultRun[]>;
  /** Every run, withheld or not: what the scripted reference line is read from. */
  allResultRuns: () => Promise<ResultRun[]>;
}
