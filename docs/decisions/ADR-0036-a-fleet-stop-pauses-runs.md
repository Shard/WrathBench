# ADR-0036: A fleet stop pauses runs; a fleet start resumes them

Status: Accepted. Date: 2026-08-23.

## Context
Under ADR-0020 the supervisor is a compose service, and every code change,
epoch roll or worldserver recreate is a `stop fleet` / `up -d fleet`. A stop
SIGTERMed every runner, and the runner ended its run as `manual`: a six-hour
`e360` forty minutes from the wall clock was thrown away to pick up a one-line
fix, and under the policy (ADR-0034) `manual` is "not the model's fault", so the
run did not even count — it was simply rerun from level 1. The operator's
decision: a stop or recreate must not cost in-flight runs.

The pieces already existed. The runner had pause reasons (`quota-exhausted`,
`rate-limited`, and an unused `operator-pause`) and `--resume`, which reattaches
the trajectory, the scratchpad and the game session by token. What was missing
was the episode clock (a resumed run restarted its wall clock), a stop that
chose pause over terminate, and a supervisor that went looking for paused runs.

## Decision
- **SIGTERM pauses, SIGINT terminates.** The runner reads the supervisor's
  stop as `operator-pause`: it abandons the request in flight (the adapter's
  fetch carries the signal) or tears down its CLI child, writes the pause
  record with the episode clock spent so far, marks meta.json with a pause
  mark, and releases the game session so the account is free — a logout,
  never a character wipe. Ctrl-C on a hand-started run stays `manual`. Two
  signals, two meanings, no flag: `docker compose stop`, a drain and a
  recreate all send SIGTERM and all mean "later", while a hand on the keyboard
  means "stop".
- **The episode budget is minutes of play, not of calendar.** The pause mark
  carries `episodeElapsedMs`; the resumed watchdog starts from it. A run that
  restarted three times still gets exactly its 90 or 360 minutes.
- **Resume before fill.** On boot, and on every tick after, the supervisor
  maps each paused run back to a job by what the run recorded (model, effort,
  tier) and spawns that job's roster with the paused run id first, on the same
  account, before the queue or the policy gets an account. A run whose job is
  gone from the file is listed, never resumed or rescheduled by the machine;
  one older than twice its budget is stale and listed too.
- **Provider pauses ride the same path.** A `rate-limited` or
  `quota-exhausted` run is resumed on the roster's defer ladder, indexed by
  how many times that run has paused, continuing the cadence the roster was on
  before its process gave up. That closes FOLLOW-UPS 43 for the free pools and
  the subscription lane alike: the run is held, not ended, and comes back when
  the window reopens.
- **A paused run is neither counted nor retried.** It is an attempt, it holds
  its model in the projection (one stream per model includes a paused one),
  and it counts toward a target or a ladder rung only when it finally ends.
- **The claude-code driver resumes fresh.** The CLI owns its conversation and
  a `-p` session is not reattached; the run restarts the CLI with the same
  fixed prompt and the scratchpad, the same resume notice every driver gets,
  and is stamped `resumedFresh: true`. Model-agnostic by construction: nothing
  in the notice or the prompt depends on the driver.

## Alternatives
- A `--pause-on-term` flag from the roster, so a hand `kill` still means
  `manual`. Rejected: the runner would have two stop behaviours to keep
  straight, and every supervisor-shaped sender (compose, systemd, Kubernetes)
  sends SIGTERM. The signal is the flag.
- Persisting the job name in the run's meta so a resume needs no mapping.
  Rejected for now: the runner does not know about jobs, and the mapping by
  (model, effort, tier) is the same one the projection already uses to count
  runs. A run the mapping cannot place is exactly a run the operator should
  look at.
- Resuming a pool run on whichever account is free. Impossible: the character
  lives on the account, and a fresh launch elsewhere would start at level 1.

## Consequences
- The restart procedure in docs/OPERATIONS.md is "stop → (runs pause) → start
  → (runs resume)". The grace chain is runner 60s backstop, roster 90s SIGKILL
  grace, service 180s `stop_grace_period`; the supervisor polls every 2s while
  stopping so it exits inside that.
- Runs started by a runner process older than this change still end `manual`
  on their last stop; every run launched after it pauses.
- A pinned loop job resumed mid-cycle numbers its next cycle from the resumed
  id (`…-c2-c2`): unique, ugly, and honest about what happened.
