#!/usr/bin/env bash
#
# Operator entry point for one episode.
#
#   ./infra/run-episode.sh --model <id> [--driver openai|claude-code|stub]
#   ./infra/run-episode.sh --resume <run-id>
#   ./infra/run-episode.sh --model <id> --local           # outside the container
#
# Anything else is passed through to `bun runner/src/run.ts` verbatim, e.g.
# --max-turns <n> (driver turns) or --max-tool-calls <n> (tool calls/episode).
#
# What this script adds over calling the runner directly:
#
#  - `WRATHBENCH_HARNESS_VERSION` is computed on the HOST (`git describe`) and
#    handed to the runner, which has the repo mounted but no git. Without it
#    every containerised trajectory would be stamped "unversioned".
#  - .env is loaded on the host for preflight checks only, and only for known
#    key prefixes. Values are never printed, never passed on the command line
#    (they would show up in `ps`): inside the container Bun loads /wrathbench/.env
#    itself, so secrets reach the runner without travelling through argv.
#  - Driver-specific preflight, so a run fails in a second rather than after
#    the sandbox and the game session are up.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
COMPOSE_FILE="${SCRIPT_DIR}/compose.yml"
SERVICE="runner"

usage() {
  sed -n '3,11p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

# ---------------------------------------------------------------- arguments

DRIVER=""
RESUME=""
MODEL=""
LOCAL=0
# The subscription lane, by env var NAME. The runner defaults to the same one;
# it is read here only so the preflight below checks the var this run will
# actually use, and names it when it is missing.
TOKEN_ENV="CLAUDE_CODE_OAUTH_TOKEN"
PASSTHROUGH=()

while [ $# -gt 0 ]; do
  case "$1" in
    --driver)
      DRIVER="${2:-}"
      PASSTHROUGH+=("--driver" "${2:-}")
      shift 2
      ;;
    --model)
      MODEL="${2:-}"
      PASSTHROUGH+=("--model" "${2:-}")
      shift 2
      ;;
    --resume)
      RESUME="${2:-}"
      PASSTHROUGH+=("--resume" "${2:-}")
      shift 2
      ;;
    --token-env)
      TOKEN_ENV="${2:-}"
      PASSTHROUGH+=("--token-env" "${2:-}")
      shift 2
      ;;
    --local)
      LOCAL=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      PASSTHROUGH+=("$1")
      shift
      ;;
  esac
done

if [ -z "${RESUME}" ] && [ -z "${MODEL}" ] && [ "${DRIVER}" != "stub" ]; then
  echo "run-episode.sh: --model <id> is required (or --resume <run-id>)" >&2
  usage >&2
  exit 2
fi

# ------------------------------------------------------------------ env

# Only these prefixes are exported, and only from lines that look like a plain
# KEY=VALUE assignment. `.env` is never sourced as shell, so a stray backtick or
# `$(...)` in a secret cannot execute. Values are never echoed.
load_env() {
  local file="${REPO_ROOT}/.env"
  [ -f "${file}" ] || return 0
  local line key value
  while IFS= read -r line || [ -n "${line}" ]; do
    case "${line}" in
      WRATHBENCH_*=* | OPENROUTER_*=* | OPENCODE_*=* | CLAUDE_*=* | OPENAI_*=*) ;;
      *) continue ;;
    esac
    key="${line%%=*}"
    value="${line#*=}"
    # strip one layer of matching quotes
    case "${value}" in
      \"*\") value="${value:1:${#value}-2}" ;;
      \'*\') value="${value:1:${#value}-2}" ;;
    esac
    [ -n "${value}" ] || continue
    export "${key}=${value}"
  done <"${file}"
}

load_env

# The honest version marker, computed where git actually is.
WRATHBENCH_HARNESS_VERSION="$(git -C "${REPO_ROOT}" describe --tags --always --dirty 2>/dev/null || echo "0.0.0-phase0")"
export WRATHBENCH_HARNESS_VERSION

# ------------------------------------------------------------------ preflight

# `claude-subscription` is the old spelling of `claude-code`; the runner reads both.
if [ "${DRIVER}" = "claude-code" ] || [ "${DRIVER}" = "claude-subscription" ]; then
  echo "run-episode.sh: driver claude-code — the Claude Code CLI is the harness for this run; it is tagged, not excluded (see docs/METHODOLOGY.md)." >&2
  token_help() {
    cat >&2 <<EOF
run-episode.sh: ${TOKEN_ENV} is not available to the runner.
  1. run:  claude setup-token
  2. put the token in .env as ${TOKEN_ENV}=... (.env is gitignored)
     — .env, not just your shell: inside the container Bun loads it from
     /wrathbench/.env, which is how the token reaches the runner at all.
  (${TOKEN_ENV} is this run's subscription LANE; another subscription's
   token in another variable does not stand in for it.)
EOF
  }
  if [ "${LOCAL}" -eq 1 ] && [ -z "${!TOKEN_ENV:-}" ]; then
    token_help
    exit 2
  fi
  if [ "${LOCAL}" -eq 1 ]; then
    command -v claude >/dev/null 2>&1 || {
      echo "run-episode.sh: the claude CLI is not on PATH; install it or drop --local" >&2
      exit 2
    }
  else
    if ! docker compose -f "${COMPOSE_FILE}" exec -T "${SERVICE}" sh -c 'command -v claude' >/dev/null 2>&1; then
      cat >&2 <<'EOF'
run-episode.sh: the runner container has no `claude` CLI (its image is oven/bun).
  either install it into the runner service (npm i -g @anthropic-ai/claude-code),
  or run on the host with --local and point the runner at a reachable module:
      WRATHBENCH_MODULE_URL=http://127.0.0.1:8086 ./infra/run-episode.sh --model opus \
        --driver claude-code --local
  (the module port is not published to the host by default)
EOF
      exit 2
    fi
    # The token must be visible *there*, not here: check it in the container.
    # The `=` anchor is load-bearing: without it CLAUDE_CODE_OAUTH_TOKEN would
    # match a line that only sets CLAUDE_CODE_OAUTH_TOKEN_2.
    if ! docker compose -f "${COMPOSE_FILE}" exec -T -e "WRATHBENCH_TOKEN_ENV=${TOKEN_ENV}" "${SERVICE}" sh -c \
      '[ -n "$(eval echo "\${${WRATHBENCH_TOKEN_ENV}:-}")" ] || grep -q "^${WRATHBENCH_TOKEN_ENV}=." /wrathbench/.env' \
      >/dev/null 2>&1; then
      token_help
      exit 2
    fi
  fi
fi

# ------------------------------------------------------------------ launch

if [ "${LOCAL}" -eq 1 ]; then
  cd "${REPO_ROOT}"
  exec bun runner/src/run.ts "${PASSTHROUGH[@]}"
fi

exec docker compose -f "${COMPOSE_FILE}" exec -T \
  -e "WRATHBENCH_HARNESS_VERSION=${WRATHBENCH_HARNESS_VERSION}" \
  "${SERVICE}" bun runner/src/run.ts "${PASSTHROUGH[@]}"
