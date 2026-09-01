import { describe, expect, test } from "bun:test";
import { TOKENS, TURNS, XP, COST, LADDER_VIEWS } from "../src/lib/axes";
import { type FrontStep, paretoFront, paretoSteps } from "../src/lib/pareto";

const p = (k: string, x: number, y: number) => ({ k, x, y });

describe("paretoFront", () => {
  test("drops a row another row beats on both axes", () => {
    const front = paretoFront([p("a", 1, 10), p("b", 2, 5), p("c", 3, 20)]);
    expect(front.map((r) => r.k)).toEqual(["a", "c"]);
  });
  test("keeps ties", () => {
    expect(paretoFront([p("a", 1, 10), p("b", 1, 10)]).map((r) => r.k)).toEqual(["a", "b"]);
  });
  test("a row equal on one axis and worse on the other is dominated", () => {
    expect(paretoFront([p("a", 1, 10), p("b", 1, 9)]).map((r) => r.k)).toEqual(["a"]);
  });
  test("a single row is kept; nothing is nothing", () => {
    expect(paretoFront([p("a", 5, 5)]).map((r) => r.k)).toEqual(["a"]);
    expect(paretoFront([])).toEqual([]);
  });
});

/**
 * A roster where the front is known by hand. Under cost × xp the front is
 * `free` (nothing is cheaper), `mid` (more xp than `free`, less than `dear`
 * for less money) and `dear` (the most xp); `slow` costs more than `mid` for
 * less xp and `waste` costs the most for the least. Under turns × xp the
 * picture changes: `dear` is the quickest and furthest, so it stands alone
 * with `free`, which is still the fewest turns — `mid` spends more turns than
 * `dear` for less xp and drops off.
 */
const roster = [
  { k: "free", cost: 0, turns: 20, xp: 200 },
  { k: "mid", cost: 0.5, turns: 300, xp: 1500 },
  { k: "slow", cost: 0.8, turns: 400, xp: 1200 },
  { k: "dear", cost: 6, turns: 100, xp: 4000 },
  { k: "waste", cost: 20, turns: 500, xp: 100 },
];
const on = (x: "cost" | "turns") => roster.map((r) => ({ k: r.k, x: r[x], y: r.xp }));

/** Each segment is a run along x or a rise along y, never a slope, and each moves x worse and y better. */
function expectStaircase(steps: readonly FrontStep[], better: { x: "lower" | "higher"; y: "lower" | "higher" }): void {
  for (const s of steps) {
    const horizontal = s.y1 === s.y2 && s.x1 !== s.x2;
    const vertical = s.x1 === s.x2 && s.y1 !== s.y2;
    expect(horizontal || vertical).toBe(true);
    if (horizontal) expect(better.x === "lower" ? s.x2 > s.x1 : s.x2 < s.x1).toBe(true);
    if (vertical) expect(better.y === "higher" ? s.y2 > s.y1 : s.y2 < s.y1).toBe(true);
  }
  // …and they chain: each begins where the last ended.
  for (let i = 1; i < steps.length; i++) {
    expect(steps[i]!.x1).toBe(steps[i - 1]!.x2);
    expect(steps[i]!.y1).toBe(steps[i - 1]!.y2);
  }
}

describe("paretoSteps", () => {
  test("cost × xp: the front in walking order, and a staircase through it", () => {
    const better = { x: COST.better, y: XP.better };
    const { front, steps } = paretoSteps(on("cost"), better);
    expect(front.map((p) => p.k)).toEqual(["free", "mid", "dear"]);
    expect(steps).toEqual([
      { x1: 0, y1: 200, x2: 0.5, y2: 200 },
      { x1: 0.5, y1: 200, x2: 0.5, y2: 1500 },
      { x1: 0.5, y1: 1500, x2: 6, y2: 1500 },
      { x1: 6, y1: 1500, x2: 6, y2: 4000 },
    ]);
    expectStaircase(steps, better);
  });

  test("turns × xp: the same roster, a different front, read off the specs", () => {
    const better = { x: TURNS.better, y: XP.better };
    const { front, steps } = paretoSteps(on("turns"), better);
    expect(front.map((p) => p.k)).toEqual(["free", "dear"]);
    expect(steps).toEqual([
      { x1: 20, y1: 200, x2: 100, y2: 200 },
      { x1: 100, y1: 200, x2: 100, y2: 4000 },
    ]);
    expectStaircase(steps, better);
  });

  test("a view with 'better' the other way walks the other way: the mirrored roster gives the mirrored staircase", () => {
    const better = { x: "higher", y: "lower" } as const;
    const mirrored = on("cost").map((r) => ({ k: r.k, x: -r.x, y: -r.y }));
    const { front, steps } = paretoSteps(mirrored, better);
    expect(front.map((r) => r.k)).toEqual(["free", "mid", "dear"]);
    expect(steps).toEqual(paretoSteps(on("cost")).steps.map((s) => ({ x1: -s.x1, y1: -s.y1, x2: -s.x2, y2: -s.y2 })));
    expectStaircase(steps, better);
    // And read the wrong way round, the same points leave one survivor: the dearest for the least.
    expect(paretoSteps(on("cost"), better).front.map((r) => r.k)).toEqual(["waste"]);
  });

  test("ties share a tread and add no segment; one entry is a front with no steps", () => {
    const { front, steps } = paretoSteps([p("a", 1, 10), p("b", 1, 10), p("c", 3, 20)]);
    expect(front.map((r) => r.k)).toEqual(["a", "b", "c"]);
    expect(steps).toEqual([
      { x1: 1, y1: 10, x2: 3, y2: 10 },
      { x1: 3, y1: 10, x2: 3, y2: 20 },
    ]);
    expect(paretoSteps([p("only", 2, 2)])).toEqual({ front: [p("only", 2, 2)], steps: [] });
    expect(paretoSteps([])).toEqual({ front: [], steps: [] });
  });

  test("every offered view's front reads less x, more y", () => {
    for (const v of LADDER_VIEWS) {
      expect(v.x.better).toBe("lower");
      expect(v.y.better).toBe("higher");
    }
    expect(TOKENS.better).toBe("lower");
  });
});
