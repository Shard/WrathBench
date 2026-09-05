#!/usr/bin/env bash
#
# Operator entry point for one episode.
#
#   ./infra/run-episode.sh --model <id> [--driver openai|claude-code|codex|stub]
#   ./infra/run-episode.sh --resume <run-id>
#   ./infra/run-episode.sh --model <id> --local           # outside the container
#   ./infra/run-episode.sh --model <id> --k8s             # into the runner pod
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
# --k8s: the same exec, into the Kubernetes runner Deployment instead of the
# compose service. Same image, same repo (baked in rather than bind-mounted),
# same .env-free secret handling — the pod carries the keys as env from the
# wrathbench-env Secret, so nothing travels through argv there either.
K8S=0
K8S_NAMESPACE="${WRATHBENCH_K8S_NAMESPACE:-wrathbench}"
K8S_RELEASE="${WRATHBENCH_K8S_RELEASE:-wrathbench}"

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
# actually use, and names it when it is missing. Empty means "the driver's
# default": CLAUDE_CODE_OAUTH_TOKEN for claude-code, CODEX_HOME for codex.
TOKEN_ENV=""
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
    --k8s)
      K8S=1
      shift
      ;;
    --namespace)
      K8S_NAMESPACE="${2:-}"
      shift 2
      ;;
    --release)
      K8S_RELEASE="${2:-}"
      shift 2
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
      WRATHBENCH_*=* | OPENROUTER_*=* | OPENCODE_*=* | CLAUDE_*=* | OPENAI_*=* | CODEX_*=*) ;;
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
  [ -n "${TOKEN_ENV}" ] || TOKEN_ENV="CLAUDE_CODE_OAUTH_TOKEN"
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
  elif [ "${K8S}" -eq 1 ]; then
    if ! kubectl -n "${K8S_NAMESPACE}" exec -i "deployment/${K8S_RELEASE}-runner" -- sh -c 'command -v claude' >/dev/null 2>&1; then
      echo "run-episode.sh: the runner pod has no \`claude\` CLI — check the image tag" >&2
      exit 2
    fi
    # The token must be visible *there*, not here. On Kubernetes it arrives as
    # env from the Secret, not from a .env file, so this is an env check only.
    if ! kubectl -n "${K8S_NAMESPACE}" exec -i "deployment/${K8S_RELEASE}-runner" \
      -- sh -c "[ -n \"\${${TOKEN_ENV}:-}\" ]" >/dev/null 2>&1; then
      cat >&2 <<EOF
run-episode.sh: ${TOKEN_ENV} is not set in the runner pod.
  It comes from the ${K8S_NAMESPACE}/wrathbench-env Secret, whose keys are the
  .env names. Add the key there (the cluster repo owns it) and let the
  Deployment roll; ${TOKEN_ENV} is this run's subscription LANE and another
  subscription's token in another variable does not stand in for it.
EOF
      exit 2
    fi
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

