# ADR-0002: Server-side control module with client-fidelity contracts

Status: Accepted. Date: 2026-08-21.

## Context
Research showed no headless 3.3.5a client implements combat, loot, quests, or vendors. jackpoz/BotFarm covers auth and navmesh movement only. Building a packet client's action layer is a multi-month project in itself.

## Decision
An in-process AzerothCore module exposes actions over HTTP and events over WebSocket. Actions are dispatched by constructing the client opcode and pushing it through the character's WorldSession handler. Observations are filtered to what a real client could see. Both contracts are documented in CONTRACTS.md and logged at the boundary.

## Alternatives
- Packet client (Path A): highest fidelity, highest cost. The SDK vocabulary is kept client-shaped so a packet-client transport could be added later as a high-fidelity track without changing the SDK.
- Eluna Lua scripting: good for prototyping, verifiers, and ledgers; cannot synthesise packets into session handlers.
- Calling server internals directly: fastest, but bypasses client validation and invites the privilege critique.

## Consequences
- Client-level validation for free, stays correct as the core evolves.
- Pathing uses server mmaps inside the module; documented as the one deliberate exception.
- The module is C++ and will need re-porting across major AzerothCore bumps; keep it thin.
