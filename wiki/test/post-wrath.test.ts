/**
 * Page-level admission (`admitPage`) and the signals behind it.
 *
 * Every fixture is invented. No wiki or game text appears in this repository.
 */

import { describe, expect, test } from "bun:test";
import {
  admitPage,
  categoryTitleIsPostWrath,
  CATACLYSM_ANNOUNCED,
  hasClassic2019Signal,
  hasPostWrathSignal,
  hasWrathSignal,
  isPreAnnouncementPage,
  namesAgree,
  pageSubject,
  worldIdVerdict,
  titleIsPostWrathCoinage,
} from "../src/post-wrath";
import type { IdKind } from "../src/ids";

const PROSE = "Example Zone Beta is a starting region full of lorem ipsum.";

/** A page created years before the Cataclysm beta: a page of this world. */
const EARLY = "2006-04-02T11:00:00Z";
/** A page created after the announcement: a page about the world that is coming. */
const LATE = "2010-08-15T11:00:00Z";
/** The BlizzCon week Cataclysm was announced, when the wiki started its stubs. */
const ANNOUNCEMENT_WEEK = "2009-08-22T00:00:00Z";

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
      expect(
        admitPage({
          ns: 0,
          title,
          eraWikitext: wikitext,
          newestWikitext: wikitext,
          firstRevisionAt: LATE,
        }),
      ).toEqual({ admit: false, reason: "dropped_post_wrath" });
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
      admitPage({
        ns: 0,
        title: "Example Zone Beta",
        eraWikitext: PROSE,
        newestWikitext: "Rewritten lorem.",
        firstRevisionAt: EARLY,
      }),
    ).toEqual({ admit: true, reason: "pre_cutoff" });
  });

  test("post_cutoff_wrath_signal: written late, explicitly about this world", () => {
    expect(
      admitPage({
        ns: 0,
        title: "Example Item Zeta",
        eraWikitext: null,
        newestWikitext: `{{itembox|patch=3.0.2}}\n${PROSE}`,
        firstRevisionAt: "2014-02-02T00:00:00Z",
      }),
    ).toEqual({ admit: true, reason: "post_cutoff_wrath_signal" });
  });

  test("post_cutoff_wrath_signal does not admit a Classic 2019 page", () => {
    expect(
      admitPage({
        ns: 0,
        title: "Example Classic realms",
        eraWikitext: null,
        newestWikitext: `{{patchbox|patch=1.13.2}}\n${PROSE}`,
        firstRevisionAt: "2019-09-01T00:00:00Z",
      }),
    ).toEqual({ admit: false, reason: "dropped_post_cutoff" });
  });

  test("dropped_post_cutoff: written late and silent about which world", () => {
    expect(
      admitPage({
        ns: 0,
        title: "Example Late Page",
        eraWikitext: null,
        newestWikitext: PROSE,
        firstRevisionAt: "2015-06-06T00:00:00Z",
      }),
    ).toEqual({ admit: false, reason: "dropped_post_cutoff" });
  });

  test("dropped_post_wrath: a beta stub written before the cutoff", () => {
    expect(
      admitPage({
        ns: 0,
        title: "Example Zone Theta",
        eraWikitext: `{{stub/Cataclysm}}\nExample Zone Theta will open with the next expansion.`,
        newestWikitext: "Example Zone Theta, lorem.",
        firstRevisionAt: LATE,
      }),
    ).toEqual({ admit: false, reason: "dropped_post_wrath" });
  });

  test("dropped_meta: out-of-game, whatever era it names", () => {
    expect(
      admitPage({
        ns: 0,
        title: "Hotfixes/2015 Archive",
        eraWikitext: PROSE,
        newestWikitext: PROSE,
        firstRevisionAt: EARLY,
      }),
    ).toEqual({ admit: false, reason: "dropped_meta" });
    expect(
      admitPage({
        ns: 0,
        title: "API GetSpellInfo",
        eraWikitext: PROSE,
        newestWikitext: PROSE,
        firstRevisionAt: EARLY,
      }),
    ).toEqual({ admit: false, reason: "dropped_meta" });
  });

  test("a late category on a Wrath page does not reach the decision", () => {
    // The signal is read on the revision the prose comes from. A zone that was
    // rewritten for a later expansion had that category added later; the page
    // itself is standing in this world.
    expect(
      admitPage({
        ns: 0,
        title: "Example Zone Beta",
        eraWikitext: PROSE,
        newestWikitext: `${PROSE}\n[[Category:Cataclysm zones]]`,
        firstRevisionAt: EARLY,
      }),
    ).toEqual({ admit: true, reason: "pre_cutoff" });
  });
});

