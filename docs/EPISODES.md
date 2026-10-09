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
- **Prompt.** The standing goal plus the facts the model is owed: the clock; that reaching level 5 within it is the bar for promotion to six-hour episodes; and that reaching the bar does not end the episode, everything after it being recorded and counting exactly as what came before (`runner/src/prompt.ts` holds the wording). The last is there because models read the bar alone as a finish line and stopped at it. Not an objective — the goal, the bar and the scoring are unchanged — and identical for every model.
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
  `docs/METHODOLOGY.md` ("Episodes, lanes, and evidence", under *The tier is
  the evidence budget*).
- **Extras.** A free model past its target may be given extra `e90` runs with
  a different starting race/class. An extra is this episode — scored,
  same prompt and leash — stamped `extra: true`; it is never counted toward a
  target and never a promotion witness.
- **Pins in the tuple.** `episode: "e90"`, the 90-minute budget, both watchdog
  thresholds, the tool-call ceiling, `objective: none`, `wikiCoords: false`, and
  the reference wiki included (`wiki` is absent unless a run withheld it).

Ninety minutes is short enough that a full roster gets several episodes a
night, which is what makes `e90` the sampling episode. If it turns out to be the
wrong default it will be replaced by a **new id** — never widened in place,
because that would silently re-scope every score already carrying this label.

## `e360` — the long episode

- **Duration.** Six hours of wall clock.
- **Start state.** Identical to `e90`: a fresh level-1 character, same prompt,
  same tools, no carry-over.
- **Objective.** None. This is a scored episode.
- **Prompt.** The standing goal plus one sentence stating the clock. Nothing about levels: past the gate, breadth is the point.
- **Watchdogs.** Idle only. **The no-XP watchdog is off.** Walking across a
  continent earns nothing for hours, and that is the behaviour this episode exists
  to permit — rungs 2–4 of the ladder are travel rungs. A no-XP watchdog here
  would end runs for doing the right thing. Tool-call ceiling **12000** — the
  runaway guard of 1000 calls per 30 minutes, sized so a
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
  `wikiCoords: false`, the reference wiki included (`wiki` is absent unless a run
  withheld it), and the tool-call ceiling.

## `probing` — the probe-campaign episode

A probe exists only as a cell of a checked-in, versioned campaign definition
(operator decision, 2026-10-09). A campaign has two halves:

- **The definition, in git** (`runner/src/campaign-defs/`, one module per
  campaign id, every version kept). This is the static half: the question the
  sweep answers, its cells (each a race and class), the objective if there is
  one, the stopping rule, the clock and watchdogs, the tool-call guard,
  `wikiCoords`/`wiki`, whether a paused run resumes, and the attempt cap that
  says when a cell is abandoned.
  - **A published version is never edited.** `runner/test/campaign-defs.test.ts`
    pins every `id@version`'s content hash, so a change to a definition fails
    the suite until it becomes a new version. A cell whose meaning changes under
    the same id re-scopes every run already recorded against it.
    class-probe's `nightelf-hunter` cell did exactly that: it was class 4
    (Rogue) for its first three runs and was then corrected to class 3 in
    place.
  - **Closed** versions are history: they attribute past runs and launch
    nothing.
- **The store row** (`campaigns/<id>`, `docs/RUNBOOK.md`). This is the
  dynamic half: which version is active, whether it is enabled, which roster
  entries sweep it and how many counted runs each owes per cell, the account
  it is pinned to, and whether an unhealthy model is skipped.

The rule is enforced at both places a probe can come from:

- **The runner, on every fresh launch** (`runner/src/campaign-launch.ts`).
  - `--episode probing` needs `--campaign <id>@<version> --cell <id>`, naming
    an open definition in this checkout and one of its cells.
  - `--campaign` implies `probing`, and with any other episode it is refused.
  - With `--campaign`, the run's shape comes from the definition alone. Every
    flag that would set part of it is refused: `--objective`, `--race`,
    `--class`, `--wiki-coords`, `--wiki`, `--max-tool-calls` and the watchdog
    flags. A different shape is a new version.
  - The run is stamped with the campaign id, `campaignVersion`, the
    definition's `campaignHash` and the cell. A fleet launch also stamps
    `ref`, the roster name it ran as.
  - A `--resume` reloads the run's own stored config and is not checked, so
    every run from before the rule still loads.
- **The fleet.** A queue job naming `probing` is refused, so a probe is never
  a queue job.

What the fleet's argv carries for a probe is its identity alone:
`--episode probing --campaign <id>@<version> --cell <id> --ref <name>`.

- **Duration.** The definition's. The ninety minutes in the episode table is a
  fallback no launch reaches any more, because every open definition states
  its own clock.
- **Start state.** A fresh level-1 character of the cell's race and class.
- **Objective.** Allowed, and set only by the definition. The to-level-10
  campaigns carry none: the standing goal already drives levelling, and naming
  a level is the statistic the goal wording avoids.
- **Watchdogs.** The definition's. Every definition so far keeps the no-XP
  watchdog off, for the same reason it is off on `e360` and more so: a probe
  may spend its whole budget walking somewhere in order to find out what
  happens there.
- **Tool-call ceiling.** The definition's, sized as a runaway guard.
- **Stopping rule.** A definition may set `stopAtLevel`. The run then ends as
  `level-target` on the first server-observed level at or above it, which is
  the server's word and not the model's.
  - It outranks every watchdog but the stale-character check, so a run that got
    there in the tick its clock ran out ended because it got there.
  - It is a verdict and counts like `episode-limit`. The measurement is taken,
    and the rest of the clock would buy nothing.
- **Ends.** Anything, including `manual`.
- **Done.** An (assignment, cell) is done when it holds the assignment's
  `runsPerCell` counted runs, or abandoned once it has had the definition's
  `maxAttemptsPerCell` launches.
  - Both are counted per (campaign, version, roster name, cell). A newer
    version that reuses a cell id is never credited with an older version's
    runs.
  - Completion is derived from the runs on disk, never recorded.
- **Scoring.** **Unscored, always** — the `scored: false` flag is what excludes
  it from the Ladder and every chart, through the same predicate that excludes
  `freeplay`. It still appears in the runs table, which lists every
  run regardless of scorability. Nothing about a probe is a second mechanism.
- **Promotion.** None in either direction, and no target: no tier can buy a
  `probing` run, which is enforced by the type of a tier's run counts rather
  than by a check someone has to remember (`ScoredEpisodeId`). A campaign takes
  a model only when the model owes no counted eval and holds no live or paused
  run. A paused freeplay character therefore blocks its model's assignment
  until that character is ended or resumed.
- **Re-arming.** **A new harness series does not re-arm a campaign.** This is
  the property that separates a probe from an eval, and it falls out rather than
  being built: re-arming is only consequential through a target, and a
  permanently-zero target has nothing to un-meet.
- **Pins in the tuple.** `episode: "probing"` and the unscored reason. The clock,
  the watchdogs and the campaign stamp are recorded, like everything else, but
  carry no comparability claim. That is why a probe run is never reported as
  "overridden": there is no group for it to have fallen out of.

**Reading old runs.** A run is attributed at read time and never rewritten
(`attributeCampaign`). Three rules apply, in order:

1. The run's own stamp.
2. A run stamped with an id but no version belongs to the version whose
   definition claims such runs: class-probe@1 and nav-probe@1. This is only for
   reading and for that version's own work, never for counting a newer
   version's.
3. A run that recorded no campaign at all is placed by a closed definition
   that lists it by run id. These are the nine runs of the next-minor loop
   spike, hand-launched with `--episode probing` before the rule existed, now
   loop-spike@1's.

Every placed run says which rule placed it (`campaignSource`). A run whose
recorded race or class is not its cell's declared start is flagged, never
relabelled.

