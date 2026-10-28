#!/usr/bin/perl
# One run's module audit log, reduced where it lives: in the worldserver
# container (perl-base, no modules), so a gigabyte of audit never crosses the
# wire. infra/inspect-audit.ts sends this text as `perl -e` and reads its
# output; `bun wb inspect audit` is the way to run it.
#
# The audit files are named after the session token, so the token is handled
# as the secret it is. It arrives as the first line of stdin and nowhere else:
# never in argv. Files are found with readdir and opened by open() in this
# process, so no command line anywhere carries a file name. Nothing printed
# names a file, and every record printed has the token struck and its session
# field replaced before it is cut short (a cut through a token would leave a
# prefix no strike matches).
#
# argv (none of it secret; '-' for none):
#   mode    summary | records
#   op      keep only these ops (actions) or opcodes (events), comma-separated
#   status  keep only this status
#   since   epoch ms: skip older records, and day files from before its UTC day
#   until   epoch ms: skip newer records
#   last    records: how many of the newest matches to print (default 20)
#   cap     records: bytes kept of each printed record (default 600)
#
# Output, tab-separated:
#   F <files> <bytes>                the files read, counted, never named
#   R <records> <first> <last>       records in the window, and their clock span
#   M <matched>                      how many matched the filters
#   C <kind> <name> <status> <n>     summary: one per kind, op or opcode, and status, of the matches
#   L <record>                       records: one of the last matches, struck and capped
#
# The audit directory is $WB_AUDIT_DIR, else the module's own
# $AC_WRATH_BENCH_AUDIT_DIR, else the image's default.
use strict;
use warnings;

my ($mode, $op, $status, $since, $until, $last, $cap) = @ARGV;
$mode = 'summary' if !defined $mode || $mode ne 'records';
$op = '' if !defined $op || $op eq '-';
my %ops = map { $_ => 1 } grep { $_ ne '' } split /,/, $op;
$status = '' if !defined $status || $status eq '-';
$since = 0 if !defined $since || $since !~ /\A\d+\z/;
$until = 0 if !defined $until || $until !~ /\A\d+\z/;
$last = 20 if !defined $last || $last !~ /\A\d+\z/ || $last < 1;
$cap = 600 if !defined $cap || $cap !~ /\A\d+\z/ || $cap < 80;

my $dir = $ENV{WB_AUDIT_DIR} || $ENV{AC_WRATH_BENCH_AUDIT_DIR} || '/azerothcore/env/dist/logs/wrathbench';
my $tok = <STDIN>;
die "inspect-audit: no token on stdin\n" unless defined $tok;
$tok =~ s/[\r\n]+\z//;
die "inspect-audit: an empty token\n" if $tok eq '';
# A smoke's sessions rather than one run's: the line `smoke-<name>-*` names
# the fixed part of the tokens a smoke gives its sessions (infra/smoke:
# `smoke-<name>-<uuid>`, which no run's token starts with; the name may hold
# hyphens), and every file of a session it names is read — the name exactly:
# what follows it must open with the uuid's first eight hex digits, so
# `quest` does not read `quest-item-start`'s, nor `group` `group-a`'s. The
# prefix is no secret; the rest of each token is, and is struck wherever it
# appears.
my $smoke = $tok =~ /\Asmoke-[a-z0-9]+(?:-[a-z0-9]+)*-\*\z/;
$tok =~ s/\*\z// if $smoke;
# The module names the file after the token with every byte outside
# [A-Za-z0-9_-] as '_' (module/PROTOCOL.md, "Audit log").
(my $ftok = $tok) =~ s/[^A-Za-z0-9_-]/_/g;

sub utc_day {
  my @g = gmtime(int($_[0] / 1000));
  return sprintf('%04d-%02d-%02d', $g[5] + 1900, $g[4] + 1, $g[3]);
}
my $since_day = $since > 0 ? utc_day($since) : '';
my $until_day = $until > 0 ? utc_day($until) : '';

opendir(my $dh, $dir) or die "inspect-audit: cannot read the audit directory\n";
my $undated;
my @days;
my $prefix = "$ftok.";
my @smoked;
while (defined(my $n = readdir $dh)) {
  if ($smoke) {
    if ($n =~ /\A\Q$ftok\E[0-9a-f]{8}-[A-Za-z0-9_-]*\.(\d{4}-\d\d-\d\d)\.jsonl\z/) {
      my $day = $1;
      next if $since_day ne '' && $day lt $since_day;
      next if $until_day ne '' && $day gt $until_day;
      push @smoked, [$day, $n];
    } elsif ($n =~ /\A\Q$ftok\E[0-9a-f]{8}-[A-Za-z0-9_-]*\.jsonl\z/) {
      push @smoked, ['', $n];
    }
    next;
  }
  if ($n eq "$ftok.jsonl") { $undated = $n; next; }
  next unless length($n) == length($ftok) + 17 && substr($n, 0, length($prefix)) eq $prefix && substr($n, -6) eq '.jsonl';
  my $day = substr($n, length($prefix), 10);
  next unless $day =~ /\A\d{4}-\d\d-\d\d\z/;
  next if $since_day ne '' && $day lt $since_day;
  next if $until_day ne '' && $day gt $until_day;
  push @days, [$day, $n];
}
closedir $dh;
# The order the runbook copies them in: the undated file from before day files, then the days.
my @files = ((defined $undated ? ($undated) : ()), map { $_->[1] } sort { $a->[0] cmp $b->[0] } @days);
@files = map { $_->[1] } sort { $a->[0] cmp $b->[0] || $a->[1] cmp $b->[1] } @smoked if $smoke;

