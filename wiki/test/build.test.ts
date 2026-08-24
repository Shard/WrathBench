import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertUniquePages, createSchema, makeWriter } from "../src/bundle";
import { parseArgs } from "../src/build";
import { DEFAULT_ERA_CUTOFF } from "../src/wrath-only";
import { searchReference } from "../src/search";
import { renderDump } from "./fixtures";

const dir = mkdtempSync(join(tmpdir(), "wrathbench-wiki-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("build.ts turns a dump into a searchable bundle", async () => {
  const xmlPath = join(dir, "example-dump.xml");
  const outPath = join(dir, "bundle.sqlite");
  await Bun.write(
    xmlPath,
    renderDump([
      {
        title: "Example Quest Alpha",
        ns: 118,
        id: 1,
        revisions: [
          {
            id: 2,
            timestamp: "2015-01-01T00:00:00Z",
            text: "{{questbox|level=5|id=4242}}'''Example Quest Alpha''' sends you to [[Example Zone Beta|the beta zone]].",
          },
          { id: 1, timestamp: "2009-01-01T00:00:00Z", text: "An older draft, lorem ipsum." },
        ],
      },
      {
        title: "Example Zone Beta",
        ns: 0,
        id: 2,
        revisions: [
          {
            id: 4,
            timestamp: "2016-01-01T00:00:00Z",
            text: "{{coords|48.2|42.1|Example Zone Beta}}The rewritten lorem.",
          },
          {
            id: 3,
            timestamp: "2009-01-01T00:00:00Z",
            text: [
              "{{coords|48.2|42.1|Example Zone Beta}}'''Example Zone Beta''' is a starting region full of consectetur.",
              "",
              "In Cataclysm the region is rearranged and the road runs south instead.",
              "",
              "== In Cataclysm ==",
              "The whole section describes a world this server does not run.",
              "",
              "== External links ==",
              "* [http://example.invalid/beta Example Beta entry]",
              "",
              "== Background ==",
              "Removable background lorem.",
            ].join("\n"),
          },
        ],
      },
      {
        title: "Example Old Name",
        ns: 0,
        id: 3,
        revisions: [
          { id: 5, timestamp: "2009-01-01T00:00:00Z", text: "#REDIRECT [[Example Zone Beta]]" },
        ],
      },
      {
        // A redirect whose target does not survive the cutoff points at nothing.
        title: "Example Dangling Name",
        ns: 0,
        id: 4,
        revisions: [
          { id: 6, timestamp: "2009-01-01T00:00:00Z", text: "#REDIRECT [[Example Late Page]]" },
        ],
      },
      {
        // Written after the cutoff and silent about which world it describes.
        title: "Example Late Page",
        ns: 0,
        id: 5,
        revisions: [{ id: 7, timestamp: "2016-01-01T00:00:00Z", text: "A late page, lorem ipsum." }],
      },
      {
        // Written after the cutoff, but says outright that it is this world.
        title: "Example Item Zeta",
        ns: 0,
        id: 6,
        revisions: [
          {
            id: 8,
            timestamp: "2014-01-01T00:00:00Z",
            text: "{{itembox|patch=3.0.2}}Example Item Zeta is a trinket, lorem dolor.",
          },
        ],
      },
      {
        // Written *before* the cutoff, about the expansion that was coming.
        title: "Example Zone Theta",
        ns: 0,
        id: 7,
        revisions: [
          {
            id: 9,
            timestamp: "2010-09-01T00:00:00Z",
            text: "{{stub/Cataclysm}}Example Zone Theta, lorem ipsum dolor sit.",
          },
        ],
      },
      {
        // Written after the cutoff, about a later expansion: not this world's
        // wiki at all. It is counted as post-cutoff, not post-Wrath — the
        // reason it is absent is that the page did not exist here.
        title: "Example Zone Iota",
        ns: 0,
        id: 13,
        revisions: [
          {
            id: 15,
            timestamp: "2013-01-01T00:00:00Z",
            text: "{{stub/Cataclysm}}Example Zone Iota, lorem ipsum.",
          },
        ],
      },
      {
        // The 588-page pocket: a page of this world that acquired a later
        // expansion's patch field and category in 2010, before the cutoff. It
        // predates the announcement, so it is kept and the annotated paragraph is cut.
        title: "Example Capital City",
        ns: 0,
        id: 14,
        revisions: [
          {
            id: 18,
            timestamp: "2016-01-01T00:00:00Z",
            text: "The rewritten capital, lorem.",
          },
          {
            id: 17,
            timestamp: "2010-09-15T00:00:00Z",
            text: [
              "{{zonebox|patch=4.0.1}}'''Example Capital City''' is the seat of the example kingdom.",
              "",
              "In Cataclysm the city is rearranged and the harbour is rebuilt.",
              "",
              "[[Category:Cataclysm]]",
            ].join("\n"),
          },
          {
            id: 16,
            timestamp: "2005-06-01T00:00:00Z",
            text: "'''Example Capital City''' is the seat of the example kingdom.",
          },
        ],
      },
      {
        // Out-of-game: classified by title, never emitted.
        title: "Hotfixes/2015 Archive",
        ns: 0,
        id: 8,
        revisions: [{ id: 10, timestamp: "2009-01-01T00:00:00Z", text: "Archive of notes, lorem." }],
      },
      {
        // Nothing but an infobox: no prose to index, and none was cut either.
        title: "Example Empty Page",
        ns: 0,
        id: 9,
        revisions: [{ id: 11, timestamp: "2009-01-01T00:00:00Z", text: "{{zonebox|level=5}}" }],
      },
      {
        title: "Talk:Example Quest Alpha",
        ns: 1,
        id: 10,
        revisions: [{ id: 12, timestamp: "2016-01-01T00:00:00Z", text: "chatter, lorem." }],
      },
    ]),
  );

  const proc = Bun.spawn(
    // `--no-canary`: the fixtures are invented pages, so the capitals the
    // canary requires are not among them. `canary.test.ts` covers the gate.
    ["bun", join(import.meta.dir, "..", "src", "build.ts"), xmlPath, "--out", outPath, "--no-canary"],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(await proc.exited).toBe(0);

  expect(existsSync(outPath)).toBe(true);
  const db = new Database(outPath, { readonly: true });

  const pages = db.query<{ n: number }, []>("SELECT count(*) AS n FROM pages").get()!;
  // Alpha, Beta, Zeta and the capital. The talk page is out of namespace; the
  // late pages, the Cataclysm stub and the hotfix archive are dropped; the
  // infobox-only page is empty; the two redirects are not pages.
  expect(pages.n).toBe(4);
  const redirects = db.query<{ n: number }, []>("SELECT count(*) AS n FROM redirects").get()!;
  expect(redirects.n).toBe(1); // the dangling one went with its target
  const meta = db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?");
  const metaValue = (key: string): string => meta.get(key)!.value;
  const metaNumber = (key: string): number => Number.parseInt(metaValue(key), 10);
  expect(metaValue("pages_kept")).toBe("4");

  // The prose came from the pre-cutoff revision and the templates are gone from
  // the indexed text; the id below still comes off the newest revision.
  const alpha = searchReference(db, "Example Quest Alpha")[0]!;
  expect(alpha.snippet).toContain("older draft");
  expect(alpha.snippet).not.toContain("questbox");
  expect(alpha.snippet).not.toContain("the beta zone");

  // Redirects resolve, and one whose target is not in the bundle is not either.
  const viaRedirect = searchReference(db, "Example Old Name")[0]!;
  expect(viaRedirect.title).toBe("Example Zone Beta");
  const redirectSources = db
    .query<{ source: string }, []>("SELECT source FROM redirects ORDER BY source")
    .all()
    .map((r) => r.source);
  expect(redirectSources).toEqual(["Example Old Name"]);

  // Full text search works over the stripped text.
  const beta = searchReference(db, "consectetur")[0]!;
  expect(beta.title).toBe("Example Zone Beta");
  // Its Cataclysm paragraph and its Cataclysm section were cut before the strip,
  // and nothing was left in their place.
  expect(beta.snippet).not.toContain("Cataclysm");
  expect(beta.snippet).not.toContain("road runs south");
  expect(searchReference(db, "does not run")).toEqual([]);
  expect(metaValue("sections_dropped")).toBe("1");
  // Beta's Cataclysm paragraph, and the capital's: protection keeps the page,
  // it does not keep the paragraph that named a later world.
  expect(metaValue("paragraphs_dropped")).toBe("2");
  const capital = searchReference(db, "Example Capital City")[0]!;
  expect(capital.snippet).toContain("seat of the example kingdom");
  expect(capital.snippet).not.toContain("harbour is rebuilt");
  expect(capital.snippet).not.toContain("rewritten capital");
  // The out-of-world trim is a separate counter, with a breakdown saying what
  // went. The link section is gone and left no heading behind.
  expect(beta.snippet).not.toContain("Example Beta entry");
  expect(beta.snippet).not.toContain("External links");
  expect(beta.snippet).not.toContain("Removable background");
  expect(metaValue("sections_trimmed")).toBe("2");
  // Sorted, not in the order the dump happened to state them: the breakdown is
  // part of what makes a rebuild reproducible.
  expect(metaValue("sections_trimmed_json")).toBe('{"background":1,"external links":1}');
  // Coords were lifted off the raw wikitext before the strip and persisted.
  expect(beta.coords).toEqual([{ zone: "Example Zone Beta", x: 48.2, y: 42.1 }]);
  expect(beta.snippet).not.toContain("coords"); // the template is gone from text
  const coordRows = db.query<{ n: number }, []>("SELECT count(*) AS n FROM page_coords").get()!;
  expect(coordRows.n).toBe(1);
  expect(metaValue("schema_version")).toBe("5");

  // Ids were lifted off the raw wikitext too, and an id query finds the page
  // through the id table rather than through body prose.
  const idRows = db.query<{ n: number }, []>("SELECT count(*) AS n FROM page_ids").get()!;
  expect(idRows.n).toBe(1);
  expect(metaValue("id_rows")).toBe("1");
  const byId = searchReference(db, "quest 4242")[0]!;
  expect(byId.title).toBe("Example Quest Alpha");
  expect(byId.matchedId).toEqual({ kind: "quest", id: 4242 });

  // The era channel records what it did: the cutoff, the pages whose prose came
  // from an older revision, and one reason per page for being in or out.
  expect(metaValue("era_cutoff")).toBe(DEFAULT_ERA_CUTOFF);
  expect(metaValue("pages_era_swapped")).toBe("3"); // alpha, beta and the capital
  expect(metaValue("pages_pre_cutoff")).toBe("3");
  // A subset of `pages_pre_cutoff`, deliberately outside the identity below:
  // the capital carried a post-Wrath signal and predates the Cataclysm announcement.
  expect(metaValue("pages_pre_announcement_protected")).toBe("1");
  expect(metaValue("pages_post_cutoff_wrath_signal")).toBe("1"); // the trinket
  // The late page that says nothing, and the late page that names Cataclysm:
  // neither has prose from before the cutoff, which is the reason for both.
  expect(metaValue("pages_dropped_post_cutoff")).toBe("2");
  expect(metaValue("pages_dropped_post_wrath")).toBe("1");
  expect(metaValue("pages_dropped_meta")).toBe("1");
  expect(metaValue("empty_pages")).toBe("1");
  expect(metaValue("redirects_dropped_dangling")).toBe("1");

  // Every non-redirect page the parser yielded is accounted for exactly once.
  // Nothing else here catches a page counted twice or lost silently.
  const accounted =
    metaNumber("pages_pre_cutoff") +
    metaNumber("pages_post_cutoff_wrath_signal") +
    metaNumber("pages_dropped_post_cutoff") +
    metaNumber("pages_dropped_post_wrath") +
    metaNumber("pages_dropped_meta") +
    metaNumber("empty_pages");
  expect(accounted).toBe(
    metaNumber("pages_in_namespaces") - metaNumber("redirects") - metaNumber("redirects_dropped_dangling"),
  );

  // The dropped namespace is really absent, and so are the dropped pages: a
  // dropped title is not a page, not an exact-title hit, and not in the index.
  expect(searchReference(db, "chatter")).toEqual([]);
  const titles = db
    .query<{ title: string }, []>("SELECT title FROM pages ORDER BY title")
    .all()
    .map((r) => r.title);
  expect(titles).toEqual([
    "Example Capital City",
    "Example Item Zeta",
    "Example Quest Alpha",
    "Example Zone Beta",
  ]);
  for (const gone of [
    "Example Late Page",
    "Example Zone Theta",
    "Example Zone Iota",
    "Hotfixes/2015 Archive",
  ]) {
    expect(searchReference(db, gone).some((h) => h.title === gone)).toBe(false);
  }
  expect(searchReference(db, "Example Item Zeta")[0]!.title).toBe("Example Item Zeta");

  db.close();

  // Rebuilding replaces the bundle in place.
  const again = Bun.spawn(
    // `--no-canary`: the fixtures are invented pages, so the capitals the
    // canary requires are not among them. `canary.test.ts` covers the gate.
    ["bun", join(import.meta.dir, "..", "src", "build.ts"), xmlPath, "--out", outPath, "--no-canary"],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(await again.exited).toBe(0);
  const db2 = new Database(outPath, { readonly: true });
  expect(db2.query<{ n: number }, []>("SELECT count(*) AS n FROM pages").get()!.n).toBe(4);
  db2.close();
}, 30_000);

test("a page split into 50-revision blocks builds as one row", async () => {
  const xmlPath = join(dir, "split-dump.xml");
  const outPath = join(dir, "split-bundle.sqlite");
  // Three consecutive <page> blocks for one title, newest-first as the dump
  // emits them, plus a neighbour that must stay its own page.
  await Bun.write(
    xmlPath,
    renderDump([
      {
        title: "Example Long History",
        ns: 0,
        id: 1,
        revisions: [
          { id: 30, timestamp: "2018-01-01T00:00:00Z", text: "The current lorem, full of consectetur." },
        ],
      },
      {
        title: "Example Long History",
        ns: 0,
        id: 1,
        revisions: [{ id: 20, timestamp: "2012-01-01T00:00:00Z", text: "A middling draft, lorem." }],
      },
      {
        title: "Example Long History",
        ns: 0,
        id: 1,
        revisions: [{ id: 10, timestamp: "2006-01-01T00:00:00Z", text: "The oldest stub, lorem." }],
      },
      {
        title: "Example Zone Beta",
        ns: 0,
        id: 2,
        revisions: [
          { id: 41, timestamp: "2016-01-01T00:00:00Z", text: "Example Zone Beta is a rewritten region." },
          { id: 40, timestamp: "2009-01-01T00:00:00Z", text: "Example Zone Beta is a region." },
        ],
      },
    ]),
  );

  const proc = Bun.spawn(
    // `--no-canary`: the fixtures are invented pages, so the capitals the
    // canary requires are not among them. `canary.test.ts` covers the gate.
    ["bun", join(import.meta.dir, "..", "src", "build.ts"), xmlPath, "--out", outPath, "--no-canary"],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(await proc.exited).toBe(0);

  const db = new Database(outPath, { readonly: true });
  const counts = db
    .query<{ rows: number; keys: number }, []>(
      "SELECT count(*) AS rows, count(DISTINCT title || ns) AS keys FROM pages",
    )
    .get()!;
  expect(counts).toEqual({ rows: 2, keys: 2 });
  const meta = db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?");
  expect(meta.get("pages_distinct_keys")!.value).toBe("2");
  expect(meta.get("pages_kept")!.value).toBe("2");
  // Four blocks were read for two pages.
  expect(meta.get("page_blocks_seen")!.value).toBe("4");

  // One row, and its prose is the newest pre-cutoff revision — which arrived in
  // the third block, not the first.
  const hit = searchReference(db, "Example Long History")[0]!;
  expect(hit.snippet).toContain("oldest stub");
  // "consectetur" appears only in the post-cutoff text, so it is not indexed.
  expect(searchReference(db, "consectetur")).toEqual([]);
  // Both pages here have a newer revision than the one their prose came from.
  expect(meta.get("pages_era_swapped")!.value).toBe("2");
  db.close();
}, 30_000);

test("the build refuses to ship two rows for one page", () => {
  const db = new Database(":memory:");
  createSchema(db);
  const writer = makeWriter(db, 10);
  writer.addPage("Example Long History", 0, "The current lorem.");
  writer.addPage("Example Long History", 0, "A stale draft, lorem.");
  writer.flush();
  expect(() => assertUniquePages(db)).toThrow(/distinct \(title, ns\)/);

  // The same title in two namespaces is two pages, not a duplicate.
  const clean = new Database(":memory:");
  createSchema(clean);
  const cleanWriter = makeWriter(clean, 10);
  cleanWriter.addPage("Example Shared Name", 0, "The article, lorem.");
  cleanWriter.addPage("Example Shared Name", 14, "The category, lorem.");
  cleanWriter.flush();
  expect(assertUniquePages(clean)).toBe(2);
});

test("the canary refuses to rename a bundle that lost this world's pages", async () => {
  const xmlPath = join(dir, "canary-dump.xml");
  const outPath = join(dir, "canary-bundle.sqlite");
  await Bun.write(
    xmlPath,
    renderDump([
      {
        title: "Example Zone Beta",
        ns: 0,
        id: 1,
        revisions: [
          { id: 1, timestamp: "2009-01-01T00:00:00Z", text: "A zone of lorem ipsum." },
        ],
      },
    ]),
  );
  // No `--no-canary` here: a full build must contain the capitals, and this
  // dump contains none of them.
  const proc = Bun.spawn(
    ["bun", join(import.meta.dir, "..", "src", "build.ts"), xmlPath, "--out", outPath],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(await proc.exited).toBe(1);
  expect(await new Response(proc.stderr).text()).toContain("canary failed");
  // The bundle was not written, and neither was the temp file beside it.
  expect(existsSync(outPath)).toBe(false);
  expect(readdirSync(dir).filter((f) => f.startsWith(".canary-bundle"))).toEqual([]);
}, 30_000);

test("--no-canary and --max-pages decide whether the gate runs", () => {
  expect(parseArgs(["dump.xml"]).canary).toBe(true);
  expect(parseArgs(["dump.xml", "--no-canary"]).canary).toBe(false);
  // A smoke build stops before most of the dump, so the gate is off unless it
  // is asked for.
  expect(parseArgs(["dump.xml", "--max-pages", "50"]).canary).toBe(false);
  expect(parseArgs(["dump.xml", "--max-pages", "50", "--canary"]).canary).toBe(true);
});

test("--era-cutoff overrides the default and is validated before the stream", () => {
  expect(parseArgs(["dump.xml"]).eraCutoff).toBe(DEFAULT_ERA_CUTOFF);
  expect(parseArgs(["dump.xml", "--era-cutoff", "2009-01-01T00:00:00Z"]).eraCutoff).toBe(
    "2009-01-01T00:00:00Z",
  );
  // A date without a time would compare wrongly against the dump's timestamps
  // and quietly drop every page in the bundle.
  expect(() => parseArgs(["dump.xml", "--era-cutoff", "2010-10-12"])).toThrow(/ISO-8601/);
  expect(() => parseArgs(["dump.xml", "--era-cutoff", "yesterday"])).toThrow(/ISO-8601/);
});