describe("a page that predates the Cataclysm announcement is a Wrath page", () => {
  // The 588-page pocket: a capital or a starting zone whose
  // 2010 editors annotated what was coming, dropped by its own annotation.
  const SIGNALLED = `{{zonebox|patch=4.0.1}}\n${PROSE}\n[[Category:Cataclysm]]`;

  test("a signal on a page created in 2006 does not drop it, and is counted", () => {
    expect(
      admitPage({
        ns: 0,
        title: "Example Capital City",
        eraWikitext: SIGNALLED,
        newestWikitext: SIGNALLED,
        firstRevisionAt: EARLY,
      }),
    ).toEqual({ admit: true, reason: "pre_cutoff", preAnnouncementProtected: true });
  });

  test("the same signal on a page created after the announcement still drops it", () => {
    expect(
      admitPage({
        ns: 0,
        title: "Example Capital City",
        eraWikitext: SIGNALLED,
        newestWikitext: SIGNALLED,
        firstRevisionAt: LATE,
      }),
    ).toEqual({ admit: false, reason: "dropped_post_wrath" });
  });

  test("the announcement week is already too late to protect", () => {
    // The wiki started stubs for the announced expansion the same week, and a
    // page created then is a page about it, not a page that acquired it.
    expect(
      admitPage({
        ns: 0,
        title: "Example Raid Epsilon",
        eraWikitext: SIGNALLED,
        newestWikitext: SIGNALLED,
        firstRevisionAt: ANNOUNCEMENT_WEEK,
      }),
    ).toEqual({ admit: false, reason: "dropped_post_wrath" });
    expect(isPreAnnouncementPage(ANNOUNCEMENT_WEEK)).toBe(false);
  });

  test("protection is not a flag on a page with no signal", () => {
    expect(
      admitPage({
        ns: 0,
        title: "Example Zone Beta",
        eraWikitext: PROSE,
        newestWikitext: PROSE,
        firstRevisionAt: EARLY,
      }),
    ).toEqual({ admit: true, reason: "pre_cutoff" });
  });

  test("out-of-game still wins over protection", () => {
    expect(
      admitPage({
        ns: 0,
        title: "API GetSpellInfo",
        eraWikitext: SIGNALLED,
        newestWikitext: SIGNALLED,
        firstRevisionAt: EARLY,
      }),
    ).toEqual({ admit: false, reason: "dropped_meta" });
  });

  test("a dump that states no creation date protects nothing", () => {
    expect(isPreAnnouncementPage("")).toBe(false);
    expect(isPreAnnouncementPage(EARLY)).toBe(true);
    expect(isPreAnnouncementPage(CATACLYSM_ANNOUNCED)).toBe(false);
    expect(isPreAnnouncementPage(LATE)).toBe(false);
    expect(
      admitPage({
        ns: 0,
        title: "Example Zone Theta",
        eraWikitext: SIGNALLED,
        newestWikitext: SIGNALLED,
        firstRevisionAt: "",
      }),
    ).toEqual({ admit: false, reason: "dropped_post_wrath" });
  });
});

