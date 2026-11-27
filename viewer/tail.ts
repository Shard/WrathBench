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
  CostCoverage,
  DeathFacts,
  EntrySummary,
  LevelUpFacts,
  LevelUpMark,
  PartyGroupMark,
  PartyInstanceMark,
  PartyKillMark,
  ReportedUsage,
  SpellFacts,
  TalentFacts,
  TalentSpendMark,
  TaxiFacts,
  TokenTotals,
  TpsFacts,
  TrackTravelMark,
  TradeFacts,
  TradeMarkView,
} from "./api-types";
import { statSync } from "node:fs";
import { dirname } from "node:path";
import { isV1RunDir, sessionDirOfRun } from "../runner/src/run-reader";
import { TurnIndex } from "../runner/src/trace-samples";
import { isBareSessionDir } from "../runner/src/session-store";
import { feedRecordOf, pairStoreCalls, readHeldCall, readRecordRow, RecordFollower, storeCallRecordsOf, type RecordLine, type RecordLoc, type StoreCalls } from "./record-feed";
import { CodexUsageCorrector } from "../runner/src/codex-usage";
import { EVENT_WINDOW_EXCLUDE } from "../runner/src/ambient-events";
import { HistoryRebuilder, rebuildSlimRequest, slimRequest, systemTextMatches, windowEntryIndices } from "../runner/src/request-record";
import { isSlimRequest, messageChars, requestStatsOf } from "../runner/src/request-stats";
import { MODEL_RESPONSE_RECORD } from "../runner/src/archive-dir";
import { SEGMENT_MARKS } from "../runner/src/sessions";
import {
  achievementFactsFrom,
  achievementMarkOf,
  ClaudeCostTally,
  claudeTurnUsage,
  concat,
  deathFactsFrom,
  deathMarkOf,
  levelUpFactsFrom,
  levelUpMarkOf,
  reportedUsage,
  SCAN_CHUNK_BYTES,
  spellFactsFrom,
  spellMarkOf,
  splitLines,
  talentFactsFrom,
  talentMarkOf,
  taxiFactsFrom,
  taxiMarkOf,
  tokensPerSecond,
  tokenTotals,
  TPS_SPAN_OPENERS,
  tradeFactsFrom,
  tradeMarkOf,
  type AchievementMark,
  type DeathMark,
  type SpellMark,
} from "../runner/src/run-totals";
import {
  areaNamesOf,
  groupMarkOf,
  instanceMarkOf,
  killMarkOf,
  reflectMarkOf,
  reflectionWindowsFrom,
  travelMarksOf,
  type ReflectionWindow,
  type ReflectMark,
} from "./run-marks";

/** How much of any one string a summary carries before it is cut. */
export const MAX_TEXT = 2000;
/** Max array elements kept in a generic summary. */
const MAX_ARRAY = 8;

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

interface OpenAiToolCall {
  function?: { name?: unknown; arguments?: unknown };
  name?: unknown;
}

/**
 * The tools a reply called, by name as the writer recorded it. The fixed loop
 * writes the OpenAI shape (`tool_calls`, the name under `function`); the CLI
 * drivers write `tool_uses` (`{ id, name, input }`), with the CLI's own prefix
 * still on the name (`mcp__wrathbench__…`, `wrathbench.…`). Both are read; the
 * prefix is left for the page, which is what tells a call the CLI routed to
 * the run's tools from one it refused.
 */
