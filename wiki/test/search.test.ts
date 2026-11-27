import { beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createMemoryBundle, makeWriter } from "../src/bundle";
import {
  EMPTY_PAGE_SNIPPET,
  EXACT_TITLE_RANK,
  parseIdQuery,
  searchReference,
  stripProseCoords,
} from "../src/search";

let db: Database;

beforeAll(() => {
  db = createMemoryBundle();
  const writer = makeWriter(db, 2);
  writer.addPage(
    "Example Quest Alpha",
    118,
    "Example Quest Alpha is the first quest of the beta zone.\nObjectives\nSpeak to Example Person Gamma.",
  );
  writer.addPage(
    "Example Zone Beta",
    0,
    "Example Zone Beta is a starting region. Lorem ipsum dolor sit amet, consectetur adipiscing elit.",
  );
  writer.addPage(
    "Example Person Gamma",
    0,
    "Example Person Gamma is a quest giver standing in Example Zone Beta.",
  );
  writer.addPage(
    "Quest:Example Quest Epsilon",
    118,
    "Objectives: return to Example Person Gamma with five lorem tokens.",
  );
  writer.addPage("Example Category Page", 14, "Pages about lorem things in the example world.");
  writer.addPage(
    "Example Person Delta",
    0,
    "Example Person Delta stands at (48.2, 42.1) in Example Zone Beta, near the inn [50, 41]. Patch (3.3.5) notes.",
    [{ zone: "Example Zone Beta", x: 48.2, y: 42.1, raw: "{{coords|48.2|42.1|Example Zone Beta}}" }],
  );
  writer.addPage(
    "Example Bars Vendor",
    0,
    "Example Bars Vendor sells lorem bars in Example Zone Beta.",
  );
  writer.addRedirect("Example Old Name", "Example Zone Beta", 0);
  writer.addRedirect("Example Older Name", "Example Old Name", 0);
  writer.addRedirect("Example Broken Name", "Example Missing Page", 0);
  writer.flush();
});

describe("searchReference", () => {
  test("finds a page by a word in its body", () => {
    const hits = searchReference(db, "consectetur");
    expect(hits[0]!.title).toBe("Example Zone Beta");
    expect(hits[0]!.snippet).toContain("consectetur");
  });

  test("an exact title comes first, matched case-insensitively", () => {
    const hits = searchReference(db, "Example Person Gamma");
    expect(hits[0]!.title).toBe("Example Person Gamma");
    expect(hits[0]!.rank).toBe(EXACT_TITLE_RANK);
    expect(hits[0]!.exactTitle).toBe(true);
    expect(searchReference(db, "example person gamma")[0]!.title).toBe("Example Person Gamma");
  });

  test("results survive a JSON round trip, which is how the runner sees them", () => {
    // A non-finite rank would serialise to null and reach the model as a different hit.
    const hits = [...searchReference(db, "Example Person Gamma"), ...searchReference(db, "Example Person Delta")];
    expect(JSON.parse(JSON.stringify(hits))).toEqual(hits);
    expect(hits.every((h) => Number.isFinite(h.rank))).toBe(true);
  });

  test("a bare quest name resolves to the Quest: namespace title", () => {
    const hits = searchReference(db, "Example Quest Epsilon");
    expect(hits[0]!.title).toBe("Quest:Example Quest Epsilon");
    expect(hits[0]!.exactTitle).toBe(true);
  });

  test("follows a redirect and a chain of them, and a redirect to a missing page falls back to full text", () => {
    const hits = searchReference(db, "Example Old Name");
    expect(hits[0]!.title).toBe("Example Zone Beta");
    expect(hits[0]!.redirectedFrom).toBe("Example Old Name");
    expect(searchReference(db, "Example Older Name")[0]!.title).toBe("Example Zone Beta");
    expect(searchReference(db, "Example Broken Name").every((h) => h.redirectedFrom === undefined)).toBe(true);
  });

  test("respects the namespace filter and the limit, and returns no duplicates", () => {
    const hits = searchReference(db, "example", { namespaces: [118] });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.ns === 118)).toBe(true);
    expect(searchReference(db, "example", { limit: 2 })).toHaveLength(2);
    const titles = searchReference(db, "Example Zone Beta").map((h) => h.title);
    expect(new Set(titles).size).toBe(titles.length);
  });

  test("a wordy question falls back to OR rather than returning nothing", () => {
    const strict = searchReference(db, "where do I find the quest giver called Gamma");
    expect(strict.length).toBeGreaterThan(0);
    expect(strict.some((h) => h.title === "Example Person Gamma")).toBe(true);
  });

  test("the OR fallback does not dilute a query that already matched", () => {
    const hits = searchReference(db, "quest giver");
    expect(hits.map((h) => h.title)).toEqual(["Example Person Gamma"]);
  });

  test("survives queries FTS5 would choke on", () => {
    expect(() => searchReference(db, `"unbalanced AND (`)).not.toThrow();
    expect(searchReference(db, "   ")).toEqual([]);
    expect(searchReference(db, "zzzznothinghere")).toEqual([]);
  });
});

