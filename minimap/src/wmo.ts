/**
 * The other kind of minimap: a WMO's own, drawn where the model stands.
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
 * Map 36 (`DeadminesInstance`) is the second shape. It has ADTs, and their
 * minimap is the hills above the mine and Ironclad Cove; the mine itself is
 * models the ADTs place (`MODF`, with a real position and a yaw), whose
 * indoor groups carry minimaps of their own in the same `<Model>_<g>_<a>_<b>`
 * form. One trs directory (`WMO\Dungeon\AZ_Deadmines`) files four models'
 * tiles, so a tile's model is read off its name (`wmoModelStem`), not its
 * directory.
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
 * - **An image need not be 256px.** A group small enough for one tile gets a
 *   smaller power-of-two image at the same 2 px to the yard, painted flush
 *   against its bottom row and left column: Subway groups 009 and 015 are
 *   256x64 and 016 is 64x32, and every Deadmines tile is 32 to 256 on a side.
 *   The band a tile covers ends `height / 2` yards below `max.y`, not 128;
 *   counted that way, Deadmines group B000's 64x64 image paints rows 18-63
 *   for its 23.2-yard span, and 33 of the 34 B and D groups start painting
 *   at row `height - 2 * span` to within three pixels. Read with 128, every
 *   image shorter than 256 lands 64 to 112 yards off. A shorter image with
 *   `b > 0` has not been seen.
 *
 * ## Placing a model
 *
 * A placement's frame keeps height second, with world x = origin −
 * position[2] and world y = origin − position[0]; the origin is 0 for a WDT's
 * global model and half the world's width for an ADT's. The model turns by
 * `rotation[1]` degrees about the vertical, then by the tram's 180°. What
 * shows it: the corners of each Deadmines model's own box land on the
 * world box its `MODF` declares, to a tenth of a yard, for B (−91°) and D
 * (−55.5°, oblique enough that the other sign misses by 37 yards). Overlaid
 * on the result, all 213 of map 36's creature spawns fall on painted rooms,
 * the cove and the ship, and the instance's arrival point at the mouth of the
 * entrance tunnel.
 */

/** Yards covered by one 256px WMO minimap tile. Measured, see above. */
export const WMO_TILE_SIZE = 128;

/** A full WMO minimap tile is the same 256px square an ADT one is. */
export const WMO_TILE_PX = 256;

/** The scale that follows: 2 px per yard, four times the ADT minimap's. */
export const WMO_PX_PER_YARD = WMO_TILE_PX / WMO_TILE_SIZE;

/** A 3-component vector as the chunks store it. */
export type Vec3 = readonly [number, number, number];

/** One `MODF` entry: a WMO placed in the world. */
export interface WmoPlacement {
  /** The model path exactly as `MWMO` spells it, e.g. `World\wmo\...\Subway.wmo`. */
  name: string;
  /** The same for every ADT that lists one placed model. */
  uniqueId: number;
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
 * Half the world's width: where the world origin sits in the coordinate frame
 * an ADT's `MODF` positions are written in (32 ADTs of 533⅓ yards).
 */
export const ADT_FRAME_ORIGIN = 32 * (1600 / 3);

function readModf(view: DataView, at: number, name: string): WmoPlacement {
  return {
    name,
    uniqueId: view.getUint32(at + 4, true),
    position: vec3(view, at + 8),
    rotation: vec3(view, at + 20),
    extentMin: vec3(view, at + 32),
    extentMax: vec3(view, at + 44),
  };
}

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
  return readModf(view, modf.at, names[0] as string);
}

/**
 * Every WMO one ADT places: `MODF` entries, each naming its model through
 * `MWID` (an offset into the `MWMO` string block). A model that straddles
 * tiles is listed by every ADT it touches, under the same `uniqueId`, so a
 * caller collecting a whole map dedupes on that.
 */
