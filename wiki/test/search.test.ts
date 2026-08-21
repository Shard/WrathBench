import { beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createMemoryBundle, makeWriter } from "../src/bundle";
import {
  EXACT_TITLE_RANK,
  normaliseTitle,
  searchReference,
  toMatchExpression,
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
  writer.addRedirect("Example Old Name", "Example Zone Beta", 0);
  writer.addRedirect("Example Older Name", "Example Old Name", 0);
  writer.addRedirect("Example Broken Name", "Example Missing Page", 0);
  writer.flush();
});

describe("toMatchExpression", () => {
  test("quotes tokens and drops punctuation", () => {
    expect(toMatchExpression("alpha beta")).toBe(`"alpha" "beta"`);
    expect(toMatchExpression(`a "b" OR NEAR(c)`)).toBe(`"a" "b" "OR" "NEAR" "c"`);
    expect(toMatchExpression("   ***   ")).toBeNull();
  });
});

describe("normaliseTitle", () => {
  test("capitalises the first letter and swaps underscores", () => {
    expect(normaliseTitle("example_zone beta")).toBe("Example zone beta");
    expect(normaliseTitle("  Example Zone Beta ")).toBe("Example Zone Beta");
    expect(normaliseTitle("")).toBe("");
  });
});

describe("searchReference", () => {
  test("finds a page by a word in its body", () => {
    const hits = searchReference(db, "consectetur");
    expect(hits[0]!.title).toBe("Example Zone Beta");
    expect(hits[0]!.snippet).toContain("consectetur");
  });

  test("an exact title comes first", () => {
    const hits = searchReference(db, "Example Person Gamma");
    expect(hits[0]!.title).toBe("Example Person Gamma");
    expect(hits[0]!.rank).toBe(EXACT_TITLE_RANK);
    expect(hits[0]!.exactTitle).toBe(true);
  });

  test("a bare quest name resolves to the Quest: namespace title", () => {
    const hits = searchReference(db, "Example Quest Epsilon");
    expect(hits[0]!.title).toBe("Quest:Example Quest Epsilon");
    expect(hits[0]!.exactTitle).toBe(true);
  });

  test("titles are matched case-insensitively", () => {
    expect(searchReference(db, "example person gamma")[0]!.title).toBe("Example Person Gamma");
  });

  test("follows a redirect to its target", () => {
    const hits = searchReference(db, "Example Old Name");
    expect(hits[0]!.title).toBe("Example Zone Beta");
    expect(hits[0]!.redirectedFrom).toBe("Example Old Name");
  });

  test("follows a chain of redirects", () => {
    const hits = searchReference(db, "Example Older Name");
    expect(hits[0]!.title).toBe("Example Zone Beta");
  });

  test("a redirect to a missing page falls back to full-text results", () => {
    const hits = searchReference(db, "Example Broken Name");
    expect(hits.every((h) => h.redirectedFrom === undefined)).toBe(true);
  });

  test("respects the namespace filter", () => {
    const hits = searchReference(db, "example", { namespaces: [118] });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.ns === 118)).toBe(true);
  });

  test("respects the limit", () => {
    expect(searchReference(db, "example", { limit: 2 })).toHaveLength(2);
  });

  test("returns no duplicates", () => {
    const hits = searchReference(db, "Example Zone Beta");
    const titles = hits.map((h) => h.title);
    expect(new Set(titles).size).toBe(titles.length);
  });

  test("results survive a JSON round trip, which is how the runner sees them", () => {
    const hits = searchReference(db, "Example Person Gamma");
    const roundTripped = JSON.parse(JSON.stringify(hits)) as typeof hits;
    expect(roundTripped).toEqual(hits);
    expect(Number.isFinite(roundTripped[0]!.rank)).toBe(true);
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
