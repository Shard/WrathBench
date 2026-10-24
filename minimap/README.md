# minimap

The tooling that makes the map tiles the dashboard's map draws. The operator
runs it once, on the host, against a local client extraction: `extract` reads
the 3.3.5a minimap textures out of the client's MPQ archives and writes them as
PNG tiles under `data/minimap/`, `bake` builds the zoomed-out levels from those,
`bake-art` paints the zone maps over the same grid, and `transcode` derives the
smaller served tree from all of them. The viewer serves the result under
`/tiles/`, and the public site gets it by a separate upload
(`infra/publish-tiles.ts`). Tooling lives in git, output does not, the same
shape as `wiki/`. The map view this feeds is described in docs/ARCHITECTURE.md
(dashboard section).

Most of this file is the record of how each format and orientation was
verified against the real archives. Read "Usage" to run it and "Output and the
tile convention" to consume it; the rest is for anyone changing the tooling.

Nothing here is Blizzard-derived: the MPQ reader, BLP2 decoder and PNG encoder
are ours, the tests build synthetic archives and textures in code, and every
byte of game data the tool touches stays under the gitignored `data/`.

## Usage

Runs on the host, against the one-time client extraction. It does not talk to
any container and does not need the server running.

```
bun run --cwd minimap extract              # every map in TILED_MAPS (below)
bun minimap/src/extract.ts --map 0,571     # specific maps
bun minimap/src/extract.ts --force         # rewrite existing tiles
bun minimap/src/extract.ts --limit 20      # first N tiles per map (smoke test)
```

Flags: `--map <ids>`, `--force`, `--limit <n>`, `--data <dir>` (default
`data`; the other inputs default under it, which is how a worktree with no
`data/` of its own points at the main checkout's), `--out <dir>` (default
`<data>/minimap`), `--client <dir>` (default `<data>/client-source/Data`).
Map.dbc is read from `<data>/client/dbc`.

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

