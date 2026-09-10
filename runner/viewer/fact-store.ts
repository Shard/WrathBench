/**
 * The per-run fact cache, persisted across process starts.
 *
 * `readRunFactsCached` (models.ts) memoises one `RunFact` per run on the
 * `(size, mtime)` signature of its two artefacts, because reading every
 * trajectory in full to count model responses costs ~13s on the operator's
 * corpus and a poll happens every thirty seconds. That memo lives in a
 * closure, so every viewer restart — and `bun ship --publisher`, and every
 * deploy — pays the fill again (FOLLOW-UPS item 115).
 *
 * A finished run's files never change, so its fact is not merely stable within
 * a process: it is stable forever. This writes the memo to a file and reads it
 * back on the next start. Nothing about the rule changes — every entry read
 * from disk is still checked against the run's live signature by the same
 * comparison the in-memory cache makes, so a run whose files moved is
 * recomputed and only that run is.
 *
 * Four properties the file has to have, and why:
 *
 * - **Versioned.** `FACT_CACHE_VERSION` invalidates the file when what a fact
 *   *contains* changes, which no `(size, mtime)` signature can notice — the
 *   files did not move, the code did. `runner/test/viewer-fact-store.test.ts`
 *   pins `RunFact`'s key list against a literal so that a field added to the
 *   fact fails a test naming this constant, rather than silently serving facts
 *   from before it existed.
 * - **Keyed to one corpus.** The runs directory is stamped in the file: a
 *   default path shared by two deployments must never serve one tree's facts
 *   for another's.
 * - **Written on a debounce, never only on shutdown.** The pod is killed, not
 *   asked. A change marks the store dirty and a short timer flushes it, so the
 *   worst case a `SIGKILL` costs is the last couple of seconds of counting.
 * - **Disposable.** Missing, truncated, half-written, from another version or
 *   another corpus — every one of those reads as "no cache" and the viewer
 *   recomputes. This file may never be the reason a page fails to serve.
 *
 * A live run is deliberately never persisted: its signature moves on every
 * poll, so a persisted entry would be stale before it was written, and
 * marking the store dirty for it would rewrite the file every thirty seconds
 * forever. Liveness is decided from the trajectory's mtime against `now` on
 * every call anyway (see `readRunFactsCached`), which is what makes a cached
 * fact safe to reuse at all.
 *
 * JSON rather than `bun:sqlite`, by measurement: the whole cache is 234 KiB
 * for the operator's 346 stamped runs (~0.7 KiB a run), so a whole-file
 * rewrite on a debounce costs less than the bookkeeping a row store would
 * need. The crossover is somewhere in the tens of MB — tens of thousands of
 * runs — at which point per-run rows and an incremental write start to matter
 * and this becomes a table.
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RunFact } from "../src/models";
import { LIVE_WINDOW_MS, type FactCacheEntry } from "./models";

/**
 * Bump when what a `RunFact` holds changes, or when how one is counted does.
 * A signature cannot see a code change, so this is the only thing that
 * invalidates facts read by an older build.
 */
export const FACT_CACHE_VERSION = 1;

/** How long a change waits before the file is rewritten. */
export const FLUSH_DEBOUNCE_MS = 2_000;

/**
 * Every key a `RunFact` has, sorted. The load path requires an exact match, so
 * a fact written by a build with a different shape is dropped even if someone
 * forgot the version bump; the test pins this list so they are told instead.
 */
export const FACT_KEYS: readonly string[] = [
  "account",
  "bestLevel",
  "campaign",
  "cell",
  "character",
  "effort",
  "endedAt",
  "episode",
  "episodeMs",
  "episodeOverride",
  "extra",
  "harnessSeries",
  "harnessVersion",
  "live",
  "model",
  "modelResponses",
  "pause",
  "runId",
  "startedAt",
  "subscription",
  "terminationReason",
];

/** The default file, a sibling of the runs directory the viewer only reads. */
export function defaultFactCachePath(runsDir: string): string {
  return join(runsDir, "..", "fact-cache.json");
}

export interface FactStore {
  /** The memo itself, handed straight to `readRunFactsCached`. */
  cache: Map<string, FactCacheEntry>;
  /** Told by `readRunFactsCached` that an entry was written or dropped. */
  onChange: (id: string, entry: FactCacheEntry | null) => void;
  /** Write now, if anything is pending. Safe to call on a store with no path. */
  flush: () => void;
  /** Where the file is, or undefined when this store is memory-only. */
  path: string | undefined;
  /** How many entries came off disk at construction — what a warm start saved. */
  loaded: number;
}

