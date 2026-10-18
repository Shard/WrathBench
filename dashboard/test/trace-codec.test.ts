/**
 * The trace codec is one of the viewer modules the dashboard imports at
 * runtime over the `@viewer/*` alias (`vite.config.ts`), not only for types:
 * the player decodes segments in the browser. This pins that the alias reaches
 * it under the dashboard's own resolution and that a segment the viewer encodes
 * decodes here. The codec's behaviour is tested beside it, in
 * `runner/test/trace.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import { SEG_MS, decodeSegment, encodeSegment, sampleAt, stateAt } from "@viewer/trace";

describe("@viewer/trace", () => {
  test("resolves at runtime and round-trips a segment", () => {
    const t0 = 1_760_000_100_000;
    const seg = encodeSegment(
      [
        { ts: t0, kind: "key", map: 0, x: 0, y: 0, z: 0, o: 0, data: JSON.stringify({ hp: 10, hpMax: 10 }) },
        { ts: t0 + 1000, kind: "pos", map: 0, x: 7, y: 0, z: 0, o: 0, data: null },
        { ts: t0 + 1000, kind: "state", map: null, x: null, y: null, z: null, o: null, data: JSON.stringify({ hp: 8 }) },
      ],
      { run: "r", t0, t1: t0 + SEG_MS },
    );
    const back = decodeSegment(JSON.parse(JSON.stringify(seg)));
    expect(sampleAt(back.frames, t0 + 500)?.x).toBeCloseTo(3.5, 6);
    expect(stateAt(back, t0 + 1000).hp).toBe(8);
  });
});
