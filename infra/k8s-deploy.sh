#!/usr/bin/env bash
#
# The day-2 deploy window on Kubernetes. The compose equivalent is
# infra/deploy-worldserver.sh, and this is deliberately the same shape:
#
#   draining    scale the fleet Deployment to 0. SIGTERM reaches the
#               supervisor, every live run PAUSES and is resumed when it comes
#               back. Then wait for the supervisor's own state file to say every
#               job has exited — never a pid probe, never a guess — AND for the
#               fleet POD to be gone, because the supervisor's own preflight
#               smoke is not a job and holds a smoke account that the gate
#               smokes need (2026-09-17).
#   waiting     wait for the worldserver rollout and for the module to answer
#               /health ready WITH the bearer.
#   verifying   run the gate smokes (preflight.smokes) and then the deploy-only
#               full arc (preflight.deploySmokes) through
#               `kubectl exec deploy/<release>-runner`. The fleet is down, so
#               nothing else is on the smoke accounts.
#   resuming    scale the fleet back to 1. The supervisor re-gates on the new
#               identity and resumes every paused run before it fills the pool.
#
# WHAT THIS SCRIPT DOES NOT DO: change the image tag. Flux owns that. The
# deploy is "the cluster repo's HelmRelease now names tag X"; this script is the
# window around the rollout Flux performs. Rollback is likewise a revert of that
# tag in the cluster repo, not anything here — which is why there is no :prev
# tagging, no swap and no automatic roll-back path. If the smokes fail, this
# script says so, leaves the fleet UP (its own gate blocks spawning until
# something passes), and exits 1; the operator reverts the tag.
#
# Whatever happens after the fleet is scaled to 0, the EXIT trap scales it back.
# A deploy must never leave the fleet stopped: that is the invariant an operator
# relies on instead of watching the window.
#
# THE PIN CHECK. Before anything is drained or smoked, the tag the cluster
# actually runs (the worldserver Deployment's image, or the module's /health
# `build` when that does not read back) is compared to `git describe` of this
# tree, and a mismatch REFUSES. On 2026-09-16 this script ran against a pin that
# had not landed: it smoked the old release, called it verified and resumed the
# fleet on it. `--expect-tag` names a different tag to require;
# `--allow-tag-mismatch` is the deliberate override and says so in the log.
#
#   ./infra/k8s-deploy.sh                 # drain, wait, smoke, resume
#   ./infra/k8s-deploy.sh --dry-run       # resolved values only; change nothing
#   ./infra/k8s-deploy.sh --no-smoke      # window WITHOUT verification (honest,
#                                         # and it says so)
#   ./infra/k8s-deploy.sh --expect-tag harness-0.5-627-gcf6dcc3
#   ./infra/k8s-deploy.sh --allow-tag-mismatch
#   ./infra/k8s-deploy.sh --namespace wrathbench --release wrathbench

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
NAMESPACE="${WRATHBENCH_K8S_NAMESPACE:-wrathbench}"
RELEASE="${WRATHBENCH_K8S_RELEASE:-wrathbench}"
RUN_SMOKE=1
DRY_RUN=0
# The tag this tree is. `git describe --tags --always`, exactly what
# build-images.sh stamps into the images and the chart's image.tag.
TREE_TAG="$(git -C "${REPO_ROOT}" describe --tags --always 2>/dev/null || true)"
EXPECT_TAG="${WRATHBENCH_EXPECT_TAG:-}"
ALLOW_TAG_MISMATCH=0
# The pause switch `fleet-update.sh drain` leaves set, as the PODS see it. Same
# file, same meaning; overridable only so the tests can point a stubbed kubectl
# at a fixture directory.
PAUSE_JSON="${WRATHBENCH_FLEET_RUNS_DIR:-/wrathbench/data/runs}/fleet-pause.json"
HEALTH_WAIT_S="${WRATHBENCH_DEPLOY_HEALTH_WAIT_S:-900}"
DRAIN_WAIT_S="${WRATHBENCH_DEPLOY_DRAIN_WAIT_S:-300}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --namespace|-n) NAMESPACE="$2"; shift 2 ;;
    --release) RELEASE="$2"; shift 2 ;;
    --no-smoke) RUN_SMOKE=0; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --expect-tag) EXPECT_TAG="$2"; shift 2 ;;
    --allow-tag-mismatch) ALLOW_TAG_MISMATCH=1; shift ;;
    -h|--help) sed -n '2,48p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "k8s-deploy: unknown flag $1" >&2; exit 2 ;;
  esac
