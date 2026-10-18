# Runbook

How to run the harness day to day. Architecture is in `docs/ARCHITECTURE.md`;
what the agent may see and do is `docs/CONTRACTS.md`. Bringing the stack up on
a fresh machine is `infra/README.md`.

The fleet runs on Kubernetes from the Helm chart at `infra/chart/wrathbench`,
and the chart is also the reference for anyone doing a more serious
deployment. `infra/compose.yml` is the single-machine quickstart
(`infra/README.md`, "Try it on one machine"): it brings the same services up
to try WrathBench without installing anything, and there is no compose deploy
path — no deploy window, no update script, no rollback. A compose stack is
brought up, used and brought down; the release and update procedures below
are the cluster's.

The operator commands below are `bun wb <group> <command>`, run from the
repository root (`infra/wb.ts`). `bun wb` lists them, and `bun wb <group>`
shows the script each one runs and where. A command that reads the data
volume runs in the runner pod, the rest run on your machine, and the
arguments after the command go to the script untouched. `bun wb --local …`
targets the quickstart stack instead, where a command has a compose form.

## Running the fleet as a service

The fleet supervisor (`infra/run-fleet.ts`) is a long-lived service — a
Deployment on the cluster, and a compose service on the quickstart stack. It
has no deadline, and it is steered entirely through the config store, which it
re-reads every 60 seconds ("Where the config lives", below). It lives inside
the runner image rather than on the host so it survives the operator's shell
and reboots, and never crosses the container boundary to spawn a runner.
The chart and compose run it the same way — the same image, the same store
re-read every 60 seconds, the same drain on SIGTERM — with the Deployment
scaled 0/1 where compose stops and starts a service. Read every
`docker compose` line below as the quickstart stack's; on the cluster the
equivalent is a `kubectl scale` or `kubectl rollout restart` of that
Deployment, and the update verbs, `bun wb fleet graceful|force|drain|resume|state`
(`infra/fleet-update.sh`), speak only kubectl.

### Start it

```
docker compose -f infra/compose.yml up -d --no-deps fleet
```

`--no-deps` is not optional. Without it compose may decide a dependency (the
worldserver, typically, whose committed config can be ahead of the running
container) is out of date and recreate it — dropping every live episode. The
service sits behind the `fleet` profile precisely so that a bare
`docker compose -f infra/compose.yml up -d` cannot start a second supervisor
against the same config; naming the service is what activates it.

### Watch it

```
bun wb fleet status                                     # read-only report
kubectl -n wrathbench logs -f deploy/wrathbench-fleet   # supervisor stdout
kubectl -n wrathbench exec deploy/wrathbench-runner -- tail -f data/runs/fleet-<job>-<stamp>.log   # one job's roster stdout
docker compose -f infra/compose.yml logs -f fleet       # supervisor stdout, quickstart
```

`--status` reads `data/runs/fleet-state.json` on the data volume, which is
why `bun wb fleet status` runs it in the runner pod: run on a workstation,
`infra/run-fleet.sh --status` reads that machine's own `data/`, which on a
cluster deployment is empty. Liveness comes from a heartbeat the supervisor
refreshes each tick, not from a pid probe that would mean nothing across
pods. A supervisor that has been gone for more than three ticks
reports `NOT RUNNING`. Finished runs get no rows there: the run directories and
`fleet-<stamp>.jsonl` are the record.

### Where the config lives

**The sqlite config store is the only fleet config.** The
active config is operational state, not source, and is
never committed to git. It is `config.sqlite` on the data volume, beside
`runs/` (`$WRATHBENCH_DATA/config.sqlite`, overridable with
`WRATHBENCH_CONFIG_DB`; on the cluster the `config` subPath of the
`wrathbench-data` PVC at `/wrathbench/data/config/config.sqlite`, mounted
writable on the fleet, the runner, the viewer and the publisher; under compose
the same `data/` bind mount at `data/config.sqlite` — nothing to provision
either way). The store's `config_audit` table is the history: actor, note,
and the before and after documents of every change.

The one config document in git is **`infra/fleet.example.json`, the
bootstrap**: a newcomer seeds the store from it once and gets a working board,
with no campaign or queue job that would run. Nothing else reads the example. Export (the CLI and the page)
renders the store to a document, for reading or for diffing against an earlier
export — never for committing.

- The supervisor reads the store on boot, on every 60s re-read, and in
  `--status`; the viewer's `/api/models`, `/api/campaigns` and `/api/config`
  read the same store, and so does the publisher, so the public site labels
  what the fleet is actually running.
- An **empty** store — zero rows, or no file yet — is a legitimate state, not
  an error: the supervisor runs an empty board and prints one line naming the
  seed command every tick it stays empty; `/api/config` answers
  `seeded: false`; the `/config` page shows the seed instruction. Nothing crashes, nothing drains a live run because of
  it, and nothing repopulates silently.
- A store that **cannot be opened** (locked past the busy timeout, corrupt, a
  permissions slip) is a different state and is treated the way a document
  that does not parse is: the supervisor keeps its last good config, complains
  once, and retries every tick, and `--status` leads with the `config
  REJECTED` banner. The two are kept apart deliberately — a transient read
  failure must never read as "every job vanished".
- An edit through the app is live **one tick later**. Nothing restarts, and
  nothing about scheduling changed: the store is read where the file was read,
  and the same `parseFleet` refuses the same things.
- Every write is validated against the WHOLE config — an edit the supervisor
  would refuse is refused with the same sentence — and recorded in
  `config_audit` with the actor, the note, and the before and after documents.

Edit it from the **viewer's `/config` page**. Every write takes a note,
which lands in `config_audit` beside the actor. The page is operator-only: no
nav link and nothing served on the public build or behind a public viewer,
which is the same condition `/api/config` is mounted under. The viewer has no
login; it answers only to its own names, `localhost` and IP addresses (the
DNS-rebinding guard, `runner/viewer/README.md` "Host allowlist"). On the
cluster its names are the chart's `viewer.ingress.host` and `extraHosts`, so a
rename is those values and nothing else; elsewhere they are
`WRATHBENCH_VIEWER_ALLOWED_HOSTS`. Any other name gets a 421.

```
# the CLI — for a script, or a viewer that is not up
bun wb config seed                     # once, on a fresh deployment: infra/fleet.example.json (--force replaces)
bun wb config get roster/sonnet
bun wb config patch roster/sonnet '{"tier":"t2"}' --actor operator --note "promote"
bun wb config audit 20
bun wb config export > /tmp/fleet.json # to read or diff; never to commit
```

The store is on the PVC, so `bun wb config` runs `runner/src/config-store.ts`
in the runner pod (`kubectl -n wrathbench exec deploy/wrathbench-runner -- bun
runner/src/config-store.ts …`), the same way `fleet-state.json` is read;
`infra/k8s-deploy.sh` reads the `preflight` block that way too (`get
preflight`). A file argument is a path inside the pod, so an export goes to
stdout and is redirected on your side. The
endpoints behind the page are the
same operations over HTTP and are documented in `runner/viewer/README.md`;
they are operator-only and are not mounted at all when the viewer is in public
mode.

### Steer it

Edit the config — on the `/config` page, or with the CLI. Nothing to restart.
The unit you steer is the
**job**: a roster entry (or a rotation of several), an episode, a
repeat count, on one account — pinned to it when the job names an `account`,
otherwise on whichever pool account is free.

- `"enabled": false` — the job **drains**: no signal while it has an episode in
  flight, SIGTERM at the next episode boundary. Worst case a just-started
  episode is terminated gracefully; never a corrupted one. A pool job frees
  its account when the process exits; deleting a job from the queue drains it
  the same way. A roster starts its next episode milliseconds after the last
  one ends, faster than the supervisor's once-a-tick look, so the drain is
  also written beside the job's log (`<jsonl>.drain`). The roster checks it
  before every launch and exits at that boundary. Re-enabling the job before
  then removes it.
- `"enabled": true`, or a brand-new job — spawned on the next tick (a pool job
  when an account is free) for what its `repeat` still owes. `enabled` belongs
  to a JOB; on a roster entry it is refused (pause a character with
  `idle: "none"` — "Strict keys", below).
- **`repeat: n` is a total, counted off the runs on disk**, never off the
  supervisor's memory, which a restart loses. A job's progress is the counted
  runs its ref already has on that episode in this harness series: the same
  runs the policy's tier target counts (`isCounted`, archive included),
  whoever launched them. A policy pick shares the job's name, so the two
  cannot be told apart, and a run is worth the same either way. A run that
  ended `manual`, `attempt-failed`, `stale`, `adapter-error`, on a harness
  error or with no model response does not count and is redone under a fresh
  run id. A run still in flight does not count yet. A job whose count is met is
  **done**: it spawns nothing across restarts, day stamps and releases, and
  `--status` shows `(3/3 counted) — done`. To get more runs, raise `repeat`;
  flipping the job off and on adds none.
- A job whose process exits while enabled is *finished* for the life of that
  supervisor, and is not respawned even if a copy did not count. A supervisor
  restart, or flipping the job off and on, retries what it still owes. A job
  that can never be satisfied (a dead endpoint) therefore costs its remainder
  once per boot or flip, and never loops.
- A malformed edit is complained about and ignored; the last good config keeps
  running. Check it first if you like, with `bun wb fleet dry-run`
  (the store validates every write, so a rejected config is rare: a shape the
  running code does not read, or a store it could not open).
- While the config is rejected, **every `enabled` flag in it is inert** — including
  a later, valid-looking edit disabling a job, which the supervisor never sees
  because it never gets past the parse. `--status` leads with a REJECTED
  banner and marks a pinned job's flag as not in effect until a re-read
  succeeds. The banner comes from the
  supervisor's own state file, not from parsing the config here: the two can be
  different versions of the code, and the supervisor's verdict is the one that
  decides what runs. Trust the banner over your own reading of the store.

Two enabled jobs must not share an account, a pinned account may not be in the
pool, and the roster policy (claude models on the claude-code driver only —
the claude-code harness — and that driver runs claude models only; no claude id
on the codex driver) is enforced on every roster entry at every re-read.
Billing is derived rather than policed, so no model id is refused for what it
costs; an entry the rules put on the wrong side — a stealth id quoted at zero
with no free suffix, say — states `billing: "free"` or `"paid"`, and its runs
carry that word to every reader. The price sync writes no zero row for a
suffixless id, so such a preview is free only by that declaration. Free models on
OpenRouter or OpenCode Zen share one rate-limit key per platform because those
free tiers are pooled per upstream provider: a single sequential run per pool
is both the polite and the effective shape — two runs on one pool just trip the
same rate limits twice. OpenCode Go is billed apart from Zen on the same host,
so every model on a Go base counts against its own key, `opencode-go`, its free
slugs included; the base's path is what tells the two apart.

#### Config reference

The store is the config ("Where the config lives", above); the shape below is
what `infra/fleet.example.json` shows and what an export renders — a store row
is one piece of it (a singleton block, or one roster entry, campaign or queue
job). "Changing the config shape" below is how a shape change ships.

