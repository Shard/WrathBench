/**
 * Census of the stack's in-game wave 1 (wrath-mcp issue 4, its CHANGELOG's
 * quest areas, class resources, unit and own state, dismount, open items, item
 * and ground casts): the readings and the few actions a client has that the
 * SDK gained in one go. One persistent Human Rogue (`Ob` + the account's
 * letters, e.g. `Obsmokee` on SMOKE4, never deleted: a throwaway's create and
 * delete cost two minutes of logout linger) at the Northshire vineyard edge,
 * Kobold Vermin in view and Kobold Camp Cleanup (7) in the log
 * (`vineyard-kill-credit`), is enough to see most of them on the live server.
 *
 * It is a census, not a gate: every check prints PASS, FAIL or SKIP with the
 * status, hint or event that decided it, and the smoke carries on to the next;
 * only a setup failure (no login, no kobold) stops it. It exits 1 on any FAIL.
 * A zero update field is never sent in a create block, so a reading that is
 * legitimately 0 at login (rested XP on a new character, the stand state of
 * one standing) is reported as INFO, and the flags are asserted only after
 * the action that makes them non-zero.
 *
 *   1. Self at login: `stats`, `proficiency`, `mounted` and `inCombat` false,
 *      the glyph slots on `talents()`; `restedXp`, `standState` and
 *      `shapeshiftForm` as INFO.
 *   2. The reply taps: raw CMSG_PLAYED_TIME -> SMSG_PLAYED_TIME, raw
 *      CMSG_QUERY_TIME -> SMSG_QUERY_TIME_RESPONSE, raw CMSG_NPC_TEXT_QUERY ->
 *      SMSG_NPC_TEXT_UPDATE; CMSG_TAXINODE_STATUS_QUERY at a non-flight-master
 *      as INFO (no flight master stands here).
 *   3. `questAreas(7)`, `questAreas()` and `state.questPois`; `questAreas(783)`
 *      (rewarded, not in the log) -> `not_in_log`.
 *   4. `dismount()` on foot -> `not_mounted`, and `raw` never called.
 *   5. Sit and stand by raw CMSG_STANDSTATECHANGE: `self.sitting` and
 *      `standState` follow.
 *   6. Cast targets: a `targetPoint` without z throws with nothing sent; a
 *      point with z and a `targetItem` (the worn main hand) each draw a cast
 *      verdict from the server, and the session still answers afterwards.
 *   7. Combat: Sinister Strike on a kobold -> its row `inCombat`, `tapped`,
 *      `tappedByYou`; `self.inCombat`; `self.comboPoints` on it; after the
 *      kill, `lootable` on the corpse (INFO when it dropped nothing).
 *   SKIPPED, by design: `useItem` on a lootable container (fixtures write no
 *   items, and the stager's `.additem` is not a smoke's path); runes, totems,
 *   channels and mirror timers (other classes, water); mounted dismount.
 *
 * Standalone, not in the suite: a wandering kobold is not deterministic
 * enough for a regression gate.
 *
 *   bun wb smoke stack-observation      # once the runner image carries it
 */

import { connect, type StreamEvent, type UnitView, type WrathClient } from "@wrathbench/sdk";
import { accountFixtureName, applyScenario, ensureFixtureCharacter, type FixtureContext } from "./lib/fixture";
import { authHeaders, MODULE_SECRET } from "./lib/auth";
import { moduleBase } from "./lib/module";
import { smokeSubToken, smokeToken } from "./lib/session";

const BASE = moduleBase();
const ACCOUNT = process.env.MODULE_ACCOUNT ?? "PROBE";
const TOKEN = smokeToken("stack-observation");
const CHARACTER = process.env.SMOKE_CHARACTER ?? accountFixtureName("Ob", ACCOUNT);
const SCENARIO = "vineyard-kill-credit";
const RACE_HUMAN = 1;
const CLASS_ROGUE = 4;
const KOBOLD_VERMIN = 6;
const KOBOLD_CAMP_CLEANUP = 7;
const A_THREAT_WITHIN = 783; // rewarded by the scenario, so never in the log
const SINISTER_STRIKE = 1752;
const MAIN_HAND = { bag: 255, slot: 15 };
const REPLY_MS = 5_000;

const started = Date.now();
const log = (m: string) => console.log(`[stack-observation +${((Date.now() - started) / 1000).toFixed(1).padStart(5)}s] ${m}`);
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

const lastSeq = (client: WrathClient): number => client.events.recent(1)[0]?.seq ?? -1;

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

