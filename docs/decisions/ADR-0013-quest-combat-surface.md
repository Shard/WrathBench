# ADR-0013: Quest/combat surface — the client-local judgment calls

Status: Accepted. Date: 2026-08-21.

## Context
The Phase 0 action set (targeting, combat, interaction, quests, loot, vendor,
inventory, death) is mechanical — one client opcode per action, one decoder per
whitelisted packet — except for four places where the contracts needed a call.

## Decision
- **`loot_all` replays the auto-loot client sequence inside the tap.** A take-all
  cannot be one opcode (the client sends per-slot AUTOSTORE only after the loot
  window arrives). Rather than force the SDK into three round trips, the module
  arms a flag and, on the window, queues exactly what an auto-loot client sends.
  This is client-local knowledge — the window was served to the agent too — the
  same argument that lets the mover impersonate the movement engine (ADR-0010).
- **`SMSG_MONSTER_MOVE` is served as destination + duration only.** The spline
  points would hand the agent the server's route in machine-readable form where
  a player sees animation. CONTRACTS.md's ambiguity rule resolves toward not
  serving.
- **Character delete is a parked utility session, not an in-world action.**
  `CMSG_CHAR_DELETE` is sent from character select, never in world; exposing it
  as an action would misrepresent that. Deleting by SQL is the server-side
  shortcut the action contract forbids and skips the core's own checks.
- **Quest log and inventory are served as the raw update fields the wire
  carries**, not reassembled guids, joined item templates or an inventory
  snapshot. That is a world model, which ADR-0010 assigned to the SDK.

## Consequences
- The tap writes packets in two places (query cache misses, loot replay), both
  through the thread-safe queue.
- `loot_all` is fire-and-forget; a window opened by plain `loot` is never
  auto-emptied.
- Combat multiplies event volume (~70% of it wandering-creature movement);
  batching remains future work until a denser zone demands it.
