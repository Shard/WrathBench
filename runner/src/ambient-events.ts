/**
 * The ambient-opcode pattern of the context policy (`CONTEXT_POLICY` in
 * `context.ts`, which holds this same RegExp as `EVENT_WINDOW_EXCLUDE`). A
 * leaf with no imports, so a reader of a run's record can count what the
 * model never saw without loading the context assembler, the SDK and the MCP
 * server behind it.
 *
 * Ambient-motion opcodes excluded from the model-visible event window (they
 * still fold into the state cache, whose nearby/motion the summary reflects).
 * Measured on gate2-ox-1: SMSG_MONSTER_MOVE alone was 69% of served events
 * while combat/quest signal was 1.8% — the window exists for signal.
 * WB_TRANSPORT_PROGRESS is the same kind of motion: each transport in view
 * range reports once a second (every transport on the map did, wherever
 * the character stood, which came to about four-fifths of the window's
 * characters and read to models as noise), while the cache already keeps
 * each car's position and `docked`.
 *
 * Excluded first, then counted (operator decision, 2026-10-05): the window
 * is the last EVENT_WINDOW events that are NOT ambient, however many ambient
 * ones arrived among them, and the line above it says how many ambient
 * events the span it covers held. It used to be the other way round — the
 * last EVENT_WINDOW events of any kind, ambient ones then dropped — and on a
 * continent whose transports report every second that left a median of 4
 * events, about 2.6 seconds of play, in a window the prompt calls "the most
 * recent events", with 17% of turns showing none at all; whatever the
 * previous half-minute of combat, loot and quest updates had said was gone
 * before the model's next turn. The sandbox child keeps the non-ambient
 * events in a ring of their own (`contextEvents` in sandbox/entry.ts), so
 * the window's reach is the last EVENT_WINDOW signal events since the
 * child started — independent of the ambient rate, and emptied by a
 * sandbox restart like everything else the child holds.
 *
 * SMSG_PARTY_MEMBER_STATS and its _FULL answer (the prefix matches both) are
 * ambient too (operator decision, Mark, 2026-10-21). They are the party
 * frames of a member out of sight, and the server sends one per update of
 * that member: about two a second while it walks, plus one for each regen
 * tick and each hit. Four far members would turn the 64-event window over
 * in about seven seconds. The state cache keeps each member's latest values
 * (`group().members[i].stats`), and the HUD's party line reads them there.
 *
 * A creature's threat list (SMSG_THREAT_UPDATE, SMSG_HIGHEST_THREAT_UPDATE)
 * and a world state's change (SMSG_UPDATE_WORLD_STATE) are ambient as well
 * (operator, 2026-10-30): about one list a second for each creature fighting in range, and three
 * changes a second while an outdoor PvP capture slider moves. The SDK keeps
 * them out of its retained buffer but its listeners, this ring's among them,
 * still receive them. The cache folds both (a unit's `threat`,
 * `self.worldStates`); the list's removal and clear and the zone's initial
 * states stay ordinary events.
 *
 * One kind of event is ambient by what it carries, not by its opcode: an
 * update that says only that a ship or zeppelin came into view or left it
 * (`transportSighting` in `context.ts`; operator, 2026-11-12). `isAmbientEvent`
 * there is the whole test, this pattern and that one, and is what every
 * reader of the window asks.
 */
export const EVENT_WINDOW_EXCLUDE =
  /^(SMSG_MONSTER_MOVE|MSG_MOVE|WB_TRANSPORT_PROGRESS|SMSG_PARTY_MEMBER_STATS|(SMSG_THREAT_UPDATE|SMSG_HIGHEST_THREAT_UPDATE|SMSG_UPDATE_WORLD_STATE)$)/;
