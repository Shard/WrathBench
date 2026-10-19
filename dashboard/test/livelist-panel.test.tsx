/**
 * The map sidebar's live list (`components/LiveList.tsx`), against a DOM.
 *
 * The order itself is pinned by `liveListOrder`'s tests and the camera half of
 * a pick by `mapfit.test.ts`; what only the markup can show is that the rows
 * come out in that order, that a click hands the page the row's run, that a
 * poll handing back fresh objects in the same order rebuilds no row (a click
 * landing on a node being replaced is lost), and that no characters draws no
 * list at all.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createComponent, createSignal } from "solid-js";
import { Window } from "happy-dom";
import { render } from "solid-js/web";
import { createServer } from "vite";
import solid from "vite-plugin-solid";
import { fileURLToPath } from "node:url";
import type { AgentPosition } from "../../runner/viewer/api-types";

const dashboardRoot = fileURLToPath(new URL("..", import.meta.url));

type LiveListModule = typeof import("../src/components/LiveList");

async function loadLiveList(): Promise<LiveListModule> {
  const server = await createServer({
    root: dashboardRoot,
    configFile: false,
    resolve: { alias: { "@viewer": fileURLToPath(new URL("../../runner/viewer", import.meta.url)) } },
    plugins: [solid({ dev: false, ssr: false })],
    optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true },
  });
  try {
    return (await server.ssrLoadModule("/src/components/LiveList.tsx")) as LiveListModule;
  } finally {
    await server.close();
  }
}

const DOM_GLOBALS = ["window", "document", "Node", "Text", "Element", "HTMLElement", "SVGElement", "HTMLTemplateElement", "Document", "Event", "MouseEvent", "navigator"] as const;
const priorGlobals = new Map<string, { present: boolean; value: unknown }>();

function restoreGlobals(): void {
  for (const [name, prior] of priorGlobals) {
    if (prior.present) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: prior.value });
    else delete (globalThis as Record<string, unknown>)[name];
  }
  priorGlobals.clear();
}

function installDom(): Document {
  const window = new Window({ settings: { disableJavaScriptFileLoading: true, disableJavaScriptEvaluation: true, disableCSSFileLoading: true } });
  const w = window as unknown as Record<string, unknown>;
  for (const name of DOM_GLOBALS) {
    priorGlobals.set(name, { present: name in globalThis, value: (globalThis as Record<string, unknown>)[name] });
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: name === "window" ? window : w[name] });
  }
  return window.document as unknown as Document;
}

afterEach(restoreGlobals);

const at = (runId: string, character: string | null, level: number | null, map = 0): AgentPosition => ({
  runId,
  character,
  model: "fixture/test-model",
  map,
  x: 0,
  y: 0,
  ts: 0,
  level,
  xp: null,
  money: null,
  questsCompleted: null,
  harnessVersion: null,
});

const FEED = [at("run-low", "Lowena", 3), at("run-high", "Highmar", 12), at("run-mid", "Midrin", 7)];

/** Each row as it reads: its spans' text, the drawn swatch having none and the model's logo (a monogram here) left out. */
const rowsOf = (root: ParentNode): string[][] =>
  Array.from(root.querySelectorAll(".live-row")).map((b) =>
    Array.from(b.children)
      .map((s) => {
        const copy = s.cloneNode(true) as Element;
        for (const icon of Array.from(copy.querySelectorAll(".model-icon"))) icon.remove();
        return (copy.textContent ?? "").trim();
      })
      .filter((s) => s !== ""),
  );

async function mount(initial: readonly AgentPosition[]) {
  const document = installDom();
  const { LiveList } = await loadLiveList();
  const [rows, setRows] = createSignal<readonly AgentPosition[]>(initial);
  const picked: string[] = [];
  const el = document.createElement("div");
  document.body.append(el);
  const dispose = render(
    () =>
      createComponent(LiveList, {
        get rows() {
          return rows();
        },
        onPick: (id: string) => picked.push(id),
      }),
    el,
  );
  return { el, setRows, picked, dispose };
}

describe("the live list", () => {
  test("one row per live character, highest level first: name, model, level", async () => {
    const m = await mount(FEED);
    expect(rowsOf(m.el)).toEqual([
      ["Highmar", "test-model", "L12"],
      ["Midrin", "test-model", "L7"],
      ["Lowena", "test-model", "L3"],
    ]);
    m.dispose();
  });

  test("a click on a row hands the page that row's run", async () => {
    const m = await mount(FEED);
    const buttons = Array.from(m.el.querySelectorAll(".live-row")) as HTMLButtonElement[];
    buttons[1]!.click();
    buttons[0]!.click();
    expect(m.picked).toEqual(["run-mid", "run-high"]);
    m.dispose();
  });

  test("a poll in the same order keeps every row's node; a level change reorders", async () => {
    const m = await mount(FEED);
    const before = Array.from(m.el.querySelectorAll(".live-row"));
    m.setRows(FEED.map((p) => ({ ...p, x: p.x + 1 })));
    const after = Array.from(m.el.querySelectorAll(".live-row"));
    expect(after.every((b, i) => b === before[i])).toBe(true);
    m.setRows(FEED.map((p) => (p.runId === "run-low" ? { ...p, level: 13 } : p)));
    expect(rowsOf(m.el).map((r) => r[0])).toEqual(["Lowena", "Highmar", "Midrin"]);
    m.dispose();
  });

  test("where the character is and its newest log line are the row's hover, not columns", async () => {
    const far: AgentPosition = { ...at("run-far", "Farrow", 5, 1), status: { turn: 4, level: 5, zone: "Durotar", text: "heading for the docks", ts: 0 } };
    const unplaced: AgentPosition = { ...at("run-near", "Nearby", 4, 1), status: { turn: 2, level: 4, zone: null, text: "resting", ts: 0 } };
    const m = await mount([...FEED, far, unplaced]);
    expect(rowsOf(m.el)[2]).toEqual(["Farrow", "test-model", "L5"]);
    const titles = Array.from(m.el.querySelectorAll(".live-row")).map((b) => b.getAttribute("title"));
    expect(titles).toEqual(["Eastern Kingdoms", "Eastern Kingdoms", "Durotar — heading for the docks", "Kalimdor — resting", "Eastern Kingdoms"]);
    m.dispose();
  });

  test("a character with no name yet reads as its model once, and an unknown level as a dash", async () => {
    const m = await mount([at("run-anon", null, null)]);
    expect(rowsOf(m.el)).toEqual([["test-model", "—"]]);
    m.dispose();
  });

  test("no live characters draws no list", async () => {
    const m = await mount([]);
    expect(m.el.querySelector(".live-list")).toBeNull();
    m.setRows(FEED);
    expect(m.el.querySelectorAll(".live-row").length).toBe(3);
    m.setRows([]);
    expect(m.el.querySelector(".live-list")).toBeNull();
    m.dispose();
  });
});
