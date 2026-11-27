#!/usr/bin/env bash
#
# A viewer release: new code for the viewer, the publisher and the collector,
# with the fleet left running.
#
# WHY THIS EXISTS. A full release (k8s-release.sh) drains the fleet before it
# pins, because moving `image.tag` rolls the fleet pod and the worldserver, and
# a drain can wait hours on a scored run. A dashboard or viewer change needs
# none of that: the chart gives the viewer group its own tag
# (`image.viewerTag`), and this script moves only that value. Nothing here
# drains, sets the pause switch, opens a deploy window, smokes or resumes; the
# fleet pod, the run pods, the runner pod and the worldserver keep the tag
# they run.
#
#   check    always, and read-only: the fleet's tag A off the worldserver;
#            HEAD descends from A; A..HEAD touches nothing a viewer release
#            may not carry (below); the viewer runs the runner image
#   build    ./infra/build-images.sh --push --only runner at HEAD's tag B,
#            from the commit; skipped when B is A (the fleet's images exist)
#   pin      --viewer-pin-hook, or printed instructions; then WAIT until the
#            viewer, publisher and collector carry B and have rolled, and
#            fail loudly if the worldserver, runner or fleet moved off A
#
# WHAT A VIEWER RELEASE MAY NOT CARRY. The chart stays at the fleet's revision
# (the pin moves one value, never the chart source), and the viewer at B reads
# what the fleet at A writes and is read by A's tools. So a range that touches
# any of these is refused, and goes out as a full release instead:
#
#   infra/chart/                 a chart change does not deploy with one value;
#                                the viewer at B would run without it
#   collector/schema.sql         the collector at B applies its schema to the
#                                store `bun wb inspect` reads from the runner
#                                pod at A
#   runner/src/config-store.ts   the config store the fleet at A reads; the
#   runner/src/store-secrets.ts  viewer at B opens it too
#
# Everything else may ride, Dockerfiles, the lockfile and a wrath-mcp pointer
# bump included: the image is built whole at B, so it is self-consistent, and a
# newer reader of older records is the direction the viewer already keeps.
# Admin writes are held while the builds differ (viewer/write-hold.ts),
# and the harness stamp every pod carries stays A (the chart's `image.tag`).
#
# THE HOOK CONTRACT. `--viewer-pin-hook <command>` is run as
#
#     <command>                    with NO arguments, WRATHBENCH_VIEWER_TAG=B
#                                  and WRATHBENCH_FLEET_TAG=A in the
#                                  environment, and WRATHBENCH_TAG and
#                                  WRATHBENCH_SHA unset
#
# It sets `image.viewerTag` to WRATHBENCH_VIEWER_TAG and changes nothing else:
# not `image.tag`, not the chart's source revision. It returns once the pin is
# placed; this script waits for the cluster itself. It is a different flag from
# k8s-release.sh's `--pin-hook`, which this script refuses, and it is handed
# nothing a full-release hook reads (no argv, no WRATHBENCH_TAG or
# WRATHBENCH_SHA), so a full-release hook pointed here by mistake has no tag to
# pin the fleet to. If something pins the fleet anyway, the wait sees the
# worldserver, runner or fleet leave A and fails; that detects, it cannot undo.
#
# A full release keeps its own hook, which must also set `image.viewerTag` to
# its tag or clear it (k8s-release.sh, "THE HOOK CONTRACT").
#
#   ./infra/k8s-release-viewer.sh --dry-run
#   ./infra/k8s-release-viewer.sh --viewer-pin-hook ~/bin/place-viewer-pin
#   ./infra/k8s-release-viewer.sh --from pin --helmrelease <namespace>/<name>
#
# Flags: --from build|pin, --dry-run, --viewer-pin-hook <command>,
# --helmrelease <namespace/name> (an extra wait, after the tag poll), --tag
# <tag>, --registry <registry>, --pin-wait <seconds>, --namespace/-n,
# --release.

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# Overridable only so the tests can point it at a throwaway git repository.
REPO_ROOT="${WRATHBENCH_RELEASE_REPO_ROOT:-$(cd -- "${SCRIPT_DIR}/.." && pwd)}"

