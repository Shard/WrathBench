/**
 * Resuming a fan-out run, proved on the compose quickstart with the stub
 * driver: no model, no credential. Run by hand from the repository root,
 * never by the test suite (it needs the live stack). What it proves, on one
 * run of `runner/test/fixtures/stub-fanout-demo.json` across five accounts:
 *
 * 1. SIGTERM once five characters are in (a supervisor stop): the run pauses
 *    as `operator-pause`, the module holds none of its sessions (the server
 *    takes the characters out of the world within its minute's grace), and
 *    `roster.json` is still mode 0600 with the same five tokens, each `in`.
 * 2. `--resume`: the `harness` `fanout` record names all five as `back`
 *    before the first turn, the module holds five sessions again, and every
 *    `sessions/<Character>/` gains rows stamped after the resume.
 * 3. SIGKILL (no pause written, sessions left in the world), then
 *    `--resume` again once the run is ownerless (about two minutes, retried
 *    while the runner refuses it): the same, and the run ends `stub-complete`
 *    with every session given back and the roster still 0600.
 *
 * The stub's script starts over on every resume, so each resumed segment
 * opens with five `login_character` calls answered "already logged in":
 * expected, not a failure.
 *
 * The quickstart must be up with the runner and the worldserver, and the five
 * accounts on the module's allowlist. The default accounts are the stock
 * compose's (`RUNNER` and `POOL01` … `POOL04`, which bootstrap creates):
 *
 *   docker compose --env-file .env -f infra/compose.yml up -d --build runner
 *   bun infra/quickstart-fanout-resume.ts [--project wrathbench] [--accounts A,B,C,D,E] [--no-kill]
 *
 * It reads the run directory on this machine's `data/runs` (the runner
 * container's bind mount), never prints a token, writes nothing under the run
 * directory, and leaves the run in place for `bun infra/inspect-run.ts run <id>`.
 * About eight minutes: two of them wait out the killed run's heartbeat, and
 * up to two wait for the server to take logged-out characters out of the world.
 */

import { createHash } from "node:crypto";
import { existsSync, openSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSegments, readSegment, STREAMS } from "@wrathbench/mcp/record/read";
import { newRunId } from "../runner/src/config";
import { DRIVER_TABLE } from "../runner/src/drivers";
import { readRoster, ROSTER_FILE } from "../runner/src/fanout-run";
import { RESUME_REFUSED_EXIT } from "../runner/src/models";
import { fanoutSessionDir, readRunRow } from "../runner/src/run-reader";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const project = flag("--project") ?? "wrathbench";
const accounts = (flag("--accounts") ?? "RUNNER,POOL01,POOL02,POOL03,POOL04").split(",").map((a) => a.trim()).filter((a) => a.length > 0);
const hardKill = !argv.includes("--no-kill");
const COUNT = 5;
if (accounts.length < COUNT) throw new Error(`five characters need five accounts, got ${accounts.length}`);

const runsDir = "data/runs";
const runId = newRunId();
const runDir = join(runsDir, runId);
const pidFile = `/tmp/${runId}.pid`;
const logPath = join(tmpdir(), `${runId}.log`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;

function check(ok: boolean, what: string): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures++;
}

function container(service: string): string {
  const p = Bun.spawnSync(["docker", "ps", "-q", "--filter", `label=com.docker.compose.project=${project}`, "--filter", `label=com.docker.compose.service=${service}`]);
  const id = p.stdout.toString().trim().split("\n")[0] ?? "";
  if (id === "") throw new Error(`no running ${service} container in compose project ${project}`);
  return id;
}
const runner = container("runner");
const worldserver = container("worldserver");
const db = container("db");

