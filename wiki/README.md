# wiki

Turns a locally held wowwiki dump into a searchable sqlite bundle, and provides the
search function behind the runner's `search_reference` MCP tool.

The dump and the bundle are Blizzard-derived. Both live under `data/`, which is
gitignored at the directory level, and neither is ever committed or published.
Every contributor builds their own bundle from their own dump.

## Build

```
bun wiki/src/build.ts data/wiki/<dump>.7z [--out data/wiki/bundle.sqlite]
                                          [--era-cutoff 2010-10-12T00:00:00Z]
                                          [--no-canary]
```

The archive is streamed through `7z x -so`; the 24 GB XML is never written to disk.
A plain `.xml` path also works. `--max-pages n` stops early, which is useful for a
quick smoke build — with the caveat that redirects are resolved against the pages
actually seen, so a truncated run drops every redirect whose target sits past the
stopping point and its `redirects` count means nothing. `--era-cutoff` moves the revision line the bundle is taken at
(below); it must be a full ISO-8601 UTC instant, and a malformed one is rejected
before the stream starts rather than quietly dropping every page.

The build writes to a hidden temp file beside the destination and renames it into
place at the end, so it is idempotent: a rebuild either replaces the bundle wholly
or leaves the previous one untouched. There is no resume; a full pass is minutes,
not hours.

**The canary runs before that rename.** `wiki/src/canary.ts` holds a fixed list
of titles a patch-3.3.5a reference cannot be missing — the ten capitals, the
eight racial starting zones, the classic and Wrath zones an over-broad era rule
reaches first, and the low-level dungeons Cataclysm moved out from under their
own names — and the build fails, naming every missing one, rather than
renaming a bundle that has lost this world. Counters cannot catch a rule that is
one word too broad; they all add up either way. This is what would have caught
the drop of Stormwind City and Durotar (FOLLOW-UPS 49). Redirects count: a title
resolves directly or through the chain. `--no-canary` skips it, and is the
default for a `--max-pages` smoke build, which never reaches most of the dump;
`--canary` forces it back on.

`wiki/src/verify.ts` is the deeper, operator-run gate on a bundle that is already
written — the same required titles, a list of Cataclysm-or-later titles that must
**not** be there, and phrase pairs on named pages (no `flooded` on Thousand
Needles; `Stonewrought Dam` on Loch Modan). It exits non-zero with a report:

```
bun wiki/src/verify.ts [--db data/wiki/bundle.sqlite]
```

Every entry in both lists was checked against the dump before it was added. A
title that also existed pre-2010 as lore — Mount Hyjal, Tol Barad, Grim Batol,
Kul Tiras, Zandalar, Worgen, Goblin — is deliberately not a forbidden title, and
a phrase pair the wiki's own 2010 editors had already broken is not a pair: a
gate that cries wolf is a gate that gets skipped.

## What ends up in the bundle

The bundle is a concise reference for **this world**: patch 3.3.5a, Wrath of the
Lich King. Nothing in it is labelled by era, because content that is not 3.3.5 is
not in it — the build drops it, by deterministic rules, with a count in `meta`
for every rule. Removal is verifiable by rebuilding from the same dump. See
ADR-0040.

- Namespaces main (0), Category (14), Portal (116) and Quest (118). Talk, User,
  File, Template, Forum, Guild, Server and the semantic-mediawiki namespaces are
  dropped without being parsed.
- One row per surviving page, built from **two** revisions of it. The prose is
  the newest revision saved before the era cutoff — 2010-10-12, patch 4.0.1 — so
  what the model reads describes a world at most one patch from 3.3.5a instead
  of the 2020 one. Everything structured (coordinates, entity ids, the quest
  infobox) still comes off the **newest** revision, where a decade of
  corrections lives and where 30% of the coordinates only exist.
