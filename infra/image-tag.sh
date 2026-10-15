#!/usr/bin/env bash
#
# Print the image tag for a tree or a commit.
#
#   ./infra/image-tag.sh                         # this working tree, `-dirty` if a tracked file changed
#   ./infra/image-tag.sh <commit-ish>            # a commit (never `-dirty`; git refuses --dirty with one)
#   ./infra/image-tag.sh --branch feat/x [...]   # ... with `-x` appended: a branch's build
#   ./infra/image-tag.sh -C <dir> [...]          # the repository at <dir> instead of the current one
#
# The tag is `git describe --tags --always`, so it reads `harness-0.5-<n>-g<sha>`
# and `harnessSeries()` (runner/src/comparability.ts) names it series 0.5. One
# script, because two producers must agree on it: infra/build-images.sh for a
# release or a hand build, and the branch-image workflow
# (.github/workflows/branch-image.yml), which builds a control image for every
# master commit and a treatment image for every push to a feat/** branch. A
# campaign that compares the two then compares builds named the same way, and
# a run's harness stamp reads the same whichever produced its image.
#
# --branch appends the branch's slug: the name past its first `/` (the
# `feat/` of `feat/campaign-arms`), lowercased, every run of characters other
# than a-z and 0-9 turned into one `-`, and cut to 48 characters. The same slug
# is the arm id the workflow suggests. It keeps the series readable
# (`harness-0.5-940-gabc1234-campaign-arms` is still 0.5) and the whole tag
# well inside the registry's 128-character limit.
#
# `--always` falls back to a bare SHA when no tag is reachable (a clone fetched
# without tags). That still names the commit, so it is printed, but it names no
# harness series; the workflow checks the series before it pushes anything.
#
# Exits 1 without printing a tag when git cannot describe the commit, and for
# `latest`, which is refused everywhere a tag becomes a pin (GitHub issue 7).

set -Eeuo pipefail

REPO=""
BRANCH=""
BRANCH_SET=0
REV=""

needs_value() { [[ $# -ge 2 ]] || { echo "image-tag: $1 takes a value" >&2; exit 2; }; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    -C) needs_value "$@"; REPO="$2"; shift 2 ;;
    --branch) needs_value "$@"; BRANCH="$2"; BRANCH_SET=1; shift 2 ;;
    -h|--help) sed -n '2,31p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "image-tag: unknown flag $1" >&2; exit 2 ;;
    *)
      [[ -z "${REV}" ]] || { echo "image-tag: one commit-ish at most (got ${REV} and $1)" >&2; exit 2; }
      REV="$1"; shift ;;
  esac
done

# The branch slug, computed before git is asked anything so a bad name fails
# the same way in any directory.
SLUG=""
if [[ "${BRANCH_SET}" -eq 1 ]]; then
  name="${BRANCH#refs/heads/}"
  [[ "${name}" == */* ]] && name="${name#*/}"
  SLUG="$(printf '%s' "${name}" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-')"
  SLUG="${SLUG#-}"
  SLUG="${SLUG:0:48}"
  SLUG="${SLUG%-}"
  if [[ -z "${SLUG}" ]]; then
    echo "image-tag: --branch ${BRANCH} leaves no slug (it needs a letter or digit past its prefix)" >&2
    exit 2
  fi
fi

git_() { if [[ -n "${REPO}" ]]; then git -C "${REPO}" "$@"; else git "$@"; fi; }

# Tracked changes only, exactly as build-images.sh has always decided it: an
# untracked scratch file is not part of the tree the tag names.
tree_dirty() { ! { git_ diff --quiet && git_ diff --cached --quiet; }; }

if [[ -n "${REV}" ]]; then
  TAG="$(git_ describe --tags --always "${REV}" 2>/dev/null)" || { echo "image-tag: git cannot describe ${REV}" >&2; exit 1; }
elif ! git_ rev-parse --verify --quiet HEAD >/dev/null 2>&1; then
  echo "image-tag: not in a repository with a commit" >&2
  exit 1
elif tree_dirty; then
  TAG="$(git_ describe --tags --always --dirty)" || { echo "image-tag: git cannot describe this tree" >&2; exit 1; }
else
  TAG="$(git_ describe --tags --always)" || { echo "image-tag: git cannot describe this tree" >&2; exit 1; }
fi

[[ -n "${TAG}" ]] || { echo "image-tag: git described nothing" >&2; exit 1; }
[[ "${TAG}" != "latest" ]] || { echo "image-tag: 'latest' is not an immutable tag and is refused (GitHub issue 7)" >&2; exit 1; }

if [[ -n "${SLUG}" ]]; then TAG="${TAG}-${SLUG}"; fi
printf '%s\n' "${TAG}"
