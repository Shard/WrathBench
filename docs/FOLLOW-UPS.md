# Follow-ups

Open items only, grouped by area. Numbers are stable — ADRs, commits and the worklog
cite them — so gaps are normal and nothing is renumbered. When an item ships or is
rejected it leaves this file: the day file in `docs/worklogs/` records it with the
commit, and the number moves to the resolved ledger at the bottom so citations still
resolve. An item with no next action and no trigger leaves the same way, to a GitHub
issue — this file is for work someone could pick up, not for everything known. Each open item says what, why it matters (with evidence), what unblocks it,
and status.

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

## Quests, combat, economy (SDK surface)

9b. **A wait/until primitive, and the error taxonomy behind it** (absorbs item 17,
    2026-08-23: both are one parked decision about how failure and waiting are named).
    About 20 of opus's 85 turns (roster-opus-20260822) were pure 25–28s sleep-polls of a
    background routine. A `sdk.waitUntil(predicate, timeout)`, or letting a snippet
    declare "wake me on event X", would cut turn counts for every model. Held: it smells
    like the convenience middle tier ADR-0015 forbids; decide deliberately with the
    operator, not inline. Item 17's `sdk.wait` alias was the same decision and is folded
    in here. Also still parked from 17: a **machine-readable error class taxonomy** — its
    tiers 1 and 2 shipped 2026-08-22, ADR-0017 settled the BigInt question and
    `events.off` shipped 2026-08-23, but nothing yet gives a snippet a stable class to
    branch on. Partial movement 2026-08-23: ambient `sleep()` now wakes early on attack
    or death with a reason (worklogs/2026-08-23), which covers the two observed reasons
    for polling without adding a predicate API. Unblocks on one ADR covering both halves.

## Fleet and gate


