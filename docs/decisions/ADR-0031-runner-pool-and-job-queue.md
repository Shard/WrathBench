# ADR-0031: Runner pool and job queue

Date: 2026-08-23. Status: accepted.

## Context

Since ADR-0020 the fleet is `infra/fleet.json`: one lane, one account, one
sequential episode stream. That shape is right for a probe that must stay on a
known account (nav-probe on SHAKEOUT) and wrong for everything else. Six free
models on six `RUNNER*` accounts means the account is the scheduling unit: to
give a model a longer episode the operator edits a lane's watchdogs by hand, a
model that should run once at a longer tier has to displace a looping lane, and
when a lane idles (its models all cooling on the defer ladder) its account sits
empty while another lane's models wait behind their own. Episode tiers
(ADR-0030) make this worse: a model earns its way into `e360`, and running it
there is a job, not a lane.

## Decision

**Lanes stop owning accounts.** `fleet.json` gains an `accounts` block and a
`queue`:

- `accounts.pinned` maps an account to a lane name. A pinned lane is exactly
  today's lane — its own roster process, enabled/drain/respawn semantics
  untouched. The `lanes` list holds only pinned lanes.
- `accounts.pool` lists the accounts the queue may use, in preference order.
- `roster` names entries (the per-entry roster schema) plus `tiers`, the
  episode tiers the model has been promoted into. Promotion is recorded here
  by an operator or an eval step; the supervisor never computes it.
- `queue` is an ordered list of jobs `{ ref, episode, repeat, lane?, enabled? }`.
  `ref` is a roster name or a list of them (a list rotates models on one
  account as a multi-entry lane does). `episode` is `e90 | e360 | freeplay`,
  passed to the runner as `--episode <id>` with the equivalent explicit
  watchdog flags alongside until the runner owns the id. `repeat` is a count
  (n run ids on one roster process) or `"loop"` (run-roster `--loop`).

**Scheduling is a pure function of the config and the facts the supervisor
already has.** Every tick, after the pinned lanes are diffed as before, the
supervisor walks the queue in order and hands each runnable job the next free
pool account. Free means not assigned to a running job and not held live by
anything, which is the roster's own account-busy inference (`accountHeldBy`),
not a new one. Runnable means enabled, not running, not finished, promoted
into its episode (a ref that is not is dropped from the job; a job with no
promoted ref is skipped with a logged reason, once), not a second stream on a
model already running, and not cooling or tainted on its own defer sidecar.
A job that has been given an account becomes a lane to the rest of the
supervisor — same spawn path, same drain, same exited-0-is-finished rule — so
the preflight gate, the heartbeat, the state file and the rejected-config
banner cover it for free. The account is released when the process exits.

**The shape change ships beside the live file, not over it.** A supervisor that
predates this ADR rejects the new shape and keeps its last good config; that is
the safe failure, but it also means the new file must not be written over
`fleet.json` while the old code is running. So `infra/fleet.next.json` is the
same seven streams under the new schema, and the operator renames it at the
next drain window. The new code loads both shapes — the old one as "every lane
pinned, empty pool" — so the rename is reversible and the order of the two
steps (restart, rename) does not matter.

## Alternatives considered

- *Per-job processes instead of per-job rosters.* Would let `repeat: n` cycle
  through the pool instead of holding one account. Rejected: the roster's
  defer ladder, resume-in-place and cycle numbering all live in run-roster and
  are exactly what a free-pool job needs; one job, one roster process keeps
  them.
- *Computing promotion in the supervisor* from the eval store. Rejected: a
  tier change is a comparability change (ADR-0026) and wants a recorded
  decision, not a threshold that flips at 03:00.
- *A pool account per job lane with static assignment.* That is today's shape
  with extra steps.

## Consequences

- With six pool accounts and six looping jobs the first six runnable jobs are
  the fleet and the rest wait in order; rotation is reordering or disabling a
  job. This is the same capacity as today, made explicit.
- Run ids keep their form (`fleet-<lane>-<model>-<stamp>`), with `-rN` for the
  n-th copy of a `repeat: n` job; the shipped next-file names its jobs after
  today's lanes so the eval surface sees no seam at the switch.
- `--status` grows an accounts block (pinned vs pool, what runs where) and a
  queue block (depth, running, waiting, skipped-with-reason); `--dry-run` shows
  the jobs that would spawn now, one per free account.
- The per-tier dimensions (`episodeDimensions`) are the supervisor's until the
  runner's `--episode` flag lands; when it does they become redundant, not
  wrong, and can be dropped in one place.
