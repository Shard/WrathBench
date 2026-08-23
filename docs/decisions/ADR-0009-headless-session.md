# ADR-0009: Headless WorldSession on a parked loopback socket

Status: Accepted. Date: 2026-08-21.

## Context
The module must stand up a WorldSession with no game client attached (ADR-0002).
On the pinned core both paths it needs are gated on the session's socket:
`SendPacket` returns before the script hook when `m_Socket` is null, and `Update`
refuses to drain the receive queue and reaps the session once the socket is null
or closed. `WorldSocket` is `final` and its constructor requires a connected TCP
socket, so a fake subclass is impossible.

## Decision
Construct the session the way the real auth path does, but hand it a *parked*
`WorldSocket`: a real socket around the server end of a loopback TCP pair the
module connects to itself, never started, never registered with a network
thread, never authenticated. It exists only so `IsOpen()` is true. Inbound actions
go through `QueuePacket` into the stock opcode table; outbound packets are
captured by a `CanPacketSend` hook that returns false so nothing accumulates on
the unflushed socket; teardown is a client logout followed by `CloseSocket()`,
which is exactly a client disconnect. Mechanics are in docs/ARCHITECTURE.md.

Rejected: a null socket (the mod-playerbots shape) is a dead end on stock core —
playerbots works only because its fork patches these paths, and ADR-0007 forbids
a fork. An in-process packet client over real TCP would exercise SRP, ARC4 and
framing for no difference in what the handlers see; it stays the future
high-fidelity track.

## Consequences
- Every handler-side check applies unchanged; the only skipped machinery is
  transport auth, which validates the wire, not the actions.
- The tap runs on whatever thread calls `SendPacket`; everything downstream must
  be lock-protected and never touch game objects.
- The coupling surface with the core is `WorldSession::SendPacket`,
  `WorldSession::Update` and the `WorldSocket` constructor. If a core bump moves
  the send hook or the null-socket semantics, this is where to look.
