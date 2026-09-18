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
  /** The equipment slot 0-18 when worn, the slot within `bag` when carried. */
  slot?: number | null;
  /** The container when carried: 255 the backpack, 19-22 a worn bag. Absent when worn. */
  bag?: number | null;
}

/** The carried items, in the order a player would see them across their bags. */
export function carried(items: readonly InvItem[]): InvItem[] {
  const rows = items.filter((i) => !i.equipped);
  const positioned = (i: InvItem): boolean => typeof i.bag === "number" && typeof i.slot === "number";
  const placed = rows.filter(positioned);
  const loose = rows.filter((i) => !positioned(i));
  // The backpack (255) is the first bag on screen even though its number is the
  // largest, so it sorts ahead of the worn bags rather than after them.
  const bagRank = (b: number): number => (b === 255 ? -1 : b);
  placed.sort((a, b) => bagRank(a.bag!) - bagRank(b.bag!) || a.slot! - b.slot!);
  loose.sort((a, b) => a.name.localeCompare(b.name));
  // Positioned rows first: a mixed sample is one where some slots were seen
  // and some were not, and the rows that know where they sit should keep that
  // order rather than being interleaved by name with the ones that do not.
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
    // `bag` present means the row is addressed inside a container, so its
    // `slot` is a bag position and not an equipment slot — the two share the
    // field name. A worn row never carries one.
    const worn = item.bag === undefined || item.bag === null;
    if (worn && typeof slot === "number" && Number.isInteger(slot) && slot >= 0 && slot <= 18 && !bySlot.has(slot)) {
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

/**
 * The rows a grid can draw, and the rows it cannot.
 *
 * A square is a frame around an icon, and the icon only exists for a row with
 * an entry to link. A row without one — most of every run recorded before the
 * id column, whose names resolved and so carry no `item <id>` to parse — would
 * be a 40px box with "Barba ric Cloth Breec" wrapped inside it. Those rows are
 * a list instead, and this is the split the panels draw from.
 */
export function splitLinked(
  items: readonly InvItem[],
  hasEntry: (i: InvItem) => boolean,
): { linked: InvItem[]; unlinked: InvItem[] } {
  const linked: InvItem[] = [];
  const unlinked: InvItem[] = [];
  for (const i of items) (hasEntry(i) ? linked : unlinked).push(i);
  return { linked, unlinked };
}

/** The button a popover hangs off, as much of its rect as the maths needs. */
export interface AnchorRect {
  top: number;
  bottom: number;
  left: number;
}

/** Where a floating popover sits, in viewport coordinates. */
export interface Placement {
  /** Below the button, or flipped above it. */
  below: boolean;
  /** The CSS offset from the viewport edge the popover is pinned to. */
  offset: number;
  left: number;
  maxHeight: number;
}

/**
 * Place a popover against the viewport rather than against its card.
 *
 * The panels hang off buttons inside a scrolling sidebar, and a popover that
 * is a child of that sidebar is clipped by it — a full paperdoll showed four
 * rows. So it is drawn through a portal, fixed, and this is the arithmetic:
 * below the button when there is room, flipped above when there is not, always
 * within the viewport horizontally, and never taller than what is left.
 *
 * Pure, so the case that matters — a button near the foot of a tall page — is
 * testable without a browser.
 */
export function popoverPlacement(
  rect: AnchorRect,
  viewport: { width: number; height: number },
  opts: { width?: number; gap?: number; margin?: number; min?: number; needed?: number } = {},
): Placement {
  const width = opts.width ?? 340;
  const gap = opts.gap ?? 6;
  const margin = opts.margin ?? 8;
  const min = opts.min ?? 120;
  const below = viewport.height - rect.bottom - gap - margin;
  const above = rect.top - gap - margin;
  // Below unless it is both short of a usable panel and worse than above: a
  // popover that fits below stays below, because that is where the button is.
  // Once the panel has been measured, `needed` is its real height, and the bar
  // becomes "does the whole thing fit" — a nineteen-slot doll under a button
  // near the foot of a card wants the room above it, not a scrollbar.
  const want = opts.needed ?? min;
  const goBelow = below >= want || below >= above;
  const room = Math.max(min, goBelow ? below : above);
  const left = Math.min(Math.max(margin, rect.left), Math.max(margin, viewport.width - width - margin));
  return {
    below: goBelow,
    offset: goBelow ? rect.bottom + gap : viewport.height - rect.top + gap,
    left,
    maxHeight: room,
  };
}
