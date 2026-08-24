# Follow-ups

Open items only, grouped by area. Numbers are stable — ADRs, commits and the worklog
cite them — so gaps are normal and nothing is renumbered.

When an item ships or is rejected it leaves this file entirely: the day file in
`docs/worklogs/` records it with the commit, and that is where a citation to its
number resolves — `grep -rn "item 64" docs/worklogs/`. An item with no next action
and no trigger leaves the same way, to a GitHub issue.

**This file is a list of work someone could pick up, not a record of everything
known.** It carried a resolved ledger until 2026-08-24; at 64 entries the archive
was larger than the list, which is the failure mode to avoid rather than repeat.

Each open item says what, why it matters (with evidence), what unblocks it, and
status.

## Next up

1. **38** — run the N1 gate: three tram rides on PROBE with typed success per leg;
   ADR-0027 flips to accepted on that run.
2. **35** — milestone records; rungs 2/4/6 of the ladder read "not instrumented" until
   they exist.
3. **19** — before anything is public or MCP-exposed: shared secret on the port,
   token-to-character binding, filesystem sandboxing.

## Navigation

38. **Navigation plan — rungs 2–4** (2026-08-22; supersedes item 18). Rung 4 — a
    capital, the tram, one flight, unaided — is the public release trigger
    (VISION.md). Scoped to walking, the Deeprun Tram and flight masters; boats,
    zeppelins and elevators are rung-7 work. Source: the 2026-08-22 spatial-delivery
    synthesis and the travel probe (worklogs/2026-08-22).
    - **N1 — actions and statuses: shipped and deployed** (ADR-0027, commits
      92f7df1..b88dd1d, live as `harness-0.3-68` since 2026-08-23). Typed `no_path`
      causes with the subdivision retry in the module, `CMSG_AREATRIGGER` on entering
      a DBC volume, transfer packets tapped and `waitForTransfer` typed,
      transport-relative movement. **Gate passed 2026-08-23** on `harness-0.4-73-gafd352c`:
      `travel.ts --from tram-ironforge --rides 3` (item 45 fixture) rode IF→SW three
      times with typed success on every leg, boarding on attempt 1 each time, rides
      60s; ADR-0027 is accepted. One residual left: triggers are only tested while a
      `move_to` is active.
    - **N2 — field-level observations**, each small, each earned, each logged.
      **Shipped 2026-08-23 (ADR-0027 amendment, built to `:next`, awaiting the deploy
      window):** zone and area name on self (`WB_AREA` from the server's zone/area pair
      named by the client's `AreaTable.dbc`; `state.self.zone` / `state.self.area`; HUD
      `position: Elwynn Forest / Northshire Valley — map 0 (x, y, z)`; `milestone`
      records `kind: zone|area` with ids only, plus `zone`/`area` state columns) and NPC
      roles on nearby units from `UNIT_NPC_FLAGS` (`UnitView.roles`, `units({ role })`,
      HUD `Gryth Thurden (flight master, 4.2y)` — role, not recommendation). Gate:
      `infra/smoke/area-and-roles.ts` (login names, one `WB_AREA` each way across the
      abbey door, Deputy Willem reports `questGiver`) — runs on the first deploy of the
      N2 build; if the server's ids disagree with the ones read from the map files, the
      smoke is corrected to the server's answer. **Remaining:** innkeeper bind
      (`CMSG_BINDER_ACTIVATE`, `SMSG_BINDPOINTUPDATE`) so the hearthstone is a real
      connector. Log the exact model-facing payload for each so the later
      text-vs-other-channel experiment is honest.
    - **N3 — flight paths**, the first real destination-choice surface: gossip a
      visible flight master → tap `SMSG_SHOWTAXINODES` (current node and known-node
      mask, exactly what the client receives) → `activate_taxi` → on-taxi movement
      state in the cache so the loop does not fight the flight → arrival as a
      postcondition. Never the TaxiPath catalogue. Gate: the probe flies one hop; a
      model discovers and uses a flight master unaided.
    - **N4 — rung-4 attempts**: Opus/Fable runs with milestone records on, destination
      choice scored from the records (destination chosen → connector chosen → action
      dispatched → transfer confirmed / not_visited / waiting / wrong_map / stuck →
      arrival at server-confirmed map+xyz). Never "ended near the coordinate"; that
      scores `move_to`.
    - **Not in 0.3, by decision:** a `here()` / `goTo(name)` helper, a rendered minimap
      as model observation (ADR-0019 stays operator-only), the TaxiPath /
      areatrigger_teleport tables, walkability masks, a persistent map notebook (a
      labelled context-engine change under 8b if ever). Wiki coordinates are a run
      dimension withheld from scored runs (ADR-0028); pull back to a labelled coords
      tier only if the names-only ladder proves unclimbable.

## Fleet and gate


