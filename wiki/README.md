# wiki

Turns a locally held wowwiki dump into a searchable sqlite bundle, and provides the
search function behind the runner's `search_reference` MCP tool.

The bundle is a concise reference for **this world**: patch 3.3.5a, Wrath of the
Lich King. Nothing in it is labelled by era, because content that is not 3.3.5 is
not in it — the build drops it, by deterministic rules, with a count in `meta` for
every rule. Removal is verifiable by rebuilding from the same dump.

The dump and the bundle are Blizzard-derived. Both live under `data/`, which is
gitignored at the directory level, and neither is ever committed or published.
Every contributor builds their own bundle from their own dump.

## Build

```
bun wiki/src/build.ts data/wiki/<dump>.7z [--out data/wiki/bundle.sqlite]
                                          [--era-cutoff 2010-10-12T00:00:00Z]
                                          [--world-ids data/wiki/world-ids.json]
                                          [--max-pages n] [--no-canary]
```

The archive is streamed through `7z x -so`; the 24 GB XML is never written to disk.
A plain `.xml` path also works. The build writes to a hidden temp file beside the
destination and renames it into place at the end, so a rebuild either replaces the
bundle wholly or leaves the previous one untouched. There is no resume; a full pass
is minutes, not hours. FTS5 is required and checked before the stream starts.

`--max-pages n` stops early, for a quick smoke build — with the caveat that
redirects are resolved against the pages actually seen, so a truncated run drops
every redirect whose target sits past the stopping point and its `redirects` count
means nothing.

`--era-cutoff` moves the revision line the bundle is taken at. It must be a full
ISO-8601 UTC instant, and a malformed one is rejected before the stream starts
rather than quietly dropping every page.

`--world-ids` is the one input that does not come out of the dump:

```
infra/export-world-ids.sh          # -> data/wiki/world-ids.json
```

Four SELECTs against `acore_world` for the quest, creature, item and gameobject
**id→name** maps. The export is server-derived, stays under `data/` and never
enters git. Without the flag `meta.world_ids` reads `none`; with it, it records
the export's `exported_at` and per-kind counts, so a bundle built against a different
export is visible rather than inferred. A malformed, empty or id-only export fails
the build rather than quietly changing which pages it keeps.

**The canary runs before the rename.** `wiki/src/canary.ts` holds a fixed list of
titles a patch-3.3.5a reference cannot be missing — the ten capitals, the eight
racial starting zones, the classic and Wrath zones an over-broad era rule reaches
first, and the low-level dungeons Cataclysm moved out from under their own names —
and the build fails, naming every missing one, rather than renaming a bundle that
has lost this world. Counters cannot catch a rule that is one word too broad; they
all add up either way. Redirects count: a title resolves directly or through the
chain. `--no-canary` skips it, and is the default for a `--max-pages` build;
`--canary` forces it back on.

`wiki/src/verify.ts` is the deeper, operator-run gate on a bundle that is already
written — the same required titles, a list of Cataclysm-or-later titles that must
**not** be there (resolved through the redirect table, so a recovered name counts),
and phrase pairs on named pages (no `flooded` on Thousand Needles; `Stonewrought
Dam` on Loch Modan). It exits non-zero with a report:

```
bun wiki/src/verify.ts [--db data/wiki/bundle.sqlite]
```

Every entry in both lists was checked against the dump before it was added. A title
that also existed pre-2010 as lore — Mount Hyjal, Tol Barad, Grim Batol, Kul Tiras,
Zandalar, Worgen, Goblin, Deepholm, Uldum, Kezan, Gilneas — is deliberately not a
forbidden title (what those pages may *say* is gated by the phrase pairs instead),
and a phrase pair the wiki's own 2010 editors had already broken is not a pair: a
gate that cries wolf is a gate that gets skipped.

Rebuild and swap, with runs in flight:

```
bun wiki/src/build.ts data/wiki/<dump>.7z --out data/wiki/bundle.sqlite.next
bun wiki/src/verify.ts --db data/wiki/bundle.sqlite.next   # gate: non-zero = do not swap
ln data/wiki/bundle.sqlite data/wiki/bundle.sqlite.bak-$(date +%Y%m%d-%H%M)
mv -f data/wiki/bundle.sqlite.next data/wiki/bundle.sqlite
```

