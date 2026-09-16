/**
 * Trajectory lines in, ClickHouse rows out.
 *
 * The boundary is deliberately loose. A trajectory is written by whatever
 * build launched the run, over a year of record kinds being added, and this
 * store is derived — so a line this file does not recognise must still land,
 * whole, in `events.raw`. The Zod schema therefore validates exactly what
 * every consumer here depends on (`t` is a string, `ts` is a number) and
 * passes the rest through untouched. A line that fails even that is not
 * dropped either: it lands as kind `unparseable` with its bytes in `raw`,
 * which is the same thing `readTrajectory` does and for the same reason —
 * evidence does not get to vanish because a writer was interrupted mid-line.
 */

import { z } from "zod";

/**
 * The record kinds that belong to a driver turn, and therefore to `turns`.
 * Everything else is ambient and goes to `events`. The split is what makes the
 * big column (`messages`) live in one table that a query can avoid touching.
 */
export const TURN_KINDS: ReadonlySet<string> = new Set([
  "request",
  "response",
  "snippet",
  "snippet_result",
  "tool_call",
  "tool_result",
  "events_served",
]);

/** Loose on purpose; see the header. Unknown keys survive in `raw`. */
export const trajectoryLine = z
  .object({ t: z.string(), ts: z.number() })
  .loose();

export type ParsedLine =
  | { ok: true; rec: Record<string, unknown>; t: string; ts: number }
  | { ok: false };

export function parseLine(text: string): ParsedLine {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false };
  }
  const r = trajectoryLine.safeParse(raw);
  if (!r.success) return { ok: false };
  return { ok: true, rec: r.data as Record<string, unknown>, t: r.data.t, ts: r.data.ts };
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function int(v: unknown): number | null {
  const n = num(v);
  return n === null ? null : Math.trunc(n);
}
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function json(v: unknown): string {
  return v === undefined ? "" : JSON.stringify(v);
}

/**
 * Usage, across the shapes the drivers actually write.
 *
 * OpenAI-compatible providers send `prompt_tokens`/`completion_tokens`, the
 * Anthropic shape sends `input_tokens`/`output_tokens` plus the two cache
 * counters, and reasoning models put their thinking tokens in a nested
 * `completion_tokens_details`. All three are read here into one set of
 * columns, because the question a cross-run query asks — how many tokens did
 * this run spend — has one answer whichever provider served it. The whole
 * record is still in `raw`, so a shape this misses is recoverable.
 */
export interface UsageRow {
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  reasoning_tokens: number | null;
  total_tokens: number | null;
  cost_usd: number | null;
}

export function usageOf(rec: Record<string, unknown>): UsageRow {
  const u = obj(rec["usage"]);
  const empty: UsageRow = {
    input_tokens: null,
    output_tokens: null,
    cache_read_tokens: null,
    cache_write_tokens: null,
    reasoning_tokens: null,
    total_tokens: null,
    cost_usd: null,
  };
  if (u === null) return empty;
  const details = obj(u["completion_tokens_details"]);
  const prompt = obj(u["prompt_tokens_details"]);
  return {
    input_tokens: int(u["input_tokens"]) ?? int(u["prompt_tokens"]),
    output_tokens: int(u["output_tokens"]) ?? int(u["completion_tokens"]),
    cache_read_tokens:
      int(u["cache_read_input_tokens"]) ?? int(prompt?.["cached_tokens"]) ?? int(u["cached_tokens"]),
    cache_write_tokens: int(u["cache_creation_input_tokens"]),
    reasoning_tokens: int(details?.["reasoning_tokens"]) ?? int(u["reasoning_tokens"]),
    total_tokens: int(u["total_tokens"]),
    cost_usd: num(u["cost"]),
  };
}

export interface RowContext {
  runId: string;
  lineNo: number;
  ingestedAt: number;
}

