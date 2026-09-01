/**
 * The other kind of minimap: a map whose terrain is one big WMO instead of a
 * grid of ADTs.
 *
 * Map 369 (`DeeprunTram`) is the case that forced this. Its WDT holds no ADTs
 * at all — one `MODF` placing `AZ_Subway.wmo` at the origin — and
 * `md5translate.trs` has no `deepruntram` section, so the ADT path in
 * `extract.ts` finds nothing and the map draws as an empty lattice. The tiles
 * do exist; they are filed under the *model's* directory
 * (`WMO\Dungeon\AZ_Subway`) and named `Subway_<group>_<a>_<b>.blp` — a group
 * index and a grid local to that group, with no world coordinate anywhere in
 * the name. Placing them is this module's whole job.
 *
 * Everything here is pure: chunk parsing and arithmetic, no I/O and no decode.
 * `extract.ts` owns the pixels.
 *
 * ## What was measured, and how
 *
 * None of the constants below are from a spec. Each was read off the real
 * archive and is reproducible from it:
 *
 * - **2 pixels per yard**, so 128 yards per 256px tile — four times the ADT
 *   minimap's density, and not the 133.33 a quarter-ADT would give. Every one
 *   of the 20 Subway groups paints its tiles from image x = 0 to exactly
 *   `(max.x - min.x) * 2`, with a transparent margin filling the rest of the
 *   last tile. Twenty independent agreements, to the pixel.
 * - **A group's tiles are one strip that ends flush at its bounding box**, and
 *   `b` counts *backwards* along it: tile `b` covers model y from
 *   `max.y - (b + 1) * 128` to `max.y - b * 128`, so `b = 0` is the band
 *   against the group's maximum. What shows this is where the slack goes. The
 *   strip is longer than the group by `nb * 128 - span`, and that unpainted
 *   remainder sits at the low rows of the *highest*-numbered tile — g000 paints
 *   rows 0-255 of `b0` and only rows 201-255 of `b1`, and 256 - 201 is exactly
 *   its 55px remainder. Nineteen of twenty groups put their remainder there,
 *   to the pixel. Number the strip the other way and the paint comes apart at
 *   a tile seam and leaves a hole the width of the remainder.
 * - **World x is negated, not mirrored.** `worldX = -x` together with
 *   `worldY = -y` is a 180° turn about the vertical, which is what a rigid
 *   placement can produce; leaving world x unnegated would be a reflection.
 *   The trajectories agree: the two tram tracks sit at world x -45.4 and 4.5,
 *   symmetric to a quarter yard about the tunnel's centre line under the
 *   negated reading and outside the tunnel entirely under the other.
 *
 * Laid out this way the painted set lands flush inside the model's own extent
 * on both axes — model x [-195.3, 215.1] and y [-2565.4, 38.9] against a
 * declared [-195.25, 215.77] and [-2565.71, 39.42] — which is the check that
 * catches an anchor off by a tile, since paint cannot fall outside the box the
 * model declares.
 *
 * Three of the 20 groups (009, 015, 016 — two entrance stubs and a tiny
 * fixture) paint content with no relation to their own bounding box, on either
 * axis. They are placed by the same rule as the rest and land close enough;
 * nothing here special-cases them.
 */

/** Yards covered by one 256px WMO minimap tile. Measured, see above. */
export const WMO_TILE_SIZE = 128;

/** WMO minimap tiles are the same 256px squares the ADT ones are. */
export const WMO_TILE_PX = 256;

/** The scale that follows: 2 px per yard, four times the ADT minimap's. */
export const WMO_PX_PER_YARD = WMO_TILE_PX / WMO_TILE_SIZE;

/** A 3-component vector as the chunks store it. */
export type Vec3 = readonly [number, number, number];

/** One `MODF` entry: a WMO placed in the world. */
export interface WmoPlacement {
  /** The model path exactly as `MWMO` spells it, e.g. `World\wmo\...\Subway.wmo`. */
  name: string;
  position: Vec3;
  rotation: Vec3;
  extentMin: Vec3;
  extentMax: Vec3;
}

/** One `MOGI` entry: the bounding box of a group inside the model. */
export interface WmoGroupBox {
  min: Vec3;
  max: Vec3;
}

interface Chunk {
  magic: string;
  at: number;
  size: number;
}

/**
 * Walk a chunked file. The magic is stored back to front on disk (`REVM` for
 * `MVER`), which is the one thing about this format that bites every reader.
 */
function* chunks(data: Uint8Array): Generator<Chunk> {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let at = 0;
  while (at + 8 <= data.byteLength) {
    const magic = String.fromCharCode(
      data[at + 3] as number,
      data[at + 2] as number,
      data[at + 1] as number,
      data[at] as number,
    );
    const size = view.getUint32(at + 4, true);
    if (at + 8 + size > data.byteLength) return;
    yield { magic, at: at + 8, size };
    at += 8 + size;
  }
}

