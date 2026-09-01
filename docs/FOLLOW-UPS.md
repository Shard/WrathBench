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

1. **Issue #41** — the scratchpad edit op (research edit-vs-rewrite across
   harnesses first); the player surface itself is complete as of 2026-08-30.
2. **38** — N1 passed 2026-08-23; next is N2 (innkeeper bind) and N3
   (`SMSG_SHOWTAXINODES`, the destination-choice surface, still untapped).
3. **110** — the viewer's last two wiring lines for the spell/talent/trade
   milestones (item 35 shipped the producers, the facts and the render;
   `runner/viewer/api.ts` was owned by another agent that day).

## Player surface

The 2026-08-29 fan-out audit (three subagents — the SDK surface, the module's
taps, and every trajectory to date) found a character who can walk, fight, quest,
train, fly and bind, and who cannot see or spend most of what a level-10 player
handles. Observed need is thin on purpose here: across 11 Claude runs no snippet
ever called `sdk.raw()` and the highest level reached was 9, so nothing below is
"a trajectory asked for it" — it is the surface a player needs before a run can
get far enough to ask. **Operator's decision, 2026-08-29: complete the basic
player surface, each piece validated by a smoke test, before any 0.6 talk.**
Items 95–101 all shipped the same day (97f4e31, dc8c9aa, 3dfd712, 5981a29;
worklogs/2026-08-29).

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
      smoke is corrected to the server's answer. **Innkeeper bind shipped 2026-08-29,
      deployed as `harness-0.5-225-ga2c0bd2`, gate passed the same day
      (`innkeeper-bind.ts`: login bind Coldridge Valley 132 → bind at Firebrew
      lands 0.0y from the character as Ironforge 1537):** `SMSG_BINDER_CONFIRM` / `SMSG_BINDPOINTUPDATE` /
      `SMSG_PLAYERBOUND` tapped, `CMSG_BINDER_ACTIVATE` on the raw allowlist,
      `state.self.bindPoint` (map, xyz, area id + AreaTable name), `bindAtInnkeeper`
      typed, HUD `home: Ironforge — map 0 (x, y, z)`. Payloads in
      worklogs/2026-08-29. Gate: `infra/smoke/innkeeper-bind.ts` (scenario
      `inn-ironforge`). N2 is complete.
    - **N3 — flight paths, shipped 2026-08-29, deployed as
      `harness-0.5-225-ga2c0bd2`, probe gate passed the same day:**
      `SMSG_SHOWTAXINODES` tapped exactly as the wire has it (show flag, guid,
      current node, 14-word mask) plus the mask decoded to `known[]` named from the
      client's `TaxiNodes.dbc`; `state.lastTaxiNodes(guid)`, `showTaxiNodes(guid)`
      (hello → the icon-2 taxi option → window), `activateTaxi(guid, nameOrId)`
      typed over raw `CMSG_ACTIVATETAXI` with a hint per `ActivateTaxiReply` code.
      Never the TaxiPath catalogue, never node positions, never a nearest-master
      lookup. `infra/smoke/taxi-nodes.ts` passed (window current 6 Ironforge,
      known 6/8/100 — 100 Honor Hold is the core's Alliance starting mask, not the
      fixture's; `activateTaxi(gryth, "Thelsamar")` accepted, fare 105c;
      `taxiFlight` true → false at 97s; landing zone Loch Modan). **Remaining:**
      the "unaided" half of the gate — a model discovers and uses a flight master
      on its own (N4 evidence). Residual seen on the gate: `state.self.position`
      still read the takeoff point after landing (the fold does not follow the
      flight spline; the zone did move) — a model reads its landing spot from
      `self.zone` until its first own step. Open question for the operator:
      whether the `TaxiNodes.dbc` node positions (which the client draws on its
      taxi map) are a contract-clean observation; withheld until decided.
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
    loop. One more step since 2026-08-30: the map page requests `/tiles/...`
    same-origin, which only resolves while one Worker serves both the SPA and
    the bucket. In the Open shape those requests need the data hostname (the
    tiles are published under `tiles/` in the same bucket, so a
    `VITE_WRATHBENCH_SNAPSHOT_BASE`-relative tile URL plus a cache rule and a
    CORS entry for the prefix), and whatever replaces the gate has to keep them
    behind it. Gated by issue #10 (entries/game-text) in the same breath, since
    removing the gate is what makes the deploy genuinely public.

108. **Split `sdk/src/client.ts` / `protocol.ts` / `state.ts` along their shared seam**
    (consolidation scan 2026-09-01; the `infra/run-fleet.ts` half shipped, see the
    2026-09-01 day file). `client.ts` (5.9k), `protocol.ts` (2.2k) and `state.ts`
    (4.5k) share the same pets/group/mail/bank/trade/loot/item-text seam, already
    bannered in the first two — split all three identically (`*-social.ts`) so they
    stay paired, adding the banners to `state.ts` first. Mechanical, no behaviour
    change, its own session; the SDK surface the model sees does not move. The
    `--status` half of `run-fleet.ts` is back to Mark: `printStatus` reads ~20
    scheduler-side values (the eleven `format*` helpers, `planResumes`,
    `planStaleRuns`, `streamsFrom`, `loadConfigForRead`, `pausesOnDrain`, …) while
    `main` and `--dry-run` call back into it, so the plain move is an import cycle,
    not a seam. Leave it, or move the planners and formatters with it — his call.

109. **Pre-open-source checklist** (2026-09-01). Mark's calls, each small: (a) the
    operator's first name appears in ~38 worklog lines — keep, or `the operator`;
    (b) the footer and BibTeX link to `github.com/Shard/WrathBench` 404 while the repo
    is private (`dashboard/src/components/Layout.tsx`, `pages/About.tsx`) — hide until
    it opens, or open first; (c) `sdk/generate-api-docs.ts` fails `docs:api` on three
    undocumented exports (`nameMailSenders`, `petCommand`, `questDetailsFrom`);
    (d) the copy review's voice rewrites and cuts not yet taken (Home intro, About
    "reading a result", the StreamChart caption, Models/Campaigns intros — see the
    2026-09-01 day file). Trigger: the day before the repo flips public.

110. **Wire the spell/talent/trade facts through `runner/viewer/api.ts`**
    (2026-09-01, item 35's leftover). The producers, the derivations, the public
    projection, the types and the run page all shipped; two lines in the viewer's
    request handlers did not, because `api.ts` was being edited by another agent
    that day and was off limits. Until they land, `RunDetailResponse.spells` /
    `.talents` / `.trades` are `undefined` and the run page's milestones section
    reads "not recorded" for those three rows however much the trajectory holds.
    Exactly two edits, both mechanical: in the `/api/runs/:id` body (beside
    `deaths: tail.deaths`) add `spells: tail.spells`, `talents: tail.talents`,
    `trades: tail.trades`; and in `resultRuns()` pass `resultRunOf`'s new
    trailing `learning` argument after `totals?.deaths ?? null`:
    `totals === null ? undefined : { spells: totals.spells, talents: totals.talents, trades: totals.trades }`
    (omitted, never nulls, so an unwired viewer says "does not answer" rather
    than "the run recorded none"). Trigger: next time `api.ts` is free.
