#!/usr/bin/env bash
#
# Roll new SUPERVISOR code onto the live fleet — infra/run-fleet.ts,
# infra/run-roster.ts, or anything else that only takes effect when the `fleet`
# container's process starts. Runner code under runner/src is bind-mounted and
# applies at the next episode spawn with no restart at all; see
# docs/OPERATIONS.md, "Updating the live fleet".
#
#   ./infra/fleet-update.sh graceful   # pause, wait for every run that has a
#                                      # clock to finish on it, recreate, resume
#   ./infra/fleet-update.sh force      # recreate NOW; every live run pauses and,
#                                      # if scored, spends its attempt (--yes)
#                                      # a set switch is cleared after the recreate
#   ./infra/fleet-update.sh drain      # pause and wait for quiet, then STOP —
#                                      # the pause stays set (deploy windows)
#   ./infra/fleet-update.sh resume     # clear the pause switch
#   ./infra/fleet-update.sh status     # what the switch and the fleet say
#
# Flags: --dry-run (print the plan, touch nothing), --timeout <seconds> (how
# long `graceful`/`drain` will wait for quiet; default 8h — an e360 plus slack),
# --yes (skip the confirmation `force` asks for).
#
# THE SWITCH. `data/runs/fleet-pause.json` (`{"paused":true,"why":...}`) is read
# by the supervisor every tick. While it is set: nothing is launched — no queue
# job, no policy pick, no campaign cell, no resume of a paused run — and every
# running job drains, which means SIGTERM only once its roster is between
# episodes. Live episodes are never signalled. The switch is a sidecar, not a
# fleet.json key, because a typo in fleet.json makes every `enabled` flag in it
# inert until somebody reads the banner, and a stop switch must not be able to
# do that.
#
# WHAT GRACEFUL WAITS FOR. Every run a recreate would COST: the scored e90 and
# e360 runs, which reach their own episode limit or watchdog and record their
# verdict. NOT the runs that come back where they left off — the freeplay
# stream and a probe campaign with `resume: true` — which the wait counts as
# drained once the switch has put them in `draining`. An `idle: unlimited`
# session has no clock to finish on, so waiting for one is waiting forever
# (2026-08-29: the window ran to its ceiling and had to become a `force`).
#
# WHAT GRACEFUL COSTS. Nothing, in the normal case. Three caveats, all printed
# by the script:
#  - the drain race the supervisor documents: an episode spawned in the instant
#    between the idle check and the SIGTERM is terminated gracefully. Worst
#    case one just-started episode, never one mid-flight.
#  - a run already PAUSED by its provider (rate-limited, quota-exhausted) is not
#    resumed while the switch is set. If the window outlasts that run's own
#    episode budget it is ended stale — and a provider pause that goes stale is
#    a COUNTED failed attempt against the model (runner/src/lapse.ts). The
#    script lists such runs before it starts waiting.
#  - a parked freeplay/resume:true run is SIGTERMed by the recreate wherever it
#    happens to be, exactly as `force` would. It resumes on the same run id,
#    account and character; nothing is scored, so nothing is spent.
#
# ON ABORT. Ctrl-C during the wait kills nothing, and the switch STAYS SET —
# the script says so and names `fleet-update.sh resume`, which is the only way
# the fleet starts scheduling again.
#
# WHAT FORCE COSTS. `up -d --force-recreate` stops the container inside its
# 180s stop_grace_period, so every live run takes the pause path: a scored
# e90/e360 run is ended `manual` — the attempt is spent and reattempted with a
# full clock, the model is not blamed, and whatever it had spent is spent.
# Freeplay and a campaign with `resume: true` come back where they left off.
#
# `--no-deps` is not optional on either path: without it compose may decide the
# worldserver is out of date and recreate it under the live episodes.

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
# Overridable only so the tests can point the script at fixtures.
COMPOSE_FILE="${WRATHBENCH_FLEET_COMPOSE_FILE:-${REPO_ROOT}/infra/compose.yml}"
STATE_JSON="${WRATHBENCH_FLEET_STATE_JSON:-${REPO_ROOT}/data/runs/fleet-state.json}"
PAUSE_JSON="${WRATHBENCH_FLEET_PAUSE_JSON:-${REPO_ROOT}/data/runs/fleet-pause.json}"
POLL_S="${WRATHBENCH_FLEET_POLL_S:-30}"
# How long to wait for a fresh heartbeat after the recreate before giving up and
# LEAVING the switch set — a supervisor that did not come back must not find the
# fleet unpaused behind it.
BOOT_WAIT_S="${WRATHBENCH_FLEET_BOOT_WAIT_S:-180}"
TIMEOUT_S="${WRATHBENCH_FLEET_TIMEOUT_S:-28800}"
COMPOSE=(docker compose -f "${COMPOSE_FILE}")
# Bun with no colour: every number this script reads back is parsed.
BUN_PLAIN_ENV=(env -u FORCE_COLOR NO_COLOR=1)

