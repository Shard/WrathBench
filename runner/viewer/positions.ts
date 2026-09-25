/**
 * The position feed: where every live agent is, right now.
 *
 * This is an interface rather than a query the renderer runs, so one renderer
 * can sit behind any position feed. The
 * map draws `AgentPosition[]` and knows nothing about where they came from —
 * live mode fills them from each run's `run.sqlite` (here), and a replay mode
 * later fills the same shape from a trajectory reader plus a time cursor. That
 * seam is the reason this file is separate from the page.
 *
 * Which runs to ask comes from one of two listings. `positionsFromStore` takes
 * it off the derived store (`clickhouse.ts`) the way every listing route does;
 * `readPositions` walks the runs directory, and is what a caller with no store
 * gets. Either way the answer per run is read from that run's own files, and
 * built by the one function both call, so the two feeds cannot disagree about
 * what an agent looks like.
 *
 * Read-only, like everything else in the viewer: databases open readonly and
 * the schema is asked what it has before it is selected from, because an old
 * run directory never gains a column it did not record.
 */

import type { Database } from "bun:sqlite";
import { openRunDb } from "../src/rundb";
import { STALL_PAUSE } from "../src/lapse";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentPosition, CharacterStatus, MoveIntentView, RunRow } from "./api-types";
import { runRowOf, type RunStore } from "./clickhouse";
import { listRuns, readMoves } from "./runs";

/**
 * How stale a position may be and still count as an agent on the map. Longer
 * than the trajectory-liveness window in `runs.ts` on purpose: a run that is
 * thinking hard, or paused mid-turn, is still somewhere.
 */
export const POSITION_WINDOW_MS = 600_000;

/**
 * One agent, at one moment. The `ts` is the state sample's, not the read's —
 * the client ages pips off it, and a replay feed will supply the sample time
 * from the trajectory in exactly the same way.
 */
/* The shape lives in `api-types.ts`, the contract the dashboard imports too. */
export type { AgentPosition } from "./api-types";

/** Which columns a run's `state` table actually has (schema drift is normal). */
function stateColumns(db: Database): Set<string> {
  try {
    const rows = db.query(`PRAGMA table_info(state)`).all() as { name?: unknown }[];
    return new Set(rows.map((r) => String(r.name)));
  } catch {
    return new Set();
  }
}

function num(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}

/**
 * The player frame's columns, read from the same row as the
 * position so the frame shows the character as that sample saw it rather than
 * a per-column high-water mix. Older runs lack the columns entirely, which is
 * what `stateColumns` is asked about first.
 */
const GAUGE_COLUMNS = ["health", "max_health", "power", "max_power", "power_type", "next_level_xp"] as const;

/** The gauges of one state row, keyed as the API serves them. */
export interface PositionGauges {
  health: number | null;
  maxHealth: number | null;
  power: number | null;
  maxPower: number | null;
  powerType: number | null;
  nextLevelXp: number | null;
}

/**
 * The newest state sample that actually carried a position.
 *
 * Not simply the newest row: a sample may record level and xp with no
 * coordinates, and taking it would make a live agent blink off the map even
 * though a position landed seconds earlier.
 */
