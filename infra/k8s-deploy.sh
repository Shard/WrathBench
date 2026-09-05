#!/usr/bin/env bash
#
# The day-2 deploy window on Kubernetes. The compose equivalent is
# infra/deploy-worldserver.sh, and this is deliberately the same shape:
#
#   draining    scale the fleet Deployment to 0. SIGTERM reaches the
#               supervisor, every live run PAUSES and is resumed when it comes
#               back. Then wait for the supervisor's own state file to say every
#               job has exited — never a pid probe, never a guess.
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
#   ./infra/k8s-deploy.sh                 # drain, wait, smoke, resume
#   ./infra/k8s-deploy.sh --dry-run       # resolved values only; change nothing
#   ./infra/k8s-deploy.sh --no-smoke      # window WITHOUT verification (honest,
#                                         # and it says so)
#   ./infra/k8s-deploy.sh --namespace wrathbench --release wrathbench

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
FLEET_JSON="${WRATHBENCH_DEPLOY_FLEET_JSON:-${REPO_ROOT}/infra/fleet.json}"

NAMESPACE="${WRATHBENCH_K8S_NAMESPACE:-wrathbench}"
RELEASE="${WRATHBENCH_K8S_RELEASE:-wrathbench}"
RUN_SMOKE=1
DRY_RUN=0
HEALTH_WAIT_S="${WRATHBENCH_DEPLOY_HEALTH_WAIT_S:-900}"
DRAIN_WAIT_S="${WRATHBENCH_DEPLOY_DRAIN_WAIT_S:-300}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --namespace|-n) NAMESPACE="$2"; shift 2 ;;
    --release) RELEASE="$2"; shift 2 ;;
    --no-smoke) RUN_SMOKE=0; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
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
command -v bun >/dev/null 2>&1 || die "bun is not on PATH (this script reads fleet.json with it)"

readonly BUN_PLAIN_ENV=(env NO_COLOR=1 FORCE_COLOR=0 TERM=dumb)
strip_ansi() { sed -e 's/\x1b\[[0-9;]*[A-Za-z]//g'; }

# ------------------------------------------------------------------ 0. config
# Identical parse to deploy-worldserver.sh: fleet.json is the one place the
# smokes and their accounts are configured, on compose and on Kubernetes.
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
  "${BUN_PLAIN_ENV[@]}" bun -e '
    const c = await Bun.file(process.argv[1]).json();
    const pf = c.preflight ?? {};
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
  ' "${FLEET_JSON}" | strip_ansi
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
  "${KUBECTL[@]}" get "${WORLD_DEPLOY}" -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null || true
}
fleet_replicas() {
  "${KUBECTL[@]}" get "${FLEET_DEPLOY}" -o jsonpath='{.spec.replicas}' 2>/dev/null || echo 0
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
  say "  fleet config       ${FLEET_JSON}"
  say "  worldserver image  $(deployed_tag) (Flux owns this; this script never changes it)"
  say "  fleet replicas     $(fleet_replicas)"
  say "  jobs alive         $(alive_jobs) (per the runner pod's view of fleet-state.json)"
  say "  health wait        ${HEALTH_WAIT_S}s"
  say "  drain wait         ${DRAIN_WAIT_S}s after the fleet scales to 0"
  say "  preflight account  ${PREFLIGHT_ACCOUNT}"
  say "  smokes (${#SMOKES[@]})         ${SMOKES[*]-none} (budget ${PREFLIGHT_TIMEOUT_S}s)"
  say "  deploy smokes (${#DEPLOY_SMOKES[@]})  ${DEPLOY_SMOKES[*]-none} (budget ${DEPLOY_TIMEOUT_S}s)"
  say "  verification path  $(if [[ "${RUN_SMOKE}" -eq 0 ]]; then echo "none (--no-smoke)"; elif [[ "${#SMOKES[@]}" -eq 0 ]]; then echo "NONE — preflight has no smokes"; else echo "kubectl exec ${RUNNER_DEPLOY}, fleet at 0"; fi)"
  exit 0
fi

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
on_exit() {
  local rc="$?"
  trap - ERR EXIT
  if [[ "${FLEET_STOPPED}" -eq 1 || -n "${FINAL_PHASE}" ]]; then
    if ! bring_fleet_up; then
      write_phase failed "the fleet did not scale back up after the deploy window; run: kubectl -n ${NAMESPACE} scale ${FLEET_DEPLOY} --replicas=1"
      exit 1
    fi
  fi
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
if [[ "$(fleet_replicas)" != "0" ]]; then
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
