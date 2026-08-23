/**
 * Probe for the two field-level observations of FOLLOW-UPS item 38 N2:
 * zone/subzone names on self (`WB_AREA`, `state.self.zone` / `state.self.area`)
 * and NPC roles from `UNIT_NPC_FLAGS` (`state.units(...).roles`).
 *
 * End to end against a booted worldserver, from inside the compose network:
 * a fresh Human in Northshire -> login announces Elwynn Forest / Northshire
 * Valley (ids 12 / 9) -> Deputy Willem in view carries `questGiver` in his
 * roles and answers `units({ role: "questGiver" })` -> a walk into the abbey
 * hall (Marshal McBride's spot; the abbey is WMO 59, whose WMOAreaTable rows
 * all name area 24 "Northshire Abbey") produces exactly one `WB_AREA`, with
 * the zone unchanged and the subzone now Northshire Abbey -> the walk back
 * out produces exactly one more, back to Northshire Valley -> logout.
 *
 * The expected ids were read from the data volume before the first run, not
 * guessed: the human spawn and its surroundings are area 9 in `0004832.map`'s
 * area grid (every ADT chunk within 120y; area 12, the zone itself with no
 * subzone, starts ~120y west up the valley wall), and area 24 is only ever a
 * WMO area (`WMOAreaTable.dbc`, WMO id 59 with a groupId -1 default row), so
 * it is reached by walking indoors, not across a chunk edge. If the first
 * deployed run disagrees, the server's answer wins and this file is corrected
 * — the names here are the client's `AreaTable.dbc` text for those ids.
 *
 * Preflight-gate ready (ADR-0023 amendment): reads MODULE_ACCOUNT the way the
 * supervisor's spawnSmoke injects it, deletes last run's character through the
 * real CMSG_CHAR_DELETE path before creating this run's, and only logs out at
 * the end (a disconnected character lingers 60s in the core's expireTime,
 * during which a delete is silently ignored). Budget: ~20s.
 *
 * Run standalone (defaults to the PROBE account):
 *   docker compose -f infra/compose.yml exec runner bun infra/smoke/area-and-roles.ts
 *
 * Override the target with MODULE_HOST / MODULE_PORT (default worldserver:8086)
 * and the login account with MODULE_ACCOUNT (default PROBE).
 */

import { connect } from "../../sdk/src/index";

const BASE = `http://${process.env.MODULE_HOST ?? "worldserver"}:${process.env.MODULE_PORT ?? "8086"}`;
const ACCOUNT = process.env.MODULE_ACCOUNT ?? "PROBE";
// Session tokens must be at least 32 characters (POST /session rejects
// shorter ones with weak_token); randomUUID keeps them unguessable too.
const TOKEN = `smoke-area-${crypto.randomUUID()}`;
// Fixed name, deleted at the START of every run and only logged out at the
// end. One name per script, so the leftover is always exactly one.
const CHARACTER = "Smokearea";

const WILLEM = 823; // Deputy Willem, npcflag 3 (gossip | questgiver), at the spawn
const HOME = { x: -8949.95, y: -132.49, z: 83.53 }; // human spawn
const ABBEY_HALL = { x: -8902.6, y: -162.6, z: 82.0 }; // Marshal McBride's spot, inside WMO 59

const EXPECT = {
  zone: { id: 12, name: "Elwynn Forest" },
  outside: { id: 9, name: "Northshire Valley" },
  inside: { id: 24, name: "Northshire Abbey" },
};

const started = Date.now();
const log = (m: string) =>
  console.log(`[area +${((Date.now() - started) / 1000).toFixed(1).padStart(5)}s] ${m}`);
function fail(m: string): never {
  throw new Error(m);
}

