#!/usr/bin/env bash
# Ship the dashboard to the public site.
#
#   bun ship                   tests, snapshot-mode build, wrangler deploy, restore the private build
#   bun ship --publisher     … and restart the snapshot publisher (needed after runner/viewer changes)
#   bun ship --tiles         … and upload changed minimap tiles first
#   bun ship --skip-tests
#
# Since 2026-09-11 the site is the design doc's **Open** shape: the app is
# `wrathbench.shard.page`, served as static assets with no Worker in the read
# path, and the data is `wrathbench-data.shard.page`, the R2 bucket behind its
# own custom domain. There is no gate and no password step any more; the
# Cloudflare-side setup this deploy assumes is `infra/cloudflare/README.md`.
#
# The private viewer serves dashboard/dist too, so the last step rebuilds it in
# normal mode — and that build names no origin and no snapshot base, so it
# carries no og:image and serves tiles off its own disk: the card's tags and the
# data hostname belong to the public site only. Bun reads .env for the S3_* keys
# the tile publisher needs and for the WRATHBENCH_* names below.
#
# Minimap tiles reach the public site by two separate steps, on purpose. The
# snapshot loop uploads JSON and never a tile; `--tiles` uploads the changed
# ones to the bucket, from a checkout with data/minimap populated. What makes
# the built site *ask* for them is WRATHBENCH_TILES_BASE below — so a deploy
# from a machine that never ran the extraction leaves it unset and ships the
# labelled grid, exactly as WRATHBENCH_VIEWER_PUBLIC=1 already makes the viewer
# do, rather than a site pointing at textures nobody uploaded.
set -euo pipefail
cd "$(dirname "$0")/.."

publisher=0 tiles=0 tests=1
for a in "$@"; do
  case "$a" in
    --publisher) publisher=1 ;;
    --tiles) tiles=1 ;;
    --skip-tests) tests=0 ;;
    *) echo "deploy: unknown flag $a" >&2; exit 2 ;;
  esac
done

if [ "$tests" = 1 ]; then
  echo "deploy: dashboard tests"
  bun test dashboard runner/test/viewer-tools.test.ts runner/test/public-projection.test.ts runner/test/snapshot.test.ts >/dev/null
  bun run --cwd dashboard typecheck >/dev/null
fi
if [ "$tiles" = 1 ]; then
  # Changed tiles only: the skip-unchanged manifest lives in the bucket, so a
  # re-run with nothing re-extracted PUTs nothing. See the header.
  echo "deploy: tiles — uploading changed minimap tiles"
  bun infra/publish-tiles.ts --upload
fi

# The two hostnames, from .env rather than from here, because they are account
# facts and not repository ones. `bun -e` rather than the shell so they can live
# in .env with the rest.
#
# Both are hard failures, and the snapshot base is the less obvious of the two:
# with it empty the build is the PRIVATE bundle — SNAPSHOT_MODE is false, every
# page polls `/api` on the public hostname, and the site renders as a permanent
# data outage rather than as anything recognisably broken.
snapshot_base=$(bun -e 'process.stdout.write(process.env.WRATHBENCH_SNAPSHOT_BASE ?? "")')
if [ -z "$snapshot_base" ]; then
  echo "deploy: WRATHBENCH_SNAPSHOT_BASE is unset — set it in .env to the data hostname" >&2
  echo "deploy: (https://wrathbench-data.shard.page; empty would build the private bundle)" >&2
  exit 1
fi
origin=$(bun -e 'process.stdout.write(process.env.WRATHBENCH_PUBLIC_ORIGIN ?? "")')
if [ -z "$origin" ]; then
  echo "deploy: WRATHBENCH_PUBLIC_ORIGIN is unset — set it in .env to the site's own https origin" >&2
  echo "deploy: (https://wrathbench.shard.page; the card's og:image must be absolute)" >&2
  exit 1
fi

