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

And the painted map over the same levels (see "The painted map" below):

```
bun run --cwd minimap bake-art             # maps 0, 1, 530, 571
bun minimap/src/artbake.ts --map 0 --force --data <data dir> --client <client Data dir>
```

Flags: `--map <ids>`, `--force`, `--data <dir>` (default `data`; the other
inputs default under it), `--client <dir>` (default `<data>/client-source/Data`),
`--locale <code>` (default `enUS`), `--out <dir>` (the tile root, default
`<data>/minimap`, which must already hold the native tiles), `--gap paper|minimap`
and `--cities` (both below).

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

The art bake reads more:

- The same archives plus the locale ones, in client order: the base four, then
  `<locale>/locale-<locale>`, `expansion-locale-<locale>`, `lichking-locale-<locale>`,
  then the three patches, then `<locale>/patch-<locale>`, `-2`, `-3`. Every
  zone's world-map art is in `locale-<locale>.MPQ` — Outland's and Northrend's
  included; the expansion and lichking locale archives hold none (their
  listfiles and a direct lookup agree) — and `patch-<locale>.MPQ` re-serves the
  zones redrawn in 3.x, which is why the locale patches must sit above it.
- `data/client/dbc/WorldMapArea.dbc`, `WorldMapOverlay.dbc` and `AreaTable.dbc`.
- `data/client/maps/*.map`, the server's per-ADT area and liquid grid
  (AzerothCore's map extractor output).
- The native minimap tiles: which ADTs have one (the art covers every one of
  them, see "Seams"), and their pixels for `--gap minimap`.

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
data/minimap/<mapId>/art/<z>/<row>_<col>.png         the painted map, z = 1..6 (no level 0)
```

The native path does not move: the public bucket and every deployed build
already address it. The levels sit under a layer directory inside the map's
own, which keeps the tile root a list of map ids (the publisher walks it as
one), and the painted art layer sits beside them at the same levels and on the
same grid; transparent where nothing is painted, its finest level is z1, 128
px per ADT. The map page lays it over the minimap and crossfades the two by
zoom (`ART_FADE_START_PX` / `ART_FADE_END_PX` in
`dashboard/src/lib/mapview.ts`). Because the art is re-baked in place while its
look is tuned, the viewer revalidates it instead of caching it for a year.
The tile publisher uploads the art with the rest of the tiles
(`infra/cloudflare/README.md`, step 6). The
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

## The painted map

`src/artbake.ts` stitches every zone's world-map art into one picture on the
minimap's grid: `<map>/art/<z>/<row>_<col>.png`, z = 1..6, spelled by
`lodTileName(ART_LAYER, …)`. z1 is 128 px per ADT, about the density the zone
maps are painted at; higher levels are the same alpha-weighted 2×2 filter as
the minimap's. Tiles are transparent where nothing is painted and only tiles
with content are written. The output is byte-deterministic, an existing tile
is skipped without `--force`, and `--force` also removes tiles a re-bake no
longer has content for. The map page draws it over the minimap and fades it
out as you zoom in.

### Placement

A zone's map is 4×3 BLP tiles of 256 (`Interface\WorldMap\<name>\<name>1..12.blp`)
plus its WorldMapOverlay pieces. The picture is the top-left 1002×668 of that
1024×768; the rest is padding. Its WorldMapArea row gives the world rect, and
the art maps onto it linearly:

```
u = (left − Y) / (left − right) × 1002      world Y (west)  → art x
v = (top  − X) / (top  − bottom) × 668      world X (north) → art y
```

Zones are placed on the map they physically sit on (`WorldMapArea.mapId`), not
the one they are displayed under. Eversong, Ghostlands and Quel'Danas, and the
Azuremyst isles, are on 530 beside Outland.

What was verified, and how:

1. **The crop.** For every rect checked, `(left − right) / 1002` and
   `(top − bottom) / 668` (yards per pixel across and down) agree within 0.1%,
   so the pixels are square only under the 1002×668 crop.
2. **Landmarks, against our own trajectories.** The dwarf start lands in
   Coldridge Valley, just above its label, beside the Anvilmar icon. The human
   start lands beside Northshire Abbey's icon.
3. **Against the minimap.** A z1 art tile at 50% over its four native tiles
   lines up: Coldridge's roads and lakes in Dun Morogh, and Northshire and the
   Goldshire road in Elwynn. Stitched regions line up too: Dun Morogh's lakes,
   The Loch, the Wetlands delta and Westfall's coast.

### The server's area grid (`src/mapfile.ts`)

Each `data/client/maps/<map:3><row:2><col:2>.map` covers one ADT. The layout
below was read off the bytes; it is version 9 of the extractor format.

- **Header:** 11 u32: `MAPS`, the version, the build, then an offset and size
  for each of the area, height, liquid and holes sections.
- **`AREA`:** a u16 of flags (1 means the whole tile is one area) and a u16
  area id, then, unless the flag is set, u16[16][16] AreaTable ids.
- **`MLIQ`:** a u8 of flags (1 means no per-cell type), the tile's u8 liquid
  flags, a u16 type, the liquid's vertex rectangle and a level. Unless flag 1
  is set, u16[16][16] entries and u8[16][16] per-cell flags follow: 0x01 water,
  0x02 ocean.

Every real tile seen with one liquid type for the whole tile spans the full
vertex grid, so the axis order of that rectangle is untested.

What was verified, and how:

1. **File order.** The first two-digit field spans the same range as the
   minimap's rows on map 0, and the second the columns. That is the
   extent-against-extent argument the native tiles were held to.
2. **In-tile order.** Under the dwarf start the row-major reading gives
   Coldridge Valley. The transposed reading gives Coldridge Pass, the
   neighbouring subzone.
3. **Pixels.** Subzone boundaries drawn from the grid over the minimap follow
   the terrain. Iceflow Lake, Coldridge Valley and The Loch trace their water.
   The zone borders follow the snow, grass and red rock between Dun Morogh,
   Loch Modan and the Badlands, and the grass and wheat between Elwynn and
   Westfall.

A cell's zone is its AreaTable id walked up the parent chain to the root,
which is the id WorldMapArea.areaId uses.

Three gotchas:

- Sea areas have zone parents (the Forbidding Sea sits under the Wetlands), so
  open sea is taken from the ocean liquid flag, not the area.
- Area 0 marks unused terrain.
- Ironforge and Undercity have no terrain cells at all: they are interiors.

### Seams

What makes clean seams possible is a mask of each zone's own painted interior,
not the raster alone. The raster is necessary but not enough. Dun Morogh's map
bakes the label WETLANDS onto a ridge the server's grid puts inside Dun Morogh,
so a mask from territory alone shows "WETL…".

The base tiles of a zone map leave its interior blank parchment, and the
overlay pieces paint it in. So **own** is where an overlay is opaque and
actually changed the base. The Burning Crusade overlays are large blocks that
repaint margins and labels unchanged, which is why "changed" is part of the
test. Labels, compass roses and the painted frame sit on blank parchment away
from it.

Per output pixel:

- **Validity.** A zone's art counts inside its frame and near its own mask.
  - The frame is a rounded inset rect: 10 px on three sides, 26 at the bottom,
    corners of radius 80. The fade is 56 px, pulled inward by noise so a cut is
    not a ruler line.
  - On land, the art counts out to 110 px from the own mask, which keeps the
    painted border mountains. At sea it counts to 35 px, enough for the coastal
    hatching but not a baked sea name.
  - Both are smooth functions of the art position, evaluated per pixel.
- **Territory.**
  - Land cells belong to the raster's zone.
  - Sea cells, and area-0 ground, belong to the nearest land's zone within
    450 yards.
  - Each zone's territory is blurred at cell scale and then sharpened against
    the others (shares raised to the third power and renormalised). A boundary
    comes out as a smooth curve rather than the grid's 33-yard staircase.
- **Weights.** A zone paints its territory share times its validity. Land its
  own zone cannot paint goes to the zones whose art can, in proportion to
  validity to the fourth power, so the hand-over has no hard switch.
- **The backdrop** takes what is left.
  - **Sea** is where the server says ocean (and the terrain-less cells near
    it). It is coloured with the zone maps' own water: the median of cool
    pixels (blue at least 0.8 of red) over sea and lake cells, measured at bake
    time. It is full out to 3 ADTs from the coast, a shade deeper offshore.
  - **Unpainted land** is parchment: the mean colour of the zones' painted
    rings, measured at bake time. It fills out to 450 yards from land some art
    can paint and fades over 450 more.
  - **The minimap's coverage.** The map page draws the minimap at full
    strength wherever the art is clear. So the backdrop is also opaque over
    every ADT that has a native minimap tile, read from the tile root at bake
    time. There, unused ground is parchment (the Outland maps paint their void
    that way too) and anything else is sea.
  - **The opaque extent** is therefore the union of 3 ADTs past the coast and
    every ADT with a minimap tile. It fades to clear over the 2 ADTs beyond
    that. Coverage is held at 1 for one cell past the last covered one, so
    bilinear sampling cannot dip below opaque at a covered tile's corner.
    Where no minimap tile and no coast is near, the art is clear.

`--gap minimap` shades the parchment with the minimap's ground instead. It is
not the default because unpainted land is exactly where the minimap is
unfinished: flat placeholder fills with chunk-staircase edges, and the grading
carries those edges over.

Capitals (AreaTable flag 0x100) are off by default, and the surrounding zone's
map paints them. `--cities` draws a capital's own map over its terrain cells.
On map 0 that was tried and left off, for three reasons:
- Stormwind's plan cuts through Elwynn's STORMWIND banner.
- The plan's blank margin shows around it.
- The plan is a jump in scale against the walled-city icon Elwynn's map
  already paints there.

Ironforge and Undercity have no cells to draw on.

What was verified, and how:

- **Labels.** Fourteen baked labels across seven zone maps were each cropped
  beside the same world rect of the bake's output: neighbour names, sea names
  and a compass rose, in Dun Morogh, Elwynn, Westfall, the Wetlands, Redridge,
  Eversong and the Ghostlands. Twelve are gone. The two that are not are listed
  below.
- **Alignment.** A z1 tile laid over its natives lines up (see "Placement").
- **Synthetic tests** pin the rest:
  - A label baked on a zone's territory but away from its overlay never
    reaches the output, and no frame pixel does.
  - The sea takes the art's water colour.
  - Every z1 pixel of an ADT with a minimap tile is opaque, even far from
    any coast. Past the coverage the art fades to clear over the fade width,
    and the gap between coverage and coast stays clear.
  - The bake is deterministic.
- **On the real bake**, every z1 pixel over all 3636 native minimap ADTs is
  opaque. Composited over the minimap pyramid at z3 and z4 (what the map page
  draws at continent zoom), no minimap pixel shows through on any of the four
  maps.

What still looks wrong:

- **Straight seams.** Where a territory runs past its own map's frame (Badlands
  west, Elwynn north, the Eastern Plaguelands, Desolace, Silithus) the cut is
  feathered and wavy but still follows the frame. Where two frames face each
  other across a border (Desolace's bottom, Feralas's top), both fades leave a
  strip of parchment between them. The feather is in art pixels, so it is
  narrower in yards for a zone drawn at a large scale.
- **Faint label leaks** where a zone's own overlays paint a neighbour's label on
  cells the grid gives that zone: BURNING STEPPES along Redridge's north edge,
  and EASTERN PLAGUELANDS along Ghostlands' south edge.
- **The parchment fill** is flat beside the painted rings.
- **The outline at continent zoom** is the minimap's coverage wherever that
  reaches past the coast. It is softened by the fade, but it is the ADT grid:
  Northrend's coverage is one rectangle of sea, Outland's a stepped block of
  parchment, and Kalimdor has a small square of sea far to the north-west
  (the minimap tiles around GM Island).
- **A strip of ocean** on 530, between Outland and Quel'Thalas, draws a small
  sea of its own.

The bake over maps 0, 1, 530 and 571 takes about 140 s and writes 2248 tiles
(177 MiB):

| map | z1 | z2 | z3 | z4 | z5 | z6 | MiB |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | 305 | 87 | 27 | 8 | 4 | 1 | 38.0 |
| 1 | 439 | 119 | 36 | 12 | 4 | 1 | 52.0 |
| 530 | 446 | 124 | 34 | 11 | 4 | 1 | 48.2 |
| 571 | 413 | 119 | 36 | 12 | 4 | 1 | 38.8 |

## Relationship to the viewer

`runner/viewer/worldmap.ts` owns the transform and the pyramid's spelling, and
`runner/viewer/tiles.ts` serves both shapes above under `/tiles/<mapId>/`.
Both agree with what this tool writes. The orientation in `worldToPixel` could not be verified until an
extraction rendered a known zone — the Northshire Abbey check above is that
verification, and it confirms the existing code rather than changing it.
