/**
 * Incremental reader over a run's `trajectory.jsonl`.
 *
 * One reader per run serves both the initial window and the live tail: it scans
 * forward from wherever it stopped, so the partial-line logic exists once. It
 * keeps only a small summary per entry plus the byte range the raw line
 * occupies, so a 3 MB trajectory costs kilobytes of memory and the full text of
 * any one entry is re-read from disk on demand.
 *
 * Splitting happens on bytes, not on decoded text: 0x0A cannot occur inside a
 * UTF-8 multi-byte sequence, so a chunk boundary can never corrupt a character
 * as long as the bytes after the last newline are carried over untouched.
 */

import { statSync } from "node:fs";

const NEWLINE = 0x0a;

/** How much of any one string a summary carries before it is cut. */
export const MAX_TEXT = 2000;
/** Max array elements kept in a generic summary. */
const MAX_ARRAY = 8;

export interface EntrySummary {
  /** Index of this entry in the file, 0-based. Stable; used to fetch the raw line. */
  i: number;
  t: string;
  ts: number;
  /** Byte range of the raw line, newline excluded. */
  start: number;
  end: number;
  /** True when anything in this entry was dropped or cut for display. */
  clipped?: boolean;
  [key: string]: unknown;
}

/** Split a byte buffer into newline-terminated lines plus the trailing remainder. */
export function splitLines(buf: Uint8Array): { lines: Uint8Array[]; rest: Uint8Array } {
  const lines: Uint8Array[] = [];
  let from = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === NEWLINE) {
      lines.push(buf.subarray(from, i));
      from = i + 1;
    }
  }
  return { lines, rest: buf.subarray(from) };
}

function clip(s: string, max = MAX_TEXT): { text: string; clipped: boolean } {
  if (s.length <= max) return { text: s, clipped: false };
  return { text: `${s.slice(0, max)}\n… ${s.length - max} more characters`, clipped: true };
}

/** Shrink an arbitrary value to something safe to ship to a browser. */
function shrink(value: unknown, out: { clipped: boolean }, depth = 0): unknown {
  if (typeof value === "string") {
    const c = clip(value);
    if (c.clipped) out.clipped = true;
    return c.text;
  }
  if (Array.isArray(value)) {
    if (depth >= 3) {
      out.clipped = true;
      return `[${value.length} items]`;
    }
    const kept = value.slice(0, MAX_ARRAY).map((v) => shrink(v, out, depth + 1));
    if (value.length > MAX_ARRAY) {
      out.clipped = true;
      kept.push(`… ${value.length - MAX_ARRAY} more`);
    }
    return kept;
  }
  if (value !== null && typeof value === "object") {
    if (depth >= 3) {
      out.clipped = true;
      return "{…}";
    }
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      o[k] = shrink(v, out, depth + 1);
    }
    return o;
  }
  return value;
}

/**
 * Rough token estimate, for runs where nobody counted. Drivers log a `usage`
 * block when the provider returns one, but plenty of endpoints return none, and
 * older trajectories predate the logging entirely. Four characters per token is
 * the usual English approximation; everything derived from it is labelled as an
 * estimate in the UI rather than presented as a measurement.
 */
export const CHARS_PER_TOKEN = 4;
export function estimateTokens(chars: number): number {
  return Math.round(chars / CHARS_PER_TOKEN);
}

/** Characters a chat message contributes to the context, tool calls included. */
function messageChars(m: unknown): number {
  if (m === null || typeof m !== "object") return 0;
  const msg = m as Record<string, unknown>;
  let n = typeof msg["role"] === "string" ? msg["role"].length : 0;
  const content = msg["content"];
  if (typeof content === "string") n += content.length;
  else if (content !== undefined && content !== null) n += JSON.stringify(content).length;
  const calls = msg["tool_calls"];
  if (Array.isArray(calls)) n += JSON.stringify(calls).length;
  return n;
}

/**
 * Provider-reported usage, if a driver records it. Normalised to
 * prompt/completion, with the two cache figures kept separate.
 *
 * `cachedRead` and `cacheWrite` are absent rather than zero when the provider
 * says nothing about them: OpenAI-compatible endpoints report cache reads as
 * `cached_tokens` and never mention cache writes at all, and a run that cannot
 * know a number must not display one. Cache reads are a *subset* of the prompt
 * on both the OpenAI-compat shape and the claude CLI shape the runner
 * normalises to, so prompt is always the whole input for the turn.
 */
