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
 *   `WRATHBENCH_VIEWER_PUBLIC=1` emits every JSON body through the public
 *   projection (`public-projection.ts`, plus the game-prose redactor
 *   `redact-prose.ts` on `/entries`) and withholds the routes with no
 *   projected form: raw entries, minimap tiles and the SSE tail. See
 *   `pub` below, and docs/ARCHITECTURE.md (viewer/dashboard section).
 *
 * Public mode is what the snapshot renderer runs its in-process handle as. It
 * is not a way to expose this service: the live viewer is private and
 * operator-only, and public delivery is static snapshots only
 * (docs/PUBLIC-DASHBOARD.md, "The live viewer is not a public service").
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { harnessSeries } from "../src/comparability";
import { moduleAuthHeaders } from "../src/module-auth";
import { EPISODES, EPISODE_IDS, EPISODE_LIST } from "../src/episodes";
import { HARNESSES } from "../src/config";
import { badEvidenceReason } from "../src/lapse";
import type {
  ApiInfoResponse,
  CampaignRowView,
  CampaignsResponse,
  CostFigure,
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
  RunRow,
  RunsResponse,
  TokenTotals,
  TrackResponse,
} from "./api-types";
import { resultRunOf, trackFrom } from "./results";
import { type Campaign, campaignComplete, campaignModels } from "../src/campaigns";
import { modelsResponse, readFleetRoster, readRunFactsCached, type FactCacheEntry } from "./models";
import { modelStates, outstandingWork } from "../src/models";
import { readPositions } from "./positions";
import { toolsResponse } from "./tools";
import { runCost } from "./pricing";
import {
  projectCampaigns,
  projectEntries,
  projectEpisodes,
  projectFleet,
  projectInfo,
  projectModels,
  projectPositions,
  projectResults,
  projectRunDetail,
  projectRuns,
  projectTools,
  projectTrack,
} from "./public-projection";
import {
  isValidRunId,
  LIVE_WINDOW_MS,
  listRunsCached,
  readMoves,
  readRun,
  readScratchpad,
  readStates,
  readStatesCached,
  type RunReadCacheEntry,
  runDir,
} from "./runs";
import { isArchiveDir } from "./archive-dir";
import {
  TILE_CACHE_CONTROL,
  TILE_PUBLIC_CACHE_CONTROL,
  TILE_PUBLIC_ROBOTS,
  resolveTilePath,
} from "./tiles";
import {
  SEGMENT_MARKS,
  TrajectoryTail,
  playtimeMs,
  reportedCostUsd,
  responseCostCoverage,
  RunTotalsScanner,
  segmentsFrom,
  tokenTotals,
  tokensPerSecond,
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
   * Withhold raw entries and tiles, and project + redact `/entries`.
   * Opt-in-to-public rather than opt-in-to-raw: the operator's own run page
   * depends on raw bodies, so defaulting them off would break the working view.
   */
  publicMode?: boolean;
  /**
   * Serve `/tiles/` in public mode anyway. Off by default and meaningless on
   * its own: it only ever loosens `publicMode`, never the operator's own
   * loopback viewer, which serves tiles regardless. The operator opts in with
   * `WRATHBENCH_VIEWER_TILES_PUBLIC=1` for a deployment they have decided may
   * carry them; nothing else in the stack turns it on, and the static public
   * snapshot never contains a tile either way (see `snapshot.ts`).
   */
  tilesPublic?: boolean;
  /**
   * Where the module answers /health, for the `worldserver` identity on
   * /api/info. Defaults to loopback; the compose network does not publish the
   * port to the host, so a host-side viewer reports `null` unless it is given
   * a reachable URL.
   */
  moduleUrl?: string;
  /**
   * The fleet config whose `roster` block names the models `/api/models` rows.
   * Absent, missing or unreadable is a normal state the route
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
      const res = await fetch(`${moduleUrl}/health`, { headers: moduleAuthHeaders(), signal: AbortSignal.timeout(2_000) });
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

/** The one shared scoreability verdict, applied to a projected result row. */
function taintOf(r: Pick<ResultRun, "live" | "pauseReason" | "modelResponses" | "terminationReason">): string | null {
  return badEvidenceReason({
    live: r.live === true,
    paused: r.pauseReason !== null,
    modelResponses: r.modelResponses,
    terminationReason: r.terminationReason,
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
 * The dashboard build on disk, as Vite's fingerprinted entry filename.
 *
 * Vite hashes chunk names and empties `dist/` on every build, so that name
 * changes exactly when the bundle does — which makes it a build id nobody has
 * to remember to stamp. Parsed out of `index.html` rather than by listing
 * `assets/` (which holds lazy chunks too, in no defined order).
 *
 * Cached on the file's mtime: `/api/info` is polled by every open tab, and a
 * build id that reads the page off disk each time would be the cheapest route
 * to a thundering herd on a rebuild.
 */
function dashboardBuildOf(dir: string | undefined, cache: { mtime: number; id: string | null }): string | null {
  if (dir === undefined) return null;
  const file = join(dir, "index.html");
  if (!existsSync(file)) return null;
  const mtime = statSync(file).mtimeMs;
  if (mtime === cache.mtime) return cache.id;
  const html = readFileSync(file, "utf8");
  // The entry script; `null` if the page has none, which is a build we cannot
  // identify rather than an error — the field is nullable for exactly that.
  const id = /src="\/assets\/([^"]+\.js)"/.exec(html)?.[1] ?? null;
  cache.mtime = mtime;
  cache.id = id;
  return id;
}

/**
 * How long one series census stands in for the next.
 *
 * Minutes, not seconds: a new series appears on a deploy, never on a tick, and
 * the census opens the run metadata for every run on disk. `/api/info` is the
 * route every open tab polls — the one whose build id is already memoised for
 * exactly that reason.
 */
export const SERIES_CACHE_MS = 300_000;

/**
 * The harness series present in the run directory, newest first, with counts.
 *
 * The shell's global series selector needs this before any page has
 * fetched rows of its own, so it rides on `/api/info`. Cached on a window
 * because that route is polled by every open tab and the answer changes only
 * when a run starts; the census reads run metadata, never a trajectory.
 */
export function harnessSeriesCensus(rows: readonly { harnessVersion: string | null }[]): { series: string; runs: number }[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const s = harnessSeries(r.harnessVersion);
    if (s === null) continue;
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  return [...counts]
    .map(([series, runs]) => ({ series, runs }))
    .sort((a, b) => {
      const [am, an] = a.series.split(".").map((n) => Number.parseInt(n, 10));
      const [bm, bn] = b.series.split(".").map((n) => Number.parseInt(n, 10));
      return (bm! - am!) || (bn! - an!);
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
     * rule) belongs to the class that schedules it, so `pinned` is
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
  const tilesPublic = opts.tilesPublic === true;
  /**
   * Serve a body, through the public projection when this handle is public.
   *
   * Public mode is not a set of routes an operator has to remember (GitHub
   * issue #30): every JSON body this handle emits in public mode crosses the
   * same allowlist the static snapshot publishes through, so the live viewer
   * in public mode is at most as revealing as the snapshot. The snapshot
   * renderer projects each parsed body again on its own side — the invariant
   * there is "every body crosses the projection HERE", not "the handle was
   * public" — so every projector is idempotent by construction and pinned as
   * such by `runner/test/viewer-public-mode.test.ts`.
   *
   * Routes with no projector are not served in public mode at all: raw lines,
   * tiles and `/stream` answer `withheld()`. The one deliberate exception is
   * `/scratchpad`, the model's own notes, published as written
   * (docs/DATA-AND-LEGAL.md, "Trajectory logs", operator 2026-08-30).
   */
  const pub = <T>(body: T, project: (b: T) => unknown): Response =>
    json(publicMode ? project(body) : body);
  const dashboardDir = opts.dashboardDir;
  /** Per-handle, so a test's temp dir never inherits another's build id. */
  const buildCache: { mtime: number; id: string | null } = { mtime: -1, id: null };
  // The series census for /api/info, on a window: every open tab polls that
  // route, and the answer only moves when a run starts.
  let seriesCache: { at: number; value: { series: string; runs: number }[] } | undefined;
  const seriesCensus = (): { series: string; runs: number }[] => {
    const now = Date.now();
    if (seriesCache === undefined || now - seriesCache.at >= SERIES_CACHE_MS) {
      seriesCache = { at: now, value: harnessSeriesCensus(listRunsCached(runsDir, runReadCache, now)) };
    }
    return seriesCache.value;
  };
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
  const totalsCache = new Map<
    string,
    {
      size: number;
      mtime: number;
      totals: RunTotals;
      /**
       * The resumable scan behind those totals, kept only while the file is
       * still being written. A live run's trajectory runs to hundreds of
       * megabytes and misses the (size, mtime) key on every poll, so without
       * this every listing route re-read it from byte zero — the whole reason
       * the API was slow. A scanner retains one mark per reply, which is the
       * one thing here proportional to the file, so a run whose trajectory has
       * gone quiet drops it and keeps the totals alone.
       */
      scanner?: RunTotalsScanner;
    }
  >();

  /**
   * Run facts for `/api/models`, memoised per run the same way.
   *
   * The projection reads every trajectory in full to count model responses, so
   * without this a thirty-second poll would re-read the whole runs directory
   * forever. A finished run's fact is read once per process.
   */
  const factCache = new Map<string, FactCacheEntry>();

  /**
   * Run rows and their state series for the listing routes, memoised per run
   * the same way (`readRunCached` in `runs.ts` carries the rule, including why
   * a live run is never served from it). Every listing route reads all 330 of
   * them, which is 330 database opens per request without this.
   */
  const runReadCache = new Map<string, RunReadCacheEntry>();

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
    /*
     * Resume where the last scan stopped, unless the file cannot be resumed:
     * a scanner that has already read past the current size means the file was
     * truncated or replaced, and folding new bytes into old accumulators would
     * double-count. Then it is read whole, once.
     */
    let scanner = hit?.scanner;
    if (scanner === undefined || scanner.size > st.size) scanner = new RunTotalsScanner(path);
    const totals = await scanner.scan();
    /*
     * Keep the scanner only while the trajectory is still growing. `LIVE_WINDOW_MS`
     * is the same window the run rows call liveness on, so exactly the runs that
     * miss this cache every poll are the ones that keep their resumable state.
     */
    const growing = Date.now() - st.mtimeMs < LIVE_WINDOW_MS;
    totalsCache.set(
      runId,
      growing
        ? { size: st.size, mtime: st.mtimeMs, totals, scanner }
        : { size: st.size, mtime: st.mtimeMs, totals },
    );
    return totals;
  }

  /**
   * A run row with the resolved model id filled in.
   *
   * Stamped beats derived, in one place: a run launched since 2026-08-25 has
   * the answer on `meta.json` and in its `run` row, and everything older only
   * inside its trajectory, where `scanRunTotals` picked it up on the pass the
   * listing already pays for. Nothing is written back — an old run is read
   * differently, not rewritten (the same rule the episode tier follows).
   */
  function withResolved(row: RunRow, totals: RunTotals | null): RunRow {
    if (row.resolvedModel !== null && row.cliVersion !== null) return row;
    const seen = totals?.resolved ?? null;
    if (seen === null) return row;
    return {
      ...row,
      resolvedModel: row.resolvedModel ?? seen.model,
      cliVersion: row.cliVersion ?? seen.cliVersion,
    };
  }

  /**
   * The listing facts a `ResultRun` carries: playtime, tokens, and the cost.
   *
   * `runCost` is the listing's own, over the same memoised totals, so no page
   * can quote different dollars for one run. Both figures ride on the row but
   * under their own names: `actualCost` is what the provider charged — the
   * only figure the runs table shows, because an estimate standing in for a
   * bill is the one thing a listing must not do — and `expectedCost` is the
   * price table applied to the tokens, which the ladder's scatter reads only
   * where no provider figure exists (a free tier, local hardware, a
   * subscription) and labels as such.
   */
  function listingFacts(
    row: RunRow,
    totals: RunTotals,
    now: number,
  ): { playtimeMs: number | null; tokens: TokenTotals | null; actualCost: CostFigure; expectedCost: CostFigure } {
    const cost = runCost({
      run: row,
      tokens: totals.tokens,
      reportedUsd: totals.reportedCostUsd,
      coverage: totals.responseCost,
    });
    return {
      playtimeMs: playtimeMs(totals.segments, { lastTs: totals.lastTs, live: row.live, now }),
      tokens: totals.tokens,
      actualCost: cost.actual,
      expectedCost: cost.expected,
    };
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
    for (const raw of listRunsCached(runsDir, runReadCache, now)) {
      const dir = runDir(runsDir, raw.runId);
      const totals = dir === null ? null : await runTotals(raw.runId, dir);
      const row = withResolved(raw, totals);
      out.push(
        resultRunOf(
          row,
          readStatesCached(runsDir, row.runId, runReadCache, now),
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
            : listingFacts(row, totals, now),
          totals?.areas ?? null,
          totals?.achievements ?? null,
          totals?.taxi ?? null,
          totals?.leveling ?? null,
          totals?.deaths ?? null,
          totals === null
            ? undefined
            : { spells: totals.spells, talents: totals.talents, trades: totals.trades },
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
   * The optional `?harness=` filter, shared by `/api/results`,
   * `/api/ladder` and `/api/models`. Defaults to `all`: the harness is a tag
   * on the row, not a partition, so a chart shows both loops unless asked
   * not to. Unknown values are a 400 for the same reason the episode filter's are.
   */
  function harnessFilter(url: URL): HarnessView | "all" | null {
    const raw = url.searchParams.get("harness");
    if (raw === null || raw === "all") return "all";
    return (HARNESSES as readonly string[]).includes(raw) ? (raw as HarnessView) : null;
  }

  /**
   * The episodes a ladder is offered for.
   *
   * `probing` is not one (operator, 2026-08-29). A probe campaign is a
   * commissioned sweep whose cells vary on purpose, so a table that ranks its
   * runs against each other ranks the sweep, not the models — and unlike the
   * scored ids there is no group for a row to belong to. Probe runs stay
   * visible everywhere runs are listed; they just have no ladder. It is only
   * the ladder that loses the id: `/api/results?episode=probing` still answers,
   * and `EPISODE_IDS` is untouched.
   */
  const LADDER_EPISODES: readonly string[] = EPISODE_IDS.filter((id) => id !== "probing");

  async function resultsResponse(url: URL, ladder = false): Promise<Response> {
    const episode = episodeFilter(url);
    if (episode === null) {
      return json({ error: `unknown episode; one of: ${[...EPISODE_IDS, "all"].join(", ")}` }, 400);
    }
    if (ladder && episode !== "all" && !LADDER_EPISODES.includes(episode)) {
      return json({ error: `no ladder for that episode; one of: ${LADDER_EPISODES.join(", ")}` }, 400);
    }
    const harness = harnessFilter(url);
    if (harness === null) {
      return json({ error: `unknown harness; one of: ${[...HARNESSES, "all"].join(", ")}` }, 400);
    }
    /*
     * An override is a membership question, and only a scored id has a
     * membership to lose: `freeplay` pins nothing but its own name and its
     * unscored reason, so a freeplay run given its own leash has not fallen
     * out of any group — the same reason `docs/EPISODES.md` gives for never
     * reporting a probe run as overridden. The freeplay ladder is the whole
     * active field (operator, 2026-08-29), so it holds them.
     */
    const unscoredLadder =
      ladder && episode !== "all" && episode !== null && !EPISODES[episode].scored;
    const includeOverrides = url.searchParams.get("includeOverrides") === "1" || unscoredLadder;
    const everything = await resultRuns();
    const all = harness === "all" ? everything : everything.filter((r) => r.harness === harness);
    /*
     * Filtering to a tier means filtering to its *members*: stamped
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
    return pub(body, projectResults);
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
        // An attempt that never became an episode is not a member of the tier's
        // group — the same predicate the ladder filters on, so this
        // count and that chart hold the same runs.
        const tainted = (r: (typeof stamped)[number]): boolean => taintOf(r) !== null;
        const lapsed = (r: (typeof stamped)[number]): boolean => r.terminationReason !== null && tainted(r);
        return {
          ...tier,
          members: stamped.filter((r) => !r.episodeOverride && !tainted(r)).length,
          lapsed: stamped.filter((r) => !r.episodeOverride && lapsed(r)).length,
          overrides: stamped.filter((r) => r.episodeOverride).length,
          derived: tagged.length - stamped.length,
        };
      }),
      untiered: all.filter((r) => r.episode === null).length,
      now: Date.now(),
    };
    return pub(body, projectEpisodes);
  }

  /**
   * The probe lane, grouped by what commissioned each run.
   *
   * Built from the RUN DIRECTORY and only annotated from the config, which is
   * the property that matters: a campaign that has been completed, switched off
   * and deleted from the file still has a row here, because its runs are what
   * happened. A row with runs and no `config` is a finished campaign, not an
   * error — and a cell the config no longer declares is still shown, because
   * pretending a run did not happen is worse than showing one that no longer
   * has a home.
   */
  async function campaignsResponse(): Promise<Response> {
    const all = await resultRuns();
    const probes = all.filter((r) => r.campaign !== null);
    const roster = readFleetRoster(opts.fleetConfigPath);
    const declared = new Map(roster.campaigns.map((c) => [c.name, c]));
    const names = [
      // Config order first, so the file's own priority is what the page shows;
      // then any campaign only the runs remember.
      ...roster.campaigns.map((c) => c.name),
      ...[...new Set(probes.map((r) => r.campaign!))].filter((n) => !declared.has(n)),
    ];
    const catalog = roster.models.map((m) => m.name);
    const rows: CampaignRowView[] = names.map((name) => {
      const mine = probes.filter((r) => r.campaign === name);
      const c = declared.get(name);
      const cellIds = [
        ...(c?.cells.map((x) => x.id) ?? []),
        ...[...new Set(mine.map((r) => r.cell).filter((x): x is string => x !== null))].filter(
          (id) => c === undefined || !c.cells.some((x) => x.id === id),
        ),
      ];
      const newest = mine.reduce<ResultRun | null>((a, b) => ((a?.startedAt ?? 0) >= (b.startedAt ?? 0) ? a : b), null);
      const ended = mine.filter((r) => r.terminationReason !== null);
      // The scheduler's own reading of a finished probe, shared by the
      // `complete` flag and the `runs` count below so the two cannot disagree.
      const probeRuns = ended.map((r) => ({
        campaign: r.campaign,
        cell: r.cell,
        ref: refOf(roster, r),
        counted: !r.extra && !r.episodeOverride && taintOf(r) === null,
      }));
      return {
        campaign: name,
        config:
          c === undefined
            ? null
            : {
                enabled: c.enabled,
                runsPerCell: c.runsPerCell,
                cells: c.cells.map((x) => x.id),
                // No `eligible` predicate, deliberately: the scheduler passes
                // one (`verdict !== "blocked"`) so it does not launch a cell
                // against a dead endpoint, but `blocked` also covers `running`
                // and `paused`, which are properties of this second, not of the
                // sweep. Wired here, a model's count and the complete flag
                // below would flicker with the live board on every poll. This
                // page answers what the config asked for, so it counts every
                // named model — health is the fleet strip's question.
                models: campaignModels(c, catalog).length,
                // Ended runs only, which is deliberately NOT the question the
                // scheduler asks. The scheduler counts a live probe as done so
                // it does not launch the same cell twice; a page must not
                // announce a sweep complete while one of its runs could still
                // end `manual` and re-open the cell.
                //
                // `counted` mirrors `isCounted` over the fields a result row
                // has. It cannot be `unscored`, which is non-null for every
                // probe (`probing` is an unscored episode) — and it must not
                // be a blanket `true`, because that is what made this page
                // report a cell swept while the scheduler was still relaunching
                // it. `attempts` (`maxAttemptsPerCell`) reads every row here
                // either way.
                complete: campaignComplete(c, catalog, probeRuns),
                account: c.account ?? null,
              },
        runs: countedProbeRuns(c, catalog, probeRuns),
        live: mine.filter((r) => r.terminationReason === null).length,
        models: [...new Set(mine.map((r) => r.model).filter((m): m is string => m !== null))].sort(),
        cells: cellIds.map((cell) => {
          const runs = mine.filter((r) => r.cell === cell);
          const levels = runs.map((r) => r.maxLevel).filter((l): l is number => l !== null);
          return {
            cell,
            declared: c !== undefined && c.cells.some((x) => x.id === cell),
            runs: runs.length,
            models: [...new Set(runs.map((r) => r.model).filter((m): m is string => m !== null))].sort(),
            bestLevel: levels.length > 0 ? Math.max(...levels) : null,
          };
        }),
        newestRunId: newest?.runId ?? null,
        newestAt: newest?.startedAt ?? null,
      };
    });
    const body: CampaignsResponse = {
      campaigns: rows,
      orphans: all.filter((r) => r.episode === "probing" && r.campaign === null).length,
      configPath: roster.path,
      now: Date.now(),
    };
    return pub(body, projectCampaigns);
  }

  /**
   * The numerator of the page's `runs/want` progress, where `want` is
   * `cells × runsPerCell × models`: the same `counted` runs `campaignComplete`
   * credits, on a declared cell, by a model the sweep names, and never more per
   * (model, cell) than the cell asks for. Every ended run — failed attempts,
   * re-sweeps, models since dropped from the campaign — read 73/8 on a sweep
   * the scheduler still owed cells on. Without a config there is no `want`, so
   * the count is every counted run.
   */
  function countedProbeRuns(
    c: Campaign | undefined,
    catalog: readonly string[],
    probeRuns: readonly { cell: string | null; ref: string | null; counted: boolean }[],
  ): number {
    const counted = probeRuns.filter((r) => r.counted);
    if (c === undefined) return counted.length;
    const models = new Set(campaignModels(c, catalog));
    const cells = new Set(c.cells.map((x) => x.id));
    const tally = new Map<string, number>();
    for (const r of counted) {
      if (r.ref === null || r.cell === null || !models.has(r.ref) || !cells.has(r.cell)) continue;
      const k = `${r.ref}\u0000${r.cell}`;
      tally.set(k, Math.min(c.runsPerCell, (tally.get(k) ?? 0) + 1));
    }
    let n = 0;
    for (const v of tally.values()) n += v;
    return n;
  }

  /** The roster name a probe run used, for the completion count. */
  function refOf(roster: { models: readonly { name: string; model: string; effort?: string | undefined }[] }, r: ResultRun): string | null {
    const hit = roster.models.find((m) => m.model === r.model && (m.effort ?? null) === (r.effort ?? null));
    return hit?.name ?? null;
  }

  async function listWithTotals(): Promise<RunListRow[]> {
    const out: RunListRow[] = [];
    for (const raw of listRunsCached(runsDir, runReadCache)) {
      const dir = runDir(runsDir, raw.runId);
      const totals = dir === null ? null : await runTotals(raw.runId, dir);
      const row = withResolved(raw, totals);
      out.push({
        ...row,
        modelResponses: totals?.modelResponses ?? null,
        tokens: totals?.tokens ?? null,
        // Off the same memoised whole-file pass as the tokens; the fleet page's
        // speed column and the run page's read one derivation.
        tps: totals?.tps ?? null,
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
        dashboardBuild: dashboardBuildOf(dashboardDir, buildCache),
        worldserver: await worldserver(),
        harnessSeries: seriesCensus(),
        now: Date.now(),
      };
      return pub(body, projectInfo);
    }
    if (path === "/api/runs") {
      const body: RunsResponse = { runs: await listWithTotals() };
      return pub(body, projectRuns);
    }
    if (path === "/api/positions") return pub({ positions: readPositions(runsDir) }, projectPositions);
    if (path === "/api/episodes") return await episodesResponse();
    /* The model-facing tool list, off `TOOLS` at request time (`tools.ts`); harness text only. */
    if (path === "/api/tools") return pub(toolsResponse(), projectTools);
    if (path === "/api/campaigns") return await campaignsResponse();
    /*
     * `/api/ladder` serves the same projection as `/api/results`. The ladder's own
     * derivation stays client-side (`dashboard/src/lib/ladder.ts`, where its rung
     * rules and their tests already live); the route exists so the episode
     * filter has one spelling per page rather than the ladder page having to
     * know it is really asking the results endpoint. It differs in one thing:
     * `probing` has no ladder (see `LADDER_EPISODES`) and answers 400 here,
     * while `/api/results?episode=probing` still lists those runs.
     */
    if (path === "/api/results") return await resultsResponse(url);
    if (path === "/api/ladder") return await resultsResponse(url, true);
    if (path === "/api/fleet") {
      /*
       * The supervisor's published state, plus one thing only the roster and
       * the run history know: how many counted runs the policy still owes
       * (`outstandingWork` in `runner/src/models.ts`, where the bounds and the
       * ETA formula are written out). Computed here rather than published by
       * the supervisor so it is right with the fleet down, and off the same
       * projection `/api/models` serves — the page cannot disagree with the
       * models table about who owes what.
       */
      const now = Date.now();
      const body = readFleet(runsDir, now);
      const roster = readFleetRoster(opts.fleetConfigPath);
      if (roster.shape === "roster") {
        const runs = readRunFactsCached(runsDir, factCache, now);
        const states = modelStates({ runsDir, roster: roster.models, policy: roster.policy, runs, now });
        body.outstanding = outstandingWork({
          states,
          policy: roster.policy,
          excluded: roster.excluded.map((e) => e.name),
          accounts: roster.accounts,
          maxConcurrent: roster.maxConcurrent,
        });
      }
      return pub(body, projectFleet);
    }
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
      const rows = new Map(listRunsCached(runsDir, runReadCache, now).map((r) => [r.runId, r]));
      for (const row of body.models) {
        for (const r of row.runs) {
          const dir = runDir(runsDir, r.runId);
          const totals = dir === null ? null : await runTotals(r.runId, dir);
          // The run's own record, not the roster entry: whether a model is local
          // is a fact about the `apiBase` it was actually served from.
          const rawRow = rows.get(r.runId);
          const runRow = rawRow === undefined ? undefined : withResolved(rawRow, totals);
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
           * can label an extras-cycle run without the scheduler's
           * projection having to learn about races.
           */
          r.race = runRow?.race ?? null;
          r.raceName = runRow?.raceName ?? null;
          r.class = runRow?.class ?? null;
          r.className = runRow?.className ?? null;
          r.characterLabel = runRow?.characterLabel ?? null;
          /*
           * Which model this run was really on. The row keeps its roster
           * grouping — that is the unit the scheduler counts in — and the ids
           * are collected below, so an alias that resolved two ways shows both
           * rather than one of them standing for the other.
           */
          r.resolvedModel = runRow?.resolvedModel ?? null;
        }
        row.resolvedModels = [
          ...new Set(row.runs.map((r) => r.resolvedModel).filter((m): m is string => typeof m === "string")),
        ].sort();
      }
      return pub(body, projectModels);
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
      /*
       * The resolved model is the one fact here that does not grow: it is
       * observed once, in the run's first turn, and never revised. So it comes
       * off the memoised whole-file totals rather than the incremental tail —
       * one derivation, shared with the listing — and a run that stamped it at
       * write time short-circuits the scan entirely.
       */
      const run = withResolved(readRun(runsDir, runId), await runTotals(runId, dir));
      /*
       * Playtime comes off the tail's own index rather than `runTotals`: the
       * tail is incremental, where a live run misses the (size, mtime) totals
       * cache on every poll and would re-read the whole file. Both paths run
       * the same `segmentsFrom`/`playtimeMs`, so the two pages agree by
       * construction.
       */
      const entries = tail.entries;
      // Off the tail rather than the served list: the tail sees every line,
      // and the listing's figure is read off every line too — a run whose last
      // record the feed does not serve must not close its segment early here.
      const lastTs = tail.lastTs;
      const marks: { t: string; ts: number }[] = [];
      for (const e of entries) {
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
        // Same incremental path as tokens and cost: the tail accumulates the
        // milestone marks as it indexes, so a live run's line grows with it.
        achievements: tail.achievements,
        taxi: tail.taxi,
        leveling: tail.leveling,
        deaths: tail.deaths,
        spells: tail.spells,
        talents: tail.talents,
        trades: tail.trades,
        // Same incremental path again: a live run's rate advances with the tail
        // rather than waiting on the (size, mtime) totals cache to miss.
        tps: tokensPerSecond(entries),
        // The turns spent reflecting, from the same pass: the feed accents them
        // by turn, and the window that opens one can sit far above whatever
        // slice of entries the page happens to have loaded.
        reflections: tail.reflections,
      };
      return pub(body, projectRunDetail);
    }

    if (rest === "/track") {
      // The replay feed (item 22): the same position shape the live map
      // consumes, read from one finished run instead of every live one.
      const run = readRun(runsDir, runId);
      const body: TrackResponse = {
        runId,
        character: run.character,
        model: run.model,
        harnessVersion: run.harnessVersion,
        points: trackFrom(readStates(runsDir, runId)),
        // The intentions beside the track: same run, different cadence.
        moves: readMoves(runsDir, runId),
      };
      return pub(body, projectTrack);
    }

    if (rest === "/entries") {
      await scan(runId, tail);
      const total = tail.entries.length;
      const limit = Math.min(WINDOW_MAX, Math.max(1, Number(url.searchParams.get("limit") ?? 200)));
      const fromParam = url.searchParams.get("from");
      const from = fromParam === null ? Math.max(0, total - limit) : Math.max(0, Number(fromParam));
      const page = { from, total, entries: tail.entries.slice(from, from + limit) };
      // Public mode serves the same window the snapshot publishes: each entry
      // through the per-type allowlist and the game-prose redactor.
      return json(publicMode ? projectEntries(page) : page);
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

    // The scratchpad is the model's own notes, published as written since
    // 2026-08-30 (docs/DATA-AND-LEGAL.md, "Trajectory logs"); no public gate.
    if (rest === "/scratchpad") {
      const text = readScratchpad(runsDir, runId);
      if (text === null) return notFound("no scratchpad");
      return new Response(text, { headers: { "content-type": "text/plain; charset=utf-8" } });
    }

    if (rest === "/stream") {
      /*
       * The live tail has no projected form: it pushes entry batches as they
       * are written, and a public reader's window is the static snapshot's
       * one published tail instead (the SPA guards SSE off in snapshot mode).
       * Withheld rather than projected so public mode is not a set of routes
       * an operator has to remember — GitHub issue #30.
       */
      if (publicMode) return withheld();
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
      // The only Blizzard-derived bytes the viewer serves, so public mode
      // withholds them unless the operator has explicitly opted this
      // deployment in.
      const asPublic = publicMode && tilesPublic;
      if (publicMode && !asPublic) return withheld();
      const file = resolveTilePath(tilesDir, path);
      // A tile that was never extracted is a 404 the client expects and draws
      // around; it is not an error worth a body. A miss is never cached: the
      // extraction may write that tile a minute from now.
      if (file === null) {
        return new Response("no such tile", {
          status: 404,
          ...(asPublic ? { headers: { "x-robots-tag": TILE_PUBLIC_ROBOTS } } : {}),
        });
      }
      return new Response(Bun.file(file), {
        headers: {
          "content-type": "image/png",
          "cache-control": asPublic ? TILE_PUBLIC_CACHE_CONTROL : TILE_CACHE_CONTROL,
          ...(asPublic ? { "x-robots-tag": TILE_PUBLIC_ROBOTS } : {}),
        },
      });
    }

    if (dashboardDir !== undefined) {
      const hit = staticFile(dashboardDir, path.slice(1));
      if (hit !== null) return hit;
      // Client-side routing: anything not a file is the SPA's own concern.
      return dashboardIndex();
    }

    // No build on disk. There is no fallback UI to serve: the SPA
    // is the only UI, so every non-API path gets the notice telling the
    // operator how to build it.
    return unbuilt();
  };
}
