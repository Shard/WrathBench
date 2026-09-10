#!/usr/bin/env bash
# Restart the operator viewer.
#
# CLUSTER-NATIVE since 2026-09-11. Since the 2026-09-08 cutover the viewer is
# the `wrathbench-viewer` Deployment behind the `wrathbench.local` Ingress
# (docs/[removed]), not a bun process on the workstation, so a restart
# is a rollout restart and the check that follows is the Ingress answering
# /api/info. The workstation's systemd user unit is disabled and kept only for
# the compose rollback; `--local` is the path that drives it.
#
#   ./infra/viewer-restart.sh            # rollout restart the viewer Deployment
#   ./infra/viewer-restart.sh --dry-run  # print the kubectl commands only
#   ./infra/viewer-restart.sh --local    # the retired workstation path (rollback)
#
# On the cluster the viewer's code is baked into the runner image and Flux owns
# the tag, so this restarts a wedged process — it does not deploy anything. A
# viewer that should be serving NEW code needs a new image tag, which is
# infra/build-images.sh plus a cluster-repo bump.
set -Eeuo pipefail

NAMESPACE="${WRATHBENCH_K8S_NAMESPACE:-wrathbench}"
RELEASE="${WRATHBENCH_K8S_RELEASE:-wrathbench}"
VIEWER_URL="${WRATHBENCH_VIEWER_URL:-https://wrathbench.local}"
LOCAL=0
DRY_RUN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --local) LOCAL=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --namespace|-n) NAMESPACE="${2:-}"; shift 2 ;;
    --release) RELEASE="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "viewer-restart: unknown argument $1" >&2; exit 2 ;;
  esac
done

if [[ "${LOCAL}" -eq 0 ]]; then
  DEPLOY="deployment/${RELEASE}-viewer"
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    echo "viewer-restart: would run kubectl -n ${NAMESPACE} rollout restart ${DEPLOY}"
    echo "viewer-restart: would run kubectl -n ${NAMESPACE} rollout status ${DEPLOY} --timeout=180s"
    echo "viewer-restart: would then GET ${VIEWER_URL}/api/info"
    exit 0
  fi
  kubectl -n "${NAMESPACE}" rollout restart "${DEPLOY}"
  kubectl -n "${NAMESPACE}" rollout status "${DEPLOY}" --timeout=180s
  curl -sk -o /dev/null -w "viewer: http %{http_code} on ${VIEWER_URL}\n" "${VIEWER_URL}/api/info"
  exit 0
fi

# ------------------------------------------------------------------- --local
# RETIRED, kept for the compose rollback in docs/[removed]. The
# systemd user unit (infra/wrathbench-viewer.service) owns the process when it
# is installed and a restart goes through it — a nohup launch beside it would
# race for the port. Kill by pid either way: `pkill -f` on the pattern matches
# the caller.
cd "$(dirname "$0")/.."
echo "viewer-restart: --local: the RETIRED workstation viewer (the live one is the cluster Deployment)"
if [[ "${DRY_RUN}" -eq 1 ]]; then echo "viewer-restart: would restart the systemd user unit or relaunch bun runner/viewer/serve.ts"; exit 0; fi
if systemctl --user cat wrathbench-viewer.service >/dev/null 2>&1; then
  systemctl --user restart wrathbench-viewer
else
  pid=$(ps -eo pid,args | grep "[b]un runner/viewer/serve.ts" | grep -v "bash -c" | awk '{print $1}' | head -1 || true)
  [ -n "${pid:-}" ] && kill "$pid" && sleep 2
  WRATHBENCH_MODULE_URL="${WRATHBENCH_MODULE_URL:-http://192.168.192.3:8086}" \
  WRATHBENCH_VIEWER_LAN="${WRATHBENCH_VIEWER_LAN:-1}" \
  WRATHBENCH_FLEET_CONFIG="${WRATHBENCH_FLEET_CONFIG:-infra/fleet.json}" \
    setsid nohup bun runner/viewer/serve.ts > data/viewer.log 2>&1 < /dev/null &
fi
sleep 4
curl -s -o /dev/null -w 'viewer: http %{http_code} on :8090\n' http://127.0.0.1:8090/api/info
