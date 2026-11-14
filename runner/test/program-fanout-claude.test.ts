/**
 * The program loop at fan-out on the claude-code driver, through the fake
 * CLI over a real confined sandbox holding a seat per character and the
 * fan-out stub module: the tools the CLI is served are the ones it is
 * granted, and a routine started for a character runs as that character.
 * Names are invented.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Scratchpad } from "@wrathbench/mcp";
import { Workspace } from "@wrathbench/mcp/workspace";
import { MCP_SERVER_NAME, runClaudeEpisode } from "../src/adapter-claude";
import { loadRunConfig } from "../src/config";
import { EpisodicLog } from "../src/episodic";
import { openFanout } from "../src/fanout-run";
import { SandboxHost } from "../src/sandbox/host";
import { RecordSignals } from "../src/session-record";
import { toolsFor } from "../src/tools";
import { readTrajectory, Trajectory } from "../src/trajectory";
import { PROGRAM_DIR, ProgramWake } from "../src/wake";
import { Watchdogs } from "../src/watchdogs";
import { PORT_SECRET, startStub } from "./fixtures/fanout-module";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();
const stops: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s().catch(() => undefined);
});

function fakeClaudeBin(): string {
  const dir = tempDir("wrathbench-program-fanout-claude-bin-");
  const path = join(dir, "claude");
  writeFileSync(path, `#!/bin/sh\nexec ${process.execPath} ${join(import.meta.dir, "fixtures", "fake-claude.ts")} "$@"\n`, "utf8");
  chmodSync(path, 0o755);
  return path;
}

const MAIN = `export async function report() {
  memory[state.self.name] = (memory[state.self.name] ?? 0) + 1;
  while (!signal.aborted) await sleep(50, { wake: false });
}
export async function trip() {
  await sleep(300, { wake: false });
  return "done";
}
`;

describe("the program loop at fan-out on claude-code", () => {
  test("every tool served is granted and nothing else, and a routine started for a character runs as it", async () => {
    const stub = startStub();
    stops.push(() => stub.stop());
    const runsDir = tempDir("wrathbench-program-fanout-claude-");
    const runId = "fan-program-claude";
    const runDir = join(runsDir, runId);
    const config = {
      ...loadRunConfig({
        driver: "claude-code",
        model: "opus",
        runsDir,
        moduleUrl: stub.url,
        credential: "claude-1",
        usageMaxPct: { scored: 80, freeplay: 80 },
        episode: "probing",
        stepIntervalMs: 50,
        stateIntervalMs: 1,
        maxTurns: 2,
        loop: "program",
        yield: true,
        fanout: { characters: 2, accounts: ["POOL01", "POOL02"] },
      }),
      runId,
      token: "f".repeat(32),
    };
    const trajectory = new Trajectory(runDir);
    trajectory.writeMeta({ runId, harnessVersion: "t", startedAt: Date.now(), config });
    const wake = new ProgramWake({ trajectory, tickMs: 20, coalesceMs: 100 });
    const signals = new RecordSignals();
    const scratchpad = new Scratchpad(join(runDir, "scratchpad.md"));
    const sandbox = new SandboxHost({
      moduleUrl: stub.url,
      token: config.token,
      scratchpad,
      snippetTimeoutMs: 5_000,
      pingGraceMs: 1_000,
      fanout: { maxCharacters: 2 },
      signals,
      recordTickMs: 3_600_000,
      logSink: () => {},
      program: { workspace: new Workspace(join(runDir, PROGRAM_DIR)), onFact: wake.onFact, beatMs: 200 },
    });
    stops.push(() => sandbox.stop());
    const roster = openFanout({ fanout: config.fanout!, moduleUrl: stub.url, runDir, runsDir, sandbox, secrets: trajectory, signals, env: { WRATHBENCH_MODULE_SECRET: PORT_SECRET } });
    stops.push(() => roster.shutdown({ logout: true }));
    const record = join(runDir, "fake-record.json");
    const calls = [
      [
        { name: "login_character", arguments: { name: "alfa", race: 1, class: 1 } },
        { name: "login_character", arguments: { name: "bravo", race: 1, class: 1 } },
        { name: "write_file", arguments: { path: "main.ts", content: MAIN } },
        { name: "start_routine", arguments: { name: "report", character: "Alfa" } },
        { name: "start_routine", arguments: { name: "report", character: "Bravo" } },
        // Its end is what wakes the turn-end sleep.
        { name: "start_routine", arguments: { name: "trip" } },
      ],
      [
        { name: "run_snippet", arguments: { code: "JSON.stringify(memory)" } },
        { name: "yield", arguments: { seconds: 1 } },
      ],
    ];
    await runClaudeEpisode({
      config: config as typeof config & { runId: string; token: string },
      runDir,
      sandbox,
      scratchpad,
      episodic: new EpisodicLog(join(runDir, "episodic.jsonl")),
      trajectory,
      watchdogs: new Watchdogs(config.watchdogs),
      claudeBin: fakeClaudeBin(),
      env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "/tmp", CLAUDE_CODE_OAUTH_TOKEN: "oauth-token-for-tests" },
      extraEnv: { WB_FAKE_MODE: "tools", WB_FAKE_RECORD: record, WB_FAKE_CALLS: JSON.stringify(calls) },
      killGraceMs: 500,
      programWake: wake,
    });
    trajectory.close();
    const rec = JSON.parse(readFileSync(record, "utf8")) as Record<string, unknown>;
    // Served and granted alike: the program loop's fan-out list.
    const served = rec["mcpTools"] as string[];
    expect(served).toEqual(toolsFor({ programTools: { yield: true }, fanout: true }).map((t) => t.name));
    expect(rec["allowedTools"]).toEqual(served.map((t) => `mcp__${MCP_SERVER_NAME}__${t}`));
    const results = readTrajectory(runDir)
      .filter((x) => x.t === "tool_result" || x.t === "snippet_result")
      .map((x) => [String(x["name"]), String(x["text"])] as const);
    expect(results.filter(([n]) => n === "start_routine").map(([, t]) => t.split("\n")[0])).toEqual(["started report (Alfa) on deploy 1", "started report (Bravo) on deploy 1", "started trip on deploy 1"]);
    expect(results.find(([n]) => n === "run_snippet")?.[1]).toContain('{\\"Alfa\\":1,\\"Bravo\\":1}');
  }, 60_000);
});
