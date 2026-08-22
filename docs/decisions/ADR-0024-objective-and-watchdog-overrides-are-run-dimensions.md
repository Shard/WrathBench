# ADR-0024: Objective and watchdog overrides are run dimensions

Date: 2026-08-22. Status: accepted.

## Context

The harness has one prompt for every model (ADR-0004) and a deliberately broad
goal that names no formula to maximize (ADR-0018). That is what makes two runs
comparable. But not every run we want to launch is a comparison. The travel
probe of 2026-08-22 (FOLLOW-UPS 18, sequenced into item 38) told us what a
hand-driven script can reach; it did not tell us whether a model, handed the
same navigation surface and told where to go, can get there on its own. That
question needs a run steered at a named task, over hours, with a character that
earns no XP for most of them.

Two knobs are missing for that and both are easy to get wrong:

- The task itself. Written as prompt text it would be a *per-model prompt* the
  moment anybody tuned it for one lane, which the hard constraints forbid.
- The leash. `no-xp` fires after 45 minutes without XP, which is correct for a
  leveling run and fatal for a travel run: walking to Ironforge earns nothing.
  Reaching for it as a global default change would weaken every other run.

`effort` already set the precedent (ADR-0017/0018 line of work): a knob that
would be tuning if it varied per model is legitimate when it is a *dimension* —
set per run, recorded in metadata, identical in shape for everyone, so `opus at
low` and `opus at high` are two comparable rows rather than one tuned model.

## Decision

**`objective` and `watchdogs` are run dimensions, recorded in run metadata,
never per-model prompts.**

1. `objective` is an optional string in the run config (`--objective`, roster
   entry field, fleet lane default). It is rendered into the fixed prompt at one
   fixed place — between the standing goal and the runtime description — inside
   a delimited `--- Operator objective for this run ---` block that states in
   the prompt itself that it is *in addition to* the standing goal. The standing
   goal is never replaced or edited. With no objective the prompt is
   byte-identical to the one that shipped before, by construction: the prompt is
   the join of two constants and the block goes between them.

2. **The prompt text is a function of the objective alone.** Not of the model,
   the driver, or the effort level. Both drivers render it through the same
   `buildSystemPrompt`, and a test asserts the claude CLI's `--system-prompt`
   value equals the fixed loop's system message for the same objective.

3. **A run with an objective is unscored.** It carries the same `shakeout`
   marker machinery the external-scaffold drivers use — meta.json, the
   `shakeout` column of run.sqlite, the timeline header, the dashboard badge —
   stamped `unscored (operator objective)`. A steered run and a free-play run
   are not comparable, and the record says so without anyone having to remember.
   Both reasons stack, driver stamp first: a subscription objective run reads
   `shakeout-only (external scaffold); unscored (operator objective)`.

4. **Watchdog thresholds are overridable per entry and per lane, and `null` (or
   `0`, the only spelling argv can carry) disables one.** Disabled means the
   watchdog is not evaluated, not that its threshold is zero. Overrides are
   recorded in meta.json exactly like every other config value, so a run's leash
   is readable after the fact — a *result* run still uses the defaults.

## Alternatives considered

- **Objective as a separate first user message.** Rejected: the drivers differ
  in how the first message is assembled (the CLI owns its own conversation), so
  the text a model saw would depend on the driver. The system prompt is the one
  surface both drivers share verbatim.
- **A second prompt file for probe runs.** Rejected: that is two harness
  prompts, and the first divergence between them is untraceable.
- **Loosening the `no-xp` default for everyone.** Rejected: the default is
  correct for the runs it was written for. The probe is the exception and should
  pay for itself in its own config.
- **A separate `scored: false` flag.** Rejected as a second vocabulary for a
  thing the viewer, the run row and the timeline already say one way.

## Consequences

- An objective is operator-authored world knowledge ("the Deeprun Tram runs from
  Stormwind"), which is not an observation-contract breach (docs/CONTRACTS.md):
  the contract governs what the *server* serves the agent, and a human telling
  an agent where it is going is the same class of thing as the standing goal
  telling it to level up. It is a reason such runs cannot score, which point 3
  enforces.
- The tool-call ceiling becomes a lane concern. `maxToolCallsPerEpisode`
  defaults to 500, sized as a runaway guard for a 90-minute episode; a
  multi-hour entry that does not raise it terminates `tool-call-limit`
  mid-probe. Roster entries and lanes can now set it (`maxToolCalls`), and the
  nav-probe lane does.
- Anything reading `shakeout` for equality must move to a prefix/substring test.
  The driver stamp stays first for exactly that reason.
