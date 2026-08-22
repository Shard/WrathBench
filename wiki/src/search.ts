#!/usr/bin/env bun
/**
 * Search over the wiki bundle. This is what the runner's `search_reference`
 * MCP tool calls.
 *
 * Two things happen per query. First a title resolution: the query is treated
 * as a page title and pushed through the redirect table, so an agent that knows
 * an old or alternate name still lands on the article. Then an FTS5 MATCH
 * ranked by bm25 with the title column weighted up. The title hit, if any, is
 * returned first; FTS results follow, deduplicated.
 */

import { Database } from "bun:sqlite";
import { DEFAULT_BUNDLE_PATH, bundleHasCoords } from "./bundle";

export interface SearchOptions {
  /** Max results. Default 8. */
  limit?: number;
  /** Restrict to these namespaces. Default: all in the bundle. */
  namespaces?: readonly number[];
  /** Snippet width in tokens. Default 28. */
  snippetTokens?: number;
}

export interface SearchResult {
  title: string;
  ns: number;
  /** A short extract around the match, or the head of the article for a title hit. */
  snippet: string;
  /**
   * bm25 score, lower is better. `EXACT_TITLE_RANK` for a title or redirect hit.
   * Always finite: this crosses a JSON boundary on its way to the model.
   */
  rank: number;
  /** True when the query resolved to this page's title (possibly via a redirect). */
  exactTitle?: true;
  /** Set when the query matched a redirect that led here. */
  redirectedFrom?: string;
  /**
   * Coordinates recorded on the wiki page (templates/infoboxes). These are
   * wiki-reference notes, not a live observation and not proof anything is at
   * that spot now. Absent when the page has none, or when the bundle predates
   * the coordinate channel. Every number is finite: this crosses a JSON
   * boundary on its way to the model.
   */
  coords?: { zone?: string; x: number; y: number }[];
}

/** Sorts ahead of any bm25 score and survives JSON.stringify. */
export const EXACT_TITLE_RANK = -1e9;

const TOKEN = /[\p{L}\p{N}][\p{L}\p{N}'_-]*/gu;

/** Build a safe FTS5 MATCH expression: every token quoted, implicit AND. */
export function toMatchExpression(query: string): string | null {
  const tokens = query.match(TOKEN);
  if (tokens === null || tokens.length === 0) return null;
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" ");
}

/** MediaWiki titles are first-letter capitalised and use spaces, not underscores. */
export function normaliseTitle(title: string): string {
  const t = title.replace(/_/g, " ").trim();
  if (t.length === 0) return t;
  return t[0]!.toUpperCase() + t.slice(1);
}

interface PageRow {
  id: number;
  title: string;
  ns: number;
  text: string;
}

function headSnippet(text: string, chars = 280): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= chars ? flat : `${flat.slice(0, chars)} …`;
}

interface CoordRow {
  zone: string | null;
  x: number;
  y: number;
}

/**
 * Coordinates for a page, or undefined when it has none. Returns undefined
 * (not a throw) on a pre-coords bundle, so a stale bundle read directly by the
 * runner degrades to "no coords" rather than crashing search. Only finite,
 * in-range triples survive; JSON stays safe.
 */
function coordsForPage(
  db: Database,
  hasCoords: boolean,
  pageId: number,
): SearchResult["coords"] {
  if (!hasCoords) return undefined;
  const rows = db
    .query<CoordRow, [number]>("SELECT zone, x, y FROM page_coords WHERE page_id = ? LIMIT 8")
    .all(pageId);
  const coords = rows
    .filter((r) => Number.isFinite(r.x) && Number.isFinite(r.y))
    .map((r) => (r.zone !== null && r.zone !== "" ? { zone: r.zone, x: r.x, y: r.y } : { x: r.x, y: r.y }));
  return coords.length > 0 ? coords : undefined;
}

/**
 * Resolve a title through the redirect table (bounded hops) and return the page.
 */
function resolveTitle(db: Database, title: string): { page: PageRow; via: string | null } | null {
  const pageStmt = db.query<PageRow, [string]>(
    "SELECT id, title, ns, text FROM pages WHERE title = ? COLLATE NOCASE LIMIT 1",
  );
  const redirectStmt = db.query<{ target: string }, [string]>(
    "SELECT target FROM redirects WHERE source = ? COLLATE NOCASE LIMIT 1",
  );

  // Titles in the dump carry their namespace prefix, so a bare quest name has to
  // be tried against "Quest:" too before giving up.
  const normalised = normaliseTitle(title);
  const candidates =
    normalised.includes(":") || normalised.length === 0
      ? [normalised]
      : [normalised, `Quest:${normalised}`, `Category:${normalised}`, `Portal:${normalised}`];

  for (const candidate of candidates) {
    let current = candidate;
    let via: string | null = null;
    for (let hop = 0; hop < 6; hop++) {
      const page = pageStmt.get(current);
      if (page !== null) return { page, via };
      const redirect = redirectStmt.get(current);
      if (redirect === null) break;
      via = current;
      current = normaliseTitle(redirect.target);
    }
  }
  return null;
}

