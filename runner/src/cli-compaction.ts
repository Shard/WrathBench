/**
 * The CLI scaffolds' own context compaction: when the harness asks for an
 * episodic status entry because of it, and how each compaction is recorded.
 *
 * The decision is docs/METHODOLOGY.md, "An episodic log, asked for at each
 * trim or compaction, read back at rest or in flight" (operator, 2026-10-14).
 * The fixed loop asks on the last turn before its own block trim, which it
 * knows exactly. The CLI drivers (`adapter-codex.ts`, `adapter-claude.ts`) run
 * no trim; the CLI compacts its history itself, mid-turn, and the harness can
 * speak to the model only through the next turn's context message. So the ask
 * is a prediction where the CLI's reported usage makes one, and a statement
 * of fact otherwise:
 *
 * - **Before.** At each turn boundary the driver hands over the context size
 *   the CLI last reported and the CLI's auto-compaction threshold, as far as
 *   it can be derived from what the CLI reported. The ask goes out when the
 *   context plus `COMPACTION_ASK_LOOKAHEAD_TURNS` times the largest per-turn
 *   growth seen since the last compaction reaches the threshold: the crossing
 *   is then predicted within the next two turns, so the ask lands with about a
 *   turn to spare. Replayed on the GPT-6.1 Sol freeplay rollout (72
 *   compactions in about 1,840 turns), that rule asked at least one full turn
 *   ahead 71 times, at the start of the compacting turn once — where the CLI
 *   still compacts only after the turn's first call — and never missed. A
 *   lookahead of one turn asked in the compacting turn itself 63 times.
 * - **After.** A compaction that arrives with no ask before it in its cycle
 *   — no threshold known yet, a turn whose growth the prediction did not
 *   cover, a claude-code turn long enough to cross it alone — gets the ask on
 *   the next turn, saying it already happened.
 *
 * At most one ask per cycle (the span between two compactions), re-armed by
 * each compaction. Per episode and never persisted, like the reflection gate:
 * a resumed run starts a fresh CLI conversation.
 *
 * The threshold is also learned: the lowest context a compaction was reported
 * at in this run caps the derived one. The derivation is a pinned CLI's rule
 * (`codexAutoCompactLimit`, `claudeAutoCompactLimit`), and the claude-code
 * CLI can apply a per-model default window the stream never names, so the
 * run's own compactions are the better witness once there is one.
 *
 * Nothing here changes what the model sees beyond the one notice per cycle:
 * the compaction records are trajectory only.
 */

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import type { HarnessNotice } from "./sandbox/host";

// ------------------------------------------------------------------ the ask

/** Turns of growth the prediction looks ahead; see the header for the replay behind 2. */
export const COMPACTION_ASK_LOOKAHEAD_TURNS = 2;

/**
 * The two notices, the same bytes on both CLIs (no vendor named), phrased as
 * the fixed loop's `trim_pending` is. "The CLI" is the prompt's own name for
 * what owns the conversation on these harnesses (`contextSentence`).
 */
export const COMPACTION_PENDING_NOTICE =
  "The CLI will soon compact older conversation into a summary. Record a short status entry — " +
  "what you are doing and how it is going — with log_status.";
export const COMPACTED_NOTICE =
  "The CLI has compacted older conversation into a summary. Record a short status entry — " +
  "what you are doing and how it is going — with log_status.";

export type CompactionAskTiming = "before" | "after";

/** One ask, with the inputs it was decided on, for the `compaction_ask` record. */
export interface CompactionAskDecision {
  ask: CompactionAskTiming;
  /** The context size the decision read, tokens; null when the CLI reported none. */
  context: number | null;
  /** The threshold it compared against (derived, capped by learned); null when unknown. */
  threshold: number | null;
  /** The largest per-turn growth in the cycle; null when none was measured. */
  growth: number | null;
}

/** What a driver knows at a turn boundary. */
export interface CompactionTurn {
  /** The context the CLI last reported, tokens (its last call's input plus output). */
  context?: number | undefined;
  /** The CLI's auto-compaction threshold as derived from what it reported. */
  threshold?: number | undefined;
  /** Each compaction the CLI reported during the turn, by the context it compacted at (null: not said). */
  compactions: readonly (number | null)[];
}

