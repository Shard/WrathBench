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

1. **38** — N1 passed 2026-08-23; next is N2 (innkeeper bind) and N3
   (`SMSG_SHOWTAXINODES`, the destination-choice surface, still untapped).
2. **35** — milestone records; rung 6 of the ladder reads "not instrumented" until
   grouping and instance records exist, and death/level-up/spell/talent are still
   unwritten.
3. **19** — before anything is public or MCP-exposed: shared secret on the port,
   token-to-character binding, filesystem sandboxing.

## Navigation

38. **Navigation plan — rungs 2–4** (2026-08-22; supersedes item 18). Rung 4 — a
    capital, the tram, one flight, unaided — is the public release trigger
    (VISION.md). Scoped to walking, the Deeprun Tram and flight masters; boats,
    zeppelins and elevators are rung-7 work. Source: the 2026-08-22 spatial-delivery
    synthesis and the travel probe (worklogs/2026-08-22).
    - **N1 — actions and statuses: shipped and deployed** (commits
      92f7df1..b88dd1d, live as `harness-0.3-68` since 2026-08-23). Typed `no_path`
      causes with the subdivision retry in the module, `CMSG_AREATRIGGER` on entering
      a DBC volume, transfer packets tapped and `waitForTransfer` typed,
      transport-relative movement. **Gate passed 2026-08-23** on `harness-0.4-73-gafd352c`:
      `travel.ts --from tram-ironforge --rides 3` (item 45 fixture) rode IF→SW three
      times with typed success on every leg, boarding on attempt 1 each time, rides
      60s; N1 is proven. One residual left: triggers are only tested while a
      `move_to` is active.
    - **N2 — field-level observations**, each small, each earned, each logged.
      **Shipped 2026-08-23 (an N1 amendment, built to `:next`, awaiting the deploy
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
      as model observation (the map stays operator-only), the TaxiPath /
      areatrigger_teleport tables, walkability masks, a persistent map notebook (a
      labelled context-engine change under 8b if ever). Wiki coordinates are a run
      dimension withheld from scored runs (docs/METHODOLOGY.md, "Episodes, lanes,
      and evidence"); pull back to a labelled coords
      tier only if the names-only ladder proves unclimbable.

## Episodes and results

8. **Cross-driver cost is not comparable, because the two harnesses do not
   spend context the same way** (recorded, not penalised: the harness is a tag on every
   row, docs/METHODOLOGY.md, "What WrathBench measures"). The fixed loop trims and its
   requests plateau; the claude-code harness applies no policy at all, so one CLI
   conversation grows linearly (~200k tokens by the end of a 90-minute episode,
   roster-sonnet-20260822, COSTS.md), the lane's spend is mostly cache-read replays of a
   growing prefix, and a `quota-exhausted` pause loses the context on resume. Read
   first: `fleet-nav-probe-sonnet-20260822-c2`, a 6h e360 completed naturally at $43.90.
   The prompt half is closed — since 2026-08-29 each harness's prompt states its own
   context regime and the two hash differently in the comparability tuple, so a
   cross-driver comparison is visibly over two prompts rather than looking like one.
   What remains is the operator's: whether the claude-code harness should have a
   context policy at all, or stay the deliberate "the CLI owns its history" arm, and if
   the latter, what a $/level or $/turn chart may say across the two harnesses. Both are
   methodology, not implementation — nothing here is an agent's to decide.

35. **Milestone records alongside the state samples** (2026-08-22 strategy session).
    The signal vector lists deaths, zones, spells learned and talents spent
    (docs/METHODOLOGY.md, "Scoring") and none is recorded (the `state` table has level, xp, map+xyz, money,
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
    talent and the firsts are still unwritten. **First consumer (2026-08-25):**
    `scanRunTotals` reads the zone/area marks in its existing streaming pass and
    `ResultRun.areas` carries `{ startArea, distinctAreas, leftStartArea,
    capitalZone, zoneMarks, areaMarks }` (`runner/viewer/tail.ts`
    `areaFactsFrom`), from which ladder rungs 2 and 4 now derive
    (`dashboard/src/lib/ladder.ts`); a run with no marks reads `null`, never
    `false`. **Achievements and flights (2026-08-25, issue #8):** the
    loop also writes `{ kind: "achievement", id, name?, points?, categoryId? }`
    per own earn, `{ kind: "achievements_at_login", ids, points }` once per
    process (written even when the backlog is empty — it is what says the taps
    were live for the run), and `{ kind: "taxi", from: { areaId } }` /
    `{ kind: "taxi_landed", to: { areaId } }` from `self.taxiFlight` flipping
    after an accepted reply. `ResultRun.achievements` / `.taxi` and
    `RunDetailResponse` carry them (`achievementFactsFrom`, `taxiFactsFrom`),
    rung 4 now derives fully (capital **and** a flight), and achievement points
    are displayed only — no ordering reads them. **Deaths and levels
    (2026-08-29):** the loop writes `{ kind: "level", from: number | undefined,
    to, xp?, turn }` on every change of `self.level` (the first observation of a
    process carries no `from`, exactly as the first zone does, so a level-up is
    a mark that carries one and climbs), and `{ kind: "death", observedTs?,
    position?: { map, x, y, z, source }, zone?, area?, released? }` plus
    `{ kind: "release", graveyard? }` / `{ kind: "resurrect" }` from the ghost
    flag. The death is read as a *window* — the cache latches the corpse and the
    reclaim delay until the resurrect, so a sample landing anywhere inside it
    recovers the death and stamps it with the cache's own time rather than the
    sample's; a window that opened and closed between two samples still leaves
    nothing, the usual lower bound. `RunTotals.leveling` / `.deaths`
    (`levelUpFactsFrom`, `deathFactsFrom`), `ResultRun` and
    `RunDetailResponse` carry them; the level mark is the liveness witness that
    lets "never died" read as `0` where "not recorded" reads `null`, the job
    `achievements_at_login` does for flights. Nothing renders them yet.
    **What remains:** spell learned, talent spent, the "firsts" (first trade,
    first instance, first group join) and grouping/instance records. Rung 6 is
    still nobody's — it needs a party record and an instance record, and the
    harness runs one character per session; its framing is issue #9.

90. **The freeplay pilot is queued behind class-probe, and one lane cannot do
    both** (2026-08-28, with the roster refresh). `nemotron-super` carries
    `idle: "unlimited"` and is also the only working model left in
    `campaigns.class-probe`. The policy consumes candidates in three ordered loops
    — scored evals (`runner/src/models.ts:1535`), campaign probes (`:1580`), then
    idle/freeplay (`:1613`) — so its eight cells (up to 90m each) all run before the
    freeplay session starts, roughly twelve hours out. It is also the only free lane
    whose tier targets are met, so it is the only one eligible for idle work at all;
    the others still owe scored runs. `policy.maxConcurrent.openrouter: 1` means it
    cannot do both at once either. Next action: operator picks which the lane spends
    tonight on — leave it (class-probe sweeps, freeplay follows), or drop it from
    `class-probe.models` so freeplay starts now and the campaign idles until another
    free lane meets its targets. Related: raising the openrouter cap to 2 would let a
    cleared lane's scored run and the sweep overlap, at the cost that a mid-run 429
    on a scored run is unrecoverable (scored lanes never resume).

93. **`fleet-update.sh graceful` cannot complete while a freeplay stream is live**
    (2026-08-29). Graceful sets the pause switch and then waits for every live run
    to "finish on its own clock" — an `idle: unlimited` freeplay session has no
    clock, so the wait runs to its 8h ceiling. Observed on the 2026-08-29 recreate:
    the switch paused the sonnet-low stream at once (55 min lost), the script sat on
    "2 job(s) still live", and aborting it left the switch set, so `force --yes` had
    to follow and then `resume` to clear it. Now that freeplay streams pause and
    resume in place (98ed9f1), graceful should count a paused freeplay stream as
    drained and proceed; and an aborted graceful should say the switch is still set.
    Next action: teach the wait loop that `operator-pause`d freeplay runs are done,
    and print the resume hint on Ctrl-C.

## Docs and release

85. **Retire the gate Worker before launch** (2026-08-25; operator's explicit
    direction). The public dashboard currently runs the **Gated** shape —
    `dashboard/worker/index.ts` serving both the SPA and `/v1/*` from a private
    R2 binding behind a shared password — because the account has no zone and,
    on Cloudflare, access control and cache are custom-domain features. That is
    scaffolding for a private preview and **not what launches**. The launch
    shape is the design doc's **Open** one: R2 behind a custom domain with cache
    rules, an assets-only Worker with no `main`, and therefore no Worker
    invocation anywhere in the read path — so a traffic spike is absorbed by the
    edge cache at ~$0 and never reaches the lab or a per-request compute bill.
    Unblocked by a zone on the account (a nameserver move for an existing domain
    or a new registration; `shard.page` was considered and declined 2026-08-25
    because it points elsewhere). Then: attach the data custom domain, add the
    two cache rules, apply `infra/cloudflare/r2-cors.json` with the real origin,
    rebuild with `VITE_WRATHBENCH_SNAPSHOT_BASE=https://data.<zone>`, drop
    `main` and the `r2_buckets` binding from `dashboard/wrangler.jsonc`, delete
    `dashboard/worker/`, and remove `dashboard/worker` from the root typecheck
    loop. Gated by issue #10 (entries/game-text) in the same breath, since
    removing the gate is what makes the deploy genuinely public.

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
