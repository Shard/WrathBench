/**
 * How a model is drawn when it is the row: a family's mark, or a monogram.
 * Which family an id belongs to is the catalogue's (infra/model-catalogue.test.ts);
 * this pins the drawing side over it.
 */

import { describe, expect, test } from "bun:test";
import { iconModels, monogramOf } from "../src/lib/modelmark";

describe("the monogram", () => {
  test("the first alphanumeric, uppercased", () => {
    expect(monogramOf("stealth/ox-alpha")).toBe("S");
    expect(monogramOf("hy3-free")).toBe("H");
    expect(monogramOf("x-preview-f-free")).toBe("X");
    expect(monogramOf("-2-lane")).toBe("2");
  });

  test("nothing to letter is a question mark, never an empty badge", () => {
    expect(monogramOf("")).toBe("?");
    expect(monogramOf("  /-  ")).toBe("?");
  });
});

describe("a job's icons", () => {
  test("one icon per family: a rotation of two Claude models shows one Claude", () => {
    expect(iconModels(["opus", "sonnet"])).toEqual(["opus"]);
    expect(iconModels(["opus", "openai/gpt-5.6-luna", "google/gemini-3.7-flash"])).toEqual([
      "opus",
      "openai/gpt-5.6-luna",
    ]);
  });

  test("unmatched ids drop out as soon as anything is recognised", () => {
    // `omen-alpha`'s developer is unrevealed, so the catalogue gives it no family.
    expect(iconModels(["omen-alpha", "opus"])).toEqual(["opus"]);
  });

  test("a list nothing matches keeps its first ids, so their monograms still show", () => {
    // Invented ids, beside the one real id with no family.
    expect(iconModels(["omen-alpha", "acme-labs/acme-1", "acme-labs/acme-2"])).toEqual(["omen-alpha", "acme-labs/acme-1"]);
    expect(iconModels([])).toEqual([]);
  });
});
