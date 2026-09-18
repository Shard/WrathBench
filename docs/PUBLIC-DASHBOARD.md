# Public dashboard hosting

How the public site is hosted, and why. The app is at
`https://wrathbench.shard.page`, the data at
`https://wrathbench-data.shard.page`, and no Worker sits in the read path. The
cutover runbook is `infra/cloudflare/README.md`. The architecture is the "published
JSON snapshots" stage `docs/ARCHITECTURE.md` ("Persistence") names. GitHub
issue #10 is the standing public-hosting checklist;
`docs/DATA-AND-LEGAL.md` remains the binding constraint set.

## Goal and constraints

The runs stay on the operator's hardware. The public
site is **push-based**: the lab pushes derived data outward on a timer, and no
public request ever reaches it — so a traffic spike, however large, is
Cloudflare's problem and not the lab's. Freshness of a few minutes is
acceptable (the operator's call; the cadence is 5 minutes, for the write-cost
reason in "Cost" below. The harness's own
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
applies to any future Helm/[removed] deployment: the public surface is the
static artifact bucket and the SPA in front of it, never a viewer, module or
MCP Service or Ingress.

## Recommended architecture

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
built-in; no rclone, no wrangler in the data path). Cadence: a fast lane
every ~60s, aggregate and per-run artifacts only when their inputs change.
Runs as one long-lived loop (a k8s Deployment or a compose service beside the
fleet) rather than a CronJob, because change detection wants the same
persistent mtime/size memoisation the viewer already uses; a `--once` mode
covers backfill and smoke tests. The per-run half of a pass is rendered and
uploaded in batches of `WRATHBENCH_PUBLISH_BATCH` runs (default 8) rather than
built whole and then pushed, and each batch's runs are then released from the
viewer handle, so what a pass holds does not grow with the runs tree; the
ordering below is unaffected, because those batches are the run wave and the
manifest is still written after all of them. That, with the trajectory scanners
reading in windows rather than whole files, is what puts a pass over a
1,016-run tree at 0.78 GB peak RSS rather than 4.4 GB. Credentials are one R2
key pair scoped to the one bucket, held only by the publisher.

