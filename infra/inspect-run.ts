#!/usr/bin/env bun
/**
 * `bun wb inspect live|run|trajectory|tools|pad`: read-only views of the runs,
 * every one bounded by default.
 *
 *   bun infra/inspect-run.ts live                      runs with a heartbeat, one line each
 *   bun infra/inspect-run.ts run <run-id> [--since D] [--until D]
 *                                                      the verdict, level, counts, sizes
 *   bun infra/inspect-run.ts trajectory <run-id> [--last N | --next N] [--errors] [--grep RE]
 *                                       [--all] [--since D] [--until D] [--width N]
 *   bun infra/inspect-run.ts tools <run-id> [--since D] [--until D]
 *                                                      calls per tool, reflect, the pad's writers
 *   bun infra/inspect-run.ts pad <run-id> [--since D] [--until D] [--last N] | --at D
 *                                                      the pad's size over time and its writes, or its text
 *
 * D is `90s`, `30m`, `2h`, `1d`, epoch ms or an ISO time. The runs directory is
 * `--runs-dir`, else WRATHBENCH_RUNS_DIR, else `data/runs`.
 *
 * Where each view reads. A run's heavy facts (its row, its state samples and
 * every trajectory record) come from ClickHouse, the derived store the
 * collector tails the runs into (collector/README.md), at CLICKHOUSE_URL with
 * the viewer's coordinates. A live run's run.sqlite is never walked: a whole-
 * table read of one once held the file against the runner's writer for long
 * enough to kill the run. What stays on the files is small and file-level: the
 * heartbeat, a few meta.json fields, file sizes, scratchpad.md, the nearby
 * ring, and the trace, which the collector does not hold by design. A live
 * run's trace is two index lookups, never a walk; a run with no live owner is
 * walked in rowid windows (`scanByRowid`).
 *
 * Every view prints a `source` line: how far ClickHouse is behind the file, or
 * that it read the files instead and why (no CLICKHOUSE_URL, ClickHouse
 * unreachable, the run not in it yet, or `--files`). Falling back is safe for
 * the trajectory, which a reader cannot lock; run.sqlite is opened in a
 * fallback only when the run has no fresh heartbeat, and otherwise the view
 * says what it did not read.
 *
 * A run is live when its row has neither a termination nor a pause (a paused
 * run is unterminated too, which is why the pause counts), and it has a live
 * owner only while its heartbeat is fresh: an unterminated run whose heartbeat
 * went cold lost its process. Nothing here ever prints a whole trajectory line,
 * `meta.json`'s config or the row's `config_json`, and every line it prints has
 * the run's session token struck, which older trajectories still carry.
 *
 * Import-free on purpose: `bun:sqlite` and `node:*` only, and `fetch` for
 * ClickHouse. So the same file runs unchanged wherever the runs are: in the
 * runner pod through `bun wb`, from stdin into a pod whose image predates it
 * (`kubectl exec -i … -- bun run - run <id> < infra/inspect-run.ts`), or
 * against a copy here. The constants and the connection rule it shares with
 * the runner, the collector and the viewer are pinned by its tests.
 */

import { Database } from "bun:sqlite";
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

/** runner/src/trajectory.ts: a heartbeat older than this has no owner. */
export const HEARTBEAT_DEAD_MS = 120_000;
/** runner/src/config.ts: below this a token is a pre-hardening run id, never struck. */
export const MIN_TOKEN_LENGTH = 32;
/** wrath-mcp/mcp/src/redact.ts. */
export const REDACTED = "[redacted]";
/** runner/viewer/archive-dir.ts. */
export const ARCHIVE_DIR = "archive";

const RUN_ID = /^[A-Za-z0-9._-]+$/;
export const DEFAULT_WIDTH = 200;
export const DEFAULT_LAST = 20;
const MAX_LAST = 1000;

// ------------------------------------------------------------------ formatting

export function fmtAge(ms: number): string {
  if (!Number.isFinite(ms)) return "?";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 90) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d${h % 24}h`;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** `YYYY-MM-DDTHH:MM:SSZ`, or `?` for a value that is not a time. */
export function iso(ts: unknown): string {
  return typeof ts === "number" && Number.isFinite(ts) ? `${new Date(ts).toISOString().slice(0, 19)}Z` : "?";
}

/** `MM-DD HH:MM:SS`, UTC: a trajectory line's clock. */
function clock(ts: number): string {
  return Number.isFinite(ts) ? new Date(ts).toISOString().slice(5, 19).replace("T", " ") : "??-?? ??:??:??";
}

function money(copper: unknown): string | null {
  if (typeof copper !== "number" || !Number.isFinite(copper)) return null;
  const g = Math.floor(copper / 10_000);
  const s = Math.floor((copper % 10_000) / 100);
  const c = copper % 100;
  return [g > 0 ? `${g}g` : "", g > 0 || s > 0 ? `${s}s` : "", `${c}c`].filter(Boolean).join(" ");
}

/**
 * One line of at most `width` characters: newlines shown as ⏎ with the
 * indentation after them dropped, tabs as spaces. Strike the token before
 * capping, never after: a cut through a token leaves a prefix the strike no
 * longer matches.
 */
export function cap(text: string, width: number): string {
  const flat = text.replace(/\r?\n[\t ]*/g, "⏎").replace(/\t/g, " ");
  return flat.length <= width ? flat : `${flat.slice(0, Math.max(0, width - 1))}…`;
}

function count(map: Map<string, number>, key: string, by = 1): void {
  map.set(key, (map.get(key) ?? 0) + by);
}

function topCounts(map: Map<string, number>, n: number): string {
  const sorted = [...map].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const shown = sorted.slice(0, n).map(([k, v]) => `${k} ${v}`);
  if (sorted.length > n) shown.push(`+${sorted.length - n} more`);
  return shown.join(", ");
}

/** A duration or a point in time, as epoch ms: `90s`, `30m`, `2h`, `1d` back from now, epoch ms, or ISO. */
export function parseSince(raw: string, now: number): number {
  const rel = /^(\d+(?:\.\d+)?)(s|m|h|d)$/.exec(raw);
  if (rel !== null) {
    const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[rel[2] as "s" | "m" | "h" | "d"];
    return now - Number(rel[1]) * unit;
  }
  if (/^\d{12,}$/.test(raw)) return Number(raw);
  const at = Date.parse(raw);
  if (Number.isNaN(at)) throw new Error(`--since ${raw}: not 90s/30m/2h/1d, epoch ms or an ISO time`);
  return at;
}

// ------------------------------------------------------------------ the run's files

export function isValidRunId(id: string): boolean {
  return RUN_ID.test(id) && id !== "." && id !== ".." && id !== ARCHIVE_DIR;
}

/** The run's directory, archived or not; null when there is none. */
export function findRunDir(runsDir: string, id: string): string | null {
  if (!isValidRunId(id)) return null;
  for (const dir of [join(runsDir, id), join(runsDir, ARCHIVE_DIR, id)]) {
    try {
      if (statSync(dir).isDirectory()) return dir;
    } catch {
      /* not here */
    }
  }
  return null;
}

/** meta.json, or null. Callers pick fields from it; it is never printed whole (it holds the token). */
function readMeta(dir: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as unknown;
    return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function obj(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** The token to strike from what is printed: `strikableSessionToken`'s rule (runner/src/session-token.ts). */
export function strikableToken(meta: Record<string, unknown> | null, runId: string): string | null {
  const token = obj(meta?.["config"])["token"];
  return typeof token === "string" && token.length >= MIN_TOKEN_LENGTH && token !== runId ? token : null;
}

export function strike(text: string, token: string | null): string {
  return token === null ? text : text.replaceAll(token, REDACTED);
}

function heartbeatAt(dir: string): number | null {
  try {
    return statSync(join(dir, "heartbeat")).mtimeMs;
  } catch {
    return null;
  }
}

/** A heartbeat fresh enough that the run's process may be writing its run.sqlite now. */
function ownedAt(heartbeat: number | null, now: number): boolean {
  return heartbeat !== null && now - heartbeat < HEARTBEAT_DEAD_MS;
}

export interface RunRow {
  termination_reason: string | null;
  termination_detail: string | null;
  pause_reason: string | null;
  started_at: number | null;
  ended_at: number | null;
  model: string | null;
  driver: string | null;
  character: string | null;
  harness_version: string | null;
}

export interface StateRow {
  ts: number;
  level: number | null;
  xp: number | null;
  money: number | null;
  quests_completed: number | null;
  turn: number | null;
  zone: number | null;
  next_level_xp?: number | null;
}

/**
 * How long a read waits out a live run's write before SQLITE_BUSY: the
 * runner's RUN_DB_BUSY_TIMEOUT_MS (runner/src/rundb.ts, which says why),
 * copied because this file imports nothing outside bun:sqlite and node:*.
 */
export const RUN_DB_BUSY_TIMEOUT_MS = 5000;

function openDb(dir: string): Database | null {
  const path = join(dir, "run.sqlite");
  if (!existsSync(path)) return null;
  let db: Database;
  try {
    db = new Database(path, { readonly: true });
  } catch {
    return null;
  }
  try {
    db.exec(`PRAGMA busy_timeout = ${RUN_DB_BUSY_TIMEOUT_MS}`);
  } catch {
    db.close();
    return null;
  }
  return db;
}

function hasTable(db: Database, name: string): boolean {
  return db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== null;
}

function columns(db: Database, table: string): Set<string> {
  return new Set((db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
}

/** The run row's verdict columns, read the way `readVerdict` reads them: an empty string is no value. */
function readRow(db: Database, runId: string): RunRow | null {
  const have = columns(db, "run");
  const pick = (c: string): string => (have.has(c) ? c : `NULL AS ${c}`);
  const cols = ["termination_reason", "termination_detail", "pause_reason", "started_at", "ended_at", "model", "driver", "character", "harness_version"];
  const row = db.query(`SELECT ${cols.map(pick).join(", ")} FROM run WHERE run_id = ?`).get(runId) as Record<string, unknown> | null;
  return row === null ? null : runRowOf(row);
}

/** A run row from either store: an empty string or a zero start is no value. */
export function runRowOf(row: Record<string, unknown>): RunRow {
  const s = (k: string): string | null => str(row[k]);
  const n = (k: string): number | null => (typeof row[k] === "number" && row[k] !== 0 ? (row[k] as number) : null);
  return {
    termination_reason: s("termination_reason"),
    termination_detail: s("termination_detail"),
    pause_reason: s("pause_reason"),
    started_at: n("started_at"),
    ended_at: n("ended_at"),
    model: s("model"),
    driver: s("driver"),
    character: s("character"),
    harness_version: s("harness_version"),
  };
}

export type VerdictState = "live" | "ownerless" | "paused" | "terminated" | "no-row" | "unread";

export interface Verdict {
  state: VerdictState;
  /** The termination or pause reason. */
  reason: string | null;
  detail: string | null;
  heartbeatAgeMs: number | null;
}

/**
 * The live rule: live when the row has neither a termination nor a pause, and
 * only while the heartbeat is fresh; an unterminated, unpaused run whose
 * heartbeat is cold or gone has lost its owner. `row` undefined is a row this
 * read did not get: ClickHouse was not there, and a live run's run.sqlite is
 * not opened. Pure.
 */
export function verdictOf(row: Pick<RunRow, "termination_reason" | "termination_detail" | "pause_reason"> | null | undefined, heartbeat: number | null, now: number): Verdict {
  const heartbeatAgeMs = heartbeat === null ? null : now - heartbeat;
  if (row === undefined) return { state: "unread", reason: null, detail: null, heartbeatAgeMs };
  if (row === null) return { state: "no-row", reason: null, detail: null, heartbeatAgeMs };
  if (row.termination_reason !== null) return { state: "terminated", reason: row.termination_reason, detail: row.termination_detail, heartbeatAgeMs };
  if (row.pause_reason !== null) return { state: "paused", reason: row.pause_reason, detail: null, heartbeatAgeMs };
  const owned = heartbeatAgeMs !== null && heartbeatAgeMs < HEARTBEAT_DEAD_MS;
  return { state: owned ? "live" : "ownerless", reason: null, detail: null, heartbeatAgeMs };
}

function heartbeatPhrase(v: Verdict): string {
  return v.heartbeatAgeMs === null ? "no heartbeat" : `heartbeat ${fmtAge(v.heartbeatAgeMs)} ago`;
}

export function describeVerdict(v: Verdict, meta: Record<string, unknown> | null, now: number): string {
  switch (v.state) {
    case "no-row":
      return `no run row in run.sqlite (a failed launch, or a directory holding only launch files); ${heartbeatPhrase(v)}`;
    case "unread":
      return `unread: ${heartbeatPhrase(v)}, so its process is up; the row is read from ClickHouse, which is not there, and a live run's run.sqlite is not opened`;
    case "terminated":
      return `terminated: ${v.reason}${v.detail !== null ? ` — ${v.detail}` : ""}`;
    case "paused": {
      const pause = obj(meta?.["pause"]);
      const at = typeof pause["at"] === "number" ? pause["at"] : null;
      const notBefore = typeof pause["notBefore"] === "number" ? pause["notBefore"] : null;
      const when = at === null ? "" : ` since ${iso(at)} (${fmtAge(now - at)} ago)`;
      const wait = notBefore !== null && notBefore > now ? `, not before ${iso(notBefore)}` : "";
      return `paused: ${v.reason}${when}${wait}; resumable, not running`;
    }
    case "live":
      return `live: no termination, no pause; ${heartbeatPhrase(v)}`;
    case "ownerless":
      return `ownerless: no termination and no pause, but ${heartbeatPhrase(v)} (over ${HEARTBEAT_DEAD_MS / 1000}s: its process is gone)`;
  }
}

// ------------------------------------------------------------------ the trajectory, as bytes

const HEAD = /^\{"ts":(-?\d+(?:\.\d+)?),"t":"([^"\\]{1,64})"/;
const CHUNK = 4 << 20;

/** A trajectory line's clock and kind, off its first bytes; parsed whole only when the head does not say. */
function headOf(buf: Buffer, start: number, end: number): { ts: number; t: string } {
  const head = buf.toString("latin1", start, Math.min(end, start + 120));
  const m = HEAD.exec(head);
  if (m !== null) return { ts: Number(m[1]), t: m[2]! };
  if (end - start > 1 << 20) return { ts: Number.NaN, t: "?" };
  try {
    const r = JSON.parse(buf.toString("utf8", start, end)) as { ts?: unknown; t?: unknown };
    return { ts: typeof r.ts === "number" ? r.ts : Number.NaN, t: typeof r.t === "string" ? r.t : "?" };
  } catch {
    return { ts: Number.NaN, t: "?" };
  }
}

