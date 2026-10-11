#!/usr/bin/env bash
#
# Refuse an image whose filesystem holds a secret-shaped or Blizzard-shaped
# path. infra/build-images.sh runs it on every image it builds, before anything
# is pushed.
#
#   ./infra/image-guard.sh <image>...          # scan each image; exit 1 naming what it found
#   ./infra/image-guard.sh --paths [--root D]  # the matcher alone: tar-style paths on stdin,
#                                              # offending ones on stdout, exit 1 if any
#
# It prints PATHS ONLY, never contents. A flagged directory is printed once,
# not every file under it.
#
# The images are built from a `git archive` of the commit, so nothing untracked
# can reach one in the first place. This is the second line: it catches a
# tracked file that should not be, a Dockerfile step that writes one, or a
# build that went around build-images.sh. It reads the final filesystem
# (`docker export` of a container that is created and never started), so a file
# added in one layer and deleted in a later one is not seen here; keeping such a
# file out of the build context is the archive's job.
#
# What is refused:
#   - `.env` and `.env.*` (but `.env.example`), anywhere;
#   - `*.pem`, `*.key`, `id_*`, anywhere outside the system CA store;
#   - `.git-credentials`, `auth.json` (the Codex CLI's login), `credentials*`
#     and `.credentials*` (Claude Code's login file is `.credentials.json`);
#   - `.npmrc` holding an auth token or password;
#   - any `.claude` or `.wrangler` directory (but the Claude Code CLI's own
#     state, below);
#   - `*.sqlite` (and its -wal/-shm/-journal) under /wrathbench or /azerothcore;
#   - anything under /wrathbench/data, the data volume's mount point;
#   - client-data file types (MPQ, DBC, extracted maps), which never ship.
#
# The allow-list is explicit and minimal; every entry is something an image
# legitimately carries today:
#   - etc/ssl/certs/*        the ca-certificates bundle
#   - usr/lib/ssl/cert.pem   OpenSSL's link to that bundle
#   - home/bun/.claude/ and its backups/, downloads/ and sessions/ directories,
#     and backups/.claude.json.backup.<n>: what the runner Dockerfile's
#     `claude --version` writes. Any other file there is refused.
#
# With --paths, an `.npmrc` is refused unless --root names a directory holding
# a copy of it at the listed path whose content shows no token. In image mode
# the guard extracts only the `.npmrc` files it listed, into a temp directory,
# and greps them; no other file is ever read out of an image.

set -Eeuo pipefail

say() { echo "[$(date +%H:%M:%S)] image-guard: $*"; }
die() { echo "[$(date +%H:%M:%S)] image-guard: $*" >&2; exit 2; }

