#!/usr/bin/env bun
/**
 * The hosted gateway as this deployment runs it (chart: `hosted.gateway`):
 * wrath-mcp's gateway with a worker per pod (`pod-workers.ts`) in place of a
 * process per credential.
 *
 * Before it serves, it makes the grants file stand: created empty if there is
 * none, so a fresh deployment starts and `bun wb tenants add` has a file to
 * write, and holding every account in `WRATHBENCH_HOSTED_RESERVED` (the
 * freeplay world's allowlist without the tenants, which the chart renders)
 * in `reservedAccounts`, so no grant can ever name an account the operator's
 * own sessions lease there. A grants file that already names one of them is
 * refused, and the gateway does not start.
 *
 *   bun infra/hosted/gateway.ts --grants <file> --state <dir> [wrath-mcp gateway flags]
 */

import { existsSync } from "node:fs";
import { gatewayMain, parseGatewayArgs } from "@wrathbench/mcp/hosted/gateway";
import { emptyGrantsFile, readGrantsFile, writeGrantsFile } from "@wrathbench/mcp/hosted/grants";
import { K8sClient } from "../k8s-client";
import { PodWorkers, readWorkerTemplate } from "./pod-workers";

/** The accounts the chart reserves, comma-separated. */
export const RESERVED_ENV = "WRATHBENCH_HOSTED_RESERVED";

/**
 * The grants file at `path`, created if absent, with every account in
 * `reserved` among its `reservedAccounts`. Returns the accounts it added.
 * Throws when the file does not stand with them (a grant names one).
 */
export function ensureGrantsFile(path: string, reserved: readonly string[]): string[] {
  const file = existsSync(path) ? readGrantsFile(path) : emptyGrantsFile();
  const have = new Set(file.reservedAccounts.map((a) => a.toUpperCase()));
  const added = reserved.filter((a) => a.length > 0 && !have.has(a.toUpperCase()));
  if (added.length > 0 || !existsSync(path)) writeGrantsFile(path, { ...file, reservedAccounts: [...file.reservedAccounts, ...added] });
  return added;
}

export const reservedFromEnv = (env: Record<string, string | undefined> = process.env): string[] =>
  (env[RESERVED_ENV] ?? "").split(",").map((a) => a.trim()).filter((a) => a.length > 0);

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const log = (line: string): void => console.error(`[wrathbench hosted] ${line}`);
  try {
    const args = parseGatewayArgs(argv);
    const added = ensureGrantsFile(args.grants, reservedFromEnv());
    if (added.length > 0) log(`reserved ${added.length} account(s) for the operator's own sessions: ${added.join(",")}`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }
  const client = K8sClient.inCluster();
  if (client === null) {
    console.error("the hosted gateway starts its workers as pods and needs the in-cluster API (a ServiceAccount token); off the cluster, run wrath-mcp's own gateway, whose workers are local processes");
    process.exit(2);
  }
  const workers = new PodWorkers({ client, template: readWorkerTemplate(), log });
  await workers.reapStale();
  await gatewayMain(argv, { workers });
}