The rename is atomic and each runner process holds its bundle open by handle, so a
live run keeps reading the file it opened and the next process to start picks up
the new one. Nothing has to be drained to swap a bundle.

## Decisions

The rules below state themselves; the fuller reasoning behind the reference bundle
lives in docs/METHODOLOGY.md "The reference bundle".

- **Era cutoff 2010-10-12, and prose is split from structure.** A surviving page is
  built from two revisions: the newest before the cutoff (patch 4.0.1) supplies the
  prose, the newest supplies the coordinates, entity ids and quest infobox, where a
  decade of corrections lives and where 30% of the coordinates only exist.
- **Drop, do not label.** A note costs the model a line in every snippet, does not
  survive a snippet window that starts after it, and leaves the wrong world in the
  index anyway. Out-of-game pages go the same way, not even reachable by exact
  title.
- **A page that predates the Cataclysm announcement is a Wrath page.** A post-Wrath
  signal never drops it, because Stormwind City picked up `|patch=4.0.1` in its own
  2010 history and the city is standing here. The line is `CATACLYSM_ANNOUNCED =
  2009-08-21`, not the beta: of the 588 pages in that pocket, 119 were created on or
  after the announcement and were mostly Cataclysm content.
- **A protected page steps back to the last signal-free revision** — the page before
  the beta rewrote it — refused when that revision is under **a quarter** of the
  newer one's length, since a stub or a blanking is worse than a rewrite.
- **Cataclysm's own coinages are vetoed by exact title in ns 0**, before the
  protection and as a redirect source too: a name with no pre-Cataclysm meaning has
  no revision about this world. Deepholm, Uldum, Kezan, Gilneas, Mount Hyjal, Tol
  Barad and Grim Batol are deliberately not on that list — they are this world's own
  lore, gated by `verify.ts` phrases instead.
- **Out-of-world sections are trimmed, and a page the trim empties is kept.** Link
  farms, patch records, lore and media sections go; but trimming them says nothing
  about which world the page is from, so the row stays with empty text and keeps its
  title, ids, coordinates and quest infobox. Only the era cuts drop a page.
- **Names survive page moves.** When Cataclysm took the bare title of a rebuilt
  dungeon, the era rules drop the page correctly and lose the name. Redirect
  recovery from the newest revision and from an `(original)`/`(old)` sibling put the
  name back — never the page — resolved through the one bounded chain walk in two
  passes, since whether a title answers is only known once its chain is resolved.
- **The build may ask the world DB whether an id exists, and the name has to
  agree.** A late page stating an id this server has *under a name that matches the
  page's subject* is admitted. The id alone was 0.62 precise over an exhaustive
  151-row review (94 true, 57 false); name agreement refuses 53 and admits 95 pages,
  of which about 15 are known false admits kept by design — roughly 0.85. The server
  is read once, offline, into a file.
- **A rebuild is a harness minor bump.** The reference surface changes for every lane
  at once, so runs before and after are not comparable on what the model could read.
- **Every rule counts itself in `meta`, and the counters close.** Six admission and
  drop reasons plus `empty_pages` account for every page the parser yields except
  those that were a `#REDIRECT` at the cutoff, asserted as an identity by the build
  test. See Counters below.

## What ends up in the bundle

- Namespaces main (0), Category (14), Portal (116) and Quest (118). Talk, User,
  File, Template, Forum, Guild, Server and the semantic-mediawiki namespaces are
  dropped without being parsed.
- One row per surviving page, from the two revisions above. The era revision has to
  survive two hygiene rules to win: a revision where the page was a `#REDIRECT` is
  not prose, and a revision that was immediately reverted — the revision right after
  it restored a sha1 the page already had — is not what the page said. Otherwise the
  newest pre-cutoff revision wins, whatever order the dump lists revisions in.
- A protected page holds a third slot, the newest pre-cutoff revision carrying no
  post-Wrath signal of its own, tested against the same rules `admitPage` reads.
- The dump is full history, so most of its bulk is revisions that never reach the
  bundle. A page with more than 50 revisions is exported as several consecutive
  `<page>` blocks of 50, so a block is not a page: the parser holds a page open
  until the (title, ns) key changes and merges its blocks, and the build asserts
  `pages` holds one row per (title, ns) — `pages_distinct_keys` — so a regression
  here fails the build instead of quietly indexing stale text beside current text.
