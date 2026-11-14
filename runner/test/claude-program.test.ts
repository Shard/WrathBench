/**
 * The program loop on the claude-code driver, through the fake CLI over a
 * real confined sandbox and the stub module: the turn-end sleep and `yield`,
 * the program's tools served and granted alike, the raised MCP tool timeout,
 * the session's pad rule and its resets (a compaction, a new session), and a
 * stop request ending a sleep. The snippet loop on claude-code keeps its
 * prompt, grant and environment.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Scratchpad, SecretRedactor, type ToolProgram } from "@wrathbench/mcp";
import { Workspace } from "@wrathbench/mcp/workspace";
import { leaseSessionSecret } from "@wrathbench/mcp/module-auth";
import { MCP_SERVER_NAME, MCP_TOOL_TIMEOUT_ENV, claudeArgs, mcpToolNames, programToolEnv, runClaudeEpisode } from "../src/adapter-claude";
import { loadRunConfig, threadContextOf } from "../src/config";
import { EpisodicLog } from "../src/episodic";
import { CODEX_SYSTEM_PROMPT, SNIPPET_DELTA_SENTENCE, buildSystemPrompt } from "../src/prompt";
import { ReflectGate } from "../src/reflect";
import { SandboxHost, type SnippetResult } from "../src/sandbox/host";
import { renderSnippetDelta } from "../src/sandbox/snippet-delta";
import { callTool } from "../src/tools";
import { readTrajectory, Trajectory } from "../src/trajectory";
import { PROGRAM_DIR, PROGRAM_TOOL_TIMEOUT_MS, ProgramWake } from "../src/wake";
import { Watchdogs } from "../src/watchdogs";
import { PORT_SECRET, startStub, type Stub } from "./fixtures/fanout-module";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();
const hosts: SandboxHost[] = [];
const stubs: Stub[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((h) => h.stop()));
  await Promise.all(stubs.splice(0).map((s) => s.stop()));
});

const TOKEN = "program-claude-token-0001";
const LOGIN = 'await connect(); return (await sdk.createSession({ character: "Thalvorn", race: 1, class: 2 })).character;';
const MAIN = `export async function trip(args) {
  await sleep(300, { wake: false });
  console.log("arrived at " + args.to);
  return "done";
}
export async function idle() {
  while (!signal.aborted) await sleep(50, { wake: false });
}
`;

/** A directory holding a `claude` that runs the scripted fake (`fixtures/fake-claude.ts`). */
function fakeClaudeBin(): string {
  const dir = tempDir("wrathbench-program-claude-bin-");
  const path = join(dir, "claude");
  writeFileSync(path, `#!/bin/sh\nexec ${process.execPath} ${join(import.meta.dir, "fixtures", "fake-claude.ts")} "$@"\n`, "utf8");
  chmodSync(path, 0o755);
  return path;
}

interface ProgramRun {
  /** One list of `{ name, arguments }` calls per turn. */
  calls: unknown[][];
  maxTurns?: number;
  idleMs?: number;
  signal?: AbortSignal;
  /** `--yield true`; on unless said. */
  yield?: boolean;
  /** The fake's own settings (`WB_FAKE_COMPACT_TURN`, `WB_FAKE_SESSION_TURN`). */
  fake?: Record<string, string>;
}

