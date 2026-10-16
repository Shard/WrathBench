#!/usr/bin/env bash
#
# Build every WrathBench image at one immutable tag and, optionally, push it.
#
#   ./infra/build-images.sh                      # build all four, local tags
#   ./infra/build-images.sh --push               # ... and push them
#   ./infra/build-images.sh --registry registry.example/wrathbench
#   ./infra/build-images.sh --tag v0.6.0         # override the computed tag
#   ./infra/build-images.sh --only runner        # one image (repeatable)
#   ./infra/build-images.sh --commit <sha> --tag <tag>   # a named commit (k8s-release.sh)
#
# The tag is `git describe --tags --always` of the working tree, and the tree
# must be clean: on Kubernetes the tag IS the pin (GitHub issue 7 — no `latest`,
# no branch tag, no mutable default may become the deployment source), and a
# tag built from uncommitted work is a pin that points at nothing. Since the
# images are built from the commit (below), uncommitted edits would simply be
# left out of them, which is the other reason a dirty tree is refused.
# --allow-dirty builds the commit anyway: the edits are NOT in the images, the
# tag carries `-dirty`, and a `-dirty` tag is never pushed.
#
# Every image is built from a `git archive` of the commit, unpacked into a
# temporary directory, never from the working tree, so an untracked or ignored
# file in the checkout cannot reach an image whatever the ignore files say. The
# server images also need AzerothCore, a submodule and so not in that archive:
# it is exported the same way from the submodule commit the commit pins, and
# only the paths server.Dockerfile copies (AC_PATHS below). Each image is then
# scanned by infra/image-guard.sh before anything is pushed; one it refuses is
# untagged and stops the run.
#
# The same tag becomes:
#   - the four image tags,
#   - `image.tag` in the chart's values (infra/chart/wrathbench),
#   - WRATHBENCH_BUILD on the worldserver (the module's /health `build` field),
#   - WRATHBENCH_BUILD_VERSION in the runner image and, via the chart,
#     WRATHBENCH_HARNESS_VERSION on every trajectory it produces.
# One string, so the deployed revision, the server identity and the harness
# stamp on a run all agree and are reviewable.

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# The repository whose commit is built. Overridable only so the tests can point
# it at a throwaway one.
REPO_ROOT="${WRATHBENCH_BUILD_REPO_ROOT:-$(cd -- "${SCRIPT_DIR}/.." && pwd)}"
IMAGE_GUARD="${SCRIPT_DIR}/image-guard.sh"

REGISTRY="${WRATHBENCH_REGISTRY:-harbor.local/wrathbench}"
TAG=""
COMMIT=""
PUSH=0
ALLOW_DIRTY=0
ONLY=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --registry) REGISTRY="$2"; shift 2 ;;
    --tag) TAG="$2"; shift 2 ;;
    --commit) COMMIT="$2"; shift 2 ;;
    --only) ONLY+=("$2"); shift 2 ;;
    --push) PUSH=1; shift ;;
    --allow-dirty) ALLOW_DIRTY=1; shift ;;
    -h|--help) sed -n '2,37p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "build-images: unknown flag $1" >&2; exit 2 ;;
  esac
done

cd "${REPO_ROOT}"

say() { echo "[$(date +%H:%M:%S)] build-images: $*"; }
die() { echo "[$(date +%H:%M:%S)] build-images: $*" >&2; exit 1; }

# The commit every image is built from: HEAD, or --commit. k8s-release.sh
# passes the commit its tag describes, so a commit landing in the checkout
# mid-release cannot change what that tag's images contain. The computed tag
# describes HEAD, so another commit needs its own --tag.
SHA="$(git rev-parse --verify --quiet "${COMMIT:-HEAD}^{commit}")" || die "${COMMIT:-HEAD} does not name a commit"
if [[ -n "${COMMIT}" && -z "${TAG}" && "${SHA}" != "$(git rev-parse HEAD)" ]]; then
  die "--commit ${COMMIT} is not HEAD and the computed tag would describe HEAD; pass --tag as well"
fi

# Tracked changes only. An untracked scratch file is not part of the tree the
# tag names, and `git describe --dirty` agrees — it is what makes the tag
# reproducible from the SHA.
tree_dirty() { ! { git diff --quiet && git diff --cached --quiet; }; }

if tree_dirty; then
  if [[ "${ALLOW_DIRTY}" -eq 0 ]]; then
    die "the working tree has uncommitted changes; commit them or pass --allow-dirty (a dirty tag must never be deployed)"
  fi
  say "WARNING: --allow-dirty — the uncommitted changes are NOT in these images (they are built from ${SHA}); the -dirty tag is never pushed"
fi

if [[ -z "${TAG}" ]]; then
  TAG="$(git describe --tags --always $(tree_dirty && echo --dirty) 2>/dev/null || echo unknown)"
