#!/usr/bin/env bun
/**
 * Fetch the model logos named by `infra/model-lineup.json` into
 * `dashboard/src/assets/model-logos/<family-id>.svg`.
 *
 *   bun infra/fetch-model-logos.ts            # download, write, prune
 *   bun infra/fetch-model-logos.ts --check    # no network; drift check
 *
 * Recognizing a new model should be a data edit (ADR-0045): add or extend a
 * family in the lineup, run this, commit. The artwork comes from
 * `@lobehub/icons-static-svg` at the version the lineup pins, pulled straight
 * from `registry.npmjs.org` — the CDN mirrors that normally serve these files
 * are not reachable from here, and a registry tarball is the pinnable thing
 * anyway: its metadata quotes an sha512 integrity we verify before unpacking.
 *
 * The SVGs are committed. They are a few hundred bytes each, the dashboard has
 * to build from a bare clone with no network, and a committed asset is the only
 * version of "pinned" that survives the package being unpublished.
 *
 * Writes are byte-compared first, so a re-run that changed nothing produces no
 * diff, and `.svg` files no family references are pruned — a family renamed in
 * the lineup does not leave its old logo behind.
 */

import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseLineup, planAssets, readTar, selectIcons, assetFile, type ModelLineup } from "./model-logos.ts";

const REPO_ROOT = dirname(import.meta.dir);
const LINEUP = join(REPO_ROOT, "infra", "model-lineup.json");
const ASSETS = join(REPO_ROOT, "dashboard", "src", "assets", "model-logos");
/** Shown in output relative to the repo root; absolute paths are noise here. */
const ASSETS_LABEL = "dashboard/src/assets/model-logos";
const REGISTRY = "https://registry.npmjs.org";

interface RegistryVersion {
  dist?: { tarball?: unknown; integrity?: unknown };
}

/** Filenames already in the assets directory. Missing directory = nothing there yet. */
function presentFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".svg"))
    .sort();
}

/**
 * The pinned tarball's bytes, verified against the registry's own
 * `dist.integrity`. The metadata document and the tarball come from the same
 * host, so this is not a trust boundary so much as a corruption and
 * wrong-version guard — but it is free, and a silently truncated download
 * would otherwise surface as an unreadable tar much further along.
 */
async function fetchTarball(icons: ModelLineup["icons"]): Promise<Uint8Array<ArrayBuffer>> {
  const metaUrl = `${REGISTRY}/${icons.package}/${icons.version}`;
  const metaRes = await fetch(metaUrl);
  if (!metaRes.ok) throw new Error(`${metaUrl}: HTTP ${metaRes.status}`);
  const meta = (await metaRes.json()) as RegistryVersion;

  const tarball = meta.dist?.tarball;
  const integrity = meta.dist?.integrity;
  if (typeof tarball !== "string" || tarball === "") throw new Error(`${metaUrl}: no dist.tarball`);
  if (typeof integrity !== "string" || !integrity.startsWith("sha512-")) {
    throw new Error(`${metaUrl}: dist.integrity is not an sha512 SRI string (got ${String(integrity)})`);
  }

  const res = await fetch(tarball);
  if (!res.ok) throw new Error(`${tarball}: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());

  const digest = new Bun.CryptoHasher("sha512").update(bytes).digest("base64");
  const expected = integrity.slice("sha512-".length);
  if (digest !== expected) {
    throw new Error(`${tarball}: sha512 mismatch — registry says ${expected}, download hashes to ${digest}`);
  }
  console.log(`${icons.package}@${icons.version}: ${bytes.length} bytes, sha512 verified`);
  return bytes;
}

async function check(lineup: ModelLineup): Promise<number> {
  const wanted = new Map<string, Uint8Array | null>();
  for (const f of lineup.families) if (f.icon !== undefined) wanted.set(f.id, null);
  const present = new Map<string, Uint8Array | null>(presentFiles(ASSETS).map((f) => [f, null]));
  // Bytes are deliberately not read: without the tarball there is nothing to
  // compare them against, so --check finds missing and orphaned files only.
  // Byte-level staleness is what the default (network) run is for.
  const plan = planAssets(wanted, present);

  for (const id of plan.missing) {
    const family = lineup.families.find((f) => f.id === id);
    console.error(`missing   ${ASSETS_LABEL}/${assetFile(id)} (family ${id}, icon ${family?.icon ?? "?"})`);
  }
  for (const file of plan.orphaned) console.error(`orphaned  ${ASSETS_LABEL}/${file} (no family references it)`);

  if (plan.missing.length > 0 || plan.orphaned.length > 0) {
    console.error(
      `${ASSETS_LABEL}: ${plan.missing.length} missing, ${plan.orphaned.length} orphaned — run: bun infra/fetch-model-logos.ts`,
    );
    return 1;
  }
  console.log(`${ASSETS_LABEL}: ${plan.unchanged.length} assets present, no orphans`);
  return 0;
}

async function sync(lineup: ModelLineup): Promise<number> {
  const gz = await fetchTarball(lineup.icons);
  const entries = readTar(new Uint8Array(Bun.gunzipSync(gz)));
  const icons = selectIcons(lineup, entries);

  const wanted = new Map<string, Uint8Array | null>(icons.map((i) => [i.familyId, i.svg]));
  const byFamily = new Map(icons.map((i) => [i.familyId, i]));

  const present = new Map<string, Uint8Array | null>();
  for (const file of presentFiles(ASSETS)) present.set(file, new Uint8Array(await Bun.file(join(ASSETS, file)).arrayBuffer()));
  const plan = planAssets(wanted, present);

  mkdirSync(ASSETS, { recursive: true });
  for (const id of [...plan.missing, ...plan.stale].sort()) {
    const icon = byFamily.get(id)!;
    await Bun.write(join(ASSETS, assetFile(id)), icon.svg);
    console.log(`written   ${assetFile(id)} (${icon.slug}, ${icon.svg.length} bytes)`);
  }
  for (const id of plan.unchanged) console.log(`unchanged ${assetFile(id)} (${byFamily.get(id)!.slug})`);
  for (const file of plan.orphaned) {
    rmSync(join(ASSETS, file));
    console.log(`pruned    ${file} (no family references it)`);
  }

  const written = plan.missing.length + plan.stale.length;
  console.log(
    `${ASSETS_LABEL}: ${icons.length} icons from ${entries.length} tarball entries — ${written} written, ${plan.unchanged.length} unchanged, ${plan.orphaned.length} pruned`,
  );
  return 0;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const unknown = argv.filter((a) => a !== "--check");
  if (unknown.length > 0) throw new Error(`unknown argument ${unknown[0]} (only --check)`);
  const lineup = parseLineup(await Bun.file(LINEUP).text(), "infra/model-lineup.json");
  return argv.includes("--check") ? check(lineup) : sync(lineup);
}

if (import.meta.main) process.exit(await main());
