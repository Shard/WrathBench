/**
 * The program loop (`loop: "program"`), a probe arm, against fakes: its
 * config and tuple keys and refusals, its prompt body, its tool list, the
 * sleep and its wake reasons, the [wake] block, the records `inspect requests`
 * reads, and the fixed loop driving all of it. The snippet loop's own pins
 * (prompt hashes, tools, config, tuple) are the rest of the suite's, which
 * this change leaves passing untouched.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import type { ActionHintNote, ProgramFact, ProgramFacts, RoutineRow } from "@wrathbench/mcp";
import { PROGRAM_EDIT_SCRATCHPAD_NOT_FOUND, routineDetailKey, Scratchpad } from "@wrathbench/mcp";
import { PROGRAM_FANOUT_RUN_SNIPPET_SENTENCE } from "@wrathbench/mcp/fanout";
import { StubAdapter, type ChatRequest } from "../src/adapter";
import { campaignPairRefusals, type PairRosterEntry } from "../src/campaigns";
import { comparabilityOf, promptHash } from "../src/comparability";
import { assembleContext, capWindowMessage, CONTEXT_POLICY, PadSeen, renderWindow, scratchpadUnchangedLine, type HistoryMessage } from "../src/context";
import { PAD_HEADER_PATTERN } from "../../infra/inspect-run";
import { defaultLoopOf, launchLoopOf, loadRunConfig, loopLaunchRefusal, programLoopRefusal } from "../src/config";
import { EpisodicLog } from "../src/episodic";
import { fanoutSessionNote } from "../src/fanout-run";
import { runLoop } from "../src/loop";
import {
  buildSystemPrompt,
  PROGRAM_BODY_TAIL,
  PROGRAM_RESUME_KEPT,
  PROGRAM_RUNTIME_LEAD,
  PROGRAM_YIELD_TAIL,
  programPromptOf,
  resumeSessionNote,
  SYSTEM_PROMPT,
} from "../src/prompt";
import { carryProgramFiles, configFromArgs, dropCarriedProgramFiles } from "../src/run";
import { parseRunArgs } from "../src/run-flags";
import type { SandboxHost } from "../src/sandbox/host";
import { RecordSignals } from "../src/session-record";
import { callTool, coerceToolArgs, isKnownTool, toolsFor, TOOLS } from "../src/tools";
import { readTrajectory, Trajectory } from "../src/trajectory";
import { mergeFacts, ProgramWake, renderWake, sleepUntilWake, WAKE_CAP_MS, WAKE_CONSOLE_CHARS, Waker, type WakeReason, type WakeView } from "../src/wake";
import { Watchdogs } from "../src/watchdogs";
import { LEAKED_SECRET } from "./fixtures/leaky-snippet";
import { program1Tools } from "./fixtures/program1-tools";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();

const BASE = ["--driver", "stub", "--run-id", "r1", "--token", "tok-aaaaaaaaaaaaaaaaaaaaaa", "--module-url", "http://x"];

describe("config, flags and the tuple", () => {
  test("--loop and --yield are written at every launch; the tuple carries them on the program loop only", () => {
    // The stub is not a model: it keeps the snippet loop unless asked.
    const snippet = configFromArgs(BASE, {});
    expect(snippet.loop).toBe("snippet");
    expect("yield" in snippet).toBe(false);
    const said = configFromArgs([...BASE, "--loop", "snippet"], {});
    expect(said.loop).toBe("snippet");
    const tSnippet = comparabilityOf(snippet, "harness-1.0-1-gabc");
    expect("loop" in tSnippet).toBe(false);
    expect(comparabilityOf(said, "harness-1.0-1-gabc")).toEqual(tSnippet);
    // A config stored before the loop was written down reads as it did, and stamps the same tuple.
    const { loop: _loop, ...legacy } = snippet;
    expect(comparabilityOf(legacy as typeof snippet, "harness-1.0-1-gabc")).toEqual(tSnippet);

    const program = configFromArgs([...BASE, "--loop", "program"], {});
    expect(program.loop).toBe("program");
    expect("yield" in program).toBe(false);
    const withYield = configFromArgs([...BASE, "--loop", "program", "--yield", "true"], {});
    expect(withYield.yield).toBe(true);
    const tYield = comparabilityOf(withYield, "harness-1.0-1-gabc");
    expect(Object.keys(tYield).slice(-2)).toEqual(["loop", "yield"]);
    // Three arms, three prompts, three tuples.
    const hashes = new Set([tSnippet.promptHash, comparabilityOf(program, "harness-1.0-1-gabc").promptHash, tYield.promptHash]);
    expect(hashes.size).toBe(3);
    expect(tSnippet.promptHash).toBe(promptHash(SYSTEM_PROMPT));
  });

  test("the default loop: the program loop with yield on the fixed loop and claude-code, without it on codex, the snippet loop elsewhere", () => {
    const MODEL = ["--run-id", "r1", "--token", "tok-aaaaaaaaaaaaaaaaaaaaaa", "--module-url", "http://x", "--model", "m"];
    const openai = configFromArgs([...MODEL, "--driver", "openai", "--episode", "freeplay"], {});
    expect([openai.loop, openai.yield]).toEqual(["program", true]);
    const off = configFromArgs([...MODEL, "--driver", "openai", "--episode", "freeplay", "--yield", "false"], {});
    expect([off.loop, off.yield]).toEqual(["program", undefined]);
    const codex = configFromArgs([...MODEL, "--driver", "codex", "--credential", "chatgpt-1", "--episode", "freeplay"], {});
    expect([codex.loop, codex.yield]).toEqual(["program", undefined]);
    expect(comparabilityOf(codex, "harness-1.0-1-gabc").loop).toBe("program");
    const cc = configFromArgs([...MODEL, "--driver", "claude-code", "--episode", "freeplay"], {});
    expect([cc.loop, cc.yield]).toEqual(["program", true]);
    expect(defaultLoopOf({ driver: "pi" })).toEqual({ loop: "snippet", yield: false });
    expect(defaultLoopOf({ driver: "reference" })).toEqual({ loop: "snippet", yield: false });
    // A fan-out run takes its driver's default: one program drives every character.
    expect(defaultLoopOf({ driver: "openai", fanout: { characters: 2 } })).toEqual({ loop: "program", yield: true });
    expect(defaultLoopOf({ driver: "codex", fanout: { characters: 2 } })).toEqual({ loop: "program", yield: false });
    expect(defaultLoopOf({ driver: "pi", fanout: { characters: 2 } })).toEqual({ loop: "snippet", yield: false });
    expect(launchLoopOf({ driver: "openai" }, { loop: "program" })).toEqual({ loop: "program", yield: true });
    expect(launchLoopOf({ driver: "codex" }, { yield: true })).toEqual({ loop: "program", yield: true });
    expect(launchLoopOf({ driver: "openai" }, { loop: "snippet" })).toEqual({ loop: "snippet" });
  });

  test("a model's snippet loop launches only as a probe, and scored episodes wait; the stub and the reference are exempt", () => {
    for (const driver of ["openai", "codex", "claude-code", "pi"] as const) {
      for (const episode of ["e90", "e360", "freeplay", undefined] as const) {
        expect(loopLaunchRefusal({ loop: "snippet", driver, episode })).toContain("legacy arm (--episode probing)");
        // A config stored before the loop was written down was the snippet loop.
        expect(loopLaunchRefusal({ driver, episode })).toContain("legacy arm (--episode probing)");
      }
      expect(loopLaunchRefusal({ loop: "snippet", driver, episode: "probing" })).toBeNull();
    }
    expect(loopLaunchRefusal({ loop: "snippet", driver: "pi", episode: "freeplay" })).toContain("runs only the snippet loop for now");
    expect(loopLaunchRefusal({ loop: "snippet", driver: "claude-code", episode: "freeplay" })).toContain("runs the program loop (--loop program)");
    expect(loopLaunchRefusal({ loop: "program", driver: "openai", episode: "freeplay" })).toBeNull();
    expect(loopLaunchRefusal({ loop: "program", driver: "codex", episode: undefined })).toBeNull();
    for (const episode of ["e90", "e360"] as const) expect(loopLaunchRefusal({ loop: "program", driver: "openai", episode })).toContain("scored episodes do not run yet");
    for (const driver of ["stub", "reference"] as const) {
      for (const episode of ["e90", "freeplay", undefined] as const) expect(loopLaunchRefusal({ loop: "snippet", driver, episode })).toBeNull();
    }
  });

  test("the loop is identity: a stored config reloads it, as a resume does", () => {
    const c = configFromArgs([...BASE, "--loop", "program", "--yield", "true"], {});
    const again = loadRunConfig(JSON.parse(JSON.stringify(c)));
    expect(again.loop).toBe("program");
    expect(again.yield).toBe(true);
  });

  test("refused off the fixed loop, claude-code and codex, on a route driver, and --yield without it; run at fan-out", () => {
    const refused = (extra: string[]): string => {
      try {
        configFromArgs([...BASE.filter((a, i, all) => !(a === "stub" && all[i - 1] === "--driver") && a !== "--driver"), ...extra], {});
        return "";
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    };
    expect(refused(["--driver", "stub", "--yield", "true"])).toContain("needs --loop program");
    expect(refused(["--driver", "pi", "--loop", "program"])).toContain("runs a CLI's own turn loop");
    // One program drives every character of a fan-out run.
    expect(refused(["--driver", "stub", "--loop", "program", "--max-characters", "2", "--accounts", "ALPHA,BRAVO", "--episode", "freeplay"])).toBe("");
    expect(refused(["--driver", "stub", "--loop", "nope"])).toContain("--loop takes program or snippet");
    // A continuation runs it: its files and memory come along (`carryProgramFiles`).
    expect(programLoopRefusal({ loop: "program", driver: "openai", episode: "freeplay" })).toBeNull();
    expect(programLoopRefusal({ loop: "program", driver: "openai", episode: "probing" })).toBeNull();
    // codex and claude-code run it (the turn-end pause is the sleep, and yield inside a turn); pi does not yet.
    expect(programLoopRefusal({ loop: "program", yield: true, driver: "codex", episode: "probing" })).toBeNull();
    expect(programLoopRefusal({ loop: "program", yield: true, driver: "claude-code", episode: "probing" })).toBeNull();
    expect(programLoopRefusal({ loop: "program", driver: "claude-code", episode: "probing" })).toBeNull();
    expect(programLoopRefusal({ loop: "program", driver: "pi", episode: "probing" })).toContain("runs a CLI's own turn loop");
    expect(programLoopRefusal({ loop: "snippet", driver: "openai", episode: "e90" })).toBeNull();
  });

  test("a continuation on the program loop carries the files and memory.json, not the versions or the registry", () => {
    const from = tempDir("wrathbench-carry-from-");
    const to = tempDir("wrathbench-carry-to-");
    mkdirSync(join(from, "program", "files", "lib"), { recursive: true });
    mkdirSync(join(from, "program", "deploys", "3"), { recursive: true });
    writeFileSync(join(from, "program", "files", "main.ts"), "export async function grind() {}\n");
    writeFileSync(join(from, "program", "files", "lib", "pull.ts"), "export const x = 1;\n");
    writeFileSync(join(from, "program", "files", "memory.json"), '{"phase":"grind"}');
    writeFileSync(join(from, "program", "registry.json"), '{"deploy":3,"attempted":3,"routines":[{"name":"grind","state":"running"}]}');
    expect(carryProgramFiles(from, to)).toBe(true);
    expect(readFileSync(join(to, "program", "files", "memory.json"), "utf8")).toBe('{"phase":"grind"}');
    expect(readFileSync(join(to, "program", "files", "lib", "pull.ts"), "utf8")).toBe("export const x = 1;\n");
    expect(readdirSync(join(to, "program")).sort()).toEqual(["files"]);
    // A snippet-loop predecessor has no files: the workspace starts empty.
    expect(carryProgramFiles(tempDir("wrathbench-carry-none-"), tempDir("wrathbench-carry-to2-"))).toBe(false);
  });

  test("a continuation whose character is gone drops the files it carried, before the sandbox loads them", () => {
    const from = tempDir("wrathbench-drop-from-");
    const to = tempDir("wrathbench-drop-to-");
    mkdirSync(join(from, "program", "files"), { recursive: true });
    writeFileSync(join(from, "program", "files", "main.ts"), "export async function grind() {}\n");
    writeFileSync(join(from, "program", "files", "memory.json"), '{"phase":"grind"}');
    expect(carryProgramFiles(from, to)).toBe(true);
    dropCarriedProgramFiles(to);
    expect(readdirSync(join(to, "program", "files"))).toEqual([]);
  });

  test("both flags parse, and an arm may carry them", () => {
    expect(parseRunArgs(["--loop", "program", "--yield", "true"])).toEqual({ loop: "program", yield: "true" });
  });

  test("a campaign pair refuses the program loop on pi, and --yield where the arm runs the snippet loop", () => {
    const roster: Record<string, PairRosterEntry> = { ds: { driver: "openai" }, cc: { driver: "claude-code" }, cx: { driver: "codex" }, pi: { driver: "pi" } };
    const arms = [
      { id: "snippet" },
      { id: "program", args: ["--loop", "program"] },
      { id: "program-yield", args: ["--loop", "program", "--yield", "true"] },
      { id: "stray", args: ["--yield", "true"] },
    ];
    const c = {
      name: "program-probe",
      version: 1,
      arms,
      assignments: [{ model: "ds", runsPerCell: 1 }, { model: "cc", runsPerCell: 1 }, { model: "cx", runsPerCell: 1 }, { model: "pi", runsPerCell: 1 }],
    };
    const out = campaignPairRefusals(c, roster).map((r) => `${r.ref}:${r.arm}`);
    // `--yield` alone is the program loop's on the drivers that run it by default; pi runs the snippet loop.
    expect(out.sort()).toEqual(["pi:program", "pi:program-yield", "pi:stray"]);
    // One agent driving the whole party runs the program loop too.
    const oneAgent = { ...c, arms: [{ id: "one-agent", agents: 1 as const, args: ["--loop", "program"] }] };
    expect(campaignPairRefusals(oneAgent, roster).map((r) => `${r.ref}:${r.arm}`)).toEqual(["pi:one-agent"]);
  });
});

describe("the program prompt", () => {
  const program = buildSystemPrompt(undefined, "probing", "wrathbench", true, 5_400_000, { yield: false });
  const programYield = buildSystemPrompt(undefined, "probing", "wrathbench", true, 5_400_000, { yield: true });

  test("the snippet loop's prompt is the one it always was", () => {
    expect(buildSystemPrompt(undefined, undefined, "wrathbench", true, null, undefined)).toBe(SYSTEM_PROMPT);
    expect(buildSystemPrompt(undefined, undefined, "wrathbench", true, null, programPromptOf({}))).toBe(SYSTEM_PROMPT);
  });

  test("every passage that described the persistent REPL is replaced, and the approved text is in its place", () => {
    for (const gone of [
      "Top-level const/let/var/function/class declarations persist across snippets",
      "import is not available",
      "Your only way to act.",
      "including from a background routine.",
      "losing all bindings and routines",
      "Act through tools every turn",
      "You write TypeScript snippets that run in a persistent sandbox",
    ]) {
      expect(program).not.toContain(gone);
    }
    expect(program).toContain(PROGRAM_RUNTIME_LEAD);
    expect(program).toContain("## Your program\n\nYour workspace is a small directory of files that outlives the sandbox;");
    expect(program).toContain("## Snippets\n\nrun_snippet runs TypeScript once, now:");
    expect(program).toContain("- memory: one plain JSON object the harness keeps for you");
    expect(program).toContain('- wake(reason): ask for your own attention from a routine, e.g. wake("bags full").');
    expect(program).toContain("- run_snippet: run TypeScript once, now, in the sandbox. Nothing it starts outlives it.");
    expect(program).toContain("- start_routine / stop_routine: start_routine({ name, args? })");
    expect(program).toContain("After you have slept, the turn begins with a [wake] block:");
    expect(program.endsWith(PROGRAM_BODY_TAIL)).toBe(true);
  });

  test("each turn's pad is the pad or a line saying it is unchanged, and a pad edit's miss says where the pad may be; the snippet loop's are as they were", async () => {
    expect(program).toContain("Every turn you receive the current state summary, the most recent events, any harness notices, and your scratchpad, or a line saying it is unchanged since you last saw it in this conversation. After you have slept,");
    expect(SYSTEM_PROMPT).toContain("Every turn you receive the current state summary, the most recent events, any harness notices, and your scratchpad. Older conversation is trimmed");
    expect(program).toContain("There is no read tool: the scratchpad as last written is in this turn's context or earlier in this conversation, and inside a snippet await scratchpad.read() returns it.");
    expect(program).not.toContain("every turn's context already carries the scratchpad");
    expect(SYSTEM_PROMPT).toContain("There is no read tool: every turn's context already carries the scratchpad as last written,");
    const dir = tempDir("wrathbench-program-pad-");
    const ctx = (program: boolean) =>
      ({
        sandbox: {},
        scratchpad: new Scratchpad(join(dir, "pad.md")),
        sessionLive: () => true,
        turn: () => 1,
        secrets: { scrub: (t: string) => t },
        ...(program ? { program: { readFile: () => ({ ok: true, text: "" }) } } : {}),
      }) as never;
    const miss = { old: "absent", new: "x" };
    expect((await callTool(ctx(true), "edit_scratchpad", miss)).text).toBe(PROGRAM_EDIT_SCRATCHPAD_NOT_FOUND);
    expect(PROGRAM_EDIT_SCRATCHPAD_NOT_FOUND).toEndWith("The scratchpad as last written is in this turn's context or earlier in this conversation.");
    expect((await callTool(ctx(false), "edit_scratchpad", miss)).text).toBe("edit_scratchpad: old was not found in the scratchpad; copy the text exactly, whitespace included. The scratchpad as last written is in this turn's context.");
  });

  test("a successful load restarts every running routine, as the stack does", () => {
    expect(program).toContain("When a load succeeds, every running routine is stopped and started again from the top with the same arguments.");
    expect(program).not.toContain("A running routine whose code changed is stopped");
  });

  test("the codex harness renders the program body too, and its snippet body is the one it always was", () => {
    const codexProgram = buildSystemPrompt(undefined, "probing", "codex", true, 5_400_000, { yield: true });
    expect(codexProgram).toContain("## Your program");
    expect(codexProgram).toContain("- yield: sleep until something wakes you.");
    expect(codexProgram.endsWith(`${PROGRAM_BODY_TAIL} ${PROGRAM_YIELD_TAIL}`)).toBe(true);
    expect(buildSystemPrompt(undefined, "probing", "codex", true, 5_400_000, programPromptOf({}))).toBe(buildSystemPrompt(undefined, "probing", "codex", true, 5_400_000));
  });

  test("yield adds one bullet and one closing sentence, and nothing else", () => {
    expect(program).not.toContain("- yield:");
    expect(programYield).toContain("\n- yield: sleep until something wakes you.");
    expect(programYield.endsWith(`${PROGRAM_BODY_TAIL} ${PROGRAM_YIELD_TAIL}`)).toBe(true);
    const bullet = "\n- yield: sleep until something wakes you. yield({ seconds? }) returns when a wake arrives, or after seconds (at most 300, the default), and its result is the [wake] block.";
    expect(programYield.replace(bullet, "").replace(` ${PROGRAM_YIELD_TAIL}`, "")).toBe(program);
  });

  test("an objective keeps the world facts, and wiki off deletes the reference tool from the program body too", () => {
    const steered = buildSystemPrompt("Find the mine.", "probing", "wrathbench", true, 5_400_000, { yield: false });
    expect(steered).toContain(PROGRAM_RUNTIME_LEAD);
    expect(steered).not.toContain("Your goal is to progress your character");
    const noWiki = buildSystemPrompt(undefined, "probing", "wrathbench", false, null, { yield: true });
    expect(noWiki).not.toContain("search_reference");
  });

  test("a resumed program run is told what it kept", () => {
    const note = resumeSessionNote({ character: "Thalvorn", race: 1, class: 2, clock: "40 minutes elapsed of 90", seen: "", program: true });
    expect(note).toContain("your scratchpad, your files and memory were, and the routines that were running are started again from the top.");
    expect(resumeSessionNote({ character: "Thalvorn", race: 1, class: 2, clock: "x", seen: "" })).toContain("Conversation history was not preserved; your scratchpad was. ");
  });
});

describe("the program tools", () => {
  test("served in the prompt's order, yield only on a yield arm; the snippet loop's list is the nine", () => {
    expect(toolsFor({}).map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
    expect(TOOLS.map((t) => t.name)).toEqual(["run_snippet", "recent_events", "state_summary", "search_reference", "write_scratchpad", "edit_scratchpad", "reflect", "log_status", "read_log"]);
    const names = toolsFor({ programTools: { yield: true } }).map((t) => t.name);
    expect(names).toEqual([
      "run_snippet",
      "read_file",
      "write_file",
      "edit_file",
      "delete_file",
      "start_routine",
      "stop_routine",
      "yield",
      "recent_events",
      "state_summary",
      "search_reference",
      "write_scratchpad",
      "edit_scratchpad",
      "reflect",
      "log_status",
      "read_log",
    ]);
    expect(toolsFor({ programTools: { yield: false } }).map((t) => t.name)).not.toContain("yield");
    expect(toolsFor({ programTools: { yield: false }, wikiSearch: false }).map((t) => t.name)).not.toContain("search_reference");
    const run = toolsFor({ programTools: { yield: false } }).find((t) => t.name === "run_snippet")!;
    expect(run.description).toContain("Nothing a snippet declares or starts outlives it");
  });

  test("argument coercion knows the program tools only on a program run; the snippet loop's lookup is unchanged", () => {
    expect(coerceToolArgs("edit_file", '{"path":"main.ts","old_string":"a","new_string":"b"}', { yield: false })).toEqual({
      ok: true,
      args: { path: "main.ts", old_string: "a", new_string: "b" },
    });
    expect(coerceToolArgs("yield", "{}", { yield: true })).toEqual({ ok: true, args: {} });
    expect(isKnownTool("write_file")).toBe(false);
    expect(isKnownTool("yield")).toBe(false);
  });
});

// ------------------------------------------------------------------ waking

/** A clock that only moves when slept on, with things scheduled on it. */
function fakeClock(start = 1_000_000) {
  let t = start;
  const at: { ts: number; fn: () => void }[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
      for (const e of at.filter((x) => x.ts <= t)) {
        at.splice(at.indexOf(e), 1);
        e.fn();
      }
    },
    schedule: (ms: number, fn: () => void) => at.push({ ts: t + ms, fn }),
    advance: (ms: number) => {
      t += ms;
    },
  };
}

