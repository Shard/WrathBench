#!/usr/bin/env bun
/**
 * `bun wb inspect live|run|trajectory|tools|pad`: read-only views of the runs
 * on the data volume, every one bounded by default.
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
 * D is `90s`, `30m`, `2h`, `1d`, epoch ms or an ISO time; `--since` and
 * `--until` together are a window, found by bisecting the file on its clock
 * rather than reading it from the top. The runs directory is `--runs-dir`,
 * else WRATHBENCH_RUNS_DIR, else `data/runs`.
 *
 * A run is live when its row has neither a termination nor a pause (a paused
 * run is unterminated too, which is why the pause counts), and it has a live
 * owner only while its heartbeat is fresh: an unterminated run whose heartbeat
 * went cold lost its process. Nothing here ever prints a whole trajectory line,
 * `meta.json`'s config or the row's `config_json`, and every line it prints has
 * the run's session token struck, which older trajectories still carry.
 *
 * Import-free on purpose: `bun:sqlite` and `node:*` only. So the same file runs
 * unchanged wherever the runs are: in the runner pod through `bun wb`, from
 * stdin into a pod whose image predates it (`kubectl exec -i … -- bun run - run
 * <id> < infra/inspect-run.ts`), or against a copy here. It also starts in
 * milliseconds. The constants it shares with the runner are pinned by its test.
 */

import { Database } from "bun:sqlite";
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

/** runner/src/trajectory.ts: a heartbeat older than this has no owner. */
export const HEARTBEAT_DEAD_MS = 120_000;
/** runner/src/config.ts: below this a token is a pre-hardening run id, never struck. */
export const MIN_TOKEN_LENGTH = 32;
/** mcp/src/redact.ts. */
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

