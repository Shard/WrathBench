/**
 * The viewer's read path over the derived store.
 *
 * Every listing route used to open all 1,148 `run.sqlite` files and re-read
 * every trajectory to count what the page showed. It reads rows from here
 * instead. What the store is and why is docs/ARCHITECTURE.md ("The derived
 * store"); how it is filled is `collector/README.md`.
 *
 * The seam is deliberately at **"fetch me these rows"**, not at "answer this
 * question". A store that answered questions would be a second implementation
 * of every derivation the viewer already has, free to disagree with the first
 * about a published number — which is exactly what `run_totals` exists to
 * avoid. So `RunStore` returns table rows, one mapping layer below turns them
 * into the `RunRow` / `RunTotals` / `RunFact` / `StatePoint` the rest of the
 * viewer already speaks, and there is one such mapping however many stores
 * exist.
 *
 * Two implementations, and the second is not a mock:
 *
 * - `clickhouseStore` reads ClickHouse over HTTP. What every deployment uses.
 * - `localRunStore` runs *the collector itself* over a runs directory into
 *   memory. It is what a bare clone, a test and `bun run viewer` with no
 *   ClickHouse configured get, and it goes through the same ingestion code the
 *   real store is filled by — so the two cannot drift in what a row means.
 *   It keeps only the four tables a read path needs — `runs`, `run_totals`,
 *   `states`, `moves` — and drops `turns`, `events`, `milestones` and
 *   `episodic` as they arrive, which is what makes holding a corpus in memory
 *   sane at all.
 *
 * Only aggregates are ever pushed into SQL — the latest reading per run, and
 * nothing else. Every ordering-sensitive derivation was computed once, by the
 * viewer's own code, when the collector tailed the file.
 */

import type { ComparabilityView, ItemSample, MoveIntentView, RunRow, StateItemsRow, StatePoint } from "./api-types";
import { characterLabel, className, raceName } from "./characters";
import { harnessOfRun, parseComparability } from "../src/index";
import { platformOf } from "../src/platform";
import type { RunFact } from "../src/models";
import type { RunTotals } from "./tail";
import { LIVE_WINDOW_MS, itemSamplesOf } from "./runs";

// ------------------------------------------------------------- the row shapes

/** `wrathbench.runs`, as JSON comes back from ClickHouse. */
export interface RunTableRow {
  run_id: string;
  archived: number;
  harness_version: string;
  started_at: number;
  ended_at: number | null;
  driver: string;
  shakeout: string;
  model: string;
  objective: string;
  character: string;
  platform: string;
  resolved_model: string;
  resolved_cli_version: string;
  continued_from: string;
  termination_reason: string;
  termination_detail: string;
  pause_reason: string;
  reflecting_since: number | null;
  config_json: string;
  comparability_json: string;
  meta_json: string;
  trajectory_bytes: number;
  trajectory_mtime: number;
  ingested_at: number;
}

/** `wrathbench.run_totals`. Both columns are whole objects, as JSON. */
export interface TotalsTableRow {
  run_id: string;
  totals_json: string;
  fact_json: string;
  trajectory_bytes: number;
  ingested_at: number;
}

export interface StateTableRow {
  run_id: string;
  seq: number;
  ts: number;
  level: number | null;
  xp: number | null;
  map: number | null;
  x: number | null;
  y: number | null;
  z: number | null;
  event_count: number | null;
  last_seq: number | null;
  money: number | null;
  quests_completed: number | null;
  turn: number | null;
  zone: number | null;
  area: number | null;
  health: number | null;
  max_health: number | null;
  power: number | null;
  max_power: number | null;
  power_type: number | null;
  next_level_xp: number | null;
  items: string;
}

/**
 * A `states` row without `items`.
 *
 * `items` is the one large column in the table — the whole inventory as JSON,
 * per sample — and the only thing that reads it is the latest-reading
 * aggregate. Every other read path maps rows through `statePointOf`, which
 * never touches it, so those reads ask for these columns by name. Selecting
 * `*` instead was what made a listing pull ~25 MiB per run and tip ClickHouse
 * over its memory limit (2026-09-17).
 */
