#!/usr/bin/env bun
/**
 * `bun wb inspect live|run|trajectory|tools|pad|stuck|session|requests`: read-only views of the runs,
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
 *   bun infra/inspect-run.ts stuck [<run-id>] [--window D] [--until D] [--move N] [--max-gap D]
 *                                 [--repeat N] [--hints N] [--schema N] [--restarts N] [--asks N]
 *                                                      no game progress over a window, and the failure signals in it
 *   bun infra/inspect-run.ts session <run-id> [--stream events|calls] [--character NAME] [--kind K[,K]]
 *                                   [--grep RE] [--last N | --next N] [--since D] [--until D]
 *                                                      a v1 run's session record, one line per row
 *   bun infra/inspect-run.ts requests <run-id> [--since D] [--until D] [--at-level N[,N]] [--at-minutes N[,N]]
 *                                    [--stall D] [--price-at DAY] [--catalogue FILE] [--json]
 *                                                      tokens and cost per request, wakes, levels, turn-ins and stalls per hour
 *
 * D is `90s`, `30m`, `2h`, `1d`, epoch ms or an ISO time. The runs directory is
 * `--runs-dir`, else WRATHBENCH_RUNS_DIR, else `data/runs`. Where a view takes
 * a run id it takes a fan-out character's session id too, `<run-id>~<Name>`
 * as the viewer names it: `session` reads that character's record alone (its
 * `--character`), and every other view reads the run, the one agent's.
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
 * A v1 run's session record is read off its files too, a fan-out run's one per
 * character (`sessions/<Character>/`): the marks its `events` stream holds,
 * the `session` view and what covers `stuck`'s window. The store holds only
 * the samples the collector folds from each trace, a fan-out character's
 * under `<run-id>~<Character>`.
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
  /** Whether the line holds `literal`; null when the reader did not fetch the line to look. */
  contains(literal: string): boolean | null;
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
    contains: (literal) => buf.subarray(s, e).indexOf(literal) >= 0,
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

/**
 * One trajectory line as the store returns it: `r` empty when not fetched,
 * `h`/`p`/`q` the server's cuts, and `pn` how many pad headers a request's
 * line holds (`PAD_HEADER_PATTERN`).
 */
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
  pn: number;
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
  /**
   * The `states` rows of [since, until], in (ts, seq) order: what `stuck`
   * judges a v1 run by, whose samples the collector folds from its trace and
   * whose trajectory carries none.
   */
  samples(id: string, since: number, until: number): Promise<Record<string, unknown>[]>;
  /** The newest `states` row before `ts`: the reading a window that starts there starts from. */
  sampleBefore(id: string, ts: number): Promise<Record<string, unknown> | null>;
  extent(id: string, w: Window): Promise<Extent>;
  /** The lines numbered [from, to) that the spec wants, in the window. */
  rows(id: string, spec: ReadSpec, w: Window, from: number, to: number): Promise<StoreRow[]>;
  /** Whole request lines, for the rare pad a server-side cut could not place. */
  raws(id: string, lines: readonly number[]): Promise<Map<number, string>>;
  /** The run's `response` records' usage columns summed, over the whole run (`usageSql`). */
  usage(id: string): Promise<UsageTotals>;
}

/**
 * What a run's `response` records report of their usage, summed: the
 * collector's usage columns (collector/src/lines.ts `usageOf`), or the same
 * fields read off the file. A figure no response reported is null, never 0.
 */
export interface UsageTotals {
  responses: number;
  /** Responses that reported an input or an output count. */
  reported: number;
  input: number;
  output: number;
  cacheRead: number | null;
  cacheWrite: number | null;
  /** The provider's own charge, summed over the responses that carried one (`costed`). */
  usd: number | null;
  costed: number;
}

/** The run's response usage in one aggregate, each line once (a replay's rows wait for a merge). */
export function usageSql(runId: string): string {
  return `SELECT count() AS n, countIf(i IS NOT NULL OR o IS NOT NULL) AS reported, sum(ifNull(i, 0)) AS input, sum(ifNull(o, 0)) AS output,
       sum(ifNull(cr, 0)) AS cache_read, countIf(cr IS NOT NULL) AS crn, sum(ifNull(cw, 0)) AS cache_write, countIf(cw IS NOT NULL) AS cwn,
       sum(ifNull(c, 0)) AS usd, countIf(c IS NOT NULL) AS costed
  FROM (SELECT line_no, any(input_tokens) AS i, any(output_tokens) AS o, any(cache_read_tokens) AS cr, any(cache_write_tokens) AS cw, any(cost_usd) AS c
          FROM turns WHERE run_id = ${sqlStr(runId)} AND kind = 'response' GROUP BY line_no)`;
}

