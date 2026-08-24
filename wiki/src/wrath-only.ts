/**
 * Cutting a page down to what a character here can act on: sections and
 * paragraphs.
 *
 * This world is Wrath of the Lich King. The dump is from 2020, four expansions
 * later, and even the pre-cutoff revision the prose is taken from can carry a
 * section about what was coming — the wiki wrote about announced expansions
 * before they shipped. `post-wrath.ts` decides whether a whole page belongs in
 * the bundle at all; this module cuts the parts of a surviving page that do
 * not.
 *
 * A nav-probe run read one of those paragraphs, concluded that a starter-zone
 * pass was collapsed and that the only way out of the valley was a gyrocopter
 * quest, and spent the rest of its session chasing a quest chain that does not
 * exist in 3.3.5 (night-report 2026-08-23 §4, run
 * `fleet-nav-probe-sonnet-20260822-c3`). The tunnel is there in this world; the
 * collapse is Cataclysm's.
 *
 * The bundle is a concise Wrath reference. Content that is not 3.3.5 is
 * removed, not labelled: a label costs the model a paragraph of reading and
 * still leaves the wrong world in the snippet window. Removal is deterministic,
 * counted in `meta`, and reversible by rebuilding — which is the reversibility
 * that matters (ADR-0040).
 *
 * The same file also holds the second reason a section is cut: not that it is
 * about a later world, but that it is not about the world at all. A character
 * driving through Azeroth cannot act on an external link, a patch-note list, a
 * gallery or a lore essay, and the census says those are most of the bundle's
 * bulk — `External links` alone is 66,140 pages and 14% of raw bytes. The
 * `OUT_OF_WORLD_SECTION` set names them by heading and the same walker drops
 * them, counted separately from the era cut (ADR-0040).
 *
 * Three levels here, all running on the RAW wikitext before the strip, because
 * the strip destroys the templates and headings that identify a section:
 *
 * - Section: `{{cata-section}}` under an `== Cataclysm ==` heading, or an
 *   `== In Mists of Pandaria ==` heading on its own, or a heading in the
 *   out-of-world drop set. The heading and everything under it, down to the
 *   next heading of the same or a shallower level, goes.
 * - Paragraph: prose that names a later expansion in the future or past tense
 *   inside an otherwise Wrath-era section. Phrase rules, deliberately narrow;
 *   see `POST_WRATH_PARAGRAPH` for what each one is for and what it must not
 *   catch.
 * - Empty section: what the two cuts above and the strip leave behind. A
 *   heading whose subtree carries no prose is not emitted, so a page never
 *   grows an orphan heading line where a table or a link list used to be.
 *
 * Pre-Wrath eras (`{{bc-section}}`, `== The Burning Crusade ==`) are untouched:
 * that content is in this world. So is `{{Removedwithcataclysm}}` and its
 * family — something removed *later* exists in 3.3.5 — and the template goes
 * the way every other template goes, with no note in its place.
 *
 * Deterministic, never throws, no network.
 */

import { stripWikitext } from "./strip";

/**
 * The revision cutoff the bundle is taken at: patch 4.0.1, the client patch
 * that shipped the Cataclysm world change. A revision saved before this instant
 * describes a world at most one patch away from 3.3.5a; the first revision
 * after it may describe a continent that was rearranged.
 *
 * 4.0.1 rather than 3.3.5's own release: a page edited between them is still
 * describing the Wrath world, and holding the line at 3.3.5 costs 6.2% more
 * pages with no pre-cutoff revision at all for no gain in accuracy. 4.0.1
 * rather than the Shattering (2010-11-23) or Cataclysm's release (2010-12-07):
 * those two buy 0.2-0.3% fewer drops and let in a month of beta-informed
 * rewrites. See ADR-0040.
 */
export const DEFAULT_ERA_CUTOFF = "2010-10-12T00:00:00Z";

/** What a pass over one page's wikitext removed. */
export interface WrathOnlyResult {
  /** The wikitext with post-Wrath sections and paragraphs removed. */
  text: string;
  /** How many era sections were dropped (the heading and its body). */
  sectionsDropped: number;
  /** How many paragraphs were dropped by the phrase rules. */
  paragraphsDropped: number;
  /** How many sections were trimmed as out-of-world, including empty ones. */
  sectionsTrimmed: number;
  /**
   * The trim, by normalised heading, so a rebuild says exactly what went.
   * Sections dropped because nothing survived in them are counted under
   * `EMPTY_SECTION_KEY` rather than under a real heading name.
   */
  sectionsTrimmedBy: Record<string, number>;
}