function sh(id: string, script: string): string {
  const p = Bun.spawnSync(["docker", "exec", id, "sh", "-c", script], { stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`docker exec failed: ${p.stderr.toString().trim()}`);
  return p.stdout.toString();
}

/** The module's own count of live bench sessions: the operator census over loopback (`infra/module-health.sh`). */
function moduleSessions(): number {
  const probe = `my $s = IO::Socket::INET->new("localhost:8086") or die "connect: $!\\n"; print $s "GET /health HTTP/1.0\\r\\nAuthorization: Bearer $ENV{AC_WRATH_BENCH_SECRET}\\r\\n\\r\\n"; local $/; my $r = <$s>; my ($b) = $r =~ /\\r\\n\\r\\n(.*)/s; print $b;`;
  const p = Bun.spawnSync(["docker", "exec", worldserver, "perl", "-MIO::Socket::INET", "-e", probe]);
  return (JSON.parse(p.stdout.toString()) as { sessions: number }).sessions;
}

/** The characters the server has online, of these. */
function onlineCharacters(names: readonly string[]): string[] {
  if (names.some((n) => !/^[A-Za-z]+$/.test(n))) throw new Error("not a character name");
  const list = names.map((n) => `'${n}'`).join(",");
  const out = sh(db, `MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot -N -B -e "SELECT name FROM acore_characters.characters WHERE online = 1 AND name IN (${list})"`);
  return out.split("\n").map((l) => l.trim()).filter((l) => l.length > 0).sort();
}

/** The roster without its tokens: each token stands as a short hash, so "unchanged" is checkable and nothing secret is printed. */
function roster(): { mode: string; entries: { character: string; account: string; in: boolean; tokenHash: string }[] } {
  const path = join(runDir, ROSTER_FILE);
  if (!existsSync(path)) return { mode: "absent", entries: [] };
  return {
    mode: (statSync(path).mode & 0o777).toString(8),
    entries: readRoster(runDir).map((e) => ({ character: e.character, account: e.account, in: e.in === true, tokenHash: createHash("sha256").update(e.token).digest("hex").slice(0, 12) })),
  };
}

/** Rows and the newest row's stamp in one character's session record, over every stream. */
function recordOf(character: string): { rows: number; newest: number } {
  const dir = fanoutSessionDir(runDir, character);
  let rows = 0;
  let newest = 0;
  if (dir === null || !existsSync(dir)) return { rows, newest };
  for (const stream of STREAMS) {
    for (const seg of listSegments(dir, stream)) {
      for (const row of readSegment<{ ts?: number }>(seg).rows) {
        rows++;
        if (typeof row.ts === "number" && row.ts > newest) newest = row.ts;
      }
    }
  }
  return { rows, newest };
}

/** `harness` `fanout` records' `back` lists, in order. Only short lines are parsed: a trajectory line can run to megabytes. */
function fanoutBacks(): string[][] {
  const path = join(runDir, "trajectory.jsonl");
  if (!existsSync(path)) return [];
  const out: string[][] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.length > 4096 || !line.includes('"kind":"fanout"')) continue;
    const rec = JSON.parse(line) as { t?: string; back?: string[] };
    if (rec.t === "harness" && Array.isArray(rec.back)) out.push(rec.back);
  }
  return out;
}

async function until<T>(what: string, ms: number, probe: () => T | undefined | false): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const v = probe();
      if (v !== undefined && v !== false) return v;
    } catch {
      // not yet
    }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(2_000);
  }
}

/** Start the runner in the runner container, its pid kept inside the container so a signal reaches bun rather than the docker client. */
function launch(args: string[]): Bun.Subprocess {
  const log = openSync(logPath, "a");
  const cmd = `echo $$ > ${pidFile}; exec bun runner/src/run.ts ${args.join(" ")}`;
  console.log(`---- bun runner/src/run.ts ${args.join(" ")}   (log: ${logPath})`);
  return Bun.spawn(["docker", "exec", runner, "sh", "-c", cmd], { stdout: log, stderr: log, stdin: "ignore" });
}
const signal = (sig: "TERM" | "KILL"): void => void sh(runner, `kill -${sig} "$(cat ${pidFile})"`);

const characters = (): string[] => roster().entries.map((e) => e.character).sort();
const allIn = (): string[] | undefined => {
  const r = roster();
  return r.entries.length === COUNT && r.entries.every((e) => e.in) ? r.entries.map((e) => e.character).sort() : undefined;
};

/** Resume, retrying while the runner refuses because the run still has an owner; returns once the `fanout` record with `back` is written. */
async function resume(backsBefore: number): Promise<{ proc: Bun.Subprocess; at: number }> {
  const deadline = Date.now() + 240_000;
  for (;;) {
    const at = Date.now();
    const proc = launch(["--resume", runId]);
    while (proc.exitCode === null && fanoutBacks().length <= backsBefore) {
      if (Date.now() - at > 120_000) throw new Error(`no fanout record two minutes into the resume; see ${logPath}`);
      await sleep(1_000);
    }
    if (proc.exitCode === null) return { proc, at };
    if (proc.exitCode !== RESUME_REFUSED_EXIT || Date.now() > deadline) throw new Error(`resume exited ${proc.exitCode}; see ${logPath}`);
    console.log("     refused: the run still has an owner; retrying in 15 s");
    await sleep(15_000);
  }
}

function checkResumed(label: string, back: string[] | undefined, names: string[], before: Map<string, { rows: number }>, at: number): void {
  check(back !== undefined && back.slice().sort().join() === names.join(), `${label}: the fanout record names all ${COUNT} as back (${back?.join(", ")})`);
  check(moduleSessions() === COUNT, `${label}: the module holds ${COUNT} sessions`);
  check(onlineCharacters(names).join() === names.join(), `${label}: the server has all ${COUNT} online`);
  for (const c of names) {
    const r = recordOf(c);
    check(r.rows > (before.get(c)?.rows ?? 0) && r.newest > at, `${label}: sessions/${c}/ grew (${before.get(c)?.rows} → ${r.rows} rows, newest ${new Date(r.newest).toISOString()})`);
  }
}

