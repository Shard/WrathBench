/**
 * Fast-gate smoke B (ADR-0023 amendment, 2026-08-23): combat, kill credit and
 * loot, with exactly ONE kill. Runs on its own account in parallel with
 * quest-accept-status.ts; together they are the per-tick preflight gate. The
 * deploy-time full arc (eight kills to objective completion and the kill
 * quest's own turn-in) stays module-quest.ts.
 *
 * Starts from a fixture (FOLLOW-UPS item 45). A persistent character (default
 * `Smokekc` on MODULE_ACCOUNT, never deleted) is placed by
 * `infra/fixtures/apply.ts --scenario vineyard-kill-credit`: level 1, no
 * money, logged out at the near edge of the Northshire vineyard, with
 * "A Threat Within" (783) already rewarded and "Kobold Camp Cleanup" (7) in
 * the log. That is what this smoke used to *play* — accept 783 at the spawn,
 * walk to Marshal McBride, turn it in, take 7 — and it was ~35s of a ~50s
 * run, since 7 is gated on 783. Those claims did not disappear with it: the
 * whole accept / questgiver-status / turn-in / chain-offer surface is proven
 * every tick by quest-accept-status.ts on a parallel account, so the gate
 * loses nothing while this script gets to the fight in seconds.
 *
 * Raw HTTP/WS only (no SDK). Arc:
 *   0. enumerate the account (POST /characters); if `Smokekc` is missing,
 *      create it through the module (Human Paladin) and log straight out;
 *   1. apply the `vineyard-kill-credit` scenario to the logged-out character;
 *   2. login; assert the fixture landed — within 15y of the vineyard edge and
 *      quest 7 in the served quest log;
 *   3. engage the nearest Kobold Vermin: set_target -> face -> attack_start ->
 *      the SMSG_ATTACKERSTATEUPDATE stream -> the kobold's health reaches 0 ->
 *      SMSG_QUESTUPDATE_ADD_KILL { questId 7, entry 6, current 1 } and a
 *      fromKill SMSG_LOG_XPGAIN;
 *   4. loot_all the corpse -> SMSG_LOOT_RESPONSE -> SMSG_LOOT_RELEASE_RESPONSE;
 *   5. DELETE /session. The character is the fixture: it is never deleted, and
 *      `apply.ts` rewrites its rows (quest log included, `clearQuests`) at the
 *      start of the next run.
 *
 * The fixture is not free on back-to-back runs: `apply.ts` polls
 * `characters.online = 0`, which only clears when the core's logout save
 * lands. A run that follows another immediately pays that wait instead of the
 * ~35s of walking it replaced.
 *
 * Fail fast, never "pick another": the one fight has a hard cap of 1.5x the
 * longest fight observed (25.9s, 2026-08-23 logs), a death is a failure, and
 * so is a kobold that never comes into view. The gate re-runs every tick while
 * it fails; a slow failure is the expensive kind. For the same reason the
 * contended-account wait on POST /characters is ten seconds here, not the
 * twenty minutes travel.ts allows itself: that wait, apply.ts's online poll
 * and the arc are sequential, and their sum must close under the gate's
 * `preflight.timeoutMs`.
 *
 * Run (the fixture tool needs the DB env; see compose.yml's `fixtures`
 * service, and the `fleet` service which carries it for this gate):
 *
 *   docker compose -f infra/compose.yml exec \
 *     -e MODULE_ACCOUNT=SMOKE2 \
 *     -e WRATHBENCH_DB_HOST=db -e WRATHBENCH_DB_PORT=3306 \
 *     -e WRATHBENCH_DB_USER=root -e WRATHBENCH_DB_PASSWORD=wrathbench \
 *     runner bun infra/smoke/kill-credit.ts [--character Smokekc]
 */

import { applyScenario, ensureFixtureCharacter, type FixtureContext } from "./lib/fixture";

const HOST = process.env.MODULE_HOST ?? "worldserver";
const PORT = process.env.MODULE_PORT ?? "8086";
const BASE = `http://${HOST}:${PORT}`;
const WS = `ws://${HOST}:${PORT}`;