NAMESPACE="${WRATHBENCH_K8S_NAMESPACE:-wrathbench}"
RELEASE="${WRATHBENCH_K8S_RELEASE:-wrathbench}"
FROM="build"
DRY_RUN=0
VIEWER_PIN_HOOK=""
HELMRELEASE=""
TAG=""
REGISTRY=""
PIN_WAIT_S="${WRATHBENCH_RELEASE_PIN_WAIT_S:-1800}"
POLL_S="${WRATHBENCH_RELEASE_POLL_S:-15}"
ROLLOUT_WAIT_S="${WRATHBENCH_RELEASE_ROLLOUT_WAIT_S:-900}"

# Overridable only so the tests can point it at a stub.
BUILD_IMAGES="${WRATHBENCH_BUILD_IMAGES_CMD:-${SCRIPT_DIR}/build-images.sh}"

PHASES=(build pin)

# What a viewer release may not carry: the header says why.
REFUSED_PATHS=(
  "infra/chart/"
  "collector/schema.sql"
  "runner/src/config-store.ts"
  "runner/src/store-secrets.ts"
)

say() { echo "[$(date +%H:%M:%S)] k8s-release-viewer: $*"; }
die() { echo "[$(date +%H:%M:%S)] k8s-release-viewer: $*" >&2; exit 2; }
fail() { echo "[$(date +%H:%M:%S)] k8s-release-viewer: $*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --from) FROM="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --viewer-pin-hook) VIEWER_PIN_HOOK="${2:-}"; shift 2 ;;
    --pin-hook) die "--pin-hook is the full release's hook, which pins the fleet; a viewer release takes --viewer-pin-hook, a hook that sets image.viewerTag alone (infra/README.md, \"Releasing on Kubernetes\")" ;;
    --helmrelease) HELMRELEASE="${2:-}"; shift 2 ;;
    --tag) TAG="${2:-}"; shift 2 ;;
    --registry) REGISTRY="${2:-}"; shift 2 ;;
    --pin-wait) PIN_WAIT_S="${2:-}"; shift 2 ;;
    --namespace|-n) NAMESPACE="${2:-}"; shift 2 ;;
    --release) RELEASE="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,69p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument $1 (--from ${PHASES[*]}, --dry-run, --viewer-pin-hook, --helmrelease, --tag, --registry, --pin-wait, --namespace, --release)" ;;
  esac
done

