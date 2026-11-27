/**
 * The viewer's read-only HTTP surface, as a handler you can call directly.
 *
 * Split out of `serve.ts` so the routes can be tested without binding a port,
 * and so the boundary is one handler an auditor can read end to end: this
 * file and the route modules it mounts (`api-results.ts`, `api-run.ts`, and
 * with their groups on `api-fleet.ts` and `api-evals.ts`, over `api-tails.ts`
 * and `api-context.ts`). Two rules hold everywhere below:
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
import { json, notFound, withheld } from "./http";
import type { SiteSettings } from "../src/site-settings";
import { siteInfoField } from "./site-info";
import { moduleAuthHeaders } from "@wrathbench/mcp/module-auth";
import { HARNESSES, isNotAModelRun } from "../src/config";
import type {
  ClipsResponse,
  HighlightResponse,
  ApiInfoResponse,
  CostFigure,
  E90TokenProfileView,
  ResultRun,
  CharacterResponse,
  CharacterStatePoint,
  HarnessView,
  RunListRow,
  RunRow,
  RunsResponse,
  StateItemsRow,
  StatePoint,
  TokenTotals,
} from "./api-types";
import { resultRunOf } from "./results";
import { readFleetRoster } from "./models";
import type { RunFact } from "../src/models";
import { positionsFromStore } from "./positions";
import { runCost } from "./pricing";
import { characterViewOf } from "./character";
import {
  projectCharacterResponse,
  projectInfo,
  projectPositions,
  projectHighlight,
  projectRuns,
} from "./public-projection";
import { strikableSessionToken, strikeSessionTokens } from "../src/session-token";
import { closedWindowsMemo, createInspectorApi } from "@wrathbench/inspector";
import { fanoutSessions, isFanoutRun, isWithheldFanoutRun, runSession, runsSource } from "./runs-source";
import { attachSessionStore, isBareSessionId } from "../src/session-store";
import { fanoutLead, fanoutReadings } from "../src/run-reader";
import { clipsView, pickHighlight } from "./camera";
import { readStateItems, readStates } from "./runs";
import { isValidRunId, LIVE_WINDOW_MS, readRun, runDir } from "../src/run-list";
import {
  factOf,
  runRowOf,
  statePointOf,
  storeFor,
  totalsOf,
  withFanoutLeads,
  type RunStore,
} from "./clickhouse";
import { compressResponse } from "./compress";
import { hostAllowlist, hostGuard } from "./host-guard";
import { writeGuard } from "./write-guard";
import { ADMIN_API_PREFIX, ALL_GROUPS, allGroupsOn, CONFIG_API_PREFIX, groupOfApiPath, type Groups } from "./groups";
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
import { playtimeMs, recordSegments } from "../src/sessions";
import { RunTotalsScanner, type RunTotals } from "../src/run-totals";
import type { ApiContext } from "./api-context";
import { sharedStore, STORE_SHARE_MS } from "./shared-store";
import { createTailCache } from "./api-tails";
import { createResultsApi } from "./api-results";
import { createRunApi } from "./api-run";

/*
 * The store's shared reads (`shared-store.ts`), re-exported here unchanged. The
 * fleet readers are `api-fleet.ts`'s and are imported from there: a static
 * re-export here would load the runner group's module into every handle.
 */
export { sharedStore, STORE_SHARE_MS } from "./shared-store";
/* The tail cache moved to `api-tails.ts`; its bounds are re-exported here unchanged. */
export { TAIL_CACHE_BYTES, TAIL_IDLE_MS } from "./api-tails";
/* The results builder is `api-results.ts`; its eval-field strip is re-exported here unchanged. */
export { withoutEvalFields } from "./api-results";
/* The run routes moved to `api-run.ts`; their constants and helpers are re-exported here unchanged. */
export { entriesWindowAt, POLL_MS, streamStart, TRACK_MEMO_RUNS, TRACK_SETTLE_MS, WINDOW_MAX } from "./api-run";

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

