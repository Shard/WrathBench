/**
 * Probe for group loot rolls (FOLLOW-UPS 102): two grouped characters kill a
 * creature whose loot always holds an uncommon item, the corpse opens a roll
 * frame for both, each votes through `lootRoll`, and the verdict names a
 * winner who gets the item.
 *
 * Why Leprithus. A roll only opens for an item at or above the group's loot
 * threshold, uncommon by default and not settable lower (GroupHandler refuses
 * it). No ordinary low-level creature has a guaranteed green; instance bosses
 * do, but a fixture cannot place a character inside an instance, and the
 * harness has no GM command path (SOAP is off by contract, the console is
 * interactive). Leprithus (entry 572, Westfall) is a static, unpooled rare
 * whose loot group is all uncommon, so every kill drops one, and at a
 * 72000s respawn far from every current run he is up unless this smoke
 * killed him within the last twenty hours. If he is not in view the smoke
 * FAILS saying so — that is the one precondition it cannot arrange.
 *
 * Arc: two throwaway Human Warriors, PROBE and SMOKE2 (the group smoke's
 * pattern), both placed by `leprithus-westfall` (level 30, twelve yards from
 * his spawn) -> both in world -> A invites B, B accepts (group loot is the
 * default on a fresh group) -> A kills Leprithus with B assisting -> A loots
 * the corpse: the green is ROLL_ONGOING in the window (auto-loot leaves it),
 * SMSG_LOOT_START_ROLL reaches both -> state.pendingRolls() names it on both
 * -> A needs, B greeds (each echoed as `rolled` with a number) ->
 * SMSG_LOOT_ROLL_WON names A (need beats greed) -> the item is pushed to A ->
 * a `no_pending_roll` refusal on B afterwards, as a value with a hint ->
 * leave, logout, delete.
 *
 * What it proves: the five roll packets decoded, the roll frame folded and
 * closed by the right events, the vote body, the echo, the winner. What it
 * does not: disenchant (nobody in the group enchants) and master loot.
 *
 * It FAILS against any worldserver built before the taps. Run it only after
 * the image is deployed: it is the gate for the item 102 build.
 *
 * Run from inside the network:
 *   docker compose -f infra/compose.yml exec runner bun infra/smoke/loot-roll.ts
 */

import { connect, isDecodeError, isEvent } from "../../sdk/src/index";
import { applyScenario, ensureFixtureCharacter, type FixtureContext } from "./lib/fixture";
import { probeName } from "./lib/name";

const BASE = `http://${process.env.MODULE_HOST ?? "worldserver"}:${process.env.MODULE_PORT ?? "8086"}`;
const ACCOUNT_A = process.env.MODULE_ACCOUNT ?? "PROBE";
const ACCOUNT_B = process.env.MODULE_ACCOUNT2 ?? "SMOKE2";
const RUN = crypto.randomUUID();
const NAME_A = probeName("Bra");
const NAME_B = probeName("Brb");
const SCENARIO = "leprithus-westfall";
const LEPRITHUS = 572;

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
for (const ctx of [fixtureFor(ACCOUNT_A, NAME_A, TOKEN_A), fixtureFor(ACCOUNT_B, NAME_B, TOKEN_B)]) {
  await ensureFixtureCharacter(ctx);
  await applyScenario(ctx, SCENARIO);
}

