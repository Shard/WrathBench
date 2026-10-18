/**
 * Arranging one inventory sample into a bag grid and a paperdoll, and the
 * trace's character sheet into such a sample.
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

import type { TraceItemName, TraceSheet } from "@viewer/api-types";

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
  /**
   * The instance's random property id, negative for a random suffix, when the
   * trace's sheet says it has one. The sheet names an item by its template, so
   * the suffix reaches the reader only through the Wowhead link carrying it.
   */
  rand?: number | null;
  /** A worn item's durability, current and maximum, when the trace's sheet carries it. */
  durability?: readonly [cur: number, max: number] | null;
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

/* ------------------------------------------------------ the trace's sheet --- */

/** The sheet's lists the panels draw from. */
export type SheetInventory = Pick<TraceSheet, "equip" | "inv" | "dur">;

type Names = ReadonlyMap<number, TraceItemName>;
type Row = readonly number[];

/**
 * What one dictionary has built: the last lists and their rows, so a sheet
 * whose lists did not change gets the same array back, and a row that did not
 * change keeps its object. The codec's fold keeps a row it did not touch as
 * the same array, so identity is the whole test.
 */
interface Built {
  equip: Row[] | null;
  inv: Row[] | null;
  dur: Row[] | null;
  out: InvItem[];
  rows: WeakMap<Row, { dur: Row | undefined; item: InvItem }>;
}

/** Per segment dictionary: the names are a segment's, and one segment's rows are read against its own. */
const builds = new WeakMap<Names, Built>();

/**
 * The label a row is shown by, as the 60 s state line writes one
 * (`itemSample` in `runner/src/loop.ts`): the template's name, else `item
 * <id>` (which `entryOf` still links), else the slot for an item the cache has
 * not seen created yet.
 */
function labelOf(names: Names, itemId: number, slot: number): string {
  const name = itemId > 0 ? names.get(itemId)?.[1] : undefined;
  return name ?? (itemId > 0 ? `item ${itemId}` : `slot ${slot}`);
}

function rowItem(names: Names, row: Row, worn: boolean, dur: Row | undefined): InvItem {
  const [a, b, itemId] = worn ? [undefined, row[0]!, row[1]!] : [row[0]!, row[1]!, row[2]!];
  const quality = itemId > 0 ? names.get(itemId)?.[0] : undefined;
  const rand = worn ? row[2] : row[4];
  return {
    name: labelOf(names, itemId, b),
    count: worn ? 1 : (row[3] ?? 1),
    equipped: worn,
    ...(itemId > 0 ? { itemId } : {}),
    ...(typeof quality === "number" ? { quality } : {}),
    slot: b,
    ...(a === undefined ? {} : { bag: a }),
    ...(rand !== undefined && rand !== 0 ? { rand } : {}),
    ...(dur !== undefined && dur.length >= 3 ? { durability: [dur[1]!, dur[2]!] as const } : {}),
  };
}

/**
 * The sheet's equipment and carried items as the panels' rows: the same rows
 * the 60 s reading would have given (`itemSample`), plus each item's random
 * property and a worn item's durability. Worn bags are not among them, as they
 * are not on the reading. Null when either list is not recorded, which the
 * caller reads as "the sheet cannot say" and falls back from, never as empty
 * bags.
 *
 * The same array comes back while the lists stay the same arrays (a frame,
 * a money change), and an unchanged row keeps its object, so the bag and the
 * paperdoll redraw only what moved and keep the icons Wowhead put in them.
 */
export function sheetItems(sheet: SheetInventory, names: Names): InvItem[] | null {
  const { equip, inv, dur } = sheet;
  if (equip === null || inv === null) return null;
  const last = builds.get(names);
  if (last !== undefined && last.equip === equip && last.inv === inv && last.dur === dur) return last.out;
  const rows = last?.rows ?? new WeakMap<Row, { dur: Row | undefined; item: InvItem }>();
  const durOf = new Map<number, Row>();
  for (const d of dur ?? []) durOf.set(d[0]!, d);
  const one = (row: Row, worn: boolean): InvItem => {
    const d = worn ? durOf.get(row[0]!) : undefined;
    const hit = rows.get(row);
    if (hit !== undefined && hit.dur === d) return hit.item;
    const item = rowItem(names, row, worn, d);
    rows.set(row, { dur: d, item });
    return item;
  };
  const out = [...equip.map((r) => one(r, true)), ...inv.map((r) => one(r, false))];
  builds.set(names, { equip, inv, dur, out, rows });
  return out;
}

/** What the sidebar shows for money and the inventory. */
export interface SheetReading {
  money: number | null;
  items: readonly InvItem[] | null;
}

/**
 * The sidebar's money and inventory at the playhead: the trace's sheet where
 * it says, and the coarse reading where it does not — the position's newest
 * reading live, the track's at the cursor in a replay. `view` is null where
 * the trace does not drive (a replay playing faster than its segments are
 * fetched for) or cannot answer (nothing loaded there), and a sheet key is
 * null where it was not recorded: a segment from before the sheet, or the
 * stretch after a sandbox restart before the character's own create block.
 * Either way the reading stands, so the panel never goes blank where the
 * reading had something. An empty list is an observation and stands.
 */
export function sheetReading(
  view: { sheet: SheetInventory & Pick<TraceSheet, "money">; items: Names } | null,
  reading: SheetReading,
): SheetReading {
  if (view === null) return reading;
  return { money: view.sheet.money ?? reading.money, items: sheetItems(view.sheet, view.items) ?? reading.items };
}
