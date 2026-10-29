import { describe, expect, test } from "bun:test";

import {
  CLAUDE_CODE_SYSTEM_PROMPT,
  SYSTEM_PROMPT,
  contextSentence,
  freshCharacterNote,
  resumeSessionNote,
  continuedSessionNote,
} from "../src/prompt";

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

  test("every duration option names its unit, and killTarget's default is not in seconds", () => {
    // Recent 90-minute runs passed seconds-sized values (4-40) to
    // killTarget's timeout, which is milliseconds, and got status "timeout"
    // at once; the prompt said "default 25s" and never named the unit.
    expect(SYSTEM_PROMPT).toContain("sdk.killTarget(guid, { timeout: ms, disengage, abortBelowHealthPct })");
    expect(SYSTEM_PROMPT).toContain("the timeout (default 25000 = 25s,");
    expect(SYSTEM_PROMPT).toContain("sdk.waitForChat(textOrPredicate, { timeout: ms })");
    expect(SYSTEM_PROMPT).toContain("sdk.waitForQuestObjective(questId, { timeout: ms })");
    expect(SYSTEM_PROMPT).toContain("waitForOpcode(opcode, { timeout: ms })");
    expect(SYSTEM_PROMPT).not.toContain("{ timeout }");
    expect(SYSTEM_PROMPT).not.toContain("default 25s");
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
    // The operator's wording (2026-10-20): a rough on-foot figure, with the
    // direction a swim or a mount moves it; moveTo's note judges by the
    // module's walk time, so the prompt states no speed.
    expect(SYSTEM_PROMPT).toContain(
      "A long walk is the usual way to hit that limit (on foot roughly 200y; less swimming, more mounted), so dispatch those with await sdk.moveToAsync(target)",
    );
    expect(SYSTEM_PROMPT).not.toContain("7yd/s");
    expect(SYSTEM_PROMPT).toContain("await sdk.moveToAsync(target)");
  });

  test("moveTo is documented as taking a unit or guid, with a typed miss", () => {
    // 4 of 7 runs in the same fan-out threw a raw TypeError reading .x off a
    // unit lookup that found nothing.
    expect(SYSTEM_PROMPT).toContain("moveTo and moveToAsync take a unit, a guid or a name as well as a point");
    expect(SYSTEM_PROMPT).toContain('status: "unknown_target"');
  });

  test("tools are distinguished from ambient snippet objects", () => {
    // laguna and hy3 called write_scratchpad(...) / search_reference(...) as
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

  test("the scratchpad cap is stated, with the refusal, at the number the pad enforces", () => {
    // A freeplay run filled its pad and lost every note it appended for eighty
    // turns: the cap was in no prompt or tool text (operator, 2026-10-14).
    const { SCRATCHPAD_MAX_CHARS } = require("@wrathbench/mcp");
    expect(SYSTEM_PROMPT).toContain(`The scratchpad holds at most ${SCRATCHPAD_MAX_CHARS.toLocaleString("en-US")} characters`);
    expect(SYSTEM_PROMPT).toContain("is refused and saves nothing (in a snippet, the call rejects)");
  });

  test("bank and mail are on the helper surface", () => {
    // openBank, bankDeposit and sendMail existed in the SDK and no run had
    // ever used them; the prompt never named them (operator, 2026-10-14).
    for (const call of ["sdk.openBank(", "sdk.bankDeposit(", "sdk.bankWithdraw(", "state.bank()", "sdk.openMailbox(", "sdk.sendMail(", "sdk.mailList()"]) {
      expect(SYSTEM_PROMPT).toContain(call);
    }
  });
});

