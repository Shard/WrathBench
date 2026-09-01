#!/usr/bin/env bash
#
# Deploy a new worldserver image. One command owns the whole window:
#
#   ./infra/deploy-worldserver.sh                     # promote :next -> :latest
#   ./infra/deploy-worldserver.sh --next-tag wrathbench/worldserver:mybuild
#   ./infra/deploy-worldserver.sh --dry-run           # print the plan and the
#                                                     # resolved values; do nothing
#   ./infra/deploy-worldserver.sh --no-smoke          # deploy UNVERIFIED (see below)
#
# Phases, each written to data/runs/server-state.json for the viewer:
#
#   draining    stop the `fleet` service. SIGTERM reaches the supervisor, every
#               live run PAUSES and is resumed by the supervisor when
#               it comes back. The script then waits for the supervisor's own
#               state file to say every job has exited — never pgrep, never a
#               guess — with a bounded timeout that fails loudly.
#   swapping    tag :latest -> :prev, :next -> :latest, recreate the worldserver
#               (--no-deps: the one time recreation is the point), wait for the
#               module to answer /health ready.
#   verifying   run the gate smokes (preflight.smokes) and then the deploy-only
#               full arc (preflight.deploySmokes) directly through
#               `docker compose exec runner`. The fleet is down, so nothing else
#               is on the smoke accounts.
#   resuming    PASS: `compose up -d fleet`. The supervisor re-gates on the new
#               identity and resumes every paused run before it fills the pool.
#   running     the window is over; the detail line says what was deployed and
#               what verified it.
#   rolled-back FAIL: :prev -> :latest, recreate, wait for health, verify the OLD
#               build with the same smokes, bring the fleet back on it. Exit 1.
#   failed      the deploy failed AND nothing could be verified (no :prev, or the
#               old build failed too). The fleet is still brought up — its own
#               gate blocks spawning until something passes — and the phase
#               says so. Exit 1.
#
# Whatever happens after the fleet is stopped, the EXIT trap brings it back up.
# A deploy must never leave the fleet stopped: that is the invariant an
# operator relies on instead of watching the window.
#
# VERIFICATION IS FAIL-CLOSED (2026-08-22, after a deploy that printed
# "DEPLOYED and verified" having executed no smoke at all — see docs/WORKLOG.md):
# the success line prints only when VERIFIED_BY names something that actually
# ran to a zero exit. Every other path rolls back and exits non-zero, and the
# two honest "verified nothing" paths (--no-smoke, no smokes configured) say
# UNVERIFIED. Values read out of JSON are validated before they are used, and
# nothing machine-read is allowed to carry terminal colour.
#
# --no-smoke is the honest escape hatch for a machine where the preflight
# account does not exist in auth yet (see infra/fleet.json `preflight` notes):
# it deploys, waits for health, verifies nothing, says so, and hands the server
# to the fleet — whose own gate is then the only check.
#
# The script holds an flock on data/runs/server-state.lock for its lifetime.
# A second deploy refuses to start while it is held; the supervisor, on boot,
# writes `running` over any other phase it finds only when the lock is FREE,
# so a deploy that died mid-window cannot leave a stale phase on the page.

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
# Overridable only so the test harness can point the script at fixtures; the
# defaults are the real thing and nothing in normal operation sets these.
COMPOSE_FILE="${WRATHBENCH_DEPLOY_COMPOSE_FILE:-${REPO_ROOT}/infra/compose.yml}"
FLEET_JSON="${WRATHBENCH_DEPLOY_FLEET_JSON:-${REPO_ROOT}/infra/fleet.json}"
STATE_JSON="${WRATHBENCH_DEPLOY_STATE_JSON:-${REPO_ROOT}/data/runs/fleet-state.json}"
SERVER_STATE_JSON="${WRATHBENCH_DEPLOY_SERVER_STATE_JSON:-${REPO_ROOT}/data/runs/server-state.json}"
SERVER_STATE_LOCK="${SERVER_STATE_JSON%.json}.lock"
COMPOSE=(docker compose -f "${COMPOSE_FILE}")

