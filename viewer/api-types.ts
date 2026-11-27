/**
 * The wire shapes of the viewer's read-only `/api` surface.
 *
 * This module is the contract between the Bun viewer and the `dashboard/` SPA,
 * and it is imported by both. It therefore has **no runtime imports** and
 * declares types only: the dashboard bundles for a browser and cannot pull in
 * `bun:sqlite` transitively, and a type-only module keeps the two sides from
 * drifting without either owning the other. What it takes from elsewhere it
 * takes as types, from modules that are import-free themselves; the run row
 * and the run totals are declared in `runner/src/run-types.ts` and
 * re-exported here.
 *
 * This file holds the viewer group's own routes and the shapes every group
 * shares (the snapshot envelope, a cost figure, the run row). The other
 * groups' routes have files of their own beside it, along the route modules'
 * seams: `api-types-runner.ts` (`api-fleet.ts`), `api-types-evals.ts`
 * (`api-evals.ts`) and `api-types-admin.ts` (the config API and the admin
 * page). They import from here; this file imports none of them.
 */

import type { SiteTheme } from "../runner/src/site-settings";
export type { SiteTheme, ThemeToken } from "../runner/src/site-settings";
import type { RunCondition } from "./condition";
export type { ChartGroup, RunCondition } from "./condition";
import type { NearbyWindow, SessionPosition, SessionTrack, SessionTrackPoint } from "@wrathbench/inspector/wire";
// The run row and the run totals are the runner's (`runner/src/run-types.ts`),
// which the runner's core and the collector read without importing the viewer.
import type {
  AchievementFacts,
  ActiveSegment,
  AreaFacts,
  ComparabilityView,
  CostCoverage,
  DeathFacts,
  DeathSite,
  EntrySummary,
  EpisodeBudgetView,
  EpisodeIdView,
  HarnessView,
  LevelUpFacts,
  LevelUpMark,
  PartyStampView,
  ReportedUsage,
  RunRow,
  SpellFacts,
  SpellLearnMark,
  StatePoint,
  TalentFacts,
  TalentSpendMark,
  TaxiFacts,
  TokenTotals,
  TpsFacts,
  TradeFacts,
  TradeMarkView,
  UnreportedUsage,
} from "../runner/src/run-types";
export type {
  AchievementFacts,
  ActiveSegment,
  AreaFacts,
  ComparabilityView,
  CostCoverage,
  DeathFacts,
  DeathSite,
  EntrySummary,
  EpisodeBudgetView,
  EpisodeIdView,
  HarnessView,
  LevelUpFacts,
  LevelUpMark,
  PartyStampView,
  ReportedUsage,
  RunRow,
  SpellFacts,
  SpellLearnMark,
  StatePoint,
  TalentFacts,
  TalentSpendMark,
  TaxiFacts,
  TokenTotals,
  TpsFacts,
  TradeFacts,
  TradeMarkView,
  UnreportedUsage,
};

/**
 * The envelope a published public snapshot stamps onto every response body it
 * renders (`viewer/snapshot.ts`). Optional on the response interfaces
 * that carry it, following this file's convention: the live API never sends
 * either field, and a consumer of either surface must render without them.
 */
export interface SnapshotEnvelope {
  /** When the snapshot was rendered (epoch ms). */
  generatedAt?: number;
  /** `PUBLIC_ATTRIBUTION` from `viewer/public-projection.ts`. */
  attribution?: string;
}


/** The four priced components of a run's tokens, in dollars. */
export interface CostBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * One dollar figure with its provenance (`viewer/pricing.ts`).
 *
 * `basis` is the field to read first:
 * - `reported` — a figure the provider itself billed: OpenRouter's per-response
 *   `usage.cost` summed over the run, or the Claude Agent SDK's
 *   `total_cost_usd`. Used verbatim, except for the marked `backfill` below.
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
  /**
   * Per-component dollars, when the figure was computed. Null when reported.
   * Absent from every published snapshot: no public page reads it
   * (docs/PUBLIC-DASHBOARD.md, "What is published").
   */
  breakdown?: CostBreakdown | null;
  /** The price row the figure was computed at, and when that row was taken.
   * Both null unless `basis` is `list-price` — a reported figure has no table
   * behind it. The date is on the wire rather than baked into a display string
   * so a stale price cannot go on reading as a current one. */
  priceId: string | null;
  asOf: string | null;
  /** Always present: a blank cost states something and must say what. */
  note: string;
  /**
   * Present only on a claude-code `actual` with turns the CLI never reported a
   * cost for (a killed or paused turn ends before its `claude_result` lands).
   * `usd` above is then `reportedUsd` plus this `usd`: those turns' tokens at
   * the run's own list row — or nothing, `usd: null`, where the model has no
   * row and the figure reads low. Every surface that shows the figure marks it
   * with a `*` whose hover is `note`. Operator's decision, 2026-10-08.
   */
  backfill?: CostBackfill;
}