export function parseAdtWmoPlacements(adt: Uint8Array): WmoPlacement[] {
  const view = new DataView(adt.buffer, adt.byteOffset, adt.byteLength);
  let mwmo: Chunk | null = null;
  let mwid: Chunk | null = null;
  let modf: Chunk | null = null;
  for (const chunk of chunks(adt)) {
    if (chunk.magic === "MWMO") mwmo = chunk;
    else if (chunk.magic === "MWID") mwid = chunk;
    else if (chunk.magic === "MODF") modf = chunk;
  }
  if (mwmo === null || mwid === null || modf === null) return [];
  const block = mwmo;
  const nameAt = (offset: number): string | null => {
    if (offset >= block.size) return null;
    let end = block.at + offset;
    while (end < block.at + block.size && adt[end] !== 0) end++;
    return new TextDecoder().decode(adt.subarray(block.at + offset, end));
  };
  const out: WmoPlacement[] = [];
  for (let at = modf.at; at + MODF_SIZE <= modf.at + modf.size; at += MODF_SIZE) {
    const nameId = view.getUint32(at, true);
    if ((nameId + 1) * 4 > mwid.size) continue;
    const name = nameAt(view.getUint32(mwid.at + nameId * 4, true));
    if (name === null || name.length === 0) continue;
    out.push(readModf(view, at, name));
  }
  return out;
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
 * Whether a placement turns only about the vertical — the only kind
 * `placementToWorld` handles. Every placement the extractor has met is: the
 * tram's (none at all) and the Deadmines' (yaw only). A tilted model would
 * need the full rotation and a projection, so the extractor checks and says
 * so instead. A tolerance rather than `=== 0` because these are floats off a
 * disk.
 */
export function isUprightPlacement(p: WmoPlacement, epsilon = 1e-3): boolean {
  return Math.abs(p.rotation[0]) <= epsilon && Math.abs(p.rotation[2]) <= epsilon;
}

/** A function from a model's horizontal coordinates to the world's. */
export type ModelToWorld = (x: number, y: number) => { x: number; y: number };

/**
 * Model space → world space for an upright placement.
 *
 * The placement's frame has height second and its two horizontal axes the
 * world's turned about: world x = origin − position[2], world y = origin −
 * position[0], where the origin is 0 for a WDT's global model and
 * `ADT_FRAME_ORIGIN` for an ADT's. The model turns by `rotation[1]` degrees
 * about the vertical and then, like the tram, 180° (the negation), so an
 * unrotated model at the origin is `(−x, −y)`.
 */
export function placementToWorld(p: WmoPlacement, frame: "wdt" | "adt"): ModelToWorld {
  const origin = frame === "adt" ? ADT_FRAME_ORIGIN : 0;
  const ox = origin - p.position[2];
  const oy = origin - p.position[0];
  const t = (p.rotation[1] * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  return (x, y) => ({ x: ox - (c * x - s * y), y: oy - (s * x + c * y) });
}

/**
 * The model coordinate a pixel of a group tile stands on.
 *
 * `a` counts up from the group's `min.x` and `b` counts down from its
 * `max.y`, and within an image x runs with model x and y with model y. The
 * image is `height` pixels tall and its bottom row is flush against the
 * band's top: a 256px tile spans the whole 128-yard band, and a group small
 * enough for one shorter image sits flush at `max.y`.
 */
export function groupPixelToModel(
  box: WmoGroupBox,
  tile: { a: number; b: number },
  height: number,
  sx: number,
  sy: number,
): { x: number; y: number } {
  return {
    x: box.min[0] + tile.a * WMO_TILE_SIZE + sx / WMO_PX_PER_YARD,
    y: box.max[1] - tile.b * WMO_TILE_SIZE - (height - sy) / WMO_PX_PER_YARD,
  };
}

/**
 * The trs section a model's tiles are filed under.
 *
 * That section is the model's *directory* with the `World\` prefix dropped —
 * `World\wmo\Dungeon\AZ_Subway\Subway.wmo` is filed under
 * `WMO\Dungeon\AZ_Subway` — lower-cased the way `parseTrs` keys are. One
 * directory can hold several models (`AZ_Deadmines` holds four), so the
 * section alone does not say whose a tile is; `wmoModelStem` does.
 */
export function wmoTrsSection(name: string): string {
  const dir = name.slice(0, Math.max(0, name.lastIndexOf("\\")));
  return dir.replace(/^world\\/i, "").toLowerCase();
}

/**
 * The model's file name without its extension, lower-cased: the prefix its
 * group tiles carry (`Subway_000_00_00.blp` for `Subway.wmo`), as
 * `parseWmoTrs` records it.
 */
export function wmoModelStem(name: string): string {
  const base = name.slice(name.lastIndexOf("\\") + 1);
  const dot = base.lastIndexOf(".");
  return (dot < 0 ? base : base.slice(0, dot)).toLowerCase();
}