const reason = (key: WakeReason["key"], ts: number, inContext = false): WakeReason => ({ key, ts, text: key, inContext });

describe("sleepUntilWake", () => {
  test("nothing wakes it: five minutes, then the cap", async () => {
    const c = fakeClock();
    const r = await sleepUntilWake({ waker: new Waker(), capMs: WAKE_CAP_MS, floorMs: 3_000, stopped: () => false, now: c.now, sleep: c.sleep });
    expect(r).toEqual({ fired: "cap", sleptMs: WAKE_CAP_MS });
  });

  test("a cascade is one wake: the first reason opens a two-second window", async () => {
    const c = fakeClock();
    const w = new Waker();
    c.schedule(60_000, () => w.note(reason("routine_ended", c.now())));
    c.schedule(61_000, () => w.note(reason("error", c.now())));
    const r = await sleepUntilWake({ waker: w, capMs: WAKE_CAP_MS, floorMs: 3_000, stopped: () => false, now: c.now, sleep: c.sleep });
    expect(r.fired).toBe("routine_ended");
    expect(r.sleptMs).toBeGreaterThanOrEqual(62_000);
    expect(r.sleptMs).toBeLessThanOrEqual(62_000 + 250);
    expect(w.peek().map((x) => x.key)).toEqual(["routine_ended", "error"]);
  });

  test("a reason pending as the sleep starts wakes it at the floor", async () => {
    const c = fakeClock();
    const w = new Waker();
    w.note(reason("wake", c.now() - 10_000));
    const r = await sleepUntilWake({ waker: w, capMs: WAKE_CAP_MS, floorMs: 3_000, stopped: () => false, now: c.now, sleep: c.sleep });
    expect(r).toEqual({ fired: "wake", sleptMs: 3_000 });
  });

  test("a stop or a watchdog verdict ends it at once; a queued notice wakes it", async () => {
    const c = fakeClock();
    let stop = false;
    c.schedule(10_000, () => (stop = true));
    const r = await sleepUntilWake({ waker: new Waker(), capMs: WAKE_CAP_MS, floorMs: 3_000, stopped: () => stop, now: c.now, sleep: c.sleep });
    expect(r.fired).toBe("stopped");
    expect(r.sleptMs).toBeLessThanOrEqual(10_250);
    let queued = 0;
    c.schedule(5_000, () => (queued = 1));
    const n = await sleepUntilWake({ waker: new Waker(), capMs: WAKE_CAP_MS, floorMs: 3_000, stopped: () => false, queuedNotices: () => queued, now: c.now, sleep: c.sleep });
    expect(n.fired).toBe("notice");
  });

  test("a yield's own seconds are its cap", async () => {
    const c = fakeClock();
    const r = await sleepUntilWake({ waker: new Waker(), capMs: 20_000, floorMs: 3_000, stopped: () => false, now: c.now, sleep: c.sleep });
    expect(r).toEqual({ fired: "cap", sleptMs: 20_000 });
  });
});

