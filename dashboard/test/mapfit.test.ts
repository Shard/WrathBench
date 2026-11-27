/**
 * The map's camera fit (`@wrathbench/inspector/views/mapfit`) on the dashboard's real graph: the sources,
 * `createMapState`, the fit, and the effect that turns the replay's cursor into
 * its feed, created in the page's order, with the track arriving after the
 * effects first ran, as it does over the network.
 *
 * The regression is the public replay of a character who had crossed to
 * Kalimdor, sought to its last sample: a blank map. The camera stayed on the
 * Eastern Kingdoms framing over Kalimdor's tiles because the crossing asked
 * for a fit after the fit effect had already run for the same feed change
 * (`cursorMap` subscribes to the feed only once a track exists, so it sits
 * behind the fit among the feed's observers). Nothing woke the fit again
 * until the public tail changed, minutes later. That only happens on the real
 * graph, which is why this test drives one rather than a pure function.
 *
 * The fit's own contract (an ask waiting for someone, asked now, a pick
 * dropping a waiting ask, several sessions framed) is the inspector's suite
 * (`wrath-mcp/inspector/test/views/mapfit.test.ts`), on a graph of its own;
 * this file keeps what the dashboard adds: `createMapState` and a run's
 * replayed positions.
 */

import { describe, expect, test } from "bun:test";
import type { AgentPosition, TrackPoint, TrackResponse } from "../../viewer/api-types";

/* The reactive build of solid-js stands behind this name for every dashboard
   test; `test/preload-solid.ts` installs it and says why. */
import { createEffect, createRoot, createSignal } from "solid-js";
import { createMapFit } from "@wrathbench/inspector/views/mapfit";
import { createMapState } from "../src/lib/mapstate";
import { positionsAt } from "../src/lib/replay";

const point = (ts: number, map: number, x: number, y: number): TrackPoint => ({
  ts,
  map,
  x,
  y,
  level: 44,
  xp: 0,
  money: null,
  questsCompleted: null,
  turn: null,
});

/** Two samples in Westfall, then the run's last one in Dustwallow Marsh. */
const TRACK: TrackResponse = {
  runId: "run-1",
  characterName: "Thalvorn",
  model: "test/model",
  harnessVersion: "harness-0.5",
  points: [point(100, 0, -10977.9, -1244.1), point(200, 0, -10050, 1000), point(300, 1, -4025.4, -3787.6)],
};

/** The page minus its canvas: every fit the camera made, in order, by the positions it framed. */
function replayPage() {
  return createRoot((dispose) => {
    const [track, setTrack] = createSignal<TrackResponse | undefined>(undefined);
    const [cursor, setCursor] = createSignal(0);
    const [feed, setFeed] = createSignal<readonly AgentPosition[]>([]);
    const [pinned, setPinned] = createSignal<number | null>(null);
    const state = createMapState({ feed, track, pinned, selectedId: () => null });
    const fits: { map: number; x: number }[][] = [];
    const camera = createMapFit({
      activeMap: state.activeMap,
      feed,
      cursorMap: state.cursorMap,
      fit: (here) => fits.push(here.map((p) => ({ map: p.map, x: p.x }))),
      onCross: () => setPinned(null),
    });
    // The page's feed effect: in a replay, the track's reading at the cursor.
    createEffect(() => {
      const t = track();
      setFeed(t === undefined ? [] : positionsAt(t, cursor()));
    });
    return {
      state,
      camera,
      fits,
      dispose,
      /** The track load as the page makes it: track, then cursor, then a fit asked for. */
      load: (t: TrackResponse): void => {
        setTrack(() => t);
        setCursor(t.points[0]!.ts);
        camera.ask();
      },
      seek: (ts: number): void => {
        setCursor(ts);
      },
    };
  });
}

describe("the map's camera fit", () => {
  test("a replay sought across a continent frames the character there at once", () => {
    const p = replayPage();
    p.load(TRACK);
    // The load's ask is made by the next feed change, on the first continent.
    p.seek(200);
    expect(p.fits.at(-1)).toEqual([{ map: 0, x: -10050 }]);
    expect(p.camera.pending()).toBe(false);

    // The end: nothing else changes after this seek (the public tail is fixed
    // until the next publish), so the fit has to be made here or not at all.
    p.seek(300);
    expect(p.state.activeMap()).toBe(1);
    expect(p.fits.at(-1)).toEqual([{ map: 1, x: -4025.4 }]);
    expect(p.camera.pending()).toBe(false);
    p.dispose();
  });
});