describe("the context sentence is the harness's, and says what that harness does", () => {
  // The prompt used to state the fixed loop's aggressive trim on both
  // harnesses. On claude-code no trim happens at all — one CLI
  // conversation grows for the whole episode — so on that driver the prompt
  // stated something false about the machinery the model was running under.
  test("the fixed loop states the trim, and the scratchpad as the memory", () => {
    expect(contextSentence("wrathbench")).toBe(
      "Older conversation is trimmed aggressively, and older tool results are folded to one-line records first — the scratchpad is your memory, not the chat history.",
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

  test("the scratchpad survives on claude-code only with the reason it is true", () => {
    // Kept because a pause and resume restores the scratchpad and no
    // conversation (`resumeSessionNote`) — not as leftover advice.
    const s = contextSentence("claude-code");
    expect(s).toContain("paused and resumed");
    expect(s).toContain("scratchpad");
  });

  test("the two prompts differ by exactly that sentence and the snippet-delta one, and nothing else", () => {
    const { SNIPPET_DELTA_SENTENCE } = require("../src/prompt");
    expect(CLAUDE_CODE_SYSTEM_PROMPT).not.toBe(SYSTEM_PROMPT);
    expect(
      CLAUDE_CODE_SYSTEM_PROMPT.replace(contextSentence("claude-code"), contextSentence("wrathbench")).replace(` ${SNIPPET_DELTA_SENTENCE}`, ""),
    ).toBe(SYSTEM_PROMPT);
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
    // The objective block is the same text on both; only the context and
    // snippet-delta sentences move.
    const { SNIPPET_DELTA_SENTENCE } = require("../src/prompt");
    const a = buildSystemPrompt("walk to Ironforge", "e90", "wrathbench");
    const b = buildSystemPrompt("walk to Ironforge", "e90", "claude-code");
    expect(a).toContain("--- Operator objective for this run ---\nwalk to Ironforge\n");
    expect(b).toContain("--- Operator objective for this run ---\nwalk to Ironforge\n");
    expect(b.replace(contextSentence("claude-code"), contextSentence("wrathbench")).replace(` ${SNIPPET_DELTA_SENTENCE}`, "")).toBe(a);
  });
});

describe("episode sentence", () => {
  const { buildSystemPrompt, episodeSection, objectiveSection, WORLD_SECTION } = require("../src/prompt");
  test("no episode and no objective is byte-identical to SYSTEM_PROMPT", () => {
    expect(buildSystemPrompt()).toBe(SYSTEM_PROMPT);
    expect(buildSystemPrompt(undefined, "freeplay")).toBe(SYSTEM_PROMPT);
  });
  test("e90 states the clock, the promotion bar, and that the bar is not the end; e360 only the clock", () => {
    // All three Sonnet 5.5 e90 runs read the bar alone as a finish line ("Level
    // 5 is done and the promotion bar is met. I'm stopping here") and idled
    // into the no-XP watchdog. Operator decision 2026-10-01: say, as a fact,
    // that reaching it ends nothing — no advice, no number to chase, the bar
    // itself unchanged.
    expect(episodeSection("e90")).toBe(
      "This episode lasts 90 minutes. Reaching level 5 within it is the bar for promotion to six-hour episodes. " +
        "Reaching the bar does not end the episode: everything after it is recorded and counts exactly as what came before.",
    );
    expect(episodeSection("e360")).toBe("This episode lasts six hours.");
    expect(episodeSection("freeplay")).toBeUndefined();
    expect(episodeSection("probing")).toBeUndefined();
  });

  test("every rendering hashes as pinned, so a prompt edit has to move its pins on purpose", () => {
    // Pinned by value, not by rebuilding from the same parts, so a change to
    // any rendering fails here. The last edit to move them is the sleep
    // sentence going back to "pass { wake: false } for a plain timer" (the
    // wake revert after Deadmines a8), in the shared body, so it moved all
    // of them. The snippet-delta sentence (claude-code only, operator
    // 2026-10-21) then split claude-code off the other CLI renders, moving
    // its six and no other. The operator's wording edits to the "attacked"
    // clause and the snippet-delta sentence (2026-10-21) moved all of them.
    // The useItem refusal clause giving its shape rather than a status list,
    // once the SDK added quest_refused (2026-10-29), moved all of them, and
    // so did the trim to key starting points that followed it (operator,
    // 2026-10-29): helper result shapes and status lists, the NPC-window
    // shapes, the state field list and the units filter-key list left to the
    // SDK reference.
    const { promptHash } = require("../src/comparability");
    const pinned: Record<string, Record<string, Record<string, string>>> = {
      none: {
        wrathbench: { on: "sha256:3211d771263f42db", off: "sha256:024cb60e17a771bb" },
        "claude-code": { on: "sha256:78fd18cc70619210", off: "sha256:11b799b2d291a502" },
        cli: { on: "sha256:9a65d05391c66d9b", off: "sha256:a285889d04da2e47" },
      },
      e90: {
        wrathbench: { on: "sha256:228eb7d0b6b89da5", off: "sha256:d0aae6cbd12b88dc" },
        "claude-code": { on: "sha256:429aa208c02466b3", off: "sha256:f1487723fd549865" },
        cli: { on: "sha256:dbec5dddf05071a4", off: "sha256:b64409d039b6303b" },
      },
      e360: {
        wrathbench: { on: "sha256:486dc4826299b4e9", off: "sha256:9dbc2c67dc7a2c3e" },
        "claude-code": { on: "sha256:50bfa3d5f6b7df90", off: "sha256:5d5e3950d0e51782" },
        cli: { on: "sha256:bf15a2bb334e3dfe", off: "sha256:82049ec62f459129" },
      },
    };
    const episodes = [
      [undefined, "none"],
      ["freeplay", "none"],
      ["probing", "none"],
      ["e90", "e90"],
      ["e360", "e360"],
    ] as const;
    for (const [episode, row] of episodes) {
      for (const harness of ["wrathbench", "claude-code", "codex", "pi"] as const) {
        for (const wiki of [true, false]) {
          const got = promptHash(buildSystemPrompt(undefined, episode, harness, wiki));
          const want = pinned[row]![harness === "wrathbench" || harness === "claude-code" ? harness : "cli"]![wiki ? "on" : "off"];
          expect(`${episode}/${harness}/${wiki}: ${got}`).toBe(`${episode}/${harness}/${wiki}: ${want}`);
        }
      }
    }
  });
  test("the sentence sits after the world facts and before the objective block", () => {
    const p = buildSystemPrompt("walk to Ironforge", "e90");
    const facts = p.indexOf(WORLD_SECTION);
    const tier = p.indexOf(episodeSection("e90"));
    const obj = p.indexOf(objectiveSection("walk to Ironforge"));
    expect(facts).toBe(0);
    expect(tier).toBeGreaterThan(facts);
    expect(obj).toBeGreaterThan(tier);
  });
});

describe("an objective replaces the broad goal (operator, 2026-10-21)", () => {
  const { buildSystemPrompt, clockWords, GOAL_SECTION, probingClockSentence, WORLD_SECTION } = require("../src/prompt");

  test("the standing goal is the old bytes, so every run without an objective reads as it did", () => {
    // Verbatim, the string GOAL_SECTION was before it was split into world
    // facts and directive sentences; the hash pins above say the same of
    // every whole rendering.
    expect(GOAL_SECTION).toBe(
      "You are an agent controlling one character in World of Warcraft 3.3.5a on a private benchmark server. The world is live and does not pause for you. This is the complete, unmodified 3.3.5a world: every zone, city, road, flight path, boat and tram a player could use exists and is reachable, and nothing has been walled off for the benchmark. Your goal is to progress your character over the long run — leveling up, completing quests, acquiring better gear, accumulating wealth, and growing in capability. The server is the source of truth for what actually happened. There is no single number to maximize; play the game well and make broad, durable progress.\n\n" +
        "You do not play directly. You write TypeScript snippets that run in a persistent sandbox holding one SDK client for your game session, and you supervise the results.",
    );
    for (const episode of [undefined, "freeplay", "probing", "e90", "e360"] as const) {
      for (const objective of [undefined, "", "   "]) {
        expect(buildSystemPrompt(objective, episode, "wrathbench", true, 14_400_000).startsWith(`${GOAL_SECTION}\n\n`)).toBe(true);
      }
    }
    // A budget changes nothing without an objective, on any tier.
    expect(buildSystemPrompt(undefined, "probing", "wrathbench", true, 14_400_000)).toBe(SYSTEM_PROMPT);
  });

  test("with an objective the directive sentences and the additive line are gone, and the world facts read first", () => {
    for (const episode of [undefined, "freeplay", "probing", "e90", "e360"] as const) {
      for (const harness of ["wrathbench", "claude-code", "codex", "pi"] as const) {
        const p = buildSystemPrompt("walk to Ironforge", episode, harness, true, 14_400_000);
        expect(p.startsWith(`${WORLD_SECTION}\n\n`)).toBe(true);
        expect(p).not.toContain("Your goal is to progress");
        expect(p).not.toContain("There is no single number to maximize");
        expect(p).not.toContain("in addition to the standing goal");
        expect(p).toContain("--- Operator objective for this run ---\nwalk to Ironforge\n--- end operator objective ---");
      }
    }
    // The world facts are the goal's own sentences minus the two directives.
    expect(
      GOAL_SECTION.replace(
        " Your goal is to progress your character over the long run — leveling up, completing quests, acquiring better gear, accumulating wealth, and growing in capability.",
        "",
      ).replace(" There is no single number to maximize; play the game well and make broad, durable progress.", ""),
    ).toBe(WORLD_SECTION);
  });

  test("a probe with an objective states its clock from the budget; freeplay and an unlimited budget state none", () => {
    expect(buildSystemPrompt("x", "probing", "wrathbench", true, 14_400_000)).toContain(`${WORLD_SECTION}\n\nThis run lasts four hours.\n\n--- Operator objective`);
    expect(buildSystemPrompt("x", "probing", "wrathbench", true, null)).toContain(`${WORLD_SECTION}\n\n--- Operator objective`);
    expect(buildSystemPrompt("x", "freeplay", "wrathbench", true, 14_400_000)).toContain(`${WORLD_SECTION}\n\n--- Operator objective`);
    // An eval tier keeps its own fixed sentence, whatever the budget says.
    expect(buildSystemPrompt("x", "e360", "wrathbench", true, 60_000)).toContain(`${WORLD_SECTION}\n\nThis episode lasts six hours.\n\n--- Operator objective`);
    expect(probingClockSentence(14_400_000)).toBe("This run lasts four hours.");
    expect(probingClockSentence(null)).toBeUndefined();
    expect(probingClockSentence(undefined)).toBeUndefined();
  });

  test("the clock is humanised as the eval sentences are", () => {
    expect(clockWords(90 * 60_000)).toBe("90 minutes");
    expect(clockWords(360 * 60_000)).toBe("six hours");
    expect(clockWords(240 * 60_000)).toBe("four hours");
    expect(clockWords(60 * 60_000)).toBe("one hour");
    expect(clockWords(720 * 60_000)).toBe("twelve hours");
    expect(clockWords(1440 * 60_000)).toBe("24 hours");
    expect(clockWords(45 * 60_000)).toBe("45 minutes");
  });

  test("objective-bearing renderings hash as pinned", () => {
    const { promptHash } = require("../src/comparability");
    const got = {
      probing4h: promptHash(buildSystemPrompt("walk to Ironforge", "probing", "wrathbench", true, 14_400_000)),
      probing4hCli: promptHash(buildSystemPrompt("walk to Ironforge", "probing", "claude-code", true, 14_400_000)),
      e90: promptHash(buildSystemPrompt("walk to Ironforge", "e90", "wrathbench", true)),
      freeplay: promptHash(buildSystemPrompt("walk to Ironforge", "freeplay", "wrathbench", true)),
    };
    expect(got).toEqual({
      probing4h: "sha256:335a744a3e0534c7",
      probing4hCli: "sha256:f65503044352c802",
      e90: "sha256:929e2f052da0965c",
      freeplay: "sha256:caa725c5528f585b",
    });
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
    expect(note).toContain("your scratchpad was");
  });
});