/** The two parts of a backfilled claude-code actual; see `CostFigure.backfill`. */
export interface CostBackfill {
  /** The CLI's own `total_cost_usd`, summed over sessions. */
  reportedUsd: number;
  /** The list-price estimate for the unreported turns, or null when no row could price them. */
  usd: number | null;
  /** How many turns the CLI never reported a cost for. */
  turns: number;
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
 * The top-level fields are `expected` again, kept for older consumers of the
 * live API. Read `actual`/`expected`. The published snapshot omits them (no
 * public page reads them), so they are optional here: a reader that wants one
 * must say what it does when the body comes from a bucket.
 */
export interface CostView extends Partial<CostFigure> {
  actual: CostFigure;
  expected: CostFigure;
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
  /** The tools the reply called, as recorded: a CLI driver's names keep the CLI's prefix (`mcp__wrathbench__run_snippet`). */
  tools?: string[];
  outChars?: number;
  usage?: ReportedUsage;
  /** `compaction` on a CLI's summarisation call (pi), which has no text and no tools. */
  kind?: string;
  /** pi: the characters of reasoning the reply carried. */
  thinkingChars?: number;
  /** pi: why the reply ended (`toolUse`, `stop`, `length`, `error`, `aborted`). */
  stopReason?: string;
  /** pi: what the reply cost, by pi's own price table. */
  piCostUsd?: number;
  /** pi: an errored reply's message. */
  error?: string;
  /**
   * claude-code: the thinking tokens the CLI estimated since the previous
   * reply, summed off the `thinking_tokens` markers the feed does not serve.
   * They led to the model's next output, which this reply's record precedes.
   */
  thinkingTokens?: number;
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
  /**
   * When the writer handed the call to the tool, stamped by every writer. The
   * MCP-backed ones append the call after it ran, so their `ts` is write time
   * and this is the only real start; a call's duration is its result's `ts`
   * minus this. Absent on trajectories written before the stamp.
   */
  dispatchTs?: number;
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
  /** The turn's message stood a line for an event window its thread already held (`EventsSeen`); `count` is then 0. */
  unchanged?: boolean;
}

/**
 * One dispatched action as the `actions` record carries it
 * (`ActionNote` in `wrath-mcp/mcp/src/sandbox/ipc.ts`, mirrored here because this
 * file is the type-only contract the dashboard imports). Everything but
 * `action`, `ts` and `status` is optional.
 */
export interface ActionNoteView {
  ts: number;
  action: string;
  args?: Record<string, unknown>;
  /** HTTP status; 0 when no answer came. */
  status: number;
  ms?: number;
  error?: string;
  hint?: string;
  moveId?: number;
  names?: { target?: string; spell?: string; item?: string; quest?: string };
  count?: number;
  lastTs?: number;
  auto?: boolean;
}

/**
 * An `actions` record: one snippet's dispatches since the last flush. `callTs`
 * equals the owning `tool_call`'s `dispatchTs` — the join, since the writers
 * append the two in different orders (`runner/src/trajectory.ts`,
 * `ActionsLine`). Absent on runs written before the action log, which simply
 * have no such records.
 */
export interface ActionsEntry extends EntryBase {
  t: "actions";
  callTs?: number;
  routine?: boolean;
  actions: ActionNoteView[];
  dropped?: Record<string, number>;
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
  | ActionsEntry
  | OtherEntry;

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

/**
 * A run's character on the map now: the session's position (`SessionPosition`,
 * the inspector's) and the run it belongs to.
 */
export interface AgentPosition extends SessionPosition {
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
  /** The CLI compaction window off the same stamp; absent is `auto`. */
  compactWindow?: string | null;
  /*
   * `questsCompleted` is summed across the counter's restarts
   * (`questsAcrossRestarts`), as on `ResultRun.questsCompleted`. No inventory:
   * the map's sidebar reads what the character wears and carries off the
   * trace's character sheet at the playhead (`trace`), and the newest reading
   * here ran the public delay ahead of the pip beside it. `class` is off the
   * run row (launch config, not a state sample), and `nearby` is set exactly
   * where `nearby.json` carries the run's window (`LiveNearby`), its ring
   * (`/api/run/<id>/nearby`) written within `NEARBY_FRESH_MS`.
   */
  harnessVersion: string | null;
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
   * keys, no leading slash) — stamped by `viewer/snapshot.ts` and
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
    /** The run's camera video (`ClipsResponse`), on a run that has one. */
    clips?: string;
  };
}

