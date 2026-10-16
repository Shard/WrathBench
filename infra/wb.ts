#!/usr/bin/env bun
/**
 * `bun wb <group> <command> [args…]`: one front door to the operator's
 * scripts. It is for people only.
 *
 * Every command is a fixed argv in front of the operator's own arguments,
 * which pass through untouched, `--help` included. So `bun wb fleet status`
 * is exactly `bun infra/run-fleet.ts --status`, run where the data is. The
 * scripts keep their paths and their own flags. The chart, the supervisor and
 * the config store go on calling them by path and never through here: a
 * roster or a run launched through wb would hide from the argv matchers the
 * drain and the archive guard read.
 *
 * Where a command runs is decided once, here:
 *
 *  - A `runner` command reads or writes the data volume: the fleet's state,
 *    the config store, the smokes' accounts. On a cluster it runs in the
 *    runner pod, as `kubectl -n <ns> exec -i deploy/<release>-runner -- bun
 *    <path> …`. The pod is only ever asked to run a file its image already
 *    has, never this one, because the deployed image can be older than the
 *    checkout (mid-release, on a branch, after a merge before the pin). When
 *    such a command fails and its file is not in the pod, wb names the image
 *    the pod runs. A row whose meaning rests on a flag the file gained later
 *    names that flag, and wb checks the pod's copy carries it before running
 *    anything: an older file would ignore the flag and do something else.
 *  - A `host` command runs on this machine, from the repository root. The
 *    release, the fleet's update window and the server probe drive kubectl
 *    themselves; the site and data commands write this checkout or the public
 *    bucket.
 *
 * The cluster is the default target. `--local`, or WRATHBENCH_TARGET=local,
 * targets the compose quickstart on this machine instead: a runner command is
 * exec'd into compose's `runner` container, and a command with no compose
 * form is refused. The namespace and the release come from
 * WRATHBENCH_K8S_NAMESPACE and WRATHBENCH_K8S_RELEASE (default `wrathbench`),
 * or `-n`/`--release`; a host script gets them through that same environment,
 * never as an added flag. Global flags go before the group. Everything after
 * the command belongs to the script.
 */

import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";

export const REPO_ROOT = resolve(import.meta.dir, "..");
const COMPOSE_FILE = "infra/compose.yml";

/** Where a command's argv is executed. */
export type Place = "runner" | "host";

/** One way to run a command: a fixed argv, then the operator's arguments. */
export interface Form {
  readonly place: Place;
  readonly argv: readonly string[];
}

export interface Entry {
  readonly group: string;
  readonly command: string;
  /** What the command takes, for the help line. */
  readonly takes?: string;
  readonly summary: string;
  readonly cluster: Form;
  /** The compose quickstart's form; null when there is none, and --local is refused. */
  readonly local: Form | null;
  /**
   * A flag the runner's copy of the file must carry before this runs there on
   * the cluster. bootstrap.ts from before `--accounts-only` ignores its
   * arguments and runs the whole bootstrap, which in the runner pod would
   * re-advertise the realm; so the row is refused until the image has it.
   * Under --local the runner's file is this checkout's (compose bind-mounts it).
   */
  readonly requires?: string;
}

/** The groups, in help order, with what each is for. A group with no command is not here. */
export const GROUPS: Readonly<Record<string, string>> = {
  fleet: "the supervisor: what it runs, what it would run, and its update window",
  run: "one episode by hand",
  config: "the config store (the fleet config)",
  campaign: "probe campaign definitions",
  release: "build the images, release them, and the deploy window",
  server: "the worldserver's module, and the viewer",
  accounts: "game accounts: the harness's, and the operator's GM spectator",
  smoke: "the smoke scripts under infra/smoke",
  site: "the public site",
  data: "prices and logos this checkout carries",
  chart: "checks on the Helm chart",
};

/** Runs in the runner: the pod on a cluster, compose's `runner` container under --local. */
function inRunner(...argv: string[]): Pick<Entry, "cluster" | "local"> {
  const form: Form = { place: "runner", argv };
  return { cluster: form, local: form };
}

/** Runs here, the same way on either target. */
function onHost(...argv: string[]): Pick<Entry, "cluster" | "local"> {
  const form: Form = { place: "host", argv };
  return { cluster: form, local: form };
}

/** Runs here, against the cluster only. */
function clusterOnly(...argv: string[]): Pick<Entry, "cluster" | "local"> {
  return { cluster: { place: "host", argv }, local: null };
}

