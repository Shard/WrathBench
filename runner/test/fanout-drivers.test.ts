/**
 * The CLI drivers at fan-out: claude-code, codex and pi, each driving one
 * fan-out run (`fanout-run.ts`) through its scripted fake CLI
 * (`fixtures/fake-{claude,codex,pi}.ts`, `$WB_FAKE_CALLS`), the loopback MCP
 * bridge, the real confined child with a seat per character, and the module
 * stub (`fixtures/fanout-module.ts`). No model, no credential, no worldserver.
 *
 * For each driver: the fan-out tool list is what the CLI is served and (on
 * claude-code) granted; a call naming a character acts as that character and
 * lands in that character's record; one CLI session drives every character;
 * no seat token reaches anything the CLI is handed; a resumed roster's
 * characters answer the first turn; and a run that drives one character is
 * served, byte for byte, what it was served before fan-out existed.
 *
 * Names are invented.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionReader, type CallRow } from "@wrathbench/mcp/record";
import { Scratchpad } from "@wrathbench/mcp/scratchpad";
import { claudeArgs, mcpToolNames, runClaudeEpisode } from "../src/adapter-claude";
import { runCodexEpisode } from "../src/adapter-codex";
import { runPiEpisode } from "../src/adapter-pi";
import { loadRunConfig, type RunConfig } from "../src/config";
import { EpisodicLog } from "../src/episodic";
import { fanoutSessionNote, openFanout, readRoster, ROSTER_FILE } from "../src/fanout-run";
import { configFromArgs } from "../src/run";
import { SandboxHost, type HarnessNotice } from "../src/sandbox/host";
import { characterSessionDir, RecordSignals, SESSION_DIR, SESSIONS_DIR } from "../src/session-record";
import { toolsFor } from "../src/tools";
import { readMeta, readTrajectory, Trajectory } from "../src/trajectory";
import { Watchdogs } from "../src/watchdogs";
import type { CharacterRoster } from "@wrathbench/mcp/fanout";
import { PORT_SECRET, startStub, type Stub } from "./fixtures/fanout-module";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();
const RUN_TS = join(import.meta.dir, "..", "src", "run.ts");
const FAKES = {
  "claude-code": { bin: "claude", fixture: join(import.meta.dir, "fixtures", "fake-claude.ts") },
  codex: { bin: "codex", fixture: join(import.meta.dir, "fixtures", "fake-codex.ts") },
  pi: { bin: "pi", fixture: join(import.meta.dir, "fixtures", "fake-pi.ts") },
} as const;
type CliDriver = keyof typeof FAKES;
const DRIVERS: CliDriver[] = ["claude-code", "codex", "pi"];

/** The tools a fan-out run is served, in order: the nine, then the roster's three. */
const FANOUT_NAMES = toolsFor({ fanout: true }).map((t) => t.name);

/**
 * What a single-character run is served, hashed: the `tools/list` result over
 * MCP, the tools claude-code is granted, and claude-code's argv. Taken at
 * WrathBench `v1` e846355a, the head before fan-out (#450, #453) existed, and
 * equal at d251f31e; not regenerated to make this pass (wrath-mcp's
 * `fanout1-identity.test.ts` holds the stack's side the same way).
 */
const SINGLE = {
  toolsList: "b6b0f118bee75e59",
  claudeAllowedTools: "a24dbe820edb9b8b",
  claudeArgs: "90a5a17af291fcf4",
};
const hash = (v: unknown): string => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 16);

/** A directory holding an executable named for the CLI that runs its fake, with the fake's settings baked in. */
function fakeBinDir(driver: CliDriver, fakeEnv: Record<string, string> = {}): string {
  const dir = tempDir("wrathbench-fanout-fakebin-");
  const path = join(dir, FAKES[driver].bin);
  const assigns = Object.entries(fakeEnv).map(([k, v]) => `${k}='${v}' `).join("");
  writeFileSync(path, `#!/bin/sh\n${assigns}exec ${process.execPath} ${FAKES[driver].fixture} "$@"\n`, "utf8");
  chmodSync(path, 0o755);
  return dir;
}

