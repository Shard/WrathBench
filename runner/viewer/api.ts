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

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { json } from "./http";
import { harnessSeries } from "../src/comparability";
import type { SiteSettings } from "../src/site-settings";
import { siteInfoField } from "./site-info";
import { moduleAuthHeaders } from "@wrathbench/mcp/module-auth";
import { EPISODES, EPISODE_IDS, EPISODE_LIST, hasBoard, isTaskEpisode } from "../src/episodes";
import { HARNESSES, isNotAModelRun } from "../src/config";
import { badEvidenceReason, countedRun } from "../src/lapse";
import type {
  ClipsResponse,
  HighlightResponse,
  ApiInfoResponse,
  CampaignsResponse,
  DungeonsResponse,
  CostFigure,
  E90TokenProfileView,
  EpisodeIdView,
  EpisodesResponse,
  ResultsResponse,
  ResultRun,
  CharacterResponse,
  CharacterStatePoint,
  HarnessView,
  RunDetailResponse,
  RunListRow,
  RunRow,
  RunsResponse,
  StateItemsRow,
  StatePoint,
  TokenTotals,
  TrackResponse,
} from "./api-types";
import { episodeOf, questsAcrossRestarts, resultRunOf, trackFrom } from "./results";
import { scriptedReferenceLines } from "./scripted-reference";
import { ENTRIES_WINDOW } from "./public-keys";
import { campaignsView } from "./campaigns";
import { readFleetRoster, rosterNameOf } from "./models";
import type { RunFact } from "../src/models";
import { positionsFromStore } from "./positions";
import { runCost } from "./pricing";
import { characterViewOf } from "./character";
import { creatureNamesOf, partyDetailOf } from "./party-marks";
import { bossKillsOf, isBossKill } from "./timeline-marks";
import { boardsOf, DEADMINES_BOSSES, DUNGEON_BOARD_VERSION } from "./dungeons";
import { dungeonMarksOf } from "./dungeon-marks";
import {
  projectCampaigns,
  projectDungeons,
  projectCharacterResponse,
  projectEntries,
  projectEpisodes,
  projectInfo,
  projectPositions,
  projectResults,
  projectRunDetail,
  projectClips,
  projectHighlight,
  projectRuns,
  projectTrack,
  projectTraceIndex,
  projectTraceSegment,
  projectNearby,
} from "./public-projection";
import { NEARBY_SPAN_MS } from "@wrathbench/inspector/codec/nearby";
import { scrubPathsText } from "./scrub-paths";
import { strikableSessionToken, strikeSessionTokens } from "../src/session-token";
import { SEG_MS } from "@wrathbench/inspector/codec/trace";
import { closedWindowsMemo, createInspectorApi, nearbyWindow, traceIndex, traceSegment } from "@wrathbench/inspector";
import { fanoutSession, fanoutSessions, isFanoutRun, isWithheldFanoutRun, runSession, runsSource } from "./runs-source";
import { attachSessionStore, isBareSessionId } from "../src/session-store";
import { fanoutLead, fanoutReadings, parseFanoutSessionId } from "../src/run-reader";
import { latestFrameResponse } from "./camera-live";
import { CLIP_CONTENT_TYPE, CLIP_MEDIA_ROUTE, clipMedia, clipsView, fileResponse, hadCamera, pickHighlight, type ClipMediaKind } from "./camera";
import { readMoves, readScratchpad, readStateItems, readStates } from "./runs";
import { isValidRunId, LIVE_WINDOW_MS, readRun, runDir } from "../src/run-list";
import {
  factOf,
  moveViewsOf,
  runRowOf,
  statePointOf,
  storeFor,
  totalsOf,
  withFanoutLeads,
  type RunStore,
} from "./clickhouse";
import { compressResponse } from "./compress";
import { CONFIG_API_PREFIX, handleConfigRequest } from "./config-api";
import { createAdminApi } from "./admin-api";
import { hostAllowlist, hostGuard } from "./host-guard";
import { writeGuard } from "./write-guard";
import { ALL_GROUPS, allGroupsOn, groupOfApiPath, type Groups } from "./groups";
import { e90TokenProfile } from "./drafts";
import {
  ART_TILE_CACHE_CONTROL,
  ART_TILE_PUBLIC_CACHE_CONTROL,
  TILE_CACHE_CONTROL,
  TILE_PUBLIC_CACHE_CONTROL,
  TILE_PUBLIC_ROBOTS,
  isRevalidatedTile,
  resolveTile,
  resolveTileIndex,
  tileNotModified,
  tileValidators,
} from "./tiles";
import { playtimeMs, recordSegments, segmentsFrom } from "../src/sessions";
import { RunTotalsScanner, type RunTotals } from "../src/run-totals";
import type { ApiContext } from "./api-context";
import { createFleetApi, sharedStore, STORE_SHARE_MS } from "./api-fleet";
import { createTailCache, type TrackCore } from "./api-tails";

/* The fleet readers moved to `api-fleet.ts`; re-exported here unchanged. */
export {
  coldRuns,
  fleetRunIds,
  heldAccounts,
  readFleet,
  readServerState,
  SERVER_PHASES,
  sharedStore,
  STORE_SHARE_MS,
  withoutRuns,
} from "./api-fleet";
/* The tail cache moved to `api-tails.ts`; its bounds are re-exported here unchanged. */
export { TAIL_CACHE_BYTES, TAIL_IDLE_MS } from "./api-tails";

/**
 * How often the live tail rescans, and the biggest entries window a client may
 * ask for: the run page's own window (`ENTRIES_WINDOW`), which the publisher
 * reads through this handler too, so a smaller cap would cut the published
 * window and leave a hole in the private page's "load earlier".
 */
export const POLL_MS = 1000;
export const WINDOW_MAX = ENTRIES_WINDOW;

/** The five-man bosses known by entry: elites by rank, so the rank alone does not say (`isBossKill`). */
const NAMED_BOSSES: ReadonlySet<number> = new Set(DEADMINES_BOSSES);

/**
 * Where the `/entries` window that shows the moment `at` begins: the window
 * of `limit` entries with the last entry at or before `at` a quarter of the
 * way in, so a reader who jumped to a time has a little of what led up to it
 * and most of what came after. Clamped to the run, so a time before the first
 * entry is the first window and one past the last is the tail.
 */
export function entriesWindowAt(entries: readonly { ts: number }[], at: number, limit: number): number {
  let lo = 0;
  let hi = entries.length - 1;
  let found = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (entries[mid]!.ts <= at) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return Math.max(0, Math.min(found - Math.floor(limit / 4), entries.length - limit));
}

/**
 * How long a terminated run's files must have been quiet before its track is
 * treated as final. Far past the collector's five-second poll, so the store
 * holds the last of its states and moves before anything is kept.
 */
export const TRACK_SETTLE_MS = 5 * 60_000;

/** How many settled runs' track cores are kept; each is one replay's points, inventory patches and moves. */
export const TRACK_MEMO_RUNS = 6;

