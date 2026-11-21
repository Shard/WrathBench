/**
 * Read-only view over `data/runs/`. Nothing here ever writes. A v1 run is read
 * off meta.json and its session record (`runner/src/run-reader.ts`); a 0.5
 * run's `run.sqlite` is opened readonly, so an old run dir never gains a
 * schema it did not have.
 *
 * This is no longer the viewer's listing path. `/api/runs`, `/api/results`,
 * `/api/models` and the run page read the derived store instead
 * (`runner/viewer/clickhouse.ts`), which is why the memoisation that used to live at the
 * bottom of this file is gone: a query is not a thousand file opens, and a
 * cache in front of one would only be a second thing that can be wrong about a
 * live run. What still reads files directly, and must, is everything that asks
 * about a process writing *right now*: the fleet supervisor's own polling
 * (`runner/src/archive.ts`), the account ledger on `/api/fleet`, and the live
 * map (`runner/viewer/positions.ts`).
 *
 * All three prefilter: the first two to the handful of runs whose files moved
 * inside their window, the live map to the runs the derived store lists as
 * unterminated (`positionsFromStore`). What the map still opens per poll is
 * one small file per such run (a v1 run's `live.json`, a 0.5 run's
 * `run.sqlite`), because its whole subject is where a character is *this
 * second* and the store's state series is a five-second poll behind.
 *
 * The runner's own, not the viewer's: the archive CLI and the collector read
 * it, and neither imports the viewer. The viewer's per-run series readers
 * (`runner/viewer/runs.ts`) read beside it.
 */

import { isTaskEpisode } from "./episodes";
import type { Database } from "bun:sqlite";
import { openRunDb } from "./rundb";
import { holdsOnlyLaunchFiles } from "./launch-files";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ItemSample } from "@wrathbench/inspector/wire";
import type { ComparabilityView, RunRow } from "./run-types";
import { fanoutLead, fanoutReadings, isFanoutRunDir, isV1RunDir, latestReading, readRunRow } from "./run-reader";
import { characterLabel, className, raceName } from "./characters";
import { isArchiveDir } from "./archive-dir";
import { bareSessionDir, isBareSessionDir, isBareSessionId, sessionStoreOf } from "./session-store";
import { harnessOfRun, parseComparability } from "./comparability";
import { runCredentialOf } from "./credential-slots";
import { platformOf } from "./platform";

/**
 * A run counts as live when it has not terminated and its trajectory grew
 * recently. "No termination reason" alone is not enough — a killed process
 * leaves none — and a stale mtime is the only signal we have from outside the
 * container.
 */
export const LIVE_WINDOW_MS = 120_000;

const RUN_ID = /^[A-Za-z0-9._-]+$/;

/** Guard against `..` and anything that would leave the runs directory. */
export function isValidRunId(id: string): boolean {
  return RUN_ID.test(id) && id !== "." && id !== "..";
}

/**
 * A run's directory, or null when there is none by that id. A bare session's
 * viewer id resolves into the session store read beside this runs directory
 * (`runner/src/session-store.ts`), when one is and no run directory has the
 * same name.
 */
export function runDir(runsDir: string, runId: string): string | null {
  if (!isValidRunId(runId)) return null;
  // `archive` is a directory of runs, not a run; the viewer never reads inside it.
  if (isArchiveDir(runId)) return null;
  const dir = join(runsDir, runId);
  if (existsSync(dir) && statSync(dir).isDirectory()) return dir;
  const store = isBareSessionId(runId) ? sessionStoreOf(runsDir) : null;
  return store === null ? null : bareSessionDir(store, runId);
}

/** `runDir`, or the path a run of that id would have: for the readers that read a missing run as empty. */
export function runPath(runsDir: string, runId: string): string {
  return runDir(runsDir, runId) ?? join(runsDir, runId);
}

export function openReadonly(dir: string): Database | null {
  const path = join(dir, "run.sqlite");
  if (!existsSync(path)) return null;
  try {
    return openRunDb(path, { readonly: true });
  } catch {
    return null;
  }
}

interface MetaShape {
  runId?: string;
  harnessVersion?: string;
  startedAt?: number;
  shakeout?: string;
  comparability?: unknown;
  resolved?: { model?: unknown; cliVersion?: unknown };
  config?: {
    model?: string;
    extra?: boolean;
    driver?: string;
    character?: string;
    race?: number;
    class?: number;
    /** The model chooses its start (`RunConfig.chooseStart`). */
    chooseStart?: boolean;
    apiBase?: string;
    billing?: string;
    objective?: string;
    campaign?: string;
    cell?: string;
    campaignVersion?: number;
    continuedFrom?: string;
    world?: string;
  };
}

