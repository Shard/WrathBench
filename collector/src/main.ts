/**
 * The collector as a process.
 *
 *   bun collector/src/main.ts                 poll forever (the service)
 *   bun collector/src/main.ts --once          one pass, then exit
 *   bun collector/src/main.ts --replay        forget every offset, one full
 *                                             pass from byte zero, then poll
 *   bun collector/src/main.ts --replay --once the backfill
 *   bun collector/src/main.ts --apply-schema  create the tables, then exit
 *
 * `--apply-schema` is safe to run every start and the service does: every
 * statement in `schema.sql` is `IF NOT EXISTS`, and a collector pointed at an
 * empty ClickHouse should come up rather than fail on a missing table.
 */

import { readConfig } from "./config";
import { Collector, openOffsets } from "./collector";
import { applySchema } from "./schema";
import { clickhouseSink } from "./sink";

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const has = (flag: string): boolean => argv.includes(flag);
  const once = has("--once");
  const replay = has("--replay") || has("--backfill");
  const schemaOnly = has("--apply-schema");
  const noSchema = has("--no-schema");

  const cfg = readConfig();
  /*
   * `schema.sql` names `wrathbench.` on every statement, so a `CLICKHOUSE_DATABASE`
   * pointing anywhere else would create the tables in one database and insert
   * into another — an empty store with no error anywhere. Refuse at startup
   * rather than run in that shape.
   */
  if (cfg.database !== "wrathbench") {
    console.error(
      `collector: CLICKHOUSE_DATABASE is ${cfg.database}, but schema.sql creates every table in wrathbench. ` +
        "Unset it, or set it to wrathbench.",
    );
    return 1;
  }
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  /*
   * One line per outage, not one per retry: a ClickHouse that is down for an
   * hour must not be an hour of log. The latch is raised on the first wait and
   * lowered by the first call that succeeds after it — so the second outage of
   * a long-lived process is logged too, which it was not while the latch was
   * cleared once at startup and never again.
   */
  let waiting = false;
  const sink = clickhouseSink(cfg, {
    signal: controller.signal,
    onRetry: (attempt, err) => {
      if (waiting) return;
      waiting = true;
      console.warn(
        `collector: clickhouse unavailable, retrying (${err instanceof Error ? err.message : String(err)})`,
      );
      void attempt;
    },
    onOk: () => {
      if (!waiting) return;
      waiting = false;
      console.log("collector: clickhouse is back");
    },
  });

  if (!noSchema) {
    const n = await applySchema(sink);
    console.log(`collector: schema applied (${n} statements) at ${cfg.url}/${cfg.database}`);
  }
  if (schemaOnly) return 0;

  const offsets = openOffsets(cfg);
  const collector = new Collector({ cfg, sink, offsets, log: (m) => console.log(m) });
  if (replay) {
    console.log(`collector: replay — forgetting every offset under ${cfg.runsDir}`);
    collector.replayFromZero();
  }

  try {
    if (once) {
      const stats = await collector.pass();
      console.log(
        `collector: pass over ${stats.seen} runs — ${stats.trajectoryLines} trajectory lines, ` +
          `${stats.episodicLines} episodic lines, ${stats.states} states, ${stats.moves} moves, ` +
          `${stats.runs} run rows, ${stats.totals} totals`,
      );
    } else {
      console.log(`collector: watching ${cfg.runsDir} every ${cfg.pollMs}ms`);
      await collector.run(controller.signal);
    }
  } finally {
    offsets.close();
  }
  return 0;
}

process.exit(await main());
