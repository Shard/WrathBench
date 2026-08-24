#!/usr/bin/env bun
/**
 * Search over the wiki bundle. This is what the runner's `search_reference`
 * MCP tool calls.
 *
 * Results come back in bands, and only within a band does bm25 decide:
 *
 *   0. exact title — the query resolved to a page title, via redirects.
 *   1. entity id — the query named an id and a page states that id in its
 *      infobox (`page_ids`, bundle schema 3).
 *   2. title tokens — every word of the query appears in the page title.
 *   3. body — the words appear somewhere in the text.
 *
 * Out-of-game pages (patch notes, addon/UI documentation, boxed products,
 * real-world topics) used to be a fifth band, labelled and sunk. They are no
 * longer in the bundle at all: `classifyMetaPage` runs at build time and the
 * build does not emit them (ADR-0040).
 *
 * The bands exist because bm25 alone put a page whose only connection to
 * "quest 783" was the digits 783 inside an arithmetic example above the quest
 * page itself (FOLLOW-UPS 25). Numbers are the sharp case: a numeric token that
 * the query marks as an id ("783", "quest 783", "npc entry 721") is looked up
 * against id fields only and is never handed to the full-text index, so body
 * prose can no longer answer an id question.
 */

import { Database } from "bun:sqlite";
import { DEFAULT_BUNDLE_PATH, bundleHasCoords, bundleHasIds, bundleHasQuest } from "./bundle";
import type { IdKind } from "./ids";
import type { WikiQuest } from "./quests";

export interface SearchOptions {
  /** Max results. Default 8. */
  limit?: number;
  /** Restrict to these namespaces. Default: all in the bundle. */
  namespaces?: readonly number[];
  /** Snippet width in tokens. Default 28. */
  snippetTokens?: number;
  /**
   * Whether wiki-recorded coordinates are served. Default true. When false
   * the `coords` field is never set and coordinate-shaped pairs in snippet
   * prose are redacted (`stripProseCoords`): a names-first run must not be
   * able to read an answer key off the page text either.
   */
  coords?: boolean;
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
  /** Set when the page was found because it states this entity id. */
  matchedId?: { kind: IdKind; id: number };
  /**
   * Coordinates recorded on the wiki page (templates/infoboxes). These are
   * wiki-reference notes, not a live observation and not proof anything is at
   * that spot now. Absent when the page has none, or when the bundle predates
   * the coordinate channel. Every number is finite: this crosses a JSON
   * boundary on its way to the model.
   */
  coords?: { zone?: string; x: number; y: number }[];
  /**
   * What the page's quest infobox states about the quest: the NPC that gives
   * it, the NPC it is turned in to, and the category (usually a zone). Absent
   * when the page is not a quest page, or when the bundle predates the channel.
   *
   * `end` absent means the page does not say — never that the ender is the
   * giver. Giver and ender differ often enough that guessing is the bug this
   * field exists to fix (night-report 2026-08-23 §2a).
   */
  quest?: WikiQuest;
}

/** Sorts ahead of any bm25 score and survives JSON.stringify. */
export const EXACT_TITLE_RANK = -1e9;

/** An id hit: below an exact title, above anything bm25 scored. Finite, for JSON. */
export const ID_MATCH_RANK = -5e8;

/**
 * Result bands. Ordering is by band first, bm25 second; `rank` is what the
 * caller displays, `band` is what sorts.
 */
const BAND = { title: 0, id: 1, titleTokens: 2, body: 3 } as const;

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

/**
 * A coordinate-looking pair in prose: two numbers in 0–100 (optionally with
 * decimals) separated by a comma or slash, inside round or square brackets,
 * e.g. `(48.2, 42.1)`, `[48, 42]`, `(48.2/42.1)`. Templates and infoboxes are
 * already stripped at build time (`stripWikitext`), so this is what survives
 * into the stored text: hand-written prose like "at (48, 42)". Best-effort —
 * a pair written without brackets is not matched, and a dotted version number
 * in brackets would be.
 */
const PROSE_COORDS =
  /[(\[]\s*(?:100|\d{1,2})(?:\.\d+)?\s*[,/]\s*(?:100|\d{1,2})(?:\.\d+)?\s*[)\]]/g;

