/**
 * Probe for entering the Deadmines (docs/proposals/GROUP-PLAY.md §4): one
 * character walks from Moonbrook down the mine to the instance portal, is
 * transferred onto map 36 the way a client is (the module's areatrigger
 * crossing, `CMSG_AREATRIGGER`, the core's teleport, `SMSG_NEW_WORLD`),
 * walks a few yards inside, sees the Defias, and walks back out through the
 * exit trigger onto map 0.
 *
 * What it proves that the design could not assume: the navmesh is
 * continuous from Moonbrook's street through the mine's tunnels to trigger
 * 78, and map 36 has a mesh on the data volume (a move inside answering
 * `no_mesh` is the tell). It is the gate for enabling the campaign and joins
 * the release's deploy smokes while the campaign runs.
 *
 * The character is a persistent fixture on MODULE_ACCOUNT (default PROBE),
 * placed by `infra/fixtures/apply.ts --scenario moonbrook-mine`: level 80, so
 * nothing on the walk interrupts it.
 *
 *   bun wb smoke deadmines-entry
 *
 * Run it in a release window: it needs a worldserver whose module crosses
 * areatriggers (every build since the tram smoke) and the live realm.
 */

import { connect } from "../../sdk/src/index";
import { DEADMINES_ENTRANCE_TRIGGER, MOONBROOK } from "../fixtures/scenarios";
import { authHeaders, MODULE_SECRET } from "./lib/auth";
import { accountFixtureName, applyScenario, ensureFixtureCharacter, type FixtureContext } from "./lib/fixture";
import { moduleBase } from "./lib/module";
import { dist2d, fmt, walkTo } from "./lib/party";

const BASE = moduleBase();
const ACCOUNT = process.env.MODULE_ACCOUNT ?? "PROBE";
const CHARACTER = accountFixtureName("Dmines", ACCOUNT);
const TOKEN = `smoke-deadmines-${crypto.randomUUID()}`;
/** `areatrigger_teleport` 78's target on map 36, and trigger 119 just inside, back to map 0 at (-11208.3, 1672.52). */
const INSIDE_ARRIVAL = { x: -16.4, y: -383.07, z: 61.78 };
const EXIT_TRIGGER = { x: -14.4, y: -393.4, z: 64.6 };
const OUTSIDE_ARRIVAL = { x: -11208.3, y: 1672.52, z: 24.66 };
const DEADMINES_MAP = 36;

const started = Date.now();
const log = (m: string) => console.log(`[deadmines-entry +${((Date.now() - started) / 1000).toFixed(1).padStart(6)}s] ${m}`);
function fail(m: string): never {
  throw new Error(m);
}

const health = await fetch(`${BASE}/health`, { headers: authHeaders() }).then((r) => r.json() as Promise<{ ok?: boolean; build?: string }>);
if (!health?.ok) fail(`health not ok: ${JSON.stringify(health)}`);
log(`health ok: build=${health.build ?? "?"}; ${CHARACTER} on ${ACCOUNT}`);

const client = await connect({ baseUrl: BASE, token: TOKEN, secret: MODULE_SECRET, account: ACCOUNT });
const fixture: FixtureContext = {
  base: BASE,
  account: ACCOUNT,
  character: CHARACTER,
  token: `${TOKEN}-fixture`,
  log,
  fail,
  createAndLogout: async () => {
    // Human warrior: the class is irrelevant at level 80 on this walk.
    await client.createSession({ account: ACCOUNT, character: CHARACTER, race: 1, class: 1 });
    await client.logout();
  },
};
const areas: { map: number; seq: number }[] = [];
client.events.onAny((e: any) => {
  if (e?.opcode === "WB_AREA" && typeof e.data?.map === "number") areas.push({ map: e.data.map, seq: e.seq });
});

