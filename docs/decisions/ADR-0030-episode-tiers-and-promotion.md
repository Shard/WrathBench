# ADR-0030: Episode tiers and promotion

Date: 2026-08-23. Status: accepted.

## Context

Everything scored so far has been one shape: a fresh level-1 character, no
operator objective, a 90-minute wall clock. That shape was never named, so it
could not be varied without ambiguity. It now has to be varied. Rungs 2–4 of
the ladder (VISION.md) are travel rungs, and travel is slow: a model that
correctly decides to walk to Ironforge spends an hour of an episode earning
nothing, and the 90-minute clock ends the run before the rung can be reached.
The obvious fix — raise the wall clock — silently re-scopes every existing
score, which ADR-0004 forbids and ADR-0026 was built to make detectable.

So the length of an episode becomes a named thing rather than a number in a
lane's config. Naming it also settles a second problem: a six-hour episode is
expensive, and handing one to a model that cannot survive ninety minutes wastes
a lane for a night. Who gets a long episode has to be decided by a rule that is
written down, not by taste, or the eval track acquires per-model accommodation
through the back door.

## Decision

**Three episode ids. Each id is a comparability group; scores never mix across
ids, and never across harness versions within an id.** The tuple of ADR-0026
gains `episode`.

- **`e90`** — 90-minute wall clock, fresh level-1 character (ADR-0006), no
  operator objective, idle watchdog 20m, no-XP watchdog 20m. The default tier;
  every model starts here.
- **`e360`** — six-hour wall clock, otherwise identical to `e90`: same fresh
  start, same fixed prompt, same tools, no objective. Idle watchdog only. **The
  no-XP watchdog is disabled**, deliberately: hours of travel with zero XP is
  the behaviour this tier exists to permit, and a watchdog that kills it is
  measuring the leash rather than the model.
- **`freeplay`** — no wall clock required, operator objective allowed,
  `wikiCoords` allowed (ADR-0028), labeled and unscored. The navigation probe
  lane is a `freeplay` episode.

`e360` and `freeplay` can both run six hours; duration is not what separates
them. `e360` is a scored group — no objective, names-first, the standing goal
only — and `freeplay` is the lane where the operator is allowed to steer, which
is exactly why it cannot score (ADR-0024 point 3).

**The id determines the leash; an ADR-0024 override is harness development, not
a dimension of the group.** A run whose recorded watchdogs, wall clock or
tool-call ceiling differ from its id's definition is not a member of that group
and does not share its chart. Overrides keep the meaning they had — a two-minute
smoke does not want a six-hour clock — but they now cost group membership
instead of quietly shifting what a group means.

**Promotion is mechanical and recorded.** A model is `e360`-eligible once it
has, **on the current harness version**, two `e90` episodes that both reached
ladder rung 1 (level 5) and neither of which ended `adapter-error`. A run that
paused (`quota-exhausted`, `rate-limited`) and was resumed still counts —
a pause is not a judgement (ADR-0026's resume rules keep such a run readable).
A run that ended `harness-error` counts for neither side: it is our defect, so
it neither qualifies nor disqualifies, and the two qualifying episodes are
simply the next two that are not one.

**Demotion is mechanical too.** Two consecutive `e360` episodes ended by the
idle watchdog return the model to `e90` only. Consecutive means consecutive
within a harness version; a version bump resets eligibility in both directions,
because "on the current harness version" is the whole point of the group.

**Eligibility is a roster field (`tiers`), never a per-model prompt.** The
loop stays model-agnostic (CLAUDE.md): the model is never told which tier it is
in, no prompt text moves with the tier, and the only thing that varies is the
wall clock and the watchdogs — which the tuple already records. Eligibility is
scheduling metadata, computed from run history and written into the roster.

## Alternatives considered

- **Widening `e90` instead of adding `e360`.** Rejected: it re-scopes every
  existing score under a name that already means something. If 90 minutes turns
  out to be the wrong default, the replacement is a **new id**, not a changed
  `e90`.
- **Promotion by operator judgement.** Rejected. A per-model decision about who
  gets more compute is per-model tuning wearing a scheduling hat, and the first
  time it is exercised inconsistently the eval track's integrity claim is gone.
- **A single elastic episode that stops when progress stops.** Rejected: the
  stop condition is the measurement. An episode whose length depends on how well
  the model did makes two rows incomparable by construction.

## Consequences

- The tuple gains `episode` in `runner/src/comparability.ts`, structurally in
  `runner/viewer/api-types.ts`, and as a grouping key on `/api/eval` — the same
  three places `wikiCoords` landed in ADR-0028.
- **Past runs read `episode: null` and are never back-labeled.** They ran with
  the defaults of their day (idle 10m, no-XP 45m), which is not what `e90` pins,
  and ADR-0026 is explicit that recomputing a tuple field asserts a
  comparability that was never established. Adopting `e90` therefore means
  changing the watchdog defaults to 20m/20m, and the first `e90` run is the
  first run after that change.
- **An episode id pins both budget slots, not just the clock.** ADR-0026 keeps
  turns and tool calls separate on purpose, and ADR-0024 records that the
  500-call default is sized for ninety minutes — a six-hour episode on that
  ceiling ends `tool-call-limit` before its clock. The ceiling is a runaway guard,
  not a budget: 1000 calls per 30 minutes (`e90` 3000, `e360` 12000), sized so
  a legitimately fast model never meets it; tool calls per episode are reported,
  not scored. A lane that changes it out of band leaves the group.
- **Scheduling consequence: lanes stop owning accounts.** A lane that owns one
  account serializes its whole roster behind it, and an `e360` job holds that
  account four times as long as an `e90` — so a roster mixing tiers starves.
  The replacement is a pinned set (SHAKEOUT for the subscription lanes, whose
  credentials are not interchangeable) plus a generic pool whose free accounts
  take the next queued job `{model, episode}`. The pool is being built
  separately; this ADR only records why it became necessary.
- The eval surface has one more thing it can be asked and one more way to be
  honest: a chart can be asked which episode id its rows share, and a model with
  no `e360` rows can be told from one that has not qualified.
