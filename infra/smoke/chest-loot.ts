/**
 * Gate for chest loot through the SDK: `lootCorpse(chest)` opens a chest-type
 * game object the way a client does and empties it.
 *
 * Why this exists: two runs (opus-low a11/a12, sonnet-low a2, Coldridge
 * Valley, 2026-08-29) called `interact(guid)` on a chest, got the ack, and
 * then `lootCorpse(guid)` timed out. The core ignores `CMSG_GAMEOBJ_USE` on a
 * chest (`GameObject::Use` has no chest case) and drops `CMSG_LOOT` on any
 * game object guid (`HandleLootOpcode`: `!guid.IsCreatureOrVehicle()` returns
 * silently). A client opens a chest by casting the lock's Opening spell at it
 * (`SPELL_EFFECT_OPEN_LOCK`, ~1s), and the server answers the cast with the
 * loot window. The SDK now does that; this smoke proves it against the live
 * server.
 *
 * Fixture: a persistent character (default `Smokechest` on PROBE, never
 * deleted) is placed by `infra/fixtures/apply.ts --scenario felix-bucket` —
 * level 5 in front of Felix's Bucket of Bolts (template 178085, lock 43 =
 * "Open Kneeling", one loot row: the quest item 16314) with A Refugee's
 * Quandary (3361) in the log, which is what makes the chest show its item.
 *
 * Arc:
 *   1. login; the bucket in view as goType "chest" within reach;
 *   2. interact(bucket) is refused with { status: "chest" } and a hint
 *      naming lootCorpse (the opcode would be dropped);
 *   3. lootCorpse(bucket): SMSG_SPELL_START(6478) -> SMSG_LOOT_RESPONSE ->
 *      { status: "looted", items: [{ 16314, 1 }] }, the item in the bag;
 *   4. destroy the quest item so the next run's chest has it to show (and,
 *      at login, destroy one a failed run left behind: the chest only shows
 *      16314 to a character who still needs it, so a leftover makes the
 *      window come back empty — which is what happened on 2026-08-30);
 *   5. logout.
 *
 *   docker compose -f infra/compose.yml exec runner bun infra/smoke/chest-loot.ts
 */

import { connect } from "../../sdk/src/index";
import { applyScenario, ensureFixtureCharacter, type FixtureContext } from "./lib/fixture";
import { authHeaders, MODULE_SECRET } from "./lib/auth";

const BASE = `http://${process.env.MODULE_HOST ?? "worldserver"}:${process.env.MODULE_PORT ?? "8086"}`;
const ACCOUNT = process.env.MODULE_ACCOUNT ?? "PROBE";
const TOKEN = `smoke-chest-loot-${crypto.randomUUID()}`;
const CHARACTER = process.env.SMOKE_CHARACTER ?? "Smokechest";
const SCENARIO = "felix-bucket";

const BUCKET = 178085; // gameobject_template entry, Felix's Bucket of Bolts
const BOLTS = 16314; // item_template entry, the quest item inside
const OPEN_KNEELING = 6478; // the Opening spell for lock type 13, the bucket's

const started = Date.now();
const log = (m: string) => console.log(`[chest +${((Date.now() - started) / 1000).toFixed(1).padStart(5)}s] ${m}`);
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
      await c.createSession({ account: ACCOUNT, character: CHARACTER, race: 3, class: 1 });
      await c.logout();
    } finally {
      c.close();
    }
  },
};
await ensureFixtureCharacter(fixtureCtx);
await applyScenario(fixtureCtx, SCENARIO);

const client = await connect({ baseUrl: BASE, token: TOKEN, secret: MODULE_SECRET });
const seen: string[] = [];
client.events.onAny((e) => {
  if (["SMSG_SPELL_START", "SMSG_SPELL_GO", "SMSG_CAST_FAILED", "SMSG_LOOT_RESPONSE", "SMSG_LOOT_RELEASE_RESPONSE", "SMSG_ITEM_PUSH_RESULT"].includes(e.opcode)) {
    seen.push(e.opcode);
    log(`  ${e.opcode} ${JSON.stringify(e.data)}`);
  }
});

