/**
 * The map sidebar's quest button and its panel, against a DOM.
 *
 * What the pure tests (`questlog.test.ts`) cannot see is the markup's two
 * promises. The button is there only while the sheet carries the log. And
 * each quest's anchor is made once per quest id: Wowhead's script names a
 * quest by replacing what is inside its link, so a row rebuilt on every
 * counter would fall back to `quest <id>` each time the playhead crossed
 * one. The script never loads here (happy-dom fetches nothing), so its rename
 * is done by hand, the way it does it.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createComponent, createSignal } from "solid-js";
import { Window } from "happy-dom";
import { render } from "solid-js/web";
import { createServer } from "vite";
import solid from "vite-plugin-solid";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { QuestRow } from "../src/lib/questlog";

const dashboardRoot = fileURLToPath(new URL("..", import.meta.url));

type InventoryModule = typeof import("../src/components/Inventory");

async function loadInventory(): Promise<InventoryModule> {
  const server = await createServer({
    root: dashboardRoot,
    configFile: false,
    resolve: { alias: { "@viewer": fileURLToPath(new URL("../../runner/viewer", import.meta.url)) } },
    plugins: [solid({ dev: false, ssr: false })],
    optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true },
  });
  try {
    return (await server.ssrLoadModule("/src/components/Inventory.tsx")) as InventoryModule;
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
  // The panel is portalled, and Solid's Portal asks whether its mount is the head.
  "HTMLHeadElement",
  "Document",
  "Event",
  "MouseEvent",
  "KeyboardEvent",
  "MutationObserver",
  "navigator",
] as const;
const priorGlobals = new Map<string, { present: boolean; value: unknown }>();

function installDom(): { document: Document; restore: () => void } {
  // Nothing is fetched or run: the tooltip script's tag errors out at once, as a blocked reader's does.
  const window = new Window({ settings: { disableJavaScriptFileLoading: true, disableJavaScriptEvaluation: true, disableCSSFileLoading: true } });
  const w = window as unknown as Record<string, unknown>;
  for (const name of DOM_GLOBALS) {
    priorGlobals.set(name, { present: name in globalThis, value: (globalThis as Record<string, unknown>)[name] });
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: name === "window" ? window : w[name] });
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

const LOG: QuestRow[] = [
  { questId: 902, slot: 0, status: "active", objectives: [{ have: 1, need: 3, itemId: 5002, name: "Fixture Fang" }] },
  { questId: 900, slot: 1, status: "active", objectives: [{ have: 2, need: 6 }, { have: 0, need: 10 }] },
  { questId: 903, slot: 4, status: "complete", objectives: [] },
  { questId: 904, slot: 6, status: "failed", objectives: [{ have: 1, need: 4 }] },
  { questId: 905, slot: 9, status: "active", objectives: null },
  { questId: 899, slot: null, status: "turnedIn", objectives: null },
];

/** An objective's text as printed: its spaces do not break, so a row wraps only between objectives. */
const nb = (s: string): string => s.replace(/ \/ /g, " / ");

/** Each button as it reads: its spans' text, the drawn icons having none. */
const labels = (root: ParentNode): string[] =>
  Array.from(root.querySelectorAll(".popover-button")).map((b) =>
    Array.from(b.children)
      .map((s) => s.textContent ?? "")
      .filter((s) => s !== "")
      .join(" "),
  );

