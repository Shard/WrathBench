/**
 * Probe for the Phase-0 quest/combat action set (PHASE-0, docs/CONTRACTS.md).
 *
 * Full arc against a booted worldserver, raw HTTP/WS only (no SDK):
 * fresh Human Paladin in Northshire -> accept "A Threat Within" (783) from
 * Deputy Willem -> walk to Marshal McBride -> gossip/quest_list -> turn in 783
 * -> accept the starter kill quest "Kobold Camp Cleanup" (7) -> walk to the
 * vineyards -> per kobold: set_target -> attack_start -> observe the
 * SMSG_ATTACKERSTATEUPDATE stream -> kill credit via SMSG_QUESTUPDATE_ADD_KILL
 * -> loot_all the corpse (loot/item-push/money events) -> repeat until
 * SMSG_QUESTUPDATE_COMPLETE -> return -> quest_complete + choose reward ->
 * SMSG_QUESTGIVER_QUEST_COMPLETE + XP (+ level-ups on the way) -> vendor_list
 * in the abbey -> logout -> POST /character-delete of the probe character.
 *
 * Run:
 *   docker compose -f infra/compose.yml exec runner bun infra/smoke/module-quest.ts
 */

const HOST = process.env.MODULE_HOST ?? "worldserver";
const PORT = process.env.MODULE_PORT ?? "8086";
const BASE = `http://${HOST}:${PORT}`;
const WS = `ws://${HOST}:${PORT}`;

// Session tokens must be at least 32 characters (POST /session rejects
// shorter ones with weak_token); randomUUID keeps them unguessable too.
const TOKEN = `probe-quest-${crypto.randomUUID()}`;
// Fresh character every run (the whole point: the arc starts at level 1 with a
// clean quest log). Deleted at the end through /character-delete, which is
// itself part of what this probe proves.
import { probeName } from "./lib/name";
import { authHeaders } from "./lib/auth";

const CHARACTER = probeName("Bq");

// Own account so the probe never fights the runner track for the default
// RUNNER account (one live session per account). Created by
// infra/bootstrap/bootstrap.ts with WRATHBENCH_ACCOUNT_USER=PROBE.
const ACCOUNT = process.env.MODULE_ACCOUNT ?? "PROBE";

const QUEST_INTRO = 783; // A Threat Within (Deputy Willem -> Marshal McBride)
const QUEST_KILL = 7;    // Kobold Camp Cleanup (kill 8 Kobold Vermin, entry 6)
const ENTRY_WILLEM = 823;
const ENTRY_MCBRIDE = 197;
const ENTRY_VERMIN = 6;
const ENTRY_VENDOR = 78; // Janos Hammerknuckle, abbey courtyard vendor

function log(msg: string) {
  console.log(`[probe] ${msg}`);
}
function fail(msg: string): never {
  console.error(`[probe] FAIL: ${msg}`);
  // Best-effort session cleanup so a failed run does not leave the account
  // blocked for the next one.
  const bail = () => process.exit(1);
  setTimeout(bail, 3000);
  fetch(`${BASE}/session`, { method: "DELETE", headers: authHeaders(), body: JSON.stringify({ token: TOKEN }) }).then(bail, bail);
  throw new Error("unreachable");
}

async function req(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...authHeaders(), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json: any = undefined;
  try {
    json = await res.json();
  } catch {}
  return { status: res.status, json };
}

async function action(name: string, fields: Record<string, unknown> = {}): Promise<any> {
  const r = await req("POST", "/action", { token: TOKEN, action: name, ...fields });
  if (r.status !== 200 || !r.json?.ok) fail(`action ${name} failed: ${r.status} ${JSON.stringify(r.json)}`);
  return r.json;
}

// ---------------------------------------------------------------- event feed
const events: any[] = [];
const startedAt = Date.now();

// Minimal client-side world model, rebuilt from the served events only.
type Vec = { x: number; y: number; z: number };
const units = new Map<string, { entry?: number; pos?: Vec; health?: number; dead?: boolean }>();
const self = { guid: "", health: 0, maxHealth: 0, level: 1, money: 0, xp: 0, pos: { x: 0, y: 0, z: 0 } as Vec };
const questLog = new Map<number, number>(); // slot -> questId
const questState = new Map<number, number>(); // slot -> state (1 = objectives complete)

