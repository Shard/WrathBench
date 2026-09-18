# Run viewer

A read-only web view of run trajectories, live and finished. It exists so an
operator can watch a run and see where it is stuck without tailing 3 MB of
JSONL by hand.

## Running

Since the 2026-09-08 cutover the viewer is the `wrathbench-viewer` Deployment on
the cluster, behind the `wrathbench.[removed].shard.page` Ingress (alias `wrathbench.local`)
(`docs/[removed]`); its code is baked into the runner image and Flux
owns the tag, so it comes back on its own and new viewer code needs a new tag
rather than a restart. `bun run viewer:restart`
(`infra/viewer-restart.sh`) rollout-restarts that Deployment and checks
`https://wrathbench.[removed].shard.page/api/info` — it kicks a wedged process, it does not
deploy anything. The workstation's systemd user unit
(`infra/wrathbench-viewer.service`) is retired and disabled, kept only for the
compose rollback, which is what `viewer-restart.sh --local` drives.

Locally — a rehearsal, a bare clone, or development on the pages — it is still
one process:

```
bun runner/viewer/serve.ts        # from the repo root
```

Then open http://127.0.0.1:8090. A bare clone works: an absent runs directory
is created empty, and every page serves its labelled empty state.

- `WRATHBENCH_VIEWER_PORT` overrides the port (default 8090).
- `WRATHBENCH_RUNS_DIR` overrides the runs directory (default `data/runs`).
- `WRATHBENCH_MINIMAP_DIR` overrides the tile root (default `data/minimap`).
- `WRATHBENCH_DASHBOARD_DIR` overrides where the built SPA is looked for
  (default `dashboard/dist`).
