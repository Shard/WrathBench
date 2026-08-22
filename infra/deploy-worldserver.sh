#!/usr/bin/env bash
#
# Deploy a new worldserver image, verified by the fleet's own preflight smoke.
#
#   ./infra/deploy-worldserver.sh                     # promote :next -> :latest
#   ./infra/deploy-worldserver.sh --next-tag wrathbench/worldserver:mybuild
#   ./infra/deploy-worldserver.sh --dry-run           # print the plan and the
#                                                     # resolved values; do nothing
#   ./infra/deploy-worldserver.sh --no-smoke          # deploy UNVERIFIED (see below)
#   ./infra/deploy-worldserver.sh --allow-live        # override the refusal below
#
# The whole point is that a deploy is not "done" when the container is up — it
# is done when the same smokes the fleet gates on have passed against it. So:
#
#   1. refuse to run while any episode is live (recreating kills live sessions);
#   2. tag :latest -> :prev, :next -> :latest;
#   3. up -d --no-deps worldserver  (recreate: the one time that is the point);
#   4. wait for the module to answer /health ready;
#   5. verify. If the `fleet` service is up AND preflight is enabled in
#      infra/fleet.json, wait for IT to record a gate result for the new server
#      — the supervisor re-gates on identity change all by itself, and its
#      record is what unblocks lane spawning. If no gate record appears within
#      the grace window (an older supervisor that predates the gate, say), or
#      preflight is disabled, run the configured smokes directly through
#      `docker compose exec runner` instead.
#   6. on failure: :prev -> :latest, recreate, exit non-zero.
#
# The gate check keys on the gate record's TIMESTAMP, not on matching a server
# identity string: a stale `ok: true` record must never be able to greenlight a
# new image.
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
# it deploys and waits for health, verifies nothing, and says so.

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
# Overridable only so the test harness can point the script at fixtures; the
# defaults are the real thing and nothing in normal operation sets these.
COMPOSE_FILE="${WRATHBENCH_DEPLOY_COMPOSE_FILE:-${REPO_ROOT}/infra/compose.yml}"
FLEET_JSON="${WRATHBENCH_DEPLOY_FLEET_JSON:-${REPO_ROOT}/infra/fleet.json}"
STATE_JSON="${WRATHBENCH_DEPLOY_STATE_JSON:-${REPO_ROOT}/data/runs/fleet-state.json}"
COMPOSE=(docker compose -f "${COMPOSE_FILE}")

IMAGE=wrathbench/worldserver
NEXT_TAG="${IMAGE}:next"
ALLOW_LIVE=0
RUN_SMOKE=1
DRY_RUN=0
HEALTH_WAIT_S=300
# How long to give a running supervisor to notice the new server and record a
# gate result before we stop waiting for it and smoke the server ourselves.
GATE_GRACE_S=240
# A heartbeat older than this means the supervisor is not ticking, whatever the
# container says (run-fleet's own HEARTBEAT_STALE_MS).
HEARTBEAT_STALE_S=180

while [[ $# -gt 0 ]]; do
  case "$1" in
    --next-tag) NEXT_TAG="$2"; shift 2 ;;
    --allow-live) ALLOW_LIVE=1; shift ;;
    --no-smoke) RUN_SMOKE=0; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '2,42p' "$0"; exit 0 ;;
    *) echo "deploy-worldserver: unknown flag $1" >&2; exit 2 ;;
  esac
done

say() { echo "[$(date +%H:%M:%S)] deploy: $*"; }
die() { echo "[$(date +%H:%M:%S)] deploy: $*" >&2; exit 1; }

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

cd "${REPO_ROOT}"

# ------------------------------------------------------------------ 0. config
# One bun call, plain text out, KEY<TAB>VALUE lines — no console.log of a
# number anywhere on a path bash will do arithmetic on.
# Smokes are `script<TAB>account` pairs (SMOKES / SMOKE_ACCOUNTS index-aligned):
# fleet.json entries may be a bare script (on preflight.account) or
# { script, account }. `deploySmokes` is the deploy-time full arc the
# supervisor never runs (ADR-0023 amendment); it has its own budget.
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
require_num "GATE_GRACE_S" "${GATE_GRACE_S}"
require_num "HEARTBEAT_STALE_S" "${HEARTBEAT_STALE_S}"

