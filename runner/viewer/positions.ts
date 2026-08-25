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
 * Read-only, like everything else in the viewer: databases open readonly and
 * the schema is asked what it has before it is selected from, because an old
 * run directory never gains a column it did not record.
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AgentPosition } from "./api-types";
import { listRuns } from "./runs";

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
 * The newest state sample that actually carried a position.
 *
 * Not simply the newest row: a sample may record level and xp with no
 * coordinates, and taking it would make a live agent blink off the map even
 * though a position landed seconds earlier.
 */
export function readLatestPosition(
  runsDir: string,
  runId: string,
): { map: number; x: number; y: number; ts: number } | null {
  const path = join(runsDir, runId, "run.sqlite");
  if (!existsSync(path)) return null;
  let db: Database;
  try {
    db = new Database(path, { readonly: true });
  } catch {
    return null;
  }
  try {
    const cols = stateColumns(db);
    for (const c of ["ts", "map", "x", "y"]) if (!cols.has(c)) return null;
    const r = db
      .query(
        `SELECT ts, map, x, y FROM state
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
    return { map, x, y, ts };
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/**
 * Every agent worth drawing: unterminated, and standing somewhere recently.
 *
 * Trajectory mtime deliberately plays no part — that is the listing's notion of
 * live, keyed on a different file for a different question. Here the position's
 * own age is the whole test.
 */
export function readPositions(
  runsDir: string,
  now = Date.now(),
  windowMs = POSITION_WINDOW_MS,
): AgentPosition[] {
  const out: AgentPosition[] = [];
  for (const run of listRuns(runsDir, now)) {
    if (run.terminationReason !== null) continue;
    const pos = readLatestPosition(runsDir, run.runId);
    if (pos === null) continue;
    if (now - pos.ts > windowMs) continue;
    out.push({
      runId: run.runId,
      character: run.character,
      model: run.model,
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
    });
  }
  out.sort((a, b) => b.ts - a.ts);
  return out;
}
