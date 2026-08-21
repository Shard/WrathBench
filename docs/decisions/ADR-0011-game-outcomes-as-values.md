# ADR-0011: Game outcomes are return values, not exceptions

Status: Accepted. Date: 2026-08-21.

## Context
`moveTo` is the first SDK helper that waits for a game verdict. The module answers a `move_to` twice: an HTTP ack that it queued the request, then a `WB_MOVE_RESULT` event whose `status` is one of `arrived`, `no_path`, `too_far`, `interrupted`, `stopped`, `superseded` (PROTOCOL.md, ADR-0010). Only the first of those is success in the ordinary sense, and the SDK has to decide what shape the other five take in TypeScript. Everything the model writes is a snippet run by the harness, so the shape decides what a forgotten `try` costs.

## Decision
The SDK mirrors PROTOCOL.md's own split. Transport and request errors keep throwing (`WrathTransportError`, `WrathRequestError`); anything the *game* decided is a value.

`moveTo` returns a discriminated union — `{ ok: true, status: "arrived", … } | { ok: false, status, … }` — carrying the server-confirmed position for every status, because "where am I now" is what the next decision needs whether or not the move succeeded. `if (!result.ok)` is hard to forget and impossible to get half-right, whereas an exception for `no_path` would put a perfectly ordinary answer ("you cannot walk there") on the same channel as `not_in_world`, and an unhandled one would end a run over a wall.

The one thing that stays a throw is `EventTimeoutError`: no result arrived. That is the *absence* of an outcome, not an outcome — the character may still be walking — and inventing a `status: "timeout"` would put an SDK fabrication in a field that otherwise only ever holds the module's own words.

## Alternatives
- Throw a typed `MoveFailedError` per status: idiomatic for a library, wrong for a snippet runner. Every navigation call would need a `try`, and the failure statuses are expected outcomes of normal play, not exceptional ones.
- Return `undefined` on failure: loses the status and the position, which are the two things a recovery needs.
- Fold the timeout into the union: friendlier to write against, but it makes an SDK-authored value indistinguishable from a module-authored one at the exact point where the trajectory log would disagree.

## Consequences
- Every later game-verdict helper (cast, loot, quest turn-in) follows the same rule, so the surface stays predictable: throws mean "the call was wrong or unanswered", values mean "the world answered".
- `MoveResult.status` is a widened string union, so a status added to the module parses instead of breaking, and lands on the `ok: false` branch by default.
