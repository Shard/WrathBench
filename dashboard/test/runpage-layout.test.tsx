/**
 * The run page's sidebar, as the operator laid it out: the model, then the
 * character, then the figures; one cost card; and the character's totals
 * across attempts folded into a pane under the milestones, closed until the
 * reader opens it — it used to lead the sidebar, eight cards tall.
 *
 * The two components are rendered for real (happy-dom, as the scratchpad
 * panel's test does). Where they sit on the page is component wiring with no
 * seam to call, so that is asserted on the page's source, the way
 * `snapshot-client.test.ts` pins the public build's call sites.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { Window } from "happy-dom";
import { render } from "solid-js/web";
import { createServer } from "vite";
import solid from "vite-plugin-solid";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { CharacterView, ClipsResponse, CostView } from "../../runner/viewer/api-types";

const dashboardRoot = fileURLToPath(new URL("..", import.meta.url));

type CardsModule = typeof import("../src/components/CharacterCards");
type CostModule = typeof import("../src/components/CostCard");
type ReplayModule = typeof import("../src/components/Replay");

async function load(): Promise<{ cards: CardsModule; cost: CostModule; replay: ReplayModule }> {
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
    return {
      cards: (await server.ssrLoadModule("/src/components/CharacterCards.tsx")) as CardsModule,
      cost: (await server.ssrLoadModule("/src/components/CostCard.tsx")) as CostModule,
      replay: (await server.ssrLoadModule("/src/components/Replay.tsx")) as ReplayModule,
    };
  } finally {
    await server.close();
  }
}

const DOM_GLOBALS = ["window", "document", "Node", "Text", "Element", "HTMLElement", "SVGElement", "Document", "Event", "navigator", "localStorage"] as const;
const prior = new Map<string, { present: boolean; value: unknown }>();

function installDom(): Document {
  const window = new Window();
  const values: Record<(typeof DOM_GLOBALS)[number], unknown> = {
    window,
    document: window.document,
    Node: window.Node,
    Text: window.Text,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    SVGElement: window.SVGElement,
    Document: window.Document,
    Event: window.Event,
    navigator: window.navigator,
    localStorage: window.localStorage,
  };
  for (const name of DOM_GLOBALS) {
    prior.set(name, { present: name in globalThis, value: (globalThis as Record<string, unknown>)[name] });
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: values[name] });
  }
  return window.document as unknown as Document;
}

afterEach(() => {
  for (const [name, p] of prior) {
    if (p.present) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: p.value });
    else delete (globalThis as Record<string, unknown>)[name];
  }
  prior.clear();
});

const tokens = { source: "reported", contextTokens: 10, promptTokens: 1000, completionTokens: 200, totalTokens: 1200, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 4 };

const character = {
  characterId: "char-root",
  model: "m",
  effort: null,
  driver: null,
  harnessVersion: null,
  name: "Wanderly",
  characterLabel: null,
  attempt: 2,
  attempts: 2,
  previous: "char-root",
  next: null,
  truncated: false,
  runs: [],
  totals: {
    attempts: 2,
    startedAt: null,
    endedAt: null,
    playtimeMs: 3_600_000,
    questsCompleted: 3,
    xpEarned: 1000,
    tokens,
    cost: { actualUsd: 1.5, actualAttempts: 1, expectedUsd: 2.25, expectedAttempts: 2, attempts: 2, asIfMetered: false, actualBackfilled: 1 },
    level: 8,
    money: 100,
    achievements: null,
    deaths: null,
    taxi: null,
    spells: null,
    talents: null,
    trades: null,
    toolCalls: 1,
    snippets: 1,
    modelResponses: 1,
  },
} as unknown as CharacterView;

const figure = (over: Partial<CostView["actual"]>): CostView["actual"] => ({ usd: null, basis: "none", asIfMetered: false, priceId: null, asOf: null, note: "", ...over });

describe("the character's totals on a run page", () => {
  test("render as a closed pane, with the attempt count on its head and one cost card inside", async () => {
    const document = installDom();
    const { cards } = await load();
    const mount = document.createElement("div");
    document.body.append(mount);
    const dispose = render(() => createComponent(cards.CharacterTotalsPanel, { character, runId: "char-2" }), mount);

    const pane = mount.querySelector("section.collapsible");
    expect(pane).not.toBeNull();
    expect(pane!.classList.contains("open")).toBe(false);
    expect(pane!.querySelector(".collapsible-toggle")!.getAttribute("aria-expanded")).toBe("false");
    expect(pane!.querySelector(".collapsible-body")!.hasAttribute("inert")).toBe(true);
    expect(pane!.querySelector(".collapsible-summary")!.textContent).toBe("2 attempts");

    // One cost card, not an actual and an expected; the backfill mark stays on the figure.
    // The label is the key's own text; the hint's glyph is a button beside it.
    const label = (c: Element): string => c.querySelector(".k")!.firstChild!.textContent!.trim();
    const costs = [...mount.querySelectorAll(".card")].filter((c) => label(c).startsWith("cost"));
    expect(costs.map(label)).toEqual(["cost"]);
    const cost = costs[0]!;
    expect(cost.querySelector(".v")!.textContent).toBe("$1.50*");
    expect(cost.querySelector(".sub")!.textContent).toBe("actual 1/2 · expected $2.25");
    expect(cost.querySelector(".info-hint")).not.toBeNull();
    dispose();
  });
});

describe("the replay's chapter list", () => {
  test("is a pane that starts closed, lists levels and boss kills only, and seeks the timeline to the run time a chapter is at", async () => {
    const document = installDom();
    const { replay } = await load();
    // A video cut before the rule: its turn-ins and zones still listed, and a death that is an event, not a chapter.
    const clips = {
      parts: [{ seconds: 300 }],
      chapters: [
        { t: 0, part: 0, type: "zone", detail: "entered zone 12", caption: "" },
        { t: 30, part: 0, type: "quest", detail: "turned in quest 7", caption: "" },
        { t: 61, part: 0, type: "level", detail: "reached level 5", caption: "On to the mill." },
        { t: 185, part: 0, type: "death", detail: "died", caption: "" },
        { t: 240, part: 0, type: "boss", detail: "killed boss 644", caption: "" },
      ],
      // Ten seconds of run time to a second of video, from run time 1,000,000.
      timemap: [
        [0, 1_000_000],
        [300, 4_000_000],
      ],
    } as unknown as ClipsResponse;
    const sought: number[] = [];
    const mount = document.createElement("div");
    document.body.append(mount);
    // The focus is 70 s into the video.
    const dispose = render(() => createComponent(replay.ChaptersPanel, { clips, at: 1_700_000, onSeek: (ms: number) => void sought.push(ms) }), mount);

    const pane = mount.querySelector(".collapsible")!;
    expect(pane.classList.contains("open")).toBe(false);
    expect(pane.querySelector(".collapsible-toggle")!.getAttribute("aria-expanded")).toBe("false");
    expect(pane.querySelector(".collapsible-title")!.textContent).toBe("replay chapters");
    expect(pane.querySelector(".collapsible-summary")!.textContent).toBe("2");
    const rows = [...pane.querySelectorAll("tr")];
    expect(rows.map((r) => [...r.querySelectorAll("td")].map((td) => td.textContent!.trim()))).toEqual([
      ["1:01", "level", "reached level 5"],
      ["4:00", "boss", "killed boss 644"],
    ]);
    // The chapter the focus is in is marked.
    expect(rows.map((r) => r.className)).toEqual(["hovered", ""]);

    (pane.querySelector(".collapsible-toggle") as HTMLElement).click();
    expect(pane.classList.contains("open")).toBe(true);
    (rows[1]!.querySelector("a") as HTMLElement).click();
    expect(sought).toEqual([3_400_000]);
    dispose();
  });

  test("a run with no chapters, or with only what is no chapter any more, has no pane", async () => {
    const document = installDom();
    const { replay } = await load();
    const mount = document.createElement("div");
    document.body.append(mount);
    const dispose = render(() => createComponent(replay.ChaptersPanel, { clips: { parts: [], chapters: [], timemap: [] } as unknown as ClipsResponse, at: 0, onSeek: () => undefined }), mount);
    expect(mount.querySelector(".collapsible")).toBeNull();
    dispose();
  });
});

describe("the run's cost card", () => {
  test("headlines the actual, keeps the expected with its price month underneath, and hides the notes behind the hint", async () => {
    installDom();
    const { cost } = await load();
    const r = cost.runCostReading({
      actual: figure({ usd: 3.2, basis: "reported", asIfMetered: true, note: "the SDK's own figure", backfill: { reportedUsd: 3, usd: 0.2, turns: 2 } }),
      expected: figure({ usd: 4, basis: "list-price", priceId: "row", asOf: "2026-10-03", note: "row list price as of 2026-10-03" }),
    });
    expect(r.value).toBe("$3.20*");
    expect(r.sub).toBe("actual, as-if-metered · expected $4.00 (2026-10)");
    expect(r.hint).toBe("actual: the SDK's own figure\n\nexpected: row list price as of 2026-10-03");
  });

  test("falls back to the expected when the provider reported nothing, and says so in a word", async () => {
    installDom();
    const { cost } = await load();
    const r = cost.runCostReading({
      actual: figure({ note: "provider reports no cost" }),
      expected: figure({ usd: 0.5, basis: "list-price", asOf: "2026-09-01", note: "n" }),
    });
    expect(r.value).toBe("$0.500");
    expect(r.sub).toBe("expected, 2026-09 prices · no actual");
    expect(cost.runCostReading(undefined).value).toBe("—");
  });
});

describe("the run page's sidebar order", () => {
  const src = readFileSync(new URL("../src/pages/RunDetail.tsx", import.meta.url), "utf8");
  const at = (needle: string): number => {
    const i = src.indexOf(needle);
    expect(i).toBeGreaterThan(-1);
    return i;
  };

  test("the controls and the live status are in the title row, not the sidebar", () => {
    expect(at('<div class="runview-head">')).toBeLessThan(at('class="side-controls runview-actions"'));
    expect(at('class="side-controls runview-actions"')).toBeLessThan(at('<aside class="runview-side">'));
    expect(at("runview-status")).toBeLessThan(at('<aside class="runview-side">'));
  });

  test("the model leads the sidebar, the character card follows it, and the totals pane sits under the milestones", () => {
    const side = at('<aside class="runview-side">');
    const model = at('<div class="k">model</div>');
    const char = at('<div class="k">character</div>');
    expect(side).toBeLessThan(model);
    expect(model).toBeLessThan(char);
    // Nothing between the sidebar's start and the model but a comment, the grid and the
    // gate a store session's page drops it by (it has no model side, `hasModelSide`).
    expect(src.slice(side, model).replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\s+/g, " ").trim()).toBe(
      '<aside class="runview-side"> <div class="cards"> <Show when={hasModelSide(run())}> <div class="card">',
    );
    expect(at('<h2 class="section">milestones</h2>')).toBeLessThan(at("<CharacterTotalsPanel"));
    // The video's chapter list is a pane under the milestones too, not a table under the player.
    expect(at("<RunVideo")).toBeLessThan(at('<h2 class="section">milestones</h2>'));
    expect(at('<h2 class="section">milestones</h2>')).toBeLessThan(at("<ChaptersPanel"));
    expect(at("<ChaptersPanel")).toBeLessThan(at("<CharacterTotalsPanel"));
    expect(src).not.toContain("<CharacterTotalsCard");
  });

  test("one cost card", () => {
    expect(src.match(/<CostCard /g)?.length).toBe(1);
    expect(src).not.toContain("cost — actual");
    expect(src).not.toContain("cost — expected");
  });
});