DRY_RUN=0
ASSUME_YES=0
MODE=""

say() { echo "fleet-update: $*"; }
die() { echo "fleet-update: $*" >&2; exit 2; }
strip_ansi() { sed -r 's/\x1B\[[0-9;]*[A-Za-z]//g'; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    graceful|force|drain|resume|status) [[ -z "${MODE}" ]] || die "one mode at a time (got ${MODE} and $1)"; MODE="$1"; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    --timeout) TIMEOUT_S="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,65p' "$0"; exit 0 ;;
    *) die "unknown argument $1 (graceful | force | drain | resume | status)" ;;
  esac
done
[[ -n "${MODE}" ]] || die "which mode? graceful | force | drain | resume | status"
[[ "${TIMEOUT_S}" =~ ^[0-9]+$ ]] || die "--timeout takes whole seconds (got ${TIMEOUT_S})"
[[ "${POLL_S}" =~ ^[0-9]+$ ]] || die "WRATHBENCH_FLEET_POLL_S takes whole seconds"

# ------------------------------------------------------------ state readers
#
# Everything about liveness comes from the supervisor's own state file, never
# from a process listing: this script runs on the host and the supervisor is in
# a container, so a pid here means nothing.

# How many jobs the supervisor lists with a live roster process; "none" when
# there is no readable state file (nothing has ever run here).
alive_jobs() {
  "${BUN_PLAIN_ENV[@]}" bun -e '
    try { const s = await Bun.file(process.argv[1]).json();
      process.stdout.write(String(Object.values(s.jobs ?? {}).filter((j) => j && j.alive === true).length) + "\n"); }
    catch { process.stdout.write("none\n"); }
  ' "${STATE_JSON}" 2>/dev/null | strip_ansi || echo none
}

# What the graceful window is actually waiting for. Every live job row, split
# in two:
#
#   wait:<name> ...   a run that must finish on its own clock. A recreate ends
#                     it `manual`: the attempt is spent. Every scored e90/e360
#                     is here.
#   park:<name> ...   a run that comes back WHERE IT LEFT OFF — the freeplay
#                     stream, and a probe campaign with `resume: true`. The
#                     recreate costs it nothing (2026-08-29: the sonnet stream
#                     came back on the same run id and character), so waiting
#                     on one is waiting for nothing. item 93.
#
# A row is parked only when the supervisor has already put it in `draining`:
# that is the proof the switch reached it. It is also what makes the observed
# hang finish — a freeplay job under a supervisor that drains to an episode
# boundary sits `draining, alive` forever, because an `idle: unlimited`
# session has no boundary — and it keeps the documented sparing of a REFUSED
# PIN honest: a spared job never drains, so it still holds the window.
#
# `resumesInPlace` is the supervisor's own answer (it is the only side that
# knows the campaign's opt-in, and the switch has to work while fleet.json is
# rejected); a supervisor older than that field does not write it, so the
# freeplay pair is the fallback and the first graceful after this ships still
# works.
#
# Output ends with `ok`: anything less — a truncated mid-write state file, a
# bun that died — is NOT quiet. Nothing here says whether the supervisor is
# ticking; the caller checks the heartbeat.
drain_view() {
  "${BUN_PLAIN_ENV[@]}" bun -e '
    const s = await Bun.file(process.argv[1]).json();
    for (const [name, j] of Object.entries(s.jobs ?? {})) {
      if (!j || j.alive !== true) continue;
      const where = `${name} (${j.ref ?? "?"}, ${j.episode ?? "episode unknown"}, ${j.account ?? "?"})`;
      const resumes = j.resumesInPlace === true || (j.resumesInPlace === undefined && j.source === "policy" && j.episode === "freeplay");
      if (resumes && j.draining === true) process.stdout.write(`park:${where} — draining; resumes in place\n`);
      else process.stdout.write(`wait:${where}${j.draining === true ? " — draining" : ""}\n`);
    }
    process.stdout.write("ok\n");
  ' "${STATE_JSON}" 2>/dev/null | strip_ansi || true
}

