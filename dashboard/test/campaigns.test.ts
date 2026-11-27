/**
 * The campaigns page's figures, over a fixture `/api/campaigns` body
 * (`fixtures/campaigns.ts`): squares matched to their arms by key, what a
 * square says once the cap or a refusal settled it, a bill never mixed with an
 * estimate, and an arm with no runs never dressed as a median. One source check
 * closes the file: the page must not lean on what the public projection omits.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CampaignView, Square } from "../../viewer/api-types-evals";
import { armRowText, gridRows, squareClass, squareHref, squareText, squareTitle } from "../src/lib/campaigns";
import { CAMPAIGNS } from "./fixtures/campaigns";

const WAKE: CampaignView = CAMPAIGNS.campaigns[0]!;

describe("the grid", () => {
  test("rows keep the definition's cell order and match squares by column key, not position", () => {
    const rows = gridRows(WAKE);
    expect(rows.map((r) => [r.cell.id, r.start])).toEqual([
      ["north", "Dwarf Warrior"],
      ["south", "Orc Warrior"],
      ["east", "Blood Elf Rogue"],
    ]);
    // `south` was served out of order; its first column is still sonnet-low|control.
    expect(rows[1]!.squares.map((s) => s?.column)).toEqual(WAKE.columns.map((c) => c.key));
    expect(rows[1]!.squares[0]!.mismatchedStart).toBe(1);
    // `east` has no row: four gaps.
    expect(rows[2]!.squares).toEqual([null, null, null, null]);
  });
});

describe("a square", () => {
  const rows = gridRows(WAKE);
  const [reached] = rows[0]!.squares;
  const [, capped, , refused] = rows[1]!.squares as [Square, Square, Square, Square];

  test("runs nobody billed add their estimate beside the bill, never into it (operator, 2026-11-18)", () => {
    const sq = { ...reached!, costUsd: null, estimatedUsd: 0.42 };
    expect(squareTitle(sq, "L5")).toContain("best L5 · ~$0.420 estimated where no bill was reported · 1 counted run wanted");
    expect(squareTitle({ ...reached!, estimatedUsd: 0.5 }, "L5")).toContain("$1.25 billed · ~$0.500 estimated where no bill was reported");
    // A square from a snapshot that predates it, or with nothing priced, says nothing of it.
    expect(squareTitle({ ...reached!, estimatedUsd: null }, "L5")).not.toContain("estimated");
  });

  test("a square that spent its attempts without a counted run says capped, and is still a way into its runs", () => {
    expect(squareText(capped, "L5")).toBe("capped");
    expect(squareClass(capped, "L5")).toBe("right mono dim");
    expect(squareTitle(capped, "L5")).toBe(
      "0 of 0 counted runs reached L5 · best L3 · 2 not counted · capped: its attempts are spent without the counted runs it wanted · 1 counted run wanted\nbuild 0.5-921-gbbbbbbb",
    );
    expect(squareHref(WAKE, "south", capped)).toBe("/campaigns/wake-probe/1?cell=south&column=sonnet-low%7Cwake");
    // Capped with a counted run short of its want keeps its figure.
    expect(squareText({ ...capped, counted: 1 }, "L5")).toBe("0/1");
  });

  test("a refused pair's square says refused, with the reason first in its hover", () => {
    expect(squareText(refused, "L5")).toBe("refused");
    expect(squareClass(refused, "L5")).toBe("right mono err");
    expect(squareTitle(refused, "L5")).toBe("refused: compact window 100k clashes with the arm's --compact-window 50k");
    // One that ran before the refusal keeps its figures, and the hover leads with why.
    const ran = { ...refused, runs: 1, counted: 1, reached: 1, bestLevel: 5 };
    expect(squareText(ran, "L5")).toBe("1/1");
    expect(squareClass(ran, "L5")).toBe("right mono ok");
    expect(squareTitle(ran, "L5").split("\n")[0]).toBe("refused: compact window 100k clashes with the arm's --compact-window 50k");
  });
});

describe("the arm comparison", () => {
  test("per assignment, each arm's medians to the stop level, its endings and its builds", () => {
    const [control, wake] = WAKE.comparison[0]!.arms;
    expect(armRowText(control!)).toEqual({
      runs: "2",
      reached: "2",
      minutes: "47m",
      turns: "213",
      cost: "$1.10*",
      costTitle: "* 2 of the figures behind this median are a subscription's as-if-metered cost, which nobody was billed",
      promptTokens: "1.84M",
      terminations: "level-target 2",
      builds: "0.5-920-gaaaaaaa",
    });
    expect(armRowText(wake!).terminations).toBe("adapter-error 1 · level-target 1");
    // A metered arm's median carries no mark.
    expect([armRowText(wake!).cost, armRowText(wake!).costTitle]).toEqual(["$0.900", ""]);
  });

  test("an arm with no runs reads dashes, not zeros dressed as medians", () => {
    expect(armRowText(WAKE.comparison[1]!.arms[1]!)).toEqual({
      runs: "0",
      reached: "0",
      minutes: "—",
      turns: "—",
      cost: "—",
      costTitle: "",
      promptTokens: "—",
      terminations: "—",
      builds: "—",
    });
  });
});

describe("the page's sources", () => {
  const SRC = join(import.meta.dir, "..", "src");
  const page = readFileSync(join(SRC, "pages", "Campaigns.tsx"), "utf8");
  const lib = readFileSync(join(SRC, "lib", "campaigns.ts"), "utf8");

  test("nothing reads the store row's account, which the public projection omits", () => {
    for (const src of [page, lib]) expect(src).not.toMatch(/\.account\b/);
  });
});