```
preflight   the gate (below): enabled, account, smokes [{script, account}], timeoutMs,
            deploySmokes, deployTimeoutMs. Its accounts may not be in the pool or on a job.
accounts    { pool: [...], paid: [...], local: [...] } — the account classes, each in
            preference order. Never PROBE, never SMOKE*. `pinned` is derived from the jobs and
            refused if authored.
roster      name -> entry. The keys an entry may carry are `ROSTER_ENTRY_KEYS`
            (infra/run-fleet-config.ts) and nothing else; anything else REFUSES the entry by
            name ("Strict keys", below).
            NO character name: the model names its own at createSession, and the name it chose is
            what the run row, meta.json and the runs page carry. `character` is REFUSED by name
            here (as it is in a campaign or a cell) — a name in the config is one the harness has
            to keep valid and unique, and an invalid one takes the whole file down. A fixed name
            was actively harmful: a character name is realm-wide unique while the hygiene that
            clears it is per-account, so a fresh attempt scheduled elsewhere met a name it could
            not use and no way to pick another. The launch note invites a name inside the game's
            own rule and says it is the model's for the episode; the roster's suggestion survives
            only for a model that would rather not choose. The freshness belt does not read names:
            it arms on every character guid hygiene listed for the account, so a model that names a
            survivor is caught by its guid and its level, never by its spelling. `race` and
            `class` are not the model's either, but they stay: they are the episode's
            comparability dimensions. Never an account. Two scheduling axes (docs/METHODOLOGY.md, "The tier is
            the evidence budget"):
            `tier` — REQUIRED, and the only thing that sets a run count. t0 trial (e90 x1, the
              ladder is HELD and it never climbs on its own), t1 standard (e90 x3, climbs to t2 on
              one counted level-5 e90), t2 long (e90 x3 + e360 x1). The table is code
              (`TIER_TABLE`, runner/src/models.ts) — a bespoke volume is a NAMED tier added there,
              not a number edited into one entry. On EVERY entry: the roster is a model catalog,
              so there is no unscheduled entry to make an exception for.
            `objective` and `wikiCoords` — REFUSED. Steering is a campaign, which names this entry
              in an assignment and supplies its own task shape.
            `idle` — what it does with an account once its tier is spent. `none` (default, and
              what a paid model wants) or `unlimited` (one continuous freeplay session at a time,
              with no episode wall clock — the idle watchdog is what ends it). Never bought by
              omission. A race/class sweep is a campaign now, not an idle mode. Flipping
              `unlimited` → `none` pauses the live session at once; flipping it back brings the
              same character back ("Freeplay characters are durable", below).
            `routing` — which backend behind OpenRouter may serve this entry. Three spellings:
              a provider name (`"Z.AI"`), a list in preference order (`["Z.AI", "Together"]`), or
              the object `{ order, sort, allowFallbacks, requireParameters }`. `sort`
              (price|throughput|latency) is an ALTERNATIVE to `order` and refused alongside it;
              `allowFallbacks` defaults to false, so a request a named provider cannot serve FAILS
              rather than moving to another machine. Absent means the model author's own provider,
              fallbacks off — `openai/...` pins OpenAI, `z-ai/...` pins Z.AI
              (`LAB_PROVIDERS`, runner/src/routing.ts, whose names are the ones responses have
              actually carried). An author with no first-party endpoint on record pins nothing and
              still never falls back; name the provider here to pin it. An entry that declares an
              `effort` also requires the parameter by default, so a backend that would silently
              drop `reasoning_effort` is skipped rather than mislabelling the matrix cell.
              OpenRouter entries ONLY: on a claude-code/codex entry, or an apiBase that is not
              OpenRouter (Cerebras, LM Studio, OpenCode Zen or Go), `routing` takes the whole file down
              rather than sitting there doing nothing. The resolved routing is stamped into the
              run's comparability tuple and the provider that actually served it is recorded on
              the run (docs/METHODOLOGY.md, "Routing is pinned"). The served provider is recorded
              rather than keyed — a fact observed minutes after launch cannot be part of what a
              launch stamped — and with fallbacks off the two agree, which is what makes a
              disagreement worth seeing. An OpenCode Go run cannot be pinned: Go picks the
              backend behind each model and the request has no way to name one. So it stamps
              `{ via: "OpenCode Go", allowFallbacks: true }`, unpinned and keyed apart from a
              pinned run of the same model, and the backend that answered each call is recorded
              from Go's response headers (`x-opencode-endpoint-id`,
              `x-opencode-upstream-model-id`). The field is absent, not null, on a run whose
              request has no routing to state (a CLI harness, Cerebras, LM Studio, OpenCode
              Zen): there is nothing to record, and those runs stamp exactly as they did before
              the field existed.
            `wiki` — whether this entry's runs get the reference wiki at all. Default true; set
              `false` and the run has no `search_reference` tool, the prompt does not name one,
              and no bundle is opened (issue #61). It is a
              capability switch declared on the run, not an arm bought out of the tier budget, so
              `wiki: false` is stamped into the comparability tuple as a KEY and those runs never
              share a chart with the runs that had it. `wikiCoords` alongside it is REFUSED:
              coordinates are a setting of a surface this entry does not have. A probe drops it
              with the other run dimensions — a campaign owns its own task shape.
            `compactWindow` — claude-code entries ONLY: the CLI's auto-compaction window, `"auto"`
              or 100k–1M tokens (`"100k"`, `"500k"`, `"1M"`). Absent or `"auto"` is the CLI's own
              default, which sits near the model's whole context. Normalised on load (`"100K"` →
              `"100k"`, `"1000k"` → `"1M"`, `"auto"` → absent); on any other driver, or out of
              range, it takes the whole file down. A run dimension like `effort` (operator
              decision 2026-10-09): stamped into the tuple as a KEY, part of the run id, and part
              of what maps a run back to its entry — so a copy of an entry that differs only in
              its window owns its own runs and its own tier budget, and pages show it after the
              effort (`max · 100k`). Mechanics: runner/README.md, "The compaction window".
            `apiBase` / `apiKeyEnv` — openai entries: the endpoint, and the NAME of the env var
              holding its key (absent: OpenRouter and `OPENROUTER_KEY`). The pair must be one the
              provider table holds (`KEY_PROVIDERS`, runner/src/providers.ts): each key goes only
              to its own provider's host over https, and `LMSTUDIO_KEY` only to a host the
              deployment lists in `WRATHBENCH_LOCAL_MODEL_HOSTS` (chart: `localModelHosts`). Any
              other pairing REFUSES the entry by name, a write through the store is a 400, and
              run.ts refuses to start one. A new provider is a row in that table, not config.
            A t0 model that reaches level 5 KEEPS the witness (`t0*` in --status) without spending
            it: move it to t1 and it promotes at once on evidence it already has. Moving a model
            by hand is always allowed and never records a promotion — "promoted" is said only of
            a climb.
policy      Only where runs execute and how many at once. maxConcurrent { <rate-limit key>: n }
            caps the runs in flight per key (`concurrencyKeyOf`), counting every job on that
            key, pinned ones included.
            Optional, off when absent: `paid { maxConcurrent 1 }` — at most that many paid runs in
            flight. It is a THROTTLE, not a budget: how much a paid model runs is its tier, the
            same sentence a free model's budget is written in.
            Billing is derived per model (free slug / LAN apiBase / claude-code -> free, else
            paid); `roster.<name>.billing: "free"|"paid"` overrides it. To the scheduler, billing
            says only WHERE a run may execute — the account class and the rate-limit key.
            An openai entry's override is also recorded on each run it launches: the reader's
            verdict (the ladders' "exclude free") follows it, and a recorded free needs no price.
            `runsPerEpisode`, `paid.runsPerEpisode` and `extras` are not 0.5 keys and are refused
            by name, as are `roster.<name>.runsPerEpisode` and `roster.<name>.tiers`.
            `routing` — the fleet-wide default for OpenRouter entries, same shape as an entry's.
            An entry that states its own keeps it WHOLE: the two are alternatives, never merged,
            because a merged routing is one nobody wrote down. Absent means the built-in default
            (the model author's own provider, fallbacks off).
            `runPods` — `"off"` (default) or `"probes"`: where a probe-campaign episode executes.
            `probes` runs every probing episode as its own pod on the cluster, on the arm's image
            ("Run pods", below). Anything else is refused. While it is not `probes`, or off the
            cluster, an arm that pins an image or a command is a refused pair, never run on master.
campaign-defs  published campaign definitions, `<id>@<version>` → { definition, hash, source,
            publishedAt }. Written ONLY by runner/src/campaign-publish.ts and never changed: `set`,
            `patch`, `delete`, the /config page and a reseed all refuse the prefix, and a second
            publish with a different hash is refused ("Probe campaigns", below). A seeded document
            may carry them only exactly as the store holds them (an export, restored), so a
            fresh store gets its definitions by publishing them, then seeding the rest.
campaigns   probe campaigns (docs/EPISODES.md, `probing`): the DYNAMIC half only —
            { <id>: { version, enabled, assignments [{ model: <roster name>, runsPerCell }],
            account?, excludeUnhealthy? } }, strict. The shape (cells, arms, start, leash, stop
            level, resume, attempt cap) is the published definition `<id>@<version>`. A row the store
            will not write (no version, an unknown key) or one naming a version nobody published is
            refused by name on read, alone: the roster, the policy and every other campaign load.
            `version` is explicit, never "latest", so a new publish cannot re-target a sweep. Every
            run is an unscored `probing` episode. With `account` the campaign is PINNED and follows
            the pinned-job account rules; without, the policy schedules it between the evals and
            the idle work, on a model that owes no eval and holds no live or paused run. Either
            way `excludeUnhealthy` skips a retired or cooling model. Completion is DERIVED per
            (id, version, assignment, arm, cell) against the counted probe runs on disk — set
            `enabled: false` when a sweep is done and its results stay visible. Progress is on the
            /campaigns page ("Probe campaigns", below).
queue       jobs, in priority order (never `probing`: a probe is a campaign's cell): { ref | [refs], episode e90|e360|freeplay, repeat n|"loop",
            enabled, account? } — plus `subscription` (a lane's env var NAME) and nothing else;
            any other key REFUSES the job by name ("Strict keys", below). With `account` the job is PINNED to it and never the policy's;
            without, it is a manual pool job that outranks the policy. The name is always
            `<first ref>-<episode>` (run ids `fleet-<name>-<model>[-<effort>][-<compactWindow>]-<stamp>`), one job
            per (ref, episode). A numeric `repeat` is DERIVED like a campaign's completion: a total
            of counted runs per ref on disk in this series, and a job that meets it is done ("Steer
            it", above). A pool job whose ref is not eligible for its EPISODE is skipped
            with the reason in --status; a pinned one waits the same way. A waiting manual job
            reserves the POOL only — the paid and local classes still pick, and the reservation
            is named in --status.
```

#### Strict keys, and how to pause a character

A roster entry and a queue job each carry a **declared set of keys**
(`ROSTER_ENTRY_KEYS` and `QUEUE_JOB_KEYS` in `infra/run-fleet-config.ts`) and
nothing else. A key outside the set REFUSES that entry or job by
name: the refusal line in `--status` says which key it was and what to write
instead, the rest of the file stays in effect, and a live run under the refused
entry or job is left alone — it just does not respawn. Whole-file rejection is
what a shape error gets. (Campaigns are strict through their own
schema; account lists are plain names and have no keys to get wrong.)

The key to watch: **`enabled` is a queue job's word, not a roster entry's** — on
an entry it is refused by name, so it is not how a character is paused.
To pause a character, set the entry's `idle: "none"`: the freeplay
job stops being generated, the paused run reads "not in config — resume by
hand", and it stays down until `idle: "unlimited"` comes back (the character is
durable — "Freeplay characters are durable", below). To take a model out of
scheduling entirely, set its tier and idle to what you actually want; there is
no on/off switch on a catalog entry.

A roster entry referenced by a pinned job is never policy-scheduled: the account
is spoken for. Nothing else takes an entry out of the policy — a campaign
BORROWS a catalog entry rather than removing it from the schedule. Everything
else in the roster is the policy's (below). This
is the only shape: a file that still says `lanes` or `accounts.pinned` is
refused by name, with the message naming the 0.4 keys.

#### Adding a model

New OpenRouter models arrive as **drafts**, on demand, from the `/config`
page: nothing to run in a pod, no file to edit, no key to mount. **fetch new
models** reads the OpenRouter catalogue once — it is public, so the call carries
no credential, and it is bounded at 16 MB and 20 seconds — and proposes every
tool-calling model the roster does not already run and nobody has ignored.
Free and paid are both proposed, labelled from the slug the way the roster
labels them; the list is newest first with a free/paid toggle. A second fetch
adds only what is new, refreshes a pending draft's price, and never brings an
ignored model back.

A draft is not config. It is a `proposed/<model id>` row in the store, which
`parseFleet` — and so the supervisor, `/api/models`, the ladders and the
publisher — never reads; nothing schedules it; and a fetch or an ignore writes
no line to the history and does not move the version, so a few hundred drafts
cannot bury the record of what the fleet ran. An ignore is remembered by model
id (with who ignored it) and survives a reseed; **un-ignore**, in the collapsed
*ignored* list, undoes it.

Each draft carries an estimate of one `e90`: the catalogue's list price applied
to the median counted `e90` of this series on the wrathbench harness, from
provider-reported tokens only — prompt, completion and cache reads, each its
own median. It is labelled an estimate on the page because it extrapolates
from other models' token shape (docs/COSTS.md); with no counted `e90` to take a
profile from there is no estimate at all.

**promote** writes an ordinary roster entry — `{ model, tier }`, plus `race`
and `class` when given, else the harness defaults — through the same validation
and the same attributed, version-checked write as any roster edit, and it is
in the history like one. The tier has no default: promotion never picks one
(docs/METHODOLOGY.md, "The tier is the evidence budget"). The entry states no
`routing`, because absent is the rule — the author's own provider, fallbacks
off, or `policy.routing` where the fleet sets one; the routing column shows
which — no `billing`, because it is derived from the slug, and no `idle`. A
refusal — a name or a model the roster already has, a claude id on the openai
driver — is shown on the row, and the draft stays.

Nothing calls the model first: whether a slug really answers a tool call is
what its `t0` trial finds out. A model the catalogue does not carry — a
claude-code or codex lane, the LAN box, Cerebras, OpenCode Go — is still added with **add a
roster entry**. The endpoints are in `runner/viewer/README.md`.

An OpenCode Go model is an openai entry with `apiBase`
`https://opencode.ai/inference/go/openai/v1` (the base Go's docs give; the
older `https://opencode.ai/zen/go/v1` still answers and is the same surface)
and `apiKeyEnv` `OPENCODE_KEY`, under the id Go's own listing uses
(`https://opencode.ai/inference/go/v1/models`, no key needed). Only the
models Go serves over chat completions can be reached this way; its Responses
and Anthropic-messages models cannot. Go admits agents other than its own client
on stated conditions, and the adapter meets them as itself: its own user
agent, and `x-opencode-session` set to the run id, one value for the whole run.
It never sends the headers that identify OpenCode's own client. Go picks
the backend behind each model, so a Go run stamps unpinned routing and
records the backend that answered (`routing`, above). A `-free`
Go slug derives free; any other derives paid, which puts it under the paid
throttle, and is priced by a `PROVIDER_PRICES` row on that exact base, since
Go reports no per-response charge.