**The campaigns page.** It shows one pane per version, with a cells × models
grid. Each square gives the counted runs that reached the stop level, the
median minutes of play to it, and the best level. Columns follow the
assignments' order and never pool two harness series, and nothing is sorted by
a result: `probing` has no comparability group (`docs/METHODOLOGY.md`).

**The to-level-10 campaigns.** Both share one shape
(`runner/src/campaign-defs/shapes.ts`): `e360`'s leash with a 12-hour play
ceiling, stop at level 10, resume on pause, three attempts per cell.

- **race-probe@1** holds the class at Warrior and takes each of the ten races
  from its own start. A Blood Elf cannot be a warrior in 3.3.5a, so that cell
  is a Rogue.
- **class-probe@2** holds the start zone at Coldridge Valley for the seven
  classes a Dwarf or a Gnome can play. It adds a Draenei Shaman and a Night Elf
  Druid, the only Alliance options for those two classes.
- **Death Knight is in neither.** The server creates one only on an account
  holding a level-55 character, and it starts at 55.
- **The Horde starts** and the two map-530 starts had never been driven
  before race-probe@1. `infra/smoke/race-probe-starts.ts` creates, walks and
  takes a quest at each one, and race-probe@1 is enabled only after it passes.

`probing` and `freeplay` are both steered and both unscored. What separates them
is the relationship to the schedule: a probe campaign is **commissioned**, runs
a defined sweep to completion and is then disabled, while freeplay is the
standing sandbox that never finishes. Duration separates neither pair.

## `freeplay` — labeled and unscored

- **Duration.** Uncapped by the id. A `freeplay` run may set any wall clock or
  none; the navigation probe runs six hours because that is a convenient
  session, not because the id requires it.
- **Ceilings.** Per job, not per id. A `freeplay` run that names no
  `maxToolCalls` gets the runner's own 500-call runaway guard — the id pins
  nothing. The one exception is the
  policy-generated session in the `idle: "unlimited"` lane below, which
  materialises with no ceiling at all. It is the *job* that earns this, not the
  ref: a freeplay job written into the fleet config that names an idle-capable
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
  here; the default `none` buys nothing, and those are the only two values
  the axis has — a race/class sweep is a probe campaign, not an idle mode,
  because it is an unscored question and would otherwise be asked in the scored
  lane. Once a model has met its tier's targets the
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
  another **on the same character**: a character is durable across the
  operator's disable/re-enable and across its own endings, so the
  next attempt is launched `--continue-from` the last one — same account,
  same character, the scratchpad carried forward — and records the lineage as
  `continued_from` (docs/RUNBOOK.md, "Freeplay characters are durable"). Such a run is stamped `extra: true` — an attempt, shown as an extra
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
(`docs/RUNBOOK.md`, the scheduling policy).

## Runs that lapsed

A run can also stop without a verdict: it pauses, or it goes quiet because the
host slept or the fleet was down. What happens next is the **lane's** rule,
not the model's or the operator's (docs/METHODOLOGY.md, "Episodes, lanes, and
evidence"):

| lane | a pause | a stale run |
|---|---|---|
| `e90`, `e360` | failed attempt, retried fresh | ended, retried fresh |
| `probing` | failed attempt unless the campaign definition says `resume` | ended |
| `freeplay` | resumed | ended; the next tick launches the next attempt on the same character |

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
stay as they are and are deliberately not aligned with `e90`'s pinned 20m/20m.
They are the shape of an untagged
one-off, not a quiet third ruleset: moving them would change every flagless run
without any tuple field saying so, and every run that is scored passes the flag.

## Runs before this page

A run launched before episode ids existed reads `episode: null`, and is never
back-labeled. It ran under the watchdog defaults of its day, which are not what
`e90` pins, and a tuple field is never recomputed after the fact:
saying nothing is more honest than asserting a comparability that was never
established.
