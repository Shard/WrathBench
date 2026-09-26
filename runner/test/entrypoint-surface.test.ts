/**
 * What the entrypoint loop (a probing spike) tells the model and records about
 * itself: the second prompt body, run_snippet's description, the harness
 * strings, the refusals that keep it off scored tiers and the CLI drivers, and
 * the comparability key that keeps its runs apart. The snippet loop's side of
 * each is pinned in `snippet-mode-pin.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { comparabilityOf, comparabilitySchema } from "../src/comparability";
import { loadRunConfig, loopRefusal } from "../src/config";
import {
  ENTRYPOINT_GOAL_SECTION,
  STATE_KEPT_AND_LOST,
  STATE_KEPT_AND_LOST_ENTRYPOINT,
  SYSTEM_PROMPT,
  buildSystemPrompt,
  continuedSessionNote,
  resumeSessionNote,
} from "../src/prompt";
import { configFromArgs } from "../src/run";
import { STATE_LOSS_RECOVERY_ENTRYPOINT, STATE_RESET_NOTICE_ENTRYPOINT } from "../src/sandbox/host";
import { ENTRYPOINT_RUN_SNIPPET_DESCRIPTION, TOOLS, toolsFor } from "../src/tools";
import { MEMORY_WRITE_REFUSAL } from "../src/workspace";

const ENTRY = buildSystemPrompt(undefined, "probing", "wrathbench", true, "entrypoint");
const ENTRY_NO_WIKI = buildSystemPrompt("Reach Goldshire.", "freeplay", "wrathbench", false, "entrypoint");

/** Phrases that describe the snippet loop's REPL, which the entrypoint loop does not have. */
const SNIPPET_LOOP_PHRASES = ["globalThis", "background routine", "Background routines", "Top-level bindings", "top-level binding", "Your only way to act"];

describe("the entrypoint prompt", () => {
  test("says the model writes a program the harness runs, and how a turn ends", () => {
    expect(ENTRYPOINT_GOAL_SECTION).toContain(
      "You write a TypeScript program, main.ts in your workspace, that the harness runs continuously against one SDK client for your session; you are woken to read what happened and revise it.",
    );
    expect(ENTRY).toContain("## Your program");
    expect(ENTRY).toContain("export async function loop(ctx) { … }");
    expect(ENTRY).toContain("A tick has 120 seconds and a handler 10");
    expect(ENTRY).toContain(
      "Your changes take effect as soon as you save them: a write_file, edit_file or delete_file that changes main.ts or a file it imports loads main.ts afresh in place of the running program, whose tick and handlers in flight are aborted and whose timers and event listeners are removed, and the tool's result says whether it loaded. Files changed from a snippet load when you end your turn.",
    );
    expect(ENTRY).not.toContain("Your changes take effect when you end your turn");
    expect(ENTRY).toContain("It holds at most 32000 characters of JSON");
    expect(ENTRY).toContain("## Snippets");
    expect(ENTRY).toContain("Nothing a snippet starts outlives it");
    expect(ENTRY).toContain("## Each wake");
    expect(ENTRY).toContain("its errors with the workspace lines they came from, its outcomes (sdk calls that answered ok: false, which never wake you), its ctx.wake calls");
    expect(ENTRY).toContain("- memory: your program's memory, the same object as ctx.memory.");
    expect(ENTRY.endsWith(
      "Older conversation is trimmed aggressively — notes.md is your memory, not the chat history. End your turn by replying without a tool call; your program keeps running and you are woken for its errors, its ctx.wake calls, level-ups, quest turn-ins and deaths, and at the latest after five minutes. " +
        "A reply that contains any tool call continues your turn, whatever its text says, until the request cap in the [wake] header.",
    )).toBe(true);
    // "ok means sent" stays.
    expect(ENTRY).toContain("means the opcode was dispatched, not that it worked");
  });

  test("shares every other byte of the SDK surface with the snippet prompt", () => {
    // The long state-shapes bullet is the same text on both loops.
    const shapes = SYSTEM_PROMPT.slice(SYSTEM_PROMPT.indexOf("- state.units(filter?)"), SYSTEM_PROMPT.indexOf("- sdk.events —"));
    expect(shapes.length).toBeGreaterThan(1_000);
    expect(ENTRY).toContain(shapes);
  });

  test("names none of the snippet loop's REPL, in any rendering", () => {
    for (const text of [ENTRY, ENTRY_NO_WIKI, buildSystemPrompt(undefined, "freeplay", "wrathbench", true, "entrypoint")]) {
      for (const phrase of SNIPPET_LOOP_PHRASES) expect(text).not.toContain(phrase);
    }
    expect(ENTRY_NO_WIKI).not.toContain("search_reference");
    expect(ENTRY).toContain("search_reference");
  });
});