# ------------------------------------------------------------------ 1. refuse
# Same signal as run-fleet --status: the roster's account-busy inference over
# the trajectory stores. Exit code carries it, so nothing here parses text.
live_runs_ok() { bun infra/run-fleet.ts "${FLEET_JSON}" --live-runs; }

# Liveness of the supervisor, from the host, needs BOTH halves: the container
# actually running AND a fresh heartbeat. A stopped fleet leaves its last
# heartbeat behind, and for up to HEARTBEAT_STALE_S that file still reads
# "alive" — which is how the 2026-08-22 deploy came to wait for a gate result
# from a supervisor that had been stopped (defect 3).
fleet_container_running() {
  local names
  names="$("${COMPOSE[@]}" ps --status running --format '{{.Name}}' fleet 2>/dev/null | strip_ansi)" || return 1
  [[ -n "${names//[[:space:]]/}" ]]
}
heartbeat_age_s() {
  "${BUN_PLAIN_ENV[@]}" bun -e '
    const s = await Bun.file(process.argv[1]).json();
    if (typeof s.heartbeatAt !== "number") { process.stdout.write("none\n"); process.exit(0); }
    process.stdout.write(String(Math.max(0, Math.round((Date.now() - s.heartbeatAt) / 1000))) + "\n");
  ' "${STATE_JSON}" 2>/dev/null | strip_ansi || echo none
}
fleet_alive() {
  local age
  fleet_container_running || return 1
  age="$(heartbeat_age_s)"
  [[ "${age}" =~ ^[0-9]+$ ]] || return 1
  [[ "${age}" -lt "${HEARTBEAT_STALE_S}" ]]
}

# ----------------------------------------------------------------- --dry-run
if [[ "${DRY_RUN}" -eq 1 ]]; then
  say "--dry-run: resolved values only, nothing is tagged, recreated or smoked"
  say "  compose file       ${COMPOSE_FILE}"
  say "  fleet config       ${FLEET_JSON}"
  say "  fleet state        ${STATE_JSON}"
  say "  next tag           ${NEXT_TAG}"
  say "  rollback target    $(docker image inspect "${IMAGE}:latest" >/dev/null 2>&1 && echo "${IMAGE}:prev (from the running :latest)" || echo "NONE — no ${IMAGE}:latest")"
  say "  health wait        ${HEALTH_WAIT_S}s"
  say "  gate grace         ${GATE_GRACE_S}s (from the moment the server is healthy)"
  say "  preflight enabled  ${PREFLIGHT_ENABLED}"
  say "  preflight account  ${PREFLIGHT_ACCOUNT}"
  say "  preflight budget   ${PREFLIGHT_TIMEOUT_S}s for the whole smoke sequence"
  say "  smokes (${#SMOKES[@]})       ${SMOKES[*]-none}"
  say "  deploy smokes (${#DEPLOY_SMOKES[@]}) ${DEPLOY_SMOKES[*]-none} (budget ${DEPLOY_TIMEOUT_S}s, run after the gate)"
  say "  fleet container    $(fleet_container_running && echo running || echo "not running")"
  say "  fleet heartbeat    $(heartbeat_age_s)s ago (stale at ${HEARTBEAT_STALE_S}s)"
  say "  verification path  $(if [[ "${RUN_SMOKE}" -eq 0 ]]; then echo "none (--no-smoke)"; elif [[ "${PREFLIGHT_ENABLED}" -eq 1 ]] && fleet_alive; then echo "wait for the fleet gate, then direct smokes if it never records"; elif [[ "${#SMOKES[@]}" -eq 0 ]]; then echo "NONE — preflight has no smokes; the deploy would exit non-zero unverified"; else echo "direct smokes via docker compose exec runner"; fi)"
  if [[ "${ALLOW_LIVE}" -eq 1 ]]; then
    say "  live episodes      not checked (--allow-live)"
  else
    say "  live episodes      $(live_runs_ok >/dev/null 2>&1 && echo "none — the deploy would proceed" || echo "PRESENT — the deploy would refuse")"
  fi
  exit 0
fi

if [[ "${ALLOW_LIVE}" -eq 0 ]]; then
  if ! live_runs_ok; then
    die "episodes are live — drain first (set every lane enabled:false and wait for
       ./infra/run-fleet.sh --status to go quiet), or pass --allow-live to kill them"
  fi
else
  say "--allow-live: not checking for live episodes (they will be killed)"
fi

