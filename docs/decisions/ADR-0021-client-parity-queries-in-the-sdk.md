# ADR-0021: Client-parity queries live in the SDK, except cache-miss lookups

Date: 2026-08-22. Status: accepted.

## Context

A real 3.3.5a client sends a number of packets nobody clicks for: name,
creature and item queries when an object it has never seen arrives,
`CMSG_QUESTGIVER_STATUS_QUERY` for every questgiver that comes into view (to
draw the `!`/`?` marker), `CMSG_QUESTGIVER_STATUS_MULTIPLE_QUERY` whenever its
quest log changes, and `CMSG_QUEST_QUERY` for every quest whose template it does
not hold. The observation contract (docs/CONTRACTS.md) allows all of their
answers; the question is who sends them. The module already sends the first
group from its update-object tap (ADR-0010), and FOLLOW-UPS 27/28 needed the
second group.

Two places were possible. The module could send the status and quest queries
from the same tap that sends creature queries — one mechanism, no SDK state.
Or the SDK could send them from its event fold, over the same `POST /action`
surface a snippet uses.

## Decision

**The module sends only the cache-miss lookups a client needs to decode the
stream at all** (name, creature, item — without them the update-object fold
has no names, and every consumer would need them). **Everything else a client
sends on its own — questgiver status on sight, status refresh on a quest-log
change, quest template on accept — is sent by the SDK**, as ordinary actions
the module exposes one-for-one with the client opcode
(`questgiver_status_query`, `questgiver_status_multiple_query`,
`quest_query`), fire-and-forget, debounced, bounded once per guid-in-view or
per quest-in-log, and with the dedupe that a status already received in the
same burst suppresses the query.

The line is: the module sends what is needed to *read* packets; the SDK sends
what is needed to *show* the client's screen. That keeps the module a packet
bridge (CLAUDE.md: game semantics live in TypeScript), keeps every
automatically-sent opcode visible in the action audit log under the session's
token like any other action, and keeps the policy — when to re-query, what
counts as a quest-log change — in the replayable, unit-testable layer.

## Alternatives

- Module-side for everything, mirroring the creature-query path. Rejected:
  the trigger for the status refresh is a quest-log *semantic* (membership or
  complete bit, not counters), which is exactly the kind of game knowledge the
  module is not supposed to carry, and it would make the auto-queries invisible
  to the action audit.
- No automatic behaviour; expose `questGiverStatusQuery`/`questQuery` and let
  snippets call them. Rejected: the whole point of 27/28 is that the model should
  not have to know to ask — a client never asks. The raw methods stay on the
  client for a caller who wants a refresh now.

## Consequences

- The state cache stays a pure fold (ADR-0013): it never sends anything. The
  SDK client holds the small amount of "what have I asked" state and clears it
  on `close()`.
- The auto-queries cost one `POST /action` per questgiver entering view and one
  per quest-log change (debounced 150 ms), which is the same order as the
  creature queries the module already sends.
- A module built before `a4ed1a3` answers these actions with
  `400 unsupported_action`; the SDK drops that silently, so an old image
  simply leaves `questGiver`/`objectives` undefined rather than breaking a run.
  Scores across the deploy boundary are not comparable (ADR-0004).
