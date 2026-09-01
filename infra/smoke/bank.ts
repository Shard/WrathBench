/**
 * Probe for the bank surface (item 100, bank): the bank frame
 * (`openBank` -> `SMSG_SHOW_BANK`), a deposit landing in a bank slot
 * (`PLAYER_FIELD_BANK_SLOT_1` served as `invSlot39-66`, read by
 * `state.bank()`), and the withdrawal landing back in the backpack.
 *
 * It FAILS against any worldserver built before the change (no bank slots
 * served, SMSG_SHOW_BANK dropped). Run it only after the image is deployed:
 * one of the gates for the item 100 build.
 *
 * Throwaway Human Warrior placed by `bank-ironforge` (in front of Bailey
 * Stonemantle). A fresh character carries its starting food and water, which
 * is what gets banked.
 *
 * Run from inside the network:
 *   docker compose -f infra/compose.yml exec runner bun infra/smoke/bank.ts
 */

import { connect, type WrathClient } from "../../sdk/src/index";
import { applyScenario, deleteFixtureCharacters, ensureFixtureCharacter, type FixtureContext } from "./lib/fixture";
import { probeName } from "./lib/name";
import { authHeaders, MODULE_SECRET } from "./lib/auth";

const BASE = `http://${process.env.MODULE_HOST ?? "worldserver"}:${process.env.MODULE_PORT ?? "8086"}`;
const ACCOUNT = process.env.MODULE_ACCOUNT ?? "PROBE";
const TOKEN = `smoke-bank-${crypto.randomUUID()}`;
const CHARACTER = probeName("Bb");
const SCENARIO = "bank-ironforge";
const BAILEY = 2461;

const started = Date.now();
const log = (m: string) => console.log(`[bank +${((Date.now() - started) / 1000).toFixed(1).padStart(5)}s] ${m}`);
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
  await client.createSession({ account: ACCOUNT, character: CHARACTER, race: 1, class: 1 });
  log(`in world as ${CHARACTER}`);
  await client.waitForNearby((o) => o.entry?.value === BAILEY && o.fields.get("npcFlags") !== undefined, { timeout: 15_000 });
  await Bun.sleep(1500); // the backpack items' create blocks and queries
  const bailey = client.state.units({ entry: BAILEY })[0] ?? fail("Bailey Stonemantle not in view — did apply.ts place the character?");
  if (!bailey.roles.includes("banker")) fail(`Bailey's roles ${JSON.stringify(bailey.roles)} lack banker`);
  const carried = client.state.bag().items;
  log(`carrying: ${JSON.stringify(carried.map((i) => [i.bag, i.slot, i.name, i.count]))}`);
  const item = carried[0] ?? fail("the backpack is empty; a fresh character should carry its starting food and water");
  if (client.state.bank().items.length !== 0) fail(`the bank already holds ${client.state.bank().items.length} item(s) on a fresh character`);

  // 1. The frame.
  const bank = await client.openBank(bailey, { timeout: 10_000 });
  if (bank.guid !== bailey.guid) fail(`bank frame guid ${bank.guid}, expected ${bailey.guid}`);
  log(`PASS open: bank frame at ${bailey.name}, ${bank.totalSlots} slots, ${bank.freeSlots} free`);

  // 2. Deposit, read the bank slot, withdraw.
  const deposit = await client.bankDeposit(item.bag, item.slot, { timeout: 10_000 });
  log(`bankDeposit: ${JSON.stringify(deposit)}`);
  if (!deposit.ok) fail(`deposit refused: ${deposit.hint}`);
  if (deposit.bag !== 255 || deposit.slot < 39 || deposit.slot > 66) fail(`deposit landed at bag ${deposit.bag} slot ${deposit.slot}, expected a main bank slot 39-66`);
  const banked = client.state.bank().items.find((i) => i.guid === item.guid) ?? fail("state.bank() does not list the deposited item");
  if (banked.name !== item.name) fail(`banked item named ${JSON.stringify(banked.name)}, expected ${JSON.stringify(item.name)}`);
  if (client.state.bag().items.some((i) => i.guid === item.guid)) fail("state.bag() still lists the deposited item");
  log(`PASS deposit: ${banked.name} at bank slot ${banked.slot}`);
  const withdraw = await client.bankWithdraw(banked.bag, banked.slot, { timeout: 10_000 });
  log(`bankWithdraw: ${JSON.stringify(withdraw)}`);
  if (!withdraw.ok) fail(`withdraw refused: ${withdraw.hint}`);
  if (withdraw.bag !== 255 || withdraw.slot < 23 || withdraw.slot > 38) fail(`withdrawal landed at bag ${withdraw.bag} slot ${withdraw.slot}, expected the backpack`);
  if (client.state.bank().items.length !== 0) fail("state.bank() still lists the withdrawn item");
  log("PASS withdraw: back in the backpack, bank empty");
  console.log(`PASS: bank (${((Date.now() - started) / 1000).toFixed(1)}s)`);
} catch (e) {
  console.log(`FAIL: ${String(e instanceof Error ? (e.stack ?? e.message) : e)}`);
  process.exitCode = 1;
} finally {
  await session?.logout().catch(() => {});
  session?.close();
  await deleteFixtureCharacters(fixtureCtx, [CHARACTER]);
}