- The era revision has to survive two hygiene rules to win: a revision where the
  page was a `#REDIRECT` is not prose, and a revision that was immediately
  reverted — the revision right after it restored a sha1 the page already had —
  is not what the page said. Otherwise the newest pre-cutoff revision wins,
  whatever order the dump lists revisions in.
- The dump is full history, so most of its bulk is revisions that never reach
  the bundle. A page with more than 50 revisions is exported as several
  consecutive `<page>` blocks of 50, so a block is not a page: the parser holds
  a page open until the (title, ns) key changes and merges its blocks, and the
  build asserts `pages` holds one row per (title, ns) — recorded as
  `pages_distinct_keys` in `meta` — so a regression here fails the build instead
  of quietly indexing stale text beside current text.
- Redirects are decided by the same Wrath snapshot: a page that was a redirect
  at the cutoff is a redirect here whatever it became later, and one that was an
  article then is an article here even if it was merged away in 2014. Source and
  target go in `redirects`, so a search for an old or alternate name still lands
  on the article — unless the chain does not end at a surviving page, in which
  case the redirect is dropped with its target (`redirects_dropped_dangling`).
- **Names survive page moves.** A MediaWiki move carries the page's history to
  the destination, so after Cataclysm took the bare title of a rebuilt dungeon,
  that title holds the *new* article's revisions and is dropped here — correctly
  — while this world's article sits under `… (original)` or under another name
  entirely, and the name a character would search for is gone. Two rules put the
  name back, and neither puts the page back. First, the **newest revision** is
  read when the Wrath-snapshot one does not answer: a snapshot redirect whose
  target was itself renamed retries the newest revision's target, and a page
  that has no article here at all becomes a name when its newest revision is a
  `#REDIRECT` (`redirects_recovered_newest`). Second, a bare title with no page
  and no redirect whose **`(original)` or `(old)` sibling** is in the bundle
  becomes a redirect to it, `(original)` winning when a page has both
  (`redirects_original_sibling`). Both are candidate generation only: every
  candidate goes into the same pending list and is resolved by the same bounded
  chain walk, so a sibling that is itself only a redirect still lands, whichever
  target actually resolves is the one written, and a candidate that leads
  nowhere is dropped as dangling like any other. Out-of-game titles are the one
  exclusion — a patch archive is dropped, not demoted, so its name does not come
  back either.
- **Sections that are trimmed.** A concise reference is one a character can act
  on, so a fixed set of headings is dropped at build time, on the raw wikitext,
  heading line and body together: `external links`, `references`, `see also`,
  `patch changes`, `patches and hotfixes`, `patch history`, `patch notes`,
  `changes`, `gallery`, `videos`, `video`, `images`, `media`, `trivia`, `notes
  and trivia`, `speculation`, `quotes`, `quote`, `dialogue`, `criticism`,
  `reception`, `development`, `history`, `background`, `lore`, `in the rpg`,
  `rpg`, `in the warcraft rpg`, `in the tcg`, `tcg`, `in the manga`, `in the
  comics`, `in the novels`, `in hearthstone`, `in warcraft iii`, `in warcraft
  ii`, `in warcraft i`, `addons`, `macros`. The heading is normalised first —
  trimmed, case-folded, markup and trailing punctuation removed — and matched
  **exactly**, never as a prefix or a substring, which is the whole reason
  `changes` goes while `past changes` stays and `notes and trivia` goes while
  `notes` stays. Nothing is rewritten: a section is here in full or not at all.
  There is no keep list in the code, only the drop set, but these were
  considered and deliberately kept: `notes`, `tips`, `tactics`, `tips and
  tactics`, `strategy`, `abilities`, `drops`, `source`, `objectives`,
  `description`, `progress`, `completion`, `rewards`, `gains`, `quests`,
  `location`. They say what is there, what it does and how to get it — that is
  the whole point of the bundle. A section left with no prose after all the cuts
  and the strip is not emitted either, so a table-only `Drops` or a section the
  paragraph rule emptied never becomes an orphan heading line. `sections_trimmed`
  counts the lot and `sections_trimmed_json` breaks it down by heading, with the
  empty ones under `(empty)`; the era counters above stay separate. See ADR-0040.
