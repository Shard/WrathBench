/**
 * A Deadmines run's characters' milestones, for the dungeon board
 * (`dungeons.ts`): each character's kills, deaths, resurrections and first
 * entry into the instance, off its own session record's `events` stream. A
 * single-character run has one record (`session/`); a fan-out run one per
 * character (`sessions/<Character>/`), which the run tail does not read, so
 * this goes through the runs source's handles for both.
 *
 * Read-only like the rest of the viewer. An ended run's marks never change,
 * so they are kept once read; a live one is read again each time.
 */

import { join } from "node:path";
import type { SessionHandle } from "@wrathbench/inspector";
import type { CharacterMarks } from "./dungeons";
import { DEADMINES_MAP } from "./dungeons";
import { fanoutSession, fanoutSessions, isFanoutRun, runSession } from "./runs-source";

const KINDS = ["kill", "death", "resurrect", "instance"] as const;

/** One session's marks. */
async function marksOf(handle: SessionHandle, character: string): Promise<CharacterMarks> {
  const out: CharacterMarks = { character, kills: [], deaths: [], resurrects: [], entered: null };
  let segments;
  try {
    segments = await handle.segments("events");
  } catch {
    return out;
  }
  const batches = await handle.read("events", segments, { kinds: KINDS }).catch(() => []);
  for (const rows of batches) {
    for (const row of rows as { kind: string; ts: number; victimGuid?: string; entry?: number; event?: string; map?: number }[]) {
      if (row.kind === "kill" && typeof row.victimGuid === "string") out.kills.push({ ts: row.ts, victimGuid: row.victimGuid, entry: typeof row.entry === "number" ? row.entry : null });
      else if (row.kind === "death") out.deaths.push(row.ts);
      else if (row.kind === "resurrect") out.resurrects.push(row.ts);
      else if (row.kind === "instance" && row.event === "entered" && row.map === DEADMINES_MAP && (out.entered === null || row.ts < out.entered)) out.entered = row.ts;
    }
  }
  return out;
}

const ended = new Map<string, CharacterMarks[]>();

/** A run's characters' marks: one for a single-character run, one per character for a fan-out run. */
export async function dungeonMarksOf(runsDir: string, runId: string, o: { ended: boolean; character: string | null }): Promise<CharacterMarks[]> {
  const key = join(runsDir, runId);
  const kept = ended.get(key);
  if (kept !== undefined) return kept;
  let marks: CharacterMarks[];
  if (isFanoutRun(runsDir, runId)) {
    marks = [];
    for (const s of fanoutSessions(runsDir, runId)) {
      const h = fanoutSession(runsDir, s.id);
      if (h !== null) marks.push(await marksOf(h, s.character));
    }
  } else {
    marks = [await marksOf(runSession(runsDir, runId), o.character ?? runId)];
  }
  if (o.ended) ended.set(key, marks);
  return marks;
}