/** Whether a request's `If-None-Match` names this ETag (weak comparison, as RFC 9110 has for it). */
function ifNoneMatch(req: Request, etag: string): boolean {
  const header = req.headers.get("if-none-match");
  if (header === null) return false;
  if (header.trim() === "*") return true;
  const bare = (t: string): string => t.trim().replace(/^W\//, "");
  return header.split(",").some((t) => bare(t) === bare(etag));
}

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
   * The config store (the only fleet config since 2026-09-18): what
   * the config API reads and writes, and where `/api/models` and
   * `/api/campaigns` take their roster and campaigns from. Absent is the data
   * volume's default (`configDbPath`); a test names its own. An empty or
   * unreadable store is a normal state those routes label rather than an
   * error.
   */
  configDbPath?: string;
  /**
   * Where run rows, state series and the per-run derivations are read from
   * (`clickhouse.ts`). Absent means `storeFor(runsDir)`: ClickHouse when
   * `CLICKHOUSE_URL` is set, and otherwise a store the collector fills in
   * memory from the runs directory — which is what a bare clone, a test and a
   * one-shot render get.
   */
  store?: RunStore;
  /**
   * The names this handle answers to beyond `localhost` and IP addresses
   * (`host-guard.ts`); a request addressed to any other is a 421 on every path.
   * Absent means no Host check at all, which is right only for a handle no
   * network reaches — the snapshot renderer's and a test's. `serve.ts`, the one
   * place a handle is bound to a port, always passes it.
   */
  allowedHosts?: readonly string[];
  /**
   * Which of the deployment's groups are on (`groups.ts`). A group that is off
   * has no route here: its paths answer the 404 any unknown path gets. Absent
   * is every group, which is today's deployment and what a bare clone runs.
   */
  groups?: Groups;
  /**
   * The admin switch (`groups.ts`): mounts the config API, the one write
   * surface. Off by default, so a handle that is not told otherwise has no
   * write route at all; a public handle never has one, whatever this says.
   */
  admin?: boolean;
  /**
   * A bare session store read beside the runs (`WRATHBENCH_SESSION_STORE`,
   * `runner/src/session-store.ts`): a standalone wrath-mcp's sessions, listed
   * and opened as runs under their viewer ids. Absent is none. A public
   * handle withholds every one of them.
   */
  sessionStore?: string | null;
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

/** The one shared scoreability verdict (`badEvidenceReason`), applied to a projected result row. */
function badEvidenceOf(r: Pick<ResultRun, "live" | "pauseReason" | "modelResponses" | "terminationReason">): string | null {
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

/** Where the inspector's API is mounted on a private handle. */
export const INSPECTOR_BASE = "/api/inspector";

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

/** How long `/api/highlight` is held: it reads every listed run's `camera/clips.json`. */
const HIGHLIGHT_CACHE_MS = 15_000;

/**
 * How long one whole-fleet listing build stands in for the next.
 *
 * Seconds, and short ones: the listing is the most expensive thing this server
 * builds — two fleet-wide store queries, every run's totals, every run's state
 * series — and two routes call for it *per run* (`/api/run/<id>` and its
 * `/track`, for a freeplay run or one that continues another). The publisher
 * fetches both for every run with eight workers, so one pass used to issue
 * thousands of fleet-wide queries in bursts and ran ClickHouse out of memory.
 *
 * Fifteen seconds is what that costs and no more: a publisher pass takes about
 * a minute, the freeplay character view a run page wears tolerates a few
 * seconds of staleness, and the run page's own numbers — its states, tokens,
 * cost, playtime — do not come from this listing at all.
 */
export const RESULT_RUNS_CACHE_MS = 15_000;

/** `/api/info`'s `previewSeries`, spread in: the field when the store's `site` block names one, nothing otherwise. */
export function previewSeriesField(site: SiteSettings): { previewSeries?: string } {
  return site.previewSeries === undefined ? {} : { previewSeries: site.previewSeries };
}

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
 * Build the request handler.
 *
 * Per-run tails, scan serialisation and the totals memo live in the closure:
 * one viewer process, one reader per run, however many browsers are watching.
 */
/**
 * A handler, plus the one thing a one-shot walk over the whole runs tree needs
 * that a viewer does not: the ability to forget a run.
 *
 * Every per-run memo in this closure exists because a viewer is polled — a
 * finished run is read once per process and answered from memory forever after.
 * The snapshot publisher is the opposite shape: it visits every run once per
 * pass, in order, and nothing it has already published will be asked for again
 * this pass, so those memos are a live set that grows with the tree. `release`
 * lets that caller drop one run's share of it.
 *
 * It is opt-in and nothing in the viewer calls it: a process that keeps serving
 * requests lets its own eviction decide (`evictTails` — idle runs and a byte
 * budget, never one a stream is reading). The cost is symmetric and worth
 * stating — a released run is read from disk again the next time it is asked
 * for, which for the publisher means every pass rather than once per process.
 */
export type ApiHandle = ((req: Request) => Promise<Response>) & {
  /** Forget every per-run memo for `runId`. A run that is not cached is a no-op. */
  release(runId: string): void;
  /**
   * How many runs each per-run memo is holding. Introspection only — what a
   * streaming pass asserts about itself, and what an operator would want if the
   * publisher ever grows again.
   */
  cachedRuns(): { entries: number };
  /**
   * The runs a public handle withholds, sorted: every run whose driver is not a
   * model (`isNotAModelRun`, by driver or by stamp), and every fan-out run
   * but a `deadmines-solo` one (`isWithheldFanoutRun`). The publisher hands them
   * to its engine to delete what an earlier pass published for them
   * (`runner/viewer/snapshot.ts`, `withdrawn`). Not a route: it is answered
   * in-process only, so no public reader learns the ids.
   */
  unpublishedRuns(): Promise<string[]>;
};

export function createApi(opts: ApiOptions): ApiHandle {
  const { runsDir, tilesDir } = opts;
  // Before the store below, whose first pass lists the store's sessions with the runs.
  if (opts.sessionStore !== undefined) attachSessionStore(runsDir, opts.sessionStore);
  /*
   * The derived store. Every route that once opened all 1,148 run directories
   * reads rows from here instead (docs/ARCHITECTURE.md, "The derived store").
   * Its corpus-wide reads are shared over `STORE_SHARE_MS` and nothing longer
   * (`sharedStore`): enough that the fleet page's tabs and routes, polling
   * every few seconds, cost one query rather than one each, and short enough
   * that nothing here can be meaningfully wrong about a live run.
   */
  const store = sharedStore(opts.store ?? storeFor(runsDir));
  /*
   * The fleet config, read as the supervisor reads it, on the same window:
   * `/api/fleet`, `/api/models` and `/api/campaigns` all ask for it per poll,
   * and one read of the store is 12-29 ms. A write through the config API
   * drops it at once (`route`), so an edit is never shown stale on the page
   * that made it.
   */
  let rosterHeld: { at: number; value: ReturnType<typeof readFleetRoster> } | undefined;
  const fleetRoster = (): ReturnType<typeof readFleetRoster> => {
    if (rosterHeld === undefined || Date.now() - rosterHeld.at >= STORE_SHARE_MS) {
      rosterHeld = { at: Date.now(), value: readFleetRoster(opts.configDbPath) };
    }
    return rosterHeld.value;
  };
  const publicMode = opts.publicMode === true;
  const tilesPublic = opts.tilesPublic === true;
  const groups = opts.groups ?? ALL_GROUPS;
  // Never on a public handle: the read-only public site has no write surface.
  const admin = opts.admin === true && !publicMode;
  // The admin pages' status beside the config they edit (`admin-api.ts`).
  const adminApi = admin
    ? createAdminApi({ groups, runsDir, ...(opts.configDbPath !== undefined ? { dbPath: opts.configDbPath } : {}) })
    : null;
  const allowedHosts = opts.allowedHosts === undefined ? null : hostAllowlist(opts.allowedHosts);
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
  const pub = <T>(body: T, project: (b: T) => unknown, runIds: readonly string[] = []): Response =>
    json(publicMode ? struckFor(project(body), runIds) : body);
  const struckFor = (projected: unknown, runIds: readonly string[]): unknown =>
    runIds.length === 0 ? projected : JSON.parse(publicText(JSON.stringify(projected), runIds));
  /**
   * The public boundary's one session-token strike (`runner/src/session-token.ts`),
   * a backstop for runs recorded while the module still echoed the token in its
   * action replies: a model that logged one carried it into its own text, and
   * those trajectories keep it. Every public body that carries a run's
   * model-written text names its runs to `pub` (or, for the scratchpad, here),
   * and each run's token is read fresh from its meta.json and struck by value.
   */
  const publicText = (text: string, runIds: readonly string[]): string => {
    const tokens: string[] = [];
    for (const id of runIds) {
      const d = runDir(runsDir, id);
      const t = d === null ? null : strikableSessionToken(d, id);
      if (t !== null) tokens.push(t);
    }
    return strikeSessionTokens(text, tokens);
  };
  const dashboardDir = opts.dashboardDir;
  /** Per-handle, so a test's temp dir never inherits another's build id. */
  const buildCache: { mtime: number; id: string | null } = { mtime: -1, id: null };
  // The series census for /api/info, on a window: every open tab polls that
  // route, and the answer only moves when a run starts.
  let seriesCache: { at: number; value: { series: string; runs: number }[] } | undefined;
  // The home page's clip, on a short window: it reads every listed run's camera directory.
  let highlightCache: { at: number; value: HighlightResponse } | undefined;
  const seriesCensus = async (): Promise<{ series: string; runs: number }[]> => {
    const now = Date.now();
    if (seriesCache === undefined || now - seriesCache.at >= SERIES_CACHE_MS) {
      seriesCache = { at: now, value: harnessSeriesCensus(await runRows(now)) };
    }
    return seriesCache.value;
  };
  const worldserver = worldserverIdentity(opts.moduleUrl ?? "http://127.0.0.1:8086");

  /** Each run's closed trace windows, for its track (see `release` for why it is never dropped). */
  const closedWindows = closedWindowsMemo();
  const inspector = createInspectorApi(runsSource(runsDir), { base: INSPECTOR_BASE });
  /** A run's closed trace windows, memoised per run (`closedWindowsMemo`). */
  const traceSegs = (runId: string, now: number) => closedWindows(`${runsDir}\0${runId}`, runSession(runsDir, runId), now);

  /** The runs' tails and settled track cores, and forgetting them (`api-tails.ts`). */
  const { tailFor, pin, unpin, evictTails, scan, trackCores, release, cachedRuns } = createTailCache();

  /**
   * Every run row, mapped and ordered as the listing wants it.
   *
   * One query where this was a thousand `run.sqlite` opens, and nothing
   * memoises it *here*: the store is already the memo for one reader, and a
   * cache in front of this would only be a second thing that can be wrong
   * about a live run. What is memoised is one layer up — `resultRuns` holds a
   * whole listing build on a short window, because that build is what the
   * per-run routes ask for. Archived runs are filtered here rather than at
   * ingestion — the scheduler needs them, a listing must not show them, and
   * that is a question for the reader.
   */
  async function allRunRows(now = Date.now()): Promise<RunRow[]> {
    /*
     * The latest readings without the inventory (`latestReadings`): `items` is
     * nearly all of the states table, and no listing reads it — not the
     * private runs table, not results, ladders, models or the census, and not
     * a public `/api/runs` either, whose rows (`projectRunListRow`) carry no
     * inventory. A row here has `items: null`; the one page that shows an
     * inventory is a run's own, which reads `latestState` for that run.
     */
    const [rows, readings] = await Promise.all([store.runRows(), store.latestReadings()]);
    // A fan-out run reads its lead character's level and xp (`withFanoutLeads`).
    const latest = withFanoutLeads(readings);
    const out = rows
      .filter((r) => r.archived === 0)
      .map((r) => runRowOf(r, latest.get(r.run_id), now));
    out.sort((a, b) => (b.startedAt ?? b.mtime ?? 0) - (a.startedAt ?? a.mtime ?? 0));
    return out;
  }

  /**
   * The listing's rows. A public handle leaves out every run whose driver is
   * not a model (operator, 2026-10-20): the scripted reference plays a private
   * program its snippets carry, so no public body may name one. The rule is
   * the scheduler's (`isNotAModelRun`), and it is applied here, at the source
   * every listing reads, and again per run (`withheldRun`).
   */
  async function runRows(now = Date.now()): Promise<RunRow[]> {
    const rows = await allRunRows(now);
    return publicMode ? rows.filter((r) => !withheldRow(r)) : rows;
  }

  /**
   * Whether a public handle withholds this row: its driver is not a model, or
   * it is a fan-out run, one agent driving several characters, other than a
   * scored `deadmines-solo` attempt (`isWithheldFanoutRun`). Any other fan-out
   * run is an unscored probe and has no public form (its run detail presents
   * no character and its game side is per character); the one-agent
   * Deadmines id's runs are published with its table (operator delegated,
   * 2026-11-15). Read off the run's directory, from meta.json's launch
   * config, so a run is withheld from its first pass rather than published
   * and withdrawn. A bare session (`session-store.ts`) is withheld whole: no
   * launch says what drove it, and publishing one is not this handle's call.
   */
  function withheldRow(r: Pick<RunRow, "runId" | "driver" | "shakeout">): boolean {
    return isWithheldRow(r) || isBareSessionId(r.runId) || isWithheldFanoutRun(runsDir, r.runId);
  }

  /** The ids a public handle withholds (`ApiHandle.unpublishedRuns`). */
  async function unpublishedRuns(): Promise<string[]> {
    return (await allRunRows())
      .filter(withheldRow)
      .map((r) => r.runId)
      .sort();
  }

  /** Whether a public handle answers this run as if it did not exist. Always false on a private one. */
  async function withheldRun(runId: string): Promise<boolean> {
    return publicMode && withheldRow(await runRowOne(runId));
  }

  /**
   * One run's row. Its own state rows answer the latest readings.
   *
   * Falls back to the files when the store has no row for a directory that is
   * there. That is not a hedge against ClickHouse: it is the first seconds of
   * a run's life. The collector polls, so a run that started a moment ago has
   * a directory and no row yet, and the run page existed to be watched from
   * the first turn. `readRun` is a single run's files — one `run.sqlite`, not
   * a scan — and this route already opens that run's trajectory for its feed.
   */
  async function runRowOne(runId: string, now = Date.now()): Promise<RunRow> {
    return (await runRowAndLead(runId, now)).run;
  }

  /**
   * `runRowOne`, and for a fan-out run the name of the character whose level
   * and xp the row reads (`fanoutLead`), off the same source as the row: the
   * store's readings, or the files'. Null for any other run, and before any
   * character has a level.
   */
  async function runRowAndLead(runId: string, now = Date.now()): Promise<{ run: RunRow; lead: string | null }> {
    const r = await store.runRow(runId);
    if (r === null) {
      const run = readRun(runsDir, runId, now);
      const dir = runDir(runsDir, runId);
      const lead = run.character === null && dir !== null && isFanoutRun(runsDir, runId) ? (fanoutLead(fanoutReadings(dir))?.character ?? null) : null;
      return { run, lead };
    }
    // The store's own aggregate, not every row of the run mapped here: this
    // needs five values, and pulling the series to get them meant reading the
    // `items` JSON of every sample.
    const own = await store.latestState(runId);
    if (own !== undefined || !isFanoutRun(runsDir, runId)) return { run: runRowOf(r, own, now), lead: null };
    // A fan-out run's are its characters', each under its session id: the listing's roll-up.
    const sessions = fanoutSessions(runsDir, runId);
    const got = await Promise.all(sessions.map(async (s) => [s, await store.latestState(s.id)] as const));
    const readings = got.flatMap(([s, l]) => (l === undefined ? [] : [{ id: s.id, character: s.character, level: l.level, xp: l.xp, reading: l }]));
    const lead = withFanoutLeads(new Map(readings.map((x) => [x.id, x.reading] as const))).get(runId);
    return { run: runRowOf(r, lead, now), lead: fanoutLead(readings)?.character ?? null };
  }

  /**
   * One run's state series, from the store, falling back to its own sqlite for
   * the same reason `runRowOne` does.
   */
  async function statesOfRun(runId: string): Promise<StatePoint[]> {
    const rows = await store.stateRows(runId);
    return rows.length > 0 ? rows.map(statePointOf) : readStates(runsDir, runId);
  }

  /**
   * One run's inventory samples, for the replay track — the same store-then-files
   * fallback, and its own call because `items` is the one large column and only
   * a replay wants it.
   */
  async function stateItemsOfRun(runId: string): Promise<StateItemsRow[]> {
    const rows = await store.stateItemRows(runId);
    return rows.length > 0 ? rows : readStateItems(runsDir, runId);
  }

  /**
   * Per-run totals for the listing.
   *
   * Every one of these was computed once, by the viewer's own
   * `RunTotalsScanner`, when the collector tailed the file — so the listing no
   * longer re-reads a trajectory to count what it shows, and the numbers are
   * the same numbers by construction rather than by a second implementation
   * agreeing. See `collector/schema.sql` (`run_totals`) for why this is not a
   * SQL aggregation.
   */
  async function allTotals(): Promise<Map<string, RunTotals>> {
    const out = new Map<string, RunTotals>();
    for (const r of await store.totalsRows()) {
      const totals = totalsOf(r);
      if (totals !== null) out.set(r.run_id, totals);
    }
    return out;
  }

  async function runTotals(runId: string): Promise<RunTotals | null> {
    return totalsOf(await store.totalsRow(runId));
  }

  /**
   * The scheduler's facts, off the same store.
   *
   * `/api/models` still serves `modelStates` — the supervisor's own verdict,
   * so the page and the supervisor cannot disagree about why a model is not
   * running. Only where the `RunFact[]` comes from changed: the collector
   * called `readRunFact` as it tailed, and this reads the answer back.
   * Liveness is the one field re-decided here, against this `now`, because a
   * stored `true` would be a claim about a process that stopped writing hours
   * ago.
   */
  async function runFacts(now: number): Promise<RunFact[]> {
    // The liveness columns and the fact alone: the JSON-heavy columns of both
    // tables (meta, config, the whole totals) are what made this ~6 MB a call.
    const [rows, totals] = await Promise.all([store.runListing(), store.factRows()]);
    const mtimes = new Map(
      rows.filter((r) => r.archived === 0).map((r) => [r.run_id, r.trajectory_mtime === 0 ? null : r.trajectory_mtime]),
    );
    const out: RunFact[] = [];
    for (const t of totals) {
      if (!mtimes.has(t.run_id)) continue;
      const fact = factOf(t, mtimes.get(t.run_id) ?? null, now);
      if (fact !== null) out.push(fact);
    }
    // Oldest first, ties broken by run id — the same order the reader this
    // replaces produced, so nothing downstream sees a different sequence.
    out.sort((a, b) => a.startedAt - b.startedAt || (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));
    return out;
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
   * A store session's playtime, which has no trajectory totals to sum: its
   * record's span (`recordSegments`), the same one its run page serves. Null
   * on any other row without totals.
   */
  function storePlaytime(row: RunRow, now: number): number | null {
    return row.source === "store" ? playtimeMs(recordSegments(row), { lastTs: row.endedAt, live: row.live, now }) : null;
  }

  /**
   * The listing facts a `ResultRun` carries: playtime, tokens, and the cost.
   *
   * `runCost` is the listing's own, over the same memoised totals, so no page
   * can quote different dollars for one run. Both figures ride on the row but
   * under their own names: `actualCost` is what the provider charged, and
   * `expectedCost` is the price table applied to the tokens, which the runs
   * table and the ladder's scatter read only where no provider figure exists
   * (a free tier, local hardware, a subscription) and mark as an estimate.
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
   * Built inside this closure on purpose: it reads the same stored totals the
   * run page does, so the charts and the page cannot disagree. The segments it
   * passes are the run page's own, which is what makes time-to-level and
   * playtime agree.
   */
  async function buildResultRuns(): Promise<ResultRun[]> {
    const out: ResultRun[] = [];
    // One clock for the pass: a live run's playtime is charged up to *now*, and
    // two rows of one response must not be measured against different nows.
    const now = Date.now();
    // Every row, withheld or not: `resultRuns` withholds for a public handle,
    // and the reference line (`allResultRuns`) is read off the rows it withholds.
    const [rows, totalsByRun] = await Promise.all([allRunRows(now), allTotals()]);
    // One query for every run's state series, not one per run: a pass over
    // ~700 runs used to issue ~700 sequential `states` reads, which is what
    // ran ClickHouse out of memory on 2026-09-17.
    const statesByRun = await store.stateRowsByRun(rows.map((r) => r.runId));
    for (const raw of rows) {
      const totals = totalsByRun.get(raw.runId) ?? null;
      const row = withResolved(raw, totals);
      // Let each series go as it is consumed: the map holds every state row of
      // the corpus, and the publisher's pass has a hard-won peak-RSS bound
      // (runner/viewer/snapshot.ts) to stay inside.
      const states = statesByRun.get(row.runId) ?? [];
      statesByRun.delete(row.runId);
      out.push(
        resultRunOf(
          row,
          states.map(statePointOf),
          totals?.segments ?? (row.source === "store" ? recordSegments(row) : []),
          totals === null
            ? null
            : {
                toolCalls: totals.toolCalls,
                snippets: totals.snippets,
                modelResponses: totals.modelResponses,
              },
          totals === null
            ? row.source === "store"
              ? { playtimeMs: storePlaytime(row, now), tokens: null, actualCost: null, expectedCost: null }
              : null
            : listingFacts(row, totals, now),
          totals?.areas ?? null,
          totals?.achievements ?? null,
          totals?.taxi ?? null,
          totals?.leveling ?? null,
          totals?.deaths ?? null,
          totals === null
            ? undefined
            : { spells: totals.spells, talents: totals.talents, trades: totals.trades },
          totals?.milestones,
        ),
      );
    }
    return out;
  }

  /**
   * The listing, built at most once per `RESULT_RUNS_CACHE_MS`.
   *
   * The pending promise is what is stored, not just the settled value, so a
   * burst of concurrent callers shares one build rather than starting one
   * each: that burst is the whole point. The publisher fetches `/api/run/<id>`
   * and `/api/run/<id>/track` for every run with eight workers, and both call
   * for this listing on a freeplay run, so hundreds of fleet-wide queries used
   * to leave in a few seconds.
   *
   * The build's own clock goes with it: the rows a window serves were all
   * measured against the `now` of the build that made them, so a live run's
   * playtime can read up to `RESULT_RUNS_CACHE_MS` short. `/api/results` still
   * stamps its `now` at request time, which is the figure a client ages
   * against. Fifteen seconds of that is below what any of these surfaces show.
   *
   * Per handle, like the series census and the build id, so a test that builds
   * its own `createApi` starts with an empty window. It is not conditioned on
   * which store is behind it: the local store is a memo over the same files,
   * and one rule is easier to be right about than two.
   *
   * The window is restamped when the build *settles*, not when it starts: a
   * build of the whole corpus is the expensive thing here, and a start stamp
   * would spend most of a fifteen-second window building and leave the
   * finished rows standing for whatever was left. A build that throws is not
   * kept at all — the window would otherwise serve the failure until it
   * expired.
   */
  let listingCache: { at: number; value: Promise<ResultRun[]> } | undefined;
  /**
   * The listing a handle serves. A public handle's results, ladders, episodes,
   * campaigns and character chains are all built off this, so a run withheld
   * here is withheld there.
   */
  async function resultRuns(): Promise<ResultRun[]> {
    const rows = await allResultRuns();
    return publicMode ? rows.filter((r) => !isNotAModelRun(r) && !isWithheldFanoutRun(runsDir, r.runId)) : rows;
  }
  /** Every run, withheld or not: what the scripted reference line is read from. */
  function allResultRuns(): Promise<ResultRun[]> {
    const now = Date.now();
    if (listingCache === undefined || now - listingCache.at >= RESULT_RUNS_CACHE_MS) {
      const build = buildResultRuns();
      listingCache = { at: now, value: build };
      build.then(
        () => {
          if (listingCache?.value === build) listingCache = { at: Date.now(), value: build };
        },
        () => {
          if (listingCache?.value === build) listingCache = undefined;
        },
      );
    }
    return listingCache.value;
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
   * right heading. With the evals group off there are no tiers to default
   * to, and an absent filter is `all`.
   */
  function episodeFilter(url: URL): EpisodeIdView | "all" | null {
    const raw = url.searchParams.get("episode");
    if (raw === null) return groups.evals ? "e90" : "all";
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
  // Nor are the task episodes (operator, 2026-11-14): a staged level-20
  // dungeon run would top a level ladder, and their runs are read on the
  // dungeon board instead.
  const LADDER_EPISODES: readonly string[] = EPISODE_IDS.filter((id) => id !== "probing" && !isTaskEpisode(id));

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
    // With evals off the rows are a listing, not a comparison: no ladder condition rides on them.
    const runs = groups.evals ? tiered : tiered.map(withoutEvalFields);
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
      // The ladder's reference line, as numbers, off every run: the reference
      // run is withheld from a public handle's rows, and this is all of it
      // that is published (`scripted-reference.ts`).
      ...(ladder ? { scriptedReference: scriptedReferenceLines(await allResultRuns(), episode) } : {}),
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
        // A run whose driver is not a model ran an episode's shape and is no
        // member of its group: the scripted reference is a labelled line, not
        // a run of the tier (docs/METHODOLOGY.md, "Scoring").
        const tagged = all.filter((r) => r.episode === tier.id && !isNotAModelRun(r));
        const stamped = tagged.filter((r) => r.episodeSource === "stamped");
        // An attempt that never became an episode is not a member of the tier's
        // group — the same predicate the ladder filters on, so this
        // count and that chart hold the same runs.
        const notEvidence = (r: (typeof stamped)[number]): boolean => badEvidenceOf(r) !== null;
        const lapsed = (r: (typeof stamped)[number]): boolean => r.terminationReason !== null && notEvidence(r);
        return {
          ...tier,
          members: stamped.filter((r) => !r.episodeOverride && !notEvidence(r)).length,
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
   * The probe lane, one entry per published campaign version
   * (`campaignsView`), with every refusal the campaign parser made.
   *
   * The published definitions and the store row come from the config store,
   * read exactly as the supervisor reads them; the runs from the run
   * directory, matched by their own stamps. `counted` is the scheduler's own
   * definition (`countedRun`, lapse.ts) over a result row — never `unscored`, which is non-null for
   * every probe.
   */
  /**
   * The dungeon board (`dungeons.ts`): the runs of each Deadmines id with a
   * table (`hasBoard`, `deadmines-solo` alone), read with each character's
   * milestones. Off the handle's own listing, so a run a public handle
   * withholds is in no row.
   */
  async function dungeonsResponse(): Promise<Response> {
    const all = (await resultRuns()).filter((r) => hasBoard(r.episode) && r.episodeSource === "stamped");
    const runs = await Promise.all(
      all.map(async (run) => ({ run, characters: await dungeonMarksOf(runsDir, run.runId, { ended: run.terminationReason !== null, character: run.character }) })),
    );
    // The same table on either handle: the one-agent id's runs are the only
    // fan-out runs a public handle lists (`resultRuns`).
    const boards = boardsOf(runs);
    const body: DungeonsResponse = { version: DUNGEON_BOARD_VERSION, boards, now: Date.now() };
    return pub(body, projectDungeons);
  }

  async function campaignsResponse(): Promise<Response> {
    const all = await resultRuns();
    const roster = fleetRoster();
    const view = campaignsView(all, roster, (r) =>
      countedRun({
        extra: r.extra,
        episodeOverride: r.episodeOverride,
        notAModel: isNotAModelRun(r),
        live: r.live === true,
        paused: r.pauseReason !== null,
        modelResponses: r.modelResponses,
        terminationReason: r.terminationReason,
      }),
    );
    const body: CampaignsResponse = { now: Date.now(), campaigns: view.campaigns, refused: view.refused };
    return pub(body, projectCampaigns);
  }

  async function listWithTotals(): Promise<RunListRow[]> {
    const [rows, totalsByRun] = await Promise.all([runRows(), allTotals()]);
    return rows.map((raw) => listRowOf(raw, totalsByRun.get(raw.runId) ?? null));
  }

  /**
   * One listing row: the run's row with its totals' figures. The runs index
   * builds every row with it and the fleet feed the few it shows
   * (`fleetRunFacts`), so the two pages cannot quote different numbers.
   */
  function listRowOf(raw: RunRow, totals: RunTotals | null): RunListRow {
    const row = withResolved(raw, totals);
    return {
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
          ? storePlaytime(row, Date.now())
          : playtimeMs(totals.segments, {
              lastTs: totals.lastTs,
              live: row.live,
              now: Date.now(),
            }),
    };
  }

  function dashboardIndex(): Response {
    if (dashboardDir === undefined) return unbuilt();
    return staticFile(dashboardDir, "index.html") ?? unbuilt();
  }

  /**
   * Whether a run can no longer change underneath its track: terminated, and
   * its files quiet for `TRACK_SETTLE_MS`, which is what lets the collector —
   * a five-second poll — have stored the last of its states and moves.
   */
  function isSettled(run: RunRow): boolean {
    return run.terminationReason !== null && run.mtime !== null && Date.now() - run.mtime >= TRACK_SETTLE_MS;
  }

  /**
   * The store-derived half of a run's track: its points with the inventory as
   * patches, and its moves. For a live run, read fresh every time. For a
   * settled one, read once and kept (`trackCores`): those rows cannot change
   * any more, and reading them is the expensive part of the route — a long
   * run's whole `items` history out of the store, hundreds of milliseconds and
   * tens of MB a call. Nothing invalidates an entry but eviction: the LRU
   * bound, `release`, and the run's tail being dropped.
   */
  async function trackCoreOf(runId: string, settled: boolean): Promise<TrackCore> {
    const held = settled ? trackCores.get(runId) : undefined;
    if (held !== undefined) {
      trackCores.delete(runId);
      trackCores.set(runId, held);
      return held;
    }
    const [states, items, moveRows] = await Promise.all([
      statesOfRun(runId),
      stateItemsOfRun(runId),
      store.moveRows(runId),
    ]);
    const core: TrackCore = {
      ...trackFrom(states, items),
      // Same fallback as the track's own points: a run whose moves the
      // collector has not reached yet still draws its intentions.
      moves: moveRows.length > 0 ? moveViewsOf(moveRows) : await readMoves(runsDir, runId),
    };
    if (settled) {
      trackCores.set(runId, core);
      while (trackCores.size > TRACK_MEMO_RUNS) trackCores.delete(trackCores.keys().next().value!);
    }
    return core;
  }

  /**
   * A fan-out character's replay feed, under its session id
   * (`<run-id>~<Character>`, `runs-source.ts`): `/track`, `/trace` and
   * `/trace/<t0>`, read as a run's are, off the character's own record and
   * the store's rows under that id (the collector keys them so). Its run's
   * row answers the rest: the model, the harness, whether the track can still
   * change. A public handle answers none: a fan-out run it publishes (a
   * `deadmines-solo` attempt) is published without its characters, so no
   * character's id is public. No travel marks: those are the
   * trajectory's, and the run's one trajectory is no one character's.
   */
  async function fanoutCharacterRoute(id: string, parent: string, character: string, rest: string): Promise<Response> {
    const session = runDir(runsDir, parent) === null ? null : fanoutSession(runsDir, id);
    if (session === null || publicMode) return notFound(`no such run: ${id}`);
    if (rest === "/trace") return pub(await traceIndex(session, Date.now()), projectTraceIndex, [parent]);
    const traceMatch = /^\/trace\/(\d+)$/.exec(rest);
    if (traceMatch !== null) {
      const t0 = Number(traceMatch[1]);
      if (!Number.isSafeInteger(t0) || t0 % SEG_MS !== 0) return notFound("no such trace window");
      const found = await traceSegment(session, t0, Date.now());
      if (found === null) return notFound("no trace in that window");
      return new Response(JSON.stringify(found.segment), {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": found.closed ? "public, max-age=31536000, immutable" : "no-store",
        },
      });
    }
    if (rest !== "/track") return notFound(`no such route for ${id}`);
    const run = await runRowOne(parent);
    const core = await trackCoreOf(id, isSettled(run));
    const trace = await closedWindows(`${runsDir}\0${id}`, session, Date.now());
    const body: TrackResponse = {
      runId: id,
      characterName: character,
      model: run.model,
      harnessVersion: run.harnessVersion,
      points: core.points,
      inv: core.inv,
      moves: core.moves,
      travel: [],
      ...(trace === null ? {} : { trace }),
    };
    return pub(body, projectTrack, [parent]);
  }

  /**
   * What the route modules share with this closure (`api-context.ts`): the
   * store, the projection helper and the listing reads, so every module reads
   * the one memo rather than a copy of it.
   */
  const ctx: ApiContext = {
    runsDir,
    store,
    publicMode,
    groups,
    pub,
    fleetRoster,
    harnessFilter,
    runRows,
    allTotals,
    withResolved,
    runFacts,
    unpublishedRuns,
    runRowOne,
    runTotals,
    listRowOf,
  };
  // A group that is off is absent: its module is not built (`groups.ts`).
  const fleetApi = groups.runner ? createFleetApi(ctx) : null;

  async function api(req: Request, url: URL, path: string): Promise<Response | null> {
    // A group that is off has no routes: its paths are unknown paths here.
    const group = groupOfApiPath(path);
    if (group !== null && !groups[group]) return null;
    if (path === "/api" || path === "/api/info") {
      const body: ApiInfoResponse = {
        service: "wrathbench-viewer",
        publicMode,
        dashboard: dashboardDir !== undefined && existsSync(join(dashboardDir, "index.html")),
        dashboardBuild: dashboardBuildOf(dashboardDir, buildCache),
        worldserver: await worldserver(),
        harnessSeries: await seriesCensus(),
        // Only when the store's `site` block names one, so a deployment without it serves the body it did.
        ...previewSeriesField(fleetRoster().site),
        // The deployment's name, theme, home and about, likewise only when set.
        ...siteInfoField(fleetRoster().site),
        // Only when one is off, so today's deployment serves the body it did.
        ...(allGroupsOn(groups) ? {} : { groups: { ...groups } }),
        ...(admin ? { admin: true } : {}),
        now: Date.now(),
      };
      return pub(body, projectInfo);
    }
    if (path === "/api/runs") {
      const body: RunsResponse = { runs: await listWithTotals() };
      return pub(body, projectRuns);
    }
    // The home page's one clip, over the runs this handle lists: a public
    // handle's listing has already left out every run that is never published.
    if (path === "/api/highlight") {
      const at = Date.now();
      if (highlightCache === undefined || at - highlightCache.at >= HIGHLIGHT_CACHE_MS) {
        const runs: { runId: string; model: string | null; clips: ClipsResponse }[] = [];
        for (const r of await runRows(at)) {
          const clips = clipsView(runsDir, r.runId);
          if (clips !== null) runs.push({ runId: r.runId, model: r.model, clips });
        }
        highlightCache = { at, value: { highlight: pickHighlight(runs) } };
      }
      const body = highlightCache.value;
      return pub(body, projectHighlight, body.highlight === null ? [] : [body.highlight.runId]);
    }
    if (path === "/api/positions") {
      const listed = publicMode ? new Set((await runRows()).map((r) => r.runId)) : null;
      // A public handle keeps a position only for a run its own listing holds:
      // a position carries no driver to judge it by, so one the listing does
      // not vouch for is left out rather than guessed at.
      const positions = (await positionsFromStore(store, runsDir)).filter((p) => listed === null || listed.has(p.runId));
      // A position's status is the character's last `log_status` line, as written.
      return pub({ positions }, projectPositions, positions.map((p) => p.runId));
    }
    if (path === "/api/episodes") return await episodesResponse();
    if (path === "/api/campaigns") return await campaignsResponse();
    if (path === "/api/dungeons") return await dungeonsResponse();
    /*
     * `/api/ladder` serves the same projection as `/api/results`. The ladder's own
     * derivation stays client-side (`dashboard/src/lib/ladder.ts`, where its row
     * order, the milestone rules and their tests already live); the route exists so the episode
     * filter has one spelling per page rather than the ladder page having to
     * know it is really asking the results endpoint. It differs in one thing:
     * `probing` has no ladder (see `LADDER_EPISODES`) and answers 400 here,
     * while `/api/results?episode=probing` still lists those runs.
     */
    if (path === "/api/results") return await resultsResponse(url);
    if (path === "/api/ladder") return await resultsResponse(url, true);
    // The runner group's routes (`api-fleet.ts`): `/api/fleet`, `/api/models` and `/api/tools`.
    const runner = fleetApi === null ? null : await fleetApi(url, path);
    if (runner !== null) return runner;

    /*
     * One character, whole: the aggregate every attempt's page
     * shows a card of, plus the level and XP series across the WHOLE chain
     * with the attempt each sample came from — which is the one thing no
     * single run's page can draw, because a session's own series stops at its
     * own logout.
     *
     * The id may be any run in the chain, not only the head. A reader's link
     * is built from whatever attempt they were looking at, and making the SPA
     * canonicalise first would be a round trip to learn something the server
     * already knows.
     *
     * Served in public mode, like `/api/run/<id>`, through a projector that is
     * the run detail's own applied across the chain.
     */
    const cm = /^\/api\/character\/([^/]+)$/.exec(path);
    if (cm !== null) {
      const id = cm[1]!;
      if (!isValidRunId(id)) return notFound(`no such character: ${id}`);
      const view = characterViewOf(id, await resultRuns());
      if (view === null) return notFound(`no such character: ${id}`);
      /*
       * Attempt by attempt, through the same `statesOfRun` the run page reads:
       * the derived store when it has the rows, and that attempt's own sqlite
       * when the collector has not reached it. One degradation, not two.
       */
      const states: CharacterStatePoint[] = [];
      for (const [i, a] of view.runs.entries()) {
        const points = await statesOfRun(a.runId);
        for (const pt of points) states.push({ ...pt, runId: a.runId, attempt: i + 1 });
      }
      // Within an attempt, by the clock; across them, by the chain. The two
      // agree on a real character and only this order keeps a seam where a
      // clock skew across a relaunch would otherwise move a sample past one.
      states.sort((x, y) => x.attempt - y.attempt || x.ts - y.ts);
      const body: CharacterResponse = { character: view, states };
      return pub(body, projectCharacterResponse, view.runs.map((r) => r.runId));
    }

    const m = /^\/api\/run\/([^/]+)(\/.*)?$/.exec(path);
    if (m === null) return null;
    const runId = m[1]!;
    const rest = m[2] ?? "";
    // A fan-out character, under its session id: its replay feed and nothing else.
    const named = parseFanoutSessionId(runId);
    if (named !== null) return await fanoutCharacterRoute(runId, named.runId, named.character, rest);
    const dir = runDir(runsDir, runId);
    if (dir === null) return notFound(`no such run: ${runId}`);
    // Every per-run route, the trace windows and the nearby ring included: a
    // withheld run is not there, to a public handle.
    if (await withheldRun(runId)) return notFound(`no such run: ${runId}`);
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
      const { run: row, lead } = await runRowAndLead(runId);
      const run = withResolved(row, await runTotals(runId));
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
      /*
       * The segment marks, accumulated by the tail as it indexes: every
       * `SEGMENT_MARKS` entry and the first entry with a timestamp (`ts > 0`
       * keeps an unparseable first line, which `scanRunTotals` drops outright,
       * from spending the no-meta bootstrap on a zero timestamp).
       */
      const marks = tail.segmentMarks;
      /*
       * Tokens, cost, coverage and speed ride the same incremental path: the
       * tail accumulates the cost as it indexes and holds the token and speed
       * derivations until it grows (`TrajectoryTail.tokens`), so a live run's
       * figure grows with its trajectory instead of waiting for the (size,
       * mtime) totals cache to miss, and a warm poll does not re-walk every
       * entry the run ever wrote.
       */
      const tokens = tail.tokens;
      /*
       * The freeplay character this run is one attempt of, aggregated across the
       * whole chain (`character.ts`). Every figure the runner records is per
       * attempt, so without this the run page shows a twelfth session's quests
       * under a character that has been playing for a fortnight.
       *
       * Gated on the run being freeplay at all — the stamped tier, or a
       * `continuedFrom` for a run whose metadata predates the stamp — so a
       * scored run's page pays nothing for it. Behind the gate it is the
       * listing's own rows, and this route is why that listing is held on a
       * window at all: `resultRuns` shares one build for
       * `RESULT_RUNS_CACHE_MS`, so a burst of run pages pays for one, and this
       * page and `/api/ladder` cannot disagree about what a character is.
       */
      const whole =
        run.continuedFrom !== null || episodeOf(run).episode === "freeplay"
          ? characterViewOf(runId, await resultRuns())
          : null;
      /*
       * `characterViewOf` is universal since — every run has a
       * character, a scored one's being a chain of one — but a card and a strip
       * reading "attempt 1 of 1" are noise standing where a fact should be
       * (`hasLineage`, lineage.ts). So the field stays absent below the
       * threshold that gate has always drawn, and a reader who wants the
       * degenerate view asks `/api/character/<id>` for it.
       */
      const character = whole !== null && whole.attempts > 1 ? whole : null;
      // A store session has no trajectory to mark its sessions: its record's span is its one.
      const sessions = run.source === "store" ? recordSegments(run) : segmentsFrom(marks);
      const states = await statesOfRun(runId);
      /*
       * A party member's own records (`party-marks.ts`), off the tail just
       * scanned and the run's own files: gated on the row's stamp, so every
       * other run's page pays nothing and keeps its shape.
       */
      const party = run.party === undefined ? null : await partyDetailOf(runsDir, runId, dir, tail);
      /*
       * The run's boss kills, for the timeline's chapters (`timeline-marks.ts`):
       * rank-3 victims and the Deadmines' named bosses off the same kill
       * marks, each named as the run's own client cache answered its entry.
       */
      const bossMarks = tail.kills.filter((k) => isBossKill(k, NAMED_BOSSES));
      const bosses = bossKillsOf(bossMarks, NAMED_BOSSES, creatureNamesOf(dir, new Set(bossMarks.map((k) => k.entry).filter((e): e is number => e !== null))));
      const body: RunDetailResponse = {
        /*
         * The row's quest count is the newest sample's, and the counter is the
         * running process's: a run resumed in place reads zero after the
         * resume. This route holds the series, so it serves the whole run's
         * count — the figure `ResultRun.questsCompleted` carries, from the same
         * `questsAcrossRestarts`.
         */
        run: { ...run, questsCompleted: questsAcrossRestarts(states) ?? run.questsCompleted },
        states,
        total: entries.length,
        tokens,
        cost: runCost({
          run,
          tokens,
          reportedUsd: tail.reportedCostUsd,
          coverage: tail.costCoverage,
        }),
        playtimeMs: playtimeMs(sessions, { lastTs, live: run.live, now: Date.now() }),
        // The segments that figure sums, so the page's charts close the same
        // pauses the playtime does (`sessions.ts`).
        sessions,
        /*
         * The models-table row this run links to, so the page need not fetch
         * the whole models aggregate for one name. Off the roster the config
         * store holds now (`fleetRoster`, shared on its short window), like
         * `/api/models` itself. Public-safe: `models.json` publishes every row
         * name. A cold run's published detail is only re-rendered on the full
         * pass, so a renamed roster entry reaches it that late.
         */
        rosterName: rosterNameOf(
          fleetRoster(),
          run.model,
          run.comparability?.effort ?? null,
          run.comparability?.compactWindow ?? null,
        ),
        // Same incremental path as tokens and cost: the tail accumulates the
        // milestone marks as it indexes, so a live run's line grows with it.
        achievements: tail.achievements,
        taxi: tail.taxi,
        leveling: tail.leveling,
        deaths: tail.deaths,
        // Only where there is one: a run with none keeps the body, and the published key, it had.
        ...(bosses.length > 0 ? { bosses } : {}),
        spells: tail.spells,
        talents: tail.talents,
        trades: tail.trades,
        // Same incremental path again: a live run's rate advances with the tail
        // rather than waiting on the (size, mtime) totals cache to miss.
        tps: tail.tps,
        // The turns spent reflecting, from the same pass: the feed accents them
        // by turn, and the window that opens one can sit far above whatever
        // slice of entries the page happens to have loaded.
        reflections: tail.reflections,
        // Absent, not null, on a run with no character: an optional field the page
        // falls back from, the same shape the facts above take.
        ...(character === null ? {} : { character }),
        ...(party === null ? {} : { party }),
        // A fan-out run's characters, so the page can open each one's session,
        // and the one whose level and xp the run's row reads.
        ...(isFanoutRun(runsDir, runId) ? { fanout: fanoutSessions(runsDir, runId) } : {}),
        ...(lead === null ? {} : { fanoutLead: lead }),
        // A label off meta.json, read here rather than carried on the row:
        // it is no part of the listing and no store column holds it.
        ...(hadCamera(runsDir, runId) ? { camera: true as const } : {}),
      };
      return pub(body, projectRunDetail, [runId]);
    }

    /*
     * The camera's clips (`camera.ts`): the list off `camera/clips.json`, and
     * each clip's video and poster, which only a clip the list names reaches
     * and the frames never do. Public mode serves both too: the snapshot
     * publishes the same clips, and the list crosses `projectClips`, which
     * redacts each caption as model text is. A run with no clips is a 404 to
     * a public handle and `null` to a private one: the private pages ask on
     * every run, filmed or not (the `camera` label lags a live run's filming),
     * and a 404 there is a console error on every page.
     */
    if (rest === "/clips") {
      const body = clipsView(runsDir, runId);
      if (body === null) return publicMode ? notFound("no clips") : json(null);
      return pub(body, projectClips, [runId]);
    }
    /*
     * The newest camera frame and its `{seq, t}` (`camera-live.ts`), for the
     * run page's live still. Private only: frames are never published, and
     * nothing on the public site may act as a live view of the world, so a
     * public handle has no such route, before anything is read.
     */
    if (rest.startsWith("/camera/")) {
      if (publicMode) return notFound("no such route");
      const live = latestFrameResponse(req, runsDir, runId, rest);
      if (live !== null) return live;
    }
    const media = CLIP_MEDIA_ROUTE.exec(rest);
    if (media !== null) {
      const kind = media[2] as ClipMediaKind;
      const hit = clipMedia(runsDir, runId, media[1]!, kind);
      if (hit === null) return notFound("no such clip");
      return fileResponse(req, hit.file, hit.stat, CLIP_CONTENT_TYPE[kind]);
    }

    if (rest === "/track") {
      // The replay feed: the same position shape the live map
      // consumes, read from one finished run instead of every live one.
      const run = await runRowOne(runId);
      /*
       * Where this attempt sits in its character, so the map's transport can step
       * to the one either side of it without a second fetch.
       *
       * Deliberately the same expression the detail route gates its `character`
       * with, and the same `characterViewOf` call behind it: a scored run's
       * replay pays nothing, a freeplay one pays what its run page already
       * pays — and pays it only once, since both routes take the listing off
       * the same `RESULT_RUNS_CACHE_MS` window — and the two routes cannot
       * come to different answers about who continues whom.
       */
      const whole =
        run.continuedFrom !== null || episodeOf(run).episode === "freeplay"
          ? characterViewOf(runId, await resultRuns())
          : null;
      // Same threshold as the detail route's, for the same reason: a bar with
      // no attempt either side of it has nothing to step to.
      const character = whole !== null && whole.attempts > 1 ? whole : null;
      const trace = await traceSegs(runId, Date.now());
      // The travel marks ride the same incremental tail the run page reads, so
      // a replay opened after the page — and every publisher pass, which asks
      // for both — pays nothing for them; a cold replay pays the page's scan.
      await scan(runId, tail);
      const settled = isSettled(run);
      const core = await trackCoreOf(runId, settled);
      const body: TrackResponse = {
        runId,
        characterName: run.character,
        model: run.model,
        harnessVersion: run.harnessVersion,
        // The points, and the inventory along them as patches (`inv`), so the
        // replay pip can show what the live pip shows.
        points: core.points,
        inv: core.inv,
        // The intentions beside the track: same run, different cadence.
        moves: core.moves,
        // How the character crossed each gap — flights, hearths, graveyard
        // releases — derived from the trajectory at read time, never stored.
        travel: tail.travel,
        // Absent, not null, on a run with no character — as on the detail route.
        ...(character === null
          ? {}
          : {
              character: {
                characterId: character.characterId,
                attempt: character.attempt,
                attempts: character.attempts,
                previous: character.previous,
                next: character.next,
              },
            }),
        // The closed trace windows, each `/trace/<t0>`. Absent on a run with
        // none, so a track from before the recorder is the bytes it was.
        ...(trace === null ? {} : { trace }),
        // A fan-out run's characters, whose tracks the map replays together.
        ...(isFanoutRun(runsDir, runId) ? { fanout: fanoutSessions(runsDir, runId) } : {}),
      };
      if (!settled) return pub(body, projectTrack, [runId]);
      /*
       * A settled run's track revalidates rather than re-downloads: a weak
       * ETag over the body as served (weak because the bytes on the wire
       * depend on the encoding), answered with a 304 while it holds. Not
       * `immutable`, although the run cannot change: the body also carries
       * the character's `next` attempt, which appears when a continuation
       * starts, and the trace windows, the last of which may still be settling.
       */
      const text = JSON.stringify(publicMode ? struckFor(projectTrack(body), [runId]) : body);
      const etag = `W/"${Bun.hash(text).toString(36)}"`;
      // `Vary` on the 304 too: it stands for a body that varied on it.
      const headers = { etag, "cache-control": "no-cache", vary: "Accept-Encoding" };
      if (ifNoneMatch(req, etag)) return new Response(null, { status: 304, headers });
      return new Response(text, { headers: { "content-type": "application/json; charset=utf-8", ...headers } });
    }

    if (rest === "/trace") {
      // The trace index: the closed windows and the tail so far. Never cached:
      // the tail moves with every drain.
      return pub(await traceIndex(runSession(runsDir, runId), Date.now()), projectTraceIndex, [runId]);
    }

    const traceMatch = /^\/trace\/(\d+)$/.exec(rest);
    if (traceMatch !== null) {
      const t0 = Number(traceMatch[1]);
      if (!Number.isSafeInteger(t0) || t0 % SEG_MS !== 0) return notFound("no such trace window");
      const found = await traceSegment(runSession(runsDir, runId), t0, Date.now());
      if (found === null) return notFound("no trace in that window");
      /*
       * A closed window is settled (`SETTLE_MS` past its end), so its segment
       * can never change and is cached as an immutable asset is; the window
       * still open or settling is served as it stands, uncached. Its chat
       * lines are the model's own text, so a public body is struck like the
       * run's other text (`publicText`).
       */
      const body = JSON.stringify(publicMode ? projectTraceSegment(found.segment) : found.segment);
      return new Response(publicMode ? publicText(body, [runId]) : body, {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": found.closed ? "public, max-age=31536000, immutable" : "no-store",
        },
      });
    }

    if (rest === "/nearby") {
      /*
       * The units around a live character, for the live map: the last `span`
       * ms of the run's ring (the inspector's `nearbyWindow`, at most its reach), one
       * window. Never cached — the ring moves every drain — and an empty
       * window, not a 404, for a run with none: no units is a state. In public
       * mode the window crosses `projectNearby`.
       */
      const spanParam = Number(url.searchParams.get("span") ?? NEARBY_SPAN_MS);
      const span = Number.isFinite(spanParam) ? spanParam : NEARBY_SPAN_MS;
      return pub(await nearbyWindow(runSession(runsDir, runId), span, Date.now()), projectNearby);
    }

    if (rest === "/entries") {
      await scan(runId, tail);
      const total = tail.entries.length;
      const limit = Math.min(WINDOW_MAX, Math.max(1, Number(url.searchParams.get("limit") ?? ENTRIES_WINDOW)));
      const fromParam = url.searchParams.get("from");
      // `at` is the timeline's jump to a time: the window that holds that moment (`entriesWindowAt`).
      const atParam = Number(url.searchParams.get("at") ?? Number.NaN);
      const from =
        fromParam !== null
          ? Math.max(0, Number(fromParam))
          : Number.isFinite(atParam)
            ? entriesWindowAt(tail.entries, atParam, limit)
            : Math.max(0, total - limit);
      const page = { from, total, entries: tail.entries.slice(from, from + limit) };
      // Public mode serves the same window the snapshot publishes: each entry
      // through the per-type allowlist and the game-prose redactor.
      return pub(page, projectEntries, [runId]);
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
    // It has no projector — it is text, not a body — so the path scrub every
    // projector applies is applied here by hand when the handle is public.
    if (rest === "/scratchpad") {
      const text = readScratchpad(runsDir, runId);
      if (text === null) return notFound("no scratchpad");
      return new Response(publicMode ? publicText(scrubPathsText(text), [runId]) : text, {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
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
      /*
       * The stream's own position in the shared tail. `scan` hands what it
       * newly read only to the caller that ran it, and every reader of this
       * run shares the one tail — a second tab, the run page's own detail
       * poll, `/entries`, `/track` — so forwarding `scan`'s return value lost
       * whatever another reader happened to read first. Each stream sends
       * `entries.slice(cursor)` instead, after any scan by anyone, and starts
       * over from the top when the tail was rebuilt under it (a truncated or
       * rotated file; `generation`).
       *
       * Where it starts is the client's to say. The run page loads its window
       * from `/entries` and only then opens this, so a stream starting at the
       * tail's end would drop whatever was written between the two; the page
       * passes `?from=` (the index of the first entry it does not hold — an
       * entry's `i`, which is its index in `entries`) and the stream sends
       * from there. Every frame that moves the cursor carries it as the SSE
       * `id`, so the browser's own reconnect sends it back as `Last-Event-ID`,
       * which wins over the URL's `from`: a reconnect resumes where the last
       * connection stopped, neither losing the gap nor replaying what it
       * already delivered. A start past the tail's end means the file was
       * rebuilt shorter since the client read it, so that starts over at 0,
       * as a rebuild under an open stream does. No start at all is the end.
       */
      const start = streamStart(req, url);
      let cursor = start === null ? tail.entries.length : start > tail.entries.length ? 0 : start;
      let gen = tail.generation;
      let timer: ReturnType<typeof setInterval> | undefined;
      let closed = false;
      // Pinned while open: eviction must never drop a tail a stream is reading,
      // or the stream would keep an orphan while `tailFor` built a second one.
      pin(runId, tail);
      const unpinOnce = (): void => {
        if (closed) return;
        closed = true;
        if (timer !== undefined) clearInterval(timer);
        unpin(runId);
      };
      const stream = new ReadableStream({
        start(controller) {
          const enc = new TextEncoder();
          // `id` only on the frames that move the cursor: a browser keeps the
          // last id it saw across frames that carry none.
          const send = (data: unknown, id?: number): void => {
            if (closed) return;
            try {
              const head = id === undefined ? "" : `id: ${id}\n`;
              controller.enqueue(enc.encode(`${head}data: ${JSON.stringify(data)}\n\n`));
            } catch {
              unpinOnce(); // the client went away between ticks
            }
          };
          /** Everything past the cursor, as one batch; false when there was nothing. */
          const flush = (): boolean => {
            if (tail.generation !== gen) {
              gen = tail.generation;
              cursor = 0;
            }
            if (cursor >= tail.entries.length) return false;
            const added = tail.entries.slice(cursor);
            cursor = tail.entries.length;
            // The token figure is the tail's memo: one derivation per batch
            // however many streams are open.
            send({ entries: added, tokens: tail.tokens }, cursor);
            return true;
          };
          send({ hello: runId, total: tail.entries.length }, cursor);
          // What was written before the stream opened, at once rather than on
          // the first tick.
          flush();
          timer = setInterval(() => {
            void scan(runId, tail)
              .then(() => {
                // A heartbeat keeps proxies and fetch timeouts from calling it dead.
                if (!flush()) send({ tick: Date.now() });
              })
              .catch(() => undefined);
          }, POLL_MS);
        },
        cancel() {
          unpinOnce();
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

  /**
   * The token profile a config draft's estimate is priced at (`drafts.ts`):
   * the scheduler's own counted-run facts, each run's harness off its row and
   * its tokens off the same totals the listing serves. Built only when the
   * operator's config page asks for its drafts.
   */
  async function e90Profile(): Promise<E90TokenProfileView | null> {
    const now = Date.now();
    const roster = fleetRoster();
    const [facts, rows, totals] = await Promise.all([runFacts(now), runRows(now), allTotals()]);
    const harness = new Map(rows.map((r) => [r.runId, r.harness]));
    return e90TokenProfile(
      facts.map((fact) => ({ fact, harness: harness.get(fact.runId) ?? null, tokens: totals.get(fact.runId)?.tokens ?? null })),
      roster.policy,
    );
  }

  async function route(req: Request): Promise<Response> {
    /*
     * Every request, on every path and every method, public handle or not, must
     * be addressed to a name this viewer answers to (`host-guard.ts`): what a
     * page that has re-pointed its own name at the viewer cannot fake. First,
     * so such a page learns nothing else about what is here.
     */
    if (allowedHosts !== null) {
      const misdirected = hostGuard(req, allowedHosts);
      if (misdirected !== null) return misdirected;
    }

    const url = new URL(req.url);
    const path = decodeURIComponent(url.pathname);

    /*
     * Every unsafe method, on every path, must come from the viewer's own pages
     * (`write-guard.ts`): JSON, from this host, not cross-site. On every handle
     * that is not public, admin switch or not: without the switch there is no
     * write route, and the guard still keeps a cross-site page from reaching
     * any route with a method the reads do not look at. A public handle has no
     * write route at all, and answers every one with the 404 below rather than
     * a refusal that would say one exists.
     */
    if (!publicMode) {
      const refused = writeGuard(req);
      if (refused !== null) return refused;
    }

    /*
     * Readiness: this process is up and serving. It reads nothing — no module,
     * no store, no runs directory — so a hung or unreachable worldserver, or a
     * slow store, never takes the viewer out of its Service (the chart's
     * probes; `/api/info` asks the module's /health and can wait two seconds
     * on it). In no group and on every handle, public mode included.
     */
    if (path === "/api/ready") return json({ ready: true });

    /*
     * The config API: read and edit the fleet config. Behind the admin switch
     * (`groups.ts`), which a public handle never has, so without it the routes
     * are not served at all — a 404, not the 403 `withheld()` gives, because a
     * write surface should not announce itself. It lives in `config-api.ts`;
     * this is the whole of its presence here.
     */
    if (admin && path.startsWith(CONFIG_API_PREFIX)) {
      const res = await handleConfigRequest(req, url, path, {
        ...(opts.configDbPath !== undefined ? { dbPath: opts.configDbPath } : {}),
        e90Profile,
      });
      // Anything but a read may have changed the roster: the next poll reads it afresh.
      if (req.method !== "GET" && req.method !== "HEAD") rosterHeld = undefined;
      if (res !== null) return res;
    }
    if (adminApi !== null) {
      const res = await adminApi(req, path);
      if (res !== null) return res;
    }

    /*
     * The inspector's own API over the runs (`@wrathbench/inspector`, through
     * `runs-source.ts`): the session record as written, but for its `id`,
     * which reads as the session's id there (the run id, or a fan-out
     * character's `<run-id>~<Character>`) and never as the token's
     * fingerprint; every stream and its tail. Raw records with no projected form, so a public
     * handle withholds it whole, like the raw lines and the run's tail.
     */
    if (path === INSPECTOR_BASE || path.startsWith(`${INSPECTOR_BASE}/`)) {
      if (publicMode) return withheld();
      return (await inspector(req)) ?? notFound("no such path");
    }

    if (path.startsWith("/api")) return (await api(req, url, path)) ?? notFound("no such path");

    if (path.startsWith("/tiles/")) {
      // The only Blizzard-derived bytes the viewer serves, so public mode
      // withholds them unless the operator has explicitly opted this
      // deployment in.
      const asPublic = publicMode && tilesPublic;
      if (publicMode && !asPublic) return withheld();
      // A map's tile index revalidates like the art: a transcode rewrites it
      // in place. Missing or stale, it is a 404 and the page asks for every
      // cell instead (`tiles.ts`).
      const index = resolveTileIndex(tilesDir, path);
      if (index !== null) {
        const v = tileValidators(statSync(index));
        const headers = {
          "cache-control": asPublic ? ART_TILE_PUBLIC_CACHE_CONTROL : ART_TILE_CACHE_CONTROL,
          etag: v.etag,
          "last-modified": v.lastModified,
          ...(asPublic ? { "x-robots-tag": TILE_PUBLIC_ROBOTS } : {}),
        };
        if (tileNotModified(req.headers, v)) return new Response(null, { status: 304, headers });
        return new Response(Bun.file(index), { headers: { "content-type": "application/json", ...headers } });
      }
      const hit = resolveTile(tilesDir, path);
      // A tile that was never extracted is a 404 the client expects and draws
      // around; it is not an error worth a body. A miss is never cached: the
      // extraction may write that tile a minute from now.
      if (hit === null) {
        return new Response("no such tile", {
          status: 404,
          ...(asPublic ? { headers: { "x-robots-tag": TILE_PUBLIC_ROBOTS } } : {}),
        });
      }
      const robots: Record<string, string> = asPublic ? { "x-robots-tag": TILE_PUBLIC_ROBOTS } : {};
      // The art is re-baked in place, so it revalidates (`tiles.ts`); every
      // other tile is immutable and needs no validator.
      if (isRevalidatedTile(hit.ref)) {
        const v = tileValidators(statSync(hit.file));
        const headers = {
          "cache-control": asPublic ? ART_TILE_PUBLIC_CACHE_CONTROL : ART_TILE_CACHE_CONTROL,
          etag: v.etag,
          "last-modified": v.lastModified,
          ...robots,
        };
        if (tileNotModified(req.headers, v)) return new Response(null, { status: 304, headers });
        return new Response(Bun.file(hit.file), { headers: { "content-type": hit.contentType, ...headers } });
      }
      return new Response(Bun.file(hit.file), {
        headers: {
          "content-type": hit.contentType,
          "cache-control": asPublic ? TILE_PUBLIC_CACHE_CONTROL : TILE_CACHE_CONTROL,
          ...robots,
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
  }

  return Object.assign(
    async function handle(req: Request): Promise<Response> {
      evictTails();
      /*
       * Every JSON body leaves through the one encoder (`compress.ts`), so no
       * route has to remember it, and nothing that is not JSON — the SSE tail
       * above all — is ever read or buffered by it.
       */
      return await compressResponse(req, await route(req));
    },
    { release, cachedRuns, unpublishedRuns },
  );
}

/**
 * A results row as a deployment without the evals group serves it
 * (`groups.ts`): without the comparison condition the ladder groups rows by,
 * which only the evals group reads (`ResultRun.condition`, `ResultRun.wiki`,
 * both optional, absent is "not answered"). The run's own stamps stay: its
 * episode and why it cannot be scored are what it recorded, and a null
 * `unscored` would read as "scored", which nothing here has decided.
 */
export function withoutEvalFields(r: ResultRun): ResultRun {
  const { condition: _condition, wiki: _wiki, ...rest } = r;
  return rest;
}

/** Whether a run row is one a public handle withholds: its driver, or its stamp, says it is not a model's. */
function isWithheldRow(r: Pick<RunRow, "driver" | "shakeout">): boolean {
  return isNotAModelRun({ driver: r.driver, unscored: r.shakeout });
}

/**
 * Where a `/stream` starts, as the client asked: the browser's `Last-Event-ID`
 * on a reconnect (the cursor the last connection's frames carried), else the
 * URL's `from`. Null when neither is a non-negative integer, which starts the
 * stream at the tail's end.
 */
export function streamStart(req: Request, url: URL): number | null {
  for (const raw of [req.headers.get("last-event-id"), url.searchParams.get("from")]) {
    if (raw === null || !/^\d+$/.test(raw.trim())) continue;
    const n = Number(raw.trim());
    if (Number.isSafeInteger(n)) return n;
  }
  return null;
}
