/**
 * The facts of terminated runs, kept on disk across processes.
 *
 * The fleet supervisor reads every run directory at boot (`readRunFacts`,
 * archive included), and almost all of that time is counting the records of
 * trajectories that will never change again: on the live runs directory the
 * terminated runs were 32 of the 36 seconds before the first spawn. A
 * terminated run's fact is a function of its files alone — no `now` reaches
 * it, because `live` is false whatever the clock says — so it can be kept
 * under a key made of those files' stats and served until any of them moves.
 *
 * This file is only the store. What counts as a key and which facts may be
 * kept is `readRunFacts`' decision (`runFactKey`, `cacheableFact`), next to the
 * reader the key has to describe. The store's rule is that it never answers
 * with doubt: a file that is missing, unreadable, from another reader version
 * or not JSON is an empty cache, an entry whose key differs is a miss, and a
 * miss is the cold read the caller would have made anyway.
 *
 * Writes go to a temporary file beside it and are renamed over it, so a
 * reader sees the old file or the new one and never half of either, and a
 * crash mid-write leaves the old file in place. Two writers (an old fleet pod
 * still unwinding beside a new one) each rename a whole file of their own;
 * whichever lands last wins, and every entry in it is checked against the
 * files on disk again before it is served.
 */
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import type { RunFact } from "./models";

interface Entry {
  key: string;
  fact: RunFact;
}

export class RunFactCache {
  readonly path: string;
  /** The reader's identity (`runFactCacheVersion`): a file written by another reader is not read. */
  readonly version: string;
  private entries: Map<string, Entry> | undefined;
  private dirty = false;
  /** Why the last load or flush fell back, for a caller that logs it; undefined after one that did not. */
  failure: string | undefined;

  constructor(path: string, version: string) {
    this.path = path;
    this.version = version;
  }

  private load(): Map<string, Entry> {
    if (this.entries !== undefined) return this.entries;
    const entries = new Map<string, Entry>();
    this.entries = entries;
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch {
      return entries; // no file yet: every read is cold, and the first flush writes one
    }
    let doc: unknown;
    try {
      doc = JSON.parse(raw);
    } catch (e) {
      this.failure = `${this.path} is not JSON (${e instanceof Error ? e.message : String(e)}); reading every run cold`;
      this.dirty = true;
      return entries;
    }
    const d = doc as { version?: unknown; entries?: unknown } | null;
    if (d === null || typeof d !== "object" || d.version !== this.version || d.entries === null || typeof d.entries !== "object") {
      this.dirty = true; // another reader's file, or not this shape: replaced at the next flush
      return entries;
    }
    for (const [rel, e] of Object.entries(d.entries as Record<string, unknown>)) {
      const entry = e as Partial<Entry> | null;
      if (entry === null || typeof entry !== "object" || typeof entry.key !== "string") continue;
      const fact = entry.fact as Partial<RunFact> | undefined;
      // Only what this store is ever given: a terminated run, under its own id.
      if (fact === null || typeof fact !== "object" || fact.runId !== basename(rel) || typeof fact.terminationReason !== "string") continue;
      entries.set(rel, { key: entry.key, fact: fact as RunFact });
    }
    return entries;
  }

  /** The fact kept for a run directory under exactly this key, as a copy; undefined on any difference. */
  get(rel: string, key: string): RunFact | undefined {
    const e = this.load().get(rel);
    return e !== undefined && e.key === key ? { ...e.fact } : undefined;
  }

  set(rel: string, key: string, fact: RunFact): void {
    const e = this.load().get(rel);
    if (e !== undefined && e.key === key) return;
    this.entries!.set(rel, { key, fact: { ...fact } });
    this.dirty = true;
  }

  delete(rel: string): void {
    if (this.load().delete(rel)) this.dirty = true;
  }

  /** Drop every entry for a directory not in `seen`: a run archived, deleted or renamed leaves nothing behind. */
  retain(seen: ReadonlySet<string>): void {
    const entries = this.load();
    for (const rel of [...entries.keys()]) {
      if (seen.has(rel)) continue;
      entries.delete(rel);
      this.dirty = true;
    }
  }

  /** Write the entries if anything changed. Best effort: a store that cannot be written costs the next process a cold read, nothing else. */
  flush(): void {
    if (!this.dirty || this.entries === undefined) return;
    const tmp = `${this.path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify({ version: this.version, entries: Object.fromEntries(this.entries) }));
      renameSync(tmp, this.path);
      this.dirty = false;
      this.failure = undefined;
    } catch (e) {
      this.failure = `could not write ${this.path} (${e instanceof Error ? e.message : String(e)})`;
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* nothing more to do */
      }
    }
  }
}
