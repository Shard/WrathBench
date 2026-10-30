/**
 * Census of the stack's in-game wave 3 (wrath-mcp issue 4, its CHANGELOG's
 * item raw actions and single-item repair, instance saves and difficulty,
 * world states, weather, the game clock and own speeds): the readings a
 * login now folds and the raw opcodes a level-1 character can exercise on
 * the live server. One persistent Human Warrior (`Wv` + the account's
 * letters, e.g. `Wvsmokee` on SMOKE4) reset to level 1 at the Northshire
 * start (`northshire-fresh`), with Godric Rothgar (1213, Armorer &
 * Shieldcrafter, a vendor that repairs) a short walk away.
 *
 * A census like stack-observation: every check prints PASS, FAIL, SKIP or
 * INFO with what decided it and the smoke carries on; only a setup failure
 * (no login) stops it. It exits 1 on any FAIL. A silence the module's
 * PROTOCOL.md documents passes only when nothing arrives within 2 s and a
 * raw CMSG_QUERY_TIME is still answered afterwards.
 *
 *   1. Self at login: `speeds` with a run speed near 7, `gameTime`,
 *      `worldStates` for the scenario's zone (Elwynn Forest, 12, map 0),
 *      `dungeonDifficulty`; `weather` and `raidDifficulty` as INFO (a zone
 *      without weather sends none, and the raid one comes only when it
 *      differs from the stored one).
 *   2. Raw CMSG_REQUEST_RAID_INFO -> SMSG_RAID_INSTANCE_INFO with no locks,
 *      and `state.self.instanceLocks` [].
 *   3. Raw CMSG_RESET_INSTANCES: one SMSG_INSTANCE_RESET(_FAILED) per saved
 *      instance, so none for this character; either passes.
 *   4. Raw CMSG_ITEM_REFUND_INFO on a carried item bought with no extended
 *      cost (the starting kit): silence, no SMSG_ITEM_REFUND_INFO_RESPONSE.
 *   5. At Godric: `repairAll(vendor)` and `repairAll(vendor, item)` with a
 *      carried item are acked and leave the money as it was (the kit is at
 *      full durability, so a repair costs nothing and only the ack and a live
 *      session are observable); `repairAll(vendor, "<no such item>")` throws
 *      before anything is sent.
 *   6. Raw MSG_SET_DUNGEON_DIFFICULTY to the other difficulty: a solo change
 *      outside an instance is accepted silently, so no echo; a relog then
 *      reads it from the login's MSG_SET_DUNGEON_DIFFICULTY. It is set back
 *      to normal before the smoke ends, the character being persistent.
 *   SKIPPED, by design: threat (needs a fight, about one update a second per
 *   creature), weather changes, an instance save and its reset, the other
 *   item raw actions (gems, temporary enchants, a refundable purchase,
 *   glyphs, buying into a bag), the dispel logs.
 *
 * It FAILS against a worldserver built before the pin that serves wave 3.
 * Standalone, not in the suite and not a deploy smoke:
 *
 *   bun wb smoke stack-wave3      # once the runner image carries it
 *
 * MODULE_ACCOUNT defaults to SMOKE4, which has room for a fixture character
 * (PROBE sits at the realm's ten-character cap).
 */

import { connect, type StreamEvent, type UnitView, type WrathClient } from "@wrathbench/sdk";
import { SCENARIOS, type ScenarioName } from "../fixtures/scenarios";
import { accountFixtureName, applyScenario, ensureFixtureCharacter, type FixtureContext } from "./lib/fixture";
import { authHeaders, MODULE_SECRET } from "./lib/auth";
import { moduleBase } from "./lib/module";
import { smokeSubToken, smokeToken } from "./lib/session";

const BASE = moduleBase();
const ACCOUNT = process.env.MODULE_ACCOUNT ?? "SMOKE4";
const TOKEN = smokeToken("stack-wave3");
const CHARACTER = process.env.SMOKE_CHARACTER ?? accountFixtureName("Wv", ACCOUNT);
const SCENARIO: ScenarioName = "northshire-fresh";
const RACE_HUMAN = 1;
const CLASS_WARRIOR = 1;
const GODRIC_ROTHGAR = 1213;
const REPLY_MS = 5_000;
const SILENCE_MS = 2_000;
const DUNGEON_NORMAL = 0;
const DUNGEON_HEROIC = 1;

