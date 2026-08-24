/**
 * Whether a whole page belongs in a Wrath bundle.
 *
 * The bundle is a concise patch-3.3.5a reference. Nothing in it is labelled by
 * era, because nothing that is not 3.3.5 is in it. The revision cutoff does
 * most of the work — a page with no revision before 2010-10-12 is a page about
 * a world this server does not run — and this module does the rest: the pages
 * that were written before the cutoff *about* what was coming, which the census
 * of 2026-08-24 counted at 444 one-paragraph beta stubs for Cataclysm zones and
 * NPCs.
 *
 * The signals are read on the revision the prose comes from, and one more thing
 * about the page: a page that existed before the Cataclysm beta is a Wrath page
 * and a signal never drops it (see `CATACLYSM_BETA_START`). Stormwind City is
 * the example — it acquired `|patch=4.0.1` in 2010 and the city is standing.
 *
 * `admitPage` is the one page-level decision, a pure function of the title, the
 * two revisions the parser holds and the page's creation date. It is deliberately the only door: an
 * admission rule the evidence does not support today (see
 * `post_cutoff_wrath_signal` below, and ADR-0040 on the server-side id
 * cross-check that is not implemented) is added here, not in the parser or the
 * build loop.
 *
 * Every rule is deterministic over raw wikitext and the title. Nothing reads
 * the server DB, the DBC tables or anything outside the dump (CONTRACTS.md).
 */

import { classifyMetaPage } from "./meta-pages";

/**
 * Why a page is in the bundle, or is not. Each value is a `meta` counter on the
 * built bundle, and the five of them plus `empty_pages` account for every
 * non-redirect page the parser yielded.
 */
export type AdmitReason =
  /**
   * Has pre-cutoff prose and either no post-Wrath signal or the pre-beta
   * protection (`CATACLYSM_BETA_START`). The prose is that revision.
   */
  | "pre_cutoff"
  /**
   * No pre-cutoff revision, but the newest revision carries an explicit
   * Wrath-or-earlier signal and no post-Wrath or Classic-2019 one: the page was
   * written late about something that is in this world. The prose is the newest
   * revision, because it is the only one there is.
   */
  | "post_cutoff_wrath_signal"
  /**
   * No pre-cutoff prose, and the newest revision does not say outright that it
   * is Wrath content. Whether or not it carries a post-Wrath signal: this
   * world's wiki simply does not have the page.
   */
  | "dropped_post_cutoff"
  /**
   * The page has pre-cutoff prose that names a later expansion in its title,
   * categories, banners or infobox, and the page was created after the
   * Cataclysm beta started: a beta stub, written before the cutoff about what
   * was coming.
   */
  | "dropped_post_wrath"
  /** Out-of-game reference: patch notes, addon/UI docs, a boxed product, a real-world topic. */
  | "dropped_meta";

export interface AdmitInput {
  title: string;
  /**
   * The newest revision saved before the era cutoff that passed the parser's
   * hygiene rules, or null when the page has none.
   */
  eraWikitext: string | null;
  /** The newest revision, which is what the structured extractors read. */
  newestWikitext: string;
  /**
   * Timestamp of the page's oldest revision, ISO 8601, or "" when the dump
   * states none. A page created before `CATACLYSM_BETA_START` existed in the
   * Wrath world and is protected from the post-Wrath signals; see below.
   */
  firstRevisionAt: string;
}

export interface AdmitDecision {
  admit: boolean;
  reason: AdmitReason;
  /**
   * True when the page carried a post-Wrath signal and was kept anyway, because
   * it predates the Cataclysm beta. A tag on a subset of `pre_cutoff`, not a
   * sixth bucket: it is counted separately and is not part of the accounting
   * identity.
   */
  preBetaProtected?: boolean;
}

