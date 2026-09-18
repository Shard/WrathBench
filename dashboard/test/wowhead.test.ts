/**
 * The item panels hold no art, so what is pinned here is the seam where that
 * shows: which entry a row links, what it falls back to when there is no entry
 * or no script, and that the script is asked for exactly once.
 *
 * The slot table is checked against AzerothCore's own enum rather than against
 * a list retyped from a wiki: the numbers arrive from the server, and a
 * paperdoll that places a trinket in the tabard square would be a claim about
 * the character that nothing observed.
 *
 * `wow.zamimg.com` and `www.wowhead.com` are the two external origins the
 * dashboard asks a reader's browser for, on the operator's decision of
 * 2026-09-18; `docs/PUBLIC-DASHBOARD.md` records the request audit.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { Window } from "happy-dom";
import { carried, carriedCount, paperdoll, splitLinked, type InvItem } from "../src/lib/inventory";
import { popoverPlacement } from "../src/lib/popover";
import {
  EQUIPMENT_SLOTS,
  PAPERDOLL_BOTTOM,
  PAPERDOLL_LEFT,
  PAPERDOLL_RIGHT,
  entryOf,
  isDecorated,
  isEquipmentSlot,
  itemUrl,
  loadWowhead,
  onWowheadStatus,
  parseEntryFromName,
  qualityColor,
  refreshLinks,
  resetWowheadStatus,
  slotLabel,
  wowheadConfig,
  wowheadStatus,
} from "../src/lib/wowhead";

const SRC = join(import.meta.dir, "..", "src");

function sources(dir: string = SRC): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith(".ts") || name.endsWith(".tsx") ? [path] : [];
  });
}

function item(over: Partial<InvItem> = {}): InvItem {
  return { name: "Linen Cloth", count: 1, equipped: false, ...over };
}

describe("an item id becomes a link, and nothing else does", () => {
  test("the Wrath dataset, because our ids are 3.3.5a", () => {
    expect(itemUrl(6948)).toBe("https://www.wowhead.com/wotlk/item=6948");
  });

  test("a non-entry is not a link", () => {
    expect(itemUrl(0)).toBeNull();
    expect(itemUrl(-1)).toBeNull();
    expect(itemUrl(1.5)).toBeNull();
    expect(itemUrl(Number.NaN)).toBeNull();
  });

  test("an unresolved name still carries its entry", () => {
    // What a state sample records when the client cache had no name yet.
    expect(parseEntryFromName("item 6948")).toBe(6948);
    expect(parseEntryFromName("  item 4540 ")).toBe(4540);
    expect(parseEntryFromName("Item 117")).toBe(117);
  });

  test("a real name is not an entry", () => {
    expect(parseEntryFromName("Hearthstone")).toBeNull();
    expect(parseEntryFromName("item")).toBeNull();
    expect(parseEntryFromName("items 12")).toBeNull();
    expect(parseEntryFromName("item 0")).toBeNull();
    expect(parseEntryFromName(null)).toBeNull();
  });

  test("the recorded id wins over the placeholder, and either works", () => {
    expect(entryOf({ itemId: 6948, name: "Hearthstone" })).toBe(6948);
    expect(entryOf({ name: "item 4540" })).toBe(4540);
    expect(entryOf({ itemId: null, name: "item 4540" })).toBe(4540);
    // A run from before the id column, with a name that did resolve: no link.
    expect(entryOf({ name: "Hearthstone" })).toBeNull();
  });
});

describe("quality colours survive the light theme", () => {
  test("common is the page's own foreground, not white", () => {
    // `#ffffff` on the light theme's `#fbfbfc` is invisible; null means "inherit".
    expect(qualityColor(1)).toBeNull();
    expect(qualityColor(null)).toBeNull();
    expect(qualityColor(undefined)).toBeNull();
  });

  test("the rest are the client's palette", () => {
    expect(qualityColor(0)).toBe("#9d9d9d");
    expect(qualityColor(2)).toBe("#1eff00");
    expect(qualityColor(3)).toBe("#0070dd");
    expect(qualityColor(4)).toBe("#a335ee");
    expect(qualityColor(5)).toBe("#ff8000");
    expect(qualityColor(6)).toBe("#e6cc80");
    expect(qualityColor(7)).toBe("#e6cc80");
  });
});

describe("the script is fetched once, configured before it loads", () => {
  test("a second call adds no second tag", () => {
    const win = new Window();
    const host = win as unknown as { document: Document; whTooltips?: unknown };
    expect(loadWowhead(host)).toBe(true);
    expect(loadWowhead(host)).toBe(false);
    const tags = host.document.querySelectorAll('script[src="https://wow.zamimg.com/js/tooltips.js"]');
    expect(tags.length).toBe(1);
  });

  test("the config is in place by the time the tag exists", () => {
    const win = new Window();
    const host = win as unknown as { document: Document; whTooltips?: unknown };
    loadWowhead(host);
    expect(host.whTooltips).toEqual(wowheadConfig());
    // Renaming off is what keeps our fallback text ours.
    expect(wowheadConfig().renameLinks).toBe(false);
  });

  test("no document, no script — importing this costs a test nothing", () => {
    expect(loadWowhead(undefined as never)).toBe(false);
  });

  test("refreshing links before the script lands is a no-op, not a throw", () => {
    expect(() => refreshLinks()).not.toThrow();
  });
});

describe("a cell knows whether Wowhead got to it", () => {
  const win = new Window();
  const doc = win.document as unknown as Document;
  const anchor = (html: string): Element => {
    const a = doc.createElement("a");
    a.innerHTML = html;
    return a;
  };

  test("our own fallback is not decoration", () => {
    expect(isDecorated(anchor('<span class="inv-name">Linen Cloth</span>'))).toBe(false);
  });

  test("anything the script inserted is", () => {
    expect(isDecorated(anchor('<span class="inv-name">x</span><ins style="background-image:url()"></ins>'))).toBe(true);
  });

  test("nothing at all is not decorated", () => {
    expect(isDecorated(null)).toBe(false);
    expect(isDecorated(anchor(""))).toBe(false);
  });
});

describe("the paperdoll's numbers are the server's numbers", () => {
  test("every slot 0-18 appears exactly once across the three regions", () => {
    const all: number[] = [...PAPERDOLL_LEFT, ...PAPERDOLL_RIGHT, ...PAPERDOLL_BOTTOM];
    all.sort((a, b) => a - b);
    expect(all).toEqual(Array.from({ length: 19 }, (_, i) => i));
    const defined: number[] = EQUIPMENT_SLOTS.map((s) => s.slot);
    defined.sort((a, b) => a - b);
    expect(defined).toEqual(all);
  });

  test("the labels match `EquipmentSlots` in Player.h", () => {
    // deps/azerothcore/src/server/game/Entities/Player/Player.h:660.
    expect(slotLabel(0)).toBe("head");
    expect(slotLabel(3)).toBe("shirt"); // EQUIPMENT_SLOT_BODY
    expect(slotLabel(14)).toBe("back");
    expect(slotLabel(15)).toBe("main hand");
    expect(slotLabel(17)).toBe("ranged");
    expect(slotLabel(18)).toBe("tabard");
  });

  test("bags are not paperdoll slots", () => {
    expect(isEquipmentSlot(18)).toBe(true);
    expect(isEquipmentSlot(19)).toBe(false); // the first bag
    expect(isEquipmentSlot(255)).toBe(false); // the backpack
    expect(isEquipmentSlot(null)).toBe(false);
  });
});

describe("what a sample says, and what it does not", () => {
  test("a worn item with no slot is listed, never placed", () => {
    // Every run recorded before the column existed is this case.
    const d = paperdoll([item({ name: "Worn Shortsword", equipped: true })]);
    expect(d.bySlot.size).toBe(0);
    expect(d.unplaced.map((i) => i.name)).toEqual(["Worn Shortsword"]);
  });

  test("a slot the sample does give is placed", () => {
    const d = paperdoll([
      item({ name: "Worn Shortsword", equipped: true, slot: 15 }),
      item({ name: "Recruit's Shirt", equipped: true, slot: 3 }),
      item({ name: "Linen Cloth", equipped: false }),
    ]);
    expect(d.bySlot.get(15)?.name).toBe("Worn Shortsword");
    expect(d.bySlot.get(3)?.name).toBe("Recruit's Shirt");
    expect(d.unplaced).toEqual([]);
  });

  test("a bag slot (19-22) is not a paperdoll square", () => {
    const d = paperdoll([item({ name: "Small Bag", equipped: true, slot: 19 })]);
    expect(d.bySlot.size).toBe(0);
    expect(d.unplaced.map((i) => i.name)).toEqual(["Small Bag"]);
  });

  test("a carried row's `slot` is a bag position, not an equipment slot", () => {
    // `slot` means two things depending on `bag`; only a worn row is placed.
    const d = paperdoll([item({ name: "Tough Jerky", equipped: false, bag: 255, slot: 4 })]);
    expect(d.bySlot.size).toBe(0);
    expect(d.unplaced).toEqual([]);
  });

  test("carried rows sort by bag then slot, backpack first", () => {
    const rows = carried([
      item({ name: "c", bag: 19, slot: 0 }),
      item({ name: "a", bag: 255, slot: 28 }),
      item({ name: "b", bag: 255, slot: 23 }),
      item({ name: "d", bag: 20, slot: 3 }),
    ]);
    expect(rows.map((i) => i.name)).toEqual(["b", "a", "c", "d"]);
  });

  test("without positions they sort by name, so the grid stops reshuffling", () => {
    const rows = carried([item({ name: "Tough Jerky" }), item({ name: "Linen Cloth" })]);
    expect(rows.map((i) => i.name)).toEqual(["Linen Cloth", "Tough Jerky"]);
  });

  test("positioned rows keep their order ahead of the ones mid-migration", () => {
    const rows = carried([item({ name: "aaa" }), item({ name: "zzz", bag: 255, slot: 23 })]);
    expect(rows.map((i) => i.name)).toEqual(["zzz", "aaa"]);
  });

  test("equipped rows are not carried, and the count is stacks not items", () => {
    const items = [item({ name: "Linen Cloth", count: 20 }), item({ name: "Sword", equipped: true })];
    expect(carried(items).map((i) => i.name)).toEqual(["Linen Cloth"]);
    expect(carriedCount(items)).toBe(1);
    // Null is "no inventory recorded", which the panels say in words.
    expect(carriedCount(null)).toBe(0);
    expect(carriedCount([])).toBe(0);
  });
});

describe("one place spells the external origins", () => {
  test("no source outside lib/wowhead.ts names zamimg or wowhead.com", () => {
    const users = sources().filter((p) => {
      if (p === join(SRC, "lib", "wowhead.ts")) return false;
      // A comment naming the decision is prose, not a second request path; the
      // check is for a literal URL.
      return /https:\/\/(wow\.zamimg\.com|www\.wowhead\.com)/.test(readFileSync(p, "utf8"));
    });
    expect(users.map((p) => p.slice(SRC.length + 1))).toEqual([]);
  });

  test("the script is injected at runtime, never from index.html", () => {
    // The page shell is shared with the public build's own head; the script
    // belongs to the pages that show items, and arrives with them.
    const html = readFileSync(join(SRC, "..", "index.html"), "utf8");
    expect(html.includes("zamimg")).toBe(false);
  });
});

describe("a square is only drawn where an icon can arrive", () => {
  // Three branches, and each is a decision about the reader rather than about
  // the data: a 40px box with a wrapped name in it is less readable than a
  // line of text, so the box is reserved for rows an icon will cover.
  const hasEntry = (i: InvItem): boolean => entryOf(i) !== null;

  test("rows with no entry are listed, not gridded", () => {
    const { linked, unlinked } = splitLinked(
      [item({ name: "item 6948" }), item({ name: "Barbaric Cloth Breeches" })],
      hasEntry,
    );
    expect(linked.map((i) => i.name)).toEqual(["item 6948"]);
    expect(unlinked.map((i) => i.name)).toEqual(["Barbaric Cloth Breeches"]);
  });

  test("a recorded id is an entry even when the name resolved", () => {
    const { linked } = splitLinked([item({ name: "Hearthstone", itemId: 6948 })], hasEntry);
    expect(linked.length).toBe(1);
  });

  test("a worn set with no slots has nothing to place, so it is a list", () => {
    // The historical case: `paperdoll` places none, and the panel draws the
    // list rather than an empty doll beside a chip row of the real armour.
    const worn = [
      item({ name: "Squire's Shirt", equipped: true }),
      item({ name: "Light Mail Armor", equipped: true }),
    ];
    const d = paperdoll(worn);
    expect(d.bySlot.size).toBe(0);
    expect(d.unplaced.length).toBe(2);
  });

  test("one slot is enough to draw the doll", () => {
    const d = paperdoll([
      item({ name: "Worn Shortsword", equipped: true, slot: 15 }),
      item({ name: "Squire's Shirt", equipped: true }),
    ]);
    expect(d.bySlot.size).toBe(1);
    expect(d.unplaced.map((i) => i.name)).toEqual(["Squire's Shirt"]);
  });
});

describe("a script that never arrives is a state, not a wait", () => {
  test("the tag's error says so, and every watcher hears it", () => {
    resetWowheadStatus();
    const win = new Window();
    const host = win as unknown as { document: Document; whTooltips?: unknown };
    const seen: string[] = [];
    const off = onWowheadStatus((s) => seen.push(s));
    loadWowhead(host);
    const tag = host.document.querySelector("script[src*=zamimg]") as unknown as { onerror?: () => void };
    tag.onerror?.();
    expect(seen).toEqual(["pending", "failed"]);
    expect(wowheadStatus()).toBe("failed");
    off();
    resetWowheadStatus();
  });

  test("ready wins once it is reached, and does not fall back", () => {
    resetWowheadStatus();
    const win = new Window();
    const host = win as unknown as { document: Document; whTooltips?: unknown };
    loadWowhead(host);
    const tag = host.document.querySelector("script[src*=zamimg]") as unknown as {
      onload?: () => void;
      onerror?: () => void;
    };
    tag.onload?.();
    expect(wowheadStatus()).toBe("ready");
    // A late error on a script that already ran must not blank the icons.
    tag.onerror?.();
    expect(wowheadStatus()).toBe("ready");
    resetWowheadStatus();
  });

  test("nothing has happened yet is pending, which still draws the grid", () => {
    resetWowheadStatus();
    expect(wowheadStatus()).toBe("pending");
  });
});

describe("a popover is placed against the viewport, not against its card", () => {
  const vp = { width: 1280, height: 800 };

  test("below the button when there is room", () => {
    const p = popoverPlacement({ top: 100, bottom: 120, left: 900 }, vp);
    expect(p.below).toBe(true);
    expect(p.offset).toBe(126);
    expect(p.maxHeight).toBe(800 - 120 - 6 - 8);
  });

  test("flipped above it when there is not", () => {
    // The defect: a button near the foot of a tall sidebar had four rows of a
    // nineteen-slot doll under it.
    const p = popoverPlacement({ top: 700, bottom: 730, left: 900 }, vp);
    expect(p.below).toBe(false);
    expect(p.offset).toBe(800 - 700 + 6);
    expect(p.maxHeight).toBe(700 - 6 - 8);
  });

  test("once the panel is measured, the side that fits the whole thing wins", () => {
    // 191px under the button is a usable panel but not a nineteen-slot doll.
    const rect = { top: 570, bottom: 594, left: 1030 };
    expect(popoverPlacement(rect, vp).below).toBe(true);
    const p = popoverPlacement(rect, vp, { needed: 430 });
    expect(p.below).toBe(false);
    expect(p.maxHeight).toBe(570 - 6 - 8);
  });

  test("never off the right edge, and never past the left margin", () => {
    expect(popoverPlacement({ top: 10, bottom: 30, left: 1270 }, vp).left).toBe(1280 - 340 - 8);
    expect(popoverPlacement({ top: 10, bottom: 30, left: -50 }, vp).left).toBe(8);
  });

  test("a phone-width viewport clamps to what is left, not below the margin", () => {
    // 360 - 340 - 8 leaves 12, so a button at 12 stays where it is; the CSS
    // max-width is what keeps the panel itself inside the screen.
    const p = popoverPlacement({ top: 10, bottom: 30, left: 40 }, { width: 360, height: 740 });
    expect(p.left).toBe(12);
    expect(popoverPlacement({ top: 10, bottom: 30, left: 0 }, { width: 360, height: 740 }).left).toBe(8);
  });
});
