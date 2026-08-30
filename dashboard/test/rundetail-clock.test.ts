/**
 * The context the run feed's clock cell reads.
 *
 * `RunDetail.tsx` provides the run's start once, around the feed, and every row
 * component reads it with `useContext` — including the rows a `<For>` creates,
 * which is the part worth pinning. Solid resolves a context through the OWNER
 * tree, not the DOM tree, and `For` builds each row under the owner that was
 * running when it did; if that ever stopped holding, every stamp would quietly
 * fall back to the wall clock rather than fail, which is the kind of regression
 * a build and a typecheck both pass.
 *
 * The same reason `rundetail-owner.test.ts` exists: a Solid pattern new to this
 * page is pinned directly rather than trusted from the page reading right.
 * Written with `createComponent` rather than JSX so it runs under `bun test`
 * with no transform.
 */

import { describe, expect, test } from "bun:test";
import { For, createComponent, createContext, createRoot, useContext } from "solid-js";
import { fmtElapsed } from "../src/lib/format";

const RunStart = createContext<() => number | null>(() => null);

/** What `When` does: elapsed off the context, or the fallback when there is none. */
function cell(ts: number): string {
  const start = useContext(RunStart)();
  return start === null ? "wall" : fmtElapsed(ts - start);
}

describe("the run feed's clock context", () => {
  test("rows a For creates read the start the feed provided", () => {
    const START = 1_700_000_000_000;
    const out = createRoot((dispose) => {
      const seen = createComponent(RunStart.Provider, {
        value: () => START,
        get children() {
          return createComponent(For, {
            each: [START, START + 9_000, START + 3_922_000],
            children: (ts: number) => cell(ts),
          });
        },
      }) as unknown as () => unknown;
      const rows = seen() as string[];
      dispose();
      return rows;
    });
    expect(out).toEqual(["0:00", "0:09", "1:05:22"]);
  });

  test("with no provider the cell falls back rather than counting from the epoch", () => {
    const out = createRoot((dispose) => {
      const v = cell(1_700_000_000_000);
      dispose();
      return v;
    });
    expect(out).toBe("wall");
  });
});