/** The smokes, one command each, named for their file. */
function smokeEntries(): Entry[] {
  const names = readdirSync(join(REPO_ROOT, "infra", "smoke"), { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts"))
    .map((e) => e.name.slice(0, -".ts".length))
    .sort();
  return names.map((name) => {
    const path = `infra/smoke/${name}.ts`;
    // The local-model probe calls a model endpoint and never the module, so it
    // needs neither the pod nor the stack.
    if (name === "local-model") {
      return { group: "smoke", command: name, summary: "can a self-hosted endpoint drive the tool loop", ...onHost("bun", path) };
    }
    return { group: "smoke", command: name, summary: path, ...inRunner("bun", path) };
  });
}

const CONFIG_STORE = "runner/src/config-store.ts";
const BOOTSTRAP = "infra/bootstrap/bootstrap.ts";
const SPECTATOR = "infra/spectator-account.ts";
const RUN_FLEET = "infra/run-fleet.ts";
const FLEET_UPDATE = "infra/fleet-update.sh";

/**
 * The table. Help and dispatch both read it and nothing else, so they cannot
 * disagree. Every `run-fleet.ts` row carries its mode flag: a bare
 * `run-fleet.ts` in the runner pod would be a second supervisor on the same
 * store.
 */
export const ENTRIES: readonly Entry[] = [
  { group: "fleet", command: "status", summary: "accounts, models and sessions; read-only", ...inRunner("bun", RUN_FLEET, "--status") },
  { group: "fleet", command: "dry-run", summary: "what the next tick would spawn; spawns nothing", ...inRunner("bun", RUN_FLEET, "--dry-run") },
  {
    group: "fleet",
    command: "clear-model",
    takes: "<roster-name>",
    summary: "forgive a model's defer ladder or retirement; the next tick picks it up",
    ...inRunner("bun", RUN_FLEET, "--clear-model"),
  },
  { group: "fleet", command: "state", summary: "the pause switch, the heartbeat, the live jobs", ...clusterOnly(FLEET_UPDATE, "status") },
  { group: "fleet", command: "graceful", summary: "new supervisor code, with nobody's run interrupted", ...clusterOnly(FLEET_UPDATE, "graceful") },
  { group: "fleet", command: "force", summary: "recreate the supervisor now; live scored runs spend their attempt", ...clusterOnly(FLEET_UPDATE, "force") },
  { group: "fleet", command: "drain", summary: "pause, wait for quiet, scale the fleet to 0; the switch stays set", ...clusterOnly(FLEET_UPDATE, "drain") },
  { group: "fleet", command: "resume", summary: "clear the pause switch", ...clusterOnly(FLEET_UPDATE, "resume") },

  {
    group: "run",
    command: "episode",
    takes: "--model <id> … | --resume <run-id>",
    summary: "one episode, launched in the runner",
    cluster: { place: "host", argv: ["infra/run-episode.sh", "--k8s"] },
    local: { place: "host", argv: ["infra/run-episode.sh"] },
  },

  { group: "config", command: "get", takes: "[key]", summary: "one row's document, or every key", ...inRunner("bun", CONFIG_STORE, "get") },
  { group: "config", command: "set", takes: "<key> <json|->", summary: "replace one row; validated", ...inRunner("bun", CONFIG_STORE, "set") },
  { group: "config", command: "patch", takes: "<key> <json>", summary: "merge into one row; validated", ...inRunner("bun", CONFIG_STORE, "patch") },
  { group: "config", command: "delete", takes: "<key>", summary: "remove one row; validated", ...inRunner("bun", CONFIG_STORE, "delete") },
  { group: "config", command: "audit", takes: "[n]", summary: "the last n changes", ...inRunner("bun", CONFIG_STORE, "audit") },
  {
    group: "config",
    command: "export",
    takes: "[file]",
    summary: "the store as one document, to stdout (a file argument is a path in the runner)",
    ...inRunner("bun", CONFIG_STORE, "export"),
  },
  {
    group: "config",
    command: "seed",
    takes: "[file] [--force]",
    summary: "import a config document (default infra/fleet.example.json, as the runner has it)",
    ...inRunner("bun", CONFIG_STORE, "seed"),
  },

  {
    group: "campaign",
    command: "publish",
    takes: "runner/campaigns/<id>@<v>.json",
    summary: "publish a definition into the store; checked here, where git is",
    cluster: { place: "host", argv: ["bun", "runner/src/campaign-publish.ts", "--k8s"] },
    local: { place: "host", argv: ["bun", "runner/src/campaign-publish.ts"] },
  },

  { group: "release", command: "run", summary: "the whole release: build, drain, pin, deploy, resume", ...clusterOnly("infra/k8s-release.sh") },
  { group: "release", command: "build", summary: "build every image at one tag, from the commit", ...onHost("infra/build-images.sh") },
  { group: "release", command: "deploy", summary: "the deploy window alone: drain, wait, smoke, resume", ...clusterOnly("infra/k8s-deploy.sh") },

  { group: "server", command: "health", summary: "the module's health census, read inside the worldserver", ...clusterOnly("infra/module-health.sh") },
  { group: "server", command: "restart-viewer", summary: "rollout restart the viewer, then check it answers", ...clusterOnly("infra/viewer-restart.sh") },

  // Both write game accounts, so neither has a default: `ensure` creates only
  // the accounts it is given, and `spectator` only with a password on stdin.
  {
    group: "accounts",
    command: "ensure",
    takes: "<NAME>…",
    summary: "create each named account that is missing (password: its name); nothing else is written",
    requires: "--accounts-only",
    ...inRunner("bun", BOOTSTRAP, "--accounts-only"),
  },
  {
    group: "accounts",
    command: "spectator",
    takes: "(password on stdin)",
    summary: "ensure the operator's GM account SPECTATOR; read -rs P && printf '%s\\n' \"$P\" | bun wb accounts spectator",
    requires: "--password-stdin",
    ...inRunner("bun", SPECTATOR, "--password-stdin"),
  },

  ...smokeEntries(),

  { group: "site", command: "ship", summary: "build and deploy the public site", ...onHost("infra/deploy-dashboard.sh") },
  { group: "site", command: "og", summary: "render the social card", ...onHost("bun", "infra/render-og.ts") },
  { group: "site", command: "tiles", summary: "upload changed minimap tiles (--dry-run | --upload)", ...onHost("bun", "infra/publish-tiles.ts") },
  { group: "site", command: "verify", summary: "read the public bucket back and check it", ...onHost("bun", "infra/publish-accept.ts") },

  { group: "data", command: "prices", summary: "sync OpenRouter list prices into the price file", ...onHost("bun", "infra/sync-prices.ts") },
  { group: "data", command: "logos", summary: "fetch the model logos the lineup names (--check: drift only)", ...onHost("bun", "infra/fetch-model-logos.ts") },

  { group: "chart", command: "check", summary: "the database pods do not roll when only the release moves", ...onHost("infra/chart/stable-pod-templates.sh") },
];

/** The repository file a form runs: the first `.ts` or `.sh` in its argv. */
export function targetPath(form: Form): string | undefined {
  return form.argv.find((a) => a.endsWith(".ts") || a.endsWith(".sh"));
}

export interface Options {
  readonly target: "cluster" | "local";
  readonly namespace: string;
  readonly release: string;
}

export type Parsed =
  | { kind: "help"; opts: Options; group?: string }
  | { kind: "run"; opts: Options; entry: Entry; args: string[] }
  | { kind: "error"; message: string; opts: Options; group?: string };

function nonEmpty(v: string | undefined): string | undefined {
  return v === undefined || v === "" ? undefined : v;
}

/** Read the global flags, the group and the command. Nothing after the command is looked at. */
export function parse(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): Parsed {
  const envTarget = nonEmpty(env["WRATHBENCH_TARGET"]);
  let target: Options["target"] = "cluster";
  let namespace = nonEmpty(env["WRATHBENCH_K8S_NAMESPACE"]) ?? "wrathbench";
  let release = nonEmpty(env["WRATHBENCH_K8S_RELEASE"]) ?? "wrathbench";
  const opts = (): Options => ({ target, namespace, release });
  if (envTarget !== undefined) {
    if (envTarget !== "cluster" && envTarget !== "local") {
      return { kind: "error", message: `WRATHBENCH_TARGET is "${envTarget}"; it is cluster or local`, opts: opts() };
    }
    target = envTarget;
  }
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("-")) break;
    if (a === "-h" || a === "--help") return { kind: "help", opts: opts() };
    if (a === "--local") {
      target = "local";
      continue;
    }
    if (a === "-n" || a === "--namespace" || a === "--release") {
      const v = argv[++i];
      if (v === undefined || v === "" || v.startsWith("-")) return { kind: "error", message: `${a} needs a value`, opts: opts() };
      if (a === "--release") release = v;
      else namespace = v;
      continue;
    }
    return { kind: "error", message: `unknown flag ${a} (global flags go before the group)`, opts: opts() };
  }
  const group = argv[i];
  if (group === undefined) return { kind: "help", opts: opts() };
  if (!(group in GROUPS)) return { kind: "error", message: `no group "${group}"`, opts: opts() };
  const command = argv[i + 1];
  if (command === undefined || command === "-h" || command === "--help") return { kind: "help", opts: opts(), group };
  const entry = ENTRIES.find((e) => e.group === group && e.command === command);
  if (entry === undefined) return { kind: "error", message: `no command "${group} ${command}"`, opts: opts(), group };
  return { kind: "run", opts: opts(), entry, args: argv.slice(i + 2) };
}

