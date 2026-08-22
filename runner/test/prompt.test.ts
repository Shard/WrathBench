import { describe, expect, test } from "bun:test";

import { SYSTEM_PROMPT } from "../src/prompt";

/**
 * The prompt is harness surface (ADR-0004), so the facts a run proved models
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

  test("tools are distinguished from ambient snippet objects", () => {
    // laguna and hy3 called write_scratchpad(...) / search_reference(...) as
    // bare globals inside snippets.
    expect(SYSTEM_PROMPT).toContain("Tools and ambient objects are different things");
    expect(SYSTEM_PROMPT).toContain("is a ReferenceError");
  });
});
