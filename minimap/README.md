# minimap

One-time tooling that reads the WoW 3.3.5a minimap textures out of the client
MPQ archives and writes them as PNG tiles under `data/minimap/`. Tooling lives
in git, output does not — same shape as `wiki/`. The map view this feeds is
described in docs/ARCHITECTURE.md (dashboard section).

Nothing here is Blizzard-derived: the MPQ reader, BLP2 decoder and PNG encoder
are ours, the tests build synthetic archives and textures in code, and every
byte of game data the tool touches stays under the gitignored `data/`.

## Usage

Runs on the host, against the one-time client extraction. It does not talk to
any container and does not need the server running.

```
bun run --cwd minimap extract              # maps 0, 1, 369, 530, 571
bun minimap/src/extract.ts --map 0,571     # specific maps
bun minimap/src/extract.ts --force         # rewrite existing tiles
bun minimap/src/extract.ts --limit 20      # first N tiles per map (smoke test)
```

Flags: `--map <ids>`, `--force`, `--limit <n>`, `--out <dir>` (default
`data/minimap`), `--client <dir>` (default
`data/client-source/Data`).

Then bake the zoomed-out levels from what it wrote (see "The LOD pyramid"
below):

```
bun run --cwd minimap bake                 # every map directory under data/minimap
bun minimap/src/bake.ts --map 0 --force    # one map, rewriting existing levels
```

Flags: `--map <ids>`, `--force`, `--out <dir>` (the tile root it reads and
writes, default `data/minimap`).

Idempotent: a tile that already exists is skipped unless `--force`. A full
extraction of the four continents takes about 17 s and produces 3636 tiles /
~104 MiB; map 369 adds 12 tiles / 214 KiB on top.

Tests: `bun test minimap/`. Typecheck: `bun run --cwd minimap typecheck`.

## Inputs

- `data/client-source/Data/*.MPQ`, opened in client load
  order — `common`, `common-2`, `expansion`, `lichking`, `patch`, `patch-2`,
  `patch-3` — with later archives winning. `md5translate.trs` resolves to
  `patch-3.MPQ`; the hashed tile BLPs themselves resolve to `common.MPQ`.
- `textures\Minimap\md5translate.trs`, the client's table from readable tile
  names to the hashed files that actually exist in the archives.
- `data/client/dbc/Map.dbc` for the internal directory name → map id mapping
  (`Azeroth` → 0, `Kalimdor` → 1, `DeeprunTram` → 369, `Expansion01` → 530,
  `Northrend` → 571).
- For a map with no terrain, `World\Maps\<Dir>\<Dir>.wdt` and the WMO root it
  names. See "Maps that are one building" below.

## Output and the tile convention

`data/minimap/<mapId>/<tileRow>_<tileCol>.png`, 256×256 RGBA — one tile per
ADT, the native minimap resolution.

The two naming conventions in play are different from each other, so state both:

- **Input (`md5translate.trs`)**: an entry `map<A>_<B>.blp` has **A = tile
  column, B = tile row** — the same order ADT filenames use.
- **Output (this tool)**: `<tileRow>_<tileCol>.png` — **row first**, matching
  `runner/viewer/worldmap.ts`. So the trs entry
  `Azeroth\map31_43.blp` becomes `data/minimap/0/43_31.png`.

The transform the viewer must use:

```
tileRow = 32 - worldX / 533.33325     // world X is north; row grows southward
tileCol = 32 - worldY / 533.33325     // world Y is west;  col grows eastward
pixelX  = frac(tileCol) * 256         // within a tile, left→right is east
pixelY  = frac(tileRow) * 256         // within a tile, top→bottom is south
```

North is up and east is right, both across the tile grid and inside each tile
(BLP row 0 is the northern edge). Tiles stitch seamlessly with no flip or
transpose.

### What was verified, and how

The column/row order was **not** settled by presence alone — both `map43_31`
and `map31_43` exist in the Azeroth section, so that test does not
discriminate. Three independent checks were run instead:

1. **Grid extent.** The Azeroth section spans A ∈ [24, 44] and B ∈ [20, 61].
   Eastern Kingdoms is far taller (north–south) than it is wide, so the
   wider-ranging index B must be the row.
