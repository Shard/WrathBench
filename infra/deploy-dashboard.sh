#!/usr/bin/env bash
# Ship the dashboard to the gated public site.
#
#   bun deploy                 tests, snapshot-mode build, wrangler deploy, restore the private build
#   bun deploy --publisher     … and restart the snapshot publisher (needed after runner/viewer changes)
#   bun deploy --tiles         … and upload changed minimap tiles first
#   bun deploy --skip-tests
#
# The private viewer serves dashboard/dist too, so the last step rebuilds it in
# normal mode. Bun reads .env for the S3_* keys the tile publisher needs.
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
echo "deploy: snapshot-mode build"
VITE_WRATHBENCH_SNAPSHOT_BASE=/ bun run --cwd dashboard build >/dev/null
echo "deploy: wrangler"
bunx wrangler deploy --config dashboard/wrangler.jsonc | grep -E "Success|Deployed|rror" || true
echo "deploy: restore the private build"
bun run --cwd dashboard build >/dev/null
if [ "$publisher" = 1 ]; then
  echo "deploy: restart publisher"
  docker compose -f infra/compose.yml --profile publish restart publisher
fi
echo "deploy: done"
