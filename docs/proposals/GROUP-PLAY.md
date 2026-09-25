# Group play (ladder rung 6)

Status: proposal. Nothing here is decided, and nothing here is an agent's to
decide — the scoring questions at the end are the operator's.

## What rung 6 asks for

"A 5-man dungeon cleared by a party of agents" (docs/VISION.md's ladder, and
its long-term freeplay goal "a group of agents collectively enters and completes
a dungeon"). It is the only rung the ladder page has never been able to answer:
its cell reads *not instrumented* for every model, and unlike the other holes
that is not a missing derivation over records we already keep. There are no
records to derive from.

## Why the harness cannot produce it

Two gaps, and they are different in kind.

**No group or instance record.** The milestone series covers what a lone
character does to itself. It has nothing for joining or leaving a party, and
nothing for entering an instance. A map-id change in the state samples is not an instance record: it
cannot tell a dungeon from a boat ride, and a rung that reads it would be
answering a different question than the one it prints. The SDK does hold a
`state.group`, so the party half is closer than the instance half — but a
record still has to be produced, and a producer that never fires because no run
can ever group is a producer nobody can validate.

**One character per session.** This is the real blocker. A run is one process:
one account, one sandbox, one agent loop, one trajectory. Two characters in a
party are two runs that would have to start together, stay alive together, be
in the same place at the same time, and end together — and nothing in the runner
or the fleet supervisor can express that. The producers, the watchdogs and the
episode budget are all per-process; so is every derivation the viewer does over
a trajectory. A party is the first thing WrathBench would measure that is not a
property of a single run.

## What would have to change

- **Multi-session coordination.** A unit of work above the run: several runs
  launched as one party, sharing a start, a stop and a fate. The fleet
  supervisor allocates one job to one account today; a party is one job with
  several. What happens when one member dies, stalls or hits its budget is the
  question that shapes everything else here.
- **Account allocation.** Five accounts, five characters, on the same realm and
  faction, at compatible levels, in the same place. The account classes we have
  are per-run; a party needs them reserved as a set.
- **Milestone kinds.** A `group` record (joined, left, the party's composition
  as guids or member counts — never names) and an `instance` record (the
  instance the character actually entered, from the server's own say-so rather
  than a map-id guess). Additive kinds, like everything else in the series; the
  ladder's rung 6 test then derives from them the way rung 4 derives from
  capital-zone plus flight.
- **The rest of the party surface.** Most of it exists (module/PROTOCOL.md,
  the raw allowlist and the group, mail, bank and trade events; `sdk/API.md`,
  the group helpers and `state.group()`). Still missing: the
  `SMSG_PARTY_MEMBER_STATS` tap (the party frame's health, power, zone and
  position for the other members), quest sharing (`CMSG_PUSHQUESTTOPARTY`),
  and 3.3.5's Dungeon Finder
  (`CMSG_LFG_JOIN`), which teleports a formed party into the instance and is
  therefore a client-legal way to attempt Deadmines before cross-continent
  travel and instance portals are reliable. Issue #9 tracks these alongside
  the multi-session runner, the group and instance records above, and the
  scoring questions below.

## The questions this proposal does not answer

They are methodology, and they are the operator's (docs/METHODOLOGY.md):

- Whose result is a cleared dungeon? Five runs of one model is a model's
  result; five runs of five models is not obviously anybody's, and the ladder's
  ordering (highest rung, then XP, then gold) is defined over single runs.
- Does a party run stay in the freeplay track, or does it want an episode of
  its own? Freeplay already allows agents to interact; a scored party episode
  would need a comparability tuple that says who else was in the world.
- Is rung 6 reached by a party of one model, or by any party at all?

Until those are answered, rung 6 stays not instrumented and the ladder says so
plainly, which is the honest reading.
