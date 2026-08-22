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

## Addendum (2026-08-22): createSession reclaims a permitted account

A confirmed harness trap surfaced on a shared-account lane (account `RUNNER`
cycled model→model): a prior episode leaked a bench session under its old
token, and the next episode's `createSession` was boxed in with three
contradictory signals and no exit — `createSession` → `account_in_use` ("you
already have a live session… do not call createSession again"), `deleteSession`
(new token) → `no_session`, state cache → no session. One weak model called
`createSession` 94 times against this; a capable agent is equally trapped. This
is the failure ADR-0016 exists to prevent, on the create surface.

The fix applies both rules of this ADR to `POST /session`. **Repair only what is
deterministic:** the one-account-one-lane-one-episode invariant (enforced by the
fleet's duplicate-account guard and the roster's account-busy guard) makes "a
session is holding this permitted account at create time" mean exactly one thing
— it is stale/leaked, never a legitimate concurrent run — so taking ownership is
the single valid reading, not a guess. A normal create therefore reclaims: it
tears the stale session down through the existing teardown path and enters world
once the core has released the account. A same-token create that is already in
world for the same character+account returns success idempotently (the caller
re-syncs from the event stream); a same-token session in world for a *different*
character is torn down and rebuilt rather than answered with a wrong-character
success — the silent-wrong-behavior line this ADR draws. **Every rejection stays
actionable:** `account_in_use`, whose SDK-rendered hint was the dead-end itself,
no longer fires on `POST /session`. The only residual failure is the rare case
where the core does not release the account within the internal reclaim wait,
reported as the existing `timeout` code (retryable, and the teardown is already
in flight, so a retry converges).

Consequence, per this ADR's own terms: this changes a documented error contract
(`account_in_use` was a create-path answer), so it is a harness change, versioned
and not score-comparable across the boundary. `account_in_use` remains on the
non-reclaiming surfaces (`POST /characters`, `POST /character-delete`);
character-delete deliberately still refuses with `account_owned_by_other_token`
rather than evicting a running episode.
