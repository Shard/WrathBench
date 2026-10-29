/**
 * A regression smoke: the kill quest's own turn-in. It is a member of
 * the on-demand regression suite (`bun wb smoke suite`, infra/smoke/lib/suite.ts) on SMOKE4,
 * beside kill-credit.ts and quest-accept-status.ts. Neither the deploy window
 * nor the supervisor runs it: both verify with infra/smoke/preflight.ts alone.
 *
 * This used to be the full arc on a fresh character: accept 783 from Deputy
 * Willem, turn it in to Marshal McBride, take Kobold Camp Cleanup (7), fight
 * eight Kobold Vermin one after another, walk back, turn 7 in, list a vendor,
 * log out and delete the character. It took 290-340s of every window, about
 * 70s of it three `/character-delete` 504s at the end (the core keeps a
 * logged-out character for 60s and ignores a delete in that window, and the
 * module answers each ignored delete after its 20s wait), and the rest eight
 * sequential level-1 fights and four walks. Every claim it made is still
 * proven in the same suite, each by the cheapest smoke that can:
 *   - the 783 accept / gossip / turn-in, quest 7 landing in the log, the
 *     vendor list, a fresh character's create and the CMSG_CHAR_DELETE path:
 *     quest-accept-status.ts;
 *   - the attack stream, SMSG_QUESTUPDATE_ADD_KILL, loot, and the kill
 *     objective completing (8/8 and the slot's State bit): kill-credit.ts,
 *     whose fixture stands the count at 7 so its one kill is the last;
 *   - the kill quest's turn-in, with its reward, XP and level-up: here.
 * What no smoke in the suite plays any more is eight fights in a row. The old arc
 * is in git history (this file before the change) for a by-hand run.
 *
 * Starts from a fixture. A persistent character (`Mq` + the account's
 * letters, `Mqsmokee` on SMOKE4, never deleted) is placed by
 * `infra/fixtures/apply.ts --scenario mcbride-kill-quest-done`: level 1 at
 * 300 of 400 xp, logged out in front of Marshal McBride, with 783 rewarded and
 * quest 7 complete at 8/8. Raw HTTP/WS only (no SDK). Arc:
 *   0. enumerate the account (POST /characters); if the character is missing,
 *      create it through the module (Human Paladin) and log straight out;
 *   1. apply the scenario to the logged-out character;
 *   2. login; assert the fixture landed: within 5y of the spot, quest 7 in
 *      the served quest log with its State complete and its counter at 8;
 *   3. questgiver_status_query on McBride reads a reward status (10, or its
 *      9/6/3 variants);
 *   4. quest_complete 7 -> SMSG_QUESTGIVER_OFFER_REWARD -> quest_choose_reward
 *      -> SMSG_QUESTGIVER_QUEST_COMPLETE with xp > 0, SMSG_LOG_XPGAIN
 *      (fromKill false), quest 7 gone from the quest log, and
 *      SMSG_LEVELUP_INFO to level 2 with the level field following;
 *   5. DELETE /session. The character is the fixture: the next run's
 *      apply.ts rewrites its level, xp, position and quest log.
 *
 * Every wait is a reply wait, bounded at 3s; nothing walks. POST /characters
 * waits out a contended account in 1s steps for at most 10s.
 *
 * Run:
 *   bun wb smoke module-quest [--character Mqprobe]
 *   bun wb --local smoke module-quest   # the quickstart
 */

import { accountFixtureName, applyScenario, ensureFixtureCharacter, type FixtureContext } from "./lib/fixture";
import { authHeaders } from "./lib/auth";
import { failOnce } from "./lib/fail";
import { moduleBase, moduleWsBase } from "./lib/module";
import { smokeToken } from "./lib/session";
import { SCENARIOS } from "../fixtures/scenarios";

const BASE = moduleBase();
const WS = moduleWsBase();

// Session tokens must be at least 32 characters (POST /session rejects
// shorter ones with weak_token); randomUUID keeps them unguessable too.
const TOKEN = smokeToken("module-quest");
const ACCOUNT = process.env.MODULE_ACCOUNT ?? "PROBE";
// Character names are realm-global, so the fixture's name is the account's.
const CHARACTER = (() => {
  const i = process.argv.indexOf("--character");
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : accountFixtureName("Mq", ACCOUNT);
})();
const SCENARIO = "mcbride-kill-quest-done";
const SPOT = SCENARIOS[SCENARIO].position;

const QUEST_KILL = 7; // Kobold Camp Cleanup (kill 8 Kobold Vermin, entry 6)
const KILLS_REQUIRED = 8;
const ENTRY_MCBRIDE = 197;
// QuestGiverStatus (QuestDef.h): REWARD 10 (yellow ?), REWARD2 9, REWARD_REP 6, LOW_LEVEL_REWARD_REP 3.
const STATUS_REWARD = new Set([10, 9, 6, 3]);
const LEVEL_AFTER = 2;

const REPLY_TIMEOUT_MS = 3000;