export interface Plan {
  readonly argv: string[];
  readonly cwd: string;
  /** Added to the inherited environment. */
  readonly env: Record<string, string>;
}

/** The runner pod, as kubectl names it. */
export function runnerPod(opts: Options): string {
  return `deploy/${opts.release}-runner`;
}

/** The argv a form runs on a target, with the operator's arguments appended untouched. */
export function argvFor(form: Form, opts: Options, args: readonly string[]): string[] {
  if (form.place === "host") return [...form.argv, ...args];
  if (opts.target === "cluster") return ["kubectl", "-n", opts.namespace, "exec", "-i", runnerPod(opts), "--", ...form.argv, ...args];
  return ["docker", "compose", "-f", COMPOSE_FILE, "exec", "-T", "runner", ...form.argv, ...args];
}

/** What one command runs, or why it cannot. */
export function plan(entry: Entry, opts: Options, args: readonly string[]): Plan | { refused: string } {
  const form = opts.target === "local" ? entry.local : entry.cluster;
  if (form === null) return { refused: `"${entry.group} ${entry.command}" drives the cluster; it has no --local form` };
  return {
    argv: argvFor(form, opts, args),
    cwd: REPO_ROOT,
    env: { WRATHBENCH_K8S_NAMESPACE: opts.namespace, WRATHBENCH_K8S_RELEASE: opts.release },
  };
}

