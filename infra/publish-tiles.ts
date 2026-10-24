#!/usr/bin/env bun
/**
 * Publish the minimap tiles to the public dashboard's R2 bucket.
 *
 * Its own script, and deliberately not a flag on `publish-dashboard.ts`: the
 * snapshot loop runs unattended every few minutes and must never carry these
 * bytes along with it. Tiles change only when the extraction in `minimap/` is
 * re-run, so uploading them is an occasional, explicit act by the operator.
 *
 *   bun infra/publish-tiles.ts --dry-run   # transcode locally, print the plan, upload nothing
 *   bun infra/publish-tiles.ts --upload    # upload what changed
 *
 * The painted art layer goes up with the rest: the operator published it on
 * 2026-10-18 under the same exception as the minimap tiles
 * (docs/DATA-AND-LEGAL.md).
 *
 * Uploads the served tree, never the masters. A pass first runs the transcode
 * (`minimap/src/transcode.ts`), which is incremental, so the served tree under
 * `data/minimap/web/` is current with the bakes before anything is hashed;
 * then it reads only tiles out of that tree (gitignored, like all of `data/`)
 * — the natives `<mapId>/<row>_<col>.webp`, the pyramid levels
 * `<mapId>/<layer>/<z>/<row>_<col>.webp` and each map's `index.json` — and
 * writes only to the bucket, each object typed by its extension. Keys mirror
 * the viewer's own path so the SPA asks for the same URL in both shapes:
 * `tiles/<mapId>/<row>_<col>.webp`, `tiles/<mapId>/<layer>/<z>/…` for each
 * layer in `LOD_LAYERS` (`minimap`, `art`), `tiles/<mapId>/index.json`.
 *
 * The `.png` keys earlier passes uploaded — the pyramid's masters, and the
 * natives as indexed PNG — are no longer local, so they stay in the bucket as
 * manifest orphans. Builds from before each WebP tree ask for them, and so
 * does any build whose map index does not say `native: "webp"`. When to delete
 * them is in `infra/cloudflare/README.md`, step 6.
 *
 * No object carries a Cache-Control: Bun's S3 writer has no option for one
 * (its write options stop at type, disposition, encoding, storage class and
 * ACL), and the zone's `/tiles/` cache rules set the edge and browser TTLs by
 * path whatever an object says (`infra/cloudflare/README.md`). That matters
 * for the art layer, which is re-baked at the same keys while its look is
 * tuned: what reaches readers after a re-bake is decided at the edge, so a
 * pass reports which maps' art it changed, and those are the prefixes to
 * purge.
 *
 * Skip-unchanged is by content hash, held in a manifest object in the bucket
 * (`tiles/manifest.json`) rather than in a local state file: a re-extraction on
 * another machine rewrites every mtime without changing a byte, and the point
 * of this script is that a re-run with nothing new costs nothing. The manifest
 * is written LAST, for the same reason `publish-core.ts` flips `manifest.json`
 * last — a manifest that lands before the objects it claims would make a
 * half-finished run look complete to the next one.
 *
 * Env (Bun.S3Client's own names, autoloaded from .env, same key pair as the
 * snapshot publisher):
 *   S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_BUCKET, S3_ENDPOINT
 *   WRATHBENCH_MINIMAP_DIR  default data/minimap
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describeTranscode, transcodeTree } from "../minimap/src/transcode";
import { TILE_INDEX_NAME } from "../runner/viewer/tileindex";
import { SERVED_DIR, isRevalidatedTile, parseTileIndexPath, parseTilePath, tileContentType, tileRefPath } from "../runner/viewer/tiles";
import { LOD_LAYERS } from "../runner/viewer/worldmap";

// ------------------------------------------------------------------ contracts

/** The bucket prefix every tile object lives under. */
export const TILE_PREFIX = "tiles/";
/** Where the hash manifest lives. Not a tile path, so the gate never serves it. */
export const TILE_MANIFEST_KEY = "tiles/manifest.json";
/** Tile PNGs are large-ish and many; a modest pool keeps memory flat. */
export const TILE_CONCURRENCY = 8;

/** One tile on disk. */
export interface LocalTile {
  /** Bucket key, e.g. `tiles/0/43_31.webp` or `tiles/0/minimap/3/5_3.webp`. */
  key: string;
  /** Absolute or cwd-relative path under the minimap root. */
  file: string;
  size: number;
}

