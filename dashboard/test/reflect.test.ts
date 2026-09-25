import { describe, expect, test } from "bun:test";
import type { CharacterStatus, EntrySummary, ReflectionWindowView } from "@viewer/api-types";
import type { FeedGroup } from "../src/lib/feedgroup";
import {
  REST_PERIOD_MS,
  REST_RISE_PX,
  groupTurn,
  isReflectTool,
  reflectingAt,
  restPhase,
  statusStamp,
} from "../src/lib/reflect";

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

describe("reflectingAt", () => {
  const windows: ReflectionWindowView[] = [
    { fromTurn: 5, toTurn: 9 },
    { fromTurn: 20, toTurn: null },
  ];

  test("the window is half-open: the opening turn is in, the closing turn is out", () => {
    expect(reflectingAt(windows, 4)).toBe(false);
    expect(reflectingAt(windows, 5)).toBe(true);
    expect(reflectingAt(windows, 8)).toBe(true);
    // The close names the first turn spent acting again.
    expect(reflectingAt(windows, 9)).toBe(false);
  });

  test("a null close runs to the end of the run", () => {
    expect(reflectingAt(windows, 19)).toBe(false);
    expect(reflectingAt(windows, 20)).toBe(true);
    expect(reflectingAt(windows, 9999)).toBe(true);
  });

  test("no windows, and a row with no turn, are never accented", () => {
    expect(reflectingAt(undefined, 6)).toBe(false);
    expect(reflectingAt([], 6)).toBe(false);
    // "We do not know which turn this was" is not "reflecting".
    expect(reflectingAt(windows, undefined)).toBe(false);
    expect(reflectingAt(windows, null)).toBe(false);
  });
});

describe("isReflectTool", () => {
  test("the three tools of the surface, and nothing else", () => {
    for (const n of ["reflect", "log_status", "read_log"]) expect(isReflectTool(n)).toBe(true);
    for (const n of ["run_snippet", "write_file", "search_reference", "", "read_logs"])
      expect(isReflectTool(n)).toBe(false);
    expect(isReflectTool(null)).toBe(false);
    expect(isReflectTool(undefined)).toBe(false);
  });
});

describe("groupTurn", () => {
  const entry = (t: string, turn?: number): EntrySummary =>
    ({ i: 0, t, ts: 0, start: 0, end: 0, ...(turn === undefined ? {} : { turn }) }) as EntrySummary;

  test("each composite shape is asked where it actually keeps the turn", () => {
    expect(groupTurn({ kind: "turn", request: entry("request", 7), events: null } as FeedGroup)).toBe(7);
    expect(groupTurn({ kind: "response", entry: entry("response", 8), latencyMs: null } as FeedGroup)).toBe(8);
    expect(
      groupTurn({
        kind: "call",
        call: entry("tool_call", 9),
        snippet: null,
        result: null,
        durationMs: null,
      } as FeedGroup),
    ).toBe(9);
    expect(groupTurn({ kind: "plain", entry: entry("state", 3) } as FeedGroup)).toBe(3);
  });

  test("a call whose own half is off the window's edge answers from the half that is in", () => {
    expect(
      groupTurn({
        kind: "call",
        call: null,
        snippet: null,
        result: entry("tool_result", 11),
        durationMs: null,
      } as FeedGroup),
    ).toBe(11);
    // Nothing carried a turn: undefined, which reflectingAt reads as no accent.
    expect(
      groupTurn({ kind: "call", call: entry("tool_call"), snippet: null, result: null, durationMs: null } as FeedGroup),
    ).toBeUndefined();
  });
});
