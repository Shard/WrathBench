/**
 * Fast-gate smoke A (added to the gate 2026-08-23): the quest-accept /
 * questgiver-status / turn-in surface, with no combat. Runs on its own account
 * in parallel with kill-credit.ts; together they are the per-tick preflight
 * gate. The deploy-time full arc stays module-quest.ts.
 *
 * Raw HTTP/WS only (no SDK). Arc — fresh Human Paladin in Northshire, which
 * spawns beside Deputy Willem:
 *   1. login: SMSG_LOGIN_VERIFY_WORLD, the self create block, the login-time
 *      SMSG_QUESTGIVER_STATUS_MULTIPLE;
 *   2. the quest-status assertions, verbatim from quest-status.ts:
 *      questgiver_status_multiple_query names Willem "available"
 *      (8; 2/7/4 variants); questgiver_status_query for his guid agrees;
 *      quest_query 783 -> title, requiredNpcOrGo.length 4 / requiredItems
 *      .length 6, no kill objectives; quest_query 7 -> objective 0 is
 *      { entry 6, count 8 }; quest_query without questId -> 400
 *      missing_quest_id;
 *   3. quest_list / quest_details / quest_accept 783 from Willem -> the
 *      quest-log Id field shows it and, 783 being a talk quest, the served
 *      State field reads complete (bit 1) — the same completion signal the
 *      kill arc reads after its last kill; then STATUS_MULTIPLE no longer
 *      reads Willem as available;
 *   4. walk into the abbey to Marshal McBride, gossip_hello -> gossip/quest
 *      list; quest_complete 783 -> SMSG_QUESTGIVER_OFFER_REWARD ->
 *      quest_choose_reward -> SMSG_QUESTGIVER_QUEST_COMPLETE + SMSG_LOG_XPGAIN
 *      (+ the xp field moving on self);
 *   5. Kobold Camp Cleanup (7) lands in the quest log (chain auto-offer, or
 *      an explicit accept);
 *   6. vendor_list on Janos Hammerknuckle -> SMSG_LIST_INVENTORY with items;
 *   7. logout. Step 0, before any of this: POST /character-delete of LAST
 *      run's character (the real CMSG_CHAR_DELETE path) — see CHARACTER below
 *      for why the delete is first, not last.
 *
 * Every wait is sized at ~1.5x the observed maximum for that step (logs in
 * data/logs/wrathbench/probe-quest-*.jsonl), not a catch-all 60s: the gate
 * re-runs every tick while it fails, so a slow failure is an expensive one.
 *
 * Run:
 *   docker compose -f infra/compose.yml exec runner bun infra/smoke/quest-accept-status.ts
 */

import { authHeaders } from "./lib/auth";

const HOST = process.env.MODULE_HOST ?? "worldserver";
const PORT = process.env.MODULE_PORT ?? "8086";
const BASE = `http://${HOST}:${PORT}`;
const WS = `ws://${HOST}:${PORT}`;

const TOKEN = `probe-qaccept-${crypto.randomUUID()}`;
// Fixed name, deleted at the START of every run and only logged out at the
// end: a character that merely disconnects stays in world for the core's
// 60s WorldSession::expireTime, during which CMSG_CHAR_DELETE is silently
// ignored (measured 2026-08-23: 66s from logout to a successful delete), and
// a real client's clean exit (CMSG_LOGOUT_REQUEST) is not on the raw
// allowlist. Deleting last run's character first proves the same
// CMSG_CHAR_DELETE path with no wait, because by the next tick the linger is
// long over. One name per script, so the leftover is always exactly one.
const CHARACTER = "Smokeqa";
const ACCOUNT = process.env.MODULE_ACCOUNT ?? "PROBE";

