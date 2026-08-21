# ADR-0018: Broad goal, recorded signals, scores derived offline

Status: Accepted. Date: 2026-08-22.

## Context

FOLLOW-UPS 13 required deciding the Phase-1 metric before the first scored
run. The cautionary tale is RuneBench: a raw total-XP objective "punished
exploration" and collapsed play into uninterrupted grinding, and their
mid-evaluation metric change is half of why aggregators exclude their
results. The first measured WrathBench night supplied our own evidence: at
1.0 rates the XP curve runs through quest turn-ins, and quest completion
separated model tiers cleanly where raw XP did not (strong models completed
5–11 quests; weak models accepted-and-abandoned or never accepted, whatever
their kill counts).

WoW's structure also differs from the OSRS case in a way that matters: the
leveling game is a journey around the level spine. Optimal play forces zone
movement, new spells, talent decisions, class quests, and eventually
dungeons; there is no Lumbridge where max level is reachable standing
still. A broad goal is therefore a real instruction with a real gradient,
not an invitation to farm one number.

The operator's direction (2026-08-22): lean toward the long-horizon end of
the spectrum now — up to and including freeplay and agent-to-agent play —
and formalize a stricter timed eval closer to public release.

## Decision

Three commitments, in order of bindingness.

1. **The goal prompt is deliberately broad.** The agent is told to progress
   its character — level, gear, quests, wealth, capability — not to
   maximize a named statistic. The prompt is part of the fixed harness
   (ADR-0004): its wording changes only at a harness version boundary, and
   it never names a formula a model could Goodhart.

2. **The harness records a signal vector, not a score.** Per run, sampled
   or event-sourced: level curve over time, XP, quests completed (with
   quest ids, so quest level/XP weighting stays possible), money, deaths,
   zones/position, spells learned and talents spent (as observation allows),
   playtime, and the existing event/turn counts. Recording is cheap and
   additive; anything derivable from the trajectory later does not need to
   be decided now.

3. **Scores are derived offline from trajectories, never live.** Any
   leaderboard number — level-weighted quest count, level-per-hour curve,
   a composite — is a derivation over recorded signals, versioned in the
   results pipeline, recomputable over every past run. Changing a
   derivation never invalidates a run; changing the recording or the prompt
   does (harness boundary). The stricter timed-eval definition is deferred
   to release time as a derivation-plus-episode-config choice, not a
   harness redesign.

## Consequences

- No single number is promised to models or to readers during this phase;
  the honest artifact is the scorecard.
- Signal recording lands additively (state-table columns, trajectory
  entries); old runs simply lack the new columns and derivations must
  tolerate that.
- Derivation caveat (implementation, 2026-08-22): `quests_completed` in the
  state table counts per StateCache lifetime and resets on sandbox restart —
  derive quest totals from `max()` over a run's state rows or from the
  per-turn-in `quest_complete` trajectory records, never from the final row.
- Goodhart pressure moves from the model to the derivation author — where
  it can be revised without re-running anything.
- Supersedes the open question in FOLLOW-UPS 13.
