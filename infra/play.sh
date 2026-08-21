#!/usr/bin/env bash
# Launch the local 3.3.5a client against this machine's WrathBench server as
# the SPECTATOR (GM) account. Operator tooling — see infra/SPECTATOR.md for the
# GM commands and the do-not-interfere etiquette during measured runs.
#
#   ./infra/play.sh            # launch (windowed by default)
#   ./infra/play.sh --check    # preflight only, no launch
#
# The client stays exactly where it lives for extraction; only realmlist.wtf
# and Config.wtf (both client-side settings files) are touched.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLIENT_DIR="${WRATHBENCH_CLIENT_DIR:-$REPO/data/client-source/ChromieCraft_3.3.5a}"
WINEPREFIX="${WRATHBENCH_WINEPREFIX:-$HOME/.wrathbench-wine}"
export WINEPREFIX

fail() { echo "play.sh: $*" >&2; exit 1; }

[ -f "$CLIENT_DIR/Wow.exe" ] || fail "no Wow.exe under $CLIENT_DIR (set WRATHBENCH_CLIENT_DIR)"
command -v wine >/dev/null || fail "wine not installed"

# Point the client at this machine. Both files are client config, not server
# state; the account name prefill saves typing (password is typed in-game).
printf 'set realmlist 127.0.0.1\n' > "$CLIENT_DIR/Data/enUS/realmlist.wtf"
mkdir -p "$CLIENT_DIR/WTF"
CONFIG="$CLIENT_DIR/WTF/Config.wtf"
touch "$CONFIG"
grep -v '^SET accountName ' "$CONFIG" > "$CONFIG.tmp" || true
printf 'SET accountName "SPECTATOR"\n' >> "$CONFIG.tmp"
mv "$CONFIG.tmp" "$CONFIG"

# Preflight: the realm must be reachable from the host.
ok=1
if ! (exec 3<>/dev/tcp/127.0.0.1/3724) 2>/dev/null; then
  echo "  ✗ authserver not reachable on 127.0.0.1:3724 (is the stack up?)"; ok=0
else
  exec 3<&- 3>&- || true
  echo "  ✓ authserver reachable on 127.0.0.1:3724"
fi
if ! (exec 3<>/dev/tcp/127.0.0.1/8085) 2>/dev/null; then
  echo "  ✗ worldserver not reachable on 127.0.0.1:8085"
  echo "    (the world port goes live when the worldserver container is next"
  echo "     recreated — you can reach the realm list but not enter the world)"
  ok=0
else
  exec 3<&- 3>&- || true
  echo "  ✓ worldserver reachable on 127.0.0.1:8085"
fi

[ "${1:-}" = "--check" ] && exit $((1 - ok))
if [ "$ok" -ne 1 ]; then
  echo "launching anyway (login screen will work; world entry needs both ports)"
fi

echo "launching client (account SPECTATOR — password in infra/SPECTATOR.md notes)"
cd "$CLIENT_DIR"
exec wine Wow.exe -windowed
