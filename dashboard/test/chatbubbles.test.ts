/**
 * The map's chat bubbles: which lines are up at a playhead, several characters
 * at once, and the trace store handing each line over once across the tail's
 * promotion to a closed window. Every line is invented.
 */

import { describe, expect, test } from "bun:test";
import { CONTEXT_MS, SEG_MS, encodeSegment, type TraceChatLine, type TraceRow } from "@wrathbench/inspector/codec/trace";
import type { TraceSegment } from "../../viewer/api-types";
import { projectTraceSegment } from "../../viewer/public-projection";
import { BUBBLE_MS, bubblesAt } from "@wrathbench/inspector/views/chatbubbles";
import { createTraceStore } from "@wrathbench/inspector/views/traceplayer";

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
});

describe("several speakers", () => {
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
