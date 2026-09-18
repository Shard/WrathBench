/**
 * Probe for the talent tree and respec surface: the
 * `talent_tree` action answered as `WB_TALENT_TREE` (tabs named from
 * TalentTab.dbc, talents named from Spell.dbc, `state.talentTree()` merging
 * the learned ranks), `learnTalent` spending a point, and `resetTalents`
 * through the trainer's unlearn gossip option (`MSG_TALENT_WIPE_CONFIRM`
 * tapped, echoed raw, `SMSG_TALENTS_INFO` after).
 *
 * It FAILS against any worldserver built before the tap (`talent_tree`
 * comes back 400 unsupported_action). Run it only after the image is
 * deployed: it is the gate for that build.
 *
 * Fixture: a persistent Human Paladin (default
 * `Smoketalent` on MODULE_ACCOUNT, never deleted) placed by
 * `infra/fixtures/apply.ts --scenario talents-stormwind` — level 10, 5g,
 * in front of Katherine the Pure (entry 5492) in Stormwind's cathedral. Not
 * Brother Sammuel: the abbey trainer's gossip menu (4663) is "Please teach
 * me." alone, while the city paladin trainers' menus (2304, 4469-4471)
 * carry the unlearn option (`gossip_menu_option` OptionType 16), and
 * `HandleTalentWipeConfirmOpcode` needs level 10 and a trainer of the
 * character's own class — so a respec is only testable here.
 *
 * Arc:
 *   1. login; Katherine in view with the trainer role;
 *   2. queryTalentTree -> three tabs (Holy, Protection, Retribution), every
 *      talent named, unspentPoints as SMSG_TALENTS_INFO says;
 *   3. if a point is unspent: learnTalent on a row-0 talent -> learned;
 *      state.talentTree() shows pointsSpent 1 there;
 *   4. resetTalents(Katherine) -> reset: talents empty, the point back, the
 *      quoted cost gone from state.money;
 *   5. logout. apply.ts resets level and money next run; the reset leaves
 *      the talents clean for it.
 *
 * Run from inside the network:
 *   docker compose -f infra/compose.yml exec runner bun infra/smoke/talent-tree.ts
 */

import { connect } from "../../sdk/src/index";
import { applyScenario, ensureFixtureCharacter, type FixtureContext } from "./lib/fixture";
import { authHeaders, MODULE_SECRET } from "./lib/auth";

const BASE = `http://${process.env.MODULE_HOST ?? "worldserver"}:${process.env.MODULE_PORT ?? "8086"}`;
const ACCOUNT = process.env.MODULE_ACCOUNT ?? "PROBE";
const TOKEN = `smoke-talent-tree-${crypto.randomUUID()}`;
const CHARACTER = process.env.SMOKE_CHARACTER ?? "Smoketalent";
const SCENARIO = "talents-stormwind";
const KATHERINE = 5492;
const PALADIN_TABS = ["Holy", "Protection", "Retribution"];

const started = Date.now();
const log = (m: string) => console.log(`[talent +${((Date.now() - started) / 1000).toFixed(1).padStart(5)}s] ${m}`);
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
      await c.createSession({ account: ACCOUNT, character: CHARACTER, race: 1, class: 2 });
      await c.logout();
    } finally {
      c.close();
    }
  },
};
await ensureFixtureCharacter(fixtureCtx);
await applyScenario(fixtureCtx, SCENARIO);

