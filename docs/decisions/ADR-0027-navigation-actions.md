# ADR-0027: Navigation is the module's: typed causes, client-parity triggers and transports

Date: 2026-08-22. Status: proposed — accepted once `infra/smoke/travel.ts`
passes end to end on a deployed build (the FOLLOW-UPS 38 N1 gate). The code
and the status vocabulary below shipped ahead of that run; the run is what
turns this from a design into a record.

## Context

The travel probe of 2026-08-22 (FOLLOW-UPS item 18, WORKLOG) made long-range
travel the obstacle between the starter zone and a capital. Three findings
drove this decision:

- `no_path` was one name for four failures (missing navmesh tile, destination
  off the mesh, character off the mesh, partial path) plus one the module
  inflicted on itself: a 3D endpoint check that rejected paths the mesh had
  resolved fine in x/y because the request's z was stale. The recovery the
  probe needed — a z-ladder, then a midpoint — is a pathing detail a model
  had to reinvent unprompted; qwen spent 8 turns on it.
- Areatrigger teleports (the tram portals, every instance entrance) fire on
  `CMSG_AREATRIGGER`, which a real client sends on its own when its position
  enters a DBC volume. No action could express it, so no bench character
  could ever leave a continent by foot.
- A tram car is a transport. The server carries only passengers that
  declared `MOVEMENTFLAG_ONTRANSPORT` with a transport-relative offset — a
  thing a client's physics produces, never a player decision.

Behind all three was the same question: which layer owns navigation detail?
The model-agnostic loop (CLAUDE.md) and ADR-0015 say the SDK grows only by
observed need and never teaches strategy; docs/CONTRACTS.md says the module
may do locally what a client does locally. Pathing detail is exactly that.

## Decision

1. **The module names the cause; the agent never retries pathing detail.**
   `WB_MOVE_RESULT.status` is `arrived | too_far | no_mesh | target_off_mesh
   | start_off_mesh | path_incomplete | transferred | interrupted | stopped |
   superseded`; `no_path` no longer exists. The module checks navmesh tiles
   before pathing (the core folds a missing tile into a straight-line
   "shortcut" it must never walk), compares the endpoint in 2D and reports
   `meshZ` when the mesh chose a different z, and retries a partial path
   once by subdividing at the partial end, reporting `reachedPos` if that
   also fails. The SDK carries a per-status hint (ADR-0016 rule 2) and
   nothing else: the cause is the module's word.
2. **Areatriggers are client behaviour, so the module does them.** It reads
   the client's own `AreaTrigger.dbc` from the mounted data volume (never
   from git, docs/DATA-AND-LEGAL.md), tests the mover's position with the
   server's own geometry, and sends `CMSG_AREATRIGGER` once per entry. Every
   dispatch is audited and mirrored as `WB_AREATRIGGER`. Consequences —
   portals, exploration credit, inns — happen to the character as they
   happen to a client, without an agent action.
3. **Transports are client behaviour, so the module does them.** When the
   mover's point is inside a transport's model bounds, synthesized packets
   carry the transport block a client's would. Short moves on or off a
   transport are straight lines (there is no mesh on a car); a move that ends
   aboard says `onTransport`; while riding idle the module reports the
   carried position as `WB_RIDE_PROGRESS`. There is no "activate transport"
   action: boarding is walking onto the car.
4. **Map changes are server postconditions.** `SMSG_TRANSFER_PENDING`,
   `SMSG_NEW_WORLD` and `SMSG_TRANSFER_ABORTED` are whitelisted;
   `state.self.position.map` follows `SMSG_NEW_WORLD` (the only map id a
   client gets after login); `moveTo` resolves a `transferred` move only once
   the server has named the new map, and `waitForTransfer` answers with a
   typed verdict (`transferred | aborted | waiting | no_transfer |
   wrong_map`) — returned, never thrown (ADR-0011), never a sleep.

## Alternatives

- A `retryZ`/`subdivide` option on `moveTo`: pushes the recovery back onto
  the model under a different name, and ADR-0015 forbids the middle tier.
- An `activate_transport` or `enter_portal` action: neither is anything a
  client sends; both would be server-side shortcuts (CONTRACTS).
- Serving the transport animation so the SDK computes positions: more
  surface for the same fact the module already has from the server object.
- Keeping `no_path` and adding a `cause` field: the status is what a snippet
  branches on, and ADR-0011's whole point is that the branch is obvious.

## Consequences

- The status vocabulary and the error-hint text changed: a harness-version
  boundary per ADR-0016. Runs before and after are not score-comparable on
  navigation.
- Quest-credit and tavern triggers now fire for bench characters wherever a
  move crosses one — intended parity, and PROTOCOL.md says so, but a quest
  log can change without the agent doing anything.
- A request 40y above a cliff now resolves to the cliff-bottom mesh point
  and walks there, reporting `meshZ`. The old module would have said
  `no_path`. This is consistent with "asks to go somewhere and either
  arrives or gets a failure".
- Model bounds were spiked before commit: `Subwaycar.m2` (displayId 3831) is
  in `GameObjectModels.dtree` with real bounds, and the core loads that list
  unconditionally, so transports have models in this build. A transport
  without one falls back to a 12y radius around its position; if that ever
  matters the gate run will show it.
- Two risks the gate run must retire: the module tests its *interpolated*
  position while the server checks its *applied* one (mitigated by
  dispatching after the heartbeat and re-arming after 1.5s), and the module
  only checks triggers while a `move_to` is active — a character carried
  into a trigger volume by a transport while idle does not fire it.
