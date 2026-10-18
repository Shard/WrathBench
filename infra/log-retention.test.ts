/**
 * The server log retention pass (chart/wrathbench/files/log-retention.pl),
 * run against a fixture directory with a fake module behind it, and the chart
 * that schedules it. What is pinned is the rule set the pass is allowed to
 * act on: a day file dated before today (UTC) and quiet for the window is
 * deleted whatever the server's start, with the date read from the end of the
 * name because a token may carry dots; today's day file and a legacy undated
 * file are deleted only when quiet for the window and older than the server
 * process, emptied in place and never unlinked when younger; a file the
 * server holds open is never touched; with no server start known only past
 * days are deleted; a disabled window changes nothing; and no output ever
 * carries a file name, because the names are session tokens.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "./temp-dirs";

const tempDir = tempDirs();
const SCRIPT = join(import.meta.dir, "chart", "wrathbench", "files", "log-retention.pl");
const CHART = join(import.meta.dir, "chart", "wrathbench");
const perl = Bun.which("perl");
const helm = Bun.which("helm");

const DAY = 86_400;
const SECRET = "port-secret-for-the-test-0123456789abcdef";
/** Session tokens as the module names them: 32 hex characters. */
const token = () => Array.from({ length: 32 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");
/** The module's day-file date: YYYY-MM-DD in UTC, for a unix time. */
const utcDate = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);

/** The fake module: GET /health with the port secret answers startedAtMs; anything else 401. */
let server: ReturnType<typeof Bun.serve> | undefined;
let startedAtMs = 0;
let hits = 0;
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      hits++;
      if (req.headers.get("authorization") !== `Bearer ${SECRET}`) return new Response('{"ok":false,"error":"unauthorized"}', { status: 401 });
      return Response.json({ ok: true, module: "mod-wrathbench", sessions: 1, startedAtMs, build: "test" });
    },
  });
});
afterAll(() => server?.stop(true));

interface Fixture {
  dir: string;
  /** name → path, by role. */
  files: Record<string, string>;
}

/**
 * now - 4 d: the server started. Seven files, one per rule — four legacy
 * undated ones, as the module named them before day files, and three day
 * files — plus a directory and a symlink the pass must step over.
 */
function fixture(now: number): Fixture {
  const dir = tempDir("wb-log-retention-");
  startedAtMs = (now - 4 * DAY) * 1000;
  const mk = (name: string, ageDays: number, bytes: number): string => {
    const path = join(dir, name);
    writeFileSync(path, "x".repeat(bytes));
    utimesSync(path, now - ageDays * DAY, now - ageDays * DAY);
    return path;
  };
  const files = {
    fresh: mk(`${token()}.jsonl`, 0.5, 100), // within the window
    closedBeforeStart: mk(`${token()}.jsonl`, 5, 1000), // quiet, older than the process: deleted
    quietSinceStart: mk(`${token()}.jsonl`, 3.5, 500), // quiet, younger than the process: truncated
    emptySinceStart: mk(`${token()}.jsonl`, 3.5, 0), // already empty: waits for a restart
    // A past day's file, quiet for the window though younger than the process: deleted, the writer never reopens a past date.
    pastDay: mk(`${token()}.${utcDate(now - 2 * DAY)}.jsonl`, 3.5, 700),
    // The same, for a token that carries dots and a date-shaped part of its own: only the end of the name is the date.
    pastDayDottedToken: mk(`2099-12-31.${token()}.${utcDate(now - 2 * DAY)}.jsonl`, 3.5, 300),
    todayDated: mk(`${token()}.${utcDate(now)}.jsonl`, 0.5, 200), // today's day file: within the window
  };
  mkdirSync(join(dir, "a-directory"));
  symlinkSync(files.closedBeforeStart, join(dir, `${token()}.jsonl`));
  return { dir, files };
}