/** Key -> sha256 hex of the bytes last uploaded under it. */
export type TileManifest = Record<string, string>;

/** What a pass would do, before it does any of it. */
export interface TilePlan {
  upload: LocalTile[];
  unchanged: LocalTile[];
  /** Manifest keys with no file behind them any more. Left in the bucket. */
  orphans: string[];
}

/** The bucket, reduced to what this script needs. Faked in tests. */
export interface TileStore {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  putText(key: string, body: string, contentType: string): Promise<void>;
  getText(key: string): Promise<string | null>;
}

// -------------------------------------------------------------------- scanning

const MAP_DIR = /^\d+$/;
const LEVEL_DIR = /^\d+$/;
/** `.webp` now; `.png` in a served tree an older transcode wrote, which the pass before the scan replaces. */
const NATIVE_FILE = /^\d+_\d+\.(png|webp)$/;
const LEVEL_FILE = /^\d+_\d+\.webp$/;

/** Whether a request path is the one canonical spelling of a served tile or index. */
function isServedKey(path: string): boolean {
  const ref = parseTilePath(path);
  if (ref !== null) return ref.legacy !== true && tileRefPath(ref) === path;
  const map = parseTileIndexPath(path);
  return map !== null && path === `/${TILE_PREFIX}${map}/${TILE_INDEX_NAME}`;
}

function list(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

/**
 * Every tile under the served root (`<tile root>/web`), as bucket keys.
 *
 * Strict on names: a file is a tile only if `runner/viewer/tiles.ts` would
 * parse its path back out of a request *and* spell it the same way — so a
 * README, an extraction log, a half-written temp file, a level outside its
 * range, a layer the viewer does not serve, a second spelling of a tile
 * (`043_31.png`) or a pyramid tile under its master's `.png` name is not
 * something this script can upload. The walk reads only a map's own files
 * and the directories of the listed layers.
 */
export function scanTiles(root: string): LocalTile[] {
  const out: LocalTile[] = [];
  const add = (rel: string, file: string): void => {
    if (!isServedKey(`/${TILE_PREFIX}${rel}`)) return;
    const stat = statSync(file);
    if (!stat.isFile()) return;
    out.push({ key: `${TILE_PREFIX}${rel}`, file, size: stat.size });
  };
  for (const map of list(root)) {
    if (!MAP_DIR.test(map)) continue;
    const dir = join(root, map);
    for (const name of list(dir)) {
      if (NATIVE_FILE.test(name)) add(`${map}/${name}`, join(dir, name));
    }
    for (const layer of LOD_LAYERS) {
      for (const z of list(join(dir, layer))) {
        if (!LEVEL_DIR.test(z)) continue;
        const levelDir = join(dir, layer, z);
        for (const name of list(levelDir)) {
          if (LEVEL_FILE.test(name)) add(`${map}/${layer}/${z}/${name}`, join(levelDir, name));
        }
      }
    }
    if (list(dir).includes(TILE_INDEX_NAME)) add(`${map}/${TILE_INDEX_NAME}`, join(dir, TILE_INDEX_NAME));
  }
  return out;
}

/** Parse whatever is in the bucket into a manifest. A bad one is simply empty. */
export function parseTileManifest(json: string | null): TileManifest {
  if (json === null) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return {};
  }
  if (raw === null || typeof raw !== "object") return {};
  const tiles = (raw as { tiles?: unknown }).tiles;
  if (tiles === null || typeof tiles !== "object") return {};
  const out: TileManifest = {};
  for (const [k, v] of Object.entries(tiles as Record<string, unknown>)) {
    if (typeof v === "string" && k.startsWith(TILE_PREFIX)) out[k] = v;
  }
  return out;
}

export function renderTileManifest(manifest: TileManifest, now: number): string {
  const tiles: TileManifest = {};
  for (const key of Object.keys(manifest).sort()) tiles[key] = manifest[key] as string;
  return `${JSON.stringify({ version: 1, generatedAt: now, tiles }, null, 0)}\n`;
}

/**
 * Split the local set against the manifest. Pure, so the whole decision is
 * testable without a bucket or a disk full of PNGs.
 */
