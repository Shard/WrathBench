#!/usr/bin/env bash
#
# Roll new SUPERVISOR code onto the live fleet — infra/run-fleet.ts,
# infra/run-roster.ts, or anything else that only takes effect when the fleet
# process starts.
#
# NOT for config. A config change — a roster entry, the policy, a job — is
# picked up by the running supervisor on its next 60s tick once it is in the
# config store (the viewer's /config page, or runner/src/config-store.ts through
# the runner pod). Nothing here is involved; see docs/OPERATIONS.md, "Where the
# config lives".
#
# CLUSTER-NATIVE since 2026-09-11. The fleet is the `wrathbench-fleet`
# Deployment in namespace `wrathbench` (docs/[removed]); compose has
# been stopped since the 2026-09-08 cutover. Every verb below drives kubectl.
# There is no compose path any more: this script used to run
# `docker compose ps fleet` and report a live fleet as "container not running,
# heartbeat 260151s ago", which is a lie an operator makes deploy decisions on.
#
#   ./infra/fleet-update.sh graceful   # pause, wait for every run that has a
#                                      # clock to finish on it, recreate, resume
#   ./infra/fleet-update.sh force      # recreate NOW; every live run pauses and,
#                                      # if scored, spends its attempt (--yes)
#                                      # a set switch is cleared after the recreate
#   ./infra/fleet-update.sh drain      # pause and wait for quiet, then SCALE TO 0 —
#                                      # the pause stays set (deploy windows)
#   ./infra/fleet-update.sh resume     # clear the pause switch
#   ./infra/fleet-update.sh status     # what the switch, the state file and the
#                                      # Deployment say
#
# Flags: --dry-run (print every kubectl command it would run, touch nothing),
# --timeout <seconds> (how long `graceful`/`drain` will wait for quiet; default
# 8h — an e360 plus slack), --yes (skip the confirmation `force` asks for),
# --namespace/-n and --release (the chart's release name, default `wrathbench`).
#
# WHERE THE FILES LIVE. `fleet-state.json` and the pause switch beside it are on
# the `wrathbench-data` PVC, which the workstation cannot see, so every read and
# write of them goes through `kubectl exec` — into the RUNNER Deployment, not the
# fleet's own pod. Same file, same meaning; the runner is the exec target because
# the fleet pod is the thing being recreated and stops existing mid-window.
# infra/k8s-deploy.sh reads the same file the same way.
#
# RECREATE, ON KUBERNETES. `kubectl rollout restart` on a Deployment whose
# strategy is `Recreate` (infra/chart/wrathbench/templates/fleet.yaml): the old
# pod is SIGTERMed and gets its 180s terminationGracePeriodSeconds — the compose
# stop_grace_period, ported — and only then does the new one start. Two
# supervisors never overlap, which is the property that matters. A fleet already
# scaled to 0 (what `drain` leaves behind) is brought back with
# `kubectl scale --replicas=1` instead, because a rollout restart of nothing
# restarts nothing. Compose's `--no-deps` has no analogue and needs none: a
# Deployment restart touches one Deployment, never the worldserver.
#
# THE SWITCH. `<runs>/fleet-pause.json` (`{"paused":true,"why":...}`) is read
# by the supervisor every tick. While it is set: nothing is launched — no queue
# job, no policy pick, no campaign cell, no resume of a paused run — and every
# running job drains, which means SIGTERM only once its roster is between
# episodes. Live episodes are never signalled. The switch is a sidecar, not a
# config key, because a rejected config makes every `enabled` flag in it inert
# until somebody reads the banner, and a stop switch must not be able to do
# that. The config store and the switch are both files on the PVC; neither goes
# through Flux.
#
# WHAT GRACEFUL WAITS FOR. Every run a recreate would COST: the scored e90 and
# e360 runs, which reach their own episode limit or watchdog and record their
# verdict. NOT the runs that come back where they left off — the freeplay
# character and a probe campaign with `resume: true` — which the wait counts as
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
# WHAT FORCE COSTS. The rollout restart stops the pod inside its 180s grace, so
# every live run takes the pause path: a scored e90/e360 run is ended `manual`
# — the attempt is spent and reattempted with a full clock, the model is not
# blamed, and whatever it had spent is spent. Freeplay and a campaign with
# `resume: true` come back where they left off.
#
# NOT THE DEPLOY WINDOW. This script rolls the SUPERVISOR. A worldserver deploy
# is infra/k8s-deploy.sh, which owns its own drain and its own smokes. Neither
# changes an image tag: Flux owns that (docs/[removed]).

