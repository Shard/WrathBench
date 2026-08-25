# infra/cloudflare

The Cloudflare-side configuration for the public dashboard, checked in so the
setup is reviewable and reproducible instead of remembered. Nothing here is
applied by any script: the operator applies each file once, in the order the
"Public dashboard" runbook in `docs/OPERATIONS.md` gives. The design these
shapes come from — push-based publisher, R2 as the data plane, no Worker in the
read path — is `docs/PUBLIC-DASHBOARD.md`.

That design assumes a **domain on the account**, and the runbook calls it the
**Open** shape. Until there is one, the deploy runs in the **Gated** shape
instead: one Worker serving both the SPA and `/v1/*` out of a private bucket
binding, with a shared password in front. The reason is not preference. On
Cloudflare, access control, WAF, and cache are custom-domain features; the
managed `r2.dev` development URL has none of them and is world-readable to
whoever learns the hostname. A preview that must not be world-readable therefore
needs something in the read path to say no, and on a zoneless account only a
Worker can.

| file | what it is | shape |
| --- | --- | --- |
| `r2-cors.json` | The `wrathbench-public` bucket's CORS policy, in R2's own bucket-CORS format. `GET`/`HEAD` from the app origin plus `http://localhost:5180` (the Vite dev server, so snapshot mode can be developed against the real bucket). Apply with `wrangler r2 bucket cors set wrathbench-public --file infra/cloudflare/r2-cors.json`. | **Open only** |

`AllowedOrigins` ships with a **placeholder app hostname** — the real one is an
operator decision (`docs/PUBLIC-DASHBOARD.md`, "Operator decisions") — and must
be edited before the file is applied. Origins match as exact strings, scheme
included, so a wrong entry fails closed with a CORS error in the browser rather
than leaking anything.

In the Gated shape the app and its data share one origin, so there is no
cross-origin request to permit and this file is not applied at all. It is kept,
unapplied, because it is the Open shape's policy and the Open shape is still
where this is going.

The SPA's own deployment config is `dashboard/wrangler.jsonc`, kept beside the
build it uploads rather than here; the gate it now declares a `main` for is
`dashboard/worker/index.ts`.

Parts of the setup that are deliberately not files:

- **The cache rules** on the data hostname (Open shape). Cloudflare does not
  cache JSON by default and cache rules have no supported import format, so it
  is six clicks in the zone's Caching → Cache Rules, described step by step in
  the runbook. It is also the only way the Open shape costs money if it is
  forgotten — every public request becomes a billed read against the bucket.
  The Gated shape has no zone and sets the same TTLs from the Worker instead.
- **The gate's password** (Gated shape), which is a Worker secret:
  `wrangler secret put DASHBOARD_PASSWORD`. Never a file, never argv.
- **The two API tokens** (R2 Object Read & Write scoped to the one bucket, for
  the publisher; Workers Scripts Edit — plus Workers R2 Storage Read in the
  Gated shape, to bind the bucket — for whoever deploys the SPA). Secrets live
  in `.env` at the repository root and are never committed, never argv.
- **The bucket's Public Development URL**, which must stay **disabled**. It is
  not configuration so much as the one setting that would undo the gate: with
  it on, every published object is readable at `pub-<id>.r2.dev` regardless of
  what fronts it.
