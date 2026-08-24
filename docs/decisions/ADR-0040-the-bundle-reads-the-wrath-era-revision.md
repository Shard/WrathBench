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
  place. If the cut empties a page that had prose, the page is dropped and
  counted as `dropped_post_wrath`.
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
  for it.
- The cost is a fact that only ever appeared under a dropped heading: a tactic
  written under `Trivia`, a spawn note under `History`. The census says that is
  a thin tail against 16% of bytes, and the drop set is one edit away if a
  trajectory shows otherwise.
