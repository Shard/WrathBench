/**
 * Gate 1 (docs/PHASE-0.md): one quest end to end, through the SDK only.
 *
 * Create a character -> accept a starter quest -> turn it in -> take the kill
 * quest -> clear kobolds until the quest log says the objective is done -> loot
 * each corpse -> turn in -> gain a level. No raw HTTP: everything here is a
 * call on the client, and everything the script knows about the world it read
 * off `client.state`. That is the point — this file is the advertisement for
 * the SDK surface, so if it starts growing game logic, the helper is missing.
 *
 * Run:
 *   docker compose -f infra/compose.yml exec runner bun infra/smoke/one-quest.ts
 */

import { connect, pointOf, type NearbyObject } from "../../sdk/src/index";

const BASE = `http://${process.env.MODULE_HOST ?? "worldserver"}:${process.env.MODULE_PORT ?? "8086"}`;
// Long-lived probe sessions use the PROBE account, never RUNNER: the module
// allows one live session per account and RUNNER belongs to the runner track.
const ACCOUNT = process.env.MODULE_ACCOUNT ?? "PROBE";
const TOKEN = `smoke-quest-${Date.now()}`;
// Fresh name per run: the arc starts at level 1 with an empty quest log, and
// the realm caps characters per account at ten.
const CHARACTER = "Sq" + Date.now().toString(26).replace(/[0-9]/g, (d) => "ghijklmnop"[+d]).slice(-8);

const QUEST_INTRO = 783; // A Threat Within (Deputy Willem -> Marshal McBride)
const QUEST_KILL = 7; //   Kobold Camp Cleanup (kill 8, entry 6)
const WILLEM = 823;
const MCBRIDE = 197;
const VERMIN = 6;
const ABBEY = { x: -8902.6, y: -162.6, z: 82.0 };
const VINEYARDS = { x: -8790, y: -160, z: 82.5 };

const log = (m: string) => console.log(`[smoke ${new Date().toISOString().slice(11, 19)}] ${m}`);
function fail(m: string): never {
  // A function declaration, not an arrow: TypeScript only narrows past a
  // `never`-returning call when it can see the signature this way.
  throw new Error(m);
}

const client = await connect({ baseUrl: BASE, token: TOKEN });
const alive = (entry: number) => (o: NearbyObject) =>
  o.entry?.value === entry && o.health?.value.current !== 0 && pointOf(o) !== undefined;
const nearest = async (entry: number, what: string, timeout = 30_000) => {
  await client.waitForNearby(alive(entry), { timeout });
  return client.state.closest(alive(entry)) ?? fail(`lost sight of ${what}`);
};

try {
  await client.createSession({ account: ACCOUNT, character: CHARACTER, race: 1, class: 2 });
  log(`in world as ${CHARACTER} (Human Paladin), guid ${client.state.self.guid}`);

  const willem = await nearest(WILLEM, "the first questgiver", 15_000);
  const intro = await client.acceptQuestFrom(willem.guid, QUEST_INTRO);
  if (!intro.ok) fail(`quest ${QUEST_INTRO} not offered: saw ${JSON.stringify(intro.offered)}`);
  log(`accepted quest ${QUEST_INTRO} (${intro.status})`);

  if (!(await client.moveTo(ABBEY, { timeout: 120_000 })).ok) fail("could not walk to the abbey");
  const mcbride = await nearest(MCBRIDE, "the second questgiver");
  const introDone = await client.turnInQuest(mcbride.guid, QUEST_INTRO);
  if (!introDone.ok) fail(`quest ${QUEST_INTRO} would not turn in`);
  log(`turned in ${QUEST_INTRO} for ${introDone.xp} xp; level ${client.state.self.level?.value}`);

  // The chain may have auto-added the kill quest during that turn-in, which is
  // why the helper reads the log before it asks.
  const kill = await client.acceptQuestFrom(mcbride.guid, QUEST_KILL);
  if (!kill.ok) fail(`quest ${QUEST_KILL} not offered: saw ${JSON.stringify(kill.offered)}`);
  log(`accepted quest ${QUEST_KILL} (${kill.status})`);

  if (!(await client.moveTo(VINEYARDS, { timeout: 120_000 })).ok) fail("could not walk to the kobolds");
  let kills = 0;
  while (client.state.quest(QUEST_KILL)?.complete !== true) {
    const health = client.state.self.health?.value;
    if (health && health.current < health.max * 0.5) {
      log(`resting at ${health.current}/${health.max}`);
      // Bounded: a character that died to something outside the fight, or a
      // gauge that stops being observed, must not park the run here forever.
      const restUntil = Date.now() + 90_000;
      while ((client.state.self.health?.value.current ?? 0) < health.max * 0.9) {
        if (Date.now() > restUntil) break;
        await Bun.sleep(1000);
      }
    }
    const kobold = await nearest(VERMIN, "a kobold");
    const at = pointOf(kobold)!.value;
    await client.moveTo(at, { timeout: 60_000 });
    const fight = await client.killTarget(kobold.guid);
    if (!fight.ok) {
      log(`fight ended ${fight.status} after ${fight.swings} swings; picking another`);
      if (fight.status === "player_died") fail("died in the vineyards");
      continue;
    }
    const loot = await client.lootCorpse(kobold.guid);
    kills++;
    log(
      `kill ${kills}: ${fight.swings} swings, looted ${loot.items.length} items + ${loot.gold}c;` +
        ` objective ${client.state.quest(QUEST_KILL)?.counts[0]}`,
    );
  }
  const objective = await client.waitForQuestObjective(QUEST_KILL);
  log(`objective complete after ${kills} kills: state=${objective.state} counts=${objective.counts}`);

  if (!(await client.moveTo(ABBEY, { timeout: 120_000 })).ok) fail("could not walk back to the abbey");
  const turnIn = await client.turnInQuest((await nearest(MCBRIDE, "the questgiver")).guid, QUEST_KILL);
  if (!turnIn.ok) fail(`quest ${QUEST_KILL} would not turn in`);
  await Bun.sleep(2000); // let the reward's XP and level fields land
  const level = client.state.self.level?.value ?? 1;
  log(`turned in ${QUEST_KILL} for ${turnIn.xp} xp and ${turnIn.money}c`);
  console.log(
    `${level >= 2 ? "PASS" : "FAIL"}: level ${level}, xp ${client.state.xp?.value}/${client.state.nextLevelXp?.value},` +
      ` money ${client.state.money?.value}c, ${kills} kills, ${client.state.inventory.length} inventory slots` +
      ` (e.g. "${client.state.inventory.find((i) => i.name !== undefined)?.name}")`,
  );
  if (level < 2) process.exitCode = 1;
} catch (e) {
  console.log(`FAIL: ${String(e instanceof Error ? (e.stack ?? e.message) : e)}`);
  process.exitCode = 1;
} finally {
  await client.logout().catch(() => {});
  const gone = await client
    .deleteCharacter(CHARACTER, { account: ACCOUNT, initialDelayMs: 3000 })
    .catch((e: unknown) => String(e));
  log(`cleanup: ${CHARACTER} ${typeof gone === "string" ? gone : "deleted"}`);
  client.close();
}
