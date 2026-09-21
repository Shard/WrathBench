/**
 * Bash-level tests for infra/k8s-release.sh, in the shape
 * infra/fleet-update.test.ts established: the real script, every command it
 * drives replaced by a shim, no cluster and no registry.
 *
 * Four shims and one shared log. `kubectl`, `build-images.sh`,
 * `fleet-update.sh` and `k8s-deploy.sh` all append `"<name> <argv>"` to the
 * same file in the order they were called, which is the only way an assertion
 * about PHASE ORDER means anything: the release script's whole job is that the
 * middle of a release happens in one sequence instead of in a hand-typed chain
 * joined with `;` (2026-09-16).
 *
 * The properties worth pinning are the ones that cost a bad deploy when they
 * are wrong: the deploy window must never open before the cluster is observed
 * to carry the tree's tag, a failing pin hook must stop the release, the tag
 * poll must be a real wait rather than a single look, `--dry-run` must run no
 * command at all, and a dirty tree must not become a pin.
 *
 * FORCE_COLOR=3 throughout, for the same reason the sibling suites do it.
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const SCRIPT = join(REPO_ROOT, "infra", "k8s-release.sh");

/**
 * A `kubectl` with no cluster behind it.
 *
 *   FAKE_TAG            the tag every object reports
 *   FAKE_TAG_BEFORE     the tag reported for the first FAKE_TAG_FLIP_AFTER
 *                       image reads (the pin has not landed yet)
 *   FAKE_TAG_FLIP_AFTER how many image reads happen before the flip
 *   FAKE_MISSING        space-separated objects `get -o name` cannot find
 *   FAKE_ROLLOUT_FAIL   `rollout status` exits 1
 *   FAKE_WAIT_FAIL      `kubectl wait` exits 1
 *   FAKE_REPLICAS       what the fleet Deployment reports
 */
const KUBECTL_SHIM = `#!/usr/bin/env bash
log() { printf 'kubectl %s\\n' "$1" >> "\${FAKE_LOG}"; }
while [[ $# -gt 0 ]]; do
  case "$1" in -n|--namespace) shift 2 ;; *) break ;; esac
done
raw="$*"
case "\${1:-}" in
  get)
    obj="\${2:-}"
    if [[ "\${raw}" == *"-o name"* ]]; then
      log "get \${obj} -o name"
      for m in \${FAKE_MISSING:-}; do [[ "\${m}" == "\${obj}" ]] && exit 1; done
      printf '%s\\n' "\${obj}"
      exit 0
    fi
    if [[ "\${raw}" == *"replicas"* ]]; then
      log "get \${obj} replicas"
      printf '%s' "\${FAKE_REPLICAS:-0}"
      exit 0
    fi
    log "get \${obj} image"
    tag="\${FAKE_TAG}"
    if [[ -n "\${FAKE_TAG_BEFORE:-}" ]]; then
      n=0
      [[ -f "\${FAKE_LOG}.imagecount" ]] && n="$(cat "\${FAKE_LOG}.imagecount")"
      n=$(( n + 1 ))
      printf '%s' "\${n}" > "\${FAKE_LOG}.imagecount"
      (( n > \${FAKE_TAG_FLIP_AFTER:-3} )) || tag="\${FAKE_TAG_BEFORE}"
    fi
    case "\${obj}" in
      *worldserver) printf 'reg.example/library/wrathbench-worldserver:%s' "\${tag}" ;;
      *) printf 'reg.example/library/wrathbench-runner:%s' "\${tag}" ;;
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
    [[ "\${FAKE_WAIT_FAIL:-0}" == "1" ]] && exit 1
    exit 0
    ;;
esac
log "\${raw}"
exit 0
`;

/** build-images.sh / fleet-update.sh / k8s-deploy.sh: log the argv, obey an rc. */
const siblingShim = (name: string, rcVar: string) => `#!/usr/bin/env bash
printf '%s %s\\n' "${name}" "$*" >> "\${FAKE_LOG}"
exit "\${${rcVar}:-0}"
`;

