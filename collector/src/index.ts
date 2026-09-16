/**
 * The collector's public surface: what the tests, the viewer's query module
 * and any future tool import. `main.ts` is the process; nothing imports it.
 */

export { Batcher } from "./batch";
export { Collector, openOffsets, type CollectorDeps, type PassStats } from "./collector";
export {
  DEFAULT_BATCH_BYTES,
  DEFAULT_BATCH_ROWS,
  DEFAULT_POLL_MS,
  readConfig,
  type CollectorConfig,
} from "./config";
export { Ingester, type IngestResult } from "./ingest";
export {
  TURN_KINDS,
  parseLine,
  usageOf,
  type ParsedLine,
  type RowContext,
  type UsageRow,
} from "./lines";
export { OffsetStore, type FileOffset } from "./offsets";
export { SCHEMA_PATH, applySchema, splitStatements } from "./schema";
export { listRunDirs, type RunDirEntry } from "./scan";
export {
  RETRY_BASE_MS,
  RETRY_MAX_MS,
  SinkAborted,
  clickhouseSink,
  jsonEachRow,
  memorySink,
  retryDelayMs,
  type Sink,
  type SinkOptions,
} from "./sink";
export { CHUNK_BYTES, tailLines, type TailedLine } from "./tailer";