/** Where the inspector's API is mounted on a private handle. */
export const INSPECTOR_BASE = "/api/inspector";

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
  /*
   * The admin switch's two surfaces, the config API (`config-api.ts`) and the
   * admin pages' status beside the config they edit (`admin-api.ts`). Imported
   * only with the switch on, so a handle without it never loads the write
   * surface, the credential store or the codex login behind them.
   */
  const configApi = admin ? import("./config-api") : null;
  const adminApi = admin
    ? import("./admin-api").then((m) =>
        m.createAdminApi({ groups, runsDir, ...(opts.configDbPath !== undefined ? { dbPath: opts.configDbPath } : {}) }),
      )
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
  // The home page's clip, on a short window: it reads every listed run's camera directory.
  let highlightCache: { at: number; value: HighlightResponse } | undefined;
  const worldserver = worldserverIdentity(opts.moduleUrl ?? "http://127.0.0.1:8086");

  /** Each run's closed trace windows, for its track (see `release` for why it is never dropped). */
  const closedWindows = closedWindowsMemo();
  const inspector = createInspectorApi(runsSource(runsDir), { base: INSPECTOR_BASE });
  /** A run's closed trace windows, memoised per run (`closedWindowsMemo`). */
  const traceSegs = (runId: string, now: number) => closedWindows(`${runsDir}\0${runId}`, runSession(runsDir, runId), now);

  /** The runs' tails and settled track cores, and forgetting them (`api-tails.ts`). */
  const tails = createTailCache();
  const { evictTails, release, cachedRuns } = tails;

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
    resultRuns,
    allResultRuns,
    struckFor,
    publicText,
    tails,
    runRowAndLead,
    statesOfRun,
    stateItemsOfRun,
    withheldRun,
    closedWindows,
    traceSegs,
  };
  /*
   * A group that is off is absent (`groups.ts`): its route module is never
   * imported, so neither it nor what it reaches is loaded into this process.
   * One that is on is imported as the handle is built and awaited by the
   * first request that asks for it. The runner group's is `api-fleet.ts`, the
   * evals group's `api-evals.ts`.
   */
  const fleetApi = groups.runner ? import("./api-fleet").then((m) => m.createFleetApi(ctx)) : null;
  const evalsApi = groups.evals ? import("./api-evals").then((m) => m.createEvalsApi(ctx)) : null;
  /*
   * The results builder (`api-results.ts`), built whatever the groups say:
   * `/api/results` is the viewer's and shares its builder with the ladder. The
   * group gate at the top of `api` is what keeps `/api/ladder` absent.
   */
  const { resultsResponse } = createResultsApi(ctx);
  // A run's own routes, the viewer group's.
  const runRoute = createRunApi(ctx);

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
        // The evals group's (`api-evals.ts`): with it off the dashboard draws no series selector.
        ...(evalsApi !== null ? { harnessSeries: await (await evalsApi).seriesCensus() } : {}),
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
    // The evals group's routes (`api-evals.ts`); with the group off the gate above has answered.
    if (evalsApi !== null) {
      if (path === "/api/episodes") return await (await evalsApi).episodesResponse();
      if (path === "/api/campaigns") return await (await evalsApi).campaignsResponse();
      if (path === "/api/dungeons") return await (await evalsApi).dungeonsResponse();
    }
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
    const runner = fleetApi === null ? null : await (await fleetApi)(url, path);
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

    // A run's own routes (`api-run.ts`): `/api/run/<id>` and everything under it.
    return await runRoute(req, url, path);
  }

  /**
   * The token profile a config draft's estimate is priced at (`drafts.ts`):
   * the scheduler's own counted-run facts, each run's harness off its row and
   * its tokens off the same totals the listing serves. Built only when the
   * operator's config page asks for its drafts, so `drafts.ts` is imported
   * here and nowhere else in this file.
   */
  async function e90Profile(): Promise<E90TokenProfileView | null> {
    const { e90TokenProfile } = await import("./drafts");
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
    if (configApi !== null && path.startsWith(CONFIG_API_PREFIX)) {
      const { handleConfigRequest } = await configApi;
      const res = await handleConfigRequest(req, url, path, {
        ...(opts.configDbPath !== undefined ? { dbPath: opts.configDbPath } : {}),
        e90Profile,
      });
      // Anything but a read may have changed the roster: the next poll reads it afresh.
      if (req.method !== "GET" && req.method !== "HEAD") rosterHeld = undefined;
      if (res !== null) return res;
    }
    // It answers its own prefix and nothing else, so no other path waits on its import.
    if (adminApi !== null && path.startsWith(ADMIN_API_PREFIX)) {
      const res = await (await adminApi)(req, path);
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

/** Whether a run row is one a public handle withholds: its driver, or its stamp, says it is not a model's. */
function isWithheldRow(r: Pick<RunRow, "driver" | "shakeout">): boolean {
  return isNotAModelRun({ driver: r.driver, unscored: r.shakeout });
}
