# Architecture

## Components

```
 model  <--MCP-->  runner (Bun)  <--SDK calls-->  sdk (Bun)  <--HTTP/WS-->  module (C++ in worldserver)
                      |                                                            |
                      v                                                            v
              data/runs/<id>/  (trajectory JSONL, sqlite)                 AzerothCore worldserver + DBs
```

### module/ (C++, GPL-2.0-or-later, in-process with worldserver)

The licensing boundary follows this layout: `module/` is GPL-2.0-or-later; all other original WrathBench code and documentation, including `sdk/`, `runner/`, `dashboard/`, `wiki/`, `minimap/`, `infra/`, and `docs/`, are MIT. The build copies this module into the pinned AzerothCore tree; that relationship does not relicense AzerothCore itself or any other dependency.

A thin bridge. It does two things and should never learn to do a third.

- Actions: accepts typed requests over HTTP, constructs the corresponding client opcode (`CMSG_*`), and pushes it through the character's `WorldSession` handler. Every server-side check a real client is subject to (range, facing, GCD, cooldowns, reagents, quest prerequisites, gossip state) applies unchanged.
- Events: taps the outbound packet stream for the session (`SMSG_*`), filters it to the observation contract, and publishes it over a WebSocket as JSON.
- Session management: creates or logs in a character for a session token, logs out on release.
- Audit log: every action dispatched and every observation served, with a timestamp and the session id.

It knows about opcodes and sessions. It does not know what a quest, a rotation, or a route is.

How it attaches to the core: a bench session is a stock `WorldSession` handed a *parked* `WorldSocket` — a real socket around the server end of a loopback TCP pair the module connects to itself, never started, never registered with a network thread, never authenticated; it exists so the session's socket checks pass. Inbound actions go through `WorldSession::QueuePacket`, the same queue the real socket feeds, and are dispatched by the stock opcode table. Outbound packets are captured by a `ServerScript::CanPacketSend` hook that returns false, so nothing is ever queued on the unflushed socket. The idle kick is reset from `WorldScript::OnUpdate`; teardown is `CMSG_LOGOUT_REQUEST` then `CloseSocket()`, which the core reaps as a client disconnect. HTTP/WS are Boost.Beast (header-only, already in the core's Boost); JSON is a small hand-rolled builder because the core's Boost build has no `Boost::json` target. Coupling surface: `WorldSession::SendPacket`, `WorldSession::Update`, the `WorldSocket` constructor.

The mover (why the module owns movement and navigation detail:
`docs/METHODOLOGY.md`, "Client fidelity"): `move_to` resolves a path once with `PathGenerator` on the world thread; only a fully normal path whose endpoint lands within 4y (2D) of the request is accepted, a straight-line request beyond ~250y is `too_far`, a partial path is subdivided once. It then sends `MSG_MOVE_START_FORWARD`, a heartbeat every ~500ms and `MSG_MOVE_STOP`, each with `MovementInfo` interpolated at the character's live run speed, into the stock movement handlers. The module answers `SMSG_TIME_SYNC_REQ` itself so the clock delta settles near zero. Arrival is declared from the server-side position (3s deadline after the stop); >15y of drift between server and interpolation ends the move as `interrupted`. Areatrigger volumes (from the client's `AreaTrigger.dbc` on the data volume) and transport bounds are tested against the mover's position on each heartbeat. The update-object decoder keeps one guid→type map per session, pruned by destroy and out-of-range; compressed updates never reach the tap because compression happens at socket write. Shapes, statuses and constants: `module/PROTOCOL.md`.

### sdk/ (Bun/TypeScript, MIT)

The surface the model programs against. Thin typed wrappers over module actions, a typed event stream, and a small set of composed helpers that emerged from real runs (for example `moveTo`, `killTarget`, `lootNearby`, `acceptQuestFrom`). Helpers are added because a run needed them, not in anticipation.

The SDK is versioned. Its surface is part of the harness version.