# The supervisor's last heartbeat, in epoch SECONDS, or 0. Absolute rather than
# an age, because what the update has to know after a recreate is not "recent"
# but "later than the recreate" — a state file left by the supervisor that just
# died is seconds old and means the opposite of alive.
heartbeat_at_s() {
  "${BUN_PLAIN_ENV[@]}" bun -e '
    try { const s = await Bun.file(process.argv[1]).json();
      process.stdout.write(String(typeof s.heartbeatAt === "number" ? Math.floor(s.heartbeatAt / 1000) : 0) + "\n"); }
    catch { process.stdout.write("0\n"); }
  ' "${STATE_JSON}" 2>/dev/null | strip_ansi || echo 0
}

# Age of that heartbeat in seconds, for the operator-facing lines.
heartbeat_age_s() {
  local at; at="$(heartbeat_at_s)"
  [[ "${at}" =~ ^[0-9]+$ ]] || at=0
  if [[ "${at}" == "0" ]]; then echo none; else echo $(( $(date +%s) - at )); fi
}

# One line per paused run the supervisor is NOT resuming — the runs a long
# window can turn stale. Empty when there are none.
paused_runs() {
  "${BUN_PLAIN_ENV[@]}" bun -e '
    try { const s = await Bun.file(process.argv[1]).json();
      for (const p of s.paused ?? []) {
        const mins = typeof p.elapsedMs === "number" ? Math.round(p.elapsedMs / 60000) : "?";
        const budget = typeof p.budgetMs === "number" ? Math.round(p.budgetMs / 60000) : "?";
        process.stdout.write(`${p.runId} (${p.model}): ${p.reason}, ${mins}m of ${budget}m\n`);
      } } catch {}
  ' "${STATE_JSON}" 2>/dev/null | strip_ansi || true
}

# Whether the supervisor has PICKED UP the switch (its last tick), not merely
# whether the file exists.
pause_in_effect() {
  "${BUN_PLAIN_ENV[@]}" bun -e '
    try { const s = await Bun.file(process.argv[1]).json();
      process.stdout.write(s.pausedSwitch ? "yes\n" : "no\n"); } catch { process.stdout.write("no\n"); }
  ' "${STATE_JSON}" 2>/dev/null | strip_ansi || echo no
}

fleet_container_running() {
  local names
  names="$("${COMPOSE[@]}" ps --status running --format '{{.Name}}' fleet 2>/dev/null | strip_ansi)" || return 1
  [[ -n "${names//[[:space:]]/}" ]]
}

set_switch() {
  local why="$1"
  if [[ "${DRY_RUN}" -eq 1 ]]; then say "dry-run: would write ${PAUSE_JSON} (${why})"; return 0; fi
  mkdir -p "$(dirname "${PAUSE_JSON}")"
  "${BUN_PLAIN_ENV[@]}" bun -e '
    const [p, why] = process.argv.slice(1);
    await Bun.write(p + ".tmp", JSON.stringify({ paused: true, why, at: Date.now() }, null, 2) + "\n");
    const { renameSync } = await import("node:fs"); renameSync(p + ".tmp", p);
  ' "${PAUSE_JSON}" "${why}" >/dev/null
  say "pause switch SET: ${why}"
}

