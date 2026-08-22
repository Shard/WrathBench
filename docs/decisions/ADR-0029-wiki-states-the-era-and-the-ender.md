# ADR-0029: The reference bundle states the quest's ender and the wiki's era

Date: 2026-08-23. Status: accepted.

## Context

Two findings from the 2026-08-23 night report sit on the same seam: the bundle
build throws away the wikitext templates, and everything a quest page knows
about itself lives in one.

- **Turn-ins.** ~150 `EventTimeoutError`s across 17 of 18 runs came from turning
  a quest in to the NPC that gave it when the ender is someone else (§2a). Quest
  783 failed identically in three independent runs across three models — a
  discoverability gap, not model confusion. The wiki does state it
  (`{{questbox | start=… | end=… }}`), but `stripWikitext` removes every
  template, so the stored text for quest 783 reads "Speak with ." with the
  ender's name gone from the page entirely.
- **Era.** The dump was taken in 2020, four expansions past this server. A
  nav-probe run read that Coldridge Pass is collapsed and the valley's exit is a
  gyrocopter quest chain, and spent the rest of the session on a chain that does
  not exist in 3.3.5 (§4). That paragraph sits under `== Cataclysm ==` and
  `{{cata-section}}` on the page — and the strip removes both the template and
  the heading's markup, so the label never reaches the index.

Both are the same shape as coords (ADR-0028 predecessor) and ids (FOLLOW-UPS
25): the fact is in the wikitext, the strip destroys it, the fix is to lift it
before the strip. Nothing here reads the AzerothCore DB or DBC tables; it stays
inside what the wiki bundle already holds (CONTRACTS).

## Decision

**The bundle carries the quest infobox as data and marks the wiki's own era
labels in the text. `search_reference` leads a quest hit with giver and ender,
and its description states the world's patch.**

1. `page_quest (page_id, start, end, category)`, schema 4, lifted by
   `extractQuest` from the named-argument infoboxes (`questbox`, `questinfo`)
   only — `{{questlong|…}}` is a list-item template on index pages and states
   neither. Degrades like `page_ids`, never fails closed: a live episode must
   not lose search because the deployed bundle is a version behind.
2. **`end` is never inferred from `start`.** 11,013 quest pages in this dump
   state a giver and only 6,637 state an ender. When the page does not say, the
   result line says "turn-in NPC not stated on this page". Guessing "same NPC"
   would manufacture a confident wrong answer in precisely the case this exists
   to fix.
3. A quest hit's snippet leads with `[quest infobox: starts at X; turn in to Y;
   category Z]`, through the same redaction path as the rest of the snippet, so
   ADR-0028's names-first lanes gain no coordinate channel. Names are what
   names-first means.
4. `markEraSections` runs before the strip and prefixes **every paragraph** of a
   post-Wrath era section — by `{{cata-section}}`-style template or by heading
   text — with `[Cataclysm-era, not in patch 3.3.5]`. Per paragraph because
   search returns a snippet window and a note at the top of a section is not in
   it. Pages the wiki says were *removed* in Cataclysm get the converse note:
   they exist here.
5. Nothing is deleted. Flagging is verifiable and reversible; deletion loses
   prose that is often still correct, and hides that anything was done.
6. `search_reference`'s description carries a fixed sentence, identical in every
   lane, saying the world is patch 3.3.5a and that Cataclysm-and-later
   statements do not apply. This is the primary mitigation, not the fallback:
   a 2020 page's *lead* describes the post-Cataclysm world in the present tense
   with no label at all ("was linked … prior to its collapse"), and no
   build-time rule can tell that from Wrath-era prose.

## Consequences

- The `search_reference` description changes for every lane at once, so runs
  before and after are not comparable on the prompt axis. That is deliberate and
  uniform — unlike ADR-0028 §3, which kept a *dimension* out of the prompt hash
  precisely so two lanes could differ. Nothing differs between lanes here.
- Schema 4 needs a bundle rebuild (~45s, reproducible from the same dump). An
  un-rebuilt bundle serves search exactly as before, minus both channels.
- The extractor is deterministic parsing of wikitext, like coords and ids. A
  page that states the wrong ender teaches the model the wrong ender; this is
  wiki reference, not ground truth, and the tool description already frames it
  that way.
- Unfixed: unlabelled post-3.3.5 prose in page leads. Tracked in FOLLOW-UPS.
