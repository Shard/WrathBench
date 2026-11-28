/**
 * `bun wb`: the table, the plan each command becomes, and a real spawn
 * through a `kubectl` shim.
 *
 * The properties pinned here are the ones that would hurt if they broke:
 *  - every command runs a file the repository has, and a fleet command always
 *    carries its mode flag (a bare one in the pod is a second supervisor);
 *  - a group alone is help, never a release, and nothing cluster-driving has a
 *    --local form;
 *  - a row whose flag the pod's older copy of its file lacks never runs;
 *  - the operator's arguments reach the script byte for byte, whatever they
 *    look like.
 */
import { describe, expect, test } from "bun:test";
import { accessSync, chmodSync, constants, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "./temp-dirs";
import { ENTRIES, GROUPS, REPO_ROOT, argvFor, parse, plan, targetPath, type Entry, type Options, type Plan } from "./wb";

const tempDir = tempDirs();
const WB = join(REPO_ROOT, "infra", "wb.ts");
const CLUSTER: Options = { target: "cluster", namespace: "wrathbench", release: "wrathbench" };
const LOCAL: Options = { ...CLUSTER, target: "local" };

/** Arguments a shell would have mangled: each must arrive as itself. */
const AWKWARD = ["--help", "--local", "--dry-run", "--", "", "two words", "$(touch /tmp/wb-pwned)", "'quoted'", '{"tier":"t2"}', "-n", "x;y", "*"];

function planned(entry: Entry, opts: Options, args: readonly string[]): Plan {
  const p = plan(entry, opts, args);
  if ("refused" in p) throw new Error(p.refused);
  return p;
}

function forms(e: Entry) {
  return e.local === null ? [e.cluster] : [e.cluster, e.local];
}

describe("the table", () => {
  test("every command's group is a group, every group has a command, and no command is listed twice", () => {
    const groups = new Set(ENTRIES.map((e) => e.group));
    expect([...groups].sort()).toEqual(Object.keys(GROUPS).sort());
    const names = ENTRIES.map((e) => `${e.group} ${e.command}`);
    expect(new Set(names).size).toBe(names.length);
  });

  test("every file a command runs exists, and a shell script is executable", () => {
    for (const e of ENTRIES) {
      for (const form of forms(e)) {
        const path = targetPath(form);
        expect(path, `${e.group} ${e.command}`).toBeDefined();
        expect(existsSync(join(REPO_ROOT, path!)), path).toBe(true);
        if (path!.endsWith(".sh")) expect(() => accessSync(join(REPO_ROOT, path!), constants.X_OK)).not.toThrow();
      }
    }
  });

  test("every run-fleet.ts command carries its mode flag: a bare one in the pod is a second supervisor", () => {
    const fleet = ENTRIES.filter((e) => e.cluster.argv.includes("infra/run-fleet.ts"));
    expect(fleet.length).toBeGreaterThan(0);
    for (const e of fleet) expect(["--status", "--dry-run", "--clear-model"]).toContain(e.cluster.argv[2]!);
  });

  test("a row's required flag is in its argv and in this checkout's copy of its file", () => {
    const rows = ENTRIES.filter((e) => e.requires !== undefined);
    expect(rows.length).toBeGreaterThan(0);
    for (const e of rows) {
      for (const form of forms(e)) {
        expect(form.argv).toContain(e.requires!);
        expect(readFileSync(join(REPO_ROOT, targetPath(form)!), "utf8")).toContain(e.requires!);
      }
    }
  });
});

describe("help is the table", () => {
  test("no group runs anything on its own: `bun wb release` is help, never a release", () => {
    for (const group of Object.keys(GROUPS)) {
      expect(parse([group], {})).toEqual({ kind: "help", opts: CLUSTER, group });
      expect(parse([group, "--help"], {})).toEqual({ kind: "help", opts: CLUSTER, group });
    }
    expect(parse([], {})).toEqual({ kind: "help", opts: CLUSTER });
    expect(parse(["-h"], {})).toEqual({ kind: "help", opts: CLUSTER });
  });
});

describe("arguments pass through untouched", () => {
  test("for every command on every target it has, after the fixed argv and in order", () => {
    for (const e of ENTRIES) {
      for (const opts of e.local === null ? [CLUSTER] : [CLUSTER, LOCAL]) {
        const p = planned(e, opts, AWKWARD);
        expect(p.argv.slice(-AWKWARD.length)).toEqual(AWKWARD);
        expect(p.argv.length).toBe(argvFor(opts.target === "local" ? e.local! : e.cluster, opts, []).length + AWKWARD.length);
      }
    }
  });
});

describe("where a command runs", () => {
  const entry = (g: string, c: string): Entry => ENTRIES.find((e) => e.group === g && e.command === c)!;

  test("a command that drives the cluster has no --local form", () => {
    for (const [g, c] of [["release", "run"], ["release", "deploy"], ["release", "viewer"], ["fleet", "drain"], ["fleet", "resume"], ["fleet", "state"], ["server", "health"], ["server", "log-retention"]] as const) {
      expect(plan(entry(g, c), LOCAL, [])).toHaveProperty("refused");
    }
  });
});

describe("--env: a variable for the command alone", () => {
  const entry = (g: string, c: string): Entry => ENTRIES.find((e) => e.group === g && e.command === c)!;
  const run = (argv: string[]) => {
    const r = parse(argv, { WRATHBENCH_TARGET: undefined });
    if (r.kind !== "run") throw new Error(`not a run: ${JSON.stringify(r)}`);
    return planned(r.entry, r.opts, r.args);
  };

  test("repeatable, in order, before the group; a runner command gets them in the pod or the container, a host command in its environment", () => {
    const vars = ["--env", "MODULE_RAID_ACCOUNTS=EVAL01,EVAL02", "--env", "MODULE_PARTY_ACCOUNTS=two words=x"];
    expect(run([...vars, "smoke", "raid-group", "--keep"]).argv).toEqual([
      "kubectl", "-n", "wrathbench", "exec", "-i", "deploy/wrathbench-runner", "--",
      "env", "MODULE_RAID_ACCOUNTS=EVAL01,EVAL02", "MODULE_PARTY_ACCOUNTS=two words=x", "bun", "infra/smoke/raid-group.ts", "--keep",
    ]);
    expect(run(["--local", ...vars, "smoke", "raid-group"]).argv).toEqual([
      "docker", "compose", "-f", "infra/compose.yml", "exec", "-T",
      "-e", "MODULE_RAID_ACCOUNTS=EVAL01,EVAL02", "-e", "MODULE_PARTY_ACCOUNTS=two words=x", "runner", "bun", "infra/smoke/raid-group.ts",
    ]);
    const host = run([...vars, "site", "og"]);
    expect(host.argv).toEqual(["bun", "infra/render-og.ts"]);
    expect(host.env).toMatchObject({ MODULE_RAID_ACCOUNTS: "EVAL01,EVAL02", MODULE_PARTY_ACCOUNTS: "two words=x", WRATHBENCH_K8S_NAMESPACE: "wrathbench" });
    // An empty value is a value.
    expect(run(["--env", "EMPTY=", "smoke", "raid-group"]).argv).toContain("EMPTY=");
  });

  test("without --env every argv is the one it always was", () => {
    for (const e of ENTRIES) for (const f of forms(e)) {
      const opts = f === e.local ? LOCAL : CLUSTER;
      expect(argvFor(f, { ...opts, env: [] }, ["x"])).toEqual(argvFor(f, opts, ["x"]));
    }
    expect(plan(entry("smoke", "raid-group"), CLUSTER, [])).not.toHaveProperty("env.MODULE_RAID_ACCOUNTS");
  });

  test("a bad name, a missing value or a name wb sets itself is refused, and the value is never echoed", () => {
    for (const bad of [["--env"], ["--env", "NOEQUALS"], ["--env", "lower=SECRETVALUE"], ["--env", "1ST=SECRETVALUE"], ["--env", "=SECRETVALUE"], ["--env", "A-B=SECRETVALUE"]]) {
      const r = parse([...bad, "smoke", "raid-group"], {});
      expect(r.kind).toBe("error");
      expect(JSON.stringify(r)).not.toContain("SECRETVALUE");
    }
    const reserved = parse(["--env", "WRATHBENCH_K8S_NAMESPACE=other", "smoke", "raid-group"], {});
    expect(reserved).toMatchObject({ kind: "error", message: "--env cannot set WRATHBENCH_K8S_NAMESPACE; use -n or --release" });
    // After the group it is the script's argument, not wb's.
    const late = parse(["smoke", "raid-group", "--env", "A=1"], {});
    expect(late).toMatchObject({ kind: "run", args: ["--env", "A=1"] });
    expect(late.opts.env).toBeUndefined();
  });
});

// ------------------------------------------------------------------ spawn

/**
 * A `kubectl` and a `docker` with nothing behind them: each records its argv
 * NUL-separated, one file per call. `exec … -- sh -c` is the missing-file
 * probe (answered from FAKE_PRESENT), `get` reads the runner's image, and
 * anything else exits FAKE_RC.
 */
const SHIM = `#!/usr/bin/env bash
n=$(ls "$FAKE_CALLS" | wc -l)
printf '%s\\0' "$(basename "$0")" "$@" > "$FAKE_CALLS/$(printf '%03d' "$n")"
for a in "$@"; do
  if [ "$a" = "sh" ]; then echo "\${FAKE_PRESENT:-present}"; exit 0; fi
done
if [ "\${3:-}" = "get" ]; then echo "registry.example/wrathbench-runner:harness-0.5-1-gold"; exit 0; fi
if [ "\${4:-}" = "ps" ]; then echo "\${FAKE_RUNNER_ID:-}"; exit 0; fi
exit "\${FAKE_RC:-0}"
`;

function runWb(args: readonly string[], env: Record<string, string> = {}): { code: number; out: string; err: string; calls: string[][] } {
  const dir = tempDir("wb-cli-");
  const bin = join(dir, "bin");
  const calls = join(dir, "calls");
  Bun.spawnSync(["mkdir", "-p", bin, calls]);
  for (const name of ["kubectl", "docker"]) {
    writeFileSync(join(bin, name), SHIM);
    chmodSync(join(bin, name), 0o755);
  }
  // From a directory with no .env, so Bun autoloads nothing into the run.
  const p = Bun.spawnSync([process.execPath, WB, ...args], {
    cwd: dir,
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, FAKE_CALLS: calls, WRATHBENCH_TARGET: "cluster", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const recorded = readdirSync(calls)
    .sort()
    .map((f) => readFileSync(join(calls, f), "utf8").split("\0").slice(0, -1));
  return { code: p.exitCode ?? 1, out: p.stdout.toString(), err: p.stderr.toString(), calls: recorded };
}

describe("bun wb, for real", () => {
  test("runs the planned argv once, with the operator's arguments intact", () => {
    const r = runWb(["config", "patch", "roster/x", '{"tier":"t2"}', "--note", "two words"]);
    expect(r.code).toBe(0);
    expect(r.calls).toEqual([
      ["kubectl", "-n", "wrathbench", "exec", "-i", "deploy/wrathbench-runner", "--", "bun", "runner/src/config-store.ts", "patch", "roster/x", '{"tier":"t2"}', "--note", "two words"],
    ]);
  });

  test("a row whose flag the pod's copy of its file lacks is refused, naming the image, and nothing runs", () => {
    const r = runWb(["accounts", "ensure", "SMOKE5"], { FAKE_PRESENT: "absent" });
    expect(r.code).toBe(2);
    expect(r.calls.length).toBe(2);
    expect(r.calls[0]!.slice(-3)).toEqual(["sh", "--accounts-only", "infra/bootstrap/bootstrap.ts"]);
    expect(r.calls[1]!.slice(0, 4)).toEqual(["kubectl", "-n", "wrathbench", "get"]);
    expect(r.err).toContain("infra/bootstrap/bootstrap.ts predates --accounts-only; the pod runs registry.example/wrathbench-runner:harness-0.5-1-gold");
  });

  test("--env reaches the pod as named, and nothing of wb's own environment does", () => {
    const r = runWb(["--env", "MODULE_RAID_ACCOUNTS=EVAL01,EVAL02,EVAL03,EVAL04,EVAL05,EVAL06", "smoke", "raid-group"], { WRATHBENCH_DB_PASSWORD: "s3cret", MODULE_PARTY_ACCOUNTS: "PARTY1" });
    expect(r.code).toBe(0);
    expect(r.calls).toEqual([
      ["kubectl", "-n", "wrathbench", "exec", "-i", "deploy/wrathbench-runner", "--", "env", "MODULE_RAID_ACCOUNTS=EVAL01,EVAL02,EVAL03,EVAL04,EVAL05,EVAL06", "bun", "infra/smoke/raid-group.ts"],
    ]);
    expect(r.calls.flat().join(" ")).not.toMatch(/s3cret|MODULE_PARTY_ACCOUNTS/);
    // A group's help prints the table's argv, never the operator's values.
    const help = runWb(["--env", "MODULE_RAID_ACCOUNTS=SECRETVALUE", "smoke"]);
    expect(help).toMatchObject({ code: 0, calls: [] });
    expect(help.out).toContain("infra/smoke/raid-group.ts");
    expect(help.out).not.toContain("SECRETVALUE");
  });

  test("help, and an unknown command, run nothing", () => {
    expect(runWb([])).toMatchObject({ code: 0, calls: [] });
    expect(runWb(["fleet"])).toMatchObject({ code: 0, calls: [] });
    const bad = runWb(["fleet", "statsu"]);
    expect(bad).toMatchObject({ code: 2, calls: [] });
    expect(bad.err).toContain('no command "fleet statsu"');
    expect(runWb(["--local", "release", "run"])).toMatchObject({ code: 2, calls: [] });
  });
});
