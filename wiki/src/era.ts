/**
 * Era marking: this world is patch 3.3.5a, the wiki is not.
 *
 * The dump was taken in 2020, so its pages describe the world as it stood
 * several expansions after Wrath of the Lich King. Most of that divergence is
 * kept in explicit era sections — `{{cata-section}}` under an `== Cataclysm ==`
 * heading, `{{mists-section}}` under `== In Mists of Pandaria ==` — which is
 * exactly the structure `stripWikitext` destroys: the template goes with every
 * other template, the heading becomes an ordinary line, and Cataclysm prose
 * lands in the index indistinguishable from Wrath prose.
 *
 * A nav-probe run read one of those paragraphs, concluded that Coldridge Pass
 * was collapsed and that the only way out of the valley was a gyrocopter quest,
 * and spent the rest of its session chasing a quest chain that does not exist
 * in 3.3.5 (night-report 2026-08-23 §4, run `fleet-nav-probe-sonnet-20260822-c3`).
 * The tunnel is there in this world; the collapse is Cataclysm's.
 *
 * So: mark, never delete. This runs on the RAW wikitext before the strip and
 * prefixes every paragraph of a post-3.3.5 era section with a fixed literal
 * note. Per paragraph rather than per section because search returns a snippet
 * window, and a note at the top of a section is not in the window.
 *
 * What it cannot fix: a page's lead paragraph, written present-tense in 2020,
 * describes the post-Cataclysm world as current with no marker at all
 * ("… was linked … prior to its collapse"). Nothing at build time can tell that
 * from Wrath-era prose. The `search_reference` tool description carries the
 * standing warning for that half; this covers the half the wiki labels.
 *
 * Deterministic, never throws, no network.
 */

/** Expansions after Wrath of the Lich King: their content is not in this world. */
const POST_WRATH: { pattern: RegExp; label: string }[] = [
  { pattern: /^(cata|cataclysm)$/, label: "Cataclysm" },
  { pattern: /^(mists|mop|pandaria)$/, label: "Mists of Pandaria" },
  { pattern: /^(warlords|wod|draenor)$/, label: "Warlords of Draenor" },
  { pattern: /^(legion)$/, label: "Legion" },
  { pattern: /^(battle|bfa|azeroth)$/, label: "Battle for Azeroth" },
  { pattern: /^(shadowlands|sl)$/, label: "Shadowlands" },
];

/** Heading text that names a post-Wrath expansion, with or without a leading "in". */
const HEADING_ERA: { pattern: RegExp; label: string }[] = [
  { pattern: /^(in\s+)?cataclysm$/i, label: "Cataclysm" },
  { pattern: /^(in\s+)?(the\s+)?shattering$/i, label: "Cataclysm" },
  { pattern: /^(in\s+)?mists of pandaria$/i, label: "Mists of Pandaria" },
  { pattern: /^(in\s+)?warlords of draenor$/i, label: "Warlords of Draenor" },
  { pattern: /^(in\s+)?legion$/i, label: "Legion" },
  { pattern: /^(in\s+)?battle for azeroth$/i, label: "Battle for Azeroth" },
  { pattern: /^(in\s+)?shadowlands$/i, label: "Shadowlands" },
];

