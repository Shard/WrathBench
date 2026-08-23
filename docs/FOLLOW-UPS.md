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
2. **48** — decide whether the flagless watchdog defaults move to 20m/20m.
3. **46** — same-map teleports visible to the agent; the module sends the stop.
4. **43** — subscription-lane quota pauses hold the run instead of ending it.
5. **35** — milestone records; rungs 2/4/6 of the ladder read "not instrumented" until
   they exist.
6. **19** — before anything is public or MCP-exposed: shared secret on the port,
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

46. **A same-map teleport is invisible to the agent** (2026-08-23; module work).
    Evidence: `fleet-nav-probe-sonnet-20260822-c3`, whose model wrote "don't trust
    state.self.position after a hearthstone" into its scratchpad. A near teleport
    (Hearthstone, spell 8690, every same-map port) sends the client
    `MSG_MOVE_TELEPORT_ACK` (0x0C7) carrying the arrival point; the module answers it
    (`TickTeleportAcks`) but does not tap it, and there is no `SMSG_NEW_WORLD` on a
    same-map port, so the agent observes strictly less than a client and
    `state.self.position` stays stale until the next `WB_MOVE_RESULT`. Three parts:
    (1) tap the opcode in the observed-movement case (packGUID + u32 counter +
    MovementInfo), one row in `OBSERVED_MOVE_OPCODES`, one row in module/PROTOCOL.md —
    the SDK's `MSG_MOVE_*` fold already routes an own-guid block to self position.
    (2) `TickMover` answers `transferred` for near teleports too (`IsBeingTeleported()`
    is true for both), so a Hearthstone mid-`moveTo` sends the SDK into a
    `waitForTransfer` for an `SMSG_NEW_WORLD` that never comes — a full-timeout hang
    ending in a false hint. Needs `sameMap: true` on the result or its own status.
    (3) `DoMoveTo` finishes a superseded move without `MSG_MOVE_STOP` and a planning
    failure sends no packet, leaving the server with `MOVEMENTFLAG_FORWARD` as its last
    word and every later cast failing `SPELL_FAILED_MOVING` (~10 minutes of Hearthstone
    casts in that run). The SDK sends the stop after any status meaning nothing moved
    (`MOVE_LEAVES_NO_STOP`, 2026-08-23) — that covers `moveTo` but not `moveToAsync`,
    which never reads a verdict; the module should send it at the source. Unblocked by
    a module build and a deploy window.

51. **ADRs and doc drift owed by the 2026-08-23 `moveTo` change** (da93f0a;
    worklogs/2026-08-23). `unknown_target` is an SDK-side move status outside
    ADR-0027's module-owned vocabulary (the `killTarget`-answers-`lost` pattern), and
    `ConnectOptions.deadline` is a new concept crossing the SDK/runner boundary; both
    want an ADR. `docs/CONTRACTS.md` and `module/PROTOCOL.md` were not re-read for
    move-surface drift. `runner/src/prompt.ts` still lists `moveTo` among "the raw
    actions under them" a line above the clause grouping it with the unit-accepting
    helpers — left alone because every prompt edit is a comparability boundary; fix it
    in the next deliberate prompt bump.

## Quests, combat, economy (SDK surface)

9b. **A wait/until primitive that does not burn snippet turns.** About 20 of opus's 85
    turns (roster-opus-20260822) were pure 25–28s sleep-polls of a background routine.
    A `sdk.waitUntil(predicate, timeout)`, or letting a snippet declare "wake me on
    event X", would cut turn counts for every model. Held: it smells like the
    convenience middle tier ADR-0015 forbids; decide deliberately with the operator,
    not inline. Item 17's parked `sdk.wait` alias is the same decision. Partial
    movement 2026-08-23: ambient `sleep()` now wakes early on attack or death with a
    reason (worklogs/2026-08-23), which covers the two observed reasons for polling
    without adding a predicate API.

17. **Failure-surface audit, parked tier.** Tiers 1 and 2 shipped 2026-08-22
    (worklogs/2026-08-22); ADR-0017 settled the BigInt question; `events.off` shipped
    2026-08-23. Still parked pending an ADR: a machine-readable error class taxonomy,
    and a `sdk.wait` alias — the latter is item 9b's decision.

50. **Equipped-bag contents are unobservable** (split from item 39, which shipped the
    spellbook and raw hatch 2026-08-22). `state.bag()` is the backpack only; items in
    equipped bags are invisible to the agent although the client has them from the same
    update fields. Blind spot, not yet the obstacle in any trajectory; the ADR-0015 bar
    is a run that needs it. Evidence pointer when it comes: an `inventory_full` turn-in
    with free slots in an equipped bag.

## Fleet and gate