const a = await connect({ baseUrl: BASE, token: TOKEN_A });
const b = await connect({ baseUrl: BASE, token: TOKEN_B });
try {
  await a.createSession({ account: ACCOUNT_A, character: NAME_A, race: 1, class: 1 });
  await b.createSession({ account: ACCOUNT_B, character: NAME_B, race: 1, class: 1 });
  log(`both in world: ${NAME_A} ${a.state.self.guid}, ${NAME_B} ${b.state.self.guid}`);
  await Bun.sleep(1000);
  const up = await a.waitForNearby((o) => o.entry?.value === LEPRITHUS, { timeout: 10_000 }).catch(() => undefined);
  if (up === undefined) fail("Leprithus (572) is not in view — he respawns 72000s after a kill; this smoke cannot arrange him, try later");

  // 1. Group up; a fresh group is group loot at the uncommon threshold.
  const invite = await a.inviteToGroup(NAME_B, { timeout: 10_000 });
  if (!invite.ok) fail(`invite refused: ${invite.hint}`);
  await b.events.waitForOpcode("SMSG_GROUP_INVITE", { timeout: 10_000 });
  const group = await b.acceptGroupInvite({ timeout: 10_000 });
  await a.events.waitFor((e) => e.opcode === "SMSG_GROUP_LIST" && (e.data as any).left === false, { timeout: 10_000 });
  log(`PASS group: ${group.members.map((m) => m.name).join(", ")} + self, lootMethod=${JSON.stringify(a.state.group()?.lootMethod)}`);

  // 2. Kill him together; B assists so the corpse is the group's.
  const target = a.state.units({ entry: LEPRITHUS, alive: true })[0] ?? fail("no live Leprithus in view");
  const assist = b.killTarget(target.guid, { timeout: 180_000 }).catch((e) => ({ ok: false, status: `threw: ${String(e)}` }) as const);
  const kill = await a.killTarget(target.guid, { timeout: 180_000 });
  log(`killTarget A: ${kill.status}; B: ${(await assist).status}`);
  if (!kill.ok) fail(`Leprithus not killed: ${JSON.stringify(kill)}`);

  // 3. Loot: the green stays in the window as ROLL_ONGOING and the roll frame opens on both.
  const rollOnA = a.events.waitFor((e) => isEvent(e, "SMSG_LOOT_START_ROLL") && !isDecodeError(e.data), { timeout: 20_000 });
  const rollOnB = b.events.waitFor((e) => isEvent(e, "SMSG_LOOT_START_ROLL") && !isDecodeError(e.data), { timeout: 20_000 });
  const looted = await a.lootCorpse(target.guid, { timeout: 20_000 });
  log(`lootCorpse: ${JSON.stringify({ ok: looted.ok, status: looted.status })}`);
  const [startA, startB] = await Promise.all([rollOnA, rollOnB]);
  log(`SMSG_LOOT_START_ROLL: ${JSON.stringify(startA.data)}`);
  if ((startA.data as any).rollGuid !== (startB.data as any).rollGuid) fail("the two characters see different rolls");
  await Bun.sleep(1000); // the item query names it
  const pendingA = a.state.pendingRolls();
  const pendingB = b.state.pendingRolls();
  if (pendingA.length !== 1 || pendingB.length !== 1) fail(`pendingRolls: A ${pendingA.length}, B ${pendingB.length}, expected one each`);
  const roll = pendingA[0]!;
  if (roll.name === undefined || (roll.quality ?? 0) < 2) fail(`the roll is not a named uncommon: ${JSON.stringify(roll)}`);
  if (!roll.allowed.includes("need") || !roll.allowed.includes("greed")) fail(`need/greed not offered: ${JSON.stringify(roll.allowed)}`);
  log(`PASS frame: both see a roll on ${JSON.stringify(roll.name)} (quality ${roll.quality}), buttons ${roll.allowed.join("/")}`);

  // 4. Vote by name on A (need) and by roll guid on B (greed); need beats greed.
  const wonOnA = a.events.waitFor((e) => (isEvent(e, "SMSG_LOOT_ROLL_WON") || isEvent(e, "SMSG_LOOT_ALL_PASSED")) && !isDecodeError(e.data), { timeout: 70_000 });
  const needed = await a.lootRoll(roll.name, "need", { timeout: 15_000 });
  if (!needed.ok) fail(`A's need refused: ${needed.status} — ${needed.hint}`);
  const greeded = await b.lootRoll(roll.rollGuid, "greed", { timeout: 15_000 });
  if (!greeded.ok) fail(`B's greed refused: ${greeded.status} — ${greeded.hint}`);
  log(`rolled: A need ${needed.roll}, B greed ${greeded.roll}`);
  if (a.state.pendingRolls().length !== 0 || b.state.pendingRolls().length !== 0) fail("a voted roll is still pending");
  const verdict = await wonOnA;
  log(`${verdict.opcode}: ${JSON.stringify(verdict.data)}`);
  if (!isEvent(verdict, "SMSG_LOOT_ROLL_WON")) fail("everyone passed?");
  if ((verdict.data as any).winnerGuid !== a.state.self.guid) fail(`winner ${(verdict.data as any).winnerGuid}, expected ${NAME_A} (need over greed)`);
  await a.events.waitFor((e) => isEvent(e, "SMSG_ITEM_PUSH_RESULT") && !isDecodeError(e.data) && (e.data as any).itemId === roll.itemId, { timeout: 15_000 });
  log(`PASS verdict: ${NAME_A} won ${JSON.stringify(roll.name)} and it was pushed`);

  // 5. Nothing left to vote on: a value with a hint, nothing sent.
  const late = await b.lootRoll(roll.name, "pass");
  if (late.ok || late.status !== "no_pending_roll") fail(`late vote should be no_pending_roll: ${JSON.stringify(late)}`);
  if (!b.drainActionHints().some((h) => h.action === "lootRoll" && h.status === "no_pending_roll")) fail("no hint recorded for the late vote");
  log("PASS refusal: no_pending_roll with a hint");
  await a.leaveGroup({ timeout: 10_000 }).catch(() => {});
  console.log(`PASS: loot-roll (${((Date.now() - started) / 1000).toFixed(1)}s)`);
} catch (e) {
  console.log(`FAIL: ${String(e instanceof Error ? (e.stack ?? e.message) : e)}`);
  process.exitCode = 1;
} finally {
  await a.logout().catch(() => {});
  await b.logout().catch(() => {});
  await a.deleteCharacter(NAME_A, { account: ACCOUNT_A }).catch((e) => log(`delete ${NAME_A} failed: ${String(e)}`));
  await b.deleteCharacter(NAME_B, { account: ACCOUNT_B }).catch((e) => log(`delete ${NAME_B} failed: ${String(e)}`));
  a.close();
  b.close();
}
