# Public dashboard hosting

How the public site is hosted, and why. Researched 2026-08-25, decided the same
week, shipped 2026-08-30 in a password-gated interim shape, and moved to the
**Open** shape described here on 2026-09-11 (item 85): the app at
`https://wrathbench.shard.page`, the data at
`https://wrathbench-data.shard.page`, and no Worker in the read path. The
cutover runbook is `infra/cloudflare/README.md`. The architecture is the "published
JSON snapshots" stage `docs/ARCHITECTURE.md` ("Persistence") names, and the
choices that shape what the public site means are under "Operator decisions"
at the end. GitHub issue #10 is the standing public-hosting checklist;
`docs/DATA-AND-LEGAL.md` remains the binding constraint set.

## Goal and constraints

The runs stay on the operator's hardware. The public
site is **push-based**: the lab pushes derived data outward on a timer, and no
public request ever reaches it — so a traffic spike, however large, is
Cloudflare's problem and not the lab's. Freshness of a few minutes is
acceptable (the operator's call; the cadence was 60s at first and is 5 minutes
since 2026-08-25, for the write-cost reason in "Cost" below. The harness's own
floor is finer than either: state samples land every 60s and the fleet
heartbeat every 30–60s, so even a 60s push loses almost nothing the private
dashboard actually has). Budget: Cloudflare free tier, with at most a small
paid step.

Push-out has a second benefit worth stating: FOLLOW-UPS item 19 (shared secret
on the module port, token-to-character binding, snippet filesystem sandboxing)
gates any *inbound* public exposure of the control surface. A publisher that
only makes outbound S3 PUTs exposes nothing inbound, so the public dashboard
does not wait on item 19. The private viewer keeps its loopback/LAN posture
unchanged.

## The live viewer is not a public service

Public delivery is **static snapshots only**. `runner/viewer` — the live
viewer, on loopback or an explicitly opted-in LAN — is private and
operator-only, and running it Internet-facing is unsupported: it reads the runs
directory, tails live trajectories, holds an SSE connection open per watcher,
and answers `/api/info` about the operator's own machine. Nothing about it is
designed to survive a public request rate, and no gate in this repo fronts it.

`WRATHBENCH_VIEWER_PUBLIC=1` is not a way to publish it. What that flag means
since GitHub issue #30 (2026-09-01) is: every JSON body the handle emits
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
1,016-run tree at 0.78 GB peak RSS rather than 4.4 GB (2026-09-08). Credentials are one R2 key
pair scoped to the one bucket, held only by the publisher.

Minimap tiles are published by a second, separate script
(`infra/publish-tiles.ts`), decided by the operator 2026-08-30. It is never
part of a snapshot pass: the loop above uploads JSON only, and the tiles are
uploaded by an explicit operator run — `--dry-run` prints the plan, `--upload`
performs it. It reads `data/minimap/<mapId>/<row>_<col>.png` and writes
`tiles/<mapId>/<row>_<col>.png` in the same bucket, keyed by the path the
viewer already serves so the SPA asks for one URL in either shape. Skip
by content hash, held in `tiles/manifest.json` in the bucket and written after
the objects it names, so a re-run with nothing re-extracted uploads nothing.
Under the gate they were served `private, max-age=3600` and `X-Robots-Tag:
noindex` to an authenticated reader only. The Open shape keeps none of those
three — no authentication, no header the publisher can send, and the app's
`robots.txt` covers the app hostname only — so a published tile is
world-readable, cacheable and indexable. **That does not reopen the decision**,
which was taken on 2026-08-30 and reaffirmed on 2026-09-11; what it leaves is a
crawler-directive question with no bearing on what the site shows
(`infra/cloudflare/README.md`, "Open, and the operator's"). The tiles are cached
by a `/tiles/*` zone rule at a 1-day TTL, short because a re-extraction reuses
the keys rather than addressing them by content.

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

