# Runbook

How to run the harness day to day. Architecture is in `docs/ARCHITECTURE.md`;
what the agent may see and do is `wrath-mcp/docs/CONTRACTS.md`. Bringing the stack up on
a fresh machine is `infra/README.md`.

The fleet runs on Kubernetes from the Helm chart at `infra/chart/wrathbench`.
`infra/compose.yml` is the single-machine quickstart (`infra/README.md`, "Try
it on one machine"): the same services, brought up, used and brought down,
with no deploy window, update script or rollback. The release and update
procedures below are the cluster's.

The operator commands are `bun wb <group> <command>`, run from the repository
root (`infra/wb.ts`). `bun wb` lists them, and `bun wb <group>` shows the
script each one runs and where. A command that reads the data volume runs in
the runner pod, the rest run on your machine, and the arguments after the
command go to the script untouched. `bun wb --local …` targets the quickstart
stack instead, where a command has a compose form.

| To | Read |
| --- | --- |
| start, stop or watch the fleet | "Start it", "Watch it", "Stop it" |
| look at a run | "Inspect a run" |
| change what runs, or pause a character | "Steer it", "Config reference", "Strict keys, and how to pause a character" |
| add a model | "Adding a model" |
| ship code | "Deploy window" |
| restart the supervisor without a release | "Updating the live fleet" |
| deal with a run that stopped without a verdict | "Lapsed runs: paused, and stale" |
| see why a model is or is not scheduled | "The scheduling policy" |
| run a probe campaign | "Probe campaigns", "Run pods" |
| launch one episode by hand | "Ad-hoc launches", "The scripted reference run" |
| manage provider credentials, their slots and their budgets | "Credentials" |
| switch the runner, evals or viewer group off | "Groups" |
| edit the fleet from the browser | "The admin interface" |
| back up, move or restore a character | "Backing up and moving a character" |
| operate the public site | "Public dashboard" |

## Running the fleet as a service

The fleet supervisor (`infra/run-fleet.ts`) is a long-lived service: the
`wrathbench-fleet` Deployment on the cluster, the `fleet` service on the
quickstart stack, both from the runner image. It has no deadline and is
steered entirely through the config store, which it re-reads every 60 seconds
("Where the config lives"). The update verbs, `bun wb fleet
graceful|force|drain|resume|state` (`infra/fleet-update.sh`), speak only
kubectl.

### Start it

```
kubectl -n wrathbench scale deploy/wrathbench-fleet --replicas=1     # the cluster
docker compose -f infra/compose.yml up -d --no-deps fleet            # the quickstart
```

On the quickstart `--no-deps` is not optional: without it compose may decide
the worldserver is out of date and recreate it, dropping every live episode.
The service sits behind the `fleet` profile so that a bare `up -d` cannot start
a second supervisor against the same config.

### Watch it

```
bun wb fleet status                                     # read-only report
kubectl -n wrathbench logs -f deploy/wrathbench-fleet   # supervisor stdout
kubectl -n wrathbench exec deploy/wrathbench-runner -- tail -f data/runs/fleet-<job>-<stamp>.log   # one job's roster stdout
docker compose -f infra/compose.yml logs -f fleet       # supervisor stdout, quickstart
```

`bun wb fleet status` is the supervisor's `--status`, run in the runner pod
because it reads `data/runs/fleet-state.json` on the data volume. Liveness is
a heartbeat the supervisor refreshes each tick, so a supervisor gone for more
than three ticks reports `NOT RUNNING`. Finished runs get no rows there: the
run directories and `fleet-<stamp>.jsonl` are the record.

### Inspect a run

```
bun wb inspect live                                  # every run with a heartbeat, one line each
bun wb inspect run <run-id> [--since 2h] [--until 1h] # verdict, level, quests across restarts, counts, errors by class, marks, cost, sizes, trace
bun wb inspect trajectory <run-id> --errors --last 10
bun wb inspect trajectory <run-id> --since <iso> --next 20   # the first 20 after a moment
bun wb inspect tools <run-id> [--since 2h] [--until 1h]       # calls per tool, ok/error, reflect granted/refused, pad writers
bun wb inspect pad <run-id> [--since 2h]                       # pad size over time, writes, cap refusals, drops flagged
bun wb inspect pad <run-id> --at <iso>                         # the pad's text at a moment, rebuilt from the record
bun wb inspect stuck [<run-id>] [--window 2h] [--until 1h]     # no game progress over a window, and the failure signals in it
bun wb inspect session <run-id> [--stream calls] [--character Name] [--kind death,level] [--grep RE] [--last 20]   # a v1 run's record, a line per row
bun wb inspect audit <run-id> [--op WB_MOVE_RESULT [--status S]] [--since 1h]
bun wb inspect audit <run-id> --summary --op move_path,WB_MOVE_RESULT   # move verdicts by op
bun wb inspect audit --smoke edge-drop --op move_edge_drop --since 1h   # a smoke's sessions (from the smoke-session ledger)
bun wb inspect publisher [<run-id>]                  # last flip, versions per run, the secret scan, last passes
```

All read-only and bounded: a trajectory line is never printed whole, only
capped fields of it, and the session token is struck from everything printed.
A run is live when its row has neither a termination nor a pause; one with
neither whose heartbeat is older than two minutes has lost its process and
reads `ownerless`.

`live`, `run`, `trajectory`, `tools`, `pad`, `stuck` and `session` are
`infra/inspect-run.ts` in the runner pod. Before a release ships a change to
it, the same file runs in the pod from stdin:
`kubectl -n wrathbench exec -i deploy/wrathbench-runner -- bun run - run <run-id> < infra/inspect-run.ts`.

All but `session` read a run's row, its state samples and its trajectory from
ClickHouse (the runner pod's `CLICKHOUSE_*`), never by walking a live 0.5
run's `run.sqlite`: a full read of one held it against the runner's writer
long enough to kill the run. The heartbeat, a few `meta.json` fields, file sizes,
`scratchpad.md`, the nearby ring and the trace stay on the files. Every view
carries a `source` line: `ClickHouse through <time>, 8s behind the file`,
flagged as the collector being behind or down past two minutes, or `the
files: <why>` when there is no `CLICKHOUSE_URL`, ClickHouse does not answer,
the run is not in it yet, or `--files` was given. The fallback reads
`trajectory.jsonl`, which a reader cannot lock. A v1 run is read whole off
its files: its row is `meta.json`'s and its level, quests and samples are its
session record's, none of which a reader can hold. A fan-out run is read per
character, each off its own record in `sessions/<Character>/` (the store's
rows under `<run-id>~<Character>`): `run` prints a block per character, `live`
a line per character under the run's, and `session` reads them together, each
line naming its character. A v1 run's `marks` (deaths, levels gained, zones,
turn-ins) are its record's `events` rows, not trajectory records, and
`session` is the reader of its `events` and `calls` streams that `trajectory
--grep` was on 0.5. `run`'s `cost` line is the whole run's: the provider's
own charge where it reported one (OpenRouter's per response, the Claude Code
CLI's per session) and the tokens the responses reported; the list-price
figure is the viewer's. A 0.5 run's `run.sqlite`
is opened only when it has no fresh heartbeat, so a live one's row reads
`unread` and its level `not read`. Each query is `readonly=2`, capped at 60 s and 256 MiB, and
tagged `log_comment = 'wb inspect'`, so on a Code 241 `system.query_log` shows
whether inspect was in flight.

`audit` and `publisher` read where the data lives. The audit log's files are
named by the token's fingerprint, the first 16 hex characters of its SHA-256
(files from before stack 0.2.0 by the token itself), so `inspect audit` reads
the token from the run's `meta.json` and hands it and its fingerprint on
stdin to `infra/inspect-audit.pl` inside the worldserver container, which
reduces the files there and prints counts or struck records, never a file
name. A smoke has no run: every smoke names its sessions through `smokeToken`
(`infra/smoke/lib/session.ts`), which records each fingerprint under the
smoke's name in `data/runs/smoke-sessions.jsonl`, so `--smoke <name>` (or
`<name>-<role>`, like `group-a`) reads that smoke's sessions.

`stuck` is the detector for a run that keeps talking while its character goes
nowhere. It judges a trailing window (two hours by default, ending now, or at
an ended run's last record, or at `--until`) from the character's samples: any
rise in level, xp or quests, any change of money, items or map, or straying
more than 50 yards from where the window began is progress, and none of it is
`STUCK`. The window must be covered, or the verdict is `unjudged`, since
nothing recorded is not no progress; a young or just-resumed run is never
flagged. What covers it depends on the run:

- a 0.5 run sampled its state every minute (`state` rows), so its samples
  must be at most 15 minutes apart and reach both ends of the window;
- a v1 run's trace writes a change and nothing between, so a character
  standing still has no trace row for hours. Its window is covered by the
  record's other writes as well: the `calls` and `events` rows and
  `live.json`'s heartbeat. The reading it starts from is the newest sample
  before the window, so a level gained just inside it is still progress. A
  character standing still while its record is written reads `STUCK`; a gap
  of more than 15 minutes with nothing written at all reads `unjudged`;
- a fan-out run's characters are each judged so off their own records, and
  the run is `STUCK` only when every one is: one agent moving any of its
  characters is making progress.

Only that verdict flags a run. Beside it, each marked tripped or not with its
count: the same error repeated (digits folded), the harness-delivered hint
tallies, `events_served` records carrying a `schemaError`, sandbox restarts,
and, as a labelled heuristic, responses that read as addressed to the
operator. With no run id it prints one line per run with a live owner. Every
threshold is a flag; the defaults are `STUCK_DEFAULTS` in
`infra/inspect-run.ts`. It reports and nothing more: no record is written and
nothing acts on the run. `bun wb fleet status` flags a live run with the same
verdict, by the same rule for each kind of run (`!! STUCK: …` on its account
row), from its newest samples (a v1 run's trace with its record's other
writes, folded on from the last poll; a 0.5 run's newest `run.sqlite` state
rows by rowid), a few milliseconds per live run. The flag is reported only:
the fleet never acts on it. The failure signals are `inspect stuck`'s alone.

### Where the config lives

**The sqlite config store is the only fleet config.** It is operational
state, never committed to git: `config.sqlite` on the data volume, beside
`runs/` (`$WRATHBENCH_DATA/config.sqlite`, overridable with
`WRATHBENCH_CONFIG_DB`). On the cluster that is the `config` subPath of the
`wrathbench-data` PVC, mounted writable on the fleet, the runner, the viewer
and the publisher; under compose it is `data/config.sqlite` on the bind
mount.

The one config document in git is `infra/fleet.example.json`, the bootstrap:
a newcomer seeds the store from it once and gets a working board, with no
campaign or queue job that would run. Nothing else reads it. An export renders
the store to a document for reading or diffing, never for committing.

- The supervisor reads the store on boot, on every 60s re-read and in
  `--status`. The viewer's `/api/models`, `/api/campaigns` and `/api/config`
  and the publisher read the same store.
- An edit is live **one tick later**, with nothing restarted. A tick can
  land between two writes, so write a credential (`credentials/<id>`) before
  the roster entries that need it.
- Every write is validated against the whole config, refused with the
  sentence the supervisor would use, and recorded in the store's
  `config_audit` table with the actor, the note, and the before and after
  documents. That table is the history.
- An **empty** store (zero rows, or no file yet) is a legitimate state: the
  supervisor runs an empty board and names the seed command every tick,
  `/api/config` answers `seeded: false`, and the `/config` page shows the
  seed instruction. Nothing drains a live run because of it.
- A store that **cannot be opened** (locked past the busy timeout, corrupt, a
  permissions slip) is treated like a document that does not parse: the
  supervisor keeps its last good config, complains once and retries every
  tick, and `--status` leads with the `config REJECTED` banner. A transient
  read failure never reads as "every job vanished".

Edit it from the **viewer's `/config` page**, the admin interface ("The admin
interface"): it and its API exist only on a viewer with the admin switch on,
which the chart leaves off (`admin.enabled`), and never on the public build.
The viewer has no login; it answers only to its own names, `localhost` and IP
addresses (`runner/viewer/README.md`, "Host allowlist"). On the cluster its names are the chart's
`viewer.ingress.host` and `extraHosts`; elsewhere they are
`WRATHBENCH_VIEWER_ALLOWED_HOSTS`. Any other name gets a 421.

```
# the CLI — for a script, or a viewer that is not up
bun wb config seed                     # once, on a fresh deployment: infra/fleet.example.json (--force replaces)
bun wb config get roster/sonnet
bun wb config patch roster/sonnet '{"tier":"t2"}' --actor operator --note "promote"
bun wb config audit 20
bun wb config credentials                            # the credentials, in preference order ("Credentials")
bun wb config credentials add claude-2 '{"provider":"claude","secretEnv":"CLAUDE_CODE_OAUTH_TOKEN_2","slots":1,"budget":{"kind":"usage"},"billing":"paid","enabled":true}'
bun wb config credentials edit claude-2 '{"slots":2}' --note "why"
bun wb config credentials disable claude-2 --note "why"   # no new run takes it; live runs finish
bun wb config move-credential <run-id> claude-2 --pin --note "why"  # a paused run to another credential ("Moving a run to another credential")
bun wb config export > /tmp/fleet.json # to read or diff; never to commit
```

`bun wb config` runs `runner/src/config-store.ts` in the runner pod, where
the store is. A file argument is a path inside the pod, so an export goes to
stdout and is redirected on your side. The endpoints behind the page are the
same operations over HTTP (`runner/viewer/README.md`).

### Steer it

Edit the config, on the `/config` page (with the admin switch on) or with the CLI. Nothing to restart.
The unit you steer is the **job**: a roster entry (or a rotation of several),
an episode and a repeat count, on one account — pinned to it when the job
names an `account`, otherwise on whichever pool account is free, and on the
first credential that serves its model and has room ("Credentials").

- `"enabled": false` — the job **drains**: no signal while it has an episode in
  flight, SIGTERM at the next episode boundary. A pool job frees its account
  when the process exits; deleting a job from the queue drains it the same
  way. The drain is also written beside the job's log (`<jsonl>.drain`),
  which the roster checks before every launch, because it starts its next
  episode faster than the supervisor's once-a-tick look. Re-enabling the job
  before the boundary removes it.
- `"enabled": true`, or a brand-new job — spawned on the next tick (a pool job
  when an account is free) for what its `repeat` still owes. `enabled` belongs
  to a job; on a roster entry it is refused ("Strict keys, and how to pause a
  character").
- **`repeat: n` is a total, counted off the runs on disk.** A job's progress
  is the counted runs its ref already has on that episode in this harness
  series: the same runs the policy's tier target counts (`isCounted`, archive
  included), whoever launched them. A run that ended `manual`,
  `attempt-failed`, `stale`, `adapter-error`, on a harness error or with no
  model response does not count and is redone under a fresh run id; a run in
  flight does not count yet. A job whose count is met is **done**: it spawns
  nothing across restarts and releases, and `--status` shows `(3/3 counted) —
  done`. To get more runs, raise `repeat`; flipping the job off and on adds
  none.
- A job whose process exits while enabled is finished for the life of that
  supervisor, even if a copy did not count. A supervisor restart, or flipping
  the job off and on, retries what it still owes, so a job that can never be
  satisfied (a dead endpoint) costs its remainder once per boot or flip and
  never loops.
- A malformed edit is complained about and ignored; the last good config
  keeps running. `bun wb fleet dry-run` checks one first. The store validates
  every write, so a rejected config is rare: a shape the running code does
  not read, or a store it could not open.
- While the config is rejected, **every `enabled` flag in it is inert**,
  including a later edit disabling a job. `--status` leads with a REJECTED
  banner, which comes from the supervisor's own state file: trust it over your
  own reading of the store, because the supervisor's verdict is the one that
  decides what runs.

Two enabled jobs must not share an account, a pinned account may not be in the
pool, and the roster policy is enforced on every entry at every re-read:
claude models run only on the claude-code driver, which runs only claude
models.

Billing is derived, not policed, so no model id is refused for what it costs.
An entry the rules put on the wrong side (a stealth id quoted at zero with no
free suffix, say) states `billing: "free"` or `"paid"`, and its runs carry
that word to every reader. To the scheduler it says only which credential may
carry a run: on a metered provider a free credential carries only free models
and a paid one only paid ones, so a free tier's shared key and a paid key are
two credentials even when one secret serves both. OpenCode Go is a provider
of its own (`opencode-go`), apart from Zen on the same host.

#### Config reference

The shape below is what `infra/fleet.example.json` shows and what an export
renders; a store row is one piece of it (a singleton block, or one roster
entry, campaign or queue job). "Changing the config shape" is how a shape
change ships.

```
preflight   the gate ("The preflight gate"): enabled, account, smokes [{script, account}], timeoutMs,
            deploySmokes (empty), deployTimeoutMs. Its accounts may not be in the
            pool or on a job.
accounts    { pool?: [...], max? }, or absent — the one account pool: every account a run that
            names none is drawn from, one live session each, at most `max` live at once
            (default: all). Absent, the generated pool POOL01 … POOLnn the chart sizes ("The
            account pool"); a listed pool replaces it, in preference order, and an empty list
            drains it. Never PROBE, never SMOKE*, never the gate's, and a POOLnn name is never
            listed or pinned: those are refused by name. `pinned` is derived from the jobs and
            refused if authored.
credentials id -> { provider, secretEnv, slots, budget?, billing, enabled }, in preference order
            ("Credentials"; `runner/src/credential-slots.ts`). The NAME of the env var holding each
            secret, never the secret. A seeded store's examples are all disabled.
roster      name -> entry. The keys an entry may carry are `ROSTER_ENTRY_KEYS`
            (runner/src/roster-refusal.ts) and nothing else; anything else REFUSES the entry by
            name ("Strict keys").
            NO character name: the model names its own at createSession. `character` is REFUSED
            by name here (as it is in a campaign or a cell). `race` and `class` stay: they are
            the episode's comparability dimensions. Never an account. Two scheduling axes
            (docs/METHODOLOGY.md, "The tier is the evidence budget"):
            `tier` — REQUIRED, and the only thing that sets a run count. t0 trial (e90 x1, the
              ladder is HELD and it never climbs on its own), t1 standard (e90 x3, climbs to t2 on
              one counted level-5 e90), t2 long (e90 x3 + e360 x1). The table is code
              (`TIER_TABLE`, runner/src/models.ts) — a bespoke volume is a NAMED tier added there,
              not a number edited into one entry. On EVERY entry.
            `objective` and `wikiCoords` — REFUSED. Steering is a campaign, which names this entry
              in an assignment and supplies its own task shape.
            `idle` — what it does with an account once its tier is spent. `none` (default, and
              what a paid model wants) or `unlimited` (one continuous freeplay session at a time,
              with no episode wall clock — the idle watchdog is what ends it). Flipping
              `unlimited` → `none` pauses the live session at once; flipping it back brings the
              same character back ("Freeplay characters are durable").
            `routing` — which backend behind OpenRouter may serve this entry. Three spellings:
              a provider name (`"Z.AI"`), a list in preference order (`["Z.AI", "Together"]`), or
              the object `{ order, sort, allowFallbacks, requireParameters }`. `sort`
              (price|throughput|latency) is an ALTERNATIVE to `order` and refused alongside it;
              `allowFallbacks` defaults to false, so a request a named provider cannot serve FAILS
              rather than moving to another machine. Absent means the model author's own provider,
              fallbacks off — `openai/...` pins OpenAI, `z-ai/...` pins Z.AI
              (`LAB_PROVIDERS`, runner/src/routing.ts). An author with no first-party endpoint on
              record pins nothing and still never falls back; name the provider here to pin it. An entry that declares an
              `effort` also requires the parameter by default, so a backend that would silently
              drop `reasoning_effort` is skipped rather than mislabelling the matrix cell.
              OpenRouter entries ONLY: on a claude-code/codex entry, or an apiBase that is not
              OpenRouter (Cerebras, LM Studio, OpenCode Zen or Go), `routing` takes the whole file
              down. The resolved routing is stamped into the run's comparability tuple and the provider that actually served it is recorded on
              the run (docs/METHODOLOGY.md, "Routing is pinned"); with fallbacks off the two
              agree, which is what makes a disagreement worth seeing. An OpenCode Go run cannot be
              pinned and stamps `{ via: "OpenCode Go", allowFallbacks: true }` ("Adding a
              model"). The field is absent, not null, on a run whose request has no routing to
              state (a CLI harness, Cerebras, LM Studio, OpenCode Zen).
            `wiki` — whether this entry's runs get the reference wiki at all. Default true; set
              `false` and the run has no `search_reference` tool, the prompt does not name one,
              and no bundle is opened. It is a capability switch declared on the run, not an arm bought out of the tier budget, so
              `wiki: false` is stamped into the comparability tuple as a KEY and those runs never
              share a chart with the runs that had it. `wikiCoords` alongside it is REFUSED:
              coordinates are a setting of a surface this entry does not have. A probe drops it
              with the other run dimensions — a campaign owns its own task shape.
            `compactWindow` — claude-code and codex entries ONLY: the CLI's auto-compaction
              window, `"auto"` or 100k–1M tokens (`"100k"`, `"500k"`, `"1M"`). `"auto"` is the
              CLI's own window, which sits near the model's whole context (codex: 90% of the
              catalogue window). ABSENT is the driver's default: on claude-code 300k (operator,
              2026-11-10), on codex the CLI's `auto`. A fresh freeplay session and a campaign's
              square take the 300k now. A scored episode (e90, e360) takes it only from the
              series after 0.5 (`defaultCompactWindowScoredAfter`, runner/src/drivers.ts): in
              0.5 an entry with no window still launches its scored runs on `auto`, so its
              scored rows stay on one window and nothing is owed again. A claude-code entry that
              should stay on the CLI's window says `"auto"`. A STATED window at or above what the
              CLI would apply anyway (the
              model's context on claude-code, that 90% on codex) ends the run as `harness-error`
              after its first turn. The default never does: on a model whose context is 300k or
              less the CLI compacts at the model's own limit, the run plays on, is recorded at
              the 300k it was given, and its trajectory carries a note of the clamp. The default
              is not a resume's: a paused run keeps the window it recorded, and one
              that recorded none ran on `auto` and stays there; a freeplay character moves to
              300k at its next fresh session. Normalised on load (`"100K"` → `"100k"`, `"1000k"`
              → `"1M"`; `"auto"` → absent on codex, kept on claude-code); on any other driver,
              or out of range, it takes the whole file down. A run dimension like `effort`
              (operator decisions 2026-10-09, and 2026-10-11 for codex): stamped into the tuple
              as a KEY — a defaulted run carries `300k` like a stated one, and a run with no
              window is an `auto` run whenever it was written — part of the run id when the
              entry states one, and part of what maps a run back to its entry: a stated window
              owns exactly its runs, so a copy of an entry that differs only in its window owns
              its own runs and its own tier budget, and an entry with none owns the runs it
              launched at its driver's default, the `auto` runs from before 2026-11-10 with the
              300k runs since. Its targets, its paused run and its character are therefore what
              they were, while results still group on the tuple: `auto` and `300k` runs of one
              entry are two rows, which in 0.5 only a freeplay character or a probe can show,
              since its scored runs all stay on `auto`. Pages show a run's window after the effort
              (`max · 100k`). Mechanics: runner/README.md, "The compaction window".
            `apiBase` — openai and pi entries: the endpoint (absent: OpenRouter). Its host is the
              entry's credential provider (`providerOfModel`, runner/src/credential-slots.ts): a host the
              provider table owns, over https, or a self-hosted host the deployment lists in
              `WRATHBENCH_LOCAL_MODEL_HOSTS` (chart: `localModelHosts`). Any other base REFUSES the
              entry by name, and run.ts refuses to start one. An entry never names a key: the key is
              its credential's, and a roster write carrying `apiKeyEnv` is a 400. A new provider is a
              row in the provider tables, not config.
            `credential` — optional: pin this entry's runs to one credential, by id. They take that
              one or wait for it, never another. Normally absent. A pin that cannot carry the entry
              (not configured, another provider's, the other billing side) refuses the entry by name.
            A t0 model that reaches level 5 KEEPS the witness (`t0*` in --status) without spending
            it: move it to t1 and it promotes at once on evidence it already has. Moving a model
            by hand is always allowed and never records a promotion — "promoted" is said only of
            a climb.
policy      Only where runs execute. `maxSessions { <driver>: n }` — how many sessions of a driver
            one host carries at once, whichever credential pays (each CLI session is a process and a
            sandbox): the one cap that is not a credential's. Absent: none beyond the slots.
            Billing is derived per model (free slug / LAN apiBase / subscription CLI -> free, else
            paid); `roster.<name>.billing: "free"|"paid"` overrides it. To the scheduler, billing
            says only which credential may carry a run. An openai entry's override is also
            recorded on each run it launches: the ladders' "exclude free" follows it, and a
            recorded free needs no price.
            `routing` — the fleet-wide default for OpenRouter entries, same shape as an entry's.
            An entry that states its own keeps it WHOLE: the two are never merged. Absent means
            the built-in default (the model author's own provider, fallbacks off).
            `runPods` — `"off"` (default) or `"probes"`: every probing episode runs as its own
            pod on the arm's image ("Run pods"). While it is not `probes`, or off the cluster, an
            arm that pins an image or a command is a refused pair, never run on master.
            `maxConcurrent`, `paid` and `subscriptions` are refused by name: their work is the
            credentials' ("Credentials").
campaign-defs  published campaign definitions, `<id>@<version>` → { definition, hash, source,
            publishedAt }. Written ONLY by runner/src/campaign-publish.ts and never changed: `set`,
            `patch`, `delete`, the /config page and a reseed all refuse the prefix, and a second
            publish with a different hash is refused ("Probe campaigns"). A seeded document may
            carry them only exactly as the store holds them (an export, restored), so a fresh
            store gets its definitions by publishing them, then seeding the rest.
campaigns   probe campaigns (docs/EPISODES.md, `probing`): the DYNAMIC half only —
            { <id>: { version, enabled, assignments [{ model: <roster name>, runsPerCell }],
            account?, accounts?, credential?, excludeUnhealthy?, concluded? } }, strict. The
            shape (cells, arms, start, leash, stop level, resume, attempt cap) is the published
            definition `<id>@<version>`; `version` is explicit, never "latest". A row the store
            will not write, or one naming a version nobody published, is refused by name on read,
            alone: everything else loads. Every run is an unscored `probing` episode.
            `account` — PINS the campaign, under the pinned-job account rules. Without it the
              policy schedules it between the evals and the idle work, on a model that owes no
              eval and holds no live or paused run.
            `accounts` — a PARTY definition's pin, never `account`: one per member, member order,
              the leader first; any other count, a shared account or a clash refuses the whole
              pin. Its square launches one roster of all members together, after the stager,
              takes a slot per member on one credential, starts only when all fit, and
              resumes whole (docs/proposals/GROUP-PLAY.md; `infra/party-fate.ts`).
            `credential` — a PINNED campaign's credential, by id: every launch of the campaign
              takes it, overriding the assignments' own placement for those runs only. One that
              cannot carry every assignment refuses the campaign.
            `excludeUnhealthy` — skips a retired or cooling model.
            `concluded` — a list of versions of this id the operator declares finished: each
              launches and resumes nothing, and the page shows it `complete*` with its counts
              as the runs made them.
            Completion is DERIVED per (id, version, assignment, arm, cell) against the counted
            probe runs on disk; set `enabled: false` when a sweep is done and its results stay
            visible. Progress is on the /campaigns page.
queue       jobs, in priority order (never `probing`): { ref | [refs], episode e90|e360|freeplay,
            repeat n|"loop", enabled, account?, credential? } and nothing else ("Strict keys").
            With `account` the job is PINNED to it and never the policy's; without, it is a
            manual pool job that outranks the policy. The name is always `<first ref>-<episode>`
            (run ids `fleet-<name>-<model>[-<effort>][-<compactWindow>]-<stamp>`), one job per
            (ref, episode). A numeric `repeat` is a total of counted runs ("Steer it"). A pool
            job whose ref is not eligible for its EPISODE is skipped with the reason in
            --status; a pinned one waits the same way. A waiting manual job reserves the pool,
            and --status names the reservation. `credential` pins the job's runs to one.
```

#### Strict keys, and how to pause a character

A roster entry and a queue job each carry a declared set of keys
(`ROSTER_ENTRY_KEYS` and `QUEUE_JOB_KEYS` in `runner/src/roster-refusal.ts`)
and nothing else. A key outside the set refuses that entry or job by name:
the refusal line in `--status` says which key it was and what to write
instead, the rest of the config stays in effect, and a live run under the
refused entry or job is left alone and does not respawn. A shape error
rejects the whole config, and so do the keys a roster entry is refused by
name: `character`, `account`, `objective`, `wikiCoords`, `resume` and the
retired `tiers` and `runsPerEpisode`. Campaigns are strict through their own
schema.

**`enabled` is a queue job's word, not a roster entry's.** To pause a
character, set the entry's `idle: "none"`: the freeplay job stops being
generated, the paused run reads "not in config — resume by hand", and it
stays down until `idle: "unlimited"` comes back ("Freeplay characters are
durable"). To take a model out of scheduling, set its tier and idle to what
you want; a catalog entry has no on/off switch.

A roster entry referenced by a pinned job is never policy-scheduled: the
account is spoken for. Nothing else takes an entry out of the policy; a
campaign borrows an entry without removing it from the schedule.

#### Adding a model

New OpenRouter models arrive as **drafts** from the `/config` page. **fetch
new models** reads the public OpenRouter catalogue once, with no credential,
and proposes every tool-calling model the roster does not already run and
nobody has ignored, free and paid, newest first. A second fetch adds only
what is new, refreshes a pending draft's price, and never brings an ignored
model back.

A draft is not config. It is a `proposed/<model id>` row in the store, which
`parseFleet` never reads, so nothing schedules it, and a fetch or an ignore
writes no line to the history. An ignore is remembered by model id and
survives a reseed; **un-ignore**, in the collapsed *ignored* list, undoes it.

Each draft carries an estimate of one `e90`: OpenRouter's list price applied
to the median counted `e90` of this series on the wrathbench harness
(docs/COSTS.md). With no counted `e90` to take a profile from there is no
estimate.

**promote** writes an ordinary roster entry, `{ model, tier }` plus `race`
and `class` when given, through the same validation and attributed write as
any roster edit. The tier has no default: promotion never picks one
(docs/METHODOLOGY.md, "The tier is the evidence budget"). The entry states no
`routing`, `billing` or `idle`, so each takes its default. A refusal (a name
or a model the roster already has, a claude id on the openai driver) is shown
on the row, and the draft stays.

Nothing calls the model first: whether a slug really answers a tool call is
what its `t0` trial finds out. A model OpenRouter's catalogue does not carry
(a claude-code or codex model, the LAN box, Cerebras, OpenCode Go) is added
with **add a roster entry**. The endpoints are in `runner/viewer/README.md`.

An OpenCode Go model is an openai entry with `apiBase`
`https://opencode.ai/inference/go/openai/v1` (the older
`https://opencode.ai/zen/go/v1` is the same surface), carried by an
`opencode-go` credential on `OPENCODE_KEY`, under the id Go's own listing uses
(`https://opencode.ai/inference/go/v1/models`, no key needed). Go serves
every text model it lists over chat completions. The adapter identifies as
itself: its own user agent, `x-opencode-session` set to the run id, and never
the headers of OpenCode's own client. Go picks the backend and the request
cannot name one, so a Go run stamps unpinned routing, keyed apart from a
pinned run of the same model. Go no longer names the backend in its response
headers, so the run records the slug only. A `-free` Go slug derives free and
runs on a free `opencode-go` credential; any other derives paid, runs on the
paid one with its usage budget, and is priced by an `opencode-go` endpoint
row on its catalogue entry. Each response reports its charge (`usage.cost`,
zero inside the allowance) and where it was billed
(`usage.opencode.billing_source`): `balance` means Go's Extra Usage billed the
account past a spent allowance, which the run records and the fleet holds as
`overage` ("The usage window"). With Extra Usage off, a spent allowance
arrives as a 429 `GoUsageLimitError` instead, which pauses `quota-exhausted`.
An API key can expire: issue the fleet's with no expiry, and with permission
to read usage.

**A new model also needs a catalogue entry** in `infra/model-catalogue.json`,
the one place a model's static facts live (docs/ARCHITECTURE.md). The roster
entry says how a model is scheduled; the catalogue says what it is, and every
page, the ladder's filters, the cost figures and the Every Eval Ever export
read it from there. In a checkout:

1. Add the entry under the id the roster names, written lowercase and without
   `:free`: its `family` (an existing family's id, or a new family with its
   company, name, logo `icon` and globs — then `bun wb data logos`; `null`
   only while the developer is unrevealed), its `name`, its `weights`
   (`open` with the checkpoint's URL, `closed` with where the vendor says it is
   served only, else `unknown`) and its `source`. Other spellings of the same
   model go in `aliases`: a codex slug, a dated snapshot, a Zen `-free` id.
2. Price it. A paid OpenRouter or codex model: `bun wb data prices`, which
   writes the windows onto the entry (and reports any priced id the catalogue
   does not list). A new Claude model: a dated, sourced `prices.anthropic`.
   A non-OpenRouter paid provider: a dated, sourced `prices.endpoints` row
   under the provider's id in `providers` (add the provider, with its exact
   `apiBase`, if it is new). Free and local models need no price.
3. `bun wb data catalogue --format` validates the file and rewrites it in its
   one spelling (offline, prices untouched), which `bun run test` requires.
   Commit.

The catalogue ships in the image, so the entry reaches the viewer, the
scheduler's status line and the publisher with the next release, and the public
site with the next dashboard build. Until then `--status` lists every roster
entry the catalogue does not list, and every one with no price, saying which
fix it needs. `bun wb data catalogue` asks the same of the published
generation: it reads the public bucket and names every model id there with no
entry.

### Stop it

```
kubectl -n wrathbench scale deploy/wrathbench-fleet --replicas=0     # the cluster
docker compose -f infra/compose.yml stop fleet                       # the quickstart
```

A stop **pauses** the live runs. SIGTERM reaches the supervisor, which
SIGTERMs each job's roster, which SIGTERMs the runner; the runner pauses its
run as `operator-pause`: the episode clock stops (the minutes spent are
written to meta.json and the budget resumes from there), the request or tool
call in flight is abandoned, the game session is logged out so the account is
free, and the run is marked paused — not terminated, not counted, not a
ladder failure. The runner's own backstop is 60s, the roster's SIGKILL grace
90s, the pod's termination grace (compose's `stop_grace_period`) 180s, in
that order.

What the pause costs depends on the lane. A **scored** run is ended `manual`
on the next boot: the attempt is spent, the model is not blamed, and the
scheduler gives it a fresh attempt with a full clock. Freeplay, and a probe
campaign that asked to resume, come back where they left off. Starting the
fleet again resumes the paused runs before it launches anything fresh ("What
a restart does to paused runs"). Ctrl-C on a hand-started
`infra/run-episode.sh` ends the run as `manual`: SIGINT is the operator's
cut, SIGTERM is the supervisor's pause.

To stop launching *without* pausing what is running, use the pause switch
("Graceful"). The supervisor does not exit when it runs out of work: it idles
and waits for the config to give it something.

### Updating the live fleet

This is the cluster's procedure. A quickstart compose stack has no update path
beyond `up -d --build`, which recreates what changed under whatever is
running, and runs each episode from the bind-mounted checkout.

On the cluster the code is baked into the images, so the first question is
**what changed**:

| What you changed | How it lands |
| --- | --- |
| the config store (`/config` page or `bun wb config`) | the **next tick** (60s). Hot-reloaded; every write is validated, and a config the running code refuses is complained about and ignored. |
| the wiki bundle | the next episode spawn: it is on the data volume. |
| any code: `runner/`, `wrath-mcp/sdk/`, `wrath-mcp/mcp/`, `infra/`, `wrath-mcp/module/`, `dashboard/` | a **release** (`bun wb release run`, "Deploy window"). A stack change in `wrath-mcp/` merges in wrath-mcp first and ships as a pointer bump here (`infra/PINS.md`). A run in flight keeps the code it started with. The viewer picks up a new image with `bun wb server restart-viewer`. |
| anything the supervisor reads only at start: its own code, its env, a credential's secret | a fleet pod restart. A release does one; the two recipes below do one without a release. |

`fleet-update.sh` does not build or pin an image: new code reaches the fleet
pod through a release, whose drain and resume phases are this script's.

The supervisor's date stamp (`fleet-<job>-<model>-<YYYYMMDD>`) is taken once at
start and fixed for the life of the process, so `--resume-roster` and the
loop's `-cN` numbering keep their meaning. A restart rolls it. Resumes do not
care: the run id is read off disk.

#### Graceful — nobody's run is interrupted

```
bun wb fleet graceful             # the whole thing
bun wb fleet graceful --dry-run   # the plan and every resolved value; safe while runs are live
bun wb fleet state                # the switch, the heartbeat, the live jobs
```

It sets the **pause switch**, waits for every run a recreate would *cost* to
end on its own clock, recreates the container on the new code, waits for the
new supervisor process to report (a changed `startedAt` in the state file),
and clears the switch. No attempt is spent
and nothing scored is signalled.

It does not wait for the runs that come back **where they left off**: the
freeplay character and a probe campaign with `resume: true`. The switch
SIGTERMs a freeplay session at once (it has no episode boundary to drain to),
and once such a job is `draining` the wait counts it as drained; the recreate
then lands on whatever parked run is still mid-episode. Each poll names both
halves: `waiting on:` for the runs holding the window and `counted drained:`
for the parked ones. Whether a job parks is the supervisor's own answer,
published per job row as `resumesInPlace` in `fleet-state.json`.

The switch is `data/runs/fleet-pause.json` (`{"paused": true, "why": "..."}`),
read every tick beside the config. While it is set the fleet launches
**nothing** — no queue job, no policy pick, no campaign cell, no resume of a
paused run — and every running job drains: SIGTERM only once its roster is
between episodes, as `"enabled": false` on one job does. It is a sidecar, not
a config key, so that it works while the config is rejected. `fleet-update.sh`
only writes and deletes that file, so it can be set by hand; `--status` leads
with a banner naming it, and distinguishes the switch on disk from the one the
supervisor has picked up.

Three costs, all printed by the script:

- The drain race: an episode spawned in the instant between the idle check
  and the SIGTERM is signalled, with run-roster's 90s grace. Worst case one
  just-started episode, never one mid-flight.
- A run already **paused by its provider** is not resumed while the switch is
  set. If the window outlasts that run's own episode budget it is swept as
  stale, and a stale *provider* pause is a **counted** failed attempt against
  the model (`runner/src/lapse.ts`). The script lists such runs before it
  waits; a long wait with one on the board is a reason to clear the switch and
  update later. Waiting is bounded (`--timeout`, default 8h), and a timeout
  leaves the switch set and kills nothing.
- A **parked** run is SIGTERMed by the recreate wherever it happens to be, as
  `force` would do it. It resumes on the same run id, account and character.

A **refused pin** (the `!` block in `--status`) is spared from draining, so
one that loops holds the window open until the timeout. Disable it in the
config, or use `force`.

"Quiet" is only claimed from a state file the script parsed, written by a
supervisor whose heartbeat is current; an unreadable file or a dead
supervisor's frozen rows keep it waiting.

Ctrl-C during the wait is safe: no scored run has been signalled, **the
switch stays set**, and the fleet schedules nothing until `bun wb fleet
resume`. The script says so on the way out.

#### Forceful — now, and it costs the live runs

```
bun wb fleet force                # asks for confirmation; --yes to skip
kubectl -n wrathbench rollout restart deployment/wrathbench-fleet   # the same thing by hand
```

The fleet pod stops inside its 180s termination grace, so every live run takes
the **pause** path ("Stop it") rather than being killed. What it costs:

- A scored run (`e90`/`e360`) is ended `manual` on the next boot: **the
  attempt is spent**, with whatever money or quota it had burned, and the
  scheduler gives the model a fresh attempt with a full clock. `manual` is in
  `NOT_THE_MODELS_FAULT`, so it is not a strike and never reaches a scored
  surface (docs/METHODOLOGY.md, "Episodes, lanes, and evidence").
- Freeplay, and a probe campaign with `resume: true`, come back where they
  left off on the same run id, account and character. An automatic resume
  restates the current leash rather than inheriting the stored one.
- A preflight smoke in flight dies with the container; the gate re-runs it.

If the switch is already set when `force` runs (an aborted `graceful`), force
clears it after the recreate, once the new supervisor has reported, and
names the `why` it found. A supervisor that does not come back leaves the
switch set. `drain` is the mode that leaves it set, and it stops the
container instead.

#### What a restart does to paused runs

On boot, before the queue or the policy spawns anything, the supervisor finds
every paused run whose model and episode are still in the config and maps it
back to its job (a pinned or queued job, else a synthetic policy job with the
attempt read off the run id). Scored runs are ended as failed attempts and
reattempted; freeplay and opted-in campaigns resume: the supervisor spawns
the job's roster with the paused run id first and `--resume-roster`, on the
**same account**, because the character lives there and a fresh launch on that
account would wipe it. `--resume` reattaches the trajectory and scratchpad,
recreates the game session with the same character, and continues the
episode budget. A CLI driver (claude-code, codex, pi) does not reattach the
CLI's own conversation, so such a run restarts with a fresh CLI session (the
same fixed prompt, the scratchpad, the resume notice every driver gets) and
is stamped `resumedFresh: true` in meta.json.

Only once every resume has its account does the pool fill. The same planner
runs every tick, so a run paused by its provider (`rate-limited`,
`quota-exhausted`) is resumed once its cooling is over ("Lapsed runs: paused,
and stale"). A supervisor that boots with the pause switch set does none of
this until the switch is cleared.

### Lapsed runs: paused, and stale

A run that stops without a verdict is handled by its **lane**
(docs/METHODOLOGY.md, "Episodes, lanes, and evidence"). While a run is paused
its model is held: no second attempt starts for it, and a paused run counts
toward nothing until it ends.

A **scored** run (`e90`, `e360`), and a probe campaign that did not set
`resume: true`, does not resume. `--status` shows it on its account as a
failed attempt and lists it among the lapsed runs the supervisor ends on its
next tick: it writes the termination through the runner's own writer,
releases the session so the account and character go back, and the policy
schedules a fresh attempt on the tick after. Three counted failures on one
(model, episode, series) and the model is **tainted** for that episode:
`--status` says so and the model is blocked, taking no idle work either,
until `bun wb fleet clear-model <name>`. A fleet stop (`manual`) and an
offline gap (`stale`) do not count toward those three. This taint is not the
roster's own `tainted` in a job's defer sidecar, which is one process backing
off a model whose launches keep failing.

**Stale** runs are swept on boot and on every tick: any run with no
termination whose last activity (its pause mark, else its trajectory) is older
than its own episode budget — 12h for a run with no wall clock — is ended.
That is the half-day outage case. A freeplay session is never stale: it is
resumed under its own run id however long the gap. A run the fleet did not
launch (no `fleet-` prefix) is never ended by the supervisor: it is listed for
the operator.

A run with **no verdict at all** — no termination, no pause, no live process —
is a runner that was killed before it could write. On the lanes that resume,
the supervisor reads it as paused `offline` as of its last activity and
resumes it like an `operator-pause`, once the run provably has no owner. It
holds its model, and every other launch on its account keeps its character.
The scored lanes are left to the
stale sweep: a lapsed `e90` is a failed attempt either way.

The proof of "no owner" is the run's **heartbeat**: a runner rewrites
`heartbeat` in its run directory every twenty seconds and removes it on any
exit it gets to make, so a fresh one (under two minutes) means a process owns
the run, on this pod or any other. A quiet trajectory proves nothing, because
a run waiting on a slow provider writes nothing. `run.ts --resume` and the
roster both refuse a run with a fresh heartbeat (exit 75, nothing written, the
session not touched), so a resume by hand cannot land on a run the fleet is
playing, nor the reverse.

For the lanes that **do** resume (freeplay, and a campaign whose definition
says `resume`), `--status` shows the pause on its account and a `paused runs
not resumed` block with why:

- **not in config** — the model or episode is gone from the fleet config (or
  the pinned job is disabled, or on another account). Resume it by hand
  (`bun wb run episode --resume <run id>`, on its account) or archive it.
- **cooling** — a pause on the roster's defer ladder (every reason but
  `operator-pause`, `offline`, `party-paused` and `subscription-budget`),
  indexed by the run's pause streak: its
  ladder pauses since its last segment that made a turn. The roster retries a
  mid-episode provider pause in place while its process lives; once it gives
  up and exits, the supervisor takes over on the longer ladder, resuming in
  place on the same run id. Past the ladder the run is listed, not hammered.
- **waiting** — its account is busy with another job or held by a
  hand-started run. A resume never moves to another account.

Some pauses wait for a known instant instead of climbing the ladder:

- A provider that said when its allowance resets (OpenRouter's free-tier
  daily limit names the next 00:00 UTC): the roster makes no in-place retry,
  the supervisor resumes the run at the reset, once, and the pause neither
  spends a rung nor counts toward the streak. Only a reset 10 minutes to 48
  hours out is honoured, so a per-minute window stays on the ladder.
  `--status` lists the run as `resuming at <time> (provider reset)`.
- A subscription credential's spent quota (codex, claude-code, an OpenCode Go
  allowance) waits for its usage window's reset the same way, up to seven
  days out, listed as `(usage window reset)`. A freeplay run its budget paused
  (`subscription-budget`) is on no ladder: it resumes once its window is back
  under the threshold ("Credentials", "The usage window").

