# Public dashboard hosting — research and recommendation

A proposal for hosting the dashboard publicly, researched 2026-08-25. Nothing
in here is decided: the architecture below details the "published JSON
snapshots" stage that `docs/ARCHITECTURE.md` ("Persistence") already names as
proposed, and every choice that shapes what the public site means is listed
under "Operator decisions" at the end. GitHub issue #10 is the standing
public-hosting checklist this document feeds; `docs/DATA-AND-LEGAL.md` remains
the binding constraint set.

## Goal and constraints

The runs stay on the operator's hardware (the [removed] k8s lab). The public
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
covers backfill and smoke tests. Credentials are one R2 key pair scoped to
the one bucket, held only by the publisher.

Minimap tiles are published to the gated site by a second, separate script
(`infra/publish-tiles.ts`), decided by the operator 2026-08-30. It is never
part of a snapshot pass: the loop above uploads JSON only, and the tiles are
uploaded by an explicit operator run — `--dry-run` prints the plan, `--upload`
performs it. It reads `data/minimap/<mapId>/<row>_<col>.png` and writes
`tiles/<mapId>/<row>_<col>.png` in the same bucket, keyed by the path the
viewer already serves so the SPA asks for one URL in either shape. Skip
by content hash, held in `tiles/manifest.json` in the bucket and written after
the objects it names, so a re-run with nothing re-extracted uploads nothing.
Tiles are served only behind the gate, `private, max-age=3600` and
`X-Robots-Tag: noindex`; the same headers the viewer sends under
`WRATHBENCH_VIEWER_TILES_PUBLIC=1`.

### Bucket layout, atomicity, freshness

```
/v1/manifest.json                    mutable   max-age=30   { gen, generatedAt }
/v1/live.json                        mutable   max-age=30   fleet + positions fast lane
/v1/snap/<gen>/runs.json …           immutable max-age=1y   the aggregate set
/v1/run/<id>/<ver>/detail.json …     immutable max-age=1y   per-run detail and track
```