/**
 * A run's campaign stamps, off its launch config: the campaign, cell and
 * version, the arm, the roster name it was launched as, and the image a run
 * pod was asked for. Read as recorded and never inferred — a run from before a
 * stamp existed simply has none. One helper for both row builders (this
 * file's and the store's `runRowOf`), so the two listings cannot read a run
 * differently.
 */
export function campaignFieldsOf(
  config: Readonly<Record<string, unknown>> | null | undefined,
): Pick<RunRow, "campaign" | "cell" | "campaignVersion" | "arm" | "ref" | "image" | "party"> {
  const s = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
  const campaign = s(config?.["campaign"]);
  const version = config?.["campaignVersion"];
  const p = config?.["party"] as { id?: unknown; member?: unknown; size?: unknown; role?: unknown; members?: unknown } | null | undefined;
  // A party is a campaign's square, or a scored Deadmines attempt (`isTaskEpisode`).
  const partied = campaign !== null || (typeof config?.["episode"] === "string" && isTaskEpisode(config["episode"]));
  const party =
    partied && p !== null && typeof p === "object" && s(p.id) !== null && s(p.member) !== null && typeof p.size === "number"
      ? { id: s(p.id)!, member: s(p.member)!, size: p.size, ...partyPlaceOf(p.role, p.members, s(p.member)!) }
      : null;
  return {
    campaign,
    cell: campaign === null ? null : s(config?.["cell"]),
    campaignVersion: campaign !== null && typeof version === "number" && Number.isInteger(version) ? version : null,
    arm: campaign === null ? null : s(config?.["arm"]),
    ref: s(config?.["ref"]),
    image: s(config?.["image"]),
    // Only on a party member, so every other row keeps its shape.
    ...(party !== null ? { party } : {}),
  };
}

/**
 * A member's role and its place in the stamp's member order (the leader at 0),
 * each only where the stamp states it, so a row from before them keeps its shape.
 */
function partyPlaceOf(role: unknown, members: unknown, member: string): { role?: string; index?: number } {
  const index = Array.isArray(members)
    ? members.findIndex((m) => m !== null && typeof m === "object" && (m as { member?: unknown }).member === member)
    : -1;
  return {
    ...(typeof role === "string" && role.length > 0 ? { role } : {}),
    ...(index >= 0 ? { index } : {}),
  };
}

function readMetaSafe(dir: string): MetaShape | null {
  const path = join(dir, "meta.json");
  // A bare session has no launch: what it knows of one is its `session.json`'s (`runRowOfBareSession`).
  if (!existsSync(path)) return isBareSessionDir(dir) ? bareMetaOf(dir) : null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as MetaShape;
  } catch {
    return null;
  }
}

/** A bare session's row as the meta.json a launch would have written: its start and its character's config. */
function bareMetaOf(dir: string): MetaShape | null {
  const r = readRunRow(dir, "");
  if (r === null) return null;
  let config: MetaShape["config"] = {};
  try {
    if (typeof r["config_json"] === "string") config = JSON.parse(r["config_json"]) as MetaShape["config"];
  } catch {
    config = {};
  }
  return { ...(typeof r["started_at"] === "number" ? { startedAt: r["started_at"] } : {}), config };
}

/**
 * Which columns a run's `state` table actually has.
 *
 * The table gains signals over time and an old run directory never gains them
 * retroactively — the databases here are opened readonly precisely so that
 * stays true. Asking the schema first is what lets one viewer read both, and
 * keeps a column that does not exist yet from turning into an error the whole
 * listing pays for.
 */
export function stateColumns(db: Database): Set<string> {
  try {
    const rows = db.query(`PRAGMA table_info(state)`).all() as { name?: unknown }[];
    return new Set(rows.map((r) => String(r.name)));
  } catch {
    return new Set();
  }
}