2. **Asymmetric absences.** `map31_44`, `map31_48` and `map32_48` are present
   while `map44_31`, `map48_31` and `map48_32` are all absent. Dun Morogh
   (row ≈ 43–44) and Elwynn/Stormwind (row ≈ 48) certainly have minimap
   coverage, so the present spellings — column first — are the real ones.
3. **Pixels, against positions from our own trajectories.** Two map-0 landmarks
   were rendered and inspected:

   | source | world (x, y) | row, col | tile | what the pixels show |
   | --- | --- | --- | --- | --- |
   | dwarf start | −6240, 331 | 43.70, 31.38 | `43_31` | Dun Morogh snow; marker on a small dwarven settlement, consistent with Coldridge Valley |
   | human start | −8870, −115 | 48.63, 32.22 | `48_32` | Elwynn green; the marker lands exactly on Northshire Abbey's red roof |

   The Northshire Abbey hit is pixel-accurate and is the strongest evidence:
   it fixes the row/column order, the sign of both axes, and the within-tile
   pixel orientation at once. A 3×3 mosaic around each landmark also stitches
   continuously (roads and coastlines cross tile seams), confirming no flip.

The transposed reading fails all three checks.

## Format notes from the real extraction

- **Compression.** Every one of the ~33 000 sectors read across the four
  default maps is zlib (method `0x02`). PKWARE implode (`0x08`) and bzip2
  (`0x10`) never appear, so `src/explode.ts` is deliberately a stub that
  reports the method rather than ~150 lines of untested format code; the
  reader skips such a file and falls back to an earlier archive. The extractor
  prints the sector-method tally on every run, so a future archive that does
  use implode will announce itself.
- **BLP variants.** All 3636 minimap tiles are DXT1 (`colorEncoding=2`,
  `alphaSize=0`, `alphaEncoding=0`) at exactly 256×256. The decoder also
  handles palettised (1/4/8-bit alpha), DXT3, DXT5 and raw BGRA, all covered
  by synthetic-fixture tests, because nothing guarantees a custom patch stays
  DXT1.
- **Archives.** All seven are MPQ v1. Encrypted, FIX_KEY and single-unit
  files are implemented and covered by synthetic-fixture tests; the minimap
  path was not instrumented to say whether it hits any. The bzip2 path shells
  out to `bunzip2` and is likewise untested against real data — it has never
  been reached.
- **Coverage.** Every tile named in the trs for maps 0, 1, 530 and 571 was
  found in the archives — 0 missing, 0 failed.

## Maps that are one building

Map 369, the Deeprun Tram, has no ADTs and no `deepruntram` section in the trs.
It is a single WMO — `World\wmo\Dungeon\AZ_Subway\Subway.wmo`, placed at the
origin unrotated by the one `MODF` in its WDT — and its minimap lives under the
*model's* directory as `Subway_<group>_<a>_<b>.blp`: a group index and a grid
local to that group, with no world coordinate in the name. The extractor falls
through to this path whenever a map has no ADT tiles, so it is not a special
case for 369; it is what a terrain-less map does.

`src/wmo.ts` carries the placement rule and, more usefully, the evidence for
each part of it — nothing there came from a spec, all of it was read off the
archive. The short version: 2 pixels to the yard (128 yards a tile, four times
the ADT density), tile `a` counting up from the group's `min.x` and tile `b`
counting *down* from its `max.y`, and world = the model turned 180° about the
vertical. The extractor then resamples 4:1 into the ordinary
`<row>_<col>.png` grid, so the viewer, the dashboard and the tile publisher
cannot tell this path from the other one.

What was verified, and how — the same standard the ADT orientation was held to:

1. **The scale and the x anchor**, from the art alone. All 20 groups paint from
   image x = 0 to exactly `(max.x − min.x) × 2` with a transparent remainder.
