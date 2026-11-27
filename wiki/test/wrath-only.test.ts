import { describe, expect, test } from "bun:test";
import {
  dropOutOfWorldOnly,
  dropPostWrath,
  dropPostWrathParagraphs,
  dropPostWrathSections,
} from "../src/wrath-only";
import { stripWikitext } from "../src/strip";

/**
 * How many out-of-world sections a cut removed: the sum of its breakdown, which
 * is where the count lives now (a scalar beside the map was one more thing that
 * could disagree with it).
 */
function trimmed(cut: { sectionsTrimmedBy: Record<string, number> }): number {
  return Object.values(cut.sectionsTrimmedBy).reduce((a, b) => a + b, 0);
}

// Every fixture here is invented. No wiki or game text appears in this repo.

const PAGE = [
  "'''Example Pass''' links Example Valley to the rest of Example Region.",
  "",
  "== Cataclysm ==",
  "{{cata-section}}",
  "The pass was buried under stone and the only way out became an aircraft.",
  "",
  "Travellers now take the flight instead.",
  "",
  "== Inhabitants ==",
  "Example Person Gamma stands at the tunnel mouth.",
].join("\n");

describe("sections", () => {
  test("a post-Wrath section is dropped, heading and all, and the lead and later sections survive", () => {
    const cut = dropPostWrath(PAGE);
    const text = stripWikitext(cut.text);
    expect(text).not.toContain("buried under stone");
    expect(text).not.toContain("take the flight");
    expect(text).not.toContain("Cataclysm");
    expect(cut.sectionsDropped).toBe(1);
    expect(text).toContain("links Example Valley");
    expect(text).toContain("Example Person Gamma");
    expect(text).toContain("Inhabitants");
  });

  test("a section template alone drops its section, heading text alone does too", () => {
    const templateOnly = dropPostWrathSections("== Later ==\n{{legion-section}}\nLorem ipsum dolor.");
    expect(templateOnly.text).not.toContain("Lorem ipsum");
    expect(templateOnly.text).not.toContain("Later");
    expect(templateOnly.sectionsDropped).toBe(1);

    const headingOnly = dropPostWrathSections("== In Mists of Pandaria ==\nLorem ipsum dolor.");
    expect(headingOnly.text.trim()).toBe("");
    expect(headingOnly.sectionsDropped).toBe(1);
  });

  test("a subsection of a dropped section goes with it, a sibling does not", () => {
    const page = [
      "Lead lorem.",
      "== Cataclysm ==",
      "Body lorem.",
      "=== Detail ===",
      "Detail lorem.",
      "== Inhabitants ==",
      "Keeper lorem.",
    ].join("\n");
    const cut = dropPostWrathSections(page);
    expect(cut.text).toContain("Lead lorem.");
    expect(cut.text).toContain("Keeper lorem.");
    expect(cut.text).not.toContain("Body lorem.");
    expect(cut.text).not.toContain("Detail lorem.");
    expect(cut.sectionsDropped).toBe(1);
  });

  test("pre-Wrath eras are untouched", () => {
    const page = "== The Burning Crusade ==\n{{bc-section}}\nLorem ipsum dolor.";
    expect(dropPostWrathSections(page)).toEqual({
      text: page,
      sectionsDropped: 0,
      sectionsTrimmedBy: {},
    });
    const plain = "Example Valley is a starting area.";
    expect(dropPostWrath(plain)).toEqual({
      text: plain,
      sectionsDropped: 0,
      paragraphsDropped: 0,
      paragraphsDroppedOnLinks: 0,
      sectionsTrimmedBy: {},
    });
  });

  test("content removed in a later expansion is kept, with no note in its place", () => {
    const cut = dropPostWrath("{{Removedwithcataclysm}}\n{{questbox|id=7}}\nLorem ipsum dolor.");
    const text = stripWikitext(cut.text);
    expect(text).toBe("Lorem ipsum dolor.");
    expect(cut.sectionsDropped).toBe(0);
    expect(cut.paragraphsDropped).toBe(0);
  });
});

