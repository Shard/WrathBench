/**
 * The start-zone gate for race-probe@1: create, log in, walk and take a quest
 * once at each start no benchmark run has used yet.
 *
 * race-probe@1 sweeps every race's own start, and until it no run had driven a
 * Horde character or started on map 530. The server allows all of them
 * (normal realm, two-faction accounts, every bench account on expansion 2,
 * navmesh tiles for maps 0, 1 and 530), but "the server allows it" is not "the
 * harness has done it". This smoke is that check, and its Horde cells are not
 * enabled until it passes (docs/EPISODES.md, `probing`).
 *
 * Per start, with the cell's own race and class:
 *   0. delete LAST run's character of that name (the real CMSG_CHAR_DELETE
 *      path) — first, not last: a character that just logged out lingers in
 *      world for the core's expire time and a delete then is ignored;
 *   1. createSession -> in world at level 1 on the expected map;
 *   2. a unit marked as having a quest available comes into view;
 *   3. moveTo it -> arrived;
 *   4. questsAvailableFrom -> acceptQuestFrom the first offer -> in the log;
 *   5. logout.
 * Nothing is asserted about which quest or which NPC: the gate is that each
 * start plays, not that it plays a particular way.
 *
 *   kubectl -n wrathbench exec deploy/wrathbench-runner -- bun infra/smoke/race-probe-starts.ts
 *   docker compose -f infra/compose.yml exec runner bun infra/smoke/race-probe-starts.ts
 *
 * `SMOKE_STARTS=orc,undead` runs a subset. Account: MODULE_ACCOUNT, default
 * PROBE (never a pool account: the characters are left standing between runs).
 */

import { connect, type WrathClient } from "../../sdk/src/index";
import { deleteFixtureCharacters } from "./lib/fixture";
import { authHeaders, MODULE_SECRET } from "./lib/auth";
import { moduleBase } from "./lib/module";

const BASE = moduleBase();
const ACCOUNT = process.env.MODULE_ACCOUNT ?? "PROBE";
const RUN = crypto.randomUUID();

/** The five starts race-probe@1 is the first to use, with the cell's race and class. */
const STARTS = [
  { key: "orc", cell: "orc-warrior", race: 2, class: 1, map: 1, character: "Smokeorc" },
  { key: "undead", cell: "undead-warrior", race: 5, class: 1, map: 0, character: "Smokeundead" },
  { key: "tauren", cell: "tauren-warrior", race: 6, class: 1, map: 1, character: "Smoketauren" },
  { key: "bloodelf", cell: "bloodelf-rogue", race: 10, class: 4, map: 530, character: "Smokebelf" },
  { key: "draenei", cell: "draenei-warrior", race: 11, class: 1, map: 530, character: "Smokedraenei" },
] as const;

type Start = (typeof STARTS)[number];

const QUESTGIVER_TIMEOUT_MS = 20_000;
const MOVE_TIMEOUT_MS = 30_000;

const started = Date.now();
const log = (m: string): void => console.log(`[starts +${((Date.now() - started) / 1000).toFixed(1).padStart(5)}s] ${m}`);

class StartFailed extends Error {}
function fail(m: string): never {
  throw new StartFailed(m);
}

/** The nearest unit the server marks as offering a quest, once one is in view. */
async function nearestQuestgiver(client: WrathClient): Promise<{ guid: string; name: string | undefined; distance: number | undefined }> {
  const deadline = Date.now() + QUESTGIVER_TIMEOUT_MS;
  for (;;) {
    const offering = client.state
      .units()
      .filter((u) => u.questGiver === "available" || u.questGiver === "low_level_available")
      .sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));
    const u = offering[0];
    if (u !== undefined) return { guid: u.guid, name: u.name, distance: u.distance };
    if (Date.now() > deadline) fail(`no unit marked as offering a quest came into view within ${QUESTGIVER_TIMEOUT_MS / 1000}s`);
    await Bun.sleep(250);
  }
}

