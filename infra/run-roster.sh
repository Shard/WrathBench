#!/usr/bin/env bash
#
# Overnight roster orchestrator: run one episode per model, sequentially.
#
#   ./infra/run-roster.sh infra/roster-example.json --until 07:30
#   ./infra/run-roster.sh infra/roster-example.json --dry-run
#
# A thin wrapper: it holds no secrets and does no preflight. Each episode is
# launched as a child `infra/run-episode.sh`, which is where .env loading,
# driver preflight and harness version stamping live. See infra/run-roster.ts.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

command -v bun >/dev/null 2>&1 || {
  echo "run-roster.sh: bun is not on PATH (the orchestrator runs on the host)" >&2
  exit 2
}

cd "${REPO_ROOT}"
exec bun infra/run-roster.ts "$@"
