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

## Schema

```sql
pages       (id INTEGER PRIMARY KEY, title TEXT, ns INTEGER, text TEXT, text_len INTEGER)
redirects   (source TEXT PRIMARY KEY, target TEXT, ns INTEGER)
page_coords (page_id INTEGER, zone TEXT, x REAL, y REAL, raw TEXT)  -- wiki-derived, one row per coord
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

FTS5 is required and checked before the stream starts; a sqlite build without it
fails the build loudly rather than producing an unindexed bundle.

## Search

```ts
import { openBundle, searchReference } from "@wrathbench/wiki";

const db = openBundle();                       // data/wiki/bundle.sqlite, read-only
searchReference(db, "example quest alpha", { limit: 8, namespaces: [0, 118] });
// -> { title, ns, snippet, rank, exactTitle?, redirectedFrom?, coords? }[]
//    coords?: { zone?, x, y }[] — wiki-reference positions, not a live observation
```

A query is first resolved as a title, trying the bare name and then the namespace
prefixes, and following redirects; that hit, if any, comes first with
`exactTitle: true` and `rank: EXACT_TITLE_RANK`. Then FTS5 `MATCH` ranked by `bm25`
with the title column weighted up. Query text is tokenised and quoted, so no user
string can be an FTS5 syntax error, and a multi-word query that ANDs to nothing is
retried once as an OR so a model asking in sentences still gets results. Every field
is JSON-safe: the runner hands these straight to the model.

For manual poking:

```
bun wiki/src/search.ts [--db path] [--limit n] <query>
```

## Tests

`bun test wiki/` covers the streaming parser, the wikitext stripper, search, and an
end-to-end build. All fixtures are synthetic and invented; no dump or bundle is
needed to run them, and no game text appears in this directory.
