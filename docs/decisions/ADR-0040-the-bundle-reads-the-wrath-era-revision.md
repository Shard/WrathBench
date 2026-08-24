# ADR-0040: The bundle is a Wrath snapshot

Status: Accepted. Date: 2026-08-24.

## Context

The reference bundle is built from a 2020 wowwiki dump and read by a model driving
a character in patch 3.3.5a. Four expansions of divergence sit between the two.
ADR-0029 marked the era sections the wiki labels about itself and left the rest,
which left the bundle carrying two kinds of text: text about this world, and text
about a later one with a note attached. A note costs the model a line of reading in
every snippet, does not survive a snippet window that starts after it, and still
leaves the wrong world in the index. The dump is a rough source; the bundle is a
product built from it, and what is not in this world has no reason to be in the
product.

A census over the dump (2026-08-24, scratch, not committed) bounds what a revision
cutoff can and cannot do:

- 81.3% of pages have a revision older than 2010-10-12; 18.6% do not, because the
  wiki kept growing after 2010.
- Starter-zone pages, the ones a new character is most exposed to, are exactly the
  ones that were rewritten: their pre-cutoff text is 0.30–0.90 of the newest by
  size. That is the divergence, not a loss.
- A plain swap would cost 30% of the wiki coordinates and a slice of the entity ids:
  those live in infoboxes filled in over the decade after. They are facts about ids
  and map positions, not about which world it is. Quest infobox coverage is
  unaffected (99.9%).
- Of the 20,407 pages with no pre-cutoff revision, 1,901 are provably post-Wrath, 15
  carry an explicit Wrath-or-earlier signal, and 18,717 say nothing either way.

Two further facts the cutoff alone cannot handle, both measured the same day. A
Cataclysm signal on a page is not always a statement about the page's subject: 588
pages that existed before the beta picked up `|patch=4.0.1` or a Cataclysm category
in a 2010 revision, Stormwind City and Durotar among them, and every one of them is
a place a character can walk into on this server. And a MediaWiki move carries a
page's whole history to the destination, so after Cataclysm rebuilt the low-level
dungeons the bare title holds the *new* article's revisions while this world's
article sits under `… (original)` — the era rules do the right thing to the page and
the wrong thing to the name.

## Decision

**The bundle is a concise Wrath reference. Anything that is not patch 3.3.5 is
removed at build time by deterministic rules, and every rule's count is written to
`meta`.** Removal is verifiable by rebuilding from the same dump, which is the
reversibility that matters; a label in a snippet is not.

**The cutoff is 2010-10-12T00:00:00Z**, patch 4.0.1 — the client patch that shipped
the world change, before Cataclysm's content. Not 3.3.5's own release: a page edited
in the four months between is still describing the Wrath world, and holding that
line costs 6.2 points more dropped pages for no gain. Not the Shattering or
Cataclysm's release: 0.2–0.3 points fewer drops, and a month of beta-informed
rewrites let in. It is a constant with an `--era-cutoff` flag, written to
`meta.era_cutoff` and validated as a full ISO-8601 instant before the stream starts.

**A surviving page is a hybrid, not a swap.** The newest revision supplies the
structured fields — coordinates, entity ids, quest infobox — and the newest revision
before the cutoff supplies the prose that is stripped and indexed. Two hygiene rules
on the era winner and only these two: a candidate whose text is a `#REDIRECT` is
skipped, and one that was immediately reverted is skipped (the revision right after
it restored a `sha1` the page already had). No size-drop or minor-flag heuristics —
`<minor/>` is unused in this dump and a size heuristic would have thrown out 1.7% of
winners on suspicion. Redirect-ness is decided from the same snapshot: a page that
was a redirect in 2010 is one here whatever it became later, and one that was an
article then is an article here even if it was merged away in 2014 (144 pages flip).

**One page-level decision, `admitPage` in `wiki/src/post-wrath.ts`**, a pure
function of the title, the namespace, the two revisions and — when the build was
given one — the world-id oracle of ADR-0042. It returns one of six reasons, each a
`meta` counter, and the six plus `empty_pages` account for every page the parser
yields except those that were a `#REDIRECT` at the cutoff (`pages_era_redirect`).
That is a build-test identity, so a page cannot be counted twice or lost quietly.
The counters are documented in `wiki/README.md`.

**Post-Wrath signals drop the page**: a title parenthetical or a `/Cataclysm`-style
subpage suffix naming a later expansion, a `[[Category:…]]` naming one, a
page-banner template, an infobox `|patch=` at 4.0 or later, or an `|expansion=`
naming one. They are read on the revision the prose comes from, never on a later
one, and they are narrow where the words collide: the Burning Legion, the 7th
Legion, Draenor as Outland's own name and `{{Removedwithlegion}}` are all Wrath
content, and the census's own tally (`Burning Legion` 39 against `Legion` 29) is why
"category contains Legion" is not a rule. In **ns 14 only** a category page's own
title is a signal, because the category rule reads the categories written *on* a
page and a category page carries none of its own — 33 such stubs were in a built
bundle. Never in ns 0, where Mount Hyjal, Tol Barad, Gilneas and Uldum all have
Wrath-era lore pages under those names.

