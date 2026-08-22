import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
            id: 3,
            timestamp: "2016-01-01T00:00:00Z",
            text: "{{coords|48.2|42.1|Example Zone Beta}}'''Example Zone Beta''' is a starting region full of consectetur.",
          },
        ],
      },
      {
        title: "Example Old Name",
        ns: 0,
        id: 3,
        revisions: [
          { id: 4, timestamp: "2016-01-01T00:00:00Z", text: "#REDIRECT [[Example Zone Beta]]" },
        ],
      },
      {
        title: "Talk:Example Quest Alpha",
        ns: 1,
        id: 4,
        revisions: [{ id: 5, timestamp: "2016-01-01T00:00:00Z", text: "chatter, lorem." }],
      },
    ]),
  );

  const proc = Bun.spawn(
    ["bun", join(import.meta.dir, "..", "src", "build.ts"), xmlPath, "--out", outPath],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(await proc.exited).toBe(0);

  expect(existsSync(outPath)).toBe(true);
  const db = new Database(outPath, { readonly: true });

  const pages = db.query<{ n: number }, []>("SELECT count(*) AS n FROM pages").get()!;
  expect(pages.n).toBe(2); // the redirect and the talk page are not pages
  const redirects = db.query<{ n: number }, []>("SELECT count(*) AS n FROM redirects").get()!;
  expect(redirects.n).toBe(1);
  const meta = db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?");
  expect(meta.get("pages_kept")!.value).toBe("2");

  // The newest revision won, and the template is gone from the indexed text.
  const alpha = searchReference(db, "Example Quest Alpha")[0]!;
  expect(alpha.snippet).toContain("the beta zone");
  expect(alpha.snippet).not.toContain("questbox");
  expect(alpha.snippet).not.toContain("older draft");

  // Redirects resolve.
  const viaRedirect = searchReference(db, "Example Old Name")[0]!;
  expect(viaRedirect.title).toBe("Example Zone Beta");

  // Full text search works over the stripped text.
  const beta = searchReference(db, "consectetur")[0]!;
  expect(beta.title).toBe("Example Zone Beta");
  // Coords were lifted off the raw wikitext before the strip and persisted.
  expect(beta.coords).toEqual([{ zone: "Example Zone Beta", x: 48.2, y: 42.1 }]);
  expect(beta.snippet).not.toContain("coords"); // the template is gone from text
  const coordRows = db.query<{ n: number }, []>("SELECT count(*) AS n FROM page_coords").get()!;
  expect(coordRows.n).toBe(1);
  expect(db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key=?").get("schema_version")!.value).toBe("3");

  // Ids were lifted off the raw wikitext too, and an id query finds the page
  // through the id table rather than through body prose.
  const idRows = db.query<{ n: number }, []>("SELECT count(*) AS n FROM page_ids").get()!;
  expect(idRows.n).toBe(1);
  expect(db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key=?").get("id_rows")!.value).toBe("1");
  const byId = searchReference(db, "quest 4242")[0]!;
  expect(byId.title).toBe("Example Quest Alpha");
  expect(byId.matchedId).toEqual({ kind: "quest", id: 4242 });

  // The dropped namespace is really absent.
  expect(searchReference(db, "chatter")).toEqual([]);

  db.close();

  // Rebuilding replaces the bundle in place.
  const again = Bun.spawn(
    ["bun", join(import.meta.dir, "..", "src", "build.ts"), xmlPath, "--out", outPath],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(await again.exited).toBe(0);
  const db2 = new Database(outPath, { readonly: true });
  expect(db2.query<{ n: number }, []>("SELECT count(*) AS n FROM pages").get()!.n).toBe(2);
  db2.close();
}, 30_000);
