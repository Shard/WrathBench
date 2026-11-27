/**
 * The admin page's config editors' pure half.
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
  EMPTY_NEW_ENTRY,
  formOf,
  formatRouting,
  isReadOnlyKey,
  jsonEditorKeys,
  newEntryDoc,
  parseRouting,
  promoteBody,
  promoteFormOf,
  rosterWrite,
} from "../src/lib/config";

describe("parseRouting", () => {
  test("empty is absent, which is a VALUE — the author's own provider", () => {
    expect(parseRouting("")).toBeUndefined();
    expect(parseRouting("   ")).toBeUndefined();
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

  test("an emptied tier is a slip, not a request — tier is required on every entry", () => {
    expect(rosterWrite(entry, { ...formOf(entry), tier: "" })).toBeNull();
  });
});

describe("newEntryDoc", () => {
  test("only the keys the operator filled in — an empty optional is left OUT, not sent empty", () => {
    const doc = newEntryDoc({ ...EMPTY_NEW_ENTRY, name: "x", model: "m", tier: "t1" });
    expect(doc).toEqual({ model: "m", tier: "t1" });
  });
});

describe("jsonEditorKeys", () => {
  test("collection ENTRIES, never the bare collection name", () => {
    const keys = ["_notes", "preflight", "accounts", "roster/a", "roster/b", "policy", "campaigns/x", "queue/0"];
    expect(jsonEditorKeys(keys)).toEqual(["_notes", "preflight", "accounts", "policy", "campaigns/x", "queue/0"]);
  });

  test("published campaign definitions are listed, and read-only: the API refuses a write to them", () => {
    const keys = ["campaign-defs/wake-probe@1", "campaigns/wake-probe", "policy"];
    expect(jsonEditorKeys(keys)).toEqual(keys);
    expect(keys.map(isReadOnlyKey)).toEqual([true, false, false]);
    expect(isReadOnlyKey("campaign-defs")).toBe(true);
    expect(isReadOnlyKey("campaigns")).toBe(false);
    expect(isReadOnlyKey("campaign-definitions")).toBe(false);
  });
});

describe("drafts", () => {
  test("a promotion never picks a tier: the form starts without one and will not send without one", () => {
    const form = promoteFormOf("glm-6");
    expect(form).toEqual({ name: "glm-6", tier: "", race: "", class: "" });
    expect(() => promoteBody("z-ai/glm-6", form)).toThrow(/choose a tier/);
    expect(promoteBody("z-ai/glm-6", { ...form, tier: "t0" })).toEqual({ model: "z-ai/glm-6", name: "glm-6", tier: "t0" });
  });
});
