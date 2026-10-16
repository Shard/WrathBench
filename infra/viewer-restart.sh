#!/usr/bin/env bash
# Restart the operator viewer.
#
# The viewer is the `wrathbench-viewer` Deployment behind the cluster's Ingress,
# not a bun process on the workstation, so a restart is a rollout restart and
# the check that follows is the Ingress answering /api/info
# (WRATHBENCH_VIEWER_URL names it; it must be set).
#
#   ./infra/viewer-restart.sh            # rollout restart the viewer Deployment
#   ./infra/viewer-restart.sh --dry-run  # print the kubectl commands only
#
# On the cluster the viewer's code is baked into the runner image and Flux owns
# the tag, so this restarts a wedged process — it does not deploy anything. A
# viewer that should be serving NEW code needs a new image tag, which is
# infra/build-images.sh plus a cluster-repo bump. Outside a cluster the viewer
# is one process you start yourself (runner/viewer/README.md).
set -Eeuo pipefail

NAMESPACE="${WRATHBENCH_K8S_NAMESPACE:-wrathbench}"
RELEASE="${WRATHBENCH_K8S_RELEASE:-wrathbench}"
VIEWER_URL="${WRATHBENCH_VIEWER_URL:?set WRATHBENCH_VIEWER_URL to the viewer Ingress URL}"
DRY_RUN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --namespace|-n) NAMESPACE="${2:-}"; shift 2 ;;
    --release) RELEASE="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "viewer-restart: unknown argument $1" >&2; exit 2 ;;
  esac
done

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
