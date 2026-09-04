/**
 * The shared axes must update their retained tick nodes when a chart's layout
 * changes. A tick value can survive an in-place update while its mapping and
 * formatter are replaced, so the test keeps the same SVG nodes and changes the
 * parent props without remounting either axis.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createComponent, createSignal } from "solid-js";
import { Window } from "happy-dom";
import { render } from "solid-js/web";
import { createServer } from "vite";
import solid from "vite-plugin-solid";
import { fileURLToPath } from "node:url";
import type { ChartBox } from "../src/lib/ladder";

const dashboardRoot = fileURLToPath(new URL("..", import.meta.url));

async function loadAxisComponents(): Promise<{ XAxis: typeof import("../src/components/ChartParts").XAxis; YAxis: typeof import("../src/components/ChartParts").YAxis }> {
  const server = await createServer({
    root: dashboardRoot,
    configFile: false,
    plugins: [solid({ dev: false, ssr: false })],
    optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true },
  });
  try {
    return (await server.ssrLoadModule("/src/components/ChartParts.tsx")) as {
      XAxis: typeof import("../src/components/ChartParts").XAxis;
      YAxis: typeof import("../src/components/ChartParts").YAxis;
    };
  } finally {
    await server.close();
  }
}

const BOX: ChartBox = { x0: 10, x1: 100, y0: 200, y1: 20 };
const TICKS = [1, 2];
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
  // The test restores its own globals in a finally block; this catches an
  // assertion or setup failure before that block can run.
  if (priorGlobals.size > 0) {
    for (const [name, prior] of priorGlobals) {
      if (prior.present) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: prior.value });
      else delete (globalThis as Record<string, unknown>)[name];
    }
    priorGlobals.clear();
  }
});

describe("shared chart-axis reactivity", () => {
  test("retained x and y ticks follow changed mappings and formatters in place", async () => {
    const { document, restore } = installDom();
    try {
      const [xFactor, setXFactor] = createSignal(10);
      const [yFactor, setYFactor] = createSignal(100);
      const [xPrefix, setXPrefix] = createSignal("x-old-");
      const [yPrefix, setYPrefix] = createSignal("y-old-");
      const { XAxis, YAxis } = await loadAxisComponents();

      const xMap = (): ((value: number) => number) => {
        const factor = xFactor();
        return (value) => value * factor;
      };
      const yMap = (): ((value: number) => number) => {
        const factor = yFactor();
        return (value) => value * factor;
      };
      const xFormat = (): ((value: number) => string) => {
        const prefix = xPrefix();
        return (value) => `${prefix}${value}`;
      };
      const yFormat = (): ((value: number) => string) => {
        const prefix = yPrefix();
        return (value) => `${prefix}${value}`;
      };
      const xProps = {
        ticks: TICKS,
        get px() {
          return xMap();
        },
        box: BOX,
        get format() {
          return xFormat();
        },
      };
      const yProps = {
        ticks: TICKS,
        get py() {
          return yMap();
        },
        box: BOX,
        get format() {
          return yFormat();
        },
      };
      const mount = document.createElement("div");
      const xSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      const ySvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      mount.append(xSvg, ySvg);
      const disposeX = render(() => createComponent(XAxis, xProps), xSvg);
      const disposeY = render(() => createComponent(YAxis, yProps), ySvg);
      const xLines = [...xSvg.querySelectorAll("line")];
      const yLines = [...ySvg.querySelectorAll("line")];
      const xLabels = [...xSvg.querySelectorAll("text")];
      const yLabels = [...ySvg.querySelectorAll("text")];
      expect(xLines.map((line) => line.getAttribute("x1"))).toEqual(["10", "20"]);
      expect(yLines.map((line) => line.getAttribute("y1"))).toEqual(["100", "200"]);
      expect(xLabels.map((label) => label.textContent)).toEqual(["x-old-1", "x-old-2"]);
      expect(yLabels.map((label) => label.textContent)).toEqual(["y-old-1", "y-old-2"]);

      setXFactor(30);
      setYFactor(400);
      setXPrefix("x-new-");
      setYPrefix("y-new-");
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      expect([...xSvg.querySelectorAll("line")]).toEqual(xLines);
      expect([...ySvg.querySelectorAll("line")]).toEqual(yLines);
      expect([...xSvg.querySelectorAll("text")]).toEqual(xLabels);
      expect([...ySvg.querySelectorAll("text")]).toEqual(yLabels);
      expect(xLines.map((line) => line.getAttribute("x1"))).toEqual(["30", "60"]);
      expect(yLines.map((line) => line.getAttribute("y1"))).toEqual(["400", "800"]);
      expect(xLabels.map((label) => label.textContent)).toEqual(["x-new-1", "x-new-2"]);
      expect(yLabels.map((label) => label.textContent)).toEqual(["y-new-1", "y-new-2"]);

      disposeX();
      disposeY();
    } finally {
      restore();
    }
  });
});