/**
 * Page banner templates that say the page is about a later expansion.
 *
 * Named literally rather than pattern-matched, because the expansion word alone
 * is not a signal. `{{Removedwithlegion}}` and `{{Removedwithcataclysm}}` say
 * the subject was removed *later*, so it exists in 3.3.5 and the page stays.
 * `{{legion-inline}}` (278 uses in the census, the third most common template
 * on late pages) marks one clause, not the page. `{{Legion-section}}` marks a
 * section, which `wrath-only.ts` drops on its own.
 */
const POST_WRATH_TEMPLATES = new Set([
  "cataclysm",
  "cata",
  "cata-stub",
  "stub/cataclysm",
  "cataclysm-article",
  "cataclysm/update",
  "legion-article",
  "stub/legion",
  "legion/update",
  "legiondalaran",
  "draenorzone",
  "warlords of draenor",
  "wod",
  "pandaria",
  "mists of pandaria",
  "mop",
  "battle for azeroth",
  "bfa",
  "shadowlands",
]);

/** `(Cataclysm)`, `(Legion)` and friends as a title's disambiguation parenthetical. */
const TITLE_PARENTHETICAL =
  /\((cataclysm|mists of pandaria|legion|warlords of draenor|battle for azeroth|shadowlands)\)(\/|$| )/i;

/**
 * Category names that place the page in a later expansion.
 *
 * Substring for the multi-word expansion names, which cannot mean anything else
 * in 3.3.5. Not bare `Draenor`: Draenor is Outland's own name and predates this
 * server by two expansions, so only `Warlords of Draenor` counts. `Legion` is
 * the sharp one and is handled separately (see `categoryIsPostWrath`).
 */
const POST_WRATH_CATEGORY_SUBSTRINGS = [
  "cataclysm",
  "mists of pandaria",
  "pandaria",
  "warlords of draenor",
  "battle for azeroth",
  "shadowlands",
];

/**
 * `Legion` as an expansion, not as the Burning Legion.
 *
 * The census's own tally is the counterexample: of the category names on late
 * pages, `Burning Legion` appears 39 times against `Legion`'s 29 and
 * `Legion stubs`' 10. A `contains Legion` rule would take every Burning Legion
 * page in the bundle with it, and the Burning Legion is in this world. So:
 * exactly `Legion`, or starting `Legion ` — which keeps `Legion stubs` and
 * rejects `Burning Legion`, `7th Legion` and `Legion's Bane` (an apostrophe,
 * not a space). The residue this accepts is a category that opens with the word
 * and means the army — `Legion of the Damned` would fire — and the census finds
 * no such category name in the dump. `ends with Legion` was tried and dropped:
 * `Burning Legion` matches it, and the list of words that may precede it is
 * unbounded.
 */
function legionCategoryIsExpansion(name: string): boolean {
  return name === "legion" || name.startsWith("legion ");
}

