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
      transport-relative movement. **Gate still open:** `infra/smoke/travel.ts` rides
      the tram IF→SW end to end with a typed success and no undifferentiated
      `no_path`; run it three times on PROBE, record wall clock per leg, then ADR-0027
      is accepted. Residuals to watch: interpolated-vs-applied position at trigger
      dispatch (re-armed after 1.5s), and triggers are only tested while a `move_to`
      is active. The leg-1 waypoints were made mesh-valid 2026-08-23 (42b5c38).
    - **N2 — field-level observations**, each small, each earned, each logged: zone
      and area name on self from position and the client's own DBC (no packet carries
      it; the client computes it, so the module may), with a `milestone` record (item
      35) on change; NPC role on nearby units from `UNIT_NPC_FLAGS` (flight master,
      innkeeper, trainer, vendor — role, not recommendation); innkeeper bind
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

50. **Equipped-bag contents are unobservable** (split from item 39, which shipped the
    spellbook and raw hatch 2026-08-22). `state.bag()` is the backpack only; items in
    equipped bags are invisible to the agent although the client has them from the same
    update fields. Blind spot, not yet the obstacle in any trajectory; the ADR-0015 bar
    is a run that needs it. Evidence pointer when it comes: an `inventory_full` turn-in
    with free slots in an equipped bag.


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


45. **Scenario-fixture characters for smokes** (2026-08-23, ADR-0023 amendment). The
    fast gate proves what a level-1 character can reach in under a minute from the
    Northshire spawn. Every late-game claim — a dungeon entrance, a flight path, a
    trainer with ranks to sell, a mailbox with mail, the tram, death far from a
    graveyard — is minutes of play away, so it can only live in the deploy-time arc or
    go ungated. Want: an `infra/fixtures` operator tool that writes the
    `acore_characters` rows for a named scenario (level, position, quest log,
    inventory, spells) while the character is logged out, on the smoke accounts only;
    a smoke logs into the fixture and proves its claim in seconds. Never reachable from
    the runner or the SDK, so the contract in docs/CONTRACTS.md is untouched. Same path
    fixes the smokes left out of the gate: `spellbook.ts` (deletes last, pays the 60s
    linger) and the cooldown assertion in item 47. Also: `CMSG_LOGOUT_REQUEST` on the
    raw allowlist would let any smoke end cleanly in 20s instead of 60.

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
    entry, and `SPELL_GO` goes back to being a cast-path check.


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
    label. N2's zone/area observation (item 38) is the first producer.



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

56. **`areatrigger` re-fires while the character stands inside the volume** (2026-08-23,
    item-55 diagnosis). In `fleet-nav-probe-freeplay-sonnet-20260823-c4` the module
    logged `areatrigger 710` every ~1.5s for 13s during one walk — `CheckAreaTriggers`
    (`module/src/WbManager.cpp`) re-arms on the 1.5s timer rather than on entry, so a
    character lingering in a DBC volume sends `CMSG_AREATRIGGER` repeatedly. The real
    client sends it once on crossing the boundary. Harmless for teleport triggers
    (the transfer moves the character out) but wrong for quest-explore triggers and
    noisy in the audit log. Fix: track the set of volumes the character is inside and
    dispatch only on entry. Module change, so it lands in a deploy window.

## Wiki

49. **Unlabelled post-3.3.5 prose in wiki page leads** (2026-08-23, from ADR-0029;
    previously carried under a duplicate number 47). ADR-0029 marks the era sections
    the wiki labels itself, but a 2020 page's lead is written present-tense about the
    post-Cataclysm world with no marker at all — the Coldridge Valley lead still says
    the pass linked the valley to Dun Morogh "prior to its collapse", which is false
    here, and no build-time rule separates that from Wrath-era prose. The
    `search_reference` description carries the standing warning. A real fix needs
    either a pre-Cataclysm revision of each page (the dump is full history, so the
    revision from before 2010-12 is in it — a second bundle channel, expensive) or
    per-sentence classification (not deterministic). Revisit only if a trajectory shows
    a model misled by a lead after the description warning shipped.

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
