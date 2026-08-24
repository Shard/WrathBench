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
export type EpisodeIdView = "e90" | "e360" | "probing" | "freeplay";

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

/**
 * One probe campaign as `/api/campaigns` serves it (ADR-0041).
 *
 * Built from the RUN DIRECTORY, not from the config, which is the whole point:
 * a campaign that has been completed, switched off and deleted from the file
 * still has a row here, because its runs are what happened. `config` is the
 * config's side of the story when the entry is still present, and null when it
 * is not — a row with runs and no config is a finished campaign, not an error.
 */
export interface CampaignRowView {
  campaign: string;
  /** The config entry, when the file still names this campaign. */
  config: {
    enabled: boolean;
    runsPerCell: number;
    /** Cell ids the config declares, in declaration order. */
    cells: string[];
    /** How many catalog entries the campaign sweeps, as resolved right now. */
    models: number;
    /** Whether every (model, cell) has its runs: derived, never recorded. */
    complete: boolean;
    /** The account it is pinned to, or null when it draws from the pool. */
    account: string | null;
  } | null;
  /** Counted probe runs recorded against this campaign. */
  runs: number;
  /** Runs still in flight. */
  live: number;
  /** Distinct models that have run a cell of it. */
  models: string[];
  /** Per cell, what has happened — including a cell the config no longer declares. */
  cells: {
    cell: string;
    /** Null when the config no longer declares this cell but runs of it exist. */
    declared: boolean;
    runs: number;
    models: string[];
    /** Best level any run of this cell reached, or null. */
    bestLevel: number | null;
  }[];
  newestRunId: string | null;
  newestAt: number | null;
}

/** `/api/campaigns`: the probe lane, grouped by what commissioned each run. */
export interface CampaignsResponse {
  campaigns: CampaignRowView[];
  /** Probe runs that recorded no campaign at all — a launch that should not exist. */
  orphans: number;
  /** Where the fleet config was read from, so a missing `config` can be explained. */
  configPath: string | null;
  now: number;
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
  /** Which loop owned the run (ADR-0035). */
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
   * Which reference bundle the run read, off the bundle's own `meta` table
   * (ADR-0033). An annotation: a text-changing rebuild is paired with a harness
   * minor bump, which is what actually groups. Null when the run had no bundle;
   * absent on runs stamped before the field existed.
   */
  wikiBundle?: {
    schemaVersion: string | null;
    builtAt: string | null;
    source: string | null;
    eraCutoff: string | null;
  } | null;
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
  /** The harness tag (ADR-0035): from the tuple, else the driver. Null when neither was recorded. */
  harness: HarnessView | null;
  /** The unscored stamp (the key keeps the old column name). Null when the run can score. */
  shakeout: string | null;
  /** The operator objective this run was steered with (ADR-0024), or null. */
  objective: string | null;
  /**
   * The probe campaign that commissioned this run and which of its cells it is
   * (ADR-0041), or null on anything else. Read off the run's own config, which
   * is what lets a campaign's results outlive the deletion of its config entry:
   * this page is built from the run directory, not from the roster.
   */
  campaign: string | null;
  cell: string | null;
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
  /**
   * What the character wears and carries, from the newest state sample that
   * recorded it (FOLLOW-UPS 50). Null on runs that predate the `items` column.
   */
  items: ItemSample[] | null;
  mtime: number | null;
  bytes: number | null;
  live: boolean;
  error?: string;
}

/** One item on a state sample: a client-cache name, its stack count, worn or carried. */
export interface ItemSample {
  name: string;
  count: number;
  equipped: boolean;
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
  /** The newest recorded inventory; see `RunRow.items`. */
  items: ItemSample[] | null;
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
}

/**
 * Every run on disk. There is no zero-response filter: a run that terminates
 * without a single model response is archived by the runner as it exits, so it
 * never reaches a listing at all.
 */
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

/**
 * One job with a process, as the supervisor publishes it (ADR-0034: the job
 * is the one unit of work; an account, with a class, is where it runs). A job
 * names the roster entry it is running, the tier, the account it landed on,
 * where it came from — the file's pinned list, the manual queue, or the
 * policy's own pick — and the process that runs it.
 *
 * The supervisor publishes processes, not runs; the run a job is driving is
 * resolved the same way `run-fleet.ts --status` resolves it (see
 * `accountHeldBy` in `run-roster.ts`) — from the run directories themselves.
 */
