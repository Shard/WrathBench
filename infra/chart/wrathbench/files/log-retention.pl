#!/usr/bin/perl
# Server log retention: the module's per-session audit log, pruned by age.
#
# The worldserver writes one JSONL file per session token and UTC day under
# WrathBench.AuditDir, `<token>.<YYYY-MM-DD>.jsonl`, rolling to the next day's
# at the first record after midnight UTC (module/PROTOCOL.md "Audit log").
# The chart's log-retention CronJob (templates/log-retention.yaml) runs this
# once a day from the worldserver image, which is where perl is, against the
# same `logs` subPath of the data PVC. `bun wb server log-retention` runs the
# same file, over stdin, inside the worldserver container as a dry run.
#
# Why perl and not `find -mtime -delete`: the one thing retention must never
# do is unlink a file the server will still write to — the server would keep
# writing into an inode nobody can see, the disk would not come back until the
# session ended, and the session's record would go with it. Three rules keep
# it off such a file, and each needs more than find:
#
#   delete   a day file dated before today (UTC) that is quiet for the window.
#            The writer only ever opens the current day's file and never a
#            past date, so a past day's file gets no further write by
#            construction, whatever the server's start time; a session that
#            went idle before midnight may still hold the descriptor, and the
#            unlinked inode goes with its next record, which rolls the file.
#   delete   an undated `<token>.jsonl` (the form before day files; left over
#            until it ages out) quiet for the window AND last written before
#            the current server process started. Such a file was held for its
#            session's life, and age alone did not prove it closed: a session
#            whose run died without logging out stands idle in the world with
#            its file open and nothing to write. The server writes a
#            `session_create` line the moment it opens a file, so a file the
#            running process holds has an mtime after its start; one older
#            than the start is held by nobody. The start comes from the
#            module's GET /health (`startedAtMs`), with the port secret. The
#            same rule covers today's day file, which can only be quiet for
#            the window under a window shorter than a day.
#   truncate what the second rule reaches but cannot delete, written since
#            the start: it is almost certainly closed, and if it is not, the
#            writer opened it O_APPEND, so emptying it in place loses nothing
#            that follows and frees the space now. The empty file is deleted
#            by the second rule after the next server restart.
#
# With the server unreachable only past days are deleted; the rest is
# truncated. Inside the worldserver container (the dry run) /proc/1 is the
# server itself, and a file any of its descriptors point at is never touched
# whatever the rules say; the dry run reports that count, so a non-zero
# `held` would be a session idle across midnight (harmless) or, for an
# undated file, the proof failing. One readdir, one stat per file, no content
# read; unlink and truncate are metadata operations.
#
# File names are session tokens. Nothing here prints one or passes one to
# another program: counts and bytes only.
#
# Environment: WRATHBENCH_AUDIT_DIR, WRATHBENCH_LOG_RETENTION_DAYS (0 or empty
# disables), WRATHBENCH_MODULE_HOST (host:port), WRATHBENCH_MODULE_SECRET (or
# AC_WRATH_BENCH_SECRET, the worldserver's own), DRY_RUN (non-empty: report
# only), WRATHBENCH_RETENTION_HOLDER_PID (the process whose descriptors are
# checked; default 1 when that is a worldserver).
use strict;
use warnings;
use IO::Socket::INET;
use POSIX qw(strftime);

my $dir    = $ENV{WRATHBENCH_AUDIT_DIR} // '/azerothcore/env/dist/logs/wrathbench';
my $days   = $ENV{WRATHBENCH_LOG_RETENTION_DAYS} // '';
my $dry    = defined $ENV{DRY_RUN} && $ENV{DRY_RUN} ne '' && $ENV{DRY_RUN} ne '0';
my $host   = $ENV{WRATHBENCH_MODULE_HOST} // 'worldserver:8086';
my $secret = $ENV{WRATHBENCH_MODULE_SECRET} // $ENV{AC_WRATH_BENCH_SECRET} // '';
my $margin = 60;    # seconds; the server's clock and the file system's are the same node's, this is slack

if ($days eq '' || $days !~ /^\d+(?:\.\d+)?$/ || $days == 0) {
    print "log retention: disabled (WRATHBENCH_LOG_RETENTION_DAYS is '$days'); nothing to do\n";
    exit 0;
}
my $window = $days * 86400;
my $now    = time;
my $cutoff = $now - $window;
my $today  = strftime('%Y-%m-%d', gmtime $now);    # the day file the writer opens now; any earlier date is closed to it