const client = await connect({ baseUrl: BASE, token: TOKEN, secret: MODULE_SECRET });
try {
  // 1. Login, the trainer in view, the talents packet from login.
  await client.createSession({ account: ACCOUNT, character: CHARACTER, race: 1, class: 2 });
  log(`in world as ${CHARACTER}, guid ${client.state.self.guid}, level ${client.state.self.level?.value}`);
  await client.waitForNearby((o) => o.entry?.value === KATHERINE && o.fields.get("npcFlags") !== undefined, { timeout: 15_000 });
  const trainer = client.state.units({ entry: KATHERINE })[0] ?? fail("Katherine the Pure not in units() — did apply.ts place the character?");
  if (!trainer.roles.includes("trainer")) fail(`Katherine's roles ${JSON.stringify(trainer.roles)} lack trainer`);
  const talents0 = client.state.talents() ?? fail("no SMSG_TALENTS_INFO from login");
  log(`talents at login: unspent ${talents0.unspentPoints}, spent rows ${JSON.stringify(talents0.talents)}`);

  // 2. The tree.
  const tree = await client.queryTalentTree({ timeout: 10_000 });
  log(`tree: class ${tree.class}, unspent ${tree.unspentPoints}, tabs ${JSON.stringify(tree.tabs.map((t) => [t.tabId, t.name, t.talents.length]))}`);
  if (tree.class !== 2) fail(`tree class ${tree.class}, expected 2 (paladin)`);
  if (tree.tabs.length !== 3) fail(`${tree.tabs.length} tabs, expected 3`);
  const names = tree.tabs.map((t) => t.name);
  if (!PALADIN_TABS.every((n) => names.includes(n))) fail(`tab names ${JSON.stringify(names)} are not ${JSON.stringify(PALADIN_TABS)} (did the module log "loaded N talent tabs"?)`);
  const unnamed = tree.tabs.flatMap((t) => t.talents.filter((x) => x.name === undefined));
  if (unnamed.length > 0) fail(`${unnamed.length} talent(s) without a Spell.dbc name: ${JSON.stringify(unnamed.slice(0, 3))}`);
  const withPrereq = tree.tabs.flatMap((t) => t.talents.filter((x) => x.dependsOn !== undefined));
  if (withPrereq.length === 0) fail("no talent carries a prerequisite — the DependsOn column did not come through");
  if (tree.unspentPoints !== talents0.unspentPoints) fail(`tree unspent ${tree.unspentPoints} != talents packet ${talents0.unspentPoints}`);
  log(`PASS tree: ${tree.tabs.reduce((n, t) => n + t.talents.length, 0)} talents, ${withPrereq.length} with prerequisites`);

  // 3. Spend a point when there is one.
  if (tree.unspentPoints > 0) {
    const tab = tree.tabs[0]!;
    const pick = tab.talents.find((x) => x.row === 0 && x.pointsSpent < x.maxRank) ?? fail("no row-0 talent to spend on");
    const result = await client.learnTalent(pick.talentId, pick.pointsSpent, { timeout: 10_000 });
    log(`learnTalent(${pick.talentId} ${pick.name}, ${pick.pointsSpent}): ${result.status}`);
    if (!result.ok) fail(`learnTalent refused: ${result.hint}`);
    const after = client.state.talentTree()?.tabs[0]!.talents.find((x) => x.talentId === pick.talentId);
    if (after?.pointsSpent !== pick.pointsSpent + 1) fail(`state.talentTree() shows pointsSpent ${after?.pointsSpent}, expected ${pick.pointsSpent + 1}`);
    log(`PASS learn: ${pick.name} now ${after.pointsSpent}/${after.maxRank}`);
  } else {
    log("no unspent point (a previous run left one spent); the reset below still proves the respec path");
  }

  // 4. Respec at the trainer.
  const spent = client.state.talents()?.talents.length ?? 0;
  const moneyBefore = client.state.money?.value ?? fail("money unobserved");
  const reset = await client.resetTalents(trainer, { timeout: 10_000 });
  log(`resetTalents: ${JSON.stringify(reset)}`);
  if (spent === 0) {
    if (reset.ok) fail("a reset with nothing spent should have been refused");
    log("PASS reset refused (nothing to unlearn), as the handler does");
  } else {
    if (!reset.ok) fail(`reset refused: ${reset.hint}`);
    if (reset.talents.talents.length !== 0) fail(`talents after reset: ${JSON.stringify(reset.talents.talents)}`);
    if (reset.talents.unspentPoints < 1) fail(`unspent after reset ${reset.talents.unspentPoints}`);
    await Bun.sleep(1000);
    const moneyAfter = client.state.money?.value ?? fail("money unobserved after reset");
    if (reset.cost > 0 && moneyBefore - moneyAfter !== reset.cost) fail(`money ${moneyBefore} -> ${moneyAfter}, expected -${reset.cost}`);
    log(`PASS reset: ${reset.talents.unspentPoints} point(s) back, cost ${reset.cost} (money ${moneyBefore} -> ${moneyAfter})`);
  }

  console.log(`PASS: talent-tree (${((Date.now() - started) / 1000).toFixed(1)}s)`);
} catch (e) {
  console.log(`FAIL: ${String(e instanceof Error ? (e.stack ?? e.message) : e)}`);
  process.exitCode = 1;
} finally {
  await client.logout().catch(() => {});
  client.close();
}
