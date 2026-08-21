#!/usr/bin/env bash
#
# Extract maps, vmaps, mmaps, DBCs and Cameras from a local WoW 3.3.5a
# (build 12340) client into data/client, using AzerothCore's extraction tools
# from the wrathbench/tools image.
#
# Usage: ./infra/extract-client-data.sh /path/to/wow-client [output-dir]
#
# See infra/EXTRACTION.md for inputs, sizes, durations and how to resume.
#
set -euo pipefail

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -P "${SCRIPT_DIR}/.." && pwd)"

TOOLS_IMAGE="${WRATHBENCH_TOOLS_IMAGE:-wrathbench/tools}"
# AzerothCore's tools image ships the four binaries but not necessarily
# mmaps-config.yaml, so we mount the copy from the pinned submodule.
MMAPS_CONFIG="${MMAPS_CONFIG:-${REPO_ROOT}/deps/azerothcore/src/tools/mmaps_generator/mmaps-config.yaml}"
MIN_FREE_GB="${MIN_FREE_GB:-30}"
DRY_RUN="${DRY_RUN:-0}"

usage() {
    cat <<EOF
Usage: $(basename "$0") [--force] <client-dir> [output-dir]

  <client-dir>   A full WoW 3.3.5a build 12340 install (the directory that
                 contains Data/). Mounted read-only.
  [output-dir]   Where to write dbc/ maps/ vmaps/ mmaps/ Cameras/.
                 Default: ${REPO_ROOT}/data/client

Options:
  --force        Redo every stage, discarding existing output.
  -h, --help     This message.

Environment:
  MMAPS_THREADS           mmaps_generator worker threads (default: nproc).
  WRATHBENCH_TOOLS_IMAGE  Tools image (default: wrathbench/tools).
  MMAPS_CONFIG            Path to mmaps-config.yaml on the host.
  MIN_FREE_GB             Free-space floor for the preflight (default: 30).
  DRY_RUN=1               Print docker invocations instead of running them.
EOF
}

log()  { printf '%s  %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- arguments

FORCE=0
CLIENT_DIR=""
OUT_DIR=""

while [ $# -gt 0 ]; do
    case "$1" in
        --force) FORCE=1 ;;
        -h|--help) usage; exit 0 ;;
        -*) usage >&2; die "unknown option: $1" ;;
        *)
            if [ -z "$CLIENT_DIR" ]; then
                CLIENT_DIR="$1"
            elif [ -z "$OUT_DIR" ]; then
                OUT_DIR="$1"
            else
                usage >&2; die "too many arguments"
            fi
            ;;
    esac
    shift
done

[ -n "$CLIENT_DIR" ] || { usage >&2; exit 1; }
OUT_DIR="${OUT_DIR:-${REPO_ROOT}/data/client}"

[ -d "$CLIENT_DIR" ] || die "client directory not found: $CLIENT_DIR"
CLIENT_DIR="$(cd -P "$CLIENT_DIR" && pwd)"

# Resolve the output path without creating it yet: the repo check below must
# refuse a bad path rather than leave a directory behind.
if [ -d "$OUT_DIR" ]; then
    OUT_DIR="$(cd -P "$OUT_DIR" && pwd)"
else
    OUT_PARENT="$(dirname "$OUT_DIR")"
    [ -d "$OUT_PARENT" ] || die "parent of output dir does not exist: $OUT_PARENT"
    OUT_DIR="$(cd -P "$OUT_PARENT" && pwd)/$(basename "$OUT_DIR")"
fi

# Nothing Blizzard-derived may land in the repo outside data/.
case "$OUT_DIR" in
    "${REPO_ROOT}/data"|"${REPO_ROOT}/data/"*) ;;
    "$REPO_ROOT"|"${REPO_ROOT}/"*)
        die "output dir is inside the repo but outside data/: $OUT_DIR" ;;
esac

mkdir -p "$OUT_DIR"

# ---------------------------------------------------------------- preflight

preflight() {
    local data_dir="${CLIENT_DIR}/Data"
    [ -d "$data_dir" ] || die "no Data/ directory in client: $CLIENT_DIR"

    # The base archives every 3.3.5a install has. patch-3..5 are optional:
    # map_extractor probes for them and skips what is missing.
    local mpq
    for mpq in common.MPQ common-2.MPQ expansion.MPQ lichking.MPQ patch.MPQ; do
        [ -f "${data_dir}/${mpq}" ] || die "missing client archive: Data/${mpq}"
    done

    local locale found=""
    for locale in enUS enGB; do
        if [ -f "${data_dir}/${locale}/locale-${locale}.MPQ" ]; then
            found="$locale"
            break
        fi
    done
    [ -n "$found" ] || die "no enUS or enGB locale found under Data/"
    log "locale: ${found} (client build is verified from the extractor output)"

    command -v docker >/dev/null 2>&1 || die "docker not found on PATH"
    if [ "$DRY_RUN" != "1" ]; then
        docker info >/dev/null 2>&1 || die "cannot talk to the docker daemon"
        if ! docker image inspect "$TOOLS_IMAGE" >/dev/null 2>&1; then
            die "image ${TOOLS_IMAGE} not found. Build it from the repo root:
  docker build -f infra/docker/server.Dockerfile --target tools -t ${TOOLS_IMAGE} ."
        fi
    fi

    [ -f "$MMAPS_CONFIG" ] || die "mmaps config not found: $MMAPS_CONFIG"

    local free_kb free_gb
    free_kb="$(df -Pk "$OUT_DIR" | awk 'NR==2 {print $4}')"
    free_gb=$(( free_kb / 1024 / 1024 ))
    [ "$free_gb" -ge "$MIN_FREE_GB" ] || \
        die "only ${free_gb}GB free at ${OUT_DIR}; need ~${MIN_FREE_GB}GB of working space"
    log "free space at output: ${free_gb}GB"
}

