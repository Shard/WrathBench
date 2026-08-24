#!/usr/bin/env bash
#
# Export the 3.3.5a world DB's entity ids and names to a file the wiki build reads.
#
#   ./infra/export-world-ids.sh                       # -> data/wiki/world-ids.json
#   ./infra/export-world-ids.sh --out /tmp/ids.json
#
# The wiki build admits a page written after the era cutoff when an id the page
# states about itself exists in this server's world DB **and the DB's name for
# that id agrees with the page's subject** (ADR-0042). The name is what makes
# the rule worth having: an id alone admits every Cataclysm page that inherited
# a 3.3.5 entry or copy-pasted someone else's infobox.
#
# The build is a function of files, not of a running server, so the ids are
# exported once, here, and the build reads the file. That keeps a rebuild
# reproducible from the dump plus this export, and keeps the server out of the
# build's dependencies.
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
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "export-world-ids: unknown flag $1" >&2; exit 2 ;;
  esac
done

mkdir -p "$(dirname -- "${OUT}")"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

# Two columns per row, id then name, in mysql's batch escaping (a tab, newline
# or backslash inside a name comes back as \t, \n or \\). The JSON pass below
# undoes exactly that.
query() {
  docker exec -i "${CONTAINER}" mysql -uroot -p"${PASSWORD}" --batch --skip-column-names \
    --default-character-set=utf8mb4 acore_world -e "$2" 2>/dev/null >"${WORK}/$1.tsv"
  if [[ ! -s "${WORK}/$1.tsv" ]]; then
    echo "export-world-ids: $1 came back empty — refusing to write a bundle-shrinking export" >&2
    exit 1
  fi
}

echo "export-world-ids: reading acore_world from ${CONTAINER}"
# A quest's name is its log title; the other three carry a plain `name`.
query quest      'SELECT ID, LogTitle FROM quest_template ORDER BY ID'
query creature   'SELECT entry, name FROM creature_template ORDER BY entry'
query item       'SELECT entry, name FROM item_template ORDER BY entry'
query gameobject 'SELECT entry, name FROM gameobject_template ORDER BY entry'

EXPORTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
TMP="$(mktemp "${OUT}.tmp-XXXXXX")"

# Bun does the JSON, because a name can hold any character a quest designer
# typed and shell quoting is the wrong tool for that.
WB_WORK="${WORK}" WB_OUT="${TMP}" \
WB_SOURCE="acore_world on ${CONTAINER}, SELECT-only export by infra/export-world-ids.sh" \
WB_EXPORTED_AT="${EXPORTED_AT}" bun -e '
const work = process.env.WB_WORK;
const unescape = (s) => s.replace(/\\(.)/g, (_, c) => (c === "t" ? "\t" : c === "n" ? "\n" : c));
const out = { source: process.env.WB_SOURCE, exported_at: process.env.WB_EXPORTED_AT, counts: {} };
for (const kind of ["quest", "creature", "item", "gameobject"]) {
  const rows = {};
  const text = await Bun.file(`${work}/${kind}.tsv`).text();
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const tab = line.indexOf("\t");
    const id = Number.parseInt(tab === -1 ? line : line.slice(0, tab), 10);
    if (!Number.isInteger(id)) continue;
    rows[id] = tab === -1 ? "" : unescape(line.slice(tab + 1));
  }
  out[kind] = rows;
  out.counts[kind] = Object.keys(rows).length;
}
await Bun.write(process.env.WB_OUT, JSON.stringify(out));
'

mv -f "${TMP}" "${OUT}"

echo "export-world-ids: wrote ${OUT} ($(du -h "${OUT}" | cut -f1))"
for kind in quest creature item gameobject; do
  printf '  %-11s %s\n' "${kind}" "$(wc -l <"${WORK}/${kind}.tsv")"
done
