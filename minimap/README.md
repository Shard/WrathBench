# minimap

One-time tooling that reads the WoW 3.3.5a minimap textures out of the client
MPQ archives and writes them as PNG tiles under `data/minimap/`. Tooling lives
in git, output does not — same shape as `wiki/`, per ADR-0019.

Nothing here is Blizzard-derived: the MPQ reader, BLP2 decoder and PNG encoder
are ours, the tests build synthetic archives and textures in code, and every
byte of game data the tool touches stays under the gitignored `data/`.

## Usage

Runs on the host, against the one-time client extraction. It does not talk to
any container and does not need the server running.

```
bun run --cwd minimap extract              # maps 0, 1, 530, 571
bun minimap/src/extract.ts --map 0,571     # specific maps
bun minimap/src/extract.ts --force         # rewrite existing tiles
bun minimap/src/extract.ts --limit 20      # first N tiles per map (smoke test)
```

Flags: `--map <ids>`, `--force`, `--limit <n>`, `--out <dir>` (default
`data/minimap`), `--client <dir>` (default
`data/client-source/ChromieCraft_3.3.5a/Data`).

Idempotent: a tile that already exists is skipped unless `--force`. A full
extraction of all four default maps takes about 17 s and produces 3636 tiles /
~104 MiB.

Tests: `bun test minimap/`. Typecheck: `bun run --cwd minimap typecheck`.

## Inputs

- `data/client-source/ChromieCraft_3.3.5a/Data/*.MPQ`, opened in client load
  order — `common`, `common-2`, `expansion`, `lichking`, `patch`, `patch-2`,
  `patch-3` — with later archives winning. `md5translate.trs` resolves to
  `patch-3.MPQ`; the hashed tile BLPs themselves resolve to `common.MPQ`.
- `textures\Minimap\md5translate.trs`, the client's table from readable tile
  names to the hashed files that actually exist in the archives.
- `data/client/dbc/Map.dbc` for the internal directory name → map id mapping
  (`Azeroth` → 0, `Kalimdor` → 1, `Expansion01` → 530, `Northrend` → 571).

## Output and the tile convention

`data/minimap/<mapId>/<tileRow>_<tileCol>.png`, 256×256 RGBA — one tile per
ADT, the native minimap resolution.

The two naming conventions in play are different from each other, so state both:

- **Input (`md5translate.trs`)**: an entry `map<A>_<B>.blp` has **A = tile
  column, B = tile row** — the same order ADT filenames use.
- **Output (this tool)**: `<tileRow>_<tileCol>.png` — **row first**, matching
  ADR-0019 and `runner/viewer/worldmap.ts`. So the trs entry
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
   | dwarf start, runs `night-sonnet-2` / `night-opus-1` | −6240, 331 | 43.70, 31.38 | `43_31` | Dun Morogh snow; marker on a small dwarven settlement, consistent with Coldridge Valley |
   | human start, runs `gate2-ox-1` / `roster-laguna-s-2-1-20260822` | −8870, −115 | 48.63, 32.22 | `48_32` | Elwynn green; the marker lands exactly on Northshire Abbey's red roof |

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

## Relationship to the viewer

`runner/viewer/worldmap.ts` owns the transform and `runner/viewer/tiles.ts`
serves `data/minimap/<mapId>/<row>_<col>.png`. Both already agree with what
this tool writes; no reconciliation was needed. ADR-0019 flagged the
orientation in `worldToPixel` as unverified until an extraction rendered a
known zone — the Northshire Abbey check above is that verification, and it
confirms the existing code rather than changing it.

## Layout

```
src/crypt.ts     Blizzard crypt table, string hash, block (de)cryption
src/mpq.ts       MPQ v1/v2 reader; MpqChain applies patch load order
src/compress.ts  sector decompression dispatch (zlib; bzip2 via bunzip2)
src/explode.ts   PKWARE implode — stub, see above
src/blp.ts       BLP2 decoder (palette / DXT1,3,5 / raw BGRA), mip 0
src/png.ts       minimal RGBA PNG encoder
src/dbc.ts       WDBC reader and the Map.dbc directory → id lookup
src/trs.ts       md5translate.trs parser
src/extract.ts   CLI
```
