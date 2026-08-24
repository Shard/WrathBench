#!/usr/bin/env bun
/**
 * The pre-swap gate: check a built bundle describes *this* world before it
 * replaces the deployed one.
 *
 *   bun wiki/src/verify.ts [--db data/wiki/bundle.sqlite]
 *
 * The build's own canary (`canary.ts`) asks the cheap question — are the
 * capitals and the starting zones here at all — and refuses to rename a bundle
 * that fails it. This asks the expensive ones, on a bundle that is already
 * written:
 *
 * - **MUST_EXIST**: the canary list, again, so the gate is meaningful when it is
 *   run against a bundle someone built elsewhere or with `--no-canary`.
 * - **MUST_NOT_EXIST**: titles that are Cataclysm-or-later coinages, so a page
 *   under that name is proof the era rules let a later world through. Every
 *   entry was checked against the dump: a name that also existed pre-2010 as
 *   lore — Mount Hyjal, Tol Barad, Grim Batol, Kul Tiras, Zandalar, Worgen,
 *   Goblin, Gilneas City, Uldum, Pandaria and a dozen more — is **not** here,
 *   because its presence proves nothing and a gate that cries wolf is a gate
 *   that gets skipped.
 * - **Phrase pairs**: a phrase that must not appear on a named page (the
 *   Cataclysm rewrite of a zone that still stands in 3.3.5) and one that must.
 *   Each pair was checked against the dump's own pre-cutoff revisions, which is
 *   the only way to tell a real assertion from a guess: the pairs the wiki's
 *   2010 editors had already broken — the Barrens already naming its Cataclysm
 *   halves in 2010, for one — are deliberately absent from this list.
 *
 * Exit code 0 when everything holds, 1 with a report of the failures otherwise.
 * Nothing here reads the server, the dump, or anything but the bundle.
 */

import { Database } from "bun:sqlite";
import { DEFAULT_BUNDLE_PATH } from "./bundle";
import { MUST_EXIST, resolveCanary } from "./canary";

/**
 * Titles that are Cataclysm-or-later coinages: no page of this world can carry
 * one. Verified absent from a bundle built at the 2010-10-12 cutoff, and
 * verified to be names the wiki did not use before the expansion that coined
 * them.
 */
export const MUST_NOT_EXIST: readonly string[] = [
  // Cataclysm split or renamed these; the pre-Cataclysm names are in MUST_EXIST.
  "Northern Barrens",
  "Ruins of Gilneas",
  // Cataclysm zones with no pre-2010 lore page under this name.
  "Kelp'thar Forest",
  "Abyssal Depths",
  "Shimmering Expanse",
  "Molten Front",
  // Cataclysm raids and dungeons, under the exact name the expansion gave them.
  "Throne of the Four Winds",
  "The Bastion of Twilight",
  "The Vortex Pinnacle",
  "End Time",
  "Hour of Twilight",
  // Later expansions still.
  "The Jade Forest",
  "Broken Isles",
  // Patch pages for client patches this world never saw. `classifyMetaPage`
  // drops all of them as out-of-game, so these also check that rule is running.
  "Patch 4.0.1",
  "Patch 4.3.0",
  "Patch 5.0.4",
  "Patch 6.0.2",
  "Patch 7.0.3",
  "Patch 8.0.1",
];

/**
 * `[title, phrase]`: the phrase must **not** appear in the page's text.
 *
 * These are the Cataclysm rewrites of places that are standing in 3.3.5 — the
 * flooded Thousand Needles, the burned Camp Taurajo, the goblin Azshara. A hit
 * means the bundle took its prose from after the world changed.
 */
export const FORBIDDEN_PHRASES: readonly (readonly [string, string])[] = [
  ["Thousand Needles", "flooded"],
  ["Thousand Needles", "Speedbarge"],
  ["Auberdine", "Ruins of Auberdine"],
  ["Camp Taurajo", "burned"],
  ["Azshara", "Bilgewater"],
  ["Stormwind City", "Cataclysm"],
  ["Stormwind City", "Deathwing"],
  ["Darkshore", "Maelstrom"],
  ["Un'Goro Crater", "Cataclysm"],
  ["Winterspring", "Cataclysm"],
  ["Duskwood", "Cataclysm"],
  ["Redridge Mountains", "Cataclysm"],
  ["Ashenvale", "Cataclysm"],
  ["Silverpine Forest", "Forsaken High Command"],
  ["Kul Tiras", "Cataclysm"],
  ["Zandalar", "Cataclysm"],
  ["Goblin", "playable race"],
  ["Grim Batol", "Twilight's Hammer"],
];

