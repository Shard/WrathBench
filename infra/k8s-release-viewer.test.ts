/**
 * Bash-level tests for infra/k8s-release-viewer.sh, in the shape
 * k8s-release.test.ts set: the real script, kubectl and build-images.sh
 * replaced by shims that log to one file in call order, no cluster and no
 * registry, and a throwaway git tree whose history is the fleet's commit and
 * what came after it.
 *
 * What is pinned is what would cost live runs if it were wrong: the script
 * never drains, gates, smokes or scales anything; it hands its hook nothing a
 * full-release hook could pin the fleet with; it refuses a range that touches
 * what the fleet shares; and it notices when the fleet's side left its tag.
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tempDirs } from "./temp-dirs";

const tempDir = tempDirs();

const REPO_ROOT = join(import.meta.dir, "..");
const SCRIPT = join(REPO_ROOT, "infra", "k8s-release-viewer.sh");

/**
 * A `kubectl` with a fleet on one tag and a viewer group on another.
 *
 *   FAKE_FLEET_TAG     what the worldserver, runner, fleet and authserver report
 *   FAKE_VIEWER_TAG    what the viewer, publisher and collector report before the pin
 *   FAKE_PINNED_TAG    what they report once the pin landed: once the hook has
 *                      run, or after FAKE_FLIP_AFTER image reads of them
 *   FAKE_WRONG_PIN     once pinned, the worldserver reports the pinned tag too
 *   FAKE_SPLIT_RUNNER  the runner reports this tag from the start (a release in flight)
 *   FAKE_VIEWER_REPO   the viewer's image name (default the runner image's)
 *   FAKE_MISSING       space-separated objects `get -o name` cannot find
 *   FAKE_ROLLOUT_FAIL  `rollout status` exits 1
 */
const KUBECTL_SHIM = `#!/usr/bin/env bash
log() { printf 'kubectl %s\\n' "$1" >> "\${FAKE_LOG}"; }
while [[ $# -gt 0 ]]; do
  case "$1" in -n|--namespace) shift 2 ;; *) break ;; esac
done
raw="$*"
pinned() {
  [[ -f "\${FAKE_LOG}.pinned" ]] && return 0
  [[ -n "\${FAKE_FLIP_AFTER:-}" ]] || return 1
  local n=0
  [[ -f "\${FAKE_LOG}.reads" ]] && n="$(cat "\${FAKE_LOG}.reads")"
  (( n >= FAKE_FLIP_AFTER ))
}
case "\${1:-}" in
  get)
    obj="\${2:-}"
    if [[ "\${raw}" == *"-o name"* ]]; then
      log "get \${obj} -o name"
      for m in \${FAKE_MISSING:-}; do [[ "\${m}" == "\${obj}" ]] && exit 1; done
      printf '%s\\n' "\${obj}"
      exit 0
    fi
    log "get \${obj} image"
    case "\${obj}" in
      *-viewer|*-publisher|*-collector)
        n=0
        [[ -f "\${FAKE_LOG}.reads" ]] && n="$(cat "\${FAKE_LOG}.reads")"
        printf '%s' "$(( n + 1 ))" > "\${FAKE_LOG}.reads"
        tag="\${FAKE_VIEWER_TAG}"
        pinned && tag="\${FAKE_PINNED_TAG}"
        repo="wrathbench-runner"
        [[ "\${obj}" == *-viewer && -n "\${FAKE_VIEWER_REPO:-}" ]] && repo="\${FAKE_VIEWER_REPO}"
        printf 'reg.example/wrathbench/%s:%s' "\${repo}" "\${tag}"
        ;;
      *-worldserver)
        tag="\${FAKE_FLEET_TAG}"
        [[ "\${FAKE_WRONG_PIN:-0}" == "1" ]] && pinned && tag="\${FAKE_PINNED_TAG}"
        printf 'reg.example/wrathbench/wrathbench-worldserver:%s' "\${tag}"
        ;;
      *-runner)
        printf 'reg.example/wrathbench/wrathbench-runner:%s' "\${FAKE_SPLIT_RUNNER:-\${FAKE_FLEET_TAG}}"
        ;;
      *)
        printf 'reg.example/wrathbench/wrathbench-runner:%s' "\${FAKE_FLEET_TAG}"
        ;;
    esac
    exit 0
    ;;
  rollout)
    log "rollout \${2:-} \${3:-}"
    [[ "\${FAKE_ROLLOUT_FAIL:-0}" == "1" ]] && exit 1
    exit 0
    ;;
  wait)
    log "wait \${raw}"
    exit 0
    ;;
esac
log "\${raw}"
exit 0
`;

