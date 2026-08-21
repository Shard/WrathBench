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

## Two tracks, one harness

- **Eval track** — what exists today: fixed episodes, versioned harness,
  scores comparable within a harness version (ADR-0004). Leaderboards live
  here.
- **Freeplay track** — ultra-long-horizon runs with no episode cap, in the
  spirit of Claude Plays Pokémon: "go play WoW" and the agent owns its own
  goals, coordination, and (eventually) its own context management. Freeplay
  runs are labeled, never mixed into eval scores. The labeled context-engine
  idea (FOLLOW-UPS 8b) becomes load-bearing here: ultra-long play forces the
  self-compaction question that fixed episodes let us defer.

The economics motivate patience: local models keep improving, hardware gets
cheaper, and the harness is model-agnostic by construction. The freeplay
server is designed to still be running when models that can raid arrive.

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
