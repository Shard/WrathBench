# ADR-0040: The bundle is a Wrath snapshot

Status: Accepted. Date: 2026-08-24 (rewritten the same day; the first version
labelled what this one removes).

## Context
The reference bundle is built from a 2020 wowwiki dump and read by a model
driving a character in patch 3.3.5a. Four expansions of divergence sit between
the two. ADR-0029 marked the era sections the wiki labels itself and left the
rest, and the first version of this ADR added a revision cutoff for the prose
and a page-level label for the pages that have no revision before it.

That left the bundle carrying two kinds of text: text about this world, and text
about a later one with a note attached. A note costs the model a line of reading
in every snippet, does not survive a snippet window that starts after it, and
still leaves the wrong world in the index. The dump is a rough source; the
bundle is a product built from it, and what is not in this world has no reason
to be in the product.

The evidence for what a cutoff can and cannot do is a census over the dump
(2026-08-24, scratch, not committed):

- 81.3% of pages have a revision older than 2010-10-12; 18.6% do not, because
  the wiki kept growing after 2010.
- Starter-zone pages, the ones a new character is most exposed to, are exactly
  the ones that were rewritten: their pre-cutoff text is 0.30–0.90 of the newest
  by size. That is the divergence, not a loss.
- A plain swap would cost 30% of the wiki coordinates and a slice of the entity
  ids: those live in infoboxes filled in over the decade after. They are facts
  about ids and map positions, not about which world it is. Quest infobox
  coverage is unaffected (99.9%).
- Of the 20,407 pages with no pre-cutoff revision, 1,901 are provably post-Wrath
  (expansion template, category, title parenthetical, or an infobox patch at 4.0
  or later), 15 carry an explicit Wrath-or-earlier signal, and 18,717 say
  nothing either way.
- 144 article pages have a pre-cutoff revision whose newest instance is itself a
  `#REDIRECT`.

## Decision
**The bundle is a concise Wrath reference. Anything that is not patch 3.3.5 is
removed at build time by deterministic rules, and every rule's count is written
to `meta`.** Removal is verifiable by rebuilding from the same dump, which is
the reversibility that matters; a label in a snippet is not.

The rules, in the order the build applies them:

- **The cutoff, 2010-10-12T00:00:00Z**, patch 4.0.1 — the client patch that
  shipped the world change, before Cataclysm's content. Not 3.3.5's own release:
  a page edited in the four months between is still describing the Wrath world,
  and holding that line costs 6.2 points more dropped pages for no gain in
  accuracy. Not the Shattering or Cataclysm's release: 0.2–0.3 points fewer
  drops, and a month of beta-informed rewrites let in. A constant with an
  `--era-cutoff` build flag, written to `meta.era_cutoff` so a bundle says which
  line it was built at, and validated as a full ISO-8601 instant before the
  stream starts.
- **A hybrid page, not a swap.** A surviving page is built from two revisions:
  the newest supplies the structured fields (coordinates, entity ids, quest
  infobox), the newest before the cutoff supplies the prose that is stripped and
  indexed.
- **Two hygiene rules on the era winner, and only these two.** A candidate whose
  text is a `#REDIRECT` is skipped, and one that was immediately reverted is
  skipped — the revision right after it restored a `sha1` the page already had.
  No size-drop or minor-flag heuristics: the census found `<minor/>` unused in
  this dump and a size heuristic would have thrown out 1.7% of winners on
  suspicion. The revert test needs a newer and an older revision and `<sha1>` is
  emitted after `<text>`, so it is decided at page finish over a per-page ledger
  of (timestamp, id, sha1), with the two newest passing bodies held.
- **Redirect-ness is decided by the Wrath snapshot too**, from the newest
  pre-cutoff revision. A page that was a redirect in 2010 is a redirect here
  whatever it became later; a page that was an article then is an article here
  even if it was merged away in 2014 (144 pages flip this way). A redirect whose
  chain does not end at a surviving page is dropped with its target.
