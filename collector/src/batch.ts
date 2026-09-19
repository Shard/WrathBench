/**
 * Row buffering, one buffer per table.
 *
 * The collector reads a trajectory line by line and never holds a whole file,
 * so something has to decide when enough lines have accumulated to be worth a
 * round trip. That is here, and the accounting is in bytes as well as rows for
 * the reason `config.ts` gives: one line of this corpus can be megabytes.
 *
 * `flushAll` is the commit point. The ingester advances a file offset only
 * after it returns, so a batch that is still in memory when the process dies
 * is simply re-read on the next start — which is exactly what the natural
 * keys in `schema.sql` make harmless.
 */

import type { Sink } from "./sink";

export class Batcher {
  private readonly buffers = new Map<string, { rows: unknown[]; bytes: number }>();

  constructor(
    private readonly sink: Sink,
    private readonly maxRows: number,
    private readonly maxBytes: number,
  ) {}

  async add(table: string, row: unknown): Promise<void> {
    const buf = this.buffers.get(table) ?? { rows: [], bytes: 0 };
    buf.rows.push(row);
    /*
     * The row is serialised once here to size it and once again in the sink.
     * Measured against the alternative — carrying pre-serialised strings and
     * losing the typed row at every call site — the second stringify is not
     * where this process spends its time; disk reads and the HTTP round trip
     * are.
     */
    buf.bytes += JSON.stringify(row).length;
    this.buffers.set(table, buf);
    if (buf.rows.length >= this.maxRows || buf.bytes >= this.maxBytes) await this.flush(table);
  }

  async flush(table: string): Promise<void> {
    const buf = this.buffers.get(table);
    if (buf === undefined || buf.rows.length === 0) return;
    this.buffers.delete(table);
    await this.sink.insert(table, buf.rows);
  }

  async flushAll(): Promise<void> {
    for (const table of [...this.buffers.keys()]) await this.flush(table);
  }
}