- Wikitext is reduced to plain text: templates, tables, refs, comments and file
  links are removed, `[[link|label]]` becomes `label`, headings become plain lines,
  whitespace is collapsed. Most infobox data lives in templates and is therefore
  lost. The consumer is a model reading search results, not a browser.
  Brace-matching is a run at a time and by kind — `{{{param|default}}}` is a
  parameter, `}}` closes a template and `|}` a table — and an opener that is
  never closed costs its own paragraph, not the page: the strip resumes at the
  next blank line after it. Reading braces two characters at a time, and a
  repeated `<ref name="x" />` swallowed as if it opened a footnote, used to
  empty whole articles (FOLLOW-UPS 63).
- Coordinates are the exception: before the strip runs, `extractCoords` lifts
  wiki-recorded map positions off the raw wikitext (`{{coords|x|y|zone}}`
  templates and infobox `loc`/`location` fields) into the `page_coords` table.
  These are wiki-derived reference notes — what an editor wrote on the page — not
  a live observation and not proof anything is at that spot now. Nothing here
  reads the AzerothCore DB, DBC tables or Questie; it is all deterministic parsing
  of the wikitext.
- Quest giver and ender are the second exception, for the same reason: a quest
  page's `{{questbox | start=… | end=… | category=… }}` is a template, so the
  strip takes the ender's name off the page entirely. `extractQuest` lifts the
  three fields into `page_quest` before the strip. It reads only the
  named-argument infoboxes (`questbox`, `questinfo`) — `{{questlong|…}}` is a
  list-item template on index pages — and it **never infers `end` from
  `start`**: 11,013 quest pages state a giver, 6,637 state an ender, and search
  says "not stated on this page" for the rest rather than guessing the giver.
  See ADR-0029.
- Entity ids are the third exception, and for the same reason: `extractIds` lifts
  the numeric ids a page states about itself (`{{questbox|…|id=783}}`,
  `{{npcbox|…|id=721}}`, `|itemid=`, `|npcid=`, `|questid=`, `|entry=`) off the raw
  wikitext into `page_ids`, tagged with the kind the enclosing template implies.
  Without this an id can only be matched against body prose, and a page whose
  arithmetic happens to contain the digits outranks the entity page (FOLLOW-UPS
  25). Same provenance rule: deterministic parsing of wikitext, nothing else.

## What is dropped, and how it is counted

`admitPage` (`wiki/src/post-wrath.ts`) is the one page-level decision, a pure
function of the title, the namespace and the two revisions. It returns one of
five reasons, and each is a `meta` counter; the five plus `empty_pages` account
for every page the parser yields except those that were a `#REDIRECT` at the
cutoff (`pages_era_redirect`), which the build test asserts as an identity so a
page cannot be counted twice or lost quietly. The term on the right is
`pages_era_redirect` and not `redirects`, because a redirect row can now be
generated for a title that is also a counted page: a page a move emptied is
still a dropped page, and recovering its name does not put the page back.

- `pages_pre_cutoff` — has pre-cutoff prose, and either no post-Wrath signal or
  the pre-announcement protection below. Its prose is that revision.
  `pages_era_swapped` counts how many of these took their prose from an older
  timestamp than their structured fields, and
  `pages_pre_announcement_protected` how many were kept by the protection — a subset of this counter, deliberately outside the accounting
  identity, never a bucket of its own.
