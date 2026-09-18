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
import { carried, carriedCount, paperdoll, type InvItem } from "../src/lib/inventory";
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
  parseEntryFromName,
  qualityColor,
  refreshLinks,
  slotLabel,
  wowheadConfig,
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
    // A run from before track A's column, with a name that did resolve: no link.
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
    // Every run today is this case: track A has not written `slot` yet.
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

  test("carried rows sort by bag then slot, backpack first", () => {
    const rows = carried([
      item({ name: "c", bag: 19, bagSlot: 0 }),
      item({ name: "a", bag: 255, bagSlot: 5 }),
      item({ name: "b", bag: 255, bagSlot: 1 }),
      item({ name: "d", bag: 20, bagSlot: 3 }),
    ]);
    expect(rows.map((i) => i.name)).toEqual(["b", "a", "c", "d"]);
  });

  test("without positions they sort by name, so the grid stops reshuffling", () => {
    const rows = carried([item({ name: "Tough Jerky" }), item({ name: "Linen Cloth" })]);
    expect(rows.map((i) => i.name)).toEqual(["Linen Cloth", "Tough Jerky"]);
  });

  test("positioned rows keep their order ahead of the ones mid-migration", () => {
    const rows = carried([item({ name: "aaa" }), item({ name: "zzz", bag: 255, bagSlot: 0 })]);
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
