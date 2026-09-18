#!/usr/bin/env bash
# The module's operator health census (sessions, drop counts by opcode), read
# over loopback inside the worldserver container, which is the only caller the
# module gives the census to; any other caller gets liveness with zeroed
# counters (module/PROTOCOL.md, "Authentication"). The image has no curl or
# wget — perl is what it does have.
#
# CLUSTER-NATIVE since 2026-09-11: the worldserver is a Deployment in namespace
# `wrathbench`. `--compose` is the local rehearsal
# path against infra/compose.yml.
#
#   ./infra/module-health.sh             # kubectl exec into the worldserver pod
#   ./infra/module-health.sh --compose   # the compose rehearsal stack
set -Eeuo pipefail
cd "$(dirname "$0")/.."

NAMESPACE="${WRATHBENCH_K8S_NAMESPACE:-wrathbench}"
RELEASE="${WRATHBENCH_K8S_RELEASE:-wrathbench}"
COMPOSE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --compose) COMPOSE=1; shift ;;
    --namespace|-n) NAMESPACE="${2:-}"; shift 2 ;;
    --release) RELEASE="${2:-}"; shift 2 ;;
    *) echo "module-health: unknown argument $1" >&2; exit 2 ;;
  esac
done

PROBE='
  my $s = IO::Socket::INET->new("localhost:8086") or die "connect: $!\n";
  print $s "GET /health HTTP/1.0\r\nAuthorization: Bearer $ENV{AC_WRATH_BENCH_SECRET}\r\n\r\n";
  local $/; my $r = <$s>; my ($b) = $r =~ /\r\n\r\n(.*)/s; print $b, "\n";'

if [[ "${COMPOSE}" -eq 1 ]]; then
  exec docker compose -f infra/compose.yml exec -T worldserver perl -MIO::Socket::INET -e "${PROBE}"
fi
exec kubectl -n "${NAMESPACE}" exec -i "deployment/${RELEASE}-worldserver" -- perl -MIO::Socket::INET -e "${PROBE}"