Per-aggregate versions replaced one hash over the whole set on 2026-09-04
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
month) that covers this corpus many times over: ~150–200 runs today, and only
projected JSON is ever uploaded — a fraction of the ~3 MB/run the private
trajectories weigh. Two setup facts carry all the operational risk:

- The CDN cache only fronts a bucket through a **custom domain**; the
  `r2.dev` URL is uncached.
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

The public site includes the live fleet and map (operator's choice,
2026-08-25): pips and fleet state at the push cadence (5 minutes), and the map
over real minimap tiles (operator, 2026-08-30). Where a tile comes from is
`dashboard/src/lib/tiles.ts` and nowhere else — the data hostname in the public
build, same-origin in the private viewer — so the two shapes share one path and
neither is special-cased. Replaying a freeplay character end to end works there too: since item 119 the
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

`/character/<id>` (item 128) is the one page assembled in the browser rather
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
- **Minimap tiles**: shown on the public map (operator, 2026-08-30), uploaded
  since then by the explicit `infra/publish-tiles.ts` step above and never by a
  snapshot pass — behind the gate's password until 2026-09-11 and world-readable
  from the data hostname since. Independent of that, and unchanged: no snapshot
  *artifact* may name a tile (`runner/test/snapshot.test.ts` pins it).
- **Entries: names and ids stay, game prose goes** (docs/DATA-AND-LEGAL.md,
  "Trajectory logs", operator 2026-08-30). One window per run is published —
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
  otherwise as written, and every other absolute path stays "Never" (operator,
  2026-09-11).
- **Names now pass**: `items[].name`, a move's `target`, a position's episodic
  `status` (text and zone name) and `terminationDetail`.
- **Still projected out**: the operator `objective`, `apiBase`, `pauseReason`
  free text (a fixed `"paused"` token stays), model last-error message text,
  the fleet config-rejection error and preflight tails, wiki bundle source
  (on a run row and inside an entry's restamped comparability tuple alike),
  and every local filesystem path and pid.
- **Character names are shown** (operator decision, 2026-08-30). The runner
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
the page is plain about that. Beside them it now shows the spread those runs
already paid for: a rung cell reads "2/3" — how many of the runs whose records
can answer that rung reached it, with the link still going to the first that
did — and under the best level sits the median and range across the counted
runs that recorded one. Below the table, two labelled reference lines say what
a level reading means. The empirical ceiling is derived at read time from the
scored runs of the selected series on the tier in view, so it is never a
constant and its label names what it is a maximum over. The human speedrun
band is stated per tier — roughly level 9–10 by ninety minutes, level 18–19 by
six hours — and each label says how thin the sourcing is rather than claiming
there is none: "one Wrath entry, bracketed by Classic Era and Cataclysm
Classic" at e90, "interpolated from one Wrath 1–20 entry" at e360.
speedrun.com's Wrath of the Lich King Classic Archive board carries a single
entry in each of those categories — 1–10 in 1:31 on an Orc Hunter, 1–20 in
7:02:39 — both confirmed in a browser by the operator on 2026-09-16, and the
Classic Era and Cataclysm Classic records stay as context on either side
because they run different XP rates than 3.3.5a. One entry per category fixes a
pace, not a distribution, and a Hunter route with death warps is an upper bound
on what WrathBench's fixed Dwarf Paladin can do. The figures, the caveats and
the run URL where one was given live in `dashboard/src/lib/reference.ts` and
are repeated in the footnote under the strip. Neither line is a score and
neither enters the row order.

## The social card

A link to the site pasted into Discord, Slack or anywhere else reading Open
Graph tags should unfurl with a title, a sentence, and a picture. Two facts
about crawlers decide the whole shape of it: they fetch the HTML with **no
JavaScript**, and they reject SVG. So the tags are in the static
`dashboard/index.html` and the picture is a PNG rendered at ship time — the
live chart cannot be either.

- **The picture** is `dashboard/src/lib/og.ts`, a pure string builder over the
  same derivation the homepage's scatter uses (`homeLadderRuns`,
  `ladderPoints`, `ladderChartLayout`, `paretoFront`), so it cannot show a
  shape the page does not. 1200×630, an explicit dark ground because a card is
  composited on someone else's chrome, the Pareto frontier as a step line, one
  logo puck per entry with the frontier's ringed and the rest dimmed. No axis
  labels, no point labels, no tick text: Discord renders the card about 400 px
  wide inline and a wall of 4 px glyphs reads as a broken image. The wordmark
  is the one text element. Colours are literal hex — resvg has no cascade, so
  a `var()` would paint nothing.
