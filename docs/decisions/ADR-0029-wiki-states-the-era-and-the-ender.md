# ADR-0029: The reference bundle states the quest's ender and the wiki's era

Status: Accepted. Date: 2026-08-23.

## Context
Two findings from the 2026-08-23 night report sit on one seam: the bundle build
strips wikitext templates, and everything a quest page knows about itself lives
in one. ~150 turn-in timeouts across 17 of 18 runs came from turning a quest in
to the NPC that gave it when the ender is someone else — the wiki states the
ender in the infobox, and the strip removed it, leaving "Speak with ." A
nav-probe run read a 2020 page's Cataclysm section as current and spent its
session on a quest chain that does not exist in 3.3.5, because the era template
and heading markup were stripped too. Same shape as coordinates and ids: the
fact is in the wikitext, the strip destroys it, the fix is to lift it first.
Nothing here reads the server's DB or DBC (CONTRACTS.md).

## Decision
- The bundle carries the quest infobox as data (giver, ender, category), lifted
  from the named-argument infoboxes only, degrading like every other optional
  table so a live episode never loses search because the bundle is a version
  behind.
- **The ender is never inferred from the giver.** 11,013 pages state a giver and
  only 6,637 an ender; when the page does not say, the result says "turn-in NPC
  not stated". Guessing "same NPC" would manufacture a confident wrong answer in
  precisely the case this exists to fix.
- A quest hit leads with the infobox line, through the same redaction as the
  rest of the snippet, so names-first lanes (ADR-0033) gain no coordinate channel.
- **Every paragraph** of a post-Wrath era section is prefixed with an era label,
  because search returns a snippet window and a note at the top of a section is
  not in it. Pages the wiki says were removed in Cataclysm get the converse
  note. Nothing is deleted: flagging is verifiable and reversible; deletion
  loses prose that is often still correct and hides that anything was done.
- `search_reference`'s description carries one fixed sentence, identical in
  every lane, saying the world is 3.3.5a. This is the primary mitigation, not
  the fallback: a 2020 page's lead describes the post-Cataclysm world in the
  present tense with no label, and no build-time rule can tell that from
  Wrath-era prose.

## Consequences
- The tool description changes for every lane at once, so runs before and after
  are not comparable on the prompt axis — uniform, unlike a dimension.
- A page that states the wrong ender teaches the wrong ender; this is wiki
  reference, not ground truth, and the description already frames it that way.
- Unlabelled post-3.3.5 prose in page leads stays unfixed (FOLLOW-UPS 49).
