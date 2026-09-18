#!/usr/bin/env bun
/**
 * Publish the minimap tiles to the public dashboard's R2 bucket.
 *
 * Its own script, and deliberately not a flag on `publish-dashboard.ts`: the
 * snapshot loop runs unattended every few minutes and must never carry these
 * bytes along with it. Tiles change only when the extraction in `minimap/` is
 * re-run, so uploading them is an occasional, explicit act by the operator.
 *
 *   bun infra/publish-tiles.ts --dry-run   # print the plan, upload nothing
 *   bun infra/publish-tiles.ts --upload    # upload what changed
 *
 * Reads only from `data/minimap/<mapId>/<row>_<col>.png` (gitignored, like all
 * of `data/`) and writes only to the bucket. Keys mirror the viewer's own path
 * so the SPA asks for the same URL in both shapes:
 * `tiles/<mapId>/<row>_<col>.png`.
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

// ------------------------------------------------------------------ contracts

/** The bucket prefix every tile object lives under. */
export const TILE_PREFIX = "tiles/";
/** Where the hash manifest lives. Not a tile path, so the gate never serves it. */
export const TILE_MANIFEST_KEY = "tiles/manifest.json";
/** Tile PNGs are large-ish and many; a modest pool keeps memory flat. */
export const TILE_CONCURRENCY = 8;

/** One tile on disk. */
export interface LocalTile {
  /** Bucket key, e.g. `tiles/0/43_31.png`. */
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
const TILE_FILE = /^\d+_\d+\.png$/;

/**
 * Every tile under the minimap root, as bucket keys.
 *
 * Strict on names — bare integers only, exactly what `runner/viewer/tiles.ts`
 * will parse back out of a request path — so anything else the directory
 * happens to hold (a README, an extraction log, a half-written temp file) is
 * not something this script can upload.
 */
export function scanTiles(root: string): LocalTile[] {
  let maps: string[];
  try {
    maps = readdirSync(root);
  } catch {
    return [];
  }
  const out: LocalTile[] = [];
  for (const map of maps.sort()) {
    if (!MAP_DIR.test(map)) continue;
    const dir = join(root, map);
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries.sort()) {
      if (!TILE_FILE.test(name)) continue;
      const file = join(dir, name);
      const stat = statSync(file);
      if (!stat.isFile()) continue;
      out.push({ key: `${TILE_PREFIX}${map}/${name}`, file, size: stat.size });
    }
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
}

/**
 * One pass: hash what is on disk, diff it against the bucket's manifest, upload
 * the difference, then write the manifest.
 */
export async function publishTiles(
  local: LocalTile[],
  store: TileStore,
  opts: { dryRun?: boolean; now?: number; concurrency?: number; log?: (line: string) => void } = {},
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
  };
  if (opts.dryRun === true) return report;

  await pooled(plan.upload, opts.concurrency ?? TILE_CONCURRENCY, async (tile) => {
    await store.put(tile.key, await Bun.file(tile.file).bytes(), "image/png");
  });

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
  const local = scanTiles(root);
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
}