/** `usageSql`'s one row as totals. Exported for the tests' store, which builds the same row. */
export function usageOf(r: Record<string, unknown> | undefined): UsageTotals {
  const n = (k: string): number => Number(r?.[k] ?? 0) || 0;
  return {
    responses: n("n"),
    reported: n("reported"),
    input: n("input"),
    output: n("output"),
    cacheRead: n("crn") > 0 ? n("cache_read") : null,
    cacheWrite: n("cwn") > 0 ? n("cache_write") : null,
    usd: n("costed") > 0 ? n("usd") : null,
    costed: n("costed"),
  };
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
 * A pad header `padOfSection` could accept, as it sits in a raw line (RE2 and
 * JavaScript alike): no label, or a `padSizeLabel` one. Any other line that
 * starts like a header, such as the old cut's `[scratchpad truncated at N
 * chars]` marker that every pad of an older run ends with, can never be the
 * section's, so the server's cut skips it.
 */
export const PAD_HEADER_PATTERN = String.raw`\\n\\n\[scratchpad(?: [0-9]+\.[0-9]k/[0-9]+k(?:, over the cap)?)?\]\\n`;

/**
 * One page of a run's lines. Both tables share the file's line numbers, each
 * line in exactly one, so a range of numbers is a range of the file and the
 * primary key (run_id, line_no) prunes it. The server withholds every line a
 * view would not parse, and cuts out the pieces it would: a request's line
 * from its last pad header (`PAD_HEADER_PATTERN`) to its end, with how many
 * such headers it holds, and the text around a result's refusal. The cut's
 * start is `length − p − m + 2`, p the header's position in the reversed line
 * and m its length; a header is ASCII, so the cut never splits a character.
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
    const headers = `extractAll(raw, ${sqlStr(PAD_HEADER_PATTERN)})`;
    const last = `arrayElement(${headers}, -1)`;
    const pads = spec.pads === true && turns;
    const pad = pads ? `if(kind = 'request' AND length(${headers}) > 0, substring(raw, length(raw) - position(reverse(raw), reverse(${last})) - length(${last}) + 2), '')` : "''";
    const padCount = pads ? `if(kind = 'request', length(${headers}), 0)` : "0";
    const refusal = `positionUTF8(raw, ${sqlStr(PAD_REFUSED)})`;
    const near =
      spec.refusals === true && turns
        ? `if(kind IN ('snippet_result', 'tool_result') AND ${refusal} > 0, substringUTF8(raw, toUInt64(greatest(1, toInt64(${refusal}) - 48)), ${48 + PAD_REFUSED.length + 24}), '')`
        : "''";
    branches.push(
      `SELECT line_no AS l, ts, kind AS k, length(raw) AS b, ${turns ? "tool_name" : "''"} AS n, ${turns ? "is_error" : "CAST(NULL AS Nullable(UInt8))"} AS e, ` +
        `${raw} AS r, ${head} AS h, ${pad} AS p, toUInt32(${padCount}) AS pn, ${near} AS q FROM ${turns ? "turns" : "events"} WHERE ${where.join(" AND ")}`,
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

/** Half the server profile's per-query cap (infra/clickhouse/users.d/wrathbench-profile.xml): inspect is never the biggest query on the server. */
export const CLICKHOUSE_QUERY_MEMORY = 256 << 20;

/**
 * Every query's settings. `readonly=2` refuses a write whatever the user may
 * do, and still lets these settings be set. `log_comment` names the reader in
 * `system.query_log`, which is where a memory incident is traced first
 * (docs/RUNBOOK.md). A page's lines are megabytes apiece where it holds
 * requests, and every cut of one is a copy, so blocks are kept to a few
 * hundred rows: at the default a page of pad cuts reached 380 MiB.
 */
export const CLICKHOUSE_SETTINGS: Readonly<Record<string, string>> = {
  default_format: "JSON",
  // Without it ClickHouse quotes every Int64, and every clock here arrives as a string.
  output_format_json_quote_64bit_integers: "0",
  readonly: "2",
  max_execution_time: String(CLICKHOUSE_QUERY_SECONDS),
  max_memory_usage: String(CLICKHOUSE_QUERY_MEMORY),
  max_block_size: "512",
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
    async samples(id, since, until) {
      return rows(
        `SELECT ts, level, xp, money, quests_completed, map, x, y, z, items FROM states FINAL WHERE run_id = ${sqlStr(id)} AND ts >= ${Math.floor(since)} AND ts <= ${Math.floor(until)} ORDER BY ts, seq`,
      );
    },
    async sampleBefore(id, ts) {
      const r = await rows<Record<string, unknown>>(
        `SELECT ts, level, xp, money, quests_completed, map, x, y, z, items FROM states FINAL WHERE run_id = ${sqlStr(id)} AND ts < ${Math.floor(ts)} ORDER BY ts DESC, seq DESC LIMIT 1`,
      );
      return r[0] ?? null;
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
      // A few at a time and never aggregated: each is a whole request line.
      for (let i = 0; i < lines.length; i += RAWS_PER_QUERY) {
        const some = lines.slice(i, i + RAWS_PER_QUERY).map((l) => Math.trunc(l));
        for (const r of await rows<{ l: number; r: string }>(`SELECT line_no AS l, raw AS r FROM turns WHERE run_id = ${sqlStr(id)} AND line_no IN (${some.join(", ")})`)) out.set(r.l, r.r);
      }
      return out;
    },
    async usage(id) {
      return usageOf((await rows<Record<string, unknown>>(usageSql(id)))[0]);
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
    contains: (literal) => (raw === null ? null : raw.includes(literal)),
  };
}

/** Whole request lines a store read may fetch again before it stops and says so; and how many go in one query. */
export const PAD_REREADS = 32;
const RAWS_PER_QUERY = 8;

/** A store read's whole-line re-reads: how many are left, and how many requests went without one. */
export interface Rereads {
  left: number;
  skipped: number;
}

/**
 * One page as records, oldest first: deduplicated by line, and each request's
 * pad placed. When the cut from the last pad header does not parse and the
 * line holds an earlier header, the section may be that one (a pad that quotes
 * a header of its own), so the line is read again whole, as the file's reader
 * reads it; at most `PAD_REREADS` of them, after which a pad is counted as
 * skipped rather than fetched.
 */
async function storeRecs(store: InspectStore, runId: string, spec: ReadSpec, rows: readonly StoreRow[], rereads: Rereads): Promise<Rec[]> {
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
      if (pad !== null) pads.set(r.l, pad);
      else if (r.pn > 1 && rereads.left > again.length) again.push(r.l);
      else if (r.pn > 1) rereads.skipped++;
    }
    rereads.left -= again.length;
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
async function storeRead(
  store: InspectStore,
  runId: string,
  spec: ReadSpec,
  w: Window,
  bounds: { lo: number; hi: number } | null,
  forward: boolean,
  fn: RecFn,
  rereads: Rereads = { left: PAD_REREADS, skipped: 0 },
): Promise<void> {
  if (bounds === null) return;
  let lo = bounds.lo;
  let hi = bounds.hi + 1;
  for (let size = FIRST_PAGE_LINES; lo < hi; size = Math.min(MAX_PAGE_LINES, size * 2)) {
    const a = forward ? lo : Math.max(lo, hi - size);
    const b = forward ? Math.min(hi, lo + size) : hi;
    const recs = await storeRecs(store, runId, spec, await store.rows(runId, spec, w, a, b), rereads);
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

/** The v1 session record's directory in a run directory, or null on a 0.5 run (`runner/src/session-record.ts`). */
function sessionDir(dir: string): string | null {
  const session = join(dir, "session");
  return existsSync(join(session, "session.json")) ? session : null;
}

/** One stream of a session record, by its files alone: how many segments, how big, and how long since the newest was written. */
function streamLine(session: string, stream: string, now: number): string {
  let names: string[];
  try {
    names = readdirSync(join(session, stream)).filter((n) => /\.jsonl(\.zst)?$/.test(n));
  } catch {
    return `${stream} none`;
  }
  let bytes = 0;
  let newest = 0;
  for (const n of names) {
    try {
      const st = statSync(join(session, stream, n));
      bytes += st.size;
      newest = Math.max(newest, st.mtimeMs);
    } catch {
      /* compressed or unlinked as it was listed */
    }
  }
  return names.length === 0 ? `${stream} none` : `${stream} ${names.length} segment(s) ${fmtBytes(bytes)}, newest written ${fmtAge(now - newest)} ago`;
}

/**
 * The session record's line for a v1 run: its format, who it is, whether it
 * closed, and its captured streams. Never the session id: it is the token's
 * fingerprint and the module audit file's name, which no view prints
 * (skill `fleet-readonly`).
 */
export function sessionLine(session: string, now: number): string {
  let head = "unreadable session.json";
  try {
    const s = JSON.parse(readFileSync(join(session, "session.json"), "utf8")) as { format?: unknown; ended?: unknown; character?: { name?: unknown } | null };
    const who = typeof s.character?.name === "string" ? s.character.name : "no character yet";
    head = `${typeof s.format === "string" ? s.format : "unknown format"} (${who}), ${typeof s.ended === "number" ? `closed ${fmtAge(now - s.ended)} ago` : "open"}`;
  } catch {
    /* said above */
  }
  return `${head} · ${["trace", "events", "calls"].map((stream) => streamLine(session, stream, now)).join(" · ")}`;
}

function nearbyLine(dir: string, now: number): string {
  // A v1 run's ring is a stream of its session record; a 0.5 run's was `nearby/` in the run directory.
  return ringLine(sessionDir(dir) !== null ? join(dir, "session", "nearby") : join(dir, "nearby"), now);
}

/** The nearby ring's files, by their sizes and times alone. */
function ringLine(ring: string, now: number): string {
  let names: string[];
  try {
    names = readdirSync(ring);
  } catch {
    return "none (no ring: not live, or a run from before it)";
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
 * A 0.5 run's trace line (a v1 run's trace is in its session record,
 * `sessionLine`). The collector does not hold the trace (collector/README.md,
 * "Not tailed, on purpose"), so it is read here, and only ever by rowid: the
 * newest row and the highest rowid are each one index lookup, which is all a
 * live run gets. A run with no live owner also gets its rows by kind, walked
 * in windows.
 */
function traceLine(db: Database, now: number, live: boolean): string {
  if (!hasTable(db, "trace")) return "none (no session record, and no 0.5 trace table)";
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

// ------------------------------------------------------------------ a v1 run's files

/**
 * A v1 run (`session/session.json`) has no run.sqlite: its row is meta.json's
 * (runner/src/run-reader.ts, `runRowOfMeta`) and its readings are its session
 * record's (wrath-mcp/docs/SESSION-FORMAT.md). Neither is a database, so a
 * fallback reads them whether or not the run has a live owner: a reader
 * cannot hold a file a writer renames into place or appends to.
 */
function isV1Dir(dir: string): boolean {
  return existsSync(join(dir, "session", "session.json"));
}

/**
 * A v1 run's row: meta.json's. A first-build v1 run also has a run.sqlite its
 * own builds wrote a verdict into; a termination there that meta.json lacks
 * is taken from it, as runner/src/run-reader.ts does, and only when no live
 * owner could be writing it.
 */
function v1Row(dir: string, runId: string, meta: Record<string, unknown> | null, owned: boolean): RunRow | null {
  const row = metaRow(meta);
  if (row === null || row.termination_reason !== null || owned) return row;
  const db = openDb(dir);
  if (db === null) return row;
  try {
    const old = readRow(db, runId);
    if (old?.termination_reason == null) return row;
    return { ...row, termination_reason: old.termination_reason, termination_detail: old.termination_detail, ended_at: old.ended_at, pause_reason: null };
  } catch {
    return row;
  } finally {
    db.close();
  }
}

/** The run row meta.json holds (`RunVerdictFields` in runner/src/trajectory.ts). */
export function metaRow(meta: Record<string, unknown> | null): RunRow | null {
  if (meta === null) return null;
  const config = obj(meta["config"]);
  const termination = obj(meta["termination"]);
  return runRowOf({
    termination_reason: termination["reason"],
    termination_detail: termination["detail"],
    pause_reason: meta["pauseReason"],
    started_at: meta["startedAt"],
    ended_at: meta["endedAt"],
    model: config["model"],
    driver: config["driver"],
    character: config["character"],
    harness_version: meta["harnessVersion"],
  });
}

/** A segment's lines, plain or zstd, as text; the last line when it has no newline is left off. */
function segmentText(path: string): string {
  const bytes = readFileSync(path);
  const plain = path.endsWith(".zst") ? Bun.zstdDecompressSync(bytes) : bytes;
  const text = new TextDecoder().decode(plain);
  const end = text.lastIndexOf("\n");
  return end < 0 ? "" : text.slice(0, end);
}

/** A stream's segment files, oldest first, each once (the compressed one when both are there). */
function segmentFiles(session: string, stream: string): string[] {
  let names: string[];
  try {
    names = readdirSync(join(session, stream));
  } catch {
    return [];
  }
  const byStem = new Map<string, string>();
  for (const n of names) {
    const m = /^(\d{13}(?:-\d+)?)\.jsonl(\.zst)?$/.exec(n);
    if (m === null) continue;
    if (m[2] !== undefined || !byStem.has(m[1]!)) byStem.set(m[1]!, n);
  }
  return [...byStem.keys()].sort().map((stem) => join(session, stream, byStem.get(stem)!));
}

/**
 * The newest reading a v1 run's trace holds: its newest segment folded from
 * its last `key` row (a key states everything whole, so no earlier segment is
 * read). `turn` is not on the record; it is the trajectory's.
 */
export function traceLatest(session: string): StateRow | null {
  const files = segmentFiles(session, "trace");
  for (let i = files.length - 1; i >= 0; i--) {
    let rows: Record<string, unknown>[];
    try {
      rows = segmentText(files[i]!).split("\n").flatMap((l) => {
        try {
          return [JSON.parse(l) as Record<string, unknown>];
        } catch {
          return [];
        }
      });
    } catch {
      continue;
    }
    let from = -1;
    for (let j = rows.length - 1; j >= 0; j--) if (rows[j]!["kind"] === "key") {
      from = j;
      break;
    }
    if (from < 0) continue;
    const fold: Record<string, unknown> = { ...obj(rows[from]!["data"]) };
    let ts = typeof rows[from]!["ts"] === "number" ? (rows[from]!["ts"] as number) : 0;
    for (const r of rows.slice(from + 1)) {
      if (typeof r["ts"] === "number") ts = r["ts"];
      if (r["kind"] === "state") Object.assign(fold, obj(r["data"]));
    }
    const n = (k: string): number | null => (typeof fold[k] === "number" ? (fold[k] as number) : null);
    return { ts, level: n("level"), xp: n("xp"), money: n("money"), quests_completed: null, turn: null, zone: n("zone"), next_level_xp: n("xpMax") };
  }
  return null;
}

/**
 * A v1 run's turn-ins, off its `events` stream's `quest` rows: one stretch,
 * the run's own count. A record with a trace reading and no turn-in reads 0,
 * as the samples the collector folds from that trace do.
 */
export function eventQuests(session: string, latest: StateRow | null = null): { ts: number; quests: number | null }[] {
  const out: { ts: number; quests: number | null }[] = latest === null ? [] : [{ ts: latest.ts, quests: 0 }];
  let n = 0;
  for (const f of segmentFiles(session, "events")) {
    let text: string;
    try {
      text = segmentText(f);
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.includes('"kind":"quest"')) continue;
      try {
        const r = JSON.parse(line) as { ts?: unknown; kind?: unknown };
        if (r.kind === "quest" && typeof r.ts === "number") out.push({ ts: r.ts, quests: ++n });
      } catch {
        /* a torn line */
      }
    }
  }
  return out;
}

/**
 * A v1 run's trace folded into samples over a window, off its files: a sample
 * at every row that changes the level, XP, money, map, the turn-ins or what is
 * carried, at every key row, and once a minute while only the position moves
 * (runner/src/trace-samples.ts is the full derivation; this is the part
 * `stuck` reads, kept here because this file imports nothing). Items are
 * keyed by id and count, which is all `itemsKey` compares. The newest sample
 * before the window comes first when there is one: the trace writes a change
 * and nothing between, so it is the reading the window starts from.
 */
export function traceSamples(session: string, w: { since: number; until: number }): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const fold: Record<string, unknown> = {};
  let pos: { map: unknown; x: unknown; y: unknown; z: unknown } = { map: null, x: null, y: null, z: null };
  let quests = 0;
  let last = "";
  let lastPos = "";
  let lastAt = -Infinity;
  const inv = new Map<string, number[]>();
  const equip = new Map<number, number[]>();
  let before: Record<string, unknown> | null = null;
  for (const f of segmentFiles(session, "trace")) {
    let text: string;
    try {
      text = segmentText(f);
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      let r: Record<string, unknown>;
      try {
        r = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const ts = typeof r["ts"] === "number" ? r["ts"] : null;
      if (ts === null) continue;
      if (ts > w.until) return out.length === 0 && before !== null ? [before] : out;
      const d = obj(r["data"]);
      if (typeof r["map"] === "number") pos = { map: r["map"], x: r["x"], y: r["y"], z: r["z"] };
      if (r["kind"] === "key") {
        for (const k of Object.keys(fold)) delete fold[k];
        Object.assign(fold, d);
        inv.clear();
        equip.clear();
      } else if (r["kind"] === "state") Object.assign(fold, d);
      if (r["kind"] === "key" || r["kind"] === "state") {
        if (Array.isArray(d["qdone"])) quests += d["qdone"].length;
        for (const row of (Array.isArray(d["inv"]) ? d["inv"] : []) as number[][]) {
          if (row.length <= 2) inv.delete(`${row[0]}:${row[1]}`);
          else inv.set(`${row[0]}:${row[1]}`, row);
        }
        for (const row of (Array.isArray(d["equip"]) ? d["equip"] : []) as number[][]) {
          if (row.length <= 1) equip.delete(row[0]!);
          else equip.set(row[0]!, row);
        }
      }
      const items = [...[...equip.values()].map((e) => ({ itemId: e[1], count: 1, equipped: true })), ...[...inv.values()].map((e) => ({ itemId: e[2], count: e[3] ?? 1 }))];
      const sample = { ts, level: fold["level"] ?? null, xp: fold["xp"] ?? null, money: fold["money"] ?? null, quests_completed: quests, ...pos, items };
      const key = JSON.stringify({ ...sample, ts: 0, x: 0, y: 0, z: 0 });
      const moved = JSON.stringify(pos) !== lastPos && ts - lastAt >= 60_000;
      if (key === last && !moved && r["kind"] !== "key") continue;
      last = key;
      lastPos = JSON.stringify(pos);
      lastAt = ts;
      if (ts < w.since) before = sample;
      else {
        if (before !== null && out.length === 0) out.push(before);
        out.push(sample);
      }
    }
  }
  return out.length === 0 && before !== null ? [before] : out;
}

/** A session segment's window: five minutes from the time its name starts with (wrath-mcp/docs/SESSION-FORMAT.md). */
const SEGMENT_MS = 5 * 60_000;

/** What a v1 run's record says about a window beside its trace: when its writer was writing, and the served batches that failed to decode. */
export interface RecordWrites {
  /**
   * The times the session's writer is known to have been running in the
   * window: every `calls` and `events` row (a tool call, the actions a
   * snippet or routine dispatched, a served batch, a game event) and
   * `live.json`'s heartbeat, which the writer rewrites on every tick.
   */
  writes: number[];
  /** Served batches (`calls` `events` rows) that carry a `schemaError`: what `events_served` records were. */
  schemaBatches: number;
}

/**
 * The writes of a v1 run's record in a window, off its files, other than its
 * trace's. A character standing still writes no trace rows (the trace is a
 * change and nothing between), so these are what say the record was being
 * written through a quiet stretch, and the silence is the character's. Only
 * the segments that can hold the window are read.
 */
export function recordWrites(session: string, w: { since: number; until: number }): RecordWrites {
  const out: RecordWrites = { writes: [], schemaBatches: 0 };
  const inWindow = (ts: unknown): ts is number => typeof ts === "number" && ts >= w.since && ts <= w.until;
  for (const stream of ["calls", "events"] as const) {
    for (const f of segmentFiles(session, stream)) {
      // A segment holds rows from before the time it is named for (a late row) but none from after its five minutes.
      const t0 = Number(/(\d{13})(?:-\d+)?\.jsonl/.exec(f)?.[1]);
      if (Number.isFinite(t0) && t0 + SEGMENT_MS < w.since) continue;
      let text: string;
      try {
        text = segmentText(f);
      } catch {
        continue;
      }
      for (const line of text.split("\n")) {
        // The writer puts `ts` first; a row that does not is parsed whole.
        const at = /^\{"ts":(\d+)[,}]/.exec(line);
        let ts: unknown = at === null ? null : Number(at[1]);
        if (at === null) {
          try {
            ts = (JSON.parse(line) as { ts?: unknown }).ts;
          } catch {
            continue;
          }
        }
        if (!inWindow(ts)) continue;
        out.writes.push(ts);
        if (stream === "calls" && line.includes('"kind":"events"') && line.includes(SCHEMA_ERROR_KEY)) out.schemaBatches++;
      }
    }
  }
  try {
    const live = JSON.parse(readFileSync(join(session, "live.json"), "utf8")) as { ts?: unknown };
    if (inWindow(live.ts)) out.writes.push(live.ts);
  } catch {
    /* no heartbeat yet, or one being renamed into place */
  }
  return out;
}

// ------------------------------------------------------------------ a fan-out run's records

/** Where a fan-out run keeps its records, one per character (runner/src/run-reader.ts `SESSIONS_DIR`). */
export const SESSIONS_DIR = "sessions";
/** A fan-out character's directory name: the name as the server spells it, letters only (`isFanoutCharacterName`). */
const CHARACTER_NAME = /^[A-Za-z]+$/;
/** What joins a fan-out run's id to a character's name in the store's key (runner/src/run-reader.ts `FANOUT_SEP`). */
export const FANOUT_SEP = "~";

/**
 * What a command's run argument names: a run id, or a fan-out character's
 * session id (`<run-id>~<Name>`, the viewer's and the store's key for it:
 * runner/src/run-reader.ts `parseFanoutSessionId`) as its run and character.
 * Null when it is neither.
 */
export function parseRunArg(arg: string): { runId: string; character: string | null } | null {
  const at = arg.indexOf(FANOUT_SEP);
  if (at < 0) return isValidRunId(arg) ? { runId: arg, character: null } : null;
  const runId = arg.slice(0, at);
  const character = arg.slice(at + FANOUT_SEP.length);
  return isValidRunId(runId) && CHARACTER_NAME.test(character) ? { runId, character } : null;
}

/**
 * A fan-out run: one agent driving several characters, each with its own
 * session record in `sessions/<Character>/` and no `session/`. Its meta.json's
 * `config.fanout` says so from the launch, `sessions/` for a run whose
 * meta.json cannot be read: runner/src/run-reader.ts `isFanoutRunDir`.
 */
export function isFanoutDir(dir: string, meta: Record<string, unknown> | null = readMeta(dir)): boolean {
  if (isV1Dir(dir)) return false;
  const fanout = obj(meta?.["config"])["fanout"];
  if (typeof fanout === "object" && fanout !== null) return true;
  try {
    return statSync(join(dir, SESSIONS_DIR)).isDirectory();
  } catch {
    return false;
  }
}

/** A fan-out run's characters with a record, in name order (`fanoutCharacters`); empty for any other run. */
export function fanoutCharacters(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(join(dir, SESSIONS_DIR));
  } catch {
    return [];
  }
  return names.filter((n) => CHARACTER_NAME.test(n) && existsSync(join(dir, SESSIONS_DIR, n, "session.json"))).sort();
}

/** One session record of a run: the character it is (null when its session.json names none yet), and its directory. */
export interface SessionRef {
  character: string | null;
  session: string;
}

/** A run's session records: a v1 run's one, a fan-out run's each, in name order; none on a 0.5 run. */
export function sessionsOf(dir: string): SessionRef[] {
  const single = sessionDir(dir);
  if (single !== null) {
    let character: string | null = null;
    try {
      const s = JSON.parse(readFileSync(join(single, "session.json"), "utf8")) as { character?: { name?: unknown } | null };
      character = str(s.character?.name);
    } catch {
      /* unreadable: no name */
    }
    return [{ character, session: single }];
  }
  return fanoutCharacters(dir).map((c) => ({ character: c, session: join(dir, SESSIONS_DIR, c) }));
}

/** How far before its segment's start a row may be (a late row, by the writer's drain interval; SESSION-FORMAT.md, "Segments"). */
const SEGMENT_SLACK_MS = 60_000;

/** Whether a segment can hold a row of the window: its five minutes, and the late rows before them. */
function segmentInWindow(path: string, w: Window): boolean {
  const t0 = Number(/(\d{13})(?:-\d+)?\.jsonl/.exec(path)?.[1]);
  if (!Number.isFinite(t0)) return true;
  if (w.since !== null && t0 + SEGMENT_MS < w.since) return false;
  return !(w.until !== null && t0 - SEGMENT_SLACK_MS > w.until);
}

/** One row of a session stream: its clock, its kind, the row and the line it was read from. */
export interface StreamRow {
  ts: number;
  kind: string;
  row: Record<string, unknown>;
  line: string;
}

/**
 * The rows of one stream of a session record in a window, in time order (the
 * `events` and `calls` streams are in written order, each row at its own
 * instant, so they are sorted here). Only the segments that can hold the
 * window are read. With `limit`, the newest N that `keep` keeps (or with
 * `forward` the oldest N), read from that end a segment at a time, and one
 * segment past the Nth row for the late rows a segment can hold.
 */
export function streamRows(
  session: string,
  stream: string,
  w: Window,
  keep: (r: StreamRow) => boolean = () => true,
  limit: { n: number; forward: boolean } | null = null,
): StreamRow[] {
  const files = segmentFiles(session, stream).filter((f) => segmentInWindow(f, w));
  if (limit !== null && !limit.forward) files.reverse();
  const out: StreamRow[] = [];
  let past = false;
  for (const f of files) {
    let text: string;
    try {
      text = segmentText(f);
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      let row: Record<string, unknown>;
      try {
        row = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const ts = row["ts"];
      if (typeof ts !== "number" || typeof row["kind"] !== "string") continue;
      if ((w.since !== null && ts < w.since) || (w.until !== null && ts > w.until)) continue;
      const r: StreamRow = { ts, kind: row["kind"], row, line };
      if (keep(r)) out.push(r);
    }
    if (limit !== null && out.length >= limit.n) {
      if (past) break;
      past = true;
    }
  }
  out.sort((a, b) => a.ts - b.ts);
  if (limit === null) return out;
  return limit.forward ? out.slice(0, limit.n) : out.slice(-limit.n);
}

/**
 * The `events` kinds that are a stream restating itself, never something that
 * happened: the whole state, and the baselines a recorder states once
 * (SESSION-FORMAT.md, `events`). A zone, area or level row with no `from` is
 * a first reading, and not a mark either.
 */
const BASELINE_EVENTS: ReadonlySet<string> = new Set(["key", "achievements_at_login", "spells_at_login"]);

/** Whether an `events` row is something that happened: what the 0.5 trajectory's `milestone` and `quest_complete` records were. */
export function isEventMark(row: Record<string, unknown>): boolean {
  const kind = row["kind"];
  if (typeof kind !== "string" || BASELINE_EVENTS.has(kind)) return false;
  return !((kind === "zone" || kind === "area" || kind === "level") && row["from"] === undefined);
}

/**
 * A session's `events` marks over a window, by kind, the most first: deaths,
 * levels gained (with the levels they went between), zone and area changes,
 * turn-ins, achievements and the rest. On a v1 run these are what the 0.5
 * trajectory carried as `milestone` and `quest_complete` records. Empty when
 * nothing happened.
 */
export function eventMarks(session: string, w: Window): string {
  const counts = new Map<string, number>();
  let from: number | null = null;
  let to: number | null = null;
  for (const r of streamRows(session, "events", w, (r) => isEventMark(r.row))) {
    count(counts, r.kind);
    if (r.kind !== "level") continue;
    if (from === null && typeof r.row["from"] === "number") from = r.row["from"];
    if (typeof r.row["to"] === "number") to = r.row["to"];
  }
  const sorted = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return sorted.map(([k, n]) => (k === "level" && from !== null && to !== null ? `level ${n} (L${from}→L${to})` : `${k} ${n}`)).join(", ");
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

/**
 * A reading's xp, or 0 where the reading shows it is: a values update carries
 * only a create block's non-zero fields, so a character at exactly 0 xp has no
 * `xp` until its first gain, while the bar's length (`next_level_xp`, never 0
 * below the cap) arrived in the same block. Null when neither was read. For
 * the views' lines only: the samples, and what is derived from them, keep the
 * reading as recorded.
 */
export function xpOf(st: Pick<StateRow, "xp" | "next_level_xp"> | null | undefined): number | null {
  if (st === null || st === undefined) return null;
  return st.xp ?? (st.next_level_xp != null && st.next_level_xp > 0 ? 0 : null);
}

function levelLine(st: StateRow | null, now: number): string {
  if (st === null) return "no state sample yet";
  return [
    `L${st.level ?? "?"} ${xpOf(st) ?? "?"}xp${st.next_level_xp != null ? ` of ${st.next_level_xp}` : ""}`,
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

/**
 * One forward pass over the trajectory: counts by kind, errors by class,
 * harness notices by kind; and the run's cost, when `cost` is given, which
 * only a pass over the whole run may take.
 */
function scanActivity(path: string, window: Window, token: string | null, cost?: CostTally): Activity {
  const { since, until } = window;
  const a = newActivity();
  fileForward(
    path,
    (r) => {
      if (cost !== undefined) noteCost(cost, r);
      if (until !== null && r.ts > until) return cost === undefined;
      if (since !== null && !(r.ts >= since)) return;
      a.records++;
      count(a.kinds, r.t);
      if (Number.isFinite(r.ts) && (a.last === null || r.ts >= a.last.ts)) a.last = { ts: r.ts, t: r.t };
      noteActivity(a, r, token);
    },
    since === null || cost !== undefined ? 0 : seekTime(path, since),
  );
  return a;
}

// ------------------------------------------------------------------ what a run cost

/**
 * What a run's records say it cost: the usage its `response` records report,
 * summed, and the provider's own charge. That charge is in two shapes, read
 * as runner/viewer/tail.ts `reportedCostUsd` reads them: OpenRouter's per
 * response (`usage.cost`, summed), and the Claude Code CLI's per session
 * (`claude_result.costUsd`, cumulative, so a session's is its largest). No
 * price table is read for this line: the list-price figure is the viewer's
 * (runner/viewer/pricing.ts), and `requests` prices a window's tokens at the
 * model catalogue's row (`requestPrice`).
 */
export interface CostTally {
  usage: UsageTotals;
  /** The CLI's figure per session. */
  cli: Map<string, number>;
}

export function newCost(): CostTally {
  return { usage: { responses: 0, reported: 0, input: 0, output: 0, cacheRead: null, cacheWrite: null, usd: null, costed: 0 }, cli: new Map() };
}

function intOf(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null;
}

/** One response's usage, in the collector's field order (collector/src/lines.ts `usageOf`), so the store and the file agree. */
function noteUsage(t: UsageTotals, rec: Record<string, unknown> | null): void {
  t.responses++;
  const u = obj(rec?.["usage"]);
  const input = intOf(u["input_tokens"]) ?? intOf(u["prompt_tokens"]);
  const output = intOf(u["output_tokens"]) ?? intOf(u["completion_tokens"]);
  const read = intOf(u["cache_read_input_tokens"]) ?? intOf(obj(u["prompt_tokens_details"])["cached_tokens"]) ?? intOf(u["cached_tokens"]);
  const write = intOf(u["cache_write_tokens"]) ?? intOf(u["cache_creation_input_tokens"]);
  const usd = typeof u["cost"] === "number" && Number.isFinite(u["cost"]) ? u["cost"] : null;
  if (input !== null || output !== null) t.reported++;
  t.input += input ?? 0;
  t.output += output ?? 0;
  if (read !== null) t.cacheRead = (t.cacheRead ?? 0) + read;
  if (write !== null) t.cacheWrite = (t.cacheWrite ?? 0) + write;
  if (usd !== null) {
    t.usd = (t.usd ?? 0) + usd;
    t.costed++;
  }
}

/** A `claude_result`'s cumulative figure for its session: the largest one seen is the session's. */
function noteCli(cli: Map<string, number>, rec: Record<string, unknown> | null): void {
  const v = rec?.["costUsd"];
  if (typeof v !== "number" || !Number.isFinite(v)) return;
  const key = str(rec?.["sessionId"]) ?? "";
  cli.set(key, Math.max(cli.get(key) ?? v, v));
}

function noteCost(c: CostTally, r: Rec): void {
  if (r.t === "response") noteUsage(c.usage, r.parse());
  else if (r.t === "claude_result") noteCli(c.cli, r.parse());
}

/** A token count, short: 950, 12.3k, 4.56M. */
export function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function fmtUsd(usd: number): string {
  return `$${usd.toFixed(usd < 1 ? 4 : 2)}`;
}

/** The `cost` line: the provider's charge where it reported one, and the tokens its responses reported. */
export function costLine(c: CostTally): string {
  const u = c.usage;
  if (u.responses === 0 && c.cli.size === 0) return "no model response recorded";
  const cli = c.cli.size === 0 ? null : [...c.cli.values()].reduce((a, b) => a + b, 0);
  const charged: string[] = [];
  if (u.usd !== null) charged.push(`${fmtUsd(u.usd)} reported by the provider on ${u.costed} of ${u.responses} responses`);
  // The CLI's figure alone: the viewer adds the turns no result covered, at list (runner/viewer/pricing.ts `backfilled`).
  if (cli !== null) charged.push(`${fmtUsd(cli)} the CLI's total_cost_usd over ${c.cli.size} session(s), turns it never reported left out`);
  const total = u.usd !== null && cli !== null ? `${fmtUsd(u.usd + cli)}: ` : "";
  const usd = charged.length === 0 ? "no charge reported by the provider (the viewer prices the tokens at list)" : `${total}${charged.join(" + ")}`;
  const cache = [u.cacheRead !== null ? `cache read ${fmtTokens(u.cacheRead)}` : null, u.cacheWrite !== null ? `write ${fmtTokens(u.cacheWrite)}` : null].filter((b) => b !== null);
  // A claude-code response's output count is the turn's opening snapshot, far below what it produced (runner/viewer/tail.ts `tokenTotals`).
  const out = cli !== null ? `out ${fmtTokens(u.output)} (claude-code's opening snapshots, not its output: the viewer's figure is)` : `out ${fmtTokens(u.output)}`;
  const tokens =
    u.reported === 0
      ? `no tokens reported on ${u.responses} responses`
      : `tokens in ${fmtTokens(u.input)}${cache.length > 0 ? ` (${cache.join(", ")})` : ""}, ${out}, reported on ${u.reported} of ${u.responses} responses`;
  return `over the run: ${usd} · ${tokens}`;
}