23. **Helm chart for the fleet** (2026-08-22). ADR-0020 made the supervisor a compose
    service shaped as the chart's rehearsal: Deployment (the `fleet` service, `restart:
    unless-stopped` → a restartPolicy), ConfigMap (`infra/fleet.json`, read-only and
    hot-reloaded — a remount is the same edit-the-file steering), PVC (`data/`, which
    already holds every piece of supervisor state: run dirs, `fleet-state.json`, lane
    logs, defer sidecars, `fleet-models.json`). The actual work is the two things that
    do not port: the repo bind mount (the chart wants the harness baked into the image,
    so the `git describe` stamp comes from a build arg rather than a mounted `.git`),
    and `.env` (a Secret mounted at the same path so "never via argv" survives).


47. **A cooldown the agent can actually watch — the premise was wrong** (2026-08-23,
    rewritten 2026-08-24 after a live probe). `state.cooldowns()` is fed by
    `SMSG_SPELL_COOLDOWN` / `SMSG_COOLDOWN_EVENT` and no smoke asserts a running
    cooldown. The item used to say that was a level-1 problem and that a Hearthstone
    would fix it, because its 30-minute cooldown "the server does send". **It does
    not.** Measured on a fresh Human Paladin: `useItem` on 6948 produced
    `SMSG_SPELL_START` (`castTimeMs 10000`), `SMSG_SPELL_GO`, `MSG_MOVE_TELEPORT_ACK`
    and no cooldown opcode of any kind; `state.cooldowns()` stayed empty.
    The source says why, and generalises: `Player::AddSpellAndCategoryCooldowns` sets
    `needsCooldownPacket` only inside `if (GetTotalAuraModifier(SPELL_AURA_MOD_COOLDOWN))`
    (`Player.cpp:11148`), so **no ordinary player cast emits `SMSG_SPELL_COOLDOWN` in
    3.3.5** — the packet exists for cooldowns a *modifier* changed, which is exactly
    the case a client cannot derive. `SMSG_ITEM_COOLDOWN` is the 30-second equip path
    only (`Player.cpp:12048`), not a use path. Both opcodes are tapped by the module
    already (`WbManager.cpp:3913/3932`); they simply never fire. **Do not re-attempt
    this with a bigger character or a different item** — level is not the variable.
    What the probe did establish: the cooldown is real, it is just client-derived.
    It persists (`character_spell_cooldown`: spell 8690 and the category-1176 row,
    both `item 6948`) and comes back at login in `SMSG_INITIAL_SPELLS.cooldowns[]`,
    which the module decodes correctly — a relog read `{spellId 8690, cooldownMs
    1687000}` and `state.cooldowns()` agreed. That block is genuinely untested and
    a smoke *could* cover it: fixture-clear `character_spell_cooldown` (keyed by
    `(guid, spell)`, no guid generator, not in ObjectMgr's reap list — item 57 does
    not apply here), cast, log out, relog, assert. It costs a new smoke, a new
    fixture capability and **~3 minutes on every deploy**, so it is an operator's
    call to price, not a cleanup — and it would cover `INITIAL_SPELLS`, never the
    opcode this item is named for. The one live route to `SMSG_COOLDOWN_EVENT` is
    the potion path (`Spell.cpp:4374`: `IsPotion()` -> `SetLastPotionId` ->
    `UpdatePotionCooldown` -> `SendCooldownEvent`), which needs a purchased potion,
    so it is blocked on item 57 and on a fixture with money. That is the successor,
    and it is the only one. Status: open, unblocked by nothing; the decode stays
    uncovered until a potion route exists.


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



61. **Browser back into a replay restarts it from the beginning** (2026-08-24, a
    consequence of making `/map` and `/map?run=<id>` the only two URL states).
    The cursor is deliberately not in the URL — putting it there would rewrite
    history four times a second under the play slider — so returning to a replay
    by any route reloads its track and drops the cursor at the first recorded
    sample. An operator who scrubbed to hour four, clicked into the run page and
    pressed back gets hour zero. The fix is a per-run cursor remembered in memory
    for the life of the page (a `Map<runId, ts>` consulted when a track loads),
    not a URL parameter. Unblocked by a run long enough for the scrub to be work
    worth not losing; today's tracks are minutes.


74. **Freeplay rows show no episode progress even when their run recorded a real
    watchdog** (2026-08-24, deliberate; re-scoped 2026-08-24 by ADR-0041).
    `rowProgress` in `dashboard/src/lib/fleet.ts` returns null for
    `episode === "freeplay"` because the id is uncapped (docs/EPISODES.md) and a
    percentage would read as a tier fact. The example that motivated this —
    `nav-probe` recording `episodeMs: 21600000` — is a `probing` run now, and
    `probing` is deliberately NOT in that predicate: a campaign sets a real
    enforced clock and the run ends on it, so the percentage means something.
    What remains is the narrower original question: whether a *freeplay* run
    carrying an explicit `episodeMs` should show one too. If the operator wants
    it, deleting one predicate is the whole change, and the freeplay test in
    `dashboard/test/fleet.test.ts` is what would have to say the opposite.


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

37. **World-level log, via achievements** (2026-08-22; later, when the freeplay server
    has more than one agent). Per-session trajectories cannot answer "who was near whom
    when" or "who did X first". Before a bespoke world log, tap the achievement system:
    3.3.5 awards achievements server-side including realm-firsts, and the client
    observes them through `SMSG_ACHIEVEMENT_EARNED` / `SMSG_CRITERIA_UPDATE` — neither
    is in the tap (`module/src/WbManager.cpp` opcode switch) nor in CONTRACTS.md. One
    tap case plus an `achievement` event type gives every character a server-authored
    ledger of firsts for free, contract-clean. A server-wide position sampler (every
    character, ~10s) is the other half and is cheap because the module already sees
    every session; defer until it is the next obstacle.

40. **Group tier — rung 6** (harness-0.4, after 38). Party actions
    (`CMSG_GROUP_INVITE` / `ACCEPT` / `DECLINE` / `UNINVITE` / `DISBAND`,
    `CMSG_LOOT_METHOD`), taps (`SMSG_GROUP_INVITE`, `SMSG_GROUP_LIST`,
    `SMSG_PARTY_MEMBER_STATS`, `SMSG_PARTY_COMMAND_RESULT`), `state.group` in the
    cache, party chat and `whisper`, quest sharing (`CMSG_PUSHQUESTTOPARTY`). Harness
    side: item 10 and a multi-session runner. Consider 3.3.5's Dungeon Finder
    (`CMSG_LFG_JOIN` family): it teleports a formed party into the instance, a
    client-legal way to attempt Deadmines before cross-continent travel and
    instance-portal triggers are reliable. Trade, mail, bank, auction house and guilds
    stay behind the earned-by-need rule until a freeplay run asks.


72. **`SMSG_INITIAL_SPELLS` declares a cooldown count it does not carry** (2026-08-24,
    found while disproving item 47). `Player::_LoadSpells`' packet builder writes
    `uint16(m_spellCooldowns.size())` as the entry count (`Player.cpp:2852`) and only
    *then* skips rows whose `needSendToClient` is false — unlike the spell count two
    lines above, which is fixed up with a `data.put` after the loop. A character with
    a category cooldown therefore gets a packet declaring 2 entries and carrying 1.
    Measured: our Hearthstone probe hit exactly that (spell 8690 `needSend 1`, the
    category-1176 row `needSend 0`). The module's decoder tolerated it cleanly — one
    row, no `decodeError` — but **that tolerance is currently proven by one manual
    observation and by no test**, and it is C++ decode, so nothing in `bun test` can
    reach it. Upstream bug, not ours; the risk is that a future decoder tightening
    trusts the count. Worth a comment at the decode site at minimum. Blocks nothing.

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

33. **Public hosting checklist for the dashboard** (2026-08-22, ADR-0022). Before any
    of it is exposed: **Legal, first and blocking** — minimap tiles are Blizzard
    textures and must not ship; `WRATHBENCH_VIEWER_PUBLIC=1` withholds them (the map
    degrades to a labelled grid) and raw entries and scratchpads, but entry *summaries*
    still carry model output and snippet code and whether those are publishable is
    undecided (DATA-AND-LEGAL). **Auth-less read-only exposure** — the API takes no
    bodies, opens every database readonly and strips bearer tokens, but has no rate
    limit and no cache, and `/api/runs` reads every trajectory on a cold process; decide
    a caching layer and a per-IP limit with the hosting. **Caching** — only `/tiles` and
    fingerprinted assets are cacheable; every `/api` response is `no-store`; short-TTL
    on the listing and the position feed is the cheap win. **A public run set** — a
    public page should not list every run the fleet ever produced (stillborn runs are
    already hidden by default); decide what the listing selects before pointing a domain
    at it.

## Resolved ledger

One line per number so citations resolve; the day file carries the detail.

- 59 — 2026-08-24 — 1257fe2 — cache-write tokens flattened from `prompt_tokens_details` in `toUsage`
- 64 — 2026-08-24 — 7a1cc07 — the protection line is the Cataclysm **announcement** (2009-08-21, `CATACLYSM_ANNOUNCED`), not the beta. 119 of the 588 protected pages were created on or after BlizzCon 2009 and were mostly announced-Cataclysm content (Blackwing Descent, Halls of Origination, Gilneas City, a run of beta ability pages); a page created before the announcement could not have been written about Cataclysm at all. Renamed through the code, the meta key (`pages_pre_announcement_protected`), the tests, `wiki/README.md` and ADR-0040 together. Keeps roughly 500 of the 588
- 63 — 2026-08-24 — 7a1cc07 — the stripper emptied whole articles. Root cause was not the brace scanner: `CONTAINER_TAGS` read a repeated `<ref name="x" />` as an *opening* tag and ate everything to the next `</ref>` — on Orgrimmar's 2010 revision 1,486 characters including the `}}` that closed the infobox, after which `removeBraced` never returned to depth 0 and discarded the page. The scanner is hardened too: brace runs are counted a run at a time (`{{{param|default}}}` no longer opens a phantom `{|` on its third brace, and the mirror case no longer leaks infobox fields out as prose) and closers match their opener's kind. Unbalanced input now costs its own paragraph, not the page — the strip resumes at the first blank line after the unclosed opener. Measured over the dump on the Wrath snapshot: pages that strip to nothing with ≥200 characters of non-template prose 47 → 11 — 22 recovered by the ref fix alone, 28 with the hardened scanner and the fallback stubbed out, 37 with it — so the net catches 9 and the root-cause fixes carry the rest. Orgrimmar, Scarlet Crusade, Crystalsong Forest and Gnoll are among them, and Orgrimmar's era revision now strips to its 10,696 characters of prose; whether the item-49 canary passes needs the operator's rebuild. One page in a 2,457-page sample flips the other way — a bare `<onlyinclude>` achievement box whose text the old over-closing bug leaked out of its template — which is the leakage fix, roughly 35 to 40 pages dump-wide. The residue is table-only pages
- 49 — 2026-08-24 — 40b3054, 9194abb, ac50f51, 551dba1 — the wiki bundle reads the era, not 2020. Prerequisite first: a `<page>` block is 50 revisions, not a page, so the parser merges a title's blocks and the build asserts one row per (title, ns) — 9,693 stale duplicate rows were competing in `pages_fts`. Then prose comes from the newest revision saved before 2010-10-12 (patch 4.0.1) while coordinates, ids and the quest infobox stay on the newest revision, where the corrections are (ADR-0040); the 20,428 pages with no pre-cutoff revision keep their newest text under a fixed page-level label rather than being dropped. Out-of-game reference pages (patch notes, the Lua API, the client UI, addons, boxed products) are classified from the title and sunk below every body hit with a label, never deleted, exact titles never demoted. The runner stamps the bundle's identity (`schema_version`, `built_at`, `source`, `era_cutoff`) into the run's comparability tuple, so a rebuild is visible instead of indistinguishable. Verified on a rebuilt bundle: unlabelled Cataclysm-mentioning pages 2,025 → 650, Deathwing/Shattering/Pandaria mentions 2,032 → 306, the Coldridge Valley "collapse" prose 3 → 0, coordinates −2.6% and ids −1% (the stale duplicate rows going away). **Deploy pending:** the rebuilt bundle sits at `data/wiki/bundle.next.sqlite` and is not swapped in; the swap is a harness minor bump (ADR-0033 addendum) and waits for a deploy window after review. That staged file predates the out-of-world section trim (2026-08-24, ADR-0040), the pre-announcement protection, the stripper fix in item 63 and the empty-row fix in 9f06265, and has to be rebuilt before the swap — it was built with the behaviour that dropped 5,011 pages of this world. **Amended 2026-08-24:** the era rules were dropping 588 pages of this world — a page that existed before the Cataclysm beta had picked up `|patch=4.0.1` or a Cataclysm category in a 2010 revision, and was read as a beta stub; Stormwind City, Durotar, the Barrens, Thousand Needles, Auberdine, Southshore and Camp Taurajo among them. A page whose first revision predates the Cataclysm announcement is now a Wrath page and a post-Wrath signal never drops it (`pages_pre_announcement_protected`; the line moved from 2010-06-01 to 2009-08-21 under item 64), while the section and paragraph cuts still strip what the 2010 editors wrote about the next world; a page with no pre-cutoff prose is counted `dropped_post_cutoff` whatever else it says, which moves 1,429 pages between counters and admits nothing new. Every counter in that build added up, which is why the build now ends with a **canary**: the ten capitals, the eight racial starting zones and the reshaped classic zones must resolve in the finished bundle or the build fails before the rename (`wiki/src/canary.ts`, `--no-canary` for smoke builds), with `wiki/src/verify.ts` as the operator-run pre-swap gate over the same list plus forbidden titles and phrase pairs. Residue is issue #6 (was item 62); 63 and 64 are resolved below
- 45 — 2026-08-23 — 96214db, 614cb08, afd352c, f1c76fb — scenario fixtures (`infra/fixtures`), `travel.ts --from`, tram gate 3/3
- 9 — 2026-08-22 — b3d6c7a, 9ed564d — trainers (`trainer_list`/`trainer_buy_spell`, `trainerList`/`buySpell`)
- 9a — 2026-08-22 — 9ed564d — `questsAvailableFrom`
- 14 — 2026-08-22 — 8ab861e, 4801a35, c422620 — death recovery (teleport acks, ghost movement, spirit healer)
- 14 (duplicate number) — 2026-08-22 — 2db0d93, a0ca9c1 — roster defer ladder, taint, persisted defer state
- 15 — 2026-08-22 — 1f29a2c — un-awaited SDK call killed the sandbox (graduated before this file's rewrite)
- 16 — 2026-08-22 — no code change — quest-giver flicker was a model failure (graduated earlier)
- 18 — 2026-08-22 — 1ddb421 — travel probe; findings folded into item 38
- 20 — 2026-08-22 — 5f3e288, 7be516e — solo auto-loot (graduated earlier)
- 21 — 2026-08-22 — 2ee2e2f — turnInQuest statuses (graduated earlier)
- 22 — 2026-08-22 — 1a2d6a9 — map replay of historical runs
- 25 — 2026-08-22 — ff3ac0f, 444db05 — `search_reference` banded ranking, id channel, repeat memo
- 26 — 2026-08-22 — rejected — `nothing_offered` would fabricate an outcome (worklogs/2026-08-22, ergonomics pass)
- 27 — 2026-08-22 — a4ed1a3, 756eb83 — questgiver status markers; deployed 21:16
- 28 — 2026-08-22 — a4ed1a3, 756eb83 — quest objective text and counts; deployed 21:16
- 30 — 2026-08-22 — 55f8e27, bf65fdf — bundle schema 3 built and swapped; fail-closed open
- 31 — 2026-08-22 — 04b2eae — hand-written viewer pages deleted
- 34 — 2026-08-22 — 0bfe207 — nested-template id kinds (in the swapped bundle)
- 38 N1 — 2026-08-22 code, deployed 2026-08-23 — ADR-0027 — item stays open for the gate run and N2–N4
- 43 — 2026-08-23 — ADR-0036 — pauses are held and resumed by the supervisor: operator-pause at once, provider pauses on the defer ladder by pause count; the claude-code CLI conversation is still not reattached (item 8) — the run resumes fresh, stamped `resumedFresh`
- 39 — 2026-08-22 — d739071, b4c5928, ADR-0025 — spellbook/cooldowns/talents, raw hatch; equipped bags split to 50
- 41 — 2026-08-22, deployed 2026-08-23 — d1255d7 — `/health` build id
- 42 — 2026-08-22 — 1a2d6a9, d3e39d6 — server identity in the dashboard; per-run server build in the tuple
- 44 — 2026-08-22 — 6156b5f, 2f19f75 — cooperative abort of abandoned snippets
- 47 (duplicate number, wiki leads) — 2026-08-23 — renumbered to 49
- 8c — 2026-08-23 — merged into 8
- 48 (a)–(f) — 2026-08-23 — 56bfdef, 634e58c, 277f948 — episode tiers wiring; (g) stays open under 48
- 46 — 2026-08-23 — a97c3c8, 2b60cb0 — `MSG_MOVE_TELEPORT_ACK` tapped, `teleported` status, ground-z ladder with `move_to.guid`, stop on supersede/planning failure; ADR-0027 amendment. Deployed and verified: live as `harness-0.4-3-g8f6939d` since ~14:00, `infra/smoke/module-navigation.ts` PASS on SMOKE3 and the gate PASS
- 17 — 2026-08-23 — folded into 9b — failure-surface audit: tiers 1–2 shipped 2026-08-22, ADR-0017 settled BigInt, `events.off` shipped 2026-08-23; the `sdk.wait` alias and the error-class taxonomy are parked under 9b
- 48 (g) — 2026-08-23 — no code change — flagless runs are not tier members (`episode: null`, counted by nothing in ADR-0034), so the bare idle 10m / no-XP 45m defaults stay; written down in docs/EPISODES.md
- 51 — 2026-08-23 — ADR-0037 — `unknown_target` as an SDK-side status and `ConnectOptions.deadline` as explain-not-cap; PROTOCOL.md was already in sync, CONTRACTS.md gained the typed map-change outcomes and the teleport-ack observable; the prompt.ts wording moved to item 54
- 13 — 2026-08-23 — ADR-0018 amendment — the ladder's row ordering is stated and versioned: highest rung, then total XP as the lexicographic `(level, xp)` pair, then gold; both tie-breaks shown on the row with the run each came from, nulls sort last, no aggregate score
- 32 (1) — 2026-08-23 — 46e2726, 7423453, 62bc30a — run cost card in `runner/viewer/pricing.ts`; (2) and (3) stay open under 32
- 55 — 2026-08-23 — c89d984 — not a lost verdict: every "timed-out" `WB_MOVE_RESULT` in the post-deploy nav-probe c4 arrived later (27/27, audit log cross-reference); the caller's own short `timeout` sized from straight-line distance was the cause, so the SDK now says how far is covered/left and that the move is still walking, and hints pre-flight when a timeout is under 1.5× the walk. Loot half: zero `SMSG_LOOT_RESPONSE` timeouts across every run on `harness-0.4-3` (3000+ loots); reopen only if a sonnet-lane run with real loot volume shows them again
- 24 — 2026-08-23 — 4f5cb8a — `accountHeldBy` tests activity age before opening a run dir; paused runs are deliberately not "held" (the supervisor's resume-before-fill reserves their account)
- 36 — 2026-08-23 — 6f1ffd5 — `character` and `platform` are run columns (`runner/src/platform.ts`); `local` = loopback/RFC-1918/.local, the same test billing uses
- 52 — 2026-08-23 — 56bdb8d, 1345621 — one policy-membership predicate in `runner/src/models.ts`; `/api/models` excludes pinned refs and serves `policy.maxConcurrent`; fleet page reads `session` and `jobs`
- 10 — 2026-08-23 — folded into 19 — parallelism came from the account pool and classes (ADR-0034); the credential binding that remained is item 19's (1)/(2)
- 29 — 2026-08-23 — 314156b — local models past their targets play freeplay (`policy.extras.local`), so the inference-bound caveat is a property of the class, not a standing item
- 53 — 2026-08-23 — 4b82bf9, 4de6da0, 61d683f, 29b33ba — the evidence was one `reclaimCorpse` call (attempts: 10) from 387y, later reclaimed by walking back; the gap was information: the module now asks `MSG_CORPSE_QUERY` on repop like a client, `state.self.corpse`/`graveyard`/`reclaimDelay`, `not_reclaimed` names one reason (too_far with distance, delay_not_elapsed, wrong_map, no_corpse), the ghost HUD line states both options and the healer's cost; module in `:next`, smoke pending deploy
- 54 — 2026-08-23 — 61d683f — the prompt's sleep line carries a worked wake-reason example (pre-v1 prompt tuning ships as a patch)
- 50 — 2026-08-23 — see the day file — worn-bag contents decoded (`numSlots`, `bagSlot<n>Lo/Hi`), `bag()` spans backpack + worn bags with `totalSlots`/`bags`, HUD total across bags, `items` state column on the run and map pages; module in `:next`, `infra/smoke/inventory.ts` pending deploy. Items 57/58 unchanged
- 56 — 2026-08-23 — ac539d3 — `CMSG_AREATRIGGER` fires once on crossing into a volume (per-session inside set, cleared on exit/teleport), not every 1.5s while inside; live as harness-0.4-66
- 68 — 2026-08-24 — found and fixed the same hour — the `--status` accounts table named a finished job where `--live-runs` named the running one. `state.jobs` is keyed by job NAME, stable across attempts, so it is a cumulative record; `printStatus` keyed a map by account and let the last write win, which reads the object's INSERTION order (first-spawn order), so a job that exited at noon masked the run holding the account. Display only — every scheduling path leases by `accountHeldBy` — but it made the board unreadable at exactly the moment a deploy needed reading. Now `jobsByAccount` in `infra/run-fleet.ts` ranks live-before-dead then newest-first, shares one liveness verdict with the row's own note, and reports two live jobs on one account as a `!!` clash instead of picking silently. The comment claiming `--live-runs` was "the same signal --status shows" is corrected: they are two sources, and that claim is how this hid
- 69 — 2026-08-24 — `infra/` had no tsconfig, so nothing ever typechecked the 3.6k-line supervisor: `bun test` strips types without checking them, and four `fleet.test.ts` fixtures were silently missing the `idle` and `local` fields that ADR-0043 made required. `infra/tsconfig.json` added, the 17 errors it found fixed (4 fixtures, 12 index/group assertions in `infra/smoke/`, 1 import extension), and `bun run typecheck` now covers all six projects — cited in CLAUDE.md next to `bun test` so the next agent runs both
- 62 — 2026-08-24 — moved to issue #6, not resolved — the wiki bundle's remaining era-rule imprecision (the paragraph rule's ~0.8 precision floor, and the ~15 late pages whose id and name both exist in the 3.3.5 DB). Open-ended measurement work with no trigger and nothing blocked behind it, so it is tracked where open-ended things belong. Its other two bullets were genuinely resolved (d0f3ec8, ADR-0042) and the issue keeps them as history
- 76 — 2026-08-24 — 1685dac — the paid account class is split unconditionally, like `local`; `paidPoolOf` deleted, `policy.paid` is only the cap now. An unconfigured paid class HOLDS its picks and names them instead of spilling them onto free pool accounts
- 66 — 2026-08-24 — 4eb455d, 64319d9 — an account-rule violation refuses the PIN, not the file: the offending job or campaign is disabled in place and named in `config.refusals` (a `!` block in `--status`, a `config-refusal` event in the supervisor), and the rest of the file takes effect. Jobs and campaigns are one `Pin` list checked in file order; shape errors and duplicate names still fail. 64319d9 fixed a regression in the first commit: a refused pin is disabled, and `diffJobs` drains a running job whose spawn is disabled, so a refusal would have SIGTERMed a live campaign probe where the whole-file rejection left it alone — a refusal now suppresses scheduling only, and the tick spares (and records) any live run under a refused pin. The preflight-vs-disabled-job gap the item also raised is NOT closed — the clash check still reads only enabled pins, so a disabled job may still park on the gate's account unremarked. It is harmless now rather than fixed: enabling it later refuses that job instead of taking the file down
- 73 — 2026-08-24 — 2b0b968 — comment only: `playtimeMs` no longer claims the episode watchdog resets on every resume (08cd691 gave it `elapsedBeforeMs`); it now says where the two clocks still diverge
- 63 (re-scoped), 70, 71 — 2026-08-24 — see the day file — probe campaigns landed as the third lane (ADR-0041, commits 8cfabb1..9cf583b). Not a resolution of 63: it is narrower now, because the `nav-probe` example that motivated it is a `probing` run and `probing` is deliberately outside the predicate. 70 was withdrawn the same day — see its own ledger line
- 58 — 2026-08-24 — 9848d70 — the loot half, with the durability half quantified and left open. `kill-credit.ts` empties `Smokekc`'s backpack at the START of the run, not before logout: start-of-run is idempotent, it runs after a previous run failed and skipped its own cleanup (exactly when the bag is fullest), and it makes the loot line readable as "N free, then loot arrived". `destroy_item` goes through the module like a client's delete, so no fixture and no item-57 guid problem. The keep rule fails toward keeping — only a slot positively identified as non-keep is destroyed, unidentified slots are kept and named, and 6948 is protected, because a fixture cannot restore a Hearthstone it destroys. Best-effort and reported, never asserted: it uses `req()` not `action()`, so a refusal is a log line and the run carries on to its real claims — a cleanup failure must not be indistinguishable from the loot bug this prevents. An empty read is reported as "contents unknown", not as a reassuring zero. Found in passing: the real accumulation is ~2-3 items per run, not the 0-1 the item assumed, and five runs' backlog was already sitting there. Durability is NOT fixed and is not close to biting: both durability-bearing items were 25/25 before and after three fights, and the steady-state drift is ~0.5% x 2/19 slots per damage event — order of one point per ~100 runs, thousands of gate ticks from zero. `DurabilityLoss.OnDeath` is the only fast path and this smoke treats a death as a failure by construction. A repair needs a vendor, a walk and money; open when something makes it worth that
- 71 — 2026-08-24 — closed as not a problem, measured rather than argued — `campaignWork` costs 0.063 ms/tick on the shipped board and 2.1 ms/tick on the twelve-campaign, 5000-probe-run board the item said "would notice", against a 60s tick. The memoisation it proposed would have bought nothing and cost a cache to invalidate. The one repeated search — a `campaigns.find` inside the sort comparator — is precomputed instead (6fbc72c)
- 70 — 2026-08-24 — withdrawn, not fixed: the item described intentional behaviour on a premise the code contradicts. The ladder is per roster entry (`matchesRoster` is model + effort), so no model's failure can cool another. It is climbed ONLY by a stillborn launch or `adapter-error` (`NO_PROGRESS_REASONS`), both endpoint properties — a probe that runs its full episode and achieves nothing ends `episode-limit` or `idle` and does not climb it at all. So the item's own revisit trigger, "a campaign with a harder task starts retiring models that were fine on e90", cannot occur: task difficulty is invisible to the ladder. Sharing it across lanes is correct and needs no lane key
- 75 — 2026-08-24 — 6287b0a — `/api/info` carries `dashboardBuild` (Vite's fingerprinted entry name, parsed from index.html, cached on mtime); the SPA keeps the first id it sees — its own, since index.html is `no-store` — and shows a `new build — reload` button beside the status badge when a later poll disagrees. The item's other half was ALREADY true: `staticFile` has served index.html `no-store` all along, verified against the live viewer
- 60 — 2026-08-24 — dec01d2 — both halves. The fallback lattice batches into one stroked path of at most 130 segments (below `TILE_MIN_PX` nothing is drawn into a cell, so nothing can be covered; the per-cell arm above the threshold is untouched because there a drawn tile must suppress its own outline). The replay route is decimated to screen resolution in world units, with the tolerance taken from the scale alone so a pan reuses the cache and only a zoom or a new prefix rebuilds it. Geometry lives in `mapview.ts` as pure functions with 13 tests; the decimation measures against the last KEPT point, which three of them catch