### runner/ (Bun/TypeScript, MIT)

- MCP server exposing tools to the model: run snippet, read recent events, query state summary, search reference bundle, read and write scratchpad, reflect, log status, read log.
- Snippet sandbox: a persistent runtime per session so snippets share state and can leave routines running. Executes in a separate process with network access only to the module, an allowlisted environment carrying only the run's own leased session secret (never the module's port secret or a provider key), and a Linux Landlock filesystem ruleset applied before exec (`runner/src/sandbox/confine.ts`) so it can read the interpreter, `runner/`, `sdk/` and `node_modules/` and nothing else — not `.env`, not the home directory. Hard per-snippet timeout.
- Agent loop: model-agnostic. Fixed prompt, fixed event window and state summary, fixed retry policy. Persists scratchpad and summary so a session can resume after a process failure.
- Watchdogs: idle timeout, no-XP timeout, episode time limit, snippet runaway. Each ends the episode with a named termination reason.
- Trajectory log: JSONL per run containing every snippet, its result, every event batch the model saw, and a periodic state line (level, zone, XP, position).
- Model adapter: one OpenAI-compatible chat layer. Provider and model are run config.

**Harness-delivered hints.** The SDK attaches a per-status recovery hint to a failed action result (`moveTo` `too_far`, `target_off_mesh`, `drop`, …), but that hint reaches the model only if the snippet's own code keeps it: one run took 41 `too_far` refusals in four hours while reducing every result to `.status`, and read the hint zero times. So the client also tallies each hint-bearing failure per (action, status) on a channel the snippet cannot strip; the sandbox drains it once per snippet, and `tools.ts` renders it as a short `--- harness ---` block at the foot of that snippet's result — one line per status with a count, the hint text unchanged and nothing added to it. It goes in the tool result rather than the next turn's harness-notice block because a claude-code turn is a whole CLI session: a notice there would arrive a turn late, and delivery must not cost the model a follow-up inspection. Both drivers dispatch through the same `callTool`, so both get it, and the trajectory's `snippet_result` records it as part of what the model saw.