# -------------------------------------------------------------------- 2. tags
docker image inspect "${NEXT_TAG}" >/dev/null 2>&1 || die "no such image: ${NEXT_TAG} (build it first)"
# A gate sequence in flight against the CURRENT server simply dies with the
# recreate; its record carries the old identity and gate_verdict ignores it.
# Nothing to wait for here.
HAVE_PREV=0
if docker image inspect "${IMAGE}:latest" >/dev/null 2>&1; then
  docker tag "${IMAGE}:latest" "${IMAGE}:prev"
  HAVE_PREV=1
  say "tagged the running image ${IMAGE}:prev (rollback target)"
else
  say "no ${IMAGE}:latest to keep — there is no rollback target"
fi
docker tag "${NEXT_TAG}" "${IMAGE}:latest"
say "promoted ${NEXT_TAG} -> ${IMAGE}:latest ($(docker image inspect -f '{{.Id}}' "${IMAGE}:latest" | cut -c8-19))"

DEPLOY_AT_MS="$(date +%s)000"
require_num "DEPLOY_AT_MS" "${DEPLOY_AT_MS}"

ROLLED_BACK=0
rollback() {
  if [[ "${ROLLED_BACK}" -eq 1 ]]; then return; fi
  ROLLED_BACK=1
  if [[ "${HAVE_PREV}" -eq 0 ]]; then
    say "ROLLBACK IMPOSSIBLE: no ${IMAGE}:prev. The new image is live and unverified."
    return
  fi
  say "ROLLING BACK to ${IMAGE}:prev"
  docker tag "${IMAGE}:prev" "${IMAGE}:latest"
  "${COMPOSE[@]}" up -d --no-deps worldserver
  say "rolled back; the fleet's own gate will re-smoke the restored server on its next tick"
}

# Anything unexpected after the promote — a failed docker call, a bad
# substitution, a helper that exits non-zero — is a failed deploy, not a
# warning. The trap is why "verified" can no longer be reached by falling
# through a broken step.
fail_closed() {
  local line="$1" rc="$2"
  trap - ERR
  say "FAILED at line ${line} (exit ${rc}) — treating the deploy as failed"
  rollback
  exit 1
}
trap 'fail_closed "${LINENO}" "$?"' ERR

# ----------------------------------------------------------------- 3. recreate
# --no-deps is not optional: a dependency sweep would recreate the runner (where
# ad-hoc episodes live) and the fleet supervisor under us.
say "recreating worldserver"
"${COMPOSE[@]}" up -d --no-deps worldserver

# ------------------------------------------------------------------- 4. health
say "waiting for the module to answer /health ready (up to ${HEALTH_WAIT_S}s)"
health_ok() {
  "${COMPOSE[@]}" exec -T runner bun -e '
    const url=(process.env.WRATHBENCH_MODULE_URL??"http://worldserver:8086")+"/health";
    try{const r=await fetch(url,{signal:AbortSignal.timeout(4000)});const j=await r.json();
      process.exit(j?.ok===true&&j?.worldStopped!==true?0:1);}catch{process.exit(1);}
  ' >/dev/null 2>&1
}
deadline=$(( $(date +%s) + HEALTH_WAIT_S ))
until health_ok; do
  if [[ "$(date +%s)" -ge "${deadline}" ]]; then
    say "worldserver never became healthy"
    trap - ERR
    rollback
    exit 1
  fi
  sleep 5
done
say "worldserver is healthy"
# The identity the supervisor will stamp on its gate record for THIS server.
# A record carrying any other identity is a verdict on some other boot.
NEW_IDENTITY="$("${COMPOSE[@]}" exec -T runner bun -e '
  const url=(process.env.WRATHBENCH_MODULE_URL??"http://worldserver:8086")+"/health";
  try{const j=await (await fetch(url,{signal:AbortSignal.timeout(4000)})).json();
    if(typeof j.build==="string"&&typeof j.startedAtMs==="number")process.stdout.write(`build:${j.build}@${Math.round(j.startedAtMs)}`);}catch{}
' 2>/dev/null | strip_ansi)"
say "new server identity: ${NEW_IDENTITY:-unknown (module predates /health build id; matching by time only)}"
# The gate grace is measured from HERE, not from the promote: the health wait
# above may legitimately take longer than the grace, and an expired grace would
# send us smoking directly while the live supervisor is smoking the same
# account — mutual session reclaims, a failed smoke, and a rolled-back good
# image. False rollback is the worst thing this script could do.
HEALTHY_AT_S="$(date +%s)"
require_num "HEALTHY_AT_S" "${HEALTHY_AT_S}"