# The codex driver: the OpenAI Codex CLI on a ChatGPT subscription. Its lane
# variable names a DIRECTORY (a logged-in Codex home holding auth.json), not a
# token, and it is never copied per run — one directory per lane, shared by
# that lane's runs, one live session per lane (runner/README.md, Drivers).
if [ "${DRIVER}" = "codex" ]; then
  [ -n "${TOKEN_ENV}" ] || TOKEN_ENV="CODEX_HOME"
  echo "run-episode.sh: driver codex — the Codex CLI is the harness for this run; it is tagged, not excluded (see docs/METHODOLOGY.md)." >&2
  codex_help() {
    cat >&2 <<EOF
run-episode.sh: ${TOKEN_ENV} does not name a logged-in Codex home for the runner.
  1. run:  codex login          (a ChatGPT subscription; the login lands in ~/.codex/auth.json)
  2. put the directory in .env as ${TOKEN_ENV}=/home/<you>/.codex (.env is gitignored)
     — that value is the HOST path, which is what --local uses. Inside the
     container the directory is BIND-MOUNTED at /home/bun/.codex and the
     compose service sets CODEX_HOME to it (infra/compose.yml, x-codex-lane);
     Bun's autoload does not overwrite a variable already set, so .env keeps
     naming the host path. On Kubernetes the Secret names a mounted path.
  (${TOKEN_ENV} is this run's subscription LANE. Never copy auth.json per run:
   its refresh token is spent by whichever process refreshes first, and the
   other side then fails with "refresh token was already used".)
EOF
  }
  if [ "${LOCAL}" -eq 1 ]; then
    command -v codex >/dev/null 2>&1 || {
      echo "run-episode.sh: the codex CLI is not on PATH; install @openai/codex@0.153.4 or drop --local" >&2
      exit 2
    }
    if [ -z "${!TOKEN_ENV:-}" ] || [ ! -f "${!TOKEN_ENV}/auth.json" ]; then
      codex_help
      exit 2
    fi
  elif [ "${K8S}" -eq 1 ]; then
    if ! kubectl -n "${K8S_NAMESPACE}" exec -i "deployment/${K8S_RELEASE}-runner" -- sh -c 'command -v codex' >/dev/null 2>&1; then
      echo "run-episode.sh: the runner pod has no \`codex\` CLI — check the image tag" >&2
      exit 2
    fi
    # The lane must be visible *there*: a directory the pod can read, named by
    # env from the Secret. A logged-in home has to be mounted into the pod;
    # the path alone proves nothing, so the check is for auth.json in it.
    if ! kubectl -n "${K8S_NAMESPACE}" exec -i "deployment/${K8S_RELEASE}-runner" \
      -- sh -c "[ -f \"\${${TOKEN_ENV}:-}/auth.json\" ]" >/dev/null 2>&1; then
      cat >&2 <<EOF
run-episode.sh: ${TOKEN_ENV} does not name a logged-in Codex home in the runner pod.
  It comes from the ${K8S_NAMESPACE}/wrathbench-env Secret (the .env names) and
  must point at a directory mounted into the pod that holds auth.json.
EOF
      exit 2
    fi
  else
    if ! docker compose -f "${COMPOSE_FILE}" exec -T "${SERVICE}" sh -c 'command -v codex' >/dev/null 2>&1; then
      cat >&2 <<'EOF'
run-episode.sh: the runner container has no `codex` CLI.
  either rebuild the runner image (infra/docker/runner.Dockerfile installs
  @openai/codex@0.153.4 since 2026-09-05; the running container predates it),
  or run on the host with --local and point the runner at a reachable module:
      WRATHBENCH_MODULE_URL=http://127.0.0.1:8086 ./infra/run-episode.sh --model gpt-6-astra \
        --driver codex --local
  (the module port is not published to the host by default)
EOF
      exit 2
    fi
    if ! docker compose -f "${COMPOSE_FILE}" exec -T -e "WRATHBENCH_TOKEN_ENV=${TOKEN_ENV}" "${SERVICE}" sh -c \
      '[ -f "$(eval echo "\${${WRATHBENCH_TOKEN_ENV}:-}")/auth.json" ]' \
      >/dev/null 2>&1; then
      codex_help
      exit 2
    fi
  fi
fi

# ------------------------------------------------------------------ launch

if [ "${LOCAL}" -eq 1 ]; then
  cd "${REPO_ROOT}"
  exec bun runner/src/run.ts "${PASSTHROUGH[@]}"
fi

if [ "${K8S}" -eq 1 ]; then
  # The pod has no .git, so the stamp cannot be recomputed there; the chart
  # already sets WRATHBENCH_HARNESS_VERSION from the image tag, which is the
  # honest marker for a baked-in repo. Passing the workstation's `git describe`
  # would claim a revision the pod is not running.
  exec kubectl -n "${K8S_NAMESPACE}" exec -i "deployment/${K8S_RELEASE}-runner" \
    -- bun runner/src/run.ts "${PASSTHROUGH[@]}"
fi

exec docker compose -f "${COMPOSE_FILE}" exec -T \
  -e "WRATHBENCH_HARNESS_VERSION=${WRATHBENCH_HARNESS_VERSION}" \
  "${SERVICE}" bun runner/src/run.ts "${PASSTHROUGH[@]}"
