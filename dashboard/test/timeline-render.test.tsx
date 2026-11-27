/**
 * The timeline, drawn (`src/components/Timeline.tsx`): the bar against a DOM,
 * for a short run, a live one and one long enough to zoom; and that both
 * pages mount it and neither keeps a scrubber of its own.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { Window } from "happy-dom";
import { render } from "solid-js/web";
import { createServer } from "vite";
import solid from "vite-plugin-solid";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runMarks } from "../../viewer/timeline-marks";
import type { Span } from "../src/lib/timeline";
import type { TimelineStore } from "../src/lib/timelinestore";

const dashboardRoot = fileURLToPath(new URL("..", import.meta.url));

type Entry = typeof import("./fixtures/timeline-entry");

async function load(): Promise<Entry> {
  const server = await createServer({
    root: dashboardRoot,
    configFile: false,
    resolve: {
      alias: {
        "@viewer": fileURLToPath(new URL("../../viewer", import.meta.url)),
        "@runner": fileURLToPath(new URL("../../runner/src", import.meta.url)),
      },
    },
    plugins: [solid({ dev: false, ssr: false })],
    optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true },
  });
  try {
    return (await server.ssrLoadModule("/test/fixtures/timeline-entry.ts")) as Entry;
  } finally {
    await server.close();
  }
}

const DOM_GLOBALS = ["window", "document", "Node", "Text", "Element", "HTMLElement", "SVGElement", "Document", "Event", "navigator", "localStorage"] as const;
const prior = new Map<string, { present: boolean; value: unknown }>();
let win: Window | undefined;

function installDom(): Document {
  const window = new Window();
  win = window;
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

const HOUR = 3_600_000;
const T0 = 1_763_000_000_000;

/** A run of `hours`: a level gained at each third, a boss killed at the half, a death at five sixths. */
function marksFor(hours: number) {
  const len = hours * HOUR;
  return runMarks({
    leveling: {
      marks: [
        { ts: T0, from: null, to: 7, xp: 0, turn: 1 },
        { ts: T0 + len / 3, from: 7, to: 8, xp: 0, turn: 5 },
        { ts: T0 + (2 * len) / 3, from: 8, to: 9, xp: 0, turn: 9 },
      ],
    },
    bosses: [{ ts: T0 + len / 2, entry: 644, name: null }],
    deaths: { sites: [{ ts: T0 + (5 * len) / 6 }] },
  });
}

async function mount(hours: number, live = false) {
  const document = installDom();
  const entry = await load();
  const host = document.createElement("div");
  document.body.append(host);
  let tl!: TimelineStore;
  let setSpan!: (s: Span) => void;
  const dispose = render(() => {
    const [span, set] = entry.createSignal<Span | null>({ from: T0, to: T0 + hours * HOUR });
    setSpan = (s) => void set(s);
    tl = entry.createTimeline({ span, live: () => live, external: true });
    return createComponent(entry.Timeline, { store: tl, marks: marksFor(hours), startLevel: 7, feed: { from: T0 + hours * HOUR * 0.9, to: T0 + hours * HOUR } });
  }, host);
  const bar = host.querySelector(".timeline")!;
  /** The track answers for a 1000px box, so a pointer's x is a tenth of a percent of the view. */
  const track = bar.querySelector(".timeline-track") as HTMLElement;
  track.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1000, bottom: 40, width: 1000, height: 40, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  const pointer = (type: string, x: number, target: Element = track): void => {
    const ev = new win!.Event(type, { bubbles: true, cancelable: true }) as unknown as Record<string, unknown>;
    Object.assign(ev, { clientX: x, pointerId: 1, pointerType: "mouse", buttons: 1 });
    target.dispatchEvent(ev as unknown as Event);
  };
  const key = (k: string): void => {
    const ev = new win!.Event("keydown", { bubbles: true, cancelable: true }) as unknown as Record<string, unknown>;
    Object.assign(ev, { key: k });
    document.dispatchEvent(ev as unknown as Event);
  };
  const text = (sel: string): string[] => [...bar.querySelectorAll(sel)].map((el) => (el.textContent ?? "").replace(/\s+/g, " ").trim());
  return { document, host, bar, track, tl, setSpan, pointer, key, text, dispose };
}

