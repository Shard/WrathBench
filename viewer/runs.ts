/**
 * A run's series off disk, read-only: its state samples, its bag's items, its
 * move intents and its scratchpad, for the viewer's direct reads. Nothing here
 * ever writes. The run listing these read beside (`listRuns`, `readRun`,
 * `runDir`) is the runner's, `runner/src/run-list.ts`, because the runner's
 * core reads it too and never imports the viewer.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { MoveIntentView, StateItemsRow, StatePoint } from "./api-types";
import { moves } from "@wrathbench/inspector";
import { fanoutSession, runSession } from "./runs-source";
import { characterSamplesOf, isFanoutRunDir, isV1RunDir, parseFanoutSessionId, readStateSamples } from "../runner/src/run-reader";
import { num, openReadonly, runDir, runPath, stateColumns } from "../runner/src/run-list";

/** A state row's columns as a `StatePoint`: the one mapping both homes go through. */
function statePointOfRow(r: Record<string, unknown>): StatePoint {
  return {
    ts: num(r["ts"]) ?? 0,
    level: num(r["level"]),
    xp: num(r["xp"]),
    map: num(r["map"]),
    x: num(r["x"]),
    y: num(r["y"]),
    z: num(r["z"]),
    eventCount: num(r["event_count"]),
    lastSeq: num(r["last_seq"]),
    // `SELECT *` on a database that predates the column simply has no key
    // here, which `num` turns into null — no schema guard needed.
    turn: num(r["turn"]),
    // The player frame's numbers, same rule.
    health: num(r["health"]),
    maxHealth: num(r["max_health"]),
    power: num(r["power"]),
    maxPower: num(r["max_power"]),
    powerType: num(r["power_type"]),
    nextLevelXp: num(r["next_level_xp"]),
    questsCompleted: num(r["quests_completed"]),
  };
}

/**
 * A run's state samples, oldest first: a v1 run's folded from its trace
 * (`trace-samples.ts`), a 0.5 run's its run.sqlite `state` rows.
 */
/** A fan-out character's samples, by its session id (`<run-id>~<Character>`); null for an id that is not one. */
function characterSamples(runsDir: string, id: string): Record<string, unknown>[] | null {
  const named = parseFanoutSessionId(id);
  if (named === null) return null;
  const dir = runDir(runsDir, named.runId);
  return dir === null || !isFanoutRunDir(dir) ? [] : (characterSamplesOf(dir, named.character) as unknown as Record<string, unknown>[]);
}

export function readStates(runsDir: string, runId: string): StatePoint[] {
  const character = characterSamples(runsDir, runId);
  if (character !== null) return character.map(statePointOfRow);
  const dir = runPath(runsDir, runId);
  if (isV1RunDir(dir)) return readStateSamples(dir, runId).map(statePointOfRow);
  const db = openReadonly(dir);
  if (db === null) return [];
  try {
    const rows = db.query(`SELECT * FROM state WHERE run_id = ? ORDER BY ts`).all(runId) as Record<
      string,
      unknown
    >[];
    return rows.map(statePointOfRow);
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/**
 * One run's recorded quest counts, oldest first, for the map feed to total
 * across restarts (`questsAcrossRestarts`) the way the run page does. Two
 * columns rather than `readStates`, which the feed would pay `items` for on
 * every poll; empty where the schema predates the column.
 */
export function readQuestCounts(runsDir: string, runId: string): Pick<StatePoint, "questsCompleted">[] {
  const dir = runPath(runsDir, runId);
  if (isV1RunDir(dir)) return readStateSamples(dir, runId).map((r) => ({ questsCompleted: num(r["quests_completed"]) }));
  const db = openReadonly(dir);
  if (db === null) return [];
  try {
    if (!stateColumns(db).has("quests_completed")) return [];
    const rows = db
      .query(`SELECT quests_completed AS q FROM state WHERE run_id = ? AND quests_completed IS NOT NULL ORDER BY ts`)
      .all(runId) as { q: unknown }[];
    return rows.map((r) => ({ questsCompleted: num(r.q) }));
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/**
 * One run's `items` samples, oldest first, skipping the samples that carried
 * none — the fallback `readStates` is, for the same reason and in the same
 * place: a run the collector has not reached yet still replays.
 *
 * Separate from `readStates` because `items` is the one large column of the
 * table and nothing but a replay wants it; every other read path would be
 * paying for a whole inventory per sample to ignore it.
 */
export function readStateItems(runsDir: string, runId: string): StateItemsRow[] {
  const dir = runPath(runsDir, runId);
  const character = characterSamples(runsDir, runId);
  if (character !== null || isV1RunDir(dir)) {
    const out: StateItemsRow[] = [];
    for (const r of character ?? readStateSamples(dir, runId)) {
      if (typeof r["items"] === "string" && r["items"].length > 0) out.push({ ts: num(r["ts"]) ?? 0, seq: num(r["seq"]) ?? 0, items: r["items"] });
    }
    return out;
  }
  const db = openReadonly(dir);
  if (db === null) return [];
  try {
    const rows = db
      .query(`SELECT ts, rowid AS seq, items FROM state WHERE run_id = ? AND items IS NOT NULL ORDER BY ts, rowid`)
      .all(runId) as Record<string, unknown>[];
    const out: StateItemsRow[] = [];
    for (const r of rows) {
      if (typeof r["items"] !== "string" || r["items"].length === 0) continue;
      out.push({ ts: num(r["ts"]) ?? 0, seq: num(r["seq"]) ?? 0, items: r["items"] });
    }
    return out;
  } catch {
    // A run.sqlite from before the `items` column: it recorded none.
    return [];
  } finally {
    db.close();
  }
}

/** Every movement intention a run recorded, oldest first: the inspector's readout over the run's session (`runs-source.ts`). */
export async function readMoves(runsDir: string, runId: string): Promise<MoveIntentView[]> {
  try {
    // A fan-out character's session id opens its own record; a run's id, the run's.
    const session = parseFanoutSessionId(runId) === null ? runSession(runsDir, runId) : fanoutSession(runsDir, runId);
    if (session === null) return [];
    return await moves(session);
  } catch {
    return [];
  }
}

export function readScratchpad(runsDir: string, runId: string): string | null {
  const path = join(runPath(runsDir, runId), "scratchpad.md");
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
