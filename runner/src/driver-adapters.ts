/**
 * The adapter half of the driver seam: per driver, what `run.ts` calls to
 * launch it. The facts about a driver (its harness, lane, billing, cost and the
 * rest) are in `drivers.ts`, which everything can read; this module imports
 * the adapters, so only `run.ts` and the tests import it.
 *
 * Keyed `Record<Driver, …>` so a driver in the registry with no adapter here
 * fails typecheck, and `drivers.test.ts` holds `kind` to `runEpisode`: a
 * scaffold runs its own episode, a fixed-loop driver hands `runLoop` a
 * `ChatAdapter`.
 */

import type { Database } from "bun:sqlite";
import { OpenAiChatAdapter, StubAdapter, type ChatAdapter } from "./adapter";
import { runClaudeEpisode } from "./adapter-claude";
import { codexEffortRefusal, laneLooksLoggedIn, runCodexEpisode } from "./adapter-codex";
import { DEFAULT_CLAUDE_TOKEN_ENV, DEFAULT_CODEX_HOME_ENV, isTokenEnvName, type Driver, type RunConfig } from "./config";
import type { EpisodicLog } from "./episodic";
import type { LoopOutcome, ObservationStallHook } from "./loop";
import { apiKeyRefusal } from "./providers";
import { ReferenceAdapter } from "./reference/adapter";
import { REFERENCE_ROUTE } from "./reference/route";
import { routingForRun } from "./routing";
import type { HarnessNotice, SandboxHost } from "./sandbox/host";
import type { Scratchpad } from "./scratchpad";
import type { Trajectory } from "./trajectory";
import type { Watchdogs } from "./watchdogs";

/** What a driver's launch preflight hands back. */
export interface DriverLaunch<C extends RunConfig> {
  /** The config the run records: a CLI lane is named even when it was the default. */
  config: C;
  /** The fixed loop's transport; absent on a scaffold, which runs its own turns. */
  adapter?: ChatAdapter;
}

/** What `run.ts` hands a scaffold's episode: the fields every scaffold driver takes. */
export interface ScaffoldEpisodeOptions {
  config: RunConfig & { runId: string; token: string };
  runDir: string;
  sandbox: SandboxHost;
  scratchpad: Scratchpad;
  episodic: EpisodicLog;
  wiki?: Database | undefined;
  trajectory: Trajectory;
  watchdogs: Watchdogs;
  initialNotices?: HarnessNotice[];
  turnOffset?: number;
  signal?: AbortSignal;
  onObservationStalled?: ObservationStallHook | undefined;
}

export interface DriverAdapter {
  /**
   * Before the sandbox and the game session are up: check the driver's key or
   * lane, redact its credential, and build the fixed loop's adapter. A missing
   * lane or key must fail in a second, naming the variable, so a refusal
   * prints and exits 2.
   */
  prepare<C extends RunConfig>(config: C, trajectory: Trajectory): DriverLaunch<C>;
  /** A scaffold's whole episode; absent on a fixed-loop driver, whose turns `runLoop` runs. */
  runEpisode?: (o: ScaffoldEpisodeOptions) => Promise<LoopOutcome>;
}

