/**
 * Probe for the item tooltip: the extended
 * `SMSG_ITEM_QUERY_SINGLE_RESPONSE` decode (stats, damage, armor, speed,
 * spells, bonding, durability, requirements) on `state.items`.
 *
 * It FAILS against any worldserver built before the change (the answers
 * carry no `damage`/`armor`). Run it only after the image is deployed.
 *
 * Arc: fresh Human Paladin -> login -> the starting gear's item queries
 * answer (the module asks on first sight, as a client cache miss) -> the
 * worn weapon has a damage range, a speed and a durability; the pants are
 * the one armored, durable piece (a fresh paladin wears a shirt, pants and
 * boots — no chest; item_template gives the shirt and Squire's Boots armor 0
 * and no durability, so those decode as 0 and that is the decode being
 * right); the answers parse (no decodeError) -> logout and delete.
 *
 * Run from inside the network:
 *   docker compose -f infra/compose.yml exec runner bun infra/smoke/item-stats.ts
 */

import { connect } from "../../sdk/src/index";
import { probeName } from "./lib/name";
import { authHeaders, MODULE_SECRET } from "./lib/auth";

const BASE = `http://${process.env.MODULE_HOST ?? "worldserver"}:${process.env.MODULE_PORT ?? "8086"}`;
const ACCOUNT = process.env.MODULE_ACCOUNT ?? "PROBE";
const TOKEN = `smoke-item-stats-${crypto.randomUUID()}`;
const CHARACTER = probeName("Bi");
const SLOT_LEGS = 6;
const CLASS_ARMOR = 4;
const SLOT_MAIN_HAND = 15;

const started = Date.now();
const log = (m: string) => console.log(`[items +${((Date.now() - started) / 1000).toFixed(1).padStart(5)}s] ${m}`);
function fail(m: string): never {
  throw new Error(m);
}

const health = await fetch(`${BASE}/health`, { headers: authHeaders() }).then((r) => r.json() as Promise<any>);
if (!health?.ok) fail(`health not ok: ${JSON.stringify(health)}`);
log(`health ok: build=${health.build ?? "?"}`);

const client = await connect({ baseUrl: BASE, token: TOKEN, secret: MODULE_SECRET });
const decodeErrors: number[] = [];
client.events.on("SMSG_ITEM_QUERY_SINGLE_RESPONSE", (e) => {
  if ((e.data as { decodeError?: boolean }).decodeError) decodeErrors.push(e.seq);
});
try {
  await client.createSession({ account: ACCOUNT, character: CHARACTER, race: 1, class: 2 });
  log(`in world as ${CHARACTER}`);
  const deadline = Date.now() + 15_000;
  const worn = () => client.state.inventory.filter((i) => i.slot < 19 && i.itemId !== undefined);
  while (worn().length < 3 || worn().some((i) => client.state.items.get(i.itemId!) === undefined)) {
    if (Date.now() > deadline) fail(`worn items or their queries did not arrive: ${JSON.stringify(worn())}`);
    await Bun.sleep(250);
  }
  if (decodeErrors.length > 0) fail(`item query decode errors at seq ${decodeErrors.join(",")} — the extended layout does not match the wire`);
  const infos = worn().map((i) => ({ slot: i.slot, info: client.state.items.get(i.itemId!)!.value }));
  log(`worn: ${JSON.stringify(infos.map((x) => [x.slot, x.info.name, x.info.armor, x.info.damage, x.info.speedMs, x.info.maxDurability]))}`);
  const weapon = infos.find((x) => x.slot === SLOT_MAIN_HAND) ?? fail("no main-hand item");
  if (!weapon.info.damage || weapon.info.damage.length === 0) fail(`main hand ${weapon.info.name} has no damage range`);
  if (!(weapon.info.damage[0]!.max >= weapon.info.damage[0]!.min && weapon.info.damage[0]!.min > 0)) fail(`bad damage ${JSON.stringify(weapon.info.damage)}`);
  if (!weapon.info.speedMs || weapon.info.speedMs < 1000) fail(`main hand speed ${weapon.info.speedMs}`);
  if (weapon.info.class !== 2) fail(`main hand class ${weapon.info.class}, expected 2 (weapon)`);
  const pants = infos.find((x) => x.slot === SLOT_LEGS) ?? fail("no legs item");
  if (pants.info.class !== CLASS_ARMOR) fail(`legs class ${pants.info.class}, expected 4 (armor)`);
  if (!pants.info.armor || pants.info.armor <= 0) fail(`legs ${pants.info.name} armor ${pants.info.armor}`);
  const noDur = [pants, weapon].filter((x) => x.info.maxDurability === undefined || x.info.maxDurability === 0);
  if (noDur.length > 0) fail(`durable piece(s) without maxDurability: ${JSON.stringify(noDur.map((x) => x.info.name))}`);
  if (infos.some((x) => x.info.bonding === undefined)) fail("bonding missing on a worn piece");
  console.log(`PASS: item-stats (${infos.length} worn pieces decoded, ${weapon.info.name} ${weapon.info.damage[0]!.min}-${weapon.info.damage[0]!.max} @ ${weapon.info.speedMs}ms, ${((Date.now() - started) / 1000).toFixed(1)}s)`);
} catch (e) {
  console.log(`FAIL: ${String(e instanceof Error ? (e.stack ?? e.message) : e)}`);
  process.exitCode = 1;
} finally {
  await client.logout().catch(() => {});
  await client.deleteCharacter(CHARACTER, { account: ACCOUNT }).catch((e) => log(`delete failed: ${String(e)}`));
  client.close();
}
