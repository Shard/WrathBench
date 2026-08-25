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

import type {
  AchievementFacts,
  AreaFacts,
  EntrySummary,
  ReportedUsage,
  TaxiFacts,
  TokenTotals,
  TpsFacts,
} from "./api-types";
import { statSync } from "node:fs";
import { CONTEXT_POLICY } from "../src/context";
import { MODEL_RESPONSE_RECORD } from "./archive-dir";

const NEWLINE = 0x0a;

/** How much of any one string a summary carries before it is cut. */
export const MAX_TEXT = 2000;
/** Max array elements kept in a generic summary. */
const MAX_ARRAY = 8;

/*
 * The summary, usage and totals shapes live in `api-types.ts` — the type-only
 * contract the dashboard imports too — and are re-exported here unchanged.
 */
export type { AchievementFacts, AreaFacts, EntrySummary, ReportedUsage, TaxiFacts, TokenTotals, TpsFacts } from "./api-types";

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
      // The provider's own charge for the call. OpenRouter sends it under the
      // usage opt-in (`runner/src/adapter.ts`); everyone else omits it.
      const cost = o["cost"];
      if (typeof cost === "number" && Number.isFinite(cost)) out.cost = cost;
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
      // The token derivations read a claude-code turn's output off this record
      // (`ClaudeTurnUsage`), and the generic shrink below would cut a long
      // `iterations` array down to eight entries plus a string. Project it
      // first, from the raw record, so both this path and `scanRunTotals` read
      // the same thing.
      if (t === "claude_result") {
        const ct = claudeTurnUsage(rec);
        if (ct !== null) base["claudeTurn"] = ct;
      }
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
 * What one harness turn of the claude-code driver actually produced, off its
 * `claude_result` record.
 *
 * The `response` records inside such a turn carry the API's `message_start`
 * usage snapshot, which is the finished count for INPUT and a placeholder for
 * OUTPUT — one to thirty-odd tokens, whatever had been emitted when the stream
 * opened. Summing them read ~300× low: on the haiku run of 2026-08-25, 508
 * responses summed to 671 output tokens against the 207,062 the 23 result
 * records report. So output for a claude-code turn is read here and nowhere
 * else, and prompt tokens keep coming off the responses, where they are right.
 *
 * `iterations` is documented as one entry per API call in the turn. It is not,
 * on any CLI version we have logged: it holds a single entry, the LAST call, on
 * all seven runs that carry it, including turns of 1,280 API calls. So the
 * per-reply path below is gated on the only invariant that can tell a real list
 * from that one entry — the entries summing to the turn total — which on a
 * one-call turn is true and correct, and on everything else declines.
 */
export interface ClaudeTurnUsage {
  /** Output tokens for the whole harness turn. Authoritative. */
  completion: number;
  /** Per-API-call output tokens, in order, or empty when the list is unusable. */
  iterations: number[];
  /** The CLI's own turn clock: model time plus every tool round trip. */
  durationMs: number | null;
  /** Wall clock inside API calls. Absent before 2026-08-25; preferred when present. */
  durationApiMs: number | null;
}

/** Read a raw or summarised `claude_result` record into the shape above. */
export function claudeTurnUsage(rec: Record<string, unknown>): ClaudeTurnUsage | null {
  const raw = rec["usageRaw"];
  if (raw === null || typeof raw !== "object") return null;
  const u = raw as Record<string, unknown>;
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const completion = num(u["output_tokens"]);
  if (completion === null) return null;
  let iterations: number[] = [];
  if (Array.isArray(u["iterations"])) {
    const each = (u["iterations"] as unknown[]).map((it) =>
      it !== null && typeof it === "object" ? num((it as Record<string, unknown>)["output_tokens"]) : null,
    );
    // A shrunk summary can replace overflow entries with a string; anything
    // that is not a number end to end makes the list unusable, not partial.
    if (each.length > 0 && each.every((n) => n !== null)) iterations = each as number[];
  }
  return {
    completion,
    iterations,
    durationMs: num(rec["durationMs"]),
    durationApiMs: num(rec["durationApiMs"]),
  };
}

/**
 * Whether these entries came from the claude-code driver.
 *
 * Read off the records only that driver writes — its `driver` line, and the
 * `claude_system` envelopes it forwards — because the question this answers is
 * whether an unresolved `response` usage figure is an opening snapshot or a
 * finished count, and that is a property of the driver, not of the run.
 */
function isClaudeCode(entries: readonly EntrySummary[]): boolean {
  for (const e of entries) {
    if (e.t === "claude_system" || e.t === "claude_result") return true;
    if (e.t === "driver" && e["driver"] === "claude-code") return true;
  }
  return false;
}

/** The claude-code turns of a run, by turn number. */
function claudeTurns(entries: readonly EntrySummary[]): Map<number, ClaudeTurnUsage> {
  const out = new Map<number, ClaudeTurnUsage>();
  for (const e of entries) {
    if (e.t !== "claude_result") continue;
    const turn = e["turn"];
    if (typeof turn !== "number") continue;
    const usage = (e["claudeTurn"] as ClaudeTurnUsage | undefined) ?? claudeTurnUsage(e);
    // A turn that reports no output is a turn this cannot speak for: an error
    // result with nothing in it must not zero out what the envelopes did see.
    if (usage !== null && usage !== undefined && usage.completion > 0) out.set(turn, usage);
  }
  return out;
}

