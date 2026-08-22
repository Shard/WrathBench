#!/usr/bin/env bun
/**
 * Run entry point.
 *
 *   bun runner/src/run.ts --driver openai --model <id> [--api-base URL] [--effort low] [flags]
 *   bun runner/src/run.ts --driver stub --stub <script.json> [flags]
 *   bun runner/src/run.ts --driver claude-subscription --model opus  [SHAKEOUT ONLY]
 *   bun runner/src/run.ts --resume <run-id>
 *
 * Two run dimensions are recorded and never model-specific (ADR-0024):
 * `--objective "<text>"` renders one delimited operator objective into the
 * fixed prompt and stamps the run unscored, and `--watchdogs-json '{...}'`
 * (or the individual `--idle-ms`/`--no-xp-ms`/`--episode-ms` flags) overrides
 * watchdog thresholds, where `null`/`0` disables one. A third, `--wiki-coords`
 * (ADR-0028), serves wiki-recorded coordinates through `search_reference`;
 * the default is names-first, and the choice is stamped into the
 * comparability tuple so the two never share a chart.
 *
 * `--adapter` is the old name for `--driver` and still works.
 *
 * Flags map 1:1 onto config.ts. A resumed run reloads its config from
 * meta.json, keeps its token (so a still-alive module session is reattached by
 * the model's next createSession call), keeps its scratchpad and trajectory,
 * and starts the message window empty with a harness notice saying so — the
 * scratchpad, not the chat history, is the durable memory (ADR-0011).
 */

import { join } from "node:path";
import { comparabilityOf, fetchServerBuild, sameComparability } from "./comparability";
import { openWikiBundle } from "./wiki";
import { OpenAiChatAdapter, StubAdapter, type ChatAdapter } from "./adapter";
import { runClaudeEpisode } from "./adapter-claude";
import {
  DRIVERS,
  loadRunConfig,
  MIN_TOKEN_LENGTH,
  newRunId,
  newSessionToken,
  resolveSessionToken,
  shakeoutStamp,
  watchdogOverrideSchema,
  type RunConfig,
  type WatchdogOverride,
} from "./config";
import { runLoop } from "./loop";
import { SandboxHost } from "./sandbox/host";
import { Scratchpad } from "./scratchpad";
import { Trajectory, readMeta, type RunMeta } from "./trajectory";
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

/**
 * A boolean flag: bare `--wiki-coords` or `--wiki-coords true|1|yes` is on,
 * `--wiki-coords false|0|no` is off, absent is undefined (the zod default).
 */
function flag(v: string | boolean | undefined): boolean | undefined {
  if (v === undefined) return undefined;
  if (typeof v === "boolean") return v;
  const t = v.trim().toLowerCase();
  if (t === "true" || t === "1" || t === "yes") return true;
  if (t === "false" || t === "0" || t === "no") return false;
  return undefined;
}

function num(v: string | boolean | undefined): number | undefined {
  return typeof v === "string" ? Number(v) : undefined;
}

/**
 * `--watchdogs-json '{"noXpMs":null,"idleMs":1200000}'` — the whole override
 * object in one flag. The individual `--idle-ms`/`--no-xp-ms`/`--episode-ms`
 * flags still work and are applied first; this one wins where they overlap,
 * because it is the only spelling that can carry `null` (disable) through
 * argv, and the roster emits it for exactly that reason (ADR-0024).
 */
function watchdogOverrides(v: string | boolean | undefined): WatchdogOverride {
  if (typeof v !== "string") return {};
  let raw: unknown;
  try {
    raw = JSON.parse(v);
  } catch {
    console.error(`--watchdogs-json is not valid JSON: ${v}`);
    process.exit(2);
  }
  const parsed = watchdogOverrideSchema.safeParse(raw);
  if (!parsed.success) {
    console.error(`--watchdogs-json rejected: ${parsed.error.message}`);
    process.exit(2);
  }
  return parsed.data;
}

/**
 * A fresh run's config, assembled from raw argv.
 *
 * Exported (and taking argv rather than a parsed object) so the whole seam —
 * `parseArgs`, the per-flag plumbing, `--watchdogs-json`, and the zod defaults
 * — is testable as one unit. A dropped flag here is invisible until a run ends
 * hours early for the wrong reason, which is exactly what the roster's
 * generated argv must be pinned against.
 */
