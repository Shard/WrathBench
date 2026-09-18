/**
 * How the runner opens the reference bundle.
 *
 * One seam for every entry point (run.ts, mcp.ts) so the schema check is
 * enforced in exactly one place. Opening the sqlite file directly — which both
 * entry points used to do — bypasses `openBundle`'s guard: a bundle built
 * before the coordinate channel has no `page_coords` table, `searchReference`
 * treats that as "no coords", and every episode silently searches without the
 * channel while nothing anywhere says so.
 *
 * Two outcomes, deliberately different:
 *   - bundle file absent  -> `undefined`. `search_reference` reports itself
 *     unavailable; a run with no reference is a supported configuration.
 *   - bundle present but too old -> throw. A stale bundle is a deploy mistake,
 *     not a configuration, and it is invisible from inside a trajectory.
 */

import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { openBundle } from "@wrathbench/wiki/search";

/**
 * Open the reference bundle read-only, or `undefined` when there is no file at
 * `path`. Throws when the file exists but predates the schema this harness
 * expects: the message carries the underlying complaint plus the build-beside
 * and swap-in commands, because an operator who trips this mid-window needs the
 * rename, not a 24 GB re-read.
 */
export function openWikiBundle(path: string): Database | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return openBundle(path);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    throw new Error(
      `${why}\n` +
        `The bundle is too old for this harness and search would silently lose the ` +
        `coordinate channel, so the run stops here. Build a fresh one beside it and swap:\n` +
        `  bun wiki/src/build.ts data/wiki/<dump>.7z --out ${path}.next\n` +
        `  ln ${path} ${path}.bak-$(date +%Y%m%d-%H%M) && mv -f ${path}.next ${path}`,
    );
  }
}

/**
 * The bundle's own identity, read from its `meta` table (wiki/src/bundle.ts).
 *
 * A run records the bundle *path* in its config, which says nothing about what
 * was in the file: the same path holds a different reference surface after
 * every rebuild, and a rebuild that changes page text changes what a model
 * could read. This record is the evidence, annotated onto the comparability
 * tuple (docs/METHODOLOGY.md, "Episodes, lanes, and evidence").
 *
 * Everything is nullable on purpose. `era_cutoff` is written only by bundles
 * built with an era cutoff, `schema_version` is TEXT in the bundle and stays a
 * string here, and a bundle whose meta table is empty (or absent) reads as all
 * nulls rather than as an error: this is annotation, and it never fails closed.
 */
export interface WikiBundleMeta {
  /** `schema_version` as written — a string, never parsed into a number. */
  schemaVersion: string | null;
  /** ISO timestamp of the build. Moves on every rebuild, even of one dump. */
  builtAt: string | null;
  /** The dump file's basename. */
  source: string | null;
  /**
   * The era cutoff the prose was taken at, when the build applied one: only
   * bundles built after the cutoff channel exists write this key, and an older
   * bundle reads `null` — never back-labelled as "no cutoff was applied".
   */
  eraCutoff: string | null;
}

/**
 * Read `meta` off an open bundle. `null` when there is no bundle, and all-null
 * fields when the table is empty or unreadable — a run with no reference is a
 * supported configuration, and a bundle that cannot describe itself must not
 * take a launch down with it.
 */
export function wikiBundleMeta(db: Database | undefined): WikiBundleMeta | null {
  if (db === undefined) return null;
  let rows: { key: string; value: string }[] = [];
  try {
    rows = db.query<{ key: string; value: string }, []>("SELECT key, value FROM meta").all();
  } catch {
    rows = [];
  }
  const at = (key: string): string | null => {
    const row = rows.find((r) => r.key === key);
    return typeof row?.value === "string" ? row.value : null;
  };
  return {
    schemaVersion: at("schema_version"),
    builtAt: at("built_at"),
    source: at("source"),
    eraCutoff: at("era_cutoff"),
  };
}
