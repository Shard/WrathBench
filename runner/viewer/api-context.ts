/**
 * What `createApi` (`api.ts`) shares with the route modules it mounts: one
 * object, built once per handle, so a module reads the handle's own store,
 * memos and projection rather than a module-level global. Functions only, and
 * values fixed at construction: a memo lives in the closure that owns it, and
 * a module reaches it through the function that reads it.
 */

import type { RunFact } from "../src/run-fact";
import type { RunTotals } from "../src/run-totals";
import type { closedWindowsMemo } from "@wrathbench/inspector";
import type { HarnessView, ResultRun, RunListRow, RunRow, StateItemsRow, StatePoint } from "./api-types";
import type { TailCache } from "./api-tails";
import type { RunStore } from "./clickhouse";
import type { Groups } from "./groups";
import type { RosterBase } from "./roster";

export interface ApiContext {
  runsDir: string;
  /** The derived store, its corpus-wide reads shared (`sharedStore`). */
  store: RunStore;
  publicMode: boolean;
  groups: Groups;
  /** Serve a body, through the public projection when the handle is public. */
  pub: <T>(body: T, project: (b: T) => unknown, runIds?: readonly string[]) => Response;
  /**
   * The fleet config's roster names and `site` block (`roster.ts`), read on a
   * short window; a route that needs the policy or the campaigns completes it
   * (`fullRosterOf`, `models.ts`).
   */
  fleetRoster: () => RosterBase;
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
  /** Project-then-strike, as `pub` does, for a body served by hand. */
  struckFor: (projected: unknown, runIds: readonly string[]) => unknown;
  /** Strike the named runs' session tokens out of a public text. */
  publicText: (text: string, runIds: readonly string[]) => string;
  /** The handle's run tails and settled track cores (`api-tails.ts`). */
  tails: TailCache;
  runRowAndLead: (runId: string, now?: number) => Promise<{ run: RunRow; lead: string | null }>;
  statesOfRun: (runId: string) => Promise<StatePoint[]>;
  stateItemsOfRun: (runId: string) => Promise<StateItemsRow[]>;
  /** Whether a public handle answers this run as if it did not exist. */
  withheldRun: (runId: string) => Promise<boolean>;
  /** Each run's closed trace windows, memoised (`closedWindowsMemo`). */
  closedWindows: ReturnType<typeof closedWindowsMemo>;
  traceSegs: (runId: string, now: number) => ReturnType<ReturnType<typeof closedWindowsMemo>>;
}