describe("the timeline's bar", () => {
  test("draws the run as level bands with its boss kill and its death on them, and pads the shell while it is mounted", async () => {
    const { document, bar, track, text, tl, dispose } = await mount(3);
    expect(document.documentElement.classList.contains("has-timeline")).toBe(true);
    // Three levels, three bands, each numbered.
    expect(text(".timeline-band")).toEqual(["7", "8", "9"]);
    expect([...bar.querySelectorAll(".timeline-mark")].map((m) => m.className)).toEqual([
      "timeline-mark level",
      "timeline-mark boss",
      "timeline-mark level",
      "timeline-mark death",
    ]);
    expect((bar.querySelector(".timeline-mark.boss") as HTMLElement).style.left).toBe("50.000%");
    // What the feed holds, under the bar: the run's last tenth.
    expect((bar.querySelector(".timeline-feed") as HTMLElement).style.left).toBe("90.000%");
    expect(text(".timeline-axis > span")).toEqual(["0", "30m", "1h", "1h 30m", "2h", "2h 30m"]);
    // An ended run opens at its end, with nothing to follow and nothing to zoom.
    expect(text(".timeline-clock")).toEqual(["3:00:00 / 3:00:00"]);
    expect(track.getAttribute("role")).toBe("slider");
    expect(track.getAttribute("aria-valuenow")).toBe(String(T0 + 3 * HOUR));
    expect(bar.querySelector(".timeline-live")).toBeNull();
    expect(bar.querySelector('[aria-label="zoom in"]')).toBeNull();
    expect((bar.querySelector(".timeline-head") as HTMLElement).style.left).toBe("100.000%");
    expect(tl.at()).toBe(T0 + 3 * HOUR);
    dispose();
    expect(document.documentElement.classList.contains("has-timeline")).toBe(false);
  });

  test("a press on the bar seeks there, a press beside a mark lands on it, and a drag scrubs", async () => {
    const { bar, tl, pointer, text, dispose } = await mount(3);
    pointer("pointerdown", 250);
    expect(tl.at()).toBe(T0 + 0.75 * HOUR);
    expect(tl.origin()).toBe("timeline");
    expect(text(".timeline-clock")).toEqual(["45:00 / 3:00:00"]);
    expect((bar.querySelector(".timeline-head") as HTMLElement).style.left).toBe("25.000%");
    expect((bar.querySelector(".timeline-played") as HTMLElement).style.width).toBe("25.000%");
    pointer("pointermove", 600);
    expect(tl.at()).toBe(T0 + 1.8 * HOUR);
    pointer("pointerup", 600);
    // Three pixels off the boss kill at the half: the kill itself.
    pointer("pointerdown", 503);
    expect(tl.at()).toBe(T0 + 1.5 * HOUR);
    pointer("pointerup", 503);
    // A move with no button down is a hover, not a scrub.
    pointer("pointermove", 100);
    expect(tl.at()).toBe(T0 + 1.5 * HOUR);
    dispose();
  });

  test("space plays, the arrows step from mark to mark, Home and End go to the ends; a key in a control is the control's", async () => {
    const { document, bar, tl, key, dispose } = await mount(3);
    key("Home");
    expect(tl.at()).toBe(T0);
    key("ArrowRight");
    expect(tl.at()).toBe(T0 + HOUR);
    key("l");
    expect(tl.at()).toBe(T0 + 1.5 * HOUR);
    key("ArrowLeft");
    expect(tl.at()).toBe(T0 + HOUR);
    key(" ");
    expect(tl.playing()).toBe(true);
    expect(bar.querySelector(".tbtn.play")!.getAttribute("aria-label")).toBe("pause");
    key("k");
    expect(tl.playing()).toBe(false);
    key("End");
    expect(tl.at()).toBe(T0 + 3 * HOUR);
    expect((bar.querySelector('[aria-label="next mark"]') as HTMLButtonElement).disabled).toBe(true);
    // Space on a button is that button's.
    const ev = new win!.Event("keydown", { bubbles: true, cancelable: true }) as unknown as Record<string, unknown>;
    Object.assign(ev, { key: " " });
    bar.querySelector(".tbtn.speed")!.dispatchEvent(ev as unknown as Event);
    expect(tl.playing()).toBe(false);
    expect(document.documentElement.classList.contains("has-timeline")).toBe(true);
    dispose();
  });

  test("a live run is followed until the reader seeks back; the live button takes hold again", async () => {
    const { bar, tl, setSpan, pointer, text, dispose } = await mount(3, true);
    const live = (): HTMLElement => bar.querySelector(".timeline-live") as HTMLElement;
    expect(text(".timeline-live")).toEqual(["live"]);
    expect(live().getAttribute("aria-pressed")).toBe("true");
    // The edge moves on under a reader who follows it.
    setSpan({ from: T0, to: T0 + 4 * HOUR });
    expect(text(".timeline-clock")).toEqual(["4:00:00 / 4:00:00"]);
    pointer("pointerdown", 500);
    pointer("pointerup", 500);
    expect(tl.following()).toBe(false);
    expect(text(".timeline-live")).toEqual(["go live"]);
    expect(live().getAttribute("aria-pressed")).toBe("false");
    setSpan({ from: T0, to: T0 + 5 * HOUR });
    expect(text(".timeline-clock")).toEqual(["2:00:00 / 5:00:00"]);
    live().click();
    expect(tl.following()).toBe(true);
    expect(text(".timeline-clock")).toEqual(["5:00:00 / 5:00:00"]);
    dispose();
  });

  test("a run of days can be zoomed: the buttons, an overview of the whole run while zoomed, and fit", async () => {
    const { bar, tl, text, pointer, dispose } = await mount(96);
    expect(text(".timeline-clock")).toEqual(["4d 00:00 / 4d 00:00"]);
    expect(text(".timeline-axis > span")).toEqual(["0", "12h", "1d", "1d 12h", "2d", "2d 12h", "3d", "3d 12h"]);
    const zoomIn = bar.querySelector('[aria-label="zoom in"]') as HTMLElement;
    expect(zoomIn).not.toBeNull();
    expect(bar.querySelector(".timeline-overview")).toBeNull();
    expect(text(".timeline-end .playbar-btn")).toEqual([]);
    tl.seek(T0 + 48 * HOUR, "timeline");
    zoomIn.click();
    zoomIn.click();
    const view = tl.view()!;
    expect(view.to - view.from).toBeLessThan(96 * HOUR);
    expect(view.from).toBeLessThan(T0 + 48 * HOUR);
    expect(view.to).toBeGreaterThan(T0 + 48 * HOUR);
    expect(bar.querySelector(".timeline-track")!.classList.contains("zoomed")).toBe(true);
    // The whole run above the bar, with the part on screen marked; a press on it moves the view there.
    const overview = bar.querySelector(".timeline-overview") as HTMLElement;
    expect(overview).not.toBeNull();
    overview.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1000, bottom: 8, width: 1000, height: 8, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    pointer("pointerdown", 0, overview);
    expect(tl.view()!.from).toBe(T0);
    // …and it did not scrub: the focus is where it was.
    expect(tl.at()).toBe(T0 + 48 * HOUR);
    // Only the marks in view are drawn: the first level, at 32 h, is; the death at 80 h is not.
    expect([...bar.querySelectorAll(".timeline-mark")].map((m) => m.className)).not.toContain("timeline-mark death");
    expect(text(".timeline-end .playbar-btn")).toEqual(["fit"]);
    (bar.querySelector(".timeline-end .playbar-btn") as HTMLElement).click();
    expect(tl.view()).toBeNull();
    expect(bar.querySelector(".timeline-overview")).toBeNull();
    dispose();
  });
});

