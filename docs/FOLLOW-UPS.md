# Follow-ups

Open items as of 2026-08-21, end of the first full build-and-run day. Ordered by
priority. Items graduate out of this file into commits; the dev loop
(docs/PHASE-0.md) decides when.

## Gate work

1. ~~Sandbox restart notice never reached the model~~ **Fixed 2026-08-21**:
   the notice only existed on the timeout→ping→kill path; a child that died on
   its own (gate2-ox-3's case) rejected the eval with a bare error, emitted no
   notice, counted no restart, and left the host holding a dead proc handle.
   `host.ts` now detects unexpected exits in `onExit`, emits the
   `sandbox_restarted` notice with recovery guidance, counts it for the
   runaway watchdog, and respawns lazily. Two tests cover mid-snippet and
   between-snippet death.
2. ~~Canonical gate-2 confirmation episode~~ **PASSED 2026-08-21**
   (gate2-ox-4): full chain in causal order in one unaided episode — accept
   turn 9 → 8/8 kill credits → loot → quest 7 turn-in (170 XP) → level 3.
3. ~~Gate 3 rerun~~ **PASSED 2026-08-21** (gate2-ox-4): 2h06m, 123 turns,
   zero harness-attributable errors (6 snippet errors, all model-attributable;
   no watchdog fires, no sandbox restarts, no harness notices).
4. ~~Gate 4 rehearsal~~ **PASSED 2026-08-21**: down -v, fresh up, db
   re-import, bootstrap verified, module-slice + session-state probes PASS,
   spectator ports green; Quick Start in README validated (images prebuilt —
   fresh-machine compile of the pinned tree is the one unexercised step).

## Harness quality

5. ~~WB_SESSION_STATE live verification~~ **Verified 2026-08-21** by
   `infra/smoke/module-session-state.ts`: reattach to an in-world session
   delivers one synthetic state event with the right character/guid/position/
   level, a pre-login subscriber gets none, and the event fans out to every
   subscriber with a shared seq.
6. ~~eventCount vs lastSeq +3 drift~~ **Fixed 2026-08-21**: not
   double-application — `lastSeq` was max'd, so after session-retry churn
   restarted the seq numbering it held the old session's max (+3 = the three
   events the aborted first session delivered). `StateCache.apply` now assigns
   `lastSeq` from every non-gap event; `eventCount` remains a lifetime counter
   across sessions by design.
7. ~~Whitelist census review~~ **Done 2026-08-21** over 11 runs (1,723
   drops): no dropped opcode showed a model demonstrably blocked — the
   ADR-0015 small-surface bar holds, all skipped. Two watch-items to
   re-check later, both flagged by the census rather than by a hurt run:
   - `SMSG_QUESTGIVER_STATUS_MULTIPLE`: agents currently get no passive
     quest-marker signal at all (the whitelisted singular STATUS only
     answers explicit queries) and compensate with wiki lookups; fine in
     Northshire's ~5-NPC hub, may not scale to bigger zones.
   - `SMSG_INITIAL_SPELLS`: CONTRACTS promises "known spells" as an
     observation but no opcode serves it; add when a spellcasting class
     first needs `cast_spell` against uncertain ids, not before.
8. Claude-driver ContextBuilder: state sampling and watchdog checks are solid
   now, but a `quota-exhausted` pause still loses the CLI's accumulated
   context on resume (documented; acceptable for shakeout).
   Amended 2026-08-22 (morning-opus-1 post-mortem): the subscription lane
   also never applies the context policy the prompt describes — no trim,
   one CLI conversation growing linearly (111k tokens at 40 min, ~640
   tok/turn slope), so ~98% of that run's 10.2M tokens were cache-read
   replays of the growing prefix. The prompt's "older conversation is
   trimmed aggressively" is false on this lane; either the driver applies
   a policy or the prompt stops promising one. Cost comparisons across
   drivers are invalid until then.