const data = (e: StreamEvent | undefined): Record<string, unknown> => (e?.data ?? {}) as Record<string, unknown>;
const CAST_VERDICTS = ["SMSG_SPELL_START", "SMSG_SPELL_GO", "SMSG_CAST_FAILED", "SMSG_SPELL_FAILURE"];
const castVerdict = (spellId: number) => (e: StreamEvent) => CAST_VERDICTS.includes(e.opcode) && data(e).spellId === spellId;

/** The session still answers: a raw CMSG_QUERY_TIME gets its reply. */
async function stillAnswers(client: WrathClient): Promise<boolean> {
  const from = lastSeq(client);
  await client.raw("CMSG_QUERY_TIME");
  return (await nextEvent(client, from, (e) => e.opcode === "SMSG_QUERY_TIME_RESPONSE")) !== undefined;
}

function vermin(client: WrathClient): UnitView[] {
  return client.state.units({ entry: KOBOLD_VERMIN, alive: true }).filter((u) => u.x !== undefined && u.y !== undefined);
}
const row = (client: WrathClient, guid: string): UnitView | undefined => client.state.units({ entry: KOBOLD_VERMIN }).find((u) => u.guid === guid);
const flags = (u: UnitView | undefined) =>
  u === undefined
    ? "gone"
    : show({ inCombat: u.inCombat, stunned: u.stunned, skinnable: u.skinnable, lootable: u.lootable, tapped: u.tapped, tappedByYou: u.tappedByYou, sitting: u.sitting, shapeshiftForm: u.shapeshiftForm, dead: u.dead });

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
      await c.createSession({ account: ACCOUNT, character: CHARACTER, race: RACE_HUMAN, class: CLASS_ROGUE });
      await c.logout();
    } finally {
      c.close();
    }
  },
};

