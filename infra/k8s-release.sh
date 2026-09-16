#!/usr/bin/env bash
#
# One command for a release: build and push the images, drain the fleet, get the
# pin in front of the cluster, run the smoke-gated deploy window, put the fleet
# back to work.
#
# WHY THIS EXISTS. The scripted ends of a release have worked for a while; what
# went wrong on 2026-09-16 was the hand-driven middle — the pin, the wait for it
# to actually reach the cluster, and a pause switch nobody cleared. A chain of
# shell joined with `;` ran the deploy window against an image that had never
# changed. So the middle is scripted too, and the one part of it that is not the
# same anywhere — HOW a pin is placed — is a hook.
#
#   build    ./infra/build-images.sh --push, on a clean tree
#   drain    ./infra/fleet-update.sh drain — the pause switch stays set
#   pin      --pin-hook, or printed instructions; then WAIT until the cluster
#            actually carries this tree's tag and every rollout is complete
#   deploy   ./infra/k8s-deploy.sh — the smokes, then the fleet comes back
#   resume   ./infra/fleet-update.sh resume — the switch, cleared
#
# THE HOOK CONTRACT. `--pin-hook <command>` is run as
#
#     <command> <tag> <sha>        with WRATHBENCH_TAG and WRATHBENCH_SHA
#                                  in the environment
#
# and is expected to RETURN once the pin has been placed — merged, applied,
# committed, whatever your GitOps repo means by that. It does NOT have to wait
# for the cluster to catch up: this script does that itself, by reading what the
# cluster runs, which is the check that a hook cannot get wrong. A hook that
# exits non-zero stops the release before the deploy window opens.
#
# With no hook the `pin` phase prints the tag, the commit and where the chart
# expects them, and then polls for the same thing. Place the pin by hand and it
# continues on its own.
#
# EVERY PHASE IS IDEMPOTENT and `--from <phase>` restarts at one: a release that
# died waiting for a pin is `--from pin`, and when the cluster already carries
# the tag the hook is skipped rather than run twice.
#
#   ./infra/k8s-release.sh --dry-run
#   ./infra/k8s-release.sh --pin-hook ~/bin/place-wrathbench-pin
#   ./infra/k8s-release.sh --from pin --helmrelease <namespace>/<name>
#
# Flags: --from <phase>, --dry-run, --pin-hook <command>,
# --helmrelease <namespace/name> (an extra wait target, skipped when absent —
# nothing here assumes a Flux namespace, or Flux at all), --tag <tag>,
# --registry <registry>, --no-smoke (passed to the deploy window),
# --pin-wait <seconds>, --namespace/-n, --release.

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# The tree whose tag this release IS. Overridable only so the tests can point it
# at a throwaway git repository and exercise the dirty-tree refusal without
# dirtying this one.
REPO_ROOT="${WRATHBENCH_RELEASE_REPO_ROOT:-$(cd -- "${SCRIPT_DIR}/.." && pwd)}"

NAMESPACE="${WRATHBENCH_K8S_NAMESPACE:-wrathbench}"
RELEASE="${WRATHBENCH_K8S_RELEASE:-wrathbench}"
FROM="build"
DRY_RUN=0
PIN_HOOK=""
HELMRELEASE=""
TAG=""
REGISTRY=""
NO_SMOKE=0
PIN_WAIT_S="${WRATHBENCH_RELEASE_PIN_WAIT_S:-1800}"
POLL_S="${WRATHBENCH_RELEASE_POLL_S:-15}"
ROLLOUT_WAIT_S="${WRATHBENCH_RELEASE_ROLLOUT_WAIT_S:-900}"

# The siblings this script drives. Overridable only so the tests can point them
# at stubs: a release script calls the scripts next to it, never whatever is on
# PATH under the same name.
BUILD_IMAGES="${WRATHBENCH_BUILD_IMAGES_CMD:-${SCRIPT_DIR}/build-images.sh}"
FLEET_UPDATE="${WRATHBENCH_FLEET_UPDATE_CMD:-${SCRIPT_DIR}/fleet-update.sh}"
K8S_DEPLOY="${WRATHBENCH_K8S_DEPLOY_CMD:-${SCRIPT_DIR}/k8s-deploy.sh}"