set -Eeuo pipefail

NAMESPACE="${WRATHBENCH_K8S_NAMESPACE:-wrathbench}"
RELEASE="${WRATHBENCH_K8S_RELEASE:-wrathbench}"
# The runs directory as the PODS see it. Overridable only so the tests can point
# a stubbed kubectl at a fixture directory on the host.
RUNS_DIR="${WRATHBENCH_FLEET_RUNS_DIR:-/wrathbench/data/runs}"
STATE_JSON="${RUNS_DIR}/fleet-state.json"
PAUSE_JSON="${RUNS_DIR}/fleet-pause.json"
POLL_S="${WRATHBENCH_FLEET_POLL_S:-30}"
# How long to wait for a fresh heartbeat after the recreate before giving up and
# LEAVING the switch set — a supervisor that did not come back must not find the
# fleet unpaused behind it.
BOOT_WAIT_S="${WRATHBENCH_FLEET_BOOT_WAIT_S:-180}"
# `kubectl rollout status` after a restart: the old pod's 180s grace plus an
# image pull plus margin.
ROLLOUT_WAIT_S="${WRATHBENCH_FLEET_ROLLOUT_WAIT_S:-420}"
TIMEOUT_S="${WRATHBENCH_FLEET_TIMEOUT_S:-28800}"
# Bun with no colour: every number this script reads back is parsed.
BUN_PLAIN_ENV=(env NO_COLOR=1 FORCE_COLOR=0 TERM=dumb)

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
    --namespace|-n) NAMESPACE="${2:-}"; shift 2 ;;
    --release) RELEASE="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,91p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument $1 (graceful | force | drain | resume | status)" ;;
  esac
done
[[ -n "${MODE}" ]] || die "which mode? graceful | force | drain | resume | status"
[[ "${TIMEOUT_S}" =~ ^[0-9]+$ ]] || die "--timeout takes whole seconds (got ${TIMEOUT_S})"
[[ "${POLL_S}" =~ ^[0-9]+$ ]] || die "WRATHBENCH_FLEET_POLL_S takes whole seconds"

KUBECTL=(kubectl -n "${NAMESPACE}")
FLEET_DEPLOY="deployment/${RELEASE}-fleet"
# Every PVC read and write goes through here, NOT through the fleet pod: the
# fleet pod is what a recreate takes away.
EXEC_DEPLOY="${WRATHBENCH_FLEET_EXEC_DEPLOY:-deployment/${RELEASE}-runner}"

command -v kubectl >/dev/null 2>&1 || die "kubectl is not on PATH — this script drives the cluster, not compose"

