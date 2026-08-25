# ADR-0048: Achievements and flight use are observed, not inferred

Status: Accepted — deployed as `harness-0.5-34-g9be594e` 2026-08-25;
`infra/smoke/achievements-taxi.ts` PASS on PROBE the same day (the second
track, SDK/runner/dashboard, is FOLLOW-UPS 79). Date: 2026-08-25.

## Context
ADR-0018 records a signal vector and derives scores offline, so anything the
dashboard wants to claim later has to be in the recording now. Two claims are
owed and were not recordable: rung 4 of the ladder ("reach a capital; use a
flight master") read "not instrumented", and there was no achievement-points
metric at all. Both are exactly what a client is told: the core sends
`SMSG_ACHIEVEMENT_EARNED` as each achievement lands, `SMSG_ALL_ACHIEVEMENT_DATA`
at login with everything earned so far, and `SMSG_ACTIVATETAXIREPLY` when a
flight is accepted or refused; while flying, the character's own
`UNIT_FIELD_FLAGS` carries `UNIT_FLAG_TAXI_FLIGHT`. GitHub issue #8 ("World-level
log for a multi-agent freeplay server, via achievements", formerly FOLLOW-UPS
37) names the achievement packets as the first half of that log; this is that
half.

## Decision
1. **Tap the packets, not the state.** `SMSG_ACHIEVEMENT_EARNED`,
   `SMSG_ALL_ACHIEVEMENT_DATA` (completed block only) and
   `SMSG_ACTIVATETAXIREPLY` join the event whitelist with the shapes in
   `module/PROTOCOL.md`. Being flown is `taxiFlight` on self, a named bit of
   the `unitFlags` the observation stream already served — a flight "starts"
   when the reply is 0 and the bit flips on, and "ends" when it flips off.
   There is no `flight_completed` event because no packet says that; the
   runner reads the flip like a client would.
2. **Names and points are client-cache knowledge.** The module loads
   `Achievement.dbc` from the data volume the way it loads `AreaTable.dbc`
   (ADR-0027 amendment, `WB_AREA`), and puts `name`, `points` and `categoryId`
   on every achievement object. Nothing Blizzard-derived enters git: the file
   stays under `data/`, and the loader refuses any layout but 3.3.5a's.
3. **Activation stays raw.** `CMSG_ACTIVATETAXI` was already allowlisted; no
   helper is added until a trajectory shows the need (ADR-0015).

## Deliberately not done
- **No criteria tracking.** `SMSG_CRITERIA_UPDATE` (which #8 also names) is
  not tapped and the criteria block of `SMSG_ALL_ACHIEVEMENT_DATA` is
  consumed unserved. Progress toward an achievement is not a milestone, the
  packet is noisy (one per counter change, in combat), and decoding it means
  carrying `Achievement_Criteria.dbc` for ids that mean nothing on their own.
  It can be added under the same test if a derivation ever needs it.
- **No server-side achievement queries.** The module never reads
  `AchievementMgr`; a run's achievements are what its own packets said.
- **No taxi-node or map surface.** `SMSG_SHOWTAXINODES` and
  `SMSG_TAXINODE_STATUS` are not served; the agent finds flight masters the way
  it finds anything, and learns a node by visiting it.
- **The second half of #8** — a server-wide position sampler for the freeplay
  world — is not touched and stays deferred under that issue.

## Consequences
- An additive whitelist widening (CONTRACTS: a major harness version when it
  is deployed); runs before it carry no achievement or flight signal, and
  derivations must treat that as "not recorded", not zero (ADR-0018).
- `SMSG_ACHIEVEMENT_EARNED` is a say-range broadcast, so the event carries
  `guid` and `self`; the runner records milestones only for `self: true`.
- Rung 4 and achievement points become derivable once the runner records the
  milestones (second track) and the fleet has run on the deployed image.
