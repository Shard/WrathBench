# ADR-0040: The bundle's prose comes from the Wrath-era revision

Status: Accepted. Date: 2026-08-24.

## Context
ADR-0029 marks the era sections the wiki labels itself, and says plainly what it
cannot reach: a 2020 page's lead is written present-tense about a world four
expansions past this one, with no marker at all. FOLLOW-UPS 49 is that half. It
stopped being theoretical when a nav-probe run read a starter-zone lead that
describes a pass as collapsed — it is not collapsed in 3.3.5a — and planned a
detour around it.

The dump is full history, so the revision from before the world changed is
already in the file we build from. A census over it (2026-08-24, scratch, not
committed) measured what swapping to it would cost:

- 81.3% of pages have a revision older than 2010-10-12; 18.6% do not, because
  the wiki kept growing after 2010.
- Starter-zone pages, the ones a new character is most exposed to, are exactly
  the ones that were rewritten: their pre-cutoff text is 0.30–0.90 of the newest
  by size. That is the divergence, not a loss.
- But a plain swap would cost 30% of the wiki coordinates and a slice of the
  entity ids: those live in infoboxes that were filled in over the decade after,
  and they are facts about ids and map positions, not about which world it is.
  Quest infobox coverage is unaffected (99.9%).

Cutoff candidates measured: 3.3.5's own release (2010-06-22), patch 4.0.1
(2010-10-12), the Shattering (2010-11-23), Cataclysm's release (2010-12-07).

## Decision
- **A hybrid, not a swap.** Each page is built from two revisions: the newest
  revision supplies the structured fields (coordinates, entity ids, quest
  infobox), and the newest revision before the era cutoff supplies the prose
  that is stripped and indexed. Redirect-ness is decided by the newest revision,
  so a page that redirects today stays a redirect.
- **The cutoff is 2010-10-12T00:00:00Z**, patch 4.0.1 — the client patch that
  shipped the world change, before Cataclysm's content. Not 3.3.5's own release:
  a page edited in the four months between is still describing the Wrath world,
  and holding that line costs 6.2 points more fallback pages for no gain in
  accuracy. Not the Shattering or Cataclysm's release: they buy 0.2–0.3 points
  fewer fallbacks and let in a month of beta-informed rewrites. It is a constant
  with a `--era-cutoff` build flag, written to `meta.era_cutoff` so a bundle says
  which line it was built at, and validated as a full ISO-8601 instant before the
  stream starts — a malformed one would compare wrongly and quietly turn every
  page into a fallback.
- **Two hygiene rules on the era winner, and only these two.** A candidate whose
  text is a `#REDIRECT` is skipped: the page is an article, and a revision where
  it was a redirect is not its prose. A candidate that was immediately reverted
  is skipped: the revision right after it restored a `sha1` the page already had,
  so its edit was undone. No size-drop or minor-flag heuristics — the census
  found `<minor/>` unused in this dump and a size heuristic would have thrown out
  1.7% of winners on suspicion. The revert test needs both a newer and an older
  revision and `<sha1>` is emitted after `<text>`, so it cannot be decided while
  streaming; it is decided at page finish over a per-page ledger of
  (timestamp, id, sha1), with the two newest passing bodies held so the runner-up
  is there when the newest is rejected. Two consecutive reverted revisions is
  past what that window sees, and the page keeps the older of the two rather than
  losing its prose.
- **Nothing is deleted.** A page with no pre-cutoff revision keeps its newest
  text and carries a fixed page-level label — `[this page was written after patch
  3.3.5; its content may not exist in this world]` — prefixed before the strip so
  it reaches the snippet window, the same mechanism ADR-0029's section notes use.
  Era-section marking still runs on whichever revision won.

## Consequences
- The reference surface changes for every lane at once, so this is a harness
  minor bump (ADR-0033 addendum): runs before and after are not comparable on
  what the model could read, and `meta.era_cutoff` is the evidence on the tuple.
- `schema_version` goes to 5, but no table is added or removed — the same
  `pages.text` column holds older prose. A version-4 bundle therefore keeps
  answering rather than failing closed; only the pre-`page_coords` bundles below
  version 2 still stop a run.
- The 18.6% of pages written after 2010-10 are labelled, not removed. A model
  that searches for something that only exists in Cataclysm now gets the page
  with a sentence saying so, which is strictly better than the unlabelled prose
  it got before and strictly worse than not having the page confuse it at all.
- The unlabelled-post-3.3.5-prose problem is now confined to those pages plus
  whatever a pre-4.0.1 editor wrote about the future. It is not closed, and the
  `search_reference` description keeps its standing sentence.
- Peak parser memory goes from one revision body to the newest body plus at most
  two era candidates. Bodies are held only while a page is open.
- Coordinates keep coming from the newest revision, so a coordinate can now be
  newer than the prose beside it. That was already the contract: they are
  wiki-reference notes about where something is, not claims about what the world
  looked like in a given patch.