export interface FleetJobView {
  name: string;
  /** The roster ref, or several joined by `+` for a rotating job. */
  ref: string;
  /**
   * The tier the job runs under, or **null** when the supervisor could not name
   * one (commit 95908d5: unknown is written as null, never guessed at). A page
   * says "episode unknown" for it rather than showing a dash, which is what an
   * account holding no job shows.
   */
  episode: string | null;
  account: string;
  /** The class of the account it landed on (ADR-0034): pool, paid, local, or pinned. */
  accountClass: "pinned" | "pool" | "paid" | "local";
  source: string;
  /** The n-th attempt on (model, episode); absent on a job from the file. */
  attempt?: number;
  /** The paused run this spawn is resuming (ADR-0036), when it is resuming one. */
  resuming?: string;
  /** The models behind `ref`, in roster order. */
  models: string[];
  /** The run holding this job's account (`heldAccounts`). Null between episodes and while a resume is spawning. */
  runId: string | null;
  /** That run's model. Null whenever `runId` is. */
  model: string | null;
  /** The supervisor's process record for this job. */
  pid: number;
  spawnedAt: number;
  exitCode: number | null;
  draining: boolean;
  alive: boolean;
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
  /** How many times this run has paused; what the resume cadence indexes. */
  pauseCount: number;
  /** When the supervisor will try again; null when it is not a matter of time. */
  resumeAfter: number | null;
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

/** A paused run the supervisor ended instead of resuming (its ref names another model now). */
export interface FleetEndedView {
  runId: string;
  model: string;
  ref: string;
  detail: string;
}

/** The preflight gate's last result (ADR-0023), as the supervisor recorded it. */
export interface FleetPreflightView {
  at: number;
  serverIdentity: string;
  /** The server's /health `build` stamp. */
  build?: string;
  ok: boolean;
  /** The gate was disabled: nothing ran, the gate is open. */
  skipped?: boolean;
  results: { script: string; ok: boolean; ms: number; tail: string }[];
}

/** The file on disk is rejected; the supervisor runs on its last good config. */
export interface FleetConfigRejectedView {
  since: number;
  error: string;
}

/**
 * How much of the schedule is still owed, as `runner/src/models.ts` computes
 * it (`outstandingWork`, where the formula and its two simplifications are
 * written out). `lower` assumes no further promotions, `upper` assumes every
 * still-eligible model promotes; the ETAs are wall clock from now, and null
 * when some of the work has no account to run it on. Shaped here rather than
 * imported, because this file stays import-free.
 */
export interface FleetOutstandingView {
  lower: number;
  upper: number;
  etaLowerMs: number | null;
  etaUpperMs: number | null;
  breakdown: {
    group: string;
    concurrency: number;
    lowerRuns: number;
    upperRuns: number;
    lowerMinutes: number;
    upperMinutes: number;
  }[];
}

/**
 * The worldserver's deploy-window phase, as `infra/deploy-worldserver.sh`
 * writes it to `data/runs/server-state.json` at each transition. `running`
 * is the rest state (and the answer when the file is absent); the four
 * window phases mean a deploy holds the server right now; `rolled-back` and
 * `failed` are verdicts that stay up until the supervisor next boots. The
 * detail is the script's own sentence — the page prints it, never guesses.
 */
export interface FleetServerView {
  phase: "running" | "draining" | "swapping" | "verifying" | "resuming" | "rolled-back" | "failed";
  /** When the window opened (or the phase was reclaimed as running). */
  since: number;
  /** The build being deployed (or, at rest, the one last deployed); "" when unknown. */
  build: string;
  /** The build a failed deploy rolled back to, when there was one. */
  prevBuild?: string;
  detail: string;
  updatedAt: number;
}

/**
 * The supervisor's published state. `present: false` is the normal answer on a
 * machine where the fleet has never run — it is not an error.
 */
export interface FleetResponse {
  present: boolean;
  /** The deploy window's phase; `running` with an empty detail when nothing was ever written. */
  server: FleetServerView;
  fleetPid?: number;
  startedAt?: number;
  heartbeatAt?: number;
  containerized?: boolean;
  stamp?: string;
  /** When the config in force was last parsed. */
  configLoadedAt?: number;
  /** Set while fleet.json on disk does not load; the file's enabled flags are not in effect. */
  configRejected?: FleetConfigRejectedView;
  /** The last gate result; absent until the supervisor has gated once. */
  preflight?: FleetPreflightView;
  /** Every job with a process, as the supervisor published it. */
  jobs: FleetJobView[];
  /** Every account the supervisor knows, with its class and what holds it. */
  accounts: FleetAccountView[];
  /** Paused runs the supervisor is not resuming right now, with why. */
  paused: FleetPausedView[];
  /** Paused runs the supervisor ended instead of resuming, this session. */
  ended: FleetEndedView[];
  /** Runs finished since this supervisor started. */
  session?: FleetSessionView;
  /**
   * Counted runs the policy still owes, with an ETA. Absent when the viewer
   * was given no fleet config to read a roster and its accounts out of.
   */
  outstanding?: FleetOutstandingView;
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
   * An id for the dashboard build currently on disk, or null when none is.
   *
   * An open tab keeps running whatever JavaScript it loaded, possibly hours and
   * several commits old, while a rebuild has already replaced the files behind
   * it — so a bug report can describe code that no longer exists (item 64). The
   * SPA remembers the first value it sees, which IS its own build (index.html
   * is served `no-store`, so a loaded tab was served the build that was current
   * at the time), and says so when a later poll disagrees.
   *
   * It is Vite's own fingerprinted entry filename rather than a new stamp:
   * it already changes exactly when the bundle does, and costs no build step.
   */
  dashboardBuild: string | null;
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

/** One run as the results charts read it: identity, comparability, level marks. */
export interface ResultRun {
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
  /**
   * The probe campaign that commissioned this run and its cell (ADR-0041), or
   * null. A grouping key for the campaigns page and nothing else: a probe is
   * unscored, so these never reach a chart.
   */
  campaign: string | null;
  cell: string | null;
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
   * fleet listing and the run page show, not a peak (no state sample the results
   * surface reads carries money, so a peak is not derivable). Null when never
   * recorded; zero is a real reading.
   */
  money: number | null;
  questsCompleted: number | null;
  /** Maps the run was observed on, for the ladder's Outland/Northrend rungs. */
  maps: number[];
  /*
   * The listing columns. The episodes page is the per-run grain (ADR-0022
   * amendment, 2026-08-23), so the facts the fleet's run table used to carry
   * ride on this row rather than being joined against `/api/runs` in a page.
   */
  /** The character's name, where `characterLabel` is its race and class. */
  character: string | null;
  /** Cumulative active time; the same figure `RunListRow.playtimeMs` carries. */
  playtimeMs: number | null;
  /** The run's token totals, or null when the trajectory could not be read. */
  tokens: TokenTotals | null;
  /**
   * What the provider says it charged — `CostView.actual`, and only that.
   * `CostView`'s own top-level fields are the *expected* figure, so a row that
   * held the whole view would render an estimate wherever a reader reached for
   * `cost.usd`; a listing of what runs cost may not quietly show a guess.
   * `basis: "none"` (with `note` saying which nothing) is the blank.
   */
  actualCost: CostFigure | null;
  /** Why a run is suspended, when it ended for no other reason (ADR-0036). */
  pauseReason: string | null;
}

export interface ResultsResponse {
  runs: ResultRun[];
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

/** A rung of the evidence ladder (ADR-0043); mirrors `TIERS` in `runner/src/models.ts`. */
export type TierView = "t0" | "t1" | "t2";

/** What a model does with an account once its tier is spent; mirrors `IDLE_MODES`. */
export type IdleModeView = "none" | "unlimited";

/** One tier's counts for one model, plus the runs behind them. */
export interface ModelEpisodeView {
  /** Stamped, un-overridden runs that produced at least one model response. */
  counted: number;
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
  /**
   * Free or paid (`runner/src/model-cost.ts`). Since ADR-0043 this says only
   * where a run may physically execute — the account class and the rate-limit
   * key. It buys no runs and costs none: that is the tier.
   */
  billing: "free" | "paid";
  /** The tier the config admitted this model to (ADR-0043). */
  declaredTier: TierView;
  /** The tier it is scheduled under: `declaredTier` advanced once if it earned rung 1. */
  tier: TierView;
  /**
   * A counted e90 in this series reached the promotion level. What the model
   * EARNED, kept apart from where it was ADMITTED: a `t0` model can hold this
   * without spending it, and a hand-promoted model never shows it falsely.
   */
  earnedRung1: boolean;
  /** What it does with an account once its tier is spent. */
  idle: IdleModeView;
  status: ModelStatusView;
  /** Tiers the model may be scheduled on, in policy order. */
  eligible: EpisodeIdView[];
  perEpisode: Partial<Record<EpisodeIdView, ModelEpisodeView>>;
  cooling?: { until: number; rung: number; reason: string };
  retired?: { at: number; reason: string };
  /** Consecutive no-progress attempts on the defer ladder. */
  ladder: number;
  /**
   * The scheduler's verdict on this model right now — `schedulability` in
   * `runner/src/models.ts`, the function `run-fleet --status` prints — over
   * the jobs the supervisor has in flight. `extras` means the only thing left
   * to run is an extra past the target.
   */
  schedulable: { ok: boolean; why: string; extras: boolean };
  /** This model's stamped runs, newest first. */
  runs: ModelRunView[];
  newestRunId: string | null;
  lastError: ModelLastErrorView | null;
}

export interface ModelsResponse {
  models: ModelRowView[];
  /** Where the roster came from. A fleet config without a `roster` map is `unreadable`. */
  roster: {
    path: string | null;
    shape: "roster" | "missing" | "unreadable";
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
    promoteAtLevel: number;
    /** The series the counts are keyed on (this checkout's); null when unversioned, which counts every run. */
    series: string | null;
    /** The paid throttle when the file turns it on; null is no split. Only a cap — never a budget. */
    paid: { maxConcurrent: number } | null;
    /** The ladder itself (ADR-0043), so a page can name a tier's budget without hardcoding it. */
    tiers: Record<TierView, { runsPerEpisode: { e90: number; e360: number }; promotesTo: TierView | null; label: string }>;
    /**
     * `policy.maxConcurrent`: streams the policy may have in flight per
     * key (`concurrencyKeyOf`), counting every run on that key. An absent
     * key is unlimited; an empty object is a file that names no cap.
     */
    maxConcurrent: Record<string, number>;
  };
  /** The defer ladder's rungs, so the page can say "rung 3 of 9" honestly. */
  ladderMs: number[];
  /** The `?harness=` filter honoured; "all" (the default) lists every roster row. */
  harness: HarnessView | "all";
  now: number;
}