export function num(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * An `items` column's JSON, parsed and shape-checked: anything that is not an
 * array of named rows reads as null, and a row without a name is dropped.
 *
 * The one place the stored shape is re-read, so the sqlite path and the
 * ClickHouse one (`itemsOf`) cannot come to different answers about what a
 * sample said. Everything past name/count/equipped is copied **only** when the
 * stored value has the right type: a row written before those fields existed
 * keeps exactly its three keys, rather than gaining `itemId: undefined` — an
 * absent field means unobserved, and a zero there would name slot 0 or a
 * poor-quality item that was never seen.
 */
export function itemSamplesOf(text: string): ItemSample[] | null {
  let parsed: unknown;
  try {
    parsed = text.length === 0 ? null : (JSON.parse(text) as unknown);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out: ItemSample[] = [];
  type Row = Record<"name" | "count" | "equipped" | "itemId" | "quality" | "slot" | "bag", unknown>;
  const opt = (key: "itemId" | "quality" | "slot" | "bag", v: unknown): { [k: string]: number } =>
    typeof v === "number" ? { [key]: v } : {};
  for (const it of parsed as Row[]) {
    if (typeof it?.name !== "string") continue;
    out.push({
      name: it.name,
      count: typeof it.count === "number" ? it.count : 1,
      equipped: it.equipped === true,
      ...opt("itemId", it.itemId),
      ...opt("quality", it.quality),
      ...opt("slot", it.slot),
      ...opt("bag", it.bag),
    });
  }
  return out;
}

/**
 * The newest `items` sample, parsed and shape-checked: a run
 * written before the column existed, or a sample that carried none, is null.
 */
function latestItems(db: Database, runId: string, cols: Set<string>): ItemSample[] | null {
  if (!cols.has("items")) return null;
  try {
    const r = db
      .query(`SELECT items AS v FROM state WHERE run_id = ? AND items IS NOT NULL ORDER BY ts DESC LIMIT 1`)
      .get(runId) as Record<string, unknown> | null;
    if (r === null || typeof r["v"] !== "string") return null;
    return itemSamplesOf(r["v"]);
  } catch {
    return null;
  }
}

export function readRun(runsDir: string, runId: string, now = Date.now()): RunRow {
  const dir = runPath(runsDir, runId);
  const row: RunRow = {
    runId,
    model: null,
    driver: null,
    harness: null,
    shakeout: null,
    objective: null,
    // In the order `campaignFieldsOf` writes them, so this row and the store's
    // `runRowOf` serialise field for field alike.
    campaign: null,
    cell: null,
    campaignVersion: null,
    arm: null,
    ref: null,
    image: null,
    extra: false,
    comparability: null,
    character: null,
    race: null,
    raceName: null,
    class: null,
    className: null,
    characterLabel: null,
    platform: null,
    resolvedModel: null,
    cliVersion: null,
    apiBase: null,
    harnessVersion: null,
    startedAt: null,
    endedAt: null,
    terminationReason: null,
    terminationDetail: null,
    pauseReason: null,
    continuedFrom: null,
    level: null,
    xp: null,
    money: null,
    questsCompleted: null,
    items: null,
    mtime: null,
    bytes: null,
    live: false,
  };

  const meta = readMetaSafe(dir);
  if (meta !== null) {
    row.harnessVersion = str(meta.harnessVersion);
    row.startedAt = num(meta.startedAt);
    row.shakeout = str(meta.shakeout);
    row.model = str(meta.config?.model);
    row.objective = str(meta.config?.objective);
    row.extra = meta.config?.extra === true;
    // The freeplay character this launch continues. Read from meta first and from
    // the run row below, the same order every other config-and-column fact
    // here is read in; `dropContinuation` clears both together, so they cannot
    // disagree about a character whose character went away.
    row.continuedFrom = str(meta.config?.continuedFrom);
    row.driver = str(meta.config?.driver);
    // A fan-out run's characters are its sessions' (`fanout` on its detail); none is the run's.
    row.character = isFanoutRunDir(dir) ? null : str(meta.config?.character);
    /*
     * Race and class are config, not comparability: they are read here beside
     * the character name and nothing recomputes or back-labels them. A run
     * written before the fields existed keeps null, and so does a run whose
     * model chooses its start until its character is seen: its config holds
     * a placeholder until then (`trajectory.setStart`).
     */
    const startUnchosen = meta.config?.chooseStart === true && meta.config?.character === undefined;
    row.race = startUnchosen ? null : num(meta.config?.race);
    row.class = startUnchosen ? null : num(meta.config?.class);
    row.raceName = raceName(row.race);
    row.className = className(row.class);
    row.characterLabel = characterLabel(row.race, row.class);
    row.apiBase = str(meta.config?.apiBase);
    // Launch config only, like `extra`: no column carries it.
    const declared = meta.config?.billing;
    if (declared === "free" || declared === "paid") row.declaredBilling = declared;
    // What paid: a v1 run's credential, or a 0.5 run's lane. Launch config only.
    Object.assign(row, runCredentialOf(meta.config));
    // The world it played on, a label like the credential; absent before worlds.
    const world = str(meta.config?.world);
    if (world !== null) row.world = world;
    /*
     * What the provider actually served, promoted onto the run mid-episode
     * (`Trajectory.recordResolved`). Read here and from the columns below;
     * a run written before either existed reads null and is back-filled from
     * its trajectory by the caller, never rewritten on disk.
     */
    row.resolvedModel = str(meta.resolved?.model);
    row.cliVersion = str(meta.resolved?.cliVersion);
    /*
     * Validated, not trusted: meta.json is written by whatever build launched
     * the run, and a shape this build does not recognise reads as "not
     * recorded" rather than reaching a chart as a half-filled tuple.
     */
    row.comparability = parseComparability(meta.comparability) as ComparabilityView | null;
  }
  // Attributed whether or not the meta was readable: a closed definition names
  // its members by run id, which needs nothing from the run but its id.
  Object.assign(row, campaignFieldsOf(meta?.config as Record<string, unknown> | undefined));

  const jsonl = join(dir, "trajectory.jsonl");
  if (existsSync(jsonl)) {
    const st = statSync(jsonl);
    row.mtime = st.mtimeMs;
    row.bytes = st.size;
  } else if (isBareSessionDir(dir)) {
    // A bare session has no trajectory; its writer's heartbeat is `live.json`, rewritten every tick.
    const live = statSync(join(dir, "live.json"), { throwIfNoEntry: false });
    if (live !== undefined) row.mtime = live.mtimeMs;
  }

  if (isV1RunDir(dir) || !existsSync(join(dir, "run.sqlite"))) {
    // A v1 run: its row from meta.json (or a first-build run.sqlite), its
    // readings from the session record's trace (`run-reader.ts`). A run with
    // neither a record nor a run.sqlite (a launch that failed before its
    // session opened) is one too: its row is its meta.json.
    try {
      const r = readRunRow(dir, runId);
      if (r !== null) applyRunRow(row, r);
      const latest = latestReading(dir, runId);
      // A fan-out run has no one reading: its lead character's level and xp (`fanoutLead`).
      const lead = latest === null && isFanoutRunDir(dir) ? fanoutLead(fanoutReadings(dir)) : null;
      if (lead !== null) {
        row.level = lead.level;
        row.xp = lead.xp;
      }
      if (latest !== null) {
        row.level = latest.level;
        row.xp = latest.xp;
        row.money = latest.money;
        row.questsCompleted = latest.questsCompleted;
        row.items = latest.items === null ? null : itemSamplesOf(latest.items);
      }
    } catch (err) {
      row.error = err instanceof Error ? err.message : String(err);
    }
    return finishRow(row, now);
  }

  // A single unreadable or busy database degrades one row, never the listing.
  const db = openReadonly(dir);
  if (db !== null) {
    try {
      const r = db.query(`SELECT * FROM run WHERE run_id = ?`).get(runId) as Record<string, unknown> | null;
      if (r !== null) {
        applyRunRow(row, r);
      }
      const last = db
        .query(
          `SELECT level, xp FROM state WHERE run_id = ? AND level IS NOT NULL AND level > 0
           ORDER BY ts DESC LIMIT 1`,
        )
        .get(runId) as Record<string, unknown> | null;
      if (last !== null) {
        row.level = num(last["level"]);
        row.xp = num(last["xp"]);
      }

      /*
       * The newest sample that actually carried a value. Zero is a real
       * reading — a broke character has 0 copper — so only NULL is treated as
       * "nothing recorded", and a column the schema lacks stays null rather
       * than becoming a misleading 0.
       */
      const cols = stateColumns(db);
      const latest = (column: string): number | null => {
        if (!cols.has(column)) return null;
        try {
          const r = db
            .query(
              // The column name is one of our own literals, never user input.
              `SELECT ${column} AS v FROM state WHERE run_id = ? AND ${column} IS NOT NULL
               ORDER BY ts DESC LIMIT 1`,
            )
            .get(runId) as Record<string, unknown> | null;
          return r === null ? null : num(r["v"]);
        } catch {
          return null;
        }
      };
      row.money = latest("money");
      row.questsCompleted = latest("quests_completed");
      row.items = latestItems(db, runId, cols);
    } catch (err) {
      row.error = err instanceof Error ? err.message : String(err);
    } finally {
      db.close();
    }
  }

  return finishRow(row, now);
}

/** The run row's columns onto a listing row: a column wins where it has an answer, the meta read fills the rest. */
function applyRunRow(row: RunRow, r: Record<string, unknown>): void {
  row.harnessVersion = str(r["harness_version"]) ?? row.harnessVersion;
  row.startedAt = num(r["started_at"]) ?? row.startedAt;
  row.endedAt = num(r["ended_at"]);
  row.model = str(r["model"]) ?? row.model;
  row.driver = str(r["driver"]) ?? row.driver;
  row.shakeout = str(r["shakeout"]) ?? row.shakeout;
  row.objective = str(r["objective"]) ?? row.objective;
  // `character`/`platform` landed at 0.4-6: a 0.4-1..5 run.sqlite has
  // neither, and the meta read above / the derivation below answer.
  row.character = str(r["character"]) ?? row.character;
  row.platform = str(r["platform"]);
  // Added at 0.5: a run.sqlite that predates the columns yields undefined
  // here, which `str` reads as null — the same as "not recorded".
  row.resolvedModel = str(r["resolved_model"]) ?? row.resolvedModel;
  row.cliVersion = str(r["resolved_cli_version"]) ?? row.cliVersion;
  row.terminationReason = str(r["termination_reason"]);
  row.terminationDetail = str(r["termination_detail"]);
  row.pauseReason = str(r["pause_reason"]);
  // Added at 0.5 with the durable character: a run.sqlite that predates the
  // column has no key here, which `str` reads as null.
  row.continuedFrom = str(r["continued_from"]) ?? row.continuedFrom;
  if (row.apiBase === null && typeof r["config_json"] === "string") {
    try {
      row.apiBase = str((JSON.parse(r["config_json"]) as { apiBase?: unknown }).apiBase);
    } catch {
      /* a run row with unparseable config still lists */
    }
  }
}

/** What every row is finished with, however it was read. */
function finishRow(row: RunRow, now: number): RunRow {
  row.harness = harnessOfRun({ comparability: row.comparability, driver: row.driver });
  // The stamped column wins; a run that predates it is derived by the rule the
  // writer stamps with (`runner/src/platform.ts`), so the two are labelled alike.
  if (row.platform === null) row.platform = platformOf(row.apiBase, row.driver);
  row.live =
    row.terminationReason === null && row.mtime !== null && now - row.mtime < LIVE_WINDOW_MS;
  return closeBareSession(row, now);
}

/** A store session's verdict when its record closed it (`session.json`'s `ended`). */
export const BARE_ENDED = "ended";
/** ...and when its writer stopped without closing it: `live.json`'s heartbeat went quiet. */
export const BARE_ABANDONED = "abandoned";

/**
 * A bare session's end, as the record states it (`runner/src/session-store.ts`).
 * A run says it ended by a termination reason, which a session never writes,
 * and every reader of a row (the listing's status, the run page's timeline,
 * its LIVE toggle and its polling, the live map) takes a missing one as a run
 * still going. So a session closed in its `session.json` reads as `ended` at
 * that close, and one whose writer died without closing it, its `live.json`
 * quiet for the listing's live window (wrath-mcp/docs/SESSION-FORMAT.md, "a
 * session whose ended is null and whose heartbeat is old was abandoned"),
 * reads as `abandoned` at its last heartbeat. Decided on each read, against
 * `now`, because a stored row never learns that its writer stopped; a writer
 * that resumes the session moves the heartbeat and it reads as live again.
 * Both row homes pass every row through here, so it is also where a session's
 * row is stamped as the store's (`RunRow.source`). Any other row is returned
 * as it was.
 */
export function closeBareSession<T extends Pick<RunRow, "runId" | "terminationReason" | "endedAt" | "startedAt" | "mtime" | "live" | "source">>(row: T, now: number): T {
  if (!isBareSessionId(row.runId)) return row;
  row.source = "store";
  if (row.terminationReason !== null) return row;
  if (row.endedAt !== null) row.terminationReason = BARE_ENDED;
  else if (row.mtime === null || now - row.mtime >= LIVE_WINDOW_MS) {
    row.terminationReason = BARE_ABANDONED;
    row.endedAt = row.mtime ?? row.startedAt;
  }
  if (row.terminationReason !== null) row.live = false;
  return row;
}

export function listRuns(runsDir: string, now = Date.now()): RunRow[] {
  if (!existsSync(runsDir)) return [];
  const ids = readdirSync(runsDir, { withFileTypes: true })
    // A directory holding only launch files is a launch that never became a run.
    .filter((d) => d.isDirectory() && isValidRunId(d.name) && !isArchiveDir(d.name) && !holdsOnlyLaunchFiles(join(runsDir, d.name)))
    .map((d) => d.name);
  const rows = ids.map((id) => readRun(runsDir, id, now));
  rows.sort((a, b) => (b.startedAt ?? b.mtime ?? 0) - (a.startedAt ?? a.mtime ?? 0));
  return rows;
}