Three pauses cool on the ladder but always come back, because the runner
releases the session and the roster advances, so the supervisor resumes the
run with a fresh sandbox and session:

- `observation-stalled`: the sandbox's event stream closed and the recorded
  state stopped moving.
- `auth-failed`: the credential refused — a Codex login that could not
  refresh, or any provider's 401 on an API key. It says nothing about the
  model. The run comes back once the operator has logged the credential in
  again or replaced the key; until then it climbs the ladder and is listed.
- `infrastructure-failed`: a CLI scaffold failing on its host, such as the
  codex CLI unable to write its thread under `CODEX_HOME` on a full volume. A
  volume the operator has freed is picked back up; one still full climbs the
  ladder until the run is listed. The CLI's own words are in the pause detail
  and the run's `codex_stderr` records; the model is never shown them.

### Freeplay characters are durable

A freeplay character — the one an `idle: "unlimited"` ref plays across its
sessions — is the operator's to disable and re-enable at will, and it
survives that.

The character's identity is the ref's latest freeplay run that is not live
and recorded an account and a character, ended **or paused**
(`charactersFrom`; matched on model + effort, so a renamed ref keeps its
character). Latest means newest **start**, so of two paused runs of one
character the one resumed is the head, whichever paused last. What the
supervisor does with it, per tick:

- **Disable** (`idle: "unlimited"` → `"none"`, or the fleet pause switch): the
  policy job is drained, and for this lane a drain is an immediate SIGTERM.
  The runner logs the character out and writes `operator-pause`; `--status`
  lists the run as `paused, not in config` while the ref stays `none`.
- **Re-enable**, however much later: the paused run is resumed in place: same
  run id, account, character, scratchpad. A freeplay pause never goes stale:
  while it sits it is listed by `--status`, it holds its model (the policy
  starts nothing for that ref, scored or not), and it is never continued
  from. A pause the supervisor will not resume by itself (a provider pause
  past the defer ladder, a ref no longer in the unlimited lane) waits for the
  operator: resume it by hand, or end it.
- **After an ended session** (the watchdog, or the operator's kill): the next
  policy pick is a **continuation**: a new run id (`-a<n+1>`) launched with
  `--continue-from <predecessor>`. The runner refuses it unless the launch is
  `freeplay` and the predecessor is a freeplay run on the same account that
  named a character. Hygiene then keeps that character and clears the rest,
  the predecessor's `scratchpad.md` is copied in, race and class are the
  character's, and the model is told which run and character it continues.
  If the character is gone, or the predecessor is on disk nowhere, the run
  drops the lineage (`continue-dropped`), deletes the copied notes and starts
  fresh. An archived predecessor stays valid: `loadContinuation` reads it
  from `<runs>/archive/<id>`.
- **The account is the character's.** A freeplay pick prefers its character's
  account over the model's last run. If that account is busy, who holds it
  decides (`characterStanding`):
  - the ref itself (its own live run, or its resume reserving the account):
    nothing to plan;
  - another ref's **bounded** run (a scored episode, a probe, a hand-written
    job) ends at its episode boundary, so the pick is **held**, never started
    fresh elsewhere;
  - another ref's **unlimited session** has no boundary to wait for, so the
    pick starts **fresh on the free account it was offered**, lineage dropped:
    no `--continue-from`, and the drop is recorded on the new run, in the
    supervisor log and in `--status`. With no free account the ref gets no
    pick, and the supervisor says once why the next one will be fresh. The
    orphaned character stays protected while the fresh session is live; once
    that session ends having named a character it is the head, and the next
    fresh launch on the old account wipes the orphan in ordinary hygiene.
- **One character per model+effort.** An `unlimited` ref has exactly one
  character at a time. The older ended sessions of a character are parked
  with `archive.ts --run-ids` ("Archiving runs"), which is a decision about
  listings and nothing else: the character is untouched and the scheduler
  still reads the archived runs.
- **Nothing else deletes it.** Every fresh launch on an account that holds
  another ref's freeplay character gets `--keep-characters`, so a scored run's
  hygiene leaves it standing (the model is told the name is taken), and the
  cross-account name sweep skips freeplay characters and the character of
  every run that has not ended.
