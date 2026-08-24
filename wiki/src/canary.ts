/**
 * The pre-swap canary: pages this world's wiki cannot be missing.
 *
 * The era rules drop tens of thousands of pages by deterministic signal, and a
 * signal that is one word too broad drops a capital city. That is exactly what
 * happened once (FOLLOW-UPS 49): a `|patch=4.0.1` added to Stormwind City in
 * 2010 read as "this page is about Cataclysm", and the build cheerfully
 * produced a bundle of this world with no Stormwind, no Durotar and no Barrens
 * — and said nothing, because every counter added up. Counters cannot see an
 * over-broad rule; a fixed list of titles can.
 *
 * So the build ends with this: a small list of pages that a patch-3.3.5a
 * reference must contain, checked against the finished bundle before it is
 * renamed into place. A missing one fails the build and leaves the previous
 * bundle where it is.
 *
 * The list is deliberately titles only — the ten capitals, the eight racial
 * starting zones, and the classic/TBC/Wrath zones Cataclysm reshaped hardest,
 * which are the ones an over-broad era rule reaches first. No page text is
 * asserted here and none is quoted: `wiki/src/verify.ts` is where the deeper,
 * operator-run content checks live. Nothing in this file is game text beyond
 * the place names, which are the same names FOLLOW-UPS and the docs already
 * use.
 */

import type { Database } from "bun:sqlite";

/**
 * Titles that must resolve to a page in ns 0, directly or through a redirect.
 *
 * Every entry was checked against the dump's own title list before it was
 * added; a canary that is not true of the source is a build that fails for the
 * wrong reason. Redirect resolution is part of the check because the wiki
 * settled some of these under another name (`The Exodar` → `Exodar`).
 */
export const MUST_EXIST: readonly string[] = [
  // The ten capitals.
  "Stormwind City",
  "Ironforge",
  "Darnassus",
  "The Exodar",
  "Orgrimmar",
  "Undercity",
  "Thunder Bluff",
  "Silvermoon City",
  "Shattrath City",
  "Dalaran",
  // The eight racial starting zones.
  "Elwynn Forest",
  "Dun Morogh",
  "Teldrassil",
  "Azuremyst Isle",
  "Durotar",
  "Mulgore",
  "Tirisfal Glades",
  "Eversong Woods",
  // The starting valleys inside two of them, rewritten wholesale by Cataclysm.
  "Northshire Valley",
  "Coldridge Valley",
  // Classic and TBC zones Cataclysm reshaped, renamed or destroyed. These are
  // the pages an over-broad era rule reaches first, because they are the ones
  // whose 2010 editors annotated what was coming.
  "The Barrens",
  "Thousand Needles",
  "Shimmering Flats",
  "Auberdine",
  "Southshore",
  "Camp Taurajo",
  "Loch Modan",
  "Azshara",
  "Stonetalon Mountains",
  "Desolace",
  "Darkshore",
  "Badlands",
  "Stranglethorn Vale",
  "Dustwallow Marsh",
  "Wetlands",
  "Westfall",
  // A Wetlands location in this world, an instance only in the next one.
  "Grim Batol",
  // Wrath zones: the world the server actually runs.
  "Borean Tundra",
  "Howling Fjord",
  "Dragonblight",
  "Icecrown",
];

/** How many redirect hops a canary follows; the build's own bound. */
const MAX_HOPS = 6;

/**
 * Does `title` resolve to a ns-0 page, following redirects? Returns the page
 * title it landed on, or null.
 *
 * Deliberately a few lines rather than a call into `search.ts`: the gate should
 * not depend on the ranking layer it is meant to protect, and matching is exact
 * on purpose — a canary that falls back to full-text would pass on a bundle
 * that merely mentions Stormwind somewhere.
 */
export function resolveCanary(db: Database, title: string): string | null {
  const page = db.query<{ title: string }, [string]>(
    "SELECT title FROM pages WHERE ns = 0 AND title = ? LIMIT 1",
  );
  const redirect = db.query<{ target: string }, [string]>(
    "SELECT target FROM redirects WHERE ns = 0 AND source = ? LIMIT 1",
  );
  let current = title;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const hit = page.get(current);
    if (hit !== null) return hit.title;
    const next = redirect.get(current);
    if (next === null) return null;
    current = next.target;
  }
  return null;
}

/** Canary titles that do not resolve in this bundle. */
export function missingCanaries(db: Database): string[] {
  return MUST_EXIST.filter((title) => resolveCanary(db, title) === null);
}

/**
 * Fail the build when a canary is missing, naming every one of them.
 *
 * Called after the indexes and `meta` are written and before the temp file is
 * renamed into place, so a bundle that fails here never replaces a good one.
 */
export function assertCanaries(db: Database): void {
  const missing = missingCanaries(db);
  if (missing.length === 0) return;
  throw new Error(
    `canary failed: ${missing.length} of ${MUST_EXIST.length} required pages are not in the bundle. ` +
      `The era rules are dropping this world's own pages. Missing: ${missing.join(", ")}`,
  );
}
