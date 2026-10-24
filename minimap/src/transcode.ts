#!/usr/bin/env bun
/**
 * The served tile tree, derived from the lossless masters the extraction and
 * the bakes write. The format choices and the measurements behind them are in
 * `minimap/README.md`, "Served formats".
 *
 * Reads `<root>/<map>/<row>_<col>.png` and `<root>/<map>/<layer>/<z>/<row>_<col>.png`
 * and writes, under `<root>/web/` (`SERVED_DIR`):
 *
 * - `<map>/<row>_<col>.webp` for each native and `<map>/<layer>/<z>/<row>_<col>.webp`
 *   for each pyramid tile: lossy at `WEBP_QUALITY`, or lossless where that is
 *   at most `LOSSLESS_SLACK` times the lossy size — every solid, near-solid
 *   and mostly transparent tile, which a lossy codec shifts by whole levels
 *   and which then seams against its neighbours;
 * - `<map>/index.json`, which cells exist, where the art hides the minimap,
 *   and that the natives are WebP (`runner/viewer/tileindex.ts`).
 *
 * Alpha comes through exact or the tile is not lossy: every encoded tile is
 * decoded again and compared, and a mismatch falls back to the lossless form.
 * The masters are never written: the bakes read them, and lossy on lossy
 * would compound.
 *
 * Incremental. `web/transcode.json` records, per output, the hash of the
 * master it came from, under an encoder id that names the Bun build (whose
 * statically linked libwebp and libspng are the encoders) and the settings;
 * a changed master, a changed setting or a different Bun re-encodes, and
 * nothing else does. An output whose master is gone is removed. The encoders
 * are deterministic, so the tile publisher's content hashes see exactly the
 * tiles that changed.
 *
 *   bun minimap/src/transcode.ts [--root <tile root>] [--force]
 *
 * `--root` defaults to `data/minimap`. The tile publisher runs the same pass
 * before it scans, so a publish never ships a stale served tree.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type IndexCell, TILE_INDEX_NAME, buildTileIndex, renderTileIndex } from "../../runner/viewer/tileindex";
import { SERVED_DIR, newestMasterDir } from "../../runner/viewer/tiles";
import { ART_LAYER, LOD_LAYERS, LOD_MAX, type LodLayer, MINIMAP_LAYER, lodServedName, lodTileName, nativeServedName, tileName } from "../../runner/viewer/worldmap";
import { decodePng } from "./png";

/** libwebp quality for every served tile; why 90 is in the README. */
export const WEBP_QUALITY = 90;
/** Lossless wins wherever it costs at most this many times the lossy bytes. */
export const LOSSLESS_SLACK = 2;
/** The sidecar under the served tree. Not a tile name, so nothing serves or uploads it. */
export const TRANSCODE_STATE = "transcode.json";

/** Names the encoder build and every setting, so changing either re-encodes. */
export function encoderId(): string {
  return `bun ${Bun.version}+${Bun.revision}; native and lod webp q${WEBP_QUALITY} lossless<=${LOSSLESS_SLACK}x`;
}

const NATIVE = /^(\d+)_(\d+)\.png$/;
/** A served native: the WebP this pass writes, or the indexed PNG an older one did, which it removes. */
const SERVED_NATIVE = /^\d+_\d+\.(png|webp)$/;
const CONCURRENCY = 16;

async function decodeAny(bytes: Uint8Array): Promise<Uint8Array> {
  return decodePng(await new Bun.Image(bytes).png({ compressionLevel: 0 }).bytes()).rgba;
}

function alphaEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 3; i < a.length; i += 4) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * A tile's served bytes, native or pyramid: lossy WebP, or lossless where
 * that is cheap or lossy would touch alpha.
 */
export async function transcodeTile(master: Uint8Array): Promise<Uint8Array> {
  const [lossy, lossless] = await Promise.all([
    new Bun.Image(master).webp({ quality: WEBP_QUALITY }).bytes(),
    new Bun.Image(master).webp({ lossless: true }).bytes(),
  ]);
  if (lossless.length <= lossy.length * LOSSLESS_SLACK) return lossless;
  return alphaEqual(decodePng(master).rgba, await decodeAny(lossy)) ? lossy : lossless;
}

/**
 * Whether the art covers the minimap: opaque at every pixel the minimap
 * paints at all. Where it does, the map page drawing the art at full
 * strength never shows the minimap, so it does not fetch it.
 */
export function artCovers(art: Uint8Array, minimap: Uint8Array): boolean {
  for (let i = 3; i < minimap.length; i += 4) if (minimap[i] !== 0 && art[i] !== 255) return false;
  return true;
}

