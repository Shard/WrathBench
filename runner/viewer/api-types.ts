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
 * The envelope a published public snapshot stamps onto every response body it
 * renders (`runner/viewer/snapshot.ts`). Optional on the response interfaces
 * that carry it, following this file's convention: the live API never sends
 * either field, and a consumer of either surface must render without them.
 */
export interface SnapshotEnvelope {
  /** When the snapshot was rendered (epoch ms). */
  generatedAt?: number;
  /** `PUBLIC_ATTRIBUTION` from `runner/viewer/public-projection.ts`. */
  attribution?: string;
}

/**
 * The comparability tuple a run was stamped with.
 *
 * Structurally identical to `Comparability` in `runner/src/comparability.ts`,
 * which is where it is defined and validated. It is mirrored rather than
 * imported because this module is import-free by construction —
 * the dashboard bundles it for a browser and must not pull `zod`, `bun:sqlite`
 * or the prompt text in behind it. `runner/test/comparability.test.ts` pins
 * the two shapes to each other.
 */
export interface EpisodeBudgetView {
  maxTurns: number | null;
  /** Null = no ceiling (the policy freeplay lane); never the argv sentinel 0. */
  maxToolCalls: number | null;
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
 * One probe campaign as `/api/campaigns` serves it.
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
export interface CampaignsResponse extends SnapshotEnvelope {
  campaigns: CampaignRowView[];
  /** Probe runs that recorded no campaign at all — a launch that should not exist. */
  orphans: number;
  /** Where the fleet config was read from, so a missing `config` can be explained. */
  configPath: string | null;
  now: number;
}

/** `/api/episodes`: the table, plus how many runs are tagged against each tier. */
export interface EpisodesResponse extends SnapshotEnvelope {
  episodes: (EpisodeTierView & {
    /**
     * Runs that are *members* of this tier's comparability group: stamped with
     * the id, never overridden, and a recorded episode rather than a spent
     * attempt. This is the count a chart may use.
     */
    members: number;
    /** Stamped with the id but given a leash the id does not describe. */
    overrides: number;
    /**
     * Stamped with the id but never a recorded episode: the run
     * lapsed and was ended, an operator cut it, or the harness failed. An
     * attempt spent on this tier, counted apart from its members.
     */
    lapsed: number;
    /**
     * Labeled with the id by the reader rather than stamped at launch — an
     * older run that looks like this tier. Countable, never a member: past
     * runs are not back-labeled.
     */
    derived: number;
  })[];
  /** Runs that belong to no tier at all — neither stamped nor derivable. */
  untiered: number;
  now: number;
}

/**
 * The harness a run ran under: `wrathbench` is the fixed loop,
 * `claude-code` the Claude Code CLI scaffold, `codex` the OpenAI Codex CLI
 * scaffold. Literal union rather than an import, because this module is
 * import-free by construction.
 */
export type HarnessView = "wrathbench" | "claude-code" | "codex";

export interface ComparabilityView {
  /** `git describe` of this repo's build — the same for every harness. */
  harnessVersion: string;
  promptHash: string;
  promptChars: number;
  /** Which loop owned the run. */
  harness: HarnessView;
  effort: string | null;
  budget: EpisodeBudgetView;
  /** True when an operator objective steered the run, which makes it unscored. */
  objective: boolean;
  /**
   * Whether `search_reference` served wiki coordinates. Absent on
   * runs stamped before the field existed.
   */
  wikiCoords?: boolean;
  /**
   * Which reference bundle the run read, off the bundle's own `meta` table
   * An annotation: a text-changing rebuild is paired with a harness
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
  /**
   * The model id the provider actually served (2026-08-25).
   * An annotation like `wikiBundle`, and the one field here that is observed
   * mid-episode rather than stamped at launch, so it is excluded from tuple
   * equality. Absent on runs stamped before the field existed.
   */
  resolvedModel?: string | null;
}

/** One run, as the listing and the detail endpoint report it. */
export interface RunRow {
  runId: string;
  model: string | null;
  driver: string | null;
  /** The harness tag: from the tuple, else the driver. Null when neither was recorded. */
  harness: HarnessView | null;
  /** The unscored stamp (the key keeps the old column name). Null when the run can score. */
  shakeout: string | null;
  /** The operator objective this run was steered with, or null. */
  objective: string | null;
  /**
   * The probe campaign that commissioned this run and which of its cells it is
   * or null on anything else. Read off the run's own config, which
   * is what lets a campaign's results outlive the deletion of its config entry:
   * this page is built from the run directory, not from the roster.
   */
  campaign: string | null;
  cell: string | null;
  /** An extra run: past the policy target, scored like any other, never counted by the fleet. */
  extra: boolean;
  character: string | null;
  /**
   * The starting character the run was launched with (the extras cycle
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
  /**
   * The model id the provider actually served, where `model` is the string the
   * run was launched with. The Claude Code CLI resolves a roster alias
   * (`sonnet`) to a real id (`claude-sonnet-5`) at launch and names it only in
   * its own `init` event; an OpenAI-compatible provider names the served id on
   * each response. Stamped on the run since 2026-08-25 and back-filled by the
   * reader from the trajectory for everything older. Null is "not recorded" —
   * never the config string, which is the question this field exists to answer.
   */
  resolvedModel: string | null;
  /** The Claude Code CLI's own version, from the same record. Null on any other driver. */
  cliVersion: string | null;
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
  /**
   * The freeplay run this one continues (`continued_from` in run.sqlite, and
   * `config.continuedFrom` in meta.json). A durable freeplay stream is one
   * character across attempts, and this is the only link between them; null is
   * "a fresh launch", which is also what a run written before the column
   * existed and a run whose continuation was dropped both read as.
   */
  continuedFrom: string | null;
  level: number | null;
  xp: number | null;
  /** Copper on hand, and quests turned in. Null when this run's schema predates them. */
  money: number | null;
  questsCompleted: number | null;
  /**
   * What the character wears and carries, from the newest state sample that
   * recorded it (item 50). Null on runs that predate the `items` column.
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
  /**
   * The player frame's numbers, from the newest state sample that carried a
   * position (item 104). Optional for the reason `move` is: a run
   * recorded before the columns existed, and a snapshot published before this
   * shipped, carry none, and every reader must draw those as unobserved rather
   * than as zero. A health/maxHealth pair is whole or absent — the SDK
   * withholds a gauge until both halves are seen.
   */
  health?: number | null;
  maxHealth?: number | null;
  power?: number | null;
  maxPower?: number | null;
  /** The raw `powerType` field the client picks a power bar with. */
  powerType?: number | null;
  /** The XP bar's denominator, as the client shows it. */
  nextLevelXp?: number | null;
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
  /**
   * `reported` only when a driver actually logged provider usage, `estimated`
   * when nobody counted, and `snapshot` for a claude-code run whose completion
   * figure rests on the API's opening usage snapshots because the turns that
   * produced it never emitted a `claude_result` — reported, and known to
   * under-read badly. See `tokenTotals` in `tail.ts`.
   */
  source: "reported" | "estimated" | "snapshot";
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
 * How fast a run's model is producing: output tokens divided by the wall time
 * the model spent on its replies — the wait it was answering plus the reply
 * itself — and never by the run's elapsed time, most of which the harness
 * spends driving the game.
 *
 * The unit is one REPLY rather than one turn, because a turn is not the same
 * thing under the two drivers: the fixed loop writes a `request` and a
 * `response` per turn, while the claude-code driver hands the CLI one request
 * and logs thousands of responses under it. See `tokensPerSecond` in
 * `runner/viewer/tail.ts` for how a span is opened and closed.
 *
 * Two figures because a live run's speed now is a different question from the
 * average it has managed so far: `recent` is the last `TPS_RECENT_REPLIES`
 * measured replies, summed the same way (Σ tokens ÷ Σ seconds over the window,
 * never a mean of per-reply rates, which one short reply would dominate).
 *
 * Null on either figure when nothing in it is measurable — a run whose first
 * request is still in flight has no rate, and zero would claim it had stalled.
 */
export interface TpsFacts {
  /** Output tokens per second over every measured reply; null when there are none. */
  overall: number | null;
  /** The same over the last `TPS_RECENT_REPLIES` replies. */
  recent: number | null;
  /** Measured replies behind `overall`. Not `TokenTotals.turns`: see above. */
  replies: number;
  /** Measured replies behind `recent` (at most `TPS_RECENT_REPLIES`). */
  recentReplies: number;
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
  /**
   * The claude driver's monotonic tool-call index, stamped on its `tool_call`,
   * `snippet` and result records (`runner/src/adapter-claude.ts`); absent on
   * the fixed loop's records, which key on `turn` instead.
   */
  call?: number;
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

/** A `tool_call` record: the generic summariser keeps its name and args. */
export interface ToolCallEntry extends EntryBase {
  t: "tool_call";
  name?: string;
  args?: unknown;
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
  | ToolCallEntry
  | SnippetResultEntry
  | EventsServedEntry
  | OtherEntry;

/**
 * Where a character was trying to get to: one recorded movement intention.
 *
 * The destination the runner watched a `move_to` dispatch for, and the
 * module's verdict once it arrived. `status` is null while the move is in
 * flight, `"arrived"` when it worked, and the module's own failure word
 * (`too_far`, `drop`, `lost`, `target_off_mesh`, …) when it did not.
 */
export interface MoveIntentView {
  /** When this was recorded: the dispatch, or the verdict that ended it. */
  ts: number;
  /** The map the move was dispatched on. A destination on another map is not this one's. */
  map: number | null;
  x: number;
  y: number;
  z: number;
  /** The unit the move was aimed at, when it was aimed at one. */
  target: string | null;
  /** The module's verdict; null while the move was still walking. */
  status: string | null;
}

/** One agent, at one moment (the map's position feed). */
/**
 * The newest entry in a run's episodic log (`runner/src/episodic.ts`): what the
 * model last said it was doing, and the stamps the harness put on it.
 *
 * The stamps are `null` rather than absent when the sample that wrote the entry
 * could not observe them, the way every other unobserved reading on this feed
 * is null — `level` and `zone` are optional on the writer's own shape.
 */
export interface CharacterStatus {
  /** The driver turn the entry was written on. */
  turn: number;
  level: number | null;
  /** The zone name the client would have shown; null when unobserved. */
  zone: string | null;
  /** The model's own text, capped by the writer. */
  text: string;
  ts: number;
}

export interface AgentPosition {
  runId: string;
  character: string | null;
  model: string | null;
  /**
   * The effort the run was launched at, off its comparability stamp — what
   * tells two pips of the same model apart where a character has no name yet.
   * Optional for the reason `move` is: a feed or a published snapshot from
   * before this field carries none, and a reader must draw those as "no effort
   * recorded" rather than inventing one.
   */
  effort?: string | null;
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
  /**
   * The newest recorded movement intention, when the run has one. Optional
   * because a published snapshot rendered before this existed carries none,
   * and the map must read those the same way it reads a run that never moved.
   */
  move?: MoveIntentView | null;
  /**
   * The player frame's numbers, from the newest state sample that carried a
   * position (item 104). Optional for the reason `move` is: a run
   * recorded before the columns existed, and a snapshot published before this
   * shipped, carry none, and every reader must draw those as unobserved rather
   * than as zero. A health/maxHealth pair is whole or absent — the SDK
   * withholds a gauge until both halves are seen.
   */
  health?: number | null;
  maxHealth?: number | null;
  power?: number | null;
  maxPower?: number | null;
  /** The raw `powerType` field the client picks a power bar with. */
  powerType?: number | null;
  /** The XP bar's denominator, as the client shows it. */
  nextLevelXp?: number | null;
  /**
   * The character's class, off the run row (it is launch config, not a state
   * sample). Lets a pip from a run recorded before `powerType` still tint its
   * power bar the way that class's bar is tinted.
   */
  class?: number | null;
  /**
   * The newest episodic entry, or null when the run has logged none. Optional
   * for the reason `move` is: a snapshot published before this shipped carries
   * none, and a reader must draw that as "nothing logged" rather than crash.
   */
  status?: CharacterStatus | null;
  /**
   * Whether a reflection window is open on this run right now
   * (`runner/src/reflect.ts`). Optional and false-by-default for the same
   * reason: an older feed says nothing, and nothing is not "reflecting".
   */
  reflecting?: boolean;
}

/** A run row as the listing serves it: the row plus whole-file totals. */
export interface RunListRow extends RunRow {
  tokens: TokenTotals | null;
  /**
   * Output tokens per second, whole-run and recent; see `TpsFacts`. Null when
   * the trajectory could not be read or no turn has completed. Optional for the
   * reason `ResultRun.xpEarned` is: a dashboard built against a viewer that
   * predates the field must still render.
   */
  tps?: TpsFacts | null;
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
   * Where a public snapshot placed this run's detail and track bodies (bucket
   * keys, no leading slash) — stamped by `runner/viewer/snapshot.ts` and
   * present only in published snapshots, never on the live API. Optional for
   * the reason `tps` is: consumers of either surface must render without it.
   */
  snapshot?: {
    detail: string;
    track: string;
    /**
     * The projected, prose-redacted tail window of the feed (`EntriesResponse`
     * shape) and the run's scratchpad (`ScratchpadResponse`). Optional because
     * a snapshot rendered before 2026-08-30 carries neither.
     */
    entries?: string;
    scratchpad?: string;
  };
}

/** The scratchpad route as a snapshot artifact: the file's text, whole. */
export interface ScratchpadResponse {
  text: string;
}

/**
 * Every run on disk. There is no zero-response filter: a run that terminates
 * without a single model response is archived by the runner as it exits, so it
 * never reaches a listing at all.
 */
export interface RunsResponse extends SnapshotEnvelope {
  runs: RunListRow[];
}

export interface PositionsResponse extends SnapshotEnvelope {
  positions: AgentPosition[];
}

/**
 * One attempt of a freeplay stream, with its own figures.
 *
 * A durable stream is one character across attempts (docs/OPERATIONS.md,
 * "Freeplay streams are durable"), and every figure the runner records is per
 * *attempt*: the quest counter, the tokens, the cost, the playtime all start
 * again at each continuation. That is not changed here — the record is the
 * record — so the strip on the run page shows each attempt as it was recorded
 * and `StreamTotals` says what the character has done altogether.
 *
 * Null is "this attempt recorded none of that kind", never zero, exactly as on
 * `ResultRun`, which is where every field below is read from.
 */
export interface StreamAttempt {
  runId: string;
  startedAt: number | null;
  endedAt: number | null;
  terminationReason: string | null;
  pauseReason: string | null;
  live: boolean;
  /** The highest level observed on this attempt (`ResultRun.maxLevel`). */
  level: number | null;
  xpEarned: number | null;
  questsCompleted: number | null;
  playtimeMs: number | null;
  tokens: TokenTotals | null;
  /** As on `ResultRun`: what the provider charged, and this repo's price table. */
  actualCost: CostFigure | null;
  expectedCost: CostFigure | null;
  /**
   * Deaths on this attempt. **Optional, and absent from the public
   * projection**: `RunDetailResponse.deaths` is withheld there whole (corpse
   * positions), so the stream withholds the count with it rather than opening
   * a second door onto the same fact. Absent is "this viewer does not answer",
   * which is not the claim `null` makes.
   */
  deaths?: number | null;
  flights: number | null;
  /**
   * The level marks with their per-mark active playtime, so the run page can
   * draw the stream's stitched level series without fetching every attempt.
   */
  levels: LevelMark[];
}

/**
 * What a stream cost, kept as two sums and never one.
 *
 * A `CostFigure` carries a `basis`, a `priceId` and an `asOf`, and a chain
 * whose attempts were one reported, one priced from the table and one neither
 * has no honest single basis — so the attempts' figures are summed as numbers
 * and the coverage is stated beside them rather than a synthesised figure
 * claiming a basis it does not have. Actual and expected are never added
 * together: they are two answers to two questions (`CostView`).
 */
export interface StreamCost {
  /** Sum over the attempts that reported an actual charge; null when none did. */
  actualUsd: number | null;
  /** How many attempts that sum covers, out of `attempts`. */
  actualAttempts: number;
  expectedUsd: number | null;
  expectedAttempts: number;
  /** Attempts in the stream — the denominator both coverages are read against. */
  attempts: number;
  /**
   * Any attempt whose actual figure is a subscription driver's own
   * `total_cost_usd` (`CostFigure.asIfMetered`): money that was never billed.
   * Carried so a stream on a subscription does not read as a bill.
   */
  asIfMetered: boolean;
}

/**
 * A stream's figures, summed or unioned across its attempts.
 *
 * The rule everywhere: a sum over attempts where NONE recorded a kind is null;
 * where some did, those are summed and the rest contribute nothing — the same
 * null-vs-zero discipline the per-run facts keep, so a stream with one attempt
 * from before a producer shipped is not reported as having done less.
 *
 * What is summed and what is taken from the furthest attempt is the difference
 * between a tally and a state. Quests, xp, playtime, tokens, deaths and flights
 * are things that happened and add up. Level, money and achievements are what
 * the CHARACTER holds now — achievements included, since the tap reports the
 * whole backlog — so the latest attempt that recorded one answers.
 */
export interface StreamTotals {
  attempts: number;
  /** The first attempt's start, and the last attempt's end — null while it is live. */
  startedAt: number | null;
  endedAt: number | null;
  playtimeMs: number | null;
  questsCompleted: number | null;
  xpEarned: number | null;
  tokens: TokenTotals | null;
  cost: StreamCost;
  /** The character's current standing, from the furthest attempt that recorded it. */
  level: number | null;
  money: number | null;
  achievements: AchievementFacts | null;
  /** Tallies: counts summed, marks concatenated in attempt order. */
  /** Withheld in public mode, as `RunDetailResponse.deaths` is; see `StreamAttempt.deaths`. */
  deaths?: DeathFacts | null;
  taxi: TaxiFacts | null;
  spells: SpellFacts | null;
  talents: TalentFacts | null;
  trades: TradeFacts | null;
  toolCalls: number | null;
  snippets: number | null;
  modelResponses: number | null;
}

/**
 * The freeplay stream a run is one attempt of — the whole run, where the run
 * row is one session of it.
 *
 * Served only for a run whose chain holds more than one attempt (`hasLineage`),
 * because "attempt 1 of 1" is noise standing where a fact should be. The
 * aggregation happens HERE, at read time, and nothing is written back: the
 * runner records per attempt and that surface is the model's, not the
 * reader's (docs/METHODOLOGY.md — an old run is read differently, not
 * relabelled).
 */
export interface StreamView {
  /** The chain root's run id: the stream's identity across attempts. */
  streamId: string;
  /** This run's 1-based place in `runs`. */
  attempt: number;
  attempts: number;
  previous: string | null;
  next: string | null;
  /**
   * The root still names a predecessor this viewer did not serve (archived, or
   * gone), so the stream begins mid-history and every total below is a lower
   * bound over the attempts on screen.
   */
  truncated: boolean;
  /** Every attempt, oldest first, each with its own figures. */
  runs: StreamAttempt[];
  totals: StreamTotals;
}

export interface RunDetailResponse extends SnapshotEnvelope {
  run: RunRow;
  states: StatePoint[];
  total: number;
  tokens: TokenTotals;
  /** What the run cost, or why not. Accumulates with the trajectory on a live run. */
  cost: CostView;
  /** Cumulative active time; see `RunListRow.playtimeMs`. */
  playtimeMs: number | null;
  /**
   * Achievements and flights from this run's milestone records,
   * accumulated by the same incremental tail the entry feed rides, so a live
   * run's line grows with it. Null on a run that recorded none — never zero.
   * Optional for the reason `ResultRun.areas` is: an older viewer has neither.
   */
  achievements?: AchievementFacts | null;
  taxi?: TaxiFacts | null;
  /**
   * The level timeline and the deaths this run's milestones account for; null
   * is "not recorded", never zero. Optional for the reason `achievements` is.
   */
  leveling?: LevelUpFacts | null;
  deaths?: DeathFacts | null;
  /**
   * Spells learned, talent points spent and trades completed this run; null is
   * "not recorded", never zero. Optional for the reason `achievements` is.
   */
  spells?: SpellFacts | null;
  talents?: TalentFacts | null;
  trades?: TradeFacts | null;
  /**
   * Output tokens per second (`TpsFacts`), off the same incremental tail as the
   * tokens above, so a live run's rate advances with its trajectory. Null when
   * no turn has completed; optional for the reason `achievements` is.
   */
  tps?: TpsFacts | null;
  /**
   * The turns this run spent reflecting, as half-open `[fromTurn, toTurn)`
   * ranges off its `reflect_window` records — `toTurn` null when the window ran
   * to the end of the run. Empty when none was recorded; optional for the
   * reason `achievements` is, so a dashboard built against an older viewer
   * simply accents nothing.
   */
  reflections?: ReflectionWindowView[];
  /**
   * The freeplay stream this run is one attempt of, aggregated across the whole
   * chain. Present only when the run has lineage worth printing; optional for
   * the reason `achievements` is — an older viewer does not answer it, and the
   * page falls back to the run's own figures.
   */
  stream?: StreamView;
}

/**
 * One stretch of turns spent reflecting rather than acting. Turn indices only:
 * it is a fact about this harness's own loop, with nothing of the world in it.
 * The derivation and the half-open convention are `tail.ts`
 * (`reflectionWindowsFrom`), which is where the "why" lives.
 */
export interface ReflectionWindowView {
  fromTurn: number;
  toTurn: number | null;
}

export interface EntriesResponse {
  from: number;
  total: number;
  entries: FeedEntry[];
}

/**
 * One job with a process, as the supervisor publishes it (the job is the one
 * unit of work; an account, with a class, is where it runs). A job
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
  /** The class of the account it landed on: pool, paid, local, or pinned. */
  accountClass: "pinned" | "pool" | "paid" | "local";
  source: string;
  /** The n-th attempt on (model, episode); absent on a job from the file. */
  attempt?: number;
  /** The paused run this spawn is resuming, when it is resuming one. */
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
 * it, with its class. `job` is null when nothing is on it — which is what
 * the fleet table's idle rows are made of.
 */
export interface FleetAccountView {
  account: string;
  /** `pinned` (a job names it), or the class that may schedule it. */
  class: "pinned" | "pool" | "paid" | "local";
  job: string | null;
}

/**
 * A paused run the supervisor is holding rather than resuming, as
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

/** The preflight gate's last result, as the supervisor recorded it. */
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
export interface FleetResponse extends SnapshotEnvelope {
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
export interface ApiInfoResponse extends SnapshotEnvelope {
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
  /**
   * Every harness series (`major.minor` of a version stamp) that recorded
   * runs, newest first, with how many runs each holds.
   *
   * The shell's series selector is a global filter, so it needs the list of
   * series before any page has loaded its own rows. It rides on `/api/info`
   * for the reason the build stamp does: the shell already polls this route,
   * and a poller per shell control is exactly the budget the dashboard is
   * built not to spend. Runs whose stamp names no series are not listed —
   * they belong to no group, and only the "all" selection shows them.
   *
   * Optional: a dashboard built against a viewer that predates this field must
   * still work, so it is absent rather than empty on an older process.
   */
  harnessSeries?: { series: string; runs: number }[];
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

/**
 * What a run's zone/area milestones say about where it went.
 *
 * A **lower bound in every field**: the producer reads the state cache on
 * `stateIntervalMs` (60s) alongside `recordState`, not on the movement itself,
 * so an excursion that began and ended between two samples leaves no record at
 * all. Same convention as `results.ts`: first observation, not first reach.
 *
 * Null fields are "never recorded", never zero or false — a run from before the
 * producer existed has no `AreaFacts` at all, and `leftStartArea: null` is a run
 * whose zone was seen and whose area never was.
 */
export interface AreaFacts {
  /** The first area observed. Null when no `area` milestone was written. */
  startArea: number | null;
  /** Distinct area ids over the whole run, `startArea` included. */
  distinctAreas: number;
  /**
   * Whether the run has at least two *consecutive* observed areas both
   * outside `startArea`'s tutorial region (see `tutorialRegionOf` in
   * `runner/viewer/tail.ts`) — a sustained exit, not "any area seen that
   * differs": a lone milestone outside the region does not count, nor does
   * wandering between a newbie zone's own subzones. The pair may occur
   * anywhere in the run; a later return home does not erase it. Null when no
   * area was observed.
   */
  leftStartArea: boolean | null;
  /** The first capital zone entered, or null when none was. */
  capitalZone: number | null;
  /** How many records of each kind fed the above. */
  zoneMarks: number;
  areaMarks: number;
}

/**
 * What a run's achievement milestones say it holds (issue #8).
 *
 * `earned` is the union of the login backlog and the run's own earns, so on a
 * resumed run it is what the character holds, not what it earned this episode.
 * `points` is the last backlog record's total plus the points of every earn
 * outside that backlog — a **lower bound**, because the module serves points
 * only where it could read `Achievement.dbc`.
 *
 * Null (no `AchievementFacts` at all) is "no achievement record in this run":
 * every run before the taps were deployed, and any run whose login packet the
 * cache missed. It is never zero.
 */
export interface AchievementFacts {
  earned: number;
  points: number;
  /** The ids behind `earned`, ascending. */
  ids: number[];
}

/**
 * Flights taken, from the `taxi` milestone records.
 *
 * `flights` counts takeoffs — a `taxi` record, i.e. an accepted reply followed
 * by the taxi flag turning on — not landings, and it is a lower bound: the
 * producer samples on `stateIntervalMs`, so a hop that began and ended between
 * two samples leaves nothing behind, the same convention as `AreaFacts`.
 *
 * Null is "flights were not recorded for this run", which is not the same fact
 * as `{ flights: 0 }`. The two are told apart by the achievement records: a run
 * on a worldserver with the taps writes an `achievements_at_login` milestone
 * even when the backlog is empty, so achievement records **or** taxi records
 * prove the taps were live and zero becomes representable.
 */
export interface TaxiFacts {
  flights: number;
}

/**
 * A run's level timeline, from its `level` milestone records (FOLLOW-UPS 35).
 *
 * The producer writes one mark per change of `self.level`, `from` absent on the
 * first observation of a process — so the first mark of a run is the level it
 * started at, and a **level-up is a mark that carries a `from` and climbs**.
 * `levelUps` already applies that rule; a consumer must never count `marks`.
 *
 * Distinct from the level readings the state samples carry, which say what the
 * level was at each sample: a mark says *when it changed*, with the turn in
 * flight and the XP the bar showed at that moment. It is a lower bound in the
 * usual sense — sampled on `stateIntervalMs`, so two levels gained inside one
 * interval leave one mark — and null (no `LevelUpFacts` at all) is "not
 * recorded": every run before 2026-08-29.
 */
export interface LevelUpFacts {
  /** Marks that carry a `from` and climb. Never `marks.length`. */
  levelUps: number;
  /** The first level observed, and the highest any mark named. */
  startLevel: number;
  maxLevel: number;
  /** The ends of `marks`, carried so a listing row need not walk the array. */
  first: LevelUpMark;
  last: LevelUpMark;
  /** The timeline itself, in observation order. Tens of entries at most. */
  marks: LevelUpMark[];
}

/**
 * One `level` milestone projected: the level, the level it came from, and when.
 * Distinct from `LevelMark`, which is a level reading derived from the state
 * samples and carries the cost of reaching it.
 */
export interface LevelUpMark {
  to: number;
  /** Null on the first observation of a process — a baseline, not a gain. */
  from: number | null;
  /** XP toward the next level as the bar showed it at that moment. */
  xp: number | null;
  ts: number;
  turn: number | null;
}

/**
 * A run's deaths, from the `death` / `release` / `resurrect` milestones.
 *
 * `deaths` counts the **dead windows** the producer observed opening, not the
 * health transitions: the state cache latches the corpse and the reclaim delay
 * from the death until the resurrect, so a sample landing anywhere inside the
 * window sees it and stamps the death with the cache's own timestamp. A death
 * whose whole window fell between two samples leaves nothing, and two deaths
 * with no observed resurrect between them read as one — a lower bound, the
 * convention `AreaFacts` and `TaxiFacts` already carry.
 *
 * Null is "deaths were not recorded for this run" and is not `{ deaths: 0 }`.
 * The two are told apart by the level marks: every run under this producer
 * writes one on its first sample, so a run with a level timeline and no death
 * genuinely never died. This is the job `achievements_at_login` does for
 * flights; the achievement records cannot do it here, since runs that predate
 * the death producer have them.
 */
export interface DeathFacts {
  deaths: number;
  /** Ghost-flag transitions: released to a graveyard, and resurrected. */
  releases: number;
  resurrects: number;
  /** The ends of `sites`, carried so a listing row need not walk the array. */
  first: DeathSite | null;
  last: DeathSite | null;
  /** Every death observed, in order — the death sites map replay wants (item 22). */
  sites: DeathSite[];
}

/** Where and when one death happened. */
export interface DeathSite {
  /** The death's own timestamp where the cache carried one, else the record's. */
  ts: number;
  turn: number | null;
  /**
   * The corpse, and which packet said where it is: `death_spot` is the position
   * at the moment health reached 0, `corpse_query` the server's own answer.
   * Null when neither had been observed by the sample that saw the death.
   */
  position: { map: number; x: number; y: number; z: number; source: "corpse_query" | "death_spot" } | null;
  /**
   * The zone/area reading at first observation. It is the death site only when
   * `released` is false — once the spirit is at the graveyard these are the
   * graveyard's ids, and `released` is what says which one a reader is holding.
   */
  zone: number | null;
  area: number | null;
  released: boolean | null;
}

/**
 * What a run learned, spent and traded, from the `spells_at_login` / `spell` /
 * `talent` / `trade` milestones (item 35, 2026-09-01).
 *
 * `spells_at_login` is the liveness witness all three share: it is written once
 * per process by the same producer, so a run that has it and no learns really
 * learned nothing, while a run from before the producer has none of the four
 * records and reads null — "not recorded" — throughout.
 */
export interface SpellFacts {
  /** Ids that entered the book after the login baseline. */
  learned: number;
  /** How many the book already carried when the run first read it. */
  atLogin: number;
  /** The learned ids, ascending. Ids only: names are the client's DBC text. */
  ids: number[];
  /** Each learn in observation order, so a page can show when. */
  marks: SpellLearnMark[];
}

export interface SpellLearnMark {
  id: number;
  ts: number;
  turn: number | null;
}

/** Talent points this run spent. Nothing about the ranks it started holding. */
export interface TalentFacts {
  /** Records written: one per rank the run watched climb. */
  spends: number;
  /** Distinct talents any of those spends touched. */
  talents: number;
  marks: TalentSpendMark[];
}

export interface TalentSpendMark {
  id: number;
  /** Points now in that talent (the wire rank plus one). */
  points: number;
  ts: number;
  turn: number | null;
}

/**
 * Completed trades. What was traded is not recorded — the SDK clears both
 * sides of the window when the trade stops being open — so this is the count
 * and the moments, which is what "first trade" needs.
 */
export interface TradeFacts {
  trades: number;
  first: TradeMarkView | null;
  last: TradeMarkView | null;
  marks: TradeMarkView[];
}

export interface TradeMarkView {
  ts: number;
  turn: number | null;
}

/** One run as the results charts read it: identity, comparability, level marks. */
export interface ResultRun {
  runId: string;
  model: string | null;
  /**
   * The id the provider actually served, where `model` is what the run asked
   * for; see `RunRow.resolvedModel`. Optional for the reason `xpEarned` is: a
   * dashboard built against a viewer that predates the field must still render.
   */
  resolvedModel?: string | null;
  cliVersion?: string | null;
  platform: string | null;
  harnessVersion: string | null;
  /**
   * `major.minor` of the harness version: the comparability group
   * the charts key on, with the exact versions listed on the row. Null when
   * the stamp has none.
   */
  harnessSeries: string | null;
  /** An extra run past the policy target; scored like any other, reported apart by the fleet. */
  extra: boolean;
  /**
   * The run's starting character (the extras cycle). Ids as recorded,
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
   * The probe campaign that commissioned this run and its cell, or
   * null. A grouping key for the campaigns page and nothing else: a probe is
   * unscored, so these never reach a chart.
   */
  campaign: string | null;
  cell: string | null;
  effort: string | null;
  /** The harness tag. A tag on the row, not a partition. */
  harness: HarnessView | null;
  promptHash: string | null;
  /** The worldserver build this run was stamped against, or null. */
  serverBuild: string | null;
  /** Whether wiki coordinates were served; null when not recorded. */
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
  /** Why this run cannot be scored, or null when it can. */
  unscored: string | null;
  startedAt: number | null;
  /**
   * The listing's own reading of whether the file is still being written, and
   * when the run ended (the runs page's status column). Optional: a dashboard built
   * against a viewer that predates them must still work, and reads the
   * recorded reasons instead.
   */
  endedAt?: number | null;
  live?: boolean;
  terminationReason: string | null;
  levels: LevelMark[];
  maxLevel: number | null;
  /**
   * XP *within* `maxLevel`: the highest reading any sample carried at that
   * level. Together with `maxLevel` it is the ladder's total-XP ordering
   * — the pair is lexicographic because xp resets at each
   * level and level never goes down. Null when no sample recorded xp there.
   */
  xp: number | null;
  /**
   * XP earned over the whole run, as a **lower bound**: the last observed
   * within-level xp of every level below `maxLevel`, plus the xp within it —
   * the same reconstruction the run page's cumulative chart draws
   * (`dashboard/src/lib/runview.ts`), computed here so the ladder's scatter
   * and that chart cannot disagree. Under-counts by whatever was earned
   * between a level's last sample and the ding, never over-counts. Null when
   * no sample carried both a level and an xp reading. Optional: a dashboard
   * built against a viewer that predates the field must still work.
   */
  xpEarned?: number | null;
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
   * The listing columns. The runs page is the per-run grain, so the facts
   * the fleet's run table used to carry ride on this row rather than being
   * joined against `/api/runs` in a page.
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
  /**
   * `CostView.expected` — the price table applied to the run's own tokens,
   * `$0` with `asIfMetered` for a free tier or local hardware. The runs table
   * never shows it (a listing of what runs cost may not show a guess); the
   * ladder's scatter reads it only where no provider figure exists, and says
   * so. Optional for the reason `xpEarned` is.
   */
  expectedCost?: CostFigure | null;
  /**
   * Whether this run cost the operator money (`runner/src/billing.ts`). Derived
   * from the model id, the api base, and the harness — a subscription counts as
   * paid here, which is deliberately the opposite of the scheduler's verdict in
   * `runner/src/model-cost.ts`; that one answers "does this consume the paid
   * concurrency budget". The ladder's "exclude free" toggle reads this.
   * Optional for the reason `xpEarned` is: a dashboard built against a viewer
   * that predates the field must still work, and reads `undefined` as unknown
   * rather than as free.
   */
  billing?: "free" | "paid";
  /**
   * Where the run went, from its zone/area milestone records (FOLLOW-UPS 35):
   * the ladder's rungs 2 and 4 read this. `null` is a run that wrote no such
   * record — everything before the producer shipped on 2026-08-23 — and must
   * not be read as "never left"; `undefined` is a viewer that predates the
   * field, the same convention `xpEarned` and `expectedCost` use.
   */
  areas?: AreaFacts | null;
  /**
   * The level timeline and the deaths, from the same pass over the milestone
   * records. Optional for the reason `areas` is: an older viewer has neither.
   */
  leveling?: LevelUpFacts | null;
  deaths?: DeathFacts | null;
  /**
   * Achievements the run's records account for. `null` is a run that
   * wrote none — everything before the achievement taps were deployed — and
   * must not be read as zero; `undefined` is a viewer that predates the field.
   * A displayed signal only: nothing in the ladder's ordering reads it
   * (highest rung, then XP, then gold).
   */
  achievements?: AchievementFacts | null;
  /**
   * Flights taken, from the same records; `null` when flights were not recorded
   * for this run. Rung 4's second half. See `TaxiFacts` for why null and zero
   * are different facts.
   */
  taxi?: TaxiFacts | null;
  /**
   * Spells learned, talent points spent and trades completed (item 35). Null is
   * "not recorded" for the reason `deaths` is — the witness is
   * `spells_at_login`, see `SpellFacts` — and `undefined` an older viewer.
   */
  spells?: SpellFacts | null;
  talents?: TalentFacts | null;
  trades?: TradeFacts | null;
  /** Why a run is suspended, when it ended for no other reason. */
  pauseReason: string | null;
  /**
   * The run this one continues; see `RunRow.continuedFrom`. What the freeplay
   * ladder collapses a stream's attempts by.
   */
  continuedFrom: string | null;
  /**
   * A launch that produced nothing — `stillbornOf` in `runner/src/models.ts`,
   * the same notion the scheduler's defer ladder counts. `null` is undecided:
   * the run is live or paused, or its response count could not be read. Kept
   * apart from `unscored`, which for a steered run answers "the episode" and
   * so never gets far enough to say anything about the run itself.
   */
  stillborn: boolean | null;
}

export interface ResultsResponse extends SnapshotEnvelope {
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

/** A run's whole recorded track, for map replay (item 22). */
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
  /**
   * The player frame's numbers, from the newest state sample that carried a
   * position (item 104). Optional for the reason `move` is: a run
   * recorded before the columns existed, and a snapshot published before this
   * shipped, carry none, and every reader must draw those as unobserved rather
   * than as zero. A health/maxHealth pair is whole or absent — the SDK
   * withholds a gauge until both halves are seen.
   */
  health?: number | null;
  maxHealth?: number | null;
  power?: number | null;
  maxPower?: number | null;
  /** The raw `powerType` field the client picks a power bar with. */
  powerType?: number | null;
  /** The XP bar's denominator, as the client shows it. */
  nextLevelXp?: number | null;
}

/**
 * Where a replayed run sits in its freeplay stream, and the attempts either
 * side of it (item 119).
 *
 * The four scalars off `StreamView` and nothing else. The map's play bar needs
 * somewhere to step to; it does not need the chain's totals, and carrying the
 * whole view here would make a replay's fetch the size of a run page's for two
 * run ids. Derived from the same `streamViewOf` call `/api/run/<id>` serves its
 * `stream` from, so the bar's steps and the run page's attempt strip cannot
 * name different neighbours on a fork.
 *
 * Absent — not null — on a run with no stream worth printing, and on a track
 * served or published before this shipped.
 */
export interface TrackStream {
  /** The chain root's run id: the stream's identity across attempts. */
  streamId: string;
  /** This run's 1-based place in the stream. */
  attempt: number;
  attempts: number;
  /** The attempt before this one, when the viewer serves it. */
  previous: string | null;
  /** The attempt that continues this one, when the viewer serves it. */
  next: string | null;
}

export interface TrackResponse extends SnapshotEnvelope {
  runId: string;
  character: string | null;
  model: string | null;
  harnessVersion: string | null;
  points: TrackPoint[];
  /**
   * The stream this run is an attempt of, when it is one: the play bar's
   * previous/next steps. Optional — an older viewer and an older snapshot
   * carry none, and the controls simply do not render.
   */
  stream?: TrackStream;
  /**
   * Every movement intention the run recorded, oldest first. Separate from
   * `points` because it has its own cadence: a move is dispatched when the
   * model decides to walk, not when the state ticker writes a row. Optional
   * for the same reason as `AgentPosition.move`.
   */
  moves?: MoveIntentView[];
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
 * model is not running.
 */
export type ModelStatusView = "new" | "active" | "cooling" | "promoted" | "retired";

/** A rung of the evidence ladder; mirrors `TIERS` in `runner/src/models.ts`. */
export type TierView = "t0" | "t1" | "t2";

/** What a model does with an account once its tier is spent; mirrors `IDLE_MODES`. */
export type IdleModeView = "none" | "unlimited";

/** One tier's counts for one model, plus the runs behind them. */
export interface ModelEpisodeView {
  /** Stamped, un-overridden, completed runs that are safe scoring evidence. */
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
  /** An extra run: an attempt past the target, never counted. */
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
  /**
   * The id the provider actually served for this run (`RunRow.resolvedModel`),
   * attached by the route from the same run rows the listing reads. Optional
   * for the reason `cost` is: the scheduler's projection does not carry it.
   */
  resolvedModel?: string | null;
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
  /** The roster name (the config's `roster` map key) — the row's identity. */
  name: string;
  model: string;
  effort: string | null;
  platform: string | null;
  /** The harness this roster entry's runs go through, from its driver. */
  harness: HarnessView;
  /**
   * Free or paid (`runner/src/model-cost.ts`). Since the tier became the only
   * budget this says only
   * where a run may physically execute — the account class and the rate-limit
   * key. It buys no runs and costs none: that is the tier.
   *
   * NOT the same verdict as `ResultRun.billing`, and the two disagree on
   * purpose: this one answers "does this consume the paid concurrency budget",
   * so a `claude-code` subscription reads `free` here; that one answers "did we
   * pay for this run", so the same entry's runs read `paid` there
   * (`runner/src/billing.ts`).
   */
  billing: "free" | "paid";
  /** The tier the config admitted this model to. */
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
  /**
   * Every distinct id this roster entry's runs actually resolved to, sorted.
   *
   * The row stays keyed on the roster's `model` string — that is the unit the
   * scheduler counts in — but an alias resolves at launch, so one row can hold
   * runs from two different Claudes. More than one entry here is that drift,
   * shown rather than averaged away. Empty when no run of this entry recorded
   * one; optional for the reason `ModelRunView.cost` is.
   */
  resolvedModels?: string[];
  /** This model's stamped runs, newest first. */
  runs: ModelRunView[];
  newestRunId: string | null;
  lastError: ModelLastErrorView | null;
}

export interface ModelsResponse extends SnapshotEnvelope {
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
     * an objective. Same predicate as `run-fleet --status` (item 52).
     */
    excluded: { name: string; reason: string }[];
  };
  policy: {
    promoteAtLevel: number;
    /** The series the counts are keyed on (this checkout's); null when unversioned, which counts every run. */
    series: string | null;
    /** The paid throttle when the file turns it on; null is no split. Only a cap — never a budget. */
    paid: { maxConcurrent: number } | null;
    /** The ladder itself, so a page can name a tier's budget without hardcoding it. */
    tiers: Record<TierView, { runsPerEpisode: { e90: number; e360: number }; promotesTo: TierView | null; label: string }>;
    /**
     * `policy.maxConcurrent`: streams the policy may have in flight per key,
     * counting every run on that key. An absent key is unlimited; an empty
     * object is a file that names no cap.
     *
     * Most keys are a roster entry's own (`concurrencyKeyOf`). The exception is
     * Claude: a run counts against BOTH `claude-code` — every session in flight,
     * whichever subscription pays — and `claude-code:<ENV NAME>`, that one
     * subscription's, and needs room in both. Which subscription a run bills is
     * decided when it is scheduled, so no key here is derivable from the entry
     * alone.
     */
    maxConcurrent: Record<string, number>;
  };
  /** The defer ladder's rungs, so the page can say "rung 3 of 9" honestly. */
  ladderMs: number[];
  /** The `?harness=` filter honoured; "all" (the default) lists every roster row. */
  harness: HarnessView | "all";
  now: number;
}

/** One model-facing tool as `/api/tools` presents it: the runner's own text, plus one example call. */
export interface ToolView {
  name: string;
  /** The description the model is given, verbatim from `runner/src/tools.ts` (names-first rendering). */
  description: string;
  /** The tool's parameters, in JSON Schema, as the model is given them. */
  inputSchema: Record<string, unknown>;
  /** One illustrative call, as the arguments would be sent; null for a tool that takes none. Harness text. */
  example: string | null;
  /** For an argument-less tool, one line on what the call gives back; null otherwise. */
  returns: string | null;
}

/** `/api/tools`: the model-facing tool list, in the order the model sees it. */
export interface ToolsResponse extends SnapshotEnvelope {
  tools: ToolView[];
}