describe("paragraphs", () => {
  const cutOf = (paragraph: string) => dropPostWrathParagraphs(`Lead lorem.\n\n${paragraph}\n\nTail lorem.`);

  test("a paragraph about the later world goes, whichever way it names it", () => {
    for (const paragraph of [
      "In Cataclysm the bridge is gone and the road runs south instead.",
      "World of Warcraft: Cataclysm adds a second quartermaster here.",
      "After the Shattering the lake drained and the pier stands dry.",
      "This is an upcoming zone; Deathwing is said to nest below it.",
      "The quest giver will be moved to the far bank in the Cataclysm expansion.",
    ]) {
      const cut = cutOf(paragraph);
      expect({ paragraph, dropped: cut.paragraphsDropped, text: cut.text }).toEqual({ paragraph, dropped: 1, text: "Lead lorem.\n\nTail lorem." });
    }
  });

  test("this world's names that later expansions reuse keep their paragraph", () => {
    for (const paragraph of [
      "Deathwing is spoken of in the tavern, though nobody has seen him.",
      "The Burning Legion burned this grove in the War of the Ancients.",
      "A caravan will arrive from the south once the road is cleared.",
      "The 7th Legion recruiter stands beside the inn door.",
    ]) {
      const cut = cutOf(paragraph);
      expect({ paragraph, dropped: cut.paragraphsDropped }).toEqual({ paragraph, dropped: 0 });
      expect(cut.text).toContain(paragraph);
    }
  });

  test("`will` counts only near Cataclysm, not anywhere on the page", () => {
    const far =
      "Cataclysm is named in the first sentence of this paragraph, which then runs on " +
      "for a good while about the road, the bridge, the ferry and the tolls collected " +
      "at the crossing, before finally saying that a caravan will arrive at dusk.";
    expect(dropPostWrathParagraphs(`Lead lorem.\n\n${far}`).paragraphsDropped).toBe(0);
  });

  test("an infobox field never decides a paragraph", () => {
    const block = "{{npcbox|note=In Cataclysm this NPC moves}}\nExample Person Gamma tends the fire.";
    const cut = dropPostWrathParagraphs(`Lead lorem.\n\n${block}`);
    expect(cut.paragraphsDropped).toBe(0);
  });

  test("sections are cut before paragraphs, so nothing is counted twice", () => {
    const page = [
      "Lead lorem.",
      "",
      "== In Cataclysm ==",
      "In Cataclysm the bridge is gone.",
      "",
      "In Cataclysm the road runs south.",
    ].join("\n");
    const cut = dropPostWrath(page);
    expect(cut.sectionsDropped).toBe(1);
    expect(cut.paragraphsDropped).toBe(0);
    expect(stripWikitext(cut.text)).toBe("Lead lorem.");
  });
});

