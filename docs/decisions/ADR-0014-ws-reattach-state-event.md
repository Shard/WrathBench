# ADR-0014: Synthetic session-state event on WebSocket reattach

Status: Accepted. Date: 2026-08-21.

## Context
Events are fanned out live with no replay (module/PROTOCOL.md). A runner that
reconnects its `/events` WebSocket to a still-alive in-world session never sees
`SMSG_LOGIN_VERIFY_WORLD` again — it fired once, long ago — so the SDK's state
cache stays blind to its own position, map, and level for the rest of the run
(observed on gate2). Adding replay/buffering would be a much larger design
change than the gap warrants.

## Decision
On WS subscribe to a token whose session is already in world, the module emits
one synthetic `WB_SESSION_STATE` event (0xFF03) carrying only client-visible
facts: character name, own guid, inWorld, map, x/y/z/o, level — exactly what
`SMSG_LOGIN_VERIFY_WORLD` plus the session's own identity (already handed over
in the `/session` response) would carry. Nothing the observation contract does
not already serve is added; this is the same "client-local knowledge" argument
as the mover's `WB_MOVE_*` events (ADR-0010).

Two details needed judgment:
- Thread-safety: the subscribe callback runs on an io thread, and Player state
  must never be read there. The emission is pushed as a world-thread task and
  delivered asynchronously as (effectively) the first frame, re-validating the
  session before touching the player.
- Seq/fan-out: the event takes the next per-session `seq` and goes to every
  subscriber of the token, like any event. Sending it only to the new socket
  would put a hole in `seq` for subscribers that stayed connected, breaking the
  gapless-within-session guarantee; already-connected consumers can simply
  ignore a redundant state event.

## Alternatives
- Event replay buffer with `?sinceSeq=`: solves a broader problem nobody has
  yet, adds retention policy and memory questions; rejected for now.
- SDK-side re-query via a new HTTP endpoint: puts self state on the request
  channel, where every other observation arrives on the event stream; the
  split in PROTOCOL.md is deliberate.

## Consequences
- Reconnecting runners regain self position/map/level within one world tick.
- A consumer subscribing twice sees the state event twice (once per attach);
  documented, harmless.
- The audit log records each emission like any event, so reattaches are
  visible in the trajectory ground truth.