export function readLatestPosition(
  runsDir: string,
  runId: string,
): ({ map: number; x: number; y: number; ts: number } & PositionGauges) | null {
  const path = join(runsDir, runId, "run.sqlite");
  if (!existsSync(path)) return null;
  let db: Database;
  try {
    db = openRunDb(path, { readonly: true });
  } catch {
    return null;
  }
  try {
    const cols = stateColumns(db);
    for (const c of ["ts", "map", "x", "y"]) if (!cols.has(c)) return null;
    // Column names are our own literals, never input; a run that predates them
    // simply selects fewer, and every gauge below reads null.
    const extra = GAUGE_COLUMNS.filter((c) => cols.has(c));
    const r = db
      .query(
        `SELECT ts, map, x, y${extra.length === 0 ? "" : `, ${extra.join(", ")}`} FROM state
         WHERE run_id = ? AND map IS NOT NULL AND x IS NOT NULL AND y IS NOT NULL
         ORDER BY ts DESC LIMIT 1`,
      )
      .get(runId) as Record<string, unknown> | null;
    if (r === null) return null;
    const ts = num(r["ts"]);
    const map = num(r["map"]);
    const x = num(r["x"]);
    const y = num(r["y"]);
    if (ts === null || map === null || x === null || y === null) return null;
    return {
      map,
      x,
      y,
      ts,
      health: num(r["health"]),
      maxHealth: num(r["max_health"]),
      power: num(r["power"]),
      maxPower: num(r["max_power"]),
      powerType: num(r["power_type"]),
      nextLevelXp: num(r["next_level_xp"]),
    };
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/**
 * The newest entry in a run's episodic log (`data/runs/<id>/episodic.jsonl`),
 * or null when it has none.
 *
 * Read as a file rather than through `runner/src/episodic.ts`: that class's
 * constructor creates the directory, and the viewer only ever reads. The file
 * is a handful of 600-char lines, so the whole of it is parsed and the last
 * good line taken — the same tolerance the writer's own reader shows a
 * half-written last line, for the same reason (the harness may be appending to
 * it right now).
 */
export function readLatestStatus(runsDir: string, runId: string): CharacterStatus | null {
  const path = join(runsDir, runId, "episodic.jsonl");
  if (!existsSync(path)) return null;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  let latest: CharacterStatus | null = null;
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const e = JSON.parse(line) as Record<string, unknown>;
      if (typeof e["text"] !== "string" || typeof e["turn"] !== "number") continue;
      latest = {
        turn: e["turn"],
        level: typeof e["level"] === "number" ? e["level"] : null,
        zone: typeof e["zone"] === "string" && e["zone"].length > 0 ? e["zone"] : null,
        text: e["text"],
        ts: typeof e["ts"] === "number" ? e["ts"] : 0,
      };
    } catch {
      // A partial line is not a reason to lose the entries before it.
    }
  }
  return latest;
}

/**
 * Whether a reflection window is open on this run right now.
 *
 * `run.reflecting_since` is the writer's mirror of the gate's window
 * (`runner/src/trajectory.ts`); non-null is the whole test. The column is
 * asked for before it is selected, because an old run directory never gains a
 * column it did not record — and a run that predates it was never reflecting.
 */
export function readReflecting(runsDir: string, runId: string): boolean {
  const path = join(runsDir, runId, "run.sqlite");
  if (!existsSync(path)) return false;
  let db: Database;
  try {
    db = openRunDb(path, { readonly: true });
  } catch {
    return false;
  }
  try {
    const cols = db.query(`PRAGMA table_info(run)`).all() as { name?: unknown }[];
    if (!cols.some((c) => String(c.name) === "reflecting_since")) return false;
    const r = db.query(`SELECT reflecting_since AS since FROM run WHERE run_id = ?`).get(runId) as
      | { since?: unknown }
      | null;
    return typeof r?.since === "number";
  } catch {
    return false;
  } finally {
    db.close();
  }
}

/**
 * The newest movement intention a run recorded, or null.
 *
 * The whole table is read and the last row taken rather than a `LIMIT 1`
 * query, because `readMoves` is the one place that knows the table may not
 * exist at all; a run's intentions are a handful of rows an hour.
 */
export function readLatestMove(runsDir: string, runId: string): MoveIntentView | null {
  const moves = readMoves(runsDir, runId);
  return moves.length === 0 ? null : moves[moves.length - 1]!;
}

/**
 * One run's entry on the map, or null when it is not worth drawing:
 * terminated, paused because its observation stalled, or not standing
 * anywhere inside the window.
 *
 * Trajectory mtime deliberately plays no part — that is the listing's notion of
 * live, keyed on a different file for a different question. Here the position's
 * own age is the whole test, with the one exception of a stalled run: its
 * newest rows are the last reading repeated while the character went on
 * elsewhere, so the position is fresh by its stamp and wrong by its content.
 */
