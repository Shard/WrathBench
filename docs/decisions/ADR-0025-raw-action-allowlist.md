# ADR-0025: The raw-action escape hatch is an allowlist of ordinary client opcodes

Status: Accepted. Date: 2026-08-22.

## Context
ADR-0015 promises a raw tier below the helpers so that an agent can compose
what the SDK does not package, and so that a trajectory can *show* the need
for a surface before the module and SDK grow one. Until now that tier was the
fixed set of single-opcode actions; anything else (whisper, bank, mail, flight
paths, talents) was simply unreachable, and `WrathClient.action()` was private.
A fully open passthrough is not acceptable either: the action contract
(docs/CONTRACTS.md) is "what a real client would send", and the module is the
thing that has to make that true.

## Decision
`POST /action` gains `raw`: an opcode *name* plus a hex body, queued verbatim
into the stock handler. Membership is a static allowlist in the module, and
the rule for an entry is: a stock 3.3.5a client sends it during ordinary play,
its handler does nothing a non-GM client could not do, and no dedicated action
already covers it. Excluded on purpose: movement (the module drives it; a
stray packet desyncs the mover), session lifecycle, every opcode that already
has an action (one audited path per opcode), and anything GM-gated or
teleport-shaped. The module validates name, hex shape and a 512-byte cap; it
never parses or repairs the body. The SDK's `raw(opcode, payload)` validates
at its boundary with Zod and packs a typed field list little-endian so the
model does not hand-roll byte order.

Replies to raw actions reach the agent only through the existing event
whitelist. That asymmetry is intended: "I sent it and saw nothing" is the
evidence that earns a tap or a helper.

## Alternatives
- Any `CMSG_*` by number: violates the contract's spirit (GM and movement
  opcodes), and loses the per-opcode audit story.
- No hatch, only new actions on demand: every new surface then needs a module
  rebuild before the need can even be demonstrated — the loop ADR-0015 set out
  to break.

## Consequences
- Widening the allowlist is additive and needs no ADR; narrowing it is a
  harness change. Each addition must pass the three-part rule above.
- Payload bugs are the caller's: the module treats a bad body exactly as the
  core treats a malformed client packet.
- When a raw opcode shows up repeatedly in trajectories, that is the signal to
  give it an action and a decoded reply — and to remove it from the allowlist.