/**
 * Search the bundle. Never throws on a malformed query: an unparseable query
 * simply yields no FTS results.
 */
export function searchReference(
  db: Database,
  query: string,
  opts: SearchOptions = {},
): SearchResult[] {
  const limit = Math.max(1, Math.min(opts.limit ?? 8, 50));
  const snippetTokens = Math.max(8, Math.min(opts.snippetTokens ?? 28, 64));
  const namespaces = opts.namespaces;
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  const hasCoords = bundleHasCoords(db);

  const direct = resolveTitle(db, query);
  if (direct !== null && (namespaces === undefined || namespaces.includes(direct.page.ns))) {
    seen.add(direct.page.title);
    const coords = coordsForPage(db, hasCoords, direct.page.id);
    results.push({
      title: direct.page.title,
      ns: direct.page.ns,
      snippet: headSnippet(direct.page.text),
      rank: EXACT_TITLE_RANK,
      exactTitle: true,
      ...(direct.via !== null ? { redirectedFrom: direct.via } : {}),
      ...(coords !== undefined ? { coords } : {}),
    });
  }

  const match = toMatchExpression(query);
  if (match !== null) {
    // A model asks in sentences. Try the precise AND first; if nothing matches,
    // fall back to OR so a long question still finds the article.
    const expressions = match.includes(" ") ? [match, match.replaceAll(" ", " OR ")] : [match];
    const nsFilter =
      namespaces !== undefined && namespaces.length > 0
        ? ` AND p.ns IN (${namespaces.map(() => "?").join(",")})`
        : "";
    const sql = `
      SELECT p.id AS id,
             p.title AS title,
             p.ns AS ns,
             snippet(pages_fts, 1, '', '', ' … ', ${snippetTokens}) AS snippet,
             bm25(pages_fts, 8.0, 1.0) AS rank
      FROM pages_fts
      JOIN pages p ON p.id = pages_fts.rowid
      WHERE pages_fts MATCH ?${nsFilter}
      ORDER BY rank, p.id
      LIMIT ?
    `;
    const params: (string | number)[] = [match];
    if (nsFilter !== "") params.push(...(namespaces as readonly number[]));
    params.push(limit + results.length + 4);
    const stmt = db.query<
      { id: number; title: string; ns: number; snippet: string; rank: number },
      (string | number)[]
    >(sql);
    for (const expression of expressions) {
      let matched = 0;
      params[0] = expression;
      try {
        for (const row of stmt.all(...params)) {
          matched++;
          if (seen.has(row.title)) continue;
          seen.add(row.title);
          const coords = coordsForPage(db, hasCoords, row.id);
          results.push({
            title: row.title,
            ns: row.ns,
            snippet: row.snippet.replace(/\s+/g, " ").trim(),
            rank: row.rank,
            ...(coords !== undefined ? { coords } : {}),
          });
          if (results.length >= limit) break;
        }
      } catch {
        // A query FTS5 cannot parse yields no matches rather than an error.
      }
      // Only widen to OR when the precise expression found nothing at all.
      if (matched > 0) break;
    }
  }

  return results.slice(0, limit);
}

/**
 * Open a bundle read-only. Fails loudly on a bundle built before the coordinate
 * channel (schema < 2): the `page_coords` table is a schema change, and a stale
 * bundle would silently advertise an empty coords channel. Rebuild with:
 *   bun wiki/src/build.ts data/wiki/<dump>.7z --out data/wiki/bundle.sqlite
 */
export function openBundle(path: string = DEFAULT_BUNDLE_PATH): Database {
  const db = new Database(path, { readonly: true });
  if (!bundleHasCoords(db)) {
    db.close();
    throw new Error(
      `wiki bundle at ${path} predates the coordinate channel (no page_coords table). ` +
        `Rebuild it: bun wiki/src/build.ts data/wiki/<dump>.7z --out ${path}`,
    );
  }
  return db;
}

if (import.meta.main) {
  const argv = Bun.argv.slice(2);
  let dbPath = DEFAULT_BUNDLE_PATH;
  let limit = 8;
  const terms: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--db") dbPath = argv[++i] ?? dbPath;
    else if (arg === "--limit") limit = Number.parseInt(argv[++i] ?? "8", 10);
    else terms.push(arg);
  }
  if (terms.length === 0) {
    console.error("usage: bun wiki/src/search.ts [--db path] [--limit n] <query>");
    process.exit(2);
  }
  const db = openBundle(dbPath);
  const hits = searchReference(db, terms.join(" "), { limit });
  if (hits.length === 0) console.log("(no results)");
  for (const hit of hits) {
    const via = hit.redirectedFrom !== undefined ? ` (via ${hit.redirectedFrom})` : "";
    console.log(`\n# ${hit.title}  [ns ${hit.ns}, rank ${hit.rank.toFixed(3)}]${via}`);
    console.log(hit.snippet);
  }
  db.close();
}