/** `at` is the file offset of the line's first byte. */
type LineFn = (buf: Buffer, start: number, end: number, at: number) => boolean | void;

/** Every non-empty line from byte `from` (a line start), oldest first; the callback returns true to stop. */
function forwardLines(path: string, fn: LineFn, from = 0): void {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const chunk = Buffer.allocUnsafe(CHUNK);
    let carry: Buffer | null = null;
    let pos = from;
    while (pos < size) {
      const n = readSync(fd, chunk, 0, CHUNK, pos);
      if (n <= 0) break;
      const base = pos - (carry?.length ?? 0);
      pos += n;
      const buf: Buffer = carry === null ? chunk.subarray(0, n) : Buffer.concat([carry, chunk.subarray(0, n)]);
      carry = null;
      let s = 0;
      for (;;) {
        const e = buf.indexOf(10, s);
        if (e < 0) break;
        if (e > s && fn(buf, s, e, base + s) === true) return;
        s = e + 1;
      }
      if (s < buf.length) carry = Buffer.from(buf.subarray(s));
    }
    if (carry !== null && carry.length > 0) fn(carry, 0, carry.length, pos - carry.length);
  } finally {
    closeSync(fd);
  }
}

/** The offset of the first line that starts at or after byte `pos`; the file's size when none does. */
function lineStartFrom(fd: number, size: number, pos: number): number {
  if (pos <= 0) return 0;
  const buf = Buffer.allocUnsafe(64 << 10);
  // A line starts at `pos` when the byte before it ends one.
  for (let p = pos - 1; p < size; ) {
    const n = readSync(fd, buf, 0, buf.length, p);
    if (n <= 0) break;
    const i = buf.subarray(0, n).indexOf(10);
    if (i >= 0) return p + i + 1;
    p += n;
  }
  return size;
}

/** Below this the bisection stops and the caller's own scan, which filters every line anyway, takes over. */
const SEEK_SLACK = 256 << 10;

/**
 * A line start at or before the first line whose clock is at or past `t` (past
 * it, when `strict`), bisected on byte offsets: a few dozen small reads for any
 * file size, where a scan from the top reads the whole 700 MB. A record's `ts`
 * is its write time, so the file is in clock order in practice; the answer is a
 * lower bound and every caller still filters each line by its own clock.
 */
export function seekTime(path: string, t: number, strict = false): number {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const head = Buffer.allocUnsafe(120);
    const tsAt = (at: number): number => {
      const n = readSync(fd, head, 0, head.length, at);
      const m = HEAD.exec(head.toString("latin1", 0, n));
      return m === null ? Number.NaN : Number(m[1]);
    };
    let lo = 0;
    let hi = size;
    while (hi - lo > SEEK_SLACK) {
      const mid = lo + Math.floor((hi - lo) / 2);
      let at = lineStartFrom(fd, size, mid);
      let ts = Number.NaN;
      // A line whose head does not say its clock is stepped over, a few at most.
      for (let k = 0; k < 8 && at < hi; k++) {
        ts = tsAt(at);
        if (Number.isFinite(ts)) break;
        at = lineStartFrom(fd, size, at + 1);
      }
      if (at >= hi || !Number.isFinite(ts)) hi = mid;
      else if (strict ? ts <= t : ts < t) lo = at;
      else hi = at;
    }
    return lo;
  } finally {
    closeSync(fd);
  }
}

/** The offset of the first line whose clock is past `t`; the file's size when none is. */
export function offsetAfter(path: string, t: number): number {
  let found = -1;
  forwardLines(
    path,
    (buf, s, e, at) => {
      const h = headOf(buf, s, e);
      if (Number.isFinite(h.ts) && h.ts > t) {
        found = at;
        return true;
      }
    },
    seekTime(path, t, true),
  );
  return found < 0 ? statSync(path).size : found;
}

/** Every non-empty line before byte `to` (a line start), newest first, reading back; the callback returns true to stop. */
function backwardLines(path: string, fn: LineFn, to?: number): void {
  const fd = openSync(path, "r");
  try {
    let pos = to ?? fstatSync(fd).size;
    let tail: Buffer = Buffer.alloc(0);
    while (pos > 0) {
      const len = Math.min(CHUNK, pos);
      pos -= len;
      const chunk = Buffer.allocUnsafe(len);
      readSync(fd, chunk, 0, len, pos);
      const buf: Buffer = tail.length === 0 ? chunk : Buffer.concat([chunk, tail]);
      let e = buf.length;
      for (;;) {
        const nl = buf.lastIndexOf(10, e - 1);
        if (nl < 0) break;
        if (e > nl + 1 && fn(buf, nl + 1, e, pos + nl + 1) === true) return;
        e = nl;
      }
      tail = Buffer.from(buf.subarray(0, e));
    }
    if (tail.length > 0) fn(tail, 0, tail.length, 0);
  } finally {
    closeSync(fd);
  }
}

/** The clock of the file's newest record that says one, off the last few lines; null when none does. */
function newestInFile(path: string): number | null {
  let ts: number | null = null;
  let seen = 0;
  try {
    backwardLines(path, (buf, s, e) => {
      const h = headOf(buf, s, e);
      if (Number.isFinite(h.ts)) {
        ts = h.ts;
        return true;
      }
      return ++seen >= 50;
    });
  } catch {
    return null;
  }
  return ts;
}

function parseLine(buf: Buffer, start: number, end: number): Record<string, unknown> | null {
  return parseJson(buf.toString("utf8", start, end));
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text) as unknown;
    return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A result record's text, as a string whatever shape it was logged in. */
function textOf(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === undefined || v === null) return "";
  return JSON.stringify(v);
}

/**
 * A failed snippet's class: the error's name off the line after the harness's
 * `error (Nms)`, `timeout` for the snippet ceiling, else its first words.
 */
export function errorClass(text: string): string {
  const lines = text.split("\n", 3);
  const body = (/^error \(\d+ms\)$/.test(lines[0] ?? "") ? lines[1] : lines[0]) ?? "";
  if (body.startsWith("snippet evaluation exceeded")) return "timeout";
  const named = /^([A-Za-z_$][\w$]*(?:Error|Exception))\b/.exec(body) ?? /^([A-Za-z_$][\w$]{0,39}):/.exec(body);
  if (named !== null) return named[1]!;
  return body.split(/\s+/).slice(0, 3).join(" ").slice(0, 32) || "(empty)";
}

// ------------------------------------------------------------------ one record, from either store

/**
 * One trajectory record as a view reads it, from the file or from ClickHouse.
 * Every view is written once, against this: the file's records decode lazily
 * off the line's bytes, so a 2 MB request never becomes a string a view did
 * not ask for, and ClickHouse's carry only what the view's `ReadSpec` asked the
 * server for. A field the spec did not fetch reads as absent, which is what
 * each view does with a record too big to parse.
 */
export interface Rec {
  ts: number;
  t: string;
  bytes: number;
  /** The `name` a call or a result carries; null when it has none. */
  name(): string | null;
  isError(): boolean;
  /** A request's adapter label. */
  adapter(): string | null;
  /** The whole line, or null when the reader did not fetch it. */
  text(): string | null;
  parse(): Record<string, unknown> | null;
  /** The pad a request's context showed. */
  pad(): string | null;
  /** The over-cap refusal a result carries. */
  refusal(): { op: string; chars: number } | null;
}

/** A view's step over one record; true stops the read. */
export type RecFn = (r: Rec) => boolean | void;

const NAME_IN_HEAD = /"name":"([^"\\]{1,64})"/;
const ADAPTER_IN_HEAD = /"adapter":"([^"\\]{1,200})"/;

function headString(buf: Buffer, s: number, e: number): string {
  return buf.toString("latin1", s, Math.min(e, s + 400));
}

/** A file line as a record. Valid only inside the line callback: the buffer is the reader's. */
function fileRec(buf: Buffer, s: number, e: number): Rec {
  const h = headOf(buf, s, e);
  let head: string | null = null;
  let parsed: Record<string, unknown> | null | undefined;
  const headStr = (): string => (head ??= headString(buf, s, e));
  return {
    ts: h.ts,
    t: h.t,
    bytes: e - s,
    name: () => NAME_IN_HEAD.exec(headStr())?.[1] ?? null,
    isError: () => headStr().includes('"isError":true'),
    adapter: () => ADAPTER_IN_HEAD.exec(headStr())?.[1] ?? null,
    text: () => buf.toString("utf8", s, e),
    parse: () => (parsed === undefined ? (parsed = parseLine(buf, s, e)) : parsed),
    pad: () => padOfRequest(buf, s, e),
    refusal: () => padRefusalIn(buf, s, e),
  };
}

function fileForward(path: string, fn: RecFn, from = 0): void {
  forwardLines(path, (buf, s, e) => fn(fileRec(buf, s, e)), from);
}

function fileBackward(path: string, fn: RecFn, to?: number): void {
  backwardLines(path, (buf, s, e) => fn(fileRec(buf, s, e)), to);
}

// ------------------------------------------------------------------ ClickHouse

/**
 * The store's coordinates, or null when none are configured: the viewer's
 * `clickhouseConfigFromEnv` (runner/viewer/clickhouse.ts), copied because this
 * file imports nothing, and pinned to it by the test. The URL can carry a
 * password, so nothing here ever prints it.
 */
export interface ClickhouseConfig {
  url: string;
  user: string;
  password: string;
  database: string;
}

export function clickhouseConfigOf(env: Readonly<Record<string, string | undefined>>): ClickhouseConfig | null {
  const url = env["CLICKHOUSE_URL"];
  if (url === undefined || url.length === 0) return null;
  return {
    url: url.replace(/\/+$/, ""),
    user: env["CLICKHOUSE_USER"] ?? "default",
    password: env["CLICKHOUSE_PASSWORD"] ?? "",
    database: env["CLICKHOUSE_DATABASE"] ?? "wrathbench",
  };
}

/** collector/src/lines.ts `TURN_KINDS`: these kinds land in `turns`, every other kind in `events`. */
export const TURN_KINDS: readonly string[] = ["request", "response", "snippet", "snippet_result", "tool_call", "tool_result", "events_served"];
/** The kind the collector gives a line that is not a record (collector/src/lines.ts `unparseableRow`); the file's reader calls it `?`. */
export const UNPARSEABLE = "unparseable";
/** Above this a record's line is never fetched: every view reads such a record by its size alone. */
export const RAW_CAP_BYTES = 4 << 20;
/** Record kinds too big to be worth parsing for a line of their own, and never fetched whole from the store. */
export const SIZE_ONLY: ReadonlySet<string> = new Set(["request", "events_served", "claude_system", "driver", "codex_result", "actions"]);

/**
 * When a row (or its whole line) is wanted: always, never, or when any of the
 * given holds. `contains` is a literal the raw line holds, so it is the same
 * test whichever store answers it; `error` and `names` read `is_error` and
 * `tool_name`, which only `turns` carries.
 */
export type Rule = "all" | "none" | { contains?: string; error?: boolean; names?: readonly string[] };

/** What a view asks of the store: which kinds, which of their rows and lines, and what the server cuts out for it. */
export interface ReadSpec {
  kinds: Readonly<Record<string, { row?: Rule; raw: Rule }>> | "all";
  /** A request's first 400 characters, for its adapter. */
  heads?: boolean;
  /** A request's line from its last pad header on (`PAD_HEADER_JSON`), for its pad. */
  pads?: boolean;
  /** The text around a result's over-cap refusal. */
  refusals?: boolean;
}

/** One trajectory line as the store returns it: `r` empty when not fetched, `h`/`p`/`q` the server's cuts. */
export interface StoreRow {
  l: number;
  ts: number;
  k: string;
  b: number;
  n: string;
  e: number | null;
  r: string;
  h: string;
  p: string;
  q: string;
}

/** A run as `runs` holds it: its run.sqlite row merged with meta.json. */
export interface StoreRun extends RunRow {
  archived: boolean;
}

/** What the store holds of one run's trajectory, over a window and over the whole run. */
export interface Extent {
  /** Records per kind in the window, `?` for a line that is not a record. */
  kinds: Map<string, number>;
  /** The record with the newest clock in the window, ties to the later line. */
  last: { ts: number; t: string } | null;
  /** The window's first and last line, and the clocks of its first and last record that has one; null when it is empty. */
  window: { lo: number; hi: number; firstTs: number | null; lastTs: number | null } | null;
  /** The newest clock the store holds for the run, whatever the window; null when it holds none. */
  newestTs: number | null;
}

/**
 * The reads a view makes of the store. ClickHouse answers them in SQL
 * (`clickhouseStore`); the tests answer them from the collector's own rows in
 * memory, so a view reads the same records either way. Each is one bounded
 * query: a key lookup, an aggregate over the run's narrow columns, or a range
 * of line numbers.
 */
export interface InspectStore {
  runs(ids: readonly string[]): Promise<Map<string, StoreRun>>;
  /** Each run's newest state sample, by its sqlite rowid. */
  latestStates(ids: readonly string[]): Promise<Map<string, StateRow>>;
  /** Every sample that carries a quest count, in (ts, rowid) order. */
  quests(id: string): Promise<{ ts: number; quests: number | null }[]>;
  extent(id: string, w: Window): Promise<Extent>;
  /** The lines numbered [from, to) that the spec wants, in the window. */
  rows(id: string, spec: ReadSpec, w: Window, from: number, to: number): Promise<StoreRow[]>;
  /** Whole request lines, for the rare pad a server-side cut could not place. */
  raws(id: string, lines: readonly number[]): Promise<Map<number, string>>;
}

export class StoreError extends Error {}

