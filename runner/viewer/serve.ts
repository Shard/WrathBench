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

import { existsSync } from "node:fs";
import { join } from "node:path";
import { createApi, json } from "./api";

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
 * The built SPA, and since ADR-0022 the only UI there is. Its absence is not a
 * startup failure: the API keeps serving, and every page route answers with the
 * notice that says how to build it.
 */
const dashboardDir = process.env["WRATHBENCH_DASHBOARD_DIR"] ?? "dashboard/dist";
const publicMode = process.env["WRATHBENCH_VIEWER_PUBLIC"] === "1";
/** Module /health for the worldserver build on /api/info; unreachable is fine (null). */
const moduleUrl = process.env["WRATHBENCH_MODULE_URL"] ?? "http://127.0.0.1:8086";
/*
 * The fleet config `/api/models` reads its roster from (ADR-0031). The staged
 * pool/queue file is preferred while it exists, because it is the one that
 * carries a `roster` map; after the operator renames it over `fleet.json` the
 * same lookup finds the same content under the live name. Neither present, or
 * a config that predates the roster map, is a labelled empty state on the page
 * rather than a startup failure — the viewer runs on machines that have no
 * fleet at all.
 */
const fleetConfigPath =
  process.env["WRATHBENCH_FLEET_CONFIG"] ??
  ["infra/fleet.next.json", "infra/fleet.json"].find((p) => existsSync(p));

if (!existsSync(runsDir)) {
  console.error(`no runs directory at ${runsDir} — run from the repo root, or set WRATHBENCH_RUNS_DIR.`);
  process.exit(1);
}

const built = existsSync(join(dashboardDir, "index.html"));
const handle = createApi({
  runsDir,
  tilesDir,
  dashboardDir: built ? dashboardDir : undefined,
  publicMode,
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
  `wrathbench viewer: http://${host}:${server.port}  (runs: ${runsDir})` +
    (built ? "" : "  [dashboard not built — run `bun run --cwd dashboard build`]") +
    (publicMode ? "  [public mode: raw, scratchpads and tiles withheld]" : ""),
);
