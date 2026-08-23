# Operations

How to run the harness day to day. Architecture is in `docs/ARCHITECTURE.md`;
what the agent may see and do is `docs/CONTRACTS.md`. Bringing the stack up on
a fresh machine is `infra/README.md`.

## Running the fleet as a service

The fleet supervisor (`infra/run-fleet.ts`) is a compose service. It is up
while the dev machine is up, it has no deadline, and it is steered entirely by
editing `infra/fleet.json` — which it re-reads every 60 seconds. See
`docs/decisions/ADR-0020-fleet-as-a-service.md` for why it lives inside the
runner image rather than on the host.

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

Edit `infra/fleet.json`. Nothing to restart. The unit you steer is the **job**
(ADR-0034): a roster entry (or a rotation of several), an episode tier, a
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
pool, and the roster policy (claude models on the claude-code driver only — the
claude-code harness, ADR-0035; shared free pools carry free ids only) is
enforced on every roster entry at every re-read.

#### Config reference (`infra/fleet.json`)

```
preflight   the gate (ADR-0023): enabled, account, smokes [{script, account}], timeoutMs,
            deploySmokes, deployTimeoutMs. Its accounts may not be in the pool or on a job.
accounts    { pool: [...], paid: [...], local: [...] } — the account classes (ADR-0034), each in
            preference order. Never PROBE, never SMOKE*. `pinned` is derived from the jobs and
            refused if authored.
roster      name -> entry, the exact run-roster per-entry schema (model, driver, effort, apiBase,
            apiKeyEnv, character, race, class, objective, watchdogs, maxToolCalls, wikiCoords).
            Never an account. Optional scheduling fields: `tiers` (a manual FORCE into a tier;
            normally absent — e360 is earned) and `runsPerEpisode {e90, e360}` (per-entry target).
policy      runsPerEpisode {e90, e360} targets (default 3/3); maxConcurrent { <driver>: n } caps
            the streams the policy may have in flight per driver, counting every job on that
            driver, pinned ones included (`"claude-code": 2` today: the probe plus one sonnet).
            Optional, off when absent (ADR-0034 amendment): `paid { runsPerEpisode {e90 3, e360 1},
            maxConcurrent 1 }` — paid models get those hard targets and at most that many in
            flight across the pool; `extras { characters [{race, class}, ...] }` — free models
            past their targets get extra runs when the pool is idle, cycling those characters
            (default: a short Alliance level-1 list). `{}` for either takes the defaults.
            Billing is derived per model (free slug / LAN apiBase / claude-code / allowlist ->
            free, else paid); `roster.<name>.billing: "free"|"paid"` overrides it.
queue       jobs, in priority order: { ref | [refs], episode e90|e360|freeplay, repeat n|"loop",
            enabled, account? }. With `account` the job is PINNED to it and never the policy's;
            without, it is a manual pool job that outranks the policy. The name is always
            `<first ref>-<episode>` (run ids `fleet-<name>-<model>[-<effort>]-<stamp>`), one job
            per (ref, episode). A pool job whose ref is not eligible for its tier is skipped with
            the reason in --status; a pinned one waits the same way.
```

A roster entry referenced by a pinned job, or carrying an `objective`, is never
policy-scheduled: the account is spoken for, and a probe's runs are not the
model's evidence. Everything else in the roster is the policy's (below). This
is the only shape: a file that still says `lanes` or `accounts.pinned` is
refused by name, with the message naming the 0.4 keys.

### Stop it

```
docker compose -f infra/compose.yml stop fleet
```

A stop **pauses** the live runs, it does not cost them (ADR-0036). SIGTERM
reaches the supervisor, which SIGTERMs each job's roster, which SIGTERMs the
runner; the runner pauses its run as `operator-pause`: the episode clock stops
(the minutes spent so far are written to meta.json and the budget resumes from
there), the request or tool call in flight is abandoned, the game session is
logged out so the account is free, and the run is marked paused — not
terminated, not counted, not a ladder failure. The roster records
`paused-operator` and exits; the supervisor waits for every roster (polling
every 2s while stopping) and exits. The runner's own backstop is 60s, the
roster's SIGKILL grace 90s, the service's `stop_grace_period` 180s, in that
order. The next `up -d` resumes the paused runs before it launches anything
fresh (below). Ctrl-C on a hand-started `infra/run-episode.sh` still ends the
run as `manual`: SIGINT is the operator's cut, SIGTERM is the supervisor's
pause.

To stop launching *without* pausing what is running, set every job to
`"enabled": false` and wait for `--status` to go quiet. The supervisor does not exit when it runs out of
work — with no deadline it idles (logging so once) and waits for the config to
give it something, because exiting under `restart: unless-stopped` would just
restart it a minute later with a new epoch.

`docker compose rm fleet` afterwards if you want the container gone; the state
in `data/runs/` is what matters and it is on the bind mount.

### Roll the epoch / pick up code changes