- **Hygiene has a guard of its own.** Before deleting, the runner reads the
  run directories for the account (`characterOwners`) and never deletes a
  character whose newest run has no termination. A character above level 1
  that no *ended* run accounts for is kept too, unless the launch passes
  `--allow-character-delete` (the fleet never does). Both are logged and
  recorded in the trajectory. The guard reads `archive/` too, so archiving a
  run does **not** release its character. The release is a termination on the
  run's row: to end a run by hand, `kubectl -n wrathbench exec
  deploy/wrathbench-runner -- bun runner/src/classify.ts <run id> manual
  [note]`, which refuses a run with no termination and no pause (it may be
  live) unless `--force` comes first.

`--status` prints one row per `idle: "unlimited"` ref with its head and the
verdict above. Roster changes that compete for one account go in **one
write, owner first**: two edits in sequence let a second character elect the
account on the tick between them. A hand-written `freeplay` job on the same
ref is the operator's own experiment and never continues anything. To start a
character over deliberately, delete its character (`POST /character-delete`
on the module) before re-enabling: the continuation finds nothing and starts
fresh.

Scored episodes are untouched: `--continue-from` is refused on `e90`/`e360`,
their hygiene still clears everything but another ref's freeplay character,
and a lapsed scored run is still a failed attempt.

### Backing up and moving a character

A freeplay character is two halves: its run directory and its rows in the
characters database. `export-character` writes both into one archive, and
`import-character` puts both back: to back a character up before risky
maintenance, move it to another host, or restore it after a database loss.
Both run in the runner pod:

```
bun wb accounts export-character <run-id> [file] [--no-trajectory]
bun wb accounts import-character <file> [--account NAME] [--note TEXT] [--actor NAME]
```

Both need SOAP, which only the chart's `staging` switch turns on ("Party
staging"): the game half is the core's own `.pdump write` and `.pdump load`,
sent as STAGER, which remaps item, mail and pet ids on load. Without SOAP
(the compose quickstart, or staging off) both commands refuse by name.

The archive goes in `data/characters/`, the runner pod's mount of the data
volume's `characters` subPath; a file named without a `/` is taken from
there, and the default name is `<run-id>-<UTC stamp>.tar.gz`. It holds
`manifest.json` (the run and character identity, the pause or verdict, the
builds, and the size and sha256 of every other member), `character.pdump`,
and `run/…`, the run directory without its heartbeat, `claude-config/backups/`,
`claude-mcp.json`, temp files and sqlite journals; each sqlite file is copied
with `VACUUM INTO`. `--no-trajectory` also leaves out `trajectory.jsonl`: a
small archive that can continue the character but no longer holds its record.

An archive never carries a credential. The session token is dropped from
meta.json (a resume mints a fresh one) and struck to `[redacted]` where older
records carry it. Anything else that reads as a credential, by value against
the runner pod's environment or by shape, refuses the export, naming the file
and the rule, never the value; so does a `.credentials.json` or `auth.json`
anywhere.

**Export refuses**, writing nothing:

- a run with a live owner, with no verdict, or archived;
- a run that has named no character;
- a character the database lacks, holds on another account, or has online.

**Import refuses**, loading and writing nothing:

- a run id that exists, under the runs directory or `archive/`;
- an account that does not exist (`bun wb accounts ensure` it first);
- a character name or guid that exists, a soft-deleted character's guid
  included;
- any member whose size or sha256 differs from the manifest, is missing, or
  is not listed in it.

An import never replaces anything. The imported run keeps its id and comes
back paused (or ended) exactly as it left; nothing resumes it but the
roster's `idle`. Each import is appended to `imports` in its meta.json, which
no public projection carries. With `--account`, the run's `config.account`
moves too, so that account has to be on the module's allowlist and in the
fleet's pool. The core keeps a dump's guid only when it is below the highest
it has handed out; if the guid moves, the import says so and records it, and
nothing reads the old one.

**Before risky maintenance**, back up every character that matters, with
each one paused:

```
bun wb config patch roster/sonnet '{"idle":"none"}' --actor operator --note "backup before maintenance"
bun wb inspect run <run-id>                       # wait for "paused: operator-pause"
bun wb accounts export-character <run-id>         # prints the archive's path
bun wb config patch roster/sonnet '{"idle":"unlimited"}' --actor operator --note "backed up"
```

The archive is on the same volume as the run. To survive the loss of that
volume, copy it off the cluster:

```
kubectl -n wrathbench exec deploy/wrathbench-runner -- cat data/characters/<file> > <file>
```

**Restoring** onto a host, or after a database loss:

1. Set the ref to `idle: "none"` first, so the run is not picked up the
   moment it lands.
2. Copy the archive in:

   ```
   kubectl -n wrathbench exec -i deploy/wrathbench-runner -- sh -c 'cat > data/characters/<file>' < <file>
   ```

3. Run `bun wb accounts import-character <file>`.
4. Set the ref back to `unlimited` when you want it played.

If the run directory survived the loss, move it aside (or archive it) first.
If the character survived, it is already restored.

**Moving a character to another account on the same host** is an export,
then removing the run directory and deleting the character, then an import
with `--account`. The removal is deliberately not part of either command.

### Node disk pressure

A node that runs out of root disk evicts pods with no grace period, so a live
episode dies without writing its pause record. The chart is built so that
WrathBench is neither the cause nor the first thing evicted:

- Every container requests `ephemeral-storage`. The kubelet evicts pods that
  exceed their request first, and a container with no request is in that
  group however little it writes. The request is a rank, not a budget:
  everything that is evidence is on the data PVC, which does not count.
- Every `emptyDir` carries a `sizeLimit`, far above the working set. It is a
  backstop against a runaway, not a quota to run near: exceeding one evicts
  the pod, which costs every run it was supervising.
- `priorityClassName` is the deploying cluster's to set; the chart creates no
  PriorityClass. Left empty, the field is omitted from every pod.

### Server log retention

The worldserver's own log goes to the console (`kubectl logs`). What it keeps
as files on the data PVC is `logs/Errors.log`, rewritten on every boot, and
the module's audit log, one JSONL per session and UTC day under
`logs/wrathbench` (`<fingerprint>.<YYYY-MM-DD>.jsonl`, the first 16 hex
characters of the token's SHA-256). The audit log is what grows, about 0.6 GB
a day per live freeplay stream, and it is kept for a window
(wrath-mcp/docs/CONTRACTS.md "Audit"): `worldserver.logRetention.days` in the
chart's values, default 3, `0` to disable. The `wrathbench-log-retention`
CronJob prunes it once a day (`schedule`) by age, so changing the window
never rolls the worldserver.

The pass never touches a file the server will still write to. A past day's
file is deleted once quiet for the window. Today's file, and an undated file
from before day files, is deleted only when it is quiet for the window *and*
older than the running server process (read from `GET /health`); one younger
than the process is emptied in place and deleted after the next restart. With
the module unreachable only past days are deleted. It logs counts and bytes,
never a name. A live stream therefore holds at most about `days + 1` days of
audit.

```
bun wb server log-retention            # dry run inside the worldserver container: counts, bytes, and
                                       # how many candidates the server holds open