- `WRATHBENCH_VIEWER_PUBLIC=1` serves every JSON body through the public
  projection (`public-projection.ts`, and the game-prose redactor
  `redact-prose.ts` on `/entries`), and withholds the routes with no projected
  form: raw entries, minimap tiles and the SSE tail. It is what the snapshot
  renderer runs its in-process handle as; it is **not** a way to expose the
  viewer publicly (`docs/PUBLIC-DASHBOARD.md`, "The live viewer is not a public
  service").
- `WRATHBENCH_VIEWER_TILES_PUBLIC=1` serves minimap tiles in public mode
  anyway. Off by default, and a no-op on its own.
- `CLICKHOUSE_URL`, with `CLICKHOUSE_USER` / `CLICKHOUSE_PASSWORD` /
  `CLICKHOUSE_DATABASE`, point the listing routes at the derived store
  (`clickhouse.ts`; what it is and how it is filled are docs/ARCHITECTURE.md
  and `collector/README.md`). Unset, the viewer builds the same rows in memory
  by running the collector's own ingestion over the runs directory — the same
  code, so a row means the same thing, but it does once per start what the
  store does once, ever. That is a quickstart, not a deployment. Which one is
  in use is printed in the startup line.

## This directory is the API; the UI is the dashboard

The UI is a SolidJS SPA in `dashboard/`, and this directory is
the API it reads plus the static host that serves it. Build it with
`bun run --cwd dashboard build`; the viewer picks it up from `dashboard/dist`
with no further configuration.

The hand-written pages this directory used to serve were deleted on 2026-08-22
(item 31). There is no fallback UI: with no build on disk every page route
answers with a plain-text notice naming the build command, and `/api` keeps
serving throughout. What the dashboard renders is documented in
`dashboard/README.md`; what follows is what the server decides before the UI
sees it.

## Loopback only

The viewer binds 127.0.0.1. Trajectories contain game-derived text — quest text,
NPC and item names — and per `docs/DATA-AND-LEGAL.md` none of it leaves this
machine. Setting `WRATHBENCH_VIEWER_HOST` to anything else is a startup failure
that prints why, unless `WRATHBENCH_VIEWER_LAN=1` explicitly opts a trusted
private network in. That opt-in is for a LAN, not the internet: it lets someone
on the same network read pages, and reaches nothing else — the module stays
loopback regardless. Public hosting is intended eventually and is not this;
the viewer/dashboard section of `docs/ARCHITECTURE.md` carries what has to be
settled first.

Opting in takes two steps, and the second is the one that gets forgotten:

```
WRATHBENCH_VIEWER_LAN=1 \
  WRATHBENCH_MODULE_URL=http://<worldserver container ip>:8086 \
  WRATHBENCH_FLEET_CONFIG=infra/fleet.json \
  bun runner/viewer/serve.ts            # now binds 0.0.0.0:8090

# and the host firewall, scoped to the LAN — NOT a bare --add-port, which
# would open 8090 to every network in the zone:
sudo firewall-cmd --permanent --zone=public --add-rich-rule=\
  'rule family="ipv4" source address="192.168.1.0/24" port port="8090" protocol="tcp" accept'
sudo firewall-cmd --reload
```

`--permanent` matters: a runtime-only rule is lost on the next reload or reboot,
which is how this was set up the first time and why it stopped working. Note that
`curl http://<lan-ip>:8090` **from the host itself** succeeds even with the port
firewalled — that traffic is delivered over `lo` and never crosses the zone — so
verify from another machine, or the check proves nothing.

It also only ever reads. Each `run.sqlite` is opened readonly, so a run being
written by the harness inside the container is never disturbed, and an old run
directory never gains a schema it did not have.

## The run listing

`/api/runs` lists every directory under `data/runs`, newest first: model,
unscored stamp (the legacy `shakeout` key), harness tag, character, harness version, latest level, XP, money and completed
quests from the `state` table, when it started, playtime, total tokens, and how
it ended.

Playtime (`playtimeMs`, on the listing rows and on `/api/run/<id>`) is *active*
time, not the span the trajectory covers: a segment opens at the `meta` record
and at each `resume`, and closes at each `pause` or `termination`, with an open
segment running to now for a live run and to its last entry otherwise. A run
that a rate limit paused and `--resume` picked up hours later would otherwise
read as having played through the gap. It is computed here, once, so the fleet
table and the run page cannot disagree. Note that this is not the
`episode-limit` watchdog's clock, which is per-process uptime since the current
resume and so never sees paused time.

Tokens per second (`tps`, on the listing rows and on `/api/run/<id>`) is output
tokens over the wall time of the model's REPLIES, never over the run's elapsed
time, most of which the harness spends driving the game. A span opens at a
record that hands the model something to answer — the `request` on the fixed
loop, the `snippet_result` or `tool_result` the CLI was waiting on under
claude-code — and closes at the last `response` before the next such record.
Replies rather than turns because a turn is not the same unit under the two
drivers: `fleet-sonnet-e360-sonnet-20260824` is one `request` and 2,833
`response` records, so timing "a turn" there would time the whole six-hour
episode. Ambient records (`state`, `milestone`, `claude_system`) are ignored
rather than treated as boundaries — they are written by timers while the model
is mid-reply, and one restarting the clock reads as a speed the model never had.
A span still in flight, and one a `pause`/`resume`/`termination` landed inside,
count for nothing. Two figures ride together: the whole run, and the last ten
replies, each summed as Σ tokens ÷ Σ seconds rather than averaged over replies.
Tokens are provider-reported where any record of the span reported usage and
`chars ÷ 4` only where none did — the claude-code driver's last envelope carries
the running total for the whole reply, so estimating the earlier ones alongside
it would count their text twice. `tokenTotals` reads the same spans
(`replySpans`), so the run's completion total and its rate can never disagree
about what one reply produced.

The claude-code driver is the exception on the OUTPUT side, fixed 2026-08-25.
Its `response` envelopes carry the API's `message_start` usage, whose
`output_tokens` is the snapshot taken before the reply exists — one to
thirty-odd tokens, never the finished count — while its input figures are
right. Summing them read ~300× low (508 responses summing to 671 output tokens
on a run whose 23 `claude_result` records report 207,062). So where a turn has a
`claude_result`, the viewer takes that turn's output from it and ignores the
snapshots, and the turn becomes the measured unit for `tps`: the result's
`output_tokens` over the SUM of that turn's span clocks, each timed by the rule
above (so a stretch across a pause drops out). The clock stays model time, which
keeps the figure comparable to the fixed loop's request-to-response; the CLI's
own `duration_api_ms`, then `duration_ms`, stand in only for a turn with no
measurable span at all. `duration_ms` is not the default denominator on purpose:
on the 2026-08-25 haiku run it sums to 5,283,659 ms of a 5,400,000 ms episode,
which is the run's elapsed clock with every MCP round trip in it.

The result's `iterations` array is documented as one
entry per API call but holds only the last call on every CLI version logged so
far, so the per-reply path is gated on the entries summing to the turn total —
true on a one-call turn, declined on everything else. A turn with no result (in
flight, or cut short by a watchdog) keeps its snapshot figures, which are all
anyone has for it.

A run where NONE of the turns produced a result — 21 of the 29 claude-code runs
on disk on 2026-08-25, because a watchdog kill is the normal ending — has a
completion total resting entirely on those snapshots, and `tokenTotals` reports
`source: "snapshot"` for it rather than `"reported"`. It is neither an estimate
nor a measurement: provider-reported and known to be far too low, so the run page
labels it "snapshot — under-read" and marks the rate the same way. A run that
resolved its turns and was cut off mid-flight on the last one stays `reported`;
labelling that `snapshot` over a handful of tokens would be the same mistake
pointing the other way.

The figure is comparable within a lane and roughly so between the drivers: a
claude-code turn is timed by its own spans, each of which runs from the result
the CLI was handed to the reply that came back and so carries the CLI round trip
as well as the generation, where a fixed loop span is request-to-response with no
such hop in it. Read it as "is this run
moving", never as a model's generation speed.


The `state` table gains signals over time and an old run directory never gains
them retroactively, so the viewer asks each database what columns it has before
selecting: `money` and `quests_completed` come back null where the schema
predates them. Zero is a real reading — a broke character has 0 copper — so only
a missing value is null, never a recorded zero. Playtime is the wall clock the
trajectory spans, first entry to last. A run counts as **live** when it has no
termination reason *and* its `trajectory.jsonl` was appended to within the last
two minutes — "no termination reason" alone is not enough, because a killed
process never writes one.

Getting a token total per run means reading every trajectory, so the server
memoises each run's totals on the file's size and mtime: a finished run is read
once per process, a live one only as it grows, and the scan keeps a few numbers
rather than a summary per entry.

## A freeplay character is aggregated at read time

A durable freeplay character is one character across many attempts
(docs/OPERATIONS.md, "Freeplay characters are durable"), and every counter the
runner keeps is per *attempt*: `questsCompleted` is that session's own
`completions.length`, the tokens and the cost are that attempt's trajectory, the
playtime is that attempt's active segments. So the run page used to answer "how
many quests has this character done" with the last session's tally, and a reader
could only see the run one attempt at a time.

`/api/run/<id>` now carries a `character` (`character.ts`) for a run with lineage: the
whole chain, oldest first, each attempt with its own figures, plus the totals
across them. **Nothing is written back.** What the runner records is the
model-visible surface and a methodology matter; an old run is read differently,
not relabelled — so the aggregation is the reader's and an attempt whose
`run.sqlite` predates a column simply contributes nothing to that sum.

What sums and what does not is the difference between a tally and a state:

- **Summed** — quests, xp earned, playtime, tokens, tool calls, snippets,
  replies, deaths, flights, spells learned, talent spends, trades. A sum over
  attempts where NONE recorded a kind is `null`, never 0; where some did, those
  are summed and the rest contribute nothing.
- **The furthest attempt's** — level (the highest any attempt observed; a
  character never de-levels), money, and `achievements`, which is already
  cumulative because the tap reports the character's whole backlog. Summing it
  would count every achievement once per continuation. `atLogin` on the spell
  facts is the same shape pointing the other way: it is the oldest served
  attempt's baseline, since attempt 2 logged in holding attempt 1's book.
