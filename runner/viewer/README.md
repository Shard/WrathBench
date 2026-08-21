# Run viewer

A read-only web view of run trajectories, live and finished. It exists so an
operator can watch a run and see where it is stuck without tailing 3 MB of
JSONL by hand.

## Running

```
bun runner/viewer/serve.ts        # from the repo root, on the host
```

Then open http://127.0.0.1:8090.

- `WRATHBENCH_VIEWER_PORT` overrides the port (default 8090).
- `WRATHBENCH_RUNS_DIR` overrides the runs directory (default `data/runs`).

## Loopback only

The viewer binds 127.0.0.1 and nothing else. Trajectories contain game-derived
text — quest text, NPC and item names — and per `docs/DATA-AND-LEGAL.md` none of
it leaves this machine. `WRATHBENCH_VIEWER_HOST` exists only so the refusal is
visible: set it to anything other than `127.0.0.1` and the process prints why and
exits 1. There is no flag that opens it up. Do not put it behind a tunnel or a
reverse proxy.

It also only ever reads. Each `run.sqlite` is opened readonly, so a run being
written by the harness inside the container is never disturbed, and an old run
directory never gains a schema it did not have.

## What it shows

The index lists every directory under `data/runs`, newest first: model, driver,
shakeout flag, latest level and XP from the `state` table, start time, and how it
ended. A run counts as **live** when it has no termination reason *and* its
`trajectory.jsonl` was appended to within the last two minutes — "no termination
reason" alone is not enough, because a killed process never writes one.

The run page is a turn-by-turn feed: model text, snippets as code blocks,
snippet results with errors highlighted, harness notices called out, compact
one-line state samples, and a termination or pause banner. A small level/XP
sparkline comes from the `state` table.

The last 200 entries load first; **load earlier** walks backwards a window at a
time. On a live run the page follows the file over SSE and appends new entries as
they land, with an auto-scroll toggle.

## How it handles big files

`request` entries embed the whole model message array and `events_served`
entries embed every packet, so nothing ships the raw file to the browser. One
`TrajectoryTail` per run scans the JSONL forward from wherever it stopped,
splitting on bytes (0x0A can never occur inside a UTF-8 sequence, so a write
that lands mid-character is safe) and keeping only a small summary plus the byte
range of each line. Big fields collapse to counts; the full JSON of any single
entry is re-read from disk on demand behind a click.

## Endpoints

| path | what |
| --- | --- |
| `/`, `/run/<id>` | the single-page client |
| `/api/runs` | run listing |
| `/api/run/<id>` | run row, state series, entry count |
| `/api/run/<id>/entries?from=&limit=` | summarised entries (default: last 200) |
| `/api/run/<id>/raw/<i>` | the raw JSONL line for one entry |
| `/api/run/<id>/scratchpad` | the run's scratchpad.md |
| `/api/run/<id>/stream` | SSE: new entries as they are appended |

Tail and summariser logic is tested in `runner/test/viewer-tail.test.ts`.