async function runStart(s: Start): Promise<void> {
  log(`${s.key}: ${s.cell} (race ${s.race}, class ${s.class}) as ${s.character} on ${ACCOUNT}`);
  await deleteFixtureCharacters({ base: BASE, account: ACCOUNT, token: `smoke-starts-${RUN}-${s.key}`, log }, [s.character]);
  const client = await connect({ baseUrl: BASE, token: `smoke-starts-${RUN}-${s.key}-play`, secret: MODULE_SECRET });
  try {
    // 1. A fresh character at its race's own start.
    await client.createSession({ account: ACCOUNT, character: s.character, race: s.race, class: s.class });
    const deadline = Date.now() + 10_000;
    while (client.state.self.position === undefined || client.state.self.level === undefined) {
      if (Date.now() > deadline) fail("no self position or level observed after login");
      await Bun.sleep(100);
    }
    const level = client.state.self.level.value;
    const pos = client.state.self.position.value;
    if (level !== 1) fail(`logged in at level ${level}; a fresh character starts at level 1`);
    if (pos.map !== s.map) fail(`logged in on map ${pos.map}; the ${s.key} start is on map ${s.map}`);
    log(
      `  in world: level 1, map ${pos.map}, ${client.state.self.zone?.value.name ?? "zone ?"} / ${client.state.self.area?.value.name ?? "area ?"}`,
    );

    // 2–3. A questgiver in view, walked to.
    const npc = await nearestQuestgiver(client);
    log(`  questgiver: ${npc.name ?? npc.guid}, ${npc.distance?.toFixed(1) ?? "?"}y`);
    const moved = await client.moveTo(npc.guid, { timeout: MOVE_TIMEOUT_MS });
    if (!moved.ok || moved.status !== "arrived") fail(`moveTo the questgiver: ${JSON.stringify(moved)}`);
    log(`  arrived at (${moved.position.x.toFixed(1)}, ${moved.position.y.toFixed(1)}, ${moved.position.z.toFixed(1)})`);

    // 4. Its first offer, taken and in the log.
    const offered = await client.questsAvailableFrom(npc.guid);
    const first = offered.ok ? offered.quests[0] : undefined;
    if (first === undefined) fail(`questsAvailableFrom offered nothing: ${JSON.stringify(offered)}`);
    const accepted = await client.acceptQuestFrom(npc.guid, first.questId);
    if (!accepted.ok) fail(`acceptQuestFrom ${first.questId}: ${JSON.stringify(accepted)}`);
    if (client.state.quest(first.questId) === undefined) fail(`quest ${first.questId} is not in the quest log after accepting`);
    log(`  PASS ${s.key}: accepted ${first.questId} "${first.title}"`);
  } finally {
    // 5. Out of the world; the character stays until the next run deletes it.
    await client.logout().catch(() => {});
    client.close();
  }
}

const health = await fetch(`${BASE}/health`, { headers: authHeaders() }).then((r) => r.json() as Promise<{ ok?: boolean; build?: string }>);
if (health.ok !== true) {
  console.log(`FAIL: module health not ok: ${JSON.stringify(health)}`);
  process.exit(1);
}
log(`health ok: build=${health.build ?? "?"}`);

const wanted = (process.env.SMOKE_STARTS ?? "").split(",").map((x) => x.trim()).filter((x) => x.length > 0);
const chosen = wanted.length === 0 ? STARTS : STARTS.filter((s) => wanted.includes(s.key));
if (chosen.length === 0) {
  console.log(`FAIL: SMOKE_STARTS named none of ${STARTS.map((s) => s.key).join(", ")}`);
  process.exit(2);
}

const failed: string[] = [];
for (const s of chosen) {
  try {
    await runStart(s);
  } catch (e) {
    failed.push(s.key);
    log(`  FAIL ${s.key}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
const elapsed = ((Date.now() - started) / 1000).toFixed(1);
if (failed.length > 0) {
  console.log(`FAIL: race-probe starts ${failed.join(", ")} (${chosen.length - failed.length}/${chosen.length} passed, ${elapsed}s)`);
  process.exitCode = 1;
} else {
  console.log(`PASS: race-probe starts ${chosen.map((s) => s.key).join(", ")} (${elapsed}s)`);
}
