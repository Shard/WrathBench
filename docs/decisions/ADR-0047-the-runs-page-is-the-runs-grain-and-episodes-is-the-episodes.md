# ADR-0047: The runs page is the runs grain, and episodes is the episodes

Status: Accepted. Date: 2026-08-24.

## Context

ADR-0022's amendment named one page per grain: fleet for what is running now,
episodes for the runs, results and ladder for aggregates over them. In practice
the results page had become a chart-and-picker wall — a tier chip row, a
harness chip row, a level chip row, a metric toggle, a character chip row, a
bar chart and then the rows — and it opened on one tier with the rest filtered
away. Finding a run meant knowing which page and which chips. Meanwhile the
episodes page carried a full per-run table under its tier definitions, so the
runs were listed in two places and neither was the place to find *all* of them.

## Decision

The operator's direction, verbatim in spirit: the results page becomes the
runs page; it is consolidated into a dedicated table for finding every run
no matter what it is; it feels like a spreadsheet; the bar chart goes; it
opens on all runs ordered by start time. And, on review of the first cut:
episodes is **not** folded into runs. It stays as its own page, refocused on
the episodes themselves.

So the dashboard has three grains over runs, plus the one over the present:

- **Episodes** (`/episodes`) — the tiers: what each id fixes about a run, how
  many members, overridden and labeled runs sit against each, and a link to
  the runs of that tier. It lists no runs of its own.
- **Runs** (`/runs`) — the runs: one row per recorded run, every kind (scored,
  probe, freeplay, objective; live, paused, ended; any series the shell's
  selector admits), opening on all of them newest first. Every header sorts;
  the sort and every filter are in the URL; a value in a cell is the link
  that narrows to it. A row links to the run page and the run page links back
  with the same query.
- **Ladder** (`/ladder`) — aggregates over runs: the rungs per model (ADR-0018).
- **Fleet** (`/`) — now.

`/results` redirects to `/runs`, query intact. There is no `/results` any
more and no aggregate "what a level costs" table: the ladder's level-and-xp
columns already say how far each model got, and the level-cost bar chart was
answering a cost question the operator does not want a chart for. It is
deleted rather than moved, along with the grouping maths behind it
(`groupsForLevel`); if a cost-per-level view is wanted later it is a new
page with its own reason, not a chart smuggled back onto this one.

## Consequences

- `dashboard/src/lib/results.ts` becomes `lib/ladder.ts` (the rung rules and
  the character helpers the ladder needs, unchanged) and `lib/runs.ts` (the
  table's columns, sort, filters and readings). The results grouping is gone.
- The viewer's `ResultRun` grows `live` and `endedAt` so the status column is
  the viewer's own reading rather than a guess; the page degrades to the
  recorded reasons against a viewer that predates them. The 8090 viewer needs
  a restart to serve the fields.
- Cross-page links (`runsHref` in `lib/runs.ts`) have one spelling; the
  `episodesHref`/`resultsHref` pair in `lib/models.ts` is replaced by it.
- ADR-0022's amendment is superseded on where the runs live: `/runs`, not
  `/episodes`.
