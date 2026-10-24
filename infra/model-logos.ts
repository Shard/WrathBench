/**
 * Pure helpers behind `infra/fetch-model-logos.ts`: a small tar reader, which
 * icon each model-catalogue family wants, and what a run would change on disk.
 * The catalogue's own shape and validation are `infra/model-catalogue.ts`'s.
 *
 * Nothing here touches the network or the filesystem, so the CLI's decisions
 * are testable from fixtures.
 */

import type { CatalogueFamily, ModelCatalogue } from "./model-catalogue";

/** What the logo fetch reads of the model catalogue: the pinned package and each family's icon. */
export type LogoCatalogue = Pick<ModelCatalogue, "icons"> & { families: readonly Pick<CatalogueFamily, "id" | "icon">[] };

// --------------------------------------------------------------------- tar

export interface TarEntry {
  name: string;
  data: Uint8Array;
}

const BLOCK = 512;

/**
 * Read a plain (already gunzipped) tar. Enough of the format for an npm
 * tarball and no more: ustar headers, regular files only, no PAX/GNU long-name
 * extensions — npm packs paths short enough for the name/prefix pair.
 */
export function readTar(archive: Uint8Array): TarEntry[] {
  const decoder = new TextDecoder();
  const field = (at: number, off: number, len: number): string => {
    const raw = archive.subarray(at + off, at + off + len);
    const end = raw.indexOf(0);
    return decoder.decode(end === -1 ? raw : raw.subarray(0, end)).trim();
  };

  const out: TarEntry[] = [];
  for (let at = 0; at + BLOCK <= archive.length; ) {
    // Two zero blocks close the archive; one is already enough to stop.
    if (archive.subarray(at, at + BLOCK).every((b) => b === 0)) break;

    const name = field(at, 0, 100);
    const prefix = field(at, 345, 155);
    const octal = field(at, 124, 12);
    const size = octal === "" ? 0 : Number.parseInt(octal, 8);
    if (!Number.isFinite(size) || size < 0) throw new Error(`tar: unreadable size "${octal}" for entry ${name || "(unnamed)"}`);

    const typeflag = archive[at + 156] ?? 0;
    const body = at + BLOCK;
    // '0' and NUL are the two spellings of a regular file; anything else
    // (directory, link, PAX header) carries no icon and is skipped.
    if (typeflag === 0x30 || typeflag === 0) {
      out.push({ name: prefix === "" ? name : `${prefix}/${name}`, data: archive.subarray(body, body + size) });
    }
    at = body + Math.ceil(size / BLOCK) * BLOCK;
  }
  return out;
}

// ------------------------------------------------------------------ icons

export interface IconEntry {
  familyId: string;
  slug: string;
  /** Where it lived in the tarball, for error messages. */
  path: string;
  svg: Uint8Array;
}

/** Path of an icon slug inside the package tarball. */
export function iconPath(slug: string): string {
  return `package/icons/${slug}.svg`;
}

/**
 * The packaged icons each embed a `<title>` ("Claude"), which browsers treat
 * as the tooltip when the SVG is inlined — hijacking the richer label the
 * dashboard puts on the badge itself. The icon is decorative there, so the
 * title comes out at extraction; every consumer and the idempotence compare
 * then see the same bytes.
 */
export function prepareSvg(svg: Uint8Array): Uint8Array {
  const text = new TextDecoder().decode(svg);
  const prepared = paintWhiteAsText(text.replace(/<title[^>]*>[\s\S]*?<\/title>/g, ""));
  return prepared === text ? svg : new TextEncoder().encode(prepared);
}

/**
 * A shape painted pure white becomes `currentColor`.
 *
 * Some of the package's colour icons are drawn for a dark tile: Kimi's is a
 * blue dot beside a white K. On a light page the K vanishes, and in the
 * charts and on the map, where every logo sits on a white puck, it left a
 * blank disc. As `currentColor` the shape follows the text colour inline,
 * light on dark and dark on light, and resolves to black in an image
 * document, which is what the pucks draw. A white fill inside a `<clipPath>`
 * or `<mask>` is geometry rather than paint and is left alone.
 */
export function paintWhiteAsText(svg: string): string {
  return svg
    .split(/(<(clipPath|mask)\b[\s\S]*?<\/\2>)/)
    .map((part, i) => (i % 3 === 0 ? part.replace(/\bfill="(#fff|#ffffff|white)"/gi, 'fill="currentColor"') : i % 3 === 1 ? part : ""))
    .join("");
}

/**
 * The icon each family asks for, in catalogue order. A slug the package does not
 * carry is a hard error: silently shipping a catalogue that names a typo would
 * leave the dashboard with a missing logo and no way to notice.
 */
export function selectIcons(catalogue: LogoCatalogue, entries: readonly TarEntry[]): IconEntry[] {
  const byPath = new Map<string, Uint8Array>();
  for (const e of entries) byPath.set(e.name, e.data);

  const out: IconEntry[] = [];
  for (const family of catalogue.families) {
    if (family.icon === undefined) continue;
    const path = iconPath(family.icon);
    const svg = byPath.get(path);
    if (svg === undefined) {
      throw new Error(
        `family ${family.id}: icon "${family.icon}" is not in ${catalogue.icons.package}@${catalogue.icons.version} (no ${path} in the tarball)`,
      );
    }
    out.push({ familyId: family.id, slug: family.icon, path, svg: prepareSvg(svg) });
  }
  return out;
}

// ------------------------------------------------------------------- plan

export interface AssetPlan {
  /** Family ids with no file in the assets directory. */
  missing: string[];
  /** Family ids whose file exists but differs from the packaged icon. */
  stale: string[];
  /** Family ids whose file is already byte-identical. */
  unchanged: string[];
  /** `.svg` filenames in the directory no family references. */
  orphaned: string[];
}

export function assetFile(familyId: string): string {
  return `${familyId}.svg`;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * What a run would change. Both sides may carry `null` instead of bytes,
 * meaning "present but not read" — that is how `--check` works offline: it
 * knows which files exist but cannot know whether their bytes still match the
 * pinned package, so an unread pair counts as unchanged rather than stale.
 *
 * `wanted` is keyed by family id, `present` by filename as found on disk.
 */
export function planAssets(
  wanted: ReadonlyMap<string, Uint8Array | null>,
  present: ReadonlyMap<string, Uint8Array | null>,
): AssetPlan {
  const plan: AssetPlan = { missing: [], stale: [], unchanged: [], orphaned: [] };
  const claimed = new Set<string>();

  for (const [familyId, svg] of wanted) {
    const file = assetFile(familyId);
    claimed.add(file);
    if (!present.has(file)) {
      plan.missing.push(familyId);
      continue;
    }
    const onDisk = present.get(file) ?? null;
    if (svg !== null && onDisk !== null && !bytesEqual(svg, onDisk)) plan.stale.push(familyId);
    else plan.unchanged.push(familyId);
  }

  for (const file of present.keys()) {
    if (file.endsWith(".svg") && !claimed.has(file)) plan.orphaned.push(file);
  }
  plan.orphaned.sort();
  return plan;
}
