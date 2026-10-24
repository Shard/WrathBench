/**
 * The wire shapes of the viewer's read-only `/api` surface.
 *
 * This module is the contract between the Bun viewer and the `dashboard/` SPA,
 * and it is imported by both. It therefore has **no runtime imports** and
 * declares types only: the dashboard bundles for a browser and cannot pull in
 * `bun:sqlite` transitively, and a type-only module keeps the two sides from
 * drifting without either owning the other. Its one import is a type from the
 * driver registry (`runner/src/drivers.ts`), which is import-free itself.
 *
 * The server-side modules (`runs.ts`, `tail.ts`) re-export the names they used
 * to declare, so nothing that imported them before has to move.
 */

import type { Harness } from "../src/drivers";

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
 * `/api/campaigns`: every published probe campaign version, its store row,
 * and the cells × (assignment × arm) grid of what has run.
 *
 * Built from the published definitions (`campaign-defs/*` in the config
 * store) and annotated from the run directory: a version is listed while it is
 * published, whether or not a row names it, and its runs are the ones stamped
 * with its campaign, version, roster name and arm. A run from before arms
 * existed belongs to no square and is not here; it is on the runs pages.
 */
export interface CampaignsResponse extends SnapshotEnvelope {
  now: number;
  campaigns: CampaignView[];
  /**
   * Store rows, published definitions and (assignment, arm) pairs read but not
   * used, and why: `campaigns/<id>`, `campaign-defs/<id>@<v>`, or
   * `<id>@<v>:<ref>:<arm>` for a pair that cannot launch as configured.
   */
  refused: { key: string; reason: string }[];
}

/** One published campaign version. */
export interface CampaignView {
  id: string;
  version: number;
  /** `id@version`. */
  key: string;
  /** The definition's content hash, which every run of it is stamped with. */
  hash: string;
  /** Where it was published from: the commit, the path, and the origin branches that held the commit then. */
  source: { commit: string; path: string; branch?: string[] } | null;
  publishedAt: number | null;
  question: string;
  /** The definition's own note: why it is shaped the way it is. */
  note?: string | null;
  shape: {
    objective: string | null;
    stopAtLevel: number | null;
    /**
     * Every end the definition sets, `stopAtLevel` included as a level end:
     * a `{ level }` ends a run as `level-target`, a `{ kill: { entry } }` as
     * `kill-target`. Empty when none does.
     */
    end: ({ level: number } | { kill: { entry: number } })[];
    episodeMs: number;
    idleMs: number;
    noXpMs: number | null;
    maxToolCalls: number;
    wiki: boolean;
    wikiCoords: boolean;
    resume: boolean;
    maxAttemptsPerCell: number | null;
  };
  cells: { id: string; race: number; class: number; note?: string }[];
  arms: { id: string; note?: string; image: string | null; command: string[] | null; args: string[] }[];
  /** The store row naming this version; null when it is published and no row names it. */
  config: {
    enabled: boolean;
    account: string | null;
    assignments: {
      ref: string;
      model: string;
      effort: string | null;
      compactWindow: string | null;
      harness: string | null;
      runsPerCell: number;
    }[];
  } | null;
  /**
   * `running`: a run is in flight. `queued`: enabled with work left.
   * `complete`: every square settled and nothing in flight. `disabled`: the row
   * is switched off with work left. `unassigned`: no row, or a row naming no
   * assignment the roster still holds. A version the operator concluded is
   * `complete` whatever else holds (`concluded`).
   */
  state: "running" | "queued" | "complete" | "disabled" | "unassigned";
  /**
   * Whether the id's store row lists this version in `concluded`: complete by
   * the operator's verdict rather than by its squares, whose counts `progress`
   * and the grid still state as counted.
   */
  concluded: boolean;
  /**
   * In RUNS, all five: `want` is cells × arms × Σ runsPerCell over the
   * assignments the roster still holds; `done` the counted runs, never more per
   * square than it wants; `capped` the runs wanted on squares abandoned at
   * the attempt cap, which are never coming — so `done + capped === want`
   * exactly when every square is settled; `attempted` every launch, counted
   * or not, live included; `live` the runs in flight.
   */
  progress: { want: number; done: number; attempted: number; capped: number; live: number };
  /**
   * One per assignment × arm, assignments in the row's priority order and arms
   * in the definition's. `compactWindow` is the effective window: the arm's
   * when its args set one, else the roster entry's.
   */
  columns: {
    key: string;
    ref: string;
    arm: string;
    model: string;
    effort: string | null;
    compactWindow: string | null;
    harness: string | null;
  }[];
  /** One row per cell, in the definition's order; squares in `columns` order. */
  grid: { cell: string; squares: Square[] }[];
  /** Per assignment, one summary per arm: the arms side by side. */
  comparison: { ref: string; arms: ArmSummary[] }[];
  /**
   * What the providers BILLED for every run of this version: the reported
   * figure (`actualCost` with a `reported` basis), never a list-price estimate,
   * and never a subscription's as-if-metered figure, which nobody was charged.
   * Null when no run reported a charge, which is not the claim $0 makes.
   */
  costUsd: number | null;
  newestRunId: string | null;
  newestAt: number | null;
}

