/**
 * An edit as a compact diff (`lib/textdiff.ts`): the shared ends trimmed to
 * context, removed lines then added ones, and the changed words marked where
 * both sides are small.
 */

import { describe, expect, test } from "bun:test";
import { lineDiff, wordRanges } from "../src/lib/textdiff";

const ops = (d: ReturnType<typeof lineDiff>): string[] => d.lines.map((l) => `${l.op}${l.text}`);

describe("lineDiff", () => {
  test("shared lines at either end are trimmed to two of context", () => {
    const before = ["a", "b", "c", "d", "old", "e", "f", "g", "h"].join("\n");
    const after = ["a", "b", "c", "d", "new 1", "new 2", "e", "f", "g", "h"].join("\n");
    const d = lineDiff(before, after);
    expect(ops(d)).toEqual([" c", " d", "-old", "+new 1", "+new 2", " e", " f"]);
    expect([d.hiddenBefore, d.hiddenAfter, d.removed, d.added]).toEqual([2, 2, 1, 2]);
  });

  test("removed lines come before added ones, however they interleave", () => {
    expect(ops(lineDiff("x\ny\nz", "X\ny\nZ"))).toEqual(["-x", "-y", "-z", "+X", "+y", "+Z"]);
  });

  test("a pure insertion and a pure deletion", () => {
    expect(ops(lineDiff("", "export async function grind(){\n}"))).toEqual(["+export async function grind(){", "+}"]);
    expect(ops(lineDiff("keep\ndrop", "keep"))).toEqual([" keep", "-drop"]);
    expect(lineDiff("same", "same").lines).toEqual([" same"].map((t) => ({ op: " ", text: t.slice(1) })));
  });

  test("the words that changed are marked on both sides", () => {
    const d = lineDiff("await sdk.moveTo({x:-5500,y:-470,z:400});", "await sdk.moveTo({x:-5500,y:-280,z:353.986});");
    const [rm, add] = d.lines;
    expect(rm!.words!.map(([a, b]) => rm!.text.slice(a, b))).toEqual(["470", "400"]);
    expect(add!.words!.map(([a, b]) => add!.text.slice(a, b))).toEqual(["280", "353.986"]);
  });

  test("a line that changed almost whole is marked by its colour alone", () => {
    const d = lineDiff("const a = 1;", "while (x) { y(); }");
    expect(d.lines.every((l) => (l.words ?? []).length === 0)).toBe(true);
  });

  test("past a dozen lines a side, no words are compared", () => {
    const many = (p: string) => Array.from({ length: 20 }, (_, k) => `${p}${k}`).join("\n");
    expect(lineDiff(many("a"), many("b")).lines.every((l) => l.words === undefined)).toBe(true);
  });
});

describe("wordRanges", () => {
  test("ranges are character offsets into each side", () => {
    expect(wordRanges("a b c", "a x c")).toEqual({ before: [[2, 3]], after: [[2, 3]] });
  });
  test("too big a comparison is declined", () => {
    expect(wordRanges("w ".repeat(400), "v ".repeat(400))).toBeNull();
  });
});
