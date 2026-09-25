import { describe, expect, test } from "bun:test";

import {
  CLAUDE_CODE_SYSTEM_PROMPT,
  STATE_KEPT_AND_LOST,
  SYSTEM_PROMPT,
  buildSystemPrompt,
  contextSentence,
  freshCharacterNote,
  resumeSessionNote,
  continuedSessionNote,
} from "../src/prompt";
import { REFLECTION_PROMPT } from "../src/reflect";
import { STATE_LOSS_RECOVERY, STATE_RESET_NOTICE } from "../src/sandbox/host";
import { TOOLS } from "../src/tools";

/**
 * The prompt is harness surface, so the facts a run proved models
 * get wrong are pinned here rather than left to a careful re-read. Each case
 * says what the runs got wrong that made it worth a sentence.
 */
describe("system prompt: the shapes and seams runs proved models get wrong", () => {
  test("state.closest is documented as taking the same criteria object as units()", () => {
    // 4 of 5 models in one review called closest({entry}) by
    // analogy with units(filter); the SDK now agrees, and so must the prompt.
    expect(SYSTEM_PROMPT).toContain("state.closest(filter) for the nearest match by distance");
    expect(SYSTEM_PROMPT).toContain("the same criteria object state.units() takes, or a predicate");
  });

  test("the no-match shapes of units() and closest() are stated", () => {
    // Models chained `.distance`/`.guid` off a miss and read the bare V8
    // TypeError as a harness fault (a closing fan-out).
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
    // A navigation fan-out: 6 of 7 runs hit the 30s abandon with a moveTo in
    // flight, and one re-issued the identical blocking call to one coordinate
    // five times.
    expect(SYSTEM_PROMPT).toContain("a move of more than roughly 200y cannot finish inside one snippet");
    expect(SYSTEM_PROMPT).toContain("await sdk.moveToAsync(target)");
  });

  test("moveTo is documented as taking a unit or guid, with a typed miss", () => {
    // 4 of 7 runs in the same fan-out threw a raw TypeError reading .x off a
    // unit lookup that found nothing.
    expect(SYSTEM_PROMPT).toContain("moveTo and moveToAsync take a unit, a guid or a name as well as a point");
    expect(SYSTEM_PROMPT).toContain('status: "unknown_target"');
  });

  test("tools are distinguished from ambient snippet objects", () => {
    // laguna and hy3 called write_scratchpad(...) / search_reference(...) (tools of the day) as
    // bare globals inside snippets.
    expect(SYSTEM_PROMPT).toContain("Tools and ambient objects are different things");
    expect(SYSTEM_PROMPT).toContain("is a ReferenceError");
  });

  test("the world is stated to be the whole, unwalled 3.3.5a world", () => {
    // Two opus-low freeplay runs (e360 2026-08-26, a11 2026-08-29) wrote
    // "cannot leave Coldridge Valley" into the scratchpad as a hard fact after
    // local pathing failures, and ground out the rest of the episode inside
    // the starter valley. Operator decision 2026-08-29: the extent of the
    // world is a world fact and belongs in the prompt.
    expect(SYSTEM_PROMPT).toContain("This is the complete, unmodified 3.3.5a world");
    expect(SYSTEM_PROMPT).toContain("nothing has been walled off for the benchmark");
  });
});