function positionOf(runsDir: string, run: RunRow, now: number, windowMs: number): AgentPosition | null {
  if (run.terminationReason !== null) return null;
  if (run.pauseReason === STALL_PAUSE) return null;
  const pos = readLatestPosition(runsDir, run.runId);
  if (pos === null) return null;
  if (now - pos.ts > windowMs) return null;
  return {
    runId: run.runId,
    character: run.character,
    model: run.model,
    // Off the comparability stamp, which is already public on the run row:
    // the map names a nameless pip by its model, and the effort is the half
    // of that name two sibling characters differ by.
    effort: run.comparability?.effort ?? null,
    map: pos.map,
    x: pos.x,
    y: pos.y,
    ts: pos.ts,
    level: run.level,
    xp: run.xp,
    money: run.money,
    questsCompleted: run.questsCompleted,
    items: run.items,
    harnessVersion: run.harnessVersion,
    // The player frame, from the same sample the pip is drawn from.
    health: pos.health,
    maxHealth: pos.maxHealth,
    power: pos.power,
    maxPower: pos.maxPower,
    powerType: pos.powerType,
    nextLevelXp: pos.nextLevelXp,
    // Launch config, not a sample: the fallback tint for a run recorded
    // before `power_type` existed.
    class: run.class,
    // Where it is trying to get to. Not aged here: the map decides what a
    // stale intention looks like, the same way it decides for a pip.
    move: readLatestMove(runsDir, run.runId),
    // What the character last said it was doing, and whether it is thinking
    // rather than acting right now. Neither is aged either, for the same
    // reason: staleness is the reader's call, not the feed's.
    status: readLatestStatus(runsDir, run.runId),
    reflecting: readReflecting(runsDir, run.runId),
  };
}

/** The feed over a listing: every run worth drawing, newest position first. */
function positionsOf(runsDir: string, runs: readonly RunRow[], now: number, windowMs: number): AgentPosition[] {
  const out: AgentPosition[] = [];
  for (const run of runs) {
    const p = positionOf(runsDir, run, now, windowMs);
    if (p !== null) out.push(p);
  }
  out.sort((a, b) => b.ts - a.ts);
  return out;
}

/**
 * Every agent worth drawing, listed by walking the runs directory.
 *
 * `listRuns` opens every run in the tree to find the handful that are
 * unterminated, which is the fan-out `positionsFromStore` exists to avoid. It
 * stays as the feed for a caller that has no store.
 */
export function readPositions(
  runsDir: string,
  now = Date.now(),
  windowMs = POSITION_WINDOW_MS,
): AgentPosition[] {
  return positionsOf(runsDir, listRuns(runsDir, now), now, windowMs);
}

/**
 * Every agent worth drawing, listed off the derived store.
 *
 * The listing is the one `/api/runs` reads — two queries, archived runs
 * filtered by the reader, the rows mapped by `runRowOf` and ordered as
 * `listRuns` orders them — so no run directory is opened to learn which runs
 * exist or have ended. What stays on files is only what is asked of the runs
 * that have not ended: the position itself, the move, the status and the
 * reflection window, read exactly as `readPositions` reads them, because the
 * map's whole subject is where a character is this second and the store is a
 * collector poll behind that.
 *
 * Like every listing route, a run the collector has not reached yet is not
 * listed until it has; that is the first seconds of a run's life.
 */
export async function positionsFromStore(
  store: RunStore,
  runsDir: string,
  now = Date.now(),
  windowMs = POSITION_WINDOW_MS,
): Promise<AgentPosition[]> {
  const [rows, latest] = await Promise.all([store.runRows(), store.latestStates()]);
  const runs = rows.filter((r) => r.archived === 0).map((r) => runRowOf(r, latest.get(r.run_id), now));
  runs.sort((a, b) => (b.startedAt ?? b.mtime ?? 0) - (a.startedAt ?? a.mtime ?? 0));
  return positionsOf(runsDir, runs, now, windowMs);
}