Minimap tiles are published by a second, separate script
(`infra/publish-tiles.ts`), decided by the operator. It is never part of a
snapshot pass: the loop above uploads JSON only, and the tiles are
uploaded by an explicit operator run — `--dry-run` prints the plan, `--upload`
performs it. It reads `data/minimap/<mapId>/<row>_<col>.png` and writes
`tiles/<mapId>/<row>_<col>.png` in the same bucket, keyed by the path the
viewer already serves so the SPA asks for one URL in either shape. Skip
by content hash, held in `tiles/manifest.json` in the bucket and written after
the objects it names, so a re-run with nothing re-extracted uploads nothing.
A published tile is world-readable, cacheable and indexable: there is no
authentication, no header the publisher can send, and the app's `robots.txt`
covers the app hostname only. What that leaves open is a crawler directive with
no bearing on what the site shows (`infra/cloudflare/README.md`, "Open, and the
operator's"). The tiles are cached by a `/tiles/*` zone rule at a 1-day TTL,
short because a re-extraction reuses the keys rather than addressing them by
content.

`VITE_WRATHBENCH_TILES_BASE` is what points the build at them, and it is a
separate flag from the snapshot base on purpose: the upload is a separate,
occasional act, so deriving one from the other would have a JSON pass assert
that tiles are there. Left unset the map draws its labelled grid, exactly as
`WRATHBENCH_VIEWER_PUBLIC=1` already makes the viewer do — a complete map view
and the right one from a checkout that never ran the extraction.

### Bucket layout, atomicity, freshness

```
/v1/manifest.json                    mutable   max-age=30   { gen, artifacts: {name: key}, generatedAt }
/v1/live.json                        mutable   max-age=30   fleet + positions fast lane
/v1/snap/<ver>/runs.json …           immutable max-age=1y   one aggregate, at its own content version
/v1/run/<id>/<ver>/detail.json …     immutable max-age=1y   per-run detail and track
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
versions are pruned after a few cycles (the last five of each aggregate, the
last two of each run); deletes are free.

Per-aggregate versions replaced one hash over the whole set
(operator, GitHub issue #38). Under the old scheme a single live run taking a
turn moved `runs.json`, `results.json`, every `ladder-*.json` and
`models.json`, and the pass rewrote all ten aggregates under a fresh prefix —
three of seven compared were byte-identical. The same pass now rewrites only
what moved. `playtimeMs` is zeroed alongside `now` when a payload is hashed for
addressing, for the same reason: it advances with the wall clock on every pass
of a live run, so hashing it made a run's detail and every aggregate carrying
the figure churn on passes where nothing had happened. The cost is that a
change to `playtimeMs` alone — the live figure between turns, or a level mark
revised by a pause recorded after the fact — publishes on the next real change
rather than immediately.

**Publisher and reader move together.** The manifest is a contract, and the
transition has one asymmetry: a reader that knows `artifacts` falls back to the
old one-prefix layout when it meets a manifest without it, but a reader too old
to know `artifacts` reads `gen` and derives a key that no longer exists. So the
dashboard deploys first and the publisher second; between the two the site is
correct on both shapes. A tab still running pre-#38 JavaScript across the
publisher deploy sees 404s on the aggregates until it is reloaded — bounded by
the manifest's 30s TTL plus a reload, and not worth a compatibility write of
the whole set under one prefix, which is the cost the change exists to remove.
The pre-#38 objects need no migration: their keys classify as ordinary versions
of the names they carry, so the first flip after the change prunes them.

Worst-case staleness is push cadence + edge TTL ≈ 90–120s. If that ever
matters, a cache-purge API call on the two mutable URLs after each push
tightens it to ≈ the push cadence; not needed for a ~1 minute target.

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
implements the same interface over the bucket: resolve `manifest.json`
(memoised ~30s), fetch generation-addressed artifacts, serve `fleet()` and
`positions()` from `live.json`, and apply the episode/harness filters
client-side over the pre-rendered results artifact. Internal ~30s
memoisation is what leaves `poll.ts` and every page's stated interval
untouched — the fleet page still ticks at 5s, but ticks between snapshot
refreshes resolve from memory. `entries()`/`raw()` reject with the same 403
semantics the viewer's public mode already answers, which the pages already
handle; SSE is guarded off. Selection is a Vite build-time env, so one build
flag produces the public bundle and the private build keeps its same-origin,
CORS-free posture (the bucket carries the project's first and only CORS
policy, scoped to the app hostname).

The public site includes the live fleet and map (operator's choice): pips and
fleet state at the push cadence (5 minutes), and the map over real minimap
tiles (operator). Where a tile comes from is
`dashboard/src/lib/tiles.ts` and nowhere else — the data hostname in the public
build, same-origin in the private viewer — so the two shapes share one path and
neither is special-cased. Replaying a freeplay character end to end works there too: since the
track carries the four scalars of its character — the identity, the place in the
chain and the run ids either side — so the play bar's previous/next attempt
links need no second request, which is what makes them work over static
snapshot objects at all. The published `track.json` is content-addressed
beside its `detail.json`, and a new attempt changes that detail's `character`, so
the key rotates and the neighbours never go stale. Two clock fixes keep the
staleness story honest, and both are improvements for the private dashboard
too:

- Fleet-heartbeat staleness must be computed against the response's own
  `now`, not the browser clock — otherwise a healthy snapshot pushed a
  cadence ago trips the 180s fleet-dead threshold in
  `dashboard/src/lib/fleet.ts`. This is what makes a slower cadence safe: the
  age is frozen at render time rather than growing while a reader waits. The
  map's pip dimming reads the same way, through `positionAgeMs` in
  `dashboard/src/lib/mapview.ts`.
- A shell banner in snapshot mode says "data as of Ns ago" from the
  artifact's `generatedAt`, turning warning-coloured when the publisher has
  evidently stopped pushing. Three clocks exist (heartbeat 30–60s, push at
  the publish cadence, edge TTL ≤60s) and the UI must not conflate them.

Wire-type impact is two optional fields (`generatedAt`, `attribution`) on the
response envelopes in `runner/viewer/api-types.ts`, following that file's
optional-so-older-consumers-still-render convention.

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

The field rename that came with the page (`stream` → `character` on the run
detail and the track) needed no generation bump: snapshot artifacts are
addressed by a hash of their own content, so the renamed bodies simply mint new
keys, and the SPA ships in the same release as the data it reads. The one
visible effect is on a browser holding a cached SPA from before the release
against fresh data: its character card goes missing until it reloads. There is
no dual-reading reader, because carrying two spellings would be the half-rename
the change exists to end.

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
- **Minimap tiles**: shown on the public map (operator), uploaded by the
  explicit `infra/publish-tiles.ts` step above and never by a
  snapshot pass. Independent of that, and unchanged: no snapshot
  *artifact* may name a tile (`runner/test/snapshot.test.ts` pins it).
- **Entries: names and ids stay, game prose goes** (docs/DATA-AND-LEGAL.md,
  "Trajectory logs", operator). One window per run is published —
  the last 200 entries, `entries.json` beside `detail.json`, in the shape the
  run page's private path loads first — after `projectEntry` (an allowlist
  per entry type: the `meta` entry sheds the run config, `driver` and
  `claude_system` their paths, `pause`/`watchdog` their free-text detail) and
  `redactGameProse` (`runner/viewer/redact-prose.ts`), which replaces the
  prose fields enumerated from `sdk/src/protocol.ts` — quest details,
  objectives, area and completion text, questgiver/trainer greetings, the
  request-items and offer-reward text, gossip option text, item description,
  page and letter text, mail body, chat message — wherever a decoded payload
  appears in a tool result. Quest titles, item, NPC, zone and spell names and
  every id remain. The run's `scratchpad.json` ships whole beside it.
  **Residual, stated plainly**: model-authored text — turn text, snippet
  code, the scratchpad, the episodic status, console lines, and any tool
  result the model formatted as plain prose rather than JSON — is published
  as written and is not filtered; it may quote game prose. No "load earlier"
  and no live tail publicly: the window advances with the detail poll.
- **Paths**: a container-internal prefix is made repo-relative — every
  exported projector's output crosses `scrubPathsValue`
  (`runner/viewer/scrub-paths.ts`), which strips the runner image's
  `/wrathbench` working directory wherever a published string carries it, so a
  sandbox stack trace reads as `sdk/src/client.ts:123`; the model's text is
  otherwise as written, and every other absolute path stays "Never" (operator).
- **Names now pass**: `items[].name`, a move's `target`, a position's episodic
  `status` (text and zone name) and `terminationDetail`.
- **Still projected out**: the operator `objective`, `apiBase`, `pauseReason`
  free text (a fixed `"paused"` token stays), model last-error message text,
  the fleet config-rejection error and preflight tails, wiki bundle source
  (on a run row and inside an entry's restamped comparability tuple alike),
  and every local filesystem path and pid.
- **Character names are shown** (operator decision). The runner
  generates them at character creation, so they are not game text; the
  `characterLabel` race/class pair, resolved from ids by our own tables, is
  shown beside them.
- **The safe core ships whole**: the `ResultRun` layer is ids, numbers and
  model identifiers — levels, XP, areas and achievements as ids, taxi facts,
  costs, tokens — and is what the runs, ladder, episodes, models and
  campaigns pages are made of.
- **Every artifact carries the attribution statement** DATA-AND-LEGAL's
  "Scale and framing" requires (the harness runs on the AzerothCore community
  reconstruction of 3.3.5a; nothing Blizzard-owned is distributed), rendered
  in the shell footer.

The projection gets the most-tested file in the change: fixture responses
with poisoned fields (including keys smuggled through open signatures),
asserted against the exact allowlisted key set, fixture-based and green from
a bare clone like everything else.

## What the ladder shows

Each row's headline numbers are still maxima over a model's counted runs, and
the page is plain about that. Beside them it shows the spread those runs
already paid for: a rung cell reads "2/3" — how many of the runs whose records
can answer that rung reached it, with the link still going to the first that
did — and under the best level sits the median and range across the counted
runs that recorded one.

### The controls

The operator took three of the four dropdowns off the page. Race and class
asked a question an eval episode cannot answer differently — every scored run
is the same baseline character — and the harness select was the shell's
series selector spelled a second time. What is above the chart now:

- The **tier** chips and the **axes** chips, unchanged, both in the URL.
- A **filters** button opening a small popover with two native
  `<select multiple>` boxes, **company** and **family**. Company is the model
  registry's own vendor (`infra/model-lineup.json`); family is the model *line*
  and is **derived from the slug** rather than looked up, because the registry's
  families are vendor-wide ("Claude" covers sonnet, opus, haiku and fable) and
  filtering by one would be filtering by company twice. The derivation is dumb
  and stated: drop the provider prefix, drop the free marker, drop every
  dash-separated token carrying a digit — `claude-fable-5` → `claude-fable`,
  `gpt-6-astra` → `gpt-astra`. Both option lists are derived from the rows on
  screen, so neither can go stale. Values combine within a box and narrow
  across the two, and both ride in the URL (`?company=`, `?family=`) so a
  reading of a slice can be linked. The button carries the count of what is on.
- **exclude free**, the per-viewer preference it has always been — a standing
  opinion about what counts as evidence, not a slice of the field.
- **pareto front**, unchanged, `?pareto=1`.
- **representative efforts**, new and **on by default** (`?efforts=all` turns
  it off). For a model with several effort entries it shows only the efforts on
  **that model's own cost-against-xp Pareto front**: an effort that earned less
  XP *and* cost more than another effort of the same model is a knob setting,
  not a result. A model with one entry is untouched, ties are kept, and nothing
  is ever compared across models. The rule is `representativeEfforts` in
  `dashboard/src/lib/ladderfilter.ts`, pure and unit-tested, applied at the
  page so the chart and the table cannot disagree; the axes are fixed at cost
  and XP rather than following the axes chips, or the set on screen would mean
  something different on every view. On the data of 2026-09-18 it hides five
  of twenty-eight entries at e90 (`claude-fable-5`, `claude-fable-5 (high)`,
  `claude-fable-5 (none)`, `sonnet`, `sonnet (max)`) and one of eight at e360
  (`sonnet (medium)`); it removes no table row, because the table is keyed on
  the model and the chart on the (model, effort) pair.

Hovering a pin lights its table row and hovering a row lights its pins, keyed
on the model (`hoverKeyOf`); keyboard focus on a row does the same.

### No explanatory prose on the page (operator)

Every derived view here has a paragraph's worth of "and here is what that
actually means" behind it, and each one used to be printed under its chart or
table. A reader who already knows reads past three sentences every visit; a
reader who does not is reading an essay where they wanted a number. The page
shows the heading, the control labels and the axes; the sentences are one
hover away, on a small "i" beside the heading (`components/InfoHint.tsx`), and
at length in this document. The line counting what the header's series
selector filtered out went with them — the selector is labelled and explains
itself.

### The human reference

`dashboard/src/lib/reference.ts` holds two references the ladder does not draw:
an **empirical ceiling** derived at read time from the scored runs of the
selected series on the tier in view, and a **human speedrun band** stated per
tier — roughly level 9–10 by ninety minutes, level 18–19 by six hours.

The figures come from speedrun.com's Wrath of the Lich King Classic Archive
board, which carries a single entry in each of those categories: **1–10 in 1:31
on an Orc Hunter**, and **1–20 in 7:02:39**, both confirmed in a browser on
2026-09-16. The e90 band is labelled "one Wrath entry, bracketed by Classic Era
and Cataclysm Classic"; the e360 band is "interpolated from one Wrath 1–20
entry", because a 1–20 run is not linear in level. The Classic Era and
Cataclysm Classic records sit either side as context, because they run
different XP rates than 3.3.5a.

Neither mark is a score, neither enters the row order, and neither is on the
page: the rail that carried them was hard to read, and one entry per category
is not enough data to earn the space. It returns if and when there are several
runs to state a distribution from. Nothing else reads the figures — the home
page, the models page and the OG card never did.

## The social card

A link to the site pasted into Discord, Slack or anywhere else reading Open
Graph tags should unfurl with a title, a sentence, and a picture. Two facts
about crawlers decide the whole shape of it: they fetch the HTML with **no
JavaScript**, and they reject SVG. So the tags are in the static
`dashboard/index.html` and the picture is a PNG the snapshot publisher
re-renders every pass — the live chart cannot be either.

- **The picture** is `dashboard/src/lib/og.ts`, a pure string builder over the
  same derivation the homepage's scatter uses (`homeLadderRuns`,
  `ladderPoints`, `ladderChartLayout`, `paretoFront`), so it cannot show a
  shape the page does not. 1200×630, an explicit dark ground because a card is
  composited on someone else's chrome, the Pareto frontier as a step line, one
  logo puck per entry with the frontier's ringed and the rest dimmed. Colours
  are literal hex and the font stack is the site's own monospace face — resvg
  has no cascade, so a `var()` would paint nothing, and a card in a different
  face than the page it links to reads as someone else's card.

  Text is rationed rather than banned (operator). Discord renders
  the card about 400 px wide inline, so nothing is set below 21 units — about
  7 px there — and only four things are set at all: the wordmark, the corner
  cue, the chart's identity in the top right, and one name above each frontier
  entry. The identity is `XP.caption` and `COST.caption` out of
  `dashboard/src/lib/axes.ts` verbatim, over the tier's length, so the card
  cannot drift from the chart it is a picture of. The names are
  `modelDisplay`'s, the front's only: the step line is the claim the card
  makes, and a name on a dominated point spends a glyph on a point nobody is
  being asked to read. Where two names would collide, `keepLabels` drops the
  one that is worse on the y axis (per its spec's `better`) rather than drawing
  them over each other, with the wordmark, the identity block and the cue
  pre-reserved — a card is a picture nobody proofreads before it is unfurled.

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
  app origin serves, prints the stamp, and `--upload` seeds `v1/og.png` so a
  first ship does not point at an object no publisher has written yet. A
  missing R2 key pair skips the upload with a line rather than failing the
  ship.

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

- **`robots.txt`.** With no fetch handler the site serves nothing at that path
  unless a file is in `dashboard/public/`, which there is, and it is
  permissive — a disallow-all there stops an unfurl in the places that honour
  it (Slack and Twitter do, Discord does not). The file covers the app hostname
  only; the data hostname serves no `robots.txt`, because nothing in this
  repository writes an object at a bucket root.

The unfurl itself is the last check in `infra/cloudflare/README.md`.

## The repository link

The footer's GitHub link and the BibTeX `url` line on `/about` are behind
`VITE_WRATHBENCH_REPO_URL`, the third build-time flag beside
`VITE_WRATHBENCH_SNAPSHOT_BASE` and the card's two. Unset or empty, neither is
rendered — a link that 404s under the project's own name is worse than no link
on the one page a stranger reads first. Set to the repository's URL, both
appear.

`infra/deploy-dashboard.sh` reads `WRATHBENCH_REPO_URL` from `.env` the way it
reads `WRATHBENCH_PUBLIC_ORIGIN`, but empty is not an error there: no origin
means a broken card and stops the ship, no repo URL just means no link, so
turning the link on is one line in `.env` and a redeploy with no repository
edit. The value is validated as an http(s) URL and otherwise ignored, so a
stray setting cannot put an arbitrary scheme in an anchor; the link's text is
the last two path segments (`owner/repo`).

The footer only renders in the public build (it hangs off the snapshot
attribution), so in the private viewer this flag shows in the citation alone.

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
  the free tier's 1,000 writes/day sat under the original 1-minute cadence's
  1,440 (at today's 5-minute cadence that particular clause no longer bites,
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
  ARCHITECTURE.md's own staging says JSON snapshots come first, with
  Parquet/DuckDB when analysis outgrows JSONL scripts and ClickHouse only if
  a public dashboard ever needs live aggregates.

## Cost

Numbers verified 2026-08-25 against the Cloudflare docs source (the
`cloudflare-docs` repo, which is what renders on the docs site). Modeling a
viral week at 1M requests/day:

| design | viral week | sustained 30M req/month |
|---|---|---|
| Static assets + R2 behind cache rule (recommended) | ~$0 | ~$0 |
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
**writes** went unpriced until the loop actually ran, and they are the side that
has a live-fleet-shaped cost.

Measured 2026-08-25 against a real fleet: a steady pass was **24 PUTs + ~4
DELETEs**, made of the ten snapshot aggregates, `manifest.json`, `live.json`,
and a detail/track pair per live run (six, at the time). The count was
near-constant whatever the cadence, because `gen` was a single hash over every
aggregate: one live run taking a turn changed `runs.json`, `results.json`,
`ladder-*.json` and `models.json`, and that rewrote all ten under a fresh
prefix. Those are real data changes — token counts, turns, levels, cost basis —
not clock artifacts, so normalizing timestamps alone would not have removed
them.

Per-aggregate versions take the aggregate half of that from ten to
the ones that actually moved — three of seven compared on that pass were
byte-identical — and zeroing `playtimeMs` when hashing removes the passes where
a live run's clock alone had advanced. The post-change figure has not been
measured against a fleet; on the issue's own ratio a steady pass should land
around twenty. The floor is unchanged and was always the point: an **idle**
fleet costs one `live.json` PUT per pass at any cadence (~9k/month at 300s).

Rolling the publisher *back* across this change wants the state file deleted.
An old binary reads `state.gens` as generation stamps, finds hashes that were
never path segments, and plans every aggregate as surplus — self-healing, but
it churns a pass. The state file is a cache the operator may throw away, which
is the documented repair for exactly this.

| cadence | class-A ops/month | against the 1M free tier |
|---|---|---|
| 60s | ~1.21M | over, about $0.94/month |
| 300s (current) | ~242k | ~24% |

The entire write cost is live runs. The cadence was the first lever pulled;
per-aggregate addressing is the second.

Unverified at research time (primary pages blocked from the research
environment; confirm before relying on them): the exact Pro-plan feature
list (the Workers-exclusion is corroborated across sources), Turso plan
quotas, Cache Reserve pricing, and whether a Workers deploy rate limit would
constrain a redeploy-per-minute pattern (moot here — data moves through R2,
not redeploys).

## Third-party origins

A run page and the map sidebar draw item icons and tooltips, and the way they
do it is a link to `https://www.wowhead.com/wotlk/item=<entry>` decorated in
the reader's browser by Wowhead's public tooltip script. So a visitor to those
two pages fetches `https://wow.zamimg.com/js/tooltips.js` and, per item, icon
art from `wow.zamimg.com` and tooltip JSON from `nether.wowhead.com`. Those are
the only third-party origins the application asks for, alongside the
Cloudflare Web Analytics script (`static.cloudflareinsights.com`) the zone
injects into every page — a zone setting, cookieless, and not something the
build adds. The tooltip script is injected at runtime by
`dashboard/src/lib/wowhead.ts` rather than sitting in `index.html`, so a page
with no items asks for nothing. The reason for the
arrangement is the red line in `docs/DATA-AND-LEGAL.md`: we extract and serve
no item art — we publish the `item_template.entry` the server already gave us
and let somebody else's service supply the picture. A reader who blocks either
host loses the icons and keeps the panel: every cell falls back to the item's
name in its quality colour with its stack count, which is what the plain
`carrying:` line said before.