describe("the entrypoint tools and harness strings", () => {
  test("run_snippet is the one-off it is; the list is the same tools in the same order", () => {
    const tools = toolsFor({ loop: "entrypoint" });
    expect(tools.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
    expect(tools[0]!.description).toBe(ENTRYPOINT_RUN_SNIPPET_DESCRIPTION);
    expect(tools.slice(1)).toEqual(TOOLS.slice(1));
    expect(toolsFor({ loop: "entrypoint", wikiSearch: false }).some((t) => t.name === "search_reference")).toBe(false);
    expect(toolsFor({ loop: "entrypoint", wikiCoords: true }).find((t) => t.name === "search_reference")!.description).toContain(
      "Some hits carry wiki-recorded coordinates",
    );
  });

  test("no model-facing string of the entrypoint loop names the snippet loop's REPL", () => {
    const strings = [
      ...toolsFor({ loop: "entrypoint" }).map((t) => t.description),
      STATE_LOSS_RECOVERY_ENTRYPOINT,
      STATE_RESET_NOTICE_ENTRYPOINT,
      STATE_KEPT_AND_LOST_ENTRYPOINT,
      MEMORY_WRITE_REFUSAL,
      resumeSessionNote({ character: "Bromdir", race: 3, class: 1, clock: "40 minutes elapsed of 90", seen: "", loop: "entrypoint" }),
      continuedSessionNote({ character: "Bromdir", race: 3, class: 1, from: "run-a", seen: "", loop: "entrypoint" }),
    ];
    for (const s of strings) for (const phrase of SNIPPET_LOOP_PHRASES) expect(s).not.toContain(phrase);
  });

  test("resume and continuation notes say the program comes back from main.ts, and memory.json was kept", () => {
    const resumed = resumeSessionNote({ character: "Bromdir", race: 3, class: 1, clock: "40 minutes elapsed of 90", seen: "", loop: "entrypoint" });
    expect(resumed).toContain(STATE_KEPT_AND_LOST_ENTRYPOINT);
    expect(resumed).not.toContain(STATE_KEPT_AND_LOST);
    expect(STATE_KEPT_AND_LOST_ENTRYPOINT).toContain("your program loads again from main.ts when you end your first turn");
    expect(STATE_KEPT_AND_LOST_ENTRYPOINT).toContain("memory.json");
  });
});

describe("where the entrypoint loop may run", () => {
  test("only unscored, and only on the fixed loop; each refusal names the limit and the relaunch", () => {
    expect(loopRefusal({ loop: "entrypoint", episode: "probing", driver: "openai" })).toBeNull();
    expect(loopRefusal({ loop: "entrypoint", episode: "freeplay", driver: "stub" })).toBeNull();
    expect(loopRefusal({ loop: "snippet", episode: "e90", driver: "claude-code" })).toBeNull();
    expect(loopRefusal({ driver: "openai" })).toBeNull();
    const scored = loopRefusal({ loop: "entrypoint", episode: "e90", driver: "openai" })!;
    expect(scored).toContain("--episode e90, a scored tier");
    expect(scored).toContain("relaunch with --episode probing, or drop --loop");
    expect(loopRefusal({ loop: "entrypoint", driver: "openai" })).toContain("on no episode tier");
    for (const driver of ["claude-code", "codex"] as const) {
      const cli = loopRefusal({ loop: "entrypoint", episode: "probing", driver })!;
      expect(cli).toContain(`the ${driver} CLI owns its own turns`);
      expect(cli).toContain("relaunch with --driver openai, or drop --loop");
    }
    expect(() => loadRunConfig({ driver: "openai", episode: "e360", loop: "entrypoint" })).toThrow("a scored tier");
  });

  test("--loop entrypoint reaches the config, and the tuple gains its key, last, with its own prompt hash", () => {
    const argv = [
      "--run-id", "run-ep",
      "--token", "0123456789abcdef0123456789abcdef",
      "--module-url", "http://worldserver:8086",
      "--api-base", "https://example.invalid/v1",
      "--driver", "openai",
      "--model", "some/model",
      "--episode", "probing",
    ];
    const snippet = configFromArgs(argv);
    const entry = configFromArgs([...argv, "--loop", "entrypoint"]);
    expect(snippet.loop).toBeUndefined();
    expect(entry.loop).toBe("entrypoint");
    const a = comparabilityOf(snippet, "harness-0.5-x", null, null);
    const b = comparabilityOf(entry, "harness-0.5-x", null, null);
    expect("loop" in a).toBe(false);
    expect(b.loop).toBe("entrypoint");
    expect(Object.keys(b).at(-1)).toBe("loop");
    expect(b.promptHash).not.toBe(a.promptHash);
    expect(comparabilitySchema.parse(JSON.parse(JSON.stringify(b)))).toEqual(b);
    expect(() => configFromArgs([...argv.slice(0, -2), "--episode", "e90", "--loop", "entrypoint"])).toThrow("a scored tier");
  });
});