export function planTileUploads(local: LocalTile[], manifest: TileManifest, hashes: Map<string, string>): TilePlan {
  const upload: LocalTile[] = [];
  const unchanged: LocalTile[] = [];
  for (const tile of local) {
    const have = manifest[tile.key];
    const hash = hashes.get(tile.key);
    if (have !== undefined && hash !== undefined && have === hash) unchanged.push(tile);
    else upload.push(tile);
  }
  const present = new Set(local.map((t) => t.key));
  const orphans = Object.keys(manifest)
    .filter((k) => !present.has(k))
    .sort();
  return { upload, unchanged, orphans };
}

export function hashBytes(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

/** Bounded-concurrency map, in order, failing on the first error. */
async function pooled<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
}

export interface TilePublishReport {
  uploaded: number;
  skipped: number;
  bytes: number;
  orphans: number;
  /**
   * Entries in the bucket's manifest, or null when there is no manifest object
   * at all. The distinction is the whole trust of a `--dry-run`: "every tile
   * would upload" means a first run when this is null and a problem when it is
   * a number.
   */
  manifestEntries: number | null;
  /**
   * Maps whose art layer this pass uploads (or would): the art is re-baked at
   * the same keys, so each one is a `tiles/<map>/art/` prefix the edge has to
   * be purged of before readers see the new painting.
   */
  artMaps: number[];
  /**
   * Maps whose `index.json` this pass uploads (or would). The index is
   * rewritten at the same key whenever a map's cells change, so each one is a
   * `tiles/<map>/index.json` to purge, or the page keeps skipping cells the
   * bake has since added.
   */
  indexMaps: number[];
}

/** The maps among `tiles` whose keys are art-layer tiles, ascending. */
export function artMapsOf(tiles: readonly { key: string }[]): number[] {
  const maps = new Set<number>();
  for (const t of tiles) {
    const ref = parseTilePath(`/${t.key}`);
    if (ref !== null && isRevalidatedTile(ref)) maps.add(ref.map);
  }
  return [...maps].sort((a, b) => a - b);
}

/** The maps among `tiles` whose keys are tile indexes, ascending. */
export function indexMapsOf(tiles: readonly { key: string }[]): number[] {
  const maps = new Set<number>();
  for (const t of tiles) {
    const map = parseTileIndexPath(`/${t.key}`);
    if (map !== null) maps.add(map);
  }
  return [...maps].sort((a, b) => a - b);
}

/**
 * One pass: hash what is on disk, diff it against the bucket's manifest, upload
 * the difference, then write the manifest.
 */
export async function publishTiles(
  local: LocalTile[],
  store: TileStore,
  opts: {
    dryRun?: boolean;
    now?: number;
    concurrency?: number;
    log?: (line: string) => void;
  } = {},
): Promise<TilePublishReport> {
  const log = opts.log ?? ((line: string): void => console.log(line));
  const raw = await store.getText(TILE_MANIFEST_KEY);
  const manifest = parseTileManifest(raw);

  // Hash-only first pass. The bytes are deliberately not kept: a full
  // extraction is thousands of PNGs, and holding all of them to upload a
  // handful would make the memory cost of a no-op run the same as a first one.
  const hashes = new Map<string, string>();
  await pooled(local, opts.concurrency ?? TILE_CONCURRENCY, async (tile) => {
    hashes.set(tile.key, hashBytes(await Bun.file(tile.file).bytes()));
  });

  const plan = planTileUploads(local, manifest, hashes);
  const bytes = plan.upload.reduce((sum, t) => sum + t.size, 0);
  const report: TilePublishReport = {
    uploaded: plan.upload.length,
    skipped: plan.unchanged.length,
    bytes,
    orphans: plan.orphans.length,
    manifestEntries: raw === null ? null : Object.keys(manifest).length,
    artMaps: artMapsOf(plan.upload),
    indexMaps: indexMapsOf(plan.upload),
  };
  if (opts.dryRun === true) return report;

  // Indexes after the tiles they list, for the reason the manifest goes last:
  // an index that lands first would send a page to a cell not yet uploaded.
  const isIndex = (t: LocalTile): boolean => parseTileIndexPath(`/${t.key}`) !== null;
  for (const batch of [plan.upload.filter((t) => !isIndex(t)), plan.upload.filter(isIndex)]) {
    await pooled(batch, opts.concurrency ?? TILE_CONCURRENCY, async (tile) => {
      await store.put(tile.key, await Bun.file(tile.file).bytes(), tileContentType(tile.key));
    });
  }

  // Manifest last: a run that dies mid-upload leaves the previous manifest
  // standing, so the next run re-uploads what it did not finish.
  const next: TileManifest = { ...manifest };
  for (const tile of plan.upload) next[tile.key] = hashes.get(tile.key) as string;
  await store.putText(TILE_MANIFEST_KEY, renderTileManifest(next, opts.now ?? Date.now()), "application/json");
  if (plan.orphans.length > 0) {
    log(`publish-tiles: ${plan.orphans.length} manifest key(s) have no local file; left in the bucket`);
  }
  return report;
}

