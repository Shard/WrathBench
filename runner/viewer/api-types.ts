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

/**
 * The comparability tuple a run was stamped with (ADR-0026).
 *
 * Structurally identical to `Comparability` in `runner/src/comparability.ts`,
 * which is where it is defined and validated. It is mirrored rather than
 * imported because this module is import-free by construction (ADR-0022) —
 * the dashboard bundles it for a browser and must not pull `zod`, `bun:sqlite`
 * or the prompt text in behind it. `runner/test/comparability.test.ts` pins
 * the two shapes to each other.
 */
export interface EpisodeBudgetView {
  maxTurns: number | null;
  maxToolCalls: number;
  idleMs: number | null;
  noXpMs: number | null;
  episodeMs: number | null;
  maxSandboxRestarts: number;
}

/**
 * The episode tiers (`runner/src/episodes.ts`). Spelled out as a literal union
 * rather than imported, because this module is import-free by construction.
 */
export type EpisodeIdView = "e90" | "e360" | "freeplay";

/** One episode tier as `/api/episodes` serves it. Mirrors `EpisodeTier`. */
export interface EpisodeTierView {
  id: EpisodeIdView;
  minutes: number | null;
  idleMinutes: number;
  noXpMinutes: number | null;
  /** Tool-call ceiling the tier pins, or null when it pins none. */
  toolCalls: number | null;
  objectiveAllowed: boolean;
  scored: boolean;
  summary: string;
}

/** `/api/episodes`: the table, plus how many runs are tagged against each tier. */
export interface EpisodesResponse {
  episodes: (EpisodeTierView & {
    /**
     * Runs that are *members* of this tier's comparability group: stamped with
     * the id and never overridden. This is the count a chart may use.
     */
    members: number;
    /** Stamped with the id but given a leash the id does not describe. */
    overrides: number;
    /**
     * Labeled with the id by the reader rather than stamped at launch — an
     * older run that looks like this tier. Countable, never a member (ADR-0030:
     * past runs are not back-labeled).
     */
    derived: number;
  })[];
  /** Runs that belong to no tier at all — neither stamped nor derivable. */
  untiered: number;
  /**
   * Stillborn runs excluded from every count above. They carry a stamped tuple
   * (meta.json is written at launch) and would otherwise inflate tier
   * membership with launches that never produced a turn.
   */
  stillbornExcluded: number;
  now: number;
}

export interface ComparabilityView {
  harnessVersion: string;
  promptHash: string;
  promptChars: number;
  contextEngine: string;
  effort: string | null;
  budget: EpisodeBudgetView;
  /** True when an operator objective steered the run, which makes it unscored. */
  objective: boolean;
  /**
   * Whether `search_reference` served wiki coordinates (ADR-0028). Absent on
   * runs stamped before the field existed.
   */
  wikiCoords?: boolean;
  /**
   * The episode tier the run was launched under, or null for a run assembled
   * flag-by-flag. Absent on runs stamped before the field existed.
   */
  episode?: EpisodeIdView | null;
  /** True when a tier run's effective watchdogs are not its tier's. */
  episodeOverride?: boolean;
  /**
   * The worldserver's own build identity off its `/health` at launch (or
   * resume-restamp) time. Null when the module was unreachable, or for a run
   * that predates this field.
   */
  serverBuild: { build: string; startedAtMs: number } | null;
}

/** One run, as the listing and the detail endpoint report it. */
export interface RunRow {
  runId: string;
  model: string | null;
  driver: string | null;
  adapter: string | null;
  shakeout: string | null;
  /** The operator objective this run was steered with (ADR-0024), or null. */
  objective: string | null;
  character: string | null;
  /** Where the model was served from: "openrouter", "anthropic", the api host, or the driver. */
  platform: string | null;
  apiBase: string | null;
  harnessVersion: string | null;
  /**
   * The stamped comparability tuple, or null for a run whose metadata predates
   * the stamp. Null reads as "not recorded": nothing recomputes it, because a
   * prompt hash taken against today's prompt would be a fabricated claim.
   */
  comparability: ComparabilityView | null;
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
  /**
   * The driver turn in flight when the sample was taken; null on runs written
   * before the column existed, and on samples taken before the first turn.
   * Samples are taken on a clock, so this is first-observation, not first-reach.
   */
  turn: number | null;
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
  /**
   * `response` records in the trajectory — the model's own turns. Null when the
   * trajectory could not be read. Not a turn count: one API reply can produce
   * several records under the claude driver, so it is only ever read as
   * zero-or-not.
   */
  modelResponses: number | null;
  /**
   * True when this run never produced a model response and is no longer live
   * (`runner/viewer/stillborn.ts`). Such a run never got off the ground; the
   * dashboard hides it unless asked.
   */
  stillborn: boolean;
}

