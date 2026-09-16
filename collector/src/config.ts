/**
 * Everything the collector is told, and nothing it decides for itself.
 *
 * Config is environment only: the collector runs as a service in compose and
 * as a Deployment in the chart, and both of those hand a process env vars.
 * There is no config file, because there is nothing here an operator would
 * want to version separately from the deployment that sets it.
 */

export interface CollectorConfig {
  /** Base URL of ClickHouse's HTTP interface, no trailing slash. */
  url: string;
  user: string;
  password: string;
  /** The database every table lives in. Must match `schema.sql`. */
  database: string;
  /** The runs tree: `<data>/runs`. The collector only ever reads it. */
  dataDir: string;
  runsDir: string;
  /** The collector's own sqlite: per-file offsets, so a restart resumes. */
  stateDb: string;
  /** How long between polls of the runs tree. */
  pollMs: number;
  /** Flush a table's batch at this many rows... */
  batchRows: number;
  /** ...or this many bytes of JSON, whichever trips first. */
  batchBytes: number;
}

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v.length === 0 ? fallback : v;
}

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v.length === 0) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Batch limits, and why both exist.
 *
 * A trajectory's largest lines are megabytes on their own — the rendered
 * context re-logged every turn is ~75% of the corpus's bytes — so a row count
 * alone would let one batch grow to hundreds of MB and a byte cap alone would
 * make a batch of small `state` lines pointlessly chatty. Whichever trips
 * first wins.
 */
export const DEFAULT_BATCH_ROWS = 2_000;
export const DEFAULT_BATCH_BYTES = 8 * 1024 * 1024;
export const DEFAULT_POLL_MS = 5_000;

export function readConfig(overrides: Partial<CollectorConfig> = {}): CollectorConfig {
  const dataDir = overrides.dataDir ?? env("WRATHBENCH_DATA", "data");
  return {
    url: (overrides.url ?? env("CLICKHOUSE_URL", "http://127.0.0.1:8123")).replace(/\/+$/, ""),
    user: overrides.user ?? env("CLICKHOUSE_USER", "default"),
    password: overrides.password ?? env("CLICKHOUSE_PASSWORD", ""),
    database: overrides.database ?? env("CLICKHOUSE_DATABASE", "wrathbench"),
    dataDir,
    runsDir: overrides.runsDir ?? env("WRATHBENCH_RUNS_DIR", `${dataDir}/runs`),
    stateDb: overrides.stateDb ?? env("WRATHBENCH_COLLECTOR_DB", `${dataDir}/collector.sqlite`),
    pollMs: overrides.pollMs ?? envInt("WRATHBENCH_COLLECTOR_POLL_MS", DEFAULT_POLL_MS),
    batchRows: overrides.batchRows ?? envInt("WRATHBENCH_COLLECTOR_BATCH_ROWS", DEFAULT_BATCH_ROWS),
    batchBytes: overrides.batchBytes ?? envInt("WRATHBENCH_COLLECTOR_BATCH_BYTES", DEFAULT_BATCH_BYTES),
  };
}