/**
 * One measured reply: what the model produced between the record that handed
 * it something to answer and the last response before the next such record.
 *
 * Two consumers read these spans and they have to agree about what one reply
 * is: `tokenTotals` (how many output tokens the run produced) and
 * `tokensPerSecond` (how fast it produced them). See `tokensPerSecond` for why
 * the span, rather than the turn, is the unit, and `TPS_SPAN_OPENERS` for what
 * opens one.
 */
export interface ReplySpan {
  /** Sum of `usage.completion` over the span's records that reported usage. */
  reported: number;
  /** Sum of `chars / 4` over the records that reported none. */
  estimated: number;
  /** Whether anything in the span reported usage; decides which of the two counts. */
  sawUsage: boolean;
  /** The opener's timestamp; 0 when it had none, and on responses that had no opener at all. */
  start: number;
  /** The last response's timestamp, or null where the span has no responses yet. */
  last: number | null;
  /** The harness turn this span's records belonged to, where they said. */
  turn: number | null;
  /**
   * True where the span's reported tokens are claude-code opening snapshots
   * that no `claude_result` could replace — a real figure is not available for
   * this reply and what stands is known to be far too low.
   */
  snapshot?: boolean;
  /**
   * A duration the driver measured, which overrides the span clock. Set only on
   * a collapsed claude-code turn, where the whole turn is the measured unit.
   */
  ms?: number;
}

/**
 * The run's replies, in order.
 *
 * A span's tokens are provider-reported where ANY of its records reported
 * usage, and `chars / 4` only where none did — never both. The claude-code
 * driver splits one reply across several `response` records where only the
 * last carries usage, and that last figure is the running total for the whole
 * message (`adapter-claude.ts`), so adding an estimate for the earlier
 * envelopes counts their text twice (FOLLOW-UPS 82). That is true of the
 * message's INPUT side only: its `completion` is the API's opening snapshot,
 * so where the turn has a `claude_result` the spans are resolved against it —
 * `perReplyTokens` where the turn's `iterations` really describe its replies,
 * `collapseClaudeTurns` otherwise.
 *
 * Reported figures are SUMMED, not taken from the last: one span can hold
 * several messages — several API calls — and each carries its own running
 * total, so taking the last would drop every message but one.
 *
 * Responses with no opener before them still make a span, with `start` 0: they
 * produced tokens, which `tokenTotals` must count, but they time nothing,
 * which is why `tokensPerSecond` requires a `start`.
 */
export function replySpans(entries: readonly EntrySummary[]): ReplySpan[] {
  const claude = claudeTurns(entries);
  const perReply = perReplyTokens(entries, claude);
  const claudeCode = isClaudeCode(entries);
  const spans: ReplySpan[] = [];
  let open: ReplySpan | null = null;
  const close = (): void => {
    if (open !== null) spans.push(open);
    open = null;
  };
  const turnOf = (e: EntrySummary): number | null =>
    typeof e["turn"] === "number" ? (e["turn"] as number) : null;
  /** Per turn, how many of its usage-bearing responses have been seen. */
  const seen = new Map<number, number>();

  for (const e of entries) {
    if (e.t === "response") {
      open ??= { reported: 0, estimated: 0, sawUsage: false, start: 0, last: null, turn: turnOf(e) };
      open.turn ??= turnOf(e);
      const usage = e["usage"] as ReportedUsage | undefined;
      if (usage !== undefined) {
        open.sawUsage = true;
        const turn = turnOf(e);
        const list = turn === null ? undefined : perReply.get(turn);
        if (list !== undefined && turn !== null) {
          const k = seen.get(turn) ?? 0;
          seen.set(turn, k + 1);
          open.reported += list[k] ?? 0;
        } else {
          open.reported += usage.completion;
          // Nothing will replace this: the turn produced no result, so its
          // opening snapshot is the whole of what anyone can say.
          if (claudeCode && (turn === null || !claude.has(turn))) open.snapshot = true;
        }
      } else {
        open.estimated += estimateTokens(Number(e["outChars"] ?? 0));
      }
      if (e.ts > 0) open.last = e.ts;
      continue;
    }
    // A record that opens or closes an active stretch ends the span it lands
    // in: whatever comes next was written on the far side of a pause.
    if (SEGMENT_MARKS.has(e.t)) {
      close();
      continue;
    }
    // Ambient telemetry mid-reply is not a boundary; see `tokensPerSecond`.
    if (!TPS_SPAN_OPENERS.has(e.t)) continue;
    close();
    const usage = e["usage"] as ReportedUsage | undefined;
    // Some adapters report the whole reply's usage on the record that opened it.
    open = {
      reported: usage?.completion ?? 0,
      estimated: 0,
      sawUsage: usage !== undefined,
      start: e.ts > 0 ? e.ts : 0,
      last: null,
      turn: turnOf(e),
    };
  }
  close();
  return collapseClaudeTurns(spans, claude, perReply);
}

/**
 * Where a `claude_result`'s `iterations` can be trusted to describe the turn's
 * replies one for one: only when they sum to the turn's output total.
 *
 * Counting them instead would not discriminate. The adapter writes a `response`
 * only for an envelope that carried text or a tool call, so a two-call turn
 * whose first call produced neither has one usage-bearing response and one
 * iteration — the counts match, the single last-call figure gets read as the
 * whole turn, and the total silently loses a call. The sum cannot go wrong that
 * way: it is either the turn or it is declined.
 */
