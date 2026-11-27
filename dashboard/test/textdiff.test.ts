/**
 * An edit as a compact diff (`lib/textdiff.ts`): the shared ends trimmed to
 * context, removed lines then added ones, and the changed words marked where
 * both sides are small.
 */

import { describe, expect, test } from "bun:test";
import { lineDiff } from "../src/lib/textdiff";

const ops = (d: ReturnType<typeof lineDiff>): string[] => d.lines.map((l) => `${l.op}${l.text}`);

describe("lineDiff", () => {
  test("shared lines at either end are trimmed to two of context, removed lines before added ones", () => {
    const before = ["a", "b", "c", "d", "old", "e", "f", "g", "h"].join("\n");
    const after = ["a", "b", "c", "d", "new 1", "new 2", "e", "f", "g", "h"].join("\n");
    const d = lineDiff(before, after);
    expect(ops(d)).toEqual([" c", " d", "-old", "+new 1", "+new 2", " e", " f"]);
    expect([d.hiddenBefore, d.hiddenAfter, d.removed, d.added]).toEqual([2, 2, 1, 2]);
    expect(ops(lineDiff("x\ny\nz", "X\ny\nZ"))).toEqual(["-x", "-y", "-z", "+X", "+y", "+Z"]);
    expect(ops(lineDiff("keep\ndrop", "keep"))).toEqual([" keep", "-drop"]);
  });

  test("the words that changed are marked on both sides", () => {
    const d = lineDiff("await sdk.moveTo({x:-5500,y:-470,z:400});", "await sdk.moveTo({x:-5500,y:-280,z:353.986});");
    const [rm, add] = d.lines;
    expect(rm!.words!.map(([a, b]) => rm!.text.slice(a, b))).toEqual(["470", "400"]);
    expect(add!.words!.map(([a, b]) => add!.text.slice(a, b))).toEqual(["280", "353.986"]);
  });
});