/** Expansions after Wrath of the Lich King: their content is not in this world. */
const POST_WRATH_SECTION: { pattern: RegExp; label: string }[] = [
  { pattern: /^(cata|cataclysm)$/, label: "Cataclysm" },
  { pattern: /^(mists|mop|pandaria)$/, label: "Mists of Pandaria" },
  { pattern: /^(warlords|wod|draenor)$/, label: "Warlords of Draenor" },
  { pattern: /^(legion)$/, label: "Legion" },
  { pattern: /^(battle|bfa|azeroth)$/, label: "Battle for Azeroth" },
  { pattern: /^(shadowlands|sl)$/, label: "Shadowlands" },
];

/** Heading text that names a post-Wrath expansion, with or without a leading "in". */
const HEADING_ERA: RegExp[] = [
  /^(in\s+)?cataclysm$/i,
  /^(in\s+)?(the\s+)?shattering$/i,
  /^(in\s+)?mists of pandaria$/i,
  /^(in\s+)?warlords of draenor$/i,
  /^(in\s+)?legion$/i,
  /^(in\s+)?battle for azeroth$/i,
  /^(in\s+)?shadowlands$/i,
];

/**
 * `{{cata-section}}`, `{{Mists-section}}`, `{{legion-section}}`.
 *
 * The `-section` suffix is what makes this safe for Legion: `{{legion-inline}}`
 * and `{{Removedwithlegion}}` are not section markers and never match here.
 */