describe("out-of-world sections", () => {
  test("a meta, media or other-medium section is trimmed and counted by its heading", () => {
    for (const heading of ["External links", "Patch changes", "Gallery", "Trivia", "History", "In the RPG", "In Warcraft III", "Changes"]) {
      const page = [
        "Example Valley is a starting area.",
        "",
        `== ${heading} ==`,
        "Removable lorem ipsum dolor sit amet.",
        "",
        "== Inhabitants ==",
        "Example Person Gamma tends the fire.",
      ].join("\n");
      const cut = dropPostWrath(page);
      const text = stripWikitext(cut.text);
      expect(text).not.toContain("Removable lorem");
      expect(text).not.toContain(heading);
      expect(text).toContain("Example Person Gamma");
      expect({ heading, by: cut.sectionsTrimmedBy, dropped: cut.sectionsDropped }).toEqual({ heading, by: { [heading.toLowerCase()]: 1 }, dropped: 0 });
    }
  });

  test("headings that are deliberately kept survive", () => {
    for (const heading of ["Notes", "Tips and tactics", "Objectives", "Abilities", "Past changes"]) {
      const page = `Lead lorem.\n\n== ${heading} ==\nKeepable lorem ipsum dolor.`;
      const cut = dropPostWrath(page);
      expect(trimmed(cut)).toBe(0);
      expect(stripWikitext(cut.text)).toContain("Keepable lorem");
      expect(stripWikitext(cut.text)).toContain(heading);
    }
  });

  test("a subsection of a trimmed section goes with it", () => {
    const page = [
      "Lead lorem.",
      "== History ==",
      "Body lorem.",
      "=== Later ===",
      "Detail lorem.",
      "==== Deeper ====",
      "Deeper lorem.",
      "== Inhabitants ==",
      "Keeper lorem.",
    ].join("\n");
    const cut = dropPostWrath(page);
    expect(cut.text).toContain("Lead lorem.");
    expect(cut.text).toContain("Keeper lorem.");
    expect(cut.text).not.toContain("Body lorem.");
    expect(cut.text).not.toContain("Detail lorem.");
    expect(cut.text).not.toContain("Deeper lorem.");
    expect(trimmed(cut)).toBe(1);
  });

  test("a kept section between two trimmed ones survives", () => {
    const page = [
      "== Trivia ==",
      "First removable lorem.",
      "== Objectives ==",
      "Keepable lorem.",
      "== External links ==",
      "Second removable lorem.",
    ].join("\n");
    const cut = dropPostWrath(page);
    expect(stripWikitext(cut.text)).toBe("Objectives\nKeepable lorem.");
    expect(trimmed(cut)).toBe(2);
    expect(cut.sectionsTrimmedBy).toEqual({ trivia: 1, "external links": 1 });
  });

  test("headings are normalised: case, trailing colon, odd spacing, markup", () => {
    const variants = [
      "==EXTERNAL LINKS==",
      "==   External links:   ==",
      "== external  links ==",
      "== ''External links'' ==",
      "== [[External links]] ==",
    ];
    for (const heading of variants) {
      const cut = dropPostWrath(`Lead lorem.\n${heading}\nRemovable lorem.`);
      expect(trimmed(cut)).toBe(1);
      expect(cut.sectionsTrimmedBy["external links"]).toBe(1);
      expect(stripWikitext(cut.text)).toBe("Lead lorem.");
    }
  });

  test("a trimmed subsection does not swallow the section after it", () => {
    const page = [
      "== Inhabitants ==",
      "Keeper lorem.",
      "=== Trivia ===",
      "Removable lorem.",
      "== Objectives ==",
      "Objective lorem.",
    ].join("\n");
    const cut = dropPostWrath(page);
    const text = stripWikitext(cut.text);
    expect(text).toContain("Keeper lorem.");
    expect(text).toContain("Objective lorem.");
    expect(text).not.toContain("Removable lorem.");
    expect(text).toContain("Objectives");
    expect(trimmed(cut)).toBe(1);
  });

  test("a section whose body strips to nothing leaves no orphan heading", () => {
    const page = [
      "Lead lorem.",
      "== Drops ==",
      '{| class="example"',
      "! Column",
      "|}",
      "== Inhabitants ==",
      "Keeper lorem.",
    ].join("\n");
    const cut = dropPostWrath(page);
    expect(stripWikitext(cut.text)).toBe("Lead lorem.\nInhabitants\nKeeper lorem.");
    expect(trimmed(cut)).toBe(1);
    expect(cut.sectionsTrimmedBy).toEqual({ "(empty)": 1 });
  });

  test("a section listed only in inline link templates is not empty", () => {
    // The names are what the section says; a list of other templates still goes.
    const page = [
      "Lead lorem.",
      "== Quests ==",
      "* {{questlong|Alliance|10|Example Quest Alpha}}",
      "* {{questlong|Alliance|12|Example Quest Beta}}",
      "== Prices ==",
      "* {{cost|1|50|0}}",
    ].join("\n");
    const cut = dropPostWrath(page);
    expect(stripWikitext(cut.text)).toBe("Lead lorem.\nQuests\nExample Quest Alpha\nExample Quest Beta");
    expect(cut.sectionsTrimmedBy).toEqual({ "(empty)": 1 });
  });

  test("a paragraph that reads as the later world only through its names keeps them out", () => {
    // The template-free reading passes the paragraph rules; with the names in,
    // "in Cataclysm" appears. The paragraph stays as it was, holes included.
    const page = [
      "Lead lorem.",
      "",
      "A reward from {{quest|Example Return in Cataclysm}}, sold by {{npc||Example Person Gamma}}.",
      "",
      "Sold by {{npc||Example Person Gamma}} here.",
    ].join("\n");
    const cut = dropPostWrath(page);
    expect(cut.paragraphsDropped).toBe(0);
    expect(stripWikitext(cut.text)).toBe("Lead lorem.\nA reward from , sold by .\nSold by Example Person Gamma here.");
    // Rendering off reads the page exactly as before.
    expect(stripWikitext(dropPostWrath(page, { inlineLinks: false }).text, { inlineLinks: false })).toBe(
      "Lead lorem.\nA reward from , sold by .\nSold by here.",
    );
  });

  test("with rendering on, the phrase rules read a link as its label", () => {
    // The template-free reading sees "[[The Shattering]]" and never fired; read
    // as the strip renders it, the paragraph is the later world's and goes.
    const page = [
      "Lead lorem.",
      "",
      "This quest was replaced by {{quest|Example Quest Beta}} after [[The Shattering]].",
    ].join("\n");
    const cut = dropPostWrath(page);
    expect(cut.paragraphsDropped).toBe(1);
    expect(cut.paragraphsDroppedOnLinks).toBe(1);
    expect(stripWikitext(cut.text)).toBe("Lead lorem.");
    // Rendering off is the reading the page set is decided on, unchanged.
    const plain = dropPostWrath(page, { inlineLinks: false });
    expect(plain.paragraphsDropped).toBe(0);
    expect(stripWikitext(plain.text, { inlineLinks: false })).toBe(
      "Lead lorem.\nThis quest was replaced by after The Shattering.",
    );
    // A piped link reads as its label, never as its target.
    const piped = "Lorem in [[Example Expansion|Cataclysm]] dolor.\n\nKept lorem, in [[Cataclysm|the next one]].";
    expect(stripWikitext(dropPostWrath(piped).text)).toBe("Kept lorem, in the next one.");
  });

  test("a line that a line rule catches only through its name keeps it out", () => {
    const page = ["== Inhabitants ==", "* {{item|Example Speedbarge Token}}", "* {{item|Example Item Delta}}"].join("\n");
    const cut = dropPostWrath(page);
    expect(stripWikitext(cut.text)).toBe("Inhabitants\nExample Item Delta");
  });

  test("a heading with no body of its own but an occupied subsection survives", () => {
    const page = ["== Abilities ==", "=== Example Strike ===", "Ability lorem."].join("\n");
    const cut = dropPostWrath(page);
    expect(stripWikitext(cut.text)).toBe("Abilities\nExample Strike\nAbility lorem.");
    expect(trimmed(cut)).toBe(0);
  });

  test("a section the paragraph rule empties leaves no orphan heading", () => {
    const page = [
      "Lead lorem.",
      "",
      "== Inhabitants ==",
      "",
      "In Cataclysm the camp is gone.",
    ].join("\n");
    const cut = dropPostWrath(page);
    expect(cut.paragraphsDropped).toBe(1);
    expect(trimmed(cut)).toBe(1);
    expect(stripWikitext(cut.text)).toBe("Lead lorem.");
  });

  test("the lead is never trimmed by the heading rule", () => {
    const page = "External links are mentioned in this lead about history and trivia.";
    const cut = dropPostWrath(page);
    expect(trimmed(cut)).toBe(0);
    expect(stripWikitext(cut.text)).toBe(page);
  });
});

