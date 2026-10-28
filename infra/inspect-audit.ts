#!/usr/bin/env bun
/**
 * `bun wb inspect audit <run-id>`: one run's module audit log, as counts or as
 * its last few matching records, without a token or a file name ever printed.
 *
 *   bun infra/inspect-audit.ts [--k8s] <run-id>                  counts per kind, op or opcode, and status
 *   bun infra/inspect-audit.ts [--k8s] <run-id> --op X[,Y…] [--status S] [--last N]
 *                                                               the newest matching records
 *   bun infra/inspect-audit.ts [--k8s] <run-id> --summary --op X[,Y…]
 *                                                               the counts of those ops alone: verdicts by op
 *   common: [--since D] [--until D] [--top N] [--width N]
 *   offline: --audit-dir DIR [--runs-dir DIR]                    a copy here, no container
 *   bun infra/inspect-audit.ts [--k8s] --smoke <name> …          a smoke's sessions instead of a run's
 *
 * The files are named after the run's session token, which lives in the run's
 * meta.json on the runs volume, while the files live in the worldserver's
 * logs. So the token is read here from meta.json (the runner pod's on the
 * cluster, `data/runs/` under compose), never printed, and handed on stdin to
 * `infra/inspect-audit.pl` running where the files are: `kubectl exec` into
 * the worldserver with `--k8s` (wb passes it on the cluster), `docker compose
 * exec` into compose's otherwise. The script reduces the log there and prints
 * no name; what comes back is struck again here before it is shown.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { cap, fmtBytes, isValidRunId, iso, MIN_TOKEN_LENGTH, parseSince, REDACTED } from "./inspect-run";

const REPO_ROOT = resolve(import.meta.dir, "..");
const SCRIPT = join(import.meta.dir, "inspect-audit.pl");
const COMPOSE_FILE = join(REPO_ROOT, "infra", "compose.yml");
const DEFAULT_TOP = 40;
const DEFAULT_WIDTH = 200;

export const USAGE = `usage: bun infra/inspect-audit.ts [--k8s] <run-id> | --smoke <name> [--op X[,Y…] [--status S] [--last N | --summary]] [--since D] [--until D] [--top N] [--width N]
       offline: --audit-dir DIR [--runs-dir DIR]
D is 90s, 30m, 2h, 1d, epoch ms or ISO; with no --op, or with --summary, it prints counts
--smoke <name> reads the sessions a smoke names smoke-<name>-<uuid>, not a run's (no meta.json; --since narrows to one run)`;

export interface AuditArgs {
  /** The run, or for --smoke the label `smoke-<name>`, as printed. */
  runId: string;
  /** --smoke: the name in the tokens the smoke gives its sessions, `smoke-<name>-<uuid>`. */
  smoke: string | null;
  target: "k8s" | "compose" | "dir";
  op: string | null;
  status: string | null;
  /** Counts rather than records, of the --op filter's matches. */
  summary: boolean;
  since: number | null;
  until: number | null;
  last: number;
  top: number;
  width: number;
  auditDir: string | null;
  runsDir: string;
}