describe("the waker", () => {
  test("what a context showed is no longer news; a program fact is until a wake takes it", () => {
    const w = new Waker();
    w.note(reason("notice", 1, true));
    w.note(reason("died", 2, true));
    w.note(reason("routine_ended", 3));
    w.shown();
    expect(w.peek().map((r) => r.key)).toEqual(["routine_ended"]);
    w.forget("routine_ended", 3);
    expect(w.first()).toBeUndefined();
  });
});

const row = (o: Partial<RoutineRow> & { name: string }): RoutineRow => ({ deploy: 7, startedAt: 0, state: "running", ...o }) as RoutineRow;
const emptyFacts = (o: Partial<ProgramFacts> = {}): ProgramFacts => ({ deploy: 7, routines: [], facts: [], factsDropped: 0, repeats: [], console: { lines: [], total: 0 }, ...o });

describe("renderWake", () => {
  const NOW = 10_000_000;
  const thrown: ProgramFact = {
    kind: "ended",
    ts: NOW - 60_000,
    fresh: true,
    routine: {
      name: "trip",
      deploy: 7,
      startedAt: NOW - 120_000,
      endedAt: NOW - 60_000,
      state: "threw",
      error: { name: "TypeError", text: "TypeError: Cannot read properties of undefined (reading 'guid')", frames: ["at pickTarget (lib/combat.ts:14:22)", "at trip (main.ts:9:3)"], signature: "trip|TypeError|lib/combat.ts:14" },
    },
  };
  const refusal: ProgramFact = { kind: "refusal", ts: NOW - 30_000, routine: "grind", deploy: 7, action: "moveTo", status: "too_far", hint: "the point is 512y away; a move goes at most 300y", signature: "grind||moveTo|too_far", fresh: true };
  const view = (o: Partial<WakeView> = {}): WakeView => ({
    n: 12,
    sleptMs: 245_000,
    fired: "routine_ended",
    capMs: WAKE_CAP_MS,
    reasons: [{ key: "routine_ended", ts: NOW - 60_000, text: "routine ended (trip, threw)", inContext: false }],
    facts: emptyFacts({
      routines: [row({ name: "grind", startedAt: NOW - 720_000, lastAction: { action: "moveTo", ts: NOW - 3_000 } }), row({ name: "trip", state: "threw", startedAt: NOW - 120_000, endedAt: NOW - 60_000, error: (thrown as { routine: RoutineRow }).routine.error })],
      facts: [
        thrown,
        refusal,
        { kind: "preempted", ts: NOW - 20_000, by: { snippet: true }, of: { routine: "grind" }, to: { x: 1, y: 2.25, z: 3 } },
        { kind: "wake", ts: NOW - 10_000, reason: "bags full", routine: "grind" },
      ],
      repeats: [
        { signature: "grind||moveTo|too_far", count: 37, ts: NOW - 5_000 },
        { signature: "trip|TypeError|lib/combat.ts:14", count: 2, ts: NOW - 50_000 },
      ],
      console: { lines: [{ ts: NOW - 1_000, level: "log", routine: "grind", text: "pulling boar", count: 3 }], total: 1204 },
    }),
    signatures: new Map([
      ["trip|TypeError|lib/combat.ts:14", { kind: "error", text: "trip TypeError: Cannot read properties of undefined (reading 'guid')", frames: ["at pickTarget (lib/combat.ts:14:22)", "at trip (main.ts:9:3)"] }],
      ["grind||moveTo|too_far", { kind: "refusal", text: "grind moveTo too_far — the point is 512y away; a move goes at most 300y", frames: [] }],
    ]),
    progress: { level: { from: 4, to: 5 }, quests: 1, deaths: 0 },
    now: NOW,
    ...o,
  });

  test("facts only, every section in its place", () => {
    expect(renderWake(view())).toBe(
      [
        "[wake 12 · slept 4m05s · woke for: routine ended (trip, threw)]",
        "routines:",
        "grind running 12m, deploy 7, last action 3s ago",
        "trip threw 1m ago: TypeError: Cannot read properties of undefined (reading 'guid') at pickTarget (lib/combat.ts:14:22)",
        "errors:",
        "  trip TypeError: Cannot read properties of undefined (reading 'guid') ×3",
        "      at pickTarget (lib/combat.ts:14:22)",
        "      at trip (main.ts:9:3)",
        "refusals:",
        "  grind moveTo too_far — the point is 512y away; a move goes at most 300y ×38",
        "moves replaced:",
        "  routine grind's move to (1.0, 2.3, 3.0) was replaced by your snippet, 20s ago",
        "wake calls:",
        '  grind: "bags full", 10s ago',
        "since you slept: level 4 → 5 · quests completed 1 · deaths 0",
        "program console: 1,204 lines, last 1 shown, repeats folded",
        "  [grind] pulling boar ×3",
      ].join("\n"),
    );
  });

  test("a failed load says what it followed: a restart, or a continuation's carried files", () => {
    const failed = (by: "restart" | "carried") => renderWake(view({ facts: emptyFacts({ facts: [{ kind: "load_failed", ts: NOW - 1_000, error: "main.ts:1 parse error", running: null, by }] }) }));
    expect(failed("restart")).toContain("load after the restart failed: main.ts:1 parse error");
    expect(failed("carried")).toContain("the carried files did not load: main.ts:1 parse error");
    expect(failed("carried")).not.toContain("restart");
  });

  test("the same view is the same bytes; nothing running and the cap say so as facts", () => {
    expect(renderWake(view())).toBe(renderWake(view()));
    const idle = renderWake(view({ fired: "cap", reasons: [], facts: emptyFacts({ routines: [row({ name: "trip", state: "returned", endedAt: NOW - 1_000, value: '"done"' })] }), progress: { xp: 830, quests: 0, deaths: 0 } }));
    expect(idle.split("\n")).toEqual(["[wake 12 · slept 4m05s · woke for: five minutes passed]", "routines:", 'trip returned 1s ago: "done"', "no routine is running", "since you slept: xp +830 · quests completed 0 · deaths 0"]);
    expect(renderWake(view({ fired: "cap", capMs: 30_000, reasons: [], facts: emptyFacts(), progress: null })).split("\n")).toEqual([
      "[wake 12 · slept 4m05s · woke for: 30s passed]",
      "routines: none started",
      "no routine is running",
    ]);
  });

  test("capped: eight signatures, twenty console lines", () => {
    const facts: ProgramFact[] = [];
    const signatures = new Map<string, { kind: "error"; text: string; frames: string[] }>();
    for (let k = 0; k < 11; k++) {
      const sig = `r|E${k}|main.ts:${k}`;
      facts.push({ kind: "error", ts: NOW - k, routine: "r", deploy: 7, error: { name: `E${k}`, text: `E${k}: x`, frames: [], signature: sig }, fresh: true });
      signatures.set(sig, { kind: "error", text: `r E${k}: x`, frames: [] });
    }
    const lines = Array.from({ length: 30 }, (_, k) => ({ ts: NOW - 30 + k, level: "log" as const, routine: "r", text: `line ${k}`, count: 1 }));
    const text = renderWake(view({ facts: emptyFacts({ facts, console: { lines, total: 30 } }), signatures }));
    expect(text.match(/^ {2}r E\d+: x$/gm)?.length).toBe(8);
    expect(text).toContain("  and 3 more");
    expect(text).toContain("program console: 30 lines, last 20 shown, repeats folded");
    expect(text).not.toContain("line 9\n");
    expect(text).toContain("line 29");
  });

  test("the console is capped in characters too: one log call printed over many lines cannot carry the block", () => {
    // Seven entries, about 5.7k characters, each a pretty-printed move result.
    const big = (k: number) => ({ ts: NOW - 10 + k, level: "log" as const, routine: "grind", text: `move ${k} {\n${"  field: value,\n".repeat(40)}}`, count: 1 });
    const text = renderWake(view({ facts: emptyFacts({ console: { lines: [0, 1, 2, 3, 4, 5, 6].map(big), total: 7 } }) }));
    const con = text.slice(text.indexOf("program console:"));
    expect(con.length).toBeLessThan(WAKE_CONSOLE_CHARS + 100);
    expect(con).toStartWith("program console: 7 lines, last 3 shown, repeats folded\n  [grind] move 4 {");
    expect(con).toContain("move 6 {");
    // A newest entry alone over the cap is shown cut to its head, and says so.
    const huge = { ts: NOW, level: "warn" as const, routine: "grind", text: "x".repeat(5_000), count: 2 };
    const cut = renderWake(view({ facts: emptyFacts({ console: { lines: [big(0), huge], total: 3 } }) }));
    const tail = cut.slice(cut.indexOf("program console:"));
    expect(tail).toStartWith("program console: 3 lines, last 1 shown, repeats folded\n  [grind] warn: xxx");
    expect(tail).toMatch(/… \(3,0\d\d more chars\) ×2$/);
    expect(tail.length).toBeLessThan(WAKE_CONSOLE_CHARS + 100);
  });

  test("a routine's error or value the model was shown before is referred to, not repeated", () => {
    const trip = row({ name: "trip", state: "threw", startedAt: NOW - 120_000, endedAt: NOW - 60_000, error: (thrown as { routine: RoutineRow }).routine.error });
    const done = row({ name: "scout", state: "returned", startedAt: NOW - 50_000, endedAt: NOW - 40_000, value: '{ x: 1, y: 2, view: [ "a long list" ] }' });
    const v = view({ fired: "cap", reasons: [], facts: emptyFacts({ routines: [trip, done] }), progress: null, shown: new Set([routineDetailKey(trip)!, routineDetailKey(done)!]) });
    expect(renderWake(v).split("\n")).toEqual(["[wake 12 · slept 4m05s · woke for: five minutes passed]", "routines:", "trip threw 1m ago: TypeError (shown before)", "scout returned 40s ago (value shown before)", "no routine is running"]);
  });

  test("two drains are one span", () => {
    const a = emptyFacts({ facts: [refusal], repeats: [{ signature: "s", count: 2, ts: 1 }], console: { lines: [{ ts: 1, level: "log", routine: "r", text: "a", count: 1 }], total: 5 } });
    const b = emptyFacts({ deploy: 8, facts: [thrown], repeats: [{ signature: "s", count: 3, ts: 4 }], console: { lines: [], total: 2 } });
    const m = mergeFacts(a, b);
    expect(m.deploy).toBe(8);
    expect(m.facts).toEqual([refusal, thrown]);
    expect(m.repeats).toEqual([{ signature: "s", count: 5, ts: 4 }]);
    expect(m.console.total).toBe(7);
  });
});

