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
tail -f data/runs/fleet-<lane>-<stamp>.log             # one lane's roster stdout
```

`--status` works from the host even though the supervisor is in a container: it
reads `data/runs/fleet-state.json`, and liveness comes from a heartbeat the
supervisor refreshes each tick, not from a pid probe that would mean nothing
across the namespace. A supervisor that has been gone for more than three ticks
reports `NOT RUNNING`.

### Steer it

Edit `infra/fleet.json`. Nothing to restart.

- `"enabled": false` — the lane **drains**: no signal while it has an episode in
  flight, SIGTERM at the next episode boundary. Worst case a just-started
  episode is terminated gracefully; never a corrupted one.
- `"enabled": true`, or a brand-new lane — spawned on the next tick.
- A malformed edit is complained about and ignored; the last good config keeps
  running. Check it first if you like:
  `docker compose -f infra/compose.yml run --rm --no-deps fleet bun infra/run-fleet.ts infra/fleet.json --dry-run`
- While the file is rejected, **every `enabled` flag in it is inert** — including
  a later, valid-looking edit disabling a lane, which the supervisor never sees
  because it never gets past the parse. `--status` leads with a banner
  (`!! fleet.json REJECTED since …`) and marks each lane's `enabled=` as
  `(FILE, NOT in effect)` until a re-read succeeds. The banner comes from the
  supervisor's own state file, not from parsing the config here: the two can be
  different versions of the code, and the supervisor's verdict is the one that
  decides what runs. Trust the banner over your own reading of the file.

Two enabled lanes must not share an account, and lane policy (claude models on
the claude-subscription driver only; shared free pools carry free ids only) is
enforced on every re-read. Under the pool/queue shape (ADR-0031, below) the
same applies to pinned lanes, and queue jobs are steered the same way.

### Stop it

```
docker compose -f infra/compose.yml stop fleet
```

This is a **drain**, not a kill: SIGTERM reaches the supervisor, which SIGTERMs
each lane, each of which terminates its episode gracefully (30s of grace) —
which is why the service has a 180s stop grace period. To stop launching
*without* killing what is running, set every lane to `"enabled": false` and wait
for `--status` to go quiet. The supervisor does not exit when it runs out of
work — with no deadline it idles (logging so once) and waits for the config to
give it something, because exiting under `restart: unless-stopped` would just
restart it a minute later with a new epoch.

`docker compose rm fleet` afterwards if you want the container gone; the state
in `data/runs/` is what matters and it is on the bind mount.

### Roll the epoch / pick up code changes

The date stamp in run ids (`fleet-<lane>-<model>-<YYYYMMDD>`) is taken once at
supervisor start and stays fixed for the life of the process — it is an *epoch*,
not a calendar date, so that `--resume-roster` and the loop's `-cN` numbering
keep meaning what they meant. A supervisor up for three days still stamps the
day it started. To roll it — and to pick up edits to `run-fleet.ts`,
`run-roster.ts` or the runner image:

```
docker compose -f infra/compose.yml stop fleet          # drains
docker compose -f infra/compose.yml build fleet         # only if the image changed
docker compose -f infra/compose.yml up -d --no-deps fleet
```

Note that `restart: unless-stopped` also rolls the epoch on its own after a
crash or a machine reboot, so run ids change there too.

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
ever: set every lane in `infra/fleet.json` to `"enabled": false` and wait until
`./infra/run-fleet.sh --status` shows no lane with a live run (an episode can
take up to 90 minutes; `docker compose -f infra/compose.yml stop fleet` cuts it
to the 30s graceful path). `./infra/run-fleet.sh --live-runs` is the same check
the script uses — it lists live episodes and exits non-zero if there are any.
Re-enable the lanes afterwards.

### The preflight gate

The supervisor smokes the server before it launches anything. The knob is the
top-level `preflight` block in `infra/fleet.json`, hot-reloaded like the lanes:

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

- **`smokes` is the per-tick gate.** It runs before the first lane is spawned
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
`account_not_permitted`, the gate fails, and no lane spawns until it is fixed.
The order of operations at that drain window is therefore: recreate the
worldserver, then restart the fleet (which is also what picks up the new
supervisor code — a running supervisor rejects the `{ script, account }` entry
shape and keeps its last good config until restarted).

The gate accounts must be their own: sharing one with an enabled lane is refused
as a config error (every per-entry account is checked), and none is ever
`PROBE`, the ad-hoc debugging account.

### Switching to the pool/queue shape (ADR-0031)

`infra/fleet.next.json` is today's fleet under the new schema: lanes no longer
own accounts; `accounts.pinned` keeps nav-probe on SHAKEOUT, `accounts.pool`
holds RUNNER–RUNNER6, and the free/local models are a `roster` the scheduling
policy (ADR-0032) runs on whichever pool account is free; `queue` is for manual
overrides. The supervisor that is running today rejects
that shape (it keeps its last good config and complains), so the switch is done
at a drain window, in this order:

```
# 1. drain: park every lane, wait for --status to show no live run
#    (or `stop fleet`, which cuts a running episode to the 30s graceful path)
docker compose -f infra/compose.yml stop fleet

