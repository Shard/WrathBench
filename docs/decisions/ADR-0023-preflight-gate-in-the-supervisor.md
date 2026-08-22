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

## Amendment 2026-08-23: a fast gate and a deploy-time full arc

The gate as shipped ran `module-quest.ts` then `quest-status.ts`, sequentially
on `SMOKE`: ~260s on the happy path, of which ~145s was eight level-1 melee
fights and ~60s walking. Every worldserver restart cost the fleet four and a
half minutes of nothing spawning, and a re-checking failure cost that per tick.

**The per-tick gate is now two short smokes, and the full arc moves to deploy
time.** `preflight.smokes` entries are `{ script, account }` (a bare string
means the default `account`); entries with distinct accounts run concurrently
against one shared deadline, entries on the same account run in order, and the
clash check covers every account named. The full `module-quest.ts` arc is
`preflight.deploySmokes`, which `deploy-worldserver.sh` runs once per deploy
after the gate passes and the supervisor never runs. Both live in fleet.json so
the script and the supervisor read one file and one account list.

The two smokes keep every server-proven claim of the old pair and drop none:

- `quest-accept-status.ts` (SMOKE, ~20s): login; the quest-status assertions
  verbatim (STATUS_MULTIPLE names Willem available, per-guid STATUS agrees,
  quest_query 783 with `requiredNpcOrGo.length 4` / `requiredItems.length 6`
  and no kill objectives, quest_query 7 objective 0 `{ entry 6, count 8 }`,
  `missing_quest_id` is a 400); accept 783; the served quest-log State field
  reads complete; Willem no longer available; quest_complete ->
  OFFER_REWARD -> quest_choose_reward -> QUESTGIVER_QUEST_COMPLETE + XPGAIN;
  quest 7 in the log; vendor_list.
- `kill-credit.ts` (SMOKE2 once permitted, ~42s): the same 783 turn-in (the
  kill quest is gated on it), then exactly one Kobold Vermin: ATTACKERSTATEUPDATE
  stream, SMSG_QUESTUPDATE_ADD_KILL `{ 7, 6, 1/8 }`, fromKill XPGAIN, loot
  window and release. Fail fast: one fight, a 40s cap (1.5x the longest fight
  in the logs), no "pick another", a death is a failure.

Two things came out of measuring rather than reading:

- *`SMSG_QUESTUPDATE_COMPLETE` was never a proven claim.* The core does not
  send it for kill or talk objectives at the pinned commit (zero occurrences in
  every trajectory on disk); the old smoke read completion off the served
  quest-log State bit and the final ADD_KILL, and said so in a comment. The
  fast gate asserts the same State bit on 783, which a talk quest completes on
  accept. Objective completion by kills stays in the deploy-time arc.
- *Character delete costs a minute after logout, by the core's rule.* A
  disconnected session keeps its player in world for `WorldSession::expireTime`
  (60s), during which CMSG_CHAR_DELETE is silently ignored; measured 66s from
  logout to a successful delete, in every smoke that deletes at the end. A real
  client's clean exit, CMSG_LOGOUT_REQUEST, is not on the raw allowlist. So the
  fast smokes use a fixed name per script, delete *last run's* character first
  (the same CMSG_CHAR_DELETE path, instant because the linger is long over by
  the next tick) and only log out at the end. `spellbook.ts` still deletes last
  and so stays out of the gate; `module-navigation.ts` does not read
  `MODULE_ACCOUNT` and would log into a live lane's account, so it stays out
  too.

`timeoutMs` is ~3x the measured critical path. `SMOKE2`–`SMOKE4` exist in
auth; the module permits them after the next worldserver recreate, and the
fleet.json ships both smokes on `SMOKE` until then (sequential, ~62s) with the
flip to `SMOKE2` documented in OPERATIONS — an armed gate bound to an
unpermitted account is exactly the parked-fleet failure this ADR warned about.

A sub-minute gate that proves late-game claims needs characters that do not
start at level 1 — FOLLOW-UPS 45.