- **Cost is two sums and a coverage.** A `CostFigure` carries a basis, a price
  id and a date, and a chain whose attempts were one provider-reported, one
  priced from the table and one neither has no honest single basis — so
  `CharacterCost` adds the dollars and states how many attempts each sum covers,
  keeping actual and expected apart as `CostView` does. `asIfMetered` rides
  along so a subscription character does not read as a bill.
- **Token source degrades to the weakest.** One `snapshot`-sourced attempt makes
  the character's total under-read, and labelling it `reported` because the other
  eleven were would hide the caveat the label exists to carry.

The chain is `lineage.ts`, shared with the dashboard over the `@viewer/*` alias,
so the ladder's row, the runs table's column and this aggregation cannot
disagree about which attempts belong to one character. The chain served is the
**forward** one — the deepest under the root — because a reader on attempt 11
wants to see 12. The gate is narrow: the block runs only for a run that is
freeplay or names a `continuedFrom`, so a scored run's page pays nothing for it,
and behind the gate it is the same memoised `runTotals` the listing uses, so an
ended attempt is read once per process.

`characterViewOf` itself is **universal** since 2026-09-16 (item 128): every run
the set holds gets a view, and a scored run's is a chain of one attempt. Null is
reserved for a run the set does not hold and for a stillborn launch. Aggregating
universally is not printing universally — a strip reading "attempt 1 of 1" is
noise standing where a fact should be, which is what `hasLineage` says — so the
two routes above embed the field only when the chain has more than one attempt,
and a reader who wants the degenerate view asks for it:

`GET /api/character/<id>` serves one character whole: the view, plus every
attempt's state samples laid end to end with the attempt each came from. That
pairing is the only thing that finds a session boundary — a relaunch can follow
a logout by a second — which is why it is on the wire rather than left to the
page. The id may be any run in the chain, not only the head, and the series
reads the same store-then-sqlite path `/api/run/<id>` reads its own states
through. Public mode serves it, projected by the run detail's own projectors
applied across the chain.

## Token accounting

The runner records a provider `usage` block on `response` entries whenever the
provider returns one, so those counts are measured. Cache figures a provider
never mentions come back null, never `0`: an OpenAI-compatible endpoint reports
cache reads as `cached_tokens` and says nothing at all about writes, and
"unknown" is not "none". **Runs recorded before usage logging landed report
estimates instead** — characters ÷ 4, flagged as estimated — and newer runs
carry provider-reported counts automatically; the viewer decides per run by
whether it finds any usage in the file. A turn's reported prompt size replaces
the estimate for that turn, so the two never double-count.

The one exception is the claude-code harness (driver id `claude-code`, formerly
`claude-subscription`). Its
driver discarded the CLI's usage objects until 2026-08-22, and a characters ÷ 4
estimate over a session that reuses an enormous cached prefix is off by orders
of magnitude — so those runs report no usage rather than a number that would
mislead. Runs recorded after the fix carry real counts, cache writes included.

## Positions, the map feed, and tiles

`/api/positions` is the feed behind the map: for every run with no termination
reason, the newest `state` row that actually carried `map, x, y` — not simply
the newest row, since a level-only sample would otherwise blink an agent off the
map — dropped if that reading is more than ten minutes old. By design the
renderer consumes only that array and never touches the run store, which is what
lets a replay mode plug a trajectory reader into the same shape later. The
coordinate transform lives on its own in `worldmap.ts` (`tile = 32 −
coord/533.33325`, world X → tile row, world Y → tile column) with no imports,
for the same reason, and the dashboard imports it rather than copying it.

`/api/run/<id>` also carries `reflections`: the turns the run spent reflecting,
as half-open `[fromTurn, toTurn)` ranges off its `reflect_window` records, with
`toTurn` null when the window ran to the end of the run. Half-open because both
records are written at the top of a turn, before the model answers it, so the
close names the first turn spent acting again — `tail.ts` owns the reasoning.
It is served whole rather than derived by the reader, because the `open` that
starts a window routinely sits above whatever slice of entries the run page has
loaded. Turn indices carry nothing of the world, so they survive the public
projection.

Each position also carries what the character last *said* it was doing and
whether it is thinking rather than acting. `status` is the newest entry in the
run's `episodic.jsonl` — the model's text under the harness's own turn/level/zone
stamp — read as a file, because that log has no sqlite half and the viewer must
not create the directory a writer would. `reflecting` is `run.reflecting_since`
being non-null: the trajectory keeps the window's transitions, the column keeps
the current answer, and a process boundary clears it, since a resumed run starts
with a fresh gate. Both publish: the entry is the model's own words under a
zone *name*, and names and model-authored text are published since 2026-08-30
(docs/DATA-AND-LEGAL.md, "Trajectory logs").

Tiles come from the minimap extraction in `minimap/`, which writes
`data/minimap/<mapId>/<row>_<col>.png`; `/tiles/<mapId>/<row>_<col>.png` serves
them straight from there, integers only and cached for a year since they never
change (public mode with `WRATHBENCH_VIEWER_TILES_PUBLIC=1` sends a private
one-hour cache instead — see "What it will not serve"). Nothing extracted yet is a normal state, not an error: a missing tile
draws as a labelled grid square, so the map works on a machine that has never
run the extraction. `WRATHBENCH_MINIMAP_DIR` overrides the tile root.

The gated public dashboard serves the same path. `infra/publish-tiles.ts` is a
separate, hand-run publisher step (never part of a snapshot pass) that uploads
`data/minimap` to the R2 bucket under `tiles/<mapId>/<row>_<col>.png`; the gate
Worker serves them to authenticated readers only, with this file's
`TILE_PUBLIC_CACHE_CONTROL` and `TILE_PUBLIC_ROBOTS` headers. See
`docs/PUBLIC-DASHBOARD.md`.

