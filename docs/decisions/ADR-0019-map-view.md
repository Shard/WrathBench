# ADR-0019: Map view — minimap tiles from the client, one renderer for live and replay

Status: Accepted. Date: 2026-08-22.

## Context
Operating a fleet needs a spatial view on the actual world map. Every run
already records `map, x, y, z` (ADR-0018), and the client MPQs sit in `data/`
from the one-time extraction. Replaying historical runs on the same map is
future work, but it shapes the design now.

## Decision
- **Tiles** are the client's own minimap textures, decoded from the MPQs by an
  in-repo Bun tool into `data/minimap/` (gitignored; tests use synthetic
  fixtures). MPQ and BLP decoding are ~600 lines of format code we own; the
  alternative, StormLib in the extraction container, couples a viewer feature to
  the worldserver image build.
- **One module owns the world→tile transform** (`worldmap.ts`), verified
  empirically against positions our own trajectories logged before it was trusted.
- **The renderer consumes a position-feed interface**, not the live-run store:
  live mode polls the latest state row per run; replay later plugs a trajectory
  reader plus a time cursor into the same interface. That seam is the reason
  this record exists.
- Plain canvas, no mapping library: a two-axis affine transform does not need
  one, and the viewer has no dependencies. A missing tile draws as a labelled
  grid square, so the page works before any extraction has run.

## Consequences
- The viewer is the only component serving Blizzard-derived bytes, only from
  `data/`, under the loopback-by-default posture (DATA-AND-LEGAL.md).
- Any change that makes the renderer live-only (reading run liveness in the
  draw path) is a regression against this record.
- Instance maps lack minimap coverage in places; the grid fallback is the
  answer, not special cases.