/** A codex lane directory that looks logged in. */
function fakeCodexHome(): string {
  const dir = tempDir("wrathbench-fanout-codex-home-");
  writeFileSync(join(dir, "auth.json"), '{"auth_mode":"chatgpt","tokens":{"access_token":"fake"}}\n', "utf8");
  return dir;
}

/** Each driver's run configuration, as its own driver tests launch it. */
function driverConfig(driver: CliDriver): Record<string, unknown> {
  switch (driver) {
    case "claude-code":
      return { driver, model: "opus", credential: "claude-1", usageMaxPct: { scored: 80, freeplay: 80 } };
    case "codex":
      return { driver, model: "gpt-5.5", credential: "chatgpt-1", usageMaxPct: { scored: 80, freeplay: 80 } };
    case "pi":
      return {
        driver,
        model: "deepseek-flash",
        apiBase: "https://api.deepseek.com/v1",
        apiKeyEnv: "DEEPSEEK_KEY",
        episode: "probing",
        campaign: "pi-vs-wrathbench",
        campaignVersion: 1,
        cell: "dwarf-paladin",
        arm: "pi",
        ref: "deepseek-flash-pi",
      };
  }
}

/** The environment a driver's CLI is launched from: its credential, and the fake on PATH. */
function driverEnv(driver: CliDriver, fakeEnv: Record<string, string> = {}): Record<string, string> {
  const base = { PATH: `${fakeBinDir(driver, fakeEnv)}:${process.env["PATH"] ?? ""}`, HOME: process.env["HOME"] ?? "/tmp" };
  switch (driver) {
    case "claude-code":
      return { ...base, CLAUDE_CODE_OAUTH_TOKEN: "oauth-token-for-tests" };
    case "codex":
      return { ...base, CODEX_HOME: fakeCodexHome() };
    case "pi":
      return { ...base, DEEPSEEK_KEY: "sk-deepseek-for-tests" };
  }
}

type EpisodeOptions = Parameters<typeof runClaudeEpisode>[0];

/** Run one episode of `driver` with the options every scaffold driver takes. */
function runEpisode(driver: CliDriver, o: EpisodeOptions) {
  switch (driver) {
    case "claude-code":
      return runClaudeEpisode(o);
    case "codex":
      return runCodexEpisode(o);
    case "pi":
      return runPiEpisode({ ...o, piBin: join(fakeBinDir("pi"), "pi"), killGraceMs: 500, windDownGraceMs: 5_000 });
  }
}

const stops: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop().catch(() => undefined);
});

interface Rig {
  stub: Stub;
  runDir: string;
  config: RunConfig & { runId: string; token: string };
  trajectory: Trajectory;
  sandbox: SandboxHost;
  roster: CharacterRoster;
  options: (fake: { record: string; calls: unknown[][]; initialNotices?: HarnessNotice[] }) => EpisodeOptions;
}

/**
 * A fan-out run of `driver` on three accounts, its sandbox and roster as
 * run.ts builds them, against `stub` (a fresh one unless given). A second
 * rig on the same run directory and stub is the resumed process.
 */
