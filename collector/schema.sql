-- WrathBench's derived store. Every table here is disposable: drop the
-- database, run `bun collector/src/main.ts --replay`, and it comes back from
-- `data/runs/`, which stays the evidence record and the only write path.
--
-- Conventions that hold for every table below, and why:
--
--   * Timestamps are `Int64` epoch milliseconds, not `DateTime64`. That is
--     what the runner writes and what every API body already carries, so a
--     round trip through this store changes no byte a client sees. Read them
--     with `fromUnixTimestamp64Milli(ts)` when a human wants a date.
--   * No `PARTITION BY`. ReplacingMergeTree deduplicates only within a
--     partition, and any time-based partition would split a run that crosses
--     the boundary and keep both copies of its rows forever. The corpus is
--     tens of GB on one node; one partition per table is the right size.
--   * Every table a re-ingest can touch is `ReplacingMergeTree` on a natural
--     key that replay reproduces exactly, so `--replay` is idempotent rather
--     than additive. Merges are asynchronous, so a reader that needs exact
--     counts says `FINAL`.
--   * A trajectory line's dedup key is `(run_id, line_no)` — its ordinal in
--     the file — never `(run_id, turn)`. One turn writes several lines
--     (request, response, snippet, snippet_result, tool_call), and `turn` is
--     absent on most record kinds; keying on it would silently collapse a
--     turn's lines into one and lose the rest. Replay reads the same bytes in
--     the same order, so the ordinal is stable.
--   * `raw` holds the whole JSONL line on every trajectory row. Nothing is
--     lost when a typed column does not exist yet, which is what lets the
--     schema stay small without the store becoming lossy.

CREATE DATABASE IF NOT EXISTS wrathbench;

-- One row per run: the `run` row of its `run.sqlite`, plus what only
-- `meta.json` knows (the comparability tuple, the launch config). The two are
-- read together and written as one row because every consumer reads them
-- together — the viewer's `readRun` merges them field by field today.
CREATE TABLE IF NOT EXISTS wrathbench.runs
(
  run_id                String,
  -- Runs under `data/runs/archive/`. A listing hides them; the fleet
  -- scheduler must see them (see `readRunFacts`, `includeArchived`), so they
  -- are ingested with a flag rather than skipped.
  archived              UInt8 DEFAULT 0,
  harness_version       String,
  started_at            Int64,
  ended_at              Nullable(Int64),
  driver                String,
  -- The unscored stamp. Legacy column name, kept from run.sqlite.
  shakeout              String,
  model                 String,
  objective             String,
  character             String,
  platform              String,
  resolved_model        String,
  resolved_cli_version  String,
  continued_from        String,
  termination_reason    String,
  termination_detail    String,
  pause_reason          String,
  reflecting_since      Nullable(Int64),
  -- The launch config and the comparability tuple as they were written, so a
  -- consumer that wants a field no column carries can parse rather than wait
  -- for a migration.
  config_json           String CODEC(ZSTD(3)),
  comparability_json    String CODEC(ZSTD(3)),
  meta_json             String CODEC(ZSTD(3)),
  -- The trajectory file's own size and mtime at ingestion. Liveness is decided
  -- from the mtime against `now` exactly as it is from the file today.
  trajectory_bytes      Int64,
  trajectory_mtime      Int64,
  ingested_at           Int64
)
ENGINE = ReplacingMergeTree(ingested_at)
ORDER BY run_id;

-- The periodic state samples: `state` in run.sqlite, one row per sample.
-- `seq` is the sqlite rowid, which is stable across re-reads and breaks the
-- tie when two samples land in the same millisecond.
CREATE TABLE IF NOT EXISTS wrathbench.states
(
  run_id          String,
  seq             Int64,
  ts              Int64,
  level           Nullable(Int32),
  xp              Nullable(Int64),
  map             Nullable(Int32),
  x               Nullable(Float64),
  y               Nullable(Float64),
  z               Nullable(Float64),
  event_count     Nullable(Int64),
  last_seq        Nullable(Int64),
  money           Nullable(Int64),
  quests_completed Nullable(Int64),
  turn            Nullable(Int32),
  zone            Nullable(Int32),
  area            Nullable(Int32),
  health          Nullable(Int32),
  max_health      Nullable(Int32),
  power           Nullable(Int32),
  max_power       Nullable(Int32),
  power_type      Nullable(Int32),
  next_level_xp   Nullable(Int64),
  -- `ItemSample[]` as written. JSON because it is read whole or not at all.
  items           String CODEC(ZSTD(3)),
  ingested_at     Int64
)
ENGINE = ReplacingMergeTree(ingested_at)
ORDER BY (run_id, ts, seq);