57. **Item fixtures need a guid-safe design** (2026-08-23, split out of item 45). A
    fixture cannot write inventory or mail, so no smoke can be staged with a specific
    bag or mailbox: `item_instance` guids come from an in-memory generator seeded once
    at worldserver boot from `SELECT MAX(guid)`, so anything inserted from outside
    while the server is up collides with guids the running server is about to hand
    out — and `ObjectMgr.cpp` then *deletes* every row at or above its watermark in
    `character_inventory`, `mail_items`, `auctionhouse` and `guild_bank_item` on the
    next start. Externally written items are racy now and reaped later, which is why
    `infra/fixtures/scenarios.ts` refuses them outright. Two designs are plausible and
    neither is picked: route the grant through the live server (a vendor purchase or
    quest reward driven by the module, which is slow but always guid-correct), or
    write with the world stopped and reseed the watermark. Blocks nothing today —
    every claim a fixture is wanted for so far is position, level or spells. Do it
    when a smoke needs gear, mail or a specific consumable to prove its claim.

## Episodes and results

77. **EventStream reconnect has no per-attempt connect bound** (2026-08-24, bare-clone
    audit). `openSocket()` (`sdk/src/events.ts`) puts no timeout of its own around the
    WebSocket construction, so one stalled TCP/WS handshake during a reconnect silently
    consumes the caller's whole wait budget with no fallback — the reconnect ladder
    only reschedules on close/error, never on "still opening". Observed once as the
    events.test.ts reconnect test timing out at 5s in a loaded container (2026-08-24,
    under the wrong Bun; not reproduced since — 25+ runs incl. under CPU stress), so
    this stays parked per the earned-by-need rule. Unblocks on a second observation,
    in CI or a live run's reconnect logs.

78. **run.sqlite is opened everywhere with busy_timeout 0** (2026-08-24, bare-clone
    audit). No connection to a run.sqlite anywhere in the codebase sets
    `PRAGMA busy_timeout` (or WAL), so any overlap — the runner writing while the
    viewer, fleet supervisor or models.ts reads — throws SQLITE_BUSY immediately
    instead of retrying. Never yet observed failing (the 2026-08-24 endRuns test
    failure that first pointed here turned out to be a root-container path quirk),
    which is why this is an item and not a change: one line in `Trajectory`'s
    constructor plus the read-only opens, when an actual SQLITE_BUSY shows up in a
    log. Unblocks on first observation.

8. **Context policy is not applied on the claude-code harness** (ADR-0035: recorded,
   not penalised). No trim; one CLI conversation grows linearly (~200k tokens by the end
   of a 90-minute episode, roster-sonnet-20260822, COSTS.md), so the lane's spend is
   mostly cache-read replays of a growing prefix and a `quota-exhausted` pause loses the
   context on resume. Either the driver applies a policy or the prompt stops promising
   one; cross-driver cost comparisons are invalid until then. Read first (merged 8c):
   `fleet-nav-probe-sonnet-20260822-c2`, a 6h e360 completed naturally at $43.90.
   - **8a — extractive digest, behind an evidence gate.** Requests plateau at ~8–20k on
     the fixed-loop driver (worklogs/2026-08-21), so build it only on real context
     exhaustion or a trajectory re-querying facts lost to a trim. Design then: a trimmed
     message becomes a deterministic one-line record (tool, truncated args, error flag)
     in a capped ring buffer in the regenerated context message. Within a harness
     version, never model summarization (conflates constructs, breaks replay) and never
     per-model context scaling (declared sizes drift for one id).
   - **8b — context engine as a labelled harness value; parked, operator direction.**
     (a) Stretch the window past 24–48 in a future harness version: caching makes a much
     longer prefix nearly free at ~8–12k steady state against 131k–200k contexts.
     (b) Offer threshold-triggered self-compaction as a third value of the ADR-0033
     tuple's `harness` field (ADR-0035), since grow-then-self-compact is what end-user
     agents run under: comparable within a harness if the operator partitions, never
     silently across. Supersedes 8a's flat "no model summarization ever" for a future
     labelled engine, not for unlabelled changes to this one.


32. **Dashboard parity gaps against the deleted pages** (2026-08-22, ADR-0022; the
    pages went in item 31). The cost estimate — (1) — shipped 2026-08-23 as
    `runner/viewer/pricing.ts`, priced from dated, sourced rows rather than the old
    hard-coded table. Left, each deliberate: (2) **Whole-feed expand preset** (Minimal /
    Responses / Snippets / All, remembered in localStorage) — the SPA folds per block
    only. (3) **Compact state samples and called-out harness notices** — rendered
    through the generic-entry path, readable but unstyled. Unblocked by someone wanting
    them; neither blocks release.

