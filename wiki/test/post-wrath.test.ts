/**
 * Page-level admission (`admitPage`) and the signals behind it.
 *
 * Every fixture is invented. No wiki or game text appears in this repository.
 */

import { describe, expect, test } from "bun:test";
import {
  admitPage,
  hasClassic2019Signal,
  hasPostWrathSignal,
  hasWrathSignal,
} from "../src/post-wrath";

const PROSE = "Example Zone Beta is a starting region full of lorem ipsum.";

describe("post-Wrath page signals fire", () => {
  const fires: [string, string, string][] = [
    ["title parenthetical", "Example Zone Beta (Cataclysm)", PROSE],
    ["title parenthetical, subpage", "Example Zone Beta (Legion)/Quests", PROSE],
    ["category, expansion name", "Example Zone Beta", `${PROSE}\n[[Category:Cataclysm zones]]`],
    ["category, Pandaria", "Example Zone Beta", `${PROSE}\n[[Category:Pandaria]]`],
    ["category, exactly Legion", "Example Zone Beta", `${PROSE}\n[[Category:Legion]]`],
    ["category, Legion prefix", "Example Zone Beta", `${PROSE}\n[[Category:Legion stubs]]`],
    ["stub banner", "Example Zone Beta", `{{stub/Cataclysm}}\n${PROSE}`],
    ["article banner", "Example Zone Beta", `{{Legion-article}}\n${PROSE}`],
    ["zone banner", "Example Zone Beta", `{{DraenorZone}}\n${PROSE}`],
    ["expansion banner", "Example Zone Beta", `{{Pandaria}}\n${PROSE}`],
    ["patch field", "Example Zone Beta", `{{zonebox|patch=4.0.3a}}\n${PROSE}`],
    ["patch field, much later", "Example Zone Beta", `{{zonebox|patch=8.1.5}}\n${PROSE}`],
    ["expansion field", "Example Zone Beta", `{{zonebox|expansion=Mists of Pandaria}}\n${PROSE}`],
  ];
  for (const [name, title, wikitext] of fires) {
    test(name, () => {
      expect(hasPostWrathSignal(title, wikitext)).toBe(true);
      expect(admitPage({ title, eraWikitext: wikitext, newestWikitext: wikitext })).toEqual({
        admit: false,
        reason: "dropped_post_wrath",
      });
    });
  }
});

describe("post-Wrath page signals do not fire", () => {
  // Each of these is Wrath-era content that a careless rule would delete. The
  // Burning Legion, Deathwing, Draenor and the 7th Legion are all in 3.3.5.
  const quiet: [string, string, string][] = [
    ["Removedwithlegion says it is here now", "Example Item Zeta", `{{Removedwithlegion}}\n${PROSE}`],
    ["Removedwithcataclysm likewise", "Example Item Zeta", `{{Removedwithcataclysm}}\n${PROSE}`],
    ["legion-inline marks a clause", "Example Person Gamma", `{{legion-inline}} ${PROSE}`],
    ["Legion-section is the section rule's job", "Example Zone Beta", `{{Legion-section}}\n${PROSE}`],
    ["Burning Legion category", "Example Zone Beta", `${PROSE}\n[[Category:Burning Legion]]`],
    ["7th Legion category", "Example Person Gamma", `${PROSE}\n[[Category:7th Legion]]`],
    ["Legion's possessive category", "Example Item Zeta", `${PROSE}\n[[Category:Legion's Bane items]]`],
    ["bare Draenor category is old Outland", "Example Zone Beta", `${PROSE}\n[[Category:Draenor]]`],
    ["a Wrath patch field", "Example Zone Beta", `{{zonebox|patch=3.3.0}}\n${PROSE}`],
    ["no signal at all", "Example Zone Beta", PROSE],
  ];
  for (const [name, title, wikitext] of quiet) {
    test(name, () => {
      expect(hasPostWrathSignal(title, wikitext)).toBe(false);
    });
  }
});

