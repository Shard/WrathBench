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
 * Every run directory, including the archive.
 *
 * The viewer skips `archive/` because an archived run is one nobody should
 * see again; the scheduler reads it and has to (`readRunFacts`,
 * `includeArchived`). This store serves both, so it ingests both and marks
 * which is which — the filter belongs in the query, not in the ingestion.
 */
export function listRunDirs(runsDir: string): RunDirEntry[] {
  const out: RunDirEntry[] = [];
  let top: Dirent<string>[];
  try {
    top = readdirSync(runsDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of top) {
    if (!d.isDirectory() || !isValidRunId(d.name)) continue;
    if (d.name === ARCHIVE_DIR) {
      const archiveDir = join(runsDir, ARCHIVE_DIR);
      let inner: Dirent<string>[];
      try {
        inner = readdirSync(archiveDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const a of inner) {
        if (!a.isDirectory() || !isValidRunId(a.name)) continue;
        const dir = join(archiveDir, a.name);
        out.push({ runId: a.name, dir, archived: true, sig: signature(dir) });
      }
      continue;
    }
    const dir = join(runsDir, d.name);
    out.push({ runId: d.name, dir, archived: false, sig: signature(dir) });
  }
  return out;
}