/** The run's cost off the store: its usage aggregate, and its `claude_result` records when it has any. */
async function storeCost(store: InspectStore, runId: string): Promise<CostTally> {
  const c = newCost();
  c.usage = await store.usage(runId);
  const all = await store.extent(runId, { since: null, until: null });
  if ((all.kinds.get("claude_result") ?? 0) > 0) {
    await storeRead(store, runId, { kinds: { claude_result: { raw: "all" } } }, { since: null, until: null }, all.window, true, (r) => noteCli(c.cli, r.parse()));
  }
  return c;
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

/** The figures a fan-out run is summed up by: the character with the highest level, then the higher xp, then the first by name (`fanoutLead`). */
export function leadOf<T extends { character: string; level: number | null; xp: number | null }>(readings: readonly T[]): T | null {
  let lead: T | null = null;
  for (const r of readings) {
    if (r.level === null || r.level <= 0) continue;
    if (lead === null || r.level > lead.level! || (r.level === lead.level && (r.xp ?? -1) > (lead.xp ?? -1)) || (r.level === lead.level && r.xp === lead.xp && r.character < lead.character)) lead = r;
  }
  return lead;
}

/** The store's key for a fan-out character's rows (runner/src/run-reader.ts `fanoutSessionId`). */
function fanoutKey(runId: string, character: string): string {
  return `${runId}${FANOUT_SEP}${character}`;
}

/** Each fan-out character's newest reading and its quest samples: the store's under its key, else its record's. */
async function characterReadings(via: Via, runId: string, refs: readonly SessionRef[]): Promise<{ ref: SessionRef; character: string; st: StateRow | null; quests: { ts: number; quests: number | null }[] }[]> {
  const keys = refs.map((r) => fanoutKey(runId, r.character ?? "?"));
  const states = via.store !== null ? await via.store.latestStates(keys) : null;
  const out = [];
  for (const [i, ref] of refs.entries()) {
    const character = ref.character ?? "?";
    const st = states !== null ? (states.get(keys[i]!) ?? null) : traceLatest(ref.session);
    const quests = via.store !== null ? await via.store.quests(keys[i]!) : eventQuests(ref.session, st);
    out.push({ ref, character, st, quests });
  }
  return out;
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
    const v1 = isV1Dir(dir);
    const fanout = !v1 && isFanoutDir(dir, meta);
    const row: RunRow | null | undefined =
      via.store !== null ? via.run : v1 || fanout ? v1Row(dir, runId, meta, owned) : owned ? undefined : db === null ? null : readRow(db, runId);
    const verdict = verdictOf(row, heartbeat, opts.now);
    say("run", `${runId}${dir.includes(`/${ARCHIVE_DIR}/`) ? " (archived)" : ""}${fanout ? " (fan-out)" : ""}`);
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
    // A fan-out run's launch names one character, and no one character is the run.
    const refs = fanout ? sessionsOf(dir) : [];
    if (fanout) {
      const plan = obj(config["fanout"]);
      const of = typeof plan["characters"] === "number" ? ` of ${plan["characters"]}` : "";
      const accounts = Array.isArray(plan["accounts"]) ? plan["accounts"].filter((a): a is string => typeof a === "string") : [];
      const who = refs.length === 0 ? `none logged in yet${of}` : `${refs.length}${of} logged in: ${refs.map((r) => r.character).join(", ")}`;
      say("characters", `${who}${accounts.length > 0 ? ` · accounts ${accounts.join(", ")}` : ""}`);
    } else {
      const character = row?.character ?? str(config["character"]);
      const account = str(config["account"]);
      if (character !== null || account !== null) say("character", `${character ?? "?"}${account !== null ? ` on ${account}` : ""}`);
    }
    const started = row?.started_at ?? (typeof meta?.["startedAt"] === "number" ? (meta["startedAt"] as number) : null);
    say(
      "started",
      `${iso(started)}${started !== null ? ` (${fmtAge(opts.now - started)} ago)` : ""}${row?.ended_at != null ? ` · ended ${iso(row.ended_at)} (${fmtAge(opts.now - row.ended_at)} ago)` : ""}`,
    );

    const characters = fanout ? await characterReadings(via, runId, refs) : [];
    if (fanout) {
      const lead = leadOf(characters.map((c) => ({ character: c.character, level: c.st?.level ?? null, xp: xpOf(c.st) })));
      say("level", `per character below${lead === null ? "; none has a level yet" : `; the lead is ${lead.character}, L${lead.level} ${lead.xp ?? "?"}xp`}`);
    } else if (via.store !== null) {
      say("level", levelLine((await via.store.latestStates([runId])).get(runId) ?? null, opts.now));
      // The newest sample's count is its process's, so the run's is its own line.
      const quests = questLine(await via.store.quests(runId));
      if (quests !== null) say("quests", quests);
    } else if (v1) {
      const latest = traceLatest(join(dir, "session"));
      say("level", levelLine(latest, opts.now));
      const quests = questLine(eventQuests(join(dir, "session"), latest));
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
      // The cost is the whole run's whatever the window: one pass with the activity when it is the whole run too.
      const whole = opts.since === null && opts.until === null;
      const cost = via.store !== null ? null : newCost();
      const a = via.store !== null ? await storeActivity(via.store, runId, via.ext, opts, token) : scanActivity(traj, opts, token, whole ? cost! : undefined);
      if (cost !== null && !whole) fileForward(traj, (r) => noteCost(cost, r));
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
      // A v1 run's milestones and turn-ins are its record's `events` rows, not trajectory records; a fan-out run's are each character's, below.
      const marks = [["pause", "resume", "termination", "quest_complete", "milestone"].filter((t) => k(t) > 0).map((t) => `${t} ${k(t)}`).join(", "), v1 ? eventMarks(join(dir, "session"), opts) : ""];
      if (marks.some((m) => m !== "")) say("marks", marks.filter((m) => m !== "").join(" · "));
      say("cost", costLine(cost ?? (await storeCost(via.store!, runId))));
    }
    say("files", fileLine(dir));
    const session = sessionDir(dir);
    if (session !== null) say("session", sessionLine(session, opts.now));
    else if (fanout) say("sessions", `${refs.length} character record(s) under ${SESSIONS_DIR}/`);
    else say("trace", db === null ? "no run.sqlite" : traceLine(db, opts.now, owned));
    if (!fanout) say("nearby", nearbyLine(dir, opts.now));
    for (const c of characters) {
      say(c.character, levelLine(c.st, opts.now));
      const quests = questLine(c.quests);
      if (quests !== null) say("  quests", quests);
      const marks = eventMarks(c.ref.session, opts);
      if (marks !== "") say("  marks", marks);
      say("  session", sessionLine(c.ref.session, opts.now));
      say("  nearby", ringLine(join(c.ref.session, "nearby"), opts.now));
    }
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
    const meta = isV1Dir(f.dir) ? null : readMeta(f.dir);
    if (isFanoutDir(f.dir, meta)) {
      // One line for the run, its lead's level on it, and a line per character under it.
      row = rows !== null && rows.has(f.id) ? rows.get(f.id)! : v1Row(f.dir, f.id, meta, ownedAt(f.hb, opts.now));
      const refs = sessionsOf(f.dir);
      let byKey = new Map<string, StateRow>();
      if (rows !== null && rows.has(f.id) && opts.store !== null) {
        try {
          byKey = await opts.store.latestStates(refs.map((r) => fanoutKey(f.id, r.character ?? "?")));
        } catch {
          byKey = new Map();
        }
      }
      const readings = refs.map((r) => {
        const s = rows !== null && rows.has(f.id) ? (byKey.get(fanoutKey(f.id, r.character ?? "?")) ?? null) : traceLatest(r.session);
        return { character: r.character ?? "?", level: s?.level ?? null, xp: xpOf(s), ts: s?.ts ?? null };
      });
      const lead = leadOf(readings);
      const v = verdictOf(row, f.hb, opts.now);
      const level = lead === null ? "L?" : `L${lead.level} ${lead.xp ?? "?"}xp (${lead.character})`;
      const age = row?.started_at != null ? `up ${fmtAge(opts.now - row.started_at)}` : "";
      const reason = v.reason !== null ? ` ${v.reason}` : "";
      const missing = rows !== null && !rows.has(f.id) ? "  (not in ClickHouse yet)" : "";
      out(cap(`  ${f.id}  ${v.state}${reason}  hb ${fmtAge(opts.now - f.hb)}  ${level}  ${age}  ${row?.model ?? ""}  fan-out, ${refs.length} character(s)${missing}`, opts.width));
      for (const r of readings) out(cap(`      ${r.character}  L${r.level ?? "?"} ${r.xp ?? "?"}xp${r.ts !== null ? `  sampled ${fmtAge(opts.now - r.ts)} ago` : ""}`, opts.width));
      continue;
    }
    if (rows !== null && rows.has(f.id)) {
      row = rows.get(f.id)!;
      st = states.get(f.id) ?? null;
    } else if (isV1Dir(f.dir)) {
      row = v1Row(f.dir, f.id, readMeta(f.dir), ownedAt(f.hb, opts.now));
      st = traceLatest(join(f.dir, "session"));
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
    const level = st === null ? "L?" : `L${st.level ?? "?"} ${xpOf(st) ?? "?"}xp`;
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

/** How long one value of a record's line runs before it is cut; the line itself is still held to `--width`. */
const VALUE_CHARS = 80;
/**
 * The values that say what went wrong, and a wake's block: a routine's thrown
 * text, a program error's frames, a hint. Cut at 80 they lost the message
 * itself (`TypeError: turnInQ…`), so they run to this many, `--width` allowing.
 */
const LONG_VALUE_CHARS = 2_000;
const LONG_VALUE_KEYS: ReadonlySet<string> = new Set(["error", "frames", "hint", "reason", "block", "detail", "note"]);

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
    const most = LONG_VALUE_KEYS.has(k) ? LONG_VALUE_CHARS : VALUE_CHARS;
    shown[k] = s === undefined ? v : s.length > most ? `${s.slice(0, most - 1)}…` : typeof v === "string" ? s : s === raw ? v : s;
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

async function storePad(store: InspectStore, runId: string, ext: Extent, w: Window, rereads: Rereads): Promise<PadScan> {
  const r = padReducer(w);
  await storeRead(store, runId, PAD_SPEC, w, ext.window, true, r.fn, rereads);
  r.p.toolCalls = ext.kinds.get("tool_call") ?? 0;
  ({ first: r.p.first, last: r.p.last } = spanFrom(ext));
  return r.p;
}

const PAD_BUCKETS = 24;

/** The line a store read prints when it stopped re-reading whole requests. */
function unplaced(n: number): string {
  return `uncertain ${n} request(s) hold more than one pad header and were not read again whole past the first ${PAD_REREADS}, so their pad is missing here; --files reads them`;
}

export async function inspectPad(runId: string, opts: Ctx & Window & { last: number }, out: Out): Promise<number> {
  const run = trajectoryOf(runId, opts, out);
  if (run === null) return 1;
  const via = await viaFor(opts, runId, run.dir, opts);
  const rereads: Rereads = { left: PAD_REREADS, skipped: 0 };
  const p = via.store !== null ? await storePad(via.store, runId, via.ext, opts, rereads) : scanPad(run.path, opts);
  const say = (text: string): void => out(cap(strike(text, run.token), opts.width));
  const span = p.first === null ? "no records" : `${clock(p.first)} to ${clock(p.last!)}`;
  say(`${runId}: the scratchpad, ${windowPhrase(opts) || "whole run"} (${span}), UTC`);
  say(`source    ${via.line}`);
  const driver = driverName(p.adapter, run.dir, runId, via, opts.now);
  const perRequest = p.requestsWithPad > 0 ? ` (${(p.toolCalls / p.requestsWithPad).toFixed(1)} per request)` : "";
  say(`sizes     driver ${driver} · the pad's text on ${p.requestsWithPad} of ${p.requests} request(s) · ${p.toolCalls} tool call(s)${perRequest}`);
  if (rereads.skipped > 0) say(unplaced(rereads.skipped));
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
  const rereads: Rereads = { left: PAD_REREADS, skipped: 0 };
  let p: PadAt | null;
  if (via.store !== null) {
    const r = padAtReducer(opts.at);
    await storeRead(via.store, runId, PAD_AT_SPEC, upTo, via.ext.window, false, r.fn, rereads);
    p = r.done();
  } else p = padAt(run.path, opts.at);
  if (p === null) {
    say(`${runId}: no request and no write_scratchpad at or before ${iso(opts.at)} records the pad`);
    if (rereads.skipped > 0) say(unplaced(rereads.skipped));
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
  if (rereads.skipped > 0) say(unplaced(rereads.skipped));
  say(`source    ${via.line}`);
  say("---");
  for (const line of p.text.split("\n")) say(line);
  return 0;
}

// ------------------------------------------------------------------ inspect stuck

/**
 * The stuck detector's thresholds, in one place: `inspect stuck` takes each as
 * a flag and `fleet status` uses them as they stand. Chosen to catch an agent
 * that keeps talking while its character goes nowhere (the case that prompted
 * it: two days, thousands of near-identical snippets, level, xp and position
 * unchanged) and to stay quiet through ordinary waiting: a flight moves, a
 * crafting or fishing session changes the bags, a vendor trip the money, an
 * xp-making sleep loop the xp. An e90 ends on its own `no-xp` watchdog (20
 * minutes) long before a two-hour window could trip.
 */
export const STUCK_DEFAULTS = {
  /** The trailing window the run is judged over. */
  windowMs: 2 * 3_600_000,
  /** Further than this from the window's first position, in yards, is movement, and movement is progress. */
  moveYards: 50,
  /** A gap between state samples (or at either end of the window) longer than this leaves the window unjudged. */
  maxGapMs: 15 * 60_000,
  /** One identical error, digits aside, this many times in the window. */
  repeatErrors: 20,
  /**
   * One harness-delivered hint's (action, status) tallied this many times in
   * the window. High because a healthy run's tallies are in the thousands: a
   * fighting freeplay character's rotation logged castSpell not_ready about
   * 6,900 times in two hours, and a levelling e360 moveTo target_off_mesh 141.
   * So it marks only a flood; the tallies print whatever it says.
   */
  hintTally: 10_000,
  /** `events_served` records carrying a `schemaError`. */
  schemaErrors: 10,
  /** `sandbox_restarted` notices. */
  restarts: 3,
  /** Responses the heuristic reads as addressed to the operator. */
  asks: 2,
} as const;

export type StuckThresholds = { -readonly [K in keyof typeof STUCK_DEFAULTS]: number };

/** One state sample, as either the trajectory's `state` record or run.sqlite's `state` row holds it. */
export interface ProgressSample {
  ts: number;
  level: number | null;
  xp: number | null;
  money: number | null;
  quests: number | null;
  map: number | null;
  x: number | null;
  y: number | null;
  z: number | null;
  /** The bags and worn items as a sorted `item:count` list; null when the sample has none. */
  items: string | null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * The items of a sample as one comparable string: item id (else name), count
 * and whether worn, sorted. Crafting, looting, fishing, buying and equipping
 * all change it; a ghost pacing at a wall does not.
 */
export function itemsKey(items: unknown): string | null {
  if (!Array.isArray(items)) return null;
  return items
    .map((i) => {
      const o = obj(i);
      return `${String(o["itemId"] ?? o["name"] ?? "?")}:${String(o["count"] ?? 1)}${o["equipped"] === true ? "w" : ""}`;
    })
    .sort()
    .join(",");
}

/** A sample from a trajectory `state` record (camelCase) or a run.sqlite `state` row (snake_case, items as JSON text). */
export function progressSampleOf(r: Record<string, unknown>, ts: number): ProgressSample {
  let items: unknown = r["items"];
  if (typeof items === "string") {
    try {
      items = JSON.parse(items) as unknown;
    } catch {
      items = null;
    }
  }
  return {
    ts,
    level: num(r["level"]),
    xp: num(r["xp"]),
    money: num(r["money"]),
    quests: num(r["questsCompleted"] ?? r["quests_completed"]),
    map: num(r["map"]),
    x: num(r["x"]),
    y: num(r["y"]),
    z: num(r["z"]),
    items: itemsKey(items),
  };
}

/** The last value of each progress field a sample carried: what the next sample is compared with. */
export interface ProgressCarry {
  lx: { level: number; xp: number } | null;
  q: number | null;
  m: number | null;
  it: string | null;
  mp: number | null;
}

export function newProgressCarry(): ProgressCarry {
  return { lx: null, q: null, m: null, it: null, mp: null };
}

/** What one sample changed against the carry: the progress rule `stuck` and `requests` share, movement aside. */
export interface ProgressStep {
  /** (level, xp) rose. */
  rose: boolean;
  /** Turn-ins added; a drop is a restart (the count is the process's own) and adds none. */
  quests: number;
  money: boolean;
  items: boolean;
  map: boolean;
}

/** One sample against the carry, which it then updates; a field the sample does not carry is unknown, never a change. Pure but for the carry. */
export function progressStep(c: ProgressCarry, x: ProgressSample): ProgressStep {
  const step: ProgressStep = { rose: false, quests: 0, money: false, items: false, map: false };
  if (x.level !== null && x.xp !== null) {
    if (c.lx !== null && (x.level > c.lx.level || (x.level === c.lx.level && x.xp > c.lx.xp))) step.rose = true;
    c.lx = { level: x.level, xp: x.xp };
  }
  if (x.quests !== null) {
    if (c.q !== null && x.quests > c.q) step.quests = x.quests - c.q;
    c.q = x.quests;
  }
  if (x.money !== null) {
    if (c.m !== null && x.money !== c.m) step.money = true;
    c.m = x.money;
  }
  if (x.items !== null) {
    if (c.it !== null && x.items !== c.it) step.items = true;
    c.it = x.items;
  }
  if (x.map !== null) {
    if (c.mp !== null && x.map !== c.mp) step.map = true;
    c.mp = x.map;
  }
  return step;
}

export interface ProgressVerdict {
  /** `stuck`: no progress of any kind over a window the record covers; `unjudged`: it does not cover it. */
  state: "stuck" | "progressing" | "unjudged";
  /** What changed, what held, or why the window cannot be judged. */
  evidence: string;
  samples: number;
}

/**
 * Whether the character made any progress over [since, until], from its state
 * samples. Progress is any of: (level, xp) rising, the quest count rising (a
 * drop is a restart, the count being the process's own), the money or the
 * items changing, the map changing, or the position straying more than
 * `moveYards` from where the window began. A field a sample did not carry is
 * unknown, never a change. The window must be covered, or the answer is
 * `unjudged`, since nothing recorded is not no progress. Pure.
 *
 * Covered means two things, by what the samples are. A 0.5 run sampled its
 * state every minute, so its samples must be at most `maxGapMs` apart and from
 * either end. A v1 run's samples are its trace's, which writes a change and
 * nothing between, so a character standing still has none for hours: given
 * `writes`, the times its record was being written (`recordWrites`), the
 * window is covered when those and the samples are that close, the newest
 * sample before the window is the reading it starts from, and a stretch with
 * no sample is a stretch in which nothing changed.
 */
export function progressVerdict(
  all: readonly ProgressSample[],
  w: { since: number; until: number },
  t: Pick<StuckThresholds, "moveYards" | "maxGapMs">,
  writes?: readonly number[],
): ProgressVerdict {
  const inside = all.filter((x) => x.ts >= w.since && x.ts <= w.until).sort((a, b) => a.ts - b.ts);
  // When the window's coverage was seen: the samples alone, or with the record's other writes.
  const seen = writes === undefined ? inside.map((x) => x.ts) : [...inside.map((x) => x.ts), ...writes.filter((ts) => ts >= w.since && ts <= w.until)].sort((a, b) => a - b);
  const what = writes === undefined ? "state samples" : "record writes";
  const k = seen.length;
  if (k < 2) return { state: "unjudged", evidence: writes === undefined ? `${k} state sample(s) in the window` : `${k} record write(s) in the window`, samples: inside.length };
  let gap = { ms: seen[0]! - w.since, at: w.since };
  for (let i = 1; i < k; i++) if (seen[i]! - seen[i - 1]! > gap.ms) gap = { ms: seen[i]! - seen[i - 1]!, at: seen[i - 1]! };
  if (w.until - seen[k - 1]! > gap.ms) gap = { ms: w.until - seen[k - 1]!, at: seen[k - 1]! };
  if (gap.ms > t.maxGapMs) {
    return {
      state: "unjudged",
      evidence: `${k} ${what}, but a ${fmtAge(gap.ms)} gap from ${iso(gap.at)} (over ${fmtAge(t.maxGapMs)}): a run younger than the window, a pause, or ${writes === undefined ? "samples" : "a record"} not being written`,
      samples: inside.length,
    };
  }
  let s = inside;
  if (writes !== undefined) {
    // The reading the window starts from: the newest sample before it, as of its start.
    const before = all.filter((x) => x.ts < w.since).reduce<ProgressSample | null>((a, x) => (a === null || x.ts >= a.ts ? x : a), null);
    if (before !== null) s = [{ ...before, ts: w.since }, ...inside];
    if (s.length === 0) return { state: "unjudged", evidence: `${k} record writes, but no trace reading in or before the window`, samples: 0 };
  }
  const n = s.length;
  const changes: string[] = [];
  const last = <K extends keyof ProgressSample>(k: K): ProgressSample[K] | null => {
    for (let i = n - 1; i >= 0; i--) if (s[i]![k] !== null) return s[i]![k];
    return null;
  };
  const first = <K extends keyof ProgressSample>(k: K): ProgressSample[K] | null => s.find((x) => x[k] !== null)?.[k] ?? null;
  // Each field compared with the last sample that carried it.
  let rose = false;
  let quests = 0;
  let money = false;
  let items = false;
  const maps = new Set<number>();
  let map = false;
  const carry = newProgressCarry();
  for (const x of s) {
    const step = progressStep(carry, x);
    rose ||= step.rose;
    quests += step.quests;
    money ||= step.money;
    items ||= step.items;
    map ||= step.map;
    if (x.map !== null) maps.add(x.map);
  }
  // How far the character strayed from the window's first position on that map.
  const origin = s.find((x) => x.map !== null && x.x !== null && x.y !== null && x.z !== null) ?? null;
  let stray = 0;
  if (origin !== null) {
    for (const x of s) {
      if (x.map !== origin.map || x.x === null || x.y === null || x.z === null) continue;
      stray = Math.max(stray, Math.hypot(x.x - origin.x!, x.y - origin.y!, x.z - origin.z!));
    }
  }
  const lvl = `L${first("level") ?? "?"} ${first("xp") ?? "?"}xp`;
  if (rose) changes.push(`${lvl} → L${last("level") ?? "?"} ${last("xp") ?? "?"}xp`);
  if (quests > 0) changes.push(`quests +${quests}`);
  if (money) changes.push(`money ${money2(first("money"))} → ${money2(last("money"))}`);
  if (items) changes.push("items changed");
  if (map) changes.push(`maps ${[...maps].join(", ")}`);
  if (stray > t.moveYards) changes.push(`moved ${Math.round(stray)} yd from where the window began`);
  const span =
    writes === undefined
      ? `${n} samples over ${fmtAge(s[n - 1]!.ts - s[0]!.ts)}, largest gap ${fmtAge(gap.ms)}`
      : `${inside.length} trace sample(s) and ${k - inside.length} other record write(s) in the window, largest gap ${fmtAge(gap.ms)}`;
  if (changes.length > 0) return { state: "progressing", evidence: `${changes.join(" · ")} · ${span}`, samples: n };
  const where = origin === null ? "position unknown" : `map ${origin.map}, within ${stray.toFixed(1)} yd of (${origin.x!.toFixed(0)}, ${origin.y!.toFixed(0)})`;
  const held = [`${lvl} throughout`, "quests +0", `money ${first("money") === null ? "unknown" : "unchanged"}`, `items ${first("items") === null ? "unknown" : "unchanged"}`, where];
  return { state: "stuck", evidence: `${held.join(" · ")} · ${span}`, samples: n };
}

function money2(copper: number | null): string {
  return money(copper) ?? "?";
}

/**
 * Assistant text that reads as addressed to whoever runs the harness: asking
 * for help, a reset, a teleport, a recovery mechanism, or reporting a bug. A
 * heuristic, labelled as one wherever it prints: a model narrating its plan can
 * match, and one asking in other words will not.
 */
export const OPERATOR_ASKS: readonly RegExp[] = [
  /\b(?:operators?|administrators?|admins?|game ?masters?|GMs?|developers?|maintainers?)\b[^.?!\n]{0,80}\b(?:help|reset|unstuck|unstick|teleport|intervene|intervention|assist|fix|recover|rescue|look into)/i,
  /\b(?:please|could you|can you|would you|i need you to)\b[^.?!\n]{0,60}\b(?:reset|teleport|unstick|resurrect|revive|move) (?:me|my character|the character)\b/i,
  /\b(?:bug report|report (?:this|a|the) bug|harness (?:bug|issue|problem)|server[- ]side (?:bug|issue|fix))\b/i,
  /\b(?:recovery mechanism|manual intervention|outside (?:help|intervention))\b/i,
  // What a stranded ghost said for two days: "awaiting resurrection or external unstuck".
  /\b(?:external|outside|manual)\b[^.?!\n]{0,40}\b(?:help|unstuck|unstick|intervention|rescue|recovery|fix)\b/i,
];

/** The harness-delivered hint block at a result's foot (`renderActionHints`, wrath-mcp/mcp/src/tools.ts). */
export const HINT_BLOCK_HEAD = "--- harness ---";
/**
 * One line of that block: `action status ×N (from an earlier snippet: label): hint`.
 * The action is an SDK name and the status a snake_case code, so a hint's own
 * text on a line of its own never reads as one; the label is the snippet's
 * code, parentheses and all, so it ends at the first `): `.
 */
export const HINT_LINE = /^([A-Za-z_$][\w$.]*) ([a-z][a-z0-9_]*)(?: ×(\d+))?(?: \(from an earlier snippet.*?\))?: /;
/** How a served event names a decode failure (EventSummary, runner/src/context.ts). */
export const SCHEMA_ERROR_KEY = '"schemaError"';

/** An error's signature: its first meaningful line, digits folded, so the same failure at another place or time counts as one. */
export function errorSignature(name: string, text: string): string {
  const lines = text.split("\n", 3);
  const body = (/^error \(\d+ms\)$/.test(lines[0] ?? "") ? lines[1] : lines[0]) ?? "";
  return `${name}: ${body.replace(/\d+(?:\.\d+)?/g, "#").slice(0, 120) || "(empty)"}`;
}

export interface StuckScan {
  samples: ProgressSample[];
  snippets: number;
  toolCalls: number;
  responses: number;
  errors: Map<string, number>;
  hints: Map<string, number>;
  schemaRecords: number;
  restarts: number[];
  asks: { ts: number; text: string }[];
}

/** The detector's reads over a window, record by record: the state samples, the activity, and every failure signal. */
function stuckReducer(w: Window): { a: StuckScan; fn: RecFn } {
  const a: StuckScan = { samples: [], snippets: 0, toolCalls: 0, responses: 0, errors: new Map(), hints: new Map(), schemaRecords: 0, restarts: [], asks: [] };
  const fn: RecFn = (r) => {
    if (Number.isFinite(r.ts)) {
      if (w.until !== null && r.ts > w.until) return true;
      if (w.since !== null && r.ts < w.since) return;
    }
    switch (r.t) {
      case "state": {
        const p = r.bytes < 1 << 20 ? r.parse() : null;
        if (p !== null) a.samples.push(progressSampleOf(p, r.ts));
        return;
      }
      case "snippet":
        a.snippets++;
        return;
      case "tool_call":
        if (r.name() !== "run_snippet") a.toolCalls++;
        return;
      case "snippet_result":
      case "tool_result": {
        if (r.bytes >= 256 << 10) return;
        const p = r.parse();
        if (p === null) return;
        const text = textOf(p["text"]);
        if (p["isError"] === true) count(a.errors, errorSignature(typeof p["name"] === "string" ? p["name"] : r.t === "snippet_result" ? "run_snippet" : "?", text));
        const at = text.lastIndexOf(`\n${HINT_BLOCK_HEAD}\n`);
        if (at < 0) return;
        for (const line of text.slice(at + HINT_BLOCK_HEAD.length + 2).split("\n")) {
          const m = HINT_LINE.exec(line);
          if (m !== null) count(a.hints, `${m[1]} ${m[2]}`, m[3] === undefined ? 1 : Number(m[3]));
        }
        return;
      }
      case "events_served":
        // The store sends only the rows that hold the key; the file's reader looks.
        if (r.contains(SCHEMA_ERROR_KEY) !== false) a.schemaRecords++;
        return;
      case "harness": {
        const p = r.bytes < 64 << 10 ? r.parse() : null;
        if (p?.["kind"] === "sandbox_restarted") a.restarts.push(r.ts);
        return;
      }
      case "response": {
        a.responses++;
        const p = r.bytes < 1 << 20 ? r.parse() : null;
        const content = obj(p?.["message"])["content"];
        if (typeof content !== "string") return;
        for (const re of OPERATOR_ASKS) {
          const m = re.exec(content);
          if (m === null) continue;
          a.asks.push({ ts: r.ts, text: content.slice(Math.max(0, m.index - 40), m.index + 160) });
          break;
        }
        return;
      }
    }
  };
  return { a, fn };
}

/** What the detector asks of the store: the state records whole, the results that failed or carry a hint block, and the rest counted. */
const STUCK_SPEC: ReadSpec = {
  kinds: {
    state: { raw: "all" },
    snippet: { raw: "none" },
    tool_call: { raw: "none" },
    snippet_result: { row: { error: true, contains: HINT_BLOCK_HEAD }, raw: "all" },
    tool_result: { row: { error: true, contains: HINT_BLOCK_HEAD }, raw: "all" },
    events_served: { row: { contains: SCHEMA_ERROR_KEY }, raw: "none" },
    harness: { raw: "all" },
    response: { raw: "all" },
  },
};

/** One signal's line: tripped or not, the count against its threshold, and what it saw. */
interface Signal {
  name: string;
  tripped: boolean;
  text: string;
}

export interface StuckReport {
  window: { since: number; until: number };
  progress: ProgressVerdict;
  scan: StuckScan;
  signals: Signal[];
}

/** Every signal over a scan, the progress verdict first: the only one that flags a run. Pure. */
export function stuckReport(a: StuckScan, w: { since: number; until: number }, t: StuckThresholds, writes?: readonly number[]): StuckReport {
  const top = (m: Map<string, number>): [string, number] | null => [...m].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0] ?? null;
  const progress = progressVerdict(a.samples, w, t, writes);
  const err = top(a.errors);
  const errTotal = [...a.errors.values()].reduce((x, y) => x + y, 0);
  const hint = top(a.hints);
  const signals: Signal[] = [
    {
      name: "errors",
      tripped: err !== null && err[1] >= t.repeatErrors,
      text: err === null ? `none failed (threshold ${t.repeatErrors} identical)` : `${err[1]}× ${JSON.stringify(err[0])} (threshold ${t.repeatErrors} identical) · ${errTotal} error(s) in ${a.errors.size} signature(s)`,
    },
    {
      name: "hints",
      tripped: hint !== null && hint[1] >= t.hintTally,
      text: hint === null ? `no harness-delivered hint (threshold ${t.hintTally})` : `${topCounts(a.hints, 4)} tallied in the harness's hint blocks (threshold ${t.hintTally} for one)`,
    },
    {
      name: "schema",
      tripped: a.schemaRecords >= t.schemaErrors,
      text: `${a.schemaRecords} events_served record(s) carrying a schemaError (threshold ${t.schemaErrors})`,
    },
    {
      name: "restarts",
      tripped: a.restarts.length >= t.restarts,
      text: `${a.restarts.length} sandbox restart(s)${a.restarts.length > 0 ? `, the last at ${clock(a.restarts[a.restarts.length - 1]!)}` : ""} (threshold ${t.restarts})`,
    },
    {
      name: "asks",
      tripped: a.asks.length >= t.asks,
      text: `heuristic: ${a.asks.length} of ${a.responses} response(s) read as addressed to the operator (threshold ${t.asks})`,
    },
  ];
  return { window: w, progress, scan: a, signals };
}

/** The one line `fleet status` and `inspect stuck` without a run id print for a stuck run. */
export function stuckFlag(p: ProgressVerdict, windowMs: number): string {
  return `no progress in ${fmtAge(windowMs)}: ${p.evidence}`;
}

/** One fan-out character's progress over the window. */
export interface CharacterProgress {
  character: string;
  progress: ProgressVerdict;
}

/**
 * A fan-out run's verdict from its characters': stuck only when every one is
 * (one agent moving any of its characters is making progress), progressing
 * when any one is, and otherwise unjudged. infra/run-fleet-state.ts
 * `liveRunStuck` flags a fan-out run by the same rule. Pure.
 */
export function fanoutProgress(characters: readonly CharacterProgress[]): ProgressVerdict {
  const n = characters.length;
  const samples = characters.reduce((a, c) => a + c.progress.samples, 0);
  if (n === 0) return { state: "unjudged", evidence: "no character has a record yet", samples: 0 };
  const moving = characters.filter((c) => c.progress.state === "progressing");
  if (moving.length > 0) return { state: "progressing", evidence: `${moving.length} of ${n} character(s) made progress: ${moving.map((c) => `${c.character}: ${c.progress.evidence}`).join("; ")}`, samples };
  const held = characters.filter((c) => c.progress.state === "stuck");
  if (held.length === n) return { state: "stuck", evidence: `every character (${n}) held: ${held.map((c) => `${c.character}: ${c.progress.evidence}`).join("; ")}`, samples };
  const open = characters.filter((c) => c.progress.state === "unjudged");
  return { state: "unjudged", evidence: `${open.length} of ${n} character(s) unjudged and none progressing: ${open.map((c) => `${c.character}: ${c.progress.evidence}`).join("; ")}`, samples };
}

/** One session record's samples over a window (the store's under `key`, else the record's) and its other writes. */
async function sessionProgress(
  via: Via,
  key: string,
  session: string,
  w: { since: number; until: number },
  t: StuckThresholds,
): Promise<{ samples: ProgressSample[]; writes: number[]; schemaBatches: number; progress: ProgressVerdict }> {
  let rows: Record<string, unknown>[];
  if (via.store !== null) {
    const before = await via.store.sampleBefore(key, w.since);
    rows = [...(before !== null ? [before] : []), ...(await via.store.samples(key, w.since, w.until))];
  } else rows = traceSamples(session, w);
  const samples = rows.map((r) => progressSampleOf(r, r["ts"] as number));
  const rec = recordWrites(session, w);
  return { samples, writes: rec.writes, schemaBatches: rec.schemaBatches, progress: progressVerdict(samples, w, t, rec.writes) };
}

/** The detector over one run: where it reads, the window, the scan, and a fan-out run's characters one by one. */
async function stuckOf(
  ctx: Ctx,
  runId: string,
  run: { dir: string; path: string },
  until: number | null,
  t: StuckThresholds,
): Promise<{ via: Via; report: StuckReport; anchor: string; characters: CharacterProgress[] | null }> {
  // The window ends at --until, else at the run's newest record (an ended run
  // is judged on its last stretch), and never in the future.
  const probe = await viaFor(ctx, runId, run.dir, { since: null, until });
  const newest = probe.store !== null ? probe.ext.newestTs : newestInFile(run.path);
  const end = until ?? Math.min(ctx.now, newest ?? ctx.now);
  const anchor = until !== null ? "--until" : newest !== null && newest < ctx.now - HEARTBEAT_DEAD_MS ? "the run's newest record" : "now";
  const w = { since: end - t.windowMs, until: end };
  let via: Via = probe;
  let scan: StuckScan;
  if (probe.store !== null) {
    const ext = await probe.store.extent(runId, w);
    via = { ...probe, ext };
    const r = stuckReducer(w);
    await storeRead(probe.store, runId, STUCK_SPEC, w, ext.window, true, r.fn);
    scan = r.a;
  } else {
    const r = stuckReducer(w);
    fileForward(run.path, r.fn, seekTime(run.path, w.since));
    scan = r.a;
  }
  // A v1 run's trajectory is the model side: its samples are its trace's,
  // folded by the collector into the store, or read off the record here,
  // and the newest one before the window with them. The trace is silent
  // while nothing changes, so what covers the window is the record's other
  // writes, off its files on either path: the store holds neither the
  // `calls` stream whole nor `live.json`.
  if (isV1Dir(run.dir)) {
    const s = await sessionProgress(via, runId, join(run.dir, "session"), w, t);
    scan.samples = s.samples;
    // Its tools' served batches are its record's `calls` rows, not trajectory records.
    scan.schemaRecords += s.schemaBatches;
    return { via, report: stuckReport(scan, w, t, s.writes), anchor, characters: null };
  }
  // A fan-out run: each character judged off its own record, the store's
  // rows under its key; the trajectory's signals are the one agent's.
  if (isFanoutDir(run.dir)) {
    const characters: CharacterProgress[] = [];
    for (const ref of sessionsOf(run.dir)) {
      const character = ref.character ?? "?";
      const s = await sessionProgress(via, fanoutKey(runId, character), ref.session, w, t);
      scan.schemaRecords += s.schemaBatches;
      characters.push({ character, progress: s.progress });
    }
    scan.samples = [];
    const report = stuckReport(scan, w, t, []);
    return { via, report: { ...report, progress: fanoutProgress(characters) }, anchor, characters };
  }
  return { via, report: stuckReport(scan, w, t), anchor, characters: null };
}

export async function inspectStuck(runId: string, opts: Ctx & { until: number | null; thresholds: StuckThresholds }, out: Out): Promise<number> {
  const run = trajectoryOf(runId, opts, out);
  if (run === null) return 1;
  const t = opts.thresholds;
  const { via, report, anchor, characters } = await stuckOf(opts, runId, run, opts.until, t);
  const say = (text: string): void => out(cap(strike(text, run.token), opts.width));
  const p = report.progress;
  const a = report.scan;
  const label = (v: ProgressVerdict): string => (v.state === "stuck" ? "TRIPPED" : v.state === "unjudged" ? "unjudged" : "ok     ");
  const whose = characters === null ? "" : characters.length === 1 ? " (its one character)" : ` (all ${characters.length} characters: a fan-out run is stuck only when every one is)`;
  say(`${runId}: the stuck detector over ${fmtAge(t.windowMs)} to ${iso(report.window.until)} (${anchor}), UTC`);
  say(
    `verdict   ${p.state === "stuck" ? `STUCK: no game progress in the window${whose}` : p.state === "progressing" ? `not stuck: ${characters === null ? "the" : "a"} character made progress` : "unjudged: what was recorded does not cover the window"} (only the progress signal flags a run; the rest are evidence)`,
  );
  say(`source    ${via.line}`);
  if (characters === null) say(`progress  ${label(p)}  ${p.evidence}`);
  else {
    say(`progress  ${label(p)}  ${characters.length} character(s)${characters.length === 0 ? `: ${p.evidence}` : ", each judged off its own record:"}`);
    const pad = Math.max(0, ...characters.map((c) => c.character.length));
    for (const c of characters) say(`  ${c.character.padEnd(pad)}  ${label(c.progress)}  ${c.progress.evidence}`);
  }
  say(`activity  ${a.snippets} snippet(s) · ${a.toolCalls} other tool call(s) · ${a.responses} model response(s) in the window`);
  for (const s of report.signals) say(`${s.name.padEnd(9)} ${s.tripped ? "TRIPPED" : "ok     "}  ${s.text}`);
  for (const ask of a.asks.slice(-2)) say(`          ${clock(ask.ts)}  ${cap(ask.text, opts.width - 40)}`);
  say(
    `limits    --window ${fmtAge(t.windowMs)} --move ${t.moveYards} --max-gap ${fmtAge(t.maxGapMs)} --repeat ${t.repeatErrors} --hints ${t.hintTally} --schema ${t.schemaErrors} --restarts ${t.restarts} --asks ${t.asks}`,
  );
  return 0;
}

/** `inspect stuck` with no run id: every run with a live owner, one line each. */
export async function inspectStuckLive(opts: Ctx & { thresholds: StuckThresholds }, out: Out): Promise<number> {
  let names: string[];
  try {
    names = readdirSync(opts.runsDir);
  } catch {
    out(`no runs directory at ${opts.runsDir}`);
    return 1;
  }
  const live = names.filter((id) => id !== ARCHIVE_DIR && isValidRunId(id) && ownedAt(heartbeatAt(join(opts.runsDir, id)), opts.now)).sort();
  out(`${live.length} run(s) with a live owner; the stuck detector over the last ${fmtAge(opts.thresholds.windowMs)} of each`);
  let source = "";
  for (const id of live) {
    const run = trajectoryOf(id, opts, () => {});
    if (run === null) {
      out(cap(`  ${id}  no trajectory`, opts.width));
      continue;
    }
    const { via, report, characters } = await stuckOf(opts, id, run, null, opts.thresholds);
    source = via.line;
    const p = report.progress;
    const others = report.signals.filter((s) => s.tripped).map((s) => s.name);
    // The tripped evidence first: the progress line that follows is long, and the cap cuts its end.
    const also = others.length > 0 ? ` (also tripped: ${others.join(", ")})` : "";
    const rest = p.state === "stuck" ? stuckFlag(p, opts.thresholds.windowMs) : p.state === "unjudged" ? p.evidence : "";
    const fan = characters === null ? "" : `  fan-out, ${characters.filter((c) => c.progress.state === "stuck").length} of ${characters.length} character(s) held`;
    out(cap(strike(`  ${id}  ${p.state === "stuck" ? "STUCK" : p.state}${also}${fan}${rest !== "" ? `  ${rest}` : ""}`, run.token), opts.width));
  }
  if (source !== "") out(cap(`source    ${source}`, opts.width));
  return 0;
}

// ------------------------------------------------------------------ inspect session

/** The streams `session` reads: what happened to a character, and what the agent asked for and sent. */
export const SESSION_STREAMS = ["events", "calls"] as const;
export type SessionStream = (typeof SESSION_STREAMS)[number];

export interface SessionOptions extends Ctx, Window {
  stream: SessionStream;
  /** One fan-out character, or the run's one; null for every character. */
  character: string | null;
  /** The kinds to show; null for every kind but the `key` rows, which restate the stream. */
  kinds: ReadonlySet<string> | null;
  grep: RegExp | null;
  last: number;
  forward: boolean;
}

/** Who a calls row came from: a tool call by its id, code a call left running, or the SDK's own traffic. */
function originOf(v: unknown): string {
  const o = obj(v);
  const type = str(o["type"]) ?? "?";
  return typeof o["call"] === "number" ? `${type} #${o["call"]}` : type;
}

function json(v: unknown): string {
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return "?";
  }
}

/**
 * One stream row as a line's body: each `calls` kind by what it means (a call
 * and its arguments, a result and its text, the actions an origin sent, a
 * move and its verdict, a served batch by opcode), an `events` row as its
 * fields.
 */
export function sessionRowText(r: StreamRow): string {
  const row = r.row;
  const rest = (): string => {
    const { ts: _ts, kind: _kind, seq: _seq, ...fields } = row;
    return Object.keys(fields).length === 0 ? "" : json(fields);
  };
  switch (r.kind) {
    case "call":
      return `#${String(row["id"])} ${str(row["tool"]) ?? "?"} ${json(row["args"])}`;
    case "result": {
      const ms = typeof row["durationMs"] === "number" ? ` ${row["durationMs"]}ms` : "";
      return `#${String(row["id"])} ${row["error"] === true ? "ERROR" : "ok"}${ms} ${textOf(row["text"])}`;
    }
    case "actions": {
      const acts = (Array.isArray(row["actions"]) ? row["actions"] : []).map((a) => {
        const x = obj(a);
        const what = [str(x["action"]) ?? "?", String(x["status"] ?? "?"), str(x["error"])].filter((b) => b !== null).join(" ");
        return typeof x["count"] === "number" && x["count"] > 1 ? `${what} ×${x["count"]}` : what;
      });
      const dropped = Object.keys(obj(row["dropped"])).length > 0 ? ` (dropped ${json(row["dropped"])})` : "";
      return `${originOf(row["origin"])}: ${acts.join(", ")}${dropped}`;
    }
    case "move": {
      const at = [row["x"], row["y"], row["z"]].map((n) => (typeof n === "number" ? n.toFixed(1) : "?")).join(", ");
      const target = row["target"] !== null && row["target"] !== undefined ? ` target ${String(row["target"])}${str(row["name"]) !== null ? ` (${row["name"] as string})` : ""}` : "";
      const status = row["status"] === null || row["status"] === undefined ? "dispatched" : String(row["status"]);
      return `${originOf(row["origin"])}: #${String(row["moveId"] ?? "?")} map ${String(row["map"] ?? "?")} (${at})${target} ${status}`;
    }
    case "events": {
      const ops = new Map<string, number>();
      let schema = 0;
      for (const e of Array.isArray(row["events"]) ? row["events"] : []) {
        count(ops, str(obj(e)["opcode"]) ?? "?");
        if (obj(e)["schemaError"] !== undefined) schema++;
      }
      const folded = typeof row["folded"] === "number" ? `, ${row["folded"]} folded` : "";
      return `${originOf(row["origin"])}: ${String(row["count"] ?? "?")} event(s)${folded}${schema > 0 ? `, ${schema} with a schemaError` : ""}: ${topCounts(ops, 8)}`;
    }
    case "key":
      return r.row["open"] !== undefined ? `${Array.isArray(row["open"]) ? row["open"].length : "?"} call(s) open` : rest();
    default:
      return rest();
  }
}

/**
 * A v1 run's session record, one capped line per row of one stream, the
 * newest `--last` (or the oldest `--next`) in a window: the `events` stream
 * (deaths, levels, zones, turn-ins and the rest of what happened) or the
 * `calls` stream (each tool call and its result, the actions and moves sent on
 * its behalf, the event batches it served). These were trajectory records on
 * 0.5, which `trajectory --grep` read. A fan-out run's characters are read
 * together, each line naming its character, or one with `--character`; a call
 * written to several characters' records (one that named none) is shown once.
 * Read off the files wherever the views read: the store does not hold these
 * streams whole.
 */
export async function inspectSession(runId: string, opts: SessionOptions, out: Out): Promise<number> {
  const dir = findRunDir(opts.runsDir, runId);
  if (dir === null) {
    out(`no run ${runId} under ${opts.runsDir} (nor its ${ARCHIVE_DIR}/)`);
    return 1;
  }
  const token = strikableToken(readMeta(dir), runId);
  let refs = sessionsOf(dir);
  if (refs.length === 0) {
    out(
      isFanoutDir(dir)
        ? `${runId}: a fan-out run none of whose characters has a session record yet`
        : `${runId} has no session record: a 0.5 run, whose events and actions are trajectory records (trajectory --all --grep)`,
    );
    return 1;
  }
  const fanout = sessionDir(dir) === null;
  if (opts.character !== null) {
    const want = opts.character.toLowerCase();
    const picked = refs.filter((r) => r.character?.toLowerCase() === want);
    if (picked.length === 0) {
      out(`${runId} has no character ${opts.character}: ${refs.map((r) => r.character ?? "(unnamed)").join(", ")}`);
      return 1;
    }
    refs = picked;
  }
  const keep = (r: StreamRow): boolean =>
    (opts.kinds === null ? r.kind !== "key" : opts.kinds.has(r.kind)) && (opts.grep === null || opts.grep.test(strike(r.line, token)));
  const limit = { n: opts.last, forward: opts.forward };
  // A call or its result written to several characters' records is one call: shown once, with whose records hold it.
  const rows: (StreamRow & { who: string[] })[] = [];
  const seen = new Map<string, StreamRow & { who: string[] }>();
  for (const ref of refs) {
    for (const r of streamRows(ref.session, opts.stream, opts, keep, limit)) {
      const id = (r.kind === "call" || r.kind === "result") && typeof r.row["id"] === "number" ? `${r.kind}:${r.row["id"]}` : null;
      const prior = id === null ? undefined : seen.get(id);
      if (prior !== undefined) {
        prior.who.push(ref.character ?? "?");
        continue;
      }
      const row = { ...r, who: [ref.character ?? "?"] };
      if (id !== null) seen.set(id, row);
      rows.push(row);
    }
  }
  rows.sort((a, b) => a.ts - b.ts);
  const shown = opts.forward ? rows.slice(0, opts.last) : rows.slice(-opts.last);
  const whoOf = (who: readonly string[]): string => (who.length === 1 ? who[0]! : `${who[0]}+${who.length - 1}`);
  const pad = fanout ? Math.max(0, ...shown.map((r) => whoOf(r.who).length)) : 0;
  const kindPad = Math.max(0, ...shown.map((r) => r.kind.length));
  const say = (text: string): void => out(cap(strike(text, token), opts.width));
  const filters = [
    opts.kinds !== null ? `kind ${[...opts.kinds].join(",")}` : null,
    opts.grep !== null ? `grep /${opts.grep.source}/` : null,
    windowPhrase(opts) !== "" ? windowPhrase(opts) : null,
  ].filter((b) => b !== null);
  const whose = fanout ? `${refs.length} character(s): ${refs.map((r) => r.character).join(", ")}` : (refs[0]!.character ?? "its character");
  say(`${runId}: the ${opts.stream} stream of ${whose}${filters.length > 0 ? ` · ${filters.join(" · ")}` : ""} · ${opts.forward ? "the first" : "the last"} ${shown.length}, UTC`);
  say(`source    the files: the session record${fanout ? "s" : ""} (ClickHouse does not hold these streams whole)`);
  for (const r of shown) {
    const who = fanout ? `${whoOf(r.who).padEnd(pad)}  ` : "";
    say(`${clock(r.ts)}  ${who}${r.kind.padEnd(kindPad)}  ${sessionRowText(r)}`);
  }
  if (shown.length === 0) say("          (no row matches)");
  return 0;
}

// ------------------------------------------------------------------ inspect requests

/**
 * How a driver's records carry a model call's usage: runner/src/drivers.ts
 * `DriverEntry.usage`, copied because this file imports nothing, and pinned by
 * the test. `response`: one `response` record per request, its usage the
 * request's. `turn-snapshot` (claude-code): one usage-bearing `response` per
 * API call, its input finished but its output the stream's opening snapshot,
 * the turn's finished output on its `claude_result`. `exec-tally` (codex): one
 * `response` per CLI turn, its figures a tally of every call in it.
 */
export type UsageShape = "response" | "turn-snapshot" | "exec-tally";
export const DRIVER_USAGE: Readonly<Record<string, UsageShape>> = {
  openai: "response",
  "claude-code": "turn-snapshot",
  codex: "exec-tally",
  pi: "response",
  stub: "response",
  reference: "response",
};

/**
 * One request as its `response` record reported it (on codex, one CLI turn).
 * A figure not reported is null, never 0. `prompt` is the whole prompt with
 * the cached part inside it, the runner's convention for every driver;
 * `output` is the finished count, which on claude-code is the turn's result
 * spread evenly over the turn's requests, and null where the turn has none.
 */
export interface ModelCall {
  ts: number;
  turn: number | null;
  prompt: number | null;
  cached: number | null;
  write: number | null;
  output: number | null;
  reasoning: number | null;
  usd: number | null;
}

/** A codex thread total in the runner's normalised shape (runner/src/codex-usage.ts `CodexUsage`). */
interface CodexTotal {
  prompt: number;
  completion: number;
  cached?: number;
  write?: number;
  reasoning?: number;
}

/**
 * One turn's usage from two thread totals: runner/src/codex-usage.ts
 * `codexUsageDelta`, copied and pinned by the test. Each field on its own,
 * never below zero (a drop is a new baseline); no previous total is the total.
 */
export function codexDelta(prev: CodexTotal | undefined, cur: CodexTotal): CodexTotal {
  if (prev === undefined) return { ...cur };
  const d = (a: number | undefined, b: number | undefined): number => Math.max(0, (a ?? 0) - (b ?? 0));
  const out: CodexTotal = { prompt: d(cur.prompt, prev.prompt), completion: d(cur.completion, prev.completion) };
  if (cur.cached !== undefined) out.cached = d(cur.cached, prev.cached);
  if (cur.write !== undefined) out.write = d(cur.write, prev.write);
  if (cur.reasoning !== undefined) out.reasoning = d(cur.reasoning, prev.reasoning);
  return out;
}

/** What a `requests` read takes off the trajectory, the whole run's, oldest first. */
export interface RequestScan {
  shape: UsageShape;
  calls: ModelCall[];
  /** A scaffold's `response` records with no usage: a message's (claude-code) or a CLI turn's (codex) earlier records, not requests. */
  envelopes: number;
  /** codex: responses whose usage was the thread's running total, turned into the turn's here. */
  derived: number;
  /** codex: thread totals that went down, each read as a new baseline. */
  regressions: number;
  /** claude-code: each turn's finished output, off its `claude_result`. */
  turnOutput: Map<number, number>;
  /** claude-code: a turn's output with no request of its own to spread it over. */
  orphanOutput: number;
  /** claude-code: the CLI's cumulative charge per session, as each result reported it. */
  cli: { ts: number; session: string; usd: number }[];
  /** `wake` records (the shape `harness/wake` defined): what ended each wait, and how long it slept. */
  wakes: { ts: number; fired: string; sleptMs: number }[];
  /** Every `response` record's clock, usage or none: on a scaffold, one per item the model answered with (a tool call, a message), not one per model call. */
  responseTs: number[];
  /** Spans from a `pause` record to the next `resume`, `to` null when the run never resumed. */
  pauses: { from: number; to: number | null }[];
  /** A 0.5 trajectory's own `state` records, for a run with no other samples. */
  states: ProgressSample[];
  first: number | null;
  last: number | null;
}

function finite(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * A response's usage in one shape. The runner writes every driver's as
 * `prompt_tokens` (the whole prompt) with the cached part inside it; a record
 * with `input_tokens` instead is a raw shape, and what that counts is the
 * driver's: Codex's includes the cache, Anthropic's leaves it beside.
 */
function usageFigures(u: Record<string, unknown>, shape: UsageShape): Omit<ModelCall, "ts" | "turn"> | null {
  const details = obj(u["prompt_tokens_details"]);
  const cached = intOf(u["cached_tokens"]) ?? intOf(details["cached_tokens"]) ?? intOf(u["cache_read_input_tokens"]) ?? intOf(u["cached_input_tokens"]);
  const write = intOf(u["cache_write_tokens"]) ?? intOf(details["cache_write_tokens"]) ?? intOf(u["cache_creation_input_tokens"]) ?? intOf(u["cache_write_input_tokens"]);
  let prompt = intOf(u["prompt_tokens"]);
  const input = intOf(u["input_tokens"]);
  if (prompt === null && input !== null) prompt = shape === "exec-tally" ? input : input + (cached ?? 0) + (write ?? 0);
  const output = intOf(u["completion_tokens"]) ?? intOf(u["output_tokens"]);
  const reasoning = intOf(u["reasoning_tokens"]) ?? intOf(obj(u["completion_tokens_details"])["reasoning_tokens"]) ?? intOf(u["reasoning_output_tokens"]);
  const usd = finite(u["cost"]);
  if (prompt === null && output === null && cached === null && usd === null) return null;
  return { prompt, cached, write, output, reasoning, usd };
}

/** The record-by-record read behind `requests`; `done` settles claude-code's output once every result is in. */
function requestReducer(shape: UsageShape): { fn: RecFn; done: () => RequestScan } {
  const a: RequestScan = {
    shape,
    calls: [],
    envelopes: 0,
    derived: 0,
    regressions: 0,
    turnOutput: new Map(),
    orphanOutput: 0,
    cli: [],
    wakes: [],
    responseTs: [],
    pauses: [],
    states: [],
    first: null,
    last: null,
  };
  // codex: the thread total the next one is measured from (runner/src/codex-usage.ts `CodexUsageCorrector`).
  let prev: CodexTotal | undefined;
  let thread: string | null = null;
  const fn: RecFn = (r) => {
    if (Number.isFinite(r.ts)) {
      a.first ??= r.ts;
      a.last = Math.max(a.last ?? r.ts, r.ts);
    }
    switch (r.t) {
      case "driver":
        // Every episode opens a new thread.
        prev = undefined;
        thread = null;
        return;
      case "codex_thread": {
        const id = str(r.parse()?.["threadId"]);
        if (id !== thread) {
          thread = id;
          prev = undefined;
        }
        return;
      }
      case "pause":
        if (a.pauses.length === 0 || a.pauses[a.pauses.length - 1]!.to !== null) a.pauses.push({ from: r.ts, to: null });
        return;
      case "resume": {
        const open = a.pauses[a.pauses.length - 1];
        if (open !== undefined && open.to === null) open.to = r.ts;
        return;
      }
      case "wake": {
        const p = r.parse();
        a.wakes.push({ ts: r.ts, fired: str(p?.["fired"]) ?? "?", sleptMs: finite(p?.["sleptMs"]) ?? 0 });
        return;
      }
      case "state": {
        const p = r.bytes < 1 << 20 ? r.parse() : null;
        if (p !== null) a.states.push(progressSampleOf(p, r.ts));
        return;
      }
      case "claude_result": {
        const p = r.parse();
        const turn = intOf(p?.["turn"]);
        const out = intOf(obj(p?.["usageRaw"])["output_tokens"]) ?? intOf(obj(p?.["usage"])["completion_tokens"]);
        // A result that reports no output speaks for nothing (runner/viewer/tail.ts `claudeTurns`).
        if (turn !== null && out !== null && out > 0) a.turnOutput.set(turn, out);
        const usd = finite(p?.["costUsd"]);
        if (usd !== null) a.cli.push({ ts: r.ts, session: str(p?.["sessionId"]) ?? "", usd });
        return;
      }
      case "response": {
        a.responseTs.push(r.ts);
        const p = r.bytes < RAW_CAP_BYTES ? r.parse() : null;
        const turn = intOf(p?.["turn"]);
        const raw = p?.["usage"];
        let f = raw !== null && typeof raw === "object" ? usageFigures(raw as Record<string, unknown>, shape) : null;
        // A scaffold's message (claude-code) or CLI turn (codex) writes several records, and only its last carries the usage.
        if (shape !== "response" && f === null) {
          a.envelopes++;
          return;
        }
        if (shape === "turn-snapshot" && f !== null) {
          // The input is the finished count; the output an opening snapshot, settled from the turn's result in `done`.
          f = { ...f, output: null, reasoning: null };
        } else if (shape === "exec-tally" && f !== null && p?.["usageCumulative"] === undefined) {
          // A thread total, from before the driver wrote per-turn deltas: the turn's is what it added.
          const cur: CodexTotal = { prompt: f.prompt ?? 0, completion: f.output ?? 0 };
          if (f.cached !== null) cur.cached = f.cached;
          if (f.write !== null) cur.write = f.write;
          if (f.reasoning !== null) cur.reasoning = f.reasoning;
          if (prev !== undefined && (cur.prompt < prev.prompt || cur.completion < prev.completion)) a.regressions++;
          const d = codexDelta(prev, cur);
          prev = cur;
          a.derived++;
          f = { prompt: d.prompt, cached: d.cached ?? null, write: d.write ?? null, output: d.completion, reasoning: d.reasoning ?? null, usd: f.usd };
        }
        a.calls.push({ ts: r.ts, turn, prompt: f?.prompt ?? null, cached: f?.cached ?? null, write: f?.write ?? null, output: f?.output ?? null, reasoning: f?.reasoning ?? null, usd: f?.usd ?? null });
        return;
      }
    }
  };
  const done = (): RequestScan => {
    if (shape !== "turn-snapshot") return a;
    const byTurn = new Map<number, ModelCall[]>();
    for (const c of a.calls) if (c.turn !== null) byTurn.set(c.turn, [...(byTurn.get(c.turn) ?? []), c]);
    for (const [turn, out] of a.turnOutput) {
      const calls = byTurn.get(turn) ?? [];
      if (calls.length === 0) a.orphanOutput += out;
      for (const c of calls) c.output = out / calls.length;
    }
    return a;
  };
  return { fn, done };
}

/** What `requests` asks of the store: the usage-bearing records whole, and the rest by their kind and clock alone. */
const REQUESTS_SPEC: ReadSpec = {
  kinds: {
    response: { raw: "all" },
    claude_result: { raw: "all" },
    codex_thread: { raw: "all" },
    wake: { raw: "all" },
    state: { raw: "all" },
    driver: { raw: "none" },
    pause: { raw: "none" },
    resume: { raw: "none" },
  },
};

// ---------------------------------------------------------------- prices

/** One price row as `requests` prices tokens at it: dollars per million, and where the figure is from. */
export interface RequestPrice {
  id: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** The row, its window and the catalogue it was read from, in words. */
  basis: string;
}

/** Where the model catalogue is looked for: beside this file, else the repository's from the working directory (the runner pod's is /wrathbench). */
function catalogueAt(path: string | null): { cat: Record<string, unknown> | null; path: string } {
  const tries = path !== null ? [path] : [join(import.meta.dir, "model-catalogue.json"), join("infra", "model-catalogue.json")];
  for (const p of tries) {
    try {
      return { cat: JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>, path: p };
    } catch {
      /* not there */
    }
  }
  return { cat: null, path: tries[tries.length - 1]! };
}

interface RateWindowRow {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  from?: string;
}

/** The window in force at `at`: runner/viewer/pricing.ts `windowAt`. */
function rateAt(windows: unknown, at: number): RateWindowRow | null {
  if (!Array.isArray(windows) || windows.length === 0) return null;
  let chosen: RateWindowRow | null = null;
  for (const w of windows as RateWindowRow[]) {
    if (w.from !== undefined && Date.parse(w.from) > at) break;
    chosen = w;
  }
  return chosen ?? (windows[0] as RateWindowRow);
}

/** Two api bases name one endpoint: same origin and path, trailing slash ignored (pricing.ts `sameBase`). */
function sameBase(a: string | null, b: unknown): boolean {
  if (a === null || typeof b !== "string") return false;
  const norm = (u: string): string | null => {
    try {
      const url = new URL(u);
      return `${url.origin.toLowerCase()}${url.pathname.replace(/\/+$/, "")}`;
    } catch {
      return null;
    }
  };
  const x = norm(a);
  return x !== null && x === norm(b);
}

/**
 * The run's price row out of the model catalogue (infra/model-catalogue.json),
 * at the rate window in force at `at`: the part of runner/viewer/pricing.ts
 * `priceFor` that names a metered row, matched the same way, and pinned to it
 * by the test. A free slug reads zero; a metered endpoint's row is matched on
 * its base and id; an OpenRouter row on its id, and only for a run on
 * OpenRouter or with no base; a codex slug under `openai/`; a Claude row on the
 * model the CLI served. Anything else (a local base, a declared-free run, an id
 * no row names) is a reason, never a guess: the viewer's figure is then the one.
 */
export function requestPrice(
  cat: Record<string, unknown> | null,
  run: { model: string | null; driver: string | null; apiBase: string | null; resolvedModel: string | null; billing: string | null },
  at: number,
): RequestPrice | { none: string } {
  const model = run.model ?? "";
  if (cat === null) return { none: "no price table here (infra/model-catalogue.json not found)" };
  if (run.billing === "free") return { none: "the launch declared it free (the viewer's figure is the one)" };
  if (/(?::free$|-free$)/.test(model)) return { id: model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, basis: `${model}: a free slug, request-capped, not token-billed` };
  const models = obj(cat["models"]);
  const providers = obj(cat["providers"]);
  const when = (w: RateWindowRow, asOf: unknown): string => (w.from !== undefined ? `in force from ${w.from}` : `its first window${typeof asOf === "string" ? `, read ${asOf}` : ""}`);
  const row = (id: string, w: RateWindowRow | null, basis: string): RequestPrice | null =>
    w === null ? null : { id, input: w.input, output: w.output, cacheRead: w.cacheRead, cacheWrite: w.cacheWrite, basis };
  const base = run.apiBase;
  if (base !== null) {
    for (const [key, entry] of Object.entries(models)) {
      for (const [provider, p] of Object.entries(obj(obj(obj(entry)["prices"])["endpoints"]))) {
        const pr = obj(p);
        const ids = Array.isArray(pr["ids"]) ? (pr["ids"] as string[]) : [key];
        const at0 = obj(providers[provider]);
        if (!ids.includes(model) || !sameBase(base, at0["apiBase"])) continue;
        const w = rateAt(pr["windows"], at);
        if (w !== null) return row(`${str(at0["label"]) ?? provider}/${model}`, w, `${provider} endpoint row, ${when(w, pr["asOf"])}`)!;
      }
    }
    let host = "";
    try {
      host = new URL(base).hostname;
    } catch {
      /* not a URL */
    }
    if (host !== "openrouter.ai") return { none: `no row here for ${model} on ${base} (the viewer's pricing decides local and other bases)` };
  }
  const synced = (id: string): { w: RateWindowRow | null } | null => {
    for (const entry of Object.values(models)) {
      const p = obj(obj(obj(entry)["prices"])["openrouter"])[id];
      if (p !== undefined) return { w: rateAt(obj(p)["windows"], at) };
    }
    return null;
  };
  const asOf = obj(providers["openrouter"])["asOf"];
  const or = synced(model);
  if (or !== null) return row(model, or.w, `OpenRouter row, ${or.w === null ? "" : when(or.w, asOf)}`) ?? { none: `OpenRouter no longer prices ${model}` };
  if (run.driver === "codex" && !model.includes("/")) {
    const v = synced(`openai/${model}`);
    if (v !== null && v.w !== null) return row(`openai/${model}`, v.w, `OpenAI list price via the OpenRouter row openai/${model}, ${when(v.w, asOf)}; as-if-metered (a ChatGPT subscription)`)!;
  }
  if (run.driver === "claude-code" || /claude/i.test(model)) {
    const served = run.resolvedModel ?? model;
    for (const [key, entry] of Object.entries(models)) {
      const p = obj(obj(obj(entry)["prices"])["anthropic"]);
      const ids = Array.isArray(p["ids"]) ? (p["ids"] as string[]) : [key];
      if (!ids.includes(served)) continue;
      const w = rateAt(p["windows"], at);
      if (w !== null) return row(served, w, `Anthropic list price, ${when(w, p["asOf"])}; as-if-metered (a subscription)`)!;
      return { none: `no Anthropic row for ${served}${typeof p["unpriced"] === "string" ? `: ${p["unpriced"]}` : ""}` };
    }
    return { none: `no Anthropic row for ${served}` };
  }
  return { none: `no price row here for ${model}` };
}

// ---------------------------------------------------------------- spans

type Span = [number, number];

function spanTotal(xs: readonly Span[]): number {
  return xs.reduce((n, [a, b]) => n + Math.max(0, b - a), 0);
}

/** `xs` with every part `holes` covers taken out. Both sorted, neither overlapping itself. */
function spanMinus(xs: readonly Span[], holes: readonly Span[]): Span[] {
  const out: Span[] = [];
  for (const [a0, b] of xs) {
    let a = a0;
    for (const [h0, h1] of holes) {
      if (h1 <= a || h0 >= b) continue;
      if (h0 > a) out.push([a, h0]);
      a = Math.max(a, h1);
      if (a >= b) break;
    }
    if (a < b) out.push([a, b]);
  }
  return out;
}

/** The parts both lists cover. */
function spanAnd(xs: readonly Span[], ys: readonly Span[]): Span[] {
  const out: Span[] = [];
  for (const [a, b] of xs) {
    for (const [c, d] of ys) {
      const lo = Math.max(a, c);
      const hi = Math.min(b, d);
      if (lo < hi) out.push([lo, hi]);
    }
  }
  return out.sort((p, q) => p[0] - q[0]);
}

/** How long a stretch with no game progress must last, past this, to be a stall rather than play. */
export const STALL_DEFAULT_MS = 5 * 60_000;

/**
 * The stretches of [since, until] in which the character made no game
 * progress, by `stuck`'s rule (`progressStep`, and movement past `moveYards`),
 * and the stretches the record does not cover. A stretch runs from one
 * progress to the next, its movement measured from where it began; one longer
 * than `stallMs` is a stall. Covered is `stuck`'s sense: the samples (and on
 * a v1 run the record's other writes, `recordWrites`) no further apart than
 * `maxGapMs`, and nothing before the first reading. What is not covered is
 * never a stall: nothing recorded is not no progress. Pure.
 */
export function stallSpans(
  all: readonly ProgressSample[],
  w: { since: number; until: number },
  t: { moveYards: number; maxGapMs: number; stallMs: number },
  writes?: readonly number[],
): { stalls: Span[]; uncovered: Span[] } {
  const inside = all.filter((x) => x.ts >= w.since && x.ts <= w.until).sort((a, b) => a.ts - b.ts);
  const before = all.filter((x) => x.ts < w.since).reduce<ProgressSample | null>((a, x) => (a === null || x.ts >= a.ts ? x : a), null);
  const s = before !== null ? [{ ...before, ts: w.since }, ...inside] : inside;
  if (s.length === 0) return { stalls: [], uncovered: [[w.since, w.until]] };
  // Coverage: nothing before the first reading, and no gap past maxGapMs between writes.
  const uncovered: Span[] = [];
  if (s[0]!.ts > w.since) uncovered.push([w.since, s[0]!.ts]);
  const seen = [...s.map((x) => x.ts), ...(writes ?? []).filter((ts) => ts >= s[0]!.ts && ts <= w.until)].sort((a, b) => a - b);
  for (let i = 1; i < seen.length; i++) if (seen[i]! - seen[i - 1]! > t.maxGapMs) uncovered.push([seen[i - 1]!, seen[i]!]);
  if (w.until - seen[seen.length - 1]! > t.maxGapMs) uncovered.push([seen[seen.length - 1]!, w.until]);
  // Progress: each sample against the carry, movement against where the stretch began.
  const carry = newProgressCarry();
  let anchor: ProgressSample | null = null;
  const marks: number[] = [];
  for (const [i, x] of s.entries()) {
    const step = progressStep(carry, x);
    const placed = x.map !== null && x.x !== null && x.y !== null && x.z !== null;
    const moved = placed && anchor !== null && anchor.map === x.map && Math.hypot(x.x! - anchor.x!, x.y! - anchor.y!, x.z! - anchor.z!) > t.moveYards;
    const progressed = i > 0 && (step.rose || step.quests > 0 || step.money || step.items || step.map || moved);
    if (progressed) marks.push(x.ts);
    if (placed && (anchor === null || progressed || anchor.map !== x.map)) anchor = x;
  }
  const edges = [s[0]!.ts, ...marks.filter((ts) => ts > s[0]!.ts && ts < w.until), w.until];
  const quiet: Span[] = [];
  for (let i = 1; i < edges.length; i++) if (edges[i]! - edges[i - 1]! > t.stallMs) quiet.push([edges[i - 1]!, edges[i]!]);
  return { stalls: spanMinus(quiet, uncovered), uncovered };
}

// ---------------------------------------------------------------- windows

/** One character's readings over the run, and when its record was written. */
interface CharacterTrack {
  name: string | null;
  samples: ProgressSample[];
  /** A v1 record's writes beside its trace; undefined for a 0.5 run, whose samples are a minute apart. */
  writes: number[] | undefined;
}

/** The active milliseconds of [a, b]: its wall clock less the paused spans. */
function activeMs(a: number, b: number, pauses: readonly { from: number; to: number | null }[]): number {
  return Math.max(0, b - a - spanTotal(spanAnd([[a, b]], pauses.map((p) => [p.from, p.to ?? Infinity] as Span))));
}

/** The moment `ms` of active time has passed since `start`, the paused spans left out; Infinity when a pause never ends first. */
function activeAt(start: number, ms: number, pauses: readonly { from: number; to: number | null }[]): number {
  let t = start;
  let left = ms;
  for (const p of [...pauses].sort((x, y) => x.from - y.from)) {
    if (p.to !== null && p.to <= t) continue;
    if (p.from >= t + left) break;
    left -= Math.max(0, p.from - t);
    if (p.to === null) return Infinity;
    t = Math.max(t, p.to);
  }
  return t + left;
}

/** The first moment a track's level reached `level`; null when it never did. */
function levelReached(track: CharacterTrack, level: number): number | null {
  for (const x of [...track.samples].sort((a, b) => a.ts - b.ts)) if (x.level !== null && x.level >= level) return x.ts;
  return null;
}

/** One character's figures over a window. */
export interface CharacterFigures {
  name: string | null;
  levelFrom: number | null;
  levelTo: number | null;
  levelsPerHour: number | null;
  quests: number;
  questsPerHour: number | null;
  stallMinutes: number;
  uncoveredMinutes: number;
}

/** One window's figures. A figure no record reported is null, never 0. */
export interface WindowFigures {
  label: string;
  since: number;
  until: number;
  /** False for a cut the run never reached; every other figure is then absent. */
  reached: boolean;
  activeMinutes: number;
  requests: number;
  requestsPerHour: number | null;
  /** How many requests reported each figure. */
  reported: { input: number; cached: number; write: number; output: number; reasoning: number; cost: number };
  uncachedInPerRequest: number | null;
  cachedInPerRequest: number | null;
  cacheWritePerRequest: number | null;
  outputPerRequest: number | null;
  reasoningPerRequest: number | null;
  /** Wakes off `wake` records where the run has them, else harness turns. */
  wakes: {
    by: "wake" | "turn";
    count: number;
    perHour: number | null;
    requestsPer: number | null;
    /** `response` records per wake: on codex, where a request is a CLI turn, the items the model answered with. */
    responsesPer: number | null;
    fired: Record<string, number>;
    asleepShare: number | null;
  };
  /** The provider's own charge: OpenRouter's per response, the Claude Code CLI's per session. */
  reportedUsd: number | null;
  /** The window's tokens at the price row; output only where it is known. */
  pricedUsd: number | null;
  levelsPerHour: number | null;
  questsPerHour: number | null;
  quests: number;
  stallMinutes: number;
  uncoveredMinutes: number;
  characters: CharacterFigures[];
}

function perHour(n: number, activeMinutes: number): number | null {
  return activeMinutes > 0 ? (n * 60) / activeMinutes : null;
}

/** One track over a window: its levels and turn-ins (restarts read as `stuck` reads them), and its stalls. */
function characterFigures(track: CharacterTrack, w: { since: number; until: number }, minutes: number, t: { moveYards: number; maxGapMs: number; stallMs: number }): CharacterFigures & { stalls: Span[]; uncovered: Span[] } {
  const sorted = [...track.samples].sort((a, b) => a.ts - b.ts);
  const upTo = sorted.filter((x) => x.ts <= w.until);
  const before = upTo.filter((x) => x.ts < w.since);
  const inside = upTo.filter((x) => x.ts >= w.since);
  const levelAt = (xs: readonly ProgressSample[]): number | null => {
    for (let i = xs.length - 1; i >= 0; i--) if (xs[i]!.level !== null) return xs[i]!.level;
    return null;
  };
  const levelFrom = levelAt(before) ?? inside.find((x) => x.level !== null)?.level ?? null;
  const levelTo = levelAt(upTo);
  const carry = newProgressCarry();
  for (const x of before) progressStep(carry, x);
  let quests = 0;
  for (const x of inside) quests += progressStep(carry, x).quests;
  const { stalls, uncovered } = stallSpans(track.samples, w, t, track.writes);
  return {
    name: track.name,
    levelFrom,
    levelTo,
    levelsPerHour: levelFrom !== null && levelTo !== null ? perHour(levelTo - levelFrom, minutes) : null,
    quests,
    questsPerHour: perHour(quests, minutes),
    stallMinutes: spanTotal(stalls) / 60_000,
    uncoveredMinutes: spanTotal(uncovered) / 60_000,
    stalls,
    uncovered,
  };
}

/** Every figure of one window, off the scan and the tracks. Pure. */
export function windowFigures(
  scan: RequestScan,
  tracks: readonly CharacterTrack[],
  w: { label: string; since: number; until: number },
  price: RequestPrice | null,
  t: { moveYards: number; maxGapMs: number; stallMs: number },
): WindowFigures {
  const inW = (ts: number): boolean => ts >= w.since && ts <= w.until;
  const calls = scan.calls.filter((c) => inW(c.ts));
  const minutes = activeMs(w.since, w.until, scan.pauses) / 60_000;
  const sum = (pick: (c: ModelCall) => number | null): { n: number; total: number } => {
    let n = 0;
    let total = 0;
    for (const c of calls) {
      const v = pick(c);
      if (v === null) continue;
      n++;
      total += v;
    }
    return { n, total };
  };
  const uncached = sum((c) => (c.prompt === null ? null : c.prompt - (c.cached ?? 0)));
  const cached = sum((c) => (c.prompt === null && c.cached === null ? null : (c.cached ?? 0)));
  const write = sum((c) => c.write);
  const output = sum((c) => c.output);
  const reasoning = sum((c) => c.reasoning);
  const usd = sum((c) => c.usd);
  const per = (s: { n: number; total: number }): number | null => (s.n > 0 ? s.total / s.n : null);
  // The Claude Code CLI's charge is cumulative per session: the window's is what each session added in it.
  let cliUsd: number | null = null;
  if (scan.cli.length > 0) {
    const sessions = new Set(scan.cli.map((c) => c.session));
    for (const s of sessions) {
      const of = scan.cli.filter((c) => c.session === s);
      const upTo = of.filter((c) => c.ts <= w.until).reduce((m, c) => Math.max(m, c.usd), 0);
      const before = of.filter((c) => c.ts < w.since).reduce((m, c) => Math.max(m, c.usd), 0);
      if (of.some((c) => inW(c.ts))) cliUsd = (cliUsd ?? 0) + Math.max(0, upTo - before);
    }
  }
  const reportedUsd = usd.n > 0 || cliUsd !== null ? (usd.n > 0 ? usd.total : 0) + (cliUsd ?? 0) : null;
  let pricedUsd: number | null = null;
  if (price !== null && uncached.n > 0) {
    const read = cached.total;
    const fresh = Math.max(0, uncached.total - write.total);
    pricedUsd = (fresh * price.input + read * price.cacheRead + write.total * price.cacheWrite + output.total * price.output) / 1e6;
  }
  // Wakes: the `wake` records where the run has them, else its harness turns.
  const wakes = scan.wakes.filter((x) => inW(x.ts));
  const byWake = scan.wakes.length > 0;
  const turns = new Set(calls.map((c) => c.turn).filter((n) => n !== null));
  const count = byWake ? wakes.length : turns.size;
  const fired: Record<string, number> = {};
  for (const x of wakes) fired[x.fired] = (fired[x.fired] ?? 0) + 1;
  const slept = wakes.reduce((n, x) => n + x.sleptMs, 0);
  const chars = tracks.map((tr) => characterFigures(tr, w, minutes, t));
  // A run stalls while every character does: one agent moving any of them is making progress (`fanoutProgress`).
  const runStalls = chars.length === 0 ? [] : chars.slice(1).reduce((acc, c) => spanAnd(acc, c.stalls), chars[0]!.stalls);
  const runUncovered = chars.length === 0 ? [[w.since, w.until] as Span] : chars.slice(1).reduce((acc, c) => spanAnd(acc, c.uncovered), chars[0]!.uncovered);
  const gained = chars.reduce<number | null>((n, c) => (c.levelFrom !== null && c.levelTo !== null ? (n ?? 0) + c.levelTo - c.levelFrom : n), null);
  const quests = chars.reduce((n, c) => n + c.quests, 0);
  return {
    label: w.label,
    since: w.since,
    until: w.until,
    reached: true,
    activeMinutes: minutes,
    requests: calls.length,
    requestsPerHour: perHour(calls.length, minutes),
    reported: { input: uncached.n, cached: cached.n, write: write.n, output: output.n, reasoning: reasoning.n, cost: usd.n },
    uncachedInPerRequest: per(uncached),
    cachedInPerRequest: per(cached),
    cacheWritePerRequest: per(write),
    outputPerRequest: per(output),
    reasoningPerRequest: per(reasoning),
    wakes: {
      by: byWake ? "wake" : "turn",
      count,
      perHour: perHour(count, minutes),
      requestsPer: count > 0 ? calls.length / count : null,
      responsesPer: count > 0 ? scan.responseTs.filter(inW).length / count : null,
      fired,
      asleepShare: byWake && minutes > 0 ? slept / (minutes * 60_000) : null,
    },
    reportedUsd,
    pricedUsd,
    levelsPerHour: gained === null ? null : perHour(gained, minutes),
    questsPerHour: chars.length === 0 ? null : perHour(quests, minutes),
    quests,
    stallMinutes: spanTotal(runStalls) / 60_000,
    uncoveredMinutes: spanTotal(runUncovered) / 60_000,
    characters: chars.map(({ stalls: _s, uncovered: _u, ...c }) => c),
  };
}

// ---------------------------------------------------------------- the view

export interface RequestsOptions extends Ctx, Window {
  /** Cut the run where its first character reached each level. */
  atLevels: number[];
  /** Cut the run at each many active minutes from its start. */
  atMinutes: number[];
  stallMs: number;
  /** Re-price the tokens at the rates in force on this day instead of the run's start. */
  priceAt: number | null;
  /** The catalogue to price from, in place of the one beside this file. */
  catalogue: string | null;
  json: boolean;
}

/** A 0.5 run's state rows, read only once no live owner can be writing it, in rowid windows (`scanByRowid`). */
function samples05(db: Database, runId: string): ProgressSample[] {
  if (!hasTable(db, "state")) return [];
  const have = columns(db, "state");
  const pick = (c: string): string => (have.has(c) ? c : `NULL AS ${c}`);
  const cols = ["ts", "level", "xp", "money", "quests_completed", "map", "x", "y", "z", "items"].map(pick).join(", ");
  const byWindow = db.query(`SELECT ${cols} FROM state WHERE rowid > ? AND rowid <= ? AND run_id = ?`);
  return scanByRowid(db, "state", (lo, hi) => byWindow.all(lo, hi, runId) as Record<string, unknown>[]).map((r) => progressSampleOf(r, r["ts"] as number));
}

/** One store key's samples over the run, the newest one before it first. */
async function storeSamples(store: InspectStore, key: string, since: number, until: number): Promise<ProgressSample[]> {
  const before = await store.sampleBefore(key, since);
  return [...(before !== null ? [before] : []), ...(await store.samples(key, since, until))].map((r) => progressSampleOf(r, r["ts"] as number));
}

function fmtPer(n: number | null, digits = 1): string {
  return n === null ? "—" : n.toFixed(digits);
}

function fmtTok(n: number | null): string {
  return n === null ? "—" : fmtTokens(Math.round(n));
}

/** A figure with how many requests reported it, when not all of them did. */
function covered(text: string, n: number, of: number): string {
  return text === "—" || n >= of ? text : `${text} (${n}/${of})`;
}

/**
 * `requests`: what each model request cost the run, over the run (or
 * `--since`/`--until`) and up to each cut (`--at-level`, `--at-minutes`), from
 * the trajectory's `response` records and the run's readings. Per request:
 * uncached and cached input, output and reasoning; per wake (or harness turn):
 * requests; per hour: requests, wakes, levels and turn-ins; the provider's own
 * charge and, where the catalogue has a row, the tokens priced at it; and the
 * minutes no character made progress by `stuck`'s rule. Each driver's usage is
 * read in its own shape and said so (`UsageShape`); a figure a record did not
 * carry is a dash or a count of how many did, never a zero.
 */
export async function inspectRequests(runId: string, opts: RequestsOptions, out: Out): Promise<number> {
  const run = trajectoryOf(runId, opts, out);
  if (run === null) return 1;
  const { dir, token } = run;
  const meta = readMeta(dir);
  const config = obj(meta?.["config"]);
  const via = await viaFor(opts, runId, dir, { since: null, until: null });
  const driver = (via.store !== null ? via.run?.driver : null) ?? str(config["driver"]) ?? "?";
  const shape = DRIVER_USAGE[driver] ?? "response";
  const r = requestReducer(shape);
  if (via.store !== null) await storeRead(via.store, runId, REQUESTS_SPEC, { since: null, until: null }, via.ext.window, true, r.fn);
  else fileForward(run.path, r.fn);
  const scan = r.done();
  const heartbeat = heartbeatAt(dir);
  const owned = ownedAt(heartbeat, opts.now);
  const row = via.store !== null ? via.run : isV1Dir(dir) || isFanoutDir(dir, meta) ? metaRow(meta) : null;
  const start = row?.started_at ?? finite(meta?.["startedAt"]) ?? scan.first ?? opts.now;
  const end = row?.ended_at ?? finite(meta?.["endedAt"]) ?? (owned ? opts.now : (scan.last ?? opts.now));
  const notes: string[] = [];

  // The readings: a v1 run's record (a fan-out run's, each character's), else a 0.5 run's samples.
  const tracks: CharacterTrack[] = [];
  const refs = sessionsOf(dir);
  if (refs.length > 0) {
    const fanout = sessionDir(dir) === null;
    for (const ref of refs) {
      const key = fanout ? fanoutKey(runId, ref.character ?? "?") : runId;
      const samples = via.store !== null ? await storeSamples(via.store, key, start, end) : traceSamples(ref.session, { since: start, until: end }).map((x) => progressSampleOf(x, x["ts"] as number));
      tracks.push({ name: ref.character, samples, writes: recordWrites(ref.session, { since: start, until: end }).writes });
    }
  } else if (isFanoutDir(dir, meta)) {
    notes.push("no character has a session record yet: levels, turn-ins and stalls are unknown");
  } else {
    let samples: ProgressSample[] = [];
    if (via.store !== null) samples = await storeSamples(via.store, runId, start, end);
    else if (!owned) {
      const db = openDb(dir);
      try {
        samples = db === null ? [] : samples05(db, runId);
      } finally {
        db?.close();
      }
    } else notes.push(`levels, turn-ins and stalls ${notOpened(heartbeat, opts.now)}`);
    if (samples.length === 0) samples = scan.states;
    if (samples.length > 0 || !owned) tracks.push({ name: str(config["character"]), samples, writes: undefined });
  }

  // The price row, at the run's start or at --price-at.
  const { cat } = catalogueAt(opts.catalogue);
  const resolved = obj(meta?.["resolved"]);
  const priceAt = opts.priceAt ?? start;
  const price = requestPrice(
    cat,
    { model: row?.model ?? str(config["model"]), driver, apiBase: str(config["apiBase"]), resolvedModel: str(resolved["model"]), billing: str(config["billing"]) },
    priceAt,
  );
  const priceRow = "none" in price ? null : price;

  // The windows: the run or --since/--until, then each cut from the run's start.
  const t = { moveYards: STUCK_DEFAULTS.moveYards, maxGapMs: STUCK_DEFAULTS.maxGapMs, stallMs: opts.stallMs };
  const whole = { label: windowPhrase(opts) === "" ? "run" : "window", since: Math.max(start, opts.since ?? start), until: Math.min(end, opts.until ?? end) };
  const windows: WindowFigures[] = [windowFigures(scan, tracks, whole, priceRow, t)];
  const unreached = (label: string): WindowFigures => ({ ...windowFigures(scan, [], { label, since: start, until: start }, null, t), reached: false });
  for (const level of opts.atLevels) {
    const at = tracks.map((tr) => ({ name: tr.name, at: levelReached(tr, level) })).filter((x) => x.at !== null) as { name: string | null; at: number }[];
    const first = at.reduce<{ name: string | null; at: number } | null>((m, x) => (m === null || x.at < m.at ? x : m), null);
    const label = `to L${level}`;
    if (first === null) windows.push(unreached(label));
    else {
      windows.push(windowFigures(scan, tracks, { label, since: start, until: Math.max(start, first.at) }, priceRow, t));
      if (tracks.length > 1) notes.push(`${label}: ${at.sort((a, b) => a.at - b.at).map((x) => `${x.name ?? "?"} at ${fmtAge(activeMs(start, x.at, scan.pauses))}`).join(", ")}${at.length < tracks.length ? `; ${tracks.length - at.length} never` : ""}`);
    }
  }
  for (const m of opts.atMinutes) {
    const at = activeAt(start, m * 60_000, scan.pauses);
    const label = `to ${m}m`;
    windows.push(at > end ? unreached(label) : windowFigures(scan, tracks, { label, since: start, until: at }, priceRow, t));
  }

  // What each shape's figures are, said once.
  if (shape === "turn-snapshot") {
    const turns = new Set(scan.calls.map((c) => c.turn).filter((n) => n !== null));
    const open = [...turns].filter((n) => !scan.turnOutput.has(n!)).length;
    notes.push(
      `claude-code: a request is a response record carrying usage (${scan.envelopes} earlier envelope(s) of a message carry none and are not counted); ` +
        `its input is the finished count, its output the stream's opening snapshot, so output is each turn's claude_result spread evenly over the turn's requests` +
        (open > 0 ? `; ${open} of ${turns.size} turn(s) have no result (cut short): their requests carry only snapshots, shown as unreported output, never as a figure` : ""),
    );
    if (scan.orphanOutput > 0) notes.push(`claude-code: ${fmtTokens(scan.orphanOutput)} output on result(s) whose turn has no request is left out`);
    notes.push("claude-code: the CLI's charge arrives only on a turn's result, so a cut that ends inside a long turn shows no reported cost for it, not a cost of nothing");
  } else if (shape === "exec-tally") {
    notes.push(
      `codex: a request here is one CLI turn (codex exec), whose usage tallies every model call in it (the CLI reports no per-call figure), on the turn's last response record (${scan.envelopes} earlier one(s) carry none)` +
        (scan.derived > 0
          ? `; ${scan.derived} turn(s) recorded the thread's running total, so each is what it added to the previous total (runner/src/codex-usage.ts)${scan.regressions > 0 ? `, ${scan.regressions} drop(s) read as a new baseline` : ""}`
          : "; each turn's usage is the driver's own per-turn delta"),
    );
    notes.push("codex: responses per wake counts the response records, one per item the model answered with (a tool call, a message); several items can share one model call");
  }
  notes.push("uncached input is the prompt less its cache reads (cache writes are in it); reasoning, where reported, is part of output");
  if (scan.pauses.length > 0) notes.push(`${scan.pauses.length} pause(s): paused time is left out of every minute and per-hour figure, and of the --at-minutes cuts`);
  notes.push("active time is the wall clock less pause-to-resume spans; a process that died and was resumed with no pause record counts as active");
  if (scan.wakes.length === 0) notes.push("no wake records: wakes are harness turns (distinct turn numbers among the requests)");
  else notes.push("wakes are the run's wake records; asleep is their slept time over the active time");
  notes.push(`stall: a stretch longer than ${fmtAge(opts.stallMs)} with no game progress by stuck's rule (level, xp, turn-ins, money, items, map, ${t.moveYards} yd); time the record does not cover is never a stall${tracks.length > 1 ? "; the run stalls while every character does" : ""}`);
  const cost =
    "none" in price
      ? `not priced: ${price.none}`
      : `${price.id} at $${price.input}/$${price.output}/$${price.cacheRead}/$${price.cacheWrite} per M (in/out/cache read/write): ${price.basis}, at ${opts.priceAt !== null ? `--price-at ${iso(opts.priceAt).slice(0, 10)}` : `the run's start`} (infra/model-catalogue.json)`;

  if (opts.json) {
    out(
      strike(
        JSON.stringify({
          run: runId,
          model: row?.model ?? str(config["model"]),
          driver,
          usage: shape,
          source: via.line,
          started: start,
          ended: end,
          price: "none" in price ? { none: price.none } : { ...price, at: priceAt },
          windows,
          notes,
        }),
        token,
      ),
    );
    return 0;
  }
  const say = (text: string): void => out(cap(strike(text, token), opts.width));
  say(`${runId}: model requests over ${windows.map((w) => w.label).join(", ")}, UTC`);
  say(`model     ${row?.model ?? str(config["model"]) ?? "?"} · driver ${driver} · usage ${shape} · started ${iso(start)} · ${row?.ended_at != null ? `ended ${iso(end)}` : owned ? "live" : `last record ${iso(end)}`}`);
  say(`source    ${via.line}`);
  say(`price     ${cost}`);
  const colW = 16;
  const head = (label: string, cells: readonly string[]): void => say(`${label.padEnd(22)}${cells.map((c) => c.padStart(colW)).join("")}`);
  const cell = (f: (w: WindowFigures) => string): string[] => windows.map((w) => (w.reached ? f(w) : "not reached"));
  head("", windows.map((w) => w.label));
  head("span", cell((w) => `${clock(w.since).slice(6, 11)}–${clock(w.until).slice(6, 11)}`));
  head("active minutes", cell((w) => w.activeMinutes.toFixed(1)));
  head(shape === "exec-tally" ? "CLI turns (requests)" : "requests", cell((w) => String(w.requests)));
  head("  per hour", cell((w) => fmtPer(w.requestsPerHour)));
  head("uncached in/request", cell((w) => covered(fmtTok(w.uncachedInPerRequest), w.reported.input, w.requests)));
  head("cached in/request", cell((w) => covered(fmtTok(w.cachedInPerRequest), w.reported.cached, w.requests)));
  if (windows.some((w) => w.reported.write > 0)) head("cache write/request", cell((w) => covered(fmtTok(w.cacheWritePerRequest), w.reported.write, w.requests)));
  head("output/request", cell((w) => covered(fmtTok(w.outputPerRequest), w.reported.output, w.requests)));
  head("  reasoning/request", cell((w) => covered(fmtTok(w.reasoningPerRequest), w.reported.reasoning, w.requests)));
  const by = scan.wakes.length > 0 ? "wakes" : "turns";
  head(by, cell((w) => String(w.wakes.count)));
  head(`  per hour`, cell((w) => fmtPer(w.wakes.perHour)));
  head(`  requests per ${by === "wakes" ? "wake" : "turn"}`, cell((w) => fmtPer(w.wakes.requestsPer)));
  // A CLI turn is one request and one wake: what varies per wake is how many items the model answered with.
  if (shape === "exec-tally") head(`  responses per ${by === "wakes" ? "wake" : "turn"}`, cell((w) => fmtPer(w.wakes.responsesPer)));
  if (scan.wakes.length > 0) {
    head("  asleep", cell((w) => (w.wakes.asleepShare === null ? "—" : `${Math.round(w.wakes.asleepShare * 100)}%`)));
    head("  fired by", cell((w) => Object.entries(w.wakes.fired).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k, n]) => `${k} ${n}`).join(", ") || "—"));
  }
  head("cost reported", cell((w) => (w.reportedUsd === null ? "—" : scan.cli.length > 0 ? fmtUsd(w.reportedUsd) : covered(fmtUsd(w.reportedUsd), w.reported.cost, w.requests))));
  head("cost priced", cell((w) => (w.pricedUsd === null ? "—" : `${fmtUsd(w.pricedUsd)}${w.reported.output < w.requests ? "*" : ""}`)));
  if (tracks.length > 0) {
    head("levels per hour", cell((w) => fmtPer(w.levelsPerHour, 2)));
    head("turn-ins", cell((w) => String(w.quests)));
    head("  per hour", cell((w) => fmtPer(w.questsPerHour, 2)));
    head("stall minutes", cell((w) => `${w.stallMinutes.toFixed(1)}${w.uncoveredMinutes >= 0.05 ? ` (+${w.uncoveredMinutes.toFixed(1)}?)` : ""}`));
    if (tracks.length > 1 || tracks[0]!.name !== null) {
      for (const [i, tr] of tracks.entries()) {
        head(tr.name ?? "?", cell((w) => {
          const c = w.characters[i]!;
          return `L${c.levelFrom ?? "?"}→L${c.levelTo ?? "?"}`;
        }));
        head("  turn-ins", cell((w) => String(w.characters[i]!.quests)));
        head("  stall minutes", cell((w) => {
          const c = w.characters[i]!;
          return `${c.stallMinutes.toFixed(1)}${c.uncoveredMinutes >= 0.05 ? ` (+${c.uncoveredMinutes.toFixed(1)}?)` : ""}`;
        }));
      }
    }
  }
  if (windows.some((w) => w.reached && w.pricedUsd !== null && w.reported.output < w.requests)) notes.unshift("cost priced*: output priced only where it is known");
  if (tracks.length > 0) notes.push("(+N?) after stall minutes: minutes the record does not cover, judged neither way");
  for (const n of notes) say(`note      ${n}`);
  return 0;
}

// ------------------------------------------------------------------ CLI

// ------------------------------------------------------------------ inspect messages

/**
 * The parts of a turn's context message, in the order the runner writes them
 * (runner/src/context.ts `assembleContext`): the turn's number, the program
 * loop's [wake] block, the harness notices, the state summary (the HUD), the
 * event window and the scratchpad.
 */
export const MESSAGE_PARTS = ["turn", "wake", "notices", "hud", "events", "pad"] as const;
export type MessagePart = (typeof MESSAGE_PARTS)[number];

/** A context message cut into its parts: each part's text, "" for one it lacks. Pure; the parts join back to the message with their "\n\n". */
export function messageParts(text: string): Record<MessagePart, string> {
  const out: Record<MessagePart, string> = { turn: "", wake: "", notices: "", hud: "", events: "", pad: "" };
  const turnEnd = text.startsWith("[turn ") ? text.indexOf("\n\n") : -1;
  if (turnEnd < 0) {
    out.hud = text;
    return out;
  }
  out.turn = text.slice(0, turnEnd);
  // The events and the pad are the last two parts, each under its own header,
  // found forward from the HUD: the pad's text, last, may quote either header.
  const hudAt = text.indexOf("\n\n== ", turnEnd);
  const eventsAt = text.indexOf("\n\n[events", hudAt >= 0 ? hudAt : turnEnd);
  const padAt = text.indexOf("\n\n[scratchpad", eventsAt >= 0 ? eventsAt : hudAt >= 0 ? hudAt : turnEnd);
  const bodyEnd = eventsAt >= 0 ? eventsAt : padAt >= 0 ? padAt : text.length;
  if (padAt >= 0) out.pad = text.slice(padAt + 2);
  if (eventsAt >= 0) out.events = text.slice(eventsAt + 2, padAt >= 0 ? padAt : text.length);
  // Between the turn and the events: the wake, the notices, then the HUD.
  let at = turnEnd + 2;
  const noticesAt = text.indexOf("[harness notices]\n", at);
  const notices = noticesAt >= 0 && noticesAt < bodyEnd && (noticesAt === at || text.startsWith("\n\n", noticesAt - 2)) ? noticesAt : -1;
  if (text.startsWith("[wake ", at)) {
    const wakeEnd = notices >= 0 ? notices - 2 : hudStart(text, at, bodyEnd);
    out.wake = text.slice(at, wakeEnd);
    at = wakeEnd + 2;
  }
  if (notices >= 0) {
    const noticesEnd = hudStart(text, notices, bodyEnd);
    out.notices = text.slice(notices, noticesEnd);
    at = noticesEnd + 2;
  }
  out.hud = at < bodyEnd ? text.slice(at, bodyEnd) : "";
  return out;
}

/** Where the state summary starts after `from`: its `== ` header line, else the last "\n\n" before `end`; the index of that "\n\n". */
function hudStart(text: string, from: number, end: number): number {
  const header = text.indexOf("\n\n== ", from);
  if (header >= 0 && header < end) return header;
  const last = text.lastIndexOf("\n\n", end - 1);
  return last > from ? last : end;
}

/** A request record's context message: the slim record's `user`, else the last user message it carries. */
export function contextMessageOf(r: Record<string, unknown>): string | null {
  if (typeof r["user"] === "string") return r["user"];
  const messages = r["messages"];
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = obj(messages[i]);
    if (m["role"] === "user" && typeof m["content"] === "string") return m["content"];
  }
  return null;
}