let session: WrathClient | undefined;
try {
  const health = await fetch(`${BASE}/health`, { headers: authHeaders() }).then((r) => r.json() as Promise<any>);
  if (!health?.ok) fail(`health not ok: ${show(health)}`);
  log(`health ok: build=${health.build ?? "?"}, character=${CHARACTER} on ${ACCOUNT}`);
  await ensureFixtureCharacter(fixtureCtx);
  await applyScenario(fixtureCtx, SCENARIO);

  const client = await connect({ baseUrl: BASE, token: TOKEN, secret: MODULE_SECRET });
  session = client;
  await client.createSession({ account: ACCOUNT, character: CHARACTER, race: RACE_HUMAN, class: CLASS_ROGUE });
  log(`in world as ${CHARACTER}, guid ${client.state.self.guid}`);
  await client.waitForNearby((o) => o.entry?.value === KOBOLD_VERMIN, { timeout: 15_000 });
  await Bun.sleep(1500); // the rest of the login burst: create blocks, proficiency, talents
  const self = () => client.state.self;

  // 1. Self at login.
  await check("self.stats", async () => {
    await until(3000, () => self().stats !== undefined);
    const s = self().stats?.value;
    if (s === undefined) return ["FAIL", "state.self.stats undefined 3s after login"];
    const core = [s.strength, s.agility, s.stamina, s.intellect, s.spirit, s.armor];
    return core.every((n) => typeof n === "number") ? ["PASS", show(s)] : ["FAIL", `a core stat is unobserved: ${show(s)}`];
  });
  await check("self.proficiency", () => {
    const p = self().proficiency?.value;
    if (p === undefined) return ["FAIL", "state.self.proficiency undefined (no SMSG_SET_PROFICIENCY folded)"];
    const ok = typeof p.weaponMask === "number" && typeof p.armorMask === "number" && p.weaponMask !== 0 && p.armorMask !== 0;
    return [ok ? "PASS" : "FAIL", `weaponMask=0x${p.weaponMask?.toString(16)} armorMask=0x${p.armorMask?.toString(16)}`];
  });
  await check("self.mounted/inCombat at login", () => {
    const m = self().mounted?.value;
    const c = self().inCombat?.value;
    return [m === false && c === false ? "PASS" : "FAIL", `mounted=${m} inCombat=${c} stunned=${self().stunned?.value}`];
  });
  await check("talents().glyphs", () => {
    const g = client.state.talents()?.glyphs;
    return [Array.isArray(g) ? "PASS" : "FAIL", `glyphs=${show(g)}`];
  });
  await check("self.restedXp", () => {
    const r = self().restedXp;
    return r === undefined ? ["INFO", "unobserved: the field is 0 on a minutes-old character, and a zero field is not sent"] : ["PASS", `restedXp=${r.value}`];
  });
  await check("self.standState/shapeshiftForm at login", () => {
    return ["INFO", `standState=${show(self().standState?.value)} sitting=${self().sitting?.value} shapeshiftForm=${show(self().shapeshiftForm?.value)}`];
  });
  await check("self class resources at login", () => {
    return ["INFO", `comboPoints=${show(self().comboPoints?.value)} runes=${show(self().runes?.value)} totems=${self().totems.length} mirrorTimers=${self().mirrorTimers.length} channeling=${show(self().channeling?.value)}`];
  });
  await check("units() rows before combat", () => {
    const rows = client.state.units({ entry: KOBOLD_VERMIN }).slice(0, 3);
    if (rows.length === 0) return ["FAIL", "no Kobold Vermin rows"];
    const keys = ["inCombat", "stunned", "skinnable", "lootable", "tapped", "tappedByYou", "sitting", "shapeshiftForm"];
    const missing = keys.filter((k) => !(k in rows[0]!));
    if (missing.length > 0) return ["FAIL", `rows lack ${missing.join(", ")}: ${show(rows[0])}`];
    return ["INFO", rows.map((u) => `${u.guid}@${u.distance?.toFixed(1)}y ${flags(u)}`).join(" | ")];
  });

  // 2. Reply taps.
  await check("CMSG_PLAYED_TIME -> SMSG_PLAYED_TIME", async () => {
    const from = lastSeq(client);
    const sent = await client.raw("CMSG_PLAYED_TIME", [{ u8: 1 }]);
    const e = await nextEvent(client, from, (x) => x.opcode === "SMSG_PLAYED_TIME");
    if (e === undefined) return ["FAIL", `no SMSG_PLAYED_TIME in ${REPLY_MS}ms; raw answered ${show(sent)}`];
    return [typeof data(e).totalSec === "number" ? "PASS" : "FAIL", show(e.data)];
  });
  await check("CMSG_QUERY_TIME -> SMSG_QUERY_TIME_RESPONSE", async () => {
    const from = lastSeq(client);
    const sent = await client.raw("CMSG_QUERY_TIME");
    const e = await nextEvent(client, from, (x) => x.opcode === "SMSG_QUERY_TIME_RESPONSE");
    if (e === undefined) return ["FAIL", `no SMSG_QUERY_TIME_RESPONSE in ${REPLY_MS}ms; raw answered ${show(sent)}`];
    const skew = Math.abs(Number(data(e).serverTime) - Date.now() / 1000);
    return [skew < 300 ? "PASS" : "FAIL", `${show(e.data)} (clock skew ${skew.toFixed(0)}s)`];
  });
  await check("CMSG_NPC_TEXT_QUERY -> SMSG_NPC_TEXT_UPDATE", async () => {
    const npc = vermin(client)[0] ?? fail("no kobold to name as the npc");
    const from = lastSeq(client);
    const sent = await client.raw("CMSG_NPC_TEXT_QUERY", [{ u32: 1 }, { guid: npc.guid }]);
    const e = await nextEvent(client, from, (x) => x.opcode === "SMSG_NPC_TEXT_UPDATE");
    if (e === undefined) return ["FAIL", `no SMSG_NPC_TEXT_UPDATE in ${REPLY_MS}ms; raw answered ${show(sent)}`];
    return [Array.isArray(data(e).texts) ? "PASS" : "FAIL", show(e.data).slice(0, 200)];
  });
  await check("CMSG_TAXINODE_STATUS_QUERY at a non-flight-master", async () => {
    const npc = vermin(client)[0] ?? fail("no kobold to ask about");
    const from = lastSeq(client);
    const sent = await client.raw("CMSG_TAXINODE_STATUS_QUERY", [{ guid: npc.guid }]);
    const e = await nextEvent(client, from, (x) => x.opcode === "SMSG_TAXINODE_STATUS", 2000);
    return e === undefined ? ["INFO", `no reply (no flight master in view to ask about); raw answered ${show(sent)}`] : ["PASS", show(e.data)];
  });

  // 3. Quest objective areas.
  await check(`questAreas(${KOBOLD_CAMP_CLEANUP})`, async () => {
    if (!client.state.questLog.some((q) => q.questId === KOBOLD_CAMP_CLEANUP)) return ["FAIL", `quest ${KOBOLD_CAMP_CLEANUP} not in the log: ${show(client.state.questLog.map((q) => q.questId))}`];
    const r = await client.questAreas(KOBOLD_CAMP_CLEANUP);
    if (!r.ok) return ["FAIL", `${r.status}: ${r.hint}`];
    const q = r.quests[0];
    const cached = client.state.questPois.get(KOBOLD_CAMP_CLEANUP);
    const detail = `${q?.title}: ${q?.pois.length} area(s) ${show(q?.pois.map((p) => ({ objectiveIndex: p.objectiveIndex, map: p.map, points: p.points.length })))}; state.questPois ${cached === undefined ? "missing" : `${cached.value.length} area(s)`}`;
    return [q?.questId === KOBOLD_CAMP_CLEANUP && (q.pois.length === 0 || cached !== undefined) ? "PASS" : "FAIL", detail];
  });
  await check("questAreas() for the whole log", async () => {
    const r = await client.questAreas();
    if (!r.ok) return ["FAIL", `${r.status}: ${r.hint}`];
    return ["PASS", r.quests.map((q) => `${q.questId}:${q.pois.length}`).join(", ")];
  });
  await check(`questAreas(${A_THREAT_WITHIN}) not in the log`, async () => {
    const r = await client.questAreas(A_THREAT_WITHIN);
    return [!r.ok && r.status === "not_in_log" ? "PASS" : "FAIL", show(r)];
  });

  // 4. dismount() on foot: answered from the cache, nothing sent.
  await check("dismount() on foot", async () => {
    if (self().mounted === undefined) return ["FAIL", "state.self.mounted is unobserved: dismount() would send"];
    const original = client.raw.bind(client);
    let sends = 0;
    client.raw = ((...args: Parameters<WrathClient["raw"]>) => {
      sends++;
      return original(...args);
    }) as WrathClient["raw"];
    try {
      const r = await client.dismount();
      const ok = !r.ok && r.status === "not_mounted" && sends === 0;
      return [ok ? "PASS" : "FAIL", `${show(r)}; raw sends during the call: ${sends}`];
    } finally {
      client.raw = original;
    }
  });

  // 5. Sit and stand.
  await check("sit (raw CMSG_STANDSTATECHANGE 1)", async () => {
    const r = await client.raw("CMSG_STANDSTATECHANGE", [{ u32: 1 }]);
    const sat = await until(3000, () => self().sitting?.value === true);
    return [sat ? "PASS" : "FAIL", `raw ${show(r)}; sitting=${self().sitting?.value} standState=${show(self().standState?.value)}`];
  });
  await check("stand (raw CMSG_STANDSTATECHANGE 0)", async () => {
    const r = await client.raw("CMSG_STANDSTATECHANGE", [{ u32: 0 }]);
    const up = await until(3000, () => self().sitting?.value === false);
    return [up ? "PASS" : "FAIL", `raw ${show(r)}; sitting=${self().sitting?.value} standState=${show(self().standState?.value)}`];
  });

  // 6. Cast targets.
  const spell = client.state.spell(SINISTER_STRIKE) === undefined ? undefined : SINISTER_STRIKE;
  const here = self().position?.value;
  await check("castSpell targetPoint without z", async () => {
    if (spell === undefined || here === undefined) return ["SKIP", `Sinister Strike not in the book or no position (book: ${client.state.spells().length})`];
    const from = lastSeq(client);
    try {
      await client.castSpell(spell, undefined, { targetPoint: { x: here.x, y: here.y } as unknown as { x: number; y: number; z: number } });
      return ["FAIL", "castSpell accepted a point without z"];
    } catch (e) {
      const msg = String(e instanceof Error ? e.message : e);
      const sentNothing = (await nextEvent(client, from, castVerdict(spell), 1000)) === undefined;
      return [/z/.test(msg) && sentNothing ? "PASS" : "FAIL", `threw: ${msg}; no cast verdict after: ${sentNothing}`];
    }
  });
  await check("castSpell targetPoint {x,y,z}: a verdict, the session alive", async () => {
    if (spell === undefined || here === undefined) return ["SKIP", "no spell or position"];
    const from = lastSeq(client);
    const ack = await client.castSpell(spell, undefined, { targetPoint: { x: here.x + 2, y: here.y, z: here.z } });
    const v = await nextEvent(client, from, castVerdict(spell));
    const alive = await stillAnswers(client);
    return [v !== undefined && alive ? "PASS" : "FAIL", `ack ${show(ack)}; verdict ${v === undefined ? "none" : `${v.opcode} ${show(v.data)}`}; session answers: ${alive}`];
  });
  await Bun.sleep(1600);
  await check("castSpell targetItem (worn main hand): a verdict, the session alive", async () => {
    if (spell === undefined) return ["SKIP", "no spell"];
    const weapon = client.state.inventory.find((i) => i.slot === MAIN_HAND.slot);
    const from = lastSeq(client);
    const ack = await client.castSpell(spell, undefined, { targetItem: MAIN_HAND });
    const v = await nextEvent(client, from, castVerdict(spell));
    const alive = await stillAnswers(client);
    return [v !== undefined && alive ? "PASS" : "FAIL", `weapon ${weapon?.guid ?? "?"}; ack ${show(ack)}; verdict ${v === undefined ? "none" : `${v.opcode} ${show(v.data)}`}; session answers: ${alive}`];
  });

  // 7. Combat.
  const me = self().position?.value ?? fail("own position unobserved");
  const target = vermin(client).sort((a, b) => (a.distance ?? 99) - (b.distance ?? 99))[0] ?? fail("no live Kobold Vermin in view");
  log(`combat: kobold ${target.guid} at ${target.distance?.toFixed(1)}y ${flags(target)}`);
  const dx = me.x - target.x!;
  const dy = me.y - target.y!;
  const d = Math.max(Math.hypot(dx, dy), 0.1);
  const moved = await client.moveTo({ x: target.x! + (dx / d) * 2.5, y: target.y! + (dy / d) * 2.5, z: target.z ?? me.z }, { timeout: 20_000 });
  log(`moveTo the kobold: ${moved.ok ? "ok" : show(moved)}`);
  await client.setTarget(target.guid);
  await client.attackStart(target.guid);
  const fightBy = Date.now() + 30_000;
  let lastStrike = 0;
  let seenRow = { inCombat: false, tapped: false, tappedByYou: false };
  let selfInCombat = false;
  let combo: unknown;
  while (Date.now() < fightBy) {
    const u = row(client, target.guid);
    if (u === undefined || u.dead === true) break;
    if (u.inCombat === true) seenRow.inCombat = true;
    if (u.tapped === true) seenRow.tapped = true;
    if (u.tappedByYou === true) seenRow.tappedByYou = true;
    if (self().inCombat?.value === true) selfInCombat = true;
    const cp = self().comboPoints?.value;
    if (cp !== undefined && cp.points > 0) combo = cp;
    if (Date.now() - lastStrike > 1600 && spell !== undefined) {
      lastStrike = Date.now();
      await client.castSpell(spell, target.guid).catch((e) => log(`  castSpell: ${String(e)}`));
    }
    await Bun.sleep(100);
  }
  const after = row(client, target.guid);
  log(`after the fight: ${flags(after)}`);
  await check("units() row inCombat/tapped/tappedByYou while fought", () => {
    const ok = seenRow.inCombat && seenRow.tapped && seenRow.tappedByYou;
    return [ok ? "PASS" : "FAIL", `seen during the fight: ${show(seenRow)}`];
  });
  await check("self.inCombat while fighting", () => [selfInCombat ? "PASS" : "FAIL", `self.inCombat seen true: ${selfInCombat}`]);
  await check("self.comboPoints from Sinister Strike", () => {
    if (spell === undefined) return ["SKIP", "no Sinister Strike"];
    return [combo !== undefined ? "PASS" : "FAIL", `comboPoints ${show(combo)} (kobold ${target.guid})`];
  });
  await check("corpse lootable", async () => {
    if (after === undefined || after.dead !== true) return ["SKIP", `the kobold did not die within the fight window: ${flags(after)}`];
    await until(2000, () => row(client, target.guid)?.lootable === true);
    const c = row(client, target.guid);
    if (c?.lootable === true) return ["PASS", flags(c)];
    return [c?.lootable === false ? "INFO" : "FAIL", `lootable=${c?.lootable} (false is right when it dropped nothing) ${flags(c)}`];
  });

  report("SKIP", "useItem on a lootable container", "fixtures write no items and no smoke path seeds one (the stager's .additem is the party's)");
  report("SKIP", "dismount() while mounted", "a level-1 character has no mount");
  report("SKIP", "runes, totems, channeling, mirror timers, ammo", "other classes, or water; this smoke's character is a level-1 rogue on land");
} catch (e) {
  report("FAIL", "setup", String(e instanceof Error ? (e.stack ?? e.message) : e));
} finally {
  await session?.attackStop().catch(() => {});
  await session?.logout().catch(() => {});
  session?.close();
  const count = (v: Verdict) => results.filter((r) => r.verdict === v).length;
  console.log(`totals: ${count("PASS")} pass, ${count("FAIL")} fail, ${count("SKIP")} skip, ${count("INFO")} info`);
  for (const r of results.filter((x) => x.verdict === "FAIL")) console.log(`  FAIL ${r.name}: ${r.detail}`);
  const failed = count("FAIL") > 0;
  console.log(`${failed ? "FAIL" : "PASS"}: stack-observation (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  if (failed) process.exitCode = 1;
}
