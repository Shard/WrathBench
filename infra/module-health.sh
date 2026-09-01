#!/usr/bin/env bash
# The module's operator health census (sessions, drop counts by opcode), read
# over loopback inside the worldserver container, which is the only caller the
# module gives the census to; any other caller gets liveness with zeroed
# counters (module/PROTOCOL.md, "Authentication"). The image has no curl or
# wget — perl is what it does have.
set -euo pipefail
cd "$(dirname "$0")/.."
exec docker compose -f infra/compose.yml exec -T worldserver perl -MIO::Socket::INET -e '
  my $s = IO::Socket::INET->new("localhost:8086") or die "connect: $!\n";
  print $s "GET /health HTTP/1.0\r\nAuthorization: Bearer $ENV{AC_WRATH_BENCH_SECRET}\r\n\r\n";
  local $/; my $r = <$s>; my ($b) = $r =~ /\r\n\r\n(.*)/s; print $b, "\n";'