/** One cell × (assignment × arm) square. */
export interface Square {
  /** The `columns[].key` this square sits under. */
  column: string;
  /** Ended runs, counted or not. A run in flight is in `live`, not here. */
  runs: number;
  /** Ended runs that count toward the square. */
  counted: number;
  /**
   * Counted attempts that reached the definition's end — a run that ended on
   * one (`level-target`, `kill-target`) or got to its stop level; a party is
   * one attempt. 0 when it sets none.
   */
  reached: number;
  live: number;
  /** Minutes of play to the stop level over the counted runs that reached it; null when none did. */
  minutesToStop: { min: number; median: number; max: number } | null;
  /** Best level any run of the square reached. */
  bestLevel: number | null;
  /** Billed cost of the square's runs, on `CampaignView.costUsd`'s basis. */
  costUsd: number | null;
  /** Runs whose recorded race/class is not the cell's declared start. */
  mismatchedStart: number;
  /** Distinct builds the square's runs ran on: their harness versions. */
  builds: string[];
  /** Every run of the square, live ones included, oldest first. */
  runIds: string[];
  /**
   * A party definition's square: its attempts' party ids, oldest first, each
   * the five runs above that share it. Absent on every other square.
   */
  parties?: string[];
  /** The assignment's `runsPerCell`. */
  want?: number;
  /** `done`: it has its counted runs. `capped`: it had its launches without them. Null: still owed. */
  settled?: "done" | "capped" | null;
  /** Why its (assignment, arm) pair cannot launch, or null when it can. */
  refused?: string | null;
}

/** One arm of one assignment, summarised to the definition's stop level. */
export interface ArmSummary {
  arm: string;
  /** Ended runs, counted or not. */
  runs: number;
  /** Counted runs that reached the definition's end (each party member is a run); the medians are over these. */
  reached: number;
  medianMinutesToStop: number | null;
  /** Turns at the first observation of the stop level. */
  medianTurnsToStop: number | null;
  /**
   * The provider's reported cost of a run that reached the stop level — the
   * run ended there (`level-target`), so its total is its cost to the stop.
   * Unlike `costUsd`, a subscription's as-if-metered figure is included,
   * because it is the only cost a subscription arm has; `costAsIfMetered`
   * says how many of the figures were that.
   */
  medianCostToStop: number | null;
  /** Prompt tokens of a run that reached the stop level, over the whole run for the same reason. */
  medianPromptTokensToStop: number | null;
  /** How the ended runs ended, by termination reason. */
  terminations: Record<string, number>;
  builds: string[];
  /** Of the figures behind `medianCostToStop`, how many are a subscription's as-if-metered one. */
  costAsIfMetered?: number;
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
 * scaffold. The registry's own union, by a type-only import: the registry is
 * import-free too, so nothing server-side follows it into the dashboard.
 */
export type HarnessView = Harness;

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
   * Present, and `false`, only on a run configured without the reference wiki
   * at all — no `search_reference`, and the prompt does not name it (issue
   * #61). Absent is the ordinary run, which has it.
   */
  wiki?: false;
  /**
   * The CLI harness's auto-compaction window (`100k`…`1M`; claude-code or codex), a key like
   * `effort`. Absent is the CLI's own `auto`, which is also every run stamped
   * before the field existed.
   */
  compactWindow?: string | null;
  /**
   * Which reference bundle the run read, off the bundle's own `meta` table
   * An annotation: a text-changing rebuild ships as a patch within the
   * series, and `builtAt` marks which side of it a run read. Null when the run had no bundle;
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
   * The probe campaign this run was launched as a cell of, or null on anything
   * else: its own stamps, read off the run's config and never inferred, which
   * is what lets a campaign's results outlive the deletion of its store row.
   */
  campaign: string | null;
  cell: string | null;
  /** The definition version it was stamped with; null when it recorded none. Absent from a viewer that predates versions. */
  campaignVersion?: number | null;
  /** The campaign arm it ran; null on a run from before arms. */
  arm?: string | null;
  /** The roster name the fleet launched a campaign run as; null when it recorded none. */
  ref?: string | null;
  /** The image a run pod was asked to run (`WRATHBENCH_RUN_IMAGE`); null on a child-process launch. */
  image?: string | null;
  /**
   * The party a campaign run is a member of (`config.party`): its id (the
   * attempt's run-id stem), which member, and the size. Absent on every run
   * that is no party member, so no other row changes shape.
   */
  party?: PartyStampView;
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
  /**
   * The roster entry's own `billing`, as the run recorded it at launch
   * (`RunConfig.billing`). Absent on almost every run: billing is derived. The
   * reader's verdict and the price table honour it on the openai driver only
   * (`declaredBillingOf` in `runner/src/billing.ts`).
   */
  declaredBilling?: "free" | "paid";
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
   * `config.continuedFrom` in meta.json). A durable freeplay character is one
   * character across attempts, and this is the only link between them; null is
   * "a fresh launch", which is also what a run written before the column
   * existed and a run whose continuation was dropped both read as.
   */
  continuedFrom: string | null;
  level: number | null;
  xp: number | null;
  /** Copper on hand, and quests turned in. Null when this run's schema predates them. */
  money: number | null;
  /**
   * The newest sample's quest count on a listing row. That counter is the
   * running process's own and starts again at a resume, so `/api/run/<id>`,
   * which holds the run's series, serves the whole run's sum instead
   * (`questsAcrossRestarts`, as on `ResultRun.questsCompleted`), and so do
   * the map feed and the replay track.
   */
  questsCompleted: number | null;
  /**
   * What the character wears and carries, from the newest state sample that
   * recorded it. Null on runs that predate the `items` column, and on every
   * listing row (`/api/runs`, which reads the store's items-free aggregate):
   * only a run's own detail carries it.
   */
  items: ItemSample[] | null;
  mtime: number | null;
  bytes: number | null;
  live: boolean;
  error?: string;
}

