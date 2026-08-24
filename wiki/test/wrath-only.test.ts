import { describe, expect, test } from "bun:test";
import { dropPostWrath, dropPostWrathParagraphs, dropPostWrathSections } from "../src/wrath-only";
import { stripWikitext } from "../src/strip";

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
  test("a post-Wrath section is dropped, heading and all", () => {
    const cut = dropPostWrath(PAGE);
    const text = stripWikitext(cut.text);
    expect(text).not.toContain("buried under stone");
    expect(text).not.toContain("take the flight");
    expect(text).not.toContain("Cataclysm");
    expect(cut.sectionsDropped).toBe(1);
  });

  test("the lead and later sections survive", () => {
    const text = stripWikitext(dropPostWrath(PAGE).text);
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
    expect(dropPostWrathSections(page)).toEqual({ text: page, sectionsDropped: 0 });
    const plain = "Example Valley is a starting area.";
    expect(dropPostWrath(plain)).toEqual({
      text: plain,
      sectionsDropped: 0,
      paragraphsDropped: 0,
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
  const drops = [
    "In Cataclysm the bridge is gone and the road runs south instead.",
    "The camp was rebuilt with Cataclysm and the tents moved uphill.",
    "World of Warcraft: Cataclysm adds a second quartermaster here.",
    "After the Shattering the lake drained and the pier stands dry.",
    "This is an upcoming zone; Deathwing is said to nest below it.",
    "The beta build places a Cataclysm flight master on the ridge.",
    "Cataclysm will move the quest giver to the far bank.",
    "The quest giver will be moved to the far bank in the Cataclysm expansion.",
  ];
  for (const paragraph of drops) {
    test(`drops: ${paragraph.slice(0, 34)}…`, () => {
      const cut = dropPostWrathParagraphs(`Lead lorem.\n\n${paragraph}\n\nTail lorem.`);
      expect(cut.paragraphsDropped).toBe(1);
      expect(cut.text).toBe("Lead lorem.\n\nTail lorem.");
    });
  }

  const keeps = [
    "Deathwing is spoken of in the tavern, though nobody has seen him.",
    "The Burning Legion burned this grove in the War of the Ancients.",
    "Garrosh keeps a war camp on the ridge above the road.",
    "Draenor is what the orcs called their world before it broke.",
    "A caravan will arrive from the south once the road is cleared.",
    "The 7th Legion recruiter stands beside the inn door.",
  ];
  for (const paragraph of keeps) {
    test(`keeps: ${paragraph.slice(0, 34)}…`, () => {
      const cut = dropPostWrathParagraphs(`Lead lorem.\n\n${paragraph}\n\nTail lorem.`);
      expect(cut.paragraphsDropped).toBe(0);
      expect(cut.text).toContain(paragraph);
    });
  }

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

  test("a page can lose every paragraph, and the caller sees an empty strip", () => {
    const cut = dropPostWrath("In Cataclysm this whole page describes another world.");
    expect(cut.paragraphsDropped).toBe(1);
    expect(stripWikitext(cut.text)).toBe("");
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