fi
[[ "${TAG}" != "unknown" && -n "${TAG}" ]] || die "could not compute a tag from git"
[[ "${TAG}" != "latest" ]] || die "'latest' is not an immutable tag and is refused (GitHub issue 7)"

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
wants_server() { wants wrathbench-worldserver || wants wrathbench-authserver || wants wrathbench-db-import; }

# ------------------------------------------------------------- the context
#
# The build context is the commit, exported, never the working tree. Both
# `-f` paths point INSIDE the export too: BuildKit reads the ignore file beside
# the Dockerfile it is given, so a working-tree `-f` would pick up an
# uncommitted ignore file.
CONTEXT="$(mktemp -d "${TMPDIR:-/tmp}/wrathbench-build.XXXXXX")"
trap 'rm -rf "${CONTEXT}"' EXIT
say "exporting ${SHA} (git archive, tracked files only) to ${CONTEXT}"
git archive --format=tar "${SHA}" | tar -xf - -C "${CONTEXT}"

# What the server images take from AzerothCore: exactly the deps/azerothcore
# sources server.Dockerfile COPYs (infra/build-images.test.ts holds the two
# lists together). Upstream tracks far more than this, its own agent settings
# among it, and none of that has any business in a build context.
AC_PATHS=(CMakeLists.txt conf deps src modules apps/docker/entrypoint.sh data)

# The submodule's tree is not in the superproject's archive, so it is exported
# from the submodule's own repository, at the commit ${SHA} pins (never the
# submodule checkout's HEAD, which can be anywhere). An uninitialised
# deps/azerothcore is an empty directory inside the superproject, where
# `git -C` would quietly find the wrong repository, hence the toplevel check.
export_azerothcore() {
  local sub="${REPO_ROOT}/deps/azerothcore" mode type ac_sha rest real top
  read -r mode type ac_sha rest <<< "$(git ls-tree "${SHA}" deps/azerothcore)"
  [[ "${mode:-}" == "160000" && "${type:-}" == "commit" ]] || die "${SHA} pins no deps/azerothcore submodule"
  real="$(cd "${sub}" 2>/dev/null && pwd -P || true)"
  top="$(git -C "${sub}" rev-parse --show-toplevel 2>/dev/null || true)"
  if [[ -z "${real}" || "${top}" != "${real}" ]] || ! git -C "${sub}" cat-file -e "${ac_sha}^{commit}" 2>/dev/null; then
    die "AzerothCore ${ac_sha} (the submodule commit ${SHA} pins) is not available in deps/azerothcore; run: git submodule update --init deps/azerothcore"
  fi
  say "exporting AzerothCore ${ac_sha} (${AC_PATHS[*]}) to deps/azerothcore/"
  git -C "${sub}" archive --format=tar --prefix=deps/azerothcore/ "${ac_sha}" -- "${AC_PATHS[@]}" | tar -xf - -C "${CONTEXT}"
}
if wants_server; then export_azerothcore; fi

# Every image is scanned before anything is pushed (infra/image-guard.sh). A
# refused image loses its tag here, so it cannot be pushed by hand either.
guard() {
  if ! "${IMAGE_GUARD}" "$1"; then
    docker image rm "$1" >/dev/null 2>&1 || true
    die "image-guard refused $1; its tag is removed and nothing was pushed"
  fi
}

BUILT=()

# The three AzerothCore targets share one `build` stage, so after the first the
# others are assembly only. The ccache cache mount lives in the Dockerfile
# (infra/docker/server.Dockerfile), shared with compose builds on the same daemon.
build_server_target() {
  local target="$1" name="$2" ref="${REGISTRY}/$2:${TAG}"
  wants "${name}" || return 0
  say "building ${ref} (server.Dockerfile target ${target})"
  docker build \
    --target "${target}" \
    --build-arg "WRATHBENCH_BUILD=${TAG}" \
    --build-arg "USER_ID=${WRATHBENCH_UID:-1000}" \
    --build-arg "GROUP_ID=${WRATHBENCH_GID:-1000}" \
    -t "${ref}" -f "${CONTEXT}/infra/docker/server.Dockerfile" "${CONTEXT}"
  guard "${ref}"
  BUILT+=("${ref}")
}

build_runner() {
  local ref="${REGISTRY}/wrathbench-runner:${TAG}"
  wants "wrathbench-runner" || return 0
  say "building ${ref} (runner.Dockerfile, repo baked in)"
  docker build \
    --build-arg "WRATHBENCH_BUILD_VERSION=${TAG}" \
    -t "${ref}" -f "${CONTEXT}/infra/docker/runner.Dockerfile" "${CONTEXT}"
  guard "${ref}"
  BUILT+=("${ref}")
}

build_server_target worldserver wrathbench-worldserver
build_server_target authserver  wrathbench-authserver
build_server_target db-import   wrathbench-db-import
build_runner

[[ "${#BUILT[@]}" -gt 0 ]] || die "--only ${ONLY[*]} matched no image; names are worldserver, authserver, db-import, runner"

say "built, and passed the image guard:"
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
