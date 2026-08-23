/**
 * Race and class as the viewer renders them.
 *
 * Two things are pinned here. The tables are the client's own ids, gaps
 * included — a nine-name list mapped onto 1..9 would label every extras run
 * wrong — and an id no table knows renders as its own number rather than
 * disappearing, which is what keeps "not recorded" (null) distinguishable from
 * "recorded, unrecognised".
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLASS_NAMES, RACE_NAMES, characterLabel, className, raceName } from "../viewer/characters";
import { readRun } from "../viewer/runs";

describe("names resolve", () => {
  test("the ids the extras cycle actually uses", () => {
    expect(raceName(1)).toBe("Human");
    expect(raceName(3)).toBe("Dwarf");
    expect(raceName(4)).toBe("Night Elf");
    expect(raceName(7)).toBe("Gnome");
    expect(className(1)).toBe("Warrior");
    expect(className(2)).toBe("Paladin");
    expect(className(3)).toBe("Hunter");
    expect(className(4)).toBe("Rogue");
    expect(className(5)).toBe("Priest");
    expect(className(8)).toBe("Mage");
    expect(className(9)).toBe("Warlock");
    expect(className(11)).toBe("Druid");
  });

  test("the gaps are where SharedDefines.h puts them", () => {
    // 6 is Death Knight and 7 Shaman — not Shaman and Mage, which is what a
    // nine-name list crammed into 1..9 would claim.
    expect(className(6)).toBe("Death Knight");
    expect(className(7)).toBe("Shaman");
    expect(CLASS_NAMES[10]).toBeUndefined();
    // Race 9 (goblin) is not playable in 3.3.5a; 10 and 11 are.
    expect(RACE_NAMES[9]).toBeUndefined();
    expect(raceName(10)).toBe("Blood Elf");
    expect(raceName(11)).toBe("Draenei");
  });

  test("an unknown id renders the number, and an unrecorded one stays null", () => {
    expect(raceName(9)).toBe("9");
    expect(className(10)).toBe("10");
    expect(raceName(null)).toBeNull();
    expect(className(undefined)).toBeNull();
  });

  test("the label is both halves, one half, or nothing", () => {
    expect(characterLabel(3, 3)).toBe("Dwarf Hunter");
    expect(characterLabel(9, 10)).toBe("9 10");
    expect(characterLabel(4, null)).toBe("Night Elf");
    expect(characterLabel(null, 11)).toBe("Druid");
    expect(characterLabel(null, null)).toBeNull();
  });
});

describe("a run row carries its character", () => {
  function fixture(config: Record<string, unknown>): { runs: string; id: string } {
    const runs = mkdtempSync(join(tmpdir(), "viewer-characters-"));
    const id = "run-1";
    mkdirSync(join(runs, id), { recursive: true });
    writeFileSync(join(runs, id, "meta.json"), JSON.stringify({ runId: id, startedAt: 1000, config }));
    return { runs, id };
  }

  test("race and class come off meta.json's config, resolved", () => {
    const { runs, id } = fixture({ model: "m", character: "Benchy", race: 3, class: 3 });
    const row = readRun(runs, id);
    expect(row.race).toBe(3);
    expect(row.class).toBe(3);
    expect(row.characterLabel).toBe("Dwarf Hunter");
  });

  test("a run whose config predates the fields reads null, and is never back-labeled", () => {
    const { runs, id } = fixture({ model: "m", character: "Benchy" });
    const row = readRun(runs, id);
    expect(row.race).toBeNull();
    expect(row.className).toBeNull();
    expect(row.characterLabel).toBeNull();
  });
});