# ------------------------------------------------------------ state readers
#
# Everything about liveness comes from the supervisor's own state file, never
# from a pod listing: a Running pod says the process started, not that it is
# ticking, and a pod that is Terminating still has one.
#
# ONE exec per poll. The reader emits a small line protocol rather than five
# round trips, because on the cluster each read is a `kubectl exec` and a poll
# loop that takes five of them every 30s is five ways to get a partial answer.
#
#   switch:set|unset      the pause sidecar exists
#   switchwhy:<text>      what it says (only when set)
#   pickedup:yes|no       the supervisor's OWN last tick saw it — not the file
#   heartbeat:<epoch-s>   absolute, 0 when unknown; see below
#   startedat:<epoch-ms>  the supervisor process's own start stamp, 0 when
#                         unknown. A recreate is complete when this CHANGES.
#   alive:<n>             job rows with a live roster process
#   wait:<where>          a run that must finish on its own clock. A recreate
#                         ends it `manual`: the attempt is spent. Every scored
#                         e90/e360 is here.
#   park:<where>          a run that comes back WHERE IT LEFT OFF — the freeplay
#                         character, and a probe campaign with `resume: true`. The
#                         recreate costs it nothing (2026-08-29: the sonnet
#                         session came back on the same run id and character), so
#                         waiting on one is waiting for nothing. item 93.
#   paused:<line>         a paused run the supervisor is NOT resuming
#   state:unreadable      the state file did not parse this poll
#   exec:failed           kubectl could not reach the exec target at all
#   ok                    the last line, and the only proof the whole read
#                         happened. Anything less is NOT quiet.
#
# A row is parked only when the supervisor has already put it in `draining`:
# that is the proof the switch reached it. It is also what makes the observed
# hang finish — a freeplay job under a supervisor that drains to an episode
# boundary sits `draining, alive` forever, because an `idle: unlimited` session
# has no boundary — and it keeps the documented sparing of a REFUSED PIN
# honest: a spared job never drains, so it still holds the window.
#
# `resumesInPlace` is the supervisor's own answer (it is the only side that
# knows the campaign's opt-in, and the switch has to work while the config is
# rejected); a supervisor older than that field does not write it, so the
# freeplay pair is the fallback.
#
# The heartbeat is ABSOLUTE epoch seconds rather than an age, because what the
# update has to know after a recreate is not "recent" but "later than the
# recreate" — a state file left by the supervisor that just died is seconds old
# and means the opposite of alive. It is the POD's clock against the
# workstation's; both are NTP-disciplined and the margins here are minutes.
read_state() {
  local out
  out="$("${KUBECTL[@]}" exec -i "${EXEC_DEPLOY}" -- "${BUN_PLAIN_ENV[@]}" bun -e '
    const [statePath, pausePath] = process.argv.slice(1);
    const { existsSync } = await import("node:fs");
    const out = [];
    if (existsSync(pausePath)) {
      out.push("switch:set");
      try { out.push(`switchwhy:${(await Bun.file(pausePath).json()).why ?? "no reason recorded"}`); }
      catch { out.push("switchwhy:unreadable"); }
    } else out.push("switch:unset");
    let s;
    try { s = await Bun.file(statePath).json(); }
    catch {
      out.push("state:unreadable");
      process.stdout.write(out.join("\n") + "\n");
      process.exit(0);
    }
    out.push(`pickedup:${s.pausedSwitch ? "yes" : "no"}`);
    out.push(`heartbeat:${typeof s.heartbeatAt === "number" ? Math.floor(s.heartbeatAt / 1000) : 0}`);
    // The supervisor PROCESS identity: `const START_AT = Date.now()` at module
    // scope in infra/run-fleet.ts, so it changes exactly once per process. It is
    // what proves a NEW supervisor came back, and unlike a heartbeat compared to
    // a host timestamp it never asks two machine clocks to agree. (No
    // apostrophes in here: the whole snippet is a single-quoted bash string.)
    out.push(`startedat:${typeof s.startedAt === "number" ? s.startedAt : 0}`);
    let alive = 0;
    for (const [name, j] of Object.entries(s.jobs ?? {})) {
      if (!j || j.alive !== true) continue;
      alive++;
      const where = `${name} (${j.ref ?? "?"}, ${j.episode ?? "episode unknown"}, ${j.account ?? "?"})`;
      const resumes = j.resumesInPlace === true || (j.resumesInPlace === undefined && j.source === "policy" && j.episode === "freeplay");
      if (resumes && j.draining === true) out.push(`park:${where} — draining; resumes in place`);
      else out.push(`wait:${where}${j.draining === true ? " — draining" : ""}`);
    }
    out.push(`alive:${alive}`);
    for (const p of s.paused ?? []) {
      const mins = typeof p.elapsedMs === "number" ? Math.round(p.elapsedMs / 60000) : "?";
      const budget = typeof p.budgetMs === "number" ? Math.round(p.budgetMs / 60000) : "?";
      out.push(`paused:${p.runId} (${p.model}): ${p.reason}, ${mins}m of ${budget}m`);
    }
    out.push("ok");
    process.stdout.write(out.join("\n") + "\n");
  ' "${STATE_JSON}" "${PAUSE_JSON}" 2>/dev/null | strip_ansi | tr -d '\r')" || true
  [[ -n "${out//[[:space:]]/}" ]] || out="exec:failed"
  printf '%s\n' "${out}"
}