PHASES=(build drain pin deploy resume)

say() { echo "[$(date +%H:%M:%S)] k8s-release: $*"; }
die() { echo "[$(date +%H:%M:%S)] k8s-release: $*" >&2; exit 2; }
fail() { echo "[$(date +%H:%M:%S)] k8s-release: $*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --from) FROM="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --pin-hook) PIN_HOOK="${2:-}"; shift 2 ;;
    --helmrelease) HELMRELEASE="${2:-}"; shift 2 ;;
    --tag) TAG="${2:-}"; shift 2 ;;
    --registry) REGISTRY="${2:-}"; shift 2 ;;
    --no-smoke) NO_SMOKE=1; shift ;;
    --pin-wait) PIN_WAIT_S="${2:-}"; shift 2 ;;
    --namespace|-n) NAMESPACE="${2:-}"; shift 2 ;;
    --release) RELEASE="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,48p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument $1 (--from ${PHASES[*]}, --dry-run, --pin-hook, --helmrelease, --tag, --registry, --no-smoke, --pin-wait, --namespace, --release)" ;;
  esac
done

FROM_INDEX=-1
for i in "${!PHASES[@]}"; do [[ "${PHASES[$i]}" == "${FROM}" ]] && FROM_INDEX="${i}"; done
[[ "${FROM_INDEX}" -ge 0 ]] || die "--from takes one of: ${PHASES[*]} (got $(printf %q "${FROM}"))"
[[ "${PIN_WAIT_S}" =~ ^[0-9]+$ ]] || die "--pin-wait takes whole seconds (got ${PIN_WAIT_S})"
[[ "${POLL_S}" =~ ^[0-9]+$ ]] || die "WRATHBENCH_RELEASE_POLL_S takes whole seconds"
[[ -z "${HELMRELEASE}" || "${HELMRELEASE}" == */* ]] || die "--helmrelease takes <namespace>/<name> (got ${HELMRELEASE})"

SELECTED=("${PHASES[@]:${FROM_INDEX}}")
wants_phase() { local p; for p in "${SELECTED[@]}"; do [[ "${p}" == "$1" ]] && return 0; done; return 1; }

command -v kubectl >/dev/null 2>&1 || die "kubectl is not on PATH"
command -v git >/dev/null 2>&1 || die "git is not on PATH (the tag is git describe of this tree)"

KUBECTL=(kubectl -n "${NAMESPACE}")
strip_ansi() { sed -e 's/\x1b\[[0-9;]*[A-Za-z]//g'; }

# ------------------------------------------------------------------ the tag
# One string for the whole release: the image tags, the chart's image.tag, the
# worldserver's WRATHBENCH_BUILD and the harness stamp on every trajectory. It
# is computed WITHOUT --dirty — a dirty tag is refused by the build phase rather
# than carried into the pin.
tree_dirty() { ! { git -C "${REPO_ROOT}" diff --quiet && git -C "${REPO_ROOT}" diff --cached --quiet; }; }
[[ -n "${TAG}" ]] || TAG="$(git -C "${REPO_ROOT}" describe --tags --always 2>/dev/null || true)"
[[ -n "${TAG}" ]] || die "could not compute a tag from git (--tag names one)"
[[ "${TAG}" != "latest" ]] || die "'latest' is not an immutable tag and is refused (GitHub issue 7)"
SHA="$(git -C "${REPO_ROOT}" rev-parse HEAD 2>/dev/null || true)"
[[ -n "${SHA}" ]] || die "could not read HEAD from ${REPO_ROOT}"

# ------------------------------------------------------------- cluster reads
#
# What the cluster RUNS, never what a pin PR says it will run — the distinction
# the 2026-09-16 window did not make. Only the tag after the last colon is
# compared: the registry is one cluster's business.
FLEET_DEPLOY="deployment/${RELEASE}-fleet"
# The pin's own witnesses. worldserver carries the worldserver image; runner and
# viewer carry the runner image, so together they prove BOTH images rolled. The
# runner is in the list for a second reason: the deploy window runs every smoke
# as `kubectl exec deploy/<release>-runner`, so a runner still on the old tag
# would produce the "verified by N smokes" claim from the OLD harness. Its
# `rollout status` cannot catch that — a Deployment whose spec never changed
# reports rolled out instantly — so the tag is read instead.
PIN_WITNESSES=(
  "deployment/${RELEASE}-worldserver"
  "deployment/${RELEASE}-runner"
  "deployment/${RELEASE}-viewer"
)
# Everything the chart rolls that is worth waiting on. The fleet Deployment is
# deliberately NOT here: this window holds it at 0, and a Helm upgrade may have
# reset it to 1 under the held pause switch — either way its rollout says
# nothing about the release. `db` runs an upstream image and never moves on a
# tag change; it is waited on only if it happens to be rolling.
ROLLOUT_TARGETS=(
  "deployment/${RELEASE}-worldserver"
  "deployment/${RELEASE}-authserver"
  "deployment/${RELEASE}-runner"
  "deployment/${RELEASE}-viewer"
  "deployment/${RELEASE}-publisher"
  "deployment/${RELEASE}-collector"
  "statefulset/${RELEASE}-clickhouse"
)

images_of() {
  "${KUBECTL[@]}" get "$1" -o jsonpath='{.spec.template.spec.containers[*].image}' 2>/dev/null | strip_ansi | tr -d '\r' || true
}
exists() { "${KUBECTL[@]}" get "$1" -o name >/dev/null 2>&1; }
# True when ANY container on the object carries the tag — not containers[0]: a
# sidecar must not decide which image a Deployment is.
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
pinned_everywhere() {
  local d
  for d in "${PIN_WITNESSES[@]}"; do carries_tag "${d}" "${TAG}" || return 1; done
  return 0
}

# ----------------------------------------------------------------- the plan
say "release ${TAG} (commit ${SHA})"
say "  namespace   ${NAMESPACE} (release ${RELEASE})"
say "  phases      ${SELECTED[*]}$(if [[ "${FROM}" != "build" ]]; then echo "  (--from ${FROM}; ${PHASES[*]:0:${FROM_INDEX}} skipped)"; fi)"
say "  pin         $(if [[ -n "${PIN_HOOK}" ]]; then echo "hook: ${PIN_HOOK} ${TAG} ${SHA}"; else echo "no --pin-hook: printed instructions, then the same wait"; fi)"
say "  wait target $(if [[ -n "${HELMRELEASE}" ]]; then echo "helmrelease ${HELMRELEASE} (after the tag poll, never instead of it)"; else echo "the Deployments' own images and rollouts (no --helmrelease given)"; fi)"

if [[ "${DRY_RUN}" -eq 1 ]]; then
  say "--dry-run: the plan only. Nothing is built, pushed, drained, pinned, smoked or scaled."
  for d in "${PIN_WITNESSES[@]}"; do
    say "  cluster now ${d}: $(tags_of "${d}")$(if carries_tag "${d}" "${TAG}"; then echo "  (already ${TAG})"; else echo "  (not ${TAG})"; fi)"
  done
  say "  fleet now   ${FLEET_DEPLOY}: $(if exists "${FLEET_DEPLOY}"; then "${KUBECTL[@]}" get "${FLEET_DEPLOY}" -o jsonpath='{.spec.replicas}' 2>/dev/null | strip_ansi; echo " replica(s)"; else echo "not found"; fi)"
  wants_phase build && say "  would build  ${BUILD_IMAGES} --push --tag ${TAG}$(if [[ -n "${REGISTRY}" ]]; then echo " --registry ${REGISTRY}"; fi)  (refusing a dirty tree)"
  wants_phase drain && say "  would drain  ${FLEET_UPDATE} drain --namespace ${NAMESPACE} --release ${RELEASE}"
  if wants_phase pin; then
    if [[ -n "${PIN_HOOK}" ]]; then
      say "  would pin    ${PIN_HOOK} ${TAG} ${SHA}  (WRATHBENCH_TAG=${TAG} WRATHBENCH_SHA=${SHA}), then poll"
    else
      say "  would pin    print image.tag=${TAG} and commit ${SHA} and where the chart expects them, then poll"
    fi
    say "  would wait   up to ${PIN_WAIT_S}s for ${PIN_WITNESSES[*]} to carry ${TAG}, then rollout status on:"
    for d in "${ROLLOUT_TARGETS[@]}"; do
      say "                 ${d}$(if exists "${d}"; then echo ""; else echo "  (absent — skipped)"; fi)"
    done
    [[ -n "${HELMRELEASE}" ]] && say "                 and kubectl wait --for=condition=Ready helmrelease/${HELMRELEASE#*/} in ${HELMRELEASE%/*}"
  fi
  wants_phase deploy && say "  would deploy ${K8S_DEPLOY} --namespace ${NAMESPACE} --release ${RELEASE} --expect-tag ${TAG}$(if [[ "${NO_SMOKE}" -eq 1 ]]; then echo " --no-smoke"; fi)"
  wants_phase resume && say "  would resume ${FLEET_UPDATE} resume --namespace ${NAMESPACE} --release ${RELEASE}"
  say "--dry-run: each phase's own script has a --dry-run that says more; this is the order."
  exit 0
fi

# ---------------------------------------------------------------- 1. build
phase_build() {
  say "=== build: ${BUILD_IMAGES} --push at ${TAG}"
  if tree_dirty; then
    fail "the working tree has uncommitted changes. ${TAG} would name a commit that does not contain what is in the images, which is a pin that points at nothing. Commit, then re-run."
  fi
  local args=(--push --tag "${TAG}")
  [[ -n "${REGISTRY}" ]] && args+=(--registry "${REGISTRY}")
  # Idempotent by construction: docker reuses its layers and a push of a digest
  # the registry already has is a no-op.
  "${BUILD_IMAGES}" "${args[@]}"
  say "built and pushed ${TAG}"
}

# ---------------------------------------------------------------- 2. drain
phase_drain() {
  say "=== drain: ${FLEET_UPDATE} drain (the pause switch STAYS SET through the pin and the deploy)"
  # Idempotent: on an already-drained fleet it sets the switch again, finds
  # nothing live and scales to 0 again.
  "${FLEET_UPDATE}" drain --namespace "${NAMESPACE}" --release "${RELEASE}"
  say "drained; the switch is set and the fleet schedules nothing until \`resume\`"
}

# ------------------------------------------------------------------ 3. pin
print_pin_instructions() {
  say "no --pin-hook, so the pin is yours to place. Set:"
  say "    image.tag = ${TAG}"
  say "    commit    = ${SHA}"
  say "  The chart reads the tag as \`image.tag\` (infra/chart/wrathbench/values.yaml),"
  say "  which your GitOps repo supplies however it supplies values — a HelmRelease's"
  say "  \`values:\`, a values file, or \`helm upgrade --set image.tag=${TAG}\`. If that"
  say "  release also pins the chart SOURCE by revision, the commit above is it."
  say "  Point --pin-hook at whatever does this for you and it stops being a hand step."
  say "Waiting for the cluster to carry ${TAG} — place the pin and this continues on its own."
}

run_pin_hook() {
  say "pin hook: ${PIN_HOOK} ${TAG} ${SHA}"
  # The tag and the sha arrive BOTH ways — as argv and in the environment — so a
  # hook can be a one-liner or a script that reads its config from the env.
  if ! WRATHBENCH_TAG="${TAG}" WRATHBENCH_SHA="${SHA}" \
       bash -c "${PIN_HOOK} \"\$@\"" pin-hook "${TAG}" "${SHA}"; then
    fail "the pin hook exited non-zero. NOTHING has been deployed and the fleet is drained with the switch set. Fix the pin, then: ./infra/k8s-release.sh --from pin"
  fi
  say "pin hook returned; now waiting for the cluster to actually carry ${TAG}"
}

wait_for_tag() {
  local deadline d
  deadline=$(( $(date +%s) + PIN_WAIT_S ))
  while :; do
    if pinned_everywhere; then
      say "the cluster carries ${TAG}: $(for d in "${PIN_WITNESSES[@]}"; do printf '%s=%s ' "${d##*/}" "$(tags_of "${d}")"; done)"
      return 0
    fi
    if (( $(date +%s) >= deadline )); then
      for d in "${PIN_WITNESSES[@]}"; do say "  ${d}: $(tags_of "${d}")"; done
      fail "the cluster still does not carry ${TAG} after ${PIN_WAIT_S}s. Nothing was deployed; the fleet is drained with the switch set. When the pin lands: ./infra/k8s-release.sh --from pin"
    fi
    for d in "${PIN_WITNESSES[@]}"; do
      carries_tag "${d}" "${TAG}" || say "  waiting: ${d} is on $(tags_of "${d}"), not ${TAG}"
    done
    sleep "${POLL_S}"
  done
}

