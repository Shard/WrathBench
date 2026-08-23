/**
 * Objective and watchdog overrides as run dimensions (ADR-0024).
 *
 * Three properties are load-bearing and all three are pinned here: the prompt
 * text depends only on the objective (never on the model or the driver), a run
 * that carries an objective is stamped unscored everywhere it is recorded, and
 * a watchdog set to null/0 is genuinely off rather than instantly tripping.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StubAdapter } from "../src/adapter";
import { claudeArgs } from "../src/adapter-claude";
import {
  loadRunConfig,
  OBJECTIVE_STAMP,
  STUB_STAMP,
  unscoredStamp,
  watchdogOverrideSchema,
} from "../src/config";
import { runLoop } from "../src/loop";
import { buildSystemPrompt, SYSTEM_PROMPT } from "../src/prompt";
import { Scratchpad } from "../src/scratchpad";
import type { SandboxHost, SnippetResult } from "../src/sandbox/host";
import { readMeta, readTrajectory, Trajectory } from "../src/trajectory";
import { configFromArgs } from "../src/run";
import { readRun } from "../viewer/runs";
import { Watchdogs } from "../src/watchdogs";

const OBJECTIVE = "Travel from your starting zone to the nearest capital city.";

describe("objective in the run config", () => {
  test("absent by default; a run that names one carries it verbatim", () => {
    expect(loadRunConfig({}).objective).toBeUndefined();
    expect(loadRunConfig({ objective: OBJECTIVE }).objective).toBe(OBJECTIVE);
  });

  test("an empty objective is a config error, not a silently ignored field", () => {
    expect(() => loadRunConfig({ objective: "" })).toThrow();
  });

  test("an objective stamps the run unscored, and stacks with the driver's stamp", () => {
    // No objective: exactly the stamps that shipped before ADR-0024.
    expect(unscoredStamp("openai")).toBeUndefined();
    expect(unscoredStamp("claude-code")).toBeUndefined(); // ADR-0035: a harness, not a penalty
    expect(unscoredStamp("stub")).toBe(STUB_STAMP);
    // An objective alone is enough to keep a run out of a scored comparison.
    expect(unscoredStamp("openai", OBJECTIVE)).toBe(OBJECTIVE_STAMP);
    // Both reasons: the driver stamp stays the prefix, so anything matching on
    // it keeps matching.
    const both = unscoredStamp("stub", OBJECTIVE)!;
    expect(both.startsWith(STUB_STAMP)).toBe(true);
    expect(both).toContain(OBJECTIVE_STAMP);
  });
});

describe("prompt rendering", () => {
  test("no objective is byte-identical to the standing prompt", () => {
    expect(buildSystemPrompt()).toBe(SYSTEM_PROMPT);
    expect(buildSystemPrompt(undefined)).toBe(SYSTEM_PROMPT);
    expect(buildSystemPrompt("   ")).toBe(SYSTEM_PROMPT);
  });

  test("the objective is one delimited block, verbatim, added to the standing goal", () => {
    const p = buildSystemPrompt(OBJECTIVE);
    expect(p).toContain("--- Operator objective for this run ---");
    expect(p).toContain(`--- Operator objective for this run ---\n${OBJECTIVE}\n`);
    expect(p).toContain("--- end operator objective ---");
    // Added, never replacing: the standing goal and the whole body survive.
    expect(p).toContain("There is no single number to maximize");
    expect(p).toContain("## The snippet runtime");
    expect(p.length).toBeGreaterThan(SYSTEM_PROMPT.length);
    // The block sits between the goal and the runtime description.
    expect(p.indexOf("There is no single number to maximize")).toBeLessThan(
      p.indexOf("--- Operator objective for this run ---"),
    );
    expect(p.indexOf("--- end operator objective ---")).toBeLessThan(p.indexOf("## The snippet runtime"));
  });

  test("the text depends on the objective alone — not the model, driver or effort", async () => {
    // The claude driver's `--system-prompt` value...
    const args = claudeArgs({
      mcpConfigPath: "/tmp/mcp.json",
      systemPrompt: buildSystemPrompt(OBJECTIVE),
      model: "sonnet",
      effort: "high",
    });
    const viaClaude = args[args.indexOf("--system-prompt") + 1];
    // ...and the fixed loop's system message, for a different model entirely.
    const adapter = new StubAdapter([{ content: "noop", toolCalls: [] }]);
    const dir = mkdtempSync(join(tmpdir(), "wrathbench-objective-"));
    const config = {
      ...loadRunConfig({
        driver: "stub",
        model: "some/other-model:free",
        effort: "low",
        objective: OBJECTIVE,
        stepIntervalMs: 0,
        stateIntervalMs: 1,
      }),
      runId: "run-objective",
      token: "run-objective",
    };
    const trajectory = new Trajectory(dir);
    trajectory.writeMeta({ runId: config.runId, harnessVersion: "t", startedAt: Date.now(), config });
    await runLoop({
      config,
      adapter,
      sandbox: fakeSandbox(),
      scratchpad: new Scratchpad(join(dir, "scratchpad.md")),
      trajectory,
      watchdogs: new Watchdogs(config.watchdogs),
      sleep: () => Promise.resolve(),
    });
    const request = readTrajectory(dir).find((r) => r.t === "request");
    const messages = request?.["messages"] as { role: string; content: string }[];
    const viaLoop = messages.find((m) => m.role === "system")?.content;
    expect(viaLoop).toBe(viaClaude!);
    expect(viaLoop).toBe(buildSystemPrompt(OBJECTIVE));
    trajectory.close();
  });
});

describe("meta recording", () => {
  test("meta.json and the run row carry the objective and the unscored stamp", () => {
    const dir = mkdtempSync(join(tmpdir(), "wrathbench-objective-meta-"));
    const config = loadRunConfig({
      runId: "run-meta",
      driver: "claude-code",
      model: "sonnet",
      objective: OBJECTIVE,
    });
    const trajectory = new Trajectory(dir);
    const shakeout = unscoredStamp(config.driver, config.objective)!;
    trajectory.writeMeta({
      runId: "run-meta",
      harnessVersion: "t",
      startedAt: Date.now(),
      config,
      shakeout,
    });
    expect(readMeta(dir)?.config.objective).toBe(OBJECTIVE);
    expect(readMeta(dir)?.shakeout).toContain(OBJECTIVE_STAMP);
    const row = trajectory.runRow("run-meta");
    expect(row?.["objective"]).toBe(OBJECTIVE);
    expect(String(row?.["shakeout"])).toContain(OBJECTIVE_STAMP);
    // And the trajectory's own meta record, which the viewer falls back to.
    const meta = readTrajectory(dir).find((r) => r.t === "meta");
    expect((meta?.["config"] as { objective?: string }).objective).toBe(OBJECTIVE);
    trajectory.close();
  });
});

describe("watchdog overrides", () => {
  test("the override schema takes a partial object and refuses unknown keys", () => {
    expect(watchdogOverrideSchema.parse({})).toEqual({});
    expect(watchdogOverrideSchema.parse({ noXpMs: null, idleMs: 1_200_000 })).toEqual({
      noXpMs: null,
      idleMs: 1_200_000,
    });
    expect(watchdogOverrideSchema.safeParse({ noXpMS: 5 }).success).toBe(false);
    expect(watchdogOverrideSchema.safeParse({ idleMs: -1 }).success).toBe(false);
  });

  test("null and 0 both mean disabled once parsed into the run config", () => {
    expect(loadRunConfig({ watchdogs: { noXpMs: null } }).watchdogs.noXpMs).toBeNull();
    // 0 is the only disable spelling argv can carry.
    expect(loadRunConfig({ watchdogs: { noXpMs: 0 } }).watchdogs.noXpMs).toBeNull();
    // Everything unset keeps its default.
    const c = loadRunConfig({ watchdogs: { noXpMs: null } }).watchdogs;
    expect(c.idleMs).toBe(10 * 60_000);
    expect(c.episodeMs).toBe(6 * 60 * 60_000);
    expect(c.maxSandboxRestarts).toBe(3);
  });

  test("a disabled watchdog never fires, however long the clock runs", () => {
    const config = loadRunConfig({
      watchdogs: { noXpMs: 0, idleMs: null, episodeMs: 21_600_000 },
    });
    let now = 0;
    const w = new Watchdogs(config.watchdogs, () => now);
    w.noteProgress(1, 0);
    now = 21_599_999;
    // no-xp and idle are off; the wall clock has not run out yet.
    expect(w.check()).toBeNull();
    now = 21_600_000;
    expect(w.check()?.reason).toBe("episode-limit");
  });

  test("overrides are recorded in meta, so a probe's leash is readable after the fact", () => {
    const dir = mkdtempSync(join(tmpdir(), "wrathbench-objective-wd-"));
    const config = loadRunConfig({
      runId: "run-wd",
      watchdogs: { noXpMs: null, episodeMs: 21_600_000, idleMs: 1_200_000 },
    });
    const trajectory = new Trajectory(dir);
    trajectory.writeMeta({ runId: "run-wd", harnessVersion: "t", startedAt: Date.now(), config });
    expect(readMeta(dir)?.config.watchdogs).toEqual({
      noXpMs: null,
      episodeMs: 21_600_000,
      idleMs: 1_200_000,
      maxSandboxRestarts: 3,
    });
    trajectory.close();
  });
});

describe("argv -> run config", () => {
  test("the nav-probe lane's generated argv lands as the config the probe needs", () => {
    // Verbatim what `episodeArgv` produces for the nav-probe lane entry. If any
    // of it silently failed to land, the 6h probe would die at 45 minutes as
    // `no-xp` and read like a harness fault.
    const config = configFromArgs([
      "--driver", "claude-code",
      "--model", "sonnet",
      "--run-id", "fleet-nav-probe-sonnet-20260822",
      "--account", "SHAKEOUT",
      "--objective", OBJECTIVE,
      "--max-tool-calls", "2500",
      "--wiki-coords", "true",
      "--character", "Navprobe",
      "--race", "3",
      "--class", "2",
      "--episode-ms", "21600000",
      "--watchdogs-json", JSON.stringify({ idleMs: 1_200_000, noXpMs: null }),
    ]);
    expect(config.objective).toBe(OBJECTIVE);
    expect(config.maxToolCallsPerEpisode).toBe(2500);
    expect(config.wikiCoords).toBe(true);
    expect(config.watchdogs).toEqual({
      idleMs: 1_200_000,
      noXpMs: null,
      episodeMs: 21_600_000,
      maxSandboxRestarts: 3,
    });
    expect(config).toMatchObject({
      driver: "claude-code",
      model: "sonnet",
      account: "SHAKEOUT",
      character: "Navprobe",
      race: 3,
      class: 2,
    });
    expect(unscoredStamp(config.driver, config.objective)).toContain(OBJECTIVE_STAMP);
  });

  test("no dimensions on the command line means the shipped defaults", () => {
    const config = configFromArgs(["--driver", "openai", "--model", "m:free"]);
    expect(config.objective).toBeUndefined();
    expect(config.wikiCoords).toBe(false);
    expect(config.watchdogs).toEqual({
      idleMs: 10 * 60_000,
      noXpMs: 45 * 60_000,
      episodeMs: 6 * 60 * 60_000,
      maxSandboxRestarts: 3,
    });
    expect(config.maxToolCallsPerEpisode).toBe(500);
  });

  test("--wiki-coords is a flag: bare, true/1 on; false/0 off; absent is names-first", () => {
    expect(configFromArgs(["--model", "m", "--wiki-coords", "--race", "1"]).wikiCoords).toBe(true);
    expect(configFromArgs(["--model", "m", "--wiki-coords", "1"]).wikiCoords).toBe(true);
    expect(configFromArgs(["--model", "m", "--wiki-coords", "false"]).wikiCoords).toBe(false);
    expect(configFromArgs(["--model", "m"]).wikiCoords).toBe(false);
  });

  test("--extra is a flag like --wiki-coords; absent is a counted run (ADR-0034)", () => {
    expect(configFromArgs(["--model", "m", "--extra", "true"]).extra).toBe(true);
    expect(configFromArgs(["--model", "m", "--extra", "--race", "3"]).extra).toBe(true);
    expect(configFromArgs(["--model", "m"]).extra).toBe(false);
  });

  test("--no-xp-ms 0 is the command-line spelling of disabled", () => {
    expect(configFromArgs(["--model", "m", "--no-xp-ms", "0"]).watchdogs.noXpMs).toBeNull();
  });
});

describe("the viewer's run row", () => {
  test("exposes the objective, so a steered run is identifiable in the listing", () => {
    const runs = mkdtempSync(join(tmpdir(), "wrathbench-objective-viewer-"));
    const config = loadRunConfig({ runId: "run-view", model: "sonnet", objective: OBJECTIVE });
    const trajectory = new Trajectory(join(runs, "run-view"));
    trajectory.writeMeta({
      runId: "run-view",
      harnessVersion: "t",
      startedAt: Date.now(),
      config,
      shakeout: unscoredStamp("openai", OBJECTIVE)!,
    });
    trajectory.close();
    const row = readRun(runs, "run-view");
    expect(row.objective).toBe(OBJECTIVE);
    expect(row.shakeout).toBe(OBJECTIVE_STAMP);
    // A run with no objective reports null, not an empty string.
    const plain = new Trajectory(join(runs, "run-plain"));
    plain.writeMeta({
      runId: "run-plain",
      harnessVersion: "t",
      startedAt: Date.now(),
      config: loadRunConfig({ runId: "run-plain", model: "sonnet" }),
    });
    plain.close();
    expect(readRun(runs, "run-plain").objective).toBeNull();
  });
});

function fakeSandbox(): SandboxHost {
  const fake = {
    evalSnippet: (code: string): Promise<SnippetResult> =>
      Promise.resolve({ ok: true, value: `ran:${code}`, logs: [], durationMs: 1 }),
    recentEvents: () => Promise.resolve([]),
    stateSnapshot: () => Promise.resolve({ self: {}, lastSeq: -1, eventCount: 0 }),
    totalRestarts: 0,
    consecutiveRestarts: 0,
    drainNotices: () => [],
    stop: () => Promise.resolve(),
  };
  return fake as unknown as SandboxHost;
}