/**
 * One item on a state sample: a client-cache name, its stack count, worn or
 * carried, and where it sits.
 *
 * Everything past `name`, `count` and `equipped` is optional and arrived later
 * (the paperdoll/bag UI). Every row written before it carries those three and
 * nothing else, so a reader treats an absent field as **unobserved** — never as
 * zero, and never as slot 0. A live sample can be missing them too: a slot whose
 * item create block or item query has not arrived yet is a real observation of
 * an occupied slot with no id, name or quality behind it.
 *
 * `slot` and `bag` are the SDK's own addressing pair, unchanged, so a row is
 * what `equipItem`/`useItem`/`destroyItem` take:
 * - worn (`equipped: true`): `bag` absent, `slot` the equipment slot 0-18.
 * - carried (`equipped: false`): `bag` 255 for the backpack (slots 23-38) or a
 *   worn bag's own equipment slot 19-22 (slots 0..numSlots-1), `slot` the slot
 *   within it.
 *
 * So `bag !== undefined` is the carried discriminator and `slot` means the same
 * kind of thing on both sides of it. There is no separate `bagSlot`.
 */
export interface ItemSample {
  name: string;
  count: number;
  equipped: boolean;
  /** The item template id, once the item's own create block has been seen. */
  itemId?: number;
  /** Item quality (0 poor .. 7 heirloom), from the item query, once answered. */
  quality?: number;
  /** The equipment slot when worn, the slot within `bag` when carried. */
  slot?: number;
  /** The container, when carried: 255 the backpack, 19-22 a worn bag. Absent when worn. */
  bag?: number;
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
   * position. Optional for the reason `move` is: a run
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
   * Quests turned in by the process that took the sample — it restarts at
   * zero on a resume or a sandbox restart, which is why a run's total is
   * summed across those restarts (`questsAcrossRestarts`). Optional for the
   * reason the frame's numbers are.
   */
  questsCompleted?: number | null;
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
  /**
   * Codex only: the prompt of the turn's last API call, read by the driver
   * from the CLI's rollout. A codex turn is many calls, so `prompt` above is a
   * tally; this is the size of a context. Absent on records written before the
   * driver logged it.
   */
  lastCall?: { prompt: number; contextWindow?: number };
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
  /**
   * The size of the latest prompt. Null for a codex run until a response
   * carries its last call's prompt (`ReportedUsage.lastCall`): a codex turn's
   * own totals are a tally of many calls, so none is shown in its place.
   */
  contextTokens: number | null;
  /** The model's window, where the last call's source said (codex rollout). */
  contextWindow?: number;
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
 * The tokens of a claude-code run that no `claude_result` covers: whatever a
 * session's responses used after its last result (or in a session that never
 * got one). Read off the responses' usage, so the input side is the finished
 * count and the output side the API's opening snapshot — under-read
 * (`tokenTotals`). See `ClaudeCostTally` in `tail.ts`.
 */
export interface UnreportedUsage {
  turns: number;
  promptTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  completionTokens: number;
}

