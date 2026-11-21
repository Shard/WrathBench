/**
 * The run feed's rows, rendered (`components/FeedRows.tsx`): a run of actions
 * between two decisions is one closed line of counts with its failures drawn
 * under it, it opens to a line per action, a line opens to the card it used
 * to be, and what a reader opened stays open while a live tail grows the run.
 *
 * happy-dom through Vite, as the scratchpad panel's test does. Which rows
 * fold and what they count is `feedtier.test.ts`'s; this is the drawing.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createComponent, createSignal } from "solid-js";
import { Window } from "happy-dom";
import { render } from "solid-js/web";
import { createServer } from "vite";
import solid from "vite-plugin-solid";
import { fileURLToPath } from "node:url";
import type { FeedEntry } from "../../runner/viewer/api-types";
import { groupFeed, type FeedGroup } from "../src/lib/feedgroup";
import type { ExpandPreset } from "../src/lib/feedview";

const dashboardRoot = fileURLToPath(new URL("..", import.meta.url));

type RowsModule = typeof import("../src/components/FeedRows");

async function load(): Promise<RowsModule> {
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
    return (await server.ssrLoadModule("/src/components/FeedRows.tsx")) as RowsModule;
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

let seq = 0;
function e(t: string, ts: number, extra: Record<string, unknown> = {}): FeedEntry {
  return { i: seq++, t, ts, start: 0, end: 0, ...extra } as FeedEntry;
}

function move(moveId: number, ts: number, status = "arrived"): FeedEntry[] {
  const at = { moveId, map: 0, x: moveId * 10, y: 20, z: 0, target: null, routine: true };
  return [e("move", ts, { ...at, status: null }), e("move", ts + 5, { ...at, status })];
}

/** A reply, a snippet with its own action log, then a walk with one refusal and a read, then a reply. */
function window(): FeedEntry[] {
  return [
    e("request", 100, { turn: 1, messageCount: 4, promptChars: 9000 }),
    e("response", 200, { turn: 1, text: "Pulling the nearest boar, then walking the fence." }),
    e("tool_call", 300, { turn: 1, name: "run_snippet", args: {}, dispatchTs: 300 }),
    e("snippet", 300, { turn: 1, code: "await sdk.killTarget(boar)" }),
    e("actions", 380, {
      callTs: 300,
      actions: [
        { ts: 310, action: "set_target", status: 200, ms: 2, names: { target: "Invented Boar" } },
        { ts: 320, action: "cast_spell", status: 400, ms: 2, error: "out_of_range", names: { spell: "Invented Strike" } },
        { ts: 330, action: "loot", status: 200, ms: 2, names: { target: "Invented Boar" } },
      ],
    }),
    e("snippet_result", 400, { turn: 1, name: "run_snippet", isError: false, text: "ok" }),
    ...move(1, 500),
    ...move(2, 600, "too_far"),
    e("tool_call", 700, { turn: 1, name: "state_summary", args: {}, dispatchTs: 700 }),
    e("tool_result", 710, { turn: 1, name: "state_summary", isError: false, text: "level 7 · 62% health" }),
    e("milestone", 800, { kind: "level", from: 6, to: 7 }),
    e("response", 900, { turn: 2, text: "Level 7. On to the mill." }),
  ];
}

const texts = (root: Element, selector: string): string[] => [...root.querySelectorAll(selector)].map((el) => (el.textContent ?? "").replace(/\s+/g, " ").trim());
const click = (el: Element | null): void => {
  if (el === null) throw new Error("nothing to click");
  (el as HTMLElement).click();
};

async function mount(entries: () => FeedEntry[], preset: () => ExpandPreset = () => "responses") {
  const document = installDom();
  const { FeedList } = await load();
  const host = document.createElement("div");
  document.body.append(host);
  let prev: FeedGroup[] = [];
  const groups = (): FeedGroup[] => (prev = groupFeed(entries(), prev));
  const dispose = render(
    () =>
      createComponent(FeedList, {
        get groups() {
          return groups();
        },
        runId: "fixture",
        get preset() {
          return preset();
        },
        surface: { loop: "program" },
        reflections: undefined,
      }),
    host,
  );
  return { host, dispose };
}

