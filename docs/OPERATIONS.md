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

Recreating the worldserver kills every live session. Get to zero live runs
first:

1. Set every lane in `infra/fleet.json` to `"enabled": false`.
2. Wait until `./infra/run-fleet.sh --status` shows no lane with a live run —
   the lanes drain at their next episode boundary, so allow for an episode
   (up to 90 minutes) or `docker compose -f infra/compose.yml stop fleet` to
   cut it to the 30s graceful-termination path.
3. `docker compose -f infra/compose.yml up -d --no-deps worldserver` (this
   recreates it; it is the one time recreation is the point). `--no-deps` again:
   the `runner` container is where ad-hoc host episodes live, and it goes stale
   against its image every time `build fleet` retags `wrathbench/runner`, so a
   dependency sweep would recreate it and kill anything exec'd into it.
4. Re-enable the lanes, or `up -d --no-deps fleet` if you stopped the service.

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