35. **Milestone records alongside the state samples** (2026-08-22 strategy session).
    ADR-0018 lists deaths, zones, spells learned and talents spent in the signal vector
    and none is recorded (the `state` table has level, xp, map+xyz, money,
    quests_completed, turn; `quest_complete` is the only event-shaped record). Add a
    `milestone` trajectory record `{ t: "milestone", kind, ... }` emitted from the loop
    the way `quest_complete` is: death (and spirit-healer/corpse recovery), zone and
    area change (ids from the state cache, not names), level-up, spell learned, talent
    spent, first capital, first instance, first group join, first trade. Kinds are
    additive; derivations come later. Why it matters: the ladder page shows rungs 2, 4
    and 6 as "not instrumented" for exactly these (zone change, capital entry, taxi
    use, group join), map replay cannot show death sites or zone coverage (item 22),
    and the freeplay firsts ladder is a derivation over these records plus the model
    label. **First producer exists (2026-08-23):** the loop writes
    `{ t: "milestone", kind: "zone" | "area", from: { id } | undefined, to: { id }, turn, ts }`
    from the state cache's `self.zone` / `self.area` on every change, including the
    first observation (`from` undefined), alongside `quest_complete`
    (`runner/src/loop.ts`, `Trajectory.recordMilestone`). Death, level-up, spell,
    talent and the firsts are still unwritten; the dashboard reads none of them yet.


67. **Freeplay characters do not persist between sessions, which is what the
    "ultra long-term sandbox" actually needs** (2026-08-24, from the ADR-0043
    conversation). `idle: "unlimited"` now gives a model repeated six-hour
    freeplay sessions, but every episode still deletes and recreates a fresh
    level-1 character (ADR-0006), so session N+1 starts where session 1 did and
    the long horizon is six hours, not a week. Carry-over is exactly what the
    scored episodes forbid, so this is not a knob — it needs its own record:
    what identity a resumable freeplay character has, how its run ids and
    trajectory relate across sessions, and how the viewer shows a character
    rather than a run. Out of scope for ADR-0043 deliberately; the six-hour cap
    there is what makes the sessions restartable in the first place.


## Module

79. **module/ has no host-side checks at all** (2026-08-24, bare-clone audit). ~5,900
    lines of C++ with no unit tests, no lint, no static analysis runnable outside the
    live stack — the smoke scripts are the verification and they need the full
    compose stack, so every non-live environment (CI, web sessions, the 2026-08-24
    audit) sees module/ as a blind spot. Deliberate so far (the module stays thin;
    game semantics live in TypeScript), but the boundary deserves a decision rather
    than a default: even a `clang-format --dry-run` or a syntax-only compile in the
    image build would catch mechanical breakage before a deploy window. Next action:
    decide what, if anything, runs without the stack; record it either way.

## Wiki

65. **The build's counters are three hand-synced lists** (2026-08-24, surfaced by
    the simplify pass over `wiki/`; predates that PR's diff). `wiki/src/build.ts`
    states every one of its ~28 metrics three times: a `let`/`Record` in the
    build loop, a `meta` key in the `setMeta` call, and a line in the console
    summary. Nothing ties the three together, so a new counter is added in three
    places and is silently absent from the bundle or the summary if one is
    missed, and the ones that are deliberately *not* part of the accounting
    identity (`pages_pre_announcement_protected`, `pages_id_name_mismatch`,
    `empty_pages`) say so only in a comment beside each of the three. What it
    costs today is small — the comments are good and the meta diff of a rebuild
    catches a drift — which is why this is a follow-up and not a fix: it is worth
    doing when the next counter goes in, as one metric table (name, help text,
    whether it is in the identity, how it prints) that the loop increments, the
    meta write reads and the summary renders. Watch for it the next time a
    counter is added to `build.ts`.

## Docs and release

19. **Pre-public / MCP blockers on the control surface** (fan-out review 2026-08;
    accepted-risk statement in docs/CONTRACTS.md). Shipped so far: the module refuses
    tokens under 32 characters (`400 weak_token`) and the runner issues random tokens
    (2026-08-22), the accounts allowlist on the utility routes, and the sandbox child's
    env allowlist. Still open, and required before any public or MCP-exposed deployment
    or before trusting an adversarial multi-run result: (1) the module issues a random
    secret at session create, returns it only to the creator, and requires it on
    `/action`, `DELETE /session` and `/events` (which today is token-scoped but cannot
    validate against a live session because subscribers connect before it exists);
    module and runner change together, backward compat off. (2) Nothing binds a token to
    a character and the HTTP surface has no authentication, so any caller reaching the
    port can delete any character on an allowlisted account that is not logged in — a
    token-to-character binding plus a shared secret on the port is the floor. (3) A
    snippet can still fs-read `.env` by absolute path; needs filesystem sandboxing (a
    trajectory audit found no run ever did). Item 10 (per-character credentials) is
    folded in here: the account pool delivered run parallelism, and what remained of 10
    — nothing binds a caller to an account or a token to a character — is exactly (1)
    and (2).
