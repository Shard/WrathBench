/**
 * Fast-gate smoke B (ADR-0023 amendment, 2026-08-23): combat, kill credit and
 * loot, with exactly ONE kill. Runs on its own account in parallel with
 * quest-accept-status.ts; together they are the per-tick preflight gate. The
 * deploy-time full arc (eight kills to objective completion and the kill
 * quest's own turn-in) stays module-quest.ts.
 *
 * Raw HTTP/WS only (no SDK). Arc — fresh Human Paladin in Northshire:
 *   1. login; accept "A Threat Within" (783) from Deputy Willem at the spawn;
 *   2. walk to Marshal McBride, turn 783 in (quest_complete ->
 *      SMSG_QUESTGIVER_OFFER_REWARD -> quest_choose_reward ->
 *      SMSG_QUESTGIVER_QUEST_COMPLETE), take "Kobold Camp Cleanup" (7) — the
 *      kill quest is gated on 783, so this leg is the price of a kill credit;
 *   3. walk to the near edge of the vineyard, engage the nearest Kobold
 *      Vermin: set_target -> face -> attack_start -> the
 *      SMSG_ATTACKERSTATEUPDATE stream -> the kobold's health reaches 0 ->
 *      SMSG_QUESTUPDATE_ADD_KILL { questId 7, entry 6, current 1 } and a
 *      fromKill SMSG_LOG_XPGAIN;
 *   4. loot_all the corpse -> SMSG_LOOT_RESPONSE -> SMSG_LOOT_RELEASE_RESPONSE;
 *   5. logout. Step 0, before any of this: POST /character-delete of LAST
 *      run's character (the real CMSG_CHAR_DELETE path) — see CHARACTER below
 *      for why the delete is first, not last.
 *
 * Fail fast, never "pick another": the one fight has a hard cap of 1.5x the
 * longest fight observed (25.9s, 2026-08-23 logs), a death is a failure, and
 * so is a kobold that never comes into view. The gate re-runs every tick while
 * it fails; a slow failure is the expensive kind.
 *
 * Run:
 *   docker compose -f infra/compose.yml exec runner bun infra/smoke/kill-credit.ts
 */

const HOST = process.env.MODULE_HOST ?? "worldserver";
const PORT = process.env.MODULE_PORT ?? "8086";
const BASE = `http://${HOST}:${PORT}`;
const WS = `ws://${HOST}:${PORT}`;

const TOKEN = `probe-killcredit-${crypto.randomUUID()}`;
// Fixed name, deleted at the START of every run and only logged out at the
// end: a character that merely disconnects stays in world for the core's
// 60s WorldSession::expireTime, during which CMSG_CHAR_DELETE is silently
// ignored (measured 2026-08-23: 66s from logout to a successful delete), and
// a real client's clean exit (CMSG_LOGOUT_REQUEST) is not on the raw
// allowlist. Deleting last run's character first proves the same
// CMSG_CHAR_DELETE path with no wait, because by the next tick the linger is
// long over. One name per script, so the leftover is always exactly one.
const CHARACTER = "Smokekc";
const ACCOUNT = process.env.MODULE_ACCOUNT ?? "PROBE";

const QUEST_INTRO = 783; // A Threat Within (Deputy Willem -> Marshal McBride)
const QUEST_KILL = 7; // Kobold Camp Cleanup (kill 8 Kobold Vermin, entry 6)
const ENTRY_WILLEM = 823;
const ENTRY_MCBRIDE = 197;
const ENTRY_VERMIN = 6;

const MCBRIDE_POS = { x: -8902.6, y: -162.6, z: 82.0 };
// The vineyard's near edge, module-quest.ts's proven target: the closest
// Kobold Vermin spawns to the abbey (creature rows at x -8783..-8795,
// y -134..-171) are within view from here. A point 15y nearer the abbey wall
// (-8805,-158) was path_incomplete on the mesh.
const VINEYARD_EDGE = { x: -8790, y: -160, z: 82.5 };

// Observed maxima (2026-08-23 logs): McBride walk 9.5s, abbey->vineyard walk
// 21.9s, fights 11.6-25.9s.
const WALK_TIMEOUT_MS = 30000;
const FIGHT_TIMEOUT_MS = 40000;
const REPLY_TIMEOUT_MS = 3000;

