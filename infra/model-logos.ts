/**
 * Pure helpers behind `infra/fetch-model-logos.ts`: the lineup file's shape,
 * a small tar reader, which icon each family wants, and what a run would
 * change on disk.
 *
 * Nothing here touches the network or the filesystem, so the CLI's decisions
 * are testable from fixtures.
 */

// ------------------------------------------------------------------ lineup

export interface LineupFamily {
  id: string;
  name: string;
  vendor: string;
  /** Icon slug in the pinned package; absent means the family has no logo. */
  icon: string | undefined;
  match: string[];
}

export interface LineupIcons {
  package: string;
  version: string;
}

export interface ModelLineup {
  version: number;
  icons: LineupIcons;
  families: LineupFamily[];
}

/** A family id becomes a filename, and an icon slug becomes a path inside the tarball. */
const SAFE_SLUG = /^[a-z0-9][a-z0-9._-]*$/;

function str(value: unknown, where: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${where} must be a non-empty string`);
  return value;
}

/**
 * Parse and validate `infra/model-lineup.json`. Hand-rolled rather than zod,
 * like the rest of infra's config reading: the shape is small and the errors
 * are worth naming the offending entry.
 */
export function parseLineup(json: string, where = "model-lineup.json"): ModelLineup {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    throw new Error(`${where}: not valid JSON — ${(err as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`${where}: expected an object`);
  const top = raw as Record<string, unknown>;

  if (typeof top["version"] !== "number") throw new Error(`${where}: version must be a number`);

  const icons = top["icons"];
  if (typeof icons !== "object" || icons === null || Array.isArray(icons)) {
    throw new Error(`${where}: icons must be an object with package and version`);
  }
  const iconsObj = icons as Record<string, unknown>;
  const pinned: LineupIcons = {
    package: str(iconsObj["package"], `${where}: icons.package`),
    version: str(iconsObj["version"], `${where}: icons.version`),
  };

  const families = top["families"];
  if (!Array.isArray(families) || families.length === 0) {
    throw new Error(`${where}: families must be a non-empty array`);
  }

  const seen = new Set<string>();
  const parsed: LineupFamily[] = families.map((entry, i) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`${where}: families[${i}] must be an object`);
    }
    const f = entry as Record<string, unknown>;
    const id = str(f["id"], `${where}: families[${i}].id`);
    // The id is written as `<id>.svg`; keep it to something that cannot escape
    // the assets directory or surprise a bundler.
    if (!SAFE_SLUG.test(id)) throw new Error(`${where}: families[${i}].id "${id}" must match ${SAFE_SLUG}`);
    if (seen.has(id)) throw new Error(`${where}: duplicate family id "${id}"`);
    seen.add(id);

    let icon: string | undefined;
    if (f["icon"] !== undefined) {
      icon = str(f["icon"], `${where}: family ${id} icon`);
      if (!SAFE_SLUG.test(icon)) throw new Error(`${where}: family ${id} icon "${icon}" must match ${SAFE_SLUG}`);
    }

    const match = f["match"];
    if (!Array.isArray(match) || match.length === 0) {
      throw new Error(`${where}: family ${id} match must be a non-empty array of patterns`);
    }
    const patterns = match.map((p, j) => str(p, `${where}: family ${id} match[${j}]`));

    return { id, name: str(f["name"], `${where}: family ${id} name`), vendor: str(f["vendor"], `${where}: family ${id} vendor`), icon, match: patterns };
  });

  return { version: top["version"], icons: pinned, families: parsed };
}

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
  const stripped = text.replace(/<title[^>]*>[\s\S]*?<\/title>/g, "");
  return stripped === text ? svg : new TextEncoder().encode(stripped);
}

/**
 * The icon each family asks for, in lineup order. A slug the package does not
 * carry is a hard error: silently shipping a lineup that names a typo would
 * leave the dashboard with a missing logo and no way to notice.
 */
export function selectIcons(lineup: ModelLineup, entries: readonly TarEntry[]): IconEntry[] {
  const byPath = new Map<string, Uint8Array>();
  for (const e of entries) byPath.set(e.name, e.data);

  const out: IconEntry[] = [];
  for (const family of lineup.families) {
    if (family.icon === undefined) continue;
    const path = iconPath(family.icon);
    const svg = byPath.get(path);
    if (svg === undefined) {
      throw new Error(
        `family ${family.id}: icon "${family.icon}" is not in ${lineup.icons.package}@${lineup.icons.version} (no ${path} in the tarball)`,
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
