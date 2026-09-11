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
| `r2-cors.json` | The `wrathbench-public` bucket's CORS policy, in R2's own bucket-CORS format. `GET`/`HEAD` from the app origin plus `http://localhost:5180` (the Vite dev server, so snapshot mode can be developed against the real bucket). Apply with `wrangler r2 bucket cors set wrathbench-public --file infra/cloudflare/r2-cors.json`. |

R2's bucket-CORS format has no prefix selector, so the policy is bucket-wide and
therefore also covers the `tiles/` prefix. That is **only relevant if tiles are
ever published** — they are not, and the public build does not ask for them; see
"Open, and the operator's" at the end. The entry is not a decision about tiles
and does not make one reachable: CORS permits a cross-origin read of an object
that is already served, and nothing is served under that prefix to the public
build today.

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
Cloudflare does **not** cache JSON by default, so without these every public
request is a billed read against the bucket.

1. **Mutable** — `Hostname equals wrathbench-data.shard.page` *and* `URI Path is
   in {"/v1/manifest.json", "/v1/live.json"}` → eligible for cache, **Edge TTL
   30s**, **Browser TTL 30s**. Worst-case staleness is the push cadence plus
   this, about 90–120s.
2. **Immutable** — `Hostname equals wrathbench-data.shard.page` *and* `URI Path
   starts with "/v1/snap/" or "/v1/run/"` → eligible for cache, **Edge TTL 1
   year**, **Browser TTL 1 year**. These are content-addressed and never
   rewritten under their own key, so a long TTL is safe by construction.

Both rules set the TTL **explicitly by path** rather than respecting an origin
header, and that is not a style choice: the 2026-09-11 readback confirmed that
no published object carries a `Cache-Control` at all — Bun's S3 writer cannot
send one, and under the gate the Worker added them on egress. "Respect origin
TTL" would therefore respect nothing. **Both rules already exist on the zone**
(operator, 2026-09-11); step 9 verifies them rather than creating them.

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

### 6. Upload the tiles — **only if the operator decides tiles go public**

**Skip this step.** Minimap tiles are Blizzard textures
(`docs/DATA-AND-LEGAL.md`). Under the gate they were reachable only to a reader
with the password; the Open shape has nothing in the read path able to say no,
so publishing them now makes them world-readable, and whether that happens is
the operator's decision and has not been taken. The public build reflects that:
it names no tile host, requests nothing, and draws its labelled grid — the same
thing `WRATHBENCH_VIEWER_PUBLIC=1` already makes the private viewer do, and the
same thing a machine that never ran the extraction draws. The map page works.

If the decision is ever taken, this is the step, plus
`WRATHBENCH_TILES_BASE=https://wrathbench-data.shard.page` in `.env` and a
redeploy — the flag is separate from the snapshot base precisely so that
publishing the JSON never publishes the textures:

```
bun infra/publish-tiles.ts --dry-run    # counts only, uploads nothing
bun infra/publish-tiles.ts --upload
```

From a checkout with `data/minimap` populated by the extraction in `minimap/`,
with the same `S3_*` credentials as the publisher. The skip-unchanged manifest
(`tiles/manifest.json`) lives in the bucket. Never part of a snapshot pass, and
never automatic. A third cache rule for `/tiles/*` would be wanted then, and a
re-extraction reuses keys, so a re-upload wants a purge of that prefix.

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
- `/map?run=<id>` replays over the labelled grid, and the network tab shows
  **no request to `/tiles/`** at all. A request there would mean a build was
  made with `WRATHBENCH_TILES_BASE` set, which is a decision nobody has taken.
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

- **Do minimap tiles go public at all?** Not decided, and the repository's
  default is no. Under the gate they were served `private, max-age=3600` and
  `X-Robots-Tag: noindex` to an authenticated reader only, which is what
  `docs/PUBLIC-DASHBOARD.md` promised and what made publishing them a small
  question. In the Open shape none of those three things survives: there is no
  authentication, the publisher cannot send a header, and the app's
  `robots.txt` covers the app hostname only — so a published tile is a
  world-readable, cacheable, indexable Blizzard texture. That is a
  `docs/DATA-AND-LEGAL.md` question and therefore the operator's.

  Until it is answered the public build asks for nothing and draws the labelled
  grid, which is a working map and the same thing the private viewer draws in
  public mode. Turning them on is three things together: upload them (step 6),
  set `WRATHBENCH_TILES_BASE` in `.env`, redeploy. If that happens, the same
  three losses want answering with it — a third cache rule for `/tiles/*`, and
  either a `robots.txt` object at the bucket root (an R2 custom domain will
  serve one) or a zone Transform Rule adding `X-Robots-Tag` on the prefix.
