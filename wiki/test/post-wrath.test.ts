/**
 * Page-level admission (`admitPage`) and the signals behind it.
 *
 * Every fixture is invented. No wiki or game text appears in this repository.
 * Each rule is carried by a few representative cases and the near-misses it
 * must not catch, not by a case per page.
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

/** A page whose one revision is both its era and its newest text. */
const page = (title: string, wikitext: string, firstRevisionAt: string, ns = 0) =>
  admitPage({ ns, title, eraWikitext: wikitext, newestWikitext: wikitext, firstRevisionAt });

describe("post-Wrath page signals", () => {
  test("fire on a title parenthetical, a category, a banner, a patch or an expansion field", () => {
    const fires: [string, string][] = [
      ["Example Zone Beta (Legion)/Quests", PROSE],
      ["Example Zone Beta", `${PROSE}\n[[Category:Cataclysm zones]]`],
      ["Example Zone Beta", `${PROSE}\n[[Category:Legion]]`],
      ["Example Zone Beta", `{{stub/Cataclysm}}\n${PROSE}`],
      ["Example Zone Beta", `{{DraenorZone}}\n${PROSE}`],
      ["Example Zone Beta", `{{zonebox|patch=4.0.3a}}\n${PROSE}`],
      ["Example Zone Beta", `{{zonebox|expansion=Mists of Pandaria}}\n${PROSE}`],
    ];
    for (const [title, wikitext] of fires) {
      expect({ wikitext, fires: hasPostWrathSignal(title, wikitext) }).toEqual({ wikitext, fires: true });
      expect(page(title, wikitext, LATE)).toEqual({ admit: false, reason: "dropped_post_wrath" });
    }
  });

  test("do not fire on Wrath-era content a careless rule would delete", () => {
    // The Burning Legion, Deathwing, Draenor and the 7th Legion are all in 3.3.5.
    const quiet: [string, string][] = [
      ["Example Item Zeta", `{{Removedwithcataclysm}}\n${PROSE}`],
      ["Example Person Gamma", `{{legion-inline}} ${PROSE}`],
      ["Example Zone Beta", `{{Legion-section}}\n${PROSE}`],
      ["Example Zone Beta", `${PROSE}\n[[Category:Burning Legion]]`],
      ["Example Person Gamma", `${PROSE}\n[[Category:7th Legion]]`],
      ["Example Item Zeta", `${PROSE}\n[[Category:Legion's Bane items]]`],
      ["Example Zone Beta", `${PROSE}\n[[Category:Draenor]]`],
      ["Example Zone Beta", `{{zonebox|patch=3.3.0}}\n${PROSE}`],
    ];
    for (const [title, wikitext] of quiet) expect({ wikitext, fires: hasPostWrathSignal(title, wikitext) }).toEqual({ wikitext, fires: false });
  });
});