clear_switch() {
  if [[ "${DRY_RUN}" -eq 1 ]]; then say "dry-run: would delete ${PAUSE_JSON}"; return 0; fi
  rm -f "${PAUSE_JSON}"
  say "pause switch cleared — the fleet schedules again within a tick (60s)"
}

# What the switch says, for an operator who did not set it. Empty when it is not set.
switch_why() {
  [[ -f "${PAUSE_JSON}" ]] || return 0
  "${BUN_PLAIN_ENV[@]}" bun -e '
    try { const s = await Bun.file(process.argv[1]).json();
      process.stdout.write(String(s.why ?? "no reason recorded") + "\n"); } catch { process.stdout.write("unreadable\n"); }
  ' "${PAUSE_JSON}" 2>/dev/null | strip_ansi || true
}

# Wait for the NEW supervisor's first heartbeat and only then clear the switch.
# Strictly after the recreate: the OLD supervisor's last heartbeat is fresh too,
# and mistaking it for the new one is how the switch gets cleared under a fleet
# that never came back. Non-zero means it did not come back and the switch was
# LEFT SET on purpose.
await_boot_then_clear() {
  local recreated_at="$1" at boot_deadline
  boot_deadline=$(( $(date +%s) + BOOT_WAIT_S ))
  while :; do
    at="$(heartbeat_at_s)"
    [[ "${at}" =~ ^[0-9]+$ ]] || at=0
    if (( at >= recreated_at )); then break; fi
    if (( $(date +%s) >= boot_deadline )); then
      say "no fresh heartbeat after ${BOOT_WAIT_S}s — LEAVING the switch set so the fleet cannot"
      say "start scheduling behind a supervisor nobody has looked at. Check \`${COMPOSE[*]} logs fleet\`,"
      say "then \`./infra/fleet-update.sh resume\`."
      return 1
    fi
    sleep 2
  done
  clear_switch
  return 0
}

# ------------------------------------------------------------------- status
print_status() {
  say "compose file   ${COMPOSE_FILE}"
  say "fleet state    ${STATE_JSON}"
  say "pause switch   ${PAUSE_JSON} $( [[ -f "${PAUSE_JSON}" ]] && echo SET || echo "not set" )"
  say "picked up      $(pause_in_effect) (the supervisor's own last tick)"
  say "heartbeat      $(heartbeat_age_s)s ago"
  say "jobs alive     $(alive_jobs)"
  local pr; pr="$(paused_runs)"
  if [[ -n "${pr}" ]]; then
    say "paused runs the supervisor is not resuming:"
    while IFS= read -r l; do [[ -n "${l}" ]] && say "  ${l}"; done <<< "${pr}"
  fi
  say "container      $(fleet_container_running && echo running || echo "not running")"
}

if [[ "${MODE}" == "status" ]]; then print_status; exit 0; fi
if [[ "${MODE}" == "resume" ]]; then clear_switch; exit 0; fi

