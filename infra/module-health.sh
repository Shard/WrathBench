#!/usr/bin/env bash
# The module's operator health census (sessions, leases, limits, drop counts
# by opcode, the world-load counts behind `worldLoaded`). The module gives the
# census to the port secret's holder, wherever it calls from; a lease secret
# gets liveness with zeroed counters (wrath-mcp/module/PROTOCOL.md, "GET
# /health"). The probe runs inside the worldserver container because that is
# where the port secret is (AC_WRATH_BENCH_SECRET), not because of the
# address. The image has no curl or wget — perl is what it does have.
#
# The worldserver is a Deployment in namespace `wrathbench`:
#
#   ./infra/module-health.sh             # kubectl exec into the worldserver pod
set -Eeuo pipefail

NAMESPACE="${WRATHBENCH_K8S_NAMESPACE:-wrathbench}"
RELEASE="${WRATHBENCH_K8S_RELEASE:-wrathbench}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --namespace|-n) NAMESPACE="${2:-}"; shift 2 ;;
    --release) RELEASE="${2:-}"; shift 2 ;;
    *) echo "module-health: unknown argument $1" >&2; exit 2 ;;
  esac
done

PROBE='
  my $s = IO::Socket::INET->new("localhost:8086") or die "connect: $!\n";
  print $s "GET /health HTTP/1.0\r\nAuthorization: Bearer $ENV{AC_WRATH_BENCH_SECRET}\r\n\r\n";
  local $/; my $r = <$s>; my ($b) = $r =~ /\r\n\r\n(.*)/s; print $b, "\n";'

exec kubectl -n "${NAMESPACE}" exec -i "deployment/${RELEASE}-worldserver" -c worldserver -- perl -MIO::Socket::INET -e "${PROBE}"