const ERA_SECTION_TEMPLATE = /\{\{\s*([A-Za-z]{2,12})-section\s*[|}]/g;

/** A wikitext heading line, with its level. */
const HEADING_LINE = /^[ \t]*(={2,6})[ \t]*(.*?)[ \t]*\1[ \t]*$/;

/**
 * Sections a character cannot act on: they are about the wiki, the franchise or
 * the patch record, not about the world the character is standing in.
 *
 * Matched on the **normalised** heading and only ever exactly — no prefix, no
 * substring. That is what keeps `changes` out of the bundle while `past changes`
 * stays, `notes and trivia` out while `notes` stays, and `patch changes` out
 * while every other `patch …` heading is untouched. There is no keep list in
 * this file on purpose: everything not named here is kept, and the headings that
 * were deliberately considered and kept are listed in `wiki/README.md`.
 *
 * Rewriting is not on the table — a section is here in full or not at all.
 */
const OUT_OF_WORLD_SECTION: ReadonlySet<string> = new Set([
  // The link farm and the citation apparatus: 14.1% of raw bytes on its own.
  "external links",
  "references",
  "see also",
  // The patch record. The world is one patch; its history is not actionable.
  "patch changes",
  "patches and hotfixes",
  "patch history",
  "patch notes",
  "changes",
  // Media, which survives the strip as a caption at best.
  "gallery",
  "videos",
  "video",
  "images",
  "media",
  // Commentary and colour.
  "trivia",
  "notes and trivia",
  "speculation",
  "quotes",
  "quote",
  "dialogue",
  "criticism",
  "reception",
  "development",
  // Story about the world rather than the state of it.
  "history",
  "background",
  "lore",
  // Other Warcraft products: not this game, not this world.
  "in the rpg",
  "rpg",
  "in the warcraft rpg",
  "in the tcg",
  "tcg",
  "in the manga",
  "in the comics",
  "in the novels",
  "in hearthstone",
  "in warcraft iii",
  "in warcraft ii",
  "in warcraft i",
  // Out-of-game client tooling. `classifyMetaPage` drops whole pages of this;
  // these are the sections of a page that is otherwise about the world.
  "addons",
  "macros",
]);

/** The breakdown key for a section dropped because nothing survived inside it. */
export const EMPTY_SECTION_KEY = "(empty)";

/**
 * A heading as the drop set sees it: link and bold markup gone, whitespace
 * collapsed, trailing punctuation and colons removed, case-folded.
 */
export function normaliseHeading(text: string): string {
  return text
    .replace(/\[\[|\]\]/g, "")
    .replace(/'{2,5}/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\s:;,.!?]+$/, "")
    .trim()
    .toLowerCase();
}

/** How far past a heading an era-section template still counts as that section's marker. */
const MARKER_WINDOW = 400;

/**
 * Paragraph-level phrase rules, applied case-insensitively to the paragraph's
 * prose (its templates removed first, so an infobox field never triggers one).
 *
 * These are narrow on purpose. A bare mention of Deathwing, the Legion, Draenor
 * or Garrosh is Wrath lore — all four are in the game in 3.3.5 — so none of
 * them is a rule on its own. What each rule is for:
 *
 * - `in Cataclysm` / `with Cataclysm` / `World of Warcraft: Cataclysm`: the
 *   wiki's own phrasing for "this changes in the next expansion".
 * - `after the Shattering`: the world change, which has not happened here.
 * - `upcoming`/`beta` in the same paragraph as Cataclysm, Deathwing or the
 *   Shattering: the beta-era stub sentence.
 * - `will` within 60 characters of `Cataclysm`: future tense about the
 *   expansion, which is exactly what a 2010 editor wrote.
 *
 * Known imprecision, measured on a 33-paragraph hand-checked sample: about 0.8
 * precision. `with Cataclysm` catches "removed with Cataclysm", which is a
 * statement about content that *is* here; the paragraph is still mostly about
 * the later world, so it goes. What the rules cannot catch at all is a
 * present-tense 2010 paragraph describing a beta zone without naming the
 * expansion (FOLLOW-UPS 62).
 */
const POST_WRATH_PARAGRAPH: { name: string; test: (prose: string) => boolean }[] = [
  { name: "in-cataclysm", test: (p) => /\bin cataclysm\b/i.test(p) },
  { name: "with-cataclysm", test: (p) => /\bwith cataclysm\b/i.test(p) },
  { name: "product-name", test: (p) => /world of warcraft:\s*cataclysm/i.test(p) },
  { name: "after-the-shattering", test: (p) => /\bafter the shattering\b/i.test(p) },
  {
    name: "beta-or-upcoming",
    test: (p) =>
      /\b(upcoming|beta)\b/i.test(p) && /\b(cataclysm|deathwing|the shattering)\b/i.test(p),
  },
  { name: "future-tense", test: (p) => nearWord(p, /\bcataclysm\b/gi, /\bwill\b/i, 60) },
];

/** True when `other` occurs within `window` characters of any `anchor` match. */
function nearWord(text: string, anchor: RegExp, other: RegExp, window: number): boolean {
  anchor.lastIndex = 0;
  for (let m = anchor.exec(text); m !== null; m = anchor.exec(text)) {
    const from = Math.max(0, m.index - window);
    const to = Math.min(text.length, m.index + m[0].length + window);
    if (other.test(text.slice(from, to))) return true;
  }
  return false;
}

/** A paragraph's prose: its template calls removed, so infobox fields do not count. */
function proseOf(paragraph: string): string {
  let s = paragraph;
  for (let i = 0; i < 4 && s.includes("{{"); i++) s = s.replace(/\{\{[^{}]*\}\}/g, " ");
  return s;
}

function sectionLabelFor(name: string): string | undefined {
  const n = name.toLowerCase();
  for (const { pattern, label } of POST_WRATH_SECTION) {
    if (pattern.test(n)) return label;
  }
  return undefined;
}

function headingIsPostWrath(text: string): boolean {
  return HEADING_ERA.some((p) => p.test(text));
}

/**
 * Remove every post-Wrath section, then every post-Wrath paragraph of what is
 * left. Sections first: a paragraph inside a dropped section is not counted
 * twice, and the phrase rules never have to see it.
 */
export function dropPostWrath(wikitext: string): WrathOnlyResult {
  if (typeof wikitext !== "string" || wikitext.length === 0) {
    return {
      text: wikitext,
      sectionsDropped: 0,
      paragraphsDropped: 0,
      sectionsTrimmed: 0,
      sectionsTrimmedBy: {},
    };
  }
  const sections = dropPostWrathSections(wikitext);
  const paragraphs = dropPostWrathParagraphs(sections.text);
  // Empty sections last: both cuts above are themselves a source of a heading
  // with nothing under it.
  const empties = dropEmptySections(paragraphs.text);
  const sectionsTrimmedBy = { ...sections.sectionsTrimmedBy };
  if (empties.sectionsTrimmed > 0) {
    sectionsTrimmedBy[EMPTY_SECTION_KEY] =
      (sectionsTrimmedBy[EMPTY_SECTION_KEY] ?? 0) + empties.sectionsTrimmed;
  }
  return {
    text: empties.text,
    sectionsDropped: sections.sectionsDropped,
    paragraphsDropped: paragraphs.paragraphsDropped,
    sectionsTrimmed: sections.sectionsTrimmed + empties.sectionsTrimmed,
    sectionsTrimmedBy,
  };
}

/**
 * Drop `== In Cataclysm ==` / `{{cata-section}}` sections and out-of-world
 * sections: in both cases the heading line and everything under it until the
 * next heading of the same or a shallower level.
 *
 * One walker, two reasons, two counters. The era check runs first, so a heading
 * that is both never increments both; a heading inside an already-dropped
 * section is not counted at all, since its section is what went.
 *
 * `opts.eraCuts: false` runs the same walker with the era half switched off, so
 * a caller can ask what the out-of-world trim alone would leave. That is the
 * question `dropOutOfWorldOnly` exists to answer; nothing else should need it.
 */
export function dropPostWrathSections(
  wikitext: string,
  opts: { eraCuts?: boolean } = {},
): {
  text: string;
  sectionsDropped: number;
  sectionsTrimmed: number;
  sectionsTrimmedBy: Record<string, number>;
} {
  const eraCuts = opts.eraCuts ?? true;
  const lines = wikitext.split("\n");
  const drop = new Array<boolean>(lines.length).fill(false);
  let current: { level: number } | undefined;
  /** A heading whose era marker may still arrive on a line just below it. */
  let pending: { level: number; index: number } | undefined;
  let sectionsDropped = 0;
  let sectionsTrimmed = 0;
  const sectionsTrimmedBy: Record<string, number> = {};

  for (let i = 0; i < lines.length; i++) {
    const heading = HEADING_LINE.exec(lines[i]!);
    if (heading !== null) {
      const level = heading[1]!.length;
      const text = heading[2] ?? "";
      if (current !== undefined && level <= current.level) current = undefined;
      pending = undefined;
      if (eraCuts && headingIsPostWrath(text.replace(/\[\[|\]\]/g, "").trim())) {
        current = { level };
        sectionsDropped++;
        drop[i] = true;
        continue;
      }
      if (current !== undefined) {
        // A sub-heading inside a dropped section goes with it.
        drop[i] = true;
        continue;
      }
      const normalised = normaliseHeading(text);
      if (OUT_OF_WORLD_SECTION.has(normalised)) {
        current = { level };
        sectionsTrimmed++;
        sectionsTrimmedBy[normalised] = (sectionsTrimmedBy[normalised] ?? 0) + 1;
        drop[i] = true;
        continue;
      }
      pending = { level, index: i };
      continue;
    }
    // `{{cata-section}}` sitting just under a heading marks that heading's
    // section — and the heading itself, which is already behind us.
    if (eraCuts && pending !== undefined && lines[i]!.includes("{{")) {
      let scanned = 0;
      for (let j = pending.index + 1; j <= i && scanned < MARKER_WINDOW; j++) scanned += lines[j]!.length;
      if (scanned < MARKER_WINDOW) {
        ERA_SECTION_TEMPLATE.lastIndex = 0;
        for (let m = ERA_SECTION_TEMPLATE.exec(lines[i]!); m !== null; m = ERA_SECTION_TEMPLATE.exec(lines[i]!)) {
          if (sectionLabelFor(m[1] ?? "") !== undefined) {
            current = { level: pending.level };
            sectionsDropped++;
            drop[pending.index] = true;
            for (let j = pending.index + 1; j < i; j++) drop[j] = true;
            pending = undefined;
            break;
          }
        }
      }
    }
    if (current !== undefined) drop[i] = true;
  }

  if (sectionsDropped === 0 && sectionsTrimmed === 0) {
    return { text: wikitext, sectionsDropped: 0, sectionsTrimmed: 0, sectionsTrimmedBy };
  }
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!drop[i]) kept.push(lines[i]!);
  }
  return { text: kept.join("\n"), sectionsDropped, sectionsTrimmed, sectionsTrimmedBy };
}

