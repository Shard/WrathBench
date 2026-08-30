#!/usr/bin/env bash
# Restart the private LAN viewer (bun runner/viewer/serve.ts on :8090) with its
# standing env. Kill by pid — `pkill -f` on the pattern matches the caller.
set -euo pipefail
cd "$(dirname "$0")/.."
pid=$(ps -eo pid,args | grep "[b]un runner/viewer/serve.ts" | grep -v "bash -c" | awk '{print $1}' | head -1 || true)
[ -n "${pid:-}" ] && kill "$pid" && sleep 2
WRATHBENCH_MODULE_URL="${WRATHBENCH_MODULE_URL:-http://192.168.192.3:8086}" \
WRATHBENCH_VIEWER_LAN="${WRATHBENCH_VIEWER_LAN:-1}" \
WRATHBENCH_FLEET_CONFIG="${WRATHBENCH_FLEET_CONFIG:-infra/fleet.json}" \
  setsid nohup bun runner/viewer/serve.ts > data/viewer.log 2>&1 < /dev/null &
sleep 4
curl -s -o /dev/null -w 'viewer: http %{http_code} on :8090\n' http://127.0.0.1:8090/api/info