describe("which cut emptied the page", () => {
  // `dropOutOfWorldOnly` answers one question, asked only of a page that ended
  // up with no prose at all: would anything have survived if only the
  // out-of-world trim had run? Yes means the era cuts took the page's prose and
  // the page is about a later world; no means it was a link farm or an infobox,
  // and its title and ids are still this world's. `build.ts` drops the first and
  // keeps the second as an empty row.

  test("an infobox and a link list leave nothing, and no era cut was involved", () => {
    const page = [
      "{{itembox|patch=3.0.2|itemid=7311}}",
      "",
      "== External links ==",
      "* [http://example.invalid/kappa Example Kappa entry]",
    ].join("\n");
    expect(stripWikitext(dropPostWrath(page).text)).toBe("");
    expect(stripWikitext(dropOutOfWorldOnly(page))).toBe("");
  });

  test("a page the era section emptied still has prose without the era cuts", () => {
    const page = ["== In Cataclysm ==", "The whole page is about the next world."].join("\n");
    expect(stripWikitext(dropPostWrath(page).text)).toBe("");
    expect(stripWikitext(dropOutOfWorldOnly(page))).toContain("next world");
  });

  test("an era page with a link section is still an era page", () => {
    // The case a trim-only text has to get right: both cuts fire, and only one
    // of them is evidence about the page's world.
    const page = [
      "== Cataclysm ==",
      "{{cata-section}}",
      "A zone that does not exist in this world.",
      "",
      "== External links ==",
      "* [http://example.invalid/theta Example Theta entry]",
    ].join("\n");
    expect(stripWikitext(dropPostWrath(page).text)).toBe("");
    expect(stripWikitext(dropOutOfWorldOnly(page))).toContain("does not exist");
  });

  test("a paragraph rule that empties a page counts as an era cut", () => {
    const page = "In Cataclysm the camp is gone and nothing else is said here.";
    expect(stripWikitext(dropPostWrath(page).text)).toBe("");
    expect(stripWikitext(dropOutOfWorldOnly(page))).toBe(page);
  });
});

