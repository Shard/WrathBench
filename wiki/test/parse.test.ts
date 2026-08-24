import { describe, expect, test } from "bun:test";
import { chunked, parsePages, type WikiPage } from "../src/parse";
import { renderDump, type FixturePage, type FixtureRevision } from "./fixtures";

async function collect(xml: string, chunkSize: number): Promise<WikiPage[]> {
  const out: WikiPage[] = [];
  for await (const page of parsePages(chunked(xml, chunkSize))) out.push(page);
  return out;
}

const CHUNK_SIZES = [1, 3, 17, 64, 1024, 1_000_000];

describe("parsePages", () => {
  test("page and revision boundaries survive any chunking", async () => {
    const pages: FixturePage[] = [
      {
        title: "Example Quest Alpha",
        ns: 118,
        id: 1,
        revisions: [
          { id: 20, timestamp: "2011-01-01T00:00:00Z", text: "Lorem alpha newest." },
          { id: 10, timestamp: "2009-01-01T00:00:00Z", text: "Lorem alpha oldest." },
        ],
      },
      {
        title: "Example Zone Beta",
        ns: 0,
        id: 2,
        revisions: [{ id: 30, timestamp: "2012-01-01T00:00:00Z", text: "Lorem beta only." }],
      },
    ];
    const xml = renderDump(pages);
    for (const size of CHUNK_SIZES) {
      const got = await collect(xml, size);
      expect(got.map((p) => p.title)).toEqual(["Example Quest Alpha", "Example Zone Beta"]);
      expect(got.map((p) => p.ns)).toEqual([118, 0]);
      expect(got[0]!.wikitext).toBe("Lorem alpha newest.");
      expect(got[1]!.wikitext).toBe("Lorem beta only.");
    }
  });

  test("picks the newest revision whatever the dump's ordering", async () => {
    const revisions = [
      { id: 1, timestamp: "2006-05-05T10:00:00Z", text: "oldest lorem" },
      { id: 2, timestamp: "2010-05-05T10:00:00Z", text: "middle lorem" },
      { id: 3, timestamp: "2016-05-05T10:00:00Z", text: "newest lorem" },
    ];
    const orders = {
      "oldest-first": revisions,
      "newest-first": [...revisions].reverse(),
      shuffled: [revisions[1]!, revisions[2]!, revisions[0]!],
    };
    for (const [name, revs] of Object.entries(orders)) {
      const xml = renderDump([{ title: "Example Page Gamma", ns: 0, id: 3, revisions: revs }]);
      for (const size of [7, 512]) {
        const got = await collect(xml, size);
        expect(got).toHaveLength(1);
        expect(`${name}:${got[0]!.wikitext}`).toBe(`${name}:newest lorem`);
        expect(got[0]!.timestamp).toBe("2016-05-05T10:00:00Z");
      }
    }
  });

  test("equal timestamps break the tie on the higher revision id", async () => {
    const ts = "2013-03-03T03:03:03Z";
    const xml = renderDump([
      {
        title: "Example Page Delta",
        ns: 0,
        id: 4,
        revisions: [
          { id: 51, timestamp: ts, text: "lower id lorem" },
          { id: 99, timestamp: ts, text: "higher id lorem" },
        ],
      },
    ]);
    for (const size of [11, 4096]) {
      const got = await collect(xml, size);
      expect(got[0]!.wikitext).toBe("higher id lorem");
    }
  });

  test("drops namespaces outside the wanted set without parsing them", async () => {
    const xml = renderDump([
      { title: "Talk:Example Quest Alpha", ns: 1, id: 5, revisions: [{ id: 1, timestamp: "2011-01-01T00:00:00Z", text: "chatter" }] },
      { title: "Template:Example Box", ns: 10, id: 6, revisions: [{ id: 2, timestamp: "2011-01-01T00:00:00Z", text: "box" }] },
      { title: "Category:Example Category", ns: 14, id: 7, revisions: [{ id: 3, timestamp: "2011-01-01T00:00:00Z", text: "cat lorem" }] },
      { title: "Portal:Example Portal", ns: 116, id: 8, revisions: [{ id: 4, timestamp: "2011-01-01T00:00:00Z", text: "portal lorem" }] },
      { title: "User:Example Person", ns: 2, id: 9, revisions: [{ id: 5, timestamp: "2011-01-01T00:00:00Z", text: "profile" }] },
    ]);
    for (const size of [5, 256]) {
      const got = await collect(xml, size);
      expect(got.map((p) => p.ns).sort((a, b) => a - b)).toEqual([14, 116]);
    }
  });

  test("carries a redirect attribute through when the dump emits one", async () => {
    const xml = renderDump([
      {
        title: "Example Old Name",
        ns: 0,
        id: 10,
        redirectAttr: "Example New Name",
        revisions: [{ id: 1, timestamp: "2011-01-01T00:00:00Z", text: "#REDIRECT [[Example New Name]]" }],
      },
    ]);
    const got = await collect(xml, 33);
    expect(got[0]!.redirectAttr).toBe("Example New Name");
  });

  test("decodes entities in titles and text, and unescapes markup faithfully", async () => {
    const xml = renderDump([
      {
        title: "Example & Ampersand <Page>",
        ns: 0,
        id: 11,
        revisions: [{ id: 1, timestamp: "2011-01-01T00:00:00Z", text: "a < b && c > d <br> end" }],
      },
    ]);
    for (const size of [2, 9, 8192]) {
      const got = await collect(xml, size);
      expect(got[0]!.title).toBe("Example & Ampersand <Page>");
      expect(got[0]!.wikitext).toBe("a < b && c > d <br> end");
    }
  });

  test("underscores in titles become spaces", async () => {
    const xml = renderDump([
      { title: "Example_Quest_Alpha", ns: 0, id: 12, revisions: [{ id: 1, timestamp: "2011-01-01T00:00:00Z", text: "lorem" }] },
    ]);
    expect((await collect(xml, 64))[0]!.title).toBe("Example Quest Alpha");
  });

  test("a page whose text spans many chunks is reassembled intact", async () => {
    const body = "lorem ipsum dolor ".repeat(5000);
    const xml = renderDump([
      { title: "Example Long Page", ns: 0, id: 13, revisions: [{ id: 1, timestamp: "2011-01-01T00:00:00Z", text: body }] },
    ]);
    for (const size of [13, 997, 65536]) {
      const got = await collect(xml, size);
      expect(got[0]!.wikitext).toBe(body);
    }
  });

  test("an empty stream yields nothing", async () => {
    expect(await collect("", 16)).toEqual([]);
    expect(await collect(renderDump([]), 16)).toEqual([]);
  });
});

