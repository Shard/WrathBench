# Run viewer

The read-only HTTP API over recorded runs, and the process that hosts the
dashboard. It reads `data/runs/` (and the collector's ClickHouse store when
there is one) and answers the dashboard's questions: which runs are live, what
a run did and spent, where every character is. It exists so an operator can
watch a run and see where it is stuck without tailing 3 MB of JSONL by hand.
The UI is `dashboard/`; the public site is a static snapshot rendered through
this same code (`docs/PUBLIC-DASHBOARD.md`), never this process on the open
internet.

The first sections say how to run it and what it refuses to serve. The rest
records, route by route, how each figure is derived, for anyone who has to
read or change one.

## Running

On Kubernetes the viewer is the `wrathbench-viewer` Deployment behind the
cluster's own Ingress; its code is baked into the runner image and Flux
owns the tag, so it comes back on its own and new viewer code needs a new tag
rather than a restart. `bun run viewer:restart`
(`infra/viewer-restart.sh`) rollout-restarts that Deployment and checks
`/api/info` on `$WRATHBENCH_VIEWER_URL` — it kicks a wedged process, it does not
deploy anything.

Anywhere else — the single-machine compose stack, a bare clone, or development
on the pages — it is one process you start and stop yourself:

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
- `WRATHBENCH_VIEWER_ALLOWED_HOSTS` lists, comma-separated, the host names
  the viewer answers to beyond `localhost` and IP addresses (ports ignored).
  Unset, it is the host of `WRATHBENCH_VIEWER_URL` when that is set, and
  nothing else. Every other `Host` gets a 421 ("Host allowlist" below). On the
  cluster the chart renders it from `viewer.ingress.host` and
  `ingress.extraHosts`, so changing those values is the whole of a rename; a
  viewer reached by any other name — another alias, a hand-run process behind
  your own proxy — needs that name added here, or its pages answer 421.
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

There is no fallback UI: with no build on disk every page route
answers with a plain-text notice naming the build command, and `/api` keeps
serving throughout. The dashboard's own rules are in `dashboard/README.md`;
what follows is what the server decides before the UI sees it.

## Loopback only

The viewer binds 127.0.0.1. Trajectories contain game-derived text — quest text,
NPC and item names — and per `docs/DATA-AND-LEGAL.md` none of it leaves this
machine. Setting `WRATHBENCH_VIEWER_HOST` to anything else is a startup failure
that prints why, unless `WRATHBENCH_VIEWER_LAN=1` explicitly opts a trusted
private network in. That opt-in is for a LAN, not the internet: it lets someone
on the same network read pages, and reaches nothing else — the module stays
loopback regardless. Public hosting is the published snapshot, not this
(`docs/PUBLIC-DASHBOARD.md`, "The live viewer is not a public service").

Opting in takes two steps, and the second is the one that gets forgotten:

```
WRATHBENCH_VIEWER_LAN=1 \
  WRATHBENCH_MODULE_URL=http://<worldserver container ip>:8086 \
  bun runner/viewer/serve.ts            # now binds 0.0.0.0:8090; the roster comes from data/config.sqlite

# and the host firewall, scoped to the LAN — NOT a bare --add-port, which
# would open 8090 to every network in the zone:
sudo firewall-cmd --permanent --zone=public --add-rich-rule=\
  'rule family="ipv4" source address="<your-lan>/24" port port="8090" protocol="tcp" accept'
sudo firewall-cmd --reload
```

`--permanent` matters: a runtime-only rule is lost on the next reload or reboot.
Note that `curl http://<lan-ip>:8090` **from the host itself** succeeds even
with the port firewalled — that traffic is delivered over `lo` and never crosses the zone — so
verify from another machine, or the check proves nothing.

It also only ever reads. Each `run.sqlite` is opened readonly, so a run being
written by the harness inside the container is never disturbed, and an old run
directory never gains a schema it did not have.

### Host allowlist

There is no login, by the operator's choice: the network the viewer is served
on is private. What a private network does not stop is DNS rebinding — a web
page a LAN browser opens re-points its own name at the viewer's address, and
the browser then counts the viewer as that page's origin, so the page can read
every route and its writes pass the write guard. The browser still sends the
page's own name in `Host`, so `host-guard.ts` answers a request addressed to
any name but the viewer's own with a 421 Misdirected Request — the request
reached a server that does not answer for that name, which is not the write
guard's 403 — before any route runs, on every path and every method. The names
it accepts:

- `localhost`, always — what local development, a `kubectl port-forward` and
  the operator's curl use;
- any IP address, always. A browser sends an IP `Host` only when the page's
  own origin is that address, which an attacker cannot serve, so it costs no
  protection; and it is what a Kubernetes probe sends (the pod IP) and what a
  LAN browser pointed at `http://<lan-ip>:8090` sends;
- the names in `WRATHBENCH_VIEWER_ALLOWED_HOSTS`, else the host of
  `WRATHBENCH_VIEWER_URL`.

Only `Host` is read, never `X-Forwarded-Host`, which a rebinding page could set
itself; the proxy in front of the viewer must pass the browser's `Host` through
(Traefik does by default). An in-cluster client reaching the viewer by its
Service name is refused like any other unlisted name. A name in the list that
is not a host is a startup failure. A handle no network reaches — the snapshot renderer's, a test's — has
no allowlist and no check; only `serve.ts` binds a port, and it always passes
one.

## The run listing

`/api/runs` lists every directory under `data/runs`, newest first.

Playtime (`playtimeMs`, on the listing rows and on `/api/run/<id>`) is *active*
time, not the span the trajectory covers: a segment opens at the `meta` record
and at each `resume`, and closes at each `pause` or `termination`, with an open
segment running to now for a live run and to its last entry otherwise. A run
that a rate limit paused and `--resume` picked up hours later would otherwise
read as having played through the gap. It is computed here, once, so the fleet
table and the run page cannot disagree. Note that this is not the
`episode-limit` watchdog's clock, which is per-process uptime since the current
resume and so never sees paused time.

Those segments are the run's **sessions** (`sessions.ts`, the one definition the
viewer and the dashboard share over `@viewer/*`). A run is one session or more:
a paused freeplay run is resumed in place by the fleet, however much later, so
one run id can hold two sessions days apart. `/api/run/<id>` serves them as
`sessions`, the results rows and a character's attempts carry them too, and
every chart that plots samples against time plots them on the session clock —
the active time before each sample, the same `activeMsUntil` a level mark's
`playtimeMs` is — so a pause is closed and marked rather than drawn as days of
flat line. A boundary is a recorded mark, never a gap between samples.

The quest count is the one recorded figure a resume restarts. `quests_completed`
on a state sample is the running process's own count, so it reads zero again
after a resume and after a sandbox restart inside a session, and the newest
sample says nothing about the run. Within a process it only grows, so the
run's count is summed across every drop (`questsAcrossRestarts`, a lower bound
by whatever a stretch completed after its last sample) everywhere a reader is
shown it: `/api/run/<id>` and the results rows, the map feed (each live run's
counts read off its `run.sqlite`, two columns, `readQuestCounts`), and the
replay track, whose every point carries the run's count up to it from the same
fold (`questTally`), so the end of a replay reads what the run page does. Only
the fleet listing's row is the newest sample, which on a resumed run is the
count since the resume; `bun wb inspect run` prints each stretch.

The trace's `qdone` turn-ins do not feed that count. They are the server's
receipts and exact where the 60 s fold is a lower bound, so mixing them in
would make the map disagree with the results page; they exist only since the
character sheet, so a run that crossed that release would be counted two ways;
and they are per window, so a total would be a fold over every segment of the
run. The quest log panel shows them, as turn-ins since its window began.

Tokens per second (`tps`, on the listing rows and on `/api/run/<id>`) is output
tokens over the wall time of the model's REPLIES, never over the run's elapsed
time, most of which the harness spends driving the game. A span opens at a
record that hands the model something to answer — the `request` on the fixed
loop, the `snippet_result` or `tool_result` the CLI was waiting on under
claude-code — and closes at the last `response` before the next such record.
Replies rather than turns because a turn is not the same unit under the two
drivers: one claude-code run on disk is one `request` and 2,833 `response`
records, so timing "a turn" there would time the whole six-hour episode. Ambient records (`state`, `milestone`, `claude_system`) are ignored
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

The claude-code driver is the exception on the OUTPUT side. Its `response`
envelopes carry the API's `message_start` usage, whose
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
on the haiku run it sums to 5,283,659 ms of a 5,400,000 ms episode,
which is the run's elapsed clock with every MCP round trip in it.

