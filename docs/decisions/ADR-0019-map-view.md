# ADR-0019: Map view — minimap tiles from the client, one renderer for live and replay

Date: 2026-08-22. Status: accepted.

## Context

Operating a fleet of concurrent agents needs a spatial view: where is everyone,
right now, on the actual world map. Every run already records `map, x, y, z`
in its `state` table (ADR-0018 signal vector), and the full client MPQs sit in
`data/client-source/` from the one-time extraction. We also know we will want
to replay historical runs on the same map later (route visualisation, death
sites, zone coverage) — that is future work, but it shapes the design now.

## Decision

**Tiles.** A one-time tool (`wiki/`-style: tooling in git, output in `data/`)
reads the minimap textures out of the MPQs — `textures/Minimap/md5translate.trs`
maps `<MapDir>\mapX_Y.blp` names to hashed BLP files — decodes BLP2 to PNG and
writes `data/minimap/<mapId>/<tileRow>_<tileCol>.png` (256×256, the native
minimap resolution; one tile per ADT). MPQ reading and BLP decoding are
implemented in Bun/TypeScript in-repo: the formats are stable and documented,
and it keeps the pipeline dependency-free and containerisable. Nothing
Blizzard-derived enters git — tiles live under `data/` (gitignored), and the
pipeline's tests use synthetic fixtures built in the test itself.

**Coordinates.** One module owns the transform (`runner/viewer/worldmap.ts`):
WoW world yards → ADT tile grid, `tile = 32 − coord/533.33325`, world X
(north) mapping to rows and world Y (west) to columns. The extraction tool
must verify orientation empirically before the contract is trusted: render the
Coldridge Valley / Dun Morogh tiles and check them against positions our own
trajectories already logged (e.g. Anvilmar at map 0, x≈-6240, y≈380).

**Renderer.** A `/map` page on the existing viewer: plain canvas pan/zoom over
the tile pyramid (no mapping library — the viewer has no dependencies and a
two-axis affine transform does not need one), pips per character, click →
state sidebar (level, xp, money, quests, model, freshness) with a link to the
run's detail page. Tiles are served by the viewer from `data/minimap/` with a
flat-grid fallback when a tile (or the whole extract) is missing, so the page
works before the extraction has ever run.

**Source-agnostic positions.** The renderer consumes a *position feed*
interface — `{ runId, character, map, x, y, ts, ...preview }[]` — not the
live-run store directly. Live mode polls `/api/positions` (latest state row of
each unterminated run). Replay mode later plugs a trajectory reader into the
same interface plus a time cursor; the renderer does not know the difference.
That interface is the reuse seam and the reason this ADR exists.

## Consequences

- The viewer stays the only component that serves Blizzard-derived bytes, and
  only from `data/`, under the existing LAN posture (loopback by default,
  `WRATHBENCH_VIEWER_LAN=1` opt-in, never public).
- BLP/MPQ decoding is ~600 lines of format code we own. Accepted: the
  alternative (StormLib in the extraction container) couples a viewer feature
  to the worldserver image build.
- Replay is explicitly out of scope now (FOLLOW-UPS), but any change that
  would make the renderer live-only (e.g. reading run liveness inside the
  draw path) is a regression against this ADR.
- Instance/dungeon maps have no minimap coverage in places; the grid fallback
  is the answer, not special cases.
