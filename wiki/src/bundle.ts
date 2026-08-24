/**
 * Bundle schema and writer.
 *
 * The bundle is a single sqlite file under data/ holding one row per kept page,
 * a redirect table, and an FTS5 index over title + text. It is Blizzard-derived
 * and never leaves data/.
 */

import { Database } from "bun:sqlite";
import type { WikiCoord } from "./coords";
import type { WikiId } from "./ids";
import type { WikiQuest } from "./quests";

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
  // Numeric entity ids the page states about itself, lifted from infobox
  // templates before the strip (schema 3). Without them a query for an id can
  // only be answered by body prose, which is what FOLLOW-UPS 25 was about.
  db.run(`
    CREATE TABLE page_ids (
      page_id INTEGER NOT NULL,
      kind    TEXT NOT NULL,
      id      INTEGER NOT NULL
    );
  `);
  // What a quest page's infobox states about its giver and its turn-in, lifted
  // before the strip (schema 4). `end` is NULL when the page does not say; it
  // is never inferred from `start`. See quests.ts.
  db.run(`
    CREATE TABLE page_quest (
      page_id  INTEGER PRIMARY KEY,
      start    TEXT,
      end      TEXT,
      category TEXT
    );
  `);
}

/** Name of the coords table, so callers can probe for it on older bundles. */
export const COORDS_TABLE = "page_coords";

/** Name of the entity-id table, so callers can probe for it on older bundles. */
export const IDS_TABLE = "page_ids";

/** Name of the quest-infobox table, so callers can probe for it on older bundles. */
export const QUEST_TABLE = "page_quest";

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

/**
 * True if this bundle was built with the entity-id channel (schema >= 3).
 * Consumers degrade — an id query on an older bundle simply finds nothing and
 * says so — rather than throwing: a live episode must not lose search because
 * the deployed bundle is a version behind.
 */
export function bundleHasIds(db: Database): boolean {
  const row = db
    .query<{ n: number }, [string]>(
      "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?",
    )
    .get(IDS_TABLE);
  return (row?.n ?? 0) > 0;
}

/**
 * True if this bundle was built with the quest giver/ender channel (schema >= 4).
 * Degrades like `page_ids` rather than failing closed: a live episode must not
 * lose `search_reference` because the deployed bundle is a version behind.
 */
export function bundleHasQuest(db: Database): boolean {
  const row = db
    .query<{ n: number }, [string]>(
      "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?",
    )
    .get(QUEST_TABLE);
  return (row?.n ?? 0) > 0;
}

/**
 * One row per (title, ns), the bundle's central invariant.
 *
 * The dump splits a long page history into several `<page>` blocks; a parser
 * that took a block for a page silently wrote thousands of stale duplicate rows
 * competing with current text in the FTS index (FOLLOW-UPS 49). Returns the
 * distinct key count so the build can record it, and throws otherwise, so that
 * class of bug fails the build instead of shipping.
 */
export function assertUniquePages(db: Database): number {
  const row = db
    .query<{ rows: number; keys: number }, []>(
      "SELECT count(*) AS rows, count(DISTINCT title || char(31) || ns) AS keys FROM pages",
    )
    .get();
  const rows = row?.rows ?? 0;
  const keys = row?.keys ?? 0;
  if (rows !== keys) {
    throw new Error(
      `pages holds ${rows} rows for ${keys} distinct (title, ns): a page was written more ` +
        "than once, so search would rank its stale text against its current text",
    );
  }
  return keys;
}

/** Indexes that only pay off once the table is full. */
export function createIndexes(db: Database): void {
  // UNIQUE is the standing guard behind `assertUniquePages`, which runs first
  // and says what went wrong in words.
  db.run("CREATE UNIQUE INDEX pages_title_ns ON pages(title, ns)");
  db.run("CREATE INDEX pages_ns ON pages(ns)");
  db.run("CREATE INDEX page_coords_page_id ON page_coords(page_id)");
  db.run("CREATE INDEX page_ids_page_id ON page_ids(page_id)");
  db.run("CREATE INDEX page_ids_lookup ON page_ids(id, kind)");
}

export function applyBuildPragmas(db: Database): void {
  db.run("PRAGMA journal_mode = OFF");
  db.run("PRAGMA synchronous = OFF");
  db.run("PRAGMA temp_store = MEMORY");
  db.run("PRAGMA cache_size = -262144"); // 256 MB
}

export interface Writer {
  /** `coords`/`ids`/`quest` are optional so older callers (and tests) still pass three args. */
  addPage(
    title: string,
    ns: number,
    text: string,
    coords?: readonly WikiCoord[],
    ids?: readonly WikiId[],
    quest?: WikiQuest | null,
  ): void;
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
  const insertId = db.prepare("INSERT INTO page_ids (page_id, kind, id) VALUES (?, ?, ?)");
  const insertQuest = db.prepare(
    "INSERT OR REPLACE INTO page_quest (page_id, start, end, category) VALUES (?, ?, ?, ?)",
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
    addPage(title, ns, text, coords, ids, quest) {
      begin();
      const id = nextId++;
      insertPage.run(id, title, ns, text, text.length);
      insertFts.run(id, title, text);
      if (coords !== undefined) {
        for (const c of coords) {
          insertCoord.run(id, c.zone ?? null, c.x, c.y, c.raw);
        }
      }
      if (ids !== undefined) {
        for (const e of ids) insertId.run(id, e.kind, e.id);
      }
      if (quest !== undefined && quest !== null) {
        insertQuest.run(id, quest.start ?? null, quest.end ?? null, quest.category ?? null);
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
