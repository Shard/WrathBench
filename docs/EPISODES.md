# Episodes

The rulesets a run can be launched under. Every run is tagged with exactly one
episode id, and the id is a comparability group: two runs may only be compared
if they share an id **and** a harness series (`major.minor` of the harness
version; the exact build is recorded and listed, the series is the group).
The reasoning is in `docs/METHODOLOGY.md` ("Episodes, lanes, and evidence");
this page is the definition an operator tags against. Who gets scheduled on
which episode, including promotion, is the model's tier — the evidence
budget, stated in METHODOLOGY and nowhere else. Note that **tier** is not a
word for an episode: a tier is
a rung of the evidence ladder (`t0`/`t1`/`t2`) — how many runs a model gets —
and an episode is the ruleset a run happens under. This page is about episodes.

An id fixes the shape of the run — how long, what start state, which watchdogs,
whether the operator may steer. It fixes nothing about the model: the prompt,
the tools and the loop are identical across all four ids, and no model is ever
told which one it is in.

Two of the four ids are **scored** (`e90`, `e360`) and two are **steered**
(`probing`, `freeplay`). That split is the one that matters: a scored id fixes
its own leash and forbids an objective, so its runs form a comparability group;
a steered id lets an operator point the agent somewhere, which is exactly why it
can never score. `runner/src/episodes.ts` carries the `scored` flag per id and
everything else is derived from it — no list of names decides what counts.

## `e90` — the default episode

- **Duration.** 90 minutes of wall clock (`episode-limit`).
- **Start state.** A fresh level-1 character, deleted and recreated per
  episode. Nothing carries over between episodes.
- **Objective.** None. The standing goal only — an operator objective is what
  makes a run unscored.
- **Prompt.** The standing goal plus one sentence of fact the model is owed: "This episode lasts 90 minutes. Reaching level 5 within it is the bar for promotion to six-hour episodes." Not an objective — the goal and the scoring are unchanged — and identical for every model.
- **Watchdogs.** Idle 20m, no-XP 20m, plus the standing sandbox-restart guard.
  Tool-call ceiling 3000 (1000 per 30 minutes): a runaway guard sized so no legitimately fast model can reach it; tool calls per episode are reported, not scored.
- **Ends.** Normally on `episode-limit`. Also on `idle` or `no-xp` (the model
  stopped, or stopped making progress), `adapter-error` (fatal model API error)
  or `harness-error` (our defect). A run that **pauses** — its provider refused,
  or the fleet stopped under it — ends too: a scored episode does not resume.
  It is a **failed attempt** (`attempt-failed`, or `manual` when the
  harness stopped it, or `stale` when nothing came back for it), its account and
  character go back, and the model gets a fresh attempt with a new run id and a
  full clock. Three counted failures on an episode and the model is tainted for
  it until an operator clears the model.
- **Scoring.** Scored.
- **Promotion.** A model on `t1` that reaches rung 1 in one counted episode
  climbs to `t2`, which is what buys an `e360`; a model on `t0` keeps the
  witness and stays. The rule, the budgets and what counts:
  `docs/METHODOLOGY.md` ("The tier is the evidence budget").
- **Extras.** A free model past its target may be given extra `e90` runs with
  a different starting race/class. An extra is this episode — scored,
  same prompt and leash — stamped `extra: true`; it is never counted toward a
  target and never a promotion witness.
- **Pins in the tuple.** `episode: "e90"`, the 90-minute budget, both watchdog
  thresholds, the tool-call ceiling, `objective: none`, `wikiCoords: false`.

Ninety minutes is short enough that a full roster gets several episodes a
night, which is what makes `e90` the sampling episode. If it turns out to be the
wrong default it will be replaced by a **new id** — never widened in place,
because that would silently re-scope every score already carrying this label.

## `e360` — the long episode

- **Duration.** Six hours of wall clock.
- **Start state.** Identical to `e90`: a fresh level-1 character, same prompt,
  same tools, no carry-over.