A new model needs a price too, or its runs read no expected cost. `--status`
lists every roster entry with none, and says which fix it needs: a paid
OpenRouter or codex model is priced by `bun wb data prices`, a new Claude
model by a dated row in `CLAUDE_PRICES`, a non-OpenRouter provider by one in
`PROVIDER_PRICES` (both in `runner/viewer/pricing.ts`). The price file ships in
the image, so either way the price reaches the viewer with the next release.

### Stop it

```
docker compose -f infra/compose.yml stop fleet
```

A stop **pauses** the live runs. SIGTERM
reaches the supervisor, which SIGTERMs each job's roster, which SIGTERMs the
runner; the runner pauses its run as `operator-pause`: the episode clock stops
(the minutes spent so far are written to meta.json and the budget resumes from
there), the request or tool call in flight is abandoned, the game session is
logged out so the account is free, and the run is marked paused — not
terminated, not counted, not a ladder failure. The roster records
`paused-operator` and exits; the supervisor waits for every roster (polling
every 2s while stopping) and exits. For a **scored** run the pause is where it
ends: a stop does not cost a run its *place*, but it does cost it that
attempt — the run is ended `manual`, the model is not blamed for it,
and the scheduler gives it a fresh attempt with a full clock. Freeplay, and a
probe campaign that asked to resume, come back where they left off. The runner's own backstop is 60s, the
roster's SIGKILL grace 90s, the service's `stop_grace_period` 180s, in that
order. The next `up -d` resumes the paused runs before it launches anything
fresh (below). Ctrl-C on a hand-started `infra/run-episode.sh` still ends the
run as `manual`: SIGINT is the operator's cut, SIGTERM is the supervisor's
pause.

To stop launching *without* pausing what is running, use the pause switch —
"Updating the live fleet", below. The supervisor does not exit when it runs out
of work: with no deadline it idles (logging so once) and waits for the config to
give it something, because exiting under `restart: unless-stopped` would just
restart it a minute later with a new epoch.

`docker compose rm fleet` afterwards if you want the container gone; the state
in `data/runs/` is what matters and it is on the bind mount.

### Updating the live fleet

This is the cluster's procedure. The fleet's update verbs (`bun wb fleet
graceful|force|drain|resume|state`, `infra/fleet-update.sh`) and the deploy
window, `bun wb release deploy` (`infra/k8s-deploy.sh`), speak only kubectl; a quickstart compose stack has no
update path beyond `up -d --build`, which recreates what changed under
whatever is running. On the cluster the repo is baked into the runner image
rather than bind-mounted, so every code row of the table below lands with a
release (a new image tag, `bun wb release run`); the config store and the
wiki bundle live on the data volume and need none.

Everything that changes the harness reaches the running fleet one of three
ways, and the first question is always **which**:

| What you changed | How it lands |
| --- | --- |
| `runner/src/**`, `sdk/**`, the wiki bundle | the **next episode spawn**. The repo is a bind mount and every episode is a fresh `bun runner/src/run.ts`: nothing to restart, and a run in flight keeps the code it started with. |
| the config store (`/config` page or `config-store.ts`) | the **next tick** (60s). Hot-reloaded; every write is validated, and a config the running code refuses is complained about and ignored. |
| `dashboard/**` | `bun run build` in `dashboard/`, then restart the viewer service. No fleet involvement. |
| `infra/run-fleet*.ts`, `infra/run-roster.ts`, the runner **image**, compose env | only when the **`fleet` container's process restarts**. That is what the two recipes below are for. |

The supervisor's date stamp (`fleet-<job>-<model>-<YYYYMMDD>`) is taken once at
start and fixed for the life of the process — an *epoch*, not a calendar date,
so `--resume-roster` and the loop's `-cN` numbering keep meaning what they
meant. A supervisor up for three days still stamps the day it started; a
restart rolls it, and so does `restart: unless-stopped` after a crash or a
reboot. Resumes do not care: the run id is read off disk.

#### Graceful — nobody's run is interrupted

```
bun wb fleet graceful             # the whole thing
bun wb fleet graceful --dry-run   # the plan and every resolved value; safe while runs are live
bun wb fleet state                # the switch, the heartbeat, the live jobs
```

It sets the **pause switch**, waits for every run a recreate would *cost* to end
on its own clock, recreates the container on the new code, waits for the new
supervisor's first heartbeat, and clears the switch. No attempt is spent. Some
runs are still signalled: the switch itself SIGTERMs a freeplay character at
once (it has no episode boundary to drain to), and the
recreate lands on whatever parked runs are still mid-episode. Nothing *scored*
is ever signalled, which is the promise that matters.

It does not wait for the runs that come back **where they left off**: the
freeplay character and a probe campaign with `resume: true`. Once the switch has
put such a job in `draining` the wait counts it as drained and moves on — an
`idle: "unlimited"` session has no clock to finish on, so waiting for one is
waiting to the 8h ceiling — and such a session comes back on the same run id
and character anyway. The status
lines name both halves each poll: `waiting on:` for the runs holding the window
and `counted drained:` for the parked ones. Whether a job parks is the
supervisor's own answer, published per job row as `resumesInPlace` in
`fleet-state.json` — the script never re-reads the config for a campaign's
`resume` flag, because the switch has to work while the config is rejected. A
supervisor older than that field does not write it, and the script falls back
to the freeplay pair (`source: policy`, `episode: freeplay`).

The switch is `data/runs/fleet-pause.json` (`{"paused": true, "why": "..."}`),
read every tick beside the config. While it is set the fleet launches
**nothing** — no queue job, no policy pick, no campaign cell, no resume of a
paused run — and every running job *drains*: SIGTERM only once its roster is
between episodes, exactly as `"enabled": false` on one job does. It is a
sidecar rather than a config key on purpose: a rejected config makes
every `enabled` flag in it inert until somebody reads the banner, and the stop
button must not be able to do that. It also works while the config is rejected,
which is when someone most wants it. Set it by hand if you prefer
(`fleet-update.sh` only writes and deletes that file); `--status` leads with a
banner naming it, and distinguishes the switch on disk from the one the
supervisor has picked up.

Three costs, all printed by the script:

- the drain race the supervisor has always had: an episode spawned in the
  instant between the idle check and the SIGTERM gets run-roster's graceful
  30s episode termination. Worst case one just-started episode, never one
  mid-flight.
- a run already **paused by its provider** is not resumed while the switch is
  set. If the window outlasts that run's own episode budget it is swept as
  stale — and a stale *provider* pause is a **counted** failed attempt against
  the model (`runner/src/lapse.ts`). The script lists such runs before it waits;
  a long wait with one of those on the board is a reason to clear the switch and
  update later. Waiting is bounded (`--timeout`, default 8h) and a timeout
  leaves the switch set and kills nothing.
- a **parked** run (freeplay, or a `resume: true` campaign) is SIGTERMed by the
  recreate wherever it happens to be, exactly as `force` would do it. It resumes
  on the same run id, account and character; nothing scored is spent.

A **refused pin** (the `!` block in `--status`) is deliberately spared from
draining — its live run was overruled, not parked — so a refused pin that loops
holds the window open until the timeout. `--status` names it; disable it in the
file, or use `force`.

"Quiet" is only ever claimed from a state file the script actually parsed,
written by a supervisor whose heartbeat is current: an unreadable file (the
supervisor writes it non-atomically, so a poll can land mid-write) and a dead
supervisor's frozen rows both keep waiting rather than recreating over live
episodes.

Ctrl-C during the wait is safe: no scored run has been signalled, the switch stays
set, and `bun wb fleet resume` puts the fleet back to work — which
the script says, loudly, on the way out. An aborted window that looked like
nothing happened is how a fleet ends up scheduling nothing until somebody
notices.

**Draining a supervisor that does not read the switch.** The switch is
supervisor code, so a supervisor from before it existed ignores it. The
equivalent drain, needing nothing but the hot-reloaded config, is an edit —

```
accounts: { "pool": [], "paid": [], "local": [] }   # the policy has nowhere to schedule
campaigns: every one "enabled": false               # each drains at its episode boundary
queue: []                                           # nothing manual
```

— then wait for `--status` to show no live job, `kubectl -n wrathbench rollout
restart deployment/wrathbench-fleet`, and put the accounts and campaigns back. `infra/fleet.test.ts` pins that this edit parses and
schedules nothing. It is strictly worse than the switch — it is an edit to the
config whose every flag goes inert on a typo, and it does not stop a *resume* —
so it is the fallback and never the recipe.

#### Forceful — now, and it costs the live runs

```
bun wb fleet force                # asks for confirmation; --yes to skip
kubectl -n wrathbench rollout restart deployment/wrathbench-fleet   # the same thing by hand
```

The fleet pod stops inside its 180s termination grace, so every live
run takes the **pause** path rather than being killed: the supervisor SIGTERMs
each roster, each roster SIGTERMs its episode, and the runner writes a pause and
logs the character out. Nothing is corrupted. What it costs:

- a scored run (`e90`/`e360`) is ended `manual` on the next boot: **the attempt
  is spent** — with whatever money or quota it had burned — and the scheduler
  gives the model a fresh attempt with a full clock. `manual` is in
  `NOT_THE_MODELS_FAULT`, so it is **not a strike** and never reaches a scored
  surface; three of *those* would taint a model, and a supervisor kill is not
  one of them (docs/METHODOLOGY.md, "Episodes, lanes, and evidence").
- freeplay, and a probe campaign with `resume: true`, come back where they left
  off on the same account and character. An automatic resume also **restates
  the current leash** rather than inheriting the stored one: the runner reloads
  `meta.json` and only replaces a limit a flag names, so a freeplay run created
  under an older policy would otherwise come back under that policy's clock and
  ceiling. The roster emits `--watchdogs-json {"episodeMs":null}` and
  `--max-tool-calls 0` for the `idle: "unlimited"` lane, which rewrites both
  caps to `null` on the resumed run while its run id, account, character,
  session token, trajectory and scratchpad are all the stored run's.
- a preflight smoke in flight dies with the container; the gate re-runs it.

If the switch is already **set** when `force` runs — the ordinary way to arrive
here is an aborted `graceful` — force clears it after the recreate, once the new
supervisor's heartbeat is in, and names the `why` it found on the way past.
Force *starts* the container, so a switch left set behind it is a fleet that
runs and schedules nothing; `drain` is the mode whose job is leaving it set, and
that one stops the container instead. A supervisor that does not come back
leaves the switch set, exactly as on the graceful path.

`fleet-update.sh` does not build or pin an image for you: new code reaches the
fleet pod through a release (`bun wb release run`), whose drain and resume
phases are this script's.

#### The worldserver

`bun wb release deploy` (`infra/k8s-deploy.sh`) owns its own window and is the **forceful**
path by design: its `draining` phase scales the fleet to 0, so every live run
pauses and a scored one spends its attempt, exactly as above. That is the
documented trade — the script needs nothing from you while it runs, and a
deploy must never depend on an operator watching a wait loop.

For the graceful version, drain first and hand the script a quiet fleet:

```
bun wb fleet drain        # pause, wait for quiet, scale the fleet to 0; switch stays set
bun wb release deploy     # its own drain finds nothing live; it scales the fleet back
bun wb fleet resume       # clear the switch; the pool fills on the next tick
```

The deploy still brings the fleet up on every exit path — that invariant is
untouched — so `resume` is the only step you owe it afterwards. If you forget,
`--status` says the fleet is paused and nothing schedules until you do.

#### What a restart does to paused runs

The restart procedure is **stop → (runs pause) → start → (scored runs
are ended as failed attempts and reattempted; freeplay and opted-in campaigns
resume)**. On boot, before the queue or the policy spawns anything, the
supervisor finds every paused run whose model and episode are still in the
config, maps it back to its job (a pinned or queued job from the config,
else a synthetic policy job with the attempt read off the run id), and spawns
that job's roster with the paused run id first and `--resume-roster`, on the
**same account** — the character lives there, and a fresh launch on that
account would wipe it. `--resume` reattaches the trajectory and scratchpad,
recreates the game session with the same character, and continues the episode
budget; the claude-code driver cannot reattach the CLI's own conversation, so
such a run restarts with a fresh CLI session (the same fixed prompt, the
scratchpad, the same "runner restarted, this run resumed" notice every driver
gets) and is stamped `resumedFresh: true` in meta.json. Only once every resume
has its account does the pool fill. The same planner runs every tick, so a run
paused by its provider (`rate-limited`, `quota-exhausted`) is resumed once its
cooling is over — see "Lapsed runs" below. A supervisor that boots with the
pause switch set does none of this until the switch is cleared, which is what
keeps an update window from filling the pool behind the operator's back; its
log names a planned resume or policy pick once the switch is cleared, not while
it holds.

### Lapsed runs: paused, and stale