- **One page-level decision, `admitPage` in `wiki/src/post-wrath.ts`**, a pure
  function of the title and the two revisions, returning one of five reasons:
  `pre_cutoff` and `post_cutoff_wrath_signal` admit; `dropped_post_cutoff`,
  `dropped_post_wrath` and `dropped_meta` do not. Each is a `meta` counter, and
  the five plus `empty_pages` account for every non-redirect page the parser
  yields — a build-test identity, so a page cannot be counted twice or lost
  quietly.
- **Post-Wrath signals drop the page**: a title parenthetical naming a later
  expansion, a `[[Category:…]]` naming one, a page-banner template
  (`{{stub/Cataclysm}}`, `{{Legion-article}}`, `{{DraenorZone}}`), an infobox
  `|patch=` at 4.0 or later, or an `|expansion=` naming one. Read on the revision
  the prose comes from, never on a later one: a Wrath zone that Cataclysm
  changed had its Cataclysm category added in 2011, and reading the newest
  revision would delete a zone that is standing in this world. The rules are
  narrow where the words collide — the Burning Legion, the 7th Legion, Draenor
  as Outland's own name and `{{Removedwithlegion}}` are all Wrath content, and
  the census's own tally (`Burning Legion` 39 against `Legion` 29) is why
  "category contains Legion" is not a rule.
- **Out-of-game pages are dropped, not demoted.** `classifyMetaPage` runs at
  build time and the build does not emit what it classifies. The search band and
  its label are gone, and with them ADR-0029's carve-out that kept an exact-title
  hit at the top: the page is not there to return. That was decided, not
  forgotten — a hotfix archive is not a fact about this world under any query.
- **Sections and paragraphs are cut inside a surviving page.** A
  `{{cata-section}}` or `== In Cataclysm ==` section goes, heading and all
  (`sections_dropped`). A paragraph matching a narrow phrase rule goes
  (`paragraphs_dropped`); a bare mention of Deathwing, the Legion, Draenor or
  Garrosh does not, because all four are in this world.
  `{{Removedwithcataclysm}}` is not a drop signal — content removed later exists
  here — and the template goes the way every template goes, with nothing in its
  place. If the **era** cuts empty a page that had prose, the page is dropped and
  counted as `dropped_post_wrath`; if the out-of-world trim is what emptied it,
  the page keeps its row with empty text (see §Which cut emptied the page decides
  what happens to it).
- **`search_reference`'s description carries one fixed sentence** saying the
  bundle is a Wrath-era snapshot of the wiki and describing this world, and to
  prefer what can be observed in game. The clause about labelled paragraphs is
  gone with the labels.

**Admission by explicit Wrath signal is in, and it is the only admission rule.**
A page created after the cutoff can still be right about this world — the wiki
documented the old world for a decade — and `post_cutoff_wrath_signal` admits
one when the newest revision says so outright: an infobox `|patch=` below 4.0,
an `|expansion=` naming Wrath or earlier, or one of four category names, with a
Classic-2019 veto (WoW Classic's patches are 1.13/1.14 and read as vanilla to
every rule above). That reaches 15 of the 20,407 late pages. The rule that would
reach the unlabelled 18,717 is a **server-side id cross-check** — admit a
post-cutoff quest, NPC or item page whose stated id exists in the world DB — and
it is deliberately **not implemented**. The wiki tooling reads nothing from the
server by design, and crossing that line is an operator decision, not an
implementer's (FOLLOW-UPS 62).

## Consequences
- The reference surface changes for every lane at once, so this is a harness
  minor bump (ADR-0033 addendum): runs before and after are not comparable on
  what the model could read. `meta.era_cutoff` and the `pages_dropped_*` counters
  are the evidence on the tuple, and they are also what tells a version-5 bundle
  built before this from one built after.
