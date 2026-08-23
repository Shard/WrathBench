# ADR-0025: The raw-action escape hatch is an allowlist of ordinary client opcodes

Status: Accepted. Date: 2026-08-22.

## Context
ADR-0015 promises a raw tier below the helpers so an agent can compose what the
SDK does not package, and so a trajectory can *show* the need for a surface
before the module and SDK grow one. Until now that tier was the fixed set of
single-opcode actions; whisper, bank, mail, flight paths and talents were simply
unreachable. A fully open passthrough is not acceptable either: the action
contract is "what a real client would send", and the module has to make that true.

## Decision
`POST /action` accepts `raw`: an opcode name plus a hex body, queued verbatim
into the stock handler. Membership is a static allowlist in the module, and the
rule for an entry is: a stock client sends it during ordinary play, its handler
does nothing a non-GM client could not do, and no dedicated action already
covers it. Excluded on purpose: movement (a stray packet desyncs the mover),
session lifecycle, anything with an action (one audited path per opcode), and
anything GM-gated or teleport-shaped. The module validates shape and a size cap
and never parses or repairs the body; the SDK packs a typed field list so the
model does not hand-roll byte order.

Replies reach the agent only through the existing event whitelist. That
asymmetry is intended: "I sent it and saw nothing" is the evidence that earns a
tap or a helper.

Rejected: any `CMSG_*` by number (violates the contract's spirit, loses the
per-opcode audit); no hatch (every new surface then needs a module rebuild
before the need can be demonstrated — the loop ADR-0015 set out to break).

## Consequences
- Widening the allowlist is additive and needs no ADR; narrowing it is a harness
  change.
- Payload bugs are the caller's; the core treats a bad body as a malformed
  client packet.
- A raw opcode recurring in trajectories is the signal to give it an action and
  a decoded reply, and to remove it from the allowlist.
