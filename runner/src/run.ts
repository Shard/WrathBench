#!/usr/bin/env bun
/**
 * Run entry point.
 *
 *   bun runner/src/run.ts --adapter openai --model <id> [--api-base URL] [flags]
 *   bun runner/src/run.ts --adapter stub --stub <script.json> [flags]
 *   bun runner/src/run.ts --resume <run-id>
 *
 * Flags map 1:1 onto config.ts. A resumed run reloads its config from
 * meta.json, keeps its token (so a still-alive module session is reattached by
 * the model's next createSession call), keeps its scratchpad and trajectory,
 * and starts the message window empty with a harness notice saying so — the
 * scratchpad, not the chat history, is the durable memory (ADR-0011).
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { OpenAiChatAdapter, StubAdapter, type ChatAdapter } from "./adapter";
import { loadRunConfig, newRunId, type RunConfig } from "./config";
import { runLoop } from "./loop";
import { SandboxHost } from "./sandbox/host";
import { Scratchpad } from "./scratchpad";
import { Trajectory, readMeta } from "./trajectory";
import { harnessVersion } from "./version";
import { Watchdogs } from "./watchdogs";

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function num(v: string | boolean | undefined): number | undefined {
  return typeof v === "string" ? Number(v) : undefined;
}

async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2));
  const resumeId = typeof args["resume"] === "string" ? args["resume"] : undefined;

  let config: RunConfig & { runId: string; token: string };
  let resumed = false;
  if (resumeId !== undefined) {
    const runsDir = typeof args["runs-dir"] === "string" ? args["runs-dir"] : "data/runs";
    const meta = readMeta(join(runsDir, resumeId));
    if (meta === null) {
      console.error(`no meta.json for run ${resumeId} under ${runsDir}`);
      process.exit(2);
    }
    const c = loadRunConfig(meta.config);
    config = { ...c, runId: resumeId, token: c.token ?? resumeId };
    resumed = true;
  } else {
    const runId = typeof args["run-id"] === "string" ? args["run-id"] : newRunId();
    const c = loadRunConfig({
      runId,
      moduleUrl:
        typeof args["module-url"] === "string"
          ? args["module-url"]
          : process.env["WRATHBENCH_MODULE_URL"] ?? undefined,
      token: typeof args["token"] === "string" ? args["token"] : runId,
      character: typeof args["character"] === "string" ? args["character"] : undefined,
      race: num(args["race"]),
      class: num(args["class"]),
      adapter: typeof args["adapter"] === "string" ? args["adapter"] : undefined,
      model: typeof args["model"] === "string" ? args["model"] : undefined,
      apiBase:
        typeof args["api-base"] === "string"
          ? args["api-base"]
          : process.env["OPENAI_BASE_URL"] ?? undefined,
      apiKeyEnv: typeof args["api-key-env"] === "string" ? args["api-key-env"] : undefined,
      stubScript: typeof args["stub"] === "string" ? args["stub"] : undefined,
      maxTurns: num(args["max-turns"]),
      stepIntervalMs: num(args["step-interval-ms"]),
      stateIntervalMs: num(args["state-interval-ms"]),
      snippetTimeoutMs: num(args["snippet-timeout-ms"]),
      runsDir: typeof args["runs-dir"] === "string" ? args["runs-dir"] : undefined,
      wikiBundle: typeof args["wiki-bundle"] === "string" ? args["wiki-bundle"] : undefined,
      watchdogs: {
        ...(num(args["idle-ms"]) !== undefined ? { idleMs: num(args["idle-ms"]) } : {}),
        ...(num(args["no-xp-ms"]) !== undefined ? { noXpMs: num(args["no-xp-ms"]) } : {}),
        ...(num(args["episode-ms"]) !== undefined ? { episodeMs: num(args["episode-ms"]) } : {}),
      },
    });
    config = { ...c, runId: c.runId ?? runId, token: c.token ?? runId };
  }

  const runDir = join(config.runsDir, config.runId);
  const trajectory = new Trajectory(runDir);
  const scratchpad = new Scratchpad(join(runDir, "scratchpad.md"));

  // adapter
  let adapter: ChatAdapter;
  if (config.adapter === "stub") {
    if (config.stubScript === undefined) {
      console.error("--adapter stub requires --stub <script.json>");
      process.exit(2);
    }
    adapter = StubAdapter.fromScriptFile(config.stubScript);
  } else {
    const apiKey = process.env[config.apiKeyEnv];
    const apiBase = config.apiBase ?? process.env["OPENAI_BASE_URL"];
    if (config.model === undefined || apiKey === undefined || apiBase === undefined) {
      console.error(
        `openai adapter needs --model, --api-base (or OPENAI_BASE_URL), and $${config.apiKeyEnv} set`,
      );
      process.exit(2);
    }
    trajectory.redact(apiKey);
    adapter = new OpenAiChatAdapter({ baseUrl: apiBase, apiKey, model: config.model });
  }

  const version = harnessVersion();
  if (!resumed) {
    trajectory.writeMeta({ runId: config.runId, harnessVersion: version, startedAt: Date.now(), config });
  } else {
    trajectory.clearPause(config.runId);
    trajectory.append({ t: "resume", harnessVersion: version });
  }

  const sandbox = new SandboxHost({
    moduleUrl: config.moduleUrl,
    token: config.token,
    scratchpad,
    snippetTimeoutMs: config.snippetTimeoutMs,
    pingGraceMs: config.sandboxPingGraceMs,
    onNotice: (n) => trajectory.append({ t: "harness", ...n }),
  });
  const wiki = existsSync(config.wikiBundle)
    ? new Database(config.wikiBundle, { readonly: true })
    : undefined;
  if (wiki === undefined) {
    console.error(`warning: wiki bundle not found at ${config.wikiBundle}; search_reference will report unavailable`);
  }

  const watchdogs = new Watchdogs(config.watchdogs);

  let stopping = false;
  process.on("SIGINT", () => {
    if (stopping) process.exit(130);
    stopping = true;
    console.error("\nSIGINT: terminating run as `manual`");
    trajectory.setTermination(config.runId, "manual", "SIGINT");
    void sandbox.stop().finally(() => process.exit(130));
  });

  console.error(
    `[wrathbench] run ${config.runId} (${resumed ? "resumed" : "new"}) — adapter ${adapter.label}, harness ${version}`,
  );
  console.error(`[wrathbench] trajectory: ${runDir}`);

  const outcome = await runLoop({
    config,
    adapter,
    sandbox,
    scratchpad,
    wiki,
    trajectory,
    watchdogs,
    initialNotices: resumed
      ? [
          {
            ts: Date.now(),
            kind: "session_note",
            text:
              "the runner process was restarted and this run resumed. Conversation history was " +
              "not preserved; your scratchpad was. The game session may still exist under the " +
              "same token: run `await connect()`, then `await sdk.createSession({...})` — a " +
              "`token_in_use` error means the session is still alive and you can simply keep " +
              "acting through `sdk`.",
          },
        ]
      : [],
  });

  await sandbox.stop();
  if (outcome.kind === "paused") {
    console.error(`[wrathbench] paused: ${outcome.reason} — resume with --resume ${config.runId}`);
  } else {
    console.error(`[wrathbench] terminated: ${outcome.reason}${outcome.detail !== undefined ? ` (${outcome.detail})` : ""}`);
  }
  trajectory.close();
  wiki?.close();
}

if (import.meta.main) {
  void main();
}