bun wb server log-retention --days 7   # the same for another window
bun wb server log-retention --apply    # a Job from the CronJob, now; waits and prints its log
```

To read one run's audit while it is kept, `bun wb inspect audit <run-id>`. To
keep one past the window, raise `days` in the deploying cluster's values, or
copy its day files out before the pass. They are named by the fingerprint of
`config.token` in the run's `meta.json`; the fingerprint is no secret and may
go in argv, the token never does:

```
fp=$(kubectl -n wrathbench exec deploy/wrathbench-runner -- bun -p 'require("crypto").createHash("sha256").update(JSON.parse(require("fs").readFileSync("data/runs/<run-id>/meta.json","utf8")).config.token).digest("hex").slice(0,16)')
kubectl -n wrathbench exec deploy/wrathbench-worldserver -- sh -c 'cd /azerothcore/env/dist/logs/wrathbench && for f in "$1".????-??-??.jsonl; do [ -f "$f" ] && cat "$f"; done' sh "$fp" > <run-id>.audit.jsonl
```

The compose quickstart has no retention: its `data/logs` is a bind mount you
prune yourself.

### Deploy window

Every code change reaches the cluster in a release, and `infra/k8s-deploy.sh`
(`bun wb release deploy`) is the only deploy window. There is none for
compose: a quickstart stack takes a new worldserver with `docker compose
--env-file .env -f infra/compose.yml up -d --build`, which recreates it under
whatever is running and verifies nothing.

A stack change (module, SDK or MCP) ships the same way, as a pointer bump: it
merges in wrath-mcp, the commit that moves `wrath-mcp/` merges here
(`infra/PINS.md`), and the release built from that commit carries it. That
release is the only place a module change is verified, by the smoke suite
after the resume ("The lean path").

```
bun wb release build --push                    # every image, tagged `git describe` (infra/build-images.sh)
bun wb release run --dry-run                   # the plan and every resolved value
bun wb release run --pin-hook <your pin hook>  # the whole release, start to finish (infra/k8s-release.sh)
bun wb release run --from pin                  # restart at a phase
bun wb release deploy                          # the deploy window alone (infra/k8s-deploy.sh)
```

`infra/README.md`, "Releasing on Kubernetes", has the phases (build, drain,
pin, deploy, resume), the pin hook, and what the window refuses. `release run`
drains gracefully (`fleet drain`, "Graceful"), so no scored run is signalled.
`release deploy` on its own is the forceful path: its draining phase scales
the fleet to 0, so a live scored run spends its attempt ("Forceful"). Run `bun
wb fleet drain` before it to make it graceful; a window that succeeds clears
the switch itself. Keep the window to one operator: it holds no deploy lock.

#### The lean path

A window holds the fleet, so it carries nothing that does not have to be
there: drain, deploy, the launch gate (`preflight.smokes`), then the fleet
resumes at once. The drain is the one wait that may run long, because it lets
a scored run reach its own episode boundary. Beyond the drain and the rollout,
whatever runs while the fleet is held — the gate, and anything run by hand —
stays within about a minute in total.

**Module verification runs after the resume**, with the fleet live, on
accounts the fleet does not schedule: `bun wb smoke <name>` (`bun wb smoke`
lists them), or the regression suite in one command:

```
bun wb smoke suite [member …] | --list
```

It runs the game-surface smokes in `infra/smoke/lib/suite.ts` (kill-credit,
quest-accept-status, module-quest, module-navigation, achievements-taxi,
deadmines-entry, chest-loot) on SMOKE2–SMOKE4, each on the account its
character lives on. Smokes that share an account run one after another, and
the accounts run in parallel. It prints one PASS/FAIL line per smoke with its
duration and exits 1 on any failure. A smoke retries only a named transient
condition, once or within a stated bound, and prints a `RETRY:` line when it
does (`infra/smoke/lib/transient.ts`); a PASS that needed one shows the retry
on its line. It refuses any member that would log in on the pool, PROBE,
PARTY* or SMOKE, so it never holds the fleet. Run it after any release that
touches the game surface. A smoke that fails after the resume has found a
defect in a live build: revert the pin, which is another window, or fix
forward.

The accounts for hand runs:

- `PROBE`, the default of most smokes (`jump-knockback` and `stack-wave3`
  default to SMOKE4, the party smokes to PARTY1–PARTY5). It is free while no
  enabled job or campaign pins it and no run, such as the scripted reference
  run, holds it. `bun wb fleet status` lists each account with what is on it.
- `SMOKE2`–`SMOKE4`, which the suite uses and some smokes use beside PROBE
  (swim's observer is SMOKE3, death-recovery's priest SMOKE4), so a hand smoke
  on one of them waits for a suite run to finish.
- A suite member run alone goes through the suite, `bun wb smoke suite
  <member>`, which keeps it on its own account. The bare `bun wb smoke <name>`
  passes no environment into the pod, so it logs in on PROBE and fails at
  character creation on a name its own account holds. For any other account
  use the kubectl form:
  `kubectl -n wrathbench exec deploy/wrathbench-runner -- env MODULE_ACCOUNT=SMOKE3 bun infra/smoke/<name>.ts`.
- Leave `SMOKE` to the gate. The supervisor runs its gate on SMOKE as soon as
  it boots, and again after any worldserver restart.

**A smoke that needs a campaign's accounts holds that campaign, never the
fleet.** The party smokes (`party-entry`, `party-staging`) stage and delete
characters on PARTY1–PARTY5, which only the party campaign uses:

```
bun wb config patch campaigns/<id> '{"enabled":false}' --actor <you> --note "held for the party smokes"
bun wb fleet status    # wait until no run on PARTY1–PARTY5 is live or paused
bun wb smoke party-entry
bun wb config patch campaigns/<id> '{"enabled":true}' --actor <you> --note "party smokes done"
```

A disabled campaign spawns nothing, and its live attempt drains at its
episode boundary rather than being signalled, so the wait is that attempt's
own leash. Every staging deletes whatever the party accounts hold, a paused
attempt's characters included. A campaign without `resume` ends a paused
attempt on the next tick; one with it keeps the paused party, listed and not
resumed while the campaign is disabled, so run the smokes once that attempt
has finished, or end it deliberately first.

#### Holding the fleet for a CLI-env or sandbox change

The gate and the suite's smokes drive the module with a scripted client. They
never start the Claude Code or Codex CLI and never run a model's snippet, so a
change to the environment the CLIs start with, or to the snippet sandbox's
confinement, passes them untested, and the resume phase puts every paused run
straight onto that build. For an ordinary change that is fine: watch the
first real run after the release. Holding the fleet is an option, not the
default, for a change that could break every run of a driver at launch, such
as a CLI version bump or a sandbox policy change:

```
bun wb release run --pin-hook <your pin hook> --keep-paused
bun wb run episode --account PROBE --driver claude-code --model <id> --max-tool-calls 20
bun wb run episode --account PROBE --driver codex --model <id> --max-tool-calls 20
bun wb run episode --account PROBE --driver openai --model <id> --max-turns 5
bun wb fleet resume
```

`--keep-paused` reaches `k8s-deploy.sh`, which sets the pause switch before
its drain if nothing has, scales the fleet back to 1 on every exit path as
always, and never clears the switch; the release skips its resume phase and
says so. The supervisor comes up and spawns nothing, a resume included. The
hold is one short real run per driver on PROBE (or SHAKEOUT), a couple of
minutes, then `bun wb fleet resume`. Module smokes and anything longer wait
until after the resume.

Each run has no `--episode`, so it is unscored; `--credential-env` picks a
second subscription's variable. The CLI drivers have no turn limit, so `--max-tool-calls`
bounds them. Read each trajectory as far as a logged-in CLI and a snippet that
reached the module. A run that hits its limit costs the model nothing, but one
that dies before the model answers, or on an adapter error, is a rung on that
model's cooling ladder, and `bun wb fleet clear-model` forgives it. A
provider-paused run is not resumed while the switch is set and can go stale,
which counts ("Graceful"). If a run fails, nothing scheduled has run on that
build: revert the pin, and resume once a build passes.

#### Images

The images are built from the commit, never from the working tree:
`build-images.sh` builds from a `git archive` of the commit, so nothing
untracked, ignored or uncommitted can reach an image, and a dirty tree is
refused (`--allow-dirty` builds the commit anyway, but its `-dirty` tag is
never pushed). The submodules are exported the same way from the commits that
commit pins, so they have to be initialised in the checkout you build from.
The runner image also takes the scripted reference program from the private
checkout's HEAD, and the build stops when it cannot find it ("The scripted
reference run").

Each image goes through `infra/image-guard.sh` before anything is pushed. The
guard refuses an image that holds a secret-shaped path (env files, keys,
credential and token files, agent or wrangler state, sqlite stores) or client
data, naming the paths, never their contents. A refusal means the commit or a
Dockerfile step put that file in the image, so fix it there. Don't widen the
guard's allow-list to get past it.

A worldserver whose world load came up short is never started. Its pod waits
for MySQL to answer a query before the load begins (the `wait-for-db` init
container), and its startup probe passes only on a `200` from the module's
`/health`, which answers `503 world_not_loaded` when a core store came up empty
or MySQL restarted during the load (wrath-mcp/module/PROTOCOL.md, `GET /health`). Such a
pod is restarted when the startup budget runs out (`worldserver.startupProbe`,
15 minutes), and a release waiting on it fails rather than smoking it. `bun wb
server health` prints the counts and
`dbRestarted`; `kubectl -n wrathbench delete pod -l
app.kubernetes.io/component=worldserver` restarts it now instead.

#### What each phase means

`infra/k8s-deploy.sh` writes `data/runs/server-state.json` at every
transition, and the Fleet page's banner is the phase plus the script's own
`detail` sentence verbatim.

- **draining** — the fleet Deployment is scaled to 0. Every live run pauses
  ("Stop it"), and the supervisor writes its final state and exits. The script
  then waits, up to 300s each, for that state file to say no job is alive, for
  the fleet pod to be gone and for every run pod to be gone. A pod that outlives the
  wait, or a pod listing that fails, fails the window closed with the pod
  named.
- **waiting** — the worldserver rollout, then `/health` answering ready with
  the bearer, each for at most 900s.
- **verifying** — the gate smokes (`preflight.smokes`) run through `kubectl
  exec` into the runner pod within their timeout, then any
  `preflight.deploySmokes` (none today). The detail names the smoke in flight.
- **resuming** — every smoke passed; the fleet is scaled back to 1 and the
  pause switch cleared. The supervisor boots, re-gates on the new server
  identity and resumes every paused run on its own account before the queue or
  the policy gets one. Under `--keep-paused` the pause switch stays set and it
  resumes nothing.
- **running** — the window is over. The script prints `DEPLOYED and verified
  by …` and exits 0.
- **failed** — the window failed closed: the drain never completed, the
  worldserver never answered ready, a smoke failed, or the fleet would not
  scale back. The detail says which. Exit 1.

Whatever happens after the fleet is scaled to 0, the script's EXIT trap scales
it back: a deploy never leaves the fleet stopped, and after a failure the
fleet's own preflight gate blocks spawning until a build passes.

The script does not change the image tag and does not roll back: a rollback
is reverting `image.tag` where the pin lives to the previous immutable tag,
and the script says so when it fails. The supervisor writes `running` over
any window phase it finds on file when it boots, which is the acknowledgement
of a `failed` notice.

#### If it says failed

Read the detail: it names what failed, and the script's output has the tail.
Then:

1. **The drain did not complete** (a job still alive, a fleet or run pod still
   listed, or a pod listing that failed). Nothing was smoked, but the window
   only opens once the cluster carries this tree's tag, so the new build is
   already live, or rolling out, and unverified. The fleet's own gate still
   smokes it before anything spawns. Check `data/runs/fleet-<stamp>.jsonl` for
   why the supervisor did not exit cleanly (a roster that ignored SIGTERM, a
   runner past its 60s backstop), or the named pod, then run the window again.
2. **The worldserver never answered ready.** The rollout or the module is the
   problem: `kubectl -n wrathbench logs deploy/wrathbench-worldserver` and
   `bun wb server health`. Revert the pin if the build is at fault.
3. **A smoke failed on the new build.** The fleet is up and gated shut, so
   nothing has spawned on that build. Revert the pin; the gate re-runs on the
   new server identity and unblocks the fleet once the old build passes. If
   the old build fails too, the failure is not in the build (auth, the
   database, the smoke accounts, the runner image). Run a smoke by hand and
   read its output: `bun wb smoke preflight` logs in as PROBE. The gate's own
   account needs the variable set in the pod, which is the kubectl form,
   `kubectl -n wrathbench exec deploy/wrathbench-runner -- env MODULE_ACCOUNT=SMOKE bun infra/smoke/preflight.ts`.
4. **The fleet did not scale back up.** The one case with a command for you:
   `kubectl -n wrathbench scale deploy/wrathbench-fleet --replicas=1`.

`--no-smoke` is the escape hatch for a cluster where the preflight accounts
do not exist yet: it drains, waits for health, verifies nothing, says
`DEPLOYED UNVERIFIED`, and hands the server to the fleet, whose own gate is
then the only check. An enabled preflight with no `smokes` configured is not
that: it fails and exits 1.

`--dry-run` prints the plan and every resolved value and executes nothing. It
is read-only and safe while the fleet is up.

### The preflight gate

The supervisor smokes the server before it launches anything. The knob is the
top-level `preflight` block of the config, hot-reloaded like the jobs;
`infra/fleet.example.json` shows its shape. There are two lists:

- **`smokes` is the gate.** It runs before the first job is spawned and again
  whenever the server identity changes: on every worldserver recreate and on
  every restart the container does by itself. Every job waits on it, so it
  proves only that the stack is alive end to end, and the default,
  `infra/smoke/preflight.ts`, does that in well under a second: health and the
  port secret, the event stream, a login, the login state on the stream, one
  action's reply, a logout. Its character is persistent, created the first
  time and never deleted. Entries with distinct accounts run in parallel;
  entries sharing an account run in order. A bare string entry means "on
  `account`".
- **`deploySmokes` is what a release proves on top, and it is empty.** The
  deploy window would run these after the gate smokes, one after another,
  with the fleet down, under the one deadline `deployTimeoutMs`; the
  supervisor never runs them. The game-surface regression smokes run on
  demand instead (`bun wb smoke suite`, "The lean path").

**The budget.** Whatever the window smokes stays within about a minute, since
it runs while the fleet is held with nothing running. Today that is the gate
alone. The suite runs with the fleet live, so it holds nothing and has no
budget: about 80 s once its characters exist, longer the first time. A new
smoke is never added to either list to cover a gap: it lives on demand, as
`bun wb smoke <name>`, and a smoke that truly must gate releases has to fit
inside the minute by replacing or shrinking another, which is the operator's
call.

The supervisor runs the gate before it reads the run history, so with the
server up the gate passes within seconds of a start. While `/health` is not
ready it asks again every 5s, not once a tick.

A failure spawns nothing, complains once, and is re-checked every tick, so a
fix or a rollback unblocks the fleet with no operator action. Drains still
work while the gate is shut. `timeoutMs` is the budget for the whole gate,
sized for the slowest legitimate login (the module bounds a create that
reclaims a stale session at 20s), not for the smoke's usual run. `bun wb fleet
status` shows the last gate result, per script; `bun wb fleet dry-run` shows
the plan.

**Gate accounts.** Every account a smoke is bound to must exist in auth and be
in the module's allowlist — `worldserver.accounts` in the chart's values
(`AC_WRATH_BENCH_ACCOUNTS` in `infra/compose.yml` on the quickstart stack),
which the module reads **only at worldserver recreate**. A smoke bound to an
account the running module does not permit gets 403 `account_not_permitted`,
the gate fails, and no job spawns until it is fixed, so a new gate account is
added at a recreate and not before. `bun wb accounts ensure` creates one (an
auth-DB insert, safe with the server running), and only the accounts it is
named:

```
bun wb accounts ensure SMOKE2
```

It is `infra/bootstrap/bootstrap.ts --accounts-only` in the runner pod: the
password is the account's name, an account that exists is left alone, and no
realm row is written. On the quickstart without Bun, compose's `bootstrap`
service makes one account by running the whole bootstrap with it as the
configured account, which also re-upserts the realm row and resets that
account's password if it differs: `docker compose -f infra/compose.yml run
--rm --no-deps -e WRATHBENCH_ACCOUNT_USER=SMOKE2 -e
WRATHBENCH_ACCOUNT_PASSWORD=SMOKE2 bootstrap`.

The gate accounts must be their own: an enabled job or campaign pinned to
one is refused, a gate account in the account pool rejects the config, and
none should be `PROBE`, the ad-hoc debugging account. Benchmark characters
are never fixtured: the fixture tool (`infra/fixtures`) writes only to smoke,
probe and party accounts.

Server identity is `/health`'s `build` and `startedAtMs` (`serverIdentity`,
`infra/run-fleet-plan.ts`), so it changes on every worldserver boot.

### Groups

A deployment is three groups, each on unless switched off (chart
`groups.<name>.enabled`; `runner/viewer/groups.ts`):

- **runner**: the fleet supervisor, its run pods, the runner pod and the
  codex home. Off, nothing launches a run.
- **evals**: scored episodes, campaigns, the ladder and comparability. It
  has no workload of its own. Off, the supervisor launches no scored or
  probing episode: every campaign and every e90, e360 or probing job reads as
  disabled (each drains at its boundary, as a disabled job does), and an
  `idle: unlimited` entry gets its freeplay session whether or not it owes a
  counted run. What is counted does not change.
- **viewer**: the viewer, the publisher, and ClickHouse with its collector.

A group that is off is absent, not hidden: its workloads are not rendered,
whatever their own `enabled` says, and the pods that remain are told through
`WRATHBENCH_GROUPS` (the groups that are on, comma-separated; rendered only
when one is off). The viewer then has none of that group's pages or routes
(runner: `/fleet`, `/models`, `/api/fleet`, `/api/models`; evals: `/ladder`,
`/campaigns`, `/about`, `/api/ladder`, `/api/campaigns`, `/api/episodes`),
and the publisher none of its objects (evals: the ladders, `campaigns.json`,
`episodes.json` and the social card; runner: `models.json` and the fleet in
`live.json`). A viewer-only deployment reads the sessions its own agents
produced. Groups are deployment config, so a change is a values commit and a
rollout, not a store write. The world itself (worldserver, authserver,
database) is in no group.

### The admin interface

The `/config` page and every write route the viewer has. Off by default
(chart `admin.enabled`; `WRATHBENCH_ADMIN=1` for a hand-run viewer), so a
deployment that does not turn it on has no write route at all; the chart
refuses it with the viewer off, and `serve.ts` refuses it together with
`WRATHBENCH_VIEWER_PUBLIC=1`. It is private only, like the viewer: no login,
reached on the LAN by the viewer's own names ("Where the config lives").

It is one more client of the config store, beside `bun wb config`: every
write goes through `/api/config` and `parseFleet`, is refused with the
supervisor's own sentence, and lands in `config_audit` with the actor and
note the page requires. It is one section at a time, each its own address
(`/config/<section>`), listed down the side (a row across the top on a
phone); a section whose group is off is absent, and every store row's raw
editor sits in the section of the table that edits it:

- **providers** (`/config/providers`): every credential with its health, and
  its non-secret fields edited in place: add one (provider, the env var NAME
  its secret is in, slots, billing, a budget), edit those of an existing one
  (its id and provider stay; a new provider is a new credential), enable or
  disable it, remove it. A credential's health is one state, the first that
  applies of `disabled` (the store's switch), `secret-missing` (the
  supervisor's environment lacks the variable, or the chart's `modelKeys`
  does not hand it to the model pods), `auth-failed` (a provider read or a
  paused run says the key was refused), `no-access`, `overage` (a run on it
  was billed to the balance past the allowance; ahead of a spent window,
  since that run also marks its allowance spent), `quota-spent` (a usage
  window at 100%, the provider's word, or a paused `quota-exhausted` run),
  `held` (a budget holding starts: a usage threshold, today's spend or runs),
  `unread` (the provider's usage endpoint gave no answer) and
  `ok`, with the reason, since when where known, the provider's last answer,
  the usage windows as meters, and the fix. Unknown while no supervisor is
  up, except what the store and the chart say themselves. Every state is
  derived from state that already exists (`runner/src/credential-health.ts`).
- **roster**: the roster's fields, a new entry, and the drafts ("Adding a
  model").
- **freeplay**: an entry's `idle: unlimited` on or off, which plays or
  pauses its durable character ("Freeplay characters are durable").
- **campaigns**: enable, disable or remove one, or add one from a published
  definition with its assignments. Publishing a definition stays the CLI's
  ("Probe campaigns").
- **queue**: enable, disable or remove a job, or add one.
- **policy**: the remaining rows (`policy`, `accounts`, `preflight`) as raw
  JSON.
- **deployment**: the groups and how publishing is set, read-only, with the
  chart key on each row.
- **history**: the audit table and the export.

New credentials, campaigns and jobs are written disabled. A secret's value is
never read, shown or written from the browser: the store holds names, and
values are the deployment's Secret ("Secrets"). Each credential's `set key`
(an endpoint) or `re-auth` (a subscription) control is there and switched
off, until where a secret written from the browser goes is decided. The status comes from
`GET /api/admin` (`runner/viewer/README.md`), which the chart feeds with the
`modelKeys` names and, when there is a publisher, its non-secret settings and
its state file, mounted read-only.

### Changing the config shape

The new shape under the old code is the one thing that must not happen, and
the store's validator is the code in the runner pod, so a new-shape document
can only be seeded once the new code is deployed. There is no compatibility
read: a shape the running code does not read is refused by name. So:

1. `bun wb config export > fleet-before.json`, and write the new-shape
   document beside it.
2. Release the new code as usual. The new supervisor refuses the old-shape
   store and runs an empty board (`config REJECTED` at the top of `bun wb
   fleet status`): nothing spawns and nothing resumes.
3. Copy the new document into the runner pod (a file argument is a path
   there), `bun wb config seed --force <path in the pod>`, and check `bun wb
   fleet dry-run`. The supervisor loads it on its next tick.

Have the document ready, because the fleet runs nothing between the window
and the seed. Roll back with `seed --force` of the export. Run ids carry the
job name, so a renamed job starts a fresh id; nothing resumes across the
rename.

### The scheduling policy

The `queue` normally holds only the pinned jobs: the supervisor fills free
pool accounts from the roster by policy — each model's tier budget
(`t0`/`t1`/`t2`, "Config reference"), `e90` for everyone, `e360` once earned,
newest-to-the-roster first, shorter episode first, fewest runs first, one
character per model, each pick on the first credential with room
("Credentials"). Only runs from the running build's harness **series** (`0.5`
of `harness-0.5-1437-g…`) count; a minor bump starts every model's evidence
over, a fix commit does not. How many paid runs are in flight at once is the
paid credentials' slots — never a budget: how much a paid model runs is its
tier. A model whose entry
says `idle: "unlimited"` takes one continuous freeplay session at a time once
its targets are met, stamped `extra: true`: an attempt but never counted.

Everything it decides is derived from `data/runs/` each tick; nothing is
stored except an operator's clear.

```
bun wb fleet status                       # models table: status, counted/target per episode, why (not) schedulable
bun wb fleet dry-run                      # the picks the policy would make for the free accounts right now
bun wb fleet clear-model <roster-name>    # forgive a retired/cooling model; picked up on the next tick
```

Both reports read what is running as the supervisor does: a job whose process
is alive, never a row `fleet-state.json` keeps for a roster that has exited.
`--dry-run` plans the next tick around that: a job in flight keeps its account
and its model, and its row says what a restart does to its run; a paused run
the supervisor would bring back reads `resumes <run id> in place`. A live
fleet run no job owns (a killed runner's heartbeat stays warm for two minutes
after a pod recreate) keeps its account and its model, so nothing launches a
second session for that model. Once it reads cold, on a resuming lane it is an
`offline` pause and resumes in place, and a scored run waits for the stale
sweep. With the pause switch set the dry-run leads with the switch, and the
plan is what launches once it is cleared.

The status words: `new` has no counted run yet; `active` is working toward
its `e90` target; `promoted` may also be scheduled on `e360`; `cooling` is on
the defer ladder (`1m … 6h`) after consecutive zero-response or
`adapter-error` attempts; `retired` failed once more at the 6h ceiling and
will not be scheduled until cleared; `pinned` is outside the policy (a pinned
ref or a probe). A launch that produced no model response never counts toward
a target but does climb the ladder, so a dead provider costs at most ten
launches over about 11 hours before it is retired.

A manual pool job (a `queue` entry without an account) always outranks the
policy for a pool account; add one to force a specific run (an `e360` for a
model that has not climbed needs `tier: "t2"` on its roster entry as well).
Its `repeat` tops the model's counted runs on that episode up to `n`, the
policy's runs included ("Steer it"). How many runs a model gets is its `tier`
and nothing else.

### Probe campaigns

A probe is a cell of a published campaign definition, and nothing else
(`docs/EPISODES.md`, `probing`). The definition is a JSON file,
`runner/campaigns/<id>@<version>.json`, published into the config store; it
fixes the cells, the arms and the shape. The store row `campaigns/<id>` says
which version is active, whether it runs, who sweeps it and how many counted
runs each owes per square. `/campaigns` lists every published version;
`/campaigns/<id>/<version>` shows its arms, grid and arm comparison.

**Adding or changing a campaign** needs no release:

1. Write `runner/campaigns/<id>@<version>.json`. A change to a published one
   is a new file with the next version; never edit a published version. `bun
   test` checks every file parses and is named for what it holds.
2. Commit it and push it to any branch on origin. A pull request can carry
   its own campaign beside the code its arms test.
3. Publish it from a checkout that has the commit:

```
bun wb campaign publish runner/campaigns/<id>@<version>.json --actor <you> --note "<why>"
bun wb campaign publish runner/campaigns/<id>@<version>.json --dry-run   # check and print, write nothing
```

The CLI (`runner/src/campaign-publish.ts --k8s`) runs on your machine, where
git is. It fetches origin, refuses a file that is untracked or modified or whose
last commit no origin branch holds, and pipes the publication into the runner
pod's store (under `bun wb --local` it writes the local store). Publishing the
same definition again is a no-op; publishing a different one under a
published `id@version` is refused. Which commits may publish is
`PUBLISH_RULE` in `campaign-publish.ts`: any origin branch today,
`origin-master` to tighten it.

**Assigning models to a campaign.**

1. Name the roster entries in `assignments`, in priority order. Each owes
   `runsPerCell` counted runs per square, and a square is one (cell, arm).
2. Enable the row.
3. To queue more data later, raise an assignment's `runsPerCell` or append
   another assignment. To move to a new version, point `version` at it; work
   is counted per version, so the new one starts from nothing.
4. To declare a version finished whatever its squares hold, list it in
   `concluded` (the whole list: a patch replaces it). It launches and resumes
   nothing, and the page marks it `complete*`.

```
bun wb config set campaigns/race-probe \
  '{"version":1,"enabled":true,"assignments":[{"model":"codex-sol-61","runsPerCell":1}]}' \
  --actor <you> --note "race-probe@1: sol-61 x1"
```

A row naming a version nobody has published is accepted by the store and
refused by name on read: `--status` lists it, the campaigns page shows it
under refused, and nothing launches until the version is published.

**Arms.** An arm with no `image` runs the release image; a definition with
more than one arm must pin every arm's image, by tag or `@sha256:` digest
(never `:latest`). A pinned arm (an `image` or a `command`) runs only in a run
pod ("Run pods"): with `policy.runPods` off, or off the cluster, every
(assignment, arm) pair of it is refused before any launch and listed as
`<id>@<v>:<ref>:<arm>`, never run on the release image, and it schedules again
once the switch is on. An arm image must be a build that has
`--campaign-file` and refuses unknown flags; anything older ignores the
campaign file it is given. An arm's `args` come after the supervisor's own
and may not restate a shape flag or a supervisor flag; `--compact-window` is
the exception.

An arm that sets the window may be assigned only roster entries on the
claude-code, codex or pi driver that set none themselves (`"auto"` on a
claude-code entry is a window set): any other pair is refused before it
launches. An arm that passes no window runs the entry's stated one, else the
driver's default, like any fresh launch: 300k on claude-code (operator,
2026-11-10), including a square of a definition published before the default,
since a campaign is a spike and is not kept comparable across such a change.
An arm that measures the CLI's own window says `--compact-window auto`. An arm
pinned to an image built before the default runs that image's runner, which
has none.

Every pair of an assignment whose roster entry the fleet refuses (an unknown
key, a base no credential provider serves, a pinned credential that cannot
carry it) is refused too: the campaign sweeps
its other assignments, and the entry's own refusal, with its reason, is under
`--status`'s refused pins. The campaigns page shows those squares as refused
without the reason, because the reason can name a key, a credential or a host.

**A hand launch** names the square and nothing that sets its shape.
`run-episode.sh` writes the run's `campaign.json` from the published
definition and launches `run.ts` with `--campaign-file`; the runner refuses
`--episode probing` without one, and with one it refuses `--objective`,
`--race`/`--class`, `--wiki-coords`/`--wiki`, `--max-tool-calls` and the
watchdog flags. `--arm` may be left out when the definition has one arm; an
arm that pins an image or a command cannot be hand-launched.

```
bun wb run episode --model <id> --campaign class-probe@2 --cell dwarf-paladin
```

**The pi harness: a probe-only roster entry.** The `pi` driver
(runner/README.md, "The pi driver") runs only as a campaign's assignment until
the operator promotes it. Its entry is an ordinary roster entry with
`driver: "pi"` and an endpoint, like the openai driver's, and the window when
the campaign compares at a fixed one:

```
bun wb config set roster/deepseek-flash-pi \
  '{"model":"deepseek-flash","driver":"pi","tier":"t1","apiBase":"https://api.deepseek.com/v1","effort":"high","compactWindow":"300k"}' \
  --actor <you> --note "pi on deepseek-flash, probe-only (#257)"