function trackEvent(e: any) {
  if (e.opcode === "SMSG_UPDATE_OBJECT" && Array.isArray(e.data?.objects)) {
    for (const o of e.data.objects) {
      if (o.update === "create") {
        const u = units.get(o.guid) ?? {};
        if (o.pos) u.pos = o.pos;
        if (o.fields?.entry !== undefined) u.entry = o.fields.entry;
        if (o.fields?.health !== undefined) {
          u.health = o.fields.health;
          u.dead = o.fields.health === 0;
        }
        units.set(o.guid, u);
        if (o.self) self.guid = o.guid;
      } else if (o.update === "values") {
        const u = units.get(o.guid) ?? {};
        if (o.fields?.health !== undefined) {
          u.health = o.fields.health;
          u.dead = o.fields.health === 0;
        }
        units.set(o.guid, u);
      } else if (o.update === "movement" && o.pos) {
        const u = units.get(o.guid) ?? {};
        u.pos = o.pos;
        units.set(o.guid, u);
      } else if (o.update === "outOfRange") {
        for (const g of o.guids ?? []) units.delete(g);
      }
      // Self-only fields (money, xp, level, quest log).
      if ((o.update === "create" || o.update === "values") && o.guid === self.guid && o.fields) {
        if (o.fields.health !== undefined) self.health = o.fields.health;
        if (o.fields.maxHealth !== undefined) self.maxHealth = o.fields.maxHealth;
        if (o.fields.level !== undefined) self.level = o.fields.level;
        if (o.fields.money !== undefined) self.money = o.fields.money;
        if (o.fields.xp !== undefined) self.xp = o.fields.xp;
        for (const [k, v] of Object.entries(o.fields)) {
          const m = /^quest(\d+)Id$/.exec(k);
          if (m) questLog.set(+m[1]!, v as number);
          const ms = /^quest(\d+)State$/.exec(k);
          if (ms) questState.set(+ms[1]!, v as number);
        }
      }
    }
  } else if (e.opcode?.startsWith("MSG_MOVE_") && e.data?.guid && e.data?.pos) {
    const u = units.get(e.data.guid) ?? {};
    u.pos = e.data.pos;
    units.set(e.data.guid, u);
  } else if (e.opcode === "SMSG_MONSTER_MOVE" && e.data?.guid) {
    const u = units.get(e.data.guid) ?? {};
    u.pos = e.data.destination ?? e.data.pos;
    units.set(e.data.guid, u);
  } else if (e.opcode === "SMSG_DESTROY_OBJECT") {
    units.delete(e.data?.guid);
  } else if (e.opcode === "WB_MOVE_RESULT" || e.opcode === "WB_MOVE_PROGRESS") {
    if (e.data?.pos) self.pos = e.data.pos;
  }
}

