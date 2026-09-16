/**
 * The map's route wiring: `/map` and `/map?run=<id>`, and the swap between them.
 *
 * The derivations are covered in `mapview.test.ts`. What is covered here is the
 * layer above them — the search parameter reaching the effect that owns the
 * swap — because a live-run report of "the live control does nothing" pointed
 * straight at it and nothing in the suite could confirm or deny it. (It was a
 * stale bundle in an open tab, not the code; see worklogs/2026-08-24.)
 *
 * `useSearchParams` needs a DOM and a rendered `Router`, which `bun test` has
 * neither of. The stand-in below is the router's own shape: a memo over the
 * parsed query string, and one lazily-created memo per key on top of it — that
 * is `createMemoObject` in `@solidjs/router`, reproduced rather than imported
 * because it is not part of the package's public surface. The real one was
 * verified to notify on a key appearing, changing and vanishing before this was
 * written; what these tests pin is our half of the contract.
 */

import { describe, expect, test } from "bun:test";
import type { AgentPosition, TrackResponse } from "../../runner/viewer/api-types";

/* The reactive build of solid-js stands behind this name for every dashboard
   test; `test/preload-solid.ts` installs it and says why. */
import { createEffect, createMemo, createRoot, createSignal, getOwner, runWithOwner } from "solid-js";
import { clearReplayState, createLeftReplay, createMapState } from "../src/lib/mapstate";
import { runParam } from "../src/lib/replay";

const TRACK: TrackResponse = {
  runId: "run-1",
  characterName: "Benchy",
  model: "test/model",
  harnessVersion: "harness-0.2",
  points: [
    { ts: 100, map: 0, x: 1, y: 1, level: 1, xp: 0, money: null, questsCompleted: null, turn: 1 },
    { ts: 200, map: 530, x: 9, y: 9, level: 2, xp: 5, money: null, questsCompleted: null, turn: 2 },
  ],
};

function live(runId: string, map: number): AgentPosition {
  return {
    runId,
    character: runId,
    model: "test/model",
    map,
    x: 1,
    y: 1,
    ts: 1000,
    level: 5,
    xp: 100,
    money: null,
    questsCompleted: null,
    items: null,
    harnessVersion: "harness-0.2",
  };
}

/**
 * The page, minus its canvas: the route parameter, the sources, the derived
 * state, and the one effect that owns the swap — wired exactly as `MapPage`
 * wires them, including the order of the writes.
 */
function page(initialSearch: string) {
  return createRoot((dispose) => {
    const [search, setSearch] = createSignal(initialSearch);
    const query = createMemo<Record<string, string>>(() => {
      const out: Record<string, string> = {};
      for (const [k, v] of new URLSearchParams(search())) out[k] = v;
      return out;
    });
    /*
     * The per-key memo, and the detail that makes copying it worthwhile:
     * `runWithOwner` is not decoration. The first read of a parameter happens
     * inside the effect below, and a memo created there would be owned by that
     * effect and disposed the next time it re-runs — after which the cached
     * memo returns its last value forever and the page never learns the route
     * changed again. That is precisely the "the control does nothing" shape,
     * and the router avoids it by creating the memo under the router's owner.
     * Written the naive way first, this file caught itself.
     */
    const owner = getOwner();
    const keys = new Map<string, () => string | undefined>();
    const param = (name: string): string | undefined => {
      let memo = keys.get(name);
      if (memo === undefined) {
        runWithOwner(owner, () => {
          memo = createMemo(() => query()[name]);
          keys.set(name, memo);
        });
      }
      return keys.get(name)!();
    };
    const replayId = (): string | undefined => runParam(param("run"));

    const [track, setTrack] = createSignal<TrackResponse | undefined>(undefined);
    const [cursor, setCursor] = createSignal(0);
    const [playing, setPlaying] = createSignal(false);
    const [feedList, setFeedList] = createSignal<readonly AgentPosition[]>([]);
    const [pinned, setPinned] = createSignal<number | null>(null);
    const [selectedId, setSelectedId] = createSignal<string | null>(null);
    const [replayError, setReplayError] = createSignal<string | undefined>(undefined);
    const state = createMapState({ feed: feedList, track, pinned, selectedId });

    /* What the renderer owns, so the test can see it was reset too. */
    const canvas = { pips: new Set<string>(), fits: 0 };
    const calls = { tracks: [] as string[], refreshes: 0 };
    const leftReplay = createLeftReplay();

    createEffect(() => {
      const id = replayId();
      const returningToLive = leftReplay(id);
      clearReplayState({
        setTrack: (t) => {
          setTrack(() => t);
        },
        setCursor,
        setPlaying,
        setPinned,
        setSelectedId,
        setFeed: (list) => {
          setFeedList(() => list);
        },
        setError: setReplayError,
      });
      canvas.pips.clear();
      canvas.fits++;
      if (id === undefined) {
        if (returningToLive) calls.refreshes++;
        return;
      }
      calls.tracks.push(id);
    });

    /* The feed, live or replayed, is the one thing that reaches the renderer. */
    const arrive = (list: readonly AgentPosition[]): void => {
      for (const p of list) canvas.pips.add(p.runId);
      setFeedList(() => list);
    };

    return {
      state,
      calls,
      canvas,
      arrive,
      dispose,
      navigate: (s: string) => setSearch(s),
      sources: { track, cursor, playing, pinned, selectedId, replayError },
      setTrack: (t: TrackResponse) => setTrack(() => t),
      setCursor,
      setPlaying,
      setPinned,
      setSelectedId,
      setReplayError,
    };
  });
}

