/**
 * The wire shapes of the viewer's read-only `/api` surface.
 *
 * This module is the contract between the Bun viewer and the `dashboard/` SPA,
 * and it is imported by both. It therefore has **no imports of its own** and
 * declares types only: the dashboard bundles for a browser and cannot pull in
 * `bun:sqlite` transitively, and a type-only module keeps the two sides from
 * drifting without either owning the other.
 *
 * The server-side modules (`runs.ts`, `tail.ts`) re-export the names they used
 * to declare, so nothing that imported them before has to move.
 */

/** One run, as the listing and the detail endpoint report it. */
export interface RunRow {
  runId: string;
  model: string | null;
  driver: string | null;
  adapter: string | null;
  shakeout: string | null;
  character: string | null;
  /** Where the model was served from: "openrouter", "anthropic", the api host, or the driver. */
  platform: string | null;
  apiBase: string | null;
  harnessVersion: string | null;
  startedAt: number | null;
  endedAt: number | null;
  terminationReason: string | null;
  terminationDetail: string | null;
  pauseReason: string | null;
  level: number | null;
  xp: number | null;
  /** Copper on hand, and quests turned in. Null when this run's schema predates them. */
  money: number | null;
  questsCompleted: number | null;
  mtime: number | null;
  bytes: number | null;
  live: boolean;
  error?: string;
}

/** One `state` sample. Every field but `ts` may be absent from a given sample. */
export interface StatePoint {
  ts: number;
  level: number | null;
  xp: number | null;
  map: number | null;
  x: number | null;
  y: number | null;
  z: number | null;
  eventCount: number | null;
  lastSeq: number | null;
}

/** Provider-reported usage for one turn, normalised across driver shapes. */
export interface ReportedUsage {
  prompt: number;
  completion: number;
  cachedRead?: number;
  cacheWrite?: number;
}

/** Token accounting for a whole run. */
export interface TokenTotals {
  /** "reported" only when a driver actually logged provider usage. */
  source: "reported" | "estimated";
  contextTokens: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Null, never 0, when the provider never said. */
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  turns: number;
}

/**
 * The fields every summarised entry carries. The open index signature is what
 * the server writes through; readers should narrow to `FeedEntry` below.
 */
export interface EntrySummary {
  /** Index of this entry in the file, 0-based. Stable; used to fetch the raw line. */
  i: number;
  t: string;
  ts: number;
  /** Byte range of the raw line, newline excluded. */
  start: number;
  end: number;
  /** True when anything in this entry was dropped or cut for display. */
  clipped?: boolean;
  [key: string]: unknown;
}

/*
 * The read side. `EntrySummary`'s index signature makes every field `unknown`
 * at a call site, which is fine for a server that only forwards it and useless
 * for a UI that renders it. These narrow the shapes the dashboard actually
 * draws; anything else falls through to `OtherEntry` and renders generically.
 */

interface EntryBase {
  i: number;
  ts: number;
  start: number;
  end: number;
  turn?: number;
  clipped?: boolean;
}

export interface RequestEntry extends EntryBase {
  t: "request";
  adapter?: string;
  messageCount?: number;
  systemChars?: number;
  promptChars?: number;
  usage?: ReportedUsage;
}

export interface ResponseEntry extends EntryBase {
  t: "response";
  text?: string;
  tools?: string[];
  outChars?: number;
  usage?: ReportedUsage;
}

export interface SnippetEntry extends EntryBase {
  t: "snippet";
  code?: string;
}

export interface SnippetResultEntry extends EntryBase {
  t: "snippet_result" | "tool_result";
  name?: string;
  isError?: boolean;
  text?: string;
}

export interface EventsServedEntry extends EntryBase {
  t: "events_served";
  via?: string;
  count?: number;
  opcodes?: string[];
  ambient?: number;
  moreOpcodes?: number;
  folded?: number;
}

