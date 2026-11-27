/**
 * A run's totals from its `trajectory.jsonl`: tokens, cost, wall clock, tool
 * calls and the milestone facts (areas, flights, achievements, levels, deaths,
 * spells, talents, trades), streamed by `RunTotalsScanner` without keeping the
 * run in memory, and the per-record derivations they are made of.
 *
 * The runner's own, not the viewer's: the collector stores these per run
 * (`collector/src/ingest.ts`) and never imports the viewer. The viewer's
 * incremental reader (`viewer/tail.ts`, `TrajectoryTail`) folds the
 * same records through the same derivations, so it imports them from here
 * and a page and the store cannot disagree about what a record means.
 */

import type {
  AchievementFacts,
  ActiveSegment,
  AreaFacts,
  CostCoverage,
  DeathFacts,
  DeathSite,
  EntrySummary,
  LevelUpFacts,
  LevelUpMark,
  ReportedUsage,
  SpellFacts,
  SpellLearnMark,
  TalentFacts,
  TalentSpendMark,
  TaxiFacts,
  TokenTotals,
  TpsFacts,
  TradeFacts,
  TradeMarkView,
  UnreportedUsage,
} from "./run-types";
import { statSync } from "node:fs";
import { dirname } from "node:path";
import { SessionReader, type EventRow, type StreamCursor } from "@wrathbench/mcp/record";
import { isV1RunDir, milestoneOfEvent, sessionDirOfRun } from "./run-reader";
import { TurnIndex } from "./trace-samples";
import { CodexUsageCorrector } from "./codex-usage";
import { driverEntry } from "./drivers";
import { messageChars, requestStatsOf } from "./request-stats";
import { MODEL_RESPONSE_RECORD } from "./archive-dir";
import { SEGMENT_MARKS, segmentsFrom, type SegmentMark } from "./sessions";
import { num } from "./values";

const NEWLINE = 0x0a;

/**
 * How many bytes a scanner pulls off disk at a time.
 *
 * Both scanners below used to read the whole unread region in one slice, which
 * on the runs tree means a 638 MB `ArrayBuffer` for the largest trajectory (and
 * a line view per record over all of it) before a single record is parsed. That
 * is transient, but transient at that size is what a memory limit sees: the
 * publisher's pass peaked at 4.4 GB reading a tree whose live set is well under
 * one. Reading in windows changes nothing about
 * what is parsed — the partial line at a window's edge is carried in `pending`
 * exactly as the partial line at the end of a live file always was — and bounds
 * the buffer instead. Four mebibytes is comfortably above the largest single
 * record and small enough that eight concurrent readers cost tens of megabytes.
 */
export const SCAN_CHUNK_BYTES = 4 * 1024 * 1024;

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
export function reportedUsage(rec: Record<string, unknown>): ReportedUsage | null {
  const candidates = [rec["usage"], (rec["message"] as Record<string, unknown> | undefined)?.["usage"]];
  const last = rec["lastCall"] as Record<string, unknown> | null | undefined;
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
      const lp = last?.["prompt_tokens"];
      if (typeof lp === "number" && Number.isFinite(lp)) {
        out.lastCall = { prompt: lp };
        const w = last?.["context_window"];
        if (typeof w === "number" && Number.isFinite(w)) out.lastCall.contextWindow = w;
      }
      // claude-code: the output is the message's finished count, not its opening snapshot.
      if (o["completion_final"] === true) out.final = true;
      return out;
    }
  }
  return null;
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
 * records report. So output for a claude-code turn that has a result is read
 * here and nowhere else, and prompt tokens keep coming off the responses, where
 * they are right. A response the driver gave its finished count
 * (`ReportedUsage.final`) is right on both sides, but where its turn has a
 * result the result still settles it, so nothing is counted twice.
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
    if (e.t === "driver" && driverEntry(e["driver"])?.usage === "turn-snapshot") return true;
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
   * True where the span held a claude-code reply in a turn with no
   * `claude_result` whose finished output count the driver recorded
   * (`ReportedUsage.final`): reported, and right, but not settled by a result.
   */
  final?: boolean;
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
 * envelopes counts their text twice. That is true of the
 * message's INPUT side only: its `completion` is the API's opening snapshot
 * unless the driver recorded the finished count (`ReportedUsage.final`), so
 * where the turn has a `claude_result` the spans are resolved against it —
 * `perReplyTokens` where the turn's `iterations` really describe its replies,
 * `collapseClaudeTurns` otherwise — and where it has none, each reply is marked
 * `snapshot` or `final` by which of the two it carries.
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
          // opening snapshot, or the finished count the driver recorded, is
          // the whole of what anyone can say.
          if (claudeCode && (turn === null || !claude.has(turn))) {
            if (usage.final === true) open.final = true;
            else open.snapshot = true;
          }
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
 * A claude-code run's model turns, as its CLI counted them: each
 * `claude_result` that reports output closes one driver turn, and its
 * `num_turns` (its message count where it carried none) is that turn's model
 * turns, not a running total. The messages before it are the usage-bearing
 * `response` records since the last such result in the same CLI process (a
 * `driver` record opens a new one); a message no result covers — a turn cut
 * short, or still running — counts one, as the one API call it was. A result
 * with no message of its own to cover is left out.
 *
 * The same count as `bun wb inspect requests` reads for its run column
 * (infra/inspect-run.ts `requestReducer`, which copies it because that file
 * imports nothing, and is pinned to it by infra/inspect-requests.test.ts).
 * Every other driver's turns are its requests; see `tokenTotals`.
 */
export function claudeModelTurns(entries: readonly EntrySummary[]): number {
  let turns = 0;
  /** Usage-bearing messages since the last result that covered any, in this CLI process. */
  let pending = 0;
  for (const e of entries) {
    if (e.t === "driver") {
      turns += pending;
      pending = 0;
    } else if (e.t === "response") {
      if (e["usage"] !== undefined) pending++;
    } else if (e.t === "claude_result") {
      const usage = (e["claudeTurn"] as ClaudeTurnUsage | undefined) ?? claudeTurnUsage(e);
      // A result that reports no output speaks for nothing (`claudeTurns`): its messages stay a turn each.
      if (usage === null || !(usage.completion > 0)) {
        turns += pending;
      } else if (pending > 0) {
        const n = e["numTurns"];
        turns += typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.trunc(n) : pending;
      }
      pending = 0;
    }
  }
  return turns + pending;
}