```

- It may sit beside the `wrathbench` entry for the same model and endpoint:
  the one-model-one-harness rule does not apply to a probe-only driver,
  because none of its runs is in a scored lane. A probe run maps back to the
  entry it names, never by model id, so the two never pool.
- Its `tier` and `idle` buy nothing. The policy gives the entry no target and
  no freeplay, a queue job naming it outside a campaign is skipped, and the
  runner refuses a hand launch of it on any episode but a campaign's `probing`.
  `--status` says "driver pi is probe-only" against it.
- A routing block is refused, and a key the provider table gives no pi
  provider refuses the entry: today that is every key but `DEEPSEEK_KEY`.
- Give the same `effort` as the `wrathbench` entry it is compared with.
  Absent is each harness's own default, which differ: pi thinks at `high` on
  deepseek-flash, and the openai driver sends no level at all. A level pi
  would clamp (`medium` on deepseek-flash) ends the run before its first turn.
- `compactWindow` on a pi entry, or `--compact-window` on an arm, is pi's
  reserve below the model's window (`300k` compacts above 300,000 tokens on
  deepseek-flash's 1,000,000); one at or above the window ends the run before
  its first turn. Absent is pi's own threshold, 983,616 tokens there.

A wrathbench-against-pi campaign assigns both entries, and the arm leaves the
driver alone: the assignment, not the arm, chooses the harness. The run pod
gets the entry's one key and nothing else (`runPodEnv`). The image carries the
pinned `pi` (`PI_VERSION`), so a branch arm needs an image built from a commit
that has the driver.

### Run pods

A probe-campaign arm may name its own container image — a branch build, or a
harness that is not this repository — and an image cannot be a child process
of the fleet pod. So on the cluster a probing episode can run as **its own
pod**, created by the roster from the chart's template and watched until it
ends (`infra/run-pod.ts`; the contract both sides honour is
`docs/ARCHITECTURE.md`, "Launching a run: the run contract"). Scored lanes
stay child processes.

**The switch.** `policy.runPods` in the config store, `"off"` by default:

```
bun wb config patch policy '{"runPods":"probes"}' --actor <you> --note "run pods on for probes"
bun wb config patch policy '{"runPods":"off"}'    --actor <you> --note "run pods off"
```

It reaches a job at its next roster spawn (the supervisor hands it to
`run-roster` as `--run-pods`), so a roster already mid-episode keeps the mode it
started under. With it on, every probing episode is a pod, image-less arms
too, so arms compare on one execution path.

**What the chart provides** (`templates/run-pods.yaml`): the fleet's
ServiceAccount and a Role over pods in the release namespace only; the pod
template, rendered from the same helpers as the fleet pod and mounted into it;
and the launcher's settings. Two values matter at deploy time:

- `runPods.allowedImages` — the image *repositories* an arm may name, matched
  on the part before the tag or digest, exactly or as a path prefix. Empty
  means the release runner alone (`<image.registry>/wrathbench-runner`). Add
  the repository branch images are pushed to
  (`ghcr.io/shard/wrathbench-runner`).
  An image outside the list, untagged, or `:latest` is refused before a pod
  exists.
- `runPods.imagePullSecrets` — pull Secret names for run pods only, merged
  with the chart-wide `imagePullSecrets` ("Secrets"), for a repository in
  `allowedImages` the chart-wide Secret cannot pull.

A run pod gets the module secret and the one credential its driver bills (its
credential's `CLAUDE_CODE_OAUTH_TOKEN*`, its endpoint key, or the mounted codex home),
`WRATHBENCH_LOCAL_MODEL_HOSTS` from the chart's `localModelHosts`, the runs
and wiki volumes, and no config store, no database variables and no
`ANTHROPIC_*` variable. Its harness stamp is the arm's image tag, never
master's; a digest-only pin stamps `<repository basename>@sha256:<12 hex>`.
The launcher writes `runs/<id>/image.json` (`ref`, `digest`, `pod`, `node`,
`startedAt`) when the container starts, and a resume in a pod relaunches that
digest whatever the arm says now. That holds only while `runPods` is
`probes`: switched off, a paused probe on an image-less arm resumes as a child
process on the release, one on a pinned arm waits, listed, until the switch is
back on, and the supervisor exempts a probe from the harness-series gate only
when it has an `image.json` and the switch is on.

**Lifecycle.** Each pod carries an ownerReference to the fleet pod, so a fleet
stop or crash deletes its run pods with the pod's 90s grace — the same
SIGTERM → `operator-pause` an episode gets from its roster. A roster's SIGTERM
deletes its pod with that grace and waits for it to be gone, and the
supervisor's drain counts a roster's run pod as an episode in flight.
`infra/k8s-deploy.sh` waits for zero run pods after the fleet pod is gone and
before the worldserver is touched, and fails the window closed naming the run
if one outlives the budget, or if the pods cannot be listed for that long.
`bun wb fleet state` lists them.

A pod that will not pull (`ImagePullBackOff`), cannot be scheduled for five
minutes, stays Pending for fifteen, or is evicted before its run began ends
the attempt as `launch-failed` with the kubelet's reason in the roster's log,
never as a hang.
So does an image the allow-list refuses, a pod the API will not create, and a
run.ts that refuses its flags. Each leaves a stub run terminated `launch-failed`
with that reason, which counts toward the definition's `maxAttemptsPerCell`:
a square that cannot launch settles as capped instead of being picked again
every tick. The pod's log is followed into the job log, and the finished pod
is deleted.

**Debugging one.** Pods are labelled `app.kubernetes.io/component=run`, with
the run id in the annotation `wrathbench.shard.page/run-id` (the label
`wrathbench.shard.page/run` is its hash: a run id can exceed 63 characters) and
the owning roster's pid in `wrathbench.shard.page/roster-pid`.

```
kubectl -n wrathbench get pods -l app.kubernetes.io/component=run -o wide
kubectl -n wrathbench describe pod <name>          # pull errors, scheduling, the image digest
kubectl -n wrathbench logs <name>                  # run.ts's own lines; also in the job log
kubectl -n wrathbench get cm wrathbench-run-pod-template -o jsonpath='{.data.pod\.json}'
```

**A branch runner image** is built by hand, from a clean checkout of the
branch, or naming the branch's head from any clean checkout; a definition
usually pins its digest:

```
./infra/build-images.sh --only runner --push --registry ghcr.io/shard --without-reference
./infra/build-images.sh --only runner --push --registry ghcr.io/shard --without-reference \
  --commit <sha> --tag "$(git describe --tags --always <sha>)"
```

`--without-reference` is required there: an image carrying the scripted
reference program is never pushed to a public registry host ("The scripted
reference run"). The image is built like a release's ("Images"), and its tag
is `git describe` of the commit, so a run stamped with it groups with the
series.

**Checking the launcher.** One short probe on `PROBE`: pin a one-cell
campaign there, assign a model, set `runPods` to `probes`, and watch
`bun wb fleet state` and the job log for `run pod … created`, `… running on <node>: <image> is
sha256:…`, and the roster's verdict. Expect the first pull of a new image to
take minutes; the account is held through it by `image.json` and the heartbeat.

### Ad-hoc launches

One episode, launched in the runner pod (`bun wb --local run episode`: in the
quickstart's runner container):

```
bun wb run episode --model <id> [--driver openai|claude-code|codex|pi]
```

`./infra/run-roster.sh` and `./infra/run-fleet.sh` still start a roster or a
whole supervisor by hand, on the quickstart. Both read the config store and
`data/runs/` of the machine they run on, so on a workstation against the
cluster they have nothing to read. Never run a second supervisor against the
same store while the fleet is up: both would spawn jobs on the same accounts.

### A fan-out run, by hand

One agent driving several characters (Shard/wrath-mcp#29). The fleet
launches one only as a party campaign's one-agent arm (docs/EPISODES.md,
"One agent, the whole party"), on the party's pinned accounts, staged as the
party is; anything else is launched by hand.

```
bun runner/src/run.ts --driver <driver> --model <id> [--objective "<text>"] \
  --max-characters 5 --accounts POOL01,POOL02,POOL03,POOL04,POOL05
