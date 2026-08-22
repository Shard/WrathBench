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
    Depended on the item-14 teleport ack, which has shipped.

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

22. **Map replay of historical runs** (Mark, 2026-08-22). The live map view
    (ADR-0019) renders a position-feed interface, not the live store — replay is a
    trajectory reader plus a time cursor plugged into the same renderer: route
    lines, death sites, zone coverage per run. Deliberately deferred; the seam is
    the position-feed type in runner/viewer. Anything that makes the renderer
    live-only regresses ADR-0019.

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

25. **`search_reference` ranks id noise above the entity page, and never says
    "you already asked this"** (2026-08-22 review). laguna issued 11 searches and
    nemotron 13 *identical* queries in one episode; the top hits were pages whose
    only match was a numeric-id substring, with the actual NPC/quest page below
    them. Two changes, both harness-side: rank an exact title/entity match above a
    body substring, and de-noise bare-number matches (an id match should require the
    id to be in an id-shaped field, not anywhere in the text). Then make repetition
    visible — a per-episode memo of "this query returned these titles N turns ago"
    in the tool result, so a model re-asking sees it is re-asking rather than
    reading the same list as if it were new. The second half is the cheaper of the
    two and probably the one that saves turns.

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

27. **Questgiver status icon on nearby units** (`SMSG_QUESTGIVER_STATUS` /
    `_MULTIPLE`) — the `!`/`?`/greyed marker a real client renders over an NPC's
    head, and squarely inside the observation contract: it is a packet a client
    receives. Today a snippet cannot tell a questgiver from a guard, or an *ender*
    from a *giver*, without interacting and waiting out a silence. That silence is
    the single most expensive failure in the 2026-08-22 review — laguna spent turns
    103-238 at 0.1y from the giver of quest 783 (McBride ends it), ox-alpha 8-10
    turns, nemotron 10, qwen 5 — and an icon on `state.units()` would let a snippet
    filter enders before ever sending an opcode. Module work: tap the opcode, fold
    the status onto the object in the state cache, expose it as a `UnitFilter` key.

28. **Quest objective text and required counts** — the client renders
    "Kobold Vermin slain: 0/8" from the quest query response
    (`SMSG_QUEST_QUERY_RESPONSE`); the SDK exposes only the packed progress
    `counts: [n,n,n,n]` from the quest log, with no objective names and no
    denominators. So a model that has the quest cannot tell *what* to kill or *how
    many*: ox-alpha lost ~15-20 turns grinding wolves for a kobold quest, watching
    `counts` stay at 0 and concluding the counter was broken. Module work
    (`CMSG_QUEST_QUERY` plus the response decode), then a `state.quest(id)` that
    carries `objectives: [{ text, required, have }]`. Pairs with item 27: together
    they are most of what a client actually shows about a quest.

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