**Reflection, the episodic log, and the trim notices.** Three of the nine tools
exist because of the message window rather than the world (docs/METHODOLOGY.md,
"Reflection is the model's to take, and only at rest" and "An episodic log,
written before each trim, read back at rest"). `log_status` appends one
harness-stamped entry (turn, level, zone) to `data/runs/<id>/episodic.jsonl`,
which is append-only and therefore not the scratchpad. `reflect` returns a
fixed, content-free review prompt while the character's `resting` flag is set —
one reflection per rest visit — and opens a reflection window in which
`read_log` pages that log; the window closes when the character leaves the rest
area, on a 30-turn circuit breaker, or at the end of the run, and every
transition is a `reflect_window` record. After a sandbox restart the state
cache is rebuilt, so `resting` is unobserved until the next update block
carries `playerFlags` and the gate holds the last reading it was fed rather
than reading silence as "not resting" — the same latch discipline the ghost
flag has.

The fixed loop asks for an entry (`trim_pending`) on the last turn before a
block trim and says so afterwards (`window_trimmed`). That is exact rather than
predicted: a turn's message count is not known until the model has answered it,
so the cut is applied one turn *after* the crossing that earns it
(`laggedLength`), which turns an unanswerable question about the future into a
fact already sitting in the history. Every trim is preceded by exactly one
prompt, on the turn immediately before it, whatever the model's tool-call count
does; the price is that the window sits at most one turn's growth above
`MESSAGE_WINDOW_MAX` for that one turn, and the prefix stays byte-stable
because the cut still moves only in whole blocks.

The asymmetry between harness groups is deliberate and follows from the policy:
the claude-code driver runs no message window of ours, so it never raises
either notice and is never asked for a status entry. Its tool list is
identical — a tool that appeared on one harness and not the other would be a
second, quieter difference between them — so `log_status`, `reflect` and
`read_log` all work there; in practice its episodic log stays empty because
nothing prompts for entries, and one CLI session is one driver turn, which puts
the reflection breaker far out of reach. The standalone MCP server (`runner/src/mcp.ts`,
an operator's hand-driven mode) has no context builder at all, so nothing there
could ever observe the character leaving or count a turn: it answers `reflect`
and refuses `read_log` rather than serving the log through a window that could
never close.

### runner/viewer/ + dashboard/ (Bun/TypeScript, MIT)

The operator's read-only window on runs, live and finished. Split in two along
one line: the Bun process owns everything that needs the filesystem,
the SPA owns everything that is UI.

- `runner/viewer/` serves a read-only JSON API under `/api` (run listing, run
  detail and state series, summarised trajectory entries, the position feed, the
  fleet supervisor's published job state), an SSE tail per run, minimap tiles
  from `data/minimap/`, and the built SPA as static files. Every database is
  opened readonly, so a run being written inside the container is never
  disturbed. Bearer tokens are stripped from anything that forwards a raw
  record. `WRATHBENCH_VIEWER_PUBLIC=1` withholds raw entries and tiles — the
  unprojected record and Blizzard bytes — and serves entry summaries through
  the public projection and the game-prose redactor (`runner/viewer/README.md`).
  `WRATHBENCH_VIEWER_TILES_PUBLIC=1` opts tiles alone back in for a deployment
  whose operator has decided it may serve them (off by default, no-op outside
  public mode, private one-hour cache and `noindex` when on); the static public
  snapshot never carries a tile either way.
- `dashboard/` is a SolidJS SPA and the only UI: a homepage explainer at `/`
  (what the benchmark is, the loop, the tools as served by `/api/tools` so the page cannot drift
  from the runner), fleet at `/fleet`, about at `/about` (the tiers, the
  harness groups, how to read a score; `/episodes` redirects there), runs (the
  per-run grain), ladder, models, run detail, and the map view — minimap
  tiles decoded from the client's own MPQs into `data/minimap/` (gitignored),
  drawn on plain canvas behind a position-feed interface so replay can later
  plug a trajectory reader into the renderer that serves live runs.
  It imports three modules from the viewer rather than copying them — the API
  wire types, the world→tile transform and the freeplay lineage walk — so drift
  between the two sides is a compile error. It is the only place in the repository with a dependency graph;
  the harness itself still runs with no build step. Without a build on disk the
  viewer serves the API as usual and answers page routes with a plain-text
  notice naming `bun run --cwd dashboard build`; there is no fallback UI.
- **One page per grain, and the runs have their own.** The fleet page is what
  is running *now* and links to a run without listing them; `/runs` is the runs
  — one row per recorded run of every kind, opening on all of them newest
  first, every header sortable, the sort and every filter in the URL, and a
  value in a cell the link that narrows to it; `/about` is the tiers, what
  each id fixes and how many runs sit against it, listing no runs of its own;
  `/ladder` is the aggregates. Runs are listed in one place and one only — a
  page that opens with most of its rows filtered away is not that place — so
  `/results` redirects to `/runs` with its query intact, and there is no
  cost-per-level chart: the ladder's own columns already say how far each model
  got, and a cost view worth having is a page with its own reason, not a chart
  smuggled onto another one.
- **Every run belongs to a character, and the character has a page.** A durable
  freeplay character is one character across attempts, and everything the runner
  records is per attempt — so a reader could see only the session in front of
  them and the quest count was the last session's. The viewer aggregates the
  chain at read time (`character` on `/api/run/<id>`, `runner/viewer/character.ts`)
  and the run page leads with it: an attempts strip listing every attempt with
  its status, level and playtime, each a link; the character's
  level-against-cumulative-playtime line above this attempt's XP chart, drawn by
  the same `CharacterPlot` the freeplay field uses; and the character's totals as
  the sidebar's headline with this attempt's figures named underneath. The feed
  stays per attempt because a trajectory is one run's, with a link at each seam.
  The character is also a page of its own — `/character/<id>`
  over `GET /api/character/<id>` — carrying the whole chain's curve with the
  session boundaries marked, the totals, the live session when one runs, and
  every attempt. It is **universal, not freeplay-only**: a scored run's character
  is a chain of one attempt, so no page branches on "is this freeplay" to know a
  run has a character. Navigation stays freeplay-first — freeplay rows lead to
  the character, scored rows to the run. Nothing is written back: the record is
  per attempt and stays that way, which is also why an attempt predating a column
  contributes nothing rather than a zero.
- **The harness series is one shell-wide filter, not a per-page control.** The
  series — `major.minor` of a version stamp — is already the comparability
  group every page of runs is a view of, so the selector lives once, in the top
  bar, and filters every page that shows runs. Four pickers that could disagree
  about what a shared link meant is the failure the episode filter was
  consolidated to prevent. `latest` is stored as the token rather than the
  series it resolves to today, so it follows a minor bump instead of freezing;
  the newest series also appears under its own number, because `latest` tracks
  and a number pins. The choice lives in `?series=` so a link is shareable and
  in `localStorage` so a tab reopens where it was, URL first. A run whose stamp
  names no series belongs to no group and appears only under `all`, and what
  the filter removed is always stated on the page — the rule binds harder here
  because the control doing the dropping is in the header rather than on the
  page being read. Filtering is client-side over rows the API already carries,
  with `/api/info` (the route the shell already polls) naming the series that
  have runs, rather than a poller or a route parameter per control. Two pages
  are deliberately unfiltered: the fleet page is the deployed series by
  construction, and the models page is the scheduler's verdict computed
  server-side, where a client-side filter would make the counts and the list
  disagree. This is a different dimension from the harness filter, which
  selects which *loop* owned a run; both exist and compose, which is why this
  one is spelled `series` everywhere.
- **`infra/model-lineup.json` is the model identity catalog; the fleet config
  stays a scheduling catalog.** Every roster field in the fleet config is a scheduling
  fact and presentation has always been absent from its schema, so a cosmetic
  field there would be the first — and it would have to survive the four
  parsers kept deliberately in sync. The lineup file instead defines *families*
  (`{ id, name, vendor, icon, match }`) keyed by model-id glob patterns rather
  than roster names, so it recognizes an id wherever it turns up: the roster,
  run history, a map position. Matching is data-driven and dumb on purpose —
  lowercase the id, strip a trailing `:free`, take the first family whose
  pattern matches, file order being precedence — and an id no family matches
  gets a neutral monogram rather than a special case in code, which is the
  per-model override the harness forbids. Recognizing a new model is a data
  edit, never a code change. The mark appears wherever a model is the row —
  the runs table's model column, the ladder table's rungs rows, the fleet
  page's model cells and paused list, the models page's roster names, the run
  page's model card, the map's pips and sidebar, and the ladder scatter, whose
  marks are logo pucks. The scatter's harness colour lives on the puck's ring
  rather than its fill, so the legend reads as a ring and says exactly what a
  plain dot's colour said. Logos are fetched rather than drawn:
  `infra/fetch-model-logos.ts` pulls the npm tarball of the Lobe Icons package
  at the version pinned in the lineup's own `icons` block and extracts exactly
  the icons the lineup names; the SVGs are committed, because they are a few
  hundred bytes each and the dashboard has to build from a bare clone with no
  network. The CLI prunes assets no family references and has a `--check` mode
  so drift is detectable offline. The artwork is MIT-licensed and the brands
  remain their owners' trademarks; provenance is in `THIRD-PARTY-NOTICES.md`.
  The pricing table's display ids and the scheduler's family test stay where
  they are — billing and scheduling facts, not presentation, and folding them
  in would couple scheduling to a cosmetic file.
- Loopback by default. Trajectories carry game-derived text, so a non-loopback
  bind fails at startup unless `WRATHBENCH_VIEWER_LAN=1` opts a trusted private
  network in (docs/DATA-AND-LEGAL.md). What a public deployment may carry is
  docs/DATA-AND-LEGAL.md's to settle: minimap tiles are shown, and entry
  summaries are published one window per run with game prose stripped.
- **Public hosting is push-based, so the lab is never an origin.**
  `infra/publish-dashboard.ts` calls the viewer's own `createApi` handler
  in-process, applies an allowlist projection, and PUTs generation-addressed
  JSON to an R2 bucket on a timer (300s in both deployments,
`WRATHBENCH_PUBLISH_INTERVAL_MS`), manifest last so a reader never
  observes a torn generation; every public read is then a static asset or an
  edge-cached object and no inbound path to the harness exists at all. The SPA
  builds a second time in **snapshot mode** — a build-time
  `VITE_WRATHBENCH_SNAPSHOT_BASE` selects a client implementing the same
  `Client` interface over the bucket instead of `/api`, so the pages are the
  same pages and the private build keeps its same-origin, CORS-free posture.
  Design and cost model are docs/PUBLIC-DASHBOARD.md, the Cloudflare setup is
  docs/RUNBOOK.md ("Public dashboard"), and the gate above still binds.

### wiki/ (Bun/TypeScript, MIT)

Tooling to turn a locally held wiki dump into a searchable bundle the runner can serve. The dump and the bundle live in `data/` and are never committed.

### minimap/ (Bun/TypeScript, MIT)

Tooling for local map assets used by the viewer. The assets themselves are supplied outside the repository under `data/` and are not part of the MIT-licensed WrathBench source.

### infra/

Compose file for worldserver, authserver, database, module build, and runner. The server data directory is supplied by the operator under `data/`. Smoke script that drives one quest end to end through the SDK.

The core is stock AzerothCore, pinned by commit — no playerbots fork, so there
is one dependency tree; the party question waits for encounter work and will
be answered with data from real runs.

The worldserver image (`infra/docker/server.Dockerfile`) is a close adaptation of upstream AzerothCore's own multi-stage Dockerfile with the build context at our repo root: it copies the pinned submodule plus `module/` as `modules/mod-wrathbench` and keeps upstream's stage names, base image, toolchain, runtime user and filesystem layout, so upstream docker fixes diff cleanly against ours at each submodule bump. Two departures: `-DWITHOUT_GIT=1`, because a submodule checkout has no usable `.git` (version strings read `unknown`; the submodule pointer and `infra/PINS.md` are the pin), and a 10G ccache mount, because upstream's 1G thrashes on a full core build and module iteration is the hot path. RelWithDebInfo is kept because symbols matter when the module crashes the worldserver. A `db-import` target is built alongside because upstream's boot flow expects it.

## Data flow for one action

1. Model calls `run_snippet` via MCP with TypeScript.
2. Runner executes it in the session's sandbox; snippet calls `sdk.castSpell(id)`.
3. SDK posts `{action: "cast", spellId}` to the module.
4. Module builds `CMSG_CAST_SPELL` and hands it to the session's handler, as if the client had sent it.
5. Server applies its normal validation and effects.
6. Outbound `SMSG_SPELL_GO` or `SMSG_CAST_FAILED` is tapped, filtered, and published on the WebSocket.
7. SDK surfaces it as a typed event; the snippet or the model reacts.
8. Runner appends the snippet, result, and events to the trajectory.

## Reset

Every episode starts with a freshly created character at level 1 in its starting zone. Character creation is a client action the module supports. Character snapshots (DB save and restore for mid-level starts) are deferred.

## Persistence

- Run metadata and periodic state in `bun:sqlite` under `data/runs/`.
- Trajectories as JSONL next to it.
- Server state in the AzerothCore databases; the server is authoritative for XP, level, deaths, quests, gold.
- A single-node ClickHouse holding a **derived, disposable** copy of all of it,
  filled by `collector/`.

The files under `data/runs/` are the evidence record — the thing a result
claim points at — and stay the write path and the only authoritative copy.
Nothing downstream ever becomes the sole holder of a trajectory: the store
below is rebuilt from those files by one command, and is designed so that
losing it costs a backfill rather than a run.

### The derived store

The corpus was measured at 1,148 runs and 11 GB, of which 7.5 GB was
`trajectory.jsonl` and the largest single file 669 MB. Roughly three quarters of
those bytes are one field: `messages`, the rendered context re-logged on every
turn. Without a store, every cold request to a listing route opens every
`run.sqlite` over iSCSI and re-reads every trajectory to count what the
page shows. That is what the store is for.

**The runner does not change.** It appends JSONL and moves on, the way a
service logs. It does not know the store exists, has no client for it, and
fails in none of the ways a database client fails. All the ingestion
complexity lives in one place.

**The collector owns ingestion.** `collector/` is a separate Bun service that
polls `data/runs/`, tails each file from a byte offset it keeps in its own
small sqlite, and batch-inserts over ClickHouse's HTTP interface. Its
`--replay` mode walks every run from offset zero — and that is the backfill,
the recovery path *and* the steady-state code path, so there is no
rarely-exercised branch to be wrong when it is needed. ClickHouse being down
is a wait, never a loss: offsets advance only past rows the server has
acknowledged. `collector/README.md` is the detail.

**The store is derived and disposable, and the schema says so.** Every table is
`ReplacingMergeTree` on a key that replay reproduces exactly, so re-ingesting is
idempotent rather than additive. A trajectory line's key is its ordinal in the
file, never `(run_id, turn)` — one turn writes five or six lines and most record
kinds carry no turn at all. Every trajectory row keeps the whole line in `raw`,
so a record kind the schema does not name yet is still queryable, and the schema
can stay small without the store becoming lossy. Measured on this corpus:
`messages` compresses 29-46x columnar, against 4.2x for gzip over the whole
file, and 641 MB of one run's trajectory lands as ~32 MB of parts.

**Derivations are computed once, by the code that already existed.** Anything
that is a pure aggregate over typed columns — token sums, response counts,
first and last timestamp — is SQL. Anything ordering-sensitive — active
segments and playtime, the zone and death timelines, the level ladder, tokens
per second over reply spans — is a state machine, and a SQL reimplementation
would be a second implementation that can disagree with the first about a
published number. So the collector runs the viewer's own `RunTotalsScanner`
and `readRunFact` as it tails and stores the result as JSON on the run. Same
code, same bytes, by construction.

**The viewer reads the store; the supervisor still reads the files.** Every
listing route answers from ClickHouse. The live-progress path — "is this run
going right now", the supervisor's own polling of `run.sqlite`, the per-run
trajectory tail behind `/entries` and the SSE stream — still reads files
directly, because it asks about a process that
is writing at this instant. The live map is the half-way case: the store says
which runs are unterminated, and only those few have their `run.sqlite` opened. Retiring the per-run sqlite is a later step and
waits on the store carrying the live state series.

With no `CLICKHOUSE_URL` the viewer builds the same rows in memory by running
the collector's own ingestion over the runs directory — which is what a bare
clone, `bun run viewer` on a laptop and every test get. It is the same code
path, so a row means the same thing on both; it simply holds the answer in a
process instead of a database, keeping only `runs`, `run_totals`, `states` and
`moves` and dropping `turns`, `events`, `milestones` and `episodic` as they
arrive because a read path never reads them. That is a quickstart, not a deployment:
on the real corpus it does once per start what the store does once, ever.

## What is deliberately absent

Results pipeline, perturbation tooling, snapshot/restore, per-character credentials, multi-agent support, concurrency beyond a few sequential or lightly parallel characters on one server.
