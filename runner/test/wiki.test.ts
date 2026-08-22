/**
 * How the runner opens the reference bundle: absent is a configuration, stale
 * is a deploy mistake and fails closed (FOLLOW-UPS 30). Fixtures are synthetic
 * sqlite files; no dump, no bundle, no game text.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSchema } from "@wrathbench/wiki/bundle";
import { openWikiBundle } from "../src/wiki";

describe("openWikiBundle", () => {
  const dir = mkdtempSync(join(tmpdir(), "wrathbench-runner-wiki-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("a missing bundle is undefined, not an error", () => {
    expect(openWikiBundle(join(dir, "nope.sqlite"))).toBeUndefined();
  });

  test("a schema-too-old bundle fails closed, naming the table and the swap", () => {
    const path = join(dir, "old-bundle.sqlite");
    const w = new Database(path, { create: true });
    // Schema 1: pages exist, page_coords and page_ids never did.
    w.run("CREATE TABLE pages (id INTEGER PRIMARY KEY, title TEXT, ns INTEGER, text TEXT, text_len INTEGER)");
    w.close();

    expect(() => openWikiBundle(path)).toThrow(/page_coords/);
    // The remedy has to be actionable in a deploy window: build beside, swap in.
    expect(() => openWikiBundle(path)).toThrow(/bun wiki\/src\/build\.ts/);
    expect(() => openWikiBundle(path)).toThrow(/mv -f/);
  });

  test("a current bundle opens read-only with the coord and id channels present", () => {
    const path = join(dir, "current.sqlite");
    const w = new Database(path, { create: true });
    createSchema(w);
    w.close();

    const db = openWikiBundle(path);
    expect(db).toBeDefined();
    const tables = db!
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => r.name);
    expect(tables).toContain("page_coords");
    expect(tables).toContain("page_ids");
    expect(() => db!.run("INSERT INTO pages VALUES (1, 'x', 0, 'y', 1)")).toThrow();
    db!.close();
  });
});