FROM_INDEX=-1
for i in "${!PHASES[@]}"; do [[ "${PHASES[$i]}" == "${FROM}" ]] && FROM_INDEX="${i}"; done
[[ "${FROM_INDEX}" -ge 0 ]] || die "--from takes one of: ${PHASES[*]} (got $(printf %q "${FROM}"); the check always runs)"
[[ "${PIN_WAIT_S}" =~ ^[0-9]+$ ]] || die "--pin-wait takes whole seconds (got ${PIN_WAIT_S})"
[[ "${POLL_S}" =~ ^[0-9]+$ ]] || die "WRATHBENCH_RELEASE_POLL_S takes whole seconds"
[[ -z "${HELMRELEASE}" || "${HELMRELEASE}" == */* ]] || die "--helmrelease takes <namespace>/<name> (got ${HELMRELEASE})"

SELECTED=("${PHASES[@]:${FROM_INDEX}}")
wants_phase() { local p; for p in "${SELECTED[@]}"; do [[ "${p}" == "$1" ]] && return 0; done; return 1; }

command -v kubectl >/dev/null 2>&1 || die "kubectl is not on PATH"
command -v git >/dev/null 2>&1 || die "git is not on PATH (the tag is git describe of this tree)"

KUBECTL=(kubectl -n "${NAMESPACE}")
strip_ansi() { sed -e 's/\x1b\[[0-9;]*[A-Za-z]//g'; }
gitr() { git -C "${REPO_ROOT}" "$@"; }

# ------------------------------------------------------------------ the tag
tree_dirty() { ! { gitr diff --quiet && gitr diff --cached --quiet; }; }
[[ -n "${TAG}" ]] || TAG="$(gitr describe --tags --always 2>/dev/null || true)"
[[ -n "${TAG}" ]] || die "could not compute a tag from git (--tag names one)"
[[ "${TAG}" != "latest" ]] || die "'latest' is not an immutable tag and is refused (GitHub issue 7)"
[[ "${TAG}" != probe-* ]] || die "${TAG} is a probe image's tag (build-images.sh --probe); a probe image is pinned by a campaign arm and never released"
SHA="$(gitr rev-parse HEAD 2>/dev/null || true)"
[[ -n "${SHA}" ]] || die "could not read HEAD from ${REPO_ROOT}"

# ------------------------------------------------------------- cluster reads
# The viewer group, which this release moves, and the fleet side, which it must
# not. Only the tag after the last colon is compared.
VIEWER_DEPLOY="deployment/${RELEASE}-viewer"
VIEWER_GROUP=(
  "deployment/${RELEASE}-viewer"
  "deployment/${RELEASE}-publisher"
  "deployment/${RELEASE}-collector"
)
FLEET_SIDE=(
  "deployment/${RELEASE}-worldserver"
  "deployment/${RELEASE}-runner"
  "deployment/${RELEASE}-fleet"
)
WORLD_DEPLOY="deployment/${RELEASE}-worldserver"
RUNNER_DEPLOY="deployment/${RELEASE}-runner"

images_of() {
  "${KUBECTL[@]}" get "$1" -o jsonpath='{.spec.template.spec.containers[*].image}' 2>/dev/null | strip_ansi | tr -d '\r' || true
}
exists() { "${KUBECTL[@]}" get "$1" -o name >/dev/null 2>&1; }
carries_tag() {
  local ref last
  for ref in $(images_of "$1"); do
    last="${ref##*/}"
    [[ "${last}" == *:* ]] || continue
    [[ "${ref##*:}" == "$2" ]] && return 0
  done
  return 1
}
tags_of() {
  local ref out=() last
  for ref in $(images_of "$1"); do
    last="${ref##*/}"
    if [[ "${last}" == *:* ]]; then out+=("${ref##*:}"); else out+=("untagged"); fi
  done
  if [[ "${#out[@]}" -eq 0 ]]; then printf 'not found'; else printf '%s' "${out[*]}"; fi
}
# The first container's image without its tag: which image a Deployment runs.
repo_of() {
  local ref
  ref="$(images_of "$1" | awk '{print $1}')"
  [[ -n "${ref}" ]] || return 1
  if [[ "${ref##*/}" == *:* ]]; then printf '%s' "${ref%:*}"; else printf '%s' "${ref}"; fi
}