- **Objective.** None. This is a scored episode.
- **Prompt.** The standing goal plus "This episode lasts six hours." Nothing about levels: past the gate, breadth is the point.
- **Watchdogs.** Idle only. **The no-XP watchdog is off.** Walking across a
  continent earns nothing for hours, and that is the behaviour this episode exists
  to permit — rungs 2–4 of the ladder are travel rungs. A no-XP watchdog here
  would end runs for doing the right thing. Tool-call ceiling **12000** — the
  runaway guard of 1000 calls per 30 minutes (operator, 2026-08-23), sized so a
  fast model cannot touch it; it bounds the claude-code harness's inner loop,
  not the score.
- **Ends.** As `e90`, minus `no-xp`.
- **Scoring.** Scored, in its own group. An `e360` row never shares a chart with
  an `e90` row: four times the budget is four times the opportunity, and putting
  them on one axis would rank the schedule rather than the models.
- **Promotion in.** Earned on `e90` per the tier rule: a `t1` model that reaches rung
  1 climbs to `t2`, and `t2` is the tier that buys an `e360`. **Out:** none; a
  model that stalls its `e360` runs meets its target and is simply not scheduled
  here again. Every tier's budget is the same whoever is paying — billing says
  where a run may execute, never how many.
- **Pins in the tuple.** `episode: "e360"`, the six-hour budget, idle threshold,
  no-XP disabled (which is not the same as zero), `objective: none`,
  `wikiCoords: false`, and the tool-call ceiling.

## `probing` — the probe-campaign episode

- **Duration.** Ninety minutes by default, and the default is the point: the
  number lives in the table so a campaign that names no clock inherits
  something sane, but a campaign may set its own and the id enforces nothing.
  This is the opposite of `e90`, where ninety minutes is a pin.
- **Start state.** Whatever the campaign's cell says.
- **Objective.** Allowed, and in practice always present — a campaign *is* an
  objective plus the set of cells it is swept over.
- **Watchdogs.** Idle 20m. **The no-XP watchdog is off**, for the same reason it
  is off on `e360` and more so: a probe may spend its whole budget walking
  somewhere in order to find out what happens there, and ending it for earning
  nothing would destroy the observation it was commissioned to make.
- **Tool-call ceiling.** None pinned; the campaign's own stands.
- **Ends.** Anything, including `manual`.
- **Scoring.** **Unscored, always** — the `scored: false` flag is what excludes
  it from the Ladder and every chart, through the same predicate that excludes
  `freeplay`. It still appears in the runs table, which lists every
  run regardless of scorability. Nothing about a probe is a second mechanism.
- **Promotion.** None in either direction, and no target: no tier can buy a
  `probing` run, which is enforced by the type of a tier's run counts rather
  than by a check someone has to remember (`ScoredEpisodeId`).
- **Re-arming.** **A new harness series does not re-arm a campaign.** This is
  the property that separates a probe from an eval, and it falls out rather than
  being built: re-arming is only consequential through a target, and a
  permanently-zero target has nothing to un-meet.
- **Pins in the tuple.** `episode: "probing"` and the unscored reason. The clock
  and the watchdogs are recorded, like everything else, but carry no
  comparability claim — which is why a probe run is never reported as
  "overridden": there is no group for it to have fallen out of.

`probing` and `freeplay` are both steered and both unscored. What separates them
is the relationship to the schedule: a probe campaign is **commissioned**, runs
a defined sweep to completion and is then disabled, while freeplay is the
standing sandbox that never finishes. Duration separates neither pair.

## `freeplay` — labeled and unscored

- **Duration.** Uncapped by the id. A `freeplay` run may set any wall clock or
  none; the navigation probe runs six hours because that is a convenient
  session, not because the id requires it.
- **Ceilings.** Per job, not per id. A `freeplay` run that names no
  `maxToolCalls` gets the runner's own 500-call runaway guard, exactly as a
  `probing` run does — the id pins nothing. The one exception is the
  policy-generated session in the `idle: "unlimited"` lane below, which
  materialises with no ceiling at all. It is the *job* that earns this, not the
  ref: a freeplay job written into the fleet file that names an idle-capable
  ref is an ordinary experiment and keeps the 500.
- **Start state.** Whatever the experiment needs.
- **Objective.** Allowed. One of the two steered ids where the operator may tell
  the agent where to go, and where `wikiCoords` may be on (the run-dimension
  rule in `docs/METHODOLOGY.md`; `freeplay` was the only steered id until the
  probe lane arrived).
