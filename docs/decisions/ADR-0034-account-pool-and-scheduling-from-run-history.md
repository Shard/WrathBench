# ADR-0034: Account pool and a scheduling policy from run history

Status: Accepted. Date: 2026-08-23. Consolidates ADR-0031 and ADR-0032 (both
superseded by this record). Amended the same day, twice: one job concept, then
series keying with the paid/free split (both below). **This is the single statement of the promotion rule**;
docs/EPISODES.md, docs/OPERATIONS.md and docs/COSTS.md point here.

## Context
Under ADR-0020 the fleet was lanes, and a lane owned an account: one sequential
episode stream per account. Episode tiers (ADR-0033) broke that — an `e360` holds
an account four times as long as an `e90`, so a roster mixing tiers starves, and
giving a model a longer run meant displacing a looping lane by hand. The first
replacement was a hand-written ordered job queue with promotion recorded as a
roster edit, on the reasoning that a tier change is a comparability change and
wanted a recorded decision rather than a threshold that flips at 03:00. One night
showed the cost: the queue needed editing for every model added, pruned or
promoted; looping jobs held accounts with nothing left to prove; a provider that
refused every launch was relaunched on its lane's ladder with the account idle
behind it. What the operator wants is a statement of how much evidence per model,
and a scheduler that gets there by itself.

## Decision
**Lanes stop owning accounts.** `fleet.json` has `accounts.pinned` (account →
lane; a pinned lane is exactly the old lane, for work that must stay on a known
account such as subscription credentials) and `accounts.pool`, in preference
order. A job handed a pool account becomes a lane to the rest of the supervisor —
same spawn, drain, preflight gate (ADR-0023), heartbeat and state file — and
releases the account when its process exits. Free means not assigned and not
held live, by the roster's existing account-busy inference.

**The default source of pool work is a policy derived from run history**, in one
pure projection (`runner/src/models.ts`) that the supervisor, `--status`,
`--dry-run` and `/api/models` all read. There is one answer to "why is this model
not running", and it is derived, never stored.

- **Target:** three counted runs per (model, episode) by default. A run counts when the model answered at least once and the run did not end by operator cut (`manual`) or harness failure (`harness-error`); those still number attempts, and the policy reruns them
  (`policy.runsPerEpisode`, overridable per roster entry). A model that has met
  its targets is not scheduled.
- **What counts:** only runs stamped with an episode id (no back-labeling, per
  ADR-0033), un-overridden, with at least one model response. A *stillborn* run
  (no response, not live) counts toward the ladder, not the target.
- **Promotion:** every roster model is `e90`-eligible on arrival. It becomes
  `e360`-eligible automatically once **one** counted `e90` run has reached level 5
  (ladder rung 1). No harness-version filter (that would restart every model's
  evidence on each bump and keep the fleet on rung zero). No demotion: a model
  that idles its `e360` runs meets its target and stops being scheduled.
  `freeplay` is never scheduled by policy. `roster.<name>.tiers` survives only as
  a manual force.
- **Ladder and retirement:** consecutive no-progress attempts (stillborn or
  `adapter-error`) cool the model for `1m/3m/5m/10m/15m/30m/1h/3h/6h`. A failure
  at the 6h ceiling **retires** the model until `run-fleet.sh --clear-model`,
  whose record in `data/runs/fleet-models.json` is the only state the policy
  persists (it works by ignoring attempts that ended before it).
- **Priority** for a free account: models with zero counted runs on any eligible
  episode, then the shorter episode, then fewest counted runs, then roster order.
  One stream per model at a time.
- **The `queue` is a manual override** that outranks the policy; its tier gate
  reads the same projection, so an `e360` job for an unpromoted model is skipped
  with a logged reason unless the entry forces the tier.

The shape change shipped as a sibling file (`fleet.next.json`) rather than over
the live one: an older supervisor rejects the new shape and keeps its last good
config, the new code reads both, so the restart and the rename commute.

## Alternatives
- Promotion by operator judgement, or as a recorded roster edit. What those
  guarded against was a decision made differently per model; a threshold written
  once and applied to every model alike is the same guarantee with less latency.
- Per-job processes instead of per-job rosters: the defer ladder, resume-in-place
  and cycle numbering all live in run-roster and are what a pool job needs.
- Persisting the ladder in a supervisor-written sidecar: two sources of truth
  that a restart or hand-launched run would desynchronise.

## Consequences
- Capacity is explicit: with six pool accounts, six jobs run and the rest wait.
- Nothing on disk before `--episode` carries a stamp, so the policy started every
  model at zero. Correct — those runs ran under the leash of their day.
- The model is never told its tier; only the wall clock and watchdogs vary, and
  the tuple records both. The loop stays model-agnostic.