function sqlStr(s: string): string {
  return `'${s.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

function sqlList(xs: Iterable<string>): string {
  return [...xs].map(sqlStr).join(", ");
}

function ruleSql(rule: Rule, turns: boolean): string {
  if (rule === "all") return "1";
  if (rule === "none") return "0";
  const any: string[] = [];
  if (rule.contains !== undefined) any.push(`position(raw, ${sqlStr(rule.contains)}) > 0`);
  if (rule.error === true && turns) any.push("is_error = 1");
  if (rule.names !== undefined && rule.names.length > 0 && turns) any.push(`tool_name IN (${sqlList(rule.names)})`);
  return any.length === 0 ? "0" : `(${any.join(" OR ")})`;
}

/** The window on an Int64 clock column: whole milliseconds either side. */
function windowSql(w: Window, col: string): string[] {
  const out: string[] = [];
  if (w.since !== null) out.push(`${col} >= ${Math.ceil(w.since)}`);
  if (w.until !== null) out.push(`${col} <= ${Math.floor(w.until)}`);
  return out;
}

/** The pad section's header as it sits in a raw line, its newlines JSON-escaped. */
export const PAD_HEADER_RAW = "\\n\\n[scratchpad";

/**
 * One page of a run's lines. Both tables share the file's line numbers, each
 * line in exactly one, so a range of numbers is a range of the file and the
 * primary key (run_id, line_no) prunes it. The server withholds every line a
 * view would not parse, and cuts out the pieces it would: a request's pad
 * section from its last header to the end of the line (`length − p − 13` is
 * the header's first byte, p its position in the reversed line, and the
 * header is ASCII so the cut never splits a character), and the text around a
 * result's refusal.
 */
export function rowsSql(runId: string, spec: ReadSpec, w: Window, from: number, to: number): string {
  const branches: string[] = [];
  for (const turns of [true, false]) {
    const kinds = spec.kinds === "all" ? null : Object.entries(spec.kinds).filter(([k]) => TURN_KINDS.includes(k) === turns);
    if (kinds !== null && kinds.length === 0) continue;
    const where = [`run_id = ${sqlStr(runId)}`, `line_no >= ${from}`, `line_no < ${to}`, ...windowSql(w, "ts")];
    if (kinds !== null) where.push(`(${kinds.map(([k, s]) => `(kind = ${sqlStr(k)} AND ${ruleSql(s.row ?? "all", turns)})`).join(" OR ")})`);
    const want = kinds === null ? "1" : `multiIf(${kinds.map(([k, s]) => `kind = ${sqlStr(k)}, ${ruleSql(s.raw, turns)}`).join(", ")}, 0)`;
    const raw = `if(kind IN (${sqlList(SIZE_ONLY)}) OR length(raw) > ${RAW_CAP_BYTES} OR NOT ${want}, '', raw)`;
    const head = spec.heads === true && turns ? "if(kind = 'request', substringUTF8(raw, 1, 400), '')" : "''";
    const at = `position(reverse(raw), reverse(${sqlStr(PAD_HEADER_RAW)}))`;
    const pad = spec.pads === true && turns ? `if(kind = 'request' AND ${at} > 0, substring(raw, length(raw) - ${at} - ${PAD_HEADER_RAW.length - 2}), '')` : "''";
    const refusal = `positionUTF8(raw, ${sqlStr(PAD_REFUSED)})`;
    const near =
      spec.refusals === true && turns
        ? `if(kind IN ('snippet_result', 'tool_result') AND ${refusal} > 0, substringUTF8(raw, toUInt64(greatest(1, toInt64(${refusal}) - 48)), ${48 + PAD_REFUSED.length + 24}), '')`
        : "''";
    branches.push(
      `SELECT line_no AS l, ts, kind AS k, length(raw) AS b, ${turns ? "tool_name" : "''"} AS n, ${turns ? "is_error" : "CAST(NULL AS Nullable(UInt8))"} AS e, ` +
        `${raw} AS r, ${head} AS h, ${pad} AS p, ${near} AS q FROM ${turns ? "turns" : "events"} WHERE ${where.join(" AND ")}`,
    );
  }
  return `SELECT * FROM (${branches.join(" UNION ALL ")}) ORDER BY l`;
}

/**
 * The run's lines by kind over a window, and its newest clock overall. Reads
 * only (line_no, ts, kind), deduplicated by line, since a replay's rows wait
 * for a merge to drop them. A line that is not a record (`unparseable`, clock
 * 0) counts in a window with no `--since`, as the file's reader counts it.
 */
export function extentSql(runId: string, w: Window): string {
  const id = sqlStr(runId);
  const win = windowSql(w, "any(ts)");
  const rec = `w AND k != ${sqlStr(UNPARSEABLE)}`;
  return `SELECT k, countIf(w) AS n, minIf(l, w) AS lo, maxIf(l, w) AS hi, countIf(${rec}) AS np,
       argMinIf(t, l, ${rec}) AS first_ts, minIf(l, ${rec}) AS first_l, argMaxIf(t, l, ${rec}) AS last_ts, maxIf(l, ${rec}) AS last_l,
       maxIf(t, ${rec}) AS newest_ts, argMaxIf(l, (t, l), ${rec}) AS newest_l,
       maxIf(t, k != ${sqlStr(UNPARSEABLE)}) AS all_ts, countIf(k != ${sqlStr(UNPARSEABLE)}) AS all_n
  FROM (SELECT line_no AS l, any(ts) AS t, any(kind) AS k, ${win.length === 0 ? "1" : `(${win.join(" AND ")})`} AS w
          FROM (SELECT line_no, ts, kind FROM turns WHERE run_id = ${id} UNION ALL SELECT line_no, ts, kind FROM events WHERE run_id = ${id})
         GROUP BY line_no)
 GROUP BY k`;
}

export interface ExtentRow {
  k: string;
  n: number;
  lo: number;
  hi: number;
  np: number;
  first_ts: number;
  first_l: number;
  last_ts: number;
  last_l: number;
  newest_ts: number;
  newest_l: number;
  all_ts: number;
  all_n: number;
}

/** The per-kind rows of `extentSql` as one `Extent`. Exported for the tests' store, which builds the same rows. */
export function extentOf(rows: readonly ExtentRow[]): Extent {
  const kinds = new Map<string, number>();
  let last: { ts: number; t: string; l: number } | null = null;
  let lo = Infinity;
  let hi = -Infinity;
  let first: { ts: number; l: number } | null = null;
  let end: { ts: number; l: number } | null = null;
  let newestTs: number | null = null;
  for (const r of rows) {
    const t = r.k === UNPARSEABLE ? "?" : r.k;
    if (r.all_n > 0) newestTs = Math.max(newestTs ?? -Infinity, r.all_ts);
    if (r.n === 0) continue;
    kinds.set(t, r.n);
    lo = Math.min(lo, r.lo);
    hi = Math.max(hi, r.hi);
    if (r.np === 0) continue;
    if (last === null || r.newest_ts > last.ts || (r.newest_ts === last.ts && r.newest_l > last.l)) last = { ts: r.newest_ts, t, l: r.newest_l };
    if (first === null || r.first_l < first.l) first = { ts: r.first_ts, l: r.first_l };
    if (end === null || r.last_l > end.l) end = { ts: r.last_ts, l: r.last_l };
  }
  const window = kinds.size === 0 ? null : { lo, hi, firstTs: first?.ts ?? null, lastTs: end?.ts ?? null };
  return { kinds, last: last === null ? null : { ts: last.ts, t: last.t }, window, newestTs };
}

const RUN_COLUMNS = "run_id, archived, termination_reason, termination_detail, pause_reason, started_at, ended_at, model, driver, character, harness_version";
const STATE_COLUMNS = "run_id, ts, level, xp, money, quests_completed, turn, zone, next_level_xp";

/** How long one query may take, server-side and here. A query that needs longer is a bug in the query. */
export const CLICKHOUSE_QUERY_SECONDS = 60;

/**
 * Every query's settings. `readonly=2` refuses a write whatever the user may
 * do, and still lets these settings be set. `log_comment` names the reader in
 * `system.query_log`, which is where a memory incident is traced first
 * (docs/RUNBOOK.md); the per-query memory and thread bounds are the server
 * profile's (infra/clickhouse/users.d/wrathbench-profile.xml).
 */
export const CLICKHOUSE_SETTINGS: Readonly<Record<string, string>> = {
  default_format: "JSON",
  // Without it ClickHouse quotes every Int64, and every clock here arrives as a string.
  output_format_json_quote_64bit_integers: "0",
  readonly: "2",
  max_execution_time: String(CLICKHOUSE_QUERY_SECONDS),
  log_comment: "wb inspect",
};

/** The name of what went wrong, never its message: a fetch error's message can carry the URL, and the URL a password. */
function errorName(e: unknown): string {
  if (e instanceof StoreError) return e.message;
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : e instanceof Error ? e.name : "error";
}

/** The store over ClickHouse's HTTP interface, the way the viewer reaches it. */
export function clickhouseStore(cfg: ClickhouseConfig, fetchImpl: (url: URL, init: RequestInit) => Promise<Response> = fetch): InspectStore {
  const headers: Record<string, string> = { "content-type": "text/plain; charset=utf-8", "x-clickhouse-user": cfg.user };
  if (cfg.password.length > 0) headers["x-clickhouse-key"] = cfg.password;
  async function rows<T>(sql: string): Promise<T[]> {
    const url = new URL(cfg.url);
    url.searchParams.set("database", cfg.database);
    for (const [k, v] of Object.entries(CLICKHOUSE_SETTINGS)) url.searchParams.set(k, v);
    let res: Response;
    try {
      res = await fetchImpl(url, { method: "POST", headers, body: sql, signal: AbortSignal.timeout((CLICKHOUSE_QUERY_SECONDS + 15) * 1000) });
    } catch (e) {
      throw new StoreError(errorName(e));
    }
    const text = await res.text();
    if (!res.ok) throw new StoreError(`HTTP ${res.status}: ${(text.split("\n", 1)[0] ?? "").slice(0, 160)}`);
    const body = JSON.parse(text) as { data?: unknown };
    return Array.isArray(body.data) ? (body.data as T[]) : [];
  }
  return {
    async runs(ids) {
      const out = new Map<string, StoreRun>();
      if (ids.length === 0) return out;
      for (const r of await rows<Record<string, unknown>>(`SELECT ${RUN_COLUMNS} FROM runs FINAL WHERE run_id IN (${sqlList(ids)})`)) {
        out.set(String(r["run_id"]), { ...runRowOf(r), archived: r["archived"] === 1 });
      }
      return out;
    },
    async latestStates(ids) {
      const out = new Map<string, StateRow>();
      if (ids.length === 0) return out;
      const sql = `SELECT ${STATE_COLUMNS} FROM states FINAL WHERE run_id IN (${sqlList(ids)}) ORDER BY run_id, seq DESC LIMIT 1 BY run_id`;
      for (const r of await rows<StateRow & { run_id: string }>(sql)) out.set(r.run_id, r);
      return out;
    },
    async quests(id) {
      return rows(`SELECT ts, quests_completed AS quests FROM states FINAL WHERE run_id = ${sqlStr(id)} AND quests_completed IS NOT NULL ORDER BY ts, seq`);
    },
    async extent(id, w) {
      return extentOf(await rows<ExtentRow>(extentSql(id, w)));
    },
    async rows(id, spec, w, from, to) {
      return rows<StoreRow>(rowsSql(id, spec, w, from, to));
    },
    async raws(id, lines) {
      const out = new Map<number, string>();
      if (lines.length === 0) return out;
      const sql = `SELECT line_no AS l, any(raw) AS r FROM turns WHERE run_id = ${sqlStr(id)} AND line_no IN (${lines.map((l) => Math.trunc(l)).join(", ")}) GROUP BY line_no`;
      for (const r of await rows<{ l: number; r: string }>(sql)) out.set(r.l, r.r);
      return out;
    },
  };
}

/** A store row as a record. `pad` is the request's pad, already placed. */
function storeRec(row: StoreRow, pad: string | null): Rec {
  const raw = row.r === "" ? null : row.r;
  const notRecord = row.k === UNPARSEABLE;
  let parsed: Record<string, unknown> | null | undefined;
  return {
    ts: notRecord ? Number.NaN : row.ts,
    t: notRecord ? "?" : row.k,
    bytes: row.b,
    name: () => (row.n === "" ? null : row.n),
    isError: () => row.e === 1,
    adapter: () => ADAPTER_IN_HEAD.exec(row.h)?.[1] ?? null,
    text: () => raw,
    parse: () => (parsed === undefined ? (parsed = raw === null ? null : parseJson(raw)) : parsed),
    pad: () => pad,
    refusal: () => (row.q !== "" ? padRefusalOf(row.q) : raw === null ? null : padRefusalOf(raw)),
  };
}

/**
 * One page as records, oldest first: deduplicated by line, and each request's
 * pad placed. A pad the cut from the last header cannot place (a pad that
 * quotes a header of its own) is read again off the whole line, as the file's
 * reader reads it.
 */
async function storeRecs(store: InspectStore, runId: string, spec: ReadSpec, rows: readonly StoreRow[]): Promise<Rec[]> {
  const byLine = new Map<number, StoreRow>();
  for (const r of rows) if (!byLine.has(r.l)) byLine.set(r.l, r);
  const sorted = [...byLine.values()].sort((x, y) => x.l - y.l);
  const pads = new Map<number, string | null>();
  if (spec.pads === true) {
    const again: number[] = [];
    for (const r of sorted) {
      if (r.k !== "request" || r.p === "") continue;
      const b = Buffer.from(r.p);
      const pad = padOfRequest(b, 0, b.length);
      if (pad === null) again.push(r.l);
      else pads.set(r.l, pad);
    }
    const whole = await store.raws(runId, again);
    for (const l of again) {
      const raw = whole.get(l);
      const b = raw === undefined ? null : Buffer.from(raw);
      pads.set(l, b === null ? null : padOfRequest(b, 0, b.length));
    }
  }
  return sorted.map((r) => storeRec(r, pads.get(r.l) ?? null));
}

/** Lines per page: the first page small, so `--last 20` reads little, then doubling, so a sparse `--grep` does not crawl. */
export const FIRST_PAGE_LINES = 1_000;
export const MAX_PAGE_LINES = 20_000;

/** The run's records in [bounds.lo, bounds.hi] that the spec wants, page by page in either direction; `fn` returns true to stop. */
async function storeRead(store: InspectStore, runId: string, spec: ReadSpec, w: Window, bounds: { lo: number; hi: number } | null, forward: boolean, fn: RecFn): Promise<void> {
  if (bounds === null) return;
  let lo = bounds.lo;
  let hi = bounds.hi + 1;
  for (let size = FIRST_PAGE_LINES; lo < hi; size = Math.min(MAX_PAGE_LINES, size * 2)) {
    const a = forward ? lo : Math.max(lo, hi - size);
    const b = forward ? Math.min(hi, lo + size) : hi;
    const recs = await storeRecs(store, runId, spec, await store.rows(runId, spec, w, a, b));
    if (!forward) recs.reverse();
    for (const r of recs) if (fn(r) === true) return;
    if (forward) lo = b;
    else hi = a;
  }
}

// ------------------------------------------------------------------ where a view reads

/** Past this, ClickHouse is not keeping up: the collector polls every few seconds. */
export const STORE_BEHIND_MS = 120_000;

/** How the store stands against the file: the `source` line of a view that reads it. */
export function freshness(newestTs: number | null, fileNewest: number | null): string {
  if (newestTs === null) return "ClickHouse, which holds no trajectory record of this run yet";
  const through = `through ${iso(newestTs)}`;
  if (fileNewest === null) return `ClickHouse ${through}`;
  const lag = Math.floor(fileNewest) - newestTs;
  if (lag < 1000) return `ClickHouse ${through}, current with the file`;
  const behind = `ClickHouse ${through}, ${fmtAge(lag)} behind the file`;
  return lag > STORE_BEHIND_MS ? `${behind}: the collector is behind or down, and the newest records are missing here (--files reads the file)` : behind;
}

/** How the views of one command reach the runs: the store, or the files and why. */
interface Ctx extends Options {
  store: InspectStore | null;
  /** Why the files are read when there is no store. */
  noStore: string;
}

/** Where one run's view reads: the store with what it holds, or the files and the `source` line saying why. */
type Via = { store: InspectStore; run: StoreRun | null; ext: Extent; line: string } | { store: null; line: string };

/**
 * Where a view of one run reads. `run` needs the run's row from the store; the
 * trajectory views need only its lines, which a directory with no run.sqlite
 * row still has.
 */
async function viaFor(ctx: Ctx, runId: string, dir: string, w: Window, needRow = false): Promise<Via> {
  if (ctx.store === null) return { store: null, line: `the files: ${ctx.noStore}` };
  const traj = join(dir, "trajectory.jsonl");
  try {
    const run = (await ctx.store.runs([runId])).get(runId) ?? null;
    if (run === null && needRow) return { store: null, line: "the files: the run is not in ClickHouse yet" };
    const ext = await ctx.store.extent(runId, w);
    let size = 0;
    try {
      size = statSync(traj).size;
    } catch {
      /* no trajectory */
    }
    if (ext.newestTs === null && size > 0) return { store: null, line: `the files: ${run === null ? "the run" : "its trajectory"} is not in ClickHouse yet` };
    return { store: ctx.store, run, ext, line: freshness(ext.newestTs, size > 0 ? newestInFile(traj) : null) };
  } catch (e) {
    return { store: null, line: `the files: ClickHouse unreachable (${errorName(e)})` };
  }
}

/** Why a fallback leaves run.sqlite shut: the one sentence every such line ends with. */
function notOpened(heartbeat: number | null, now: number): string {
  return `not read: heartbeat ${fmtAge(now - (heartbeat ?? now))} ago, so the run may be live, and a live run's run.sqlite is not opened (ClickHouse holds it)`;
}

