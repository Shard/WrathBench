# Operations

How to run the harness day to day. Architecture is in `docs/ARCHITECTURE.md`;
what the agent may see and do is `docs/CONTRACTS.md`. Bringing the stack up on
a fresh machine is `infra/README.md`.

## Running the fleet as a service

The fleet supervisor (`infra/run-fleet.ts`) is a compose service. It is up
while the dev machine is up, it has no deadline, and it is steered entirely by
editing `infra/fleet.json` — which it re-reads every 60 seconds. It lives
inside the runner image rather than on the host so it survives the operator's
shell and reboots, never crosses the container boundary to spawn a runner,
and is one step from the intended Helm shape.

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
  when an account is free).
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
the claude-code harness; shared free pools carry free ids only) is
enforced on every roster entry at every re-read.

#### Config reference (`infra/fleet.next.json`)

Shipped as a sibling file while 0.5 lands; whoever asks for `fleet.json` is
handed `fleet.next.json` when one is beside it (`preferNextConfig`), so the
running supervisor keeps its config until it restarts and the rename commutes.

```
preflight   the gate (below): enabled, account, smokes [{script, account}], timeoutMs,
            deploySmokes, deployTimeoutMs. Its accounts may not be in the pool or on a job.
accounts    { pool: [...], paid: [...], local: [...] } — the account classes, each in
            preference order. Never PROBE, never SMOKE*. `pinned` is derived from the jobs and
            refused if authored.
roster      name -> entry, the exact run-roster per-entry schema (model, driver, effort, apiBase,
            apiKeyEnv, race, class, objective, watchdogs, maxToolCalls, wikiCoords).
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
              what a paid model wants) or `unlimited` (one freeplay session at a time, capped at
              6h on every class). Never bought by omission. A race/class sweep is a campaign now,
              not an idle mode.
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
            cells [{ id, race?, class?, objective?, ... }], account?, objective?,
            wikiCoords?, watchdogs?, maxToolCalls? } }. Every run is an unscored `probing`
            episode; the campaign owns its whole task shape, so a catalog entry's own objective
            or leash never leaks into one. Precedence: episode defaults < campaign < cell.
            With `account` the campaign is PINNED to it and follows the pinned-job account rules;
            without, the policy schedules it between the evals and the idle work. Completion is
            DERIVED (cells x models x runsPerCell against the counted probe runs on disk) — set
            `enabled: false` when a sweep is done and its results stay visible. Progress is on
            the /campaigns page.
queue       jobs, in priority order: { ref | [refs], episode e90|e360|freeplay, repeat n|"loop",
            enabled, account? }. With `account` the job is PINNED to it and never the policy's;
            without, it is a manual pool job that outranks the policy. The name is always
            `<first ref>-<episode>` (run ids `fleet-<name>-<model>[-<effort>]-<stamp>`), one job
            per (ref, episode). A pool job whose ref is not eligible for its EPISODE is skipped
            with the reason in --status; a pinned one waits the same way. A waiting manual job
            reserves the POOL only — the paid and local classes still pick, and the reservation
            is named in --status.
```

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
| `infra/run-fleet.ts`, `infra/run-roster.ts`, the runner **image**, compose env | only when the **`fleet` container's process restarts**. That is what the two recipes below are for. |

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

It sets the **pause switch**, waits for every live run to end on its own clock,
recreates the container on the new code, waits for the new supervisor's first
heartbeat, and clears the switch. Nothing is signalled and no attempt is spent.

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

Two costs, both printed by the script:

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

Ctrl-C during the wait is safe: nothing has been signalled, the switch stays
set, and `./infra/fleet-update.sh resume` puts the fleet back to work.

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
  off on the same account and character.
- a preflight smoke in flight dies with the container; the gate re-runs it.

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
session is ended too, and the next tick starts a fresh one. A run the fleet did
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
  paused. This is how FOLLOW-UPS 43 is answered: the roster retries a
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
block when the file IS in effect but the account rules disabled a pin in it
(item 66 — an enabled job or campaign on a listed account, or a second one on
an account already taken, is refused by name rather than taking the whole file
down with it); the supervisor
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
`idle: "unlimited"` takes one capped freeplay session at a time once its
targets are met, stamped `extra: true` — an attempt but never counted.
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
./infra/run-episode.sh --model <id> [--driver openai|claude-code]
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

The CLI parks runs for the other reason, the comparability floor:

```
bun runner/src/archive.ts --pre-series 0.4 --dry-run            # everything below the harness-0.4 floor
bun runner/src/archive.ts --pre-series 0.4 --release-paused     # ...including parked runs nobody holds
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

### Secrets

`.env` at the repo root, never argv. Bun loads `/wrathbench/.env` inside the
container — in the supervisor and again in every child — so keys reach the
runner without appearing in `ps` or in the compose file. A claude-code
job needs the token of the lane it was scheduled on there (`claude setup-token`)
— `CLAUDE_CODE_OAUTH_TOKEN`, or `CLAUDE_CODE_OAUTH_TOKEN_2` for the second
subscription; without it the roster refuses the episode with a `launch-failed`
row naming that variable, rather than burning a session.

### Harness version stamping

Every episode is stamped with `git describe --tags --always --dirty`, computed
at launch. On the host `run-episode.sh` does it; in the container `run-roster`
does it, using the `git` in the runner image against the bind-mounted `.git`.
A dirty tree stamps `-dirty` either way — that is the point, and it is why the
stamp is not a file written once at `up` time.
