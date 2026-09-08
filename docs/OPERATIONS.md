# Operations

How to run the harness day to day. Architecture is in `docs/ARCHITECTURE.md`;
what the agent may see and do is `docs/CONTRACTS.md`. Bringing the stack up on
a fresh machine is `infra/README.md`.

## Running the fleet as a service

The fleet supervisor (`infra/run-fleet.ts`) is a compose service. It is up
while the dev machine is up, it has no deadline, and it is steered entirely by
editing `infra/fleet.json` — which it re-reads every 60 seconds. It lives
inside the runner image rather than on the host so it survives the operator's
shell and reboots, and never crosses the container boundary to spawn a runner.
That shape is what the Helm chart at `infra/chart/wrathbench` deploys
unchanged — the same image, the same `fleet.json` re-read every 60 seconds,
the same drain on SIGTERM — with the Deployment scaled 0/1 where compose stops
and starts a service. See `docs/DEPLOY-NUSPHERE.md`.

### Start it

```
docker compose -f infra/compose.yml up -d --no-deps fleet
```

`--no-deps` is not optional. Without it compose may decide a dependency (the
worldserver, typically, whose committed config can be ahead of the running
container) is out of date and recreate it — dropping every live episode. The
service sits behind the `fleet` profile precisely so that a bare
`docker compose -f infra/compose.yml up -d` cannot start a second supervisor
against the same `fleet.json`; naming the service is what activates it.

### Watch it

```
docker compose -f infra/compose.yml logs -f fleet     # supervisor stdout
./infra/run-fleet.sh --status                          # host, read-only
tail -f data/runs/fleet-<job>-<stamp>.log              # one job's roster stdout
```

`--status` works from the host even though the supervisor is in a container: it
reads `data/runs/fleet-state.json`, and liveness comes from a heartbeat the
supervisor refreshes each tick, not from a pid probe that would mean nothing
across the namespace. A supervisor that has been gone for more than three ticks
reports `NOT RUNNING`.

### Steer it

Edit `infra/fleet.json`. Nothing to restart. The unit you steer is the
**job**: a roster entry (or a rotation of several), an episode, a
repeat count, on one account — pinned to it when the job names an `account`,
otherwise on whichever pool account is free.

- `"enabled": false` — the job **drains**: no signal while it has an episode in
  flight, SIGTERM at the next episode boundary. Worst case a just-started
  episode is terminated gracefully; never a corrupted one. A pool job frees
  its account when the process exits; deleting a job from the queue drains it
  the same way.
- `"enabled": true`, or a brand-new job — spawned on the next tick (a pool job
  when an account is free). `enabled` belongs to a JOB; on a roster entry it is
  refused (pause a stream with `idle: "none"` — "Strict keys", below).
- A malformed edit is complained about and ignored; the last good config keeps
  running. Check it first if you like:
  `docker compose -f infra/compose.yml run --rm --no-deps fleet bun infra/run-fleet.ts infra/fleet.json --dry-run`
- While the file is rejected, **every `enabled` flag in it is inert** — including
  a later, valid-looking edit disabling a job, which the supervisor never sees
  because it never gets past the parse. `--status` leads with a banner
  (`!! fleet.json REJECTED since …`) and marks a pinned job's flag as
  `(FILE, NOT in effect)` until a re-read succeeds. The banner comes from the
  supervisor's own state file, not from parsing the config here: the two can be
  different versions of the code, and the supervisor's verdict is the one that
  decides what runs. Trust the banner over your own reading of the file.

Two enabled jobs must not share an account, a pinned account may not be in the
pool, and the roster policy (claude models on the claude-code driver only —
the claude-code harness; no claude id on the codex driver; shared free pools
carry free ids only) is enforced on every roster entry at every re-read.

#### Config reference (`infra/fleet.json`)

`infra/fleet.json` is the live config. (Through the 0.5 rollout it was staged
beside the running one as `fleet.next.json`; that shim was removed once 0.5
landed — see "Changing the config shape" below for the pattern, which is still
how a shape change ships.)

```
preflight   the gate (below): enabled, account, smokes [{script, account}], timeoutMs,
            deploySmokes, deployTimeoutMs. Its accounts may not be in the pool or on a job.
accounts    { pool: [...], paid: [...], local: [...] } — the account classes, each in
            preference order. Never PROBE, never SMOKE*. `pinned` is derived from the jobs and
            refused if authored.
roster      name -> entry. The keys an entry may carry, and nothing else: model, tier, idle,
            driver, effort, apiBase, apiKeyEnv, billing, subscription, race, class, watchdogs,
            maxToolCalls. Anything else REFUSES the entry by name ("Strict keys", below).
            NO character name: the model names its own at createSession, and the name it chose is
            what the run row, meta.json and the runs page carry. `character` is REFUSED by name
            here (as it is in a campaign or a cell) — a name in the config is one the harness has
            to keep valid and unique, and an invalid one takes the whole file down. `race` and
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
              under `models` and supplies its own task shape.
            `idle` — what it does with an account once its tier is spent. `none` (default, and
              what a paid model wants) or `unlimited` (one continuous freeplay session at a time,
              with no episode wall clock — the idle watchdog is what ends it). Never bought by
              omission. A race/class sweep is a campaign now, not an idle mode. Flipping
              `unlimited` → `none` pauses the live session at once; flipping it back brings the
              same character back ("Freeplay streams are durable", below).
            A t0 model that reaches level 5 KEEPS the witness (`t0*` in --status) without spending
            it: move it to t1 and it promotes at once on evidence it already has. Moving a model
            by hand is always allowed and never records a promotion — "promoted" is said only of
            a climb.
policy      Only where runs execute and how many at once. maxConcurrent { <rate-limit key>: n }
            caps the streams in flight per key (`concurrencyKeyOf`), counting every job on that
            key, pinned ones included (`"claude-code": 2` today: the probe plus one sonnet).
            Optional, off when absent: `paid { maxConcurrent 1 }` — at most that many paid runs in
            flight. It is a THROTTLE, not a budget: how much a paid model runs is its tier, the
            same sentence a free model's budget is written in.
            Billing is derived per model (free slug / LAN apiBase / claude-code / allowlist ->
            free, else paid); `roster.<name>.billing: "free"|"paid"` overrides it. Billing
            says only WHERE a run may execute — the account class and the rate-limit key.
            `runsPerEpisode`, `paid.runsPerEpisode` and `extras` are not 0.5 keys and are refused
            by name, as are `roster.<name>.runsPerEpisode` and `roster.<name>.tiers`.
campaigns   probe campaigns (docs/EPISODES.md, `probing`): { <name>: { enabled, models "all"|[refs], runsPerCell,
            maxAttemptsPerCell?, cells [{ id, race?, class?, objective?, ... }], account?, objective?,
            wikiCoords?, watchdogs?, maxToolCalls? } }. Every run is an unscored `probing`
            episode; the campaign owns its whole task shape, so a catalog entry's own objective
            or leash never leaks into one. Precedence: episode defaults < campaign < cell.
            With `account` the campaign is PINNED to it and follows the pinned-job account rules;
            without, the policy schedules it between the evals and the idle work. Completion is
            DERIVED (cells x models x runsPerCell against the counted probe runs on disk) — set
            `enabled: false` when a sweep is done and its results stay visible. A failed launch
            is not a counted run, so a cell that always fails would be swept forever:
            `maxAttemptsPerCell` ABANDONS a (model, cell) after that many launches, counted or
            not. Absent means no cap. Progress is on the /campaigns page.
queue       jobs, in priority order: { ref | [refs], episode e90|e360|freeplay, repeat n|"loop",
            enabled, account? } — plus `subscription` (a lane's env var NAME) and nothing else;
            any other key REFUSES the job by name ("Strict keys", below). With `account` the job is PINNED to it and never the policy's;
            without, it is a manual pool job that outranks the policy. The name is always
            `<first ref>-<episode>` (run ids `fleet-<name>-<model>[-<effort>]-<stamp>`), one job
            per (ref, episode). A pool job whose ref is not eligible for its EPISODE is skipped
            with the reason in --status; a pinned one waits the same way. A waiting manual job
            reserves the POOL only — the paid and local classes still pick, and the reservation
            is named in --status.
```

