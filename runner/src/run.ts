#!/usr/bin/env bun
/**
 * Run entry point.
 *
 *   bun runner/src/run.ts --driver openai --model <id> [--api-base URL] [--effort low] [flags]
 *   bun runner/src/run.ts --driver stub --stub <script.json> [flags]
 *   bun runner/src/run.ts --driver claude-code --model opus  [claude-code harness]
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
 * `--episode <e90|e360|probing|freeplay>` names an episode tier (`episodes.ts`): the
 * wall clock and both watchdogs come from that one flag, and the id is stamped
 * into the comparability tuple. An explicit `--idle-ms`/`--no-xp-ms`/
 * `--episode-ms`/`--watchdogs-json` on top of it still wins, and the run is
 * then stamped `episodeOverride: true` so it cannot pass as a clean tier run.
 *
 * Flags map 1:1 onto config.ts. A resumed run reloads its config from
 * meta.json, keeps its token (so a still-alive module session is reattached by
 * the model's next createSession call), keeps its scratchpad and trajectory,
 * and starts the message window empty with a harness notice saying so — the
 * scratchpad, not the chat history, is the durable memory (ADR-0011).
 */

import { join } from "node:path";
import { archiveIfNoResponses } from "./archive";
import { comparabilityOf, fetchServerBuild, sameComparability } from "./comparability";
import { EPISODES, EPISODE_IDS, isEpisodeId } from "./episodes";
import { openWikiBundle, wikiBundleMeta } from "./wiki";
import { OpenAiChatAdapter, StubAdapter, type ChatAdapter } from "./adapter";
import { runClaudeEpisode } from "./adapter-claude";
import {
  DRIVERS,
  episodeOverrideOf,
  loadRunConfig,
  MIN_TOKEN_LENGTH,
  newRunId,
  newSessionToken,
  resolveSessionToken,
  unscoredStamp,
  watchdogOverrideSchema,
  type RunConfig,
  type WatchdogOverride,
} from "./config";
import { runLoop, type StopRequest } from "./loop";
import { SandboxHost } from "./sandbox/host";
import { Scratchpad } from "./scratchpad";
import { Trajectory, readMeta, type PauseMark, type RunMeta } from "./trajectory";
import { harnessVersion } from "./version";
import { Watchdogs } from "./watchdogs";
import { className, raceName } from "../viewer/characters";

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
    episode: typeof args["episode"] === "string" ? args["episode"] : undefined,
    driver: typeof args["driver"] === "string" ? args["driver"] : undefined,
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
    // Identity as well: a resumed extra is still an extra.
    extra: flag(args["extra"]),
    // A probe campaign's identity (ADR-0041), both or neither.
    campaign: typeof args["campaign"] === "string" ? args["campaign"] : undefined,
    cell: typeof args["cell"] === "string" ? args["cell"] : undefined,
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
  if (args["episode"] !== undefined && !isEpisodeId(args["episode"])) {
    console.error(`unknown --episode ${String(args["episode"])} (one of: ${EPISODE_IDS.join(", ")})`);
    process.exit(2);
  }
  /*
   * A tier that forbids an objective forbids it at launch, not on the chart.
   * The alternative — accepting the pair and stamping the run unscored — would
   * quietly turn a scored run into an unscored one, which is exactly the kind
   * of silent downgrade the tuple exists to prevent.
   */
  if (
    isEpisodeId(args["episode"]) &&
    typeof args["objective"] === "string" &&
    !EPISODES[args["episode"]].objectiveAllowed
  ) {
    console.error(
      `--episode ${args["episode"]} does not allow --objective; a steered run is --episode probing (a campaign) or --episode freeplay`,
    );
    process.exit(2);
  }

  let config: RunConfig & { runId: string; token: string };
  let resumed = false;
  /** The meta.json a resume loaded, kept so a regenerated token can be persisted. */
  let resumedMeta: RunMeta | undefined;
  /** The pause mark the resumed meta carried, read before the mark is consumed. */
  let resumedPause: PauseMark | undefined;
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
    resumedPause = meta.pause;
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
  // What was *in* that file, for the tuple: the config records only the path,
  // and the path holds a different reference surface after every rebuild.
  const wikiBundle = wikiBundleMeta(wiki);

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
  } else if (config.driver === "claude-code") {
    const token = process.env["CLAUDE_CODE_OAUTH_TOKEN"];
    if (token === undefined || token.trim().length === 0) {
      console.error(
        "--driver claude-code needs $CLAUDE_CODE_OAUTH_TOKEN.\n" +
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

  const shakeout = unscoredStamp(config.driver, config.objective);
  const version = harnessVersion();
  // Never blocks launch: an unreachable module (or one that predates the
  // field) reads as `null`, same as "not recorded" everywhere else in the
  // tuple. Fetched fresh on every launch and every resume-restamp, so a
  // resumed run's tuple names the build it is actually resuming against.
  const serverBuild = await fetchServerBuild(config.moduleUrl);
  const comparability = comparabilityOf(config, version, serverBuild, wikiBundle);
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
    trajectory.append({
      t: "resume",
      harnessVersion: version,
      ...(resumedPause !== undefined ? { after: resumedPause.reason, episodeElapsedMs: resumedPause.episodeElapsedMs } : {}),
    });
    /*
     * The pause mark is consumed: meta.json says "paused" only while the run
     * is. The claude-code driver cannot reattach the CLI's own conversation
     * (the CLI owns that history; the runner starts a fresh session with the
     * same fixed prompt and the scratchpad), so such a resume is stamped
     * `resumedFresh` in meta.json — sticky: the run had at least one fresh
     * restart in its life, which a reader of its turns should know.
     */
    if (resumedMeta !== undefined) {
      const { pause: _pause, ...rest } = resumedMeta;
      resumedMeta = {
        ...rest,
        ...(config.driver === "claude-code" ? { resumedFresh: true } : {}),
      };
      trajectory.writeMeta({ ...resumedMeta, harnessVersion: version, config, comparability });
    }
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
  /*
   * The episode clock continues from where the last segment left it: a
   * paused run's meta.json carries the wall clock it had spent, so a 90-minute
   * budget is 90 minutes of play however many times the fleet restarted
   * underneath it. A pause written before the mark existed resumes at zero.
   */
  const elapsedBeforeMs = resumedPause?.episodeElapsedMs ?? 0;
  const watchdogs = new Watchdogs(config.watchdogs, Date.now, elapsedBeforeMs);
  if (resumed && elapsedBeforeMs > 0) {
    console.error(`[wrathbench] episode clock resumes at ${Math.round(elapsedBeforeMs / 60_000)}m`);
  }

  // A stopped runner must still leave a run that says what happened to it.
  // Two signals, two meanings (ADR-0036):
  //  - SIGTERM is what a supervisor sends — `docker compose stop`, a drain, a
  //    recreate. The run PAUSES as `operator-pause`: clock stopped, session
  //    released, resumable with --resume. The fleet's stop must not cost a run.
  //  - SIGINT is the operator's Ctrl-C on a hand-started run: `manual`.
  // Either way the driver is asked to unwind cooperatively (the request in
  // flight is abandoned, the CLI child torn down) and the record is written
  // by the loop; a backstop writes it if the unwind wedges.
  let stopping = false;
  const abort = new AbortController();
  const onSignal = (sig: "SIGINT" | "SIGTERM"): void => {
    if (stopping) process.exit(130);
    stopping = true;
    const req: StopRequest =
      sig === "SIGTERM"
        ? { kind: "pause", reason: "operator-pause", detail: `${sig}: supervisor stop` }
        : { kind: "terminate", detail: sig };
    console.error(
      req.kind === "pause"
        ? `\n${sig}: pausing run as \`operator-pause\` (resume with --resume ${config.runId})`
        : `\n${sig}: terminating run as \`manual\``,
    );
    abort.abort(req);
    // Backstop: never hang forever waiting for a wedged child or snippet. If
    // the loop has not written its record by then, write it here so the run
    // is never left with neither a termination nor a pause.
    setTimeout(() => {
      const row = trajectory.runRow(config.runId);
      const recorded = row !== null && ((row["termination_reason"] ?? null) !== null || (row["pause_reason"] ?? null) !== null);
      if (!recorded) {
        if (req.kind === "pause") {
          trajectory.setPause(config.runId, req.reason, `${req.detail} (backstop)`, watchdogs.elapsedMs());
          trajectory.writeMeta({ ...(readMeta(runDir) ?? metaNow()), pause: pauseMark(req) });
        } else {
          trajectory.setTermination(config.runId, "manual", `${req.detail} (backstop)`);
        }
      }
      process.exit(130);
    }, req.kind === "pause" ? 60_000 : 20_000).unref();
  };
  const metaNow = (): RunMeta => ({
    runId: config.runId,
    harnessVersion: version,
    startedAt: Date.now(),
    config,
    comparability,
    ...(shakeout !== undefined ? { shakeout } : {}),
  });
  const pauseMark = (p: { reason: PauseMark["reason"]; detail?: string | undefined }): PauseMark => ({
    reason: p.reason,
    ...(p.detail !== undefined ? { detail: p.detail } : {}),
    at: Date.now(),
    episodeElapsedMs: watchdogs.elapsedMs(),
  });
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  console.error(
    `[wrathbench] run ${config.runId} (${resumed ? "resumed" : "new"}) — driver ${config.driver}${adapter !== undefined ? ` (${adapter.label})` : ""}, harness ${version}`,
  );
  if (config.episode !== undefined) {
    console.error(
      `[wrathbench] episode ${config.episode}${episodeOverrideOf(config) ? " (OVERRIDDEN — not a clean tier run)" : ""}`,
    );
  }
  if (shakeout !== undefined) {
    console.error(`[wrathbench] ${shakeout.toUpperCase()} — this run is NOT a scored result`);
  }
  console.error(`[wrathbench] trajectory: ${runDir}`);

  if (!resumed) {
    // Episode hygiene (ADR-0006 fresh character per episode): the account has
    // ~10 character slots and every character on it is disposable between
    // episodes. Clear them so the model can always create its assigned one.
    //
    // Mostly best-effort — EXCEPT for the assigned name. On 2026-08-24 a
    // delete timed out (the previous episode's character was still mid-logout
    // save), the run proceeded anyway, and the model's `createSession` reused
    // the level-6 character it found: a scored e90 that started at level 6.
    // So deletion is confirmed by re-listing (a timed-out delete may still
    // have landed) and retried with backoff, and if the ASSIGNED name is
    // still standing at the end, the run refuses to start: it terminates as a
    // zero-response `harness-error`, which the stillborn path below archives
    // and the scheduler's defer ladder retries in a minute — after the save
    // has landed. Any other survivor only eats a slot, and is logged.
    try {
      // Derived from the session secret, as `deleteCharacter` does: these are
      // throwaway tokens for one call each, but they still have to clear the
      // module's `weak_token` floor.
      const listNames = async (i: number): Promise<string[]> => {
        const res = await fetch(`${config.moduleUrl}/characters`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: `${config.token}-hygiene-${i}`, account: config.account }),
        });
        const j = (await res.json()) as { ok?: boolean; enum?: { characters?: { name?: string }[] } };
        return (j.enum?.characters ?? []).map((c) => c.name).filter((n): n is string => !!n);
      };
      let names = await listNames(0);
      const initial = names.length;
      for (let attempt = 0; names.length > 0; attempt++) {
        for (const name of names) {
          const del = await fetch(`${config.moduleUrl}/character-delete`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              token: `${config.token}-hygiene-del-${attempt}-${name}`,
              account: config.account,
              character: name,
            }),
          });
          const dj = (await del.json()) as { deleted?: boolean; error?: string };
          if (dj.deleted !== true) {
            console.error(`[wrathbench] hygiene: could not delete leftover character ${name} (${dj.error ?? del.status})`);
          }
        }
        names = await listNames(attempt + 1);
        if (names.length === 0 || attempt >= 3) break;
        const waitMs = 5000 * (attempt + 1);
        console.error(
          `[wrathbench] hygiene: ${names.length} character(s) survived delete — retrying in ${waitMs / 1000}s (a logout save may still be landing)`,
        );
        await Bun.sleep(waitMs);
      }
      const cleared = initial - names.length;
      if (cleared > 0) {
        console.error(`[wrathbench] hygiene: cleared ${cleared} leftover character(s)`);
        trajectory.append({ t: "harness", kind: "hygiene", cleared });
      }
      const survivor = names.find((n) => n.toLowerCase() === config.character.toLowerCase());
      if (survivor !== undefined) {
        const detail = `hygiene: assigned character ${survivor} survived deletion — a scored run must not start on a used character`;
        console.error(`[wrathbench] ${detail}`);
        trajectory.setTermination(config.runId, "harness-error", detail);
        trajectory.close();
        try {
          const moved = archiveIfNoResponses(config.runsDir, config.runId);
          if (moved !== null) console.error(`[wrathbench] no model response — archived to ${moved}`);
        } catch (err) {
          console.error(`[wrathbench] could not archive ${config.runId}: ${err instanceof Error ? err.message : String(err)}`);
        }
        wiki?.close();
        process.exit(1);
      }
      if (names.length > 0) {
        console.error(
          `[wrathbench] hygiene: ${names.length} leftover character(s) not cleared (${names.join(", ")}) — proceeding, the assigned name is free`,
        );
      }
    } catch (err) {
      console.error(`[wrathbench] hygiene: skipped (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  /*
   * The resumed run's session note. It carries the same character facts the
   * fresh-launch note does, and for the same reason: a resumed model has no
   * conversation history, so anything the note leaves out it has to guess.
   * `nav-probe-freeplay-sonnet-20260823-c3` guessed — the old note said
   * `createSession({...})` with no name — and rolled a second, wrong character
   * next to the one the pause had preserved, which is exactly the loss ADR-0036
   * exists to prevent.
   */
  const resumeNote = (): string => {
    const spentM = Math.round(elapsedBeforeMs / 60_000);
    const budgetMs = config.watchdogs.episodeMs;
    const clock =
      budgetMs !== null && budgetMs !== undefined
        ? `${spentM} minutes elapsed of ${Math.round(budgetMs / 60_000)}`
        : `${spentM} minutes elapsed`;
    const last = trajectory.lastState(config.runId);
    const seen =
      last === null || (last.level === undefined && last.xp === undefined)
        ? ""
        : ` It was last observed at level ${last.level ?? "?"}` +
          (last.xp !== undefined ? ` with ${last.xp} xp` : "") +
          `, and that progress is still there.`;
    const race = raceName(config.race);
    const klass = className(config.class);
    return (
      `the runner process was restarted and this run resumed after a pause, ${clock}. ` +
      `Conversation history was not preserved; your scratchpad was. ` +
      `Your character for this episode is unchanged and was NOT deleted: name "${config.character}", ` +
      `race ${config.race}${race !== null ? ` (${race})` : ""}, class ${config.class}` +
      `${klass !== null ? ` (${klass})` : ""}.${seen} Do not create a different one. ` +
      `Run \`await connect()\`, then ` +
      `\`await sdk.createSession({ character: "${config.character}", race: ${config.race}, class: ${config.class} })\` ` +
      `— it reuses the existing character of that name; a \`token_in_use\` error means the session is ` +
      `still alive and you can simply keep acting through \`sdk\`.`
    );
  };

  const initialNotices = resumed
      ? [
          {
            ts: Date.now(),
            kind: "session_note",
            text: resumeNote(),
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
    config.driver === "claude-code"
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
          signal: abort.signal,
        });

  if (outcome.kind === "paused") {
    /*
     * The pause mark: what a supervisor reads to find resumable runs, and
     * what the next --resume continues the episode clock from. Written before
     * the session is touched so a crash in the release still leaves a
     * resumable run.
     */
    trajectory.writeMeta({ ...(readMeta(runDir) ?? metaNow()), pause: pauseMark(outcome) });
  }
  if (outcome.kind === "terminated" || outcome.reason === "operator-pause") {
    // A finished run frees its module session so the account is not held
    // (the realm caps characters/sessions per account). So does a run the
    // supervisor paused: the fleet is going down, and the account must be
    // free for the resume (same character — logout, never a wipe). A run
    // paused by its provider keeps the session alive on purpose: that is
    // the in-place retry path, and the roster frees it when it moves on.
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
  /*
   * A launch that did not happen does not become a run. A terminated run with
   * zero `response` records — the provider was dead on the first request, the
   * key was refused, the adapter threw before a turn existed — is moved into
   * `data/runs/archive/` right here, after the termination row is written and
   * the trajectory is closed, so no listing ever counts it. A PAUSE is not a
   * termination: a paused run with no response yet is resumed, not buried.
   */
  if (outcome.kind === "terminated") {
    try {
      const moved = archiveIfNoResponses(config.runsDir, config.runId);
      if (moved !== null) console.error(`[wrathbench] no model response — archived to ${moved}`);
    } catch (err) {
      console.error(`[wrathbench] could not archive ${config.runId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (stopping) {
    wiki?.close();
    process.exit(130);
  }
  wiki?.close();
}

if (import.meta.main) {
  void main();
}