The date stamp in run ids (`fleet-<job>-<model>-<YYYYMMDD>`) is taken once at
supervisor start and stays fixed for the life of the process — it is an *epoch*,
not a calendar date, so that `--resume-roster` and the loop's `-cN` numbering
keep meaning what they meant. A supervisor up for three days still stamps the
day it started. To roll it — and to pick up edits to `run-fleet.ts`,
`run-roster.ts` or the runner image:

```
docker compose -f infra/compose.yml stop fleet          # runs pause
docker compose -f infra/compose.yml build fleet         # only if the image changed
docker compose -f infra/compose.yml up -d --no-deps fleet   # runs resume, then the pool fills
```

The restart procedure is therefore **stop → (runs pause) → start → (runs
resume)**. On boot, before the queue or the policy spawns anything, the
supervisor finds every paused run whose model and tier are still in
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
cooling is over — see "Paused runs" below.

Note that `restart: unless-stopped` also rolls the epoch on its own after a
crash or a machine reboot, so run ids change there too; resumes do not care
about the epoch (the run id is read from disk).

### Paused runs

`--status` shows a paused run on its account as `paused (reason, Xm elapsed
of Ym) — <run id> Lx xp`, then a `paused runs not resumed` block for every
paused run the supervisor is not resuming right now, with why:

- **not in config** — the model or tier is gone from `fleet.json` (or the
  pinned job is disabled, or on another account). Resume it by hand
  (`infra/run-episode.sh --resume <run id>` on its account) or archive it.