```

- `--max-characters <n>` above 1 with `--accounts <a,b,…>` is the grant: up
  to `n` characters in the world at once, on those accounts, at least `n` of
  them (the module holds one session per account). The run uses one model
  credential. Without the flags, or with a count of 1, the run is the
  single-character one, unchanged.
- It is refused for a scored episode (`e90`, `e360`), a party member and a
  continuation: a fan-out run is a probe until its eval is defined.
- The supervisor counts every account a live fan-out run's grant names
  (`config.fanout.accounts` in its `meta.json`) as held, pool accounts
  included, so the queue and the policy leave them alone and a roster waits
  for all of them. A paused run's accounts are reserved only by its resume,
  which the fleet plans for a run it launched; a paused hand launch on pool
  accounts is not protected, so resume it or launch on accounts outside the
  pool. Each must be on the module's allowlist ("The account pool").
- Launch hygiene clears every listed account, as it clears the one account of
  any fresh run.
- The run directory has `sessions/<Character>/` (a session record per
  character) where a single-character run has `session/`, and `roster.json`,
  mode 0600, which holds each character's session token: never copy it out
  of the runs volume. A resume (`--resume <run-id>`) logs back in the
  characters that were in the world when the run paused.
- What it is served: the nine tools with `character` on `run_snippet`,
  `recent_events` and `state_summary`, plus `login_character`,
  `logout_character` and `list_characters`, in the stack's plain default
  wording; the fixed loop's turn context carries the stack's roll-up and no
  event window. The system prompt is the single-character one. All of that is
  placeholder until the harness round decides the benchmark's own.

`runner/test/fixtures/stub-fanout-demo.json` is a scripted five-character
session for the stub driver (`--driver stub --stub <that file> --wiki false`,
with the flags above): it logs five characters in, acts for all of them from
one snippet, reads the roll-up and the merged feed, logs one out and back in,
and blocks the sandbox once to show every character reattached.

`bun infra/quickstart-fanout-resume.ts --project <compose project> --accounts
<five accounts>`, with the quickstart up and its fleet service stopped,
checks a resume on that session end to end: it stops the run with SIGTERM
once the five are in, resumes it, kills it with SIGKILL, resumes it again,
and lets it end, checking the roster file, the module's sessions and each
character's record at every step. Its launch deletes every character on the
accounts it is given, as any fresh run's does; on the stock compose,
`RUNNER` and `POOL01` … `POOL04` are allowlisted. Its header says what it
proves. By hand only: it needs the live stack.

### The scripted reference run

Once per harness series, by hand, on `PROBE` (docs/EPISODES.md, "The scripted
reference run"). The runner pod runs the image's code, so launch it after the
release that carries the series:

```
bun wb run episode --driver reference --episode e90 --account PROBE
```

It needs no key, no credential and no `--model`: the route is the model
(`reference/<route>@<version>`). Nothing schedules it: the fleet config
refuses `driver: reference`, and the scheduler counts it toward nothing. What
it shares with everything else is the account, so run no smoke on `PROBE`
while a reference run holds it. The program never ends a run itself, so the
verdict should be `episode-limit`; `no-xp` means the route stalled somewhere.
A pause is not resumed.

Check it with `bun wb inspect run <run-id>` and `bun wb inspect trajectory
<run-id> --grep 'REF'`. Every turn's result ends in one `[log] REF {…}` line:
the step, `advance`, what the tick did, and the level, xp and health. An `npc
… not in view` after walks that arrived is a route position to correct; the
same `move …` failure repeated from one spot (the audit's move results give
the position) is the program's to fix. Bump the route's `version` with the
correction, so the next run is a new line rather than the old one moved, and
release, since the image carries the program.

The program is not in the public repository: a working route script for this
SDK is an answer key a future model could be trained on, so it is kept in the
operator's private checkout and built into the runner image from there
(docs/METHODOLOGY.md, "Scoring"). This tree holds only the hook: the driver,
its adapter, the stamp and the counting rules.

- `infra/build-images.sh` takes the program from `reference/src/` at the
  private checkout's HEAD and lays it at `runner/src/reference/` in the build
  context. The checkout is `WRATHBENCH_PRIVATE_DIR` (or `--private-dir`); the
  default is the operator's own path, so a build anywhere else has to set it.
  It must name the checkout's top level, with `reference/src/index.ts`
  committed at HEAD and no uncommitted tracked change under `reference/src`
  (`--allow-dirty` builds HEAD anyway).
- A runner build that cannot find the program stops before anything is built,
  so a release never ships without it. `--without-reference` builds an image
  without it for local use or for a public registry, and is refused when
  pushing to the release registry.
- Any build without the program, a public clone or the compose quickstart
  included, refuses a `--driver reference` launch in one line and writes
  nothing. To check the program in an image:

```
docker run --rm <runner image> bun -e 'const r = await (await import("/wrathbench/runner/src/reference-program.ts")).loadReferenceProgram(); console.log(r.ok ? "present " + r.program.route.id + "@" + r.program.route.version : r.reason)'
```

The program's own tests live beside it and run against a public checkout
(`reference/test.sh <checkout>` in the private checkout).

Nothing of a reference run reaches the public site: the publisher withholds
every run whose driver is not a model, and deletes what an earlier pass
published for one (docs/PUBLIC-DASHBOARD.md, "Runs that are never published").
The ladder's scripted reference line is public as numbers only: level, xp,
route, series and tier.

### Archiving runs

A run that terminates without a single model response — the provider was dead
on the first request, the key was refused, the adapter threw before a turn
existed — is **archived by the runner itself as it exits**, into
`data/runs/archive/<run-id>/`. It is a launch that did not happen, so no
listing shows one. A *pause* is not a termination: a paused run with no
response yet is resumed, not archived. Nothing is deleted, and the viewer
never reads inside `archive/`; `--status` and the scheduler do, because the
defer ladder is made of launches that did not happen and attempt numbers must
stay unique on disk.

The CLI parks runs for two other reasons: the comparability floor, and the
operator's own judgement about what a listing should show. It runs in the
runner pod (`kubectl -n wrathbench exec deploy/wrathbench-runner -- bun
runner/src/archive.ts …`; an `@file` is a path there):

```
archive.ts --pre-series <X.Y> --dry-run          # everything outside series X.Y
archive.ts --pre-series <X.Y> --release-paused   # ...including parked runs nobody holds
archive.ts --run-ids a,b,c --dry-run            # exactly these runs
archive.ts --run-ids @ids.txt --release-paused  # ...one id per line, # comments skipped
```

`--pre-series` parks every run whose recorded harness version is not a build
of the series: an older series, or no `harness-` tag at all. `--run-ids`
parks exactly the runs you name. Both refuse, with the reason, a run the
fleet may still be holding: its own files written inside the last ten
minutes, a `run.ts` process naming it, or a fleet job jsonl naming it inside
the same window. `--release-paused` lets a run through the activity hold when
its meta records a pause and no `run.ts` process names it, because a
supervisor retrying a paused run rewrites its files every few minutes.

**Run the dry-run first and check the count**: a live run is the one thing
this must not touch, and `archiveRun` is a rename with no guard of its own.
An id that names no movable run (a typo, a run already parked, a directory
that is not a run) is reported on its own line and counted separately.

### Credentials

The scarce things a run spends are a provider credential and a game account,
so the fleet models those and nothing else. A **credential** is one provider
secret — an OpenRouter key, a Claude subscription token, a Codex home, an
OpenCode key — kept as a `credentials/<id>` row in the config store, in
preference order (`runner/src/credential-slots.ts`):

```
"credentials": {
  "claude-1":        { "provider": "claude",     "secretEnv": "CLAUDE_CODE_OAUTH_TOKEN",   "slots": 1, "budget": { "kind": "usage", "scoredMaxPct": 80, "freeplayMaxPct": 80 }, "billing": "paid", "enabled": true },
  "claude-2":        { "provider": "claude",     "secretEnv": "CLAUDE_CODE_OAUTH_TOKEN_2", "slots": 1, "budget": { "kind": "usage" }, "billing": "paid", "enabled": true },
  "chatgpt-1":       { "provider": "chatgpt",    "secretEnv": "CODEX_HOME",                "slots": 1, "budget": { "kind": "usage" }, "billing": "paid", "enabled": true },
  "openrouter-free": { "provider": "openrouter", "secretEnv": "OPENROUTER_KEY",            "slots": 1, "budget": { "kind": "runs", "perDay": 40 }, "billing": "free", "enabled": true },
  "openrouter-paid": { "provider": "openrouter", "secretEnv": "OPENROUTER_KEY",            "slots": 1, "budget": { "kind": "spend", "usdPerDay": 5 }, "billing": "paid", "enabled": true },
  "lmstudio":        { "provider": "local",      "secretEnv": "LMSTUDIO_KEY",              "slots": 1, "billing": "free", "enabled": true }
}
```

- **provider** — `claude` (a Claude subscription, the claude-code driver),
  `chatgpt` (a Codex home, the codex driver), `openrouter`, `opencode` (Zen),
  `opencode-go`, `cerebras`, `deepseek`, `local` (the self-hosted server). A
  model's provider is its CLI driver's, or its `apiBase`'s host. A new one is
  a row in `runner/src/credential-slots.ts` and `runner/src/providers.ts`.
- **secretEnv** — the NAME of the env var holding the secret (for `chatgpt`,
  the var naming the logged-in Codex home), never the secret: the provider's
  own name or that with a numbered suffix (`CLAUDE_CODE_OAUTH_TOKEN_2`,
  `CODEX_HOME_2`, `OPENROUTER_KEY_2`). A value where a name belongs is refused
  by shape, and a numbered key still goes only to its provider's host. Two
  credentials share a secret only as a metered key's free/paid split.
- **slots** — how many runs may be live on it at once.
- **budget** — one limit on the credential's total use, below. `{ kind:
  "usage", scoredMaxPct?, freeplayMaxPct? }` (claude, chatgpt, opencode-go;
  each default 80, 100 is off) is the usage window. `{ kind: "spend",
  usdPerDay }` (openrouter) is the provider's own reported charge on the
  credential's runs since 00:00 UTC. `{ kind: "runs", perDay }` (any) counts
  launches since 00:00 UTC: each fresh start, and each segment a resume
  starts. Absent is `usage` at 80/80 on a credential that bills a plan with
  usage windows (claude, chatgpt, and opencode-go's paid side), and none on
  any other; to run a subscription without the shares, write `usage` at
  100/100 or another kind.
- **billing** — on a metered provider, which models the credential carries: a
  free credential only free models, a paid one only paid models. On a
  subscription every model bills it and the word describes it. It never
  reaches a run's recorded billing, a price or a ladder.
- **enabled** — a disabled credential takes no new run; live runs on it finish.

`bun wb config credentials [list | add | edit | disable]` edits them ("Where
the config lives"). A credential is config, but its secret reaches a pod
only when the pod starts: a new one is a key in the env Secret and a
`modelKeys` line in the chart ("Secrets"), so it lands with a release, not
with the 60s re-read. `--status` names a credential whose variable is not
set.

**What a budget holds.** A budget holds launches, never a run in flight, with
one exception, the freeplay share of a usage window:

- `spend` and `runs` hold every launch the supervisor makes on the
  credential once used: a fresh start, a resume, and a running scored job's
  next episode, which waits while its live episode finishes. Both reopen at
  00:00 UTC. Neither pauses or ends a live run, so a running job's own retry
  of a deferred attempt is counted but not held. Each counts from the runs on
  disk at every tick, so a tick that starts several runs on one credential at
  once can pass a `runs` budget by what it starts together, at most the
  credential's free slots.
- `usage` holds a scored start at `scoredMaxPct`, holds a freeplay start or
  resume at `freeplayMaxPct` and also pauses a live freeplay run there, and
  holds everything at a spent window ("The usage window", below).

`--status` says which budget holds which credential and why; `--dry-run`
names it on every held pick.

**How a run starts.** A run takes a slot on the first enabled credential that
serves its model's provider and has room under its slots and its budget, and
the host carries a session of its driver under `policy.maxSessions` (the one
cap that is not a credential's). Every launch path asks the same question:
pinned jobs, the manual queue, the policy's picks, resumes and parties. A
party takes a slot per member on one credential, all of them or none. A pick
with nowhere to start is held with the reason (`--dry-run`'s `HELD`); a pick
with no credential at all says so ("no enabled … credential").

`roster.<name>.credential`, `queue[].credential` and
`campaigns.<id>.credential` pin one credential: the run takes that one or
waits for it, never another. Normally absent.

**What a run records.** `config.credential` (the id), and for a CLI driver
`config.credentialEnv` (the variable its CLI reads) and `config.usageMaxPct`
(its usage thresholds). The fleet counts live runs per credential off that
record every tick, so the count survives a supervisor restart, and a resumed
run goes back to the credential it started on and nowhere else: a paused run
whose credential is gone or disabled is listed and waits. A 0.5 run recorded
its subscription lane (`config.subscription`) instead; the viewer reads both,
the scheduler only the credential.

**The usage window.** A subscription bills a flat plan whose allowance is
metered in rolling windows, and a window the fleet drains stays empty until it
resets. So the fleet reads each credential's usage and stops short of the top:

- a scored run (`e90`, `e360`) does not start on a credential while any of its
  windows is at or over `scoredMaxPct`. A scored run already live is never
  paused (that would spend its attempt): its episode finishes, and the job's
  next episode waits;
- a freeplay run does not start or resume on a credential at or over
  `freeplayMaxPct`, and a live one pauses at its next turn boundary as
  `subscription-budget`, resumable, waiting for the window's reset. That pause
  is the harness's doing: no strike, no rung on the defer ladder, no streak;
- a window at 100% — or a `quota-exhausted` pause — holds every launch on the
  credential, scored, freeplay or probe, until it resets, capped at seven
  days, with or without a usage budget. A probe is held only by that.

The readings: the codex driver reads the thread's rollout after each turn, the
claude-code driver the CLI's `rate_limit_event` frames, and each records the
newest reading on change in the run's meta.json and as a `harness` record of
kind `rate_limits`, keyed by the run's credential: the used percent, the
window's length and its reset, nothing else. For OpenCode Go the supervisor
reads Go's usage endpoint for each `opencode-go` credential with a usage
budget, at most once a minute, and leaves the reading in
`data/runs/fleet-credential-usage.json`; Go's windows are the five hours, the
week and the month, and one Go reports `rate-limited` is spent whatever its
percent. No reading counts for longer than seven days, and a credential with
no reading is open — unless its last read failed in a way that says so. Each
Go read is classified, and a change of class is logged:

- the key refused (401, `auth-failed`): every Go credential naming that key
  is held, free side included, until a read succeeds;
- no access to usage (403, `no-access`: a key without usage permission, or a
  workspace with no Go plan): that credential is held until a read succeeds;
- no answer (a timeout, a 5xx, a shape the reader does not know, `unread`):
  nothing is held, and the class is kept with when it began;
- a response a run on it saw billed to the balance (`overage`): that
  credential is held until a read at least a minute later shows every window
  with room. The run marks its allowance spent, so a live freeplay run pauses
  at its turn boundary like any spent window; a live scored run finishes. A Claude per-model weekly
cap (a refusal naming `seven_day_opus`, say) is a window of its own that holds
only that family's launches.

`--status` prints one line per credential: slots in use, the budget and what
it has used (the windows with their percent and reset, today's spend or
runs), whether a scored and a freeplay launch are held, whether its variable
is set, the newest `auth-failed` or `quota-exhausted` on it, and a Codex
home's volume. The supervisor publishes the same in `fleet-state.json`, and the
private viewer's `/api/fleet` serves it. None of the figures reach a public
page.

**The Codex home.** `CODEX_HOME` names a logged-in Codex home (`codex login`;
the login is its `auth.json`), and a second subscription is `CODEX_HOME_2`
pointing at a second directory. A directory is never copied per run: its
refresh token is spent by whichever process refreshes first.

The CLI never deletes a thread's rollout (`sessions/**/rollout-*.jsonl`), so
the fleet deletes them: the driver at a thread change and at its episode's
end, and an hourly supervisor sweep of every home a `chatgpt` credential names
for any rollout unwritten for two hours that is no live run's recorded thread
(`<run-dir>/codex-thread.json`). Each thread whose rollouts went is then
deleted from the CLI's own stores (`thread_history_1.sqlite`,
`state_5.sqlite`) with `codex delete --force <thread>`, which needs no login.
That is best effort: a failure is logged (the driver's
`codex_rollouts_removed` record, the sweep's line) and its rows stay. Deleting
rows does not shrink the file; a `VACUUM` while no codex run is live does.

#### Moving a run to another credential

Quotas run out at different rates, so a durable freeplay character sometimes
has to move to the subscription with room. Patching the roster pin alone does
not do it: a resume rebuilds the run's config from its `meta.json`, whose
`config.credential` is the credential it is on. `move-credential` is the
supported way:

```
# 1. pause it, so nothing resumes it mid-move: the runner writes operator-pause
bun wb config patch roster/sonnet '{"idle":"none"}' --actor operator --note "moving credentials"
bun wb inspect run <run-id>             # wait for "paused: operator-pause"
# 2. move it: meta.json first, then the roster pin
bun wb config move-credential <run-id> claude-1 --pin --actor operator --note "claude-2 spent until Friday"
# 3. let the fleet resume it, on the new credential
bun wb config patch roster/sonnet '{"idle":"unlimited"}' --actor operator --note "moved credentials"
```

**Step 1 is not optional**, even for a run that already reads paused. While
its ref is `unlimited` the fleet may resume it on any tick, and a resume that
read `meta.json` before the move writes the old credential back over it. The
command re-checks the owner and the file just before its rename, but cannot
see a resume that has read the file and not yet started its heartbeat.

The move rewrites `config.credential`, `config.credentialEnv` and
`config.usageMaxPct` to the new credential's. `--pin` writes the roster
entry's `credential` too, after `meta.json`, so the fleet counts the run where
it bills. Without `--pin`, an entry that pins a different credential refuses
the move. The pin is validated before `meta.json` is touched; if writing it
still fails, the command says so, and running it again applies only the pin.

What it refuses, writing nothing: a run with a live owner or with no verdict
at all (the fleet would resume it as `offline` on its next tick); a credential
that is not configured, disabled, another provider's or the other billing
side; a run that records no credential (0.5, or launched by hand); an
archived run; and any driver but claude-code. A Codex home holds the CLI's own
threads, so codex runs stay where they started.

Each move is appended to the run's `credentialHistory` in `meta.json` as
`{ from, to, at, actor, note }`, which no public projection carries.

### The account pool

A run that names no account is drawn from the pool, one live session per
account. Nobody names the pool's accounts: they are `POOL01` … `POOLnn`, and
one chart value sizes them, `worldserver.pool.size` (default 8, at most 99;
`runner/src/account-pool.ts`). From that value the chart:

- appends the names to the module's allowlist (`AC_WRATH_BENCH_ACCOUNTS`),
  after `worldserver.accounts`;
- gives the bootstrap Job `WRATHBENCH_POOL_SIZE`, and the Job creates each
  missing pool account in auth with its name as its password, the convention
  every harness account follows (the module opens its sessions in-process and
  never uses it). No secret is in values, and an account that exists is left
  alone;
- gives the fleet, viewer, runner and publisher pods the same
  `WRATHBENCH_POOL_SIZE`, so a config with no `accounts.pool` reads the same
  pool everywhere.

The size lives in values and nowhere else, because the allowlist is rendered
from values and Helm cannot read the config store. **Changing it is a values
change and a worldserver restart**: the Job creates any new accounts at the
upgrade, but the module reads its allowlist only at start, so until the
worldserver is recreated a new account answers 403 `account_not_permitted`.
That is a deploy window ("Deploy window"). Shrinking it deletes no account and
no character; an account past the new size is simply never drawn from again.
`accounts.max` in the config still caps how many are live at once, with no
restart.

A config may list `accounts.pool` instead, in preference order: the 0.5-era
named accounts (`RUNNER` … `RUNNER7`, still on the default allowlist), which
replace the generated pool while they are listed. A paused run comes back only
on its own account, and one whose account is no longer in the pool is listed
"not in the account pool — resume by hand". So a deployment with paused
characters on the named accounts keeps listing them until those runs are done.
The reserved accounts are as they were: `SMOKE*`, `PROBE` and the preflight
gate's are never in the pool, and a `POOLnn` name is never listed, pinned by
an enabled job, or a gate account.

On the quickstart, compose cannot loop: `x-pool-size` in `infra/compose.yml`
(4) sizes bootstrap and the services, and the worldserver's allowlist lists
`POOL01` … `POOL04` by hand. Change the two together and recreate the
worldserver.

### Secrets

Never argv. On the cluster every key is a key of the env Secret
(`envSecretName`, `wrathbench-env`), which the cluster repo generates from
`.env`; the chart hands each pod only the keys it names (`modelKeys` and
`templates/_helpers.tpl`), never the whole Secret, so a new provider key is a
`modelKeys` line plus the key in the Secret — a second key of a provider
(`OPENROUTER_KEY_2`, `CLAUDE_CODE_OAUTH_TOKEN_2`) included, which reaches no
pod until it is named there ("Credentials"). On the quickstart Bun loads
`/wrathbench/.env` inside the container, in the supervisor and again in every
child. A claude-code job needs the token of the credential it was placed on
(`claude setup-token`): `CLAUDE_CODE_OAUTH_TOKEN`, or
`CLAUDE_CODE_OAUTH_TOKEN_2` for the second subscription. Without it the roster
refuses the episode with a `launch-failed` row naming that variable. The
config store holds only each secret's variable NAME, never the secret.

Database clients follow the same rule: `mysql`, `mysqladmin` and `mysqldump`
take the password as `MYSQL_PWD` and `clickhouse-client` as
`CLICKHOUSE_PASSWORD`, never as `-p`/`--password`.

Where a secret may travel from the runner is fixed in code, not config:

- A provider key goes only to its own provider's host (`KEY_PROVIDERS` in
  `runner/src/providers.ts`; the self-hosted key only to the deployment's
  `WRATHBENCH_LOCAL_MODEL_HOSTS`).
- No child inherits the runner's environment: the snippet child gets a named
  list (`sandboxChildEnv`), and each CLI driver an allowlist of its own
  (`childEnv` in `adapter-claude.ts` and `adapter-codex.ts`), the plumbing a
  process needs plus the one credential it bills.
- The per-run session secret the child authenticates with is registered for
  redaction the moment it is leased: a snippet that prints its environment
  writes `[redacted]` into the trajectory, the sandbox host scrubs it from the
  child's stdout and stderr, and every tool result and context message is
  scrubbed before it is sent, so the model and the CLIs' own session files
  carry `[redacted]` too (runner/README.md, "The sandbox", says what no scrub
  catches).
- A run pod gets only the module secret and its driver's one credential ("Run
  pods").

**The images are private.** Every pod built from WrathBench's images pulls
with a Secret the cluster owns, named in the chart's `imagePullSecrets` value;
the chart never holds the credential. The MySQL and ClickHouse pods pull
upstream public images and carry none. Run pods add
`runPods.imagePullSecrets` for a repository that Secret cannot pull.
`runPods.allowedImages` defaults to `<image.registry>/wrathbench-runner`, so a
registry move moves the allow-list with it.

`WRATHBENCH_MODULE_SECRET` is the module's **port secret**
(wrath-mcp/module/PROTOCOL.md, "Authentication"). Every request to the
worldserver's control port, `GET /health` included, must carry it (or a
session secret leased with it) as `Authorization: Bearer`, and a module
started without one, or with one shorter than 32 characters, refuses to
listen and says so at ERROR in its log. Generate it once with `openssl rand
-hex 32` and put it in `.env`; it is the only place it lives. Who reads it:

- the **runner and fleet**: the run host presents it for hygiene, `/health`
  and `POST /lease`, then hands the snippet child only the per-run session
  secret the lease returned. The child's environment never carries the port
  secret: a snippet that could read it could list and delete on any account;
- the **smokes** (`infra/smoke/lib/auth.ts`), exec'd in the runner container,
  and the deploy script's `/health` probes, which run there too;
- the **worldserver**, as `AC_WRATH_BENCH_SECRET`. On the cluster the chart
  takes it from the `WRATHBENCH_MODULE_SECRET` key of the env Secret. On the
  quickstart compose interpolates it, and with `infra/` as its project
  directory it reads the repo-root `.env` only when told to: `--env-file .env`
  on every `up` (`infra/README.md`). An `up` without it ships an empty secret
  and the module refuses to listen.

An operator's loopback probe inside the worldserver container needs the
header too, and the image has neither curl nor wget: `bun wb server health`
(`infra/module-health.sh`) does it with perl and prints the full census
(`sessions`, drops by opcode). A probe from anywhere else, the runner
container included, gets liveness with the counters zeroed.

Rotating it is a deploy window: the worldserver and everything that presents
the secret must change together, and a process reads it once, at start. On the
cluster that is the env Secret, then the worldserver and every pod carrying
the key restart onto it with the fleet drained. On the quickstart stack it is
`.env`, then `down` and `up` again with `--env-file .env`.

### Network policy

The chart can put NetworkPolicies on the pods that run model-driven code: the
fleet pod and the run pods. Each gets an egress allow-list and no ingress. The
viewer, publisher and collector get egress allow-lists too. The switch is
`networkPolicy.enabled`, off by default. `templates/networkpolicy.yaml`
says what each policy admits and why. In short, the fleet and run pods may
reach:

- the module on 8086;
- cluster DNS;
- TCP 443 anywhere outside the private, CGNAT and link-local ranges, for the
  model APIs and the CLIs' own endpoints;
- the self-hosted model servers in `localModelHosts`, each of which must then
  be written as IPv4:port.

Only the fleet may reach the Kubernetes API, for the run-pod launcher, and
MySQL, for a gate smoke that stages a fixture (none does today). Neither may
reach ClickHouse, the viewer or any other address on the LAN.

**Turning it on is a release step of its own.** Ship the chart first, with the
switch off, which changes nothing. Then set the values in a separate GitOps
commit: a chart change and the values that depend on it can otherwise land in
either order. The values:

```
networkPolicy:
  enabled: true
  kubeApi:            # kubectl get svc kubernetes -n default; and its EndpointSlice
    - { cidr: <service ClusterIP>/32, port: 443 }
    - { cidr: <apiserver address>/32, port: 6443 }
```

A missing `kubeApi`, or a `localModelHosts` entry that is not IPv4:port, fails
the render rather than producing a policy that silently drops traffic. A
dropped connection does not fail fast: it hangs until its own timeout. So turn
the policies on with the fleet quiet, and check the result before resuming:

```
bun wb fleet drain                   # switch set, every run parked, fleet at 0
#  ...the values commit lands; `kubectl -n wrathbench get networkpolicy` lists five (six with staging on)
kubectl -n wrathbench scale deploy/wrathbench-fleet --replicas=1   # if the upgrade has not; it comes up paused
kubectl -n wrathbench exec deploy/wrathbench-fleet -- bun -e '
for (const u of ["http://worldserver:8086/health", "https://openrouter.ai/api/v1/models",
  "http://<localModelHost>/v1/models", "https://kubernetes.default.svc/version",
  "http://wrathbench-clickhouse:8123/ping", "http://wrathbench-viewer:8090/api/info"])
  await fetch(u, { signal: AbortSignal.timeout(5000), tls: { rejectUnauthorized: false } })
    .then((r) => console.log(r.status, u), (e) => console.log(e.name, u));'