function log(msg: string) {
  console.log(`[probe +${((Date.now() - startedAt) / 1000).toFixed(1)}s] ${msg}`);
}
// Best-effort session cleanup so a failed run does not leave the account
// blocked for the next one (lib/fail.ts: once, awaited, then the exit).
const { fail: failNow, failed } = failOnce({
  prefix: () => "[probe] FAIL",
  cleanup: () => fetch(`${BASE}/session`, { method: "DELETE", headers: authHeaders(), body: JSON.stringify({ token: TOKEN }) }),
  cleanupMs: 3000,
});
function fail(msg: string): never {
  return failNow(msg);
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
const self = { guid: "", level: 0, xp: 0, pos: { x: 0, y: 0, z: 0 } as Vec };
const questLog = new Map<number, number>(); // slot -> questId
const questState = new Map<number, number>(); // slot -> state (bit 1 = objectives complete)
const questCountsLo = new Map<number, number>(); // slot -> counters 0 and 1, 16 bits each

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
          const mc = /^quest(\d+)CountsLo$/.exec(k);
          if (mc) questCountsLo.set(+mc[1]!, v as number);
        }
      }
    }
  } else if (e.opcode === "SMSG_DESTROY_OBJECT") {
    units.delete(e.data?.guid);
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
    await Bun.sleep(50);
  }
}

/** Poll a condition on the tracked state for up to `ms`; true when it held in time. */
async function until(ms: number, cond: () => boolean): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) return false;
    await Bun.sleep(50);
  }
  return true;
}

const dist2d = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
const slotOf = (questId: number) => [...questLog].find(([, id]) => id === questId)?.[0];
const killCounter = (slot: number) => (questCountsLo.get(slot) ?? 0) & 0xffff;
const slotComplete = (slot: number) => ((questState.get(slot) ?? 0) & 1) === 1;

async function waitForUnit(entry: number, timeoutMs: number, what: string): Promise<{ guid: string; pos: Vec }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const [guid, u] of units) if (u.entry === entry && !u.dead && u.pos) return { guid, pos: u.pos };
    if (Date.now() > deadline) fail(`never saw ${what} (entry ${entry}) in update range`);
    await Bun.sleep(100);
  }
}

async function createSession(): Promise<any> {
  const session = await req("POST", "/session", { token: TOKEN, account: ACCOUNT, character: CHARACTER, race: 1, class: 2 });
  if (session.status !== 200 || !session.json?.inWorld) fail(`session failed: ${JSON.stringify(session.json)}`);
  return session.json;
}

async function endSession(): Promise<void> {
  const del = await req("DELETE", "/session", { token: TOKEN });
  if (del.status !== 200) fail(`session delete failed: ${JSON.stringify(del.json)}`);
}

/**
 * The fixture boot, shared with kill-credit.ts and travel.ts. Nothing else
 * should hold the suite's account, but a by-hand run can follow another smoke
 * on it within a second, so a contended account is retried every second for
 * ten.
 */
const fixtureCtx: FixtureContext = {
  base: BASE,
  account: ACCOUNT,
  character: CHARACTER,
  token: TOKEN,
  log,
  fail,
  contendedDeadlineMs: 10_000,
  contendedRetryMs: 1_000,
  createAndLogout: async () => {
    await createSession();
    await endSession();
  },
};

/**
 * The fixture's postcondition, checked in world rather than trusted: the
 * character stands at the spot and the served log holds 7, complete, at 8
 * kills. A scenario that silently did nothing must read as "the fixture did
 * not land", not as a turn-in the core refused.
 */
async function assertFixtureStart(): Promise<number> {
  const d = dist2d(self.pos, SPOT);
  if (d > 5) fail(`fixture start: at (${self.pos.x.toFixed(0)}, ${self.pos.y.toFixed(0)}), ${d.toFixed(0)}y from the spot in front of McBride — did apply.ts write ${CHARACTER}?`);
  await until(REPLY_TIMEOUT_MS, () => {
    const slot = slotOf(QUEST_KILL);
    return slot !== undefined && slotComplete(slot) && killCounter(slot) === KILLS_REQUIRED;
  });
  const slot = slotOf(QUEST_KILL);
  if (slot === undefined) fail(`fixture start: quest ${QUEST_KILL} is not in the served quest log (${JSON.stringify([...questLog])}) — did apply.ts write ${CHARACTER}?`);
  if (!slotComplete(slot) || killCounter(slot) !== KILLS_REQUIRED) {
    fail(
      `fixture start: quest ${QUEST_KILL} in slot ${slot} reads state ${questState.get(slot) ?? 0}, ${killCounter(slot)} kills; ` +
        `the fixture writes complete at ${KILLS_REQUIRED} — did apply.ts write ${CHARACTER}'s status and mobcount1?`,
    );
  }
  log(`fixture start ok: ${d.toFixed(1)}y from the spot, level ${self.level} xp ${self.xp}, quest ${QUEST_KILL} in slot ${slot} complete at ${KILLS_REQUIRED}/${KILLS_REQUIRED}`);
  return slot;
}

