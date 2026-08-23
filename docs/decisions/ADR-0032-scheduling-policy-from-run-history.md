# ADR-0032: Scheduling policy from run history

Date: 2026-08-23. Status: accepted. Amends ADR-0030 (promotion) and ADR-0031
(queue as the only source of pool work).

## Context

ADR-0031 made the pool: free accounts take jobs from an ordered `queue`. The
queue was hand-written — six looping jobs mirroring the six lanes of the day —
and ADR-0030 made promotion into `e360` a roster edit an operator records after
reading the eval surface. Both were deliberate: a tier change is a
comparability change, so it wanted a recorded decision rather than a threshold
that flips at 03:00.

A night of running it showed the cost. The queue needed editing every time a
model was added, pruned, or earned a longer run; a looping job held its account
whether or not the model had anything left to prove; a provider that refused
every launch was relaunched on the roster's own ladder inside its lane, and the
lane's account sat behind it. What the operator actually wants is not a list of
jobs but a statement of **how much evidence per model** — three runs per
(model, episode) — and a scheduler that gets there on its own, spends nothing on
a model that has met its target, backs off a model that is not launching, and
stops trying one that never will.

## Decision

**The queue becomes an override. The default source of pool work is a policy
computed from run history**, in one pure projection
(`runner/src/models.ts: modelStates`) that the supervisor, `--status`,
`--dry-run` and the viewer's `/api/models` all read. There is one answer to
"why is this model not running", and it is derived, never stored.

- **Targets.** Three runs per (model, episode) by default; `policy.runsPerEpisode`
  in the fleet file changes the default and `roster.<name>.runsPerEpisode`
  changes one entry.
- **What counts.** Only runs stamped with an episode id count at all (ADR-0030:
  no back-labeling; history before the stamp is invisible to the schedule). A
  stamped run counts toward its target when it is un-overridden and produced at
  least one model response. A **stillborn** run — zero `response` records and
  not live, the viewer's definition — does not count toward the target but does
  count toward the ladder.
- **Eligibility.** Every roster model is `e90`-eligible on arrival. It becomes
  `e360`-eligible automatically once one counted, un-overridden `e90` run has
  reached level 5 (rung 1). `tiers` on a roster entry survives only as a manual
  force; `freeplay` is never scheduled by the policy.
- **The ladder.** Consecutive no-progress attempts — stillborn, or ended
  `adapter-error` — index `1m/3m/5m/10m/15m/30m/1h/3h/6h`; the model cools
  until the last failure's end plus the rung. An attempt made at the 6h ceiling
  that still makes no progress **retires** the model: it is never scheduled
  again until `run-fleet.sh --clear-model <name>`, which records the clear in
  `data/runs/fleet-models.json`. The clear is the only state the policy
  persists; it works by ignoring attempts that ended before it, so the ladder
  itself stays a function of the run directories.
- **Priority** for the next free pool account: (1) models with zero counted runs
  on any episode they are eligible for; (2) the shorter episode first; (3)
  fewest counted runs toward target; ties by roster order. One stream per model
  at a time; pinned lanes untouched.
- **Precedence.** Manual `queue` entries outrank the policy: the policy fills
  only the accounts the queue leaves free, and never while a runnable manual
  job is waiting for one. The queue's own tier gate reads the same projection,
  so a manual `e360` job for an unpromoted model is still skipped with a reason
  unless the entry forces the tier.

A policy job is an ordinary one-run job to the rest of the supervisor — lane
`<name>-<episode>`, run id `fleet-<name>-<episode>-<model>-<stamp>` with
`-a<n>` from the second attempt — so the preflight gate, the drain path and the
state file cover it for free.

## Alternatives considered

- *Keep promotion as a recorded roster edit* (ADR-0030). The recorded decision
  was meant to keep per-model accommodation out of the schedule. A threshold
  written down once and applied to every model alike is the same guarantee with
  less operator latency; what ADR-0030 was guarding against is a decision that
  is made differently per model, and a rule in code cannot be.
- *Persist the ladder in a sidecar the supervisor writes.* Rejected: two
  sources of truth for the same fact, and a supervisor restart or a hand-launched
  run would desynchronise them. Deriving it from the run directories means the
  status a reader prints is the status the supervisor acts on.
- *Filter counted runs by harness version.* The comparability surface already
  separates versions; making the schedule do it too would restart every model's
  evidence on each bump and keep the fleet perpetually on rung zero. Recorded,
  not filtered, for now.

## Consequences

- ADR-0030's promotion paragraph is superseded by this one: one qualifying run,
  not two; automatic, not recorded by hand; demotion is not implemented (a model
  that idles its e360 runs simply meets its target and stops being scheduled).
- `fleet.next.json` ships with an empty queue; the roster and the pool are the
  whole schedule. The live `fleet.json` is untouched until the drain window.
- The run history on disk at the time of this ADR carries no episode stamps
  (the live fleet predates `--episode`), so the policy starts every model at
  zero. That is correct: those runs ran under the leash of their day.
- `--status` prints a per-model block; `--dry-run` prints the policy's picks.
  A Models page over `/api/models` is the same projection served.
