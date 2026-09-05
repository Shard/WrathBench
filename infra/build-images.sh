#!/usr/bin/env bash
#
# Build every WrathBench image at one immutable tag and, optionally, push it.
#
#   ./infra/build-images.sh                      # build all four, local tags
#   ./infra/build-images.sh --push               # ... and push them
#   ./infra/build-images.sh --registry harbor.local/library
#   ./infra/build-images.sh --tag v0.6.0         # override the computed tag
#   ./infra/build-images.sh --only runner        # one image (repeatable)
#
# The tag is `git describe --tags --always` of the working tree, and the tree
# must be clean: on Kubernetes the tag IS the pin (GitHub issue 7 — no `latest`,
# no branch tag, no mutable default may become the deployment source), and a
# tag built from uncommitted work is a pin that points at nothing. --allow-dirty
# is the escape hatch for local experiments and appends `-dirty`, which Flux
# should never be pointed at.
#
# The same tag becomes:
#   - the four image tags,
#   - `image.tag` in the chart's values (infra/chart/wrathbench),
#   - WRATHBENCH_BUILD on the worldserver (the module's /health `build` field),
#   - WRATHBENCH_BUILD_VERSION in the runner image and, via the chart,
#     WRATHBENCH_HARNESS_VERSION on every trajectory it produces.
# One string, so the deployed revision, the server identity and the harness
# stamp on a run all agree and are reviewable.
#
# Related: infra/build-worldserver.sh builds the worldserver alone to the
# compose deploy script's `:next` tag and stays the tool for that flow.

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

REGISTRY="${WRATHBENCH_REGISTRY:-harbor.local/library}"
TAG=""
PUSH=0
ALLOW_DIRTY=0
ONLY=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --registry) REGISTRY="$2"; shift 2 ;;
    --tag) TAG="$2"; shift 2 ;;
    --only) ONLY+=("$2"); shift 2 ;;
    --push) PUSH=1; shift ;;
    --allow-dirty) ALLOW_DIRTY=1; shift ;;
    -h|--help) sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "build-images: unknown flag $1" >&2; exit 2 ;;
  esac
done

cd "${REPO_ROOT}"

say() { echo "[$(date +%H:%M:%S)] build-images: $*"; }
die() { echo "[$(date +%H:%M:%S)] build-images: $*" >&2; exit 1; }

# Tracked changes only. An untracked scratch file is not part of the tree the
# tag names, and `git describe --dirty` agrees — it is what makes the tag
# reproducible from the SHA.
tree_dirty() { ! { git diff --quiet && git diff --cached --quiet; }; }

if tree_dirty; then
  if [[ "${ALLOW_DIRTY}" -eq 0 ]]; then
    die "the working tree has uncommitted changes; commit them or pass --allow-dirty (a dirty tag must never be deployed)"
  fi
  say "WARNING: --allow-dirty — this tag is not reproducible from any commit and must not be deployed"
fi

if [[ -z "${TAG}" ]]; then
  TAG="$(git describe --tags --always $(tree_dirty && echo --dirty) 2>/dev/null || echo unknown)"
fi
[[ "${TAG}" != "unknown" && -n "${TAG}" ]] || die "could not compute a tag from git"
[[ "${TAG}" != "latest" ]] || die "'latest' is not an immutable tag and is refused (GitHub issue 7)"

SHA="$(git rev-parse HEAD)"
say "tag ${TAG} (source ${SHA}) -> ${REGISTRY}/<name>:${TAG}"

# --only takes either spelling: `worldserver` or `wrathbench-worldserver`.
# The short one is what an operator types; the long one is the image name.
wants() {
  [[ "${#ONLY[@]}" -eq 0 ]] && return 0
  local w short="${1#wrathbench-}"
  for w in "${ONLY[@]}"; do
    [[ "${w}" == "$1" || "${w#wrathbench-}" == "${short}" ]] && return 0
  done
  return 1
}

BUILT=()

# The three AzerothCore targets share one `build` stage, so after the first the
# others are assembly only. The ccache cache mount lives in the Dockerfile
# (infra/docker/server.Dockerfile), the same one build-worldserver.sh warms.
build_server_target() {
  local target="$1" name="$2" ref="${REGISTRY}/$2:${TAG}"
  wants "${name}" || return 0
  say "building ${ref} (server.Dockerfile target ${target})"
  docker build \
    --target "${target}" \
    --build-arg "WRATHBENCH_BUILD=${TAG}" \
    --build-arg "USER_ID=${WRATHBENCH_UID:-1000}" \
    --build-arg "GROUP_ID=${WRATHBENCH_GID:-1000}" \
    -t "${ref}" -f infra/docker/server.Dockerfile .
  BUILT+=("${ref}")
}

build_runner() {
  local ref="${REGISTRY}/wrathbench-runner:${TAG}"
  wants "wrathbench-runner" || return 0
  say "building ${ref} (runner.Dockerfile, repo baked in)"
  docker build \
    --build-arg "WRATHBENCH_BUILD_VERSION=${TAG}" \
    -t "${ref}" -f infra/docker/runner.Dockerfile .
  BUILT+=("${ref}")
}

build_server_target worldserver wrathbench-worldserver
build_server_target authserver  wrathbench-authserver
build_server_target db-import   wrathbench-db-import
build_runner

[[ "${#BUILT[@]}" -gt 0 ]] || die "--only ${ONLY[*]} matched no image; names are worldserver, authserver, db-import, runner"

say "built:"
for ref in "${BUILT[@]}"; do
  printf '  %-52s %s  %s\n' "${ref}" \
    "$(docker image inspect -f '{{.Id}}' "${ref}" | cut -c8-19)" \
    "$(docker image inspect -f '{{.Size}}' "${ref}" | awk '{printf "%.2f GB", $1/1073741824}')"
done

if [[ "${PUSH}" -eq 1 ]]; then
  if tree_dirty && [[ "${ALLOW_DIRTY}" -eq 1 ]]; then
    die "refusing to push a --allow-dirty tag"
  fi
  for ref in "${BUILT[@]}"; do
    say "pushing ${ref}"
    docker push "${ref}"
  done
  say "pushed ${#BUILT[@]} image(s) at ${TAG}; set image.tag=${TAG} in the cluster repo"
else
  say "not pushed (--push to push). image.tag for the chart: ${TAG}"
fi
