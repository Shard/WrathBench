/**
 * Everything the map page derives from its feed, as one directed graph.
 *
 * This module exists because the map used to fold its feed and compute its
 * derived state in the same place: one function read `activeMap` and `selected`
 * and wrote both back, so every tick re-entered the effect that called it and
 * Firefox reported `too much recursion` under the play slider. A replayed feed
 * made it unconditional, because a scrubbed position is a fresh object every
 * time and a signal holding it therefore always "changed".
 *
 * The rule that keeps it fixed is structural rather than remembered: the
 * sources below are the only writable state, everything else is a `createMemo`
 * over them, and no memo here writes anything at all. Sticky choices that used
 * to need a write-back — which map to show — are expressed with the reducer
 * form of `createMemo`, where the previous answer arrives as an argument.
 *
 * None of this touches the canvas. The renderer owns its own mutable pip state
 * and its `requestAnimationFrame`; this is the half Solid owns.
 */

import type { AgentPosition, TrackResponse } from "@viewer/api-types";
import { type Accessor, createMemo } from "solid-js";
import { chooseMap, mapCounts } from "./mapview";
import { mapsVisited } from "./replay";

export interface MapSources {
  /** The feed on screen: the live poll's positions, or the replay cursor's. */
  feed: Accessor<readonly AgentPosition[]>;
  /** The loaded track, when the page is replaying one. */
  track: Accessor<TrackResponse | undefined>;
  /** The map an operator clicked a chip for, or null for "whatever fits". */
  pinned: Accessor<number | null>;
  /** The run whose pip was clicked. An id, not a reading: identity is stable. */
  selectedId: Accessor<string | null>;
}

export interface MapState {
  /** The chips: every map with something on it, and how many. */
  maps: Accessor<[number, number][]>;
  count: Accessor<number>;
  /** In replay, the map the cursor's sample stands on. Null when live. */
  cursorMap: Accessor<number | null>;
  activeMap: Accessor<number | null>;
  /** The reading behind the sidebar, or null when nothing is selected. */
  selected: Accessor<AgentPosition | null>;
}

export function createMapState(src: MapSources): MapState {
  /*
   * Replay names every map the track visits, not just the one under the cursor:
   * the chips are how an operator jumps back to a continent the run has left.
   * Keyed on the track alone, so the O(n²) visit scan runs once per load and
   * never on a cursor tick.
   */
  const maps = createMemo<[number, number][]>(() => {
    const t = src.track();
    if (t !== undefined) return mapsVisited(t.points).map((m) => [m, 1] as [number, number]);
    return mapCounts(src.feed());
  });

  const count = createMemo(() => src.feed().length);

  const cursorMap = createMemo<number | null>(() => {
    if (src.track() === undefined) return null;
    return src.feed()[0]?.map ?? null;
  });

  const activeMap = createMemo<number | null>(
    (prev) => chooseMap(maps(), prev ?? null, src.pinned(), cursorMap()),
    null,
  );

  /*
   * Replay follows the character rather than a click — there is one pip, and a
   * selection that could go stale against the cursor would read as a bug.
   */
  const selected = createMemo<AgentPosition | null>(() => {
    const list = src.feed();
    if (src.track() !== undefined) return list[0] ?? null;
    const id = src.selectedId();
    if (id === null) return null;
    return list.find((p) => p.runId === id) ?? null;
  });

  return { maps, count, cursorMap, activeMap, selected };
}

/**
 * The writable half of the page, as the one thing that can clear it.
 *
 * `/map` and `/map?run=<id>` are two states, not two layers: moving between
 * them — the live control, browser back, a deep link, or one run's replay
 * straight to another's — has to leave nothing of the state it came from. The
 * setters arrive as arguments so this stays a pure writer with no signals of
 * its own, which is also what keeps it testable against the real graph.
 */
export interface MapWritables {
  setTrack: (track: TrackResponse | undefined) => void;
  setCursor: (ts: number) => void;
  setPlaying: (on: boolean) => void;
  setPinned: (map: number | null) => void;
  setSelectedId: (id: string | null) => void;
  setFeed: (list: readonly AgentPosition[]) => void;
  setError: (message: string | undefined) => void;
}

/** Everything a replay leaves behind, unwound in one place. */
export function clearReplayState(w: MapWritables): void {
  w.setTrack(undefined);
  w.setCursor(0);
  w.setPlaying(false);
  w.setPinned(null);
  w.setSelectedId(null);
  /*
   * Load-bearing, and it does not look it: the next feed overwrites this
   * anyway. But `activeMap` is a reducer memo whose stickiness lives *inside*
   * the memo, not in any source here, so the only way to forget the continent
   * the replay ended on is to let it recompute over an empty map list once and
   * reject its own previous answer. Drop this and returning to live can sit on
   * the replay's map because one straggler happens to be standing there.
   */
  w.setFeed([]);
  /*
   * A failed `?run=<bad id>` otherwise keeps its error banner over a perfectly
   * healthy live map — the hint bar checks the error before anything else.
   */
  w.setError(undefined);
}