# The social card. Rendered before the build because the build stamps its URL
# with the picture's own content hash — a crawler caches a card by URL and has
# no purge, so an unchanged picture must keep its URL and a changed one must
# lose it. No `|| true` anywhere in here: a build whose tags point at an image
# that is not there is worse than no card, so a failed render stops the ship
# (`set -e` covers the assignment below). The tags are absolute against
# $origin, which is why the card is a public-origin artifact and not a build
# product of the private viewer.
echo "deploy: social card"
og_stamp=$(bun infra/render-og.ts)

# The repository link, and the BibTeX `url` line with it. Empty is the default
# and not an error: the repo is private, and a footer link that 404s is worse
# than no link. On the day it opens, set WRATHBENCH_REPO_URL in .env to the
# repository's URL and redeploy — that is the whole flip.
repo_url=$(bun -e 'process.stdout.write(process.env.WRATHBENCH_REPO_URL ?? "")')
[ -n "$repo_url" ] && echo "deploy: repo link $repo_url" || echo "deploy: no repo link (WRATHBENCH_REPO_URL unset)"

# WRATHBENCH_TILES_BASE: the host holding the `tiles/` prefix, which is the data
# hostname. Unset is not an error — it builds the labelled grid, which is what a
# checkout without the extraction should ship.
tiles_base=$(bun -e 'process.stdout.write(process.env.WRATHBENCH_TILES_BASE ?? "")')
[ -n "$tiles_base" ] && echo "deploy: tiles from $tiles_base" || echo "deploy: no WRATHBENCH_TILES_BASE — grid only"

echo "deploy: snapshot-mode build ($snapshot_base)"
VITE_WRATHBENCH_SNAPSHOT_BASE="$snapshot_base" \
  VITE_WRATHBENCH_TILES_BASE="$tiles_base" \
  VITE_WRATHBENCH_PUBLIC_ORIGIN="$origin" \
  VITE_WRATHBENCH_OG_STAMP="$og_stamp" \
  VITE_WRATHBENCH_REPO_URL="$repo_url" \
  bun run --cwd dashboard build >/dev/null

# The deploy credential. Either of two, and the script says which it used:
#
#   - WRATHBENCH_CF_DEPLOY_TOKEN in .env: a token with Workers Scripts:Edit on
#     the account and Workers Routes:Edit on the zone — enough to upload the
#     assets and to own the Custom Domain in dashboard/wrangler.jsonc, and
#     nothing else. Exported into wrangler's own name for the one command. This
#     is the unattended form.
#   - Unset: wrangler's own login (`bunx wrangler login`, the account the
#     operator picked in the browser). A login on the wrong account deploys
#     somewhere nobody wants, so the script prints who it is first.
#
# Neither is the publisher's R2 key pair: that one writes objects and cannot
# deploy, the deploy credential deploys and cannot read an object.
echo "deploy: wrangler"
deploy_token=$(bun -e 'process.stdout.write(process.env.WRATHBENCH_CF_DEPLOY_TOKEN ?? "")')
if [ -n "$deploy_token" ]; then
  echo "deploy: credential is WRATHBENCH_CF_DEPLOY_TOKEN"
  export CLOUDFLARE_API_TOKEN="$deploy_token"
else
  echo "deploy: no WRATHBENCH_CF_DEPLOY_TOKEN in .env — using wrangler's login:"
  bunx wrangler whoami 2>/dev/null | grep -E "logged in|Account Name|│" | head -4 \
    || { echo "deploy: wrangler is not logged in (bunx wrangler login), and no token is set" >&2; exit 1; }
fi
# No `|| true` and no output filter: a failed upload must stop the ship here,
# before the private build below overwrites dist and "deploy: done" prints.
# Wrangler also caches the account it last used in
# node_modules/.cache/wrangler/wrangler-account.json; after a login on a
# different account that cache still wins and the deploy 10000s, so clear it.
rm -f node_modules/.cache/wrangler/wrangler-account.json
bunx wrangler deploy --config dashboard/wrangler.jsonc

echo "deploy: restore the private build"
bun run --cwd dashboard build >/dev/null
if [ "$publisher" = 1 ]; then
  echo "deploy: restart publisher"
  bun run publisher:restart
fi
echo "deploy: done"
