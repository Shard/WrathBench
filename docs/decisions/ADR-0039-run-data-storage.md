# ADR-0039: Run data storage — files now, Parquet next, ClickHouse when the fleet outgrows a laptop

Status: Proposed. Date: 2026-08-23.

## Context

Everything the harness records lives under `data/runs/` as files, one directory per
run: `trajectory.jsonl` (every record the loop saw — model responses, snippets and
their results, state samples, served event batches; 236 trajectories today, 664 MB,
2.8 MB each on average, lines up to hundreds of KB), `run.sqlite` (the `run` row and
the `state` samples: level, xp, map, position, money, quests, turn), `meta.json`
(the comparability tuple, pause state), a scratchpad and a log. The fleet's own state
is two more JSON files. The dashboard reads all of it on request; the scheduler's
projection reads every trajectory in full (memoised on size+mtime); every analysis
this week was an ad-hoc Python script streaming JSONL.

That has been the right choice. The files are the evidence record — the thing a
result claim points at — and a directory you can `ls`, `tar` and diff is the most
honest store there is while the shape of a record is still changing daily. But three
pressures are now visible:

- **Reads scan.** `/api/runs`, `/api/results`, the ladder, `accountHeldBy` and the
  scheduling projection each walk the directory. The pre-0.4 archive (125 dirs) cut
  the working set to 23 runs and the problem went away, which says how close it is:
  a fleet of eight accounts adds ~60 runs a day.
- **Analysis is bespoke.** "How many `WB_MOVE_RESULT` timeouts per run after the
  deploy", "which runs read `.wake`", "tool-call gap percentiles per model" were each a
  script with its own JSONL extractor, run by a subagent, results pasted into a
  report. The questions are SQL-shaped; the store is not.
- **Public hosting.** The dashboard must one day serve from somewhere other than the
  box that runs the games, cheaply and under load (the plan is Cloudflare: static
  assets plus JSON state). A request path that opens sqlite files on the game box
  cannot be that.

The operator asked for a written proposal rather than a decision, with the tools
explained, since neither Parquet nor ClickHouse is familiar.

## The two tools, plainly

**Parquet** is a *file format*, not a database. A Parquet file is a table stored
column by column (all the `ts` values together, then all the `level` values, …)
with types, compression and per-block min/max statistics. Consequences: it is
5–20× smaller than the same rows as JSON; a query that touches three columns reads
three columns, not every line; and any tool that speaks Parquet — DuckDB, pandas,
polars, Spark, ClickHouse, BigQuery — reads it directly. It is append-unfriendly (you
write a file, you don't add lines to it), which suits us: a finished run is immutable.
Think of it as "the JSONL, but typed, columnar and a tenth the size".

**DuckDB** is an embedded analytical database — the SQLite of analytics. No server; a
library (`bun:sqlite` has a cousin, and the CLI is one binary). Its trick is that it
queries Parquet (and JSON, and CSV) *in place*: `SELECT model, count(*) FROM
'data/parquet/*/responses.parquet' WHERE error LIKE '%WB_MOVE_RESULT%' GROUP BY 1`
with no import step. It is single-node and fast to ~hundreds of GB. This is the
tool that turns this week's Python extractors into one-line queries.

**ClickHouse** is a *server*: a columnar database built for exactly this shape —
append-only event streams with timestamps, queried by aggregation. It ingests
Parquet natively, scales past one machine, and is what you reach for when the data
or the query load exceeds what DuckDB over files does on one box. It is also a
service to run, back up and secure, and a second copy of the truth.

Relation between them: Parquet is the storage format all three agree on; DuckDB reads
it without a server; ClickHouse reads it into a server. Starting with Parquet keeps
every later door open at no cost.

Our Grafana stack (on k8s) is the right home for *operational* metrics — supervisor
heartbeat, module packet counters, account utilisation, gate results — fed from
Prometheus or ClickHouse. Trajectories are not a Grafana shape and should not be
pushed into it.

## Decision (proposed)

Three stages, each earning the next by evidence, none of them replacing the files.

**Stage 1 — a typed reader, and snapshots for the dashboard.** Part of the
runner/fleet/dashboard split (to be its own ADR): one `runs/` library that is the only
code that opens a run directory, returning typed records (`RunFacts`, state samples,
the response/snippet/tool-call records). `fleet` uses it for the projection; the
dashboard stops reading `data/` on request and instead reads **snapshots** that
`fleet` publishes on run end and on a timer — `runs/index.json`, `runs/<id>.json`,
`results/<episode>.json`, `ladder.json`, `fleet.json`. Those snapshots *are* the
public API: syncing that directory to object storage behind a CDN is the whole
public-hosting story, with the raw-entry and scratchpad payloads (DATA-AND-LEGAL)
simply never written into the public set. No database involved; this stage fixes the
scan cost and the hosting shape at once.

**Stage 2 — Parquet export and DuckDB for analysis.** On run end the same reader
writes `data/parquet/<run-id>/{responses,snippets,state,events}.parquet` (the JSONL
stays; Parquet is a derived view, regenerable). Analysis becomes SQL in
`docs/analysis/*.sql` run by `duckdb`, checked in and re-runnable — the fan-out
reviews become queries with a history. Zero infrastructure. Expected size: the
664 MB of JSONL today would be roughly 50–100 MB of Parquet.

**Stage 3 — ClickHouse, when one of these is true:** the Parquet set no longer fits a
laptop's comfortable scan (order of tens of GB; at today's rate that is months away);
more than one person or process needs to query concurrently; or the public dashboard
wants live aggregates that a snapshot cadence cannot give. Then ClickHouse is a sink
fed from the Stage-2 Parquet by the same reader, the operational counters go to it
or Prometheus for Grafana, and the files remain the record of evidence.

## What this rules out

- The dashboard, public or admin, never opens `run.sqlite`/`trajectory.jsonl` in a
  request path after Stage 1.
- No store that is the *only* copy of a trajectory. The JSONL under `data/runs/`
  (and its archive) stays authoritative and gitignored; everything else is derived.
- No ClickHouse before Stage 2 has shown a query the files cannot answer in time.

## Consequences

- Stage 1 is mostly moves plus a publisher; it is the prerequisite for the
  architecture split and for public hosting, so it comes first regardless of the
  database question.
- Stage 2 costs one exporter and a `duckdb` binary and pays back on the first
  analysis. It also makes ClickHouse ingestion a `INSERT … FROM file` later.
- Stage 3 is an operations decision with a known trigger rather than a taste
  decision made early.

## Open questions for the operator

- Snapshot cadence for live runs on the public dashboard (every 60 s is plenty for
  a leaderboard; the admin view keeps its 5 s poll on the box).
- Whether `docs/analysis/*.sql` belongs in the repo (yes, I think: queries are not
  game text) — and whether published *aggregates* derived from model output need a
  DATA-AND-LEGAL line of their own.
- Retention: Parquet for everything forever is cheap; whether archived pre-series
  runs get exported at all.