## How it handles big files

`request` entries embed the whole model message array and `events_served`
entries embed every packet, so nothing ships the raw file to the browser. One
`TrajectoryTail` per run scans the JSONL forward from wherever it stopped,
splitting on bytes (0x0A can never occur inside a UTF-8 sequence, so a write
that lands mid-character is safe) and keeping only a small summary plus the byte
range of each line. Big fields collapse to counts; the full JSON of any single
entry is re-read from disk on demand behind a click. The SSE tail heartbeats
once a second, so a quiet run can be told from a dead connection.

## Endpoints

Everything under `/api` is read-only with one exception: the config API below,
which is the only write surface the viewer has and is not mounted at all in
public mode. Everywhere else no route accepts a body, every database is opened
readonly, and the runs directory is only ever listed and read.

| path | what |
| --- | --- |
| `/api/info` | what mode the viewer is in: public, dashboard built |
| `/api/runs` | run listing, with per-run token totals and active playtime |
| `/api/positions` | position feed: every live agent's latest map/x/y plus a preview |
| `/api/fleet` | the fleet supervisor's jobs, accounts, gate and heartbeat |
| `/api/tools` | the eight model-facing tools — name, description and schema off `runner/src/tools.ts` at request time, plus one example call (tools with arguments) or one returns line (tools without); harness text only, served in public mode too |
| `/api/run/<id>` | run row, state series, entry count, token totals, playtime, reflection windows, and — for a freeplay attempt — the whole `character` it is part of |
| `/api/character/<id>` | one character whole: the chain, its totals, and every attempt's state samples end to end with the attempt each came from. `<id>` is any run in the chain |
| `/api/run/<id>/entries?from=&limit=` | summarised entries (default: last 200); in public mode each entry crosses `projectEntry` and `redactGameProse` |
| `/api/run/<id>/raw/<i>` | the raw JSONL line for one entry (withheld in public mode) |
| `/api/run/<id>/scratchpad` | the run's scratchpad.md — the model's own notes, served in public mode too |
| `/api/run/<id>/stream` | SSE: new entries as they are appended (withheld in public mode) |
| `/tiles/<mapId>/<row>_<col>.png` | one minimap tile from `data/minimap/` (404 when not extracted; withheld in public mode unless `WRATHBENCH_VIEWER_TILES_PUBLIC=1`) |
| `/api/config...` | the fleet config, read and write — see below; **not mounted in public mode** |
| anything else | the built SPA, or the not-built notice when there is none |

### The config API (operator-only)

Since item 127 the fleet config lives in a sqlite store on the data volume
(`runner/src/config-store.ts`, `$WRATHBENCH_DATA/config.sqlite`), and
`infra/fleet.json` is its seed and its export format. The supervisor reads the
store on every 60s re-read, so an edit here is live one tick later with no
restart. The UI over these endpoints is the dashboard's `/config` page
(`dashboard/src/pages/Config.tsx`, item 134) — a roster table with tier, idle,
billing and routing editable inline, a JSON editor per other row key, the audit
history and an export button. Its nav link appears only on a private build
served by a non-public viewer, which is the same condition these routes are
mounted under. An operator can still drive the endpoints with curl or the CLI
(`bun runner/src/config-store.ts seed|export|get|set|patch|delete|audit`).

A *key* is a row: `roster/<name>`, `campaigns/<name>`, `queue/<n>`, or one of
the singletons `_notes`, `preflight`, `accounts`, `policy`.

| path | what |
| --- | --- |
| `GET /api/config` | the whole config in fleet.json's shape, plus `keys`, `version` (moves on every accepted write) and whether the store has been seeded |
| `GET /api/config/<key>` | one row's document |
| `PUT /api/config/<key>` | replace one row |
| `PATCH /api/config/<key>` | shallow-merge into one row |
| `DELETE /api/config/<key>` | remove one row |
| `GET /api/config/audit?limit=` | the change history, newest first, with the before and after documents |
| `POST /api/config/export` | render the store to fleet.json's exact shape; returns the text, and writes a file only when the body names a `path` |

Every write renders the whole candidate config and runs it through
`parseFleet` — the same function the supervisor refuses a bad `fleet.json`
with — so a rejected edit is a 400 carrying that refusal word for word, and
nothing the app accepts can be rejected at the next tick. `x-wrathbench-actor`
and `x-wrathbench-note` name who changed what and why; the actor defaults to
`viewer`. The viewer has no authentication of its own (loopback, or a trusted
LAN behind `WRATHBENCH_VIEWER_LAN`), so "not public" is the whole of the
authorisation — which is why a public handle answers 404 rather than the 403
it gives for a withheld read route.