- Redirects are decided by the same Wrath snapshot: a page that was a redirect at
  the cutoff is a redirect here whatever it became later, and one that was an
  article then is an article here even if it was merged away in 2014. Source and
  target go in `redirects`, so a search for an old or alternate name still lands on
  the article — unless the chain does not end at a surviving page, in which case the
  redirect is dropped with its target.
- Wikitext is reduced to plain text: templates, tables, refs, comments and file
  links are removed, `[[link|label]]` becomes `label`, headings become plain lines,
  whitespace is collapsed. Most infobox data lives in templates and is therefore
  lost. The consumer is a model reading search results, not a browser.
  Brace-matching is a run at a time and by kind — `{{{param|default}}}` is a
  parameter, `}}` closes a template and `|}` a table — and an opener that is never
  closed costs its own paragraph, not the page: the strip resumes at the next blank
  line after it.
- Three things are lifted off the raw wikitext **before** the strip, because they
  live in the templates the strip removes:
  - **Coordinates** (`extractCoords`): `{{coords|x|y|zone}}` and infobox
    `loc`/`location` fields, into `page_coords`. These are wiki-derived reference
    notes — what an editor wrote on the page — not a live observation and not proof
    anything is at that spot now.
  - **Quest giver and ender** (`extractQuest`): `{{questbox | start=… | end=… |
    category=… }}` into `page_quest`. It reads only the named-argument infoboxes
    (`questbox`, `questinfo`) — `{{questlong|…}}` is a list-item template on index
    pages — and it **never infers `end` from `start`**: 11,013 quest pages state a
    giver, 6,637 state an ender, and search says "not stated on this page" for the
    rest rather than guessing the giver.
  - **Entity ids** (`extractIds`): the numeric ids a page states about itself
    (`|id=`, `|itemid=`, `|npcid=`, `|questid=`, `|entry=`) into `page_ids`, tagged
    with the kind the enclosing template implies. Without this an id can only be
    matched against body prose, and a page whose arithmetic happens to contain the
    digits outranks the entity page.

Nothing here reads the AzerothCore DB, DBC tables or Questie; it is all
deterministic parsing of the wikitext. The world-id export is the one place the
build reads the server, and it decides only *whether a page is in the bundle* — no
value off it ever reaches a row, a snippet or the model.

## The cuts inside a surviving page

Three levels run on the raw wikitext before the strip (`wiki/src/wrath-only.ts`),
the first two about the era and the third about whether the section is about the
world at all.

- **Era sections.** A `{{cata-section}}`/`{{mists-section}}` marker or an
  `== In Cataclysm ==`-style heading drops the heading and everything under it, down
  to the next heading of the same or a shallower level. Pre-Wrath eras
  (`{{bc-section}}`, `== The Burning Crusade ==`) are untouched. The April 2010
  Cataclysm class previews are in this set too: Blizzard posted one per class and
  the wiki pasted each into the class page under standardised headings, so
  `new … abilities`, `changes to abilities and mechanics`, `new talents and talent
  changes`, `mastery` (with the optional `passive`/`talent`/`tree`/`bonuses` words),
  `cataclysm class preview…` and `cataclysm changes`/`cataclysm preview` are era
  cuts. Measured over the era revision of every page in the kept namespaces:
  46 pages carry one — 7, 9, 8, 9, 0 and 13 respectively, and the
  first four are the class pages and nothing else. `mastery` is the narrow one,
  since Stance Mastery and Tactical Mastery are 3.3.5 talents; anchored at both ends
  it reaches neither, and a plain `== Talents ==` is untouched. Headings are matched
  on their normalised form, so a trailing colon or bold markup does not hide one.