// ------------------------------------------------------------------ help

export function topHelp(opts: Options): string {
  const lines = [
    "usage: bun wb [--local] [-n <namespace>] [--release <name>] <group> <command> [args…]",
    "",
  ];
  for (const [group, what] of Object.entries(GROUPS)) {
    const commands = ENTRIES.filter((e) => e.group === group).map((e) => e.command);
    lines.push(`  ${group.padEnd(9)} ${what}`);
    lines.push(`  ${"".padEnd(9)} ${wrap(commands.join(", "), 66).join(`\n  ${"".padEnd(9)} `)}`);
  }
  lines.push(
    "",
    "`bun wb <group>` shows what each command runs. Arguments after the command",
    "reach the script untouched, --help included.",
    "",
    `Target: ${opts.target === "cluster" ? `the cluster (namespace ${opts.namespace}, release ${opts.release})` : "the compose quickstart on this machine"}.`,
    "--local, or WRATHBENCH_TARGET=local, is the compose quickstart; -n and --release,",
    "or WRATHBENCH_K8S_NAMESPACE and WRATHBENCH_K8S_RELEASE, name the cluster's.",
  );
  return lines.join("\n");
}

export function groupHelp(group: string, opts: Options): string {
  const clusterOpts: Options = { ...opts, target: "cluster" };
  const localOpts: Options = { ...opts, target: "local" };
  const lines = [`usage: bun wb ${group} <command> [args…]`, "", `${GROUPS[group]}.`, ""];
  for (const e of ENTRIES.filter((x) => x.group === group)) {
    lines.push(`  ${[e.command, e.takes].filter(Boolean).join(" ")}`);
    lines.push(`      ${e.summary}`);
    const cluster = argvFor(e.cluster, clusterOpts, []).join(" ");
    const local = e.local === null ? null : argvFor(e.local, localOpts, []).join(" ");
    if (local === cluster) lines.push(`      runs: ${cluster}`);
    else {
      lines.push(`      runs: ${cluster}`);
      lines.push(`      --local: ${local ?? "(none: it drives the cluster)"}`);
    }
    if (e.requires !== undefined) lines.push(`      first: the runner pod's ${targetPath(e.cluster)} must have ${e.requires}, or nothing runs`);
  }
  return lines.join("\n");
}

function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line !== "" && line.length + 1 + word.length > width) {
      out.push(line);
      line = word;
    } else line = line === "" ? word : `${line} ${word}`;
  }
  if (line !== "") out.push(line);
  return out;
}

// ------------------------------------------------------------------ run

