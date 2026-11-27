import { describe, expect, test } from "bun:test";
import { classifyMetaPage } from "../src/meta-pages";

/**
 * Every title here is either invented or a structural title (a namespace
 * prefix, a template-generated archive name) that carries no game text.
 * One or two titles per rule; the negatives are the near-misses each rule
 * must not catch.
 */

describe("classifyMetaPage", () => {
  test("each rule names its pages and their subpages", () => {
    const positives: [string, string][] = [
      ["Hotfixes/2015 Archive", "hotfixes"],
      ["Patch 3.3.5", "patch-notes"],
      ["Patches/3.x", "patch-notes"],
      ["Patch mirrors (PTR)", "patch-notes"],
      ["List of pop culture references in Warcraft/All", "pop-culture"],
      ["Example Bars (AddOn)/Configuration", "addon"],
      ["API GetExampleInfo", "api"],
      ["Widget API/Region", "ui"],
      ["MACRO cast", "macro"],
      ["World of Warcraft: The Board Game", "product"],
      ["BlizzCon 2013/Example panel", "real-world"],
      ["Category:Removed in patch 4.0.3a", "meta-category"],
      ["Category:User:Examplename", "meta-category"],
      ["Zones by level (old)", "legacy-meta"],
      // Underscores are normalised like MediaWiki does.
      ["API_GetExampleInfo", "api"],
    ];
    for (const [title, reason] of positives) expect({ title, reason: classifyMetaPage(title) }).toEqual({ title, reason: reason as never });
  });

  test("near-misses and world pages are kept", () => {
    const negatives = [
      "Example Zone Beta",
      "Category:Example Zone Beta quests",
      // `Patch ` is not a safe prefix on its own: an item can start with it.
      "Patch of Example Bat Hair",
      "Category:Patchwerk",
      // `Widget` alone is UI documentation; an NPC that starts with it is not.
      "Widget the Example Deceased",
      // `* (old)` is a superseded version of a real thing, which is an era
      // problem (`post-wrath.ts`), not an out-of-game one.
      "Example Shield (old)",
      // `Blizzard` alone is a spell.
      "Blizzard",
      // Lower-cased prefixes are prose, not the wiki's namespace convention.
      "Api of the Example Ancients",
      "",
    ];
    for (const title of negatives) expect({ title, reason: classifyMetaPage(title) }).toEqual({ title, reason: null });
  });
});
