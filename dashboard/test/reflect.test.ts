import { describe, expect, test } from "bun:test";
import type { CharacterStatus } from "@viewer/api-types";
import { REST_PERIOD_MS, REST_RISE_PX, restPhase, statusStamp } from "../src/lib/reflect";

const status = (o: Partial<CharacterStatus>): CharacterStatus => ({
  turn: 1,
  level: null,
  zone: null,
  text: "",
  ts: 0,
  ...o,
});

describe("statusStamp", () => {
  test("reads the way read_log prints it to the model", () => {
    expect(statusStamp(status({ turn: 12, level: 4, zone: "Kharanos" }))).toBe("turn 12 · L4 · Kharanos");
  });

  test("an unobserved stamp is a question mark, never a dropped field", () => {
    expect(statusStamp(status({ turn: 3 }))).toBe("turn 3 · L? · ?");
    expect(statusStamp(status({ turn: 3, level: 1, zone: "" }))).toBe("turn 3 · L1 · ?");
  });
});

describe("restPhase", () => {
  test("the glyph rises and falls back within the period", () => {
    expect(restPhase(0).rise).toBeCloseTo(0, 6);
    expect(restPhase(REST_PERIOD_MS / 2).rise).toBeCloseTo(REST_RISE_PX, 6);
    expect(restPhase(REST_PERIOD_MS).rise).toBeCloseTo(0, 6);
  });

  test("it is a loop, not a saw: the period repeats and never leaves the band", () => {
    for (const t of [0, 137, 900, 1731, 2599]) {
      expect(restPhase(t + 10 * REST_PERIOD_MS).rise).toBeCloseTo(restPhase(t).rise, 6);
      const { rise, alpha } = restPhase(t);
      expect(rise).toBeGreaterThanOrEqual(0);
      expect(rise).toBeLessThanOrEqual(REST_RISE_PX);
      expect(alpha).toBeGreaterThan(0.4);
      expect(alpha).toBeLessThanOrEqual(0.9);
    }
  });

  test("reduced motion still draws the glyph — it stops moving, it does not vanish", () => {
    const a = restPhase(0, true);
    const b = restPhase(REST_PERIOD_MS / 2, true);
    expect(a).toEqual(b);
    expect(a.alpha).toBeGreaterThan(0.5);
  });
});