# Parsed fields of the last read_state, as globals — a function that filled an
# array in a pipeline would be filling it in a subshell.
ST_SWITCH="unset"; ST_WHY=""; ST_PICKEDUP="no"; ST_HEARTBEAT=0; ST_STARTED=0; ST_ALIVE="none"; ST_OK=0
WAIT_LINES=(); PARK_LINES=(); PAUSED_LINES=()
parse_state() {
  ST_SWITCH="unset"; ST_WHY=""; ST_PICKEDUP="no"; ST_HEARTBEAT=0; ST_STARTED=0; ST_ALIVE="none"; ST_OK=0
  WAIT_LINES=(); PARK_LINES=(); PAUSED_LINES=()
  local l
  while IFS= read -r l; do
    case "${l}" in
      switch:*) ST_SWITCH="${l#switch:}" ;;
      switchwhy:*) ST_WHY="${l#switchwhy:}" ;;
      pickedup:*) ST_PICKEDUP="${l#pickedup:}" ;;
      heartbeat:*) ST_HEARTBEAT="${l#heartbeat:}" ;;
      startedat:*) ST_STARTED="${l#startedat:}" ;;
      alive:*) ST_ALIVE="${l#alive:}" ;;
      wait:*) WAIT_LINES+=("${l#wait:}") ;;
      park:*) PARK_LINES+=("${l#park:}") ;;
      paused:*) PAUSED_LINES+=("${l#paused:}") ;;
      ok) ST_OK=1 ;;
    esac
  done <<< "$1"
  [[ "${ST_HEARTBEAT}" =~ ^[0-9]+$ ]] || ST_HEARTBEAT=0
  [[ "${ST_STARTED}" =~ ^[0-9]+$ ]] || ST_STARTED=0
}
refresh_state() { parse_state "$(read_state)"; }

heartbeat_age_s() { if [[ "${ST_HEARTBEAT}" == "0" ]]; then echo none; else echo $(( $(date +%s) - ST_HEARTBEAT )); fi; }

# ------------------------------------------------------- deployment readers
deploy_field() {
  "${KUBECTL[@]}" get "${FLEET_DEPLOY}" -o "jsonpath={$1}" 2>/dev/null | strip_ansi | tr -d '\r' || true
}
fleet_replicas() { local r; r="$(deploy_field ".spec.replicas")"; [[ "${r}" =~ ^[0-9]+$ ]] || r=""; echo "${r}"; }
fleet_ready() { local r; r="$(deploy_field ".status.readyReplicas")"; [[ "${r}" =~ ^[0-9]+$ ]] || r=0; echo "${r}"; }
fleet_pods() {
  "${KUBECTL[@]}" get pods -l "app.kubernetes.io/instance=${RELEASE},app.kubernetes.io/component=fleet" \
    -o 'jsonpath={range .items[*]}{.metadata.name}{" "}{.status.phase}{"\n"}{end}' 2>/dev/null | strip_ansi | tr -d '\r' || true
}

# ------------------------------------------------------------------- writes
set_switch() {
  local why="$1"
  if [[ "${DRY_RUN}" -eq 1 ]]; then say "dry-run: would write ${PAUSE_JSON} through ${KUBECTL[*]} exec ${EXEC_DEPLOY} (${why})"; return 0; fi
  "${KUBECTL[@]}" exec -i "${EXEC_DEPLOY}" -- "${BUN_PLAIN_ENV[@]}" bun -e '
    const [p, why] = process.argv.slice(1);
    await Bun.write(p + ".tmp", JSON.stringify({ paused: true, why, at: Date.now() }, null, 2) + "\n");
    const { renameSync } = await import("node:fs"); renameSync(p + ".tmp", p);
  ' "${PAUSE_JSON}" "${why}" >/dev/null
  say "pause switch SET: ${why}"
}

