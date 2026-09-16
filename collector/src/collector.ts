/**
 * The collector loop.
 *
 * One pass = list the runs tree, ingest every directory whose artefacts have
 * moved since the last pass, sleep, repeat. `--replay` is the same pass with
 * the offsets cleared first: there is one code path, which is the point — the
 * backfill and the recovery path are the steady-state path, so a bug in either
 * is a bug in the one everybody exercises daily.
 *
 * Nothing here ever gives up. ClickHouse being down parks the pass inside
 * `Sink.insert` (see `sink.ts`), which retries until it works or the process
 * is asked to stop. Offsets are committed only past rows the sink has
 * acknowledged, so a collector that has been waiting all night resumes from
 * exactly where it stopped.
 */

import { Batcher } from "./batch";
import type { CollectorConfig } from "./config";
import { Ingester } from "./ingest";
import { OffsetStore } from "./offsets";
import { listRunDirs } from "./scan";
import { SinkAborted, type Sink } from "./sink";

export interface PassStats {
  /** Run directories seen. */
  seen: number;
  /** Of those, the ones that had something new. */
  ingested: number;
  trajectoryLines: number;
  episodicLines: number;
  states: number;
  moves: number;
  runs: number;
  totals: number;
}

export interface CollectorDeps {
  cfg: CollectorConfig;
  sink: Sink;
  offsets: OffsetStore;
  now?: () => number;
  chunkBytes?: number;
  log?: (msg: string) => void;
}

export class Collector {
  private readonly batcher: Batcher;
  private readonly ingester: Ingester;
  private readonly now: () => number;
  /** Each run's artefact signature at its last pass; a cheap "has it moved". */
  private readonly lastSeen = new Map<string, string>();

  constructor(private readonly deps: CollectorDeps) {
    this.now = deps.now ?? Date.now;
    this.batcher = new Batcher(deps.sink, deps.cfg.batchRows, deps.cfg.batchBytes);
    this.ingester = new Ingester({
      runsDir: deps.cfg.runsDir,
      batcher: this.batcher,
      offsets: deps.offsets,
      now: this.now,
      ...(deps.chunkBytes === undefined ? {} : { chunkBytes: deps.chunkBytes }),
    });
  }

  /** Forget every offset, so the next pass reads every run from byte zero. */
  replayFromZero(): void {
    this.deps.offsets.reset();
    this.lastSeen.clear();
  }

  async pass(): Promise<PassStats> {
    const stats: PassStats = {
      seen: 0,
      ingested: 0,
      trajectoryLines: 0,
      episodicLines: 0,
      states: 0,
      moves: 0,
      runs: 0,
      totals: 0,
    };
    for (const entry of listRunDirs(this.deps.cfg.runsDir)) {
      stats.seen++;
      const before = this.lastSeen.get(entry.runId);
      if (before !== undefined && before === entry.sig) {
        /*
         * Nothing in this run has moved since the last pass, so there is
         * nothing to read — and it is not being written, so its resumable
         * totals scanner is holding marks for a file that is finished.
         */
        this.ingester.forget(entry.runId);
        continue;
      }
      const r = await this.ingester.ingestRun(entry.runId, entry.dir, entry.archived);
      this.lastSeen.set(entry.runId, entry.sig);
      const touched =
        r.trajectoryLines + r.episodicLines + r.states + r.moves > 0 || r.run || r.totals;
      if (touched) stats.ingested++;
      stats.trajectoryLines += r.trajectoryLines;
      stats.episodicLines += r.episodicLines;
      stats.states += r.states;
      stats.moves += r.moves;
      if (r.run) stats.runs++;
      if (r.totals) stats.totals++;
    }
    await this.batcher.flushAll();
    return stats;
  }

  /** Poll until `signal` fires. One pass, sleep, repeat. */
  async run(signal: AbortSignal): Promise<void> {
    const log = this.deps.log ?? ((m: string) => console.log(m));
    while (!signal.aborted) {
      const started = this.now();
      try {
        const s = await this.pass();
        if (s.ingested > 0) {
          log(
            `collector: ${s.ingested}/${s.seen} runs, ${s.trajectoryLines} trajectory lines, ` +
              `${s.states} states, ${s.moves} moves, ${s.runs} run rows, ${s.totals} totals ` +
              `in ${this.now() - started}ms`,
          );
        }
      } catch (err) {
        if (err instanceof SinkAborted) return;
        // A pass that throws for any other reason must not end the service:
        // the offsets it did commit stand and the next pass picks up there.
        log(`collector: pass failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      await sleepUntil(this.deps.cfg.pollMs, signal);
    }
  }
}

function sleepUntil(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done(): void {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/** Open the offset store the collector's config names. */
export function openOffsets(cfg: CollectorConfig): OffsetStore {
  return new OffsetStore(cfg.stateDb);
}
