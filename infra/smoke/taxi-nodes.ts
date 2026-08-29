/**
 * Probe for the flight-master destination surface (FOLLOW-UPS 38 N3):
 * `SMSG_SHOWTAXINODES` tapped and folded (`state.lastTaxiNodes(guid)`),
 * `showTaxiNodes` opening the window through the master's gossip, and
 * `activateTaxi` flying one hop with the landing read off `taxiFlight`.
 *
 * It FAILS against any worldserver built before the tap (the window never
 * arrives). Run it only after the image is deployed: it is the gate for the
 * N3 build.
 *
 * Fixture (FOLLOW-UPS 45 pattern): a persistent character (default
 * `Smokeflight` on MODULE_ACCOUNT, never deleted) is placed by
 * `infra/fixtures/apply.ts --scenario taxi-ironforge` — level 10, 1g, in
 * front of Gryth Thurden in Ironforge with TaxiNodes 6 (Ironforge) and 8
 * (Thelsamar) visited, because the server only sells routes between visited
 * nodes (ERR_TAXINOTVISITED otherwise).
 *
 * Arc:
 *   1. login; Gryth (entry 1573) comes into view carrying the flightMaster
 *      role;
 *   2. showTaxiNodes(gryth) -> the window: showWindow true, current node 6
 *      named from TaxiNodes.dbc, known contains 6 and 7 (>= 1 destination);
 *   3. activateTaxi(gryth, "Thelsamar") -> accepted (reply 0); self flips
 *      taxiFlight true within 5s; the fare shows on state.money;
 *   4. the ride: taxiFlight flips back false (Ironforge -> Thelsamar is
 *      ~2 min); self.zone is then Loch Modan (38), not Ironforge (1537);
 *   5. logout. apply.ts resets the position next run.
 *
 * Run from inside the network (the runner service carries the DB env the
 * fixture tool needs; MODULE_ACCOUNT defaults to PROBE):
 *
 *   docker compose -f infra/compose.yml exec runner bun infra/smoke/taxi-nodes.ts
 */

import { connect } from "../../sdk/src/index";
import { applyScenario, ensureFixtureCharacter, type FixtureContext } from "./lib/fixture";

const BASE = `http://${process.env.MODULE_HOST ?? "worldserver"}:${process.env.MODULE_PORT ?? "8086"}`;
const ACCOUNT = process.env.MODULE_ACCOUNT ?? "PROBE";
const TOKEN = `smoke-taxi-nodes-${crypto.randomUUID()}`;
const CHARACTER = process.env.SMOKE_CHARACTER ?? "Smokeflight";
const SCENARIO = "taxi-ironforge";

const GRYTH_THURDEN = 1573; // creature entry, Ironforge flight master
const TAXI_IRONFORGE = 6;
const TAXI_THELSAMAR = 8;
const ZONE_IRONFORGE = 1537;
const ZONE_LOCH_MODAN = 38;

const started = Date.now();
const log = (m: string) => console.log(`[taxi +${((Date.now() - started) / 1000).toFixed(1).padStart(5)}s] ${m}`);
function fail(m: string): never {
  throw new Error(m);
}

const health = await fetch(`${BASE}/health`).then((r) => r.json() as Promise<any>);
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
    // Dwarf Warrior: the fixture stands in Ironforge, so a same-faction race.
    const c = await connect({ baseUrl: BASE, token: `${TOKEN}-create` });
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

const client = await connect({ baseUrl: BASE, token: TOKEN });
const waitTaxiFlight = async (want: boolean, timeoutMs: number, what: string) => {
  const deadline = Date.now() + timeoutMs;
  while (client.state.self.taxiFlight?.value !== want) {
    if (Date.now() > deadline) fail(`timed out waiting for ${what} (taxiFlight is ${JSON.stringify(client.state.self.taxiFlight)})`);
    await Bun.sleep(250);
  }
};

try {
  // 1. Login, the flight master in view.
  await client.createSession({ account: ACCOUNT, character: CHARACTER, race: 3, class: 1 });
  log(`in world as ${CHARACTER}, guid ${client.state.self.guid}`);
  await client.waitForNearby((o) => o.entry?.value === GRYTH_THURDEN && o.fields.get("npcFlags") !== undefined, { timeout: 15_000 });
  const gryth = client.state.units({ entry: GRYTH_THURDEN })[0] ?? fail("Gryth Thurden not in units() — did apply.ts place the character?");
  if (!gryth.roles.includes("flightMaster")) fail(`Gryth's roles ${JSON.stringify(gryth.roles)} lack flightMaster`);
  await waitTaxiFlight(false, 10_000, "self on the ground (taxiFlight false)");

  // 2. The window, through the master's gossip.
  const window = await client.showTaxiNodes(gryth, { timeout: 10_000 });
  log(`window: current ${window.current.nodeId} ${JSON.stringify(window.current.name)}, known ${JSON.stringify(window.known)}`);
  if (window.current.nodeId !== TAXI_IRONFORGE) fail(`current node ${window.current.nodeId}, expected ${TAXI_IRONFORGE}`);
  if (window.current.name === undefined || !/ironforge/i.test(window.current.name))
    fail(`current node is not named from TaxiNodes.dbc: ${JSON.stringify(window.current)} (did the module log "loaded N taxi nodes"?)`);
  if (window.known.length < 1) fail("the window offers no known node");
  if (!window.known.some((n) => n.nodeId === TAXI_THELSAMAR)) fail(`the fixture's node ${TAXI_THELSAMAR} is not known: ${JSON.stringify(window.known)}`);
  if (window.mask.length !== 14) fail(`mask has ${window.mask.length} words, expected 14`);
  if (client.state.lastTaxiNodes(gryth.guid)?.seq !== window.seq) fail("state.lastTaxiNodes(guid) does not hold the window");
  log(`PASS window: ${window.known.length} known node(s), current ${window.current.name}`);

  // 3. One hop, by name.
  const moneyBefore = client.state.money?.value;
  const result = await client.activateTaxi(gryth, "Thelsamar", { timeout: 10_000 });
  log(`activateTaxi: ${JSON.stringify(result)}`);
  if (!result.ok) fail(`flight refused: reply ${result.reply} — ${result.hint}`);
  if (result.to.nodeId !== TAXI_THELSAMAR) fail(`resolved destination ${result.to.nodeId}, expected ${TAXI_THELSAMAR}`);
  await waitTaxiFlight(true, 5_000, "taxiFlight true after an accepted flight");
  log(`PASS takeoff: taxiFlight true; money ${moneyBefore} -> ${client.state.money?.value}`);

  // 4. The landing is the flag flipping back; the zone is the proof of where.
  await waitTaxiFlight(false, 5 * 60_000, "the landing (taxiFlight false)");
  await Bun.sleep(1500); // let the WB_AREA for the landing zone land
  const zone = client.state.self.zone?.value;
  if (zone?.id === ZONE_IRONFORGE) fail(`landed but self.zone is still Ironforge: ${JSON.stringify(zone)}`);
  if (zone?.id !== ZONE_LOCH_MODAN) fail(`landed in zone ${JSON.stringify(zone)}, expected ${ZONE_LOCH_MODAN} (Loch Modan)`);
  log(`PASS landing: ${zone.name} at ${JSON.stringify(client.state.self.position?.value)}`);

  console.log(`PASS: taxi-nodes (${((Date.now() - started) / 1000).toFixed(1)}s)`);
} catch (e) {
  console.log(`FAIL: ${String(e instanceof Error ? (e.stack ?? e.message) : e)}`);
  process.exitCode = 1;
} finally {
  await client.logout().catch(() => {});
  client.close();
}
