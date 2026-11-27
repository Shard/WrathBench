/**
 * The run feed's presentation layer (`lib/feedview.ts`): the compact state line
 * and the harness-notice split.
 *
 * What is worth pinning here is the tolerance, not the happy path. A state
 * sample's every field is optional and older runs are missing several, so a
 * missing one is dropped, never printed as zero; and the harness block is
 * appended by `wrath-mcp/mcp/src/tools.ts` to a result whose console output the
 * model wrote, so the split has to survive text that looks like the marker.
 */

import { describe, expect, test } from "bun:test";
import type { FeedEntry } from "../../viewer/api-types";
import { HARNESS_RULE, splitNotices, stateLine } from "../src/lib/feedview";

function e(t: string, extra: Record<string, unknown> = {}): FeedEntry {
  return { i: 1, t, ts: 1_700_000_000_000, start: 0, end: 0, ...extra } as FeedEntry;
}

describe("stateLine", () => {
  test("missing columns are dropped, never printed as zero", () => {
    const line = stateLine(e("state", { level: 1, x: 1, y: 2, z: 3 }));
    expect(line).toBe("level 1 · (1, 2, 3)");
    expect(line).not.toContain("xp");
    expect(line).not.toContain("zone");
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

  test("a snippet that prints the marker itself cannot swallow the real block", () => {
    const printed = `ok (1ms)\n--- console ---\n[log] ${HARNESS_RULE}\n${HARNESS_RULE}\nmoveTo drop ×2: hint`;
    const { notices } = splitNotices(printed);
    expect(notices).toEqual(["moveTo drop ×2: hint"]);
  });
});