export interface MessagesOptions extends Ctx, Window {
  last: number;
  /** Print the wake blocks themselves. */
  wakes: boolean;
}

/** One request's message as `messages` reads it. */
interface MessageRow {
  ts: number;
  turn: number | null;
  parts: Record<MessagePart, string>;
}

/** One wake's block: off its record (`block`) on a run that writes it, else off the yield result that carried it. */
interface WakeText {
  ts: number;
  text: string;
}

/** The read behind `messages`: the requests' messages cut into parts, and the wake blocks a record or a yield result holds. */
function messagesReducer(o: Window): { fn: RecFn; rows: MessageRow[]; wakes: WakeText[]; yields: WakeText[]; unread: number } {
  const a = { rows: [] as MessageRow[], wakes: [] as WakeText[], yields: [] as WakeText[], unread: 0, fn: (() => undefined) as RecFn };
  a.fn = (r) => {
    if (Number.isFinite(r.ts) && ((o.since !== null && r.ts < o.since) || (o.until !== null && r.ts > o.until))) return;
    if (r.t === "request") {
      const p = r.bytes < RAW_CAP_BYTES ? r.parse() : null;
      const text = p === null ? null : contextMessageOf(p);
      if (text === null) {
        a.unread++;
        return;
      }
      a.rows.push({ ts: r.ts, turn: intOf(p!["turn"]), parts: messageParts(text) });
    } else if (r.t === "wake") {
      const block = str(r.parse()?.["block"]);
      if (block !== null) a.wakes.push({ ts: r.ts, text: block });
    } else if (r.t === "tool_result" && r.name() === "yield") {
      const text = str(r.parse()?.["text"]);
      if (text !== null) a.yields.push({ ts: r.ts, text });
    }
  };
  return a;
}

