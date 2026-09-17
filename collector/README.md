# collector

Tails `data/runs/` and writes it into ClickHouse, so the viewer can answer a
question about a thousand runs with one query instead of a thousand file opens.

The store is **derived and disposable**. The files under `data/runs/` are the
evidence record and the only write path; nothing here ever writes to them, and
the runner does not know this service exists. Drop the ClickHouse database,
delete `data/collector.sqlite`, run `--replay`, and everything comes back.

## Running it

```sh
bun collector/src/main.ts                  # the service: poll forever
bun collector/src/main.ts --replay --once  # the backfill
bun collector/src/main.ts --apply-schema   # create the tables, exit
```

Configuration is environment only:

| variable | default | what it is |
| --- | --- | --- |
| `CLICKHOUSE_URL` | `http://127.0.0.1:8123` | the HTTP interface |
| `CLICKHOUSE_USER` / `CLICKHOUSE_PASSWORD` | `default` / empty | credentials |
| `CLICKHOUSE_DATABASE` | `wrathbench` | must match `schema.sql` |
| `WRATHBENCH_DATA` | `data` | the data directory |
| `WRATHBENCH_RUNS_DIR` | `<data>/runs` | the tree to watch |
| `WRATHBENCH_COLLECTOR_DB` | `<data>/collector.sqlite` | per-file offsets |
| `WRATHBENCH_COLLECTOR_POLL_MS` | `5000` | how often to re-stat the tree |

## How it reads

Polling, not inotify: the runs tree is a network-backed volume shared by five
pods, and file-system events over such a mount are the kind of thing that works
on a laptop and quietly stops on a cluster. A `stat` of a thousand directories
is milliseconds either way.

Each source has its own resume rule, because each changes differently:

| source | shape | resume |
| --- | --- | --- |
| `trajectory.jsonl` | append-only | byte offset + next line ordinal |
| `episodic.jsonl` | append-only | byte offset + next line ordinal |
| `run.sqlite` `state` | append-only | sqlite rowid watermark |
| `run.sqlite` `move` | append-only | sqlite rowid watermark |
| `run.sqlite` `run` | mutated in place | `(size, mtime)` signature |
| `meta.json` | rewritten | `(size, mtime)` signature |

Those live in `data/collector.sqlite`, which is the only thing this service
owns on disk and is as disposable as the store itself.

A run id is not unique on disk: `runs/<id>/` and `runs/archive/<id>/` can both
exist and hold different runs, where an attempt was archived and a later launch
reused the id. Every key here — the offsets, the signatures, every table's
`ORDER BY` — is the run id alone, so the pass ingests one directory per id and
the non-archived one wins, the copy the viewer serves. The collision is logged
once; the files are left where they are.

A trajectory is never loaded whole — the largest in the corpus is 669 MB. The
tailer slides a 4 MB window and holds at most one line across chunks; a live
run's half-written last line is left unread, so a committed offset is always
past a newline. Batches flush at 2,000 rows **or** 8 MB, whichever trips first,
because one line of this corpus can be megabytes on its own.

ClickHouse being down is a wait, never a loss: `insert` retries with capped
backoff, and an offset is committed only after the sink has acknowledged the
rows. The worst a night of downtime costs is a store that is behind.

`--replay` is the same pass with the offsets cleared. One code path, on
purpose: the backfill and the recovery path *are* the steady-state path, so
there is no rarely-exercised branch to be wrong.

## The tables

`schema.sql` carries the full commentary; this is the map.

| table | one row is | key |
| --- | --- | --- |
| `runs` | a run: its `run.sqlite` row merged with `meta.json` | `run_id` |
| `states` | one periodic state sample | `(run_id, ts, seq)` |
| `moves` | one movement dispatch or verdict | `(run_id, ts, seq)` |
| `milestones` | one `{"t":"milestone"}` line, typed | `(run_id, line_no)` |
| `turns` | one turn-shaped trajectory line, with `messages` | `(run_id, line_no)` |
| `events` | every other trajectory line | `(run_id, line_no)` |
| `episodic` | one `episodic.jsonl` entry | `(run_id, line_no)` |
| `run_totals` | the per-run derivations, as JSON | `run_id` |

