/**
 * The run feed's presentation layer (`lib/feedview.ts`): the expand preset,
 * the compact state line and the harness-notice split.
 *
 * What is worth pinning here is the tolerance, not the happy path. A state
 * sample's every field is optional and older runs are missing several; the
 * harness block is appended by `runner/src/tools.ts` to a result whose console
 * output the model wrote, so the split has to survive text that looks like the
 * marker; and a `notice` record does not exist in the trajectory yet, so its
 * reader is pinned against the contract this build promises to tolerate rather
 * than against a fixture from a writer.
 */

import { describe, expect, test } from "bun:test";
import type { FeedEntry } from "../../runner/viewer/api-types";
import {
  EXPAND_DEFAULT,
  EXPAND_PRESETS,
  expandedBy,
  harnessFields,
  HARNESS_RULE,
  isHarnessEntry,
  noticeView,
  readExpandPref,
  splitNotices,
  stateLine,
  writeExpandPref,
  type BlockKind,
} from "../src/lib/feedview";

function e(t: string, extra: Record<string, unknown> = {}): FeedEntry {
  return { i: 1, t, ts: 1_700_000_000_000, start: 0, end: 0, ...extra } as FeedEntry;
}

describe("expandedBy", () => {
  const kinds: BlockKind[] = ["response", "call", "detail"];

  test("the presets nest: each opens everything the one before it did", () => {
    for (let i = 1; i < EXPAND_PRESETS.length; i++) {
      const narrow = EXPAND_PRESETS[i - 1]!;
      const wide = EXPAND_PRESETS[i]!;
      for (const k of kinds) {
        if (expandedBy(narrow, k)) expect(expandedBy(wide, k)).toBe(true);
      }
    }
  });

  test("the ends are what they say", () => {
    for (const k of kinds) {
      expect(expandedBy("minimal", k)).toBe(false);
      expect(expandedBy("all", k)).toBe(true);
    }
    expect(expandedBy("responses", "response")).toBe(true);
    expect(expandedBy("responses", "call")).toBe(false);
    expect(expandedBy("snippets", "call")).toBe(true);
    expect(expandedBy("snippets", "detail")).toBe(false);
  });
});

describe("the remembered preset", () => {
  test("falls back with no storage at all, without throwing", () => {
    expect(globalThis.localStorage).toBeUndefined();
    expect(readExpandPref()).toBe(EXPAND_DEFAULT);
    expect(() => writeExpandPref("all")).not.toThrow();
  });

  test("round-trips, and a value this build cannot honour resolves to the default", () => {
    const store = new Map<string, string>();
    // @ts-expect-error test double, not the real Storage interface
    globalThis.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    try {
      writeExpandPref("snippets");
      expect(readExpandPref()).toBe("snippets");
      // A preset from a build that had one this does not.
      store.set("wrathbench.runview.expand", "everything-including-requests");
      expect(readExpandPref()).toBe(EXPAND_DEFAULT);
    } finally {
      // @ts-expect-error restoring the ambient absence other tests rely on
      delete globalThis.localStorage;
    }
  });
});

describe("stateLine", () => {
  test("a full sample reads as one line, ids labelled as ids", () => {
    const line = stateLine(
      e("state", {
        level: 7,
        xp: 3210,
        zone: 12,
        area: 87,
        money: 12_345,
        questsCompleted: 4,
        map: 0,
        x: -8949.95,
        y: -132.49,
        z: 83.53,
      }),
    );
    expect(line).toContain("level 7");
    expect(line).toContain("3210 xp");
    // Not a bare "12 · 87": nothing client-side maps a zone id to a name, so
    // the line must not read like one.
    expect(line).toContain("zone 12 · area 87");
    expect(line).toContain("4 quests");
    expect(line).toContain("map 0 (-8950, -132, 84)");
  });

  test("missing columns are dropped, never printed as zero", () => {
    const line = stateLine(e("state", { level: 1, x: 1, y: 2, z: 3 }));
    expect(line).toBe("level 1 · (1, 2, 3)");
    expect(line).not.toContain("xp");
    expect(line).not.toContain("zone");
  });

  test("a sample with nothing in it says so rather than rendering empty", () => {
    expect(stateLine(e("state"))).toBe("no fields recorded");
  });

  test("a partial position is not half-rendered", () => {
    expect(stateLine(e("state", { level: 3, x: 1, y: 2 }))).toBe("level 3");
  });
});

