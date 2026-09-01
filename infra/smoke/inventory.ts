/**
 * Probe for the one-bag inventory view (item 50): `state.bag()` spans
 * the backpack and every worn bag, and equipment is readable off
 * `state.inventory` by slot.
 *
 * End to end against a booted worldserver, from inside the compose network:
 * a fresh Human Warrior in Northshire -> the login create blocks arrive ->
 *   1. `bag().totalSlots` is 16 (no worn bags) and `bags` is empty;
 *   2. `freeSlots` is `16 - items.length`, every item is addressed as the
 *      backpack (bag 255, slot 23-38), and the starter Hearthstone is named;
 *   3. the equipped rows (`inventory` with slot < 19) name the starter weapon
 *      (main hand, slot 15) — a "Worn …" item for every starting class;
 * -> logout.
 *
 * What this cannot prove: the worn-bag branch. A level-1 character owns no
 * bag, a fixture cannot write one (item 57: item guids are not safe to write
 * from outside), and `Smoketram` — the gate's persistent fixture character —
 * was created without one for the same reason. That branch (container
 * `numSlots` + `bagSlot<n>Lo/Hi` folded into `bag()`, addressed by the bag's
 * equip slot 19-22) is covered by the sdk unit test on a fixture update block
 * (sdk/test/state.test.ts, "bag() spans a worn bag"). Nothing further is
 * opened: the first trajectory that buys a bag is the live check.
 *
 * Preflight-gate ready: reads MODULE_ACCOUNT the way the
 * supervisor's spawnSmoke injects it, deletes last run's character through the
 * real CMSG_CHAR_DELETE path before creating this run's, and only logs out at
 * the end. Budget: ~15s.
 *
 * Run standalone (defaults to the PROBE account):
 *   docker compose -f infra/compose.yml exec runner bun infra/smoke/inventory.ts
 */

import { connect } from "../../sdk/src/index";
import { authHeaders, MODULE_SECRET } from "./lib/auth";

const BASE = `http://${process.env.MODULE_HOST ?? "worldserver"}:${process.env.MODULE_PORT ?? "8086"}`;
const ACCOUNT = process.env.MODULE_ACCOUNT ?? "PROBE";
const TOKEN = `smoke-inventory-${crypto.randomUUID()}`;
const CHARACTER = "Smokebag";

const BACKPACK = 255;
const BACKPACK_SIZE = 16;
const MAIN_HAND_SLOT = 15;

const started = Date.now();
const log = (m: string) =>
  console.log(`[inventory +${((Date.now() - started) / 1000).toFixed(1).padStart(5)}s] ${m}`);
function fail(m: string): never {
  throw new Error(m);
}

async function deletePreviousCharacter(): Promise<void> {
  for (let attempt = 0; attempt < 4; ++attempt) {
    const res = await fetch(`${BASE}/character-delete`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify({ token: `${TOKEN}-del${attempt}`, account: ACCOUNT, character: CHARACTER }),
    });
    const json: any = await res.json().catch(() => undefined);
    if (json?.deleted === true) return log(`deleted last run's ${CHARACTER}`);
    if (res.status === 502 && json?.error === "character_not_found") return log(`no previous ${CHARACTER}`);
    log(`character-delete attempt ${attempt}: ${res.status} ${JSON.stringify(json)}`);
    if (res.status !== 504) break;
    await Bun.sleep(2000);
  }
  fail(`could not delete last run's ${CHARACTER}`);
}

const health = await fetch(`${BASE}/health`, { headers: authHeaders() }).then((r) => r.json() as Promise<any>);
if (!health?.ok) fail(`health not ok: ${JSON.stringify(health)}`);
log(`health ok: build=${health.build ?? "?"}, character=${CHARACTER}`);
await deletePreviousCharacter();

const client = await connect({ baseUrl: BASE, token: TOKEN, secret: MODULE_SECRET });

try {
  await client.createSession({ account: ACCOUNT, character: CHARACTER, race: 1, class: 1 });
  log(`in world as ${CHARACTER} (Human Warrior), guid ${client.state.self.guid}`);

  // The three-way join settles once the item query answers have landed: wait
  // for every carried row to carry a name rather than reading the first block.
  const deadline = Date.now() + 10_000;
  for (;;) {
    const b = client.state.bag();
    const named = b.items.length > 0 && b.items.every((i) => i.name !== undefined);
    const weaponNamed = client.state.inventory.some((i) => i.slot === MAIN_HAND_SLOT && i.name !== undefined);
    if (named && weaponNamed) break;
    if (Date.now() > deadline) fail(`inventory never fully joined: ${JSON.stringify({ bag: b, inventory: client.state.inventory })}`);
    await Bun.sleep(100);
  }

  // 1. No worn bags: 16 slots total.
  const bag = client.state.bag();
  if (bag.totalSlots !== BACKPACK_SIZE) fail(`totalSlots ${bag.totalSlots}, expected ${BACKPACK_SIZE}`);
  if (bag.bags.length !== 0) fail(`a fresh character wears no bag, got ${JSON.stringify(bag.bags)}`);
  log(`PASS totalSlots ${bag.totalSlots}, no worn bags`);

  // 2. Free slots and addressing.
  if (bag.freeSlots !== BACKPACK_SIZE - bag.items.length) {
    fail(`freeSlots ${bag.freeSlots} with ${bag.items.length} items, expected ${BACKPACK_SIZE - bag.items.length}`);
  }
  for (const i of bag.items) {
    if (i.bag !== BACKPACK || i.slot < 23 || i.slot > 38) fail(`carried row not addressed as backpack: ${JSON.stringify(i)}`);
  }
  if (!bag.items.some((i) => i.name === "Hearthstone")) fail(`no Hearthstone among ${JSON.stringify(bag.items.map((i) => i.name))}`);
  log(`PASS carrying ${bag.items.map((i) => (i.count && i.count > 1 ? `${i.name} x${i.count}` : i.name)).join(", ")} (${bag.freeSlots} free)`);

  // 3. Equipment off `inventory`: the starter weapon in the main hand.
  const equipped = client.state.inventory.filter((i) => i.slot < 19);
  const weapon = equipped.find((i) => i.slot === MAIN_HAND_SLOT);
  if (weapon?.name === undefined || !/^Worn /.test(weapon.name)) {
    fail(`main hand is ${JSON.stringify(weapon)}, expected a "Worn …" starter weapon`);
  }
  if (bag.items.some((i) => i.guid === weapon.guid)) fail(`the equipped weapon also appears in bag()`);
  log(`PASS equipped: ${equipped.map((i) => i.name ?? `slot ${i.slot}`).join(", ")}`);

  console.log(`PASS: inventory (${((Date.now() - started) / 1000).toFixed(1)}s)`);
} catch (e) {
  console.log(`FAIL: ${String(e instanceof Error ? (e.stack ?? e.message) : e)}`);
  process.exitCode = 1;
} finally {
  await client.logout().catch(() => {});
  client.close();
}
