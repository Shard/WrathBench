# Episodes

The rulesets a run can be launched under. Every run is tagged with exactly one
episode id, and the id is a comparability group: two runs may only be compared
if they share an id **and** a harness version. The decision and its reasoning
are in `docs/decisions/ADR-0030-episode-tiers-and-promotion.md`; this page is
the definition an operator tags against.

An id fixes the shape of the run — how long, what start state, which watchdogs,
whether the operator may steer. It fixes nothing about the model: the prompt,
the tools and the loop are identical across all three ids, and no model is ever
told which one it is in.

## `e90` — the default tier

- **Duration.** 90 minutes of wall clock (`episode-limit`).
- **Start state.** A fresh level-1 character, deleted and recreated per episode
  (ADR-0006). Nothing carries over between episodes.
- **Objective.** None. The standing goal only — an operator objective is what
  makes a run unscored (ADR-0024).
- **Watchdogs.** Idle 20m, no-XP 20m, plus the standing sandbox-restart guard.
  Tool-call ceiling 500, the runaway guard sized for this length.
- **Ends.** Normally on `episode-limit`. Also on `idle` or `no-xp` (the model
  stopped, or stopped making progress), `adapter-error` (fatal model API error)
  or `harness-error` (our defect). A `quota-exhausted` or `rate-limited` pause
  is not an end — the run is suspended and resumable.
- **Scoring.** Scored.
- **Promotion.** Every model starts here and stays eligible for it forever.
  Two `e90` episodes on the current harness version that reach rung 1 (level 5)
  and do not end `adapter-error` make the model `e360`-eligible.
- **Pins in the tuple.** `episode: "e90"`, the 90-minute budget, both watchdog
  thresholds, the tool-call ceiling, `objective: none`, `wikiCoords: false`.

Ninety minutes is short enough that a full roster gets several episodes a
night, which is what makes `e90` the sampling tier. If it turns out to be the
wrong default it will be replaced by a **new id** — never widened in place,
because that would silently re-scope every score already carrying this label.

## `e360` — the long tier

- **Duration.** Six hours of wall clock.
- **Start state.** Identical to `e90`: a fresh level-1 character, same prompt,
  same tools, no carry-over.
- **Objective.** None. This is a scored tier.
- **Watchdogs.** Idle only. **The no-XP watchdog is off.** Walking across a
  continent earns nothing for hours, and that is the behaviour this tier exists
  to permit — rungs 2–4 of the ladder are travel rungs. A no-XP watchdog here
  would end runs for doing the right thing. Tool-call ceiling **2000**: the same
  ratio to the clock as `e90`'s 500 (four times the minutes, four times the
  calls), pinned 2026-08-23 by the operator rather than tuned to any model.
- **Ends.** As `e90`, minus `no-xp`.
- **Scoring.** Scored, in its own group. An `e360` row never shares a chart with
  an `e90` row: four times the budget is four times the opportunity, and putting
  them on one axis would rank the schedule rather than the models.
- **Promotion in.** Two qualifying `e90` episodes, as above. **Out:** two
  consecutive `e360` episodes ended by the idle watchdog return the model to
  `e90` only — a model that stalls has stopped using the budget it was given.
  Both directions reset on a harness version bump.
- **Pins in the tuple.** `episode: "e360"`, the six-hour budget, idle threshold,
  no-XP disabled (which is not the same as zero), `objective: none`,
  `wikiCoords: false`, and the tool-call ceiling once 48(c) fixes it.

## `freeplay` — labeled and unscored

- **Duration.** Uncapped by the id. A `freeplay` run may set any wall clock or
  none; the navigation probe runs six hours because that is a convenient
  session, not because the id requires it.
- **Start state.** Whatever the experiment needs.
- **Objective.** Allowed. This is the only id where the operator may tell the
  agent where to go (ADR-0024), and `wikiCoords` may be on (ADR-0028).
- **Watchdogs.** Set per experiment; recorded, like everything else.
- **Ends.** Anything, including `manual`.
- **Scoring.** **Unscored, always.** The run carries the same `unscored`
  labeling machinery as every other steered run, so a freeplay result cannot
  drift into an eval chart by being forgotten about.
- **Promotion.** None in either direction. A freeplay run neither qualifies nor
  disqualifies a model for anything.
- **Pins in the tuple.** `episode: "freeplay"` and the unscored reason. The
  other fields are recorded but carry no comparability claim.

`e360` and `freeplay` are both often six hours long. Duration is not what
separates them — steering is. `e360` is the standing goal with a longer clock;
`freeplay` is where a human is allowed to point.

## Runs before this page

A run launched before episode ids existed reads `episode: null`, and is never
back-labeled. It ran under the watchdog defaults of its day, which are not what
`e90` pins, and a tuple field is never recomputed after the fact (ADR-0026):
saying nothing is more honest than asserting a comparability that was never
established.
