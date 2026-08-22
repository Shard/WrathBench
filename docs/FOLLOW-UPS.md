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
    prompt; (4) a contract-clean coordinates source — the probe hardcoded DB-derived
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
