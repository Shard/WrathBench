# ADR-0020: The fleet supervisor is a compose service, not a host process

Status: Accepted. Date: 2026-08-22.

## Context
The supervisor was launched by hand on the host with a deadline, and every
episode crossed the container boundary twice (host supervisor → host roster →
`compose exec` → containerised runner). It died at the deadline and needed a
human to relaunch, so the machine could be up with nothing running; it required
Bun, the checkout and a long-lived shell on the host; and terminating an episode
needed a `/proc` scan inside the container to deliver a signal the exec hop
swallowed. The intended end state is a Helm chart (Deployment + ConfigMap +
PVC), which argues for a self-contained, config-by-file service now.

## Decision
The supervisor runs inside the runner image as a `fleet` compose service,
`restart: unless-stopped`, no deadline; `infra/fleet.json` stays the hot-reloaded
control plane. In-container it spawns the runner as a direct child, frees
sessions over HTTP and signals its own child. The host launchers still work,
byte-identically, for ad-hoc runs. Choices a contributor would otherwise
question:

- **Behind a compose profile**, so a bare `up -d` cannot start a second
  supervisor against the same config — two lanes on one account is a night of
  `account_in_use`. The price is that the first start after a fresh `up` is
  explicit.
- **Harness version from `git describe` in the image**, not a stamp file written
  at `up`: a stamp frozen at `up` says "clean" for a tree edited five minutes
  later, and a dirty tree must stamp `-dirty`.
- **Liveness is a heartbeat in the state file**, not `kill(pid, 0)`: `--status`
  runs on the host, where a pid from another namespace is meaningless at best.
- **The run-id date stamp is a supervisor epoch**, fixed for the life of the
  process: rolling it at midnight would rename a running lane's roster and logs
  underneath it. Rolling it is a deliberate restart, which is also how code
  changes are picked up.
- **An unbounded loop is the normal case**; the stop condition is the operator
  disabling the lane or stopping the service.

Rejected: a systemd unit (solves lifetime, not the boundary crossing, and is not
a step toward Helm); mounting the docker socket so the container can `compose
exec` (root-equivalent control of the host daemon for no gain).

## Consequences
- The supervisor survives the operator's shell and comes back after a reboot; a
  crash-restart takes a new epoch, visible in `--status`.
- `up -d fleet` must always carry `--no-deps`, or compose may recreate the
  worldserver under live episodes. Every command in docs/OPERATIONS.md says so.
- Secrets keep the property they had: loaded from `.env` inside the container,
  never via argv or the compose file.
