#!/usr/bin/env bash
#
# Fleet orchestrator: one run-roster process per enabled job in the fleet config.
#
#   ./infra/run-fleet.sh --until 18:00
#   ./infra/run-fleet.sh --dry-run
#   ./infra/run-fleet.sh --status
#
# The config IS the fleet, and it is the config store (data/config.sqlite;
# docs/RUNBOOK.md "Where the config lives"): edit it on the viewer's /config
# page or with runner/src/config-store.ts while this runs and the supervisor
# follows (re-read every 60s). See infra/run-fleet.ts.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

command -v bun >/dev/null 2>&1 || {
  echo "run-fleet.sh: bun is not on PATH (the orchestrator runs on the host)" >&2
  exit 2
}

cd "${REPO_ROOT}"
exec bun infra/run-fleet.ts "$@"
