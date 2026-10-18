# Public dashboard hosting

How the public site is hosted, and why. The app is at
`https://wrathbench.shard.page`, the data at
`https://wrathbench-data.shard.page`, and no Worker sits in the read path. The
Cloudflare setup is `infra/cloudflare/README.md`; the published JSON snapshots
this describes are the public face of what `docs/ARCHITECTURE.md`
("Persistence") records. GitHub issue #10 is the standing public-hosting
checklist; `docs/DATA-AND-LEGAL.md` remains the binding constraint set.

## Goal and constraints

The runs stay on the operator's hardware. The public
site is **push-based**: the lab pushes derived data outward on a timer, and no
public request ever reaches it — so a traffic spike, however large, is
Cloudflare's problem and not the lab's. Freshness of a few minutes is
acceptable; the cadence is 5 minutes, for the write-cost
reason in "Cost" below. (The harness's own
floor is finer than either: state samples land every 60s and the fleet
heartbeat every 30–60s, so even a 60s push loses almost nothing the private
dashboard actually has). Budget: Cloudflare free tier, with at most a small
paid step.

Push-out has a second benefit worth stating: the module hardening (shared
secret on the module port, token-to-character binding, snippet filesystem
sandboxing) gates any *inbound* public exposure of the control surface. A publisher that
only makes outbound S3 PUTs exposes nothing inbound, so the public dashboard
does not wait on it. The private viewer keeps its loopback/LAN posture
unchanged.

## The live viewer is not a public service

Public delivery is **static snapshots only**. `runner/viewer` — the live
viewer, on loopback or an explicitly opted-in LAN — is private and
operator-only, and running it Internet-facing is unsupported: it reads the runs
directory, tails live trajectories, holds an SSE connection open per watcher,
and answers `/api/info` about the operator's own machine. Nothing about it is
designed to survive a public request rate, and no gate in this repo fronts it.