- **The render** is `infra/render-og.ts`, run by `infra/deploy-dashboard.sh`
  before the snapshot-mode build. It takes its runs from a snapshot pass's own
  `ladder-e90.json` rather than a live poll, so the picture and the published
  numbers agree; rasterises with `@resvg/resvg-js` (MPL-2.0), Bun having no
  rasteriser and the host's Chromium not being a pinned build dependency; and
  writes `dashboard/public/og.png`, which is gitignored as the build product it
  is. It prints the PNG's content hash, and the ship fails outright if the
  render does — tags pointing at an image that is not there are worse than no
  card.
- **The tags** are injected into `index.html` by a Vite `transformIndexHtml`
  hook over `dashboard/src/lib/og-tags.ts`. `og:image` must be absolute, so
  they exist only in a build told its origin: `WRATHBENCH_PUBLIC_ORIGIN` (in
  `.env`) becomes `VITE_WRATHBENCH_PUBLIC_ORIGIN`, and the render's hash
  becomes `VITE_WRATHBENCH_OG_STAMP`, appended as `?v=` — a crawler caches a
  card by URL and offers no purge, so the URL has to change exactly when the
  picture does. The private viewer build names no origin and therefore carries
  no image tags at all, rather than a relative URL no crawler could resolve.

- **`robots.txt`.** The Open shape has no fetch handler and so serves nothing
  at that path unless a file is in `dashboard/public/`, which there now is, and
  it is permissive. The Gated shape's Worker answered it with a disallow-all
  ahead of the password form, and that was the *second* reason nothing
  unfurled, independent of the password: Slack and Twitter honour robots.txt,
  Discord does not, so even exempting `/` and `/og.png` from the gate would
  have unfurled in one place and not the others. Both blockers went with the
  gate. The file covers the app hostname only; the data hostname serves no
  `robots.txt`, because nothing in this repository writes an object at a bucket
  root.

The card could not unfurl at all until 2026-09-11 (item 111): the gate answered
every credential-less request — Discord's crawler included — with the 401
password form, `/` and `/og.png` among them, so a crawler saw the form and not
the tags. Nothing about the card was wrong; the gate was in front of it. Both
are gone with the Worker, and the unfurl is the last check in
`infra/cloudflare/README.md`.

## The repository link

The footer's GitHub link and the BibTeX `url` line on `/about` are behind
`VITE_WRATHBENCH_REPO_URL`, the third build-time flag beside
`VITE_WRATHBENCH_SNAPSHOT_BASE` and the card's two. Unset or empty — the
default everywhere, including today's public build — neither is rendered:
the link is not turned on yet, and one that 404s under the project's own name
is worse than no link on the one page a stranger reads first. Set to the
repository's URL, both appear.

`infra/deploy-dashboard.sh` reads `WRATHBENCH_REPO_URL` from `.env` the way it
reads `WRATHBENCH_PUBLIC_ORIGIN`, but empty is not an error there: no origin
means a broken card and stops the ship, no repo URL just means no link. **On
launch day the flip is one line in `.env` and a redeploy**, with no repository
edit. The value is validated as an http(s) URL and otherwise ignored, so a
stray setting cannot put an arbitrary scheme in an anchor; the link's text is
the last two path segments (`owner/repo`).

The footer only renders in the public build (it hangs off the snapshot
attribution), so in the private viewer this flag shows in the citation alone.