A run that stops without a verdict is handled by its **lane**
(docs/METHODOLOGY.md, "Episodes, lanes, and evidence").

A **scored** run (`e90`, `e360`) — and a probe campaign that did not set
`resume: true` — does not resume. `--status` shows it on its account as a
failed attempt and lists it among the lapsed runs the supervisor ends on its
next tick. The supervisor writes the
termination through the runner's own writer, releases the session so the
account and character go back, and the policy schedules a fresh attempt on the
tick after. Three counted failures on one (model, episode, series) and the
model is **tainted** for that episode: `--status` says so and the model is
blocked — not "free", so
it takes no idle work either — until `bun wb fleet clear-model <name>`. A
fleet stop (`manual`) and an offline gap (`stale`) do not count toward those
three: they are the harness's doing. Do not confuse this taint with the
roster's own `tainted` in a job's defer sidecar, which is one process backing
off a model whose launches keep failing.

**Stale** runs are swept on boot and on every tick: any run with no termination
whose last activity (its pause mark, else its trajectory) is older than **its
own** episode budget — 12h for a run with no wall clock — is ended. That is the
half-day outage case: the host slept, and every run left live or paused had its
budget elapse in wall clock while nobody was playing it. A freeplay session is
never stale: it has no budget to elapse, and it is resumed under its own run id
however long the gap (below). A run the fleet did
not launch (no `fleet-` prefix) is never ended by the supervisor: it is listed
for the operator.

A run with **no verdict at all** — no termination, no pause, no live process —
is a runner that was killed before it could write (a SIGKILL inside the stop
grace, a host that lost power). On the lanes that resume, the supervisor reads
it as paused `offline` as of its last activity and resumes it as it would an
`operator-pause`, once the run provably has no owner; `--status` shows it the
same way. It is never left in limbo, and its character is never a launch's
leftover: it stays the character head, it holds its model, and every other
launch on its account keeps it. The scored lanes are left to the stale sweep
above — a lapsed `e90` is a failed attempt either way.

The proof of "no owner" is the run's **heartbeat**: a runner rewrites
`heartbeat` in its run directory every twenty seconds and removes it on any
exit it gets to make, so a fresh one (under two minutes) means a process owns
the run — on this pod or any other — and a cold one means it was killed. A
quiet trajectory proves nothing, because a run waiting on a slow provider
writes nothing. A verdict-less run with a cold heartbeat is resumed on the next
tick; one with no heartbeat file at all (its runner predates it) is listed as
offline until it has been silent for its own idle watchdog
plus two minutes (thirty minutes when it recorded none). `run.ts --resume`
and the roster both refuse a run with a fresh heartbeat — exit 75, nothing
written, the session not touched — so a resume by hand cannot land on a run
the fleet is playing, nor the reverse.

For the lanes that **do** resume — freeplay, and a campaign whose definition says `resume` —
`--status` shows the pause on its account and a `paused runs not resumed` block
with why:

- **not in config** — the model or episode is gone from the fleet config (or the
  pinned job is disabled, or on another account). Resume it by hand
  (`bun wb run episode --resume <run id>`, on its account) or archive it.
- **cooling** — a pause on the roster's defer ladder (every reason but
  `operator-pause` and `offline`), indexed by the run's pause streak: its
  ladder pauses since its last segment that made a turn, so a segment that
  played starts the count over. The two-stage retry answers the mid-episode
  pause question: the roster retries a mid-episode provider pause in place while
  its process lives;
  once it gives up and exits, the supervisor takes over on the longer ladder,
  resuming in place on the same run id. Past the ladder the run is listed,
  not hammered. A provider pause whose provider said when its allowance
  resets (OpenRouter's free-tier daily limit names the next 00:00 UTC) waits
  for that instant instead: the roster makes no in-place retry, the
  supervisor resumes the run at the reset, once, and the pause neither spends
  a rung nor counts toward the streak. Every attempt before a known reset is a
  refusal already announced, and counting them ran a freeplay stream's whole
  ladder out hours before its daily allowance came back. Only a reset 10
  minutes to 48 hours out is honoured: a per-minute window stays on the
  ladder, which is what stops a saturated key resuming every few minutes
  forever. `--status` lists such a run as `resuming at <time> (provider
  reset)`. A subscription lane's spent quota (codex, claude-code, an OpenCode
  Go allowance) waits for its usage window's reset the same way, up to seven
  days out, listed as `(usage window reset)`; "The subscription usage gate",
  below. A freeplay run the gate paused (`subscription-budget`) is on no
  ladder at all: it resumes once its window is back under the threshold. A run paused `observation-stalled` (its sandbox's event stream
  closed and the recorded state stopped moving) cools on the same ladder, but
  the runner releases its session and the roster advances, so the supervisor
  always brings it back, with a fresh sandbox and session. A run paused
  `infrastructure-failed` — a CLI scaffold failing on its host, such as the
  codex CLI unable to write its thread under `CODEX_HOME` on a full volume —
  takes the same path: the roster frees its session and advances, and the
  ladder keeps resuming it, so a volume the operator has freed is picked back
  up, and one still full climbs the ladder until it is listed. The CLI's own
  words are in the pause detail and the run's `codex_stderr` records; the
  model is never shown them.
- **waiting** — its account is busy with another job or held by a
  hand-started run. A resume never moves to another account.

While a run is paused its model is held: on a lane that resumes the supervisor
resumes the run and never reschedules the model, and on one that does not the
run is ended as a failed attempt on the next tick, then reattempted fresh.
Either way no second attempt starts for that model, and
a paused run counts toward nothing until it finally ends.

### Freeplay characters are durable

A freeplay character — the one an `idle: "unlimited"` ref plays across its
sessions — is the operator's to disable and re-enable at will, and it
survives that. Without it only a *pause* would come back: every
ended session (idle watchdog, a hand kill) would be followed
by a fresh attempt whose hygiene wiped the account and whose model named a new
level-1 character.

The character's identity is nothing new on disk: the ref's latest freeplay run
that is not live and recorded an account and a character — ended **or paused**
(`charactersFrom`; matched on model + effort like account affinity, so a
renamed ref keeps its character). Latest means newest **start**, the one order
the model hold and the resume planner read too, so of two paused runs of one
character the one resumed is the head, whichever paused last. A paused head is
normally resumed rather than continued from, and the resume reserves its
account and job name before the policy picks;
it is a head so that a paused run the resume planner declines still holds the
lineage, instead of the next attempt continuing from the ended run before it.
What the supervisor does with it, per tick:

- **Disable** (`idle: "unlimited"` → `"none"`, or the fleet pause switch): the
  policy job is drained, and for this lane a drain is an immediate SIGTERM —
  there is no episode boundary to wait for on a session with no wall clock.
  The runner logs the character out and writes `operator-pause`; `--status`
  lists the run as `paused, not in config` while the ref stays `none`.
- **Re-enable**, however much later: the paused run is resumed in place by the
  ordinary resume path — same run id, account, character, scratchpad. A
  freeplay pause never goes stale — for every reader alike: while it sits it is
  listed by `--status`, it holds its model (the policy starts nothing for that
  ref, scored or not), and it is never continued from, because a continuation
  is only ever hung on a run that ended. A pause the supervisor will not resume
  by itself (a provider pause past the defer ladder, a ref no longer in the
  unlimited lane) therefore waits for the operator: resume it by hand, or end it.