`WRATHBENCH_VIEWER_PUBLIC=1` is not a way to publish it. What that flag means
(GitHub issue #30) is: every JSON body the handle emits
crosses the same projection the snapshot publishes through, and the routes with
no projected form — raw lines, minimap tiles, and the SSE tail — answer `403
withheld in public mode`. That makes the flag a *boundary* rather than a set of
routes an operator has to remember, which is what the snapshot renderer needs
from it, since the renderer calls the same handle in-process. It is not a
hardening measure, and it does not make the viewer safe to expose. The same
applies to the cluster deployment: the public surface is the
static artifact bucket and the SPA in front of it, never a viewer, module or
MCP Service or Ingress.

## The architecture

Three pieces: a publisher on the lab, an R2 bucket as the data plane, and the
existing SPA built in a snapshot mode as the app plane. No Worker, no D1, no
KV, no Durable Object sits in the read path — every public read is a static
asset or an edge-cached object, which is what makes the cost ~$0 and the
hug-of-death survivable by construction.

### The publisher (lab side)

A Bun process (`runner/viewer/snapshot.ts` for rendering,
`infra/publish-dashboard.ts` for the CLI, following the existing seam: render
logic lives with the viewer's readers, operational CLIs live in `infra/`). It
calls the viewer's `createApi` handler in-process — the handler is already "a
handler you can call directly", split out of `serve.ts` for exactly this — so
the public snapshot can never drift from what the private viewer computes.
On each pass it applies a public projection (below), diffs against what it
last uploaded, and PUTs changed artifacts to R2 with `Bun.S3Client` (a Bun
built-in; no rclone, no wrangler in the data path). Cadence: one pass every
five minutes (`WRATHBENCH_PUBLISH_INTERVAL_MS`), aggregate and per-run
artifacts only when their inputs change.
Runs as one long-lived loop (a k8s Deployment or a compose service beside the
fleet) rather than a CronJob, because change detection wants the same
persistent mtime/size memoisation the viewer already uses; a `--once` mode
covers backfill and smoke tests. The per-run half of a pass is rendered and
uploaded in batches of `WRATHBENCH_PUBLISH_BATCH` runs rather than
built whole and then pushed, and each batch's runs are then released from the
viewer handle, so what a pass holds does not grow with the runs tree; the
ordering below is unaffected, because those batches are the run wave and the
manifest is still written after all of them. That, with the trajectory scanners
reading in windows rather than whole files, is what puts a pass over a
1,016-run tree at 0.78 GB peak RSS rather than 4.4 GB. Credentials are one R2
key pair scoped to the one bucket, held only by the publisher.

A finished run is not rendered again once it has gone cold. That means all
its files have been still for 15 minutes (`COLD_MS`), past the live window,
the trace's settling and the collector's catch-up. A pass skips it, pointing
its row at the keys it rendered to last time, when three things hold: its
files' sizes and mtimes are unchanged, its listing row as the viewer served it
(not the few fields `runs.json` publishes of it) is unchanged, and so are
the rows of every attempt in its character. The bucket must also still hold
every object the row names, by the engine's record. A failed PUT or a pruned
version therefore puts the run back in the render.

Some inputs the fingerprint cannot see:

- code: the projection, the redaction and scrub lists, the codec and
  `model-cost`;
- the OpenRouter price table, read once at start and rewritten by
  `sync-prices`;
- a store row the listing row does not reflect;
- lineage as the viewer's own listing sees it.

A restart covers code and prices, since a new process remembers nothing and
renders everything once. Every run is also rendered in full at least every six
hours (`WRATHBENCH_PUBLISH_FULL_RENDER_MS`), which bounds the rest. The keys are
content-addressed, so a full render that finds nothing changed uploads nothing.

The skip was added because rendering cold runs was most of a pass. On the
fleet a pass took about 120 s. Nearly all of that was the per-run phase over
some 580 runs: about 5,000 store queries returning about 600 MB, and about
16 GB of trajectory reads, since a streamed pass releases each run's entry
index. Almost every run landed on keys the bucket already held.

Minimap tiles are published by a second, separate script
(`infra/publish-tiles.ts`). It is never part of a
snapshot pass: the loop above uploads JSON only, and the tiles are
uploaded by an explicit operator run. It writes them into the same bucket,
keyed by the path the viewer already serves so the SPA asks for one URL in
either shape. The zoomed-out levels baked from them (`minimap/README.md`) go
up the same way under the same prefix (`tiles/<map>/minimap/<z>/…`), so the
cache rule, the CORS policy and `robots.txt` cover them with no change. The
painted art layer (`tiles/<map>/art/<z>/…`) goes up in the same pass, under
the same exception (`docs/DATA-AND-LEGAL.md`), with its own browser TTL
because it is re-baked in place. Skip
by content hash, held in `tiles/manifest.json` in the bucket and written after
the objects it names, so a re-run with nothing re-extracted uploads nothing.
A published tile is world-readable, cacheable and indexable: there is no
authentication, no header the publisher can send, and the app's `robots.txt`
covers the app hostname only. What that leaves open is a crawler directive with
no bearing on what the site shows (`infra/cloudflare/README.md`, "Open, and the
operator's"). The tiles are cached by a `/tiles/*` zone rule at a 1-day TTL,
short because a re-extraction reuses the keys rather than addressing them by
content. Once published, the art layer, re-baked at the same keys while its
look is tuned, has a rule of its own with a browser TTL of minutes; a re-bake
is purged by prefix, and the publisher names which maps' art it changed. The build flag that points the map at them, and why it is a flag of
its own, is `dashboard/README.md`'s.

### Bucket layout, atomicity, freshness

```
/v1/manifest.json                    mutable   max-age=30   { gen, artifacts: {name: key}, generatedAt }
/v1/live.json                        mutable   max-age=30   fleet + positions fast lane, trace tails inline
/v1/snap/<ver>/runs.json …           immutable max-age=1y   one aggregate, at its own content version
/v1/run/<id>/<ver>/detail.json …     immutable max-age=1y   per-run detail and track
/v1/run/<id>/trace/<t0>.json         immutable max-age=1y   one closed five-minute trace window
```

Everything except the two mutable files is immutable and addressed by its own
content version. The manifest is the index: `artifacts` maps an aggregate name
to its bucket key, the way a run row's `snapshot` pointers do, so a reader
follows keys and never reconstructs one. `gen` rides along as the manifest's
own identity — the hash of the name/version pairs — and addresses nothing; it
is what tells the publisher whether the flip is worth a PUT.

Upload order is per-run → aggregates → manifest last, so a reader can never
observe a torn generation: an old manifest points at a complete old set, the
new one at a complete new set. `live.json` sits deliberately outside the
generation chain — for the fleet pips, freshness beats consistency. Superseded
versions are pruned after a few cycles; deletes are free. An aggregate keeps its
last five versions. A run keeps two while it is changing, so a reader still on
the previous manifest finds what that manifest names, and one once the previous
flip already named its current version. A finished run therefore holds only its
current objects, and a run re-keyed by a change to what its key covers (the
track, below) is down to the new set two passes later.

Each aggregate carries its own content version rather than one hash over the
whole set (GitHub issue #38), so a pass rewrites only what moved. Under a
single hash a live run taking a turn moved `runs.json`, `results.json`, every
`ladder-*.json` and `models.json`, and the pass rewrote all ten aggregates
under a fresh prefix — three of seven compared were byte-identical.
`playtimeMs` is zeroed alongside `now` when a payload is hashed for
addressing, for the same reason: it advances with the wall clock on every pass
of a live run, so hashing it made a run's detail and every aggregate carrying
the figure churn on passes where nothing had happened. The cost is that a
change to `playtimeMs` alone — the live figure between turns, or a level mark
revised by a pause recorded after the fact — publishes on the next real change
rather than immediately.

**The manifest is a contract, so publisher and reader move together.** A
reader that knows `artifacts` falls back to the one-prefix layout when it meets
a manifest without it, but a reader that does not know `artifacts` reads `gen`
and derives a key no longer written. So the dashboard deploys first and the
publisher second; between the two the site is correct on both shapes.

Worst-case staleness is push cadence + edge TTL, about six minutes at the
five-minute cadence. If that ever matters, a cache-purge API call on the two
mutable URLs after each push tightens it to the push cadence.

### Trace segments

A run the trace recorder drove has positions at about 1 Hz and the unit state
beside them, packed one segment per run per UTC-aligned five-minute window
(`runner/viewer/trace.ts` is the codec and the format). That is what lets the
map play a character back as movement rather than a pip that jumps once a pass.
A segment is published once, when its window closes, at
`v1/run/<id>/trace/<t0>.json`, and is immutable like the content-addressed
objects but addressed by its window: a closed window never changes. Closed
means a minute (`SETTLE_MS`) past its end, so a row the recorder drains late
still lands in it. A row that arrived after the PUT would be gone for a year
at the edge.

- **Listed, never guessed.** The run's `track.json` gains `trace: {segMs,
  segs}`, the windows as runs of `[firstT0, count]`, and each live position in
  `live.json` gains `trace: {segMs, recent, tail}`: the last three closed
  windows, and the tail, everything since, inline. A reader fetches only a
  window one of those lists. The edge caches a 404 for a day, so asking for one
  speculatively would hide it after it lands.
- **Before what lists it.** Segments go up in the run wave, before the
  aggregates and both mutable files. A failed one fails the pass, so no
  `live.json` and no manifest naming it is written. The renderer also cuts
  `live.json`'s `recent` to the windows a published track lists, so the
  property does not rest on timing.
- **Rendered once.** The state file records each run's published windows as
  the same packed runs (`traceSegs`), not as a hash per key. A pass asks the
  viewer only for windows it does not hold, so a week-long run's two thousand
  segments are neither re-read nor re-encoded. Throwing the state file away
  costs one re-upload of every segment, the same repair as for every other key.
- **Never pruned.** No version supersedes a window, so none is surplus. They
  accumulate: about 6 KB a segment raw, so roughly 50 MB per character-month
  of continuous play against R2's 10 GB free storage.
- **Runs before the recorder** have no `trace` table. Their tracks carry no
  `trace` field, so their bytes and keys are what they were, and nothing is
  backfilled.
- **A published segment cannot be corrected in place.** A content-addressed
  run object moves to a new key when its projection changes. A segment's key
  is its window, so a change to the codec or to `projectTraceSegment` reaches
  only windows that close after it ships. Two things hold the old ones: the
  edge caches them for a year, and `traceSegs` keeps them from being PUT again.
  Correcting published windows takes three things together: a new key prefix
  the reader moves to (`trace2/`), a cleared `traceSegs`, and a purge of the
  old prefix. A change to the content boundary is therefore one to settle
  before segments go out, not after.

One trace-specific cache fact: segments sit under `/v1/run/`, so the zone's
immutable rule and its rate limit (60 requests per 10 seconds per IP) cover
them. A replay asks for one segment per five minutes of play, so even 60×
playback is about one request every five seconds. A player should prefetch
around the cursor, not a whole run.

The reader is `dashboard/src/lib/traceplayer.ts`, and it is written to that
budget. The live map fetches only for the runs drawn on the continent on
screen: the window under the playhead, and the next listed one in the last
minute before the playhead reaches it, with at most four requests in flight
for the page. A replay fetches the cursor's window and prefetches the next
listed one about five wall seconds ahead, and only at 60× or slower; faster,
it plays the track's 60 s points. Either way a `t0` is requested only once a
list named it. The public live map runs about nine minutes behind real time,
because a `live.json` lands about every seven: the delay is the publish
period plus the two 30 s caches, a poll and a margin, with the period learned
from the `generatedAt`s the page sees (`dashboard/README.md`, "The map's
player"). That is the price of movement rather than a jump per pass.

### Data plane: R2 behind a custom domain with a cache rule

R2 has free egress and a free tier (10 GB stored, 10M reads, 1M writes per
month) that covers this corpus many times over: a few hundred runs today, and only
projected JSON is ever uploaded — a fraction of the ~3 MB/run the private
trajectories weigh. Two setup facts carry all the operational risk:

- The CDN cache only fronts a bucket through a **custom domain**; the
  `r2.dev` URL is uncached, and the bucket's Public Development URL stays
  disabled: it would be a second, un-ruled address for the objects the cache
  rules exist to sit in front of.
- Cloudflare does **not cache JSON by default**. An explicit cache rule on
  the data hostname ("eligible for cache, respect origin TTL") is required,
  with the publisher setting `cache-control` per object at PUT. Forgetting
  the rule is the one real misconfiguration cost: every request becomes a
  billed read against the bucket (~$7/month at 30M requests/month, versus ~$0
  with the rule).

### App plane: the SPA on Workers Static Assets

The built dashboard deploys as a Workers Static Assets project (`wrangler
deploy`, SPA not-found handling for the client router) on
`wrathbench.shard.page`, a Custom Domain the deploy itself creates and owns;
`workers_dev` is off, so the site has exactly one origin and the card's
absolute `og:image` cannot point at a second one. Static asset requests
are free and unlimited on the free plan, and with no fetch handler there is no
Worker invocation anywhere in the read path. Workers Static Assets rather
than Pages: Pages still works but Cloudflare's own guidance points new
projects at Workers, which has feature parity and is where the limits get
raised.

### Dashboard: a snapshot client behind the existing seam

`dashboard/src/api/client.ts` already defines the one `Client` interface every
page consumes, with injectable `fetch` and `base`. A `snapshot-client.ts`
implements the same interface over the bucket. Internal memoisation is what
leaves `poll.ts` and every page's stated interval untouched — ticks between
snapshot refreshes resolve from memory. `raw()` rejects with the same 403
semantics the viewer's public mode already answers, which the pages already
handle; SSE is guarded off. Selection is a Vite build-time env, so one build
flag produces the public bundle and the private build keeps its same-origin,
CORS-free posture (the bucket carries the project's first and only CORS
policy, scoped to the app hostname).

The public site includes the live fleet and map: pips and
fleet state at the push cadence, and the map over real minimap
tiles. Where a tile comes from is
`dashboard/src/lib/tiles.ts` and nowhere else — the data hostname in the public
build, same-origin in the private viewer — so the two shapes share one path and
neither is special-cased. Replaying a freeplay character end to end works there too: the
track carries its character — the identity, the place in the
chain and the run ids either side — so the play bar's previous/next attempt
links need no second request, which is what makes them work over static
snapshot objects at all. The published `track.json` is content-addressed
with its `detail.json`, entries and scratchpad under one version, and a new
attempt changes that detail's `character`, so the key rotates and the neighbours
never go stale. Two clock fixes keep the
staleness story honest, and both are improvements for the private dashboard
too:

- Fleet-heartbeat staleness must be computed against the response's own
  `now`, not the browser clock — otherwise a healthy snapshot pushed a
  cadence ago trips the fleet-dead threshold in
  `dashboard/src/lib/fleet.ts`. This is what makes a slower cadence safe: the
  age is frozen at render time rather than growing while a reader waits. The
  map's pip dimming reads the same way, through `positionAgeMs` in
  `dashboard/src/lib/mapview.ts`.
- A shell banner in snapshot mode states the data's age from the
  artifact's `generatedAt`, and warns when the publisher has evidently stopped
  pushing. Three clocks exist (the supervisor's heartbeat, the push, the edge
  TTL) and the UI must not conflate them.

### The character page over a bucket

`/character/<id>` is the one page assembled in the browser rather
than published as an artifact of its own, and that is deliberate: every part of
it is already in the bucket. The chain and its totals come off `results.json`
through the same `characterViewOf` the viewer serves `/api/character/<id>`
from, and the curve comes from each attempt's already-published `track.json`.
One derivation, two transports — the rule the whole snapshot client is written
to — so the publisher did not change and no new object was added.

Three consequences worth stating rather than discovering:

- The walk runs against the **unfiltered** results, never a tier or series
  view. A character is durable across both, and resolving it against a filtered
  set would silently shorten its history instead of saying it is short.
- An attempt the snapshot published no track for contributes nothing to the
  curve and does not fail the page. The attempt list still names it.
- The page costs one extra object per attempt on first open, all of them
  already cached by the client's own memo and by the CDN.

## The content boundary

The projection is the legal boundary in code, and it is an **allowlist by
construction**: fresh objects naming every emitted field, never
delete-fields-from-a-copy — `EntrySummary` has an open index signature, so a
copy-and-delete projection is not statically bounded. The rules, mapped to
`docs/DATA-AND-LEGAL.md`:

- **Never**: wiki content (a `search_reference` tool result is replaced whole),
  raw trajectory lines (the unprojected record: run config, message arrays,
  every packet), and any local path or host fact. Raw lines are withheld by
  `WRATHBENCH_VIEWER_PUBLIC=1` and the publisher never renders them.
- **Minimap tiles**: shown on the public map, uploaded by the
  explicit `infra/publish-tiles.ts` step above and never by a
  snapshot pass. Independent of that: no snapshot
  *artifact* may name a tile (`runner/test/snapshot.test.ts` pins it).
- **Entries: names and ids stay, game prose goes** (docs/DATA-AND-LEGAL.md,
  "Trajectory logs"). One window per run is published —
  the feed's tail, `entries.json` beside `detail.json` — after `projectEntry`
  (an allowlist per entry type) and `redactGameProse`
  (`runner/viewer/redact-prose.ts`), which replaces the prose fields enumerated
  from `sdk/src/protocol.ts` and the SDK's own types wherever a decoded
  payload appears in a tool result — as JSON, or as the sandbox renders a
  snippet's value and its console objects (`Bun.inspect`, read in place) —
  and the gossip option text the SDK quotes in its own hints and errors.
  Quest titles, item, NPC, zone and spell names and
  every id remain. The run's `scratchpad.json` ships whole beside it, and
  the run page shows it as plain text, never parsed as markup (a page reads
  only the key its listing row names, so a run with no pad requests nothing).
  **Residual, stated plainly**: model-authored text — turn text, snippet
  code, the scratchpad, the episodic status, the words of console lines,
  objects the model rebuilt under keys of its own, and any tool result the
  model formatted as plain prose — is published as written and is not
  filtered; it may quote game prose. A change to the redaction needs no
  re-key of its own: the run's key hashes the projected window, so exactly
  the runs whose window the change alters move to a new key, and their old
  objects are pruned on the pass after. No "load earlier"
  and no live tail publicly: the window advances with the detail poll.
- **The run's session token, never**: runs recorded while the module still
  echoed it in its action replies carry it wherever a snippet logged one, in
  the model-authored text above. As a backstop for those, the public
  boundary strikes it by value, after projection (`publicText`,
  `runner/viewer/api.ts`), from every body that carries a run's text: the
  run's own detail, entries, track and scratchpad, each position's episodic
  status on the live map (`live.json`), and a character's attempts. The
  aggregates carry no model-written text. A token too short to be a secret
  (a run from before token hardening used its run id) is left alone.
- **Paths**: a container-internal prefix is made repo-relative — every
  exported projector's output crosses `scrubPathsValue`
  (`runner/viewer/scrub-paths.ts`); the model's text is otherwise as written, and every other absolute path stays "Never".
- **The action log ships** in the window: an `actions` record's notes are
  rebuilt field by field (`projectActionNotes`), their `args` against the
  body fields `ActionRequest` declares, and the client-cache `names` they
  carry pass like the others; a `say` text or raw payload in `args` is
  model-authored, the residual above.
- **Names pass**: `items[].name` and a track inventory's item names
  (`inv.items`), a move's `target`, a position's episodic
  `status` (text and zone name) and `terminationDetail`.
- **Still projected out**: the operator `objective`, `apiBase`, `pauseReason`
  free text (a fixed `"paused"` token stays), model last-error message text,
  the fleet config-rejection error and preflight tails, wiki bundle source
  (on a run row and inside an entry's restamped comparability tuple alike),
  and every local filesystem path and pid.
- **Character names are shown**. The runner
  generates them at character creation, so they are not game text; the
  `characterLabel` race/class pair, resolved from ids by our own tables, is
  shown beside them.
- **The safe core ships, less what no page reads** ("What is published", below):
  the `ResultRun` layer is ids, numbers and model identifiers — levels, XP,
  areas and achievements as ids, taxi facts, costs, tokens.
- **Deaths are public** (operator, 2026-10-18), everywhere a page shows them.
  A run's death count, its releases and resurrects and each death's turn ship
  on its `detail.json` (`projectDeaths`; a death site's position and zone stay
  off, as no page reads them), and a character's total on its card; the
  death, release and resurrect milestones were already in the entries window.
  Every run is re-keyed once by it, as it was for the travel marks.
- **A track's travel marks ship.** The replay draws flights in their own
  colour and leaves a gap at a teleport from the track's `travel` list, read
  off the trajectory at request time (`dashboard/src/lib/replay.ts`). Its
  flight takeoffs and landings, its hearthstone uses and its graveyard
  releases ship as kinds and timestamps, facts the safe core, the action log
  and the deaths already carry. The track is hashed into the run's key with
  the rest, so a replay published before the marks existed is re-keyed once and
  draws them: the old URL is cached for a year and cannot be corrected in
  place. That re-uploads every object of every run once, and the old set is
  pruned as above.

- **The trace ships positions and the unit frame, deaths included, not
  targets.** A segment (`projectTraceSegment`) keeps positions, cuts,
  flights, health and power, level and XP, aura spell ids with stacks and
  expiry, the combat, mounted, taxi, dead, ghost and resting flags, and a
  cast's spell, so a death reads as it happened: health at 0, the ghost, the
  Ghost aura on the corpse run and Resurrection Sickness after a spirit
  healer. Withheld: aura flags, and the `target`, which names another unit,
  and a player target with its health is another player's whereabouts. A
  window published before deaths were public is immutable and carries no
  `dead` or `ghost` and blank gauges while the character was down; the
  projector passes such a window back unchanged, so the bucket's verifier
  still reads it as a fixed point. The `tail` in `live.json` crosses the
  same projector.

The projection gets the heaviest testing in the tree: fixture responses
with poisoned fields (including keys smuggled through open signatures),
asserted against the exact allowlisted key set, fixture-based and green from
a bare clone like everything else.

### What is published

The bucket holds what the public dashboard reads and nothing else (operator,
2026-10-18). A field no page reads is bytes in the bucket and a place for
something that should never have left to ride out: a session token reached the
run feed inside a field nobody was looking at. Redacting a field that is
published for no reason is the wrong cure, so the projectors name the fields
the pages read, and the shared types (`api-types.ts`) may declare more than a
snapshot carries.

Chosen by an audit of every published object against the dashboard's source
(property reads through `dashboard/src`, `lib/`, the snapshot client and the
`@viewer` modules it imports), checked in a browser with each fetched body
wrapped in a read-recording proxy, and read one more time for anything the
proxy cannot see (hover content, popovers, branches no fixture reaches). What a
pass leaves out, and who reads what is left:

- **`runs.json` is the fleet table's join and the pointers.** `fleetRows`
  reads level, xp, tokens, speed, the provider's cost figure, playtime, the
  episode budget and the served model; the snapshot client follows `snapshot`.
  Typed as `PublicRunListRow`, and `fleetRows` is typed against it, so the
  compiler says it reads nothing else. Every other listing field is on
  `results.json` or the run's own `detail.json`, where the page that shows it
  reads it. This was two megabytes that move on every pass with a live run.
- **A run's `detail.json` states are the chart's three fields** (`ts`,
  `level`, `xp`, typed as `ChartSample`), and its cost is `actual` and
  `expected`, not a third copy of `expected` beside them. The row drops
  `objective` and `apiBase` (always null), the file's `mtime` and `bytes`, and
  `raceName`/`className`, which `characterLabel` already says. The run's whole
  quest count is the server's sum across restarts, applied before the
  projection, so the per-sample count is not needed to total it.
- **Entries lose the raw line's byte range** (`start`, `end`, which only the
  private viewer's raw links use), a request's `adapter`, `systemChars` and
  `usage`, a response's `outChars` and `usage`, an events batch's `ambient` and
  `folded`, and **a snippet call's copy of its code**: `run_snippet`'s only
  argument is the code, the runner writes it again as the next record, and the
  page prints that one (`lib/feedgroup.ts` pairs them by adjacency, turn and
  call index). The copy is dropped only where that pairing holds in the window
  as published, with equal text, which is also what keeps the projection a
  fixed point of itself. About a sixth of an entries window was this copy.
- **Cost figures carry no per-component `breakdown`** anywhere. A result row's
  figures carry what the ladder, the runs table and the character page read
  (the actual figure's note for a tooltip, `basis`, `usd`, `asIfMetered`, the
  backfill mark; the estimate's `basis`, `usd`, `asIfMetered`); the price row
  and its date are on a single run's page. A model's run list carries `actual`
  only, which is the column it prints.
- **A result row** also leaves out `platform`, `cliVersion`, `promptHash`,
  `serverBuild`, `wikiCoords`, `wiki` and `raceName`/`className`: the run page
  reads the first six off the run's own row and tuple.
- **Models** leave out, per run, the version and series, the character's ids,
  the served model and the start time, and per tier `otherSeries`,
  `reachedL5`, `lastEnded`, `lastReason` and the run ids; the roster table
  prints the counts and the target, and the run list is its own.
- **A move's `z`** (on the live feed and in a track): the map marks a
  destination on the plane.

`runner/test/public-projection.test.ts` pins each of these and scans the
dashboard's source for the unambiguous names, so a page that starts to read one
fails there until the projection carries it again. Nothing about a trace
segment, a run's character, the leaderboards' numbers or anything the model sees
changed. The run objects are content-addressed, so shipping this re-keys every
run's objects once (a full re-upload; the old set is pruned as usual), and a
site still on the previous dashboard build reads the trimmed bodies unchanged,
because the build reads none of what was left out.

Published and unread, left as they were because each is stated as public above
or is the operator's to decide: the `campaignVersion` and `arm` stamps on a
result row and a run's row (for matching a run to its campaign pane).

**A track's inventory is patches** (`inv`, `runner/viewer/track-inv.ts`): each
change as the slots that moved, where the track used to carry the whole
inventory on every point it changed on. That took a level-43 character's track
from 30.3 MB to 5.7 MB, and a live run's track is re-uploaded on every pass.
Unlike the trim above, an older dashboard cannot read the new shape, so the
dashboard reads both and, as with the manifest, the site deploys first and the
publisher second. A run's objects share one version, so the release re-keys
every run that recorded an inventory once, all four of its objects (a full
re-upload of those runs; the old set is pruned as usual), and a run that
recorded none keeps its key.

## What the ladder shows

Each row's headline numbers are still maxima over a model's counted runs, and
the page is plain about that. Beside them it shows the spread those runs
already paid for: per rung, how many of the runs whose records can answer that
rung reached it, and for the best level the median and range across the counted
runs that recorded one.

### The controls

Three of the four dropdowns are off the page. Race and class
asked a question an eval episode cannot answer differently — every scored run
is the same baseline character — and the harness select was the shell's
series selector spelled a second time. The tier and axes chips and the pareto
front are unchanged. What else is above the chart:

- **company** and **family** filters. Company is the model
  registry's own vendor (`infra/model-lineup.json`); family is the model *line*
  and is **derived from the slug** rather than looked up, because the registry's
  families are vendor-wide ("Claude" covers sonnet, opus, haiku and fable) and
  filtering by one would be filtering by company twice. Both option lists are
  derived from the rows on screen, so neither can go stale, and both ride in the
  URL so a reading of a slice can be linked.
- **exclude free**, the per-viewer preference it has always been — a standing
  opinion about what counts as evidence, not a slice of the field.
- **representative efforts**, **on by default**. For a model with several effort entries it shows only the efforts on
  **that model's own cost-against-xp Pareto front**: an effort that earned less
  XP *and* cost more than another effort of the same model is a knob setting,
  not a result. A model with one entry is untouched, ties are kept, and nothing
  is ever compared across models. The rule is `representativeEfforts` in
  `dashboard/src/lib/ladderfilter.ts`, pure and unit-tested, applied at the
  page so the chart and the table cannot disagree; the axes are fixed at cost
  and XP rather than following the axes chips, or the set on screen would mean
  something different on every view. On the data measured it hides
  five of twenty-eight entries at e90 and one of eight at e360; it removes no table row, because the table is keyed on
  the model and the chart on the (model, effort) pair.

### No explanatory prose on the page

Every derived view here has a paragraph's worth of "and here is what that
actually means" behind it, and none of it is printed under the chart or the
table. A reader who already knows would read past three sentences every visit;
a reader who does not would be reading an essay where they wanted a number. The
page shows the heading, the control labels and the axes; the sentences are one
hover away, on a small "i" beside the heading (`components/InfoHint.tsx`), and
at length in this document. The same goes for a line counting what the header's
series selector filtered out — the selector is labelled and explains itself.

The rule is scoped to the derived views. Home and the about page carry the
site's intro copy: a reader arriving cold needs to be told what this is before
any number means anything.

### The human reference

`dashboard/src/lib/reference.ts` holds two references the ladder does not draw:
an **empirical ceiling** derived at read time from the scored runs of the
selected series on the tier in view, and a **human speedrun band** stated per
tier — roughly level 9–10 by ninety minutes, level 18–19 by six hours.

The figures come from speedrun.com's Wrath of the Lich King Classic Archive
board, which carries a single entry in each of those categories: **1–10 in 1:31
on an Orc Hunter**, and **1–20 in 7:02:39**, both confirmed in a browser. The
e90 band is labelled "one Wrath entry, bracketed by Classic Era
and Cataclysm Classic"; the e360 band is "interpolated from one Wrath 1–20
entry", because a 1–20 run is not linear in level. The Classic Era and
Cataclysm Classic records sit either side as context, because they run
different XP rates than 3.3.5a.

Neither mark is a score, neither enters the row order, and neither is on the
page: the rail that carried them was hard to read, and one entry per category
is not enough data to earn the space. It returns if and when there are several
runs to state a distribution from. Nothing else reads the figures. A scripted
greedy-XP grinder and a deterministic walkthrough were considered as baselines
and not chosen: no scripted agent is built and nothing new is run.

## The social card

A link to the site pasted into Discord, Slack or anywhere else reading Open
Graph tags should unfurl with a title, a sentence, and a picture. Two facts
about crawlers decide the whole shape of it: they fetch the HTML with **no
JavaScript**, and they reject SVG. So the tags are in the static
`dashboard/index.html` and the picture is a PNG the snapshot publisher
re-renders every pass — the live chart cannot be either.

- **The picture** is `dashboard/src/lib/og.ts`, a pure string builder over the
  same derivation the homepage's scatter uses, so it cannot show a shape the
  page does not. It has an explicit dark ground because a card is composited on
  someone else's chrome. Colours
  are literal hex and the font stack is the site's own monospace face — resvg
  has no cascade, so a `var()` would paint nothing, and a card in a different
  face than the page it links to reads as someone else's card.

  Text is rationed rather than banned. Discord renders
  the card about 400 px wide inline, so nothing is set below 21 units — about
  7 px there — and only four things are set at all: the wordmark, the corner
  cue, the chart's identity in the top right, and one name above each frontier
  entry. The identity is `XP.caption` and `COST.caption` out of
  `dashboard/src/lib/axes.ts` verbatim, over the tier's length, so the card
  cannot drift from the chart it is a picture of. The names are
  `modelDisplay`'s, the front's only: the step line is the claim the card
  makes, and a name on a dominated point spends a glyph on a point nobody is
  being asked to read. Where two names would collide, `keepLabels` drops one
  rather than drawing them over each other — a card is a picture nobody proofreads before it is unfurled.

- **The render** is `infra/og-render.ts`: the drawing, the logos read off disk
  (the dashboard resolves them through `import.meta.glob`, which exists only
  under Vite), and a font probe. `@resvg/resvg-js` (MPL-2.0) rasterises, Bun
  having no rasteriser and the host's Chromium not being a pinned build
  dependency. The probe is load-bearing: resvg resolves a family through the
  host's font database and draws **nothing at all** when it matches none, with
  no error and no fallback box, so a render on a fontless host would produce a
  plausible card with its wordmark, its captions and every model name silently
  missing. `renderOgPng` refuses to return bytes unless a probe glyph draws,
  and the publisher's image carries `fonts-dejavu-core` for it
  (`infra/docker/runner.Dockerfile`).

- **Who renders it, and when.** The **publisher** does, every pass: after
  `infra/publish-dashboard.ts` has published a snapshot it renders the card
  from that pass's own `ladder-e90.json` and PUTs it to `v1/og.png` in the
  bucket, so the picture and the published numbers are the same data by
  construction. It is a PUT of its own rather than one of the engine's
  artifacts — `SnapshotArtifact` is a JSON body at a content-addressed key, and
  widening it to carry bytes at a mutable key would reach into `needsPut`,
  `classifyPath`, the pruning window and `infra/publish-accept.ts` for one
  image; `infra/publish-tiles.ts` is the precedent. The stamp is remembered in
  memory, so an unchanged card costs no PUT and a restart costs one, and a
  failure there never fails a pass: the JSON is the site. `v1/og.png` is
  mutable in the same sense `v1/manifest.json` is and wants the same short edge
  TTL from the zone's cache rules.

  `infra/render-og.ts` is the ship-time half — it writes the static asset the
  app origin serves, and seeds `v1/og.png` so a first ship does not point at an
  object no publisher has written yet. It seeds only an absent object (a HEAD
  first): the ship renders from the shipping machine's runs tree, which need
  not be the fleet's, and since the publisher PUTs only when its own render
  changes, a stale card written over the publisher's would stand until the
  ladder next moved.

- **The tags** are injected into `index.html` by a Vite `transformIndexHtml`
  hook over `dashboard/src/lib/og-tags.ts`. `og:image` must be absolute, so
  they exist only in a build told its origin: `WRATHBENCH_PUBLIC_ORIGIN` is the
  page the card links back to, `WRATHBENCH_SNAPSHOT_BASE` is the hostname the
  picture is served from (the same data hostname the SPA reads its JSON from),
  and the render's hash becomes `VITE_WRATHBENCH_OG_STAMP`, appended as `?v=`.
  A build that names no snapshot base falls back to the app origin's own
  `/og.png` — the private build's branch, not the public site's, since
  `deploy-dashboard.sh` hard-fails on an empty `WRATHBENCH_SNAPSHOT_BASE`; on
  the public site `dashboard/public/og.png` therefore ships unreferenced, as
  the thing a redirect or a rolled-back tag could still land on. The private
  viewer build names no origin at all and carries no image tags, rather than a
  relative URL no crawler could resolve.

  **The URL is still ship-stamped, and that is structural.** A crawler caches a
  card by URL and offers no purge, so the URL has to change when the picture
  does — but these tags live in a static `index.html` served with no Worker in
  the read path (`dashboard/wrangler.jsonc` forecloses one on purpose), so
  nothing short of a deploy can rewrite them. What the publisher buys is that
  any *fresh* scrape gets the current ladder; a crawler already holding a card
  keeps it until the next ship moves `?v=`. The only between-ship lever is a
  short edge and browser TTL on `v1/og.png` in the zone's cache rules, and
  Bun's S3 writer cannot send `Cache-Control` (see `infra/publish-dashboard.ts`),
  so that rule is the whole of it. **It is a required step, not a refinement:**
  `v1/og.png` matches none of the existing rules (30s on the two mutable JSON
  paths, long on `v1/snap/*` and `v1/run/*`), so it falls to the zone default
  for a PNG with no origin header, which is `max-age=86400` — measured against
  a `tiles/` object on the same hostname. Until a rule names it, the card at
  the edge is up to a day old rather than up to a pass old.

The unfurl itself is the last check in `infra/cloudflare/README.md`.

## Rejected alternatives

- **Cloudflare Tunnel / pull-through cache to the viewer** — the origin is
  the lab, so a cache-miss storm or one wrong header is inbound public load
  on the operator's lab; it also drags the module hardening into scope. Fails the premise.
- **D1 as the public store** — free tier hard-fails (errors, not throttling)
  at 5M rows read/day, exactly the hug-of-death moment; on paid, every read
  still invokes a billed Worker; read replication is still beta and its
  sessions API is Worker-binding-only.
- **Durable Objects** — a single-location, duration-billed actor is the
  opposite of reads-at-the-edge; the worst shape for a spike.
- **KV as primary** — propagation is "up to 60 seconds or more", consuming
  the entire freshness budget before the push cadence spends a cent of it;
  the free tier's 1,000 writes/day sits under a 1-minute cadence's
  1,440 (at the 5-minute cadence that particular clause does not bite,
  but the others do); and reads bill per key unless fronted by the cache — at
  which point R2 does the same job with explicit TTLs.
- **Pages** — no advantage over Workers Static Assets for this shape, and
  the limits work (100k files, etc.) lands on Workers first.
- **SQLite served over HTTP range requests (sqlite-wasm-http on R2), Turso
  embedded replicas, Parquet + DuckDB, ClickHouse** — real options for a
  later stage, in that order of nearness, and the bucket layout above is
  deliberately compatible with adding a `runs.sqlite` artifact next to the
  JSON. Not first: the range-request VFS is experimental with a
  cache-invalidation-per-push gotcha, Turso's embedded replicas want a
  long-lived process with local disk (a VPS shape, not an edge one), and
  the public site needs no live aggregates: ClickHouse is the operator's
  derived store (`docs/ARCHITECTURE.md`, "The derived store"), and the site
  is served from JSON snapshots.

## Cost

Numbers verified against the Cloudflare docs source (the
`cloudflare-docs` repo, which is what renders on the docs site). Modeling a
viral week at 1M requests/day:

| design | viral week | sustained 30M req/month |
|---|---|---|
| Static assets + R2 behind cache rule (this design) | ~$0 | ~$0 |
| Same, cache rule forgotten | $0 (inside free reads) | ~$7 |
| Worker + KV or D1 in the read path (paid) | $5 | ~$11–21 |
| Worker + anything on the free plan | fails (100k req/day cap) | fails |

The pattern: the dominant cost in any dynamic design is Workers request
billing, not the datastore — so the two designs that keep Workers out of the
read path both land at ~$0, and the real risk on the free plan is cliffs
(hard daily caps), not bills. Workers Paid at $5/month is cliff insurance,
needed only if a Worker ever enters the path.

One SKU clarification, because it changes what the budget buys: the $20/month
"Pro" plan is a **zone** plan — WAF, page rules, image optimization — and
includes none of Workers, KV, D1 or R2. It is not the SKU this design needs.
The plan ladder that matters here is Workers Free (sufficient) → Workers Paid
($5, optional insurance).

### The write side, measured

The table above prices **reads** — the spike this design exists to survive. The
**writes** are the side with a live-fleet-shaped cost.

Measured against a real fleet under a single `gen` hash over every aggregate, a
steady pass was **24 PUTs + ~4 DELETEs**: the ten snapshot aggregates,
`manifest.json`, `live.json`, and a detail/track pair per live run (six, at the
time). The count was near-constant whatever the cadence, because one live run
taking a turn changed `runs.json`, `results.json`, `ladder-*.json` and
`models.json`, and that rewrote all ten under a fresh prefix. Those are real
data changes — token counts, turns, levels, cost basis — not clock artifacts,
so normalizing timestamps alone would not have removed them.

Per-aggregate versions take the aggregate half of that down to
the ones that actually moved — three of seven compared on that pass were
byte-identical — and zeroing `playtimeMs` when hashing removes the passes where
a live run's clock alone had advanced; on that ratio a steady pass should land
around twenty. The floor is the point: an **idle**
fleet costs one `live.json` PUT per pass at any cadence (~9k/month at 300s).

A publisher rolled back to the single-hash scheme wants the state file deleted.
It reads `state.gens` as generation stamps, finds hashes that were
never path segments, and plans every aggregate as surplus — self-healing, but
it churns a pass. The state file is a cache the operator may throw away, which
is the documented repair for exactly this.

| cadence | class-A ops/month | against the 1M free tier |
|---|---|---|
| 60s | ~1.21M | over, about $0.94/month |
| 300s (current) | ~242k | ~24% |

The entire write cost is live runs, and the two levers on it are the cadence
and per-aggregate addressing.

A steady pass now makes 14 PUTs. Passes
run about every 6.7 minutes, because a pass takes one to two minutes on top of
the interval. That is about 90k class-A ops a month. Trace segments add one PUT
per live character per closed window, and that count does not depend on the
cadence: a window closes every five minutes, whenever the pass that uploads it
runs. A character live around the clock adds 288 a day, about **8.6k a month**.
Three such characters take the month to about 116k, roughly 12% of the free
tier. Nothing else per pass moves: the tail rides inside the `live.json` PUT
already made, and the window list inside a `track.json` a live run rewrites
every pass anyway.

Unverified at research time (primary pages blocked from the research
environment; confirm before relying on them): the exact Pro-plan feature
list (the Workers-exclusion is corroborated across sources), Turso plan
quotas, Cache Reserve pricing, and whether a Workers deploy rate limit would
constrain a redeploy-per-minute pattern (moot here — data moves through R2,
not redeploys).

## Crawlers

The site is a static projection, so what a crawler may read is decided by the
content boundary above, not by a directive. What the crawler posture decides is
*volume*: the headline material is meant to be found, the transcripts are not
meant to be bulk-pulled.

- The app hostname's `robots.txt` (`dashboard/public/robots.txt`) allows
  everything; it exists so link previews unfurl.
- The data hostname's `robots.txt` (`infra/robots.ts`, PUT by the publisher at
  start-up) disallows `/v1/run/` for every agent and allows the rest. Its content-signal
  line states the terms for what is allowed: search and live answers yes,
  training no.
- A zone rate limit on `/v1/run/` at the data hostname is the enforcement for agents
  that do not read the file. A reader paging through runs stays well under it
  (`infra/cloudflare/README.md`, step 4b).

Not done, deliberately: blocking by bot class, and charging crawlers for the
transcripts through Cloudflare's pay-per-crawl. The first is the next step if
the limit proves insufficient; the second is the intended shape for the
transcripts once that feature is generally available, and is the reason they
are disallowed rather than served with terms attached.

## Third-party origins

A run page and the map sidebar draw item icons and tooltips, and the way they
do it is a link to `https://www.wowhead.com/wotlk/item=<entry>` decorated in
the reader's browser by Wowhead's public tooltip script. The sidebar's unit
frame draws a traced character's buffs and the spell it is casting the same
way, as links to `https://www.wowhead.com/wotlk/spell=<id>`: the trace carries
the spell id and nothing else. So a visitor to those
two pages fetches `https://wow.zamimg.com/js/tooltips.js` and, per item or
spell, icon art from `wow.zamimg.com` and tooltip JSON from `nether.wowhead.com`. Those are
the only third-party origins the application asks for, alongside the
Cloudflare Web Analytics script (`static.cloudflareinsights.com`) — cookieless,
and appended at startup by `dashboard/src/main.tsx` on the public build only,
so the same bundle served by the private viewer reports nothing. The tooltip script is injected at runtime by
`dashboard/src/lib/wowhead.ts` rather than sitting in `index.html`, so a page
with no items asks for nothing. The reason for the
arrangement is the red line in `docs/DATA-AND-LEGAL.md`: we extract and serve
no item art — we publish the `item_template.entry` the server already gave us
and let somebody else's service supply the picture. A reader who blocks either
host loses the icons and keeps the panel: every cell falls back to the item's
name.
