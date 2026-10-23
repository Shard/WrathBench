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
import { DEFAULT_MAP, chooseMap, mapCounts } from "./mapview";
import { mapsVisited } from "./replay";

export interface MapSources {
  /** The feed on screen: the live poll's positions, or the replay cursor's. */
  feed: Accessor<readonly AgentPosition[]>;
  /** The loaded track, when the page is replaying one; in a party's replay, the member the map follows. */
  track: Accessor<TrackResponse | undefined>;
  /**
   * Every member's track, when the page is replaying a party (`/map?party=<id>`).
   * Absent or undefined is a single run's replay, or live.
   */
  group?: Accessor<readonly TrackResponse[] | undefined>;
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
  /** Never null: with nothing on any map the page still draws one (`chooseMap`). */
  activeMap: Accessor<number>;
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
  /*
   * A party's every visited map, each counted by the members on it at the
   * cursor, so a chip says where the others are. Visits are scanned once per
   * load like a run's; the counts follow the feed.
   */
  const visited = createMemo<number[]>(() => {
    const g = src.group?.();
    if (g === undefined) return [];
    return [...new Set(g.flatMap((t) => mapsVisited(t.points)))];
  });
  const maps = createMemo<[number, number][]>(() => {
    if (src.group?.() !== undefined) {
      const counts = new Map(mapCounts(src.feed()));
      const all = [...new Set([...visited(), ...counts.keys()])];
      return all.map((m) => [m, counts.get(m) ?? 0] as [number, number]);
    }
    const t = src.track();
    if (t !== undefined) return mapsVisited(t.points).map((m) => [m, 1] as [number, number]);
    return mapCounts(src.feed());
  });

  const count = createMemo(() => src.feed().length);

  /*
   * Replay follows the character rather than a click — there is one pip, and a
   * selection that could go stale against the cursor would read as a bug. A
   * party's replay follows the member picked, and the leader until one is.
   */
  const selected = createMemo<AgentPosition | null>(() => {
    const list = src.feed();
    if (src.group?.() !== undefined) {
      const id = src.selectedId() ?? src.track()?.runId ?? null;
      return list.find((p) => p.runId === id) ?? list[0] ?? null;
    }
    if (src.track() !== undefined) return list[0] ?? null;
    const id = src.selectedId();
    if (id === null) return null;
    return list.find((p) => p.runId === id) ?? null;
  });

  /** The map the followed character stands on: the one a replay shows. */
  const cursorMap = createMemo<number | null>(() => {
    if (src.track() === undefined) return null;
    if (src.group?.() !== undefined) return selected()?.map ?? null;
    return src.feed()[0]?.map ?? null;
  });

  const activeMap = createMemo<number>(
    (prev) => chooseMap(maps(), prev, src.pinned(), cursorMap()),
    DEFAULT_MAP,
  );

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
  /** A party's tracks and its members, where the page replays parties. */
  setGroup?: (tracks: undefined) => void;
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
  w.setGroup?.(undefined);
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

/**
 * The replay link the selected-agent panel offers, or nothing.
 *
 * Nothing in two cases: no selection to link, and — the one worth a function —
 * a selection that *is* the run already being replayed. In replay mode the
 * panel always shows the replayed agent, so the link would navigate to the URL
 * the page is already on: a control that visibly does nothing when clicked,
 * which is worse than an absent one.
 */
export function replayHrefFor(
  track: TrackResponse | undefined,
  selected: AgentPosition | null,
): string | null {
  if (selected === null) return null;
  if (track?.runId === selected.runId) return null;
  return replayHref(selected.runId);
}

/**
 * The route a replay of one run id lives at.
 *
 * One spelling, because two places link to it now: the selected pip's way in,
 * and the play bar's steps between a character's attempts. A swap is
 * the route effect's job either way — the link changes the URL and nothing
 * else, which is what keeps the cursor memory per attempt.
 */
export function replayHref(runId: string): string {
  return `/map?run=${encodeURIComponent(runId)}`;
}

/**
 * A route-change classifier: did *this* change leave a replay for the live map?
 *
 * The live poll answers with nothing while a replay owns the map, so its last
 * value is empty and its next tick can be a whole interval away — returning to
 * live has to ask for positions immediately or the map sits blank. But a cold
 * load of `/map` must not, because the poll has just fetched of its own accord
 * and a second request would double the first load of every visit.
 *
 * The distinction is a transition rather than a state, so it needs one bit of
 * memory. Kept here, as a closure with the flag written from the id on every
 * call, so it cannot drift out of step with the route no matter how often or
 * why the effect re-runs — and so the transition table is testable.
 */
export function createLeftReplay(): (id: string | undefined) => boolean {
  let wasReplaying = false;
  return (id) => {
    const left = wasReplaying && id === undefined;
    wasReplaying = id !== undefined;
    return left;
  };
}