/**
 * How much of a run its provider-reported cost covers: responses that did and
 * did not carry a per-call charge (OpenRouter's shape), and for a claude-code
 * run, the tokens of the turns its CLI never reported a cost for.
 */
export interface CostCoverage {
  costed: number;
  uncosted: number;
  /** Absent on a run with nothing unreported, and on totals derived before the field existed. */
  unreported?: UnreportedUsage;
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
}

/**
 * One dispatched action as the `actions` record carries it
 * (`ActionNote` in `runner/src/sandbox/ipc.ts`, mirrored here because this
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
  /** The CLI compaction window off the same stamp; absent is `auto`. */
  compactWindow?: string | null;
  map: number;
  x: number;
  y: number;
  /** Epoch ms of the state sample this position came from. */
  ts: number;
  level: number | null;
  xp: number | null;
  money: number | null;
  /**
   * Quests turned in over the whole run, summed across the counter's restarts
   * (`questsAcrossRestarts`), as on `ResultRun.questsCompleted`; on a replay,
   * the run's count up to the point.
   */
  questsCompleted: number | null;
  /*
   * No inventory: the map's sidebar reads what the character wears and
   * carries off the trace's character sheet at the playhead (`trace`), and
   * the newest reading here ran the public delay ahead of the pip beside it.
   */
  harnessVersion: string | null;
  /**
   * The newest recorded movement intention, when the run has one. Optional
   * because a published snapshot rendered before this existed carries none,
   * and the map must read those the same way it reads a run that never moved.
   */
  move?: MoveIntentView | null;
  /**
   * The player frame's numbers, from the newest state sample that carried a
   * position. Optional for the reason `move` is: a run
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
  /**
   * The fine-grained trace near now (`PositionTrace`). Absent on a run that
   * recorded none, and on a feed or snapshot from before the recorder.
   */
  trace?: PositionTrace;
  /**
   * True when the run's nearby ring (`/api/run/<id>/nearby`) is being written:
   * its newest file was touched within `NEARBY_FRESH_MS`. Absent otherwise, so
   * the map asks for units only where there are some. In `live.json` it is
   * set exactly where `nearby.json` carries the run's window (`LiveNearby`).
   */
  nearby?: true;
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

/**
 * One session: a stretch of a run during which the harness was actually
 * driving, from its first `meta` or a `resume` to a `pause` or the
 * `termination` (`runner/viewer/sessions.ts`, which owns the derivation). A
 * run resumed in place days later is two of these under one run id.
 */
