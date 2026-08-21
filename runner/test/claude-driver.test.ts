/**
 * The claude-subscription driver, exercised end to end against a scripted fake
 * `claude` binary on PATH. No live stack, no real CLI, no subscription quota:
 * the fake speaks the real stream-json protocol and really calls our MCP
 * server through the loopback bridge.
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childEnv, claudeArgs, detectLimit, mcpToolNames, runClaudeEpisode } from "../src/adapter-claude";
import { SHAKEOUT_STAMP, isShakeoutDriver, loadRunConfig } from "../src/config";
import { SYSTEM_PROMPT } from "../src/prompt";
import { Scratchpad } from "../src/scratchpad";
import { renderTimeline } from "../src/timeline";
import { TOOLS } from "../src/tools";
import { Trajectory, readMeta, readTrajectory } from "../src/trajectory";
import { harnessVersion, HARNESS_VERSION_FALLBACK } from "../src/version";
import { Watchdogs } from "../src/watchdogs";
import type { SandboxHost, SnippetResult } from "../src/sandbox/host";

const FIXTURE = join(import.meta.dir, "fixtures", "fake-claude.ts");

function fakeSandbox(): SandboxHost {
  return {
    evalSnippet: (code: string): Promise<SnippetResult> =>
      Promise.resolve({ ok: true, value: `ran:${code}`, logs: [], durationMs: 1 }),
    recentEvents: () => Promise.resolve([]),
    stateSnapshot: () => Promise.resolve({ self: {}, lastSeq: -1, eventCount: 0 }),
    totalRestarts: 0,
    consecutiveRestarts: 0,
    drainNotices: () => [],
    stop: () => Promise.resolve(),
  } as unknown as SandboxHost;
}

/** A directory holding an executable `claude` that runs the fixture. */
function fakeBinDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "wrathbench-fakebin-"));
  const path = join(dir, "claude");
  writeFileSync(path, `#!/bin/sh\nexec ${process.execPath} ${FIXTURE} "$@"\n`, "utf8");
  chmodSync(path, 0o755);
  return dir;
}

interface EpisodeSetup {
  runDir: string;
  recordPath: string;
  trajectory: Trajectory;
  options: Parameters<typeof runClaudeEpisode>[0];
}

function setupEpisode(
  mode: string,
  extraConfig: Record<string, unknown> = {},
  parentEnvExtra: Record<string, string> = {},
): EpisodeSetup {
  const runDir = mkdtempSync(join(tmpdir(), "wrathbench-claude-run-"));
  const recordPath = join(runDir, "record.json");
  const config = {
    ...loadRunConfig({
      driver: "claude-subscription",
      model: "opus",
      stepIntervalMs: 0,
      stateIntervalMs: 1,
      ...extraConfig,
    }),
    runId: "run-test",
    token: "run-test",
  };
  const trajectory = new Trajectory(runDir);
  trajectory.writeMeta({
    runId: "run-test",
    harnessVersion: "t",
    startedAt: Date.now(),
    config,
    shakeout: SHAKEOUT_STAMP,
  });
  return {
    runDir,
    recordPath,
    trajectory,
    options: {
      config,
      runDir,
      sandbox: fakeSandbox(),
      scratchpad: new Scratchpad(join(runDir, "scratchpad.md")),
      trajectory,
      watchdogs: new Watchdogs(config.watchdogs),
      sleep: () => Promise.resolve(),
      env: {
        PATH: `${fakeBinDir()}:${process.env["PATH"] ?? ""}`,
        HOME: process.env["HOME"] ?? "/tmp",
        // a key that must NOT reach the child
        ANTHROPIC_API_KEY: "sk-ant-must-not-be-used",
        AWS_BEARER_TOKEN_BEDROCK: "must-not-be-used",
        CLAUDE_CODE_OAUTH_TOKEN: "oauth-token-for-tests",
        WB_FAKE_MODE: mode,
        WB_FAKE_RECORD: recordPath,
        ...parentEnvExtra,
      },
    },
  };
}