wait_for_rollouts() {
  local d
  for d in "${ROLLOUT_TARGETS[@]}"; do
    if ! exists "${d}"; then
      say "  ${d} is not installed — skipped"
      continue
    fi
    say "  rollout status ${d} (up to ${ROLLOUT_WAIT_S}s)"
    "${KUBECTL[@]}" rollout status "${d}" --timeout="${ROLLOUT_WAIT_S}s" \
      || fail "${d} did not finish rolling out. Nothing was deployed; the fleet is drained with the switch set."
  done
  say "  ${FLEET_DEPLOY} is NOT waited on: this window holds it at 0, and a Helm upgrade may have reset it to 1 under the held switch"
  if [[ -n "${HELMRELEASE}" ]]; then
    # AFTER the tag poll, never instead of it: a HelmRelease is still Ready on
    # the PREVIOUS revision, so `wait --for=condition=Ready` on its own would
    # return instantly and hand the deploy window the old image — the
    # 2026-09-16 mistake in a different costume.
    say "  kubectl -n ${HELMRELEASE%/*} wait --for=condition=Ready helmrelease/${HELMRELEASE#*/}"
    kubectl -n "${HELMRELEASE%/*}" wait --for=condition=Ready --timeout="${ROLLOUT_WAIT_S}s" \
      "helmrelease/${HELMRELEASE#*/}" \
      || fail "helmrelease ${HELMRELEASE} is not Ready. The images are pinned but the release is not settled; nothing was deployed."
  fi
}