Two things the page has to work around, and they are properties of this API
rather than of the page. There is **no if-version and no conflict detection**:
`version` is the last audit id and a write carries no expectation of it, so the
page re-reads `/api/config` immediately before each write and refuses when the
version moved under it. And **PATCH cannot remove a key** — it is a shallow
merge, and JSON has no `undefined` — while an absent `routing`, `idle` or
`billing` is a distinct, deliberate state; so the page PATCHes a set and PUTs
the whole entry with the key omitted for a clear.

### What it will not serve

The `meta` trajectory entry embeds the whole run config, bearer token included,
and the generic summariser used to copy it wholesale — so both `/entries?from=0`
and `/raw/0` served it. Redaction is keyed on field name at any depth and applied
at the two places a raw record can reach a client (`summarize` and
`TrajectoryTail.raw`). `apiKeyEnv` is deliberately kept: it names an environment
variable, and the value of that variable is never written to the trajectory.

`WRATHBENCH_VIEWER_PUBLIC=1` makes the whole handle a boundary rather than a
set of routes an operator has to remember (GitHub issue #30, 2026-09-01): every
`/api` body is emitted through `pub`, which projects it in public mode with the
same projector the snapshot uses, so a route added without one fails
`runner/test/viewer-public-mode.test.ts` rather than shipping unprojected. The
three routes with no projected form are withheld outright — raw entries and
minimap tiles (the unprojected record, and Blizzard-derived bytes) and the SSE
tail, whose whole point is unprojected entries as they are appended; a public
reader's window is the snapshot's one published tail instead. `/scratchpad` is
the deliberate exception, served in public mode because the model's own notes
are published as written. It is opt-in-to-public, not opt-in-to-raw: the run
page depends on raw bodies, so a public deployment sets the flag rather than
the developer clearing it.

What a public entry carries (docs/DATA-AND-LEGAL.md, "Trajectory logs", operator
2026-08-30): names and ids stay, game prose goes. `projectEntry`
(`public-projection.ts`) is an allowlist per entry type — the `meta` entry
sheds the run config (api base, objective, paths), `driver` and `claude_system`
their binaries, cwd and socket paths, `pause`/`watchdog` their free-text
`detail`; an unlisted type ships as its skeleton. `redactGameProse`
(`redact-prose.ts`) then replaces the prose fields enumerated from
`sdk/src/protocol.ts` — quest `details`/`objectives`/`areaDescription`/
`completedText` and objective `text`, questgiver and trainer `greeting`, the
request-items and offer-reward `text`, gossip option `text`, item
`description`, page and item `text`, mail `body`, chat `message` — wherever a
decoded payload turns up in a tool result: an event batch, a JSON value, a
`recent_events` line, a string holding JSON one or two levels down; a cut
fragment is redacted from its first prose key to the end, and a
`search_reference` result (wiki text) goes whole. Model-authored text — turn
text, snippet code, the scratchpad, the episodic log, console lines and any
result the model formatted as plain prose — is published as written; it can
quote the world, and that residual is stated in `docs/PUBLIC-DASHBOARD.md`.

Tiles alone can be opted back in with `WRATHBENCH_VIEWER_TILES_PUBLIC=1`, for a
deployment whose operator has decided it may serve them. It settles nothing —
the flag exists so the decision can be *acted on*, not so it can be skipped —
and it is off unless deliberately set. It also only loosens public mode: on a
private viewer it does nothing, since tiles are served there regardless. What
changes when it is on: the route answers instead of 403, with
`Cache-Control: private, max-age=3600` (short, so turning the flag off is felt
the same day) and `X-Robots-Tag: noindex`; a miss stays an uncached 404 and no
path lists a directory. The startup banner says which of the two public shapes
is running. The static public snapshot is untouched by all of this: the
renderer builds its own public handle without the flag and asks for no tile, so
no bucket key can be one (`runner/test/snapshot.test.ts` pins it).

Tail and summariser logic is tested in `runner/test/viewer-tail.test.ts`; the
coordinate transform, the position feed and tile path validation in
`runner/test/viewer-map.test.ts`; the API surface, redaction and static hosting
in `runner/test/viewer-api.test.ts`.