/** What `messages` asks of the store: requests by their rows (their lines come whole, by number), wakes and yield results whole. */
const MESSAGES_SPEC: ReadSpec = {
  kinds: { request: { raw: "none" }, wake: { raw: "all" }, tool_result: { row: { names: ["yield"] }, raw: "all" } },
};

/** The same read off the store: request lines fetched whole by number, the newest `last` of them. */
async function storeMessages(store: InspectStore, runId: string, ext: Extent, w: Window, last: number, fn: RecFn): Promise<void> {
  if (ext.window === null) return;
  const rows: StoreRow[] = [];
  for (let lo = ext.window.lo; lo <= ext.window.hi; lo += MAX_PAGE_LINES) rows.push(...(await store.rows(runId, MESSAGES_SPEC, w, lo, Math.min(ext.window.hi + 1, lo + MAX_PAGE_LINES))));
  rows.sort((x, y) => x.l - y.l);
  const wanted = rows.filter((r) => r.k === "request").slice(-last).map((r) => r.l);
  const whole = new Map<number, string>();
  for (let i = 0; i < wanted.length; i += RAWS_PER_QUERY) for (const [l, raw] of await store.raws(runId, wanted.slice(i, i + RAWS_PER_QUERY))) whole.set(l, raw);
  for (const r of rows) {
    if (r.k === "request" && !whole.has(r.l)) continue;
    fn(storeRec(r.k === "request" ? { ...r, r: whole.get(r.l)! } : r, null));
  }
}

