# Dashboard

The operator SPA over the viewer's read-only API: fleet overview, one page per
run, and the live map. SolidJS + Vite, TypeScript strict, no CSS framework.

Why an SPA and why a dependency at all: docs/ARCHITECTURE.md (dashboard section).

## Running

Two ways, and they must behave the same.

**Development** — Vite serves the SPA and proxies `/api` and `/tiles` to a
viewer you run yourself:

```
bun runner/viewer/serve.ts          # terminal 1: the API, on 127.0.0.1:8090
bun run dashboard:dev               # terminal 2: http://127.0.0.1:5180
```

`WRATHBENCH_VIEWER_ORIGIN` points the proxy somewhere other than 8090 — useful
when the operator's own viewer already owns that port.

**Production** — build once, and the viewer hosts the result itself:

```
bun run dashboard:build             # writes dashboard/dist
bun runner/viewer/serve.ts          # http://127.0.0.1:8090
```

The viewer serves `dashboard/dist` when it exists. When it does not there is no
UI at all — page routes answer with a plain-text notice naming the build command
— so a checkout that wants the dashboard has to build it.
`WRATHBENCH_DASHBOARD_DIR` overrides where the viewer looks.

**Public** — the same SPA, reading published JSON snapshots out of a bucket
instead of a viewer (docs/PUBLIC-DASHBOARD.md). One build-time flag selects it:

```
VITE_WRATHBENCH_SNAPSHOT_BASE=https://wrathbench-data.shard.page bun run dashboard:build
```

Minimap tiles are a separate flag, `VITE_WRATHBENCH_TILES_BASE`, and separate
on purpose (`src/lib/tiles.ts`): they land in the bucket by a hand-run
`infra/publish-tiles.ts --upload` and never by a snapshot pass, so deriving the
one flag from the other would have a JSON publish assert that tiles are there.
The public site sets it to the data hostname. Unset, the map requests no tile
and draws its labelled grid — the same thing the viewer does under
`WRATHBENCH_VIEWER_PUBLIC=1`, and the right build from a checkout that never ran
the extraction. The private build sets neither flag and serves tiles same-origin
as always.

