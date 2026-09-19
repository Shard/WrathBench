/**
 * Gate for quest-start items (2026-08-30): an item whose template starts a
 * quest and has no on-use spell can be used, the server offers the quest from
 * it, and the accept names the item as the questgiver.
 *
 * Why this exists: a run holding the Tome of Divinity (6916, startquest 1646,
 * no spell — and 1646 has no creature starter, the item is the only way in)
 * called useItem and got `400 item_not_usable` from the module's own
 * pre-check, with an SDK hint asserting the item had no effect. It never
 * reached the server. A client never sends CMSG_USE_ITEM for such an item
 * (HandleUseItemOpcode drops spell id 0 as unknown); its right-click is
 * CMSG_QUESTGIVER_QUERY_QUEST with the item's guid, and the accept names the
 * item guid too (both handlers take TYPEMASK_ITEM). The module now sends that
 * for a spell-less start-quest item, and the SDK waits for the offer.
 *
 * Arc, on a throwaway Human Warrior placed by `ammen-vale-runts` (level 20,
 * empty log, among Infected Nightstalker Runts in Ammen Vale — each drops the
 * Faintly Glowing Crystal 23678 at 100%, which starts Strange Findings 9455,
 * Alliance, min level 5, no class gate, no previous quest, and has no spell):
 *   1. login; a runt in view; killTarget + lootCorpse until the crystal is
 *      in the bag with its tooltip (state.items says startQuest 9455);
 *   2. useItem("Faintly Glowing Crystal") -> the module sends
 *      CMSG_QUESTGIVER_QUERY_QUEST -> SMSG_QUESTGIVER_QUEST_DETAILS for 9455
 *      -> the result carries questOffer { questId, title, itemGuid };
 *   3. acceptQuestFrom(itemGuid, 9455) -> CMSG_QUESTGIVER_ACCEPT_QUEST with
 *      the item guid -> quest 9455 in state.questLog;
 *   4. logout, delete the character.
 *
 * It FAILS against a worldserver built before 2026-08-30: use_item answers
 * `400 item_not_usable` and the SDK's message says the build predates
 * quest-start items. That failure is the gate for the deploy.
 *
 * Run from inside the network:
 *   docker compose -f infra/compose.yml exec -T runner bun infra/smoke/quest-item-start.ts
 */

import { connect, WrathRequestError, type WrathClient } from "../../sdk/src/index";
import { applyScenario, deleteFixtureCharacters, ensureFixtureCharacter, type FixtureContext } from "./lib/fixture";
import { probeName } from "./lib/name";
import { authHeaders, MODULE_SECRET } from "./lib/auth";
import { moduleBase } from "./lib/module";

const BASE = moduleBase();
const ACCOUNT = process.env.MODULE_ACCOUNT ?? "PROBE";
const TOKEN = `smoke-quest-item-start-${crypto.randomUUID()}`;
const CHARACTER = probeName("Qi");
const SCENARIO = "ammen-vale-runts";
const RUNT = 17202; // Infected Nightstalker Runt
const CRYSTAL = 23678; // Faintly Glowing Crystal: startquest 9455, no spell
const QUEST = 9455; // Strange Findings
const KILLS_MAX = 3;

const started = Date.now();
const log = (m: string) => console.log(`[quest-item-start +${((Date.now() - started) / 1000).toFixed(1).padStart(5)}s] ${m}`);
function fail(m: string): never {
  throw new Error(m);
}

const health = await fetch(`${BASE}/health`, { headers: authHeaders() }).then((r) => r.json() as Promise<any>);
if (!health?.ok) fail(`health not ok: ${JSON.stringify(health)}`);
log(`health ok: build=${health.build ?? "?"}, character=${CHARACTER} on ${ACCOUNT}`);