describe("the quest button and its panel", () => {
  test("a button only while the sheet carries the log, counting the quests in it", async () => {
    const { document, restore } = installDom();
    try {
      const { InventoryPanel } = await loadInventory();
      const [quests, setQuests] = createSignal<QuestRow[] | null>(null);
      const mount = document.createElement("div");
      document.body.append(mount);
      const dispose = render(
        () =>
          createComponent(InventoryPanel, {
            items: [],
            get quests() {
              return quests();
            },
          }),
        mount,
      );
      expect(labels(mount)).toEqual(["0 carrying", "0 equipped"]);
      setQuests(LOG);
      // The turn-in is listed, not counted.
      expect(labels(mount)).toEqual(["0 carrying", "0 equipped", "? 5 quests"]);
      setQuests([]);
      expect(labels(mount)).toEqual(["0 carrying", "0 equipped", "? 0 quests"]);
      setQuests(null);
      expect(labels(mount)).toEqual(["0 carrying", "0 equipped"]);
      dispose();
    } finally {
      restore();
    }
  });

  test("the button does not wait on the bags: a sheet with the log and not yet the bags draws both the null word and the button", async () => {
    const { document, restore } = installDom();
    try {
      const { InventoryPanel } = await loadInventory();
      // Live after a sandbox restart: the log is back, the bags are not, and the feed carries no inventory.
      const [items, setItems] = createSignal<[] | null>(null);
      const [quests, setQuests] = createSignal<QuestRow[] | null>(null);
      const mount = document.createElement("div");
      document.body.append(mount);
      const dispose = render(
        () =>
          createComponent(InventoryPanel, {
            get items() {
              return items();
            },
            get quests() {
              return quests();
            },
            missing: "—",
          }),
        mount,
      );
      const note = (): string[] => Array.from(mount.querySelectorAll(".inv-note")).map((n) => n.textContent ?? "");
      // Neither observed: the word alone, as before.
      expect(labels(mount)).toEqual([]);
      expect(note()).toEqual(["—"]);
      expect(mount.querySelector(".inventory")).toBeNull();
      setQuests(LOG);
      expect(labels(mount)).toEqual(["? 5 quests"]);
      expect(note()).toEqual(["—"]);
      // The bags arrive: their buttons take the word's place.
      setItems([]);
      expect(labels(mount)).toEqual(["0 carrying", "0 equipped", "? 5 quests"]);
      expect(note()).toEqual([]);
      dispose();
    } finally {
      restore();
    }
  });

  test("each row links its quest for the script to name, its progress beside it while in progress, its status in its colour after", async () => {
    const { document, restore } = installDom();
    try {
      const { QuestLog } = await loadInventory();
      const [rows, setRows] = createSignal<QuestRow[]>(LOG);
      const mount = document.createElement("div");
      document.body.append(mount);
      const dispose = render(
        () =>
          createComponent(QuestLog, {
            get rows() {
              return rows();
            },
          }),
        mount,
      );
      (mount.querySelector(".popover-button") as HTMLButtonElement).click();
      const panel = document.body.querySelector(".bag-popover")!;
      expect(panel).not.toBeNull();
      const items = Array.from(panel.querySelectorAll("li"));
      expect(items).toHaveLength(6);

      const link = items[0]!.querySelector("a.inv-list-link") as HTMLAnchorElement;
      expect(link.getAttribute("href")).toBe("https://www.wowhead.com/wotlk/quest=902");
      expect(link.getAttribute("data-wh-rename-link")).toBe("true");
      expect(link.textContent).toBe("quest 902");
      // The progress sits outside the anchor, which the script rewrites.
      expect(link.querySelector(".inv-list-count")).toBeNull();

      const progress = (li: Element) => li.querySelector(".inv-list-count > span")!;
      expect(progress(items[0]!).textContent).toBe(nb("1 / 3"));
      expect(progress(items[0]!).querySelector("span")!.getAttribute("title")).toBe("Fixture Fang");
      expect(progress(items[1]!).textContent).toBe(nb("2 / 6 · 0 / 10"));
      expect(progress(items[1]!).getAttribute("class")).toBeNull();
      expect(progress(items[2]!).textContent).toBe("complete");
      expect(progress(items[2]!).getAttribute("class")).toBe("ok");
      // Out of progress, the status alone: a failed quest's counts are not what it is.
      expect(progress(items[3]!).textContent).toBe("failed");
      expect(progress(items[3]!).getAttribute("class")).toBe("err");
      expect(items[3]!.querySelector(".inv-list-count")!.getAttribute("title")).toBe("failed");
      // No counts recorded for it: nothing beside the link, rather than zeros.
      expect(progress(items[4]!).textContent).toBe("");
      expect(progress(items[5]!).textContent).toBe("turned in");
      expect(progress(items[5]!).getAttribute("class")).toBe("ok-muted");

      // The script names the quest the way it does: by replacing the link's contents.
      link.innerHTML = "<span>Fixture Quest</span>";
      // A counter climbs and quest 902 completes: new row objects, the same anchors.
      setRows([
        { ...LOG[0]!, status: "complete", objectives: [{ have: 3, need: 3, itemId: 5002, name: "Fixture Fang" }] },
        { ...LOG[1]!, objectives: [{ have: 3, need: 6 }, { have: 0, need: 10 }] },
        ...LOG.slice(2),
      ]);
      const after = Array.from(panel.querySelectorAll("li"));
      expect(after[0]!.querySelector("a")).toBe(link);
      expect(link.textContent).toBe("Fixture Quest");
      expect(progress(after[0]!).textContent).toBe("complete");
      expect(progress(after[0]!).getAttribute("class")).toBe("ok");
      expect(progress(after[1]!).textContent).toBe(nb("3 / 6 · 0 / 10"));
      dispose();
    } finally {
      restore();
    }
  });
});

