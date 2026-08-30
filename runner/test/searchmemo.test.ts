/**
 * search_reference's ranking and its per-episode repeat memo, driven through
 * callTool against a synthetic in-memory bundle. Every page here is invented.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { createMemoryBundle, makeWriter } from "@wrathbench/wiki/bundle";
import { TOOLS, WIKI_COORDS_SENTENCE, callTool, normalizeSearchQuery, toolsFor, type ToolContext } from "../src/tools";
import { EpisodicLog } from "../src/episodic";
import { ReflectGate } from "../src/reflect";
import { Scratchpad } from "../src/scratchpad";
import type { SandboxHost } from "../src/sandbox/host";

function bundle(): Database {
  const db = createMemoryBundle();
  const writer = makeWriter(db, 2);
  writer.addPage(
    "Example Formula Notes",
    0,
    "Worked example: 4242 divided by two is 2121, and 4242 minus 42 is 4200. 4242 again.",
  );
  writer.addPage(
    "Example Quest Alpha",
    118,
    "Objectives: speak to Example Person Gamma in the beta zone.",
    undefined,
    [{ kind: "quest", id: 4242 }],
  );
  writer.addPage("Example Person Gamma", 0, "Example Person Gamma stands in the beta zone.");
  writer.addPage(
    "Example Person Delta",
    0,
    "Example Person Delta stands at (48.2, 42.1) in the beta zone.",
    [{ zone: "Beta Zone", x: 48.2, y: 42.1, raw: "{{coords|48.2|42.1|Beta Zone}}" }],
  );
  writer.flush();
  return db;
}

/**
 * A fresh context per test: the episode state is keyed on the ToolContext
 * object, so sharing one would leak a memo between cases.
 */
function context(wiki?: Database): ToolContext {
  const dir = mkdtempSync(join(tmpdir(), "wrathbench-memo-"));
  return {
    sandbox: {
      evalSnippet: () => Promise.resolve({ ok: true, value: "1", logs: [], durationMs: 1 }),
    } as unknown as SandboxHost,
    scratchpad: new Scratchpad(join(dir, "scratchpad.md")),
    wiki,
    sessionLive: () => true,
    reflect: new ReflectGate(),
    episodic: new EpisodicLog(join(dir, "episodic.jsonl")),
    turn: () => 1,
  };
}

const search = (ctx: ToolContext, query: string): Promise<{ text: string }> =>
  callTool(ctx, "search_reference", { query }) as Promise<{ text: string }>;

describe("normalizeSearchQuery", () => {
  test("case, punctuation and whitespace do not make a new query", () => {
    expect(normalizeSearchQuery("  Quest: A Threat!  ")).toBe(normalizeSearchQuery("quest a threat"));
    expect(normalizeSearchQuery("npc 4242")).not.toBe(normalizeSearchQuery("npc 4243"));
  });
});

describe("search_reference ranking through the tool", () => {
  test("an id query reaches the page that states the id, not the digits in prose", async () => {
    const ctx = context(bundle());
    const res = await search(ctx, "quest 4242");
    expect(res.text).toContain("# Example Quest Alpha");
    expect(res.text).toContain("matched quest id 4242");
    expect(res.text).not.toContain("Example Formula Notes");
  });

  test("an id query on a bundle without an id index says so", async () => {
    const db = bundle();
    db.run("DROP INDEX page_ids_lookup");
    db.run("DROP INDEX page_ids_page_id");
    db.run("DROP TABLE page_ids");
    const res = await search(context(db), "quest 4242");
    expect(res.text).toContain("no results");
    expect(res.text).toContain("no entity-id index");
  });
});

