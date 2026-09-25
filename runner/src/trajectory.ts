/**
 * Trajectory persistence for one run: `data/runs/<run-id>/`
 *
 *   trajectory.jsonl   every model request/response, snippet + result, event
 *                      batch served, tool call, periodic state line, watchdog
 *                      firings, termination. Append-only, one JSON object per
 *                      line, `{ t, ts, ... }`.
 *   run.sqlite         run metadata row + periodic state rows, for querying
 *                      across runs without parsing JSONL.
 *   meta.json          the run config + harness version, for `--resume`.
 *   workspace/         owned by Workspace (notes.md and the model's other files).
 *
 * Redaction: records never carry API keys by construction (headers are never
 * logged), and every string is additionally scrubbed against the secret values
 * registered via `redact()` — belt and braces for a key that leaks into a
 * message body.
 */

import type { Database } from "bun:sqlite";
import { openRunDb } from "./rundb";
import { appendFileSync, mkdirSync, readFileSync, existsSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { jsonLine, toJsonSafe } from "./jsonsafe";
import type { Comparability } from "./comparability";
import type { PauseReason, RunConfig, TerminationReason } from "./config";
import { platformOf } from "./platform";

export interface StateLine {
  level?: number | undefined;
  xp?: number | undefined;
  map?: number | undefined;
  x?: number | undefined;
  y?: number | undefined;
  z?: number | undefined;
  eventCount?: number | undefined;
  lastSeq?: number | undefined;
  /** Copper on the character, from `PLAYER_FIELD_COINAGE`. */
  money?: number | undefined;
  /** Turn-ins the server confirmed this session, cumulative. */
  questsCompleted?: number | undefined;
  /**
   * Which driver turn was in flight when this sample was taken.
   *
   * Samples are taken on `stateIntervalMs`, not once per turn, so this is the
   * turn a value was *first observed* on, never the turn it was reached on.
   * Optional: samples written before the column existed have none, and a
   * sample taken before the first turn (or by a driver with no turn counter)
   * records nothing rather than a misleading 0.
   */
  turn?: number | undefined;
  /** Zone id from the state cache (`self.zone`, WB_AREA). Ids only: names are client text. */
  zone?: number | undefined;
  /** Area (subzone) id from the state cache (`self.area`). */
  area?: number | undefined;
  /**
   * The player frame's own numbers, off the same snapshot
   * every other field here comes from — no extra RPC. `health`/`maxHealth` and
   * `power`/`maxPower` arrive as the state cache's derived gauges, which it
   * withholds until both halves have actually been observed, so a pair is
   * either wholly present or wholly absent and a ratio read off one row is
   * never mismatched. `powerType` is the raw field the client picks the bar
   * with; `nextLevelXp` is the denominator of the XP bar.
   */
  health?: number | undefined;
  maxHealth?: number | undefined;
  power?: number | undefined;
  maxPower?: number | undefined;
  powerType?: number | undefined;
  nextLevelXp?: number | undefined;
  /**
   * What the character carries and wears: names, counts, ids and
   * quality from the state cache's item queries, `equipped` for inventory
   * slots 0-18, carried rows from `state.bag()` across every bag with the
   * `bag`/`slot` pair the item actions take. Omitted when the snapshot had no
   * inventory at all.
   */
  items?: ItemSample[] | undefined;
}

/**
 * One movement intention, as the sandbox watched it (`MoveIntentNote`): the
 * destination a `move_to` was dispatched for, and the module's verdict once it
 * arrived. Two rows per move in the normal case — the dispatch, then the
 * verdict — so a replay can show a move in flight and then how it ended.
 */
export interface MoveLine {
  /** When this happened: the dispatch, or the verdict. Defaults to now. */
  ts?: number | undefined;
  /** The module's move id; absent when the ack had not answered yet. */
  moveId?: number | null | undefined;
  /** The map the dispatch was made on. A destination is meaningless without it. */
  map?: number | null | undefined;
  x: number;
  y: number;
  z: number;
  /** The unit the move was aimed at, when it was aimed at one. */
  target?: string | null | undefined;
  /** The module's verdict (`arrived`, `too_far`, `superseded`, …); absent while in flight. */
  status?: string | null | undefined;
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

/**
 * A world-state transition the loop noticed between two samples.
 * Kinds are additive; derivations (first capital, zone
 * coverage) come later and read these. `from`/`to` carry ids only — never
 * names — so the record stays what the server said, and a rendering choice
 * (which locale, which DBC) never changes a trajectory after the fact.
 */
/**
 * One `{ t: "milestone", ... }` trajectory record. Kinds are
 * additive and every consumer ignores the ones it does not know, so a new kind
 * never invalidates a run.
 *
 * - `zone` / `area`: a change of `self.zone` / `self.area`, ids only, `from`
 *   absent on the first observation of a process.
 * - `achievement`: one of **our own** earns. Never another player's:
 *   `SMSG_ACHIEVEMENT_EARNED` is a say-range broadcast.
 * - `achievements_at_login`: the backlog `SMSG_ALL_ACHIEVEMENT_DATA` carried,
 *   written once per process so a resumed run's history is visible without its
 *   past being re-emitted as fresh firsts. Written even when the backlog is
 *   empty — it is the record that says the taps were live for this run, which
 *   is what lets a reader tell "flew nowhere" from "flights were not recorded".
 * - `taxi` / `taxi_landed`: `taxiFlight` on self flipping on after an accepted
 *   reply, and flipping back. The area id is keyed `areaId`, not `id`, so no
 *   consumer can mistake a flight record for a zone/area mark.
 * - `level`: `self.level` changing, `from` absent on the first observation of a
 *   process exactly as on `zone` — so a run's starting level is on the record
 *   and a consumer counts level-ups as the marks that carry a `from`, never as
 *   the number of marks. `xp` is the reading at the moment the new level was
 *   first seen, which is what the client's bar showed.
 * - `death` / `release` / `resurrect`: own health reaching zero, the spirit
 *   being released to a graveyard, and the character being alive again.
 *   Produced from the events themselves — the sandbox child latches each
 *   transition as it arrives and the state sample drains what happened since
 *   the last one — with the sampled window read kept as the fallback for a
 *   process that opens on an already-dead character or a child that cannot
 *   answer. `observedTs` on a `death` is the timestamp of the event that
 *   carried it: the death's own moment, not the sample's. `zone` / `area` are
 *   the reading at that moment, which is the death site unless `released` says
 *   the spirit was already at the graveyard — on an event-driven death it
 *   normally is not, and the `release` record a moment later is what says when
 *   the spirit went; the field is absent when `playerFlags` had not been
 *   observed at all, which is ordinary.
 * - `spells_at_login`: the spellbook as the first sample that saw one read it
 *   (`SMSG_INITIAL_SPELLS`), written once per process. It does the job
 *   `achievements_at_login` does for flights — it is the record that says the
 *   spellbook, talent and trade producers were live for this run, which is what
 *   lets a reader tell "learned nothing" from "learning was not recorded" — and
 *   it is also what keeps a resumed character's whole book from landing as
 *   twenty fresh learns.
 * - `spell`: one id appearing in the book after that baseline. Ids only: the
 *   rank and the name are the client's own Spell.dbc reading of the id.
 * - `talent`: a talent whose rank climbed. `points` is the rank normalised to
 *   points spent (the wire rank is 0-based: rank 0 is one point), `rank` is the
 *   wire value as it arrived. The first observation of a talent frame seeds
 *   silently — a resumed character's already-spent points are not spends this
 *   run made — and a respec lowers the remembered rank without a record, so a
 *   relearn afterwards reads as a spend again.
 * - `trade`: one completed trade, read from `state.trade` latching
 *   `TRADE_STATUS_TRADE_COMPLETE` (8). `observedTs` is the cache's stamp for
 *   that packet, which is both the trade's own moment and what dedupes it
 *   across samples. What was traded is not on the record: the SDK clears both
 *   sides of the window as soon as the trade stops being open, so by the time a
 *   sample lands only the completion itself survives. Two completions inside
 *   one sampling gap record one — the usual lower bound.
 */
export type MilestoneLine =
  | {
      kind: "zone" | "area";
      from: { id: number } | undefined;
      to: { id: number };
      turn?: number | undefined;
    }
  | {
      kind: "achievement";
      id: number;
      name?: string | undefined;
      points?: number | undefined;
      categoryId?: number | undefined;
      turn?: number | undefined;
    }
  | { kind: "achievements_at_login"; ids: number[]; points: number; turn?: number | undefined }
  | { kind: "taxi"; from?: { areaId: number } | undefined; turn?: number | undefined }
  | { kind: "taxi_landed"; to?: { areaId: number } | undefined; turn?: number | undefined }
  | {
      kind: "level";
      from: number | undefined;
      to: number;
      xp?: number | undefined;
      turn?: number | undefined;
    }
  | {
      kind: "death";
      /** The death event's own timestamp (the sampled fallback uses the cache's). */
      observedTs?: number | undefined;
      /** Where the corpse is, and which packet said so; absent when unobserved. */
      position?:
        | { map: number; x: number; y: number; z: number; source: "corpse_query" | "death_spot" }
        | undefined;
      zone?: { id: number } | undefined;
      area?: { id: number } | undefined;
      /** The ghost flag was already set when the death was first observed. */
      released?: boolean | undefined;
      turn?: number | undefined;
    }
  | {
      kind: "release";
      graveyard?: { map: number; x: number; y: number; z: number } | undefined;
      turn?: number | undefined;
    }
  | { kind: "resurrect"; turn?: number | undefined }
  | { kind: "spells_at_login"; ids: number[]; turn?: number | undefined }
  | { kind: "spell"; id: number; turn?: number | undefined }
  | {
      kind: "talent";
      id: number;
      /** Points now spent in that talent: the wire rank plus one. */
      points: number;
      /** The wire rank, 0-based, exactly as `SMSG_TALENTS_INFO` carried it. */
      rank: number;
      /** The spec the points went into, when the packet named one. */
      spec?: number | undefined;
      turn?: number | undefined;
    }
  | {
      kind: "trade";
      /** The cache's stamp for the completion packet; the dedup key. */
      observedTs?: number | undefined;
      turn?: number | undefined;
    };

/**
 * The entrypoint loop's records (a probing spike; `loop: "entrypoint"`,
 * loop.ts `EntrypointPhases`). A turn is still one model request; a wake is
 * the run of requests between two sleeps, and `request`/`response` records
 * carry `wake` on this loop only. Every kind is additive: the collector keeps
 * a kind it does not name in `raw`, and nothing reading the snippet loop's
 * records sees a change.
 *
 * - `wake`: a wake began — with its first request's `turn`, why (`reasons`,
 *   `wake.ts` `WakeKind`: start, error, load, halted, restart, requested,
 *   milestone, fallback) and how long the model had slept (0 on the first).
 * - `wake_end`: it ended — `requests` made, and whether by a reply without a
 *   tool call (`yield`) or at the request cap (`cap`); `run_end` is the last
 *   one, written when the run stops (`requests` 0 if it stopped asleep). Each
 *   carries the program's `ticks`, `longestTickMs`, `overruns`, `halts` and
 *   `restarts` since the previous `wake_end`, so the records sum to the run.
 * - `deploy`: main.ts loaded (or failed to, with the error the model is
 *   shown) as a wake ended, or unloaded because it was deleted; `reload: true`
 *   marks the host bringing a deploy back after a restart it was not blamed
 *   for. `version` is the workspace import version it loaded at.
 * - `program_error`: one error signature and how many times it happened since
 *   the previous `wake_end`, written just before each `wake_end`, so the counts
 *   sum to every occurrence exactly once.
 *
 * `wake`, `deploy` and `version` count from 1 in each process, and `turn` here
 * is the process's own, as on `request`: a resumed run starts them again, so
 * an analysis keys them on the segment, which `resume` records delimit.
 */
export type EntrypointRecord =
  | { t: "wake"; wake: number; turn: number; reasons: string[]; sleptMs: number }
  | {
      t: "wake_end";
      wake: number;
      requests: number;
      reason: "yield" | "cap" | "run_end";
      ticks: number;
      longestTickMs: number;
      overruns: number;
      halts: number;
      restarts: number;
    }
  | {
      t: "deploy";
      wake: number;
      deploy: number;
      version: number;
      ok: boolean;
      action: "load" | "unload";
      error?: string;
      exports?: string[];
      warnings?: string[];
      reload?: true;
    }
  | {
      t: "program_error";
      wake: number;
      signature: string;
      hook: string;
      /** `failed`: an `sdk` call from the program that threw, rejected or answered `ok: false`, caught or not; `thrown`: every other signature. */
      kind: "thrown" | "failed";
      count: number;
      deploy: number | null;
    };

export interface RunMeta {
  runId: string;
  harnessVersion: string;
  startedAt: number;
  config: RunConfig;
  /**
   * Everything that has to match before two runs share a chart: harness
   * version, prompt hash, episode budget, context engine, effort, and whether
   * an operator objective steered the run. Absent on runs written
   * before the stamp existed, which read as "not recorded" rather than being
   * recomputed against today's prompt.
   */
  comparability?: Comparability;
  /**
   * The unscored stamp (`unscoredStamp` in config.ts): set for a stub run or
   * an operator-objective run. Present in meta.json, in the `shakeout` column
   * of run.sqlite and in the timeline header, so such a run cannot be mistaken
   * for a score. The key keeps its name from before the harness/driver
   * split because old runs carry it; the harness (`wrathbench` | `claude-code`) is a separate dimension in
   * the comparability tuple, never a stamp here.
   */
  shakeout?: string;
  /**
   * Set while the run is paused (`--resume` clears it): the reason, when, and
   * the episode clock spent so far, which is what the resumed run's wall
   * clock continues from. The same facts are in run.sqlite's `pause_reason`
   * and the trajectory's `pause` record; they live here too so a supervisor
   * can find resumable runs from meta.json alone.
   */
  pause?: PauseMark;
  /**
   * A resume that could not reattach the driver's own conversation (the
   * claude-code CLI keeps its history in its own session; the runner starts
   * a fresh one and says so in the prompt). Sticky once set: the run had at
   * least one fresh restart somewhere in its life.
   */
  resumedFresh?: boolean;
  /**
   * What the *provider* said it actually served, as opposed to what the run
   * asked for. `config.model` is the roster's string — often an alias (`sonnet`,
   * `opus`) that the Claude Code CLI resolves at launch — so nothing in run
   * metadata said which Claude a run was on. The CLI's `init` event names the
   * resolved id and its own version; an OpenAI-compatible provider names the
   * served id on every response. First observation wins and is never revised:
   * a run has one answer, and a second look would only ever be a later segment
   * disagreeing with the one the score was earned under.
   *
   * Absent on every run written before this existed. The viewer back-fills
   * those at read time from the trajectory rather than rewriting them.
   */
  resolved?: ResolvedModel;
}

/** The provider's own answer to "what ran", promoted onto the run. */
export interface ResolvedModel {
  /** The resolved model id (`claude-sonnet-5`), or null when none was named. */
  model: string | null;
  /** The Claude Code CLI's version. Null on any other driver. */
  cliVersion: string | null;
  /**
   * The backend that actually served the run, as the response body named it
   * (`Z.AI`, `Together`, `Google AI Studio`). Null on a driver or endpoint
   * that names none.
   *
   * The same species as `model`: observed mid-episode, promoted once, never
   * revised. It is the *answer* to the routing the tuple stamped — the request
   * says which providers are allowed, this says which one took it — and with
   * `allow_fallbacks: false` those agree, so a disagreement is exactly the
   * thing worth seeing. It is an annotation and not a key for the reason the
   * resolved model id is not one (docs/METHODOLOGY.md): a fact observed
   * minutes after launch cannot be part of what a launch stamped, and the
   * requested routing already carries the grouping.
   */
  provider: string | null;
}

export interface PauseMark {
  reason: PauseReason;
  detail?: string | undefined;
  at: number;
  /** Episode wall clock spent across every segment up to this pause. */
  episodeElapsedMs: number;
}

export interface TrajectoryRecord {
  t: string;
  ts: number;
  [key: string]: unknown;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS run (
  run_id TEXT PRIMARY KEY,
  harness_version TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  -- The driver is its own column, not just a key inside config_json: a
  -- cross-run SELECT must be able to exclude stub runs without parsing.
  -- shakeout is the unscored stamp (legacy column name, see RunMeta).
  driver TEXT,
  shakeout TEXT,
  model TEXT,
  -- The operator objective this run was steered with, if any. Its
  -- own column for the same reason the driver has one: a cross-run SELECT must
  -- be able to exclude steered runs without parsing config_json.
  objective TEXT,
  -- The character this run played and the platform that served the model
  --. Both were derivable from config_json and from the api
  -- base; a column means a cross-run SELECT — and the viewer's listing — does
  -- not have to parse a blob or re-derive a rule that could drift.
  character TEXT,
  platform TEXT,
  -- What the provider actually served (RunMeta.resolved), promoted out of the
  -- driver's own first word: the CLI resolves the alias 'sonnet' to the id
  -- 'claude-sonnet-5' at launch, and a column means a cross-run SELECT can ask which Claude a row
  -- was on without replaying the trajectory.
  resolved_model TEXT,
  resolved_cli_version TEXT,
  -- And which backend served it (2026-09-16): an aggregator answers one slug
  -- from many machines, so "which provider was this row on" is a question a
  -- cross-run SELECT has to be able to ask without replaying the trajectory.
  resolved_provider TEXT,
  -- The freeplay run this one continues (RunConfig.continuedFrom): the
  -- lineage of a freeplay character, so a listing can follow it across
  -- the run ids the operator's disable/re-enable cycle gave it.
  continued_from TEXT,
  termination_reason TEXT,
  termination_detail TEXT,
  pause_reason TEXT,
  -- When the run's reflection window opened, NULL whenever none is open. A
  -- single nullable column rather than a table of transitions: the question
  -- the viewer asks is "is this character reflecting right now", and a window
  -- has no history worth keeping in sqlite: the reflect_window records in the
  -- trajectory are that history.
  reflecting_since INTEGER,
  config_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS state (
  run_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  level INTEGER,
  xp INTEGER,
  map INTEGER,
  x REAL, y REAL, z REAL,
  event_count INTEGER,
  last_seq INTEGER,
  -- Phase-1 signal vector groundwork: recorded, never scored here.
  money INTEGER,
  quests_completed INTEGER,
  -- The driver turn in flight when the sample was taken, so turns-to-level is
  -- derivable without replaying the JSONL. Nullable, like StateLine.turn.
  turn INTEGER,
  -- Zone and area ids: where the sample was taken, as the
  -- game's own area ids; names are rendered from the client's DBC, not stored.
  zone INTEGER,
  area INTEGER
);
-- Movement intention: where the character was trying to get to, one row per
-- (dispatch, verdict). Its own table rather than columns on the state table,
-- because state is what the scorer and every derivation in the viewer read,
-- and an intention is not an observation of the world: it is this run's own
-- last request. CREATE TABLE IF NOT EXISTS gives an older run.sqlite the
-- table (empty) the first time this build opens it.
CREATE TABLE IF NOT EXISTS move (
  run_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  move_id INTEGER,
  map INTEGER,
  x REAL, y REAL, z REAL,
  -- The unit the move was aimed at, when it was aimed at one.
  target TEXT,
  -- The module's verdict; NULL on the row that records the dispatch itself.
  status TEXT
);
`;

/**
 * Columns added to `run` inside the 0.4 series (at 0.4-6).
 * `CREATE TABLE IF NOT EXISTS` is a no-op on an existing run.sqlite, so a
 * resumed 0.4-1..0.4-5 run would otherwise write into a table that lacks
 * them. The only migration the runner carries: every run below the 0.4
 * floor is archived, and every 0.4 `state` table already has every column.
 */
const RUN_ADDED_COLUMNS: Record<string, string> = {
  character: "TEXT",
  platform: "TEXT",
  // Added at 0.5: promoted from the driver's first word mid-episode, so a run
  // launched by an older build (and any run resumed by this one) gains them here.
  resolved_model: "TEXT",
  resolved_cli_version: "TEXT",
  // Added 2026-09-16: the backend that served the run (`routing.ts`).
  resolved_provider: "TEXT",
  // Added 2026-08-29: a freeplay continuation names its predecessor.
  continued_from: "TEXT",
  // Added 2026-08-30: the open reflection window, for the viewer's live feed.
  reflecting_since: "INTEGER",
};

/**
 * Columns added to `state` inside the 0.4 series. Same
 * reason: a resumed run's sqlite predates them, and the insert names them.
 * No compat reads — a sample written before the column existed has NULL.
 */
const STATE_ADDED_COLUMNS: Record<string, string> = {
  zone: "INTEGER",
  area: "INTEGER",
  // JSON `ItemSample[]`; NULL when the sample carried none.
  items: "TEXT",
  // Added 2026-08-30: the player frame's numbers. Additive and
  // nullable — nothing scored reads them, and a sample written before they
  // existed has NULL, which every reader renders as unobserved.
  health: "INTEGER",
  max_health: "INTEGER",
  power: "INTEGER",
  max_power: "INTEGER",
  power_type: "INTEGER",
  next_level_xp: "INTEGER",
};

export class Trajectory {
  readonly dir: string;
  readonly jsonlPath: string;
  private readonly db: Database;
  private readonly secrets: string[] = [];
  private readonly now: () => number;
  /**
   * The run this file belongs to, latched at `writeMeta` — which every launch
   * and every resume path calls before a turn is taken. It exists so `append`
   * can mirror the one record kind that has a *current* answer worth querying
   * (`reflect_window`) into the `run` row without every call site having to
   * pass a run id it does not otherwise need. Null for the read-only openers
   * (`classify.ts`, `timeline.ts`), which append none of those kinds.
   */
  private runId: string | null = null;

  constructor(dir: string, opts: { now?: () => number } = {}) {
    this.dir = dir;
    this.now = opts.now ?? Date.now;
    mkdirSync(dir, { recursive: true });
    this.jsonlPath = join(dir, "trajectory.jsonl");
    this.db = openRunDb(join(dir, "run.sqlite"));
    this.db.exec(SCHEMA);
    this.migrateTable("run", RUN_ADDED_COLUMNS);
    this.migrateTable("state", STATE_ADDED_COLUMNS);
  }

  /** Additive, idempotent: add any column this build knows and the file lacks. */
  private migrateTable(table: "run" | "state", columns: Record<string, string>): void {
    const have = new Set(
      (this.db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name),
    );
    for (const [name, type] of Object.entries(columns)) {
      if (!have.has(name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    }
  }

  /**
   * One movement intention: a `move_to` dispatch, or the verdict that ended it.
   *
   * Written whenever the sandbox's watched intent changes — the state ticker
   * samples every 5s, so a walk shorter than the state-row cadence still gets
   * both of its rows. The caller owns the change detection (`MoveLine` is
   * whatever it saw); this only records.
   */
  recordMove(runId: string, m: MoveLine): void {
    this.append({ t: "move", ...m });
    this.db
      .query(
        `INSERT INTO move (run_id, ts, move_id, map, x, y, z, target, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(runId, m.ts ?? this.now(), m.moveId ?? null, m.map ?? null, m.x, m.y, m.z, m.target ?? null, m.status ?? null);
  }

  /** One `milestone` record, the way `quest_complete` is written. */
  recordMilestone(m: MilestoneLine): void {
    this.append({ t: "milestone", ...m });
  }

  /** Register a secret to scrub from every persisted string. */
  redact(secret: string | undefined): void {
    if (secret !== undefined && secret.length >= 8) this.secrets.push(secret);
  }

  private scrub(line: string): string {
    let out = line;
    for (const s of this.secrets) out = out.replaceAll(s, "[redacted]");
    return out;
  }

  /** Append one record. `ts` is stamped here unless the record carries one. */
  append(record: { t: string; ts?: number; [key: string]: unknown }): void {
    const full = { ts: this.now(), ...record };
    appendFileSync(this.jsonlPath, `${this.scrub(jsonLine(full))}\n`, "utf8");
    if (record.t === "reflect_window") this.mirrorReflectWindow(full.ts, record["event"]);
  }

  /**
   * Keep `run.reflecting_since` equal to the gate's window, so a reader can ask
   * whether a character is reflecting *now* without replaying the JSONL. The
   * transitions themselves stay in the trajectory; this is only the current
   * answer, and it is written from the same records rather than from a second
   * call site, so the two cannot disagree.
   */
  private mirrorReflectWindow(ts: number, event: unknown): void {
    if (this.runId === null || (event !== "open" && event !== "close")) return;
    this.setReflectingSince(event === "open" ? ts : null);
  }

  private setReflectingSince(since: number | null): void {
    if (this.runId === null) return;
    this.db.query(`UPDATE run SET reflecting_since = ? WHERE run_id = ?`).run(since, this.runId);
  }

  writeMeta(meta: RunMeta): void {
    this.runId = meta.runId;
    const safe = JSON.parse(this.scrub(jsonLine(meta))) as RunMeta;
    writeFileSync(join(this.dir, "meta.json"), `${JSON.stringify(toJsonSafe(safe), null, 2)}\n`, "utf8");
    this.db
      .query(
        `INSERT INTO run (run_id, harness_version, started_at, driver, shakeout, model, objective, character, platform, resolved_model, resolved_cli_version, resolved_provider, continued_from, config_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET harness_version = excluded.harness_version`,
      )
      .run(
        meta.runId,
        meta.harnessVersion,
        meta.startedAt,
        meta.config.driver,
        meta.shakeout ?? null,
        meta.config.model ?? null,
        meta.config.objective ?? null,
        meta.config.character ?? null,
        platformOf(meta.config.apiBase, meta.config.driver),
        meta.resolved?.model ?? null,
        meta.resolved?.cliVersion ?? null,
        meta.resolved?.provider ?? null,
        meta.config.continuedFrom ?? null,
        this.scrub(jsonLine(meta.config)),
      );
    /*
     * No window is open at a process boundary. `reflect.ts`: "A resumed run
     * starts with a fresh gate — closed window, un-armed until the next
     * false→true transition", and a pause is the same boundary. Clearing here
     * is that in-memory truth's persistent half: a run killed mid-window would
     * otherwise leave the column standing and read as reflecting forever.
     */
    this.setReflectingSince(null);
    this.append({ t: "meta", ...meta });
  }

  /**
   * A continuation whose character turned out to be gone: the run goes on as
   * a fresh one, and every place that said "continues run X on character Y"
   * — the run row, meta.json and the trajectory — is told so, because a
   * lineage the character does not back is exactly the wrong record.
   */
  dropContinuation(runId: string, detail: string): void {
    this.append({ t: "harness", kind: "continue-dropped", detail });
    this.db.query(`UPDATE run SET continued_from = NULL, character = NULL WHERE run_id = ?`).run(runId);
    const path = join(this.dir, "meta.json");
    try {
      const meta = JSON.parse(readFileSync(path, "utf8")) as RunMeta;
      const { continuedFrom: _from, character: _name, ...config } = meta.config;
      writeFileSync(path, `${JSON.stringify(toJsonSafe({ ...meta, config }), null, 2)}\n`, "utf8");
    } catch {
      // No meta.json (a test harness): the row and the record carry it.
    }
  }

  /**
   * Promote what the provider said it served onto the run, once.
   *
   * Not folded into `writeMeta`: the answer arrives mid-episode (the CLI's
   * `init` event, the first response body), long after the launch write, and
   * `writeMeta`'s conflict path deliberately updates only `harness_version`.
   * So this owns both halves — the `run` row and `meta.json` — and is the only
   * writer of either field. First observation wins: a call that would overwrite
   * an already-recorded value with a different one is ignored, and the run
   * keeps the id it was launched under.
   *
   * Returns whether anything was written, so a caller can log the promotion
   * exactly once without keeping its own flag honest.
   */
  recordResolved(runId: string, r: Partial<ResolvedModel>): boolean {
    const model = r.model ?? null;
    const cliVersion = r.cliVersion ?? null;
    const provider = r.provider ?? null;
    if (model === null && cliVersion === null && provider === null) return false;
    const meta = this.readMetaFile();
    const have = meta?.resolved;
    const next: ResolvedModel = {
      model: have?.model ?? model,
      cliVersion: have?.cliVersion ?? cliVersion,
      // `?? null` and not `?? provider`: an older run's `resolved` block has no
      // `provider` key at all, and `undefined ?? provider` would take the new
      // one — which is what we want — while a run that recorded `null` keeps
      // its null. Both read the same here, and the first observation wins
      // either way.
      provider: have?.provider ?? provider,
    };
    if (
      have !== undefined &&
      have.model === next.model &&
      have.cliVersion === next.cliVersion &&
      (have.provider ?? null) === next.provider
    ) {
      return false;
    }
    try {
      this.db
        .query(`UPDATE run SET resolved_model = ?, resolved_cli_version = ?, resolved_provider = ? WHERE run_id = ?`)
        .run(next.model, next.cliVersion, next.provider, runId);
    } catch {
      /* a run.sqlite that cannot take the update must not end the episode */
    }
    if (meta !== null) {
      /*
       * The tuple carries the same answer as an annotation, so a reader that
       * already parses comparability does not need a second lookup. It is
       * excluded from `sameComparability`, which is why
       * filling it here does not turn every resume into a restamp.
       */
      const merged: RunMeta = {
        ...meta,
        resolved: next,
        ...(meta.comparability !== undefined
          ? { comparability: { ...meta.comparability, resolvedModel: next.model } }
          : {}),
      };
      const safe = JSON.parse(this.scrub(jsonLine(merged))) as RunMeta;
      writeFileSync(join(this.dir, "meta.json"), `${JSON.stringify(toJsonSafe(safe), null, 2)}\n`, "utf8");
    }
    this.append({ t: "harness", kind: "resolved_model", ...next });
    return true;
  }

  /** meta.json as it stands, or null when it is missing or unreadable. */
  private readMetaFile(): RunMeta | null {
    try {
      return JSON.parse(readFileSync(join(this.dir, "meta.json"), "utf8")) as RunMeta;
    } catch {
      return null;
    }
  }

  recordState(runId: string, s: StateLine): void {
    this.append({ t: "state", ...s });
    this.db
      .query(
        `INSERT INTO state (run_id, ts, level, xp, map, x, y, z, event_count, last_seq, money, quests_completed, turn, zone, area, items,
                            health, max_health, power, max_power, power_type, next_level_xp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        runId,
        this.now(),
        s.level ?? null,
        s.xp ?? null,
        s.map ?? null,
        s.x ?? null,
        s.y ?? null,
        s.z ?? null,
        s.eventCount ?? null,
        s.lastSeq ?? null,
        s.money ?? null,
        s.questsCompleted ?? null,
        s.turn ?? null,
        s.zone ?? null,
        s.area ?? null,
        s.items === undefined ? null : JSON.stringify(s.items),
        s.health ?? null,
        s.maxHealth ?? null,
        s.power ?? null,
        s.maxPower ?? null,
        s.powerType ?? null,
        s.nextLevelXp ?? null,
      );
  }

  /**
   * The character the run is actually playing (the model names it).
   *
   * The launch config carries only the harness's suggestion, so every reader
   * of "which character was this" — the runs page and the positions feed off
   * `run.character`, and the resume note off `meta.json` — has to be told the
   * name the model chose, once, at the first sight of it in the world.
   * Recorded in all three places because they are read by different processes:
   * a resumed runner reads meta.json before any database is open.
   */
  setCharacter(runId: string, character: string): void {
    this.append({ t: "character", character });
    this.db.query(`UPDATE run SET character = ? WHERE run_id = ?`).run(character, runId);
    const path = join(this.dir, "meta.json");
    try {
      const meta = JSON.parse(readFileSync(path, "utf8")) as RunMeta;
      if (meta.config?.character === character) return;
      const next = { ...meta, config: { ...meta.config, character } };
      writeFileSync(path, `${JSON.stringify(toJsonSafe(next), null, 2)}\n`, "utf8");
    } catch {
      // No meta.json yet (a test harness, a torn write): the database row and
      // the trajectory record still carry the name.
    }
  }

  setTermination(runId: string, reason: TerminationReason, detail?: string): void {
    this.append({ t: "termination", reason, detail });
    this.db
      .query(
        `UPDATE run SET termination_reason = ?, termination_detail = ?, ended_at = ?, pause_reason = NULL
         WHERE run_id = ?`,
      )
      .run(reason, detail ?? null, this.now(), runId);
  }

  /**
   * Record a pause. `episodeElapsedMs` rides on the record when the caller
   * knows it (run.ts does; the drivers pass what their watchdogs say) so the
   * pause line in the trajectory reads as "paused at 41m of 90m".
   *
   * One pause per segment: a row that already carries a `pause_reason` is
   * left as it is and no second record is appended. The signal handler in
   * run.ts writes the pause the instant SIGTERM lands (so a SIGKILL a second
   * later still leaves a verdict), and the driver's own cooperative unwind
   * then reaches the same call — the first write is the verdict, and the
   * pause count `readRunFact` derives from the trajectory stays one per
   * segment. `--resume` clears the row (`clearPause`), so the next segment's
   * pause is recorded again.
   */
  setPause(runId: string, reason: PauseReason, detail?: string, episodeElapsedMs?: number): boolean {
    const row = this.db.query(`SELECT pause_reason FROM run WHERE run_id = ?`).get(runId) as { pause_reason?: unknown } | null;
    if (row !== null && typeof row.pause_reason === "string" && row.pause_reason !== "") return false;
    this.append({ t: "pause", reason, detail, ...(episodeElapsedMs !== undefined ? { episodeElapsedMs } : {}) });
    this.db.query(`UPDATE run SET pause_reason = ? WHERE run_id = ?`).run(reason, runId);
    return true;
  }

  /**
   * The pause and its meta.json mark, together and once per segment: when the
   * row already carries a pause, NOTHING is written — not the record, not the
   * row, and not the mark. A run that paused on its provider and is then
   * stopped keeps that pause's reason and its instant (`at`), which is what
   * the resume cadence counts from. `meta` is the run's meta as it stands.
   */
  pauseWithMark(runId: string, mark: PauseMark, meta: RunMeta): boolean {
    if (!this.setPause(runId, mark.reason, mark.detail, mark.episodeElapsedMs)) return false;
    this.writeMeta({ ...meta, pause: mark });
    return true;
  }

  clearPause(runId: string): void {
    this.db.query(`UPDATE run SET pause_reason = NULL WHERE run_id = ?`).run(runId);
  }

  runRow(runId: string): Record<string, unknown> | null {
    return this.db.query(`SELECT * FROM run WHERE run_id = ?`).get(runId) as Record<
      string,
      unknown
    > | null;
  }

  /**
   * The highest turn this run has already recorded, or 0.
   *
   * Read on `--resume` so the recorded turn series keeps climbing across a
   * restart. A run whose rows predate the column answers 0, which is the same
   * answer a fresh run gives — a resumed old run then records turns from 1 and
   * its series is visibly non-monotonic, which the eval side treats as "no
   * usable turn index" rather than as a fast run.
   */
  maxTurn(runId: string): number {
    try {
      const r = this.db
        .query(`SELECT MAX(turn) AS t FROM state WHERE run_id = ?`)
        .get(runId) as { t?: unknown } | null;
      return typeof r?.t === "number" ? r.t : 0;
    } catch {
      return 0;
    }
  }

  /**
   * The most recent state sample this run recorded, or null. Read on
   * `--resume` so the resumed session note can tell the model where its
   * character was left (the character survives a pause, so the note has to
   * name it).
   */
  lastState(runId: string): { level?: number; xp?: number } | null {
    try {
      const r = this.db
        .query(`SELECT level, xp FROM state WHERE run_id = ? ORDER BY ts DESC LIMIT 1`)
        .get(runId) as { level?: unknown; xp?: unknown } | null;
      if (r === null) return null;
      return {
        ...(typeof r.level === "number" ? { level: r.level } : {}),
        ...(typeof r.xp === "number" ? { xp: r.xp } : {}),
      };
    } catch {
      return null;
    }
  }

  stateRows(runId: string): Record<string, unknown>[] {
    return this.db
      .query(`SELECT * FROM state WHERE run_id = ? ORDER BY ts`)
      .all(runId) as Record<string, unknown>[];
  }

  close(): void {
    this.db.close();
  }
}

/** Read every record of a trajectory file. Bad lines surface, not vanish. */
export function readTrajectory(dir: string): TrajectoryRecord[] {
  const path = join(dir, "trajectory.jsonl");
  if (!existsSync(path)) return [];
  const out: TrajectoryRecord[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      out.push(JSON.parse(line) as TrajectoryRecord);
    } catch {
      out.push({ t: "unparseable-line", ts: 0, line });
    }
  }
  return out;
}

export function readMeta(dir: string): RunMeta | null {
  const path = join(dir, "meta.json");
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as RunMeta;
}

// ------------------------------------------------------------- heartbeat
//
// The proof that a run has a live owner. A trajectory's mtime cannot be that
// proof: a run waiting on a slow provider, or a model in a long reflect, writes
// nothing for as long as its request takes, and the idle watchdog is checked
// between turns, so not even `idleMs` bounds the silence. The runner therefore
// rewrites one small file on a timer for as long as its process exists, and
// removes it on any exit it gets to make. Age is the whole test — never pid
// liveness, because the reader may be on another pod or host, and the run this
// exists for is one whose owner was SIGKILLed: its mark simply goes cold. The
// content (host and pid) is for the operator reading a refusal, nothing else.

export const HEARTBEAT_FILE = "heartbeat";
/** How often a running runner rewrites its heartbeat. */
export const HEARTBEAT_EVERY_MS = 20_000;
/**
 * A heartbeat older than this has no owner: six missed beats, which also
 * absorbs a blocked event loop (a snippet's 30 s ceiling) and clock skew
 * between the pod that wrote it and the pod reading it.
 */
export const HEARTBEAT_DEAD_MS = 120_000;

/** When the run's owner last beat, or null when the run carries no heartbeat. */
export function heartbeatAt(dir: string): number | null {
  try {
    return statSync(join(dir, HEARTBEAT_FILE)).mtimeMs;
  } catch {
    return null;
  }
}

/** Who wrote the heartbeat ("host pid"), for a message; empty when unreadable. */
export function heartbeatOwner(dir: string): string {
  try {
    return readFileSync(join(dir, HEARTBEAT_FILE), "utf8").trim();
  } catch {
    return "";
  }
}

/**
 * Beat now and every `HEARTBEAT_EVERY_MS` until the returned stop is called
 * (or the process exits: the timer is unref'd and never keeps it alive). Stop
 * removes the file, so a clean exit leaves a run anyone may resume at once.
 */
export function startHeartbeat(dir: string, owner: string): () => void {
  const path = join(dir, HEARTBEAT_FILE);
  const beat = (): void => {
    try {
      writeFileSync(path, `${owner}\n`);
    } catch {
      /* a full or read-only disk costs the heartbeat, never the run */
    }
  };
  beat();
  const timer = setInterval(beat, HEARTBEAT_EVERY_MS);
  timer.unref();
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    try {
      rmSync(path, { force: true });
    } catch {
      /* already gone */
    }
  };
}