- `schema_version` stays 5. No table is added or removed — the same `pages.text`
  column holds fewer, older rows — so a bundle one version behind keeps
  answering; only the pre-`page_coords` bundles below version 2 still stop a run.
- The bundle is smaller and its coverage is narrower. A model asking about
  something that only exists in Cataclysm now gets nothing rather than a page
  with a note, which is the intended answer: it does not exist here.
- The cost is the pages this drops that were right about 3.3.5 and did not say
  so — most of the 18,717. That is the trade the operating principle takes, and
  the id cross-check above is the way back if a trajectory shows it costing
  something.
- Coordinates keep coming from the newest revision, so a coordinate can be newer
  than the prose beside it. That was already the contract: they are
  wiki-reference notes about where something is, not claims about what the world
  looked like in a given patch.
- Peak parser memory is the newest body plus at most two era candidates, held
  only while a page is open.

## Sections

Addendum, 2026-08-24. The rules above ask which world a page is about. This one
asks a different question of a page that survived them: can a character driving
through the world act on this section at all?

### Context
A heading census over the Wrath-snapshot revisions (2026-08-24, scratch, not
committed) says the bundle's bulk is not world facts. `External links` is on
66,140 pages and 14.1% of raw bytes — a link farm the strip reduces to a list of
bare labels. The patch record (`patch changes`, `patches and hotfixes`, `patch
history`, `patch notes`) is another 1.4%. Lore and story (`history`,
`background`, `lore`) is about 1.3%, and the commentary and media set (`trivia`,
`quotes`, `speculation`, `gallery`, `videos`, `images`, `dialogue`, the other
Warcraft products) about 1.8%. None of it names a coordinate, an id, a giver or
a reward. The unambiguous drop candidates come to 16.3% of corpus bytes.

The sections the model actually needs are cheap and few: `source`, `objectives`,
`description`, `completion`, `progress`, `rewards`, `gains`, `notes`,
`abilities`, `drops`, `location`.

### Decision
**A fixed set of headings is dropped at build time — the heading line through
the next heading of the same or a shallower level — and nothing is rewritten.**
The set is matched on the normalised heading (trimmed, case-folded, markup and
trailing punctuation removed) and only ever exactly, never as a prefix or a
substring: that is what separates `changes` from `past changes` and `notes and
trivia` from `notes`. The set and the deliberately kept headings are listed in
`wiki/README.md`; the code carries the drop set only, because a keep list would
have to be exhaustive to mean anything and no heading needs permission to stay.

It runs in the same section walker as the era cut (`dropPostWrathSections`),
with the era check first so a heading can never be counted under both. A third
pass runs last, after the paragraph rules: **a section whose subtree carries no
prose once everything is stripped is not emitted at all**, so a table-only
section, or one the era rules emptied, never leaves an orphan heading line. The
test is on the subtree rather than the direct body — a heading with no text of
its own but an occupied subsection is a real heading.

Rewriting, summarising or truncating a section is not on the table. A section is
in the bundle in full or it is not there, which is what keeps removal verifiable
by rebuilding from the same dump.

### Consequences
- `sections_trimmed` is the total and `sections_trimmed_json` the breakdown by
  normalised heading, with empty-section removals under `(empty)`, so a rebuild
  says exactly what went. The keys are sorted before serialising, so two builds
  from the same dump write the same string. The era counters
  (`sections_dropped`, `paragraphs_dropped`) stay separate: they answer a
  different question, and a regression in one should not hide in the other.
- Like the era rules, this changes what every lane can read, so it lands with the
  same harness minor bump and the same deploy window.
- A page that was nothing but a link list now empties and is counted as
  `pages_dropped_post_wrath` — the wrong name for the right outcome. The five
  reasons plus `empty_pages` are a build-test identity and not worth widening
  for it. **Superseded**: it was not the right outcome, it was five thousand
  pages of this world thrown away with their ids. See §Which cut emptied the
  page decides what happens to it.
