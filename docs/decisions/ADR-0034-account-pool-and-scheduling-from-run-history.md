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

## Amendment 2026-08-23: account classes

`policy.paid.maxConcurrent` throttles paid models, but it throttles them *over
the shared pool*: a paid run lands on whichever `accounts.pool` account happens
to be free, and "one paid run at a time" holds only because a number in a file
says so. Money is worth a stronger guarantee than a counter, so the paid class
gets its own accounts: `accounts.paid`, beside `accounts.pool`.

A paid pick launches only on a free account from `accounts.paid`, and a free
pick — extras included — only on the pool. With one paid account, one paid run
at a time is true *by construction*, the same reason the local LM Studio box is
one runner: the resource itself is the limit, not a policy that could be edited
into something expensive. The cap stays anyway; it is what holds when there is
more than one paid account, and it keeps the projection's held-pick reason
("paid cap: 1/1") meaningful.

If `policy.paid` is present and `accounts.paid` is absent or empty, paid picks
are **held** with `no paid account configured` rather than spilling into the
pool. Spilling is the failure mode this amendment exists to remove; a gap in
the config should stop paid work, not quietly widen it. `--status` and
`--dry-run` name that gap on its own line so it does not read as "the models
are just not schedulable today".

**Coexistence rule.** Listing an account says who may *schedule* it; `enabled`
says who *holds* it — and only an enabled job holds one. So an account may not
appear in both lists, and an **enabled** pinned job may not sit on an account in
either list, but a **disabled** pinned job may: it is a parked switch, holding
nothing. That is how `SHAKEOUT2` is the paid account today while the disabled
`sub-opus-e90` job stays pinned to it, ready to be flipped on by hand — and it
matches the neighbouring one-job-per-account check, which has always ignored
disabled jobs. The accounts table shows such an account once, under the class
that schedules it, with the parked job as its note.

One exception, deliberate: the split governs the **policy**. A manual queue
job with no account is the operator's explicit override and draws from the
pool whatever its ref's billing — pin a paid ref to a paid account, or let the
policy schedule it.

**The same argument makes a third class: `accounts.local`.** A model served
from the operator's own hardware — an LM Studio box on the LAN, `isLocalBase`
in `runner/src/model-cost.ts` — is priced free, and under the free/paid split
alone it would take whatever pool account came up. But that box answers one
request stream at a time, which is exactly the paid class's argument with money
swapped for hardware: the resource is the limit, so give it its own accounts.
A local pick launches only on a free account from `accounts.local`; free and
paid picks never touch one. Local beats billing where they disagree, since the
constraint is the box, not the invoice.

Two things differ from paid, both deliberate. There is no `policy.local` block
— nothing about a local model needs a target or a cap that the box does not
already enforce — so the class has no on-switch to key on and is **always
live**: a roster with a local model and no `accounts.local` holds those picks
with `no local account configured` rather than putting the box's model on a
shared account. And there is no pre-split escape: `accounts.paid` keeps one so
that a file written before the split still runs, but nothing was ever written
against a local class, so there is nothing to preserve.

Everything else is the paid class verbatim, and the code says so once rather
than three times: the classes are a map (`classPoolsOf`, `classAccountsOf`,
`accountClassOf`), and validation, `--status` rows, `--dry-run`, the state
file's `accounts` block and resume-on-your-own-class all iterate it. The
coexistence rule, the preflight exclusion and the one-class-per-account check
extend unchanged.

A class governs the **next pick**, never a run already in flight. `qwen3-8-27b`
was mid-run on a pool account when the class was introduced; it was left alone,
and `--status` marks such a row `[local model on a pool account — left alone]`
rather than killing a run to tidy the table.

`accounts.paid` is optional and absent is the old behaviour: with neither block
the pool is one undifferentiated class again.

## Amendment 2026-08-23: "lane" is retired

The word is gone from the code, the state file, the API and the docs. A **job**
is the unit of work; an **account**, with a class, is where it runs; the
materialised thing the supervisor spawns is a `JobSpawn`. `fleet-state.json`
has one `jobs` map carrying both the job and its process; there is no `lanes`
block, no `lanes` list in `fleet.json`, no `accounts.pinned` input, and no
read of any of them — a file that still says so is refused by name, with the
message naming the 0.4 keys. Per-job files keep their pattern
(`fleet-<job>-<stamp>.{roster.json,jsonl,log}`); the per-job jsonl record's
key is `job`. Older worklogs and ADR bodies keep the word as history.

