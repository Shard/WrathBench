/**
 * The runs as the inspector reads them: WrathBench's implementation of the
 * inspector's `SessionSource` (`@wrathbench/inspector`), over the runs
 * directory. Everything that reads a run's session side (the trace, the ring
 * of nearby units, the movement intentions) asks this, and the inspector's
 * readout does the rest, so the codecs and the API are the same for a run as
 * for a session in a bare store.
 *
 * - A **v1** run keeps its session record in `<run>/session/`, written by the
 *   stack (`wrath-mcp/docs/SESSION-FORMAT.md`): read with the inspector's
 *   own store reader, under the run's id.
 * - A **0.5** run has none: its trace and moves are tables of `run.sqlite`
 *   and its ring is one-minute files in `<run>/nearby/`. `legacy05-source.ts`
 *   reads those and presents them as the v1 record's rows. Nothing on disk is
 *   converted; a 0.5 run stays readable, not comparable.
 *
 * A session's id here is its run's id (one character per run), which is also
 * what every packed window carries as `run`. A v1 run's `session.json` is
 * presented with its `id` replaced by the run id, so the listing and the
 * detail agree with the handle: the record's own `id` is the session token's
 * fingerprint, the stem of the module's audit files, and no response of the
 * viewer (which has no login) names one. The stack's own bin keys a bare
 * store by that id and stays as it is. The viewer serves its handle as the
 * operator; nothing it serves is scoped to a user.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { StoredSessionHandle, inScope, type SessionEntry, type SessionHandle, type SessionScope, type SessionSource } from "@wrathbench/inspector";
import type { SessionFile } from "@wrathbench/mcp/record";
import { legacy05Session } from "./legacy05-source";
import { runDir } from "./runs";

/** The session record's directory inside a run directory (`runner/src/session-record.ts`). */
export const SESSION_DIR = "session";

/** Whether a run directory holds a v1 session record. */
export function isV1Run(runsDir: string, runId: string): boolean {
  return existsSync(join(runsDir, runId, SESSION_DIR, "session.json"));
}

/**
 * A v1 run's session record, read as the stack wrote it but for `session.json`'s
 * `id`, which reads as the run id: the session's id as WrathBench defines it,
 * never the token's fingerprint.
 */
class RunSessionHandle extends StoredSessionHandle {
  override async session(): Promise<SessionFile | null> {
    const s = await super.session();
    return s === null ? null : { ...s, id: this.id };
  }
}

/**
 * A run's session, opened by its id, whatever it recorded: its record when it
 * has one, else the 0.5 readers. A run with nothing reads as having recorded
 * nothing, never as an error.
 */
export function runSession(runsDir: string, runId: string): SessionHandle {
  return isV1Run(runsDir, runId) ? new RunSessionHandle(runId, join(runsDir, runId, SESSION_DIR)) : legacy05Session(runsDir, runId);
}

/**
 * The runs directory as a source: a session per run that has a v1 record,
 * listed newest opened first, and every run, 0.5 ones included, opened by
 * its id. A 0.5 run is never listed, because it has no `session.json` to list
 * it by; it still opens.
 */
export function runsSource(runsDir: string): SessionSource {
  return {
    async list(scope: SessionScope): Promise<SessionEntry[]> {
      let names: string[];
      try {
        names = readdirSync(runsDir);
      } catch {
        return [];
      }
      const out: SessionEntry[] = [];
      for (const name of names) {
        if (runDir(runsDir, name) === null || !isV1Run(runsDir, name)) continue;
        const h = runSession(runsDir, name);
        const session = await h.session();
        if (session === null || !inScope(session, scope)) continue;
        out.push({ id: name, session, live: await h.live() });
      }
      return out.sort((a, b) => b.session.opened - a.session.opened);
    },
    async open(id: string, scope: SessionScope): Promise<SessionHandle | null> {
      if (runDir(runsDir, id) === null) return null;
      const h = runSession(runsDir, id);
      // A 0.5 run has no `session.json` and is the operator's; a v1 run is whoever its record names.
      if (scope.kind !== "operator" && !inScope(await h.session(), scope)) return null;
      return h;
    },
  };
}
