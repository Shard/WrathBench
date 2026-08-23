/**
 * The viewer's read-only HTTP surface, as a handler you can call directly.
 *
 * Split out of `serve.ts` so the routes can be tested without binding a port,
 * and so the boundary is one file an auditor can read end to end. Two rules
 * hold everywhere below:
 *
 * - **Nothing writes.** Databases open readonly, the runs directory is only
 *   ever listed and read, and there is no route that accepts a body.
 * - **Nothing leaks.** `/api` serves run and fleet metadata. Bearer tokens are
 *   stripped in `tail.ts` at both places a raw record can reach a client, and
 *   `WRATHBENCH_VIEWER_PUBLIC=1` additionally withholds the three routes that
 *   carry verbatim game text or Blizzard bytes (raw entries, scratchpads,
 *   minimap tiles). See ADR-0022.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { EPISODE_IDS, EPISODE_LIST } from "../src/episodes";
import { HARNESSES } from "../src/config";
import type {
  ApiInfoResponse,
  EntrySummary,
  EpisodeIdView,
  EpisodesResponse,
  ResultsResponse,
  ResultRun,
  FleetAccountView,
  FleetJobView,
  FleetPausedView,
  FleetResponse,
  FleetServerView,
  FleetSessionView,
  HarnessView,
  ModelsResponse,
  RunDetailResponse,
  RunListRow,
  RunsResponse,
} from "./api-types";
import { resultRunOf, trackFrom } from "./results";
import { modelsResponse, readFleetRoster, readRunFactsCached, type FactCacheEntry } from "./models";
import { modelStates } from "../src/models";
import { readPositions } from "./positions";
import { runCost } from "./pricing";
import { isValidRunId, listRuns, readRun, readScratchpad, readStates, runDir } from "./runs";
import { isArchiveDir } from "./archive-dir";
import { TILE_CACHE_CONTROL, resolveTilePath } from "./tiles";
import {
  SEGMENT_MARKS,
  TrajectoryTail,
  playtimeMs,
  reportedCostUsd,
  responseCostCoverage,
  scanRunTotals,
  segmentsFrom,
  tokenTotals,
  type RunTotals,
} from "./tail";

/** How often the live tail rescans, and the biggest window a client may ask for. */
export const POLL_MS = 1000;
export const WINDOW_MAX = 500;

export interface ApiOptions {
  runsDir: string;
  tilesDir: string;
  /** Where a built SPA lives. Absent or unbuilt is a normal state. */
  dashboardDir?: string;
  /**
   * Withhold raw entries, scratchpads and tiles. Opt-in-to-public rather than
   * opt-in-to-raw: the operator's own run page depends on raw bodies, so
   * defaulting them off would break the working view.
   */
  publicMode?: boolean;
  /**
   * Where the module answers /health, for the `worldserver` identity on
   * /api/info. Defaults to loopback; the compose network does not publish the
   * port to the host, so a host-side viewer reports `null` unless it is given
   * a reachable URL.
   */
  moduleUrl?: string;
  /**
   * The fleet config whose `roster` block names the models `/api/models` rows
   * (ADR-0031). Absent, missing or unreadable is a normal state the route
   * labels rather than an error; a roster map is the one source of names.
   */
  fleetConfigPath?: string;
}

/** How long one /health answer (or one failure) stands in for the next. */
export const HEALTH_CACHE_MS = 10_000;

/**
 * Read the worldserver's build identity off /health, tolerating a server that
 * is down (null) or a module that predates the field (null). One fetch per
 * cache window however many browsers poll.
 */
