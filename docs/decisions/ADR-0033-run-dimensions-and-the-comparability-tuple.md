# ADR-0033: Run dimensions and the comparability tuple

Status: Accepted. Date: 2026-08-23. Consolidates ADR-0024, ADR-0026, ADR-0028 and
ADR-0030 (all superseded by this record); the promotion rule lives in ADR-0034.
**Amended 2026-08-24 by ADR-0041**: there are two steered episodes now, not one.
Where this record says `freeplay` is the only id that may carry an objective or
serve coordinates, read "the steered ids, `freeplay` and `probing`". The
principle is untouched — steering is what makes a run unscored — only the count.

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
  key the scripted stub uses (the key's name predates ADR-0035; it holds the
  unscored stamp), so a steered row cannot drift into a chart by being forgotten. An objective is operator-authored world knowledge,
  not a contract breach: CONTRACTS.md governs what the *server* serves.
- Watchdog overrides — per entry or lane; `null` disables one (not evaluated, not
  threshold zero). Recorded like any config value; a result run uses the id's leash.
- `wikiCoords` — default false. Exact yards from the wiki are an answer key for
  the ladder's "find things" rungs: with them every model converges on
  search-read-`moveTo`; without them a model must do what a player does (read
  "in the inn at Goldshire", walk there, look). Harder is the point. When false,
  `search_reference` sets no `coords` field and redacts coordinate-shaped pairs in
  prose, best-effort; its description states which side the run is on so a
  names-first model does not hunt for numbers that are not there. True only on a
  steered id (`freeplay`, and `probing` since ADR-0041). If the names-only ladder proves unclimbable by every model, the
  pull-back is a labeled coords tier — a second row, never a silent change.
- `episode` — a named ruleset (`e90`, `e360`, `probing`, `freeplay`, defined in
  docs/EPISODES.md). **Each id is a comparability group**: scores never mix across
  ids, nor across harness versions within one. The id determines the leash; a run
  whose recorded watchdogs, wall clock or tool-call ceiling differ from its id's
  definition is not a member of the group. `e360` exists because travel rungs need
  hours of zero XP, and raising `e90`'s clock would re-scope every existing score;
  if 90 minutes is the wrong default, the replacement is a new id. `e360` and
  `freeplay` can both run six hours — steering, not duration, separates them.

**One tuple, computed in one place, stamped at launch, never recomputed.**
`runner/src/comparability.ts` names it: harness version, prompt hash and length,
harness (`wrathbench` | `claude-code`, ADR-0035; stamped as `contextEngine` before
that record and mapped on read), effort, episode budget, episode id and override
flag, objective presence, `wikiCoords`. Rules that follow from "stamped, never recomputed":

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
  and the claude-code harness has no real version of the other, and averaging
  would hide which binds. A disabled watchdog stays `null` in the tuple.

## Alternatives
- Objective as a first user message or a second prompt file: the text a model
  saw would depend on the driver, or there would be two harness prompts whose
  first divergence is untraceable.
- A separate `scored: false` flag: a second vocabulary for a thing the run row
  already says one way.
- Widening `e90` instead of adding `e360`; an elastic episode that stops when
  progress stops (the stop condition becomes the measurement).

## Consequences
- Comparability is falsifiable: a chart can be asked which tuple its rows share.
  *(Superseded by ADR-0035: `unscoredReason` no longer excludes the claude-code
  harness; its runs are tagged `harness: claude-code` and shown alongside
  `wrathbench` rows. Turns remain different units across the two, which is why
  the harness tag is on every row.)*
- The tuple shape is declared twice — zod in the runner, structurally in the
  import-free viewer types (ADR-0022) — and a type-level test fails if they drift.
- Changing a tier's definition, the prompt, or a dimension's default is a harness
  boundary. `--episode e90` pins the 20m/20m watchdogs; the flagless defaults
  (10m/45m) are unchanged (FOLLOW-UPS 48g). The first stamped run is the first
  `e90` member.
- Long-running lanes materialize their roster at spawn, so a changed dimension
  reaches only new episodes.