function readRecord(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

describe("claude-subscription driver", () => {
  test("drives turns, round-trips a tool call through our MCP config, honours maxTurns", async () => {
    const { runDir, recordPath, trajectory, options } = setupEpisode("tools", { maxTurns: 2 });
    const outcome = await runClaudeEpisode(options);
    expect(outcome).toEqual({ kind: "terminated", reason: "turn-limit", detail: "2 turns" });

    const record = readRecord(recordPath);
    // the SAME fixed prompt as the OpenAI loop, byte for byte
    expect(record["systemPrompt"]).toBe(SYSTEM_PROMPT);
    // built-ins disabled; only our six tools granted
    expect(record["toolsFlag"]).toBe("");
    expect(record["allowedTools"]).toEqual(mcpToolNames());
    expect(record["strictMcpConfig"]).toBe(true);
    expect(record["inputFormat"]).toBe("stream-json");
    expect(record["outputFormat"]).toBe("stream-json");
    expect(record["model"]).toBe("opus");
    // our MCP server really answered tools/list over the loopback bridge
    expect(record["mcpTools"]).toEqual(TOOLS.map((t) => t.name));
    // the context message is the harness's, assembled by ADR-0012 machinery
    const userMessages = record["userMessages"] as string[];
    expect(userMessages).toHaveLength(2);
    expect(userMessages[0]).toContain("[turn 1]");
    expect(userMessages[0]).toContain("== state");

    // the tool call went to the runner's sandbox and is in the trajectory
    const records = readTrajectory(runDir);
    const types = records.map((r) => r.t);
    expect(types).toContain("snippet");
    expect(types).toContain("snippet_result");
    expect(types.filter((t) => t === "request")).toHaveLength(2);
    const snippetResult = records.find((r) => r.t === "snippet_result");
    expect(snippetResult?.["text"]).toContain('ran:await sdk.say("turn 1")');
    const result = records.find((r) => r.t === "claude_result");
    expect(result?.["numTurns"]).toBe(2);
    expect(trajectory.runRow("run-test")?.["termination_reason"]).toBe("turn-limit");
    trajectory.close();
  }, 20_000);

  test("the spawned CLI never sees API-key credentials", async () => {
    const { recordPath, trajectory, options } = setupEpisode("tools", { maxTurns: 1 });
    await runClaudeEpisode(options);
    const env = readRecord(recordPath)["env"] as Record<string, unknown>;
    expect(env["hasAnthropicApiKey"]).toBe(false);
    expect(env["hasAwsBearer"]).toBe(false);
    expect(env["hasOauthToken"]).toBe(true);
    // config dir is scratch, inside the run directory
    expect(String(env["configDir"])).toContain("claude-config");
    trajectory.close();
  }, 20_000);

  test("a usage-limit result pauses the run as window-exhausted", async () => {
    const { trajectory, options } = setupEpisode("limit", { maxTurns: 3 });
    const outcome = await runClaudeEpisode(options);
    expect(outcome.kind).toBe("paused");
    expect(outcome.kind === "paused" && outcome.reason).toBe("window-exhausted");
    expect(outcome.kind === "paused" && outcome.detail).toContain("resets at");
    expect(trajectory.runRow("run-test")?.["pause_reason"]).toBe("window-exhausted");
    expect(trajectory.runRow("run-test")?.["termination_reason"]).toBeNull();
    trajectory.close();
  }, 20_000);

  test("a usage-limit message on stderr with a non-zero exit also pauses", async () => {
    const { trajectory, options } = setupEpisode("limit-exit", { maxTurns: 3 });
    const outcome = await runClaudeEpisode(options);
    expect(outcome.kind).toBe("paused");
    expect(outcome.kind === "paused" && outcome.reason).toBe("window-exhausted");
    trajectory.close();
  }, 20_000);

  test("model output about in-game limits never pauses the run", async () => {
    const { trajectory, options } = setupEpisode("chatty-limit", { maxTurns: 1 });
    const outcome = await runClaudeEpisode(options);
    expect(outcome).toEqual({ kind: "terminated", reason: "turn-limit", detail: "1 turns" });
    expect(trajectory.runRow("run-test")?.["pause_reason"]).toBeNull();
    trajectory.close();
  }, 20_000);

  test("claudeArgs uses only flags that exist, and never invents --max-turns", () => {
    const args = claudeArgs({ mcpConfigPath: "/tmp/x.json", model: "opus" });
    expect(args.slice(0, 2)).toEqual(["-p", "--verbose"]);
    expect(args).toContain("--strict-mcp-config");
    expect(args).not.toContain("--max-turns");
    expect(args[args.indexOf("--tools") + 1]).toBe("");
  });
});

describe("detectLimit", () => {
  test("recognises the CLI's limit shapes and parses the reset epoch", () => {
    const epoch = detectLimit("Claude AI usage limit reached|1780000000");
    expect(epoch?.reason).toBe("window-exhausted");
    expect(epoch?.detail).toContain(new Date(1780000000 * 1000).toISOString());
    expect(detectLimit("You've hit your 5-hour limit. Your limit resets at 3pm.")?.reason).toBe(
      "window-exhausted",
    );
    expect(detectLimit("ordinary assistant text about limits of the sandbox")).toBeNull();
    expect(detectLimit(undefined)).toBeNull();
  });
});

describe("childEnv", () => {
  test("drops every billing credential and keeps the subscription token", () => {
    const env = childEnv(
      {
        PATH: "/usr/bin",
        ANTHROPIC_API_KEY: "sk-ant-secret",
        ANTHROPIC_AUTH_TOKEN: "t",
        ANTHROPIC_BASE_URL: "https://example.invalid",
        AWS_BEARER_TOKEN_BEDROCK: "b",
        GOOGLE_APPLICATION_CREDENTIALS: "/g.json",
        CLAUDE_CODE_USE_BEDROCK: "1",
        CLAUDE_CODE_OAUTH_TOKEN: "oauth",
        UNRELATED: "keep",
      },
      { configDir: "/runs/x/claude-config" },
    );
    expect(env["ANTHROPIC_API_KEY"]).toBeUndefined();
    expect(env["ANTHROPIC_AUTH_TOKEN"]).toBeUndefined();
    expect(env["ANTHROPIC_BASE_URL"]).toBeUndefined();
    expect(env["AWS_BEARER_TOKEN_BEDROCK"]).toBeUndefined();
    expect(env["GOOGLE_APPLICATION_CREDENTIALS"]).toBeUndefined();
    expect(env["CLAUDE_CODE_USE_BEDROCK"]).toBeUndefined();
    expect(env["CLAUDE_CODE_OAUTH_TOKEN"]).toBe("oauth");
    expect(env["UNRELATED"]).toBe("keep");
    expect(env["CLAUDE_CONFIG_DIR"]).toBe("/runs/x/claude-config");
  });
});

describe("driver selection and stamping", () => {
  test("config defaults to the openai driver and accepts the legacy adapter name", () => {
    expect(loadRunConfig({}).driver).toBe("openai");
    expect(loadRunConfig({ adapter: "stub" }).driver).toBe("stub");
    expect(loadRunConfig({ driver: "claude-subscription" }).driver).toBe("claude-subscription");
    expect(isShakeoutDriver("claude-subscription")).toBe(true);
    expect(isShakeoutDriver("openai")).toBe(false);
  });

  test("meta, sqlite and the timeline all carry the shakeout stamp", () => {
    const dir = mkdtempSync(join(tmpdir(), "wrathbench-stamp-"));
    const config = loadRunConfig({ driver: "claude-subscription", model: "opus" });
    const trajectory = new Trajectory(dir);
    trajectory.writeMeta({
      runId: "run-stamp",
      harnessVersion: "t",
      startedAt: Date.now(),
      config,
      shakeout: SHAKEOUT_STAMP,
    });
    const row = trajectory.runRow("run-stamp");
    expect(row?.["driver"]).toBe("claude-subscription");
    expect(row?.["shakeout"]).toBe(SHAKEOUT_STAMP);
    trajectory.close();

    expect(readMeta(dir)?.shakeout).toBe(SHAKEOUT_STAMP);
    const rendered = renderTimeline(dir, "run-stamp");
    expect(rendered).toContain("NOT A HARNESS RESULT");
    expect(rendered).toContain("driver:     claude-subscription");
  });

  test("run.ts refuses to start the claude driver without the OAuth token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wrathbench-refuse-"));
    const env = { ...process.env };
    delete env["CLAUDE_CODE_OAUTH_TOKEN"];
    const proc = Bun.spawn({
      cmd: [
        process.execPath,
        join(import.meta.dir, "..", "src", "run.ts"),
        "--driver",
        "claude-subscription",
        "--model",
        "opus",
        "--runs-dir",
        dir,
      ],
      // a cwd without a .env: Bun auto-loads one, and the repo's has the token
      cwd: dir,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(2);
    expect(stderr).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(stderr).toContain("claude setup-token");
  }, 20_000);
});

describe("harnessVersion", () => {
  test("prefers WRATHBENCH_HARNESS_VERSION when set", () => {
    expect(harnessVersion({ WRATHBENCH_HARNESS_VERSION: "0.0.0-phase0+gdeadbee-dirty" })).toBe(
      "0.0.0-phase0+gdeadbee-dirty",
    );
    // blank is not a version
    const fallback = harnessVersion({ WRATHBENCH_HARNESS_VERSION: "  " });
    expect(fallback === HARNESS_VERSION_FALLBACK || fallback.startsWith("0.0.0-phase0+g")).toBe(true);
  });
});
