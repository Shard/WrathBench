/**
 * Probe for group loot rolls (FOLLOW-UPS 102): `SMSG_LOOT_START_ROLL` folded
 * into `state.pendingRolls()` on every member, `lootRoll` (by name or roll
 * guid) sending `CMSG_LOOT_ROLL`, `SMSG_LOOT_ROLL` / `SMSG_LOOT_ROLL_WON`
 * echoing the votes and the verdict, need beating greed, the won item
 * landing in the winner's bag (there is no ITEM_PUSH_RESULT for a roll), and
 * the late vote refused as `no_pending_roll` with a hint.
 *
 * It FAILS against any worldserver built before the tap. Run it only after
 * the image is deployed: it is the gate for the item 102 build.
 *
 * Why a chest and not a kill: a roll needs a drop at or above the group's
 * loot threshold, and the threshold cannot go below uncommon
 * (HandleLootMethodOpcode refuses it). No open-world creature under level
 * 35 has a guaranteed green (the guaranteed groups are all instance bosses);
 * the earlier fixture, Leprithus in Westfall, is a rare on a 20h respawn,
 * which made the smoke a coin toss, not a gate. A Battered Chest (template
 * 2849) has `groupLootRules` set, so Player::SendLoot hands its window to
 * Group::GroupLoot like a corpse, and its loot group 1 is 332 equal-chanced
 * uncommon entries: every open yields at least one green, and its other
 * (non-grouped) loot references can add more — the 2026-08-30 run rolled two
 * at once — so the arc below is written for N >= 1 rolls. The Lakeshire one
 * (guid 20651) is in no pool and respawns in 7200s. If it is not in view —
 * something opened it in the last two hours — the smoke reports SKIP and
 * exits 0: a respawn window, not a verdict on the build.
 *
 * Arc: two level-30 Human Warriors (PROBE + MODULE_ACCOUNT2) placed by
 * `battered-chest-lakeshire`, facing the chest -> group up (group loot,
 * uncommon threshold by default) -> A opens the chest (lootCorpse casts the
 * lock's Opening spell) -> both see one SMSG_LOOT_START_ROLL per ROLL_ONGOING
 * slot in the window, the same set on each, every one a named uncommon with
 * need/greed offered -> A needs every roll (by name where the name is
 * unambiguous, else by roll guid), B greeds every one by roll guid -> one
 * SMSG_LOOT_ROLL_WON per roll names A with rollType 1, every item appears in
 * A's bag and none in B's -> B's late vote is no_pending_roll with a hint ->
 * leave, logout, delete both.
 *
 * Run from inside the network:
 *   docker compose -f infra/compose.yml exec -T -e MODULE_ACCOUNT=PROBE -e MODULE_ACCOUNT2=SMOKE2 runner bun infra/smoke/loot-roll.ts
 */

import { connect, isDecodeError, isEvent, type WrathClient } from "../../sdk/src/index";
import { applyScenario, deleteFixtureCharacters, ensureFixtureCharacter, type FixtureContext } from "./lib/fixture";
import { probeName } from "./lib/name";

const BASE = `http://${process.env.MODULE_HOST ?? "worldserver"}:${process.env.MODULE_PORT ?? "8086"}`;
const ACCOUNT_A = process.env.MODULE_ACCOUNT ?? "PROBE";
const ACCOUNT_B = process.env.MODULE_ACCOUNT2 ?? "SMOKE2";
const RUN = crypto.randomUUID();
const NAME_A = probeName("Bra");
const NAME_B = probeName("Brb");
const SCENARIO = "battered-chest-lakeshire";
const BATTERED_CHEST = 2849;

const started = Date.now();
const log = (m: string) => console.log(`[loot-roll +${((Date.now() - started) / 1000).toFixed(1).padStart(5)}s] ${m}`);
function fail(m: string): never {
  throw new Error(m);
}

const health = await fetch(`${BASE}/health`).then((r) => r.json() as Promise<any>);
if (!health?.ok) fail(`health not ok: ${JSON.stringify(health)}`);
log(`health ok: build=${health.build ?? "?"}; ${NAME_A} on ${ACCOUNT_A}, ${NAME_B} on ${ACCOUNT_B}`);