// --------------------------------------------------- the wake and the loop

/** A program as the wake reads it, with facts the test hands it. */
function fakeProgram() {
  let pending = emptyFacts();
  return {
    beats: 0,
    push(f: ProgramFact, wake: ProgramWake) {
      pending = { ...pending, facts: [...pending.facts, f] };
      wake.onFact(f);
    },
    console(text: string) {
      pending = { ...pending, console: { lines: [...pending.console.lines, { ts: 1, level: "log", routine: "grind", text, count: 1 }], total: pending.console.total + 1 } };
    },
    async beat() {
      this.beats++;
    },
    drainFacts(): ProgramFacts {
      const out = pending;
      pending = emptyFacts({ routines: out.routines });
      return out;
    },
    shown: new Set<string>(),
    shownDetails(): ReadonlySet<string> {
      return new Set(this.shown);
    },
    markShown(rows: readonly RoutineRow[]) {
      for (const r of rows) {
        const k = routineDetailKey(r);
        if (k !== undefined) this.shown.add(k);
      }
    },
    setRoutines(routines: RoutineRow[]) {
      pending = { ...pending, routines };
    },
    forgets: 0,
    forgetShown() {
      this.forgets++;
      this.shown.clear();
    },
    readFile: () => ({ ok: true, text: "" }),
    writeFile: async () => ({ ok: true, text: "" }),
    editFile: async () => ({ ok: true, text: "" }),
    deleteFile: async () => ({ ok: true, text: "" }),
    startRoutine: async () => ({ ok: true, text: "started grind on deploy 2\nroutines:\ngrind running 0s, deploy 2, no action yet" }),
    routines: (): RoutineRow[] => [],
    stopRoutine: async () => ({ ok: true, text: "stopped grind" }),
  };
}