export function toolCallNames(message: unknown): string[] {
  if (message === null || typeof message !== "object") return [];
  const m = message as { tool_calls?: unknown; tool_uses?: unknown };
  const calls = Array.isArray(m.tool_calls) ? m.tool_calls : Array.isArray(m.tool_uses) ? m.tool_uses : [];
  return calls.map((c: OpenAiToolCall) => {
    const n = c?.function?.name ?? c?.name;
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
 * array on a full record, the fresh user message on a slim one) and
 * `events_served` (every packet the SDK surfaced) — are reduced to counts here.
 * Their full content is still reachable one entry at a time through the raw
 * endpoint, a slim request's rebuilt.
 */
export function summarize(rec: Record<string, unknown>, i: number, start: number, end: number): EntrySummary {
  const t = typeof rec["t"] === "string" ? (rec["t"] as string) : "unknown";
  const ts = typeof rec["ts"] === "number" ? (rec["ts"] as number) : 0;
  const flag = { clipped: false };
  const base: EntrySummary = { i, t, ts, start, end };
  if (typeof rec["turn"] === "number") base["turn"] = rec["turn"];

  switch (t) {
    case "request": {
      // Either shape (`runner/src/request-record.ts`): a full record carries
      // its message array and the counts are taken off it; a slim one carries
      // the counts the writer took off the same array, so both read alike.
      const stats = requestStatsOf(rec);
      base["adapter"] = rec["adapter"];
      base["messageCount"] = stats.messageCount;
      base["systemChars"] = stats.systemChars;
      // The whole prompt for this turn: what the model saw as context.
      base["promptChars"] = stats.promptChars;
      const usage = reportedUsage(rec);
      if (usage !== null) base["usage"] = usage;
      // A slim request's body is one click away too, rebuilt (`TrajectoryTail.raw`).
      base["clipped"] = stats.messageCount > 0;
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
      // How much of this batch the model never saw. An older context record
      // holds the raw batch the window was cut from, ambient motion and all,
      // so the operator needs the split, not just the total; a newer one holds
      // only what was rendered and says how much it folded (`folded`, below).
      let ambient = 0;
      for (const [op, n] of tally) if (EVENT_WINDOW_EXCLUDE.test(op)) ambient += n;
      if (ambient > 0) base["ambient"] = ambient;
      // The tally is cut at six; an operator reading it must know when there
      // were more kinds than that, or the line reads as the whole story.
      if (tally.length > 6) base["moreOpcodes"] = tally.length - 6;
      // Ambient movement folded out of this reply or window, before the batch.
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
      // A CLI's summarisation call (pi), which the token totals count apart.
      if (rec["kind"] === "compaction") base["kind"] = "compaction";
      // pi's own account of the reply: how much it reasoned, why it stopped,
      // what it cost, and an errored reply's message, capped by the writer.
      if (typeof rec["thinkingChars"] === "number") base["thinkingChars"] = rec["thinkingChars"];
      if (typeof rec["stopReason"] === "string") base["stopReason"] = rec["stopReason"];
      if (typeof rec["piCostUsd"] === "number") base["piCostUsd"] = rec["piCostUsd"];
      if (typeof rec["error"] === "string") base["error"] = clip(rec["error"], 600).text;
      base["clipped"] = c.clipped;
      return base;
    }
    case "snippet": {
      const c = clip(typeof rec["code"] === "string" ? rec["code"] : "", 8000);
      base["code"] = c.text;
      base["clipped"] = c.clipped;
      return base;
    }
    case "actions": {
      // Kept whole: the sandbox already bounds a record (120 notes per flush,
      // strings clipped at write), and the generic shrink below would cut the
      // list to eight and the notes' `names` at depth three. Secret-named keys
      // are still stripped, as everywhere a record reaches a client.
      if (typeof rec["callTs"] === "number") base["callTs"] = rec["callTs"];
      if (rec["routine"] === true) base["routine"] = true;
      base["actions"] = Array.isArray(rec["actions"]) ? redactSecrets(rec["actions"]) : [];
      if (rec["dropped"] !== null && typeof rec["dropped"] === "object") base["dropped"] = redactSecrets(rec["dropped"]);
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
 * How much of a run the per-response cost actually covers.
 *
 * A run whose process was replaced mid-flight — the fleet resumes rather than
 * recreates — can have responses from before the adapter recorded `usage.cost`
 * and responses from after. Summing them yields a number that looks like a bill
 * for the whole run and is a bill for part of it, which is worse than a blank.
 * The counts let the cost note say so.
 *
 * `costed` is 0 for the claude-code driver whatever the run did: its figure
 * comes off `claude_result`, not off responses. Its partial case is a
 * different shape — turns no result covers — and is carried as `unreported`
 * (`ClaudeCostTally`).
 */
export function responseCostCoverage(entries: readonly { t: string; [k: string]: unknown }[]): CostCoverage {
  let costed = 0;
  let uncosted = 0;
  const claude = new ClaudeCostTally();
  for (const e of entries) {
    claude.note(e);
    if (e.t !== MODEL_RESPONSE_RECORD) continue;
    const usage = e["usage"] as ReportedUsage | undefined;
    if (typeof usage?.cost === "number" && Number.isFinite(usage.cost)) costed++;
    else uncosted++;
  }
  const unreported = claude.unreported();
  return unreported === undefined ? { costed, uncosted } : { costed, uncosted, unreported };
}

/**
 * Whether a record belongs in the feed the API serves.
 *
 * The trajectory on disk stays complete — this decides only what the run page
 * is handed. The claude-code driver forwards every CLI system message, and its
 * `thinking_tokens` envelopes are a running estimate, hundreds of them on a
 * long run, that rendered as raw JSON rows on a page that is already heavy.
 * Dropped from the served list on the operator's call, 2026-09-01; their sum
 * rides on the next served reply instead (`TrajectoryTail.thinkingSince`),
 * a figure on a card rather than a row. The `init` envelope stays: it is the session and driver marker
 * the cost tally, the resolved model and the claude mark all read, and it is
 * the one carrying `session_id` for every session a run opens.
 *
 * Records that will not parse are not reachable here; they surface as
 * `unparseable-line` and must, since a line nobody can read is a defect.
 */
function isServedEntry(rec: Record<string, unknown>): boolean {
  return !(rec["t"] === "claude_system" && rec["subtype"] === "thinking_tokens");
}

/**
 * A `thinking_tokens` marker's increment. The markers' `estimated_tokens` is
 * a running total within one message, so the deltas are what sum across the
 * messages between two replies; 0 for any other record.
 */
function thinkingDeltaOf(rec: Record<string, unknown>): number {
  if (rec["t"] !== "claude_system" || rec["subtype"] !== "thinking_tokens") return 0;
  const d = rec["estimated_tokens_delta"];
  return typeof d === "number" && Number.isFinite(d) && d > 0 ? d : 0;
}

/** A complete line that is not JSON must surface, never vanish. */
function unparseable(text: string, i: number, start: number, end: number): EntrySummary {
  return { i, t: "unparseable-line", ts: 0, start, end, line: clip(text, 400).text, clipped: true };
}

/**
 * A trajectory record that the first v1 builds wrote beside the session
 * record's own row for the same thing (wrath-mcp#29 phase 1): a milestone, a
 * turn-in, the action log, a movement intention, a tool's event batch. A v1
 * run's feed takes those from the record (`record-feed.ts`), so these are
 * skipped rather than shown twice.
 */
function isRecordMirror(rec: Record<string, unknown>): boolean {
  const t = rec["t"];
  return t === "milestone" || t === "quest_complete" || t === "actions" || t === "move" || (t === "events_served" && rec["via"] === "tool");
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
  private readonly levelUpMarks: LevelUpMark[] = [];
  private readonly deathMarks: DeathMark[] = [];
  private readonly spellMarks: SpellMark[] = [];
  private readonly talentMarks: TalentSpendMark[] = [];
  private readonly tradeMarks: TradeMarkView[] = [];
  /** The replay's flight, hearth and graveyard marks; see `travelMarksOf`. */
  private readonly travelMarks: TrackTravelMark[] = [];
  /** A party member's map transfers, kills and group changes (`instanceMarkOf`, `killMarkOf`, `groupMarkOf`). */
  private readonly instanceMarks: PartyInstanceMark[] = [];
  private readonly killMarks: PartyKillMark[] = [];
  private readonly groupMarks: PartyGroupMark[] = [];
  /** Zone and area names by id, off the served `WB_AREA` events (`areaNamesOf`); the newest wins. */
  private readonly zoneNameOf = new Map<number, string>();
  private readonly areaNameOf = new Map<number, string>();
  /** `reflect_window` transitions, for the run page's per-turn accent. */
  private readonly reflectMarks: ReflectMark[] = [];
  /**
   * Which entry carries the system prompt text for each hash a slim request
   * points at, so `raw` rebuilds one without walking a long segment back to
   * its first request. Any entry carrying the text will do: the text is
   * checked against the hash before it is used.
   */
  private readonly systemTextAt = new Map<string, number>();
  /** Per-turn codex usage for records written before the driver logged it; see `CodexUsageCorrector`. */
  private readonly codexUsage = new CodexUsageCorrector();
  /**
   * The claude-code thinking estimate since the last served `response`: the
   * `thinking_tokens` markers are not served (`isServedEntry`), so their sum
   * rides on the next reply's summary as `thinkingTokens` instead.
   */
  private thinkingSince = 0;
  /** The turn in flight at an instant, from the lines read so far: the session record's rows are joined to turns by it. */
  private turns = new TurnIndex();
  /** Whether this is a v1 run, whose game side is its session record's; latched once seen. */
  private v1 = false;
  /** The session record's `events` and `calls`, followed; null for a 0.5 run. */
  private follower: RecordFollower | null = null;
  /** Record rows read but not yet in the feed: each waits for the trajectory to reach its stamp. */
  private readonly pendingRecord: RecordLine[] = [];
  /** Where each entry that came from the session record is, by entry index, for `raw`. */
  private readonly recordLocs = new Map<number, RecordLoc>();
  /** Whether this is a session read from a wrath-mcp store, whose tool calls are its record's (`pairStoreCalls`); latched once seen. */
  private store = false;
  /** A store session's calls read without their result yet, and how many it has read. */
  private storeCalls: StoreCalls = { held: new Map(), count: 0 };
  /** Where each entry drawn from a store session's call is, by entry index, for `raw`: its result, its call, and which of the call's records it is. */
  private readonly storeCallLocs = new Map<number, { result: RecordLoc; call: { loc: RecordLoc; id: number; n: number } | null; part: number }>();
  /**
   * The last timestamp the FILE carries, served or not: the run page closes a
   * finished run's last segment on it, and `scanRunTotals` reads it off every
   * line. Folding it out of the served list instead would let a run whose last
   * record is one of the envelopes `isServedEntry` drops report a shorter
   * playtime on the run page than in the listing.
   */
  private lastTsSeen: number | null = null;
  /** Bytes consumed as complete lines. */
  private consumed = 0;
  /** Bytes after the last newline: an entry still being written. */
  private pending: Uint8Array = new Uint8Array(0);
  private readonly decoder = new TextDecoder();
  /** Read window; only a test narrows it, to exercise a record split across two. */
  private readonly chunkBytes: number;
  /**
   * Bumped every time the index is dropped and rebuilt (a truncated or rotated
   * file). A reader holding a position in `entries` — an SSE stream's cursor —
   * compares it to know that position no longer means anything.
   */
  private gen = 0;
  /**
   * The served entries `replySpans` reads, and through it `tokenTotals` and
   * `tokensPerSecond`: requests, responses, `claude_result`, the span openers,
   * the segment marks, every `driver` line and the first `claude_system`. Every
   * other record is skipped by both derivations without effect, so they answer
   * over this the same as over `entries` — the subset `RunTotalsScanner`
   * keeps for the same reason — and a live run's figure costs a pass over its
   * turns rather than over every state sample and event it ever wrote. The
   * objects are the ones in `entries`, so it costs a pointer each.
   */
  private readonly spanEntries: EntrySummary[] = [];
  private sawClaudeSystem = false;
  /** `reportedCostUsd` and `responseCostCoverage`, accumulated over the served entries in order. */
  private claudeCost = new ClaudeCostTally();
  private responseCostUsd: number | null = null;
  private costed = 0;
  private uncosted = 0;
  /** The run page's segment marks: every `SEGMENT_MARKS` entry, and the first entry with a timestamp. */
  private readonly segmentMarkList: { t: string; ts: number }[] = [];
  /**
   * `tokenTotals` and `tokensPerSecond` over `spanEntries`, held until the
   * index grows or is rebuilt. Shared by every open stream and the run page's
   * poll, so N watchers of a live run cost one derivation per batch, not N.
   * Keyed on (generation, span count): both derivations read nothing else.
   */
  private spanMemo: { gen: number; n: number; tokens?: TokenTotals; tps?: TpsFacts } | null = null;

  constructor(path: string, chunkBytes: number = SCAN_CHUNK_BYTES) {
    this.path = path;
    this.chunkBytes = Math.max(1, chunkBytes);
  }

  /** See `gen`: changes exactly when `entries` was emptied and re-read. */
  get generation(): number {
    return this.gen;
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
      // A bare session (`runner/src/session-store.ts`) has no trajectory at all: its feed is its record's alone.
      if (!isBareSessionDir(dirname(this.path))) return [];
      size = 0;
    }
    if (size < this.size) {
      this.entries.length = 0;
      this.consumed = 0;
      this.pending = new Uint8Array(0);
      // The accumulators are part of the index: a truncated or rotated file is
      // re-read whole, and keeping them would double-count everything in it.
      this.achievementMarks.length = 0;
      this.taxiMarks.length = 0;
      this.levelUpMarks.length = 0;
      this.deathMarks.length = 0;
      this.spellMarks.length = 0;
      this.talentMarks.length = 0;
      this.tradeMarks.length = 0;
      this.travelMarks.length = 0;
      this.instanceMarks.length = 0;
      this.killMarks.length = 0;
      this.groupMarks.length = 0;
      this.zoneNameOf.clear();
      this.areaNameOf.clear();
      this.reflectMarks.length = 0;
      this.systemTextAt.clear();
      this.codexUsage.reset();
      this.thinkingSince = 0;
      this.lastTsSeen = null;
      this.spanEntries.length = 0;
      this.sawClaudeSystem = false;
      this.claudeCost = new ClaudeCostTally();
      this.responseCostUsd = null;
      this.costed = 0;
      this.uncosted = 0;
      this.segmentMarkList.length = 0;
      this.spanMemo = null;
      this.turns = new TurnIndex();
      this.follower = null;
      this.pendingRecord.length = 0;
      this.recordLocs.clear();
      this.storeCalls = { held: new Map(), count: 0 };
      this.storeCallLocs.clear();
      this.gen++;
    }
    // A v1 run's game side is its session record's, merged in by time (`record-feed.ts`).
    if (!this.v1 && isV1RunDir(dirname(this.path))) this.v1 = true;
    if (this.v1 && this.follower === null) this.follower = new RecordFollower(sessionDirOfRun(dirname(this.path)));
    // A store session has no trajectory, so its record's calls are its feed's (`pairStoreCalls`).
    if (!this.store && isBareSessionDir(dirname(this.path))) this.store = true;
    this.followRecord();
    if (size === this.size && this.pendingRecord.length === 0) return [];

    const added: EntrySummary[] = [];
    // A window at a time; see `SCAN_CHUNK_BYTES`. Byte offsets are the file's
    // throughout, because `this.consumed` is where the previous window stopped.
    while (this.size < size) {
      const windowEnd = Math.min(size, this.size + this.chunkBytes);
      const fresh = new Uint8Array(await Bun.file(this.path).slice(this.size, windowEnd).arrayBuffer());
      const buf = this.pending.length === 0 ? fresh : concat(this.pending, fresh);
      const { lines, rest } = splitLines(buf);

      let offset = this.consumed;
      for (const line of lines) {
        const start = offset;
        const end = start + line.length;
        offset = end + 1; // the newline
        if (line.length === 0) continue;
        const text = this.decoder.decode(line);
        let rec: Record<string, unknown> | null = null;
        try {
          rec = JSON.parse(text) as Record<string, unknown>;
        } catch {
          /* summarised as unparseable below */
        }
        if (rec !== null) {
          this.turns.note(rec);
          // The session record's rows from before this line come first: the feed is in time order.
          if (this.pendingRecord.length > 0 && typeof rec["ts"] === "number") this.flushRecord(rec["ts"], added);
          // What a first-build v1 trajectory mirrored of the record is read off the record alone.
          if (this.v1 && isRecordMirror(rec)) continue;
        }
        this.take(rec, text, start, end, added);
      }
      this.consumed = offset;
      this.pending = rest.length === 0 ? new Uint8Array(0) : new Uint8Array(rest);
    }
    // Whatever of the record is newer than every trajectory line read.
    this.flushRecord(Infinity, added);
    return added;
  }

  /**
   * Read the session record on from where the last scan stopped, into the
   * rows waiting to be merged into the feed (`record-feed.ts`), oldest first.
   */
  private followRecord(): void {
    if (this.follower === null) return;
    const read = this.follower.read();
    const lines = this.store ? pairStoreCalls(read, this.storeCalls) : read;
    if (lines.length === 0) return;
    this.pendingRecord.push(...lines);
    this.pendingRecord.sort((a, b) => a.row.ts - b.row.ts);
  }

  /** Feed the waiting record rows stamped at or before `ts`, each as the trajectory record it stands for. */
  private flushRecord(ts: number, added: EntrySummary[]): void {
    let n = 0;
    while (n < this.pendingRecord.length && this.pendingRecord[n]!.row.ts <= ts) n++;
    if (n === 0) return;
    for (const line of this.pendingRecord.splice(0, n)) {
      if (this.store && line.loc.stream === "calls" && line.row.kind === "result") {
        // A store session's call and its result: the call's records, drawn where it returned.
        const call = line.call !== undefined ? { loc: line.call.loc, id: line.call.row.id, n: line.call.n } : null;
        for (const [part, rec] of storeCallRecordsOf(line.call ?? null, line.row).entries()) {
          this.storeCallLocs.set(this.entries.length, { result: line.loc, call, part });
          this.take(rec, JSON.stringify(rec), -1, -1, added);
        }
        continue;
      }
      const rec = feedRecordOf(line.row, this.turns.at(line.row.ts), line.loc.stream);
      if (rec === null) continue;
      this.recordLocs.set(this.entries.length, line.loc);
      this.take(rec, JSON.stringify(rec), -1, -1, added);
    }
  }

  /**
   * One record into the index: every accumulator, then the feed. `rec` null
   * is a line that will not parse. A trajectory line's `start`/`end` are its
   * bytes in the file; a session record row's are -1, and `recordLocs` says
   * where it is.
   */
  private take(rec: Record<string, unknown> | null, text: string, start: number, end: number, added: EntrySummary[]): void {
        const i = this.entries.length;
        let summary: EntrySummary;
        try {
          if (rec === null) throw new Error("unparseable");
          // Before anything reads its usage: a codex response written before
          // the driver logged per-turn deltas carries the thread's total.
          this.codexUsage.note(rec);
          if (rec["t"] === "milestone") {
            const ach = achievementMarkOf(rec);
            if (ach !== null) this.achievementMarks.push(ach);
            const taxi = taxiMarkOf(rec);
            if (taxi !== null) this.taxiMarks.push(taxi);
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
            const instance = instanceMarkOf(rec);
            if (instance !== null) this.instanceMarks.push(instance);
            const kill = killMarkOf(rec);
            if (kill !== null) this.killMarks.push(kill);
            const group = groupMarkOf(rec);
            if (group !== null) this.groupMarks.push(group);
          }
          const names = areaNamesOf(text);
          for (const [id, name] of names.zones) this.zoneNameOf.set(id, name);
          for (const [id, name] of names.areas) this.areaNameOf.set(id, name);
          // Milestones and the action log both: the hearthstone is a dispatch.
          for (const mark of travelMarksOf(rec)) this.travelMarks.push(mark);
          // Not a milestone: its own record kind, written by the loop's builder.
          const reflect = reflectMarkOf(rec);
          if (reflect !== null) this.reflectMarks.push(reflect);
          const ts = rec["ts"];
          // The file's, never a session record row's: the run page closes a finished run's last segment on it.
          if (start >= 0 && typeof ts === "number" && ts > 0) this.lastTsSeen = ts;
          // After the accumulators, so a record that is not served still counts
          // toward everything derived from the file, and after the offset above,
          // so the byte range of every later entry — what `raw` reads — stands.
          if (!isServedEntry(rec)) {
            this.thinkingSince += thinkingDeltaOf(rec);
            return;
          }
          if (rec["t"] === "request" && typeof rec["systemText"] === "string" && typeof rec["systemHash"] === "string") {
            this.systemTextAt.set(rec["systemHash"], i);
          }
          summary = summarize(rec, i, start, end);
          if (rec["t"] === "response" && this.thinkingSince > 0) {
            summary["thinkingTokens"] = this.thinkingSince;
            this.thinkingSince = 0;
          }
        } catch {
          summary = unparseable(text, i, start, end);
        }
        this.entries.push(summary);
        this.index(summary);
        added.push(summary);
  }

  /**
   * Fold one served entry into the run page's accumulators, in file order —
   * the same order the whole-list functions they stand in for walk `entries`.
   */
  private index(e: EntrySummary): void {
    const t = e.t;
    if (e.ts > 0 && (SEGMENT_MARKS.has(t) || this.segmentMarkList.length === 0)) {
      this.segmentMarkList.push({ t, ts: e.ts });
    }
    this.claudeCost.note(e);
    if (t === MODEL_RESPONSE_RECORD) {
      const c = (e["usage"] as ReportedUsage | undefined)?.cost;
      if (typeof c === "number" && Number.isFinite(c)) {
        this.costed++;
        this.responseCostUsd = (this.responseCostUsd ?? 0) + c;
      } else {
        this.uncosted++;
      }
    }
    let span = t === "request" || t === "response" || t === "claude_result" || t === "driver";
    span ||= TPS_SPAN_OPENERS.has(t) || SEGMENT_MARKS.has(t);
    if (!span && t === "claude_system" && !this.sawClaudeSystem) {
      this.sawClaudeSystem = true;
      span = true;
    }
    if (span) this.spanEntries.push(e);
  }

  /** The memo for the current index, fresh when it has grown or been rebuilt since. */
  private spans(): { gen: number; n: number; tokens?: TokenTotals; tps?: TpsFacts } {
    const m = this.spanMemo;
    if (m !== null && m.gen === this.gen && m.n === this.spanEntries.length) return m;
    this.spanMemo = { gen: this.gen, n: this.spanEntries.length };
    return this.spanMemo;
  }

  /** `tokenTotals(entries)`, without walking every entry each time it is asked. */
  get tokens(): TokenTotals {
    const m = this.spans();
    m.tokens ??= tokenTotals(this.spanEntries);
    return m.tokens;
  }

  /** `tokensPerSecond(entries)`, off the same memo. */
  get tps(): TpsFacts {
    const m = this.spans();
    m.tps ??= tokensPerSecond(this.spanEntries);
    return m.tps;
  }

  /** `reportedCostUsd(entries)`, accumulated as the file is indexed. */
  get reportedCostUsd(): number | null {
    const cli = this.claudeCost.total();
    return cli === null ? this.responseCostUsd : (this.responseCostUsd ?? 0) + cli;
  }

  /** `responseCostCoverage(entries)`, accumulated as the file is indexed. */
  get costCoverage(): CostCoverage {
    const unreported = this.claudeCost.unreported();
    return unreported === undefined
      ? { costed: this.costed, uncosted: this.uncosted }
      : { costed: this.costed, uncosted: this.uncosted, unreported };
  }

  /** The marks `segmentsFrom` reads for the run page's sessions and playtime. */
  get segmentMarks(): readonly { t: string; ts: number }[] {
    return this.segmentMarkList;
  }

  /** The last timestamp in the file, from records served and dropped alike. */
  get lastTs(): number | null {
    return this.lastTsSeen;
  }

  /** Achievements this run's records account for; null when it wrote none. */
  get achievements(): AchievementFacts | null {
    return achievementFactsFrom(this.achievementMarks);
  }

  /** Flights taken; null when flights were not recorded for this run. */
  get taxi(): TaxiFacts | null {
    return taxiFactsFrom(this.taxiMarks, this.achievementMarks.length > 0);
  }

  /** The level timeline; null when the run wrote no level milestone. */
  get leveling(): LevelUpFacts | null {
    return levelUpFactsFrom(this.levelUpMarks);
  }

  /** Deaths, releases and resurrects; null when none of it was recorded. */
  get deaths(): DeathFacts | null {
    return deathFactsFrom(this.deathMarks, this.levelUpMarks.length > 0);
  }

  /** Spells learned; null when the run recorded no spellbook milestone. */
  get spells(): SpellFacts | null {
    return spellFactsFrom(this.spellMarks);
  }

  /** Talent points spent; null when learning was not recorded for this run. */
  get talents(): TalentFacts | null {
    return talentFactsFrom(this.talentMarks, this.spellMarks.length > 0);
  }

  /** Completed trades; null when they were not recorded for this run. */
  get trades(): TradeFacts | null {
    return tradeFactsFrom(this.tradeMarks, this.spellMarks.length > 0);
  }

  /**
   * The replay's travel marks, oldest first. Sorted rather than in file order:
   * an `actions` record is flushed after the dispatches it lists, so a hearth
   * can land in the file after a milestone stamped later than it.
   */
  get travel(): TrackTravelMark[] {
    return [...this.travelMarks].sort((a, b) => a.ts - b.ts);
  }

  /** Map transfers into and out of an instance, oldest first. */
  get instances(): PartyInstanceMark[] {
    return [...this.instanceMarks].sort((a, b) => a.ts - b.ts);
  }

  /** Kills the server reported to this run, oldest first; names unattached. */
  get kills(): PartyKillMark[] {
    return [...this.killMarks].sort((a, b) => a.ts - b.ts);
  }

  /** `group` milestones, oldest first. */
  get groups(): PartyGroupMark[] {
    return [...this.groupMarks].sort((a, b) => a.ts - b.ts);
  }

  /** The zone name the client was served for an id, or null when this run saw none. */
  zoneName(id: number): string | null {
    return this.zoneNameOf.get(id) ?? null;
  }

  /** The area name the client was served for an id, or null when this run saw none. */
  areaName(id: number): string | null {
    return this.areaNameOf.get(id) ?? null;
  }

  /**
   * The turns this run spent reflecting. Empty when it wrote no window record,
   * which a run that never reflected and a run from before the record shipped
   * are both — there is no witness that tells them apart, and the accent this
   * feeds draws nothing either way.
   */
  get reflections(): ReflectionWindow[] {
    return reflectionWindowsFrom(this.reflectMarks);
  }

  /**
   * The raw JSON text of one entry, read back from disk.
   *
   * A slim request is served as what the model saw, not as the slim line:
   * the record with `messages` rebuilt from the file through the replay's own
   * code (`runner/src/request-record.ts`), and a `rebuilt` verdict saying
   * whether the rebuild hashed to the bytes that were sent. A rebuild that
   * fails says why and still serves the record; it never passes silently.
   */
  async raw(i: number): Promise<string | null> {
    const e = this.entries[i];
    if (e === undefined) return null;
    const stored = this.storeCallLocs.get(i);
    if (stored !== undefined) {
      // A store session's call: its result and its call read again, and served as the record the feed drew.
      const dir = sessionDirOfRun(dirname(this.path));
      const result = readRecordRow(dir, stored.result);
      if (result === null || result.kind !== "result") return null;
      const call = stored.call !== null ? readHeldCall(dir, stored.call.loc, stored.call.id) : null;
      if (stored.call !== null && call === null) return null;
      const rec = storeCallRecordsOf(call !== null ? { row: call, n: stored.call!.n } : null, result)[stored.part];
      return rec === undefined ? null : redactRawLine(JSON.stringify(rec));
    }
    const loc = this.recordLocs.get(i);
    if (loc !== undefined) {
      // A session record row: read again, and served as the record the feed drew.
      const row = readRecordRow(sessionDirOfRun(dirname(this.path)), loc);
      const rec = row === null ? null : feedRecordOf(row, this.turns.at(row.ts), loc.stream);
      return rec === null ? null : redactRawLine(JSON.stringify(rec));
    }
    const text = await this.lineOf(e);
    if (e.t !== "request") return redactRawLine(text);
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return redactRawLine(text);
    }
    if (!isSlimRequest(rec)) return redactRawLine(text);
    const rebuilt = await this.rebuildRequest(i, rec);
    const body = {
      ...rec,
      ...(rebuilt.messages !== undefined ? { messages: rebuilt.messages } : {}),
      rebuilt: rebuilt.ok ? { verified: true } : { verified: false, error: rebuilt.error },
    };
    return JSON.stringify(redactSecrets(body));
  }

  private async lineOf(e: EntrySummary): Promise<string> {
    return await Bun.file(this.path).slice(e.start, e.end).text();
  }

  /** One slim request rebuilt off the indexed file, walking back over its window only. */
  private async rebuildRequest(
    i: number,
    rec: Record<string, unknown>,
  ): Promise<{ ok: boolean; error?: string; messages?: unknown[] }> {
    const slim = slimRequest(rec);
    if (typeof slim === "string") return { ok: false, error: slim };
    let systemText = slim.systemText;
    if (systemText === undefined) {
      const at = this.systemTextAt.get(slim.systemHash);
      const holder = at === undefined ? undefined : this.entries[at];
      if (holder !== undefined) {
        try {
          const text = (JSON.parse(await this.lineOf(holder)) as { systemText?: unknown }).systemText;
          if (typeof text === "string" && systemTextMatches(text, slim.systemHash)) systemText = text;
        } catch {
          /* an unreadable holder is a missing text, which the rebuild names */
        }
      }
    }
    const indices = windowEntryIndices(this.entries, i, slim);
    let window: ReturnType<HistoryRebuilder["window"]>;
    if (typeof indices === "string") {
      window = indices;
    } else {
      const history = new HistoryRebuilder();
      for (const j of indices) {
        try {
          history.take(JSON.parse(await this.lineOf(this.entries[j]!)) as Record<string, unknown>);
        } catch {
          /* a line that will not parse leaves the window short, which the rebuild names */
        }
      }
      window = history.window(0, history.length);
    }
    const out = rebuildSlimRequest(slim, systemText, window);
    return out.ok
      ? { ok: true, messages: out.messages }
      : { ok: false, error: out.error, ...(out.messages !== undefined ? { messages: out.messages } : {}) };
  }
}