/** The notice an ask is delivered as, in the next turn's context. */
export function compactionNotice(ask: CompactionAskTiming, ts: number): HarnessNotice {
  return ask === "before"
    ? { ts, kind: "compaction_pending", text: COMPACTION_PENDING_NOTICE }
    : { ts, kind: "compacted", text: COMPACTED_NOTICE };
}

/** The per-episode trigger. Pure: fed once per turn boundary, answers with at most one ask. */
export class CompactionAsk {
  /** Whether this cycle's one ask has gone out. */
  private asked = false;
  private lastContext: number | undefined;
  /** The largest per-turn rise of the context in this cycle; 0 until two readings exist. */
  private maxGrowth = 0;
  /** The lowest context any compaction in this run was reported at. */
  private learned: number | undefined;

  noteTurn(o: CompactionTurn): CompactionAskDecision | null {
    const context = typeof o.context === "number" && Number.isFinite(o.context) && o.context > 0 ? o.context : undefined;
    if (o.compactions.length > 0) {
      for (const pre of o.compactions) {
        if (typeof pre === "number" && Number.isFinite(pre) && pre > 0) this.learned = Math.min(this.learned ?? pre, pre);
      }
      const askedBefore = this.asked;
      const growth = this.maxGrowth;
      // A new cycle, measured from the context the compaction left.
      this.asked = false;
      this.maxGrowth = 0;
      this.lastContext = context;
      if (askedBefore) return null;
      return { ask: "after", context: context ?? null, threshold: this.threshold(o.threshold) ?? null, growth: growth > 0 ? growth : null };
    }
    if (context === undefined) return null;
    if (this.lastContext !== undefined && context > this.lastContext) {
      this.maxGrowth = Math.max(this.maxGrowth, context - this.lastContext);
    }
    this.lastContext = context;
    const threshold = this.threshold(o.threshold);
    if (this.asked || this.maxGrowth === 0 || threshold === undefined) return null;
    if (context + COMPACTION_ASK_LOOKAHEAD_TURNS * this.maxGrowth < threshold) return null;
    this.asked = true;
    return { ask: "before", context, threshold, growth: this.maxGrowth };
  }

  private threshold(derived: number | undefined): number | undefined {
    const d = typeof derived === "number" && Number.isFinite(derived) && derived > 0 ? derived : undefined;
    if (d === undefined) return this.learned;
    return this.learned === undefined ? d : Math.min(d, this.learned);
  }
}

// ------------------------------------------------------------- thresholds

/**
 * The Codex CLI's auto-compaction threshold, from the window it reports.
 *
 * In the pinned CLI (0.159.3, `codex-rs/protocol/src/openai_models.rs`,
 * `ModelInfo::auto_compact_token_limit`) the threshold is 90% of the model's
 * catalogue `context_window`, while the `model_context_window` every
 * `token_count` event reports is `usable_context_window`, that window times
 * `effective_context_window_percent` — 95 for every model in the ChatGPT
 * catalogue and the field's default. So 475,000 reported is 450,000 (GPT-6.1
 * Sol: no call at or above it went uncompacted across 72 cycles) and 258,400
 * is 244,800 (GPT-6 Astra, whose context peaked about 242k). Re-checked at
 * every CLI bump, like `DISABLED_FEATURES`.
 */
export const CODEX_AUTO_COMPACT_PERCENT = 90;
export const CODEX_EFFECTIVE_WINDOW_PERCENT = 95;

export function codexAutoCompactLimit(reportedWindow: number): number {
  const window = Math.round((reportedWindow * 100) / CODEX_EFFECTIVE_WINDOW_PERCENT);
  return Math.floor((window * CODEX_AUTO_COMPACT_PERCENT) / 100);
}

/**
 * The Claude Code CLI's auto-compaction threshold. In the pinned CLI the
 * effective window is the compaction window less `min(maxOutputTokens,
 * 20000)` reserved for the summary, and compaction starts 13,000 below that
 * (`autocompact: … effectiveWindow=980000` for Claude Haiku 5.5 on `auto`,
 * whose compactions were reported at a `pre_tokens` of 967,077). The window
 * is the run's `compactWindow` when set, never more than the model's
 * `contextWindow` from the `result` envelope's `modelUsage`. On `auto` the
 * CLI may apply a per-model default below the context window, which the
 * stream does not name; the learned threshold (`CompactionAsk`) corrects for
 * that from the first compaction on.
 */
