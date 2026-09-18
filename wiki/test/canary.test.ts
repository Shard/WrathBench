/**
 * The build's canary: the list itself, and the gate over a synthetic bundle.
 *
 * The bundle here is built by hand from the canary list, so no wiki text is
 * needed and none appears. Titles are place names, which the docs and
 * the docs already name.
 */

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { assertCanaries, missingCanaries, MUST_EXIST, resolveCanary } from "../src/canary";
import { createSchema, makeWriter } from "../src/bundle";
import { MUST_NOT_EXIST } from "../src/verify";

/** A bundle holding one page per given title, plus any redirects. */
function bundleOf(titles: readonly string[], redirects: readonly [string, string][] = []): Database {
  const db = new Database(":memory:");
  createSchema(db);
  const writer = makeWriter(db);
  for (const title of titles) {
    writer.addPage(title, 0, `${title} is a place in the example world.`, [], [], null);
  }
  for (const [source, target] of redirects) writer.addRedirect(source, target, 0);
  writer.flush();
  return db;
}

describe("the canary list", () => {
  test("has no duplicates", () => {
    expect(new Set(MUST_EXIST).size).toBe(MUST_EXIST.length);
  });

  test("is not empty, and does not overlap the forbidden titles", () => {
    expect(MUST_EXIST.length).toBeGreaterThan(30);
    const forbidden = new Set(MUST_NOT_EXIST);
    expect(MUST_EXIST.filter((t) => forbidden.has(t))).toEqual([]);
  });

  test("holds no title that is only whitespace or an underscore form", () => {
    for (const title of MUST_EXIST) {
      expect(title.trim()).toBe(title);
      expect(title).not.toContain("_");
    }
  });
});

describe("assertCanaries", () => {
  test("passes on a bundle that holds every title", () => {
    const db = bundleOf(MUST_EXIST);
    expect(missingCanaries(db)).toEqual([]);
    expect(() => assertCanaries(db)).not.toThrow();
    db.close();
  });

  test("a title that is only a redirect still resolves", () => {
    const rest = MUST_EXIST.filter((t) => t !== "The Exodar");
    const db = bundleOf([...rest, "Exodar"], [["The Exodar", "Exodar"]]);
    expect(resolveCanary(db, "The Exodar")).toBe("Exodar");
    expect(() => assertCanaries(db)).not.toThrow();
    db.close();
  });

  test("a redirect whose target is not in the bundle does not resolve", () => {
    const db = bundleOf([], [["The Exodar", "Exodar"]]);
    expect(resolveCanary(db, "The Exodar")).toBe(null);
    db.close();
  });

  test("fails, naming the missing pages", () => {
    const db = bundleOf(MUST_EXIST.filter((t) => t !== "Stormwind City" && t !== "Durotar"));
    expect(missingCanaries(db)).toEqual(["Stormwind City", "Durotar"]);
    expect(() => assertCanaries(db)).toThrow(/Stormwind City, Durotar/);
    expect(() => assertCanaries(db)).toThrow(/2 of \d+ required pages/);
    db.close();
  });

  test("a page in another namespace is not the page", () => {
    const db = bundleOf(MUST_EXIST);
    db.run("UPDATE pages SET ns = 14 WHERE title = 'Dalaran'");
    expect(missingCanaries(db)).toEqual(["Dalaran"]);
    db.close();
  });
});