export function parseArgs(argv: readonly string[], now: number): AuditArgs | { error: string } {
  let target: AuditArgs["target"] = "compose";
  const positional: string[] = [];
  const v = new Map<string, string>();
  const valued = new Set(["--op", "--status", "--since", "--until", "--last", "--top", "--width", "--audit-dir", "--runs-dir", "--smoke"]);
  let summary = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--k8s") target = "k8s";
    else if (a === "--summary") summary = true;
    else if (valued.has(a)) {
      const val = argv[++i];
      if (val === undefined) return { error: `${a} needs a value` };
      v.set(a, val);
    } else if (a.startsWith("-")) return { error: `unknown flag ${a}` };
    else positional.push(a);
  }
  const smoke = v.get("--smoke") ?? null;
  if (smoke !== null) {
    if (!/^[a-z0-9]+$/.test(smoke)) return { error: "--smoke is the bare name in a smoke's tokens, like edge for smoke-edge-<uuid>" };
    if (positional.length > 0) return { error: "--smoke reads a smoke's sessions, not a run's: no run id with it" };
  } else if (positional.length !== 1 || !isValidRunId(positional[0]!)) {
    return { error: positional.length === 0 ? "a run id is needed" : `not one run id: ${positional.join(" ")}` };
  }
  const num = (flag: string, dflt: number, min: number, max: number): number | null => {
    const raw = v.get(flag);
    if (raw === undefined) return dflt;
    const n = Number(raw);
    return Number.isInteger(n) && n >= min && n <= max ? n : null;
  };
  const last = num("--last", 20, 1, 1000);
  const top = num("--top", DEFAULT_TOP, 1, 10_000);
  const width = num("--width", DEFAULT_WIDTH, 80, 100_000);
  if (last === null || top === null || width === null) return { error: "--last is 1..1000, --top 1..10000, --width 80 or more" };
  const op = v.get("--op");
  if (op !== undefined && !/^[A-Za-z0-9_]+(,[A-Za-z0-9_]+)*$/.test(op)) return { error: "--op is a name like move_to or WB_MOVE_RESULT, or several joined by commas" };
  const st = v.get("--status");
  if (st !== undefined && !/^[A-Za-z0-9_]+$/.test(st)) return { error: "--status is a bare name like arrived" };
  if (st !== undefined && op === undefined) return { error: "--status filters the records of an --op" };
  let since: number | null = null;
  let until: number | null = null;
  try {
    if (v.has("--since")) since = parseSince(v.get("--since")!, now);
    if (v.has("--until")) until = parseSince(v.get("--until")!, now);
  } catch (e) {
    return { error: (e as Error).message.replace("--since", v.has("--until") ? "--since/--until" : "--since") };
  }
  const auditDir = v.get("--audit-dir") ?? null;
  if (auditDir !== null) target = "dir";
  return {
    runId: smoke !== null ? `smoke-${smoke}` : positional[0]!,
    smoke,
    target,
    op: op ?? null,
    status: st ?? null,
    summary: summary || op === undefined,
    since,
    until,
    last,
    top,
    width,
    auditDir,
    runsDir: v.get("--runs-dir") ?? join(REPO_ROOT, "data", "runs"),
  };
}

/** What `inspect-audit.pl` printed, parsed. */
export interface Reduced {
  files: number;
  bytes: number;
  records: number;
  first: number | null;
  last: number | null;
  counts: { kind: string; name: string; status: string; n: number }[];
  matched: number | null;
  lines: string[];
}

export function parseReduced(text: string): Reduced {
  const r: Reduced = { files: 0, bytes: 0, records: 0, first: null, last: null, counts: [], matched: null, lines: [] };
  const num = (s: string | undefined): number | null => (s === undefined || s === "-" ? null : Number(s));
  for (const line of text.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const tag = line.slice(0, tab);
    const rest = line.slice(tab + 1);
    const f = rest.split("\t");
    if (tag === "F") {
      r.files = num(f[0]) ?? 0;
      r.bytes = num(f[1]) ?? 0;
    } else if (tag === "R") {
      r.records = num(f[0]) ?? 0;
      r.first = num(f[1]);
      r.last = num(f[2]);
    } else if (tag === "C" && f.length === 4) r.counts.push({ kind: f[0]!, name: f[1]!, status: f[2]!, n: Number(f[3]) });
    else if (tag === "M") r.matched = num(f[0]);
    else if (tag === "L") r.lines.push(rest);
  }
  return r;
}

/** Strike the token (when there is one worth striking; for --smoke, every one of the smoke's) and any session field, whatever came back. */
export function scrubAudit(text: string, token: string | RegExp | null): string {
  const struck = token === null ? text : text.replaceAll(token, REDACTED);
  return struck.replace(/"session":"[^"]*"/g, `"session":"${REDACTED}"`);
}