- **Era paragraphs.** A blank-line-separated block whose prose (its templates
  removed first, so an infobox field never decides) matches a narrow phrase rule
  goes: `in Cataclysm`, `with Cataclysm`, `World of Warcraft: Cataclysm`, `after the
  Shattering`, `upcoming`/`beta` beside Cataclysm, Deathwing or the Shattering,
  `will` within 60 characters of `Cataclysm`, and the class preview's own framing
  (`development on Cataclysm continues`, `Cataclysm class preview`). An adversarial
  read of a built bundle added the rules for prose that describes the later world
  **without** naming the expansion: `rated battleground(s)`, an inline
  `(Expansion: …)` tag, `playable` beside `worgen` or `goblin`, `Archaeology` unless
  a `dig site`, `team`, `unit` or `expedition` sits within 20 characters of it
  either side, and `Mastery` only when the paragraph also carries the 2010 dev voice
  (`we plan`, `we're planning`, `will be a new`, `new passive stat`). The last two
  are the narrow ones and are tested both ways: a quest's archaeology team and the
  Stance Mastery and Tactical Mastery talents are all in this world and all survive.
  A handful of rules cut a single **line** rather than the block — `Speedbarge` is
  the only one today — because a block is as often a list of subzones as it is a
  paragraph, and one item of it can be the only later-world thing on the page. A
  bare mention of Deathwing, the Legion, Draenor or Garrosh is not a rule: all four
  are in this world. Precision on a hand-checked 33-paragraph sample is about 0.8;
  the residue is recorded with the build.
- **Out-of-world sections.** A fixed set of headings is dropped, heading line and
  body together: `external links`, `references`, `see also`, `patch changes`,
  `patches and hotfixes`, `patch history`, `patch notes`, `changes`, `gallery`,
  `videos`, `video`, `images`, `media`, `trivia`, `notes and trivia`, `speculation`,
  `quotes`, `quote`, `dialogue`, `criticism`, `reception`, `development`, `history`,
  `background`, `lore`, `in the rpg`, `rpg`, `in the warcraft rpg`, `in the tcg`,
  `tcg`, `in the manga`, `in the comics`, `in the novels`, `in hearthstone`,
  `in warcraft iii`, `in warcraft ii`, `in warcraft i`, `addons`, `macros`. The
  heading is normalised first — trimmed, case-folded, markup and trailing
  punctuation removed — and matched **exactly**, never as a prefix or a substring,
  which is the whole reason `changes` goes while `past changes` stays and `notes and
  trivia` goes while `notes` stays. Nothing is rewritten: a section is here in full
  or not at all. There is no keep list in the code, only the drop set, but these
  were considered and deliberately kept: `notes`, `tips`, `tactics`, `tips and
  tactics`, `strategy`, `abilities`, `drops`, `source`, `objectives`, `description`,
  `progress`, `completion`, `rewards`, `gains`, `quests`, `location`. They say what
  is there, what it does and how to get it — that is the whole point of the bundle.
  A section left with no prose after all the cuts and the strip is not emitted
  either, so a table-only `Drops` never becomes an orphan heading line.

Which cut emptied a page decides what happens to it. If the **era** cuts took all of
its prose the page is dropped: a page whose every paragraph was about a later world
is a page about a later world. If the out-of-world trim or the strip is what left it
empty, the page stays as an empty row — trimming a link list says nothing about
which world the page is from, and dropping the row would throw away a title, an id
and a coordinate that are this world's. `dropOutOfWorldOnly` is the discriminator:
the same section walker with the era half switched off, run only on a page that came
out empty.

## Counters

Every counter is one row in the `METRICS` table in `wiki/src/build.ts` — name,
help text and its place in the accounting identity — and the build loop, the
`meta` write, the console summary and the identity test all read that table, so
a counter cannot be in one of them and silently missing from another.

`admitPage` (`wiki/src/post-wrath.ts`) is the one page-level decision, a pure
function of the title, the namespace, the two revisions and — when the build was
given one — the world-id oracle. It returns one of six reasons, each a `meta`
counter. The six plus `empty_pages` account for every page the parser yields except
those that were a `#REDIRECT` at the cutoff (`pages_era_redirect`), which the build
test asserts as an identity so a page cannot be counted twice or lost quietly. The
term on the right is `pages_era_redirect` and not `redirects`, because a redirect
row can be generated for a title that is also a counted page: a page a move
emptied is still a dropped page, and recovering its name does not put the page back.

- `pages_pre_cutoff` — has pre-cutoff prose, and either no post-Wrath signal or the
  pre-announcement protection. Its prose is that revision.
- `pages_post_cutoff_wrath_signal` — no pre-cutoff revision, but the newest revision
  says outright that its subject is Wrath-or-earlier: an infobox `|patch=` below
  4.0, an `|expansion=` naming Wrath, the Burning Crusade or vanilla, or a
  `[[Category:Wrath of the Lich King]]`-style category. Vetoed for WoW Classic
  (2019), whose 1.13/1.14 patches read as vanilla to every one of those rules. Its
  prose is the newest revision, because it is the only one there is.