- `pages_post_cutoff_wrath_signal` — **no** pre-cutoff revision, but the newest
  revision says outright that its subject is Wrath-or-earlier: an infobox
  `|patch=` below 4.0, an `|expansion=` naming Wrath, the Burning Crusade or
  vanilla, or a `[[Category:Wrath of the Lich King]]`-style category. Vetoed
  when the page is WoW Classic (2019), whose patches are 1.13/1.14 and read as
  vanilla to every one of those rules. Its prose is the newest revision, because
  it is the only one there is. This is the only admission rule for late pages;
  the rule that would reach the rest is a server-side id cross-check, which the
  wiki tooling deliberately does not do (ADR-0040, FOLLOW-UPS 62).
- `pages_dropped_post_cutoff` — no prose from before the cutoff, and not admitted
  by the explicit Wrath signal above. Whether the page also names a later
  expansion does not change the reason: this world's wiki does not have the page
  at all, which is why the signalled late pages are counted here and not under
  `pages_dropped_post_wrath`. Roughly a fifth of the dump's pages; the wiki kept
  growing after 2010.
- `pages_dropped_post_wrath` — the page has pre-cutoff prose that names a later
  expansion in its title parenthetical or in a `/Cataclysm`-style **subpage
  suffix** (`Global functions/Cataclysm` is the later client's fork of the
  page), a `[[Category:…]]`, a page-banner template (`{{stub/Cataclysm}}`,
  `{{Legion-article}}`, `{{DraenorZone}}`, `{{Pandaria}}`), an infobox `|patch=`
  at 4.0 or later, or an `|expansion=` naming one — **and the page was created
  on or after the day Cataclysm was announced**: the stubs written before the
  cutoff about the expansion that was coming. In **ns 14 only**, a category
  page whose own title names a post-Wrath zone or feature counts too
  (`Category:Deepholm quests`, `Category:Uldum NPCs`, `Category:Archaeology`):
  the category rule reads the categories written *on* a page and a category page
  carries none of its own, which left 33 such stubs in a built bundle. It is
  never applied to ns 0 — Mount Hyjal, Tol Barad, Gilneas and Uldum all have
  Wrath-era lore pages under those names, which is why `verify.ts` refuses to
  list them as forbidden titles — and `Category:Burning Legion` is this world's,
  by the same `Legion`-exactly rule as everywhere else. Also counts a page whose
  prose the **era cuts** took in full — a page whose every paragraph was about a
  later world is a page about a later world, whatever its infobox says. Only the
  era cuts: a page the out-of-world trim emptied is kept, see `empty_pages`
  below.
- `pages_dropped_meta` — out-of-game: patch notes, the Lua addon API, the client
  UI, a boxed product, a real-world topic. `classifyMetaPage` classifies from
  the title alone and the build does not emit what it classifies (see Search,
  below).
- `empty_pages` — in the bundle, with no prose. A page whose body was an infobox,
  a table or a link farm is still this world's item, quest or NPC, and its title,
  its ids, its coordinates and its quest infobox are still the right answer to a
  query, so it is kept as a row with empty text. `pages_emptied_by_trim` counts
  how many of them had prose before the out-of-world trim took it — a subset,
  like the protection counter, and not part of the identity. An empty row is not
  an FTS document: indexing a title with no body behind it would let bm25 rank
  it above a page that has something to say.

**A page that predates the Cataclysm announcement is a Wrath page, and a signal
never drops it.** Stormwind City picked up `|patch=4.0.1` and a
`[[Category:Cataclysm]]` in its own pre-cutoff history, and the city is standing
in this world: 588 pages were in that pocket when it was measured at a
2010-06-01 line — capitals, starting zones, the zones Cataclysm reshaped —
against 4,859 pages the beta ramp created from scratch. What separates the two
is not the wikitext but the page's age, so `admitPage` reads the page's
**first** revision timestamp and treats `2009-08-21` (`CATACLYSM_ANNOUNCED`),
the day Cataclysm was announced at BlizzCon, as the line. It is the
announcement and not the beta because the wiki started stubbing the new
expansion the same week: 119 of that 588 were created on or after it, and most
of them were Cataclysm content sitting in a Wrath bundle (FOLLOW-UPS 64). The
section and paragraph rules still strip what they strip, so the Cataclysm
paragraph that arrived with the category still goes; the page stays. Counted as
`pages_pre_announcement_protected`.