const started = Date.now();
const log = (m: string) => console.log(`[stack-wave3 +${((Date.now() - started) / 1000).toFixed(1).padStart(5)}s] ${m}`);
function fail(m: string): never {
  throw new Error(m);
}

type Verdict = "PASS" | "FAIL" | "SKIP" | "INFO";
const results: { verdict: Verdict; name: string; detail: string }[] = [];
function report(verdict: Verdict, name: string, detail: string): void {
  results.push({ verdict, name, detail });
  log(`${verdict} ${name}: ${detail}`);
}
/** Run one check; a throw is its FAIL, never the smoke's. */
async function check(name: string, fn: () => Promise<[Verdict, string]> | [Verdict, string]): Promise<void> {
  try {
    const [verdict, detail] = await fn();
    report(verdict, name, detail);
  } catch (e) {
    report("FAIL", name, String(e instanceof Error ? e.message : e));
  }
}

const show = (v: unknown): string => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

async function until(ms: number, done: () => boolean): Promise<boolean> {
  const by = Date.now() + ms;
  while (!done()) {
    if (Date.now() > by) return false;
    await Bun.sleep(50);
  }
  return true;
}

/**
 * The newest seq the cache has folded. Not `events.recent()`: the SDK keeps
 * world state changes (and threat lists) out of its retained buffer.
 */
const lastSeq = (client: WrathClient): number => client.state.lastSeq;

/** The next event after `from` matching, or undefined on timeout. */
async function nextEvent(client: WrathClient, from: number, match: (e: StreamEvent) => boolean, ms = REPLY_MS): Promise<StreamEvent | undefined> {
  const already = client.events.recent().find((e) => e.seq > from && match(e));
  if (already !== undefined) return already;
  try {
    return await client.events.waitFor((e) => e.seq > from && match(e), { timeout: ms });
  } catch {
    return undefined;
  }
}
const isOpcode = (...opcodes: string[]) => (e: StreamEvent) => opcodes.includes(e.opcode);
const data = (e: StreamEvent | undefined): Record<string, unknown> => (e?.data ?? {}) as Record<string, unknown>;

/** The session still answers: a raw CMSG_QUERY_TIME gets its reply. */
async function stillAnswers(client: WrathClient): Promise<boolean> {
  const from = lastSeq(client);
  await client.raw("CMSG_QUERY_TIME");
  return (await nextEvent(client, from, isOpcode("SMSG_QUERY_TIME_RESPONSE"))) !== undefined;
}

/** A documented silence: nothing matching within SILENCE_MS, and the session still answers after. */
async function silence(client: WrathClient, from: number, ...opcodes: string[]): Promise<{ heard: StreamEvent | undefined; alive: boolean }> {
  const heard = await nextEvent(client, from, isOpcode(...opcodes), SILENCE_MS);
  return { heard, alive: await stillAnswers(client) };
}

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
    const c = await connect({ baseUrl: BASE, token: smokeSubToken(TOKEN, "create"), secret: MODULE_SECRET });
    try {
      await c.createSession({ account: ACCOUNT, character: CHARACTER, race: RACE_HUMAN, class: CLASS_WARRIOR });
      await c.logout();
    } finally {
      c.close();
    }
  },
};

/** Log in under a fresh sub-token and wait for the fixture's position. */
async function login(suffix: string): Promise<WrathClient> {
  const client = await connect({ baseUrl: BASE, token: smokeSubToken(TOKEN, suffix), secret: MODULE_SECRET });
  try {
    await client.createSession({ account: ACCOUNT, character: CHARACTER, race: RACE_HUMAN, class: CLASS_WARRIOR });
    if (!(await until(10_000, () => client.state.self.position !== undefined))) fail(`${CHARACTER}: no self position observed after login (${suffix})`);
    return client;
  } catch (e) {
    await client.logout().catch(() => {});
    client.close();
    throw e;
  }
}