const BUILD_SHIM = `#!/usr/bin/env bash
printf 'build-images %s\\n' "$*" >> "\${FAKE_LOG}"
exit "\${FAKE_BUILD_RC:-0}"
`;

/** A viewer pin hook that records what it was handed and lands the pin. */
const VIEWER_HOOK = `#!/usr/bin/env bash
printf 'viewer-pin-hook argc=%s viewer=%s fleet=%s tag=%s sha=%s\\n' "$#" "\${WRATHBENCH_VIEWER_TAG:-unset}" "\${WRATHBENCH_FLEET_TAG:-unset}" "\${WRATHBENCH_TAG:-unset}" "\${WRATHBENCH_SHA:-unset}" >> "\${FAKE_LOG}"
touch "\${FAKE_LOG}.pinned"
exit "\${FAKE_HOOK_RC:-0}"
`;

interface Case {
  args?: string[];
  withHook?: boolean;
  hookRc?: number;
  /** Paths the commit after the fleet's touches (beside dashboard/page.ts). */
  touch?: string[];
  /** The fleet runs HEAD itself, so the release puts the viewer back on it. */
  fleetAtHead?: boolean;
  /** The fleet runs a commit on a side branch HEAD does not contain. */
  fleetOffBranch?: boolean;
  /** The viewer group already carries HEAD's tag. */
  alreadyPinned?: boolean;
  flipAfter?: number;
  wrongPin?: boolean;
  splitRunner?: string;
  viewerRepo?: string;
  missing?: string[];
  rolloutFails?: boolean;
  dirty?: boolean;
}

interface Result {
  exitCode: number;
  out: string;
  calls: string[];
  tag: string;
  sha: string;
  fleetTag: string;
}

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" };