And the served tree the viewer and the tile publisher read (see "Served
formats" below), which the publisher also runs on its own before every pass:

```
bun run --cwd minimap transcode            # incremental: only what changed
bun minimap/src/transcode.ts --root data/minimap --force
```

Idempotent: a tile that already exists is skipped unless `--force`. A full
extraction of the four continents takes about 17 s and produces 3636 tiles /
~104 MiB; map 369 adds 12 tiles / 214 KiB on top, map 36 36 tiles / 0.4 MiB,
and the other 70 dungeons and raids 1394 tiles / 40 MiB. A fresh extraction
of the whole default set takes about 45 s.

The default set is `TILED_MAPS` in `runner/viewer/worldmap.ts`, the same table
the dashboard names maps from, so a map with tiles is never drawn under a bare
number and a named map is never a blank lattice. The instances are in it
rather than in a list baked on demand: they are small, and a default that is
the whole served set is what lets a fresh `extract` reproduce it (all but the
two tram tiles described under "Maps that are one building", point 4).

Tests: `bun run test minimap/` from the repository root. Typecheck:
`bun run --cwd minimap typecheck`.

## Inputs

- `data/client-source/Data/*.MPQ`, opened in client load
  order — `common`, `common-2`, `expansion`, `lichking`, `patch`, `patch-2`,
  `patch-3` — with later archives winning. `md5translate.trs` resolves to
  `patch-3.MPQ`; the hashed tile BLPs themselves resolve to `common.MPQ`.
- `textures\Minimap\md5translate.trs`, the client's table from readable tile
  names to the hashed files that actually exist in the archives.
- `data/client/dbc/Map.dbc` for the internal directory name → map id mapping
  (`Azeroth` → 0, `Kalimdor` → 1, `DeadminesInstance` → 36, `DeeprunTram` →
  369, `Expansion01` → 530, `Northrend` → 571), and each map's instance type.
- For a map with no terrain, `World\Maps\<Dir>\<Dir>.wdt` and the WMO root it
  names. See "Maps that are one building" below.
- For a dungeon or raid, its ADTs (`World\Maps\<Dir>\<Dir>_<col>_<row>.adt`)
  and the WMO roots they place. See "Instances: rooms over terrain" below.

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
- **Coverage.** Every tile named in the trs for every default map was found
  in the archives — 0 missing, 0 failed.

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
3. **The mirror sign**, against our own trajectories. The two freeplay runs
   that rode the tram (34 state samples between them) sit at world x −45.4
   and 4.5 — symmetric to a quarter yard about the tunnel's centre line under
   `worldX = −x`, and outside the tunnel
   entirely under the other sign. Overlaying all 34 on the finished composite
   puts every one of them on a track or a station platform.
4. **Short images.** Three groups (009, 015, 016: two entrance stubs and a
   small fixture) have images shorter than 256, painted flush against their
   bottom row. Read as 256-row tiles they land 96-112 yards from their own
   boxes; read at their real height they fit them (016 to the pixel on both
   axes). The tooling now reads them that way, so a `--force` re-extraction
   of 369 moves those stubs onto the stations they join and changes two of
   its twelve tiles; the published tiles predate that.

## Instances: rooms over terrain

Map 36, the Deadmines, has both kinds. Its 36 ADTs (rows and columns 30–35)
draw the hills over the mine, the walls of Ironclad Cove and the ship, and the
client's own near-white blanks on the edge columns and rows. The mine itself
is models the ADTs place: `AZ_Deadmines_B.wmo` (the tunnels and rooms) and
`AZ_Deadmines_D.wmo` (by the cove), each with a real position and a yaw. Their
indoor groups carry minimaps of their own, filed under one trs directory
(`WMO\Dungeon\AZ_Deadmines`) with two other models', so a tile is matched to
its model by its name, not its directory. The outdoor groups have none: the
ADT minimap already draws them.

For a dungeon or raid (Map.dbc instance type 1 or 2), the extractor reads
every model the map's ADTs place, once each by `uniqueId`, and lays the
minimap of every one that has one over the terrain tile it lands on, opaque.
A continent does not get this: its thousands of buildings are drawn from
above by the terrain minimap already, roofs and all, which is the right
picture there, and the overlay would change maps that are already published.

`src/wmo.ts` holds the placement and the evidence: the corners of each
model's box land on the world box its `MODF` declares to a tenth of a yard,
for B at −91° and D at −55.5°. Group images are as small as 32px and sit
flush at the group's `max.y` (see point 4 above). Against the server's own
world data, all 213 of map 36's creature spawns fall on painted rooms, the
cove or the ship, and the instance's arrival point (−16.4, −383.1) sits at
the mouth of the entrance tunnel.

Not every passage between rooms is painted, so a character walking one can
show on the hillside between two rooms. The whole mine is about one native
tile across, so the map draws it at the minimap's own 0.48 px to the yard.

### Every dungeon and raid

The default set holds every dungeon and raid in Map.dbc that the client has a
minimap for. The two paths above carry all of them: 30 are one model in their
WDT, like the tram, and 41 are ADTs with placed models, like the Deadmines.
Six are left out. Map.dbc marks 44 and 598 unused, 169 is the Emerald Dream
test map, and 624, 649 and 650 have neither a trs section nor a global model
with a minimap, so they keep their number on the map page.

Together they are 2959 files: 70.6 MB of masters, 25.5 MB served (12.9 MB of
dungeons, 12.6 of raids). The largest are Icecrown Citadel, Ulduar and the
Escape from Durnholde at 1.3–2.0 MB served each; most one-model dungeons are
under 0.1 MB.

What was verified, and how:

- **Placement, against the server's own spawns.** For each map, the share of
  AzerothCore's creature spawns (its base world data, `creature.sql`) that
  land within 2 px (about 4 yards) of a placed model's paint. On the one-model
  maps it is 70–100%: the Botanica 70%, Molten Core 77%, the Underbog 79%,
  every other one 84% or more. A sign or anchor error moves a whole model off
  its spawns, and none shows one. Dire Maul is the only one turned (180°) and
  scores 99%; its exit triggers in AreaTrigger.dbc sit in its wings' doorways.
- **The terrain maps.** A low share on an ADT map is the map being outdoors,
  not a misplacement. Zul'Farrak, the Black Morass, the Ramparts, Durnholde,
  the Oculus, the Pit of Saron, Zul'Gurub, the Ruins of Ahn'Qiraj, Hyjal,
  Zul'Aman, the Sunwell, Ulduar, the Obsidian and Ruby Sanctums and the Eye
  of Eternity are mostly fought in the open, and every spawn on every one of them lands on a terrain
  tile.
- **Determinism.** Re-extracting map 36 alongside the rest reproduces its
  published tiles byte for byte.

What still looks wrong:

- **Floors are averaged.** Where groups at different heights cover the same
  ground, their pixels are averaged into one. Counted by group bounding boxes
  whose heights do not overlap, it is worst in the Sunken Temple (22% of
  painted pixels), the Black Temple and Icecrown Citadel (21%), Azjol-Nerub
  (17%), Blackrock Spire (14%, Lower and Upper stacked), Shadowfang Keep
  (10%), and Scholomance, Karazhan and Blackwing Lair (8%). Tall groups
  overlap in height, so the count misses some: Blackrock Depths measures 1%
  but its core reads as a jumble, and Maraudon and Dire Maul blend in places.
  A fix is a layer per floor, chosen by the character's height, which changes
  every step from the extractor to the map page. It is not attempted.
- **Tilted models are skipped**, so the terrain under them is what shows: a
  cave tunnel used in Stratholme, the Culling, Durnholde and Hyjal, Hyjal's
  buildings, the troll dens in Zul'Gurub and Blackwing Lair, a hive in the
  Ruins of Ahn'Qiraj, a tunnel in Naxxramas, and huts and towers elsewhere.
- **Ahn'kahet** has cave-shell groups with minimaps of their own, which paint
  broad blue sheets around and partly over its rooms.

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
then `publish-tiles --upload` (which transcodes first), then purge `/tiles/`
(`infra/cloudflare/README.md`).

The bake over the six extracted maps takes about 10 s and writes 1505 tiles
(79.9 MiB):

| map | z1 | z2 | z3 | z4 | z5 | z6 | MiB |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | 193 | 55 | 18 | 6 | 4 | 1 | 19.0 |
| 1 | 282 | 78 | 26 | 11 | 4 | 1 | 29.0 |
| 36 | 9 | 4 | 4 | 4 | 4 | 1 | 0.3 |
| 369 | 8 | 6 | 4 | 4 | 4 | 1 | 0.1 |
| 530 | 234 | 69 | 26 | 10 | 4 | 1 | 15.1 |
| 571 | 300 | 88 | 24 | 12 | 4 | 1 | 16.4 |

The other 70 dungeons and raids add 1565 tiles (27.4 MiB) in under a second
each; a bare `bake` walks every map directory, instances included.

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

## Served formats

The PNG tree is the lossless master: the bakes read it, and a lossy copy
re-encoded from a lossy copy would compound. What is served is derived from it
by `src/transcode.ts` into `data/minimap/web/`, the same relative paths with
the extension changed:

```
web/<mapId>/<row>_<col>.webp                native
web/<mapId>/<layer>/<z>/<row>_<col>.webp    the minimap and art pyramids
web/<mapId>/index.json                      which cells exist; where the art hides the minimap; "native": "webp"
web/transcode.json                          the transcode's own cache, never served
```

- **Every tile is WebP at q90.** Lossless WebP is kept wherever it is at
  most twice the lossy size. That covers every solid, near-solid and mostly
  transparent tile, which a lossy codec shifts by whole levels against an
  exact neighbour. Each lossy tile is decoded again, and if its alpha is not
  exact it is served lossless instead.
- **The natives moved from indexed PNG to WebP (operator, 2026-10-24).** They
  were kept as a 256-colour PNG so that no client had to change. The
  operator chose a modern format that the current major browsers all
  support, without going further than that: WebP is in every current
  Chrome, Firefox, Safari and Edge. The natives take the pyramids' rule
  unchanged.
- **The index says which.** A map's `index.json` carries `"native": "webp"`,
  still at version 1, so a deployed build parses it and ignores the field.
  The page asks for `.webp` natives only where the index says so, and
  `.png` wherever it does not: an index written before the field, a stale
  one at the edge, or none at all. Every server still answers `.png`. The
  viewer serves the indexed PNG an older transcode left, or the master
  (`runner/viewer/tiles.ts`), and the bucket keeps the old `.png` objects
  (`infra/cloudflare/README.md`, step 6). So a build and a served tree can
  ship in either order. A transcode removes the indexed PNG natives an
  older one wrote.
- **The encoders are Bun's own** (`Bun.Image`, libwebp and libspng linked into
  the pinned Bun), so there is no new dependency. The cache key is the Bun
  build plus every setting, so a Bun upgrade re-encodes everything. The
  output is byte-deterministic, so the publisher's content hashes upload only
  what changed.

