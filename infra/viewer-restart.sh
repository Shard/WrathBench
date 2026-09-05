#!/usr/bin/env bash
# Restart the private LAN viewer (bun runner/viewer/serve.ts on :8090).
#
# When the systemd user unit is installed (infra/wrathbench-viewer.service),
# that is what owns the process and a restart goes through it — the unit is
# what brings the viewer back after a reboot, and a nohup launch beside it
# would race for the port. Without the unit, fall back to the old detached
# launch. Kill by pid either way — `pkill -f` on the pattern matches the caller.
set -euo pipefail
cd "$(dirname "$0")/.."
if systemctl --user cat wrathbench-viewer.service >/dev/null 2>&1; then
  systemctl --user restart wrathbench-viewer
else
  pid=$(ps -eo pid,args | grep "[b]un runner/viewer/serve.ts" | grep -v "bash -c" | awk '{print $1}' | head -1 || true)
  [ -n "${pid:-}" ] && kill "$pid" && sleep 2
  WRATHBENCH_MODULE_URL="${WRATHBENCH_MODULE_URL:-http://192.168.192.3:8086}" \
  WRATHBENCH_VIEWER_LAN="${WRATHBENCH_VIEWER_LAN:-1}" \
  WRATHBENCH_FLEET_CONFIG="${WRATHBENCH_FLEET_CONFIG:-infra/fleet.json}" \
    setsid nohup bun runner/viewer/serve.ts > data/viewer.log 2>&1 < /dev/null &
fi
sleep 4
curl -s -o /dev/null -w 'viewer: http %{http_code} on :8090\n' http://127.0.0.1:8090/api/info
