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
import { basename, join } from "node:path";
import type {
  ApiInfoResponse,
  EntrySummary,
  FleetLane,
  FleetLaneRun,
  FleetLaneView,
  FleetResponse,
  RunListRow,
} from "./api-types";
import { readPositions } from "./positions";
import { isValidRunId, listRuns, readRun, readScratchpad, readStates, runDir } from "./runs";
import { TILE_CACHE_CONTROL, resolveTilePath } from "./tiles";
import {
  SEGMENT_MARKS,
  TrajectoryTail,
  playtimeMs,
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
 * `LIVE_WINDOW_MS` (120s): the lane's run has to be resolved the same way the
 * account guard and `--status` resolve it, or the dashboard would disagree with
 * the supervisor about which run a lane holds near the boundary. The constant
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
 * session back, so it holds nothing — the lane reads as idle, not as driving a
 * run it has finished with.
 *
 * The map is keyed on account, not on lane: a hand-started run, or a previous
 * cycle that has not gone cold, holds the account just as hard as a fleet one
 * and will show under the lane that shares it. That is the honest reading of
 * "what has this account" — `--status` says the same, adding only that the
 * holder is "not fleet-managed" when the lane's own process is gone.
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
      .filter((d) => d.isDirectory() && isValidRunId(d.name))
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

/**
 * The models a lane's roster will work through, in order.
 *
 * Only the model names are projected: the roster entries also carry api bases,
 * key environment names and accounts, and the boundary rule is to project what
 * the UI needs rather than forward a file. The stored `rosterPath` is
 * repo-relative and written by a supervisor that may live in another container,
 * so only its basename is trusted and it is resolved inside the runs directory.
 */
export function rosterModels(runsDir: string, rosterPath: string): string[] {
  if (typeof rosterPath !== "string" || rosterPath.length === 0) return [];
  const file = join(runsDir, basename(rosterPath));
  if (!existsSync(file)) return [];
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { model?: unknown }[];
    if (!Array.isArray(raw)) return [];
    return raw
      .map((e) => (e !== null && typeof e === "object" && typeof e.model === "string" ? e.model : null))
      .filter((m): m is string => m !== null);
  } catch {
    return [];
  }
}

/** Read the fleet supervisor's published state. Absent is normal, not an error. */
export function readFleet(runsDir: string, now = Date.now()): FleetResponse {
  const path = join(runsDir, "fleet-state.json");
  if (!existsSync(path)) return { present: false, lanes: [], now };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as {
      fleetPid?: number;
      startedAt?: number;
      heartbeatAt?: number;
      containerized?: boolean;
      stamp?: string;
      lanes?: Record<string, FleetLane>;
    };
    const held = heldAccounts(runsDir, now);
    const lanes: FleetLaneView[] = Object.entries(raw.lanes ?? {}).map(([name, lane]) => {
      const run = held.get((lane.account ?? "RUNNER").toUpperCase());
      const resolved: FleetLaneRun = {
        runId: run?.runId ?? null,
        model: run?.model ?? null,
        rosterModels: rosterModels(runsDir, lane.rosterPath),
      };
      return { name, ...lane, ...resolved };
    });
    lanes.sort((a, b) => a.name.localeCompare(b.name));
    // `fleetConfig` is deliberately not forwarded: it is a host path, and the
    // API says what the fleet is doing, not where this machine keeps things.
    return {
      present: true,
      fleetPid: raw.fleetPid,
      startedAt: raw.startedAt,
      heartbeatAt: raw.heartbeatAt,
      containerized: raw.containerized,
      stamp: raw.stamp,
      lanes,
      now,
    };
  } catch {
    return { present: false, lanes: [], now };
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

  async function listWithTotals(): Promise<RunListRow[]> {
    const out: RunListRow[] = [];
    for (const row of listRuns(runsDir)) {
      const dir = runDir(runsDir, row.runId);
      const totals = dir === null ? null : await runTotals(row.runId, dir);
      out.push({
        ...row,
        tokens: totals?.tokens ?? null,
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
    if (path === "/api/runs") return json({ runs: await listWithTotals() });
    if (path === "/api/positions") return json({ positions: readPositions(runsDir) });
    if (path === "/api/fleet") return json(readFleet(runsDir));

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
      return json({
        run,
        states: readStates(runsDir, runId),
        total: entries.length,
        tokens: tokenTotals(entries),
        playtimeMs: playtimeMs(segmentsFrom(marks), { lastTs, live: run.live, now: Date.now() }),
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