clear_switch() {
  if [[ "${DRY_RUN}" -eq 1 ]]; then say "dry-run: would run ${KUBECTL[*]} exec ${EXEC_DEPLOY} -- rm -f ${PAUSE_JSON}"; return 0; fi
  "${KUBECTL[@]}" exec -i "${EXEC_DEPLOY}" -- rm -f "${PAUSE_JSON}" >/dev/null
  say "pause switch cleared — the fleet schedules again within a tick (60s)"
}

# `rollout restart` on a running Deployment, `scale --replicas=1` on one that is
# at 0 (what `drain` leaves). Either way `rollout status` blocks until the new
# pod is available, so the heartbeat wait that follows is about the SUPERVISOR
# ticking rather than about the pod existing.
recreate_fleet() {
  local replicas; replicas="$(fleet_replicas)"
  if [[ "${replicas}" == "0" ]]; then
    say "the fleet Deployment is scaled to 0 — scaling it back to 1 rather than restarting nothing"
    "${KUBECTL[@]}" scale "${FLEET_DEPLOY}" --replicas=1
  else
    "${KUBECTL[@]}" rollout restart "${FLEET_DEPLOY}"
  fi
  say "waiting for the rollout (the old pod gets its full 180s grace first, up to ${ROLLOUT_WAIT_S}s)"
  "${KUBECTL[@]}" rollout status "${FLEET_DEPLOY}" --timeout="${ROLLOUT_WAIT_S}s"
}
recreate_plan() {
  local replicas; replicas="$(fleet_replicas)"
  if [[ "${replicas}" == "0" ]]; then say "would: ${KUBECTL[*]} scale ${FLEET_DEPLOY} --replicas=1 (it is at 0)"
  else say "would: ${KUBECTL[*]} rollout restart ${FLEET_DEPLOY}"; fi
  say "would: ${KUBECTL[*]} rollout status ${FLEET_DEPLOY} --timeout=${ROLLOUT_WAIT_S}s"
}

# Wait for a NEW supervisor PROCESS and only then clear the switch. The old
# supervisor's last heartbeat is fresh too, and mistaking it for the new one is
# how the switch gets cleared under a fleet that never came back — so the test
# is that `startedAt` has CHANGED, not that a timestamp is recent. That also
# keeps the check off the clocks: `startedAt` is stamped by the pod and compared
# only against itself, where "is this heartbeat later than the moment I typed
# the restart" would be the workstation's clock against `chungusjr`'s and would
# read a dying supervisor's final write as a boot if the pod ran a few seconds
# ahead. A supervisor too old to write the field leaves it 0, and 0 never counts
# as a boot: the window times out with the switch set, which is the safe
# direction. Non-zero means it did not come back and the switch was LEFT SET on
# purpose.
await_boot_then_clear() {
  local was_started="$1" boot_deadline
  boot_deadline=$(( $(date +%s) + BOOT_WAIT_S ))
  while :; do
    refresh_state
    if (( ST_STARTED != 0 && ST_STARTED != was_started )); then break; fi
    if (( $(date +%s) >= boot_deadline )); then
      say "no NEW supervisor process after ${BOOT_WAIT_S}s — LEAVING the switch set, so the"
      say "fleet cannot start scheduling behind a supervisor nobody has looked at. Check"
      say "\`${KUBECTL[*]} logs ${FLEET_DEPLOY}\`, then \`./infra/fleet-update.sh resume\`."
      return 1
    fi
    sleep 2
  done
  clear_switch
  return 0
}