// ------------------------------------------------------------------ inspect run

export interface Out {
  (line: string): void;
}

interface Options {
  runsDir: string;
  now: number;
  width: number;
}

/** A time window: `--since` and `--until`, each epoch ms or open. */
export interface Window {
  since: number | null;
  until: number | null;
}

/** `since … until …`, or "" for the whole run. */
function windowPhrase(w: Window): string {
  return [w.since !== null ? `since ${iso(w.since)}` : null, w.until !== null ? `until ${iso(w.until)}` : null].filter(Boolean).join(" ");
}

function fileLine(dir: string): string {
  const parts: string[] = [];
  for (const name of ["trajectory.jsonl", "run.sqlite", "scratchpad.md", "episodic.jsonl", "client-cache.json"]) {
    try {
      parts.push(`${name} ${fmtBytes(statSync(join(dir, name)).size)}`);
    } catch {
      /* absent */
    }
  }
  return parts.join(" · ") || "(none of the usual files)";
}

function nearbyLine(dir: string, now: number): string {
  const ring = join(dir, "nearby");
  let names: string[];
  try {
    names = readdirSync(ring);
  } catch {
    return "none (no nearby/ ring: not live, or a run from before it)";
  }
  if (names.length === 0) return "empty ring";
  let bytes = 0;
  let newest = 0;
  for (const n of names) {
    try {
      const s = statSync(join(ring, n));
      bytes += s.size;
      newest = Math.max(newest, s.mtimeMs);
    } catch {
      /* unlinked as it aged */
    }
  }
  return `${names.length} window file(s), ${fmtBytes(bytes)}, newest written ${fmtAge(now - newest)} ago`;
}

/**
 * Rows per statement when a read has to walk a whole table of a run with no
 * live owner. On the rollback journal a statement's SHARED lock lasts as long
 * as the statement, and the runner's commit waits for every one of them: a
 * single full scan of a live run's trace (hundreds of thousands of rows, most
 * of a 300 MB file, from a cold disk) held the file for longer than the writer
 * would wait, and the run died of `database is locked`. Walked in rowid
 * windows instead, each its own statement, a writer gets in between them.
 */
export const SCAN_WINDOW_ROWS = 20_000;

/** Every row of `table` through `windowed(lo, hi)`, one statement per rowid window (`SCAN_WINDOW_ROWS`), in rowid order. */
export function scanByRowid<T>(db: Database, table: string, windowed: (lo: number, hi: number) => T[], window = SCAN_WINDOW_ROWS): T[] {
  const max = (db.query(`SELECT max(rowid) AS m FROM ${table}`).get() as { m: number | null }).m;
  const out: T[] = [];
  if (max === null) return out;
  for (let lo = 0; lo < max; lo += window) out.push(...windowed(lo, Math.min(lo + window, max)));
  return out;
}

/**
 * The trace's line. The collector does not hold the trace (collector/README.md,
 * "Not tailed, on purpose"), so it is read here, and only ever by rowid: the
 * newest row and the highest rowid are each one index lookup, which is all a
 * live run gets. A run with no live owner also gets its rows by kind, walked
 * in windows.
 */
function traceLine(db: Database, now: number, live: boolean): string {
  if (!hasTable(db, "trace")) return "no trace table (a run from before the recorder)";
  const max = (db.query("SELECT max(rowid) AS m FROM trace").get() as { m: number | null }).m;
  if (max === null) return "no rows";
  const newest = (db.query("SELECT ts FROM trace ORDER BY rowid DESC LIMIT 1").get() as { ts: number | null } | null)?.ts ?? null;
  const at = newest === null ? "?" : `${iso(newest)} (${fmtAge(now - newest)} ago)`;
  const dictMax = hasTable(db, "trace_dict") ? (db.query("SELECT max(rowid) AS m FROM trace_dict").get() as { m: number | null }).m : null;
  if (live) return `about ${max} rows (by rowid; by kind only once the run has no live owner), newest ${at}; dict about ${dictMax ?? 0}`;
  const byWindow = db.query("SELECT kind, count(*) AS n FROM trace WHERE rowid > ? AND rowid <= ? GROUP BY kind");
  const counts = new Map<string, number>();
  for (const k of scanByRowid(db, "trace", (lo, hi) => byWindow.all(lo, hi) as { kind: string; n: number }[])) count(counts, k.kind, k.n);
  if (counts.size === 0) return "no rows";
  const total = [...counts.values()].reduce((a, n) => a + n, 0);
  const dict = hasTable(db, "trace_dict") ? (db.query("SELECT count(*) AS n FROM trace_dict").get() as { n: number }).n : 0;
  const byKind = [...counts].sort((a, b) => b[1] - a[1]).map(([kind, n]) => `${kind} ${n}`).join(", ");
  return `${total} rows (${byKind}), newest ${at}; dict ${dict}`;
}

function lastState(db: Database): StateRow | null {
  if (!hasTable(db, "state")) return null;
  const have = columns(db, "state");
  const pick = (c: string): string => (have.has(c) ? c : `NULL AS ${c}`);
  const cols = ["ts", "level", "xp", "money", "quests_completed", "turn", "zone", "next_level_xp"];
  // The newest row by rowid, which the state table is appended in, not by ts:
  // the table has no index on ts, and the sort was a full scan of a live run.
  return db.query(`SELECT ${cols.map(pick).join(", ")} FROM state ORDER BY rowid DESC LIMIT 1`).get() as StateRow | null;
}

/** One process's stretch of the quest count: when its first sample was taken, and its last count. */
export interface QuestStretch {
  from: number;
  last: number;
}

/**
 * The run's quest count across restarts, and the stretches it is summed from.
 *
 * The recorded count is the running process's own, so it reads zero again
 * after a resume or a sandbox restart; a drop marks one, and the run's count
 * is every stretch's last count added up. The viewer's `questsAcrossRestarts`
 * (`runner/viewer/results.ts`) is the same fold, copied because this file
 * imports nothing, and the test pins the two to the same answer. Null when no
 * sample carried a count.
 */
export function questStretches(samples: readonly { ts: number; quests: number | null }[]): { total: number; stretches: QuestStretch[] } | null {
  const stretches: QuestStretch[] = [];
  for (const s of samples) {
    if (s.quests === null) continue;
    const cur = stretches[stretches.length - 1];
    if (cur === undefined || s.quests < cur.last) stretches.push({ from: s.ts, last: s.quests });
    else cur.last = s.quests;
  }
  return stretches.length === 0 ? null : { total: stretches.reduce((n, s) => n + s.last, 0), stretches };
}

/** The quest samples of a run with no live owner, walked in rowid windows (`scanByRowid`). */
function questSamplesOf(db: Database, runId: string): { ts: number; quests: number | null }[] | null {
  if (!hasTable(db, "state") || !columns(db, "state").has("quests_completed")) return null;
  const byWindow = db.query(
    "SELECT ts, quests_completed AS quests FROM state WHERE rowid > ? AND rowid <= ? AND run_id = ? AND quests_completed IS NOT NULL ORDER BY ts",
  );
  return scanByRowid(db, "state", (lo, hi) => byWindow.all(lo, hi, runId) as { ts: number; quests: number | null }[]);
}

function questLine(samples: readonly { ts: number; quests: number | null }[] | null): string | null {
  const q = samples === null ? null : questStretches(samples);
  if (q === null) return null;
  const restarts = q.stretches.length - 1;
  const newest = q.stretches[q.stretches.length - 1]!.last;
  const head = `${q.total} over the run${restarts > 0 ? `, summed across ${restarts} restart(s); the newest sample reads ${newest}` : ""}`;
  return restarts > 0 ? `${head} · ${q.stretches.map((s) => `from ${clock(s.from).slice(0, 11)} ${s.last}`).join(" · ")}` : head;
}

function levelLine(st: StateRow | null, now: number): string {
  if (st === null) return "no state sample yet";
  return [
    `L${st.level ?? "?"} ${st.xp ?? "?"}xp${st.next_level_xp != null ? ` of ${st.next_level_xp}` : ""}`,
    money(st.money) !== null ? `money ${money(st.money)}` : null,
    st.zone != null ? `zone ${st.zone}` : null,
    st.turn != null ? `turn ${st.turn}` : null,
    `sampled ${fmtAge(now - st.ts)} ago`,
  ]
    .filter((b): b is string => b !== null)
    .join(" · ");
}

interface Activity {
  records: number;
  kinds: Map<string, number>;
  last: { ts: number; t: string } | null;
  snippetErrors: Map<string, number>;
  toolErrors: Map<string, number>;
  harness: Map<string, number>;
}

function newActivity(): Activity {
  return { records: 0, kinds: new Map(), last: null, snippetErrors: new Map(), toolErrors: new Map(), harness: new Map() };
}

/** What one record adds to the errors by class and the harness notices by kind. */
function noteActivity(a: Activity, r: Rec, token: string | null): void {
  if (r.t === "snippet_result" || r.t === "tool_result") {
    if (!r.isError()) return;
    // A result is small next to a request; past 256 KB, read its head only.
    const p = r.bytes < 256 << 10 ? r.parse() : null;
    if (r.t === "snippet_result") count(a.snippetErrors, errorClass(p === null ? "" : strike(textOf(p["text"]), token)));
    else count(a.toolErrors, typeof p?.["name"] === "string" ? (p["name"] as string) : "?");
  } else if (r.t === "harness") {
    const p = r.bytes < 64 << 10 ? r.parse() : null;
    count(a.harness, typeof p?.["kind"] === "string" ? (p["kind"] as string) : "?");
  }
}

/** One forward pass over the trajectory: counts by kind, errors by class, harness notices by kind. */
function scanActivity(path: string, window: Window, token: string | null): Activity {
  const { since, until } = window;
  const a = newActivity();
  fileForward(
    path,
    (r) => {
      if (until !== null && r.ts > until) return true;
      if (since !== null && !(r.ts >= since)) return;
      a.records++;
      count(a.kinds, r.t);
      if (Number.isFinite(r.ts) && (a.last === null || r.ts >= a.last.ts)) a.last = { ts: r.ts, t: r.t };
      noteActivity(a, r, token);
    },
    since === null ? 0 : seekTime(path, since),
  );
  return a;
}

/** The errors and harness notices only: the counts come from the extent. */
const ACTIVITY_SPEC: ReadSpec = {
  kinds: { snippet_result: { row: { error: true }, raw: "all" }, tool_result: { row: { error: true }, raw: "all" }, harness: { raw: "all" } },
};

async function storeActivity(store: InspectStore, runId: string, ext: Extent, w: Window, token: string | null): Promise<Activity> {
  const a = newActivity();
  for (const [k, n] of ext.kinds) {
    a.kinds.set(k, n);
    a.records += n;
  }
  a.last = ext.last;
  await storeRead(store, runId, ACTIVITY_SPEC, w, ext.window, true, (r) => noteActivity(a, r, token));
  return a;
}