async function deletePreviousCharacter(): Promise<void> {
  for (let attempt = 0; attempt < 4; ++attempt) {
    const res = await fetch(`${BASE}/character-delete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
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

const health = await fetch(`${BASE}/health`).then((r) => r.json() as Promise<any>);
if (!health?.ok) fail(`health not ok: ${JSON.stringify(health)}`);
log(`health ok: build=${health.build ?? "?"}, character=${CHARACTER}`);
await deletePreviousCharacter();

const client = await connect({ baseUrl: BASE, token: TOKEN });
const areas: { mapId: number; zoneId: number; zoneName: string; areaId: number; areaName: string }[] = [];
client.events.on("WB_AREA", (e) => {
  areas.push(e.data as (typeof areas)[number]);
  log(`WB_AREA ${JSON.stringify(e.data)}`);
});

// A function, not `areas.length` inline: TypeScript narrows the literal
// length after an `!== n` guard and then flags the next guard as impossible.
const seen = () => areas.length;
const waitForAreas = async (n: number, what: string, timeoutMs: number) => {
  const deadline = Date.now() + timeoutMs;
  while (areas.length < n) {
    if (Date.now() > deadline) fail(`timed out waiting for ${what} (have ${areas.length} WB_AREA)`);
    await Bun.sleep(100);
  }
};
const expectArea = (
  got: (typeof areas)[number],
  zone: { id: number; name: string },
  area: { id: number; name: string },
  what: string,
) => {
  if (got.mapId !== 0) fail(`${what}: map ${got.mapId}, expected 0`);
  if (got.zoneId !== zone.id || got.zoneName !== zone.name) {
    fail(`${what}: zone ${got.zoneId} "${got.zoneName}", expected ${zone.id} "${zone.name}"`);
  }
  if (got.areaId !== area.id || got.areaName !== area.name) {
    fail(`${what}: area ${got.areaId} "${got.areaName}", expected ${area.id} "${area.name}"`);
  }
};

try {
  // 1. Login announces where the character is.
  await client.createSession({ account: ACCOUNT, character: CHARACTER, race: 1, class: 1 });
  log(`in world as ${CHARACTER} (Human Warrior), guid ${client.state.self.guid}`);
  await waitForAreas(1, "the login WB_AREA", 5000);
  expectArea(areas[0]!, EXPECT.zone, EXPECT.outside, "login");
  const zone = client.state.self.zone?.value;
  const area = client.state.self.area?.value;
  if (zone?.name !== EXPECT.zone.name || zone.id !== EXPECT.zone.id) fail(`state.self.zone is ${JSON.stringify(zone)}`);
  if (area?.name !== EXPECT.outside.name || area.id !== EXPECT.outside.id) fail(`state.self.area is ${JSON.stringify(area)}`);
  log(`PASS login: ${zone.name} / ${area.name} (${zone.id} / ${area.id}) on self`);

  // 2. Roles: the questgiver at the spawn.
  await client.waitForNearby((o) => o.entry?.value === WILLEM && o.fields.get("npcFlags") !== undefined, {
    timeout: 15_000,
  });
  const willem = client.state.units({ entry: WILLEM })[0] ?? fail("Deputy Willem not in units()");
  if (!willem.roles.includes("questGiver")) fail(`Deputy Willem roles ${JSON.stringify(willem.roles)} lack questGiver`);
  if (!willem.roles.includes("gossip")) fail(`Deputy Willem roles ${JSON.stringify(willem.roles)} lack gossip`);
  const byRole = client.state.units({ role: "questGiver" }).map((u) => u.guid);
  if (!byRole.includes(willem.guid)) fail(`units({ role: "questGiver" }) = ${JSON.stringify(byRole)} omits Willem`);
  const fm = client.state.units({ role: "flightMaster" });
  if (fm.length !== 0) fail(`no flight master stands in Northshire, yet units({ role: "flightMaster" }) returned ${fm.length}`);
  log(`PASS roles: Deputy Willem ${JSON.stringify(willem.roles)}; units({ role: "questGiver" }) finds him`);

  // 3. Into the abbey hall: one WB_AREA, zone unchanged, subzone Northshire Abbey.
  const inward = await client.moveTo(ABBEY_HALL, { timeout: 30_000 });
  if (!inward.ok) fail(`walk into the abbey: ${JSON.stringify(inward)}`);
  await waitForAreas(2, "the abbey WB_AREA", 5000);
  await Bun.sleep(1500); // any flapping at the doorway would land here
  if (seen() !== 2) fail(`expected exactly one WB_AREA for the walk in, got ${seen() - 1}: ${JSON.stringify(areas.slice(1))}`);
  expectArea(areas[1]!, EXPECT.zone, EXPECT.inside, "abbey hall");
  if (client.state.self.area?.value.id !== EXPECT.inside.id) fail(`state.self.area did not follow: ${JSON.stringify(client.state.self.area)}`);
  if (client.state.self.zone?.value.id !== EXPECT.zone.id) fail(`state.self.zone changed: ${JSON.stringify(client.state.self.zone)}`);
  log(`PASS walk in: one WB_AREA -> ${areas[1]!.zoneName} / ${areas[1]!.areaName}`);

  // 4. Back out: one more, back to the valley. The edge fires both ways.
  const outward = await client.moveTo(HOME, { timeout: 30_000 });
  if (!outward.ok) fail(`walk back out: ${JSON.stringify(outward)}`);
  await waitForAreas(3, "the valley WB_AREA", 5000);
  await Bun.sleep(1500);
  if (seen() !== 3) fail(`expected exactly one WB_AREA for the walk out, got ${seen() - 2}: ${JSON.stringify(areas.slice(2))}`);
  expectArea(areas[2]!, EXPECT.zone, EXPECT.outside, "back outside");
  log(`PASS walk out: one WB_AREA -> ${areas[2]!.zoneName} / ${areas[2]!.areaName}`);

  console.log(`PASS: area-and-roles (${seen()} WB_AREA, ${((Date.now() - started) / 1000).toFixed(1)}s)`);
} catch (e) {
  console.log(`FAIL: ${String(e instanceof Error ? (e.stack ?? e.message) : e)}`);
  process.exitCode = 1;
} finally {
  await client.logout().catch(() => {});
  client.close();
}