/** A program-loop claude-code run over a real sandbox, its CLI the fake playing `calls`. */
async function claudeProgramRun(o: ProgramRun) {
  const runDir = tempDir("wrathbench-program-claude-");
  const config = {
    ...loadRunConfig({
      driver: "claude-code",
      model: "opus",
      runsDir: tempDir("wrathbench-program-claude-runs-"),
      credential: "claude-1",
      usageMaxPct: { scored: 80, freeplay: 80 },
      episode: "probing",
      stepIntervalMs: 50,
      stateIntervalMs: 1,
      loop: "program",
      ...(o.yield !== false ? { yield: true } : {}),
      ...(o.maxTurns !== undefined ? { maxTurns: o.maxTurns } : {}),
    }),
    runId: "run-program-claude",
    token: "run-program-claude",
  };
  const trajectory = new Trajectory(runDir);
  trajectory.writeMeta({ runId: config.runId, harnessVersion: "t", startedAt: Date.now(), config });
  const wake = new ProgramWake({ trajectory, tickMs: 20, coalesceMs: 100 });
  const module = startStub();
  stubs.push(module);
  const lease = await leaseSessionSecret({ moduleUrl: module.url, token: TOKEN, account: "RUNNER", env: { WRATHBENCH_MODULE_SECRET: PORT_SECRET } });
  const sandbox = new SandboxHost({
    moduleUrl: module.url,
    token: TOKEN,
    secret: lease.secret!,
    account: "RUNNER",
    scratchpad: new Scratchpad(join(runDir, "scratchpad.md")),
    snippetTimeoutMs: 5_000,
    pingGraceMs: 1_000,
    logSink: () => {},
    program: { workspace: new Workspace(join(runDir, PROGRAM_DIR)), onFact: wake.onFact, beatMs: 200 },
  });
  hosts.push(sandbox);
  expect((await sandbox.evalSnippet(LOGIN)).value).toContain("Thalvorn");
  const record = join(runDir, "fake-record.json");
  const started = Date.now();
  const outcome = await runClaudeEpisode({
    config: config as typeof config & { runId: string; token: string },
    runDir,
    sandbox,
    scratchpad: new Scratchpad(join(runDir, "scratchpad.md")),
    episodic: new EpisodicLog(join(runDir, "episodic.jsonl")),
    trajectory,
    watchdogs: new Watchdogs({ ...config.watchdogs, ...(o.idleMs !== undefined ? { idleMs: o.idleMs } : {}) }),
    claudeBin: fakeClaudeBin(),
    env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "/tmp", CLAUDE_CODE_OAUTH_TOKEN: "oauth-token-for-tests" },
    extraEnv: { WB_FAKE_MODE: "tools", WB_FAKE_RECORD: record, WB_FAKE_CALLS: JSON.stringify(o.calls), ...(o.fake ?? {}) },
    killGraceMs: 500,
    programWake: wake,
    ...(o.signal !== undefined ? { signal: o.signal } : {}),
  });
  trajectory.close();
  const rec = JSON.parse(readFileSync(record, "utf8")) as Record<string, unknown>;
  return { outcome, ms: Date.now() - started, rec, messages: rec["userMessages"] as string[], records: readTrajectory(runDir), config, runDir };
}

const UNCHANGED = "[scratchpad 0.0k/32k: unchanged since you last saw it in this conversation, so not repeated]";