describe("a page split into 50-revision blocks", () => {
  // The dump exports a long history as consecutive <page> blocks of 50
  // revisions each, all carrying the same title and ns. A block is not a page.
  const block = (title: string, ns: number, id: number, revisions: FixtureRevision[]): FixturePage =>
    ({ title, ns, id, revisions });
  const rev = (id: number, year: number, text: string): FixtureRevision =>
    ({ id, timestamp: `${year}-04-04T04:04:04Z`, text });

  test("becomes one page holding the newest text, at any chunk size", async () => {
    const xml = renderDump([
      block("Example Long History", 0, 1, [rev(30, 2018, "newest lorem"), rev(29, 2017, "b1 older")]),
      block("Example Long History", 0, 1, [rev(20, 2013, "b2 lorem"), rev(19, 2012, "b2 older")]),
      block("Example Long History", 0, 1, [rev(10, 2006, "b3 lorem"), rev(9, 2005, "oldest lorem")]),
    ]);
    for (const size of CHUNK_SIZES) {
      const got = await collect(xml, size);
      expect(`${size}:${got.length}`).toBe(`${size}:1`);
      expect(`${size}:${got[0]!.wikitext}`).toBe(`${size}:newest lorem`);
      expect(got[0]!.timestamp).toBe("2018-04-04T04:04:04Z");
    }
  });

  test("merges the same way when the blocks arrive oldest-first", async () => {
    const xml = renderDump([
      block("Example Long History", 0, 1, [rev(9, 2005, "oldest lorem"), rev(10, 2006, "b3 lorem")]),
      block("Example Long History", 0, 1, [rev(19, 2012, "b2 older"), rev(20, 2013, "b2 lorem")]),
      block("Example Long History", 0, 1, [rev(29, 2017, "b1 older"), rev(30, 2018, "newest lorem")]),
    ]);
    for (const size of [1, 23, 4096]) {
      const got = await collect(xml, size);
      expect(got).toHaveLength(1);
      expect(got[0]!.wikitext).toBe("newest lorem");
    }
  });

  test("leaves the pages around it alone", async () => {
    const xml = renderDump([
      block("Example Zone Beta", 0, 1, [rev(40, 2016, "beta lorem")]),
      block("Example Long History", 0, 2, [rev(30, 2018, "newest lorem")]),
      block("Example Long History", 0, 2, [rev(10, 2006, "older lorem")]),
      block("Example Quest Alpha", 118, 3, [rev(50, 2015, "alpha lorem")]),
      block("Example Zone Gamma", 0, 4, [rev(60, 2014, "gamma lorem")]),
    ]);
    for (const size of [1, 31, 8192]) {
      const got = await collect(xml, size);
      expect(got.map((p) => p.title)).toEqual([
        "Example Zone Beta",
        "Example Long History",
        "Example Quest Alpha",
        "Example Zone Gamma",
      ]);
      expect(got[1]!.wikitext).toBe("newest lorem");
    }
  });

  test("a dropped namespace between two blocks does not split the page", async () => {
    const xml = renderDump([
      block("Example Long History", 0, 1, [rev(30, 2018, "newest lorem")]),
      block("Talk:Example Long History", 1, 2, [rev(31, 2019, "chatter")]),
      block("Example Long History", 0, 1, [rev(10, 2006, "older lorem")]),
    ]);
    for (const size of [1, 37, 8192]) {
      const got = await collect(xml, size);
      expect(got).toHaveLength(1);
      expect(got[0]!.wikitext).toBe("newest lorem");
    }
  });

  test("the same title in another namespace stays a separate page", async () => {
    const xml = renderDump([
      block("Example Shared Name", 0, 1, [rev(30, 2018, "main lorem")]),
      block("Example Shared Name", 14, 2, [rev(10, 2006, "category lorem")]),
    ]);
    for (const size of [1, 29, 8192]) {
      const got = await collect(xml, size);
      expect(got.map((p) => [p.ns, p.wikitext])).toEqual([
        [0, "main lorem"],
        [14, "category lorem"],
      ]);
    }
  });

  test("a redirect attribute on one block survives the merge", async () => {
    const first: FixturePage = {
      ...block("Example Old Name", 0, 1, [rev(30, 2018, "#REDIRECT [[Example New Name]]")]),
      redirectAttr: "Example New Name",
    };
    const xml = renderDump([
      first,
      block("Example Old Name", 0, 1, [rev(10, 2006, "an article, once")]),
    ]);
    for (const size of [1, 41, 8192]) {
      const got = await collect(xml, size);
      expect(got).toHaveLength(1);
      expect(got[0]!.redirectAttr).toBe("Example New Name");
    }
  });
});
