/**
 * How the runner opens the reference bundle: absent is a configuration, stale
 * is a deploy mistake and fails closed (item 30). Fixtures are synthetic
 * sqlite files; no dump, no bundle, no game text.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSchema } from "@wrathbench/wiki/bundle";
import { openWikiBundle, wikiBundleMeta } from "../src/wiki";

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

/**
 * The bundle's identity, for the comparability tuple. Annotation,
 * never a gate: every failure mode here reads as "not recorded".
 */
describe("wikiBundleMeta", () => {
  const dir = mkdtempSync(join(tmpdir(), "wrathbench-runner-wikimeta-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function bundle(name: string, meta: Record<string, string>): string {
    const path = join(dir, name);
    const w = new Database(path, { create: true });
    createSchema(w);
    const stmt = w.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)");
    for (const [k, v] of Object.entries(meta)) stmt.run(k, v);
    w.close();
    return path;
  }

  test("no bundle reads as not-recorded, not as an error", () => {
    expect(wikiBundleMeta(undefined)).toBeNull();
  });

  test("an empty meta table reads all-null rather than throwing", () => {
    const db = openWikiBundle(bundle("empty.sqlite", {}));
    expect(wikiBundleMeta(db)).toEqual({
      schemaVersion: null,
      builtAt: null,
      source: null,
      eraCutoff: null,
    });
    db!.close();
  });

  test("a pre-era bundle keeps working: eraCutoff is null, the rest is read", () => {
    const db = openWikiBundle(
      bundle("pre-era.sqlite", {
        schema_version: "4",
        built_at: "2026-08-20T00:00:00.000Z",
        source: "example-dump.7z",
        pages_kept: "12",
      }),
    );
    expect(wikiBundleMeta(db)).toEqual({
      schemaVersion: "4", // TEXT in the bundle, a string here
      builtAt: "2026-08-20T00:00:00.000Z",
      source: "example-dump.7z",
      eraCutoff: null,
    });
    db!.close();
  });

  test("an era-cut bundle carries its cutoff", () => {
    const db = openWikiBundle(
      bundle("era.sqlite", {
        schema_version: "5",
        built_at: "2026-08-24T12:00:00.000Z",
        source: "example-dump.7z",
        era_cutoff: "2010-10-12",
      }),
    );
    expect(wikiBundleMeta(db)?.eraCutoff).toBe("2010-10-12");
    db!.close();
  });

  test("a bundle with no meta table at all reads all-null, never throws", () => {
    const path = join(dir, "no-meta.sqlite");
    const w = new Database(path, { create: true });
    createSchema(w);
    w.run("DROP TABLE meta");
    w.close();
    const db = new Database(path, { readonly: true });
    expect(wikiBundleMeta(db)?.builtAt).toBeNull();
    db.close();
  });
});
