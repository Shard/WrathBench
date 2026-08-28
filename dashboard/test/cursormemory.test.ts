/**
 * The per-run replay cursor remembered for the life of the page (item 61).
 *
 * Two things are worth pinning. The validation, because a remembered cursor is
 * consulted against whatever track *actually* loaded and a wrong answer there
 * is an out-of-range scrubber rather than a visible error. And the fact that
 * the route swap cannot erase it: `clearReplayState` sets the cursor to 0 on
 * every change of `/map?run=`, including the one that fires on the way out of
 * a replay, so anything that recorded the cursor by watching it would record
 * that 0 and hand back the beginning — the bug this exists to fix. The second
 * test drives the real reactive graph the page drives.
 */

import { describe, expect, test } from "bun:test";
import type { AgentPosition, TrackPoint, TrackResponse } from "../../runner/viewer/api-types";

/* The reactive build of solid-js stands behind this name for every dashboard
   test; `test/preload-solid.ts` installs it and says why. */
import { createEffect, createRoot, createSignal } from "solid-js";
import { createCursorMemory } from "../src/lib/cursormemory";
import { clearReplayState } from "../src/lib/mapstate";

function point(ts: number): TrackPoint {
  return { ts, map: 0, x: 1, y: 1, level: 1, xp: 0, money: null, questsCompleted: null, turn: ts };
}

function track(runId: string, times: number[]): TrackResponse {
  return {
    runId,
    character: "Benchy",
    model: "test/model",
    harnessVersion: "harness-0.4",
    points: times.map(point),
  };
}

const RUN_A = track("run-a", [1000, 2000, 3000]);

describe("cursor memory", () => {
  test("a run never scrubbed opens at its first recorded sample", () => {
    expect(createCursorMemory().resume(RUN_A)).toBe(1000);
  });

  test("a scrubbed run reopens where it was left", () => {
    const mem = createCursorMemory();
    mem.remember("run-a", 2500);
    expect(mem.resume(RUN_A)).toBe(2500);
  });

  test("the end of the track is inside the span, not past it", () => {
    const mem = createCursorMemory();
    mem.remember("run-a", 3000);
    expect(mem.resume(RUN_A)).toBe(3000);
  });

  test("a cursor beyond the loaded track falls back to the first sample", () => {
    // The track that loads is the authority: a run whose recording is shorter
    // than what was remembered would otherwise park the scrubber out of range.
    const mem = createCursorMemory();
    mem.remember("run-a", 9999);
    expect(mem.resume(RUN_A)).toBe(1000);
    mem.remember("run-a", 1);
    expect(mem.resume(RUN_A)).toBe(1000);
  });

  test("one run's cursor never lands in another's replay", () => {
    const mem = createCursorMemory();
    mem.remember("run-a", 2500);
    expect(mem.resume(track("run-b", [1000, 2000, 3000]))).toBe(1000);
  });

  test("runs are remembered independently", () => {
    const mem = createCursorMemory();
    mem.remember("run-a", 2500);
    mem.remember("run-b", 1500);
    expect(mem.resume(RUN_A)).toBe(2500);
    expect(mem.resume(track("run-b", [1000, 2000]))).toBe(1500);
  });

  test("a run that recorded no position has no cursor to resume", () => {
    const mem = createCursorMemory();
    mem.remember("run-a", 2500);
    expect(mem.resume(track("run-a", []))).toBe(0);
  });

  /*
   * The page's route effect, as `maproute.test.ts` builds it: handles come back
   * out of `createRoot` so the assertions run after the graph has settled.
   */
  function page(mem: ReturnType<typeof createCursorMemory>, id: string | undefined) {
    return createRoot((dispose) => {
      const [replayId, setReplayId] = createSignal<string | undefined>(id);
      const [track_, setTrack] = createSignal<TrackResponse | undefined>(undefined);
      const [cursor, setCursor] = createSignal(0);
      const [, setPlaying] = createSignal(false);
      const [, setFeed] = createSignal<readonly AgentPosition[]>([]);
      const [, setPinned] = createSignal<number | null>(null);
      const [, setSelectedId] = createSignal<string | null>(null);
      const [, setError] = createSignal<string | undefined>(undefined);

      createEffect(() => {
        const on = replayId();
        clearReplayState({
          setTrack: (t) => {
            setTrack(() => t);
          },
          setCursor,
          setPlaying,
          setPinned,
          setSelectedId,
          setFeed: (list) => {
            setFeed(() => list);
          },
          setError,
        });
        if (on === undefined) return;
        const t = track(on, [1000, 2000, 3000]);
        setTrack(() => t);
        setCursor(mem.resume(t));
      });

      return {
        dispose,
        cursor,
        track: track_,
        navigate: (next: string | undefined) => {
          setReplayId(next);
        },
        /* What the slider and the play tick do, and the only writers. */
        scrubTo: (ts: number) => {
          setCursor(ts);
          mem.remember("run-a", ts);
        },
      };
    });
  }

  test("a replay opens at its first sample and the scrub survives leaving it", () => {
    const mem = createCursorMemory();
    const p = page(mem, "run-a");
    expect(p.cursor()).toBe(1000);

    /* An operator scrubs, then clicks into the run page and presses back. */
    p.scrubTo(2500);
    p.navigate(undefined);
    // The route swap clears the cursor on the way out — this is the write that
    // an effect watching the cursor would have recorded as "left at zero".
    expect(p.cursor()).toBe(0);
    expect(p.track()).toBeUndefined();

    p.navigate("run-a");
    expect(p.cursor()).toBe(2500);
    p.dispose();
  });

  test("a fresh page does not resume another page's cursor", () => {
    /* The memory dies with the document: a new one is a new session. */
    const first = createCursorMemory();
    const a = page(first, "run-a");
    a.scrubTo(2500);
    a.dispose();
    const b = page(createCursorMemory(), "run-a");
    expect(b.cursor()).toBe(1000);
    b.dispose();
  });
});