Everything except the two mutable files is immutable and addressed by a
generation stamp (aggregates) or a content version (per-run). Upload order is
per-run → aggregates → manifest last, so a reader can never observe a torn
generation: an old manifest points at a complete old set, the new one at a
complete new set. `live.json` sits deliberately outside the generation chain
— for the fleet pips, freshness beats consistency. Old generations are pruned
after a few cycles; deletes are free.

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
deploy`, SPA not-found handling for the client router). Static asset requests
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
over minimap tiles — since 2026-08-30 the tiles are published to the gated
site as an explicit publisher step and served only behind the gate, so the SPA
requests `/tiles/...` in snapshot mode too and falls back to the labelled grid
square wherever a tile 404s. Two clock fixes keep the staleness story honest, and both are
improvements for the private dashboard too:

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
- **Minimap tiles**: published to the gated site since 2026-08-30, by the
  explicit `infra/publish-tiles.ts` step above and never by a snapshot pass.
  The gate serves them only to an authenticated reader, `private,
  max-age=3600` and `X-Robots-Tag: noindex`, and no snapshot artifact names
  one (`runner/test/snapshot.test.ts` pins that).
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
- **Names now pass**: `items[].name`, a move's `target`, a position's episodic
  `status` (text and zone name) and `terminationDetail`.
- **Still projected out**: the operator `objective`, `apiBase`, `pauseReason`
  free text (a fixed `"paused"` token stays), model last-error message text,
  the fleet config-rejection error and preflight tails, wiki bundle source,
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

## The gated interim shape (no domain on the account)

**This shape is scaffolding, and it is not what launches.** It exists so a
private preview can be shared before there is a domain; the launch shape is the
one described above, and the reasons are load-bearing rather than aesthetic. See
item 85 in `docs/FOLLOW-UPS.md` for the retirement steps.

Everything above assumes a zone. The account has none, and that is not a
detail to route around: on Cloudflare, access control, WAF, and cache are all
**custom-domain features**. The managed `r2.dev` development URL has none of
them, is rate-limited by design, and is world-readable to anyone who learns the
hostname. "An r2.dev URL with a password on it" is not a configuration that
exists.

So a preview that must not be world-readable needs something in the read path
able to say no, and on a zoneless account the only thing that can is a Worker.
The interim shape, called **Gated** in the runbook:

- one Worker on `*.workers.dev` serving the SPA from Static Assets **and**
  `/v1/*` and `/tiles/*` from an R2 **binding**, with `run_worker_first: true`
  so the gate sees the page load and not only the data. Only
  `/tiles/<mapId>/<row>_<col>.png` is reachable under the tile prefix —
  anything else there, `tiles/manifest.json` included, is a 404, and the Worker
  never lists the bucket. It also answers `/robots.txt` ahead of the gate,
  disallowing `/tiles/` and everything else;
- the bucket private, its Public Development URL **disabled** — the binding is
  the only path to an object;
- a shared password (`DASHBOARD_PASSWORD`, a Worker secret) accepted three ways:
  a session cookie, `?k=<secret>` so one link is shareable, and HTTP Basic for
  `curl`. The cookie holds a hash of the secret, not the secret;
- the TTLs this document puts in cache rules set by the Worker on egress
  instead, which incidentally answers the `Cache-Control` problem in "Bucket
  layout": Bun's `S3Client` cannot send the header, so the Worker sends it;
- no edge cache and no CORS. One origin, few readers, free-tier bucket reads.

Every one of those bullets is a cost, and the reason the Open shape is the one
that launches. A Worker in the read path means every request — page loads,
static assets, artifacts — is billed compute with a per-day free ceiling, and
nothing is held at the edge, so a spike converts directly into invocations and
bucket reads. The push-based design exists precisely so that a spike is absorbed
by cache in front of immutable objects, at roughly zero marginal cost and with
no compute in the path to saturate. The gate trades that away to buy a password,
which is the right trade for a preview shared with a handful of people and the
wrong one for a launch.

This inverts the design's "no Worker in the read path" for the read path only.
The projection, the snapshot renderer, the publisher, and the SPA source are
untouched and identical between the two shapes, so adopting a domain later is a
rebuild with a different `VITE_WRATHBENCH_SNAPSHOT_BASE` and a `wrangler.jsonc`
that drops its `main` — not a redesign.

What the gate is worth is exactly one shared secret: no identity, no per-person
revocation, nothing but rotation. That is the right weight for a preview shared
with named people, and it is why issue #10's content gate still binds the first
genuinely public deploy rather than being satisfied by this one. A link handed
to anyone who asks would be that deploy in all but name.


## Rejected alternatives

- **Cloudflare Tunnel / pull-through cache to the viewer** — the origin is
  the lab, so a cache-miss storm or one wrong header is inbound public load
  on [removed]; it also drags item 19 into scope. Fails the premise.
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

Measured 2026-08-25 against a real fleet: a steady pass is **24 PUTs + ~4
DELETEs**, made of the ten snapshot aggregates, `manifest.json`, `live.json`,
and a detail/track pair per live run (six, at the time). The count is
near-constant whatever the cadence, because `gen` is a single hash over every
aggregate: one live run taking a turn changes `runs.json`, `results.json`,
`ladder-*.json` and `models.json`, and that rewrites all ten under a fresh
prefix. Those are real data changes — token counts, turns, levels, cost basis —
not clock artifacts, so normalizing timestamps does not remove them.

| cadence | class-A ops/month | against the 1M free tier |
|---|---|---|
| 60s | ~1.21M | over, about $0.94/month |
| 300s (current) | ~242k | ~24% |

An **idle** fleet costs one `live.json` PUT per pass at any cadence (~9k/month
at 300s): the entire write cost is live runs. That is why the cadence, not a
timestamp fix, was the lever pulled — see item 86 in `docs/FOLLOW-UPS.md` for
what is still worth doing.

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
3. **Domain and naming** for the app and data hostnames.
4. **SKU**: free, or $5/month Workers Paid as cliff insurance.
5. **Attribution wording** for the footer and artifact envelope.
6. **Whether DATA-AND-LEGAL.md gains a "published projection" section**
   codifying decision 2 — this document can draft it; adopting it is the
   operator's edit.

Decided by the operator 2026-08-25, recorded here: the public site includes
the live fleet and map views at snapshot cadence (not a results-only site),
accepting that positions reveal near-real-time lab activity.

Also decided by the operator 2026-08-25: the first deploy is a **test run for
going public**, not the public launch — no custom domain for now, and a basic
shared password so the site is reachable by anyone the operator sends the link
to and by nobody else. That settles decision 4 as *free plan* for the moment and
defers decision 3; it does not touch decision 2, which still gates the
ungated deploy. The operator's stated premise — an `r2.dev` hostname with a
password on it — is not available on Cloudflare (see "The gated interim shape"),
so the same intent is served by a Worker gate instead, and the bucket's Public
Development URL stays disabled.

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
