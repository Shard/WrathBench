/**
 * The era revision slot: which revision supplies the prose (ADR-0040).
 *
 * All fixtures are synthetic and invented, like every other fixture here.
 */

import { describe, expect, test } from "bun:test";
import { chunked, parsePages, type WikiPage } from "../src/parse";
import { renderDump } from "./fixtures";

/** A fixed cutoff, so these do not move when the default does. */
const CUT = "2010-10-12T00:00:00Z";

const CHUNK_SIZES = [1, 3, 17, 64, 1024, 1_000_000];

async function parse(xml: string, size = 64, cutoff = CUT): Promise<WikiPage[]> {
  const out: WikiPage[] = [];
  for await (const page of parsePages(chunked(xml, size), undefined, undefined, cutoff)) {
    out.push(page);
  }
  return out;
}

describe("the era revision slot", () => {
  test("prose comes from the newest pre-cutoff revision, structure from the newest", async () => {
    const xml = renderDump([
      {
        title: "Example Zone Beta",
        ns: 0,
        id: 1,
        revisions: [
          { id: 3, timestamp: "2018-01-01T00:00:00Z", text: "The rewritten lorem." },
          { id: 2, timestamp: "2010-09-01T00:00:00Z", text: "The era lorem." },
          { id: 1, timestamp: "2007-01-01T00:00:00Z", text: "The first stub, lorem." },
        ],
      },
    ]);
    for (const size of CHUNK_SIZES) {
      const [got] = await parse(xml, size);
      expect(`${size}:${got!.wikitext}`).toBe(`${size}:The rewritten lorem.`);
      expect(`${size}:${got!.eraWikitext}`).toBe(`${size}:The era lorem.`);
      expect(got!.eraTimestamp).toBe("2010-09-01T00:00:00Z");
    }
  });

  test("a page whose whole history predates the cutoff keeps its newest revision", async () => {
    const xml = renderDump([
      {
        title: "Example Zone Beta",
        ns: 0,
        id: 1,
        revisions: [
          { id: 2, timestamp: "2009-06-01T00:00:00Z", text: "The newest lorem." },
          { id: 1, timestamp: "2007-01-01T00:00:00Z", text: "The first stub, lorem." },
        ],
      },
    ]);
    const [got] = await parse(xml);
    expect(got!.eraWikitext).toBe("The newest lorem.");
    // One revision won both slots, so the build counts no swap for this page.
    expect(got!.eraTimestamp).toBe(got!.timestamp);
  });

  test("a page with no pre-cutoff revision has no era text", async () => {
    const xml = renderDump([
      {
        title: "Example Later Page",
        ns: 0,
        id: 1,
        revisions: [
          { id: 2, timestamp: "2016-01-01T00:00:00Z", text: "Written later, lorem." },
          { id: 1, timestamp: "2013-01-01T00:00:00Z", text: "An earlier late draft, lorem." },
        ],
      },
    ]);
    const [got] = await parse(xml);
    expect(got!.eraWikitext).toBeNull();
    expect(got!.eraTimestamp).toBe("");
    expect(got!.hasEraRevision).toBe(false);
    expect(got!.eraRedirectTarget).toBeNull();
  });

  test("a revision where the page was a redirect never wins the era slot", async () => {
    const xml = renderDump([
      {
        title: "Example Zone Beta",
        ns: 0,
        id: 1,
        revisions: [
          { id: 4, timestamp: "2018-01-01T00:00:00Z", text: "The rewritten lorem." },
          { id: 3, timestamp: "2010-09-01T00:00:00Z", text: "#REDIRECT [[Example Zone Gamma]]" },
          { id: 2, timestamp: "2010-05-01T00:00:00Z", text: "The era lorem." },
          { id: 1, timestamp: "2007-01-01T00:00:00Z", text: "The first stub, lorem." },
        ],
      },
    ]);
    for (const size of [3, 512]) {
      const [got] = await parse(xml, size);
      expect(`${size}:${got!.eraWikitext}`).toBe(`${size}:The era lorem.`);
      // …but the page *was* a redirect at the cutoff, and that is what the
      // build reads to decide whether the bundle holds a page or a redirect.
      expect(`${size}:${got!.eraRedirectTarget}`).toBe(`${size}:Example Zone Gamma`);
    }
  });

  test("a redirect in the middle of the pre-cutoff range does not cost the page its prose", async () => {
    const xml = renderDump([
      {
        title: "Example Zone Beta",
        ns: 0,
        id: 1,
        revisions: [
          { id: 4, timestamp: "2018-01-01T00:00:00Z", text: "The rewritten lorem." },
          { id: 3, timestamp: "2010-09-01T00:00:00Z", text: "The era lorem." },
          { id: 2, timestamp: "2010-05-01T00:00:00Z", text: "#REDIRECT [[Example Zone Gamma]]" },
          { id: 1, timestamp: "2007-01-01T00:00:00Z", text: "The first stub, lorem." },
        ],
      },
    ]);
    const [got] = await parse(xml);
    expect(got!.eraWikitext).toBe("The era lorem.");
  });

  test("a pre-cutoff revision that was immediately reverted is skipped", async () => {
    // Revision 3 was undone: revision 4 restores the sha1 the page already had
    // at revision 2, so what revision 3 said is not what the page said.
    const xml = renderDump([
      {
        title: "Example Zone Beta",
        ns: 0,
        id: 1,
        revisions: [
          { id: 5, timestamp: "2018-01-01T00:00:00Z", text: "The rewritten lorem." },
          { id: 4, timestamp: "2010-11-01T00:00:00Z", text: "The era lorem.", sha1: "shared" },
          { id: 3, timestamp: "2010-09-01T00:00:00Z", text: "Inserted nonsense, lorem." },
          { id: 2, timestamp: "2010-05-01T00:00:00Z", text: "The era lorem.", sha1: "shared" },
          { id: 1, timestamp: "2007-01-01T00:00:00Z", text: "The first stub, lorem." },
        ],
      },
    ]);
    for (const size of [5, 4096]) {
      const [got] = await parse(xml, size);
      expect(`${size}:${got!.eraWikitext}`).toBe(`${size}:The era lorem.`);
      expect(got!.eraTimestamp).toBe("2010-05-01T00:00:00Z");
    }
  });

  test("a revert that itself predates the cutoff simply wins on its own", async () => {
    const xml = renderDump([
      {
        title: "Example Zone Beta",
        ns: 0,
        id: 1,
        revisions: [
          { id: 4, timestamp: "2018-01-01T00:00:00Z", text: "The rewritten lorem." },
          { id: 3, timestamp: "2010-09-02T00:00:00Z", text: "The era lorem.", sha1: "shared" },
          { id: 2, timestamp: "2010-09-01T00:00:00Z", text: "Inserted nonsense, lorem." },
          { id: 1, timestamp: "2010-05-01T00:00:00Z", text: "The era lorem.", sha1: "shared" },
        ],
      },
    ]);
    const [got] = await parse(xml);
    expect(got!.eraWikitext).toBe("The era lorem.");
    expect(got!.eraTimestamp).toBe("2010-09-02T00:00:00Z");
  });

  test("the era winner is found when it sits in a different block from the newest", async () => {
    const xml = renderDump([
      {
        title: "Example Long History",
        ns: 0,
        id: 1,
        revisions: [
          { id: 30, timestamp: "2018-01-01T00:00:00Z", text: "The rewritten lorem." },
          { id: 29, timestamp: "2014-01-01T00:00:00Z", text: "A later draft, lorem." },
        ],
      },
      {
        title: "Example Long History",
        ns: 0,
        id: 1,
        revisions: [
          { id: 20, timestamp: "2010-09-01T00:00:00Z", text: "The era lorem." },
          { id: 19, timestamp: "2009-01-01T00:00:00Z", text: "An older draft, lorem." },
        ],
      },
      {
        title: "Example Long History",
        ns: 0,
        id: 1,
        revisions: [{ id: 10, timestamp: "2006-01-01T00:00:00Z", text: "The first stub, lorem." }],
      },
    ]);
    for (const size of CHUNK_SIZES) {
      const got = await parse(xml, size);
      expect(`${size}:${got.length}`).toBe(`${size}:1`);
      expect(`${size}:${got[0]!.wikitext}`).toBe(`${size}:The rewritten lorem.`);
      expect(`${size}:${got[0]!.eraWikitext}`).toBe(`${size}:The era lorem.`);
    }
  });

  test("the winner does not depend on the order the revisions arrive in", async () => {
    const revisions = [
      { id: 1, timestamp: "2007-01-01T00:00:00Z", text: "The first stub, lorem." },
      { id: 2, timestamp: "2010-09-01T00:00:00Z", text: "The era lorem." },
      { id: 3, timestamp: "2018-01-01T00:00:00Z", text: "The rewritten lorem." },
    ];
    const orders = {
      "oldest-first": revisions,
      "newest-first": [...revisions].reverse(),
      shuffled: [revisions[1]!, revisions[2]!, revisions[0]!],
    };
    for (const [name, revs] of Object.entries(orders)) {
      const xml = renderDump([{ title: "Example Zone Beta", ns: 0, id: 1, revisions: revs }]);
      const [got] = await parse(xml, 37);
      expect(`${name}:${got!.eraWikitext}`).toBe(`${name}:The era lorem.`);
      expect(`${name}:${got!.wikitext}`).toBe(`${name}:The rewritten lorem.`);
    }
  });

  test("an earlier cutoff picks an earlier revision", async () => {
    const xml = renderDump([
      {
        title: "Example Zone Beta",
        ns: 0,
        id: 1,
        revisions: [
          { id: 3, timestamp: "2018-01-01T00:00:00Z", text: "The rewritten lorem." },
          { id: 2, timestamp: "2010-09-01T00:00:00Z", text: "The era lorem." },
          { id: 1, timestamp: "2007-01-01T00:00:00Z", text: "The first stub, lorem." },
        ],
      },
    ]);
    const [got] = await parse(xml, 128, "2008-01-01T00:00:00Z");
    expect(got!.eraWikitext).toBe("The first stub, lorem.");
  });
});