function fanoutRig(driver: CliDriver, o: { stub?: Stub; runsDir?: string; runId?: string; maxTurns?: number } = {}): Rig {
  const stub = o.stub ?? startStub();
  if (o.stub === undefined) stops.push(() => stub.stop());
  const runsDir = o.runsDir ?? tempDir("wrathbench-fanout-drivers-");
  const runId = o.runId ?? `fan-${driver}`;
  const runDir = join(runsDir, runId);
  const config = {
    ...loadRunConfig({
      ...driverConfig(driver),
      runsDir,
      moduleUrl: stub.url,
      stepIntervalMs: 0,
      stateIntervalMs: 1,
      maxTurns: o.maxTurns ?? 2,
      fanout: { characters: 3, accounts: ["POOL01", "POOL02", "POOL03"] },
    }),
    runId,
    token: "f".repeat(32),
  };
  const trajectory = new Trajectory(runDir);
  trajectory.writeMeta({ runId, harnessVersion: "t", startedAt: Date.now(), config });
  const scratchpad = new Scratchpad(join(runDir, "scratchpad.md"));
  const signals = new RecordSignals();
  const sandbox = new SandboxHost({
    moduleUrl: stub.url,
    token: config.token,
    scratchpad,
    snippetTimeoutMs: 5_000,
    pingGraceMs: 1_000,
    fanout: { maxCharacters: 3 },
    signals,
    recordTickMs: 3_600_000,
    logSink: () => {},
  });
  stops.push(() => sandbox.stop());
  const roster = openFanout({ fanout: config.fanout!, moduleUrl: stub.url, runDir, runsDir, sandbox, secrets: trajectory, signals, env: { WRATHBENCH_MODULE_SECRET: PORT_SECRET } });
  stops.push(() => roster.shutdown({ logout: false }));
  const episodic = new EpisodicLog(join(runDir, "episodic.jsonl"));
  return {
    stub,
    runDir,
    config,
    trajectory,
    sandbox,
    roster,
    options: (fake) => ({
      config,
      runDir,
      sandbox,
      scratchpad,
      episodic,
      trajectory,
      watchdogs: new Watchdogs(config.watchdogs),
      sleep: () => Promise.resolve(),
      env: driverEnv(driver),
      extraEnv: { WB_FAKE_MODE: "tools", WB_FAKE_RECORD: fake.record, WB_FAKE_CALLS: JSON.stringify(fake.calls) },
      ...(fake.initialNotices !== undefined ? { initialNotices: fake.initialNotices } : {}),
    }),
  };
}

const readJson = (p: string): Record<string, unknown> => JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;

/** What the fake was served by `tools/list`: the names, from its first (codex: every) connection. */
function servedNames(driver: CliDriver, rec: Record<string, unknown>): string[][] {
  if (driver === "codex") return (rec["mcpToolsLists"] as { tools: { name: string }[] }[]).map((l) => l.tools.map((t) => t.name));
  return [(rec["mcpToolsList"] as { tools: { name: string }[] }).tools.map((t) => t.name)];
}

/** The context messages the fake was handed, one per driver turn. */
function prompts(driver: CliDriver, rec: Record<string, unknown>): string[] {
  return (driver === "pi" ? rec["prompts"] : rec["userMessages"]) as string[];
}

/** The text of every tool result the fake read, in order. */
function resultTexts(rec: Record<string, unknown>): string[] {
  return (rec["toolResults"] as ({ content?: { text?: string }[] } | null)[]).map((r) => (r?.content ?? []).map((c) => c.text ?? "").join(""));
}

/** A character's record: its `call` rows, and the texts it said. */
function recordOf(runDir: string, character: string): { calls: Extract<CallRow, { kind: "call" }>[]; said: string[] } {
  const rows = new SessionReader(characterSessionDir(runDir, character)).rows("calls") as CallRow[];
  return {
    calls: rows.filter((r): r is Extract<CallRow, { kind: "call" }> => r.kind === "call"),
    said: rows.flatMap((r) => (r.kind === "actions" ? r.actions.filter((a) => a.action === "say").map((a) => JSON.stringify(a)) : [])),
  };
}

const say = (character: string, text: string) => ({ name: "run_snippet", arguments: { character, code: `(await sdk.say("${text}")).ok` } });

