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

import type { EntrySummary, ReportedUsage, TokenTotals } from "./api-types";
import { statSync } from "node:fs";
import { CONTEXT_POLICY } from "../src/context";
import { MODEL_RESPONSE_RECORD } from "./stillborn";

const NEWLINE = 0x0a;

/** How much of any one string a summary carries before it is cut. */
export const MAX_TEXT = 2000;
/** Max array elements kept in a generic summary. */
const MAX_ARRAY = 8;

/*
 * The summary, usage and totals shapes live in `api-types.ts` — the type-only
 * contract the dashboard imports too — and are re-exported here unchanged.
 */
export type { EntrySummary, ReportedUsage, TokenTotals } from "./api-types";

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
 * Field names whose *values* are secrets, wherever they appear.
 *
 * The `meta` entry embeds the run's whole config, and that config carries the
 * module bearer `token`. Nothing in the viewer needs it and the API is meant to
 * be safe to expose read-only, so it is stripped at the two places a raw record
 * can reach a client: the generic summariser below and `TrajectoryTail.raw`.
 * `apiKeyEnv` deliberately stays — it names an environment variable, and the
 * value of that variable is never written to the trajectory in the first place.
 */
const SECRET_KEYS = new Set(["token", "apiKey", "api_key", "password", "secret"]);

/** The placeholder a stripped value leaves behind, so its absence is visible. */
export const REDACTED = "[redacted]";

/** Deep copy with every secret-named value replaced. Arrays and depth included. */
export function redactSecrets(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redactSecrets);
  if (v === null || typeof v !== "object") return v;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    out[k] = SECRET_KEYS.has(k) ? REDACTED : redactSecrets(val);
  }
  return out;
}

/**
 * Redact a raw JSONL line without reshaping it. A line that will not parse is
 * returned as-is only when it demonstrably carries no secret key name — an
 * unparseable line we cannot inspect is safer withheld than forwarded.
 */
export function redactRawLine(line: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    for (const k of SECRET_KEYS) if (line.includes(`"${k}"`)) return JSON.stringify({ error: "unparseable entry withheld" });
    return line;
  }
  return JSON.stringify(redactSecrets(parsed));
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
      // How much of this batch the model never saw. The record holds the raw
      // batch; the window it was rendered into drops ambient motion, so the
      // operator needs the split, not just the total.
      let ambient = 0;
      for (const [op, n] of tally) if (CONTEXT_POLICY.EVENT_WINDOW_EXCLUDE.test(op)) ambient += n;
      if (ambient > 0) base["ambient"] = ambient;
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
        // `meta` lands here carrying the run config, bearer token and all.
        base[k] = SECRET_KEYS.has(k) ? REDACTED : shrink(redactSecrets(v), flag);
      }
      if (flag.clipped) base["clipped"] = true;
      return base;
    }
  }
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

/** One stretch of a run during which the harness was actually driving. */
export interface ActiveSegment {
  start: number;
  /** Null while the segment is still open — the run had not paused or ended. */
  end: number | null;
}

/** The record kinds that open or close an active segment. */
export const SEGMENT_MARKS = new Set(["meta", "resume", "pause", "termination"]);

/** The trajectory records that open and close an active segment. */
export interface SegmentMark {
  t: string;
  ts: number;
}

/**
 * Split a run into the stretches it was actually being driven.
 *
 * A run's wall clock span is not its playtime: `--resume` picks a run up hours
 * after a rate limit paused it, and the gap belongs to nobody. A segment opens
 * at `meta` (the first launch) and at each `resume`, and closes at each `pause`
 * or `termination`. The last segment stays open when the run neither paused nor
 * ended — `playtimeMs` decides what to close it at.
 *
 * The "only if none is open" guard is load-bearing, not defensive: a resume
 * that regenerates the session token writes a *second* `meta` record mid-file
 * (run.ts), and without the guard that would open a duplicate segment.
 *
 * A trajectory whose first record is neither `meta` nor `resume` — an older or
 * truncated file — opens its first segment at that record, so playtime degrades
 * to the old span rather than to zero.
 */
export function segmentsFrom(marks: readonly SegmentMark[]): ActiveSegment[] {
  const out: ActiveSegment[] = [];
  let open: number | null = null;
  for (const m of marks) {
    if (m.ts <= 0) continue;
    if (m.t === "meta" || m.t === "resume") {
      if (open === null) open = m.ts;
    } else if (m.t === "pause" || m.t === "termination") {
      if (open !== null) {
        out.push({ start: open, end: m.ts });
        open = null;
      }
    } else if (open === null && out.length === 0) {
      open = m.ts;
    }
  }
  if (open !== null) out.push({ start: open, end: null });
  return out;
}

/**
 * Cumulative active time: the sum of the segments, with an open one closed at
 * `now` for a live run and at the last entry otherwise.
 *
 * A run that is paused right now has no open segment, so a fresh mtime (the
 * sqlite file still being touched) cannot make the current pause count.
 *
 * This is deliberately *not* what the `episode-limit` watchdog measures.
 * `Watchdogs` is constructed fresh in each worker process with
 * `startedAt = now()` (run.ts), so its `episodeMs` is per-process uptime since
 * the current resume: it resets on every resume and never sees paused time. It
 * is a subset of the number here, which is what the whole run has spent driving.
 */
export function playtimeMs(
  segments: readonly ActiveSegment[],
  opts: { lastTs: number | null; live: boolean; now: number },
): number | null {
  if (segments.length === 0) return null;
  let total = 0;
  for (const seg of segments) {
    const end = seg.end ?? (opts.live ? opts.now : (opts.lastTs ?? seg.start));
    total += Math.max(0, end - seg.start);
  }
  return total;
}

/** What a run costs to list: token totals plus the wall clock the file spans. */
export interface RunTotals {
  tokens: TokenTotals;
  /** Timestamp of the first and last trajectory entry; null on an empty file. */
  firstTs: number | null;
  lastTs: number | null;
  entries: number;
  /**
   * Tool calls the run actually made — `tool_call` records, which is the unit
   * `maxToolCallsPerEpisode` is enforced in at the MCP boundary. Reported so
   * the ceiling can be sized against what runs really use rather than guessed.
   */
  toolCalls: number;
  /** Of those, the ones that were `eval_snippet` (a `snippet` record). */
  snippets: number;
  /**
   * `response` records: the model's own turns. Counted because a run with none
   * is stillborn (`stillborn.ts`) — never read as a turn count, since the
   * claude driver appends one record per content block of a single reply.
   */
  modelResponses: number;
  /** Stretches the run was actually being driven; see `segmentsFrom`. */
  segments: ActiveSegment[];
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
  const marks: SegmentMark[] = [];
  let firstTs: number | null = null;
  let lastTs: number | null = null;
  let entries = 0;
  let toolCalls = 0;
  let snippets = 0;
  let modelResponses = 0;

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
    // Segment marks are read before the token projection filters everything
    // else out: `meta`, `pause`, `resume` and `termination` are none of them
    // requests or responses.
    if (SEGMENT_MARKS.has(t) || marks.length === 0) marks.push({ t, ts });
    if (t === "tool_call") toolCalls++;
    else if (t === "snippet") snippets++;
    else if (t === MODEL_RESPONSE_RECORD) modelResponses++;
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

  return {
    tokens: tokenTotals(projections),
    firstTs,
    lastTs,
    entries,
    toolCalls,
    snippets,
    modelResponses,
    segments: segmentsFrom(marks),
  };
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
    return redactRawLine(await Bun.file(this.path).slice(e.start, e.end).text());
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