export function turnRow(ctx: RowContext, rec: Record<string, unknown>, raw: string): Record<string, unknown> {
  const usage = usageOf(rec);
  const events = rec["events"];
  return {
    run_id: ctx.runId,
    line_no: ctx.lineNo,
    ts: int(rec["ts"]) ?? 0,
    kind: str(rec["t"]),
    turn: int(rec["turn"]),
    ...usage,
    tool_name: str(rec["name"]),
    is_error: rec["isError"] === undefined ? null : rec["isError"] === true ? 1 : 0,
    event_count: int(rec["count"]) ?? (Array.isArray(events) ? events.length : null),
    finish_reason: str(rec["finishReason"]),
    messages: json(rec["messages"]),
    events: json(events),
    raw,
    ingested_at: ctx.ingestedAt,
  };
}

export function eventRow(ctx: RowContext, rec: Record<string, unknown>, raw: string): Record<string, unknown> {
  /*
   * `resolved_model` is read from the two places a run's served model can be
   * named — the harness's own `resolved_model` record and the claude CLI's
   * `init` — so a cross-run "which Claude was this" is one column rather than
   * a JSON reach. First-wins is the reader's job, not this row's.
   */
  const resolved =
    rec["kind"] === "resolved_model" || rec["t"] === "claude_system"
      ? str(rec["model"]) || str(obj(rec["message"])?.["model"])
      : "";
  return {
    run_id: ctx.runId,
    line_no: ctx.lineNo,
    ts: int(rec["ts"]) ?? 0,
    kind: str(rec["t"]),
    turn: int(rec["turn"]),
    level: int(rec["level"]),
    zone: int(rec["zone"]),
    area: int(rec["area"]),
    resolved_model: resolved,
    sub_kind: str(rec["kind"]),
    reason: str(rec["reason"]),
    detail: str(rec["detail"]),
    raw,
    ingested_at: ctx.ingestedAt,
  };
}

/**
 * The typed projection of a `milestone` line. Zone and area transitions carry
 * `{from:{id},to:{id}}`, a level carries bare numbers, and an achievement or a
 * spell carries a flat `id` — three shapes on one row, with `raw` behind them
 * for the fields no column names.
 */
export function milestoneRow(ctx: RowContext, rec: Record<string, unknown>, raw: string): Record<string, unknown> {
  const from = obj(rec["from"]);
  const to = obj(rec["to"]);
  return {
    run_id: ctx.runId,
    line_no: ctx.lineNo,
    ts: int(rec["ts"]) ?? 0,
    kind: str(rec["kind"]),
    turn: int(rec["turn"]),
    from_id: from === null ? int(rec["from"]) : int(from["id"]) ?? int(from["areaId"]),
    to_id: to === null ? int(rec["to"]) : int(to["id"]) ?? int(to["areaId"]),
    id: int(rec["id"]),
    points: int(rec["points"]),
    observed_ts: int(rec["observedTs"]),
    raw,
    ingested_at: ctx.ingestedAt,
  };
}

export function episodicRow(ctx: RowContext, rec: Record<string, unknown>, raw: string): Record<string, unknown> {
  return {
    run_id: ctx.runId,
    line_no: ctx.lineNo,
    ts: int(rec["ts"]) ?? 0,
    kind: str(rec["t"]) || str(rec["kind"]),
    turn: int(rec["turn"]),
    raw,
    ingested_at: ctx.ingestedAt,
  };
}

/** A line that is not JSON, or not shaped like a record. Kept, not dropped. */
export function unparseableRow(ctx: RowContext, raw: string): Record<string, unknown> {
  return {
    run_id: ctx.runId,
    line_no: ctx.lineNo,
    ts: 0,
    kind: "unparseable",
    turn: null,
    level: null,
    zone: null,
    area: null,
    resolved_model: "",
    sub_kind: "",
    reason: "",
    detail: "",
    raw,
    ingested_at: ctx.ingestedAt,
  };
}