## The gated interim shape, 2026-08-30 to 2026-09-11 (history)

Everything above assumes a zone, and for six weeks the account had none. On
Cloudflare access control, WAF and cache are all custom-domain features, and
the managed `r2.dev` URL has none of them — "an r2.dev URL with a password on
it" is not a configuration that exists — so a preview that had to be shareable
but not world-readable needed something in the read path able to say no, and on
a zoneless account only a Worker can. The **Gated** shape was that: one Worker
on `*.workers.dev` serving the SPA from Static Assets *and* `/v1/*` and
`/tiles/*` from a private R2 binding with `run_worker_first: true`, a shared
`DASHBOARD_PASSWORD` accepted as a cookie, a `?k=` link or HTTP Basic, the TTLs
set on egress because Bun's `S3Client` cannot send them, no edge cache, no
CORS, and a disallow-all `robots.txt` answered ahead of the gate. It was
scaffolding and was always labelled as such: a Worker in the read path bills
every request including static assets, holds nothing at the edge, and so
converts a spike directly into invocations and bucket reads — the exact cost
the push-based design exists to avoid. The trade bought one shared secret with
no identity and no per-person revocation, which is the right weight for a
preview shared with named people and the wrong one for a launch.

It was retired on 2026-09-11 (item 85) when the `shard.page` zone arrived on
the operator's personal account: `dashboard/worker/` deleted, `main` and the
bucket binding dropped from `dashboard/wrangler.jsonc`, the bucket given its
own custom domain and the cache rules that go with it. What it cost the minimap
tiles is the three protections the gate had given them — authentication,
`private` caching and `noindex`. It did not cost the decision to show them,
which was 2026-08-30's and stands; it made that decision plainly public.
The projection, the snapshot renderer, the publisher and the SPA source were
identical between the two shapes throughout, so the move was a rebuild with a
different `VITE_WRATHBENCH_SNAPSHOT_BASE` and a `wrangler.jsonc` that drops its
`main`, exactly as this document predicted, and not a redesign. Git history has
the Worker.

## Rejected alternatives

- **Cloudflare Tunnel / pull-through cache to the viewer** — the origin is
  the lab, so a cache-miss storm or one wrong header is inbound public load
  on the operator's lab; it also drags item 19 into scope. Fails the premise.
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

Per-aggregate versions (2026-09-04) take the aggregate half of that from ten to
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

The entire write cost is live runs. The cadence was the first lever pulled, in
2026-08-25; per-aggregate addressing is the second.

Unverified at research time (primary pages blocked from the research
environment; confirm before relying on them): the exact Pro-plan feature
list (the Workers-exclusion is corroborated across sources), Turso plan
quotas, Cache Reserve pricing, and whether a Workers deploy rate limit would
constrain a redeploy-per-minute pattern (moot here — data moves through R2,
not redeploys).

## Operator decisions

Listed here rather than decided, per CLAUDE.md's rule that anything shaping
what a result means is the operator's:

1. **Confirm the snapshot stage.** ARCHITECTURE.md's "published JSON
   snapshots" stage is proposed, not decided; building the publisher decides
   it.