/** Redact coordinate-shaped pairs from snippet prose (see `PROSE_COORDS`). */
export function stripProseCoords(text: string): string {
  return text.replace(PROSE_COORDS, "(coords withheld)");
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

interface QuestRow {
  start: string | null;
  end: string | null;
  category: string | null;
}

/**
 * The quest infobox facts for a page, or undefined when it has none. Returns
 * undefined (not a throw) on a pre-quest bundle, so a stale bundle degrades to
 * "no quest channel" rather than crashing search.
 */
function questForPage(db: Database, hasQuest: boolean, pageId: number): WikiQuest | undefined {
  if (!hasQuest) return undefined;
  const row = db
    .query<QuestRow, [number]>(
      "SELECT start, end, category FROM page_quest WHERE page_id = ? LIMIT 1",
    )
    .get(pageId);
  if (row === null) return undefined;
  const quest: WikiQuest = {};
  if (row.start !== null && row.start !== "") quest.start = row.start;
  if (row.end !== null && row.end !== "") quest.end = row.end;
  if (row.category !== null && row.category !== "") quest.category = row.category;
  return quest.start === undefined && quest.end === undefined && quest.category === undefined
    ? undefined
    : quest;
}

/**
 * The one line of prose that puts giver and ender in front of the model.
 *
 * It leads the snippet rather than riding beside it because the snippet is
 * what the runner renders, and because a model that reads "turn in to" before
 * the quest text does not have to ask a second question. When the page does not
 * state an ender the line says so explicitly: silence there used to read as
 * "turn it back in to whoever gave it", which is the failure being fixed.
 */
export function questPrefix(quest: WikiQuest | undefined): string {
  if (quest === undefined) return "";
  const parts: string[] = [];
  if (quest.start !== undefined) parts.push(`starts at ${quest.start}`);
  if (quest.end !== undefined) parts.push(`turn in to ${quest.end}`);
  else if (quest.start !== undefined) parts.push("turn-in NPC not stated on this page");
  if (quest.category !== undefined) parts.push(`category ${quest.category}`);
  if (parts.length === 0) return "";
  return `[quest infobox: ${parts.join("; ")}]\n`;
}

/**
 * Resolve a title through the redirect table (bounded hops) and return the page.
 */
function resolveTitle(db: Database, title: string): { page: PageRow; via: string | null } | null {
  const pageStmt = db.query<PageRow, [string]>(
    // A case-insensitive title can match more than one row, and on a bundle
    // built before the page-block merge it can match a stale duplicate too. The
    // dump is newest-first, so the block holding the newest revision was written
    // first and holds the lowest id: ascending id picks the right row.
    "SELECT id, title, ns, text FROM pages WHERE title = ? COLLATE NOCASE ORDER BY id LIMIT 1",
  );
  const redirectStmt = db.query<{ target: string }, [string]>(
    "SELECT target FROM redirects WHERE source = ? COLLATE NOCASE ORDER BY source LIMIT 1",
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
 * Words that mark the number beside them as an entity id, and the kind they
 * imply. `undefined` means "an id, kind unknown" — `entry`, `id`, `number`.
 */
const ID_WORDS: Record<string, IdKind | undefined> = {
  quest: "quest",
  quests: "quest",
  questid: "quest",
  npc: "npc",
  npcs: "npc",
  mob: "npc",
  mobs: "npc",
  creature: "npc",
  creatures: "npc",
  item: "item",
  items: "item",
  object: "object",
  objects: "object",
  spell: "spell",
  spells: "spell",
  entry: undefined,
  entries: undefined,
  id: undefined,
  ids: undefined,
  number: undefined,
};

const NUMERIC = /^\d{1,9}$/;

/** One numeric token the query asked about as an id. */
export interface QueryId {
  id: number;
  /** Kind the query named, when it named one. */
  kind?: IdKind;
}

export interface ParsedQuery {
  /** Ids to look up in id-shaped fields. Never handed to the text index. */
  ids: QueryId[];
  /** What is left of the query for full-text search; "" when nothing is. */
  text: string;
}

/**
 * Split a query into id lookups and text.
 *
 * A numeric token becomes an id lookup when it is the whole query, when the
 * nearest preceding non-numeric token is an id word ("quest 783",
 * "entry 721 Northshire", "npc entry 299 69"), or when the number opens the
 * query and an id word follows it ("721 npc entry Northshire"). A following id
 * word counts only in that opening position, deliberately — "level 5 quests"
 * is a request for level-5 quests, not for entity 5. The id word is consumed with the number,
 * since leaving "quest" in the text query would match every quest page; a
 * kindless word ("entry", "id") takes its kind from the word before it, which
 * is how models actually write it ("npc entry 197").
 */
export function parseIdQuery(query: string): ParsedQuery {
  const tokens = query.match(TOKEN) ?? [];
  const isNum = tokens.map((t) => NUMERIC.test(t));
  const lower = tokens.map((t) => t.toLowerCase());
  const isIdWord = lower.map((t) => t in ID_WORDS);
  const consumed = new Array<boolean>(tokens.length).fill(false);
  const ids: QueryId[] = [];

  /** Nearest non-numeric neighbour in `step` direction, or -1. */
  const neighbour = (from: number, step: number): number => {
    for (let i = from + step; i >= 0 && i < tokens.length; i += step) {
      if (!isNum[i]) return i;
    }
    return -1;
  };

  for (let i = 0; i < tokens.length; i++) {
    if (!isNum[i]) continue;
    let qualifier = -1;
    let after = -1;
    if (tokens.length > 1) {
      const left = neighbour(i, -1);
      const right = neighbour(i, 1);
      if (left >= 0 && isIdWord[left]) qualifier = left;
      else if (left < 0 && right >= 0 && isIdWord[right]) {
        // The number opens the query: "721 npc entry Northshire". Only here is
        // a *following* id word allowed to claim it — "level 5 quests" must
        // stay a search for level-5 quests.
        qualifier = right;
        after = right;
      } else continue; // an ordinary number, not an id
    }
    const value = Number.parseInt(tokens[i]!, 10);
    if (!Number.isInteger(value) || value <= 0) continue;
    consumed[i] = true;
    let kind: IdKind | undefined;
    if (qualifier >= 0) {
      consumed[qualifier] = true;
      kind = ID_WORDS[lower[qualifier]!];
      if (kind === undefined && qualifier > 0 && isIdWord[qualifier - 1]) {
        // "npc entry 197": the kindless word takes its kind from the one before.
        kind = ID_WORDS[lower[qualifier - 1]!];
        if (kind !== undefined) consumed[qualifier - 1] = true;
      }
      // "721 npc entry …": the id words trailing the number all belong to it.
      for (let j = after + 1; after >= 0 && j < tokens.length && isIdWord[j]; j++) consumed[j] = true;
    }
    if (!ids.some((e) => e.id === value && e.kind === kind)) {
      ids.push(kind === undefined ? { id: value } : { id: value, kind });
    }
  }

  if (ids.length === 0) return { ids: [], text: query };
  const text = tokens.filter((_t, i) => !consumed[i]).join(" ");
  return { ids, text };
}

/** True when every token of `text` appears in `title` (case-insensitive). */
function titleCoversTokens(title: string, text: string): boolean {
  const tokens = text.match(TOKEN);
  if (tokens === null || tokens.length === 0) return false;
  const haystack = title.toLowerCase();
  return tokens.every((t) => haystack.includes(t.toLowerCase()));
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
  const serveCoords = opts.coords ?? true;
  const hasCoords = serveCoords && bundleHasCoords(db);
  const hasIds = bundleHasIds(db);
  const hasQuest = bundleHasQuest(db);
  const snip = (text: string): string => (serveCoords ? text : stripProseCoords(text));
  const parsed = parseIdQuery(query);
  const inNamespace = (ns: number): boolean => namespaces === undefined || namespaces.includes(ns);

  const banded: { band: number; result: SearchResult }[] = [];
  const seen = new Set<string>();
  const push = (band: number, result: SearchResult): void => {
    if (seen.has(result.title)) return;
    seen.add(result.title);
    banded.push({ band, result });
  };

  // --- band 0: the query is a page title (possibly through redirects).
  // Tried on the query as written, then on the query with its id tokens
  // removed, so "A Threat Within quest 783" still resolves to the article.
  for (const candidate of parsed.text !== query && parsed.text !== "" ? [query, parsed.text] : [query]) {
    const direct = resolveTitle(db, candidate);
    if (direct === null || !inNamespace(direct.page.ns)) continue;
    const coords = coordsForPage(db, hasCoords, direct.page.id);
    const quest = questForPage(db, hasQuest, direct.page.id);
    push(BAND.title, {
      title: direct.page.title,
      ns: direct.page.ns,
      snippet: snip(questPrefix(quest) + headSnippet(direct.page.text)),
      rank: EXACT_TITLE_RANK,
      exactTitle: true,
      ...(direct.via !== null ? { redirectedFrom: direct.via } : {}),
      ...(coords !== undefined ? { coords } : {}),
      ...(quest !== undefined ? { quest } : {}),
    });
    break;
  }

  // --- band 1: entity ids, matched only against id-shaped fields.
  // Bounded: a low id can be stated by many pages, and an unbounded id band
  // would push the text half of a query like "Example Zone npc entry 12" off
  // the slate entirely. When the query is nothing but ids, they may have it all.
  let idBudget = parsed.text === "" ? limit : Math.max(1, Math.ceil(limit / 2));
  if (hasIds && parsed.ids.length > 0) {
    const stmt = db.query<PageRow & { kind: string; entity_id: number }, [number]>(`
      SELECT p.id AS id, p.title AS title, p.ns AS ns, p.text AS text,
             i.kind AS kind, i.id AS entity_id
      FROM page_ids i JOIN pages p ON p.id = i.page_id
      WHERE i.id = ?
      ORDER BY p.id
      LIMIT 32
    `);
    for (const wanted of parsed.ids) {
      // A page whose kind matches the word the query used comes first; an id
      // stated under another kind still beats a body match.
      const rows = stmt.all(wanted.id).filter((r) => inNamespace(r.ns));
      const ordered = [
        ...rows.filter((r) => wanted.kind !== undefined && r.kind === wanted.kind),
        ...rows.filter((r) => wanted.kind === undefined || r.kind !== wanted.kind),
      ];
      for (const row of ordered) {
        if (idBudget <= 0) break;
        idBudget--;
        const coords = coordsForPage(db, hasCoords, row.id);
        const quest = questForPage(db, hasQuest, row.id);
        push(BAND.id, {
          title: row.title,
          ns: row.ns,
          snippet: snip(questPrefix(quest) + headSnippet(row.text)),
          rank: ID_MATCH_RANK,
          matchedId: { kind: row.kind as IdKind, id: row.entity_id },
          ...(coords !== undefined ? { coords } : {}),
          ...(quest !== undefined ? { quest } : {}),
        });
      }
    }
  }

  // --- bands 2 and 3: full text, over the query minus its id tokens.
  const match = parsed.text === "" ? null : toMatchExpression(parsed.text);
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
    // Deliberately far wider than `limit`: the title band is decided here, in
    // TypeScript, and a title match sitting twentieth by bm25 has to be in the
    // candidate set to be promoted at all.
    params.push(Math.min(200, limit * 4 + 16));
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
          const coords = coordsForPage(db, hasCoords, row.id);
          const quest = questForPage(db, hasQuest, row.id);
          push(titleCoversTokens(row.title, parsed.text) ? BAND.titleTokens : BAND.body, {
            title: row.title,
            ns: row.ns,
            snippet: snip(questPrefix(quest) + row.snippet.replace(/\s+/g, " ").trim()),
            rank: row.rank,
            ...(coords !== undefined ? { coords } : {}),
            ...(quest !== undefined ? { quest } : {}),
          });
        }
      } catch {
        // A query FTS5 cannot parse yields no matches rather than an error.
      }
      // Only widen to OR when the precise expression found nothing at all.
      if (matched > 0) break;
    }
  }

  // Stable within a band: bm25 order for text, insertion order for the rest.
  return banded
    .map((entry, index) => ({ ...entry, index }))
    .sort((a, b) => a.band - b.band || a.result.rank - b.result.rank || a.index - b.index)
    .slice(0, limit)
    .map((entry) => entry.result);
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
