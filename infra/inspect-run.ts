#!/usr/bin/env bun
/**
 * `bun wb inspect live|run|trajectory`: read-only views of the runs on the
 * data volume, every one bounded by default.
 *
 *   bun infra/inspect-run.ts live                      runs with a heartbeat, one line each
 *   bun infra/inspect-run.ts run <run-id> [--since D]  the verdict, level, counts, sizes
 *   bun infra/inspect-run.ts trajectory <run-id> [--last N] [--errors] [--grep RE]
 *                                       [--all] [--since D] [--width N]
 *
 * D is `90s`, `30m`, `2h`, `1d`, epoch ms or an ISO time. The runs directory is
 * `--runs-dir`, else WRATHBENCH_RUNS_DIR, else `data/runs`.
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
/** runner/src/redact.ts. */
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

type LineFn = (buf: Buffer, start: number, end: number) => boolean | void;

/** Every non-empty line, oldest first; the callback returns true to stop. */
function forwardLines(path: string, fn: LineFn): void {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const chunk = Buffer.allocUnsafe(CHUNK);
    let carry: Buffer | null = null;
    let pos = 0;
    while (pos < size) {
      const n = readSync(fd, chunk, 0, CHUNK, pos);
      if (n <= 0) break;
      pos += n;
      const buf: Buffer = carry === null ? chunk.subarray(0, n) : Buffer.concat([carry, chunk.subarray(0, n)]);
      carry = null;
      let s = 0;
      for (;;) {
        const e = buf.indexOf(10, s);
        if (e < 0) break;
        if (e > s && fn(buf, s, e) === true) return;
        s = e + 1;
      }
      if (s < buf.length) carry = Buffer.from(buf.subarray(s));
    }
    if (carry !== null && carry.length > 0) fn(carry, 0, carry.length);
  } finally {
    closeSync(fd);
  }
}

/** Every non-empty line, newest first, reading back from the end; the callback returns true to stop. */
function backwardLines(path: string, fn: LineFn): void {
  const fd = openSync(path, "r");
  try {
    let pos = fstatSync(fd).size;
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
        if (e > nl + 1 && fn(buf, nl + 1, e) === true) return;
        e = nl;
      }
      tail = Buffer.from(buf.subarray(0, e));
    }
    if (tail.length > 0) fn(tail, 0, tail.length);
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

interface Activity {
  records: number;
  kinds: Map<string, number>;
  last: { ts: number; t: string } | null;
  snippetErrors: Map<string, number>;
  toolErrors: Map<string, number>;
  harness: Map<string, number>;
}

/** One forward pass over the trajectory: counts by kind, errors by class, harness notices by kind. */
function scanActivity(path: string, since: number | null, token: string | null): Activity {
  const a: Activity = { records: 0, kinds: new Map(), last: null, snippetErrors: new Map(), toolErrors: new Map(), harness: new Map() };
  const isError = Buffer.from('"isError":true');
  forwardLines(path, (buf, s, e) => {
    const h = headOf(buf, s, e);
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
  });
  return a;
}

