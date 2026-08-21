# ADR-0010: Synthesized client movement and update-object decoding

Status: Accepted. Date: 2026-08-21.

## Context
Two module pillars beyond the Stage-2 slice (ADR-0009): the agent must be able to go somewhere (`move_to`, `stop`, `face`) and see itself and the world (`SMSG_UPDATE_OBJECT` and friends). The action contract forbids server internals (`MotionMaster`, teleport); the observation contract limits fields to what a real client receives. `docs/CONTRACTS.md` grants exactly one exception: the module may resolve "move to position" against the server's mmaps, because a real client's human does that routing with eyes and the module has no eyes.

## Decision

### Movement: a per-session mover that impersonates the client's movement engine
`move_to` resolves the destination once with `PathGenerator` on the character's map (world thread, inside the module's `OnUpdate` task drain, so never concurrent with map updates). Only a fully `PATHFIND_NORMAL` path whose actual endpoint lands within 4y of the request is accepted; anything else is a `no_path` event, a straight-line request beyond 250y is `too_far`. The path never leaves the module.

The mover then does what a 3.3.5a client does on the wire: `MSG_MOVE_START_FORWARD`, `MSG_MOVE_HEARTBEAT` every ~500ms, `MSG_MOVE_STOP`, each carrying a `MovementInfo` (flags/flags2/time/xyzo/fallTime) interpolated along the path at the character's live `GetSpeed(MOVE_RUN)`. Packets go through `WorldSession::QueuePacket` into the stock `HandleMovementOpcodes`, so every server-side check (`VerifyMovementInfo`, the flag-sanitizing in `ReadMovementInfo`, anticheat hooks) applies unchanged. The mover ticks from `Manager::Update` on the world thread; HTTP threads only enqueue the request as a task. Nothing outside the world thread touches `Player`.

Two supporting choices:
- **Clock**: the module answers `SMSG_TIME_SYNC_REQ` with a synthesized `CMSG_TIME_SYNC_RESP` whose client timestamp is the server's own `getMSTime()` (received-time stamped, as `WorldSocket` does). The session's clock delta settles near zero, so movement timestamps are accepted without `SynchronizeMovement`'s fallback-log spam.
- **Truth**: arrival is not declared when the mover finishes its polyline; it is declared when the server-side character's position reaches the destination (checked after `MSG_MOVE_STOP`, 3s deadline). Before each heartbeat the mover also compares the server position against its own interpolation; >15y of drift means the server rejected or interrupted the movement (root, teleport, death) and the move ends with `interrupted` at the server's position. `WB_MOVE_RESULT.pos` is always read back from the live character — the event doubles as proof the synthesis was accepted.

`WB_MOVE_PROGRESS`/`WB_MOVE_RESULT` are module-synthesized events (opcodeIds 0xFF01/0xFF02, outside the real opcode range): a real client knows its own position locally while running; these events are that local knowledge, nothing more.

### Observation: decode the wire's own delta shape, don't invent one
`SMSG_UPDATE_OBJECT` is already full-object-on-first-sight (CREATE blocks) plus sparse deltas (VALUES blocks with a bitmask). The decoder preserves that shape instead of maintaining server-side state: one pass over the packet, CREATE blocks emit `objectType`/`pos`/`moveFlags` plus whitelisted named fields, VALUES blocks emit only the changed whitelisted fields. Every non-whitelisted field in the mask is consumed and silently dropped — the client got it, the agent does not.

Because VALUES blocks carry no object type, each session keeps a small guid→TypeID map — a mirror of the object cache a real client keeps — populated by CREATE blocks and pruned by out-of-range lists and `SMSG_DESTROY_OBJECT`. The same cache drives client-style name resolution: first sight of a creature entry or player guid issues the `CMSG_CREATURE_QUERY`/`CMSG_NAME_QUERY` a client fires on cache miss, and the responses are whitelisted events.

`SMSG_COMPRESSED_UPDATE_OBJECT` needs no handling: compression happens in `EncryptableAndCompressiblePacket::CompressIfNeeded` at socket-write time, below the `CanPacketSend` tap, so the tap only ever sees uncompressed updates.

Guids are serialized as decimal strings everywhere: creature guids (high part 0xF130…) exceed 2^53 and would be corrupted by any JSON consumer backed by IEEE doubles.

## Alternatives
- `MotionMaster::MovePoint` / spline movement for the bench character: trivially correct server-side, but it is a server-internal action path, exactly what the action contract forbids, and it would make the "actions are client opcodes" claim false for the most common action in the benchmark.
- Declaring arrival from the mover's own state: cheaper, but silently wrong the first time the server rejects a packet; server-confirmed arrival makes movement self-auditing.
- A module-side world model (server-shaped object store) serving polished JSON snapshots: more convenient for the SDK but duplicates game semantics in C++ against ADR-0005; the SDK owns the world model, the module owns packet shapes.
- Whitelisting `SMSG_MONSTER_MOVE` (creature spline movement) now: deferred. Creature positions refresh on create/heartbeat updates, which is enough for Phase 0; combat will likely need spline decoding (destination only, not the path points, which would leak routes).

## Consequences
- Movement fidelity is bounded by the heartbeat cadence: the server's position trails the mover by up to ~3.5y between heartbeats. Fine for navigation; melee-range positioning in the combat stage may want a shorter final-approach cadence.
- The 250y single-move cap (under `PathGenerator`'s ~296y limit) pushes long-range routing to the SDK — deliberately, since routing is game knowledge.
- The update decoder is the hot path; it allocates one packet copy and one JSON string per whitelisted packet and nothing per dropped packet. Measured on a Northshire login + 37y move: ~11 events/s served, ~176 packets dropped per short session, negligible tick cost.
- The guid→TypeID cache is the one piece of per-session state the tap depends on; it is bounded by update-range object counts and pruned by destroy/out-of-range.