export type StatePointRow = Omit<StateTableRow, "items">;

/**
 * The column list for `StatePointRow`, hand-written because the read paths no
 * longer say `SELECT *`. A new column in `wrathbench.states`
 * (`collector/schema.sql`) has to be added here too, or nothing will see it.
 */
const STATE_POINT_COLUMNS = [
  "run_id",
  "seq",
  "ts",
  "level",
  "xp",
  "map",
  "x",
  "y",
  "z",
  "event_count",
  "last_seq",
  "money",
  "quests_completed",
  "turn",
  "zone",
  "area",
  "health",
  "max_health",
  "power",
  "max_power",
  "power_type",
  "next_level_xp",
].join(", ");

/** Rows of one run, oldest first — the order every caller of a state series wants. */
function byTsSeq(a: { ts: number; seq: number }, b: { ts: number; seq: number }): number {
  return a.ts - b.ts || a.seq - b.seq;
}

export interface MoveTableRow {
  run_id: string;
  seq: number;
  ts: number;
  move_id: number | null;
  map: number | null;
  x: number | null;
  y: number | null;
  z: number | null;
  target: string;
  status: string;
}

/**
 * The newest reading of each signal a listing shows, per run.
 *
 * The one thing pushed into SQL, because it is the one thing a listing needs
 * that would otherwise mean fetching a million state rows. `level` and `xp`
 * come off the *same* sample — the newest with a real level — the way
 * `readRun` reads them; `money` and `questsCompleted` are each the newest
 * sample that carried a value, because zero is a real reading and only NULL
 * means "nothing recorded".
 */
export interface LatestState {
  level: number | null;
  xp: number | null;
  money: number | null;
  questsCompleted: number | null;
  items: string;
}

export interface RunStore {
  /** Every run, archived ones included; the caller filters. */
  runRows(): Promise<RunTableRow[]>;
  runRow(runId: string): Promise<RunTableRow | null>;
  totalsRows(): Promise<TotalsTableRow[]>;
  totalsRow(runId: string): Promise<TotalsTableRow | null>;
  latestStates(): Promise<Map<string, LatestState>>;
  /** The latest readings of one run, or undefined when it has no state rows yet. */
  latestState(runId: string): Promise<LatestState | undefined>;
  stateRows(runId: string): Promise<StatePointRow[]>;
  /**
   * One run's `items` column, oldest first, samples that carried none left out.
   *
   * Its own call rather than a column on `stateRows`, deliberately: `items` is
   * the large column, `stateRowsByRun` shares that column list, and asking for
   * it across a listing is what ran the server out of memory (2026-09-17). One
   * run's inventory history, for the one page that replays it, is bounded.
   */
  stateItemRows(runId: string): Promise<StateItemsRow[]>;
  /**
   * The state series of many runs in **one** query.
   *
   * What a listing needs: `/api/results` and `/api/ladder` project every run's
   * series, and doing that a run at a time was ~700 sequential queries per
   * request. Runs with no state rows are simply absent from the map.
   */
  stateRowsByRun(runIds: readonly string[]): Promise<Map<string, StatePointRow[]>>;
  moveRows(runId: string): Promise<MoveTableRow[]>;
}

// ------------------------------------------------------------- the ClickHouse

export interface ClickhouseConfig {
  url: string;
  user: string;
  password: string;
  database: string;
}

/**
 * The store's coordinates, or null when none are configured.
 *
 * Null is a first-class answer, not a failure: a bare clone, a test and a
 * one-shot render all run without ClickHouse, and `localRunStore` serves them.
 */
export function clickhouseConfigFromEnv(env: Record<string, string | undefined> = process.env): ClickhouseConfig | null {
  const url = env["CLICKHOUSE_URL"];
  if (url === undefined || url.length === 0) return null;
  return {
    url: url.replace(/\/+$/, ""),
    user: env["CLICKHOUSE_USER"] ?? "default",
    password: env["CLICKHOUSE_PASSWORD"] ?? "",
    database: env["CLICKHOUSE_DATABASE"] ?? "wrathbench",
  };
}