## Amendment 2026-08-23: local extras are freeplay

Extras were one thing: a free model past its targets takes another run of a
scored tier with the next race/class in the cycle. For the local class that is
the wrong extra. The LM Studio box is inference-bound — its wall clock is
mostly the box thinking, not the model deciding — so a fourth and fifth `e90`
buy nothing a speed comparison could honestly use. What a local model can give
that nothing else can is *duration*: it costs no money and no shared quota, so
it can simply keep playing.

So the local class's extra is a **freeplay** episode: one at a time, unbounded
(the tier caps no wall clock), the roster entry's own starting character, and
freeplay's watchdogs as they stand today. When the run ends — death spiral,
idle watchdog, operator — the next tick starts another. It is stamped
`extra: true` like any other extra, so it is an attempt, is reported apart on
the Models and Episodes pages under `freeplay`, and is never counted toward an
`e90`/`e360` target or as a promotion witness. Scheduled runs still come first:
counting is series-keyed, so a new harness minor re-arms the `e90` (and `e360`
if promoted) targets, and freeplay only resumes once they are met again.

It is a knob, not a fact about the class: `policy.extras.local` is `"freeplay"`
(the default) or `"characters"`, the race/class cycle the free models run. One
concept either way — an extra is still "a run past the target, never counted";
only what the extra *is* changes. The pick carries no character, and the
question "is this job an extra" is `isExtraJob` in `infra/run-fleet.ts`: a
policy job that either rolls a character or is a freeplay pick. Nothing else
schedules freeplay, so the two spellings cannot collide, and a manual freeplay
job (the navigation probe) is not an extra because it has no attempt number.

One consequence worth naming: the projection now keeps stats for `freeplay`
alongside the scored tiers, with a target of zero. It has to — run ids carry a
date stamp and an attempt number, so two freeplay extras in one day need real
attempt numbers to stay distinct on disk — and it is also what puts the freeplay
extras in the Models page's extras column. Eligibility and promotion are
unchanged: `freeplay` is never in `eligible`, and only a counted `e90` run
promotes.

## Amendment 2026-08-23: a launch that did not happen is archived, not labeled

"Stillborn" was a *state* a run could be in and every surface had to know about
it: the runs list hid them behind a toggle, the eval and ladder charts filtered
them with a count attached, the episode member counts excluded them, the models
page showed `+N✗` beside a target, and a CLI mode swept the directories up
afterwards. Five places spelling one idea — this run never got off the ground —
and each of them a place to get it wrong.

The state is gone. A run that terminates with zero `response` records is
**archived by the runner itself**, at termination, into `data/runs/archive/`
(`archiveIfNoResponses`, one move shared with the CLI). Nothing downstream has
to filter, because nothing downstream ever sees one: `/api/runs`, `/api/eval`,
`/api/episodes`, the Models and Episodes pages and `isCounted` all read a
directory that no longer holds it. The `?includeStillborn=` parameters, the
`stillborn` fields on the API and the dashboard's toggles are removed.

A **pause is not a termination**. A paused run with no response yet is a launch
still in progress — the supervisor resumes it — and archiving it would bury
resumable work. That distinction is free in the runner, which knows how its own
episode ended, and was *not* free in the old sweep: on the night this shipped,
every zero-response directory on disk was a paused run, so the old
`--stillborn` mode would have destroyed three of them. The mode is removed;
`--pre-series` (the comparability floor) stays.

Two readers still need what was archived, and both are the scheduler:
the **defer ladder** is made of launches that did not happen (drop them and a
dead provider relaunches forever at rung zero, which is what this record's
retirement rule exists to prevent), and **attempt numbers** must stay unique on
disk, since a run id is `fleet-<job>-<model>-<datestamp>` plus `-a<attempt>`.
So `readRunFacts` takes `includeArchived`, the projection asks for it, and the
viewer does not. `run-fleet --status` keeps its `+Nsb` column for the same
reason: it is the operator's window onto the ladder, not a listing of runs.
