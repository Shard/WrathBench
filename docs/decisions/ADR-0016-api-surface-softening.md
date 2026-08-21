# ADR-0016: API surface softening

Status: Accepted. Date: 2026-08-22.

## Context

An audit of one night's runs (2,680 tool results, 229 errors across 21
episodes) showed most model-facing failures were not capability failures but
feedback failures: a syntax error rendered as the two words "Parse error"
(43 occurrences), module rejections rendered as bare codes with no argument
name or next step (`missing_guid (HTTP 400)`, 38 across codes), a timeout
message that never said the one thing that would fix it (use a background
routine), and two paths where wrong input produced no error at all (a
`number` guid silently losing precision; the module coercing unparseable
values to 0). Weak models burned large fractions of their episodes blind-
retrying against these; one spent 33 of 81 snippets on unlocated parse
errors. Established practice (MCP spec error guidance, Anthropic tool-
writing guidance, the SWE-agent ACI result) says the same thing from the
other direction: agent interfaces should repair what is unambiguous and
explain what is not.

The tension: WrathBench is an eval. Feedback that does a model's thinking
for it, or repairs that guess at intent, would blur the very differences
the benchmark exists to measure — and per-model accommodation is banned
outright (ADR-0004).

## Decision

The harness practices **surface softening**: it may repair or explain, and
it must do both under the same two rules.

1. **Repair only what is deterministic.** An input is repaired only when
   exactly one syntactically valid reading exists — a markdown fence around
   JSON args, a trailing comma, a string where the schema demands a lone
   number, an alias key (`cmd`) when the canonical key (`code`) is absent.
   The moment two readings are plausible (enum near-misses, ambiguous
   unions), the harness rejects and explains; it never picks. Repairs are
   uniform for every model and every run — softening lives in the harness
   version, never in run config.

2. **Every rejection must be actionable.** An error message states what was
   received, what was expected, and the next step, in one or two factual
   sentences — the standard set by the sandbox-death notice and the
   `CHAR_RESPONSE_HINTS` table, both added because bare codes proved
   unactionable in live runs. Silent wrong behavior is the one forbidden
   outcome: an input the harness cannot honor must produce an error, never
   a coerced-to-zero action or a stripped key.

What softening is **not**: it does not change game semantics, add gameplay
helpers (that is ADR-0015's earned-tier decision), summarize with a model,
or teach strategy. A hint says "guids are bigints — use String(guid)";
it never says "you should be fighting boars".

## Consequences

- Error-message text is now load-bearing surface: changes to it are harness
  changes, versioned and comparable like any other (ADR-0004). Scores
  before and after a softening change are not comparable.
- The distinction between "model typo the harness repaired" and "model typo
  the harness rejected" disappears from trajectories for the repaired
  class. If error-class metrics ever matter to scoring, repairs must be
  logged as such (deferred with the error-taxonomy question).
- Decisions that would change what `JSON.stringify` or the language itself
  does inside the sandbox (e.g. `BigInt.prototype.toJSON`) are outside this
  ADR: they alter the environment, not the surface, and need their own
  decision.