bun wb fleet resume
```

Every line but the last two should print an HTTP status: any status means the
connection was made. ClickHouse and the viewer should print `TimeoutError`.
Resume as soon as it passes. After the resume, watch three things with the
fleet live:

- the next preflight gate pass, and the next `bun wb smoke suite` (kill-credit's
  fixture staging uses MySQL from the runner pod);
- each driver's first episode, through its first model call and first module
  call;
- the first run pod.

To roll back, set the switch off again. The policies are deleted and nothing
else changes.

### Party staging

The Deadmines eval (`docs/proposals/GROUP-PLAY.md`) runs on five staged
characters, put into their loadouts by `infra/fixtures/stage-party.ts`.
Gear is the one thing SQL cannot stage guid-safely, so it goes through the
worldserver's SOAP console as `.additem` on an admin account, STAGER. SOAP is
off until the chart's `staging` switch turns it on. The switch also does
these things, and nothing else:

- binds SOAP to the worldserver pod's own address, and adds 7878 to the
  ClusterIP Service;
- admits 7878 only from the fleet and runner pods, through an ingress policy on
  the worldserver, and adds the matching rule to the fleet's egress when the
  egress policies are on;
- adds PARTY1 to PARTY5 to the module's allowlist (STAGER is never on it, and
  the chart refuses to render it there);
- gives the fleet and runner pods the SOAP URL and STAGER's password. Run
  pods get neither, and `infra/run-pod.ts` refuses any SOAP or STAGER
  variable outright;
- mounts the data volume's `characters` subPath in the worldserver too, and
  sets `PlayerDump.DisallowPaths` to 0, so the character archive's `.pdump`
  can name a file the runner pod also sees ("Backing up and moving a
  character").

The compose quickstart keeps SOAP off.

**Turning it on** takes one deploy window, because SOAP, the allowlist and
the module are all read when the worldserver is recreated. Everything after
the window runs with the fleet live: PARTY1–PARTY5 are not in the pool and
on no job until a party campaign is enabled, and neither the gate nor the
suite touches them.

1. Before the window, with the server up, run
   `bun wb accounts ensure PARTY1 PARTY2 PARTY3 PARTY4 PARTY5`.
2. Pick STAGER's password: at most 16 characters, and there is no default. Put
   it into the env Secret as `WRATHBENCH_STAGER_PASSWORD`, the way every
   other key gets there, and never in this repository. The key has to be in
   the Secret before the pods start: the reference is optional, so a pod
   started without the key carries it empty until it restarts.
3. The values commit: `staging: { enabled: true }`. Then run the window as
   usual (`bun wb release run`); the fleet resumes when the gate passes.
4. After the resume, with no party campaign enabled yet, run these in this
   order:
   - `read -rs P && printf '%s\n' "$P" | bun wb accounts stager` creates STAGER
     with gmlevel 3, using the password from step 2.
   - `bun wb smoke deadmines-entry` checks the mine's mesh and the portal, on
     PROBE.
   - `bun wb smoke party-entry` stages a party, walks it into map 36 together,
     checks that it is one instance, and deletes the characters.
   - `bun wb smoke party-staging` stages the party, checks every member at
     login, and deletes the characters.
5. While a party campaign is enabled, run `deadmines-entry` after any release
   that touches the module, on PROBE with the fleet live.

To turn it off, set `staging.enabled` back to false in another window. The
policy, the port and the env go away. The PARTY and STAGER accounts stay in
auth, where they are harmless.

**Restaging** happens before each fresh party launch, never on a resume. The
roster runs `bun infra/fixtures/stage-party.ts --request -` with one request
on stdin (`infra/party-stager.ts` holds the contract): the party id,
campaign, version, scenario and level, and per member the member id, role
word, race, class, character name, account and run id. The first member
leads. The definition names the characters and the stager creates them under
those names. Each member wears the loadout of its race and class
(`infra/fixtures/loadouts.ts`): a Human Warrior tank, a Dwarf Priest healer,
and as damage a Human Mage, a Human Rogue and a Dwarf Paladin, so no pet is
ever staged. A member of any other race and class, or a level other than 20,
is refused before anything is touched. The script exits 0 when the party is
staged and formed with no session open, and its last stdout line is then
`{"ok":true,"detail":…}`. Otherwise the reason is the last line on stderr:
exit 1 for a staging that failed, 2 for a refused request. If a member does
not wear its loadout at login, the loader refused an item and mailed it, and
the stager says so.

A fresh launch never takes a run id already on disk: its stem is numbered
(`-a<n>`) past every run there, of any version, and it never resumes the day's
roster file (`--resume-roster` is for a paused party only). A new version
counts its own attempts against `maxAttemptsPerCell` from nothing. Once an
attempt's roster exits, the campaign's tally alone decides whether the square
launches again. A solo probe square's same-day retry is numbered the same
way, but its exited roster still waits for a disable and re-enable, or a
supervisor restart.

By hand, in the runner pod:

```
bun infra/fixtures/stage-party.ts --example | bun infra/fixtures/stage-party.ts --request -
```

This stages the default party: PARTY1 to PARTY5, one of each loadout, named
from the account (`Tankpartyb` on PARTY1). The smokes use the same request.
**Every staging deletes every character on the party accounts, so never run
one while a party run holds those accounts.** Each party smoke takes about
three minutes end to end, which is why they never run in a hold.

### Harness version stamping

Every episode is stamped with a harness version. On the cluster it is the
image tag the chart passes (`WRATHBENCH_HARNESS_VERSION`, the `git describe`
the image was built at), and an episode running as its own pod on an arm's
image is stamped with that image's tag, never the fleet's ("Run pods"). On
the quickstart `run-roster` computes `git describe --tags --always --dirty` at
launch against the bind-mounted `.git` (on the host, `run-episode.sh` does),
so a dirty tree stamps `-dirty`.

## Public dashboard

The public site is **push-based**: a publisher on the lab renders the viewer's
own API to JSON on a timer and PUTs it to a bucket (R2 here; any S3-compatible
one, "Where it publishes, and how"), and the SPA is built a
second time to read that bucket instead of `/api`. No public request ever
reaches the lab. `docs/PUBLIC-DASHBOARD.md` is the design, the rejected
alternatives and what the site may carry; `infra/cloudflare/README.md` is how
to stand it up and verify it, step by step; this section is operating it once
it exists.

**The live viewer is private and operator-only, and is unsupported as an
Internet-facing service.** It stays on loopback, or on a LAN the operator has
explicitly opted in with `WRATHBENCH_VIEWER_LAN=1`. Public delivery is the
static snapshot path in this section and nothing else: never a port on the
viewer, the module or the MCP bridge, and never a tunnel to one.
`WRATHBENCH_VIEWER_PUBLIC=1` exists so the snapshot renderer can call the
handle in-process; it is not an exposure plan.

The publisher's key pair (`S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`) lives
in the `wrathbench-env` cluster secret, and in `.env` for a hand-run pass or the
tile upload; the deploy token (`WRATHBENCH_CF_DEPLOY_TOKEN`) lives in `.env`
alone. Neither can do the other's job.

### First publish, by hand

On the cluster the publisher is the chart's `publisher` Deployment
(`publisher.enabled`), which runs `--loop` from its first boot; `bun wb inspect
publisher` shows what it last did. On the quickstart, `mkdir -p data/publish`
first — it is the publisher's only writable path and Docker would otherwise
create it as root. Then one pass:

```
docker compose -f infra/compose.yml run --rm --no-deps publisher \
  bun infra/publish-dashboard.ts --once
```

The chart's Deployment, compose's service and a hand pass take the same
variables, and they must stay in agreement:

| variable | value | why |
| --- | --- | --- |
| `WRATHBENCH_RUNS_DIR` | `data/runs` | the evidence record. The publisher only reads it, and opens a 0.5 run's `run.sqlite` read-only, but the mount is writable: a reader of a WAL-mode database creates and maps its `-wal` and `-shm` beside it (`runner/src/rundb.ts`) |
| `WRATHBENCH_CONFIG_DB` | the config store (the chart sets the PVC's path; unset under compose, where the default `data/config.sqlite` holds) | the store's roster names the models the pages label |
| `WRATHBENCH_PUBLISH_STATE` | `data/publish/state.json` | what was uploaded last, so a pass PUTs only what changed. Deleting it is the repair for a bad immutable object, and it also re-uploads every published trace segment in one pass: 288 a day for each character a trace recorded, which for a long freeplay fleet is tens of thousands of PUTs at once |
| `WRATHBENCH_PUBLISH_INTERVAL_MS` | `60000` in the script; the chart and compose set `300000` | `--loop` cadence. Five minutes is a cost choice against R2's class-A free tier, not a freshness one; the harness's own floor is 30–60s, so a faster push would buy little |
| `WRATHBENCH_PUBLISH_BATCH` | `8` | runs projected before the pass uploads them and drops the bodies. The pass's memory dial: measured peak RSS over a 1,016-run tree is 1.08 GB at 25, 0.78 GB at 8 and 0.59 GB at 1. Eight matches the per-run read pool's width |
| `WRATHBENCH_PUBLISH_FULL_RENDER_MS` | `21600000` (6 h) | the longest a cold run goes without being rendered in full. A pass skips a finished run whose inputs have not moved (docs/PUBLIC-DASHBOARD.md, "The publisher (lab side)"), and this bounds how stale anything the skip cannot see leaves its objects. `0` renders every run every pass |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | the publisher's key pair | `.env`, never argv |
| `S3_BUCKET` | `wrathbench-public` | the Secret's, or the chart's `publisher.target.bucket` |
| `S3_ENDPOINT` | `https://<account-id>.r2.cloudflarestorage.com` | the bucket's S3 API endpoint, not a public hostname: the Secret's, or `publisher.target.endpoint`. Unset is AWS's, from the region |
| `S3_REGION` | unset (Bun's `us-east-1`) | `publisher.target.region`; R2 takes `auto` |
| `WRATHBENCH_PUBLISH_VIRTUAL_HOSTED` | unset | `1` for an endpoint that names the bucket in its hostname (`publisher.target.virtualHostedStyle`) |
| `WRATHBENCH_PUBLISH_DELAY_MS` | `0` | how far the public view trails live play (`publisher.delayMs`) |
| `WRATHBENCH_PUBLISH_HISTORY` | unset | `0` publishes only the current view (`publisher.history: false`) |

The `S3_*` names are `Bun.S3Client`'s own, which is why they are not
spelled `WRATHBENCH_*`; `infra/publish-settings.ts` reads all of these.

### Where it publishes, and how

Deployment config, in the chart's `publisher` block; every default is the
publisher as it was.

- **Target**: any S3-compatible bucket: R2, MinIO, Spaces or AWS. The key pair
  is always the Secret's. The endpoint and bucket are too unless
  `publisher.target` sets them, where they are plain values, since neither is
  a secret. With `networkPolicy` on, the publisher reaches only
  `networkPolicy.internet`, so a bucket on the LAN needs a rule of its own.
- **Delay** (`publisher.delayMs`): the public view trails live play. A pass's
  content-addressed objects go up at once, named by nothing yet; the keys a
  reader can reach without the manifest (`live.json`, `nearby.json`, the
  manifest and the trace windows) are held in the state file's `held` and
  written once the pass is that old, with its flip and prune recorded then.
  Nothing a held pass names is pruned before it is shown, and the social
  card waits with its pass. The public map is unaffected: its playhead is set
  from each snapshot's `generatedAt`, which is the render's. `live.json`
  carries the delay (`delayMs`, only when there is one), so the shell's
  staleness warning waits that much longer. The cost is a
  state file that carries the held passes' mutable bodies, and a site the
  delay plus one interval behind. Turning the delay off writes what is held,
  oldest first, before the next pass.
- **History** (`publisher.history`): `false` publishes only the current view:
  the runs that have not ended (live, or paused and coming back) and the
  aggregates over them. A run that ends is withheld and withdrawn like a run
  that is never published, so its objects leave the bucket. Fewer objects
  change a pass, which is what a bucket's writes are billed on.
- **Off**: `publisher.enabled: false`, or the viewer group off. Nothing is
  rendered, and nothing already in the bucket is touched.

Then read the bucket back before trusting the loop with it: `bun wb site
verify` (`infra/publish-accept.ts`) walks the whole generation, and `--base
https://wrathbench-data.shard.page` walks it again through the public
hostname, which also exercises the custom domain and the cache rules.

### Minimap tiles (a separate step, never automatic)

The snapshot loop uploads JSON only. Tiles go up by hand, from a checkout with
`data/minimap` populated by the extraction in `minimap/` and its bakes of the
zoomed-out levels and the art layer (`minimap/README.md`), and only when the
extraction has changed: the skip-unchanged check is a content hash kept in
`tiles/manifest.json` in the bucket, so a re-run with nothing new PUTs nothing.

```
bun wb site tiles --dry-run    # transcodes locally, then counts; uploads nothing
bun wb site tiles --upload
```

It uses the same `S3_*` credentials as the snapshot publisher
(`WRATHBENCH_MINIMAP_DIR` overrides the root) and uploads the served tree, not
the PNG masters: each pass first runs the transcode, which only re-encodes
what changed (`minimap/README.md`, "Served formats"). `bun wb site ship
--tiles` runs the same upload as part of a deploy. Two things go with it:

- `WRATHBENCH_TILES_BASE` in `.env`, without which the built site asks for
  nothing.
- After a re-extraction, a purge of the `/tiles/` prefix, since the keys are
  reused; otherwise the tiles cache rule's day has to pass. An upload ends by
  naming the maps whose art it changed: purge `/tiles/<map>/art/` for each
  (`infra/cloudflare/README.md`, steps 4 and 6).

### Start the loop, then deploy the SPA

On the cluster the loop is the Deployment, and `kubectl -n wrathbench logs -f
deploy/wrathbench-publisher` follows it. On the quickstart:

```
docker compose -f infra/compose.yml up -d --no-deps publisher
docker compose -f infra/compose.yml logs -f publisher
```

`--no-deps` for the same reason as the fleet. The service sits behind the
`publish` profile so a bare `up -d` cannot start a second publisher against
the same bucket. Stopping the publisher needs no drain: an interrupted pass
leaves the last manifest pointing at the last complete set.

The app is a separate deploy, and only ever a UI change, because data never
moves through it:

```
bun wb site ship               # or `bun ship`, the same script
```

`infra/deploy-dashboard.sh` needs three names from `.env`:
`WRATHBENCH_SNAPSHOT_BASE` (`https://wrathbench-data.shard.page`),
`WRATHBENCH_PUBLIC_ORIGIN` (`https://wrathbench.shard.page`, which the card's
absolute `og:image` is built against) and `WRATHBENCH_CF_DEPLOY_TOKEN` (or a
`bunx wrangler login` in its place). The first two are hard failures if
unset: an empty snapshot base would quietly build the *private* bundle, which
on the public hostname polls `/api` forever.

### Verify

`infra/cloudflare/README.md`'s verify step is the check, the cache rule first
because it is the one misconfiguration that bills. Two readings belong to the
steady state:

- The staleness banner reads a plausible age: a minute or two, never hours and
  never negative. It reads only the last push, so hours means the publisher
  stopped, not that a cache is cold.
- A run detail page shows its published entries window and nothing more: no
  "load earlier", no live tail, no raw line. If a raw line ever renders, stop
  the publisher — the content boundary has a hole.

### Every Eval Ever export

`bun wb export eee` writes the scored ladders, `e90` and `e360`, as
[Every Eval Ever](https://github.com/evaleval/every_eval_ever) aggregate
records (schema 0.3.0, vendored at `infra/eee/eval.schema.json`). It reads the
same artifacts the public site does — `ladder-e90.json` and `ladder-e360.json`,
already through the public projection — and derives each record with the
ladder page's own code (`dashboard/src/lib/ladder.ts`), so the numbers are the
site's. Freeplay and probes have no scored ladder and are never read.

```
bun wb export eee --base https://wrathbench-data.shard.page   # the published generation, no credential
bun wb export eee --runs data/runs                            # rendered from a runs tree, as the publisher does
bun wb export eee --base … --series 0.5 --out data/eee/0.5 --bundle data/eee/0.5.json
```

One record per (series, episode, harness, model, effort, compaction window),
over the runs the ladder ranks: no live, paused, lapsed or steered run, and no
scripted reference. Free runs are left out by default, as on the public site;
`--include-free` exports them too, and the coverage line counts what was left
out either way. Each record carries:

- the series as `eval_library.version`, and every exact harness version in
  the cell;
- the harness label as `agent_scaffold`, the effort, the run ids and `n`;
- `model_availability` (`open_weights`, `closed_weights` or `unknown`), from
  the model's `weights` in `infra/model-catalogue.json`, looked up at export
  time;
- three results that are the ladder's three keys — `highest_rung`,
  `best_level` (with the xp within it, and the min, median and max level of
  the cell's runs) and `best_money` — plus the order between them.

No game text: rung numbers, never titles, and no character, zone or map. Every
record is scanned as the publisher scans a body, and a finding writes nothing.
A run left out is counted on stdout with its reason: a flat model id the
catalogue cannot place has no developer EEE could file it under.

Output is the datastore's own layout, `<out>/data/wrathbench/<developer>/<model>/<uuid>.json`,
under `data/eee/<snapshot time>/` by default, and the file name is fixed by the
record's identity, so a re-export of a cell lands on the same file. EEE's
validator is a Python package: run it from a throwaway venv outside this
checkout, with Hugging Face's client offline, and from `<out>`, because it
checks each path's depth from `data/`.

```
uv venv /tmp/eee-venv && VIRTUAL_ENV=/tmp/eee-venv uv pip install every-eval-ever==0.3.0
cd <out> && HF_HUB_OFFLINE=1 HF_HUB_DISABLE_TELEMETRY=1 /tmp/eee-venv/bin/python -I -m every_eval_ever validate 'data/wrathbench/*/*/*.json'
```

Exit 0 is clean, 2 is warnings only (which still block a merge there), 1 is an
error. The export submits nothing. Submitting is the operator's decision, made
on EEE's side: a pull request to the `evaleval/EEE_datastore` dataset on
Hugging Face carrying `data/wrathbench/`, titled `[Submission] …`, with the
coverage line from stdout. EEE also asks for the converter as an adapter in
its own repository and for the benchmark and metric ids in
`eval-card-registry`; model ids are not resolved against that registry here.
