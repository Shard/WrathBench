import { describe, expect, test } from "bun:test";
import { paretoFront } from "../src/lib/pareto";

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