const ended = (ts: number): ProgramFact => ({ kind: "ended", ts, routine: { name: "trip", deploy: 2, startedAt: ts - 5_000, endedAt: ts, state: "returned", value: '"done"' } });

describe("ProgramWake", () => {
  test("records every fact as it happens and a wake record inspect reads; the block passes the run's scrub", async () => {
    const dir = tempDir("wrathbench-wake-");
    const trajectory = new Trajectory(dir);
    trajectory.redact(LEAKED_SECRET);
    const c = fakeClock();
    const wake = new ProgramWake({ trajectory, now: c.now, sleep: c.sleep, counts: () => ({ deaths: 0, quests: 0 }) });
    const p = fakeProgram();
    p.push({ kind: "loaded", ts: c.now(), deploy: 2, routines: ["trip"], restarted: [], dropped: [], by: "save" }, wake);
    p.console(`token=${LEAKED_SECRET}`);
    c.schedule(40_000, () => p.push(ended(c.now()), wake));
    const idle = { asleep: 0, awake: 0, noteAsleep() { this.asleep++; }, noteAwake() { this.awake++; } };
    const woke = await wake.sleep(p, { via: "turn-end", turn: 3, capMs: WAKE_CAP_MS, floorMs: 3_000, stopped: () => false, kept: false, idle });
    expect(woke.fired).toBe("routine_ended");
    expect(idle).toMatchObject({ asleep: 1, awake: 1 });
    expect(p.beats).toBe(1);
    expect(woke.block).toContain("[wake 1 · slept 42s · woke for: routine ended (trip, returned)]");
    expect(woke.block).toContain("token=[redacted]");
    expect(woke.block).not.toContain(LEAKED_SECRET);
    trajectory.close();
    const records = readTrajectory(dir);
    expect(records.find((r) => r.t === "deploy")).toMatchObject({ ok: true, by: "save", deploy: 2 });
    expect(records.find((r) => r.t === "routine")).toMatchObject({ event: "ended", name: "trip", state: "returned" });
    expect(records.find((r) => r.t === "wake")).toMatchObject({ via: "turn-end", turn: 3, fired: "routine_ended", sleptMs: 42_000, maxMs: WAKE_CAP_MS, reasons: ["routine_ended"] });
  });

  test("a wake that stays in the conversation marks the routine values it showed; a fixed-loop turn-end wake, never kept, does not", async () => {
    const c = fakeClock();
    const wake = new ProgramWake({ trajectory: { append: () => {}, scrub: (t) => t }, now: c.now, sleep: c.sleep });
    const p = fakeProgram();
    p.setRoutines([{ name: "trip", deploy: 2, startedAt: c.now() - 5_000, endedAt: c.now(), state: "returned", value: '"done"' }]);
    const sleep = (via: "turn-end" | "yield", kept: boolean) => wake.sleep(p, { via, turn: 1, capMs: 10_000, floorMs: 3_000, stopped: () => false, kept });
    // The fixed loop's turn-end message is gone after the next sleep: shown whole each time.
    expect((await sleep("turn-end", false)).block).toContain('trip returned 10s ago: "done"');
    expect((await sleep("turn-end", false)).block).toContain('trip returned 20s ago: "done"');
    // A yield result stays: shown whole once, referred to after.
    expect((await sleep("yield", true)).block).toContain('trip returned 30s ago: "done"');
    expect((await sleep("yield", true)).block).toContain("trip returned 40s ago (value shown before)");
  });

  test("a fact from while the model was awake still wakes the next sleep, unless a routine tool showed it", async () => {
    const c = fakeClock();
    const wake = new ProgramWake({ trajectory: { append: () => {}, scrub: (t) => t }, now: c.now, sleep: c.sleep });
    const p = fakeProgram();
    p.push(ended(c.now()), wake);
    c.advance(1_000);
    const first = await wake.sleep(p, { via: "turn-end", turn: 1, capMs: WAKE_CAP_MS, floorMs: 3_000, stopped: () => false, kept: false });
    expect(first).toMatchObject({ fired: "routine_ended", sleptMs: 3_000 });
    p.push(ended(c.now()), wake);
    c.advance(1_000);
    wake.routinesShown();
    const second = await wake.sleep(p, { via: "turn-end", turn: 2, capMs: WAKE_CAP_MS, floorMs: 3_000, stopped: () => false, kept: false });
    expect(second.fired).toBe("cap");
    // The end is still in the block's own lines: it was drained as the sleep began.
    expect(second.block).toContain("[wake 2 · slept 5m00s · woke for: five minutes passed]");
  });

  test("a refusal a tool result carried does not wake a later sleep, even when its fact lands late; a new one does", async () => {
    // A refusal of one deploy, shown in a result, then a save, then a yield that woke at its floor for it.
    const c = fakeClock(10_000_000);
    const wake = new ProgramWake({ trajectory: { append: () => {}, scrub: (t) => t }, now: c.now, sleep: c.sleep });
    const p = fakeProgram();
    const refusal = (ts: number, status: string): ProgramFact => ({ kind: "refusal", ts, routine: "grind", deploy: 6, action: "moveTo", status, hint: "h", signature: `grind||moveTo|${status}`, fresh: true });
    p.push(refusal(c.now(), "path_incomplete"), wake);
    c.advance(500);
    const late = refusal(c.now() - 200, "too_far");
    const hint = (status: string): ActionHintNote => ({ action: "moveTo", status, count: 1, hint: "h", ts: c.now(), routine: "grind" });
    // The result carries both hints, as the stack's `onHintsDelivered` says.
    wake.hintsDelivered([hint("path_incomplete"), hint("too_far")]);
    // Its fact arrives after the result that carried its hint: still not news.
    p.push(late, wake);
    const first = await wake.sleep(p, { via: "yield", turn: 1, capMs: WAKE_CAP_MS, floorMs: 3_000, stopped: () => false, kept: true });
    expect(first.fired).toBe("cap");
    // The signatures are still the wake's to show.
    expect(first.block).toContain("path_incomplete");
    c.schedule(30_000, () => p.push(refusal(c.now(), "no_path"), wake));
    const second = await wake.sleep(p, { via: "yield", turn: 2, capMs: WAKE_CAP_MS, floorMs: 3_000, stopped: () => false, kept: true });
    expect(second.fired).toBe("refusal");
    // After a load, a delivered signature's first refusal on the new code is news again.
    p.push({ kind: "loaded", ts: c.now(), deploy: 7, routines: ["grind"], restarted: ["grind"], dropped: [], by: "save" }, wake);
    c.schedule(30_000, () => p.push(refusal(c.now(), "too_far"), wake));
    const third = await wake.sleep(p, { via: "yield", turn: 3, capMs: WAKE_CAP_MS, floorMs: 3_000, stopped: () => false, kept: true });
    expect(third.fired).toBe("refusal");
  });

  test("a refusal that lands after the hint drain, before the result returns, still wakes: only what a result carried is delivered", async () => {
    // The millisecond window when delivery was "everything up to the moment the result returned".
    const c = fakeClock(10_000_000);
    const wake = new ProgramWake({ trajectory: { append: () => {}, scrub: (t) => t }, now: c.now, sleep: c.sleep });
    const p = fakeProgram();
    const refusal = (ts: number, status: string): ProgramFact => ({ kind: "refusal", ts, routine: "grind", deploy: 6, action: "moveTo", status, hint: "h", signature: `grind||moveTo|${status}`, fresh: true });
    p.push(refusal(c.now(), "too_far"), wake);
    wake.hintsDelivered([{ action: "moveTo", status: "too_far", count: 1, hint: "h", ts: c.now(), routine: "grind" }]);
    c.advance(1);
    p.push(refusal(c.now(), "drop"), wake);
    const woke = await wake.sleep(p, { via: "yield", turn: 1, capMs: WAKE_CAP_MS, floorMs: 3_000, stopped: () => false, kept: true });
    expect(woke.fired).toBe("refusal");
    expect(woke.block).toContain("new refusal (grind: moveTo drop)");
    expect(woke.block).not.toContain("new refusal (grind: moveTo too_far)");
  });

  test("a wake(reason) from a routine the routine lines showed as over does not wake; a running routine's still does", async () => {
    // explore called wake("explore done") and returned while the model was awake; a stop_routine result showed it returned.
    const c = fakeClock(10_000_000);
    const wake = new ProgramWake({ trajectory: { append: () => {}, scrub: (t) => t }, now: c.now, sleep: c.sleep });
    const p = fakeProgram();
    const started = c.now() - 60_000;
    p.push({ kind: "wake", ts: c.now(), reason: "explore done", routine: "explore" }, wake);
    p.push({ kind: "wake", ts: c.now(), reason: "bags full", routine: "grind" }, wake);
    p.push({ kind: "wake", ts: c.now(), reason: "old leg done", routine: "work" }, wake);
    c.advance(1_000);
    wake.routinesShown([
      row({ name: "explore", state: "returned", startedAt: started, endedAt: c.now() - 500 }),
      row({ name: "grind", state: "running", startedAt: started }),
      // Replaced by a newer run since its call.
      row({ name: "work", state: "running", startedAt: c.now() - 100 }),
    ]);
    const woke = await wake.sleep(p, { via: "yield", turn: 1, capMs: WAKE_CAP_MS, floorMs: 3_000, stopped: () => false, kept: true });
    expect(woke.fired).toBe("wake");
    expect(woke.block).toContain('woke for: wake("bags full") from grind]');
    // The calls themselves are still the wake's to list.
    expect(woke.block).toContain('explore: "explore done"');
  });

  test("a death a result told the model of, by a dead hint, does not wake the sleep after it", async () => {
    // The turn's own result showed `moveTo dead ×8`; the turn-end sleep woke 3 s later for the death.
    const c = fakeClock(10_000_000);
    const wake = new ProgramWake({ trajectory: { append: () => {}, scrub: (t) => t }, now: c.now, sleep: c.sleep });
    const p = fakeProgram();
    // The context went out; the death came after it, so the HUD never showed it.
    wake.shown();
    c.advance(1_000);
    wake.onDeath(c.now());
    c.advance(1_000);
    wake.hintsDelivered([{ action: "moveTo", status: "dead", count: 8, hint: "you are dead", ts: c.now(), routine: "work" }]);
    const first = await wake.sleep(p, { via: "turn-end", turn: 1, capMs: WAKE_CAP_MS, floorMs: 3_000, stopped: () => false, kept: false });
    expect(first.fired).toBe("cap");
    // A later death, told of by no hint, wakes.
    c.schedule(10_000, () => wake.onDeath(c.now()));
    const second = await wake.sleep(p, { via: "turn-end", turn: 2, capMs: WAKE_CAP_MS, floorMs: 3_000, stopped: () => false, kept: false });
    expect(second.fired).toBe("died");
  });

  test("a death and a closed stream wake; a notice the context showed does not", async () => {
    const c = fakeClock();
    const wake = new ProgramWake({ trajectory: { append: () => {}, scrub: (t) => t }, now: c.now, sleep: c.sleep });
    const p = fakeProgram();
    wake.onNotice({ kind: "session_note", ts: c.now() });
    wake.shown();
    wake.onSample({ observation: { connected: true } });
    c.schedule(30_000, () => wake.onSample({ observation: { connected: false } }));
    expect((await wake.sleep(p, { via: "turn-end", turn: 1, capMs: WAKE_CAP_MS, floorMs: 3_000, stopped: () => false, kept: false })).fired).toBe("stream_closed");
    c.schedule(30_000, () => wake.onDeath(c.now()));
    expect((await wake.sleep(p, { via: "yield", turn: 2, capMs: WAKE_CAP_MS, floorMs: 3_000, stopped: () => false, kept: true })).fired).toBe("died");
  });

  test("a restart the program is blamed for is counted once, for snippet-runaway", () => {
    const wake = new ProgramWake({ trajectory: { append: () => {}, scrub: (t) => t } });
    wake.onFact({ kind: "restart", ts: 1, blamed: true, restarted: [], interrupted: [row({ name: "spin", state: "interrupted" })] });
    wake.onFact({ kind: "restart", ts: 2, blamed: false, restarted: [row({ name: "grind" })], interrupted: [] });
    expect(wake.takeBlamedRestarts()).toBe(1);
    expect(wake.takeBlamedRestarts()).toBe(0);
    expect(wake.waker.peek().map((r) => r.key)).toEqual(["sandbox_restart", "sandbox_restart"]);
  });
});