export function inspectRun(runId: string, opts: Options & { since: number | null }, out: Out): number {
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
        st.quests_completed != null ? `quests ${st.quests_completed}` : null,
        st.zone != null ? `zone ${st.zone}` : null,
        st.turn != null ? `turn ${st.turn}` : null,
        `sampled ${fmtAge(opts.now - st.ts)} ago`,
      ].filter((b): b is string => b !== null);
      say("level", parts.join(" · "));
    }

    const traj = join(dir, "trajectory.jsonl");
    if (!existsSync(traj)) say("activity", "no trajectory.jsonl");
    else {
      const a = scanActivity(traj, opts.since, token);
      const k = (t: string): number => a.kinds.get(t) ?? 0;
      const window = opts.since === null ? "" : `since ${iso(opts.since)}: `;
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

export interface TrajectoryOptions extends Options {
  last: number;
  errors: boolean;
  grep: RegExp | null;
  all: boolean;
  since: number | null;
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
  // Newest first: a result is met before its call.
  const pendingSnippet = new Map<string, Record<string, unknown>>();
  const pendingTool = new Map<string, Record<string, unknown>>();
  const grepOk = (...texts: string[]): boolean => opts.grep === null || texts.some((t) => opts.grep!.test(t));
  const keep = (it: Item): boolean => {
    if (opts.errors && !it.error) return false;
    items.push(it);
    return items.length >= opts.last;
  };
  const callKey = (r: Record<string, unknown>): string => `${String(r["turn"])}:${String(r["call"])}`;

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

  backwardLines(path, (buf, s, e) => {
    const h = headOf(buf, s, e);
    if (opts.since !== null && Number.isFinite(h.ts) && h.ts < opts.since) return true;
    if (opts.all) {
      if (opts.errors && h.t !== "snippet_result" && h.t !== "tool_result") return;
      if (SIZE_ONLY.has(h.t) || e - s > 256 << 10) {
        if (opts.grep !== null || opts.errors) return;
        return keep({ ts: h.ts, error: false, text: `${clock(h.ts)}  ${h.t}  (${fmtBytes(e - s)})` });
      }
      const r = parseLine(buf, s, e);
      if (r === null) return;
      if (h.t === "meta") {
        return keep({ ts: h.ts, error: false, text: `${clock(h.ts)}  meta  run ${String(r["runId"] ?? "?")} harness ${String(r["harnessVersion"] ?? "?")}` });
      }
      const line = compact(r, w, token);
      const error = r["isError"] === true;
      if (!grepOk(strike(buf.toString("utf8", s, e), token))) return;
      return keep({ ts: h.ts, error, text: `${clock(h.ts)}  ${h.t}  ${line}` });
    }
    switch (h.t) {
      case "snippet_result": {
        const r = parseLine(buf, s, e);
        if (r !== null) pendingSnippet.set(callKey(r), r);
        return;
      }
      case "snippet": {
        const r = parseLine(buf, s, e);
        if (r === null) return;
        const res = pendingSnippet.get(callKey(r)) ?? null;
        pendingSnippet.delete(callKey(r));
        const it = snippetItem(r, res);
        return it === null ? undefined : keep(it);
      }
      case "tool_result": {
        const r = parseLine(buf, s, e);
        if (r !== null) pendingTool.set(callKey(r), r);
        return;
      }
      case "tool_call": {
        const r = parseLine(buf, s, e);
        if (r === null) return;
        // A snippet's call is shown by its snippet record, which carries the same code.
        if (r["name"] === "run_snippet") return;
        const res = pendingTool.get(callKey(r)) ?? null;
        pendingTool.delete(callKey(r));
        const it = toolItem(r, res);
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
  });
  // Results whose call was never met (the file starts mid-call, or --since cut it off).
  if (items.length < opts.last) {
    for (const r of pendingSnippet.values()) {
      const it = snippetItem(null, r);
      if (it !== null && (!opts.errors || it.error)) items.push(it);
    }
    for (const r of pendingTool.values()) {
      const it = toolItem(null, r);
      if (it !== null && (!opts.errors || it.error)) items.push(it);
    }
  }
  const shown = items.sort((a, b) => a.ts - b.ts).slice(-opts.last);
  const filters = [opts.errors ? "errors only" : null, opts.grep !== null ? `matching /${opts.grep.source}/${opts.grep.flags}` : null, opts.since !== null ? `since ${iso(opts.since)}` : null, opts.all ? "every record kind" : null].filter(Boolean);
  out(cap(strike(`${runId}: the last ${shown.length} ${opts.all ? "record(s)" : "item(s)"}${filters.length > 0 ? ` (${filters.join(", ")})` : ""}, oldest first, UTC`, token), w));
  for (const it of shown) out(cap(strike(it.text, token), w));
  return 0;
}

// ------------------------------------------------------------------ CLI

const USAGE = `usage: bun infra/inspect-run.ts live
       bun infra/inspect-run.ts run <run-id> [--since D]
       bun infra/inspect-run.ts trajectory <run-id> [--last N] [--errors] [--grep RE] [--all] [--since D] [--width N]
common: [--runs-dir DIR] (else WRATHBENCH_RUNS_DIR, else data/runs); D is 90s, 30m, 2h, 1d, epoch ms or ISO`;

export function main(argv: readonly string[], env: Readonly<Record<string, string | undefined>>, out: Out, err: Out, now = Date.now()): number {
  const [command, ...rest] = argv;
  if (command === undefined || command === "-h" || command === "--help") {
    (command === undefined ? err : out)(USAGE);
    return command === undefined ? 2 : 0;
  }
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  const valued = new Set(["--since", "--last", "--grep", "--width", "--runs-dir"]);
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
    if (valued.has(a)) {
      const v = rest[++i];
      if (v === undefined) {
        err(`${a} needs a value\n${USAGE}`);
        return 2;
      }
      flags.set(a, v);
    } else if (a === "--errors" || a === "--all") flags.set(a, true);
    else {
      err(`unknown flag ${a}\n${USAGE}`);
      return 2;
    }
  }
  const runsDir = (flags.get("--runs-dir") as string | undefined) ?? env["WRATHBENCH_RUNS_DIR"] ?? "data/runs";
  const width = flags.has("--width") ? Number(flags.get("--width")) : DEFAULT_WIDTH;
  if (!Number.isInteger(width) || width < 40) {
    err("--width is a whole number of at least 40");
    return 2;
  }
  let since: number | null = null;
  try {
    if (flags.has("--since")) since = parseSince(flags.get("--since") as string, now);
  } catch (e) {
    err((e as Error).message);
    return 2;
  }
  const base = { runsDir, now, width };
  if (command === "live") return inspectLive(base, out);
  const runId = positional[0];
  if (runId === undefined || positional.length > 1 || !isValidRunId(runId)) {
    err(runId === undefined ? `${command} needs a run id\n${USAGE}` : `not one run id: ${positional.join(" ")}`);
    return 2;
  }
  if (command === "run") return inspectRun(runId, { ...base, since }, out);
  if (command === "trajectory") {
    const last = flags.has("--last") ? Number(flags.get("--last")) : DEFAULT_LAST;
    if (!Number.isInteger(last) || last < 1 || last > MAX_LAST) {
      err(`--last is a whole number from 1 to ${MAX_LAST}`);
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
    return inspectTrajectory(runId, { ...base, since, last, errors: flags.has("--errors"), grep, all: flags.has("--all") }, out);
  }
  err(`unknown command ${command}\n${USAGE}`);
  return 2;
}

if (import.meta.main) {
  process.exit(main(Bun.argv.slice(2), process.env, (l) => console.log(l), (l) => console.error(l)));
}