/** A pin hook that records its argv AND the two environment variables. */
const PIN_HOOK = `#!/usr/bin/env bash
printf 'pin-hook %s | env %s %s\\n' "$*" "\${WRATHBENCH_TAG:-unset}" "\${WRATHBENCH_SHA:-unset}" >> "\${FAKE_LOG}"
exit "\${FAKE_HOOK_RC:-0}"
`;

interface Case {
  args?: string[];
  /** The tag the fake cluster reports on every object. */
  clusterTag?: string;
  /** The tag reported before the pin "lands", and after how many image reads. */
  clusterTagBefore?: string;
  flipAfter?: number;
  /** Objects `kubectl get -o name` cannot find. */
  missing?: string[];
  rolloutFails?: boolean;
  waitFails?: boolean;
  replicas?: number;
  /** Use `--pin-hook` pointed at the recording hook. */
  withHook?: boolean;
  hookRc?: number;
  buildRc?: number;
  fleetUpdateRc?: number;
  deployRc?: number;
  /** Leave an uncommitted change in the throwaway tree. */
  dirty?: boolean;
  env?: Record<string, string>;
}

interface Result {
  exitCode: number;
  out: string;
  /** Every shimmed command, in the order it ran. */
  calls: string[];
  tag: string;
  sha: string;
}

const TAG = "wb-test-0.9-1-gdeadbee";

function run(c: Case): Result {
  const dir = mkdtempSync(join(tmpdir(), "wb-k8s-release-"));
  const bin = join(dir, "bin");
  const tree = join(dir, "tree");
  Bun.spawnSync(["mkdir", "-p", bin, tree]);

  // A throwaway git tree, so the dirty-tree refusal is exercised without this
  // repository's own state deciding whether the test passes.
  const git = (...a: string[]) =>
    Bun.spawnSync(["git", "-C", tree, ...a], {
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" },
    });
  git("init", "-q");
  writeFileSync(join(tree, "a.txt"), "one\n");
  git("add", "a.txt");
  git("commit", "-q", "-m", "one");
  if (c.dirty === true) writeFileSync(join(tree, "a.txt"), "two\n");
  const sha = new TextDecoder().decode(Bun.spawnSync(["git", "-C", tree, "rev-parse", "HEAD"]).stdout).trim();

  const log = join(dir, "calls.log");
  writeFileSync(log, "");
  const write = (name: string, body: string) => {
    const p = join(bin, name);
    writeFileSync(p, body);
    chmodSync(p, 0o755);
    return p;
  };
  write("kubectl", KUBECTL_SHIM);
  const buildImages = write("build-images.sh", siblingShim("build-images", "FAKE_BUILD_RC"));
  const fleetUpdate = write("fleet-update.sh", siblingShim("fleet-update", "FAKE_FLEET_RC"));
  const k8sDeploy = write("k8s-deploy.sh", siblingShim("k8s-deploy", "FAKE_DEPLOY_RC"));
  const hook = write("pin-hook.sh", PIN_HOOK);

  const args = ["--tag", TAG, ...(c.args ?? [])];
  if (c.withHook === true) args.push("--pin-hook", hook);

  const proc = Bun.spawnSync(["bash", SCRIPT, ...args], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      FORCE_COLOR: "3",
      FAKE_LOG: log,
      FAKE_TAG: c.clusterTag ?? TAG,
      ...(c.clusterTagBefore !== undefined ? { FAKE_TAG_BEFORE: c.clusterTagBefore, FAKE_TAG_FLIP_AFTER: String(c.flipAfter ?? 3) } : {}),
      ...(c.missing !== undefined ? { FAKE_MISSING: c.missing.join(" ") } : {}),
      ...(c.rolloutFails === true ? { FAKE_ROLLOUT_FAIL: "1" } : {}),
      ...(c.waitFails === true ? { FAKE_WAIT_FAIL: "1" } : {}),
      FAKE_REPLICAS: String(c.replicas ?? 0),
      ...(c.hookRc !== undefined ? { FAKE_HOOK_RC: String(c.hookRc) } : {}),
      ...(c.buildRc !== undefined ? { FAKE_BUILD_RC: String(c.buildRc) } : {}),
      ...(c.fleetUpdateRc !== undefined ? { FAKE_FLEET_RC: String(c.fleetUpdateRc) } : {}),
      ...(c.deployRc !== undefined ? { FAKE_DEPLOY_RC: String(c.deployRc) } : {}),
      WRATHBENCH_RELEASE_REPO_ROOT: tree,
      WRATHBENCH_BUILD_IMAGES_CMD: buildImages,
      WRATHBENCH_FLEET_UPDATE_CMD: fleetUpdate,
      WRATHBENCH_K8S_DEPLOY_CMD: k8sDeploy,
      WRATHBENCH_RELEASE_POLL_S: "1",
      WRATHBENCH_RELEASE_PIN_WAIT_S: "4",
      WRATHBENCH_RELEASE_ROLLOUT_WAIT_S: "3",
      ...c.env,
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
    tag: TAG,
    sha,
  };
}

