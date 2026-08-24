import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertUniquePages, createSchema, makeWriter } from "../src/bundle";
import { eraSource, parseArgs, siblingRedirects } from "../src/build";
import { DEFAULT_ERA_CUTOFF } from "../src/wrath-only";
import { EMPTY_PAGE_SNIPPET, searchReference } from "../src/search";
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
        // An infobox and a link list: the out-of-world trim takes the only prose
        // it has. The page is this world's all the same, and its id is the whole
        // reason it must stay findable.
        title: "Example Item Kappa",
        ns: 0,
        id: 11,
        revisions: [
          {
            id: 13,
            timestamp: "2009-01-01T00:00:00Z",
            text: [
              "{{itembox|patch=3.0.2|itemid=7311}}",
              "",
              "== External links ==",
              "* [http://example.invalid/kappa Example Kappa entry]",
            ].join("\n"),
          },
        ],
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
  // Alpha, Beta, Zeta and the capital, plus two rows with no prose: the
  // infobox-only page and the one the out-of-world trim emptied. The talk page
  // is out of namespace; the late pages, the Cataclysm stub and the hotfix
  // archive are dropped; the two redirects are not pages.
  expect(pages.n).toBe(6);
  const redirects = db.query<{ n: number }, []>("SELECT count(*) AS n FROM redirects").get()!;
  expect(redirects.n).toBe(1); // the dangling one went with its target
  const meta = db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?");
  const metaValue = (key: string): string => meta.get(key)!.value;
  const metaNumber = (key: string): number => Number.parseInt(metaValue(key), 10);
  expect(metaValue("pages_kept")).toBe("6");

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
  // Beta's Cataclysm paragraph only. The capital's never reaches the paragraph
  // rules: the capital is protected, so its prose steps back to the revision
  // before the annotation was written and that paragraph is not in it.
  expect(metaValue("paragraphs_dropped")).toBe("1");
  const capital = searchReference(db, "Example Capital City")[0]!;
  expect(capital.snippet).toContain("seat of the example kingdom");
  expect(capital.snippet).not.toContain("harbour is rebuilt");
  expect(capital.snippet).not.toContain("rewritten capital");
  // The out-of-world trim is a separate counter, with a breakdown saying what
  // went. The link section is gone and left no heading behind.
  expect(beta.snippet).not.toContain("Example Beta entry");
  expect(beta.snippet).not.toContain("External links");
  expect(beta.snippet).not.toContain("Removable background");
  // Two on Beta, one on the item page the trim empties.
  expect(metaValue("sections_trimmed")).toBe("3");
  // Sorted, not in the order the dump happened to state them: the breakdown is
  // part of what makes a rebuild reproducible.
  expect(metaValue("sections_trimmed_json")).toBe('{"background":1,"external links":2}');
  // Coords were lifted off the raw wikitext before the strip and persisted.
  expect(beta.coords).toEqual([{ zone: "Example Zone Beta", x: 48.2, y: 42.1 }]);
  expect(beta.snippet).not.toContain("coords"); // the template is gone from text
  const coordRows = db.query<{ n: number }, []>("SELECT count(*) AS n FROM page_coords").get()!;
  expect(coordRows.n).toBe(1);
  expect(metaValue("schema_version")).toBe("5");

  // Ids were lifted off the raw wikitext too, and an id query finds the page
  // through the id table rather than through body prose.
  // Two: the quest page's own id, and the id on the page the trim emptied —
  // which is only here because that page kept its row.
  const idRows = db.query<{ n: number }, []>("SELECT count(*) AS n FROM page_ids").get()!;
  expect(idRows.n).toBe(2);
  expect(metaValue("id_rows")).toBe("2");
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
  // Same shape, same exclusion: the capital's prose came from the last revision
  // with no post-Wrath signal on it, which is an older one than the era slot's.
  expect(metaValue("pages_stepped_back")).toBe("1");
  expect(metaValue("pages_step_back_refused")).toBe("0");
  expect(metaValue("pages_post_cutoff_wrath_signal")).toBe("1"); // the trinket
  // This build was given no world-id export, so the id door does not exist and
  // `meta` says so rather than leaving it to be inferred from a zero.
  expect(metaValue("world_ids")).toBe("none");
  expect(metaValue("pages_post_cutoff_id_match")).toBe("0");
  // The late page that says nothing, and the late page that names Cataclysm:
  // neither has prose from before the cutoff, which is the reason for both.
  expect(metaValue("pages_dropped_post_cutoff")).toBe("2");
  expect(metaValue("pages_dropped_post_wrath")).toBe("1");
  expect(metaValue("pages_dropped_meta")).toBe("1");
  // Two rows with no prose: the infobox-only page, which never had any, and the
  // item page the out-of-world trim emptied, which is the subset counter.
  expect(metaValue("empty_pages")).toBe("2");
  expect(metaValue("pages_emptied_by_trim")).toBe("1");
  expect(metaValue("redirects_dropped_dangling")).toBe("1");

  // Every non-redirect page the parser yielded is accounted for exactly once.
  // Nothing else here catches a page counted twice or lost silently.
  //
  // The term on the right is `pages_era_redirect` and not `redirects`: a
  // redirect row can now be generated for a title that is also a counted page
  // (a page move left the name behind), so the rows written are no longer the
  // pages that were redirects at the cutoff. Those are, and they are the only
  // yielded pages that go into no reason bucket.
  expect(metaValue("pages_era_redirect")).toBe("2");
  expect(metaValue("redirects_recovered_newest")).toBe("0");
  expect(metaValue("redirects_original_sibling")).toBe("0");
  const accounted =
    metaNumber("pages_pre_cutoff") +
    metaNumber("pages_post_cutoff_wrath_signal") +
    metaNumber("pages_post_cutoff_id_match") +
    metaNumber("pages_dropped_post_cutoff") +
    metaNumber("pages_dropped_post_wrath") +
    metaNumber("pages_dropped_meta") +
    metaNumber("empty_pages");
  expect(accounted).toBe(metaNumber("pages_in_namespaces") - metaNumber("pages_era_redirect"));
  // A subset counter, never a bucket: adding it to the sum would double-count.
  expect(metaNumber("pages_emptied_by_trim")).toBeLessThanOrEqual(metaNumber("empty_pages"));
  // Every row in the bundle is an admitted page or an empty one, and nothing else.
  expect(metaNumber("pages_kept")).toBe(
    metaNumber("pages_pre_cutoff") +
      metaNumber("pages_post_cutoff_wrath_signal") +
      metaNumber("pages_post_cutoff_id_match") +
      metaNumber("empty_pages"),
  );

  // A page the trim emptied keeps its row: the prose is gone, the title and the
  // id are not, and both still answer a query. This is the whole point of not
  // dropping it — an item page whose body was an infobox and a link list is
  // still this world's item.
  const kappa = searchReference(db, "Example Item Kappa")[0]!;
  expect(kappa.title).toBe("Example Item Kappa");
  expect(kappa.exactTitle).toBe(true);
  // Kappa states an item id and nothing else, so the whole snippet is the
  // literal: the page says what it states, and does not pretend to prose.
  expect(kappa.snippet).toBe(EMPTY_PAGE_SNIPPET);
  expect(kappa.snippet).not.toContain("Example Kappa entry");
  const byItemId = searchReference(db, "item 7311")[0]!;
  expect(byItemId.title).toBe("Example Item Kappa");
  expect(byItemId.matchedId).toEqual({ kind: "item", id: 7311 });
  // It is a row, not an FTS document: a page with nothing to say must not be
  // ranked, on the shortness of its own body, against pages that have
  // something. Its title is not in the index either — exact-title resolution
  // and the id table are what find it.
  const ftsHits = db
    .query<{ n: number }, [string]>(
      "SELECT count(*) AS n FROM pages_fts WHERE pages_fts MATCH ?",
    );
  expect(ftsHits.get("kappa")!.n).toBe(0);
  expect(ftsHits.get("consectetur")!.n).toBe(1);

  // The dropped namespace is really absent, and so are the dropped pages: a
  // dropped title is not a page, not an exact-title hit, and not in the index.
  expect(searchReference(db, "chatter")).toEqual([]);
  const titles = db
    .query<{ title: string }, []>("SELECT title FROM pages ORDER BY title")
    .all()
    .map((r) => r.title);
  expect(titles).toEqual([
    "Example Capital City",
    "Example Empty Page",
    "Example Item Kappa",
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
  expect(db2.query<{ n: number }, []>("SELECT count(*) AS n FROM pages").get()!.n).toBe(6);
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

/**
 * Page moves, and the names they leave behind.
 *
 * MediaWiki carries a page's history to the destination when a page is moved,
 * so a title Cataclysm took over holds the *new* article's whole history and is
 * correctly dropped here — taking the name with it. Every fixture is invented;
 * the shapes are real, the pages are not.
 */
test("a name survives the page move that emptied its title", async () => {
  const xmlPath = join(dir, "moved-dump.xml");
  const outPath = join(dir, "moved-bundle.sqlite");
  await Bun.write(
    xmlPath,
    renderDump([
      {
        // The survivor: this world's article, under the title the move gave it.
        title: "Example Delve (original)",
        ns: 0,
        id: 1,
        revisions: [
          {
            id: 1,
            timestamp: "2009-01-01T00:00:00Z",
            text: "'''Example Delve''' is a mine full of consectetur, east of the example road.",
          },
        ],
      },
      {
        // The bare title. Its own history is the later world's article, so the
        // page is dropped — and the name a character searches for goes with it
        // unless the `(original)` sibling puts it back.
        title: "Example Delve",
        ns: 0,
        id: 2,
        revisions: [
          {
            id: 3,
            timestamp: "2013-01-01T00:00:00Z",
            text: "{{stub/Cataclysm}}The rebuilt delve, lorem ipsum.",
          },
          {
            id: 2,
            timestamp: "2010-09-20T00:00:00Z",
            text: "{{zonebox|patch=4.0.1}}The rebuilt delve, lorem.",
          },
        ],
      },
      {
        // No pre-cutoff revision at all, so no page. Its newest revision says
        // where the name went, and the target is in the bundle.
        title: "Example Warren",
        ns: 0,
        id: 3,
        revisions: [
          {
            id: 4,
            timestamp: "2016-01-01T00:00:00Z",
            text: "#REDIRECT [[Example Warren (dungeon)]]",
          },
        ],
      },
      {
        title: "Example Warren (dungeon)",
        ns: 0,
        id: 4,
        revisions: [
          {
            id: 5,
            timestamp: "2009-01-01T00:00:00Z",
            text: "'''Example Warren''' is a burrow of adipiscing under the example hill.",
          },
        ],
      },
      {
        // A chain: the bare title has no page and no redirect, its `(original)`
        // sibling is itself only a redirect, and the page is a hop further on.
        title: "Example Hold (original)",
        ns: 0,
        id: 5,
        revisions: [
          {
            id: 6,
            timestamp: "2017-01-01T00:00:00Z",
            text: "#REDIRECT [[The Hold (original)]]",
          },
        ],
      },
      {
        title: "The Hold (original)",
        ns: 0,
        id: 6,
        revisions: [
          {
            id: 7,
            timestamp: "2009-01-01T00:00:00Z",
            text: "'''The Hold''' is a gaol of elit beneath the example keep.",
          },
        ],
      },
      {
        // A 2010 redirect whose target was itself renamed afterwards: the era
        // target is gone, the newest revision names one that is here.
        title: "Example Old Spelling",
        ns: 0,
        id: 7,
        revisions: [
          {
            id: 9,
            timestamp: "2018-01-01T00:00:00Z",
            text: "#REDIRECT [[Example Warren (dungeon)]]",
          },
          {
            id: 8,
            timestamp: "2009-06-01T00:00:00Z",
            text: "#REDIRECT [[Example Warren Vanished]]",
          },
        ],
      },
      {
        // Out-of-game, and its newest revision is a redirect to a page that is
        // here. The name still stays out: a patch archive is dropped, not
        // demoted, so it must not come back as something search can return.
        title: "Patch 4.0.1",
        ns: 0,
        id: 8,
        revisions: [
          {
            id: 10,
            timestamp: "2016-01-01T00:00:00Z",
            text: "#REDIRECT [[Example Warren (dungeon)]]",
          },
        ],
      },
      {
        // A bare title whose `(original)` sibling leads nowhere: no page, no
        // redirect row, counted dangling like any other candidate.
        title: "Example Nowhere (original)",
        ns: 0,
        id: 9,
        revisions: [
          { id: 11, timestamp: "2017-01-01T00:00:00Z", text: "#REDIRECT [[Example Gone]]" },
        ],
      },
      // The shape that hid this world's article behind a title nobody types.
      // The bare title is a late article, so it is dropped and generates no
      // candidate at all — but a lower-cased spelling of it is a redirect, and
      // that redirect's own chain ends at the dropped page. A rule that reads
      // "is a redirect source" as "answers" leaves the bare title alone and the
      // `(original)` sibling is never reached.
      {
        title: "Example Chapel (original)",
        ns: 0,
        id: 10,
        revisions: [
          {
            id: 12,
            timestamp: "2009-01-01T00:00:00Z",
            text: "'''Example Chapel''' is a chapel of tempor north of the example ford.",
          },
        ],
      },
      {
        title: "Example Chapel",
        ns: 0,
        id: 11,
        revisions: [
          {
            id: 13,
            timestamp: "2013-01-01T00:00:00Z",
            text: "The rebuilt chapel, incididunt ut labore.",
          },
        ],
      },
      {
        title: "Example chapel",
        ns: 0,
        id: 12,
        revisions: [
          { id: 14, timestamp: "2016-01-01T00:00:00Z", text: "#REDIRECT [[Example Chapel]]" },
        ],
      },
      // The same defect through the other door: the bare title's own newest
      // revision is a redirect, and it points at a title this bundle does not
      // have. The candidate is dead, so it must not stand in the way of the
      // `(original)` sibling that is right there.
      {
        title: "Example Spire (original)",
        ns: 0,
        id: 13,
        revisions: [
          {
            id: 15,
            timestamp: "2009-01-01T00:00:00Z",
            text: "'''Example Spire''' is a tower of magna above the example vale.",
          },
        ],
      },
      {
        title: "Example Spire",
        ns: 0,
        id: 14,
        revisions: [
          {
            id: 16,
            timestamp: "2015-01-01T00:00:00Z",
            text: "#REDIRECT [[Example Spire (rebuilt)]]",
          },
        ],
      },
    ]),
  );

  const proc = Bun.spawn(
    ["bun", join(import.meta.dir, "..", "src", "build.ts"), xmlPath, "--out", outPath, "--no-canary"],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(await proc.exited).toBe(0);

  const db = new Database(outPath, { readonly: true });
  const meta = db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?");
  const metaValue = (key: string): string => meta.get(key)!.value;

  // The bare titles all answer, and they answer with this world's article.
  expect(searchReference(db, "Example Delve")[0]!.title).toBe("Example Delve (original)");
  expect(searchReference(db, "Example Warren")[0]!.title).toBe("Example Warren (dungeon)");
  expect(searchReference(db, "Example Hold")[0]!.title).toBe("The Hold (original)");
  expect(searchReference(db, "Example Old Spelling")[0]!.title).toBe("Example Warren (dungeon)");
  // A dangling candidate for the bare title — an alternate spelling's redirect,
  // or the title's own newest revision — no longer shadows the sibling.
  expect(searchReference(db, "Example Chapel")[0]!.title).toBe("Example Chapel (original)");
  expect(searchReference(db, "Example chapel")[0]!.title).toBe("Example Chapel (original)");
  expect(searchReference(db, "Example Spire")[0]!.title).toBe("Example Spire (original)");

  // Written targets resolve: a row pointing at a title with neither a page nor
  // a redirect of its own would be a dead row.
  const rows = db
    .query<{ source: string; target: string }, []>("SELECT source, target FROM redirects ORDER BY source")
    .all();
  expect(rows).toEqual([
    { source: "Example Chapel", target: "Example Chapel (original)" },
    { source: "Example Delve", target: "Example Delve (original)" },
    { source: "Example Hold", target: "Example Hold (original)" },
    { source: "Example Hold (original)", target: "The Hold (original)" },
    { source: "Example Old Spelling", target: "Example Warren (dungeon)" },
    { source: "Example Spire", target: "Example Spire (original)" },
    { source: "Example Warren", target: "Example Warren (dungeon)" },
    // The alternate spelling lands too, and through the sibling: its own
    // candidate pointed at the dropped bare title, which now answers.
    { source: "Example chapel", target: "Example Chapel" },
    // The destination of the chain is a moved page too, and its own bare title
    // was free: the rule does not care how the sibling got into the bundle.
    { source: "The Hold", target: "The Hold (original)" },
  ]);

  // The out-of-game title is not a page and not a name either.
  expect(searchReference(db, "Patch 4.0.1").some((h) => h.title === "Patch 4.0.1")).toBe(false);
  expect(metaValue("pages_dropped_meta")).toBe("1");

  // Four through the newest revision — the late page, the renamed target, the
  // sibling that is itself only a redirect, and the alternate spelling — and
  // five through an `(original)` sibling.
  expect(metaValue("redirects_recovered_newest")).toBe("4");
  expect(metaValue("redirects_original_sibling")).toBe("5");
  expect(metaValue("redirects")).toBe("9");
  // One page in this dump was a redirect at the cutoff. Everything else here is
  // a name recovered afterwards, which is why the accounting identity counts
  // this and not the rows written.
  expect(metaValue("pages_era_redirect")).toBe("1");
  // `Example Nowhere (original)` leads nowhere, and no sibling is generated
  // from it any more: a sibling is only made from a page or from a redirect
  // that landed, so it can never point into a dead row. The other dangling one
  // is `Example Spire`'s own newest revision, whose title the sibling claimed.
  expect(metaValue("redirects_dropped_dangling")).toBe("2");
  // The bare `Example Delve` is still a dropped page, counted under its reason:
  // recovering the name does not put the page back.
  expect(metaValue("pages_dropped_post_wrath")).toBe("1");
  db.close();
}, 30_000);

test("siblingRedirects prefers (original), and leaves a title that already answers alone", () => {
  const survivors = [
    { title: "Example Delve (original)", ns: 0 },
    { title: "Example Delve (old)", ns: 0 },
    { title: "Example Kept (old)", ns: 0 },
    { title: "Example Answered (original)", ns: 0 },
    { title: "Example Article", ns: 0 },
    { title: "Example Category (original)", ns: 14 },
  ];
  const resolvable = new Set(["example answered", "example article"]);
  expect(siblingRedirects(survivors, resolvable).sort((a, b) => (a.source < b.source ? -1 : 1))).toEqual([
    { source: "Example Category", target: "Example Category (original)", ns: 14 },
    { source: "Example Delve", target: "Example Delve (original)", ns: 0 },
    { source: "Example Kept", target: "Example Kept (old)", ns: 0 },
  ]);
});

/**
 * Titles Cataclysm coined: not a page, and not a name either.
 *
 * The prose is invented, as everywhere here. The titles are real, because the
 * rule is a list of them — the same names `verify.ts` and FOLLOW-UPS already
 * write down.
 */
test("a Cataclysm-coined title is neither a page nor a recovered name", async () => {
  const xmlPath = join(dir, "coinage-dump.xml");
  const outPath = join(dir, "coinage-bundle.sqlite");
  await Bun.write(
    xmlPath,
    renderDump([
      {
        // Old enough to be protected, and its pre-cutoff revision says nothing
        // about a later expansion. The title is what drops it.
        title: "Southern Barrens",
        ns: 0,
        id: 1,
        revisions: [
          {
            id: 1,
            timestamp: "2006-06-03T00:00:00Z",
            text: "A stretch of savannah, lorem ipsum dolor sit amet consectetur.",
          },
        ],
      },
      {
        // No pre-cutoff revision, so no page — and its newest revision is a
        // redirect to a page that *is* here, which is exactly what `keepAsName`
        // would otherwise recover.
        title: "Northern Barrens",
        ns: 0,
        id: 2,
        revisions: [
          { id: 2, timestamp: "2012-01-01T00:00:00Z", text: "#REDIRECT [[The Barrens]]" },
        ],
      },
      {
        title: "The Barrens",
        ns: 0,
        id: 3,
        revisions: [
          {
            id: 3,
            timestamp: "2009-01-01T00:00:00Z",
            text: "'''The Barrens''' is a stretch of savannah, lorem ipsum dolor sit.",
          },
        ],
      },
      {
        // A redirect at the cutoff, so it goes down the era-redirect path
        // rather than through `keepAsName`. Vetoed there too.
        title: "Twilight Highlands",
        ns: 0,
        id: 5,
        revisions: [
          { id: 5, timestamp: "2010-09-01T00:00:00Z", text: "#REDIRECT [[The Barrens]]" },
        ],
      },
      {
        // On neither list: the name is older than the expansion that took it,
        // so the page stays and `verify.ts` gates what it may say instead.
        title: "Deepholm",
        ns: 0,
        id: 4,
        revisions: [
          {
            id: 4,
            timestamp: "2009-01-01T00:00:00Z",
            text: "'''Deepholm''' is a plane of elit, lorem ipsum dolor sit amet.",
          },
        ],
      },
    ]),
  );

  const proc = Bun.spawn(
    ["bun", join(import.meta.dir, "..", "src", "build.ts"), xmlPath, "--out", outPath, "--no-canary"],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(await proc.exited).toBe(0);

  const db = new Database(outPath, { readonly: true });
  const titles = db
    .query<{ title: string }, []>("SELECT title FROM pages ORDER BY title")
    .all()
    .map((r) => r.title);
  expect(titles).toEqual(["Deepholm", "The Barrens"]);
  // Not a redirect source either, by any of the three routes a name comes back
  // on: a name that resolves is a name search returns.
  expect(db.query<{ source: string }, []>("SELECT source FROM redirects").all()).toEqual([]);
  // The redirect page is still counted as one; only the row is refused, so the
  // accounting identity is undisturbed.
  const meta = db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?");
  expect(meta.get("pages_era_redirect")!.value).toBe("1");
  // Neither title resolves as an exact title, directly or through a redirect.
  // Body prose still matches the word, which is what the full-text index is
  // for; what the rule denies is a page or a name under these titles.
  expect(searchReference(db, "Southern Barrens").some((r) => r.exactTitle === true)).toBe(false);
  expect(searchReference(db, "Northern Barrens").some((r) => r.exactTitle === true)).toBe(false);
  db.close();
}, 30_000);

/**
 * Which revision a protected page's prose comes from (ADR-0040, "a protected
 * page is the page before the beta touched it").
 */
const ARTICLE = "x".repeat(1000);

test("a protected page's prose steps back to the last revision with no signal on it", () => {
  expect(
    eraSource(
      {
        eraWikitext: ARTICLE,
        eraTimestamp: "2010-09-26T00:00:00Z",
        eraFreeWikitext: "y".repeat(800),
        eraFreeTimestamp: "2010-04-30T00:00:00Z",
      },
      true,
    ),
  ).toEqual({
    text: "y".repeat(800),
    timestamp: "2010-04-30T00:00:00Z",
    steppedBack: true,
    refused: false,
  });
});

test("stepping back is refused when it would trade an article for a stub", () => {
  const got = eraSource(
    {
      eraWikitext: ARTICLE,
      eraTimestamp: "2010-09-26T00:00:00Z",
      // Under a quarter of the article: a blanking or a stub, not the page.
      eraFreeWikitext: "y".repeat(200),
      eraFreeTimestamp: "2008-04-30T00:00:00Z",
    },
    true,
  );
  expect(got.text).toBe(ARTICLE);
  expect(got.timestamp).toBe("2010-09-26T00:00:00Z");
  expect(got.steppedBack).toBe(false);
  expect(got.refused).toBe(true);
});

test("a page that is not protected is never stepped back", () => {
  const got = eraSource(
    {
      eraWikitext: ARTICLE,
      eraTimestamp: "2010-09-26T00:00:00Z",
      eraFreeWikitext: "y".repeat(800),
      eraFreeTimestamp: "2010-04-30T00:00:00Z",
    },
    false,
  );
  expect(got.text).toBe(ARTICLE);
  expect(got.steppedBack).toBe(false);
  expect(got.refused).toBe(false);
});

test("no signal-free revision at all leaves the page on the one it has", () => {
  const got = eraSource(
    {
      eraWikitext: ARTICLE,
      eraTimestamp: "2010-09-26T00:00:00Z",
      eraFreeWikitext: null,
      eraFreeTimestamp: "",
    },
    true,
  );
  expect(got.text).toBe(ARTICLE);
  expect(got.steppedBack).toBe(false);
  expect(got.refused).toBe(false);
});

/**
 * `--world-ids`: a late page whose stated id exists on this server is admitted
 * (ADR-0042). The export here is invented, like every other fixture.
 */
test("the world-id door admits late pages, and only with the flag", async () => {
  const xmlPath = join(dir, "world-ids-dump.xml");
  const idsPath = join(dir, "world-ids.json");
  await Bun.write(
    idsPath,
    JSON.stringify({
      exported_at: "2026-08-24T12:00:00Z",
      quest: [4242],
      creature: [7001],
      item: [9100],
      gameobject: [3300],
    }),
  );
  await Bun.write(
    xmlPath,
    renderDump([
      {
        // Written in 2016, silent about its era, and the id is this server's.
        title: "Example Late Quest",
        ns: 118,
        id: 1,
        revisions: [
          {
            id: 1,
            timestamp: "2016-01-01T00:00:00Z",
            text: "{{questbox|id=4242}}Example Late Quest sends you to the lorem hills.",
          },
        ],
      },
      {
        // Same shape, an id this server does not have: still dropped.
        title: "Example Later Quest",
        ns: 118,
        id: 2,
        revisions: [
          {
            id: 2,
            timestamp: "2016-01-01T00:00:00Z",
            text: "{{questbox|id=90001}}Example Later Quest is somewhere else entirely.",
          },
        ],
      },
      {
        // The id is this server's — reused by a later expansion — but the page
        // says which world it belongs to, and the signal outranks the id.
        title: "Example Late Cataclysm Quest",
        ns: 118,
        id: 3,
        revisions: [
          {
            id: 3,
            timestamp: "2016-01-01T00:00:00Z",
            text: "{{questbox|id=4242}}[[Category:Cataclysm quests]]A quest of the later world.",
          },
        ],
      },
    ]),
  );

  const build = async (extra: string[]): Promise<Database> => {
    const outPath = join(dir, `world-ids-${extra.length}.sqlite`);
    const proc = Bun.spawn(
      [
        "bun",
        join(import.meta.dir, "..", "src", "build.ts"),
        xmlPath,
        "--out",
        outPath,
        "--no-canary",
        ...extra,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await proc.exited).toBe(0);
    return new Database(outPath, { readonly: true });
  };

  // Without the flag the build is what it always was: all three are late pages
  // that say nothing this world can act on.
  const without = await build([]);
  expect(without.query<{ n: number }, []>("SELECT count(*) AS n FROM pages").get()!.n).toBe(0);
  expect(
    without
      .query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?")
      .get("world_ids")!.value,
  ).toBe("none");
  without.close();

  const db = await build(["--world-ids", idsPath]);
  const titles = db
    .query<{ title: string }, []>("SELECT title FROM pages ORDER BY title")
    .all()
    .map((r) => r.title);
  expect(titles).toEqual(["Example Late Quest"]);
  const meta = db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?");
  const metaNumber = (key: string): number => Number.parseInt(meta.get(key)!.value, 10);
  expect(metaNumber("pages_post_cutoff_id_match")).toBe(1);
  expect(metaNumber("pages_dropped_post_cutoff")).toBe(2);
  // The export's identity is on the bundle, so a rebuild against a different
  // one is visible rather than inferred.
  const worldIds = JSON.parse(meta.get("world_ids")!.value) as {
    exported_at: string;
    counts: Record<string, number>;
  };
  expect(worldIds.exported_at).toBe("2026-08-24T12:00:00Z");
  expect(worldIds.counts).toEqual({ quest: 1, creature: 1, item: 1, gameobject: 1 });
  // The identity still holds with the sixth reason in it.
  const accounted =
    metaNumber("pages_pre_cutoff") +
    metaNumber("pages_post_cutoff_wrath_signal") +
    metaNumber("pages_post_cutoff_id_match") +
    metaNumber("pages_dropped_post_cutoff") +
    metaNumber("pages_dropped_post_wrath") +
    metaNumber("pages_dropped_meta") +
    metaNumber("empty_pages");
  expect(accounted).toBe(metaNumber("pages_in_namespaces") - metaNumber("pages_era_redirect"));
  db.close();
}, 30_000);
