/**
 * The map's chat bubbles: which lines are up at a playhead, how a long one is
 * cut, several characters at once, and the trace store handing each line over
 * once across the tail's promotion to a closed window. Every line is invented.
 */

import { describe, expect, test } from "bun:test";
import { CONTEXT_MS, SEG_MS, encodeSegment, type TraceChatLine, type TraceRow } from "@viewer/trace";
import type { TraceSegment } from "../../runner/viewer/api-types";
import { projectTraceSegment } from "../../runner/viewer/public-projection";
import {
  BUBBLE_CHARS,
  BUBBLE_GAP_PX,
  BUBBLE_LIFT_PX,
  BUBBLE_MS,
  BUBBLE_STACK,
  bubblesAt,
  clipBubble,
  layoutStacks,
  stacksKey,
  type StackBox,
} from "../src/lib/chatbubbles";
import { createTraceStore } from "../src/lib/traceplayer";

const W = 1_760_000_100_000 - (1_760_000_100_000 % SEG_MS);
const line = (t: number, text: string, kind: TraceChatLine["kind"] = "say"): TraceChatLine => ({ t, kind, text });

describe("a bubble's lifetime, on the playhead's clock", () => {
  const lines = [line(W + 10_000, "pulling"), line(W + 25_000, "on my way", "party")];

  test("up from the moment it was said for BUBBLE_MS, and not before", () => {
    expect(BUBBLE_MS).toBe(30_000);
    expect(bubblesAt("a", lines, W + 9_999)).toEqual([]);
    expect(bubblesAt("a", lines, W + 10_000).map((b) => b.text)).toEqual(["pulling"]);
    expect(bubblesAt("a", lines, W + 25_000).map((b) => b.text)).toEqual(["pulling", "on my way"]);
    expect(bubblesAt("a", lines, W + 39_999).map((b) => b.text)).toEqual(["pulling", "on my way"]);
    expect(bubblesAt("a", lines, W + 40_000).map((b) => b.text)).toEqual(["on my way"]);
    expect(bubblesAt("a", lines, W + 55_000)).toEqual([]);
  });

  test("a replay scrubbed back takes a line down again; scrubbed forward, it is up as if played", () => {
    expect(bubblesAt("a", lines, W + 30_000)).toHaveLength(2);
    expect(bubblesAt("a", lines, W + 5_000)).toHaveLength(0);
    expect(bubblesAt("a", lines, W + 26_000)).toHaveLength(2);
  });

  test("several lines close together stack, newest lowest, and the oldest gives way past BUBBLE_STACK", () => {
    const burst = [1, 2, 3, 4, 5].map((i) => line(W + i * 1_000, `line ${i}`));
    const up = bubblesAt("a", [...burst].reverse(), W + 6_000);
    expect(up).toHaveLength(BUBBLE_STACK);
    expect(up.map((b) => b.text)).toEqual(["line 3", "line 4", "line 5"]);
  });

  test("the same line said twice is two bubbles with two keys; a bubble's key holds while it is up", () => {
    const twice = [line(W + 1_000, "go"), line(W + 2_000, "go")];
    const up = bubblesAt("a", twice, W + 3_000);
    expect(up).toHaveLength(2);
    expect(new Set(up.map((b) => b.key)).size).toBe(2);
    expect(stacksKey([{ runId: "a", bubbles: bubblesAt("a", twice, W + 3_000) }])).toBe(
      stacksKey([{ runId: "a", bubbles: bubblesAt("a", twice, W + 20_000) }]),
    );
    expect(stacksKey([{ runId: "a", bubbles: up }])).not.toBe(stacksKey([{ runId: "a", bubbles: bubblesAt("a", twice, W + 31_500) }]));
  });
});

describe("truncation", () => {
  test("a long line is cut with an ellipsis, and the hover keeps the whole of it with its kind", () => {
    const long = `${"word ".repeat(40)}end`;
    const [b] = bubblesAt("a", [line(W, long, "yell")], W);
    expect(b!.text.length).toBe(BUBBLE_CHARS);
    expect(b!.text.endsWith("…")).toBe(true);
    expect(b!.title).toBe(`yell: ${long}`);
    expect(b!.kind).toBe("yell");
  });

  test("a line that fits is as written; the cut never splits a surrogate pair", () => {
    expect(clipBubble("short")).toBe("short");
    expect(clipBubble("x".repeat(BUBBLE_CHARS))).toBe("x".repeat(BUBBLE_CHARS));
    const emoji = "🐗".repeat(BUBBLE_CHARS + 5);
    const cut = clipBubble(emoji);
    expect([...cut]).toHaveLength(BUBBLE_CHARS);
    expect(cut.endsWith("🐗…")).toBe(true);
  });
});