IMAGE=wrathbench/worldserver
NEXT_TAG="${IMAGE}:next"
RUN_SMOKE=1
DRY_RUN=0
HEALTH_WAIT_S="${WRATHBENCH_DEPLOY_HEALTH_WAIT_S:-300}"
# How long, after `compose stop fleet` has returned, to wait for the
# supervisor's state file to say every job has exited. `stop` itself already
# blocks for up to the service's stop_grace_period (180s), so this only covers
# the final state write — or a supervisor that was SIGKILLed before it could
# make it, which is the loud failure.
DRAIN_WAIT_S="${WRATHBENCH_DEPLOY_DRAIN_WAIT_S:-60}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --next-tag) NEXT_TAG="$2"; shift 2 ;;
    --no-smoke) RUN_SMOKE=0; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --allow-live) echo "deploy-worldserver: --allow-live is gone — the deploy drains the fleet itself (runs pause and resume; see docs/OPERATIONS.md)" >&2; exit 2 ;;
    -h|--help) sed -n '2,55p' "$0"; exit 0 ;;
    *) echo "deploy-worldserver: unknown flag $1" >&2; exit 2 ;;
  esac
done

say() { echo "[$(date +%H:%M:%S)] deploy: $*"; }
die() { echo "[$(date +%H:%M:%S)] deploy: $*" >&2; exit 1; }
hhmm() { date +%H:%M; }

# Bun colourises inspected values when FORCE_COLOR is set in the environment —
# even into a pipe — so `console.log(900)` reaches bash as ESC[33m900ESC[0m and
# every later $(( )) on it dies. Machine-read helpers run with colour off AND
# their output is stripped, because one belt is never enough for a value that
# feeds arithmetic.
readonly BUN_PLAIN_ENV=(env NO_COLOR=1 FORCE_COLOR=0 TERM=dumb)
strip_ansi() { sed -e 's/\x1b\[[0-9;]*[A-Za-z]//g'; }
# Fail loudly rather than letting a non-numeric reach (( )), where a failed
# assignment escapes both `set -e` and the ERR trap (bash 5.3: an arithmetic
# error in `x=$(( ))` is not a command failure). This is defect (1) and half of
# defect (2) of the 2026-08-22 incident, and the regex is the actual guard.
require_num() {
  local name="$1" value="$2"
  [[ "${value}" =~ ^[0-9]+$ ]] || die "${name} is not a non-negative integer: $(printf %q "${value}")"
}

command -v bun >/dev/null 2>&1 || die "bun is not on PATH (this script reads fleet.json/fleet-state.json with it)"

# The module's port secret (module/PROTOCOL.md "Authentication"; FOLLOW-UPS
# 19). Compose interpolates AC_WRATH_BENCH_SECRET from the shell, and it does
# not read the repo-root .env (its project directory is infra/), so the
# recreate below would ship an empty secret and the new module would refuse
# to listen — a rollback, every time. Load it from .env when the shell does
# not carry it, and refuse the window outright when neither does.
if [[ -z "${WRATHBENCH_MODULE_SECRET:-}" && -f "${REPO_ROOT}/.env" ]]; then
  WRATHBENCH_MODULE_SECRET="$(sed -n 's/^WRATHBENCH_MODULE_SECRET=//p' "${REPO_ROOT}/.env" | head -1 | tr -d "\"'" )"
fi
export WRATHBENCH_MODULE_SECRET="${WRATHBENCH_MODULE_SECRET:-}"
[[ "${#WRATHBENCH_MODULE_SECRET}" -ge 32 ]] || die "WRATHBENCH_MODULE_SECRET is unset or shorter than 32 characters (in the shell or ${REPO_ROOT}/.env) — the module would refuse to listen; see docs/OPERATIONS.md, Secrets"
command -v flock >/dev/null 2>&1 || die "flock is not on PATH (util-linux); the deploy lock needs it"

cd "${REPO_ROOT}"