The result's `iterations` array is documented as one
entry per API call but holds only the last call on every CLI version logged so
far, so the per-reply path is gated on the entries summing to the turn total —
true on a one-call turn, declined on everything else. A turn with no result (in
flight, or cut short by a watchdog) keeps its snapshot figures, which are all
anyone has for it.

A run where NONE of the turns produced a result — 21 of the 29 claude-code runs
on disk, because a watchdog kill is the normal ending — has a
completion total resting entirely on those snapshots, and `tokenTotals` reports
`source: "snapshot"` for it rather than `"reported"`. It is neither an estimate
nor a measurement: provider-reported and known to be far too low, so the run page
labels it and its rate as under-read. A run that
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
a missing value is null, never a recorded zero. A run counts as **live** when it has no
termination reason *and* its `trajectory.jsonl` was appended to within the last
two minutes — "no termination reason" alone is not enough, because a killed
process never writes one.

Getting a token total per run means reading every trajectory, so the server
memoises each run's totals on the file's size and mtime: a finished run is read
once per process, a live one only as it grows, and the scan keeps a few numbers
rather than a summary per entry.

## A freeplay character is aggregated at read time

A durable freeplay character is one character across many attempts
(docs/RUNBOOK.md, "Freeplay characters are durable"), and every counter the
runner keeps is per *attempt*: `questsCompleted` is that attempt's count across
its own restarts (above), the tokens and the cost are that attempt's trajectory,
the playtime is that attempt's sessions. Answering "how many quests has this
character done" from one attempt would give the last attempt's tally, and a
reader would see the run one attempt at a time.

`/api/run/<id>` carries a `character` (`character.ts`) for a run with lineage: the
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
  along so a subscription character does not read as a bill, and
  `actualBackfilled` counts the attempts whose actual includes turns the CLI
  never reported a cost for (docs/COSTS.md), so the sum wears the same `*`.
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

`characterViewOf` itself is **universal**: every run
the set holds gets a view, and a scored run's is a chain of one attempt. Null is
reserved for a run the set does not hold and for a stillborn launch. Aggregating
universally is not printing universally — a strip reading "attempt 1 of 1" is
noise standing where a fact should be, which is what `hasLineage` says — so the
two routes above embed the field only when the chain has more than one attempt,
and a reader who wants the degenerate view asks for it:

`GET /api/character/<id>` serves one character whole: the view, plus every
attempt's state samples laid end to end with the attempt each came from. That
pairing is the only thing that finds an attempt boundary — a relaunch can follow
a logout by a second — which is why it is on the wire rather than left to the
page; a resume inside an attempt comes off that attempt's `sessions` in the
view. The id may be any run in the chain, not only the head, and the series
reads the same store-then-sqlite path `/api/run/<id>` reads its own states
through. Public mode serves it, projected by the run detail's own projectors
applied across the chain.

## A party member's records

A Deadmines party attempt is five runs, one per member, launched, stopped and
counted together (docs/proposals/GROUP-PLAY.md). Membership is the run's own
stamp, `meta.config.party`, read as recorded (`campaignFieldsOf`): every row
of a member carries `party: { id, member, size, role, index }`, where the id is
the attempt's run-id stem, the role is the member's and the index is its place
in the stamp's member order, the leader at 0. Nothing groups by parsing a run
id. A run from before `role` and `index` has neither.