The signals are read on the revision the prose comes from, **never** on a later
one: a Wrath zone that Cataclysm rearranged had its Cataclysm category added in
2011, and reading the newest revision would delete a zone that is standing in
this world. They are also narrow where the words collide. The Burning Legion,
the 7th Legion, `Legion's`-anything, Deathwing, Garrosh and Draenor (Outland's
own name) are all Wrath content: the category rule fires only on a category that
*is* `Legion` or starts with `Legion `, never on one that merely contains the
word — the census counts `Burning Legion` 39 times against `Legion` 29 — and
`{{Removedwithlegion}}`/`{{Removedwithcataclysm}}` are not signals at all, since
content removed later is content that exists here.

Inside a surviving page, three more levels run on the raw wikitext before the
strip (`wiki/src/wrath-only.ts`), the first two about the era and the third
about whether the section is about the world at all:

- **Sections.** A `{{cata-section}}`/`{{mists-section}}` marker or an
  `== In Cataclysm ==`-style heading drops the heading and everything under it,
  down to the next heading of the same or a shallower level. `sections_dropped`.
  Pre-Wrath eras (`{{bc-section}}`, `== The Burning Crusade ==`) are untouched.
- **Paragraphs.** A blank-line-separated block whose prose (its templates
  removed first, so an infobox field never decides) matches a narrow phrase rule
  goes: `in Cataclysm`, `with Cataclysm`, `World of Warcraft: Cataclysm`,
  `after the Shattering`, `upcoming`/`beta` beside Cataclysm, Deathwing or the
  Shattering, and `will` within 60 characters of `Cataclysm`. An adversarial
  read of a built bundle added the rules for prose that describes the later
  world **without** naming the expansion: `rated battleground(s)`, an inline
  `(Expansion: …)` tag, `playable` beside `worgen` or `goblin`, `Archaeology`
  unless a `dig site`, `team`, `unit` or `expedition` sits within 20 characters
  of it either side, and `Mastery` only when the paragraph also carries the 2010
  dev voice (`we plan`, `we're planning`, `will be a new`, `new passive stat`).
  The last two are the narrow ones and are tested both ways: a quest's
  archaeology team and the Stance Mastery and Tactical Mastery talents are all
  in this world and all survive. A handful of rules cut a single **line** rather
  than the block — `Speedbarge` is the only one today — because a block is as
  often a list of subzones as it is a paragraph, and one item of it can be the
  only later-world thing on the page. `paragraphs_dropped` counts both. A bare
  mention of Deathwing, the Legion, Draenor or Garrosh is not a rule: all four
  are in this world. Precision on a hand-checked 33-paragraph sample is about
  0.8; the residue is FOLLOW-UPS 62.
- **Out-of-world sections.** The heading drop set described above, plus every
  section left empty by any of the three cuts. `sections_trimmed` and
  `sections_trimmed_json`.

Which cut emptied a page decides what happens to it. If the **era** cuts took
all of its prose the page is dropped, counted under `pages_dropped_post_wrath`:
a page whose every paragraph was about a later world is a page about a later
world. If the out-of-world trim or the strip is what left it empty, the page
stays as an empty row under `empty_pages` and `pages_emptied_by_trim` —
trimming a link list says nothing about which world the page is from, and
dropping the row would throw away a title, an id and a coordinate that are this
world's. `dropOutOfWorldOnly` is the discriminator: the same section walker with
the era half switched off, run only on a page that came out empty.

## Schema