function perReplyTokens(
  entries: readonly EntrySummary[],
  claude: ReadonlyMap<number, ClaudeTurnUsage>,
): Map<number, number[]> {
  const out = new Map<number, number[]>();
  if (claude.size === 0) return out;
  const usageBearing = new Map<number, number>();
  for (const e of entries) {
    if (e.t !== "response" || e["usage"] === undefined) continue;
    const turn = e["turn"];
    if (typeof turn !== "number") continue;
    usageBearing.set(turn, (usageBearing.get(turn) ?? 0) + 1);
  }
  for (const [turn, usage] of claude) {
    const list = usage.iterations;
    if (list.length === 0) continue;
    if (list.reduce((a, b) => a + b, 0) !== usage.completion) continue;
    if ((usageBearing.get(turn) ?? 0) !== list.length) continue;
    out.set(turn, list);
  }
  return out;
}

/**
 * Fold each claude-code turn the per-reply path could not resolve into a single
 * measured reply: the turn's output total over the time its replies took.
 *
 * The tokens have to come from the turn — its `response` figures are opening
 * snapshots — but the CLOCK does not. The turn's spans time the replies exactly
 * as they do under the fixed loop (opener → last response, a pause dropping the
 * span it lands in), so summing those measured windows keeps the denominator
 * inside model time and keeps the figure comparable to the fixed loop's
 * request→response. The CLI's own `duration_ms` would not: on the 2026-08-25
 * haiku run it sums to 5,283,659 ms of a 5,400,000 ms episode — 98% of wall
 * clock, every MCP round trip into the game included — which is the run's
 * elapsed clock wearing a label that says it is the model's.
 *
 * The driver's clocks are the fallback for a turn with no measurable span at
 * all (nothing timed, a pause across the whole turn): `duration_api_ms` where
 * the run records it, `duration_ms` otherwise, taken as one measurement.
 *
 * A turn with no result — one still in flight, or one a watchdog cut short —
 * keeps today's behaviour and its snapshot figures, which is the only thing
 * anyone has for it.
 */
function collapseClaudeTurns(
  spans: readonly ReplySpan[],
  claude: ReadonlyMap<number, ClaudeTurnUsage>,
  perReply: ReadonlyMap<number, number[]>,
): ReplySpan[] {
  if (claude.size === 0) return [...spans];
  const out: ReplySpan[] = [];
  const done = new Set<number>();
  for (const s of spans) {
    const turn = s.turn;
    const usage = turn === null ? undefined : claude.get(turn);
    if (turn === null || usage === undefined || perReply.has(turn)) {
      out.push(s);
      continue;
    }
    if (done.has(turn)) continue; // its siblings are already in the collapsed span
    done.add(turn);
    let start = 0;
    let last: number | null = null;
    let measured = 0;
    for (const o of spans) {
      if (o.turn !== turn) continue;
      if (o.start > 0 && (start === 0 || o.start < start)) start = o.start;
      if (o.last !== null && (last === null || o.last > last)) last = o.last;
      // The same test `tokensPerSecond` applies to a span of the fixed loop, so
      // an unmeasurable one — no opener, or the far side of a pause — is left
      // out of the denominator here exactly as it is left out there.
      if (o.start > 0 && o.last !== null && o.last > o.start) measured += o.last - o.start;
    }
    const ms = measured > 0 ? measured : (usage.durationApiMs ?? usage.durationMs);
    const collapsed: ReplySpan = {
      reported: usage.completion,
      estimated: 0,
      sawUsage: true,
      start,
      last,
      turn,
    };
    if (ms !== null && ms > 0) collapsed.ms = ms;
    out.push(collapsed);
  }
  return out;
}

/**
 * Token accounting for a whole run. Prompt tokens are summed per turn, so the
 * total is what a provider would bill, not the size of the final context.
 *
 * `source` is `snapshot` where the whole completion figure rests on claude-code
 * opening snapshots — 21 of the 29 claude-code runs on disk on 2026-08-25,
 * where a watchdog kill means no turn ever emitted the finished counts. Such a
 * total is not an estimate and not a measurement: it is provider-reported and
 * known to be far too low (~300× on the one run with both halves), and calling
 * it `reported` would let it pass for the repaired ones.
 *
 * All of it, not any of it: a run whose turns resolved and whose last turn was
 * cut off mid-flight carries a handful of snapshot tokens on that turn and is
 * otherwise finished counts, and labelling that `snapshot` would be the same
 * mistake pointing the other way. A resumed run whose first session resolved
 * and whose second was killed is the case this rule reads generously; the
 * per-turn truth is in the spans for anyone who needs it.
 *
 * Completion tokens come from `replySpans`, so a reply split across several
 * `response` records counts once (FOLLOW-UPS 82), and a claude-code turn counts
 * its `claude_result` output total instead of its responses' opening snapshots
 * (`ClaudeTurnUsage`) — never both. Prompt tokens carry the same
 * rule: a request's `chars / 4` estimate is held until something reports a
 * prompt for it, and dropped when one does — under claude-code the reporting
 * envelope is a record or more after the first, and consuming the estimate on
 * the first would have counted both.
 */