describe("splitNotices", () => {
  const result = [
    "ok (812ms)",
    "=> undefined",
    "--- console ---",
    "[log] moving",
    HARNESS_RULE,
    "moveTo too_far ×21: a single moveTo covers ~250y — walk to an intermediate point first",
    "moveTo target_off_mesh ×3: the point is off the navmesh",
  ].join("\n");

  test("lifts the harness block out and leaves the rest untouched", () => {
    const { body, notices } = splitNotices(result);
    expect(body).toBe("ok (812ms)\n=> undefined\n--- console ---\n[log] moving");
    expect(notices).toHaveLength(2);
    expect(notices[0]).toContain("moveTo too_far ×21");
    // Verbatim: the count and the wording are what the model was handed.
    expect(notices[0]).toBe(
      "moveTo too_far ×21: a single moveTo covers ~250y — walk to an intermediate point first",
    );
  });

  test("a result with no harness block is returned whole", () => {
    const plain = "ok (4ms)\n=> 42";
    expect(splitNotices(plain)).toEqual({ body: plain, notices: [] });
  });

  test("a snippet that prints the marker itself cannot swallow the real block", () => {
    const printed = `ok (1ms)\n--- console ---\n[log] ${HARNESS_RULE}\n${HARNESS_RULE}\nmoveTo drop ×2: hint`;
    const { notices } = splitNotices(printed);
    expect(notices).toEqual(["moveTo drop ×2: hint"]);
  });

  test("a marker with nothing under it is not a notice", () => {
    const trailing = `ok (1ms)\n${HARNESS_RULE}\n`;
    expect(splitNotices(trailing).notices).toEqual([]);
    expect(splitNotices(trailing).body).toBe(trailing);
  });

  test("a body that is only the harness block leaves no empty result pane", () => {
    const { body, notices } = splitNotices(`${HARNESS_RULE}\nmoveTo drop ×2: hint`);
    expect(body).toBe("");
    expect(notices).toEqual(["moveTo drop ×2: hint"]);
  });
});

describe("noticeView", () => {
  test("a notice addressed to the model reads as one", () => {
    // What `runner/src/run.ts` appends for a sandbox restart: the
    // `HarnessNotice` verbatim under `t: "harness"`.
    expect(
      noticeView(e("harness", { kind: "sandbox_restarted", text: "sandbox restarted: exited (signal SIGKILL)" })),
    ).toEqual({
      kind: "sandbox_restarted",
      text: "sandbox restarted: exited (signal SIGKILL)",
      count: null,
      bookkeeping: false,
    });
  });

  test("a textless record is bookkeeping, not a notice", () => {
    // Both observed on a live run: the same entry type, nothing said in either.
    expect(noticeView(e("harness", { kind: "hygiene", cleared: 1 })).bookkeeping).toBe(true);
    expect(
      noticeView(e("harness", { kind: "resolved_model", model: "x/y:free", cliVersion: null })).bookkeeping,
    ).toBe(true);
  });

  test("a bare record renders rather than throwing", () => {
    expect(noticeView(e("harness"))).toEqual({ kind: "harness", text: "", count: null, bookkeeping: true });
  });

  test("wrong-typed fields are ignored, not coerced", () => {
    expect(noticeView(e("notice", { kind: 7, text: { a: 1 }, count: "many" }))).toEqual({
      kind: "notice",
      text: "",
      count: null,
      bookkeeping: true,
    });
  });

  test("a count of one is no count: the row would read ×1 for a single event", () => {
    expect(noticeView(e("harness", { count: 1 })).count).toBeNull();
  });
});

describe("isHarnessEntry", () => {
  test("claims the type the runner writes, and the one api-types reserves", () => {
    expect(isHarnessEntry(e("harness"))).toBe(true);
    expect(isHarnessEntry(e("notice"))).toBe(true);
  });

  test("claims nothing else — a state sample and a milestone have their own rows", () => {
    for (const t of ["state", "milestone", "meta", "character", "response"]) {
      expect(isHarnessEntry(e(t))).toBe(false);
    }
  });
});

describe("harnessFields", () => {
  test("the bookkeeping a head line has room for, minus what the head already says", () => {
    expect(harnessFields(e("harness", { kind: "hygiene", cleared: 1 }))).toBe("cleared: 1");
    expect(
      harnessFields(e("harness", { kind: "resolved_model", model: "x/y:free", cliVersion: null })),
    ).toBe("model: x/y:free");
  });

  test("a record with nothing else in it renders empty rather than as braces", () => {
    expect(harnessFields(e("harness", { kind: "sandbox_started" }))).toBe("");
  });
});