describe("watchdogs: asleep is not idle", () => {
  test("the idle clock stops while the model sleeps and resumes when it wakes", () => {
    let t = 0;
    const w = new Watchdogs({ idleMs: 1_000, noXpMs: null, episodeMs: null, maxSandboxRestarts: 3 }, () => t);
    t = 500;
    w.noteAsleep();
    t = 10_000;
    expect(w.check()).toBeNull();
    w.noteAwake();
    t = 10_400;
    expect(w.check()).toBeNull();
    t = 10_600;
    expect(w.check()?.reason).toBe("idle");
  });
});

function programSetup(script: ConstructorParameters<typeof StubAdapter>[0], o: { yield?: boolean } = {}) {
  const dir = tempDir("wrathbench-program-loop-");
  const config = {
    ...loadRunConfig({ driver: "stub", stepIntervalMs: 3_000, stateIntervalMs: 1, loop: "program", ...(o.yield === true ? { yield: true } : {}) }),
    runId: "run-program",
    token: "run-program",
  };
  const trajectory = new Trajectory(dir);
  trajectory.writeMeta({ runId: "run-program", harnessVersion: "t", startedAt: Date.now(), config });
  const c = fakeClock(Date.now());
  const wake = new ProgramWake({ trajectory, now: c.now, sleep: c.sleep });
  const program = fakeProgram();
  const sandbox = {
    evalSnippet: async (code: string) => ({ ok: true, value: `ran:${code}`, logs: [], durationMs: 1 }),
    recentEvents: () => Promise.resolve([]),
    stateSnapshot: () => Promise.resolve({ self: {}, lastSeq: -1, eventCount: 0 }),
    totalRestarts: 0,
    consecutiveRestarts: 0,
    drainNotices: () => [],
    stop: () => Promise.resolve(),
    program,
  } as unknown as SandboxHost;
  const requests: ChatRequest[] = [];
  const adapter = new StubAdapter(script);
  const recording = { label: adapter.label, complete: (req: ChatRequest) => (requests.push(req), adapter.complete(req)) };
  return {
    dir,
    clock: c,
    program,
    wake,
    requests,
    options: {
      config,
      adapter: recording,
      sandbox,
      scratchpad: new Scratchpad(join(dir, "scratchpad.md")),
      episodic: new EpisodicLog(join(dir, "episodic.jsonl")),
      trajectory,
      watchdogs: new Watchdogs(config.watchdogs),
      sleep: () => Promise.resolve(),
      programWake: wake,
    },
  };
}

