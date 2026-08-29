/**
 * The freeplay lineage walk: chains, attempt numbers, and the run either side.
 *
 * The cases here are the ones production makes — a predecessor outside the set,
 * a fork, a malformed cycle — because those are exactly the ones a page must
 * not hang or lie about. The ladder's own `streamRows` tests
 * (`ladder.test.ts`) cover the row it builds on top of this.
 */

import { describe, expect, test } from "bun:test";
import { chainsOf, hasLineage, lineageIndex, type LineageRun } from "../src/lib/lineage";

function r(runId: string, continuedFrom: string | null = null, startedAt: number | null = null): LineageRun {
  return { runId, continuedFrom, startedAt };
}

describe("chainsOf", () => {
  test("a fresh run is its own chain", () => {
    expect(chainsOf([r("a1")]).get("a1")).toEqual(["a1"]);
  });

  test("a chain is oldest first and ends in the run itself", () => {
    const chains = chainsOf([r("a1"), r("a2", "a1"), r("a3", "a2")]);
    expect(chains.get("a3")).toEqual(["a1", "a2", "a3"]);
    expect(chains.get("a2")).toEqual(["a1", "a2"]);
  });

  test("a predecessor the set does not hold makes a root, never a dropped run", () => {
    expect(chainsOf([r("b7", "b6-archived")]).get("b7")).toEqual(["b7"]);
  });

  test("a malformed cycle ends the walk instead of hanging", () => {
    const chains = chainsOf([r("c1", "c2"), r("c2", "c1")]);
    expect(chains.get("c1")).toEqual(["c2", "c1"]);
    expect(chains.get("c2")).toEqual(["c1", "c2"]);
  });

  test("a run naming itself is a root", () => {
    expect(chainsOf([r("d1", "d1")]).get("d1")).toEqual(["d1"]);
  });
});

describe("lineageIndex", () => {
  test("attempt is the run's place and attempts is the whole stream's length", () => {
    const idx = lineageIndex([r("a1"), r("a2", "a1"), r("a3", "a2")]);
    expect(idx.get("a1")).toMatchObject({ streamId: "a1", attempt: 1, attempts: 3, previous: null, next: "a2" });
    expect(idx.get("a2")).toMatchObject({ streamId: "a1", attempt: 2, attempts: 3, previous: "a1", next: "a3" });
    expect(idx.get("a3")).toMatchObject({ streamId: "a1", attempt: 3, attempts: 3, previous: "a2", next: null });
  });

  test("a lone run has no lineage to print", () => {
    const idx = lineageIndex([r("a1"), r("z9")]);
    expect(idx.get("z9")).toMatchObject({ streamId: "z9", attempt: 1, attempts: 1, previous: null, next: null });
    expect(hasLineage(idx.get("z9"))).toBe(false);
    expect(hasLineage(undefined)).toBe(false);
  });

  test("a predecessor outside the set is not claimed as a link", () => {
    // The link cannot be resolved, so the row reads as a root rather than
    // pointing at a run the page cannot show.
    const idx = lineageIndex([r("b7", "b6-archived")]);
    expect(idx.get("b7")).toMatchObject({ streamId: "b7", attempt: 1, attempts: 1, previous: null, next: null });
  });

  test("a fork's `next` is the later start — the same tie-break the ladder's row takes", () => {
    const idx = lineageIndex([r("a1", null, 10), r("a2", "a1", 20), r("a2b", "a1", 30)]);
    expect(idx.get("a1")?.next).toBe("a2b");
    // Both keep the parent, so neither attempt is lost.
    expect(idx.get("a2")?.previous).toBe("a1");
    expect(idx.get("a2b")?.previous).toBe("a1");
    // The stream is as long as its longest chain, whichever fork a run is on.
    expect(idx.get("a2")?.attempts).toBe(2);
  });

  test("a fork with no start times is settled by id, so two polls agree", () => {
    const idx = lineageIndex([r("a1"), r("a2", "a1"), r("a3", "a1")]);
    expect(idx.get("a1")?.next).toBe("a3");
  });

  test("a mid-chain attempt knows the stream is longer than its own chain", () => {
    const idx = lineageIndex([r("a1"), r("a2", "a1"), r("a3", "a2"), r("a4", "a3")]);
    expect(idx.get("a2")).toMatchObject({ attempt: 2, attempts: 4 });
    expect(hasLineage(idx.get("a2"))).toBe(true);
  });

  test("a cycle produces no entry that hangs, and every run keeps a place", () => {
    const idx = lineageIndex([r("c1", "c2"), r("c2", "c1")]);
    expect(idx.size).toBe(2);
    expect(idx.get("c1")?.attempt).toBe(2);
    expect(idx.get("c2")?.attempt).toBe(2);
  });

  test("the order the server served rows in does not change the answer", () => {
    const runs = [r("a3", "a2", 30), r("a1", null, 10), r("a2", "a1", 20)];
    const idx = lineageIndex(runs);
    const rev = lineageIndex([...runs].reverse());
    for (const id of ["a1", "a2", "a3"]) expect(idx.get(id)).toEqual(rev.get(id)!);
  });
});