-- Movement intentions: `move` in run.sqlite. Two rows per move in the normal
-- case (the dispatch, then the module's verdict).
CREATE TABLE IF NOT EXISTS wrathbench.moves
(
  run_id      String,
  seq         Int64,
  ts          Int64,
  move_id     Nullable(Int64),
  map         Nullable(Int32),
  x           Nullable(Float64),
  y           Nullable(Float64),
  z           Nullable(Float64),
  target      String,
  status      String,
  ingested_at Int64
)
ENGINE = ReplacingMergeTree(ingested_at)
ORDER BY (run_id, ts, seq);

-- `{"t":"milestone"}` trajectory lines, typed. Kinds are additive and a kind
-- this schema does not know still lands with its `raw` intact, so a new kind
-- never needs a migration before it is queryable.
CREATE TABLE IF NOT EXISTS wrathbench.milestones
(
  run_id      String,
  line_no     Int64,
  ts          Int64,
  kind        String,
  turn        Nullable(Int32),
  -- zone/area/level transitions: ids only, never names.
  from_id     Nullable(Int64),
  to_id       Nullable(Int64),
  -- achievement / spell / talent id.
  id          Nullable(Int64),
  points      Nullable(Int64),
  -- The death event's own timestamp, where the record carried one.
  observed_ts Nullable(Int64),
  raw         String CODEC(ZSTD(3)),
  ingested_at Int64
)
ENGINE = ReplacingMergeTree(ingested_at)
ORDER BY (run_id, line_no);

-- The turn-shaped trajectory lines: request, response, snippet,
-- snippet_result, tool_call, tool_result, events_served. This is the big table
-- and the reason the store exists — ~75% of a trajectory's bytes are the
-- rendered `messages` re-logged every turn, and columnar ZSTD across turns
-- compresses that far better than gzip over the whole file.
CREATE TABLE IF NOT EXISTS wrathbench.turns
(
  run_id            String,
  line_no           Int64,
  ts                Int64,
  -- The record's own `t`.
  kind              String,
  -- The driver's turn counter. Sparse by design: several lines share one turn
  -- and some record kinds carry none. An ordering aid, never a key.
  turn              Nullable(Int32),
  input_tokens      Nullable(Int64),
  output_tokens     Nullable(Int64),
  cache_read_tokens Nullable(Int64),
  cache_write_tokens Nullable(Int64),
  reasoning_tokens  Nullable(Int64),
  total_tokens      Nullable(Int64),
  -- What the provider charged for this call, when it said.
  cost_usd          Nullable(Float64),
  -- Tool call summary: the tool's name, and whether the result was an error.
  tool_name         String,
  is_error          Nullable(UInt8),
  -- How many events an `events_served` line carried.
  event_count       Nullable(Int64),
  finish_reason     String,
  -- The rendered context of a `request`. The single largest thing in the
  -- corpus, and the one column a query should name explicitly rather than
  -- reach with SELECT *.
  messages          String CODEC(ZSTD(3)),
  -- The event batch of an `events_served`.
  events            String CODEC(ZSTD(3)),
  -- The whole line. Nothing above is load-bearing for evidence; this is.
  raw               String CODEC(ZSTD(3)),
  ingested_at       Int64
)
ENGINE = ReplacingMergeTree(ingested_at)
ORDER BY (run_id, line_no);

-- Every other trajectory line: meta, state, milestone, harness, watchdog,
-- pause, resume, termination, character, reflect_window, claude_system,
-- claude_result, driver, and whatever a later build adds. A kind this schema
-- has never seen still lands here with its `raw`, which is the point.
CREATE TABLE IF NOT EXISTS wrathbench.events
(
  run_id         String,
  line_no        Int64,
  ts             Int64,
  kind           String,
  turn           Nullable(Int32),
  -- The handful of fields worth a column because something queries them
  -- across runs: the state sample's own readings, the resolved model, and the
  -- sub-kind a `harness` or `hygiene` record carries.
  level          Nullable(Int32),
  zone           Nullable(Int32),
  area           Nullable(Int32),
  resolved_model String,
  sub_kind       String,
  reason         String,
  detail         String,
  raw            String CODEC(ZSTD(3)),
  ingested_at    Int64
)
ENGINE = ReplacingMergeTree(ingested_at)
ORDER BY (run_id, line_no);

-- `episodic.jsonl`: the model's own episodic log, one line per entry.
CREATE TABLE IF NOT EXISTS wrathbench.episodic
(
  run_id      String,
  line_no     Int64,
  ts          Int64,
  kind        String,
  turn        Nullable(Int32),
  raw         String CODEC(ZSTD(3)),
  ingested_at Int64
)
ENGINE = ReplacingMergeTree(ingested_at)
ORDER BY (run_id, line_no);

-- The per-run derivations, computed by the collector with the viewer's own
-- code and stored as JSON.
--
-- Everything the viewer derives from a trajectory falls in two classes. Pure
-- aggregates — token sums, response counts, first and last timestamp — are
-- SQL over `turns` and this table does not carry them. The rest are
-- ordering-sensitive state machines: active segments and playtime, the zone
-- and death timelines, the level ladder, tokens per second over reply spans.
-- Reimplementing those in SQL would mean two implementations that can
-- disagree about a published number, so the collector runs the *same*
-- TypeScript the viewer ran (`runner/viewer/tail.ts`, `runner/src/models.ts`)
-- as it tails and stores the answer. Same code, same bytes, by construction.
CREATE TABLE IF NOT EXISTS wrathbench.run_totals
(
  run_id      String,
  -- `RunTotals` from runner/viewer/tail.ts, as JSON.
  totals_json String CODEC(ZSTD(3)),
  -- `RunFact` from runner/src/models.ts, as JSON. Null-ish (empty string) on a
  -- run with no usable meta.json, which is what `readRunFact` returns there.
  fact_json   String CODEC(ZSTD(3)),
  -- What the totals were computed over, so a reader can tell a stale row.
  trajectory_bytes Int64,
  ingested_at Int64
)
ENGINE = ReplacingMergeTree(ingested_at)
ORDER BY run_id;