# ----------------------------------------------------------------- the check
# Always run, --from or not: it is read-only, and the pin's own assertion needs
# the fleet's tag it reads.
FLEET_TAG=""
FLEET_SHA=""
check() {
  say "=== check: what the fleet runs, and what lies between it and ${TAG}"
  exists "${WORLD_DEPLOY}" || die "${WORLD_DEPLOY} is not installed, so the fleet's tag cannot be read; a deployment with no fleet takes a full release (bun wb release run), which has no runs to drain"
  exists "${VIEWER_DEPLOY}" || die "${VIEWER_DEPLOY} is not installed: there is no viewer to release"
  # The worldserver image's tag, as k8s-deploy.sh's cluster_tag reads it: the
  # container whose image is the worldserver's, never a sidecar.
  local ref t=""
  for ref in $(images_of "${WORLD_DEPLOY}"); do
    [[ "${ref##*/}" == *worldserver:* ]] && { t="${ref##*:}"; break; }
  done
  [[ -n "${t}" ]] || die "the fleet's tag did not read back from ${WORLD_DEPLOY} (images: $(images_of "${WORLD_DEPLOY}")); nothing was done"
  FLEET_TAG="${t}"
  say "  the fleet runs ${FLEET_TAG} (${WORLD_DEPLOY})"
  # One tag across the fleet side, or a release is in flight and A is not one thing.
  local d
  for d in "${FLEET_SIDE[@]}"; do
    exists "${d}" || continue
    carries_tag "${d}" "${FLEET_TAG}" || die "${d} is on $(tags_of "${d}"), the worldserver on ${FLEET_TAG}: the fleet is not on one tag (a release in flight?). Let it finish, then re-run"
  done
  FLEET_SHA="$(gitr rev-parse --verify --quiet "${FLEET_TAG}^{commit}" 2>/dev/null || true)"
  [[ -n "${FLEET_SHA}" ]] || die "the fleet's tag ${FLEET_TAG} names no commit in this checkout; git fetch origin, then re-run"
  if ! gitr merge-base --is-ancestor "${FLEET_SHA}" "${SHA}"; then
    die "HEAD (${TAG}) does not descend from the fleet's ${FLEET_TAG}. A viewer older than the fleet, or beside it, would read records newer than its code; release from a checkout that contains ${FLEET_TAG}"
  fi
  local touched
  touched="$(gitr diff --name-only "${FLEET_SHA}" "${SHA}" -- "${REFUSED_PATHS[@]}")"
  if [[ -n "${touched}" ]]; then
    {
      echo "[$(date +%H:%M:%S)] k8s-release-viewer: ${FLEET_TAG}..${TAG} touches what a viewer release may not carry:"
      printf '    %s\n' ${touched}
      echo "  The chart stays at the fleet's revision, and the config store and the collector's schema are shared with the fleet at ${FLEET_TAG}."
      echo "  This range goes out as a full release: bun wb release run (docs/RUNBOOK.md, \"Deploy window\")."
    } >&2
    exit 2
  fi
  say "  ${FLEET_TAG}..${TAG}: nothing under ${REFUSED_PATHS[*]}"
  # The build makes the runner image only. A viewer on the slim image
  # (`image.names.viewer`) would be pinned to a tag nobody built.
  local vr rr
  if vr="$(repo_of "${VIEWER_DEPLOY}")" && rr="$(repo_of "${RUNNER_DEPLOY}")" && [[ "${vr}" != "${rr}" ]]; then
    die "the viewer runs ${vr}, not the runner image ${rr}: a viewer release builds the runner image only, so this deployment takes a full release"
  fi
}

check

# ----------------------------------------------------------------- the plan
say "viewer release ${TAG} (commit ${SHA}) over the fleet's ${FLEET_TAG}"
say "  namespace   ${NAMESPACE} (release ${RELEASE})"
say "  phases      check ${SELECTED[*]}$(if [[ "${FROM}" != "build" ]]; then echo "  (--from ${FROM}; ${PHASES[*]:0:${FROM_INDEX}} skipped)"; fi)"
say "  moves       image.viewerTag = ${TAG}: ${VIEWER_GROUP[*]}"
say "  untouched   ${FLEET_SIDE[*]} stay on ${FLEET_TAG}; no drain, no pause switch, no deploy window, no smokes"
say "  pin         $(if [[ -n "${VIEWER_PIN_HOOK}" ]]; then echo "hook: ${VIEWER_PIN_HOOK} (WRATHBENCH_VIEWER_TAG=${TAG})"; else echo "no --viewer-pin-hook: printed instructions, then the same wait"; fi)"