/** A page sitting mid-replay, the way the operator's was. */
function midReplay() {
  const p = page("?run=run-1");
  p.setTrack(TRACK);
  p.setCursor(200);
  p.setPlaying(true);
  p.setSelectedId("run-1");
  p.setPinned(530);
  p.arrive([{ ...live("run-1", 530), ts: 200 }]);
  return p;
}

describe("the map's two URL states", () => {
  test("a deep link to ?run= loads that replay and nothing else", () => {
    const p = page("?run=run-1");
    expect(p.calls.tracks).toEqual(["run-1"]);
    // A cold load must not double the live poll's own first request.
    expect(p.calls.refreshes).toBe(0);
    p.dispose();
  });

  test("a cold load of /map asks for no track and no extra poll", () => {
    const p = page("");
    expect(p.calls.tracks).toEqual([]);
    expect(p.calls.refreshes).toBe(0);
    p.dispose();
  });

  test("the live control clears the replay and asks for positions now", () => {
    const p = midReplay();
    expect(p.state.activeMap()).toBe(530);
    expect(p.canvas.pips.size).toBe(1);

    p.navigate("");

    /* The two symptoms the operator reported, asserted as absences: the replay
       UI is gated on the track, and the map's emptiness is gated on the feed. */
    expect(p.sources.track()).toBeUndefined();
    expect(p.sources.playing()).toBe(false);
    expect(p.sources.cursor()).toBe(0);
    expect(p.sources.pinned()).toBeNull();
    expect(p.sources.selectedId()).toBeNull();
    expect(p.canvas.pips.size).toBe(0);
    expect(p.state.activeMap()).toBeNull();
    // And it does not sit blank waiting for the next 5s tick.
    expect(p.calls.refreshes).toBe(1);
    expect(p.calls.tracks).toEqual(["run-1"]);

    p.arrive([live("a", 0), live("b", 0), live("c", 530)]);
    expect(p.state.activeMap()).toBe(0);
    expect(p.state.count()).toBe(3);
    p.dispose();
  });

  test("a failed replay's error does not follow the page back to live", () => {
    const p = page("?run=missing");
    p.setReplayError("Error: no such run");
    p.navigate("");
    expect(p.sources.replayError()).toBeUndefined();
    p.dispose();
  });

  test("one replay straight to another swaps rather than layers", () => {
    const p = midReplay();
    p.navigate("?run=run-2");
    expect(p.calls.tracks).toEqual(["run-1", "run-2"]);
    // No refresh: this never touched the live map.
    expect(p.calls.refreshes).toBe(0);
    // The first run is gone before the second's track can land.
    expect(p.canvas.pips.size).toBe(0);
    expect(p.sources.track()).toBeUndefined();
    expect(p.state.activeMap()).toBeNull();
    p.dispose();
  });

  test("back and forward are the same path as the controls", () => {
    const p = midReplay();
    p.navigate("");
    p.navigate("?run=run-1");
    expect(p.calls.tracks).toEqual(["run-1", "run-1"]);
    expect(p.sources.track()).toBeUndefined();
    p.navigate("");
    expect(p.calls.refreshes).toBe(2);
    p.dispose();
  });

  test("an empty ?run= is the live map, not a run with no name", () => {
    const p = page("?run=");
    expect(p.calls.tracks).toEqual([]);
    p.navigate("?run=run-1&other=1");
    expect(p.calls.tracks).toEqual(["run-1"]);
    // A change to a parameter the map does not own must not re-swap.
    p.navigate("?run=run-1&other=2");
    expect(p.calls.tracks).toEqual(["run-1"]);
    p.dispose();
  });
});

describe("createLeftReplay", () => {
  test("only the replay-to-live transition, once per transition", () => {
    const left = createLeftReplay();
    expect(left(undefined)).toBe(false); // cold load of /map
    expect(left(undefined)).toBe(false); // and it does not become true by repetition
    expect(left("a")).toBe(false); // into a replay
    expect(left("b")).toBe(false); // replay to replay
    expect(left(undefined)).toBe(true); // back to live
    expect(left(undefined)).toBe(false); // still live
  });

  test("a cold load straight into a replay never fires it", () => {
    const left = createLeftReplay();
    expect(left("a")).toBe(false);
    expect(left(undefined)).toBe(true);
  });
});
