# ADR-0027: Navigation is the module's: typed causes, client-parity triggers and transports

Status: Proposed — accepted once `infra/smoke/travel.ts` passes end to end on a
deployed build (FOLLOW-UPS 38 N1 gate). Date: 2026-08-22. The code shipped ahead
of that run; the run turns this from a design into a record.

## Context
The travel probe made long-range travel the obstacle between the starter zone
and a capital. `no_path` was one name for four failures plus one the module
inflicted on itself (a 3D endpoint check rejecting paths the mesh resolved fine
because the request's z was stale); the recovery — a z-ladder, then a midpoint —
was pathing detail a model had to reinvent unprompted, and one spent eight turns
on it. Areatrigger teleports (tram portals, instance entrances) fire on a packet
a client sends by itself when its position enters a volume, so no bench
character could leave a continent by foot. Transports carry only passengers
whose movement declares an on-transport offset — a thing a client's physics
produces, never a player decision. Behind all three: which layer owns navigation
detail? ADR-0015 says the SDK never teaches strategy; CONTRACTS.md says the
module may do locally what a client does locally.

## Decision
1. **The module names the cause; the agent never retries pathing detail.** Move
   results are a typed vocabulary (`no_mesh`, `target_off_mesh`,
   `start_off_mesh`, `path_incomplete`, `transferred`, …); `no_path` no longer
   exists. The module checks mesh tiles before pathing, compares endpoints in 2D
   and reports the mesh's z, and retries a partial path once by subdividing. The
   SDK carries a per-status hint (ADR-0016) and nothing else.
2. **Areatriggers are client behaviour, so the module does them**, reading the
   client's own `AreaTrigger.dbc` from the data volume (never git) and sending
   `CMSG_AREATRIGGER` once per entry, audited and mirrored as an event. Portals,
   exploration credit and inns happen to the character as they happen to a
   client, without an agent action.
3. **Transports are client behaviour, so the module does them.** Inside a
   transport's model bounds the synthesized packets carry the transport block a
   client's would; boarding is walking onto the car. There is no "activate
   transport" action because a client never sends one.
4. **Map changes are server postconditions.** The transfer packets are
   whitelisted, the map id follows `SMSG_NEW_WORLD`, and `waitForTransfer`
   answers with a typed verdict — returned, never thrown (ADR-0011), never a sleep.

Rejected: a retry option on `moveTo` (pushes recovery back onto the model under
another name; the middle tier ADR-0015 forbids); `enter_portal`/`activate_transport`
actions (server-side shortcuts); keeping `no_path` plus a `cause` field (the
status is what a snippet branches on, and ADR-0011's point is that the branch is
obvious).

## Consequences
- Status vocabulary and hint text changed: a harness boundary; runs before and
  after are not comparable on navigation.
- Quest-credit and tavern triggers now fire for bench characters wherever a move
  crosses one, so a quest log can change without the agent doing anything.
- A request above a cliff now resolves to the cliff-bottom mesh point and walks
  there, reporting the mesh z, where the old module said `no_path`.
- Two risks the gate run must retire: the module tests its interpolated
  position while the server checks its applied one, and triggers are only
  checked while a move is active — a character carried into a volume while idle
  does not fire it.

## Amendment 2026-08-23: same-map teleports and the z-ladder (FOLLOW-UPS 46)

Three repairs in the same spirit, built as `harness-0.3-137` and live since
2026-08-23 as `harness-0.4-3-g8f6939d` (`infra/smoke/module-navigation.ts` PASS
on SMOKE3, gate PASS):

- `teleported` joins the vocabulary as its own status rather than a `sameMap`
  flag on `transferred`. Decision 1 says the status is what a snippet branches
  on; a flag that flips the meaning of `transferred` ("a map change is coming —
  except when this field says it is not") is the `no_path`-plus-`cause` shape
  this ADR rejected, and the recovery differs: `transferred` waits for
  `SMSG_NEW_WORLD`, `teleported` reads the arrival off the server's own
  `MSG_MOVE_TELEPORT_ACK`, which is now tapped (client parity: the client is
  told where it landed). Vocabulary change, so runs before and after are not
  comparable on navigation — the same boundary the original decision drew.
- The z-ladder sits in front of the cause ladder. `move_to` accepts the guid of
  the unit a point was read from, as a hint only, and resolves z to the ground
  height at x,y (terrain and model geometry a client has) before pathing;
  without a guid the ground z is a fallback after `target_off_mesh`. The cause
  vocabulary is unchanged: a target the mesh rejects at both heights still says
  `target_off_mesh`, and `meshZ` stays relative to the z asked for.
- A superseded move and a planning failure send the `MSG_MOVE_STOP` a
  redirected client would, so the server's last movement word is never a
  stale `MOVEMENTFLAG_FORWARD` heartbeat. The SDK's `MOVE_LEAVES_NO_STOP`
  repair stays as belt to this brace.

## Amendment 2026-08-23: a ghost knows where its corpse is (FOLLOW-UPS 53)

A released ghost in a fleet run called `reclaimCorpse` from 387y away and was
told `still_ghost` ten times, with no healer in the 100y view and nothing that
said which way its corpse lay. The same client-parity test as the teleport ack
settles it: a real client sends `MSG_CORPSE_QUERY` the moment it is a ghost
and draws the answer as the corpse marker on its map, so the module sends that
one query per death on the parked client's behalf (after the graveyard port
has been acked) and serves the reply as an event; the opcode joins the raw
allowlist so a snippet can re-ask. The SDK folds it into
`state.self.corpse` (falling back to the position at the death transition
until the answer lands) and `state.self.graveyard` from
`SMSG_DEATH_RELEASE_LOC`, and `reclaimCorpse`'s `not_reclaimed` names exactly
one reason — `too_far` with the distance and the 39y radius, `delay_not_elapsed`
with the seconds left, `wrong_map`, `no_corpse`, else `still_ghost` — with the
hint for that reason, including the Spirit Healer's price when the corpse is
far. Rejected: a server-side resurrect (not a client action), widening the view
radius (the healer-list emptiness was the view limit, and saying so is the
honest fix), and a `walkToCorpse` helper (ADR-0015: `moveTo(state.self.corpse)`
is one line and the need is now visible). Observation widened by one packet a
client already receives, so the status vocabulary of `reclaimCorpse` changes
under the same navigation-comparability boundary as the rest of this ADR.

## Amendment 2026-08-23: a mesh path that falls is a ledge, not a route

nav-probe c4 on map 369 (session `956b315b…`, moveIds 186 and 277):
`ResolvePathAt` accepted a mesh endpoint 7.64y below the requested z,
`TickMover` interpolated one segment with dz -7.64 over 1.0y of 2D travel,
the 2D-only arrival check said `arrived`, and the next move from the landing
was `start_off_mesh`. The `meshZ` hint then told the agent the ground there
was at z -6.9 and to quote it next time — the mesh's choice of a drop was
being reported as the agent's stale z.

- `drop` joins the vocabulary. A resolved polyline (main path or the leg2
  splice) with any segment whose |dz| > 2.0y **and** |dz| > 1.2 x its 2D
  length is a cliff, not a ramp: the walk is not dispatched, and the result
  carries `reachedPos` (the last point before the step), `dz` (signed) and
  `target` (the request). `TickMover` runs the same test per segment as a
  defensive twin, stopping at the edge with the same status. The core's
  `SetSlopeCheck` is not used: that steers pathing; this judges the route the
  mesh already chose. `meshZ` stays for small-dz stale-z corrections.
- Every `move_to` that reaches the mesh audits `op: "move_path"` with the
  polyline (cap 64) at dispatch, so the next diagnosis reads the route rather
  than rebuilding it from heartbeats.
- SDK: `drop` hint names the ledge height and edge and says to pick a point
  on this level or find the ramp/stairs. The `meshZ` hint only claims "the
  mesh owns z, quote it" when |dz| <= 3y; beyond that it says the character
  ended N yards below/above the requested point and that the request's z was
  not what put it there.

Vocabulary change, so the navigation-comparability boundary of this ADR moves
again. Thresholds are the ones written here; a ramp steeper than 50 degrees
over more than 2y would trip the guard and show up as a `drop` with the
polyline in the audit, which is the evidence to retune on.

## Amendment 2026-08-23: an areatrigger fires on crossing, not on lingering (FOLLOW-UPS 56)

nav-probe c4 showed `areatrigger 710` in the audit every ~1.5s for 13s while
the character walked around the Kharanos crossroads: `CheckAreaTriggers`
re-armed on a 1.5s timer meant to cover heartbeat lag. A client sends
`CMSG_AREATRIGGER` once, when it crosses into the volume.

- Per session the module keeps the set of DBC volumes the mover is inside.
  `CMSG_AREATRIGGER`, the `areatrigger` audit line and `WB_AREATRIGGER` go out
  only for an id that is newly inside. An id leaves the set when the mover
  leaves its volume, changes map, or is teleported (the ack path clears it),
  so re-entry fires again. The 1.5s re-send is gone: a hit the server
  rejected because its applied position lagged the interpolated one is the
  same miss a client suffers, and a trigger the server does not act on
  (exploration already credited, or no world-DB row at all) fires exactly
  once per entry.
- Travel gate leg1b lingers inside trigger 710 for >= 5s and asserts exactly
  one `WB_AREATRIGGER` for that id; the interpolated-vs-applied residual
  stays as it is.