/** Everything else: `meta`, `state`, `notice`, `termination`, future types. */
export interface OtherEntry extends EntryBase {
  t: string;
  [key: string]: unknown;
}

export type FeedEntry =
  | RequestEntry
  | ResponseEntry
  | SnippetEntry
  | SnippetResultEntry
  | EventsServedEntry
  | OtherEntry;

/** One agent, at one moment (ADR-0019's position feed). */
export interface AgentPosition {
  runId: string;
  character: string | null;
  model: string | null;
  map: number;
  x: number;
  y: number;
  /** Epoch ms of the state sample this position came from. */
  ts: number;
  level: number | null;
  xp: number | null;
  money: number | null;
  questsCompleted: number | null;
  harnessVersion: string | null;
}

/** A run row as the listing serves it: the row plus whole-file totals. */
export interface RunListRow extends RunRow {
  tokens: TokenTotals | null;
  firstTs: number | null;
  lastTs: number | null;
  /**
   * Cumulative time the run spent being driven: the wall clock span minus the
   * stretches it sat paused between a `pause` and its `resume`. Computed
   * server-side so the fleet listing and the run page cannot disagree.
   */
  playtimeMs: number | null;
}

export interface RunsResponse {
  runs: RunListRow[];
}

export interface PositionsResponse {
  positions: AgentPosition[];
}

export interface RunDetailResponse {
  run: RunRow;
  states: StatePoint[];
  total: number;
  tokens: TokenTotals;
  /** Cumulative active time; see `RunListRow.playtimeMs`. */
  playtimeMs: number | null;
}

export interface EntriesResponse {
  from: number;
  total: number;
  entries: FeedEntry[];
}

/** One lane of the fleet supervisor, as `fleet-state.json` records it. */
export interface FleetLane {
  pid: number;
  account: string;
  rosterPath: string;
  jsonl: string;
  stdoutLog: string;
  spawnedAt: number;
  exitCode: number | null;
  draining: boolean;
  alive?: boolean;
}

/**
 * What the viewer resolves about a lane that `fleet-state.json` does not record:
 * which run currently holds the lane's account, and what the lane will run next.
 *
 * The supervisor publishes processes, not runs; the run a lane is driving is
 * inferred the same way `run-fleet.ts --status` infers it (see `accountHeldBy`
 * in `run-roster.ts`) — from the run directories themselves.
 */
export interface FleetLaneRun {
  /** The run holding this lane's account, or null when the account is free. */
  runId: string | null;
  /** That run's model. Null whenever `runId` is. */
  model: string | null;
  /** Models the lane's roster will work through, in roster order. */
  rosterModels: string[];
}

/** A lane as `/api/fleet` serves it: the state file's record plus what we resolved. */
export type FleetLaneView = FleetLane & { name: string } & FleetLaneRun;

/**
 * The supervisor's published state. `present: false` is the normal answer on a
 * machine where the fleet has never run — it is not an error.
 */
export interface FleetResponse {
  present: boolean;
  fleetPid?: number;
  startedAt?: number;
  heartbeatAt?: number;
  containerized?: boolean;
  stamp?: string;
  lanes: FleetLaneView[];
  /** Server clock at read time, so a client can age the heartbeat honestly. */
  now: number;
}

/** What the API says about itself: capability flags the SPA branches on. */
export interface ApiInfoResponse {
  /** Harness version the viewer process was built from, when it can tell. */
  service: "wrathbench-viewer";
  /** True when raw bodies, scratchpads and tiles are withheld (public mode). */
  publicMode: boolean;
  /** True when a built dashboard is being served from disk. */
  dashboard: boolean;
  /**
   * The worldserver as its module's /health reports it: the build stamp the
   * image was compiled with and its process start. `null` when the module is
   * unreachable from the viewer or predates the field (cached briefly).
   */
  worldserver: { build: string; startedAtMs: number } | null;
  now: number;
}

export interface ApiError {
  error: string;
}
