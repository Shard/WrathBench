/**
 * The frozen phase-1 v1 run in `v1p1/`, laid out as a runs directory: its
 * files copied, and `run.sql` replayed into a `run.sqlite` when asked for (a
 * phase-1 run had one; a later v1 run has none). Imports nothing from the
 * runner, so no later change to it can change what the run holds.
 */

import { Database } from "bun:sqlite";
import { cpSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const V1P1_DIR = join(import.meta.dir, "v1p1");
export const V1P1_RUN = "v1p1-solo";
export const V1P1_SRC = join(V1P1_DIR, V1P1_RUN);

/** Copy the run into `runsDir/<id>/`; `sqlite` replays its `run` and `state` tables beside it. */
export function materialiseV1p1(runsDir: string, opts: { sqlite?: boolean; as?: string } = {}): string {
  const dst = join(runsDir, opts.as ?? V1P1_RUN);
  for (const name of ["meta.json", "trajectory.jsonl", "session"]) cpSync(join(V1P1_SRC, name), join(dst, name), { recursive: true });
  if (opts.sqlite === true) {
    const db = new Database(join(dst, "run.sqlite"), { create: true });
    db.exec(readFileSync(join(V1P1_SRC, "run.sql"), "utf8"));
    db.close();
  }
  return dst;
}

/** The run's frozen `state` rows, oldest first, read from `run.sql` into memory. */
export function v1p1StateRows(): Record<string, unknown>[] {
  const db = new Database(":memory:");
  db.exec(readFileSync(join(V1P1_SRC, "run.sql"), "utf8"));
  const rows = db.query(`SELECT rowid AS seq, * FROM state ORDER BY ts, rowid`).all() as Record<string, unknown>[];
  db.close();
  return rows;
}
