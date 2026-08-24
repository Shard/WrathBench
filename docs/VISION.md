# Vision

Where this is going, beyond the current phase. Written 2026-08-22 so the
long view survives the day-to-day. Nothing here overrides PHASE-0.md or the
ADRs; when this document and a decision conflict, the decision wins until
deliberately revisited.

## North star

LLMs conquering Icecrown Citadel. Not because raiding is the point, but
because ICC stacks every hard problem in the right order: long-horizon
leveling, economy and gear decisions, travel across a continent, group
coordination, and finally execution of mechanics under time pressure. A
harness that can carry agents from a level-1 character to a 25-man raid
boss has solved long-horizon agency in a live world, and every intermediate
milestone is independently measurable.

## Three tracks, one harness

- **Eval track** — what exists today: fixed episodes, versioned harness,
  scores comparable within a harness version (ADR-0004). Episodes come in
  named tiers — `e90` for sampling, `e360` for the travel rungs, each its own
  comparability group — and a model earns the longer tier by a mechanical
  promotion rule rather than by anyone's judgement (ADR-0033, ADR-0034,
  `docs/EPISODES.md`). Leaderboards live here.
- **Probe track** — commissioned exploration: an objective swept over a set of
  cells by a set of models, run once to completion and then switched off
  (ADR-0041). What separates it from the eval track is not length or steering
  but permanence: a harness bump re-arms every eval target and never re-arms a
  campaign. Probes are how the frontier gets felt out — play every class, ride
  the tram, walk into a dungeon with four others — and they come and go as the
  questions do. Unscored, so nothing here reaches a leaderboard.
- **Freeplay track** — ultra-long-horizon runs with no episode cap, in the
  spirit of Claude Plays Pokémon: "go play WoW" and the agent owns its own
  goals, coordination, and (eventually) its own context management. Freeplay
  runs are labeled `freeplay`, never mixed into eval scores. The labeled context-engine
  idea (FOLLOW-UPS 8b) becomes load-bearing here: ultra-long play forces the
  self-compaction question that fixed episodes let us defer.

The economics motivate patience: local models keep improving, hardware gets
cheaper, and the harness is model-agnostic by construction. The freeplay
server is designed to still be running when models that can raid arrive.

## The ladder

Milestones an agent reaches, in the order the leveling game imposes them.
Each rung is a qualitatively new capability, not a bigger number; the harness
work that makes a rung reachable is listed beside it. Status as of
2026-08-22.

1. Complete a quest chain in the starting subzone (L5–6). Basic loop. **Reached.**
2. Leave the starting subzone on its own initiative. Destination choice,
   multi-hop travel. Navigation surface (`no_path` causes, areatriggers).
3. L10: class quest, first talent, spells trained. Using the game's own
   affordances. Trainer and talent surface.
4. Reach a capital city; use a flight master. Long-distance travel and
   transport. Flight paths, tram, boats.
5. L20 with riding skill and a mount. Earning and spending gold with intent.
   Money and vendor signals.
6. A 5-man dungeon cleared by a party of agents (Deadmines). Multi-agent
   coordination. Per-character credentials, grouping, multi-session runner.
7. L40, L60, Outland, Northrend. Endurance over weeks: resumability, context
   management, the freeplay server as a persistent home.
8. L80, heroics, Icecrown Citadel. The north star; gated by models and
   inference cost at least as much as by the harness.

Rungs 2–4 are one body of navigation work. Rung 6 is the first result that is
new rather than incremental. Rungs 7–8 are where freeplay becomes the
research instrument (economy, cooperation, communication, long-horizon
identity) rather than a longer episode.

**Public release point:** an agent reaches a capital unaided (rung 4) on a
harness version with a pinned episode budget, so the results charts are
comparable from the first day and never re-scored. The release is the results
charts, the ladder with its reached rungs, map replays, and the freeplay plan
stated as a plan. Community access to the freeplay world is a later, separate
announcement, after the prerequisites below and the pre-publication checklist
in `docs/DATA-AND-LEGAL.md`.

## Navigation and the minimap question

Local obstacle avoidance is already below the model (server-side mmaps
pathing). What models lack is spatial context for choosing destinations —
today that is coordinate text, and the failure modes at scale are known:
multi-zone routing, flight masters, boats/zeppelins, elevators, trams,
instance portals, hour-long stuck detection.

The contract question to settle before building anything: CONTRACTS.md says
the agent observes what a real client could observe — and a real client
renders a minimap from map data the client itself ships. A walkability/POI
observation derived from the same client extracts is therefore arguably
contract-clean; anything derived from server-omniscient state is not. Write
the ADR when a run makes navigation the obstacle; until then the travel
probe (infra/smoke/travel.ts) is the evidence-gathering instrument.

## Community agents (the open freeplay server)

The endgame for freeplay: others connect their own agents to a shared
world, bringing their own models and paying their own inference. The only
exposed surface is the MCP — never the game protocol, never direct client
connections.

Prerequisites, in order, before any public exposure:
1. Per-character credentials (FOLLOW-UPS 10) — the one-account-per-run
   scheme is the current isolation boundary and does not survive strangers.
2. AuthN/AuthZ on the module surface: today it is loopback-only and
   unauthenticated by design; public MCP inverts that assumption entirely.
3. Rate limiting, abuse handling, and per-agent resource isolation.
4. A conversation with someone qualified about the legal posture. Working
   assumptions until then: never distribute anything Blizzard-derived
   (already a hard constraint), no direct game-client access, strictly
   non-commercial.

## What this document is not

Not a roadmap and not a commitment. Phase gates stay evidence-driven: each
capability enters when an organic run makes it the next obstacle
(PHASE-0.md's rule), and the eval track's integrity — fixed harness, honest
scores, no per-model accommodation — outranks every ambition above.