export interface ReportedUsage {
  prompt: number;
  completion: number;
  cachedRead?: number;
  cacheWrite?: number;
}

function reportedUsage(rec: Record<string, unknown>): ReportedUsage | null {
  const candidates = [rec["usage"], (rec["message"] as Record<string, unknown> | undefined)?.["usage"]];
  for (const u of candidates) {
    if (u === null || u === undefined || typeof u !== "object") continue;
    const o = u as Record<string, unknown>;
    const prompt = o["prompt_tokens"] ?? o["input_tokens"];
    const completion = o["completion_tokens"] ?? o["output_tokens"];
    if (typeof prompt === "number" || typeof completion === "number") {
      const out: ReportedUsage = {
        prompt: typeof prompt === "number" ? prompt : 0,
        completion: typeof completion === "number" ? completion : 0,
      };
      const read = o["cached_tokens"] ?? o["cache_read_input_tokens"];
      const write = o["cache_write_tokens"] ?? o["cache_creation_input_tokens"];
      if (typeof read === "number") out.cachedRead = read;
      if (typeof write === "number") out.cacheWrite = write;
      return out;
    }
  }
  return null;
}

interface OpenAiToolCall {
  function?: { name?: unknown; arguments?: unknown };
  name?: unknown;
}

function toolCallNames(message: unknown): string[] {
  if (message === null || typeof message !== "object") return [];
  const calls = (message as { tool_calls?: unknown }).tool_calls;
  if (!Array.isArray(calls)) return [];
  return calls.map((c: OpenAiToolCall) => {
    const n = c.function?.name ?? c.name;
    return typeof n === "string" ? n : "?";
  });
}

/**
 * Build the display summary for one raw record.
 *
 * The two entry types that dominate the file — `request` (the whole message
 * array, growing with the conversation) and `events_served` (every packet the
 * SDK surfaced) — are reduced to counts here. Their full content is still
 * reachable one entry at a time through the raw endpoint.
 */
export function summarize(rec: Record<string, unknown>, i: number, start: number, end: number): EntrySummary {
  const t = typeof rec["t"] === "string" ? (rec["t"] as string) : "unknown";
  const ts = typeof rec["ts"] === "number" ? (rec["ts"] as number) : 0;
  const flag = { clipped: false };
  const base: EntrySummary = { i, t, ts, start, end };
  if (typeof rec["turn"] === "number") base["turn"] = rec["turn"];

  switch (t) {
    case "request": {
      const messages = Array.isArray(rec["messages"]) ? (rec["messages"] as unknown[]) : [];
      const system = messages.find((m) => (m as { role?: unknown }).role === "system");
      const sysText = typeof (system as { content?: unknown } | undefined)?.content === "string"
        ? ((system as { content: string }).content)
        : "";
      base["adapter"] = rec["adapter"];
      base["messageCount"] = messages.length;
      base["systemChars"] = sysText.length;
      // The whole prompt for this turn: what the model saw as context.
      base["promptChars"] = messages.reduce((n: number, m) => n + messageChars(m), 0);
      const usage = reportedUsage(rec);
      if (usage !== null) base["usage"] = usage;
      base["clipped"] = messages.length > 0;
      return base;
    }
    case "events_served": {
      const events = Array.isArray(rec["events"]) ? (rec["events"] as unknown[]) : [];
      const byOpcode = new Map<string, number>();
      for (const e of events) {
        const op = (e as { opcode?: unknown }).opcode;
        const key = typeof op === "string" ? op : "?";
        byOpcode.set(key, (byOpcode.get(key) ?? 0) + 1);
      }
      base["via"] = rec["via"];
      base["count"] = rec["count"] ?? events.length;
      const tally = [...byOpcode.entries()].sort((a, b) => b[1] - a[1]);
      base["opcodes"] = tally.slice(0, 6).map(([op, n]) => `${op}×${n}`);
      // The tally is cut at six; an operator reading it must know when there
      // were more kinds than that, or the line reads as the whole story.
      if (tally.length > 6) base["moreOpcodes"] = tally.length - 6;
      // Ambient movement the recent_events tool folded out of this reply.
      if (typeof rec["folded"] === "number") base["folded"] = rec["folded"];
      base["clipped"] = events.length > 0;
      return base;
    }
    case "response": {
      const msg = (rec["message"] ?? {}) as Record<string, unknown>;
      const content = typeof msg["content"] === "string" ? msg["content"] : "";
      const c = clip(content, 8000);
      base["text"] = c.text;
      base["tools"] = toolCallNames(msg);
      base["outChars"] = messageChars(msg);
      const usage = reportedUsage(rec);
      if (usage !== null) base["usage"] = usage;
      base["clipped"] = c.clipped;
      return base;
    }
    case "snippet": {
      const c = clip(typeof rec["code"] === "string" ? rec["code"] : "", 8000);
      base["code"] = c.text;
      base["clipped"] = c.clipped;
      return base;
    }
    case "snippet_result":
    case "tool_result": {
      const c = clip(typeof rec["text"] === "string" ? rec["text"] : "", 8000);
      base["name"] = rec["name"];
      base["isError"] = rec["isError"] === true;
      base["text"] = c.text;
      base["clipped"] = c.clipped;
      return base;
    }
    default: {
      for (const [k, v] of Object.entries(rec)) {
        if (k === "t" || k === "ts" || k === "turn") continue;
        base[k] = shrink(v, flag);
      }
      if (flag.clipped) base["clipped"] = true;
      return base;
    }
  }
}