2. **The `b` direction**, from where the remainder goes. It sits at the low rows
   of the *highest*-numbered tile, not at the start of the strip — g000 paints
   all of `b0` and only rows 201-255 of `b1`, and 256 − 201 is its 55px
   remainder exactly. Number the strip the other way and the paint comes apart
   at a seam. Composited correctly, the tunnel has no coverage hole anywhere
   between its two stations, and every group's painted span matches its own
   bounding box to within half a yard.
3. **The mirror sign**, against our own trajectories. The two Fable freeplay
   runs that rode the tram (34 state samples between them) sit at world x −45.4
   and 4.5 — symmetric to a quarter yard about the tunnel's centre line under
   `worldX = −x`, and outside the tunnel
   entirely under the other sign. Overlaying all 34 on the finished composite
   puts every one of them on a track or a station platform.

## The LOD pyramid

The map page draws a native tile only while it is at least 96px on screen.
Below that a continent is more tiles than the page's cache holds, so a
zoomed-out map used to be a lattice of empty boxes. `src/bake.ts` gives every
zoom something real to draw: levels z = 1..6, each tile still 256×256 but
covering 2^z × 2^z ADTs, so z = 6 is the whole 64×64 world in one tile. The
page picks the level whose cells stay near tile size on screen.

```
data/minimap/<mapId>/<row>_<col>.png                 native, the pyramid's level 0
data/minimap/<mapId>/minimap/<z>/<row>_<col>.png     z = 1..6, row/col < 64 >> z
```

The native path does not move: the public bucket and every deployed build
already address it. The levels sit under a layer directory inside the map's
own, which keeps the tile root a list of map ids (the publisher walks it as
one) and leaves room for a second layer of art at the same levels. The
spelling is `lodTileName` in `runner/viewer/worldmap.ts`, which the bake,
the viewer, the publisher and the dashboard all call; it refuses level 0, so
nothing built on it can write over a native tile.

Each level is a 2×2 box filter of the one below. Colour is weighted by alpha
and alpha is averaged. The ADT tiles are opaque, so this changes nothing for
them, but the Deeprun Tram's composite has transparent corners, and an
unweighted mean would darken its outline one level up. A missing child is a
transparent quadrant, and a tile with nothing opaque in it is not written, so
a level holds exactly the tiles that cover terrain.

Every level is computed from the one below in memory on every run, and
`--force` decides only whether existing files are rewritten. Building level
z + 1 from a skipped file instead would build it on bytes the current natives
may no longer agree with. The output is byte-deterministic, so a re-bake that
changed nothing uploads nothing. After a re-extraction, run `bake --force`,
then `publish-tiles --upload`, then purge `/tiles/`
(`infra/cloudflare/README.md`).

The bake over the five extracted maps takes about 10 s and writes 1479 tiles
(79.6 MiB):

| map | z1 | z2 | z3 | z4 | z5 | z6 | MiB |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | 193 | 55 | 18 | 6 | 4 | 1 | 19.0 |
| 1 | 282 | 78 | 26 | 11 | 4 | 1 | 29.0 |
| 369 | 8 | 6 | 4 | 4 | 4 | 1 | 0.1 |
| 530 | 234 | 69 | 26 | 10 | 4 | 1 | 15.1 |
| 571 | 300 | 88 | 24 | 12 | 4 | 1 | 16.4 |

The tram's 12 tiles sit on rows 31–32, either side of the grid's centre line,
so every level up to z5 keeps two rows of them and z3–z5 hold four tiles each.

How it was verified: z4 mosaics of maps 0 and 1 (16 tiles each) came out north
up, with coastlines continuous across every tile edge. A z3 tile over Dun
Morogh matches its four z2 children, and a z1 tile matches its four natives,
compared side by side. Synthetic tests pin the quadrant order, the alpha
weighting, the whole-world tile's placement of each native, and idempotence.

## Relationship to the viewer

`runner/viewer/worldmap.ts` owns the transform and the pyramid's spelling, and
`runner/viewer/tiles.ts` serves both shapes above under `/tiles/<mapId>/`.
Both agree with what this tool writes. The orientation in `worldToPixel` could not be verified until an
extraction rendered a known zone — the Northshire Abbey check above is that
verification, and it confirms the existing code rather than changing it.
