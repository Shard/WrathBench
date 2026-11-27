/**
 * The Deadmines by creature entry and map: what a run page's boss marks and
 * the camera read, as well as the dungeon board (`dungeons.ts`). A leaf, so a run page does not load the board and the
 * campaigns behind it.
 */

/**
 * Every Deadmines boss by creature entry (docs/proposals/GROUP-PLAY.md §6):
 * Rhahk'Zor, Sneed, Sneed's Shredder, Gilnid, Mr. Smite, Captain Greenskin,
 * Edwin VanCleef, Cookie. What a timeline or the camera calls a boss kill;
 * the board counts the route's seven (`DEADMINES_REQUIRED`).
 */
export const DEADMINES_BOSSES: readonly number[] = [644, 643, 642, 1763, 646, 647, 639, 645];

/** Cookie: a Deadmines boss off the route to VanCleef, an optional extra on the board. */
export const DEADMINES_EXTRA_ENTRY = 645;

/** The seven bosses on the route to VanCleef, in the board's order: the bosses an attempt is counted by. */
export const DEADMINES_REQUIRED: readonly number[] = DEADMINES_BOSSES.filter((e) => e !== DEADMINES_EXTRA_ENTRY);

/** Edwin VanCleef: the kill that clears the episode (the definitions' `end`). */
export const DEADMINES_END_ENTRY = 639;

/** The Deadmines instance map. */
export const DEADMINES_MAP = 36;
