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
