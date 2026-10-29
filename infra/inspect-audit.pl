#!/usr/bin/perl
# One run's module audit log, reduced where it lives: in the worldserver
# container (perl-base, no modules), so a gigabyte of audit never crosses the
# wire. infra/inspect-audit.ts sends this text as `perl -e` and reads its
# output; `bun wb inspect audit` is the way to run it.
#
# The module names a session's files by a fingerprint of its token, the first
# 16 hex characters of its SHA-256 (wrath-mcp/module/PROTOCOL.md, "Audit log"),
# which the host computes and sends: perl-base has no SHA-256. Files written
# before that carry the token itself, and a run that spans the upgrade has
# both, so the host also sends the token, as the secret it is, for the older
# files and for the strike. Everything arrives on stdin and nowhere else:
# never in argv. Files are found with readdir and opened by open() in this
# process, so no command line anywhere carries a file name. Nothing printed
# names a file, and every record printed has the token struck and its session
# field replaced before it is cut short (a cut through a token would leave a
# prefix no strike matches).
#
# stdin, one line each:
#   F <stem>     read this session's files: <stem>.<YYYY-MM-DD>.jsonl and an
#                undated <stem>.jsonl; within a day, in the order given
#   P <prefix>   read the token-named files of a smoke's sessions, from before
#                fingerprints: smoke-<name>- then a uuid's first eight hex
#                digits (every smoke token is struck when one is given)
#   T <token>    strike this token from every record printed
#   M            several sessions: their records interleave in time
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
my (%stem, @prefixes, @strike);
my $multi = 0;
while (my $l = <STDIN>) {
  $l =~ s/[\r\n]+\z//;
  my ($k, $v) = split / /, $l, 2;
  next unless defined $k && $k ne '';
  if ($k eq 'F' && defined $v && $v =~ /\A[A-Za-z0-9_-]+\z/) { $stem{$v} = scalar keys %stem unless exists $stem{$v} }
  elsif ($k eq 'P' && defined $v && $v =~ /\Asmoke-[a-z0-9]+(?:-[a-z0-9]+)*-\z/) { push @prefixes, $v }
  elsif ($k eq 'T' && defined $v && $v ne '') { push @strike, quotemeta $v }
  elsif ($k eq 'M') { $multi = 1 }
}
die "inspect-audit: no session named on stdin\n" unless %stem || @prefixes;
# A smoke's records can name another smoke session's token (a party smoke's
# sibling): every `smoke-…` token is struck, whichever smoke was read.
push @strike, 'smoke-[A-Za-z0-9_-]+' if @prefixes;
my $strike = @strike ? join('|', @strike) : undef;

sub utc_day {
  my @g = gmtime(int($_[0] / 1000));
  return sprintf('%04d-%02d-%02d', $g[5] + 1900, $g[4] + 1, $g[3]);
}
my $since_day = $since > 0 ? utc_day($since) : '';
my $until_day = $until > 0 ? utc_day($until) : '';
# An undated file says nothing about its days, so it is always read.
sub in_window { my $d = $_[0]; return $d eq '' || (($since_day eq '' || $d ge $since_day) && ($until_day eq '' || $d le $until_day)) }

opendir(my $dh, $dir) or die "inspect-audit: cannot read the audit directory\n";
# [day, order, name]: the undated file ('') before day files, and within a
# day the stems in the order given, so a run's token-named file from before
# the upgrade comes before its fingerprint-named one.
my @found;
while (defined(my $n = readdir $dh)) {
  if ($n =~ /\A([A-Za-z0-9_-]+)(?:\.(\d{4}-\d\d-\d\d))?\.jsonl\z/ && exists $stem{$1}) {
    my $day = defined $2 ? $2 : '';
    push @found, [$day, $stem{$1}, $n] if in_window($day);
    next;
  }
  # A smoke's token-named files: the name exactly, then the uuid's first
  # eight hex digits, so `death-recovery` does not read
  # `death-recovery-priest`'s, nor `group` `group-a`'s.
  for my $p (@prefixes) {
    next unless $n =~ /\A\Q$p\E[0-9a-f]{8}-[A-Za-z0-9_-]*?(?:\.(\d{4}-\d\d-\d\d))?\.jsonl\z/;
    my $day = defined $1 ? $1 : '';
    push @found, [$day, -1, $n] if in_window($day);
    last;
  }
}
closedir $dh;
my @files = map { $_->[2] } sort { $a->[0] cmp $b->[0] || $a->[1] <=> $b->[1] || $a->[2] cmp $b->[2] } @found;

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
    $line =~ s/$strike/[redacted]/g if defined $strike;
    $line =~ s/"session":"[^"]*"/"session":"[redacted]"/;
    $line = substr($line, 0, $cap) if length($line) > $cap;
    push @ring, $line;
    # Several sessions' files interleave in time: keep every match and take
    # the newest after (a smoke's window is small); one session's are in order.
    shift @ring if @ring > $last && !$multi;
  }
  close $fh;
}
if ($multi) {
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