export function tokenTotals(entries: readonly EntrySummary[]): TokenTotals {
  let prompt = 0;
  let context = 0;
  let turns = 0;
  let reported = false;
  let cacheRead: number | null = null;
  let cacheWrite: number | null = null;
  // The provider reports a turn's prompt size on the *response*, so a request's
  // estimate is held until a response either confirms or replaces it.
  let pending: number | null = null;

  for (const e of entries) {
    const usage = e["usage"] as ReportedUsage | undefined;
    if (usage !== undefined && (e.t === "request" || e.t === "response")) {
      if (usage.cachedRead !== undefined) cacheRead = (cacheRead ?? 0) + usage.cachedRead;
      if (usage.cacheWrite !== undefined) cacheWrite = (cacheWrite ?? 0) + usage.cacheWrite;
    }
    if (e.t === "request") {
      if (pending !== null) prompt += pending; // a turn nothing ever reported a prompt for
      turns++;
      const est = estimateTokens(Number(e["promptChars"] ?? 0));
      if (usage !== undefined) {
        reported = true;
        prompt += usage.prompt;
        context = usage.prompt;
        pending = null;
      } else {
        pending = est;
        context = est;
      }
    } else if (e.t === "response" && usage !== undefined) {
      reported = true;
      if (usage.prompt > 0) {
        prompt += usage.prompt;
        context = usage.prompt;
        // The reported figure replaces the request's estimate rather than
        // joining it, however many records after the request it lands.
        pending = null;
      }
    }
  }
  // A request nothing reported a prompt for has still been sent, so it counts.
  if (pending !== null) prompt += pending;

  let completion = 0;
  /** Split of the reported half, which decides between `reported` and `snapshot`. */
  let fromSnapshots = 0;
  let resolved = 0;
  for (const s of replySpans(entries)) {
    completion += s.sawUsage ? s.reported : s.estimated;
    if (!s.sawUsage) continue;
    if (s.snapshot === true) fromSnapshots += s.reported;
    else resolved += s.reported;
  }
  const snapshot = fromSnapshots > 0 && resolved === 0;

  return {
    source: snapshot ? "snapshot" : reported ? "reported" : "estimated",
    contextTokens: context,
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: prompt + completion,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    turns,
  };
}

/**
 * How many model replies the `recent` half of `TpsFacts` is measured over.
 *
 * Ten because the question it answers is "how is this run going *now*", and a
 * reply is tens of seconds: fewer would swing on one long one, more would
 * average across a stretch of the run the operator has stopped caring about.
 */
export const TPS_RECENT_REPLIES = 10;

/**
 * Output tokens per second, whole-run and over the last few replies.
 *
 * The unit measured is one REPLY, not one turn, because a turn is not the same
 * thing under the two drivers. The fixed loop writes one `request` and one
 * `response` per turn, but the claude-code driver hands the CLI a single
 * request and then logs whatever the session emits: on
 * `fleet-sonnet-e360-sonnet-20260824` that is one `request` and 2,833
 * `response` records, so timing "a turn" there would time the whole six-hour
 * episode — the run's elapsed clock wearing a label that says it is the
 * model's, which is exactly what this figure must never be.
 *
 * So a span opens at one of the records that hand the model something to answer
 * (`TPS_SPAN_OPENERS`: the `request` on the fixed loop, the `snippet_result` or
 * `tool_result` the CLI was waiting on under claude-code) and closes at the
 * last of the responses before the next opener. That is the wait plus the
 * reply: the model was working for that span and for nothing outside it. On the
 * fixed loop this is exactly request-to-response.
 *
 * Everything else — a `state` sample, a `milestone`, a `claude_system` line —
 * is ignored rather than treated as a boundary, which matters: those are
 * written by timers and taps while the model is mid-reply, and letting one
 * restart the clock would shorten the span and read as a speed the model never
 * had (on the live deepseek-pro run, by a third).
 *
 * A span whose responses never arrived is in flight and counts for nothing; so
 * is one a `pause`, `resume` or `termination` (`SEGMENT_MARKS`) landed inside,
 * whose reply sits on the far side of however long the run sat parked.
 *
 * Tokens come from `replySpans`, which `tokenTotals` reads too, so the two
 * figures can never disagree about what one reply produced: provider-reported
 * where ANY record of the span reported usage, and `chars ÷ 4` only where none
 * did, never both.
 *
 * The claude-code driver is one exception and only one: its responses carry
 * opening snapshots rather than finished output counts, so a whole harness turn
 * collapses to a single measured reply carrying the turn's output total. The
 * clock does not change with it — the denominator is the SUM of that turn's
 * spans, each timed by the rule above, so the figure stays inside model time
 * and stays comparable to the fixed loop's request→response. The CLI's own
 * `duration_api_ms`/`duration_ms` stand in only for a turn with no measurable
 * span at all. That makes `replies` a count of turns on such a run, so
 * `TPS_RECENT_REPLIES` covers rather more of the episode there than on the
 * fixed loop.
 */
export const TPS_SPAN_OPENERS = new Set(["request", "snippet_result", "tool_result"]);

export function tokensPerSecond(entries: readonly EntrySummary[]): TpsFacts {
  /**
   * One measured reply: what it produced, and how long the model took over it.
   *
   * A span with no opener timestamp times nothing, and neither does one whose
   * responses never arrived (in flight) or whose reply landed on the far side
   * of a pause — `replySpans` closes the span at the mark, so the responses
   * after it open a span with no start.
   */
  const replies: { tokens: number; ms: number }[] = [];
  for (const s of replySpans(entries)) {
    // A driver-measured duration wins where there is one: on a collapsed
    // claude-code turn the span clock times replies whose token figures were
    // discarded, so pairing the two would be a rate off two different things.
    const ms = s.ms ?? (s.start > 0 && s.last !== null ? s.last - s.start : 0);
    if (ms <= 0) continue;
    replies.push({ tokens: s.sawUsage ? s.reported : s.estimated, ms });
  }

  /** Summed both ways round, never a mean of rates: one short reply must not carry the figure. */
  const rate = (window: readonly { tokens: number; ms: number }[]): number | null => {
    let tokens = 0;
    let ms = 0;
    for (const r of window) {
      tokens += r.tokens;
      ms += r.ms;
    }
    return ms > 0 ? tokens / (ms / 1000) : null;
  };

  const recent = replies.slice(-TPS_RECENT_REPLIES);
  return { overall: rate(replies), recent: rate(recent), replies: replies.length, recentReplies: recent.length };
}

