/**
 * Which directories are runs, and which of them have moved.
 *
 * Polling `readdir` plus `stat`, deliberately: no inotify, no fanotify, no
 * watcher library. The runs tree is an NFS/iSCSI-backed PVC shared by five
 * pods, and file-system events over a network mount are the kind of thing that
 * works on a laptop and silently stops on a cluster. A stat of a thousand
 * directories is milliseconds and is the same on both.
 */

import { readdirSync, statSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { ARCHIVE_DIR } from "../../runner/viewer/archive-dir";

const RUN_ID = /^[A-Za-z0-9._-]+$/;

export interface RunDirEntry {
  runId: string;
  dir: string;
  archived: boolean;
  /**
   * `(size, mtime)` over every artefact — what "has this moved" compares.
   *
   * Size as well as mtime, because a coarse mtime is a real failure mode: a
   * file appended to within the same millisecond its last pass read it has an
   * unchanged mtime, and a gate on mtime alone would skip those bytes until
   * something else moved the file. The same rule the viewer's own read cache
   * states in `runner/viewer/runs.ts`.
   */
  sig: string;
}

function isValidRunId(id: string): boolean {
  return RUN_ID.test(id) && id !== "." && id !== "..";
}

function signature(dir: string): string {
  let sig = "";
  for (const name of ["trajectory.jsonl", "episodic.jsonl", "run.sqlite", "meta.json"]) {
    try {
      const st = statSync(join(dir, name));
      sig += `${name}:${st.size}:${st.mtimeMs}|`;
    } catch {
      // A run with no such artefact is ordinary, and "absent" is part of the
      // signature: a file that appears later is a change.
      sig += `${name}:-|`;
    }
  }
  return sig;
}

/**
 * Every run directory, including the archive — at most one per run id.
 *
 * The viewer skips `archive/` because an archived run is one nobody should
 * see again; the scheduler reads it and has to (`readRunFacts`,
 * `includeArchived`). This store serves both, so it ingests both and marks
 * which is which — the filter belongs in the query, not in what gets stored.
 *
 * **A run id is not unique on disk.** `data/runs/<id>/` and
 * `data/runs/archive/<id>/` can both exist and hold different runs: an attempt
 * was archived and a later launch reused the id, so the two differ in harness
 * version, start time and length. Every key in this service is the run id
 * alone — the pass's `lastSeen` map, the offset store's `(run_id, file)`, and
 * every ClickHouse table's `ORDER BY` — so two directories under one id do not
 * coexist, they thrash: each pass resumes from the offset the other committed,
 * commits one the other rejects, and writes rows that overwrite the other's
 * under the same `(run_id, line_no)`. The store's rows for that id become a
 * blend of two runs, re-read on every pass forever. Which is why this returns
 * one entry per id, not one per directory.
 *
 * The non-archived directory wins, because this store is the viewer's read
 * model and the viewer serves the top-level copy: `runDir` returns null for
 * anything under `archive/` and `listRuns` filters it by name
 * (`runner/viewer/runs.ts`). Nothing reads the store for what the archive is
 * kept for — attempt numbering and the defer ladder reach the filesystem
 * directly through `readRunFacts({ includeArchived })`. The skipped directory
 * is reported to `onDuplicate` so the collision is visible rather than silent;
 * its files are untouched, as everything here leaves them.
 */
export function listRunDirs(
  runsDir: string,
  onDuplicate?: (runId: string, skippedDir: string, keptDir: string) => void,
): RunDirEntry[] {
  const out: RunDirEntry[] = [];
  let top: Dirent<string>[];
  try {
    top = readdirSync(runsDir, { withFileTypes: true });
  } catch {
    return out;
  }
  let archiveNames: string[] = [];
  for (const d of top) {
    if (!d.isDirectory() || !isValidRunId(d.name)) continue;
    if (d.name === ARCHIVE_DIR) {
      try {
        archiveNames = readdirSync(join(runsDir, ARCHIVE_DIR), { withFileTypes: true })
          .filter((a) => a.isDirectory() && isValidRunId(a.name))
          .map((a) => a.name);
      } catch {
        archiveNames = [];
      }
      continue;
    }
    const dir = join(runsDir, d.name);
    out.push({ runId: d.name, dir, archived: false, sig: signature(dir) });
  }
  // The whole top level first, then the archive: readdir order must not decide
  // which of two directories sharing an id this service ingests.
  const seen = new Set(out.map((e) => e.runId));
  for (const name of archiveNames) {
    const dir = join(runsDir, ARCHIVE_DIR, name);
    if (seen.has(name)) {
      onDuplicate?.(name, dir, join(runsDir, name));
      continue;
    }
    seen.add(name);
    out.push({ runId: name, dir, archived: true, sig: signature(dir) });
  }
  return out;
}
