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

Two enabled lanes must not share an account, and lane policy (claude models on
the claude-subscription driver only; shared free pools carry free ids only) is
enforced on every re-read.

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
    { "script": "infra/smoke/kill-credit.ts", "account": "SMOKE2" }
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
  run in order. A bare string entry means "on `account`". The two shipped
  smokes split the old arc's claims without losing one:
  `quest-accept-status.ts` (login, questgiver status, quest query, accept,
  the served quest-log complete state, turn-in reward chain, XP, vendor list,
  ~20s) and `kill-credit.ts` (one kobold: attack stream, kill credit, loot
  round trip, ~42s). Both delete the previous run's character first (the
  CMSG_CHAR_DELETE proof) and only log out at the end, because a disconnected
  character stays in world for the core's 60s `WorldSession::expireTime`
  during which a delete is silently ignored — deleting last time's character
  costs nothing, deleting this time's costs a minute.
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
smokes to `SMOKE` (sequential, ~62s, `timeoutMs` 190000). After the recreate,
flip `kill-credit.ts` to `SMOKE2` and `timeoutMs` to 130000 for the parallel
~42s gate. Never before: a smoke bound to an unpermitted account gets 403
`account_not_permitted`, the gate fails, and no lane spawns until it is fixed.
The order of operations at that drain window is therefore: recreate the
worldserver, then restart the fleet (which is also what picks up the new
supervisor code — a running supervisor rejects the `{ script, account }` entry
shape and keeps its last good config until restarted).

The gate accounts must be their own: sharing one with an enabled lane is refused
as a config error (every per-entry account is checked), and none is ever
`PROBE`, the ad-hoc debugging account.

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
