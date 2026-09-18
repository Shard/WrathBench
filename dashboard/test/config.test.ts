/**
 * The config page's pure half (item 134).
 *
 * What is worth pinning is not the rendering — it is the two decisions that
 * are invisible on screen and wrong in a way nothing would report: that a
 * CLEARED field becomes a PUT with the key omitted rather than a PATCH with a
 * null (absence is a value in this config, and PATCH is a shallow merge that
 * cannot express it), and that the JSON editors are driven off the store's own
 * row keys rather than the top-level names, because a PUT to a bare collection
 * name is accepted, stored, and then ignored by the renderer.
 */

import { describe, expect, test } from "bun:test";
import {
  RoutingParseError,
  auditVerb,
  formOf,
  isRosterName,
  jsonEditorKeys,
  newEntryDoc,
  parseRouting,
  formatRouting,
  rosterWrite,
  EMPTY_NEW_ENTRY,
} from "../src/lib/config";

describe("parseRouting", () => {
  test("a bare name is a name", () => {
    expect(parseRouting("gmicloud")).toBe("gmicloud");
    expect(parseRouting("  gmicloud  ")).toBe("gmicloud");
  });

  test("a comma-separated list is preference order", () => {
    expect(parseRouting("gmicloud, deepinfra")).toEqual(["gmicloud", "deepinfra"]);
  });

  test("JSON is JSON — the object form and the list form both", () => {
    expect(parseRouting('["a","b"]')).toEqual(["a", "b"]);
    expect(parseRouting('{"order":["a"],"allowFallbacks":false}')).toEqual({ order: ["a"], allowFallbacks: false });
  });

  test("empty is absent, which is a VALUE — the author's own provider", () => {
    expect(parseRouting("")).toBeUndefined();
    expect(parseRouting("   ")).toBeUndefined();
  });

  test("text that looks like JSON and is not says so", () => {
    expect(() => parseRouting("{oops")).toThrow(RoutingParseError);
  });

  test("format and parse round-trip every shape", () => {
    for (const v of ["gmicloud", ["a", "b"], { order: ["a"] }]) {
      expect(parseRouting(formatRouting(v))).toEqual(v);
    }
    expect(formatRouting(undefined)).toBe("");
  });
});

describe("rosterWrite", () => {
  const entry = { model: "m", tier: "t0", race: 3, class: 2, routing: "gmicloud", idle: "none" };

  test("nothing changed is no write at all", () => {
    expect(rosterWrite(entry, formOf(entry))).toBeNull();
  });

  test("a pure set is a PATCH of only the changed keys", () => {
    const w = rosterWrite(entry, { ...formOf(entry), tier: "t1" });
    expect(w).toEqual({ method: "PATCH", body: { tier: "t1" }, changed: ["tier"] });
  });

  test("a CLEARED key is a PUT with the key omitted — PATCH cannot remove one", () => {
    const w = rosterWrite(entry, { ...formOf(entry), routing: "" });
    expect(w?.method).toBe("PUT");
    expect(w?.body).toEqual({ model: "m", tier: "t0", race: 3, class: 2, idle: "none" });
    expect("routing" in (w?.body ?? {})).toBe(false);
    // The one thing that must never happen: a null standing in for absence.
    expect(JSON.stringify(w?.body)).not.toContain("null");
  });

  test("a clear and a set in one write travel together, in the PUT", () => {
    const w = rosterWrite(entry, { ...formOf(entry), routing: "", tier: "t2" });
    expect(w?.method).toBe("PUT");
    expect(w?.body).toEqual({ model: "m", tier: "t2", race: 3, class: 2, idle: "none" });
    expect(w?.changed.sort()).toEqual(["routing", "tier"]);
  });

  test("clearing a key that is already absent is not a change", () => {
    const bare = { model: "m", tier: "t0" };
    expect(rosterWrite(bare, { ...formOf(bare), billing: "" })).toBeNull();
  });

  test("an emptied tier is a slip, not a request — tier is required on every entry", () => {
    expect(rosterWrite(entry, { ...formOf(entry), tier: "" })).toBeNull();
  });

  test("a routing shape change is a PATCH of the new document", () => {
    const w = rosterWrite(entry, { ...formOf(entry), routing: "a, b" });
    expect(w).toEqual({ method: "PATCH", body: { routing: ["a", "b"] }, changed: ["routing"] });
  });
});

describe("newEntryDoc", () => {
  test("only the keys the operator filled in — an empty optional is left OUT, not sent empty", () => {
    const doc = newEntryDoc({ ...EMPTY_NEW_ENTRY, name: "x", model: "m", tier: "t1" });
    expect(doc).toEqual({ model: "m", tier: "t1" });
  });

  test("race and class are the numbers the config carries", () => {
    const doc = newEntryDoc({ ...EMPTY_NEW_ENTRY, name: "x", model: "m", tier: "t0", race: "3", class: "2" });
    expect(doc).toEqual({ model: "m", tier: "t0", race: 3, class: 2 });
  });

  test("the optional strings ride along when given", () => {
    const doc = newEntryDoc({
      ...EMPTY_NEW_ENTRY,
      name: "x",
      model: "m",
      tier: "t0",
      billing: "paid",
      idle: "unlimited",
      routing: "gmicloud",
      apiBase: "https://api.example/v1",
      apiKeyEnv: "EXAMPLE_KEY",
    });
    expect(doc).toEqual({
      model: "m",
      tier: "t0",
      routing: "gmicloud",
      billing: "paid",
      idle: "unlimited",
      apiBase: "https://api.example/v1",
      apiKeyEnv: "EXAMPLE_KEY",
    });
  });
});

describe("isRosterName", () => {
  test("the row-key alphabet, since the name IS the key", () => {
    expect(isRosterName("sub-opus-low")).toBe(true);
    expect(isRosterName("qwen3.8:27b")).toBe(true);
    expect(isRosterName("")).toBe(false);
    expect(isRosterName("has/slash")).toBe(false);
    expect(isRosterName("has space")).toBe(false);
  });
});

describe("jsonEditorKeys", () => {
  test("collection ENTRIES, never the bare collection name", () => {
    const keys = ["_notes", "preflight", "accounts", "roster/a", "roster/b", "policy", "campaigns/x", "queue/0"];
    expect(jsonEditorKeys(keys)).toEqual(["_notes", "preflight", "accounts", "policy", "campaigns/x", "queue/0"]);
  });

  test("an empty collection is a singleton row and keeps its editor", () => {
    expect(jsonEditorKeys(["policy", "queue"])).toEqual(["policy", "queue"]);
  });

  test("the roster's own rows are excluded — the table is their editor", () => {
    expect(jsonEditorKeys(["roster", "roster/a"])).toEqual([]);
  });
});

describe("auditVerb", () => {
  test("null on either side is a create or a delete", () => {
    expect(auditVerb({ before: null, after: {} })).toBe("created");
    expect(auditVerb({ before: {}, after: null })).toBe("deleted");
    expect(auditVerb({ before: {}, after: {} })).toBe("changed");
  });
});
