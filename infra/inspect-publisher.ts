#!/usr/bin/env bun
/**
 * `bun wb inspect publisher [<run-id>]`: what the public publisher last did,
 * from its state file and its log, read-only.
 *
 *   bun infra/inspect-publisher.ts [--k8s] [<run-id>] [--passes N]
 *   offline: --state FILE
 *
 * The state file is on the publisher's own volume (`WRATHBENCH_PUBLISH_STATE`,
 * `data/publish/state.json`), not the runner's, so with `--k8s` (wb passes it on
 * the cluster) it is read out of the publisher pod and its log with `kubectl
 * logs`; otherwise `data/publish/state.json` in this checkout, which is the
 * compose quickstart's bind mount, and compose's log. It is parsed here with
 * the engine's own `parseState`. What is printed: when the state was written,
 * the generation the manifest last flipped to, versions per run, object and
 * trace-window counts, the last pass's secret scan with every withheld path and
 * its rules (a finding names a rule, never a value), and the last few passes'
 * log lines. With a run id: that run's versions, objects and trace windows.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describeFindings, type ScanFinding } from "../runner/src/secret-scan";
import { SEG_MS, unpackSegs } from "../runner/viewer/trace";
import { cap, fmtAge, fmtBytes, isValidRunId, iso } from "./inspect-run";
import { parseState, RUN_PREFIX, type PublishState } from "./publish-core";

const REPO_ROOT = resolve(import.meta.dir, "..");
const COMPOSE_FILE = join(REPO_ROOT, "infra", "compose.yml");
const WIDTH = 200;
const MAX_WITHHELD = 10;

export const USAGE = `usage: bun infra/inspect-publisher.ts [--k8s] [<run-id>] [--passes N]
       offline: --state FILE`;

interface Args {
  target: "k8s" | "compose" | "file";
  runId: string | null;
  passes: number;
  state: string | null;
}

export function parseArgs(argv: readonly string[]): Args | { error: string } {
  const a: Args = { target: "compose", runId: null, passes: 3, state: null };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i]!;
    if (x === "--k8s") a.target = "k8s";
    else if (x === "--passes" || x === "--state") {
      const v = argv[++i];
      if (v === undefined) return { error: `${x} needs a value` };
      if (x === "--state") {
        a.state = v;
        a.target = "file";
      } else {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 0 || n > 100) return { error: "--passes is 0..100" };
        a.passes = n;
      }
    } else if (x.startsWith("-")) return { error: `unknown flag ${x}` };
    else if (a.runId !== null || !isValidRunId(x)) return { error: `not one run id: ${x}` };
    else a.runId = x;
  }
  return a;
}

/** The raw scan block, which `parseState` does not carry (it is rewritten every pass, never read back). */
interface Scan {
  at: number;
  scanned: number;
  withheld: { path: string; findings: ScanFinding[] }[];
}

function scanOf(raw: unknown): Scan | null {
  const s = (raw as { secretScan?: unknown } | null)?.secretScan as Partial<Scan> | undefined;
  if (s === undefined || s === null || typeof s.at !== "number") return null;
  const withheld = Array.isArray(s.withheld)
    ? s.withheld.filter((w): w is Scan["withheld"][number] => typeof w?.path === "string" && Array.isArray(w.findings))
    : [];
  return { at: s.at, scanned: typeof s.scanned === "number" ? s.scanned : 0, withheld };
}

function windows(runs: readonly [number, number][]): number {
  return runs.reduce((n, r) => n + r[1], 0);
}

