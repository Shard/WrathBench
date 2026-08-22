# ADR-0026: The comparability tuple is stamped, never recomputed

Date: 2026-08-22. Status: accepted.

## Context

ADR-0004 says scores are comparable within a harness version. That was true
when the harness version was the only thing that varied. It is not any more:
`effort` is a run dimension (recorded in `config.ts`'s doc comment before it was
ever an ADR), `objective` and per-run watchdog overrides became dimensions in
ADR-0024, `maxToolCallsPerEpisode` became a lane concern in the same decision,
and the claude-subscription driver runs a context engine that is not ADR-0012's
at all. A `git describe` string does not distinguish any of those.

The release point is the eval charts, and its integrity claim is that two rows
beside each other were given the same thing. Nothing recorded that.

## Decision

**One tuple, computed in one place, stamped into run metadata at launch.**
`runner/src/comparability.ts` names it: harness version, prompt hash, prompt
length, context engine, effort, episode budget, and whether an operator
objective steered the run. `writeMeta` stores it in meta.json; the viewer serves
it on the run row; the run page renders it.

**The prompt hash is of the rendered prompt.** Not of the fixed constant. For a
run with no objective the two are equal by construction — ADR-0024 point 2
guarantees both drivers render through `buildSystemPrompt` — so every scored run
shares one hash, and a steered run visibly does not. It is the bytes the model
actually saw, which is the only thing worth hashing.

**Absent means "not recorded", and nothing recomputes it.** A run written before
this stamp gets `null`. Recomputing a prompt hash for it against today's prompt
would be worse than saying nothing: it would assert a comparability that was
never established. Same rule for a stored tuple this build cannot validate.

**A resume re-stamps.** `--resume` may tighten the leash, and a budget recorded
at launch would then describe a run that no longer exists. The tuple is
recomputed for what will actually be enforced, written, and the change recorded
as a `comparability_restamped` harness record so the earlier portion stays
readable in the trajectory.

**Turns and tool calls are recorded separately, never collapsed.** The fixed
loop ignores the tool-call ceiling; the claude driver has no real turn bound.
Averaging them into one "budget" number would hide which one binds.

**Both budget slots keep their disabled state.** `null` is "this watchdog is not
evaluated", which is not zero, and the tuple carries the null through.

## Consequences

- The eval surface gains one predicate for what may share a chart
  (`unscoredReason` in `runner/viewer/eval.ts`), and it excludes the claude
  driver whether or not the shakeout stamp is present: one of its turns has held
  168 tool calls, so its turns and the fixed loop's are different units and must
  never share an axis.
- State rows gained a `turn` column in the same change, which is what makes
  turns-to-level derivable. Because samples are taken on `stateIntervalMs` and
  not once per turn, every surface says "first observation" rather than implying
  a precision the sampling does not have.
- Nothing is added to the `run` table. `readRun` already reads meta.json for
  exactly these fields, no cross-run `SELECT` needs the tuple without parsing,
  and `writeMeta`'s `ON CONFLICT … DO UPDATE SET harness_version` would not have
  updated a new column anyway.
- The tuple's shape is declared twice: once in `runner/src/comparability.ts`
  with its zod schema, once structurally in `runner/viewer/api-types.ts`, which
  is import-free by construction (ADR-0022) so the dashboard does not bundle zod
  or the prompt text. A type-level assertion in `runner/test/comparability.test.ts`
  fails the build if the two drift.
- Comparability is now falsifiable rather than assumed. A chart can be asked
  which tuple its rows share, and a row whose tuple is unrecorded can be told
  apart from one whose tuple matches.
