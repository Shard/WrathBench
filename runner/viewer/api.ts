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

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type {
  ApiInfoResponse,
  EntrySummary,
  FleetLane,
  FleetResponse,
  RunListRow,
} from "./api-types";
import { MAP_PAGE } from "./map-page";
import { PAGE } from "./page";
import { readPositions } from "./positions";
import { listRuns, readRun, readScratchpad, readStates, runDir } from "./runs";
import { TILE_CACHE_CONTROL, resolveTilePath } from "./tiles";
import { TrajectoryTail, scanRunTotals, tokenTotals, type RunTotals } from "./tail";

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
   * defaulting them off would break the pages this viewer still serves.
   */
  publicMode?: boolean;
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function page(body: string): Response {
  return new Response(body, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
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
  "The dashboard has not been built. Run `bun install && bun run --cwd dashboard build`, " +
  "or use the legacy pages at /legacy/ and /legacy/map.";

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
    const lanes = Object.entries(raw.lanes ?? {}).map(([name, lane]) => ({ name, ...lane }));
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
      return json({
        run: readRun(runsDir, runId),
        states: readStates(runsDir, runId),
        total: tail.entries.length,
        tokens: tokenTotals(tail.entries),
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

    // The hand-written pages the SPA replaces. They keep working at /legacy
    // until the follow-up deletes them.
    if (path === "/legacy" || path === "/legacy/" || path.startsWith("/legacy/run/")) return page(PAGE);
    if (path === "/legacy/map") return page(MAP_PAGE);

    if (dashboardDir !== undefined) {
      const hit = staticFile(dashboardDir, path.slice(1));
      if (hit !== null) return hit;
      // Client-side routing: anything not a file is the SPA's own concern.
      return dashboardIndex();
    }

    // No build on disk. Serve the legacy pages rather than a 503, so a plain
    // `bun runner/viewer/serve.ts` on a fresh checkout still shows runs.
    if (path === "/" || path.startsWith("/run/")) return page(PAGE);
    if (path === "/map") return page(MAP_PAGE);
    return notFound("no such path");
  };
}
