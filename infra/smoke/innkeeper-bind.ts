/**
 * Probe for the innkeeper bind: `SMSG_BINDPOINTUPDATE`
 * tapped and folded (`state.self.bindPoint`), `SMSG_BINDER_CONFIRM` answered
 * with `CMSG_BINDER_ACTIVATE` through `bindAtInnkeeper`, the way a client's
 * confirm dialog does it.
 *
 * It FAILS against any worldserver built before the tap (no bind point at
 * login). Run it only after the image is deployed: it is the gate for the N2
 * build.
 *
 * Fixture: a persistent character (default `Smokeinn` on MODULE_ACCOUNT,
 * never deleted) is placed by `infra/fixtures/apply.ts --scenario
 * inn-ironforge` — level 10 in front of Innkeeper Firebrew in Ironforge's
 * Commons, hearthstone bound to Coldridge Valley (the dwarf start), so the
 * bind is a visible change.
 *
 * Arc:
 *   1. login -> SMSG_BINDPOINTUPDATE names the planted bind (map 0, area 132
 *      Coldridge Valley, named from AreaTable.dbc);
 *   2. Firebrew (entry 5111) in view carrying the innkeeper role;
 *   3. bindAtInnkeeper(firebrew) -> bound: map 0, within 10y of the
 *      character, area no longer the planted one, named; state.self.bindPoint
 *      agrees;
 *   4. logout. apply.ts re-plants the old homebind next run.
 *
 *   docker compose -f infra/compose.yml exec runner bun infra/smoke/innkeeper-bind.ts
 */

import { connect } from "../../sdk/src/index";
import { applyScenario, ensureFixtureCharacter, type FixtureContext } from "./lib/fixture";
import { authHeaders, MODULE_SECRET } from "./lib/auth";

const BASE = `http://${process.env.MODULE_HOST ?? "worldserver"}:${process.env.MODULE_PORT ?? "8086"}`;
const ACCOUNT = process.env.MODULE_ACCOUNT ?? "PROBE";
const TOKEN = `smoke-innkeeper-bind-${crypto.randomUUID()}`;
const CHARACTER = process.env.SMOKE_CHARACTER ?? "Smokeinn";
const SCENARIO = "inn-ironforge";

const FIREBREW = 5111; // creature entry, Innkeeper Firebrew
const AREA_COLDRIDGE_VALLEY = 132; // the planted homebind's area (zone 1 Dun Morogh)

const started = Date.now();
const log = (m: string) => console.log(`[inn +${((Date.now() - started) / 1000).toFixed(1).padStart(5)}s] ${m}`);
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
const binds: unknown[] = [];
client.events.on("SMSG_BINDPOINTUPDATE", (e) => {
  binds.push(e.data);
  log(`SMSG_BINDPOINTUPDATE ${JSON.stringify(e.data)}`);
});

try {
  // 1. Login carries the planted bind.
  await client.createSession({ account: ACCOUNT, character: CHARACTER, race: 3, class: 1 });
  log(`in world as ${CHARACTER}, guid ${client.state.self.guid}`);
  const deadline = Date.now() + 10_000;
  while (client.state.self.bindPoint === undefined) {
    if (Date.now() > deadline) fail("no SMSG_BINDPOINTUPDATE at login (is the tap deployed?)");
    await Bun.sleep(100);
  }
  const before = client.state.self.bindPoint.value;
  if (before.map !== 0 || before.area.id !== AREA_COLDRIDGE_VALLEY)
    fail(`login bind point is ${JSON.stringify(before)}, expected map 0 area ${AREA_COLDRIDGE_VALLEY} (the fixture's homebind)`);
  if (!before.area.name) fail(`login bind point carries no area name: ${JSON.stringify(before)} (AreaTable.dbc loaded?)`);
  log(`PASS login: home is ${before.area.name} (${before.area.id}) at (${before.x}, ${before.y}, ${before.z})`);

  // 2. The innkeeper in view.
  await client.waitForNearby((o) => o.entry?.value === FIREBREW && o.fields.get("npcFlags") !== undefined, { timeout: 15_000 });
  const firebrew = client.state.units({ entry: FIREBREW })[0] ?? fail("Innkeeper Firebrew not in units() — did apply.ts place the character?");
  if (!firebrew.roles.includes("innkeeper")) fail(`Firebrew's roles ${JSON.stringify(firebrew.roles)} lack innkeeper`);

  // 3. Bind, as a client does: gossip, the home option, confirm.
  const result = await client.bindAtInnkeeper(firebrew, { timeout: 10_000 });
  log(`bindAtInnkeeper: ${JSON.stringify(result)}`);
  const me = client.state.self.position?.value ?? fail("no self position");
  const d = Math.hypot(result.bindPoint.x - me.x, result.bindPoint.y - me.y);
  if (result.bindPoint.map !== 0 || d > 10) fail(`bind point ${JSON.stringify(result.bindPoint)} is ${d.toFixed(1)}y from the character on map ${me.map}`);
  if (result.bindPoint.area.id === AREA_COLDRIDGE_VALLEY) fail("the bind point did not change from the planted one");
  if (!result.bindPoint.area.name) fail(`new bind point carries no area name: ${JSON.stringify(result.bindPoint)}`);
  const after = client.state.self.bindPoint?.value;
  if (JSON.stringify(after) !== JSON.stringify(result.bindPoint)) fail(`state.self.bindPoint ${JSON.stringify(after)} disagrees with the result`);
  if (binds.length < 2) fail(`expected the login and the bind SMSG_BINDPOINTUPDATE, saw ${binds.length}`);
  log(`PASS bind: home is now ${result.bindPoint.area.name} (${result.bindPoint.area.id}), ${d.toFixed(1)}y from the character`);

  console.log(`PASS: innkeeper-bind (${((Date.now() - started) / 1000).toFixed(1)}s)`);
} catch (e) {
  console.log(`FAIL: ${String(e instanceof Error ? (e.stack ?? e.message) : e)}`);
  process.exitCode = 1;
} finally {
  await client.logout().catch(() => {});
  client.close();
}
