# infra/cloudflare

The Cloudflare-side configuration for the public dashboard, checked in so the
setup is reviewable and reproducible instead of remembered. Nothing here is
applied by any script: the operator applies each file once, in the order the
cutover runbook below gives. The design these shapes come from — push-based
publisher, R2 as the data plane, no Worker in the read path — is
`docs/PUBLIC-DASHBOARD.md`; the steady-state operational runbook is
`docs/OPERATIONS.md`, "Public dashboard".

Since 2026-09-11 the deployed shape is the design's **Open** one, on the
operator's personal account, which is where the `shard.page` zone is:

| | |
| --- | --- |
| app | `https://wrathbench.shard.page` — Workers Static Assets, no fetch handler |
| data | `https://wrathbench-data.shard.page` — the `wrathbench-public` R2 bucket behind its own custom domain |
| TTLs | zone cache rules (below), because the publisher cannot send `Cache-Control` |
| CORS | `r2-cors.json`, the project's first and only CORS policy |
| gate | none |

Both hostnames are **one label deep**, which is not cosmetic: Universal SSL
covers `*.shard.page` and not `*.*.shard.page`, so `data.wrathbench.shard.page`
would need an Advanced Certificate and this does not.

| file | what it is |
| --- | --- |
| `r2-cors.json` | The `wrathbench-public` bucket's CORS policy, in R2's own bucket-CORS format. `GET`/`HEAD` from the app origin plus `http://localhost:5180` (the Vite dev server, so snapshot mode can be developed against the real bucket). It is bucket-wide, so it covers `v1/` and `tiles/` alike — which is what the map needs, since the tiles moved to the data hostname with everything else. Apply with `wrangler r2 bucket cors set wrathbench-public --file infra/cloudflare/r2-cors.json`. |

Origins match as exact strings, scheme included, so a wrong entry fails closed
with a CORS error in the browser rather than leaking anything.

The SPA's own deployment config is `dashboard/wrangler.jsonc`, kept beside the
build it uploads rather than here. It has no `main`: the read path is static
assets and cached bucket objects, and nothing is invoked.

## The cutover runbook

Do these in order — each step names the hostname or credential the next one
depends on. Steps 1–4 are the account; 5–8 are the lab and the deploy; 9 is the
proof. The repository side of all of this is already merged; nothing below
needs a code change.

**Two credentials, and they never meet.** Mint both before starting:

- **The publisher's**, an **R2 Object Read & Write** token *scoped to
  `wrathbench-public` alone*. It hands back an access key id and secret, which
  are `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY`. This is the only Cloudflare
  credential that lives on the cluster. It cannot deploy anything.
- **The deployer's**, `WRATHBENCH_CF_DEPLOY_TOKEN` in `.env` at the repository
  root — an API token with **Account → Workers Scripts: Edit** and **Zone →
  Workers Routes: Edit** on the `shard.page` zone (the app's route is a Custom
  Domain, so the deploy creates and owns its DNS record), plus **Account →
  Workers R2 Storage: Edit** if step 3 is run through `wrangler` rather than the
  dashboard. Add **Account → Account Settings: Read** if wrangler cannot resolve
  the account id on its own. It needs no object access: it never reads or writes
  a published artifact. `infra/deploy-dashboard.sh` reads it from `.env` and
  hands it to wrangler as `CLOUDFLARE_API_TOKEN` for the one command.

A third token, zone **Cache Purge**, is only wanted if the manifest TTL is ever
tightened by purging the two mutable URLs after each push. That is not the
current design — do not mint it now.

### 1. Create the bucket

An R2 bucket named `wrathbench-public`, on the personal account. Only projected
JSON is ever uploaded, a fraction of what a trajectory weighs, so the free tier
(10 GB stored, 10M reads, 1M writes a month) covers the corpus many times over.

**Leave the Public Development URL disabled.** That is the bucket's own name for
the `pub-<id>.r2.dev` hostname. The custom domain in step 2 is the only path a
reader should have — an enabled development URL is a second, uncached,
rate-limited, un-ruled address for the same objects, and every cache rule below
would simply not apply to it. Check it is off whenever you touch bucket
settings, not only once.

### 2. Attach the data custom domain

Under the bucket's **Settings → Custom Domains → Add**, connect
`wrathbench-data.shard.page`. Cloudflare adds the DNS record itself; the status
goes **Initializing → Active** in a few minutes. This is what puts the CDN cache
in front of the bucket — the `r2.dev` URL is uncached by design, which is why
the previous sentence matters more than it looks.