describe("the feed's two tiers, drawn", () => {
  test("decisions are cards with an icon; the actions between them are one closed line of counts", async () => {
    const { host, dispose } = await mount(window);
    // turn, response, the snippet's card, the run, the level, the response.
    const rows = [...host.children];
    expect(rows.map((r) => r.className.replace(/\s+/g, " ").trim())).toEqual(["entry turn", "entry", "entry closed", "entry run bad", "entry mark", "entry"]);
    for (const r of rows) expect(r.querySelector(".feed-icon")).not.toBeNull();
    expect(texts(host, ".entry.mark .t")).toEqual(["level 6 → 7"]);

    const run = host.querySelector(".entry.run")!;
    const head = run.querySelector(":scope > .fold-head")!;
    expect(head.getAttribute("aria-expanded")).toBe("false");
    expect(texts(run, ".tally-chip")).toEqual(["2 moves", "1 read", "1 failed"]);
    // Closed, no line is drawn but the one that failed.
    expect(run.querySelectorAll(".act-line")).toHaveLength(0);
    expect(texts(run, ":scope > .action-line.err")).toEqual(["routine move to (20, 20) → too far"]);
    dispose();
  });

  test("a reply's blank lines at either end are not drawn; one that is only whitespace draws as an empty reply", async () => {
    // "all" opens the line a text-less reply folds to; opened, it adds nothing
    // the line did not say, for the whitespace-only reply as for the empty one.
    const { host, dispose } = await mount(
      () => [
        e("response", 100, { turn: 1, text: "\n\nHeading to the mill.\n\nThen the fence.\n" }),
        e("response", 200, { turn: 2, text: "\n\n \n" }),
        e("response", 300, { turn: 3, text: "At the mill." }),
        e("response", 400, { turn: 4, text: "" }),
      ],
      () => "all",
    );
    expect([...host.querySelectorAll("pre.block")].map((p) => p.textContent)).toEqual(["Heading to the mill.\n\nThen the fence.", "At the mill."]);
    const [blank, empty] = [host.children[1]!, host.children[3]!];
    expect(blank!.querySelector(".act.open")).not.toBeNull();
    expect(blank!.querySelector(".act .entry")).toBeNull();
    expect(empty!.querySelector(".act .entry")).toBeNull();
    expect(blank!.querySelector(".act-line")!.innerHTML.replace(/>[^<]*:[^<]*</g, "><")).toBe(empty!.querySelector(".act-line")!.innerHTML.replace(/>[^<]*:[^<]*</g, "><"));
    dispose();
  });

  test("every row carries its time, which is what the timeline scrolls the feed by", async () => {
    const { host, dispose } = await mount(window);
    // The turn's request, the reply, the snippet's call, the run's first action, the level, the reply.
    expect([...host.children].map((r) => (r as HTMLElement).dataset.ts)).toEqual(["100", "200", "300", "500", "800", "900"]);
    dispose();
  });

  test("under the default a snippet is its head: lines, outcome and what it put on the wire; a click opens the card", async () => {
    const { host, dispose } = await mount(window);
    const card = host.children[2]!;
    expect(texts(card, ".head .t")).toEqual(["run_snippet"]);
    expect(card.querySelector(".fold-toggle")!.getAttribute("aria-expanded")).toBe("false");
    expect(card.querySelectorAll(".body")).toHaveLength(0);
    expect(texts(card, ".head")[0]).toContain("1 line");
    expect(texts(card, ".head .outcome")).toEqual(["ok"]);
    // The refused cast is on the closed head, in the error colour.
    expect(texts(card, ".head .tally-chip")).toEqual(["2 combat actions", "1 loot", "1 failed"]);
    expect(card.querySelector(".head .tally-chip.err")).not.toBeNull();

    click(card.querySelector(".head"));
    expect(card.querySelector(".fold-toggle")!.getAttribute("aria-expanded")).toBe("true");
    expect(texts(card, "pre.block")).toEqual(["await sdk.killTarget(boar)", "ok"]);
    expect(card.querySelectorAll(".head .tally-chip")).toHaveLength(0);
    // Its action log: the counts, the refusal under them, and every dispatch once opened.
    expect(texts(card, ".body.actions .tally-chip")).toEqual(["2 combat actions", "1 loot", "1 failed"]);
    expect(texts(card, ".body.actions .action-line")).toEqual(["cast Invented Strike → refused: out_of_range"]);
    click(card.querySelector(".body.actions .fold-head"));
    expect(texts(card, ".body.actions .action-line")).toEqual(["target Invented Boar", "cast Invented Strike → refused: out_of_range", "loot Invented Boar"]);
    click(card.querySelector(".fold-toggle"));
    expect(card.querySelectorAll(".body")).toHaveLength(0);
    dispose();
  });

  test("a snippet that errored keeps its error mark closed; the presets that open calls open it; other tools' cards are whole", async () => {
    const [preset, setPreset] = createSignal<ExpandPreset>("responses");
    const entries = [
      e("tool_call", 1, { turn: 1, name: "run_snippet", args: {}, dispatchTs: 1 }),
      e("snippet", 1, { turn: 1, code: "a\nb\nc" }),
      e("snippet_result", 2, { turn: 1, name: "run_snippet", isError: true, text: "error (4ms)\nTypeError: x\n--- harness ---\nmoveTo too_far ×2: walk it in legs" }),
      e("tool_call", 3, { turn: 1, name: "log_status", args: { text: "noted" }, dispatchTs: 3 }),
      e("tool_result", 4, { turn: 1, name: "log_status", isError: false, text: "logged" }),
    ];
    const { host, dispose } = await mount(() => entries, preset);
    const [snippet, log] = [...host.children];
    expect(snippet!.className.replace(/\s+/g, " ").trim()).toBe("entry bad closed");
    expect(texts(snippet!, ".head .outcome.err")).toEqual(["error"]);
    expect(texts(snippet!, ".head")[0]).toContain("3 lines");
    expect(texts(snippet!, ".head .tally-chip.hint")).toEqual(["1 hint"]);
    // `log_status` is the model's own words: never closed.
    expect(log!.querySelector(".fold-toggle")).toBeNull();
    // Its one short argument is on its head, not a JSON body.
    expect(texts(log!, ".head .path")).toEqual(["noted"]);
    expect(texts(log!, "pre.block")).toEqual(["logged"]);

    setPreset("minimal");
    expect(snippet!.querySelectorAll(".body")).toHaveLength(0);
    for (const p of ["snippets", "all"] as const) {
      setPreset(p);
      expect(snippet!.querySelector(".fold-toggle")!.getAttribute("aria-expanded")).toBe("true");
      expect(snippet!.querySelector(".notice-callout")).not.toBeNull();
    }
    dispose();
  });

  test("a run opens to a line per action, and a line opens to the card it was", async () => {
    const { host, dispose } = await mount(window);
    const run = host.querySelector(".entry.run")!;
    click(run.querySelector(":scope > .fold-head"));
    expect(run.querySelector(":scope > .fold-head")!.getAttribute("aria-expanded")).toBe("true");
    expect(texts(run, ".act-line .act-label")).toEqual(["routine move", "routine move", "state_summary"]);
    expect(texts(run, ".act-line .act-text")).toEqual(["to (10, 20) → arrived", "to (20, 20) → too far", "level 7 · 62% health"]);
    expect(run.querySelectorAll(".act-line.err")).toHaveLength(1);
    // The failures are in the list now, not repeated under the head.
    expect(run.querySelectorAll(":scope > .action-line")).toHaveLength(0);

    expect(run.querySelectorAll(".act > .entry")).toHaveLength(0);
    click(run.querySelectorAll(".act-line")[2]!);
    const card = run.querySelector(".act > .entry")!;
    // The line it opened from names it: the card under it does not again.
    expect(texts(card, ".head .t")).toEqual([]);
    expect(texts(card, "pre.block")).toContain("level 7 · 62% health");
    dispose();
  });

  test("what a reader opened stays open while the live tail grows the run", async () => {
    const base = window().slice(0, -2);
    const [entries, setEntries] = createSignal(base);
    const { host, dispose } = await mount(entries);
    const run = host.querySelector(".entry.run")!;
    click(run.querySelector(":scope > .fold-head"));
    const first = run.querySelector(".act-line")!;
    expect(run.querySelectorAll(".act-line")).toHaveLength(3);

    setEntries([...base, ...move(3, 750)]);
    // The same row, still open, the same first line, and one more.
    expect(host.querySelector(".entry.run")).toBe(run);
    expect(run.querySelector(":scope > .fold-head")!.getAttribute("aria-expanded")).toBe("true");
    expect(run.querySelector(".act-line")).toBe(first);
    expect(run.querySelectorAll(".act-line")).toHaveLength(4);
    expect(texts(run, ".tally-chip")).toEqual(["3 moves", "1 read", "1 failed"]);
    dispose();
  });

  test("a run of one action is that action's line; the 'all' preset opens every run", async () => {
    const [preset, setPreset] = createSignal<ExpandPreset>("responses");
    const only = [e("response", 1, { turn: 1, text: "Reading." }), e("tool_call", 2, { turn: 1, name: "read_log", args: {}, dispatchTs: 2 }), e("tool_result", 3, { turn: 1, name: "read_log", isError: false, text: "5 entries" }), e("response", 4, { turn: 2, text: "Right." }), ...move(1, 10), ...move(2, 20)];
    const { host, dispose } = await mount(() => only, preset);
    const [single, walk] = [...host.querySelectorAll(".entry.run")];
    expect(single!.querySelector(".fold-head")).toBeNull();
    expect(texts(single!, ".act-line .act-label")).toEqual(["read_log"]);
    expect(walk!.querySelectorAll(".act-line")).toHaveLength(0);
    setPreset("all");
    expect(walk!.querySelectorAll(".act-line")).toHaveLength(2);
    dispose();
  });
});

