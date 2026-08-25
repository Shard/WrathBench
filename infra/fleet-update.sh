#!/usr/bin/env bash
#
# Roll new SUPERVISOR code onto the live fleet — infra/run-fleet.ts,
# infra/run-roster.ts, or anything else that only takes effect when the `fleet`
# container's process starts. Runner code under runner/src is bind-mounted and
# applies at the next episode spawn with no restart at all; see
# docs/OPERATIONS.md, "Updating the live fleet".
#
#   ./infra/fleet-update.sh graceful   # pause, wait for every live run to finish
#                                      # on its own clock, recreate, resume
#   ./infra/fleet-update.sh force      # recreate NOW; every live run pauses and,
#                                      # if scored, spends its attempt (--yes)
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
# WHAT GRACEFUL COSTS. Nothing, in the normal case: every live run reaches its
# own episode limit or watchdog and records its verdict. Two caveats, both
# printed by the script:
#  - the drain race the supervisor documents: an episode spawned in the instant
#    between the idle check and the SIGTERM is terminated gracefully. Worst
#    case one just-started episode, never one mid-flight.
#  - a run already PAUSED by its provider (rate-limited, quota-exhausted) is not
#    resumed while the switch is set. If the window outlasts that run's own
#    episode budget it is ended stale — and a provider pause that goes stale is
#    a COUNTED failed attempt against the model (runner/src/lapse.ts). The
#    script lists such runs before it starts waiting.
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
    -h|--help) sed -n '2,52p' "$0"; exit 0 ;;
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
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    say "dry-run: would run ${COMPOSE[*]} up -d --no-deps --force-recreate fleet"
    exit 0
  fi
  if [[ "${ASSUME_YES}" -ne 1 ]]; then
    read -r -p "fleet-update: type yes to recreate now: " ans
    [[ "${ans}" == "yes" ]] || die "not confirmed — nothing done"
  fi
  "${COMPOSE[@]}" up -d --no-deps --force-recreate fleet
  say "recreated. \`./infra/run-fleet.sh --status\` shows the new supervisor's first tick."
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
  say "would: poll ${STATE_JSON} every ${POLL_S}s for up to ${TIMEOUT_S}s until no job is alive"
  if [[ "${MODE}" == "graceful" ]]; then
    say "would: ${COMPOSE[*]} up -d --no-deps --force-recreate fleet"
    say "would: wait up to ${BOOT_WAIT_S}s for a fresh heartbeat, then delete ${PAUSE_JSON}"
  else
    say "would: ${COMPOSE[*]} stop fleet, and LEAVE the switch set for the deploy"
  fi
  exit 0
fi

set_switch "${WHY}"
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

# Quiet is a claim about LIVE RUNS, and only a state file this poll actually
# parsed, written by a supervisor that is actually ticking, can make it. Two
# ways to get that wrong, both ending in a recreate over live episodes:
# `writeState` is a plain writeFileSync, so a poll can land mid-write and read a
# truncated file (`alive_jobs` says "none"); and a supervisor that died leaves a
# file whose `alive: true` rows are frozen, not current. Neither is quiet. The
# deploy script reads "none" as nothing-to-drain because it only asks AFTER
# `compose stop fleet` returned — here the fleet is still up and the meaning
# inverts.
deadline=$(( $(date +%s) + TIMEOUT_S ))
while :; do
  n="$(alive_jobs)"
  hb="$(heartbeat_at_s)"; [[ "${hb}" =~ ^[0-9]+$ ]] || hb=0
  age=$(( $(date +%s) - hb ))
  if [[ ! "${n}" =~ ^[0-9]+$ ]]; then
    waiting="${STATE_JSON} did not parse this poll — NOT reading that as quiet"
  elif (( hb == 0 || age > 180 )); then
    waiting="the supervisor's heartbeat is ${age}s old — it is not ticking, so its job rows mean nothing"
  elif [[ "${n}" == "0" ]]; then
    break
  else
    waiting="${n} job(s) still live (heartbeat ${age}s ago)"
  fi
  if (( $(date +%s) >= deadline )); then
    say "TIMED OUT after ${TIMEOUT_S}s: ${waiting}. Nothing was killed and the switch is still"
    say "set: wait longer (\`fleet-update.sh status\`), or accept the cost and run"
    say "\`fleet-update.sh force\`. Clear the switch with \`fleet-update.sh resume\` to abandon the update."
    exit 1
  fi
  say "  ${waiting} — waiting"
  sleep "${POLL_S}"
done
say "quiet: no job holds a live episode."

if [[ "${MODE}" == "drain" ]]; then
  "${COMPOSE[@]}" stop fleet
  say "fleet stopped with nothing live and the switch STILL SET. Do the deploy, then:"
  say "  ${COMPOSE[*]} up -d --no-deps fleet && ./infra/fleet-update.sh resume"
  exit 0
fi

recreated_at=$(date +%s)
"${COMPOSE[@]}" up -d --no-deps --force-recreate fleet
say "recreated on the new supervisor code; waiting up to ${BOOT_WAIT_S}s for its first heartbeat"
boot_deadline=$(( $(date +%s) + BOOT_WAIT_S ))
while :; do
  at="$(heartbeat_at_s)"
  [[ "${at}" =~ ^[0-9]+$ ]] || at=0
  # Strictly after the recreate: the OLD supervisor's last heartbeat is fresh
  # too, and mistaking it for the new one is how the switch gets cleared under
  # a fleet that never came back.
  if (( at >= recreated_at )); then break; fi
  if (( $(date +%s) >= boot_deadline )); then
    say "no fresh heartbeat after ${BOOT_WAIT_S}s — LEAVING the switch set so the fleet cannot"
    say "start scheduling behind a supervisor nobody has looked at. Check \`${COMPOSE[*]} logs fleet\`,"
    say "then \`./infra/fleet-update.sh resume\`."
    exit 1
  fi
  sleep 2
done
clear_switch
say "done: new supervisor up, no run was interrupted."
