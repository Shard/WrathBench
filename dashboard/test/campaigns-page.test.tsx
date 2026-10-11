/**
 * The campaigns page, rendered against a DOM over the fixture body.
 *
 * The words are pinned in `campaigns.test.ts`; this is the one check that the
 * page puts them where they belong and survives its own routes: the index and
 * its refused rows, one campaign's grid with its two header rows and its
 * squares' links, the run list a several-run square opens, the arm comparison,
 * and the empty and unknown campaigns. Every route is reached by navigating
 * one mounted router, the way a reader does, so a route change that throws
 * inside Solid's graph fails here rather than freezing the page.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { Window } from "happy-dom";
import { render } from "solid-js/web";
import { createServer } from "vite";
import solid from "vite-plugin-solid";
import { fileURLToPath } from "node:url";
import { CAMPAIGNS } from "./fixtures/campaigns";

const dashboardRoot = fileURLToPath(new URL("..", import.meta.url));

type Entry = typeof import("./fixtures/campaigns-entry");

/** The page and the router from one module graph, loaded once a DOM is installed. */
async function loadEntry(): Promise<Entry> {
  const server = await createServer({
    root: dashboardRoot,
    configFile: false,
    // Restated because `configFile: false` drops it: `lib/campaigns.ts`
    // imports the race and class names from `runner/viewer` at runtime.
    resolve: { alias: { "@viewer": fileURLToPath(new URL("../../runner/viewer", import.meta.url)) } },
    plugins: [solid({ dev: false, ssr: false })],
    optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true },
  });
  try {
    return (await server.ssrLoadModule("/test/fixtures/campaigns-entry.ts")) as Entry;
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
  "HTMLTemplateElement",
  "Document",
  "Event",
  "CustomEvent",
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

/**
 * A DOM, and a `fetch` that answers `/api/campaigns` with the fixture: the
 * page's client is created at import and keeps the `fetch` it found, so this
 * has to be in place before the entry loads.
 */
function installDom(): Document {
  const window = new Window();
  const fetch = async (url: string | URL | Request): Promise<Response> => {
    const path = String(url);
    if (path === "/api/campaigns") return new Response(JSON.stringify(CAMPAIGNS), { headers: { "content-type": "application/json" } });
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
    navigator: window.navigator,
    fetch,
  };
  for (const name of DOM_GLOBALS) {
    priorGlobals.set(name, { present: name in globalThis, value: (globalThis as Record<string, unknown>)[name] });
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: values[name] });
  }
  return window.document as unknown as Document;
}

afterEach(restoreGlobals);

