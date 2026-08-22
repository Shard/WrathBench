# Worklog

Dated records of investigations and fixes that graduated out of docs/FOLLOW-UPS.md.
The trajectory data and the commits are the primary sources; this is the narrative
index — what was wrong, why, and what shipped. Reverse chronological.

## 2026-08-22

### API ergonomics pass: HUD, generated API.md, UnitView/gossip-by-text, wiki coords (issue #2, items 1–4)

A four-part harness-surface change to make the existing two-tier API usable the way
RuneBench's is, without importing porcelain or breaking the observation contract.
Item 5 (travel / `no_path` split / area triggers) was deliberately not started.

- **Item 1 — state HUD** (`b5e3d8b`). `formatStateSummary` became a fixed line-oriented
  client HUD (session, character, position, health, xp, money, bag, quests, target,
  nearby, open-window `ui` fold, stream, chat) driven only by observed snapshot fields;
  unobserved still prints `unobserved`, never `0`. The nearby line derives from
  `state.units()` and never prints exact mob health (CONTRACTS.md); the `ui` fold is
  computed in the sandbox (which holds the full event buffer) so `formatStateSummary`'s
  signature — and its off-limits callers — stayed untouched.
- **Item 2 — generated `sdk/API.md`** (`56be196`). A generator emits the doc from the live
  `WrathClient`/`StateCache`/`EventStream` prototypes with bidirectional drift checks
  (an invented row or an undocumented public method fails the build); `bun run docs:api:check`
  gates staleness. The sandbox exposes it as ambient `API_MD_PATH`, and the prompt's
  `Object.getOwnPropertyDescriptors` introspection recipe (ADR-0015's turn-waster) was
  deleted in favour of pointing at that file.
- **Item 3 — name-on-find, guid-on-act** (`2ed903c`, `8910a17`, `337ecfb`). `state.units({name})`
  matching went from substring-includes to exact/whole-word/shortest-then-nearest (and
  accepts a RegExp); guid-taking helpers now accept a `UnitView` directly while raw
  actions stay guid-only (deliberate ADR-0015 fence); `gossipSelect(guid, "option text")`
  resolves against a new last-gossip cache fold from `SMSG_GOSSIP_MESSAGE`/`_COMPLETE`.
- **Item 4 — wiki coordinate channel** (`10e871e`). Coordinates are extracted from raw
  wowwiki wikitext (`{{coords}}`, infobox loc) *before* stripping and persisted in a new
  `page_coords` bundle table (schema v2, fail-closed on old bundles); `search_reference`
  returns them as reference hints, explicitly not live observation. No AzerothCore DB or
  Questie source.

ADR-0004 consequence: this bumps the harness surface (prompt, context policy, SDK, and
reference bundle all changed together), so free-model scores before and after this pass
are not comparable — the post-cutover build is the new baseline. ADR-0012 gained a dated
addendum for the HUD; item 18's "wowwiki coordinates" clause is closed.

### Death was unrecoverable: an unacked teleport froze movement permanently (item 14)

Night-opus-1 (Dwarf Paladin, level 5) died in Dun Morogh, released, and then sat
motionless at the Kharanos graveyard for twelve minutes before deleting and
recreating the character at level 1. Five levels lost to the harness, not the model.

Root cause: the module never acked a teleport. `RepopAtGraveyard` calls `TeleportTo`,
which sets the near-teleport semaphore (`Player.cpp:1512/1538`); the server then
discards every movement opcode until the client sends `MSG_MOVE_TELEPORT_ACK`
(`MovementHandler.cpp:373`). The module had no teleport handling at all, so after any
teleport the character was wedged — synthesized movement packets silently dropped,
server-side position never advancing, moves returning `interrupted` or `no_path`.
Three further blockers stacked on it: the movement tick stopped any `!IsAlive()`
mover (`WbManager.cpp:1070`), conflating a ghost with a corpse and making the corpse
run impossible; `CMSG_SPIRIT_HEALER_ACTIVATE` was not whitelisted, so the graveyard
fallback was a dead end; and `reclaim_corpse` returned an indistinguishable ok
whether the server accepted or silently dropped it on one of five preconditions.
Independently, `moveTo` correlated terminal `WB_MOVE_RESULT` events on `moveId`
alone (`sdk/src/client.ts:865-879`) against a lifetime ring, but `moveIdGen` reset on
session recreate — so after a relog the SDK matched the previous session's stale
results, corrupting the model's own diagnosis.

Earlier deaths (gate2-ox-4, night-xpreview-1) had looked fine only because their
corpses were underfoot — the graveyard teleport had never applied. gate2-ox-4 in
fact finished its run alive at full health and permanently immobilized, and passed
its gate that way.

Shipped: module acks pending teleports on the world tick (`TickTeleportAcks`, near
and far, through the stock handlers, paced retries) — module-internal bridging the
agent never sees; the mover guard now stops only a dead unreleased body so a ghost
moves; `spirit_healer_activate` whitelisted end to end; SDK scopes move-result
correlation to a session epoch, with a regression test in `sdk/test/client.test.ts`;
`/character-delete`, `/session` and `/characters` gated to a `WrathBench.Accounts`
allowlist; the runner prompt documents die → repop → ghost run → reclaim with the
spirit-healer fallback. Verified end to end by `infra/smoke/death-recovery.ts`, which
now dies for real 150y from a graveyard and completes the corpse run.

Lesson: an action accepted on ack-returns-ok evidence is not an action that works.
ADR-0013 listed death recovery in the Phase 0 set and no smoke test ever died, so
the only two deaths that had happened were the one shape that survives the bug.

### Un-awaited SDK call killed the sandbox (item 15)

Three `sandbox_restarted` events in night-laguna-oc-1, each milliseconds after a
snippet that returned ok. The shape was always a fire-and-forget SDK call —
`console.log("Quest list:", JSON.stringify(sdk.questList()))`, no await. The promise
rejected after the HTTP round trip with no holder, and Bun 1.4 exits the process on
an unhandled rejection, so the whole runtime died for a routine error the try/catch
around the eval could never see. Turns running the same loop without the
fire-and-forget call survived — the controlled diff. Reproduced offline.

Fixed: the child installs `unhandledRejection`/`uncaughtException` handlers that
report (log-buffer entry on the next snippet result, plus a `fatal` session note)
instead of dying; the host pipes child stderr, keeps a tail, and stamps exit code,
signal and last stderr into the `sandbox_restarted` notice. Tests in
`runner/test/sandbox.test.ts`.

Lesson: the host was blind — stderr was `inherit` and the exit code ignored, so the
notice said only "exited unexpectedly". A supervisor that cannot say why its child
died costs more than the crash.

### "Quest-giver flicker" hypothesis killed (item 16)

The prior read — fast spawn/despawn NPCs, interacts landing a beat late — was wrong
on both counts. In night-laguna-oc-2's served event stream, Conservator Ilthalaine
and Tarindrella were created at t+0 and every later destroy/out-of-range for either
guid happened with the character 64–104y away, i.e. at the server's ~100y visibility
boundary. Two other runs show the identical far-edge churn in the same zone and
quested fine.

The actual failure was the model: laguna hallucinated wowhead-style creature entries
(1984, 1988/1992, 2031) that in the live database are unrelated critters, so its
entry-filtered scans matched nothing and it chased respawning boars as "cycling quest
NPCs" for forty minutes without ever referencing the real guid it already had. Module
destroy/OOR forwarding and the StateCache were clean. No code change.

Lesson: classify weak-model failures as model or harness before fixing anything. The
weak-model bottleneck here was knowledge and API discipline — invented entries,
unread wire truth — not observation flicker or action plumbing.

### Failure-surface audit, Tier 1 and Tier 2 (item 17)

An audit of 2,680 tool results across the overnight runs (229 errors) mapped every
failure surface. The deterministic, model-agnostic fixes shipped: Bun transpiler
AggregateErrors flattened into per-error message plus line:column and line text, with
line numbers corrected for the compile wrapper (43 of 229 errors had been a bare
"AggregateError: Parse error"); client-side guid and position validation that rejects
`undefined`/`null` and precision-truncating `number` guids by name; a
descriptor-based SDK-inspection idiom that never invokes getters; tool arguments
validated as `z.strictObject` with alias normalization, JSON fence-strip and
trailing-comma repair, echoed input on failure, and a "did you mean" for unknown tool
names; module missing-param replies that echo action and param, and `400 invalid_guid`
instead of coercing to guid 0; hints rendered into `WrathRequestError` for every known
error code; timeout ergonomics (buffered logs drained via the liveness pong,
recovery guidance in the event-loop-kill message); and `EventTimeoutError` saying what
it was waiting for.

ADR-0017 shipped alongside: guids are opaque decimal strings at the model surface,
with bigint confined behind the SDK's parseGuid/formatGuid seam.

Lesson: most model errors were the harness failing to say what was wrong, not the
model failing to reason. Auditing the error corpus in bulk found more than reading
trajectories one at a time.

### Solo auto-loot never stored an item (item 20)

The module's `loot_all` replay collected only `LOOT_SLOT_TYPE_ALLOW_LOOT` (0) slots,
but every solo `SMSG_LOOT_RESPONSE` marks its slots `LOOT_SLOT_TYPE_OWNER` (4)
(`LootMgr.cpp`, PERMISSION_OWNER). The module therefore sent `CMSG_LOOT_RELEASE` and
nothing else — no item ever entered a bag — while the SDK cheerfully reported
`{ ok: true, status: "looted" }` derived from the loot window's contents.

Fixed on both sides: the module accepts ALLOW_LOOT and OWNER (master/roll/locked stay
excluded, being group states a solo benchmark never auto-stores), and `lootCorpse`
derives its result from `SMSG_ITEM_PUSH_RESULT` receipts with a distinct
`none_stored` status. Shipped in the same post-mortem: `turnInQuest` races
`SMSG_INVENTORY_CHANGE_FAILURE` and returns `inventory_full` rather than timing out
on a full bag; `state.bag()`, the backpack view opus had rebuilt by hand from push
listeners, invSlot regexes and a forced relog (ADR-0015's bar met); and the prompt
now documents both SDK tiers.

Lesson: this is exactly the ADR-0016 rule — report the receipt, not the request.
Deriving success from what you asked for rather than what the server confirmed hid
the bug from day one.

### turnInQuest mis-statuses (item 21)

Both roster-opus and roster-sonnet read the helper's source and routed around it with
raw actions, which is the tell. Three defects in one method: a completable
`SMSG_QUESTGIVER_REQUEST_ITEMS` was answered by re-sending `quest_complete`, which the
core answers with REQUEST_ITEMS forever on item-delivery quests (now the reward is
chosen directly from that answer); a refusal while the quest log said complete
returned the same `not_complete` as unfinished objectives (now `wrong_questgiver`);
and an out-of-range turn-in burned the full timeout because the server drops it
silently (now a >40y cached-distance fast fail as `too_far`, the threshold left
deliberately gross so position staleness can never falsely reject — ADR-0016).

Shipped alongside: `item_not_usable` echoes what the local bag cache sees;
the 30s-timeout message carries a concrete fire-and-forget idiom (sonnet never once
used background routines and re-ran inline travel loops into the cap four times);
`state.self` documented as a property; claude-lane trajectory records carry a `call`
index because that lane's single long driver turn makes `turn` useless for analysis.

Lesson: when two independent models read a helper's source and issue raw actions
instead, the helper's status vocabulary is the defect.

### Long-distance travel probe (item 18)

`infra/smoke/travel.ts` walked a Dwarf from Coldridge Valley to the Deeprun Tram
entrance — about 1,900y, 18 of 18 waypoints, 7.7 minutes, on chained `move_to` hops.
Per-hop mmaps pathing is excellent: the Coldridge tunnel, switchback roads and the
long ascending Ironforge entrance hall were wall-followed inside single hops, and
waypoints taken from creature spawn coordinates (things that provably stand on the
mesh) arrived first try, 0.0–0.1y off, at ~7y/s. Zone and area transitions on map 0
are seamless and invisible. Mobs aggroing en route never interrupted a move. No
teleport fired on the ground route, so the item-14 ack fix was not load-bearing here.

Two findings became the open work in item 18. `no_path` is three different failures
wearing one name — target z off the mesh, path too long or complex
(PATHFIND_SHORT/INCOMPLETE folded into `no_path` at `WbManager.cpp:780-791`), and a
genuine mesh edge — and the agent cannot tell them apart. The recovery recipe that
cleared every recoverable case is a z-ladder (±4/10/20/40) then midpoint
subdivision; a 143y hop that failed at every z arrived cleanly as two 72y hops. All
rejections return in under 20ms, so probing is cheap. And the tram is a hard blocker
before the tram itself: areatrigger teleports fire on client-sent
`CMSG_AREA_TRIGGER`, which no action can express, and the navmesh ends about 8y
inside the portal tunnel.

Lesson: an agent would have to invent the z-ladder recipe unprompted. A status that
collapses three causes into one name pushes the whole recovery burden onto the model.

### Sandbox environment isolation (item 19 residual)

The sandbox child no longer inherits or auto-loads host environment
(`--env-file=/dev/null` plus an explicit allowlist). A trajectory audit over all
historical runs found no run had ever read the environment or the `.env` file. The
remaining gap — a snippet reading `.env` by absolute path — needs filesystem
sandboxing and stays open in item 19.

## 2026-08-21

### Dynamic context compaction: not needed on current evidence (item 8a)

A three-agent research pass concluded the extractive digest should be deferred behind
an evidence gate rather than built: under the fixed context policy, requests plateau
at roughly 8–12k tokens regardless of episode length, so there was nothing to
compact. The gate conditions (genuine context exhaustion, or a model re-querying
facts lost to a window trim) and the design to build if they trip stay open in item
8a — and the subscription-lane amendment of 2026-08-22 arguably trips them already.