# -------------------------------------------------------------------- force
if [[ "${MODE}" == "force" ]]; then
  n="$(alive_jobs)"
  say "FORCE: recreating the fleet container now."
  say "  ${n} job(s) are live. Each pauses inside the 180s grace period; a scored"
  say "  e90/e360 run then ends \`manual\` — the attempt is spent (money and quota"
  say "  with it) and reattempted with a full clock, no strike against the model."
  say "  Freeplay and campaigns with resume:true come back where they left off."
  # A switch left set by an aborted `graceful` is the normal way to arrive here
  # (2026-08-29, item 93): force STARTS the container, so leaving the
  # switch set would hand back a fleet that runs and schedules nothing — a
  # state with no use. `drain` is the mode whose job is leaving it set, and it
  # stops the container instead.
  why="$(switch_why)"
  if [[ -n "${why}" ]]; then
    say "  the pause switch is SET (${why}); this clears it after the recreate."
  fi
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    say "dry-run: would run ${COMPOSE[*]} up -d --no-deps --force-recreate fleet"
    if [[ -n "${why}" ]]; then
      say "dry-run: would wait up to ${BOOT_WAIT_S}s for a fresh heartbeat, then delete ${PAUSE_JSON}"
    fi
    exit 0
  fi
  if [[ "${ASSUME_YES}" -ne 1 ]]; then
    read -r -p "fleet-update: type yes to recreate now: " ans
    [[ "${ans}" == "yes" ]] || die "not confirmed — nothing done"
  fi
  recreated_at=$(date +%s)
  "${COMPOSE[@]}" up -d --no-deps --force-recreate fleet
  say "recreated. \`./infra/run-fleet.sh --status\` shows the new supervisor's first tick."
  if [[ -n "${why}" ]]; then
    say "waiting up to ${BOOT_WAIT_S}s for the new supervisor's first heartbeat before clearing the switch"
    await_boot_then_clear "${recreated_at}" || exit 1
  fi
  exit 0
fi

# --------------------------------------------------------- graceful / drain
#
# 1. set the switch   2. wait for the state file to say no job is alive
# 3. (graceful) recreate and clear the switch; (drain) stop and leave it set.

WHY="${MODE} supervisor update, $(date '+%Y-%m-%d %H:%M')"
if [[ "${DRY_RUN}" -eq 1 ]]; then
  say "--dry-run: the plan, and every resolved value; nothing is written, stopped or recreated"
  print_status
  say "would: write ${PAUSE_JSON} (${WHY})"
  say "would: poll ${STATE_JSON} every ${POLL_S}s for up to ${TIMEOUT_S}s until no run is being waited on"
  say "would: wait on scored runs only — a draining freeplay stream, or a resume:true campaign"
  say "       run, counts as drained: it comes back where it left off. On the state as it"
  say "       stands right now — nothing is DRAINING until the switch is set, so a stream"
  say "       that will park is listed here as one this window would wait on:"
  dv="$(drain_view)"
  if [[ "${dv}" == *$'\nok' || "${dv}" == "ok" ]]; then
    while IFS= read -r l; do
      case "${l}" in
        wait:*) say "       would wait on:  ${l#wait:}" ;;
        park:*) say "       counted drained: ${l#park:}" ;;
      esac
    done <<< "${dv}"
    [[ "${dv}" == "ok" ]] && say "       (no live job)"
  else
    say "       ${STATE_JSON} did not parse — that would NOT be read as quiet"
  fi
  if [[ "${MODE}" == "graceful" ]]; then
    say "would: ${COMPOSE[*]} up -d --no-deps --force-recreate fleet"
    say "would: wait up to ${BOOT_WAIT_S}s for a fresh heartbeat, then delete ${PAUSE_JSON}"
  else
    say "would: ${COMPOSE[*]} stop fleet, and LEAVE the switch set for the deploy"
  fi
  exit 0
fi

set_switch "${WHY}"
# From here the switch is on disk, so every way out of this script has to say so
# — an aborted window that looks like nothing happened is a fleet that quietly
# schedules nothing until somebody notices (2026-08-29, item 93).
on_abort() {
  trap - INT TERM
  echo
  say "ABORTED — nothing was killed and the PAUSE SWITCH IS STILL SET (${PAUSE_JSON})."
  say "The fleet launches nothing and resumes nothing while it is. Put it back to work with:"
  say "  ./infra/fleet-update.sh resume"
  exit 130
}
trap on_abort INT TERM
say "waiting for every live run to finish on its own clock (up to ${TIMEOUT_S}s, polling every ${POLL_S}s)"
say "an e360 run can hold this for six hours; Ctrl-C is safe — the switch stays set and nothing is killed"
pr="$(paused_runs)"
if [[ -n "${pr}" ]]; then
  say "NOTE: these runs are paused and will NOT be resumed while the switch is set."
  say "      If the window outlasts a PROVIDER pause's own budget the run is ended stale,"
  say "      and a stale provider pause is a COUNTED failed attempt. Keep the window short"
  say "      or clear the switch (\`fleet-update.sh resume\`) and try again later:"
  while IFS= read -r l; do [[ -n "${l}" ]] && say "      ${l}"; done <<< "${pr}"
