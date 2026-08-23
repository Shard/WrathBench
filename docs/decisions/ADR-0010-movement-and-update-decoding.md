# ADR-0010: Synthesized client movement and update-object decoding

Status: Accepted. Date: 2026-08-21.

## Context
The agent must be able to go somewhere and see the world. The action contract
forbids server internals (`MotionMaster`, teleport); the observation contract
limits fields to what a client receives; CONTRACTS.md grants one exception — the
module may route "move to position" against the server's mmaps, because a
client's human routes with eyes and the module has none.

## Decision
**Movement is a per-session mover that impersonates the client's movement
engine.** The path is resolved once inside the module and never leaves it; the
mover then sends what a 3.3.5a client sends on the wire — start, heartbeats,
stop, each with interpolated `MovementInfo` — through `QueuePacket` into the
stock movement handlers, so every server-side check applies. Two choices make
it honest rather than merely plausible:

- **Truth is the server's.** Arrival is declared when the server-side character
  reaches the destination, not when the mover finishes its polyline; drift
  between the server position and the interpolation ends the move as
  `interrupted` at the server's position. The result event's position is always
  read from the live character, so it doubles as proof the synthesis was accepted.
- **The module answers time-sync itself**, so the session's clock delta settles
  near zero and synthesized timestamps are accepted.

Rejected: `MotionMaster::MovePoint` is trivially correct and exactly what the
action contract forbids, for the most common action in the benchmark.
Declaring arrival from mover state is cheaper and silently wrong the first time
the server rejects a packet.

**Observation decodes the wire's own delta shape.** `SMSG_UPDATE_OBJECT` is
already full-object-on-create plus sparse deltas; the decoder preserves that
instead of keeping a server-side world model, emitting whitelisted fields only
and consuming the rest. The one per-session state it keeps is a guid→type map —
the object cache a client keeps — which also drives client-style name queries on
cache miss. A module-side world model serving polished snapshots would duplicate
game semantics in C++ (ADR-0005); the SDK owns the world model, the module owns
packet shapes.

## Consequences
- Movement fidelity is bounded by heartbeat cadence; the single-move cap pushes
  long-range routing to the SDK deliberately, since routing is game knowledge.
- Move progress/result events are module-synthesized (opcode ids outside the real
  range): a client knows its own position locally, and these are that knowledge.
- The update decoder is the hot path and allocates nothing per dropped packet.
- Guids crossing JSON are decimal strings (creature guids exceed 2^53);
  ADR-0017 later extended this to the whole model surface.
- Status vocabulary and the mover's trigger/transport duties were extended by
  ADR-0027. Constants and shapes: module/PROTOCOL.md.