- `pages_post_cutoff_id_match` — no pre-cutoff revision, nothing said about the era
  either way, and an id the page states about itself exists in this server's 3.3.5a
  world DB under an agreeing name. The subject is the title with its namespace
  prefix and trailing parentheticals off, and agreement is one name's words being
  all of the other's after case and punctuation are folded away — words, not
  substrings, because a substring rule matches inside a word. `spell` and `unknown`
  ids never match: spells are client DBC data the world DB has no table for, so its
  silence about one is no evidence, and an `unknown` id is a number whose kind the
  page did not state. Only reachable with `--world-ids`, and last in the order, so a
  page carrying a post-Wrath or Classic-2019 signal is never admitted by an id a
  later expansion reused. Its prose and cuts are the `wrath_signal` case exactly.
- `pages_dropped_post_cutoff` — no prose from before the cutoff and not admitted by
  either door above. Whether the page also names a later expansion does not change
  the reason: this world's wiki does not have the page at all. Roughly a fifth of
  the dump's pages; the wiki kept growing after 2010.
- `pages_dropped_post_wrath` — has pre-cutoff prose that carries a post-Wrath signal
  and the page was created on or after the Cataclysm announcement: a title
  parenthetical or a `/Cataclysm`-style subpage suffix naming a later expansion, a
  `[[Category:…]]`, a page-banner template (`{{stub/Cataclysm}}`,
  `{{Legion-article}}`, `{{DraenorZone}}`, `{{Pandaria}}`), an infobox `|patch=` at
  4.0 or later, or an `|expansion=` naming one. Also counts a page whose prose the
  era cuts took in full.
- `pages_dropped_meta` — out-of-game: patch notes, the Lua addon API, the client UI,
  a boxed product, a real-world topic. `classifyMetaPage` decides from the title
  alone and the build does not emit what it classifies (see Search, below).
- `empty_pages` — in the bundle, with no prose. A page whose body was an infobox, a
  table or a link farm is still this world's item, quest or NPC, and its title, its
  ids, its coordinates and its quest infobox are still the right answer to a query.
  An empty row is not an FTS document: indexing a title with no body behind it would
  let bm25 rank it above a page that has something to say.

Subsets, tagged on a counter above and deliberately outside the identity:
`pages_era_swapped` (prose from an older timestamp than the structured fields),
`pages_pre_announcement_protected`, `pages_stepped_back` and
`pages_step_back_refused`, `pages_id_name_mismatch` (pages the name rule refused —
the number to read first if the id door is ever retuned), and
`pages_emptied_by_trim`.

Cut counters: `sections_dropped` and `paragraphs_dropped` for the era cuts,
`sections_trimmed` and `sections_trimmed_json` (broken down by normalised heading,
the empty-section removals under `(empty)`) for the out-of-world trim. The two stay
separate so a regression in one cannot hide in the other. Redirect counters:
`redirects_dropped_dangling`, `redirects_recovered_newest`,
`redirects_original_sibling`.