# Records are appended in clock order, so a big file that straddles `since`
# is bisected to about where `since` falls instead of read from the top: a
# long run's undated file is gigabytes. The per-record check below still
# decides; this only skips what it would have skipped.
sub seek_since {
  my ($fh, $size, $from) = @_;
  my ($lo, $hi) = (0, $size);
  while ($hi - $lo > 65536) {
    my $mid = int(($lo + $hi) / 2);
    seek($fh, $mid, 0);
    my $partial = <$fh>;
    my $probe = <$fh>;
    my ($ts) = defined $probe ? $probe =~ /\A\{"ts":(\d+)/ : ();
    if (defined $ts && $ts < $from) { $lo = $mid } else { $hi = $mid }
  }
  seek($fh, $lo, 0);
  my $partial = $lo > 0 ? <$fh> : undef;
}

my ($bytes, $records, $matched) = (0, 0, 0);
my ($first, $newest);
my %count;
my @ring;
my $qtok = $smoke ? quotemeta($tok) . '[A-Za-z0-9_-]*' : quotemeta $tok;
# One anchored match takes a record's clock, kind and op or opcode, in the
# order the module writes them; anything else falls back to looser searches.
my $shape = qr/\A\{"ts":(\d+),"session":"[^"]*","kind":"([A-Za-z_]+)","payload":\{(?:"seq":\d+,)?"(?:op|opcode)":"([A-Za-z0-9_]+)"/;
for my $n (@files) {
  my $path = "$dir/$n";
  my $size = -s $path;
  $bytes += $size if defined $size;
  open(my $fh, '<', $path) or next;
  seek_since($fh, $size, $since) if $since > 0 && defined $size && $size > 1048576;
  while (my $line = <$fh>) {
    my ($ts, $kind, $name);
    if ($line =~ $shape) {
      ($ts, $kind, $name) = ($1, $2, $3);
    } else {
      my $head = substr($line, 0, 400);
      ($ts) = $head =~ /\A\{"ts":(\d+)/;
      ($kind) = $head =~ /"kind":"([A-Za-z_]+)"/;
      ($name) = $head =~ /"(?:op|opcode)":"([A-Za-z0-9_]+)"/;
    }
    next if $since > 0 && (!defined $ts || $ts < $since);
    next if $until > 0 && defined $ts && $ts > $until;
    $records++;
    if (defined $ts) {
      $first = $ts if !defined $first || $ts < $first;
      $newest = $ts if !defined $newest || $ts > $newest;
    }
    $kind = '?' unless defined $kind;
    $name = '?' unless defined $name;
    my $st = '-';
    my $at = index($line, '"status":"');
    if ($at >= 0 && $at < 400) {
      my $end = index($line, '"', $at + 10);
      $st = substr($line, $at + 10, $end - $at - 10) if $end > $at + 10 && $end - $at < 80;
    }
    next if %ops && !exists $ops{$name};
    next if $status ne '' && $st ne $status;
    $matched++;
    if ($mode eq 'summary') {
      $count{"$kind\t$name\t$st"}++;
      next;
    }
    $line =~ s/[\r\n]+\z//;
    $line =~ s/$qtok/[redacted]/g;
    $line =~ s/"session":"[^"]*"/"session":"[redacted]"/;
    $line = substr($line, 0, $cap) if length($line) > $cap;
    push @ring, $line;
    # Several sessions' files interleave in time: keep every match and take
    # the newest after (a smoke's window is small); one session's are in order.
    shift @ring if @ring > $last && !$smoke;
  }
  close $fh;
}
if ($smoke) {
  my $at = sub { my ($t) = $_[0] =~ /\A\{"ts":(\d+)/; defined $t ? $t : 0 };
  @ring = sort { $at->($a) <=> $at->($b) } @ring;
  splice(@ring, 0, @ring - $last) if @ring > $last;
}

print "F\t", scalar(@files), "\t$bytes\n";
print "R\t$records\t", (defined $first ? $first : '-'), "\t", (defined $newest ? $newest : '-'), "\n";
print "M\t$matched\n";
if ($mode eq 'summary') {
  print "C\t$_\t$count{$_}\n" for sort keys %count;
} else {
  print "L\t$_\n" for @ring;
}
