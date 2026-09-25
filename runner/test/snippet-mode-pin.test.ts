/**
 * The snippet loop, pinned byte for byte against a fixture captured from the
 * head the entrypoint spike was built on (02bd362a): the rendered system
 * prompts, the tool list, the harness strings, a fresh user message, the
 * snippet compiler's REPL bodies, a launch config, its comparability tuple and
 * the sandbox child's environment. The entrypoint loop is a second body next to
 * all of these, never an edit of them; a failure here means something the
 * snippet loop's model sees (or what its run records) moved.
 *
 * `fixtures/snippet-mode-surface.json` is regenerated only by a deliberate
 * change to the snippet loop, never to make this pass.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CLAUDE_CODE_SYSTEM_PROMPT,
  CODEX_SYSTEM_PROMPT,
  STATE_KEPT_AND_LOST,
  SYSTEM_PROMPT,
  buildSystemPrompt,
  continuedSessionNote,
  resumeSessionNote,
} from "../src/prompt";
import { STATE_LOSS_RECOVERY, STATE_RESET_NOTICE, sandboxChildEnv } from "../src/sandbox/host";
import { TOOLS, toolsFor } from "../src/tools";
import { assembleContext } from "../src/context";
import { compileSnippet } from "../src/sandbox/rewrite";
import { comparabilityOf } from "../src/comparability";
import { configFromArgs } from "../src/run";

const pinned = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "snippet-mode-surface.json"), "utf8")) as Record<
  string,
  unknown
>;

/** What the fixture's `compiled` entries were captured from, in order. */
const COMPILED_SOURCES = [
  "let x = 1; function f() { return 2 }\nx + f()",
  "40 + 2",
  "const { a, b } = { a: 1, b: 2 };\nreturn a + b;",
  "setInterval(() => {}, 1000);\nconst job = new AbortController();",
];

const PARENT_ENV = {
  PATH: "/usr/bin",
  HOME: "/home/x",
  TMPDIR: "/tmp",
  OPENROUTER_KEY: "sk-secret",
  WRATHBENCH_FAULT_WINDOW_MS: "1000",
  WRATHBENCH_DB_PASSWORD: "root",
  WRATHBENCH_MODULE_SECRET: "port-secret",
};
const EXPLICIT_ENV = {
  WRATHBENCH_MODULE_URL: "http://worldserver:8086",
  WRATHBENCH_TOKEN: "t",
  WRATHBENCH_WORKSPACE: "/w",
  WRATHBENCH_SECRET: "",
  WRATHBENCH_ACCOUNT: "",
};

describe("the snippet loop is unchanged", () => {
  test("system prompts, default and per harness, tier and wiki", () => {
    expect(SYSTEM_PROMPT).toBe(pinned["systemPrompt"] as string);
    expect(CLAUDE_CODE_SYSTEM_PROMPT).toBe(pinned["claudeCodeSystemPrompt"] as string);
    expect(CODEX_SYSTEM_PROMPT).toBe(pinned["codexSystemPrompt"] as string);
    expect(buildSystemPrompt(undefined, "probing", "wrathbench", true)).toBe(pinned["probingNoObjective"] as string);
    expect(buildSystemPrompt("Reach Goldshire.", "freeplay", "wrathbench", false)).toBe(
      pinned["freeplayObjectiveNoWiki"] as string,
    );
    expect(buildSystemPrompt(undefined, "e90")).toBe(pinned["e90"] as string);
  });

  test("the tool list, in every rendering", () => {
    expect(JSON.parse(JSON.stringify(TOOLS))).toEqual(pinned["tools"]);
    expect(JSON.parse(JSON.stringify(toolsFor({ wikiCoords: true })))).toEqual(pinned["toolsCoords"]);
    expect(JSON.parse(JSON.stringify(toolsFor({ wikiSearch: false })))).toEqual(pinned["toolsNoWiki"]);
  });

  test("the harness strings and session notes", () => {
    expect(STATE_LOSS_RECOVERY).toBe(pinned["stateLossRecovery"] as string);
    expect(STATE_RESET_NOTICE).toBe(pinned["stateResetNotice"] as string);
    expect(STATE_KEPT_AND_LOST).toBe(pinned["stateKeptAndLost"] as string);
    expect(
      resumeSessionNote({ character: "Bromdir", race: 3, class: 1, clock: "40 minutes elapsed of 90", seen: " Last seen at level 4." }),
    ).toBe(pinned["resumeNote"] as string);
    expect(continuedSessionNote({ character: "Bromdir", race: 3, class: 1, from: "run-a", seen: "" })).toBe(
      pinned["continuedNote"] as string,
    );
  });

  test("a fresh user message", () => {
    expect(
      assembleContext({
        stateSummary: "[state]\nlevel 3",
        events: [{ seq: 1, ts: 1, opcode: "SMSG_ATTACKSTART", data: { victimGuid: "1" } }],
        workspace: { files: [{ path: "notes.md", bytes: 4, firstLine: "# hi" }], notes: "# hi\n" },
        notices: [{ ts: 1, kind: "session_note", text: "hello" }],
        turn: 7,
      }),
    ).toBe(pinned["context"] as string);
  });

  test("the snippet compiler's REPL bodies", () => {
    expect(JSON.parse(JSON.stringify(COMPILED_SOURCES.map((src) => compileSnippet(src, {}))))).toEqual(pinned["compiled"]);
  });

  test("a launch config and its comparability tuple", () => {
    const config = configFromArgs(pinned["argv"] as string[]);
    expect(JSON.parse(JSON.stringify(config))).toEqual(pinned["config"]);
    expect(JSON.parse(JSON.stringify(comparabilityOf(config, "harness-0.5-pin", null, null)))).toEqual(
      pinned["comparability"],
    );
  });

  test("the sandbox child's environment, and a stray loop variable is never forwarded", () => {
    expect(sandboxChildEnv(PARENT_ENV, EXPLICIT_ENV)).toEqual(pinned["childEnv"] as Record<string, string>);
    expect(sandboxChildEnv({ ...PARENT_ENV, WRATHBENCH_LOOP: "entrypoint" }, EXPLICIT_ENV)).toEqual(
      pinned["childEnv"] as Record<string, string>,
    );
  });
});
