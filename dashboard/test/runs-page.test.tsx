/**
 * The runs page, rendered against a DOM over 250 synthetic runs.
 *
 * The paging arithmetic is pinned in `runs.test.ts`; this is the check that the
 * page wires it the way the operator asked (2026-10-24): a hundred rows, the
 * counts the whole set's, the page in the URL, a new sort or filter back on
 * page 1, the links on rows already on screen following the URL, and a poll
 * that changes one run neither rebuilding the other rows nor moving the reader.
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

type Entry = typeof import("./fixtures/runs-entry");

async function loadEntry(): Promise<Entry> {
  const server = await createServer({
    root: dashboardRoot,
    configFile: false,
    resolve: { alias: { "@viewer": fileURLToPath(new URL("../../runner/viewer", import.meta.url)) } },
    plugins: [solid({ dev: false, ssr: false })],
    optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true },
  });
  try {
    return (await server.ssrLoadModule("/test/fixtures/runs-entry.ts")) as Entry;
  } finally {
    await server.close();
  }
}

/** 250 ended runs, newest first by index; the newest hundred are the highest level. */
function runs(): ResultRun[] {
  return Array.from({ length: 250 }, (_, i) => ({
    runId: `run-${String(i).padStart(3, "0")}`,
    model: i % 2 === 0 ? "vendor/even" : "vendor/odd",
    platform: "openrouter",
    harnessVersion: "harness-0.5-1-gabc",
    harnessSeries: "0.5",
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
    episode: "e90",
    episodeSource: "stamped",
    episodeOverride: false,
    unscored: null,
    startedAt: 1_790_000_000_000 - i * 60_000,
    endedAt: null,
    live: false,
    terminationReason: "episode-elapsed",
    levels: [],
    maxLevel: i < 100 ? 20 + (i % 7) : 5,
    xp: null,
    money: null,
    questsCompleted: 0,
    maps: [0],
    character: `Toon${i}`,
    playtimeMs: 60_000,
    tokens: null,
    actualCost: null,
    pauseReason: null,
    continuedFrom: null,
    stillborn: null,
  })) as ResultRun[];
}

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