`/api/run/<id>` of a member also carries `party` (`party-marks.ts`): the member
list off the stamp with each member's account left off, the `instance`, `kill`
and `group` milestones off the same incremental tail as the deaths, each
death's time (which the run page's public death sites leave off), the
member's own party chat off its trace (`readTraceChat`, the server's echo of
its lines, so five members' lists never repeat each other), and where it last
was, off the newest state sample. A kill is named by the run's own client
cache (`client-cache.json`, the creature query the client was answered), and a
zone or area by the `WB_AREA` event the run was served for that id
(`areaNamesOf`); a run that was never told a name carries the id alone. There
is no party route: the dashboard builds the attempt from the listing and the
five details (`dashboard/src/lib/party.ts`), on the private viewer and the
public bucket alike.

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
driver discarded the CLI's usage objects early on, and a characters ÷ 4
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
coordinate transform lives on its own in `worldmap.ts` with no imports,
for the same reason, and the dashboard imports it rather than copying it.
A position carries no inventory: the map's sidebar reads what a live character
wears and carries off the trace's character sheet, and the newest reading on
the feed ran the public delay ahead of the pip; the run row keeps it
(`/api/run/<id>`, the run page's "carrying").

The feed is polled every few seconds, so it opens as little as it can. Only
runs the store lists as unterminated, with a trajectory it last saw inside the
window (plus five minutes for the collector's lag), are opened at all: every
state sample is written to the trajectory too, so a run quiet longer than the
window has no position inside it, and the fleet's hundred-odd paused runs were
each a database open a poll for nothing. A run that is opened has its
`run.sqlite` opened once for the position, quest counts, latest move (one row,
`ORDER BY ts DESC LIMIT 1`) and reflection window, and its `episodic.jsonl`
read from the end.

`/api/run/<id>/track` is the replay's feed: the positioned samples as points,
and what the character wore and carried along them as `inv`, a reading
wherever the stored inventory changed, written as the slots that moved since
the reading before. `track-inv.ts` is the codec and the format, import-free so
the dashboard folds with the same code. The whole inventory on every changed
point was most of a long run's track (24.7 of a level-43 character's 30.3 MB,
re-uploaded by the publisher on every pass while the run was live), and the
patches say the same readings in 136 KB. It is built at read time from the
same samples, so nothing about what is recorded changed.

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
zone *name*, and names and model-authored text are published
(docs/DATA-AND-LEGAL.md, "Trajectory logs").

Tiles come from the minimap extraction in `minimap/`, which writes
`data/minimap/<mapId>/<row>_<col>.png`, and its bakes, which write the
zoomed-out levels as `data/minimap/<mapId>/minimap/<z>/<row>_<col>.png` and the
painted art layer as `data/minimap/<mapId>/art/<z>/<row>_<col>.png`, both for z
1..6. The transcode in `minimap/` derives the served tree from those masters
under `data/minimap/web/`: the natives as indexed PNG at the same names, the
pyramids as `<z>/<row>_<col>.webp`, and a per-map `index.json`.

`/tiles/` serves every shape from there under the same path, integers only
(and the layer from a fixed list). Two fallbacks keep it working without a
current transcode:

- A served file that is missing, or older than its master, is answered from
  the master and typed as what it is. A machine that never ran the transcode
  still draws every tile.
- A pyramid tile asked for under its old `.png` name, by a build from before
  the WebP tree, gets its master.

The index is withheld (404) when it is older than any of its map's master
directories, so the page asks for every cell rather than trust a stale list.
Copying `data/minimap` to another machine wants mtimes kept (`tar`, `rsync -a`).

Tiles are cached for a year since they never change (public mode with `WRATHBENCH_VIEWER_TILES_PUBLIC=1` sends a
private one-hour cache instead — see "What it will not serve"). The art is the
exception: it is re-baked in place while its look is tuned, so it is sent
`no-cache` (`private` in public mode) with an ETag and Last-Modified, and an
unchanged tile is a 304; the index is sent the same way. Nothing extracted yet is a normal state, not an error: a missing tile
draws as a labelled grid square, so the map works on a machine that has never
run the extraction. The public site's tiles are a separate upload
(`docs/RUNBOOK.md`, "Public dashboard").

## The trace: positions second by second

A run recorded by the trace recorder has a `trace` table in its `run.sqlite`:
positions at about 1 Hz and the unit state beside them (health, power, auras,
combat, a cast, a flight). `trace.ts` is the codec — one segment per run per
UTC-aligned five-minute window, columnar and delta-encoded, with its format at
the top of the file — and it imports nothing, so the dashboard's player decodes
with the same code. `trace-db.ts` is the reads, all ranges over the
`(run_id, ts)` index.

The same rows carry the character sheet: money, equipment, worn bags, what is
carried, durability, the quest log's ids and counters, visible reputation,
skills and turn-ins, as numbers. What is carried is the backpack (bag 255,
slots 23-38), the worn bags' contents, the keyring (bag 255, 86-117) and the
currency tokens (bag 255, 118-149): everywhere the server counts toward a
quest's items. The bank (39-73) and the vendor buyback slots (74-85) are never
read. A segment states each part whole in its
keyframe and as patches after it (the rows that changed, and a key alone for
one that went), and `sheetAt` folds it at a playhead, apart from `stateAt` so
the unit frame's per-frame read never copies an inventory. The item names and
quest requirements live once per id in `trace_dict`; every read joins the ones
a segment references into its `items` and `qreq`. A segment from before the
sheet has none of its keys, which reads as "not recorded", never as empty
bags.

They also carry what the character said: each line the server echoed back as
its own (say, party, raid, yell, emote, and the sender's copy of a whisper),
kind and text, as a `chat` event the map's bubbles read. Like a turn-in it is
an event and never state, so no keyframe holds it.

- `/api/run/<id>/trace` is the index: `segs`, the closed windows that have
  rows as runs of `[firstT0, count]`, and `tail`, everything after them
  encoded so far. A window closes `SETTLE_MS` (a minute) after it ends, so a
  row the recorder drains late still lands in it; until then it is in the
  tail, which is why the tail spans two windows for that minute.
- `/api/run/<id>/trace/<t0>` is one window. A closed one never changes and is
  sent with a year's immutable cache; the open one is sent `no-store`; one
  with no rows is a 404.
- `/api/run/<id>/track` gains `trace: {segMs, segs}` and each live position on
  `/api/positions` gains `trace: {segMs, recent, tail}` — the last three closed
  windows and the tail, from one range read — so the live map and the replay
  read one shape, privately and publicly.

A run from before the recorder has no table, and every one of these answers as
"no trace": an empty index, a 404, and no `trace` field at all, so its track is
the bytes it always was. The track's window list is memoised on the database
file's size and mtime, which is what keeps the publisher from opening every
run's sqlite on every pass. In public mode a segment crosses
`projectTraceSegment`: no `target`. Deaths are public, so `dead`, `ghost` and
the gauges at a corpse pass. The sheet passes as numbers with its items'
template names, and never the bank or the vendor buyback slots. Chat passes
as kind and text, a credential's shape masked, and a public trace body has the
run's session token struck like its other text.

## Nearby units: the live map's ring

A live run also keeps the units around its character — creatures and other
players in view, where each is going, and the packet fields and query answers
the map colours and names them by — in a ring of one-minute files under
`data/runs/<id>/nearby/` (`runner/src/nearby.ts`; the rows are
`runner/src/nearby-row.ts`). It is live only: about 15 minutes, unlinked as it
ages, deleted on every pause, stop and exit, never in `run.sqlite`, the trace,
the trajectory or the store, and never read by a replay. `nearby.ts` here is
the codec — one columnar window, its format at the top of the file, import-free
so the dashboard plays it with the same code — and `nearby-ring.ts` the reads.

- `/api/run/<id>/nearby?span=<ms>` is the last `span` (default 60 s, at most
  the ring's 15 minutes) as one window: a keyframe at its start and every
  change after it, up to the newest row the child wrote, which is the data's
  horizon. Uncached, and an empty window rather than a 404 for a run with no
  ring. Files past the ring's reach are ignored whether or not the writer got
  to unlink them, so a run killed hard serves nothing stale.
- A live position on `/api/positions` gains `nearby: true` while its ring is
  being written (its newest file is under 30 s old), so the map asks only
  runs that have units to show.

In public mode the window crosses `projectNearby`: creatures only — no other
player, nothing another player owns, charms or drives, nothing while it
targets another player or their pet — with the state cut to entry, name, type,
level, health, dead, service roles, the quest marker and "targets this
character". The layer stays lit while the character is down. Creature
guids stay, so a unit two characters see draws once. The position feed's
`nearby` flag is projected too.

The public site gets the same window, live only. Each publisher pass reads
the last `PUBLIC_NEARBY_SPAN_MS` (twelve minutes: what the public map's
playhead, about nine minutes behind, needs until the next pass lands) of every
run the feed flags, straight after the feed, and `nearby.json` carries it by
run id (`projectLiveNearby`: through `projectNearby`, for flagged runs only,
cut to the span). `live.json` names that object and keeps the flag only where
the window is. Nothing else in the bucket names a unit, so the next pass after
a run's ring goes overwrites its window with nothing, and no history of
positions accumulates anywhere (docs/PUBLIC-DASHBOARD.md, "The units around a live
run").

## How it handles big files

`request` entries embed the model's message array (the whole of it on an older
or CLI-scaffold record, the fresh user message on a fixed-loop slim one) and
`events_served` entries embed packets — every one the window fetched on an
older record, the ones the model was shown plus a `folded` count on a newer
one — so nothing ships the raw file to the browser. One `TrajectoryTail` per run scans the JSONL forward from wherever it
stopped, splitting on bytes (0x0A can never occur inside a UTF-8 sequence, so a
write that lands mid-character is safe) and keeping only a small summary plus
the byte range of each line. Big fields collapse to counts; the full JSON of any
single entry is re-read from disk on demand behind a click. The SSE tail
heartbeats once a second, so a quiet run can be told from a dead connection.

Every reader of a run shares its one tail, so each SSE stream keeps its own
cursor into the tail's entries and sends whatever lies past it after any
scan, whoever ran it: a second tab, the run page's own poll or `/entries`
can no longer consume a batch an open stream then never sends. A truncated or
rotated file restarts every cursor from the top. Where a cursor starts is the
client's: the run page reads `/entries` before it opens the stream, so it
passes `?from=` (the first entry index it does not hold) and gets whatever was
written in between before going live. Each frame that moves the cursor carries
it as the SSE `id`, and the server prefers `Last-Event-ID` to `from`, so the
browser's own reconnect resumes with no gap and no replay. No start is the
tail's end; a start past it (a rebuilt file) is 0. The run page's tokens, cost,
coverage, speed and segments are accumulated by the tail as it indexes (the
token and speed derivations are held until it grows), so a warm poll and N
open streams cost one derivation per batch rather than a walk over every
entry each.

A tail is the heaviest thing the viewer holds — roughly a third of its file's
size in live objects, ~200 MB for a big freeplay run — so they are evicted:
after ten idle minutes, or once the tails nobody is streaming index more than
a GiB of trajectory between them (least recently used first). A tail with an
open stream is never evicted. An evicted run costs its next visit a re-read.

## Caching and compression

What the viewer keeps between requests is either short or final:

- **Corpus-wide store reads** (`runRows`, `totalsRows`, the latest readings,
  the liveness listing, the facts) and the fleet roster are shared for three
  seconds (`sharedStore` in `api.ts`): every route and tab inside the window
  gets the one read in flight. A write through the config API drops the
  roster at once. The listing build behind results, ladders and characters
  keeps its own fifteen-second window.
- **`/api/fleet` reads no corpus-wide table but the liveness listing.** It is
  polled every five seconds by every open tab (the status badge), so the
  figures its table rows show (`runFacts`: level, xp, tokens, speed, actual
  cost, playtime, episode clock, served model) are point reads of just those
  runs — each job's run and the paused run on each idle account
  (`fleetRunIds`) — built by the listing's own `listRowOf` and shared over
  the same three seconds for the same set of runs, and its
  `runCount` is the liveness listing it already read. Those cells used to cost
  the page the whole `/api/runs` (2.4 MB) a minute.
- **A settled run's track** — terminated, its files quiet for five minutes —
  has its store-derived half (points, inventory patches, moves) read once and
  kept for the last six such runs, and is answered with a weak ETag and
  `no-cache`, so a revisit is a 304. Not `immutable`: the body also names the
  character's next attempt, which appears when a continuation starts.

JSON bodies over 8 KB are compressed — brotli at quality 4 where the client
accepts it, gzip otherwise — with `Vary: Accept-Encoding` on every JSON body.
Listing bodies shrink 8–17× (`/api/runs` 2.4 MB to ~200 KB). The SSE tail,
tiles, the SPA's files and plain text are never read or encoded. A caller that
sends no `Accept-Encoding` — the snapshot publisher, the render rig, a test —
gets plain bodies.

The listing routes and the map read the store's latest readings without
`items` (`latestReadings`): the inventory column is nearly all of the states
table and no listing row shows one, so a private `/api/runs` row carries
`items: null`. A run's own page reads its inventory off `latestState`.

A request's counts (`messageCount`, `systemChars`, `promptChars`) come off its
message array on a full record and off the fields the writer stored on a slim
one, so a file that switches shape at a resume reads as one run. The raw view
of a slim request is what the model saw, not the slim line: the window's
records are read back (a walk to the response of `window.fromTurn`, no
further), the system text is found by its hash, and the request is rebuilt
through the replay's own code (`runner/src/request-record.ts`) and served with
`messages` and a `rebuilt` verdict — `{ verified: true }` only when it hashes
to the bytes that were sent, otherwise the error. Raw entries stay withheld in
public mode, and the public projection publishes the same request fields for
either shape and none of the slim record's own.

## Endpoints

Everything under `/api` is read-only with one exception: the config API below,
which is the only write surface the viewer has and is not mounted at all in
public mode. Everywhere else no route accepts a body, every database is opened
readonly, and the runs directory is only ever listed and read. The routes and
their response shapes are `api.ts` and `api-types.ts`; anything that is not a
route is the built SPA, or the not-built notice when there is none.

### The config API (operator-only)

The fleet config is the sqlite store `docs/RUNBOOK.md`, "Where the config
lives", describes (`runner/src/config-store.ts`); an edit here is live one tick
later with no restart. The UI over these endpoints is the dashboard's `/config`
page (`dashboard/src/pages/Config.tsx`). Its nav link appears only on a private build
served by a non-public viewer, which is the same condition these routes are
mounted under.

A *key* is a row: `roster/<name>`, `campaigns/<name>`, `queue/<n>`, or one of
the singletons `_notes`, `preflight`, `accounts`, `policy`. Published campaign
definitions (`campaign-defs/<id>@<version>`) are rows too, listed and readable
here, but every write route refuses them with a 400: only
`runner/src/campaign-publish.ts` writes one, once.

| path | what |
| --- | --- |
| `GET /api/config` | the whole config as one document (the shape `infra/fleet.example.json` shows), plus `keys`, `version` (moves on every accepted write) and whether the store has been seeded |
| `GET /api/config/<key>` | one row's document |
| `PUT /api/config/<key>` | replace one row |
| `PATCH /api/config/<key>` | shallow-merge into one row |
| `DELETE /api/config/<key>` | remove one row |
| `GET /api/config/audit?limit=` | the change history, newest first, with the before and after documents |
| `POST /api/config/export` | render the store to a config document, for reading or diffing against an earlier export (never for committing); returns `{ bytes, text }` and writes no file — a body naming a `path` is a 400 (the operator's CLI, `config-store.ts export [file]`, writes locally) |
| `GET /api/config/proposed` | the drafts (`drafts.ts`): pending ones newest first, the ignored apart, each with its slug-derived billing, catalogue price, routing and e90 estimate, plus the token profile the estimates were priced at |
| `POST /api/config/proposed/fetch` | one bounded read of the OpenRouter catalogue: proposes every tool-calling model the roster does not run and nobody ignored; 502 with the reason when the catalogue cannot be read |
| `POST /api/config/proposed/ignore`, `…/unignore` | `{ model }`: remember a draft as ignored, or put it back |
| `POST /api/config/proposed/promote` | `{ model, name, tier, race?, class? }`: write `roster/<name>` through `parseFleet` like any `PUT`, and drop the draft in the same transaction |

Drafts are `proposed/<model id>` rows of the same store that no config reader
sees (`config-store.ts`, "The draft key space"). Only a promotion is a config
write: it alone is validated, version-moving and recorded with the actor and
note. A fetch or an ignore is bookkeeping on rows nothing schedules, so it
takes no note and leaves the history alone; an ignore records its actor on the
draft. Model ids travel in bodies, never in the path.

Every write renders the whole candidate config and runs it through
`parseFleet` — the same function the supervisor refuses a bad config
with — so a rejected edit is a 400 carrying that refusal word for word, and
nothing the app accepts can be rejected at the next tick. `x-wrathbench-actor`
and `x-wrathbench-note` name who changed what and why; the actor defaults to
`viewer`. The viewer has no authentication of its own (loopback, or a trusted
LAN behind `WRATHBENCH_VIEWER_LAN`), so "not public" is the whole of the
authorisation — which is why a public handle answers 404 rather than the 403
it gives for a withheld read route.

What stops a web page on another site from writing through a LAN browser is
`write-guard.ts`, in front of every route on a private handle: any method but
GET, HEAD and OPTIONS must be `Content-Type: application/json` (a cross-site
page can only send that after a CORS preflight, which the viewer never
grants), must not carry `Sec-Fetch-Site: cross-site`, and, when it carries an
`Origin`, must come from the viewer's own host — compared by host and port,
not scheme, because behind the TLS ingress the browser's origin is https and
the request the viewer sees is http. A refusal is a 415 or a 403 before any
route runs. The dashboard sends every write as JSON, bodyless ones included.
It is not authentication: a non-browser client is not what it guards. DNS
rebinding, where the attacking page shares the viewer's origin, is the Host
allowlist's to stop (above), and it runs first.

A roster write is also held to the provider table (`runner/src/providers.ts`):
an `apiKeyEnv` that is not a listed provider key, or a key sent towards a host
its provider does not own, is a 400 and nothing is stored.

Two things the page has to work around, and they are properties of this API
rather than of the page. There is **no if-version and no conflict detection**:
`version` is the last audit id and a write carries no expectation of it, so the
page re-reads `/api/config` immediately before each write and refuses when the
version moved under it. And **PATCH cannot remove a key** — it is a shallow
merge, and JSON has no `undefined` — while an absent `routing`, `idle` or
`billing` is a distinct, deliberate state; so the page PATCHes a set and PUTs
the whole entry with the key omitted for a clear.

### What it will not serve

The `meta` trajectory entry embeds the whole run config. The runner now keeps
the module bearer token out of it (meta.json is the token's one home, for
`--resume`), but every run recorded before that carries it, and the generic
summariser would otherwise copy it wholesale into both `/entries?from=0` and
`/raw/0`. Redaction is keyed on field name at any depth
and applied at the two places a raw record can reach a client (`summarize` and
`TrajectoryTail.raw`). Older runs also carry the token where the module echoed
it into an action reply a snippet logged, which a key rule cannot catch, so
the public boundary strikes it by value as a backstop (`publicText`): every
public body that carries a run's text names its runs to `pub`. The operator's
handle serves the record as the model saw it. `apiKeyEnv` is deliberately kept: it names an environment
variable, and the value of that variable is never written to the trajectory.

The strike only reaches a body that names its runs, and only the token. So
the publisher scans every body once more on its way to the bucket
(`SecretScanner`, `runner/src/secret-scan.ts`, called from
`infra/publish-core.ts`), and a body with a finding is not written. It looks
for every secret the publisher can name by value — the credentials in its own
environment, and each run's session token read fresh from the run's meta.json
every pass — and for credential shapes no one can name: provider key prefixes,
JWT and OAuth tokens, cloud access key ids, private-key headers, `Bearer`
credentials, and 32 or more hex characters right after a word like "token",
"secret" or "key". It fails closed the way a failed upload does: the other
objects still land, the manifest does not flip, and the site stays on the last
generation that passed. The pass's log line and the state file's `secretScan`
name each withheld object, the rule and the count, never the matched text;
the scan clears when a pass comes through clean. Known values are matched in
one rolling-hash pass whatever their number, and the shapes in one regular
expression pass. A full local render of 346 runs (1,288 objects, 46 MB)
scanned in about a second with no findings. A credential too weak to match
without hitting ordinary text (shorter than twenty characters and one
character class, such as a default password) is not matched by value, and the
publisher names it at startup.

`WRATHBENCH_VIEWER_PUBLIC=1` makes the whole handle a boundary rather than a
set of routes an operator has to remember (GitHub issue #30): every
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

What a public entry carries (docs/DATA-AND-LEGAL.md, "Trajectory logs"):
names and ids stay, game prose goes. `projectEntry`
(`public-projection.ts`) is an allowlist per entry type; an unlisted type ships
as its skeleton. `redactGameProse`
(`redact-prose.ts`) then replaces the prose fields enumerated from
`sdk/src/protocol.ts` wherever a
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
changes when it is on: the route answers instead of 403, with a short private
cache (so turning the flag off is felt the same day) and `noindex`; a miss stays
an uncached 404 and no path lists a directory. The startup banner says which of the two public shapes
is running. The static public snapshot is untouched by all of this: the
renderer builds its own public handle without the flag and asks for no tile, so
no bucket key can be one (`runner/test/snapshot.test.ts` pins it).

Tail and summariser logic is tested in `runner/test/viewer-tail.test.ts`; the
coordinate transform, the position feed and tile path validation in
`runner/test/viewer-map.test.ts`; the API surface, redaction and static hosting
in `runner/test/viewer-api.test.ts`.
