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
- `WRATHBENCH_MINIMAP_DIR` overrides the tile root (default `data/minimap`).
- `WRATHBENCH_DASHBOARD_DIR` overrides where the built SPA is looked for
  (default `dashboard/dist`).
- `WRATHBENCH_VIEWER_PUBLIC=1` withholds raw entries, scratchpads and tiles.

## This directory is the API; the UI is the dashboard

Since ADR-0022 the UI is a SolidJS SPA in `dashboard/`, and this directory is
the API it reads plus the static host that serves it. Build it with
`bun run --cwd dashboard build`; the viewer picks it up from `dashboard/dist`
with no further configuration.

The hand-written pages this directory used to serve were deleted on 2026-08-22
(FOLLOW-UPS 31). There is no fallback UI: with no build on disk every page route
answers with a plain-text notice naming the build command, and `/api` keeps
serving throughout. What the dashboard renders is documented in
`dashboard/README.md`; what follows is what the server decides before the UI
sees it.

## Loopback only

The viewer binds 127.0.0.1. Trajectories contain game-derived text — quest text,
NPC and item names — and per `docs/DATA-AND-LEGAL.md` none of it leaves this
machine. Setting `WRATHBENCH_VIEWER_HOST` to anything else is a startup failure
that prints why, unless `WRATHBENCH_VIEWER_LAN=1` explicitly opts a trusted
private network in. That opt-in is for a LAN, not the internet: it lets someone
on the same network read pages, and reaches nothing else — the module stays
loopback regardless. Public hosting is intended eventually and is not this;
ADR-0022 carries what has to be settled first.

Opting in takes two steps, and the second is the one that gets forgotten:

```
WRATHBENCH_VIEWER_LAN=1 \
  WRATHBENCH_MODULE_URL=http://<worldserver container ip>:8086 \
  WRATHBENCH_FLEET_CONFIG=infra/fleet.json \
  bun runner/viewer/serve.ts            # now binds 0.0.0.0:8090

# and the host firewall, scoped to the LAN — NOT a bare --add-port, which
# would open 8090 to every network in the zone:
sudo firewall-cmd --permanent --zone=public --add-rich-rule=\
  'rule family="ipv4" source address="192.168.1.0/24" port port="8090" protocol="tcp" accept'
sudo firewall-cmd --reload
```

`--permanent` matters: a runtime-only rule is lost on the next reload or reboot,
which is how this was set up the first time and why it stopped working. Note that
`curl http://<lan-ip>:8090` **from the host itself** succeeds even with the port
firewalled — that traffic is delivered over `lo` and never crosses the zone — so
verify from another machine, or the check proves nothing.

It also only ever reads. Each `run.sqlite` is opened readonly, so a run being
written by the harness inside the container is never disturbed, and an old run
directory never gains a schema it did not have.

## The run listing

`/api/runs` lists every directory under `data/runs`, newest first: model,
unscored stamp (the legacy `shakeout` key), harness tag, character, harness version, latest level, XP, money and completed
quests from the `state` table, when it started, playtime, total tokens, and how
it ended.

Playtime (`playtimeMs`, on the listing rows and on `/api/run/<id>`) is *active*
time, not the span the trajectory covers: a segment opens at the `meta` record
and at each `resume`, and closes at each `pause` or `termination`, with an open
segment running to now for a live run and to its last entry otherwise. A run
that a rate limit paused and `--resume` picked up hours later would otherwise
read as having played through the gap. It is computed here, once, so the fleet
table and the run page cannot disagree. Note that this is not the
`episode-limit` watchdog's clock, which is per-process uptime since the current
resume and so never sees paused time.

Tokens per second (`tps`, on the listing rows and on `/api/run/<id>`) is output
tokens over the wall time of the model's REPLIES, never over the run's elapsed
time, most of which the harness spends driving the game. A span opens at a
record that hands the model something to answer — the `request` on the fixed
loop, the `snippet_result` or `tool_result` the CLI was waiting on under
claude-code — and closes at the last `response` before the next such record.
Replies rather than turns because a turn is not the same unit under the two
drivers: `fleet-sonnet-e360-sonnet-20260824` is one `request` and 2,833
`response` records, so timing "a turn" there would time the whole six-hour
episode. Ambient records (`state`, `milestone`, `claude_system`) are ignored
rather than treated as boundaries — they are written by timers while the model
is mid-reply, and one restarting the clock reads as a speed the model never had.
A span still in flight, and one a `pause`/`resume`/`termination` landed inside,
count for nothing. Two figures ride together: the whole run, and the last ten
replies, each summed as Σ tokens ÷ Σ seconds rather than averaged over replies.
Tokens are provider-reported where any response of the span reported usage and
`chars ÷ 4` only where none did — the claude-code driver's last envelope carries
the running total for the whole reply, so estimating the earlier ones alongside
it would count their text twice (which `TokenTotals.completionTokens` still
does; FOLLOW-UPS 82).

The figure is comparable within a lane and NOT between the two drivers: a
claude-code span runs from the result the CLI was handed to the reply that came
back, so it carries the CLI round trip as well as the generation, where a fixed
loop span is request-to-response with no such hop in it. Read it as "is this run
moving", never as a model's generation speed.


