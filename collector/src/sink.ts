/**
 * Where rows go: ClickHouse's HTTP interface, or a test double.
 *
 * The one rule this file exists to hold: **ClickHouse being down is a wait,
 * never a loss.** `insert` retries with backoff until it succeeds or the
 * process is asked to stop, and the caller only commits a file offset once
 * `insert` has returned. So the worst a night of ClickHouse downtime costs is
 * a collector sitting in a retry loop and a store that is behind; nothing is
 * skipped and nothing has to be reconciled by hand afterwards.
 *
 * `async_insert=1` with `wait_for_async_insert=1`: the server batches our
 * batches, which is what keeps a replay of a thousand runs from making a part
 * per insert, and we still wait for the acknowledgement — an insert we have
 * not been told landed is an insert we cannot advance an offset past.
 */

import type { CollectorConfig } from "./config";

export interface Sink {
  /** Insert rows into `table` (unqualified). Returns once they are accepted. */
  insert(table: string, rows: readonly unknown[]): Promise<void>;
  /** Run a statement that returns nothing worth parsing (DDL). */
  exec(sql: string): Promise<void>;
}

export interface SinkOptions {
  /** Raised when the process is shutting down; a retry loop gives up on it. */
  signal?: AbortSignal;
  /** Injected by tests so a retry does not really sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Told about every wait, so the service can log one line per outage. */
  onRetry?: (attempt: number, err: unknown) => void;
  /** Told when a call succeeds, so the service can say the outage is over. */
  onOk?: () => void;
}

/** Backoff: 1s, 2s, 4s, 8s, 16s, 30s, 30s… A capped wait, never a give-up. */
export const RETRY_BASE_MS = 1_000;
export const RETRY_MAX_MS = 30_000;

export function retryDelayMs(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(attempt, 10));
}

const sleepReal = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class SinkAborted extends Error {
  constructor() {
    super("collector: shutting down with rows unsent");
    this.name = "SinkAborted";
  }
}

/**
 * JSONEachRow: one JSON object per line. `undefined` is not a JSON value, so a
 * field a row does not carry is written as `null` and lands in the column's
 * default — which for every `Nullable` column here is NULL, and for every
 * `String` column is the empty string. That is the deliberate convention: a
 * string column in this store never distinguishes "empty" from "absent",
 * because nothing reading it does either.
 */
export function jsonEachRow(rows: readonly unknown[]): string {
  let out = "";
  for (const r of rows) out += `${JSON.stringify(r)}\n`;
  return out;
}

export function clickhouseSink(cfg: CollectorConfig, opts: SinkOptions = {}): Sink {
  const sleep = opts.sleep ?? sleepReal;
  const headers: Record<string, string> = {
    "content-type": "text/plain; charset=utf-8",
    "x-clickhouse-user": cfg.user,
  };
  if (cfg.password.length > 0) headers["x-clickhouse-key"] = cfg.password;

  const post = async (params: Record<string, string>, body: string): Promise<string> => {
    const url = new URL(cfg.url);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetch(url, { method: "POST", headers, body });
    const text = await res.text();
    if (!res.ok) throw new Error(`clickhouse ${res.status}: ${text.slice(0, 500)}`);
    return text;
  };

  /** Whether the process has been asked to stop. A function, not a read: the
   * value changes under us, which is the whole point of the retry loop. */
  const aborted = (): boolean => opts.signal?.aborted === true;

  /** Try until it works, or until the process is going away. */
  const forever = async <T>(what: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      if (aborted()) throw new SinkAborted();
      try {
        const out = await what();
        opts.onOk?.();
        return out;
      } catch (err) {
        if (aborted()) throw new SinkAborted();
        opts.onRetry?.(attempt, err);
        await sleep(retryDelayMs(attempt));
      }
    }
  };

  return {
    async insert(table, rows) {
      if (rows.length === 0) return;
      const body = jsonEachRow(rows);
      await forever(() =>
        post(
          {
            query: `INSERT INTO ${cfg.database}.${table} FORMAT JSONEachRow`,
            async_insert: "1",
            wait_for_async_insert: "1",
          },
          body,
        ),
      );
    },
    async exec(sql) {
      await forever(() => post({}, sql));
    },
  };
}

/** A sink that keeps every row in memory. What the tests insert into. */
export function memorySink(): Sink & { tables: Map<string, unknown[]> } {
  const tables = new Map<string, unknown[]>();
  return {
    tables,
    async insert(table, rows) {
      const bucket = tables.get(table) ?? [];
      bucket.push(...rows);
      tables.set(table, bucket);
    },
    async exec() {
      /* a memory sink has no schema to apply */
    },
  };
}