describe("the program loop on the claude-code driver, through the fake CLI", () => {
  test("the turn-end pause sleeps until a wake, whose block opens the next turn; yield is served, granted and answers its wake", async () => {
    const r = await claudeProgramRun({
      calls: [
        [
          { name: "write_file", arguments: { path: "main.ts", content: MAIN } },
          { name: "start_routine", arguments: { name: "trip", args: { to: "Goldshire" } } },
        ],
        [
          { name: "start_routine", arguments: { name: "idle" } },
          { name: "yield", arguments: { seconds: 1 } },
        ],
      ],
      maxTurns: 2,
    });
    expect(r.outcome).toEqual({ kind: "terminated", reason: "turn-limit", detail: "2 turns" });
    // The program's prompt, as the tuple hashes it.
    expect(r.rec["systemPrompt"]).toBe(buildSystemPrompt(undefined, "probing", "claude-code", true, r.config.watchdogs.episodeMs, { yield: true }));
    // Every tool served is granted, and nothing else: under -p a served tool not granted is denied.
    const served = r.rec["mcpTools"] as string[];
    expect(served).toEqual(expect.arrayContaining(["run_snippet", "read_file", "write_file", "edit_file", "delete_file", "start_routine", "stop_routine", "yield"]));
    expect(r.rec["allowedTools"]).toEqual(served.map((t) => `mcp__${MCP_SERVER_NAME}__${t}`));
    // The tool timeout is above the longest yield hold, in the child's env and on the record.
    expect((r.rec["env"] as Record<string, unknown>)["mcpToolTimeout"]).toBe(String(PROGRAM_TOOL_TIMEOUT_MS));
    expect(r.records.find((x) => x.t === "driver")).toMatchObject({ mcpToolTimeoutMs: PROGRAM_TOOL_TIMEOUT_MS });
    // The second turn opens with the wake trip's end caused, and only that turn.
    expect(r.messages[0]).not.toContain("[wake");
    expect(r.messages[1]).toMatch(/^\[turn 2\]\n\n\[wake 1 · slept \d+s · woke for: routine ended \(trip, returned\)\]/);
    const results = r.records.filter((x) => x.t === "tool_result").map((x) => [x["name"], String(x["text"])]);
    expect(results.find(([n]) => n === "write_file")?.[1]).toContain("loaded: deploy 1 · routines: idle, trip");
    expect(results.find(([n]) => n === "yield")?.[1]).toContain("[wake 2 · slept 1s · woke for: 1s passed]");
    expect(r.records.filter((x) => x.t === "wake").map((x) => [x["via"], x["fired"]])).toEqual([
      ["turn-end", "routine_ended"],
      ["yield", "cap"],
    ]);
  }, 60_000);

  test("without --yield the turn-end sleep is the only one: yield is neither served nor granted", async () => {
    const r = await claudeProgramRun({
      calls: [[{ name: "write_file", arguments: { path: "main.ts", content: MAIN } }, { name: "start_routine", arguments: { name: "trip", args: { to: "Goldshire" } } }], []],
      maxTurns: 2,
      yield: false,
    });
    const served = r.rec["mcpTools"] as string[];
    expect(served).toContain("start_routine");
    expect(served).not.toContain("yield");
    expect(r.rec["allowedTools"]).toEqual(served.map((t) => `mcp__${MCP_SERVER_NAME}__${t}`));
    expect(r.rec["systemPrompt"]).toBe(buildSystemPrompt(undefined, "probing", "claude-code", true, r.config.watchdogs.episodeMs, { yield: false }));
    expect(r.messages[1]).toMatch(/^\[turn 2\]\n\n\[wake 1 · slept \d+s · woke for: routine ended \(trip, returned\)\]/);
  }, 60_000);

  test("the pad goes whole only when the session does not hold it as it is: the first turn, and after a snippet changed it", async () => {
    const r = await claudeProgramRun({
      calls: [
        [
          { name: "write_file", arguments: { path: "main.ts", content: MAIN } },
          { name: "write_scratchpad", arguments: { content: "# plan\nGoldshire" } },
          { name: "start_routine", arguments: { name: "trip", args: { to: "Goldshire" } } },
        ],
        [{ name: "start_routine", arguments: { name: "trip", args: { to: "Elwynn" } } }],
        [
          { name: "run_snippet", arguments: { code: 'await scratchpad.write("# plan\\nfrom a snippet"); return 1' } },
          { name: "start_routine", arguments: { name: "trip", args: { to: "Westfall" } } },
        ],
        [],
      ],
      maxTurns: 4,
    });
    expect(r.messages.length).toBe(4);
    expect(r.messages[0]).toContain("[scratchpad]\n(empty");
    // The model wrote it itself, so the session holds it.
    expect(r.messages[1]).toEndWith(UNCHANGED);
    expect(r.messages[1]).not.toContain("# plan");
    expect(r.messages[2]).toEndWith(UNCHANGED);
    // A snippet's write, which the session never saw.
    expect(r.messages[3]).toEndWith("[scratchpad 0.0k/32k]\n# plan\nfrom a snippet");
  }, 60_000);

  test("a compaction, at its boundary, sends the pad whole in the next message", async () => {
    const r = await claudeProgramRun({
      calls: [
        [
          { name: "write_file", arguments: { path: "main.ts", content: MAIN } },
          { name: "write_scratchpad", arguments: { content: "# plan\nGoldshire" } },
          { name: "start_routine", arguments: { name: "trip", args: { to: "Goldshire" } } },
        ],
        [{ name: "start_routine", arguments: { name: "trip", args: { to: "Elwynn" } } }],
        [],
      ],
      maxTurns: 3,
      // The CLI compacts inside turn 2, after its message was sent.
      fake: { WB_FAKE_COMPACT_TURN: "2" },
    });
    expect(r.records.some((x) => x.t === "harness" && x["kind"] === "compaction")).toBe(true);
    expect(r.messages[1]).toEndWith(UNCHANGED);
    expect(r.messages[2]).toEndWith("[scratchpad 0.0k/32k]\n# plan\nGoldshire");
  }, 60_000);

  test("a session the CLI names that is not the one before holds nothing: the pad goes whole", async () => {
    const r = await claudeProgramRun({
      calls: [
        [
          { name: "write_file", arguments: { path: "main.ts", content: MAIN } },
          { name: "write_scratchpad", arguments: { content: "# plan\nGoldshire" } },
          { name: "start_routine", arguments: { name: "trip", args: { to: "Goldshire" } } },
        ],
        [{ name: "start_routine", arguments: { name: "trip", args: { to: "Elwynn" } } }],
        [],
      ],
      maxTurns: 3,
      fake: { WB_FAKE_SESSION_TURN: "2" },
    });
    expect(r.messages[1]).toEndWith(UNCHANGED);
    expect(r.messages[2]).toEndWith("[scratchpad 0.0k/32k]\n# plan\nGoldshire");
  }, 60_000);

  test("a stop request ends the sleep at once, and time asleep is not idle", async () => {
    const ac = new AbortController();
    // Nothing runs, so the turn-end sleep would last five minutes; idle is far shorter than the sleep.
    setTimeout(() => ac.abort(), 6_000);
    const r = await claudeProgramRun({ calls: [[{ name: "write_file", arguments: { path: "main.ts", content: MAIN } }]], idleMs: 3_000, signal: ac.signal });
    expect(r.outcome).toEqual({ kind: "terminated", reason: "manual", detail: "aborted" });
    expect(r.ms).toBeLessThan(15_000);
    expect(r.records.filter((x) => x.t === "wake").map((x) => [x["via"], x["fired"]])).toEqual([["turn-end", "stopped"]]);
    expect(r.records.some((x) => x.t === "watchdog")).toBe(false);
  }, 60_000);

  test("a stop request ends a held yield at once", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 4_000);
    const r = await claudeProgramRun({
      calls: [[{ name: "write_file", arguments: { path: "main.ts", content: MAIN } }, { name: "yield", arguments: {} }]],
      idleMs: 2_000,
      signal: ac.signal,
    });
    expect(r.outcome).toEqual({ kind: "terminated", reason: "manual", detail: "aborted" });
    expect(r.ms).toBeLessThan(15_000);
    // The held call is the CLI's, which the stop killed: its sleep ends on the next tick and its record lands after the episode returned.
    const wakes = async () => readTrajectory(r.runDir).filter((x) => x.t === "wake").map((x) => [x["via"], x["fired"]]);
    for (let k = 0; k < 50 && (await wakes()).length === 0; k++) await Bun.sleep(100);
    expect(await wakes()).toEqual([["yield", "stopped"]]);
    expect(r.records.some((x) => x.t === "watchdog")).toBe(false);
  }, 60_000);
});

