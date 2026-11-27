import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryBundle, makeWriter } from "../src/bundle";
import { extractCoords } from "../src/coords";
import { openBundle, searchReference } from "../src/search";

/*
 * Everything here is synthetic and invented. No dump, no bundle and no game
 * text is needed to run these; nothing Blizzard-derived appears in this repo.
 */

describe("extractCoords", () => {
  test("a {{coords|X|Y|Zone}} template yields that triple, whatever its case, spacing or zone link", () => {
    expect(extractCoords("Lorem {{coords|48.2|42.1|Elwynn Forest}} ipsum.")).toEqual([
      { zone: "Elwynn Forest", x: 48.2, y: 42.1, raw: "{{coords|48.2|42.1|Elwynn Forest}}" },
    ]);
    expect(extractCoords("{{ Coords | 12.5 | 67.5 | Example Vale }}")).toMatchObject([{ x: 12.5, y: 67.5, zone: "Example Vale" }]);
    expect(extractCoords("{{coords|30|40|[[Example Vale|the vale]]}}")[0]!.zone).toBe("the vale");
    expect(extractCoords("{{coords|10|20}}")).toEqual([{ x: 10, y: 20, raw: "{{coords|10|20}}" }]);
  });

  test("infobox loc + location fields are paired", () => {
    const wt = `{{npcbox
 | name = Example Person Gamma
 | location = [[Example Zone Beta]]
 | loc = 55.5, 66.6
}}`;
    const got = extractCoords(wt);
    expect(got).toHaveLength(1);
    expect(got[0]!.x).toBe(55.5);
    expect(got[0]!.y).toBe(66.6);
    expect(got[0]!.zone).toBe("Example Zone Beta");
  });

  test("malformed templates and pages with none yield nothing", () => {
    expect(extractCoords("Just some prose with a [[link]] and no coordinates.")).toEqual([]);
    expect(extractCoords("{{coords|foo|bar|Nowhere}}")).toEqual([]); // non-numeric
    expect(extractCoords("{{coords|48.2}}")).toEqual([]); // only one number
    expect(extractCoords("{{coords|999|-5|Nowhere}}")).toEqual([]); // out of range
    expect(extractCoords("{{coordinator|48|42}}")).toEqual([]); // not the coords template
  });

  test("identical triples are deduped and the array is bounded", () => {
    const dup = extractCoords("{{coords|1|2|Z}} {{coords|1|2|Z}}");
    expect(dup).toHaveLength(1);
    const many = Array.from({ length: 30 }, (_, i) => `{{coords|${i}|${i}|Z}}`).join(" ");
    expect(extractCoords(many).length).toBeLessThanOrEqual(8);
  });
});

describe("search returns wiki coords", () => {
  let db: Database;

  beforeAll(() => {
    db = createMemoryBundle();
    const writer = makeWriter(db, 2);
    writer.addPage(
      "Example Person Gamma",
      0,
      "Example Person Gamma is a quest giver standing in Example Zone Beta.",
      extractCoords("{{coords|48.2|42.1|Example Zone Beta}} Example Person Gamma."),
    );
    writer.addPage(
      "Example Zone Beta",
      0,
      "Example Zone Beta is a starting region full of consectetur, with no coordinates of its own.",
    );
    writer.flush();
  });

  test("a title or full-text hit carries its coordinates as {zone,x,y}", () => {
    const hit = searchReference(db, "Example Person Gamma")[0]!;
    expect(hit.coords).toEqual([{ zone: "Example Zone Beta", x: 48.2, y: 42.1 }]);
    const body = searchReference(db, "quest giver standing")[0]!;
    expect(body.title).toBe("Example Person Gamma");
    expect(body.coords?.[0]).toEqual({ zone: "Example Zone Beta", x: 48.2, y: 42.1 });
  });

  test("a page without coordinates omits the field", () => {
    const hit = searchReference(db, "consectetur")[0]!;
    expect(hit.title).toBe("Example Zone Beta");
    expect(hit.coords).toBeUndefined();
  });
});

describe("bundle schema", () => {
  const dir = mkdtempSync(join(tmpdir(), "wrathbench-coords-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("openBundle names the build command when there is no bundle at all", () => {
    // The other documented failure mode (a bare clone, no data/): the message
    // must point at build.ts, not surface sqlite's "unable to open".
    const path = join(dir, "never-built", "bundle.sqlite");
    expect(() => openBundle(path)).toThrow(/no wiki bundle at /);
    expect(() => openBundle(path)).toThrow(/bun wiki\/src\/build\.ts/);
  });

  test("openBundle fails loudly on a bundle without page_coords", () => {
    const path = join(dir, "old-bundle.sqlite");
    const w = new Database(path, { create: true });
    // A schema-1 bundle: pages exist, page_coords never did.
    w.run("CREATE TABLE pages (id INTEGER PRIMARY KEY, title TEXT, ns INTEGER, text TEXT, text_len INTEGER)");
    w.close();
    expect(() => openBundle(path)).toThrow(/page_coords/);
    expect(() => openBundle(path)).toThrow(/bun wiki\/src\/build\.ts/);
  });
});