describe("the per-episode repeat memo", () => {
  test("the first search carries no note", async () => {
    const res = await search(context(bundle()), "Example Person Gamma");
    expect(res.text).not.toContain("note:");
  });

  test("a repeat says how long ago it was asked and that nothing changed", async () => {
    const ctx = context(bundle());
    await search(ctx, "Example Person Gamma");
    await callTool(ctx, "state_summary", {}).catch(() => undefined);
    const again = await search(ctx, "  example person GAMMA!  ");
    expect(again.text).toContain("note: you already ran this search");
    expect(again.text).toContain("Same top results: Example Person Gamma");
    // Counted in tool calls, including the one in between.
    expect(again.text).toMatch(/\d+ tool calls ago/);
    // The note is a prefix, not a replacement: the results are still there.
    expect(again.text).toContain("# Example Person Gamma");
  });

  test("a third ask counts the repeats", async () => {
    const ctx = context(bundle());
    await search(ctx, "Example Person Gamma");
    await search(ctx, "Example Person Gamma");
    const third = await search(ctx, "Example Person Gamma");
    expect(third.text).toContain("3 times this episode");
  });

  test("a different query gets its own memo", async () => {
    const ctx = context(bundle());
    await search(ctx, "Example Person Gamma");
    const other = await search(ctx, "Example Quest Alpha");
    expect(other.text).not.toContain("note:");
  });

  test("a changed result set is reported as changed", async () => {
    const db = bundle();
    const ctx = context(db);
    await search(ctx, "Example Person Gamma");
    // The world's reference does not change mid-episode; this is the branch
    // that would fire if it ever did, so it is exercised synthetically.
    const title = "Example Person Gamma Notes";
    const text = "More about Example Person Gamma.";
    db.run("INSERT INTO pages (id, title, ns, text, text_len) VALUES (?, ?, ?, ?, ?)", [
      99,
      title,
      0,
      text,
      text.length,
    ]);
    db.run("INSERT INTO pages_fts (rowid, title, text) VALUES (?, ?, ?)", [99, title, text]);
    const again = await search(ctx, "Example Person Gamma");
    expect(again.text).toContain("The results changed");
    expect(again.text).toContain("now:");
  });

  test("a repeated search that found nothing still gets a note", async () => {
    const ctx = context(bundle());
    await search(ctx, "zzzznothinghere");
    const again = await search(ctx, "zzzznothinghere");
    expect(again.text).toContain("note: you already ran this search");
    expect(again.text).toContain("(no results)");
  });

  test("the memo does not cross episodes", async () => {
    const db = bundle();
    await search(context(db), "Example Person Gamma");
    const nextEpisode = await search(context(db), "Example Person Gamma");
    expect(nextEpisode.text).not.toContain("note:");
  });
});

describe("an id the reference does not record", () => {
  test("says no page records it, rather than nothing at all", async () => {
    const res = await search(context(bundle()), "npc entry 9999");
    expect(res.text).toContain("no results");
    expect(res.text).toContain("no page in the reference records npc id 9999");
    expect(res.text).toContain("not evidence");
  });
});

describe("the wikiCoords run dimension", () => {
  test("names-first by default: no coords line, prose pairs redacted", async () => {
    const res = await search(context(bundle()), "Example Person Delta");
    expect(res.text).toContain("# Example Person Delta");
    expect(res.text).not.toContain("wiki coords");
    expect(res.text).not.toContain("48.2");
    expect(res.text).toContain("(coords withheld)");
  });

  test("wikiCoords:true serves the coords line and the prose as written", async () => {
    const res = await search({ ...context(bundle()), wikiCoords: true }, "Example Person Delta");
    expect(res.text).toContain("wiki coords (reference, not live): Beta Zone (48.2, 42.1)");
    expect(res.text).toContain("stands at (48.2, 42.1)");
  });

  test("the tool description states which side this run is on", () => {
    const desc = (tools: typeof TOOLS): string => tools.find((t) => t.name === "search_reference")!.description;
    expect(desc(TOOLS)).toContain(WIKI_COORDS_SENTENCE.withheld);
    expect(desc(toolsFor({ wikiCoords: false }))).toContain(WIKI_COORDS_SENTENCE.withheld);
    expect(desc(toolsFor({}))).toBe(desc(TOOLS));
    const served = desc(toolsFor({ wikiCoords: true }));
    expect(served).toContain(WIKI_COORDS_SENTENCE.served);
    expect(served).not.toContain(WIKI_COORDS_SENTENCE.withheld);
    // Only that one tool's text differs.
    expect(toolsFor({ wikiCoords: true }).filter((t) => t.name !== "search_reference")).toEqual(
      TOOLS.filter((t) => t.name !== "search_reference"),
    );
  });
});