/**
 * `messages`: what each turn's context message carried, by part, in
 * characters: the turn's number, the [wake] block, the notices, the HUD, the
 * event window and the scratchpad, for the newest `--last` requests and their
 * mean. With `--wakes`, the wake blocks themselves, off the `wake` records
 * that carry them, else off the messages and the `yield` results that did.
 */
export async function inspectMessages(runId: string, opts: MessagesOptions, out: Out): Promise<number> {
  const run = trajectoryOf(runId, opts, out);
  if (run === null) return 1;
  const via = await viaFor(opts, runId, run.dir, opts);
  const m = messagesReducer(opts);
  if (via.store !== null) await storeMessages(via.store, runId, via.ext, opts, opts.last, m.fn);
  else fileForward(run.path, m.fn);
  const say = (text: string): void => out(cap(strike(text, run.token), opts.width));
  const rows = m.rows.slice(-opts.last);
  say(`${runId}: each request's context message by part, in characters, ${windowPhrase(opts) || "whole run"}, the last ${rows.length}, UTC`);
  say(`source    ${via.line}`);
  const head = ["", "turn", "total", ...MESSAGE_PARTS.slice(1)];
  const line = (cells: string[]): string => cells.map((c, i) => (i === 0 ? c.padEnd(9) : c.padStart(8))).join("");
  say(line(head));
  const totals: Record<MessagePart, number> = { turn: 0, wake: 0, notices: 0, hud: 0, events: 0, pad: 0 };
  let all = 0;
  for (const r of rows) {
    const sizes = MESSAGE_PARTS.map((k) => r.parts[k].length);
    const total = sizes.reduce((n, x) => n + x, 0) + 2 * (sizes.filter((x) => x > 0).length - 1);
    MESSAGE_PARTS.forEach((k, i) => (totals[k] += sizes[i]!));
    all += total;
    say(line([clock(r.ts), r.turn === null ? "?" : String(r.turn), fmtChars(total), ...sizes.slice(1).map((x) => fmtChars(x))]));
  }
  if (rows.length > 0) {
    const n = rows.length;
    say(line(["mean", "", fmtChars(Math.round(all / n)), ...MESSAGE_PARTS.slice(1).map((k) => fmtChars(Math.round(totals[k] / n)))]));
    say(`share     ${MESSAGE_PARTS.slice(1).map((k) => `${k} ${all > 0 ? Math.round((100 * totals[k]) / all) : 0}%`).join(" · ")}`);
  } else say("(no request with a readable message in the window)");
  if (m.unread > 0) say(`${m.unread} request(s) carried no message this view can read`);
  if (opts.wakes) {
    // A run that writes the block on its records has them all there; an older run's are in the messages and the yield results.
    const blocks: WakeText[] =
      m.wakes.length > 0 ? m.wakes : [...m.rows.filter((r) => r.parts.wake !== "").map((r) => ({ ts: r.ts, text: r.parts.wake })), ...m.yields].sort((x, y) => x.ts - y.ts);
    say(`wakes     ${blocks.length} block(s)${m.wakes.length > 0 ? ", off the wake records" : ", off the messages and the yield results"}`);
    for (const b of blocks.slice(-opts.last)) {
      say(`--- ${clock(b.ts)}`);
      for (const l of b.text.split("\n")) say(l);
    }
  }
  return 0;
}