if [[ "${DRY_RUN}" -eq 1 ]]; then
  say "--dry-run: the plan only. Nothing is built, pushed or pinned."
  for d in "${VIEWER_GROUP[@]}" "${FLEET_SIDE[@]}"; do
    say "  cluster now ${d}: $(if exists "${d}"; then tags_of "${d}"; else echo "not installed"; fi)"
  done
  if wants_phase build; then
    if [[ "${TAG}" == "${FLEET_TAG}" ]]; then
      say "  skip build   ${TAG} is the fleet's tag: its images exist, and this puts the viewer group back on them"
    else
      say "  would build  ${BUILD_IMAGES} --push --only runner --tag ${TAG} --commit ${SHA}$(if [[ -n "${REGISTRY}" ]]; then echo " --registry ${REGISTRY}"; fi)  (refusing a dirty tree)"
    fi
  fi
  if wants_phase pin; then
    if [[ -n "${VIEWER_PIN_HOOK}" ]]; then
      say "  would pin    ${VIEWER_PIN_HOOK}, no arguments, WRATHBENCH_VIEWER_TAG=${TAG} WRATHBENCH_FLEET_TAG=${FLEET_TAG}, then poll"
    else
      say "  would pin    print image.viewerTag=${TAG}, then poll"
    fi
    say "  would wait   up to ${PIN_WAIT_S}s for the viewer group to carry ${TAG}, then rollout status on each installed one"
    [[ -n "${HELMRELEASE}" ]] && say "                 and kubectl wait --for=condition=Ready helmrelease/${HELMRELEASE#*/} in ${HELMRELEASE%/*}"
    say "  would assert ${FLEET_SIDE[*]} still carry ${FLEET_TAG}"
  fi
  exit 0
fi

# ---------------------------------------------------------------- 1. build
phase_build() {
  if [[ "${TAG}" == "${FLEET_TAG}" ]]; then
    say "=== build: skipped. ${TAG} is the fleet's tag, so its images exist and are never pushed over; this puts the viewer group back on them"
    return 0
  fi
  say "=== build: ${BUILD_IMAGES} --push --only runner at ${TAG}"
  if tree_dirty; then
    fail "the working tree has uncommitted changes. The image is built from commit ${SHA}, so those changes would not be in ${TAG}. Commit, then re-run."
  fi
  local args=(--push --only runner --tag "${TAG}" --commit "${SHA}")
  [[ -n "${REGISTRY}" ]] && args+=(--registry "${REGISTRY}")
  "${BUILD_IMAGES}" "${args[@]}"
  say "built and pushed the runner image at ${TAG}"
}

# ------------------------------------------------------------------ 2. pin
installed_group() { local d; for d in "${VIEWER_GROUP[@]}"; do exists "${d}" && echo "${d}"; done; }
group_pinned() {
  local d
  for d in $(installed_group); do carries_tag "${d}" "${TAG}" || return 1; done
  return 0
}
# The fleet side, still on A; prints the first one that is not.
fleet_moved() {
  local d
  for d in "${FLEET_SIDE[@]}"; do
    exists "${d}" || continue
    carries_tag "${d}" "${FLEET_TAG}" || { printf '%s' "${d}"; return 0; }
  done
  return 1
}
fleet_moved_fail() {
  fail "$1 is on $(tags_of "$1"), not the fleet's ${FLEET_TAG}: the pin moved more than image.viewerTag. The fleet may be rolling with live runs on it. Check what the viewer pin hook changed (it sets image.viewerTag alone, never image.tag or the chart's revision) and put the fleet's pin back."
}

print_pin_instructions() {
  say "no --viewer-pin-hook, so the pin is yours to place. Set ONE value:"
  say "    image.viewerTag = ${TAG}"
  say "  and nothing else: image.tag stays ${FLEET_TAG}, and the chart's source revision"
  say "  stays where it is. Point --viewer-pin-hook at whatever does this for you."
  say "Waiting for the viewer group to carry ${TAG} — place the pin and this continues on its own."
}

run_pin_hook() {
  say "viewer pin hook: ${VIEWER_PIN_HOOK} (WRATHBENCH_VIEWER_TAG=${TAG})"
  # No argv, and none of the full release's variables: a full-release hook run
  # here by mistake has no tag and no commit to pin the fleet to.
  if ! env -u WRATHBENCH_TAG -u WRATHBENCH_SHA \
       WRATHBENCH_VIEWER_TAG="${TAG}" WRATHBENCH_FLEET_TAG="${FLEET_TAG}" \
       bash -c "${VIEWER_PIN_HOOK}"; then
    fail "the viewer pin hook exited non-zero. Nothing was deployed and the fleet was never touched. Fix the pin, then: ./infra/k8s-release-viewer.sh --from pin"
  fi
  say "viewer pin hook returned; now waiting for the viewer group to carry ${TAG}"
}