if [[ "${RUN_SMOKE}" -eq 0 ]]; then
  trap - ERR
  say "--no-smoke: DEPLOYED UNVERIFIED. Nothing has driven this server end to end."
  exit 0
fi

# ------------------------------------------------------------------- 5. verify
# 0 = a gate result recorded after this deploy and PASSING; 1 = none yet;
# 2 = one recorded after this deploy and FAILING; 3 = none yet, but the
# supervisor reports a sequence IN FLIGHT that started after this deploy (the
# record is only written when the sequence ends, so "no record" alone says
# nothing — see the 2026-08-23 false rollback in docs/WORKLOG.md).
gate_verdict() {
  "${BUN_PLAIN_ENV[@]}" bun -e '
    const [p,since,ident]=process.argv.slice(1);
    const mine=(id)=>ident===""||id===ident;
    try{const s=await Bun.file(p).json();const g=s.preflight;const f=s.preflightInFlight;
      const fresh=g&&typeof g.at==="number"&&g.at>=Number(since)&&g.skipped!==true&&mine(g.serverIdentity);
      if(!fresh){ if(f&&typeof f.since==="number"&&f.since>=Number(since)&&mine(f.identity))process.exit(3); process.exit(1); }
      if(g.ok===true)process.exit(0);
      console.error((g.results??[]).filter(r=>!r.ok).map(r=>`${r.script}: ${r.tail}`).join("\n"));
      process.exit(2);}
    catch{process.exit(1);}
  ' "${STATE_JSON}" "${DEPLOY_AT_MS}" "${NEW_IDENTITY}"
}

# The single source of truth for the success line: set to a non-empty string
# only where something actually ran and returned zero.
VERIFIED_BY=""
if [[ "${PREFLIGHT_ENABLED}" -eq 1 ]] && fleet_alive; then
  say "fleet supervisor is up (container running, heartbeat $(heartbeat_age_s)s ago) and gating — waiting for its gate result on the new server"
  gate_deadline=$(( HEALTHY_AT_S + GATE_GRACE_S + PREFLIGHT_TIMEOUT_S ))
  grace_deadline=$(( HEALTHY_AT_S + GATE_GRACE_S ))
  seen_in_flight=0
  while [[ "$(date +%s)" -lt "${gate_deadline}" ]]; do
    if gate_verdict; then rc=0; else rc=$?; fi
    case "${rc}" in
      0) say "fleet gate PASSED on the new server"; VERIFIED_BY="fleet gate"; break ;;
      2) say "fleet gate FAILED on the new server"; trap - ERR; rollback; exit 1 ;;
      3) if [[ "${seen_in_flight}" -eq 0 ]]; then seen_in_flight=1; say "fleet gate is smoking the new server now — waiting up to ${PREFLIGHT_TIMEOUT_S}s for its verdict (never smoking alongside it: two smokes reclaim the same account from each other)"; fi ;;
      1) ;;
      *) say "gate check errored (exit ${rc})"; trap - ERR; rollback; exit 1 ;;
    esac
    # No record and no sequence in flight. If the supervisor has had its grace
    # and started nothing, it is not gating (old code): smoke the server
    # ourselves. Once a sequence has been seen in flight we wait for its verdict.
    if [[ "${seen_in_flight}" -eq 0 ]] && [[ "$(date +%s)" -ge "${grace_deadline}" ]]; then
      say "no gate activity after ${GATE_GRACE_S}s — the supervisor is not gating this server; smoking directly"
      break
    fi
    sleep 10
  done
  if [[ -z "${VERIFIED_BY}" ]] && [[ "$(date +%s)" -ge "${gate_deadline}" ]]; then
    say "the fleet gate recorded nothing within ${PREFLIGHT_TIMEOUT_S}s of its grace — the server is not verified"
    trap - ERR
    rollback
    exit 1
  fi
elif [[ "${PREFLIGHT_ENABLED}" -eq 1 ]]; then
  say "preflight is enabled but the fleet supervisor is not gating (container $(fleet_container_running && echo running || echo "not running"), heartbeat $(heartbeat_age_s)s ago) — smoking directly"
fi