# ------------------------------------------------------------------ 0. config
# One bun call, plain text out, KEY<TAB>VALUE lines — no console.log of a
# number anywhere on a path bash will do arithmetic on.
# Smokes are `script<TAB>account` pairs (SMOKES / SMOKE_ACCOUNTS index-aligned):
# fleet.json entries may be a bare script (on preflight.account) or
# { script, account }. `deploySmokes` is the deploy-time full arc the
# supervisor never runs; it has its own budget.
PREFLIGHT_ENABLED=""
PREFLIGHT_ACCOUNT=""
PREFLIGHT_TIMEOUT_S=""
DEPLOY_TIMEOUT_S=""
SMOKES=()
SMOKE_ACCOUNTS=()
DEPLOY_SMOKES=()
DEPLOY_SMOKE_ACCOUNTS=()
read_preflight() {
  local key value account
  while IFS=$'\t' read -r key value account; do
    case "${key}" in
      enabled) PREFLIGHT_ENABLED="${value}" ;;
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
      const lines = [
        `enabled\t${pf.enabled === true ? 1 : 0}`,
        `account\t${account}`,
        `timeout\t${Math.ceil((Number(pf.timeoutMs) || 900000) / 1000)}`,
        `deploytimeout\t${Math.ceil((Number(pf.deployTimeoutMs) || 900000) / 1000)}`,
        ...(pf.smokes ?? []).map(entry("smoke")),
        ...(pf.deploySmokes ?? []).map(entry("deploysmoke")),
      ];
      process.stdout.write(lines.join("\n") + "\n");
    ' "${FLEET_JSON}" | strip_ansi
  )
  require_num "preflight.enabled" "${PREFLIGHT_ENABLED}"
  require_num "preflight.timeoutMs (seconds)" "${PREFLIGHT_TIMEOUT_S}"
  require_num "preflight.deployTimeoutMs (seconds)" "${DEPLOY_TIMEOUT_S}"
  [[ -n "${PREFLIGHT_ACCOUNT}" ]] || die "preflight.account is empty in ${FLEET_JSON}"
}
read_preflight
require_num "HEALTH_WAIT_S" "${HEALTH_WAIT_S}"
require_num "DRAIN_WAIT_S" "${DRAIN_WAIT_S}"

# ------------------------------------------------------------- fleet readers
fleet_container_running() {
  local names
  names="$("${COMPOSE[@]}" ps --status running --format '{{.Name}}' fleet 2>/dev/null | strip_ansi)" || return 1
  [[ -n "${names//[[:space:]]/}" ]]
}
# How many jobs the supervisor's state file still lists with a live process.
# "none" when there is no readable state file: nothing to drain.
alive_jobs() {
  "${BUN_PLAIN_ENV[@]}" bun -e '
    try { const s = await Bun.file(process.argv[1]).json();
      process.stdout.write(String(Object.values(s.jobs ?? {}).filter((j) => j && j.alive === true).length) + "\n"); }
    catch { process.stdout.write("none\n"); }
  ' "${STATE_JSON}" 2>/dev/null | strip_ansi || echo none
}
image_id() { docker image inspect -f '{{.Id}}' "$1" 2>/dev/null | strip_ansi | cut -c8-19; }
# The build stamp the module will report for an image, read off the image's
# WRATHBENCH_BUILD label/env (infra/build-worldserver.sh); falls back to the id.
image_build() {
  local tag="$1" b
  b="$(docker image inspect -f '{{index .Config.Labels "wrathbench.build"}}' "${tag}" 2>/dev/null | strip_ansi || true)"
  if [[ -z "${b}" || "${b}" == "<no value>" ]]; then
    b="$(docker image inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "${tag}" 2>/dev/null | strip_ansi | sed -n 's/^WRATHBENCH_BUILD=//p' | head -1 || true)"
  fi
  [[ -n "${b}" ]] && echo "${b}" || image_id "${tag}"
}
# The build the LIVE module reports on /health; empty when it does not answer.
# Both /health probes present the port secret: the exec'd bun autoloads
# /wrathbench/.env inside the runner, which is where it lives.
health_build() {
  "${COMPOSE[@]}" exec -T runner bun -e '
    const url=(process.env.WRATHBENCH_MODULE_URL??"http://worldserver:8086")+"/health";
    const s=process.env.WRATHBENCH_MODULE_SECRET;const headers=s?{authorization:"Bearer "+s}:{};
    try{const j=await (await fetch(url,{headers,signal:AbortSignal.timeout(4000)})).json();
      if(typeof j.build==="string"&&j.build!=="")process.stdout.write(j.build);}catch{}
  ' 2>/dev/null | strip_ansi || true
}

