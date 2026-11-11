/**
 * The frozen 0.5 runs in `legacy05/`, laid out as a runs directory.
 *
 * The runs are artifacts, not builders: this loader reads the committed text
 * files and imports nothing but `bun:sqlite` and `node:`, so deleting or
 * changing a 0.5 writer, or anything else in `runner/`, cannot change what
 * these runs hold. `run.sql` is replayed into `run.sqlite` with `bun:sqlite`
 * alone. The viewer over them is `legacy05-api.ts`; `legacy05/README.md` says
 * what each run covers.
 */

import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const LEGACY05_DIR = join(import.meta.dir, "legacy05");
export const LEGACY05_GOLDEN_DIR = join(LEGACY05_DIR, "golden");

/** The runs, by id. */
export const LEGACY05_RUNS = ["l05-party-a1", "l05-freeplay-1", "l05-freeplay-2"] as const;
export type Legacy05Run = (typeof LEGACY05_RUNS)[number];

/**
 * The instant every read is made at: 630 s into the live run, so its trace
 * has one closed window and a tail of two (one settling, one open), and its
 * nearby ring's newest file was written two seconds ago.
 */
export const LEGACY05_NOW = 1_760_087_130_000;

/** The trace windows each run recorded rows in, as `/trace/<t0>` names them. */
export const LEGACY05_WINDOWS: Record<Legacy05Run, number[]> = {
  "l05-party-a1": [1_760_000_100_000, 1_760_000_400_000, 1_760_000_700_000],
  // Recorded before the recorder: no window has rows. Asked anyway, for the 404.
  "l05-freeplay-1": [1_759_827_300_000],
  "l05-freeplay-2": [1_760_086_500_000, 1_760_086_800_000, 1_760_087_100_000],
};

/** The newest `ts` among a JSONL file's lines, or null when none has one. */
function lastTs(path: string): number | null {
  let last: number | null = null;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.length === 0) continue;
    const ts = (JSON.parse(line) as { ts?: unknown }).ts;
    if (typeof ts === "number" && (last === null || ts > last)) last = ts;
  }
  return last;
}

/** Whole seconds, so the stamp survives every filesystem's mtime resolution. */
const toSeconds = (ms: number): number => Math.ceil(ms / 1000);

/**
 * Copy the runs into `runsDir` (one directory per run) and replay each
 * `run.sql` into a `run.sqlite`. File times are set as the run would have left
 * them, never the copy's: every file of a run at its trajectory's last record,
 * and each nearby ring file at its own last row. A run's liveness, the ring's
 * freshness and the `mtime` a run row carries are all read off them.
 */
export function materialiseLegacy05(runsDir: string): void {
  for (const runId of LEGACY05_RUNS) {
    const src = join(LEGACY05_DIR, runId);
    const dst = join(runsDir, runId);
    mkdirSync(dst, { recursive: true });
    const stamp = toSeconds(lastTs(join(src, "trajectory.jsonl"))!);
    const touched: [string, number][] = [];
    for (const name of readdirSync(src)) {
      const from = join(src, name);
      if (statSync(from).isDirectory()) {
        mkdirSync(join(dst, name), { recursive: true });
        for (const inner of readdirSync(from)) {
          writeFileSync(join(dst, name, inner), readFileSync(join(from, inner)));
          touched.push([join(dst, name, inner), toSeconds(lastTs(join(from, inner)) ?? stamp * 1000)]);
        }
        touched.push([join(dst, name), stamp]);
        continue;
      }
      if (name === "run.sql") {
        const db = new Database(join(dst, "run.sqlite"), { create: true });
        db.exec(readFileSync(from, "utf8"));
        db.close();
        touched.push([join(dst, "run.sqlite"), stamp]);
        continue;
      }
      writeFileSync(join(dst, name), readFileSync(from));
      touched.push([join(dst, name), stamp]);
    }
    touched.push([dst, stamp]);
    for (const [path, s] of touched) utimesSync(path, s, s);
  }
}
