#!/usr/bin/env bash
#
# Deploy a new worldserver image, verified by the fleet's own preflight smoke.
#
#   ./infra/deploy-worldserver.sh                     # promote :next -> :latest
#   ./infra/deploy-worldserver.sh --next-tag wrathbench/worldserver:mybuild
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
# --no-smoke is the honest escape hatch for a machine where the preflight
# account does not exist in auth yet (see infra/fleet.json `preflight` notes):
# it deploys and waits for health, verifies nothing, and says so.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
COMPOSE=(docker compose -f "${REPO_ROOT}/infra/compose.yml")
FLEET_JSON="${REPO_ROOT}/infra/fleet.json"
STATE_JSON="${REPO_ROOT}/data/runs/fleet-state.json"

IMAGE=wrathbench/worldserver
NEXT_TAG="${IMAGE}:next"
ALLOW_LIVE=0
RUN_SMOKE=1
HEALTH_WAIT_S=300
# How long to give a running supervisor to notice the new server and record a
# gate result before we stop waiting for it and smoke the server ourselves.
GATE_GRACE_S=240

while [[ $# -gt 0 ]]; do
  case "$1" in
    --next-tag) NEXT_TAG="$2"; shift 2 ;;
    --allow-live) ALLOW_LIVE=1; shift ;;
    --no-smoke) RUN_SMOKE=0; shift ;;
    -h|--help) sed -n '2,33p' "$0"; exit 0 ;;
    *) echo "deploy-worldserver: unknown flag $1" >&2; exit 2 ;;
  esac
done

say() { echo "[$(date +%H:%M:%S)] deploy: $*"; }
die() { echo "[$(date +%H:%M:%S)] deploy: $*" >&2; exit 1; }

command -v bun >/dev/null 2>&1 || die "bun is not on PATH (this script reads fleet.json/fleet-state.json with it)"

cd "${REPO_ROOT}"

# ------------------------------------------------------------------ 1. refuse
# Same signal as run-fleet --status: the roster's account-busy inference over
# the trajectory stores. Exit code carries it, so nothing here parses text.
if [[ "${ALLOW_LIVE}" -eq 0 ]]; then
  if ! bun infra/run-fleet.ts "${FLEET_JSON}" --live-runs; then
    die "episodes are live — drain first (set every lane enabled:false and wait for
       ./infra/run-fleet.sh --status to go quiet), or pass --allow-live to kill them"
  fi
else
  say "--allow-live: not checking for live episodes (they will be killed)"
fi

PREFLIGHT_ENABLED="$(bun -e 'const c=await Bun.file(process.argv[1]).json();console.log(c.preflight?.enabled===true?"1":"0")' "${FLEET_JSON}")"
PREFLIGHT_ACCOUNT="$(bun -e 'const c=await Bun.file(process.argv[1]).json();console.log(c.preflight?.account??"SMOKE")' "${FLEET_JSON}")"
mapfile -t SMOKES < <(bun -e 'const c=await Bun.file(process.argv[1]).json();for(const s of c.preflight?.smokes??[])console.log(s)' "${FLEET_JSON}")
PREFLIGHT_TIMEOUT_S="$(bun -e 'const c=await Bun.file(process.argv[1]).json();console.log(Math.ceil((c.preflight?.timeoutMs??900000)/1000))' "${FLEET_JSON}")"

# -------------------------------------------------------------------- 2. tags
docker image inspect "${NEXT_TAG}" >/dev/null 2>&1 || die "no such image: ${NEXT_TAG} (build it first)"
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

DEPLOY_AT_MS="$(date +%s000)"

rollback() {
  if [[ "${HAVE_PREV}" -eq 0 ]]; then
    say "ROLLBACK IMPOSSIBLE: no ${IMAGE}:prev. The new image is live and unverified."
    return
  fi
  say "ROLLING BACK to ${IMAGE}:prev"
  docker tag "${IMAGE}:prev" "${IMAGE}:latest"
  "${COMPOSE[@]}" up -d --no-deps worldserver
  say "rolled back; the fleet's own gate will re-smoke the restored server on its next tick"
}

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
    rollback
    exit 1
  fi
  sleep 5
done
say "worldserver is healthy"

if [[ "${RUN_SMOKE}" -eq 0 ]]; then
  say "--no-smoke: DEPLOYED UNVERIFIED. Nothing has driven this server end to end."
  exit 0
fi

# ------------------------------------------------------------------- 5. verify
fleet_alive() {
  bun -e '
    const p=process.argv[1];
    try{const s=await Bun.file(p).json();
      process.exit(typeof s.heartbeatAt==="number"&&Date.now()-s.heartbeatAt<180000?0:1);}
    catch{process.exit(1);}
  ' "${STATE_JSON}" >/dev/null 2>&1
}

# 0 = a gate result recorded after this deploy and PASSING; 1 = none yet;
# 2 = one recorded after this deploy and FAILING.
gate_verdict() {
  bun -e '
    const [p,since]=process.argv.slice(1);
    try{const s=await Bun.file(p).json();const g=s.preflight;
      if(!g||typeof g.at!=="number"||g.at<Number(since)||g.skipped===true)process.exit(1);
      if(g.ok===true)process.exit(0);
      console.error((g.results??[]).filter(r=>!r.ok).map(r=>`${r.script}: ${r.tail}`).join("\n"));
      process.exit(2);}
    catch{process.exit(1);}
  ' "${STATE_JSON}" "${DEPLOY_AT_MS}"
}

verified=0
if [[ "${PREFLIGHT_ENABLED}" -eq 1 ]] && fleet_alive; then
  say "fleet supervisor is up and gating — waiting for its gate result on the new server"
  gate_deadline=$(( $(date +%s) + GATE_GRACE_S + PREFLIGHT_TIMEOUT_S ))
  while [[ "$(date +%s)" -lt "${gate_deadline}" ]]; do
    set +e; gate_verdict; rc=$?; set -e
    case "${rc}" in
      0) say "fleet gate PASSED on the new server"; verified=1; break ;;
      2) say "fleet gate FAILED on the new server"; rollback; exit 1 ;;
    esac
    # No record yet. If the supervisor has had its grace and written nothing, it
    # is not gating (old code): stop waiting and smoke the server ourselves.
    if [[ "$(date +%s)" -ge $(( DEPLOY_AT_MS / 1000 + GATE_GRACE_S )) ]]; then
      say "no gate result after ${GATE_GRACE_S}s — the supervisor predates the gate; smoking directly"
      break
    fi
    sleep 10
  done
fi

if [[ "${verified}" -eq 0 ]]; then
  if [[ "${#SMOKES[@]}" -eq 0 ]]; then
    say "no smokes configured in fleet.json preflight — DEPLOYED UNVERIFIED"
    exit 0
  fi
  say "running the preflight smokes directly as ${PREFLIGHT_ACCOUNT} (docker compose exec runner)"
  for smoke in "${SMOKES[@]}"; do
    say "smoke ${smoke}"
    if ! timeout "${PREFLIGHT_TIMEOUT_S}" "${COMPOSE[@]}" exec -T \
        -e "MODULE_ACCOUNT=${PREFLIGHT_ACCOUNT}" runner bun "${smoke}"; then
      say "smoke FAILED: ${smoke}"
      rollback
      exit 1
    fi
  done
  verified=1
fi

say "DEPLOYED and verified. Re-enable lanes in infra/fleet.json (the supervisor picks them up
       within a tick); it re-gates on its own because the server identity changed."