# ------------------------------------------------------------ server state
# data/runs/server-state.json — what the viewer's /api/fleet serves as
# `server`, and what the Fleet page's banner prints verbatim. Written at every
# phase transition; `running` when the window ends well. The detail string is
# composed HERE so the page never guesses.
NEW_BUILD=""
PREV_BUILD=""
PHASE_SINCE_MS=""
write_phase() {
  local phase="$1" detail="$2"
  [[ "${DRY_RUN}" -eq 1 ]] && return 0
  PHASE_SINCE_MS="${WINDOW_SINCE_MS}"
  mkdir -p "$(dirname "${SERVER_STATE_JSON}")"
  "${BUN_PLAIN_ENV[@]}" bun -e '
    const [p, phase, since, build, prevBuild, detail, pid] = process.argv.slice(1);
    const s = { phase, since: Number(since), build, ...(prevBuild !== "" ? { prevBuild } : {}), detail, pid: Number(pid), updatedAt: Date.now() };
    await Bun.write(p + ".tmp", JSON.stringify(s, null, 2) + "\n");
    const { renameSync } = await import("node:fs"); renameSync(p + ".tmp", p);
  ' "${SERVER_STATE_JSON}" "${phase}" "${PHASE_SINCE_MS}" "${NEW_BUILD}" "${PREV_BUILD}" "${detail}" "$$" >/dev/null
  say "phase ${phase}: ${detail}"
}

# ----------------------------------------------------------------- --dry-run
if [[ "${DRY_RUN}" -eq 1 ]]; then
  say "--dry-run: resolved values only, nothing is stopped, tagged, recreated or smoked"
  say "  compose file       ${COMPOSE_FILE}"
  say "  fleet config       ${FLEET_JSON}"
  say "  fleet state        ${STATE_JSON}"
  say "  server state       ${SERVER_STATE_JSON} (lock ${SERVER_STATE_LOCK})"
  say "  next tag           ${NEXT_TAG} $(docker image inspect "${NEXT_TAG}" >/dev/null 2>&1 && echo "(build $(image_build "${NEXT_TAG}"))" || echo "— MISSING, the deploy would refuse")"
  say "  rollback target    $(docker image inspect "${IMAGE}:latest" >/dev/null 2>&1 && echo "${IMAGE}:prev (from the running :latest, build $(b="$(health_build)"; [[ -n "${b}" ]] && echo "${b}" || image_build "${IMAGE}:latest"))" || echo "NONE — no ${IMAGE}:latest")"
  say "  port secret        ${#WRATHBENCH_MODULE_SECRET} chars (AC_WRATH_BENCH_SECRET on the recreate)"
  say "  health wait        ${HEALTH_WAIT_S}s"
  say "  drain wait         ${DRAIN_WAIT_S}s after compose stop returns"
  say "  preflight enabled  ${PREFLIGHT_ENABLED}"
  say "  preflight account  ${PREFLIGHT_ACCOUNT}"
  say "  preflight budget   ${PREFLIGHT_TIMEOUT_S}s for the whole smoke sequence"
  say "  smokes (${#SMOKES[@]})         ${SMOKES[*]-none}"
  say "  deploy smokes (${#DEPLOY_SMOKES[@]})  ${DEPLOY_SMOKES[*]-none} (budget ${DEPLOY_TIMEOUT_S}s, run after the gate smokes)"
  say "  fleet container    $(fleet_container_running && echo "running — the deploy would stop it (runs pause) and start it again at the end" || echo "not running — the deploy would start it at the end")"
  say "  jobs alive         $(alive_jobs) (per ${STATE_JSON})"
  say "  deploy lock        $(flock -n "${SERVER_STATE_LOCK}" true 2>/dev/null && echo free || echo "HELD — another deploy is running; this one would refuse")"
  say "  verification path  $(if [[ "${RUN_SMOKE}" -eq 0 ]]; then echo "none (--no-smoke): the fleet's own gate is the only check"; elif [[ "${#SMOKES[@]}" -eq 0 ]]; then echo "NONE — preflight has no smokes; the deploy would roll back unverified"; else echo "direct smokes via docker compose exec runner, fleet stopped"; fi)"
  exit 0