### 3. Apply the CORS policy

```
bunx wrangler r2 bucket cors set wrathbench-public --file infra/cloudflare/r2-cors.json
```

With the **deploy** token (Workers R2 Storage: Edit), not the publisher's S3 key
pair — the two are different credentials and this is the step where that is
easiest to get wrong. Pasting the same JSON into **Settings → CORS Policy** in
the dashboard does the same thing if you would rather not scope a token for it.

The app and the data are different origins now, so without this every fetch the
SPA makes fails in the browser with nothing in the bucket's logs to show for it.

### 4. Add the two cache rules

Zone `shard.page` → **Caching → Cache Rules**, in this order (first match wins).
Cloudflare does **not** cache JSON by default, and the rules also have to carry
the TTLs themselves: Bun's S3 writer cannot send a `Cache-Control` header (the
publisher notes this at the top of `infra/publish-dashboard.ts`), so objects land
without one and "respect origin TTL" would respect nothing.

1. **Mutable** — `Hostname equals wrathbench-data.shard.page` *and* `URI Path is
   in {"/v1/manifest.json", "/v1/live.json"}` → eligible for cache, **Edge TTL
   30s**, **Browser TTL 30s**. Worst-case staleness is the push cadence plus
   this, about 90–120s.
2. **Immutable** — `Hostname equals wrathbench-data.shard.page` → eligible for
   cache, **Edge TTL 1 year**, **Browser TTL 1 year**. Everything the first rule
   did not catch is content-addressed and never rewritten under its own key:
   `/v1/snap/<ver>/*`, `/v1/run/<id>/<ver>/*`, and `/tiles/*`, whose PNGs change
   only when the extraction is re-run and then under new bytes at the same key —
   which is the one case worth knowing about, and why a tile re-upload wants a
   purge of `/tiles/*` rather than a wait.

**A missing cache rule is the only way this shape costs money.** Without it every
public request is a billed class-B read against the bucket — roughly $7/month at
30M requests, versus roughly $0 with the rule. Step 9 checks it, first.

### 5. Point the publisher at the new account

The publisher's environment lives in the `wrathbench-env` secret in the
`wrathbench` namespace on the cluster (`docs/OPERATIONS.md`). Three values
change:

| variable | value |
| --- | --- |
| `S3_ENDPOINT` | `https://<account-id>.r2.cloudflarestorage.com` — the **personal** account's id, from R2 → Overview |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | the publisher token from above |
| `S3_BUCKET` | `wrathbench-public`, unchanged |

The endpoint is the S3 API, not a public hostname, and is not
`wrathbench-data.shard.page`.

**Reset `WRATHBENCH_PUBLISH_STATE`.** It is the memo of what this publisher last
uploaded *to the old bucket*, and against an empty new one every object it names
is a phantom: the first pass would skip almost everything and flip a manifest
pointing at keys that are not there. Delete the file (`data/publish/state.json`
on its volume) before the first pass. It is a cache the operator may throw away,
which is the documented repair for exactly this class of problem — the cost is
one full republish, which is the point.

Then restart it and watch one pass land:

```
kubectl -n wrathbench rollout restart deployment/wrathbench-publisher
kubectl -n wrathbench logs -f deployment/wrathbench-publisher
```

### 6. Upload the tiles

```
bun infra/publish-tiles.ts --dry-run    # counts only, uploads nothing
bun infra/publish-tiles.ts --upload
```

From a checkout with `data/minimap` populated by the extraction in `minimap/`,
with the same `S3_*` credentials as the publisher. The skip-unchanged manifest
(`tiles/manifest.json`) lives in the bucket, so against a fresh bucket this
uploads everything once. Never part of a snapshot pass, and never automatic.

### 7. Deploy the SPA

Set the three public names in `.env` first:

```
WRATHBENCH_SNAPSHOT_BASE=https://wrathbench-data.shard.page
WRATHBENCH_PUBLIC_ORIGIN=https://wrathbench.shard.page
WRATHBENCH_CF_DEPLOY_TOKEN=…
```

Then:

```
bun ship
```

which runs the dashboard tests, renders the social card against
`WRATHBENCH_PUBLIC_ORIGIN` (`infra/render-og.ts`; its content hash stamps the
`og:image` URL, so the card changes URL exactly when the picture does), builds
in snapshot mode against `WRATHBENCH_SNAPSHOT_BASE`, deploys with wrangler, and
rebuilds the private bundle for the viewer. Both names are hard failures if
unset: an empty snapshot base would quietly build the *private* bundle, which on
the public hostname polls `/api` forever and reads as a permanent data outage.

