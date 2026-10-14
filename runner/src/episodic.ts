/**
 * The episodic log: one append-only JSONL file per run,
 * `data/runs/<id>/episodic.jsonl`.
 *
 * The decision is docs/METHODOLOGY.md, "An episodic log, asked for at each
 * trim or compaction, read back at rest or in flight". It is deliberately *not* the
 * scratchpad: working memory is the model's to rewrite at will, and a record it
 * can rewrite cannot tell it where things went wrong. Entries are appended,
 * never edited, and are stamped with the turn, level and zone the harness
 * observed when they were written — the model supplies only the text.
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

/**
 * Which end of the log a `read_log` page starts from. Newest first is the
 * default (operator, 2026-10-14): on a long run the entry that matters is the
 * latest, and the oldest stays one `order` or one `offset` away.
 */
export const EPISODIC_ORDERS = ["newest", "oldest"] as const;
export type EpisodicOrder = (typeof EPISODIC_ORDERS)[number];

/**
 * One `read_log` page request, already clamped by the caller. The filters
 * read the harness's own stamps, never the text: a level range keeps only
 * entries whose level was observed inside it, and `zone` keeps entries whose
 * zone name contains it, case-insensitively. An entry written with that stamp
 * unobserved matches no filter on it.
 */
export interface EpisodicQuery {
  order: EpisodicOrder;
  /** Matching entries to skip from the `order` end. */
  offset: number;
  limit: number;
  minLevel?: number | undefined;
  maxLevel?: number | undefined;
  zone?: string | undefined;
}

/** Whether a query filters at all; a page of a filtered log names both counts. */
function filtered(q: EpisodicQuery): boolean {
  return q.minLevel !== undefined || q.maxLevel !== undefined || q.zone !== undefined;
}

/** The entries a query's filters keep, in log order (oldest first). */
export function matchEntries(all: readonly EpisodicEntry[], q: EpisodicQuery): EpisodicEntry[] {
  const zone = q.zone?.toLowerCase();
  return all.filter((e) => {
    if (q.minLevel !== undefined && (typeof e.level !== "number" || e.level < q.minLevel)) return false;
    if (q.maxLevel !== undefined && (typeof e.level !== "number" || e.level > q.maxLevel)) return false;
    if (zone !== undefined && (e.zone === undefined || !e.zone.toLowerCase().includes(zone))) return false;
    return true;
  });
}

/** The filters as the page names them back, e.g. `level 10–12, zone "westfall"`. */
function describeFilters(q: EpisodicQuery): string {
  const parts: string[] = [];
  if (q.minLevel !== undefined && q.maxLevel !== undefined) parts.push(`level ${q.minLevel}–${q.maxLevel}`);
  else if (q.minLevel !== undefined) parts.push(`level ${q.minLevel}+`);
  else if (q.maxLevel !== undefined) parts.push(`level ≤${q.maxLevel}`);
  if (q.zone !== undefined) parts.push(`zone "${q.zone}"`);
  return parts.join(", ");
}

/**
 * One page as `read_log` prints it: a header the model can page from, then
 * one line per entry in the requested order.
 *
 * An offset past the last match is answered with what there is to page,
 * never silently clamped onto some other page: under newest-first a clamp
 * would show entries the model did not ask for, labelled as the ones it did.
 */
export function formatPage(all: readonly EpisodicEntry[], q: EpisodicQuery): string {
  if (all.length === 0) return "your episodic log is empty (nothing has been recorded with log_status)";
  const matched = matchEntries(all, q);
  const isFiltered = filtered(q);
  const of = isFiltered ? `${matched.length} matching ${describeFilters(q)} (${all.length} in the log)` : `${all.length}`;
  if (matched.length === 0) return `no entries match ${describeFilters(q)} (${all.length} in the log)`;
  if (q.offset >= matched.length) return `offset ${q.offset} is past the end: ${of}`;
  const ordered = q.order === "newest" ? [...matched].reverse() : matched;
  const slice = ordered.slice(q.offset, q.offset + q.limit);
  const header = `showing ${q.offset + 1}–${q.offset + slice.length} of ${of}, ${q.order} first`;
  return [header, ...slice.map(formatEntry)].join("\n");
}

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

  /** One `read_log` page (`formatPage`). The query is already clamped by the caller. */
  page(q: EpisodicQuery): string {
    return formatPage(this.read(), q);
  }
}
