#!/usr/bin/env bash
# Ship the dashboard to the public site.
#
#   bun ship                   tests, snapshot-mode build, wrangler deploy, restore the private build
#   bun ship --publisher     … and restart the snapshot publisher (needed after runner/viewer changes)
#   bun ship --tiles         … and upload changed minimap tiles first (only if
#                              the operator has decided tiles go public)
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
# Minimap tiles are NOT part of the public build. They are Blizzard textures,
# the Open shape has nothing in the read path able to keep a reader out, and
# whether they go public is the operator's decision (docs/DATA-AND-LEGAL.md) and
# has not been taken — so no VITE_WRATHBENCH_TILES_BASE is passed below and the
# public map draws its labelled grid, exactly as WRATHBENCH_VIEWER_PUBLIC=1
# already makes the viewer do. `--tiles` uploads them to the bucket and is a
# separate act with the same decision in front of it; it is not what makes the
# site ask for them.
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
  # Live, and deliberately not removed — but say out loud what it does, because
  # the bucket is public now and these are Blizzard textures. See the header.
  echo "deploy: tiles — uploading to a PUBLIC bucket; whether tiles go public is"
  echo "deploy:         an open operator decision (infra/cloudflare/README.md)."
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

# WRATHBENCH_TILES_BASE, if the operator ever decides tiles are public: the host
# holding the `tiles/` prefix. Unset is the default and means the grid.
tiles_base=$(bun -e 'process.stdout.write(process.env.WRATHBENCH_TILES_BASE ?? "")')
[ -n "$tiles_base" ] && echo "deploy: tiles from $tiles_base" || echo "deploy: no tiles in the public build (grid only)"

echo "deploy: snapshot-mode build ($snapshot_base)"
VITE_WRATHBENCH_SNAPSHOT_BASE="$snapshot_base" \
  VITE_WRATHBENCH_TILES_BASE="$tiles_base" \
  VITE_WRATHBENCH_PUBLIC_ORIGIN="$origin" \
  VITE_WRATHBENCH_OG_STAMP="$og_stamp" \
  VITE_WRATHBENCH_REPO_URL="$repo_url" \
  bun run --cwd dashboard build >/dev/null

# The deploy credential, and the only one this script uses. A token with Workers
# Scripts:Edit on the account and Workers Routes:Edit on the zone — enough to
# upload the assets and to own the Custom Domain in dashboard/wrangler.jsonc,
# and nothing else. It is deliberately NOT the publisher's R2 key pair: that one
# writes objects and cannot deploy, this one deploys and cannot read an object.
# Named WRATHBENCH_CF_DEPLOY_TOKEN in .env so it sits with the rest of the
# project's secrets, and exported into wrangler's own name for the one command.
echo "deploy: wrangler"
deploy_token=$(bun -e 'process.stdout.write(process.env.WRATHBENCH_CF_DEPLOY_TOKEN ?? "")')
if [ -z "$deploy_token" ]; then
  echo "deploy: WRATHBENCH_CF_DEPLOY_TOKEN is unset — set it in .env" >&2
  echo "deploy: (Workers Scripts:Edit + Workers Routes:Edit; infra/cloudflare/README.md)" >&2
  exit 1
fi
CLOUDFLARE_API_TOKEN="$deploy_token" \
  bunx wrangler deploy --config dashboard/wrangler.jsonc | grep -E "Success|Deployed|rror" || true

echo "deploy: restore the private build"
bun run --cwd dashboard build >/dev/null
if [ "$publisher" = 1 ]; then
  echo "deploy: restart publisher"
  bun run publisher:restart
fi
echo "deploy: done"
