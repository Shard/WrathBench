# ADR-0038: The deploy owns the window; the page reads the server's phase

Status: Accepted. Date: 2026-08-23.

## Context
`infra/deploy-worldserver.sh` refused to run while any episode was live and
left the draining to the operator: disable every job, wait for `--status` to
go quiet, deploy, re-enable. With ADR-0036 a fleet stop is a pause, not a
loss, so the refusal protected nothing any more — and in practice the
operator wrote wait loops and `pkill`s around the script, which the operator
decision of 2026-08-23 names a critical bug. Meanwhile the Fleet page, during a
deploy, said "supervisor NOT RUNNING" over a column of "exited" jobs: true,
and exactly wrong.

## Decision
- The deploy script owns the whole window: stop the fleet (runs pause), wait
  for the supervisor's own state file to say no job is alive, swap, wait for
  health, verify with the gate smokes and the full arc, start the fleet (runs
  resume). On failure it rolls back, re-verifies the old build, and still
  starts the fleet. An EXIT trap brings the fleet up on every path: a deploy
  never leaves the fleet stopped. `--allow-live` and the refusal are gone;
  `--dry-run`, `--no-smoke`, `--next-tag` stay.
- The script publishes its phase in `data/runs/server-state.json`
  (`running | draining | swapping | verifying | resuming | rolled-back |
  failed`, with `since`, `build`, `prevBuild`, a `detail` sentence, `pid`,
  `updatedAt`) and holds an `flock` on the sibling `.lock` while it runs. The
  supervisor clears a stale phase only when the lock is free: any phase on
  boot, a window phase on every tick. `/api/fleet` serves the file as
  `server`; the Fleet page prints one banner line — our phase words, then the
  script's detail verbatim — relabels the supervisor line and the exited rows
  while a window is open, and never guesses.
- The drain reads the supervisor's state, never a process listing. `compose
  stop` blocks for the grace chain; if the final state still lists a live job
  60s later the deploy fails before touching the server.

## Alternatives
- Keep the refusal and have the script drain by editing `fleet.json`
  (`enabled:false`) and waiting for episodes to end. Rejected: up to six hours
  of waiting for something ADR-0036 already made free.
- Let the running supervisor gate the new server while the fleet stays up
  (the previous verification path). Rejected: the recreate kills every live
  session anyway, and the supervisor's gate and the script's direct smokes
  raced each other onto the same accounts — the 2026-08-23 false rollback.
- Have the viewer infer the phase from the heartbeat and the jobs. Rejected:
  that is the guess the page was already making, and it was wrong.

## Consequences
- A deploy costs every live run a pause and a resume (and, for the claude-code
  driver, a fresh CLI session), plus the smoke budget with the fleet down.
- `rolled-back` and `failed` stay on the page until the supervisor next boots;
  `docs/OPERATIONS.md` says what to do for each detail.
- The old build's name comes from the live module's `/health` before the swap
  (images built before this ADR carry no label); images built from now on
  also carry `wrathbench.build` as a label.