The first deploy is what creates the `wrathbench.shard.page` Custom Domain, from
`dashboard/wrangler.jsonc`.

### 8. Retire the old account's copy

Once step 9 passes: delete the `wrathbench-dashboard` Worker and the
`wrathbench-public` bucket on the old account, and revoke the tokens that
reached them — including the gate's `DASHBOARD_PASSWORD` secret, which dies with
its Worker. Nothing in the repository refers to either any more.

### 9. Verify

**The cache rule, first**, because it is the one misconfiguration that bills:

```
curl -sI https://wrathbench-data.shard.page/v1/manifest.json | grep -i 'cache-control\|cf-cache-status'
curl -sI https://wrathbench-data.shard.page/v1/manifest.json | grep -i 'cf-cache-status'
```

The second (repeat) request must say `cf-cache-status: HIT` and
`cache-control: ...max-age=30`. A `MISS`, `DYNAMIC` or `BYPASS` on the repeat
means rule 1 is not in effect. Repeat against a
`/v1/snap/<ver>/runs.json` key for the year.

**The generation**, read through the public hostname rather than the S3 API:

```
bun infra/publish-accept.ts --base https://wrathbench-data.shard.page
```

This walks the manifest's whole generation over plain `GET` — every aggregate it
names and every per-run key a `runs.json` row points at — re-projects each body
through `runner/viewer/public-projection.ts` and scans it for anything across
the content boundary. It needs no credential, which is the point: it is the
check a stranger could run, and it exercises the custom domain, the cache rules
and the CORS-less `GET` path that a browser will take. Exit 0 and "nothing
missing" is the pass. (The S3-API form, `bun infra/publish-accept.ts` with the
`S3_*` environment, still reads what is *in* the bucket; the two answer different
questions and both are worth one run.)

**That the bucket has no second address:**

```
curl -sI https://pub-<bucket-id>.r2.dev/v1/manifest.json | head -1
```

must not resolve or must fail. If it serves the manifest, the Public Development
URL is enabled — disable it (step 1).

**The browser**, at `https://wrathbench.shard.page`:

- `/` renders, with the staleness banner reading a plausible age (a minute or
  two, never hours and never negative).
- `/runs` lists, and one run detail opens — with its published entries window,
  and with no "load earlier" and no live tail.
- `/ladder` draws.
- `/map?run=<id>` replays, and **draws minimap tiles** rather than only labelled
  grid squares. Tiles are the check most likely to fail here and the one that
  fails most quietly: they come from the data hostname now, so a tile that 404s
  looks exactly like a lab machine that never ran the extraction.
- The console shows no CORS error. One means the app origin in `r2-cors.json`
  does not match the hostname the browser used, scheme included.

**The unfurl:** paste `https://wrathbench.shard.page` into Discord. It should
come back with the title, the sentence and the Pareto card. This is the whole of
FOLLOW-UPS item 111 — the Gated shape's Worker answered the crawler with a 401
form and a disallow-all `robots.txt`, and both are gone: there is no Worker, and
`dashboard/public/robots.txt` is permissive. Slack and Twitter honour robots.txt
and are worth a second check for that reason.

## Deliberately not files

- **The cache rules.** Cache rules have no supported import format, so they are
  six clicks in the zone's Caching → Cache Rules, step 4 above.
- **The two API tokens.** Secrets live in `.env` at the repository root (the
  deploy token) and in the `wrathbench-env` cluster secret (the publisher's).
  Never a file here, never argv.
- **The bucket's Public Development URL**, which must stay **disabled** — see
  step 1. It is not configuration so much as the one setting that would undo
  every rule above.

## Open, and the operator's

- **Tiles lost their `X-Robots-Tag: noindex`.** `docs/PUBLIC-DASHBOARD.md`
  promised tiles `private, max-age=3600` and `noindex`, and in the Gated shape
  the Worker set both on the way out. In the Open shape nothing can: the
  publisher cannot send a header, there is no Worker, and the app's
  `robots.txt` covers the app hostname only. The map needs the tiles public for
  the page to work at all, so the remaining question is indexing, not access.
  Two cheap answers if the operator wants one — a `robots.txt` object at the
  bucket root, which an R2 custom domain will serve, or a zone Transform Rule
  adding the header on `/tiles/*`. Neither is applied; the operator decides
  whether indexing minimap tiles is worth a rule.