describe("a page with no pre-cutoff prose is dropped_post_cutoff", () => {
  // The counter fix: the reason a late page is not in the bundle is that this
  // world's wiki does not have it, whether or not it also names a later
  // expansion. The admitted set is unchanged — the post-Wrath signal still
  // vetoes the Wrath-signal admission.
  test("a late page carrying a post-Wrath signal counts as post-cutoff", () => {
    expect(
      admitPage({
        ns: 0,
        title: "Example Zone Theta",
        eraWikitext: null,
        newestWikitext: `{{stub/Cataclysm}}\n${PROSE}`,
        firstRevisionAt: "2012-01-01T00:00:00Z",
      }),
    ).toEqual({ admit: false, reason: "dropped_post_cutoff" });
  });

  test("a late page carrying both signals is still not admitted", () => {
    expect(
      admitPage({
        ns: 0,
        title: "Example Zone Theta",
        eraWikitext: null,
        newestWikitext: `{{zonebox|patch=4.0.1|expansion=Wrath of the Lich King}}\n${PROSE}`,
        firstRevisionAt: "2012-01-01T00:00:00Z",
      }),
    ).toEqual({ admit: false, reason: "dropped_post_cutoff" });
  });

  test("a pre-announcement creation date does not admit a page with no pre-cutoff prose", () => {
    // Protection is about a page's own prose surviving; there is none here.
    expect(
      admitPage({
        ns: 0,
        title: "Example Zone Theta",
        eraWikitext: null,
        newestWikitext: `{{stub/Cataclysm}}\n${PROSE}`,
        firstRevisionAt: EARLY,
      }),
    ).toEqual({ admit: false, reason: "dropped_post_cutoff" });
  });
});

/**
 * The page whose pre-cutoff revisions all failed the parser's hygiene rules —
 * every one of them a redirect or a reverted edit. It has pre-cutoff history and
 * no pre-cutoff prose, and the rule that drops it used to live in the build loop.
 */
describe("pre-cutoff revisions that left no prose", () => {
  const WRATH = `{{itembox|patch=3.0.2}}\n${PROSE}`;

  test("an explicit Wrath signal on the newest revision does not admit it", () => {
    // The same input without the pre-cutoff history is admitted; what the newest
    // revision says cannot supply prose the page does not have.
    expect(
      admitPage({
        ns: 0,
        title: "Example Zone Theta",
        eraWikitext: null,
        hasEraRevision: false,
        newestWikitext: WRATH,
        firstRevisionAt: "2012-01-01T00:00:00Z",
      }),
    ).toEqual({ admit: true, reason: "post_cutoff_wrath_signal" });
    expect(
      admitPage({
        ns: 0,
        title: "Example Zone Theta",
        eraWikitext: null,
        hasEraRevision: true,
        newestWikitext: WRATH,
        firstRevisionAt: "2012-01-01T00:00:00Z",
      }),
    ).toEqual({
      admit: false,
      reason: "dropped_post_cutoff",
      eraRevisionsRejected: true,
    });
  });

  test("an id this server has does not admit it either", () => {
    const worldIds = {
      name(kind: IdKind, id: number): string | undefined {
        return kind === "quest" && id === 4242 ? "Example Quest Alpha" : undefined;
      },
    };
    expect(
      admitPage({
        ns: 118,
        title: "Quest:Example Quest Alpha",
        eraWikitext: null,
        hasEraRevision: true,
        newestWikitext: `{{questbox|id=4242}}\n${PROSE}`,
        firstRevisionAt: "2016-06-06T00:00:00Z",
        worldIds,
      }),
    ).toEqual({
      admit: false,
      reason: "dropped_post_cutoff",
      eraRevisionsRejected: true,
    });
  });

  test("a page the newest revision drops on its own is not flagged", () => {
    // The flag says "dropped for having no prose", which is what stops the
    // build recovering the title as a name. A page that would have been dropped
    // anyway is an ordinary drop and keeps that recovery.
    expect(
      admitPage({
        ns: 0,
        title: "Example Zone Theta",
        eraWikitext: null,
        hasEraRevision: true,
        newestWikitext: `{{stub/Cataclysm}}\n${PROSE}`,
        firstRevisionAt: "2012-01-01T00:00:00Z",
      }),
    ).toEqual({ admit: false, reason: "dropped_post_cutoff" });
  });
});

