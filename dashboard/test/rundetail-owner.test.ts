/**
 * The owner-capture pattern `RunDetail.tsx` uses to start `poll()` from inside
 * an async continuation (the "The runs page" worklog's `resummarise` cleanup
 * became this).
 *
 * `onCleanup` and `createEffect` need a synchronous owner; Solid loses the
 * running owner across an `await`, which is why the page captures `getOwner()`
 * before the first fetch and reopens it with `runWithOwner` once the response
 * arrives (`poll()`'s own `onCleanup`, deep inside `lib/poll.ts`, rides along).
 * This is the first use of `getOwner`/`runWithOwner` in the dashboard, so it is
 * pinned directly rather than trusted from the page reading right: an effect
 * created this way must still track, and must still stop when the root disposes.
 */

import { describe, expect, test } from "bun:test";

/* The reactive build of solid-js stands behind this name for every dashboard
   test; `test/preload-solid.ts` installs it and says why. */
import { createEffect, createRoot, createSignal, getOwner, onCleanup, runWithOwner } from "solid-js";

describe("owner captured before an await, reopened after", () => {
  test("an effect created via runWithOwner still tracks its signal", async () => {
    const [count, setCount] = createSignal(0);
    const seen: number[] = [];
    let dispose!: () => void;

    await new Promise<void>((resolve) => {
      dispose = createRoot((d) => {
        const owner = getOwner();
        // The async gap `RunDetail.tsx` crosses between the fetch that resolves
        // `d` and the effect it starts off the response.
        void Promise.resolve().then(() => {
          runWithOwner(owner, () => {
            createEffect(() => {
              seen.push(count());
            });
          });
          resolve();
        });
        return d;
      });
    });

    expect(seen).toEqual([0]);
    setCount(1);
    expect(seen).toEqual([0, 1]);

    dispose();
  });

  test("onCleanup registered inside that effect fires when the root disposes", async () => {
    let cleaned = false;
    let dispose!: () => void;

    await new Promise<void>((resolve) => {
      dispose = createRoot((d) => {
        const owner = getOwner();
        void Promise.resolve().then(() => {
          runWithOwner(owner, () => {
            createEffect(() => {
              onCleanup(() => {
                cleaned = true;
              });
            });
          });
          resolve();
        });
        return d;
      });
    });

    expect(cleaned).toBe(false);
    dispose();
    expect(cleaned).toBe(true);
  });
});
