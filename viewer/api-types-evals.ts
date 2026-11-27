/**
 * The evals group's wire shapes: the episode tiers (`/api/episodes`), the
 * probe campaigns (`/api/campaigns`) and the dungeon board (`/api/dungeons`),
 * all served by `api-evals.ts`. Types only, like the contract they extend
 * (`api-types.ts`), whose shared shapes they import; that file never imports
 * back. The ladder is `/api/results`'s shape, which is the viewer's.
 */

import type { EpisodeIdView, HarnessView, SnapshotEnvelope } from "./api-types";

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
  /** A task episode's agents and characters per agent; absent on every other id. */
  task?: { agents: number; characters: number };
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
   * In RUNS, all five: `want` is Σ runsPerCell over the squares (cell, arm)
   * of the assignments the roster still holds, each sweeping its `arms`; `done` the counted runs, never more per
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
  /**
   * The rest of the square's cost: summed over its runs that no provider
   * billed, a subscription's as-if-metered figure or the list-price estimate,
   * the figure each one's run page shows (operator, 2026-11-18). Kept apart
   * from `costUsd` so a bill and an estimate are never one number. Null when
   * no such run is priced; absent from a snapshot published before it.
   */
  estimatedUsd?: number | null;
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
 * One Deadmines attempt as the dungeon board reads it (`viewer/dungeons.ts`):
 * a launch of the id, one run or a party's five. Times are milliseconds from
 * the launch; null when not observed.
 */
export interface DungeonAttemptView {
  runIds: string[];
  /** The party id on the five-agent id (its page is `/party/<id>`); null on the one-agent id. */
  party: string | null;
  launchedAt: number | null;
  /** Counted as the scheduler counts it. */
  counted: boolean;
  live: boolean;
  /** Counted, and ended on the kill of Edwin VanCleef. */
  cleared: boolean;
  /** The verdict the attempt ended on (a member's own, never `party-ended`). */
  reason: string | null;
  timeToClearMs: number | null;
  /** The route's boss entries killed (`DEADMINES_REQUIRED`, seven), in the board's boss order. */
  bosses: number[];
  /** Whether Cookie, the boss off the route, was killed: an optional extra that counts toward nothing. */
  cookie: boolean;
  /** When the last of the route's bosses died. */
  lastBossMs: number | null;
  /** When the first character entered the instance. */
  enteredMs: number | null;
  deaths: number;
  wipes: number;
  /**
   * What the attempt cost, in USD: each member run's cost as the ladder reads
   * it (`runCostReading`), summed; null when any member has no reading.
   */
  costUsd: number | null;
}

/** One model condition on one Deadmines id: its best attempt and how many cleared of how many counted. */
export interface DungeonRowView {
  model: string | null;
  effort: string | null;
  harness: HarnessView | null;
  compactWindow?: string | null;
  series: string | null;
  /** The condition's public dimensions beside the ones above (`RunCondition` without its id), which the tab's chart and table key a row on. */
  condition: { loop: "program" | "snippet"; yield: boolean; pinned: boolean; wiki: boolean };
  /** Counted attempts. */
  n: number;
  /** Of those, cleared. */
  cleared: number;
  best: DungeonAttemptView;
}

/** One id's table, rows in the board's order. */
export interface DungeonBoardView {
  episode: EpisodeIdView;
  rows: DungeonRowView[];
}

/** `/api/dungeons`: the board, both ids, the one-agent id first. */
export interface DungeonsResponse extends SnapshotEnvelope {
  version: number;
  boards: DungeonBoardView[];
  now: number;
}