/** SQL string literal. Run ids are validated upstream; this is belt and braces. */
function lit(s: string): string {
  return `'${s.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

/**
 * Every table is `ReplacingMergeTree` and merges are asynchronous, so a read
 * that has to be exact says `FINAL`. Nothing here is hot enough for the cost
 * to matter: a listing is one query, and the corpus is a hundred megabytes of
 * parts.
 */
export function clickhouseStore(cfg: ClickhouseConfig): RunStore {
  const headers: Record<string, string> = {
    "content-type": "text/plain; charset=utf-8",
    "x-clickhouse-user": cfg.user,
  };
  if (cfg.password.length > 0) headers["x-clickhouse-key"] = cfg.password;

  async function rows<T>(sql: string): Promise<T[]> {
    const url = new URL(cfg.url);
    url.searchParams.set("database", cfg.database);
    url.searchParams.set("default_format", "JSON");
    // Without this, ClickHouse quotes every Int64 as a string and every
    // timestamp in this store would arrive as `"1788581524274"`.
    url.searchParams.set("output_format_json_quote_64bit_integers", "0");
    const res = await fetch(url, { method: "POST", headers, body: sql });
    const text = await res.text();
    if (!res.ok) throw new Error(clickhouseErrorMessage(res.status, text));
    const body = JSON.parse(text) as { data?: unknown };
    return Array.isArray(body.data) ? (body.data as T[]) : [];
  }

  const latestSql = (where: string): string => `
    SELECT run_id,
           argMaxIf(level, (ts, seq), level > 0)                                AS v_level,
           argMaxIf(xp, (ts, seq), level > 0)                                   AS v_xp,
           argMaxIf(money, (ts, seq), money IS NOT NULL)                        AS v_money,
           argMaxIf(quests_completed, (ts, seq), quests_completed IS NOT NULL)  AS v_quests,
           argMaxIf(items, (ts, seq), items != '')                              AS v_items
      FROM states FINAL
     ${where}
     GROUP BY run_id`;
  const LATEST = latestSql("");
  /*
   * The aliases are prefixed because ClickHouse resolves a bare `AS level`
   * back into the condition beside it and refuses the query as an aggregate
   * inside an aggregate. Nothing subtler than that is going on.
   */

  type LatestRow = {
    run_id: string;
    v_level: number | null;
    v_xp: number | null;
    v_money: number | null;
    v_quests: number | null;
    v_items: string | null;
  };
  const latestOf = (r: LatestRow): LatestState => ({
    level: r.v_level,
    xp: r.v_xp,
    money: r.v_money,
    questsCompleted: r.v_quests,
    items: r.v_items ?? "",
  });

  return {
    runRows: () => rows<RunTableRow>(`SELECT * FROM runs FINAL`),
    async runRow(runId) {
      const r = await rows<RunTableRow>(`SELECT * FROM runs FINAL WHERE run_id = ${lit(runId)}`);
      return r[0] ?? null;
    },
    totalsRows: () => rows<TotalsTableRow>(`SELECT * FROM run_totals FINAL`),
    async totalsRow(runId) {
      const r = await rows<TotalsTableRow>(`SELECT * FROM run_totals FINAL WHERE run_id = ${lit(runId)}`);
      return r[0] ?? null;
    },
    async latestStates() {
      const out = new Map<string, LatestState>();
      for (const r of await rows<LatestRow>(LATEST)) out.set(r.run_id, latestOf(r));
      return out;
    },
    /*
     * One run's latest readings as the same aggregate, not as every row of the
     * run mapped in memory: the run page wants five values and `items` is the
     * only large column in the table.
     */
    async latestState(runId) {
      const r = await rows<LatestRow>(latestSql(`WHERE run_id = ${lit(runId)}`));
      return r[0] === undefined ? undefined : latestOf(r[0]);
    },
    async stateRows(runId) {
      const r = await rows<StatePointRow>(
        `SELECT ${STATE_POINT_COLUMNS} FROM states FINAL WHERE run_id = ${lit(runId)}`,
      );
      return r.sort(byTsSeq);
    },
    async stateItemRows(runId) {
      const r = await rows<StateItemsRow>(
        `SELECT ts, seq, items FROM states FINAL WHERE run_id = ${lit(runId)} AND items != ''`,
      );
      return r.sort(byTsSeq);
    },
    /*
     * One query for the whole listing, and no `ORDER BY`: the grouping happens
     * in memory anyway, `FINAL` can defeat a read-in-order plan, and a
     * blocking sort over every state row of the corpus is exactly the shape
     * that ran the server out of memory. The `IN` list is written out rather
     * than replaced by an unfiltered scan so the query never reads runs the
     * caller has already filtered away (archived ones, mostly).
     */
    async stateRowsByRun(runIds) {
      const out = new Map<string, StatePointRow[]>();
      if (runIds.length === 0) return out;
      const ids = runIds.map(lit).join(", ");
      const r = await rows<StatePointRow>(
        `SELECT ${STATE_POINT_COLUMNS} FROM states FINAL WHERE run_id IN (${ids})`,
      );
      for (const row of r) {
        const bucket = out.get(row.run_id);
        if (bucket === undefined) out.set(row.run_id, [row]);
        else bucket.push(row);
      }
      for (const bucket of out.values()) bucket.sort(byTsSeq);
      return out;
    },
    moveRows: (runId) =>
      rows<MoveTableRow>(`SELECT * FROM moves FINAL WHERE run_id = ${lit(runId)} ORDER BY ts, seq`),
  };
}

/**
 * What a failed ClickHouse response actually said.
 *
 * The body of a failed query is usually a JSON envelope whose `meta` block
 * comes first, so slicing the first 400 characters showed the column list and
 * hid the exception — on 2026-09-17 that turned a plain memory-limit abort
 * into a query_log dig. A memory abort can also come mid-stream, after `meta`
 * and part of `data` have been flushed, which leaves the body invalid JSON
 * with the exception appended; hence the regex fallback. A pre-execution
 * failure is plain text with no JSON at all, which is the last branch.
 */
export function clickhouseErrorMessage(status: number, body: string): string {
  const say = (s: string): string => `clickhouse ${status}: ${s.slice(0, 400)}`;
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === "object" && parsed !== null) {
      const ex = (parsed as { exception?: unknown }).exception;
      if (typeof ex === "string" && ex.length > 0) return say(ex);
    }
  } catch {
    const m = /"exception"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(body);
    if (m?.[1] !== undefined) {
      try {
        return say(JSON.parse(`"${m[1]}"`) as string);
      } catch {
        return say(m[1]);
      }
    }
  }
  return say(body);
}

// ----------------------------------------------------------------- the mapping

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function parse(text: string): Record<string, unknown> | null {
  if (text.length === 0) return null;
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** `items` as `readRun` shape-checks it — the same function, so the two agree. */
const itemsOf = itemSamplesOf;

/**
 * A stored run row as the viewer's `RunRow`.
 *
 * Field for field the same merge `readRun` made from meta.json and the
 * `run` table — the collector did the merge once, at ingestion, in the same
 * order — plus the two things only a file could answer before: liveness, from
 * the trajectory mtime the collector recorded, and the newest state readings,
 * from `latest`.
 */
export function runRowOf(r: RunTableRow, latest: LatestState | undefined, now: number): RunRow {
  const meta = parse(r.meta_json);
  const config = (meta?.["config"] as Record<string, unknown> | undefined) ?? parse(r.config_json) ?? {};
  const comparability = parseComparability(
    r.comparability_json.length === 0 ? undefined : JSON.parse(r.comparability_json),
  ) as ComparabilityView | null;
  const race = num(config["race"]);
  const klass = num(config["class"]);
  const apiBase = str(config["apiBase"]);
  const driver = str(r.driver);
  const mtime = r.trajectory_mtime === 0 ? null : r.trajectory_mtime;
  const terminationReason = str(r.termination_reason);
  const row: RunRow = {
    runId: r.run_id,
    model: str(r.model),
    driver,
    harness: harnessOfRun({ comparability, driver }),
    shakeout: str(r.shakeout),
    // Campaign, cell and extra live only in the launch config; no column ever
    // carried them and `readRun` read them from meta.json exactly here.
    objective: str(r.objective),
    campaign: str(config["campaign"]),
    cell: str(config["cell"]),
    extra: config["extra"] === true,
    comparability,
    character: str(r.character),
    race,
    raceName: raceName(race),
    class: klass,
    className: className(klass),
    characterLabel: characterLabel(race, klass),
    // The stamped column wins; a run that predates it is derived the same way.
    platform: str(r.platform) ?? platformOf(apiBase, driver),
    resolvedModel: str(r.resolved_model),
    cliVersion: str(r.resolved_cli_version),
    apiBase,
    harnessVersion: str(r.harness_version),
    startedAt: r.started_at === 0 ? null : r.started_at,
    endedAt: num(r.ended_at),
    terminationReason,
    terminationDetail: str(r.termination_detail),
    pauseReason: str(r.pause_reason),
    continuedFrom: str(r.continued_from),
    level: latest?.level ?? null,
    xp: latest?.xp ?? null,
    money: latest?.money ?? null,
    questsCompleted: latest?.questsCompleted ?? null,
    items: latest === undefined ? null : itemsOf(latest.items),
    mtime,
    bytes: r.trajectory_bytes === 0 ? null : r.trajectory_bytes,
    live: terminationReason === null && mtime !== null && now - mtime < LIVE_WINDOW_MS,
  };
  return row;
}

export function totalsOf(r: TotalsTableRow | undefined | null): RunTotals | null {
  if (r === undefined || r === null || r.totals_json.length === 0) return null;
  try {
    return JSON.parse(r.totals_json) as RunTotals;
  } catch {
    return null;
  }
}

/**
 * The stored fact, with liveness re-decided against this `now`.
 *
 * `RunFact.live` and `RunRow.live` are deliberately different rules — a fact
 * is not live while the run is paused, a row is — and both are re-decided at
 * read time rather than replayed, because a stored `true` would be a claim
 * about a process that stopped writing hours ago.
 */
export function factOf(r: TotalsTableRow | undefined | null, mtime: number | null, now: number): RunFact | null {
  if (r === undefined || r === null || r.fact_json.length === 0) return null;
  let fact: RunFact;
  try {
    fact = JSON.parse(r.fact_json) as RunFact;
  } catch {
    return null;
  }
  fact.live =
    fact.terminationReason === null && fact.pause === null && mtime !== null && now - mtime < LIVE_WINDOW_MS;
  if (!fact.live && fact.endedAt === null) fact.endedAt = mtime;
  return fact;
}

export function statePointOf(r: StatePointRow): StatePoint {
  return {
    ts: r.ts,
    level: r.level,
    xp: r.xp,
    map: r.map,
    x: r.x,
    y: r.y,
    z: r.z,
    eventCount: r.event_count,
    lastSeq: r.last_seq,
    turn: r.turn,
    health: r.health,
    maxHealth: r.max_health,
    power: r.power,
    maxPower: r.max_power,
    powerType: r.power_type,
    nextLevelXp: r.next_level_xp,
  };
}

/** A move with no usable position is dropped, as `readMoves` drops it. */
export function moveViewsOf(rows: readonly MoveTableRow[]): MoveIntentView[] {
  const out: MoveIntentView[] = [];
  for (const r of rows) {
    if (r.x === null || r.y === null || r.z === null) continue;
    out.push({
      ts: r.ts,
      map: r.map,
      x: r.x,
      y: r.y,
      z: r.z,
      target: r.target.length === 0 ? null : r.target,
      status: r.status.length === 0 ? null : r.status,
    });
  }
  return out;
}

// -------------------------------------------------------------- the local one

/**
 * The same store, built in memory by running the collector over a runs
 * directory.
 *
 * Not a mock. It is the collector's own ingestion, so a row here means what a
 * row in ClickHouse means, and a change to what the collector writes changes
 * both at once. Of the eight tables the collector writes, only `runs`,
 * `run_totals`, `states` and `moves` are kept; `turns`, `events`, `milestones`
 * and `episodic` are dropped as they arrive — the read path never reads them
 * and keeping them would mean holding the corpus.
 *
 * Every call refreshes first — a pass over an unchanged tree is four `stat`s
 * per run and nothing else, which is what makes a live run's row current
 * without a cache to be wrong about. Concurrent calls share the one pass in
 * flight rather than each starting their own.
 */
export function localRunStore(runsDir: string): RunStore {
  // Imported lazily: the viewer's own bundle has no reason to pull the
  // collector in when a real store is configured.
  const kept = new Set(["runs", "run_totals", "states", "moves"]);
  const tables = new Map<string, Map<string, Record<string, unknown>>>();
  let collector: { pass: () => Promise<unknown> } | null = null;

  // The separator is written as an escape rather than as a literal NUL byte:
  // the value is the same at runtime, but a source file carrying one reads as
  // binary to `file(1)`, and grep and ripgrep then skip it silently — a
  // repo-wide sweep for an identifier would quietly miss every hit in here.
  const key = (table: string, row: Record<string, unknown>): string => {
    const id = String(row["run_id"]);
    if (table === "runs" || table === "run_totals") return id;
    return `${id}\u0000${String(row["ts"])}\u0000${String(row["seq"])}`;
  };

  const sink = {
    async insert(table: string, rows: readonly unknown[]): Promise<void> {
      if (!kept.has(table)) return;
      const bucket = tables.get(table) ?? new Map<string, Record<string, unknown>>();
      for (const raw of rows) {
        const row = raw as Record<string, unknown>;
        // Last write wins, which is what ReplacingMergeTree(ingested_at) does.
        bucket.set(key(table, row), row);
      }
      tables.set(table, bucket);
    },
    async exec(): Promise<void> {
      /* no schema to apply in memory */
    },
  };

  /**
   * The pass in flight, if any.
   *
   * Without it, `Promise.all([runRows(), latestStates()])` — which is what one
   * `/api/runs` does — both see `collector === null`, build two collectors over
   * one sink, and run two full `RunTotalsScanner` passes over every trajectory
   * in the tree. Right rows, twice the work, and on the operator's own corpus
   * that is the difference between a slow first request and two.
   */
  let pending: Promise<void> | null = null;

  async function pass(): Promise<void> {
    if (collector === null) {
      const [{ Collector }, { readConfig }, { OffsetStore }] = await Promise.all([
        import("../../collector/src/collector"),
        import("../../collector/src/config"),
        import("../../collector/src/offsets"),
      ]);
      collector = new Collector({
        cfg: readConfig({ runsDir, stateDb: ":memory:" }),
        sink,
        offsets: new OffsetStore(":memory:"),
        log: () => {},
      });
    }
    await collector.pass();
  }

  function refresh(): Promise<void> {
    pending ??= pass().finally(() => {
      pending = null;
    });
    return pending;
  }

  const all = <T>(table: string): T[] => [...(tables.get(table)?.values() ?? [])] as T[];

  return {
    async runRows() {
      await refresh();
      return all<RunTableRow>("runs");
    },
    async runRow(runId) {
      await refresh();
      return (tables.get("runs")?.get(runId) as RunTableRow | undefined) ?? null;
    },
    async totalsRows() {
      await refresh();
      return all<TotalsTableRow>("run_totals");
    },
    async totalsRow(runId) {
      await refresh();
      return (tables.get("run_totals")?.get(runId) as TotalsTableRow | undefined) ?? null;
    },
    async latestStates() {
      await refresh();
      return latestStatesOf(all<StateTableRow>("states"));
    },
    async latestState(runId) {
      await refresh();
      return latestStatesOf(all<StateTableRow>("states").filter((r) => r.run_id === runId)).get(runId);
    },
    async stateRows(runId) {
      await refresh();
      return all<StateTableRow>("states")
        .filter((r) => r.run_id === runId)
        .sort(byTsSeq);
    },
    async stateItemRows(runId) {
      await refresh();
      return all<StateTableRow>("states")
        .filter((r) => r.run_id === runId && r.items.length > 0)
        .map((r) => ({ ts: r.ts, seq: r.seq, items: r.items }))
        .sort(byTsSeq);
    },
    async stateRowsByRun(runIds) {
      await refresh();
      const want = new Set(runIds);
      const out = new Map<string, StatePointRow[]>();
      for (const row of all<StateTableRow>("states")) {
        if (!want.has(row.run_id)) continue;
        const bucket = out.get(row.run_id);
        if (bucket === undefined) out.set(row.run_id, [row]);
        else bucket.push(row);
      }
      for (const bucket of out.values()) bucket.sort(byTsSeq);
      return out;
    },
    async moveRows(runId) {
      await refresh();
      return all<MoveTableRow>("moves")
        .filter((r) => r.run_id === runId)
        .sort(byTsSeq);
    },
  };
}

/**
 * The in-memory twin of the `latestStates` query. Same rule, stated once in
 * SQL and once here; `runner/test/viewer-clickhouse.test.ts` pins them equal
 * against the same rows.
 */
export function latestStatesOf(rows: readonly StateTableRow[]): Map<string, LatestState> {
  const out = new Map<string, LatestState>();
  /*
   * The ordering key is `(ts, seq)`, not `ts` alone, and the SQL above says
   * the same. Two samples can land in one millisecond, and a rule that broke
   * that tie by accident — by insertion order, or by whatever a scan happened
   * to reach first — would be a number nobody could reproduce. `seq` is the
   * sqlite rowid, so the later-written sample wins, which is what "latest"
   * ought to mean.
   */
  const at = new Map<string, { level: number; money: number; quests: number; items: number }>();
  const after = (ts: number, seq: number, mark: number): boolean => ts * 1e6 + seq >= mark;
  const mark = (ts: number, seq: number): number => ts * 1e6 + seq;
  for (const r of rows) {
    const cur = out.get(r.run_id) ?? { level: null, xp: null, money: null, questsCompleted: null, items: "" };
    const seen = at.get(r.run_id) ?? { level: -1, money: -1, quests: -1, items: -1 };
    if (r.level !== null && r.level > 0 && after(r.ts, r.seq, seen.level)) {
      cur.level = r.level;
      // xp rides on the same sample, the way `readRun` reads the pair.
      cur.xp = r.xp;
      seen.level = mark(r.ts, r.seq);
    }
    if (r.money !== null && after(r.ts, r.seq, seen.money)) {
      cur.money = r.money;
      seen.money = mark(r.ts, r.seq);
    }
    if (r.quests_completed !== null && after(r.ts, r.seq, seen.quests)) {
      cur.questsCompleted = r.quests_completed;
      seen.quests = mark(r.ts, r.seq);
    }
    if (r.items.length > 0 && after(r.ts, r.seq, seen.items)) {
      cur.items = r.items;
      seen.items = mark(r.ts, r.seq);
    }
    out.set(r.run_id, cur);
    at.set(r.run_id, seen);
  }
  return out;
}

/**
 * The store a handle should use: ClickHouse when it is configured, the local
 * one otherwise. One place decides, so the viewer, the snapshot renderer and
 * the publisher cannot disagree about which store they are on.
 */
export function storeFor(runsDir: string, cfg: ClickhouseConfig | null = clickhouseConfigFromEnv()): RunStore {
  return cfg === null ? localRunStore(runsDir) : clickhouseStore(cfg);
}
