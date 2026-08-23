# ADR-0033: Run dimensions and the comparability tuple

Status: Accepted. Date: 2026-08-23. Consolidates ADR-0024, ADR-0026, ADR-0028 and
ADR-0030 (all superseded by this record); the promotion rule lives in ADR-0034.

## Context
ADR-0004 makes scores comparable within a harness version, and ADR-0018 makes the
goal prompt deliberately broad. Both assume the harness version is the only thing
that varies between runs. It is not: runs need an effort level, an operator-steered
objective (the travel probes), a looser leash for runs that earn no XP for hours,
wiki coordinates in some lanes and not others, and episodes of different length.
Every one of those is per-model tuning the moment it varies per model, and a
silent re-scoping of every existing score the moment it is changed globally. A
`git describe` string distinguishes none of them, and nothing recorded what two
rows on a chart had actually been given.

## Decision
**A knob that would be tuning if it varied per model is legitimate as a run
dimension: set per run, recorded in run metadata, identical in shape for every
model.** `opus at low` and `opus at high` are two comparable rows, not one tuned
model. The dimensions:

- `effort` — the precedent, set in code before any ADR.
- `objective` — optional operator text rendered into the fixed prompt at one fixed
  place, in a delimited block that says it is *in addition to* the standing goal.
  With no objective the prompt is byte-identical to the shipped one, by
  construction. The prompt is a function of the objective alone — never of the
  model, driver or effort — and both drivers render it through one function.
  **A run with an objective is unscored**, stamped through the same `shakeout`
  machinery the external-scaffold drivers use, so a steered row cannot drift into
  a chart by being forgotten. An objective is operator-authored world knowledge,
  not a contract breach: CONTRACTS.md governs what the *server* serves.
- Watchdog overrides — per entry or lane; `null` disables one (not evaluated, not
  threshold zero). Recorded like any config value; a result run uses the id's leash.
- `wikiCoords` — default false. Exact yards from the wiki are an answer key for
  the ladder's "find things" rungs: with them every model converges on
  search-read-`moveTo`; without them a model must do what a player does (read
  "in the inn at Goldshire", walk there, look). Harder is the point. When false,
  `search_reference` sets no `coords` field and redacts coordinate-shaped pairs in
  prose, best-effort; its description states which side the run is on so a
  names-first model does not hunt for numbers that are not there. True only in
  `freeplay`. If the names-only ladder proves unclimbable by every model, the
  pull-back is a labeled coords tier — a second row, never a silent change.
- `episode` — a named ruleset (`e90`, `e360`, `freeplay`, defined in
  docs/EPISODES.md). **Each id is a comparability group**: scores never mix across
  ids, nor across harness versions within one. The id determines the leash; a run
  whose recorded watchdogs, wall clock or tool-call ceiling differ from its id's
  definition is not a member of the group. `e360` exists because travel rungs need
  hours of zero XP, and raising `e90`'s clock would re-scope every existing score;
  if 90 minutes is the wrong default, the replacement is a new id. `e360` and
  `freeplay` can both run six hours — steering, not duration, separates them.

**One tuple, computed in one place, stamped at launch, never recomputed.**
`runner/src/comparability.ts` names it: harness version, prompt hash and length,
context engine, effort, episode budget, episode id and override flag, objective
presence, `wikiCoords`. Rules that follow from "stamped, never recomputed":

- The prompt hash is of the *rendered* prompt — the bytes the model saw. Every
  scored run shares one hash; a steered run visibly does not.
- A run written before a field existed reads `null` for it and is never
  back-labeled. Recomputing against today's prompt or today's tier definition
  would assert a comparability that was never established; saying nothing is
  more honest.
- A resume re-stamps for the leash that will actually be enforced, recorded as
  a `comparability_restamped` harness record; the harness version moves with it.
  A resumed run's recorded turn index continues from the run's high-water mark,
  or turns-to-level would flatter exactly the runs that had the most trouble.
- Turns and tool calls stay separate fields; the fixed loop ignores one bound
  and the claude driver has no real version of the other, and averaging would
  hide which binds. A disabled watchdog stays `null` in the tuple.

## Alternatives
- Objective as a first user message or a second prompt file: the text a model
  saw would depend on the driver, or there would be two harness prompts whose
  first divergence is untraceable.
- A separate `scored: false` flag: a second vocabulary for a thing the run row
  already says one way.
- Widening `e90` instead of adding `e360`; an elastic episode that stops when
  progress stops (the stop condition becomes the measurement).

## Consequences
- Comparability is falsifiable: a chart can be asked which tuple its rows share,
  and `unscoredReason` excludes the claude driver outright (its turns and the
  fixed loop's are different units).
- The tuple shape is declared twice — zod in the runner, structurally in the
  import-free viewer types (ADR-0022) — and a type-level test fails if they drift.
- Changing a tier's definition, the prompt, or a dimension's default is a harness
  boundary. Adopting `e90` meant moving watchdog defaults to 20m/20m; the first
  stamped run is the first `e90` member.
- Long-running lanes materialize their roster at spawn, so a changed dimension
  reaches only new episodes.
