#!/usr/bin/env bun
/**
 * A hosted credential's worker pod's entry (chart: the `hosted.gateway`
 * worker template): wrath-mcp's worker, which holds the lease secrets its
 * gateway hands it and never the port secret.
 *
 *   WRATH_MCP_WORKER_SECRET=<secret> bun infra/hosted/worker.ts --host 0.0.0.0 --port 8097 [--hello-wait-ms <ms>]
 */

import { workerMain } from "@wrathbench/mcp/hosted/worker";

await workerMain(process.argv.slice(2));