2. **Entries and game text** (issue #10's "Legal, first and blocking"): are
   entry summaries ever publishable, and under what redaction standard?
   Sub-decisions riding on it: `terminationDetail` / `pauseReason` free text,
   `items[].name`. Phase 2 is gated on this. (Character names rode on it once;
   they were decided separately on 2026-08-30 and are shown.)
3. **Domain and naming** for the app and data hostnames. **Decided
   2026-09-11**: `https://wrathbench.shard.page` and
   `https://wrathbench-data.shard.page`, on the operator's personal account,
   where the `shard.page` zone is. One label deep each, so Universal SSL covers
   both without an Advanced Certificate — `data.wrathbench.shard.page` would
   not have been. `shard.page` had been considered and declined on 2026-08-25
   because it pointed elsewhere; that reversed.
4. **SKU**: free, or $5/month Workers Paid as cliff insurance. **Decided
   2026-09-11: free**, and now on firmer ground than when it was provisional —
   the Open shape has no Worker in the read path at all, so the 100k
   requests/day cliff the Gated shape sat under does not exist for it. Workers
   Paid remains the insurance if a Worker ever enters the path.
5. **Attribution wording** for the footer and artifact envelope. **Still
   open.**
6. **Whether DATA-AND-LEGAL.md gains a "published projection" section**
   codifying decision 2 — this document can draft it; adopting it is the
   operator's edit.
7. **Whether the public map draws real minimap tiles. Decided 2026-08-30: it
   does**, and reaffirmed on 2026-09-11 when the Open shape stripped the gate's
   `private`/`noindex`/authenticated-reader protections from them. The shape is
   `infra/publish-tiles.ts --upload`, `WRATHBENCH_TILES_BASE` in `.env`, a
   redeploy, and a `/tiles/*` cache rule at a 1-day TTL. What is genuinely open
   is only a crawler directive for the prefix — a bucket-root `robots.txt` or a
   zone Transform Rule for `X-Robots-Tag` — which changes nothing the site
   shows.

Decided by the operator 2026-08-25, recorded here: the public site includes
the live fleet and map views at snapshot cadence (not a results-only site),
accepting that positions reveal near-real-time lab activity.

Decided by the operator 2026-08-25 and superseded on 2026-09-11: the first
deploy was a **test run for going public** rather than the launch — no custom
domain, and a shared password so the site was reachable by anyone the operator
sent the link to and nobody else. That deploy is over; see "The gated interim
shape" for what it was. The bucket's Public Development URL stays disabled
under both shapes, for different reasons — it was the gate's bypass, and it is
now the uncached, un-ruled second address for objects the cache rules exist to
put in front of.

## Phasing

- **Phase 1 — publisher and the aggregates-plus-fleet site** (~4–5 days):
  projection + snapshot renderer + allowlist tests; publish CLI with fake-S3
  tests (upload ordering, diffing, pruning); snapshot client + build flag +
  SSE/entries guards + staleness banner + the fleet-clock fix; Cloudflare
  setup (bucket, custom domain, CORS, cache rule, two least-privilege
  tokens) as an OPERATIONS.md runbook. Ships runs, ladder, episodes, models,
  campaigns, run detail without entries, fleet and map at 60s.
- **Phase 2 — redactor and entries**: shipped 2026-08-30 (see "The content
  boundary").
- **Phase 3 — a queryable artifact** (sqlite-over-range or Parquet) if the
  JSON set outgrows itself; the manifest-pointed layout already has room for
  it.

Everything stays fixture-tested and bare-clone green (`bun test`,
`bun run typecheck`); the live halves are verified the way the viewer's are,
by pointing the real publisher at a real runs directory and reading the
bucket back.

## Acceptance record

The readback half of GitHub issue #31's acceptance transaction, run 2026-09-11
against the production bucket with `infra/publish-accept.ts` — a read-only
walk of the generation the manifest points at. It was the only part of the
transaction the Gated shape could carry: the criteria that need a reader
through the host needed the gate's password, and the ones about edge cache
needed a zone. The Open shape has both, and
`bun infra/publish-accept.ts --base https://wrathbench-data.shard.page` is the
same walk over plain `GET` through the public hostname — no credential, real
`cache-control`, real `cf-cache-status`. It is the last step of the cutover
runbook, and this record is amended with its result once the cutover runs.

**A note on the criteria.** Issue #31's criterion 2 predates the operator's
2026-08-30 decisions and forbids four things this projection now publishes on
purpose: scratchpads (422 published here, whole), character names, item names,
and model-authored prose. Those clauses are superseded, not missed; what the
criterion still binds is what is checked below.

**What was read.** Source: `master` at `1db3b0f`, the verifier itself at
`9aa6085`; the objects were written by the publisher pod running
`harness-0.5-513-g803bd42`. Endpoint: the account's R2 S3 API
(`<account-id>.r2.cloudflarestorage.com`), bucket `wrathbench-public`.
Generation `0891dc5ed329`, generated `2026-09-10T23:43:37Z` (UTC; local
2026-09-11). **1,590 objects, 61.6 MB, 422 runs** — every one of them carrying
detail, track, entries and scratchpad pointers — across 10 aggregates. **Nothing was missing**: every key
the manifest named and every key a `runs.json` row pointed at resolved — which
is criterion 1, and criterion 6's "bounded reconciliation/readback pass" as one
manual run rather than anything scheduled.

**One finding, and it is real.** `wikiBundle` — the comparability tuple's wiki
bundle stamp, whose `source` is the operator's local dump filename — is
published in **136 places across 21 `entries.json` objects**, on `harness`
entries of kind `comparability_restamped`, in both the `before` and `after`
tuples. The projection withholds `wikiBundle` on a run row —
`projectComparability` drops that one key and copies every other field of the
tuple, so the leak is bounded to it — and this document's "Still projected out"
list names it, but `projectEntry` copies the `harness` entry's `before`/`after`
verbatim, so the same tuple ships unfiltered one layer down. The data was left
as it is: the fix is a projection change and a republish, not an edit to the
bucket. **The fix landed the same day** (`projectEntry` now sends any
comparability tuple it copies through `projectComparability`, and the verifier
scans for a dump filename by name as well as by key), so criterion 2's finding
is closed in code and awaiting the redeploy: a runner image bump, a publisher
rollout, a pass over the affected runs, then this readback re-run. Until that
rollout the bucket still holds the 136 occurrences, and a readback will also
report `projection-drift` on those 21 objects — re-projection now disagreeing
with what is published is the pending deploy, not a new defect.

**Forty-five paths, settled the same day.** Sandbox stack traces
(`/wrathbench/sdk/src/...`) inside `tool_result` text and snippet code:
container-internal paths from the image's own working directory, not the
operator's host, arriving through the model- and harness-authored surface
"Residual, stated plainly" describes. The verifier counts them separately from
its findings so they stay visible, and whether the documented residual covers a
container path was a content-boundary question and therefore the operator's.
**The operator's call, 2026-09-11**: strip the install prefix so such a path
becomes the repo-relative one it already is, and leave the rest of the text as
written — a path scrub, not prose filtering. **The scrub landed the same day**
(`runner/viewer/scrub-paths.ts`, applied at every exported projector and to the
scratchpad route; the verifier's root list is now imported from it, container
root included, so a scrub that stops running shows up here as a finding), and
it awaits the same redeploy as the `wikiBundle` fix above: until that rollout
the bucket still holds the 45, reported as *residual* because they sit under
`text` and `code`, alongside `projection-drift` on the objects carrying them —
the pending deploy, not a new defect.

**Cache metadata.** No object carries `Cache-Control`, which is the expected
state: Bun's S3 writer cannot send one, and in the Gated shape
`dashboard/worker/index.ts` sets the TTLs on egress instead (`private,
max-age=30` on the two mutable keys, `private, max-age=31536000, immutable` on
generation objects). Confirming that a reader sees them needs the gate
credential; re-run after item 85 against the Open shape's zone cache rules.

**Through the host**, unauthenticated: `/`, `/runs` and `/v1/manifest.json` all
answer `401`, the manifest as JSON rather than the SPA's HTML, and
`/robots.txt` disallows everything. That is the gate working, not the browser
smoke — the smoke and the deep-link check are deferred to item 85. The
bucket's Public Development URL could not be checked: the deploy token in
`.env` carries Workers Scripts Edit and Workers R2 Storage Read, and
`wrangler r2 bucket info` / `dev-url get` answer `Authentication error [code:
10000]` with it. Unverified rather than passed.

**Rollback, as implemented** (described, not exercised). Public access is the
Worker: the bucket is private and its binding is the only path to an object,
so `wrangler delete --config dashboard/wrangler.jsonc` removes the site, and
unsetting `DASHBOARD_PASSWORD` fails the gate closed at `503` without removing
it. Stopping the publisher (scale the Deployment to zero) freezes whatever
generation is current, because the manifest is written last and an interrupted
pass leaves the previous one authoritative. Rolling *data* back within the
retention window is manual: the last five versions of each aggregate and the
last two of each run survive a prune (`DEFAULT_KEEP_GENS`,
`DEFAULT_KEEP_RUN_VERSIONS` in `infra/publish-core.ts`), but nothing in the
publisher writes an older manifest back, so the supported move is to re-publish
from the runs directory. None of it can touch the evidence: the publisher
mounts `data/runs` read-only and writes only `data/publish`.

**Re-run after the 2026-09-11 deploy** (`harness-0.5-552-gb6fff52`, generation
`d74fd1e90e2e` generated 2026-09-11T01:38:05Z, readback from the workstation,
read-only): 1594 objects, 62.19 MB, 423 runs, 10 aggregates, **0 missing, 0
findings**. Criterion 2's two defects are gone from the published set — the
`wikiBundle.source` stamp (item 123) and the container-internal paths — after
the publisher's first two passes on the new build rewrote 451 + 73 objects and
pruned 449 + 67 old keys. Four residual notes remain, model-authored
`filesystem-path` mentions outside any known local root, published as written.
Criteria 3, 4 and 5 stay where they were: deferred to item 85.

**Through the Open shape's data hostname**, 2026-09-11, after the cutover to
the operator's own Cloudflare account (new bucket, custom domain
`wrathbench-data.shard.page`, zone cache rules, CORS; the cluster publisher
re-pointed by secret and restarted with an empty state file so its first pass
rewrote everything): `bun infra/publish-accept.ts --base
https://wrathbench-data.shard.page`, plain `GET`, no credential. Generation
`8142cd47749e`, generated 2026-09-11T03:35:54Z: 1594 objects, 62.31 MB, 423
runs, 10 aggregates, **0 missing, 0 findings**, the same four residual notes.
This is criterion 3 (a reader through the host sees only the projection) and
criterion 4 (cache metadata): the reader now sees `max-age=30` on
`v1/manifest.json` and `v1/live.json` and `max-age=31536000` on generation
objects, and a repeat request answers `cf-cache-status: HIT` — those headers
come from the zone rules, since no object carries one. CORS answers the SPA
origin only (`access-control-allow-origin: https://wrathbench.shard.page`).
The bucket's development URL is disabled and answers `401`, which closes the
"unverified" line above. Criterion 5 followed the same evening, once the Worker was deployed on the
new account (`bun ship`, wrangler version `e2951af0`, source `master` at
`48e5f64`): `/`, `/runs`, `/ladder`, `/map` and `/og.png` all answer `200` on
`wrathbench.shard.page`, an unknown path serves the SPA rather than a 404, and
a headless Chromium walk of `/`, `/runs`, a run detail, `/ladder` and
`/map?run=<id>` rendered real content from the data hostname on every route —
16 to 19 requests to the app origin and 4 to 7 to the data hostname per page,
**no request to `/tiles/` and none to `/api/`**, which is the snapshot base
doing what it should and a build made before the tile host was set. The
decision to show real tiles was already taken (2026-08-30, above); the upload
and a build carrying `WRATHBENCH_TILES_BASE` followed the same day, so this
walk records the grid rather than a withholding. The card's tags are
absolute against the public origin and `robots.txt` is permissive. Not
exercised: the Discord unfurl itself, which needs a paste. One thing the walk
turned up that nobody configured in the repository: the zone injects
Cloudflare Web Analytics (`static.cloudflareinsights.com`) into every page —
a zone-level setting on the operator's account, cookieless, and noted here so
it is not mistaken for something the build added.