# ------------------------------------------------------------------- status
print_status() {
  local replicas ready pods l
  refresh_state
  say "namespace      ${NAMESPACE} (release ${RELEASE})"
  say "fleet          ${FLEET_DEPLOY}"
  say "exec target    ${EXEC_DEPLOY} (every PVC read and write goes through it)"
  say "fleet state    ${STATE_JSON} (in the pod)"
  if [[ "${ST_SWITCH}" == "set" ]]; then say "pause switch   ${PAUSE_JSON} SET (${ST_WHY})"; else say "pause switch   ${PAUSE_JSON} not set"; fi
  if [[ "${ST_OK}" -eq 1 ]]; then
    say "picked up      ${ST_PICKEDUP} (the supervisor's own last tick)"
    say "heartbeat      $(heartbeat_age_s)s ago"
    say "jobs alive     ${ST_ALIVE}"
    for l in "${WAIT_LINES[@]}"; do say "  on its own clock: ${l}"; done
    for l in "${PARK_LINES[@]}"; do say "  resumes in place: ${l}"; done
    if (( ${#PAUSED_LINES[@]} > 0 )); then
      say "paused runs the supervisor is not resuming:"
      for l in "${PAUSED_LINES[@]}"; do say "  ${l}"; done
    fi
  else
    say "state          UNREADABLE this poll (mid-write, or the exec target is gone)"
  fi
  replicas="$(fleet_replicas)"; ready="$(fleet_ready)"; pods="$(fleet_pods)"
  if [[ -z "${replicas}" ]]; then
    say "deployment     NOT FOUND — is ${FLEET_DEPLOY} installed in ${NAMESPACE}?"
  else
    say "deployment     ${ready}/${replicas} ready"
  fi
  if [[ -n "${pods//[[:space:]]/}" ]]; then
    while IFS= read -r l; do [[ -n "${l//[[:space:]]/}" ]] && say "  pod ${l}"; done <<< "${pods}"
  else
    say "  no fleet pod"
  fi
}

if [[ "${MODE}" == "status" ]]; then print_status; exit 0; fi

if [[ "${MODE}" == "resume" ]]; then
  clear_switch
  # After a `drain` the Deployment is at 0, and a cleared switch on a fleet that
  # is not running schedules exactly nothing. Say so rather than report success.
  if [[ "$(fleet_replicas)" == "0" ]]; then
    say "NOTE: ${FLEET_DEPLOY} is scaled to 0 (a \`drain\` left it there). The switch is clear but"
    say "      nothing is running. Bring it back with:"
    say "        ${KUBECTL[*]} scale ${FLEET_DEPLOY} --replicas=1"
  fi
  exit 0
fi

# -------------------------------------------------------------------- force
if [[ "${MODE}" == "force" ]]; then
  refresh_state
  say "FORCE: recreating the fleet pod now."
  say "  ${ST_ALIVE} job(s) are live. Each pauses inside the 180s grace period; a scored"
  say "  e90/e360 run then ends \`manual\` — the attempt is spent (money and quota"
  say "  with it) and reattempted with a full clock, no strike against the model."
  say "  Freeplay and campaigns with resume:true come back where they left off."
  # A switch left set by an aborted `graceful` is the normal way to arrive here
  # (2026-08-29, item 93): force STARTS the fleet, so leaving the switch set
  # would hand back a fleet that runs and schedules nothing — a state with no
  # use. `drain` is the mode whose job is leaving it set, and it scales to 0
  # instead.
  if [[ "${ST_SWITCH}" == "set" ]]; then
    say "  the pause switch is SET (${ST_WHY}); this clears it after the recreate."
  fi
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    recreate_plan
    if [[ "${ST_SWITCH}" == "set" ]]; then
      say "would: wait up to ${BOOT_WAIT_S}s for a NEW supervisor process, then ${KUBECTL[*]} exec ${EXEC_DEPLOY} -- rm -f ${PAUSE_JSON}"
    fi
    exit 0
  fi
  if [[ "${ASSUME_YES}" -ne 1 ]]; then
    read -r -p "fleet-update: type yes to recreate now: " ans
    [[ "${ans}" == "yes" ]] || die "not confirmed — nothing done"
  fi
  was_started="${ST_STARTED}"
  had_switch="${ST_SWITCH}"
  recreate_fleet
  say "recreated. \`./infra/fleet-update.sh status\` shows the new supervisor's first tick."
  if [[ "${had_switch}" == "set" ]]; then
    say "waiting up to ${BOOT_WAIT_S}s for a NEW supervisor process before clearing the switch"
    await_boot_then_clear "${was_started}" || exit 1
  fi
  exit 0
fi

# --------------------------------------------------------- graceful / drain
#
# 1. set the switch   2. wait for the state file to say no job is alive
# 3. (graceful) recreate and clear the switch; (drain) scale to 0 and leave it set.

WHY="${MODE} supervisor update, $(date '+%Y-%m-%d %H:%M')"
if [[ "${DRY_RUN}" -eq 1 ]]; then
  say "--dry-run: the plan, every resolved value, and every kubectl command; nothing is"
  say "written, scaled or recreated"
  print_status
  say "would: write ${PAUSE_JSON} (${WHY})"
  say "would: read ${STATE_JSON} through ${EXEC_DEPLOY} every ${POLL_S}s for up to ${TIMEOUT_S}s until no run is being waited on"
  say "would: wait on scored runs only — a draining freeplay character, or a resume:true campaign"
  say "       run, counts as drained: it comes back where it left off. On the state as it"
  say "       stands right now — nothing is DRAINING until the switch is set, so a character"
  say "       that will park is listed here as one this window would wait on:"
  refresh_state
  if [[ "${ST_OK}" -eq 1 ]]; then
    for l in "${WAIT_LINES[@]}"; do say "       would wait on:  ${l}"; done
    for l in "${PARK_LINES[@]}"; do say "       counted drained: ${l}"; done
    (( ${#WAIT_LINES[@]} + ${#PARK_LINES[@]} == 0 )) && say "       (no live job)"
  else
    say "       ${STATE_JSON} did not read back — that would NOT be read as quiet"
  fi
  if [[ "${MODE}" == "graceful" ]]; then
    recreate_plan
    say "would: wait up to ${BOOT_WAIT_S}s for a NEW supervisor process, then ${KUBECTL[*]} exec ${EXEC_DEPLOY} -- rm -f ${PAUSE_JSON}"
  else
    say "would: ${KUBECTL[*]} scale ${FLEET_DEPLOY} --replicas=0, and LEAVE the switch set for the deploy"
  fi
  exit 0
fi

set_switch "${WHY}"
# From here the switch is on the PVC, so every way out of this script has to say
# so — an aborted window that looks like nothing happened is a fleet that quietly
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
# A kubectl that fails — an API blip, a rollout that times out — is likelier than
# Ctrl-C, and `set -e` would take exactly the silent exit the abort trap exists
# to prevent. Same promise, same words: nothing was killed, the switch is set.
on_fail() {
  local rc=$?
  trap - ERR INT TERM
  echo
  say "FAILED (exit ${rc}) — nothing was killed and the PAUSE SWITCH IS STILL SET (${PAUSE_JSON})."
  say "The fleet launches nothing and resumes nothing while it is. Read the error above, then:"
  say "  ./infra/fleet-update.sh status"
  say "  ./infra/fleet-update.sh resume    # to abandon the update"
  exit "${rc}"
}
trap on_fail ERR
say "waiting for every live run to finish on its own clock (up to ${TIMEOUT_S}s, polling every ${POLL_S}s)"
say "an e360 run can hold this for six hours; Ctrl-C is safe — the switch stays set and nothing is killed"
refresh_state
if (( ${#PAUSED_LINES[@]} > 0 )); then
  say "NOTE: these runs are paused and will NOT be resumed while the switch is set."
  say "      If the window outlasts a PROVIDER pause's own budget the run is ended stale,"
  say "      and a stale provider pause is a COUNTED failed attempt. Keep the window short"
  say "      or clear the switch (\`fleet-update.sh resume\`) and try again later:"
  for l in "${PAUSED_LINES[@]}"; do say "      ${l}"; done
fi

# Quiet is a claim about the runs a recreate would COST, and only a state file
# this poll actually read back, written by a supervisor that is actually
# ticking, can make it. Three ways to get it wrong: `writeState` is a plain
# writeFileSync, so a poll can land mid-write and read a truncated file (no `ok`
# line — and on the cluster a failed exec looks the same and is treated the
# same); a supervisor that died leaves a file whose `alive: true` rows are
# frozen, not current; and — the one this loop used to get wrong — a live row is
# not automatically a reason to wait. A draining freeplay character or resume:true
# campaign run comes back where it left off, so it is counted as drained; every
# scored e90/e360 is waited out. k8s-deploy.sh reads an unreadable state as
# nothing-to-drain because it only asks AFTER the fleet has scaled to 0 — here
# the fleet is still up and the meaning inverts.
deadline=$(( $(date +%s) + TIMEOUT_S ))
while :; do
  refresh_state
  age=$(( $(date +%s) - ST_HEARTBEAT ))
  if [[ "${ST_OK}" -ne 1 ]]; then
    waiting="${STATE_JSON} did not read back this poll — NOT reading that as quiet"
  elif (( ST_HEARTBEAT == 0 || age > 180 )); then
    waiting="the supervisor's heartbeat is ${age}s old — it is not ticking, so its job rows mean nothing"
  elif (( ${#WAIT_LINES[@]} == 0 )); then
    break
  else
    waiting="${#WAIT_LINES[@]} run(s) still on their own clock (heartbeat ${age}s ago)"
  fi
  if (( $(date +%s) >= deadline )); then
    say "TIMED OUT after ${TIMEOUT_S}s: ${waiting}. Nothing was killed and the switch is still"
    say "set: wait longer (\`fleet-update.sh status\`), or accept the cost and run"
    say "\`fleet-update.sh force\`. Clear the switch with \`fleet-update.sh resume\` to abandon the update."
    for l in "${WAIT_LINES[@]}"; do say "  waiting on:      ${l}"; done
    exit 1
  fi
  say "  ${waiting} — waiting"
  if (( ${#WAIT_LINES[@]} > 0 )); then for l in "${WAIT_LINES[@]}"; do say "      waiting on:      ${l}"; done; fi
  if (( ${#PARK_LINES[@]} > 0 )); then for l in "${PARK_LINES[@]}"; do say "      counted drained: ${l}"; done; fi
  sleep "${POLL_S}"
done
if (( ${#PARK_LINES[@]} > 0 )); then
  say "quiet: no run is on its own clock. ${#PARK_LINES[@]} paused run(s) counted as drained — they resume in place:"
  for l in "${PARK_LINES[@]}"; do say "  counted drained: ${l}"; done
else
  say "quiet: no job holds a live episode."
fi

if [[ "${MODE}" == "drain" ]]; then
  "${KUBECTL[@]}" scale "${FLEET_DEPLOY}" --replicas=0
  # `compose stop fleet` blocked until the container was down, and the deploy
  # starts the moment this returns. `rollout status` on a Deployment scaled to 0
  # does not reliably wait for a pod that is still Terminating, so the POD LIST
  # is what is waited on: the supervisor spends up to its 180s grace writing
  # pause records, and a deploy must not begin on top of that.
  say "waiting for the fleet pod to go away (its 180s grace is where pause records are written)"
  pod_deadline=$(( $(date +%s) + ROLLOUT_WAIT_S ))
  while :; do
    pods="$(fleet_pods)"
    [[ -z "${pods//[[:space:]]/}" ]] && break
    if (( $(date +%s) >= pod_deadline )); then
      say "the fleet pod is STILL THERE ${ROLLOUT_WAIT_S}s after scaling to 0:"
      while IFS= read -r l; do [[ -n "${l//[[:space:]]/}" ]] && say "  ${l}"; done <<< "${pods}"
      say "The switch is set and nothing was killed. Do NOT start a deploy on top of a"
      say "supervisor that may still be writing pause records — read"
      say "\`${KUBECTL[*]} describe ${FLEET_DEPLOY}\` first."
      exit 1
    fi
    sleep 2
  done
  say "fleet scaled to 0, pod gone, nothing live and the switch STILL SET. Do the deploy, then:"
  say "  ${KUBECTL[*]} scale ${FLEET_DEPLOY} --replicas=1 && ./infra/fleet-update.sh resume"
  exit 0
fi

was_started="${ST_STARTED}"
recreate_fleet
say "recreated on the new supervisor code; waiting up to ${BOOT_WAIT_S}s for its first tick"
await_boot_then_clear "${was_started}" || exit 1
trap - INT TERM ERR
say "done: new supervisor up, no run was interrupted."