describe("the Wrath snapshot decides redirect-ness", () => {
  test("a page that redirects today but was an article then is an article", async () => {
    const xml = renderDump([
      {
        title: "Example Zone Beta",
        ns: 0,
        id: 1,
        revisions: [
          { id: 2, timestamp: "2014-01-01T00:00:00Z", text: "#REDIRECT [[Example Zone Gamma]]" },
          { id: 1, timestamp: "2009-01-01T00:00:00Z", text: "The era lorem." },
        ],
      },
    ]);
    const [got] = await parse(xml);
    expect(got!.eraRedirectTarget).toBeNull();
    expect(got!.eraWikitext).toBe("The era lorem.");
    expect(got!.hasEraRevision).toBe(true);
  });

  test("a page that was a redirect then is a redirect, whatever it became", async () => {
    const xml = renderDump([
      {
        title: "Example Old Name",
        ns: 0,
        id: 1,
        revisions: [
          { id: 3, timestamp: "2016-01-01T00:00:00Z", text: "An article again, lorem." },
          { id: 2, timestamp: "2010-09-01T00:00:00Z", text: "#REDIRECT [[Example Zone Beta]]" },
          { id: 1, timestamp: "2007-01-01T00:00:00Z", text: "The first stub, lorem." },
        ],
      },
    ]);
    for (const size of CHUNK_SIZES) {
      const [got] = await parse(xml, size);
      expect(`${size}:${got!.eraRedirectTarget}`).toBe(`${size}:Example Zone Beta`);
    }
  });

  test("a page whose whole pre-cutoff history was redirects has no prose but is known", async () => {
    const xml = renderDump([
      {
        title: "Example Old Name",
        ns: 0,
        id: 1,
        revisions: [
          { id: 2, timestamp: "2016-01-01T00:00:00Z", text: "An article, lorem." },
          { id: 1, timestamp: "2009-01-01T00:00:00Z", text: "#REDIRECT [[Example Zone Beta]]" },
        ],
      },
    ]);
    const [got] = await parse(xml);
    expect(got!.eraWikitext).toBeNull();
    expect(got!.hasEraRevision).toBe(true);
    expect(got!.eraRedirectTarget).toBe("Example Zone Beta");
  });
});
