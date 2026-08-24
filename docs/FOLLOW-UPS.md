# Follow-ups

Open items only, grouped by area. Numbers are stable — ADRs, commits and the worklog
cite them — so gaps are normal and nothing is renumbered. When an item ships or is
rejected it leaves this file: the day file in `docs/worklogs/` records it with the
commit, and the number moves to the resolved ledger at the bottom so citations still
resolve. Each open item says what, why it matters (with evidence), what unblocks it,
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


47. **A cooldown the agent can actually watch** (2026-08-23; small, after item 45).
    `state.cooldowns()` is fed by `SMSG_SPELL_COOLDOWN` / `SMSG_COOLDOWN_EVENT`, and no
    smoke asserts a *running* cooldown because a level-1 character cannot produce one:
    3.3.5 sends those packets only for cooldowns the client cannot derive, so GCD-only
    spells are silent (measured on a Human Paladin: 21084 and the racial 59752 both
    emit `SMSG_SPELL_GO` and nothing else; worklogs/2026-08-23). `spellbook.ts` asserts
    `SMSG_SPELL_GO` instead, which leaves the `SMSG_SPELL_COOLDOWN` decode with no smoke
    coverage — the login-time `cooldowns[]` block in `SMSG_INITIAL_SPELLS` is empty at
    level 1. When a smoke has a character past level 1 — or a Hearthstone `use_item`,
    whose 30-minute cooldown the server does send — assert the packet and the cache
    entry, and `SPELL_GO` goes back to being a cast-path check. Unblocked as of
    2026-08-23: item 45 shipped, so `trainer-northshire` (level 4) or any fixture
    character is available, and the Hearthstone route needs no fixture item row at all
    — every character is created holding one, server-side, so item 57's guid problem
    does not apply.


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

58. **The gate's fixture characters accumulate what a fixture cannot clear**
    (2026-08-23, from the kill-credit fixture conversion). `Smokekc` is now
    persistent and loots a kobold corpse every tick, into a 16-slot backpack that
    `infra/fixtures/scenarios.ts` deliberately refuses to touch (item 57: item guids
    are not safe to write from outside). Durability drifts down on the same clock.
    Neither bites for days — the observed loot is 0–1 items and a copper per run —
    but a full bag makes `loot_all` stop proving what the smoke says it proves, and
    the failure will read as a loot bug. Cheapest honest fixes: have the smoke sell
    or destroy through the module before logout, or rotate the character. Do it when
    the gate first fails on loot, or before leaving the fleet unattended for a week.

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


## Wiki

