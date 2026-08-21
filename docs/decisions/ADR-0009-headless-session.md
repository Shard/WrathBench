# ADR-0009: Headless WorldSession on a parked loopback socket

Status: Accepted. Date: 2026-08-21.

## Context
The module must stand up a WorldSession with no game client attached: inject CMSG_* into its handlers and tap its outbound SMSG_* stream (ADR-0002). On this core, both paths are gated on the session's socket: `WorldSession::SendPacket` returns before the script hook when `m_Socket` is null, and `WorldSession::Update` refuses to drain the receive queue and reaps the session once `m_Socket` is null or closed. `WorldSocket` is `final` and its constructor requires a connected TCP socket (the base `Socket<T>` reads `remote_endpoint()` at construction), so a fake subclass is off the table.

## Decision
Construct the WorldSession directly, the way `WorldSocket::HandleAuthSessionCallback` does, but hand it a *parked* WorldSocket: a real `WorldSocket` wrapped around the server end of a loopback TCP pair the module connects to itself. `Start()` is never called, the socket is never registered with a network thread, and no auth handshake happens — the socket exists only so `IsOpen()` is true and the session's null checks pass. The session is handed to `WorldSessionMgr::AddSession`, the same queue the real auth path uses, so `InitializeSession` and everything after run stock on the world thread.

- Inbound: actions become `WorldPacket`s pushed through `WorldSession::QueuePacket` — the same thread-safe queue `WorldSocket::ReadDataHandler` feeds — and are dispatched by the stock opcode table with all status/DOS checks.
- Outbound: a `ServerScript::CanPacketSend` hook captures every packet for bench sessions and returns false, so nothing is ever queued on the parked socket (which would otherwise grow unbounded, since no network thread flushes it).
- Keepalive: the socket-idle kick normally reset by `ReadHandler` is reset from a `WorldScript::OnUpdate` hook (`ResetTimeOutTime` is public).
- Teardown: graceful logout goes through CMSG_LOGOUT_REQUEST; after SMSG_LOGOUT_COMPLETE the module calls `CloseSocket()` on the parked socket, which is exactly a client disconnect at character select — the world thread reaps and deletes the session on its next update.

HTTP and WebSocket use Boost.Beast, which is header-only and ships in the Boost the core already requires (1.83 on the pinned image). JSON is a small hand-rolled builder and flat-object parser (`WbJson.h`) rather than Boost.JSON: the core's `find_package(Boost ...)` requests only `filesystem program_options iostreams regex`, so there is no `Boost::json` target, and the wire shapes are small and flat enough that a hand-rolled serializer costs less than wiring Boost.JSON's link mode into the module build. No new vendored dependency, no new link libraries.

## Alternatives
- Null/sentinel socket (the mod-playerbots shape): dead end on stock core — `SendPacket` early-returns before `CanPacketSend`, `Update` skips the receive queue, and the session is reaped on the first update. Playerbots works because its fork patches these paths; ADR-0007 forbids a fork.
- In-process packet client over real loopback TCP to port 8085: highest fidelity (header crypto, auth handshake, framing all exercised) but it is Path A in miniature — SRP session key plumbing, ARC4, client-side framing — for no observable difference in what the handlers see. Kept as the future high-fidelity track (ADR-0002).
- Fake/loopback `WorldSocket` subclass: impossible, the class is `final` and constructor-coupled to a connected socket.

## Consequences
- Every handler-side check applies unchanged; the only skipped machinery is transport auth (SRP digest, ARC4, Warden), which validates the wire, not the actions.
- The parked socket costs one loopback TCP connection per session and satisfies idle/reap logic without touching core code.
- The tap sees packets on whatever thread calls `SendPacket` (world thread during login, map threads in world); everything downstream of the hook must be lock-protected and must never touch game objects.
- Suppressing the socket write in `CanPacketSend` means an Eluna-style observer module loaded alongside would also not see these packets; acceptable, nothing else runs in this worldserver.
- If a future core change moves the send hook or the null-socket semantics, this ADR is where to look; the coupling surface is `WorldSession::SendPacket`, `WorldSession::Update`, and the `WorldSocket` constructor.