export async function inspectRun(runId: string, opts: Ctx & Window, out: Out): Promise<number> {
  const dir = findRunDir(opts.runsDir, runId);
  if (dir === null) {
    out(`no run ${runId} under ${opts.runsDir} (nor its ${ARCHIVE_DIR}/)`);
    return 1;
  }
  const meta = readMeta(dir);
  const token = strikableToken(meta, runId);
  const say = (label: string, text: string): void => out(`${label.padEnd(10)} ${cap(strike(text, token), opts.width - 11)}`);
  const heartbeat = heartbeatAt(dir);
  const owned = ownedAt(heartbeat, opts.now);
  const via = await viaFor(opts, runId, dir, opts, true);
  // Opened only on a fallback for a run with no live owner, and for the trace, which only the file holds.
  const db = openDb(dir);
  try {
    const row: RunRow | null | undefined = via.store !== null ? via.run : owned ? undefined : db === null ? null : readRow(db, runId);
    const verdict = verdictOf(row, heartbeat, opts.now);
    say("run", `${runId}${dir.includes(`/${ARCHIVE_DIR}/`) ? " (archived)" : ""}`);
    say("verdict", describeVerdict(verdict, meta, opts.now));
    say("source", via.line);

    const config = obj(meta?.["config"]);
    const comparability = obj(meta?.["comparability"]);
    const model = row?.model ?? str(config["model"]) ?? "?";
    const bits = [
      model,
      `driver ${row?.driver ?? str(config["driver"]) ?? "?"}`,
      str(config["effort"]) !== null ? `effort ${config["effort"] as string}` : null,
      str(comparability["episode"]) !== null ? `episode ${comparability["episode"] as string}` : null,
      `harness ${row?.harness_version ?? str(meta?.["harnessVersion"]) ?? "?"}`,
    ].filter((b): b is string => b !== null);
    say("model", bits.join(" · "));
    const character = row?.character ?? str(config["character"]);
    const account = str(config["account"]);
    if (character !== null || account !== null) say("character", `${character ?? "?"}${account !== null ? ` on ${account}` : ""}`);
    const started = row?.started_at ?? (typeof meta?.["startedAt"] === "number" ? (meta["startedAt"] as number) : null);
    say(
      "started",
      `${iso(started)}${started !== null ? ` (${fmtAge(opts.now - started)} ago)` : ""}${row?.ended_at != null ? ` · ended ${iso(row.ended_at)} (${fmtAge(opts.now - row.ended_at)} ago)` : ""}`,
    );

    if (via.store !== null) {
      say("level", levelLine((await via.store.latestStates([runId])).get(runId) ?? null, opts.now));
      // The newest sample's count is its process's, so the run's is its own line.
      const quests = questLine(await via.store.quests(runId));
      if (quests !== null) say("quests", quests);
    } else if (owned) {
      say("level", notOpened(heartbeat, opts.now));
    } else {
      say("level", levelLine(db === null ? null : lastState(db), opts.now));
      const quests = questLine(db === null ? null : questSamplesOf(db, runId));
      if (quests !== null) say("quests", quests);
    }

    const traj = join(dir, "trajectory.jsonl");
    if (!existsSync(traj)) say("activity", "no trajectory.jsonl");
    else {
      const a = via.store !== null ? await storeActivity(via.store, runId, via.ext, opts, token) : scanActivity(traj, opts, token);
      const k = (t: string): number => a.kinds.get(t) ?? 0;
      const window = windowPhrase(opts) === "" ? "" : `${windowPhrase(opts)}: `;
      const last = a.last === null ? "none" : `${a.last.t} ${fmtAge(opts.now - a.last.ts)} ago`;
      say("activity", `${window}${a.records} records, last ${last} · ${k("response")} responses · ${k("snippet")} snippets · ${k("tool_call")} tool calls`);
      const se = [...a.snippetErrors.values()].reduce((x, y) => x + y, 0);
      const te = [...a.toolErrors.values()].reduce((x, y) => x + y, 0);
      say(
        "errors",
        `snippets ${se}/${k("snippet_result")}${se > 0 ? `: ${topCounts(a.snippetErrors, 6)}` : ""} · tools ${te}/${k("tool_result")}${te > 0 ? `: ${topCounts(a.toolErrors, 4)}` : ""}`,
      );
      if (a.harness.size > 0) say("harness", topCounts(a.harness, 8));
      const marks = ["pause", "resume", "termination", "quest_complete", "milestone"].filter((t) => k(t) > 0).map((t) => `${t} ${k(t)}`);
      if (marks.length > 0) say("marks", marks.join(", "));
    }
    say("files", fileLine(dir));
    say("trace", db === null ? "no run.sqlite" : traceLine(db, opts.now, owned));
    say("nearby", nearbyLine(dir, opts.now));
    return 0;
  } finally {
    db?.close();
  }
}

// ------------------------------------------------------------------ inspect live

/**
 * Every run with a heartbeat file: a stat per run directory and nothing more,
 * then the rows and newest samples of only those few, from ClickHouse. A run
 * that paused or ended cleanly removed its heartbeat, so it is not here; one
 * killed hard left a cold one, and shows. Without ClickHouse a cold one's row
 * is read from its run.sqlite and a fresh one's is not read at all.
 */
export async function inspectLive(opts: Ctx, out: Out): Promise<number> {
  let names: string[];
  try {
    names = readdirSync(opts.runsDir);
  } catch {
    out(`no runs directory at ${opts.runsDir}`);
    return 1;
  }
  const found: { id: string; dir: string; hb: number }[] = [];
  for (const id of names) {
    if (id === ARCHIVE_DIR || !isValidRunId(id)) continue;
    const dir = join(opts.runsDir, id);
    const hb = heartbeatAt(dir);
    if (hb !== null) found.push({ id, dir, hb });
  }
  found.sort((a, b) => a.id.localeCompare(b.id));
  const owned = found.filter((f) => ownedAt(f.hb, opts.now)).length;
  out(`${owned} run(s) with a live owner, ${found.length - owned} with a cold heartbeat, of ${names.length} entries under ${opts.runsDir}`);
  let rows: Map<string, StoreRun> | null = null;
  let states = new Map<string, StateRow>();
  let source = `the files: ${opts.noStore}`;
  if (opts.store !== null && found.length > 0) {
    try {
      const ids = found.map((f) => f.id);
      rows = await opts.store.runs(ids);
      states = await opts.store.latestStates(ids);
      source = "ClickHouse for the rows and the newest samples; the heartbeats from the files";
    } catch (e) {
      source = `the files: ClickHouse unreachable (${errorName(e)})`;
    }
  } else if (opts.store !== null) source = "the heartbeats from the files; none to look up in ClickHouse";
  for (const f of found) {
    let row: RunRow | null | undefined;
    let st: StateRow | null = null;
    if (rows !== null && rows.has(f.id)) {
      row = rows.get(f.id)!;
      st = states.get(f.id) ?? null;
    } else if (ownedAt(f.hb, opts.now)) {
      row = undefined;
    } else {
      const db = openDb(f.dir);
      try {
        row = db === null ? null : readRow(db, f.id);
        st = db === null ? null : lastState(db);
      } finally {
        db?.close();
      }
    }
    const v = verdictOf(row, f.hb, opts.now);
    const level = st === null ? "L?" : `L${st.level ?? "?"} ${st.xp ?? "?"}xp`;
    const age = row?.started_at != null ? `up ${fmtAge(opts.now - row.started_at)}` : "";
    const reason = v.reason !== null ? ` ${v.reason}` : "";
    const missing = rows !== null && !rows.has(f.id) ? "  (not in ClickHouse yet)" : "";
    out(cap(`  ${f.id}  ${v.state}${reason}  hb ${fmtAge(opts.now - f.hb)}  ${level}  ${age}  ${row?.model ?? ""}${missing}`, opts.width));
  }
  out(cap(`source    ${source}`, opts.width));
  return 0;
}

// ------------------------------------------------------------------ inspect trajectory

export interface TrajectoryOptions extends Ctx, Window {
  /** How many items: the newest N (`--last`), or with `forward` the oldest N from the window's start (`--next`). */
  last: number;
  forward: boolean;
  errors: boolean;
  grep: RegExp | null;
  all: boolean;
}

/** One printed line: one snippet with its result, one tool call with its result, or one notice. */
interface Item {
  ts: number;
  text: string;
  error: boolean;
}

/** Kinds the default view shows as their own line. */
const NOTICES = new Set(["harness", "pause", "resume", "termination", "continue", "quest_complete", "codex_stderr"]);

function around(text: string, re: RegExp | null, width: number): string {
  if (re === null) return text;
  const m = re.exec(text);
  if (m === null || m.index < width / 2) return text;
  return `…${text.slice(Math.max(0, m.index - Math.floor(width / 4)))}`;
}

/** A result's first line (`ok (91ms)` or `error (1257ms)`) and the rest. */
function splitResult(text: string): { head: string; rest: string } {
  const nl = text.indexOf("\n");
  return nl < 0 ? { head: text, rest: "" } : { head: text.slice(0, nl), rest: text.slice(nl + 1) };
}

/** A record as one capped line of JSON, each value struck and then cut short, its bulky fields elided. */
function compact(r: Record<string, unknown>, width: number, token: string | null): string {
  const shown: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) {
    if (k === "ts" || k === "t") continue;
    if (k === "config" || k === "comparability" || k === "messages") {
      shown[k] = "…";
      continue;
    }
    const raw = typeof v === "string" ? v : JSON.stringify(v);
    const s = raw === undefined ? undefined : strike(raw, token);
    shown[k] = s === undefined ? v : s.length > 80 ? `${s.slice(0, 79)}…` : typeof v === "string" ? s : s === raw ? v : s;
  }
  return cap(JSON.stringify(shown), width);
}

/** One half of a call and its result. */
interface Half {
  side: "call" | "result";
  r: Record<string, unknown>;
}

/**
 * A call and its result, met in reading order: the half read first waits under
 * its key, and the half read second takes it, or stands alone when nothing
 * waits (reading back, a call whose result is not written yet; reading forward,
 * a result whose call lies before the window).
 */
function meet(
  pending: Map<string, Half>,
  firstSide: Half["side"],
  key: string,
  side: Half["side"],
  r: Record<string, unknown>,
): { call: Record<string, unknown> | null; res: Record<string, unknown> | null } | null {
  if (side === firstSide) {
    pending.set(key, { side, r });
    return null;
  }
  const other = pending.get(key)?.r ?? null;
  pending.delete(key);
  return side === "call" ? { call: r, res: other } : { call: other, res: r };
}

/** The default view's kinds, each line fetched: the calls are read with the results so the two meet. */
const TRAJECTORY_SPEC: ReadSpec = {
  kinds: Object.fromEntries(["snippet", "snippet_result", "tool_call", "tool_result", ...NOTICES].map((k) => [k, { raw: "all" as Rule }])),
};
const TRAJECTORY_ALL_SPEC: ReadSpec = { kinds: "all" };

/** The run's trajectory, or a line saying why there is none. */
function trajectoryOf(runId: string, opts: Options, out: Out): { dir: string; path: string; token: string | null } | null {
  const dir = findRunDir(opts.runsDir, runId);
  if (dir === null) {
    out(`no run ${runId} under ${opts.runsDir} (nor its ${ARCHIVE_DIR}/)`);
    return null;
  }
  const path = join(dir, "trajectory.jsonl");
  if (!existsSync(path)) {
    out(`${runId} has no trajectory.jsonl`);
    return null;
  }
  return { dir, path, token: strikableToken(readMeta(dir), runId) };
}

export async function inspectTrajectory(runId: string, opts: TrajectoryOptions, out: Out): Promise<number> {
  const run = trajectoryOf(runId, opts, out);
  if (run === null) return 1;
  const { path, token } = run;
  const via = await viaFor(opts, runId, run.dir, opts);
  const w = opts.width;
  const items: Item[] = [];
  // Newest first for --last, a result met before its call; oldest first for --next, the call first.
  const pendingSnippet = new Map<string, Half>();
  const pendingTool = new Map<string, Half>();
  const grepOk = (...texts: string[]): boolean => opts.grep === null || texts.some((t) => opts.grep!.test(t));
  const keep = (it: Item): boolean => {
    if (opts.errors && !it.error) return false;
    items.push(it);
    return items.length >= opts.last;
  };
  const callKey = (r: Record<string, unknown>): string => `${String(r["turn"])}:${String(r["call"])}`;
  const firstSide: Half["side"] = opts.forward ? "call" : "result";

  const snippetItem = (code: Record<string, unknown> | null, res: Record<string, unknown> | null): Item | null => {
    const ts = (typeof code?.["ts"] === "number" ? code["ts"] : res?.["ts"]) as number;
    const codeText = textOf(code?.["code"]);
    const resText = strike(textOf(res?.["text"]), token);
    const error = res?.["isError"] === true;
    if (!grepOk(codeText, resText)) return null;
    const { head, rest } = splitResult(resText);
    const turn = String((code ?? res)?.["turn"] ?? "?");
    const call = String((code ?? res)?.["call"] ?? "?");
    const verdict = res === null ? "…" : error ? `✗ ${head.replace(/^error /, "")}` : `✓ ${head.replace(/^ok /, "")}`;
    const half = Math.max(24, Math.floor((w - 40) / 2));
    const left = cap(around(strike(codeText, token), opts.grep, half), half);
    const right = cap(around(rest, opts.grep, half), half);
    return { ts, error, text: `${clock(ts)}  t${turn} #${call}  snippet ${verdict}  ${left}${right !== "" ? `  ⇒ ${right}` : ""}` };
  };

  const toolItem = (call: Record<string, unknown> | null, res: Record<string, unknown> | null): Item | null => {
    const ts = (typeof call?.["ts"] === "number" ? call["ts"] : res?.["ts"]) as number;
    const name = String((call ?? res)?.["name"] ?? "?");
    const args = strike(call === null ? "" : textOf(call["args"]), token);
    const resText = strike(textOf(res?.["text"]), token);
    const error = res?.["isError"] === true;
    if (!grepOk(name, args, resText)) return null;
    const turn = String((call ?? res)?.["turn"] ?? "?");
    const n = String((call ?? res)?.["call"] ?? "?");
    const half = Math.max(24, Math.floor((w - 40) / 2));
    const verdict = res === null ? "…" : error ? "✗" : "✓";
    return { ts, error, text: `${clock(ts)}  t${turn} #${n}  ${name} ${verdict}  ${cap(around(args, opts.grep, half), half)}  ⇒ ${cap(around(resText, opts.grep, half), half)}` };
  };

  const onRec: RecFn = (rec) => {
    if (Number.isFinite(rec.ts)) {
      // Past the window's far edge in the direction of reading: stop. On its near side: skip.
      if (opts.since !== null && rec.ts < opts.since) return opts.forward ? undefined : true;
      if (opts.until !== null && rec.ts > opts.until) return opts.forward ? true : undefined;
    }
    if (opts.all) {
      if (opts.errors && rec.t !== "snippet_result" && rec.t !== "tool_result") return;
      if (SIZE_ONLY.has(rec.t) || rec.bytes > 256 << 10) {
        if (opts.grep !== null || opts.errors) return;
        return keep({ ts: rec.ts, error: false, text: `${clock(rec.ts)}  ${rec.t}  (${fmtBytes(rec.bytes)})` });
      }
      const r = rec.parse();
      if (r === null) return;
      // --grep filters every kind, meta included: a kept meta line would spend the --last budget.
      if (!grepOk(strike(rec.text() ?? "", token))) return;
      if (rec.t === "meta") {
        return keep({ ts: rec.ts, error: false, text: `${clock(rec.ts)}  meta  run ${String(r["runId"] ?? "?")} harness ${String(r["harnessVersion"] ?? "?")}` });
      }
      const line = compact(r, w, token);
      const error = r["isError"] === true;
      return keep({ ts: rec.ts, error, text: `${clock(rec.ts)}  ${rec.t}  ${line}` });
    }
    switch (rec.t) {
      case "snippet":
      case "snippet_result": {
        const r = rec.parse();
        if (r === null) return;
        const pair = meet(pendingSnippet, firstSide, callKey(r), rec.t === "snippet" ? "call" : "result", r);
        const it = pair === null ? null : snippetItem(pair.call, pair.res);
        return it === null ? undefined : keep(it);
      }
      case "tool_call":
      case "tool_result": {
        const r = rec.parse();
        if (r === null) return;
        // A snippet's call is shown by its snippet record, which carries the same code.
        if (rec.t === "tool_call" && r["name"] === "run_snippet") return;
        const pair = meet(pendingTool, firstSide, callKey(r), rec.t === "tool_call" ? "call" : "result", r);
        const it = pair === null ? null : toolItem(pair.call, pair.res);
        return it === null ? undefined : keep(it);
      }
      default: {
        if (!NOTICES.has(rec.t) || opts.errors || rec.bytes > 64 << 10) return;
        const r = rec.parse();
        if (r === null) return;
        const line = compact(r, w, token);
        if (!grepOk(line)) return;
        return keep({ ts: rec.ts, error: false, text: `${clock(rec.ts)}  ${rec.t}  ${line}` });
      }
    }
  };
  if (via.store !== null) await storeRead(via.store, runId, opts.all ? TRAJECTORY_ALL_SPEC : TRAJECTORY_SPEC, opts, via.ext.window, opts.forward, onRec);
  else if (opts.forward) fileForward(path, onRec, opts.since === null ? 0 : seekTime(path, opts.since));
  else fileBackward(path, onRec, opts.until === null ? undefined : offsetAfter(path, opts.until));
  // A first-read half never met: reading back, a result whose call the file or
  // the window cut off; reading forward, a call whose result lies past it.
  if (items.length < opts.last) {
    for (const p of pendingSnippet.values()) {
      const it = p.side === "call" ? snippetItem(p.r, null) : snippetItem(null, p.r);
      if (it !== null && (!opts.errors || it.error)) items.push(it);
    }
    for (const p of pendingTool.values()) {
      const it = p.side === "call" ? toolItem(p.r, null) : toolItem(null, p.r);
      if (it !== null && (!opts.errors || it.error)) items.push(it);
    }
  }
  const sorted = items.sort((a, b) => a.ts - b.ts);
  const shown = opts.forward ? sorted.slice(0, opts.last) : sorted.slice(-opts.last);
  const filters = [opts.errors ? "errors only" : null, opts.grep !== null ? `matching /${opts.grep.source}/${opts.grep.flags}` : null, windowPhrase(opts) || null, opts.all ? "every record kind" : null].filter(Boolean);
  out(cap(strike(`${runId}: the ${opts.forward ? "first" : "last"} ${shown.length} ${opts.all ? "record(s)" : "item(s)"}${filters.length > 0 ? ` (${filters.join(", ")})` : ""}, oldest first, UTC`, token), w));
  for (const it of shown) out(cap(strike(it.text, token), w));
  out(cap(`source    ${via.line}`, w));
  return 0;
}