# --- the server's start, from the module -----------------------------------
my ($started, $sessions, $health_note);
if ($secret eq '') {
    $health_note = 'no module secret in the environment';
}
else {
    # Bounded: the whole exchange has ten seconds, and the body is read to its
    # Content-Length rather than to a close the server may never send.
    my $r = eval {
        local $SIG{ALRM} = sub { die "timeout\n" };
        alarm 10;
        my $s = IO::Socket::INET->new(PeerAddr => $host, Timeout => 5) or die "unreachable\n";
        print $s "GET /health HTTP/1.0\r\nAuthorization: Bearer $secret\r\nHost: $host\r\nConnection: close\r\n\r\n";
        my $buf = '';
        while ($buf !~ /\r\n\r\n/) { defined(sysread $s, $buf, 65536, length $buf) && length $buf < 1_000_000 or last; last if $buf =~ /\r\n\r\n/ || eof $s }
        my ($want) = $buf =~ /^Content-Length:\s*(\d+)/mi;
        my $head = index($buf, "\r\n\r\n") + 4;
        while (defined $want ? length($buf) - $head < $want : 1) {
            my $n = sysread $s, $buf, 65536, length $buf;
            last if !defined $n || $n == 0 || length $buf > 1_000_000;
        }
        close $s;
        alarm 0;
        $buf;
    };
    alarm 0;
    if (!defined $r) {
        my $why = $@ // 'failed';
        chomp $why;
        $health_note = "module at $host $why";
    }
    else {
        if ($r =~ m{^HTTP/\S+ 200 } && $r =~ /"startedAtMs"\s*:\s*(\d+)/) {
            $started  = int($1 / 1000);
            $sessions = $r =~ /"sessions"\s*:\s*(\d+)/ ? $1 : undef;
        }
        else {
            my ($status) = $r =~ m{^HTTP/\S+ (\d+)};
            $health_note = 'module answered ' . ($status // 'nothing') . ' to GET /health';
        }
    }
}

# --- descriptors the server holds, when this runs beside it ----------------
my $holder = $ENV{WRATHBENCH_RETENTION_HOLDER_PID};
if (!defined $holder || $holder eq '') {
    my $comm = '';
    if (open my $c, '<', '/proc/1/comm') { $comm = <$c> // ''; close $c; chomp $comm }
    $holder = $comm eq 'worldserver' ? 1 : undef;
}
my %held;    # "dev:ino" => 1
my $held_checked = 0;
if (defined $holder && opendir my $fdd, "/proc/$holder/fd") {
    for my $fd (readdir $fdd) {
        next if $fd eq '.' || $fd eq '..';
        my @st = stat "/proc/$holder/fd/$fd" or next;
        $held{"$st[0]:$st[1]"} = 1;
    }
    closedir $fdd;
    $held_checked = 1;
}

# --- the pass ---------------------------------------------------------------
opendir my $dh, $dir or do { print STDERR "log retention: cannot read the audit dir: $!\n"; exit 1 };
my %n = map { $_ => 0 } qw(deleted pastday truncated kept empty held failed);
my %b = map { $_ => 0 } qw(deleted pastday truncated kept held);
for my $name (readdir $dh) {
    next if $name eq '.' || $name eq '..';
    my $path = "$dir/$name";
    my @st = lstat $path or next;
    next unless -f _;    # plain files only; never follow a link, never recurse
    my ($dev, $ino, $size, $mtime) = @st[0, 1, 7, 9];
    if ($mtime > $cutoff) { $n{kept}++; $b{kept} += $size; next }
    if ($held{"$dev:$ino"}) { $n{held}++; $b{held} += $size; next }
    # The date is the name's last dotted part before .jsonl: a token may carry
    # dots of its own, so nothing earlier in the name is read.
    my ($date) = $name =~ /\.(\d{4}-\d{2}-\d{2})\.jsonl\z/;
    my $pastday = defined $date && $date lt $today;
    if ($pastday || (defined $started && $mtime < $started - $margin)) {
        if ($dry || unlink $path) { $n{deleted}++; $b{deleted} += $size; if ($pastday) { $n{pastday}++; $b{pastday} += $size } } else { $n{failed}++ }
        next;
    }
    if ($size == 0) { $n{empty}++; next }
    if ($dry || truncate $path, 0) { $n{truncated}++; $b{truncated} += $size } else { $n{failed}++ }
}
closedir $dh;

# --- the report: counts and bytes, never a name -----------------------------
my $gb = sub { sprintf '%.2f GB', $_[0] / 1e9 };
my $server = defined $started
    ? 'server started ' . strftime('%Y-%m-%dT%H:%M:%SZ', gmtime $started) . (defined $sessions ? ", $sessions live session(s)" : '')
    : "server start unknown ($health_note): only past days deleted this run, other quiet files truncated";
print "log retention: window ${days}d, $server\n";
printf "  deleted:   %5d files, %s  (quiet for the window: %d past day file(s), %s; the rest closed before the server started)\n", $n{deleted}, $gb->($b{deleted}), $n{pastday}, $gb->($b{pastday});
printf "  truncated: %5d files, %s  (quiet for the window, written since the server started: emptied in place, deleted after the next restart)\n", $n{truncated}, $gb->($b{truncated});
printf "  kept:      %5d files, %s  (written within the window)\n", $n{kept}, $gb->($b{kept});
printf "  empty:     %5d files              (already emptied, awaiting a server restart)\n", $n{empty};
printf "  held:      %5d files, %s  (open in the server process beside this run; never touched)\n", $n{held}, $gb->($b{held}) if $held_checked;
printf "  failed:    %5d files              (the operation was refused; see the job's exit status)\n", $n{failed} if $n{failed};
print "  dry run: nothing was changed\n" if $dry;
exit($n{failed} ? 1 : 0);
