/**
 * The world-id export the build reads (`--world-ids`, ADR-0042).
 *
 * Every id here is invented; no export of the real server is in this repository
 * and none ever will be.
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
  quest: [11, 12],
  creature: [21, 22],
  item: [31, 32],
  gameobject: [41],
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
  expect(ids.has("quest", 11)).toBe(true);
  expect(ids.has("npc", 21)).toBe(true);
  expect(ids.has("item", 31)).toBe(true);
  expect(ids.has("object", 41)).toBe(true);
  // The kinds do not bleed into each other: a creature id is not a quest id.
  expect(ids.has("quest", 21)).toBe(false);
  expect(ids.has("item", 41)).toBe(false);
  expect(ids.has("quest", 999)).toBe(false);
});

test("spell and unknown never match, whatever the file holds", async () => {
  const ids = await loadWorldIds(await write("kinds.json", EXPORT));
  // Spells are client DBC data; the world DB has no table for them, so its
  // silence is no evidence. An `unknown` id is a number whose kind the page did
  // not state.
  for (const id of [11, 21, 31, 41]) {
    expect(ids.has("spell", id)).toBe(false);
    expect(ids.has("unknown", id)).toBe(false);
  }
});

test("the export's identity comes back for the bundle's meta", async () => {
  const ids = await loadWorldIds(await write("meta.json", EXPORT));
  expect(ids.exportedAt).toBe("2026-08-24T12:00:00Z");
  expect(ids.counts).toEqual({ quest: 2, creature: 2, item: 2, gameobject: 1 });
});

test("a malformed or empty export fails the build rather than shrinking it", async () => {
  // Failing closed is the point: an export that silently loaded as empty would
  // put the bundle back where it was, which is exactly what this rule fixes.
  const missing = await write("missing.json", { ...EXPORT, item: undefined });
  expect(loadWorldIds(missing)).rejects.toThrow(/item/);
  const empty = await write("empty.json", { ...EXPORT, creature: [] });
  expect(loadWorldIds(empty)).rejects.toThrow(/creature/);
});
