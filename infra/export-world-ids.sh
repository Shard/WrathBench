#!/usr/bin/env bash
#
# Export the 3.3.5a world DB's entity id sets to a file the wiki build can read.
#
#   ./infra/export-world-ids.sh                       # -> data/wiki/world-ids.json
#   ./infra/export-world-ids.sh --out /tmp/ids.json
#
# The wiki build admits a page written after the era cutoff when an id the page
# states about itself exists in this server's world DB (ADR-0042). The build is
# a function of files, not of a running server, so the ids are exported once,
# here, and the build reads the file. That keeps a rebuild reproducible from the
# dump plus this export, and keeps the server out of the build's dependencies.
#
# The queries are SELECT-only against acore_world. The output is server-derived
# and lives under data/, which is gitignored: it never enters git.
#
# Environment:
#   WRATHBENCH_DB_CONTAINER      docker container running MySQL (wrathbench-db-1)
#   WRATHBENCH_DB_ROOT_PASSWORD  MySQL root password (wrathbench)

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
OUT="${REPO_ROOT}/data/wiki/world-ids.json"
CONTAINER="${WRATHBENCH_DB_CONTAINER:-wrathbench-db-1}"
PASSWORD="${WRATHBENCH_DB_ROOT_PASSWORD:-wrathbench}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "export-world-ids: unknown flag $1" >&2; exit 2 ;;
  esac
done

mkdir -p "$(dirname -- "${OUT}")"

# One newline-separated column per kind, no header, straight out of the table.
query() {
  docker exec -i "${CONTAINER}" mysql -uroot -p"${PASSWORD}" --batch --skip-column-names \
    --default-character-set=utf8mb4 acore_world -e "$1" 2>/dev/null
}

echo "export-world-ids: reading acore_world from ${CONTAINER}"
QUEST="$(query 'SELECT ID FROM quest_template ORDER BY ID')"
CREATURE="$(query 'SELECT entry FROM creature_template ORDER BY entry')"
ITEM="$(query 'SELECT entry FROM item_template ORDER BY entry')"
GAMEOBJECT="$(query 'SELECT entry FROM gameobject_template ORDER BY entry')"

for pair in "quest:${QUEST}" "creature:${CREATURE}" "item:${ITEM}" "gameobject:${GAMEOBJECT}"; do
  kind="${pair%%:*}"
  rows="${pair#*:}"
  if [[ -z "${rows}" ]]; then
    echo "export-world-ids: ${kind} came back empty — refusing to write a bundle-shrinking export" >&2
    exit 1
  fi
done

TMP="$(mktemp "${OUT}.tmp-XXXXXX")"
trap 'rm -f "${TMP}"' EXIT

# Compact by construction: four arrays of ints and a small header. jq is not
# assumed to be installed, so the arrays are built by joining the columns.
join_ints() { tr -d '\r' <<<"$1" | paste -sd, -; }

EXPORTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
{
  printf '{\n'
  printf '  "source": "acore_world on %s, SELECT-only export by infra/export-world-ids.sh",\n' "${CONTAINER}"
  printf '  "exported_at": "%s",\n' "${EXPORTED_AT}"
  printf '  "counts": {"quest": %s, "creature": %s, "item": %s, "gameobject": %s},\n' \
    "$(wc -l <<<"${QUEST}")" "$(wc -l <<<"${CREATURE}")" "$(wc -l <<<"${ITEM}")" "$(wc -l <<<"${GAMEOBJECT}")"
  printf '  "quest": [%s],\n' "$(join_ints "${QUEST}")"
  printf '  "creature": [%s],\n' "$(join_ints "${CREATURE}")"
  printf '  "item": [%s],\n' "$(join_ints "${ITEM}")"
  printf '  "gameobject": [%s]\n' "$(join_ints "${GAMEOBJECT}")"
  printf '}\n'
} >"${TMP}"

mv -f "${TMP}" "${OUT}"
trap - EXIT

echo "export-world-ids: wrote ${OUT} ($(du -h "${OUT}" | cut -f1))"
echo "  quest      $(wc -l <<<"${QUEST}")"
echo "  creature   $(wc -l <<<"${CREATURE}")"
echo "  item       $(wc -l <<<"${ITEM}")"
echo "  gameobject $(wc -l <<<"${GAMEOBJECT}")"
