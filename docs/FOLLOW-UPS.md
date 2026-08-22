# Follow-ups

Outstanding work only, as of 2026-08-22, ordered by priority. Completed items
graduate out of this file into docs/WORKLOG.md, which carries the root causes and
what shipped; the dev loop (docs/PHASE-0.md) decides when.

## Harness quality

8. **Context policy is not applied on the subscription lane.** The Claude-driver
   ContextBuilder's state sampling and watchdog checks are solid, but a
   `quota-exhausted` pause still loses the CLI's accumulated context on resume
   (documented, acceptable for shakeout), and the lane never applies the context
   policy the prompt describes — no trim, one CLI conversation growing linearly
   (111k tokens at 40 min in morning-opus-1, ~640 tok/turn), so almost all of that
   run's token spend was cache-read replays of a growing prefix. Either the driver
   applies a policy or the prompt stops promising one. Cost comparisons across
   drivers are invalid until it is resolved.

8a. **Extractive digest — deferred behind an evidence gate.** The 2026-08-21 verdict
   (WORKLOG) was that compaction is unnecessary: requests plateau at ~8–12k tokens
   under the fixed policy. Under the 24→48 hysteresis medians run 13–20k, and item
   8's unbounded subscription-lane growth arguably trips the gate for that lane
   already. Build it when either signal appears: genuine context exhaustion in a
   run, or a trajectory showing a model re-querying facts it lost to a window trim.
   The design: trimmed messages replaced by a deterministic one-line record (tool,
   truncated args, error flag) in a capped ring buffer inside the regenerated
   context message. Within the current harness version, no model summarization
   (conflates constructs, breaks replay) and no per-model context scaling
   (provider-declared context sizes drift for the same model id).

8b. **Context engine as a labeled run condition — operator direction, deliberately
   parked.** When picked back up, the proposal to draft is (a) stretch the window
   well beyond 24–48 in a future harness version, since ~8–12k steady state against
   131k–200k model contexts makes a much longer stable prefix nearly free under
   prompt caching, and (b) offer threshold-triggered model self-compaction as a
   versioned **context engine** stamped into run metadata — scores comparable within
   an engine, never silently across engines. Grow-then-self-compact is what
   end-user agents actually run under, and pinning one tweak of the current policy
   forever is unlikely to be the long-term answer. This supersedes 8a's flat "no
   model summarization ever": that holds for unlabeled changes to the current
   engine, not for a future labeled one.

8c. **The nav-probe lane is the first multi-hour subscription run, and it will
   exercise exactly this.** Shipped armed-off 2026-08-22 (ADR-0024): one 6h
   claude-subscription episode with an operator travel objective, `no-xp`
   disabled, tool calls capped at 2500. Nothing in this item is fixed by it —
   the CLI still owns its conversation and still grows linearly — but a 6h run
   is roughly four times the longest sample we have (111k tokens at 40 min in
   morning-opus-1), so it is the first run that can say whether the growth ends
   in the CLI's own compaction, a `quota-exhausted` pause, or neither. Read its
   token curve before drafting either half of item 8's fix.

14. *(Closed 2026-08-22 — death recovery fixed and verified end to end; see WORKLOG.
   Referenced from item 18. The character-delete auth residual moved to item 19.)*

17. **Failure-surface audit, parked tier.** Tier 1 and Tier 2 shipped 2026-08-22
    (WORKLOG); ADR-0017 settled the BigInt question. Still parked pending ADRs: a
    machine-readable error class taxonomy, and `sdk.wait` / `events.off` aliases —
    the latter is the same question as item 9b, decide it there.

