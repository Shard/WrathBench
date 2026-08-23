# ADR-0017: Guids are opaque decimal strings at the model surface

Status: Accepted. Date: 2026-08-22.

## Context
`JSON.stringify cannot serialize BigInt` was the single most frequent error in
the first measured night (50 of 229). The BigInt was never load-bearing where
models touch it: the wire is already decimal strings, and the one real 64-bit
need — unpacking entry/type from the high bits — is SDK-internal. Models were
handed an exotic numeric type for a value they only store, compare and echo.
Patching the sandbox (`BigInt.prototype.toJSON`) was rejected: it mutates the
environment instead of fixing the API, which ADR-0016 kept out of scope.

## Decision
A guid, everywhere a model can see one, is an opaque decimal string: state
fields, helper returns, event payloads, parameters. The SDK may use bigint
internally, behind one private pair (`parseGuid`/`formatGuid`), and never lets
one escape. A bigint passed at runtime is converted (one guid, one reading: a
deterministic repair under ADR-0016); a `number` is rejected loudly for
precision loss.

Parked: session-scoped short ids (`"u12"`). They would split the model into two
id-spaces (raw events keep real guids), die on reconnect so a stale alias
silently names the wrong unit — the class ADR-0016 forbids — and lose the stable
join key between actions and server truth. If revisited, it enters as a labeled
harness condition, never a quiet default.

## Consequences
- Breaking surface change; shipped inside the harness-0.2 boundary (ADR-0004).
- The BigInt error class ceases to exist rather than getting a better message;
  the one surviving hint covers a model conjuring its own `123n` literal.
- ~20-character guids cost tokens over short aliases. Accepted: representation
  is fair game to optimize, referents are not.