/**
 * The rules an adversarial read of a built bundle added: paragraphs that
 * describe the later world without naming the expansion. Every fixture is
 * invented, as everywhere else in this file.
 */
describe("paragraphs that never name the expansion", () => {
  const cutOf = (paragraph: string) => dropPostWrathParagraphs(`Lead lorem.\n\n${paragraph}\n\nTail lorem.`);

  test("rated battlegrounds, an expansion tag, a playable worgen, Mastery as a stat and archaeology the profession go", () => {
    for (const paragraph of [
      "Honour is also earned in rated battlegrounds, which use a separate rating.",
      "Example Person Gamma sells the tabard here (Expansion: Cataclysm) for a token.",
      "The worgen became a playable race and start their run in the ruined city.",
      "Mastery will be a new passive bonus, and we're planning to tune it before release.",
      "Archaeology is trained in the capital and raises to 525 like any secondary skill.",
    ]) {
      const cut = cutOf(paragraph);
      expect({ paragraph, dropped: cut.paragraphsDropped, text: cut.text }).toEqual({ paragraph, dropped: 1, text: "Lead lorem.\n\nTail lorem." });
    }
  });

  test("the same words in this world's sense keep their paragraph", () => {
    for (const paragraph of [
      "The archaeology dig site west of the camp was abandoned before the war.",
      "Tactical Mastery is three points deep in the arms tree and keeps rage on a stance change.",
      "Battlegrounds are entered from the master beside the flightpath, or by the queue.",
      "A pack of worgen prowls the wood after dark and will not parley.",
      "The expansion of the mine reached the second seam last spring.",
    ]) {
      const cut = cutOf(paragraph);
      expect({ paragraph, dropped: cut.paragraphsDropped }).toEqual({ paragraph, dropped: 0 });
      expect(cut.text).toContain(paragraph);
    }
  });

  test("a Speedbarge line goes and the rest of the list stays", () => {
    // The block is a list of subzones, not a paragraph: dropping it whole would
    // take every other subzone with it.
    const page = [
      "Lead lorem.",
      "",
      "* Example Camp, on the eastern rim",
      "* The Speedbarge, moored in the water below",
      "* Example Post, at the southern gate",
    ].join("\n");
    const cut = dropPostWrathParagraphs(page);
    expect(cut.paragraphsDropped).toBe(1);
    expect(cut.text).toContain("Example Camp");
    expect(cut.text).toContain("Example Post");
    expect(cut.text).not.toContain("Speedbarge");
  });

  test("the prefilter does not gate the rules on the word Cataclysm", () => {
    // The rules above exist because a page can describe the later world without
    // ever naming it. A prefilter that still asked for `cataclysm` would make
    // every one of them pass its unit test and never fire on a real page.
    for (const page of [
      "Lead lorem.\n\n* The Speedbarge is moored below.",
      "Lead lorem.\n\nHonour is also earned in rated battlegrounds each week.",
      "Lead lorem.\n\nArchaeology is trained in the capital like any secondary skill.",
      "Lead lorem.\n\nMastery is a new stat found on armour from this point on.",
      "Lead lorem.\n\nThe worgen became a playable race after the wall fell.",
    ]) {
      expect(page).not.toMatch(/cataclysm|shattering|deathwing/i);
      expect(dropPostWrathParagraphs(page).paragraphsDropped).toBe(1);
    }
  });
});