# ------------------------------------------------------------------ runners

# run_tool <container-workdir> <tool> [args...]
# Containers run as the invoking user so output is not root-owned, with stdin
# closed so the tools' getchar()/scanf() prompts hit EOF instead of hanging.
# The image's entrypoint (AC's entrypoint.sh) is bypassed: it materialises conf
# files the tools don't need and aborts when the invoking uid cannot write the
# image's conf dir, so the tool binary is invoked directly instead.
run_tool() {
    local workdir="$1"; shift
    local tool="$1"; shift
    local args=(
        run --rm
        --user "$(id -u):$(id -g)"
        --entrypoint "$tool"
        -v "${CLIENT_DIR}:/client:ro"
        -v "${OUT_DIR}:/out"
        -v "${MMAPS_CONFIG}:/mmaps-config.yaml:ro"
        -w "$workdir"
        "$TOOLS_IMAGE"
        "$@"
    )
    if [ "$DRY_RUN" = "1" ]; then
        printf '  [dry-run] docker'; printf ' %q' "${args[@]}"; printf '\n'
        return 0
    fi
    docker "${args[@]}" < /dev/null
}

marker() { printf '%s/.extracted-%s' "$OUT_DIR" "$1"; }

stage_done() {
    [ "$FORCE" = "0" ] && [ -f "$(marker "$1")" ]
}

# run_stage <name> <function>
run_stage() {
    local name="$1" fn="$2" start end
    if stage_done "$name"; then
        log "stage ${name}: already complete, skipping (--force to redo)"
        return 0
    fi
    start="$(date +%s)"
    log "stage ${name}: start"
    # Drop the marker first: while a stage is running its outputs are not
    # complete, and a run killed mid-stage must not look finished afterwards.
    if [ "$DRY_RUN" = "1" ]; then
        printf '  [dry-run] rm -f %s\n' "$(marker "$name")"
    else
        rm -f "$(marker "$name")"
    fi
    "$fn"
    if [ "$DRY_RUN" = "1" ]; then
        printf '  [dry-run] touch %s\n' "$(marker "$name")"
    else
        : > "$(marker "$name")"
    fi
    end="$(date +%s)"
    log "stage ${name}: done in $(( (end - start) / 60 ))m $(( (end - start) % 60 ))s"
}

# A stage with no marker is assumed to have been interrupted: its outputs are
# wiped before it reruns. A half-written .map or .vmtree is worse than none,
# and vmap4_extractor refuses to run at all if Buildings/ is dirty.
wipe() {
    local path
    for path in "$@"; do
        if [ "$DRY_RUN" = "1" ]; then
            printf '  [dry-run] rm -rf %q\n' "${OUT_DIR}/${path}"
        else
            rm -rf "${OUT_DIR:?}/${path}"
        fi
    done
}

# ------------------------------------------------------------------- stages

# map_extractor with default -e 7 extracts maps, DBCs and Cameras in one pass.
stage_maps() {
    wipe dbc maps Cameras
    run_tool /out map_extractor -i /client -o .
}

# vmap4_extractor has no output flag: it writes ./Buildings relative to the
# working directory. The assembler turns that into the vmaps/ the server reads.
stage_vmaps() {
    wipe Buildings vmaps
    run_tool /out vmap4_extractor -d /client/Data/
    run_tool /out vmap4_assembler Buildings vmaps
    log "stage vmaps: removing the Buildings staging directory"
    wipe Buildings
}

# Each mmaps worker holds a tile's Recast heightfield, on the order of a
# gigabyte or two, so the practical ceiling is memory rather than cores.
default_mmaps_threads() {
    local cores mem_kb by_mem
    cores="$(nproc 2>/dev/null || echo 4)"
    mem_kb="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)"
    by_mem=$(( mem_kb / 1024 / 1024 / 2 ))
    if [ "$by_mem" -lt 1 ]; then by_mem=1; fi
    if [ "$by_mem" -lt "$cores" ]; then echo "$by_mem"; else echo "$cores"; fi
}

stage_mmaps() {
    local threads="${MMAPS_THREADS:-$(default_mmaps_threads)}"
    log "stage mmaps: ${threads} threads; this takes hours"
    wipe mmaps
    if [ "$DRY_RUN" = "1" ]; then
        printf '  [dry-run] mkdir -p %q\n' "${OUT_DIR}/mmaps"
    else
        mkdir -p "${OUT_DIR}/mmaps"
    fi
    run_tool /out mmaps_generator --config /mmaps-config.yaml --threads "$threads"
}

# --------------------------------------------------------------------- main

log "client:  ${CLIENT_DIR}"
log "output:  ${OUT_DIR}"
log "image:   ${TOOLS_IMAGE}"
if [ "$FORCE" = "1" ]; then
    log "--force: every stage will be redone"
fi

preflight

RUN_START="$(date +%s)"
run_stage maps  stage_maps
run_stage vmaps stage_vmaps
run_stage mmaps stage_mmaps
RUN_END="$(date +%s)"

log "extraction complete in $(( (RUN_END - RUN_START) / 60 ))m"
log "worldserver DataDir is ${OUT_DIR}"