fi

# ------------------------------------------------------------------ 1. lock
mkdir -p "$(dirname "${SERVER_STATE_LOCK}")"
exec 9>"${SERVER_STATE_LOCK}"
flock -n 9 || die "another deploy holds ${SERVER_STATE_LOCK} — wait for it (watch the Fleet page or data/runs/server-state.json)"

docker image inspect "${NEXT_TAG}" >/dev/null 2>&1 || die "no such image: ${NEXT_TAG} (build it first)"
NEW_BUILD="$(image_build "${NEXT_TAG}")"
HAVE_PREV=0
if docker image inspect "${IMAGE}:latest" >/dev/null 2>&1; then
  HAVE_PREV=1
  # The image label names a build only for images built after the label was
  # added; the running module always knows its own.
  PREV_BUILD="$(health_build)"
  [[ -n "${PREV_BUILD}" ]] || PREV_BUILD="$(image_build "${IMAGE}:latest")"
fi
WINDOW_SINCE_MS="$(date +%s)000"
require_num "WINDOW_SINCE_MS" "${WINDOW_SINCE_MS}"

# ------------------------------------------------------------ invariants
# Everything below runs with the fleet stopped. Two traps keep the promises:
#   ERR  -> fail_closed: roll back (if the swap happened), verify the old build,
#           write the phase, exit 1.
#   EXIT -> bring_fleet_up: whatever happened, the fleet is UP when we leave.
FLEET_STOPPED=0
FLEET_RESTARTED=0
FLEET_UP_FAILED=0
SWAPPED=0
FINAL_PHASE=""
VERIFIED_BY=""

bring_fleet_up() {
  if [[ "${FLEET_RESTARTED}" -eq 1 ]]; then return 0; fi
  FLEET_RESTARTED=1
  say "starting the fleet service (paused runs resume; the supervisor re-gates on the server identity)"
  if "${COMPOSE[@]}" up -d fleet; then
    return 0
  fi
  FLEET_UP_FAILED=1
  say "FLEET DID NOT START — run: docker compose -f ${COMPOSE_FILE} up -d fleet"
  return 1
}
on_exit() {
  local rc="$?"
  trap - ERR EXIT
  if [[ "${FLEET_STOPPED}" -eq 1 || "${FINAL_PHASE}" != "" ]]; then
    # Even a deploy that never stopped the fleet (it was already down) brings
    # it up: the window ends with a running fleet, full stop.
    if [[ "${FLEET_UP_FAILED}" -eq 1 ]] || ! bring_fleet_up; then
      write_phase failed "the fleet service did not start after the deploy window (server on ${NEW_BUILD}${VERIFIED_BY:+, verified by ${VERIFIED_BY}}); start it by hand: docker compose -f infra/compose.yml up -d fleet"
      exit 1
    fi
  fi
  if [[ "${FINAL_PHASE}" == "running" ]]; then
    write_phase running "deployed ${NEW_BUILD} at $(hhmm), verified by ${VERIFIED_BY}; fleet resumed"
  elif [[ "${FINAL_PHASE}" == "unverified" ]]; then
    write_phase running "deployed ${NEW_BUILD} at $(hhmm) UNVERIFIED (--no-smoke); the fleet's own gate is the only check"
  elif [[ "${FINAL_PHASE}" == "rolled-back" ]]; then
    write_phase rolled-back "${FAIL_WHY}; ${PREV_BUILD} verified by ${VERIFIED_BY}; fleet resumed on the old build"
  elif [[ "${FINAL_PHASE}" == "failed" ]]; then
    write_phase failed "${FAIL_WHY}; fleet started anyway — its gate blocks spawning until a build passes"
  fi
  exit "${rc}"
}
trap on_exit EXIT

