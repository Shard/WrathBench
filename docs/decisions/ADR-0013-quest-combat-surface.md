# ADR-0013: Quest/combat action surface and its client-local conveniences

Status: Accepted. Date: 2026-08-21.

## Context
The remaining Phase 0 action set (targeting, combat, interaction, quests, loot,
vendor, inventory, death recovery) and its observation whitelist extend the
module beyond ADR-0009/0010. Nearly all of it is mechanical — one client opcode
per action through the stock handler, one decoder per whitelisted `SMSG_*` —
but four choices needed judgment against the contracts.

## Decisions

### `loot_all` replays the auto-loot client sequence inside the tap
A take-all convenience cannot be a single opcode: the client sends
`CMSG_AUTOSTORE_LOOT_ITEM` per slot only after `SMSG_LOOT_RESPONSE` tells it
the slots. Instead of forcing the SDK into a three-round-trip dance, `loot_all`
sends `CMSG_LOOT` and arms a per-session flag; when the tap sees the loot
window it queues exactly what an auto-loot client sends: AUTOSTORE for every
allow-loot slot, `CMSG_LOOT_MONEY` if there is gold, `CMSG_LOOT_RELEASE`. This
is client-local knowledge (the loot window contents were just served to the
agent too), the same argument that lets the mover impersonate the movement
engine. The one-slot/one-coin primitives remain for the SDK.

### `SMSG_MONSTER_MOVE` is served as destination + duration only
ADR-0010 deferred creature spline decoding with a warning: the path points
would hand the agent the server's route in machine-readable form, where a
player only sees animation. Combat needs moving targets, so the packet is now
whitelisted, but the decoder consumes the spline points and emits only the
current position, the destination, and the duration — what a player perceives
("it is heading over there, arriving in about two seconds").

### Character delete is a parked utility session, not an in-world action
`CMSG_CHAR_DELETE` is `STATUS_AUTHED`: the real client sends it from character
select, never in world. Exposing it as an `/action` would misrepresent that, so
`POST /character-delete` builds the same parked session as `/session`
(ADR-0009), stops at the character list, sends the delete for the matching
name, and tears down. Episode resets (ADR-0006) need this because the realm
caps characters per account at ten.

### Quest log and inventory come from raw update fields, not module joins
`PLAYER_QUEST_LOG_*`, `PLAYER_FIELD_INV_SLOT_*`/`PACK_SLOT_*`, coinage and XP
are whitelisted and served as the raw per-u32 fields the wire carries
(`quest3State`, `invSlot23Lo`…), including guid halves as two plain numbers.
The module does not reassemble guids, join item entries, or build an inventory
snapshot — that is a world model, which ADR-0010 already assigned to the SDK.
The delta shape of the wire is preserved; the SDK folds it.

## Alternatives
- Module-side loot state machine tracking slots across packets: more code and
  server-shaped state for no observable difference; the armed-flag replay only
  acts on the window the agent was served.
- Serving spline points "because the client gets them": true on the wire,
  but the observation contract is about what a *player* can act on; resolved
  toward not serving (docs/CONTRACTS.md ambiguity rule).
- Deleting characters by SQL: trivially easy and exactly the kind of
  server-side shortcut the action contract forbids; also skips the core's
  guild/arena/loaded checks.

## Consequences
- The tap now writes packets in two places (query cache misses, loot replay);
  both only ever call the thread-safe `QueuePacket`.
- `loot_all` is fire-and-forget: a loot window opened by a plain `loot` is
  never auto-emptied, and a `loot_release` clears a still-armed flag.
- Event volume grows with combat: `SMSG_ATTACKERSTATEUPDATE` per swing (both
  directions), aura updates, `SMSG_MONSTER_MOVE` for every wandering creature
  in range. Measured on the module-quest probe (8-kill Northshire arc, ~5.5
  min): ~11 events/s average, ~70% of them `SMSG_MONSTER_MOVE` from wandering
  kobolds. Batching knobs are not yet needed and remain future work if a
  denser zone demands them.