function fixtureFor(account: string, character: string, token: string): FixtureContext {
  return {
    base: BASE,
    account,
    character,
    token,
    log,
    fail,
    contendedDeadlineMs: 10_000,
    contendedRetryMs: 5_000,
    createAndLogout: async () => {
      const c = await connect({ baseUrl: BASE, token: `${token}-create` });
      try {
        await c.createSession({ account, character, race: 1, class: 1 });
        await c.logout();
      } finally {
        c.close();
      }
    },
  };
}
const TOKEN_A = `smoke-loot-roll-a-${RUN}`;
const TOKEN_B = `smoke-loot-roll-b-${RUN}`;
const fixtureA = fixtureFor(ACCOUNT_A, NAME_A, TOKEN_A);
const fixtureB = fixtureFor(ACCOUNT_B, NAME_B, TOKEN_B);

/** Thrown to leave the arc after a SKIP line: not a failure, the finally still cleans up. */
const SKIPPED = Symbol("skipped");
let a: WrathClient | undefined;
let b: WrathClient | undefined;
try {
  for (const ctx of [fixtureA, fixtureB]) {
    await ensureFixtureCharacter(ctx);
    await applyScenario(ctx, SCENARIO);
  }
  a = await connect({ baseUrl: BASE, token: TOKEN_A });
  b = await connect({ baseUrl: BASE, token: TOKEN_B });
  await a.createSession({ account: ACCOUNT_A, character: NAME_A, race: 1, class: 1 });
  await b.createSession({ account: ACCOUNT_B, character: NAME_B, race: 1, class: 1 });
  log(`both in world: ${NAME_A} ${a.state.self.guid}, ${NAME_B} ${b.state.self.guid}`);
  await Bun.sleep(1000);
  const up = await a.waitForNearby((o) => o.entry?.value === BATTERED_CHEST && o.fields.has("goType"), { timeout: 10_000 }).catch(() => undefined);
  if (up === undefined) {
    console.log(`SKIP: loot-roll — the Battered Chest (${BATTERED_CHEST}) is not in view: opened within the last 7200s, retry after its respawn (not a build verdict)`);
    process.exitCode = 0;
  } else {
    const chest = a.state.units({ type: "gameObject" }).find((u) => u.entry === BATTERED_CHEST) ?? fail("the chest is not in units()");
    if (chest.goType !== "chest") fail(`the chest's goType is ${chest.goType}, expected chest`);
    if (chest.distance === undefined || chest.distance > 5) fail(`the chest is ${chest.distance}y away — did apply.ts place the character?`);

    // 1. Group up; a fresh group is group loot at the uncommon threshold.
    const invite = await a.inviteToGroup(NAME_B, { timeout: 10_000 });
    if (!invite.ok) fail(`invite refused: ${invite.hint}`);
    await b.events.waitForOpcode("SMSG_GROUP_INVITE", { timeout: 10_000 });
    const group = await b.acceptGroupInvite({ timeout: 10_000 });
    const listedBy = Date.now() + 10_000;
    while (!a.state.group()?.members.some((m) => m.name === NAME_B) && Date.now() < listedBy) await Bun.sleep(100);
    if (!a.state.group()?.members.some((m) => m.name === NAME_B)) fail(`A's member list lacks ${NAME_B}`);
    log(`PASS group: ${group.members.map((m) => m.name).join(", ")} + self, lootMethod=${JSON.stringify(a.state.group()?.lootMethod)}`);

    // 2. Open the chest as the group: every over-threshold drop stays in the window as ROLL_ONGOING (slotType 1) and opens a roll frame on both.
    // The roll frame only opens on the chest's first fill (Player::SendLoot
    // rolls when the game object is GO_READY). A chest a failed run left
    // half-looted opens again with its leftovers and no roll; empty it so it
    // despawns, and report the respawn window rather than a verdict.
    const rollOnA = a.events.waitFor((e) => isEvent(e, "SMSG_LOOT_START_ROLL") && !isDecodeError(e.data), { timeout: 20_000 });
    const rollOnB = b.events.waitFor((e) => isEvent(e, "SMSG_LOOT_START_ROLL") && !isDecodeError(e.data), { timeout: 20_000 });
    rollOnA.catch(() => undefined);
    rollOnB.catch(() => undefined);
    const looted = await a.lootCorpse(chest.guid, { timeout: 20_000 });
    log(`lootCorpse(chest): ${JSON.stringify({ ok: looted.ok, status: looted.status, window: looted.ok ? looted.window : undefined })}`);
    if (!looted.ok) fail(`the chest did not open: ${JSON.stringify(looted)}`);
    const startA = await rollOnA.catch(() => undefined);
    if (startA === undefined) {
      console.log(`SKIP: loot-roll — the chest opened with no roll (a previous run left it half-looted; ${looted.items.length} leftover(s) taken so it despawns): retry after its 7200s respawn (not a build verdict)`);
      await a.leaveGroup({ timeout: 10_000 }).catch(() => {});
      process.exitCode = 0;
      throw SKIPPED;
    }
    await rollOnB;
    log(`SMSG_LOOT_START_ROLL: ${JSON.stringify(startA.data)}`);

    // One roll per ROLL_ONGOING slot: the window names them, so the count is a
    // fact off the server, not a sleep. A single open can put several items at
    // or above the threshold (two on 2026-08-30), so nothing below assumes one.
    const rolling = looted.window.filter((i) => i.slotType === 1);
    if (rolling.length === 0) fail(`the window holds no ROLL_ONGOING slot: ${JSON.stringify(looted.window)}`);
    const key = (r: { slot: number; itemId: number }) => `${r.slot}:${r.itemId}`;
    const named = (c: WrathClient) => c.state.pendingRolls().filter((r) => r.name !== undefined);
    const framesBy = Date.now() + 15_000;
    while ((named(a!).length < rolling.length || named(b!).length < rolling.length) && Date.now() < framesBy) await Bun.sleep(200);
    const pendingA = a.state.pendingRolls();
    const pendingB = b.state.pendingRolls();
    if (pendingA.length !== rolling.length || pendingB.length !== rolling.length) {
      fail(`pendingRolls: A ${pendingA.length}, B ${pendingB.length}, expected ${rolling.length} (one per ROLL_ONGOING slot in ${JSON.stringify(rolling)})`);
    }
    const setA = pendingA.map(key).sort().join(", ");
    const setB = pendingB.map(key).sort().join(", ");
    if (setA !== setB) fail(`the two characters see different roll sets: A [${setA}], B [${setB}]`);
    if (setA !== rolling.map(key).sort().join(", ")) fail(`the roll frames [${setA}] do not match the window's ROLL_ONGOING slots [${rolling.map(key).sort().join(", ")}]`);
    for (const roll of pendingA) {
      const mirror = pendingB.find((r) => key(r) === key(roll))!;
      if (mirror.rollGuid !== roll.rollGuid) fail(`slot ${roll.slot} item ${roll.itemId} is roll ${roll.rollGuid} on A but ${mirror.rollGuid} on B`);
    }
    if (new Set(pendingA.map((r) => r.itemId)).size !== pendingA.length) {
      // Two draws of the same green: the bag poll below cannot tell them apart.
      // A roll of the chest's 332-entry group, not a build verdict.
      console.log(`SKIP: loot-roll — this open rolled the same item twice (${JSON.stringify(pendingA.map((r) => r.itemId))}), which the bag check cannot tell apart: retry after the 7200s respawn (not a build verdict)`);
      await a.leaveGroup({ timeout: 10_000 }).catch(() => {});
      process.exitCode = 0;
      throw SKIPPED;
    }
    for (const roll of pendingA) {
      if (roll.name === undefined || (roll.quality ?? 0) < 2) fail(`a roll is not a named uncommon: ${JSON.stringify(roll)}`);
      if (!roll.allowed.includes("need") || !roll.allowed.includes("greed")) {
        fail(`need/greed not offered on ${JSON.stringify(roll.name)} (slot ${roll.slot}, item ${roll.itemId}): ${JSON.stringify(roll.allowed)}`);
      }
    }
    log(`PASS frames: both see ${pendingA.length} roll(s) — ${pendingA.map((r) => `${JSON.stringify(r.name)} q${r.quality} slot ${r.slot} (${r.allowed.join("/")})`).join("; ")}`);

    // 3. Vote every frame: A needs (by name where the name is unambiguous, by
    // roll guid otherwise — a duplicate name is ambiguous_roll, not a failure),
    // B greeds by roll guid. Need beats greed on each.
    for (const roll of pendingA) {
      const unique = roll.name !== undefined && pendingA.filter((o) => o.name === roll.name).length === 1;
      const which = unique ? roll.name! : roll.rollGuid;
      const needed = await a.lootRoll(which, "need", { timeout: 15_000 });
      if (!needed.ok || needed.status !== "rolled") fail(`A's need on ${JSON.stringify(which)} refused: ${needed.status} — ${(needed as any).hint}`);
      log(`  A needed ${JSON.stringify(roll.name)} by ${unique ? "name" : "roll guid"}: ${needed.status}`);
    }
    for (const roll of pendingB) {
      const greeded = await b.lootRoll(roll.rollGuid, "greed", { timeout: 15_000 });
      if (!greeded.ok || greeded.status !== "rolled") fail(`B's greed on roll ${roll.rollGuid} refused: ${greeded.status} — ${(greeded as any).hint}`);
      log(`  B greeded ${JSON.stringify(roll.name)} by roll guid: ${greeded.status}`);
    }
    // Both acks are acknowledgements, not rolls: CountRollVote echoes need as
    // rollNumber 0 / rollType 0 and greed as 128, and the numbers actually
    // rolled only go out in CountTheRoll's batch. `rolled` is the assertion.
    // `choice` is the button passed in (the ack cannot be read back for it) and
    // `roll` is undefined on every ack, so neither is a server-sourced fact:
    // the verdict's rollType below is what proves need beat greed.
    if (a.state.pendingRolls().length !== 0 || b.state.pendingRolls().length !== 0) fail("a voted roll is still pending");

    // One verdict per roll, matched by slot + item (the core sends
    // ObjectGuid::Empty as the verdict's source). `waitFor` searches the
    // retained buffer, so collecting after the votes cannot miss one.
    for (const roll of pendingA) {
      const verdict = await a.events
        .waitFor(
          (e) =>
            (isEvent(e, "SMSG_LOOT_ROLL_WON") || isEvent(e, "SMSG_LOOT_ALL_PASSED")) &&
            !isDecodeError(e.data) &&
            (e.data as any).slot === roll.slot &&
            (e.data as any).itemId === roll.itemId,
          { timeout: 70_000 },
        )
        .catch(() => undefined);
      if (verdict === undefined) fail(`no verdict for ${JSON.stringify(roll.name)} (slot ${roll.slot}, item ${roll.itemId}) within 70s of the votes`);
      log(`${verdict.opcode}: ${JSON.stringify(verdict.data)}`);
      if (!isEvent(verdict, "SMSG_LOOT_ROLL_WON")) fail(`everyone passed on ${JSON.stringify(roll.name)}?`);
      if ((verdict.data as any).winnerGuid !== a.state.self.guid) fail(`winner ${(verdict.data as any).winnerGuid} on ${JSON.stringify(roll.name)}, expected ${NAME_A} (need over greed)`);
      if ((verdict.data as any).rollType !== 1) fail(`the verdict's rollType on ${JSON.stringify(roll.name)} is ${(verdict.data as any).rollType}, expected 1 (need beating greed)`);
    }
    // Group::CountTheRoll stores the won item with StoreNewItem and never
    // calls SendNewItem, so no SMSG_ITEM_PUSH_RESULT is ever sent for a roll
    // (verified against deps/azerothcore: Group.cpp has no SendNewItem call).
    // The item arrives only as the object update state.bag() folds — poll it.
    const wonItems = pendingA.map((r) => r.itemId);
    const holds = (c: WrathClient, itemId: number) => c.state.bag().items.some((i) => i.itemId === itemId);
    const bagBy = Date.now() + 15_000;
    while (!wonItems.every((id) => holds(a!, id)) && Date.now() < bagBy) await Bun.sleep(200);
    const missing = wonItems.filter((id) => !holds(a!, id));
    if (missing.length > 0) {
      fail(`${NAME_A} won ${JSON.stringify(wonItems)} but ${JSON.stringify(missing)} is not in state.bag() 15s later: ${JSON.stringify(a.state.bag().items)}`);
    }
    const wrongBag = wonItems.filter((id) => holds(b!, id));
    if (wrongBag.length > 0) fail(`${NAME_B} lost every roll but holds ${JSON.stringify(wrongBag)}`);
    log(`PASS verdicts: ${NAME_A} won all ${wonItems.length} roll(s) (${pendingA.map((r) => JSON.stringify(r.name)).join(", ")}) and they are in the bag`);

    // 4. Nothing left to vote on: a value with a hint, nothing sent.
    const late = await b.lootRoll(pendingA[0]!.name ?? pendingA[0]!.rollGuid, "pass");
    if (late.ok || late.status !== "no_pending_roll") fail(`late vote should be no_pending_roll: ${JSON.stringify(late)}`);
    if (!b.drainActionHints().some((h) => h.action === "lootRoll" && h.status === "no_pending_roll")) fail("no hint recorded for the late vote");
    log("PASS refusal: no_pending_roll with a hint");
    await a.leaveGroup({ timeout: 10_000 }).catch(() => {});
    console.log(`PASS: loot-roll (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  }
} catch (e) {
  if (e !== SKIPPED) {
    console.log(`FAIL: ${String(e instanceof Error ? (e.stack ?? e.message) : e)}`);
    process.exitCode = 1;
  }
} finally {
  await a?.logout().catch(() => {});
  await b?.logout().catch(() => {});
  a?.close();
  b?.close();
  await deleteFixtureCharacters(fixtureA, [NAME_A]);
  await deleteFixtureCharacters(fixtureB, [NAME_B]);
}