/**
 * `[title, phrase]`: the phrase must appear in the page's text.
 *
 * Each one names something Cataclysm removed, renamed or drowned, so a page
 * that has lost it is a page from the wrong decade.
 */
export const REQUIRED_PHRASES: readonly (readonly [string, string])[] = [
  ["Thousand Needles", "Shimmering Flats"],
  ["The Barrens", "Crossroads"],
  ["Dun Morogh", "Coldridge Valley"],
  ["Loch Modan", "Stonewrought Dam"],
  ["Auberdine", "Darkshore"],
  ["Southshore", "Hillsbrad"],
  ["Stranglethorn Vale", "Booty Bay"],
  ["Desolace", "Kodo"],
  ["Winterspring", "Everlook"],
  ["Westfall", "Sentinel Hill"],
];

interface Failure {
  check: string;
  detail: string;
}

/** The text of the page a title resolves to, or null when there is no page. */
function pageText(db: Database, title: string): string | null {
  const landed = resolveCanary(db, title);
  if (landed === null) return null;
  const row = db
    .query<{ text: string }, [string]>("SELECT text FROM pages WHERE ns = 0 AND title = ? LIMIT 1")
    .get(landed);
  return row === null ? null : row.text;
}

/** Every check, run against an open bundle. */
export function verifyBundle(db: Database): Failure[] {
  const failures: Failure[] = [];

  for (const title of MUST_EXIST) {
    if (resolveCanary(db, title) === null) {
      failures.push({ check: "must exist", detail: `${title} — no page and no redirect` });
    }
  }

  for (const title of MUST_NOT_EXIST) {
    const landed = resolveCanary(db, title);
    if (landed !== null) {
      failures.push({
        check: "must not exist",
        detail: `${title} — resolves to "${landed}", a later world's page`,
      });
    }
  }

  for (const [title, phrase] of FORBIDDEN_PHRASES) {
    const text = pageText(db, title);
    if (text === null) {
      failures.push({ check: "forbidden phrase", detail: `${title} — page missing` });
    } else if (text.toLowerCase().includes(phrase.toLowerCase())) {
      failures.push({
        check: "forbidden phrase",
        detail: `${title} — says "${phrase}", which is the world after this one`,
      });
    }
  }

  for (const [title, phrase] of REQUIRED_PHRASES) {
    const text = pageText(db, title);
    if (text === null) {
      failures.push({ check: "required phrase", detail: `${title} — page missing` });
    } else if (!text.toLowerCase().includes(phrase.toLowerCase())) {
      failures.push({
        check: "required phrase",
        detail: `${title} — does not say "${phrase}", which this world has`,
      });
    }
  }

  return failures;
}

function main(): void {
  let path = DEFAULT_BUNDLE_PATH;
  const argv = Bun.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--db") path = argv[++i] ?? path;
    else throw new Error(`unknown flag ${arg}\nusage: bun wiki/src/verify.ts [--db path]`);
  }

  const db = new Database(path, { readonly: true });
  const failures = verifyBundle(db);
  const checks =
    MUST_EXIST.length + MUST_NOT_EXIST.length + FORBIDDEN_PHRASES.length + REQUIRED_PHRASES.length;
  db.close();

  console.log(`verifying ${path}: ${checks} checks`);
  if (failures.length === 0) {
    console.log(`ok — ${MUST_EXIST.length} required pages, ${MUST_NOT_EXIST.length} forbidden ` +
      `titles, ${FORBIDDEN_PHRASES.length} forbidden and ${REQUIRED_PHRASES.length} required phrases`);
    return;
  }
  console.log("");
  for (const f of failures) console.log(`  [${f.check}] ${f.detail}`);
  console.log("");
  console.log(`${failures.length} of ${checks} checks failed — do not swap this bundle in`);
  process.exit(1);
}

if (import.meta.main) {
  try {
    main();
  } catch (err: unknown) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
