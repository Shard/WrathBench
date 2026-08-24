# ADR-0041: Probe campaigns are the third lane

Status: Accepted. Date: 2026-08-24. Amends ADR-0033 (`freeplay` is no longer the
only steered episode) and the probe half of ADR-0034 (a probe is no longer a
roster entry carrying an objective). Retires `idle: "characters"` from ADR-0043;
the rest of ADR-0043 — tiers, promotion, account classes, the paid throttle —
stands unchanged.

## Context

WrathBench had two lanes and needed three, and the missing one had been
accumulating as special cases rather than as a concept.

**Evals** (`e90`, `e360`) are repeatable. A minor or major harness bump re-arms
every target, the models run again, and evidence accumulates per series. They
are what the headline charts are made of.

**Freeplay** is the standing sandbox: steered, unscored, lowest priority, never
finished.

The thing in between had no name. An exploratory run — take this model, put it
on a warrior instead of a paladin, point it at the Deeprun Tram, see what
happens — was expressed as a **roster entry carrying an `objective`**, plus a
pinned job pointing at that entry. That worked, and it cost:

- `parseRoster` refusing a `tier` on an entry with an objective, because such an
  entry is outside the policy and a budget on it would be read by nothing
- `rosterModels` dropping tierless entries so the projection would not invent a
  budget for them
- `policyRefs` and `policyExclusion` each carrying an `objective === undefined`
  clause
- the Models page listing such entries as names rather than rows, so a probe's
  runs would not be double-counted against the model it borrowed
- `idle: "characters"`, an entirely separate mechanism that walked eight
  race/class combinations indexed by a model's own extras count — the same
  exploratory question, answered by a different machine, in the scored lane

Five branches and a second mechanism, all of them there to keep exploratory work
out of scored surfaces. None of them was wrong. They were all paying for the
absence of a word.

The forcing case was the operator's: free models were being run over the same
evals repeatedly, and the interesting question — how does this model handle a
rogue, a hunter, a druid — was reachable only by hijacking the idle axis, which
put unscored curiosity into a scored episode and indexed the cells off a counter
that meant something else. A dungeon probe (five agents, basic gear, outside an
instance) had no expressible shape at all.

## Decision

**A probe campaign is an objective swept over a set of cells by a set of
models. It is commissioned, runs to completion, and is then switched off.**

### The discriminator is the relationship to the harness series

Not duration, and not scoring. `e360` and `freeplay` are both often six hours;
`probing` and `freeplay` are both unscored. What separates the three lanes is
what a version bump does to them:

| Lane | On a series bump | Priority |
|---|---|---|
| Evals | targets re-arm, models run again | highest |
| Probe campaigns | **nothing** — a campaign is never re-armed | middle |
| Freeplay | nothing; it never finishes | lowest |

The middle row needs no machinery, which is the strongest argument that it is
the right cut. Re-arming is only ever consequential through a target, and
`probing` is unscored, so its target is zero forever and there is nothing to
un-meet. This is exactly how freeplay already behaved; it was never a freeplay
special case, it was a property of being unscored.

### `probing` is an episode id, and `scored: false` is the whole gate

`probing` joins the `EPISODES` table: objective allowed, no-XP watchdog off,
no tool-call ceiling, and ninety minutes as **a default a campaign inherits
rather than a leash the id enforces** — the inverse of `e90`, where ninety
minutes is a pin. Every scored surface already excluded runs by reading
`EPISODES[id].scored`, so Results, the Ladder and every chart exclude probes on
the day the id lands, through the predicate that was already there.

Two consequences were made structural rather than left to a reviewer:

- **Scored-ness is type-level.** `ScoredEpisodeId` is derived from the table's
  own `scored` literals and is what keys a tier's `runsPerEpisode`. An unscored
  episode therefore *cannot be named* in a tier's run counts. This closed a real
  landmine: `targetFor` asked `ep === "freeplay"`, and widening the union would
  have made the compiler demand a decision whose cheapest satisfying answer —
  add `probing: N` to the tier table — silently wires exploration into
  series-gated evidence and promotion. Deriving it caught two further sites
  making the same assumption by name (`runnableRefs`, `eligibleFrom`).
- **An unscored tier states no budget.** `matchesTier` returns true for one, so
  no probe or freeplay run is ever reported as "overridden". "Overridden" is a
  claim about having fallen out of a scored comparison group, and there is no
  group here to fall out of. This also retired the same latent noise on
  freeplay.