// ------------------------------------------------------------------ what tools and pad read

/** wrath-mcp/mcp/src/scratchpad.ts. */
export const SCRATCHPAD_MAX_CHARS = 32_000;
/** The words of every over-cap refusal after the op it names (`overCapText`, wrath-mcp/mcp/src/scratchpad.ts). */
export const PAD_REFUSED = "refused: the scratchpad would be ";
const PAD_REFUSED_BYTES = Buffer.from(PAD_REFUSED);
const PAD_REFUSAL = /([\w.]+) refused: the scratchpad would be (\d+) chars/;
/** The starts of the reflect tool's two fixed refusals (runner/src/reflect.ts). */
export const REFLECT_NOT_RESTING_HEAD = "Reflection needs rest or a flight";
export const REFLECT_ALREADY_USED_HEAD = "You already reflected";
/** The context's pad section when the pad is empty (runner/src/context.ts, `assembleContext`). */
export const PAD_EMPTY = "(empty — write your plan and durable facts with write_scratchpad)";
/** wrath-mcp/mcp/src/scratchpad.ts: the old cut's marker, stripped wherever a write puts it. */
const LEGACY_TRUNCATION_MARKER = /\n{0,2}\[scratchpad truncated at \d+ chars\]/g;
/** The pad tools' alias keys (wrath-mcp/mcp/src/tools.ts, each core tool's `aliases`): a logged call can carry either spelling. */
export const PAD_ARG_ALIASES: Record<string, Record<string, string>> = {
  write_scratchpad: { text: "content", markdown: "content" },
  edit_scratchpad: {
    old_string: "old",
    oldString: "old",
    old_text: "old",
    search: "old",
    new_string: "new",
    newString: "new",
    new_text: "new",
    replace: "new",
    replace_all: "replaceAll",
    replaceall: "replaceAll",
  },
};
const PAD_TOOL_NAMES = Object.keys(PAD_ARG_ALIASES);
const PAD_TOOLS = new Set(PAD_TOOL_NAMES);
/** A snippet that writes the pad: found in its code, so a write behind a branch it never took still counts. */
const SNIPPET_PAD_WRITE = /\bscratchpad\s*\.\s*(write|append)\s*\(/g;

/** `scratchpadSizeLabel` (wrath-mcp/mcp/src/scratchpad.ts): the size every turn's context shows, "31.2k/32k". */
export function padSizeLabel(chars: number): string {
  const size = `${(Math.floor(chars / 100) / 10).toFixed(1)}k/${SCRATCHPAD_MAX_CHARS / 1000}k`;
  return chars > SCRATCHPAD_MAX_CHARS ? `${size}, over the cap` : size;
}

const PAD_HEAD = /^\n\n\[scratchpad(?: ([^\]\n]*))?\]\n/;
/** The pad section's header as it sits inside a JSON string: its newlines escaped. */
const PAD_HEADER_JSON = Buffer.from(PAD_HEADER_RAW);

/**
 * The pad, off a context's text from its `\n\n[scratchpad` header to the end.
 * The section is the context's last, and its label states the size, so a
 * header whose label disagrees with the length after it is not the section's
 * (a pad or an event that quotes one). Null when it is not.
 */
export function padOfSection(text: string): string | null {
  const m = PAD_HEAD.exec(text);
  if (m === null) return null;
  const rest = text.slice(m[0].length);
  if (m[1] === undefined) return rest === PAD_EMPTY ? "" : null;
  return m[1] === padSizeLabel(rest.length) ? rest : null;
}

/** The offset of the quote that closes the JSON string byte `i` lies in; -1 when the line ends first. */
function jsonStringEnd(buf: Buffer, i: number, end: number): number {
  for (let j = i; j < end; j++) {
    const c = buf[j];
    if (c === 0x5c) j++;
    else if (c === 0x22) return j;
  }
  return -1;
}

/**
 * The pad a `request` record's context showed, read off the raw line: every
 * driver's request ends its user text with the pad section (a fixed-loop slim
 * record in `user`, every other shape as the last message), so the header is
 * found from the end and only that string's tail is decoded. A request is
 * megabytes on an old fixed-loop record; it is never parsed whole here.
 */
export function padOfRequest(buf: Buffer, s: number, e: number): string | null {
  // Searched in a view of the line alone: a miss must not run on through the rest of the chunk.
  const line = buf.subarray(s, e);
  for (let j = line.lastIndexOf(PAD_HEADER_JSON); j >= 0; j = j > 0 ? line.lastIndexOf(PAD_HEADER_JSON, j - 1) : -1) {
    const i = s + j;
    const end = jsonStringEnd(buf, i, e);
    if (end <= i) continue;
    try {
      const pad = padOfSection(JSON.parse(`"${buf.toString("utf8", i, end)}"`) as string);
      if (pad !== null) return pad;
    } catch {
      /* not the tail of a string */
    }
  }
  return null;
}

/** A pad tool's arguments under their canonical keys. */
function padArgs(name: string, args: unknown): Record<string, unknown> {
  const out = { ...obj(args) };
  for (const [alias, canonical] of Object.entries(PAD_ARG_ALIASES[name] ?? {})) {
    if (alias in out && !(canonical in out)) {
      out[canonical] = out[alias];
      delete out[alias];
    }
  }
  return out;
}

/** The size a pad tool's result reports: `written (N chars)`, `edited (…; N chars, L lines)`. */
function sizeOfResult(text: string): number | null {
  const m = /^(?:written \((\d+) chars\)|edited \([^;)]*; (\d+) chars)/.exec(text);
  return m === null ? null : Number(m[1] ?? m[2]);
}

/**
 * The over-cap refusal in a text, matched only around where its fixed words
 * stand: the op's `[\w.]+` run against a whole result (pages of one word
 * character) backtracks quadratically.
 */
function padRefusalOf(text: string): { op: string; chars: number } | null {
  const i = text.indexOf(PAD_REFUSED);
  if (i < 0) return null;
  const m = PAD_REFUSAL.exec(text.slice(Math.max(0, i - 48), i + PAD_REFUSED.length + 24));
  return m === null ? null : { op: m[1]!, chars: Number(m[2]) };
}

/** The over-cap refusal in a result line, found by its bytes and decoded around them only. */
function padRefusalIn(buf: Buffer, s: number, e: number): { op: string; chars: number } | null {
  const j = buf.subarray(s, e).indexOf(PAD_REFUSED_BYTES);
  if (j < 0) return null;
  const i = s + j;
  return padRefusalOf(buf.toString("utf8", Math.max(s, i - 48), Math.min(e, i + PAD_REFUSED_BYTES.length + 24)));
}

/** Which of `scratchpad.write(` and `scratchpad.append(` a snippet record's code calls; null for neither. */
function snippetPadWrites(r: Rec): string | null {
  if (r.bytes > RAW_CAP_BYTES) return null;
  const text = r.text();
  if (text === null || !text.includes("scratchpad")) return null;
  const code = textOf(r.parse()?.["code"]);
  const found = new Set([...code.matchAll(SNIPPET_PAD_WRITE)].map((m) => m[1]!));
  if (found.size === 0) return null;
  return ["write", "append"].filter((k) => found.has(k)).join("+");
}

/** The run's driver: the row's, else meta's, else a request's adapter label up to its colon. A live run's row is read only from ClickHouse. */
function driverName(adapter: string | null, dir: string, runId: string, via: Via, now: number): string {
  let fromRow: string | null = null;
  if (via.store !== null && via.run !== null) fromRow = via.run.driver;
  else if (!ownedAt(heartbeatAt(dir), now)) {
    const db = openDb(dir);
    try {
      fromRow = db === null ? null : (readRow(db, runId)?.driver ?? null);
    } finally {
      db?.close();
    }
  }
  return fromRow ?? str(obj(readMeta(dir)?.["config"])["driver"]) ?? adapter?.split(":")[0] ?? "?";
}