/** The dungeon difficulty the server holds for the character, as far as this smoke knows: restored to normal at the end. */
let serverDifficulty: number | undefined;
let session: WrathClient | undefined;
try {
  const health = await fetch(`${BASE}/health`, { headers: authHeaders() }).then((r) => r.json() as Promise<{ ok?: boolean; build?: string }>);
  if (health?.ok !== true) fail(`health not ok: ${show(health)}`);
  log(`health ok: build=${health.build ?? "?"}, character=${CHARACTER} on ${ACCOUNT}`);
  await ensureFixtureCharacter(fixtureCtx);
  await applyScenario(fixtureCtx, SCENARIO);

  let client = await login("play");
  session = client;
  const want = SCENARIOS[SCENARIO].position;
  const at = client.state.self.position?.value ?? fail("no position");
  if (at.map !== want.map || Math.hypot(at.x - want.x, at.y - want.y) > 3) fail(`fixture did not land: (${at.x.toFixed(1)}, ${at.y.toFixed(1)}) on map ${at.map}`);
  log(`in world as ${CHARACTER}, guid ${client.state.self.guid}`);
  const self = () => client.state.self;

  // 1. Self at login.
  await check("self.speeds", async () => {
    await until(3000, () => self().speeds !== undefined);
    const s = self().speeds?.value;
    if (s === undefined) return ["FAIL", "state.self.speeds undefined 3s after login (no speeds on our own create block)"];
    const plausible = s.run > 6.5 && s.run < 7.5 && s.walk > 0 && s.walk < s.run && s.turnRate > 0;
    return [plausible ? "PASS" : "FAIL", show(s)];
  });
  await check("self.gameTime", async () => {
    await until(3000, () => self().gameTime !== undefined);
    const g = self().gameTime?.value;
    if (g === undefined) return ["FAIL", "state.self.gameTime undefined 3s after login (no SMSG_LOGIN_SETTIMESPEED folded)"];
    return [/^\d{4}-\d\d-\d\d \d\d:\d\d$/.test(g.time) && g.speed > 0 ? "PASS" : "FAIL", show(g)];
  });
  await check("self.worldStates for the zone", async () => {
    await until(3000, () => self().worldStates !== undefined);
    const w = self().worldStates?.value;
    if (w === undefined) return ["FAIL", "state.self.worldStates undefined 3s after login (no SMSG_INIT_WORLD_STATES folded)"];
    const ids = Object.keys(w.states);
    const detail = `map ${w.map} zone ${w.zone} area ${w.area}, ${ids.length} state(s): ${show(Object.fromEntries(Object.entries(w.states).slice(0, 12)))}`;
    return [w.map === want.map && w.zone === want.zone ? "PASS" : "FAIL", detail];
  });
  await check("self.dungeonDifficulty", async () => {
    await until(3000, () => self().dungeonDifficulty !== undefined);
    const d = self().dungeonDifficulty?.value;
    if (d === undefined) return ["FAIL", "state.self.dungeonDifficulty undefined 3s after login (the login's MSG_SET_DUNGEON_DIFFICULTY not folded)"];
    serverDifficulty = d.id;
    const known = (d.id === DUNGEON_NORMAL && d.name === "normal") || (d.id === DUNGEON_HEROIC && d.name === "heroic");
    if (!known) return ["FAIL", show(d)];
    return d.id === DUNGEON_NORMAL ? ["PASS", show(d)] : ["PASS", `${show(d)} (an earlier run left heroic; this run sets it back)`];
  });
  await check("self.weather/raidDifficulty at login", () => {
    return ["INFO", `weather=${show(self().weather?.value)} raidDifficulty=${show(self().raidDifficulty?.value)} (both may be unobserved: no weather sent, and the raid one only when it differs)`];
  });

  // 2. Saved instances.
  await check("CMSG_REQUEST_RAID_INFO -> SMSG_RAID_INSTANCE_INFO", async () => {
    const from = lastSeq(client);
    const sent = await client.raw("CMSG_REQUEST_RAID_INFO");
    const e = await nextEvent(client, from, isOpcode("SMSG_RAID_INSTANCE_INFO"));
    if (e === undefined) return ["FAIL", `no SMSG_RAID_INSTANCE_INFO in ${REPLY_MS}ms; raw answered ${show(sent)}`];
    const locks = data(e).locks;
    const cached = self().instanceLocks?.value;
    const empty = Array.isArray(locks) && locks.length === 0 && cached !== undefined && cached.length === 0;
    return [empty ? "PASS" : "FAIL", `${show(e.data)}; state.self.instanceLocks ${show(cached)}`];
  });

  // 3. Reset instances: one answer per saved instance, so none here.
  await check("CMSG_RESET_INSTANCES with nothing saved", async () => {
    const from = lastSeq(client);
    const sent = await client.raw("CMSG_RESET_INSTANCES");
    const { heard, alive } = await silence(client, from, "SMSG_INSTANCE_RESET", "SMSG_INSTANCE_RESET_FAILED");
    if (!alive) return ["FAIL", `the session stopped answering after the reset; raw answered ${show(sent)}`];
    return ["PASS", heard === undefined ? `silent, as documented for a character with no saved instance; raw answered ${show(sent)}` : `answered: ${heard.opcode} ${show(heard.data)}`];
  });

  // 4. Refund info on an item bought with no extended cost.
  const carried = client.state.bag().items;
  log(`carrying: ${show(carried.map((i) => [i.bag, i.slot, i.name, i.count]))}`);
  const kit = carried[0];
  await check("CMSG_ITEM_REFUND_INFO on a non-refundable item", async () => {
    if (kit === undefined) return ["SKIP", "the backpack is empty; a fresh character carries its starting kit"];
    const from = lastSeq(client);
    const sent = await client.raw("CMSG_ITEM_REFUND_INFO", [{ guid: kit.guid }]);
    const { heard, alive } = await silence(client, from, "SMSG_ITEM_REFUND_INFO_RESPONSE");
    if (heard !== undefined) return ["FAIL", `${kit.name ?? kit.guid} is not refundable, yet the server answered ${heard.opcode} ${show(heard.data)}`];
    return [alive ? "PASS" : "FAIL", `silent for ${show(kit.name)} (${kit.guid}), as documented; session answers: ${alive}; raw answered ${show(sent)}`];
  });

  // 5. Repair at Godric Rothgar.
  let godric: UnitView | undefined;
  try {
    await client.waitForNearby((o) => o.entry?.value === GODRIC_ROTHGAR && o.fields.get("npcFlags") !== undefined, { timeout: 15_000 });
    godric = client.state.units({ entry: GODRIC_ROTHGAR })[0];
  } catch {
    godric = undefined;
  }
  let atGodric = false;
  await check("walk to Godric Rothgar (repair)", async () => {
    if (godric === undefined) return ["FAIL", `Godric Rothgar (${GODRIC_ROTHGAR}) not in view from the Northshire start`];
    if (!godric.roles.includes("repair")) return ["FAIL", `Godric's roles ${show(godric.roles)} lack repair`];
    if (godric.x === undefined || godric.y === undefined) return ["FAIL", `Godric has no position: ${show(godric)}`];
    const me = self().position?.value ?? fail("own position unobserved");
    const dx = me.x - godric.x;
    const dy = me.y - godric.y;
    const d = Math.max(Math.hypot(dx, dy), 0.1);
    const moved = await client.moveTo({ x: godric.x + (dx / d) * 2.5, y: godric.y + (dy / d) * 2.5, z: godric.z ?? me.z }, { timeout: 30_000 });
    const left = self().position?.value;
    const gap = left === undefined ? Number.NaN : Math.hypot(left.x - godric.x, left.y - godric.y);
    atGodric = moved.status === "arrived" && gap < 5;
    return [atGodric ? "PASS" : "FAIL", `${moved.status}, ${gap.toFixed(1)}y from Godric (roles ${show(godric.roles)})`];
  });
  const money = (): number => client.state.money?.value ?? 0;
  await check("repairAll(vendor)", async () => {
    if (godric === undefined || !atGodric) return ["SKIP", "not at Godric"];
    const before = money();
    const r = await client.repairAll(godric.guid);
    const alive = await stillAnswers(client);
    const after = money();
    return [r.ok && alive && after === before ? "PASS" : "FAIL", `${show(r)}; money ${before} -> ${after} (nothing worn is damaged, so it costs nothing); session answers: ${alive}`];
  });
  await check("repairAll(vendor, carried item)", async () => {
    if (godric === undefined || !atGodric) return ["SKIP", "not at Godric"];
    if (kit === undefined) return ["SKIP", "nothing carried to name"];
    const before = money();
    const r = await client.repairAll(godric.guid, { bag: kit.bag, slot: kit.slot });
    const alive = await stillAnswers(client);
    const after = money();
    return [
      r.ok && alive && after === before ? "PASS" : "FAIL",
      `${show(kit.name)} at bag ${kit.bag} slot ${kit.slot}: ${show(r)}; money ${before} -> ${after} (no durability to restore, so only the ack is observable); session answers: ${alive}`,
    ];
  });
  await check("repairAll(vendor, unheld item) throws, nothing sent", async () => {
    if (godric === undefined) return ["SKIP", "Godric not in view"];
    const vendor = godric.guid;
    try {
      // Resolved before the vendor lookup: a synchronous throw, which the async wrapper turns into a rejection.
      const r = await (async () => client.repairAll(vendor, "Wave Three Nonesuch"))();
      return ["FAIL", `no throw: ${show(r)}`];
    } catch (e) {
      const m = String(e instanceof Error ? e.message : e);
      return [/nothing in what you wear/.test(m) ? "PASS" : "FAIL", m];
    }
  });

  // 6. Dungeon difficulty: a solo change outside an instance is accepted silently.
  const from0 = serverDifficulty ?? DUNGEON_NORMAL;
  const target = from0 === DUNGEON_NORMAL ? DUNGEON_HEROIC : DUNGEON_NORMAL;
  let setSilently = false;
  await check(`MSG_SET_DUNGEON_DIFFICULTY ${from0} -> ${target}`, async () => {
    const from = lastSeq(client);
    const sent = await client.raw("MSG_SET_DUNGEON_DIFFICULTY", [{ u32: target }]);
    const { heard, alive } = await silence(client, from, "MSG_SET_DUNGEON_DIFFICULTY");
    if (!alive) return ["FAIL", `the session stopped answering; raw answered ${show(sent)}`];
    if (heard !== undefined) {
      if (data(heard).difficulty === target) {
        serverDifficulty = target;
        return ["PASS", `answered with the new difficulty: ${show(heard.data)}`];
      }
      return ["FAIL", `refused: the server echoed ${show(heard.data)}`];
    }
    serverDifficulty = target;
    setSilently = true;
    return ["PASS", `silent, as documented for a solo change the server accepts; state.self.dungeonDifficulty still ${show(self().dungeonDifficulty?.value)}`];
  });
  await check("the new difficulty read back after a relog", async () => {
    if (serverDifficulty !== target) return ["SKIP", "the change was not accepted"];
    await client.logout().catch(() => {});
    client.close();
    session = undefined;
    // The core saves and releases the character on its next session update; a
    // login racing that is retried rather than failed.
    for (let attempt = 0; ; attempt++) {
      await Bun.sleep(2000);
      try {
        client = await login(`relog${attempt}`);
        break;
      } catch (e) {
        if (attempt >= 2) throw e;
        log(`  relog attempt ${attempt} failed: ${String(e instanceof Error ? e.message : e)}`);
      }
    }
    session = client;
    await until(5000, () => self().dungeonDifficulty !== undefined);
    const d = self().dungeonDifficulty?.value;
    if (d === undefined) return ["FAIL", "no dungeon difficulty folded after the relog"];
    serverDifficulty = d.id;
    return [d.id === target ? "PASS" : "FAIL", `after the relog ${show(d)}, expected ${target}${setSilently ? " (the set was silent)" : ""}`];
  });

  report("SKIP", "threat lists", "need a fight; about one SMSG_THREAT_UPDATE a second per creature fighting in range");
  report("SKIP", "weather change, instance save and reset, raid difficulty", "a level-1 character in Northshire has no weather change on demand, no instance and no raid");
  report("SKIP", "socket gems, temporary enchants, refund, glyphs, buy into a bag", "the starting kit has no sockets, no temporary enchant, no extended-cost purchase and no glyph");
  report("SKIP", "dispel logs", "need a dispel cast in range");
} catch (e) {
  report("FAIL", "setup", String(e instanceof Error ? (e.stack ?? e.message) : e));
} finally {
  // The fixture is persistent: leave it at normal for the next run and the next login.
  if (session !== undefined && serverDifficulty !== undefined && serverDifficulty !== DUNGEON_NORMAL) {
    await session
      .raw("MSG_SET_DUNGEON_DIFFICULTY", [{ u32: DUNGEON_NORMAL }])
      .then(() => log("dungeon difficulty set back to normal"))
      .catch((e) => log(`could not set the dungeon difficulty back to normal: ${String(e)}`));
    await Bun.sleep(500);
  }
  await session?.logout().catch(() => {});
  session?.close();
  const count = (v: Verdict) => results.filter((r) => r.verdict === v).length;
  console.log(`totals: ${count("PASS")} pass, ${count("FAIL")} fail, ${count("SKIP")} skip, ${count("INFO")} info`);
  for (const r of results.filter((x) => x.verdict === "FAIL")) console.log(`  FAIL ${r.name}: ${r.detail}`);
  const failed = count("FAIL") > 0;
  console.log(`${failed ? "FAIL" : "PASS"}: stack-wave3 (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  if (failed) process.exitCode = 1;
}
