# ADR-0023: The deploy-window smoke is a supervisor gate, not a deploy step

Status: Accepted. Date: 2026-08-22. Amended 2026-08-23 (fast gate), folded in;
amended again 2026-08-23 (scenario fixtures), as a section below.

## Context
Deploying a worldserver image was a manual sequence whose smoke step depended on
remembering. A worldserver that answers `/health` can still be unable to drive a
quest arc — a dropped action, a missing DBC, a stale map volume — and the first
thing to discover it was a model, hours later, with every episode in between
spent. The recreate also has a trigger nobody types: `restart: unless-stopped`
brings a crashed worldserver back, and the fleet spawns straight into it.

## Decision
**The smoke is a gate on spawning, inside the supervisor**, hot-reloaded from
`fleet.json`. Before the first lane, and again whenever the server is no longer
the same server, it runs the configured smokes; lanes spawn only after a pass.
A failure blocks spawning and re-checks every tick, so a fix or rollback
unblocks with no operator action; only `start` is suppressed, so an operator can
always park a lane during a bad deploy; `enabled: false` is a first-class state
so the mechanism ships installed and disarmed.

**Server identity is the world's boot, not an image id.** `/health` tells
non-loopback callers liveness only and the supervisor has no docker socket, but
it shares the logs volume, where a boot is plainly visible. This is weaker than
an image id and allowed to be, because nothing downstream trusts the identity
string: the deploy script keys on the *timestamp* of a gate result. A marker that
fails to change can only cost an extra smoke; an unreadable volume yields a
marker that changes on its own. The gate fails toward re-running, never toward a
frozen "already smoked".

**The deploy script verifies**: refuses while any episode is live, tags the old
image aside, recreates, waits for the supervisor's gate result (or smokes itself
if no supervisor answers), and retags back on failure.

**The gate gets its own account**, because a smoke holds a live session for its
whole arc and sharing one with a lane means the two reclaim it from each other;
not the ad-hoc debugging account either, since a gate that fights an operator's
probe is worse than none.

**Amendment: a fast gate and a deploy-time full arc.** The original gate cost
~260s per worldserver restart, mostly melee fights and walking. The per-tick gate
is now two ~20–40s smokes on distinct accounts, run concurrently, keeping every
server-proven claim of the old pair; the full arc runs once per deploy. Two
things measured rather than read: the core never sends
`SMSG_QUESTUPDATE_COMPLETE` for kill or talk objectives at the pinned commit, so
completion is asserted off the served quest-log state bit; and a disconnected
session lingers for `expireTime` (60s) during which character delete is silently
ignored, so fast smokes delete *last run's* character first and log out last.
Script names, accounts and timeouts: docs/OPERATIONS.md.

Rejected: a build id in `/health` (the honest identity and the long-term
answer, but needs a module change plus rebuild to become true); gating in the
deploy script only (misses every self-restart); gating per episode (a tax on
the thing being measured, for an answer that only changes when the server does).

## Consequences
- A live supervisor picks the gate up only on restart, which the deploy window
  already requires.
- With preflight armed a crash-restart costs one fast gate before lanes resume —
  the intended price.
- A timed-out smoke may leak its session; harmless, since create reclaims a
  permitted account's stale session (ADR-0016).
- An armed gate bound to an unpermitted account parks the whole fleet on a 403;
  new smoke accounts ship disabled until the worldserver recreate permits them.
- A sub-minute gate that proves late-game claims needs characters that do not
  start at level 1 (FOLLOW-UPS 45); `infra/fixtures/` supplies them — see the
  amendment below.

## Amendment 2026-08-23: a gate smoke may start from a scenario fixture (FOLLOW-UPS 45)

The fast gate could only ever prove what a level-1 character reaches from the
Northshire spawn inside a minute. Everything else — the tram, a flight path, a
trainer with ranks to sell, a death far from a graveyard — is minutes of walking
away, so it went ungated or lived only in the deploy-time full arc.
`infra/fixtures/` writes the `acore_characters` rows for a named scenario (level,
xp, money, position, homebind, spells, quest log) onto a *logged-out* character on
a `SMOKE*`/`PROBE` account, and a smoke logs into it and proves its claim in
seconds. **A gate smoke may start from a fixture.**

**A fixture is outside the observation contract, not an exception to it.** Nothing
in `runner/` or `sdk/` imports the tool and no route reaches it; it is the operator
arranging the world before the run, the same act as choosing which account a smoke
logs into. `docs/CONTRACTS.md` is untouched — the character the agent drives is
still observed and moved through the module alone. What keeps that honest is the
account allowlist: runner and shakeout accounts are never fixtured, so a benchmark
run still starts from a character the agent itself created. (No items, ever: item
guids come from an in-memory generator seeded at boot and ObjectMgr reaps
externally inserted inventory at the next start — FOLLOW-UPS 57.)

**Persistent characters replace delete-last-run's-character, for fixture smokes.**
The fast-gate rule above — delete last run's character first, log out last — exists
because a disconnected session lingers for `expireTime` (60s) and a delete inside
that window is silently ignored. A fixture smoke wants the opposite: one durable
character (`Smoketram` on PROBE), reused every run and *re-placed* by the fixture
rather than recreated, which also makes the start position a written fact instead
of a spawn point. It pays a different wait — the tool polls for
`characters.online = 0` before writing, because the module's `DELETE /session` acks
when the logout is queued, ahead of the core's `LogoutPlayer` save; measured at
~36s including that wait. Smokes that genuinely want a fresh level-1 keep the
delete-first rule.

**Dropped: `CMSG_LOGOUT_REQUEST` on the raw allowlist.** It was wanted so a smoke
could end cleanly in 20s instead of 60. A persistent character never waits on a
delete, so the saving is gone — and the allowlist is the agent's action surface
(ADR-0025), which is not the place to spend for operator convenience.