8a. **Extractive digest — deferred behind an evidence gate** (2026-08-21
   research verdict, three-agent pass). Dynamic context compaction is not
   needed on current evidence: requests plateau at ~8–12k tokens under the
   fixed policy regardless of episode length. (2026-08-22: the plateau
   claim held for the API driver at the 24-window; under the 24→48
   hysteresis medians run 13–20k, and the gate is now arguably tripped for
   the subscription lane specifically — see item 8's amendment: unbounded
   linear growth, ~330k extrapolated for a 2-hour episode.) If either signal appears —
   (a) genuine context-size exhaustion in a run, or (b) trajectories showing
   a model re-querying facts it lost to a window trim — build the extractive
   digest: trimmed messages replaced by a deterministic one-line record
   (tool, truncated args, error flag) in a capped ring buffer inside the
   regenerated context message. Within the current harness version: no model
   summarization (conflates constructs, breaks replay) and no per-model
   context scaling (provider-declared context sizes drift for the same model
   id).

8b. **Context engine as a labeled run condition — operator direction,
   deliberately parked** (2026-08-21). When this is picked back up, the
   proposal to draft is: (a) stretch the window well beyond 24–48 in a
   future harness version — observed steady state is ~8–12k tokens against
   131k–200k model contexts, so a much longer stable prefix is nearly free
   under prompt caching and more compute/cost-efficient per run; (b) offer
   threshold-triggered model self-compaction ("grow to X% of budget, then
   the model compacts its own history") as a versioned **context engine**
   recorded in run metadata, the way shakeout runs are stamped — scores
   comparable within an engine, never silently across engines. Rationale:
   the harness is already opinionated in many ways; for end-user-relevant
   evaluation, grow-then-self-compact is the de-facto standard agents run
   under, and context management for games is a fraught problem where
   pinning one tweak of the current policy forever is unlikely to be the
   long-term answer. This supersedes the flat "no model summarization ever"
   phrasing of 8a: that verdict holds for unlabeled changes to the current
   engine, not for a future labeled one.

14. **Death is unrecoverable — an unacked teleport permanently freezes
   movement (night-opus-1, 2026-08-22)**. Nightopus (Dwarf Paladin) reached
   level 5, died to the Frostmane camp at -5550,550 in Dun Morogh, released,
   and then sat at the Kharanos graveyard for twelve minutes — `run.sqlite`
   shows the identical position across every state sample — before deleting
   and recreating the character at level 1. Five levels lost to the harness,
   not to the model.
   - **Root cause: the module never acks a teleport, so any teleport freezes
     movement permanently.** `Player::RepopAtGraveyard` calls `TeleportTo`
     (`Player.cpp:5034`); a same-map teleport sets `SetSemaphoreTeleportNear`
     (`Player.cpp:1512/1538`) and the server then *discards every movement
     opcode* until the client sends `MSG_MOVE_TELEPORT_ACK` —
     `MovementHandler.cpp:373`, `if (plrMover && plrMover->IsBeingTeleported())`
     → ignore. Only `HandleMoveTeleportAck` clears the semaphore and applies
     the destination (`MovementHandler.cpp:292-320`,
     `plMover->UpdatePosition(dest, true)`). The module has **no teleport
     handling of any kind** — `grep -rn Teleport module/src` is empty — so it
     never sends that ack. After a repop the character is wedged: the
     synthesized `MSG_MOVE_START_FORWARD`/`HEARTBEAT` packets are silently
     dropped, the server-side position never advances, and the module reports
     `interrupted` (position gap, `WbManager.cpp:1126`) or `no_path`
     (PathGenerator run from the un-applied old position). The same mechanism
     explains why `state.self.position` still read the death spot after repop
     and only corrected after a relogin: the server had not applied the
     destination either.
   - **Second, independent blocker**: `WbManager.cpp:1070`. The movement tick
     fires `FinishMove(s, "interrupted")` for any `!player->IsAlive()`, which
     is true of a ghost as much as of a corpse on the ground. Stopping a move
     when you die mid-run is right; conflating the two death states is the
     bug. Even with the teleport ack fixed, this alone makes the corpse run —
     the normal 3.3.5a recovery — impossible. It is the module's only
     `IsAlive` reference; nothing else is ghost-aware.
   - **Third blocker**: no `CMSG_SPIRIT_HEALER_ACTIVATE` in the action
     whitelist (`WbManager.cpp:345`), so the graveyard fallback is a dead end
     too. Selecting the spirit healer's "Return me to life" repeatedly
     produced only the `SMSG_SPELL_GO` 17251 visual with health pinned at
     1/150. The task hypothesis that release-spirit is missing was wrong:
     `repop` is whitelisted and returned ok — it set a *pending* graveyard
     teleport that was never applied (see root cause), not a completed one.
     `reclaim_corpse` is whitelisted too and also returned ok, but
     `HandleReclaimCorpseOpcode` (`MiscHandler.cpp:633`) drops the packet
     silently on any of five preconditions — not alive, no ghost flag, no
     corpse, inside the 30s reclaim delay, or outside `CORPSE_RECLAIM_RADIUS`.
     The ack says nothing about which one fired, so from the model's side a
     successful reclaim and a rejected one are indistinguishable.
   - **The two bugs are load-bearing in sequence, and the observability gap is
     what chains them.** The unacked teleport left Nightopus standing *at its
     corpse*, where `reclaim_corpse` would have worked exactly as it did for
     the other two runs. But `state.self.position` still read the death spot,
     so the model relogged to shake the apparent freeze — and the logout
     flushed the pending `m_teleport_dest`, applying the graveyard teleport
     and stranding the ghost 520y from the corpse. Only then did the 1070
     guard make the corpse run impossible. The stale position did not merely
     cost time; it converted a recoverable death into an unrecoverable one.
   - **Why earlier runs looked fine**: gate2-ox-4 (Elwynn mine, level 3) and
     night-xpreview-1 (Durotar, level 2) both died and both recovered on the
     same character in under two minutes — `repop` then `reclaimCorpse`, with
     health restored and position unchanged. Neither had to move: the corpse
     was still inside the reclaim radius (xpreview measured the ghost-to-corpse
     distance as 0). That is the same bug wearing a friendly face: their
     corpses were underfoot *because* the graveyard teleport never took
     effect. gate2-ox-4's `SMSG_DEATH_RELEASE_LOC` named -8935,-188 while the
     character sat at -8752,-193 — the release location and the actual
     position disagree by 190y, which is the unapplied teleport in plain
     sight. Death recovery therefore only "works" when you never have to move
     again. No run has ever moved as a ghost, and by the code above none
     could.
     - gate2-ox-4 is the load-bearing corroboration: after its second death it
       reclaimed successfully and was **alive at 104/104**, yet stayed frozen
       at the exact death coordinates with every horizontal move returning
       `interrupted`/`no_path` for the rest of the run. The `IsAlive` guard
       cannot explain that. `HandleReclaimCorpseOpcode` does not teleport — it
       calls `ResurrectPlayer` and nothing else — so what wedged it was the
       *repop's* pending near-teleport, which the reclaim restored health and
       cleared the ghost flag around but never resolved. That run passed its
       gate with a permanently immobilized character.
   - **Fourth defect, independent of death**: `moveTo` correlates the terminal
     `WB_MOVE_RESULT` on `moveId` alone against a lifetime event ring
     (`sdk/src/client.ts:865-879`), but `moveIdGen` is a per-`BenchSession`
     field reset on every session recreate. After a relog the SDK matches the
     *previous* session's stale results: one sweep of ten probes with 8s
     timeouts resolved in 59ms, another of 24 probes with 9s timeouts in
     136ms, and one call returned a byte-identical result (`moveId:2, seq:36,
     ts:1787328532685`) 87 seconds after the event. The comment at 867-872
     documents the seq-restart hazard and picks `moveId` as the safe key on
     the assumption it is unique per session; the reset makes that false.
     This corrupted most of the model's post-relog probing and would corrupt
     any future diagnosis the same way.
   - **Fix, in priority order**: (1) send `MSG_MOVE_TELEPORT_ACK` whenever the
     player is `IsBeingTeleportedNear` — this is the highest-value fix and is
     not death-specific, since any same-map teleport wedges movement the same
     way; a real client always sends it. (2) Make the 1070 guard distinguish
     ghost from dead-at-corpse (the ghost aura 8326 was observable
     in-trajectory, so the states are separable server-side) and let chained
     ghost moves run — note the 250y cap at `WbManager.cpp:676` against a
     ~520y corpse distance, so one short hop will not prove the fix works.
     (3) Add spirit-healer-activate as the fallback and give `reclaim_corpse`
     a real out-of-range answer. (4) Document death recovery in the runner
     prompt, which currently says nothing about it. Fix the moveId
     correlation separately (scope the match to the session that issued the
     ack). Verification must be an actual death far from the graveyard
     followed by a completed corpse run — no smoke test currently dies.
   - **Contract gap that let this ship**: ADR-0013 lists "death recovery" in
     the Phase 0 action set and it was accepted on ack-returns-ok evidence.
     Both its non-trivial legs are broken, and no smoke test exercises death
     (`infra/smoke/` covers movement, quests, session state, slice, one-quest),
     so the only two deaths before night-opus-1 happened to be the one shape
     that survives.
   - **Status 2026-08-22 — fixed in code, awaiting the morning deploy** (live
     runs in progress; the rebuilt worldserver image is built but deliberately
     not deployed). What landed:
     1. Module acks pending teleports automatically (`TickTeleportAcks`, world
        tick): `MSG_MOVE_TELEPORT_ACK` for near, `MSG_MOVE_WORLDPORT_ACK` for
        far, through the stock handlers, paced retries. The agent never sees
        teleports; the semaphore check is module-internal bridging like the
        TIME_SYNC answer.
     2. The mover guard now stops only a dead-unreleased body; a ghost
        (`PLAYER_FLAGS_GHOST`) moves, so the corpse run works.
     3. `spirit_healer_activate` whitelisted end-to-end (module action, SDK
        helper, PROTOCOL/CONTRACTS notes). No new observation opcode needed:
        the resurrection is visible through already-served events.
     4. SDK scopes `WB_MOVE_RESULT` correlation to a session epoch (advanced
        on `createSession` and on seq-restart detection); regression test in
        `sdk/test/client.test.ts` covers the stale-result relog case.
     5. `/character-delete` minimally gated: only accounts on the
        `WrathBench.Accounts` allowlist (compose: RUNNER, RUNNER2, SHAKEOUT,
        PROBE; defaults to `WrathBench.Account` when unset) are served, and
        never while a different token holds a live bench session on the
        account (`403 account_not_permitted` /
        `409 account_owned_by_other_token`). The first cut hard-coded the
        single configured account and broke smoke-probe cleanup on PROBE
        post-deploy; the allowlist replaced it 2026-08-22, and `/session` and
        `/characters` now apply the same allowlist for symmetry.
        Per-character credentials remain item 10.
     6. Runner prompt documents die → repop → ghost-run → reclaimCorpse with
        the spirit-healer fallback, including reclaim's silent-rejection
        behaviour (the client gets no packet either; not decodable server-side).
     Checked, no change needed: module port 8086 is not published to any host
     interface in `infra/compose.yml` (only 3724/8085, both 127.0.0.1-bound);
     the `0.0.0.0` bind is container-internal on the compose bridge network so
     the runner can reach `worldserver:8086`.
     Morning sequence: deploy the rebuilt worldserver image after 07:30, run
     `infra/smoke/` probes, then verify with an actual death far from the
     graveyard followed by a completed corpse run — no smoke test dies yet,
     and remember the 250y `move_to` cap means the ghost run is chained hops.
   - **Verified end-to-end 2026-08-22**: `infra/smoke/death-recovery.ts` now
     dies for real (level-1 Human vs pulled Kobold Vermin, 150y from the
     graveyard) and passed against the deployed worldserver — repop teleport
     applied, ghost corpse run arrived, reclaim resurrected.
   - **Aside, character-delete has no ownership check** (status above, point 5):
     `Manager::HttpCharacterDelete` requires only a non-empty `token` that is
     not currently in use and a non-empty `character`; `account` is
     caller-supplied and defaults to the configured one. Nothing binds the
     token to the character or the account, and the HTTP surface has no
     authentication at all (`WrathBench.BindAddress` defaults to `0.0.0.0`).
     The model deleted its own level-5 character by minting fresh
     `night-opus-1-delN` tokens until one landed — that is the documented
     `deleteCharacter` retry loop working as written, not an escalation, but
     it means any caller who can reach the port can delete any character on
     any named account that is not currently logged in. Real hole; a
     token-to-character binding plus a shared secret on the port is the
     obvious floor before anything runs on a non-loopback bind.

15. **Un-awaited SDK call killed the sandbox — Bun's default unhandled-rejection
    policy was fatal to the child (night-laguna-oc-1, 2026-08-22)**. Three
    `sandbox_restarted` events (turns 33/35/40), each 4–100ms after a snippet
    that returned ok. The common shape:
    `console.log("Quest list:", JSON.stringify(sdk.questList()))` — no await, no
    guid. `questList()` returns a promise (stringifies as `{}`), the module
    rejects the malformed action after the HTTP round trip, and the rejection
    has no holder. Bun 1.4 exits the process on an unhandled rejection, so the
    whole runtime — bindings, routines, event connection — died for a routine
    error the try/catch around the eval could never see. Turns 34/39 ran the
    same nearbyUnits loop *without* the fire-and-forget call and survived, which
    is the controlled diff. Reproduced offline with the exact snippet.
    Compounding it, the host was blind: stderr was `inherit` and `onExit`
    ignored the exit code, so the notice said only "exited unexpectedly".
    Fixed 2026-08-22: the child installs `unhandledRejection` /
    `uncaughtException` handlers that report (log-buffer entry the next snippet
    result carries, plus a `fatal` → session_note notice) instead of dying; the
    host pipes child stderr, keeps a tail, and stamps exit code, signal, and
    last stderr into the `sandbox_restarted` notice. Regression tests in
    `runner/test/sandbox.test.ts`. Live episodes launched before the fix run
    the old loaded code and remain exposed until relaunch; no module change.

16. **"Quest-giver flicker" hypothesis killed — the churn was real visibility
    edges plus hallucinated creature entries (night-laguna-oc-2, analyzed
    2026-08-22)**. The prior read ("fast spawn/despawn NPCs, interacts landing
    a beat too late") is wrong on both counts. From the served event stream:
    Conservator Ilthalaine (entry 2079, guid …6902581540) and Tarindrella
    (entry 1992, guid …5442963864) were created at t+0 (Ilthalaine at 3.8y)
    and every subsequent DESTROY/OUT_OF_RANGE for either guid happened with
    the character 64–104y away — never within 30y, let alone interact range.
    The create/destroy churn at ~100y is the server's visibility boundary
    (Tarindrella wanders a few yards across it); night-xpreview-1 and
    night-hy3-1 show the identical far-edge events in the same zone and
    quested fine. The actual failure: laguna hallucinated wowhead-style
    entries (1984 = "Ilthalaine", 1988/1992 = "Tarindrella", 2031 =
    "Melithar") when the live queries say 1984 = Young Thistle Boar, 1988 =
    Grell, 2031 = Young Nightsaber — so its entry-filtered scans matched
    nothing, it chased respawning critters as "cycling quest NPCs" for ~40
    minutes, and it never once referenced Ilthalaine's real guid (0 snippets).
    Its two clean gossips (seq 1499, 7186) hit Tarindrella, whose empty
    quest menu is correct game behavior without the Melithar pre-quest.
    Module destroy/OOR forwarding and StateCache (prunes only on
    destroy/outOfRange, no distance/staleness eviction) are both clean.
    Classification: model, not harness. Secondary tallies: laguna-oc-2
    122 snippets / 91 interact-ish / 18 errors (7 BigInt-stringify, the rest
    misuse: `u.fields?.value?.entry` on a Map, missing_guid/position);
    roster-nemotron-nano 81 snippets, 33 "AggregateError: Parse error"
    (invalid TS), 0 interact calls, stalled at 359 xp. The weak-model
    bottleneck is knowledge/API discipline (invented entries, unread wire
    truth), not observation flicker or action plumbing. No code change.

17. **Failure-surface audit — Tier 1 + Tier 2 shipped 2026-08-22**. An audit
    of 2,680 tool results across the overnight runs (229 errors) mapped every
    failure surface; the deterministic, model-agnostic fixes landed:
    - *Parse errors carry positions* (43/229 were a bare "AggregateError:
      Parse error"): the sandbox flattens Bun transpiler AggregateErrors (and
      lone BuildMessages) into per-error message + line:column + lineText,
      line numbers corrected for the compile wrapper (`entry.ts`).
    - *Guid/position validation client-side*: `guidArg`/`toBigInt` reject
      `undefined`/`null` (naming the method and where guids come from) and
      `number` (precision-truncated guids silently target nothing); `moveTo`
      validates x/y/z as finite numbers, naming the bad axis.
    - *`selfKey` prototype-safe* and the prompt's SDK-inspection idiom is now
      descriptor-based (never invokes getters).
    - *Tool arg contract matches the advertised schema*: `z.strictObject`, so
      unknown keys error naming them and the valid keys; alias normalization
      (cmd/snippet/source/script/ts→code, text/markdown→content, q→query)
      runs before validation; argument strings get JSON→fence-strip→
      trailing-comma-repair leniency; recent_events `limit` coerces + clamps;
      final failures echo ~200 chars received and restate params in prose;
      unknown tool names list the six tools with a Levenshtein/substring
      "did you mean".
    - *Module missing-param replies echo `action` + `param`*; unparseable
      guid fields are `400 invalid_guid` (echoing the value) instead of
      silently coercing to guid 0. PROTOCOL.md updated; image rebuilt, not
      deployed (live runs).
    - *Hints for all known error codes* rendered into `WrathRequestError`
      messages (the CHAR_RESPONSE_HINTS pattern generalized).
    - *Timeout ergonomics*: abandoned-eval message points at background
      routines and warns the code may still be running; the timed-out
      snippet's buffered console logs come back via the liveness ping's
      drain (pong carries `logs`); the event-loop-kill message carries the
      state-loss recovery guidance; BigInt-stringify TypeErrors name the fix,
      and the prompt states guids are bigints.
    - *`EventTimeoutError` says what it was waiting for* (`description`
      threaded through `waitFor`; SDK helpers label their waits).
    Parked pending ADRs (deliberately not shipped): BigInt.prototype.toJSON,
    sdk.wait/events.off aliases, machine-readable error class taxonomy.
    **ADR-0017 shipped 2026-08-22**: guids are opaque decimal strings at the
    model surface (state fields, helper params/returns, event payloads);
    bigint lives only behind the SDK's parseGuid/formatGuid seam. The BigInt
    error class is gone from SDK surfaces; the sandbox's BigInt-stringify
    hint stays for snippet-conjured bigints (a `123n` literal) and the prompt
    now states the string contract.

18. **Long-distance travel findings (`infra/smoke/travel.ts`, 2026-08-22)**.
    A Dwarf walked Coldridge Valley → Coldridge Pass tunnel → Kharanos →
    Ironforge gates → Tinker Town tram entrance (~1,900y, 18/18 waypoints,
    7.7 min) on chained `move_to` hops, then tried to enter the Deeprun Tram.
    - *What works*: per-hop mmaps pathing is excellent — the tunnel, the
      switchback roads, and the long ascending IF entrance hall were all
      wall-followed within single hops; waypoints taken from creature spawn
      coordinates (things that provably stand on the mesh) arrived first try,
      0.0–0.1y off, at ~7y/s. Zone/area transitions on map 0 (Coldridge →
      Dun Morogh → Ironforge city) are seamless and invisible — no event,
      no hiccup. Mobs aggroing en route (7 SMSG_ATTACKSTART) never
      interrupted a move. No teleport ever fired on this route, so the
      teleport-ack fix (item 14) was not load-bearing on the ground path;
      it becomes load-bearing exactly where leg 3 dies (below).
    - *`no_path` is three different failures wearing one name*, and the agent
      cannot tell them apart: (a) target z off the mesh by more than a few
      yards — interpolated z on the IF entrance ramp was 20y off and drew 5–6
      rejections until a z-ladder retry (±4/10/20/40) landed; (b) path too
      long/complex — the 143y Tinker Town → tram-portal hop returned
      `no_path` at *every* z, yet the same route as two ~72y hops arrived
      cleanly, i.e. PATHFIND_SHORT/INCOMPLETE folded into `no_path`
      (WbManager.cpp:780–791); (c) a genuine mesh edge (the portal tunnel,
      below). All rejections return in <20ms, so probing is cheap; the
      recovery recipe that cleared every recoverable case is z-ladder then
      midpoint subdivision, and an agent would have to invent it unprompted.
      Splitting the status (or documenting the recipe in the prompt) is the
      cheap fix.
    - *The Deeprun Tram is a hard blocker, before the tram itself is ever
      reached*: areatrigger teleports (trigger 2175 → map 369) fire on
      client-sent CMSG_AREA_TRIGGER, which the module never sends and no
      action can express (no raw-opcode escape hatch). Walking into the
      portal does nothing, and the navmesh ends ~8y inside the tunnel
      (y≈-1330: `arrived` at -1326.5, `no_path` at -1334.5, zero forward
      progress) — the character stood at the mesh edge on map 0 for the
      whole creep. The timed-platform/moving-transport question is therefore
      unreachable and untested. Even if the trigger fired, the transfer
      would be invisible today: SMSG_TRANSFER_PENDING / SMSG_NEW_WORLD are
      not served, and `state.self.position.map` only ever updates from
      SMSG_LOGIN_VERIFY_WORLD — plus a far teleport needs the worldport ack
      that only the rebuilt (item-14) image sends.
    - *Surface a future run would need*, in order: (1) module sends
      CMSG_AREA_TRIGGER when the player is standing in a teleport trigger's
      volume — client parity, and it opens the tram, instance portals, and
      inn/exit triggers in one move; (2) serve SMSG_TRANSFER_PENDING /
      SMSG_NEW_WORLD and update self map from them; (3) split `no_path` into
      distinguishable causes or teach the recovery recipe; (4) a coordinates
      source — this probe hardcoded DB-derived waypoints, which the
      observation contract denies an agent; the wiki bundle's wowwiki
      coordinates are the contract-clean equivalent. Transport (boat/tram/
      zeppelin) semantics stay unknown until (1) and (2) land.

19. **Unguessable session tokens — pre-public/MCP blocker** (fan-out review
    2026-08; accepted-risk statement in docs/CONTRACTS.md). `POST /action`
    and `DELETE /session` authenticate by bearer token alone, and the runner
    defaults tokens to the run id — a second-granularity timestamp — so a
    snippet in one run can enumerate and drive/tear down a concurrent run
    through the one host its egress allowlist permits (the module).
    Accepted while every lane is operator-launched on the private compose
    network. Before any public or MCP-exposed deployment, or before trusting
    any adversarial multi-run result: issue a random secret at session
    create, return it only to the creator, require it on every subsequent
    token-bearing call (`/action`, `DELETE /session`, `/events`). Module and
    runner change together, backward compat off — they ship from the same
    tree. Related but distinct from item 10 (per-character credentials).
    Related residual (2026-08-22): the sandbox child no longer inherits or
    auto-loads host env (--env-file=/dev/null + allowlist), but a snippet can
    still fs-read `.env` by absolute path — closing that needs filesystem
    sandboxing and joins this item as a pre-public blocker. Trajectory audit
    2026-08-22: no historical run ever read env or the file.

20. **Solo auto-loot never stored an item — Fixed 2026-08-22**
    (morning-opus-1 post-mortem). The module's `loot_all` replay collected
    only `LOOT_SLOT_TYPE_ALLOW_LOOT` (0) slots, but every solo
    `SMSG_LOOT_RESPONSE` marks its slots `LOOT_SLOT_TYPE_OWNER` (4)
    (LootMgr.cpp, PERMISSION_OWNER) — so the module sent only
    `CMSG_LOOT_RELEASE` and no item ever entered a bag, while the SDK
    reported `{ ok: true, status: "looted" }` from the window contents.
    Fixed on both sides: the module accepts ALLOW_LOOT and OWNER (MASTER/
    ROLL_ONGOING/LOCKED stay excluded — group states a solo benchmark never
    auto-stores), and `lootCorpse` now derives its result from the
    `SMSG_ITEM_PUSH_RESULT` receipts, with a distinct `none_stored` status
    when the window had items but none were stored (the ADR-0016 rule that
    would have caught this on day one). Shipped alongside, same post-mortem:
    `turnInQuest` races `SMSG_INVENTORY_CHANGE_FAILURE` and returns
    `inventory_full` instead of timing out on a full bag; `state.bag()` —
    the backpack view opus rebuilt by hand from push listeners, invSlot
    regexes and a forced relog (ADR-0015 bar met); and the prompt now
    documents both SDK tiers briefly, as ADR-0015 said it should.

## Surface candidates (add when a run makes them the obstacle)

9. **Trainers** — every model so far has visited Brother Sammuel and probed
   for a train action (deferred in docs/CONTRACTS.md Phase 0 set). First
   candidate for the next action-surface widening; needs SMSG_TRAINER_LIST
   decode + CMSG_TRAINER_BUY_SPELL.
10. Per-character credentials (PHASE-0 deferred list) — required before any
    run parallelism beyond the current one-account-per-run scheme.

## Housekeeping

11. ~~data/runs/run-mcp-check~~ Deleted 2026-08-21 (pre-fix artifact, no
    termination record).
12. ~~Tag 0.1~~ **Done 2026-08-21**: all four gates passed; tagged
    `harness-0.1` (annotated). Runs launched via run-episode.sh now stamp
    `harness-0.1[-N-gHASH]` from git describe. Everything before the tag was
    harness validation, not results (ADR-0004).
13. **Metric design against grind collapse** (before Phase-1 measurement):
    RuneBench's own site records that raw total-XP "punished exploration" and
    collapsed to "simple grind with as little stopping as possible"; they
    moved to peak XP-rate windows. Our furthest-level metric has the same
    exposure — decide the Phase-1 metric (quest weight, level-per-hour curve,
    or similar) deliberately and write the ADR before the first scored run,
    not after (their mid-eval metric change is half of why aggregators
    exclude their results).
