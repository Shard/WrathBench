#!/usr/bin/env bash
#
# Fleet orchestrator: one run-roster process per enabled job in fleet.json.
#
#   ./infra/run-fleet.sh infra/fleet.json --until 18:00
#   ./infra/run-fleet.sh infra/fleet.json --dry-run
#   ./infra/run-fleet.sh --status
#
# The config IS the fleet: edit infra/fleet.json while this runs and the
# supervisor follows (re-read every 60s). See infra/run-fleet.ts.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

command -v bun >/dev/null 2>&1 || {
  echo "run-fleet.sh: bun is not on PATH (the orchestrator runs on the host)" >&2
  exit 2
}

cd "${REPO_ROOT}"
exec bun infra/run-fleet.ts "$@"