export const CLAUDE_SUMMARY_OUTPUT_RESERVE = 20_000;
export const CLAUDE_AUTO_COMPACT_BUFFER = 13_000;

/** `compactWindow`'s canonical spelling (`100k`, `1M`) in tokens; undefined for anything else. */
export function compactWindowTokens(window: string | undefined): number | undefined {
  if (window === undefined) return undefined;
  const k = /^(\d+)k$/.exec(window);
  if (k !== null) return Number(k[1]) * 1_000;
  const m = /^(\d+)M$/.exec(window);
  return m !== null ? Number(m[1]) * 1_000_000 : undefined;
}

export function claudeAutoCompactLimit(o: {
  contextWindow: number;
  maxOutputTokens?: number | undefined;
  compactWindow?: string | undefined;
}): number | undefined {
  if (!(o.contextWindow > 0)) return undefined;
  const configured = compactWindowTokens(o.compactWindow);
  const window = configured === undefined ? o.contextWindow : Math.min(configured, o.contextWindow);
  const reserve = Math.min(o.maxOutputTokens !== undefined && o.maxOutputTokens > 0 ? o.maxOutputTokens : CLAUDE_SUMMARY_OUTPUT_RESERVE, CLAUDE_SUMMARY_OUTPUT_RESERVE);
  const limit = window - reserve - CLAUDE_AUTO_COMPACT_BUFFER;
  return limit > 0 ? limit : undefined;
}

/**
 * The main model's window off a `result` envelope's `modelUsage`, keyed by
 * model id: the entry for the model the CLI resolved at `init` when there is
 * one, else the only entry, else none — a side model's window is not the one
 * the conversation compacts against.
 */
export function claudeModelWindow(
  modelUsage: unknown,
  resolvedModel: string | undefined,
): { contextWindow: number; maxOutputTokens?: number } | undefined {
  if (modelUsage === null || typeof modelUsage !== "object") return undefined;
  const entries = Object.entries(modelUsage as Record<string, unknown>);
  const pick = (resolvedModel !== undefined ? entries.find(([k]) => k === resolvedModel) : undefined) ?? (entries.length === 1 ? entries[0] : undefined);
  const u = pick?.[1];
  if (u === null || typeof u !== "object") return undefined;
  const cw = (u as Record<string, unknown>)["contextWindow"];
  const mo = (u as Record<string, unknown>)["maxOutputTokens"];
  if (typeof cw !== "number" || !(cw > 0)) return undefined;
  return typeof mo === "number" && mo > 0 ? { contextWindow: cw, maxOutputTokens: mo } : { contextWindow: cw };
}

// ----------------------------------------------------------------- record

/**
 * One CLI compaction on the trajectory: a `harness` record of kind
 * `compaction`, the same field names on both CLI drivers. `turn`, `trigger`,
 * `preTokens`, `postTokens` and `durationMs` are what the public projection
 * already passes; `at` and the summary fields are private by default — the
 * summary is model-authored text about the run, and it is deliberately not
 * named `text`, which the public `harness` allowlist carries.
 *
 * `summary` is the summary the CLI produced, or null when it could not be
 * read. The Codex CLI on a ChatGPT login compacts remotely: the summary comes
 * back as an encrypted item (`summaryEncrypted`, `encryptedChars`) that no
 * one outside the provider can read, so its record carries what stays
 * legible instead — `retainedTurns`, the harness turns whose context
 * messages the CLI kept verbatim beside it, and its context `window` number.
 */
export type CompactionRecord = {
  t: "harness";
  kind: "compaction";
  turn: number;
  trigger: string | null;
  preTokens: number | null;
  postTokens: number | null;
  durationMs: number | null;
  /** When the compaction started (epoch ms), as the CLI reported it or the driver first saw it. */
  at?: number | null;
  summary?: string | null;
  summaryTruncated?: true;
  summaryEncrypted?: true;
  encryptedChars?: number;
  retainedTurns?: number[];
  window?: number | null;
};

/**
 * A summary's cap on the record. Summaries run to about 11,000 characters
 * (a 2026-08 Sonnet freeplay compaction); the cap only bounds a pathological
 * one, deterministically, as the episodic cap does.
 */