async function main() {
  const health = await req("GET", "/health");
  if (health.status !== 200 || !health.json?.ok) fail(`health not ok: ${JSON.stringify(health)}`);
  log(`health ok, character=${CHARACTER} account=${ACCOUNT}`);

  // 0-1. The fixture: make sure the character exists, then place it. Both run
  //      while it is logged out; apply.ts waits for the logout save itself.
  await ensureFixtureCharacter(fixtureCtx);
  await applyScenario(fixtureCtx, SCENARIO);

  const ws = await openEvents();

  // 2. Login onto the placed rows and check they are what the fixture wrote.
  const session = await createSession();
  log(`in world as ${CHARACTER} guid=${session.guid}`);
  const verify = await waitFor((e) => e.opcode === "SMSG_LOGIN_VERIFY_WORLD", 5000, "login verify");
  self.pos = { x: verify.data.x, y: verify.data.y, z: verify.data.z };
  await waitFor((e) => e.opcode === "SMSG_UPDATE_OBJECT" && e.data?.objects?.some((o: any) => o.self), 10000, "self create");
  await assertFixtureStart();

  // 3. McBride reads as having a reward for us.
  const mcbride = await waitForUnit(ENTRY_MCBRIDE, 5000, "Marshal McBride");
  let mark = events.length;
  await action("questgiver_status_query", { guid: mcbride.guid });
  const status = await waitFor((e) => e.opcode === "SMSG_QUESTGIVER_STATUS" && e.data?.guid === mcbride.guid, REPLY_TIMEOUT_MS, "SMSG_QUESTGIVER_STATUS for McBride", mark);
  if (!STATUS_REWARD.has(status.data.status)) fail(`McBride's status is ${status.data.status} with quest ${QUEST_KILL} complete, expected a reward status (10/9/6/3)`);
  log(`McBride status=${status.data.status} (reward)`);

  // 4. The turn-in: offer, choice, completion, XP, the log slot freed, the level-up.
  mark = events.length;
  const levelBefore = self.level;
  const xpBefore = self.xp;
  await action("quest_complete", { guid: mcbride.guid, questId: QUEST_KILL });
  const offer = await waitFor((e) => e.opcode === "SMSG_QUESTGIVER_OFFER_REWARD" && e.data?.questId === QUEST_KILL, REPLY_TIMEOUT_MS, "offer reward for the kill quest", mark);
  log(`offer reward: "${offer.data.title ?? "?"}"`);
  await action("quest_choose_reward", { guid: mcbride.guid, questId: QUEST_KILL, rewardIndex: 0 });
  const done = await waitFor((e) => e.opcode === "SMSG_QUESTGIVER_QUEST_COMPLETE" && e.data?.questId === QUEST_KILL, REPLY_TIMEOUT_MS, "SMSG_QUESTGIVER_QUEST_COMPLETE", mark);
  const xpGain = await waitFor((e) => e.opcode === "SMSG_LOG_XPGAIN" && e.data?.fromKill === false, REPLY_TIMEOUT_MS, "SMSG_LOG_XPGAIN", mark);
  if (!(done.data.xp > 0) || !(xpGain.data.amount > 0)) fail(`turn-in rewarded no XP: ${JSON.stringify(done.data)} / ${JSON.stringify(xpGain.data)}`);
  if (!(await until(REPLY_TIMEOUT_MS, () => slotOf(QUEST_KILL) === undefined))) fail(`quest ${QUEST_KILL} is still in the quest log after its turn-in: ${JSON.stringify([...questLog])}`);
  const levelUp = await waitFor((e) => e.opcode === "SMSG_LEVELUP_INFO", REPLY_TIMEOUT_MS, `SMSG_LEVELUP_INFO (fixture xp 300 + the turn-in's ${done.data.xp} should cross 400)`, mark);
  if (levelUp.data.level !== LEVEL_AFTER) fail(`SMSG_LEVELUP_INFO names level ${levelUp.data.level}, expected ${LEVEL_AFTER}`);
  if (!(await until(REPLY_TIMEOUT_MS, () => self.level === LEVEL_AFTER))) fail(`the level field reads ${self.level} after SMSG_LEVELUP_INFO to ${LEVEL_AFTER}`);
  log(
    `quest ${QUEST_KILL} rewarded: xp=${done.data.xp} money=${done.data.money}; XPGAIN=${JSON.stringify(xpGain.data)}; ` +
      `level ${levelBefore}->${self.level} (xp field ${xpBefore}->${self.xp}); quest log slot freed`,
  );

  // 5. Logout. The character is the fixture and is not deleted.
  await endSession();
  log("logged out");
  ws.close();

  log(`stats: ${events.length} events in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  log("PASS: McBride fixture with quest 7 at 8/8 complete -> reward status -> offer -> choose -> complete + XP -> log slot freed -> level 2 -> logout");
  process.exit(0);
}

main().catch(failed);
