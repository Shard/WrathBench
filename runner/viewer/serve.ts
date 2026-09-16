#!/usr/bin/env bun
/**
 * Operator-facing viewer for run trajectories, live and past.
 *
 *   bun runner/viewer/serve.ts            # from the repo root, on the host
 *
 * This file is only the bind: environment in, `createApi` out. The routes and
 * everything they are allowed to serve live in `api.ts`.
 *
 * Loopback by default. Trajectory content carries game-derived text; the
 * DATA-AND-LEGAL.md posture is no public endpoint and no distribution, so a
 * non-loopback bind is a startup failure unless the operator explicitly opts
 * a trusted private network in with WRATHBENCH_VIEWER_LAN=1. The module stays
 * loopback regardless — LAN viewers can read pages, not reach the server.
 *
 * Everything here reads. The runs directory is never written to, and each
 * run.sqlite is opened readonly so a live writer is untouched.
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createApi, json } from "./api";
import { clickhouseConfigFromEnv } from "./clickhouse";

const REQUIRED_HOST = "127.0.0.1";
const lanOptIn = process.env["WRATHBENCH_VIEWER_LAN"] === "1";
const host = process.env["WRATHBENCH_VIEWER_HOST"] ?? (lanOptIn ? "0.0.0.0" : REQUIRED_HOST);
if (host !== REQUIRED_HOST && !lanOptIn) {
  console.error(
    `refusing to start: WRATHBENCH_VIEWER_HOST=${host}. The viewer serves game-derived ` +
      `trajectory text and binds ${REQUIRED_HOST} unless WRATHBENCH_VIEWER_LAN=1 ` +
      `explicitly opts a trusted private network in (docs/DATA-AND-LEGAL.md).`,
  );
  process.exit(1);
}

const port = Number(process.env["WRATHBENCH_VIEWER_PORT"] ?? 8090);
const runsDir = process.env["WRATHBENCH_RUNS_DIR"] ?? "data/runs";
/*
 * Minimap tiles, written by the extraction in `minimap/`. Its absence is a
 * normal state, not a startup failure: the map draws a labelled grid where a
 * tile is missing, so it works on a machine that has never run the extraction.
 */
const tilesDir = process.env["WRATHBENCH_MINIMAP_DIR"] ?? "data/minimap";
/*
 * The built SPA, and the only UI there is. Its absence is not a
 * startup failure: the API keeps serving, and every page route answers with the
 * notice that says how to build it.
 */
const dashboardDir = process.env["WRATHBENCH_DASHBOARD_DIR"] ?? "dashboard/dist";
/*
 * The derived store (docs/ARCHITECTURE.md, "The derived store"). Configured,
 * the viewer answers every listing route from ClickHouse; unconfigured, it
 * builds the same rows in memory from the runs directory with the collector's
 * own code, which is what a laptop and a bare clone get. The choice is printed
 * at startup, because "why is this slow" and "why is this empty" have
 * different answers on the two.
 */
const clickhouse = clickhouseConfigFromEnv();
const publicMode = process.env["WRATHBENCH_VIEWER_PUBLIC"] === "1";
/*
 * Public mode withholds minimap tiles, the only Blizzard-derived bytes the
 * viewer serves. This opts one deployment back in — off by default, and a
 * no-op without WRATHBENCH_VIEWER_PUBLIC=1, since a private viewer serves
 * tiles anyway. It reaches the live viewer only: the static public snapshot
 * contains no tile whatever this says.
 */
const tilesPublic = process.env["WRATHBENCH_VIEWER_TILES_PUBLIC"] === "1";
/** Module /health for the worldserver build on /api/info; unreachable is fine (null). */
const moduleUrl = process.env["WRATHBENCH_MODULE_URL"] ?? "http://127.0.0.1:8086";
/*
 * The fleet config `/api/models` reads its roster from. Absent, or
 * a config that predates the roster map, is a labelled empty state on the page
 * rather than a startup failure — the viewer runs on machines that have no
 * fleet at all. (Until the 0.5 rename this preferred a staged
 * `fleet.next.json` sibling, mirroring the supervisor; the shim left with the
 * rename, 2026-08-24.)
 */
const fleetConfigPath = ((): string | undefined => {
  const given = process.env["WRATHBENCH_FLEET_CONFIG"];
  return given ?? (existsSync("infra/fleet.json") ? "infra/fleet.json" : undefined);
})();

/*
 * An absent runs directory is a bare clone, not a startup failure — the same
 * posture as the tiles, the SPA and the fleet config above: the viewer only
 * ever lists and reads it, so an empty one serves labelled empty states.
 */
if (!existsSync(runsDir)) mkdirSync(runsDir, { recursive: true });

const built = existsSync(join(dashboardDir, "index.html"));
const handle = createApi({
  runsDir,
  tilesDir,
  dashboardDir: built ? dashboardDir : undefined,
  publicMode,
  tilesPublic,
  moduleUrl,
  fleetConfigPath,
});

const server = Bun.serve({
  hostname: host,
  port,
  idleTimeout: 0,
  fetch: (req) =>
    handle(req).catch((err: unknown) =>
      json({ error: err instanceof Error ? err.message : String(err) }, 500),
    ),
});

console.log(
  `wrathbench viewer: http://${host}:${server.port}  (runs: ${runsDir}, store: ${clickhouse === null ? "local (no CLICKHOUSE_URL)" : clickhouse.url})` +
    (built ? "" : "  [dashboard not built — run `bun run --cwd dashboard build`]") +
    (publicMode
      ? tilesPublic
        ? "  [public mode: raw and scratchpads withheld; tiles served]"
        : "  [public mode: raw, scratchpads and tiles withheld]"
      : ""),
);