/**
 * When a runner command fails on the cluster, is its file in the pod at all?
 * A checkout ahead of the cluster names files the deployed image does not
 * have yet, and bun's "module not found" does not say that is why.
 */
function explainMissing(form: Form, opts: Options): void {
  const path = targetPath(form);
  if (path === undefined) return;
  if (podProbe(opts, 'if [ -e "$1" ]; then echo present; else echo absent; fi', path) !== "absent") return;
  console.error(
    `wb: ${path} is not in the runner pod, which runs ${runnerImage(opts)}. ` +
      "This checkout is ahead of what the cluster runs; the command reaches the pod with the release that ships it.",
  );
}

/** One `sh -c` in the runner pod, its stdout trimmed; empty when kubectl fails. */
function podProbe(opts: Options, script: string, ...args: string[]): string {
  return Bun.spawnSync(["kubectl", "-n", opts.namespace, "exec", runnerPod(opts), "--", "sh", "-c", script, "sh", ...args], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "ignore",
  })
    .stdout.toString()
    .trim();
}

/** The image the runner Deployment runs, for a message. */
function runnerImage(opts: Options): string {
  const image = Bun.spawnSync(
    ["kubectl", "-n", opts.namespace, "get", runnerPod(opts), "-o", "jsonpath={.spec.template.spec.containers[0].image}"],
    { cwd: REPO_ROOT, stdout: "pipe", stderr: "ignore" },
  )
    .stdout.toString()
    .trim();
  return image === "" ? "an image wb could not read" : image;
}

/**
 * Before a row with `requires` runs in the runner pod: does the pod's copy of
 * its file carry the flag? An older file would ignore it and do something
 * else, so anything but a clear yes refuses, and nothing runs.
 */
function refuseUnlessPodCarries(form: Form, flag: string, opts: Options): string | undefined {
  const path = targetPath(form)!;
  const found = podProbe(opts, 'if grep -qF -e "$1" "$2"; then echo present; else echo absent; fi', flag, path);
  if (found === "present") return undefined;
  if (found === "absent") {
    return (
      `the runner pod's ${path} predates ${flag}; the pod runs ${runnerImage(opts)}. ` +
      "That file would ignore the flag and do something else, so nothing was run; the command works once a release ships the flag."
    );
  }
  return `could not read the runner pod's ${path} to check it has ${flag}, so nothing was run`;
}

async function main(argv: readonly string[]): Promise<number> {
  const parsed = parse(argv, process.env);
  if (parsed.kind === "help") {
    console.log(parsed.group === undefined ? topHelp(parsed.opts) : groupHelp(parsed.group, parsed.opts));
    return 0;
  }
  if (parsed.kind === "error") {
    console.error(`wb: ${parsed.message}\n`);
    console.error(parsed.group === undefined ? topHelp(parsed.opts) : groupHelp(parsed.group, parsed.opts));
    return 2;
  }
  const p = plan(parsed.entry, parsed.opts, parsed.args);
  if ("refused" in p) {
    console.error(`wb: ${p.refused}`);
    return 2;
  }
  const form = parsed.opts.target === "local" ? parsed.entry.local : parsed.entry.cluster;
  if (parsed.entry.requires !== undefined && form?.place === "runner" && parsed.opts.target === "cluster") {
    const refusal = refuseUnlessPodCarries(form, parsed.entry.requires, parsed.opts);
    if (refusal !== undefined) {
      console.error(`wb: ${refusal}`);
      return 2;
    }
  }
  // A relative argv[0] is a repository path; execvp would resolve it against
  // the child's cwd, so do the same here rather than lean on a PATH search.
  const argv0 = p.argv[0]!;
  const child = Bun.spawn([argv0.includes("/") ? resolve(p.cwd, argv0) : argv0, ...p.argv.slice(1)], {
    cwd: p.cwd,
    env: { ...process.env, ...p.env },
    stdio: ["inherit", "inherit", "inherit"],
  });
  // Ctrl-C reaches the child from the terminal, as it would without wb; wb
  // stays to report the exit, so a script's own traps (the pause switch left
  // set, the fleet scaled back) finish first. A signal sent to wb alone is
  // handed on.
  process.on("SIGINT", () => {});
  for (const sig of ["SIGTERM", "SIGHUP"] as const) process.on(sig, () => child.kill(sig));
  const code = await child.exited;
  // Not after a signal: an interrupted command is not a missing one.
  if (code !== 0 && code < 128 && form?.place === "runner" && parsed.opts.target === "cluster") explainMissing(form, parsed.opts);
  return code;
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)));
