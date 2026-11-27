/**
 * Whom a camera follows. A camera sits in one world's pod, so its candidates
 * are the live runs on that world: an eval world's attempt (`CAMERA_WORLD` is
 * the world's id, which the run's `world.json` pointer names), or the shared
 * world's freeplay characters (`shared`). Newest first; a fan-out run, whose
 * characters are sessions of their own, is left to a later camera.
 *
 * A run is live while it has no verdict, no pause standing and a fresh
 * heartbeat (docs/RUNBOOK.md, "Is a run live").
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HEARTBEAT_DEAD_MS, heartbeatAt } from "../../runner/src/heartbeat";
import { readWorldPointer, SHARED_WORLD } from "../world";

export interface Subject {
  runId: string;
  runDir: string;
  /** The character's name as the server spells it: what `.appear` takes. */
  character: string;
  sessionDir: string;
  startedAt: number;
}

interface MetaRead {
  startedAt?: unknown;
  termination?: unknown;
  pauseReason?: unknown;
  config?: { character?: unknown; world?: unknown; fanout?: unknown };
}

function readMeta(dir: string): MetaRead | null {
  try {
    return JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as MetaRead;
  } catch {
    return null;
  }
}

/** The world a run plays on: its pointer, else its config, else the shared one. */
export function worldOfRun(dir: string, meta: MetaRead): string {
  return readWorldPointer(dir) ?? (typeof meta.config?.world === "string" ? meta.config.world : SHARED_WORLD);
}

/** Why a run is not a subject now, or null when it is one. */
export function notLive(dir: string, meta: MetaRead | null, now: number): string | null {
  if (meta === null) return "no meta.json";
  if (meta.termination !== undefined && meta.termination !== null) return "ended";
  if (typeof meta.pauseReason === "string") return "paused";
  const beat = heartbeatAt(dir);
  if (beat === null || now - beat >= HEARTBEAT_DEAD_MS) return "no owner";
  return null;
}

/** The live runs on `world`, newest first. */
export function subjectsOn(runsDir: string, world: string, now: number): Subject[] {
  let names: string[];
  try {
    names = readdirSync(runsDir);
  } catch {
    return [];
  }
  const out: Subject[] = [];
  for (const runId of names) {
    const runDir = join(runsDir, runId);
    // A cheap gate first: a run with no fresh heartbeat is no subject.
    const beat = heartbeatAt(runDir);
    if (beat === null || now - beat >= HEARTBEAT_DEAD_MS) continue;
    const meta = readMeta(runDir);
    if (notLive(runDir, meta, now) !== null || meta === null) continue;
    if (meta.config?.fanout !== undefined && meta.config.fanout !== null) continue;
    if (worldOfRun(runDir, meta) !== world) continue;
    const character = meta.config?.character;
    if (typeof character !== "string" || !/^[A-Za-z]{2,12}$/.test(character)) continue;
    const sessionDir = join(runDir, "session");
    if (!existsSync(join(sessionDir, "session.json"))) continue;
    out.push({ runId, runDir, character, sessionDir, startedAt: typeof meta.startedAt === "number" ? meta.startedAt : 0 });
  }
  return out.sort((a, b) => b.startedAt - a.startedAt || (a.runId < b.runId ? 1 : -1));
}

/** One named run as a subject, live or not (a hand-run camera's `--run`). */
export function subjectOf(runsDir: string, runId: string): Subject | null {
  const runDir = join(runsDir, runId);
  const meta = readMeta(runDir);
  const character = meta?.config?.character;
  if (meta === null || typeof character !== "string") return null;
  return { runId, runDir, character, sessionDir: join(runDir, "session"), startedAt: typeof meta.startedAt === "number" ? meta.startedAt : 0 };
}