#### Strict keys, and how to pause a stream

A roster entry and a queue job each carry a **declared set of keys** (listed
above) and nothing else. A key outside the set REFUSES that entry or job by
name: the refusal line in `--status` says which key it was and what to write
instead, the rest of the file stays in effect, and a live run under the refused
entry or job is left alone — it just does not respawn. Whole-file rejection is
still what a shape error gets. (Campaigns were already strict, via their
schema; account lists are plain names and have no keys to get wrong.)

The key that cost us a day: **`enabled` is a queue job's word, not a roster
entry's.** `"enabled": false` on an entry was silently ignored, so a freeplay
stream believed to be paused kept running through a deploy window
(2026-08-30). To pause a stream, set the entry's `idle: "none"`: the freeplay
job stops being generated, the paused run reads "not in config — resume by
hand", and it stays down until `idle: "unlimited"` comes back (the character is
durable — "Freeplay streams are durable", below). To take a model out of
scheduling entirely, set its tier and idle to what you actually want; there is
no on/off switch on a catalog entry.

A roster entry referenced by a pinned job is never policy-scheduled: the account
is spoken for. Nothing else takes an entry out of the policy — a campaign
BORROWS a catalog entry rather than removing it from the schedule. Everything
else in the roster is the policy's (below). This
is the only shape: a file that still says `lanes` or `accounts.pinned` is
refused by name, with the message naming the 0.4 keys.

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
ends: a stop no longer costs a run its *place*, but it does cost it that
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

Everything that changes the harness reaches the running fleet one of three
ways, and the first question is always **which**:

| What you changed | How it lands |
| --- | --- |
| `runner/src/**`, `sdk/**`, the wiki bundle | the **next episode spawn**. The repo is a bind mount and every episode is a fresh `bun runner/src/run.ts`: nothing to restart, and a run in flight keeps the code it started with. |
| `infra/fleet.json` | the **next tick** (60s). Hot-reloaded; a malformed edit is complained about and ignored. |
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
./infra/fleet-update.sh graceful            # the whole thing
./infra/fleet-update.sh graceful --dry-run  # the plan and every resolved value; safe while runs are live
./infra/fleet-update.sh status              # the switch, the heartbeat, the live jobs
```

It sets the **pause switch**, waits for every run a recreate would *cost* to end
on its own clock, recreates the container on the new code, waits for the new
supervisor's first heartbeat, and clears the switch. No attempt is spent. It is
not quite true any more that nothing is signalled: the switch itself SIGTERMs a
freeplay stream at once (it has no episode boundary to drain to), and the
recreate lands on whatever parked runs are still mid-episode. Nothing *scored*
is ever signalled, which is the promise that matters.

It does not wait for the runs that come back **where they left off**: the
freeplay stream and a probe campaign with `resume: true`. Once the switch has
put such a job in `draining` the wait counts it as drained and moves on — an
`idle: "unlimited"` session has no clock to finish on, so waiting for one is
waiting to the 8h ceiling (2026-08-29: the window had to become a `force`, and
the stream then came back on the same run id and character anyway). The status
lines name both halves each poll: `waiting on:` for the runs holding the window
and `counted drained:` for the parked ones. Whether a job parks is the
supervisor's own answer, published per job row as `resumesInPlace` in
`fleet-state.json` — the script never re-reads `fleet.json` for a campaign's
`resume` flag, because the switch has to work while that file is rejected. A
supervisor older than that field does not write it, and the script falls back
to the freeplay pair (`source: policy`, `episode: freeplay`).

The switch is `data/runs/fleet-pause.json` (`{"paused": true, "why": "..."}`),
read every tick beside the config. While it is set the fleet launches
**nothing** — no queue job, no policy pick, no campaign cell, no resume of a
paused run — and every running job *drains*: SIGTERM only once its roster is
between episodes, exactly as `"enabled": false` on one job does. It is a
sidecar rather than a fleet.json key on purpose: a typo in `fleet.json` makes
every `enabled` flag in it inert until somebody reads the banner, and the stop
button must not be able to do that. It also works while the file is rejected,
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
set, and `./infra/fleet-update.sh resume` puts the fleet back to work — which
the script now says, loudly, on the way out. An aborted window that looked like
nothing happened is how a fleet ends up scheduling nothing until somebody
notices.

**The first time, the switch is not live yet.** It is supervisor code, so a
supervisor started before this shipped does not read it — the graceful path
becomes available only after one restart. That restart does *not* have to be
the forceful one: the equivalent drain against the code running right now is a
`fleet.json` edit (it is hot-reloaded, so it needs nothing new) —

```
accounts: { "pool": [], "paid": [], "local": [] }   # the policy has nowhere to schedule
campaigns: every one "enabled": false               # each drains at its episode boundary
queue: []                                           # nothing manual
```

— then wait for `--status` to show no live job, `docker compose -f
infra/compose.yml up -d --no-deps --force-recreate fleet`, and put the accounts
and campaigns back. `infra/fleet.test.ts` pins that this edit parses and
schedules nothing. It is strictly worse than the switch (it is an edit to the
file whose every flag goes inert on a typo, and it does not stop a *resume*),
which is why it is the bootstrap and not the recipe.

#### Forceful — now, and it costs the live runs

```
./infra/fleet-update.sh force               # asks for confirmation; --yes to skip
docker compose -f infra/compose.yml up -d --no-deps --force-recreate fleet   # the same thing by hand
```

Compose stops the container inside its 180s `stop_grace_period`, so every live
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

`--no-deps` is not optional on either path: without it compose may decide the
worldserver is out of date and recreate it under every live episode.

Rebuilding the image (`docker compose -f infra/compose.yml build fleet`) belongs
between the drain and the recreate; `fleet-update.sh` does not build for you.

#### The worldserver

`./infra/deploy-worldserver.sh` owns its own window and is the **forceful**
path by design: its `draining` phase is `compose stop fleet`, so every live run
pauses and a scored one spends its attempt, exactly as above. That is the
documented trade — the script needs nothing from you while it runs, and a
deploy must never depend on an operator watching a wait loop.

For the graceful version, drain first and hand the script a quiet fleet:

```
./infra/fleet-update.sh drain      # pause, wait for quiet, stop the fleet; switch stays set
./infra/build-worldserver.sh
./infra/deploy-worldserver.sh      # its stop finds nothing live; it brings the fleet back up
./infra/fleet-update.sh resume     # clear the switch; the pool fills on the next tick
```

The deploy still brings the fleet up on every exit path — that invariant is
untouched — so `resume` is the only step you owe it afterwards. If you forget,
`--status` says the fleet is paused and nothing schedules until you do.

#### What a restart does to paused runs

The restart procedure is **stop → (runs pause) → start → (scored runs
are ended as failed attempts and reattempted; freeplay and opted-in campaigns
resume)**. On boot, before the queue or the policy spawns anything, the
supervisor finds every paused run whose model and episode are still in
`fleet.json`, maps it back to its job (a pinned or queued job from the file,
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
keeps an update window from filling the pool behind the operator's back.

### Lapsed runs: paused, and stale

A run that stops without a verdict is handled by its **lane**
(docs/METHODOLOGY.md, "Episodes, lanes, and evidence").

A **scored** run (`e90`, `e360`) — and a probe campaign that did not set
`resume: true` — does not resume. `--status` shows it on its account as
`failed attempt: quota-exhausted: not resumed … , retry 2/3` and lists it under
`lapsed runs the supervisor ends on its next tick`. The supervisor writes the
termination through the runner's own writer, releases the session so the
account and character go back, and the policy schedules a fresh attempt on the
tick after. Three counted failures on one (model, episode, series) and the
model is **tainted** for that episode: `--status` says
`tainted on e90 (3 failed attempts)` and the model is blocked — not "free", so
it takes no idle work either — until `run-fleet.sh --clear-model <name>`. A
fleet stop (`manual`) and an offline gap (`stale`) do not count toward those
three: they are the harness's doing. Do not confuse this taint with the
roster's own `tainted` in a job's defer sidecar, which is one process backing
off a model whose launches keep failing.

**Stale** runs are swept on boot and on every tick: any run with no termination
whose last activity (its pause mark, else its trajectory) is older than **its
own** episode budget — 12h for a run with no wall clock — is ended. That is the
half-day outage case: the host slept, and every run left live or paused had its
budget elapse in wall clock while nobody was playing it. A stale freeplay
session is ended too, and the next tick continues it on the same character
under a new run id (below). A run the fleet did
not launch (no `fleet-` prefix) is never ended by the supervisor: it is listed
for the operator.

For the lanes that **do** resume — freeplay, and `campaigns.<name>.resume` —
`--status` shows `paused (reason, Xm elapsed of Ym) — <run id> Lx xp` and a
`paused runs not resumed` block with why:

- **not in config** — the model or episode is gone from the fleet config (or the
  pinned job is disabled, or on another account). Resume it by hand
  (`infra/run-episode.sh --resume <run id>` on its account) or archive it.
- **cooling** — a provider pause on the roster's defer ladder
  (`1m/3m/5m/10m/15m/30m/1h/3h/6h`), indexed by how many times *that run* has
  paused. The two-stage retry answers the mid-episode pause question: the roster retries a
  mid-episode provider pause in place (2m/5m/10m) while its process lives;
  once it gives up and exits, the supervisor takes over on the longer ladder,
  resuming in place on the same run id. Past the ladder the run is listed,
  not hammered.
- **waiting** — its account is busy with another job or held by a
  hand-started run. A resume never moves to another account.

While a run is paused its model is held: the projection reports `no: paused
run … — resumed by the supervisor, never rescheduled` for a lane that resumes,
and `… — ended as a failed attempt on the next tick, then reattempted fresh`
for one that does not. Either way no second attempt starts for that model, and
a paused run counts toward nothing until it finally ends.

### Freeplay streams are durable

A freeplay stream — the one continuous session an `idle: "unlimited"` ref
gets — is the operator's to disable and re-enable at will, and the character
survives it (operator ask, 2026-08-29). Before this, only a *pause* came back:
every ended session (idle watchdog, a hand kill, the stale sweep) was followed
by a fresh attempt whose hygiene wiped the account and whose model named a new
level-1 character — `sub-opus-low` went through ten names in eleven attempts.

The stream's identity is nothing new on disk: the ref's latest **ended**
freeplay run that recorded an account and a character (`streamsFrom`; matched
on model + effort like account affinity, so a renamed ref keeps its stream).
What the supervisor does with it, per tick:

- **Disable** (`idle: "unlimited"` → `"none"`, or the fleet pause switch): the
  policy job is drained, and for this lane a drain is an immediate SIGTERM —
  there is no episode boundary to wait for on a session with no wall clock.
  The runner logs the character out and writes `operator-pause`; `--status`
  lists the run as `paused, not in config` while the ref stays `none`.
- **Re-enable within 12h**: the paused run is resumed in place by the ordinary
  resume path — same run id, account, character, scratchpad.
- **Re-enable later**, or after any ended session: the stale sweep (or the
  watchdog, or the operator's kill) has ended the run, so the next policy pick
  is a **continuation**: a new run id (`-a<n+1>`) launched with
  `--continue-from <predecessor>`. The runner refuses it unless the launch is
  `freeplay`, the predecessor is a freeplay run on the same account and named
  a character; then hygiene keeps that character and clears the rest, the
  predecessor's `scratchpad.md` is copied in, race and class are the
  character's, and the model gets a "this continues run X on Bromdir, last
  seen at level 8" note instead of the naming note. The lineage is on the run
  record: `config.continuedFrom` in meta.json, `continued_from` on the `run`
  row, a `continue` trajectory record. If the character turns out to be gone,
  the run drops the lineage everywhere (`continue-dropped`), deletes the
  copied notes and starts fresh — a lineage the character does not back is
  the wrong record.
- **The account is the stream's.** A freeplay pick prefers its stream's
  account over the model's last run. If that account is busy, who holds it
  decides (`streamStanding`; operator decision 2026-08-29, item 94):
  - the ref itself (its own live run, or its resume reserving the account):
    nothing to plan, the stream is in flight;
  - another ref's **bounded** run — a scored episode, a probe, a hand-written
    job — ends at its episode boundary, so the pick is **held**
    (`policy <ref>: waiting — RUNNER2 is held by glm-e90 until its episode
    boundary — holding for Bromdir (…-a11)`), never started fresh elsewhere;
  - another ref's **unlimited stream** has no boundary to wait for, and
    waiting is the deadlock the first day of durable streams produced (two
    heads on one account: the occupant's `--keep-characters` protects the
    waiter's character, `POST /character-delete` refuses `account_in_use`,
    and the waiter holds forever). The pick starts **fresh on the free
    account it was offered**, lineage dropped: no `--continue-from`, a
    `continue-dropped` harness record on the new run naming the head and
    `account_occupied_by <ref>`, a `stream-dropped` event in the supervisor
    log, and `--status` says `fresh-next`. With no free account the ref
    simply gets no pick, and the supervisor says once why the next one will
    be fresh.
  The orphaned character stays where it is. `keepFor` derives from
  `streamsFrom`, and a head is the ref's latest **ended** freeplay run with
  a character: while the fresh session is live the old head is still the
  stream, so the occupant's keep-list (fixed at its own launch anyway) and
  the next launch on that account still protect the orphan. Once the fresh
  session ends having named a character, it is the head, the orphan is no
  stream's, and the next fresh launch on the old account wipes it in
  ordinary hygiene (the cross-account name sweep stops skipping it too). If
  the fresh session dies before naming one, the old head stands and the
  next pick is decided the same way again.
- **One stream per model+effort.** A `unlimited` ref has exactly one character
  at a time, and the freeplay ladder shows the live field, not every dead
  character a model ever rolled (operator ask, 2026-08-29). The older ended
  sessions of a stream are parked with `bun runner/src/archive.ts --run-ids`
  ("Archiving runs"), which is a decision about listings and nothing else: the
  character is untouched, the trajectories survive under `archive/`, and the
  scheduler still reads them. A continuation whose predecessor has been
  archived **stays valid** — `loadContinuation` reads it from
  `<runs>/archive/<id>`, scratchpad and all, because the stream election reads
  archived facts too. A predecessor that is on disk nowhere is not fatal
  either: the launch drops the lineage (`continue-dropped`, naming the missing
  id) and starts fresh rather than dying.
- **Nothing else deletes it.** Every fresh launch on an account that holds
  another ref's stream character gets `--keep-characters`, so a scored run's
  hygiene leaves it standing (the model is told the name is taken, and the
  freshness tripwire still arms on its guid); the cross-account name sweep
  skips stream characters.

The policy line says what happened: `policy sub-opus-low: sub-opus-low freeplay
attempt 12 (extra) (continues fleet-…-a11) on RUNNER2`, and `--status` prints
one `stream <ref>:` row per `idle: "unlimited"` ref — its head (run id,
account, character) and the verdict: `in flight`, `continuable`, `held: <ref>
on it until its episode boundary`, or `occupied by <ref>'s stream: fresh-next`.
Roster changes that compete for one account go in **one write, owner first**:
the hot reload is 60 s, and two edits in sequence let a second stream elect the
account between them (how item 94 arose). A hand-written
`freeplay` job on the same ref is the operator's own experiment and never
continues anything. To start a stream over deliberately, delete its character
(`POST /character-delete` on the module, the sweep's own path) before
re-enabling: the continuation finds nothing and starts fresh.

Scored episodes are untouched: `--continue-from` is refused on `e90`/`e360`,
their hygiene still clears everything but another stream's character, and a
lapsed scored run is still a failed attempt.

**Deploy:** the runner half lands on the next episode spawn; the supervisor
half (`planContinuations`, the pause-on-drain, `--keep-characters`) needs the
`fleet` container recreated — `./infra/fleet-update.sh graceful` once the live
runs are at a boundary, as "Updating the live fleet" describes.

### Deploy window (worldserver changes)

Two scripts, from the host; the deploy is **one command** that owns the whole
window and needs nothing from you while it runs:

```
./infra/build-worldserver.sh                   # build wrathbench/worldserver:next, stamped
./infra/deploy-worldserver.sh                  # the whole window, start to finish
./infra/deploy-worldserver.sh --next-tag wrathbench/worldserver:mybuild
./infra/deploy-worldserver.sh --dry-run        # print the plan and every resolved value; do nothing
```

The build script stamps the image with this checkout's
`git describe --tags --always --dirty` (docker build-arg `WRATHBENCH_BUILD`),
which the module serves as `/health.build` alongside `startedAtMs` and the
image carries as the `wrathbench.build` label; the fleet gate, `run-fleet
--status`, the viewer's `/api/info` and the deploy script name the server by
it. Commit before building so the stamp names a commit rather than `-dirty`.

You do not drain anything first, you do not wait for anything, and you do not
kill anything. If a deploy ever needs a wait loop or a `pkill` from the
operator, that is a bug in the script, not a procedure. Run it with the fleet
up; run it again if it failed; it is safe both ways. The price of that is the
`draining` phase below: a `compose stop`, so every live run pauses and a scored
one spends its attempt. When you would rather pay nothing, drain first —
"Updating the live fleet", *The worldserver* — and hand the script a fleet that
is already quiet. Nothing about the script changes either way.

#### What each phase means

The script writes `data/runs/server-state.json` at every transition
(`{ phase, since, build, prevBuild?, detail, pid, updatedAt }`), the viewer
serves it as `server` on `/api/fleet`, and the Fleet page prints one banner
line at the top: the phase in plain words, then the script's own `detail`
sentence verbatim. The page never guesses at what the window is doing.

- **draining** — `docker compose stop fleet`. SIGTERM reaches the supervisor,
  every live run pauses (see "Stop it"), the supervisor writes its final state and
  exits. The script then waits for that state file to say no job is alive —
  the supervisor's own word, never a process listing — for at most 60s after
  `stop` returns, and fails loudly if it never does (a SIGKILL inside the
  grace period is the only way that happens). Page: *"Deploy window since
  18:52 — stopping the fleet for harness-0.4-52, runs are pausing: replacing
  harness-0.4-3; 7 job(s) live — each run pauses and resumes after the
  deploy"*. While the window is open the supervisor line reads *"fleet stopped
  for the deploy window"* instead of *NOT RUNNING*, and a job row whose
  process is gone reads *paused for deploy* instead of *exited*.
- **swapping** — `:latest` is tagged `:prev` (the rollback target), `:next`
  becomes `:latest`, the worldserver is recreated (`--no-deps`: the one time
  recreation is the point) and the script waits up to 300s for `/health` to
  answer ready. Page: *"— swapping the worldserver to harness-0.4-52: worldserver
  recreated, waiting for /health ready (up to 300s); fleet stopped, 7 job(s)
  paused and will resume"*.
- **verifying** — the gate smokes (`preflight.smokes`) and then the
  deploy-only full arc (`preflight.deploySmokes`, `module-quest.ts`) run
  directly through `docker compose exec runner`, each against its budget. The
  fleet is down, so nothing else is on the smoke accounts. The detail names the
  smoke in flight: *"— swapped to harness-0.4-52, verifying: full-arc smoke
  infra/smoke/module-quest.ts (1 of 1) running since 18:58, 600s left of its
  budget; fleet stopped, 7 job(s) paused and will resume"*.
- **resuming** — every smoke passed; `docker compose up -d fleet`. The
  supervisor boots, re-gates on the new server identity and resumes every
  paused run on its own account before the queue or the policy gets one.
- **running** — the window is over. The banner drops to a dim line: *"server
  running: deployed harness-0.4-52 at 19:03, verified by 2 direct smoke(s) + 1
  full-arc smoke(s); fleet resumed"*. The script's last line is `DEPLOYED and
  verified by …`, exit 0.
- **rolled-back** — a smoke failed on the new build. `:prev` is retagged
  `:latest`, the worldserver recreated, health waited for, and the **old** build
  is re-verified with the gate smokes; then the fleet is started on it. Exit 1.
  Page, red: *"Deploy of harness-0.4-52 FAILED at 18:52 and was rolled back to
  harness-0.4-3: gate smoke failed on harness-0.4-52; harness-0.4-3 verified by
  2 direct smoke(s); fleet resumed on the old build"*.
- **failed** — the deploy failed *and* nothing is verified: the drain never
  completed (nothing was swapped; the old server is still live), there was no
  `:prev` to roll back to, the rolled-back build would not verify either, or
  the fleet would not start. The fleet is started regardless — its own
  preflight gate blocks spawning until a build passes — and the detail says
  which case it was. Exit 1. Page, red: *"Deploy of harness-0.4-52 FAILED at
  18:52: …"*.

Whatever happens after the fleet is stopped, the script's EXIT trap brings it
back up: a deploy never leaves the fleet stopped, on any path, including an
unexpected error. `set -Eeuo pipefail` plus an ERR trap means any failed step
after the swap is a failed deploy (rollback, verify old, fleet up, exit 1),
never a warning.

The script holds an `flock` on `data/runs/server-state.lock` for its lifetime:
a second deploy refuses to start while one runs, and the supervisor writes
`running` over whatever phase it finds only when that lock is free — on boot
over any phase (a restart is your acknowledgement of a `rolled-back` or
`failed` notice), and on every tick over a *window* phase (`draining`,
`swapping`, `verifying`, `resuming`), which with no lock holder can only be the
leftovers of a deploy that died. So a crashed deploy cannot leave the page
claiming a window is open.

#### If it says failed (or rolled-back)

Read the detail: it names the smoke that failed and its tail is in the script's
output. Then:

1. **rolled-back** — the old build is live, verified, and the fleet is running
   on it. Nothing to do for the fleet. Fix the module, rebuild `:next`, deploy
   again. The red banner stays until the supervisor next boots (a `stop` /
   `up -d fleet`, or the next deploy), so it is not missed.
2. **failed, "the server was not swapped"** — the drain did not complete, so
   the old build is still live and untouched. The fleet was started again;
   check `data/runs/fleet-<stamp>.jsonl` for why the supervisor did not exit
   cleanly (a roster that ignored SIGTERM, a runner past its 60s backstop),
   then deploy again.
3. **failed, "ROLLBACK IMPOSSIBLE"** — the new build is live and unverified
   because there was no `:latest` to keep. The fleet is up and its gate is the
   only check; `run-fleet --status` and the gate strip on the Fleet page say
   whether it passed. If the gate fails, build a known-good `:next` and deploy
   it.
4. **failed, "could not verify it"** — the rollback happened but the old build
   failed the gate smokes too, which means the failure is not in the build
   (auth, the database, the smoke accounts, the runner image). The fleet is up
   and gated shut. Run a smoke by hand (`docker compose -f infra/compose.yml
   exec runner bun infra/smoke/quest-accept-status.ts`, which logs in as PROBE;
   add `-e MODULE_ACCOUNT=SMOKE` to reproduce the gate's account) and read its
   output.
5. **failed, "the fleet service did not start"** — the one case with a command
   for you: `docker compose -f infra/compose.yml up -d fleet`, after reading
   why compose refused (`docker compose logs fleet`).

`--no-smoke` is the honest escape hatch for a machine where the preflight
accounts do not exist yet: it drains, swaps, waits for health, verifies
nothing, says `DEPLOYED UNVERIFIED`, and hands the server to the fleet — whose
own gate is then the only check. An enabled preflight with no `smokes`
configured is not that: it rolls back and exits 1, because nobody asked for an
unverified deploy.

`--dry-run` prints the plan and every resolved value — which config and state
files it will read, the next and rollback builds, the smoke list and budgets,
whether the fleet container is running and how many jobs its state lists
alive, whether the deploy lock is free, and which verification path it would
take — and executes nothing. It is read-only and safe while the fleet is up.

Verification is **fail-closed**: the closing line names what verified the
deploy (`DEPLOYED and verified by N direct smoke(s) + M full-arc smoke(s)`),
and it can only be reached by a step that actually ran and exited zero. Each
smoke logs its start, its duration and its exit code.

`infra/deploy-worldserver.test.ts` covers this without a daemon: it runs the
real script with `docker` replaced by a PATH shim, under `FORCE_COLOR=3`, and
asserts the phase sequence, the drain, the rollback branch, the fleet-up
invariant on every exit path, and the exit codes.

### The preflight gate

The supervisor smokes the server before it launches anything. The knob is the
top-level `preflight` block in `infra/fleet.json`, hot-reloaded like the jobs:

```json
"preflight": {
  "enabled": true,
  "account": "SMOKE",
  "smokes": [
    { "script": "infra/smoke/quest-accept-status.ts", "account": "SMOKE" },
    { "script": "infra/smoke/kill-credit.ts", "account": "SMOKE2" },
    { "script": "infra/smoke/module-navigation.ts", "account": "SMOKE3" }
  ],
  "timeoutMs": 130000,
  "deploySmokes": [{ "script": "infra/smoke/module-quest.ts", "account": "SMOKE" }],
  "deployTimeoutMs": 600000
}
```

There are two kinds of smoke:

- **`smokes` is the per-tick gate.** It runs before the first job is spawned
  and again whenever the server identity changes — which is to say on every
  worldserver recreate *and* on every restart the container does by itself.
  Entries with **distinct accounts run in parallel**; entries sharing an account
  run in order. A bare string entry means "on `account`". The three shipped
  smokes split the old arc's claims without losing one:
  `quest-accept-status.ts` (login, questgiver status, quest query, accept,
  the served quest-log complete state, turn-in reward chain, XP, vendor list,
  ~20s), `kill-credit.ts` (one kobold: attack stream, kill credit, loot
  round trip, ~42s), and `module-navigation.ts` (the navigation status
  vocabulary: a mesh-resolved arrival carries `meshZ`, a target far outside
  the poly search is `target_off_mesh`, a request beyond the single-move cap
  is `too_far`, a plain walk arrives with no `meshZ`, and every status on the
  stream is in the documented vocabulary; ~15s, its own account so it runs
  in parallel with the other two). All three delete the previous run's
  character first (the CMSG_CHAR_DELETE proof) and only log out at the end,
  because a disconnected character stays in world for the core's 60s
  `WorldSession::expireTime` during which a delete is silently ignored —
  deleting last time's character costs nothing, deleting this time's costs a
  minute.
- **`deploySmokes` is the deploy-time full arc.** `module-quest.ts` — eight
  kills to objective completion and the kill quest's own turn-in, about four
  minutes — is run once per deploy by `infra/deploy-worldserver.sh`, after the
  gate has passed, never by the supervisor. `deployTimeoutMs` is its budget.

A failure spawns nothing, complains once, and is re-checked every tick, so a fix
or a rollback unblocks the fleet with no operator action. Drains still work
while the gate is shut. `timeoutMs` is the budget for the whole gate — every
child gets the same deadline — and is set at ~3x the measured critical path.
`./infra/run-fleet.sh --status` shows the last gate result, per script;
`--dry-run` shows the plan.

Server identity is the worldserver's boot, read off the shared logs volume
(`data/logs/Server.log`'s creation time), plus a digest of `/health`'s stable
fields. Nothing keys on that string being unique — the deploy script keys on the
gate result's timestamp — so at worst a marker that fails to change costs an
extra smoke run.

**Gate accounts.** Every account a smoke is bound to must exist in auth and be
in the module's allowlist. `SMOKE`–`SMOKE4` exist in auth (bootstrapped
2026-08-22/23; the bootstrap is an idempotent auth-DB upsert and is safe with
the server running):

```
docker compose -f infra/compose.yml run --rm --no-deps \
  -e WRATHBENCH_ACCOUNT_USER=SMOKE2 -e WRATHBENCH_ACCOUNT_PASSWORD=SMOKE2 bootstrap
```

All four are in `AC_WRATH_BENCH_ACCOUNTS` in `infra/compose.yml`, which the
module reads **only at worldserver recreate**. Until the next recreate the
running module permits `SMOKE` alone, so the shipped fleet.json binds both
`quest-accept-status.ts` and `kill-credit.ts` to `SMOKE` (sequential, ~62s,
`timeoutMs` 190000); `module-navigation.ts` is staged on `SMOKE3` in the same
`smokes` array but, being unpermitted before the recreate, answers 403 and
blocks the gate until then (see the `_notes` in `infra/fleet.json`). After the
recreate, flip `kill-credit.ts` to `SMOKE2` and `timeoutMs` to 130000 for the
parallel ~42s gate; `module-navigation.ts` on `SMOKE3` becomes live at the same
recreate and stays its own parallel chain (~15s, well under the budget). Never
before: a smoke bound to an unpermitted account gets 403
`account_not_permitted`, the gate fails, and no job spawns until it is fixed.
The order of operations at that drain window is therefore: recreate the
worldserver, then restart the fleet (which is also what picks up the new
supervisor code — a running supervisor rejects the `{ script, account }` entry
shape and keeps its last good config until restarted).

The gate accounts must be their own: sharing one with an enabled job is refused
as a config error (every per-entry account is checked), and none is ever
`PROBE`, the ad-hoc debugging account.

### What `--status` shows

```
./infra/run-fleet.sh --status
```

In order: the REJECTED banner when the file is not in effect; the PAUSED banner
when `data/runs/fleet-pause.json` is set (with what the supervisor has actually
picked up — see "Updating the live fleet"); the `!` refusal
block when the file IS in effect but a config rule disabled something in it
(item 66 — an enabled job or campaign on a listed account, or a second one on
an account already taken; and since 2026-08-30 an entry or job carrying an
unknown key — refused by name rather than taking the whole file down with it); the supervisor
line (pid, where it runs, ALIVE/NOT RUNNING by heartbeat, epoch stamp); the
gate (last result, per smoke); the **accounts** table — every account, pinned
first then the pool in preference order, with the job on it (`name: model
episode — run id — Lx xp, elapsed`, plus `cooling until …` when its roster is
between episodes on the defer ladder) or `free` (with `held by run … — not
fleet-managed` when something outside the fleet has the account, `paused (…)`
when a paused run sits on it, or the pinned job's enabled/disabled state); the
**models** table from the projection
(`runner/src/models.ts`) — the series it counts against in the header, then
per model its billing, status, counted/target per episode with best level
(`+2sb` is two zero-response launches, archived and kept for the ladder), extras made, and `yes: …`/`no: …` for
schedulability (runs from another series are noted, not counted);
the concurrency cap when one is set; the `paused runs not resumed` block when
there are any; one line `finished this session: N (ok M,
retried K)` (processes that exited since the supervisor started; `ok` is exit
0, `retried` counts respawns of a name already spawned this epoch); and a
**queue** block only when the file has manual pool jobs. Finished runs get no
rows: the run directories and `fleet-<stamp>.jsonl` are the record.
`--dry-run` prints the same anatomy for a supervisor about to start — what
would spawn on each account now, with the exact argv, and `HELD` lines for
picks the paid cap, a driver cap, or an account class with no account held
back (`no paid account configured`, `no local account configured`).

### Changing the config shape

The pattern, from the 2026-08-23 switch to the job shape:
ship the new file as a sibling (`infra/fleet.next.json`), drain or `stop fleet`
(running episodes pause and resume on start), rename it over
`fleet.json`, check `--dry-run` from the new code before anything spawns, then
`up -d --no-deps fleet`. The new file under the old code is the one thing that
must not happen, which is why it ships as a sibling. A shape the current code
does not read is refused by name — there is no compatibility read, so roll
back by renaming the old file back. Run ids carry the job name, so a renamed
job starts a fresh id; nothing resumes across the rename.

### The scheduling policy

With the job shape the `queue` normally holds only the pinned jobs: the
supervisor fills free pool accounts from the roster by policy — each model's
tier budget (`t0`/`t1`/`t2`, see the config reference), `e90` for everyone,
`e360` once earned, newest-to-the-roster first, shorter episode first, fewest
runs first, one stream per model, within `policy.maxConcurrent` per rate-limit
key. Only runs from the running checkout's harness **series** (`0.3` of
`harness-0.3-114-g…`) count; a minor bump starts every model's evidence over,
a fix commit does not. With `policy.paid` set, at most that many paid runs are
in flight at once — a throttle, never a budget. A model whose entry says
`idle: "unlimited"` takes one continuous freeplay session at a time once its
targets are met — no episode wall clock, governed by the idle watchdog —
stamped `extra: true`: an attempt but never counted.
Everything it decides is derived from `data/runs/` each tick; nothing is
stored except an operator's clear.

```
./infra/run-fleet.sh infra/fleet.json --status      # models table: status, counted/target per episode, why (not) schedulable
./infra/run-fleet.sh infra/fleet.json --dry-run     # the picks the policy would make for the free accounts right now
./infra/run-fleet.sh --clear-model <roster-name>    # forgive a retired/cooling model; picked up on the next tick
```

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
as well). How many runs a model gets is its `tier` and nothing else.

### Ad-hoc launches still work

Nothing about the host path changed. One episode:

```
./infra/run-episode.sh --model <id> [--driver openai|claude-code|codex]
```

One roster, or a whole fleet, from the host:

```
./infra/run-roster.sh infra/roster-example.json --until 07:30
./infra/run-fleet.sh infra/fleet.json --until 18:00
```

Do not run a host supervisor against `infra/fleet.json` while the `fleet`
service is up: they would both spawn jobs on the same accounts.

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
what every config written before 2026-08-25 meant.

A claude-code run counts against **two** concurrency keys and needs a free slot
in both:

- `claude-code` — every Claude session in flight, whoever pays. The overall
  ceiling, and the same key an older file already had.
- `claude-code:<ENV NAME>` — that one subscription's sessions. Every lane has
  one, the default lane included.

A key the file does not name is uncapped. Today's numbers: three sessions at
most, one on the operator's own subscription and two on the partner's — so a
lane with a slot free is still held when the three are spent, and the reason
in `--status` names the key that blocked it.

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

**The Codex lane** (2026-09-05) is the same idea with a directory for a
credential: `CODEX_HOME` names a logged-in Codex home (`codex login`; the
login is its `auth.json`), a second subscription is `CODEX_HOME_2` pointing at
a second directory, and a directory is never copied per run — its refresh
token is spent by whichever process refreshes first. A codex run counts
against the `codex` concurrency key (`"codex": 1` is one live session, the
rule the Claude lanes follow); per-lane `codex:<ENV NAME>` keys and a place in
`policy.subscriptions` are not built yet (docs/FOLLOW-UPS.md), so a codex
entry rides the default lane unless its `subscription` pins another
directory's variable by hand.

### Secrets

`.env` at the repo root, never argv. Bun loads `/wrathbench/.env` inside the
container — in the supervisor and again in every child — so keys reach the
runner without appearing in `ps` or in the compose file. A claude-code
job needs the token of the lane it was scheduled on there (`claude setup-token`)
— `CLAUDE_CODE_OAUTH_TOKEN`, or `CLAUDE_CODE_OAUTH_TOKEN_2` for the second
subscription; without it the roster refuses the episode with a `launch-failed`
row naming that variable, rather than burning a session.

`WRATHBENCH_MODULE_SECRET` — the module's **port secret** (module/PROTOCOL.md,
"Authentication"; FOLLOW-UPS 19). Every request to the worldserver's control
port, `GET /health` included, must carry it (or a session secret leased with
it) as `Authorization: Bearer`, and a module started without one — or with one
shorter than 32 characters — refuses to listen at all and says so at ERROR in
`Server.log`. Generate it once with `openssl rand -hex 32` and put it in
`.env`; it is the only place it lives. Who reads it from there:

- the **runner and fleet** services, through Bun's `.env` autoload: the run
  host presents it for hygiene, `/health` and `POST /lease`, then hands the
  snippet child only the per-run session secret the lease returned. The
  child's environment never carries the port secret (`sandboxChildEnv` drops
  it) — a snippet that could read it could list and delete on any account;
- the **smokes** (`infra/smoke/lib/auth.ts`), exec'd in the runner container,
  and the deploy script's `/health` probes, which run there too;
- the **worldserver**, as `AC_WRATH_BENCH_SECRET`. Compose interpolates that
  from the *shell*, not from the repo-root `.env` (its project directory is
  `infra/`), so `./infra/deploy-worldserver.sh` exports the value from `.env`
  before it recreates the container and refuses to open the window when it is
  missing; `--dry-run` prints its length. A bare `docker compose up -d
  worldserver` from a shell without it ships an empty secret and the module
  refuses to listen — the loud failure, by design. An operator's loopback
  probe inside the container needs the header too, and the image has neither
  curl nor wget: `./infra/module-health.sh` does it with perl and prints the
  full census (`sessions`, drops by opcode). A probe from anywhere else — the
  runner container included — gets liveness with the counters zeroed.

Rotating it is a deploy window: change `.env`, then `deploy-worldserver.sh`
(the fleet is recreated on the way out and re-reads `.env`; a live `runner`
container keeps the old value in already-running processes only, and every
`docker compose exec` reads the file fresh).

### Harness version stamping

Every episode is stamped with `git describe --tags --always --dirty`, computed
at launch. On the host `run-episode.sh` does it; in the container `run-roster`
does it, using the `git` in the runner image against the bind-mounted `.git`.
A dirty tree stamps `-dirty` either way — that is the point, and it is why the
stamp is not a file written once at `up` time.

## Public dashboard

The public site is **push-based**: a publisher on the lab renders the viewer's
own API to JSON on a timer and PUTs it to an R2 bucket, and the SPA is built a
second time to read that bucket instead of `/api`. No public request ever
reaches the lab, so a traffic spike is Cloudflare's problem rather than the
worldserver's, and the control surface stays exactly as unexposed as it is
today. `docs/PUBLIC-DASHBOARD.md` is the design and the rejected alternatives;
this section is how to stand it up.

Per `docs/DATA-AND-LEGAL.md` the first genuinely public deploy is still gated on
the operator's content decision (GitHub issue #10) about entry summaries and
verbatim game text. A password-gated preview shared with named people is not
that deploy, and does not wait on it. What follows is the mechanism.

The corollary, stated plainly (GitHub issue #30): **the live viewer is private
and operator-only, and is unsupported as an Internet-facing service.** It stays
on loopback, or on a LAN the operator has explicitly opted in with
`WRATHBENCH_VIEWER_LAN=1`. Public delivery is the static snapshot path in this
section and nothing else — never a port on the viewer, the module or the MCP
bridge, and never a tunnel to one. `WRATHBENCH_VIEWER_PUBLIC=1` projects every
body it serves and withholds raw lines, tiles and the SSE tail, but it exists so
the snapshot renderer can call the handle in-process; it is not an exposure
plan.

### Two shapes, and which one you are standing up

The design doc's shape needs a **domain on the Cloudflare account**: R2 behind a
custom domain, zone cache rules carrying the TTLs, and an assets-only Worker so
that nothing is invoked in the read path at all.

Without a domain that shape is not merely inconvenient, it is unavailable.
Cloudflare's access controls, WAF, and cache are all custom-domain features; the
managed `r2.dev` development URL has none of them, is rate-limited, and is
world-readable to anyone who learns the hostname. There is no password in front
of an `r2.dev` bucket, and enabling one alongside any other gate simply routes
around it.

So there are two shapes, and the steps below are marked for whichever applies.
**Gated is temporary**: it is how a private preview is shared before there is a
domain. **Open is what launches** — no Worker in the read path, so a traffic
spike is absorbed by the edge cache rather than converted into per-request
compute. Retiring the gate is item 85 in `docs/FOLLOW-UPS.md`.

| | **Gated** (no domain — what is deployed today) | **Open** (needs a zone — the design doc's) |
| --- | --- | --- |
| app | Worker, Static Assets, `*.workers.dev` | same, assets-only |
| data | same origin, `/v1/*` from a private bucket binding | `data.<zone>`, public bucket |
| who can read it | whoever has the password | anyone |
| TTLs set by | the Worker, on the way out | zone cache rules |
| CORS | none — one origin | `infra/cloudflare/r2-cors.json` |
| edge cache | none | yes, and load-bearing |
| gate | shared secret in `dashboard/worker/index.ts` | none; issue #10 binds it |

The Gated shape puts a Worker in the read path, which the design doc rejects for
the Open one. That trade is deliberate and narrow: a preview that must not be
world-readable needs something to say no, and on a zoneless account only a
Worker can. Everything upstream of the read path — the projection, the snapshot
renderer, the publisher, and the SPA source — is identical between the two, so
moving to Open is a rebuild with a different base and a `wrangler.jsonc` that
drops its `main`. Nothing has to be re-derived.

Do the steps in order — each one names the hostname or credential the next
depends on.

### 1. Create the bucket

An R2 bucket, `wrathbench-public`. Only projected JSON is ever uploaded, a
fraction of what a trajectory weighs, so the free tier (10 GB stored, 10M reads,
1M writes a month) covers the whole corpus many times over.

**Leave the Public Development URL disabled** — the bucket's settings call it
that; it is the `pub-<id>.r2.dev` hostname. In the Gated shape the Worker's
binding is the only path to an object, and enabling the development URL would
publish the whole bucket beside the gate rather than behind it. Check it is off
whenever you touch bucket settings, not just once.

### 2. Attach a custom domain — **Open shape only**

The CDN cache only fronts a bucket through a custom domain. Pick the data
hostname (`data.<zone>`) on a zone in the same account and attach it under the
bucket's public-access settings. Everything downstream names this hostname: the
cache rule, the CORS policy, and the SPA's build-time snapshot base.

In the Gated shape there is no data hostname. Skip to step 5.

### 3. Add the cache rule — **Open shape only**

Cloudflare does **not** cache JSON by default, and the rule also has to carry
the TTLs itself: Bun's S3 writer cannot send a `Cache-Control` header (the
publisher notes this at the top of `infra/publish-dashboard.ts`), so objects
land in the bucket without one and "respect origin" would respect nothing.
Two rules on the zone, first match wins:

1. `Hostname equals data.<zone> and URI Path is in {"/v1/manifest.json",
   "/v1/live.json"}` — eligible for cache, edge TTL **30s**, browser TTL
   **30s**. These are the two mutable files; worst-case staleness is the push
   cadence plus this TTL, about 90–120s.
2. `Hostname equals data.<zone>` — eligible for cache, edge TTL **1 year**,
   browser TTL **1 year**. Everything else is content-addressed and never
   rewritten, so a long TTL is safe by construction.

**A missing cache rule is the only way the Open shape costs money.** Without it
every public request is a billed read against the bucket — roughly $7/month at
30M requests, versus roughly $0 with the rule.

The Gated shape has no zone and therefore no cache rules, and does not need
them: `dashboard/worker/index.ts` sets the same TTLs as response headers on the
way out. They land in the browser cache rather than Cloudflare's, so a reader
who has never loaded the page still costs one bucket read. With a gate in front
and a handful of readers behind it, that is far inside the free tier — and
edge-caching a response that only some visitors are allowed to see is a footgun
best left unarmed.

### 4. Apply the CORS policy — **Open shape only**

`infra/cloudflare/r2-cors.json`, with its placeholder app origin edited to the
real hostname first:

```
bunx wrangler r2 bucket cors set wrathbench-public --file infra/cloudflare/r2-cors.json
```

The Gated shape serves the app and the data from one origin, so there is no
cross-origin request to permit and this file does not apply to it.

### 5. Mint two tokens

Least privilege, one job each, and neither can do the other's:

- **R2 Object Read & Write, scoped to `wrathbench-public` alone** — the
  publisher's, and the only Cloudflare credential that lives on the lab. It
  hands back an access key id and secret; put them in `.env` at the repository
  root as `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`. The account holds
  unrelated buckets, so the scoping is doing real work.
- **Workers Scripts Edit** — wherever `wrangler deploy` runs, as
  `CLOUDFLARE_API_TOKEN`. In the Gated shape add **Workers R2 Storage Read**,
  which is what lets the deploy bind the bucket; it still needs no object
  write.

A third, zone **Cache Purge**, is only wanted in the Open shape if the manifest
TTL is ever tightened by purging the two mutable URLs after each push. That is
not the current design — do not mint it now.

All of this runs on the **free plan**. The Gated shape invokes a Worker on
every request including static assets, which is 100k requests/day free; a
private preview is nowhere near it. Workers Paid ($5/month) is the cliff
insurance if that changes. The $20/month zone "Pro" plan is the wrong SKU
entirely: it is a zone plan and includes none of Workers, KV, D1 or R2.

### 6. Set the gate secret — **Gated shape only**

```
bunx wrangler secret put DASHBOARD_PASSWORD --config dashboard/wrangler.jsonc
```

Typed at the prompt, never in argv and never in the repository. The Worker fails
closed if it is unset — a deploy with no secret answers `503 gate not
configured` rather than serving the bucket to the internet — so set it before
the first deploy, not after.

Rotating it is the same command plus a redeploy; existing sessions die with it,
because the session cookie is derived from the secret rather than stored.

### 7. First publish, by hand

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
| `WRATHBENCH_FLEET_CONFIG` | `infra/fleet.json` | the roster names the models the pages label |
| `WRATHBENCH_PUBLISH_STATE` | `data/publish/state.json` | what was uploaded last, so a pass PUTs only what changed |
| `WRATHBENCH_PUBLISH_INTERVAL_MS` | `300000` | `--loop` cadence. Five minutes is a cost choice, not a freshness one — a pass writes ~24 objects regardless of cadence, so 60s measured ~1.2M R2 class-A ops/month against a 1M free tier and 300s is ~240k. The harness's own floor is 30–60s, so a faster push would buy little anyway |
| `WRATHBENCH_PUBLISH_BATCH` | `25` | runs projected before the pass uploads them and drops the bodies. The pass used to project the whole tree first, so what it held grew with the tree (~55 MB of artifacts at 1,016 runs); 25 bounds that. It does not lower the pass's peak RSS — 4.4 GB on that tree either way, which is the aggregate phase and the viewer handle's per-run caches rather than the artifacts (docs/FOLLOW-UPS.md item 121). 1 is legal and serializes the per-run reads |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | from step 5 | `.env`, never argv |
| `S3_BUCKET` | `wrathbench-public` | |
| `S3_ENDPOINT` | `https://<account-id>.r2.cloudflarestorage.com` | the account's R2 S3 endpoint — the S3 API, not a public hostname, and unchanged between the two shapes |

The four `S3_*` names are `Bun.S3Client`'s own, which is why they are not
spelled `WRATHBENCH_*` and why they come from `.env` rather than from
`compose.yml`.

Then read the bucket back before trusting the loop with it. In the Gated shape
the bucket has no public hostname to `curl`, so read it with
`bunx wrangler r2 object get` or the dashboard's object browser:

- `v1/manifest.json` exists, and every key its `artifacts` map names is in the
  bucket. The manifest is uploaded last precisely so this is never half true.
  (Each aggregate sits under its own content version since 2026-09-04, so the
  keys do not share a prefix; a manifest with no `artifacts` map is pre-#38 and
  its `gen` prefixes the whole set.)
- `v1/live.json` exists, and per-run objects are under `v1/run/<id>/<ver>/`.
  (Objects carry no `Cache-Control` metadata — Bun's S3 writer cannot send
  it — which is why the TTLs are set at the edge or by the Worker instead.)
- Nothing in the bucket is a raw trajectory entry, a scratchpad, or a
  filesystem path. The projection is an allowlist, so this should be true by
  construction — check it once anyway, because it is the legal boundary. A
  snapshot pass writes no tile either; those arrive only from the separate
  step below.

### 7a. Minimap tiles (optional, and never automatic)

The snapshot loop uploads JSON only. Tiles go up by hand, from a checkout with
`data/minimap` populated by the extraction in `minimap/`, and only when the
extraction has changed — the skip-unchanged check is a content hash kept in
`tiles/manifest.json` in the bucket, so a re-run with nothing new PUTs nothing.

```
bun infra/publish-tiles.ts --dry-run    # counts only, uploads nothing
bun infra/publish-tiles.ts --upload
```

It reads only `data/minimap/<mapId>/<row>_<col>.png` and writes only
`tiles/<mapId>/<row>_<col>.png` in the same bucket, with the same `S3_*`
credentials as the snapshot publisher (`WRATHBENCH_MINIMAP_DIR` overrides the
root). Both lines print uploaded / skipped / bytes. The gate serves what lands
there to authenticated readers only, `private, max-age=3600` and
`X-Robots-Tag: noindex`; nothing else under the prefix is reachable, and there
is no listing.

### 8. Start the loop, then deploy the SPA

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

The app is a separate deploy. In the **Gated** shape the data is same-origin, so
the snapshot base is a bare `/` — non-empty, which is what selects the snapshot
client, and the client appends `/v1/...` itself:

```
VITE_WRATHBENCH_SNAPSHOT_BASE=/ bun run --cwd dashboard build
bunx wrangler deploy --config dashboard/wrangler.jsonc
```

`wrangler` is a pinned devDependency (root `package.json`), so `bunx wrangler`
resolves to the version the lockfile names rather than whatever npm serves that
day — the same reason every other version here is pinned.

In the **Open** shape it is the data hostname, and the deploy is only ever a UI
change because data never moves through it:

```
VITE_WRATHBENCH_SNAPSHOT_BASE=https://data.<zone> bun run --cwd dashboard build
bunx wrangler deploy --config dashboard/wrangler.jsonc
```

That env var is what selects the snapshot client at build time, so the public
bundle and the private one (built without it, served same-origin by the viewer)
come off the same source with no runtime switch.

### 9. Verify

**Gated shape.** The first two checks are the ones that matter; run them from a
browser profile or a shell that has never held the cookie:

```
curl -si  https://wrathbench-dashboard.<subdomain>.workers.dev/            | head -1
curl -si  https://wrathbench-dashboard.<subdomain>.workers.dev/v1/manifest.json | head -1
curl -si "https://wrathbench-dashboard.<subdomain>.workers.dev/v1/manifest.json" -u ":$DASHBOARD_PASSWORD" | head -1
curl -sI  https://pub-<bucket-id>.r2.dev/v1/manifest.json                  | head -1
```

- Unauthenticated **`/`** answers `401` and a password form — not the app.
- Unauthenticated **`/v1/manifest.json`** answers `401` and JSON — not the
  manifest, and not the SPA's `index.html`. If it returns HTML, the Worker is
  not running first; check `run_worker_first` in `dashboard/wrangler.jsonc`.
- With the password, the manifest returns `200` and JSON.
- The `r2.dev` hostname does **not** resolve or answers `404`/error. If it
  serves the manifest, the Public Development URL is enabled — disable it (step
  1) before the link goes anywhere, because it is the gate's bypass.
- The shared link — `https://<app>/?k=<password>` — lands, redirects to `/`
  without the secret in the address bar, and renders.

**Open shape.** As before: the second `curl -sI https://data.<zone>/v1/manifest.json`
says `cf-cache-status: HIT`, and the headers show the rule's TTLs (30s on the
manifest, a year on a `v1/snap/<ver>/` object). A `MISS`, `DYNAMIC` or `BYPASS`
on the repeat means the cache rule from step 3 is not in effect; fix that before
anything else, because it is the one misconfiguration that bills. `cf-cache-status`
does not apply to the Gated shape and its absence there is not a fault.

**Both shapes**, once you are through the gate:

- The app loads and the runs, ladder, episodes, models, campaigns, run detail,
  fleet and map pages render. In the Open shape a CORS error in the console
  means the app origin in step 4 does not match the hostname the browser used —
  scheme included.
- The staleness banner reads a plausible age: a minute or two, never hours and
  never negative. Three clocks are in play (fleet heartbeat 30–60s, push 60s,
  and a TTL ≤60s) and the banner reads only the last push, so hours means the
  publisher stopped, not that a cache is cold.
- A run detail page shows no entries — the snapshot client answers `entries()`
  and `raw()` with the same 403 the viewer's public mode does, and there is no
  object in the bucket for it to fetch either way. If it ever shows content,
  stop the publisher: the content boundary has a hole.
- The map draws tiles where they have been uploaded (see "Minimap tiles"
  below) and the labelled grid everywhere else. Before that step has been run,
  every cell is a grid square and the tile requests 404; that is the normal
  state, not a fault.