done

FLEET_DEPLOY="deployment/${RELEASE}-fleet"
RUNNER_DEPLOY="deployment/${RELEASE}-runner"
WORLD_DEPLOY="deployment/${RELEASE}-worldserver"
KUBECTL=(kubectl -n "${NAMESPACE}")

say() { echo "[$(date +%H:%M:%S)] k8s-deploy: $*"; }
die() { echo "[$(date +%H:%M:%S)] k8s-deploy: $*" >&2; exit 1; }
hhmm() { date +%H:%M; }
require_num() {
  local name="$1" value="$2"
  [[ "${value}" =~ ^[0-9]+$ ]] || die "${name} is not a non-negative integer: $(printf %q "${value}")"
}

command -v kubectl >/dev/null 2>&1 || die "kubectl is not on PATH"
command -v bun >/dev/null 2>&1 || die "bun is not on PATH (this script parses the preflight block with it)"

readonly BUN_PLAIN_ENV=(env NO_COLOR=1 FORCE_COLOR=0 TERM=dumb)
strip_ansi() { sed -e 's/\x1b\[[0-9;]*[A-Za-z]//g'; }

# ------------------------------------------------------------------ 0. config
# Identical parse to deploy-worldserver.sh: the config store's `preflight`
# block is the one place the smokes and their accounts are configured, on
# compose and on Kubernetes. The store is on the data PVC, so it is read the
# way the supervisor reads it — `config-store.ts get preflight`, through the
# runner pod (the same pod fleet-state.json is read through). An empty or
# unreadable store fails the window here, loudly, rather than reading as "no
# smokes configured" further down.
PREFLIGHT_JSON="$("${KUBECTL[@]}" exec -i "${RUNNER_DEPLOY}" -- env NO_COLOR=1 FORCE_COLOR=0 bun runner/src/config-store.ts get preflight 2>/dev/null | strip_ansi || true)"
[[ -n "${PREFLIGHT_JSON}" ]] || die "could not read \`preflight\` from the config store through ${RUNNER_DEPLOY} — is the runner pod up, and the store seeded? (bun runner/src/config-store.ts seed infra/fleet.example.json, then edit it on /config)"
PREFLIGHT_ACCOUNT=""
PREFLIGHT_TIMEOUT_S=""
DEPLOY_TIMEOUT_S=""
SMOKES=(); SMOKE_ACCOUNTS=(); DEPLOY_SMOKES=(); DEPLOY_SMOKE_ACCOUNTS=()
while IFS=$'\t' read -r key value account; do
  case "${key}" in
    account) PREFLIGHT_ACCOUNT="${value}" ;;
    timeout) PREFLIGHT_TIMEOUT_S="${value}" ;;
    deploytimeout) DEPLOY_TIMEOUT_S="${value}" ;;
    smoke) SMOKES+=("${value}"); SMOKE_ACCOUNTS+=("${account}") ;;
    deploysmoke) DEPLOY_SMOKES+=("${value}"); DEPLOY_SMOKE_ACCOUNTS+=("${account}") ;;
  esac
done < <(
  printf '%s' "${PREFLIGHT_JSON}" | "${BUN_PLAIN_ENV[@]}" bun -e '
    const pf = JSON.parse(await Bun.stdin.text());
    const account = pf.account ?? "SMOKE";
    const entry = (kind) => (s) =>
      typeof s === "string" ? `${kind}\t${s}\t${account}` : `${kind}\t${s.script}\t${s.account ?? account}`;
    process.stdout.write([
      `account\t${account}`,
      `timeout\t${Math.ceil((Number(pf.timeoutMs) || 900000) / 1000)}`,
      `deploytimeout\t${Math.ceil((Number(pf.deployTimeoutMs) || 900000) / 1000)}`,
      ...(pf.smokes ?? []).map(entry("smoke")),
      ...(pf.deploySmokes ?? []).map(entry("deploysmoke")),
    ].join("\n") + "\n");
  ' | strip_ansi
)
require_num "preflight.timeoutMs (seconds)" "${PREFLIGHT_TIMEOUT_S}"
require_num "preflight.deployTimeoutMs (seconds)" "${DEPLOY_TIMEOUT_S}"
require_num "HEALTH_WAIT_S" "${HEALTH_WAIT_S}"
require_num "DRAIN_WAIT_S" "${DRAIN_WAIT_S}"

