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
 * (`run-reader.ts`, `viewer/runs-source.ts`); the trajectory keeps the
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
  type OwnGuid,
  type PartySignal,
  type SessionFile,
  type StreamName,
  type StreamRows,
} from "@wrathbench/mcp/record";
import { fanoutSessionDir, SESSIONS_DIR } from "./run-reader";
import { stackCommit } from "./version";

/** The session record's directory inside a run directory. */
export const SESSION_DIR = "session";

export function sessionDirOf(runDir: string): string {
  return join(runDir, SESSION_DIR);
}

/**
 * Where a fan-out run keeps its records: one session directory per
 * character, `sessions/<Character>/`, named by the character as the server
 * spells it (Shard/wrath-mcp#29). A run has `session/` or `sessions/`, never
 * both: one agent with one character is `session/`, exactly as it was.
 */
export { SESSIONS_DIR };

export function characterSessionDir(runDir: string, character: string): string {
  // A name is letters only; anything else never becomes a path (`run-reader.ts` owns the rule its readers resolve by).
  const dir = fanoutSessionDir(runDir, character);
  if (dir === null) throw new Error(`not a character name: ${JSON.stringify(character)}`);
  return dir;
}

/** A fan-out run's session directories, one per character; none for a single-character run. */
export function characterSessionDirs(runDir: string): string[] {
  try {
    return readdirSync(join(runDir, SESSIONS_DIR)).map((name) => join(runDir, SESSIONS_DIR, name));
  } catch {
    return [];
  }
}

/**
 * Remove a run's ring of nearby units, whatever is in it. The writer removes
 * it when the session closes; this is for the exits that never reach that (a
 * backstop `process.exit`) and for the archiver. Never throws.
 */
export function removeSessionRing(runDir: string): void {
  for (const dir of [sessionDirOf(runDir), ...characterSessionDirs(runDir)]) {
    try {
      rmSync(join(dir, "nearby"), { recursive: true, force: true });
    } catch {
      /* already gone, or a read-only disk the writer could not have used either */
    }
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
  /** Deaths and quests completed, counted as written: what a program-loop wake says changed while the model slept. */
  private deaths = 0;
  private quests = 0;
  /** Told of each death as it is written: a death wakes a sleeping model on the program loop (`wake.ts`). */
  onDeath: ((ts: number) => void) | undefined;

  /** Deaths and quests completed written so far (`ProgramWake`). */
  counts(): { deaths: number; quests: number } {
    return { deaths: this.deaths, quests: this.quests };
  }

  /** `SessionWriter.onRows`. */
  readonly onRows = <S extends StreamName>(stream: S, rows: StreamRows[S][]): void => {
    if (stream !== "events") return;
    for (const row of rows as EventRow[]) {
      if (row.kind === "death") {
        this.deaths++;
        this.onDeath?.(row.ts);
        continue;
      }
      if (row.kind === "quest") {
        this.quests++;
        continue;
      }
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

/** The gate's own set: the seeded guids first, then whatever the index finds. */
function seededOwn(seed: readonly string[], index: OwnGuid): OwnGuid {
  if (seed.length === 0) return index;
  const known = new Set(seed);
  return (guid) => known.has(guid) || index(guid);
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
  /**
   * Character guids that are the deployment's own before any record names
   * them: a party's members, which the stager created and the launch carries
   * (`partyOwnGuids(config.party)`). Read from the run's config, so a resume
   * has them too.
   */
  ownGuids?: readonly string[];
  token: string;
  /** The run's secret scrub, applied to every line written. */
  scrub: (text: string) => string;
  module?: SessionFile["module"];
  /**
   * A fan-out run's character: its record goes in `sessions/<character>/`
   * rather than `session/`, and `token` is that character's own.
   */
  character?: string;
  /** The signals to feed, when several records share one drain (a fan-out run's characters). */
  signals?: RecordSignals;
}

/**
 * Open the run's session record in `<runDir>/session/`. The session id is the
 * token's fingerprint, the name the module's audit files use; the token
 * itself is never written. The deployment's own characters are the ones the
 * other runs' records name, which is what lets a party's members be written
 * in each other's group rows.
 */
export function openSessionRecord(o: OpenSessionRecordOptions): SessionRecord {
  const signals = o.signals ?? new RecordSignals();
  const commit = stackCommit();
  const writer = new SessionWriter({
    dir: o.character !== undefined ? characterSessionDir(o.runDir, o.character) : sessionDirOf(o.runDir),
    id: tokenFingerprint(o.token),
    stack: { version: SDK_VERSION, ...(commit !== undefined ? { commit } : {}) },
    ...(o.module !== undefined ? { module: o.module } : {}),
    own: seededOwn(
      o.ownGuids ?? [],
      ownGuidIndex(() => {
        try {
          // Every run's one record, and every character's of a fan-out run.
          return readdirSync(o.runsDir).flatMap((run) => [join(o.runsDir, run, SESSION_DIR), ...characterSessionDirs(join(o.runsDir, run))]);
        } catch {
          return [];
        }
      }),
    ),
    scrub: o.scrub,
    // Struck by the writer itself: a snippet can print `sdk.token`, and the record must not hold it.
    token: o.token,
    onRows: signals.onRows,
  });
  writer.open();
  return { writer, signals };
}