interface CacheFile {
  version: number;
  runsDir: string;
  writtenAt: number;
  entries: Record<string, { sig: string; mtime: number | null; fact: RunFact | null }>;
}

/** Whether an entry is stable enough to be worth writing down (see the header). */
function persistable(entry: FactCacheEntry, now: number): boolean {
  return entry.mtime === null || now - entry.mtime >= LIVE_WINDOW_MS;
}

function isRunFact(value: unknown): value is RunFact {
  if (typeof value !== "object" || value === null) return false;
  const keys = Object.keys(value).sort();
  if (keys.length !== FACT_KEYS.length) return false;
  return keys.every((k, i) => k === FACT_KEYS[i]);
}

/**
 * Read the file, or decide there isn't one.
 *
 * Every failure mode lands in the same place — an empty map — because the only
 * cost of being wrong here is recomputing, and the cost of being credulous is
 * serving a number from a tree or a build this one is not.
 */
function load(path: string, runsDir: string): Map<string, FactCacheEntry> {
  const empty = new Map<string, FactCacheEntry>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return empty;
  }
  if (typeof parsed !== "object" || parsed === null) return empty;
  const file = parsed as Partial<CacheFile>;
  if (file.version !== FACT_CACHE_VERSION) return empty;
  if (file.runsDir !== runsDir) return empty;
  const entries = file.entries;
  if (typeof entries !== "object" || entries === null) return empty;
  const out = new Map<string, FactCacheEntry>();
  for (const [id, raw] of Object.entries(entries)) {
    if (typeof raw !== "object" || raw === null) continue;
    const { sig, mtime, fact } = raw as { sig?: unknown; mtime?: unknown; fact?: unknown };
    if (typeof sig !== "string") continue;
    if (mtime !== null && typeof mtime !== "number") continue;
    if (fact !== null && !isRunFact(fact)) continue;
    out.set(id, { sig, mtime, fact: fact as RunFact | null });
  }
  return out;
}

/**
 * The persisted fact cache, or a plain in-memory one when no path is given.
 *
 * No path is the default everywhere but the two long-lived services: a test,
 * a one-shot render and anything else that builds a handle behaves exactly as
 * it did before this existed, writing nothing.
 */
export function createFactStore(
  runsDir: string,
  path?: string,
  opts: { debounceMs?: number } = {},
): FactStore {
  const cache = path === undefined ? new Map<string, FactCacheEntry>() : load(path, runsDir);
  const loaded = cache.size;
  const debounceMs = opts.debounceMs ?? FLUSH_DEBOUNCE_MS;
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** One line per process, not one per failed write: a full disk is not a log flood. */
  let warned = false;

  const write = (): void => {
    if (path === undefined || !dirty) return;
    dirty = false;
    const now = Date.now();
    const entries: CacheFile["entries"] = {};
    for (const [id, entry] of cache) {
      if (!persistable(entry, now)) continue;
      entries[id] = { sig: entry.sig, mtime: entry.mtime, fact: entry.fact };
    }
    const body: CacheFile = { version: FACT_CACHE_VERSION, runsDir, writtenAt: now, entries };
    // A tmp beside the target, so the rename is atomic rather than a copy
    // across devices; the pid keeps two writers (viewer and publisher may
    // share a default path) off each other's file.
    const tmp = `${path}.tmp-${process.pid}`;
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(tmp, JSON.stringify(body));
      renameSync(tmp, path);
    } catch (err) {
      if (!warned) {
        warned = true;
        console.warn(`viewer: fact cache not written to ${path}: ${err instanceof Error ? err.message : String(err)}`);
      }
      try {
        unlinkSync(tmp);
      } catch {
        // The tmp may never have been created; nothing to clean up.
      }
    }
  };

  const onChange = (_id: string, entry: FactCacheEntry | null): void => {
    if (path === undefined) return;
    // A dropped run is a change worth writing; a live run's is not (header).
    if (entry !== null && !persistable(entry, Date.now())) return;
    dirty = true;
    if (timer !== undefined) return;
    // Not reset by later changes: the flush is at most `debounceMs` behind the
    // first pending one, whatever else arrives meanwhile.
    timer = setTimeout(() => {
      timer = undefined;
      write();
    }, debounceMs);
    // The cache must never be the reason a process stays up.
    timer.unref?.();
  };

  const flush = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    write();
  };

  return { cache, onChange, flush, path, loaded };
}