/**
 * The claude-code driver's own cost figure, accumulated the way the CLI reports
 * it: cumulative within a session, so the session's cost is its last record.
 *
 * Sessions are told apart by `session_id`, which the `claude_system` envelopes
 * carry from the CLI's first line onward and which `claude_result` records
 * itself as of 2026-08-25. A run that pauses and resumes opens a new session
 * and starts a new accumulation, so the run's cost is the sum over sessions —
 * and a `claude_result` with no session known at all falls in one anonymous
 * bucket, which takes the maximum rather than the sum. Taking the maximum
 * rather than literally the last is the same number on a monotonic series and
 * refuses to go backwards on a series that is not.
 *
 * Fed every record in order; ignores everything that is neither.
 */
export class ClaudeCostTally {
  private readonly perSession = new Map<string, number>();
  private current = "";

  note(rec: Record<string, unknown>): void {
    if (rec["t"] === "claude_system") {
      const id = rec["session_id"];
      if (typeof id === "string" && id.length > 0) this.current = id;
      return;
    }
    if (rec["t"] !== "claude_result") return;
    const own = rec["sessionId"];
    const key = typeof own === "string" && own.length > 0 ? own : this.current;
    const v = rec["costUsd"];
    if (typeof v !== "number" || !Number.isFinite(v)) return;
    const seen = this.perSession.get(key);
    this.perSession.set(key, seen === undefined ? v : Math.max(seen, v));
  }

  /** The run's claude-code cost, or null where no result record carried one. */
  total(): number | null {
    if (this.perSession.size === 0) return null;
    let sum = 0;
    for (const v of this.perSession.values()) sum += v;
    return sum;
  }
}

/**
 * What the provider says this run cost, or null when it said nothing.
 *
 * Two drivers report it in two shapes and both are summed here:
 *
 * - `claude_result.costUsd` — the Claude Agent SDK's `total_cost_usd`, which is
 *   CUMULATIVE for the CLI session and lands once per harness turn, emitted
 *   only when that turn ends cleanly; a hard watchdog kill cuts the stream
 *   before it lands, so most runs have none. One session's figure is therefore
 *   its LAST record, never the sum of them: summing 23 cumulative records on
 *   the 2026-08-25 haiku run read $69.30 for a session that charged $4.35. The
 *   sum across SESSIONS stands — a paused-and-resumed run opens a new one, and
 *   each starts its own accumulation. See `ClaudeCostTally`.
 * - `response.usage.cost` — OpenRouter's per-call charge in credits (dollars),
 *   under the usage opt-in the adapter sets for that host. Per response, so the
 *   run's figure is necessarily a sum, and it grows with a live run.
 *
 * A recorded `0` is a figure, not an absence: the test fixture emits one.
 */
export function reportedCostUsd(entries: readonly { t: string; [k: string]: unknown }[]): number | null {
  let total: number | null = null;
  const claude = new ClaudeCostTally();
  for (const e of entries) {
    claude.note(e);
    if (e.t === "claude_result") continue;
    // Responses only: a `request` record carries no charge, and counting the
    // usage block on both sides would double the bill.
    if (e.t !== MODEL_RESPONSE_RECORD) continue;
    const usage = e["usage"] as ReportedUsage | undefined;
    const c = usage?.cost;
    if (typeof c === "number" && Number.isFinite(c)) total = (total ?? 0) + c;
  }
  const cli = claude.total();
  return cli === null ? total : (total ?? 0) + cli;
}

/**
 * How much of a run the per-response cost actually covers.
 *
 * A run whose process was replaced mid-flight — the fleet resumes rather than
 * recreates — can have responses from before the adapter recorded `usage.cost`
 * and responses from after. Summing them yields a number that looks like a bill
 * for the whole run and is a bill for part of it, which is worse than a blank.
 * The counts let the cost note say so.
 *
 * `costed` is 0 for the claude-code driver whatever the run did: its figure
 * comes off `claude_result`, not off responses, so nothing here is partial.
 */