function worldserverIdentity(moduleUrl: string): () => Promise<ApiInfoResponse["worldserver"]> {
  let cached: { at: number; value: ApiInfoResponse["worldserver"] } | undefined;
  let inflight: Promise<ApiInfoResponse["worldserver"]> | undefined;
  const read = async (): Promise<ApiInfoResponse["worldserver"]> => {
    try {
      const res = await fetch(`${moduleUrl}/health`, { signal: AbortSignal.timeout(2_000) });
      if (!res.ok) return null;
      const o = (await res.json()) as { build?: unknown; startedAtMs?: unknown };
      if (typeof o.build !== "string" || typeof o.startedAtMs !== "number") return null;
      return { build: o.build, startedAtMs: o.startedAtMs };
    } catch {
      return null;
    }
  };
  return async () => {
    if (cached !== undefined && Date.now() - cached.at < HEALTH_CACHE_MS) return cached.value;
    if (inflight === undefined) {
      inflight = read().then((value) => {
        cached = { at: Date.now(), value };
        inflight = undefined;
        return value;
      });
    }
    return inflight;
  };
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function notFound(msg: string): Response {
  return json({ error: msg }, 404);
}

function withheld(): Response {
  return json({ error: "withheld in public mode" }, 403);
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

/**
 * The message a request for the SPA gets when nobody has built it.
 *
 * A plain 404 would read as a broken route. The viewer is run straight from a
 * git checkout, so "not built yet" is the common case, not a failure.
 */
export const UNBUILT_NOTICE =
  "The dashboard has not been built. Run `bun install && bun run --cwd dashboard build`.";

function unbuilt(): Response {
  return new Response(UNBUILT_NOTICE, {
    status: 503,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

/** Serve one file out of the built SPA, or null when it is not there. */
function staticFile(root: string, rel: string): Response | null {
  // Rebuilt from segments so nothing a request says can escape the root.
  const parts = rel.split("/").filter((p) => p.length > 0 && p !== "." && p !== "..");
  const file = join(root, ...parts);
  if (!existsSync(file) || !statSync(file).isFile()) return null;
  const ext = /\.[a-z0-9]+$/i.exec(file)?.[0].toLowerCase() ?? "";
  // Vite fingerprints its assets, so they are immutable; index.html is not.
  const immutable = parts[0] === "assets";
  return new Response(Bun.file(file), {
    headers: {
      "content-type": CONTENT_TYPES[ext] ?? "application/octet-stream",
      "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-store",
    },
  });
}

/**
 * How stale a run's files may be and still be read as holding its account.
 *
 * This is `run-roster.ts`'s `LIVE_TRAJECTORY_MS`, not `runs.ts`'s
 * `LIVE_WINDOW_MS` (120s): the job's run has to be resolved the same way the
 * account guard and `--status` resolve it, or the dashboard would disagree with
 * the supervisor about which run a job holds near the boundary. The constant
 * is duplicated rather than imported because importing from `infra/` would drag
 * its repo-root and process assumptions into the viewer.
 */
const ACCOUNT_HELD_MS = 3 * 60_000;

/** Age of the most recently touched artefact of a run — either file, whichever. */
function runActivityAge(dir: string, now: number): number | undefined {
  let newest: number | undefined;
  for (const name of ["trajectory.jsonl", "run.sqlite"]) {
    try {
      const m = statSync(join(dir, name)).mtimeMs;
      if (newest === undefined || m > newest) newest = m;
    } catch {
      // not written yet
    }
  }
  return newest === undefined ? undefined : now - newest;
}

/** The account a run was launched against, straight off its own meta.json. */
function accountOfRun(dir: string): string | undefined {
  try {
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as {
      config?: { account?: unknown };
    };
    const a = meta.config?.account;
    // No recorded account means no claim: `accountHeldBy` skips such a run too,
    // rather than guessing that it took the default one.
    return typeof a === "string" && a.length > 0 ? a : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Which run holds each account right now, by the same inference `--status`
 * makes (`accountHeldBy` in `run-roster.ts`): a run whose files are warm, with
 * no termination row and no pause row. A paused run has already given its
 * session back, so it holds nothing — the job reads as idle, not as driving a
 * run it has finished with.
 *
 * The map is keyed on account, not on job: a hand-started run, or a previous
 * cycle that has not gone cold, holds the account just as hard as a fleet one
 * and will show under the job that shares it. That is the honest reading of
 * "what has this account" — `--status` says the same, adding only that the
 * holder is "not fleet-managed" when the job's own process is gone.
 *
 * The prefilter is the point. `/api/fleet` polls every five seconds and a runs
 * directory holds hundreds of finished runs; only the handful whose files were
 * touched inside the window are opened. Where `accountHeldBy` takes the first
 * readdir match, this takes the freshest, which is the honest answer when a
 * crashed run and its successor briefly overlap.
 */
export function heldAccounts(runsDir: string, now = Date.now()): Map<string, { runId: string; model: string | null }> {
  const out = new Map<string, { runId: string; model: string | null; age: number }>();
  let names: string[];
  try {
    names = readdirSync(runsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && isValidRunId(d.name) && !isArchiveDir(d.name))
      .map((d) => d.name);
  } catch {
    return new Map();
  }
  for (const id of names) {
    const dir = join(runsDir, id);
    const age = runActivityAge(dir, now);
    if (age === undefined || age >= ACCOUNT_HELD_MS) continue;
    const account = accountOfRun(dir);
    if (account === undefined) continue;
    const row = readRun(runsDir, id, now);
    if (row.terminationReason !== null || row.pauseReason !== null) continue;
    const key = account.toUpperCase();
    const prev = out.get(key);
    if (prev === undefined || age < prev.age) out.set(key, { runId: id, model: row.model, age });
  }
  return new Map([...out].map(([k, v]) => [k, { runId: v.runId, model: v.model }]));
}

const SERVER_PHASES: ReadonlySet<string> = new Set(["running", "draining", "swapping", "verifying", "resuming", "rolled-back", "failed"]);

/**
 * Read the deploy script's phase file. Absent (or unreadable, or nonsense) is
 * `running` with nothing to say: the only state a page can safely assume.
 */
export function readServerState(runsDir: string, now = Date.now()): FleetServerView {
  const rest: FleetServerView = { phase: "running", since: now, build: "", detail: "", updatedAt: now };
  const path = join(runsDir, "server-state.json");
  if (!existsSync(path)) return rest;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<FleetServerView>;
    if (typeof raw.phase !== "string" || !SERVER_PHASES.has(raw.phase)) return rest;
    return {
      phase: raw.phase,
      since: typeof raw.since === "number" ? raw.since : now,
      build: typeof raw.build === "string" ? raw.build : "",
      ...(typeof raw.prevBuild === "string" && raw.prevBuild !== "" ? { prevBuild: raw.prevBuild } : {}),
      detail: typeof raw.detail === "string" ? raw.detail : "",
      updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : now,
    };
  } catch {
    return rest;
  }
}

/** Read the fleet supervisor's published state. Absent is normal, not an error. */
export function readFleet(runsDir: string, now = Date.now()): FleetResponse {
  const path = join(runsDir, "fleet-state.json");
  const server = readServerState(runsDir, now);
  const absent: FleetResponse = { present: false, server, jobs: [], accounts: [], paused: [], ended: [], now };
  if (!existsSync(path)) return absent;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as {
      fleetPid?: number;
      startedAt?: number;
      heartbeatAt?: number;
      containerized?: boolean;
      stamp?: string;
      configLoadedAt?: number;
      configRejected?: { since: number; error: string; mtime: number };
      preflight?: FleetResponse["preflight"];
      jobs?: Record<string, Omit<FleetJobView, "name" | "accountClass" | "runId" | "model">>;
      accounts?: { pinned?: Record<string, string>; pool?: Record<string, string | null>; paid?: Record<string, string | null>; local?: Record<string, string | null> };
      paused?: FleetPausedView[];
      ended?: FleetResponse["ended"];
      session?: FleetSessionView;
    };
    const held = heldAccounts(runsDir, now);
    const classOf = new Map<string, FleetAccountView["class"]>();
    for (const cls of ["pool", "paid", "local"] as const) {
      for (const a of Object.keys(raw.accounts?.[cls] ?? {})) classOf.set(a.toUpperCase(), cls);
    }
    /*
     * Jobs as the supervisor wrote them — the job (ref, tier, account, source)
     * and its process — plus what only the runs directory knows: the run
     * holding the job's account. `rosterPath`/`jsonl`/`log` stay behind: they
     * are paths on the supervisor's side of the mount.
     */
    const jobs: FleetJobView[] = Object.entries(raw.jobs ?? {})
      .map(([name, j]) => {
        const run = held.get(j.account.toUpperCase());
        return {
          name,
          ref: j.ref,
          // Unknown stays unknown: the supervisor writes null rather than a guess.
          episode: j.episode ?? null,
          account: j.account,
          accountClass: classOf.get(j.account.toUpperCase()) ?? "pinned",
          source: j.source,
          ...(j.attempt !== undefined ? { attempt: j.attempt } : {}),
          ...(j.resuming !== undefined ? { resuming: j.resuming } : {}),
          models: Array.isArray(j.models) ? j.models : [],
          runId: run?.runId ?? null,
          model: run?.model ?? null,
          pid: j.pid,
          spawnedAt: j.spawnedAt,
          exitCode: j.exitCode ?? null,
          draining: j.draining === true,
          alive: j.alive === true,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    /*
     * Accounts, in class order, with what holds each: the idle rows of the
     * fleet table. A pinned account that a class also lists (the coexistence
     * rule, ADR-0034) belongs to the class that schedules it, so `pinned` is
     * filtered against the classes rather than concatenated with them.
     */
    const accounts: FleetAccountView[] = [
      ...Object.entries(raw.accounts?.pinned ?? {})
        .filter(([a]) => !classOf.has(a.toUpperCase()))
        .map(([account, job]) => ({ account, class: "pinned" as const, job })),
      ...(["pool", "paid", "local"] as const).flatMap((cls) =>
        Object.entries(raw.accounts?.[cls] ?? {}).map(([account, job]) => ({ account, class: cls, job })),
      ),
    ];
    // `fleetConfig` is deliberately not forwarded: it is a host path, and the
    // API says what the fleet is doing, not where this machine keeps things.
    // The rejection's file mtime stays behind for the same reason.
    return {
      present: true,
      server,
      fleetPid: raw.fleetPid,
      startedAt: raw.startedAt,
      heartbeatAt: raw.heartbeatAt,
      containerized: raw.containerized,
      stamp: raw.stamp,
      ...(raw.configLoadedAt !== undefined ? { configLoadedAt: raw.configLoadedAt } : {}),
      ...(raw.configRejected !== undefined ? { configRejected: { since: raw.configRejected.since, error: raw.configRejected.error } } : {}),
      ...(raw.preflight !== undefined ? { preflight: raw.preflight } : {}),
      jobs,
      accounts,
      paused: Array.isArray(raw.paused) ? raw.paused : [],
      ended: Array.isArray(raw.ended) ? raw.ended : [],
      ...(raw.session !== undefined ? { session: raw.session } : {}),
      now,
    };
  } catch {
    return absent;
  }
}

/**
 * Build the request handler.
 *
 * Per-run tails, scan serialisation and the totals memo live in the closure:
 * one viewer process, one reader per run, however many browsers are watching.
 */
export function createApi(opts: ApiOptions): (req: Request) => Promise<Response> {
  const { runsDir, tilesDir } = opts;
  const publicMode = opts.publicMode === true;
  const dashboardDir = opts.dashboardDir;
  const worldserver = worldserverIdentity(opts.moduleUrl ?? "http://127.0.0.1:8086");

  /** One tail per run, shared by every reader; scans are serialised per run. */
  const tails = new Map<string, TrajectoryTail>();
  const scans = new Map<string, Promise<EntrySummary[]>>();

  function tailFor(runId: string, dir: string): TrajectoryTail {
    let t = tails.get(runId);
    if (t === undefined) {
      t = new TrajectoryTail(join(dir, "trajectory.jsonl"));
      tails.set(runId, t);
    }
    return t;
  }

  /** Serialise scans: two concurrent readers must not both consume the same bytes. */
  function scan(runId: string, tail: TrajectoryTail): Promise<EntrySummary[]> {
    const prev = scans.get(runId) ?? Promise.resolve([] as EntrySummary[]);
    const next = prev.then(
      () => tail.scan(),
      () => tail.scan(),
    );
    scans.set(runId, next);
    return next;
  }

  /**
   * Per-run totals for the listing, memoised on (size, mtime).
   *
   * The listing wants tokens and a wall clock for every run, which means reading
   * every trajectory. A finished run's file never changes, so it is read once per
   * process; a live run is re-read only as it grows.
   */
  const totalsCache = new Map<string, { size: number; mtime: number; totals: RunTotals }>();

  /**
   * Run facts for `/api/models`, memoised per run the same way.
   *
   * The projection reads every trajectory in full to count model responses, so
   * without this a thirty-second poll would re-read the whole runs directory
   * forever. A finished run's fact is read once per process.
   */
  const factCache = new Map<string, FactCacheEntry>();

  async function runTotals(runId: string, dir: string): Promise<RunTotals | null> {
    const path = join(dir, "trajectory.jsonl");
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(path);
    } catch {
      return null;
    }
    const hit = totalsCache.get(runId);
    if (hit !== undefined && hit.size === st.size && hit.mtime === st.mtimeMs) return hit.totals;
    const totals = await scanRunTotals(path);
    totalsCache.set(runId, { size: st.size, mtime: st.mtimeMs, totals });
    return totals;
  }

  /**
   * Every run projected onto the results surface.
   *
   * Built inside this closure on purpose: it reuses the same memoised
   * `runTotals`, so the charts inherit the (size, mtime) cache instead of
   * re-reading every trajectory on every request. The segments it passes are
   * the run page's own, which is what makes time-to-level and playtime agree.
   */
  async function resultRuns(): Promise<ResultRun[]> {
    const out: ResultRun[] = [];
    // One clock for the pass: a live run's playtime is charged up to *now*, and
    // two rows of one response must not be measured against different nows.
    const now = Date.now();
    for (const row of listRuns(runsDir)) {
      const dir = runDir(runsDir, row.runId);
      const totals = dir === null ? null : await runTotals(row.runId, dir);
      out.push(
        resultRunOf(
          row,
          readStates(runsDir, row.runId),
          totals?.segments ?? [],
          totals === null
            ? null
            : {
                toolCalls: totals.toolCalls,
                snippets: totals.snippets,
                modelResponses: totals.modelResponses,
              },
          totals === null
            ? null
            : {
                playtimeMs: playtimeMs(totals.segments, {
                  lastTs: totals.lastTs,
                  live: row.live,
                  now,
                }),
                tokens: totals.tokens,
                /*
                 * The actual figure only: what the provider says it charged.
                 * The episodes listing is a record of what runs cost, and an
                 * estimate standing in for a bill is the one thing it must not
                 * show. `runCost` is the listing's own, over the same memoised
                 * totals, so the two pages cannot quote different dollars.
                 */
                actualCost: runCost({
                  run: row,
                  tokens: totals.tokens,
                  reportedUsd: totals.reportedCostUsd,
                  coverage: totals.responseCost,
                }).actual,
              },
        ),
      );
    }
    return out;
  }

  /**
   * The `?episode=` filter, shared by `/api/results` and `/api/ladder`.
   *
   * Defaults to `e90` — the scored tier — because a chart that quietly mixes a
   * ninety-minute run with a six-hour one is the thing the tiers exist to stop.
   * `all` is a first-class value, not an escape hatch: the episodes page counts
   * every tier from one call, and a filtered page has to be able to say how
   * many rows the filter dropped. An unknown value is a 400 rather than a
   * silent fallback to the default, which would show the wrong data under the
   * right heading.
   */
  function episodeFilter(url: URL): EpisodeIdView | "all" | null {
    const raw = url.searchParams.get("episode");
    if (raw === null) return "e90";
    if (raw === "all") return "all";
    return (EPISODE_IDS as readonly string[]).includes(raw) ? (raw as EpisodeIdView) : null;
  }

  /**
   * The optional `?harness=` filter (ADR-0035), shared by `/api/results`,
   * `/api/ladder` and `/api/models`. Defaults to `all`: the harness is a tag
   * on the row, not a partition, so a chart shows both loops unless asked
   * not to. Unknown values are a 400 for the same reason the episode filter's are.
   */
  function harnessFilter(url: URL): HarnessView | "all" | null {
    const raw = url.searchParams.get("harness");
    if (raw === null || raw === "all") return "all";
    return (HARNESSES as readonly string[]).includes(raw) ? (raw as HarnessView) : null;
  }

  async function resultsResponse(url: URL): Promise<Response> {
    const episode = episodeFilter(url);
    if (episode === null) {
      return json({ error: `unknown episode; one of: ${[...EPISODE_IDS, "all"].join(", ")}` }, 400);
    }
    const harness = harnessFilter(url);
    if (harness === null) {
      return json({ error: `unknown harness; one of: ${[...HARNESSES, "all"].join(", ")}` }, 400);
    }
    const includeOverrides = url.searchParams.get("includeOverrides") === "1";
    const everything = await resultRuns();
    const all = harness === "all" ? everything : everything.filter((r) => r.harness === harness);
    /*
     * Filtering to a tier means filtering to its *members* (ADR-0030): stamped
     * with the id and not overridden. A derived label is countable but is not
     * membership, and an overridden run is only shown when asked for by name.
     */
    const tiered =
      episode === "all"
        ? all
        : all.filter(
            (r) =>
              r.episode === episode &&
              r.episodeSource === "stamped" &&
              (includeOverrides || !r.episodeOverride),
          );
    const runs = tiered;
    const body: ResultsResponse = {
      runs,
      episode,
      harness,
      includeOverrides,
      filteredOut: everything.length - runs.length,
      overridesExcluded:
        episode === "all" || includeOverrides
          ? 0
          : all.filter(
              (r) => r.episode === episode && r.episodeSource === "stamped" && r.episodeOverride,
            ).length,
      now: Date.now(),
    };
    return json(body);
  }

  async function episodesResponse(): Promise<Response> {
    /*
     * Every run here is a run that happened: a launch that produced no model
     * response is archived by the runner as it terminates, so the counts below
     * cannot be padded by launches that never got off the ground.
     */
    const all = await resultRuns();
    const body: EpisodesResponse = {
      episodes: EPISODE_LIST.map((tier) => {
        const tagged = all.filter((r) => r.episode === tier.id);
        const stamped = tagged.filter((r) => r.episodeSource === "stamped");
        return {
          ...tier,
          members: stamped.filter((r) => !r.episodeOverride).length,
          overrides: stamped.filter((r) => r.episodeOverride).length,
          derived: tagged.length - stamped.length,
        };
      }),
      untiered: all.filter((r) => r.episode === null).length,
      now: Date.now(),
    };
    return json(body);
  }

  async function listWithTotals(): Promise<RunListRow[]> {
    const out: RunListRow[] = [];
    for (const row of listRuns(runsDir)) {
      const dir = runDir(runsDir, row.runId);
      const totals = dir === null ? null : await runTotals(row.runId, dir);
      out.push({
        ...row,
        modelResponses: totals?.modelResponses ?? null,
        tokens: totals?.tokens ?? null,
        cost:
          totals === null
            ? null
            : runCost({
                run: row,
                tokens: totals.tokens,
                reportedUsd: totals.reportedCostUsd,
                coverage: totals.responseCost,
              }),
        firstTs: totals?.firstTs ?? null,
        lastTs: totals?.lastTs ?? null,
        playtimeMs:
          totals === null
            ? null
            : playtimeMs(totals.segments, {
                lastTs: totals.lastTs,
                live: row.live,
                now: Date.now(),
              }),
      });
    }
    return out;
  }

  function dashboardIndex(): Response {
    if (dashboardDir === undefined) return unbuilt();
    return staticFile(dashboardDir, "index.html") ?? unbuilt();
  }

  async function api(url: URL, path: string): Promise<Response | null> {
    if (path === "/api" || path === "/api/info") {
      const body: ApiInfoResponse = {
        service: "wrathbench-viewer",
        publicMode,
        dashboard: dashboardDir !== undefined && existsSync(join(dashboardDir, "index.html")),
        worldserver: await worldserver(),
        now: Date.now(),
      };
      return json(body);
    }
    if (path === "/api/runs") {
      const body: RunsResponse = { runs: await listWithTotals() };
      return json(body);
    }
    if (path === "/api/positions") return json({ positions: readPositions(runsDir) });
    if (path === "/api/episodes") return await episodesResponse();
    /*
     * `/api/ladder` serves the same projection as `/api/results`. The ladder's own
     * derivation stays client-side (`dashboard/src/lib/results.ts`, where its rung
     * rules and their tests already live); the route exists so the episode
     * filter has one spelling per page rather than the ladder page having to
     * know it is really asking the results endpoint.
     */
    if (path === "/api/results" || path === "/api/ladder") return await resultsResponse(url);
    if (path === "/api/fleet") return json(readFleet(runsDir));
    /*
     * `/api/models` is the scheduler's own verdict, served rather than
     * recomputed: `modelStates` in `runner/src/models.ts` is what the fleet
     * supervisor schedules on and what `--status` prints, so the page and the
     * supervisor cannot disagree about why a model is not running. The route
     * adds only the run ids behind each count and the last error text.
     */
    if (path === "/api/models") {
      const harness = harnessFilter(url);
      if (harness === null) {
        return json({ error: `unknown harness; one of: ${[...HARNESSES, "all"].join(", ")}` }, 400);
      }
      const now = Date.now();
      const roster = readFleetRoster(opts.fleetConfigPath);
      const runs = readRunFactsCached(runsDir, factCache, now);
      const states = modelStates({ runsDir, roster: roster.models, policy: roster.policy, runs, now });
      // The refs with a job in flight, off the supervisor's state: the verdict
      // says "running (one stream per model)" exactly where --status does.
      const running = new Set(readFleet(runsDir, now).jobs.flatMap((j) => j.ref.split("+")));
      const body: ModelsResponse = modelsResponse({ states, runs, runsDir, roster, now, harness, running });
      /*
       * Cost is attached here rather than in the projection: `runner/src/models.ts`
       * is what the supervisor schedules on and knows nothing about prices, and
       * the figure must be the listing's own — same memoised totals, same
       * `runCost` — or the two pages would quote different dollars for one run.
       */
      const rows = new Map(listRuns(runsDir).map((r) => [r.runId, r]));
      for (const row of body.models) {
        for (const r of row.runs) {
          const dir = runDir(runsDir, r.runId);
          const totals = dir === null ? null : await runTotals(r.runId, dir);
          // The run's own record, not the roster entry: whether a model is local
          // is a fact about the `apiBase` it was actually served from.
          const runRow = rows.get(r.runId);
          r.cost =
            totals === null || runRow === undefined
              ? null
              : runCost({
                  run: runRow,
                  tokens: totals.tokens,
                  reportedUsd: totals.reportedCostUsd,
                  coverage: totals.responseCost,
                });
          /*
           * The starting character rides along from the same row, so the panel
           * can label an extras-cycle run (ADR-0034) without the scheduler's
           * projection having to learn about races.
           */
          r.race = runRow?.race ?? null;
          r.raceName = runRow?.raceName ?? null;
          r.class = runRow?.class ?? null;
          r.className = runRow?.className ?? null;
          r.characterLabel = runRow?.characterLabel ?? null;
        }
      }
      return json(body);
    }

    const m = /^\/api\/run\/([^/]+)(\/.*)?$/.exec(path);
    if (m === null) return null;
    const runId = m[1]!;
    const rest = m[2] ?? "";
    const dir = runDir(runsDir, runId);
    if (dir === null) return notFound(`no such run: ${runId}`);
    const tail = tailFor(runId, dir);

    if (rest === "" || rest === "/") {
      await scan(runId, tail);
      const run = readRun(runsDir, runId);
      /*
       * Playtime comes off the tail's own index rather than `runTotals`: the
       * tail is incremental, where a live run misses the (size, mtime) totals
       * cache on every poll and would re-read the whole file. Both paths run
       * the same `segmentsFrom`/`playtimeMs`, so the two pages agree by
       * construction.
       */
      const entries = tail.entries;
      let lastTs: number | null = null;
      const marks: { t: string; ts: number }[] = [];
      for (const e of entries) {
        if (e.ts > 0) lastTs = e.ts;
        // `ts > 0` keeps an unparseable first line (which `scanRunTotals` drops
        // outright) from spending the no-meta bootstrap on a zero timestamp.
        if (e.ts > 0 && (SEGMENT_MARKS.has(e.t) || marks.length === 0)) {
          marks.push({ t: e.t, ts: e.ts });
        }
      }
      /*
       * Cost rides the same incremental path as tokens: both are computed off
       * the tail's entries, so a live run's figure grows with its trajectory
       * instead of waiting for the (size, mtime) totals cache to miss.
       */
      const tokens = tokenTotals(entries);
      const body: RunDetailResponse = {
        run,
        states: readStates(runsDir, runId),
        total: entries.length,
        tokens,
        cost: runCost({
          run,
          tokens,
          reportedUsd: reportedCostUsd(entries),
          coverage: responseCostCoverage(entries),
        }),
        playtimeMs: playtimeMs(segmentsFrom(marks), { lastTs, live: run.live, now: Date.now() }),
      };
      return json(body);
    }

    if (rest === "/track") {
      // The replay feed (FOLLOW-UPS 22): the same position shape the live map
      // consumes, read from one finished run instead of every live one.
      const run = readRun(runsDir, runId);
      return json({
        runId,
        character: run.character,
        model: run.model,
        harnessVersion: run.harnessVersion,
        points: trackFrom(readStates(runsDir, runId)),
      });
    }

    if (rest === "/entries") {
      await scan(runId, tail);
      const total = tail.entries.length;
      const limit = Math.min(WINDOW_MAX, Math.max(1, Number(url.searchParams.get("limit") ?? 200)));
      const fromParam = url.searchParams.get("from");
      const from = fromParam === null ? Math.max(0, total - limit) : Math.max(0, Number(fromParam));
      return json({ from, total, entries: tail.entries.slice(from, from + limit) });
    }

    const rawMatch = /^\/raw\/(\d+)$/.exec(rest);
    if (rawMatch !== null) {
      if (publicMode) return withheld();
      await scan(runId, tail);
      const raw = await tail.raw(Number(rawMatch[1]));
      if (raw === null) return notFound("no such entry");
      return new Response(raw, {
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
      });
    }

    if (rest === "/scratchpad") {
      if (publicMode) return withheld();
      const text = readScratchpad(runsDir, runId);
      if (text === null) return notFound("no scratchpad");
      return new Response(text, { headers: { "content-type": "text/plain; charset=utf-8" } });
    }

    if (rest === "/stream") {
      await scan(runId, tail);
      let timer: ReturnType<typeof setInterval> | undefined;
      const stream = new ReadableStream({
        start(controller) {
          const enc = new TextEncoder();
          const send = (data: unknown): void => {
            controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`));
          };
          send({ hello: runId, total: tail.entries.length });
          timer = setInterval(() => {
            void scan(runId, tail)
              .then((added) => {
                // A heartbeat keeps proxies and fetch timeouts from calling it dead.
                send(
                  added.length > 0
                    ? { entries: added, tokens: tokenTotals(tail.entries) }
                    : { tick: Date.now() },
                );
              })
              .catch(() => undefined);
          }, POLL_MS);
        },
        cancel() {
          if (timer !== undefined) clearInterval(timer);
        },
      });
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
          connection: "keep-alive",
        },
      });
    }

    return notFound("no such path");
  }

  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = decodeURIComponent(url.pathname);

    if (path.startsWith("/api")) return (await api(url, path)) ?? notFound("no such path");

    if (path.startsWith("/tiles/")) {
      // The only Blizzard-derived bytes the viewer serves, and the reason a
      // public deployment must not enable them until DATA-AND-LEGAL settles it.
      if (publicMode) return withheld();
      const file = resolveTilePath(tilesDir, path);
      // A tile that was never extracted is a 404 the client expects and draws
      // around; it is not an error worth a body.
      if (file === null) return new Response("no such tile", { status: 404 });
      return new Response(Bun.file(file), {
        headers: { "content-type": "image/png", "cache-control": TILE_CACHE_CONTROL },
      });
    }

    if (dashboardDir !== undefined) {
      const hit = staticFile(dashboardDir, path.slice(1));
      if (hit !== null) return hit;
      // Client-side routing: anything not a file is the SPA's own concern.
      return dashboardIndex();
    }

    // No build on disk. There is no fallback UI to serve (ADR-0022): the SPA
    // is the only UI, so every non-API path gets the notice telling the
    // operator how to build it.
    return unbuilt();
  };
}
