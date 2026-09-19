# Vision
A research workbench to explore the capabilities and expression of AI models within a complex game world. This document isn't a commitment or roadmap.

## Three tracks, one harness

- **Eval track**
  - Fixed eval episodes, versioned harness, scores comparable within a harness version.
  - Episodes come in named tiers: `e90` for sampling, `e360` for the navigational rungs.
  - Model earns more and longer episode runs by promotion rules.
  - Used to create leaderboards and measured comparable data of relatively bounded tasks.
  - Cleanly presented dynamic graphs allowing comparison of different models (and possibly harness features).
- **Freeplay track**
  - Ultra-long-horizon runs with no time cap, more in the spirit of Claude Plays Pokémon
  - Open-ended and mostly up to the agents themselves to decide how to approach the world.
  - "Go play WoW" and the agent owns its own goals, coordination, and (eventually) its own context management.
  - Freeplay runs are labeled `freeplay`, never mixed into eval scores.
  - Agents have more ability to freely interact/communicate with each other compared to eval.
- **Probe track**
  - Unscored commissioned exploration of specific scenarios.
  - Allows for fixture setups, defining more structured test scenarios (eg: a premade dungeon run)
  - Serves as information that can be used for further harness improvement or new eval episodes.

## Milestone ladder
A kind of achievement system for measuring programmatically basic capabilities the models show, which can allow them to be promoted into new episodes. The eight rungs, as the dashboard derives them (`dashboard/src/lib/ladder.ts`):

1. Quest chain in the starting subzone
2. Leave the starting subzone on its own initiative
3. L10: class quest, first talent, spells trained
4. Reach a capital city; use a flight master
5. L20 with riding skill and a mount
6. A 5-man dungeon cleared by a party of agents
7. L40, L60, Outland, Northrend
8. L80, heroics, Icecrown Citadel

### Long term freeplay goals
A few goals of mine for the project, all from level 1 fresh characters with no explicit direction:
- [ ] A group of agents collectively enters and completes a dungeon (ladder rung 6; what it would take is `docs/proposals/GROUP-PLAY.md`)
- [ ] An agent reaches the level 80 cap in freeplay
- [ ] A raid of agents independently conquering Icecrown Citadel.
- [ ] Allow community agents to participate on a community server over custom MCP protocol (incompatible with game clients)

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
contract-clean; anything derived from server-omniscient state is not. Record
the decision when a run makes navigation the obstacle; until then the travel
probe (infra/smoke/travel.ts) is the evidence-gathering instrument.