export const COMPACTION_SUMMARY_MAX_CHARS = 100_000;

/** The summary fields of a record: absent text is null, a long one is cut and marked. */
export function summaryFields(summary: string | undefined | null): Pick<CompactionRecord, "summary" | "summaryTruncated"> {
  if (summary === undefined || summary === null || summary.length === 0) return { summary: null };
  if (summary.length <= COMPACTION_SUMMARY_MAX_CHARS) return { summary };
  const dropped = summary.length - COMPACTION_SUMMARY_MAX_CHARS;
  return { summary: `${summary.slice(0, COMPACTION_SUMMARY_MAX_CHARS)}…[truncated ${dropped} chars]`, summaryTruncated: true };
}

// ---------------------------------------------- claude-code's transcript

/** How much of the session transcript's tail a summary lookup reads. */
export const CLAUDE_TRANSCRIPT_TAIL_BYTES = 2 * 1024 * 1024;

/** A session id is a UUID; anything else is not interpolated into a glob. */
const SESSION_ID = /^[0-9a-zA-Z-]{8,80}$/;

/** The text of a transcript or stream `user` message: a string, or its text blocks joined. */
export function messageText(message: unknown): string | undefined {
  const content = (message as { content?: unknown } | null | undefined)?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content
    .filter((b): b is { type: string; text: string } => b !== null && typeof b === "object" && (b as { type?: unknown }).type === "text" && typeof (b as { text?: unknown }).text === "string")
    .map((b) => b.text);
  return parts.length > 0 ? parts.join("\n") : undefined;
}

/**
 * The summary in a chunk of transcript text: the `user` line the CLI flags
 * `isCompactSummary` whose `parentUuid` is the boundary's own `uuid` — the
 * shape a 2026-08 claude-code run's transcript holds, where the boundary and
 * its summary are adjacent lines. `partialHead` drops a first line cut by
 * the tail read.
 */
export function summaryInTranscript(text: string, boundaryUuid: string, partialHead: boolean): string | undefined {
  const lines = text.split("\n");
  if (partialHead) lines.shift();
  for (let k = lines.length - 1; k >= 0; k--) {
    const line = lines[k]!;
    if (!line.includes('"isCompactSummary":true') || !line.includes(boundaryUuid)) continue;
    try {
      const rec = JSON.parse(line) as { isCompactSummary?: unknown; parentUuid?: unknown; message?: unknown };
      if (rec.isCompactSummary === true && rec.parentUuid === boundaryUuid) return messageText(rec.message);
    } catch {
      // a half-written last line
    }
  }
  return undefined;
}

/**
 * The summary the Claude Code CLI wrote after a compact boundary, read from
 * its own session transcript under the run's `CLAUDE_CONFIG_DIR`
 * (`projects/<cwd slug>/<session id>.jsonl`). The stream-json output does
 * not reliably carry it; the transcript always does. A bounded tail read,
 * looked up soon after the boundary, so the line is near the end; undefined
 * when it is not there (yet). Never throws.
 */
export function claudeCompactSummary(
  configDir: string,
  sessionId: string,
  boundaryUuid: string,
  tailBytes = CLAUDE_TRANSCRIPT_TAIL_BYTES,
): string | undefined {
  if (!SESSION_ID.test(sessionId) || boundaryUuid.length === 0) return undefined;
  try {
    const glob = new Bun.Glob(`projects/*/${sessionId}.jsonl`);
    for (const rel of glob.scanSync({ cwd: configDir, onlyFiles: true })) {
      const fd = openSync(join(configDir, rel), "r");
      try {
        const size = fstatSync(fd).size;
        const len = Math.min(size, tailBytes);
        const buf = Buffer.alloc(len);
        let got = 0;
        while (got < len) {
          const n = readSync(fd, buf, got, len - got, size - len + got);
          if (n <= 0) break;
          got += n;
        }
        const found = summaryInTranscript(buf.subarray(0, got).toString("utf8"), boundaryUuid, size > len);
        if (found !== undefined) return found;
      } finally {
        closeSync(fd);
      }
    }
  } catch {
    // no projects directory yet, or an unreadable file: an absent summary
  }
  return undefined;
}