18. **Travel surface a future run would need.** From the 2026-08-22 travel probe
    (WORKLOG), in order: (1) module sends `CMSG_AREA_TRIGGER` when the player stands
    in a teleport trigger's volume — client parity, and it opens the tram, instance
    portals and inn triggers in one move; (2) serve `SMSG_TRANSFER_PENDING` /
    `SMSG_NEW_WORLD` and update `state.self.position.map` from them, since today it
    only ever updates from `SMSG_LOGIN_VERIFY_WORLD`; (3) split `no_path` into
    distinguishable causes, or teach the z-ladder/subdivision recovery recipe in the
    prompt — **the second half shipped 2026-08-22**: a `no_path` result now carries
    `{ distance, hint }` naming the failed span and the ~15y-waypoint / different-z
    recovery (qwen spent 8 turns rediscovering it). Splitting the causes is still open
    and is module work: off-navmesh destination, blocked route and bad z are one status
    on the wire; (4) a contract-clean coordinates source — the probe hardcoded DB-derived
    waypoints, which the observation contract denies an agent. The wiki-coordinate
    channel for this shipped 2026-08-22 (issue #2 item 4, WORKLOG): `search_reference`
    now returns wowwiki `{{coords}}`/infobox coordinates as reference hints — so (4)
    is done; a *live-observed* position source is still open under (1)/(2). Transport
    (boat, tram, zeppelin) semantics stay unknown and untested until (1) and (2) land.
    Depended on the item-14 teleport ack, which has shipped. **Sequenced into
    item 38 (2026-08-22), which is the plan of record for this surface.**

19. **Unguessable session tokens — pre-public/MCP blocker** (fan-out review 2026-08;
    accepted-risk statement in docs/CONTRACTS.md). `POST /action` and
    `DELETE /session` authenticate by bearer token alone, and the runner defaults
    tokens to the run id — a second-granularity timestamp — so a snippet in one run
    can enumerate and drive or tear down a concurrent run. Accepted while every lane
    is operator-launched on the private compose network. Before any public or
    MCP-exposed deployment, or before trusting any adversarial multi-run result:
    issue a random secret at session create, return it only to the creator, require
    it on `/action`, `DELETE /session` and `/events`. Module and runner change
    together, backward compat off. Two related pre-public blockers ride here: the
    HTTP surface has no authentication at all and nothing binds a token to a
    character, so any caller reaching the port can delete any character on an
    allowlisted account that is not logged in — a token-to-character binding plus a
    shared secret on the port is the floor (the accounts allowlist shipped
    2026-08-22 and is not sufficient); and a snippet can still fs-read `.env` by
    absolute path, which needs filesystem sandboxing. Distinct from item 10.

22. ~~**Map replay of historical runs**~~ Shipped 2026-08-22. `/map?run=<id>`,
    linked from the run page, scrubs one run's recorded track through the live
    renderer: `/api/run/<id>/track` serves the positions, `dashboard/src/lib/replay.ts`
    turns a time cursor into the same `AgentPosition[]` the live poll produces,
    and the route walked so far is drawn behind the pip, split per map so a
    continent change is not a line nobody walked. ADR-0019's seam held — no draw
    path asks which mode it is in; the only mode-aware line places a scrubbed pip
    instead of walking it there. Still open, and deliberately not invented here:
    death sites and zone coverage, both of which need the milestone records of
    item 35.

23. **Helm chart for the fleet** (2026-08-22). ADR-0020 made the supervisor a
    compose service deliberately shaped as the chart's rehearsal: Deployment
    (the `fleet` service, `restart: unless-stopped` → a restartPolicy),
    ConfigMap (`infra/fleet.json`, mounted read-only and hot-reloaded — a
    ConfigMap remount is the same edit-the-file steering), PVC (`data/`, which
    already holds every piece of state the supervisor owns: run dirs,
    `fleet-state.json`, lane logs, defer sidecars). Two things do not port as
    they stand and are the actual work: the repo bind mount (the chart wants the
    harness baked into the image, which also means the `git describe` stamp has
    to come from a build arg rather than a mounted `.git`), and `.env` (a Secret,
    mounted at the same path so the "never via argv" property survives).

24. **`accountHeldBy` rescans every run directory** (2026-08-22). It
    `readdirSync`s `data/runs/` and reads a `meta.json` per entry on every
    episode launch and every `--status`. Under a forever-running supervisor with
    a fixed epoch that set only grows. Not a problem yet; noted so it is not a
    mystery slowdown in three weeks. An index keyed on account, or a scan capped
    to recently-modified directories, is the fix.

25. ~~**`search_reference` ranks id noise above the entity page, and never says
    "you already asked this"**~~ Shipped 2026-08-22. Search now ranks in bands
    (exact title, entity id, title tokens, body), an id query is answered only
    from id-shaped fields (`page_ids`, bundle schema 3, lifted from infobox
    templates at build time) and never from body prose, and a repeated query
    comes back with a one-line per-episode memo naming how many tool calls ago
    it was asked and whether the top titles changed. See WORKLOG. One residual,
    tracked as item 30: the deployed bundle predates the schema, so the id band
    is inert until it is rebuilt.

26. **A silent turn-in cannot be told from "this NPC has nothing to offer"**
    (2026-08-22 review; investigated and deliberately not implemented). The
    proposal was: during `turnInQuest`, treat an `SMSG_GOSSIP_MESSAGE` for the
    target carrying no quests and no options as `status: "nothing_offered"` instead
    of burning the 10s timeout. The trajectory does not support it. In
    `roster-laguna-s-2-1-20260822` the empty gossip menus (menuId 4650, `options: []`,
    `quests: []`, seq 5489 and 5858) are the answers to that model's own
    `questList`/`gossipHello` calls on Llane Beshere, not to a `quest_complete` —
    the core does not answer `quest_complete` with a gossip menu at all. Keying a
    resolved status on an unrelated event that happens to land inside the wait would
    let a merely-slow legitimate turn-in report a fabricated outcome, which is the
    one thing ADR-0016 forbids. If it is wanted, the honest version is module-side:
    have the module report that the handler returned without sending (see item 27's
    questgiver status, which answers the same question before the call). The distance
    in the timeout message (shipped 2026-08-22) covers the observed cases meanwhile.

## Surface candidates (add when a run makes them the obstacle)

9. **Trainers** — every model so far has visited Brother Sammuel and probed for a
   train action (deferred in docs/CONTRACTS.md Phase 0 set). First candidate for the
   next action-surface widening; needs `SMSG_TRAINER_LIST` decode plus
   `CMSG_TRAINER_BUY_SPELL`.

9a. **questsAvailableFrom(npcGuid)** — opus (roster-opus-20260822) wrote its own
    wrapper over `questList` plus event scraping and got confused by its own nulls;
    earlier runs built the same scaffold. One more sighting meets the ADR-0015 bar:
    a helper that sends `quest_list` and returns the parsed offer list from
    QUESTGIVER_QUEST_LIST *or* GOSSIP_MESSAGE (the two shapes `acceptQuestFrom`
    already handles).

9b. **A wait/until primitive that doesn't burn snippet turns** — about 20 of opus's
    85 turns were pure 25–28s sleep-polls of a background routine. A
    `sdk.waitUntil(predicate, timeout)`, or letting a snippet declare "wake me on
    event X", would cut turn counts for every model. Held: smells like the
    convenience middle tier ADR-0015 forbids; decide deliberately, with Mark, not
    inline. Item 17's parked `sdk.wait` alias is the same decision.

27. ~~**Questgiver status icon on nearby units**~~ Built and deployed 2026-08-22
    (module commit `a4ed1a3`, SDK `756eb83`; image
    `wrathbench/worldserver:next`; smoke `infra/smoke/quest-status.ts` passed live
    in the deploy window — WORKLOG). The `!`/`?`/greyed marker a
    real client renders over an NPC's head, inside the observation contract.
    Evidence: laguna spent turns 103-238 at 0.1y from the giver of quest 783
    (McBride ends it), ox-alpha 8-10 turns, nemotron 10, qwen 5. Shipped: the
    module taps `SMSG_QUESTGIVER_STATUS_MULTIPLE` and sends the two client status
    queries; `state.units()` rows carry `questGiver` (named) and the raw byte,
    `UnitFilter.questGiver` selects by name, the SDK queries on sight and on
    quest-log change (ADR-0021), and the turn-in/quest-list silences name the
    observed marker.

28. ~~**Quest objective text and required counts**~~ Built and deployed 2026-08-22
    (same commits/image/smoke as 27). Evidence: ox-alpha lost ~15-20
    turns grinding wolves for a kobold quest, watching `counts` stay at 0.
    Shipped: `quest_query` + the `SMSG_QUEST_QUERY_RESPONSE` decode;
    `state.quests` holds the template and `state.quest(id)` carries `title` and
    `objectives: [{ kind, entry, text, required, have, done }]`, `have` from the
    log counters (creature/gameobject/event slots) or the backpack stacks
    (items). Left out on purpose: reward fields (served by `QUEST_DETAILS` /
    `OFFER_REWARD` already) and `SMSG_QUESTUPDATE_ADD_KILL.required` as a second
    source of denominators.

10. **Per-character credentials** (PHASE-0 deferred list) — required before any run
    parallelism beyond the current one-account-per-run scheme. The fleet layer
    (`infra/fleet.json` + `run-fleet.ts`) stays inside that scheme by construction —
    one lane, one account, and two enabled lanes sharing an account is a config
    error — so it does not move this item, though it does supersede the hand-launched
    two-processes-with-`--skip` pattern in infra/README.md.

## Housekeeping

13. **Metric design against grind collapse** (before Phase-1 measurement). RuneBench
    records that raw total-XP punished exploration and collapsed to grinding without
    stopping; they moved to peak XP-rate windows, and their mid-eval metric change is
    half of why aggregators exclude their results. Our furthest-level metric has the
    same exposure. ADR-0018 is the decision of record and claims to supersede this
    item; kept open until it is confirmed that it covers the grind-collapse exposure
    and that the ADR is written before the first scored run, not after.

14. ~~**Roster defer backoff clamps at 10m and idles resumed lanes.**~~ Shipped
    2026-08-22. Two observed failures in one afternoon: (a) the per-spec defer
    ladder was `2m/5m/10m` clamped forever, so a saturated free model
    (`z-ai/glm-5.2:free`) was relaunched 17 times in a day, every one a 0-turn
    rate-limited stub; (b) under `--resume-roster --loop`, a spec whose cycle-1
    run had already terminated was dropped from the roster entirely, so five of
    six fleet lanes spent 16:48–17:01 logging "restarting the roster
    (0 episode(s))" and idling. Fixed: escalating ladder
    `1m/3m/5m/10m/15m/30m/1h/3h/6h` then TAINT out of the rotation on the 10th
    consecutive defer, defer state persisted in `<log>.defer.json` across lane
    restarts, an already-terminated entry kept in the rotation for later cycles,
    and no cycle nap when nothing launched *and* nothing was cooling. Left open
    for a future pass: taint is per-process, not per-day — a lane restarted after
    a taint gets the tainted specs back only if the sidecar survives, and there
    is no operator command to un-taint one without editing the sidecar.

29. **The local-qwen lane is inference-bound, so harness fixes will not move it**
    (2026-08-22). Median 48s per turn, and 78 of that episode's 90 minutes were spent
    inside the model rather than in the sandbox, the module or the world. Ergonomics
    changes that save a weak model turns (the 2026-08-22 pass: `closest` filters,
    distance in questgiver timeouts, `no_path` hints) buy that lane almost nothing —
    read its results as a throughput measurement of the local box, and do not use it
    to judge whether a harness change helped.

30. ~~**The deployed wiki bundle is schema 1, so two shipped channels are inert**~~
    Fixed 2026-08-22; bundle built to `data/wiki/bundle.next.sqlite`, swap pending
    (see WORKLOG). Original note (2026-08-22): `data/wiki/bundle.sqlite` was built 2026-08-21 and reports
    `schema_version = 1`: it has neither `page_coords` (shipped as schema 2 with
    the coordinate channel) nor `page_ids` (schema 3, FOLLOW-UPS 25). Consumers
    degrade rather than fail — `run.ts` opens the file directly and bypasses
    `openBundle`'s fail-closed check — so nothing broke, but every run since the
    coordinate channel shipped has silently returned no coordinates, and id
    queries will keep returning nothing until a rebuild. Rebuild when no fleet
    lane is mid-episode (`bun wiki/src/build.ts data/wiki/<dump>.7z --out
    data/wiki/bundle.sqlite`, a few minutes, atomic rename), then spot-check
    `schema_version`, `coord_rows` and `id_rows` in `meta`.

31. ~~**Delete the hand-written viewer pages**~~ Dropped 2026-08-22 on operator
    decision, ahead of the one-week mark: the SolidJS dashboard is the only UI.
    `runner/viewer/page.ts`, `map-page.ts` and every `/legacy` route are gone,
    and with them the last hand-copied duplicate of the ADR-0019 coordinate
    transform and the `BASE`-prefix shim both pages carried. With no build on
    disk the viewer now answers page routes with a plain-text notice naming
    `bun run --cwd dashboard build` rather than a fallback UI. The parity gaps in
    item 32 were accepted as losses, not ported.

32. **Dashboard parity gaps against the pages it replaced** (2026-08-22; the
    pages themselves were deleted the same day, item 31). Three things the old
    run page did that the SPA does not, each deliberate rather than forgotten:
    - **Cost estimate.** `page.ts` carried a `PRICING` constant (dollars per
      million tokens, per model) and rendered an estimated spend beside the token
      breakdown. Not ported: a hard-coded price table drifts silently, and the
      right home for it is probably the roster, next to the model ids it prices.
      The table as it stood, so it need not be dug out of git history — dollars
      per million, input / output / cache read / cache write: `claude-opus-5`
      5.00 / 25.00 / 0.50 / 6.25, `claude-sonnet-5` 2.00 / 10.00 / 0.20 / 2.50.
      Sonnet's row is Anthropic's introductory rate, which lapses 2026-08-31 and
      reverts to list 3.00 / 15.00 (cache 0.30 / 3.75). Cache rates are the
      published multipliers on input: a read is 0.1x, a 5-minute write 1.25x.
      Only models matching `/claude/i` (or the `claude-subscription` driver) were
      priced at all, and a claude-sdk run is billed against a subscription, so
      its figure was what the same work would have cost on the API.
    - **Whole-feed expand preset.** The old top bar had a Minimal / Responses /
      Snippets / All dropdown remembered in `localStorage`; the SPA folds and
      unfolds per block only.
    - **Compact one-line state samples and called-out harness notices.** The SPA
      renders both through the generic-entry path, so they are readable but not
      styled distinctly.

33. **Public hosting checklist for the dashboard** (2026-08-22, ADR-0022). The
    dashboard is meant to become a public read-only status page. Before any of it
    is exposed:
    - **Legal, first and blocking.** Minimap tiles are Blizzard textures and must
      not ship; `WRATHBENCH_VIEWER_PUBLIC=1` withholds them and the map degrades
      to a labelled grid, which is the intended public look until
      `docs/DATA-AND-LEGAL.md` says otherwise. The same decision governs
      trajectory text: raw entries and scratchpads are withheld by the same flag,
      but entry *summaries* still carry model output and snippet code, and
      whether those are publishable has not been decided.
    - **Auth-less read-only exposure.** The API takes no bodies and opens every
      database readonly, and bearer tokens are stripped — but it has no rate
      limit and no cache, and `/api/runs` reads every trajectory on a cold
      process. A public deployment needs a caching layer in front of the listing
      and a per-IP limit, decided with the hosting rather than guessed at now.
    - **Caching.** Only `/tiles` and the SPA's fingerprinted assets are cacheable
      today; every `/api` response is `no-store`. Short-TTL caching on the
      listing and the position feed is the cheap win.
    - **A public run set.** A public page probably should not list every run the
      fleet has ever produced, shakeouts and failed lanes included. Decide what
      the public listing selects before pointing a domain at it.

34. ~~**Nested templates mislabel the kind of an extracted entity id**~~ Fixed
    2026-08-22; bundle built to `bundle.next.sqlite`, swap pending.
    `extractIds` now brace-matches template calls and takes the kind from the
    narrowest frame that actually encloses the id field, widening outward past
    frames whose name implies no kind (`{{#if:`, `{{PAGENAME}}`); unbalanced
    input is tolerated (a stray `}}` is ignored, an unclosed `{{` runs to the
    end of the text) and the 2000-char proximity window is gone, since a closed
    frame provably encloses its own long fields. Rebuild: 84260 id rows, kinds
    before → after quest 14909 → 16031, npc 20553 → 18903, item 25668 → 24370,
    unknown 23038 → 24870; `quest 783` now leads with `Quest:A Threat Within`.
    Original report: `extractIds` decides an id's kind by the nearest preceding
    `{{template` opening, which a nested call defeats: `Quest:A Threat Within`
    writes `{{questbox | … | start = {{npc||Deputy Willem}} | end =
    {{npc||Marshal McBride}} | id = 783 }}`, so the opening nearest `| id =` is
    an `{{npc`, and the page states quest 783 under kind `npc`. Cost is a
    ranking preference, not a match: an id query for 783 still finds the page,
    it just does not win the kind-matches-the-word band FOLLOW-UPS 25 shipped
    ("quest 783"). Fix is brace-matching the openings so a closed template stops
    counting as enclosing, then a rebuild — which is another `mv` into place,
    not another drain.

35. **Milestone records alongside the state samples** (2026-08-22, strategy
    session). ADR-0018 lists deaths, zones, spells learned and talents spent in
    the signal vector; none is recorded today (the `state` table has level, xp,
    map+xyz, money, quests_completed; `quest_complete` is the only event-shaped
    record). Add a `milestone` trajectory record type — `{ t: "milestone",
    kind, ... }` — emitted from the loop the same way `quest_complete` is, for:
    death (and spirit-healer/corpse recovery), zone and area change (ids from
    the state cache, not names), level-up, spell learned, talent spent, first
    entry to a capital, first instance, first group join, first trade. Kinds
    are additive; derivations over them come later. The freeplay milestone
    ladder (first agent to leave the starting zone, reach a capital, …) is a
    derivation over these records plus the run's model label, so it needs
    nothing that is not already recorded once this lands.

    Still fully open. Note (2026-08-22): turns-to-level became derivable without
    it — state rows gained a `turn` column and the eval charts read it — but that
    is the one derivation levels alone could answer. The ladder page shows rungs
    2, 4 and 6 as "not instrumented" for exactly the records listed above: zone
    and area change, capital entry, taxi use, group join. Deaths, spells learned
    and talents spent remain unrecorded too.

36. **Run metadata is scattered and `platform` is derived, not stored**
    (2026-08-22). `model` is a column; `character` is only inside
    `config_json`; `platform` is computed at read time by `platformOf()` in
    `runner/viewer/runs.ts` from `apiBase`, which special-cases only
    `localhost`/`127.*` — so the LM Studio box at `192.168.1.20` surfaces as a
    bare IP rather than `local`. Lane name and host are not recorded at all.
    Consolidate: promote `character` and `platform` to `run` columns written at
    `writeMeta` time (migrated additively like `money`), classify any RFC-1918
    or loopback `apiBase` as `local`, and have the viewer read the column
    instead of deriving. No contributor field: a single operator submits
    results for now. Scrub note for the pre-publication checklist in
    `docs/DATA-AND-LEGAL.md`: the private LAN IP is hardcoded in
    `infra/README.md`, `infra/fleet.json`, `infra/smoke/local-model.ts` and
    `infra/fleet.test.ts`.

37. **World-level log, via achievements** (2026-08-22; later, when the
    freeplay server has more than one agent in it). Per-session trajectories
    cannot answer "who was near whom when" or "who did X first." Before
    building a bespoke world log, tap the achievement system: 3.3.5 awards
    achievements server-side, including realm-firsts, and the client observes
    them through `SMSG_ACHIEVEMENT_EARNED` / `SMSG_CRITERIA_UPDATE` — neither is
    in the module tap today (`module/src/WbManager.cpp` opcode switch) nor in
    `docs/CONTRACTS.md`. A new tap case plus an `achievement` event type gives
    every character a server-authored ledger of firsts for free and is
    contract-clean. A server-wide position sampler (every character, ~10 s) is
    the other half, and is cheap because the module already sees every
    session; defer until it is the next obstacle.

41. ~~**`/health` has no build or version id**~~ (2026-08-22, from ADR-0023).
    **Built to `:next`, deploy pending** (2026-08-22). `/health` now carries
    `build` (the repo's `git describe --tags --always --dirty`, passed as the
    `WRATHBENCH_BUILD` docker build-arg through `infra/build-worldserver.sh` /
    compose and compiled in via `module/mod-wrathbench.cmake`; `"unknown"` if
    absent), `startedAtMs` and `uptimeMs`, to every caller. The fleet gate's
    server identity prefers `build@startedAtMs` and falls back to the boot
    marker + health digest against a module that predates the field, so it
    keeps working across the deploy; the gate record and `--status` carry
    `build`. The viewer's `/api/info` exposes `worldserver: {build, startedAtMs}`
    (null when unreachable). Becomes true of the running server when
    `./infra/deploy-worldserver.sh` promotes `wrathbench/worldserver:next`.

42. ~~**Dashboard shows no server identity**~~ Footer shipped 2026-08-22 on the
    fleet and run pages; the reachability half is unchanged. The pages render `worldserver
    <build> · up <duration>` off `/api/info`, and `null` reads as "unreachable
    from the viewer (set WRATHBENCH_MODULE_URL to name it)" rather than as a
    blank — which is still what a host-side viewer sees, because compose does not
    publish 8086.

    **Per-run server build shipped 2026-08-22.** `run.ts` fetches the module's
    `/health` at launch and at every resume-restamp (never blocking launch: an
    unreachable module reads `null`, timeout 2s) and stamps
    `comparability.serverBuild: { build, startedAtMs } | null` into meta.json
    (ADR-0026). The run page's comparability panel shows it, `/api/eval`
    exposes `serverBuild` per run and folds it into the grouping key alongside
    model/harness/effort, and the footer's "not necessarily the build this run
    drove" hedge now applies only to a run whose metadata predates the field —
    a run with its own recorded build states it as fact instead. One remaining
    gap: a run resumed by a build older than this one still has no
    `serverBuild` for its pre-resume portion, same as every other field this
    stamp added.

    Original note follows.

    **Dashboard shows no server identity** (2026-08-22, from item 41). The
    viewer's `/api/info` now serves `worldserver: { build, startedAtMs } | null`
    off the module's `/health`, and the fleet gate record carries `build`, but
    no page renders either. A one-line footer ("server harness-0.3-41-gabc123,
    up since 11:07") on the fleet and run pages is the whole job; `null` should
    read as "server unreachable from the viewer", which on the host is the
    normal state because compose does not publish 8086 — set
    `WRATHBENCH_MODULE_URL` for the viewer, or publish the port to loopback,
    before the footer can say anything. Per-run server build (which build a
    trajectory ran against) wants the runner to log `/health`'s `build` in its
    run header; not done here.

43. **Subscription-lane quota pauses should be resumable** (2026-08-22).
    Today, when the claude-subscription lane hits its quota window, the pause
    ends the run instead of holding it. A long nav-probe episode loses all its
    progress to a window that reopens on its own a few hours later. Want: the
    run pauses in place and resumes when the window reopens, instead of
    exiting.

44. **Abandoned snippets keep driving the character** (2026-08-22, nav-probe
    `fleet-nav-probe-sonnet-20260822` scratchpad). A snippet that exceeds the
    tool time limit is abandoned by design (runtime survives, host.ts), but its
    loop of `moveTo` calls keeps running and moves the character while the
    model has already been handed control back. The model's own workaround was
    "fewer iterations per snippet". Want: a cooperative abort — each eval gets
    a signal that SDK waits honor, abandonment aborts it (pending move stopped
    deterministically), and the result says so. No new helper beyond that.
    **Shipped 2026-08-22.** Each eval runs under its own AbortController,
    ambient as `signal` and threaded into the SDK client via AsyncLocalStorage
    (`ConnectOptions.signal` takes a provider); every client wait rejects with
    `EventAbortedError` (the absence of a verdict, like `EventTimeoutError` —
    never a synthetic status), a `moveTo` aborted mid-walk issues `stop` once,
    `sleep` rejects too, and the abandonment message says so. The runtime
    still survives and the late result is still discarded. Routines launched
    by a snippet that returned normally keep their own (never-aborted) signal.
    Found on the way: a single-expression snippet is awaited REPL-style, so
    the launch-a-routine recipe needs a trailing value — guidance fixed.

45. **Scenario-fixture characters for smokes** (2026-08-23, from the ADR-0023
    amendment). The fast gate proves what a level-1 character can reach in
    under a minute from the Northshire spawn. Every late-game claim — a dungeon
    entrance, a flight path, a trainer with ranks to sell, a mailbox with mail,
    the tram, death far from a graveyard — is minutes of play away from the
    spawn, so it can only live in the deploy-time arc or not be gated at all.
    Want: pre-seeded characters. An `infra/fixtures` tool writes the
    `acore_characters` rows for a named scenario (level, position, quest log,
    inventory, spells) while the character is logged out, on the smoke
    accounts only; a smoke logs into the fixture and proves its claim in
    seconds. Never reachable from the runner or the SDK — it is an operator
    tool against the database, not an action, so the contract in
    docs/CONTRACTS.md is untouched. Same path fixes the two smokes left out of
    the gate: `spellbook.ts` (deletes last, pays the 60s linger) and
    `module-navigation.ts` (no `MODULE_ACCOUNT`). Also worth listing while
    here: CMSG_LOGOUT_REQUEST on the raw allowlist would let any smoke end
    cleanly in 20s instead of 60.

## Ladder work (harness-0.3 / 0.4)

The eight-rung ladder in `docs/VISION.md` is the guide; rung 4 (a capital, the
tram, one flight — unaided) is the public release trigger. Items 38–40 are the
surface work that gets there. Source for 38: the 2026-08-22 spatial-delivery
research synthesis (operator's notes) and the travel probe (WORKLOG).

38. **Navigation plan — rungs 2–4** (2026-08-22). Supersedes the ordering in
    item 18; the probe already made travel the obstacle, so Layer A is earned.
    Scoped to what a capital needs: walking, the Deeprun Tram, flight masters.
    Boats, zeppelins and elevators are rung-7 work and stay out.

    **N1 — actions and statuses** (gate for everything below) — **code shipped
    2026-08-22 (ADR-0027, commits 92f7df1..b88dd1d); gate run pending deploy.**
    - [x] `no_path` split into distinguishable causes (`target_off_mesh`,
      `path_incomplete`, `no_mesh`, plus `start_off_mesh`), with the z-ladder /
      subdivision retry done by the module itself: it is a pathing detail, the
      same layer as obstacle avoidance, not a decision the model should have to
      make. (`meshZ` / `reachedPos` on the result; per-status SDK hints.)
    - [x] `CMSG_AREATRIGGER` dispatched automatically inside `move_to` when the
      character enters a DBC trigger volume — client parity, not an agent
      action. A real client fires it without the player choosing to; the
      agent observes the consequence (transfer, quest credit, inn). The module
      reads `AreaTrigger.dbc` from the data volume; `WB_AREATRIGGER` mirrors it.
    - [x] Map change observed: tap `SMSG_TRANSFER_PENDING` / `SMSG_NEW_WORLD` /
      `SMSG_TRANSFER_ABORTED`, update `state.self.position.map`; SDK `moveTo`
      resolves `transferred` on the server-confirmed new map, never on dispatch.
    - [x] Bounded waits on transfers with typed results (`waitForTransfer`:
      `transferred` / `aborted` / `waiting` / `no_transfer` / `wrong_map`)
      instead of sleeping.
    - [x] Transport-relative movement (ONTRANSPORT packets from model bounds,
      `onTransport` on the result, `WB_RIDE_PROGRESS` while riding) — needed
      for the tram leg; boarding is walking onto the car.
    - [ ] Gate: the travel probe (`infra/smoke/travel.ts`, rewritten without the
      z-ladder) rides the tram end to end with a typed success and no
      undifferentiated `no_path`. Run it three times on PROBE after the next
      deploy window and record wall-clock per leg; ADR-0027 flips to accepted
      on that run. Known residuals to watch: interpolated-vs-applied position
      at trigger dispatch (re-armed after 1.5s), and triggers are only tested
      while a `move_to` is active.

    **N2 — field-level observations** (each small, each earned, each logged)
    - Zone / area name on self, derived from position and the same DBC the
      client ships; a `milestone` record (item 35) on change. No packet carries
      this; the client computes it, so the module may.
    - NPC role on nearby units from `UNIT_NPC_FLAGS` (flight master, innkeeper,
      trainer, vendor) — the same field family as the questgiver status.
      Role, not recommendation.
    - Innkeeper bind (`CMSG_BINDER_ACTIVATE`, `SMSG_BINDPOINTUPDATE`) so the
      hearthstone is a real connector.
    - Log the exact model-facing payload for each so the later
      text-vs-other-channel experiment is honest.

    **N3 — flight paths** (the first real destination-choice surface)
    - Gossip a visible flight master → tap `SMSG_SHOWTAXINODES` (current node
      and known-node mask, exactly what the client receives) → `activate_taxi`
      → on-taxi movement state in the cache so the loop does not fight the
      flight → arrival as a postcondition. Never the TaxiPath catalogue.
    - Gate: the probe flies one hop; a model discovers and uses a flight
      master unaided.

    **N4 — rung-4 attempts**
    - Opus / Fable runs with milestone records on. Score destination choice from
      the records: destination chosen → connector chosen → action dispatched →
      transfer confirmed / not_visited / waiting / wrong_map / stuck → arrival at
      server-confirmed map+xyz. Never "ended near the coordinate"; that scores
      `move_to`.

    **Not in 0.3, by decision:** a `here()` / `goTo(name)` helper, rendered
    minimap as a model observation (ADR-0019 stays operator-only), the
    TaxiPath / areatrigger_teleport tables, walkability masks, a persistent
    map notebook (a labeled context-engine change under item 8b if ever).

    **Open decision:** item 18(4) shipped wowwiki infobox coordinates into
    `search_reference` on 2026-08-22. The research verdict is that exact yards
    are an answer key for the scored lane and should be names-first unless a
    held-out / perturbed-twin protocol exists. Decide before the first scored
    rung-4 run; either keep and label, or drop from the scored lane.

39. **Spellbook, cooldowns, and the raw-action escape hatch** (2026-08-22;
    harness-0.3, cross-cutting). SHIPPED 2026-08-22 in the `:next` module
    build + SDK (taps, `state.spells()/cooldowns()/talents()`,
    `learnTalent`, `raw` per ADR-0025; CONTRACTS drift corrected). Still
    open from this item: equipped-bag contents. The agent cannot observe what it can cast:
    `SMSG_INITIAL_SPELLS`, `SMSG_LEARNED_SPELL`, `SMSG_REMOVED_SPELL`,
    `SMSG_SPELL_COOLDOWN`, `SMSG_COOLDOWN_EVENT` are not tapped, so models
    guess spell ids from the wiki and loop on cast-failed. Tap them, add
    `state.self.spells` and cooldowns to the cache; rung 3 ("spells trained")
    is unverifiable without it. Talents ride along: `CMSG_LEARN_TALENT`,
    `SMSG_TALENTS_INFO`. Equipped-bag contents are the other blind spot
    (backpack only today). Separately, ADR-0015 promises a raw-action escape
    hatch and `WrathClient.action()` is private: expose a whitelisted-opcode
    passthrough so a trajectory can demonstrate need for a surface before the
    module and SDK grow a helper for it — that is the ADR's own rule. Doc
    drift to fix in the same change: `docs/CONTRACTS.md` lists trainers as
    deferred (shipped) and `whisper` as present (never implemented).

40. **Group tier — rung 6** (2026-08-22; harness-0.4, after 38/39). Party
    actions (`CMSG_GROUP_INVITE` / `ACCEPT` / `DECLINE` / `UNINVITE` /
    `DISBAND`, `CMSG_LOOT_METHOD`), taps (`SMSG_GROUP_INVITE`,
    `SMSG_GROUP_LIST`, `SMSG_PARTY_MEMBER_STATS`,
    `SMSG_PARTY_COMMAND_RESULT`), `state.group` in the cache, party chat and
    `whisper`, quest sharing (`CMSG_PUSHQUESTTOPARTY`). Harness side:
    per-character credentials (item 10) and a multi-session runner.
    Consider 3.3.5's Dungeon Finder (`CMSG_LFG_JOIN` family): it teleports a
    formed party into the instance, which is a client-legal way to attempt
    Deadmines before cross-continent travel and instance-portal triggers are
    reliable. Trade, mail, bank, auction house and guilds stay behind the
    earned-by-need rule until a freeplay run asks for them.