describe("Wrath-or-earlier signals", () => {
  test("a patch below 4.0, an expansion field or a named category is one; prose alone is not", () => {
    expect(hasWrathSignal(`{{itembox|patch=3.0.2}}\n${PROSE}`)).toBe(true);
    expect(hasWrathSignal(`{{zonebox|expansion=The Burning Crusade}}\n${PROSE}`)).toBe(true);
    expect(hasWrathSignal(`${PROSE}\n[[Category:Wrath of the Lich King]]`)).toBe(true);
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
      admitPage({ ns: 0, title: "Example Zone Beta", eraWikitext: PROSE, newestWikitext: "Rewritten lorem.", firstRevisionAt: EARLY }),
    ).toEqual({ admit: true, reason: "pre_cutoff" });
  });

  test("post_cutoff_wrath_signal: written late, explicitly about this world, but never a Classic 2019 page", () => {
    expect(
      admitPage({
        ns: 0,
        title: "Example Item Zeta",
        eraWikitext: null,
        newestWikitext: `{{itembox|patch=3.0.2}}\n${PROSE}`,
        firstRevisionAt: "2014-02-02T00:00:00Z",
      }),
    ).toEqual({ admit: true, reason: "post_cutoff_wrath_signal" });
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
      admitPage({ ns: 0, title: "Example Late Page", eraWikitext: null, newestWikitext: PROSE, firstRevisionAt: "2015-06-06T00:00:00Z" }),
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
    expect(page("Hotfixes/2015 Archive", PROSE, EARLY)).toEqual({ admit: false, reason: "dropped_meta" });
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
  // A capital or a starting zone whose 2010 editors annotated what was coming,
  // dropped by its own annotation.
  const SIGNALLED = `{{zonebox|patch=4.0.1}}\n${PROSE}\n[[Category:Cataclysm]]`;

  test("a signal on a page created in 2006 does not drop it, and is counted", () => {
    expect(page("Example Capital City", SIGNALLED, EARLY)).toEqual({ admit: true, reason: "pre_cutoff", preAnnouncementProtected: true });
  });

  test("the same signal on a page created after the announcement still drops it", () => {
    expect(page("Example Capital City", SIGNALLED, LATE)).toEqual({ admit: false, reason: "dropped_post_wrath" });
  });

  test("the announcement week is already too late to protect, and so is a dump that states no date", () => {
    // The wiki started stubs for the announced expansion the same week, and a
    // page created then is a page about it, not a page that acquired it.
    expect(page("Example Raid Epsilon", SIGNALLED, ANNOUNCEMENT_WEEK)).toEqual({ admit: false, reason: "dropped_post_wrath" });
    expect(page("Example Zone Theta", SIGNALLED, "")).toEqual({ admit: false, reason: "dropped_post_wrath" });
    expect(isPreAnnouncementPage(ANNOUNCEMENT_WEEK)).toBe(false);
    expect(isPreAnnouncementPage(CATACLYSM_ANNOUNCED)).toBe(false);
    expect(isPreAnnouncementPage("")).toBe(false);
    expect(isPreAnnouncementPage(EARLY)).toBe(true);
  });

  test("out-of-game still wins over protection", () => {
    expect(page("API GetSpellInfo", SIGNALLED, EARLY)).toEqual({ admit: false, reason: "dropped_meta" });
  });
});

describe("a page with no pre-cutoff prose is dropped_post_cutoff", () => {
  // The reason a late page is not in the bundle is that this world's wiki does
  // not have it, whether or not it also names a later expansion. The post-Wrath
  // signal still vetoes the Wrath-signal admission, and a pre-announcement
  // creation date protects a page's own prose, of which there is none here.
  test("whatever signals it carries and whenever it was created", () => {
    const late = (newestWikitext: string, firstRevisionAt: string) =>
      admitPage({ ns: 0, title: "Example Zone Theta", eraWikitext: null, newestWikitext, firstRevisionAt });
    expect(late(`{{stub/Cataclysm}}\n${PROSE}`, "2012-01-01T00:00:00Z")).toEqual({ admit: false, reason: "dropped_post_cutoff" });
    expect(late(`{{zonebox|patch=4.0.1|expansion=Wrath of the Lich King}}\n${PROSE}`, "2012-01-01T00:00:00Z")).toEqual({
      admit: false,
      reason: "dropped_post_cutoff",
    });
    expect(late(`{{stub/Cataclysm}}\n${PROSE}`, EARLY)).toEqual({ admit: false, reason: "dropped_post_cutoff" });
  });
});

/**
 * The page whose pre-cutoff revisions all failed the parser's hygiene rules —
 * every one of them a redirect or a reverted edit. It has pre-cutoff history and
 * no pre-cutoff prose.
 */
describe("pre-cutoff revisions that left no prose", () => {
  test("neither an explicit Wrath signal nor an id this server has admits it, and it is flagged", () => {
    // The same input without the pre-cutoff history is admitted; what the newest
    // revision says cannot supply prose the page does not have.
    const WRATH = `{{itembox|patch=3.0.2}}\n${PROSE}`;
    const at = (hasEraRevision: boolean) =>
      admitPage({ ns: 0, title: "Example Zone Theta", eraWikitext: null, hasEraRevision, newestWikitext: WRATH, firstRevisionAt: "2012-01-01T00:00:00Z" });
    expect(at(false)).toEqual({ admit: true, reason: "post_cutoff_wrath_signal" });
    expect(at(true)).toEqual({ admit: false, reason: "dropped_post_cutoff", eraRevisionsRejected: true });
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
    ).toEqual({ admit: false, reason: "dropped_post_cutoff", eraRevisionsRejected: true });
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

  test("a later zone, profession or expansion in a category title drops it", () => {
    for (const title of ["Category:Deepholm quests", "Category:Kelp'thar Forest mobs", "Category:Archaeology", "Category:Mount Hyjal quests", "Category:Legion dungeons"]) {
      expect({ title, fires: hasPostWrathSignal(title, CATEGORY_PROSE, 14) }).toEqual({ title, fires: true });
      expect(page(title, CATEGORY_PROSE, LATE, 14)).toEqual({ admit: false, reason: "dropped_post_wrath" });
    }
  });

  test("this world's categories that share a word stay", () => {
    for (const title of ["Category:Burning Legion", "Category:7th Legion", "Category:Elwynn Forest quests", "Category:Legion's Bane"]) {
      expect({ title, fires: hasPostWrathSignal(title, CATEGORY_PROSE, 14) }).toEqual({ title, fires: false });
    }
  });

  test("the rule is ns 14 only: an article named for a later zone keeps its Wrath lore", () => {
    // Mount Hyjal, Tol Barad and Gilneas all have pre-2010 lore pages, which is
    // why `verify.ts` refuses to list them as forbidden titles.
    for (const title of ["Mount Hyjal", "Tol Barad", "Gilneas", "Uldum"]) {
      expect(hasPostWrathSignal(title, PROSE, 0)).toBe(false);
      expect(page(title, PROSE, LATE).admit).toBe(true);
    }
    expect(categoryTitleIsPostWrath(0, "Category:Deepholm")).toBe(false);
    expect(hasPostWrathSignal("Category:Deepholm", CATEGORY_PROSE)).toBe(false);
  });
});

describe("a subpage named for a later expansion", () => {
  test("is the later client's fork of the page; the parent and a Wrath-era fork are untouched", () => {
    for (const title of ["Global functions/Cataclysm", "Widget handlers/Battle for Azeroth/Frames"]) {
      expect(hasPostWrathSignal(title, PROSE)).toBe(true);
      expect(page(title, PROSE, LATE)).toEqual({ admit: false, reason: "dropped_post_wrath" });
    }
    for (const title of ["Global functions", "Global functions/Wrath of the Lich King", "Example Legionnaire/Tactics"]) {
      expect({ title, fires: hasPostWrathSignal(title, PROSE) }).toEqual({ title, fires: false });
    }
  });
});

/**
 * Titles a later expansion coined outright. Real names, invented prose: the
 * rule *is* a list of names, and the same names are already in `verify.ts`.
 */
describe("a main-namespace title that is a Cataclysm coinage", () => {
  test("is dropped even though the page predates the announcement", () => {
    // Plain prose, no signal on the revision, and a page older than the
    // announcement: every other rule would keep this.
    for (const title of ["Southern Barrens", "Vashj'ir", "The Lost Isles"]) {
      expect(titleIsPostWrathCoinage(0, title)).toBe(true);
      expect(page(title, PROSE, EARLY)).toEqual({ admit: false, reason: "dropped_post_wrath" });
    }
    // Underscores and case are the same title.
    expect(titleIsPostWrathCoinage(0, "southern_barrens")).toBe(true);
  });

  test("a name older than the expansion that took it is not on the list, and the rule is main-namespace only", () => {
    for (const title of ["Deepholm", "Gilneas", "Mount Hyjal", "The Barrens"]) {
      expect({ title, coined: titleIsPostWrathCoinage(0, title) }).toEqual({ title, coined: false });
    }
    expect(titleIsPostWrathCoinage(14, "Southern Barrens")).toBe(false);
    expect(titleIsPostWrathCoinage(118, "Southern Barrens")).toBe(false);
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

  const late = (title: string, newestWikitext: string, worldIds: typeof oracle | null = oracle, ns = 0) =>
    admitPage({
      ns,
      title,
      eraWikitext: null,
      newestWikitext,
      firstRevisionAt: "2016-06-06T00:00:00Z",
      ...(worldIds === null ? {} : { worldIds }),
    });

  test("a page whose stated id is on this server, under its own name, is admitted, with the ids", () => {
    // The ids come back with the decision: `build.ts` writes exactly these
    // rather than re-reading the wikitext.
    expect(late("Example Quest Alpha", `{{questbox|id=4242}}\n${PROSE}`)).toEqual({
      admit: true,
      reason: "post_cutoff_id_match",
      ids: [{ kind: "quest", id: 4242 }],
    });
    // Every kind the world DB has a table for maps through.
    expect(late("Example Guard", `{{npcbox|id=7001}}\n${PROSE}`).reason).toBe("post_cutoff_id_match");
    expect(late("Example Trinket", `{{itembox|itemid=9100}}\n${PROSE}`).reason).toBe("post_cutoff_id_match");
    expect(late("Example Node", `{{objectbox|id=3300}}\n${PROSE}`).reason).toBe("post_cutoff_id_match");
    // A quest page compares against the log title, prefix stripped.
    expect(late("Quest:Example Quest Alpha", `{{questbox|id=4242}}\n${PROSE}`, oracle, 118).reason).toBe("post_cutoff_id_match");
  });

  test("an id this server does not have, or a page with no id, is no evidence and no mismatch", () => {
    expect(late("Example Quest Omega", `{{questbox|id=4243}}\n${PROSE}`)).toEqual({ admit: false, reason: "dropped_post_cutoff" });
    expect(late("Example Lore Page", PROSE)).toEqual({ admit: false, reason: "dropped_post_cutoff" });
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

  test("one agreeing id is enough, whatever else the page states", () => {
    expect(late("Example Guard", `{{npcbox|id=7002}}{{npcbox|npcid=7001}}\n${PROSE}`).reason).toBe("post_cutoff_id_match");
  });

  test("spell and unknown ids never resolve: neither is in the world DB", () => {
    // Spells live in the client's DBC files, so the world DB's silence about one
    // says nothing, and an unknown kind is a number the page did not classify.
    const anyKindButThose = {
      name(kind: IdKind, id: number): string | undefined {
        return id === 4242 && kind !== "spell" && kind !== "unknown" ? "Example Ability" : undefined;
      },
    };
    expect(late("Example Ability", `{{spellbox|id=4242}}\n${PROSE}`, anyKindButThose).reason).toBe("dropped_post_cutoff");
    expect(late("Example Ability", `{{infobox|id=4242}}\n${PROSE}`, anyKindButThose).reason).toBe("dropped_post_cutoff");
  });

  test("a post-Wrath signal outranks the id, and a coinage title is vetoed before any of it", () => {
    expect(late("Example Quest Alpha", `{{questbox|id=4242}}\n[[Category:Cataclysm quests]]\n${PROSE}`)).toEqual({
      admit: false,
      reason: "dropped_post_cutoff",
    });
    expect(late("Vashj'ir", `{{questbox|id=4242}}\n${PROSE}`)).toEqual({ admit: false, reason: "dropped_post_wrath" });
  });

  test("a Classic 2019 page is vetoed even when its id and name agree", () => {
    const classic = `{{questbox|id=4242}}\n${PROSE}\n[[Category:World of Warcraft: Classic patches]]`;
    // Only the Classic veto stands between this page and an id match.
    expect(hasPostWrathSignal("Example Quest Alpha", classic)).toBe(false);
    expect(late("Example Quest Alpha", `{{questbox|id=4242}}\n${PROSE}`).reason).toBe("post_cutoff_id_match");
    expect(late("Example Quest Alpha", classic)).toEqual({ admit: false, reason: "dropped_post_cutoff" });
  });

  test("without an oracle the door does not exist", () => {
    expect(late("Example Quest Alpha", `{{questbox|id=4242}}\n${PROSE}`, null)).toEqual({ admit: false, reason: "dropped_post_cutoff" });
  });
});

describe("pageSubject", () => {
  test("the namespace prefix and any number of disambiguating parentheticals come off", () => {
    expect(pageSubject("Quest:Example Quest Alpha")).toBe("Example Quest Alpha");
    expect(pageSubject("Category:Example Zone Beta")).toBe("Example Zone Beta");
    expect(pageSubject("Example Guard (Alliance)")).toBe("Example Guard");
    expect(pageSubject("Example Guard (mob) (old)")).toBe("Example Guard");
  });

  test("a parenthetical that is not a suffix stays: it is part of the name", () => {
    expect(pageSubject("Example (Big) Guard")).toBe("Example (Big) Guard");
  });
});

describe("namesAgree", () => {
  test("case, punctuation and spacing are ornament, and one name's words being all of the other's is agreement", () => {
    expect(namesAgree("Example Guard", "example guard")).toBe(true);
    expect(namesAgree("Zim'Torga's Keeper", "Zim'Torgas Keeper")).toBe(true);
    expect(namesAgree("Example Carnie", "Example Faire Carnie")).toBe(true);
    expect(namesAgree("Turgid the Vile", "Turgid")).toBe(true);
  });

  test("different names, substrings of a word and an empty side do not agree", () => {
    expect(namesAgree("Example Quest Alpha", "Example Quest Beta")).toBe(false);
    expect(namesAgree("Carn", "Example Carnie")).toBe(false);
    expect(namesAgree("", "Example Guard")).toBe(false);
    expect(namesAgree("!!!", "Example Guard")).toBe(false);
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
});

describe("worldIdVerdict", () => {
  test("the three outcomes are match, mismatch and no id, and the ids it read come back with it", () => {
    const oracle = {
      name(kind: IdKind, id: number): string | undefined {
        return kind === "npc" && id === 7001 ? "Example Guard" : undefined;
      },
    };
    expect(worldIdVerdict("Example Guard", "{{npcbox|id=7001}}", oracle)).toMatchObject({ verdict: "match", ids: [{ kind: "npc", id: 7001 }] });
    expect(worldIdVerdict("Example Boss", "{{npcbox|id=7001}}", oracle).verdict).toBe("mismatch");
    expect(worldIdVerdict("Example Guard", "{{npcbox|id=7009}}", oracle).verdict).toBe("no id");
    expect(worldIdVerdict("Example Guard", PROSE, oracle).verdict).toBe("no id");
  });
});
