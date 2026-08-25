# infra/cloudflare

The Cloudflare-side configuration for the public dashboard, checked in so the
setup is reviewable and reproducible instead of remembered. Nothing here is
applied by any script: the operator applies each file once, in the order the
"Public dashboard" runbook in `docs/OPERATIONS.md` gives. The design these
shapes come from — push-based publisher, R2 as the data plane, no Worker in the
read path — is `docs/PUBLIC-DASHBOARD.md`.

| file | what it is |
| --- | --- |
| `r2-cors.json` | The `wrathbench-public` bucket's CORS policy, in R2's own bucket-CORS format. `GET`/`HEAD` from the app origin plus `http://localhost:5180` (the Vite dev server, so snapshot mode can be developed against the real bucket). Apply with `wrangler r2 bucket cors set wrathbench-public --file infra/cloudflare/r2-cors.json`, or paste it into the bucket's CORS policy editor. |

`AllowedOrigins` ships with a **placeholder app hostname** — the real one is an
operator decision (`docs/PUBLIC-DASHBOARD.md`, "Operator decisions") — and must
be edited before the file is applied. Origins match as exact strings, scheme
included, so a wrong entry fails closed with a CORS error in the browser rather
than leaking anything. This is the project's first and only CORS policy: the
private viewer is same-origin by construction.

The SPA's own deployment config is `dashboard/wrangler.jsonc`, kept beside the
build it uploads rather than here.

Two parts of the setup are deliberately not files:

- **The cache rule** on the data hostname. Cloudflare does not cache JSON by
  default and cache rules have no supported import format, so it is six clicks
  in the zone's Caching → Cache Rules, described step by step in the runbook.
  It is also the only way this design costs money if it is forgotten — every
  public request becomes a billed read against the bucket.
- **The two API tokens** (R2 Object Read & Write scoped to the one bucket, for
  the publisher; Workers Scripts Edit, for whoever deploys the SPA). Secrets
  live in `.env` at the repository root and are never committed, never argv.