try {
  // 1. The bucket in view, as a chest, within reach.
  await client.createSession({ account: ACCOUNT, character: CHARACTER, race: 3, class: 1 });
  log(`in world as ${CHARACTER}, guid ${client.state.self.guid}`);
  await client.waitForNearby((o) => o.entry?.value === BUCKET && o.fields.has("goType"), { timeout: 15_000 });
  const bucket = client.state.units({ type: "gameObject" }).find((u) => u.entry === BUCKET) ?? fail("the bucket is not in units()");
  if (bucket.goType !== "chest") fail(`the bucket's goType is ${bucket.goType}, expected chest`);
  if (bucket.distance === undefined || bucket.distance > 5) fail(`the bucket is ${bucket.distance}y away — did apply.ts place the character?`);
  if (!client.state.questLog.some((q) => q.questId === 3361)) fail("A Refugee's Quandary (3361) is not in the log — the fixture did not plant it");
  await Bun.sleep(1000); // the bag fold (inventory fields + item queries) lands with the first updates
  const leftover = client.state.bag().items.find((i) => i.itemId === BOLTS);
  if (leftover !== undefined) {
    log(`a previous run left ${BOLTS} x${leftover.count} in the bag; destroying it so the chest has it to show`);
    await client.destroyItem(leftover.bag, leftover.slot);
    const goneBy = Date.now() + 5_000;
    while (client.state.bag().items.some((i) => i.itemId === BOLTS) && Date.now() < goneBy) await Bun.sleep(100);
    if (client.state.bag().items.some((i) => i.itemId === BOLTS)) fail(`item ${BOLTS} is still in the bag after destroyItem`);
  }
  log(`PASS bucket: ${bucket.guid} goType=${bucket.goType} at ${bucket.distance.toFixed(1)}y, quest 3361 in the log`);

  // 2. interact() refuses a chest and says what to do instead.
  const use = await client.interact(bucket.guid);
  if (use.ok || use.status !== "chest") fail(`interact(bucket) answered ${JSON.stringify(use)}, expected { status: "chest" }`);
  log(`PASS interact: refused — ${use.hint}`);

  // 3. lootCorpse() casts, waits for the window, empties it.
  const loot = await client.lootCorpse(bucket.guid, { timeout: 10_000 });
  log(`lootCorpse: ${JSON.stringify(loot)}`);
  if (!loot.ok) fail(`lootCorpse(bucket) is ${loot.status}`);
  if (!loot.items.some((i) => i.itemId === BOLTS)) fail(`looted ${JSON.stringify(loot.items)}, expected item ${BOLTS}`);
  if (!seen.includes("SMSG_SPELL_START")) fail(`no SMSG_SPELL_START was observed: the window came from something other than the Opening cast`);
  if (!seen.includes("SMSG_LOOT_RESPONSE") || !seen.includes("SMSG_LOOT_RELEASE_RESPONSE")) fail(`window/release not both observed: ${seen.join(",")}`);
  // The push and the bag's inventory-field update are separate packets; poll for the fold.
  const bagBy = Date.now() + 5_000;
  while (!client.state.bag().items.some((i) => i.itemId === BOLTS) && Date.now() < bagBy) await Bun.sleep(100);
  const inBag = client.state.bag().items.find((i) => i.itemId === BOLTS) ?? fail(`item ${BOLTS} is not in state.bag() 5s after the loot`);
  log(`PASS loot: ${JSON.stringify(loot.items)} via Opening ${OPEN_KNEELING}; bag holds ${BOLTS} x${inBag.count}`);

  // 4. Put the world back: the quest item is what the chest shows next run.
  await client.destroyItem(inBag.bag, inBag.slot);
  const goneBy = Date.now() + 5_000;
  while (client.state.bag().items.some((i) => i.itemId === BOLTS) && Date.now() < goneBy) await Bun.sleep(100);
  if (client.state.bag().items.some((i) => i.itemId === BOLTS)) fail(`item ${BOLTS} is still in the bag after destroyItem — the next run's chest would be empty`);
  log(`destroyed the quest item; bag now ${JSON.stringify(client.state.bag().items.map((i) => i.itemId))}`);

  console.log(`PASS: chest-loot (${((Date.now() - started) / 1000).toFixed(1)}s)`);
} catch (e) {
  console.log(`FAIL: ${String(e instanceof Error ? (e.stack ?? e.message) : e)}`);
  process.exitCode = 1;
} finally {
  await client.logout().catch(() => {});
  client.close();
}
