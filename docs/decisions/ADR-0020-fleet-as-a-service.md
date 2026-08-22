# ADR-0020: The fleet supervisor is a compose service, not a host process

Date: 2026-08-22. Status: accepted.

## Context

The fleet supervisor (`infra/run-fleet.ts`) has been launched by hand on the
host with a deadline — `./infra/run-fleet.sh infra/fleet.json --until 18:00` —
and every episode reached the runner container through
`docker compose exec runner bun runner/src/run.ts`. That shape has three costs.
It dies at the deadline and has to be relaunched by a human, so the machine can
be up with nothing running on it. It depends on the host having Bun, the repo
checkout, and a shell session that outlives the night. And the process tree
crosses the container boundary twice per episode (host supervisor → host roster
→ `compose exec` → containerised runner), which is why terminating an episode
needed a `/proc` scan executed *inside* the container to deliver a signal the
exec hop swallows.

We also intend this to be the reference shape for a Helm chart later:
Deployment + ConfigMap for `fleet.json` + PVC for `data/`. That argues for a
service that is self-contained and 12-factor-ish now — config by mounted file,
state under `data/`, logs to files plus stdout — rather than a shape that only
works because a particular laptop has a particular checkout.

## Decision

**The supervisor runs inside the runner image.** A new `fleet` compose service:
same image and mounts as `runner`, `command: bun infra/run-fleet.ts
infra/fleet.json`, `restart: unless-stopped`, no deadline. `infra/fleet.json`
stays exactly what it was — the hot-reloaded control plane, re-read every 60s,
the one knob for steering. The service carries `WRATHBENCH_IN_CONTAINER=1`; on
that flag `run-roster` spawns `bun runner/src/run.ts` as a direct child instead
of shelling to `infra/run-episode.sh`, frees module sessions with its own
`fetch` instead of a `compose exec` hop, and signals its own child instead of
scanning `/proc` on the other side of a boundary that no longer exists. The
host path is untouched: `run-episode.sh` and `./infra/run-fleet.sh` still work
for ad-hoc launches, byte-identically.

The service is behind `profiles: [fleet]` so a bare `docker compose up -d`
cannot start a *second* supervisor against the same `fleet.json` — two lanes on
one account is a night of `account_in_use`. Naming the service activates the
profile, so `up -d --no-deps fleet` still starts it. `init: true` reaps orphaned
grandchildren; `stop_grace_period: 180s` is the drain floor (30s child grace +
the supervisor's 60s reap tick + margin).

**Harness version: git in the image, not a file written at `up` time.** The
runner image now installs `git`, and the repo bind mount already carries
`.git`, so `run-roster` computes `git describe --tags --always --dirty` per
episode — the same command and the same fallback `run-episode.sh` uses on the
host. The alternative (the host writes `data/harness-version` at `up`) was
rejected on honesty: a stamp frozen at `up` time says "clean" for a tree that
was edited five minutes later, and a `-dirty` tree must still stamp `-dirty`.
`--no-optional-locks` keeps `git describe` from writing the index under the
operator; uid 1000 on both sides means no dubious-ownership dance, and
`safe.directory` is set in the service env anyway for uid-shifted checkouts.

**`--loop` no longer requires a deadline.** `--until`/`--max-hours` become
optional caps in `run-roster`, and `laneUntilOrFail` becomes `laneUntil`. An
unbounded loop used to be treated as an operator mistake; under this shape it
is the normal case, and the stop condition is "the operator disables the lane
or stops the service".

**Liveness is a heartbeat, not `kill(pid, 0)`.** `--status` runs on the host
while the supervisor lives in another PID namespace, where a pid probe is
meaningless at best and hits an unrelated host process at worst. The supervisor
therefore publishes `heartbeatAt` (refreshed each tick) and a per-lane `alive`
flag into `data/runs/fleet-state.json`, and `--status` reports ALIVE/stale from
those — falling back to `pidAlive` when the field is absent, which is exactly
the case of a state file written by an older host-side supervisor. For the same
reason the lane paths in that file are now repo-relative (`resolveStatePath`
resolves them against whichever side is reading), and the `/proc` scan for
hand-started rosters is suppressed when the state says `containerized`, where
every lane would otherwise be reported as foreign.

**The date stamp is a supervisor epoch, not a date.** It is taken once at
start and every run id, lane roster, lane log and defer sidecar hangs off it
for the life of the process. Rolling it at midnight would rename a running
lane's roster and jsonl underneath it and hand `--resume-roster` and
`freeCycle` a fresh namespace mid-flight. Keeping it fixed leaves both
semantics literally as they were; rolling it is a deliberate act (`stop fleet`
then `up -d --no-deps fleet`), which is also how code changes are picked up.

**Secrets keep the property they had.** Nothing is passed via argv or the
compose file: Bun loads `/wrathbench/.env` inside the container, in the
supervisor and again in every child.

## Alternatives considered

- *Systemd unit on the host.* Solves the lifetime but not the boundary
  crossing, ties the harness to one machine's init system, and is not a step
  toward a Helm chart.
- *`docker compose exec` from a containerised supervisor* (mounting the docker
  socket). Would keep `run-episode.sh` as the single launcher, at the price of
  handing the fleet container root-equivalent control of the host daemon for no
  gain — the runner is a sibling service, not something we need Docker to reach.
- *A stamp file written by the host at `up` time.* Rejected above: it cannot
  stay honest about a dirty tree.

## Consequences

- The supervisor survives the operator's shell, and comes back after a crash or
  a machine reboot once it has been started. A crash-restart takes a **new**
  epoch, so run ids change; that is visible in `--status` (`stamp`).
- `docker compose up -d fleet` must always carry `--no-deps`. Without it compose
  may judge a dependency out of date and recreate the worldserver under live
  episodes. Documented in every command in docs/OPERATIONS.md.
- The `fleet` profile means a fresh `docker compose up -d` does not bring the
  supervisor back; the first start after a fresh `up` is explicit. Accepted as
  the cheap side of the accidental-second-supervisor hazard.
- `run-episode.sh` remains the host launcher and remains untouched — it is
  re-exec'd for every episode of a host-side fleet, so an edit there lands on
  running lanes within minutes.
- Lane stdout logs are opened `O_APPEND` with a `---- spawned <ts> pid <n>`
  separator. They used to be opened at offset 0, so a respawned lane overwrote
  the head of its own log and left the dead process's tail behind it — which is
  precisely what `--status` reads as "last:".