fi

# Quiet is a claim about the runs a recreate would COST, and only a state file
# this poll actually parsed, written by a supervisor that is actually ticking,
# can make it. Three ways to get it wrong:
# `writeState` is a plain writeFileSync, so a poll can land mid-write and read a
# truncated file (no `ok` line); a supervisor that died leaves a file whose
# `alive: true` rows are frozen, not current; and — the one this loop used to
# get wrong — a live row is not automatically a reason to wait. A draining
# freeplay stream or resume:true campaign run comes back where it left off, so
# it is counted as drained (`drain_view`); every scored e90/e360 is waited out.
# The deploy script reads an unparsable state as nothing-to-drain because it
# only asks AFTER `compose stop fleet` returned — here the fleet is still up and
# the meaning inverts.
deadline=$(( $(date +%s) + TIMEOUT_S ))
while :; do
  dv="$(drain_view)"
  hb="$(heartbeat_at_s)"; [[ "${hb}" =~ ^[0-9]+$ ]] || hb=0
  age=$(( $(date +%s) - hb ))
  wait_lines=(); park_lines=()
  while IFS= read -r l; do
    case "${l}" in
      wait:*) wait_lines+=("${l#wait:}") ;;
      park:*) park_lines+=("${l#park:}") ;;
    esac
  done <<< "${dv}"
  if [[ "${dv}" != *"ok" ]]; then
    waiting="${STATE_JSON} did not parse this poll — NOT reading that as quiet"
  elif (( hb == 0 || age > 180 )); then
    waiting="the supervisor's heartbeat is ${age}s old — it is not ticking, so its job rows mean nothing"
  elif (( ${#wait_lines[@]} == 0 )); then
    break
  else
    waiting="${#wait_lines[@]} run(s) still on their own clock (heartbeat ${age}s ago)"
  fi
  if (( $(date +%s) >= deadline )); then
    say "TIMED OUT after ${TIMEOUT_S}s: ${waiting}. Nothing was killed and the switch is still"
    say "set: wait longer (\`fleet-update.sh status\`), or accept the cost and run"
    say "\`fleet-update.sh force\`. Clear the switch with \`fleet-update.sh resume\` to abandon the update."
    for l in "${wait_lines[@]}"; do say "  waiting on:      ${l}"; done
    exit 1
  fi
  say "  ${waiting} — waiting"
  if (( ${#wait_lines[@]} > 0 )); then for l in "${wait_lines[@]}"; do say "      waiting on:      ${l}"; done; fi
  if (( ${#park_lines[@]} > 0 )); then for l in "${park_lines[@]}"; do say "      counted drained: ${l}"; done; fi
  sleep "${POLL_S}"
done
if (( ${#park_lines[@]} > 0 )); then
  say "quiet: no run is on its own clock. ${#park_lines[@]} paused run(s) counted as drained — they resume in place:"
  for l in "${park_lines[@]}"; do say "  counted drained: ${l}"; done
else
  say "quiet: no job holds a live episode."
fi

if [[ "${MODE}" == "drain" ]]; then
  "${COMPOSE[@]}" stop fleet
  say "fleet stopped with nothing live and the switch STILL SET. Do the deploy, then:"
  say "  ${COMPOSE[*]} up -d --no-deps fleet && ./infra/fleet-update.sh resume"
  exit 0
fi

recreated_at=$(date +%s)
"${COMPOSE[@]}" up -d --no-deps --force-recreate fleet
say "recreated on the new supervisor code; waiting up to ${BOOT_WAIT_S}s for its first heartbeat"
await_boot_then_clear "${recreated_at}" || exit 1
trap - INT TERM
say "done: new supervisor up, no run was interrupted."