try {
  await ensureFixtureCharacter(fixture);
  await applyScenario(fixture, "moonbrook-mine");
  await client.createSession({ account: ACCOUNT, character: CHARACTER });
  await Bun.sleep(1500);
  const start = client.state.self.position?.value ?? fail("no position after login");
  if (start.map !== 0 || dist2d(start, MOONBROOK) > 8) fail(`start ${fmt(start)} on map ${start.map}, expected Moonbrook ${fmt(MOONBROOK)}`);
  log(`in Moonbrook at ${fmt(start)}, ${dist2d(start, DEADMINES_ENTRANCE_TRIGGER).toFixed(0)}y from trigger 78`);

  // 1. Down the mine to the portal: only `transferred` onto map 36 is success.
  const sinceIn = client.events.recent(1)[0]?.seq ?? 0;
  const inbound = await walkTo(client, DEADMINES_ENTRANCE_TRIGGER, log);
  if (!(inbound.ok && inbound.status === "transferred")) fail(`the walk to trigger 78 ended ${inbound.status}${!inbound.ok && inbound.hint ? `: ${inbound.hint}` : ""}`);
  if (inbound.to.map !== DEADMINES_MAP) fail(`transferred to map ${inbound.to.map}, expected ${DEADMINES_MAP}`);
  if (dist2d(inbound.to, INSIDE_ARRIVAL) > 10) fail(`arrived at ${fmt(inbound.to)}, ${dist2d(inbound.to, INSIDE_ARRIVAL).toFixed(0)}y from the teleport target ${fmt(INSIDE_ARRIVAL)}`);
  const seen = (op: string, since: number) => client.events.recent(500).some((e: any) => e.seq > since && e.opcode === op);
  for (const op of ["SMSG_TRANSFER_PENDING", "SMSG_NEW_WORLD"]) if (!seen(op, sinceIn)) fail(`no ${op} on the stream for the transfer`);
  await Bun.sleep(1500);
  if (!areas.some((a) => a.seq > sinceIn && a.map === DEADMINES_MAP)) fail(`no WB_AREA for map ${DEADMINES_MAP} after the transfer`);
  log(`PASS entry: transferred onto map ${DEADMINES_MAP} at ${fmt(inbound.to)}; SMSG_TRANSFER_PENDING, SMSG_NEW_WORLD and WB_AREA seen`);

  // 2. One move inside arrives: map 36 has a mesh. Twelve yards along the
  // arrival's facing (the teleport target's o, 1.86), away from exit trigger
  // 119, which sits behind the arrival point.
  const inside = { x: INSIDE_ARRIVAL.x + 12 * Math.cos(1.86), y: INSIDE_ARRIVAL.y + 12 * Math.sin(1.86), z: INSIDE_ARRIVAL.z };
  let walk = await client.moveTo(inside, { timeout: 60_000 });
  if (!walk.ok && walk.status === "target_off_mesh" && walk.nearest) walk = await client.moveTo(walk.nearest, { timeout: 60_000 });
  if (!(walk.ok && walk.status === "arrived")) fail(`a move inside map ${DEADMINES_MAP} ended ${walk.status}${!walk.ok && walk.hint ? `: ${walk.hint}` : ""} — no_mesh means map 36 has no mmaps on the data volume`);
  log(`PASS mesh: a move inside arrived at ${fmt(walk.position)}`);

  // 3. The Defias are there.
  const deadline = Date.now() + 15_000;
  let defias = client.state.units({ name: /^Defias/, type: "unit" });
  while (defias.length === 0 && Date.now() < deadline) {
    await Bun.sleep(500);
    defias = client.state.units({ name: /^Defias/, type: "unit" });
  }
  if (defias.length === 0) fail(`no Defias in view inside: ${client.state.units({ type: "unit" }).slice(0, 8).map((u) => u.name).join(", ") || "nothing"}`);
  log(`PASS population: ${defias.length} Defias in view, nearest ${defias[0]!.name} level ${defias[0]!.level} at ${defias[0]!.distance?.toFixed(0)}y`);

  // 4. Out again through trigger 119.
  const sinceOut = client.events.recent(1)[0]?.seq ?? 0;
  const out = await walkTo(client, EXIT_TRIGGER, log);
  if (!(out.ok && out.status === "transferred")) fail(`the walk to exit trigger 119 ended ${out.status}${!out.ok && out.hint ? `: ${out.hint}` : ""}`);
  if (out.to.map !== 0 || dist2d(out.to, OUTSIDE_ARRIVAL) > 10) fail(`left to map ${out.to.map} at ${fmt(out.to)}, expected map 0 near ${fmt(OUTSIDE_ARRIVAL)}`);
  await Bun.sleep(1500);
  if (!areas.some((a) => a.seq > sinceOut && a.map === 0)) fail("no WB_AREA for map 0 after leaving");
  log(`PASS exit: back on map 0 at ${fmt(out.to)}`);
  console.log(`PASS: deadmines-entry (${((Date.now() - started) / 1000).toFixed(1)}s)`);
} catch (e) {
  console.log(`FAIL: ${String(e instanceof Error ? (e.stack ?? e.message) : e)}`);
  process.exitCode = 1;
} finally {
  await client.logout().catch(() => {});
  client.close();
}