const fixtureCtx: FixtureContext = {
  base: BASE,
  account: ACCOUNT,
  character: CHARACTER,
  token: TOKEN,
  log,
  fail,
  contendedDeadlineMs: 10_000,
  contendedRetryMs: 5_000,
  createAndLogout: async () => {
    const c = await connect({ baseUrl: BASE, token: `${TOKEN}-create`, secret: MODULE_SECRET });
    try {
      await c.createSession({ account: ACCOUNT, character: CHARACTER, race: 1, class: 1 });
      await c.logout();
    } finally {
      c.close();
    }
  },
};
let session: WrathClient | undefined;
try {
  await ensureFixtureCharacter(fixtureCtx);
  await applyScenario(fixtureCtx, SCENARIO);
  const client = await connect({ baseUrl: BASE, token: TOKEN, secret: MODULE_SECRET });
  session = client;
  const seen: string[] = [];
  client.events.onAny((e) => {
    if (["SMSG_QUESTGIVER_QUEST_DETAILS", "SMSG_QUESTGIVER_QUEST_LIST", "SMSG_ITEM_PUSH_RESULT"].includes(e.opcode)) {
      seen.push(e.opcode);
      log(`  ${e.opcode} ${JSON.stringify(e.data)}`);
    }
  });
  await client.createSession({ account: ACCOUNT, character: CHARACTER, race: 1, class: 1 });
  log(`in world as ${CHARACTER}, guid ${client.state.self.guid}`);
  if (client.state.questLog.length !== 0) fail(`the log is not empty after the fixture: ${JSON.stringify(client.state.questLog.map((q) => q.questId))}`);

  // 1. A crystal in the bag, with its tooltip: kill and loot runts until one drops it.
  await client.waitForNearby((o) => o.entry?.value === RUNT, { timeout: 15_000 });
  const carried = () => client.state.bag().items.find((i) => i.itemId === CRYSTAL);
  for (let kill = 1; carried() === undefined; kill++) {
    if (kill > KILLS_MAX) fail(`no crystal after ${KILLS_MAX} runts — the 100% drop is hidden when 9455 cannot be taken; check the fixture's clearQuests`);
    const runt = client.state.units({ entry: RUNT, alive: true }).sort((a, b) => (a.distance ?? 1e9) - (b.distance ?? 1e9))[0] ?? fail("no living runt in view");
    log(`kill ${kill}: runt ${runt.guid} at ${runt.distance?.toFixed(1)}y`);
    // Starter gear at level 20 against a level-7 runt is still a slow swing;
    // a timeout with both alive is resumed, anything else is a failure.
    let fight = await client.killTarget(runt.guid, { timeout: 60_000 });
    for (let round = 1; !fight.ok && fight.status === "timeout" && round < 3; round++) {
      log(`  still swinging after ${round * 60}s; resuming`);
      fight = await client.killTarget(runt.guid, { timeout: 60_000 });
    }
    if (!fight.ok) fail(`killTarget: ${fight.status}`);
    const loot = await client.lootCorpse(runt.guid, { timeout: 10_000 });
    log(`  loot: ${JSON.stringify({ status: loot.status, items: loot.items })}`);
    const bagBy = Date.now() + 5_000;
    while (carried() === undefined && Date.now() < bagBy) await Bun.sleep(100);
  }
  const tipBy = Date.now() + 10_000;
  while (client.state.items.get(CRYSTAL)?.value.startQuest !== QUEST && Date.now() < tipBy) await Bun.sleep(100);
  const crystal = carried()!;
  const tip = client.state.items.get(CRYSTAL)?.value ?? fail("no item query answer for the crystal");
  if (tip.startQuest !== QUEST) fail(`the crystal's tooltip says startQuest ${tip.startQuest}, expected ${QUEST}: ${JSON.stringify(tip)}`);
  if ((tip.spells ?? []).some((s) => s.spellId > 0)) fail(`the crystal carries a spell, this smoke needs a spell-less start item: ${JSON.stringify(tip.spells)}`);
  log(`PASS carried: ${crystal.name} (${crystal.guid}) at bag ${crystal.bag} slot ${crystal.slot}, startQuest ${tip.startQuest}, no spell`);

  // 2. Use it: the server offers the quest from the item.
  let used;
  try {
    used = await client.useItem("Faintly Glowing Crystal", undefined, undefined, { timeout: 15_000 });
  } catch (e) {
    if (e instanceof WrathRequestError && e.code === "item_not_usable") fail(`the live module refused use_item (build ${health.build ?? "?"} predates quest-start items): ${e.message}`);
    throw e;
  }
  if (!used.ok || used.questOffer === undefined) fail(`useItem carried no questOffer: ${JSON.stringify(used)}`);
  if (used.questOffer.questId !== QUEST || used.questOffer.itemGuid !== crystal.guid) fail(`wrong offer: ${JSON.stringify(used.questOffer)}`);
  if (!seen.includes("SMSG_QUESTGIVER_QUEST_DETAILS")) fail("no SMSG_QUESTGIVER_QUEST_DETAILS was observed");
  log(`PASS offer: ${JSON.stringify(used.questOffer)}`);

  // 3. Accept it with the item as the questgiver.
  const accepted = await client.acceptQuestFrom(used.questOffer.itemGuid, QUEST, { timeout: 15_000 });
  log(`acceptQuestFrom: ${JSON.stringify({ ok: accepted.ok, status: accepted.status })}`);
  if (!accepted.ok || accepted.status !== "accepted") fail(`quest ${QUEST} not accepted: ${JSON.stringify(accepted)}`);
  if (!client.state.questLog.some((q) => q.questId === QUEST)) fail("quest 9455 is not in state.questLog after the accept");
  if (seen.includes("SMSG_QUESTGIVER_QUEST_LIST")) fail("a quest list was asked for — an item is not asked with CMSG_QUESTGIVER_HELLO");
  log(`PASS accept: quest ${QUEST} "${accepted.title}" in the log`);
  console.log(`PASS: quest-item-start (${((Date.now() - started) / 1000).toFixed(1)}s)`);
} catch (e) {
  console.log(`FAIL: ${String(e instanceof Error ? (e.stack ?? e.message) : e)}`);
  process.exitCode = 1;
} finally {
  await session?.logout().catch(() => {});
  session?.close();
  await deleteFixtureCharacters(fixtureCtx, [CHARACTER]);
}
