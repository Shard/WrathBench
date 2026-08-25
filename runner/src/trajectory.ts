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
 *   scratchpad.md      owned by Scratchpad, lives in the same directory.
 *
 * Redaction: records never carry API keys by construction (headers are never
 * logged), and every string is additionally scrubbed against the secret values
 * registered via `redact()` — belt and braces for a key that leaks into a
 * message body.
 */

import { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
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
   * What the character carries and wears (FOLLOW-UPS 50): names and counts
   * from the state cache's item queries, `equipped` for inventory slots 0-18,
   * carried rows from `state.bag()` across every bag. Omitted when the
   * snapshot had no inventory at all.
   */
  items?: ItemSample[] | undefined;
}

/** One item on a state sample. Client-cache names only, as the HUD shows them. */
export interface ItemSample {
  name: string;
  count: number;
  equipped: boolean;
}

/**
 * A world-state transition the loop noticed between two samples (FOLLOW-UPS
 * 35; ADR-0018). Kinds are additive; derivations (first capital, zone
 * coverage) come later and read these. `from`/`to` carry ids only — never
 * names — so the record stays what the server said, and a rendering choice
 * (which locale, which DBC) never changes a trajectory after the fact.
 */
/**
 * One `{ t: "milestone", ... }` trajectory record (FOLLOW-UPS 35). Kinds are
 * additive and every consumer ignores the ones it does not know, so a new kind
 * never invalidates a run (ADR-0018 rule 3).
 *
 * - `zone` / `area`: a change of `self.zone` / `self.area`, ids only, `from`
 *   absent on the first observation of a process.
 * - `achievement`: one of **our own** earns (ADR-0048). Never another player's:
 *   `SMSG_ACHIEVEMENT_EARNED` is a say-range broadcast.
 * - `achievements_at_login`: the backlog `SMSG_ALL_ACHIEVEMENT_DATA` carried,
 *   written once per process so a resumed run's history is visible without its
 *   past being re-emitted as fresh firsts. Written even when the backlog is
 *   empty — it is the record that says the taps were live for this run, which
 *   is what lets a reader tell "flew nowhere" from "flights were not recorded".
 * - `taxi` / `taxi_landed`: `taxiFlight` on self flipping on after an accepted
 *   reply, and flipping back. The area id is keyed `areaId`, not `id`, so no
 *   consumer can mistake a flight record for a zone/area mark.
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
  | { kind: "taxi_landed"; to?: { areaId: number } | undefined; turn?: number | undefined };

export interface RunMeta {
  runId: string;
  harnessVersion: string;
  startedAt: number;
  config: RunConfig;
  /**
   * Everything that has to match before two runs share a chart: harness
   * version, prompt hash, episode budget, context engine, effort, and whether
   * an operator objective steered the run (ADR-0026). Absent on runs written
   * before the stamp existed, which read as "not recorded" rather than being
   * recomputed against today's prompt.
   */
  comparability?: Comparability;
  /**
   * The unscored stamp (`unscoredStamp` in config.ts): set for a stub run or
   * an operator-objective run. Present in meta.json, in the `shakeout` column
   * of run.sqlite and in the timeline header, so such a run cannot be mistaken
   * for a score. The key keeps its pre-ADR-0035 name because old runs carry
   * it; the harness (`wrathbench` | `claude-code`) is a separate dimension in
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
  -- The operator objective this run was steered with, if any (ADR-0024). Its
  -- own column for the same reason the driver has one: a cross-run SELECT must
  -- be able to exclude steered runs without parsing config_json.
  objective TEXT,
  -- The character this run played and the platform that served the model
  -- (FOLLOW-UPS 36). Both were derivable from config_json and from the api
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
  termination_reason TEXT,
  termination_detail TEXT,
  pause_reason TEXT,
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
  -- Zone and area ids (FOLLOW-UPS 38 N2): where the sample was taken, as the
  -- game's own area ids; names are rendered from the client's DBC, not stored.
  zone INTEGER,
  area INTEGER
);
`;

/**
 * Columns added to `run` inside the 0.4 series (FOLLOW-UPS 36, at 0.4-6).
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
};

/**
 * Columns added to `state` inside the 0.4 series (FOLLOW-UPS 38 N2). Same
 * reason: a resumed run's sqlite predates them, and the insert names them.
 * No compat reads — a sample written before the column existed has NULL.
 */
const STATE_ADDED_COLUMNS: Record<string, string> = {
  zone: "INTEGER",
  area: "INTEGER",
  // JSON `ItemSample[]` (FOLLOW-UPS 50); NULL when the sample carried none.
  items: "TEXT",
};

export class Trajectory {
  readonly dir: string;
  readonly jsonlPath: string;
  private readonly db: Database;
  private readonly secrets: string[] = [];
  private readonly now: () => number;

  constructor(dir: string, opts: { now?: () => number } = {}) {
    this.dir = dir;
    this.now = opts.now ?? Date.now;
    mkdirSync(dir, { recursive: true });
    this.jsonlPath = join(dir, "trajectory.jsonl");
    this.db = new Database(join(dir, "run.sqlite"));
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

  /** One `milestone` record, the way `quest_complete` is written (item 35). */
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
  }

  writeMeta(meta: RunMeta): void {
    const safe = JSON.parse(this.scrub(jsonLine(meta))) as RunMeta;
    writeFileSync(join(this.dir, "meta.json"), `${JSON.stringify(toJsonSafe(safe), null, 2)}\n`, "utf8");
    this.db
      .query(
        `INSERT INTO run (run_id, harness_version, started_at, driver, shakeout, model, objective, character, platform, resolved_model, resolved_cli_version, config_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        this.scrub(jsonLine(meta.config)),
      );
    this.append({ t: "meta", ...meta });
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
    if (model === null && cliVersion === null) return false;
    const meta = this.readMetaFile();
    const have = meta?.resolved;
    const next: ResolvedModel = {
      model: have?.model ?? model,
      cliVersion: have?.cliVersion ?? cliVersion,
    };
    if (have !== undefined && have.model === next.model && have.cliVersion === next.cliVersion) {
      return false;
    }
    try {
      this.db
        .query(`UPDATE run SET resolved_model = ?, resolved_cli_version = ? WHERE run_id = ?`)
        .run(next.model, next.cliVersion, runId);
    } catch {
      /* a run.sqlite that cannot take the update must not end the episode */
    }
    if (meta !== null) {
      /*
       * The tuple carries the same answer as an annotation (ADR-0033
       * amendment), so a reader that already parses comparability does not need
       * a second lookup. It is excluded from `sameComparability`, which is why
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
        `INSERT INTO state (run_id, ts, level, xp, map, x, y, z, event_count, last_seq, money, quests_completed, turn, zone, area, items)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      );
  }

  /**
   * The character the run is actually playing (ADR-0050: the model names it).
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
   */
  setPause(runId: string, reason: PauseReason, detail?: string, episodeElapsedMs?: number): void {
    this.append({ t: "pause", reason, detail, ...(episodeElapsedMs !== undefined ? { episodeElapsedMs } : {}) });
    this.db.query(`UPDATE run SET pause_reason = ? WHERE run_id = ?`).run(reason, runId);
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
   * character was left (ADR-0036: the character survives a pause, so the note
   * has to name it).
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
