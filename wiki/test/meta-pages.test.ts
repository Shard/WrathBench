import { describe, expect, test } from "bun:test";
import { classifyMetaPage } from "../src/meta-pages";

/**
 * Every title here is either invented or a structural title (a namespace
 * prefix, a template-generated archive name) that carries no game text.
 */

describe("classifyMetaPage — positives", () => {
  const positives: [string, string][] = [
    ["Hotfixes", "hotfixes"],
    ["Hotfixes/2015 Archive", "hotfixes"],
    ["Hotfixes/2011 thru June 1 Archive", "hotfixes"],
    ["Patch 3.3.5", "patch-notes"],
    ["Patch 0.11", "patch-notes"],
    ["Patch 3.0.8 (undocumented changes)", "patch-notes"],
    ["Patches", "patch-notes"],
    ["Patches/3.x", "patch-notes"],
    ["Patch mirrors", "patch-notes"],
    ["Patch mirrors/Checksums", "patch-notes"],
    ["Patch mirrors (PTR)", "patch-notes"],
    ["Patch FAQ", "patch-notes"],
    ["List of pop culture references in Warcraft", "pop-culture"],
    ["List of pop culture references in Warcraft/All", "pop-culture"],
    ["Example Bars (AddOn)", "addon"],
    ["Example Bars (addon)", "addon"],
    ["Example Bars (AddOn)/Configuration", "addon"],
    ["API GetExampleInfo", "api"],
    ["API pcall", "api"],
    ["API Frame SetExampleBackdrop", "api"],
    ["UI coordinates", "ui"],
    ["UI FAQ/AddOns", "ui"],
    ["XML attributes", "ui"],
    ["Widget API", "ui"],
    ["Widget API/Region", "ui"],
    ["Widget handlers", "ui"],
    ["Widget Anchor Points", "ui"],
    ["MACRO cast", "macro"],
    ["Macro API", "macro"],
    ["Slash commands", "macro"],
    ["World of Warcraft: Cataclysm", "product"],
    ["World of Warcraft: Cataclysm/Press release", "product"],
    ["World of Warcraft: The Board Game", "product"],
    ["Blizzard Entertainment", "real-world"],
    ["Blizzard Entertainment employees", "real-world"],
    ["BlizzCon", "real-world"],
    ["BlizzCon 2009", "real-world"],
    ["BlizzCon 2013/Example panel", "real-world"],
    ["Category:API events", "meta-category"],
    ["Category:AddOns Libraries", "meta-category"],
    ["Category:Patch images", "meta-category"],
    ["Category:Removed in patch 4.0.3a", "meta-category"],
    ["Category:WoW Icons: Ability", "meta-category"],
    ["Category:Blizzard forum posters", "meta-category"],
    ["Category:User:Examplename", "meta-category"],
    ["Category:Interface customization", "meta-category"],
    ["Zone (old)", "legacy-meta"],
    ["Zones by level (old)", "legacy-meta"],
    ["List of slash commands (old)", "legacy-meta"],
  ];

  for (const [title, reason] of positives) {
    test(`${title} -> ${reason}`, () => {
      expect(classifyMetaPage(title)).toBe(reason as never);
    });
  }

  test("underscores in a title are normalised like MediaWiki does", () => {
    expect(classifyMetaPage("Hotfixes/2015_Archive")).toBe("hotfixes");
    expect(classifyMetaPage("API_GetExampleInfo")).toBe("api");
  });
});

describe("classifyMetaPage — negatives", () => {
  const negatives = [
    // Ordinary world pages.
    "Example Zone Beta",
    "Example Person Gamma",
    "Quest:Example Quest Alpha",
    "Category:Example Zone Beta quests",
    // `Patch ` is not a safe prefix on its own: an item can start with it.
    "Patch of Example Bat Hair",
    "Patchwork Example Cloak",
    "Category:Patchwerk",
    // `Widget` alone is UI documentation; an NPC that starts with it is not.
    "Widget the Example Deceased",
    // `* (old)` is a superseded version of a real thing, which is an era
    // problem (`post-wrath.ts`), not an out-of-game one.
    "Example Shield (old)",
    "Quest:Example Quest Alpha (old)",
    // `Blizzard` alone is a spell.
    "Blizzard",
    "Blizzard (example ability)",
    // Lower-cased prefixes are prose, not the wiki's namespace convention.
    "Api of the Example Ancients",
    "Uid of the Example Golem",
    // A genuine in-world travel guide: no safe pattern, deliberately kept.
    "Getting to Example Keep and Example City",
    // Warcraft product names that are not the `World of Warcraft: ` prefix.
    "Warcraft III",
    "",
    "   ",
  ];

  for (const title of negatives) {
    test(`${JSON.stringify(title)} -> null`, () => {
      expect(classifyMetaPage(title)).toBeNull();
    });
  }
});

describe("classifyMetaPage — purity", () => {
  test("the title decides, and nothing else is read", () => {
    // A body that names an addon does not make the page one: the rules read the
    // title, which is what lets the classifier run at query time too.
    expect(classifyMetaPage("Example Zone Beta")).toBeNull();
    expect(classifyMetaPage("Hotfixes/2015 Archive")).toBe("hotfixes");
  });
});
