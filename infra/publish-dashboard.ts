#!/usr/bin/env bun
/**
 * Publish the public dashboard snapshot to the R2 bucket.
 *
 * The wiring and nothing else: `renderSnapshot` (runner/viewer/snapshot.ts)
 * makes the artifacts, `publishLoop` (infra/publish-core.ts) decides what to
 * PUT and in what order, and this file turns env and flags into those two
 * calls. Everything testable lives in those modules; this one is exercised by
 * running it.
 *
 *   bun infra/publish-dashboard.ts --once   # one pass, then exit (backfill, smoke)
 *   bun infra/publish-dashboard.ts --loop   # a pass every interval (the service)
 *
 * Env, matching the compose `publisher` service and docs/OPERATIONS.md
 * ("Public dashboard"):
 *   WRATHBENCH_RUNS_DIR             default data/runs
 *   WRATHBENCH_FLEET_CONFIG         default infra/fleet.json when it exists
 *   WRATHBENCH_PUBLISH_STATE        default data/publish/state.json
 *   WRATHBENCH_PUBLISH_INTERVAL_MS  default 60000
 *   WRATHBENCH_MODULE_URL           optional; names the worldserver build on info.json
 *   S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_BUCKET, S3_ENDPOINT
 *                                   Bun.S3Client's own names, autoloaded from .env
 *
 * Cache-control: the artifact contract carries a per-object header, but Bun's
 * S3 writer cannot send Cache-Control (S3Options has `type` and encodings
 * only, as of 1.4), so objects land without it and the Cloudflare cache rule
 * sets edge and browser TTLs by path instead — 30s on `/v1/manifest.json` and
 * `/v1/live.json`, long on `/v1/snap/*` and `/v1/run/*`. The runbook's rule
 * is therefore load-bearing for freshness as well as for cost.
 */

import { existsSync } from "node:fs";
import { S3Client } from "bun";
import { createRenderer } from "../runner/viewer/snapshot";
import { publishLoop, type ObjectStore, type SnapshotResult } from "./publish-core";

const RUNS_DIR = Bun.env.WRATHBENCH_RUNS_DIR ?? "data/runs";
const FLEET_CONFIG =
  Bun.env.WRATHBENCH_FLEET_CONFIG ?? (existsSync("infra/fleet.json") ? "infra/fleet.json" : undefined);
const STATE_PATH = Bun.env.WRATHBENCH_PUBLISH_STATE ?? "data/publish/state.json";
const INTERVAL_MS = Number(Bun.env.WRATHBENCH_PUBLISH_INTERVAL_MS ?? "60000");
const MODULE_URL = Bun.env.WRATHBENCH_MODULE_URL;

function fail(message: string): never {
  console.error(`publish-dashboard: ${message}`);
  process.exit(1);
}

const mode = ((): "once" | "loop" => {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--once") return "once";
  if (args.length === 1 && args[0] === "--loop") return "loop";
  fail("usage: bun infra/publish-dashboard.ts --once | --loop (env: docs/OPERATIONS.md, Public dashboard)");
})();

if (!existsSync(RUNS_DIR)) fail(`runs directory ${RUNS_DIR} does not exist`);
if (!Number.isFinite(INTERVAL_MS) || INTERVAL_MS < 1000) {
  fail(`WRATHBENCH_PUBLISH_INTERVAL_MS=${Bun.env.WRATHBENCH_PUBLISH_INTERVAL_MS} is not a sane interval`);
}
// S3Client also honours AWS_*-style names; this check covers the documented
// contract, so a half-filled .env fails here with the runbook's names rather
// than mid-pass with the SDK's.
for (const name of ["S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_BUCKET", "S3_ENDPOINT"] as const) {
  if ((Bun.env[name] ?? "") === "" && (Bun.env[name.replace("S3_", "AWS_")] ?? "") === "") {
    fail(`${name} is not set (docs/OPERATIONS.md, "Public dashboard" — the R2 key pair lives in .env)`);
  }
}

const s3 = new S3Client();
const store: ObjectStore = {
  put: async (path, body, opts) => {
    await s3.write(path, body, { type: opts.contentType });
  },
  delete: async (path) => {
    await s3.delete(path);
  },
};

// One renderer for the process, not one per pass: the viewer handle inside it
// holds the trajectory mtime caches, so a finished run is read once and a live
// one only as it grows.
const render: () => Promise<SnapshotResult> = createRenderer({
  runsDir: RUNS_DIR,
  ...(FLEET_CONFIG !== undefined ? { fleetConfigPath: FLEET_CONFIG } : {}),
  ...(MODULE_URL !== undefined ? { moduleUrl: MODULE_URL } : {}),
});

const abort = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.error(`publish-dashboard: ${signal}, finishing the pass in flight`);
    abort.abort();
  });
}

const log = (line: string): void => console.log(`${new Date().toISOString()} ${line}`);
log(`publishing ${RUNS_DIR} -> ${Bun.env.S3_BUCKET ?? Bun.env.AWS_BUCKET} (${mode}, every ${INTERVAL_MS}ms)`);

const summary = await publishLoop(render, store, STATE_PATH, {
  intervalMs: INTERVAL_MS,
  once: mode === "once",
  signal: abort.signal,
  log,
});
log(`done: ${summary.passes} passes, ${summary.published} published, ${summary.failed} failed`);
process.exit(summary.passes > 0 && summary.failed === summary.passes ? 1 : 0);
