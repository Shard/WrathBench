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

The run page's top bar carries the platform and model slug (`openrouter ·
stealth/ox-alpha`, platform derived from `config.apiBase`), the current context
size, and the tokens the run has spent in total — prompt plus completion summed
over every turn, as a provider would bill it.

**These token numbers are estimates**, and the UI says so with a `~` and an
`est` suffix. The openai adapter parses only `choices[0].message` out of the
provider response, so `usage` never reaches the trajectory and there is nothing
recorded to read; the viewer falls back to characters ÷ 4. If a driver starts
logging `usage` on `request` or `response` entries, the viewer picks it up
automatically and drops the estimate marker. Making that real is a runner
change, not a viewer one.

The run page is a turn-by-turn feed: model text, snippets as code blocks,
snippet results with errors highlighted, harness notices called out, compact
one-line state samples, and a termination or pause banner. A small level/XP
sparkline comes from the `state` table.

Snippets, snippet results, and model responses longer than three lines are
folded by default with an `expand · N lines` toggle, so scrolling a long
history stays fast. The top-bar **expand** dropdown sets the default for the
whole feed — Minimal (default), Responses, Snippets (snippets, their results,
and responses), All expanded — and is remembered in `localStorage`. Individual
blocks stay click-toggleable whatever the preset.

While a run is live, an activity line sits at the foot of the feed with a
pulsing dot, a plain-language guess at what the session is doing, and a seconds
counter since the run last wrote anything. The guess comes from the type of the
newest entry, since the loop writes a fixed cycle: a `request` means it is
waiting on the model, a `snippet` with no result yet means the snippet is still
running, `events_served` means the next turn is pending, and so on. Past two
minutes of silence the line turns amber and says the run may have stopped. It
disappears when a `termination` entry arrives, replaced by the usual banner.

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
