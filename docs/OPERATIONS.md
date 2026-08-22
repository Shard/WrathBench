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

One script, from the host:

```
./infra/deploy-worldserver.sh                  # promote wrathbench/worldserver:next
./infra/deploy-worldserver.sh --next-tag wrathbench/worldserver:mybuild
```

It refuses to run while any episode is live, tags the running image `:prev`,
promotes the new one to `:latest`, recreates the worldserver (`--no-deps`; the
one time recreation is the point), waits for the module to answer `/health`
ready, and then waits for the fleet's own preflight gate to record a pass
against the new server. On a smoke failure it retags `:prev`, recreates, and
exits non-zero. `--no-smoke` deploys unverified and says so; `--allow-live`
skips the refusal and kills whatever is running.

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
  "enabled": false,
  "account": "SMOKE",
  "smokes": ["infra/smoke/module-quest.ts", "infra/smoke/quest-status.ts"],
  "timeoutMs": 900000
}
```

The smokes run sequentially, as the given account, before the first lane is
spawned and again whenever the server identity changes — which is to say on
every worldserver recreate *and* on every restart the container does by itself.
A failure spawns nothing, complains once, and is re-checked every tick, so a fix
or a rollback unblocks the fleet with no operator action. Drains still work
while the gate is shut. `timeoutMs` is the budget for the whole sequence, not
per script. `./infra/run-fleet.sh --status` shows the last gate result;
`--dry-run` shows the plan. See
`docs/decisions/ADR-0023-preflight-gate-in-the-supervisor.md`.

Server identity is the worldserver's boot, read off the shared logs volume
(`data/logs/Server.log`'s creation time), plus a digest of `/health`'s stable
fields. Nothing keys on that string being unique — the deploy script keys on the
gate result's timestamp — so at worst a marker that fails to change costs an
extra smoke run.

**Arming it takes two one-time steps**, in this order, because an armed gate
pointed at an account the module does not permit parks the entire fleet on a
403:

1. Create the account:
   `docker compose -f infra/compose.yml run --rm --no-deps -e WRATHBENCH_ACCOUNT_USER=SMOKE -e WRATHBENCH_ACCOUNT_PASSWORD=SMOKE bootstrap`
2. Recreate the worldserver so it picks up `SMOKE` in `AC_WRATH_BENCH_ACCOUNTS`
   (it is already in `infra/compose.yml`) — i.e. the next deploy window.

Then flip `"enabled": true`. The gate account must be its own: sharing it with
an enabled lane is refused as a config error, and it is never `PROBE`, which is
the ad-hoc debugging account.

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