function openEvents(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS}/events?token=${encodeURIComponent(TOKEN)}`, { headers: authHeaders() });
    ws.addEventListener("open", () => resolve(ws));
    ws.addEventListener("error", (e) => reject(new Error(`ws error: ${String(e)}`)));
    ws.addEventListener("message", (ev) => {
      try {
        const e = JSON.parse(String(ev.data));
        events.push(e);
        trackEvent(e);
      } catch {}
    });
  });
}

async function waitFor(pred: (e: any) => boolean, timeoutMs: number, what: string, from = 0): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (let i = from; i < events.length; ++i) if (pred(events[i])) return events[i];
    if (Date.now() > deadline) fail(`timed out waiting for ${what}`);
    await Bun.sleep(100);
  }
}

const dist2d = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

async function waitForQuestInLog(questId: number, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (![...questLog.values()].includes(questId)) {
    if (Date.now() > deadline) fail(`quest log never showed ${what} (${questId}); log=${JSON.stringify([...questLog])}`);
    await Bun.sleep(100);
  }
}

// move_to with midpoint fallback for too_far legs. Returns the final
// WB_MOVE_RESULT status instead of failing: callers in combat tolerate
// interruptions, waypoint callers use moveTo below.
async function tryMoveTo(target: Vec, what: string, depth = 0): Promise<string> {
  const r = await action("move_to", target);
  const res = await waitFor(
    (e) => e.opcode === "WB_MOVE_RESULT" && e.data?.moveId === r.moveId,
    120000,
    `WB_MOVE_RESULT for ${what}`,
  );
  if (res.data.status === "arrived") return "arrived";
  if (res.data.status === "too_far" && depth < 4) {
    const mid = {
      x: (self.pos.x + target.x) / 2,
      y: (self.pos.y + target.y) / 2,
      z: (self.pos.z + target.z) / 2,
    };
    log(`move to ${what}: ${res.data.status}, hopping via midpoint`);
    const midStatus = await tryMoveTo(mid, `${what} (midpoint)`, depth + 1);
    if (midStatus !== "arrived") return midStatus;
    return tryMoveTo(target, what, depth + 1);
  }
  if (res.data.status === "interrupted" && depth < 6 && self.health > 0) {
    await Bun.sleep(1000);
    return tryMoveTo(target, what, depth + 1);
  }
  return res.data.status;
}

async function moveTo(target: Vec, what: string): Promise<void> {
  const status = await tryMoveTo(target, what);
  if (status !== "arrived") fail(`move to ${what} ended ${status}`);
}

// Face a point, tolerating rejections (e.g. 409 while a move is running) the
// way a real client's continuous auto-facing shrugs them off.
async function tryFace(x: number, y: number): Promise<void> {
  await req("POST", "/action", { token: TOKEN, action: "face", x, y });
}

// Death recovery: release spirit, ghost-walk back, reclaim the corpse. Also
// exercises the repop/reclaim actions when a fight goes badly.
async function recoverFromDeath(deathPos: Vec): Promise<void> {
  log(`died at (${deathPos.x.toFixed(0)}, ${deathPos.y.toFixed(0)}); releasing spirit`);
  const mark = events.length;
  await action("repop");
  await waitFor((e) => e.opcode === "SMSG_DEATH_RELEASE_LOC", 10000, "SMSG_DEATH_RELEASE_LOC", mark);
  await Bun.sleep(2000);
  await tryMoveTo(deathPos, "corpse run");
  const reclaimEnd = Date.now() + 60000;
  while (self.health <= self.maxHealth * 0.2 && Date.now() < reclaimEnd) {
    await action("reclaim_corpse");
    await Bun.sleep(3000);
  }
  if (self.health <= self.maxHealth * 0.2) fail("corpse reclaim never resurrected the character");
  log("resurrected at corpse");
}

function findUnitByEntry(entry: number): { guid: string; pos?: Vec } | undefined {
  for (const [guid, u] of units) if (u.entry === entry && !u.dead) return { guid, pos: u.pos };
  return undefined;
}

async function waitForUnit(entry: number, timeoutMs: number, what: string): Promise<{ guid: string; pos?: Vec }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const u = findUnitByEntry(entry);
    if (u?.pos) return u;
    if (Date.now() > deadline) fail(`never saw ${what} (entry ${entry}) in update range`);
    await Bun.sleep(200);
  }
}

async function main() {
  const health = await req("GET", "/health");
  if (health.status !== 200 || !health.json?.ok) fail(`health not ok: ${JSON.stringify(health)}`);
  log(`health ok, character=${CHARACTER}`);

  const ws = await openEvents();
  await Bun.sleep(200);

  // 1. Fresh Human Paladin in Northshire.
  const session = await req("POST", "/session", { token: TOKEN, account: ACCOUNT, character: CHARACTER, race: 1, class: 2 });
  if (session.status !== 200 || !session.json?.inWorld) fail(`session failed: ${JSON.stringify(session.json)}`);
  log(`in world as ${CHARACTER} guid=${session.json.guid}`);
  const verify = await waitFor((e) => e.opcode === "SMSG_LOGIN_VERIFY_WORLD", 5000, "login verify");
  self.pos = { x: verify.data.x, y: verify.data.y, z: verify.data.z };
  await waitFor((e) => e.opcode === "SMSG_UPDATE_OBJECT" && e.data?.objects?.some((o: any) => o.self), 10000, "self create");

  // 2. Accept the intro quest from Deputy Willem (right at the spawn point).
  const willem = await waitForUnit(ENTRY_WILLEM, 10000, "Deputy Willem");
  let mark = events.length;
  await action("quest_list", { guid: willem.guid });
  const list = await waitFor(
    (e) =>
      (e.opcode === "SMSG_QUESTGIVER_QUEST_LIST" && e.data?.quests?.some((q: any) => q.questId === QUEST_INTRO)) ||
      (e.opcode === "SMSG_GOSSIP_MESSAGE" && e.data?.quests?.some((q: any) => q.questId === QUEST_INTRO)),
    5000,
    "Willem's quest list",
    mark,
  );
  log(`Willem offers: ${JSON.stringify((list.data.quests ?? []).map((q: any) => q.questId))}`);
  mark = events.length;
  await action("quest_details", { guid: willem.guid, questId: QUEST_INTRO });
  const details = await waitFor((e) => e.opcode === "SMSG_QUESTGIVER_QUEST_DETAILS" && e.data?.questId === QUEST_INTRO, 5000, "quest details", mark);
  log(`quest ${QUEST_INTRO} details: "${details.data.title}"`);
  await action("quest_accept", { guid: willem.guid, questId: QUEST_INTRO });
  await waitForQuestInLog(QUEST_INTRO, "the intro quest");
  log(`accepted quest ${QUEST_INTRO} (quest-log field observed)`);

  // 3. Walk into the abbey to Marshal McBride, gossip him, turn in 783.
  await moveTo({ x: -8902.6, y: -162.6, z: 82.0 }, "Marshal McBride");
  const mcbride = await waitForUnit(ENTRY_MCBRIDE, 10000, "Marshal McBride");
  mark = events.length;
  await action("gossip_hello", { guid: mcbride.guid });
  const greet = await waitFor(
    (e) => e.opcode === "SMSG_GOSSIP_MESSAGE" || e.opcode === "SMSG_QUESTGIVER_QUEST_LIST",
    5000,
    "McBride gossip/quest list",
    mark,
  );
  log(`McBride answered with ${greet.opcode}`);
  mark = events.length;
  await action("quest_complete", { guid: mcbride.guid, questId: QUEST_INTRO });
  await waitFor((e) => e.opcode === "SMSG_QUESTGIVER_OFFER_REWARD" && e.data?.questId === QUEST_INTRO, 5000, "offer reward 783", mark);
  await action("quest_choose_reward", { guid: mcbride.guid, questId: QUEST_INTRO, rewardIndex: 0 });
  await waitFor((e) => e.opcode === "SMSG_QUESTGIVER_QUEST_COMPLETE" && e.data?.questId === QUEST_INTRO, 5000, "quest complete 783", mark);
  log(`turned in quest ${QUEST_INTRO}`);

  // 4. Accept the kill quest from McBride.
  mark = events.length;
  // The chain may auto-offer/accept quest 7 during the 783 turn-in; if the
  // quest log does not show it yet, accept it explicitly.
  if (![...questLog.values()].includes(QUEST_KILL)) {
    await action("quest_list", { guid: mcbride.guid });
    await waitFor(
      (e) =>
        (e.opcode === "SMSG_QUESTGIVER_QUEST_LIST" || e.opcode === "SMSG_GOSSIP_MESSAGE") &&
        e.data?.quests?.some((q: any) => q.questId === QUEST_KILL),
      5000,
      "McBride offering the kill quest",
      mark,
    );
    await action("quest_accept", { guid: mcbride.guid, questId: QUEST_KILL });
  }
  await waitForQuestInLog(QUEST_KILL, "the kill quest");
  log(`kill quest ${QUEST_KILL} in the quest log`);

  // 5. Walk to the vineyards and clear kobolds until the objective completes.
  await moveTo({ x: -8790, y: -160, z: 82.5 }, "the vineyards");
  let kills = 0;
  let sawStateUpdate = false;
  let sawLoot = false;
  let sawLootReward = false;
  // Objective completion for kill quests at the pinned commit: the core sends
  // SMSG_QUESTUPDATE_COMPLETE only for exploration/event objectives; for kill
  // objectives the client learns completion from the served quest-log State
  // field (and the final ADD_KILL reaching current == required).
  const questDone = () =>
    [...questLog.entries()].some(([slot, id]) => id === QUEST_KILL && (questState.get(slot) ?? 0) & 1) ||
    events.some(
      (e) => e.opcode === "SMSG_QUESTUPDATE_ADD_KILL" && e.data?.questId === QUEST_KILL && e.data.current >= e.data.required,
    );
  const killDeadline = Date.now() + 12 * 60 * 1000;
  while (!questDone()) {
    if (Date.now() > killDeadline) fail(`kill loop exceeded 12 minutes (${kills} kills)`);

    // Rest to a safe health margin between fights.
    if (self.maxHealth > 0 && self.health / self.maxHealth < 0.5) {
      log(`resting at ${self.health}/${self.maxHealth}`);
      const restEnd = Date.now() + 90000;
      while (self.health / self.maxHealth < 0.9 && Date.now() < restEnd) await Bun.sleep(1000);
    }

    const target = await waitForUnit(ENTRY_VERMIN, 30000, "a Kobold Vermin");
    log(`engaging kobold ${target.guid} at (${target.pos!.x.toFixed(0)}, ${target.pos!.y.toFixed(0)})`);
    await tryMoveTo(target.pos!, `kobold ${target.guid}`);
    await action("set_target", { guid: target.guid });
    await tryFace(target.pos!.x, target.pos!.y); // a real client auto-faces; melee swings need it
    await action("attack_start", { guid: target.guid });

    const fightStart = events.length;
    const fightEnd = Date.now() + 60000;
    let killed = false;
    let reengageAt = Date.now() + 6000;
    let refaceAt = Date.now() + 1500;
    while (Date.now() < fightEnd) {
      if (self.maxHealth > 0 && self.health === 0) {
        const deathPos = { ...self.pos };
        await recoverFromDeath(deathPos);
        break; // pick the fight (or the rest) back up from the top
      }
      if (!sawStateUpdate && events.some((e, i) => i >= fightStart && e.opcode === "SMSG_ATTACKERSTATEUPDATE")) {
        sawStateUpdate = true;
        log("observed SMSG_ATTACKERSTATEUPDATE stream");
      }
      const u = units.get(target.guid);
      if (!u || u.dead) {
        killed = true;
        break;
      }
      // Keep facing the target between swings, as the client does continuously.
      if (u.pos && Date.now() > refaceAt) {
        refaceAt = Date.now() + 1500;
        await tryFace(u.pos.x, u.pos.y);
      }
      // The kobold may have wandered before we connected; close the gap again.
      if (Date.now() > reengageAt) {
        reengageAt = Date.now() + 6000;
        if (u.pos && dist2d(u.pos, self.pos) > 6) {
          await tryMoveTo(u.pos, "kobold (re-approach)");
          await tryFace(u.pos.x, u.pos.y);
          await action("attack_start", { guid: target.guid });
        }
      }
      await Bun.sleep(300);
    }
    if (!killed) {
      log(`kobold ${target.guid} not dead after 60s, picking another`);
      await action("attack_stop");
      continue;
    }
    kills++;
    log(`kobold down (${kills} kills)`);

    // Loot the corpse with the one-call client sequence.
    const lootMark = events.length;
    await action("loot_all", { guid: target.guid });
    const lootEvt = await waitFor(
      (e) => e.opcode === "SMSG_LOOT_RESPONSE" || e.opcode === "SMSG_LOOT_RELEASE_RESPONSE",
      10000,
      "loot response",
      lootMark,
    );
    if (lootEvt.opcode === "SMSG_LOOT_RESPONSE") {
      sawLoot = true;
      if (lootEvt.data.items?.length || lootEvt.data.gold > 0) sawLootReward = true;
      await waitFor((e) => e.opcode === "SMSG_LOOT_RELEASE_RESPONSE", 10000, "loot release", lootMark);
    }
    await Bun.sleep(500);
  }
  log(`objective COMPLETE after ${kills} kills; loot windows seen=${sawLoot} loot rewards seen=${sawLootReward}`);
  if (!sawStateUpdate) fail("never observed SMSG_ATTACKERSTATEUPDATE");
  if (!sawLoot) fail("never observed SMSG_LOOT_RESPONSE");
  const addKill = events.find((e) => e.opcode === "SMSG_QUESTUPDATE_ADD_KILL" && e.data?.questId === QUEST_KILL);
  if (!addKill) fail("never observed SMSG_QUESTUPDATE_ADD_KILL");
  log(`kill credit sample: ${JSON.stringify(addKill.data)}`);

  // 6. Return to McBride and turn in.
  await moveTo({ x: -8902.6, y: -162.6, z: 82.0 }, "Marshal McBride (return)");
  const mcbride2 = await waitForUnit(ENTRY_MCBRIDE, 10000, "Marshal McBride (return)");
  mark = events.length;
  const xpBefore = self.xp;
  const levelBefore = self.level;
  await action("quest_complete", { guid: mcbride2.guid, questId: QUEST_KILL });
  await waitFor(
    (e) => e.opcode === "SMSG_QUESTGIVER_OFFER_REWARD" && e.data?.questId === QUEST_KILL,
    5000,
    "offer reward for the kill quest",
    mark,
  );
  await action("quest_choose_reward", { guid: mcbride2.guid, questId: QUEST_KILL, rewardIndex: 0 });
  const done = await waitFor(
    (e) => e.opcode === "SMSG_QUESTGIVER_QUEST_COMPLETE" && e.data?.questId === QUEST_KILL,
    5000,
    "SMSG_QUESTGIVER_QUEST_COMPLETE",
    mark,
  );
  const xpGain = await waitFor((e) => e.opcode === "SMSG_LOG_XPGAIN", 5000, "SMSG_LOG_XPGAIN", mark);
  await Bun.sleep(1000);
  const levelUps = events.filter((e) => e.opcode === "SMSG_LEVELUP_INFO");
  log(
    `quest rewarded: xp=${done.data.xp} money=${done.data.money}; XPGAIN=${JSON.stringify(xpGain.data)}; ` +
      `level ${levelBefore}->${self.level} (levelups seen: ${levelUps.map((e) => e.data.level).join(",") || "none"}; xp field ${xpBefore}->${self.xp})`,
  );

  // 7. Vendor list in the abbey courtyard.
  await moveTo({ x: -8909.5, y: -104.2, z: 82.0 }, "Janos Hammerknuckle");
  const vendor = await waitForUnit(ENTRY_VENDOR, 10000, "the vendor");
  mark = events.length;
  await action("vendor_list", { guid: vendor.guid });
  const inv = await waitFor((e) => e.opcode === "SMSG_LIST_INVENTORY", 5000, "vendor inventory", mark);
  if (!inv.data.items?.length) fail(`vendor inventory empty: ${JSON.stringify(inv.data)}`);
  log(`vendor list: ${inv.data.items.length} items, first=${JSON.stringify(inv.data.items[0])}`);

  // 8. Logout, then delete the probe character through the real CMSG_CHAR_DELETE path.
  const del = await req("DELETE", "/session", { token: TOKEN });
  if (del.status !== 200) fail(`session delete failed: ${JSON.stringify(del.json)}`);
  log("logged out");
  let deleted: any = null;
  for (let attempt = 0; attempt < 5 && !deleted?.json?.deleted; ++attempt) {
    await Bun.sleep(2000);
    deleted = await req("POST", "/character-delete", { token: `${TOKEN}-del${attempt}`, account: ACCOUNT, character: CHARACTER });
    if (!deleted.json?.deleted) log(`character-delete attempt ${attempt}: ${deleted.status} ${JSON.stringify(deleted.json)}`);
  }
  if (!deleted?.json?.deleted) fail(`character-delete never succeeded`);
  log(`character ${CHARACTER} deleted: ${JSON.stringify(deleted.json)}`);

  ws.close();

  // Firehose accounting.
  const secs = (Date.now() - startedAt) / 1000;
  const byOpcode = new Map<string, number>();
  for (const e of events) byOpcode.set(e.opcode, (byOpcode.get(e.opcode) ?? 0) + 1);
  const top = [...byOpcode.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const finalHealth = await req("GET", "/health");
  log(
    `stats: ${events.length} events in ${secs.toFixed(1)}s (${(events.length / secs).toFixed(1)}/s); ` +
      `top opcodes: ${top.map(([k, v]) => `${k}=${v}`).join(" ")}; health=${JSON.stringify(finalHealth.json)}`,
  );

  log("PASS: quest arc end to end — accept -> gossip -> kill credit -> loot -> complete -> reward+XP -> vendor -> char delete");
  process.exit(0);
}

main().catch((e) => fail(String(e?.stack ?? e)));