/** The scratchpad route as a snapshot artifact: the file's text, whole. */
export interface ScratchpadResponse {
  text: string;
}

/** What a chapter of a run's video marks (`viewer/camera.ts`). */
export type ChapterType = "level" | "quest" | "death" | "zone" | "boss";

/**
 * One part of a run's video as the pages read it. `video` and `poster` name
 * where the media is: a viewer route (`/api/run/<id>/clip/<name>.mp4`) on the
 * live API, a bucket key (`v1/run/<id>/clip/<name>-<hash>.mp4`) in a
 * snapshot; the client turns either into a URL.
 */
export interface VideoPartView {
  name: string;
  /** Run time of its first and last frame, ISO. */
  from: string;
  to: string;
  /** Its length as video. */
  seconds: number;
  video: string;
  poster: string | null;
}

/** A marker on the video: `t` in seconds on the whole timeline, across parts. */
export interface ChapterView {
  t: number;
  /** The index in `parts` it falls in. */
  part: number;
  type: ChapterType;
  /** Our own short text: ids and numbers, never game prose. */
  detail: string;
  /** The model's own words at that moment, or "". */
  caption: string;
}

/** The model's words from `t` (seconds, whole timeline) until the next cue. */
export interface CaptionCueView {
  t: number;
  text: string;
}

/**
 * `/api/run/<id>/clips`: a run's one video, its parts back to back, with its
 * chapters, the model's words, and the time map between the timeline and run
 * time (`[videoSeconds, runTimeMs]` keypoints; `viewer/video-time.ts`).
 * A run with none is `null` to a private handle and a 404 to a public one.
 */
export interface ClipsResponse {
  runId: string;
  parts: VideoPartView[];
  chapters: ChapterView[];
  captions: CaptionCueView[];
  timemap: [number, number][];
}

/**
 * `/api/run/<id>/camera/latest`: the run's newest camera frame, private only
 * (`viewer/camera-live.ts`), or `null` when it has none. The picture is
 * `/camera/latest.jpg`.
 */
export interface LatestFrameResponse {
  runId: string;
  seq: number;
  /** When the camera took it, ISO. */
  t: string;
}

/**
 * `/api/highlight`: the home page's excerpt of a recent run's video around its
 * newest chapter, or none. `from` and `to` are seconds into `part`'s file;
 * `chapter` is null for a video with no chapter, whose last seconds it shows.
 */