```sql
pages       (id INTEGER PRIMARY KEY, title TEXT, ns INTEGER, text TEXT, text_len INTEGER)
redirects   (source TEXT PRIMARY KEY, target TEXT, ns INTEGER)
page_coords (page_id INTEGER, zone TEXT, x REAL, y REAL, raw TEXT)  -- wiki-derived, one row per coord
page_ids    (page_id INTEGER, kind TEXT, id INTEGER)  -- quest/npc/item/object/spell/unknown
page_quest  (page_id INTEGER PRIMARY KEY, start TEXT, end TEXT, category TEXT)  -- NULL end = page does not say
meta        (key TEXT PRIMARY KEY, value TEXT)   -- source, built_at, counts, build_ms,
                                                 -- schema_version, era_cutoff
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

`page_quest` arrived with `schema_version` 4 and degrades the same way
`page_ids` does: `bundleHasQuest` reports its absence and `searchReference`
simply omits the quest line, so a bundle one version behind still answers.

`schema_version` 5 is the Wrath snapshot, and **stays 5** through the drop
rules: no table is added or removed — the same `pages.text` column simply holds
fewer, older rows — so nothing fails closed on a version-4 bundle and a deployed
bundle keeps answering until it is rebuilt. The difference is visible instead,
as `meta.era_cutoff`, which the runner records on every run's comparability
tuple (a version-4 bundle reads as `null` there, never as "no cutoff was
applied"), and as the `pages_dropped_*` counters, which are what tells a
version-5 bundle built before the drop rules from one built after. `openBundle`
still fails closed below 2, where the missing `page_coords` table would silently
cost search a whole channel.

Rebuild and swap, with runs in flight:

```
bun wiki/src/build.ts data/wiki/<dump>.7z --out data/wiki/bundle.sqlite.next
bun wiki/src/verify.ts --db data/wiki/bundle.sqlite.next   # gate: non-zero = do not swap
ln data/wiki/bundle.sqlite data/wiki/bundle.sqlite.bak-$(date +%Y%m%d-%H%M)
mv -f data/wiki/bundle.sqlite.next data/wiki/bundle.sqlite
```

The rename is atomic and each runner process holds its bundle open by handle, so
a live run keeps reading the file it opened and the next process to start picks
up the new one. Nothing has to be drained to swap a bundle.

FTS5 is required and checked before the stream starts; a sqlite build without it
fails the build loudly rather than producing an unindexed bundle.

## Search

```ts
import { openBundle, searchReference } from "@wrathbench/wiki";

const db = openBundle();                       // data/wiki/bundle.sqlite, read-only
searchReference(db, "example quest alpha", { limit: 8, namespaces: [0, 118] });
// -> { title, ns, snippet, rank, exactTitle?, redirectedFrom?, matchedId?, coords?, quest? }[]
//    coords?: { zone?, x, y }[] — wiki-reference positions, not a live observation
//    matchedId?: { kind, id }   — the page states this id in an infobox field
//    quest?: { start?, end?, category? } — the quest infobox; absent `end` means
//            the page does not state one, never that the giver takes it back.
//            The same line leads the snippet, so the model reads it either way.
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

The wiki documents more than the world: the patch history, the Lua addon API, the
client UI, the boxed products and the company that makes them. Trajectory mining
found a `Hotfixes` archive served fifteen times and a pop-culture-reference list
thirty-eight, to a character standing in a zone. `classifyMetaPage`
(`wiki/src/meta-pages.ts`) recognises those from the title alone — the wiki
namespaces them by prefix (`API GetSpellInfo`, `MACRO cast`, `Hotfixes/2015
Archive`) or disambiguates them with `(AddOn)`. It runs at **build** time and the
build does not emit what it classifies, so there is no band, no label and no
exact-title carve-out: the page is not in the bundle to return. The rules are
deliberately conservative, since a missed hotfix archive costs a page of bundle
and a dropped quest page costs the run: `Widget*` was dropped because an NPC
shares the name, `Patch *` because items do, and `* (old)` because those are
mostly superseded spell versions — an era matter, which `post-wrath.ts` owns, not
an out-of-game one. 2,570 of the pre-drop dump's 104,808 titles classify, 2.45%.

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