describe("claude-code's snippet loop is as it was", () => {
  const base = { mcpConfigPath: "/x/claude-mcp.json" };

  test("no tool timeout in the env, the nine granted, and the program's list only on the program loop", () => {
    expect(programToolEnv(false)).toEqual({});
    expect(programToolEnv(true)).toEqual({ [MCP_TOOL_TIMEOUT_ENV]: "600000" });
    expect(mcpToolNames()).toHaveLength(9);
    expect(claudeArgs(base)).toEqual(claudeArgs({ ...base, programTools: undefined }));
    const program = claudeArgs({ ...base, programTools: { yield: true } });
    expect(program).toContain(`mcp__${MCP_SERVER_NAME}__yield`);
    expect(program).toContain(`mcp__${MCP_SERVER_NAME}__start_routine`);
    expect(claudeArgs(base)).not.toContain(`mcp__${MCP_SERVER_NAME}__start_routine`);
  });

  test("the thread context is the program loop's on claude-code too, never the snippet loop's", () => {
    expect(threadContextOf({ loop: "program", driver: "claude-code" })).toBe(true);
    expect(threadContextOf({ driver: "claude-code" })).toBe(false);
  });

  test("the program body on claude-code differs from codex's by the snippet-delta sentence alone", () => {
    const claude = buildSystemPrompt(undefined, "probing", "claude-code", true, 5_400_000, { yield: true });
    const codex = buildSystemPrompt(undefined, "probing", "codex", true, 5_400_000, { yield: true });
    expect(claude.replace(` ${SNIPPET_DELTA_SENTENCE}`, "")).toBe(codex);
    expect(CODEX_SYSTEM_PROMPT).not.toContain(SNIPPET_DELTA_SENTENCE);
  });

  test("a program run's one-off snippet still ends with what changed since the previous one, as the prompt's sentence says", async () => {
    const delta = { members: [], chat: [], chatDropped: 0, damage: [], damageOther: { sources: 0, total: 0 }, level: { from: 4, to: 5 }, quests: { complete: [], added: [], gone: [] } };
    const sandbox = {
      evalSnippet: (): Promise<SnippetResult> => Promise.resolve({ ok: true, value: "42", logs: [], durationMs: 3 }),
      snippetDelta: () => Promise.resolve(delta),
      drainActionHints: () => Promise.resolve([]),
    } as unknown as SandboxHost;
    const dir = tempDir("wrathbench-program-claude-delta-");
    const res = await callTool(
      {
        sandbox,
        scratchpad: new Scratchpad(join(dir, "scratchpad.md")),
        sessionLive: () => true,
        reflect: new ReflectGate(),
        episodic: new EpisodicLog(join(dir, "episodic.jsonl")),
        turn: () => 1,
        secrets: new SecretRedactor(),
        snippetDelta: true,
        program: {} as ToolProgram,
      },
      "run_snippet",
      { code: "42" },
    );
    expect(res.text).toEndWith(renderSnippetDelta(delta as Parameters<typeof renderSnippetDelta>[0])!);
    expect(res.text).toContain("level 4 → 5");
  });
});