- **After an ended session** (the watchdog, or the operator's kill): the next
  policy pick is a **continuation**: a new run id (`-a<n+1>`) launched with
  `--continue-from <predecessor>`. The runner refuses it unless the launch is
  `freeplay`, the predecessor is a freeplay run on the same account and named
  a character; then hygiene keeps that character and clears the rest, the
  predecessor's `scratchpad.md` is copied in, race and class are the
  character's, and the model is told which run and character it continues
  instead of getting the naming note. The lineage is on the run record. If the
  character turns out to be gone,
  the run drops the lineage everywhere (`continue-dropped`), deletes the
  copied notes and starts fresh — a lineage the character does not back is
  the wrong record.
- **The account is the character's.** A freeplay pick prefers its character's
  account over the model's last run. If that account is busy, who holds it
  decides (`characterStanding`):
  - the ref itself (its own live run, or its resume reserving the account):
    nothing to plan, the run is in flight;
  - another ref's **bounded** run — a scored episode, a probe, a hand-written
    job — ends at its episode boundary, so the pick is **held**, never
    started fresh elsewhere;
  - another ref's **unlimited session** has no boundary to wait for, and
    waiting is the deadlock the first day of durable characters produced (two
    heads on one account: the occupant's `--keep-characters` protects the
    waiter's character, `POST /character-delete` refuses `account_in_use`,
    and the waiter holds forever). The pick starts **fresh on the free
    account it was offered**, lineage dropped: no `--continue-from`, and the
    drop is recorded on the new run, in the supervisor log and in `--status`.
    With no free account the ref simply gets no pick, and the supervisor says
    once why the next one will be fresh.
  The orphaned character stays where it is. `keepFor` derives from
  `charactersFrom`, and a head is the ref's latest **ended** freeplay run with
  a character: while the fresh session is live the old head is still the
  character, so the occupant's keep-list (fixed at its own launch anyway) and
  the next launch on that account still protect the orphan. Once the fresh
  session ends having named a character, it is the head, the orphan belongs
  to no character, and the next fresh launch on the old account wipes it in
  ordinary hygiene (the cross-account name sweep stops skipping it too). If
  the fresh session dies before naming one, the old head stands and the
  next pick is decided the same way again.
- **One character per model+effort.** A `unlimited` ref has exactly one
  character at a time, and the freeplay ladder shows the live field, not
  every dead character a model ever rolled. The
  older ended sessions of a character are parked with
  `bun runner/src/archive.ts --run-ids` ("Archiving runs"), which is a
  decision about listings and nothing else: the character is untouched,
  the trajectories survive under `archive/`, and the scheduler still reads
  them.
  A continuation whose predecessor has been archived **stays valid** —
  `loadContinuation` reads it from `<runs>/archive/<id>`, scratchpad and
  all, because the character election reads archived facts too. A
  predecessor that is on disk nowhere is not fatal either: the launch drops
  the lineage (`continue-dropped`, naming the missing id) and starts fresh
  rather than dying.
- **Nothing else deletes it.** Every fresh launch on an account that holds
  another ref's freeplay character gets `--keep-characters`, so a scored run's
  hygiene leaves it standing (the model is told the name is taken, and the
  freshness tripwire still arms on its guid); the cross-account name sweep
  skips freeplay characters and the character of every run that has not
  ended.
- **Hygiene has a guard of its own**, below anything the supervisor passes:
  before deleting, the runner reads the run directories for the account
  (`characterOwners`) and never deletes a character whose newest run has no
  termination — it may be minutes from being resumed, and a character is the
  one thing a resume cannot recreate. A character above level 1 that no
  *ended* run accounts for is kept too, unless the launch passes
  `--allow-character-delete` (the fleet never does). Both are logged and
  recorded in the trajectory; the model is told the name is taken. A level-1 leftover,
  or a scored episode's leftover whose run ended, is cleared as always.
  Archiving a run does **not** release its character: the guard reads
  `archive/` too, so an archived run with no termination still owns its
  character (the supervisor, for its part, never resumes or continues an
  archived run). The release is a termination on the run's row: to end a run
  by hand, `bun runner/src/classify.ts <run id> manual [note]`, which refuses
  a run with no termination and no pause (it may be live) unless given
  `--force`.

The policy line says what happened, and `--status` prints one row per
`idle: "unlimited"` ref with its head and the verdict above. Roster changes that
compete for one account go in **one write, owner first**: the hot reload is 60 s, and two edits in sequence let a second
character elect the account between them. A hand-written
`freeplay` job on the same ref is the operator's own experiment and never
continues anything. To start a character over deliberately, delete its character
(`POST /character-delete` on the module, the sweep's own path) before
re-enabling: the continuation finds nothing and starts fresh.

Scored episodes are untouched: `--continue-from` is refused on `e90`/`e360`,
their hygiene still clears everything but another ref's freeplay character,
and a lapsed scored run is still a failed attempt.

### Node disk pressure

A node that runs out of root disk evicts pods, and it does not ask nicely: at
the hard threshold the grace period is zero, so `terminationGracePeriodSeconds`
buys nothing and a live episode dies without writing its pause record. The
chart is built so that WrathBench is neither the cause of that nor the first
thing chosen when it happens.

The kubelet ranks candidates by whether a pod's ephemeral-storage use exceeds
its **request** before it looks at anything else, so a container with no
request is in the first group to go however little it is writing. Every
container in the chart therefore requests `ephemeral-storage`, at the same
modest default: what these containers write to node-local disk is a log line on
its way to the runtime and a scratch directory of a few kilobytes, because
everything that is evidence — trajectories, the module's audit trail, the
config store — is on the data PVC, which is not ephemeral storage and does not
count toward it. The request is a rank, not a budget.

Every `emptyDir` carries a `sizeLimit` for the other direction: unbounded, it
is simply node disk with a friendly name, and the pod that fills a node is the
one that gets evicted for it. The ceilings sit far above the working set on
purpose. They are a backstop against a runaway, not a quota to run near —
exceeding one evicts the pod, which costs every run it was supervising, so a
limit that could be reached in normal operation would be worse than none.

`priorityClassName` is the third piece and the only one the chart cannot
decide: priority is compared across every workload on a cluster, so the value
is the deploying cluster's and the chart creates no PriorityClass. Left empty,
the field is omitted from every pod and the deployment behaves as before. Set
it to a class the cluster defines and the realm outranks whatever else is
sharing the node when one fills.

### Server log retention

The worldserver's own log goes to the console (`kubectl logs`). What it keeps
as files on the data PVC is `logs/Errors.log`, held open and rewritten on
every boot, and the module's audit log, one JSONL per session token under
`logs/wrathbench`. The audit log is what grows — about 0.6 GB a day per live
freeplay stream, and it had reached half the volume — and it is kept for a
window, not for good (docs/CONTRACTS.md "Audit"): `worldserver.logRetention.days`
in the chart's values, default 3, `0` to disable. The
`wrathbench-log-retention` CronJob prunes it once a day (`schedule`), from the
worldserver image, by age. Its own CronJob so that changing the window never
rolls the worldserver.

What it never does is touch a file the server still holds open. A file is
deleted only when it is quiet for the window *and* older than the running
server process: the module writes a line the moment it opens a file, so a file
the process holds is newer than its start, which the pass reads from `GET
/health`. A file quiet for the window but younger than the process is emptied
in place instead — safe for an append-mode writer — and deleted after the next
restart. With the module unreachable nothing is deleted. The pass is one
`readdir` and a `stat` per file, reads nothing, and logs counts and bytes,
never a name: the names are session tokens. A file still being written is
never trimmed, so a freeplay stream that lives for weeks holds its whole log
until the run ends, and that file goes with the first pass after the window.

```
bun wb server log-retention            # dry run inside the worldserver container: counts, bytes, and
                                       # how many candidates the server holds open (always 0)
bun wb server log-retention --days 7   # the same for another window
bun wb server log-retention --apply    # a Job from the CronJob, now; waits and prints its log
```

To keep one run's audit past the window, copy it out before the pass. The
token is `config.token` in the run's `meta.json`; it travels on stdin, never
argv:

```
token=$(kubectl -n wrathbench exec deploy/wrathbench-runner -- bun -p 'JSON.parse(require("fs").readFileSync("data/runs/<run-id>/meta.json","utf8")).config.token')
printf '%s\n' "$token" | kubectl -n wrathbench exec -i deploy/wrathbench-worldserver -- sh -c 'read -r t && cat "/azerothcore/env/dist/logs/wrathbench/$t.jsonl"' > <run-id>.audit.jsonl
```

Or raise `days` in the deploying cluster's values for as long as it is needed.
The compose quickstart has no retention: its `data/logs` is a bind mount you
prune yourself.

### Deploy window (worldserver changes)

A worldserver change reaches the cluster in a release, and `infra/k8s-deploy.sh`
(`bun wb release deploy`) is the only deploy window. There is none for compose: a quickstart stack takes
a new worldserver with `docker compose --env-file .env -f infra/compose.yml up
-d --build`, which recreates it under whatever is running and verifies nothing.

#### On the cluster

```
bun wb release build --push                    # every image, tagged `git describe` (infra/build-images.sh)
bun wb release run                             # the whole release, start to finish (infra/k8s-release.sh)
bun wb release run --dry-run
bun wb release run --pin-hook <your pin hook>
bun wb release run --from pin                  # restart at a phase
bun wb release deploy                          # the deploy window alone (infra/k8s-deploy.sh)
```

`infra/README.md`, "Releasing on Kubernetes", has the phases, the pin hook,
and what `k8s-deploy.sh` — the deploy window on its own — refuses.

The images are built from the commit, never from the working tree.
`build-images.sh` unpacks a `git archive` of the commit into a temporary
directory and builds there, so nothing untracked or ignored in your checkout
can reach an image, whatever the ignore files say. The server images take
AzerothCore the same way, from the submodule commit that the commit pins, and
take only the paths `server.Dockerfile` copies. The submodule therefore has to
be initialised in the checkout you build from. Uncommitted edits are never in an
image, which is why a dirty tree is refused. `--allow-dirty` builds the commit
anyway, but its `-dirty` tag is never pushed. `k8s-release.sh` hands the build
the exact commit its tag describes.

Each image then goes through `infra/image-guard.sh` before anything is pushed.
The guard lists the image's filesystem and refuses one that holds a
secret-shaped path (env files, keys, credential and token files, agent or
wrangler state, sqlite stores) or client data. It names the paths, never their
contents. The run stops and the refused image loses its tag. A refusal means
the commit or a Dockerfile step put that file in the image, so fix it there.
Don't widen the allow-list in the guard to get past it.

A worldserver whose world load came up short is never started. Its pod waits
for MySQL to answer a query before the load begins (the `wait-for-db` init
container), and its startup probe passes only on a `200` from the module's
`/health`, which answers `503 world_not_loaded` when a core store came up empty
or MySQL restarted during the load (module/PROTOCOL.md, `GET /health`). Such a
pod is restarted when the startup budget runs out (`worldserver.startupProbe`,
15 minutes), so a deploy window waiting on it fails first, at "the worldserver
rollout did not complete". `bun wb server health` prints the counts and
`dbRestarted`; `kubectl -n wrathbench delete pod -l
app.kubernetes.io/component=worldserver` restarts it now instead.

#### Deploying a harness change that needs a real smoke first

The gate smokes drive the module with a scripted client. They never start the
Claude Code or Codex CLI and never run a model's snippet, so a change to what
those touch, such as the environment the CLIs start with or the snippet
sandbox's confinement, passes them untested. The default resume phase would
then put every paused run straight onto that build. Release such a change held:

```
bun wb release run --pin-hook <your pin hook> --keep-paused
bun wb run episode --account PROBE --driver claude-code --model <id> --max-tool-calls 20
bun wb run episode --account PROBE --driver codex --model <id> --max-tool-calls 20
bun wb run episode --account PROBE --driver openai --model <id> --max-turns 5
bun wb fleet resume
```

`--keep-paused` reaches `k8s-deploy.sh`, which sets the pause switch before its
drain if nothing has, scales the fleet back to 1 on every exit path as always,
and never clears the switch. The release skips its own resume phase and says
so. The supervisor comes up and schedules nothing, and that includes resuming a
paused run, because a resume is a spawn like any other and the switch disables
every spawn. Then smoke one short real run per driver on PROBE (or SHAKEOUT),
with no `--episode` so that it is unscored, and `--token-env` for a second
subscription lane. The CLI drivers have no turn limit, so `--max-tool-calls`
bounds them. Read each trajectory as far as a logged-in CLI and a snippet that
reached the module. A run that hits its limit costs the model nothing, but one
that dies before the model answers, or on an adapter error, is a rung on that
model's cooling ladder, and `bun wb fleet clear-model` forgives it. Only then run `bun wb fleet resume`. Keep the window short,
because a provider-paused run is not resumed while the switch is set and can go
stale, which counts (see "Graceful" above). If a smoke fails, nothing scheduled
has run on that build: revert the pin, and resume once a build passes.

#### What each phase means

`infra/k8s-deploy.sh` writes `data/runs/server-state.json` at every
transition, and the Fleet page's banner is the phase plus the script's own
`detail` sentence verbatim. The page never guesses at what the window is doing.

- **draining** — the fleet Deployment is scaled to 0. SIGTERM reaches the
  supervisor, every live run pauses (see "Stop it"), and the supervisor writes
  its final state and exits. The script then waits, for at most 300s, for that
  state file to say no job is alive — the supervisor's own word, never a
  process listing — and for the fleet pod and every run pod to be gone, since
  the supervisor's own preflight smoke is not a job and still holds a smoke
  account. A pod that outlives the wait, or a pod listing that fails, fails the
  window closed with the pod named.
- **waiting** — the worldserver rollout Flux performs, then `/health` answering
  ready with the bearer, for at most 900s.
- **verifying** — the gate smokes (`preflight.smokes`) and then the deploy
  smokes (`preflight.deploySmokes`: the game surface and the `module-quest.ts`
  full arc) run through `kubectl exec` into the runner pod, each list against
  its budget. The fleet is down, so nothing else is on the smoke accounts. The
  detail names the smoke in flight.
- **resuming** — every smoke passed; the fleet is scaled back to 1. The
  supervisor boots, re-gates on the new server identity and resumes every
  paused run on its own account before the queue or the policy gets one. Under
  `--keep-paused` the pause switch stays set and it resumes nothing.
- **running** — the window is over. The script's last line is `DEPLOYED and
  verified by …`, exit 0.
- **failed** — the window failed closed: the drain never completed, the
  worldserver never answered ready, a smoke failed, or the fleet would not
  scale back. The fleet is scaled back regardless — its own preflight gate
  blocks spawning until a build passes — and the detail says which case it
  was. Exit 1.

Whatever happens after the fleet is scaled to 0, the script's EXIT trap scales
it back: a deploy never leaves the fleet stopped, on any path, including an
unexpected error. An ERR trap makes any failed step a failed window, never a
warning.

The script does not change the image tag and does not roll back. Flux owns the
tag, so a rollback is reverting `image.tag` in the cluster repo to the previous
immutable tag and letting Flux reconcile; the script says so when it fails.
It holds no deploy lock either: an `flock` taken inside a `kubectl exec` dies
with the exec. The supervisor writes `running` over a window phase it finds on
file (the leftovers of a window that died) and over any phase when it boots,
which is the acknowledgement of a `failed` notice. Keep the window to one
operator.

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
   nothing has spawned on that build. Revert the pin and let Flux roll the
   worldserver back; the gate re-runs on the new server identity and unblocks
   the fleet once the old build passes. If the old build fails too, the
   failure is not in the build (auth, the database, the smoke accounts, the
   runner image). Run a smoke by hand and read its output:
   `bun wb smoke preflight` logs in as PROBE. The gate's own account needs
   the variable set in the pod, which is the kubectl form,
   `kubectl -n wrathbench exec deploy/wrathbench-runner -- env MODULE_ACCOUNT=SMOKE bun infra/smoke/preflight.ts`.
4. **The fleet did not scale back up.** The one case with a command for you:
   `kubectl -n wrathbench scale deploy/wrathbench-fleet --replicas=1`.

`--no-smoke` is the honest escape hatch for a cluster where the preflight
accounts do not exist yet: it drains, waits for health, verifies nothing, says
`DEPLOYED UNVERIFIED`, and hands the server to the fleet — whose own gate is
then the only check. An enabled preflight with no `smokes` configured is not
that: it fails and exits 1, because nobody asked for an unverified deploy.

`--dry-run` prints the plan and every resolved value and executes nothing. It
is read-only and safe while the fleet is up.

Verification is **fail-closed**: the closing line names what verified the
deploy (`DEPLOYED and verified by N direct smoke(s) + M full-arc smoke(s)`),
and it can only be reached by a step that actually ran and exited zero. Each
smoke logs its start, its duration and its exit code.

`infra/k8s-deploy.test.ts` covers the drain without a cluster: it runs the
real script with `kubectl` replaced by a PATH shim and asserts that no smoke
runs while a fleet or run pod is listed, that the fleet comes back on every
exit path, and what `--keep-paused` leaves set.

### The preflight gate

The supervisor smokes the server before it launches anything. The knob is the
top-level `preflight` block of the config, hot-reloaded like the jobs;
`infra/fleet.example.json` shows its shape. There are two kinds of smoke:

- **`smokes` is the gate.** It runs before the first job is spawned and again
  whenever the server identity changes — which is to say on every worldserver
  recreate *and* on every restart the container does by itself. Every job
  waits on it, so it proves only that the stack is alive end to end, and the
  default, `infra/smoke/preflight.ts`, does that in well under a second:
  health and the port secret, the event stream, a login, the login state on
  the stream, one action's reply, a logout. Its character is persistent:
  created the first time and never deleted, because the core keeps a
  logged-out character in world for 60s and silently ignores a delete in that
  window, while a login inside it just reattaches. Entries with
  **distinct accounts run in parallel**; entries sharing an account run in
  order. A bare string entry means "on `account`".
- **`deploySmokes` is what a release proves on top.** The deploy window
  (`infra/k8s-deploy.sh`) runs the gate smokes
  and then these, one after another, with the fleet down and before anything
  resumes; the supervisor never runs them. The game surface lives here:
  `kill-credit.ts` (combat, kill credit, loot), `quest-accept-status.ts`
  (quest status, accept, turn-in, vendor) and `module-quest.ts` (eight kills to
  the kill quest's own turn-in, about five minutes). `deployTimeoutMs` is their
  whole budget. Emptying the list takes them out of releases, not out of the
  gate.

The supervisor runs the gate before it reads the run history (counting every
trajectory on disk takes about half a minute on a full runs directory), so with
the server up the gate passes within seconds of a start. While `/health` is not
ready it asks again every 5s, not once a tick.

A failure spawns nothing, complains once, and is re-checked every tick, so a fix
or a rollback unblocks the fleet with no operator action. Drains still work
while the gate is shut. `timeoutMs` is the budget for the whole gate — every
child gets the same deadline — sized for the slowest legitimate login (the
module bounds a create that reclaims a stale session at 20s), not for the
smoke's usual run. `bun wb fleet status` shows the last gate result,
per script; `bun wb fleet dry-run` shows the plan.

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
realm row is written. wb refuses it while the deployed image's `bootstrap.ts`
predates the flag, because that file would run the whole bootstrap. On the
quickstart without Bun, compose's `bootstrap` service makes one account by
running the whole bootstrap with it as the configured account: it re-upserts
the realm row from compose's own realm settings and resets that account's
password if it differs: `docker compose -f infra/compose.yml run --rm --no-deps -e
WRATHBENCH_ACCOUNT_USER=SMOKE2 -e WRATHBENCH_ACCOUNT_PASSWORD=SMOKE2 bootstrap`.

Server identity is the worldserver's boot, read off the shared logs volume
(`data/logs/Server.log`'s creation time), plus a digest of `/health`'s stable
fields. Nothing keys on that string being unique — the deploy script keys on the
gate result's timestamp — so at worst a marker that fails to change costs an
extra smoke run.

The gate accounts must be their own: sharing one with an enabled job is refused
as a config error (every per-entry account is checked), and none is ever
`PROBE`, the ad-hoc debugging account. Benchmark characters are never
fixtured: the smoke-fixture tool that pre-places gate characters
(`infra/fixtures`) writes only to smoke and probe accounts, outside the
observation contract rather than an exception to it — the operator arranging
the world before a run, like choosing an account.

### Changing the config shape

The pattern: export the store (`config-store.ts export /tmp/fleet-before.json`),
write the new-shape document beside it, drain or `stop fleet` (running
episodes pause and resume on start), `seed --force` the new document, check
`--dry-run` from the new code before anything spawns, then
`up -d --no-deps fleet`. The new shape under the old code is the one thing that
must not happen, which is why the seed comes after the stop — and the store's
own validator is the running code's, so a `seed --force` from the new tree
before the fleet restarts would be refused. A shape the current code does not
read is refused by name — there is no compatibility read, so roll back with
`seed --force` of the export you took. Run ids carry the job name, so a renamed
job starts a fresh id; nothing resumes across the rename.

### The scheduling policy

With the job shape the `queue` normally holds only the pinned jobs: the
supervisor fills free pool accounts from the roster by policy — each model's
tier budget (`t0`/`t1`/`t2`, see the config reference), `e90` for everyone,
`e360` once earned, newest-to-the-roster first, shorter episode first, fewest
runs first, one character per model, within `policy.maxConcurrent` per
rate-limit key. Only runs from the running checkout's harness **series**
(`0.3` of `harness-0.3-114-g…`) count; a minor bump starts every model's
evidence over, a fix commit does not. With `policy.paid` set, at most that
many paid runs are in flight at once — a throttle, never a budget. A model
whose entry says `idle: "unlimited"` takes one continuous freeplay session at
a time once its targets are met — no episode wall clock, governed by the idle
watchdog — stamped `extra: true`: an attempt but never counted.

Everything it decides is derived from `data/runs/` each tick; nothing is
stored except an operator's clear.

```
bun wb fleet status                       # models table: status, counted/target per episode, why (not) schedulable
bun wb fleet dry-run                      # the picks the policy would make for the free accounts right now
bun wb fleet clear-model <roster-name>    # forgive a retired/cooling model; picked up on the next tick
```

Both read what is running as the supervisor does: a job whose process is
alive, never a row `fleet-state.json` keeps for a roster that has exited, so an
exited job's account reads free and its model gives its real reason (tainted,
cooling) rather than "running". `--dry-run` plans the next tick around that:
a job in flight keeps its account and its model, and its row says what a
restart does to its run; a paused run the supervisor would bring back reads
`resumes <run id> in place`. A live fleet run no job owns (a killed runner's
heartbeat stays warm for two minutes after a pod recreate) keeps its account
and its model, as on the live tick, so nothing launches a second session for
that model; it counts against no driver or paid cap. Once it reads cold it
lets go: on a resuming lane it is then an `offline` pause and resumes in place,
and a scored run waits for the stale sweep. With the pause switch set the dry-run leads with the switch, and the plan
is what launches once it is cleared.

What the status words mean: `new` has no counted run yet; `active` is working
toward its `e90` target; `promoted` may also be scheduled on `e360`; `cooling`
is on the defer ladder (`1m … 6h`) after consecutive zero-response or
`adapter-error` attempts; `retired` failed once more at the 6h ceiling and will
not be scheduled until cleared; `pinned` is outside the policy (a pinned ref or
a probe). A launch that produced no model response never counts toward a target
but does climb the ladder, so a dead provider costs at most ten launches over
~10 hours before it is retired. A manual pool job (`queue` entry without an account) always
outranks the policy for a POOL account; add one to force a specific run (an
`e360` for a model that has not climbed needs `tier: "t2"` on its roster entry
as well). Its `repeat` tops the model's counted runs on that episode up to
`n`, the policy's runs included ("Steer it", above). How many runs a model gets
is its `tier` and nothing else.

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
pod's store (`config-store.ts publish -`; under `bun wb --local` it writes the
local store). Publishing the same definition again is a no-op; publishing a
different one under a published `id@version` is refused. Which commits may
publish is `PUBLISH_RULE` in `campaign-publish.ts`: any origin branch today,
`origin-master` to tighten it.

**Assigning models to a campaign.**

1. Name the roster entries in `assignments`, in priority order. Each owes
   `runsPerCell` counted runs per square, and a square is one (cell, arm).
2. Enable the row.
3. To queue more data later, raise an assignment's `runsPerCell` or append
   another assignment. To move to a new version, point `version` at it; work
   is counted per version, so the new one starts from nothing.

The CLI validates every write against the whole config, as the `/config` page
does:

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
pod ("Run pods", below): with `policy.runPods` off, or off the cluster, every
(assignment, arm) pair of it is refused before any launch and listed as
`<id>@<v>:<ref>:<arm>`, never run on the release image, and it schedules again
once the switch is on. An arm image must be a build that has
`--campaign-file` and refuses unknown flags — anything older ignores the
campaign file it is given. An arm's `args` come after the supervisor's own
and may not restate a shape flag or a supervisor flag; `--compact-window` is
the exception. Assign an arm that sets the window only roster entries on the
claude-code driver that set none themselves: any other pair is refused before
it launches, and listed as `<id>@<v>:<ref>:<arm>`. So is every pair of an
assignment whose roster entry the fleet refuses (an unknown key, a provider
key towards a host the provider table does not pair it with, a subscription
the policy does not list): the campaign sweeps its other assignments, and the
entry's own refusal, with its reason, is under `--status`'s refused pins. The
campaigns page asks the same function (`rosterEntryRefusal`), so those squares
show as refused there too. The page says only that the entry is refused,
because the reason can name a key, a lane or a host.

Before you enable race-probe@1, run the start gate once, and enable it only
when it passes. It creates, walks and takes a quest at each start no run had
used before: Valley of Trials, Deathknell, Camp Narache, Sunstrider Isle and
Ammen Vale. It runs on `PROBE`, never a pool account.

```
bun wb smoke race-probe-starts
```

**A hand launch** names the square and nothing that sets its shape.
`run-episode.sh` writes the run's `campaign.json` from the published
definition (in the runner pod, where `bun wb run episode` sends it) and launches `run.ts` with
`--campaign-file`; the runner refuses `--episode probing` without one, and
with one it refuses `--objective`, `--race`/`--class`,
`--wiki-coords`/`--wiki`, `--max-tool-calls` and the watchdog flags. `--arm`
may be left out when the definition has one arm; an arm that pins an image or
a command cannot be hand-launched.

```
bun wb run episode --model <id> --campaign class-probe@2 --cell dwarf-paladin
```

### Run pods

A probe-campaign arm may name its own container image — a branch build, or a
harness that is not this repository — and an image cannot be a child process
of the fleet pod. So on the cluster a probing episode can run as **its own
pod**, created by the roster from the chart's template and watched until it
ends (`infra/run-pod.ts`; the contract both sides honour is
`docs/ARCHITECTURE.md`, "Launching a run: the run contract"). Scored lanes
stay child processes until a campaign has proven the launcher.

**The switch.** `policy.runPods` in the config store, `"off"` by default:

```
bun wb config patch policy '{"runPods":"probes"}' --actor <you> --note "run pods on for probes"
bun wb config patch policy '{"runPods":"off"}'    --actor <you> --note "run pods off"
```

It reaches a job at its next roster spawn (the supervisor hands it to
`run-roster` as `--run-pods`), so a roster already mid-episode keeps the mode it
started under. With it on, every probing episode — image-less arms too, so
arms compare on one execution path — is a pod; an arm with an image or a
command is a refused pair when the switch is off or the supervisor is not on
the cluster — parked and shown on the campaigns page, never launched on
master's code instead.

**What the chart provides** (`templates/run-pods.yaml`): the fleet's
ServiceAccount and a Role over pods in the release namespace only; the pod
template, rendered from the same helpers as the fleet pod and mounted into it;
and the launcher's settings. Two values matter at deploy time:

- `runPods.allowedImages` — the image *repositories* an arm may name, matched
  on the part before the tag or digest, exactly or as a path prefix. Empty
  means the release runner alone (`<image.registry>/wrathbench-runner`). Add
  the repository PR builds are pushed to (`ghcr.io/shard/wrathbench-runner`).
  An image outside the list, untagged, or `:latest` is refused before a pod
  exists.
- `runPods.imagePullSecrets` — pull Secret names for run pods only, merged
  once each with the chart-wide `imagePullSecrets` every WrathBench pod carries
  ("Secrets", below); for a repository in `allowedImages` the chart-wide Secret
  cannot pull. The cluster repo creates the Secret and the chart names it.

A run pod gets the module secret and the one credential its driver bills (its
lane's `CLAUDE_CODE_OAUTH_TOKEN*`, its `apiKeyEnv`, or the mounted codex home),
`WRATHBENCH_LOCAL_MODEL_HOSTS` from the chart's `localModelHosts` (run.ts
checks an openai entry's key and base against the provider table again, and a
pod without the hosts would refuse every self-hosted entry the fleet accepted),
the runs and wiki volumes, and no config store, no database variables and no
`ANTHROPIC_*` variable — `infra/run-pod.test.ts` asserts the last on the
rendered template and on the env builder. Its harness stamp is the arm's image
tag, never master's; a digest-only pin stamps
`<repository basename>@sha256:<12 hex>`. The launcher writes
`runs/<id>/image.json` (`ref`, `digest`, `pod`, `node`, `startedAt`) when the
container starts, and a resume in a pod relaunches that digest whatever the arm
says now. That holds only while `runPods` is `probes`: switched off, a paused
probe on an image-less arm resumes as a child process on the release, one on
a pinned arm waits, listed, until the switch is back on, and the supervisor
exempts a probe from the harness-series gate only when it has an `image.json`
and the switch is on.

**Lifecycle.** Each pod carries an ownerReference to the fleet pod, so a fleet
stop or crash deletes its run pods with the pod's 90s grace — the same
SIGTERM → `operator-pause` an episode gets from its roster. A roster's SIGTERM
deletes its pod with that grace and waits for it to be gone; the supervisor's
drain counts a roster's run pod as an episode in flight (beside its /proc
scan), asking the API only of a roster it spawned with `--run-pods`, where a
403 or 404 is no pod and a timeout or 5xx is a pod still there;
`infra/k8s-deploy.sh` waits for zero run pods after the fleet pod is
gone and before the worldserver is touched, and fails the window closed naming
the run if one outlives the budget — or if the pods cannot be listed for that
long, because a failed read is not an empty one; `bun wb fleet state`
lists them.
A pod that will not pull (`ImagePullBackOff`), cannot be scheduled for five
minutes, stays Pending for fifteen, or is evicted ends the attempt as
`launch-failed` with the kubelet's reason in the roster's log, never as a hang.
So does an image the allow-list refuses, a pod the API will not create, and a
run.ts that refuses its flags. Each leaves a stub run terminated `launch-failed`
with that reason, which counts toward the definition's `maxAttemptsPerCell`:
a square that cannot launch settles as capped instead of being picked again
every tick.
The pod's log is followed into the job log as a child's stderr was, and the
finished pod is deleted.

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

**A branch runner image.** PR heads and master commits are built by a GitHub
Actions workflow and pushed to GHCR as
`ghcr.io/shard/wrathbench-runner:harness-0.5-<n>-g<sha>[-pr<N>]`; a definition
usually pins the digest. By hand, from a clean checkout of the branch, or
naming the branch's head from any clean checkout:

```
./infra/build-images.sh --only runner --push --registry ghcr.io/shard
./infra/build-images.sh --only runner --push --registry ghcr.io/shard \
  --commit <sha> --tag "$(git describe --tags --always <sha>)"
```

Like a release ("Deploy window", above), the image is built from a `git
archive` of that commit, never from the working tree, so an uncommitted edit is
never in it, and `infra/image-guard.sh` checks it before the push. The tag is
`git describe` of the commit, so it still names series 0.5 and a run stamped
with it groups with the series; `--allow-dirty` tags are refused for push, and
`latest` is refused everywhere.

**First proof.** One short probe on `PROBE`: publish a one-arm definition,
assign a model, set `runPods` to `probes`, and watch `fleet-update.sh status`
and the job log for `run pod … created`, `… running on <node>: <image> is
sha256:…`, and the roster's verdict. Expect the first pull of a new image to
take minutes; the account is held through it by `image.json` and the heartbeat.

### Ad-hoc launches still work

One episode, launched in the runner pod (`bun wb --local run episode`: in the
quickstart's runner container):

```
bun wb run episode --model <id> [--driver openai|claude-code|codex]
```

One roster, or a whole supervisor, by hand:

```
./infra/run-roster.sh <roster.json> --until 07:30
./infra/run-fleet.sh --until 18:00
```

Both read the config store and `data/runs/` of the machine they run on, so
on a cluster deployment they have nothing to read on a workstation. Do not
run a second supervisor against the same config store while the fleet is up:
they would both spawn jobs on the same accounts.

### Archiving runs

A run that terminates without a single model response — the provider was dead
on the first request, the key was refused, the adapter threw before a turn
existed — is **archived by the runner itself as it exits**, into
`data/runs/archive/<run-id>/`. It is a launch that did not happen, so no
listing shows one: there is no filter, no toggle and nothing to sweep up. A
*pause* is not a termination: a paused run with no response yet is resumed, not
archived. Nothing is deleted, and the viewer never reads inside `archive/` —
but `run-fleet --status` and the scheduler do, because the defer ladder is made
of launches that did not happen and because attempt numbers must stay unique on
disk.

The CLI parks runs for the other two reasons — the comparability floor, and
the operator's own judgement about what a listing should show:

```
bun runner/src/archive.ts --pre-series 0.4 --dry-run            # everything below the harness-0.4 floor
bun runner/src/archive.ts --pre-series 0.4 --release-paused     # ...including parked runs nobody holds
bun runner/src/archive.ts --run-ids a,b,c --dry-run             # exactly these runs
bun runner/src/archive.ts --run-ids @ids.txt --release-paused   # ...one id per line, # comments skipped
```

`--pre-series` parks every run whose recorded harness version is not a clean
build of the series — an older series, a `-dirty` build, or no `harness-` tag
at all. A run the fleet may still be holding is refused with the reason rather
than moved: its own files written inside the last ten minutes, a `run.ts`
process naming it, or a fleet job jsonl naming it inside the same window. Run
the dry-run first; a live run is the one thing this must not touch.
`--release-paused` lets a run through the activity hold when its meta records a
pause and no `run.ts` process names it: a supervisor retrying a paused run
rewrites its files every few minutes, which would hold it forever.

`--run-ids` parks exactly the runs you name, with the same three held guards in
the same order, the same `--release-paused` and the same `--dry-run` — naming a
run is not a licence to move a directory out from under a live writer. An id
that names no movable run (a typo, a run already parked, a directory that is
not a run) is **reported on its own line and counted separately**; it is never
thrown and never silently skipped, so nineteen ids that produce eighteen moves
say so. Dry-run first and check the count: `archiveRun` is a rename with no
guard of its own, and the plan is the only filter in front of it.

### Subscription lanes

A Claude subscription is a **lane**, not a model dimension. The roster keeps one
entry per model however many accounts are behind it, because which subscription
paid for a run says nothing about what the run measured; what the lane decides
is how many sessions may be live at once.

`policy.subscriptions` lists the lanes, as the **names** of the env vars holding
their OAuth tokens (`["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN_2"]`).
The tokens themselves stay in `.env`; a token where a name belongs is refused
everywhere it can be written. Absent means the single default lane, which is
what a config that never named a lane means.

A key the file does not name is uncapped. A claude-code run counts against
**two** concurrency keys and needs a free slot in both:

- `claude-code` — every Claude session in flight, whoever pays. The overall
  ceiling, and the same key an older file already had.
- `claude-code:<ENV NAME>` — that one subscription's sessions. Every lane has
  one, the default lane included.

The scheduler assigns the lane: a claude pick takes the first subscription with
room, and the run **records** the lane it billed. That record is what the count
is re-derived from every tick, so it survives a supervisor restart, and a
resumed run goes back to the subscription it started on. Pinned jobs, campaign
cells and manual queue jobs are assigned the same way.

Two ways to override, both normally absent:

- `queue[].subscription: "<ENV NAME>"` pins one job to one subscription.
- `roster.<name>.subscription: "<ENV NAME>"` pins a model: its runs always bill
  that account, and its pick is **held** when that lane is busy rather than
  moved to the other one — pinning costs the entry the other subscription's
  free slots. A name that is not in `policy.subscriptions` refuses **that
  entry** (named in `--status`, scheduled by nothing) and leaves the rest of
  the file in effect.

Changing `policy.subscriptions` or the lane plumbing needs a fleet **recreate**,
not just the 60s config re-read: the token-to-lane path is code.

**The Codex lane** is the same idea with a directory for a
credential: `CODEX_HOME` names a logged-in Codex home (`codex login`; the
login is its `auth.json`), a second subscription is `CODEX_HOME_2` pointing at
a second directory, and a directory is never copied per run — its refresh
token is spent by whichever process refreshes first. A codex run counts
against the `codex` concurrency key (`"codex": 1` is one live session, the
rule the Claude lanes follow); per-lane `codex:<ENV NAME>` keys and a place in
`policy.subscriptions` are not built yet, so a codex
entry rides the default lane unless its `subscription` pins another
directory's variable by hand.

The CLI never deletes a thread's rollout (`sessions/**/rollout-*.jsonl`), so
the fleet deletes them, never archiving one (the trajectory holds all the
driver read off it): the driver at a thread change and at its episode's end,
and an hourly supervisor sweep for any rollout unwritten for two hours that is
no live run's recorded thread (`<run-dir>/codex-thread.json`). Nothing else in
the home is touched, so `thread_history_1.sqlite` still grows.

### The subscription usage gate

A subscription bills a flat plan whose allowance is metered in rolling
windows, and a window the fleet drains stays empty until it resets. So the
fleet reads each lane's usage and stops short of the top by default
(operator decision, 2026-10-16). The lanes are the concurrency key's:
`claude-code:<TOKEN ENV>` per Claude OAuth token, `codex:<HOME ENV>` per Codex
home, and `opencode-go:<KEY ENV>` per OpenCode Go key for the entries that
draw the Go allowance down (a Go base, paid billing; a `$0` Go model keeps
working past the limit and is never gated).

Two knobs, both env vars read by the supervisor, the roster and the runner,
each a percent in (0, 100], default 80:

- `WRATHBENCH_SUB_SCORED_MAX_PCT` — a scored run (`e90`, `e360`) does not
  start on a lane while any of its windows is at or over it. A scored run
  already live is never paused by the gate (that would spend its attempt):
  its episode finishes, and a running job's next episode waits — the
  supervisor drains the job to its boundary, and the roster re-checks before
  every launch.
- `WRATHBENCH_SUB_FREEPLAY_MAX_PCT` — a freeplay run does not start or resume
  on a lane at or over it, and a live one pauses at its next turn boundary as
  `subscription-budget`, resumable, waiting for the window's reset. That
  pause is the harness's doing: no strike, no rung on the defer ladder, no
  streak.

`100` turns a gate off. What stays on regardless is the quota-reset rule: a
lane whose quota is spent — a window at 100%, or a `quota-exhausted` pause,
which marks the window it spent — holds every launch on it, scored, freeplay
or probe, until the window resets, capped at seven days, so no failed attempt
is spent against a quota known to be empty. A scored run that pauses on a
spent quota is still a failed attempt (docs/METHODOLOGY.md); its retry just
waits for the reset. A probe is held only by that rule. An invalid value
falls back to 80 and says so in the supervisor log and in `--status`, which
reports the supervisor's own thresholds from its state file.

Where the readings come from: the codex driver reads the thread's rollout
after each turn (`rate_limits` on every `token_count`), the claude-code driver
the CLI's `rate_limit_event` frames, and each records the newest reading on
change in the run's meta.json and as a `harness` record of kind `rate_limits`
— the used percent, the window's length and its reset, nothing else. For Go,
the supervisor reads Go's usage endpoint with the entry's key, at most once a
minute per key, before a tick decides anything, and leaves the reading in
`data/runs/fleet-subscription-usage.json` for the roster and `--status`; a
live Go freeplay run refreshes its own copy at turn boundaries without
waiting on it. A window counts until its reset, and no reading counts for
longer than seven days past being taken; a lane with no reading, or one whose
reading cannot be had, is open. A Claude per-model weekly cap (a refusal
naming `seven_day_opus`, say) is a window of its own that holds only that
family's launches; the lane's other models go on. A quota pause whose CLI
names its reset ("Try again at …", `usage limit reached|<epoch>`) waits for
that instant over the reading's guess, and a run's first turn starts from the
lane's newest reading another run left.

`--status` prints the gate per lane: the newest windows with their percent
and reset, the reading's age, whether a scored and a freeplay launch are held,
and the supervisor's thresholds (from its state file, so a status shell with
other env values still reports what the fleet runs with). `--dry-run` shows a
held launch as a `HELD` pick, a `SKIP`, or a paused run not resumed, each with
the gate's reason. None of the figures reach a public page: the public fleet
listing withholds a subscription wait's reset and sentence, and the usage
records are on no public allowlist.

Setting them on the cluster: the chart has no values key for them, and the
defaults need none. The natural place is the `wrathbench.runEnv` block in
`infra/chart/wrathbench/templates/_helpers.tpl` (beside
`WRATHBENCH_LOCAL_MODEL_HOSTS`), which the fleet, the runner pod (where
`--status` runs) and the run pods already include; a value changes those pod
templates, so it rolls them.

### Secrets

`.env` at the repo root, never argv. Bun loads `/wrathbench/.env` inside the
container — in the supervisor and again in every child — so keys reach the
runner without appearing in `ps` or in the compose file. A claude-code
job needs the token of the lane it was scheduled on there (`claude setup-token`)
— `CLAUDE_CODE_OAUTH_TOKEN`, or `CLAUDE_CODE_OAUTH_TOKEN_2` for the second
subscription; without it the roster refuses the episode with a `launch-failed`
row naming that variable, rather than burning a session.

Database clients follow the same rule. `mysql`, `mysqladmin` and `mysqldump`
take the password as `MYSQL_PWD` and `clickhouse-client` as
`CLICKHOUSE_PASSWORD`, never as `-p`/`--password`, which any process in the
pod could read from the client's command line. That covers the db readiness
probe, the hook Jobs' wait for the database, the compose healthchecks and
`infra/export-world-ids.sh`. The probe sets `MYSQL_PWD` for its one command
and not on the MySQL container, whose first-boot init connects with no
password and would fail if it inherited one.

Where a secret may travel from the runner is fixed in code, not config. A
provider key goes only to its own provider's host (`KEY_PROVIDERS` in
`runner/src/providers.ts`; the self-hosted key only to the deployment's
`WRATHBENCH_LOCAL_MODEL_HOSTS`). No child inherits the runner's environment:
the snippet child gets a named list (`sandboxChildEnv`), and each CLI driver an
allowlist of its own (`childEnv` in `adapter-claude.ts` and
`adapter-codex.ts`) — the plumbing a process needs to run plus the one lane
credential it bills. The per-run session secret the child authenticates with
is registered for redaction the moment it is leased, so a snippet that prints
its environment writes `[redacted]` into the trajectory, and the sandbox host
scrubs the same value from the child's stdout and stderr before they reach the
job log or the pod log. The model reads `[redacted]` too, because every tool
result and context message is scrubbed before it is sent. So the CLI drivers'
own session files (the claude-code transcript under the run's
`claude-config/`, the Codex rollout under the lane's `CODEX_HOME`), which
keep what the CLI was sent, carry `[redacted]` where a snippet printed it
(runner/README.md, "The sandbox", says what no scrub catches).

A run pod's environment is in "Run pods", above: the launcher keeps only the
module secret and its driver's one credential.

**The images are private.** WrathBench's images live in a private Harbor
project (`harbor.nusphere.shard.page/wrathbench`, operator decision
2026-10-11), so every pod built from them — fleet, runner, viewer, publisher,
collector, worldserver, authserver, the bootstrap and db-import Jobs, and every
run pod — pulls with a Secret the cluster owns (`wrathbench-harbor-pull`, a
`kubernetes.io/dockerconfigjson`), named in the chart's `imagePullSecrets`
value from the HelmRelease. The chart never holds the credential. The MySQL and
ClickHouse pods pull upstream public images and carry none. Run pods add
`runPods.imagePullSecrets` for a repository the Harbor Secret cannot pull.
`runPods.allowedImages` defaults to `<image.registry>/wrathbench-runner`, so
the move of the registry project moves the allow-list with it.

`WRATHBENCH_MODULE_SECRET` — the module's **port secret** (module/PROTOCOL.md,
"Authentication"). Every request to the worldserver's control
port, `GET /health` included, must carry it (or a session secret leased with
it) as `Authorization: Bearer`, and a module started without one — or with one
shorter than 32 characters — refuses to listen at all and says so at ERROR in
`Server.log`. Generate it once with `openssl rand -hex 32` and put it in
`.env`; it is the only place it lives. Who reads it from there:

- the **runner and fleet** services, through Bun's `.env` autoload: the run
  host presents it for hygiene, `/health` and `POST /lease`, then hands the
  snippet child only the per-run session secret the lease returned. The
  child's environment never carries the port secret (`sandboxChildEnv`
  forwards a named list without it) — a snippet that could read it could list
  and delete on any account;
- the **smokes** (`infra/smoke/lib/auth.ts`), exec'd in the runner container,
  and the deploy script's `/health` probes, which run there too;
- the **worldserver**, as `AC_WRATH_BENCH_SECRET`. On the cluster the chart
  takes it from the `WRATHBENCH_MODULE_SECRET` key of the env Secret
  (`envSecretName`), which the cluster repo generates from `.env`. On the
  quickstart stack compose interpolates it, and with `infra/` as its project
  directory it reads the repo-root `.env` only when told to: `--env-file .env`
  on every `up` (`infra/README.md`). An `up` without it ships an empty secret
  and the module refuses to listen — the loud failure, by design. An
  operator's loopback probe inside the container needs the header too, and
  the image has neither curl nor wget: on the cluster `bun wb server health`
  (`infra/module-health.sh`) does it with perl and prints the full census
  (`sessions`, drops by opcode).
  A probe from anywhere else — the runner container included — gets liveness
  with the counters zeroed.

Rotating it is a deploy window: the worldserver and everything that presents
the secret must change together, and a process reads it once, at start. On the
cluster that is the env Secret, then the worldserver and every pod carrying
the key restart onto it with the fleet drained. On the quickstart stack it is
`.env`, then `down` and `up` again with `--env-file .env`.

### Network policy

The chart can put NetworkPolicies on the pods that run model-driven code: the
fleet pod and the run pods. Each gets an egress allow-list and no ingress. The
viewer, publisher and collector get egress allow-lists too. The switch is
`networkPolicy.enabled`, and it is off by default. `templates/networkpolicy.yaml`
says what each policy admits and why. In short, the fleet and run pods may
reach:

- the module on 8086;
- cluster DNS;
- TCP 443 anywhere outside the private, CGNAT and link-local ranges, for the
  model APIs and the CLIs' own endpoints;
- the self-hosted model servers in `localModelHosts`, each of which must then
  be written as IPv4:port.

Only the fleet may reach the Kubernetes API, for the run-pod launcher. It may
also reach MySQL, because the preflight gate's fixture staging runs in that
pod. Neither may reach ClickHouse, the viewer or any other address on the LAN.

**Turning it on is a release step of its own.** Ship the chart first, with the
switch off, which changes nothing. Then set the values in a separate GitOps
commit. Under Flux, a chart change and the values that depend on it can land
in either order. The values:

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
#  ...the values commit lands; `kubectl -n wrathbench get networkpolicy` lists five
kubectl -n wrathbench scale deploy/wrathbench-fleet --replicas=1   # if the upgrade has not; it comes up paused
kubectl -n wrathbench exec deploy/wrathbench-fleet -- bun -e '
for (const u of ["http://worldserver:8086/health", "https://openrouter.ai/api/v1/models",
  "http://<localModelHost>/v1/models", "https://kubernetes.default.svc/version",
  "http://wrathbench-clickhouse:8123/ping", "http://wrathbench-viewer:8090/api/info"])
  await fetch(u, { signal: AbortSignal.timeout(5000), tls: { rejectUnauthorized: false } })
    .then((r) => console.log(r.status, u), (e) => console.log(e.name, u));'
bun wb fleet resume
```

Every line but the last two should print an HTTP status. Any status means the
connection was made, the API's included, whatever it answers a request with no
token. ClickHouse and the viewer should print `TimeoutError`. After the
resume, watch three things:

- the next preflight gate pass (its fixture smoke uses MySQL);
- each driver's first episode, through its first model call and first module
  call;
- the first run pod.

To roll back, set the switch off again. The policies are deleted and nothing
else changes.

### Harness version stamping

Every episode is stamped with `git describe --tags --always --dirty`, computed
at launch. On the host `run-episode.sh` does it; in the container `run-roster`
does it, using the `git` in the runner image against the bind-mounted `.git`.
A dirty tree stamps `-dirty` either way — that is the point, and it is why the
stamp is not a file written once at `up` time. On the cluster the stamp is the
image tag the chart passes (`WRATHBENCH_HARNESS_VERSION`), and an episode
running as its own pod on an arm's image is stamped with *that* image's tag,
never the fleet's ("Run pods", above).

## Public dashboard

The public site is **push-based**: a publisher on the lab renders the viewer's
own API to JSON on a timer and PUTs it to an R2 bucket, and the SPA is built a
second time to read that bucket instead of `/api`. No public request ever
reaches the lab, so a traffic spike is Cloudflare's problem rather than the
worldserver's, and the control surface stays exactly as unexposed as it is
today. `docs/PUBLIC-DASHBOARD.md` is the design and the rejected alternatives;
`infra/cloudflare/README.md` is how to stand it up and verify it, step by step
and in order; this section is operating it once it exists.

The site is openly public, and what it may carry — entry summaries and
verbatim game text (GitHub issue #10) — is `docs/PUBLIC-DASHBOARD.md`'s. What
follows is the mechanism.

The corollary, stated plainly (GitHub issue #30): **the live viewer is private
and operator-only, and is unsupported as an Internet-facing service.** It stays
on loopback, or on a LAN the operator has explicitly opted in with
`WRATHBENCH_VIEWER_LAN=1`. Public delivery is the static snapshot path in this
section and nothing else — never a port on the viewer, the module or the MCP
bridge, and never a tunnel to one. `WRATHBENCH_VIEWER_PUBLIC=1` projects every
body it serves and withholds raw lines, tiles and the SSE tail, but it exists so
the snapshot renderer can call the handle in-process; it is not an exposure
plan.

The publisher's R2 key pair (`S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`) lives
in the `wrathbench-env` cluster secret, and in `.env` for a hand-run pass or the
tile upload; the deploy token (`WRATHBENCH_CF_DEPLOY_TOKEN`) lives in `.env`
alone. Neither can do the other's job.

### First publish, by hand

`mkdir -p data/publish` first — it is the publisher's only writable path and
Docker would otherwise create it as root. Then one pass:

```
docker compose -f infra/compose.yml run --rm --no-deps publisher \
  bun infra/publish-dashboard.ts --once
```

Its environment is the compose service's, and the two must stay in agreement:

| variable | value | why |
| --- | --- | --- |
| `WRATHBENCH_RUNS_DIR` | `data/runs` | the evidence record, read-only |
| `WRATHBENCH_CONFIG_DB` | `data/config.sqlite` (the default; unset under compose) | the config store's roster names the models the pages label |
| `WRATHBENCH_PUBLISH_STATE` | `data/publish/state.json` | what was uploaded last, so a pass PUTs only what changed. Deleting it is the repair for a bad immutable object, and since the trace it also re-uploads every published trace segment in one pass: 288 a day for each character a trace recorded, which for a long freeplay fleet is tens of thousands of PUTs at once |
| `WRATHBENCH_PUBLISH_INTERVAL_MS` | `60000` in the script; the chart and compose set `300000` | `--loop` cadence. Five minutes is a cost choice, not a freshness one — a pass writes ~24 objects regardless of cadence, so 60s measured ~1.2M R2 class-A ops/month against a 1M free tier and 300s is ~240k. The harness's own floor is 30–60s, so a faster push would buy little anyway |
| `WRATHBENCH_PUBLISH_BATCH` | `8` | runs projected before the pass uploads them, drops the bodies and releases those runs' entry indexes from the viewer handle. The pass's memory dial: measured peak RSS over the 1,016-run tree is 1.08 GB at 25, 0.78 GB at 8 and 0.59 GB at 1, all inside 60–67s, against 4.4 GB without the batching. Eight matches the per-run read pool's width — smaller leaves readers idle, larger only holds more at once |
| `WRATHBENCH_PUBLISH_FULL_RENDER_MS` | `21600000` (6 h) | the longest a cold run goes without being rendered in full. A pass skips a finished run whose inputs have not moved (docs/PUBLIC-DASHBOARD.md, "The publisher"), and this bounds how stale anything the skip cannot see leaves its objects. `0` renders every run every pass |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | the publisher's R2 key pair | `.env`, never argv |
| `S3_BUCKET` | `wrathbench-public` | |
| `S3_ENDPOINT` | `https://<account-id>.r2.cloudflarestorage.com` | the account's R2 S3 endpoint — the S3 API, not a public hostname |

The four `S3_*` names are `Bun.S3Client`'s own, which is why they are not
spelled `WRATHBENCH_*` and why they come from `.env` rather than from
`compose.yml`.

Then read the bucket back before trusting the loop with it —
`bun wb site verify` (`infra/publish-accept.ts`) walks the whole generation, and
`--base https://wrathbench-data.shard.page` walks it again through the public
hostname, which is the form that also exercises the custom domain and the cache
rules.

### Minimap tiles (a separate step, never automatic)

The snapshot loop uploads JSON only. Tiles go up by hand, from a checkout with
`data/minimap` populated by the extraction in `minimap/` and its bakes of the
zoomed-out levels and the art layer (`minimap/README.md`), and only when the
extraction has changed — the skip-unchanged check is a content hash kept in
`tiles/manifest.json` in the bucket, so a re-run with nothing new PUTs nothing.

```
bun wb site tiles --dry-run    # counts only, uploads nothing
bun wb site tiles --upload
```

It uses the same `S3_*` credentials as the snapshot publisher
(`WRATHBENCH_MINIMAP_DIR` overrides the root). `bun wb site ship --tiles` runs the
same upload as part of a deploy, which is the usual way to do it after a
re-extraction. Two things go with it: `WRATHBENCH_TILES_BASE` in `.env`, without
which the built site asks for nothing, and — after a re-extraction, since the
keys are reused — a purge of the `/tiles/` prefix, or the tiles cache rule's
day (`infra/cloudflare/README.md`) has to pass before readers see the new ones.
Art tiles go up in the same pass. The art is re-baked in place while its look
is tuned, so an upload ends by naming the maps whose art it changed. Purge
`/tiles/<map>/art/` for each, and the art's own cache rule brings browsers up to date within minutes
(`infra/cloudflare/README.md`, steps 4 and 6).

### Start the loop, then deploy the SPA

```
docker compose -f infra/compose.yml up -d --no-deps publisher
docker compose -f infra/compose.yml logs -f publisher
```

`--no-deps` for the same reason as the fleet: without it compose may decide the
worldserver is out of date and recreate it under live episodes. The service
sits behind the `publish` profile so a bare `up -d` cannot start a second
publisher against the same bucket. `stop publisher` needs no drain — an
interrupted pass leaves the last manifest pointing at the last complete
set.

The app is a separate deploy, and only ever a UI change, because data never
moves through it:

```
bun wb site ship               # or `bun ship`, the same script
```

`infra/deploy-dashboard.sh` needs three names from `.env`:
`WRATHBENCH_SNAPSHOT_BASE` (`https://wrathbench-data.shard.page`),
`WRATHBENCH_PUBLIC_ORIGIN` (`https://wrathbench.shard.page`, which the card's
absolute `og:image` is built against) and `WRATHBENCH_CF_DEPLOY_TOKEN` (or a
`bunx wrangler login` in its place). The first two are hard failures if unset — an empty snapshot base in particular would
quietly build the *private* bundle, which on the public hostname polls `/api`
forever and reads as a permanent data outage rather than as anything obviously
broken.

`VITE_WRATHBENCH_SNAPSHOT_BASE` is what selects the snapshot client at build
time, so the public bundle and the private one (built without it, served
same-origin by the viewer) come off the same source with no runtime switch. The
minimap tile URLs are relative to `VITE_WRATHBENCH_TILES_BASE` instead, which is
the point of its being a separate flag (`dashboard/src/lib/tiles.ts`).

`wrangler` is a pinned devDependency (root `package.json`), so `bunx wrangler`
resolves to the version the lockfile names rather than whatever npm serves that
day — the same reason every other version here is pinned.

### Verify

`infra/cloudflare/README.md`'s verify step is the check, the cache rule first
because it is the one misconfiguration that bills. Two readings belong to the
steady state:

- The staleness banner reads a plausible age: a minute or two, never hours and
  never negative. Three clocks are in play (fleet heartbeat 30–60s, push every
  five minutes, and a TTL ≤60s) and the banner reads only the last push, so
  hours means the publisher stopped, not that a cache is cold.
- A run detail page shows its published entries window and nothing more: no
  "load earlier", no live tail, no raw line. If a raw line ever renders, stop
  the publisher — the content boundary has a hole.