function clockMs(ts: number): string {
  return new Date(ts).toISOString().slice(5, 23).replace("T", " ");
}

function span(r: Reduced): string {
  if (r.first === null || r.last === null) return "no records";
  return `${r.records} records, ${clockMs(r.first)} → ${clockMs(r.last)} UTC`;
}

const RECORD = /^\{"ts":(\d+),"session":"[^"]*","kind":"([^"]*)","payload":(.*)$/;

export function formatReduced(a: AuditArgs, r: Reduced, token: string | RegExp | null): string[] {
  const out: string[] = [];
  const window = `${a.since === null ? "" : ` since ${iso(a.since)}`}${a.until === null ? "" : ` until ${iso(a.until)}`}`;
  const filter = a.op === null ? "" : `op ${a.op}${a.status !== null ? `, status ${a.status}` : ""}`;
  if (a.summary) {
    const matches = a.op === null ? "" : ` · ${r.matched ?? 0} match ${filter}`;
    out.push(`audit ${a.runId}${window}: ${r.files} file(s), ${fmtBytes(r.bytes)}, ${span(r)}${matches}`);
    if (r.files === 0) {
      out.push(`  no audit files for this ${a.smoke !== null ? "smoke's tokens" : "run's token"}: pruned by the retention window, or never written`);
      return out;
    }
    const rows = [...r.counts].sort((x, y) => y.n - x.n || x.kind.localeCompare(y.kind) || x.name.localeCompare(y.name));
    out.push(`  ${"count".padStart(10)}  ${"kind".padEnd(7)} ${"op / opcode".padEnd(32)} status`);
    for (const c of rows.slice(0, a.top)) out.push(cap(`  ${String(c.n).padStart(10)}  ${c.kind.padEnd(7)} ${c.name.padEnd(32)} ${c.status}`, a.width));
    if (rows.length > a.top) out.push(`  (${a.top} of ${rows.length} rows; --top N for more)`);
    return out.map((l) => scrubAudit(l, token));
  }
  out.push(`audit ${a.runId}${window}: ${r.matched ?? 0} record(s) match ${filter}, of ${r.records} in ${r.files} file(s); the last ${r.lines.length}, oldest first, UTC`);
  for (const raw of r.lines) {
    const line = scrubAudit(raw, token);
    const m = RECORD.exec(line);
    if (m === null) {
      out.push(cap(line, a.width));
      continue;
    }
    const payload = m[3]!.endsWith("}}") ? m[3]!.slice(0, -1) : m[3]!;
    const st = /"status":"([A-Za-z0-9_]+)"/.exec(payload.slice(0, 400))?.[1] ?? "-";
    const name = /"(?:op|opcode)":"([A-Za-z0-9_]+)"/.exec(payload.slice(0, 200))?.[1] ?? "?";
    out.push(cap(`${clockMs(Number(m[1]))}  ${m[2]}  ${name}  ${st}  ${payload}`, a.width));
  }
  return out;
}

/** The token from a meta.json document, or why there is none. */
export function tokenOf(metaText: string): string | { error: string } {
  let meta: unknown;
  try {
    meta = JSON.parse(metaText);
  } catch {
    return { error: "its meta.json does not parse" };
  }
  const token = (meta as { config?: { token?: unknown } } | null)?.config?.token;
  if (typeof token !== "string" || token === "") return { error: "its meta.json names no session token" };
  return token;
}

export interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
  env: Readonly<Record<string, string | undefined>>;
}

function k8s(env: Io["env"]): { ns: string; release: string } {
  const pick = (k: string): string => (env[k] !== undefined && env[k] !== "" ? env[k]! : "wrathbench");
  return { ns: pick("WRATHBENCH_K8S_NAMESPACE"), release: pick("WRATHBENCH_K8S_RELEASE") };
}

/** meta.json's text, from wherever the run lives; never printed. */
async function readMetaText(a: AuditArgs, io: Io): Promise<string | null> {
  if (a.target !== "k8s") {
    for (const dir of [join(a.runsDir, a.runId), join(a.runsDir, "archive", a.runId)]) {
      const path = join(dir, "meta.json");
      if (existsSync(path)) return readFileSync(path, "utf8");
    }
    return null;
  }
  const { ns, release } = k8s(io.env);
  const p = Bun.spawn(
    [
      "kubectl", "-n", ns, "exec", `deploy/${release}-runner`, "--",
      "sh", "-c", 'cat "data/runs/$1/meta.json" 2>/dev/null || cat "data/runs/archive/$1/meta.json" 2>/dev/null', "sh", a.runId,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [text, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  return code === 0 && text !== "" ? text : null;
}

function reducerArgv(a: AuditArgs, io: Io): { argv: string[]; env?: Record<string, string> } {
  const script = readFileSync(SCRIPT, "utf8");
  const args = [a.summary ? "summary" : "records", a.op ?? "-", a.status ?? "-", a.since === null ? "-" : String(Math.floor(a.since)), a.until === null ? "-" : String(Math.floor(a.until)), String(a.last), String(Math.max(600, a.width * 4))];
  if (a.target === "dir") return { argv: ["perl", "-e", script, ...args], env: { WB_AUDIT_DIR: resolve(a.auditDir!) } };
  if (a.target === "k8s") {
    const { ns, release } = k8s(io.env);
    return { argv: ["kubectl", "-n", ns, "exec", "-i", `deploy/${release}-worldserver`, "-c", "worldserver", "--", "perl", "-e", script, ...args] };
  }
  return { argv: ["docker", "compose", "-f", COMPOSE_FILE, "exec", "-T", "worldserver", "perl", "-e", script, ...args] };
}

export async function run(argv: readonly string[], io: Io, now = Date.now()): Promise<number> {
  if (argv.includes("-h") || argv.includes("--help")) {
    io.out(USAGE);
    return 0;
  }
  const a = parseArgs(argv, now);
  if ("error" in a) {
    io.err(`inspect audit: ${a.error}\n${USAGE}`);
    return 2;
  }
  // A smoke's sessions: the reducer gets the tokens' fixed prefix, and every
  // token that starts with it is struck from what comes back.
  if (a.smoke !== null) return reduce(a, io, `smoke-${a.smoke}-*`, new RegExp(`smoke-${a.smoke}-[A-Za-z0-9_-]*`, "g"));
  const metaText = await readMetaText(a, io);
  if (metaText === null) {
    io.err(`inspect audit: no meta.json for ${a.runId}${a.target === "k8s" ? " in the runner pod" : ` under ${a.runsDir}`}`);
    return 1;
  }
  const token = tokenOf(metaText);
  if (typeof token !== "string") {
    io.err(`inspect audit: ${a.runId}: ${token.error}`);
    return 1;
  }
  // What to strike from the output: the token, unless it is a pre-hardening run id the output names anyway.
  const strikable = token.length >= MIN_TOKEN_LENGTH && token !== a.runId ? token : null;
  return reduce(a, io, token, strikable);
}

/** The reducer, with `token` (a run's, or a smoke's prefix line) on its stdin, and what it found, struck. */
async function reduce(a: AuditArgs, io: Io, token: string, strikable: string | RegExp | null): Promise<number> {
  const plan = reducerArgv(a, io);
  const p = Bun.spawn(plan.argv, {
    stdin: new TextEncoder().encode(`${token}\n`),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...io.env, ...(plan.env ?? {}) },
  });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  for (const line of stderr.split("\n").filter((l) => l !== "")) io.err(cap(scrubAudit(line, strikable), 400));
  if (code !== 0) {
    io.err(`inspect audit: the reducer exited ${code}`);
    return code;
  }
  for (const line of formatReduced(a, parseReduced(stdout), strikable)) io.out(line);
  return 0;
}

if (import.meta.main) {
  process.exit(await run(Bun.argv.slice(2), { out: (l) => console.log(l), err: (l) => console.error(l), env: process.env }));
}
