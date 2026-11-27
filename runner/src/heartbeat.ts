/**
 * The run's heartbeat: the one small file a runner rewrites while its process
 * lives, and what every reader decides a live owner by. Its own module so a
 * reader (the scheduler's run facts, the viewer) need not load the trajectory
 * writer to know whether a run has an owner; `trajectory.ts` re-exports it.
 *
 * The proof that a run has a live owner. A trajectory's mtime cannot be that
 * proof: a run waiting on a slow provider, or a model in a long reflect, writes
 * nothing for as long as its request takes, and the idle watchdog is checked
 * between turns, so not even `idleMs` bounds the silence. The runner therefore
 * rewrites one small file on a timer for as long as its process exists, and
 * removes it on any exit it gets to make. Age is the whole test — never pid
 * liveness, because the reader may be on another pod or host, and the run this
 * exists for is one whose owner was SIGKILLed: its mark simply goes cold. The
 * content (host and pid) is for the operator reading a refusal, nothing else.
 */

import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const HEARTBEAT_FILE = "heartbeat";
/** How often a running runner rewrites its heartbeat. */
export const HEARTBEAT_EVERY_MS = 20_000;
/**
 * A heartbeat older than this has no owner: six missed beats, which also
 * absorbs a blocked event loop (a snippet's 30 s ceiling) and clock skew
 * between the pod that wrote it and the pod reading it.
 */
export const HEARTBEAT_DEAD_MS = 120_000;

/** When the run's owner last beat, or null when the run carries no heartbeat. */
export function heartbeatAt(dir: string): number | null {
  try {
    return statSync(join(dir, HEARTBEAT_FILE)).mtimeMs;
  } catch {
    return null;
  }
}

/** Who wrote the heartbeat ("host pid"), for a message; empty when unreadable. */
export function heartbeatOwner(dir: string): string {
  try {
    return readFileSync(join(dir, HEARTBEAT_FILE), "utf8").trim();
  } catch {
    return "";
  }
}

/**
 * Beat now and every `HEARTBEAT_EVERY_MS` until the returned stop is called
 * (or the process exits: the timer is unref'd and never keeps it alive). Stop
 * removes the file, so a clean exit leaves a run anyone may resume at once.
 */
export function startHeartbeat(dir: string, owner: string): () => void {
  const path = join(dir, HEARTBEAT_FILE);
  const beat = (): void => {
    try {
      writeFileSync(path, `${owner}\n`);
    } catch {
      /* a full or read-only disk costs the heartbeat, never the run */
    }
  };
  beat();
  const timer = setInterval(beat, HEARTBEAT_EVERY_MS);
  timer.unref();
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    try {
      rmSync(path, { force: true });
    } catch {
      /* already gone */
    }
  };
}