# ------------------------------------------------------------- state readers
# fleet-state.json lives on the data PVC, which the workstation cannot see, so
# every read of it goes through the runner pod. Same file, same meaning; the
# only difference from the compose script is who does the reading.
in_runner() { "${KUBECTL[@]}" exec -i "${RUNNER_DEPLOY}" -- "$@"; }

alive_jobs() {
  in_runner env NO_COLOR=1 FORCE_COLOR=0 bun -e '
    try { const s = await Bun.file("/wrathbench/data/runs/fleet-state.json").json();
      process.stdout.write(String(Object.values(s.jobs ?? {}).filter((j) => j && j.alive === true).length) + "\n"); }
    catch { process.stdout.write("none\n"); }
  ' 2>/dev/null | strip_ansi | tr -d '\r' || echo none
}

# The module's /health, WITH the bearer (the pod carries the secret as env from
# the Secret). An unauthenticated probe would report a healthy server as sick,
# which is why the container's own readinessProbe is a tcpSocket and this is the
# real check.
health_ok() {
  in_runner bun -e '
    const url=(process.env.WRATHBENCH_MODULE_URL??"http://worldserver:8086")+"/health";
    const s=process.env.WRATHBENCH_MODULE_SECRET;const headers=s?{authorization:"Bearer "+s}:{};
    try{const r=await fetch(url,{headers,signal:AbortSignal.timeout(4000)});const j=await r.json();
      process.exit(j?.ok===true&&j?.worldStopped!==true?0:1);}catch{process.exit(1);}
  ' >/dev/null 2>&1
}
health_build() {
  in_runner env NO_COLOR=1 FORCE_COLOR=0 bun -e '
    const url=(process.env.WRATHBENCH_MODULE_URL??"http://worldserver:8086")+"/health";
    const s=process.env.WRATHBENCH_MODULE_SECRET;const headers=s?{authorization:"Bearer "+s}:{};
    try{const j=await (await fetch(url,{headers,signal:AbortSignal.timeout(4000)})).json();
      if(typeof j.build==="string"&&j.build!=="")process.stdout.write(j.build);}catch{}
  ' 2>/dev/null | strip_ansi | tr -d '\r' || true
}
deployed_tag() {
  # Every container's image, not [0]: a sidecar must not decide which image this
  # Deployment is. The worldserver ref is preferred, the first tagged ref is the
  # fallback.
  "${KUBECTL[@]}" get "${WORLD_DEPLOY}" -o jsonpath='{.spec.template.spec.containers[*].image}' 2>/dev/null | strip_ansi | tr -d '\r' || true
}
fleet_replicas() {
  "${KUBECTL[@]}" get "${FLEET_DEPLOY}" -o jsonpath='{.spec.replicas}' 2>/dev/null || echo 0
}
# The fleet's PODS, by the same selector the chart puts in the Deployment's
# `selector.matchLabels` (instance is .Release.Name, component is `fleet`), so
# this reads the same objects the scale acts on. One line per pod, "<name>
# <phase>", empty when there is none — which is the whole signal the drain
# waits for. Identical to fleet-update.sh's reader of the same name.
fleet_pods() {
  "${KUBECTL[@]}" get pods -l "app.kubernetes.io/instance=${RELEASE},app.kubernetes.io/component=fleet" \
    -o 'jsonpath={range .items[*]}{.metadata.name}{" "}{.status.phase}{"\n"}{end}' 2>/dev/null | strip_ansi | tr -d '\r' || true
}