/**
 * Logged out: the module drops its sessions at once, and the server clears
 * `online` up to a minute later, because a character whose connection closed
 * without a client logout stays in the world that long (AzerothCore's
 * `SocketTimeOutTimeActive`, 60 s; `EnableLoginAfterDC` lets a login take it
 * back meanwhile, which is what a prompt resume does).
 */
async function checkGone(label: string, names: string[]): Promise<void> {
  check(moduleSessions() === 0, `${label}: the module holds no session`);
  const t0 = Date.now();
  const gone = await until("the server to log them out", 90_000, () => onlineCharacters(names).length === 0).then(() => true, () => false);
  check(gone, `${label}: the server has none online (after ${Math.round((Date.now() - t0) / 1000)} s)`);
}

const snapshot = (names: string[]) => new Map(names.map((c) => [c, recordOf(c)]));
const stubArgs = ["--driver", DRIVER_TABLE.stub.id, "--stub", "runner/test/fixtures/stub-fanout-demo.json", "--wiki", "false", "--max-characters", String(COUNT), "--accounts", accounts.join(","), "--run-id", runId];

console.log(`run ${runId} on project ${project}, accounts ${accounts.join(",")}`);

// 1. Launch, and stop it as a supervisor would once all five are in and acting.
let proc = launch(stubArgs);
const names = await until("five characters in", 240_000, allIn);
await until("the module's five sessions", 60_000, () => moduleSessions() === COUNT);
await sleep(20_000);
const hashes = roster().entries.map((e) => e.tokenHash).join();
signal("TERM");
check((await proc.exited) === 130, "SIGTERM: the runner exits 130");
const paused = readRunRow(runDir, runId);
check(paused?.["pause_reason"] === "operator-pause" && paused["termination_reason"] == null, `SIGTERM: paused as ${String(paused?.["pause_reason"])}, no termination`);
await checkGone("SIGTERM", names);
let r = roster();
check(r.mode === "600" && r.entries.length === COUNT && r.entries.every((e) => e.in) && r.entries.map((e) => e.tokenHash).join() === hashes, `SIGTERM: roster.json ${r.mode}, ${COUNT} entries in, tokens unchanged`);

// 2. Resume from the pause.
let before = snapshot(names);
let res = await resume(fanoutBacks().length);
await sleep(20_000);
checkResumed("resume after SIGTERM", fanoutBacks().at(-1), names, before, res.at);
r = roster();
check(r.mode === "600" && r.entries.map((e) => e.tokenHash).join() === hashes, `resume: roster.json ${r.mode}, tokens unchanged`);

if (hardKill) {
  // 3. Kill it outright: nothing is written, the sessions stay in the world, and the run goes cold.
  signal("KILL");
  await res.proc.exited;
  const killed = readRunRow(runDir, runId);
  check(killed?.["pause_reason"] == null && killed?.["termination_reason"] == null, "SIGKILL: neither a pause nor a termination is written");
  r = roster();
  check(r.mode === "600" && r.entries.every((e) => e.in) && r.entries.map((e) => e.tokenHash).join() === hashes, `SIGKILL: roster.json ${r.mode}, all in, tokens unchanged`);
  const left = sh(runner, `for p in /proc/[0-9]*; do tr '\\0' ' ' < $p/cmdline 2>/dev/null; echo; done | grep -c '^bun ' || true`).trim();
  console.log(`     after SIGKILL: the module holds ${moduleSessions()} sessions; ${left} bun processes left in the runner container`);
  before = snapshot(names);
  res = await resume(fanoutBacks().length);
  await sleep(20_000);
  checkResumed("resume after SIGKILL", fanoutBacks().at(-1), names, before, res.at);
}

// 4. Let the script run out.
check((await res.proc.exited) === 0, "end: the runner exits 0");
const ended = readRunRow(runDir, runId);
check(ended?.["termination_reason"] === "stub-complete", `end: terminated ${String(ended?.["termination_reason"])}`);
await checkGone("end", names);
r = roster();
check(r.mode === "600" && characters().join() === names.join() && r.entries.every((e) => !e.in), `end: roster.json ${r.mode}, the same ${COUNT} characters, none in`);

console.log(failures === 0 ? `PASS ${runId}` : `${failures} FAILED ${runId}; runner log ${logPath}`);
process.exit(failures === 0 ? 0 : 1);