62. **What the Wrath bundle still cannot decide** (2026-08-24, from item 49;
    rewritten when the bundle stopped labelling and started dropping, ADR-0040).
    Two residues, both precision rather than correctness now, and one open
    decision.
    - **The paragraph rule's floor.** The phrase rules (`in Cataclysm`, `with
      Cataclysm`, `after the Shattering`, `upcoming`/`beta` beside Cataclysm or
      Deathwing, `will` within 60 characters of `Cataclysm`) reach the prose that
      names the expansion. What they cannot reach is 2009–10 prose written
      present-tense about a zone or NPC that had been *announced* but not
      shipped, without naming it — the pre-cutoff revision is the one saying it,
      so no revision line helps. Precision on a hand-checked 33-paragraph sample
      is about 0.8: `with Cataclysm` also catches "removed with Cataclysm",
      which is a statement about content that *is* here. Direction when a run
      shows it costing something: the wiki's own `{{cata-inline}}`-style
      templates, which mark the clause rather than the section.
      **Narrowed 2026-08-24** by an adversarial read of the built bundle rather
      than a count of it: rated battlegrounds, the Speedbarge, an inline
      `(Expansion: …)` tag, `playable` beside worgen or goblin, Archaeology the
      profession and Mastery the stat are rules now, and a category page whose
      own title names a post-Wrath zone is a page-level signal in ns 14 (33
      stubs). That is a dent in this residue, not a fix: prose describing the
      later world in words no rule names is still there, and the only general
      answer is still the clause-marking templates above.
    - **A recovered name the bundle would rather not answer to.** The redirect
      rules added on 2026-08-24 (ADR-0040 §Names survive page moves) recover a
      title from the newest revision or from an `(original)` sibling, which is
      how `Deadmines` and `Gnomeregan` come back. Out-of-game titles are
      excluded, and a title with a post-Wrath parenthetical or subpage suffix
      never had a page to recover. What is not excluded is a bare ns-0 title
      that is a later world's coinage whose newest revision redirects to a
      Wrath lore page that survives — `Ruins of Gilneas` → `Gilneas` is the
      shape. `verify.ts` resolves its forbidden titles through the redirect
      table, so this fails the pre-swap gate rather than leaking quietly; check
      it on the next real build and add a source-side veto if it fires.
    - **The 18,717 undecidable late pages.** Of the 20,407 pages with no
      pre-cutoff revision, 1,901 are provably post-Wrath and 15 carry an explicit
      Wrath signal (`post_cutoff_wrath_signal` admits those). The rest say
      nothing either way and are dropped. Most of them are almost certainly
      correct about 3.3.5 — items, NPCs and quests documented late — and the
      bundle is smaller than it needs to be by roughly that much.
    - **Open decision, for the operator.** The only rule that reaches those
      18,717 is a **server-side id cross-check**: admit a post-cutoff quest, NPC
      or item page whose stated id exists in the world DB. The wiki tooling reads
      nothing from the server by design (CONTRACTS.md), and the id tables are
      not something a client could query, so this is an operator call about what
      the *build* may read — not about what the agent may see. Deliberately not
      implemented pending that decision (ADR-0040).

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

- 64 — 2026-08-24 — 7a1cc07 — the protection line is the Cataclysm **announcement** (2009-08-21, `CATACLYSM_ANNOUNCED`), not the beta. 119 of the 588 protected pages were created on or after BlizzCon 2009 and were mostly announced-Cataclysm content (Blackwing Descent, Halls of Origination, Gilneas City, a run of beta ability pages); a page created before the announcement could not have been written about Cataclysm at all. Renamed through the code, the meta key (`pages_pre_announcement_protected`), the tests, `wiki/README.md` and ADR-0040 together. Keeps roughly 500 of the 588
- 63 — 2026-08-24 — 7a1cc07 — the stripper emptied whole articles. Root cause was not the brace scanner: `CONTAINER_TAGS` read a repeated `<ref name="x" />` as an *opening* tag and ate everything to the next `</ref>` — on Orgrimmar's 2010 revision 1,486 characters including the `}}` that closed the infobox, after which `removeBraced` never returned to depth 0 and discarded the page. The scanner is hardened too: brace runs are counted a run at a time (`{{{param|default}}}` no longer opens a phantom `{|` on its third brace, and the mirror case no longer leaks infobox fields out as prose) and closers match their opener's kind. Unbalanced input now costs its own paragraph, not the page — the strip resumes at the first blank line after the unclosed opener. Measured over the dump on the Wrath snapshot: pages that strip to nothing with ≥200 characters of non-template prose 47 → 11 — 22 recovered by the ref fix alone, 28 with the hardened scanner and the fallback stubbed out, 37 with it — so the net catches 9 and the root-cause fixes carry the rest. Orgrimmar, Scarlet Crusade, Crystalsong Forest and Gnoll are among them, and Orgrimmar's era revision now strips to its 10,696 characters of prose; whether the item-49 canary passes needs the operator's rebuild. One page in a 2,457-page sample flips the other way — a bare `<onlyinclude>` achievement box whose text the old over-closing bug leaked out of its template — which is the leakage fix, roughly 35 to 40 pages dump-wide. The residue is table-only pages
- 49 — 2026-08-24 — 40b3054, 9194abb, ac50f51, 551dba1 — the wiki bundle reads the era, not 2020. Prerequisite first: a `<page>` block is 50 revisions, not a page, so the parser merges a title's blocks and the build asserts one row per (title, ns) — 9,693 stale duplicate rows were competing in `pages_fts`. Then prose comes from the newest revision saved before 2010-10-12 (patch 4.0.1) while coordinates, ids and the quest infobox stay on the newest revision, where the corrections are (ADR-0040); the 20,428 pages with no pre-cutoff revision keep their newest text under a fixed page-level label rather than being dropped. Out-of-game reference pages (patch notes, the Lua API, the client UI, addons, boxed products) are classified from the title and sunk below every body hit with a label, never deleted, exact titles never demoted. The runner stamps the bundle's identity (`schema_version`, `built_at`, `source`, `era_cutoff`) into the run's comparability tuple, so a rebuild is visible instead of indistinguishable. Verified on a rebuilt bundle: unlabelled Cataclysm-mentioning pages 2,025 → 650, Deathwing/Shattering/Pandaria mentions 2,032 → 306, the Coldridge Valley "collapse" prose 3 → 0, coordinates −2.6% and ids −1% (the stale duplicate rows going away). **Deploy pending:** the rebuilt bundle sits at `data/wiki/bundle.next.sqlite` and is not swapped in; the swap is a harness minor bump (ADR-0033 addendum) and waits for a deploy window after review. That staged file predates the out-of-world section trim (2026-08-24, ADR-0040 §Sections), the pre-announcement protection, the stripper fix in item 63 and the empty-row fix in 9f06265, and has to be rebuilt before the swap — it was built with the behaviour that dropped 5,011 pages of this world. **Amended 2026-08-24:** the era rules were dropping 588 pages of this world — a page that existed before the Cataclysm beta had picked up `|patch=4.0.1` or a Cataclysm category in a 2010 revision, and was read as a beta stub; Stormwind City, Durotar, the Barrens, Thousand Needles, Auberdine, Southshore and Camp Taurajo among them. A page whose first revision predates the Cataclysm announcement is now a Wrath page and a post-Wrath signal never drops it (`pages_pre_announcement_protected`; the line moved from 2010-06-01 to 2009-08-21 under item 64), while the section and paragraph cuts still strip what the 2010 editors wrote about the next world; a page with no pre-cutoff prose is counted `dropped_post_cutoff` whatever else it says, which moves 1,429 pages between counters and admits nothing new. Every counter in that build added up, which is why the build now ends with a **canary**: the ten capitals, the eight racial starting zones and the reshaped classic zones must resolve in the finished bundle or the build fails before the rename (`wiki/src/canary.ts`, `--no-canary` for smoke builds), with `wiki/src/verify.ts` as the operator-run pre-swap gate over the same list plus forbidden titles and phrase pairs. Residue is item 62; 63 and 64 are resolved below
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