Measured on the full tree (the continents, the tram and every dungeon and
raid):

| layer | files | master | served |
| --- | --- | --- | --- |
| native | 5078 | 151.1 MB | 42.3 MB (80.2 MB as indexed PNG) |
| minimap pyramid | 3070 | 112.5 MB | 17.9 MB |
| art pyramid | 2248 | 185.6 MB | 13.9 MB |
| total | 10396 (+76 indexes) | 449.2 MB | 74.1 MB |

A native is 8.1 KB on average where its indexed PNG was 15.4 KB, so a screen
of them loads in about half the bytes. 2192 of the 5078 are lossless under the
rule above: Northrend's ice and sea, the instances' transparent margins, and
other flat ground.

Why q90, from the tree before the instances joined it (maps 0, 1, 36, 369,
530 and 571):

| quality | art | minimap pyramid | art SSIM, mean / worst 5% | minimap SSIM, mean / worst 5% |
| --- | --- | --- | --- | --- |
| 85 | 10.6 MB | 10.2 MB | 0.981 / 0.963 | 0.991 / 0.976 |
| 90 | 13.9 MB | 13.0 MB | 0.984 / 0.964 | 0.995 / 0.986 |
| 92 | 16.2 MB | 14.5 MB | 0.985 / 0.966 | 0.996 / 0.989 |