export const DRIVER_ADAPTERS: Readonly<Record<Driver, DriverAdapter>> = {
  openai: {
    prepare(config, trajectory) {
      const apiBase = config.apiBase ?? process.env["OPENAI_BASE_URL"];
      // Before the variable is even read: a key name and a base are config, and
      // the pair may only be one the provider table holds (runner/src/providers.ts).
      // The fleet refuses such an entry at parse and the store refuses the write;
      // this is the last place a run could still send one, so it refuses to start.
      const keyRefusal = apiBase === undefined ? null : apiKeyRefusal(config.apiKeyEnv, apiBase);
      if (keyRefusal !== null) {
        console.error(`openai driver refuses to start: ${keyRefusal}`);
        process.exit(2);
      }
      const apiKey = process.env[config.apiKeyEnv];
      if (config.model === undefined || apiKey === undefined || apiBase === undefined) {
        console.error(
          `openai driver needs --model, --api-base (or OPENAI_BASE_URL), and $${config.apiKeyEnv} set`,
        );
        process.exit(2);
      }
      trajectory.redact(apiKey);
      // Resolved once, here, and handed to both the adapter and the tuple
      // (`comparabilityOf` calls the same function): what the wire carries is
      // what the run records.
      const routing = routingForRun({ ...config, apiBase });
      const adapter = new OpenAiChatAdapter({
        baseUrl: apiBase,
        apiKey,
        apiKeyEnv: config.apiKeyEnv,
        model: config.model,
        ...(config.effort !== undefined ? { effort: config.effort } : {}),
        ...(routing !== null ? { routing } : {}),
        // The run is the conversation: one id for its whole life, resumes
        // included. Sent to OpenCode only (`openCodeSessionHeaders`).
        sessionId: config.runId,
      });
      return { config, adapter };
    },
  },

  "claude-code": {
    prepare(config, trajectory) {
      // The subscription lane: a var NAME, defaulting to the one the CLI itself
      // knows. Everything below says the CHOSEN name, so an operator reading a
      // refusal is told which of two subscriptions is missing.
      const tokenEnv = config.subscription ?? DEFAULT_CLAUDE_TOKEN_ENV;
      if (!isTokenEnvName(tokenEnv)) {
        console.error(`--token-env ${tokenEnv} is not an environment variable name (it must not be the token itself)`);
        process.exit(2);
      }
      const token = process.env[tokenEnv];
      if (token === undefined || token.trim().length === 0) {
        console.error(
          `--driver claude-code needs $${tokenEnv}.\n` +
            "  generate one with:  claude setup-token\n" +
            `  then put it in .env as ${tokenEnv}=... (.env is gitignored)\n` +
            "  and start the run through infra/run-episode.sh, which exports it for you.",
        );
        process.exit(2);
      }
      trajectory.redact(token);
      // Recorded, so the run names its lane rather than leaving a reader (or the
      // fleet's per-lane count) to infer the default. The NAME, never the value.
      return { config: { ...config, subscription: tokenEnv } };
    },
    runEpisode: runClaudeEpisode,
  },

  codex: {
    prepare(config) {
      // The subscription lane, by var NAME: its VALUE is a CODEX_HOME directory
      // whose auth.json holds the ChatGPT login (drivers.ts, DEFAULT_CODEX_HOME_ENV).
      // Checked here for the same reason the claude token is: a missing lane
      // must fail in a second, naming the variable, not after the sandbox and the
      // game session are up. The directory is never copied and auth.json never read.
      const laneEnv = config.subscription ?? DEFAULT_CODEX_HOME_ENV;
      if (!isTokenEnvName(laneEnv)) {
        console.error(`--token-env ${laneEnv} is not an environment variable name (for codex it names the var holding a CODEX_HOME path)`);
        process.exit(2);
      }
      const home = process.env[laneEnv];
      if (!laneLooksLoggedIn(home)) {
        console.error(
          `--driver codex needs $${laneEnv} to name a Codex home directory containing auth.json` +
            (home === undefined || home.trim().length === 0 ? " (it is unset)." : ` (${home} has none).`) +
            "\n  log in once with:  codex login   (a ChatGPT subscription; the login lands in ~/.codex/auth.json)\n" +
            `  then put the directory in .env as ${laneEnv}=/home/<you>/.codex (.env is gitignored)\n` +
            "  and start the run through infra/run-episode.sh, which exports it for you.\n" +
            "  One directory per lane, shared by that lane's runs — never a per-run copy: a copied\n" +
            "  refresh token is spent by whichever process refreshes first.",
        );
        process.exit(2);
      }
      // `none`/`minimal` are not Codex levels; refused by name, never mapped.
      const refusal = codexEffortRefusal(config.effort);
      if (refusal !== null) {
        console.error(refusal);
        process.exit(2);
      }
      if (config.model === undefined) {
        console.error("--driver codex needs --model (e.g. gpt-6-astra, gpt-5.5 — the ChatGPT catalogue's ids)");
        process.exit(2);
      }
      return { config: { ...config, subscription: laneEnv } };
    },
    runEpisode: runCodexEpisode,
  },

  stub: {
    prepare(config) {
      if (config.stubScript === undefined) {
        console.error("--driver stub requires --stub <script.json>");
        process.exit(2);
      }
      return { config, adapter: StubAdapter.fromScriptFile(config.stubScript) };
    },
  },

  reference: {
    prepare(config) {
      // The scripted reference: its route through `run_snippet`, in this run's
      // sandbox and session like any model (`reference/adapter.ts`). No key, no
      // lane; `loadRunConfig` has already checked the start and named the model.
      const adapter = new ReferenceAdapter({
        route: REFERENCE_ROUTE,
        snippetTimeoutMs: config.snippetTimeoutMs,
        race: config.race,
        class: config.class,
      });
      return { config, adapter };
    },
  },
};
