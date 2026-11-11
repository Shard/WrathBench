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
 * - A **fan-out** run, one agent driving several characters, keeps one
 *   record per character in `<run>/sessions/<Character>/` and has no
 *   `session/`: each is a session of its own, under `<run-id>~<Character>`.
 *
 * A single-character run's session id is its run's id, which is also what
 * every packed window carries as `run`. A fan-out character's is the run id,
 * `~` and the character's name, and its windows carry that: `~` never occurs
 * in a run id (`isValidRunId` in `runs.ts` allows letters, digits, `.`, `_`
 * and `-`), so the split is unambiguous, and it needs no escaping in a URL
 * path. A fan-out run's own id opens nothing, since no one character is the
 * run, and its sessions are listed with the run id as their `group`.
 *
 * Every v1 record's `session.json` is presented with its `id` replaced by the
 * session's id as defined here, so the listing and the detail agree with the
 * handle: the record's own `id` is the session token's fingerprint, the stem
 * of the module's audit files, and no response of the viewer (which has no
 * login) names one. The stack's own bin keys a bare store by that id and
 * stays as it is. The viewer serves its handle as the operator; nothing it
 * serves is scoped to a user.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { StoredSessionHandle, inScope, type SessionEntry, type SessionHandle, type SessionScope, type SessionSource } from "@wrathbench/inspector";
import type { SessionFile } from "@wrathbench/mcp/record";
import { fanoutCharacters, fanoutSessionDir, isFanoutRunDir, SESSIONS_DIR } from "../src/run-reader";
import { legacy05Session } from "./legacy05-source";
import { runDir } from "./runs";

export { SESSIONS_DIR };

/** The session record's directory inside a run directory (`runner/src/session-record.ts`). */
export const SESSION_DIR = "session";

/** What joins a fan-out run's id to one of its characters' names in a session id. */
export const FANOUT_SEP = "~";

/** Whether a run directory holds a single-character v1 session record. */
export function isV1Run(runsDir: string, runId: string): boolean {
  return existsSync(join(runsDir, runId, SESSION_DIR, "session.json"));
}

/** Whether a run is a fan-out run (`isFanoutRunDir`): several characters, a record each. */
export function isFanoutRun(runsDir: string, runId: string): boolean {
  return isFanoutRunDir(join(runsDir, runId));
}

/** A fan-out character's session id. */
export function fanoutSessionId(runId: string, character: string): string {
  return `${runId}${FANOUT_SEP}${character}`;
}

/** A fan-out run's sessions, one per character with a record, in name order; empty for any other run. */
export function fanoutSessions(runsDir: string, runId: string): { id: string; character: string }[] {
  return fanoutCharacters(join(runsDir, runId)).map((character) => ({ id: fanoutSessionId(runId, character), character }));
}

/**
 * A v1 session record, a single-character run's or a fan-out character's,
 * read as the stack wrote it but for `session.json`'s `id`, which reads as the
 * handle's id (the run id, or `<run-id>~<Character>`): the session's id as
 * WrathBench defines it, never the token's fingerprint.
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
 * nothing, never as an error, and so does a fan-out run, whose run id is no
 * one character's: its routes that read "the run's session" answer empty.
 */
export function runSession(runsDir: string, runId: string): SessionHandle {
  return isV1Run(runsDir, runId) ? new RunSessionHandle(runId, join(runsDir, runId, SESSION_DIR)) : legacy05Session(runsDir, runId);
}

/**
 * One fan-out character's session, by its id (`<run-id>~<Character>`), or
 * null when the id is not one: a run that is not a fan-out run, a name that
 * is not letters only, or a character with no record there.
 */
function fanoutSession(runsDir: string, id: string): SessionHandle | null {
  const at = id.indexOf(FANOUT_SEP);
  if (at < 0) return null;
  const runId = id.slice(0, at);
  const dir = runDir(runsDir, runId);
  if (dir === null || !isFanoutRunDir(dir)) return null;
  const sessionDir = fanoutSessionDir(dir, id.slice(at + FANOUT_SEP.length));
  if (sessionDir === null || !existsSync(join(sessionDir, "session.json"))) return null;
  return new RunSessionHandle(id, sessionDir);
}

/**
 * The runs directory as a source: a session per run that has a v1 record and
 * one per character of a fan-out run, listed newest opened first, and every
 * run, 0.5 ones included, opened by its id. A 0.5 run is never listed,
 * because it has no `session.json` to list it by; it still opens. A fan-out
 * run's id opens nothing; its characters' ids do.
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
        if (runDir(runsDir, name) === null) continue;
        if (isV1Run(runsDir, name)) {
          const h = runSession(runsDir, name);
          const session = await h.session();
          if (session === null || !inScope(session, scope)) continue;
          out.push({ id: name, session, live: await h.live() });
          continue;
        }
        if (!isFanoutRun(runsDir, name)) continue;
        for (const { id } of fanoutSessions(runsDir, name)) {
          const h = fanoutSession(runsDir, id);
          const session = h === null ? null : await h.session();
          if (h === null || session === null || !inScope(session, scope)) continue;
          out.push({ id, session, live: await h.live(), group: name });
        }
      }
      return out.sort((a, b) => b.session.opened - a.session.opened);
    },
    async open(id: string, scope: SessionScope): Promise<SessionHandle | null> {
      let h: SessionHandle | null;
      if (id.includes(FANOUT_SEP)) h = fanoutSession(runsDir, id);
      else if (runDir(runsDir, id) === null || isFanoutRun(runsDir, id)) h = null;
      else h = runSession(runsDir, id);
      if (h === null) return null;
      // A 0.5 run has no `session.json` and is the operator's; a v1 run or a fan-out character is whoever its record names.
      if (scope.kind !== "operator" && !inScope(await h.session(), scope)) return null;
      return h;
    },
  };
}