export function configFromArgs(argv: string[]): RunConfig & { runId: string; token: string } {
  const args = parseArgs(argv);
  const runId = typeof args["run-id"] === "string" ? args["run-id"] : newRunId();
  const c = loadRunConfig({
    runId,
    moduleUrl:
      typeof args["module-url"] === "string"
        ? args["module-url"]
        : process.env["WRATHBENCH_MODULE_URL"] ?? undefined,
    token: typeof args["token"] === "string" ? args["token"] : newSessionToken(),
    character: typeof args["character"] === "string" ? args["character"] : undefined,
    account: typeof args["account"] === "string" ? args["account"] : undefined,
    race: num(args["race"]),
    class: num(args["class"]),
    driver: typeof args["driver"] === "string" ? args["driver"] : undefined,
    adapter: typeof args["adapter"] === "string" ? args["adapter"] : undefined,
    model: typeof args["model"] === "string" ? args["model"] : undefined,
    apiBase:
      typeof args["api-base"] === "string"
        ? args["api-base"]
        : process.env["OPENAI_BASE_URL"] ?? undefined,
    apiKeyEnv: typeof args["api-key-env"] === "string" ? args["api-key-env"] : undefined,
    // Identity, like model and driver: a resumed run keeps the effort it was
    // launched with, so --effort is not an override on --resume.
    effort: typeof args["effort"] === "string" ? args["effort"] : undefined,
    // Identity, like model and effort: an objective steers what the whole
    // run was for, so a resumed run keeps the one it was launched with.
    objective: typeof args["objective"] === "string" ? args["objective"] : undefined,
    // Identity too (ADR-0028): what the reference surface served is part of
    // what the run was, so a resume keeps the stored value.
    wikiCoords: flag(args["wiki-coords"]),
    stubScript: typeof args["stub"] === "string" ? args["stub"] : undefined,
    maxTurns: num(args["max-turns"]),
    maxToolCallsPerEpisode: num(args["max-tool-calls"]),
    stepIntervalMs: num(args["step-interval-ms"]),
    stateIntervalMs: num(args["state-interval-ms"]),
    snippetTimeoutMs: num(args["snippet-timeout-ms"]),
    runsDir: typeof args["runs-dir"] === "string" ? args["runs-dir"] : undefined,
    wikiBundle: typeof args["wiki-bundle"] === "string" ? args["wiki-bundle"] : undefined,
    watchdogs: {
      ...(num(args["idle-ms"]) !== undefined ? { idleMs: num(args["idle-ms"]) } : {}),
      ...(num(args["no-xp-ms"]) !== undefined ? { noXpMs: num(args["no-xp-ms"]) } : {}),
      ...(num(args["episode-ms"]) !== undefined ? { episodeMs: num(args["episode-ms"]) } : {}),
      ...watchdogOverrides(args["watchdogs-json"]),
    },
  });
  return { ...c, runId: c.runId ?? runId, token: c.token ?? newSessionToken() };
}