interface RunRow {
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

interface StateRow {
  ts: number;
  level: number | null;
  xp: number | null;
  money: number | null;
  quests_completed: number | null;
  turn: number | null;
  zone: number | null;
  next_level_xp?: number | null;
}

function openDb(dir: string): Database | null {
  const path = join(dir, "run.sqlite");
  if (!existsSync(path)) return null;
  try {
    return new Database(path, { readonly: true });
  } catch {
    return null;
  }
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
  if (row === null) return null;
  const s = (k: string): string | null => str(row[k]);
  const n = (k: string): number | null => (typeof row[k] === "number" ? (row[k] as number) : null);
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

export type VerdictState = "live" | "ownerless" | "paused" | "terminated" | "no-row";

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
 * heartbeat is cold or gone has lost its owner. Pure.
 */
export function verdictOf(row: Pick<RunRow, "termination_reason" | "termination_detail" | "pause_reason"> | null, heartbeat: number | null, now: number): Verdict {
  const heartbeatAgeMs = heartbeat === null ? null : now - heartbeat;
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

function parseLine(buf: Buffer, start: number, end: number): Record<string, unknown> | null {
  try {
    const v = JSON.parse(buf.toString("utf8", start, end)) as unknown;
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

function inWindow(ts: number, w: Window): boolean {
  return (w.since === null || ts >= w.since) && (w.until === null || ts <= w.until);
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

function traceLine(db: Database, runId: string, now: number): string {
  if (!hasTable(db, "trace")) return "no trace table (a run from before the recorder)";
  const kinds = db.query("SELECT kind, count(*) AS n FROM trace GROUP BY kind").all() as { kind: string; n: number }[];
  if (kinds.length === 0) return "no rows";
  const total = kinds.reduce((a, k) => a + k.n, 0);
  const newest = (db.query("SELECT max(ts) AS m FROM trace WHERE run_id = ?").get(runId) as { m: number | null }).m;
  const dict = hasTable(db, "trace_dict") ? (db.query("SELECT count(*) AS n FROM trace_dict").get() as { n: number }).n : 0;
  const byKind = kinds.sort((a, b) => b.n - a.n).map((k) => `${k.kind} ${k.n}`).join(", ");
  return `${total} rows (${byKind}), newest ${newest === null ? "?" : `${iso(newest)} (${fmtAge(now - newest)} ago)`}; dict ${dict}`;
}

function lastState(db: Database): StateRow | null {
  if (!hasTable(db, "state")) return null;
  const have = columns(db, "state");
  const pick = (c: string): string => (have.has(c) ? c : `NULL AS ${c}`);
  const cols = ["ts", "level", "xp", "money", "quests_completed", "turn", "zone", "next_level_xp"];
  return db.query(`SELECT ${cols.map(pick).join(", ")} FROM state ORDER BY ts DESC LIMIT 1`).get() as StateRow | null;
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

function questLine(db: Database, runId: string): string | null {
  if (!hasTable(db, "state") || !columns(db, "state").has("quests_completed")) return null;
  const rows = db
    .query("SELECT ts, quests_completed AS quests FROM state WHERE run_id = ? AND quests_completed IS NOT NULL ORDER BY ts")
    .all(runId) as { ts: number; quests: number | null }[];
  const q = questStretches(rows);
  if (q === null) return null;
  const restarts = q.stretches.length - 1;
  const newest = q.stretches[q.stretches.length - 1]!.last;
  const head = `${q.total} over the run${restarts > 0 ? `, summed across ${restarts} restart(s); the newest sample reads ${newest}` : ""}`;
  return restarts > 0 ? `${head} · ${q.stretches.map((s) => `from ${clock(s.from).slice(0, 11)} ${s.last}`).join(" · ")}` : head;
}

interface Activity {
  records: number;
  kinds: Map<string, number>;
  last: { ts: number; t: string } | null;
  snippetErrors: Map<string, number>;
  toolErrors: Map<string, number>;
  harness: Map<string, number>;
}

/** One forward pass over the trajectory: counts by kind, errors by class, harness notices by kind. */
function scanActivity(path: string, window: Window, token: string | null): Activity {
  const { since, until } = window;
  const a: Activity = { records: 0, kinds: new Map(), last: null, snippetErrors: new Map(), toolErrors: new Map(), harness: new Map() };
  const isError = Buffer.from('"isError":true');
  forwardLines(path, (buf, s, e) => {
    const h = headOf(buf, s, e);
    if (until !== null && h.ts > until) return true;
    if (since !== null && !(h.ts >= since)) return;
    a.records++;
    count(a.kinds, h.t);
    if (Number.isFinite(h.ts) && (a.last === null || h.ts >= a.last.ts)) a.last = h;
    if (h.t === "snippet_result" || h.t === "tool_result") {
      const head = buf.subarray(s, Math.min(e, s + 400));
      if (head.indexOf(isError) < 0) return;
      // A result is small next to a request; past 256 KB, read its head only.
      const r = e - s < 256 << 10 ? parseLine(buf, s, e) : null;
      if (h.t === "snippet_result") count(a.snippetErrors, errorClass(r === null ? "" : strike(textOf(r["text"]), token)));
      else count(a.toolErrors, typeof r?.["name"] === "string" ? (r["name"] as string) : "?");
    } else if (h.t === "harness") {
      const r = e - s < 64 << 10 ? parseLine(buf, s, e) : null;
      count(a.harness, typeof r?.["kind"] === "string" ? (r["kind"] as string) : "?");
    }
  }, since === null ? 0 : seekTime(path, since));
  return a;
}

export function inspectRun(runId: string, opts: Options & Window, out: Out): number {
  const dir = findRunDir(opts.runsDir, runId);
  if (dir === null) {
    out(`no run ${runId} under ${opts.runsDir} (nor its ${ARCHIVE_DIR}/)`);
    return 1;
  }
  const meta = readMeta(dir);
  const token = strikableToken(meta, runId);
  const say = (label: string, text: string): void => out(`${label.padEnd(10)} ${cap(strike(text, token), opts.width - 11)}`);
  const db = openDb(dir);
  try {
    const row = db === null ? null : readRow(db, runId);
    const verdict = verdictOf(row, heartbeatAt(dir), opts.now);
    say("run", `${runId}${dir.includes(`/${ARCHIVE_DIR}/`) ? " (archived)" : ""}`);
    say("verdict", describeVerdict(verdict, meta, opts.now));

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

    const st = db === null ? null : lastState(db);
    if (st === null) say("level", "no state sample yet");
    else {
      const parts = [
        `L${st.level ?? "?"} ${st.xp ?? "?"}xp${st.next_level_xp != null ? ` of ${st.next_level_xp}` : ""}`,
        money(st.money) !== null ? `money ${money(st.money)}` : null,
        st.zone != null ? `zone ${st.zone}` : null,
        st.turn != null ? `turn ${st.turn}` : null,
        `sampled ${fmtAge(opts.now - st.ts)} ago`,
      ].filter((b): b is string => b !== null);
      say("level", parts.join(" · "));
    }
    // The newest sample's count is its process's, so the run's is its own line.
    const quests = db === null ? null : questLine(db, runId);
    if (quests !== null) say("quests", quests);

    const traj = join(dir, "trajectory.jsonl");
    if (!existsSync(traj)) say("activity", "no trajectory.jsonl");
    else {
      const a = scanActivity(traj, opts, token);
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
    say("trace", db === null ? "no run.sqlite" : traceLine(db, runId, opts.now));
    say("nearby", nearbyLine(dir, opts.now));
    return 0;
  } finally {
    db?.close();
  }
}

// ------------------------------------------------------------------ inspect live

/**
 * Every run with a heartbeat file: a stat per run directory and nothing more,
 * then the row of only those few. A run that paused or ended cleanly removed
 * its heartbeat, so it is not here; one killed hard left a cold one, and shows.
 */
export function inspectLive(opts: Options, out: Out): number {
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
  const owned = found.filter((f) => opts.now - f.hb < HEARTBEAT_DEAD_MS).length;
  out(`${owned} run(s) with a live owner, ${found.length - owned} with a cold heartbeat, of ${names.length} entries under ${opts.runsDir}`);
  for (const f of found) {
    const db = openDb(f.dir);
    try {
      const row = db === null ? null : readRow(db, f.id);
      const v = verdictOf(row, f.hb, opts.now);
      const st = db === null ? null : lastState(db);
      const level = st === null ? "L?" : `L${st.level ?? "?"} ${st.xp ?? "?"}xp`;
      const age = row?.started_at != null ? `up ${fmtAge(opts.now - row.started_at)}` : "";
      const reason = v.reason !== null ? ` ${v.reason}` : "";
      out(cap(`  ${f.id}  ${v.state}${reason}  hb ${fmtAge(opts.now - f.hb)}  ${level}  ${age}  ${row?.model ?? ""}`, opts.width));
    } finally {
      db?.close();
    }
  }
  return 0;
}

// ------------------------------------------------------------------ inspect trajectory

export interface TrajectoryOptions extends Options, Window {
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
/** Record kinds too big to be worth parsing for a line of their own. */
const SIZE_ONLY = new Set(["request", "events_served", "claude_system", "driver", "codex_result", "actions"]);

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

export function inspectTrajectory(runId: string, opts: TrajectoryOptions, out: Out): number {
  const dir = findRunDir(opts.runsDir, runId);
  if (dir === null) {
    out(`no run ${runId} under ${opts.runsDir} (nor its ${ARCHIVE_DIR}/)`);
    return 1;
  }
  const path = join(dir, "trajectory.jsonl");
  if (!existsSync(path)) {
    out(`${runId} has no trajectory.jsonl`);
    return 1;
  }
  const token = strikableToken(readMeta(dir), runId);
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

  const onLine: LineFn = (buf, s, e) => {
    const h = headOf(buf, s, e);
    if (Number.isFinite(h.ts)) {
      // Past the window's far edge in the direction of reading: stop. On its near side: skip.
      if (opts.since !== null && h.ts < opts.since) return opts.forward ? undefined : true;
      if (opts.until !== null && h.ts > opts.until) return opts.forward ? true : undefined;
    }
    if (opts.all) {
      if (opts.errors && h.t !== "snippet_result" && h.t !== "tool_result") return;
      if (SIZE_ONLY.has(h.t) || e - s > 256 << 10) {
        if (opts.grep !== null || opts.errors) return;
        return keep({ ts: h.ts, error: false, text: `${clock(h.ts)}  ${h.t}  (${fmtBytes(e - s)})` });
      }
      const r = parseLine(buf, s, e);
      if (r === null) return;
      // --grep filters every kind, meta included: a kept meta line would spend the --last budget.
      if (!grepOk(strike(buf.toString("utf8", s, e), token))) return;
      if (h.t === "meta") {
        return keep({ ts: h.ts, error: false, text: `${clock(h.ts)}  meta  run ${String(r["runId"] ?? "?")} harness ${String(r["harnessVersion"] ?? "?")}` });
      }
      const line = compact(r, w, token);
      const error = r["isError"] === true;
      return keep({ ts: h.ts, error, text: `${clock(h.ts)}  ${h.t}  ${line}` });
    }
    switch (h.t) {
      case "snippet":
      case "snippet_result": {
        const r = parseLine(buf, s, e);
        if (r === null) return;
        const pair = meet(pendingSnippet, firstSide, callKey(r), h.t === "snippet" ? "call" : "result", r);
        const it = pair === null ? null : snippetItem(pair.call, pair.res);
        return it === null ? undefined : keep(it);
      }
      case "tool_call":
      case "tool_result": {
        const r = parseLine(buf, s, e);
        if (r === null) return;
        // A snippet's call is shown by its snippet record, which carries the same code.
        if (h.t === "tool_call" && r["name"] === "run_snippet") return;
        const pair = meet(pendingTool, firstSide, callKey(r), h.t === "tool_call" ? "call" : "result", r);
        const it = pair === null ? null : toolItem(pair.call, pair.res);
        return it === null ? undefined : keep(it);
      }
      default: {
        if (!NOTICES.has(h.t) || opts.errors || e - s > 64 << 10) return;
        const r = parseLine(buf, s, e);
        if (r === null) return;
        const line = compact(r, w, token);
        if (!grepOk(line)) return;
        return keep({ ts: h.ts, error: false, text: `${clock(h.ts)}  ${h.t}  ${line}` });
      }
    }
  };
  if (opts.forward) forwardLines(path, onLine, opts.since === null ? 0 : seekTime(path, opts.since));
  else backwardLines(path, onLine, opts.until === null ? undefined : offsetAfter(path, opts.until));
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
  return 0;
}

// ------------------------------------------------------------------ what tools and pad read

/** mcp/src/scratchpad.ts. */
export const SCRATCHPAD_MAX_CHARS = 32_000;
/** The words of every over-cap refusal after the op it names (`overCapText`, mcp/src/scratchpad.ts). */
export const PAD_REFUSED = "refused: the scratchpad would be ";
const PAD_REFUSED_BYTES = Buffer.from(PAD_REFUSED);
const PAD_REFUSAL = /([\w.]+) refused: the scratchpad would be (\d+) chars/;
/** The starts of the reflect tool's two fixed refusals (runner/src/reflect.ts). */
export const REFLECT_NOT_RESTING_HEAD = "Reflection needs rest or a flight";
export const REFLECT_ALREADY_USED_HEAD = "You already reflected";
/** The context's pad section when the pad is empty (runner/src/context.ts, `assembleContext`). */
export const PAD_EMPTY = "(empty — write your plan and durable facts with write_scratchpad)";
/** mcp/src/scratchpad.ts: the old cut's marker, stripped wherever a write puts it. */
const LEGACY_TRUNCATION_MARKER = /\n{0,2}\[scratchpad truncated at \d+ chars\]/g;
/** The pad tools' alias keys (runner/src/tools.ts, `ARG_ALIASES`): a logged call can carry either spelling. */
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
const PAD_TOOLS = new Set(Object.keys(PAD_ARG_ALIASES));
/** A snippet that writes the pad: found in its code, so a write behind a branch it never took still counts. */
const SNIPPET_PAD_WRITE = /\bscratchpad\s*\.\s*(write|append)\s*\(/g;
const SCRATCHPAD_BYTES = Buffer.from("scratchpad");

/** `scratchpadSizeLabel` (mcp/src/scratchpad.ts): the size every turn's context shows, "31.2k/32k". */
export function padSizeLabel(chars: number): string {
  const size = `${(Math.floor(chars / 100) / 10).toFixed(1)}k/${SCRATCHPAD_MAX_CHARS / 1000}k`;
  return chars > SCRATCHPAD_MAX_CHARS ? `${size}, over the cap` : size;
}

const PAD_HEAD = /^\n\n\[scratchpad(?: ([^\]\n]*))?\]\n/;
/** The pad section's header as it sits inside a JSON string: its newlines escaped. */
const PAD_HEADER_JSON = Buffer.from("\\n\\n[scratchpad");

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
function snippetPadWrites(buf: Buffer, s: number, e: number): string | null {
  if (e - s > 4 << 20 || buf.subarray(s, e).indexOf(SCRATCHPAD_BYTES) < 0) return null;
  const code = textOf(parseLine(buf, s, e)?.["code"]);
  const found = new Set([...code.matchAll(SNIPPET_PAD_WRITE)].map((m) => m[1]!));
  if (found.size === 0) return null;
  return ["write", "append"].filter((k) => found.has(k)).join("+");
}

const NAME_IN_HEAD = /"name":"([^"\\]{1,64})"/;
const ADAPTER_IN_HEAD = /"adapter":"([^"\\]{1,200})"/;

function headString(buf: Buffer, s: number, e: number): string {
  return buf.toString("latin1", s, Math.min(e, s + 400));
}

/** The run's driver: the row's, else meta's, else a request's adapter label up to its colon (a copy without run.sqlite). */
function driverName(adapter: string | null, dir: string, runId: string): string {
  const db = openDb(dir);
  try {
    const fromRow = db === null ? null : (readRow(db, runId)?.driver ?? null);
    return fromRow ?? str(obj(readMeta(dir)?.["config"])["driver"]) ?? adapter?.split(":")[0] ?? "?";
  } finally {
    db?.close();
  }
}

/** Characters as a short figure: 950, 12.3k. */
function fmtChars(n: number | null): string {
  if (n === null) return "?";
  return n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`;
}

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

/** One forward pass over the window: every tool's calls and results, the reflect gate, the pad's writers. */
export function scanTools(path: string, w: Window): ToolsScan {
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
  forwardLines(
    path,
    (buf, s, e) => {
      const h = headOf(buf, s, e);
      if (Number.isFinite(h.ts)) {
        if (w.until !== null && h.ts > w.until) return true;
        if (w.since !== null && h.ts < w.since) return;
        a.first ??= h.ts;
        a.last = h.ts;
      }
      switch (h.t) {
        case "request":
          a.requests++;
          a.adapter ??= ADAPTER_IN_HEAD.exec(headString(buf, s, e))?.[1] ?? null;
          return;
        case "response":
          a.responses++;
          return;
        case "tool_call": {
          const name = NAME_IN_HEAD.exec(headString(buf, s, e))?.[1] ?? "?";
          tally(name).calls++;
          return;
        }
        case "snippet": {
          const which = snippetPadWrites(buf, s, e);
          if (which !== null) count(a.snippetPad, which);
          return;
        }
        case "snippet_result":
        case "tool_result": {
          const head = headString(buf, s, e);
          const name = NAME_IN_HEAD.exec(head)?.[1] ?? (h.t === "snippet_result" ? "run_snippet" : "?");
          const isError = head.includes('"isError":true');
          const t = tally(name);
          t.results++;
          const refusal = padRefusalIn(buf, s, e);
          if (refusal !== null) count(a.padRefusals, refusal.op);
          // Results are small next to a request; past 256 KB, the head says enough.
          const r = isError || name === "reflect" ? (e - s < 256 << 10 ? parseLine(buf, s, e) : null) : null;
          const text = textOf(r?.["text"]);
          if (name === "reflect") {
            // The marker came later than the tool: a result without it is the same reflect call, older.
            if (r?.["reflect"] === true) a.reflect.marked++;
            if (!isError) a.reflect.granted++;
            else if (text.startsWith(REFLECT_NOT_RESTING_HEAD)) a.reflect.notResting++;
            else if (text.startsWith(REFLECT_ALREADY_USED_HEAD)) a.reflect.alreadyUsed++;
            else a.reflect.otherRefusal++;
          }
          if (isError) {
            t.errors++;
            count(t.classes, refusal !== null ? "over cap" : r === null ? "(a result over 256 KB, unread)" : toolErrorClass(name, text));
          }
          return;
        }
        case "reflect_window": {
          const r = parseLine(buf, s, e);
          if (r?.["event"] === "open") {
            a.windows.opens++;
            openAt = h.ts;
          } else if (r?.["event"] === "close") {
            count(a.windows.closes, String(r["reason"] ?? "?"));
            if (openAt !== null && h.ts - openAt < 1000) a.windows.zeroLength++;
            openAt = null;
          }
          return;
        }
      }
    },
    w.since === null ? 0 : seekTime(path, w.since),
  );
  a.windows.openAtEnd = openAt !== null;
  return a;
}

export function inspectTools(runId: string, opts: Options & Window, out: Out): number {
  const run = trajectoryOf(runId, opts, out);
  if (run === null) return 1;
  const a = scanTools(run.path, opts);
  const say = (text: string): void => out(cap(strike(text, run.token), opts.width));
  const span = a.first === null ? "no records" : `${clock(a.first)} to ${clock(a.last!)}`;
  say(`${runId}: tool calls by name, ${windowPhrase(opts) || "whole run"} (${span}), UTC`);
  say(`driver    ${driverName(a.adapter, run.dir, runId)} · ${a.requests} request(s) · ${a.responses} model response(s)`);
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
  const padTools = ["write_scratchpad", "edit_scratchpad"].map((n) => {
    const t = a.tools.get(n);
    const over = t?.classes.get("over cap") ?? 0;
    return `${n} ${t?.results ?? 0}${over > 0 ? ` (${over} over cap)` : ""}`;
  });
  const snippetOver = [...a.padRefusals].filter(([op]) => op.startsWith("scratchpad.")).reduce((x, [, n]) => x + n, 0);
  const inSnippets = a.snippetPad.size === 0 ? "none" : topCounts(a.snippetPad, 3);
  say(`pad       tools: ${padTools.join(", ")} · snippets calling scratchpad.write/append: ${inSnippets}${snippetOver > 0 ? ` (${snippetOver} refused over cap)` : ""}`);
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

/** One forward pass over the window: the pad's size wherever a record says it, and every write. */
export function scanPad(path: string, w: Window): PadScan {
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
  forwardLines(
    path,
    (buf, s, e) => {
      const h = headOf(buf, s, e);
      if (Number.isFinite(h.ts)) {
        if (w.until !== null && h.ts > w.until) return true;
        if (w.since !== null && h.ts < w.since) return;
        p.first ??= h.ts;
        p.last = h.ts;
      }
      switch (h.t) {
        case "request": {
          p.requests++;
          p.adapter ??= ADAPTER_IN_HEAD.exec(headString(buf, s, e))?.[1] ?? null;
          const pad = padOfRequest(buf, s, e);
          if (pad === null) return;
          p.requestsWithPad++;
          p.samples.push({ ts: h.ts, chars: pad.length });
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
          const which = snippetPadWrites(buf, s, e);
          if (which === null) return;
          const r = parseLine(buf, s, e);
          const pw = write(h.ts, r, `snippet ${which}`);
          bySnippet.set(key(r), pw);
          open = pw;
          return;
        }
        case "snippet_result": {
          const refusal = padRefusalIn(buf, s, e);
          if (refusal === null) return;
          const r = e - s < 256 << 10 ? parseLine(buf, s, e) : null;
          const pw = bySnippet.get(key(r)) ?? write(h.ts, r, `snippet ${refusal.op.replace(/^scratchpad\./, "")}`);
          bySnippet.delete(key(r));
          pw.refused = refusal.chars;
          if (open === pw) open = null;
          return;
        }
        case "tool_result": {
          const name = NAME_IN_HEAD.exec(headString(buf, s, e))?.[1] ?? "?";
          if (!PAD_TOOLS.has(name)) return;
          const r = parseLine(buf, s, e);
          const text = textOf(r?.["text"]);
          const how = name === "write_scratchpad" ? "tool write" : "tool edit";
          if (r?.["isError"] === true) {
            // A refused edit for any other reason (no match, ambiguous) changed nothing.
            const refusal = padRefusalOf(text);
            if (refusal !== null) write(h.ts, r, how).refused = refusal.chars;
            return;
          }
          const chars = sizeOfResult(text);
          const pw = write(h.ts, r, how);
          pw.after = chars;
          pw.afterFrom = chars === null ? null : "result";
          if (chars !== null) {
            p.samples.push({ ts: h.ts, chars });
            known = chars;
          }
          open = null;
          return;
        }
      }
    },
    w.since === null ? 0 : seekTime(path, w.since),
  );
  return p;
}

const PAD_BUCKETS = 24;

export function inspectPad(runId: string, opts: Options & Window & { last: number }, out: Out): number {
  const run = trajectoryOf(runId, opts, out);
  if (run === null) return 1;
  const p = scanPad(run.path, opts);
  const say = (text: string): void => out(cap(strike(text, run.token), opts.width));
  const span = p.first === null ? "no records" : `${clock(p.first)} to ${clock(p.last!)}`;
  say(`${runId}: the scratchpad, ${windowPhrase(opts) || "whole run"} (${span}), UTC`);
  const driver = driverName(p.adapter, run.dir, runId);
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
export function padAt(path: string, at: number): PadAt | null {
  const results = new Map<string, Record<string, unknown>>();
  const edits: Record<string, unknown>[] = [];
  const snippetWrites: number[] = [];
  let recorded: number | null = null;
  let from: { ts: number; what: string; text: string } | null = null;
  const key = (r: Record<string, unknown>): string => `${String(r["turn"])}:${String(r["call"])}`;
  backwardLines(
    path,
    (buf, s, e) => {
      const h = headOf(buf, s, e);
      if (Number.isFinite(h.ts) && h.ts > at) return;
      switch (h.t) {
        case "request": {
          const pad = padOfRequest(buf, s, e);
          if (pad === null) return;
          from = { ts: h.ts, what: "the request", text: pad };
          return true;
        }
        case "snippet":
          if (snippetPadWrites(buf, s, e) !== null) snippetWrites.push(h.ts);
          return;
        case "tool_result": {
          if (!PAD_TOOLS.has(NAME_IN_HEAD.exec(headString(buf, s, e))?.[1] ?? "")) return;
          const r = parseLine(buf, s, e);
          if (r === null || r["isError"] === true) return;
          results.set(key(r), r);
          recorded ??= sizeOfResult(textOf(r["text"]));
          return;
        }
        case "tool_call": {
          const name = NAME_IN_HEAD.exec(headString(buf, s, e))?.[1] ?? "";
          if (!PAD_TOOLS.has(name)) return;
          const r = parseLine(buf, s, e);
          if (r === null || !results.has(key(r))) return;
          results.delete(key(r));
          const args = padArgs(name, r["args"]);
          if (name === "edit_scratchpad") {
            edits.push(args);
            return;
          }
          if (typeof args["content"] !== "string") return;
          from = { ts: h.ts, what: "write_scratchpad", text: args["content"].replace(LEGACY_TRUNCATION_MARKER, "") };
          return true;
        }
      }
    },
    offsetAfter(path, at),
  );
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
}

export function inspectPadAt(runId: string, opts: Options & { at: number }, out: Out): number {
  const run = trajectoryOf(runId, opts, out);
  if (run === null) return 1;
  const say = (text: string): void => out(cap(strike(text, run.token), opts.width));
  const p = padAt(run.path, opts.at);
  if (p === null) {
    say(`${runId}: no request and no write_scratchpad at or before ${iso(opts.at)} records the pad`);
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
common: [--runs-dir DIR] (else WRATHBENCH_RUNS_DIR, else data/runs) [--width N]; D is 90s, 30m, 2h, 1d, epoch ms or ISO
--next N: the first N items from --since (or the file's start) instead of the last N`;

/** The flags each command takes, beyond `--runs-dir` and `--width`; any other is a usage error, never ignored. */
const COMMAND_FLAGS: Record<string, readonly string[]> = {
  live: [],
  run: ["--since", "--until"],
  trajectory: ["--last", "--next", "--errors", "--grep", "--all", "--since", "--until"],
  tools: ["--since", "--until"],
  pad: ["--since", "--until", "--last", "--at"],
};
const VALUED = new Set(["--since", "--until", "--at", "--last", "--next", "--grep", "--width", "--runs-dir"]);

export function main(argv: readonly string[], env: Readonly<Record<string, string | undefined>>, out: Out, err: Out, now = Date.now()): number {
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
    if (a !== "--runs-dir" && a !== "--width" && !allowed.includes(a)) {
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
  const base = { runsDir, now, width };
  if (command === "live") return inspectLive(base, out);
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
  if (command === "run") return inspectRun(runId, { ...base, ...window }, out);
  if (command === "tools") return inspectTools(runId, { ...base, ...window }, out);
  if (command === "pad") {
    const at = times["--at"];
    if (at === undefined) return inspectPad(runId, { ...base, ...window, last: last ?? DEFAULT_LAST }, out);
    if (window.since !== null || window.until !== null || last !== null) {
      err(`--at prints the pad at one moment; it takes no --since, --until or --last\n${USAGE}`);
      return 2;
    }
    return inspectPadAt(runId, { ...base, at }, out);
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
  return inspectTrajectory(
    runId,
    { ...base, ...window, last: next ?? last ?? DEFAULT_LAST, forward: next !== null, errors: flags.has("--errors"), grep, all: flags.has("--all") },
    out,
  );
}

if (import.meta.main) {
  process.exit(main(Bun.argv.slice(2), process.env, (l) => console.log(l), (l) => console.error(l)));
}
