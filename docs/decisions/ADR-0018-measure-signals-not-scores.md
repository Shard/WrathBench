# ADR-0018: Broad goal, recorded signals, scores derived offline

Status: Accepted. Date: 2026-08-22.

## Context
The Phase-1 metric had to be decided before the first scored run. RuneBench's
raw total-XP objective collapsed play into grinding, and its mid-evaluation
metric change is half of why aggregators exclude it. Our own first night showed
quest completion separated model tiers where raw XP did not. WoW also differs
from OSRS in a way that matters: leveling is a journey around the level spine —
zones, spells, talents, dungeons — with nowhere to reach max level standing
still. A broad goal is a real instruction with a real gradient, not an
invitation to farm one number.

## Decision
1. **The goal prompt is deliberately broad**: progress the character — level,
   gear, quests, wealth, capability — never a named statistic. Its wording
   changes only at a harness boundary (ADR-0004) and never names a formula a
   model could Goodhart.
2. **The harness records a signal vector, not a score**: level curve, XP,
   quests completed with ids, money, deaths, position, spells and talents as
   observation allows, playtime, event and turn counts. Recording is cheap and
   additive; anything derivable later need not be decided now.
3. **Scores are derived offline from trajectories, never live.** Any leaderboard
   number is a versioned derivation over recorded signals, recomputable over
   every past run. Changing a derivation never invalidates a run; changing the
   recording or the prompt does. The stricter timed eval is deferred to release
   as a derivation-plus-episode choice, not a harness redesign.

## Consequences
- No single number is promised during this phase; the honest artifact is the
  scorecard.
- Old runs lack new columns; derivations must tolerate that. (`quests_completed`
  in the state table resets on sandbox restart — derive totals from `max()` or
  the per-turn-in records, never the final row.)
- Goodhart pressure moves from the model to the derivation author, where it can
  be revised without re-running anything.

## Amendment (2026-08-23): the ladder's row ordering

The dashboard ladder puts one row per model in an order, and an order over
models is a claim. FOLLOW-UPS 13 held that claim open rather than let it stand
unstated. The operator's decision, recorded here so it can be argued with:

**Rows are ordered by highest rung reached, then total XP, then gold.**

- **Total XP** is the pair `(level, xp-within-level)` compared lexicographically,
  taken from the model's furthest run. It is not a synthesised
  `level * K + xp` integer: no XP-per-level table exists in what the harness
  records, so that number would be invented. The pair *is* the total-XP
  ordering, because xp resets at every ding and level never falls.
- **Gold** is the copper on the newest sample a run recorded — the same number
  the fleet listing and the run page show. No state sample the eval surface
  reads carries money, so a peak is not derivable and none is claimed.
- Both tie-breaks are maxima over the model's counted runs and are independent,
  so the gold usually comes from a different run than the level; each names its
  run on the page. `runs` and the model name break what is left, so the order is
  total and stable.
- A missing reading sorts **last**, never as zero: 0 copper and 0 xp are real
  readings, null is "never recorded" (the consequence above, applied).

This is a derivation over recorded signals under rule 3, not a new metric under
rule 2: nothing was added to the recording, nothing is summed, and **no
aggregate score exists** — the row shows the rung, the pair and the gold as
three separate numbers. It is versioned with the dashboard, in
`dashboard/src/lib/eval.ts` where its tests are, and is recomputable over every
past run; changing it invalidates nothing. The Goodhart exposure item 13 named
is unchanged in kind and is now stated rather than implicit: the ordering is a
bucketed furthest-level ranking with two sub-orderings, and it is the
derivation author's to revise.