const USAGE = `usage: bun infra/inspect-run.ts live
       bun infra/inspect-run.ts run <run-id> [--since D] [--until D]
       bun infra/inspect-run.ts trajectory <run-id> [--last N | --next N] [--errors] [--grep RE] [--all] [--since D] [--until D]
       bun infra/inspect-run.ts tools <run-id> [--since D] [--until D]
       bun infra/inspect-run.ts pad <run-id> [--since D] [--until D] [--last N] | --at D
       bun infra/inspect-run.ts stuck [<run-id>] [--window D] [--until D] [--move N] [--max-gap D] [--repeat N] [--hints N] [--schema N] [--restarts N] [--asks N]
       bun infra/inspect-run.ts session <run-id> [--stream events|calls] [--character NAME] [--kind K[,K]] [--grep RE] [--last N | --next N] [--since D] [--until D]
       bun infra/inspect-run.ts requests <run-id> [--since D] [--until D] [--at-level N[,N]] [--at-minutes N[,N]] [--stall D] [--price-at DAY] [--catalogue FILE] [--json]
       bun infra/inspect-run.ts messages <run-id> [--since D] [--until D] [--last N] [--wakes]
common: [--runs-dir DIR] (else WRATHBENCH_RUNS_DIR, else data/runs) [--width N] [--files]; D is 90s, 30m, 2h, 1d, epoch ms or ISO
<run-id> may be a fan-out character's session id, <run-id>~<Name>: session reads that character alone (--character), the rest the run
--next N: the first N items from --since (or the file's start) instead of the last N
--files: read the files, not ClickHouse (CLICKHOUSE_URL); a live run's run.sqlite is still not opened
stuck: with no run id, every run with a live owner; --window and --max-gap are durations (2h, 15m), the rest whole numbers
session: a v1 run's record, events by default; a fan-out run's characters together unless --character; --kind key shows the restating rows
requests: per request, wake and hour over the run (or --since/--until) and up to each cut from its start: --at-level (the first character to reach it),
  --at-minutes (active minutes, pauses left out); --stall is the shortest stall (default 5m); --price-at re-prices at that day's rates; --json for a script
messages: each request's context message by part (turn, wake, notices, hud, events, pad) in characters, the last N and their mean; --wakes prints the wake blocks`;