export interface RunsResponse {
  runs: RunListRow[];
  /** Whether `?includeStillborn=1` kept stillborn runs in `runs`. */
  includeStillborn: boolean;
  /** How many stillborn runs there are — shown, not silently dropped. Present
   * whether or not they were included, so a toggle has its count either way. */
  stillbornExcluded: number;
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

/**
 * One level a run was observed to reach, with the cost of reaching it.
 *
 * "Observed": state samples are taken on `stateIntervalMs`, so both numbers are
 * of the first sample that *showed* the level, never of the moment it was
 * reached. `playtimeMs` is the pause-corrected active time (the same figure the
 * run page shows), so a run that sat quota-exhausted for two hours is not
 * charged for them.
 */
export interface LevelMark {
  level: number;
  ts: number;
  /** Turn at first observation. Null when the run recorded no turn index. */
  turn: number | null;
  /** Active time from the run's start to that sample. */
  playtimeMs: number | null;
}

/** One run as the eval charts read it: identity, comparability, level marks. */
export interface EvalRun {
  runId: string;
  model: string | null;
  platform: string | null;
  harnessVersion: string | null;
  effort: string | null;
  contextEngine: string | null;
  promptHash: string | null;
  /** The worldserver build this run was stamped against, or null (ADR-0026). */
  serverBuild: string | null;
  /** Whether wiki coordinates were served (ADR-0028); null when not recorded. */
  wikiCoords: boolean | null;
  /**
   * The run's episode tier: stamped when the run was launched with `--episode`,
   * otherwise derived by the reader from what the run's tuple recorded, and
   * null when neither is possible. Nothing rewrites a stored tuple.
   */
  episode: EpisodeIdView | null;
  /** How this run got its tier. `"none"` when it has none. */
  episodeSource: "stamped" | "derived" | "none";
  /** True when a stamped tier run's watchdogs were overridden at launch/resume. */
  episodeOverride: boolean;
  /**
   * Tool calls the run made, counted from its `tool_call` records — the unit
   * the episode ceiling is enforced in. Null when the trajectory could not be
   * read. `snippets` is the `eval_snippet` subset of the same count.
   */
  toolCalls: number | null;
  snippets: number | null;
  /** `response` records; see `RunListRow.modelResponses`. */
  modelResponses: number | null;
  /** True when the run never produced a model response (`stillborn.ts`). */
  stillborn: boolean;
  /** Why this run cannot be scored, or null when it can (ADR-0004, ADR-0024). */
  unscored: string | null;
  startedAt: number | null;
  terminationReason: string | null;
  levels: LevelMark[];
  maxLevel: number | null;
  questsCompleted: number | null;
  /** Maps the run was observed on, for the ladder's Outland/Northrend rungs. */
  maps: number[];
}

export interface EvalResponse {
  runs: EvalRun[];
  /** The tier the response was filtered to, or "all". Echoed so a page can
   * render what it actually asked for rather than what it meant to ask for. */
  episode: EpisodeIdView | "all";
  /** Whether `?includeOverrides=1` widened the filter to overridden tier runs. */
  includeOverrides: boolean;
  /** Runs dropped by that filter. A chart that silently drops rows is a lie of
   * omission, so the count travels with the rows. */
  filteredOut: number;
  /** Of those, how many were dropped only for being overridden tier runs —
   * the ones `?includeOverrides=1` would bring back. */
  overridesExcluded: number;
  /** Whether `?includeStillborn=1` kept stillborn runs in `runs`. */
  includeStillborn: boolean;
  /** Stillborn runs matching the episode filter. Counted either way, so the
   * toggle can say how many it would reveal. */
  stillbornExcluded: number;
  now: number;
}

/** A run's whole recorded track, for map replay (FOLLOW-UPS 22). */
export interface TrackPoint {
  ts: number;
  map: number;
  x: number;
  y: number;
  level: number | null;
  xp: number | null;
  money: number | null;
  questsCompleted: number | null;
  turn: number | null;
}

export interface TrackResponse {
  runId: string;
  character: string | null;
  model: string | null;
  harnessVersion: string | null;
  points: TrackPoint[];
}

export interface ApiError {
  error: string;
}

/* -------------------------------------------------------------- models --- */

/**
 * The scheduler's verdict on a model, as `/api/models` serves it.
 *
 * Every field mirrors `ModelState` in `runner/src/models.ts`, which is where
 * the projection lives and the only place any of it is decided. The route adds
 * the run ids behind each count and the last error text; it computes no number
 * of its own, so the page and `run-fleet --status` cannot disagree about why a
 * model is not running (ADR-0031, ADR-0030).
 */
export type ModelStatusView = "new" | "active" | "cooling" | "promoted" | "retired";

/** One tier's counts for one model, plus the runs behind them. */
export interface ModelEpisodeView {
  /** Stamped, un-overridden runs that produced at least one model response. */
  counted: number;
  /** Stamped runs that never produced one — launches that did not happen. */
  stillborn: number;
  /** Every stamped run on this tier, counted or not. */
  attempts: number;
  /** Runs the policy wants at this tier before it stops scheduling them. */
  target: number;
  bestLevel: number | null;
  /** A counted run reached the promotion level — the e360 witness. */
  reachedL5: boolean;
  lastEnded: number | null;
  lastReason: string | null;
  /** The counted runs, newest first. The ids behind `counted`, not a sample. */
  runIds: string[];
  /** The stillborn ones, kept apart so a dead provider cannot pad a count. */
  stillbornRunIds: string[];
}

/** One of a model's runs, as the detail panel lists it. */
export interface ModelRunView {
  runId: string;
  episode: EpisodeIdView;
  episodeOverride: boolean;
  harnessVersion: string | null;
  startedAt: number;
  endedAt: number | null;
  /** Wall clock, start to end — not active time; the run page owns that. */
  durationMs: number | null;
  bestLevel: number | null;
  terminationReason: string | null;
  live: boolean;
  counted: boolean;
  stillborn: boolean;
}

/** The last error a model died of, off the end of that run's trajectory. */
export interface ModelLastErrorView {
  runId: string;
  reason: string;
  /** Truncated, and with the run's own recorded secrets struck out. */
  message: string;
  at: number | null;
}

export interface ModelRowView {
  /** The roster name (ADR-0031's `roster` map key) — the row's identity. */
  name: string;
  model: string;
  effort: string | null;
  platform: string | null;
  status: ModelStatusView;
  /** Tiers the model may be scheduled on, in policy order. */
  eligible: EpisodeIdView[];
  perEpisode: Partial<Record<EpisodeIdView, ModelEpisodeView>>;
  cooling?: { until: number; rung: number; reason: string };
  retired?: { at: number; reason: string };
  /** Consecutive no-progress attempts on the defer ladder. */
  ladder: number;
  /** This model's stamped runs, newest first. */
  runs: ModelRunView[];
  newestRunId: string | null;
  lastError: ModelLastErrorView | null;
}

export interface ModelsResponse {
  models: ModelRowView[];
  /**
   * Where the roster came from. `legacy` is a fleet config that predates
   * ADR-0031's `roster` map: it names no models, and names are not invented
   * from lane entries because they would stop matching at the rename.
   */
  roster: {
    path: string | null;
    shape: "roster" | "legacy" | "missing" | "unreadable";
    count: number;
  };
  policy: {
    runsPerEpisode: { e90: number; e360: number };
    promoteAtLevel: number;
  };
  /** The defer ladder's rungs, so the page can say "rung 3 of 9" honestly. */
  ladderMs: number[];
  now: number;
}