/** Let the poll's first fetch and the router's navigation land. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

describe("the campaigns page", () => {
  test("index, one campaign, a square's runs, an empty campaign and an unknown one, on one router", async () => {
    const document = installDom();
    const { Campaigns, MemoryRouter, Route, createMemoryHistory } = await loadEntry();
    const mount = document.createElement("div");
    const history = createMemoryHistory();
    history.set({ value: "/campaigns" });
    const dispose = render(
      () =>
        createComponent(MemoryRouter, {
          history,
          get children() {
            return [
              createComponent(Route, { path: "/campaigns", component: Campaigns }),
              createComponent(Route, { path: "/campaigns/:id/:version", component: Campaigns }),
            ];
          },
        }),
      mount,
    );
    const go = async (path: string): Promise<void> => {
      history.set({ value: path });
      await settle();
    };
    const text = (el: Element | null = mount): string => el?.textContent?.replace(/\s+/g, " ").trim() ?? "";
    const all = (sel: string): Element[] => [...mount.querySelectorAll(sel)];

    try {
      await settle();

      // The index: one row per campaign, then the refused store row.
      const tables = all("table");
      expect(tables).toHaveLength(2);
      const rows = [...tables[0]!.querySelectorAll("tbody tr")];
      expect(rows.map((r) => r.querySelector("td")?.textContent)).toEqual(["wake-probe@1", "side-probe@2"]);
      expect(rows[0]!.querySelector("a")?.getAttribute("href")).toBe("/campaigns/wake-probe/1");
      expect(text(rows[0]!)).toContain("running");
      expect(text(rows[0]!)).toContain("5/12 · 1 capped · 1 live");
      expect(rows[0]!.querySelector(".dot.live")).not.toBeNull();
      expect(text(rows[0]!)).toContain("$3.40");
      expect(text(rows[1]!)).toContain("unassigned");
      expect(text(tables[1]!)).toContain("campaigns/old-probe");
      expect(text(tables[1]!)).toContain("wake-probe@1:flash:wake");
      expect(text(tables[1]!)).toContain("not published");
      // No caption paragraphs: the only text outside a table is the heading.
      expect(all("p")).toHaveLength(0);

      // One campaign: shape, arms, grid, comparison.
      await go("/campaigns/wake-probe/1");
      expect(text(mount.querySelector("h1"))).toBe("wake-probe@1 running");
      expect(all("h2.section").map((h) => h.textContent)).toEqual(["arms", "grid", "arm comparison", "refused"]);
      const [arms, grid, comparison, refusedHere] = all("table");
      // Only this campaign's refusals: its pair, not another campaign's store row.
      expect([...refusedHere!.querySelectorAll("tbody td:first-child")].map((td) => td.textContent)).toEqual(["wake-probe@1:flash:wake"]);
      expect(text(arms!.querySelector("tbody tr:nth-child(2)"))).toContain("runner@sha256:0123456789ab");

      // The grid's two header rows: each assignment over its two arms, then the arms.
      const head = [...grid!.querySelectorAll("thead tr")];
      expect(head).toHaveLength(2);
      const groups = [...head[0]!.querySelectorAll("th")].slice(2);
      expect(groups.map((th) => [th.textContent, th.getAttribute("colspan")])).toEqual([
        ["claude-sonnet-5.5 · low", "2"],
        ["flash-model (free)", "2"],
      ]);
      expect([...head[1]!.querySelectorAll("th")].map((th) => th.textContent)).toEqual(["control", "wake", "control", "wake"]);

      const body = [...grid!.querySelectorAll("tbody tr")];
      expect(body).toHaveLength(3);
      const north = [...body[0]!.querySelectorAll("td")];
      expect(north.map((td) => td.textContent)).toEqual(["north", "Dwarf Warrior", "1/1 41m", "1/1 38m", "0/1", ""]);
      // The live square is a dot inside the link to its run.
      const live = north[5]!.querySelector("a");
      expect(live?.getAttribute("href")).toBe("/run/fleet-wake-probe-north-flash-20261011-w");
      expect(live?.querySelector(".dot.live")).not.toBeNull();
      // Several runs open a list on this page.
      const several = north[3]!.querySelector("a")!.getAttribute("href")!;
      expect(several).toBe("/campaigns/wake-probe/1?cell=north&column=sonnet-low%7Cwake");
      // Matched by key: `south` was served out of order.
      expect([...body[1]!.querySelectorAll("td")].map((td) => td.textContent)).toEqual(["south", "Orc Warrior", "1/1 52m*", "capped", "·", "refused"]);
      expect([...body[1]!.querySelectorAll("td")][5]!.getAttribute("class")).toBe("right mono err");
      // A cell with no row is four gaps, and its note marks it.
      expect([...body[2]!.querySelectorAll("td")].map((td) => td.textContent)).toEqual(["east*", "Blood Elf Rogue", "", "", "", ""]);

      // The comparison: one row per arm, the assignment spanning its arms.
      const cmp = [...comparison!.querySelectorAll("tbody tr")];
      expect(cmp).toHaveLength(4);
      expect(cmp[0]!.querySelector("td")?.getAttribute("rowspan")).toBe("2");
      expect([...cmp[0]!.querySelectorAll("td")].map((td) => td.textContent).slice(0, 8)).toEqual([
        "claude-sonnet-5.5 · low",
        "control",
        "2",
        "2",
        "47m",
        "213",
        "$1.10*",
        "1.84M",
      ]);
      expect([...cmp[1]!.querySelectorAll("td")].map((td) => td.textContent).slice(0, 2)).toEqual(["wake", "2"]);

      // The several-run square's list.
      expect(mount.querySelector(".detail")).toBeNull();
      await go(several);
      const detail = mount.querySelector(".detail");
      expect(detail).not.toBeNull();
      expect([...detail!.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual([
        "/campaigns/wake-probe/1",
        "/run/fleet-wake-probe-north-sonnet-low-20261011-a1",
        "/run/fleet-wake-probe-north-sonnet-low-20261011-a2",
      ]);

      // Published with no store row: no grid, no comparison, said once each.
      await go("/campaigns/side-probe/2");
      expect(text(mount.querySelector("h1"))).toBe("side-probe@2 unassigned");
      expect(all("p").map((p) => p.textContent)).toEqual(["no store row", "no store row"]);
      expect(all("table")).toHaveLength(1);
      expect(text(all("table")[0]!)).toContain("release");

      // A key nothing publishes.
      await go("/campaigns/wake-probe/9");
      expect(text(mount.querySelector("h1"))).toBe("wake-probe@9");
      expect(all("p").map((p) => p.textContent)).toEqual(["not published"]);

      // And back to the index.
      await go("/campaigns");
      expect(all("table")).toHaveLength(2);
    } finally {
      dispose();
    }
  });
});