FAIL_WHY=""
ROLLED_BACK=0
# The failure path. Called from the ERR trap and from every explicit failure:
# roll back if the swap happened, verify the restored build with the gate
# smokes, and leave through the EXIT trap (which starts the fleet).
fail_closed() {
  local why="$1" i
  local -a gate_pairs
  trap - ERR
  set +e
  FAIL_WHY="${why}"
  say "FAILED: ${why}"
  if [[ "${SWAPPED}" -eq 0 ]]; then
    # Nothing was swapped: the running server is the old one, untouched.
    FINAL_PHASE=failed
    FAIL_WHY="${why} (the server was not swapped; ${PREV_BUILD:-the running build} is still live)"
    exit 1
  fi
  if [[ "${HAVE_PREV}" -eq 0 ]]; then
    FINAL_PHASE=failed
    FAIL_WHY="${why}; ROLLBACK IMPOSSIBLE (no ${IMAGE}:prev) — ${NEW_BUILD} is live and unverified"
    say "ROLLBACK IMPOSSIBLE: no ${IMAGE}:prev. The new image is live and unverified."
    exit 1
  fi
  if [[ "${ROLLED_BACK}" -eq 1 ]]; then
    FINAL_PHASE=failed
    FAIL_WHY="${why}; the rollback to ${PREV_BUILD} did not verify either"
    exit 1
  fi
  ROLLED_BACK=1
  write_phase rolled-back "${why}; recreating the worldserver on ${PREV_BUILD}; fleet stopped, ${PAUSED_NOTE}"
  say "ROLLING BACK to ${IMAGE}:prev"
  docker tag "${IMAGE}:prev" "${IMAGE}:latest"
  "${COMPOSE[@]}" up -d --no-deps worldserver
  if ! wait_healthy; then
    FINAL_PHASE=failed
    FAIL_WHY="${why}; rolled back to ${PREV_BUILD} but it never became healthy"
    exit 1
  fi
  write_phase rolled-back "${why}; verifying the old build with the gate smokes; fleet stopped, ${PAUSED_NOTE}"
  VERIFIED_BY=""
  CURRENT_PHASE=rolled-back
  PHASE_PREFIX="${why}; verifying the old build: "
  if [[ "${#SMOKES[@]}" -gt 0 ]] && [[ "${RUN_SMOKE}" -eq 1 ]]; then
    gate_pairs=()
    for (( i = 0; i < ${#SMOKES[@]}; i++ )); do
      gate_pairs+=("${SMOKES[$i]}" "${SMOKE_ACCOUNTS[$i]}")
    done
    if run_smokes_directly "${PREFLIGHT_TIMEOUT_S}" "gate" "${gate_pairs[@]}" && [[ "${RAN}" -gt 0 ]]; then
      VERIFIED_BY="${RAN} direct smoke(s)"
    fi
  fi
  if [[ -z "${VERIFIED_BY}" ]]; then
    FINAL_PHASE=failed
    FAIL_WHY="${why}; rolled back to ${PREV_BUILD} but could not verify it"
    exit 1
  fi
  say "rolled back to ${PREV_BUILD}, verified by ${VERIFIED_BY}"
  FINAL_PHASE=rolled-back
  exit 1
}
trap 'fail_closed "unexpected error at line ${LINENO} (exit $?)"' ERR

# ------------------------------------------------------------------ helpers
health_ok() {
  "${COMPOSE[@]}" exec -T runner bun -e '
    const url=(process.env.WRATHBENCH_MODULE_URL??"http://worldserver:8086")+"/health";
    const s=process.env.WRATHBENCH_MODULE_SECRET;const headers=s?{authorization:"Bearer "+s}:{};
    try{const r=await fetch(url,{headers,signal:AbortSignal.timeout(4000)});const j=await r.json();
      process.exit(j?.ok===true&&j?.worldStopped!==true?0:1);}catch{process.exit(1);}
  ' >/dev/null 2>&1
}
wait_healthy() {
  local deadline=$(( $(date +%s) + HEALTH_WAIT_S ))
  say "waiting for the module to answer /health ready (up to ${HEALTH_WAIT_S}s)"
  until health_ok; do
    if [[ "$(date +%s)" -ge "${deadline}" ]]; then
      say "worldserver never became healthy"
      return 1
    fi
    sleep 5
  done
  say "worldserver is healthy"
}

# Run smokes directly, sequentially, through `docker compose exec runner`,
# against one shared budget. Args: budget seconds, label, then script/account
# pairs (script1 account1 script2 account2 ...). Sets RAN to the count that
# passed; returns non-zero on the first failure (the caller decides what that
# means). The budget is for the WHOLE sequence, same as the supervisor's gate,
# so each script gets what is left of it. Note that `timeout` kills the
# `docker compose exec` CLIENT: the smoke keeps running inside the runner and
# keeps its session (the module reclaims that on the next create) — so a
# timeout here is a hard stop, not something to continue past.
RAN=0
run_smokes_directly() {
  local budget="$1" label="$2"; shift 2
  local smoke account left started src took total=$(( $# / 2 )) n=0
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
    write_phase "${CURRENT_PHASE}" "${PHASE_PREFIX}${label} smoke ${smoke} (${n} of ${total}) running since $(hhmm), ${left}s left of its budget; fleet stopped, ${PAUSED_NOTE}"
    started=$(date +%s)
    # `if cmd; then` and not `set +e`: an ERR trap fires on a failing command
    # even with errexit off, and only a tested command is exempt from both.
    # The gate smokes stage their characters through infra/fixtures (item 45),
    # which needs the db service. Those four WRATHBENCH_DB_* vars are on the
    # `runner` service itself now (compose.yml's *wb-db anchor), so only the
    # account is passed here — the gate runs each smoke as its own SMOKE-N,
    # which is not the smokes' own PROBE default.
    if timeout "${left}" "${COMPOSE[@]}" exec -T \
        -e "MODULE_ACCOUNT=${account}" \
        runner bun "${smoke}"; then
      src=0
    else
      src=$?
    fi
    took=$(( $(date +%s) - started ))
    if [[ "${src}" -ne 0 ]]; then
      say "smoke ${smoke} — FAILED after ${took}s (exit ${src}$([[ "${src}" -eq 124 ]] && echo ", timed out and left running in the runner"))"
      return 1
    fi
    say "smoke ${smoke} — PASSED in ${took}s (exit 0)"
    RAN=$(( RAN + 1 ))
  done
}

# ----------------------------------------------------------------- 2. drain
CURRENT_PHASE=draining
PHASE_PREFIX=""
PAUSED_NOTE="runs paused and will resume"
if fleet_container_running; then
  n_alive="$(alive_jobs)"
  [[ "${n_alive}" =~ ^[0-9]+$ ]] || n_alive=0
  PAUSED_NOTE="${n_alive} job(s) paused and will resume"
  write_phase draining "replacing ${PREV_BUILD:-nothing}; ${n_alive} job(s) live — each run pauses and resumes after the deploy"
  FLEET_STOPPED=1
  # Blocks up to stop_grace_period (180s): SIGTERM -> supervisor -> rosters ->
  # runners pause -> supervisor writes its final state and exits.
  "${COMPOSE[@]}" stop fleet
  say "fleet service stopped; waiting for its state file to say every job has exited (up to ${DRAIN_WAIT_S}s)"
  drain_deadline=$(( $(date +%s) + DRAIN_WAIT_S ))
  while :; do
    n_alive="$(alive_jobs)"
    if [[ "${n_alive}" == "none" || "${n_alive}" == "0" ]]; then break; fi
    if fleet_container_running; then
      fail_closed "the fleet container is still running after compose stop returned"
    fi
    if [[ "$(date +%s)" -ge "${drain_deadline}" ]]; then
      fail_closed "the supervisor's state still lists ${n_alive} live job(s) ${DRAIN_WAIT_S}s after compose stop — it did not exit cleanly (SIGKILLed inside the grace period?); check data/runs/fleet-*.jsonl"
    fi
    sleep 2
  done
  say "drained: the supervisor's state lists no live job"
else
  FLEET_STOPPED=1
  write_phase draining "replacing ${PREV_BUILD:-nothing}; the fleet was already stopped — nothing to pause, it is started at the end"
  say "fleet service is not running — nothing to drain (it is started at the end regardless)"
fi

# -------------------------------------------------------------------- 3. swap
CURRENT_PHASE=swapping
write_phase swapping "tagging ${NEXT_TAG} as latest (replacing ${PREV_BUILD:-nothing}) and recreating the worldserver; fleet stopped, ${PAUSED_NOTE}"
if [[ "${HAVE_PREV}" -eq 1 ]]; then
  docker tag "${IMAGE}:latest" "${IMAGE}:prev"
  say "tagged the running image ${IMAGE}:prev (rollback target, build ${PREV_BUILD})"
else
  say "no ${IMAGE}:latest to keep — there is no rollback target"
fi
docker tag "${NEXT_TAG}" "${IMAGE}:latest"
SWAPPED=1
say "promoted ${NEXT_TAG} -> ${IMAGE}:latest ($(image_id "${IMAGE}:latest"), build ${NEW_BUILD})"
# --no-deps is not optional: a dependency sweep would recreate the runner
# (where ad-hoc episodes live) under us.
say "recreating worldserver"
"${COMPOSE[@]}" up -d --no-deps worldserver
write_phase swapping "worldserver recreated, waiting for /health ready (up to ${HEALTH_WAIT_S}s); fleet stopped, ${PAUSED_NOTE}"
wait_healthy || fail_closed "${NEW_BUILD} never answered /health ready within ${HEALTH_WAIT_S}s"
live_build="$(health_build)"
if [[ -n "${live_build}" ]]; then
  NEW_BUILD="${live_build}"
  say "new server build: ${NEW_BUILD}"
fi

if [[ "${RUN_SMOKE}" -eq 0 ]]; then
  trap - ERR
  say "--no-smoke: DEPLOYED UNVERIFIED. Nothing has driven this server end to end; the fleet's own gate is the only check."
  FINAL_PHASE=unverified
  write_phase resuming "healthy and UNVERIFIED (--no-smoke); the fleet's own gate smokes the server before anything spawns"
  exit 0
fi

# ------------------------------------------------------------------- 4. verify
CURRENT_PHASE=verifying
PHASE_PREFIX=""
if [[ "${#SMOKES[@]}" -eq 0 ]]; then
  say "no smokes configured in fleet.json preflight — DEPLOYED UNVERIFIED, and that was not asked for."
  say "Nothing has driven this server end to end. Configure preflight.smokes, or say so with --no-smoke."
  fail_closed "preflight has no smokes configured, and --no-smoke was not given"
fi
say "running the preflight smokes directly (docker compose exec runner)"
gate_pairs=()
for (( i = 0; i < ${#SMOKES[@]}; i++ )); do
  gate_pairs+=("${SMOKES[$i]}" "${SMOKE_ACCOUNTS[$i]}")
done
run_smokes_directly "${PREFLIGHT_TIMEOUT_S}" "gate" "${gate_pairs[@]}" || fail_closed "gate smoke failed on ${NEW_BUILD}"
[[ "${RAN}" -gt 0 ]] || fail_closed "no smoke actually executed — refusing to call this verified"
VERIFIED_BY="${RAN} direct smoke(s)"

# The deploy-time full arc (preflight.deploySmokes): the per-tick gate is the
# fast proof; this is the long one, run once per deploy, after the gate has
# passed. A failure here rolls back exactly like a gate failure.
if [[ "${#DEPLOY_SMOKES[@]}" -gt 0 ]]; then
  say "running the deploy-time full arc (${#DEPLOY_SMOKES[@]} smoke(s), budget ${DEPLOY_TIMEOUT_S}s)"
  deploy_pairs=()
  for (( i = 0; i < ${#DEPLOY_SMOKES[@]}; i++ )); do
    deploy_pairs+=("${DEPLOY_SMOKES[$i]}" "${DEPLOY_SMOKE_ACCOUNTS[$i]}")
  done
  run_smokes_directly "${DEPLOY_TIMEOUT_S}" "full-arc" "${deploy_pairs[@]}" || fail_closed "full-arc smoke failed on ${NEW_BUILD}"
  VERIFIED_BY="${VERIFIED_BY} + ${RAN} full-arc smoke(s)"
fi

trap - ERR
[[ -n "${VERIFIED_BY}" ]] || fail_closed "reached the end without a verification"

# ------------------------------------------------------------------ 5. resume
FINAL_PHASE=running
write_phase resuming "verified by ${VERIFIED_BY}; the supervisor re-gates on the new identity and resumes every paused run before it fills the pool"
bring_fleet_up || exit 1
say "DEPLOYED and verified by ${VERIFIED_BY}. The fleet is up: it re-gates on the new server identity and resumes every paused run first."
exit 0