const QUEST_INTRO = 783; // A Threat Within (Deputy Willem -> Marshal McBride)
const QUEST_KILL = 7; // Kobold Camp Cleanup (kill 8 Kobold Vermin, entry 6)
const ENTRY_WILLEM = 823;
const ENTRY_MCBRIDE = 197;
const ENTRY_VERMIN = 6;
const ENTRY_VENDOR = 78; // Janos Hammerknuckle, abbey courtyard vendor
const STATUS_AVAILABLE = new Set([8, 2, 7, 4]); // available / low-level / rep variants

const MCBRIDE_POS = { x: -8902.6, y: -162.6, z: 82.0 };
const VENDOR_POS = { x: -8909.5, y: -104.2, z: 82.0 };

// Observed maxima (2026-08-23 logs): McBride walk 9.5s, vendor walk 8.6s,
// every packet round trip well under 1s.
const WALK_TIMEOUT_MS = 15000;
const REPLY_TIMEOUT_MS = 3000;

function log(msg: string) {
  console.log(`[qaccept] ${msg}`);
}
function fail(msg: string): never {
  console.error(`[qaccept] FAIL: ${msg}`);
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

type Vec = { x: number; y: number; z: number };
const units = new Map<string, { entry?: number; pos?: Vec; dead?: boolean }>();
const self = { guid: "", level: 1, xp: 0, pos: { x: 0, y: 0, z: 0 } as Vec };
const questLog = new Map<number, number>(); // slot -> questId
const questState = new Map<number, number>(); // slot -> state (bit 1 = objectives complete)

function trackEvent(e: any) {
  if (e.opcode === "SMSG_UPDATE_OBJECT" && Array.isArray(e.data?.objects)) {
    for (const o of e.data.objects) {
      if (o.update === "create") {
        const u = units.get(o.guid) ?? {};
        if (o.pos) u.pos = o.pos;
        if (o.fields?.entry !== undefined) u.entry = o.fields.entry;
        if (o.fields?.health !== undefined) u.dead = o.fields.health === 0;
        units.set(o.guid, u);
        if (o.self) self.guid = o.guid;
      } else if (o.update === "values") {
        const u = units.get(o.guid) ?? {};
        if (o.fields?.health !== undefined) u.dead = o.fields.health === 0;
        units.set(o.guid, u);
      } else if (o.update === "movement" && o.pos) {
        const u = units.get(o.guid) ?? {};
        u.pos = o.pos;
        units.set(o.guid, u);
      } else if (o.update === "outOfRange") {
        for (const g of o.guids ?? []) units.delete(g);
      }
      if ((o.update === "create" || o.update === "values") && o.guid === self.guid && o.fields) {
        if (o.fields.level !== undefined) self.level = o.fields.level;
        if (o.fields.xp !== undefined) self.xp = o.fields.xp;
        for (const [k, v] of Object.entries(o.fields)) {
          const m = /^quest(\d+)Id$/.exec(k);
          if (m) questLog.set(+m[1]!, v as number);
          const ms = /^quest(\d+)State$/.exec(k);
          if (ms) questState.set(+ms[1]!, v as number);
        }
      }
    }
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

async function waitForQuestInLog(questId: number, what: string): Promise<number> {
  const deadline = Date.now() + REPLY_TIMEOUT_MS;
  for (;;) {
    for (const [slot, id] of questLog) if (id === questId) return slot;
    if (Date.now() > deadline) fail(`quest log never showed ${what} (${questId}); log=${JSON.stringify([...questLog])}`);
    await Bun.sleep(100);
  }
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

// One move_to, one verdict. The legs here are short (under 60y) and on the
// abbey's own mesh, so anything but `arrived` is a fault, not a detour.
async function moveTo(target: Vec, what: string): Promise<void> {
  const r = await action("move_to", target);
  const res = await waitFor(
    (e) => e.opcode === "WB_MOVE_RESULT" && e.data?.moveId === r.moveId,
    WALK_TIMEOUT_MS,
    `WB_MOVE_RESULT for ${what}`,
  );
  if (res.data.status !== "arrived") fail(`move to ${what} ended ${res.data.status}`);
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

  // 1. Fresh Human Paladin in Northshire.
  const session = await req("POST", "/session", { token: TOKEN, account: ACCOUNT, character: CHARACTER, race: 1, class: 2 });
  if (session.status !== 200 || !session.json?.inWorld) fail(`session failed: ${JSON.stringify(session.json)}`);
  log(`in world as ${CHARACTER} guid=${session.json.guid}`);
  const verify = await waitFor((e) => e.opcode === "SMSG_LOGIN_VERIFY_WORLD", 5000, "login verify");
  self.pos = { x: verify.data.x, y: verify.data.y, z: verify.data.z };
  await waitFor((e) => e.opcode === "SMSG_UPDATE_OBJECT" && e.data?.objects?.some((o: any) => o.self), 10000, "self create");
  const willem = await waitForUnit(ENTRY_WILLEM, 10000, "Deputy Willem");

  // 2. Questgiver status + quest query (verbatim from quest-status.ts).
  //    The core's unprompted login-time STATUS_MULTIPLE is EMPTY (verified live
  //    2026-08-22: it is sent before the visibility container is populated) —
  //    which is why a client, and the SDK, query per guid on spawn. So: wait
  //    until Willem is in view, then ask, and assert on the answer.
  const loginMultiple = await waitFor((e) => e.opcode === "SMSG_QUESTGIVER_STATUS_MULTIPLE", 10000, "login STATUS_MULTIPLE");
  log(`login STATUS_MULTIPLE: ${loginMultiple.data.statuses?.length ?? "?"} entries (the core sends it before visibility is populated; 0 is normal)`);
  let mark = events.length;
  await action("questgiver_status_multiple_query");
  const multiple = await waitFor((e) => e.opcode === "SMSG_QUESTGIVER_STATUS_MULTIPLE", REPLY_TIMEOUT_MS, "STATUS_MULTIPLE after Willem is in view", mark);
  const willemRow = (multiple.data.statuses ?? []).find((r: any) => r.guid === willem.guid);
  if (!willemRow) fail(`STATUS_MULTIPLE did not name Willem (${willem.guid}): ${JSON.stringify(multiple.data)}`);
  if (!STATUS_AVAILABLE.has(willemRow.status)) fail(`Willem's status is ${willemRow.status}, expected an available status`);
  log(`STATUS_MULTIPLE: ${multiple.data.statuses.length} questgivers, Willem status=${willemRow.status}`);

  mark = events.length;
  await action("questgiver_status_query", { guid: willem.guid });
  const single = await waitFor((e) => e.opcode === "SMSG_QUESTGIVER_STATUS" && e.data?.guid === willem.guid, REPLY_TIMEOUT_MS, "SMSG_QUESTGIVER_STATUS for Willem", mark);
  if (single.data.status !== willemRow.status) fail(`single status ${single.data.status} != multiple status ${willemRow.status}`);
  log(`questgiver_status_query -> status=${single.data.status}`);

  mark = events.length;
  await action("quest_query", { questId: QUEST_INTRO });
  const intro = await waitFor((e) => e.opcode === "SMSG_QUEST_QUERY_RESPONSE" && e.data?.questId === QUEST_INTRO, REPLY_TIMEOUT_MS, `QUEST_QUERY_RESPONSE ${QUEST_INTRO}`, mark);
  if (typeof intro.data.title !== "string" || intro.data.title.length === 0) fail(`quest ${QUEST_INTRO} has no title: ${JSON.stringify(intro.data)}`);
  if (!Array.isArray(intro.data.requiredNpcOrGo) || intro.data.requiredNpcOrGo.length !== 4) fail(`requiredNpcOrGo malformed: ${JSON.stringify(intro.data)}`);
  if (!Array.isArray(intro.data.requiredItems) || intro.data.requiredItems.length !== 6) fail(`requiredItems malformed: ${JSON.stringify(intro.data)}`);
  if (intro.data.requiredNpcOrGo.some((r: any) => r.entry !== 0 || r.count !== 0)) fail(`quest ${QUEST_INTRO} should have no kill objectives: ${JSON.stringify(intro.data.requiredNpcOrGo)}`);
  log(`quest ${QUEST_INTRO}: "${intro.data.title}" level=${intro.data.level} objectives="${intro.data.objectives}"`);

  mark = events.length;
  await action("quest_query", { questId: QUEST_KILL });
  const kill = await waitFor((e) => e.opcode === "SMSG_QUEST_QUERY_RESPONSE" && e.data?.questId === QUEST_KILL, REPLY_TIMEOUT_MS, `QUEST_QUERY_RESPONSE ${QUEST_KILL}`, mark);
  const first = kill.data.requiredNpcOrGo?.[0];
  if (!first || first.entry !== ENTRY_VERMIN || first.count !== 8) fail(`quest ${QUEST_KILL} objective 0 should be { entry ${ENTRY_VERMIN}, count 8 }: ${JSON.stringify(kill.data.requiredNpcOrGo)}`);
  log(`quest ${QUEST_KILL}: "${kill.data.title}" objective 0 = ${JSON.stringify(first)}`);

  // A bad request is rejected, not coerced.
  const bad = await req("POST", "/action", { token: TOKEN, action: "quest_query" });
  if (bad.status !== 400 || bad.json?.error !== "missing_quest_id") fail(`quest_query without questId: ${bad.status} ${JSON.stringify(bad.json)}`);

  // 3. Accept 783 from Willem (list -> details -> accept), watch the log.
  mark = events.length;
  await action("quest_list", { guid: willem.guid });
  const list = await waitFor(
    (e) =>
      (e.opcode === "SMSG_QUESTGIVER_QUEST_LIST" && e.data?.quests?.some((q: any) => q.questId === QUEST_INTRO)) ||
      (e.opcode === "SMSG_GOSSIP_MESSAGE" && e.data?.quests?.some((q: any) => q.questId === QUEST_INTRO)),
    REPLY_TIMEOUT_MS,
    "Willem's quest list",
    mark,
  );
  log(`Willem offers: ${JSON.stringify((list.data.quests ?? []).map((q: any) => q.questId))}`);
  mark = events.length;
  await action("quest_details", { guid: willem.guid, questId: QUEST_INTRO });
  const details = await waitFor((e) => e.opcode === "SMSG_QUESTGIVER_QUEST_DETAILS" && e.data?.questId === QUEST_INTRO, REPLY_TIMEOUT_MS, "quest details", mark);
  log(`quest ${QUEST_INTRO} details: "${details.data.title}"`);
  await action("quest_accept", { guid: willem.guid, questId: QUEST_INTRO });
  const introSlot = await waitForQuestInLog(QUEST_INTRO, "the intro quest");
  // A talk quest has no objectives, so the core marks it complete on accept:
  // the served State field for its slot carries bit 1. This is the same
  // completion signal the kill arc reads (the core does not send
  // SMSG_QUESTUPDATE_COMPLETE for kill or talk objectives; see module-quest.ts).
  {
    const deadline = Date.now() + REPLY_TIMEOUT_MS;
    while (((questState.get(introSlot) ?? 0) & 1) === 0) {
      if (Date.now() > deadline) fail(`quest ${QUEST_INTRO} in slot ${introSlot} never read complete; state=${JSON.stringify([...questState])}`);
      await Bun.sleep(100);
    }
  }
  log(`accepted quest ${QUEST_INTRO} (slot ${introSlot}, state=${questState.get(introSlot)} complete)`);

  mark = events.length;
  await action("questgiver_status_multiple_query");
  const refreshed = await waitFor((e) => e.opcode === "SMSG_QUESTGIVER_STATUS_MULTIPLE", REPLY_TIMEOUT_MS, "STATUS_MULTIPLE after accept", mark);
  const after = (refreshed.data.statuses ?? []).find((r: any) => r.guid === willem.guid);
  if (!after) fail(`refreshed STATUS_MULTIPLE did not name Willem: ${JSON.stringify(refreshed.data)}`);
  if (STATUS_AVAILABLE.has(after.status)) fail(`Willem still reads available (${after.status}) after giving quest ${QUEST_INTRO}`);
  log(`after accept: Willem status ${willemRow.status} -> ${after.status}`);

  // 4. Into the abbey: gossip McBride, turn in 783 with the reward chain.
  await moveTo(MCBRIDE_POS, "Marshal McBride");
  const mcbride = await waitForUnit(ENTRY_MCBRIDE, 5000, "Marshal McBride");
  mark = events.length;
  await action("gossip_hello", { guid: mcbride.guid });
  const greet = await waitFor(
    (e) => e.opcode === "SMSG_GOSSIP_MESSAGE" || e.opcode === "SMSG_QUESTGIVER_QUEST_LIST",
    REPLY_TIMEOUT_MS,
    "McBride gossip/quest list",
    mark,
  );
  log(`McBride answered with ${greet.opcode}`);
  mark = events.length;
  const xpBefore = self.xp;
  await action("quest_complete", { guid: mcbride.guid, questId: QUEST_INTRO });
  await waitFor((e) => e.opcode === "SMSG_QUESTGIVER_OFFER_REWARD" && e.data?.questId === QUEST_INTRO, REPLY_TIMEOUT_MS, "offer reward 783", mark);
  await action("quest_choose_reward", { guid: mcbride.guid, questId: QUEST_INTRO, rewardIndex: 0 });
  const done = await waitFor((e) => e.opcode === "SMSG_QUESTGIVER_QUEST_COMPLETE" && e.data?.questId === QUEST_INTRO, REPLY_TIMEOUT_MS, "quest complete 783", mark);
  const xpGain = await waitFor((e) => e.opcode === "SMSG_LOG_XPGAIN" && e.data?.fromKill === false, REPLY_TIMEOUT_MS, "SMSG_LOG_XPGAIN", mark);
  if (!(done.data.xp > 0) || !(xpGain.data.amount > 0)) fail(`turn-in rewarded no XP: ${JSON.stringify(done.data)} / ${JSON.stringify(xpGain.data)}`);
  log(`turned in quest ${QUEST_INTRO}: xp=${done.data.xp} money=${done.data.money}; XPGAIN=${JSON.stringify(xpGain.data)}; xp field ${xpBefore}->${self.xp}`);

  // 5. The kill quest lands in the log (the chain may auto-offer it during the
  //    783 turn-in; if not, accept it explicitly).
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

  // 6. Vendor list in the abbey courtyard.
  await moveTo(VENDOR_POS, "Janos Hammerknuckle");
  const vendor = await waitForUnit(ENTRY_VENDOR, 5000, "the vendor");
  mark = events.length;
  await action("vendor_list", { guid: vendor.guid });
  const inv = await waitFor((e) => e.opcode === "SMSG_LIST_INVENTORY", REPLY_TIMEOUT_MS, "vendor inventory", mark);
  if (!inv.data.items?.length) fail(`vendor inventory empty: ${JSON.stringify(inv.data)}`);
  log(`vendor list: ${inv.data.items.length} items, first=${JSON.stringify(inv.data.items[0])}`);

  // 7. Logout. Last run's character was deleted at the start; this one is
  //    next run's.
  const del = await req("DELETE", "/session", { token: TOKEN });
  if (del.status !== 200) fail(`session delete failed: ${JSON.stringify(del.json)}`);
  log("logged out");
  ws.close();

  const secs = (Date.now() - startedAt) / 1000;
  log(`stats: ${events.length} events in ${secs.toFixed(1)}s`);
  log("PASS: delete last char -> questgiver status + quest query -> accept 783 (log state complete) -> turn-in reward chain + XP -> quest 7 in log -> vendor -> logout");
  process.exit(0);
}

main().catch((e) => fail(String(e?.stack ?? e)));
