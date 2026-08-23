# ADR-0021: Client-parity queries live in the SDK, except cache-miss lookups

Status: Accepted. Date: 2026-08-22.

## Context
A real client sends packets nobody clicks for: name, creature and item queries
on first sight; questgiver status for every questgiver in view (the `!`/`?`
marker); a status refresh when the quest log changes; a quest template query on
accept. The observation contract allows all their answers; the question is who
sends them. The module already sent the first group from its update tap
(ADR-0010).

## Decision
**The module sends only the cache-miss lookups a client needs to decode the
stream at all** (name, creature, item — without them the fold has no names).
**Everything else a client sends on its own is sent by the SDK**, as ordinary
actions exposed one-for-one with the client opcode, fire-and-forget, debounced,
bounded once per guid-in-view or quest-in-log. The line: the module sends what
is needed to *read* packets; the SDK sends what is needed to *show* the client's
screen. That keeps the module a packet bridge (game semantics live in
TypeScript), keeps every auto-sent opcode in the action audit under the
session's token, and keeps the policy in the replayable, testable layer.

Rejected: module-side for everything — the refresh trigger is a quest-log
*semantic*, exactly the game knowledge the module must not carry, and the
auto-queries would vanish from the audit. No automatic behaviour at all — the
point is that the model should not have to know to ask; a client never asks.

## Consequences
- The state cache stays a pure fold that never sends; the client holds the small
  "what have I asked" state and clears it on close.
- An older module answers these with `unsupported_action`, which the SDK drops
  silently: an old image leaves fields undefined rather than breaking a run.
  Scores across that deploy boundary do not compare (ADR-0004).
