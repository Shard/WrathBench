/**
 * `bun wb`: the table, the plan each command becomes, and one real spawn
 * through a `kubectl` shim.
 *
 * The properties pinned here are the ones the dispatcher exists for:
 *  - help and dispatch read one table, so every command is in the help with
 *    the argv it runs;
 *  - every command runs a file the repository has, and no command asks the
 *    runner pod to run wb itself (the pod's image can be older than the
 *    checkout);
 *  - the operator's arguments reach the script byte for byte, whatever they
 *    look like;
 *  - a runner command on the cluster is a `kubectl exec` into the runner
 *    Deployment, and under --local an exec into compose's runner container.
 */
import { describe, expect, test } from "bun:test";
import { accessSync, chmodSync, constants, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "./temp-dirs";
import { ENTRIES, GROUPS, REPO_ROOT, argvFor, groupHelp, parse, plan, targetPath, topHelp, type Entry, type Options, type Plan } from "./wb";

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

  test("no command runs wb itself, in the pod or here", () => {
    for (const e of ENTRIES) {
      for (const form of forms(e)) expect(form.argv.some((a) => /(^|\/)wb\.ts$|^infra\/cli\//.test(a)), `${e.group} ${e.command}`).toBe(false);
    }
  });

  test("a runner command is `bun <file>`, the only thing the pod is asked to run", () => {
    for (const e of ENTRIES) {
      for (const form of forms(e)) if (form.place === "runner") expect(form.argv.slice(0, 2)).toEqual(["bun", targetPath(form)!]);
    }
  });

  test("every run-fleet.ts command carries its mode flag: a bare one in the pod is a second supervisor", () => {
    const fleet = ENTRIES.filter((e) => e.cluster.argv.includes("infra/run-fleet.ts"));
    expect(fleet.length).toBeGreaterThan(0);
    for (const e of fleet) expect(["--status", "--dry-run", "--clear-model"]).toContain(e.cluster.argv[2]!);
  });

  test("the smokes are every infra/smoke/*.ts and nothing under lib/", () => {
    const files = readdirSync(join(REPO_ROOT, "infra", "smoke"))
      .filter((f) => f.endsWith(".ts"))
      .map((f) => f.slice(0, -3))
      .sort();
    expect(ENTRIES.filter((e) => e.group === "smoke").map((e) => e.command)).toEqual(files);
    expect(files).toContain("preflight");
  });

  test("a row's required flag is in its argv and in this checkout's copy of its file", () => {
    const rows = ENTRIES.filter((e) => e.requires !== undefined);
    expect(rows.map((e) => `${e.group} ${e.command}`).sort()).toEqual(["accounts ensure", "accounts spectator"]);
    for (const e of rows) {
      for (const form of forms(e)) {
        expect(form.argv).toContain(e.requires!);
        expect(readFileSync(join(REPO_ROOT, targetPath(form)!), "utf8")).toContain(e.requires!);
      }
    }
  });

  test("the root package.json runs this file as `bun wb`", () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["wb"]).toBe("bun infra/wb.ts");
  });
});