/** Async on purpose: a sync spawn would block this process, and with it the fake module the pass asks. */
async function run(dir: string, env: Record<string, string>): Promise<{ code: number; out: string; err: string }> {
  const r = Bun.spawn([perl!, SCRIPT], {
    env: {
      PATH: process.env["PATH"] ?? "",
      WRATHBENCH_AUDIT_DIR: dir,
      WRATHBENCH_LOG_RETENTION_DAYS: "3",
      WRATHBENCH_MODULE_HOST: `127.0.0.1:${server!.port}`,
      WRATHBENCH_MODULE_SECRET: SECRET,
      // Never the server beside the test: the holder is named per test.
      WRATHBENCH_RETENTION_HOLDER_PID: "0",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(r.stdout).text(), new Response(r.stderr).text(), r.exited]);
  return { code, out, err };
}

const line = (out: string, label: string): string => out.split("\n").find((l) => l.trim().startsWith(`${label}:`)) ?? "";
const count = (out: string, label: string): number => Number(/(\d+) files/.exec(line(out, label))?.[1] ?? NaN);
const size = (path: string) => statSync(path).size;

/** No fixture name, in any form, reaches stdout or stderr. */
function expectNoNames(f: Fixture, r: { out: string; err: string }): void {
  for (const path of Object.values(f.files)) {
    const name = path.slice(path.lastIndexOf("/") + 1);
    expect(r.out + r.err).not.toContain(name.slice(0, 32));
  }
  expect(r.out + r.err).not.toContain(f.dir);
}

describe.skipIf(perl === null)("the retention pass", () => {
  test("deletes past days and what is quiet and older than the server, empties what is quiet but younger, keeps the rest", async () => {
    const now = Math.floor(Date.now() / 1000);
    const f = fixture(now);
    const r = await run(f.dir, {});
    expect(r.code, r.err).toBe(0);
    expect(existsSync(f.files.closedBeforeStart!)).toBe(false);
    expect(existsSync(f.files.pastDay!)).toBe(false);
    expect(existsSync(f.files.pastDayDottedToken!)).toBe(false);
    expect(existsSync(f.files.quietSinceStart!)).toBe(true);
    expect(size(f.files.quietSinceStart!)).toBe(0);
    expect(size(f.files.fresh!)).toBe(100);
    expect(size(f.files.todayDated!)).toBe(200);
    expect(existsSync(f.files.emptySinceStart!)).toBe(true);
    expect(existsSync(join(f.dir, "a-directory"))).toBe(true);
    expect(count(r.out, "deleted")).toBe(3);
    expect(line(r.out, "deleted")).toContain("2 past day file(s)");
    expect(line(r.out, "deleted")).toContain("0.00 GB");
    expect(count(r.out, "truncated")).toBe(1);
    expect(count(r.out, "kept")).toBe(2);
    expect(count(r.out, "empty")).toBe(1);
    expect(r.out).toContain("1 live session(s)");
    expect(r.out).not.toContain("dry run");
    expectNoNames(f, r);
  });

  test("a dry run reports the same counts and changes nothing", async () => {
    const now = Math.floor(Date.now() / 1000);
    const f = fixture(now);
    const r = await run(f.dir, { DRY_RUN: "1" });
    expect(r.code, r.err).toBe(0);
    expect(count(r.out, "deleted")).toBe(3);
    expect(count(r.out, "truncated")).toBe(1);
    expect(r.out).toContain("dry run: nothing was changed");
    expect(size(f.files.closedBeforeStart!)).toBe(1000);
    expect(size(f.files.pastDay!)).toBe(700);
    expect(size(f.files.quietSinceStart!)).toBe(500);
    expectNoNames(f, r);
  });

  test("a file the named process holds open is never touched, whatever its age or date", async () => {
    const now = Math.floor(Date.now() / 1000);
    const f = fixture(now);
    const fds = [openSync(f.files.closedBeforeStart!, "a"), openSync(f.files.pastDay!, "a")];
    try {
      const r = await run(f.dir, { WRATHBENCH_RETENTION_HOLDER_PID: String(process.pid) });
      expect(r.code, r.err).toBe(0);
      expect(existsSync(f.files.closedBeforeStart!)).toBe(true);
      expect(size(f.files.closedBeforeStart!)).toBe(1000);
      expect(size(f.files.pastDay!)).toBe(700);
      expect(count(r.out, "held")).toBe(2);
      expect(count(r.out, "deleted")).toBe(1);
      expect(existsSync(f.files.pastDayDottedToken!)).toBe(false);
      expect(count(r.out, "truncated")).toBe(1);
      expectNoNames(f, r);
    } finally {
      for (const fd of fds) closeSync(fd);
    }
  });

  test("with the server start unknown only past days are deleted; the rest is emptied", async () => {
    const now = Math.floor(Date.now() / 1000);
    const cases: Record<string, string>[] = [{ WRATHBENCH_MODULE_HOST: "127.0.0.1:1" }, { WRATHBENCH_MODULE_SECRET: "wrong" }, { WRATHBENCH_MODULE_SECRET: "" }];
    for (const env of cases) {
      const f = fixture(now);
      const r = await run(f.dir, env);
      expect(r.code, r.err).toBe(0);
      expect(r.out).toContain("server start unknown");
      expect(count(r.out, "deleted")).toBe(2);
      expect(line(r.out, "deleted")).toContain("2 past day file(s)");
      expect(existsSync(f.files.pastDay!)).toBe(false);
      expect(count(r.out, "truncated")).toBe(2);
      expect(existsSync(f.files.closedBeforeStart!)).toBe(true);
      expect(size(f.files.closedBeforeStart!)).toBe(0);
      expect(size(f.files.fresh!)).toBe(100);
      expect(size(f.files.todayDated!)).toBe(200);
      expectNoNames(f, r);
    }
    expect(line((await run(fixture(now).dir, { WRATHBENCH_MODULE_SECRET: "wrong" })).out, "log retention")).toContain("401");
  });

  test("a window of 0 or nothing disables the pass and touches no file", async () => {
    const now = Math.floor(Date.now() / 1000);
    for (const days of ["0", "", "three"]) {
      const f = fixture(now);
      const before = hits;
      const r = await run(f.dir, { WRATHBENCH_LOG_RETENTION_DAYS: days });
      expect(r.code).toBe(0);
      expect(r.out).toContain("disabled");
      expect(hits).toBe(before);
      expect(size(f.files.closedBeforeStart!)).toBe(1000);
      expectNoNames(f, r);
    }
  });

  test("the window is the operator's: seven days keeps what three would prune", async () => {
    const now = Math.floor(Date.now() / 1000);
    const f = fixture(now);
    const r = await run(f.dir, { WRATHBENCH_LOG_RETENTION_DAYS: "7" });
    expect(r.code, r.err).toBe(0);
    expect(count(r.out, "kept")).toBe(7);
    expect(count(r.out, "deleted")).toBe(0);
    expect(size(f.files.closedBeforeStart!)).toBe(1000);
    expect(size(f.files.pastDay!)).toBe(700);
  });

  test("today's day file follows the undated rules: quiet for a short window but younger than the server, it is emptied, not deleted", async () => {
    const now = Math.floor(Date.now() / 1000);
    const f = fixture(now);
    const r = await run(f.dir, { WRATHBENCH_LOG_RETENTION_DAYS: "0.25" });
    expect(r.code, r.err).toBe(0);
    expect(existsSync(f.files.todayDated!)).toBe(true);
    expect(size(f.files.todayDated!)).toBe(0);
    expect(existsSync(f.files.pastDay!)).toBe(false);
    expect(count(r.out, "deleted")).toBe(3);
    expect(count(r.out, "truncated")).toBe(3);
    expectNoNames(f, r);
  });

  test("an unreadable directory is a failure, not a silent pass", async () => {
    const r = await run(join(tempDir("wb-log-retention-"), "absent"), {});
    expect(r.code).toBe(1);
  });
});

describe.skipIf(helm === null)("the chart's log-retention CronJob", () => {
  const BASE = ["template", "wrathbench", CHART, "--namespace", "wrathbench", "--set", "image.registry=reg.example/wrathbench", "--set", "image.tag=harness-0.5-1-gabcdef0"];
  type Doc = { kind?: string; metadata?: { name?: string }; data?: Record<string, string>; spec?: Record<string, unknown> } | null;
  const render = (extra: string[]): Doc[] => {
    const r = Bun.spawnSync([helm!, ...BASE, ...extra], { stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode, r.stderr.toString()).toBe(0);
    return r.stdout.toString().split(/^---$/m).map((d) => Bun.YAML.parse(d) as Doc);
  };
  const byKind = (docs: Doc[], kind: string) => docs.filter((d) => d?.kind === kind && d.metadata?.name === "wrathbench-log-retention");

  test("renders by default with a three-day window, the script as shipped, and names no file", () => {
    const docs = render([]);
    const [cm] = byKind(docs, "ConfigMap");
    expect(cm?.data?.["log-retention.pl"]).toBe(readFileSync(SCRIPT, "utf8"));
    const [cj] = byKind(docs, "CronJob");
    expect(cj).toBeDefined();
    const spec = cj!.spec as { schedule: string; concurrencyPolicy: string; jobTemplate: { spec: { template: { spec: { containers: { command: string[]; env: { name: string; value?: string }[]; image: string }[]; automountServiceAccountToken: boolean } } } } };
    expect(spec.schedule).toBe("30 2 * * *");
    expect(spec.concurrencyPolicy).toBe("Forbid");
    const pod = spec.jobTemplate.spec.template.spec;
    expect(pod.automountServiceAccountToken).toBe(false);
    const [c] = pod.containers;
    expect(c!.image).toBe("reg.example/wrathbench/wrathbench-worldserver:harness-0.5-1-gabcdef0");
    expect(c!.command.at(-1)).toBe("/opt/wrathbench/log-retention.pl");
    expect(c!.command.join(" ")).not.toContain("jsonl");
    expect(c!.env.find((e) => e.name === "WRATHBENCH_LOG_RETENTION_DAYS")?.value).toBe("3");
    expect(c!.env.find((e) => e.name === "WRATHBENCH_MODULE_SECRET")).not.toHaveProperty("value");
  }, 30_000);

  test("a window of 0 renders neither the CronJob nor its ConfigMap, and the worldserver is unchanged either way", () => {
    const off = render(["--set", "worldserver.logRetention.days=0"]);
    expect(byKind(off, "CronJob")).toHaveLength(0);
    expect(byKind(off, "ConfigMap")).toHaveLength(0);
    const ws = (docs: Doc[]) => docs.find((d) => d?.kind === "Deployment" && d.metadata?.name === "wrathbench-worldserver");
    expect(ws(off)).toEqual(ws(render([])));
  }, 30_000);
});