describe("the context sentence is the harness's, and says what that harness does", () => {
  // The prompt used to state the fixed loop's aggressive trim on both
  // harnesses. On claude-code no trim happens at all — one CLI
  // conversation grows for the whole episode — so on that driver the prompt
  // stated something false about the machinery the model was running under.
  test("the fixed loop states the trim, and notes.md as the memory", () => {
    expect(contextSentence("wrathbench")).toBe(
      "Older conversation is trimmed aggressively — notes.md is your memory, not the chat history.",
    );
    expect(SYSTEM_PROMPT).toContain(contextSentence("wrathbench"));
    expect(SYSTEM_PROMPT).not.toContain("does not trim");
  });

  test("claude-code states its own regime, and never the trim it does not apply", () => {
    const s = contextSentence("claude-code");
    expect(s).toContain("does not trim your conversation");
    expect(s).toContain("one continuous conversation");
    expect(CLAUDE_CODE_SYSTEM_PROMPT).toContain(s);
    expect(CLAUDE_CODE_SYSTEM_PROMPT).not.toContain("trimmed aggressively");
    expect(CLAUDE_CODE_SYSTEM_PROMPT).not.toContain("not the chat history");
  });

  test("the workspace survives on claude-code only with the reason it is true", () => {
    // Kept because a pause and resume restores the workspace and no
    // conversation (`resumeSessionNote`) — not as leftover advice.
    const s = contextSentence("claude-code");
    expect(s).toContain("paused and resumed");
    expect(s).toContain("workspace");
  });

  test("the two prompts differ by exactly that sentence and nothing else", () => {
    expect(CLAUDE_CODE_SYSTEM_PROMPT).not.toBe(SYSTEM_PROMPT);
    expect(CLAUDE_CODE_SYSTEM_PROMPT.replace(contextSentence("claude-code"), contextSentence("wrathbench"))).toBe(
      SYSTEM_PROMPT,
    );
    // Everything else the prompt promises is still there on both.
    for (const p of [SYSTEM_PROMPT, CLAUDE_CODE_SYSTEM_PROMPT]) {
      expect(p).toContain("This is the complete, unmodified 3.3.5a world");
      expect(p).toContain("## The snippet runtime");
      expect(p).toContain("Act through tools every turn");
      expect(p).toContain("Every turn you receive the current state summary");
    }
  });

  test("buildSystemPrompt renders per harness, defaulting to the fixed loop", () => {
    const { buildSystemPrompt } = require("../src/prompt");
    expect(buildSystemPrompt()).toBe(SYSTEM_PROMPT);
    expect(buildSystemPrompt(undefined, undefined, "wrathbench")).toBe(SYSTEM_PROMPT);
    expect(buildSystemPrompt(undefined, undefined, "claude-code")).toBe(CLAUDE_CODE_SYSTEM_PROMPT);
    // The objective block is the same text on both; only the context sentence moves.
    const a = buildSystemPrompt("walk to Ironforge", "e90", "wrathbench");
    const b = buildSystemPrompt("walk to Ironforge", "e90", "claude-code");
    expect(a).toContain("--- Operator objective for this run ---\nwalk to Ironforge\n");
    expect(b).toContain("--- Operator objective for this run ---\nwalk to Ironforge\n");
    expect(b.replace(contextSentence("claude-code"), contextSentence("wrathbench"))).toBe(a);
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
  const note = (taken: string[] = []) => freshCharacterNote({ race: 1, class: 2, taken });

  test("invites the model to name the character, in the game's own naming rules", () => {
    expect(note()).toContain("name your character");
    expect(note()).toContain("2-12 letters, no spaces, no three identical letters in a row");
    expect(note()).toContain("it is yours for the episode");
    expect(note()).toContain("pick something you like and be creative");
  });

  test("no name travels with the launch — not as an assignment and not as a suggestion", () => {
    // A suggestion is a name the harness has to invent, keep valid and keep
    // unique; an invalid one took a whole fleet config down (2026-08-25).
    expect(note()).not.toContain("suggestion");
    expect(note()).not.toContain("your assigned character");
    expect(note()).not.toContain("Use exactly these values");
    expect(note()).toContain("be creative");
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

describe("the resume session note", () => {
  const base = { race: 1, class: 2, clock: "40 minutes elapsed of 90", seen: "", raceName: "Human", className: "Paladin" };

  test("a run that recorded a name is told to reuse exactly that character", () => {
    const note = resumeSessionNote({ ...base, character: "Grimjaw", seen: " It was last observed at level 6, and that progress is still there." });
    expect(note).toContain('name "Grimjaw"');
    expect(note).toContain('createSession({ character: "Grimjaw", race: 1, class: 2 })');
    expect(note).toContain("Do not create a different one");
    expect(note).toContain("level 6");
    expect(note).toContain("race 1 (Human), class 2 (Paladin)");
  });

  test("a run that paused before createSession landed gets the fresh-launch note, never a name it does not have", () => {
    // The name is the model's own and is recorded only once the character
    // exists; nothing may interpolate an absent one into an instruction.
    const note = resumeSessionNote({ ...base, character: undefined });
    expect(note).toContain("resumed after a pause");
    expect(note).not.toContain("undefined");
    expect(note).not.toContain("Do not create a different one");
    expect(note).toContain("name your character");
    expect(note).toContain('createSession({ character: "<your name>", race: 1, class: 2 })');
  });
});

describe("continuedSessionNote", () => {
  test("names the run it continues and the character, and says not to roll another", () => {
    const note = continuedSessionNote({
      character: "Bromdir",
      race: 3,
      class: 2,
      from: "fleet-sub-opus-low-freeplay-opus-low-20260827-a11",
      seen: " It was last observed at level 8 with 6410 xp, and that progress is still there.",
      raceName: "Dwarf",
      className: "Paladin",
    });
    expect(note).toContain("continues your earlier freeplay session fleet-sub-opus-low-freeplay-opus-low-20260827-a11");
    expect(note).toContain('name "Bromdir", race 3 (Dwarf), class 2 (Paladin)');
    expect(note).toContain("level 8 with 6410 xp");
    expect(note).toContain("Do not create a different one");
    expect(note).toContain('createSession({ character: "Bromdir", race: 3, class: 2 })');
    expect(note).toContain("your workspace, notes.md included, was kept");
    expect(note).toContain("top-level bindings or background routines");
  });
});

describe("persistence is taught as the workspace, never as globalThis", () => {
  const prompts = [SYSTEM_PROMPT, CLAUDE_CODE_SYSTEM_PROMPT, buildSystemPrompt(undefined, undefined, "wrathbench", false)];

  test("no model-facing text names globalThis", () => {
    for (const p of prompts) expect(p).not.toContain("globalThis");
    expect(STATE_LOSS_RECOVERY).not.toContain("globalThis");
    expect(STATE_RESET_NOTICE).not.toContain("globalThis");
    expect(STATE_KEPT_AND_LOST).not.toContain("globalThis");
    for (const t of TOOLS) expect(t.description).not.toContain("globalThis");
    expect(REFLECTION_PROMPT).not.toContain("globalThis");
  });

  test("the prompt teaches files and import, notes.md as memory, and what a restart loses", () => {
    expect(SYSTEM_PROMPT).toContain('import { helper } from "./lib/util"');
    expect(SYSTEM_PROMPT).toContain("notes.md in the workspace is your memory: it is shown in full every turn");
    expect(SYSTEM_PROMPT).toContain("the next import loads every workspace module afresh");
    expect(SYSTEM_PROMPT).toContain("- files: your workspace from inside a snippet");
    expect(SYSTEM_PROMPT).not.toContain("import is not available");
    expect(SYSTEM_PROMPT).not.toContain("scratchpad");
  });

  test("the persistence rule is stated whole: bindings and routines until a restart, imports per snippet, files for good", () => {
    // A live probe's model called `farm` in the snippet after the one that
    // imported it — "farm is not defined" — because the prompt said what a
    // restart loses but not that an import binding lasts one snippet.
    expect(SYSTEM_PROMPT).toContain(
      "Top-level bindings and background routines persist in the running sandbox from one snippet to the next, until the sandbox restarts; an import binding belongs to the snippet that imported it, so import again in every snippet that uses it; workspace files are the durable store and survive a restart.",
    );
  });

  test("the launch example keeps a handle a later snippet can abort, and promises no value", () => {
    // A live probe's model launched overlapping routines on consecutive turns
    // because the example gave it nothing to stop the earlier one with; and the
    // old example's trailing `"started"` never came back (a statement then a
    // value is not one expression, so the snippet returned undefined).
    // sandbox.test.ts runs this idiom end to end.
    for (const p of [SYSTEM_PROMPT, CLAUDE_CODE_SYSTEM_PROMPT]) {
      expect(p).toContain(
        "launch a background routine as a statement and keep a handle to it in a top-level binding: const job = new AbortController(); void (async (stop) => { while (!stop.aborted) { … } })(job.signal).catch((e) => console.log(String(e))); returns at once with no value, and what the routine prints arrives with later snippet results.",
      );
      expect(p).toContain(
        "A later snippet stops it with job.abort(), which the loop sees at its next check, so the call in flight (a sleep, a killTarget running to its timeout) finishes first; launching again does not stop the routine already running, so abort the old one before launching its replacement.",
      );
      expect(p).not.toContain('"started"');
      // No wait takes a routine's own signal (sleep takes only { wake }, the
      // helpers only the ambient one), so the example must not pass it to one.
      expect(p).not.toContain("signal: job.signal");
    }
  });

  test("the file tools and their limits are in the prompt's tool list", () => {
    expect(SYSTEM_PROMPT).toContain("- read_file / write_file / edit_file / delete_file: your workspace.");
    expect(SYSTEM_PROMPT).toContain("Each file holds at most 32000 characters and the workspace at most 1048576 bytes");
    expect(SYSTEM_PROMPT).toContain("the listing of your workspace, and your notes.md");
  });

  test("the resume note says bindings and routines were lost and the workspace kept", () => {
    const note = resumeSessionNote({ character: "Bromdir", race: 3, class: 2, clock: "40 minutes elapsed of 90", seen: "" });
    expect(note).toContain("neither were top-level bindings or background routines — this is a new sandbox");
    expect(note).toContain("your workspace, notes.md included, was kept");
  });
});
