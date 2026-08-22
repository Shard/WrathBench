# ADR-0023: The deploy-window smoke is a supervisor gate, not a deploy step

Date: 2026-08-22. Status: accepted.

## Context

Deploying a new worldserver image was a documented manual sequence: drain the
lanes, recreate the container, run a smoke by hand if you remembered, re-enable
the lanes. The remembering is the problem. A worldserver that boots and answers
`/health` can still be unable to drive a quest arc end to end — a module change
that drops an action, a missing DBC, a stale map volume — and the first thing to
discover it is otherwise a model, hours later, in a trajectory nobody is
watching. Every episode launched in between is spent.

The recreate also has a second trigger nobody types: `restart: unless-stopped`.
A crashed worldserver comes back on its own, and the fleet spawns straight into
it.

## Decision

**The smoke moves into the supervisor, as a gate on spawning.** `infra/fleet.json`
grows a top-level `preflight` block — `enabled`, `account`, `smokes`, `timeoutMs`
— hot-reloaded exactly like the lanes. Before it spawns any lane, and again
whenever the server it is pointed at is no longer the same server, the
supervisor runs the configured smokes sequentially as child processes and
records the result in `data/runs/fleet-state.json`. Lanes spawn only after a
pass.

Three properties matter more than the mechanism:

- **A failure blocks spawning and re-checks every tick.** No lane is launched
  into a broken world, and a fix or a rollback unblocks the fleet with no
  operator action. The complaint is logged once per server identity, not once a
  minute.
- **Only `start` is suppressed.** Drains, undrains and rearms keep working while
  the gate is shut: an operator must always be able to park a lane during a bad
  deploy.
- **`enabled: false` is a first-class state.** It records a `skipped` entry and
  opens the gate. The mechanism ships installed and disarmed; arming it is one
  line of config.

**Server identity is the world's boot, not an image id.** The module's `/health`
tells non-loopback callers liveness only — no build id, no uptime — and the
supervisor is a container with no docker socket, so it cannot ask the daemon
what image the worldserver is running. What it does share with the worldserver
is the logs volume, where a boot is plainly visible: the appender rotates the
previous `Server.log` aside and creates a new one, so the live file's creation
time changes on every boot and on every recreate. Identity is that marker plus a
digest of `/health`'s stable fields (so a module whose health surface changes
also re-gates).

This is weaker than an image id, and it is allowed to be, because **nothing
downstream trusts the identity string**: the deploy script keys on the recorded
*timestamp* of a gate result, never on matching an identity. A marker that fails
to change can therefore only ever cost an extra smoke run; it can never
greenlight an unsmoked server. For the same reason an unreadable log volume
yields a marker that changes on its own every ten minutes — the gate fails
toward re-running the smokes, never toward a frozen "already smoked".

**`infra/deploy-worldserver.sh` is the deploy, and it verifies.** It refuses to
run while any episode is live (the same account-busy signal `--status` reports,
via a new `--live-runs` flag whose exit code carries the answer), tags
`:latest` aside as `:prev`, promotes `:next`, recreates with `--no-deps`, waits
for health, and then waits for the *supervisor's* gate result on the new server.
If none appears within the grace window — a supervisor that predates this gate,
or one with preflight disabled — it runs the same smokes itself through
`docker compose exec runner`. On failure it retags `:prev` and recreates. The
manual sequence in docs/OPERATIONS.md is replaced by the script.

**The gate gets its own account, `SMOKE`.** A smoke holds a live session for its
whole arc, so sharing an account with an enabled lane would mean the two
reclaiming it from each other; `parseFleet` refuses that config outright. It is
not `PROBE` either: `PROBE` is the ad-hoc debugging account and a gate that
fights an operator's live probe is worse than no gate. `SMOKE` is added to
`AC_WRATH_BENCH_ACCOUNTS` in compose, which takes effect at the next worldserver
recreate — i.e. at the next deploy window — and the account itself is a one-time
`bootstrap` run. Until both are done the block ships `enabled: false`, because an
armed gate pointed at an unpermitted account would park the entire fleet on a
403.

## Alternatives considered

- *A build id in `/health`.* The honest identity, and the right long-term answer
  (FOLLOW-UPS). Rejected for now because it needs a module change plus a
  worldserver rebuild and recreate to become true of the running server, and the
  boot marker makes it unnecessary for the gate's actual job.
- *Gate in the deploy script only.* Covers the deploy a human types and misses
  every restart the container does by itself, which is the case that spends
  episodes silently.
- *Gate per episode, in run-roster.* A 5–10 minute smoke before every episode is
  a tax on the thing being measured, and the answer only changes when the server
  changes.

## Consequences

- A live supervisor picks the gate up only on restart (`stop fleet` /
  `up -d --no-deps fleet`), which is the same drain the deploy window already
  requires. Until then it runs old code and writes no gate record — which is
  exactly the case `deploy-worldserver.sh` falls through to smoking directly.
- With preflight armed, a worldserver crash-restart costs one smoke run before
  lanes resume. That is the intended price.
- A timed-out smoke can leak its module session. Harmless: the module reclaims a
  permitted account's stale session on the next create (commit 9bba93b), so the
  next tick's attempt is not stuck behind it.