/** Characters as a short figure: 950, 12.3k. */
function fmtChars(n: number | null): string {
  if (n === null) return "?";
  return n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`;
}

/** A window's records by clock: the store's own extent, or the reducer's count off the file. */
function spanFrom(ext: Extent): { first: number | null; last: number | null } {
  return { first: ext.window?.firstTs ?? null, last: ext.window?.lastTs ?? null };
}

// ------------------------------------------------------------------ inspect tools

interface ToolTally {
  calls: number;
  results: number;
  errors: number;
  classes: Map<string, number>;
}

export interface ToolsScan {
  first: number | null;
  last: number | null;
  adapter: string | null;
  requests: number;
  responses: number;
  tools: Map<string, ToolTally>;
  reflect: { granted: number; notResting: number; alreadyUsed: number; otherRefusal: number; marked: number };
  windows: { opens: number; closes: Map<string, number>; zeroLength: number; openAtEnd: boolean };
  /** Snippets whose code calls `scratchpad.write`/`append`, by which. */
  snippetPad: Map<string, number>;
  /** Over-cap refusals by the op the refusal names. */
  padRefusals: Map<string, number>;
}

function toolErrorClass(name: string, text: string): string {
  if (padRefusalOf(text) !== null) return "over cap";
  if (name === "run_snippet") return errorClass(text);
  const first = (text.split("\n", 1)[0] ?? "").replace(new RegExp(`^${name}:\\s*`), "");
  return first.split(/\s+/).slice(0, 4).join(" ").slice(0, 40) || "(empty)";
}

/** The tools view over the window, record by record: every tool's calls and results, the reflect gate, the pad's writers. */
function toolsReducer(w: Window): { a: ToolsScan; fn: RecFn; done: () => ToolsScan } {
  const a: ToolsScan = {
    first: null,
    last: null,
    adapter: null,
    requests: 0,
    responses: 0,
    tools: new Map(),
    reflect: { granted: 0, notResting: 0, alreadyUsed: 0, otherRefusal: 0, marked: 0 },
    windows: { opens: 0, closes: new Map(), zeroLength: 0, openAtEnd: false },
    snippetPad: new Map(),
    padRefusals: new Map(),
  };
  const tally = (name: string): ToolTally => {
    let t = a.tools.get(name);
    if (t === undefined) a.tools.set(name, (t = { calls: 0, results: 0, errors: 0, classes: new Map() }));
    return t;
  };
  let openAt: number | null = null;
  const fn: RecFn = (r) => {
    if (Number.isFinite(r.ts)) {
      if (w.until !== null && r.ts > w.until) return true;
      if (w.since !== null && r.ts < w.since) return;
      a.first ??= r.ts;
      a.last = r.ts;
    }
    switch (r.t) {
      case "request":
        a.requests++;
        a.adapter ??= r.adapter();
        return;
      case "response":
        a.responses++;
        return;
      case "tool_call":
        tally(r.name() ?? "?").calls++;
        return;
      case "snippet": {
        const which = snippetPadWrites(r);
        if (which !== null) count(a.snippetPad, which);
        return;
      }
      case "snippet_result":
      case "tool_result": {
        const name = r.name() ?? (r.t === "snippet_result" ? "run_snippet" : "?");
        const isError = r.isError();
        const t = tally(name);
        t.results++;
        const refusal = r.refusal();
        if (refusal !== null) count(a.padRefusals, refusal.op);
        // Results are small next to a request; past 256 KB, the head says enough.
        const p = isError || name === "reflect" ? (r.bytes < 256 << 10 ? r.parse() : null) : null;
        const text = textOf(p?.["text"]);
        if (name === "reflect") {
          // The marker came later than the tool: a result without it is the same reflect call, older.
          if (p?.["reflect"] === true) a.reflect.marked++;
          if (!isError) a.reflect.granted++;
          else if (text.startsWith(REFLECT_NOT_RESTING_HEAD)) a.reflect.notResting++;
          else if (text.startsWith(REFLECT_ALREADY_USED_HEAD)) a.reflect.alreadyUsed++;
          else a.reflect.otherRefusal++;
        }
        if (isError) {
          t.errors++;
          count(t.classes, refusal !== null ? "over cap" : p === null ? "(a result over 256 KB, unread)" : toolErrorClass(name, text));
        }
        return;
      }
      case "reflect_window": {
        const p = r.parse();
        if (p?.["event"] === "open") {
          a.windows.opens++;
          openAt = r.ts;
        } else if (p?.["event"] === "close") {
          count(a.windows.closes, String(p["reason"] ?? "?"));
          if (openAt !== null && r.ts - openAt < 1000) a.windows.zeroLength++;
          openAt = null;
        }
        return;
      }
    }
  };
  return {
    a,
    fn,
    done: () => {
      a.windows.openAtEnd = openAt !== null;
      return a;
    },
  };
}

/** One forward pass over the file's window: every tool's calls and results, the reflect gate, the pad's writers. */
export function scanTools(path: string, w: Window): ToolsScan {
  const t = toolsReducer(w);
  fileForward(path, t.fn, w.since === null ? 0 : seekTime(path, w.since));
  return t.done();
}

/**
 * What `tools` asks of the store. A response is only counted, so the extent
 * counts it; every other row comes, but its line only when the view would
 * parse it: a result that failed or is reflect's, a snippet that names the
 * pad, every reflect window.
 */
const TOOLS_SPEC: ReadSpec = {
  kinds: {
    request: { raw: "none" },
    tool_call: { raw: "none" },
    snippet: { row: { contains: "scratchpad" }, raw: "all" },
    snippet_result: { raw: { error: true, names: ["reflect"] } },
    tool_result: { raw: { error: true, names: ["reflect"] } },
    reflect_window: { raw: "all" },
  },
  heads: true,
  refusals: true,
};

async function storeTools(store: InspectStore, runId: string, ext: Extent, w: Window): Promise<ToolsScan> {
  const t = toolsReducer(w);
  await storeRead(store, runId, TOOLS_SPEC, w, ext.window, true, t.fn);
  const a = t.done();
  a.responses = ext.kinds.get("response") ?? 0;
  ({ first: a.first, last: a.last } = spanFrom(ext));
  return a;
}

export async function inspectTools(runId: string, opts: Ctx & Window, out: Out): Promise<number> {
  const run = trajectoryOf(runId, opts, out);
  if (run === null) return 1;
  const via = await viaFor(opts, runId, run.dir, opts);
  const a = via.store !== null ? await storeTools(via.store, runId, via.ext, opts) : scanTools(run.path, opts);
  const say = (text: string): void => out(cap(strike(text, run.token), opts.width));
  const span = a.first === null ? "no records" : `${clock(a.first)} to ${clock(a.last!)}`;
  say(`${runId}: tool calls by name, ${windowPhrase(opts) || "whole run"} (${span}), UTC`);
  say(`driver    ${driverName(a.adapter, run.dir, runId, via, opts.now)} · ${a.requests} request(s) · ${a.responses} model response(s)`);
  const rows = [...a.tools].sort((x, y) => Math.max(y[1].results, y[1].calls) - Math.max(x[1].results, x[1].calls) || x[0].localeCompare(y[0]));
  say(`${"tool".padEnd(22)} ${"calls".padStart(6)} ${"ok".padStart(6)} ${"err".padStart(6)}  errors`);
  for (const [name, t] of rows) {
    const unanswered = t.calls - t.results;
    const notes = [t.errors > 0 ? topCounts(t.classes, 4) : "", unanswered > 0 ? `+${unanswered} call(s) without a result` : ""].filter(Boolean).join(" · ");
    say(`${name.padEnd(22)} ${String(Math.max(t.results, t.calls)).padStart(6)} ${String(t.results - t.errors).padStart(6)} ${String(t.errors).padStart(6)}  ${notes}`);
  }
  if (rows.length === 0) say("(no tool calls in the window)");
  const rf = a.reflect;
  const reflects = a.tools.get("reflect")?.results ?? 0;
  if (reflects > 0) {
    const refused = rf.notResting + rf.alreadyUsed + rf.otherRefusal;
    const why = [rf.notResting > 0 ? `not resting ${rf.notResting}` : "", rf.alreadyUsed > 0 ? `already used ${rf.alreadyUsed}` : "", rf.otherRefusal > 0 ? `other ${rf.otherRefusal}` : ""].filter(Boolean).join(", ");
    say(`reflection granted ${rf.granted} · refused ${refused}${why !== "" ? `: ${why}` : ""} · the reflect marker on ${rf.marked} of ${reflects} result(s)`);
  }
  const wd = a.windows;
  const closed = [...wd.closes.values()].reduce((x, y) => x + y, 0);
  if (wd.opens > 0 || closed > 0) {
    say(`windows   opened ${wd.opens} · closed ${closed}${closed > 0 ? `: ${topCounts(wd.closes, 4)}` : ""} · ${wd.zeroLength} zero-length${wd.openAtEnd ? " · open at the window's end" : ""}`);
    if (wd.zeroLength > 0) {
      say("          zero-length: the gate's open and close are written when the harness builds a context, so a driver that builds one only");
      say("          when the model yields writes them late and together; count grants from the reflection line, not from windows");
    }
  }
  const padTools = PAD_TOOL_NAMES.map((n) => {
    const t = a.tools.get(n);
    const over = t?.classes.get("over cap") ?? 0;
    return `${n} ${t?.results ?? 0}${over > 0 ? ` (${over} over cap)` : ""}`;
  });
  const snippetOver = [...a.padRefusals].filter(([op]) => op.startsWith("scratchpad.")).reduce((x, [, n]) => x + n, 0);
  const inSnippets = a.snippetPad.size === 0 ? "none" : topCounts(a.snippetPad, 3);
  say(`pad       tools: ${padTools.join(", ")} · snippets calling scratchpad.write/append: ${inSnippets}${snippetOver > 0 ? ` (${snippetOver} refused over cap)` : ""}`);
  say(`source    ${via.line}`);
  return 0;
}

// ------------------------------------------------------------------ inspect pad

interface PadSample {
  ts: number;
  chars: number;
}

export interface PadWrite {
  ts: number;
  turn: string;
  call: string;
  /** `tool write`, `tool edit`, `snippet write`, `snippet append`, `snippet write+append`. */
  how: string;
  /** The size last known before it; null when nothing said yet. */
  before: number | null;
  /** The size after: a tool's result, or for a snippet the next request's pad when no other write came between. */
  after: number | null;
  afterFrom: "result" | "next request" | null;
  /** The size the refused write would have left, when the cap refused it. */
  refused: number | null;
}

export interface PadScan {
  first: number | null;
  last: number | null;
  adapter: string | null;
  requests: number;
  requestsWithPad: number;
  toolCalls: number;
  samples: PadSample[];
  writes: PadWrite[];
}

/** A size over 30% smaller than the one before it: a pad that lost what it held. */
export function isDrop(w: Pick<PadWrite, "before" | "after">): boolean {
  return w.before !== null && w.after !== null && w.before > 0 && w.after < w.before * 0.7;
}

/** The pad view over the window, record by record: the pad's size wherever a record says it, and every write. */
function padReducer(w: Window): { p: PadScan; fn: RecFn } {
  const p: PadScan = { first: null, last: null, adapter: null, requests: 0, requestsWithPad: 0, toolCalls: 0, samples: [], writes: [] };
  let known: number | null = null;
  // The snippet write the next request's pad sizes, while no other write has come after it.
  let open: PadWrite | null = null;
  const bySnippet = new Map<string, PadWrite>();
  const key = (r: Record<string, unknown> | null): string => `${String(r?.["turn"])}:${String(r?.["call"])}`;
  const write = (ts: number, r: Record<string, unknown> | null, how: string): PadWrite => {
    const pw: PadWrite = { ts, turn: String(r?.["turn"] ?? "?"), call: String(r?.["call"] ?? "-"), how, before: known, after: null, afterFrom: null, refused: null };
    p.writes.push(pw);
    return pw;
  };
  const fn: RecFn = (r) => {
    if (Number.isFinite(r.ts)) {
      if (w.until !== null && r.ts > w.until) return true;
      if (w.since !== null && r.ts < w.since) return;
      p.first ??= r.ts;
      p.last = r.ts;
    }
    switch (r.t) {
      case "request": {
        p.requests++;
        p.adapter ??= r.adapter();
        const pad = r.pad();
        if (pad === null) return;
        p.requestsWithPad++;
        p.samples.push({ ts: r.ts, chars: pad.length });
        if (open !== null) {
          open.after = pad.length;
          open.afterFrom = "next request";
          open = null;
        }
        known = pad.length;
        return;
      }
      case "tool_call":
        p.toolCalls++;
        return;
      case "snippet": {
        const which = snippetPadWrites(r);
        if (which === null) return;
        const rec = r.parse();
        const pw = write(r.ts, rec, `snippet ${which}`);
        bySnippet.set(key(rec), pw);
        open = pw;
        return;
      }
      case "snippet_result": {
        const refusal = r.refusal();
        if (refusal === null) return;
        const rec = r.bytes < 256 << 10 ? r.parse() : null;
        const pw = bySnippet.get(key(rec)) ?? write(r.ts, rec, `snippet ${refusal.op.replace(/^scratchpad\./, "")}`);
        bySnippet.delete(key(rec));
        pw.refused = refusal.chars;
        if (open === pw) open = null;
        return;
      }
      case "tool_result": {
        const name = r.name() ?? "?";
        if (!PAD_TOOLS.has(name)) return;
        const rec = r.parse();
        const text = textOf(rec?.["text"]);
        const how = name === "write_scratchpad" ? "tool write" : "tool edit";
        if (rec?.["isError"] === true) {
          // A refused edit for any other reason (no match, ambiguous) changed nothing.
          const refusal = padRefusalOf(text);
          if (refusal !== null) write(r.ts, rec, how).refused = refusal.chars;
          return;
        }
        const chars = sizeOfResult(text);
        const pw = write(r.ts, rec, how);
        pw.after = chars;
        pw.afterFrom = chars === null ? null : "result";
        if (chars !== null) {
          p.samples.push({ ts: r.ts, chars });
          known = chars;
        }
        open = null;
        return;
      }
    }
  };
  return { p, fn };
}

/** One forward pass over the file's window: the pad's size wherever a record says it, and every write. */
export function scanPad(path: string, w: Window): PadScan {
  const r = padReducer(w);
  fileForward(path, r.fn, w.since === null ? 0 : seekTime(path, w.since));
  return r.p;
}

/**
 * What `pad` asks of the store: every request with its pad cut out on the
 * server, and only the rows that write the pad or are refused by its cap. A
 * tool call is only counted, so the extent counts it.
 */
const PAD_SPEC: ReadSpec = {
  kinds: {
    request: { raw: "none" },
    snippet: { row: { contains: "scratchpad" }, raw: "all" },
    snippet_result: { row: { contains: PAD_REFUSED }, raw: "all" },
    tool_result: { row: { names: PAD_TOOL_NAMES }, raw: "all" },
  },
  heads: true,
  pads: true,
  refusals: true,
};

async function storePad(store: InspectStore, runId: string, ext: Extent, w: Window): Promise<PadScan> {
  const r = padReducer(w);
  await storeRead(store, runId, PAD_SPEC, w, ext.window, true, r.fn);
  r.p.toolCalls = ext.kinds.get("tool_call") ?? 0;
  ({ first: r.p.first, last: r.p.last } = spanFrom(ext));
  return r.p;
}

const PAD_BUCKETS = 24;

export async function inspectPad(runId: string, opts: Ctx & Window & { last: number }, out: Out): Promise<number> {
  const run = trajectoryOf(runId, opts, out);
  if (run === null) return 1;
  const via = await viaFor(opts, runId, run.dir, opts);
  const p = via.store !== null ? await storePad(via.store, runId, via.ext, opts) : scanPad(run.path, opts);
  const say = (text: string): void => out(cap(strike(text, run.token), opts.width));
  const span = p.first === null ? "no records" : `${clock(p.first)} to ${clock(p.last!)}`;
  say(`${runId}: the scratchpad, ${windowPhrase(opts) || "whole run"} (${span}), UTC`);
  say(`source    ${via.line}`);
  const driver = driverName(p.adapter, run.dir, runId, via, opts.now);
  const perRequest = p.requestsWithPad > 0 ? ` (${(p.toolCalls / p.requestsWithPad).toFixed(1)} per request)` : "";
  say(`sizes     driver ${driver} · the pad's text on ${p.requestsWithPad} of ${p.requests} request(s) · ${p.toolCalls} tool call(s)${perRequest}`);
  // Only a request sizes a snippet's write, so how many went unsized is the
  // run's own measure of whether its driver gives a size per turn.
  const snippetWrites = p.writes.filter((x) => x.how.startsWith("snippet") && x.refused === null);
  const unsized = snippetWrites.filter((x) => x.after === null).length;
  if (unsized > 0 || p.requestsWithPad === 0) {
    say(`per-turn  none for ${unsized} of ${snippetWrites.length} snippet write(s): driver ${driver} writes the pad's text only on a request, when it hands the model a new context`);
    say("          between requests only write_scratchpad/edit_scratchpad results give a size; a snippet's scratchpad.write/append has none");
  }
  try {
    const now = readFileSync(join(run.dir, "scratchpad.md"), "utf8").replace(LEGACY_TRUNCATION_MARKER, "");
    say(`now       scratchpad.md ${now.length} chars (${padSizeLabel(now.length)})`);
  } catch {
    say("now       no scratchpad.md");
  }
  const refusals = p.writes.filter((x) => x.refused !== null);
  say(
    `cap       ${SCRATCHPAD_MAX_CHARS} chars · ${refusals.length} refusal(s)${refusals.length > 0 ? `: ${refusals.slice(-6).map((x) => `${clock(x.ts)} ${x.how} ${x.refused}`).join(" · ")}${refusals.length > 6 ? ` (the last 6)` : ""}` : ""}`,
  );

  if (p.samples.length === 0) say("timeline  no size known in the window");
  else {
    const t0 = p.samples[0]!.ts;
    const spanMs = Math.max(0, p.samples[p.samples.length - 1]!.ts - t0);
    const bucketMs = Math.max(60_000, Math.ceil(spanMs / PAD_BUCKETS / 60_000) * 60_000);
    const buckets = new Map<number, { min: number; max: number; last: number | null; writes: number; refused: number; drops: number }>();
    const bucket = (ts: number) => {
      const i = Math.max(0, Math.floor((ts - t0) / bucketMs));
      let b = buckets.get(i);
      if (b === undefined) buckets.set(i, (b = { min: Infinity, max: -Infinity, last: null, writes: 0, refused: 0, drops: 0 }));
      return b;
    };
    for (const x of p.samples) {
      const b = bucket(x.ts);
      b.min = Math.min(b.min, x.chars);
      b.max = Math.max(b.max, x.chars);
      b.last = x.chars;
    }
    for (const x of p.writes) {
      const b = bucket(x.ts);
      if (x.refused !== null) b.refused++;
      else b.writes++;
      if (isDrop(x)) b.drops++;
    }
    say(`timeline  ${buckets.size} bucket(s) of ${fmtAge(bucketMs)}: size min–max and last, from the requests and the write results`);
    for (const [i, b] of [...buckets].sort((x, y) => x[0] - y[0])) {
      const sizes = b.last === null ? "—".padEnd(20) : `${fmtChars(b.min)}–${fmtChars(b.max)} last ${fmtChars(b.last)}`.padEnd(20);
      const marks = [b.writes > 0 ? `writes ${b.writes}` : "", b.refused > 0 ? `refused ${b.refused}` : "", b.drops > 0 ? `drops ${b.drops}` : ""].filter(Boolean).join("  ");
      say(`  ${clock(t0 + i * bucketMs).slice(0, 11)}  ${sizes}  ${marks}`);
    }
  }

  const shown = p.writes.slice(-opts.last);
  say(`writes    the last ${shown.length} of ${p.writes.length}: a tool's size from its result; a snippet's after-size from the next request, when no other write came between`);
  for (const x of shown) {
    const after = x.refused !== null ? `refused, would be ${x.refused}` : x.after === null ? "?" : `${x.after}${x.afterFrom === "next request" ? " (next request)" : ""}`;
    const change = x.before !== null && x.after !== null && x.refused === null && x.before > 0 ? `  ${x.after >= x.before ? "+" : ""}${Math.round(((x.after - x.before) / x.before) * 100)}%` : "";
    say(`  ${clock(x.ts)}  t${x.turn} #${x.call}  ${x.how.padEnd(20)} ${x.before === null ? "?" : String(x.before)} → ${after}${change}${isDrop(x) ? "  DROP" : ""}`);
  }
  return 0;
}