const userOf = (req: ChatRequest): string => String(req.messages[req.messages.length - 1]!.content);

describe("the fixed loop on the program loop", () => {
  test("a reply with no tool call sleeps; the wake opens every request until the next sleep", async () => {
    const s = programSetup([
      { content: "starting", toolCalls: [{ name: "start_routine", arguments: { name: "trip" } }] },
      { content: "waiting for trip", toolCalls: [] },
      { content: null, toolCalls: [{ name: "run_snippet", arguments: { code: "1" } }] },
      { content: "and again", toolCalls: [] },
    ]);
    s.clock.schedule(90_000, () => s.program.push(ended(s.clock.now()), s.wake));
    const outcome = await runLoop(s.options);
    expect(outcome).toEqual({ kind: "terminated", reason: "stub-complete" });
    expect(s.requests).toHaveLength(5);
    // The program prompt and the program's tools are what was sent.
    expect(String(s.requests[0]!.messages[0]!.content)).toContain("## Your program");
    expect(s.requests[0]!.tools.map((t) => t.name)).toContain("start_routine");
    expect(s.requests[0]!.tools.map((t) => t.name)).not.toContain("yield");
    expect(userOf(s.requests[0]!)).not.toContain("[wake");
    expect(userOf(s.requests[1]!)).not.toContain("[wake");
    // After the sleep: the block right after the turn's number, on both requests of the wake.
    const third = userOf(s.requests[2]!);
    expect(third.startsWith("[turn 3]\n\n[wake 1 · slept 1m32s · woke for: routine ended (trip, returned)]")).toBe(true);
    const block = third.split("\n\n")[1]!;
    expect(userOf(s.requests[3]!)).toContain(block);
    // The second sleep found nothing: five minutes, and its own block.
    expect(userOf(s.requests[4]!)).toContain("[wake 2 · slept 5m00s · woke for: five minutes passed]");
    s.options.trajectory.close();
    const wakes = readTrajectory(s.dir).filter((r) => r.t === "wake");
    expect(wakes.map((w) => [w["via"], w["turn"], w["fired"]])).toEqual([
      ["turn-end", 2, "routine_ended"],
      ["turn-end", 4, "cap"],
    ]);
  });

  test("a routine result longer than the window keeps is not counted as shown; a turn-end wake, never kept, marks nothing", async () => {
    const s = programSetup([
      { content: null, toolCalls: [{ name: "stop_routine", arguments: { name: "grind" } }] },
      { content: null, toolCalls: [{ name: "stop_routine", arguments: { name: "grind" } }] },
      { content: "waiting", toolCalls: [] },
    ]);
    const texts = ["stopped grind\nroutines:\ngrind stopped 0s ago", `stopped grind\nroutines:\n${"trip threw 1m ago: Error: in view [ … ]\n".repeat(120)}`];
    s.program.stopRoutine = async () => ({ ok: true, text: texts.shift()! });
    s.program.setRoutines([{ name: "trip", deploy: 2, startedAt: s.clock.now() - 5_000, endedAt: s.clock.now(), state: "returned", value: '"done"' }]);
    await runLoop(s.options);
    // The first result fit; the second was cut by the window, so the ledger was cleared.
    expect(s.program.forgets).toBe(1);
    expect(userOf(s.requests[3]!)).toContain('trip returned');
    expect(s.program.shown.size).toBe(0);
  });

  test("a refusal from before a tool result is delivered with it, so the turn-end sleep after does not wake for it", async () => {
    const s = programSetup([
      { content: null, toolCalls: [{ name: "run_snippet", arguments: { code: "1" } }] },
      { content: "waiting", toolCalls: [] },
    ]);
    s.program.push({ kind: "refusal", ts: s.clock.now(), routine: "grind", deploy: 2, action: "moveTo", status: "too_far", hint: "h", signature: "grind||moveTo|too_far", fresh: true }, s.wake);
    // The snippet's result carries the routine's hint, as the child drains it onto the result.
    const hint: ActionHintNote = { action: "moveTo", status: "too_far", count: 1, hint: "h", ts: s.clock.now(), routine: "grind" };
    (s.options.sandbox as unknown as { evalSnippet: unknown }).evalSnippet = async (code: string) => ({ ok: true, value: `ran:${code}`, logs: [], actionHints: [hint], durationMs: 1 });
    await runLoop(s.options);
    expect(s.requests[1]!.messages.some((m) => m.role === "tool" && (m.content ?? "").includes("moveTo too_far (routine grind): h"))).toBe(true);
    expect(userOf(s.requests[2]!)).toContain("woke for: five minutes passed]");
  });

  test("the same refusal with no result to carry its hint wakes the turn-end sleep", async () => {
    const s = programSetup([
      { content: null, toolCalls: [{ name: "run_snippet", arguments: { code: "1" } }] },
      { content: "waiting", toolCalls: [] },
    ]);
    s.program.push({ kind: "refusal", ts: s.clock.now(), routine: "grind", deploy: 2, action: "moveTo", status: "too_far", hint: "h", signature: "grind||moveTo|too_far", fresh: true }, s.wake);
    await runLoop(s.options);
    expect(userOf(s.requests[2]!)).toContain("woke for: new refusal (grind: moveTo too_far)]");
  });

  test("yield answers the wake as its result, and the next request does not repeat it", async () => {
    const s = programSetup(
      [
        { content: null, toolCalls: [{ name: "yield", arguments: { seconds: 900 } }] },
        { content: null, toolCalls: [{ name: "write_scratchpad", arguments: { content: "# notes" } }] },
      ],
      { yield: true },
    );
    s.clock.schedule(20_000, () => s.program.push({ kind: "wake", ts: s.clock.now(), reason: "bags full", routine: "grind" }, s.wake));
    await runLoop(s.options);
    expect(s.requests[0]!.tools.map((t) => t.name)).toContain("yield");
    s.options.trajectory.close();
    const records = readTrajectory(s.dir);
    const result = records.find((r) => r.t === "tool_result" && r["name"] === "yield");
    expect(String(result?.["text"])).toContain('[wake 1 · slept 22s · woke for: wake("bags full") from grind]');
    expect(userOf(s.requests[1]!)).not.toContain("[wake");
    expect(records.find((r) => r.t === "wake")).toMatchObject({ via: "yield", turn: 1, fired: "wake", maxMs: WAKE_CAP_MS });
  });
});

describe("the window cap and the program's tools", () => {
  test("read_file and yield results are sent whole; every other message is capped as it always was", () => {
    const long = "x".repeat(10_000);
    const call = (id: string, name: string) => ({ id, type: "function" as const, function: { name, arguments: "{}" } });
    const window: HistoryMessage[] = [
      { role: "assistant", content: null, tool_calls: [call("a", "read_file"), call("b", "run_snippet"), call("c", "yield")] },
      { role: "tool", tool_call_id: "a", content: long },
      { role: "tool", tool_call_id: "b", content: long },
      { role: "tool", tool_call_id: "c", content: long },
    ];
    const sent = renderWindow(window, 0).map((m) => String(m.content));
    expect(sent[1]).toBe(long);
    expect(sent[2]).toBe(capWindowMessage({ role: "tool", tool_call_id: "b", content: long }).content as string);
    expect(sent[2]).toEndWith(`…[truncated ${10_000 - CONTEXT_POLICY.WINDOW_MESSAGE_CHARS} chars]`);
    expect(sent[3]).toBe(long);
    // Folded like any result once the window's older block.
    expect(String(renderWindow(window, 4)[1]!.content)).toStartWith("[folded by harness] read_file");
  });
});