- The cost is a fact that only ever appeared under a dropped heading: a tactic
  written under `Trivia`, a spawn note under `History`. The census says that is
  a thin tail against 16% of bytes, and the drop set is one edit away if a
  trajectory shows otherwise.

## Pages that predate the beta, and a canary

Addendum, 2026-08-24. The rules above read the post-Wrath signals on the
revision the prose comes from, which was meant to stop a Cataclysm category
added in 2011 from deleting a zone that is standing in this world. It is not
enough, because some of those categories were added in 2010.

### Context
An attribution pass over the 6,935 pages `admitPage` dropped as post-Wrath
(2026-08-24, scratch, not committed) splits them three ways:

- 4,859 are a mid-2010 bot import of beta-datamined Cataclysm items and quests
  (`{{Stub/Cataclysm}}`, no revision at all before 2010-06-01). Correct drops,
  and the reason the rule exists.
- 1,429 have no pre-cutoff revision, so they were being counted under the wrong
  reason — see below.
- **588 are pages that existed before the Cataclysm beta and picked up
  `|patch=4.0.1`, `[[Category:Cataclysm]]`, a `{{Cataclysm}}` banner or
  `{{stub/cataclysm}}` in a 2010 revision.** Stormwind City is one. So are
  Orgrimmar's neighbours Durotar and the Barrens, Thousand Needles, Auberdine,
  Southshore, Camp Taurajo, Azshara, Darkshore, Desolace, Stonetalon Mountains,
  Stranglethorn Vale, the Wetlands and Westfall — the capitals and the zones
  Cataclysm was about to reshape, annotated by editors who were reading the beta
  notes. Every one of them is a place a character can walk into on this server.

The wikitext cannot separate the two groups: both say Cataclysm, in the same
words, in the same fields. What separates them is the page's age. A page that
existed before the beta documented this world first and acquired the annotation;
a page created during the beta was written about the world that was coming.

### Decision
**A page whose first revision predates 2010-06-01 (`CATACLYSM_BETA_START`) is a
Wrath page, and a post-Wrath signal never drops it.** The parser tracks each
page's oldest revision timestamp (`firstRevisionAt`) and `admitPage` reads it.
The section and paragraph rules still run on the surviving page, so the
Cataclysm paragraph that arrived with the category still goes — the page stays,
minus what was written about the next world. Kept pages that used the protection
are counted as `pages_pre_beta_protected`, a subset of `pages_pre_cutoff` and
deliberately outside the five-reasons-plus-`empty_pages` identity.

The creation date is a proxy, not evidence about content, and that is the point:
it is deterministic, it is in the dump, and it does not require reading the
server (CONTRACTS.md) or judging prose. The line is drawn at the beta rather
than at the announcement because the 588 was measured there and because the bot
import that motivates the whole rule is mid-2010.

**The reason counter for a page with no pre-cutoff prose is
`dropped_post_cutoff`, whatever else the page says.** Previously the post-Wrath
signal was tested first, so 1,429 late pages that also named a later expansion
were counted as beta stubs. The admitted set does not change — the post-Wrath
signal still vetoes the explicit-Wrath-signal admission — only the reason a page
is absent, which is that this world's wiki does not have the page.

**A canary guards the result.** `wiki/src/canary.ts` holds the titles a
patch-3.3.5a reference cannot be missing — the ten capitals, the eight racial
starting zones, and the classic and Wrath zones an over-broad era rule reaches
first — and the build checks them, through redirects, after the indexes are
written and **before** the temp bundle is renamed into place. A miss fails the
build, names every missing title, and leaves the deployed bundle alone.
`--max-pages` smoke builds skip it (`--no-canary`). `wiki/src/verify.ts` is the
operator-run version on an already-written bundle, adding Cataclysm-or-later
titles that must not exist and phrase pairs on named pages.

This is the lesson the 588 pages actually taught: every counter in that build
added up. Six thousand pages dropped, five reasons, an accounting identity the
build test asserts — and no capital city. **A rule that is one word too broad is
invisible to counters and obvious to a list of names.**