export function responseCostCoverage(
  entries: readonly { t: string; [k: string]: unknown }[],
): { costed: number; uncosted: number } {
  let costed = 0;
  let uncosted = 0;
  for (const e of entries) {
    if (e.t !== MODEL_RESPONSE_RECORD) continue;
    const usage = e["usage"] as ReportedUsage | undefined;
    if (typeof usage?.cost === "number" && Number.isFinite(usage.cost)) costed++;
    else uncosted++;
  }
  return { costed, uncosted };
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
 * Only the FIRST `meta` opens a segment. `writeMeta` appends a `meta` record
 * every time it is called, and run.ts calls it mid-file for two reasons that
 * must not count as driving: a resume that regenerates the session token
 * (which follows the `resume` mark and would otherwise open a duplicate), and
 * the pause mark itself, written milliseconds after the `pause` record (commit
 * 08cd691). That second case is what over-read every paused run at 100%+ of
 * its budget on the fleet page until 2026-08-25: pause closed the segment and
 * the pause-mark `meta` reopened it, so the whole quota wait counted as
 * playtime. Reopening after a pause is `resume`'s job alone.
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
    if (m.t === "resume") {
      if (open === null) open = m.ts;
    } else if (m.t === "meta") {
      if (open === null && out.length === 0) open = m.ts;
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
 * Close to, but not the same as, what the `episode-limit` watchdog measures.
 * `Watchdogs` is constructed fresh in each worker process, but since 08cd691
 * run.ts passes `elapsedBeforeMs` from the persisted `episodeElapsedMs`, so the
 * episode clock CARRIES ACROSS A PAUSE rather than resetting on every resume
 * (this comment said otherwise until item 62). Both clocks now exclude paused
 * time and differ only in how they accumulate it: the watchdog rewinds one
 * start point by the elapsed total, this sums the observed active segments. So
 * the two track each other, and neither is a subset of the other — a run that
 * died without recording its elapsed time resumes the watchdog at zero while
 * the segments here still remember the earlier work.
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

/* --------------------------------------------------- the resolved model id */

/**
 * What a run was *really* on, as the trajectory recorded it.
 *
 * A run records the roster's string — often an alias (`sonnet`, `opus`) that
 * the Claude Code CLI resolves at launch — so nothing on a page could say which
 * Claude a row was. Runs launched from 2026-08-25 promote the answer onto
 * `meta.json` and the `run` row at write time; every run before that carries it
 * only inside its trajectory, and this is what back-fills those at read time.
 * Nothing rewrites an old run: the derivation is the reader's, and a stamped
 * value always wins over it.
 */
export interface ResolvedMark {
  model: string | null;
  cliVersion: string | null;
}

/**
 * Read one record as a resolved-model mark, or null when it is not one.
 *
 * Two producers, one shape:
 * - `claude_system` — the CLI's own `init` event, which names the id it
 *   resolved the alias to (`model`) and its own version (`claude_code_version`).
 * - `response` — an OpenAI-compatible body's top-level `model`, the id the
 *   provider says it actually served (an aggregator may route a slug elsewhere).
 *   Only written since 2026-08-25, so older openai runs derive nothing and read
 *   as "not recorded" rather than being labelled with their config string.
 *
 * First observation wins at the call site; this function only projects.
 */
export function resolvedMarkOf(rec: Record<string, unknown>): ResolvedMark | null {
  const t = rec["t"];
  if (t !== "claude_system" && t !== "response") return null;
  const model = rec["model"];
  const cli = rec["claude_code_version"];
  if (typeof model !== "string" && typeof cli !== "string") return null;
  return {
    model: typeof model === "string" && model.length > 0 ? model : null,
    cliVersion: typeof cli === "string" && cli.length > 0 ? cli : null,
  };
}

/* ------------------------------------------------------- zone/area milestones */

/**
 * One `milestone` record of kind `zone` or `area`, projected down to the ids.
 *
 * The producer (`runner/src/loop.ts`, FOLLOW-UPS 35, 2026-08-23) writes one on
 * every change of `self.zone` / `self.area`, `from` absent on the first
 * observation of a process. Kinds beyond these two are ignored here.
 */
export interface AreaMark {
  kind: "zone" | "area";
  to: number;
  from: number | null;
}

/**
 * Zone and area ids for 3.3.5a capitals — the two factions' five each, plus the
 * two neutral hubs. Zone ids, so a `kind: "zone"` milestone answers rung 4.
 */
export const CAPITAL_ZONES = new Set([
  1519, // Stormwind
  1537, // Ironforge
  1657, // Darnassus
  3557, // The Exodar
  1637, // Orgrimmar
  1638, // Thunder Bluff
  1497, // Undercity
  3487, // Silvermoon City
  3703, // Shattrath City
  4395, // Dalaran
]);

/**
 * Derive the facts from a run's zone/area marks, or null when it has none.
 *
 * `startArea` is the **first** area mark's destination, not "the mark with no
 * `from`": a resumed run opens a second process whose `lastAreaId` starts
 * unset, so several marks can carry no `from` and only the first of them is the
 * run's start. Everything else follows from that one id.
 */
export function areaFactsFrom(marks: readonly AreaMark[]): AreaFacts | null {
  if (marks.length === 0) return null;
  const areas = marks.filter((m) => m.kind === "area");
  const zones = marks.filter((m) => m.kind === "zone");
  const startArea = areas.length > 0 ? areas[0]!.to : null;
  const distinct = new Set(areas.map((m) => m.to));
  const capital = zones.find((m) => CAPITAL_ZONES.has(m.to));
  return {
    startArea,
    distinctAreas: distinct.size,
    leftStartArea: startArea === null ? null : areas.some((m) => m.to !== startArea),
    capitalZone: capital?.to ?? null,
    zoneMarks: zones.length,
    areaMarks: areas.length,
  };
}

/** Read one trajectory record as an `AreaMark`, or null when it is not one. */
export function areaMarkOf(rec: Record<string, unknown>): AreaMark | null {
  const kind = rec["kind"];
  if (kind !== "zone" && kind !== "area") return null;
  const to = (rec["to"] as { id?: unknown } | undefined)?.id;
  if (typeof to !== "number") return null;
  const from = (rec["from"] as { id?: unknown } | undefined)?.id;
  return { kind, to, from: typeof from === "number" ? from : null };
}

/* ------------------------------------------- achievement and taxi milestones */

/**
 * One achievement milestone, projected to what a derivation needs: an own earn
 * (`kind: "earned"`, with the points when the module could name them) or the
 * login backlog (`kind: "login"`, ids plus the aggregate points).
 */
export type AchievementMark =
  | { kind: "earned"; id: number; points: number | null }
  | { kind: "login"; ids: number[]; points: number };

/** Read one trajectory record as an `AchievementMark`, or null when it is not one. */
export function achievementMarkOf(rec: Record<string, unknown>): AchievementMark | null {
  const kind = rec["kind"];
  if (kind === "achievement") {
    const id = rec["id"];
    if (typeof id !== "number") return null;
    const points = rec["points"];
    return { kind: "earned", id, points: typeof points === "number" ? points : null };
  }
  if (kind === "achievements_at_login") {
    const ids = rec["ids"];
    if (!Array.isArray(ids)) return null;
    const points = rec["points"];
    return {
      kind: "login",
      ids: ids.filter((v): v is number => typeof v === "number"),
      points: typeof points === "number" ? points : 0,
    };
  }
  return null;
}

/** `taxi` (a takeoff) or `taxi_landed`, or null when the record is neither. */
export function taxiMarkOf(rec: Record<string, unknown>): "taxi" | "taxi_landed" | null {
  const kind = rec["kind"];
  return kind === "taxi" || kind === "taxi_landed" ? kind : null;
}

/**
 * Derive a run's achievement facts, or null when it recorded none.
 *
 * Points come from the **last** login record plus every earn outside that
 * record's id set: a resumed run writes one backlog record per process and the
 * later one is the superset, so adding them all would count the same
 * achievement's points once per resume. `earned` is the union of every id seen,
 * which is what the character holds.
 */
export function achievementFactsFrom(marks: readonly AchievementMark[]): AchievementFacts | null {
  if (marks.length === 0) return null;
  const logins = marks.filter((m): m is Extract<AchievementMark, { kind: "login" }> => m.kind === "login");
  const lastLogin = logins.length > 0 ? logins[logins.length - 1]! : null;
  const backlog = new Set(lastLogin?.ids ?? []);
  const ids = new Set<number>();
  for (const m of marks) {
    if (m.kind === "login") for (const id of m.ids) ids.add(id);
    else ids.add(m.id);
  }
  let points = lastLogin?.points ?? 0;
  for (const m of marks) {
    if (m.kind === "earned" && !backlog.has(m.id) && m.points !== null) points += m.points;
  }
  return { earned: ids.size, points, ids: [...ids].sort((a, b) => a - b) };
}

/**
 * Derive a run's flight facts. `flights` counts takeoffs; landings only witness
 * that the taps were live. Null when nothing proves they were — no taxi record
 * and no achievement record — because a run from before the deploy and a run
 * that never flew would otherwise read the same (see `TaxiFacts`).
 */
export function taxiFactsFrom(
  marks: readonly ("taxi" | "taxi_landed")[],
  sawAchievementRecord: boolean,
): TaxiFacts | null {
  if (marks.length === 0 && !sawAchievementRecord) return null;
  return { flights: marks.filter((m) => m === "taxi").length };
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
   * never got off the ground (the runner archives it as it exits) — never read
   * as a turn count, since the claude driver appends one record per content
   * block of a single reply.
   */
  modelResponses: number;
  /** Stretches the run was actually being driven; see `segmentsFrom`. */
  segments: ActiveSegment[];
  /** What the provider charged: `claude_result` totals or summed
   * `response.usage.cost`; see `reportedCostUsd`. */
  reportedCostUsd: number | null;
  /** How many responses did and did not carry a per-call charge; see
   * `responseCostCoverage`. */
  responseCost: { costed: number; uncosted: number };
  /** Output tokens per second, whole-run and recent; see `tokensPerSecond`. */
  tps: TpsFacts;
  /**
   * Where the run went, from its zone/area milestone records; null when it
   * wrote none — a run from before the producer shipped (2026-08-23), which
   * must read as "not recorded" and never as "never left". See `AreaFacts`.
   */
  areas: AreaFacts | null;
  /**
   * Achievements and flights from the same pass over the milestone records;
   * null when the run wrote none of each — "not recorded", never zero. See
   * `AchievementFacts` / `TaxiFacts`.
   */
  achievements: AchievementFacts | null;
  taxi: TaxiFacts | null;
  /**
   * The model the provider actually served and the CLI version that drove it,
   * from the first record that named either (`resolvedMarkOf`). Null on a run
   * whose trajectory names neither — "not recorded", never the config string.
   * The read-time back-fill for runs written before the fields were stamped.
   */
  resolved: ResolvedMark | null;
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
  /*
   * What `replySpans` reads, and through it both `tokenTotals` and
   * `tokensPerSecond`: the request/response projections plus the records that
   * open a span or close one — the result the model was waiting on, and the
   * pause marks. Everything else is ambient and the derivation ignores it, so
   * it is never collected.
   */
  const spanMarks: EntrySummary[] = [];
  const marks: SegmentMark[] = [];
  let firstTs: number | null = null;
  let lastTs: number | null = null;
  let entries = 0;
  let toolCalls = 0;
  let snippets = 0;
  let modelResponses = 0;
  let costUsd: number | null = null;
  /** Cumulative-per-session, summed across sessions; see `ClaudeCostTally`. */
  const claudeCost = new ClaudeCostTally();
  let sawClaudeMark = false;
  let costed = 0;
  let uncosted = 0;
  /*
   * First-wins, and read before the request/response filter below: a
   * `claude_system` is neither, and the run's answer is settled by its first
   * turn. Two `let`s rather than a mark list — there is one answer per run.
   */
  let resolvedModel: string | null = null;
  let resolvedCli: string | null = null;
  const areaMarks: AreaMark[] = [];
  const achievementMarks: AchievementMark[] = [];
  const taxiMarks: ("taxi" | "taxi_landed")[] = [];

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
    // Read before the token projection drops everything that is not a turn:
    // the driver's own cost lives on a `claude_result`, which is neither, and
    // the session it belongs to on a `claude_system`, which is neither either.
    claudeCost.note(rec);
    // One marker per run is all the derivation needs to know which driver wrote
    // these responses — see `isClaudeCode`. Pushing every `claude_system` would
    // put thousands of entries in a list kept small on purpose.
    if (!sawClaudeMark && (t === "claude_system" || (t === "driver" && rec["driver"] === "claude-code"))) {
      sawClaudeMark = true;
      spanMarks.push({ i: 0, t: "driver", ts, start: 0, end: 0, driver: "claude-code" });
    }
    // Same reason, one record kind further: a `milestone` is neither a request
    // nor a response, so it has to be read before the early return below. Only
    // the ids are kept — tens of marks per run, not one per line.
    if (resolvedModel === null || resolvedCli === null) {
      const mark = resolvedMarkOf(rec);
      if (mark !== null) {
        resolvedModel ??= mark.model;
        resolvedCli ??= mark.cliVersion;
      }
    }
    if (t === "milestone") {
      const mark = areaMarkOf(rec);
      if (mark !== null) areaMarks.push(mark);
      const ach = achievementMarkOf(rec);
      if (ach !== null) achievementMarks.push(ach);
      const taxi = taxiMarkOf(rec);
      if (taxi !== null) taxiMarks.push(taxi);
    }
    if (t !== "request" && t !== "response") {
      // `claude_result` rides along with the span openers: it is what tells the
      // derivation how many output tokens the turn actually produced, and a
      // listing figure computed without it would not match the run page.
      const carried = t === "claude_result" || TPS_SPAN_OPENERS.has(t) || SEGMENT_MARKS.has(t);
      if (!carried) return;
      const mark: EntrySummary = { i: 0, t, ts, start: 0, end: 0 };
      if (typeof rec["turn"] === "number") mark["turn"] = rec["turn"];
      if (t === "claude_result") {
        const ct = claudeTurnUsage(rec);
        if (ct !== null) mark["claudeTurn"] = ct;
      }
      spanMarks.push(mark);
      return;
    }
    const p: EntrySummary = { i: spanMarks.length, t, ts, start: 0, end: 0 };
    if (typeof rec["turn"] === "number") p["turn"] = rec["turn"];
    if (t === "request") {
      const messages = Array.isArray(rec["messages"]) ? (rec["messages"] as unknown[]) : [];
      p["promptChars"] = messages.reduce((n: number, m) => n + messageChars(m), 0);
    } else {
      p["outChars"] = messageChars(rec["message"]);
    }
    const usage = reportedUsage(rec);
    if (t === MODEL_RESPONSE_RECORD) {
      if (typeof usage?.cost === "number" && Number.isFinite(usage.cost)) costed++;
      else uncosted++;
    }
    if (usage !== null) {
      p["usage"] = usage;
      // The other half of `reportedCostUsd`: OpenRouter charges per response,
      // so the run's actual cost accumulates here alongside the claude_result
      // total above. The two never both appear on one run.
      if (t === MODEL_RESPONSE_RECORD && typeof usage.cost === "number") {
        costUsd = (costUsd ?? 0) + usage.cost;
      }
    }
    spanMarks.push(p);
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

  const cli = claudeCost.total();
  if (cli !== null) costUsd = (costUsd ?? 0) + cli;

  return {
    // Over `spanMarks` rather than requests and responses alone: the span
    // openers are what tell one reply from the next, and a completion figure
    // derived without them is not the one the run page shows.
    tokens: tokenTotals(spanMarks),
    firstTs,
    lastTs,
    entries,
    toolCalls,
    snippets,
    modelResponses,
    segments: segmentsFrom(marks),
    reportedCostUsd: costUsd,
    responseCost: { costed, uncosted },
    tps: tokensPerSecond(spanMarks),
    areas: areaFactsFrom(areaMarks),
    achievements: achievementFactsFrom(achievementMarks),
    taxi: taxiFactsFrom(taxiMarks, achievementMarks.length > 0),
    resolved:
      resolvedModel === null && resolvedCli === null
        ? null
        : { model: resolvedModel, cliVersion: resolvedCli },
  };
}

/** A complete line that is not JSON must surface, never vanish. */
function unparseable(text: string, i: number, start: number, end: number): EntrySummary {
  return { i, t: "unparseable-line", ts: 0, start, end, line: clip(text, 400).text, clipped: true };
}

export class TrajectoryTail {
  readonly path: string;
  readonly entries: EntrySummary[] = [];
  /**
   * Achievement and flight milestones seen so far, accumulated as
   * the file is indexed so the run page reads them without the whole-file
   * `scanRunTotals` pass a live run would miss the cache on every poll. Same
   * pure derivations the results page uses, so the two cannot disagree — the
   * principle this file already applies to `segmentsFrom` / `playtimeMs`.
   */
  private readonly achievementMarks: AchievementMark[] = [];
  private readonly taxiMarks: ("taxi" | "taxi_landed")[] = [];
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
      // The accumulators are part of the index: a truncated or rotated file is
      // re-read whole, and keeping them would double-count everything in it.
      this.achievementMarks.length = 0;
      this.taxiMarks.length = 0;
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
        const rec = JSON.parse(text) as Record<string, unknown>;
        if (rec["t"] === "milestone") {
          const ach = achievementMarkOf(rec);
          if (ach !== null) this.achievementMarks.push(ach);
          const taxi = taxiMarkOf(rec);
          if (taxi !== null) this.taxiMarks.push(taxi);
        }
        summary = summarize(rec, i, start, end);
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

  /** Achievements this run's records account for; null when it wrote none. */
  get achievements(): AchievementFacts | null {
    return achievementFactsFrom(this.achievementMarks);
  }

  /** Flights taken; null when flights were not recorded for this run. */
  get taxi(): TaxiFacts | null {
    return taxiFactsFrom(this.taxiMarks, this.achievementMarks.length > 0);
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