describe("PadSeen: a scaffold's program loop sends the pad only when its thread does not hold it", () => {
  const inputs = (pad: string, unchanged?: boolean) => ({ stateSummary: "== state ==", events: [], scratchpad: pad, notices: [], turn: 3, ...(unchanged !== undefined ? { scratchpadUnchanged: unchanged } : {}) });

  test("the first message sends it, an unchanged pad is a line with its size, a change outside the conversation sends it again", () => {
    const seen = new PadSeen();
    expect(seen.sendWhole("# plan\nfarm boars")).toBe(true);
    expect(seen.sendWhole("# plan\nfarm boars")).toBe(false);
    // A routine's scratchpad.write: the conversation never saw it.
    expect(seen.sendWhole("# plan\nfarm wolves")).toBe(true);
    expect(seen.sendWhole("# plan\nfarm wolves")).toBe(false);
    seen.reset();
    expect(seen.sendWhole("# plan\nfarm wolves")).toBe(true);
    // An empty pad is always its one line.
    expect(seen.sendWhole("")).toBe(true);
    expect(seen.sendWhole("")).toBe(true);
  });

  test("the model's own write and edit leave a pad the conversation holds; an edit of a pad it did not hold does not", () => {
    const seen = new PadSeen();
    seen.sendWhole("a\nb");
    seen.wrote("x\ny", "x\ny");
    expect(seen.sendWhole("x\ny")).toBe(false);
    seen.edited("y", "z", false, "x\nz");
    expect(seen.sendWhole("x\nz")).toBe(false);
    // A snippet appended between, so the edit's result is not what the model can know.
    seen.edited("z", "w", false, "x\nw\nappended");
    expect(seen.sendWhole("x\nw\nappended")).toBe(true);
    seen.reset();
    seen.edited("w", "v", false, "x\nv\nappended");
    expect(seen.sendWhole("x\nv\nappended")).toBe(true);
  });

  test("the line in its place keeps the size and is no pad header, and the snippet loop's context is byte-identical", () => {
    const pad = "# plan\n".repeat(500);
    const unchanged = assembleContext(inputs(pad, true));
    expect(unchanged).toEndWith(`[scratchpad 3.5k/32k: unchanged since you last saw it in this conversation, so not repeated]`);
    expect(unchanged).not.toContain("# plan");
    expect(unchanged.endsWith(scratchpadUnchangedLine(pad.length))).toBe(true);
    // The inspect readers' pad header (a JSON-escaped line) must not match it.
    expect(new RegExp(PAD_HEADER_PATTERN).test(JSON.stringify(unchanged))).toBe(false);
    expect(new RegExp(PAD_HEADER_PATTERN).test(JSON.stringify(assembleContext(inputs(pad))))).toBe(true);
    expect(assembleContext(inputs(pad))).toBe(assembleContext(inputs(pad, false)));
    expect(assembleContext(inputs(pad))).toEndWith(`[scratchpad 3.5k/32k]\n${pad}`);
  });
});

describe("the program loop at fan-out", () => {
  const names = (defs: { name: string }[]): string[] => defs.map((d) => d.name);
  const props = (defs: { name: string; inputSchema: Record<string, unknown> }[], name: string): string[] =>
    Object.keys(defs.find((d) => d.name === name)!.inputSchema["properties"] as object);

  test("one character is served, byte for byte, what the program loop served before fan-out ran it", () => {
    const golden = readFileSync(join(import.meta.dir, "fixtures", "program1-tools.json"), "utf8");
    expect(`${JSON.stringify(program1Tools(), null, 2)}\n`).toBe(golden);
  });

  test("the list is the program loop's, in its order, with a character where one acts, and the roster's three after", () => {
    const fan = toolsFor({ programTools: { yield: true }, fanout: true });
    expect(names(fan)).toEqual([
      "run_snippet",
      "read_file",
      "write_file",
      "edit_file",
      "delete_file",
      "start_routine",
      "stop_routine",
      "yield",
      "recent_events",
      "state_summary",
      "search_reference",
      "write_scratchpad",
      "edit_scratchpad",
      "reflect",
      "log_status",
      "read_log",
      "login_character",
      "logout_character",
      "list_characters",
    ]);
    for (const n of ["run_snippet", "start_routine", "stop_routine", "recent_events", "state_summary"]) expect(props(fan, n)).toContain("character");
    expect(fan.find((d) => d.name === "run_snippet")!.description).toEndWith(PROGRAM_FANOUT_RUN_SNIPPET_SENTENCE);
    // The same tools however a caller asks: a context's sandbox holding the roster, or `fanout` said outright.
    expect(toolsFor({ programTools: { yield: true, characters: true } })).toEqual(fan);
    expect(toolsFor({ programTools: { yield: false }, fanout: true }).map((d) => d.name)).not.toContain("yield");
  });

  test("the session note names the routine tools among those that take a character, and a resume says what the program kept", () => {
    const fresh = fanoutSessionNote({ characters: 5, staged: ["Alfa"], resumed: false, back: [], lost: [], program: true });
    expect(fresh).toContain("the `character` argument of run_snippet, start_routine, stop_routine, recent_events and state_summary takes.");
    expect(fanoutSessionNote({ characters: 5, staged: ["Alfa"], resumed: false, back: [], lost: [] })).toContain("the `character` argument of run_snippet, recent_events and state_summary takes.");
    const resumed = fanoutSessionNote({ characters: 5, staged: [], resumed: true, back: ["Alfa"], lost: [], program: true });
    expect(resumed).toStartWith(`the runner process was restarted and this run resumed after a pause. ${PROGRAM_RESUME_KEPT} This run may have`);
  });

  test("each record's death names its character; one character's dead hint forgets only its own death", () => {
    const signals = new RecordSignals();
    const died: [number, string | undefined][] = [];
    signals.onDeath = (ts, character) => died.push([ts, character]);
    signals.onRowsOf("Alfa")("events", [{ ts: 5, kind: "death" } as never]);
    signals.onRows("events", [{ ts: 6, kind: "death" } as never]);
    expect(died).toEqual([
      [5, "Alfa"],
      [6, undefined],
    ]);
    expect(signals.counts().deaths).toBe(2);

    const wake = new ProgramWake({ trajectory: { append: () => {}, scrub: (t) => t } });
    wake.onDeath(10, "Alfa");
    wake.onDeath(11, "Bravo");
    expect(wake.waker.peek().map((r) => r.text)).toEqual(["Alfa died", "Bravo died"]);
    wake.hintsDelivered([{ action: "cast_spell", status: "dead", hint: "h", count: 1, ts: 20, character: "Alfa" } as ActionHintNote]);
    expect(wake.waker.peek().map((r) => r.text)).toEqual(["Bravo died"]);
    // Alfa's death from before the hint, landing late, is not news; Bravo's is.
    wake.onDeath(12, "Alfa");
    wake.onDeath(13, "Bravo");
    expect(wake.waker.peek().map((r) => r.text)).toEqual(["Bravo died", "Bravo died"]);
  });

  test("any character's death or closed stream wakes, by name, and a wake names whose level moved", async () => {
    const c = fakeClock();
    const wake = new ProgramWake({ trajectory: { append: () => {}, scrub: (t) => t }, now: c.now, sleep: c.sleep, counts: () => ({ deaths: 0, quests: 0 }) });
    const p = fakeProgram();
    const seats = (alfa: number, bravoConnected = true) => [
      { character: "Alfa", level: alfa, connected: true },
      { character: "Bravo", level: 20, connected: bravoConnected },
    ];
    wake.onSample({ seats: seats(20) });
    c.schedule(30_000, () => wake.onSample({ seats: seats(21) }));
    c.schedule(40_000, () => wake.onDeath(c.now(), "Bravo"));
    const first = await wake.sleep(p, { via: "turn-end", turn: 1, capMs: WAKE_CAP_MS, floorMs: 3_000, stopped: () => false, kept: false });
    expect(first.fired).toBe("died");
    expect(first.block.split("\n")[0]).toBe("[wake 1 · slept 42s · woke for: Bravo died]");
    expect(first.block).toContain("since you slept: Alfa level 20 → 21 · quests completed 0 · deaths 0");
    c.schedule(10_000, () => wake.onSample({ seats: seats(21, false) }));
    const second = await wake.sleep(p, { via: "turn-end", turn: 2, capMs: WAKE_CAP_MS, floorMs: 3_000, stopped: () => false, kept: false });
    expect(second.fired).toBe("stream_closed");
    expect(second.block.split("\n")[0]).toBe("[wake 2 · slept 12s · woke for: Bravo's event stream closed]");
    expect(second.block).toContain("since you slept: quests completed 0 · deaths 0");
  });

  test("the fixed loop serves the fan-out program list and passes a routine's character through", async () => {
    const starts: unknown[] = [];
    const s = programSetup([
      { content: null, toolCalls: [{ name: "start_routine", arguments: { name: "grind", character: "Alfa" } }] },
      { content: "waiting", toolCalls: [] },
    ]);
    (s.program as { startRoutine: (o: unknown) => Promise<{ ok: boolean; text: string }> }).startRoutine = async (o) => (starts.push(o), { ok: true, text: "started grind (Alfa) on deploy 2\nroutines:\ngrind (Alfa) running 0s, deploy 2, no action yet" });
    const brief = (level: number) => ({ self: { guid: "1", level: { value: level } }, observation: { connected: true } });
    (s.options.sandbox as unknown as { roster: unknown }).roster = {
      maxCharacters: 2,
      sandbox: { stateBriefs: async () => ({ Alfa: brief(20), Bravo: brief(20) }) },
      views: () => [
        { character: "Alfa", state: "in" },
        { character: "Bravo", state: "in" },
      ],
    };
    await runLoop(s.options);
    expect(names(s.requests[0]!.tools)).toContain("login_character");
    expect(props(s.requests[0]!.tools as never, "start_routine")).toContain("character");
    expect(starts).toEqual([{ name: "grind", character: "Alfa" }]);
    // The turn's state is the roll-up.
    expect(userOf(s.requests[0]!)).toContain("2 of 2 characters logged in");
  });
});
