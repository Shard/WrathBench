/**
 * Probe for the reputation pane (FOLLOW-UPS 99): `SMSG_INITIALIZE_FACTIONS`
 * tapped at login and folded into `state.reputation()` with Faction.dbc
 * names and the client's race/class base, plus `SMSG_SET_FACTION_VISIBLE`
 * / `SMSG_SET_FACTION_STANDING` as they come.
 *
 * It FAILS against any worldserver built before the tap (`reputation()`
 * empty). Run it only after the image is deployed.
 *
 * Arc: fresh Human Paladin -> login -> the login list lands on the event
 * stream (it is sent during login, before `createSession` resolves, and the
 * stream folds it asynchronously — so wait for the fold, as skills.ts does
 * for its create block) -> reputation() has Stormwind (72)
 * visible and at least Friendly for a human (base 2500 + a fresh human's
 * standing), Orgrimmar (76) Hated and at war, every row named -> logout and
 * delete. A standing change is not forced here: the login list and the
 * decode are what the deploy must prove; the SET_FACTION_STANDING path is
 * exercised by any quest turn-in in a real run.
 *
 * Run from inside the network:
 *   docker compose -f infra/compose.yml exec runner bun infra/smoke/reputation.ts
 */

import { connect } from "../../sdk/src/index";
import { probeName } from "./lib/name";

const BASE = `http://${process.env.MODULE_HOST ?? "worldserver"}:${process.env.MODULE_PORT ?? "8086"}`;
const ACCOUNT = process.env.MODULE_ACCOUNT ?? "PROBE";
const TOKEN = `smoke-reputation-${crypto.randomUUID()}`;
const CHARACTER = probeName("Br");
const FACTION_STORMWIND = 72;
const FACTION_ORGRIMMAR = 76;

const started = Date.now();
const log = (m: string) => console.log(`[rep +${((Date.now() - started) / 1000).toFixed(1).padStart(5)}s] ${m}`);
function fail(m: string): never {
  throw new Error(m);
}

const health = await fetch(`${BASE}/health`).then((r) => r.json() as Promise<any>);
if (!health?.ok) fail(`health not ok: ${JSON.stringify(health)}`);
log(`health ok: build=${health.build ?? "?"}`);

const client = await connect({ baseUrl: BASE, token: TOKEN });
try {
  await client.createSession({ account: ACCOUNT, character: CHARACTER, race: 1, class: 2 });
  log(`in world as ${CHARACTER}`);
  const deadline = Date.now() + 10_000;
  while (client.state.reputation().length === 0) {
    if (Date.now() > deadline) break;
    await Bun.sleep(100);
  }
  const rep = client.state.reputation();
  log(`reputation: ${rep.length} rows, visible ${rep.filter((r) => r.visible).length}: ${JSON.stringify(rep.filter((r) => r.visible).map((r) => [r.name, r.reputation, r.rank]))}`);
  if (rep.length === 0) fail("reputation() is empty — SMSG_INITIALIZE_FACTIONS did not arrive or was not folded");
  const unnamed = rep.filter((r) => r.name === undefined);
  if (unnamed.length > 0) fail(`${unnamed.length} row(s) without a Faction.dbc name: ${JSON.stringify(unnamed.slice(0, 3))}`);
  const sw = client.state.reputationWith(FACTION_STORMWIND) ?? fail("no Stormwind row");
  if (!sw.visible) fail(`Stormwind not visible: ${JSON.stringify(sw)}`);
  if (sw.base === undefined) fail("Stormwind carries no base — the module could not read the player's race/class");
  if (!["Friendly", "Honored", "Revered", "Exalted"].includes(sw.rank)) fail(`Stormwind rank ${sw.rank} (${sw.reputation}) for a human`);
  const org = client.state.reputationWith(FACTION_ORGRIMMAR) ?? fail("no Orgrimmar row");
  if (org.rank !== "Hated" || !org.atWar) fail(`Orgrimmar ${JSON.stringify(org)}, expected Hated and at war`);
  if (client.state.reputationWith("stormwind")?.factionId !== FACTION_STORMWIND) fail("reputationWith(\"stormwind\") did not resolve");
  console.log(`PASS: reputation (${rep.length} rows, Stormwind ${sw.rank} ${sw.reputation}, ${((Date.now() - started) / 1000).toFixed(1)}s)`);
} catch (e) {
  console.log(`FAIL: ${String(e instanceof Error ? (e.stack ?? e.message) : e)}`);
  process.exitCode = 1;
} finally {
  await client.logout().catch(() => {});
  await client.deleteCharacter(CHARACTER, { account: ACCOUNT }).catch((e) => log(`delete failed: ${String(e)}`));
  client.close();
}
