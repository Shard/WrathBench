#!/usr/bin/env bash
#
# Build the worldserver image to the deploy script's :next tag, stamped with
# this checkout's build identity.
#
#   ./infra/build-worldserver.sh                   # -> wrathbench/worldserver:next
#   ./infra/build-worldserver.sh --tag wrathbench/worldserver:mybuild
#
# WRATHBENCH_BUILD (the `build` field every /health caller sees) is the repo's
# `git describe --tags --always --dirty`, computed HERE because the docker build
# context carries no .git. The compose build path honours the same variable
# from the environment, so `WRATHBENCH_BUILD=... docker compose build
# worldserver` stamps too; a bare `docker compose build` yields "unknown".
# Then: ./infra/deploy-worldserver.sh

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
TAG=wrathbench/worldserver:next

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag) TAG="$2"; shift 2 ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "build-worldserver: unknown flag $1" >&2; exit 2 ;;
  esac
done

cd "${REPO_ROOT}"
BUILD="$(git describe --tags --always --dirty 2>/dev/null || echo unknown)"
echo "build-worldserver: stamping WRATHBENCH_BUILD=${BUILD} -> ${TAG}"
docker build \
  --target worldserver \
  --build-arg "WRATHBENCH_BUILD=${BUILD}" \
  --build-arg "USER_ID=${WRATHBENCH_UID:-1000}" \
  --build-arg "GROUP_ID=${WRATHBENCH_GID:-1000}" \
  -t "${TAG}" -f infra/docker/server.Dockerfile .
echo "build-worldserver: ${TAG} = $(docker image inspect -f '{{.Id}}' "${TAG}" | cut -c8-19) (build ${BUILD})"
