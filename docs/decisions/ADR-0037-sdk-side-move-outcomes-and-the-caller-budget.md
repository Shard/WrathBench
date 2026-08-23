# ADR-0037: The SDK may answer before the wire, and a budget explains rather than caps

Status: Accepted. Date: 2026-08-23. Records two decisions the 2026-08-23
`moveTo` change (da93f0a) made in passing (FOLLOW-UPS 51).

## Context
ADR-0027 gave navigation a module-owned status vocabulary: the module names the
cause, the SDK carries a hint and nothing else. `moveTo` then learned to accept
a unit or a guid instead of a point, because four of seven runs in the
2026-08-23 fan-out threw a raw `TypeError` reading `.x` off a lookup that
returned nothing. That created a case ADR-0027 has no word for: the caller named
a unit the state cache cannot see, so there is no point to walk to and no
`move_to` is dispatched at all. The same change gave the client a
`ConnectOptions.deadline` — the moment the sandbox will abandon the running
snippet — which is the runner reaching across the SDK boundary with a fact about
its own scheduler.

## Decision
1. **Outcomes the server decided are the module's vocabulary; "nothing was
   dispatched" is the SDK's.** `unknown_target` is a `moveTo` status that no
   `WB_MOVE_RESULT` ever carries. It is deliberately absent from
   `MOVE_STATUSES` / `KnownMoveStatus` in `sdk/src/protocol.ts`, and the failure
   arm of the result union is written `Exclude<KnownMoveStatus, …> | (string &
   {})` so a module status and an SDK refusal cannot be confused by the type
   either. The `unknown_target` arm pins `moveId`, `position`, `seq`, `ts` and
   `reachedPos` to `undefined`: a snippet reading the result can tell that
   nothing happened, not merely that something failed. Precedent:
   `killTarget` answers `lost` for a target that stopped existing, also without
   a wire status. The rule this generalises to — an SDK-side status is legal
   when it describes the SDK declining to act, never when it renames or infers
   an outcome the server produced.
2. **`ConnectOptions.deadline` explains; it never caps.** The runner passes the
   instant the sandbox will abandon the snippet. No wait shortens, no call is
   refused, no timeout is clamped because of it. Its only use is a `moveTo`
   hint saying the walk was always longer than the caller had left (ADR-0016
   rule 2: explain, do not cap). A budget already past reads as *unknown*, not
   as zero, because a background routine inherits the async context — and so
   the deadline — of the snippet that launched it, and that snippet's clock ran
   out long ago (`remainingBudgetMs`).

## Alternatives
- A thrown error for the unresolvable target. ADR-0011: a target that is not
  there is an ordinary game answer, and throwing would put the branch in a
  `catch` where the other move outcomes are not.
- Asking the module to invent an `unknown_target` status so all statuses come
  from one place. The module never saw the request; a status it did not decide
  would be a fabricated outcome (the reasoning that rejected `nothing_offered`,
  FOLLOW-UPS 26).
- Letting `deadline` cap waits, so a snippet cannot start a walk it has no time
  for. That silently shortens runs and changes what is measured without
  appearing in any tuple field; the model is told instead.

## Consequences
- Adding an SDK-side status is a surface change like any other: it widens the
  result union and belongs in the same harness-version accounting as a module
  status, even though no packet changed.
- Anything reading a move result must branch on `ok`/`status` before touching
  `moveId` or `position`; the union enforces this.
- The obvious future "improvement" — make the deadline cap — is rejected here so
  it is not re-derived as an optimisation.
- `module/PROTOCOL.md` is unchanged by either decision: neither is a wire
  concept. `docs/CONTRACTS.md` was re-read against the shipped move surface at
  the same time and gained the two sentences it was missing (the typed map-change
  outcomes, and the teleport ack as an observable).