/** The report, from the state file's text, when it was written, and the log's pass lines. Pure. */
export function report(text: string, writtenAt: number | null, logLines: readonly string[], runId: string | null, now: number, passes = 3): string[] {
  const out: string[] = [];
  let raw: unknown;
  let state: PublishState;
  try {
    raw = JSON.parse(text);
    state = parseState(text);
  } catch {
    return ["publisher: the state file does not parse"];
  }
  const say = (label: string, s: string): void => {
    out.push(`${label.padEnd(10)} ${cap(s, WIDTH - 11)}`);
  };
  say("state", `${fmtBytes(Buffer.byteLength(text))}${writtenAt === null ? "" : `, written ${iso(writtenAt)} (${fmtAge(now - writtenAt)} ago)`}`);
  say(
    "manifest",
    state.lastGen === undefined
      ? "never flipped"
      : `gen ${state.lastGen}${state.lastFlipAt !== undefined ? `, flipped ${iso(state.lastFlipAt)} (${fmtAge(now - state.lastFlipAt)} ago)` : ""}; ${state.gens.length} flip(s) on record`,
  );
  const lens = new Map<number, number>();
  for (const v of Object.values(state.runVersions)) lens.set(v.length, (lens.get(v.length) ?? 0) + 1);
  const lenText = [...lens].sort((a, b) => a[0] - b[0]).map(([l, n]) => `${l} version${l === 1 ? "" : "s"} ${n}`).join(", ");
  const uploaded = Object.keys(state.uploaded);
  const runPaths = uploaded.filter((p) => p.startsWith(RUN_PREFIX)).length;
  say(
    "runs",
    `${Object.keys(state.runVersions).length} with a published version (${lenText || "none"}); ${uploaded.length} objects uploaded, ${runPaths} under ${RUN_PREFIX}; ${state.pendingDeletes.length} delete(s) pending`,
  );
  const segRuns = Object.values(state.traceSegs);
  say("traces", `${segRuns.length} run(s) with trace segments, ${segRuns.reduce((n, r) => n + windows(r), 0)} window(s)`);
  const scan = scanOf(raw);
  if (scan === null) say("scan", "no scan recorded (a publisher that does not scan, or one that has not passed yet)");
  else {
    say("scan", `${iso(scan.at)} (${fmtAge(now - scan.at)} ago): ${scan.scanned} bodies scanned, ${scan.withheld.length} withheld`);
    for (const w of scan.withheld.slice(0, MAX_WITHHELD)) out.push(cap(`           withheld ${w.path}: ${describeFindings(w.findings)}`, WIDTH));
    if (scan.withheld.length > MAX_WITHHELD) out.push(`           (+${scan.withheld.length - MAX_WITHHELD} more withheld)`);
  }
  const passLines = logLines.filter((l) => / publish: gen /.test(l)).slice(-passes);
  if (passes > 0) {
    if (passLines.length === 0) say("passes", "no pass in the log's tail");
    for (const [i, l] of passLines.entries()) out.push(`${(i === 0 ? "passes" : "").padEnd(10)} ${cap(l, WIDTH - 11)}`);
    const trouble = logLines.filter((l) => !/ publish: gen /.test(l) && /fail|error|withheld|refus/i.test(l)).slice(-3);
    for (const l of trouble) out.push(`${"".padEnd(10)} ${cap(l, WIDTH - 11)}`);
  }
  if (runId !== null) {
    const versions = state.runVersions[runId];
    const prefix = `${RUN_PREFIX}${runId}/`;
    const objects = uploaded.filter((p) => p.startsWith(prefix));
    if (versions === undefined && objects.length === 0) say("run", `${runId}: nothing published (not public, withheld, or not rendered yet)`);
    else {
      const current = versions?.at(-1);
      const underCurrent = current === undefined ? 0 : objects.filter((p) => p.startsWith(`${prefix}${current}/`)).length;
      say("run", `${runId}: ${versions?.length ?? 0} version(s), current ${current ?? "none"}${versions !== undefined && versions.length > 1 ? ` (older ${versions.slice(0, -1).join(", ")})` : ""}`);
      say("objects", `${objects.length} under ${prefix}, ${underCurrent} of them the current version's`);
      const segs = state.traceSegs[runId];
      if (segs === undefined) say("trace", "no segments published");
      else {
        const t0s = unpackSegs(segs);
        say("trace", `${t0s.length} window(s), ${iso(t0s[0])} → ${iso(t0s.at(-1)! + SEG_MS)}, in ${segs.length} run(s) of consecutive windows`);
      }
      const held = scan?.withheld.filter((w) => w.path.startsWith(prefix)) ?? [];
      if (held.length > 0) say("withheld", held.map((w) => `${w.path.slice(prefix.length)}: ${describeFindings(w.findings)}`).join("; "));
    }
  }
  return out;
}

export interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
  env: Readonly<Record<string, string | undefined>>;
}

async function capture(argv: string[]): Promise<{ code: number; stdout: string }> {
  try {
    const p = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
    const [stdout, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
    return { code, stdout };
  } catch {
    return { code: 127, stdout: "" };
  }
}

/** The state file's text, when it was written, and the log's last lines. */
async function read(a: Args, env: Io["env"]): Promise<{ text: string; writtenAt: number | null; log: string[] } | { error: string }> {
  if (a.target === "k8s") {
    const ns = env["WRATHBENCH_K8S_NAMESPACE"] || "wrathbench";
    const release = env["WRATHBENCH_K8S_RELEASE"] || "wrathbench";
    const pod = `deploy/${release}-publisher`;
    const [state, log] = await Promise.all([
      capture(["kubectl", "-n", ns, "exec", pod, "--", "sh", "-c", 'f="${WRATHBENCH_PUBLISH_STATE:-data/publish/state.json}"; stat -c %Y "$f" && cat "$f"']),
      capture(["kubectl", "-n", ns, "logs", pod, "--tail=400"]),
    ]);
    if (state.code !== 0) return { error: `could not read the state file in ${pod} (no publisher, or it has not passed yet)` };
    const nl = state.stdout.indexOf("\n");
    return { text: state.stdout.slice(nl + 1), writtenAt: Number(state.stdout.slice(0, nl)) * 1000, log: log.stdout.split("\n") };
  }
  const path = a.state ?? join(REPO_ROOT, "data", "publish", "state.json");
  if (!existsSync(path)) return { error: `no state file at ${path}` };
  const log = a.target === "compose" ? await capture(["docker", "compose", "-f", COMPOSE_FILE, "logs", "--no-log-prefix", "--tail", "400", "publisher"]) : { code: 0, stdout: "" };
  return { text: readFileSync(path, "utf8"), writtenAt: statSync(path).mtimeMs, log: log.code === 0 ? log.stdout.split("\n") : [] };
}

export async function run(argv: readonly string[], io: Io, now = Date.now()): Promise<number> {
  if (argv.includes("-h") || argv.includes("--help")) {
    io.out(USAGE);
    return 0;
  }
  const a = parseArgs(argv);
  if ("error" in a) {
    io.err(`inspect publisher: ${a.error}\n${USAGE}`);
    return 2;
  }
  const got = await read(a, io.env);
  if ("error" in got) {
    io.err(`inspect publisher: ${got.error}`);
    return 1;
  }
  for (const line of report(got.text, got.writtenAt, got.log, a.runId, now, a.passes)) io.out(line);
  return 0;
}

if (import.meta.main) {
  process.exit(await run(Bun.argv.slice(2), { out: (l) => console.log(l), err: (l) => console.error(l), env: process.env }));
}