describe("a category page's own title", () => {
  const CATEGORY_PROSE = "Pages about the example subject.";

  const fires: [string, string][] = [
    ["Category:Deepholm quests", "a zone the next expansion coined"],
    ["Category:Ruins of Gilneas", "a place name that exists only after the Shattering"],
    ["Category:Uldum NPCs", "a zone Cataclysm opened"],
    ["Category:Vashj'ir", "an ocean zone with no Wrath-era page"],
    ["Category:Kelp'thar Forest mobs", "a Vashj'ir subzone"],
    ["Category:Archaeology", "a Cataclysm secondary profession"],
    ["Category:Mount Hyjal quests", "the ns-14 side of a name that has Wrath lore in ns 0"],
    ["Category:Lost Isles", "the goblin starting zone"],
    ["Category:Legion", "the expansion, named exactly"],
    ["Category:Legion dungeons", "the expansion, as a prefix"],
    ["Category:Mists of Pandaria items", "a later expansion still"],
  ];
  for (const [title, why] of fires) {
    test(`${title} — ${why}`, () => {
      expect(hasPostWrathSignal(title, CATEGORY_PROSE, 14)).toBe(true);
      expect(
        admitPage({
          ns: 14,
          title,
          eraWikitext: CATEGORY_PROSE,
          newestWikitext: CATEGORY_PROSE,
          firstRevisionAt: LATE,
        }),
      ).toEqual({ admit: false, reason: "dropped_post_wrath" });
    });
  }

  const keeps: [string, string][] = [
    ["Category:Burning Legion", "the army, which is in this world"],
    ["Category:7th Legion", "a Wrath-era faction whose name ends in the word"],
    ["Category:Elwynn Forest quests", "an ordinary Wrath category"],
    ["Category:Legion's Bane", "an apostrophe, not a space"],
  ];
  for (const [title, why] of keeps) {
    test(`${title} stays — ${why}`, () => {
      expect(hasPostWrathSignal(title, CATEGORY_PROSE, 14)).toBe(false);
    });
  }

  test("the rule is ns 14 only: an article named for a later zone keeps its Wrath lore", () => {
    // Mount Hyjal, Tol Barad and Gilneas all have pre-2010 lore pages, which is
    // why `verify.ts` refuses to list them as forbidden titles.
    for (const title of ["Mount Hyjal", "Tol Barad", "Gilneas", "Uldum"]) {
      expect(hasPostWrathSignal(title, PROSE, 0)).toBe(false);
      expect(
        admitPage({
          ns: 0,
          title,
          eraWikitext: PROSE,
          newestWikitext: PROSE,
          firstRevisionAt: LATE,
        }).admit,
      ).toBe(true);
    }
  });

  test("the namespace is checked inside the rule, not at the call site", () => {
    expect(categoryTitleIsPostWrath(14, "Category:Deepholm")).toBe(true);
    expect(categoryTitleIsPostWrath(0, "Category:Deepholm")).toBe(false);
    expect(categoryTitleIsPostWrath(118, "Deepholm")).toBe(false);
    // The namespace defaults to 0, so a caller that omits it gets the old rules.
    expect(hasPostWrathSignal("Category:Deepholm", CATEGORY_PROSE)).toBe(false);
  });
});

describe("a subpage named for a later expansion", () => {
  const fires = [
    "Global functions/Cataclysm",
    "Macro commands/Mists of Pandaria",
    "API/Legion",
    "Widget handlers/Battle for Azeroth/Frames",
  ];
  for (const title of fires) {
    test(`${title} is the later client's fork of the page`, () => {
      expect(hasPostWrathSignal(title, PROSE)).toBe(true);
      expect(
        admitPage({
          ns: 0,
          title,
          eraWikitext: PROSE,
          newestWikitext: PROSE,
          firstRevisionAt: LATE,
        }),
      ).toEqual({ admit: false, reason: "dropped_post_wrath" });
    });
  }

  test("the parent page and a Wrath-era fork are untouched", () => {
    for (const title of [
      "Global functions",
      "Global functions/Wrath of the Lich King",
      "Example Legionnaire/Tactics",
    ]) {
      expect(hasPostWrathSignal(title, PROSE)).toBe(false);
    }
  });
});

/**
 * Titles a later expansion coined outright. Real names, invented prose: the
 * rule *is* a list of names, and the same names are already in `verify.ts`.
 */