describe.each(DRIVERS)("%s driver at fan-out", (driver) => {
  test("one CLI session drives every character: the fan-out tools served, each call acting as the character it names", async () => {
    const r = fanoutRig(driver);
    const record = join(r.runDir, "fake-record.json");
    const outcome = await runEpisode(
      driver,
      r.options({
        record,
        calls: [
          [
            { name: "login_character", arguments: { name: "alfa", race: 1, class: 1 } },
            { name: "login_character", arguments: { name: "bravo", race: 1, class: 1 } },
            say("Alfa", "alfa here"),
            { name: "state_summary", arguments: {} },
          ],
          [say("Bravo", "bravo here"), { name: "list_characters", arguments: {} }],
        ],
      }),
    );
    expect(outcome).toEqual({ kind: "terminated", reason: "turn-limit", detail: "2 turns" });
    const rec = readJson(record);

    // The fan-out list is what the CLI is served, on every connection: codex
    // connects afresh each turn, and its second connection still finds both seats.
    const served = servedNames(driver, rec);
    expect(served.length).toBe(driver === "codex" ? 2 : 1);
    for (const names of served) expect(names).toEqual(FANOUT_NAMES);
    // claude-code grants by name, from the run's config; the grant must be the served list exactly.
    if (driver === "claude-code") {
      expect((rec["allowedTools"] as string[]).map((n) => n.replace("mcp__wrathbench__", ""))).toEqual(FANOUT_NAMES);
      expect(rec["allowedTools"]).toEqual(mcpToolNames({ fanout: true }));
    }

    // The turn context is the run's roll-up, from no character to two.
    const ctx = prompts(driver, rec);
    expect(ctx).toHaveLength(2);
    expect(ctx[0]).toContain("No character is logged in; use login_character.");
    expect(ctx[1]).toContain("2 of 3 characters logged in");

    const texts = resultTexts(rec);
    expect(texts[0]).toStartWith("logged in: Alfa");
    expect(texts[1]).toStartWith("logged in: Bravo");
    expect(texts[2]).toContain("true");
    expect(texts[3]).toStartWith("2 of 3 characters logged in");
    expect(texts[4]).toContain("true");
    expect(texts[5]).toContain("Alfa");
    expect(texts[5]).toContain("Bravo");
    expect([...r.stub.sessions.values()].map((s) => `${s.account}:${s.character}`).sort()).toEqual(["POOL01:Alfa", "POOL02:Bravo"]);

    // The trajectory has every call under its own name, `character` and all.
    const calls = readTrajectory(r.runDir).filter((x) => x.t === "tool_call");
    expect(calls.map((c) => c["name"])).toEqual(["login_character", "login_character", "run_snippet", "state_summary", "run_snippet", "list_characters"]);
    expect(calls.filter((c) => c["name"] === "run_snippet").map((c) => (c["args"] as { character?: string }).character)).toEqual(["Alfa", "Bravo"]);

    // A record per character, and each says only what was said as it. A call
    // that names no character is in every record open at the time.
    await r.sandbox.recordDrain();
    expect(existsSync(join(r.runDir, SESSION_DIR))).toBe(false);
    expect(readdirSync(join(r.runDir, SESSIONS_DIR)).sort()).toEqual(["Alfa", "Bravo"]);
    const alfa = recordOf(r.runDir, "Alfa");
    const bravo = recordOf(r.runDir, "Bravo");
    expect(alfa.said).toHaveLength(1);
    expect(alfa.said[0]).toContain("alfa here");
    expect(bravo.said).toHaveLength(1);
    expect(bravo.said[0]).toContain("bravo here");
    const snippetsOf = (c: { calls: { tool: string; args: unknown }[] }): unknown[] => c.calls.filter((x) => x.tool === "run_snippet").map((x) => (x.args as { character?: string }).character);
    expect(snippetsOf(alfa)).toEqual(["Alfa"]);
    expect(snippetsOf(bravo)).toEqual(["Bravo"]);
    for (const c of [alfa, bravo]) expect(c.calls.map((x) => x.tool)).toContain("state_summary");

    // One driver session: one CLI process for the run, or on codex one thread
    // its every turn resumes. One credential: the run's, as on any run.
    expect(readTrajectory(r.runDir).filter((x) => x.t === "driver")).toHaveLength(1);
    if (driver === "codex") {
      expect(rec["threadArgs"]).toEqual([null, "fake-thread"]);
    } else {
      expect(typeof rec["pid"]).toBe("number");
    }

    // The roster: both characters in, 0600, and no seat token anywhere the
    // CLI was handed or the trajectory wrote.
    expect(statSync(join(r.runDir, ROSTER_FILE)).mode & 0o777).toBe(0o600);
    const roster = readRoster(r.runDir);
    expect(roster.map((e) => [e.character, e.account, e.in])).toEqual([["Alfa", "POOL01", true], ["Bravo", "POOL02", true]]);
    const handed = [
      readFileSync(record, "utf8"),
      readFileSync(join(r.runDir, "trajectory.jsonl"), "utf8"),
      ...["claude-mcp.json", join("pi", "mcp.json")].filter((f) => existsSync(join(r.runDir, f))).map((f) => readFileSync(join(r.runDir, f), "utf8")),
    ].join("\n");
    for (const e of roster) expect(handed).not.toContain(e.token);
    r.trajectory.close();
  }, 60_000);

  test("a resumed run's characters are back before the first turn, and answer it", async () => {
    // The paused process: two characters logged in, then a pause that keeps their sessions.
    const first = fanoutRig(driver);
    for (const name of ["alfa", "bravo"]) {
      const login = await first.sandbox.roster!.login({ name, race: 1, class: 1 });
      expect(login.ok).toBe(true);
    }
    const before = readRoster(first.runDir);
    await first.sandbox.stop();
    await first.roster.shutdown({ logout: false });
    first.trajectory.close();
    expect(first.stub.sessions.size).toBe(2);

    // The resumed process: the same run directory and module, a new sandbox,
    // the roster read back and every character logged back in, as run.ts does.
    const r = fanoutRig(driver, { stub: first.stub, runsDir: join(first.runDir, ".."), runId: first.config.runId, maxTurns: 1 });
    const lost = await r.roster.resume();
    expect(lost).toEqual([]);
    const back = r.roster.views().filter((v) => v.state === "in").map((v) => v.character);
    expect(back).toEqual(["Alfa", "Bravo"]);
    const note = fanoutSessionNote({ characters: 3, staged: [], resumed: true, back, lost });
    const record = join(r.runDir, "fake-record-resumed.json");
    const outcome = await runEpisode(
      driver,
      r.options({ record, calls: [[say("Bravo", "bravo is back")]], initialNotices: [{ ts: Date.now(), kind: "session_note", text: note }] }),
    );
    expect(outcome).toEqual({ kind: "terminated", reason: "turn-limit", detail: "1 turns" });
    const rec = readJson(record);
    const ctx = prompts(driver, rec);
    expect(ctx[0]).toContain("These characters were in the world and have been logged back in: Alfa, Bravo.");
    expect(ctx[0]).toContain("2 of 3 characters logged in");
    // No login: the resumed seat answers by its name.
    expect(resultTexts(rec)[0]).toContain("true");
    await r.sandbox.recordDrain();
    expect(recordOf(r.runDir, "Bravo").said.some((s) => s.includes("bravo is back"))).toBe(true);
    // The same characters, on the same tokens, still in.
    expect(readRoster(r.runDir)).toEqual(before);
    r.trajectory.close();
  }, 60_000);

  test("fan-out 1 is a run with no fan-out: the nine tools, byte for byte as before fan-out", async () => {
    // `--max-characters 1` is no grant at all. (pi launches only as a campaign's
    // square, whose identity no flag carries; the flag is read the same for every driver.)
    if (driver !== "pi") expect("fanout" in configFromArgs(["--driver", driver, "--model", "m", "--max-characters", "1"])).toBe(false);

    // The driver's own MCP server, with no roster, serves the pre-fan-out list.
    const runDir = tempDir("wrathbench-fanout1-");
    const config = { ...loadRunConfig({ ...driverConfig(driver), runsDir: tempDir("wrathbench-fanout1-runs-"), stepIntervalMs: 0, stateIntervalMs: 1, maxTurns: 1 }), runId: "run-single", token: "run-single" };
    const trajectory = new Trajectory(runDir);
    trajectory.writeMeta({ runId: "run-single", harnessVersion: "t", startedAt: Date.now(), config });
    const sandbox = {
      evalSnippet: () => Promise.resolve({ ok: true, value: "ran", logs: [], durationMs: 1 }),
      recentEvents: () => Promise.resolve([]),
      stateSnapshot: () => Promise.resolve({ self: {}, lastSeq: -1, eventCount: 0 }),
      totalRestarts: 0,
      consecutiveRestarts: 0,
      drainNotices: () => [],
      stop: () => Promise.resolve(),
    } as unknown as SandboxHost;
    const record = join(runDir, "fake-record.json");
    await runEpisode(driver, {
      config,
      runDir,
      sandbox,
      scratchpad: new Scratchpad(join(runDir, "scratchpad.md")),
      episodic: new EpisodicLog(join(runDir, "episodic.jsonl")),
      trajectory,
      watchdogs: new Watchdogs(config.watchdogs),
      sleep: () => Promise.resolve(),
      env: driverEnv(driver),
      extraEnv: { WB_FAKE_MODE: "tools", WB_FAKE_RECORD: record },
    });
    const rec = readJson(record);
    const list = driver === "codex" ? (rec["mcpToolsLists"] as unknown[])[0] : rec["mcpToolsList"];
    expect(hash(list)).toBe(SINGLE.toolsList);
    if (driver === "claude-code") {
      expect(hash(rec["allowedTools"])).toBe(SINGLE.claudeAllowedTools);
      expect(hash(claudeArgs({ mcpConfigPath: "/x/claude-mcp.json", systemPrompt: "P" }))).toBe(SINGLE.claudeArgs);
      expect(claudeArgs({ mcpConfigPath: "/x/claude-mcp.json", systemPrompt: "P", fanout: false })).toEqual(claudeArgs({ mcpConfigPath: "/x/claude-mcp.json", systemPrompt: "P" }));
    }
    trajectory.close();
  }, 60_000);
});