### Consequences
- The bundle regains about 500 pages of this world, including its capitals and
  the zones a starting character walks through. That is a change in what every
  lane can read, so it lands with the same harness minor bump and deploy window
  as the rest of the era work.
- The residue is measured: 119 of the 588 protected pages were created in 2009
  or later, and the clusters at 2009-08-21/22/23 (BlizzCon, where Cataclysm was
  announced) and 2010-04 are largely Cataclysm content — Blackwing Descent,
  Blackrock Caverns, Halls of Origination, Lost City of the Tol'vir, Gilneas
  City, the Lost Isles, and a run of beta ability pages. They are admitted now.
  Moving the line to the announcement date would keep roughly 500 and drop
  roughly 88 of those; it was not done here because 2010-06-01 is the line the
  588 was measured at. FOLLOW-UPS 64.
- The canary is a fixed list, so it is a maintenance surface: a title that a
  future dump spells differently fails a good build. It is checked against the
  dump when it changes, and redirect resolution absorbs the common case.
- The canary fails today on **Orgrimmar**, and correctly. Its 2010 revision is
  emptied by the wikitext stripper before any era rule runs, so the page has
  been absent from every bundle built since the era work, counted quietly under
  `empty_pages`. That is a `strip.ts` defect, not an era one (FOLLOW-UPS 63); the
  canary is what made it visible.

## The line is the announcement, not the beta

Addendum, 2026-08-24. The protection above was drawn at 2010-06-01 because that
is where the 588-page pocket was measured, and its own consequences recorded
that 119 of those 588 were created in 2009 or later — clustered on 2009-08-21/22
and in 2010-04 — and were mostly Cataclysm content: Blackwing Descent, Blackrock
Caverns, Halls of Origination, Lost City of the Tol'vir, Gilneas City, the Lost
Isles, a run of beta ability pages. That is the whole argument for moving the
line. Cataclysm was announced at BlizzCon on 2009-08-21 and the wiki began
stubbing it the same week, so from that day on a Cataclysm signal on a page
created after it is a statement of subject, not an annotation on a Wrath page
that already existed; before it, no editor could have been writing about
Cataclysm at all. The constant is now `CATACLYSM_ANNOUNCED = 2009-08-21`,
`isPreAnnouncementPage` is the predicate, and the counter is
`pages_pre_announcement_protected` — a rename carried through code, the meta
key, the tests and this document together rather than left half done. It keeps
roughly 500 of the 588, drops the announced-Cataclysm residue, and changes
nothing else: the section and paragraph rules still strip what they strip, and a
page created before the announcement is still a Wrath page whatever it later
acquired. FOLLOW-UPS 64. The canary's Orgrimmar failure recorded above is also
closed, and was a stripper defect exactly as suspected: a repeated
`<ref name="x" />` was read as an opening tag and ate the `}}` that closed the
infobox, after which the brace scanner never returned to depth 0 (FOLLOW-UPS 63).

## Which cut emptied the page decides what happens to it

Addendum, 2026-08-24. The Consequences above accepted that a page the section
trim empties would be counted `pages_dropped_post_wrath` — "the wrong name for
the right outcome". The outcome was wrong too. On a full rebuild that bucket read
10,027 where the signal arithmetic says about 5,000, and the surplus was five
thousand pages of this world: an NPC whose body was an infobox, an item whose
body was an infobox and an external-links list, a quest whose body was a table.
The trim took their only prose, the page came out empty, and the row went — with
the title, the `page_ids`, the `page_coords` and the `page_quest` rows on it.
Bundle-wide, id rows had fallen 71,231 → 64,284.