export interface ActiveSegment {
  start: number;
  /** Null while the segment is still open — the run had not paused or ended. */
  end: number | null;
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
   * The run's sessions, oldest first — the segments `playtimeMs` sums, read
   * off the same marks. The run page lays its samples on them so a pause is
   * closed rather than drawn. Optional: a snapshot published before the field
   * has none, and the page then draws the wall clock as it always did.
   */
  sessions?: ActiveSegment[];
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
  /**
   * The wait is a subscription usage window's (operator, 2026-10-16): its
   * reset time is the operator's, so the public build withholds `resumeAfter`
   * and `why` on such a row. Absent on every other row.
   */
  subscriptionWait?: true;
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
 * The worldserver's deploy-window phase, as `infra/k8s-deploy.sh`
 * writes it to `data/runs/server-state.json` at each transition. `running`
 * is the rest state (and the answer when the file is absent); the four
 * window phases mean a deploy holds the server right now; `failed` is a
 * verdict that stays up until the supervisor next boots. The detail is the
 * script's own sentence — the page prints it, never guesses. These are exactly
 * the phases the script writes; `infra/deploy-phases.test.ts` holds them to it.
 */
export interface FleetServerView {
  phase: "running" | "draining" | "waiting" | "verifying" | "resuming" | "failed";
  /** When the window opened (or the phase was reclaimed as running). */
  since: number;
  /** The build being deployed (or, at rest, the one last deployed); "" when unknown. */
  build: string;
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
  /** Set while the config store does not load; the store's enabled flags are not in effect. */
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
 * A run's level timeline, from its `level` milestone records.
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
  /** Every death observed, in order — the death sites map replay wants. */
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
   * Null when neither had been observed by the sample that saw the death, or
   * when the corpse was inside a dungeon and only its entrance was known.
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
 * `talent` / `trade` milestones.
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
/** A party member's stamp as a row carries it. */
export interface PartyStampView {
  id: string;
  member: string;
  size: number;
  /**
   * The member's role (`tank`, `healer`, `damage`) and its place in the
   * party's member order, the leader at 0. Optional: a viewer that predates
   * them, and a snapshot published before them, carry neither.
   */
  role?: string;
  index?: number;
}

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
   * from the model id, the api base, and the harness, unless an openai run
   * recorded its roster entry's own `billing` — a subscription counts as
   * paid here, which is deliberately the opposite of the scheduler's verdict in
   * `runner/src/model-cost.ts`; that one answers "does this consume the paid
   * concurrency budget". The ladder's "exclude free" toggle reads this.
   * Optional for the reason `xpEarned` is: a dashboard built against a viewer
   * that predates the field must still work, and reads `undefined` as unknown
   * rather than as free.
   */
  billing?: "free" | "paid";
  /**
   * Where the run went, from its zone/area milestone records:
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

/** A run's whole recorded track, for map replay. */
export interface TrackPoint {
  ts: number;
  map: number;
  x: number;
  y: number;
  level: number | null;
  xp: number | null;
  money: number | null;
  /**
   * The run's quest count up to this point, summed across the counter's
   * restarts (`questTally`), so the last point's is the run page's figure.
   * Null before any sample carried one, and on every point of a track
   * published before it was filled.
   */
  questsCompleted: number | null;
  turn: number | null;
  /**
   * The player frame's numbers, from the newest state sample that carried a
   * position. Optional for the reason `move` is: a run
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
   * The inventory as a track served and published before `TrackResponse.inv`
   * carried it, read only from a track that old: the whole inventory on each
   * point where the stored sample changed, a point without the field meaning
   * "unchanged" and one before the first reading "not yet observed". The
   * viewer no longer writes it.
   */
  items?: ItemSample[];
}

/**
 * One item a track's inventory names: `[name, itemId, quality]`, null where
 * the stored row carried none. Keyed by the whole triple, not the id: a
 * random suffix is stored in the name, so one id can carry two names at once.
 */
export type TrackInvItem = [name: string, itemId: number | null, quality: number | null];

/**
 * A slot filled, in a patch: `item` indexes `TrackInventory.items`, and
 * `count` is there only when the stack is not 1. `bag` is -1 for a worn item
 * (`slot` the equipment slot 0-18), else the carried pair `ItemSample` names.
 */
export type TrackInvRow = [bag: number, slot: number, item: number] | [bag: number, slot: number, item: number, count: number];

/** A slot emptied, in a patch. */
export type TrackInvGone = [bag: number, slot: number];

/**
 * One reading, on the index of the point it surfaces at: a patch onto the
 * reading before it (onto empty bags for the first), or `null` and the reading
 * whole, as stored, where a patch cannot say it.
 */
export type TrackInvEntry = [point: number, patch: (TrackInvRow | TrackInvGone)[]] | [point: number, patch: null, whole: ItemSample[]];

/**
 * What the character wore and carried along a track, as changes
 * (`runner/viewer/track-inv.ts` is the codec and the format; `inventoryAt`
 * reads it). Built at read time from the same stored samples the points come
 * from, so nothing about what is recorded changed.
 */
export interface TrackInventory {
  items: TrackInvItem[];
  /** The readings, oldest first; a point before the first has none yet observed. */
  at: TrackInvEntry[];
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
 * One recorded fact about how the character crossed the gap between two track
 * points, which is what the replay's route is drawn by: a flight path's
 * takeoff and landing, a hearthstone used, a spirit released to a graveyard.
 *
 * Derived at read time from records the trajectory already carries — the
 * `taxi`, `taxi_landed` and `release` milestones, a `death` first seen already
 * released (no separate release follows one), and the action log's
 * hearthstone — and never stored. `ts` is the record's own: a milestone's is
 * the state sample that observed it, so the change it names happened since the
 * sample before; a hearth's is the dispatch, about ten seconds before the
 * teleport lands.
 */
export interface TrackTravelMark {
  kind: "taxi" | "taxi_landed" | "hearth" | "release";
  ts: number;
}

export interface TrackResponse extends SnapshotEnvelope {
  runId: string;
  characterName: string | null;
  model: string | null;
  harnessVersion: string | null;
  points: TrackPoint[];
  /**
   * What the character wore and carried, so a replay pip can show what a live
   * pip shows: a reading wherever the stored sample changed, as a patch onto
   * the one before (`TrackInventory`). Absent on a run whose samples recorded
   * no inventory, and on a track served or published before it existed, whose
   * points carry `items` instead.
   */
  inv?: TrackInventory;
  /**
   * The character this run is an attempt of, when it is one: the play bar's
   * previous/next steps. Optional — an older viewer and an older snapshot
   * carry none, and the controls simply do not render.
   */
  character?: TrackCharacter;
  /**
   * Every movement intention the run recorded, oldest first. Separate from
   * `points` because it has its own cadence: a move is dispatched when the
   * model decides to walk, not when the state ticker writes a row. Optional
   * for the same reason as `AgentPosition.move`.
   */
  moves?: MoveIntentView[];
  /**
   * The flight, hearth and graveyard marks, oldest first (`TrackTravelMark`).
   * Optional: an older viewer and a snapshot published before this carry
   * none, and the replay then breaks its line on map changes, the moves'
   * typed teleports and its speed backstop alone.
   */
  travel?: TrackTravelMark[];
  /**
   * The run's closed trace windows (`TrackTrace`). Absent — not empty — on a
   * run that recorded no trace, which is every run from before the recorder,
   * so their tracks serve and publish exactly the bytes they did before.
   */
  trace?: TrackTrace;
}

/* --------------------------------------------------------------- trace --- */

/*
 * The fine-grained trace (`runner/viewer/trace.ts` is the codec and the format
 * spec): positions at about 1 Hz and the unit state beside them, packed one
 * segment per run per UTC-aligned five-minute window. The shapes live here
 * with every other wire shape because the viewer serves them and the
 * dashboard decodes them.
 */

/**
 * One aura: `[spellId, stacks, expiresAt, flags]`, `expiresAt` in epoch ms and
 * 0 for none. A public segment carries the first three only.
 */
export type TraceAura = [number, number, number] | [number, number, number, number];

/** What the character has targeted: its kind, and for a creature its entry and health. */
export interface TraceTarget {
  kind: "creature" | "player" | "object" | "other";
  entry?: number;
  hpPct?: number;
}

/** A cast in progress; `endsAt` is epoch ms. */
export interface TraceCast {
  spellId: number;
  endsAt: number;
}

/**
 * The unit state the trace records. Every key is present in a keyframe; null
 * is unobserved. Fixed by the recorder's contract (`runner/src/` writes the
 * rows), so a key is added here only alongside it.
 */
export interface TraceState {
  hp: number | null;
  hpMax: number | null;
  pw: number | null;
  pwMax: number | null;
  /** 0 mana, 1 rage, 3 energy, 6 runic power. */
  pwType: number | null;
  level: number | null;
  xp: number | null;
  xpMax: number | null;
  auras: TraceAura[];
  combat: boolean;
  mounted: boolean;
  taxi: boolean;
  dead: boolean;
  ghost: boolean;
  resting: boolean;
  target: TraceTarget | null;
  cast: TraceCast | null;
}

/** `[slot, itemId]` or `[slot, itemId, rand]`: equipment slots 0-18. */
export type TraceEquipRow = [slot: number, itemId: number, ...rand: number[]];
/** `[slot, itemId, numSlots]`: a worn bag, slots 19-22. */
export type TraceBagRow = [slot: number, itemId: number, numSlots: number];
/** `[bag, slot, itemId]`, `[bag, slot, itemId, count]` or `[bag, slot, itemId, count, rand]`: a carried item. */
export type TraceInvRow = [bag: number, slot: number, itemId: number, ...countRand: number[]];
/** `[slot, cur, max]`: an equipped item's durability. */
export type TraceDurRow = [slot: number, cur: number, max: number];
/** `[slot, questId, state]` and up to four objective counters: one quest-log slot's raw fields. */
export type TraceQuestRow = [slot: number, questId: number, state: number, ...counters: number[]];
/** `[factionId, standing]`: a visible faction. */
export type TraceRepRow = [factionId: number, standing: number];
/** `[skillId, value, max]`. */
export type TraceSkillRow = [skillId: number, value: number, max: number];

/**
 * The character sheet the trace carries beside the unit state, as numbers
 * and ids (`runner/src/trace-row.ts` is the contract and documents each
 * row). Null is not observed, and a segment from before the sheet was
 * recorded carries none of these keys, which also reads as null: "not
 * recorded", never "empty".
 */
export interface TraceSheet {
  money: number | null;
  equip: TraceEquipRow[] | null;
  bags: TraceBagRow[] | null;
  inv: TraceInvRow[] | null;
  dur: TraceDurRow[] | null;
  quests: TraceQuestRow[] | null;
  rep: TraceRepRow[] | null;
  skills: TraceSkillRow[] | null;
}

/** An item as a segment names it: its quality (null when the query did not say) and its template's name. */
export type TraceItemName = [quality: number | null, name: string];

/**
 * A quest's required counts: the four counter objectives in the log's
 * counter order, then `[itemId, count]` per item to collect. Numbers only.
 */
export type TraceQuestReq = [number, number, number, number, ...[itemId: number, count: number][]];

/** One state change: `[ms from t0, kind, value]`, the kind a `TraceState` or `TraceSheet` key, `qdone`, or `chat`. */
export type TraceEventWire = [number, string, unknown];

/** Where a chat line went (`runner/src/trace-row.ts`, `TraceChatKind`). */
export type TraceChatKind = "say" | "party" | "raid" | "yell" | "whisper" | "emote";

/** A `chat` event's value: one line the character said, its kind and its text. */
export type TraceChat = [kind: TraceChatKind, text: string];

/**
 * The state at a segment's `t0`, and where the character stood.
 *
 * `p` is `[map, x, y, z, o]` quantised (`TraceSegment.q`), or null when no
 * position was known. `pt` is when that position was observed, in ms from
 * `t0` (absent is 0: interpolated to `t0` itself). `f` is a flight still in
 * the air at `t0`: `[map, x, y, z, ms]`, its destination and the ms left.
 */
export interface TraceKeyframe {
  p: [number, number, number, number, number] | null;
  pt?: number;
  /** Every `TraceState` key, and each `TraceSheet` key that is observed. */
  s: Partial<TraceState & TraceSheet>;
  f?: [number, number, number, number, number];
}

/** One run × one window, columnar. The full spec is the comment atop `trace.ts`. */
export interface TraceSegment {
  v: number;
  run: string;
  t0: number;
  t1: number;
  /** Quantisation: `p` units per yard, `o` units per turn. */
  q: { p: number; o: number };
  k: TraceKeyframe;
  /** Per sample: ms since the previous one (the first since `t0`). */
  dt: number[];
  /** Per sample: integer deltas in `1/q.p` yd and `1/q.o` turn. */
  x: number[];
  y: number[];
  z: number[];
  o: number[];
  /** `[sample, map]`: a sample reached by a jump or onto another map. */
  cuts: [number, number][];
  /** `[sample, map, x, y, z, ms]`: a taxi takeoff, its destination and duration. */
  flights: [number, number, number, number, number, number][];
  ev: TraceEventWire[];
  /** The items the sheet references, by id; absent when it references none. */
  items?: Record<string, TraceItemName>;
  /** The quests the sheet's log references, by id: their required counts. */
  qreq?: Record<string, TraceQuestReq>;
}

/** Window `t0`s as runs of consecutive windows: `[firstT0, count]`. */
export type TraceSegRuns = [number, number][];

/**
 * `GET /api/run/<id>/trace`: which windows have a segment, and the open tail.
 *
 * `segs` lists the closed windows that have rows; each is
 * `/api/run/<id>/trace/<t0>`. `tail` is everything after the last closed
 * window, encoded so far — one window, or two while the newest closed one is
 * still settling — or null when there is none.
 */
export interface TraceIndexResponse {
  segMs: number;
  segs: TraceSegRuns;
  tail: TraceSegment | null;
  now: number;
}

/** The closed windows, as a track carries them. */
export interface TrackTrace {
  segMs: number;
  segs: TraceSegRuns;
}

/**
 * A live agent's trace on the position feed: the newest closed windows and the
 * tail, so the live map reads one shape privately and publicly.
 */
export interface PositionTrace {
  segMs: number;
  /** Up to the last three closed windows with rows, oldest first. */
  recent: number[];
  tail: TraceSegment | null;
}

/* ------------------------------------------------------------- nearby --- */

/**
 * What a nearby window says about one unit besides where it is
 * (`runner/viewer/nearby.ts`; the recorder's contract is
 * `runner/src/nearby-row.ts`, pinned compatible by `runner/test/nearby-e2e.test.ts`).
 * Absent keys are unobserved. A public window carries `entry`, `name`, `ctype`,
 * `level`, `hp`, `df`, `nf`, `qg` and `tgs` only.
 */
export interface NearbyStateView {
  entry: number | null;
  name: string | null;
  sub: string | null;
  ctype: number | null;
  level: number | null;
  /** Health as a percentage, 0–100. */
  hp: number | null;
  uf: number | null;
  df: number | null;
  nf: number | null;
  qg: number | null;
  tg: string | null;
  /** The unit targets the character this window is about. */
  tgs: boolean | null;
  ow: string | null;
  ch: string | null;
  disp: number | null;
  scale: number | null;
  mf: number | null;
  race: number | null;
  cls: number | null;
  gender: number | null;
}

/** The character a window is about: which map its units are on, and (privately) who it is and targets. */
export interface NearbySelfView {
  guid: string | null;
  map: number | null;
  target: string | null;
  down: boolean;
}

/**
 * A unit's motion, quantised (`NearbyWindow.q`): `[kind, t, x, y, z, o]`, with
 * `dx, dy, dz, ms` appended on a spline. `kind` is 0 a position sample, 1 a
 * spline from `x, y, z` by `dx, dy, dz` over `ms`, 2 a hold; `t` is ms from the
 * window's `t0` (negative when the motion began before it); `o` is -1 when the
 * packet carried no facing.
 */
export type NearbyMotionWire = number[];

/** One event: `[ms from t0, unit index or -1 for the self, kind, value]`. */
export type NearbyEventWire = [number, number, string, unknown];

/** One run's nearby units over a span, columnar. The full spec is the comment atop `nearby.ts`. */
export interface NearbyWindow {
  v: number;
  run: string;
  /** The keyframe's instant, and the data's horizon (the child's last poll). */
  t0: number;
  t1: number;
  q: { p: number; o: number };
  /** The unit table: guid and type code (0 creature, 1 pet, 2 vehicle, 3 player) per index. */
  ids: string[];
  ty: number[];
  k: {
    self: Partial<NearbySelfView>;
    u: number[];
    s: Partial<NearbyStateView>[];
    m: NearbyMotionWire[];
  };
  /**
   * Per motion row: ms since the previous row (the first since `t0`), the
   * motion's own time relative to its row, the unit, the kind, position deltas
   * from that unit's previous keyframe-or-column position, and the facing.
   */
  dt: number[];
  mt: number[];
  u: number[];
  mk: number[];
  x: number[];
  y: number[];
  z: number[];
  o: number[];
  /** `[motion, dx, dy, dz, ms]`: a spline's destination as a delta from its start. */
  sp: [number, number, number, number, number][];
  ev: NearbyEventWire[];
}

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
   * from (`runner/src/models.ts`) does not know about prices. Only `actual`: the
   * panel prints the provider's figure, and the published snapshot carries
   * nothing else of it.
   */
  cost?: Pick<CostView, "actual"> | null;
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
  /** The entry's CLI compaction window (claude-code or codex); absent is the CLI's own `auto`. */
  compactWindow?: string | null;
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
     * an objective. Same predicate as `run-fleet --status`.
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
     * `policy.maxConcurrent`: runs the policy may have in flight per key,
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

/* ------------------------------------------------------ config drafts --- */

/*
 * The config API's draft routes (`/api/config/proposed`, `runner/viewer/drafts.ts`).
 * Operator-only like the rest of the config API: never mounted on a public
 * handle, so the publisher never renders one. Declared here so the page's
 * client and the server share one shape.
 */

/** Catalogue list price, dollars per million tokens. */
export interface DraftPriceView {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * The token shape a draft's estimate is priced at: the median counted `e90`
 * of this series on the wrathbench harness, provider-reported tokens only.
 */
export interface E90TokenProfileView {
  /** The counted runs the medians are taken over; never zero (no runs, no profile). */
  runs: number;
  series: string | null;
  promptTokens: number;
  completionTokens: number;
  /** Cache reads, a subset of the prompt; a run whose provider never said reads as 0. */
  cacheReadTokens: number;
}

/** One draft as the page lists it. */
export interface DraftView {
  /** The catalogue id, which a promoted entry carries as its `model`. */
  model: string;
  /** The catalogue's display name. */
  name: string | null;
  /** When the catalogue says the model was added (epoch ms); what "newest first" sorts on. */
  created: number | null;
  /** When a fetch first proposed it. */
  firstSeen: number;
  status: "draft" | "ignored";
  ignoredAt: number | null;
  ignoredBy: string | null;
  /** Derived from the slug the way the roster derives it (`billingOf`). */
  billing: "free" | "paid";
  /** Null when the catalogue quotes no usable price. */
  price: DraftPriceView | null;
  /** List price applied to the profile. Null with no price or no profile — never a guess. */
  estimateUsd: number | null;
  /** What a promoted entry would be routed to (`routingLabel`), with no `routing` of its own. */
  routing: string;
  /** A roster name for the promote form to start from. */
  suggestedName: string;
}

/** `GET /api/config/proposed`: drafts newest first, the ignored ones apart. */
export interface DraftsResponse {
  drafts: DraftView[];
  ignored: DraftView[];
  profile: E90TokenProfileView | null;
}

/** `POST /api/config/proposed/fetch`: what one read of the catalogue changed. */
export interface DraftFetchResponse {
  /** Tool-calling models in the catalogue. */
  toolModels: number;
  /** Model ids proposed for the first time. */
  added: string[];
  /** Existing drafts whose name, date or price moved. */
  refreshed: number;
  /** Drafts dropped because the roster now runs that model. */
  removed: string[];
  /** Catalogue rows that did not parse and were left alone. */
  skipped: number;
}

/** `POST /api/config/proposed/{ignore,unignore}`: where the draft now stands. */
export interface DraftStatusResponse {
  model: string;
  status: "draft" | "ignored";
}

/** `POST /api/config/proposed/promote`. Race and class are optional, as on any entry. */
export interface DraftPromoteBody {
  model: string;
  name: string;
  tier: string;
  race?: number;
  class?: number;
}
