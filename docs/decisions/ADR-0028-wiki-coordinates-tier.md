# ADR-0028: Wiki coordinates are a run dimension, withheld in scored runs

Date: 2026-08-23. Status: accepted.

## Context

FOLLOW-UPS 18(4) shipped wiki infobox coordinates into `search_reference` on
2026-08-22: a hit can carry `zone (x, y)` lifted from the page's templates.
The navigation plan (FOLLOW-UPS 38) left one decision open: whether those
numbers belong in the scored lane at all.

Rungs 3 and 4 of the ladder are about whether a model can *find* things — a
questgiver, a flight master, the tram — in a world it can only observe
through a client's eyes. Exact yards are an answer key for that. With them
every model converges on the same three-step loop, search the name, read the
number, `moveTo` it, and the rung stops measuring the thing it exists to
measure. Without them a model has to do what a player does: read that the
NPC is "in the inn at Goldshire", walk there, look. That is harder, and
harder is the point; a ladder is useless if its lower rungs are trivially
climbable by every model.

Coordinates are still useful. The unscored navigation probe exists to learn
what the travel surface can do when the model is told where to go, and there
the numbers shorten the experiment rather than corrupt it.

## Decision

**`wikiCoords` is a run dimension (ADR-0024). Default false — names-first.
True only in freeplay/unscored lanes. Stamped into the comparability tuple
(ADR-0026) so the two never share a chart.**

1. `--wiki-coords` on the runner, `wikiCoords` on a roster entry or as a fleet
   lane default (entry wins). Every scored lane stays at the default; the
   nav-probe lane sets `true`.
2. When false, `search_reference` never sets the `coords` field, and bracketed
   coordinate-shaped pairs in snippet prose — `(48.2, 42.1)`, `[50, 41]`,
   `(48/42)` — are redacted to `(coords withheld)`. Templates and infoboxes
   are already gone from the stored text at bundle-build time, so the
   redaction covers only hand-written prose; it is best-effort by design and
   tested against the shapes the wiki actually uses.
3. The `search_reference` tool description states which side the run is on,
   in one fixed sentence per value, so a names-first model does not spend
   turns searching for numbers that are not there. The fixed system prompt
   no longer promises coordinates either way, so the prompt hash does not
   move with this dimension; the tuple field carries it.
4. `comparability.wikiCoords` is a grouping key on `/api/eval` and the Eval
   table, and is shown on the RunDetail panel. A tuple stamped before the
   field existed reads as "not recorded" and groups on its own.

## Consequences

- Start harder. If the names-only ladder proves unclimbable at rung 4 by
  every model tried, the pull-back is a labeled `coords` tier for the scored
  lane — a second row, never a silent change to the existing one. That is
  what the stamp is for.
- In-flight runs keep what they were launched with: the field is identity,
  not an override, so `--resume` reads it from `meta.json`.
- A lane's roster is materialized at spawn, so a long-lived lane process
  picks up a changed `wikiCoords` only on its next spawn (disable/enable
  toggle), and only for new episodes.