Trimming an out-of-world section is not evidence that a page is from a later
world. Only the era cuts are. So the empty branch asks which cut did it, and the
question is put to the **trim-only** text: the same section walker with the era
half switched off (`dropOutOfWorldOnly`, an `eraCuts: false` option, computed on
demand because only a page that came out empty ever needs it). If prose would
have survived the trim alone, the era cuts are what emptied the page and it is
dropped as before. If not, the page keeps its row with empty text, counted under
`empty_pages` and a new `pages_emptied_by_trim` — a subset, like the protection
counter, and outside the five-reasons identity, which an empty row does not
disturb: the row is counted under `empty_pages` and under no reason.

Era-only text was the obvious discriminator and is wrong: a Cataclysm page that
also carries an external-links section still has prose in its era-only text, so
it would have been kept. Trim-only is the one that separates the two cleanly.

An empty row is a row, not an FTS document. A page with no body is the shortest
document in the index, and letting bm25 rank its title against pages that have
something to say would buy the recovered ids with a ranking regression. It is
found by exact title and by id, which is all it is there for. (A future
`INSERT INTO pages_fts(pages_fts) VALUES('rebuild')` would regenerate the index
from `pages` and silently re-add every empty row; the build runs `'optimize'`,
which does not.)

Measured over the dump: post-Wrath drops 10,027 → 5,016, empty rows 1,899 →
6,910 of which 5,011 were emptied by the trim, id rows 64,284 → 71,751, coords
7,433 → 7,631, quest rows 7,889 → 7,907, pages kept 74,393 → 81,303, and 174
redirects that used to dangle now land. The canary passes. FOLLOW-UPS 49.

## Names survive page moves

Addendum, 2026-08-24. Every rule above asks which world a page is about. This
one asks a question none of them can answer: which world a *title* is about,
when MediaWiki has moved the page out from under it.

### Context
A move carries a page's whole history to the destination. When Cataclysm rebuilt
the low-level dungeons, the wiki moved this world's article aside and wrote the
new one under the bare title — so the bare title's oldest revisions are the move
itself and everything after is the later instance, while the 3.3.5 article lives
under `… (original)` or under a name the expansion invented. The era rules then
do exactly the right thing to the page and exactly the wrong thing to the name.
Measured over the dump (2026-08-24, scratch, not committed):

- `Deadmines` is a page first written in 2010-09 whose first revision is a
  redirect to `Deadmines (original)` and whose later pre-cutoff revisions are
  the Cataclysm article. Dropped, correctly — and then the name is gone.
- `Gnomeregan` has no revision before 2016 and is dropped as post-cutoff, though
  its newest revision is `#REDIRECT [[Gnomeregan (dungeon)]]` and that target is
  in the bundle.
- `Stormwind Stockade` chains: the name a character searches for points at
  `Stormwind Stockade (original)`, which is itself dropped and whose newest
  revision redirects on to `The Stockade (original)`, which is kept.

### Decision
**A name may be recovered from a revision the prose rules do not read, and
recovering a name never puts a page back.** Two rules, both candidate generation
into the one pending list that the existing bounded chain walk resolves:

- **Fall back to the newest revision.** When a Wrath-snapshot redirect's target
  dangles, the newest revision's target is tried before the candidate is counted
  dangling; when `admitPage` refuses a page whose newest revision is a
  `#REDIRECT`, that is pushed as a candidate. 183 and 1,277 names respectively.
  Counted as `redirects_recovered_newest`.
- **The `(original)`/`(old)` sibling.** After the stream, a bare title with no
  page and no redirect whose `T (original)` or `T (old)` sibling is in the
  bundle becomes a redirect to it, `(original)` winning when both exist. 68
  names, Deadmines, Ragefire Chasm and Scarlet Monastery among them. Counted as
  `redirects_original_sibling`.

Both feed the same six-hop walk, so the Stockade chain lands through a sibling
that is itself only a redirect, and whichever target actually resolves is the
one written — a row pointing at a title with no page and no redirect of its own
would be a dead row. Out-of-game titles are excluded: ADR-0040 drops a patch
archive rather than demoting it, and `verify.ts` checks exactly that by
resolving `Patch 4.0.1` through the redirect table.