describe("parseIdQuery", () => {
  test("an id word introduces the numbers after it, a bare number is an id, and a leading number may be claimed by the word after it", () => {
    expect(parseIdQuery("4242")).toEqual({ ids: [{ id: 4242 }], text: "" });
    expect(parseIdQuery("Example Quest Alpha quest 4242")).toEqual({ ids: [{ id: 4242, kind: "quest" }], text: "Example Quest Alpha" });
    expect(parseIdQuery("entry 1717 Example Zone Beta")).toEqual({ ids: [{ id: 1717 }], text: "Example Zone Beta" });
    // A run of numbers after an id word are all ids, and a kindless word takes the kind before it.
    expect(parseIdQuery("npc entry 1717 1718")).toEqual({
      ids: [
        { id: 1717, kind: "npc" },
        { id: 1718, kind: "npc" },
      ],
      text: "",
    });
    expect(parseIdQuery("4242 npc entry Example Zone Beta")).toEqual({ ids: [{ id: 4242, kind: "npc" }], text: "Example Zone Beta" });
  });

  test("a number no id word introduces stays ordinary text", () => {
    expect(parseIdQuery("level 5 quests")).toEqual({ ids: [], text: "level 5 quests" });
    expect(parseIdQuery("Example Zone Beta 4242 npc")).toEqual({ ids: [], text: "Example Zone Beta 4242 npc" });
  });
});

describe("ranking bands", () => {
  let ranked: Database;

  beforeAll(() => {
    ranked = createMemoryBundle();
    const writer = makeWriter(ranked, 2);
    // A page whose only connection to 4242 is arithmetic in its body — the
    // shape that outranked the real entity page.
    writer.addPage(
      "Example Formula Notes",
      0,
      "Worked example: 4242 divided by two is 2121, and 4242 minus 42 is 4200. " +
        "Example Quest Alpha is mentioned here in passing, as is Example Person Gamma. " +
        "4242 4242 4242 lorem ipsum dolor sit amet.",
    );
    writer.addPage(
      "Example Quest Alpha",
      118,
      "Objectives: speak to Example Person Gamma in the beta zone.",
      undefined,
      [{ kind: "quest", id: 4242 }],
    );
    writer.addPage(
      "Example Person Gamma",
      0,
      "Example Person Gamma stands in the beta zone.",
      undefined,
      [{ kind: "npc", id: 1717 }],
    );
    // Mentions the entity by name many times over, so bm25 alone ranks it
    // above the page actually named for that entity.
    writer.addPage(
      "Example Chatter Page",
      0,
      "Example Person Gamma. Example Person Gamma. Example Person Gamma. Gamma, Gamma, Gamma.",
    );
    // Shares an id with the quest page, under a different kind.
    writer.addPage("Example Object Marker", 0, "A marker in the beta zone.", undefined, [
      { kind: "object", id: 4242 },
    ]);
    writer.flush();
  });

  test("a bare id finds the page that states it, not the page that mentions the digits", () => {
    const hits = searchReference(ranked, "4242");
    expect(hits[0]!.title).toBe("Example Quest Alpha");
    expect(hits[0]!.matchedId).toEqual({ kind: "quest", id: 4242 });
    // The digits-in-prose page is not merely demoted, it is gone: an id query
    // never reaches the text index.
    expect(hits.some((h) => h.title === "Example Formula Notes")).toBe(false);
  });

  test("a qualified id keeps the rest of the query as text", () => {
    const hits = searchReference(ranked, "Example Quest Alpha quest 4242");
    expect(hits[0]!.title).toBe("Example Quest Alpha");
    // The prose page may still come back on the words — it just cannot come
    // back on the digits, and never above the page that states the id.
    expect(hits.findIndex((h) => h.title === "Example Formula Notes")).not.toBe(0);
  });

  test("the kind named in the query decides between two pages sharing an id", () => {
    expect(searchReference(ranked, "object 4242")[0]!.title).toBe("Example Object Marker");
    expect(searchReference(ranked, "quest 4242")[0]!.title).toBe("Example Quest Alpha");
  });

  test("an exact title outranks an id hit, and a title match a body match that bm25 scores higher", () => {
    const exact = searchReference(ranked, "Example Quest Alpha");
    expect(exact[0]!.exactTitle).toBe(true);
    expect(exact[0]!.rank).toBe(EXACT_TITLE_RANK);
    const hits = searchReference(ranked, "Example Person Gamma");
    expect(hits[0]!.title).toBe("Example Person Gamma");
    expect(hits.map((h) => h.title)).toContain("Example Chatter Page");
    expect(hits.indexOf(hits.find((h) => h.title === "Example Chatter Page")!)).toBeGreaterThan(0);
  });
});