describe("help is the table", () => {
  test("the top help names every group and every command", () => {
    const help = topHelp(CLUSTER);
    for (const group of Object.keys(GROUPS)) expect(help).toContain(`  ${group} `);
    for (const e of ENTRIES) expect(help).toContain(e.command);
  });

  test("a group's help shows each command with the argv it runs on each target", () => {
    for (const group of Object.keys(GROUPS)) {
      const help = groupHelp(group, CLUSTER);
      for (const e of ENTRIES.filter((x) => x.group === group)) {
        expect(help).toContain(`  ${e.command}`);
        expect(help).toContain(argvFor(e.cluster, CLUSTER, []).join(" "));
        if (e.local !== null) expect(help).toContain(argvFor(e.local, LOCAL, []).join(" "));
      }
    }
  });

  test("no group runs anything on its own: `bun wb release` is help, never a release", () => {
    for (const group of Object.keys(GROUPS)) {
      expect(parse([group], {})).toEqual({ kind: "help", opts: CLUSTER, group });
      expect(parse([group, "--help"], {})).toEqual({ kind: "help", opts: CLUSTER, group });
    }
    expect(parse([], {})).toEqual({ kind: "help", opts: CLUSTER });
    expect(parse(["-h"], {})).toEqual({ kind: "help", opts: CLUSTER });
  });

  test("an unknown group, command or global flag is an error", () => {
    expect(parse(["nope"], {}).kind).toBe("error");
    expect(parse(["fleet", "nope"], {})).toMatchObject({ kind: "error", group: "fleet" });
    expect(parse(["--nope", "fleet", "status"], {}).kind).toBe("error");
    expect(parse(["-n"], {}).kind).toBe("error");
    expect(parse(["fleet", "status"], { WRATHBENCH_TARGET: "staging" }).kind).toBe("error");
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

  test("global flags after the command are the script's, not wb's", () => {
    const r = parse(["run", "episode", "--local", "--model", "m", "-n", "elsewhere", "--release", "r"], {});
    expect(r).toMatchObject({ kind: "run", opts: CLUSTER, args: ["--local", "--model", "m", "-n", "elsewhere", "--release", "r"] });
  });
});

describe("where a command runs", () => {
  const entry = (g: string, c: string): Entry => ENTRIES.find((e) => e.group === g && e.command === c)!;

  test("on the cluster, a runner command is a kubectl exec into the runner Deployment", () => {
    expect(planned(entry("fleet", "status"), CLUSTER, []).argv).toEqual([
      "kubectl", "-n", "wrathbench", "exec", "-i", "deploy/wrathbench-runner", "--", "bun", "infra/run-fleet.ts", "--status",
    ]);
    expect(planned(entry("config", "get"), CLUSTER, ["preflight"]).argv).toEqual([
      "kubectl", "-n", "wrathbench", "exec", "-i", "deploy/wrathbench-runner", "--", "bun", "runner/src/config-store.ts", "get", "preflight",
    ]);
  });

  test("the namespace and release come from the environment, and a global flag beats it", () => {
    const env = { WRATHBENCH_K8S_NAMESPACE: "lab", WRATHBENCH_K8S_RELEASE: "wb2" };
    const fromEnv = parse(["smoke", "preflight"], env);
    expect(fromEnv).toMatchObject({ kind: "run", opts: { target: "cluster", namespace: "lab", release: "wb2" } });
    if (fromEnv.kind !== "run") throw new Error("parse");
    expect(planned(fromEnv.entry, fromEnv.opts, []).argv.slice(0, 7)).toEqual(["kubectl", "-n", "lab", "exec", "-i", "deploy/wb2-runner", "--"]);
    const fromFlag = parse(["-n", "ns", "--release", "rel", "smoke", "preflight"], env);
    expect(fromFlag).toMatchObject({ kind: "run", opts: { namespace: "ns", release: "rel" } });
  });

  test("a host script gets the namespace and release through its environment, never as a flag", () => {
    const opts: Options = { target: "cluster", namespace: "lab", release: "wb2" };
    const p = planned(entry("fleet", "drain"), opts, ["--dry-run"]);
    expect(p.argv).toEqual(["infra/fleet-update.sh", "drain", "--dry-run"]);
    expect(p.env).toEqual({ WRATHBENCH_K8S_NAMESPACE: "lab", WRATHBENCH_K8S_RELEASE: "wb2" });
    expect(p.cwd).toBe(REPO_ROOT);
  });

  test("--local, or WRATHBENCH_TARGET=local, is the compose quickstart", () => {
    expect(parse(["--local", "fleet", "status"], {})).toMatchObject({ kind: "run", opts: { target: "local" } });
    const r = parse(["config", "audit", "5"], { WRATHBENCH_TARGET: "local" });
    if (r.kind !== "run") throw new Error("parse");
    expect(planned(r.entry, r.opts, r.args).argv).toEqual([
      "docker", "compose", "-f", "infra/compose.yml", "exec", "-T", "runner", "bun", "runner/src/config-store.ts", "audit", "5",
    ]);
  });

  test("an episode is run-episode.sh into the pod on the cluster, and its compose default under --local", () => {
    expect(planned(entry("run", "episode"), CLUSTER, ["--model", "m"]).argv).toEqual(["infra/run-episode.sh", "--k8s", "--model", "m"]);
    expect(planned(entry("run", "episode"), LOCAL, ["--model", "m"]).argv).toEqual(["infra/run-episode.sh", "--model", "m"]);
  });

  test("a campaign publish writes the pod's store on the cluster and the local one under --local", () => {
    const file = "runner/campaigns/race-probe@1.json";
    expect(planned(entry("campaign", "publish"), CLUSTER, [file]).argv).toEqual(["bun", "runner/src/campaign-publish.ts", "--k8s", file]);
    expect(planned(entry("campaign", "publish"), LOCAL, [file]).argv).toEqual(["bun", "runner/src/campaign-publish.ts", file]);
  });

  test("a command that drives the cluster has no --local form", () => {
    for (const [g, c] of [["release", "run"], ["release", "deploy"], ["fleet", "drain"], ["fleet", "resume"], ["fleet", "state"], ["server", "health"]] as const) {
      expect(plan(entry(g, c), LOCAL, [])).toHaveProperty("refused");
    }
  });

  test("the local-model probe runs here on either target: it needs no module", () => {
    expect(planned(entry("smoke", "local-model"), CLUSTER, []).argv).toEqual(["bun", "infra/smoke/local-model.ts"]);
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

  test("exits with the command's own code, and says nothing more when the file is in the pod", () => {
    const r = runWb(["fleet", "status"], { FAKE_RC: "3" });
    expect(r.code).toBe(3);
    expect(r.calls.length).toBe(2);
    expect(r.err).not.toContain("not in the runner pod");
  });

  test("names the deployed image when a failed command's file is not in the pod", () => {
    const r = runWb(["smoke", "preflight"], { FAKE_RC: "1", FAKE_PRESENT: "absent" });
    expect(r.code).toBe(1);
    expect(r.calls[1]!.slice(-4)).toEqual(["-c", 'if [ -e "$1" ]; then echo present; else echo absent; fi', "sh", "infra/smoke/preflight.ts"]);
    expect(r.err).toContain("infra/smoke/preflight.ts is not in the runner pod, which runs registry.example/wrathbench-runner:harness-0.5-1-gold");
  });

  test("--local execs into compose's runner container", () => {
    const r = runWb(["--local", "smoke", "module-slice"]);
    expect(r.code).toBe(0);
    expect(r.calls).toEqual([["docker", "compose", "-f", "infra/compose.yml", "exec", "-T", "runner", "bun", "infra/smoke/module-slice.ts"]]);
  });

  test("a row whose flag the pod's copy of its file lacks is refused, naming the image, and nothing runs", () => {
    const r = runWb(["accounts", "ensure", "SMOKE5"], { FAKE_PRESENT: "absent" });
    expect(r.code).toBe(2);
    expect(r.calls.length).toBe(2);
    expect(r.calls[0]!.slice(-3)).toEqual(["sh", "--accounts-only", "infra/bootstrap/bootstrap.ts"]);
    expect(r.calls[1]!.slice(0, 4)).toEqual(["kubectl", "-n", "wrathbench", "get"]);
    expect(r.err).toContain("infra/bootstrap/bootstrap.ts predates --accounts-only; the pod runs registry.example/wrathbench-runner:harness-0.5-1-gold");
  });

  test("a check that cannot read the pod's file refuses too", () => {
    const r = runWb(["accounts", "spectator"], { FAKE_PRESENT: "Error from server" });
    expect(r.code).toBe(2);
    expect(r.calls.length).toBe(1);
    expect(r.err).toContain("could not read the runner pod's infra/spectator-account.ts");
  });

  test("once the pod's file has the flag, the command runs with the operator's names", () => {
    const r = runWb(["accounts", "ensure", "SMOKE5", "PROBE"]);
    expect(r.code).toBe(0);
    expect(r.calls.length).toBe(2);
    expect(r.calls[1]).toEqual([
      "kubectl", "-n", "wrathbench", "exec", "-i", "deploy/wrathbench-runner", "--", "bun", "infra/bootstrap/bootstrap.ts", "--accounts-only", "SMOKE5", "PROBE",
    ]);
  });

  test("--local checks nothing first: compose's runner has this checkout's file", () => {
    const r = runWb(["--local", "accounts", "ensure", "SMOKE5"]);
    expect(r.code).toBe(0);
    expect(r.calls).toEqual([["docker", "compose", "-f", "infra/compose.yml", "exec", "-T", "runner", "bun", "infra/bootstrap/bootstrap.ts", "--accounts-only", "SMOKE5"]]);
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