describe("a main-namespace title that is a Cataclysm coinage", () => {
  const drops = [
    "Southern Barrens",
    "Northern Barrens",
    "Twilight Highlands",
    "Vashj'ir",
    "Kelp'thar Forest",
    "Shimmering Expanse",
    "Abyssal Depths",
    "The Lost Isles",
    "Lost Isles",
    "Molten Front",
    "Tol Barad Peninsula",
  ];
  for (const title of drops) {
    test(`${title} is dropped even though the page predates the announcement`, () => {
      expect(titleIsPostWrathCoinage(0, title)).toBe(true);
      // Plain prose, no signal on the revision, and a page older than the
      // announcement: every other rule would keep this.
      expect(
        admitPage({
          ns: 0,
          title,
          eraWikitext: PROSE,
          newestWikitext: PROSE,
          firstRevisionAt: EARLY,
        }),
      ).toEqual({ admit: false, reason: "dropped_post_wrath" });
    });
  }

  test("a name older than the expansion that took it is not on the list", () => {
    for (const title of [
      "Deepholm",
      "Uldum",
      "Kezan",
      "Gilneas",
      "Mount Hyjal",
      "Tol Barad",
      "Grim Batol",
      "The Barrens",
    ]) {
      expect(titleIsPostWrathCoinage(0, title)).toBe(false);
    }
  });

  test("it is a main-namespace rule; the category rule reads its own list", () => {
    expect(titleIsPostWrathCoinage(14, "Southern Barrens")).toBe(false);
    expect(titleIsPostWrathCoinage(118, "Southern Barrens")).toBe(false);
  });

  test("underscores and case are the same title", () => {
    expect(titleIsPostWrathCoinage(0, "southern_barrens")).toBe(true);
  });
});

/**
 * The world-id door: a page written after the cutoff that says
 * nothing about its era is admitted when an id it states about itself exists in
 * this server's 3.3.5a world DB **and the DB's name for that id is what the
 * page is about**.
 *
 * The oracle is passed in as data, so these tests need no export file and no
 * server. Every id and name below is invented.
 */