**A page whose first revision predates 2009-08-21 (`CATACLYSM_ANNOUNCED`) is a Wrath
page, and a post-Wrath signal never drops it.** The wikitext cannot separate the 588
annotated Wrath pages from the 4,859-page mid-2010 bot import of beta-datamined
Cataclysm stubs: both say Cataclysm, in the same words, in the same fields. What
separates them is the page's age, which is deterministic, in the dump, and does not
require reading the server or judging prose. The line is the announcement rather
than the beta because the wiki began stubbing the expansion the same week BlizzCon
announced it: 119 of the 588 were created on or after that day and were mostly
Cataclysm content. It keeps roughly 500 of the 588. The section and paragraph rules
still strip what they strip, so the Cataclysm paragraph that arrived with the
category still goes; the page stays. Counted as `pages_pre_announcement_protected`.

**A protected page's prose is the newest pre-cutoff revision carrying no post-Wrath
signal — the page before the beta touched it.** The cutoff sits eight months into
the Cataclysm beta, which is exactly when the wiki rewrote this world's zone pages
into the next world's: `Uldum` and `Gilneas` were sitting in a built bundle as
Cataclysm zone articles, kept correctly by the protection and read incorrectly at
the wrong revision. Of 77,168 pages that predate the announcement and have
pre-cutoff prose, 510 carry a signal on the revision the bundle was reading and 495
have an earlier signal-free one. The parser holds it as a third slot under the same
two-deep window and revert hygiene as the era slot. **Stepping back is refused when
the older revision is under a quarter of the newer one's length** — an older
revision is sometimes a stub or a blanking, and trading an article for a blank page
is worse than reading the rewrite. 10 of the 495 fall under that line, the other 485
keep 88% of their text at the median, and nothing sits near it: the refused reach
0.17 at p90 and the accepted bottom out around 0.5. `pages_stepped_back` and
`pages_step_back_refused`.

**Names Cataclysm coined are vetoed by exact title in ns 0**, unconditionally and
before the protection: `Southern Barrens`, `Northern Barrens`, `Twilight Highlands`,
`Vashj'ir`, `Kelp'thar Forest`, `Shimmering Expanse`, `Abyssal Depths`, `The Lost
Isles`, `Lost Isles`, `Molten Front`, `Tol Barad Peninsula`. No revision of such a
page is about this world, and it has to be a veto rather than a signal: a signal
fires per revision, and a page whose every revision carries one lands in the
protection and is *kept*. Deepholm, Uldum, Kezan, Gilneas, Mount Hyjal, Tol Barad
and Grim Batol are deliberately absent — each is this world's own lore under that
name, and what those pages may *say* is gated by `verify.ts` phrases instead.

**Out-of-game pages are dropped, not demoted.** `classifyMetaPage` runs at build
time and the build does not emit what it classifies. The search band and its label
are gone, and with them ADR-0029's carve-out that kept an exact-title hit at the
top. That was decided, not forgotten — a hotfix archive is not a fact about this
world under any query.

**Inside a surviving page, three cuts run on the raw wikitext.** An era section
(`{{cata-section}}`, `== In Cataclysm ==`, and the April 2010 Cataclysm class
previews the wiki pasted into the class pages under standardised headings) goes,
heading and all: `sections_dropped`. An era paragraph matching a narrow phrase rule
goes: `paragraphs_dropped`. A bare mention of Deathwing, the Legion, Draenor or
Garrosh is not a rule, because all four are in this world, and
`{{Removedwithcataclysm}}` is not a drop signal, because content removed later
exists here. Then **a fixed set of out-of-world headings is trimmed** — the link
farms, the patch record, the lore and media sections — matched on the normalised
heading and only ever exactly, never as a prefix or a substring, which is what
separates `changes` from `past changes` and `notes and trivia` from `notes`. The
heading census says these are 16.3% of corpus bytes and name no coordinate, id,
giver or reward. Nothing is rewritten: a section is in the bundle in full or it is
not there, which is what keeps removal verifiable by rebuilding. The drop set and
the deliberately kept headings are listed in `wiki/README.md`; the code carries the
drop set only, because a keep list would have to be exhaustive to mean anything.
A section whose subtree carries no prose once everything is stripped is not emitted
at all — the test is on the subtree, since a heading with no text of its own but an
occupied subsection is a real heading.

**Which cut emptied a page decides what happens to it.** If the era cuts took all of
its prose the page is dropped as `pages_dropped_post_wrath`. If the out-of-world
trim did, the page keeps its row with empty text under `empty_pages` and
`pages_emptied_by_trim`. Trimming an out-of-world section is not evidence that a
page is from a later world; only the era cuts are. The question is put to the
**trim-only** text — the same section walker with the era half switched off
(`dropOutOfWorldOnly`), computed on demand because only a page that came out empty
needs it. Era-only text was the obvious discriminator and is wrong: a Cataclysm page
that also carries an external-links section still has prose in its era-only text.
Not making this distinction cost 5,011 pages of this world, with their ids,
coordinates and quest rows on them; the measured before-and-after is post-Wrath
drops 10,027 → 5,016, id rows 64,284 → 71,751, pages kept 74,393 → 81,303. An empty
row is a row and not an FTS document: letting bm25 rank a bodiless title against
pages that have something to say would buy the recovered ids with a ranking
regression.