/** `[[Category:Foo]]` names on a page, lower-cased, sort key stripped. */
function categoryNames(wikitext: string): string[] {
  const out: string[] = [];
  const re = /\[\[\s*category\s*:\s*([^\]|#]+)/gi;
  for (let m = re.exec(wikitext); m !== null; m = re.exec(wikitext)) {
    const name = (m[1] ?? "").replace(/_/g, " ").trim().toLowerCase();
    if (name.length > 0) out.push(name);
  }
  return out;
}

function categoryIsPostWrath(name: string): boolean {
  if (POST_WRATH_CATEGORY_SUBSTRINGS.some((s) => name.includes(s))) return true;
  return legionCategoryIsExpansion(name);
}

/** `{{Foo|…}}` / `{{Foo}}` template names on a page, lower-cased. */
function templateNames(wikitext: string): string[] {
  const out: string[] = [];
  const re = /\{\{\s*([^|{}\n]{1,60}?)\s*(?:\||\}\})/g;
  for (let m = re.exec(wikitext); m !== null; m = re.exec(wikitext)) {
    const name = (m[1] ?? "").replace(/_/g, " ").trim().toLowerCase();
    if (name.length > 0) out.push(name);
  }
  return out;
}

/** Infobox `|field = value` pairs, lower-cased field names. */
function infoboxFields(wikitext: string, field: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`\\|\\s*${field}\\s*=\\s*([^|}\\n]{1,60})`, "gi");
  for (let m = re.exec(wikitext); m !== null; m = re.exec(wikitext)) {
    const value = (m[1] ?? "").trim().toLowerCase();
    if (value.length > 0) out.push(value);
  }
  return out;
}

/** The `major.minor` of a patch string, or null when it does not state one. */
function patchNumber(value: string): number | null {
  const m = /(\d+)\.(\d+)/.exec(value);
  if (m === null) return null;
  return Number.parseInt(m[1]!, 10) + Number.parseInt(m[2]!, 10) / 100;
}

/** Patch 4.0 is Cataclysm's client patch; this world's is 3.3.5. */
const FIRST_POST_WRATH_PATCH = 4.0;

const POST_WRATH_EXPANSION_VALUES = [
  "cataclysm",
  "mists of pandaria",
  "mop",
  "warlords of draenor",
  "wod",
  "legion",
  "battle for azeroth",
  "bfa",
  "shadowlands",
];

const WRATH_OR_EARLIER_EXPANSION_VALUES = [
  "wrath of the lich king",
  "wrath",
  "wotlk",
  "the burning crusade",
  "burning crusade",
  "tbc",
  "bc",
  "classic",
  "vanilla",
  "world of warcraft",
];

/** Category names that are an explicit Wrath-or-earlier statement about the page. */
const WRATH_OR_EARLIER_CATEGORIES = new Set([
  "wrath of the lich king",
  "the burning crusade",
  "burning crusade",
  "world of warcraft",
]);

/**
 * Does this wikitext say, anywhere, that its subject belongs to a later
 * expansion? Read on the revision whose prose the bundle would index, never on
 * a later one: a Wrath zone that Cataclysm changed had its Cataclysm category
 * added in 2011, and dropping the page for that would delete a zone that is
 * standing in this world.
 */
export function hasPostWrathSignal(title: string, wikitext: string): boolean {
  if (TITLE_PARENTHETICAL.test(title)) return true;
  for (const name of categoryNames(wikitext)) {
    if (categoryIsPostWrath(name)) return true;
  }
  for (const name of templateNames(wikitext)) {
    if (POST_WRATH_TEMPLATES.has(name)) return true;
  }
  for (const value of infoboxFields(wikitext, "patch")) {
    const n = patchNumber(value);
    if (n !== null && n >= FIRST_POST_WRATH_PATCH) return true;
  }
  for (const value of infoboxFields(wikitext, "expansion")) {
    if (POST_WRATH_EXPANSION_VALUES.some((v) => value === v || value.startsWith(`${v} `))) return true;
  }
  return false;
}

/**
 * Does this wikitext say, explicitly, that its subject is Wrath-or-earlier
 * content? This is what admits a page created after the cutoff: the wiki kept
 * documenting the old world for a decade, and such a page is right about this
 * one. The evidence has to be explicit — an infobox patch or expansion field,
 * or one of four category names — because the alternative is admitting 18,717
 * pages the census could classify neither way.
 */
export function hasWrathSignal(wikitext: string): boolean {
  for (const value of infoboxFields(wikitext, "patch")) {
    const n = patchNumber(value);
    if (n !== null && n < FIRST_POST_WRATH_PATCH) return true;
  }
  for (const value of infoboxFields(wikitext, "expansion")) {
    if (WRATH_OR_EARLIER_EXPANSION_VALUES.some((v) => value === v)) return true;
  }
  for (const name of categoryNames(wikitext)) {
    if (WRATH_OR_EARLIER_CATEGORIES.has(name)) return true;
  }
  return false;
}

/**
 * WoW Classic (2019) is a re-release, not this world: its patches are 1.13 and
 * 1.14, and its realm/patch pages read as vanilla content to every rule above.
 * The census's own "Wrath-or-earlier, no post signal" bucket is half Classic
 * pages (`Patch 1.13.0`, `Classic realms`, `Category:World of Warcraft: Classic
 * patches`), which is why this veto exists.
 */
export function hasClassic2019Signal(title: string, wikitext: string): boolean {
  if (/\bclassic\b/i.test(title) || /\bpatch 1\.1[34]\b/i.test(title)) return true;
  for (const name of categoryNames(wikitext)) {
    if (name.includes("classic") || /patch 1\.1[34]/.test(name)) return true;
  }
  return false;
}

/**
 * The Cataclysm beta ramp on the wiki, and the line that separates a page
 * *about* the coming expansion from a page that merely *acquired* it.
 *
 * The signals below are read on the revision the prose comes from, but a Wrath
 * page edited in 2010 can carry them honestly: Stormwind City picked up
 * `|patch=4.0.1` and a `[[Category:Cataclysm]]` in its own pre-cutoff history,
 * and the city is standing in this world. The census of 2026-08-24 found 588
 * such pages — capitals, starting zones, the zones Cataclysm reshaped — against
 * 4,859 genuine beta stubs, a mid-2010 bot import that created its pages from
 * scratch. What separates the two is not the wikitext, it is the page's age: a
 * page that existed before the beta documented this world first.
 *
 * So: **a page whose first revision predates 2010-06-01 is a Wrath page**, and
 * a post-Wrath signal never drops it. The section and paragraph rules in
 * `wrath-only.ts` still strip what they strip, so the Cataclysm paragraph that
 * arrived with the category still goes; the page stays. A page created on or
 * after that date with a signal is dropped as before.
 *
 * The date is the deterministic proxy available in the dump — creation date,
 * not content — and it is deliberately loose: the beta ramp is mid-2010, well
 * before the 2010-10-12 era cutoff, so protection can only ever apply to a page
 * that also has pre-cutoff prose. (An `--era-cutoff` set earlier than this
 * would invert that; nothing in the build depends on it.)
 */
export const CATACLYSM_BETA_START = "2010-06-01T00:00:00Z";

/** True when the page existed before the Cataclysm beta, so it is a Wrath page. */
export function isPreBetaPage(firstRevisionAt: string): boolean {
  return firstRevisionAt !== "" && firstRevisionAt < CATACLYSM_BETA_START;
}

/**
 * The one page-level admission decision.
 *
 * Order matters and is: out-of-game first (a hotfix archive is out whatever era
 * it names), then the post-Wrath signal (a Cataclysm beta stub written in
 * September 2010 has a pre-cutoff revision and is still not this world) —
 * unless the page predates the Cataclysm beta, which makes it a Wrath page
 * whatever it later acquired — then the cutoff, then the explicit-Wrath-signal
 * admission for late pages.
 *
 * A page with no pre-cutoff prose is `dropped_post_cutoff` whether or not it
 * carries a post-Wrath signal: the signal is why it is *also* not admitted by
 * the Wrath-signal rule, but the reason it is not in the bundle is that this
 * world's wiki does not have the page.
 */
export function admitPage(page: AdmitInput): AdmitDecision {
  if (classifyMetaPage(page.title) !== null) return { admit: false, reason: "dropped_meta" };

  if (page.eraWikitext === null) {
    // No prose from before the cutoff. The only door is an explicit
    // Wrath-or-earlier statement on the one revision there is, with the
    // Classic-2019 veto and the post-Wrath veto both still standing.
    if (
      hasWrathSignal(page.newestWikitext) &&
      !hasClassic2019Signal(page.title, page.newestWikitext) &&
      !hasPostWrathSignal(page.title, page.newestWikitext)
    ) {
      return { admit: true, reason: "post_cutoff_wrath_signal" };
    }
    return { admit: false, reason: "dropped_post_cutoff" };
  }

  if (hasPostWrathSignal(page.title, page.eraWikitext)) {
    if (!isPreBetaPage(page.firstRevisionAt)) {
      return { admit: false, reason: "dropped_post_wrath" };
    }
    return { admit: true, reason: "pre_cutoff", preBetaProtected: true };
  }

  return { admit: true, reason: "pre_cutoff" };
}
