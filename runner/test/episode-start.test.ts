/**
 * The start a run plays (operator, 2026-11-15): a level episode's race and
 * class are its id's (e90 a Human Paladin, e360 a Dwarf Paladin), whatever a
 * launch or a roster entry says; a freeplay run may instead let the model
 * choose, told the pairs the server allows at its first launch and again
 * with every pair that cannot be created.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { loadRunConfig } from "../src/config";
import { EPISODES, episodeStart, startRefusal } from "../src/episodes";
import { chooseCharacterNote, freshCharacterNote, invalidStartNote, resumeSessionNote, validStartsText } from "../src/prompt";
import { chosenStartNote, configFromArgs } from "../src/run";
import { isValidStart, VALID_STARTS } from "../src/starts";
import { mkdirSync } from "node:fs";
import { Trajectory } from "../src/trajectory";
import { readRun } from "../src/run-list";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();
const RUN_TS = join(import.meta.dir, "..", "src", "run.ts");

/** A fresh launch's stderr, refused before anything is written (no module behind it). */
async function refusalOf(extra: string[]): Promise<{ code: number; stderr: string }> {
  const runsDir = tempDir("wb-start-");
  const script = join(runsDir, "stub.json");
  writeFileSync(script, JSON.stringify([{ content: "hi", toolCalls: [] }]));
  const proc = Bun.spawn({
    cmd: [process.execPath, RUN_TS, "--driver", "stub", "--stub", script, "--runs-dir", runsDir, "--module-url", "http://127.0.0.1:9", ...extra],
    cwd: runsDir,
    env: { ...process.env, WRATHBENCH_MODULE_URL: "http://127.0.0.1:9", WRATHBENCH_MODULE_SECRET: undefined },
    stdout: "ignore",
    stderr: "pipe",
  });
  const stderr = await new Response(proc.stderr).text();
  return { code: await proc.exited, stderr };
}

describe("a level episode's start is its id's", () => {
  test("e90 is a Human Paladin and e360 a Dwarf Paladin; no other id fixes one", () => {
    expect(episodeStart("e90")).toEqual({ race: 1, class: 2 });
    expect(episodeStart("e360")).toEqual({ race: 3, class: 2 });
    for (const id of ["freeplay", "probing", "deadmines", "deadmines-solo", "nope", undefined, "constructor"]) expect(episodeStart(id)).toBeUndefined();
    expect(EPISODES.e90.summary).toContain("Human Paladin");
    expect(EPISODES.e360.summary).toContain("Dwarf Paladin");
  });

  test("a launch that states none takes the episode's", () => {
    expect(configFromArgs(["--episode", "e90"])).toMatchObject({ race: 1, class: 2 });
    expect(configFromArgs(["--episode", "e360"])).toMatchObject({ race: 3, class: 2 });
    // Its own restated is no departure.
    expect(configFromArgs(["--episode", "e360", "--race", "3", "--class", "2"])).toMatchObject({ race: 3, class: 2 });
    // Freeplay keeps the launch's, and the default is what it always was.
    expect(configFromArgs(["--episode", "freeplay", "--race", "4", "--class", "11"])).toMatchObject({ race: 4, class: 11 });
    expect(configFromArgs(["--episode", "freeplay"])).toMatchObject({ race: 1, class: 2 });
  });

  test("another race or class on a level episode is refused by name; freeplay and an unnamed episode take it", () => {
    expect(startRefusal("e90", 3, 2)).toBe(
      "--episode e90 starts every model on race 1, class 2, fixed by the episode; --race 3 --class 2 cannot apply to it (a chosen start is a freeplay run's)",
    );
    expect(startRefusal("e360", undefined, 5)).toContain("--race 3 --class 5");
    expect(startRefusal("e90", 1, 2)).toBeNull();
    expect(startRefusal("e90", undefined, undefined)).toBeNull();
    expect(startRefusal("freeplay", 3, 2)).toBeNull();
    expect(startRefusal(undefined, 3, 2)).toBeNull();
  });

  test("run.ts refuses the launch before anything is written", async () => {
    const { code, stderr } = await refusalOf(["--episode", "e90", "--race", "3", "--class", "2"]);
    expect(code).toBe(2);
    expect(stderr).toContain("--episode e90 starts every model on race 1, class 2, fixed by the episode");
  }, 30_000);

  test("a stored run keeps the start it was launched on: a past e90 Dwarf still loads", () => {
    expect(loadRunConfig({ driver: "stub", episode: "e90", race: 3, class: 2 })).toMatchObject({ race: 3, class: 2 });
  });
});