**A name may be recovered from a revision the prose rules do not read, and
recovering a name never puts a page back.** Two candidate-generation rules feed the
one pending list the existing bounded chain walk resolves. First, fall back to the
newest revision: when a Wrath-snapshot redirect's target dangles, the newest
revision's target is tried before the candidate is counted dangling, and a page
`admitPage` refuses whose newest revision is a `#REDIRECT` is pushed as a candidate
(183 and 1,277 names, `redirects_recovered_newest`). Second, after the stream, a
bare title that does not already answer whose `T (original)` or `T (old)` sibling is
in the bundle becomes a redirect to it, `(original)` winning when both exist (68
names, `redirects_original_sibling`). The sibling rule runs last and over the titles
still unanswered, because whether a title answers is only known once its chain has
been walked — reading "is a redirect source" as "answers" is what once hid this
world's Scarlet Monastery. Out-of-game titles and the coined ns-0 titles above are
excluded from recovery, on the source side too, so a name like `Ruins of Gilneas`
never resolves from any direction. Stepping back through a page's revisions to find
the pre-move article was rejected: the revisions before a move went *with* it, what
is left under the bare title is the destination's history, and the measured yield
where a pre-move revision does survive is about 3% of the names these rules reach.
A name is cheap and a wrong article is not.

**A canary guards the result, before the rename.** `wiki/src/canary.ts` holds the
titles a patch-3.3.5a reference cannot be missing — the ten capitals, the eight
racial starting zones, the classic and Wrath zones an over-broad rule reaches first,
and the dungeons Cataclysm moved (Deadmines, Ragefire Chasm, Gnomeregan, Scarlet
Monastery, Stormwind Stockade, and the rest) — checked through redirects after the
indexes are written and before the temp bundle is renamed into place. A miss fails
the build, names every missing title, and leaves the deployed bundle alone.
`--max-pages` smoke builds skip it. `wiki/src/verify.ts` is the operator-run gate on
an already-written bundle, adding Cataclysm-or-later titles that must not exist
(resolved through the redirect table) and phrase pairs on named pages. This is the
lesson the 588 pages taught: six thousand pages dropped, every counter adding up,
and no capital city. **A rule that is one word too broad is invisible to counters
and obvious to a list of names.**

**`search_reference`'s description carries one fixed sentence** saying the bundle is
a Wrath-era snapshot of the wiki describing this world, and to prefer what can be
observed in game.

## Consequences

- The reference surface changes for every lane at once, so this is a harness minor
  bump (ADR-0033): runs before and after are not comparable on what the model could
  read. `meta.era_cutoff` and the `pages_dropped_*` counters are the evidence on the
  tuple, and they are also what tells a version-5 bundle built before this from one
  built after.
- `schema_version` stays 5. No table is added or removed — the same `pages.text`
  column holds fewer, older rows — so a bundle one version behind keeps answering;
  only the pre-`page_coords` bundles below version 2 still stop a run.
- The bundle is smaller and its coverage narrower. A model asking about something
  that only exists in Cataclysm gets nothing rather than a page with a note, which
  is the intended answer: it does not exist here. Roughly 1,500 names come back
  without their pages, which is what the redirect table has always been for.
- The zone pages a starting character reads describe the world the character is
  standing in. Stormwind City's prose moves from 2010-10-07 to 2010-05-06 and stays
  a full article (28,608 → 25,278 characters); Durotar, Ashenvale, Desolace, Thousand
  Needles, Westfall and the rest of the reshaped zones move the same way.
- **The step-back does not reach a rewrite that left no signal.** Deepholm and Kezan
  are the counterexample: their beta-era revisions carry no category, banner or
  patch field, so they are already signal-free and their prose is still the
  2010-09/10 revision. The `verify.ts` phrases are the only gate on that residue, and
  it is a real one — FOLLOW-UPS 62.
- The cost of the cutoff is the pages it drops that were right about 3.3.5 and did
  not say so — most of the 18,717. ADR-0042's id oracle is the partial way back.
- The cost of the heading trim is a fact that only ever appeared under a dropped
  heading: a tactic written under `Trivia`, a spawn note under `History`. The census
  says that is a thin tail against 16% of bytes, and the drop set is one edit away.
- Coordinates keep coming from the newest revision, so a coordinate can be newer
  than the prose beside it. That was already the contract: they are wiki-reference
  notes about where something is, not claims about what the world looked like in a
  given patch.
- The canary is a fixed list, so it is a maintenance surface: a title a future dump
  spells differently fails a good build. It is checked against the dump when it
  changes, and redirect resolution absorbs the common case.
- The step-back costs a regex prefilter and, on the revisions that pass it, one
  `hasPostWrathSignal` call: 110,192 revisions over 91,108 pages, 26.5% past the
  prefilter, 0.96s of a 43s pass over 22.2 GiB. Peak parser memory is the newest
  body plus at most two era candidates, held only while a page is open.