export interface TokenTotals {
  /** "reported" only when a driver actually logged provider usage. */
  source: "reported" | "estimated";
  /** Prompt size of the most recent turn: what the model is carrying right now. */
  contextTokens: number;
  /** The whole input, cached part included — the openai-compat `prompt_tokens`. */
  promptTokens: number;
  completionTokens: number;
  /** Prompt + completion summed over every turn — cumulative, as billed. */
  totalTokens: number;
  /**
   * Cache reads and writes, `null` when the provider never said. A compat
   * endpoint reports `cached_tokens` and nothing about writes, so writes stay
   * unknown there — which is not the same as none, and must not show as 0.
   */
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  turns: number;
}

/**
 * Token accounting for a whole run. Prompt tokens are summed per turn, so the
 * total is what a provider would bill, not the size of the final context.
 */
export function tokenTotals(entries: readonly EntrySummary[]): TokenTotals {
  let prompt = 0;
  let completion = 0;
  let context = 0;
  let turns = 0;
  let reported = false;
  let cacheRead: number | null = null;
  let cacheWrite: number | null = null;
  // The provider reports a turn's prompt size on the *response*, so a request's
  // estimate is held until the response either confirms or replaces it.
  let pending: number | null = null;

  for (const e of entries) {
    const usage = e["usage"] as ReportedUsage | undefined;
    if (usage !== undefined && (e.t === "request" || e.t === "response")) {
      if (usage.cachedRead !== undefined) cacheRead = (cacheRead ?? 0) + usage.cachedRead;
      if (usage.cacheWrite !== undefined) cacheWrite = (cacheWrite ?? 0) + usage.cacheWrite;
    }
    if (e.t === "request") {
      if (pending !== null) prompt += pending; // a turn that never got a response
      turns++;
      const est = estimateTokens(Number(e["promptChars"] ?? 0));
      if (usage !== undefined) {
        reported = true;
        prompt += usage.prompt;
        completion += usage.completion;
        context = usage.prompt;
        pending = null;
      } else {
        pending = est;
        context = est;
      }
    } else if (e.t === "response") {
      if (usage !== undefined) {
        reported = true;
        if (usage.prompt > 0) {
          prompt += usage.prompt;
          context = usage.prompt;
        } else if (pending !== null) {
          prompt += pending;
        }
        completion += usage.completion;
      } else {
        if (pending !== null) prompt += pending;
        completion += estimateTokens(Number(e["outChars"] ?? 0));
      }
      pending = null;
    }
  }
  // A request still in flight has already been sent, so it counts.
  if (pending !== null) prompt += pending;

  return {
    source: reported ? "reported" : "estimated",
    contextTokens: context,
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: prompt + completion,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    turns,
  };
}

/** What a run costs to list: token totals plus the wall clock the file spans. */
export interface RunTotals {
  tokens: TokenTotals;
  /** Timestamp of the first and last trajectory entry; null on an empty file. */
  firstTs: number | null;
  lastTs: number | null;
  entries: number;
}

/**
 * Token totals for a whole run without keeping the run in memory.
 *
 * The listing wants one number per run, and holding an `EntrySummary` for every
 * entry of every run — the shape `TrajectoryTail` keeps for the feed — would
 * cost far more than the answer is worth. This streams the file, projects each
 * line down to the handful of fields token accounting reads, and drops the
 * rest. Callers are expected to memoise on (size, mtime): the work is linear in
 * bytes and a finished run never changes.
 */