export interface TranscodeReport {
  /** Per kind: master bytes in, served bytes out, files, and how many were re-encoded this pass. */
  layers: Record<"native" | LodLayer, { files: number; masterBytes: number; servedBytes: number; encoded: number }>;
  removed: number;
  indexes: number;
}

interface State {
  encoder: string;
  tiles: Record<string, string>;
}

function readState(file: string): State {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<State>;
    if (typeof raw.encoder === "string" && raw.tiles !== null && typeof raw.tiles === "object") return { encoder: raw.encoder, tiles: raw.tiles };
  } catch {
    // Absent or unreadable: everything is re-encoded.
  }
  return { encoder: "", tiles: {} };
}

/**
 * The viewer serves a served file only while it is at least as new as what it
 * was derived from (`runner/viewer/tiles.ts`). A re-bake that rewrites a
 * master with the same bytes moves its mtime and nothing else, so the output
 * it maps to is current but looks stale: move its mtime up too. Only then,
 * so an unchanged pass leaves every validator the viewer sends alone.
 */
function keepFresh(file: string, since: number): void {
  if (statSync(file).mtimeMs < since) {
    const now = new Date(Math.max(Date.now(), Math.ceil(since)));
    utimesSync(file, now, now);
  }
}

/** Through a temp name and a rename, so a reader never sees half a file; skipped when the bytes are already there. */
function writeIfChanged(file: string, bytes: Uint8Array): void {
  if (existsSync(file)) {
    const have = readFileSync(file);
    if (have.length === bytes.length && have.equals(bytes)) return;
  }
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, file);
}

function list(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

interface Job {
  kind: "native" | LodLayer;
  map: number;
  z: number;
  row: number;
  col: number;
  master: string;
  /** Relative to the served root. */
  out: string;
}

/** Every master tile under the root, strict on names the way the viewer is. */
function masters(root: string): Job[] {
  const jobs: Job[] = [];
  for (const m of list(root)) {
    if (!/^\d+$/.test(m) || String(Number(m)) !== m) continue;
    const map = Number(m);
    for (const name of list(join(root, m))) {
      const n = NATIVE.exec(name);
      if (n === null) continue;
      const row = Number(n[1]);
      const col = Number(n[2]);
      if (tileName(row, col) !== name || row >= 64 || col >= 64) continue;
      jobs.push({ kind: "native", map, z: 0, row, col, master: join(root, m, name), out: `${m}/${nativeServedName(row, col)}` });
    }
    for (const layer of LOD_LAYERS) {
      for (let z = 1; z <= LOD_MAX; z++) {
        for (const name of list(join(root, m, layer, String(z)))) {
          const n = NATIVE.exec(name);
          if (n === null) continue;
          const row = Number(n[1]);
          const col = Number(n[2]);
          let rel: string;
          try {
            rel = lodTileName(layer, z, row, col);
          } catch {
            continue;
          }
          if (rel !== `${layer}/${z}/${name}`) continue;
          jobs.push({ kind: layer, map, z, row, col, master: join(root, m, rel), out: `${m}/${lodServedName(layer, z, row, col)}` });
        }
      }
    }
  }
  return jobs;
}

async function pooled<T>(items: readonly T[], fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      for (let i = next++; i < items.length; i = next++) await fn(items[i] as T);
    }),
  );
}

/** Every served file the transcode owns, relative to the served root. */
function servedFiles(dir: string): string[] {
  const out: string[] = [];
  for (const m of list(dir)) {
    if (!/^\d+$/.test(m)) continue;
    for (const name of list(join(dir, m))) if (SERVED_NATIVE.test(name) || name === TILE_INDEX_NAME) out.push(`${m}/${name}`);
    for (const layer of LOD_LAYERS) {
      for (const z of list(join(dir, m, layer))) {
        for (const name of list(join(dir, m, layer, z))) if (name.endsWith(".webp")) out.push(`${m}/${layer}/${z}/${name}`);
      }
    }
  }
  return out;
}