# 2. swap the file (keep the old one: the new code loads either shape)
git mv -f infra/fleet.json infra/fleet.prev.json      # or plain mv if you prefer
git mv infra/fleet.next.json infra/fleet.json

# 3. check the plan from the new code before anything spawns
docker compose -f infra/compose.yml run --rm --no-deps fleet bun infra/run-fleet.ts infra/fleet.json --dry-run

# 4. start the supervisor on the new code (this is also what picks up run-fleet.ts)
docker compose -f infra/compose.yml up -d --no-deps fleet
./infra/run-fleet.sh --status
```

Steps 2 and 4 commute: a new-code supervisor started against the old file runs
it as "every lane pinned, empty queue", and a later rename is picked up on the
next 60s re-read like any other edit. What must not happen is the reverse —
the new file under the old code — which is why the file ships as a sibling.
Roll back by renaming `fleet.prev.json` back; nothing else changes.

Steering under the new shape, all hot-reloaded:

- A job's `enabled: false` drains it at the next episode boundary and frees its
  pool account; deleting it from the queue does the same. Re-enabling a job
  that finished (exit 0) is the rearm, as for a lane.
- Promotion into `e360` is automatic (ADR-0032): one counted `e90` run that
  reached level 5. `roster.<name>.tiers` is only a manual force. A manual job
  whose episode a ref is not eligible for is skipped with the reason in
  `--status` and the fleet log, never run.

### The scheduling policy (ADR-0032)

With the pool shape the `queue` is normally empty: the supervisor fills free
pool accounts from the roster by policy — three runs per (model, episode),
`e90` for everyone, `e360` once earned, newest-to-the-roster first, shorter
episode first, fewest runs first. Everything it decides is derived from
`data/runs/` each tick; nothing is stored except an operator's clear.

```
./infra/run-fleet.sh infra/fleet.json --status      # per-model block: status, counted/target per episode, why (not) schedulable
./infra/run-fleet.sh infra/fleet.json --dry-run     # the picks the policy would make for the free accounts right now
./infra/run-fleet.sh --clear-model <roster-name>    # forgive a retired/cooling model; picked up on the next tick
```

What the status words mean: `new` has no counted run yet; `active` is working
toward its `e90` target; `promoted` may also be scheduled on `e360`; `cooling`
is on the defer ladder (`1m … 6h`) after consecutive stillborn or
`adapter-error` attempts; `retired` failed once more at the 6h ceiling and will
not be scheduled until cleared. A stillborn run never counts toward a target
but does climb the ladder, so a dead provider costs at most ten launches over
~10 hours before it is retired. A manual `queue` entry always outranks the
policy; add one to force a specific run (an `e360` for an unpromoted model
needs `tiers: ["e360"]` on its roster entry as well). Targets: `policy.runsPerEpisode`
for the fleet, `roster.<name>.runsPerEpisode` per entry.
- Queue order is priority: with six pool accounts the first six runnable loop
  jobs are the fleet and the rest wait. `--dry-run` prints what would spawn now.
- `--status` shows each account (pinned -> lane, or pool -> job / free) and the
  queue (running, waiting, finished, skipped with reason).

### Ad-hoc launches still work

Nothing about the host path changed. One episode:

```
./infra/run-episode.sh --model <id> [--driver openai|claude-subscription]
```

One roster, or a whole fleet, from the host:

```
./infra/run-roster.sh infra/roster-example.json --until 07:30
./infra/run-fleet.sh infra/fleet.json --until 18:00
```

Do not run a host supervisor against `infra/fleet.json` while the `fleet`
service is up: they would both spawn lanes on the same accounts.

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
last ten minutes, or a fleet lane jsonl naming it inside the same window. Run
the dry-run first; a live lane is the one thing this must not touch.

### Secrets

`.env` at the repo root, never argv. Bun loads `/wrathbench/.env` inside the
container — in the supervisor and again in every child — so keys reach the
runner without appearing in `ps` or in the compose file. A claude-subscription
lane needs `CLAUDE_CODE_OAUTH_TOKEN` there (`claude setup-token`); without it
the roster refuses the episode with a `launch-failed` row rather than burning a
session.

### Harness version stamping

Every episode is stamped with `git describe --tags --always --dirty`, computed
at launch. On the host `run-episode.sh` does it; in the container `run-roster`
does it, using the `git` in the runner image against the bind-mounted `.git`.
A dirty tree stamps `-dirty` either way — that is the point, and it is why the
stamp is not a file written once at `up` time.