## Addendum (2026-08-24): the wiki bundle's identity

A run recorded the reference bundle's *path* and nothing about its contents.
The path is a constant (`data/wiki/bundle.sqlite`); the file behind it is not.
The era-cutoff rebuild — prose taken from pre-4.0.1 revisions, FOLLOW-UPS 49 —
changes what `search_reference` returns for the same query, which is a change
to what the model could read and therefore to what the score means. Before and
after that swap were indistinguishable in run metadata.

**A bundle whose page text changes is a behaviour change, and behaviour changes
are already grouped: by the harness series.** ADR-0034 and docs/EPISODES.md
make `major.minor` of the harness version the comparability floor — a minor
bump restarts the evidence, a fix commit does not. Adding a second grouping key
for the bundle would give one concept two vocabularies and split charts twice
for one event. So the rule is operational, not structural: **a bundle rebuild
that changes page text ships with a harness minor bump**, the same as any other
change to what the run measures. A rebuild of the same dump that changes no
prose (a re-index, a new derived channel) does not.

`comparability.wikiBundle` is then the *annotation* that makes the bump
falsifiable: `{schemaVersion, builtAt, source, eraCutoff}`, read off the
bundle's own `meta` table when the run opens it. It answers "which bundle was
this run actually reading" — the question the series bump asserts an answer to
but does not carry. Two consequences worth stating:

- `sameComparability` is whole-tuple equality, so it is stricter than series
  grouping: any rebuild between a launch and its resume — including a rebuild
  of the same dump, since `built_at` moves — now trips a
  `comparability_restamped` record. That is the honest reading of a resume that
  is reading a different file than the launch did.
- Every field is nullable and the whole record is optional. `era_cutoff` is
  written only by builds that apply one; a bundle without it reads `null` and
  is never back-labelled "no cutoff applied", by the same rule as any other
  field a run predates. A bundle that cannot describe itself — empty `meta`, no
  `meta` — annotates as nulls rather than failing a launch. This is evidence,
  not a gate; the gate is `openWikiBundle`'s schema check, and it stays the
  only place that fails closed.

## Addendum (2026-08-25): the resolved model id

A run recorded the *string it was launched with*. Under the claude-code harness
that string is usually a roster alias — `sonnet`, `opus` — which the CLI
resolves at launch to a real id (`claude-sonnet-5`) and names only inside its
own `init` event. So no page, chart or ladder row could say which Claude a run
had actually been on, and the aliases cannot simply be replaced in the roster:
renaming a ref's model ends its paused runs.

**The resolved id is a dimension of the tuple, and an annotation rather than a
grouping key** — the same standing the wiki bundle has above. It is recorded as
`comparability.resolvedModel`, and on the run itself as `meta.resolved`
(`{model, cliVersion}`) and the `resolved_model` / `resolved_cli_version`
columns of `run.sqlite`. The openai driver fills the same fields from the
`model` on the provider's response, which is the served id an aggregator may
have routed a slug to.

Two properties follow, and they are the whole of the decision:

- **Observed, not stamped.** Every other field of the tuple is a projection of
  the config at launch. This one cannot be: the answer arrives minutes later,
  from the driver. It is therefore filled in **once, on first observation, and
  never revised** — a later segment that resolves elsewhere does not overwrite
  the id the run's score was earned under — and it is **excluded from
  `sameComparability`**. Including it would make every resume of an aliased run
  emit a `comparability_restamped` record that says nothing, in a record whose
  only job is signal.
- **Back-filled at read time, never written back.** Runs that predate this carry
  the answer only in their trajectory, and the viewer derives it there on the
  same pass the listing already pays for (`scanRunTotals`). A stamped value
  always wins over a derived one. Nothing rewrites an old run directory — the
  same rule the episode tier follows: an old run is read differently, not
  relabelled on disk.

The pages show the id where they show the model, and only where it differs from
what was asked for; a roster model that resolved to more than one id across its
runs shows all of them and is flagged, because that drift is the thing this
record exists to make visible.