- **Watchdogs.** Set per experiment; recorded, like everything else.
- **Ends.** Anything, including `manual`.
- **Scoring.** **Unscored, always.** The run carries the same `unscored`
  labeling machinery as every other steered run, so a freeplay result cannot
  drift into the Ladder by being forgotten about.
- **Promotion.** None in either direction. A freeplay run neither qualifies nor
  disqualifies a model for anything.
- **Extras.** A model whose entry says `idle: "unlimited"` takes its extras
  here; the default `none` buys nothing, and those are now the only two values
  the axis has. (It briefly had a third, `idle: "characters"`, which spent a
  spare account on a scored run with the next race/class in a code-side cycle.
  That was an unscored question asked in the scored lane, so it became
  the class-probe campaign instead.) Once a model has met its tier's targets the
  policy gives it one continuous freeplay session at a time, with **no episode
  wall-clock cap and no tool-call ceiling** — a runaway guard sized in calls per
  thirty minutes means nothing on a session with no minutes, and it was ending
  these sessions in its own right: four of the first six `sub-opus-low`
  freeplay runs terminated `tool-call-limit` at 500 calls, after which the fleet
  started a fresh run on a fresh level-1 character. A policy-generated freeplay
  job on such a ref materialises with `maxToolCalls: null`, and only that
  combination does — a hand-written freeplay job on the same ref does not. It is governed by the 20-minute
  idle watchdog; when the model remains active, its character and progress
  continue beyond six hours. When that session ends, the next tick starts
  another. Such a run is stamped `extra: true` — an attempt, shown as an extra
  on the Models page and as a `freeplay` run on the Episodes page, never counted
  toward an `e90`/`e360` target. A new harness series re-arms the scheduled runs
  first (counting is series-keyed), and freeplay resumes once they are met.
- **Pins in the tuple.** `episode: "freeplay"` and the unscored reason. The
  other fields are recorded but carry no comparability claim.

`e360` is six hours long; `freeplay` has no episode wall-clock cap. Duration is not what
separates them — steering is. `e360` is the standing goal with a longer clock;
`freeplay` is where a human is allowed to point.

## Runs that produced nothing

A run that terminates without a single model response is archived by the runner
as it exits (`data/runs/archive/`), so it never appears in a listing, a count or
a chart: it is a launch that did not happen, not a short episode. A *paused* run
with no response yet is not one — it is still in progress until the supervisor
decides what becomes of it. The scheduler still reads the archive, because
consecutive such launches are what the defer ladder backs off from
(`docs/OPERATIONS.md`, the scheduling policy).

## Runs that lapsed

A run can also stop without a verdict: it pauses, or it goes quiet because the
host slept or the fleet was down. What happens next is the **lane's** rule,
not the model's or the operator's (docs/METHODOLOGY.md, "Episodes, lanes, and
evidence"):

| lane | a pause | a stale run |
|---|---|---|
| `e90`, `e360` | failed attempt, retried fresh | ended, retried fresh |
| `probing` | failed attempt unless `campaigns.<name>.resume` | ended |
| `freeplay` | resumed | ended; the next tick starts a fresh session |

A failed attempt is an **attempt spent**: it numbers a run id, it shows on the
runs page with its reason, and it is never a recorded episode — the ladder, the
episodes grain and every chart drop it, the same way they drop a freeplay run.
Only a provider's refusal (`quota-exhausted`, `rate-limited`) counts toward the
three strikes; a fleet stop and an offline gap are the harness's doing.

## Runs launched without an episode

A run launched without `--episode` is not a member of any episode. It reads
`episode: null`, the scheduling policy counts it toward nothing (no target, no
promotion, no chart), and it therefore carries no comparability claim to
protect. So the bare watchdog defaults in the runner — idle 10m, no-XP 45m —
stay as they are and are deliberately not aligned with `e90`'s pinned 20m/20m
(item 48(g), decided 2026-08-23; closed — `docs/worklogs/2026-08-23.md`). They are the shape of an untagged
one-off, not a quiet third ruleset: moving them would change every flagless run
without any tuple field saying so, and every run that is scored passes the flag.

## Runs before this page

A run launched before episode ids existed reads `episode: null`, and is never
back-labeled. It ran under the watchdog defaults of its day, which are not what
`e90` pins, and a tuple field is never recomputed after the fact:
saying nothing is more honest than asserting a comparability that was never
established.
