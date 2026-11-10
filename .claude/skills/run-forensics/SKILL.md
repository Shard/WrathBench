---
name: run-forensics
description: Answer any question about a WrathBench run, live or past, with `bun wb inspect` — is it live, paused or ownerless, its level and xp, snippets and errors, tool calls by name, the scratchpad over time or at a moment, whether it is stuck, the module audit log, what the publisher last did. Use whenever a task needs run data, and always before writing a script that reads run.sqlite, trajectory.jsonl, meta.json, audit files or the publisher's state.
---

# Run forensics

`bun wb inspect` is the only reader of run data. Every view is read-only,
bounded, and strikes the run's session token from what it prints, which a
scratch script gets wrong: a careless read of a live run's `run.sqlite` once
held the runner's writer off long enough to kill the run. Run from the
repository root; `bun wb --local …` targets the compose quickstart. How it
works is `docs/RUNBOOK.md`, "Inspect a run"; this skill is which view answers
which question, how to read the answer, and what never to do.

```
bun wb inspect live                                   # every run with a heartbeat: live, or ownerless
bun wb inspect run <run-id> [--since 2h] [--until 1h] # verdict, model, level/xp, quests across restarts, counts, errors by class, sizes, trace, nearby
bun wb inspect trajectory <run-id> --last 20          # one capped line per snippet or tool call with its result
bun wb inspect trajectory <run-id> --errors --last 10
bun wb inspect trajectory <run-id> --grep 'moveTo|too_far' --since 30m
bun wb inspect trajectory <run-id> --all --last 50    # every record kind; big ones by size only
bun wb inspect trajectory <run-id> --since <iso> --next 20   # the first 20 items after a moment
bun wb inspect tools <run-id> [--since 2h] [--until 1h]      # calls per tool, ok/error, reflect granted/refused, pad writers
bun wb inspect pad <run-id> [--since 6h] [--last 30]         # pad size over time, its writes (drops over 30% flagged), cap refusals
bun wb inspect pad <run-id> --at <iso>                       # the pad's text at a moment, rebuilt from the record
bun wb inspect stuck [<run-id>] [--window 2h] [--until 1h]   # no game progress over a window, and the failure signals in it; no id: every live run
bun wb inspect audit <run-id>                         # module audit log: counts per kind, op/opcode and status
bun wb inspect audit <run-id> --op WB_MOVE_RESULT --status target_off_mesh --last 20
bun wb inspect audit <run-id> --summary --op move_path,WB_MOVE_RESULT   # move verdicts by op
bun wb inspect audit --smoke edge-drop --op move_edge_drop --since 1h   # a smoke's own sessions, by the name `bun wb smoke` takes
bun wb inspect publisher [<run-id>]                   # last flip, versions per run, the secret scan, last passes
```

`--since`, `--until` and `--at` take `90s`, `30m`, `2h`, `1d`, epoch ms or an
ISO time. `--last N` reads back from `--until` (or the end), `--next N`
forward from `--since` (or the start). A command refuses a flag it does not
take; `bun wb inspect` lists each command's flags.

`stuck`'s verdict is the progress line alone; the other lines are evidence,
and `asks` is a phrase heuristic. `unjudged` means the state samples do not
cover the window (a young or resumed run), not that the run is fine.

## Rules

- **Live means no termination and no pause.** A paused run is unterminated
  too, so check both. Unterminated, unpaused and a heartbeat older than two
  minutes is a run that lost its process: `inspect` says `ownerless`.
- **Never read a whole trajectory line.** `trajectory.jsonl` lines run to
  megabytes. `inspect trajectory` caps every field; if you must script, read
  the head of each line only.
- **Never print a session token**, and never put one in argv. It sits in
  `meta.json` as `config.token`, so never print `meta.json` whole; older
  audit files are named by it, so never `ls` the audit directory. `inspect
  audit` takes a run id and prints only counts or struck records.
- Do not print env, `.env` or Secrets while investigating.
- **A missing view is a change to `infra/inspect-*.ts`** with a fixture test
  beside it (`infra/inspect-*.test.ts`), not a scratch script.

## Reading the `source` line

`live`, `run`, `trajectory`, `tools`, `pad` and `stuck` read ClickHouse, the store the
collector tails runs into, and say so on a `source` line. `audit` and
`publisher` read the module's audit files and the publisher's state where
they live.

- `ClickHouse through <time>, current with the file` or `…, 8s behind the
  file`: normal; a live run trails by a few seconds. Past two minutes the
  line says the collector is behind or down and the newest records are
  missing: add `--files`.
- `the files: <why>`: no `CLICKHOUSE_URL`, ClickHouse unreachable, the run
  not in it yet, or `--files`. For a live run the verdict then reads `unread`
  and the level `not read`, because the fallback will not open a live
  `run.sqlite`; the trajectory views still work.
- `ClickHouse failed mid-read (…)` on stderr, exit 1: run it again, or with
  `--files`. On a `Code: 241`, check `system.query_log` by pod before blaming
  inspect, whose queries carry `log_comment = 'wb inspect'`.

## What `tools` and `pad` can say, by driver

The pad's text is recorded only on `request` records, so a snippet's
`scratchpad.write/append` gets a size only from the next request, and only
when no other write came between. `pad` marks an unsized write `→ ?` and
prints `per-turn  none for N of M snippet write(s)` when any went unsized.

- **Fixed loop**: a request per model turn, so every write has a size.
- **codex and pi**: a request per CLI turn, which can hold several tool
  calls; a snippet write followed by another write in the same turn goes
  unsized.
- **claude-code**: a request only when it hands the CLI a new context, often
  once per session. Its snippet writes are mostly unsized, and the sizes
  between come from `write_scratchpad`/`edit_scratchpad` results. Its
  `reflect_window` records are drained late and together, so `tools` shows
  them zero-length: count grants from the `reflection` line.
- **Snippet pad writes are found in the snippet's code**, so one behind a
  branch that never ran still counts.
- `pad --at` replays `edit_scratchpad` calls from the newest request or
  `write_scratchpad`, and prints `uncertain` when it cannot vouch for the
  text: a snippet wrote the pad in between, an edit missed, or the rebuild
  disagrees with the newest write's reported size.

## When the checkout is ahead of the deployed image

`live`, `run`, `trajectory`, `tools`, `pad` and `stuck` run the runner pod's copy of
`infra/inspect-run.ts`; `audit` and `publisher` run this checkout's code. If
`bun wb` says the file is not in the runner pod, or the pod's copy answers
`unknown command` or refuses a flag, run this checkout's copy in the pod from
stdin, the command and its flags after the `-`:

```
kubectl -n <ns> exec -i deploy/<release>-runner -- bun run - tools <run-id> --since 2h < infra/inspect-run.ts
```

## Offline, against a copy

```
bun infra/inspect-run.ts run <run-id> --runs-dir <dir>
bun infra/inspect-audit.ts <run-id> --audit-dir <dir> --runs-dir <dir>
bun infra/inspect-publisher.ts --state <file>
```

With no `CLICKHOUSE_URL` in the shell these read the copy's files, and the
`source` line says so.