describe("post_cutoff_id_match", () => {
  /** An oracle over four invented id→name maps, one per world-DB table. */
  const oracle = {
    name(kind: IdKind, id: number): string | undefined {
      const maps: Partial<Record<IdKind, Record<number, string>>> = {
        quest: { 4242: "Example Quest Alpha" },
        npc: { 7001: "Example Guard", 7002: "Example Other Guard" },
        item: { 9100: "Example Trinket", 9101: "Example Faire Carnie" },
        object: { 3300: "Example Node" },
      };
      return (maps[kind] ?? {})[id];
    },
  };

  const late = (title: string, newestWikitext: string, worldIds = oracle) =>
    admitPage({
      ns: 0,
      title,
      eraWikitext: null,
      newestWikitext,
      firstRevisionAt: "2016-06-06T00:00:00Z",
      worldIds,
    });

  test("a page whose stated id is on this server, under its own name, is admitted", () => {
    // The ids come back with the decision: the door already extracted them from
    // this wikitext, and `build.ts` writes exactly these rather than re-reading it.
    expect(late("Example Quest Alpha", `{{questbox|id=4242}}\n${PROSE}`)).toEqual({
      admit: true,
      reason: "post_cutoff_id_match",
      ids: [{ kind: "quest", id: 4242 }],
    });
  });

  test("every kind the world DB has a table for maps through", () => {
    expect(late("Example Guard", `{{npcbox|id=7001}}\n${PROSE}`).reason).toBe(
      "post_cutoff_id_match",
    );
    expect(late("Example Trinket", `{{itembox|itemid=9100}}\n${PROSE}`).reason).toBe(
      "post_cutoff_id_match",
    );
    expect(late("Example Node", `{{objectbox|id=3300}}\n${PROSE}`).reason).toBe(
      "post_cutoff_id_match",
    );
  });

  test("an id this server does not have is no evidence", () => {
    expect(late("Example Quest Omega", `{{questbox|id=4243}}\n${PROSE}`)).toEqual({
      admit: false,
      reason: "dropped_post_cutoff",
    });
  });

  test("an id this server has under another name does not admit, and is counted", () => {
    // The shape of every false admit the id-only rule made: a later page states
    // the entry of the thing it replaced, or copy-pastes another page's infobox.
    expect(late("Example Later Boss", `{{npcbox|id=7001}}\n${PROSE}`)).toEqual({
      admit: false,
      reason: "dropped_post_cutoff",
      idNameMismatch: true,
    });
  });

  test("a page that states no id at all is not a mismatch", () => {
    // `pages_id_name_mismatch` is about ids that resolved, so it stays readable
    // as "pages the name rule refused" rather than "late pages".
    expect(late("Example Lore Page", PROSE)).toEqual({
      admit: false,
      reason: "dropped_post_cutoff",
    });
  });

  test("one agreeing id is enough, whatever else the page states", () => {
    expect(
      late("Example Guard", `{{npcbox|id=7002}}{{npcbox|npcid=7001}}\n${PROSE}`).reason,
    ).toBe("post_cutoff_id_match");
  });

  test("spell and unknown ids never resolve: neither is in the world DB", () => {
    // The same number, stated as a spell and as a bare id in a template that
    // implies no kind. Spells live in the client's DBC files, so the world DB's
    // silence about one says nothing, and an unknown kind is a number the page
    // did not classify. `world-ids.ts` is where that guarantee lives; here the
    // oracle would answer for any other kind, and the page is still dropped.
    const anyKindButThose = {
      name(kind: IdKind, id: number): string | undefined {
        return id === 4242 && kind !== "spell" && kind !== "unknown" ? "Example Ability" : undefined;
      },
    };
    expect(late("Example Ability", `{{spellbox|id=4242}}\n${PROSE}`, anyKindButThose).reason).toBe(
      "dropped_post_cutoff",
    );
    expect(late("Example Ability", `{{infobox|id=4242}}\n${PROSE}`, anyKindButThose).reason).toBe(
      "dropped_post_cutoff",
    );
  });

  test("a post-Wrath signal outranks the id: a reused id admits nothing", () => {
    expect(
      late(
        "Example Quest Alpha",
        `{{questbox|id=4242}}\n[[Category:Cataclysm quests]]\n${PROSE}`,
      ),
    ).toEqual({ admit: false, reason: "dropped_post_cutoff" });
  });

  test("a Classic 2019 page is vetoed the same way", () => {
    expect(late("Example Classic quest", `{{questbox|id=4242}}\n${PROSE}`)).toEqual({
      admit: false,
      reason: "dropped_post_cutoff",
    });
  });

  test("a coinage title is vetoed before any of it", () => {
    expect(late("Vashj'ir", `{{questbox|id=4242}}\n${PROSE}`)).toEqual({
      admit: false,
      reason: "dropped_post_wrath",
    });
  });

  test("an explicit Wrath signal still wins the reason", () => {
    // Both doors would admit; the page says what it is, so it is counted for
    // saying it rather than for the id.
    expect(
      late("Example Trinket", `{{itembox|patch=3.0.2|itemid=9100}}\n${PROSE}`).reason,
    ).toBe("post_cutoff_wrath_signal");
  });

  test("without an oracle the door does not exist", () => {
    expect(
      admitPage({
        ns: 0,
        title: "Example Quest Alpha",
        eraWikitext: null,
        newestWikitext: `{{questbox|id=4242}}\n${PROSE}`,
        firstRevisionAt: "2016-06-06T00:00:00Z",
      }),
    ).toEqual({ admit: false, reason: "dropped_post_cutoff" });
  });

  test("a page with pre-cutoff prose is decided by the cutoff, not the id", () => {
    expect(
      admitPage({
        ns: 0,
        title: "Example Zone Beta",
        eraWikitext: PROSE,
        newestWikitext: `{{questbox|id=4242}}\n${PROSE}`,
        firstRevisionAt: EARLY,
        worldIds: oracle,
      }),
    ).toEqual({ admit: true, reason: "pre_cutoff" });
  });

  test("a quest page compares against the log title, prefix stripped", () => {
    expect(
      admitPage({
        ns: 118,
        title: "Quest:Example Quest Alpha",
        eraWikitext: null,
        newestWikitext: `{{questbox|id=4242}}\n${PROSE}`,
        firstRevisionAt: "2016-06-06T00:00:00Z",
        worldIds: oracle,
      }).reason,
    ).toBe("post_cutoff_id_match");
  });
});