wait_for_tag() {
  local deadline d moved
  deadline=$(( $(date +%s) + PIN_WAIT_S ))
  while :; do
    if moved="$(fleet_moved)"; then fleet_moved_fail "${moved}"; fi
    if group_pinned; then
      say "the viewer group carries ${TAG}: $(for d in $(installed_group); do printf '%s=%s ' "${d##*/}" "$(tags_of "${d}")"; done)"
      return 0
    fi
    if (( $(date +%s) >= deadline )); then
      for d in $(installed_group); do say "  ${d}: $(tags_of "${d}")"; done
      fail "the viewer group still does not carry ${TAG} after ${PIN_WAIT_S}s. Nothing else was touched. When the pin lands: ./infra/k8s-release-viewer.sh --from pin"
    fi
    for d in $(installed_group); do
      carries_tag "${d}" "${TAG}" || say "  waiting: ${d} is on $(tags_of "${d}"), not ${TAG}"
    done
    sleep "${POLL_S}"
  done
}

wait_for_rollouts() {
  local d
  for d in "${VIEWER_GROUP[@]}"; do
    if ! exists "${d}"; then
      say "  ${d} is not installed — skipped"
      continue
    fi
    say "  rollout status ${d} (up to ${ROLLOUT_WAIT_S}s)"
    "${KUBECTL[@]}" rollout status "${d}" --timeout="${ROLLOUT_WAIT_S}s" \
      || fail "${d} did not finish rolling out on ${TAG}. The fleet was not touched; revert image.viewerTag to put the viewer group back."
  done
  if [[ -n "${HELMRELEASE}" ]]; then
    # After the tag poll, never instead of it: a HelmRelease is still Ready on
    # the previous revision. Ready here also means the post-upgrade hook Jobs
    # finished (templates/jobs.yaml says why they run on a viewer pin).
    say "  kubectl -n ${HELMRELEASE%/*} wait --for=condition=Ready helmrelease/${HELMRELEASE#*/}"
    kubectl -n "${HELMRELEASE%/*}" wait --for=condition=Ready --timeout="${ROLLOUT_WAIT_S}s" \
      "helmrelease/${HELMRELEASE#*/}" \
      || fail "helmrelease ${HELMRELEASE} is not Ready. The viewer group carries ${TAG}, but the upgrade (its hook Jobs included) has not settled."
  fi
}

phase_pin() {
  say "=== pin: image.viewerTag = ${TAG}"
  if group_pinned; then
    say "the viewer group ALREADY carries ${TAG} — skipping the pin step itself (a hook is not run twice)"
  elif [[ -n "${VIEWER_PIN_HOOK}" ]]; then
    run_pin_hook
  else
    print_pin_instructions
  fi
  wait_for_tag
  wait_for_rollouts
  local moved
  if moved="$(fleet_moved)"; then fleet_moved_fail "${moved}"; fi
  say "  ${FLEET_SIDE[*]}: still ${FLEET_TAG}"
  say "pinned and rolled: the viewer group on ${TAG}, the fleet on ${FLEET_TAG}"
}

RAN_PHASES=()
for phase in "${SELECTED[@]}"; do
  "phase_${phase}"
  RAN_PHASES+=("${phase}")
done

say "VIEWER RELEASED ${TAG} (${SHA}) over the fleet's ${FLEET_TAG}. Phases run: check ${RAN_PHASES[*]}."
if [[ "${TAG}" != "${FLEET_TAG}" ]]; then
  say "Admin writes are held until a full release brings the fleet to this build; \`bun wb config\` in the runner pod still writes."
fi