function log(msg: string) {
  console.log(`[killcredit] ${msg}`);
}
function fail(msg: string): never {
  console.error(`[killcredit] FAIL: ${msg}`);
  const bail = () => process.exit(1);
  setTimeout(bail, 3000);
  fetch(`${BASE}/session`, { method: "DELETE", body: JSON.stringify({ token: TOKEN }) }).then(bail, bail);
  throw new Error("unreachable");
}

async function req(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
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

type Vec = { x: number; y: number; z: number };
const units = new Map<string, { entry?: number; pos?: Vec; health?: number; dead?: boolean }>();
const self = { guid: "", health: 0, maxHealth: 0, pos: { x: 0, y: 0, z: 0 } as Vec };
const questLog = new Map<number, number>(); // slot -> questId

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
      if ((o.update === "create" || o.update === "values") && o.guid === self.guid && o.fields) {
        if (o.fields.health !== undefined) self.health = o.fields.health;
        if (o.fields.maxHealth !== undefined) self.maxHealth = o.fields.maxHealth;
        for (const [k, v] of Object.entries(o.fields)) {
          const m = /^quest(\d+)Id$/.exec(k);
          if (m) questLog.set(+m[1], v as number);
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
    const ws = new WebSocket(`${WS}/events?token=${encodeURIComponent(TOKEN)}`);
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
  const deadline = Date.now() + REPLY_TIMEOUT_MS;
  while (![...questLog.values()].includes(questId)) {
    if (Date.now() > deadline) fail(`quest log never showed ${what} (${questId}); log=${JSON.stringify([...questLog])}`);
    await Bun.sleep(100);
  }
}

function findUnitByEntry(entry: number): { guid: string; pos?: Vec } | undefined {
  for (const [guid, u] of units) if (u.entry === entry && !u.dead) return { guid, pos: u.pos };
  return undefined;
}

/** The nearest live unit of an entry with a known position, or undefined. */
function nearestUnitByEntry(entry: number): { guid: string; pos: Vec } | undefined {
  let best: { guid: string; pos: Vec } | undefined;
  for (const [guid, u] of units) {
    if (u.entry !== entry || u.dead || !u.pos) continue;
    if (!best || dist2d(u.pos, self.pos) < dist2d(best.pos, self.pos)) best = { guid, pos: u.pos };
  }
  return best;
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

// One move_to, one verdict, except that a leg interrupted by an aggroing
// kobold (the vineyard edge is their patrol) is resumed once. Anything else
// is a fault, not a detour.
async function moveTo(target: Vec, what: string, resumed = false): Promise<void> {
  const r = await action("move_to", target);
  const res = await waitFor(
    (e) => e.opcode === "WB_MOVE_RESULT" && e.data?.moveId === r.moveId,
    WALK_TIMEOUT_MS,
    `WB_MOVE_RESULT for ${what}`,
  );
  if (res.data.status === "arrived") return;
  if (res.data.status === "interrupted" && !resumed && self.health > 0) {
    log(`move to ${what}: interrupted, resuming once`);
    await Bun.sleep(500);
    return moveTo(target, what, true);
  }
  fail(`move to ${what} ended ${res.data.status}`);
}

// Face a point, tolerating rejections (e.g. 409 while a move is running) the
// way a real client's continuous auto-facing shrugs them off.
async function tryFace(x: number, y: number): Promise<void> {
  await req("POST", "/action", { token: TOKEN, action: "face", x, y });
}

async function deletePreviousCharacter(): Promise<void> {
  for (let attempt = 0; attempt < 4; ++attempt) {
    const r = await req("POST", "/character-delete", { token: `${TOKEN}-del${attempt}`, account: ACCOUNT, character: CHARACTER });
    if (r.json?.deleted === true) {
      log(`deleted last run's ${CHARACTER}: ${JSON.stringify(r.json)}`);
      return;
    }
    if (r.status === 502 && r.json?.error === "character_not_found") {
      log(`no previous ${CHARACTER} to delete (first run on this realm)`);
      return;
    }
    log(`character-delete attempt ${attempt}: ${r.status} ${JSON.stringify(r.json)}`);
    if (r.status !== 504) break;
    await Bun.sleep(2000);
  }
  fail(`could not delete last run's ${CHARACTER}`);
}

async function main() {
  const health = await req("GET", "/health");
  if (health.status !== 200 || !health.json?.ok) fail(`health not ok: ${JSON.stringify(health)}`);
  log(`health ok, character=${CHARACTER}`);

  // 0. Delete last run's character through the real CMSG_CHAR_DELETE path.
  //    `character_not_found` is the first run on a fresh realm (nothing to
  //    delete yet). A 504 is the previous character still inside the core's
  //    post-disconnect linger — only possible when the gate is retrying within
  //    a minute of a failure — and is retried past that window.
  await deletePreviousCharacter();

  const ws = await openEvents();
  await Bun.sleep(200);

  // 1. Fresh Human Paladin in Northshire; accept 783 at the spawn.
  const session = await req("POST", "/session", { token: TOKEN, account: ACCOUNT, character: CHARACTER, race: 1, class: 2 });
  if (session.status !== 200 || !session.json?.inWorld) fail(`session failed: ${JSON.stringify(session.json)}`);
  log(`in world as ${CHARACTER} guid=${session.json.guid}`);
  const verify = await waitFor((e) => e.opcode === "SMSG_LOGIN_VERIFY_WORLD", 5000, "login verify");
  self.pos = { x: verify.data.x, y: verify.data.y, z: verify.data.z };
  await waitFor((e) => e.opcode === "SMSG_UPDATE_OBJECT" && e.data?.objects?.some((o: any) => o.self), 10000, "self create");
  const willem = await waitForUnit(ENTRY_WILLEM, 10000, "Deputy Willem");
  let mark = events.length;
  await action("quest_list", { guid: willem.guid });
  await waitFor(
    (e) =>
      (e.opcode === "SMSG_QUESTGIVER_QUEST_LIST" || e.opcode === "SMSG_GOSSIP_MESSAGE") &&
      e.data?.quests?.some((q: any) => q.questId === QUEST_INTRO),
    REPLY_TIMEOUT_MS,
    "Willem's quest list",
    mark,
  );
  await action("quest_accept", { guid: willem.guid, questId: QUEST_INTRO });
  await waitForQuestInLog(QUEST_INTRO, "the intro quest");
  log(`accepted quest ${QUEST_INTRO}`);

  // 2. Turn 783 in at McBride; take the kill quest.
  await moveTo(MCBRIDE_POS, "Marshal McBride");
  const mcbride = await waitForUnit(ENTRY_MCBRIDE, 5000, "Marshal McBride");
  mark = events.length;
  await action("quest_complete", { guid: mcbride.guid, questId: QUEST_INTRO });
  await waitFor((e) => e.opcode === "SMSG_QUESTGIVER_OFFER_REWARD" && e.data?.questId === QUEST_INTRO, REPLY_TIMEOUT_MS, "offer reward 783", mark);
  await action("quest_choose_reward", { guid: mcbride.guid, questId: QUEST_INTRO, rewardIndex: 0 });
  await waitFor((e) => e.opcode === "SMSG_QUESTGIVER_QUEST_COMPLETE" && e.data?.questId === QUEST_INTRO, REPLY_TIMEOUT_MS, "quest complete 783", mark);
  log(`turned in quest ${QUEST_INTRO}`);
  mark = events.length;
  if (![...questLog.values()].includes(QUEST_KILL)) {
    await action("quest_list", { guid: mcbride.guid });
    await waitFor(
      (e) =>
        (e.opcode === "SMSG_QUESTGIVER_QUEST_LIST" || e.opcode === "SMSG_GOSSIP_MESSAGE") &&
        e.data?.quests?.some((q: any) => q.questId === QUEST_KILL),
      REPLY_TIMEOUT_MS,
      "McBride offering the kill quest",
      mark,
    );
    await action("quest_accept", { guid: mcbride.guid, questId: QUEST_KILL });
  }
  await waitForQuestInLog(QUEST_KILL, "the kill quest");
  log(`kill quest ${QUEST_KILL} in the quest log`);

  // 3. The one fight.
  await moveTo(VINEYARD_EDGE, "the vineyard edge");
  await waitForUnit(ENTRY_VERMIN, 10000, "a Kobold Vermin");
  const target = nearestUnitByEntry(ENTRY_VERMIN)!;
  log(`engaging kobold ${target.guid} at (${target.pos.x.toFixed(0)}, ${target.pos.y.toFixed(0)}), ${dist2d(target.pos, self.pos).toFixed(0)}y away`);
  await moveTo(target.pos, `kobold ${target.guid}`);
  await action("set_target", { guid: target.guid });
  await tryFace(target.pos.x, target.pos.y); // a real client auto-faces; melee swings need it
  await action("attack_start", { guid: target.guid });

  const fightStart = events.length;
  const fightEnd = Date.now() + FIGHT_TIMEOUT_MS;
  let sawStateUpdate = false;
  let killed = false;
  let reengageAt = Date.now() + 6000;
  let refaceAt = Date.now() + 1500;
  while (Date.now() < fightEnd) {
    if (self.maxHealth > 0 && self.health === 0) fail("died to a Kobold Vermin");
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
        await action("move_to", u.pos);
        await Bun.sleep(1500);
        await tryFace(u.pos.x, u.pos.y);
        await action("attack_start", { guid: target.guid });
      }
    }
    await Bun.sleep(300);
  }
  if (!killed) fail(`kobold ${target.guid} not dead after ${FIGHT_TIMEOUT_MS / 1000}s`);
  if (!sawStateUpdate) fail("never observed SMSG_ATTACKERSTATEUPDATE");
  const addKill = await waitFor(
    (e) => e.opcode === "SMSG_QUESTUPDATE_ADD_KILL" && e.data?.questId === QUEST_KILL && e.data?.guid === target.guid,
    REPLY_TIMEOUT_MS,
    "SMSG_QUESTUPDATE_ADD_KILL for the kill",
    fightStart,
  );
  if (addKill.data.entry !== ENTRY_VERMIN || addKill.data.current !== 1 || addKill.data.required !== 8) {
    fail(`kill credit malformed: ${JSON.stringify(addKill.data)}`);
  }
  const xpGain = await waitFor((e) => e.opcode === "SMSG_LOG_XPGAIN" && e.data?.fromKill === true, REPLY_TIMEOUT_MS, "fromKill SMSG_LOG_XPGAIN", fightStart);
  log(`kill credit: ${JSON.stringify(addKill.data)}; XPGAIN=${JSON.stringify(xpGain.data)}`);

  // 4. Loot the corpse with the one-call client sequence.
  const lootMark = events.length;
  await action("loot_all", { guid: target.guid });
  const lootEvt = await waitFor(
    (e) => e.opcode === "SMSG_LOOT_RESPONSE" || e.opcode === "SMSG_LOOT_RELEASE_RESPONSE",
    REPLY_TIMEOUT_MS,
    "loot response",
    lootMark,
  );
  if (lootEvt.opcode !== "SMSG_LOOT_RESPONSE") fail(`loot window never opened: first loot event was ${lootEvt.opcode}`);
  await waitFor((e) => e.opcode === "SMSG_LOOT_RELEASE_RESPONSE", REPLY_TIMEOUT_MS, "loot release", lootMark);
  log(`looted: items=${lootEvt.data.items?.length ?? 0} gold=${lootEvt.data.gold ?? 0}`);

  // 5. Logout. Last run's character was deleted at the start; this one is
  //    next run's.
  const del = await req("DELETE", "/session", { token: TOKEN });
  if (del.status !== 200) fail(`session delete failed: ${JSON.stringify(del.json)}`);
  log("logged out");
  ws.close();

  const secs = (Date.now() - startedAt) / 1000;
  log(`stats: ${events.length} events in ${secs.toFixed(1)}s`);
  log("PASS: delete last char -> one kobold — attack stream -> kill credit -> loot round trip -> logout");
  process.exit(0);
}

main().catch((e) => fail(String(e?.stack ?? e)));