/** `{{cata-section}}`, `{{Mists-section}}`, `{{legion-section}}`. */
const ERA_SECTION_TEMPLATE = /\{\{\s*([A-Za-z]{2,12})-section\s*[|}]/g;

/** `{{Removedwithcataclysm}}` and friends: content gone *later*, so present in 3.3.5. */
const REMOVED_WITH_CATA = /\{\{\s*removed\s*with\s*cataclysm\s*[|}]/gi;

/** A wikitext heading line, with its level. */
const HEADING_LINE = /^[ \t]*(={2,6})[ \t]*(.*?)[ \t]*\1[ \t]*$/;

/** The note a post-Wrath paragraph carries into the index. */
export function eraNote(label: string): string {
  return `[${label}-era, not in patch 3.3.5]`;
}

/** The note a page carries when the wiki says its subject was removed after 3.3.5. */
export const REMOVED_LATER_NOTE =
  "[the wiki says this was removed in Cataclysm, so it exists in patch 3.3.5]";

/** How far past a heading an era-section template still counts as that section's marker. */
const MARKER_WINDOW = 400;

/** True when a line carries no prose of its own, only template calls. */
function isTemplateOnly(line: string): boolean {
  return line.replace(/\{\{[^{}]*\}\}/g, "").trim().length === 0;
}

function eraLabelFor(name: string): string | undefined {
  const n = name.toLowerCase();
  for (const { pattern, label } of POST_WRATH) {
    if (pattern.test(n)) return label;
  }
  return undefined;
}

function headingLabelFor(text: string): string | undefined {
  for (const { pattern, label } of HEADING_ERA) {
    if (pattern.test(text)) return label;
  }
  return undefined;
}

/**
 * Prefix every paragraph of a post-3.3.5 era section with a fixed note, and
 * flag a page the wiki says was removed after 3.3.5. Returns the wikitext
 * unchanged when neither applies, which is the overwhelming majority of pages.
 */
export function markEraSections(wikitext: string): string {
  if (typeof wikitext !== "string" || wikitext.length === 0) return wikitext;

  const removedLater = REMOVED_WITH_CATA.test(wikitext);
  REMOVED_WITH_CATA.lastIndex = 0;

  const lines = wikitext.split("\n");
  // Which era each line belongs to, if any: a heading opens a section, the next
  // heading of the same or a shallower level closes it.
  let current: { label: string; level: number } | undefined;
  let pending: { level: number; index: number } | undefined;
  const labels = new Array<string | undefined>(lines.length).fill(undefined);

  for (let i = 0; i < lines.length; i++) {
    const heading = HEADING_LINE.exec(lines[i]!);
    if (heading !== null) {
      const level = heading[1]!.length;
      const text = heading[2] ?? "";
      if (current !== undefined && level <= current.level) current = undefined;
      const fromHeading = headingLabelFor(text.replace(/\[\[|\]\]/g, "").trim());
      if (fromHeading !== undefined) current = { label: fromHeading, level };
      else pending = { level, index: i };
      continue;
    }
    // `{{cata-section}}` sitting just under a heading marks that heading's section.
    if (pending !== undefined && lines[i]!.includes("{{")) {
      let scanned = 0;
      for (let j = pending.index + 1; j <= i && scanned < MARKER_WINDOW; j++) scanned += lines[j]!.length;
      if (scanned < MARKER_WINDOW) {
        ERA_SECTION_TEMPLATE.lastIndex = 0;
        for (let m = ERA_SECTION_TEMPLATE.exec(lines[i]!); m !== null; m = ERA_SECTION_TEMPLATE.exec(lines[i]!)) {
          const label = eraLabelFor(m[1] ?? "");
          if (label !== undefined) {
            current = { label, level: pending.level };
            break;
          }
        }
      }
    }
    if (current !== undefined) labels[i] = current.label;
  }

  const marked = labels.some((l) => l !== undefined);
  if (!marked && !removedLater) return wikitext;

  const out: string[] = [];
  let paragraphOpen = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const label = labels[i];
    if (line.trim().length === 0) {
      paragraphOpen = false;
      out.push(line);
      continue;
    }
    // A line that is nothing but templates (the era marker itself, a stub
    // banner) is not the paragraph: the note belongs on the prose, so that a
    // snippet window around the prose carries it.
    if (isTemplateOnly(line)) {
      out.push(line);
      continue;
    }
    if (label !== undefined && !paragraphOpen) {
      out.push(`${eraNote(label)} ${line}`);
      paragraphOpen = true;
      continue;
    }
    if (label !== undefined) paragraphOpen = true;
    out.push(line);
  }

  const body = out.join("\n");
  return removedLater ? `${REMOVED_LATER_NOTE}\n\n${body}` : body;
}