# The matcher. Reads paths (one per line, as `tar -t` prints them) on stdin and
# prints each offending path, a flagged directory once. Content is never read
# here; .npmrc verdicts come in from the caller as NPMRC_CLEAN (a
# newline-separated list of normalised paths whose content was checked).
match_paths() {
  NPMRC_CLEAN="${NPMRC_CLEAN:-}" awk '
    BEGIN {
      n = split(ENVIRON["NPMRC_CLEAN"], clean, "\n")
      for (i = 1; i <= n; i++) if (clean[i] != "") ok_npmrc[clean[i]] = 1
    }
    function flag(p) { if (!(p in seen)) { seen[p] = 1; print p; found = 1 } }
    {
      p = $0
      sub(/^\.\//, "", p); sub(/^\/+/, "", p)
      if (p == "" || p == ".") next
      isdir = (p ~ /\/$/)
      sub(/\/+$/, "", p)

      # Under a directory already flagged: printed once, at the directory.
      for (d in flagged_dir) if (index(p "/", d) == 1) next

      # Directory rules first, so a .claude tree is one line, not thousands.
      nc = split(p, c, "/")
      prefix = ""
      for (i = 1; i <= nc; i++) {
        prefix = prefix c[i] "/"
        if (c[i] == ".claude" || c[i] == ".wrangler") {
          if (prefix == "home/bun/.claude/") {
            # The state the CLI writes at build time, entry by entry. Anything
            # else in there is named itself, not as the directory.
            rest = substr(p "/", length(prefix) + 1)
            if (rest == "" || rest == "backups/" || rest == "downloads/" || rest == "sessions/") break
            if (rest ~ /^backups\/\.claude\.json\.backup\.[0-9]+\/$/ && !isdir) break
            if (isdir) { flagged_dir[p "/"] = 1; flag(p "/") } else flag(p)
            next
          }
          flagged_dir[prefix] = 1; flag(prefix); next
        }
      }
      if (p ~ /^wrathbench\/data\/./) { flagged_dir["wrathbench/data/"] = 1; flag("wrathbench/data/"); next }

      b = c[nc]
      if (b == ".env" || (b ~ /^\.env\./ && b != ".env.example")) { flag(p); next }
      if (b ~ /\.(pem|key)$/ || b ~ /^id_/) {
        if (index(p, "etc/ssl/certs/") == 1 || p == "usr/lib/ssl/cert.pem") next
        flag(p); next
      }
      if (b == ".git-credentials" || b == "auth.json" || b ~ /^\.?credentials/) { flag(p); next }
      if (b == ".npmrc") { if (!(p in ok_npmrc)) flag(p); next }
      if ((index(p, "wrathbench/") == 1 || index(p, "azerothcore/") == 1) && b ~ /\.sqlite3?(-wal|-shm|-journal)?$/) { flag(p); next }
      if (tolower(b) ~ /\.(mpq|dbc|db2|adt|wdt|wmo|m2|blp|vmtree|vmtile|mmap|mmtile)$/) { flag(p); next }
    }
    END { exit found ? 1 : 0 }
  '
}

# True when an .npmrc carries a credential: an auth token, basic auth, or a
# password. Reads the file, prints nothing.
npmrc_has_token() {
  grep -Eq '(^|[:[:space:]])_(authToken|auth|password)[[:space:]]*=' "$1"
}

# Normalised paths of the .npmrc files under ROOT (as the listing names them)
# that carry no credential. A missing copy is not clean.
clean_npmrcs() {
  local root="$1" list="$2" p norm
  while IFS= read -r p; do
    norm="${p#./}"; norm="${norm#/}"
    [[ "${norm##*/}" == ".npmrc" ]] || continue
    [[ -f "${root}/${norm}" ]] || continue
    npmrc_has_token "${root}/${norm}" || printf '%s\n' "${norm}"
  done < "${list}"
}

if [[ "${1:-}" == "--paths" ]]; then
  shift
  ROOT=""
  if [[ "${1:-}" == "--root" ]]; then ROOT="${2:-}"; shift 2; fi
  [[ $# -eq 0 ]] || die "--paths takes only --root <dir>"
  list="$(mktemp)"
  trap 'rm -f "${list}"' EXIT
  cat > "${list}"
  NPMRC_CLEAN=""
  [[ -n "${ROOT}" ]] && NPMRC_CLEAN="$(clean_npmrcs "${ROOT}" "${list}")"
  NPMRC_CLEAN="${NPMRC_CLEAN}" match_paths < "${list}"
  exit $?
fi

case "${1:-}" in
  ""|-h|--help) sed -n '2,50p' "$0" | sed 's/^# \{0,1\}//'; [[ -n "${1:-}" ]] && exit 0; exit 2 ;;
  -*) die "unknown flag $1" ;;
esac

command -v docker >/dev/null 2>&1 || die "docker is not on PATH"

WORK="$(mktemp -d)"
CID=""
cleanup() {
  [[ -n "${CID}" ]] && docker rm -f "${CID}" >/dev/null 2>&1 || true
  rm -rf "${WORK}"
}
trap cleanup EXIT

rc=0
for ref in "$@"; do
  # Created, never started: nothing in the image runs. `true` is a placeholder
  # command for images with no CMD.
  CID="$(docker create "${ref}" true)" || die "${ref}: could not create a container to read it"
  list="${WORK}/list"
  if ! docker export "${CID}" | tar -tf - > "${list}"; then
    die "${ref}: could not list the image filesystem; refusing it"
  fi
  # An empty listing is a failure to read, never a clean image.
  [[ -s "${list}" ]] || die "${ref}: the image filesystem listed empty; refusing it"

  npmrcs=()
  while IFS= read -r p; do
    [[ "${p##*/}" == ".npmrc" ]] && npmrcs+=("${p}")
  done < "${list}"
  NPMRC_CLEAN=""
  if [[ "${#npmrcs[@]}" -gt 0 ]]; then
    mkdir -p "${WORK}/npmrc"
    # Only the .npmrc files, by exact name. An extraction failure leaves them
    # absent, and an absent copy is refused.
    docker export "${CID}" | tar -xf - -C "${WORK}/npmrc" -- "${npmrcs[@]}" 2>/dev/null || true
    NPMRC_CLEAN="$(clean_npmrcs "${WORK}/npmrc" "${list}" || true)"
    rm -rf "${WORK}/npmrc"
  fi

  docker rm -f "${CID}" >/dev/null 2>&1 || true
  CID=""

  if found="$(NPMRC_CLEAN="${NPMRC_CLEAN}" match_paths < "${list}")"; then
    say "${ref}: clean ($(wc -l < "${list}" | tr -d ' ') paths checked)"
  else
    echo "[$(date +%H:%M:%S)] image-guard: ${ref}: REFUSED, secret- or client-data-shaped paths in the image:" >&2
    while IFS= read -r p; do printf '  /%s\n' "${p}" >&2; done <<< "${found}"
    rc=1
  fi
done
exit "${rc}"