10. **Per-character credentials** (PHASE-0 deferred list). Required before any run
    parallelism beyond one account per run. The fleet layer stays inside that scheme by
    construction (one lane or pool job, one account; two enabled lanes sharing an
    account is a config error), so ADR-0031's pool does not move this item. Needed by
    the group tier (item 40) and VISION.md's public-MCP path.

23. **Helm chart for the fleet** (2026-08-22). ADR-0020 made the supervisor a compose
    service shaped as the chart's rehearsal: Deployment (the `fleet` service, `restart:
    unless-stopped` → a restartPolicy), ConfigMap (`infra/fleet.json`, read-only and
    hot-reloaded — a remount is the same edit-the-file steering), PVC (`data/`, which
    already holds every piece of supervisor state: run dirs, `fleet-state.json`, lane
    logs, defer sidecars, `fleet-models.json`). The actual work is the two things that
    do not port: the repo bind mount (the chart wants the harness baked into the image,
    so the `git describe` stamp comes from a build arg rather than a mounted `.git`),
    and `.env` (a Secret mounted at the same path so "never via argv" survives).

24. **`accountHeldBy` rescans every run directory** (2026-08-22). It `readdirSync`s
    `data/runs/` and reads a `meta.json` per entry on every launch and every
    `--status`; the ADR-0032 projection reads every trajectory in full for the same
    reason (memoised on size+mtime, but the set only grows). Not a problem yet — the
    stillborn archive (2026-08-23) halved the directory once — noted so it is not a
    mystery slowdown in three weeks. Fix: an index keyed on account, or a scan capped
    to recently-modified directories.

43. **Subscription-lane quota pauses should be resumable** (2026-08-22). When the
    claude-code lane hits its quota window the pause ends the run instead of
    holding it; a long nav-probe episode loses its progress to a window that reopens
    on its own hours later. Want: pause in place, resume when the window reopens.
    Interacts with item 8 (the CLI's accumulated context is lost on resume today) and
    with ADR-0032's cooling deadline, which is the place a "held" state would be
    reported.

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

52. **The viewer's roster read does not know pinned refs or probes** (2026-08-23,
    ADR-0034 amendment). `runner/viewer/models.ts` lists every `roster` entry on
    `/api/models`, so `nav-probe` (model `sonnet`, an objective) shows beside `sonnet`
    with the same counts, and `policy.maxConcurrent` is not surfaced. `--status`
    marks them `pinned`; the viewer should read the same exclusion (`policyRefs`) —
    which means lifting that predicate into `runner/src/models.ts` rather than
    importing the supervisor. Also: the supervisor's `session` counters and `jobs`
    block in `fleet-state.json` are new and unread by the dashboard's fleet page.

## Episodes and eval

8. **Context policy is not applied on the claude-code harness.** (ADR-0035 names
   this: the run is tagged `harness: claude-code` and shown alongside wrathbench rows;
   the policy gap below is recorded, not penalised.) The claude-code harness never
   applies the policy the prompt describes — no trim, one CLI conversation growing
   linearly (~200k tokens by the end of a 90-minute episode in roster-sonnet-20260822,
   COSTS.md), so almost all of that lane's token spend is cache-read replays of a
   growing prefix, and a `quota-exhausted` pause still loses the CLI's accumulated
   context on resume. Either the driver applies a policy or the prompt stops promising
   one; cost comparisons across drivers are invalid until then. Evidence now exists for
   the multi-hour case (8c): `fleet-nav-probe-sonnet-20260822-c2` completed a 6h e360
   naturally at $43.90 as-metered — read its token curve before drafting either half.
   - **8a — extractive digest, deferred behind an evidence gate.** The 2026-08-21
     verdict (worklogs/2026-08-21): compaction is unnecessary on the fixed-loop driver,
     requests plateau at ~8–20k tokens. Build it when either signal appears — genuine
     context exhaustion in a run, or a trajectory showing a model re-querying facts it
     lost to a window trim. Design when built: trimmed messages replaced by a
     deterministic one-line record (tool, truncated args, error flag) in a capped ring
     buffer inside the regenerated context message. Within a harness version, no model
     summarization (conflates constructs, breaks replay) and no per-model context
     scaling (provider-declared context sizes drift for one model id).
   - **8b — context engine as a labelled run condition; operator direction,
     deliberately parked.** When picked up: (a) stretch the window well beyond 24–48 in
     a future harness version, since ~8–12k steady state against 131k–200k contexts
     makes a much longer stable prefix nearly free under prompt caching; (b) offer
     threshold-triggered model self-compaction as a versioned **harness** value
     stamped into run metadata (the `harness` field of the ADR-0033 tuple, ADR-0035) —
     a third value beside `wrathbench` and `claude-code`, comparable within a harness
     if the operator chooses to partition, never silently across. Grow-then-self-compact is what end-user agents run
     under. This supersedes 8a's flat "no model summarization ever": that holds for
     unlabelled changes to the current engine, not for a future labelled one.
   - **8c** — merged into 8 (the multi-hour evidence it asked for now exists).

13. **Metric design against grind collapse.** RuneBench's raw total-XP metric punished
    exploration and collapsed to grinding, and their mid-eval metric change is half of
    why aggregators exclude their results; a furthest-level metric has the same
    exposure. ADR-0018 (signals, not scores; derivations offline) is the decision of
    record and claims to supersede this. Kept open until the ladder's derivations
    (ADR-0030 promotion, the eval charts) are confirmed to not reintroduce a single
    collapsible number — close it by noting that in ADR-0018, not by building anything.

29. **The local-qwen lane is inference-bound; harness fixes will not move it**
    (2026-08-22). Median 48s per turn, 78 of that episode's 90 minutes inside the model.
    Read its results as a throughput measurement of the local box, never as evidence
    that a harness change helped or not. Open only as a standing caveat on the eval
    surface; closes when the lane is retired or the box changes.

32. **Dashboard parity gaps against the deleted pages** (2026-08-22, ADR-0022; the
    pages went in item 31). Each deliberate: (1) **Cost estimate** — the old `PRICING`
    table (dollars per million, input / output / cache read / cache write:
    `claude-opus-5` 5.00 / 25.00 / 0.50 / 6.25, `claude-sonnet-5` 2.00 / 10.00 / 0.20 /
    2.50; sonnet's is the introductory rate lapsing 2026-08-31, list 3.00 / 15.00, cache
    0.30 / 3.75; cache read 0.1x input, 5-minute write 1.25x) was not ported because a
    hard-coded table drifts silently; its home is the roster, next to the model ids it
    prices. COSTS.md now carries measured figures instead. (2) **Whole-feed expand
    preset** (Minimal / Responses / Snippets / All, remembered in localStorage) — the
    SPA folds per block only. (3) **Compact state samples and called-out harness
    notices** — rendered through the generic-entry path, readable but unstyled.
    Unblocked by someone wanting them; none blocks release.

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

36. **Run metadata is scattered and `platform` is derived, not stored** (2026-08-22).
    `model` is a column; `character` is only inside `config_json`; `platform` is
    computed at read time by `platformOf()` in `runner/viewer/runs.ts` from `apiBase`,
    special-casing only `localhost`/`127.*`, so the LM Studio box at `192.168.1.20`
    surfaces as a bare IP. Lane name and host are not recorded. Consolidate: promote
    `character` and `platform` to `run` columns written at `writeMeta` (migrated
    additively like `money` and `turn`), classify RFC-1918 or loopback `apiBase` as
    `local`, and have the viewer read the column. No contributor field yet. Scrub note
    for DATA-AND-LEGAL's pre-publication checklist: the private LAN IP is hardcoded in
    `infra/README.md`, `infra/fleet.json`, `infra/smoke/local-model.ts` and
    `infra/fleet.test.ts`.

48. **Episode tiers: the flagless defaults** (2026-08-23, ADR-0030). (a)–(f) shipped
    (worklogs/2026-08-23: `runner/src/episodes.ts`, the tuple fields, `?episode=` on
    eval and ladder, tiers computed by ADR-0032, EPISODES.md ceilings). Left: (g) the
    bare watchdog defaults in `runner/src/config.ts` are still idle 10m / no-XP 45m.
    `--episode` overrides them, so a lane that passes the flag is correct either way;
    whether the flagless defaults should move to 20m/20m is open, because moving them
    changes the shape of every run that does not pass `--episode` without saying so in
    a tuple field. Decide, then either move them with a harness-version note or write
    down that flagless runs are not tier members and leave them.

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
    trajectory audit found no run ever did). Distinct from item 10.

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
- 39 — 2026-08-22 — d739071, b4c5928, ADR-0025 — spellbook/cooldowns/talents, raw hatch; equipped bags split to 50
- 41 — 2026-08-22, deployed 2026-08-23 — d1255d7 — `/health` build id
- 42 — 2026-08-22 — 1a2d6a9, d3e39d6 — server identity in the dashboard; per-run server build in the tuple
- 44 — 2026-08-22 — 6156b5f, 2f19f75 — cooperative abort of abandoned snippets
- 47 (duplicate number, wiki leads) — 2026-08-23 — renumbered to 49
- 8c — 2026-08-23 — merged into 8
- 48 (a)–(f) — 2026-08-23 — 56bfdef, 634e58c, 277f948 — episode tiers wiring; (g) stays open under 48
