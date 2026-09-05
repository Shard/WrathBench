/**
 * The map's control strip across the route swap, against a DOM.
 *
 * Until 2026-09-05 leaving a replay for the live map changed the URL and then
 * froze the page: the hint text read `track()!.points.length` as a reactive
 * expression of its own, it re-ran after the track was cleared, and the throw
 * inside Solid's graph stopped every computation queued after it. The map sat
 * on the dead replay until a reload, and nothing in the suite could see it —
 * the pure route tests (`maproute.test.ts`) cover the state, not the render.
 *
 * So this renders the strip and performs the swap in the order the page does:
 * the route parameter changes first, then the replay state is cleared write by
 * write. Each write is a place an assertion-narrowed read would throw, and the
 * strip's contract is that none of them does — going live, going into a
 * replay before its track lands, the track landing, and a selection appearing
 * and vanishing under the live pill.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createComponent, createEffect, createMemo, createRoot, createSignal } from "solid-js";
import { clearReplayState } from "../src/lib/mapstate";
import { runParam } from "../src/lib/replay";
import { Window } from "happy-dom";
import { render } from "solid-js/web";
import { createServer } from "vite";
import solid from "vite-plugin-solid";
import { fileURLToPath } from "node:url";
import type { AgentPosition, TrackResponse } from "../../runner/viewer/api-types";
import type { PlayBarProps } from "../src/components/PlayBar";

const dashboardRoot = fileURLToPath(new URL("..", import.meta.url));

type Entry = typeof import("./fixtures/playbar-entry");

/**
 * The component and the router, from one module graph (`fixtures/playbar-entry.ts`
 * says why), loaded only once a DOM is installed: the router reads `window`
 * the moment it is imported.
 */
async function loadEntry(): Promise<Entry> {
  const server = await createServer({
    root: dashboardRoot,
    configFile: false,
    // The app's own resolve config is not loaded with `configFile: false`, so
    // the `@viewer/*` alias is restated: `lib/mapview.ts` imports the world→tile
    // transform from `runner/viewer` at runtime.
    resolve: { alias: { "@viewer": fileURLToPath(new URL("../../runner/viewer", import.meta.url)) } },
    plugins: [solid({ dev: false, ssr: false })],
    optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true },
  });
  try {
    return (await server.ssrLoadModule("/test/fixtures/playbar-entry.ts")) as Entry;
  } finally {
    await server.close();
  }
}

const DOM_GLOBALS = [
  "window",
  "document",
  "Node",
  "Text",
  "Element",
  "HTMLElement",
  "SVGElement",
  "SVGSVGElement",
  "HTMLTemplateElement",
  "Document",
  "Event",
  "CustomEvent",
  "navigator",
] as const;
const priorGlobals = new Map<string, { present: boolean; value: unknown }>();

function installDom(): { document: Document; restore: () => void } {
  const window = new Window();
  const values: Record<(typeof DOM_GLOBALS)[number], unknown> = {
    window,
    document: window.document as unknown as Document,
    Node: window.Node,
    Text: window.Text,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    SVGElement: window.SVGElement,
    SVGSVGElement: window.SVGSVGElement,
    HTMLTemplateElement: window.HTMLTemplateElement,
    Document: window.Document,
    Event: window.Event,
    CustomEvent: window.CustomEvent,
    navigator: window.navigator,
  };
  for (const name of DOM_GLOBALS) {
    priorGlobals.set(name, { present: name in globalThis, value: (globalThis as Record<string, unknown>)[name] });
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: values[name] });
  }
  return {
    document: window.document as unknown as Document,
    restore: () => {
      for (const name of DOM_GLOBALS) {
        const prior = priorGlobals.get(name)!;
        if (prior.present) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: prior.value });
        else delete (globalThis as Record<string, unknown>)[name];
      }
      priorGlobals.clear();
    },
  };
}

afterEach(() => {
  if (priorGlobals.size > 0) {
    for (const [name, prior] of priorGlobals) {
      if (prior.present) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: prior.value });
      else delete (globalThis as Record<string, unknown>)[name];
    }
    priorGlobals.clear();
  }
});