describe("the id band is bounded", () => {
  test("ids sharing a number cannot crowd the text half of a query out", () => {
    const db = createMemoryBundle();
    const writer = makeWriter(db, 2);
    for (let i = 0; i < 12; i++) {
      writer.addPage(`Example Shared Id Page ${i}`, 0, `A page about lorem number ${i}.`, undefined, [
        { kind: "npc", id: 12 },
      ]);
    }
    writer.addPage("Example Zone Beta", 0, "Example Zone Beta is a starting region.");
    writer.flush();
    const hits = searchReference(db, "Example Zone Beta npc entry 12", { limit: 8 });
    expect(hits.filter((h) => h.matchedId !== undefined).length).toBeLessThanOrEqual(4);
    expect(hits.some((h) => h.title === "Example Zone Beta")).toBe(true);
    // A query that is nothing but the id may still have the whole slate.
    expect(searchReference(db, "npc 12", { limit: 8 }).length).toBe(8);
    db.close();
  });
});

describe("stripProseCoords", () => {
  test("redacts bracketed coordinate pairs and leaves other numbers", () => {
    expect(stripProseCoords("at (48.2, 42.1) near [50, 41] and (48/42)")).toBe(
      "at (coords withheld) near (coords withheld) and (coords withheld)",
    );
    expect(stripProseCoords("level 12 quest, id (783) and 5 tokens")).toBe("level 12 quest, id (783) and 5 tokens");
    expect(stripProseCoords("x 48.2 y 42.1 without brackets")).toBe("x 48.2 y 42.1 without brackets");
    expect(stripProseCoords("(120, 40) is out of map range")).toBe("(120, 40) is out of map range");
  });
});

describe("searchReference coords channel", () => {
  test("serves coords and prose pairs by default", () => {
    const hit = searchReference(db, "Example Person Delta")[0]!;
    expect(hit.coords).toEqual([{ zone: "Example Zone Beta", x: 48.2, y: 42.1 }]);
    expect(hit.snippet).toContain("(48.2, 42.1)");
  });

  test("coords:false withholds the field and redacts prose pairs on every band", () => {
    const title = searchReference(db, "Example Person Delta", { coords: false })[0]!;
    expect(title.exactTitle).toBe(true);
    expect(title.coords).toBeUndefined();
    expect(title.snippet).not.toContain("48.2");
    expect(title.snippet).not.toContain("[50, 41]");
    expect(title.snippet).toContain("(coords withheld)");
    const body = searchReference(db, "delta stands inn", { coords: false }).find(
      (h) => h.title === "Example Person Delta",
    )!;
    expect(body).toBeDefined();
    expect(body.coords).toBeUndefined();
    expect(body.snippet).not.toMatch(/\d+\.\d+, \d+/);
    expect(JSON.stringify(searchReference(db, "Example Person Delta", { coords: false }))).not.toContain("coords\"");
  });
});

describe("a page with no article text", () => {
  /**
   * Infobox-only pages: rows kept for their title and their structured fields,
   * with nothing to quote. The bug pinned here is an exact-title hit that used
   * to arrive at rank 1 with a blank snippet, ahead of a page that has prose.
   */
  const emptyBundle = (): Database => {
    const empty = createMemoryBundle();
    const writer = makeWriter(empty, 2);
    writer.addPage("Example Quest Silent", 118, "", undefined, [{ kind: "quest", id: 5150 }], {
      start: "Example Person Gamma",
      end: "Example Person Delta",
      category: "Example Zone Beta",
    });
    writer.addPage("Example Barren Stub", 0, "");
    writer.addPage(
      "Example Barren Stub (disambiguation)",
      0,
      "Example Barren Stub is described here, with lorem prose about the barren stub.",
    );
    writer.flush();
    return empty;
  };

  test("an exact title says so in words and still states its quest infobox", () => {
    const empty = emptyBundle();
    const hit = searchReference(empty, "Example Quest Silent")[0]!;
    expect(hit.title).toBe("Example Quest Silent");
    expect(hit.exactTitle).toBe(true);
    expect(hit.snippet).toBe(
      `${EMPTY_PAGE_SNIPPET}\n[quest infobox: starts at Example Person Gamma; ` +
        "turn in to Example Person Delta; category Example Zone Beta]",
    );
    expect(hit.quest).toEqual({
      start: "Example Person Gamma",
      end: "Example Person Delta",
      category: "Example Zone Beta",
    });
    // An id query reaches it and reads the same way.
    const byId = searchReference(empty, "quest 5150")[0]!;
    expect(byId.title).toBe("Example Quest Silent");
    expect(byId.snippet).toContain(EMPTY_PAGE_SNIPPET);
    empty.close();
  });

  test("with nothing to state it is skipped and the query falls through", () => {
    const empty = emptyBundle();
    const hits = searchReference(empty, "Example Barren Stub");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.title === "Example Barren Stub")).toBe(false);
    expect(hits[0]!.title).toBe("Example Barren Stub (disambiguation)");
    empty.close();
  });
});