phase_pin() {
  say "=== pin: ${TAG} in front of the cluster"
  if pinned_everywhere; then
    say "the cluster ALREADY carries ${TAG} — skipping the pin step itself (nothing to place, and a hook is not run twice)"
  elif [[ -n "${PIN_HOOK}" ]]; then
    run_pin_hook
  else
    print_pin_instructions
  fi
  wait_for_tag
  wait_for_rollouts
  say "pinned and rolled: ${TAG}"
}

# ---------------------------------------------------------------- 4. deploy
phase_deploy() {
  say "=== deploy: ${K8S_DEPLOY} (its own drain, the smokes, and the fleet comes back)"
  local args=(--namespace "${NAMESPACE}" --release "${RELEASE}" --expect-tag "${TAG}")
  [[ "${NO_SMOKE}" -eq 1 ]] && args+=(--no-smoke)
  # --expect-tag is belt and braces: the pin phase already proved the cluster
  # carries ${TAG}, and the deploy refuses on its own if that stopped being true
  # between the two.
  "${K8S_DEPLOY}" "${args[@]}"
}

# ---------------------------------------------------------------- 5. resume
phase_resume() {
  say "=== resume: ${FLEET_UPDATE} resume"
  # Idempotent, and usually already done: k8s-deploy.sh clears the switch it
  # finds set on its way out. Running it again clears nothing and says so.
  "${FLEET_UPDATE}" resume --namespace "${NAMESPACE}" --release "${RELEASE}"
}

for phase in "${SELECTED[@]}"; do
  "phase_${phase}"
done

say "RELEASED ${TAG} (${SHA}). Phases run: ${SELECTED[*]}."