- A dead provider costs at most ten launches over ~10 hours before retirement.

## Amendment (2026-08-23): one concept, the job

The first cut of this record left two generations stacked: a `lanes` list
beside `accounts.pinned` for pinned work, a `queue` for pool work, and the
policy's picks as a third kind of thing, each with its own spawn bookkeeping
and its own `--status` rows. Consolidated:

- **A job is the one unit of work**: `{ ref | [refs], episode, repeat, enabled,
  account? }`. A job that names an `account` is pinned to it — exactly the old
  lane — and a job without one takes a free pool account. The policy's picks
  are jobs too, synthetic and never persisted. Every job reaches the spawner
  through one path (`jobLane` → `spawnLane`); a job's name is always
  `<first ref>-<episode>`, one job per (ref, episode).
- **The roster is the only place a model is described.** A probe with an
  objective is a roster entry like any other (the entry carries `objective`,
  `watchdogs`, `maxToolCalls`, `wikiCoords`), referenced by a pinned job. An
  entry referenced by a pinned job, or carrying an objective, is outside the
  policy: the account is spoken for, and unscored runs are not evidence.
- **`policy.maxConcurrent { <driver>: n }`** caps the policy's streams per
  driver, counting every job on that driver, pinned ones included. It exists
  so that a subscription that tolerates two sessions is a number in the file
  rather than a model removed from the roster (`sonnet`/`sonnet-low` are back
  under `"claude-code": 2`; ADR-0035 makes their runs scored, tagged).
- **`accounts.pinned` is derived**, never authored; `lanes` and a queue
  entry's `lane` are legacy input. Both older shapes — pre-pool lanes that
  name their accounts, and pool-era lanes beside `accounts.pinned` — load as
  pinned jobs carrying their entries verbatim, with one log line saying so.
- `--status` is accounts (what runs where), models (the projection), one
  session line, and a queue block only when a manual queue exists. Finished
  runs get no rows.

The shape change ships as `fleet.next.json` again, for the reason above.

## Amendment (2026-08-23, evening): series keying, paid and free, extras

Three things the first night under the policy showed.

**The harness version is the wrong grain for "what counts".** The record above
says no harness-version filter, because filtering on the exact `git describe`
would restart every model's evidence on each fix commit. But *never* filtering
is wrong the other way: a minor bump (`harness-0.3` → `0.4`) changes what a run
measures, and three runs from the old series would leave a model "target met"
and unscheduled under the new one. The grain that matches how the repo is
actually versioned is the **series** — `major.minor` of the stamp
(`harnessSeries()` in `runner/src/comparability.ts`). Counting, targets,
promotion witnesses and the ladder key on the series of the **running
checkout** against each run's recorded series; runs from another series are
listed (`otherSeries`) and never counted. An unversioned checkout has no
series and counts everything, and says so in `--status`. The eval surface
groups by series the same way, each row naming the exact builds it holds, so
the schedule and the charts agree on what is comparable. Nothing is rewritten:
the stamp stays the exact version.

**Paid and free are different bets.** A free or local model costs nothing per
extra run, so there is no reason a free account should sit idle once the
targets are met; a paid model is evidence bought with money and wants a hard
stop and a throttle. Billing is a property of the **model**, decided once in
`runner/src/model-cost.ts` (a `-free`/`contributor-free` slug, a LAN api base,
the claude-code subscription, or the verified-free allowlist → `free`;
everything else → `paid`; `roster.<name>.billing` overrides) and shared by the
viewer's price table. Under `policy.paid` a paid model's default target is
**e90 3 / e360 1**, hard — never extras — and at most `maxConcurrent` (default
1) paid models are in flight across the pool at once, pinned jobs excluded;
priority among paid models is unchanged, and a pick held by the cap is listed
in `--dry-run` with the reason.

**Extras.** Under `policy.extras`, once nothing else is schedulable, free
models past their targets get **extra** runs at the lowest priority, unbounded,
fewest-extras first, `e90` before `e360` (`e360` only for a promoted model),
cycling through `policy.extras.characters` (a list of `{race, class}`; the
default is a short list of Alliance level-1 combos). An extra is a normal
scored run of its tier — same prompt, same leash, a different starting
character — stamped `extra: true` in its config so the projection numbers it
as an attempt, reports it apart, and never counts it toward a target or as a
promotion witness. The point is more samples on the free roster for no money,
and a start-state dimension (race/class) sampled without anyone choosing it.

Both blocks are **optional and off when absent**: a `fleet.json` without
them runs exactly as before, and the live supervisor's hot-reload stays
parseable. `policy.paid: {}` and `policy.extras: {}` take the defaults.