/** The pad as it stood at one moment, and how sure that is. */
export interface PadAt {
  text: string;
  /** The record the text starts from: a request's pad, or a `write_scratchpad`'s content. */
  from: { ts: number; what: string };
  edits: number;
  /** Edits whose `old` the rebuilt text did not hold. */
  missed: number;
  /** Snippets after the start that call `scratchpad.write`/`append`: their effect is not on the record. */
  snippetWrites: number[];
  /** The newest size a write's result reported, to check the rebuild against. */
  recorded: number | null;
}

/**
 * The pad at `at`, rebuilt reading back from it: the newest request's pad or
 * `write_scratchpad` content at or before it, then every successful
 * `edit_scratchpad` after that replayed in order. A snippet's write is code,
 * not text, so one between makes the answer uncertain and says so.
 */
function padAtReducer(at: number): { fn: RecFn; done: () => PadAt | null } {
  const results = new Map<string, Record<string, unknown>>();
  const edits: Record<string, unknown>[] = [];
  const snippetWrites: number[] = [];
  let recorded: number | null = null;
  let from: { ts: number; what: string; text: string } | null = null;
  const key = (r: Record<string, unknown>): string => `${String(r["turn"])}:${String(r["call"])}`;
  const fn: RecFn = (r) => {
    if (Number.isFinite(r.ts) && r.ts > at) return;
    switch (r.t) {
      case "request": {
        const pad = r.pad();
        if (pad === null) return;
        from = { ts: r.ts, what: "the request", text: pad };
        return true;
      }
      case "snippet":
        if (snippetPadWrites(r) !== null) snippetWrites.push(r.ts);
        return;
      case "tool_result": {
        if (!PAD_TOOLS.has(r.name() ?? "")) return;
        const p = r.parse();
        if (p === null || p["isError"] === true) return;
        results.set(key(p), p);
        recorded ??= sizeOfResult(textOf(p["text"]));
        return;
      }
      case "tool_call": {
        const name = r.name() ?? "";
        if (!PAD_TOOLS.has(name)) return;
        const p = r.parse();
        if (p === null || !results.has(key(p))) return;
        results.delete(key(p));
        const args = padArgs(name, p["args"]);
        if (name === "edit_scratchpad") {
          edits.push(args);
          return;
        }
        if (typeof args["content"] !== "string") return;
        from = { ts: r.ts, what: "write_scratchpad", text: args["content"].replace(LEGACY_TRUNCATION_MARKER, "") };
        return true;
      }
    }
  };
  const done = (): PadAt | null => {
    const start = from as { ts: number; what: string; text: string } | null;
    if (start === null) return null;
    let text = start.text;
    let missed = 0;
    for (const ed of edits.reverse()) {
      const old = typeof ed["old"] === "string" ? ed["old"] : "";
      const rep = typeof ed["new"] === "string" ? ed["new"] : "";
      const i = old === "" ? -1 : text.indexOf(old);
      if (i < 0) {
        missed++;
        continue;
      }
      text = ed["replaceAll"] === true ? text.split(old).join(rep) : text.slice(0, i) + rep + text.slice(i + old.length);
    }
    return { text, from: { ts: start.ts, what: start.what }, edits: edits.length, missed, snippetWrites: snippetWrites.reverse(), recorded };
  };
  return { fn, done };
}

/** The pad at `at`, off the file. */
export function padAt(path: string, at: number): PadAt | null {
  const r = padAtReducer(at);
  fileBackward(path, r.fn, offsetAfter(path, at));
  return r.done();
}

/** What `pad --at` asks of the store, reading back: requests with their pads, the pad tools' calls and results, the snippets that name the pad. */
const PAD_AT_SPEC: ReadSpec = {
  kinds: {
    request: { raw: "none" },
    snippet: { row: { contains: "scratchpad" }, raw: "all" },
    tool_result: { row: { names: PAD_TOOL_NAMES }, raw: "all" },
    tool_call: { row: { names: PAD_TOOL_NAMES }, raw: "all" },
  },
  pads: true,
};

export async function inspectPadAt(runId: string, opts: Ctx & { at: number }, out: Out): Promise<number> {
  const run = trajectoryOf(runId, opts, out);
  if (run === null) return 1;
  const say = (text: string): void => out(cap(strike(text, run.token), opts.width));
  const upTo: Window = { since: null, until: opts.at };
  const via = await viaFor(opts, runId, run.dir, upTo);
  let p: PadAt | null;
  if (via.store !== null) {
    const r = padAtReducer(opts.at);
    await storeRead(via.store, runId, PAD_AT_SPEC, upTo, via.ext.window, false, r.fn);
    p = r.done();
  } else p = padAt(run.path, opts.at);
  if (p === null) {
    say(`${runId}: no request and no write_scratchpad at or before ${iso(opts.at)} records the pad`);
    say(`source    ${via.line}`);
    return 1;
  }
  say(`${runId}: the scratchpad as of ${iso(opts.at)}, ${p.text.length} chars (${padSizeLabel(p.text.length)})`);
  say(`from      ${p.from.what} at ${clock(p.from.ts)} UTC${p.edits > 0 ? `, then ${p.edits} edit_scratchpad call(s) replayed` : ""}`);
  if (p.snippetWrites.length > 0) {
    say(
      `uncertain ${p.snippetWrites.length} snippet(s) after that call scratchpad.write/append (${p.snippetWrites.slice(-3).map(clock).join(", ")}): what they wrote is not on the record, so this text may be behind`,
    );
  }
  if (p.missed > 0) say(`uncertain ${p.missed} edit(s) did not find their text in the rebuild`);
  if (p.recorded !== null && p.recorded !== p.text.length) say(`uncertain the rebuild is ${p.text.length} chars; the newest write's result said ${p.recorded}`);
  say(`source    ${via.line}`);
  say("---");
  for (const line of p.text.split("\n")) say(line);
  return 0;
}

// ------------------------------------------------------------------ CLI

const USAGE = `usage: bun infra/inspect-run.ts live
       bun infra/inspect-run.ts run <run-id> [--since D] [--until D]
       bun infra/inspect-run.ts trajectory <run-id> [--last N | --next N] [--errors] [--grep RE] [--all] [--since D] [--until D]
       bun infra/inspect-run.ts tools <run-id> [--since D] [--until D]
       bun infra/inspect-run.ts pad <run-id> [--since D] [--until D] [--last N] | --at D
common: [--runs-dir DIR] (else WRATHBENCH_RUNS_DIR, else data/runs) [--width N] [--files]; D is 90s, 30m, 2h, 1d, epoch ms or ISO
--next N: the first N items from --since (or the file's start) instead of the last N
--files: read the files, not ClickHouse (CLICKHOUSE_URL); a live run's run.sqlite is still not opened`;

/** The flags each command takes, beyond the common ones; any other is a usage error, never ignored. */
const COMMAND_FLAGS: Record<string, readonly string[]> = {
  live: [],
  run: ["--since", "--until"],
  trajectory: ["--last", "--next", "--errors", "--grep", "--all", "--since", "--until"],
  tools: ["--since", "--until"],
  pad: ["--since", "--until", "--last", "--at"],
};
const COMMON_FLAGS = new Set(["--runs-dir", "--width", "--files"]);
const VALUED = new Set(["--since", "--until", "--at", "--last", "--next", "--grep", "--width", "--runs-dir"]);

/** What the CLI is handed besides its arguments: a store in place of CLICKHOUSE_URL's, for the tests. */
export interface Deps {
  store?: InspectStore | null;
}

export async function main(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  out: Out,
  err: Out,
  now = Date.now(),
  deps: Deps = {},
): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === "-h" || command === "--help") {
    (command === undefined ? err : out)(USAGE);
    return command === undefined ? 2 : 0;
  }
  const allowed = COMMAND_FLAGS[command];
  if (allowed === undefined) {
    err(`unknown command ${command}\n${USAGE}`);
    return 2;
  }
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "-h" || a === "--help") {
      out(USAGE);
      return 0;
    }
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    if (!COMMON_FLAGS.has(a) && !allowed.includes(a)) {
      err(`${VALUED.has(a) || a === "--errors" || a === "--all" ? `${a} does not apply to ${command}` : `unknown flag ${a}`}\n${USAGE}`);
      return 2;
    }
    if (VALUED.has(a)) {
      const v = rest[++i];
      if (v === undefined) {
        err(`${a} needs a value\n${USAGE}`);
        return 2;
      }
      flags.set(a, v);
    } else flags.set(a, true);
  }
  const runsDir = (flags.get("--runs-dir") as string | undefined) ?? env["WRATHBENCH_RUNS_DIR"] ?? "data/runs";
  const width = flags.has("--width") ? Number(flags.get("--width")) : DEFAULT_WIDTH;
  if (!Number.isInteger(width) || width < 40) {
    err("--width is a whole number of at least 40");
    return 2;
  }
  const times: Partial<Record<"--since" | "--until" | "--at", number>> = {};
  for (const f of ["--since", "--until", "--at"] as const) {
    if (!flags.has(f)) continue;
    try {
      times[f] = parseSince(flags.get(f) as string, now);
    } catch (e) {
      err((e as Error).message.replace("--since", f));
      return 2;
    }
  }
  const window: Window = { since: times["--since"] ?? null, until: times["--until"] ?? null };
  if (window.since !== null && window.until !== null && window.since > window.until) {
    err(`--since ${iso(window.since)} is after --until ${iso(window.until)}`);
    return 2;
  }
  const count = (f: "--last" | "--next"): number | null => {
    if (!flags.has(f)) return null;
    const n = Number(flags.get(f));
    return Number.isInteger(n) && n >= 1 && n <= MAX_LAST ? n : Number.NaN;
  };
  const cfg = clickhouseConfigOf(env);
  const store = flags.has("--files") ? null : deps.store !== undefined ? deps.store : cfg === null ? null : clickhouseStore(cfg);
  const noStore = flags.has("--files") ? "--files" : deps.store === null || cfg === null ? "ClickHouse not configured (no CLICKHOUSE_URL)" : "";
  const base: Ctx = { runsDir, now, width, store, noStore };
  try {
    if (command === "live") return await inspectLive(base, out);
    const runId = positional[0];
    if (runId === undefined || positional.length > 1 || !isValidRunId(runId)) {
      err(runId === undefined ? `${command} needs a run id\n${USAGE}` : `not one run id: ${positional.join(" ")}`);
      return 2;
    }
    const last = count("--last");
    const next = count("--next");
    for (const [f, n] of [["--last", last], ["--next", next]] as const) {
      if (n !== null && Number.isNaN(n)) {
        err(`${f} is a whole number from 1 to ${MAX_LAST}`);
        return 2;
      }
    }
    if (command === "run") return await inspectRun(runId, { ...base, ...window }, out);
    if (command === "tools") return await inspectTools(runId, { ...base, ...window }, out);
    if (command === "pad") {
      const at = times["--at"];
      if (at === undefined) return await inspectPad(runId, { ...base, ...window, last: last ?? DEFAULT_LAST }, out);
      if (window.since !== null || window.until !== null || last !== null) {
        err(`--at prints the pad at one moment; it takes no --since, --until or --last\n${USAGE}`);
        return 2;
      }
      return await inspectPadAt(runId, { ...base, at }, out);
    }
    if (last !== null && next !== null) {
      err(`--last and --next are the two ends of the window: one or the other\n${USAGE}`);
      return 2;
    }
    let grep: RegExp | null = null;
    if (flags.has("--grep")) {
      try {
        grep = new RegExp(flags.get("--grep") as string, "i");
      } catch (e) {
        err(`--grep: ${(e as Error).message}`);
        return 2;
      }
    }
    return await inspectTrajectory(
      runId,
      { ...base, ...window, last: next ?? last ?? DEFAULT_LAST, forward: next !== null, errors: flags.has("--errors"), grep, all: flags.has("--all") },
      out,
    );
  } catch (e) {
    // A store that answered the first question and failed a later one: say so, never with the URL.
    if (e instanceof StoreError) {
      err(`ClickHouse failed mid-read (${e.message}); --files reads the files`);
      return 1;
    }
    throw e;
  }
}

if (import.meta.main) {
  process.exit(await main(Bun.argv.slice(2), process.env, (l) => console.log(l), (l) => console.error(l)));
}