describe("several speakers", () => {
  const box = (runId: string, sx: number, sy: number, w = 100, h = 20): StackBox => ({ runId, sx, sy, w, h });

  test("a stack sits centred above its pip, its leader running down to the puck", () => {
    const [p] = layoutStacks([box("a", 500, 400)], 1000);
    expect(p).toMatchObject({ runId: "a", x: 450, y: 400 - BUBBLE_LIFT_PX - 20, w: 100, h: 20, leadX: 50 });
    expect(p!.lead).toBeGreaterThan(0);
  });

  test("a party standing together says its lines one above another, each leader still to its own pip", () => {
    const placed = layoutStacks([box("tank", 500, 400), box("healer", 510, 402), box("mage", 495, 398)], 1000);
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const a = placed[i]!;
        const b = placed[j]!;
        const apart = a.x + a.w + BUBBLE_GAP_PX <= b.x || b.x + b.w + BUBBLE_GAP_PX <= a.x || a.y + a.h + BUBBLE_GAP_PX <= b.y || b.y + b.h + BUBBLE_GAP_PX <= a.y;
        expect(apart).toBe(true);
      }
    }
    // The lowest pip keeps its place; the others are lifted, with longer leaders.
    const healer = placed.find((p) => p.runId === "healer")!;
    expect(healer.y).toBe(402 - BUBBLE_LIFT_PX - 20);
    for (const p of placed.filter((x) => x.runId !== "healer")) expect(p.lead).toBeGreaterThan(healer.lead);
    // The order is fixed by position and id, so the same scene lays out the same.
    expect(layoutStacks([box("mage", 495, 398), box("healer", 510, 402), box("tank", 500, 400)], 1000)).toEqual(placed);
  });

  test("a stack never hides another character: a puck in its way lifts it above the puck", () => {
    const puck = { x: 486, y: 330, w: 28, h: 28 };
    const [p] = layoutStacks([box("a", 500, 400)], 1000, [puck]);
    expect(p!.y + p!.h + BUBBLE_GAP_PX).toBeLessThanOrEqual(puck.y);
    expect(p!.lead).toBeGreaterThan(puck.h);
    // Its own puck, below the stack, moves nothing.
    expect(layoutStacks([box("a", 500, 400)], 1000, [{ x: 486, y: 386, w: 28, h: 28 }])).toEqual(layoutStacks([box("a", 500, 400)], 1000));
  });

  test("characters far apart are not moved; a stack at the stage's edge stays on it, its leader still on the pip", () => {
    const [a, b] = layoutStacks([box("a", 100, 400), box("b", 900, 400)], 1000);
    expect(a!.y).toBe(b!.y);
    const [edge] = layoutStacks([box("e", 10, 300)], 1000);
    expect(edge!.x).toBe(BUBBLE_GAP_PX);
    expect(edge!.leadX).toBe(10 - BUBBLE_GAP_PX);
  });

  test("each character's lines are its own: one store, two runs, two stacks", () => {
    const store = createTraceStore();
    const rows = (x: number, said: string): TraceRow[] => [
      { ts: W, kind: "key", map: 0, x, y: 0, z: 0, o: 0, data: JSON.stringify({ hp: 1 }) },
      { ts: W + 1_000, kind: "state", map: null, x: null, y: null, z: null, o: null, data: JSON.stringify({ chat: [["party", said]] }) },
    ];
    store.setTail("tank", encodeSegment(rows(0, "pulling"), { run: "tank", t0: W, t1: W + SEG_MS }));
    store.setTail("mage", encodeSegment(rows(5, "sheeping the left one"), { run: "mage", t0: W, t1: W + SEG_MS }));
    const t = W + 2_000;
    expect(bubblesAt("tank", store.chat("tank", t - BUBBLE_MS, t), t).map((b) => b.text)).toEqual(["pulling"]);
    expect(bubblesAt("mage", store.chat("mage", t - BUBBLE_MS, t), t).map((b) => b.text)).toEqual(["sheeping the left one"]);
  });
});

describe("the store's lines", () => {
  /** A minute of walking either side of a window boundary, with a line every 10 s. */
  const rows: TraceRow[] = [];
  for (let t = W - SEG_MS; t < W + SEG_MS; t += 1_000) {
    if (t % SEG_MS === 0) rows.push({ ts: t, kind: "key", map: 0, x: 0, y: 0, z: 0, o: 0, data: JSON.stringify({ hp: 1 }) });
    rows.push({ ts: t, kind: "pos", map: 0, x: (t - W) / 1000, y: 0, z: 0, o: 0, data: null });
    if (t % 10_000 === 0) rows.push({ ts: t, kind: "state", map: null, x: null, y: null, z: null, o: null, data: JSON.stringify({ chat: [["say", `at ${t - W}`]] }) });
  }
  const seg = (t0: number, t1 = t0 + SEG_MS): TraceSegment =>
    JSON.parse(JSON.stringify(encodeSegment(rows.filter((r) => r.ts >= t0 - CONTEXT_MS && r.ts < t1), { run: "a", t0, t1 }))) as TraceSegment;

  test("a bubble said just before a window boundary stays up across it", async () => {
    const store = createTraceStore();
    store.list("a", SEG_MS, [W - SEG_MS, W]);
    await store.load("a", W - SEG_MS, async () => seg(W - SEG_MS));
    await store.load("a", W, async () => seg(W));
    const t = W + 15_000;
    expect(bubblesAt("a", store.chat("a", t - BUBBLE_MS, t), t).map((b) => b.text)).toEqual(["at -10000", "at 0", "at 10000"]);
  });

  test("a window seen in the tail and then closed hands each line over once", async () => {
    const store = createTraceStore();
    store.setTail("a", seg(W - SEG_MS, W + SEG_MS));
    store.list("a", SEG_MS, [W - SEG_MS]);
    await store.load("a", W - SEG_MS, async () => seg(W - SEG_MS));
    store.setTail("a", seg(W));
    const got = store.chat("a", W - 60_000, W + 60_000).map((c) => c.text);
    expect(got).toEqual(["at -50000", "at -40000", "at -30000", "at -20000", "at -10000", "at 0", "at 10000", "at 20000", "at 30000", "at 40000", "at 50000", "at 60000"]);
  });

  test("the public projection's segment plays the same lines", () => {
    const store = createTraceStore();
    store.setTail("a", projectTraceSegment(seg(W)));
    expect(store.chat("a", W, W + 25_000).map((c) => c.text)).toEqual(["at 10000", "at 20000"]);
  });
});
