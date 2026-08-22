# wiki

Turns a locally held wowwiki dump into a searchable sqlite bundle, and provides the
search function behind the runner's `search_reference` MCP tool.

The dump and the bundle are Blizzard-derived. Both live under `data/`, which is
gitignored at the directory level, and neither is ever committed or published.
Every contributor builds their own bundle from their own dump.

## Build

```
bun wiki/src/build.ts data/wiki/<dump>.7z [--out data/wiki/bundle.sqlite]
```

The archive is streamed through `7z x -so`; the 24 GB XML is never written to disk.
A plain `.xml` path also works. `--max-pages n` stops early, which is useful for a
quick smoke build.

The build writes to a hidden temp file beside the destination and renames it into
place at the end, so it is idempotent: a rebuild either replaces the bundle wholly
or leaves the previous one untouched. There is no resume; a full pass is minutes,
not hours.

## What ends up in the bundle

- Namespaces main (0), Category (14), Portal (116) and Quest (118). Talk, User,
  File, Template, Forum, Guild, Server and the semantic-mediawiki namespaces are
  dropped without being parsed.
- One row per page, holding the **newest** revision. The dump is full history, so
  most of its bulk is revisions that never reach the bundle.
- Redirects are not pages. Their source and target go in `redirects`, so a search
  for an old or alternate name still lands on the article.
- Wikitext is reduced to plain text: templates, tables, refs, comments and file
  links are removed, `[[link|label]]` becomes `label`, headings become plain lines,
  whitespace is collapsed. Most infobox data lives in templates and is therefore
  lost. The consumer is a model reading search results, not a browser.
- Coordinates are the exception: before the strip runs, `extractCoords` lifts
  wiki-recorded map positions off the raw wikitext (`{{coords|x|y|zone}}`
  templates and infobox `loc`/`location` fields) into the `page_coords` table.
  These are wiki-derived reference notes — what an editor wrote on the page — not
  a live observation and not proof anything is at that spot now. Nothing here
  reads the AzerothCore DB, DBC tables or Questie; it is all deterministic parsing
  of the wikitext.
- Entity ids are the other exception, and for the same reason: `extractIds` lifts
  the numeric ids a page states about itself (`{{questbox|…|id=783}}`,
  `{{npcbox|…|id=721}}`, `|itemid=`, `|npcid=`, `|questid=`, `|entry=`) off the raw
  wikitext into `page_ids`, tagged with the kind the enclosing template implies.
  Without this an id can only be matched against body prose, and a page whose
  arithmetic happens to contain the digits outranks the entity page (FOLLOW-UPS
  25). Same provenance rule: deterministic parsing of wikitext, nothing else.

## Schema

```sql
pages       (id INTEGER PRIMARY KEY, title TEXT, ns INTEGER, text TEXT, text_len INTEGER)
redirects   (source TEXT PRIMARY KEY, target TEXT, ns INTEGER)
page_coords (page_id INTEGER, zone TEXT, x REAL, y REAL, raw TEXT)  -- wiki-derived, one row per coord
page_ids    (page_id INTEGER, kind TEXT, id INTEGER)  -- quest/npc/item/object/spell/unknown
meta        (key TEXT PRIMARY KEY, value TEXT)   -- source, built_at, counts, build_ms, schema_version
pages_fts   FTS5 over (title, text), external content over pages
```

`page_coords` holds the wiki-recorded coordinates described above, keyed to
`pages.id`; `raw` keeps the source fragment for provenance while search returns
only the `{zone, x, y}` triple.

`page_coords` arrived with `schema_version` 2. It is a schema change, so
`openBundle` **fails closed** on an older bundle that lacks the table rather than
silently advertising an empty coordinate channel. Rebuild:

```
bun wiki/src/build.ts data/wiki/<dump>.7z --out data/wiki/bundle.sqlite
```

(A consumer that opens the sqlite file directly, bypassing `openBundle`, still
degrades safely: `searchReference` treats a missing `page_coords` as "no coords".)

`page_ids` arrived with `schema_version` 3 and deliberately does **not** fail
closed: a live episode must not lose `search_reference` because the deployed
bundle is a version behind. `bundleHasIds` reports the table's absence,
`searchReference` answers an id query with nothing rather than with body-text
noise, and the runner's tool result says the bundle has no id index. Ids resolve
after the next rebuild; the build is reproducible, so a rebuild from the same
dump gives the same rows.

FTS5 is required and checked before the stream starts; a sqlite build without it
fails the build loudly rather than producing an unindexed bundle.

## Search

```ts
import { openBundle, searchReference } from "@wrathbench/wiki";

const db = openBundle();                       // data/wiki/bundle.sqlite, read-only
searchReference(db, "example quest alpha", { limit: 8, namespaces: [0, 118] });
// -> { title, ns, snippet, rank, exactTitle?, redirectedFrom?, matchedId?, coords? }[]
//    coords?: { zone?, x, y }[] — wiki-reference positions, not a live observation
//    matchedId?: { kind, id }   — the page states this id in an infobox field
```

Results come back in bands, and only inside a band does `bm25` decide:

1. **exact title** — the query resolved to a page title, following redirects and
   trying the namespace prefixes. `exactTitle: true`, `rank: EXACT_TITLE_RANK`.
2. **entity id** — the query named an id and a page states it in `page_ids`.
   `matchedId`, `rank: ID_MATCH_RANK`. A page whose kind matches the word the
   query used ("quest 783") comes before one that states the same number under
   another kind.
3. **title tokens** — every word of the query appears in the page title.
4. **body** — the words appear somewhere in the text.

`parseIdQuery` decides what counts as an id. A numeric token is an id lookup when
it is the whole query, when an id word precedes it (`quest 783`, `npc entry 197`,
`entry 721 Northshire`), or when the number opens the query and an id word follows
(`721 npc entry Northshire`); the id word is consumed with it, since leaving
"quest" in the text query matches every quest page. `level 5 quests` is left alone.
An id token is **never** handed to the full-text index, so body prose can no longer
answer an id question.

The full-text candidate set is fetched far wider than `limit` before the bands are
applied, because the title band is decided in TypeScript: a title match sitting
twentieth by `bm25` has to be in the candidate set to be promoted at all.

Query text is tokenised and quoted, so no user string can be an FTS5 syntax error,
and a multi-word query that ANDs to nothing is retried once as an OR so a model
asking in sentences still gets results. Every field is JSON-safe: the runner hands
these straight to the model.

For manual poking:

```
bun wiki/src/search.ts [--db path] [--limit n] <query>
```

## Tests

`bun test wiki/` covers the streaming parser, the wikitext stripper, search, and an
end-to-end build. All fixtures are synthetic and invented; no dump or bundle is
needed to run them, and no game text appears in this directory.