The other build-time flags are `VITE_WRATHBENCH_PUBLIC_ORIGIN` and
`VITE_WRATHBENCH_OG_STAMP` (the social card's tags, docs/PUBLIC-DASHBOARD.md)
and `VITE_WRATHBENCH_REPO_URL` — where the source lives. Unset or empty, which
is the default in both builds, the footer's repository link and the BibTeX
`url` line on `/about` are not rendered at all: the link is not turned on yet
and one that 404s is worse than none. Set it to the repository's URL and both
appear; `infra/deploy-dashboard.sh` passes it through from `WRATHBENCH_REPO_URL`
in `.env`, so turning the link on is one env line and a redeploy
(`src/lib/repo.ts`).

Set, `src/api/client.ts` hands the pages `createSnapshotClient` instead of
`createClient`; unset, nothing about the private build changes. The snapshot
client implements the same `Client` interface — it resolves a manifest, reads
generation-addressed artifacts, and re-applies the `?episode=`/`?harness=`
filters client-side over the published projection — so no page knows which one
it is talking to. Every page keeps the poll interval stated at its call site;
a ~30s memo inside the client is what keeps a 5s poller off the network.

Three things a bucket cannot serve, and the guards that go with them: entry
summaries and raw trajectory lines answer 403 the way
`WRATHBENCH_VIEWER_PUBLIC=1` does, the run page opens no SSE tail, and the map
draws its labelled grid without asking for a tile (they are the only
Blizzard-derived bytes in the stack and never leave the lab). The shell gains
a "data as of Ns ago" line — the publisher's clock, kept separate from the
supervisor's heartbeat in the status badge — and the attribution footer every
published artifact carries.

## Routes

| route | what |
| --- | --- |
| `/` | the homepage: what WrathBench is, the execution loop as a diagram, the eight model-facing tools as an inspector (read off `/api/tools`, never copied), the SDK families, and a live-now line off the positions feed |
| `/fleet` | fleet overview: the supervisor, the gate, one table of jobs and accounts, paused and ended runs |
| `/about` | the meta page: how to read a result, the two harness groups, the tiers (what each id fixes, how many runs sit against it; a member count leads to its ladder), pointers to the docs; `/episodes` redirects here |
| `/runs` | every run, as a sortable table — the per-run grain; `/results` redirects here |
| `/ladder` | one tier at a time: a scatter of average cost per run against average XP earned, one point per model, over the rungs each model has reached. `freeplay` is the exception — the active field, one stepped line and one row per durable character, level against cumulative active playtime |
| `/models` | the roster with the scheduler's verdict on each entry |
| `/campaigns` | probe campaign coverage: cells swept, by how many models |
| `/run/:id` | one run, turn by turn, following the file live |
| `/character/:id` | one durable character across its attempts: the climb, the totals, the live session when one runs |
| `/config` | the config store, operator only — the page withholds itself on the public build |
| `/map` | every live agent on the world map; `/map?run=<id>` replays one run's recorded track, with the transport bottom centre |

`/run/:id` has one remembered preference of its own beside the autoscroll
toggle: the expand preset over the feed (`minimal`, `responses`, `snippets`,
`all`), which sets where every foldable block starts. It is a default, not a
lock — each block keeps its own toggle, and changing the preset returns them
all to the new default. Two record kinds get their own rows rather than the
generic JSON dump. A state sample reads as one line (level, xp, zone/area ids,
money, quests, position) that expands to the whole record. The harness's own
voice is drawn as a callout wherever it appears — a `harness` record that
carries text (a sandbox restart, a truncated turn), and the block appended to a
snippet result under a `--- harness ---` rule by `runner/src/tools.ts` — because
it is the harness talking to the model rather than the tool's output; a
`harness` record with no text is bookkeeping and stays one quiet line. The pure
half is `lib/feedview.ts` and its tests.

A durable freeplay character is one character across attempts, so `/runs` and
`/run/:id` say where a run sits in its chain ("attempt 2 of 3 · continues a11",
both directions linked on the run page) rather than listing a12 as an unrelated
row beside a11, and the chain has a page of its own at `/character/:id` — the
whole climb with its session boundaries, the totals, the live session when one
runs, and every attempt. Every run has one: a scored run's character is a chain
of one attempt, so nothing branches on "is this freeplay" to know where to
link, and navigation stays freeplay-first (freeplay rows lead to the character,
scored rows to the run). The walk is `lib/lineage.ts`, shared with the ladder's
`characterRows`, and it is indexed over every run the server served — a
character that crossed a minor bump has its predecessor outside the series
filter, which is where the line is worth the most. The table itself never reorders: it sorts
thirteen ways, so the text is the link and the rail on the run cell is only
what adjacency happens to give.

One page per grain: the fleet page is what is
running *now* and links to a run, never listing them; `/runs` is the runs;
`/about` is the tiers; `/ladder` is aggregates over runs. A tier's member
count on `/about` leads to that tier's ladder, and a point on the ladder's
chart leads to the runs behind it.

## The series selector

The harness series (`major.minor`) is the comparability group, so every page
that shows runs is a view of one. There is one selector for all of them, in the
top bar — `all`, `latest`, then each series with runs, descending —
and it filters `/runs`, `/ladder` and the live agents on `/map`; `/episodes`
lists no runs, so it has nothing to filter. `latest` is stored as the token, so it
follows a minor bump. The choice
rides in `?series=` and in `localStorage`; the URL wins, so a shared link means
what its sender saw.

It is not the `?harness=` filter, which selects which *loop* owned a
run (`wrathbench`, `claude-code` or `codex`). Different dimension, same word. `/runs`
still filters on it by clicking a cell; the ladder no longer offers it as a
control (the harness is a tag on each row and a colour on each point, not a
partition), and offers neither `all` nor overridden runs as an episode choice —
a rung and a scatter are claims about one comparability group.

`/` and `/models` are not filtered: the fleet is what is running now, and the
models page is the scheduler's verdict computed against the current series
server-side. `lib/harness.ts` holds the pure half and its tests.

## Structure

```
src/api/      typed client over the viewer JSON endpoints, the SSE tail, and
              the snapshot client the public build reads a bucket with
src/lib/      pure helpers: view maths, formatting, polling
src/pages/    one file per route
src/components/  the shell and the pieces shared between pages
```

Three modules are imported from the viewer rather than copied, under the
`@viewer/*` alias:

- `runner/viewer/api-types.ts` — the wire shapes. The viewer imports the same
  file, so a drift between what it serves and what this expects is a compile
  error rather than a runtime surprise.
- `runner/viewer/worldmap.ts` — the world→tile transform.
- `runner/viewer/lineage.ts` — the freeplay chain walk. The server aggregates a
  whole character on it (`runner/viewer/character.ts`) and this side draws the
  attempt strip on it, so one walk answers both.

All three are import-free by construction, so nothing server-side follows them
into the browser bundle.

## Tests

`bun test` from the repo root runs them with everything else. They cover the
pure layer — view maths and pip placement, the API client's paths, encoding and
error mapping — plus a focused shared-axis component regression. That regression
uses the small `happy-dom` harness to mount the Solid `<For>` loops and update
retained SVG ticks in place; the rest of the suite does not need a DOM.

## Conventions

- Nothing here writes. There is no client method that sends a body, because
  there is no route that takes one.
- Paths are root-relative, so the same code runs behind the dev proxy and
  same-origin off the viewer. That is why there is no CORS configuration.
- Polling intervals are stated at each call site, not hidden in `poll()` —
  docs/ARCHITECTURE.md (dashboard section) names polling rate as a
  public-hosting constraint.

## Where the copy lives

All under `dashboard/src/`: `pages/Home.tsx` (intro, chart heading, loop
diagram labels, can/can't lists, tools prose), `pages/About.tsx` (status,
reading a result, legal, cite), the other `pages/*.tsx` for per-page
headings, tooltips and empty states, `components/LadderChart.tsx` (chart
caption and hover), `lib/format.ts` (`COST_BASIS_NOTE`), `lib/status.ts`
(status popout), `components/SeriesSelect.tsx`, `lib/attribution.ts` (the
footer line, pinned by test to `runner/viewer/public-projection.ts`
`PUBLIC_ATTRIBUTION` — change both). Tool examples in the inspector come from
`runner/viewer/tools.ts` via `/api/tools`, so the publisher needs a restart
after editing them. To ship copy edits to the public site: `bun ship` (tests, snapshot-mode
build, wrangler deploy, then restores the private viewer's `dist`); `bun ship
--publisher` after `runner/viewer` changes, `bun ship --tiles` after a minimap
extraction; `bun run viewer:restart` for the private viewer;
`bun run deploy:worldserver` for the module (`infra/k8s-deploy.sh`;
`bun run deploy:worldserver:compose` is the rehearsal stack's).
