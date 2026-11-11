/**
 * The run's session record: where the stack writes what the character did
 * (`wrath-mcp/docs/SESSION-FORMAT.md`), and what the runner still takes from
 * it while its own readers catch up.
 *
 * The stack records; the runner hands it a place. A run is its own evidence,
 * so the place is inside the run directory, `data/runs/<id>/session/`, and
 * the record is written there as it happens: there is no copy step, and no
 * moment at which the evidence exists only in a store someone else prunes. A
 * run directory with `session/session.json` is a v1 run; one without is a
 * 0.5 run, read through `viewer/legacy05-source.ts`.
 *
 * The run's readers take everything game-side from here
 * (`run-reader.ts`, `viewer/session-source.ts`); the trajectory keeps the
 * model side only. The one thing the runner takes from the record while the
 * run plays is the kills: `RecordSignals` hands the loop each `kill` row the
 * stack wrote (after its write gate, so exactly what is on disk), and the
 * watchdogs end a campaign on the one it targets. Nothing here records
 * anything of its own.
 */

import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SDK_VERSION } from "@wrathbench/sdk";
import { tokenFingerprint } from "@wrathbench/mcp/module-auth";
import {
  SessionWriter,
  ownGuidIndex,
  type EventRow,
  type PartySignal,
  type SessionFile,
  type StreamName,
  type StreamRows,
} from "@wrathbench/mcp/record";
import { stackCommit } from "./version";

/** The session record's directory inside a run directory. */
export const SESSION_DIR = "session";

export function sessionDirOf(runDir: string): string {
  return join(runDir, SESSION_DIR);
}

/**
 * Remove a run's ring of nearby units, whatever is in it. The writer removes
 * it when the session closes; this is for the exits that never reach that (a
 * backstop `process.exit`) and for the archiver. Never throws.
 */
export function removeSessionRing(runDir: string): void {
  try {
    rmSync(join(sessionDirOf(runDir), "nearby"), { recursive: true, force: true });
  } catch {
    /* already gone, or a read-only disk the writer could not have used either */
  }
}

/** Keep the newest this many undrained; a loop that stops draining loses the oldest. */
const SIGNAL_CAP = 256;

/**
 * The kills the stack recorded since the loop last asked, as the loop drains
 * them. Fed by `SessionWriter.onRows`, so it holds what was written and
 * nothing else: a foreign killer has no guid.
 */
export class RecordSignals {
  private readonly kills: PartySignal[] = [];

  /** `SessionWriter.onRows`. */
  readonly onRows = <S extends StreamName>(stream: S, rows: StreamRows[S][]): void => {
    if (stream !== "events") return;
    for (const row of rows as EventRow[]) {
      if (row.kind !== "kill") continue;
      this.kills.push({
        kind: "kill",
        // A foreign killer's guid is never written; `self` and `member` still say whose kill it was.
        killerGuid: row.killerGuid ?? "",
        victimGuid: row.victimGuid,
        ...(row.entry !== undefined ? { entry: row.entry } : {}),
        ...(row.rank !== undefined ? { rank: row.rank } : {}),
        self: row.self,
        member: row.member,
        ts: row.ts,
        seq: row.seq ?? -1,
      });
      // A loop that stops draining loses the oldest.
      if (this.kills.length > SIGNAL_CAP) this.kills.splice(0, this.kills.length - SIGNAL_CAP);
    }
  };

  drainKills(): PartySignal[] {
    return this.kills.splice(0, this.kills.length);
  }
}

/** The run's session record, opened: the writer the stack records through, and the bridge's signals. */
export interface SessionRecord {
  writer: SessionWriter;
  signals: RecordSignals;
}

export interface OpenSessionRecordOptions {
  runDir: string;
  /** The directory every run of this deployment lives in: its sessions are the own ones. */
  runsDir: string;
  token: string;
  /** The run's secret scrub, applied to every line written. */
  scrub: (text: string) => string;
  module?: SessionFile["module"];
}

/**
 * Open the run's session record in `<runDir>/session/`. The session id is the
 * token's fingerprint, the name the module's audit files use; the token
 * itself is never written. The deployment's own characters are the ones the
 * other runs' records name, which is what lets a party's members be written
 * in each other's group rows.
 */
export function openSessionRecord(o: OpenSessionRecordOptions): SessionRecord {
  const signals = new RecordSignals();
  const commit = stackCommit();
  const writer = new SessionWriter({
    dir: sessionDirOf(o.runDir),
    id: tokenFingerprint(o.token),
    stack: { version: SDK_VERSION, ...(commit !== undefined ? { commit } : {}) },
    ...(o.module !== undefined ? { module: o.module } : {}),
    own: ownGuidIndex(() => {
      try {
        return readdirSync(o.runsDir).map((run) => join(o.runsDir, run, SESSION_DIR));
      } catch {
        return [];
      }
    }),
    scrub: o.scrub,
    // Struck by the writer itself: a snippet can print `sdk.token`, and the record must not hold it.
    token: o.token,
    onRows: signals.onRows,
  });
  writer.open();
  return { writer, signals };
}