At three times magnification the three settings could not be told apart on
art, on snow or on forest. The numbers decided it:

- The minimap pyramid's worst tiles gain most from 85 to 90 and little more
  from 90 to 92.
- At 85, the mean colour along an art tile's edge drifts by up to 3 levels,
  and that is what shows as a seam. At 90 the drift stays near 1.

The natives are seen magnified as well as downscaled (up to `MAX_SCALE`, 8×,
times the screen's pixel ratio), so they were checked closer. Against their
masters, dense city tiles score 32–37 dB as WebP q90 and 35–39 dB as the
indexed PNG: Stormwind 32.0 against 35.8, Silvermoon 33.3 against 36.1,
Dalaran 32.6 against 35.0, Northshire 36.8 against 39.0. Raising the quality
does not close that gap. At q96 the natives are as large as the indexed PNG
(80.4 MB) and Stormwind gains half a decibel, because the error that is left
is WebP's halved colour resolution rather than the quantiser. At four times
magnification, side by side with the master, the WebP softens small saturated
details slightly, where the indexed PNG posterizes water and gradients. The
map draws them smoothed in any case. q90 is kept for the natives too.

### Moving a served tree to the WebP natives

The transcode's encoder id names the settings, so the first pass after this
change re-encodes every tile. The steps, in the order the operator runs them:

1. `bun run --cwd minimap transcode` on the machine with the masters. It
   writes the `.webp` natives and the indexes that name them, and removes
   the indexed PNG natives from `web/`.
2. `bun wb site tiles --dry-run`, then `bun wb site tiles --upload`, or
   `bun wb site ship --tiles` to upload and deploy together. The pass ends
   by naming every map whose `index.json` it changed. Purge each one at the
   edge (`infra/cloudflare/README.md`, step 6), or the edge keeps serving the
   old index, and with it the `.png` natives, for a day.
3. Copy `data/minimap/web` into the viewer's volume (the data claim's
   `minimap` subPath) with modification times kept, from a throwaway pod
   that mounts the claim, as uid 1000:

   ```
   tar -C data/minimap -cf - web | kubectl -n wrathbench exec -i <pod> -- tar -C /data/minimap -xf -
   kubectl -n wrathbench exec <pod> -- find /data/minimap/web -maxdepth 2 -name '*_*.png' -delete
   ```

   The second command removes the indexed PNG natives the copy leaves behind.
   It is optional, because a `.png` request still answers from the master
   either way. The viewer reads the tree on every request, so it needs no
   restart.

The index is a bitmap per layer and level, one hex row per grid row
(`runner/viewer/tileindex.ts`), about 3 KB per continent before compression.

- **`cells`** lets the map page skip absent cells: it asks for none of them,
  so a pan no longer turns into a burst of 404s.
- **`covers`** marks the cells where an art tile is opaque over every pixel
  its minimap tile paints. Wherever the minimap's blend weight is 0, the page
  neither fetches nor draws the minimap there, which roughly halves the
  requests at continent zoom.

On the four continents every minimap cell is covered at every level, because
the art bake is opaque over every native ADT (see "Seams"). Maps without art,
such as the tram and the instances, have no covers, so their minimap is
always drawn.

## Relationship to the viewer

`runner/viewer/worldmap.ts` owns the transform and the served spellings
(`tileName` and `lodTileName` for the masters, `nativeServedName` and
`lodServedName` for the served WebP), and
`runner/viewer/tiles.ts` serves both shapes above under `/tiles/<mapId>/`, from
the served tree while it is current and from the masters otherwise.
Both agree with what this tool writes. The orientation in `worldToPixel` could not be verified until an
extraction rendered a known zone — the Northshire Abbey check above is that
verification, and it confirms the existing code rather than changing it.
