import { expect, test } from "bun:test";
import { markEraSections, REMOVED_LATER_NOTE } from "../src/era";
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

test("a labelled post-Wrath section is marked paragraph by paragraph", () => {
  const text = stripWikitext(markEraSections(PAGE));
  const lines = text.split("\n");
  const buried = lines.find((l) => l.includes("buried under stone"));
  const flight = lines.find((l) => l.includes("take the flight"));
  expect(buried).toContain("[Cataclysm-era, not in patch 3.3.5]");
  expect(flight).toContain("[Cataclysm-era, not in patch 3.3.5]");
});

test("the lead and later sections are left alone", () => {
  const text = stripWikitext(markEraSections(PAGE));
  const lines = text.split("\n");
  expect(lines[0]).not.toContain("Cataclysm-era");
  expect(lines.find((l) => l.includes("Example Person Gamma"))).not.toContain("Cataclysm-era");
});

test("no text is deleted", () => {
  const marked = markEraSections(PAGE);
  for (const fragment of ["buried under stone", "take the flight", "Example Person Gamma"]) {
    expect(marked).toContain(fragment);
  }
});

test("a section template alone marks its section, heading text alone does too", () => {
  const templateOnly = markEraSections("== Later ==\n{{legion-section}}\nLorem ipsum dolor.");
  expect(templateOnly).toContain("[Legion-era, not in patch 3.3.5]");
  const headingOnly = markEraSections("== In Mists of Pandaria ==\nLorem ipsum dolor.");
  expect(headingOnly).toContain("[Mists of Pandaria-era, not in patch 3.3.5]");
});

test("pre-Wrath eras are not marked", () => {
  const page = "== The Burning Crusade ==\n{{bc-section}}\nLorem ipsum dolor.";
  expect(markEraSections(page)).toBe(page);
  const plain = "Example Valley is a starting area.";
  expect(markEraSections(plain)).toBe(plain);
});

test("content the wiki says was removed later is flagged as present here", () => {
  const marked = markEraSections("{{Removedwithcataclysm}}\n{{questbox|id=7}}\nLorem ipsum.");
  expect(marked.startsWith(REMOVED_LATER_NOTE)).toBe(true);
  expect(stripWikitext(marked)).toContain("exists in patch 3.3.5");
});