/** Only the phase-level commands, in order: the shape of a release. */
const phases = (r: Result) =>
  r.calls
    .filter((l) => !l.startsWith("kubectl "))
    .map((l) => l.split(" ").slice(0, 2).join(" "));

describe("k8s-release.sh", () => {
  test("runs the five phases in order: build, drain, pin, deploy, resume", () => {
    const r = run({});
    expect(r.exitCode).toBe(0);
    expect(r.out).not.toContain("arithmetic syntax error");
    expect(phases(r)).toEqual(["build-images --push", "fleet-update drain", "k8s-deploy --namespace", "fleet-update resume"]);
    expect(r.calls.some((l) => l.startsWith(`build-images --push --tag ${TAG}`))).toBe(true);
    expect(r.out).toContain(`RELEASED ${TAG}`);
  });

  test("the deploy window is handed the tag, so it refuses on its own if the pin slips", () => {
    const r = run({});
    const deploy = r.calls.find((l) => l.startsWith("k8s-deploy "));
    expect(deploy).toContain(`--expect-tag ${TAG}`);
    expect(deploy).toContain("--namespace wrathbench");
    expect(deploy).toContain("--release wrathbench");
  });

  test("--from restarts at a phase and skips everything before it", () => {
    const r = run({ args: ["--from", "pin"] });
    expect(r.exitCode).toBe(0);
    expect(phases(r)).toEqual(["k8s-deploy --namespace", "fleet-update resume"]);
    expect(r.out).toContain("--from pin");
    expect(r.out).toContain("build drain skipped");
  });

  test("--from deploy runs only the window and the resume", () => {
    const r = run({ args: ["--from", "deploy"] });
    expect(r.exitCode).toBe(0);
    expect(phases(r)).toEqual(["k8s-deploy --namespace", "fleet-update resume"]);
    // The pin phase is skipped entirely: no tag poll, no rollout status.
    expect(r.calls.filter((l) => l.startsWith("kubectl rollout"))).toEqual([]);
  });

  test("an unknown --from is refused with the sibling scripts' exit 2", () => {
    const r = run({ args: ["--from", "smoke"] });
    expect(r.exitCode).toBe(2);
    expect(r.out).toContain("--from takes one of");
    expect(phases(r)).toEqual([]);
  });

  test("the pin hook gets the tag and the sha as argv AND in the environment", () => {
    const r = run({ withHook: true, clusterTagBefore: "old-tag", flipAfter: 1 });
    expect(r.exitCode).toBe(0);
    const call = r.calls.find((l) => l.startsWith("pin-hook "));
    expect(call).toBe(`pin-hook ${TAG} ${r.sha} | env ${TAG} ${r.sha}`);
  });

  test("a hook that fails stops the release before the deploy window opens", () => {
    const r = run({ withHook: true, hookRc: 1, clusterTagBefore: "old-tag" });
    expect(r.exitCode).toBe(1);
    expect(r.out).toContain("pin hook exited non-zero");
    expect(r.out).toContain("--from pin");
    expect(phases(r).filter((p) => p.startsWith("k8s-deploy"))).toEqual([]);
  });

  test("a cluster already on the tag skips the hook rather than placing the pin twice", () => {
    // What makes `--from pin` re-runnable: a second run must not re-trigger
    // whatever the operator's hook does (a PR, a commit, a helm upgrade).
    const r = run({ withHook: true });
    expect(r.exitCode).toBe(0);
    expect(r.calls.filter((l) => l.startsWith("pin-hook"))).toEqual([]);
    expect(r.out).toContain("ALREADY carries");
    expect(phases(r).filter((p) => p.startsWith("k8s-deploy"))).toHaveLength(1);
  });

  test("with no hook it prints the tag, the commit and where the chart expects them", () => {
    const r = run({ clusterTagBefore: "old-tag", flipAfter: 1 });
    expect(r.exitCode).toBe(0);
    expect(r.out).toContain(`image.tag = ${TAG}`);
    expect(r.out).toContain(`commit    = ${r.sha}`);
    expect(r.out).toContain("image.tag");
    expect(r.out).toContain("--pin-hook");
  });

  test("the tag poll is a wait, not a look: it keeps reading until the cluster carries the tag", () => {
    const r = run({ clusterTagBefore: "harness-0.5-625-gold", flipAfter: 4 });
    expect(r.exitCode).toBe(0);
    expect(r.out).toContain("waiting: deployment/wrathbench-worldserver is on harness-0.5-625-gold");
    expect(r.out).toContain(`the cluster carries ${TAG}`);
    // And the window only opened after that.
    const deployAt = r.calls.findIndex((l) => l.startsWith("k8s-deploy "));
    const rolloutAt = r.calls.findIndex((l) => l.startsWith("kubectl rollout status"));
    expect(rolloutAt).toBeGreaterThan(-1);
    expect(deployAt).toBeGreaterThan(rolloutAt);
  });

  test("a pin that never lands times out and never opens the deploy window", () => {
    const r = run({ clusterTag: "harness-0.5-625-gold" });
    expect(r.exitCode).toBe(1);
    expect(r.out).toContain("still does not carry");
    expect(r.out).toContain("--from pin");
    expect(phases(r)).toEqual(["build-images --push", "fleet-update drain"]);
  });

  test("the rollout sweep skips objects that are not installed, and never waits on the fleet", () => {
    const r = run({ missing: ["deployment/wrathbench-publisher", "statefulset/wrathbench-clickhouse"] });
    expect(r.exitCode).toBe(0);
    const rollouts = r.calls.filter((l) => l.startsWith("kubectl rollout status"));
    expect(rollouts.some((l) => l.includes("wrathbench-worldserver"))).toBe(true);
    expect(rollouts.some((l) => l.includes("wrathbench-viewer"))).toBe(true);
    expect(rollouts.some((l) => l.includes("wrathbench-publisher"))).toBe(false);
    expect(rollouts.some((l) => l.includes("clickhouse"))).toBe(false);
    // The window holds the fleet at 0, and a Helm upgrade may have reset it to
    // 1 under the held switch: either way its rollout says nothing.
    expect(rollouts.some((l) => l.includes("wrathbench-fleet"))).toBe(false);
    expect(r.out).toContain("not installed — skipped");
  });

  test("a rollout that does not complete stops the release", () => {
    const r = run({ rolloutFails: true });
    expect(r.exitCode).toBe(1);
    expect(r.out).toContain("did not finish rolling out");
    expect(phases(r).filter((p) => p.startsWith("k8s-deploy"))).toEqual([]);
  });

  test("--helmrelease is an extra wait AFTER the tag poll, never instead of it", () => {
    // A HelmRelease is still Ready on the PREVIOUS revision, so waiting on it
    // alone returns instantly and hands the window the old image — the
    // 2026-09-16 mistake in a different costume.
    const r = run({ args: ["--helmrelease", "some-ns/wrathbench"], clusterTagBefore: "old-tag", flipAfter: 4 });
    expect(r.exitCode).toBe(0);
    const waitAt = r.calls.findIndex((l) => l.startsWith("kubectl wait"));
    const firstImage = r.calls.findIndex((l) => l.includes("image"));
    const rolloutAt = r.calls.findIndex((l) => l.startsWith("kubectl rollout status"));
    expect(waitAt).toBeGreaterThan(firstImage);
    expect(waitAt).toBeGreaterThan(rolloutAt);
    expect(r.calls[waitAt]).toContain("helmrelease/wrathbench");
  });

  test("no --helmrelease means no wait at all — nothing here assumes Flux", () => {
    const r = run({});
    expect(r.calls.filter((l) => l.startsWith("kubectl wait"))).toEqual([]);
    expect(r.out).toContain("no --helmrelease given");
  });

  test("--helmrelease must name a namespace and a name", () => {
    const r = run({ args: ["--helmrelease", "wrathbench"] });
    expect(r.exitCode).toBe(2);
    expect(r.out).toContain("<namespace>/<name>");
  });

  test("a HelmRelease that never goes Ready stops the release", () => {
    const r = run({ args: ["--helmrelease", "some-ns/wrathbench"], waitFails: true });
    expect(r.exitCode).toBe(1);
    expect(r.out).toContain("not Ready");
    expect(phases(r).filter((p) => p.startsWith("k8s-deploy"))).toEqual([]);
  });

  test("build refuses a dirty tree, and nothing after it runs", () => {
    const r = run({ dirty: true });
    expect(r.exitCode).toBe(1);
    expect(r.out).toContain("uncommitted changes");
    expect(phases(r)).toEqual([]);
  });

  test("a dirty tree is only the build phase's business: --from drain still runs", () => {
    const r = run({ dirty: true, args: ["--from", "drain"] });
    expect(r.exitCode).toBe(0);
    expect(phases(r)).toEqual(["fleet-update drain", "k8s-deploy --namespace", "fleet-update resume"]);
  });

  test("a build that fails stops the release before the fleet is drained", () => {
    const r = run({ buildRc: 1 });
    expect(r.exitCode).not.toBe(0);
    expect(phases(r)).toEqual(["build-images --push"]);
  });

  test("a failed deploy window does not fall through to resume", () => {
    // k8s-deploy.sh leaves the fleet UP but gated and the switch where the
    // drain left it; clearing it here would undo that on purpose.
    const r = run({ deployRc: 1 });
    expect(r.exitCode).not.toBe(0);
    expect(phases(r).filter((p) => p === "fleet-update resume")).toEqual([]);
  });

  test("--dry-run prints the plan in order and runs no command at all", () => {
    const r = run({ args: ["--dry-run"], withHook: true, clusterTag: "harness-0.5-625-gold" });
    expect(r.exitCode).toBe(0);
    expect(phases(r)).toEqual([]);
    expect(r.calls.filter((l) => l.startsWith("kubectl rollout"))).toEqual([]);
    expect(r.calls.filter((l) => l.startsWith("kubectl wait"))).toEqual([]);
    // Reads are fine — a plan with made-up values is worth nothing.
    expect(r.calls.some((l) => l.startsWith("kubectl get"))).toBe(true);
    const plan = r.out.split("\n").filter((l) => l.includes("would "));
    expect(plan.map((l) => l.replace(/^.*would /, "").split(" ")[0])).toEqual(["build", "drain", "pin", "wait", "deploy", "resume"]);
    expect(r.out).toContain(`(not ${TAG})`);
  });

  test("--dry-run --from pin plans only the phases it would run", () => {
    const r = run({ args: ["--dry-run", "--from", "pin"] });
    expect(r.exitCode).toBe(0);
    const plan = r.out.split("\n").filter((l) => l.includes("would "));
    expect(plan.map((l) => l.replace(/^.*would /, "").split(" ")[0])).toEqual(["pin", "wait", "deploy", "resume"]);
  });

  test("--namespace and --release reach every command", () => {
    const r = run({ args: ["--namespace", "wb-test", "--release", "wb"] });
    expect(r.exitCode).toBe(0);
    expect(r.calls.some((l) => l === "fleet-update drain --namespace wb-test --release wb")).toBe(true);
    expect(r.calls.some((l) => l.startsWith("k8s-deploy --namespace wb-test --release wb"))).toBe(true);
    expect(r.calls.some((l) => l.includes("deployment/wb-worldserver"))).toBe(true);
    expect(r.out).toContain("namespace   wb-test (release wb)");
  });

  test("--registry is passed to the build and nothing else", () => {
    const r = run({ args: ["--registry", "reg.example/library"] });
    expect(r.exitCode).toBe(0);
    expect(r.calls.find((l) => l.startsWith("build-images"))).toContain("--registry reg.example/library");
  });

  test("--no-smoke reaches the deploy window", () => {
    const r = run({ args: ["--no-smoke"] });
    expect(r.calls.find((l) => l.startsWith("k8s-deploy "))).toContain("--no-smoke");
  });

  test("--help prints the header and no shell", () => {
    // `sed -n '2,Np'` over the header is easy to get one line wrong, and
    // nothing else in this suite runs that path.
    const r = run({ args: ["--help"] });
    expect(r.exitCode).toBe(0);
    expect(r.out).toContain("--pin-hook");
    expect(r.out).not.toContain("set -Eeuo");
    expect(r.out).not.toContain("SCRIPT_DIR=");
  });

  test("the runner Deployment is a pin witness: the smokes run from it", () => {
    // `rollout status` on a Deployment whose spec never changed reports rolled
    // out instantly, so it cannot tell a stale runner from a fresh one — and a
    // stale runner produces "verified by N smokes" from the OLD harness.
    const r = run({});
    expect(r.out).toContain(`wrathbench-worldserver=${TAG} wrathbench-runner=${TAG} wrathbench-viewer=${TAG}`);
  });

  // The operator's cluster name is deliberately not in this list: naming it here
  // would be the leak the test exists to prevent.
  const FORBIDDEN = ["flux-system", "gh pr", "harbor."];

  test("the script carries no cluster-specific glue", () => {
    // The operator's rule: one cluster's repo paths, its Flux objects and its
    // PR flow live there, not here.
    const src = readFileSync(SCRIPT, "utf8");
    for (const forbidden of FORBIDDEN) {
      expect(src.toLowerCase().includes(forbidden)).toBe(false);
    }
  });

  test("the chart carries no cluster-specific glue either", () => {
    // Same rule, and the chart is where it slips in first: a registry host, a
    // ClusterIssuer name or a node name from one cluster reads as a default.
    // Chart.yaml's `home:` URL is a project link, not cluster glue, and trips
    // none of these strings.
    const dir = join(import.meta.dir, "chart", "wrathbench");
    const files = [...new Bun.Glob("**/*").scanSync({ cwd: dir })].sort();
    expect(files.length).toBeGreaterThan(5);
    for (const rel of files) {
      const src = readFileSync(join(dir, rel), "utf8").toLowerCase();
      for (const forbidden of FORBIDDEN) {
        expect({ file: rel, forbidden, hit: src.includes(forbidden) }).toEqual({ file: rel, forbidden, hit: false });
      }
    }
  });
});