const TOKEN = `probe-killcredit-${crypto.randomUUID()}`;
// Persistent fixture character. Nothing is deleted: the placed rows are the
// starting state, and `apply.ts` rewrites them (level, position, quest log)
// before every run. `--character` overrides the name, as travel.ts allows.
const CHARACTER = (() => {
  const i = process.argv.indexOf("--character");
  return i >= 0 ? (process.argv[i + 1] ?? "Smokekc") : "Smokekc";
})();
const SCENARIO = "vineyard-kill-credit";
const ACCOUNT = process.env.MODULE_ACCOUNT ?? "PROBE";

const QUEST_KILL = 7; // Kobold Camp Cleanup (kill 8 Kobold Vermin, entry 6)
const ENTRY_VERMIN = 6;

// The vineyard's near edge, module-quest.ts's proven target and now the
// fixture's spawn point (infra/fixtures/scenarios.ts): the closest Kobold
// Vermin spawns to the abbey (creature rows at x -8783..-8795, y -134..-171)
// are within view from here.
const VINEYARD_EDGE = { x: -8790, y: -160, z: 82.5 };

// Observed maxima (2026-08-23 logs): fights 11.6-25.9s. The only walk left is
// the few yards to whichever kobold is nearest.
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
          if (m) questLog.set(+m[1]!, v as number);
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

/**
 * A session on this account, opened with the module's own CMSG_CHAR_CREATE
 * path when the character does not exist yet. Human Paladin, the class the
 * fight's timings were measured against.
 */
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
 * The fixture boot, shared with travel.ts. Budgets are the gate's, not a long
 * probe's: a contended account is waited out for 10s in 5s steps and then the
 * run fails, because the gate re-runs on the next tick anyway — and because
 * the three waits are sequential and their sum has to close under
 * `preflight.timeoutMs` (130s): 10s here + apply.ts's 90s online poll + a ~23s
 * arc is ~123s.
 */
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
    await createSession();
    await endSession();
  },
};

/**
 * The fixture's postcondition, checked in world rather than trusted: the
 * character stands at the vineyard edge and the served quest log holds 7.
 * Both arrive with the login handshake, so give them a moment. A stale row or
 * a scenario that silently did nothing must read as "the fixture did not
 * land", not as the ambiguous "never saw a Kobold Vermin" 10s later.
 */
async function assertFixtureStart(): Promise<void> {
  const d = dist2d(self.pos, VINEYARD_EDGE);
  if (d > 15) fail(`fixture start: at (${self.pos.x.toFixed(0)}, ${self.pos.y.toFixed(0)}), ${d.toFixed(0)}y from the vineyard edge — did apply.ts write ${CHARACTER}?`);
  await waitForQuestInLog(QUEST_KILL, "the kill quest the fixture placed");
  log(`fixture start ok: ${d.toFixed(1)}y from the vineyard edge, quest ${QUEST_KILL} in the log`);
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
  await Bun.sleep(200);

  // 2. Login onto the placed rows and check they are what the fixture wrote.
  const session = await createSession();
  log(`in world as ${CHARACTER} guid=${session.guid}`);
  const verify = await waitFor((e) => e.opcode === "SMSG_LOGIN_VERIFY_WORLD", 5000, "login verify");
  self.pos = { x: verify.data.x, y: verify.data.y, z: verify.data.z };
  await waitFor((e) => e.opcode === "SMSG_UPDATE_OBJECT" && e.data?.objects?.some((o: any) => o.self), 10000, "self create");
  await assertFixtureStart();

  // 3. The one fight. The fixture already stands at the vineyard edge, so the
  //    only walk left is up to whichever kobold is nearest.
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

  // 5. Logout. The character is not deleted: it is the fixture, and the next
  //    run's apply.ts rewrites its rows.
  await endSession();
  log("logged out");
  ws.close();

  const secs = (Date.now() - startedAt) / 1000;
  log(`stats: ${events.length} events in ${secs.toFixed(1)}s`);
  log("PASS: vineyard fixture -> one kobold — attack stream -> kill credit -> loot round trip -> logout");
  process.exit(0);
}

main().catch((e) => fail(String(e?.stack ?? e)));