Three things about that list are worth knowing before writing a query.

**Everything is `ReplacingMergeTree` on a key replay reproduces exactly.** A
trajectory line's key is its *ordinal in the file*, never `(run_id, turn)`: one
turn writes several lines and most record kinds carry no `turn` at all, so
keying on the turn would collapse a turn's lines into one. Merges are
asynchronous, so a query that needs exact counts says `FINAL`.

**`raw` holds the whole line on every trajectory row.** The typed columns are a
convenience; nothing is lost when a record kind grows a field this schema does
not name. That is what lets the schema stay small without the store becoming
lossy — and what lets `events` accept a kind nobody has written yet.

**`run_totals` is JSON on purpose.** Everything the viewer derives falls in two
classes. Pure aggregates — token sums, response counts, first and last
timestamp — are SQL over `turns`. The rest are ordering-sensitive state
machines: active segments and playtime, the zone and death timelines, tokens
per second over reply spans. Reimplementing those in SQL would mean two
implementations that can disagree about a published number, so the collector
runs *the viewer's own code* (`runner/viewer/tail.ts`, `runner/src/models.ts`)
as it tails and stores the answer. Same code, same bytes, by construction.

Archived runs are ingested too, flagged `archived = 1`. The viewer hides them
and the fleet scheduler must see them; that filter belongs in the query, not in
what gets stored.

## The memory budget

ClickHouse ships sized for a dedicated box and does not shrink to fit. It reads
the container's cgroup limit for exactly one setting — `max_server_memory_usage`,
at 0.9 of it — and every cache and thread pool keeps its default whatever the
limit is: a 5 GiB mark cache, a 5 GiB primary-index cache, a 5 GiB
index-mark cache, an 8 GiB uncompressed cache, 16 background merge threads,
`max_threads` auto(16) and no per-query memory cap at all. Against the 1.8 GiB
tracker a 2 GiB container gets, that is not a budget, and on 2026-09-17 two
concurrent viewer queries over `turns` (15.7 GiB uncompressed, 715 MiB on disk)
took the server down with `Code: 241 (total) memory limit exceeded`.

`infra/clickhouse/` is the fix, and it is the same two files under both
deployments — compose bind-mounts them, the Helm chart carries a verbatim inline
copy in its ConfigMap, and `infra/clickhouse.test.ts` fails if the two drift.
`config.d/memory.xml` hard-bounds the caches (mark 256 MiB, primary-index and
index-mark 128 MiB, uncompressed off), cuts the background pools to 4 with the
`merge_tree` free-slot thresholds scaled to match, gives merges a 512 MiB soft
limit, and caps `max_concurrent_queries` at 32. `users.d/wrathbench-profile.xml`
puts `max_threads` 4, `max_memory_usage` 512 MiB and `max_execution_time` 300s
on the **`default` profile** — not on a named user, because the app user is
created from `CLICKHOUSE_USER` by the image's entrypoint at first boot and
inherits that profile.

The numbers do not sum to the limit and are not meant to: 32 queries at 512 MiB
each is far more than the container has. What each one buys is a bound where
there was none, so no single cache, merge or query can reach the ceiling on its
own, and `max_server_memory_usage` stays the backstop rather than the first
thing hit. Both deployments now give the server 4 GiB. **On a bigger box, raise
the container limit first** — that alone moves the backstop — then the mark and
primary-index caches, then `background_pool_size`, then the profile's
`max_threads`. Raising the caches without raising the limit is how this started.

## Tests

`bun test` from the repository root, or from here. Fixture-based and green from
a bare clone: the tests build small synthetic run directories in a temp dir and
insert into a memory sink, so nothing under `data/` and no ClickHouse is
needed.
