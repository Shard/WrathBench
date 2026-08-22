/**
 * Bundle schema and writer.
 *
 * The bundle is a single sqlite file under data/ holding one row per kept page,
 * a redirect table, and an FTS5 index over title + text. It is Blizzard-derived
 * and never leaves data/.
 */

import { Database } from "bun:sqlite";
import type { WikiCoord } from "./coords";

export const DEFAULT_BUNDLE_PATH = "data/wiki/bundle.sqlite";

/** Fail loudly and early if this Bun build has no FTS5. */
export function assertFts5(db: Database): void {
  try {
    db.run("CREATE VIRTUAL TABLE temp.wrathbench_fts_probe USING fts5(x)");
    db.run("DROP TABLE temp.wrathbench_fts_probe");
  } catch (err) {
    throw new Error(
      `this sqlite build has no FTS5, the bundle cannot be indexed: ${String(err)}`,
    );
  }
}

export function createSchema(db: Database): void {
  db.run(`
    CREATE TABLE pages (
      id        INTEGER PRIMARY KEY,
      title     TEXT NOT NULL,
      ns        INTEGER NOT NULL,
      text      TEXT NOT NULL,
      text_len  INTEGER NOT NULL
    );
  `);
  db.run(`
    CREATE TABLE redirects (
      source TEXT PRIMARY KEY,
      target TEXT NOT NULL,
      ns     INTEGER NOT NULL
    );
  `);
  db.run("CREATE INDEX redirects_target ON redirects(target)");
  db.run(`
    CREATE TABLE meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  db.run(`
    CREATE VIRTUAL TABLE pages_fts USING fts5(
      title, text,
      content='pages', content_rowid='id',
      tokenize='unicode61 remove_diacritics 2'
    );
  `);
  // Wiki-reference coordinates lifted from page templates/infoboxes before the
  // wikitext is stripped. One page may have several. `raw` is the source
  // fragment, for provenance; search returns only the {zone,x,y} triple.
  db.run(`
    CREATE TABLE page_coords (
      page_id INTEGER NOT NULL,
      zone    TEXT,
      x       REAL NOT NULL,
      y       REAL NOT NULL,
      raw     TEXT NOT NULL
    );
  `);
}

/** Name of the coords table, so callers can probe for it on older bundles. */
export const COORDS_TABLE = "page_coords";

/**
 * True if this bundle was built with the coordinate channel (schema >= 2).
 * A pre-coords bundle simply lacks the table; consumers degrade rather than
 * crash, and `openBundle` fails loudly.
 */
export function bundleHasCoords(db: Database): boolean {
  const row = db
    .query<{ n: number }, [string]>(
      "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?",
    )
    .get(COORDS_TABLE);
  return (row?.n ?? 0) > 0;
}

/** Indexes that only pay off once the table is full. */
export function createIndexes(db: Database): void {
  db.run("CREATE INDEX pages_title ON pages(title)");
  db.run("CREATE INDEX pages_ns ON pages(ns)");
  db.run("CREATE INDEX page_coords_page_id ON page_coords(page_id)");
}

export function applyBuildPragmas(db: Database): void {
  db.run("PRAGMA journal_mode = OFF");
  db.run("PRAGMA synchronous = OFF");
  db.run("PRAGMA temp_store = MEMORY");
  db.run("PRAGMA cache_size = -262144"); // 256 MB
}

export interface Writer {
  /** `coords` is optional so pre-coords callers (and tests) still pass three args. */
  addPage(title: string, ns: number, text: string, coords?: readonly WikiCoord[]): void;
  addRedirect(source: string, target: string, ns: number): void;
  flush(): void;
}

/** Batched inserts inside a transaction; pages and their FTS rows go together. */
export function makeWriter(db: Database, batchSize = 2000): Writer {
  const insertPage = db.prepare(
    "INSERT INTO pages (id, title, ns, text, text_len) VALUES (?, ?, ?, ?, ?)",
  );
  const insertFts = db.prepare(
    "INSERT INTO pages_fts (rowid, title, text) VALUES (?, ?, ?)",
  );
  const insertCoord = db.prepare(
    "INSERT INTO page_coords (page_id, zone, x, y, raw) VALUES (?, ?, ?, ?, ?)",
  );
  const insertRedirect = db.prepare(
    "INSERT OR REPLACE INTO redirects (source, target, ns) VALUES (?, ?, ?)",
  );
  let nextId = 1;
  let inBatch = 0;
  let open = false;

  const begin = () => {
    if (!open) {
      db.run("BEGIN");
      open = true;
    }
  };
  const commit = () => {
    if (open) {
      db.run("COMMIT");
      open = false;
    }
    inBatch = 0;
  };
  const tick = () => {
    if (++inBatch >= batchSize) commit();
  };

  return {
    addPage(title, ns, text, coords) {
      begin();
      const id = nextId++;
      insertPage.run(id, title, ns, text, text.length);
      insertFts.run(id, title, text);
      if (coords !== undefined) {
        for (const c of coords) {
          insertCoord.run(id, c.zone ?? null, c.x, c.y, c.raw);
        }
      }
      tick();
    },
    addRedirect(source, target, ns) {
      begin();
      insertRedirect.run(source, target, ns);
      tick();
    },
    flush: commit,
  };
}

export function setMeta(db: Database, entries: Record<string, string>): void {
  const stmt = db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)");
  for (const [key, value] of Object.entries(entries)) stmt.run(key, value);
}

/** A fresh in-memory bundle. Used by tests and by anything that wants a scratch index. */
export function createMemoryBundle(): Database {
  const db = new Database(":memory:");
  assertFts5(db);
  createSchema(db);
  createIndexes(db);
  return db;
}
