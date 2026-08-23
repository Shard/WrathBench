# ADR-0016: API surface softening

Status: Accepted. Date: 2026-08-22.

## Context
An audit of one night (2,680 tool results, 229 errors, 21 episodes) showed most
model-facing failures were feedback failures, not capability failures: a syntax
error rendered as "Parse error", module rejections as bare codes with no
argument name or next step, a timeout that never named the fix, and two paths
where wrong input produced no error at all (a `number` guid losing precision,
unparseable values coerced to 0). Weak models burned large fractions of their
episodes blind-retrying. The tension: WrathBench is an eval, and feedback that
does a model's thinking, or repairs that guess at intent, would blur what it
measures; per-model accommodation is banned (ADR-0004).

## Decision
The harness may repair or explain, under two rules.

1. **Repair only what is deterministic.** An input is repaired only when exactly
   one valid reading exists (a fence around JSON, a trailing comma, a string
   where a lone number is required, an alias key when the canonical one is
   absent). With two plausible readings the harness rejects and explains; it
   never picks. Repairs are uniform across models and runs — softening lives in
   the harness version, never in run config.
2. **Every rejection is actionable**: what was received, what was expected, the
   next step, in one or two factual sentences. Silent wrong behavior is the one
   forbidden outcome: an input the harness cannot honor produces an error, never
   a coerced action or a stripped key.

Softening does not change game semantics, add gameplay helpers (ADR-0015),
summarize with a model, or teach strategy. A hint says "use String(guid)"; it
never says "you should be fighting boars". Changes to the sandbox's JS
environment are outside this record (ADR-0017 made that call for BigInt).

## Consequences
- Error-message text is load-bearing surface: changing it is a harness change,
  and scores before and after do not compare.
- The distinction between "typo repaired" and "typo rejected" disappears from
  trajectories for the repaired class; if error-class metrics ever matter,
  repairs must be logged as such.
- Applied since to session create (a stale session on a permitted account has
  exactly one meaning — leaked — so create reclaims it; module/PROTOCOL.md),
  to navigation statuses (ADR-0027) and to every per-status hint the SDK carries.