/**
 * The April 2010 Cataclysm class previews, which the wiki pasted into every
 * class page under standardised headings. Real headings, invented prose.
 */
describe("class-preview sections", () => {
  const LEAD = "'''Example Class''' is one of the example callings.";
  const PREVIEW = "An ability that no trainer of this world teaches, lorem ipsum.";
  const TALENT = "Example Talent Alpha reduces the cost of the example strike.";

  test("a preview heading is an era cut, not an out-of-world trim, markup and colon included", () => {
    for (const heading of ["New Rogue Abilities", "Mastery Passive Talent Tree Bonuses", "Cataclysm Class Preview: Rogue", "'''New Mage Abilities''':"]) {
      const page = [LEAD, "", `== ${heading} ==`, PREVIEW, "", "== Talents ==", TALENT].join("\n");
      const cut = dropPostWrath(page);
      const text = stripWikitext(cut.text);
      expect(text).not.toContain("no trainer of this world");
      expect(text).not.toContain(heading);
      // The Wrath talent section beside it is untouched.
      expect(text).toContain("Example Talent Alpha");
      expect(text).toContain("Talents");
      // Counted as an era cut. The out-of-world trim is a different question
      // and a different counter.
      expect({ heading, dropped: cut.sectionsDropped, trimmed: trimmed(cut) }).toEqual({ heading, dropped: 1, trimmed: 0 });
    }
  });

  test("headings a 3.3.5 class page really has are left alone", () => {
    for (const heading of [
      "Talents",
      "Abilities",
      "Rogue abilities",
      "Talent trees",
      "Stance Mastery",
      "Tactical Mastery",
      "Mastery of the elements",
      "Mastery bonus of the example tree",
    ]) {
      const cut = dropPostWrath([LEAD, "", `== ${heading} ==`, TALENT].join("\n"));
      expect(`${heading}: ${cut.sectionsDropped}`).toBe(`${heading}: 0`);
      expect(stripWikitext(cut.text)).toContain("Example Talent Alpha");
    }
  });

  test("the preview's own framing sentence goes even without its heading", () => {
    const page = [
      TALENT,
      "",
      "As development on Cataclysm continues, the example strike is being reworked.",
      "",
      "The Cataclysm class preview said the example strike would be a talent.",
      "",
      "Example Talent Beta shortens the example recovery.",
    ].join("\n");
    const cut = dropPostWrath(page);
    expect(cut.paragraphsDropped).toBe(2);
    const text = stripWikitext(cut.text);
    expect(text).toContain("Example Talent Alpha");
    expect(text).toContain("Example Talent Beta");
    expect(text).not.toContain("being reworked");
    expect(text).not.toContain("would be a talent");
  });
});
