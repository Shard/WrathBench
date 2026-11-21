/**
 * The ladder page's freeplay tab, rendered against a DOM.
 *
 * The derivation is pinned in `ladder.test.ts`; this is the check that the page
 * hands the tab the shell's series like every other tab (operator,
 * 2026-11-15): "latest" with a preview series offered is the established
 * series' characters, the preview its own, a named series that one, and "all"
 * every character.
 */

import { afterEach, describe, expect, jest, test } from "bun:test";
import { createComponent, createSignal } from "solid-js";
import { Window } from "happy-dom";
import { render } from "solid-js/web";
import { createServer } from "vite";
import solid from "vite-plugin-solid";
import { fileURLToPath } from "node:url";
import type { ResultRun } from "../../runner/viewer/api-types";

const dashboardRoot = fileURLToPath(new URL("..", import.meta.url));

type Entry = typeof import("./fixtures/ladder-entry");

async function loadEntry(): Promise<Entry> {
  const server = await createServer({
    root: dashboardRoot,
    configFile: false,
    resolve: {
      alias: {
        "@viewer": fileURLToPath(new URL("../../runner/viewer", import.meta.url)),
        "@runner": fileURLToPath(new URL("../../runner/src", import.meta.url)),
      },
    },
    plugins: [solid({ dev: false, ssr: false })],
    optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true },
  });
  try {
    return (await server.ssrLoadModule("/test/fixtures/ladder-entry.ts")) as Entry;
  } finally {
    await server.close();
  }
}

/** A freeplay attempt on a series. */
function fp(runId: string, series: string, character: string, over: Partial<ResultRun> = {}): ResultRun {
  return {
    runId,
    model: "vendor/model",
    platform: "openrouter",
    harnessVersion: `harness-${series}-1-gabc`,
    harnessSeries: series,
    extra: false,
    campaign: null,
    cell: null,
    effort: null,
    race: 1,
    raceName: "Human",
    class: 2,
    className: "Paladin",
    characterLabel: "Human Paladin",
    modelResponses: 3,
    harness: "wrathbench",
    promptHash: null,
    serverBuild: null,
    wikiCoords: false,
    toolCalls: null,
    snippets: null,
    episode: "freeplay",
    episodeSource: "stamped",
    episodeOverride: false,
    unscored: "unscored (episode freeplay)",
    startedAt: 1_790_000_000_000,
    endedAt: 1_790_000_600_000,
    live: false,
    terminationReason: "episode-elapsed",
    levels: [],
    maxLevel: 5,
    xp: null,
    money: null,
    questsCompleted: 0,
    maps: [0],
    character,
    playtimeMs: 60_000,
    tokens: null,
    actualCost: null,
    pauseReason: null,
    continuedFrom: null,
    stillborn: null,
    billing: "paid",
    ...over,
  } as ResultRun;
}

const RUNS: ResultRun[] = [
  fp("old-1", "0.5", "Oldhand"),
  fp("old-2", "0.5", "Oldhand", { continuedFrom: "old-1", startedAt: 1_790_000_700_000, maxLevel: 9 }),
  fp("new-1", "1.0", "Newcomer", { startedAt: 1_790_001_000_000, maxLevel: 3 }),
];

const DOM_GLOBALS = [
  "window",
  "document",
  "Node",
  "Text",
  "Element",
  "HTMLElement",
  "SVGElement",
  "HTMLTemplateElement",
  "Document",
  "Event",
  "CustomEvent",
  "MouseEvent",
  "navigator",
  "fetch",
] as const;
const priorGlobals = new Map<string, { present: boolean; value: unknown }>();

function restoreGlobals(): void {
  for (const [name, prior] of priorGlobals) {
    if (prior.present) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: prior.value });
    else delete (globalThis as Record<string, unknown>)[name];
  }
  priorGlobals.clear();
}

/** A DOM, and a `fetch` that answers the ladder with every series' runs, as the viewer and the snapshot do. */
function installDom(): Document {
  const window = new Window({ url: "http://localhost/" });
  const json = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  const fetch = async (url: string | URL | Request): Promise<Response> => {
    const path = String(url);
    if (path.startsWith("/api/ladder")) return json({ runs: RUNS });
    if (path.startsWith("/api/dungeons")) return json({ boards: [] });
    return new Response(JSON.stringify({ error: `no fixture for ${path}` }), { status: 404 });
  };
  const values: Record<(typeof DOM_GLOBALS)[number], unknown> = {
    window,
    document: window.document,
    Node: window.Node,
    Text: window.Text,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    SVGElement: window.SVGElement,
    HTMLTemplateElement: window.HTMLTemplateElement,
    Document: window.Document,
    Event: window.Event,
    CustomEvent: window.CustomEvent,
    MouseEvent: window.MouseEvent,
    navigator: window.navigator,
    fetch,
  };
  for (const name of DOM_GLOBALS) {
    priorGlobals.set(name, { present: name in globalThis, value: (globalThis as Record<string, unknown>)[name] });
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: values[name] });
  }
  return window.document as unknown as Document;
}

afterEach(() => {
  jest.useRealTimers();
  restoreGlobals();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    jest.advanceTimersByTime(0);
    await Promise.resolve();
  }
}

describe("the ladder's freeplay tab", () => {
  test("applies the shell's series like every tab", async () => {
    const document = installDom();
    const { Ladder, FeedsContext, MemoryRouter, Route, createMemoryHistory } = await loadEntry();
    jest.useFakeTimers();
    const [series, setSeries] = createSignal("latest");
    const feeds = {
      fleet: { latest: undefined, error: undefined, stalled: false, refresh: () => {} },
      info: { latest: undefined, error: undefined, stalled: false, refresh: () => {} },
      stale: () => false,
      seriesChoice: series,
      setSeriesChoice: setSeries,
      seriesAvailable: () => ["0.5", "1.0"],
      seriesPreview: () => "1.0",
    };
    const mount = document.createElement("div");
    document.body.appendChild(mount);
    const history = createMemoryHistory();
    history.set({ value: "/ladder?episode=freeplay" });
    const dispose = render(
      () =>
        createComponent(FeedsContext.Provider, {
          value: feeds as never,
          get children() {
            return createComponent(MemoryRouter, {
              history,
              get children() {
                return [createComponent(Route, { path: "/ladder", component: Ladder })];
              },
            });
          },
        }),
      mount,
    );
    /** The characters the table lists, by name, and the attempts behind each. */
    const characters = (): string[] =>
      [...mount.querySelectorAll<HTMLTableRowElement>("tbody tr")]
        .map((r) => {
          const name = r.querySelector('a[href^="/character/"]')?.textContent?.trim();
          return name === undefined ? null : `${name} ×${r.querySelector("td:nth-child(4)")?.textContent?.trim()}`;
        })
        .filter((c): c is string => c !== null);

    try {
      await settle();
      // "latest" stays on the established series while 1.0 is the preview.
      expect(characters()).toEqual(["Oldhand ×2"]);
      setSeries("1.0");
      await settle();
      expect(characters()).toEqual(["Newcomer ×1"]);
      setSeries("0.5");
      await settle();
      expect(characters()).toEqual(["Oldhand ×2"]);
      setSeries("all");
      await settle();
      expect(characters()).toEqual(["Oldhand ×2", "Newcomer ×1"]);
    } finally {
      dispose();
    }
  });
});