# ------------------------------------------------------------- the pin check
#
# 2026-09-16: a pin PR whose checks had failed never merged, the chain that
# should have stopped there used `;` instead of `&&`, and this script ran a full
# window against the OLD image — it smoked the old release, wrote `running` with
# a verification, and resumed the fleet on it. Nothing in the deploy could have
# noticed, because nothing in it ever looked at what was deployed.
#
# So: the tag the cluster RUNS against the tag this TREE IS, before anything is
# drained. The registry is deliberately not compared — that is one cluster's
# business — only the tag after the last colon, which is the immutable
# `git describe` build-images.sh stamps everywhere (issue 7).
ref_tag() {
  local ref="$1" last="${1##*/}"
  [[ "${last}" == *:* ]] || return 1
  printf '%s' "${ref##*:}"
}
cluster_tag() {
  local images ref first="" t
  images="$(deployed_tag)"
  for ref in ${images}; do
    t="$(ref_tag "${ref}")" || continue
    [[ -n "${first}" ]] || first="${t}"
    case "${ref}" in */*worldserver:*) printf '%s' "${t}"; return 0 ;; esac
  done
  if [[ -n "${first}" ]]; then printf '%s' "${first}"; return 0; fi
  # No Deployment, or no tagged image on it: the module's own /health `build` is
  # the same string, stamped into the image at build time.
  health_build
}

CLUSTER_TAG=""; WANT_TAG=""; TAG_CHECK=""; TAG_CHECK_WHY=""
resolve_tag_check() {
  WANT_TAG="${EXPECT_TAG:-${TREE_TAG}}"
  CLUSTER_TAG="$(cluster_tag)"
  if [[ -z "${WANT_TAG}" ]]; then
    TAG_CHECK=unknown
    TAG_CHECK_WHY="this tree has no tag — \`git describe --tags --always\` produced nothing (not a git checkout?), so there is nothing to compare the cluster's ${CLUSTER_TAG:-unknown} against"
  elif [[ -z "${CLUSTER_TAG}" ]]; then
    TAG_CHECK=unknown
    TAG_CHECK_WHY="the cluster's image tag did not read back from ${WORLD_DEPLOY} or from the module's /health, so it cannot be shown to be ${WANT_TAG}"
  elif [[ "${WANT_TAG}" == "${CLUSTER_TAG}" ]]; then
    TAG_CHECK=ok
    TAG_CHECK_WHY="the cluster runs ${CLUSTER_TAG}, which is $(if [[ -n "${EXPECT_TAG}" ]]; then echo "the --expect-tag"; else echo "this tree"; fi)"
  else
    TAG_CHECK=mismatch
    TAG_CHECK_WHY="the cluster runs ${CLUSTER_TAG} but $(if [[ -n "${EXPECT_TAG}" ]]; then echo "--expect-tag is"; else echo "this tree is"; fi) ${WANT_TAG}"
  fi
}
enforce_tag_check() {
  resolve_tag_check
  if [[ "${TAG_CHECK}" == "ok" ]]; then
    say "pin check: ${TAG_CHECK_WHY}"
    return 0
  fi
  if [[ "${ALLOW_TAG_MISMATCH}" -eq 1 ]]; then
    say "pin check: ${TAG_CHECK_WHY} — running anyway (--allow-tag-mismatch). Whatever this window verifies, it is NOT ${WANT_TAG:-this tree}."
    return 0
  fi
  {
    echo "[$(date +%H:%M:%S)] k8s-deploy: REFUSING TO DEPLOY: ${TAG_CHECK_WHY}."
    echo "    A window run here would drain the fleet, smoke whatever is actually deployed,"
    echo "    record that as verified and resume the fleet on it (2026-09-16)."
    echo "    Land the pin first and wait for the rollout, then re-run. Or, deliberately:"
    echo "      --expect-tag <tag>        require a different tag"
    echo "      --allow-tag-mismatch      deploy anyway, and say so in the log"
  } >&2
  exit 1
}

# ------------------------------------------------------------- pause switch
# `fleet-update.sh drain` sets the switch and LEAVES it set for this window;
# clearing it is what `fleet-update.sh resume` does, and this script's resume
# phase is the moment for it — a deploy that brings the fleet back to a switch
# nobody cleared brings back a fleet that schedules nothing (2026-09-16).
pause_switch_set() {
  in_runner sh -c "[ -f '${PAUSE_JSON}' ]" >/dev/null 2>&1
}
clear_pause_switch() {
  in_runner rm -f "${PAUSE_JSON}" >/dev/null 2>&1
}

# ------------------------------------------------------------- server state
# data/runs/server-state.json is what the viewer's /api/fleet serves as
# `server`, and what the Fleet page's banner prints verbatim. Written through
# the runner pod for the same reason as every other PVC read.
#
# The compose script holds an flock on server-state.lock for its whole window,
# and the supervisor only writes `running` over another phase when that lock is
# FREE. That does not port: an flock taken inside a `kubectl exec` dies with the
# exec, so a lock held across this script would be a lie. It is deliberately not
# faked. On the cluster the mutual exclusion that matters is a different one —
# Flux owns the image tag, so there is exactly one thing that can change what is
# deployed, and two operators running this script at once contend for the smoke
# accounts rather than for the server. Keep the window to one operator.
NEW_BUILD=""
WINDOW_SINCE_MS="$(date +%s)000"
write_phase() {
  local phase="$1" detail="$2"
  [[ "${DRY_RUN}" -eq 1 ]] && return 0
  in_runner env NO_COLOR=1 FORCE_COLOR=0 bun -e '
    const [phase, since, build, detail] = process.argv.slice(1);
    const p = "/wrathbench/data/runs/server-state.json";
    const s = { phase, since: Number(since), build, detail, pid: 0, updatedAt: Date.now() };
    await Bun.write(p + ".tmp", JSON.stringify(s, null, 2) + "\n");
    const { renameSync } = await import("node:fs"); renameSync(p + ".tmp", p);
  ' "${phase}" "${WINDOW_SINCE_MS}" "${NEW_BUILD}" "${detail}" >/dev/null || true
  say "phase ${phase}: ${detail}"
}

# ----------------------------------------------------------------- --dry-run
if [[ "${DRY_RUN}" -eq 1 ]]; then
  say "--dry-run: resolved values only; nothing is scaled, waited on or smoked"
  say "  namespace          ${NAMESPACE}"
  say "  release            ${RELEASE}"
  say "  fleet config       the config store, via ${RUNNER_DEPLOY} (config-store.ts get preflight)"
  say "  worldserver image  $(deployed_tag) (Flux owns this; this script never changes it)"
  say "  fleet replicas     $(fleet_replicas)"
  say "  fleet pods         $(p="$(fleet_pods)"; if [[ -n "${p//[[:space:]]/}" ]]; then echo "${p//$'\n'/; }" | sed 's/; $//'; else echo "none — the drain would not have to wait for one"; fi)"
  resolve_tag_check
  case "${TAG_CHECK}" in
    ok) say "  pin check          OK — ${TAG_CHECK_WHY}" ;;
    *)  say "  pin check          WOULD REFUSE — ${TAG_CHECK_WHY}$(if [[ "${ALLOW_TAG_MISMATCH}" -eq 1 ]]; then echo " (but --allow-tag-mismatch was given, so it would run)"; fi)" ;;
  esac
  say "  pause switch       $(if pause_switch_set; then echo "SET (${PAUSE_JSON}) — the resume phase would clear it"; else echo "not set (${PAUSE_JSON})"; fi)"
  say "  jobs alive         $(alive_jobs) (per the runner pod's view of fleet-state.json)"
  say "  health wait        ${HEALTH_WAIT_S}s"
  say "  drain wait         ${DRAIN_WAIT_S}s after the fleet scales to 0"
  say "  preflight account  ${PREFLIGHT_ACCOUNT}"
  say "  smokes (${#SMOKES[@]})         ${SMOKES[*]-none} (budget ${PREFLIGHT_TIMEOUT_S}s)"
  say "  deploy smokes (${#DEPLOY_SMOKES[@]})  ${DEPLOY_SMOKES[*]-none} (budget ${DEPLOY_TIMEOUT_S}s)"
  say "  verification path  $(if [[ "${RUN_SMOKE}" -eq 0 ]]; then echo "none (--no-smoke)"; elif [[ "${#SMOKES[@]}" -eq 0 ]]; then echo "NONE — preflight has no smokes"; else echo "kubectl exec ${RUNNER_DEPLOY}, fleet at 0"; fi)"
  exit 0
fi

# ----------------------------------------------------- the pin check, enforced
# Before the EXIT trap exists, so a refusal leaves the server-state phase alone:
# nothing was drained, nothing failed, and the viewer's banner should not say a
# deploy did.
enforce_tag_check

# ------------------------------------------------------------ invariants
FLEET_STOPPED=0
FLEET_RESTARTED=0
FAIL_WHY=""
VERIFIED_BY=""
FINAL_PHASE=""

bring_fleet_up() {
  [[ "${FLEET_RESTARTED}" -eq 1 ]] && return 0
  FLEET_RESTARTED=1
  say "scaling the fleet back to 1 (paused runs resume; the supervisor re-gates on the server identity)"
  "${KUBECTL[@]}" scale "${FLEET_DEPLOY}" --replicas=1
}
resume_pause_switch() {
  pause_switch_set || return 0
  if clear_pause_switch; then
    say "pause switch CLEARED (${PAUSE_JSON}) — the same thing \`fleet-update.sh resume\` does. A \`drain\` leaves it set for this window; the supervisor schedules again within a tick (60s)."
  else
    say "WARNING: the pause switch ${PAUSE_JSON} is SET and could not be cleared. The fleet is UP but schedules NOTHING until you run: ./infra/fleet-update.sh resume"
  fi
}
on_exit() {
  local rc="$?"
  trap - ERR EXIT
  if [[ "${FLEET_STOPPED}" -eq 1 || -n "${FINAL_PHASE}" ]]; then
    if ! bring_fleet_up; then
      write_phase failed "the fleet did not scale back up after the deploy window; run: kubectl -n ${NAMESPACE} scale ${FLEET_DEPLOY} --replicas=1"
      exit 1
    fi
  fi
  # Only the resume phase clears the switch. A failed window deliberately does
  # not: the fleet is up but gated, and an operator who reverts the tag wants
  # the switch exactly where the drain left it.
  case "${FINAL_PHASE}" in
    running|unverified) resume_pause_switch ;;
    failed)
      if pause_switch_set; then
        say "the pause switch is STILL SET (${PAUSE_JSON}) — deliberately, because this window FAILED."
        say "  The fleet is up and schedules nothing. Clear it with: ./infra/fleet-update.sh resume"
      fi
      ;;
  esac
  case "${FINAL_PHASE}" in
    running) write_phase running "deployed ${NEW_BUILD} at $(hhmm), verified by ${VERIFIED_BY}; fleet resumed" ;;
    unverified) write_phase running "deployed ${NEW_BUILD} at $(hhmm) UNVERIFIED (--no-smoke); the fleet's own gate is the only check" ;;
    failed) write_phase failed "${FAIL_WHY}; fleet started anyway — its gate blocks spawning until a build passes. Rollback is reverting image.tag in the cluster repo." ;;
  esac
  exit "${rc}"
}
trap on_exit EXIT

fail_closed() {
  trap - ERR
  set +e
  FAIL_WHY="$1"
  FINAL_PHASE=failed
  say "FAILED: $1"
  say "ROLLBACK IS A CLUSTER-REPO REVERT: point image.tag back at the previous immutable tag and let Flux reconcile."
  exit 1
}
trap 'fail_closed "unexpected error at line ${LINENO} (exit $?)"' ERR

# ----------------------------------------------------------------- 1. drain
CURRENT_PHASE=draining
START_REPLICAS="$(fleet_replicas)"
START_SWITCH=no
if pause_switch_set; then START_SWITCH=yes; fi
say "at the start: ${FLEET_DEPLOY} is at ${START_REPLICAS} replica(s), pause switch $(if [[ "${START_SWITCH}" == "yes" ]]; then echo "SET"; else echo "not set"; fi)"
if [[ "${START_SWITCH}" == "yes" && "${START_REPLICAS}" != "0" ]]; then
  say "  NOTE: a Helm upgrade resets the fleet Deployment to 1 replica even under a held"
  say "  pause switch, so a \`fleet-update.sh drain\` that left it at 0 does NOT mean it is"
  say "  still 0 by the time the chart has rolled (2026-09-16). Nothing was scheduled — the"
  say "  switch holds — and this window drains it again."
fi
if [[ "${START_REPLICAS}" != "0" ]]; then
  n_alive="$(alive_jobs)"
  [[ "${n_alive}" =~ ^[0-9]+$ ]] || n_alive=0
  PAUSED_NOTE="${n_alive} job(s) paused and will resume"
  write_phase draining "${n_alive} job(s) live — each run pauses and resumes after the deploy"
  FLEET_STOPPED=1
  "${KUBECTL[@]}" scale "${FLEET_DEPLOY}" --replicas=0
  # Blocks up to terminationGracePeriodSeconds (180s): SIGTERM -> supervisor ->
  # rosters -> runners pause -> supervisor writes its final state and exits.
  "${KUBECTL[@]}" rollout status "${FLEET_DEPLOY}" --timeout="${DRAIN_WAIT_S}s" >/dev/null 2>&1 || true
  say "fleet scaled to 0; waiting for its state file to say every job has exited (up to ${DRAIN_WAIT_S}s)"
  drain_deadline=$(( $(date +%s) + DRAIN_WAIT_S ))
  while :; do
    n_alive="$(alive_jobs)"
    [[ "${n_alive}" == "none" || "${n_alive}" == "0" ]] && break
    if [[ "$(date +%s)" -ge "${drain_deadline}" ]]; then
      fail_closed "the supervisor's state still lists ${n_alive} live job(s) ${DRAIN_WAIT_S}s after scaling to 0 — it did not exit cleanly; check data/runs/fleet-*.jsonl"
    fi
    sleep 5
  done
  say "drained: the supervisor's state lists no live job"
else
  FLEET_STOPPED=1
  PAUSED_NOTE="nothing was live"
  write_phase draining "the fleet was already at 0 — nothing to pause; it is scaled back at the end regardless"
fi

# THE STATE FILE IS NOT THE WHOLE DRAIN. It lists the supervisor's JOBS, and the
# supervisor also drives sessions of its own: the preflight gate runs
# `preflight.smokes` on the SMOKE accounts the moment it boots, and that is not
# a job, so fleet-state.json says "no live job" while it is mid-smoke. On
# 2026-09-17 a Helm upgrade put the fleet back to 1 replica under a held pause
# switch, its new pod started that preflight, this window scaled to 0, read the
# empty job list one second later and ran the GATE smoke on the same account —
# which the module refused with 409 account_owned_by_other_token, because the
# dying pod still held it inside its 180s termination grace.
#
# So the pod being GONE is the condition, not the job list. Same reader and same
# reason as fleet-update.sh's drain: `rollout status` on a Deployment scaled to
# 0 does not reliably wait for a pod that is still Terminating. Unconditional,
# including when the fleet was already at 0 — that branch does no state-file
# wait at all, and "already at 0" says nothing about a pod still in its grace.
say "waiting for the fleet POD to go away (its 180s grace is where pause records are written, and where the supervisor's own preflight session is released; up to ${DRAIN_WAIT_S}s)"
pod_deadline=$(( $(date +%s) + DRAIN_WAIT_S ))
pod_polls=0
while :; do
  fleet_pod_lines="$(fleet_pods)"
  pod_polls=$(( pod_polls + 1 ))
  if [[ -z "${fleet_pod_lines//[[:space:]]/}" ]]; then
    # An empty list and a failed read look the same here (the reader swallows
    # its errors), so a wait that never waited is worth one line: if the chart
    # ever renames the component label, this is where it would go silently
    # fail-open, and the log would otherwise read like a clean drain.
    [[ "${pod_polls}" -eq 1 ]] && say "  (no pod matched app.kubernetes.io/instance=${RELEASE},app.kubernetes.io/component=fleet on the first look — nothing to wait for)"
    break
  fi
  if [[ "$(date +%s)" -ge "${pod_deadline}" ]]; then
    pod_names=""
    while IFS= read -r l; do
      [[ -n "${l//[[:space:]]/}" ]] || continue
      pod_names="${pod_names}${pod_names:+, }${l}"
    done <<< "${fleet_pod_lines}"
    fail_closed "the fleet pod is still there ${DRAIN_WAIT_S}s after scaling to 0: ${pod_names} — it may still hold the ${PREFLIGHT_ACCOUNT} session its own preflight opened, and a smoke run now answers 409 account_owned_by_other_token (2026-09-17). Read: ${KUBECTL[*]} describe ${FLEET_DEPLOY}"
  fi
  sleep 2
done
say "drained: no fleet pod remains, so nothing else holds the smoke accounts"

# ------------------------------------------------------------------ 2. wait
CURRENT_PHASE=waiting
write_phase waiting "waiting for the worldserver rollout and /health ready (up to ${HEALTH_WAIT_S}s); fleet stopped, ${PAUSED_NOTE}"
"${KUBECTL[@]}" rollout status "${WORLD_DEPLOY}" --timeout="${HEALTH_WAIT_S}s" \
  || fail_closed "the worldserver rollout did not complete within ${HEALTH_WAIT_S}s"
say "waiting for the module to answer /health ready (bearer presented)"
deadline=$(( $(date +%s) + HEALTH_WAIT_S ))
until health_ok; do
  [[ "$(date +%s)" -ge "${deadline}" ]] && fail_closed "the module never answered /health ready within ${HEALTH_WAIT_S}s"
  sleep 5
done
NEW_BUILD="$(health_build)"
say "worldserver is healthy: build ${NEW_BUILD:-unknown} ($(deployed_tag))"

if [[ "${RUN_SMOKE}" -eq 0 ]]; then
  trap - ERR
  say "--no-smoke: DEPLOYED UNVERIFIED. Nothing has driven this server end to end; the fleet's own gate is the only check."
  FINAL_PHASE=unverified
  exit 0
fi

# ---------------------------------------------------------------- 3. verify
CURRENT_PHASE=verifying
[[ "${#SMOKES[@]}" -gt 0 ]] || fail_closed "preflight has no smokes configured, and --no-smoke was not given"

# One shared budget for the whole sequence, same as the supervisor's gate.
# `timeout` kills the kubectl CLIENT: the smoke keeps running in the pod and
# keeps its session (the module reclaims that on the next create), so a timeout
# here is a hard stop, not something to continue past.
RAN=0
run_smokes() {
  local budget="$1" label="$2"; shift 2
  local smoke account left started took total=$(( $# / 2 )) n=0
  local smoke_deadline=$(( $(date +%s) + budget ))
  RAN=0
  while [[ "$#" -ge 2 ]]; do
    smoke="$1"; account="$2"; shift 2
    n=$(( n + 1 ))
    left=$(( smoke_deadline - $(date +%s) ))
    if [[ "${left}" -le 0 ]]; then
      say "${label} budget exhausted before ${smoke} ran"
      return 1
    fi
    say "smoke ${smoke} — starting as ${account} (${left}s left of the ${label} budget)"
    write_phase verifying "${label} smoke ${smoke} (${n} of ${total}) running since $(hhmm), ${left}s left of its budget; fleet stopped, ${PAUSED_NOTE}"
    started=$(date +%s)
    if timeout "${left}" "${KUBECTL[@]}" exec -i "${RUNNER_DEPLOY}" \
        -- env "MODULE_ACCOUNT=${account}" bun "${smoke}"; then
      took=$(( $(date +%s) - started ))
      say "smoke ${smoke} — PASSED in ${took}s"
      RAN=$(( RAN + 1 ))
    else
      local src=$?
      took=$(( $(date +%s) - started ))
      say "smoke ${smoke} — FAILED after ${took}s (exit ${src}$([[ "${src}" -eq 124 ]] && echo ", timed out and left running in the pod"))"
      return 1
    fi
  done
}

gate_pairs=()
for (( i = 0; i < ${#SMOKES[@]}; i++ )); do gate_pairs+=("${SMOKES[$i]}" "${SMOKE_ACCOUNTS[$i]}"); done
run_smokes "${PREFLIGHT_TIMEOUT_S}" "gate" "${gate_pairs[@]}" || fail_closed "gate smoke failed on ${NEW_BUILD}"
[[ "${RAN}" -gt 0 ]] || fail_closed "no smoke actually executed — refusing to call this verified"
VERIFIED_BY="${RAN} direct smoke(s)"

if [[ "${#DEPLOY_SMOKES[@]}" -gt 0 ]]; then
  say "running the deploy-time full arc (${#DEPLOY_SMOKES[@]} smoke(s), budget ${DEPLOY_TIMEOUT_S}s)"
  deploy_pairs=()
  for (( i = 0; i < ${#DEPLOY_SMOKES[@]}; i++ )); do deploy_pairs+=("${DEPLOY_SMOKES[$i]}" "${DEPLOY_SMOKE_ACCOUNTS[$i]}"); done
  run_smokes "${DEPLOY_TIMEOUT_S}" "full-arc" "${deploy_pairs[@]}" || fail_closed "full-arc smoke failed on ${NEW_BUILD}"
  VERIFIED_BY="${VERIFIED_BY} + ${RAN} full-arc smoke(s)"
fi

trap - ERR
[[ -n "${VERIFIED_BY}" ]] || fail_closed "reached the end without a verification"

# ---------------------------------------------------------------- 4. resume
FINAL_PHASE=running
write_phase resuming "verified by ${VERIFIED_BY}; the supervisor re-gates on the new identity and resumes every paused run before it fills the pool"
say "DEPLOYED and verified by ${VERIFIED_BY}."
exit 0