async function main(): Promise<void> {
  const rawArgs = Bun.argv.slice(2);
  const args = parseArgs(rawArgs);
  const resumeId = typeof args["resume"] === "string" ? args["resume"] : undefined;
  if (typeof args["driver"] === "string" && !(DRIVERS as readonly string[]).includes(args["driver"])) {
    console.error(`unknown --driver ${args["driver"]} (one of: ${DRIVERS.join(", ")})`);
    process.exit(2);
  }

  let config: RunConfig & { runId: string; token: string };
  let resumed = false;
  /** The meta.json a resume loaded, kept so a regenerated token can be persisted. */
  let resumedMeta: RunMeta | undefined;
  let tokenRegenerated = false;
  if (resumeId !== undefined) {
    const runsDir = typeof args["runs-dir"] === "string" ? args["runs-dir"] : "data/runs";
    const meta = readMeta(join(runsDir, resumeId));
    if (meta === null) {
      console.error(`no meta.json for run ${resumeId} under ${runsDir}`);
      process.exit(2);
    }
    const c = loadRunConfig(meta.config);
    // Explicit limit/watchdog flags override the stored config: resuming a
    // runaway with a tighter leash is the whole point of passing them here.
    // Identity (character, token, driver, model) stays as stored.
    const overrides = {
      ...(num(args["max-turns"]) !== undefined ? { maxTurns: num(args["max-turns"])! } : {}),
      ...(num(args["max-tool-calls"]) !== undefined
        ? { maxToolCallsPerEpisode: num(args["max-tool-calls"])! }
        : {}),
      watchdogs: {
        ...c.watchdogs,
        ...(num(args["idle-ms"]) !== undefined ? { idleMs: num(args["idle-ms"])! } : {}),
        ...(num(args["no-xp-ms"]) !== undefined ? { noXpMs: num(args["no-xp-ms"])! } : {}),
        ...(num(args["episode-ms"]) !== undefined ? { episodeMs: num(args["episode-ms"])! } : {}),
        ...watchdogOverrides(args["watchdogs-json"]),
      },
    };
    // A stored token shorter than the module's floor is a pre-hardening run's
    // (it was the run id): replace it and persist the replacement below.
    const session = resolveSessionToken(c.token);
    config = { ...c, ...overrides, runId: resumeId, token: session.token };
    resumedMeta = meta;
    tokenRegenerated = session.regenerated;
    resumed = true;
  } else {
    config = configFromArgs(rawArgs);
  }
  // Deliberately NOT registered with `trajectory.redact`: meta.json is scrubbed
  // with the same secret list, and a redacted token could never be read back by
  // `--resume`. Trajectories are gitignored and stay on the operator's disk.

  // Before the run directory, the trajectory and the session: a stale bundle is
  // a deploy mistake, and failing here leaves no half-run behind — the roster
  // sees an exit with no run.sqlite and calls it `launch-failed`.
  const wiki = openWikiBundle(config.wikiBundle);
  if (wiki === undefined) {
    console.error(`warning: wiki bundle not found at ${config.wikiBundle}; search_reference will report unavailable`);
  }

  const runDir = join(config.runsDir, config.runId);
  const trajectory = new Trajectory(runDir);
  const scratchpad = new Scratchpad(join(runDir, "scratchpad.md"));

  // driver
  let adapter: ChatAdapter | undefined;
  if (config.driver === "stub") {
    if (config.stubScript === undefined) {
      console.error("--driver stub requires --stub <script.json>");
      process.exit(2);
    }
    adapter = StubAdapter.fromScriptFile(config.stubScript);
  } else if (config.driver === "claude-subscription") {
    const token = process.env["CLAUDE_CODE_OAUTH_TOKEN"];
    if (token === undefined || token.trim().length === 0) {
      console.error(
        "--driver claude-subscription needs $CLAUDE_CODE_OAUTH_TOKEN.\n" +
          "  generate one with:  claude setup-token\n" +
          "  then put it in .env as CLAUDE_CODE_OAUTH_TOKEN=... (.env is gitignored)\n" +
          "  and start the run through infra/run-episode.sh, which exports it for you.",
      );
      process.exit(2);
    }
    trajectory.redact(token);
  } else {
    const apiKey = process.env[config.apiKeyEnv];
    const apiBase = config.apiBase ?? process.env["OPENAI_BASE_URL"];
    if (config.model === undefined || apiKey === undefined || apiBase === undefined) {
      console.error(
        `openai driver needs --model, --api-base (or OPENAI_BASE_URL), and $${config.apiKeyEnv} set`,
      );
      process.exit(2);
    }
    trajectory.redact(apiKey);
    adapter = new OpenAiChatAdapter({
      baseUrl: apiBase,
      apiKey,
      model: config.model,
      ...(config.effort !== undefined ? { effort: config.effort } : {}),
    });
  }

  const shakeout = shakeoutStamp(config.driver, config.objective);
  const version = harnessVersion();
  // Never blocks launch: an unreachable module (or one that predates the
  // field) reads as `null`, same as "not recorded" everywhere else in the
  // tuple. Fetched fresh on every launch and every resume-restamp, so a
  // resumed run's tuple names the build it is actually resuming against.
  const serverBuild = await fetchServerBuild(config.moduleUrl);
  const comparability = comparabilityOf(config, version, serverBuild);
  if (!resumed) {
    trajectory.writeMeta({
      runId: config.runId,
      harnessVersion: version,
      startedAt: Date.now(),
      config,
      comparability,
      ...(shakeout !== undefined ? { shakeout } : {}),
    });
  } else {
    trajectory.clearPause(config.runId);
    trajectory.append({ t: "resume", harnessVersion: version });
    /*
     * A resume may tighten the leash (`--max-turns`, `--watchdogs-json`), and a
     * budget stamped at launch would then describe a run that no longer exists.
     * The tuple is re-stamped to what will actually be enforced, and the change
     * is recorded so the earlier portion is still readable in the trajectory.
     */
    if (
      resumedMeta !== undefined &&
      (resumedMeta.comparability === undefined ||
        !sameComparability(resumedMeta.comparability, comparability))
    ) {
      /*
       * The harness version moves with the tuple. A resumed run is driven by
       * the build that resumed it, and leaving the top-level stamp at the
       * launch build would have the run row and its own tuple naming two
       * different versions — on charts whose entire claim is comparability.
       */
      trajectory.writeMeta({ ...resumedMeta, harnessVersion: version, config, comparability });
      trajectory.append({
        t: "harness",
        kind: "comparability_restamped",
        // Whether anything but the build stamp moved: a resume onto a newer
        // commit always restamps, and only this says the leash actually changed.
        leashChanged:
          resumedMeta.comparability !== undefined &&
          !sameComparability(
            { ...resumedMeta.comparability, harnessVersion: version },
            comparability,
          ),
        before: resumedMeta.comparability ?? null,
        after: comparability,
      });
    }
    if (tokenRegenerated && resumedMeta !== undefined) {
      // Persist the new secret, or the next resume would regenerate again and
      // orphan this one. Everything else about the stored meta is preserved:
      // only `config` is replaced, and only its token differs.
      console.error(
        `[wrathbench] session token regenerated: the stored one was shorter than ` +
          `${MIN_TOKEN_LENGTH} chars (a pre-hardening run id, which the module now refuses as ` +
          `weak_token). No live session is stranded — the nightly worldserver recreate clears ` +
          `every module session.`,
      );
      trajectory.writeMeta({ ...resumedMeta, harnessVersion: version, config, comparability });
      trajectory.append({ t: "harness", kind: "token_regenerated", reason: "weak_stored_token" });
    }
  }

  /*
   * Where this episode's turn numbering continues from. `maxTurns` still counts
   * this process's turns; only the recorded index is cumulative, so a resumed
   * run's turns-to-level is the run's cost and not this episode's.
   */
  const turnOffset = resumed ? trajectory.maxTurn(config.runId) : 0;

  const sandbox = new SandboxHost({
    moduleUrl: config.moduleUrl,
    token: config.token,
    account: config.account,
    scratchpad,
    snippetTimeoutMs: config.snippetTimeoutMs,
    pingGraceMs: config.sandboxPingGraceMs,
    onNotice: (n) => trajectory.append({ t: "harness", ...n }),
  });
  const watchdogs = new Watchdogs(config.watchdogs);

  // A killed runner must still leave a finalised run. SIGTERM matters as much
  // as SIGINT here: that is what `docker compose down`, a supervisor, or an
  // operator's `kill` sends. The episode driver is asked to unwind (it records
  // the termination itself and tears down its CLI child); the fixed loop has
  // no such seam, so the record is written here.
  let stopping = false;
  const abort = new AbortController();
  const onSignal = (sig: string): void => {
    if (stopping) process.exit(130);
    stopping = true;
    console.error(`\n${sig}: terminating run as \`manual\``);
    if (config.driver === "claude-subscription") {
      abort.abort(sig);
      // Backstop: never hang forever waiting for a wedged child.
      setTimeout(() => process.exit(130), 20_000).unref();
    } else {
      trajectory.setTermination(config.runId, "manual", sig);
      void sandbox.stop().finally(() => process.exit(130));
    }
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  console.error(
    `[wrathbench] run ${config.runId} (${resumed ? "resumed" : "new"}) — driver ${config.driver}${adapter !== undefined ? ` (${adapter.label})` : ""}, harness ${version}`,
  );
  if (shakeout !== undefined) {
    console.error(`[wrathbench] ${shakeout.toUpperCase()} — this run is NOT a harness result`);
  }
  console.error(`[wrathbench] trajectory: ${runDir}`);

  if (!resumed) {
    // Episode hygiene (ADR-0006 fresh character per episode): the account has
    // ~10 character slots and every character on it is disposable between
    // episodes. Clear them so the model can always create its assigned one.
    // Best-effort: a failure here degrades to the old behaviour, it does not
    // block the run.
    try {
      const listRes = await fetch(`${config.moduleUrl}/characters`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Derived from the session secret, as `deleteCharacter` does: these are
        // throwaway tokens for one call each, but they still have to clear the
        // module's `weak_token` floor.
        body: JSON.stringify({ token: `${config.token}-hygiene`, account: config.account }),
      });
      const list = (await listRes.json()) as {
        ok?: boolean;
        enum?: { characters?: { name?: string }[] };
      };
      const names = (list.enum?.characters ?? []).map((c) => c.name).filter((n): n is string => !!n);
      for (const name of names) {
        const del = await fetch(`${config.moduleUrl}/character-delete`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            token: `${config.token}-hygiene-del-${name}`,
            account: config.account,
            character: name,
          }),
        });
        const dj = (await del.json()) as { deleted?: boolean; error?: string };
        if (dj.deleted !== true) {
          console.error(`[wrathbench] hygiene: could not delete leftover character ${name} (${dj.error ?? del.status})`);
        }
      }
      if (names.length > 0) {
        console.error(`[wrathbench] hygiene: cleared ${names.length} leftover character(s)`);
        trajectory.append({ t: "harness", kind: "hygiene", cleared: names.length });
      }
    } catch (err) {
      console.error(`[wrathbench] hygiene: skipped (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  const initialNotices = resumed
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
          } as const,
        ]
      : [
          {
            ts: Date.now(),
            kind: "session_note",
            text:
              `your assigned character for this episode: name "${config.character}", race ${config.race}, ` +
              `class ${config.class} (numeric ids; e.g. race 1 = Human, class 2 = Paladin). Create it with ` +
              `\`await sdk.createSession({ character: "${config.character}", race: ${config.race}, class: ${config.class} })\` ` +
              `after \`await connect()\`. Use exactly these values: the account's character slots were cleared ` +
              `for this episode and other combinations may be rejected by the server's race/class rules. ` +
              `The game account is assigned and bound for you by the harness — do not pass an account; ` +
              `createSession is issued on the correct one automatically.`,
          } as const,
        ];

  const outcome =
    config.driver === "claude-subscription"
      ? await runClaudeEpisode({
          config,
          runDir,
          sandbox,
          scratchpad,
          wiki,
          trajectory,
          watchdogs,
          initialNotices,
          turnOffset,
          signal: abort.signal,
        })
      : await runLoop({
          config,
          adapter: adapter!,
          sandbox,
          scratchpad,
          wiki,
          trajectory,
          watchdogs,
          initialNotices,
          turnOffset,
        });

  if (outcome.kind === "terminated") {
    // A finished run frees its module session so the account is not held
    // (the realm caps characters/sessions per account). A PAUSED run keeps
    // the session alive on purpose: that is the --resume path.
    try {
      await sandbox.evalSnippet(
        "if (typeof sdk !== 'undefined' && sdk) { try { await sdk.deleteSession(); } catch {} }",
      );
    } catch {
      // Best-effort: a dead sandbox or module leaves the session to the
      // module's own logout path.
    }
  }
  await sandbox.stop();
  if (outcome.kind === "paused") {
    console.error(`[wrathbench] paused: ${outcome.reason} — resume with --resume ${config.runId}`);
  } else {
    console.error(`[wrathbench] terminated: ${outcome.reason}${outcome.detail !== undefined ? ` (${outcome.detail})` : ""}`);
  }
  trajectory.close();
  if (stopping) {
    wiki?.close();
    process.exit(130);
  }
  wiki?.close();
}

if (import.meta.main) {
  void main();
}
