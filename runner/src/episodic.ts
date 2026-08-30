/**
 * The episodic log: one append-only JSONL file per run,
 * `data/runs/<id>/episodic.jsonl`.
 *
 * The decision is docs/METHODOLOGY.md, "An episodic log, written before each
 * trim, read back at rest". It is deliberately *not* the scratchpad: working
 * memory is the model's to rewrite at will, and a record it can rewrite cannot
 * tell it where things went wrong. Entries are appended, never edited, and are
 * stamped with the turn, level and zone the harness observed when they were
 * written — the model supplies only the text.
 *
 * Read back only through `read_log`, and only inside a reflection window
 * (`reflect.ts`).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Hard cap on one entry's text. A status entry is a couple of sentences; the
 * cut is deterministic (a fixed suffix carrying the number of characters
 * dropped) so a replayed run writes the same bytes.
 */
export const EPISODIC_TEXT_CHARS = 600;

/** How many entries one `read_log` page returns by default, and at most. */
export const EPISODIC_PAGE_DEFAULT = 20;
export const EPISODIC_PAGE_MAX = 50;

export interface EpisodicEntry {
  ts: number;
  /** The driver turn the entry was written on, as the driver counts turns. */
  turn: number;
  /** Character level when it was written; absent when unobserved. */
  level?: number;
  /** The zone name the client would have shown; absent when unobserved. */
  zone?: string;
  text: string;
}

/** Truncate one entry's text at the cap, marking the cut. Deterministic. */
export function capEntryText(text: string): { text: string; truncated: boolean } {
  const t = text.trim();
  if (t.length <= EPISODIC_TEXT_CHARS) return { text: t, truncated: false };
  const dropped = t.length - EPISODIC_TEXT_CHARS;
  return { text: `${t.slice(0, EPISODIC_TEXT_CHARS)}…[truncated ${dropped} chars]`, truncated: true };
}

/** One entry as `read_log` prints it. Unobserved stamps render as `?`. */
export function formatEntry(e: EpisodicEntry): string {
  const level = typeof e.level === "number" ? `L${e.level}` : "L?";
  const zone = e.zone !== undefined && e.zone.length > 0 ? e.zone : "?";
  return `[turn ${e.turn}, ${level}, ${zone}] ${e.text}`;
}

export class EpisodicLog {
  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  /** Every entry, oldest first. A malformed line is skipped, never thrown on. */
  read(): EpisodicEntry[] {
    if (!existsSync(this.path)) return [];
    const out: EpisodicEntry[] = [];
    for (const line of readFileSync(this.path, "utf8").split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        const parsed = JSON.parse(line) as EpisodicEntry;
        if (typeof parsed.text === "string" && typeof parsed.turn === "number") out.push(parsed);
      } catch {
        // A half-written last line (a killed process) is not a reason to lose
        // the entries before it.
      }
    }
    return out;
  }

  get count(): number {
    return this.read().length;
  }

  /** Append one entry. The stamps are the harness's; only `text` is the model's. */
  append(e: Omit<EpisodicEntry, "ts"> & { ts?: number }): EpisodicEntry {
    const capped = capEntryText(e.text);
    const entry: EpisodicEntry = {
      ts: e.ts ?? Date.now(),
      turn: e.turn,
      ...(typeof e.level === "number" ? { level: e.level } : {}),
      ...(e.zone !== undefined && e.zone.length > 0 ? { zone: e.zone } : {}),
      text: capped.text,
    };
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`, "utf8");
    return entry;
  }

  /**
   * One page, oldest first, with the `showing a–b of N` header the model needs
   * to page the rest. `offset` and `limit` are already clamped by the caller.
   */
  page(offset: number, limit: number): string {
    const all = this.read();
    if (all.length === 0) return "your episodic log is empty (nothing has been recorded with log_status)";
    const start = Math.min(offset, Math.max(0, all.length - 1));
    const slice = all.slice(start, start + limit);
    const header = `showing ${start + 1}–${start + slice.length} of ${all.length}`;
    return [header, ...slice.map(formatEntry)].join("\n");
  }
}