export async function scanRunTotals(path: string): Promise<RunTotals> {
  const projections: EntrySummary[] = [];
  let firstTs: number | null = null;
  let lastTs: number | null = null;
  let entries = 0;

  const decoder = new TextDecoder();
  let carry = new Uint8Array(0);
  const take = (line: Uint8Array): void => {
    if (line.length === 0) return;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(decoder.decode(line)) as Record<string, unknown>;
    } catch {
      return; // a half-written or corrupt line costs its own tokens, nothing else
    }
    entries++;
    const t = typeof rec["t"] === "string" ? (rec["t"] as string) : "unknown";
    const ts = typeof rec["ts"] === "number" ? (rec["ts"] as number) : 0;
    if (ts > 0) {
      if (firstTs === null) firstTs = ts;
      lastTs = ts;
    }
    if (t !== "request" && t !== "response") return;
    const p: EntrySummary = { i: projections.length, t, ts, start: 0, end: 0 };
    if (t === "request") {
      const messages = Array.isArray(rec["messages"]) ? (rec["messages"] as unknown[]) : [];
      p["promptChars"] = messages.reduce((n: number, m) => n + messageChars(m), 0);
    } else {
      p["outChars"] = messageChars(rec["message"]);
    }
    const usage = reportedUsage(rec);
    if (usage !== null) p["usage"] = usage;
    projections.push(p);
  };

  try {
    for await (const chunk of Bun.file(path).stream()) {
      const buf = carry.length === 0 ? chunk : concat(carry, chunk);
      const { lines, rest } = splitLines(buf);
      for (const line of lines) take(line);
      carry = rest.length === 0 ? new Uint8Array(0) : new Uint8Array(rest);
    }
  } catch {
    /* an unreadable trajectory degrades one row, never the listing */
  }
  take(carry);

  return { tokens: tokenTotals(projections), firstTs, lastTs, entries };
}

/** A complete line that is not JSON must surface, never vanish. */
function unparseable(text: string, i: number, start: number, end: number): EntrySummary {
  return { i, t: "unparseable-line", ts: 0, start, end, line: clip(text, 400).text, clipped: true };
}

export class TrajectoryTail {
  readonly path: string;
  readonly entries: EntrySummary[] = [];
  /** Bytes consumed as complete lines. */
  private consumed = 0;
  /** Bytes after the last newline: an entry still being written. */
  private pending: Uint8Array = new Uint8Array(0);
  private readonly decoder = new TextDecoder();

  constructor(path: string) {
    this.path = path;
  }

  get size(): number {
    return this.consumed + this.pending.length;
  }

  /**
   * Scan whatever has been appended since the last call.
   * Returns the entries newly completed. A file that shrank is re-read whole:
   * that means truncation or rotation, and a stale index would be worse.
   */
  async scan(): Promise<EntrySummary[]> {
    let size: number;
    try {
      size = statSync(this.path).size;
    } catch {
      return [];
    }
    if (size < this.size) {
      this.entries.length = 0;
      this.consumed = 0;
      this.pending = new Uint8Array(0);
    }
    if (size === this.size) return [];

    const fresh = new Uint8Array(await Bun.file(this.path).slice(this.size, size).arrayBuffer());
    const buf = this.pending.length === 0 ? fresh : concat(this.pending, fresh);
    const { lines, rest } = splitLines(buf);

    const added: EntrySummary[] = [];
    let offset = this.consumed;
    for (const line of lines) {
      const start = offset;
      const end = start + line.length;
      offset = end + 1; // the newline
      if (line.length === 0) continue;
      const text = this.decoder.decode(line);
      const i = this.entries.length;
      let summary: EntrySummary;
      try {
        summary = summarize(JSON.parse(text) as Record<string, unknown>, i, start, end);
      } catch {
        summary = unparseable(text, i, start, end);
      }
      this.entries.push(summary);
      added.push(summary);
    }
    this.consumed = offset;
    this.pending = rest.length === 0 ? new Uint8Array(0) : new Uint8Array(rest);
    return added;
  }

  /** The raw JSON text of one entry, read back from disk. */
  async raw(i: number): Promise<string | null> {
    const e = this.entries[i];
    if (e === undefined) return null;
    return await Bun.file(this.path).slice(e.start, e.end).text();
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