/** One pass over the whole root. */
export async function transcodeTree(root: string, opts: { force?: boolean } = {}): Promise<TranscodeReport> {
  const dir = join(root, SERVED_DIR);
  const stateFile = join(dir, TRANSCODE_STATE);
  const encoder = encoderId();
  const prior = readState(stateFile);
  const known = opts.force === true || prior.encoder !== encoder ? {} : prior.tiles;
  const jobs = masters(root);
  const report: TranscodeReport = {
    layers: {
      native: { files: 0, masterBytes: 0, servedBytes: 0, encoded: 0 },
      minimap: { files: 0, masterBytes: 0, servedBytes: 0, encoded: 0 },
      art: { files: 0, masterBytes: 0, servedBytes: 0, encoded: 0 },
    },
    removed: 0,
    indexes: 0,
  };
  const next: Record<string, string> = {};
  await pooled(jobs, async (job) => {
    const master = new Uint8Array(readFileSync(job.master));
    const hash = new Bun.CryptoHasher("sha256").update(master).digest("hex");
    const out = join(dir, job.out);
    const stats = report.layers[job.kind];
    let served: Uint8Array;
    if (known[job.out] === hash && existsSync(out)) {
      served = new Uint8Array(readFileSync(out));
    } else {
      served = await transcodeTile(master);
      writeIfChanged(out, served);
      stats.encoded++;
    }
    keepFresh(out, statSync(job.master).mtimeMs);
    next[job.out] = hash;
    stats.files++;
    stats.masterBytes += master.length;
    stats.servedBytes += served.length;
  });

  // The indexes, from the masters: which cells exist, and where the art
  // covers the minimap at the same level.
  const maps = [...new Set(jobs.map((j) => j.map))].sort((a, b) => a - b);
  for (const map of maps) {
    const own = jobs.filter((j) => j.map === map);
    const cells: IndexCell[] = own.map((j) => ({ layer: j.kind === "native" ? MINIMAP_LAYER : j.kind, z: j.z, row: j.row, col: j.col }));
    const minimapAt = new Map(own.filter((j) => j.kind === MINIMAP_LAYER).map((j) => [`${j.z}/${j.row}_${j.col}`, j.master]));
    const covers: { z: number; row: number; col: number }[] = [];
    await pooled(
      own.filter((j) => j.kind === ART_LAYER),
      async (j) => {
        const under = minimapAt.get(`${j.z}/${j.row}_${j.col}`);
        if (under === undefined) return;
        const art = decodePng(new Uint8Array(readFileSync(j.master))).rgba;
        const minimap = decodePng(new Uint8Array(readFileSync(under))).rgba;
        if (artCovers(art, minimap)) covers.push({ z: j.z, row: j.row, col: j.col });
      },
    );
    const body = new TextEncoder().encode(renderTileIndex(buildTileIndex(cells, covers, "webp")));
    const indexFile = join(dir, `${map}/${TILE_INDEX_NAME}`);
    writeIfChanged(indexFile, body);
    keepFresh(indexFile, newestMasterDir(root, map) ?? 0);
    next[`${map}/${TILE_INDEX_NAME}`] = "";
    report.indexes++;
  }

  // Anything served whose master is gone.
  for (const rel of servedFiles(dir)) {
    if (rel in next) continue;
    rmSync(join(dir, rel), { force: true });
    report.removed++;
  }

  const tiles: Record<string, string> = {};
  for (const key of Object.keys(next).sort()) if (next[key] !== "") tiles[key] = next[key] as string;
  writeIfChanged(stateFile, new TextEncoder().encode(`${JSON.stringify({ encoder, tiles })}\n`));
  return report;
}

function parseArgs(argv: string[]): { root: string; force: boolean } {
  let root = "data/minimap";
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root") root = argv[++i] ?? root;
    else if (a === "--force") force = true;
    else throw new Error(`transcode: unknown argument ${a}`);
  }
  return { root, force };
}

/** The report as lines, for this CLI and the tile publisher. */
export function describeTranscode(r: TranscodeReport): string[] {
  const mb = (n: number): string => (n / 1e6).toFixed(1);
  const lines = Object.entries(r.layers).map(
    ([kind, s]) => `transcode: ${kind}: ${s.files} files, ${mb(s.masterBytes)} MB master -> ${mb(s.servedBytes)} MB served, ${s.encoded} encoded`,
  );
  lines.push(`transcode: ${r.indexes} index(es), ${r.removed} stale file(s) removed`);
  return lines;
}

if (import.meta.main) {
  const opts = parseArgs(process.argv.slice(2));
  if (!existsSync(opts.root)) {
    console.error(`transcode: no tile root at ${opts.root} (run extract.ts first)`);
    process.exit(1);
  }
  const started = performance.now();
  const report = await transcodeTree(opts.root, { force: opts.force });
  for (const line of describeTranscode(report)) console.log(line);
  console.log(`transcode: ${encoderId()}, ${((performance.now() - started) / 1000).toFixed(1)} s`);
}