/** `inspect stuck`'s threshold flags, each with the threshold it sets and whether it is a duration. */
const STUCK_FLAGS: readonly (readonly [string, keyof StuckThresholds, "duration" | "count"])[] = [
  ["--window", "windowMs", "duration"],
  ["--move", "moveYards", "count"],
  ["--max-gap", "maxGapMs", "duration"],
  ["--repeat", "repeatErrors", "count"],
  ["--hints", "hintTally", "count"],
  ["--schema", "schemaErrors", "count"],
  ["--restarts", "restarts", "count"],
  ["--asks", "asks", "count"],
];

/** A duration: `90s`, `30m`, `2h`, `1d`; NaN when it is not one. */
export function parseDuration(raw: string): number {
  const m = /^(\d+(?:\.\d+)?)(s|m|h|d)$/.exec(raw);
  if (m === null) return Number.NaN;
  return Number(m[1]) * { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "s" | "m" | "h" | "d"];
}

/** The flags each command takes, beyond the common ones; any other is a usage error, never ignored. */
const COMMAND_FLAGS: Record<string, readonly string[]> = {
  live: [],
  run: ["--since", "--until"],
  trajectory: ["--last", "--next", "--errors", "--grep", "--all", "--since", "--until"],
  tools: ["--since", "--until"],
  pad: ["--since", "--until", "--last", "--at"],
  stuck: ["--until", ...STUCK_FLAGS.map(([f]) => f)],
  session: ["--stream", "--character", "--kind", "--grep", "--last", "--next", "--since", "--until"],
  requests: ["--since", "--until", "--at-level", "--at-minutes", "--stall", "--price-at", "--catalogue", "--json"],
  messages: ["--since", "--until", "--last", "--wakes"],
};
const COMMON_FLAGS = new Set(["--runs-dir", "--width", "--files"]);
const VALUED = new Set([
  "--since",
  "--until",
  "--at",
  "--last",
  "--next",
  "--grep",
  "--width",
  "--runs-dir",
  "--stream",
  "--character",
  "--kind",
  "--at-level",
  "--at-minutes",
  "--stall",
  "--price-at",
  "--catalogue",
  ...STUCK_FLAGS.map(([f]) => f),
]);

/**
 * A view of the run asked for by one character's session id: true, with a line
 * saying the view is the run's, when the run has that character; false, having
 * said which characters it has, when it does not. A run not found is the
 * view's to report.
 */
function sessionOfRun(runsDir: string, runId: string, character: string, out: Out): boolean {
  const dir = findRunDir(runsDir, runId);
  if (dir === null) return true;
  const refs = sessionsOf(dir);
  const ref = refs.find((r) => r.character?.toLowerCase() === character.toLowerCase());
  if (ref === undefined) {
    out(`${runId} has no character ${character}${refs.length > 0 ? `: ${refs.map((r) => r.character ?? "(unnamed)").join(", ")}` : ""}`);
    return false;
  }
  const id = `${runId}${FANOUT_SEP}${ref.character}`;
  out(`${id} is ${ref.character}'s session: this view is the run's, every character's together; session ${id} is ${ref.character}'s alone`);
  return true;
}

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
      err(`${VALUED.has(a) || a === "--errors" || a === "--all" || a === "--json" ? `${a} does not apply to ${command}` : `unknown flag ${a}`}\n${USAGE}`);
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
    if (command === "stuck") {
      const thresholds: StuckThresholds = { ...STUCK_DEFAULTS };
      for (const [f, key, kind] of STUCK_FLAGS) {
        if (!flags.has(f)) continue;
        const raw = flags.get(f) as string;
        const v = kind === "duration" ? parseDuration(raw) : Number(raw);
        if (!(Number.isFinite(v) && v > 0) || (kind === "count" && !Number.isInteger(v))) {
          err(`${f} is ${kind === "duration" ? "a duration: 90s, 30m, 2h or 1d" : "a whole number of at least 1"}`);
          return 2;
        }
        thresholds[key] = v;
      }
      if (positional.length === 0) return await inspectStuckLive({ ...base, thresholds }, out);
      const target = positional.length === 1 ? parseRunArg(positional[0]!) : null;
      if (target === null) {
        err(`not one run id: ${positional.join(" ")}`);
        return 2;
      }
      if (target.character !== null && !sessionOfRun(runsDir, target.runId, target.character, out)) return 1;
      return await inspectStuck(target.runId, { ...base, until: window.until, thresholds }, out);
    }
    const target = positional.length === 1 ? parseRunArg(positional[0]!) : null;
    if (target === null) {
      err(positional.length === 0 ? `${command} needs a run id\n${USAGE}` : `not one run id: ${positional.join(" ")}`);
      return 2;
    }
    const runId = target.runId;
    // A character's session id: `session` reads that character's record; every
    // other view is the run's, whose trajectory is the one agent's.
    // `--json` keeps stdout to the one object, so the line saying so goes to stderr.
    if (target.character !== null && command !== "session" && !sessionOfRun(runsDir, runId, target.character, flags.has("--json") ? err : out)) return 1;
    const last = count("--last");
    const next = count("--next");
    for (const [f, n] of [["--last", last], ["--next", next]] as const) {
      if (n !== null && Number.isNaN(n)) {
        err(`${f} is a whole number from 1 to ${MAX_LAST}`);
        return 2;
      }
    }
    if (command === "run") return await inspectRun(runId, { ...base, ...window }, out);
    if (command === "requests") {
      const list = (f: string): number[] | null => {
        if (!flags.has(f)) return [];
        const xs = (flags.get(f) as string).split(",").map((x) => Number(x.trim()));
        return xs.length > 0 && xs.every((x) => Number.isInteger(x) && x >= 1) ? xs : null;
      };
      const atLevels = list("--at-level");
      const atMinutes = list("--at-minutes");
      for (const [f, xs] of [["--at-level", atLevels], ["--at-minutes", atMinutes]] as const) {
        if (xs === null) {
          err(`${f} is a whole number of at least 1, or several comma-separated`);
          return 2;
        }
      }
      const stallMs = flags.has("--stall") ? parseDuration(flags.get("--stall") as string) : STALL_DEFAULT_MS;
      if (!(stallMs > 0)) {
        err("--stall is a duration: 90s, 5m, 1h");
        return 2;
      }
      let priceAt: number | null = null;
      if (flags.has("--price-at")) {
        const day = flags.get("--price-at") as string;
        priceAt = /^\d{4}-\d{2}-\d{2}$/.test(day) ? Date.parse(`${day}T00:00:00Z`) : Number.NaN;
        if (!Number.isFinite(priceAt)) {
          err("--price-at is a day, YYYY-MM-DD");
          return 2;
        }
      }
      return await inspectRequests(
        runId,
        { ...base, ...window, atLevels: atLevels!, atMinutes: atMinutes!, stallMs, priceAt, catalogue: (flags.get("--catalogue") as string | undefined) ?? null, json: flags.has("--json") },
        out,
      );
    }
    if (command === "tools") return await inspectTools(runId, { ...base, ...window }, out);
    if (command === "messages") return await inspectMessages(runId, { ...base, ...window, last: last ?? DEFAULT_LAST, wakes: flags.has("--wakes") }, out);
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
    if (command === "session") {
      const stream = (flags.get("--stream") as string | undefined) ?? "events";
      if (!(SESSION_STREAMS as readonly string[]).includes(stream)) {
        err(`--stream is ${SESSION_STREAMS.join(" or ")}\n${USAGE}`);
        return 2;
      }
      const flagged = (flags.get("--character") as string | undefined) ?? null;
      if (flagged !== null && !CHARACTER_NAME.test(flagged)) {
        err(`--character is a character's name, letters only`);
        return 2;
      }
      if (flagged !== null && target.character !== null && flagged.toLowerCase() !== target.character.toLowerCase()) {
        err(`${positional[0]} is ${target.character}'s session; --character ${flagged} names another`);
        return 2;
      }
      const character = flagged ?? target.character;
      const kindList = flags.has("--kind") ? (flags.get("--kind") as string).split(",").map((k) => k.trim()).filter((k) => k !== "") : null;
      if (kindList !== null && kindList.length === 0) {
        err(`--kind names one kind or more, comma-separated\n${USAGE}`);
        return 2;
      }
      return await inspectSession(
        runId,
        { ...base, ...window, stream: stream as SessionStream, character, kinds: kindList === null ? null : new Set(kindList), grep, last: next ?? last ?? DEFAULT_LAST, forward: next !== null },
        out,
      );
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
