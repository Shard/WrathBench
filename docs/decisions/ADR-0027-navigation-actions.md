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

Three repairs in the same spirit, shipped in module build `harness-0.3-137`
pending the harness-0.4 deploy:

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