/**
 * The chart's eviction guards (docs/RUNBOOK.md, "Node disk pressure").
 *
 * These are properties of the whole chart, not of one template, and the way
 * they break is by omission: a workload added later gets cpu and memory
 * because those are obvious and no ephemeral-storage request, no sizeLimit and
 * no priority guard because those are not. Each test below is therefore
 * written against EVERY pod spec and EVERY volume in the chart rather than
 * against a list of the ones that exist today, so the new workload fails it.
 *
 * Static, over the template source: the suite has to be green from a bare
 * clone, which cannot assume a `helm` binary.
 */
describe("chart eviction guards", () => {
  const CHART = join(import.meta.dir, "chart", "wrathbench");
  const templates = [...new Bun.Glob("templates/*.yaml").scanSync({ cwd: CHART })].sort();
  const valuesFiles = ["values.yaml", "values.example.yaml"];
  const read = (rel: string): string => readFileSync(join(CHART, rel), "utf8");

  test("every pod spec carries the priority-class guard", () => {
    // `nodeSelector: {{ toYaml .Values.nodeSelector ... }}` is one line per pod
    // spec in this chart, so it counts them; the guard has to appear as often.
    let specs = 0;
    let guards = 0;
    for (const rel of templates) {
      const src = read(rel);
      specs += [...src.matchAll(/^\s*nodeSelector: \{\{ toYaml \.Values\.nodeSelector/gm)].length;
      guards += [...src.matchAll(/^\s*priorityClassName: \{\{ \. \}\}$/gm)].length;
    }
    expect(specs).toBeGreaterThan(5);
    expect(guards).toBe(specs);
  });

  test("the priority class is values-gated and the chart creates none", () => {
    // Empty must mean ABSENT, not `priorityClassName: ""` — an empty string is
    // not a valid class name and the API server rejects the pod. And priority
    // is compared across every workload on a cluster, so the object that
    // defines the number is the cluster's, never this chart's.
    for (const rel of templates) {
      const src = read(rel);
      for (const m of src.matchAll(/^[^\n]*priorityClassName:[^\n]*$/gm)) {
        expect({ file: rel, line: m[0].trim() }).toEqual({ file: rel, line: "priorityClassName: {{ . }}" });
      }
      for (const m of src.matchAll(/^[^\n]*\.Values\.priorityClassName[^\n]*$/gm)) {
        expect({ file: rel, line: m[0].trim() }).toEqual({ file: rel, line: "{{- with .Values.priorityClassName }}" });
      }
      expect({ file: rel, hit: /kind: PriorityClass/.test(src) }).toEqual({ file: rel, hit: false });
    }
    expect(read("values.yaml")).toContain('priorityClassName: ""');
  });

  test("every emptyDir is bounded", () => {
    // An emptyDir with no ceiling is node disk with a friendly name, and the
    // pod that fills a node is the one evicted for it.
    let seen = 0;
    for (const rel of templates) {
      const lines = read(rel).split("\n");
      for (const [i, line] of lines.entries()) {
        if (!/^\s*emptyDir:\s*$/.test(line) && !/^\s*emptyDir: \{\}/.test(line)) continue;
        seen += 1;
        expect({ file: rel, line: i + 1, bounded: /^\s*sizeLimit: /.test(lines[i + 1] ?? "") }).toEqual({
          file: rel,
          line: i + 1,
          bounded: true,
        });
      }
    }
    expect(seen).toBeGreaterThan(3);
  });

  test("every container requests ephemeral-storage", () => {
    // The kubelet ranks eviction candidates by usage OVER REQUEST first, so a
    // container with no request is in the first group to go whatever it is
    // using. Block form in the values files, flow form inline in a template.
    let blocks = 0;
    for (const rel of [...valuesFiles, ...templates]) {
      const lines = read(rel).split("\n");
      for (const [i, line] of lines.entries()) {
        const flow = /^\s*requests: \{/.exec(line);
        if (flow) {
          blocks += 1;
          expect({ file: rel, line: i + 1, requested: line.includes("ephemeral-storage:") }).toEqual({
            file: rel,
            line: i + 1,
            requested: true,
          });
          continue;
        }
        const block = /^(\s*)requests:\s*$/.exec(line);
        if (!block) continue;
        const body: string[] = [];
        for (let j = i + 1; j < lines.length; j += 1) {
          const next = lines[j] ?? "";
          if (next.trim() !== "" && !next.startsWith(`${block[1]} `)) break;
          body.push(next);
        }
        // A volume claim's `requests: { storage: … }` is a different resource
        // block on a different object; it is sized by storage.* in values.yaml.
        if (body.some((l) => /^\s*storage:/.test(l))) continue;
        blocks += 1;
        expect({ file: rel, line: i + 1, requested: body.some((l) => l.includes("ephemeral-storage:")) }).toEqual({
          file: rel,
          line: i + 1,
          requested: true,
        });
      }
    }
    expect(blocks).toBeGreaterThan(10);
  });
});