describe("a freeplay run whose model chooses its start", () => {
  test("it is a freeplay run's alone, and one character's", () => {
    expect(() => loadRunConfig({ driver: "stub", episode: "e90", chooseStart: true })).toThrow("a start the model chooses is a freeplay run's; --episode e90 has its own");
    expect(() => loadRunConfig({ driver: "stub", chooseStart: true })).toThrow("--episode (none) has its own");
    expect(() =>
      loadRunConfig({ driver: "stub", episode: "freeplay", chooseStart: true, fanout: { characters: 2, accounts: ["POOL01", "POOL02"] } }),
    ).toThrow("a fan-out run's characters are staged");
    expect(loadRunConfig({ driver: "stub", episode: "freeplay", chooseStart: true }).chooseStart).toBe(true);
  });

  test("the pairs are the 3.3.5a creation screen's, Death Knight left out", () => {
    expect(Object.keys(VALID_STARTS).map(Number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 10, 11]);
    expect(isValidStart(1, 2)).toBe(true);
    expect(isValidStart(3, 3)).toBe(true);
    expect(isValidStart(1, 3)).toBe(false); // a Human Hunter
    expect(isValidStart(6, 8)).toBe(false); // a Tauren Mage
    expect(isValidStart(1, 6)).toBe(false); // a Death Knight
    expect(isValidStart(9, 1)).toBe(false); // the goblin id
    expect(isValidStart("3", 2)).toBe(false);
    expect(validStartsText()).toBe(
      "Classes: 1 Warrior, 2 Paladin, 3 Hunter, 4 Rogue, 5 Priest, 7 Shaman, 8 Mage, 9 Warlock, 11 Druid. " +
        "Races, each with the class ids it may be: 1 Human: 1, 2, 4, 5, 8, 9; 2 Orc: 1, 3, 4, 7, 9; 3 Dwarf: 1, 2, 3, 4, 5; " +
        "4 Night Elf: 1, 3, 4, 5, 11; 5 Undead: 1, 4, 5, 8, 9; 6 Tauren: 1, 3, 7, 11; 7 Gnome: 1, 4, 8, 9; " +
        "8 Troll: 1, 3, 4, 5, 7, 8; 10 Blood Elf: 2, 3, 4, 5, 8, 9; 11 Draenei: 1, 2, 3, 5, 7, 8.",
    );
  });

  test("its launch note says the start is the model's, and how to name it", () => {
    const note = chooseCharacterNote({ taken: ["Bromdir"] });
    expect(note).toBe(
      "name your character: 2-12 letters, no spaces, no three identical letters in a row — pick something you like and be creative, it is yours for the episode. " +
        "Your race and class are yours to choose as well: any pair the server allows, listed below. " +
        'Create the character with `await sdk.createSession({ character: "<your name>", race: <race id>, class: <class id> })` after `await connect()` — ' +
        "the name, race and class are all required, race and class as numeric ids. " +
        "If the server answers `char_create_failed_code_50` the name is already in use: pick a different one and call createSession again. " +
        "These names are already taken on this account and must not be used: Bromdir. " +
        "The game account is assigned and bound for you by the harness — do not pass an account; createSession is issued on the correct one automatically. " +
        validStartsText(),
    );
    // A run that does not opt in is told what it always was.
    expect(freshCharacterNote({ race: 1, class: 2, raceName: "Human", className: "Paladin" })).toContain("Your race and class are not yours to choose");
  });

  test("a resumed run with no character yet is told it chooses again; one with a character is told what it chose", () => {
    const head = { race: 1, class: 2, clock: "5 minutes elapsed", seen: "", raceName: "Human", className: "Paladin" };
    expect(resumeSessionNote({ ...head, character: undefined, chooseStart: true })).toContain(chooseCharacterNote({}));
    expect(resumeSessionNote({ ...head, character: undefined })).toContain("Your race and class are not yours to choose");
    const chosen = resumeSessionNote({ ...head, race: 6, class: 7, raceName: "Tauren", className: "Shaman", character: "Brannoc", chooseStart: true });
    expect(chosen).toContain('name "Brannoc", race 6 (Tauren), class 7 (Shaman)');
  });

  test("a pair no character can have is answered with the pairs, from wherever the snippet left the failure", () => {
    const note = invalidStartNote();
    expect(note).toBe(`That race and class cannot be created. Call createSession again with a pair the server allows. ${validStartsText()}`);
    const res = (over: { error?: string; value?: string; logs?: string[] }) => ({ error: over.error, value: over.value, logs: (over.logs ?? []).map((text) => ({ level: "log" as const, ts: 0, text })) });
    // The server's code for a pair it has no start for, as the SDK renders it.
    expect(chosenStartNote(res({ error: "WrathRequestError: module rejected request: char_create_failed_code_48 (character creation error: …) (HTTP 502)" }))).toBe(note);
    // A class id the server does not know, and a Death Knight without a level-55 character.
    expect(chosenStartNote(res({ error: "module rejected request: char_create_failed_code_49 (HTTP 502)" }))).toBe(note);
    expect(chosenStartNote(res({ value: '{"error":"char_create_failed_code_59"}' }))).toBe(note);
    // The SDK's refusal of a name for an id, and the module's of an id out of range.
    expect(chosenStartNote(res({ logs: ['invalid_race: must be a numeric id 1-11, got "Dwarf"'] }))).toBe(note);
    expect(chosenStartNote(res({ error: "module rejected request: invalid_race_class (HTTP 400)" }))).toBe(note);
    // Anything else is none of its business: a taken name, a success.
    expect(chosenStartNote(res({ error: "module rejected request: char_create_failed_code_50 (that name is already in use) (HTTP 502)" }))).toBeUndefined();
    expect(chosenStartNote(res({ value: "ok" }))).toBeUndefined();
  });
});

describe("what a reader shows of a chosen start", () => {
  test("nothing until the character is seen, then what it chose", () => {
    const runsDir = tempDir("wb-start-view-");
    const runId = "fleet-chooser-freeplay-x-20261115";
    const dir = join(runsDir, runId);
    mkdirSync(dir, { recursive: true });
    const traj = new Trajectory(dir);
    const config = loadRunConfig({ runId, driver: "stub", model: "x/chooser", episode: "freeplay", chooseStart: true });
    traj.writeMeta({ runId, harnessVersion: "0.0.0-test", startedAt: 1, config });
    // The placeholder is never shown as the run's start.
    expect(readRun(runsDir, runId)).toMatchObject({ race: null, class: null, characterLabel: null });
    traj.setCharacter(runId, "Brannoc");
    traj.setStart(runId, 6, 7);
    expect(readRun(runsDir, runId)).toMatchObject({ race: 6, class: 7, characterLabel: "Tauren Shaman" });
    traj.close();
  });
});