describe("code and edits, drawn", () => {
  test("an edit is a diff under its path, the changed words marked and the code highlighted", async () => {
    const before = ["export async function grind() {", "  await sdk.moveTo({x:-5500,y:-470,z:400});", "  return 1;", "}"].join("\n");
    const after = ["export async function grind() {", "  await sdk.moveTo({x:-5500,y:-280,z:353});", "  return 1;", "}"].join("\n");
    const { host, dispose } = await mount(() => [
      e("tool_call", 1, { turn: 1, name: "edit_file", args: { path: "main.ts", old_string: before, new_string: after }, dispatchTs: 1 }),
      e("tool_result", 2, { turn: 1, name: "edit_file", isError: false, text: "edited main.ts (1 replacement)" }),
    ]);
    const card = host.children[0]!;
    expect(texts(card, ".head .path")).toEqual(["main.ts"]);
    expect(texts(card, "pre.diff > .dl.del")).toEqual(["await sdk.moveTo({x:-5500,y:-470,z:400});"]);
    expect(texts(card, "pre.diff > .dl.add")).toEqual(["await sdk.moveTo({x:-5500,y:-280,z:353});"]);
    expect(texts(card, "pre.diff > .dl.ctx")).toEqual(["export async function grind() {", "return 1;", "}"]);
    expect(texts(card, ".dl.del .dw")).toEqual(["470", "400"]);
    expect(texts(card, ".dl.add .dw")).toEqual(["280", "353"]);
    expect(texts(card, ".dl .syn-kw")).toContain("await");
    // No JSON of the args anywhere on the card.
    expect(card.textContent).not.toContain("old_string");
    dispose();
  });

  test("a write is its file, highlighted, under its path; a snippet's code is highlighted; a wait is one line", async () => {
    const { host, dispose } = await mount(
      () => [
        e("tool_call", 1, { turn: 1, name: "write_file", args: { path: "lib/util.ts", content: "export const a = 1;\n// done" }, dispatchTs: 1 }),
        e("tool_result", 2, { turn: 1, name: "write_file", isError: false, text: "created lib/util.ts" }),
        e("tool_call", 3, { turn: 1, name: "run_snippet", args: {}, dispatchTs: 3 }),
        e("snippet", 3, { turn: 1, code: "return state.xp.value" }),
        e("snippet_result", 4, { turn: 1, name: "run_snippet", isError: false, text: 'ok (1ms)\n=> "{\\"xp\\":7066}"' }),
        e("tool_call", 5, { turn: 1, name: "yield", args: { seconds: 60 }, dispatchTs: 5 }),
        e("tool_result", 65_000, { turn: 1, name: "yield", isError: false, text: "[wake 1 · slept 1m00s]" }),
      ],
      () => "all",
    );
    const [write, snippet] = [...host.children];
    expect(texts(write!, ".head .path")).toEqual(["lib/util.ts"]);
    expect(texts(write!, "pre.block .syn-kw")).toEqual(["export", "const"]);
    expect(texts(write!, "pre.block .syn-com")).toEqual(["// done"]);
    expect(texts(snippet!, "pre.block .syn-kw")).toEqual(["return"]);
    // The value it returned as a JSON string, laid out.
    expect(texts(snippet!, "pre.block")[1]).toBe("ok (1ms) => { xp: 7066 }");
    expect(host.textContent).toContain("1m");
    expect(host.textContent).not.toContain('{"seconds":60}');
    dispose();
  });
});