const TRACK: TrackResponse = {
  runId: "fleet-a-sonnet-20260905",
  character: "Benchy",
  model: "anthropic/claude-sonnet-5",
  harnessVersion: "harness-0.5",
  points: [
    { ts: 1_000, map: 0, x: 1, y: 1, level: 1, xp: 0, money: null, questsCompleted: null, turn: 1 },
    { ts: 61_000, map: 0, x: 2, y: 2, level: 2, xp: 5, money: null, questsCompleted: null, turn: 2 },
  ],
};

const LIVE: AgentPosition = {
  runId: "fleet-b-qwen-20260905",
  character: "Grumbold",
  model: "qwen/qwen-3.8-27b",
  map: 0,
  x: 1,
  y: 1,
  ts: 1_000,
  level: 5,
  xp: 100,
  money: null,
  questsCompleted: null,
  items: null,
  harnessVersion: "harness-0.5",
};

describe("the play bar across the route swap", () => {
  test("live → replay → live, in the page's write order, without a throw", async () => {
    const { document, restore } = installDom();
    try {
      const { PlayBar, MemoryRouter, Route, createMemoryHistory } = await loadEntry();
      /*
       * The page's writable state, and the page's route effect over it. The
       * route is a search string as the router would hold it; the effect reads
       * the run id off it and clears every replay writable through the same
       * `clearReplayState` the page calls, so the writes land in the page's
       * order and — this is the point — inside an effect, where Solid batches
       * them and flushes the graph once. A top-level write flushes on its own
       * and can miss an ordering the batched flush produces.
       */
      const [route, setRoute] = createSignal("");
      const [track, setTrack] = createSignal<TrackResponse | undefined>(undefined);
      const [replayError, setReplayError] = createSignal<string | undefined>(undefined);
      const [cursor, setCursor] = createSignal(0);
      const [playing, setPlaying] = createSignal(false);
      const [selected, setSelected] = createSignal<AgentPosition | null>(null);
      const [count, setCount] = createSignal(0);
      const calls = { seek: [] as number[], toggle: 0, tracks: [] as string[] };
      const replayId = (): string | undefined => runParam(new URLSearchParams(route()).get("run") ?? undefined);

      const disposeEffect = createRoot((dispose) => {
        const id = createMemo(replayId);
        createEffect(() => {
          const run = id();
          clearReplayState({
            setTrack: (t) => setTrack(() => t),
            setCursor,
            setPlaying,
            setPinned: () => {},
            setSelectedId: () => setSelected(null),
            setFeed: (list) => setCount(list.length),
            setError: setReplayError,
          });
          if (run !== undefined) calls.tracks.push(run);
        });
        return dispose;
      });

      const props: PlayBarProps = {
        get replayId() {
          return replayId();
        },
        get track() {
          return track();
        },
        get replayError() {
          return replayError();
        },
        feedError: undefined,
        get cursor() {
          return cursor();
        },
        get playing() {
          return playing();
        },
        speed: 1,
        get count() {
          return count();
        },
        seriesHidden: 0,
        liveSeries: null,
        get selected() {
          return selected();
        },
        onSeek: (ts) => calls.seek.push(ts),
        onTogglePlay: () => calls.toggle++,
        onStepBack: () => {},
        onStepForward: () => {},
        onCycleSpeed: () => {},
      };

      const mount = document.createElement("div");
      const history = createMemoryHistory();
      const dispose = render(
        () =>
          createComponent(MemoryRouter, {
            history,
            get children() {
              return createComponent(Route, { path: "*", component: () => createComponent(PlayBar, props) });
            },
          }),
        mount,
      );
      const text = (): string => mount.textContent?.replace(/\s+/g, " ").trim() ?? "";
      const has = (sel: string): boolean => mount.querySelector(sel) !== null;

      // Live: the feed arrives, nothing selected.
      setCount(2);
      expect(has(".live-pill")).toBe(true);
      expect(has(".transport")).toBe(false);
      expect(text()).toContain("2 characters");

      // A pip selected offers the way into its replay; deselecting withdraws it.
      setSelected(LIVE);
      expect(text()).toContain("replay Grumbold →");
      expect(mount.querySelector(".playbar-btn")?.getAttribute("href")).toBe("/map?run=fleet-b-qwen-20260905");
      expect(() => setSelected(null)).not.toThrow();
      expect(text()).not.toContain("replay Grumbold");

      // Into a replay: the route changes, the effect clears, the track has not landed.
      expect(() => setRoute(`?run=${TRACK.runId}`)).not.toThrow();
      expect(calls.tracks).toEqual([TRACK.runId]);
      expect(text()).toContain("loading replay of 20260905");
      expect(has(".live-link")).toBe(true);
      expect(has(".transport")).toBe(false);

      // The track lands and the cursor is placed, as the fetch's `.then` does it.
      setTrack(TRACK);
      setCursor(1_000);
      expect(has(".transport")).toBe(true);
      expect(text()).toContain("Benchy");
      expect(text()).toContain("2 positions");
      expect([...mount.querySelectorAll(".tclock")].map((el) => el.textContent)).toEqual(["0:00", "1:00"]);
      expect(mount.querySelector("button.play")?.hasAttribute("disabled")).toBe(false);
      // Stepping back from the first sample has nowhere to go.
      expect(mount.querySelector('button[aria-label="previous sample"]')?.hasAttribute("disabled")).toBe(true);
      expect(mount.querySelector('button[aria-label="next sample"]')?.hasAttribute("disabled")).toBe(false);

      setCursor(61_000);
      setPlaying(true);
      expect([...mount.querySelectorAll(".tclock")].map((el) => el.textContent)).toEqual(["1:00", "1:00"]);
      expect(mount.querySelector('button[aria-label="pause"]')).not.toBeNull();
      expect(mount.querySelector('button[aria-label="next sample"]')?.hasAttribute("disabled")).toBe(true);

      // Back to live: the route changes and the effect unwinds the replay. This
      // is the swap that froze the page, and the assertion is that the strip
      // survives it and says live.
      expect(() => setRoute("")).not.toThrow();
      expect(has(".live-pill")).toBe(true);
      expect(has(".transport")).toBe(false);
      expect(has(".live-link")).toBe(false);
      expect(track()).toBeUndefined();
      expect(text()).toContain("0 characters");

      // And straight back in, then one replay to another: the same path.
      expect(() => setRoute(`?run=${TRACK.runId}`)).not.toThrow();
      setTrack(TRACK);
      setCursor(1_000);
      expect(has(".transport")).toBe(true);
      expect(() => setRoute("?run=fleet-b-qwen-20260905")).not.toThrow();
      expect(text()).toContain("loading replay of 20260905");
      expect(has(".transport")).toBe(false);

      // A replay that fails to load says so, and going live clears that too.
      setReplayError("no such run");
      expect(text()).toContain("no such run");
      expect(() => setRoute("")).not.toThrow();
      expect(has(".live-pill")).toBe(true);
      expect(text()).not.toContain("no such run");

      disposeEffect();
      dispose();
    } finally {
      restore();
    }
  });

  test("a one-reading track shows the transport disabled rather than a dead slider", async () => {
    const { document, restore } = installDom();
    try {
      const { PlayBar, MemoryRouter, Route, createMemoryHistory } = await loadEntry();
      const props: PlayBarProps = {
        replayId: TRACK.runId,
        track: { ...TRACK, points: [TRACK.points[0]!] },
        replayError: undefined,
        feedError: undefined,
        cursor: 1_000,
        playing: false,
        speed: 1,
        count: 0,
        seriesHidden: 0,
        liveSeries: null,
        selected: null,
        onSeek: () => {},
        onTogglePlay: () => {},
        onStepBack: () => {},
        onStepForward: () => {},
        onCycleSpeed: () => {},
      };
      const mount = document.createElement("div");
      const dispose = render(
        () =>
          createComponent(MemoryRouter, {
            history: createMemoryHistory(),
            get children() {
              return createComponent(Route, { path: "*", component: () => createComponent(PlayBar, props) });
            },
          }),
        mount,
      );
      expect(mount.textContent).toContain("1 position");
      expect(mount.textContent).toContain("one reading");
      expect(mount.querySelector("input.scrubber")).toBeNull();
      expect(mount.querySelector("button.play")?.hasAttribute("disabled")).toBe(true);
      dispose();
    } finally {
      restore();
    }
  });
});