describe("Wrath-or-earlier signals", () => {
  test("an infobox patch below 4.0 is one", () => {
    expect(hasWrathSignal(`{{itembox|patch=3.0.2}}\n${PROSE}`)).toBe(true);
  });
  test("an expansion field naming this world or an earlier one is one", () => {
    expect(hasWrathSignal(`{{zonebox|expansion=Wrath of the Lich King}}\n${PROSE}`)).toBe(true);
    expect(hasWrathSignal(`{{zonebox|expansion=The Burning Crusade}}\n${PROSE}`)).toBe(true);
  });
  test("a named category is one", () => {
    expect(hasWrathSignal(`${PROSE}\n[[Category:Wrath of the Lich King]]`)).toBe(true);
  });
  test("prose alone is not", () => {
    expect(hasWrathSignal(PROSE)).toBe(false);
  });
  test("Classic 2019 is vetoed by title, by patch number and by category", () => {
    expect(hasClassic2019Signal("Example Classic realms", PROSE)).toBe(true);
    expect(hasClassic2019Signal("Patch 1.13.2", PROSE)).toBe(true);
    expect(hasClassic2019Signal("Example Page", `${PROSE}\n[[Category:World of Warcraft: Classic patches]]`)).toBe(true);
    expect(hasClassic2019Signal("Example Zone Beta", PROSE)).toBe(false);
  });
});

describe("admitPage reasons", () => {
  test("pre_cutoff: a pre-cutoff revision and nothing post-Wrath about it", () => {
    expect(
      admitPage({ title: "Example Zone Beta", eraWikitext: PROSE, newestWikitext: "Rewritten lorem." }),
    ).toEqual({ admit: true, reason: "pre_cutoff" });
  });

  test("post_cutoff_wrath_signal: written late, explicitly about this world", () => {
    expect(
      admitPage({
        title: "Example Item Zeta",
        eraWikitext: null,
        newestWikitext: `{{itembox|patch=3.0.2}}\n${PROSE}`,
      }),
    ).toEqual({ admit: true, reason: "post_cutoff_wrath_signal" });
  });

  test("post_cutoff_wrath_signal does not admit a Classic 2019 page", () => {
    expect(
      admitPage({
        title: "Example Classic realms",
        eraWikitext: null,
        newestWikitext: `{{patchbox|patch=1.13.2}}\n${PROSE}`,
      }),
    ).toEqual({ admit: false, reason: "dropped_post_cutoff" });
  });

  test("dropped_post_cutoff: written late and silent about which world", () => {
    expect(
      admitPage({ title: "Example Late Page", eraWikitext: null, newestWikitext: PROSE }),
    ).toEqual({ admit: false, reason: "dropped_post_cutoff" });
  });

  test("dropped_post_wrath: a beta stub written before the cutoff", () => {
    expect(
      admitPage({
        title: "Example Zone Theta",
        eraWikitext: `{{stub/Cataclysm}}\nExample Zone Theta will open with the next expansion.`,
        newestWikitext: "Example Zone Theta, lorem.",
      }),
    ).toEqual({ admit: false, reason: "dropped_post_wrath" });
  });

  test("dropped_meta: out-of-game, whatever era it names", () => {
    expect(
      admitPage({ title: "Hotfixes/2015 Archive", eraWikitext: PROSE, newestWikitext: PROSE }),
    ).toEqual({ admit: false, reason: "dropped_meta" });
    expect(
      admitPage({ title: "API GetSpellInfo", eraWikitext: PROSE, newestWikitext: PROSE }),
    ).toEqual({ admit: false, reason: "dropped_meta" });
  });

  test("a late category on a Wrath page does not reach the decision", () => {
    // The signal is read on the revision the prose comes from. A zone that was
    // rewritten for a later expansion had that category added later; the page
    // itself is standing in this world.
    expect(
      admitPage({
        title: "Example Zone Beta",
        eraWikitext: PROSE,
        newestWikitext: `${PROSE}\n[[Category:Cataclysm zones]]`,
      }),
    ).toEqual({ admit: true, reason: "pre_cutoff" });
  });
});
