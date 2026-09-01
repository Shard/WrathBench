#!/usr/bin/env bash
# Ship the dashboard to the gated public site.
#
#   bun ship                   tests, snapshot-mode build, wrangler deploy, restore the private build
#   bun ship --publisher     … and restart the snapshot publisher (needed after runner/viewer changes)
#   bun ship --tiles         … and upload changed minimap tiles first
#   bun ship --skip-tests
#
# The private viewer serves dashboard/dist too, so the last step rebuilds it in
# normal mode — and that build names no origin, so it carries no og:image: the
# card's tags belong to the public site only. Bun reads .env for the S3_* keys
# the tile publisher needs and for WRATHBENCH_PUBLIC_ORIGIN.
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
  echo "deploy: tiles"
  bun infra/publish-tiles.ts --upload
fi
# The social card. Rendered before the build because the build stamps its URL
# with the picture's own content hash — a crawler caches a card by URL and has
# no purge, so an unchanged picture must keep its URL and a changed one must
# lose it. No `|| true` anywhere in here: a build whose tags point at an image
# that is not there is worse than no card, so a failed render stops the ship
# (`set -e` covers the assignment below).
echo "deploy: social card"
# `bun -e` rather than the shell, so the origin can live in .env with the rest.
origin=$(bun -e 'process.stdout.write(process.env.WRATHBENCH_PUBLIC_ORIGIN ?? "")')
if [ -z "$origin" ]; then
  echo "deploy: WRATHBENCH_PUBLIC_ORIGIN is unset — set it in .env to the site's own https origin" >&2
  echo "deploy: (the card's og:image must be an absolute URL; see docs/PUBLIC-DASHBOARD.md)" >&2
  exit 1
fi
og_stamp=$(bun infra/render-og.ts)

echo "deploy: snapshot-mode build"
VITE_WRATHBENCH_SNAPSHOT_BASE=/ \
  VITE_WRATHBENCH_PUBLIC_ORIGIN="$origin" \
  VITE_WRATHBENCH_OG_STAMP="$og_stamp" \
  bun run --cwd dashboard build >/dev/null
echo "deploy: wrangler"
bunx wrangler deploy --config dashboard/wrangler.jsonc | grep -E "Success|Deployed|rror" || true
echo "deploy: restore the private build"
bun run --cwd dashboard build >/dev/null
if [ "$publisher" = 1 ]; then
  echo "deploy: restart publisher"
  docker compose -f infra/compose.yml --profile publish restart publisher
fi
echo "deploy: done"