describe("a long title beside several objectives", () => {
  /** A collect quest of four items, the last at full count: the shape that read as a one-objective quest when both halves wrapped. */
  const LONG: QuestRow = {
    questId: 906,
    slot: 2,
    status: "active",
    objectives: [
      { have: 0, need: 1, itemId: 5101, name: "Fixture Bolt" },
      { have: 1, need: 1, itemId: 5102, name: "Fixture Thread" },
      { have: 0, need: 1, itemId: 5103, name: "Fixture Cloak" },
      { have: 10, need: 10, itemId: 5104, name: "Fixture Fur" },
    ],
  };

  test("the row is the title and one cell of every objective, so the objectives move together", async () => {
    const { document, restore } = installDom();
    try {
      const { QuestLog } = await loadInventory();
      const mount = document.createElement("div");
      document.body.append(mount);
      const dispose = render(() => createComponent(QuestLog, { rows: [LONG] }), mount);
      (mount.querySelector(".popover-button") as HTMLButtonElement).click();
      const li = document.body.querySelector(".bag-popover li")!;
      // The script's rename, by hand: a title long enough to wrap in the panel.
      li.querySelector("a.inv-list-link")!.innerHTML = "<span>Fixture Trapper's Long Yeti Fur Cloak of Many Words</span>";
      expect(Array.from(li.children).map((c) => c.getAttribute("class"))).toEqual(["inv-list-link", "inv-list-count"]);
      expect(li.querySelector(".inv-list-count")!.textContent).toBe(nb("0 / 1 · 1 / 1 · 0 / 1 · 10 / 10"));
      dispose();
    } finally {
      restore();
    }
  });

  test("in a 320 px panel the objectives drop under the title rather than pair their last line with its last line", () => {
    // happy-dom does no layout, so the rule is what the classes carry; `bun wb dashboard shots` shows it drawn.
    const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
    const body = (selector: string): string => {
      const m = new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(css);
      expect(m).not.toBeNull();
      return m![1]!;
    };
    expect(body(".inv-list")).toMatch(/max-width:\s*min\(320px/);
    const li = body(".inv-list li");
    // Wrap the row, not just its halves: the count takes a line of its own when the two do not fit side by side.
    expect(li).toMatch(/flex-wrap:\s*wrap/);
    // No gap between the title's line and the dropped objectives, so they read as one row, not two.
    expect(li).toMatch(/gap:\s*0 8px/);
    // Dropped, the objectives keep the right-hand column the counts sit in.
    expect(body(".inv-list-count")).toMatch(/margin-left:\s*auto/);
  });
});