**Stepping back through a page's revisions to find the pre-move article was
rejected.** It is the obvious alternative — walk back past the move and index
what the title said before it — and it does not work here. The revisions before
a move are the article the move took *with* it, so a title whose history was
carried away has none of them; what is left under the bare title is the
destination's history, which is the later world's text. Where a pre-move
revision does survive under the old title it is superseded text the wiki
abandoned, and the measured yield is about 3% of the names these two rules
reach. A name is cheap and a wrong article is not, so the rules recover the
name and let the reader land on the article the wiki actually kept.

**The accounting identity moves off `redirects`.** A redirect row can now be
generated for a title that is also a counted page, so the rows written are no
longer the pages that were redirects at the cutoff. Those are counted as
`pages_era_redirect`, and the identity the build test asserts is now the five
reasons plus `empty_pages` against `pages_in_namespaces - pages_era_redirect`.

**The canary grows the moved dungeons**: Deadmines, Ragefire Chasm, Gnomeregan,
Scarlet Monastery, Stormwind Stockade, Wailing Caverns, Shadowfang Keep,
Blackfathom Deeps, Razorfen Kraul and Uldaman, with Silverpine Forest, Redridge
Mountains and Ashenvale beside them. These are the titles a regression in either
rule empties, and counters cannot see it: the pages are all still in the bundle,
under names nobody types.

### Two leak rules from an adversarial read
Reading the built bundle looking for the later world rather than counting it
found two classes the rules above cannot reach, and both are now closed:

- **A category page's own title.** The category rule reads the categories
  written *on* a page; a category page carries none of its own, so
  `Category:Deepholm quests` sailed through every signal and 33 such stubs were
  in the bundle. In **ns 14 only**, a title naming a post-Wrath zone or feature
  is a post-Wrath signal. Never in ns 0: Mount Hyjal, Tol Barad, Gilneas and
  Uldum all have Wrath-era lore pages under those names, which is why
  `verify.ts` refuses to list them as forbidden titles. A title subpage suffix
  (`Global functions/Cataclysm`) reads like the parenthetical, because it says
  the same thing — the later client's fork of the page.
- **Prose that describes the later world without naming the expansion.** Rated
  battlegrounds, the Speedbarge moored in a Thousand Needles that is dry here,
  an inline `(Expansion: …)` tag, `playable` beside worgen or goblin,
  Archaeology the profession, and Mastery the stat. The last two are the narrow
  ones: a quest's archaeology team and the Stance Mastery and Tactical Mastery
  talents are in this world, so Archaeology fires only with no `dig site`,
  `team`, `unit` or `expedition` within 20 characters and Mastery only beside
  the 2010 dev voice. Both directions are tested. Speedbarge cuts a **line**
  rather than a block, because a block is as often a list of subzones as it is a
  paragraph. This is a dent in FOLLOW-UPS 62's paragraph residue, not a fix for
  it: prose that describes the later world in words no rule names is still there.

### Consequences
- Roughly 1,500 names come back, and no pages. What a model searching for
  `Deadmines` gets is this world's article under the title the wiki moved it to,
  which is what the redirect table has always been for.
- The counters say which rule earned which name (`redirects_recovered_newest`,
  `redirects_original_sibling`), and `pages_era_redirect` is the term that keeps
  the reason identity exact now that a name and a page can share a title.
- The residue is a name the rules recover that the bundle would rather not
  answer to. `verify.ts` resolves its forbidden titles through the redirect
  table, so the shape to watch on the next real build is a title like
  `Ruins of Gilneas` whose newest revision redirects to a Wrath lore page that
  survives: no parenthetical, no subpage suffix, and ns 0, so nothing above
  stops it. It is a gate failure rather than a silent leak, which is the right
  way round.
- Like every other era rule, this changes what every lane can read, so it lands
  with the same harness minor bump and the same deploy window.
