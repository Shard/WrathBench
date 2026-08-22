/**
 * How the runner opens the reference bundle.
 *
 * One seam for every entry point (run.ts, mcp.ts) so the schema check is
 * enforced in exactly one place. Opening the sqlite file directly — which both
 * entry points used to do — bypasses `openBundle`'s guard: a bundle built
 * before the coordinate channel has no `page_coords` table, `searchReference`
 * treats that as "no coords", and every episode silently searches without the
 * channel while nothing anywhere says so (FOLLOW-UPS 30).
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