/**
 * Drop a heading whose whole subtree carries no prose.
 *
 * This is the trailing-cruft rule. A `== Drops ==` that is one wiki table, or a
 * section whose only paragraph the phrase rules took, leaves a heading line the
 * strip would happily emit on its own — a word of noise in a snippet that says
 * nothing about the world.
 *
 * The test is on the **subtree**, not on the direct body: a heading with no text
 * of its own but a subsection that has some is a real heading, and dropping it
 * would orphan the subsection. Heading lines are excluded from what is stripped,
 * since a heading always strips to its own text and would make every subtree
 * look occupied. The lead — everything before the first heading — is never
 * touched by this rule.
 */
/**
 * The page with **only** the out-of-world cuts applied: the heading drop set and
 * the empty-section sweep, the era rules switched off.
 *
 * This is the answer to "which cut emptied this page?", and it is asked only of
 * a page that ended up with no prose at all. If this text still has prose, the
 * era cuts are what took it and the page is about a later world; if it does not,
 * the page was a link farm, a patch log or an infobox and its title, ids and
 * coordinates are still this world's. `build.ts` drops the first and keeps the
 * second as an empty row.
 *
 * The paragraph rules are era rules and are off here too. Computed on demand
 * rather than returned by `dropPostWrath`: almost no page needs it, and the
 * empty-section sweep strips every section body to decide.
 */
