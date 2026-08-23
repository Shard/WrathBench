# Episodes

The rulesets a run can be launched under. Every run is tagged with exactly one
episode id, and the id is a comparability group: two runs may only be compared
if they share an id **and** a harness series (`major.minor` of the harness
version; the exact build is recorded and listed, the series is the group —
ADR-0034). The decision and its reasoning
are in `docs/decisions/ADR-0033-run-dimensions-and-the-comparability-tuple.md`;
this page is the definition an operator tags against. Who gets scheduled on
which tier, including promotion, is ADR-0034 — it is stated there and only there.

An id fixes the shape of the run — how long, what start state, which watchdogs,
whether the operator may steer. It fixes nothing about the model: the prompt,
the tools and the loop are identical across all three ids, and no model is ever
told which one it is in.

## `e90` — the default tier

- **Duration.** 90 minutes of wall clock (`episode-limit`).
- **Start state.** A fresh level-1 character, deleted and recreated per episode
  (ADR-0006). Nothing carries over between episodes.
- **Objective.** None. The standing goal only — an operator objective is what
- **Prompt.** The standing goal plus one sentence of fact the model is owed: "This episode lasts 90 minutes. Reaching level 5 within it is the bar for promotion to six-hour episodes." Not an objective — the goal and the scoring are unchanged — and identical for every model.
  makes a run unscored (ADR-0033).
- **Watchdogs.** Idle 20m, no-XP 20m, plus the standing sandbox-restart guard.
  Tool-call ceiling 3000 (1000 per 30 minutes): a runaway guard sized so no legitimately fast model can reach it; tool calls per episode are reported, not scored.
- **Ends.** Normally on `episode-limit`. Also on `idle` or `no-xp` (the model
  stopped, or stopped making progress), `adapter-error` (fatal model API error)
  or `harness-error` (our defect). A `quota-exhausted` or `rate-limited` pause
  is not an end — the run is suspended and resumable.
- **Scoring.** Scored.
- **Promotion.** Every model starts here. Reaching rung 1 in one counted
  episode earns `e360`; the rule, targets and what counts are in ADR-0034.
- **Extras.** A free model past its target may be given extra `e90` runs with
  a different starting race/class (ADR-0034). An extra is this tier — scored,
  same prompt and leash — stamped `extra: true`; it is never counted toward a
  target and never a promotion witness.
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
- **Prompt.** The standing goal plus "This episode lasts six hours." Nothing about levels: past the gate, breadth is the point.
- **Watchdogs.** Idle only. **The no-XP watchdog is off.** Walking across a
  continent earns nothing for hours, and that is the behaviour this tier exists
  to permit — rungs 2–4 of the ladder are travel rungs. A no-XP watchdog here
  would end runs for doing the right thing. Tool-call ceiling **12000** — the
  runaway guard of 1000 calls per 30 minutes (operator, 2026-08-23), sized so a
  fast model cannot touch it; it bounds the claude-code harness's inner loop
  (ADR-0035), not the score.
- **Ends.** As `e90`, minus `no-xp`.
- **Scoring.** Scored, in its own group. An `e360` row never shares a chart with
  an `e90` row: four times the budget is four times the opportunity, and putting
  them on one axis would rank the schedule rather than the models.
- **Promotion in.** Earned on `e90` per ADR-0034. **Out:** none; a model that
  stalls its `e360` runs meets its target and is simply not scheduled here again.
  A paid model's default target here is one run; a promoted free model may get
  `e360` extras once everything else is met (ADR-0034).
- **Pins in the tuple.** `episode: "e360"`, the six-hour budget, idle threshold,
  no-XP disabled (which is not the same as zero), `objective: none`,
  `wikiCoords: false`, and the tool-call ceiling once 48(c) fixes it.

## `freeplay` — labeled and unscored

- **Duration.** Uncapped by the id. A `freeplay` run may set any wall clock or
  none; the navigation probe runs six hours because that is a convenient
  session, not because the id requires it.
- **Start state.** Whatever the experiment needs.
- **Objective.** Allowed. This is the only id where the operator may tell the
  agent where to go (ADR-0033), and `wikiCoords` may be on (ADR-0033).
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
`e90` pins, and a tuple field is never recomputed after the fact (ADR-0033):
saying nothing is more honest than asserting a comparability that was never
established.