### The roster is a catalog again

```
roster     the model CATALOG: model, driver, apiBase, apiKeyEnv, effort,
           character/race/class, billing, tier, idle
campaigns  objective, model selection, cells, clock, lifecycle
```

A campaign names catalog entries for their **credentials only** and supplies the
task shape itself, so `objective` never enters the catalog. The cut was already
half-made: `jobSpawn` strips `tier`/`idle` before a spec reaches a run, commented
"the fleet's bookkeeping, not a run dimension", and `account` was already refused
on a roster entry.

`nav-probe` — the flagship probe, a roster entry with an objective plus a pinned
queue job — becomes a campaign of one model and one cell. That is what *removes*
the tierless-entry special case rather than adding a third kind of thing.

### Completion is derived; a finished campaign is not archived

Remaining work is `runsPerCell` minus the counted probe runs on disk for that
(campaign, cell, model). Nothing is written back, so editing a campaign cannot
desynchronise it from a bookkeeping file, and deleting one and adding it back
resumes rather than restarts. It also inherits `isCounted` for free: a stillborn
or operator-cut probe re-runs with no special case.

A completed campaign gets `enabled: false` and **keeps its results visible**.
"Archived" deliberately does not mean today's `archiveRun`, which renames a run
directory into `data/runs/archive/` — every viewer surface skips that directory
unconditionally and no `includeArchived` parameter exists in the viewer API, so
archiving hides results everywhere. Directory-moving stays what it is: a janitor
for stillborn and pre-series junk.

The run records `campaign` and `cell` in its own config. That is what the
scheduler counts, so it must survive a restart, and it is what lets a campaign's
results **outlive the deletion of its config entry** — the results surfaces read
the run directory, not the roster. Deliberately not `extra: true`, which means
"past-target idle work" and would file commissioned work with spare-account
filler.

### Scheduling: three states, and priority at the pick

`schedulability` returned `{ ok, extras }`, and both call sites were an if-else
over exactly two outcomes — fine with two lanes, wrong with three. It is now a
verdict about the model's **availability**, not about which lane wants it:
`eval` (owes counted runs), `free` (owes nothing, nothing blocking), `blocked`
(retired, cooling, running, or holding a paused run).

Lane priority stays at the pick. A model is never "a probe model"; it is a model
that happens to owe nothing. And the ordering itself falls out of the episode
table rather than being asserted: `episodeOrder` is `EPISODE_IDS.indexOf`, and
`probing` sits between `e360` and `freeplay`.

An **unpinned** campaign draws from the model's own account class through the
policy. A **pinned** campaign is a pinned job, because a pinned account is by
definition not one the policy may draw from — which is how `nav-probe` keeps its
behaviour exactly, and how a future dungeon campaign asks for specific accounts.

Sweep order spreads across models before finishing any one of them. A sweep that
gets interrupted — by an operator, a harness bump, a dead key — should be holding
breadth when it stops: one cell on every model says more than every cell on one
model.

## Consequences

Ordering applies at pick time, so a long probe holds its rate-limit key for its
whole run. The ninety-minute default is the mitigation and the resulting
serialisation is accepted: minimum spend is the point, and concurrency gets
tuned when there is budget and keys worth using. A twelve-by-eight sweep taking
weeks is the expected shape, not a problem to design around.

The simplification is real but smaller than it first looked, and it is worth
being honest about the ledger. `parseRoster`'s mutual exclusion genuinely dies,
replaced by a flat refusal of `objective` on a catalog entry. But `policyRefs`
and `policyExclusion` each lose *one of two* branches — a pinned job still
excludes a name — and the Models page keeps its `roster.excluded` block, losing
only the "carries an objective" reason. Against that, fan-out generation,
per-campaign lifecycle and budget isolation are new surface with no predecessor
to relocate: new tests, and new failure modes around partial-sweep resume and
cell-versus-run-id naming.

The defer ladder is deliberately **not** split per lane. A probe that fails to
launch climbs the same ladder an eval would, because the ladder backs off from
endpoint failures — stillborn launches, adapter errors — which are properties of
the model's endpoint and equally relevant to both lanes. Splitting it would keep
firing probes at a dead key. Since probes only run for models that owe no
evidence, cooling one costs no eval throughput.

Group and party mechanics are out of scope. The dungeon campaign that motivated
the cell abstraction needs them and will get them separately; what this ADR owes
that future is only that defining a campaign is editing config, not writing
code.
