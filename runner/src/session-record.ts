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
 * The bridge. The scorer, the collector and the feed still read the
 * trajectory's `milestone` records and run.sqlite's `state` rows, and the
 * feed the trajectory's `move` records; they move onto the record in the
 * next phase. (The collector's `moves` table is filled from a 0.5 run's
 * `move` table only, so a v1 run has none there yet and the viewer reads its
 * moves from the record.) Until then `RecordSignals`
 * takes the rows the stack wrote (after its write gate, so exactly what is
 * on disk) and hands the loop the death, flight and party transitions in the
 * shapes it has always drained, and the run mirrors each movement intention
 * into the trajectory. Nothing here records anything of its own.
 */

import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SDK_VERSION } from "@wrathbench/sdk";
import { tokenFingerprint } from "@wrathbench/mcp/module-auth";
import {
  SessionWriter,
  ownGuidIndex,
  type CallRow,
  type DeathSignal,
  type EventRow,
  type FlightSignal,
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

/** A recorded movement intention as the trajectory's `move` record mirrors it (`MoveLine`): the target by its client-cache name, as 0.5 wrote it. */
export function moveLineOf(m: RecordedMoveRow): { ts: number; moveId: number | null; map: number | null; x: number; y: number; z: number; target: string | null; status: string | null } {
  return { ts: m.ts, moveId: m.moveId, map: m.map, x: m.x, y: m.y, z: m.z, target: m.name ?? null, status: m.status };
}

/** Keep the newest this many undrained of each; a loop that stops draining loses the oldest. */
const SIGNAL_CAP = 256;

/** One movement intention as the stack recorded it: the dispatch, or its verdict. */
export type RecordedMoveRow = Extract<CallRow, { kind: "move" }>;

/**
 * The transitions the stack recorded since the loop last asked, as the loop
 * drains them. Fed by `SessionWriter.onRows`, so it holds what was written
 * and nothing else: a group's members are the deployment's own sessions, and
 * a foreign killer has no guid.
 */
export class RecordSignals {
  private readonly death: DeathSignal[] = [];
  private readonly flight: FlightSignal[] = [];
  private readonly party: PartySignal[] = [];
  /** Called with each movement intention written, for the trajectory's `move` record. */
  onMove: ((row: RecordedMoveRow) => void) | undefined;

  /** `SessionWriter.onRows`. */
  readonly onRows = <S extends StreamName>(stream: S, rows: StreamRows[S][]): void => {
    if (stream === "events") for (const row of rows as EventRow[]) this.event(row);
    else if (stream === "calls") {
      for (const row of rows as CallRow[]) if (row.kind === "move") this.onMove?.(row);
    }
  };

  private push<T>(queue: T[], signal: T): void {
    queue.push(signal);
    if (queue.length > SIGNAL_CAP) queue.splice(0, queue.length - SIGNAL_CAP);
  }

  private event(row: EventRow): void {
    const seq = row.seq ?? -1;
    switch (row.kind) {
      case "death":
        this.push(this.death, {
          kind: "death",
          ts: row.ts,
          seq,
          ...(row.position !== undefined ? { position: row.position } : {}),
          ...(row.zone !== undefined ? { zone: row.zone } : {}),
          ...(row.area !== undefined ? { area: row.area } : {}),
          ...(row.released !== undefined ? { released: row.released } : {}),
        });
        return;
      case "release":
        this.push(this.death, { kind: "release", ts: row.ts, seq, ...(row.graveyard !== undefined ? { graveyard: row.graveyard } : {}) });
        return;
      case "resurrect":
        this.push(this.death, { kind: "resurrect", ts: row.ts, seq });
        return;
      case "taxi":
      case "taxi_landed":
        this.push(this.flight, {
          kind: row.kind,
          ts: row.ts,
          seq,
          ...(row.position !== undefined ? { position: row.position } : {}),
          ...(row.zone !== undefined ? { zone: row.zone } : {}),
          ...(row.area !== undefined ? { area: row.area } : {}),
        });
        return;
      case "group":
        this.push(this.party, {
          kind: "group",
          event: row.event,
          ...(row.groupGuid !== undefined ? { groupGuid: row.groupGuid } : {}),
          ...(row.leaderGuid !== undefined ? { leaderGuid: row.leaderGuid } : {}),
          members: row.members,
          count: row.count,
          ts: row.ts,
          seq,
        });
        return;
      case "instance":
        this.push(this.party, { kind: "instance", event: row.event, map: row.map, instanceType: row.instanceType, from: row.from, ts: row.ts, seq });
        return;
      case "kill":
        this.push(this.party, {
          kind: "kill",
          // A foreign killer's guid is never written; `self` and `member` still say whose kill it was.
          killerGuid: row.killerGuid ?? "",
          victimGuid: row.victimGuid,
          ...(row.entry !== undefined ? { entry: row.entry } : {}),
          ...(row.rank !== undefined ? { rank: row.rank } : {}),
          self: row.self,
          member: row.member,
          ts: row.ts,
          seq,
        });
        return;
      default:
        return;
    }
  }

  drainDeath(): DeathSignal[] {
    return this.death.splice(0, this.death.length);
  }

  drainFlight(): FlightSignal[] {
    return this.flight.splice(0, this.flight.length);
  }

  drainParty(): PartySignal[] {
    return this.party.splice(0, this.party.length);
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