describe("pageSubject", () => {
  test("the namespace prefix the dump writes into the title comes off", () => {
    expect(pageSubject("Quest:Example Quest Alpha")).toBe("Example Quest Alpha");
    expect(pageSubject("Category:Example Zone Beta")).toBe("Example Zone Beta");
    expect(pageSubject("Portal:Example Zone Beta")).toBe("Example Zone Beta");
  });

  test("disambiguating parentheticals come off, however many", () => {
    // Wiki bookkeeping about which article this is, never part of the name.
    expect(pageSubject("Example Guard (mob)")).toBe("Example Guard");
    expect(pageSubject("Example Guard (tactics)")).toBe("Example Guard");
    expect(pageSubject("Example Guard (Alliance)")).toBe("Example Guard");
    expect(pageSubject("Example Guard (4)")).toBe("Example Guard");
    expect(pageSubject("Example Guard (mob) (old)")).toBe("Example Guard");
  });

  test("a parenthetical that is not a suffix stays: it is part of the name", () => {
    expect(pageSubject("Example (Big) Guard")).toBe("Example (Big) Guard");
  });
});

describe("namesAgree", () => {
  test("case, punctuation and spacing are ornament", () => {
    expect(namesAgree("Example Guard", "example guard")).toBe(true);
    expect(namesAgree("Zim'Torga's Keeper", "Zim'Torgas Keeper")).toBe(true);
    expect(namesAgree("Example  Guard", "Example Guard")).toBe(true);
  });

  test("one name's words being all of the other's is agreement", () => {
    // The wiki and the DB disagree on ornament far more often than on substance.
    expect(namesAgree("Example Carnie", "Example Faire Carnie")).toBe(true);
    expect(namesAgree("Example Guard/PI", "Example Guard")).toBe(true);
    expect(namesAgree("Turgid the Vile", "Turgid")).toBe(true);
  });

  test("different names do not agree", () => {
    expect(namesAgree("Example Boss", "Example Guard")).toBe(false);
    expect(namesAgree("Example Quest Alpha", "Example Quest Beta")).toBe(false);
  });

  test("the loose side of the rule, stated: an inserted word still agrees", () => {
    // `Example Guard` and `Example Other Guard` agree, because one name's words
    // are all of the other's. That is the same clause that makes
    // `Darkmoon Carnie` agree with `Darkmoon Faire Carnie`, which is the case
    // the rule is for; the residue it accepts is a page whose subject is a
    // strict word-subset of a different entity's name. Measured over the real
    // dump it costs ~15 pages, and every alternative measured cost more real
    // ones than it saved.
    expect(namesAgree("Example Guard", "Example Other Guard")).toBe(true);
  });

  test("words, not substrings: a rule on substrings matches inside a word", () => {
    expect(namesAgree("Carn", "Example Carnie")).toBe(false);
    expect(namesAgree("Adam", "Adamant Guard")).toBe(false);
  });

  test("an empty side never agrees", () => {
    expect(namesAgree("", "Example Guard")).toBe(false);
    expect(namesAgree("Example Guard", "")).toBe(false);
    expect(namesAgree("!!!", "Example Guard")).toBe(false);
  });
});

describe("worldIdVerdict", () => {
  const oracle = {
    name(kind: IdKind, id: number): string | undefined {
      return kind === "npc" && id === 7001 ? "Example Guard" : undefined;
    },
  };

  test("the three outcomes are match, mismatch and no id", () => {
    expect(worldIdVerdict("Example Guard", "{{npcbox|id=7001}}", oracle).verdict).toBe("match");
    expect(worldIdVerdict("Example Boss", "{{npcbox|id=7001}}", oracle).verdict).toBe("mismatch");
    expect(worldIdVerdict("Example Guard", "{{npcbox|id=7009}}", oracle).verdict).toBe("no id");
    expect(worldIdVerdict("Example Guard", PROSE, oracle).verdict).toBe("no id");
  });

  test("the ids it read come back with the verdict, so the caller reads them once", () => {
    // `build.ts` writes these to the bundle; extracting them again would be a
    // second scan of the same wikitext.
    expect(worldIdVerdict("Example Guard", "{{npcbox|id=7001}}", oracle).ids).toEqual([
      { kind: "npc", id: 7001 },
    ]);
  });
});