/** A DOM, and a `fetch` that answers `/api/results` with whatever `served` holds when it is asked. */
function installDom(served: { runs: ResultRun[] }): Document {
  const window = new Window({ url: "http://localhost/" });
  const fetch = async (url: string | URL | Request): Promise<Response> => {
    const path = String(url);
    if (path.startsWith("/api/results")) return new Response(JSON.stringify({ runs: served.runs }), { headers: { "content-type": "application/json" } });
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

/** Let a fetch, its body and the router's navigation land, without running the poll's clock. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    jest.advanceTimersByTime(0);
    await Promise.resolve();
  }
}

describe("the runs page", () => {
  test("a hundred to a page, the page in the URL, sorts and filters from page 1, rows kept across a poll", async () => {
    const served = { runs: runs() };
    const document = installDom(served);
    const { Runs, FeedsContext, MemoryRouter, Route, createMemoryHistory } = await loadEntry();
    jest.useFakeTimers();
    const [series, setSeries] = createSignal("all");
    const feeds = {
      fleet: { latest: undefined, error: undefined, stalled: false, refresh: () => {} },
      info: { latest: undefined, error: undefined, stalled: false, refresh: () => {} },
      stale: () => false,
      seriesChoice: series,
      setSeriesChoice: setSeries,
      seriesAvailable: () => [],
    };
    const mount = document.createElement("div");
    document.body.appendChild(mount);
    const history = createMemoryHistory();
    history.set({ value: "/runs" });
    const dispose = render(
      () =>
        createComponent(FeedsContext.Provider, {
          value: feeds as never,
          get children() {
            return createComponent(MemoryRouter, {
              history,
              get children() {
                return [createComponent(Route, { path: "/runs", component: Runs })];
              },
            });
          },
        }),
      mount,
    );
    const go = async (path: string): Promise<void> => {
      history.set({ value: path });
      await settle();
    };
    const text = (el: Element | null = mount): string => el?.textContent?.replace(/\s+/g, " ").trim() ?? "";
    const rows = (): HTMLTableRowElement[] => [...mount.querySelectorAll<HTMLTableRowElement>("table.runs tbody tr")];
    const ids = (): string[] => rows().map((r) => r.querySelector("td:nth-child(2) a")?.getAttribute("title") ?? "");
    const rowOf = (id: string): HTMLTableRowElement | undefined => rows().find((r) => r.querySelector(`a[title="${id}"]`) !== null);
    const runLinks = (): string[] => rows().map((r) => r.querySelector("td:nth-child(2) a")!.getAttribute("href")!);
    const pagers = (): Element[] => [...mount.querySelectorAll("nav.pager")];
    const pageButton = (label: string): HTMLButtonElement =>
      [...pagers()[0]!.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label)!;
    const sortButton = (column: string): HTMLButtonElement =>
      [...mount.querySelectorAll<HTMLButtonElement>("button.sortbutton")].find((b) => text(b).startsWith(column))!;
    const location = (): string => history.get();

    try {
      await settle();

      // Page 1: the newest hundred, the count the whole set's, a pager above and below.
      expect(rows()).toHaveLength(100);
      expect(ids()[0]).toBe("run-000");
      expect(ids()[99]).toBe("run-099");
      expect(text(mount)).toContain("250 runs · sorted by started desc");
      expect(pagers()).toHaveLength(2);
      expect([...pagers()[0]!.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["‹", "1", "2", "3", "›"]);
      expect(pageButton("1").classList.contains("on")).toBe(true);
      expect(pageButton("‹").disabled).toBe(true);
      // Plain anchors, carrying the view they were drawn under.
      expect(rows()[0]!.querySelector("td:nth-child(2) a")!.getAttribute("href")).toBe("/run/run-000");

      // A sort of the whole set, from page 1: the hundred highest levels,
      // which here are the hundred already on screen — so `<For>` keeps their
      // elements, and those must follow the URL rather than the query they
      // were first drawn with (the link-staleness bug).
      const fifty = rowOf("run-050")!;
      sortButton("level").click();
      await settle();
      expect(location()).toBe("/runs?sort=level&dir=desc");
      expect(rows()).toHaveLength(100);
      expect(new Set(ids())).toEqual(new Set(Array.from({ length: 100 }, (_, i) => `run-${String(i).padStart(3, "0")}`)));
      expect(rowOf("run-050") === fifty).toBe(true);
      expect(runLinks().every((h) => h.endsWith("?sort=level&dir=desc"))).toBe(true);

      // Page 2: in the URL beside the sort, and on the links that lead to a run and back.
      pageButton("2").click();
      await settle();
      expect(location()).toBe("/runs?sort=level&dir=desc&page=2");
      expect(rows()).toHaveLength(100);
      expect(ids()[0]).toBe("run-100");
      expect(runLinks().every((h) => h.endsWith("?sort=level&dir=desc&page=2"))).toBe(true);
      // A link that narrows starts the narrower list at its top.
      const narrow = rowOf("run-100")!.querySelector('a[title^="vendor/even"]')!.getAttribute("href")!;
      expect(narrow).toBe("/runs?sort=level&dir=desc&model=vendor%2Feven");

      // A changed poll: one run on this page moves. Every other row is the
      // element it was, the moved one reads its new level, and the page holds.
      // (`===` rather than `toBe` throughout: bun's `toBe` passed a rebuilt
      // happy-dom row that reads the same as the one it replaced.)
      const kept = rowOf("run-150")!;
      const movedBefore = rowOf("run-120")!;
      served.runs = runs().map((r) => (r.runId === "run-120" ? { ...r, maxLevel: 9 } : r));
      jest.advanceTimersByTime(15_000);
      await settle();
      expect(location()).toBe("/runs?sort=level&dir=desc&page=2");
      expect(ids()[0]).toBe("run-120");
      expect(rowOf("run-150") === kept).toBe(true);
      expect(rowOf("run-120") === movedBefore).toBe(false);
      expect(text(rowOf("run-120")!.querySelector("td.right"))).toContain("9");

      // Another sort goes back to page 1.
      sortButton("level").click();
      await settle();
      expect(location()).toBe("/runs?sort=level&dir=asc");
      expect(rows()).toHaveLength(100);

      // A filter: the counts and the pages are the narrowed set's.
      await go("/runs?model=vendor%2Fodd&page=2");
      expect(text(mount)).toContain("Filtered to model=vendor/odd (125 of 250 runs)");
      expect(text(mount)).toContain("125 runs");
      expect(rows()).toHaveLength(25);
      expect(ids()[0]).toBe("run-201");
      // A page past the end shows the last one without rewriting the URL.
      await go("/runs?model=vendor%2Fodd&page=9");
      expect(location()).toBe("/runs?model=vendor%2Fodd&page=9");
      expect(ids()[0]).toBe("run-201");
      // Clearing the filter is a new list too.
      [...mount.querySelectorAll<HTMLButtonElement>("button.toggle")].find((b) => b.textContent === "clear")!.click();
      await settle();
      expect(location()).toBe("/runs");

      // So is the shell's series selector.
      await go("/runs?page=3");
      expect(ids()[0]).toBe("run-200");
      setSeries("0.5");
      await settle();
      expect(location()).toBe("/runs");
      expect(ids()[0]).toBe("run-000");
    } finally {
      dispose();
    }
  });
});