# Run smokes directly, sequentially, through `docker compose exec runner`,
# against one shared budget. Args: budget seconds, label, then script/account
# pairs (script1 account1 script2 account2 ...). Sets RAN to the count that
# passed; rolls back and exits on the first failure. The budget is for the
# WHOLE sequence, same as the supervisor's gate, so each script gets what is
# left of it. Note that `timeout` kills the `docker compose exec` CLIENT: the
# smoke keeps running inside the runner and keeps its session (the module
# reclaims that on the next create) — so a timeout here is a hard stop, not
# something to continue past.
RAN=0
run_smokes_directly() {
  local budget="$1" label="$2"; shift 2
  local smoke account left started src took
  local smoke_deadline=$(( $(date +%s) + budget ))
  RAN=0
  while [[ "$#" -ge 2 ]]; do
    smoke="$1"; account="$2"; shift 2
    left=$(( smoke_deadline - $(date +%s) ))
    if [[ "${left}" -le 0 ]]; then
      say "${label} budget exhausted before ${smoke} ran"
      trap - ERR
      rollback
      exit 1
    fi
    say "smoke ${smoke} — starting as ${account} (${left}s left of the ${label} budget)"
    started=$(date +%s)
    # `if cmd; then` and not `set +e`: an ERR trap fires on a failing command
    # even with errexit off, and only a tested command is exempt from both.
    if timeout "${left}" "${COMPOSE[@]}" exec -T \
        -e "MODULE_ACCOUNT=${account}" runner bun "${smoke}"; then
      src=0
    else
      src=$?
    fi
    took=$(( $(date +%s) - started ))
    if [[ "${src}" -ne 0 ]]; then
      say "smoke ${smoke} — FAILED after ${took}s (exit ${src}$([[ "${src}" -eq 124 ]] && echo ", timed out and left running in the runner"))"
      trap - ERR
      rollback
      exit 1
    fi
    say "smoke ${smoke} — PASSED in ${took}s (exit 0)"
    RAN=$(( RAN + 1 ))
  done
}

# Interleave two index-aligned arrays into script/account pairs.
pairs() {
  local -n _scripts="$1" _accounts="$2"
  local i
  for (( i = 0; i < ${#_scripts[@]}; i++ )); do printf '%s\n%s\n' "${_scripts[$i]}" "${_accounts[$i]}"; done
}

if [[ -z "${VERIFIED_BY}" ]]; then
  if [[ "${#SMOKES[@]}" -eq 0 ]]; then
    trap - ERR
    say "no smokes configured in fleet.json preflight — DEPLOYED UNVERIFIED, and that was not asked for."
    say "Nothing has driven this server end to end. Configure preflight.smokes, or say so with --no-smoke."
    exit 1
  fi
  say "running the preflight smokes directly (docker compose exec runner)"
  mapfile -t gate_pairs < <(pairs SMOKES SMOKE_ACCOUNTS)
  run_smokes_directly "${PREFLIGHT_TIMEOUT_S}" "gate" "${gate_pairs[@]}"
  if [[ "${RAN}" -eq 0 ]]; then
    say "no smoke actually executed — refusing to call this verified"
    trap - ERR
    rollback
    exit 1
  fi
  VERIFIED_BY="${RAN} direct smoke(s)"
fi

# The deploy-time full arc (preflight.deploySmokes): the per-tick gate is the
# fast proof; this is the long one, run once per deploy, after the gate has
# passed — so the accounts it uses are idle, and a gate failure never pays for
# it. A failure here rolls back exactly like a gate failure.
if [[ "${#DEPLOY_SMOKES[@]}" -gt 0 ]]; then
  say "running the deploy-time full arc (${#DEPLOY_SMOKES[@]} smoke(s), budget ${DEPLOY_TIMEOUT_S}s)"
  mapfile -t deploy_pairs < <(pairs DEPLOY_SMOKES DEPLOY_SMOKE_ACCOUNTS)
  run_smokes_directly "${DEPLOY_TIMEOUT_S}" "full-arc" "${deploy_pairs[@]}"
  VERIFIED_BY="${VERIFIED_BY} + ${RAN} full-arc smoke(s)"
fi

trap - ERR
if [[ -z "${VERIFIED_BY}" ]]; then
  say "reached the end without a verification — refusing to call this verified"
  rollback
  exit 1
fi

say "DEPLOYED and verified by ${VERIFIED_BY}. Re-enable lanes in infra/fleet.json (the supervisor picks
       them up within a tick); it re-gates on its own because the server identity changed."
