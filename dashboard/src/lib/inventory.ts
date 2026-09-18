/**
 * Arranging one inventory sample into a bag grid and a paperdoll.
 *
 * Pure, and separate from the markup, because every interesting decision here
 * is about absent data rather than about layout. A run recorded before track
 * A's columns exists carries only `{name, count, equipped}`: no id, no
 * quality, no slot, no bag position. Newer runs carry some or all of them. The
 * panel has to be honest in every one of those states, and "honest" is what
 * these functions pin:
 *
 *  - no slot on a worn item: it is listed under the paperdoll as slot unknown,
 *    never placed in a square we guessed at. A guessed square would be a claim
 *    about the character that no observation supports.
 *  - no bag position on a carried item: the grid falls back to name order, so
 *    the cells at least stop reshuffling between samples.
 *  - `null` items is "this run recorded no inventory", which is not the same
 *    as an empty bag; the callers keep that distinction.
 */

/**
 * One item as the panels read it.
 *
 * Deliberately a local, fully-optional-beyond-the-original-three shape rather
 * than an import of `ItemSample`: the wire type gains these fields in track
 * A's own time, and a structural type accepts both the old rows and the new
 * ones without this file ever needing to change.
 */
export interface InvItem {
  name: string;
  count: number;
  equipped: boolean;
  itemId?: number | null;
  quality?: number | null;
  /** Equipment slot 0-18 for a worn item; see `EQUIPMENT_SLOTS`. */
  slot?: number | null;
  /** Where a carried item sits: `bag` 255 is the backpack, 19-22 a worn bag. */
  bag?: number | null;
  bagSlot?: number | null;
}

/** The carried items, in the order a player would see them across their bags. */
export function carried(items: readonly InvItem[]): InvItem[] {
  const rows = items.filter((i) => !i.equipped);
  const placed = rows.filter((i) => typeof i.bag === "number" && typeof i.bagSlot === "number");
  const loose = rows.filter((i) => !(typeof i.bag === "number" && typeof i.bagSlot === "number"));
  // The backpack (255) is the first bag on screen even though its number is the
  // largest, so it sorts ahead of the worn bags rather than after them.
  const bagRank = (b: number): number => (b === 255 ? -1 : b);
  placed.sort((a, b) => bagRank(a.bag!) - bagRank(b.bag!) || a.bagSlot! - b.bagSlot!);
  loose.sort((a, b) => a.name.localeCompare(b.name));
  // Positioned rows first: once track A lands, a mixed sample is a sample
  // mid-migration, and the rows that know where they are should keep their
  // order rather than being interleaved by name.
  return [...placed, ...loose];
}

/** What is worn in each equipment slot, and what is worn but does not say where. */
export function paperdoll(items: readonly InvItem[]): {
  bySlot: Map<number, InvItem>;
  unplaced: InvItem[];
} {
  const bySlot = new Map<number, InvItem>();
  const unplaced: InvItem[] = [];
  for (const item of items) {
    if (!item.equipped) continue;
    const slot = item.slot;
    if (typeof slot === "number" && Number.isInteger(slot) && slot >= 0 && slot <= 18 && !bySlot.has(slot)) {
      bySlot.set(slot, item);
    } else {
      unplaced.push(item);
    }
  }
  unplaced.sort((a, b) => a.name.localeCompare(b.name));
  return { bySlot, unplaced };
}

/** The number on the bag button: stacks carried, not items summed. */
export function carriedCount(items: readonly InvItem[] | null | undefined): number {
  if (items === null || items === undefined) return 0;
  return items.reduce((n, i) => (i.equipped ? n : n + 1), 0);
}
