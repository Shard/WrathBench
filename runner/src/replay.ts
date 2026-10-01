#!/usr/bin/env bun
/**
 * Rebuild every fixed-loop request of a run from its trajectory alone, and
 * check each against the hash the writer took of what it sent.
 *
 *   bun runner/src/replay.ts <run-id | run-dir> [--runs-dir data/runs] [--line N]
 *
 * Without `--line` it prints one summary and exits non-zero if any request
 * failed to rebuild or rebuilt to different bytes; each failure is named by
 * its line in `trajectory.jsonl`, its segment and its turn. With `--line N` it
 * prints the rebuilt message array of the request on that line as JSON.
 *
 * A mismatch is a harness bug, or a record edited after it was written; it is
 * never a pass. Records that carry their whole message array — every
 * fixed-loop request written before the slim shape, and every claude-code and
 * codex request — are counted, not verified: there is nothing to rebuild.
 *
 * The file is streamed, never read whole (a freeplay trajectory runs to
 * hundreds of MB), and only the part of each segment's history a later window
 * can still reach is held: the window start never moves backwards within a
 * segment. The rebuild itself is `request-record.ts`, the code the viewer's
 * raw view of a slim request goes through too.
 */

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ChatMessage } from "./context";
import {
  HistoryRebuilder,
  isSlimRequest,
  rebuildSlimRequest,
  slimRequestV1,
  systemTextMatches,
} from "./request-record";

export interface RequestVerdict {
  /** 1-based line of the request in `trajectory.jsonl`. */
  line: number;
  /** Which process segment of slim records it belongs to, from 1; 0 when none has opened. */
  segment: number;
  turn: number | null;
  ok: boolean;
  detail?: string;
}

export interface ReplayReport {
  /** Slim requests seen, and how many rebuilt to the bytes their hash names. */
  slim: number;
  verified: number;
  failures: RequestVerdict[];
  /** Requests that carry their whole message array: nothing to rebuild. */
  full: number;
  /** Slim segments opened (one per process that wrote slim records). */
  segments: number;
  /** Lines that would not parse; a torn last line of a live run is one. */
  unparseable: number;
}

/**
 * Feed a trajectory's records in file order; every slim request is rebuilt
 * from what came before it and checked as it arrives.
 */
export class Replayer {
  private readonly history = new HistoryRebuilder();
  /** System prompt texts recorded so far, by their hash. */
  private readonly systemTexts = new Map<string, string>();
  private segment = 0;
  readonly report: ReplayReport = { slim: 0, verified: 0, failures: [], full: 0, segments: 0, unparseable: 0 };

  /**
   * Take one record. For a slim request, returns its verdict and, when the
   * rebuild got that far, the rebuilt messages.
   */
  take(rec: Record<string, unknown>, line: number): { verdict: RequestVerdict; messages?: ChatMessage[] } | null {
    if (rec["t"] !== "request") {
      this.history.take(rec);
      return null;
    }
    if (!isSlimRequest(rec)) {
      this.report.full++;
      // A full record inside a slim segment (the writer's own fallback) keeps
      // the window it would have had, so the segment's history is kept for
      // the requests after it. One with no window is another shape's segment
      // and needs no history at all.
      const w = rec["window"] as { from?: unknown } | undefined;
      if (typeof w?.from === "number") this.history.dropBefore(w.from);
      else this.history.dropBefore(this.history.length);
      return null;
    }
    this.report.slim++;
    const turn = typeof rec["turn"] === "number" ? rec["turn"] : null;
    const fail = (detail: string, messages?: ChatMessage[]): { verdict: RequestVerdict; messages?: ChatMessage[] } => {
      const verdict: RequestVerdict = { line, segment: this.segment, turn, ok: false, detail };
      this.report.failures.push(verdict);
      return { verdict, ...(messages !== undefined ? { messages } : {}) };
    };
    const slim = slimRequestV1(rec);
    if (typeof slim === "string") return fail(slim);
    if (slim.window.to === 0) {
      this.history.reset();
      this.segment++;
      this.report.segments++;
    }
    // A text is kept only once it is known to be the one its hash names, so a
    // tampered text fails this request and every later one that points at it.
    if (slim.systemText !== undefined && systemTextMatches(slim.systemText, slim.systemHash)) {
      this.systemTexts.set(slim.systemHash, slim.systemText);
    }
    const window = this.history.window(slim.window.from, slim.window.to);
    this.history.dropBefore(slim.window.from);
    // The record's own text when it carries one, so a text that does not match
    // its hash is reported as exactly that.
    const rebuilt = rebuildSlimRequest(slim, slim.systemText ?? this.systemTexts.get(slim.systemHash), window);
    if (!rebuilt.ok) return fail(rebuilt.error, rebuilt.messages);
    this.report.verified++;
    return { verdict: { line, segment: this.segment, turn, ok: true }, messages: rebuilt.messages };
  }
}

