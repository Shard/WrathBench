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
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLASS_NAMES, RACE_NAMES, className, raceName } from "../../runner/src/characters";
import { readRun } from "../../runner/src/run-list";
import { tempDirs } from "../../runner/test/fixtures/temp-dirs";

const tempDir = tempDirs();

describe("names resolve", () => {
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
});

describe("a run row carries its character", () => {
  function fixture(config: Record<string, unknown>): { runs: string; id: string } {
    const runs = tempDir("viewer-characters-");
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
});
