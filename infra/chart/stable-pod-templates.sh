#!/usr/bin/env bash
#
# The databases' pods must not move when only the release moves.
#
# Renders the chart as two different releases — a different chart version
# (a git-sourced chart is stamped `0.1.0+<sha>`) and a different image tag —
# and fails unless:
#
#   1. the ClickHouse StatefulSet's and the MySQL Deployment's pod templates are
#      byte-identical between the two, so an upgrade leaves both pods alone;
#   2. no workload's pod-template labels or annotations carry the chart version
#      or the image tag (the general form of 1, for every Deployment and
#      StatefulSet: a pod rolls for its own inputs, not for the release);
#   3. the things that SHOULD roll them still do: a new ClickHouse image, a
#      change to ClickHouse's own config drop-ins, a new MySQL image — and a
#      new image tag still rolls the worldserver.
#
# Why: templates/_helpers.tpl, `wrathbench.podLabels`.
#
# Needs helm and mikefarah yq v4. Run from anywhere:
#   infra/chart/stable-pod-templates.sh

set -o errexit
set -o nounset
set -o pipefail

CHART_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/wrathbench" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
for tool in helm yq; do command -v "${tool}" >/dev/null || fail "${tool} is required"; done

CH=StatefulSet/wrathbench-clickhouse
DB=Deployment/wrathbench-db
WS=Deployment/wrathbench-worldserver

# render <name> <chart version> <image tag> [helm args...]
# A copy of the chart per render, so a version stamp or a control edit never
# touches the tree. `$EDIT`, when set, is a sed script applied to the copy's
# templates/clickhouse.yaml.
render() {
  local name=$1 version=$2 tag=$3
  shift 3
  local dir="${WORK}/${name}"
  mkdir -p "${dir}"
  cp -R "${CHART_SRC}" "${dir}/chart"
  yq -i ".version = \"${version}\"" "${dir}/chart/Chart.yaml"
  if [[ -n "${EDIT:-}" ]]; then sed -i -e "${EDIT}" "${dir}/chart/templates/clickhouse.yaml"; fi
  helm template wrathbench "${dir}/chart" --namespace wrathbench \
    --set image.registry=registry.example \
    --set image.tag="${tag}" \
    "$@" >"${dir}/all.yaml"
}

# template <name> <Kind/name>: that workload's .spec.template, as YAML.
template() {
  local kind=${2%%/*} obj=${2#*/}
  yq "select(.kind == \"${kind}\" and .metadata.name == \"${obj}\") | .spec.template" "${WORK}/$1/all.yaml"
}

same() { [[ "$(template "$1" "$3")" == "$(template "$2" "$3")" ]]; }

render a 0.1.0+aaaaaaaaaaaa v-1-gaaaaaaa
render b 0.1.0+bbbbbbbbbbbb v-2-gbbbbbbb

for w in "${CH}" "${DB}"; do
  [[ -n "$(template a "${w}")" ]] || fail "${w} did not render"
  if ! same a b "${w}"; then
    diff -u <(template a "${w}") <(template b "${w}") >&2 || true
    fail "${w}'s pod template differs between two releases: every upgrade would replace that pod"
  fi
  echo "ok: ${w} pod template is identical across chart version and image tag"
done

# Every Deployment/StatefulSet pod template's labels and annotations, free of
# the release's identity.
leaks="$(yq 'select(.kind == "Deployment" or .kind == "StatefulSet")
  | .kind + "/" + .metadata.name + " " + ((.spec.template.metadata.labels // {}) + (.spec.template.metadata.annotations // {}) | to_entries | map(.key + "=" + .value) | join(" "))' \
  "${WORK}/b/all.yaml" | grep -E 'bbbbbbbbbbbb|v-2-gbbbbbbb' || true)"
[[ -z "${leaks}" ]] || fail "pod-template metadata carries the chart version or image tag: ${leaks}"
echo "ok: no pod template's labels or annotations name the chart version or image tag"

# The controls: what must still roll them.
render ch-image 0.1.0+aaaaaaaaaaaa v-1-gaaaaaaa --set clickhouse.image=clickhouse/clickhouse-server:0.0-control
! same a ch-image "${CH}" || fail "a new ClickHouse image did not change its pod template"
same a ch-image "${DB}" || fail "a new ClickHouse image changed the MySQL pod template"
echo "ok: a new ClickHouse image rolls ClickHouse, and only ClickHouse"

EDIT='0,/^<clickhouse>$/s//<clickhouse><!-- control -->/' render ch-config 0.1.0+aaaaaaaaaaaa v-1-gaaaaaaa
! same a ch-config "${CH}" || fail "a change to ClickHouse's config drop-ins did not change its pod template (checksum annotation)"
same a ch-config "${DB}" || fail "a change to ClickHouse's config changed the MySQL pod template"
echo "ok: a ClickHouse config change rolls ClickHouse, and only ClickHouse"

render db-image 0.1.0+aaaaaaaaaaaa v-1-gaaaaaaa --set db.image=mysql:0.0-control
! same a db-image "${DB}" || fail "a new MySQL image did not change its pod template"
same a db-image "${CH}" || fail "a new MySQL image changed the ClickHouse pod template"
echo "ok: a new MySQL image rolls MySQL, and only MySQL"

! same a b "${WS}" || fail "a new image tag did not change the worldserver pod template"
echo "ok: a new image tag still rolls the worldserver"
