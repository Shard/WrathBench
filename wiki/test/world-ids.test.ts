/**
 * The world-id export the build reads (`--world-ids`).
 *
 * Every id and name here is invented; no export of the real server is in this
 * repository and none ever will be.
 */

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWorldIds } from "../src/world-ids";

const dir = mkdtempSync(join(tmpdir(), "wrathbench-world-ids-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const EXPORT = {
  source: "invented",
  exported_at: "2026-08-24T12:00:00Z",
  counts: { quest: 2, creature: 2, item: 2, gameobject: 1 },
  quest: { 11: "Example Quest Alpha", 12: "Example Quest Beta" },
  creature: { 21: "Example Guard", 22: "Example Other Guard" },
  item: { 31: "Example Trinket", 32: "Example Cloak" },
  gameobject: { 41: "Example Node" },
};

async function write(name: string, body: unknown): Promise<string> {
  const path = join(dir, name);
  await Bun.write(path, JSON.stringify(body));
  return path;
}

test("the wiki's id kinds map onto the world DB's tables", async () => {
  const ids = await loadWorldIds(await write("ok.json", EXPORT));
  // quest -> quest_template, npc -> creature_template, item -> item_template,
  // object -> gameobject_template.
  expect(ids.name("quest", 11)).toBe("Example Quest Alpha");
  expect(ids.name("npc", 21)).toBe("Example Guard");
  expect(ids.name("item", 31)).toBe("Example Trinket");
  expect(ids.name("object", 41)).toBe("Example Node");
  // The kinds do not bleed into each other: a creature id is not a quest id.
  expect(ids.name("quest", 21)).toBeUndefined();
  expect(ids.name("item", 41)).toBeUndefined();
  expect(ids.name("quest", 999)).toBeUndefined();
});

test("spell and unknown never resolve, whatever the file holds", async () => {
  const ids = await loadWorldIds(await write("kinds.json", EXPORT));
  // Spells are client DBC data; the world DB has no table for them, so its
  // silence is no evidence. An `unknown` id is a number whose kind the page did
  // not state.
  for (const id of [11, 21, 31, 41]) {
    expect(ids.name("spell", id)).toBeUndefined();
    expect(ids.name("unknown", id)).toBeUndefined();
  }
});

test("the export's identity comes back for the bundle's meta", async () => {
  const ids = await loadWorldIds(await write("meta.json", EXPORT));
  expect(ids.exportedAt).toBe("2026-08-24T12:00:00Z");
  expect(ids.counts).toEqual({ quest: 2, creature: 2, item: 2, gameobject: 1 });
});

test("the id-only export is rejected, not read as nameless", async () => {
  // The first version of this export was four bare id arrays, and an id without
  // a name admits the page that copy-pasted someone else's infobox. A build
  // handed one must stop, not quietly lose the discriminator.
  const old = await write("old.json", { ...EXPORT, creature: [21, 22] });
  expect(loadWorldIds(old)).rejects.toThrow(/id-only export/);
});

test("a malformed or empty export fails the build rather than shrinking it", async () => {
  // Failing closed is the point: an export that silently loaded as empty would
  // put the bundle back where it was, which is exactly what this rule fixes.
  const missing = await write("missing.json", { ...EXPORT, item: undefined });
  expect(loadWorldIds(missing)).rejects.toThrow(/item/);
  const empty = await write("empty.json", { ...EXPORT, creature: {} });
  expect(loadWorldIds(empty)).rejects.toThrow(/creature/);
});