/**
 * Token accounting for a whole run. Prompt tokens are summed per turn, so the
 * total is what a provider would bill, not the size of the final context.
 *
 * `turns` is the run's model turns: its requests, except on claude-code,
 * where a request is a context handed to the CLI (often one a session) and
 * the model's turns are the CLI's own count (`claudeModelTurns`).
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
 * The driver now records each message's finished output count where the CLI
 * streams it (`ReportedUsage.final`), so a run with no result can still hold
 * right figures. Those replies are not "resolved by a result", and a run
 * recorded across that change holds both kinds, so the label goes by the
 * majority of replies: `snapshot` while the snapshot-only replies outnumber the
 * finished-count ones, `reported` once they do not. A run with no
 * finished-count reply reads exactly as it always did.
 *
 * Completion tokens come from `replySpans`, so a reply split across several
 * `response` records counts once, and a claude-code turn counts
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
  // Codex: a turn is a whole `codex exec`, so the figures above are tallies of
  // many calls and "context" is the last call's prompt, when the driver logged
  // it. Held apart so nothing else about the totals moves.
  const codex = entries.some((e) => e.t === "driver" && driverEntry(e["driver"])?.usage === "exec-tally");
  let codexContext: number | null = null;
  let codexWindow: number | undefined;
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
    if (e.t === "response" && usage?.lastCall !== undefined) {
      codexContext = usage.lastCall.prompt;
      if (usage.lastCall.contextWindow !== undefined) codexWindow = usage.lastCall.contextWindow;
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
    } else if (e.t === "response" && usage !== undefined && e["kind"] === "compaction") {
      // A CLI's own summarisation call (pi): billed, so its tokens count, but
      // it is not the conversation's context and answers no turn's request.
      reported = true;
      prompt += usage.prompt;
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
  /** Replies with no result, by kind: opening snapshot only, or the finished count. */
  let snapshotSpans = 0;
  let finalSpans = 0;
  for (const s of replySpans(entries)) {
    completion += s.sawUsage ? s.reported : s.estimated;
    if (!s.sawUsage) continue;
    if (s.snapshot === true) snapshotSpans++;
    if (s.final === true) finalSpans++;
    if (s.snapshot === true) fromSnapshots += s.reported;
    else if (s.final !== true) resolved += s.reported;
  }
  const snapshot = fromSnapshots > 0 && resolved === 0 && snapshotSpans > finalSpans;

  return {
    source: snapshot ? "snapshot" : reported ? "reported" : "estimated",
    contextTokens: codex ? codexContext : context,
    ...(codex && codexWindow !== undefined ? { contextWindow: codexWindow } : {}),
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: prompt + completion,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    turns: isClaudeCode(entries) ? claudeModelTurns(entries) : turns,
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
 * The claude-code driver is one exception and only one: its responses carried
 * opening snapshots rather than finished output counts, so a whole harness turn
 * that has a result collapses to a single measured reply carrying the turn's
 * output total (a reply whose finished count the driver recorded is settled by
 * the result all the same, and in a turn with none is timed as any other). The
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
 * It also keeps what that figure does NOT cover. A `claude_result` lands only
 * when a turn ends cleanly, so a turn the watchdog killed or a pause cut off
 * reaches no result and its API calls are in no session's cost: on
 * `fleet-sub-fable-none-freeplay-claude-fable-5-none-20260829-a2` two paused
 * sessions left $839 standing for a run whose tokens price at ~$1,588. A
 * session's cost covers everything it used up to its latest result, so the
 * unreported part is the responses after each session's last result —
 * `unreported()`, which `pricing.ts` prices and adds (operator's decision,
 * 2026-10-08).
 *
 * Only once the session is over, though: a turn still in flight has no result
 * YET, and counting it would mark a live run's figure on every poll between
 * results. A session is over at a `pause` or `termination` record, or when a
 * `claude_system` names a different session. A result that lands after the
 * termination — the driver's wind-down waits for one — still covers its turn.
 *
 * Fed every record in order — raw trajectory lines or summarised entries, both
 * carry the response usage — and ignores everything else.
 */
export class ClaudeCostTally {
  private readonly perSession = new Map<string, number>();
  private current = "";
  /** Per session: what its responses used since its last result, and which turns those were. */
  private readonly pending = new Map<
    string,
    { prompt: number; read: number; write: number; completion: number; turns: Set<number | null>; underRead: boolean }
  >();
  /** Sessions that can report nothing more: paused, terminated, or followed by another. */
  private readonly over = new Set<string>();

  note(rec: Record<string, unknown>): void {
    const t = rec["t"];
    if (t === "claude_system") {
      const id = rec["session_id"];
      if (typeof id === "string" && id.length > 0 && id !== this.current) {
        this.over.add(this.current);
        this.current = id;
      }
      return;
    }
    if (t === "pause" || t === "termination") {
      this.over.add(this.current);
      return;
    }
    if (t === MODEL_RESPONSE_RECORD) {
      const u = reportedUsage(rec) ?? summarisedUsage(rec["usage"]);
      if (u === null || (u.prompt === 0 && u.completion === 0)) return;
      let p = this.pending.get(this.current);
      if (p === undefined) {
        p = { prompt: 0, read: 0, write: 0, completion: 0, turns: new Set(), underRead: false };
        this.pending.set(this.current, p);
      }
      p.prompt += u.prompt;
      p.read += u.cachedRead ?? 0;
      p.write += u.cacheWrite ?? 0;
      p.completion += u.completion;
      if (u.final !== true) p.underRead = true;
      p.turns.add(typeof rec["turn"] === "number" ? rec["turn"] : null);
      return;
    }
    if (t !== "claude_result") return;
    const own = rec["sessionId"];
    const key = typeof own === "string" && own.length > 0 ? own : this.current;
    const v = rec["costUsd"];
    if (typeof v !== "number" || !Number.isFinite(v)) return;
    const seen = this.perSession.get(key);
    this.perSession.set(key, seen === undefined ? v : Math.max(seen, v));
    // Everything the session used so far is inside that cumulative figure.
    this.pending.delete(key);
  }

  /** The run's claude-code cost, or null where no result record carried one. */
  total(): number | null {
    if (this.perSession.size === 0) return null;
    let sum = 0;
    for (const v of this.perSession.values()) sum += v;
    return sum;
  }

  /**
   * The tokens no reported cost covers, in sessions that are over, or
   * undefined when there are none — or when nothing was reported at all, since
   * then there is no figure to add them to and the run's whole cost is the
   * expected one.
   */
  unreported(): UnreportedUsage | undefined {
    if (this.perSession.size === 0) return undefined;
    const out: UnreportedUsage = { turns: 0, promptTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, completionTokens: 0 };
    let underRead = false;
    for (const [session, p] of this.pending) {
      if (!this.over.has(session)) continue;
      out.turns += p.turns.size;
      out.promptTokens += p.prompt;
      out.cacheReadTokens += p.read;
      out.cacheWriteTokens += p.write;
      out.completionTokens += p.completion;
      if (p.underRead) underRead = true;
    }
    if (out.turns === 0) return undefined;
    // Only where every counted response carried its finished output count.
    if (!underRead) out.outputFinal = true;
    return out;
  }
}

/** A summarised entry's usage (`ReportedUsage`, already normalised), or null. */
function summarisedUsage(u: unknown): ReportedUsage | null {
  if (u === null || typeof u !== "object") return null;
  const o = u as Partial<ReportedUsage>;
  return typeof o.prompt === "number" && typeof o.completion === "number" ? (o as ReportedUsage) : null;
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

/**
 * One `milestone` record of kind `zone` or `area`, projected down to the ids.
 *
 * The producer (`runner/src/loop.ts`, 2026-08-23) writes one on
 * every change of `self.zone` / `self.area`, `from` absent on the first
 * observation of a process. Kinds beyond these two are ignored here.
 */
export interface AreaMark {
  kind: "zone" | "area";
  to: number;
  from: number | null;
  /** When the record was written; absent on a mark built without one. */
  ts?: number;
}

/**
 * Zone and area ids for 3.3.5a capitals — the two factions' five each, plus the
 * two neutral hubs. Zone ids, so a `kind: "zone"` milestone answers freeplay milestone 4.
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
 * Area ids that make up one "tutorial region" — the handful of areas a 3.3.5a
 * newbie zone is split into, which a character normally wanders between while
 * doing the intro quests without that being "leaving the start" in any
 * meaningful sense. Only the two clusters the fleet has actually walked are
 * listed (conservative on purpose, per docs/METHODOLOGY.md: no invented
 * framework beyond what's observed) — an area outside every listed cluster
 * falls back to a region of just itself, i.e. the old id-equality behavior.
 *
 * `1` (the zone-wide "Dun Morogh" area id, distinct from the `1` zone id
 * coincidence) is deliberately excluded from the Coldridge cluster: it is the
 * generic area AreaTable.dbc falls back to once a character is out of both
 * named Coldridge subzones, i.e. actually outside the tutorial.
 */
const TUTORIAL_REGIONS: ReadonlySet<number>[] = [
  new Set([9, 24, 59, 34]), // Northshire Valley / Abbey / Vineyards / Echo Ridge Mine (human, Elwynn Forest)
  new Set([132, 800]), // Coldridge Valley / Coldridge Pass (dwarf, Dun Morogh)
];

function tutorialRegionOf(areaId: number): ReadonlySet<number> {
  return TUTORIAL_REGIONS.find((region) => region.has(areaId)) ?? new Set([areaId]);
}

/**
 * Derive the facts from a run's zone/area marks, or null when it has none.
 *
 * `startArea` is the **first** area mark's destination, not "the mark with no
 * `from`": a resumed run opens a second process whose `lastAreaId` starts
 * unset, so several marks can carry no `from` and only the first of them is the
 * run's start. Everything else follows from that one id.
 *
 * `leftStartArea` is a **sustained-exit** test, not a single-sample one: it is
 * true only when at least two *consecutive* area milestones both carry an id
 * outside `startArea`'s tutorial region (`tutorialRegionOf`, above). A lone
 * milestone outside the region — sandwiched between two inside it — reads as
 * a transient bounce (e.g. a loading-screen glitch or a same-region hop that
 * momentarily reports the parent zone's fallback id) and does not count;
 * bouncing between a newbie zone's own subzones — e.g. Northshire Valley to
 * the Abbey — does not count either, since both sides of the region test are
 * inside the same region. The pair may occur anywhere in the run, not only at
 * the end: once a genuine two-milestone exit has happened, a later return
 * home does not erase it. This is deliberately conservative in the id sense
 * (only the two documented clusters are known regions; everything else is
 * compared by bare id) but liberal in the position sense (any sustained pair
 * anywhere counts, not just a trailing one).
 */
export function areaFactsFrom(marks: readonly AreaMark[]): AreaFacts | null {
  if (marks.length === 0) return null;
  const areas = marks.filter((m) => m.kind === "area");
  const zones = marks.filter((m) => m.kind === "zone");
  const startArea = areas.length > 0 ? areas[0]!.to : null;
  const distinct = new Set(areas.map((m) => m.to));
  const capital = zones.find((m) => CAPITAL_ZONES.has(m.to));
  const exit = sustainedExitOf(areas);
  const leftStartArea: boolean | null = startArea === null ? null : exit !== null;
  return {
    startArea,
    distinctAreas: distinct.size,
    leftStartArea,
    capitalZone: capital?.to ?? null,
    zoneMarks: zones.length,
    areaMarks: areas.length,
  };
}

/**
 * The area mark that completes the first sustained exit from the start
 * area's tutorial region (`areaFactsFrom`'s rule): the second of the first
 * pair of consecutive area marks both outside it. Null when there is none.
 */
function sustainedExitOf(areas: readonly AreaMark[]): AreaMark | null {
  if (areas.length === 0) return null;
  const region = tutorialRegionOf(areas[0]!.to);
  for (let i = 1; i < areas.length; i++) {
    if (!region.has(areas[i - 1]!.to) && !region.has(areas[i]!.to)) return areas[i]!;
  }
  return null;
}

/**
 * When a run first showed what the freeplay milestones read beyond its level
 * (`dashboard/src/lib/ladder.ts`, `RUNGS`), as record instants: the mark that
 * completes the first sustained exit from the start region, the first entry
 * into a capital zone, and the first takeoff. Null in a field when no record
 * shows it, or the record carried no instant. First observation, the same
 * lower bound `AreaFacts` and `TaxiFacts` are.
 */
export interface MilestoneInstants {
  leftStartArea: number | null;
  capitalZone: number | null;
  flight: number | null;
}

/** The area half of `MilestoneInstants`, from the same marks `areaFactsFrom` reads. */
export function areaInstantsFrom(marks: readonly AreaMark[]): Pick<MilestoneInstants, "leftStartArea" | "capitalZone"> {
  const exit = sustainedExitOf(marks.filter((m) => m.kind === "area"));
  const capital = marks.find((m) => m.kind === "zone" && CAPITAL_ZONES.has(m.to));
  return { leftStartArea: exit?.ts ?? null, capitalZone: capital?.ts ?? null };
}

/** Read one trajectory record as an `AreaMark`, or null when it is not one. */
export function areaMarkOf(rec: Record<string, unknown>): AreaMark | null {
  const kind = rec["kind"];
  if (kind !== "zone" && kind !== "area") return null;
  const to = (rec["to"] as { id?: unknown } | undefined)?.id;
  if (typeof to !== "number") return null;
  const from = (rec["from"] as { id?: unknown } | undefined)?.id;
  const ts = rec["ts"];
  return { kind, to, from: typeof from === "number" ? from : null, ...(typeof ts === "number" ? { ts } : {}) };
}

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

/** A death-family milestone: the death itself, the release, or the resurrect. */
export type DeathMark =
  | ({ kind: "death" } & DeathSite)
  | { kind: "release"; ts: number; turn: number | null }
  | { kind: "resurrect"; ts: number; turn: number | null };

/** Read one trajectory record as a `LevelUpMark`, or null when it is not one. */
export function levelUpMarkOf(rec: Record<string, unknown>): LevelUpMark | null {
  if (rec["kind"] !== "level") return null;
  const to = rec["to"];
  if (typeof to !== "number") return null;
  const from = rec["from"];
  const xp = rec["xp"];
  const turn = rec["turn"];
  const ts = rec["ts"];
  return {
    to,
    from: typeof from === "number" ? from : null,
    xp: typeof xp === "number" ? xp : null,
    ts: typeof ts === "number" ? ts : 0,
    turn: typeof turn === "number" ? turn : null,
  };
}

/** Read one trajectory record as a `DeathMark`, or null when it is not one. */
export function deathMarkOf(rec: Record<string, unknown>): DeathMark | null {
  const kind = rec["kind"];
  if (kind !== "death" && kind !== "release" && kind !== "resurrect") return null;
  const recTs = rec["ts"];
  const turn = typeof rec["turn"] === "number" ? (rec["turn"] as number) : null;
  const ts = typeof recTs === "number" ? recTs : 0;
  if (kind !== "death") return { kind, ts, turn };
  // The cache's own stamp for the death evidence wins over the record's: the
  // producer samples on a timer, so the record was written whenever the sample
  // landed, while `observedTs` is when the server said the character died.
  const observed = rec["observedTs"];
  const p = rec["position"] as
    | { map?: unknown; x?: unknown; y?: unknown; z?: unknown; source?: unknown }
    | undefined;
  const source: "corpse_query" | "death_spot" | null =
    p?.source === "corpse_query" ? "corpse_query" : p?.source === "death_spot" ? "death_spot" : null;
  const position =
    p !== undefined &&
    source !== null &&
    typeof p.map === "number" &&
    typeof p.x === "number" &&
    typeof p.y === "number" &&
    typeof p.z === "number"
      ? { map: p.map, x: p.x, y: p.y, z: p.z, source }
      : null;
  const zone = (rec["zone"] as { id?: unknown } | undefined)?.id;
  const area = (rec["area"] as { id?: unknown } | undefined)?.id;
  const released = rec["released"];
  return {
    kind: "death",
    ts: typeof observed === "number" ? observed : ts,
    turn,
    position,
    zone: typeof zone === "number" ? zone : null,
    area: typeof area === "number" ? area : null,
    released: typeof released === "boolean" ? released : null,
  };
}

/**
 * Derive a run's level timeline, or null when it wrote no `level` milestone —
 * a run from before the producer shipped (2026-08-29), which reads as "not
 * recorded" and never as "never levelled".
 *
 * `levelUps` counts only the marks that carry a `from` **and** climb: the first
 * mark of every process carries none (it is the level the process opened on),
 * so a resumed run's second baseline is not a gain.
 */
export function levelUpFactsFrom(marks: readonly LevelUpMark[]): LevelUpFacts | null {
  if (marks.length === 0) return null;
  let levelUps = 0;
  let max = marks[0]!.to;
  for (const m of marks) {
    if (m.from !== null && m.to > m.from) levelUps++;
    if (m.to > max) max = m.to;
  }
  return {
    levelUps,
    startLevel: marks[0]!.to,
    maxLevel: max,
    first: marks[0]!,
    last: marks[marks.length - 1]!,
    marks: [...marks],
  };
}

/**
 * How close behind a `resurrect` a `release` must land to be the echo below.
 * The echo is written in the same drain as the resurrect it follows (0–1 ms
 * apart on every one of the 41 deaths of the run that showed it); a real
 * release needs a death first, which is seconds of game at the very least.
 */
export const RELEASE_ECHO_MS = 1_000;

/**
 * The indexes of `release`/`resurrect` marks that are an echo, not a death
 * cycle: a release within `RELEASE_ECHO_MS` after a resurrect with no death
 * between them, and the resurrect that closes it. The sandbox's death watcher
 * wrote one such pair after nearly every resurrect — the ghost flag still read
 * set for an event or two after the clear marker, and re-opened the window —
 * so a run's history reads two releases and two resurrects per death. Fixed
 * at the source; this keeps the history it already wrote honest.
 */
function echoedReleaseCycles(marks: readonly DeathMark[]): Set<number> {
  const out = new Set<number>();
  let lastResurrect: number | null = null;
  for (let i = 0; i < marks.length; i++) {
    const m = marks[i]!;
    if (m.kind === "death") {
      lastResurrect = null;
      continue;
    }
    if (m.kind === "resurrect") {
      lastResurrect = m.ts;
      continue;
    }
    if (lastResurrect === null || m.ts - lastResurrect > RELEASE_ECHO_MS || m.ts < lastResurrect) continue;
    out.add(i);
    const next = marks[i + 1];
    if (next !== undefined && next.kind === "resurrect" && next.ts - m.ts <= RELEASE_ECHO_MS) out.add(i + 1);
  }
  return out;
}

/**
 * Derive a run's death facts.
 *
 * `sawLevelUpMark` is the liveness witness, the job `achievements_at_login` does
 * for flights: every run under this producer writes a `level` mark on its first
 * sample, so a run with a level mark and no death mark genuinely never died and
 * reads `deaths: 0`, while a run from before the producer has neither and reads
 * null — "not recorded". Without it the two would be the same row.
 */
export function deathFactsFrom(marks: readonly DeathMark[], sawLevelUpMark: boolean): DeathFacts | null {
  if (marks.length === 0 && !sawLevelUpMark) return null;
  // Mapped, not filtered through: a `DeathMark` carries a `kind` discriminant
  // that `DeathSite` does not declare, and the wire must be exactly the type.
  const sites: DeathSite[] = marks
    .filter((m): m is { kind: "death" } & DeathSite => m.kind === "death")
    .map((m) => ({
      ts: m.ts,
      turn: m.turn,
      position: m.position,
      zone: m.zone,
      area: m.area,
      released: m.released,
    }));
  const echoes = echoedReleaseCycles(marks);
  return {
    deaths: sites.length,
    releases: marks.filter((m, i) => m.kind === "release" && !echoes.has(i)).length,
    resurrects: marks.filter((m, i) => m.kind === "resurrect" && !echoes.has(i)).length,
    first: sites[0] ?? null,
    last: sites[sites.length - 1] ?? null,
    sites,
  };
}

/**
 * A spellbook milestone: the login baseline the run opened with
 * (`spells_at_login`), or one id that entered the book afterwards (`spell`).
 */
export type SpellMark =
  | { kind: "login"; ids: number[] }
  | ({ kind: "learned" } & SpellLearnMark);

/** Read one trajectory record as a `SpellMark`, or null when it is not one. */
export function spellMarkOf(rec: Record<string, unknown>): SpellMark | null {
  const kind = rec["kind"];
  if (kind === "spells_at_login") {
    const ids = rec["ids"];
    if (!Array.isArray(ids)) return null;
    return { kind: "login", ids: ids.filter((v): v is number => typeof v === "number") };
  }
  if (kind !== "spell") return null;
  const id = rec["id"];
  if (typeof id !== "number") return null;
  const ts = rec["ts"];
  return {
    kind: "learned",
    id,
    ts: typeof ts === "number" ? ts : 0,
    turn: typeof rec["turn"] === "number" ? (rec["turn"] as number) : null,
  };
}

/** Read one trajectory record as a talent spend, or null when it is not one. */
export function talentMarkOf(rec: Record<string, unknown>): TalentSpendMark | null {
  if (rec["kind"] !== "talent") return null;
  const id = rec["id"];
  if (typeof id !== "number") return null;
  const points = rec["points"];
  const rank = rec["rank"];
  // `points` is the record's own normalisation; a record that carries only the
  // 0-based wire rank is still readable, and one with neither is not a spend.
  const spent =
    typeof points === "number" ? points : typeof rank === "number" ? rank + 1 : null;
  if (spent === null) return null;
  const ts = rec["ts"];
  return {
    id,
    points: spent,
    ts: typeof ts === "number" ? ts : 0,
    turn: typeof rec["turn"] === "number" ? (rec["turn"] as number) : null,
  };
}

/** Read one trajectory record as a completed trade, or null when it is not one. */
export function tradeMarkOf(rec: Record<string, unknown>): TradeMarkView | null {
  if (rec["kind"] !== "trade") return null;
  // The cache's stamp for the completion beats the record's, for the reason
  // `deathMarkOf` prefers `observedTs`: the producer samples on a timer.
  const observed = rec["observedTs"];
  const ts = rec["ts"];
  return {
    ts: typeof observed === "number" ? observed : typeof ts === "number" ? ts : 0,
    turn: typeof rec["turn"] === "number" ? (rec["turn"] as number) : null,
  };
}

/**
 * Derive a run's spellbook facts, or null when it wrote no spell record at all
 * — a run from before the producer shipped (2026-09-01), which reads as "not
 * recorded" and never as "learned nothing".
 *
 * `atLogin` comes from the **last** baseline record for the reason
 * `achievementFactsFrom` takes the last backlog: a resumed run writes one per
 * process and the later one is the superset.
 */
export function spellFactsFrom(marks: readonly SpellMark[]): SpellFacts | null {
  if (marks.length === 0) return null;
  const logins = marks.filter((m): m is Extract<SpellMark, { kind: "login" }> => m.kind === "login");
  const learned = marks.filter((m): m is { kind: "learned" } & SpellLearnMark => m.kind === "learned");
  const ids = new Set(learned.map((m) => m.id));
  return {
    learned: ids.size,
    atLogin: logins.length === 0 ? 0 : logins[logins.length - 1]!.ids.length,
    ids: [...ids].sort((a, b) => a - b),
    marks: learned.map(({ id, ts, turn }) => ({ id, ts, turn })),
  };
}

/**
 * Derive a run's talent spends.
 *
 * `sawSpellRecord` is the liveness witness, the job `achievements_at_login`
 * does for flights: every run under this producer writes a `spells_at_login`
 * record, and the three producers shipped together, so a run with one and no
 * talent mark genuinely spent nothing while a run from before them reads null.
 */
export function talentFactsFrom(
  marks: readonly TalentSpendMark[],
  sawSpellRecord: boolean,
): TalentFacts | null {
  if (marks.length === 0 && !sawSpellRecord) return null;
  return {
    spends: marks.length,
    talents: new Set(marks.map((m) => m.id)).size,
    marks: [...marks],
  };
}

/** Derive a run's completed trades. `sawSpellRecord` is the witness, as above. */
export function tradeFactsFrom(
  marks: readonly TradeMarkView[],
  sawSpellRecord: boolean,
): TradeFacts | null {
  if (marks.length === 0 && !sawSpellRecord) return null;
  return {
    trades: marks.length,
    first: marks[0] ?? null,
    last: marks[marks.length - 1] ?? null,
    marks: [...marks],
  };
}

/** What a run costs to list: token totals plus the wall clock the file spans. */
/**
 * The revision of what `RunTotalsScanner` derives from a trajectory's bytes.
 * The collector stores the answer per run and recomputes it only when the
 * file changes, so a change to the derivation itself — the same bytes now
 * meaning a different total — would never reach a finished run. The
 * collector folds this into the signature it compares (`collector/src/ingest.ts`);
 * raising it re-derives every run once, on the next pass. Raise it with any
 * change that alters a stored total for a file that did not change.
 *
 * 1: codex per-turn usage derived from the thread totals older records carry
 *    (`CodexUsageCorrector`), and the death watcher's echoed release/resurrect
 *    pairs no longer counted (`echoedReleaseCycles`).
 * 2: a claude-code run's turns its CLI never reported a cost for, as
 *    `responseCost.unreported` (`ClaudeCostTally`).
 *    A codex run's context, the prompt of its last API call (`lastCall`),
 *    rides on the same revision.
 * 3: a v1 run's milestones are its session record's `events` rows, each with
 *    the turn in flight joined by time, and its trajectory's are not read.
 * 4: the instants the freeplay milestones are placed at (`milestones`): the
 *    sustained exit from the start region, the first capital, the first takeoff.
 */
export const RUN_TOTALS_DERIVATION = 4;

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
  /** How many responses did and did not carry a per-call charge, and a
   * claude-code run's unreported turns; see `responseCostCoverage`. */
  responseCost: CostCoverage;
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
   * When the freeplay milestones' area and flight halves were first shown, as
   * record instants (`MilestoneInstants`). Optional: a total the collector
   * stored before derivation 4 has none, and reads as unplaced.
   */
  milestones?: MilestoneInstants;
  /**
   * The level timeline and the deaths from the same pass; null when the run
   * wrote no such record — "not recorded", never zero. See `LevelUpFacts` /
   * `DeathFacts`.
   */
  leveling: LevelUpFacts | null;
  deaths: DeathFacts | null;
  /**
   * Spells learned, talent points spent and trades completed, from the same
   * pass; null when the run wrote no such record — "not recorded", never zero.
   * See `SpellFacts` for the witness the three share.
   */
  spells: SpellFacts | null;
  talents: TalentFacts | null;
  trades: TradeFacts | null;
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
 * rest.
 *
 * A scanner is resumable, which is the whole reason it is an object rather
 * than a function: callers memoise on (size, mtime), and that cache hits for
 * every finished run and structurally MISSES for a live one, whose file grows
 * every second. A live trajectory runs to hundreds of megabytes and every
 * listing route funnels through here, so re-reading it from byte zero on each
 * poll is what makes the whole API slow. `scan()` reads only what has been
 * appended since the last call and folds it into the accumulators, which are
 * all monotone — counters, first/last timestamps, first-wins resolved marks
 * and append-only mark lists — so resuming is the same answer as re-reading.
 *
 * `scanRunTotals` below is the one-shot form, unchanged for every caller that
 * reads a file once.
 */
export class RunTotalsScanner {
  readonly path: string;

  /*
   * What `replySpans` reads, and through it both `tokenTotals` and
   * `tokensPerSecond`: the request/response projections plus the records that
   * open a span or close one — the result the model was waiting on, and the
   * pause marks. Everything else is ambient and the derivation ignores it, so
   * it is never collected.
   */
  private readonly spanMarks: EntrySummary[] = [];
  private readonly marks: SegmentMark[] = [];
  private firstTs: number | null = null;
  private lastTs: number | null = null;
  private entries = 0;
  private toolCalls = 0;
  private snippets = 0;
  private modelResponses = 0;
  private costUsd: number | null = null;
  /** Cumulative-per-session, summed across sessions; see `ClaudeCostTally`. */
  private readonly claudeCost = new ClaudeCostTally();
  /**
   * A codex response written before the driver logged per-turn deltas carries
   * the thread's running total; this rewrites it to the turn's share before
   * anything below reads it. Fed every line — it needs the `driver` and
   * `codex_thread` records the token projection otherwise drops.
   */
  private readonly codexUsage = new CodexUsageCorrector();
  private sawClaudeMark = false;
  private sawCodexMark = false;
  private costed = 0;
  private uncosted = 0;
  /*
   * First-wins, and read before the request/response filter below: a
   * `claude_system` is neither, and the run's answer is settled by its first
   * turn. Two fields rather than a mark list — there is one answer per run.
   */
  private resolvedModel: string | null = null;
  private resolvedCli: string | null = null;
  private readonly areaMarks: AreaMark[] = [];
  private readonly levelUpMarks: LevelUpMark[] = [];
  private readonly deathMarks: DeathMark[] = [];
  private readonly achievementMarks: AchievementMark[] = [];
  private readonly taxiMarks: ("taxi" | "taxi_landed")[] = [];
  /** The first takeoff's instant, for `MilestoneInstants.flight`. */
  private firstFlightTs: number | null = null;
  private readonly spellMarks: SpellMark[] = [];
  private readonly talentMarks: TalentSpendMark[] = [];
  private readonly tradeMarks: TradeMarkView[] = [];
  /** The turn in flight at an instant, from the lines read so far. */
  private readonly turns = new TurnIndex();
  /** Whether this is a v1 run, whose milestones are its session record's; latched once seen. */
  private v1 = false;
  /** Where the last scan left the session record's `events` stream. */
  private eventsCursor: StreamCursor | undefined;

  private readonly decoder = new TextDecoder();

  /** Bytes consumed as complete lines; where the next scan resumes. */
  private consumed = 0;
  /**
   * Bytes after the last newline. A live trajectory's last line is routinely
   * half-written, so it is held here and re-read with the next chunk rather
   * than counted — the same discipline `TrajectoryTail.scan` follows.
   */
  private pending: Uint8Array = new Uint8Array(0);
  /** Read window; only a test narrows it, to exercise a record split across two. */
  private readonly chunkBytes: number;

  constructor(path: string, chunkBytes: number = SCAN_CHUNK_BYTES) {
    this.chunkBytes = Math.max(1, chunkBytes);
    this.path = path;
  }

  /** How far this scanner has read, complete lines and the partial one. */
  get size(): number {
    return this.consumed + this.pending.length;
  }

    private take(line: Uint8Array): void {
      if (line.length === 0) return;
      let rec: Record<string, unknown>;
      try {
        rec = JSON.parse(this.decoder.decode(line)) as Record<string, unknown>;
      } catch {
        return; // a half-written or corrupt line costs its own tokens, nothing else
      }
      this.entries++;
      this.codexUsage.note(rec);
      const t = typeof rec["t"] === "string" ? (rec["t"] as string) : "unknown";
      const ts = typeof rec["ts"] === "number" ? (rec["ts"] as number) : 0;
      if (ts > 0) {
        if (this.firstTs === null) this.firstTs = ts;
        this.lastTs = ts;
      }
      // Segment this.marks are read before the token projection filters everything
      // else out: `meta`, `pause`, `resume` and `termination` are none of them
      // requests or responses.
      if (SEGMENT_MARKS.has(t) || this.marks.length === 0) this.marks.push({ t, ts });
      if (t === "tool_call") this.toolCalls++;
      else if (t === "snippet") this.snippets++;
      else if (t === MODEL_RESPONSE_RECORD) this.modelResponses++;
      // Read before the token projection drops everything that is not a turn:
      // the driver's own cost lives on a `claude_result`, which is neither, and
      // the session it belongs to on a `claude_system`, which is neither either.
      this.claudeCost.note(rec);
      // One marker per run is all the derivation needs to know which driver wrote
      // these responses — see `isClaudeCode`. Pushing every `claude_system` would
      // put thousands of this.entries in a list kept small on purpose.
      // The mark is the record kind that was seen, which `isClaudeCode` reads
      // either way: the `driver` line, or the `claude_system` envelope.
      const reports = t === "driver" ? driverEntry(rec["driver"])?.usage : undefined;
      // Every claude-code `driver` line, though: each opens a CLI process, which `claudeModelTurns` reads as a boundary.
      if (reports === "turn-snapshot") {
        this.sawClaudeMark = true;
        this.spanMarks.push({ i: 0, t, ts, start: 0, end: 0, driver: rec["driver"] });
      } else if (!this.sawClaudeMark && t === "claude_system") {
        this.sawClaudeMark = true;
        this.spanMarks.push({ i: 0, t, ts, start: 0, end: 0 });
      }
      // The codex driver's line, for `tokenTotals`' reading of "context".
      if (!this.sawCodexMark && reports === "exec-tally") {
        this.sawCodexMark = true;
        this.spanMarks.push({ i: 0, t: "driver", ts, start: 0, end: 0, driver: rec["driver"] });
      }
      // Same reason, one record kind further: a `milestone` is neither a request
      // nor a response, so it has to be read before the early return below. Only
      // the ids are kept — tens of this.marks per run, not one per line.
      if (this.resolvedModel === null || this.resolvedCli === null) {
        const mark = resolvedMarkOf(rec);
        if (mark !== null) {
          this.resolvedModel ??= mark.model;
          this.resolvedCli ??= mark.cliVersion;
        }
      }
      // The run's turn in flight, for the session record's milestones (decision 9: joined by time).
      this.turns.note(rec);
      // A v1 run's milestones are its session record's (`followEvents`); a
      // milestone record in its trajectory is a phase-1 mirror of the same.
      if (t === "milestone" && !this.v1) this.takeMilestone(rec);
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
          if (typeof rec["numTurns"] === "number") mark["numTurns"] = rec["numTurns"];
        }
        this.spanMarks.push(mark);
        return;
      }
      const p: EntrySummary = { i: this.spanMarks.length, t, ts, start: 0, end: 0 };
      if (typeof rec["turn"] === "number") p["turn"] = rec["turn"];
      if (t === "request") {
        p["promptChars"] = requestStatsOf(rec).promptChars;
      } else {
        p["outChars"] = messageChars(rec["message"]);
      }
      const usage = reportedUsage(rec);
      if (t === MODEL_RESPONSE_RECORD) {
        if (typeof usage?.cost === "number" && Number.isFinite(usage.cost)) this.costed++;
        else this.uncosted++;
      }
      if (usage !== null) {
        p["usage"] = usage;
        // The other half of `reportedCostUsd`: OpenRouter charges per response,
        // so the run's actual cost accumulates here alongside the claude_result
        // total above. The two never both appear on one run.
        if (t === MODEL_RESPONSE_RECORD && typeof usage.cost === "number") {
          this.costUsd = (this.costUsd ?? 0) + usage.cost;
        }
      }
    this.spanMarks.push(p);
  }

  /** Fold one milestone record, from the trajectory or the session record, into the marks. */
  private takeMilestone(rec: Record<string, unknown>): void {
    const mark = areaMarkOf(rec);
    if (mark !== null) this.areaMarks.push(mark);
    const ach = achievementMarkOf(rec);
    if (ach !== null) this.achievementMarks.push(ach);
    const taxi = taxiMarkOf(rec);
    if (taxi !== null) this.taxiMarks.push(taxi);
    if (taxi === "taxi" && this.firstFlightTs === null && typeof rec["ts"] === "number") this.firstFlightTs = rec["ts"];
    const lvl = levelUpMarkOf(rec);
    if (lvl !== null) this.levelUpMarks.push(lvl);
    const death = deathMarkOf(rec);
    if (death !== null) this.deathMarks.push(death);
    const spell = spellMarkOf(rec);
    if (spell !== null) this.spellMarks.push(spell);
    const talent = talentMarkOf(rec);
    if (talent !== null) this.talentMarks.push(talent);
    const trade = tradeMarkOf(rec);
    if (trade !== null) this.tradeMarks.push(trade);
  }

  /**
   * A v1 run's milestones, read on from where the last scan left its `events`
   * stream: each row as the milestone record it stands for, with the turn in
   * flight at its instant. A batch is folded in time order, which is the
   * order the trajectory's records were in.
   */
  private followEvents(): void {
    if (!this.v1) return;
    let batch: { rows: EventRow[]; cursor: StreamCursor | undefined };
    try {
      batch = new SessionReader(sessionDirOfRun(dirname(this.path))).tail("events", this.eventsCursor);
    } catch {
      return;
    }
    this.eventsCursor = batch.cursor;
    const rows = [...batch.rows].sort((a, b) => a.ts - b.ts);
    for (const row of rows) {
      const rec = milestoneOfEvent(row, this.turns.at(row.ts));
      if (rec !== null) this.takeMilestone(rec);
    }
  }

  /**
   * Read whatever has been appended since the last call and answer the totals
   * for everything read so far.
   *
   * A file that shrank is not resumable — that is truncation or replacement,
   * and folding new bytes into old accumulators would double-count — so the
   * caller is told to start a fresh scanner by `size` running ahead of the
   * file. Here it simply reads nothing rather than lying; `runTotals` in
   * `api.ts` makes that check before it calls.
   */
  async scan(): Promise<RunTotals> {
    let size: number;
    try {
      size = statSync(this.path).size;
    } catch {
      return this.totals();
    }
    if (!this.v1) this.v1 = isV1RunDir(dirname(this.path));
    // A window at a time (`SCAN_CHUNK_BYTES`), resuming from `this.size`, which
    // the loop advances as lines are consumed and the remainder is held.
    while (this.size < size) {
      try {
        const end = Math.min(size, this.size + this.chunkBytes);
        const fresh = new Uint8Array(await Bun.file(this.path).slice(this.size, end).arrayBuffer());
        const buf = this.pending.length === 0 ? fresh : concat(this.pending, fresh);
        const { lines, rest } = splitLines(buf);
        for (const line of lines) {
          this.consumed += line.length + 1; // the newline
          this.take(line);
        }
        this.pending = rest.length === 0 ? new Uint8Array(0) : new Uint8Array(rest);
      } catch {
        /* an unreadable trajectory degrades one row, never the listing */
        break;
      }
    }
    // After the trajectory, so every milestone finds the turn it fell in.
    this.followEvents();
    return this.totals();
  }

  /**
   * Count the trailing bytes that carry no newline as a line of their own and
   * answer the totals. Only the one-shot path does this: a file whose last
   * record was written without a terminating newline still has that record
   * counted, exactly as the whole-file scan always did. A resumable scanner
   * must not, because the next append would count those bytes twice.
   */
  async scanOnce(): Promise<RunTotals> {
    await this.scan();
    if (this.pending.length > 0) {
      this.take(this.pending);
      this.consumed += this.pending.length;
      this.pending = new Uint8Array(0);
    }
    return this.totals();
  }

  /** `responseCostCoverage`'s answer, off the same accumulators. */
  private coverage(): CostCoverage {
    const unreported = this.claudeCost.unreported();
    return unreported === undefined
      ? { costed: this.costed, uncosted: this.uncosted }
      : { costed: this.costed, uncosted: this.uncosted, unreported };
  }

  private totals(): RunTotals {
    let costUsd = this.costUsd;
    const cli = this.claudeCost.total();
    if (cli !== null) costUsd = (costUsd ?? 0) + cli;
    return {
      // Over `spanMarks` rather than requests and responses alone: the span
      // openers are what tell one reply from the next, and a completion figure
      // derived without them is not the one the run page shows.
      tokens: tokenTotals(this.spanMarks),
      firstTs: this.firstTs,
      lastTs: this.lastTs,
      entries: this.entries,
      toolCalls: this.toolCalls,
      snippets: this.snippets,
      modelResponses: this.modelResponses,
      segments: segmentsFrom(this.marks),
      reportedCostUsd: costUsd,
      responseCost: this.coverage(),
      tps: tokensPerSecond(this.spanMarks),
      areas: areaFactsFrom(this.areaMarks),
      achievements: achievementFactsFrom(this.achievementMarks),
      taxi: taxiFactsFrom(this.taxiMarks, this.achievementMarks.length > 0),
      milestones: { ...areaInstantsFrom(this.areaMarks), flight: this.firstFlightTs },
      leveling: levelUpFactsFrom(this.levelUpMarks),
      deaths: deathFactsFrom(this.deathMarks, this.levelUpMarks.length > 0),
      spells: spellFactsFrom(this.spellMarks),
      talents: talentFactsFrom(this.talentMarks, this.spellMarks.length > 0),
      trades: tradeFactsFrom(this.tradeMarks, this.spellMarks.length > 0),
      resolved:
        this.resolvedModel === null && this.resolvedCli === null
          ? null
          : { model: this.resolvedModel, cliVersion: this.resolvedCli },
    };
  }
}

/** The whole-file form: one scanner, one pass, nothing retained. */
export async function scanRunTotals(path: string): Promise<RunTotals> {
  return await new RunTotalsScanner(path).scanOnce();
}

export function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
