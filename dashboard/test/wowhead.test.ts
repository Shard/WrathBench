/**
 * The item panels hold no art, so what is pinned here is the seam where that
 * shows: which entry a row links, and where on the paperdoll it is placed.
 *
 * The slot table is checked against AzerothCore's own enum rather than against
 * a list retyped from a wiki: the numbers arrive from the server, and a
 * paperdoll that places a trinket in the tabard square would be a claim about
 * the character that nothing observed.
 *
 * `wow.zamimg.com` and `www.wowhead.com` are the two external origins the
 * dashboard asks a reader's browser for, an operator decision;
 * `docs/PUBLIC-DASHBOARD.md` records the request audit. The script's loading
 * is the inspector's suite.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { paperdoll, type InvItem } from "@wrathbench/inspector/views/inventory";
import { EQUIPMENT_SLOTS, PAPERDOLL_BOTTOM, PAPERDOLL_LEFT, PAPERDOLL_RIGHT, entryOf, itemUrl, slotLabel } from "@wrathbench/inspector/views/wowhead";

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
  test("the Wrath dataset, a random roll on it either sign, and no link for a non-entry", () => {
    expect(itemUrl(6948)).toBe("https://www.wowhead.com/wotlk/item=6948");
    expect(itemUrl(12030, 1106)).toBe("https://www.wowhead.com/wotlk/item=12030?rand=1106");
    expect(itemUrl(25033, -40)).toBe("https://www.wowhead.com/wotlk/item=25033?rand=-40");
    expect(itemUrl(6948, 1.5)).toBe("https://www.wowhead.com/wotlk/item=6948");
    for (const id of [0, -1, 1.5, Number.NaN]) expect(itemUrl(id)).toBeNull();
  });

  test("the recorded id wins over the placeholder name, and a resolved name alone is no entry", () => {
    expect(entryOf({ itemId: 6948, name: "Hearthstone" })).toBe(6948);
    expect(entryOf({ name: "item 4540" })).toBe(4540);
    expect(entryOf({ itemId: null, name: "item 4540" })).toBe(4540);
    expect(entryOf({ name: "Hearthstone" })).toBeNull();
    expect(entryOf({ name: "item 0" })).toBeNull();
  });
});

describe("the paperdoll's numbers are the server's numbers", () => {
  test("every slot 0-18 appears exactly once, labelled as `EquipmentSlots` in Player.h", () => {
    const all: number[] = [...PAPERDOLL_LEFT, ...PAPERDOLL_RIGHT, ...PAPERDOLL_BOTTOM];
    all.sort((a, b) => a - b);
    expect(all).toEqual(Array.from({ length: 19 }, (_, i) => i));
    const defined: number[] = EQUIPMENT_SLOTS.map((s) => s.slot);
    expect(defined.sort((a, b) => a - b)).toEqual(all);
    // deps/azerothcore/src/server/game/Entities/Player/Player.h
    expect(slotLabel(0)).toBe("head");
    expect(slotLabel(3)).toBe("shirt"); // EQUIPMENT_SLOT_BODY
    expect(slotLabel(14)).toBe("back");
    expect(slotLabel(15)).toBe("main hand");
    expect(slotLabel(17)).toBe("ranged");
    expect(slotLabel(18)).toBe("tabard");
  });

  test("only a worn row with an equipment slot is placed; no slot, a bag slot or a carried position is listed, never placed", () => {
    const d = paperdoll([
      item({ name: "Worn Shortsword", equipped: true, slot: 15 }),
      item({ name: "Squire's Shirt", equipped: true }),
      item({ name: "Small Bag", equipped: true, slot: 19 }),
      item({ name: "Tough Jerky", equipped: false, bag: 255, slot: 4 }),
    ]);
    expect([...d.bySlot.entries()].map(([s, i]) => [s, i.name])).toEqual([[15, "Worn Shortsword"]]);
    expect(d.unplaced.map((i) => i.name).sort()).toEqual(["Small Bag", "Squire's Shirt"]);
  });
});

describe("one place spells the external origins", () => {
  test("no dashboard source names zamimg or wowhead.com, and the page shell never loads the script", () => {
    const users = sources().filter((p) => /https:\/\/(wow\.zamimg\.com|www\.wowhead\.com)/.test(readFileSync(p, "utf8")));
    expect(users.map((p) => p.slice(SRC.length + 1))).toEqual([]);
    expect(readFileSync(join(SRC, "..", "index.html"), "utf8").includes("zamimg")).toBe(false);
  });
});
