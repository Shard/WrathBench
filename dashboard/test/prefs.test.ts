/**
 * `readBoolPref`/`writeBoolPref`: the one remembered-boolean shape shared by
 * `Collapsible` (per-pane open state) and the run page (the follow-scroll
 * toggle). Blocked storage must fall back rather than throw — bun's test
 * environment has no `localStorage` at all, which exercises that path for
 * free.
 */

import { describe, expect, test } from "bun:test";
import { readBoolPref, writeBoolPref } from "../src/lib/prefs";

describe("readBoolPref", () => {
  test("falls back when storage is unavailable, without throwing", () => {
    expect(globalThis.localStorage).toBeUndefined();
    expect(readBoolPref("wrathbench.test.missing", true)).toBe(true);
    expect(readBoolPref("wrathbench.test.missing", false)).toBe(false);
    expect(() => writeBoolPref("wrathbench.test.missing", true)).not.toThrow();
  });

  test("round-trips through a working store, and an absent key falls back", () => {
    const store = new Map<string, string>();
    // @ts-expect-error test double, not the real Storage interface
    globalThis.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    try {
      expect(readBoolPref("wrathbench.test.k", true)).toBe(true);
      writeBoolPref("wrathbench.test.k", false);
      expect(readBoolPref("wrathbench.test.k", true)).toBe(false);
      writeBoolPref("wrathbench.test.k", true);
      expect(readBoolPref("wrathbench.test.k", false)).toBe(true);
    } finally {
      // @ts-expect-error restoring the ambient absence other tests rely on
      delete globalThis.localStorage;
    }
  });
});
