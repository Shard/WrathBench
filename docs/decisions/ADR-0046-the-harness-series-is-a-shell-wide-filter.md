# ADR-0046: The harness series is one shell-wide filter, not a per-page control

Status: Accepted. Date: 2026-08-24. Decided by the operator.

## Context

ADR-0034 makes the harness *series* — the `major.minor` of a version stamp — the
comparability group: a minor bump changes what a run measures and restarts the
evidence, a fix commit does not. Every page of the dashboard that shows runs is
therefore already a view of one series, whether or not it says so. Results and
the ladder group by it; the scheduler counts against it; a run from another
series is listed and never counted.

The dashboard had no way to say which one. The results table showed a `series`
column and the reader mentally filtered; the episodes listing mixed them.
Adding a picker to each page was the obvious next step, and would have produced
four controls that could disagree about what a shared link meant — the exact
failure the episode filter was consolidated into `lib/episodes.ts` to prevent.

## Decision

The operator decided: one series selector, in the top bar next to the status
badge, filtering every page that shows runs.

- The options are `all`, `latest`, then every series that has runs, descending.
  `latest` is stored as the token, never as the series it resolves to today, so
  it follows a minor bump instead of freezing on whatever was newest when the
  reader picked it. The newest series also appears under its own number: that
  looks redundant and is not — `latest` tracks, the number pins, and a link
  meaning "0.5 specifically" has to survive the next bump.
- The choice lives in `?series=` so a link is shareable, and in `localStorage`
  so the operator's own tab opens where they left it. URL first, then the
  remembered choice, then `latest`.
- A run whose stamp names no series is a member of no group, so it appears only
  under `all` — the same rule ADR-0030 applies to untiered runs.
- What the filter removed is stated on the page, not silently dropped. The rule
  is `EpisodeFilterNote`'s and it binds harder here: the control doing the
  dropping is in the header rather than on the page the reader is looking at.

This is *not* the `?harness=` filter of ADR-0035, which selects which loop owned
a run (`wrathbench` or `claude-code`). Different dimension, unfortunate shared
word. Both filters exist and compose; neither replaces the other. The new one is
spelled `series` everywhere for that reason.

## Consequences

Filtering is client-side. `/api/results` already carries `harnessSeries` on
every row and the charts group by it, so the filter costs a predicate rather
than a route parameter — and a route parameter shared by results and the ladder
is the thing ADR-0022's amendment keeps narrow.

`/api/info` gained the list of series that have runs, with counts. The shell
needs it before any page has loaded rows of its own, and `/api/info` is already
the route the shell polls: a poller per shell control is the budget ADR-0022
says not to spend. The field is optional, and a page unions it with the series
its own rows carry, so the dashboard keeps working against a viewer process
that predates it.

Two pages are deliberately not filtered. The fleet page is what is running
*now*, which is the deployed series by construction and carries no version on
its rows. The models page is the scheduler's verdict, which is computed against
the current series server-side (`otherSeries` is how it reports the rest);
filtering its rows client-side would make the counts and the list disagree.
Giving either an honest series filter is a server-side change, and nothing has
asked for one yet.

`/results` is unfiltered for a third reason, and a temporary one: it is being
replaced by `/runs` (ADR-0047), and the filter goes over with that page rather
than being fitted to one on its way out.