describe("the bar across what a page puts it through", () => {
  test("a span that comes, goes and comes back (the map's route swap) redraws without a throw; one reading has nothing to scrub", async () => {
    const document = installDom();
    const entry = await load();
    const host = document.createElement("div");
    document.body.append(host);
    let setSpan!: (s: Span | null) => void;
    let tl!: TimelineStore;
    const dispose = render(() => {
      const [span, set] = entry.createSignal<Span | null>(null);
      setSpan = (s) => void set(s);
      tl = entry.createTimeline({ span, external: true });
      return createComponent(entry.Timeline, { store: tl, marks: marksFor(3), startLevel: 7 });
    }, host);
    const bar = host.querySelector(".timeline")!;
    const play = (): HTMLButtonElement => bar.querySelector(".tbtn.play") as HTMLButtonElement;
    // Before the track lands: the bar is there, empty and inert.
    expect(play().disabled).toBe(true);
    expect(bar.querySelector(".timeline-track")!.classList.contains("off")).toBe(true);
    expect(bar.querySelectorAll(".timeline-band, .timeline-mark, .timeline-head")).toHaveLength(0);
    expect(bar.querySelector(".timeline-clock")!.textContent).toBe("—");

    expect(() => setSpan({ from: T0, to: T0 + 3 * HOUR })).not.toThrow();
    tl.seek(T0 + HOUR, "url");
    expect(play().disabled).toBe(false);
    expect(bar.querySelectorAll(".timeline-band")).toHaveLength(3);
    expect(bar.querySelector(".timeline-clock")!.textContent).toBe("1:00:00 / 3:00:00");

    // The swap: the cursor is zeroed and the span goes away, write by write, as `clearReplayState` does it.
    expect(() => {
      tl.seek(0, "clock");
      tl.setPlaying(false);
      setSpan(null);
    }).not.toThrow();
    expect(play().disabled).toBe(true);
    expect(bar.querySelectorAll(".timeline-band, .timeline-mark, .timeline-head")).toHaveLength(0);

    // A track with one reading: a span with no length, and nothing to play or scrub.
    expect(() => setSpan({ from: T0, to: T0 })).not.toThrow();
    expect(play().disabled).toBe(true);
    expect(bar.querySelector(".timeline-track")!.getAttribute("tabindex")).toBe("-1");
    dispose();
  });

  test("a page's own steps and seek replace the bar's: the map steps by sample and remembers a scrub", async () => {
    const document = installDom();
    const entry = await load();
    const host = document.createElement("div");
    document.body.append(host);
    const calls: string[] = [];
    let tl!: TimelineStore;
    const dispose = render(() => {
      const [span] = entry.createSignal<Span | null>({ from: T0, to: T0 + 3 * HOUR });
      tl = entry.createTimeline({ span, external: true });
      return createComponent(entry.Timeline, {
        store: tl,
        playing: true,
        onSeek: (ts: number) => void calls.push(`seek ${ts - T0}`),
        onToggle: () => void calls.push("toggle"),
        steps: { back: () => void calls.push("back"), forward: () => void calls.push("forward"), canBack: false, canForward: true, noun: "sample" },
      });
    }, host);
    const bar = host.querySelector(".timeline")!;
    expect((bar.querySelector('[aria-label="previous sample"]') as HTMLButtonElement).disabled).toBe(true);
    (bar.querySelector('[aria-label="next sample"]') as HTMLElement).click();
    // The page says something is playing (its video): the button is a pause, and pressing it is the page's.
    (bar.querySelector('[aria-label="pause"]') as HTMLElement).click();
    const key = new win!.Event("keydown", { bubbles: true, cancelable: true }) as unknown as Record<string, unknown>;
    Object.assign(key, { key: "Home" });
    document.dispatchEvent(key as unknown as Event);
    expect(calls).toEqual(["forward", "toggle", "seek 0"]);
    // The store was not moved behind the page's back.
    expect(tl.focus()).toBeNull();
    dispose();
  });
});