// ------------------------------------------------------------------------ CLI

if (import.meta.main) {
  const fail = (message: string): never => {
    console.error(`publish-tiles: ${message}`);
    process.exit(1);
  };

  const args = process.argv.slice(2);
  const dryRun = args.length === 1 && args[0] === "--dry-run";
  const upload = args.length === 1 && args[0] === "--upload";
  if (!dryRun && !upload) fail("usage: bun infra/publish-tiles.ts --dry-run | --upload");

  const root = Bun.env.WRATHBENCH_MINIMAP_DIR ?? "data/minimap";
  // The served tree first, so what is hashed is current with the bakes.
  for (const line of describeTranscode(await transcodeTree(root))) console.log(line);
  const local = scanTiles(join(root, SERVED_DIR));
  if (local.length === 0) fail(`no tiles under ${root} (run the extraction in minimap/ first)`);

  for (const name of ["S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_BUCKET", "S3_ENDPOINT"] as const) {
    if ((Bun.env[name] ?? "") === "" && (Bun.env[name.replace("S3_", "AWS_")] ?? "") === "") {
      fail(`${name} is not set (docs/RUNBOOK.md, "Public dashboard")`);
    }
  }

  const { S3Client } = await import("bun");
  const s3 = new S3Client();
  const store: TileStore = {
    put: async (key, body, contentType) => {
      await s3.write(key, body, { type: contentType });
    },
    putText: async (key, body, contentType) => {
      await s3.write(key, body, { type: contentType });
    },
    getText: async (key) => {
      try {
        return await s3.file(key).text();
      } catch (e) {
        // Only a missing object is null. A 403, a wrong endpoint or a bad key
        // pair must NOT read as "no manifest yet" — that would quietly turn an
        // ops failure into a full re-upload of the whole extraction.
        const code = (e as { code?: unknown }).code;
        if (code === "NoSuchKey" || code === "ENOENT") return null;
        throw e;
      }
    },
  };

  console.log(`publish-tiles: ${local.length} tile(s) under ${root} -> ${Bun.env.S3_BUCKET ?? Bun.env.AWS_BUCKET}`);
  const report = await publishTiles(local, store, { dryRun });
  const verb = dryRun ? "would upload" : "uploaded";
  console.log(
    report.manifestEntries === null
      ? `publish-tiles: no ${TILE_MANIFEST_KEY} in the bucket — this is a first run, everything uploads`
      : `publish-tiles: ${TILE_MANIFEST_KEY} lists ${report.manifestEntries} tile(s)`,
  );
  console.log(
    `publish-tiles: ${verb} ${report.uploaded}, skipped ${report.skipped} unchanged, ` +
      `${(report.bytes / 1024 / 1024).toFixed(2)} MiB, ${report.orphans} orphan(s)`,
  );
  if (report.artMaps.length > 0) {
    // Same keys, new paintings: the edge keeps the old ones until purged.
    console.log(
      `publish-tiles: art changed on map(s) ${report.artMaps.join(", ")} — purge ` +
        `${report.artMaps.map((m) => `/tiles/${m}/art/`).join(", ")} at the edge (infra/cloudflare/README.md, step 6)`,
    );
  }
  if (report.indexMaps.length > 0) {
    console.log(
      `publish-tiles: index changed on map(s) ${report.indexMaps.join(", ")} — purge ` +
        `${report.indexMaps.map((m) => `/tiles/${m}/${TILE_INDEX_NAME}`).join(", ")} at the edge (infra/cloudflare/README.md, step 6)`,
    );
  }
}