/**
 * Every line of a JSONL file, streamed: never the whole file in memory. A
 * final line with no newline is yielded too (a live run's torn tail).
 */
export async function* jsonlLines(path: string): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of Bun.file(path).stream()) {
    pending += decoder.decode(chunk, { stream: true });
    let from = 0;
    for (let nl = pending.indexOf("\n", from); nl >= 0; nl = pending.indexOf("\n", from)) {
      yield pending.slice(from, nl);
      from = nl + 1;
    }
    pending = pending.slice(from);
  }
  pending += decoder.decode();
  if (pending.length > 0) yield pending;
}

/**
 * Replay a whole `trajectory.jsonl`. `onRequest` sees every slim request's
 * verdict and rebuilt messages as they come, in order.
 */
export async function replayFile(
  path: string,
  onRequest?: (verdict: RequestVerdict, messages: ChatMessage[] | undefined) => void,
): Promise<ReplayReport> {
  const replayer = new Replayer();
  let line = 0;
  for await (const text of jsonlLines(path)) {
    line++;
    if (text.trim().length === 0) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(text) as Record<string, unknown>;
    } catch {
      replayer.report.unparseable++;
      continue;
    }
    if (rec === null || typeof rec !== "object") {
      replayer.report.unparseable++;
      continue;
    }
    const out = replayer.take(rec, line);
    if (out !== null) onRequest?.(out.verdict, out.messages);
  }
  return replayer.report;
}

/** The summary the CLI prints. */
export function renderReport(report: ReplayReport, path: string): string {
  const lines = [
    `replay ${path}`,
    `slim requests:   ${report.slim} in ${report.segments} segment(s), ${report.verified} verified`,
    `full requests:   ${report.full} (carry their whole message array; nothing to rebuild)`,
  ];
  if (report.unparseable > 0) lines.push(`unparseable:     ${report.unparseable} line(s)`);
  if (report.failures.length === 0) {
    lines.push(report.slim > 0 ? "every slim request rebuilt to the bytes that were sent" : "no slim requests to verify");
  } else {
    lines.push(`FAILED:          ${report.failures.length} request(s) did not rebuild to the bytes that were sent — a harness bug, or an edited record`);
    for (const f of report.failures.slice(0, 20)) {
      lines.push(`  line ${f.line}, segment ${f.segment}, turn ${f.turn ?? "?"}: ${f.detail ?? ""}`);
    }
    if (report.failures.length > 20) lines.push(`  … ${report.failures.length - 20} more`);
  }
  return lines.join("\n");
}

if (import.meta.main) {
  const argv = Bun.argv.slice(2);
  const dirIdx = argv.indexOf("--runs-dir");
  const runsDir = dirIdx >= 0 ? argv[dirIdx + 1]! : (process.env["WRATHBENCH_RUNS_DIR"] ?? "data/runs");
  const lineIdx = argv.indexOf("--line");
  const wantLine = lineIdx >= 0 ? Number(argv[lineIdx + 1]) : null;
  const skip = new Set([dirIdx, lineIdx].filter((i) => i >= 0).flatMap((i) => [i, i + 1]));
  const target = argv.find((a, i) => !skip.has(i) && !a.startsWith("--"));
  if (target === undefined || (wantLine !== null && !Number.isInteger(wantLine))) {
    console.error("usage: bun runner/src/replay.ts <run-id | run-dir> [--runs-dir data/runs] [--line N]");
    process.exit(2);
  }
  const dir = existsSync(target) && statSync(target).isDirectory() ? target : join(runsDir, target);
  const path = join(dir, "trajectory.jsonl");
  if (!existsSync(path)) {
    console.error(`no trajectory at ${path}`);
    process.exit(2);
  }
  let printed = false;
  const report = await replayFile(path, (verdict, messages) => {
    if (wantLine === null || verdict.line !== wantLine) return;
    printed = true;
    console.log(JSON.stringify({ ...verdict, messages: messages ?? null }, null, 2));
  });
  if (wantLine !== null && !printed) console.error(`line ${wantLine} is not a slim request`);
  // The summary goes to stderr when stdout is the rebuilt request, so that
  // stays parseable JSON.
  (wantLine === null ? console.log : console.error)(renderReport(report, path));
  process.exit(report.failures.length > 0 || (wantLine !== null && !printed) ? 1 : 0);
}
