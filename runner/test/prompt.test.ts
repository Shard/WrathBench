import { describe, expect, test } from "bun:test";

import { SYSTEM_PROMPT, freshCharacterNote } from "../src/prompt";

/**
 * The prompt is harness surface, so the facts a run proved models
 * get wrong are pinned here rather than left to a careful re-read. Each case
 * cites the trajectory that made it worth a sentence.
 */
describe("system prompt: the shapes and seams runs proved models get wrong", () => {
  test("state.closest is documented as taking the same criteria object as units()", () => {
    // 4 of 5 models in the 2026-08-22 review called closest({entry}) by
    // analogy with units(filter); the SDK now agrees, and so must the prompt.
    expect(SYSTEM_PROMPT).toContain("state.closest(filter) for the nearest match by distance");
    expect(SYSTEM_PROMPT).toContain("the same criteria object state.units() takes, or a predicate");
  });

  test("the no-match shapes of units() and closest() are stated", () => {
    // Models chained `.distance`/`.guid` off a miss and read the bare V8
    // TypeError as a harness fault (closing fan-out, 2026-08-23).
    expect(SYSTEM_PROMPT).toContain("state.units(...) returns an empty array");
    expect(SYSTEM_PROMPT).toContain("state.closest(...) returns undefined");
  });

  test("self vs units() shapes are spelled out, including the missing maxHealth", () => {
    // qwen read state.self.maxHealth.value, crashed, and ran the rest of the
    // episode blind on its own max HP.
    expect(SYSTEM_PROMPT).toContain("state.self.health.value.current");
    expect(SYSTEM_PROMPT).toContain("there is no state.self.maxHealth");
    expect(SYSTEM_PROMPT).toContain("u.maxHealth, not u.maxHealth.value");
  });

  test("questLog is documented as a plain array, not an observed wrapper", () => {
    // hy3 lost a turn to `state.questLog.value` after the prompt's old
    // "every observed field is { value, seq, ts }" universal.
    expect(SYSTEM_PROMPT).toContain("questLog is a plain array of plain entries");
    expect(SYSTEM_PROMPT).not.toContain("Every observed field on state objects is wrapped");
  });

  test("raw-action ok is documented as dispatched, not succeeded", () => {
    // qwen lost 5 turns to questComplete/questChooseReward answering
    // {"ok":true} while the server silently dropped both.
    expect(SYSTEM_PROMPT).toContain("means the opcode was dispatched, not that it worked");
    expect(SYSTEM_PROMPT).toContain("turnInQuest/acceptQuestFrom over the raw quest actions");
  });

  test("the events surface names off(), the removal models reach for", () => {
    // ox-alpha took 21 uncaught `events.off is not a function` exceptions in
    // one run, each one killing a background routine.
    expect(SYSTEM_PROMPT).toContain("off(opcode, fn)");
  });

  test("questGiver: true is documented as the any-marker shorthand", () => {
    // hy3 passed the boolean spelling six times in one run.
    expect(SYSTEM_PROMPT).toContain('questGiver: true means any marker but "none"');
  });

  test("long moves are named as the thing that does not fit one snippet", () => {
    // 2026-08-23 navigation fan-out: 6 of 7 runs hit the 30s abandon with a
    // moveTo in flight; nav-probe-c4 re-issued the identical blocking call to
    // one coordinate five times.
    expect(SYSTEM_PROMPT).toContain("a move of more than roughly 200y cannot finish inside one snippet");
    expect(SYSTEM_PROMPT).toContain("await sdk.moveToAsync(target)");
  });

  test("moveTo is documented as taking a unit or guid, with a typed miss", () => {
    // 4 of 7 runs in the same fan-out threw a raw TypeError reading .x off a
    // unit lookup that found nothing.
    expect(SYSTEM_PROMPT).toContain("moveTo and moveToAsync take a unit or a guid as well as a point");
    expect(SYSTEM_PROMPT).toContain('status: "unknown_target"');
  });

  test("tools are distinguished from ambient snippet objects", () => {
    // laguna and hy3 called write_scratchpad(...) / search_reference(...) as
    // bare globals inside snippets.
    expect(SYSTEM_PROMPT).toContain("Tools and ambient objects are different things");
    expect(SYSTEM_PROMPT).toContain("is a ReferenceError");
  });
});

describe("episode sentence", () => {
  const { buildSystemPrompt, episodeSection, GOAL_SECTION, objectiveSection } = require("../src/prompt");
  test("no episode and no objective is byte-identical to SYSTEM_PROMPT", () => {
    expect(buildSystemPrompt()).toBe(SYSTEM_PROMPT);
    expect(buildSystemPrompt(undefined, "freeplay")).toBe(SYSTEM_PROMPT);
  });
  test("e90 states the clock and the promotion bar; e360 only the clock", () => {
    expect(episodeSection("e90")).toContain("90 minutes");
    expect(episodeSection("e90")).toContain("level 5");
    expect(episodeSection("e360")).toBe("This episode lasts six hours.");
    expect(episodeSection("freeplay")).toBeUndefined();
  });
  test("the sentence sits after the goal and before the objective block", () => {
    const p = buildSystemPrompt("walk to Ironforge", "e90");
    const goal = p.indexOf(GOAL_SECTION);
    const tier = p.indexOf(episodeSection("e90"));
    const obj = p.indexOf(objectiveSection("walk to Ironforge"));
    expect(goal).toBe(0);
    expect(tier).toBeGreaterThan(goal);
    expect(obj).toBeGreaterThan(tier);
  });
});

describe("the fresh-launch session note (the model names its character)", () => {
  const note = (taken: string[] = []) => freshCharacterNote({ character: "Fleetsonnet", race: 1, class: 2, taken });

  test("invites the model to name the character, in the game's own naming rules", () => {
    expect(note()).toContain("name your character");
    expect(note()).toContain("2-12 letters, no spaces, no three identical letters in a row");
    expect(note()).toContain("it is yours for the episode");
  });

  test("the roster name is offered as a suggestion, not as an assignment", () => {
    expect(note()).toContain('"Fleetsonnet" is the harness\'s suggestion');
    expect(note()).not.toContain("your assigned character");
    expect(note()).not.toContain("Use exactly these values");
  });

  test("race and class stay fixed — they are the episode's comparability dimensions", () => {
    expect(note()).toContain("race and class are not yours to choose");
    expect(note()).toContain("race 1, class 2");
    expect(note()).toContain('createSession({ character: "<your name>", race: 1, class: 2 })');
  });

  test("a taken name is a retry the note names in advance", () => {
    expect(note()).toContain("char_create_failed_code_50");
    expect(note()).toContain("pick a different one");
  });

  test("survivors episode hygiene could not clear are named, because createSession reuses them", () => {
    expect(note(["Grimjaw", "Zeliana"])).toContain("already taken on this account and must not be used: Grimjaw, Zeliana");
    expect(note()).not.toContain("must not be used");
  });

  test("the model is still never told the account", () => {
    expect(note()).toContain("do not pass an account");
  });
});