export interface HighlightResponse {
  highlight: { runId: string; model: string | null; part: VideoPartView; from: number; to: number; chapter: ChapterView | null } | null;
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
 * One attempt of a freeplay character, with its own figures.
 *
 * A durable character is one character across attempts (docs/RUNBOOK.md,
 * "Freeplay characters are durable"), and every figure the runner records is per
 * *attempt*: the quest counter, the tokens, the cost, the playtime all start
 * again at each continuation. That is not changed here — the record is the
 * record — so the strip on the run page shows each attempt as it was recorded
 * and `CharacterTotals` says what the character has done altogether.
 *
 * Null is "this attempt recorded none of that kind", never zero, exactly as on
 * `ResultRun`, which is where every field below is read from.
 */
export interface CharacterAttempt {
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
   * projection**, where no page reads it (the totals carry the character's).
   * Absent is "this viewer does not answer", which is not the claim `null`
   * makes.
   */
  deaths?: number | null;
  flights: number | null;
  /**
   * The level marks with their per-mark active playtime, so the run page can
   * draw the character's stitched level series without fetching every attempt.
   */
  levels: LevelMark[];
  /**
   * The freeplay milestones' other marks on this attempt's clock
   * (`ResultRun.milestoneAt`), so the character page can place every
   * milestone the character reached. Optional for the reason it is there.
   */
  milestoneAt?: MilestoneTimes;
  /**
   * The attempt's sessions (`ResultRun.sessions`), so the character page can
   * lay every sample on one session clock and mark each resume as well as
   * each new attempt. Optional for the reason it is on `ResultRun`.
   */
  sessions?: ActiveSegment[];
}

/**
 * What a character cost, kept as two sums and never one.
 *
 * A `CostFigure` carries a `basis`, a `priceId` and an `asOf`, and a chain
 * whose attempts were one reported, one priced from the table and one neither
 * has no honest single basis — so the attempts' figures are summed as numbers
 * and the coverage is stated beside them rather than a synthesised figure
 * claiming a basis it does not have. Actual and expected are never added
 * together: they are two answers to two questions (`CostView`).
 */
export interface CharacterCost {
  /** Sum over the attempts that reported an actual charge; null when none did. */
  actualUsd: number | null;
  /** How many attempts that sum covers, out of `attempts`. */
  actualAttempts: number;
  expectedUsd: number | null;
  expectedAttempts: number;
  /** Attempts in the character — the denominator both coverages are read against. */
  attempts: number;
  /**
   * Any attempt whose actual figure is a subscription driver's own
   * `total_cost_usd` (`CostFigure.asIfMetered`): money that was never billed.
   * Carried so a character on a subscription does not read as a bill.
   */
  asIfMetered: boolean;
  /**
   * Of `actualAttempts`, how many carry a backfill (`CostFigure.backfill`):
   * turns their CLI never reported, estimated at list price or left out. The
   * sum wears the same `*` a single run's figure does. Absent from a viewer
   * that predates it.
   */
  actualBackfilled?: number;
}

/**
 * A character's figures, summed or unioned across its attempts.
 *
 * The rule everywhere: a sum over attempts where NONE recorded a kind is null;
 * where some did, those are summed and the rest contribute nothing — the same
 * null-vs-zero discipline the per-run facts keep, so a character with one attempt
 * from before a producer shipped is not reported as having done less.
 *
 * What is summed and what is taken from the furthest attempt is the difference
 * between a tally and a state. Quests, xp, playtime, tokens, deaths and flights
 * are things that happened and add up. Level, money and achievements are what
 * the CHARACTER holds now — achievements included, since the tap reports the
 * whole backlog — so the latest attempt that recorded one answers.
 */
export interface CharacterTotals {
  attempts: number;
  /** The first attempt's start, and the last attempt's end — null while it is live. */
  startedAt: number | null;
  endedAt: number | null;
  playtimeMs: number | null;
  questsCompleted: number | null;
  xpEarned: number | null;
  tokens: TokenTotals | null;
  cost: CharacterCost;
  /** The character's current standing, from the furthest attempt that recorded it. */
  level: number | null;
  money: number | null;
  achievements: AchievementFacts | null;
  /** Tallies: counts summed, marks concatenated in attempt order. */
  /** Publicly the count alone, which is what the character card prints. */
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
 * The freeplay character a run is one attempt of — the whole run, where the run
 * row is one session of it.
 *
 * Served only for a run whose chain holds more than one attempt (`hasLineage`),
 * because "attempt 1 of 1" is noise standing where a fact should be. The
 * aggregation happens HERE, at read time, and nothing is written back: the
 * runner records per attempt and that surface is the model's, not the
 * reader's (docs/METHODOLOGY.md — an old run is read differently, not
 * relabelled).
 */
export interface CharacterView {
  /** The chain root's run id: the character's identity across attempts. */
  characterId: string;
  /*
   * Who is playing, off the NEWEST attempt that recorded each.
   *
   * A character page has to be able to name what it is about, and an attempt
   * row carries figures and nothing else. The newest attempt rather than the
   * oldest because this is a heading about the present: a character can outlive
   * a harness patch or a driver change, and what it is on now is the honest
   * answer to "what is this". Every one of these already rides on the runs
   * listing, so none of it is a new disclosure.
   */
  model: string | null;
  effort: string | null;
  /** The CLI compaction window, off the newest attempt that set one; absent is `auto`. */
  compactWindow?: string | null;
  driver: string | null;
  harnessVersion: string | null;
  /** The in-game character name, and its race/class label. */
  name: string | null;
  characterLabel: string | null;
  /**
   * The newest attempt's episode: a `freeplay` character is the one the
   * milestones are shown for (operator, 2026-11-15). Optional: an older viewer has none.
   */
  episode?: EpisodeIdView | null;
  /** This run's 1-based place in `runs`. */
  attempt: number;
  attempts: number;
  previous: string | null;
  next: string | null;
  /**
   * The root still names a predecessor this viewer did not serve (archived, or
   * gone), so the character begins mid-history and every total below is a lower
   * bound over the attempts on screen.
   */
  truncated: boolean;
  /** Every attempt, oldest first, each with its own figures. */
  runs: CharacterAttempt[];
  totals: CharacterTotals;
}

import type { BossKill } from "./timeline-marks";
export type { BossKill };

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
   * A camera followed the run (`meta.json`'s `"camera": true`). A label only:
   * it never affects a run and is no part of its condition. Absent otherwise.
   */
  camera?: true;
  /**
   * The run's sessions, oldest first — the segments `playtimeMs` sums, read
   * off the same marks. The run page lays its samples on them so a pause is
   * closed rather than drawn. Optional: a snapshot published before the field
   * has none, and the page then draws the wall clock as it always did.
   */
  sessions?: ActiveSegment[];
  /**
   * The roster row this run's model belongs to (`rosterNameOf`), for the run
   * page's link to the models table: matched on (model, effort, compaction
   * window) over the rows `/api/models` lists, falling back to the model's own
   * row. Null when the roster names no such model. Optional: an older viewer
   * or snapshot has none, and the page then prints the model unlinked.
   */
  rosterName?: string | null;
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
   * The boss kills the server reported to this run (`bossKillsOf`): a victim
   * of creature rank 3, or one of a five-man dungeon's bosses by entry, once
   * each, oldest first. The timeline's boss chapters. Absent where there is
   * none, which a run from before the `kill` record, and a viewer or snapshot
   * from before the field, also read as. Publicly the name is null: it is the
   * client cache's.
   */
  bosses?: BossKill[];
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
   * The freeplay character this run is one attempt of, aggregated across the whole
   * chain. Present only when the run has lineage worth printing; optional for
   * the reason `achievements` is — an older viewer does not answer it, and the
   * page falls back to the run's own figures.
   */
  character?: CharacterView;
  /**
   * What this run recorded as one member of a party (`PartyDetailView`).
   * Present only on a party member's run, so every other run's detail keeps
   * its shape; optional for the reason `achievements` is.
   */
  party?: PartyDetailView;
  /**
   * A fan-out run's characters, one session record each, in name order: the
   * session id the inspector's API opens each by (`<run-id>~<Character>`)
   * and the character's name. Present only on a fan-out run, so every other
   * run's detail keeps its shape. The run's own game-side figures (level,
   * states, milestones) are no one character's and read as not recorded;
   * each character's are its session's. Private: the public projection
   * leaves it out, so a published `deadmines-solo` run names no session.
   */
  fanout?: FanoutSessionView[];
  /**
   * The fan-out character whose level and xp `run` reads (`fanoutLead`:
   * the highest level, then the higher xp, then the first by name), so the
   * page can say whose they are. Present only on a fan-out run once one of
   * its characters has a level.
   */
  fanoutLead?: string;
}

/** One character of a fan-out run (`RunDetailResponse.fanout`). */
export interface FanoutSessionView {
  /** The session id: `<run-id>~<Character>`. */
  id: string;
  character: string;
}

/**
 * One member of a party as a member's own stamp names it (`config.party.members`),
 * in member order, the leader first. The account each member logged in with is
 * on the stamp too, and is never served.
 */
export interface PartyMemberRefView {
  member: string;
  role: string;
  runId: string;
  character: string;
}

/** A map transfer that changed the instance type (`instance` milestone): into an instance, or out of one. */
export interface PartyInstanceMark {
  ts: number;
  event: "entered" | "left";
  map: number;
  /** The map the character came from. */
  from: number;
}

/**
 * A kill the server reported to this member (`kill` milestone, off
 * `SMSG_PARTYKILLLOG`): every member in range is told, so the same victim
 * appears on several members' runs and is one kill. Elites and above only.
 */
export interface PartyKillMark {
  ts: number;
  victimGuid: string;
  /** The creature entry, when this member's unit cache knew the victim. */
  entry: number | null;
  /** The creature's name as this member's own client cache answered it, when it did. */
  name: string | null;
  /** This member landed the killing blow. */
  self: boolean;
  /** The victim's creature rank where the record carried one (3 is a boss); the viewer's own, never served. */
  rank?: number;
}

/** One line this member said in party chat, as its trace recorded the server's echo. */
export interface PartyChatMark {
  ts: number;
  text: string;
}

/** A `group` milestone: the party as the server's group list described it to this member. */
export interface PartyGroupMark {
  ts: number;
  event: "joined" | "changed" | "left";
  /** The party's size, this member included; 0 on `left`. */
  count: number;
}

/**
 * Where the member last was, off its newest state sample: the map, zone and
 * area ids, and the zone and area names the client was served for them
 * (`WB_AREA`), when the run saw one.
 */
export interface PartyWhereView {
  ts: number;
  map: number | null;
  zone: number | null;
  zoneName: string | null;
  area: number | null;
  areaName: string | null;
}

/**
 * A party member's own records, beside the facts every run's detail carries
 * (deaths, the level timeline, achievements). Each list is this run's alone;
 * the party page merges the members' (`dashboard/src/lib/party.ts`).
 */
export interface PartyDetailView {
  id: string;
  member: string;
  role: string;
  size: number;
  members: PartyMemberRefView[];
  instances: PartyInstanceMark[];
  kills: PartyKillMark[];
  chat: PartyChatMark[];
  groups: PartyGroupMark[];
  /** When this member died, oldest first: `deaths.sites`' stamps, which the run page itself does not publish. */
  deaths: number[];
  where: PartyWhereView | null;
}

/**
 * One stretch of turns spent reflecting rather than acting. Turn indices only:
 * it is a fact about this harness's own loop, with nothing of the world in it.
 * The derivation and the half-open convention are `run-marks.ts`
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
   * it — so a bug report can describe code that no longer exists. The
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
  /**
   * A series the site offers as "preview (<series>)" instead of as "latest":
   * the store's `site.previewSeries` (`runner/src/site-settings.ts`). While it
   * is set, the selector's "latest" is the newest series other than this one.
   * Absent when unset, which is how a body from an older viewer reads too.
   */
  previewSeries?: string;
  /**
   * What the deployment calls and paints itself: the store's `site` block's
   * `name`, `theme`, `home` and `about` (`runner/src/site-settings.ts`), the
   * about page rendered to sanitized HTML (`site-info.ts`). Present only when
   * one of them is set, so a deployment without them serves the body it did.
   */
  site?: ApiSiteInfo;
  /**
   * Which of the deployment's groups are on (`groups.ts`), present only when
   * one is off: absent is every group, which is how a body from an older
   * viewer, and today's deployment, read. The public projection keeps it, so
   * the public build draws the same pages the deployment has.
   */
  groups?: { runner: boolean; evals: boolean; viewer: boolean };
  /**
   * True when this handle has the admin switch on: the config API and the
   * admin pages are mounted. Absent otherwise, and never on a public handle
   * or in a snapshot.
   */
  admin?: true;
  now: number;
}

/** `/api/info`'s `site`: each field only when the store sets it. */
export interface ApiSiteInfo {
  name?: string;
  /** Per scheme, `#rrggbb` by token; a token a scheme lacks keeps the stylesheet's. */
  theme?: SiteTheme;
  /** `"off"` or an in-site path; absent is the intro. */
  home?: string;
  /** The about page's markdown as sanitized HTML: no raw HTML, no image, links only to http(s), mailto, `/` and `#`. */
  aboutHtml?: string;
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
 * When a run first showed one thing a freeplay milestone reads: the record's
 * instant, and the active time from the run's start to it, on the clock
 * `LevelMark.playtimeMs` uses. `playtimeMs` is null when the run has no
 * session to measure against.
 */
export interface MilestoneMark {
  ts: number;
  playtimeMs: number | null;
}

/**
 * Where on a run's own clock the freeplay milestones beyond its level were
 * first shown (`dashboard/src/lib/ladder.ts`, `RUNGS`, operator 2026-11-15).
 * A mark is null when the run never showed it; `areas` and `flights` say
 * whether the run recorded what the first three read at all, which is the
 * line between "not reached" and "not recorded". First observation, a lower
 * bound in the sense `AreaFacts` is.
 */
export interface MilestoneTimes {
  /** The run wrote zone/area records (`ResultRun.areas` non-null). */
  areas: boolean;
  /** The run's flights were recorded (`ResultRun.taxi` non-null). */
  flights: boolean;
  /** The mark that completed the first sustained exit from the start region (`AreaFacts.leftStartArea`). */
  leftStartArea: MilestoneMark | null;
  /** The first capital zone entered (`AreaFacts.capitalZone`). */
  capitalZone: MilestoneMark | null;
  /** The first takeoff (`TaxiFacts`). */
  flight: MilestoneMark | null;
  /** The first state sample on Outland or Northrend (`EXPANSION_MAPS`). */
  expansion: MilestoneMark | null;
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
  /**
   * Which CLI drove the run. Optional for the reason `resolvedModel` is — a
   * dashboard built against a viewer that predates the field must still render
   * — and already public on `RunRow.driver`, which this mirrors.
   */
  driver?: string | null;
  /** The world the run played on (`RunRow.world`). Operator-only: the public build ships none. */
  world?: string;
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
   * names resolved by `runner/src/characters.ts`; null is "not recorded".
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
   * The probe campaign this run was launched as a cell of, and its stamps, as
   * on `RunRow`. A grouping key for the campaigns page and nothing else: a
   * probe is unscored, so these never reach a chart.
   */
  campaign: string | null;
  cell: string | null;
  campaignVersion?: number | null;
  arm?: string | null;
  ref?: string | null;
  image?: string | null;
  /** As on `RunRow`: absent on a run that is no party member. */
  party?: PartyStampView;
  effort: string | null;
  /**
   * The CLI compaction window, off the comparability stamp. A key like
   * `effort`; absent is the CLI's own `auto`, which every older run is.
   */
  compactWindow?: string | null;
  /** The harness tag. A tag on the row, not a partition. */
  harness: HarnessView | null;
  /**
   * The condition the run was played under (`condition.ts`): a ladder row
   * never mixes two. Optional: a dashboard built against a viewer that
   * predates it derives one from the row's own fields (`conditionOfRun`).
   */
  condition?: RunCondition;
  promptHash: string | null;
  /** The worldserver build this run was stamped against, or null. */
  serverBuild: string | null;
  /** Whether wiki coordinates were served; null when not recorded. */
  wikiCoords: boolean | null;
  /**
   * False when the run had no reference wiki at all (issue #61). Optional so a
   * row built before the field existed — or by a reader that does not care —
   * reads as the ordinary run, which is one that had it.
   */
  wiki?: boolean;
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
  /**
   * Quests turned in over the whole run, summed across the counter's restarts
   * (`questsAcrossRestarts`): the recorded count is the running process's own,
   * so a resume or a sandbox restart starts it again at zero.
   */
  questsCompleted: number | null;
  /** Maps the run was observed on; the Outland/Northrend half of freeplay milestone 7 reads these. */
  maps: number[];
  /**
   * When the freeplay milestones beyond the level were first shown, on this
   * run's clock (`MilestoneTimes`). Optional: a viewer that predates it has none.
   */
  milestoneAt?: MilestoneTimes;
  /*
   * The listing columns. The runs page is the per-run grain, so the facts
   * the fleet's run table used to carry ride on this row rather than being
   * joined against `/api/runs` in a page.
   */
  /** The character's name, where `characterLabel` is its race and class. */
  character: string | null;
  /** Cumulative active time; the same figure `RunListRow.playtimeMs` carries. */
  playtimeMs: number | null;
  /**
   * The sessions that playtime sums (`RunDetailResponse.sessions`). Optional:
   * a viewer or snapshot that predates the field omits it, and a reader then
   * treats the run as one session.
   */
  sessions?: ActiveSegment[];
  /** The run's token totals, or null when the trajectory could not be read. */
  tokens: TokenTotals | null;
  /**
   * What the provider says it charged — `CostView.actual`, and only that.
   * `CostView`'s own top-level fields are the *expected* figure, so a row that
   * held the whole view would render an estimate wherever a reader reached for
   * `cost.usd`; a listing of what runs cost may not quietly show a guess as a bill.
   * `basis: "none"` (with `note` saying which nothing) is the blank.
   */
  actualCost: CostFigure | null;
  /**
   * `CostView.expected` — the price table applied to the run's own tokens,
   * `$0` with `asIfMetered` for a free tier or local hardware. The runs table
   * and the ladder's scatter read it only where no provider figure exists, and
   * mark it as an estimate (operator, 2026-11-18). The public build carries its
   * dollars, basis and price date, not its note. Optional for the reason
   * `xpEarned` is.
   */
  expectedCost?: CostFigure | null;
  /**
   * Whether this run cost the operator money (`runner/src/billing.ts`). Derived
   * from the model id, the api base, and the harness, unless an openai run
   * recorded its roster entry's own `billing`. Free means literally free; a
   * subscription (claude-code, codex, OpenCode Go) counts as paid here, which
   * is deliberately the opposite of the scheduler's verdict in
   * `runner/src/model-cost.ts`; that one answers "which credential may carry
   * this run". The ladder's "exclude free" toggle reads this.
   * Optional for the reason `xpEarned` is: a dashboard built against a viewer
   * that predates the field must still work, and reads `undefined` as unknown
   * rather than as free.
   */
  billing?: "free" | "paid";
  /**
   * Where the run went, from its zone/area milestone records:
   * freeplay milestones 2 and 4 read this. `null` is a run that wrote no such
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
   * (level, then XP, then gold).
   */
  achievements?: AchievementFacts | null;
  /**
   * Flights taken, from the same records; `null` when flights were not recorded
   * for this run. Freeplay milestone 4's second half. See `TaxiFacts` for why
   * null and zero are different facts.
   */
  taxi?: TaxiFacts | null;
  /**
   * Spells learned, talent points spent and trades completed. Null is
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
   * ladder collapses a character's attempts by.
   */
  continuedFrom: string | null;
  /**
   * A launch that produced nothing — `stillbornOf` in `runner/src/run-fact.ts`,
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
  /**
   * `/api/ladder` only: the scripted reference line per series, as numbers
   * (`scripted-reference.ts`). Public as numbers only (operator, 2026-10-20):
   * the run itself is never published, so the line carries no run id.
   */
  scriptedReference?: ScriptedReferenceLine[];
}

/**
 * The level one tier's scripted reference reached in one harness series: the
 * newest finished reference run of that tier and series, reduced to what the
 * ladder's rail draws. Nothing in it names the run.
 */
export interface ScriptedReferenceLine {
  episode: EpisodeIdView;
  series: string | null;
  /** The route, `reference/<id>@<version>`: the line's model. */
  route: string | null;
  level: number;
  xp: number | null;
}

/**
 * One state sample's stored `items` JSON, as the replay path reads it.
 *
 * Raw text rather than parsed rows: the track only parses the samples where the
 * text changed, and comparing the strings is how it knows which those are.
 */
export interface StateItemsRow {
  ts: number;
  seq: number;
  items: string;
}

/** A run's whole recorded track, for map replay: a session's track point (`SessionTrackPoint`, the inspector's) and the driver turn it fell in. */
export interface TrackPoint extends SessionTrackPoint {
  turn: number | null;
}

/**
 * Where a replayed run sits in its freeplay character, and the attempts either
 * side of it.
 *
 * The four scalars off `CharacterView` and nothing else. The map's play bar needs
 * somewhere to step to; it does not need the chain's totals, and carrying the
 * whole view here would make a replay's fetch the size of a run page's for two
 * run ids. Derived from the same `characterViewOf` call `/api/run/<id>` serves its
 * `character` from, so the bar's steps and the run page's attempt strip cannot
 * name different neighbours on a fork.
 *
 * Absent — not null — on a run with no character worth printing, and on a track
 * served or published before this shipped.
 */
export interface TrackCharacter {
  /** The chain root's run id: the character's identity across attempts. */
  characterId: string;
  /** This run's 1-based place in the character. */
  attempt: number;
  attempts: number;
  /** The attempt before this one, when the viewer serves it. */
  previous: string | null;
  /** The attempt that continues this one, when the viewer serves it. */
  next: string | null;
}

/**
 * A run's whole recorded track, for map replay: the session's track
 * (`SessionTrack`, the inspector's: its points, inventory, moves, travel and
 * trace windows) and the run it belongs to. The travel marks are derived at
 * read time from records the run already carries: the `taxi`, `taxi_landed`
 * and `release` milestones, a `death` first seen already released, and the
 * action log's hearthstone.
 */
export interface TrackResponse extends SnapshotEnvelope, SessionTrack<TrackPoint> {
  runId: string;
  characterName: string | null;
  model: string | null;
  harnessVersion: string | null;
  /**
   * The character this run is an attempt of, when it is one: the play bar's
   * previous/next steps. Optional — an older viewer and an older snapshot
   * carry none, and the controls simply do not render.
   */
  character?: TrackCharacter;
  /**
   * A fan-out run's characters, on the run's own track, which has no points
   * of its own: each one's track is `/api/run/<id>/track` under its session
   * id. Absent on every other run. Private, as on the run's detail.
   */
  fanout?: FanoutSessionView[];
}

/* ------------------------------------------------------ trace, nearby --- */

/*
 * The session-side wire shapes (the trace's and the ring's packed windows,
 * the trace index, a movement intention) are the inspector's
 * (`@wrathbench/inspector/wire`), served here unchanged; re-exported so
 * every importer of this file keeps one place to look.
 */
export type * from "@wrathbench/inspector/wire";

/**
 * `nearby.json`'s `nearby`: each live run's public window (`projectLiveNearby`),
 * by run id, for exactly the positions flagged `nearby`. Overwritten every
 * pass and gone with the run's position, so the public site holds the last
 * `PUBLIC_NEARBY_SPAN_MS` of units and never more.
 */
export type LiveNearby = Record<string, NearbyWindow>;

/**
 * One state sample on a character's whole climb, told from which attempt.
 *
 * `StatePoint` plus the two fields that make a chain of attempts legible as one
 * series: the run the sample came from and its 1-based place in the character.
 * The attempt number is what a chart draws a session boundary at — a seam
 * cannot be found from the timestamps alone, because a character can be
 * relaunched within a second of the previous attempt ending.
 */
export interface CharacterStatePoint extends StatePoint {
  runId: string;
  attempt: number;
}

/**
 * `GET /api/character/<id>`: one character, whole.
 *
 * `id` is any run in the chain, not only the head — `characterViewOf` resolves
 * the chain from any member, and `character.characterId` names the canonical
 * one, so a link built from an attempt id lands rather than 404ing.
 *
 * Universal since 2026-09-16: a scored run is a character of one
 * attempt, and this route answers for it exactly as it does for a freeplay
 * character on its twelfth.
 */
export interface CharacterResponse extends SnapshotEnvelope {
  character: CharacterView;
  /**
   * Every attempt's state series laid end to end, attempt order first and
   * timestamp within it. Attempt order rather than a global sort by `ts`
   * because the two agree on a real chain and only the first keeps a seam
   * where a clock skew would move a sample across one.
   */
  states: CharacterStatePoint[];
}

export interface ApiError {
  error: string;
}