The post-Wrath signals are read on the revision the prose comes from, **never** on a
later one: a Wrath zone that Cataclysm rearranged had its Cataclysm category added
in 2011, and reading the newest revision would delete a zone that is standing in
this world. They are also narrow where the words collide. The Burning Legion, the
7th Legion, `Legion's`-anything, Deathwing, Garrosh and Draenor (Outland's own name)
are all Wrath content: the category rule fires only on a category that *is* `Legion`
or starts with `Legion `, never on one that merely contains the word — the census
counts `Burning Legion` 39 times against `Legion` 29 — and `{{Removedwithlegion}}`
and `{{Removedwithcataclysm}}` are not signals at all, since content removed later
is content that exists here. In **ns 14 only**, a category page whose own title
names a post-Wrath zone or feature counts as a signal (`Category:Deepholm quests`,
`Category:Uldum NPCs`, `Category:Archaeology`): the category rule reads the
categories written *on* a page and a category page carries none of its own, which
left 33 such stubs in a built bundle. It is never applied to ns 0, and
`Category:Burning Legion` is this world's by the same `Legion`-exactly rule as
everywhere else.

## Schema

```sql
pages       (id INTEGER PRIMARY KEY, title TEXT, ns INTEGER, text TEXT, text_len INTEGER)
redirects   (source TEXT PRIMARY KEY, target TEXT, ns INTEGER)
page_coords (page_id INTEGER, zone TEXT, x REAL, y REAL, raw TEXT)  -- wiki-derived, one row per coord
page_ids    (page_id INTEGER, kind TEXT, id INTEGER)  -- quest/npc/item/object/spell/unknown
page_quest  (page_id INTEGER PRIMARY KEY, start TEXT, end TEXT, category TEXT)  -- NULL end = page does not say
meta        (key TEXT PRIMARY KEY, value TEXT)   -- source, built_at, counts, build_ms,
                                                 -- schema_version, era_cutoff, world_ids
pages_fts   FTS5 over (title, text), external content over pages
```

`page_coords` keeps the source fragment in `raw` for provenance while search returns
only the `{zone, x, y}` triple.

Versions, and how a bundle one behind degrades:

- **2** added `page_coords`, and `openBundle` **fails closed** below it rather than
  silently advertising an empty coordinate channel. (A consumer that opens the
  sqlite file directly still degrades safely: `searchReference` treats a missing
  `page_coords` as "no coords".)
- **3** added `page_ids` and deliberately does not fail closed: a live episode must
  not lose `search_reference` because the deployed bundle is a version behind.
  `bundleHasIds` reports the table's absence, `searchReference` answers an id query
  with nothing rather than with body-text noise, and the runner's tool result says
  the bundle has no id index.
- **4** added `page_quest`, degrading the same way: `bundleHasQuest` reports its
  absence and search omits the quest line.
- **5** is the Wrath snapshot, and **stays 5** through the drop rules: no table is
  added or removed — the same `pages.text` column holds fewer, older rows — so
  nothing fails closed on a version-4 bundle and a deployed bundle keeps answering
  until it is rebuilt. The difference is visible instead, as `meta.era_cutoff`,
  which the runner records on every run's comparability tuple (a version-4 bundle
  reads as `null` there, never as "no cutoff was applied"), and as the
  `pages_dropped_*` counters, which tell a version-5 bundle built before the drop
  rules from one built after.

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
   `matchedId`, `rank: ID_MATCH_RANK`. A page whose kind matches the word the query
   used ("quest 783") comes before one that states the same number under another
   kind.
3. **title tokens** — every word of the query appears in the page title.
4. **body** — the words appear somewhere in the text.

A page with no article text is never in bands 3 and 4 — it is not an FTS document —
and bands 1 and 2 return it only when it has something structured to state (a quest
infobox, an id, or coordinates when they are served), with the fixed snippet
`(no article text; the page states only what is listed here)` ahead of the quest
line. An empty page that states nothing is skipped outright and the query falls
through to the other bands, rather than answering its own title at rank 1 with
silence.

`parseIdQuery` decides what counts as an id. A numeric token is an id lookup when it
is the whole query, when an id word precedes it (`quest 783`, `npc entry 197`,
`entry 721 Northshire`), or when the number opens the query and an id word follows
(`721 npc entry Northshire`); the id word is consumed with it, since leaving "quest"
in the text query matches every quest page. `level 5 quests` is left alone. An id
token is **never** handed to the full-text index, so body prose cannot answer
an id question.

Out-of-game pages have no band and no label, because they are not in the bundle to
return. `classifyMetaPage` (`wiki/src/meta-pages.ts`) recognises them from the title
alone — the wiki namespaces them by prefix (`API GetSpellInfo`, `MACRO cast`,
`Hotfixes/2015 Archive`) or disambiguates them with `(AddOn)`. Trajectory mining is
what motivated the rule: a `Hotfixes` archive served fifteen times and a pop-culture
reference list thirty-eight, to a character standing in a zone. The rules are
deliberately conservative, since a missed hotfix archive costs a page of bundle and
a dropped quest page costs the run: `Widget*` was dropped because an NPC shares the
name, `Patch *` because items do, and `* (old)` because those are mostly superseded
spell versions — an era matter, which `post-wrath.ts` owns, not an out-of-game one.
2,570 of the pre-drop dump's 104,808 titles classify, 2.45%.

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