The `state` table gains signals over time and an old run directory never gains
them retroactively, so the viewer asks each database what columns it has before
selecting: `money` and `quests_completed` come back null where the schema
predates them. Zero is a real reading — a broke character has 0 copper — so only
a missing value is null, never a recorded zero. Playtime is the wall clock the
trajectory spans, first entry to last. A run counts as **live** when it has no
termination reason *and* its `trajectory.jsonl` was appended to within the last
two minutes — "no termination reason" alone is not enough, because a killed
process never writes one.

Getting a token total per run means reading every trajectory, so the server
memoises each run's totals on the file's size and mtime: a finished run is read
once per process, a live one only as it grows, and the scan keeps a few numbers
rather than a summary per entry.

## Token accounting

The runner records a provider `usage` block on `response` entries whenever the
provider returns one, so those counts are measured. Cache figures a provider
never mentions come back null, never `0`: an OpenAI-compatible endpoint reports
cache reads as `cached_tokens` and says nothing at all about writes, and
"unknown" is not "none". **Runs recorded before usage logging landed report
estimates instead** — characters ÷ 4, flagged as estimated — and newer runs
carry provider-reported counts automatically; the viewer decides per run by
whether it finds any usage in the file. A turn's reported prompt size replaces
the estimate for that turn, so the two never double-count.

The one exception is the claude-code harness (driver id `claude-code`, formerly
`claude-subscription`). Its
driver discarded the CLI's usage objects until 2026-08-22, and a characters ÷ 4
estimate over a session that reuses an enormous cached prefix is off by orders
of magnitude — so those runs report no usage rather than a number that would
mislead. Runs recorded after the fix carry real counts, cache writes included.

## Positions, the map feed, and tiles

`/api/positions` is the feed behind the map: for every run with no termination
reason, the newest `state` row that actually carried `map, x, y` — not simply
the newest row, since a level-only sample would otherwise blink an agent off the
map — dropped if that reading is more than ten minutes old. Per ADR-0019 the
renderer consumes only that array and never touches the run store, which is what
lets a replay mode plug a trajectory reader into the same shape later. The
coordinate transform lives on its own in `worldmap.ts` (`tile = 32 −
coord/533.33325`, world X → tile row, world Y → tile column) with no imports,
for the same reason, and the dashboard imports it rather than copying it.

Tiles come from the minimap extraction in `minimap/`, which writes
`data/minimap/<mapId>/<row>_<col>.png`; `/tiles/<mapId>/<row>_<col>.png` serves
them straight from there, integers only and cached for a year since they never
change. Nothing extracted yet is a normal state, not an error: a missing tile
draws as a labelled grid square, so the map works on a machine that has never
run the extraction. `WRATHBENCH_MINIMAP_DIR` overrides the tile root.

## How it handles big files

`request` entries embed the whole model message array and `events_served`
entries embed every packet, so nothing ships the raw file to the browser. One
`TrajectoryTail` per run scans the JSONL forward from wherever it stopped,
splitting on bytes (0x0A can never occur inside a UTF-8 sequence, so a write
that lands mid-character is safe) and keeping only a small summary plus the byte
range of each line. Big fields collapse to counts; the full JSON of any single
entry is re-read from disk on demand behind a click. The SSE tail heartbeats
once a second, so a quiet run can be told from a dead connection.

## Endpoints

Everything under `/api` is read-only: no route accepts a body, every database is
opened readonly, and the runs directory is only ever listed and read.

| path | what |
| --- | --- |
| `/api/info` | what mode the viewer is in: public, dashboard built |
| `/api/runs` | run listing, with per-run token totals and active playtime |
| `/api/positions` | position feed: every live agent's latest map/x/y plus a preview |
| `/api/fleet` | the fleet supervisor's jobs, accounts, gate and heartbeat |
| `/api/run/<id>` | run row, state series, entry count, token totals, playtime |
| `/api/run/<id>/entries?from=&limit=` | summarised entries (default: last 200) |
| `/api/run/<id>/raw/<i>` | the raw JSONL line for one entry |
| `/api/run/<id>/scratchpad` | the run's scratchpad.md |
| `/api/run/<id>/stream` | SSE: new entries as they are appended |
| `/tiles/<mapId>/<row>_<col>.png` | one minimap tile from `data/minimap/` (404 when not extracted) |
| anything else | the built SPA, or the not-built notice when there is none |

### What it will not serve

The `meta` trajectory entry embeds the whole run config, bearer token included,
and the generic summariser used to copy it wholesale — so both `/entries?from=0`
and `/raw/0` served it. Redaction is keyed on field name at any depth and applied
at the two places a raw record can reach a client (`summarize` and
`TrajectoryTail.raw`). `apiKeyEnv` is deliberately kept: it names an environment
variable, and the value of that variable is never written to the trajectory.

`WRATHBENCH_VIEWER_PUBLIC=1` additionally withholds the three routes that carry
verbatim game text or Blizzard-derived bytes — raw entries, scratchpads and
minimap tiles. It is opt-in-to-public, not opt-in-to-raw: the run page depends on
raw bodies, so a public deployment sets the flag rather than the developer
clearing it. See ADR-0022 for the legal question that is still open.

Tail and summariser logic is tested in `runner/test/viewer-tail.test.ts`; the
coordinate transform, the position feed and tile path validation in
`runner/test/viewer-map.test.ts`; the API surface, redaction and static hosting
in `runner/test/viewer-api.test.ts`.