- **stale** — paused longer than twice its own budget (a run with no wall
  clock uses 6h). Not auto-resumed; by hand or archive.
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
run … — resumed by the supervisor, never rescheduled`, so no second attempt
starts for that model. A paused run counts toward nothing until it finally
ends.

### Deploy window (worldserver changes)

Two scripts, from the host:

```
./infra/build-worldserver.sh                   # build wrathbench/worldserver:next, stamped
./infra/deploy-worldserver.sh                  # promote wrathbench/worldserver:next
./infra/deploy-worldserver.sh --next-tag wrathbench/worldserver:mybuild
```

The build script stamps the image with this checkout's
`git describe --tags --always --dirty` (docker build-arg `WRATHBENCH_BUILD`),
which the module serves as `/health.build` alongside `startedAtMs`; the fleet
gate, `run-fleet --status` and the viewer's `/api/info` name the server by it.
Commit before building so the stamp names a commit rather than `-dirty`. A
bare `docker compose build worldserver` without `WRATHBENCH_BUILD` in the
environment produces an image that reports `"unknown"`.

It refuses to run while any episode is live, tags the running image `:prev`,
promotes the new one to `:latest`, recreates the worldserver (`--no-deps`; the
one time recreation is the point), waits for the module to answer `/health`
ready, and then waits for the fleet's own preflight gate to record a pass
against the new server. On a smoke failure it retags `:prev`, recreates, and
exits non-zero. `--no-smoke` deploys unverified and says so; `--allow-live`
skips the refusal and kills whatever is running.

`--dry-run` prints the plan and every resolved value — which config and state
files it will read, the rollback target, the preflight account, budget and
smoke list, whether the fleet supervisor is gating, and which verification path
it would take — and executes nothing. Run it first if the deploy window
matters; it is read-only and safe while the fleet is up.

Verification is **fail-closed**: the closing line names what verified the
deploy (`DEPLOYED and verified by fleet gate` or `by N direct smoke(s)`), and
it can only be reached by a step that actually ran and exited zero. Each direct
smoke logs its start, its duration and its exit code. Anything else — a failed
smoke, a failing gate record, an unexpected error anywhere after the promote —
rolls back and exits non-zero. The two paths that verify nothing say
`DEPLOYED UNVERIFIED` and never `verified`: `--no-smoke` (exit 0, you asked for
it) and an enabled preflight with no `smokes` configured (exit 1, you did not).

"Is the supervisor gating?" needs both halves: the `fleet` container running
*and* a heartbeat newer than 180s. A stopped fleet leaves a fresh heartbeat
behind for three minutes, and trusting it alone is what produced the incident
below.

`infra/deploy-worldserver.test.ts` covers this without a daemon: it runs the
real script with `docker` replaced by a PATH shim, under `FORCE_COLOR=3`, and
asserts the rollback branch and the exit codes.

Getting to zero live runs is still yours to do, and it is the same drain as
ever: set every job in `infra/fleet.json` to `"enabled": false` and wait until
`./infra/run-fleet.sh --status` shows no account with a live run (an episode can
take up to 90 minutes; `docker compose -f infra/compose.yml stop fleet` pauses
them instead, and they resume on the next start). `./infra/run-fleet.sh --live-runs` is the same check
the script uses — it lists live episodes and exits non-zero if there are any.
Re-enable the jobs afterwards.

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

There are two tiers (ADR-0023, amended 2026-08-23):

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

In order: the REJECTED banner when the file is not in effect; the supervisor
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
(`+2sb` is two stillborn attempts), extras made, and `yes: …`/`no: …` for
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

The pattern, from the 2026-08-23 switch to the job shape (ADR-0034 amendment):
ship the new file as a sibling (`infra/fleet.next.json`), drain or `stop fleet`
(running episodes pause and resume on start, ADR-0036), rename it over
`fleet.json`, check `--dry-run` from the new code before anything spawns, then
`up -d --no-deps fleet`. The new file under the old code is the one thing that
must not happen, which is why it ships as a sibling. A shape the current code
does not read is refused by name — there is no compatibility read, so roll
back by renaming the old file back. Run ids carry the job name, so a renamed
job starts a fresh id; nothing resumes across the rename.

### The scheduling policy (ADR-0034)

With the job shape the `queue` normally holds only the pinned jobs: the
supervisor fills free pool accounts from the roster by policy — three runs per
(model, episode), `e90` for everyone, `e360` once earned, newest-to-the-roster
first, shorter episode first, fewest runs first, one stream per model, within
`policy.maxConcurrent` per driver. Only runs from the running checkout's
harness **series** (`0.3` of `harness-0.3-114-g…`) count; a minor bump starts
every model's evidence over, a fix commit does not. With `policy.paid` set,
paid models (derived, see the config reference) get hard targets of 3/1 and
share a one-in-flight cap; with `policy.extras` set, free models past their
targets get extra runs — stamped `extra: true`, an attempt but never counted —
with the next race/class in the cycle, once nothing else is schedulable.
Everything it decides is derived from `data/runs/` each tick; nothing is
stored except an operator's clear.

```
./infra/run-fleet.sh infra/fleet.json --status      # models table: status, counted/target per episode, why (not) schedulable
./infra/run-fleet.sh infra/fleet.json --dry-run     # the picks the policy would make for the free accounts right now
./infra/run-fleet.sh --clear-model <roster-name>    # forgive a retired/cooling model; picked up on the next tick
```

What the status words mean: `new` has no counted run yet; `active` is working
toward its `e90` target; `promoted` may also be scheduled on `e360`; `cooling`
is on the defer ladder (`1m … 6h`) after consecutive stillborn or
`adapter-error` attempts; `retired` failed once more at the 6h ceiling and will
not be scheduled until cleared; `pinned` is outside the policy (a pinned ref or
a probe). A stillborn run never counts toward a target but does climb the
ladder, so a dead provider costs at most ten launches over ~10 hours before it
is retired. A manual pool job (`queue` entry without an account) always
outranks the policy; add one to force a specific run (an `e360` for an
unpromoted model needs `tiers: ["e360"]` on its roster entry as well). Targets:
`policy.runsPerEpisode` for the fleet, `roster.<name>.runsPerEpisode` per entry.

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

### Stillborn runs, and archiving them

A run that never produced a single model response is **stillborn**: the
provider was dead on the first request, the key was refused, the adapter threw
before a turn existed. It never got off the ground and it never will, so the
dashboard hides such runs by default — the runs list, the eval and ladder
charts, and the episode member counts all exclude them, and each surface says
how many it is hiding. `show stillborn (N)` reveals them greyed; the API takes
`?includeStillborn=1` on `/api/runs`, `/api/eval` and `/api/ladder`.

They still sit in `data/runs`. To park them:

```
bun runner/src/archive.ts --stillborn --dry-run   # list what would move, and why
bun runner/src/archive.ts --stillborn             # move them
```

Directories move to `data/runs/archive/<run-id>/` — nothing is deleted, and the
viewer never reads inside `archive/`. A run the fleet may still be holding is
refused with the reason rather than moved: its own files written inside the
last ten minutes, a `run.ts` process naming it, or a fleet job jsonl naming it
inside the same window. Run the dry-run first; a live run is the one thing
this must not touch.

```
bun runner/src/archive.ts --pre-series 0.4 --dry-run            # everything below the harness-0.4 floor
bun runner/src/archive.ts --pre-series 0.4 --release-paused     # ...including parked runs nobody holds
```

`--pre-series` parks every run whose recorded harness version is not a clean
build of the series — an older series, a `-dirty` build, or no `harness-` tag
at all. `--release-paused` lets a run through the activity hold when its meta
records a pause and no `run.ts` process names it: a supervisor retrying a
paused run rewrites its files every few minutes, which would hold it forever.

### Secrets

`.env` at the repo root, never argv. Bun loads `/wrathbench/.env` inside the
container — in the supervisor and again in every child — so keys reach the
runner without appearing in `ps` or in the compose file. A claude-code
job needs `CLAUDE_CODE_OAUTH_TOKEN` there (`claude setup-token`); without it
the roster refuses the episode with a `launch-failed` row rather than burning a
session.

### Harness version stamping

Every episode is stamped with `git describe --tags --always --dirty`, computed
at launch. On the host `run-episode.sh` does it; in the container `run-roster`
does it, using the `git` in the runner image against the bind-mounted `.git`.
A dirty tree stamps `-dirty` either way — that is the point, and it is why the
stamp is not a file written once at `up` time.