export function dropOutOfWorldOnly(wikitext: string): string {
  if (typeof wikitext !== "string" || wikitext.length === 0) return wikitext;
  return dropEmptySections(dropPostWrathSections(wikitext, { eraCuts: false }).text).text;
}

export function dropEmptySections(wikitext: string): { text: string; sectionsTrimmed: number } {
  const lines = wikitext.split("\n");
  const levels = lines.map((line) => {
    const m = HEADING_LINE.exec(line);
    return m === null ? 0 : m[1]!.length;
  });
  const drop = new Array<boolean>(lines.length).fill(false);
  let sectionsTrimmed = 0;

  for (let i = 0; i < lines.length; i++) {
    const level = levels[i]!;
    if (level === 0) continue;
    let end = i + 1;
    while (end < lines.length && (levels[end] === 0 || levels[end]! > level)) end++;
    const body: string[] = [];
    for (let j = i + 1; j < end; j++) {
      if (levels[j] === 0) body.push(lines[j]!);
    }
    if (stripWikitext(body.join("\n")).length === 0) {
      for (let j = i; j < end; j++) drop[j] = true;
      sectionsTrimmed++;
      i = end - 1;
    }
    // Otherwise fall through into the subtree: an empty subsection of an
    // occupied section still goes.
  }

  if (sectionsTrimmed === 0) return { text: wikitext, sectionsTrimmed: 0 };
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!drop[i]) kept.push(lines[i]!);
  }
  return { text: kept.join("\n"), sectionsTrimmed };
}

/**
 * Drop paragraphs that the phrase rules say describe a later world.
 *
 * Paragraphs are blank-line separated blocks of the raw wikitext, which is the
 * unit `stripWikitext` collapses to a line and `searchReference` returns a
 * window of. A block with no prose of its own (an infobox, a stub banner) is
 * never a candidate: the strip removes it anyway, and testing it would let an
 * infobox field decide a page's prose.
 */
export function dropPostWrathParagraphs(wikitext: string): {
  text: string;
  paragraphsDropped: number;
} {
  if (!/cataclysm|shattering|deathwing/i.test(wikitext)) {
    return { text: wikitext, paragraphsDropped: 0 };
  }
  const blocks = wikitext.split(/\n[ \t]*\n/);
  const kept: string[] = [];
  let paragraphsDropped = 0;
  for (const block of blocks) {
    const prose = proseOf(block).trim();
    if (prose.length === 0 || !POST_WRATH_PARAGRAPH.some((rule) => rule.test(prose))) {
      kept.push(block);
      continue;
    }
    paragraphsDropped++;
  }
  if (paragraphsDropped === 0) return { text: wikitext, paragraphsDropped: 0 };
  return { text: kept.join("\n\n"), paragraphsDropped };
}