describe("the pages that mount it", () => {
  const run = readFileSync(new URL("../src/pages/RunDetail.tsx", import.meta.url), "utf8");
  const replay = readFileSync(new URL("../src/components/Replay.tsx", import.meta.url), "utf8");

  test("the run page has the timeline, and no auto-scroll toggle or video bar beside it", () => {
    expect(run).toContain("<Timeline");
    expect(run).toContain("createTimeline(");
    expect(run).not.toContain("auto-scroll</");
    expect(run).not.toContain("toggleFollow");
    // The camera's player has a frame and a play button, and no bar of its own.
    expect(replay).not.toContain('role="slider"');
    expect(replay).not.toContain("onBar");
  });

  test("the map's replay has the timeline, on its own cursor, and no transport of its own", () => {
    const map = readFileSync(new URL("../src/pages/MapPage.tsx", import.meta.url), "utf8");
    const strip = readFileSync(new URL("../src/components/PlayBar.tsx", import.meta.url), "utf8");
    expect(map).toMatch(/<Show when=\{replayId\(\) !== undefined\}>\s*<Timeline/);
    expect(map).toContain("createTimeline({ span, external: true })");
    expect(map).toContain("const cursor = tl.at;");
    // The keys are the bar's now, on both pages.
    expect(map).not.toContain("playbackKey");
    expect(strip).not.toContain('type="range"');
    expect(strip).not.toContain("tbtn");
    expect(readFileSync(new URL("../src/styles.css", import.meta.url), "utf8")).not.toContain(".scrubber");
    // Both ways out of a replay carry the cursor's time.
    expect(map).toContain("withT(runPageHref(p().runId), track() === undefined ? null : tl.focus())");
  });

  test("publicly, a focus outside the one published window puts the feed away for a status line and never blocks the seek", () => {
    expect(run).toMatch(/const feedAway = createMemo\(\(\): boolean => \{\s*const f = tl\.focus\(\);\s*return SNAPSHOT_MODE && f !== null && entries\(\)\.length > 0 && feedPlan\(held\(\), f\) === "load";/);
    expect(run).toContain('<p class="dim feed-seam">trajectory logs for this period are unavailable</p>');
    // Hidden, not unmounted: what the reader opened is there when the focus comes back.
    expect(run).toContain('<div class="feed" hidden={feedAway()}>');
    expect(readFileSync(new URL("../src/styles.css", import.meta.url), "utf8")).toContain(".feed[hidden] { display: none; }");
  });

  test("the run page's links to the map carry the focused time, and its crumb does not", () => {
    expect(run).toContain("withT(`/map?run=${encodeURIComponent(run().runId)}`, tl.focus())");
    expect(run).toContain("<A href={`/runs${listSearch()}`}>");
  });
});