function vec3(view: DataView, at: number): Vec3 {
  return [view.getFloat32(at, true), view.getFloat32(at + 4, true), view.getFloat32(at + 8, true)];
}

/** Size of one `MODF` record. */
const MODF_SIZE = 64;
/** Size of one `MOGI` record. */
const MOGI_SIZE = 32;

/**
 * The single WMO a terrain-less map is made of, or null if the WDT has ADTs
 * (or anything else this does not understand).
 *
 * A WDT with a global WMO carries exactly one `MWMO` name and one `MODF`. Any
 * other shape is refused rather than guessed at: a map with several placed
 * models would need each one's own transform, and no map we extract has one.
 */
export function parseWdtGlobalWmo(wdt: Uint8Array): WmoPlacement | null {
  const view = new DataView(wdt.buffer, wdt.byteOffset, wdt.byteLength);
  let names: string[] = [];
  let modf: Chunk | null = null;
  for (const chunk of chunks(wdt)) {
    if (chunk.magic === "MWMO") {
      names = new TextDecoder()
        .decode(wdt.subarray(chunk.at, chunk.at + chunk.size))
        .split("\0")
        .filter((s) => s.length > 0);
    } else if (chunk.magic === "MODF") modf = chunk;
  }
  if (modf === null || modf.size < MODF_SIZE || names.length !== 1) return null;
  const at = modf.at;
  return {
    name: names[0] as string,
    position: vec3(view, at + 8),
    rotation: vec3(view, at + 20),
    extentMin: vec3(view, at + 32),
    extentMax: vec3(view, at + 44),
  };
}

/** The bounding box of every group in a WMO root file, in model order. */
export function parseWmoGroupBoxes(root: Uint8Array): WmoGroupBox[] {
  const view = new DataView(root.buffer, root.byteOffset, root.byteLength);
  for (const chunk of chunks(root)) {
    if (chunk.magic !== "MOGI") continue;
    const out: WmoGroupBox[] = [];
    for (let at = chunk.at; at + MOGI_SIZE <= chunk.at + chunk.size; at += MOGI_SIZE) {
      out.push({ min: vec3(view, at + 4), max: vec3(view, at + 16) });
    }
    return out;
  }
  return [];
}

/**
 * Whether a placement is the identity — the only one `wmoToWorld` handles.
 *
 * Every global-WMO map in 3.3.5a places its model at the origin unrotated, so
 * rather than carry a rotation matrix nothing exercises, the extractor checks
 * and says so when it is wrong. A tolerance rather than `=== 0` because these
 * are floats off a disk.
 */
export function isIdentityPlacement(p: WmoPlacement, epsilon = 1e-3): boolean {
  return [...p.position, ...p.rotation].every((v) => Math.abs(v) <= epsilon);
}

/**
 * Model space → world space, for a WMO placed at the origin unrotated.
 *
 * A 180° turn about the vertical: both horizontal axes flip, height does not.
 */
export function wmoToWorld(x: number, y: number, z: number): { x: number; y: number; z: number } {
  return { x: -x, y: -y, z };
}

/**
 * The world coordinate of a group tile's pixel (0, 0).
 *
 * Both axes hang off a corner of the group's own box — `a` counts up from
 * `min.x`, `b` counts down from `max.y` — so a tile places itself knowing
 * nothing about how many siblings it has.
 */
export function groupTileOrigin(box: WmoGroupBox, a: number, b: number): { x: number; y: number } {
  return {
    x: -box.min[0] - a * WMO_TILE_SIZE,
    y: -box.max[1] + (b + 1) * WMO_TILE_SIZE,
  };
}

/**
 * The world coordinate a pixel of a placed group tile stands on.
 *
 * Both image axes run *down* in world terms — image x southward (world x
 * falling) and image y eastward (world y falling) — so the tile is the world
 * transposed relative to a north-up map, which is why the compositor cannot
 * simply blit and has to place pixel by pixel.
 */
export function tilePixelToWorld(
  origin: { x: number; y: number },
  sx: number,
  sy: number,
): { x: number; y: number } {
  return { x: origin.x - sx / WMO_PX_PER_YARD, y: origin.y - sy / WMO_PX_PER_YARD };
}

/**
 * The trs section a model's tiles are filed under.
 *
 * That section is the model's *directory* with the `World\` prefix dropped —
 * `World\wmo\Dungeon\AZ_Subway\Subway.wmo` is filed under
 * `WMO\Dungeon\AZ_Subway` — lower-cased the way `parseTrs` keys are. The
 * file name goes with it: the group tiles carry it in their own names instead.
 */
export function wmoTrsSection(name: string): string {
  const dir = name.slice(0, Math.max(0, name.lastIndexOf("\\")));
  return dir.replace(/^world\\/i, "").toLowerCase();
}