describe("claude-code at fan-out, through run.ts", () => {
  test("--resume of a paused fan-out run brings every character back and hands the CLI the fan-out grant", async () => {
    const stub = startStub();
    stops.push(() => stub.stop());
    const runsDir = tempDir("wrathbench-fanout-resume-");
    const runId = "fan-resume";
    const runDir = join(runsDir, runId);
    const config = loadRunConfig({
      ...driverConfig("claude-code"),
      runId,
      token: "f".repeat(32),
      runsDir,
      moduleUrl: stub.url,
      stepIntervalMs: 0,
      stateIntervalMs: 1,
      maxTurns: 1,
      fanout: { characters: 2, accounts: ["POOL01", "POOL02"] },
    });
    const traj = new Trajectory(runDir);
    traj.writeMeta({ runId, harnessVersion: "t", startedAt: 1, config });
    traj.setPause(runId, "operator-pause", "SIGTERM: supervisor stop", 60_000);
    traj.writeMeta({ ...readMeta(runDir)!, pause: { reason: "operator-pause", detail: "SIGTERM: supervisor stop", at: Date.now(), episodeElapsedMs: 60_000 } });
    traj.close();
    // Where the two characters live, as the paused process left the file.
    const tokens = ["a", "b"].map((c) => c.repeat(32));
    writeFileSync(
      join(runDir, ROSTER_FILE),
      JSON.stringify([
        { character: "Alfa", account: "POOL01", token: tokens[0], in: true },
        { character: "Bravo", account: "POOL02", token: tokens[1], in: true },
      ]),
      { mode: 0o600 },
    );
    const record = join(runsDir, "fake-record.json");
    const proc = Bun.spawn({
      cmd: [process.execPath, RUN_TS, "--resume", runId, "--runs-dir", runsDir],
      cwd: runsDir,
      env: {
        ...driverEnv("claude-code", { WB_FAKE_RECORD: record, WB_FAKE_CALLS: JSON.stringify([[say("Bravo", "bravo resumed")]]) }),
        WRATHBENCH_MODULE_URL: stub.url,
        WRATHBENCH_MODULE_SECRET: PORT_SECRET,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(proc.stderr).text();
    expect(await proc.exited, stderr).toBe(0);

    const rec = readJson(record);
    expect(rec["allowedTools"]).toEqual(mcpToolNames({ fanout: true }));
    expect((rec["userMessages"] as string[])[0]).toContain("have been logged back in: Alfa, Bravo.");
    expect(resultTexts(rec)[0]).toContain("true");
    const records = readTrajectory(runDir);
    expect(records.find((x) => x.t === "harness" && x["kind"] === "fanout")?.["back"]).toEqual(["Alfa", "Bravo"]);
    expect(records.find((x) => x.t === "termination")?.["reason"]).toBe("turn-limit");
    expect(recordOf(runDir, "Bravo").said.some((s) => s.includes("bravo resumed"))).toBe(true);
    // A finished run gives every character back.
    expect(stub.sessions.size).toBe(0);
    expect(readRoster(runDir).map((e) => [e.character, e.in])).toEqual([["Alfa", false], ["Bravo", false]]);
    const text = readFileSync(join(runDir, "trajectory.jsonl"), "utf8") + readFileSync(record, "utf8") + readFileSync(join(runDir, "claude-mcp.json"), "utf8");
    for (const t of tokens) expect(text).not.toContain(t);
  }, 60_000);
});
