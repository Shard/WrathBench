# ADR-0017: Guids are opaque decimal strings at the model surface

Status: Accepted. Date: 2026-08-22.

## Context

`JSON.stringify cannot serialize BigInt` was the single most frequent error
models saw in the first measured night (50 of 229), and BigInt friction
recurs in every weak-model run. The BigInt was never load-bearing where
models touch it: the wire format is already decimal strings (JSON cannot
carry 64-bit integers), `GuidArg` already accepted strings, and the one
genuine 64-bit need — unpacking entry/type from a guid's high bits — is SDK
internals whose results (`entry`, unit type) are exposed as ordinary fields.
Models were being handed an exotic numeric type for a value they only ever
store, compare, and echo back.

The alternative of patching the sandbox (`BigInt.prototype.toJSON`) was
rejected: it mutates the JS environment instead of fixing the API, and
ADR-0016 deliberately left environment changes out of softening's scope.

## Decision

A guid, everywhere a model can see one, is an **opaque decimal string**.
State fields, helper returns, event payloads, and helper parameters all use
the string form; `===`, Map keys, template literals, and `JSON.stringify`
therefore behave exactly as a model expects. The SDK may use bigint
internally (bit unpacking) but never lets one escape to the model surface,
and helper argument validation rejects `number` guids loudly (precision
loss; see the audit) rather than accepting a third representation.

Considered and parked: **session-scoped short ids** (`"u12"`) as a further
simplification. Rejected for now because aliasing splits the model into two
id-spaces (raw events keep real guids under the observation contract), the
alias map dies on reconnect — a stale alias then silently names the wrong
unit, the exact silent-wrong-behavior class ADR-0016 forbids — and joins
between model actions and server truth lose their stable key. If weak-model
liftoff ever justifies revisiting, it enters as a labeled, evaluated harness
condition (compare runs with and without), never as a quiet default.

## Consequences

- Breaking SDK surface change: ships inside the same harness version bump
  as the death-recovery and softening work (harness-0.2 boundary); scores
  do not compare across it (ADR-0004).
- The BigInt error class ceases to exist rather than getting a better
  message; the ADR-0016 hint for it becomes dead text and is removed with
  the refactor.
- Guid strings are ~20 characters; state summaries pay a modest token cost
  over short aliases. Accepted — representation is fair game to optimize,
  referents are not.
