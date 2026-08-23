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

/**
 * The harness a run ran under (ADR-0035): `wrathbench` is the fixed loop,
 * `claude-code` the Claude Code CLI scaffold. Literal union rather than an
 * import, because this module is import-free by construction.
 */
export type HarnessView = "wrathbench" | "claude-code";

export interface ComparabilityView {
  /** `git describe` of this repo's build — the same for either harness. */
  harnessVersion: string;
  promptHash: string;
  promptChars: number;
  /** Which loop owned the run. A pre-ADR-0035 `contextEngine` is mapped here on read. */
  harness: HarnessView;
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
  /**
   * The harness tag (ADR-0035): from the tuple, else the legacy stamp, else
   * the driver. Null only when none of those was recorded.
   */
  harness: HarnessView | null;
  /** The unscored stamp, in today's vocabulary (legacy key name). Null when the run can score. */
  shakeout: string | null;
  /** The operator objective this run was steered with (ADR-0024), or null. */
  objective: string | null;
  /** An extra run (ADR-0034): past the policy target, scored like any other, never counted by the fleet. */
  extra: boolean;
  character: string | null;
  /**
   * The starting character the run was launched with (ADR-0034's extras cycle
   * gives free models a different one per extra run). Ids are the client's own
   * 3.3.5a race/class ids; the names are `runner/viewer/characters.ts`
   * resolving them, with an id no table knows rendering as its own number.
   * Null is "not recorded" — a run whose metadata predates the fields.
   */
  race: number | null;
  raceName: string | null;
  class: number | null;
  className: string | null;
  /** "Dwarf Hunter" — the compact label a row shows. Null when neither id was recorded. */
  characterLabel: string | null;
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
  /** What the provider charged for this call, in dollars (OpenRouter credits).
   * Present only when the provider reports it — the run's *actual* cost is the
   * sum of these, and nothing here estimates one. */
  cost?: number;
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

/** The four priced components of a run's tokens, in dollars. */
export interface CostBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * One dollar figure with its provenance (`runner/viewer/pricing.ts`).
 *
 * `basis` is the field to read first:
 * - `reported` — a figure the provider itself billed: OpenRouter's per-response
 *   `usage.cost` summed over the run, or the Claude Agent SDK's
 *   `total_cost_usd`. Used verbatim.
 * - `list-price` — this repo's price table applied to `TokenTotals`.
 * - `none` — nothing to say, and `note` says which nothing: no price on file,
 *   no synced price, estimated tokens, or a provider that reports no cost.
 *
 * `asIfMetered` marks a figure the operator did not actually pay: a flat
 * subscription, a free tier, or local hardware. The number is then a
 * comparison, never an invoice.
 */
export interface CostFigure {
  usd: number | null;
  basis: "reported" | "list-price" | "none";
  asIfMetered: boolean;
  /** Per-component dollars, when the figure was computed. Null when reported. */
  breakdown: CostBreakdown | null;
  /** The price row the figure was computed at, and when that row was taken.
   * Both null unless `basis` is `list-price` — a reported figure has no table
   * behind it. The date is on the wire rather than baked into a display string
   * so a stale price cannot go on reading as a current one. */
  priceId: string | null;
  asOf: string | null;
  /** Always present: a blank cost states something and must say what. */
  note: string;
}

/**
 * What a run cost, twice over, because the two answers are different questions.
 *
 * - `actual` — what the provider says it charged. The only figure that is a
 *   bill. Null (`basis: "none"`) whenever the provider reports no cost, which
 *   is most runs: OpenRouter only sends `usage.cost` on the usage opt-in, and
 *   the Claude SDK only emits `total_cost_usd` on a cleanly ended session.
 * - `expected` — the price table applied to the run's own tokens. Always
 *   attempted, even when `actual` exists, so the two can be compared and a
 *   stale price row shows up as a divergence rather than as silence.
 *
 * The top-level fields are `expected`, kept for one release so older consumers
 * keep working. Read `actual`/`expected` in new code.
 */
export interface CostView extends CostFigure {
  actual: CostFigure;
  expected: CostFigure;
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
  /** The run's cost, on the same basis the run page shows. Null when unreadable. */
  cost: CostView | null;
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
  /** What the run cost, or why not. Accumulates with the trajectory on a live run. */
  cost: CostView;
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
 * One job with a live process, as the supervisor publishes it (ADR-0034: the
 * job is the one unit of work, and a lane is how it is spawned). A job names
 * the roster entry it is running, the tier, the account it landed on, and
 * where it came from — the file's pinned list, the manual queue, or the
 * policy's own pick — which is what the lane block cannot say (FOLLOW-UPS 52).
 */
export interface FleetJobView {
  name: string;
  /** The roster ref, or several joined by `+` for a rotating job. */
  ref: string;
  episode: string;
  account: string;
  /** The class of the account it landed on (ADR-0034): pool, paid, local, or pinned. */
  accountClass?: string;
  source: string;
  /** The n-th attempt on (model, episode); absent on a job from the file. */
  attempt?: number;
  /** The paused run this spawn is resuming (ADR-0036), when it is resuming one. */
  resuming?: string;
  /** The models behind `ref`, in roster order. */
  models: string[];
  /**
   * The run holding this job's account, resolved the same way a lane's is
   * (`heldAccounts`). Null between episodes and while a resume is spawning.
   */
  runId?: string | null;
  /** The supervisor's process record for this job: what it published as a lane. */
  pid?: number;
  spawnedAt?: number;
  exitCode?: number | null;
  draining?: boolean;
  alive?: boolean;
}

/**
 * One account and what holds it, as the supervisor's `accounts` block records
 * it (ADR-0034's classes). `job` is null when nothing is on it — which is what
 * the fleet table's idle rows are made of.
 */
export interface FleetAccountView {
  account: string;
  /** `pinned` (a job names it), or the class that may schedule it. */
  class: "pinned" | "pool" | "paid" | "local";
  job: string | null;
}

/**
 * A paused run the supervisor is holding rather than resuming (ADR-0036), as
 * `--status` lists it. A paused run holds no account, so it shows against the
 * idle account it paused on rather than as a job.
 */
export interface FleetPausedView {
  runId: string;
  model: string;
  account: string | null;
  reason: string;
  since: number;
  elapsedMs: number | null;
  budgetMs: number | null;
  why: string;
}

/** The supervisor's counters since it started (`session` in fleet-state.json). */
export interface FleetSessionView {
  finished: number;
  ok: number;
  retried: number;
}

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
  /**
   * Every job with a live process, newest supervisors only: a state written
   * before ADR-0034's job concept has lanes and no jobs, and the field is
   * absent rather than synthesised from them.
   */
  jobs?: FleetJobView[];
  /**
   * Every account the supervisor knows, with its class and what holds it.
   * Absent on a supervisor that published no `accounts` block.
   */
  accounts?: FleetAccountView[];
  /** Paused runs the supervisor is not resuming right now; absent on an older one. */
  paused?: FleetPausedView[];
  /** Runs finished since this supervisor started; absent on an older one. */
  session?: FleetSessionView;
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
  /**
   * `major.minor` of the harness version (ADR-0034): the comparability group
   * the charts key on, with the exact versions listed on the row. Null when
   * the stamp has none.
   */
  harnessSeries: string | null;
  /** An extra run past the policy target (ADR-0034); scored like any other, reported apart by the fleet. */
  extra: boolean;
  /**
   * The run's starting character (ADR-0034's extras cycle). Ids as recorded,
   * names resolved by `runner/viewer/characters.ts`; null is "not recorded".
   * A dimension the charts *label and filter on*, never a group key: the
   * baseline character is the comparison set.
   */
  race: number | null;
  raceName: string | null;
  class: number | null;
  className: string | null;
  /** "Dwarf Hunter", or null when neither id was recorded. */
  characterLabel: string | null;
  effort: string | null;
  /** The harness tag (ADR-0035). A tag on the row, not a partition. */
  harness: HarnessView | null;
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
  /**
   * XP *within* `maxLevel`: the highest reading any sample carried at that
   * level. Together with `maxLevel` it is the ladder's total-XP ordering
   * (ADR-0018 amendment) — the pair is lexicographic because xp resets at each
   * level and level never goes down. Null when no sample recorded xp there.
   */
  xp: number | null;
  /**
   * Copper on the newest sample that carried a reading — the same number the
   * fleet listing and the run page show, not a peak (no state sample the eval
   * surface reads carries money, so a peak is not derivable). Null when never
   * recorded; zero is a real reading.
   */
  money: number | null;
  questsCompleted: number | null;
  /** Maps the run was observed on, for the ladder's Outland/Northrend rungs. */
  maps: number[];
}

export interface EvalResponse {
  runs: EvalRun[];
  /** The tier the response was filtered to, or "all". Echoed so a page can
   * render what it actually asked for rather than what it meant to ask for. */
  episode: EpisodeIdView | "all";
  /** The `?harness=` filter the response honoured; "all" (the default) means no filter. */
  harness: HarnessView | "all";
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
  /** Attempts past the target (`extra: true`), reported apart and never counted. */
  extras: number;
  /** Runs from another harness series: listed, never counted, never attempts. */
  otherSeries: number;
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
  /** The series the run's version belongs to; the schedule counts only the current one. */
  harnessSeries: string | null;
  /** An extra run (ADR-0034): an attempt past the target, never counted. */
  extra: boolean;
  /**
   * The run's starting character, attached by the route from the same run rows
   * the listing reads. Optional for the reason `cost` is: the projection this
   * view is built from (`runner/src/models.ts`) does not carry it.
   */
  race?: number | null;
  raceName?: string | null;
  class?: number | null;
  className?: string | null;
  characterLabel?: string | null;
  startedAt: number;
  endedAt: number | null;
  /** Wall clock, start to end — not active time; the run page owns that. */
  durationMs: number | null;
  bestLevel: number | null;
  terminationReason: string | null;
  live: boolean;
  counted: boolean;
  stillborn: boolean;
  /**
   * The run's cost, attached by the route from the same memoised trajectory
   * totals the listing uses. Optional because the projection this view is built
   * from (`runner/src/models.ts`) does not know about prices.
   */
  cost?: CostView | null;
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
  /** The harness this roster entry's runs go through (ADR-0035), from its driver. */
  harness: HarnessView;
  /** Free or paid (`runner/src/model-cost.ts`): what the policy's targets, cap and extras key on. */
  billing: "free" | "paid";
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
    /** Every entry the roster names, excluded ones included. */
    count: number;
    /**
     * Entries the policy does not schedule and this response does not row:
     * a name a pinned job holds (a probe on its own account) or one carrying
     * an objective. Same predicate as `run-fleet --status` (FOLLOW-UPS 52).
     */
    excluded: { name: string; reason: string }[];
  };
  policy: {
    runsPerEpisode: { e90: number; e360: number };
    promoteAtLevel: number;
    /** The series the counts are keyed on (this checkout's); null when unversioned, which counts every run. */
    series: string | null;
    /** The paid policy when the file turns it on (ADR-0034); null is no split. */
    paid: { runsPerEpisode: { e90: number; e360: number }; maxConcurrent: number } | null;
    /** The extras policy when on: how many characters the cycle holds. */
    extras: { characters: number } | null;
    /**
     * `policy.maxConcurrent`: streams the policy may have in flight per
     * driver, counting every job on that driver. An absent driver is
     * unlimited; an empty object is a file that names no cap.
     */
    maxConcurrent: Record<string, number>;
  };
  /** The defer ladder's rungs, so the page can say "rung 3 of 9" honestly. */
  ladderMs: number[];
  /** The `?harness=` filter honoured; "all" (the default) lists every roster row. */
  harness: HarnessView | "all";
  now: number;
}
