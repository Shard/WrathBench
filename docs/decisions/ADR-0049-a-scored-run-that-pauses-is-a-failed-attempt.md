# ADR-0049: A scored run that pauses is a failed attempt

Status: Accepted. Date: 2026-08-25. Amends ADR-0036, which resumed every paused
run: resuming is now the rule for `freeplay` and an opt-in for a probe
campaign, and never happens on a scored episode. ADR-0036's mechanics — the
SIGTERM/SIGINT split, the episode clock in the pause mark, resume-before-fill,
the defer ladder, the re-pointed-ref rule — stand unchanged for the lanes that
still resume.

## Context

ADR-0036 was written to stop a deploy costing an in-flight `e360`. It fixed
that, and it did it by treating a pause as a suspension: the clock stops, the
account is released, the supervisor picks the run back up on its next boot and
the episode continues from the minute it stopped.

That is right for a sandbox and wrong for a measurement. An `e90` is ninety
minutes of *play*, and the tuple says so — but a run that paused at minute 41,
sat out a two-hour quota window and came back is not ninety minutes of play in
any sense a reader of the ladder would recognise. The world moved on: the
server may have been recreated under it, the character sat logged out, and the
model's own context was restarted (`resumedFresh` on the claude-code driver, a
"this run resumed" notice on every other). We record the run as a member of the
`e90` group anyway. Nothing about the tuple is false; the *episode* is.

Three more things had accumulated on the same seam:

- **A paused run holds its model.** Nothing else is scheduled for it, so a
  model whose provider is out of quota can hold a pool account's worth of
  schedule for as long as the ladder allows and produce, in the end, one run.
- **Taint counted the wrong thing.** ADR-0036's ladder is indexed by how many
  times *one run* has paused. Ten pauses of one run is one attempt; three runs
  that each died on quota is three, and only the second is evidence about the
  model's endpoint.
- **An outage left runs dangling.** A 12.7-hour gap (host asleep, 2026-08-24)
  left a `qwen` pause the supervisor listed forever: past twice its budget, so
  never auto-resumed, and nothing ended it. Every run left live or paused
  through an outage has had its budget elapse in wall clock; none of them is a
  recorded episode, and none of them was being ended.

## Decision

**A run that lapses — pauses, or goes quiet — is resumed only if its lane says
so. Everywhere else it is a failed attempt: ended, its account and character
released, and the model given a fresh attempt with a new run id and a full
clock.**

| lane | a pause | a stale run |
|---|---|---|
| `e90`, `e360` | **failed attempt**, retried fresh | ended, retried fresh |
| `probing` | failed attempt unless `campaigns.<name>.resume` | ended |
| `freeplay` | resumed (ADR-0036, unchanged) | ended; a fresh session starts |

The rule is one pure function (`classifyLapse`, `runner/src/lapse.ts`) that the
supervisor, the roster and `--status` all read, so there is exactly one answer
to "what happens to this run" and it is table-tested.

`campaigns.<name>.resume` defaults to **false** — a probe that paused is
usually better re-swept than continued, and a campaign that genuinely wants
continuity says so. `resume` is refused by name on a roster entry, on a queue
job and in `policy`: whether a lapse resumes is a property of the lane, and a
file that said otherwise meant something specific by it.

### Three strikes, and what a strike is

Three **counted** failures on one (model, episode, harness series) taint the
model for that episode. It is then `blocked` — deliberately not `free`, because
idle work is not the reward for burning three evals — until
`run-fleet.sh --clear-model`, which forgives strikes the way it already forgives
the ladder. This replaces ADR-0036's per-run pause count as the thing that says
"stop trying".

What counts is the termination reason and nothing else:

| what happened | reason written | counts |
|---|---|---|
| the provider refused (`quota-exhausted`, `rate-limited`) | `attempt-failed` | yes |
| the fleet stopped under it (`operator-pause`: a deploy, ADR-0036) | `manual` | no |
| nothing came back for it, and it was not waiting on a provider | `stale` | no |
| nothing came back for it while it waited on its provider | `attempt-failed` | yes |

An operator-pause is the **harness's** doing, so the attempt is spent but the
model is not blamed for it; an offline gap is harness weather for the same
reason. Both distinctions were the operator's call, and both are the reason the
counting predicate is a reason and never a parsed detail string: `manual` and
`stale` are already in `NOT_THE_MODELS_FAULT`, `attempt-failed` joins them, and
`isFailedAttempt` reads one field. Only a run the fleet launched (a `fleet-`
prefix) spends a policy attempt; a hand-started run is listed for the operator
and never ended by the supervisor.

### Stale is a sweep, not a listing

On start and on every tick, a run with no termination whose last activity — its
pause mark when it has one, else its trajectory's mtime — is older than **its
own** recorded `episodeMs` (12h, twice the longest tier, for a run with no wall
clock) is ended. Its own budget rather than a tier nominal, because a run
launched with an overridden watchdog is held to the clock it actually ran under.
A live job's account is left alone: the supervisor cannot name the run ids its
children are playing, and ending a live run's row would be worse than leaving a
dead one open for another tick.

### It is an attempt, never a recorded episode

A failed attempt numbers a run id, shows on the runs page with its reason, and
counts as an attempt spent on the Models page. It is excluded from every
episodes-grain surface through the predicate those surfaces already share
(`unscoredReason` → `unscored (attempt-failed)`), the same way a freeplay run
is — no parallel field, no new filter, and the ADR-0047 grains keep meaning what
they meant.

### The session goes back with the run

A provider-paused run keeps its module session alive on purpose (that is the
in-place retry path). Ending one therefore has to release it, or the fresh
attempt this record promises lands on an account that is still held and dies
`account_in_use`. Every path that ends a lapsed run — the roster's, on its way
past, and the supervisor's — frees the session first.

## Alternatives

- **Resume, but stamp the run "resumed" and let the charts decide.** That is
  today plus a caveat, and a caveat on a row nobody reads before reading the
  level is not a control. It also keeps the model held for the whole pause.
- **Count a resumed run's wall-clock gap and subtract it.** It measures the
  wrong thing twice: the episode is not just minutes, it is a continuous
  session in a world that keeps moving.
- **Let the operator choose per run.** The rule would then be a judgement made
  differently each night — the same argument that made promotion a threshold
  (ADR-0034) and the tier the only budget (ADR-0043).
- **A parallel `attemptFailed` field beside the termination.** The vocabulary
  already had room; a second field would give every surface two things to check
  and one of them to forget.

## Consequences

- A deploy still costs no *evidence* — the attempt is re-run — but it does cost
  the run in flight and roughly its elapsed time. That is the trade ADR-0038's
  deploy window was already sizing for; the mitigation is unchanged (deploy when
  the board is quiet).
- The projection is read once a tick, so a run ended this tick still reads as
  paused in the same tick's `states`: the fresh attempt starts on the tick
  after. Self-healing, and safe — the paused run holds its model in between, so
  nothing double-schedules.
- The runner is untouched. It still pauses, because "the process stopped without
  a verdict" is the honest thing for it to write; turning that into a failed
  attempt is a *scheduling* decision and lives with the scheduler.
- Two things called "tainted" now exist: this one (model × episode × series,
  from failed attempts) and the roster's defer-sidecar taint (one process, one
  spec, launches that never got off the ground). They are different scopes and
  `--status` names both in full.
- The 0.5 config gains no key it does not use: no campaign sets `resume` today,
  so every campaign is re-swept on a pause.
- The harness series does not bump. Nothing about what a run measures changes:
  the counted-run set is unchanged for every run already on disk, and this only
  decides what happens to runs that never became measurements.