function run(c: Case): Result {
  const dir = tempDir("wb-k8s-release-viewer-");
  const bin = join(dir, "bin");
  const tree = join(dir, "tree");
  mkdirSync(bin, { recursive: true });
  mkdirSync(tree, { recursive: true });

  const git = (...a: string[]): string => {
    const r = Bun.spawnSync(["git", "-C", tree, ...a], { env: GIT_ENV });
    if (r.exitCode !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr.toString()}`);
    return r.stdout.toString().trim();
  };
  const commit = (path: string, body: string, msg: string) => {
    mkdirSync(dirname(join(tree, path)), { recursive: true });
    writeFileSync(join(tree, path), body);
    git("add", path);
    git("commit", "-q", "-m", msg);
  };
  git("init", "-q", "-b", "main");
  commit("a.txt", "zero\n", "zero");
  git("tag", "wb-0.9");
  // The fleet's commit: one past the series tag, so its tag is describe output.
  commit("a.txt", "one\n", "the fleet");
  let fleetTag = git("describe", "--tags", "--always");
  if (c.fleetOffBranch === true) {
    git("switch", "-q", "-c", "side");
    commit("side.txt", "side\n", "side");
    fleetTag = git("describe", "--tags", "--always");
    git("switch", "-q", "main");
  }
  if (c.fleetAtHead !== true) {
    commit("dashboard/page.ts", "export {};\n", "a page");
    for (const p of c.touch ?? []) commit(p, "changed\n", `touch ${p}`);
  }
  const sha = git("rev-parse", "HEAD");
  const tag = git("describe", "--tags", "--always");
  if (c.fleetAtHead === true) fleetTag = tag;
  if (c.dirty === true) writeFileSync(join(tree, "a.txt"), "dirty\n");

  const log = join(dir, "calls.log");
  writeFileSync(log, "");
  const write = (name: string, body: string) => {
    const p = join(bin, name);
    writeFileSync(p, body);
    chmodSync(p, 0o755);
    return p;
  };
  write("kubectl", KUBECTL_SHIM);
  const buildImages = write("build-images.sh", BUILD_SHIM);
  const hook = write("viewer-pin-hook.sh", VIEWER_HOOK);
  if (c.alreadyPinned === true) writeFileSync(`${log}.pinned`, "");

  const args = [...(c.args ?? [])];
  if (c.withHook === true) args.push("--viewer-pin-hook", hook);

  const proc = Bun.spawnSync(["bash", SCRIPT, ...args], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      FORCE_COLOR: "3",
      FAKE_LOG: log,
      FAKE_FLEET_TAG: fleetTag,
      FAKE_VIEWER_TAG: fleetTag,
      FAKE_PINNED_TAG: tag,
      ...(c.flipAfter !== undefined ? { FAKE_FLIP_AFTER: String(c.flipAfter) } : {}),
      ...(c.wrongPin === true ? { FAKE_WRONG_PIN: "1" } : {}),
      ...(c.splitRunner !== undefined ? { FAKE_SPLIT_RUNNER: c.splitRunner } : {}),
      ...(c.viewerRepo !== undefined ? { FAKE_VIEWER_REPO: c.viewerRepo } : {}),
      ...(c.missing !== undefined ? { FAKE_MISSING: c.missing.join(" ") } : {}),
      ...(c.rolloutFails === true ? { FAKE_ROLLOUT_FAIL: "1" } : {}),
      ...(c.hookRc !== undefined ? { FAKE_HOOK_RC: String(c.hookRc) } : {}),
      // A full release's variables in the operator's shell must not reach the viewer hook.
      WRATHBENCH_TAG: "full-release-tag",
      WRATHBENCH_SHA: "full-release-sha",
      WRATHBENCH_RELEASE_REPO_ROOT: tree,
      WRATHBENCH_BUILD_IMAGES_CMD: buildImages,
      // No sleep between tag polls: a poll that flips counts reads, not seconds.
      WRATHBENCH_RELEASE_POLL_S: "0",
      WRATHBENCH_RELEASE_PIN_WAIT_S: "4",
      WRATHBENCH_RELEASE_ROLLOUT_WAIT_S: "3",
    },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  expect(existsSync(log)).toBe(true);
  return {
    exitCode: proc.exitCode ?? -1,
    out: `${proc.stdout.toString()}${proc.stderr.toString()}`,
    calls: readFileSync(log, "utf8").split("\n").filter(Boolean),
    tag,
    sha,
    fleetTag,
  };
}

/** Every call that is not a kubectl read: what the release DID. */
const acts = (r: Result) => r.calls.filter((l) => !l.startsWith("kubectl get "));

describe("k8s-release-viewer.sh", () => {
  test("check, build the runner image, pin, wait on the viewer group: no drain, gate, smoke or scale", () => {
    const r = run({ withHook: true });
    expect(r.exitCode, r.out).toBe(0);
    expect(acts(r)).toEqual([
      `build-images --push --only runner --tag ${r.tag} --commit ${r.sha}`,
      expect.stringMatching(/^viewer-pin-hook /),
      "kubectl rollout status deployment/wrathbench-viewer",
      "kubectl rollout status deployment/wrathbench-publisher",
      "kubectl rollout status deployment/wrathbench-collector",
    ]);
    // Nothing that reaches the fleet: no fleet-update, no k8s-deploy, no exec, scale or patch.
    for (const l of r.calls) expect(l).not.toMatch(/fleet-update|k8s-deploy|exec|scale|patch|delete|restart/);
    expect(r.out).toContain(`VIEWER RELEASED ${r.tag}`);
    expect(r.out).toContain(`over the fleet's ${r.fleetTag}`);
    expect(r.out).toContain(`still ${r.fleetTag}`);
    // The hook gets no arguments and only the viewer's variables, never the full release's.
    expect(r.calls.find((l) => l.startsWith("viewer-pin-hook "))).toBe(`viewer-pin-hook argc=0 viewer=${r.tag} fleet=${r.fleetTag} tag=unset sha=unset`);
  });

  test("--pin-hook, the full release's flag, is refused before anything runs", () => {
    const r = run({ args: ["--pin-hook", "/bin/true"] });
    expect(r.exitCode).toBe(2);
    expect(r.out).toContain("--viewer-pin-hook");
    expect(r.calls).toEqual([]);
  });

  test("a range that touches the chart, the config store or the collector's schema is refused, naming the paths", () => {
    for (const p of ["infra/chart/wrathbench/values.yaml", "runner/src/config-store.ts", "runner/src/store-secrets.ts", "collector/schema.sql"]) {
      const r = run({ withHook: true, touch: [p] });
      expect([p, r.exitCode]).toEqual([p, 2]);
      expect(r.out).toContain(`    ${p}`);
      expect(r.out).toContain("bun wb release run");
      expect(acts(r)).toEqual([]);
    }
    // A Dockerfile, the lockfile and other code may ride.
    const ok = run({ withHook: true, touch: ["infra/docker/runner.Dockerfile", "bun.lock", "runner/src/models.ts"] });
    expect(ok.exitCode, ok.out).toBe(0);
  });

  test("a checkout that does not contain the fleet's commit is refused: a viewer older than the fleet is the dangerous direction", () => {
    const r = run({ withHook: true, fleetOffBranch: true });
    expect(r.exitCode).toBe(2);
    expect(r.out).toContain("does not descend from the fleet's");
    expect(acts(r)).toEqual([]);
  });

  test("a pin that moves the fleet's side is detected and fails loudly", () => {
    const r = run({ withHook: true, wrongPin: true });
    expect(r.exitCode).toBe(1);
    expect(r.out).toContain("deployment/wrathbench-worldserver is on");
    expect(r.out).toContain("the pin moved more than image.viewerTag");
    expect(r.out).not.toContain("VIEWER RELEASED");
  });

  test("a fleet that is not on one tag (a release in flight) is refused before anything runs", () => {
    const r = run({ withHook: true, splitRunner: "harness-0.9-99-g9999999" });
    expect(r.exitCode).toBe(2);
    expect(r.out).toContain("the fleet is not on one tag");
    expect(acts(r)).toEqual([]);
  });

  test("a viewer on the slim image is refused: only the runner image is built", () => {
    const r = run({ withHook: true, viewerRepo: "wrathbench-viewer" });
    expect(r.exitCode).toBe(2);
    expect(r.out).toContain("a viewer release builds the runner image only");
    expect(acts(r)).toEqual([]);
  });

  test("--dry-run reads the cluster and runs nothing", () => {
    const r = run({ withHook: true, args: ["--dry-run"] });
    expect(r.exitCode, r.out).toBe(0);
    expect(acts(r)).toEqual([]);
    expect(r.out).toContain(`would build  `);
    expect(r.out).toContain(`--push --only runner --tag ${r.tag} --commit ${r.sha}`);
    expect(r.out).toContain("no drain, no pause switch, no deploy window, no smokes");
    expect(r.out).toContain(`WRATHBENCH_VIEWER_TAG=${r.tag}`);
  });

  test("with no hook it prints the one value to set and waits for it", () => {
    const r = run({ flipAfter: 8 });
    expect(r.exitCode, r.out).toBe(0);
    expect(r.out).toContain(`image.viewerTag = ${r.tag}`);
    expect(r.out).toContain(`image.tag stays ${r.fleetTag}`);
    expect(r.out).toContain("waiting: deployment/wrathbench-viewer is on");
  });

  test("the pin hook is not run twice when the viewer group already carries the tag", () => {
    const r = run({ withHook: true, alreadyPinned: true, args: ["--from", "pin"] });
    expect(r.exitCode, r.out).toBe(0);
    expect(r.calls.some((l) => l.startsWith("viewer-pin-hook"))).toBe(false);
    expect(r.calls.some((l) => l.startsWith("build-images"))).toBe(false);
    expect(r.out).toContain("ALREADY carries");
  });

  test("at the fleet's own commit the build is skipped and the viewer group goes back to the fleet's tag", () => {
    const r = run({ withHook: true, fleetAtHead: true, alreadyPinned: true });
    expect(r.exitCode, r.out).toBe(0);
    expect(r.calls.some((l) => l.startsWith("build-images"))).toBe(false);
    expect(r.out).toContain("its images exist and are never pushed over");
  });

  test("a failed hook, a dirty tree and a failed rollout each stop it, and none touches the fleet", () => {
    const hook = run({ withHook: true, hookRc: 3 });
    expect(hook.exitCode).toBe(1);
    expect(hook.out).toContain("the fleet was never touched");
    const dirty = run({ withHook: true, dirty: true });
    expect(dirty.exitCode).toBe(1);
    expect(dirty.out).toContain("uncommitted changes");
    expect(dirty.calls.some((l) => l.startsWith("build-images"))).toBe(false);
    const rollout = run({ withHook: true, rolloutFails: true });
    expect(rollout.exitCode).toBe(1);
    expect(rollout.out).toContain("did not finish rolling out");
    for (const r of [hook, dirty, rollout]) for (const l of r.calls) expect(l).not.toMatch(/fleet-update|k8s-deploy|scale/);
  });

  test("a viewer group without a collector (ClickHouse off) skips it", () => {
    const r = run({ withHook: true, missing: ["deployment/wrathbench-collector"] });
    expect(r.exitCode, r.out).toBe(0);
    expect(r.out).toContain("deployment/wrathbench-collector is not installed — skipped");
  });
});
