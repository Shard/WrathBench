/**
 * A regression smoke: combat, kill credit, kill-objective completion and loot,
 * with exactly ONE kill. It is a member of the on-demand regression suite (`bun wb smoke suite`, infra/smoke/lib/suite.ts)
 * on SMOKE2, beside quest-accept-status.ts and module-quest.ts (the kill
 * quest's turn-in). Neither the deploy window nor the supervisor runs it:
 * both verify with infra/smoke/preflight.ts alone.
 *
 * Starts from a fixture. A persistent character (default
 * `Smokekc` on MODULE_ACCOUNT, never deleted) is placed by
 * `infra/fixtures/apply.ts --scenario vineyard-last-kill`: level 1, no
 * money, logged out at the near edge of the Northshire vineyard, with
 * "A Threat Within" (783) already rewarded and "Kobold Camp Cleanup" (7) in
 * the log at 7 of its 8 Kobold Vermin. The one kill is therefore the last
 * one: it carries the credit from the persisted count to 8/8 and the core
 * marks the objective complete, which module-quest.ts used to prove by
 * playing all eight fights (four to five minutes).
 *
 * The fixture replaced a played prologue too: accept 783 at the spawn,
 * walk to Marshal McBride, turn it in, take 7 — and it was ~35s of a ~50s
 * run, since 7 is gated on 783. Those claims did not disappear with it: the
 * whole accept / questgiver-status / turn-in / chain-offer surface is proven
 * in the same suite by quest-accept-status.ts on another account, so the
 * suite loses nothing while this script gets to the fight in seconds.
 *
 * Raw HTTP/WS only (no SDK). Arc:
 *   0. enumerate the account (POST /characters); if `Smokekc` is missing,
 *      create it through the module (Human Paladin) and log straight out;
 *   1. apply the `vineyard-last-kill` scenario to the logged-out character;
 *   2. login; assert the fixture landed — within 15y of the vineyard edge,
 *      quest 7 in the served quest log with its first counter at 7 and its
 *      State not yet complete; then empty the backpack of what
 *      previous runs looted into it, through CMSG_DESTROYITEM —
 *      best effort, reported, never asserted;
 *   3. engage the nearest Kobold Vermin: set_target -> face -> attack_start ->
 *      the SMSG_ATTACKERSTATEUPDATE stream -> the kobold's health reaches 0 ->
 *      SMSG_QUESTUPDATE_ADD_KILL { questId 7, entry 6, current 8, required 8 },
 *      the quest-log slot's State reading complete (bit 1: the core sends no
 *      SMSG_QUESTUPDATE_COMPLETE for a kill objective, so this field is how a
 *      client learns it), a fromKill SMSG_LOG_XPGAIN, and the
 *      SMSG_PARTYKILLLOG kill record naming this character as the killer
 *      (ungrouped, the core sends it to the killer alone);
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
 * so is a kobold that never comes into view. A slow failure is the expensive
 * kind: the suite waits on its slowest member. For the same
 * reason the contended-account wait on POST /characters is ten seconds here,
 * not the twenty minutes travel.ts allows itself: that wait, apply.ts's online
 * poll and the arc are sequential.
 *
 * Run. The DB env the fixture tool needs is on the runner itself (the chart's
 * dbEnv, compose.yml's *wb-db anchor), so by hand nothing is added:
 *
 *   bun wb smoke kill-credit [--character Smokekc]
 *   bun wb --local smoke kill-credit [--character Smokekc]   # the quickstart
 *
 * The suite runs it as SMOKE2 (MODULE_ACCOUNT=SMOKE2), where `Smokekc` lives; by hand it
 * logs in as PROBE. Another account is MODULE_ACCOUNT in the runner's
 * environment, which `bun wb` does not carry: `kubectl -n wrathbench exec
 * deploy/wrathbench-runner -- env MODULE_ACCOUNT=SMOKE2 bun
 * infra/smoke/kill-credit.ts`.
 */

import { applyScenario, ensureFixtureCharacter, type FixtureContext } from "./lib/fixture";
import { authHeaders } from "./lib/auth";
import { failOnce } from "./lib/fail";
import { moduleBase, moduleWsBase } from "./lib/module";

const BASE = moduleBase();
const WS = moduleWsBase();

const TOKEN = `probe-killcredit-${crypto.randomUUID()}`;
// Persistent fixture character. Nothing is deleted: the placed rows are the
// starting state, and `apply.ts` rewrites them (level, position, quest log)
// before every run. `--character` overrides the name, as travel.ts allows.
const CHARACTER = (() => {
  const i = process.argv.indexOf("--character");
  return i >= 0 ? (process.argv[i + 1] ?? "Smokekc") : "Smokekc";
})();
const SCENARIO = "vineyard-last-kill";
const ACCOUNT = process.env.MODULE_ACCOUNT ?? "PROBE";

const QUEST_KILL = 7; // Kobold Camp Cleanup (kill 8 Kobold Vermin, entry 6)
const ENTRY_VERMIN = 6;
const KILLS_REQUIRED = 8;
/** What the fixture stands the count at: the one kill here is the last. */
const KILLS_PLACED = 7;

// The vineyard's near edge, the target the old full arc walked to and now the
// fixture's spawn point (infra/fixtures/scenarios.ts): the closest Kobold
// Vermin spawns to the abbey (creature rows at x -8783..-8795, y -134..-171)
// are within view from here.
const VINEYARD_EDGE = { x: -8790, y: -160, z: 82.5 };

// Observed maxima (2026-08-23 logs): fights 11.6-25.9s. The only walk left is
// the few yards to whichever kobold is nearest.
// The backpack, addressed as the item actions address it (sdk/src/state.ts
// `bag()`): `INVENTORY_SLOT_BAG_0` is bag 255 and its sixteen slots are 23-38
// in the character's own `invSlot<n>` numbering. Equipment is 0-18 and worn
// bags 19-22 — neither is ever touched here.
const BACKPACK_BAG = 255;
const BACKPACK_FIRST_SLOT = 23;
const BACKPACK_LAST_SLOT = 38;
const BACKPACK_SIZE = 16;
/** Kept by the start-of-run clear: the starter Hearthstone (slot 23 on a fresh character). */
const KEEP_ITEM_IDS = new Set([6948]);
/**
 * How long the guid -> item create block join is given to settle after login.
 * It lands with the create block the login already waits for — both live runs
 * joined immediately — so this is slack, not a budget, and the deploy
 * smokes' shared budget is no place to spend more (see the header).
 */
const BAG_JOIN_TIMEOUT_MS = 1500;

const WALK_TIMEOUT_MS = 30000;
const FIGHT_TIMEOUT_MS = 40000;
const REPLY_TIMEOUT_MS = 3000;

function log(msg: string) {
  console.log(`[killcredit] ${msg}`);
}
// Best-effort session cleanup so a failed run does not leave the account
// blocked for the next one (lib/fail.ts: once, awaited, then the exit).
const { fail: failNow, failed } = failOnce({
  prefix: () => "[killcredit] FAIL",
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
const units = new Map<string, { entry?: number; pos?: Vec; health?: number; dead?: boolean }>();
const self = { guid: "", health: 0, maxHealth: 0, pos: { x: 0, y: 0, z: 0 } as Vec };
const questLog = new Map<number, number>(); // slot -> questId
const questState = new Map<number, number>(); // slot -> state (bit 1 = objectives complete)
const questCountsLo = new Map<number, number>(); // slot -> counters 0 and 1, 16 bits each
// `invSlot<n>Lo/Hi` off our own update blocks: the two u32 halves of the item
// guid carried in inventory slot n (equipment 0-18, worn bags 19-22, backpack
// 23-38). A zero pair is an empty slot, and a slot cleared while we watch
// arrives as a `values` update with the halves set to 0 — which is how the
// clear below sees its own work land.
const invSlots = new Map<number, { lo: number; hi: number }>();

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
          const ms = /^quest(\d+)State$/.exec(k);
          if (ms) questState.set(+ms[1]!, v as number);
          const mc = /^quest(\d+)CountsLo$/.exec(k);
          if (mc) questCountsLo.set(+mc[1]!, v as number);
          const inv = /^invSlot(\d+)(Lo|Hi)$/.exec(k);
          if (inv) {
            const slot = +inv[1]!;
            const half = invSlots.get(slot) ?? { lo: 0, hi: 0 };
            if (inv[2] === "Lo") half.lo = (v as number) >>> 0;
            else half.hi = (v as number) >>> 0;
            invSlots.set(slot, half);
          }
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

async function waitForQuestInLog(questId: number, what: string): Promise<number> {
  const deadline = Date.now() + REPLY_TIMEOUT_MS;
  for (;;) {
    for (const [slot, id] of questLog) if (id === questId) return slot;
    if (Date.now() > deadline) fail(`quest log never showed ${what} (${questId}); log=${JSON.stringify([...questLog])}`);
    await Bun.sleep(100);
  }
}

/** A quest-log slot's first objective counter: the low 16 bits of its CountsLo field. */
const killCounter = (slot: number) => (questCountsLo.get(slot) ?? 0) & 0xffff;
const slotComplete = (slot: number) => ((questState.get(slot) ?? 0) & 1) === 1;

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
 * The fixture boot, shared with travel.ts. Budgets are a suite member's, not
 * a long probe's: a contended account is waited out for 10s in 5s steps and
 * then the run fails, because nothing else should hold the account in a
 * deploy window — and because the three waits are sequential: 10s here +
 * apply.ts's 90s online poll + a ~23s arc is ~123s at worst. The backpack clear (step 2b) is inside
 * that arc and costs at most ~3s of waiting — a 1.5s join settle and a 1.5s
 * destroy settle, both usually instant — so any new wait added here has to be
 * paid for out of the same budget.
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
 * character stands at the vineyard edge and the served quest log holds 7 at
 * 7 kills, not complete. All of it arrives with the login handshake, so give
 * it a moment. A stale row or a scenario that silently did nothing must read
 * as "the fixture did not land", not as the ambiguous "never saw a Kobold
 * Vermin" 10s later or a kill credit that lands at the wrong count.
 */
async function assertFixtureStart(): Promise<number> {
  const d = dist2d(self.pos, VINEYARD_EDGE);
  if (d > 15) fail(`fixture start: at (${self.pos.x.toFixed(0)}, ${self.pos.y.toFixed(0)}), ${d.toFixed(0)}y from the vineyard edge — did apply.ts write ${CHARACTER}?`);
  const slot = await waitForQuestInLog(QUEST_KILL, "the kill quest the fixture placed");
  const deadline = Date.now() + REPLY_TIMEOUT_MS;
  while (killCounter(slot) !== KILLS_PLACED && Date.now() < deadline) await Bun.sleep(100);
  if (killCounter(slot) !== KILLS_PLACED || slotComplete(slot)) {
    fail(
      `fixture start: quest ${QUEST_KILL} in slot ${slot} reads ${killCounter(slot)} kills, state ${questState.get(slot) ?? 0}; ` +
        `the fixture writes ${KILLS_PLACED} and incomplete — did apply.ts write ${CHARACTER}'s mobcount1?`,
    );
  }
  log(`fixture start ok: ${d.toFixed(1)}y from the vineyard edge, quest ${QUEST_KILL} in slot ${slot} at ${KILLS_PLACED}/${KILLS_REQUIRED}`);
  return slot;
}

/**
 * What the backpack holds right now, addressed the way `destroy_item` wants
 * it: bag 255, slot 23-38 (sdk/src/state.ts `bag()`). A slot whose guid
 * halves are both zero — or that has never been mentioned, since the wire
 * compresses zeros out of create blocks — is free.
 */
function backpack(): { slot: number; guid: string; entry: number | undefined }[] {
  const out: { slot: number; guid: string; entry: number | undefined }[] = [];
  for (let slot = BACKPACK_FIRST_SLOT; slot <= BACKPACK_LAST_SLOT; slot++) {
    const half = invSlots.get(slot);
    if (!half || (half.lo === 0 && half.hi === 0)) continue;
    const guid = ((BigInt(half.hi) << 32n) | BigInt(half.lo)).toString();
    out.push({ slot, guid, entry: units.get(guid)?.entry });
  }
  return out;
}

/**
 * Empty the backpack of everything the fixture did not put there,
 * through `CMSG_DESTROYITEM` — the same opcode a player pressing
 * delete sends, so this needs nothing from `infra/fixtures/*`, which refuses
 * to touch item_instance rows for good reason: item guids are not
 * safe to write from outside the running server.
 *
 * At the START of the run, not before logout, for three reasons:
 *   1. it is idempotent — it does not matter how many previous runs left junk
 *      behind, or how much;
 *   2. it runs even after a previous run FAILED and skipped its own cleanup,
 *      which is exactly the case where the bag is most likely to be full;
 *   3. it makes the loot assertion precise: the bag had N free slots, then
 *      loot arrived and occupied one.
 *
 * Best effort and REPORTED, never asserted. A cleanup that cannot run is a
 * line in the log and the run carries on to its real claims; a cleanup that
 * *aborted* the smoke would be a second failure mode wearing the costume of
 * the loot bug this exists to prevent.
 *
 * The keep rule fails toward keeping. Only a slot positively identified as a
 * non-keep item is destroyed: an item whose create block has not arrived (or
 * whose entry we never saw) is left alone and reported, because the join can
 * be incomplete and the Hearthstone sits in slot 23, the first one. Equipment
 * (slots 0-18) and worn bags (19-22) are never addressed at all.
 */
async function clearBackpack(): Promise<void> {
  // The join settles a moment after login: our own create block carries the
  // slot guids, the items' own create blocks carry their entries. Wait for
  // every occupied slot to name its item rather than reading the first block.
  const deadline = Date.now() + BAG_JOIN_TIMEOUT_MS;
  while (Date.now() < deadline && backpack().some((i) => i.entry === undefined)) await Bun.sleep(100);

  const held = backpack();
  // The fixture's Hearthstone is a permanent occupant, so an empty read is
  // never "the bag is clean" — it is our own create block not having carried
  // its `invSlot<n>` fields. Say so rather than logging a reassuring zero:
  // a cleanup that silently did nothing is the failure this exists to avoid.
  if (held.length === 0) {
    log("cleanup: no inventory slots observed — our create block carried no invSlot fields; nothing cleared and the bag's real contents are unknown");
    return;
  }
  const free = BACKPACK_SIZE - held.length;
  const junk = held.filter((i) => i.entry !== undefined && !KEEP_ITEM_IDS.has(i.entry));
  const unknown = held.filter((i) => i.entry === undefined);
  log(`backpack: ${held.length}/${BACKPACK_SIZE} slots used, ${free} free — ${junk.length} to clear${unknown.length ? `, ${unknown.length} unidentified (kept)` : ""}`);
  if (unknown.length) log(`cleanup: slots ${unknown.map((i) => i.slot).join(",")} never named their item; left alone`);
  if (junk.length === 0) return;

  for (const item of junk) {
    // Not action(): that fails the run on a refusal, and this must not.
    // Omitting `count` destroys the whole stack.
    const r = await req("POST", "/action", { token: TOKEN, action: "destroy_item", bag: BACKPACK_BAG, slot: item.slot });
    if (r.status !== 200 || !r.json?.ok) {
      log(`cleanup: destroy_item slot ${item.slot} (item ${item.entry}) refused: ${r.status} ${JSON.stringify(r.json)}`);
    }
  }
  // The slots we emptied come back as `values` updates with zeroed halves.
  const settle = Date.now() + REPLY_TIMEOUT_MS;
  const stillThere = () => backpack().filter((i) => junk.some((j) => j.slot === i.slot && j.guid === i.guid));
  while (Date.now() < settle && stillThere().length > 0) await Bun.sleep(100);

  const remaining = stillThere();
  const after = backpack();
  if (remaining.length === 0) {
    log(`cleanup: cleared ${junk.length} of ${junk.length} — ${BACKPACK_SIZE - after.length} free slots`);
  } else {
    log(`cleanup: cleared ${junk.length - remaining.length} of ${junk.length}, ${remaining.length} remain (slots ${remaining.map((i) => i.slot).join(",")}) — ${BACKPACK_SIZE - after.length} free slots. Not fatal; the loot claims below still stand, but the bag fills.`);
  }
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
  const questSlot = await assertFixtureStart();

  // 2b. Empty the backpack of what previous runs looted into it, before the
  //     run adds to it. Best effort: reported, never
  //     asserted.
  await clearBackpack();

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
  if (addKill.data.entry !== ENTRY_VERMIN || addKill.data.current !== KILLS_REQUIRED || addKill.data.required !== KILLS_REQUIRED) {
    fail(`kill credit malformed: ${JSON.stringify(addKill.data)} (expected entry ${ENTRY_VERMIN}, ${KILLS_PLACED} + 1 = ${KILLS_REQUIRED} of ${KILLS_REQUIRED})`);
  }
  // The last kill completes the objective: the core sets the slot's State bit
  // (Player::CompleteQuest), and the counter on the field agrees with the packet.
  {
    const deadline = Date.now() + REPLY_TIMEOUT_MS;
    while (!(slotComplete(questSlot) && killCounter(questSlot) === KILLS_REQUIRED) && Date.now() < deadline) await Bun.sleep(100);
    if (!slotComplete(questSlot)) fail(`quest ${QUEST_KILL} in slot ${questSlot} never read complete after the last kill; state=${questState.get(questSlot) ?? 0}`);
    if (killCounter(questSlot) !== KILLS_REQUIRED) fail(`quest ${QUEST_KILL}'s served counter reads ${killCounter(questSlot)} after the last kill, expected ${KILLS_REQUIRED}`);
  }
  log(`objective complete: quest ${QUEST_KILL} slot ${questSlot} state=${questState.get(questSlot)} counter=${killCounter(questSlot)}/${KILLS_REQUIRED}`);
  const xpGain = await waitFor((e) => e.opcode === "SMSG_LOG_XPGAIN" && e.data?.fromKill === true, REPLY_TIMEOUT_MS, "fromKill SMSG_LOG_XPGAIN", fightStart);
  log(`kill credit: ${JSON.stringify(addKill.data)}; XPGAIN=${JSON.stringify(xpGain.data)}`);
  // The kill record (Unit::Kill): with no group the core sends it to the
  // killer alone, so the one this character receives names itself.
  const killLog = await waitFor(
    (e) => e.opcode === "SMSG_PARTYKILLLOG" && e.data?.victimGuid === target.guid,
    REPLY_TIMEOUT_MS,
    "SMSG_PARTYKILLLOG for the kill (module predates the tap?)",
    fightStart,
  );
  if (killLog.data.killerGuid !== self.guid) fail(`SMSG_PARTYKILLLOG names killer ${killLog.data.killerGuid}, expected ${self.guid}`);
  log(`kill record: ${JSON.stringify(killLog.data)}`);

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

  // 4a. Loot refused, decoded. CMSG_LOOT on the corpse just emptied is
  //     answered with the refusal form of SMSG_LOOT_RESPONSE
  //     (Player::SendLootError: guid, LOOT_NONE, one LootError byte — 0,
  //     "didn't kill", once the corpse has lost UNIT_DYNFLAG_LOOTABLE). The
  //     module used to run off the end of that 10-byte packet and serve
  //     {"decodeError":true}, so the SDK waited for a window that was never
  //     coming. Gate: the structured form. A corpse that still had an
  //     unstorable slot reopens a window instead; that is released and
  //     reported as "not exercised", not failed, since it says nothing about
  //     the decode.
  const refuseMark = events.length;
  await action("loot", { guid: target.guid });
  const refusal = await waitFor((e) => e.opcode === "SMSG_LOOT_RESPONSE", REPLY_TIMEOUT_MS, "loot refusal", refuseMark);
  if (refusal.data?.decodeError) fail("loot refusal served as {decodeError:true}: the module did not decode SendLootError");
  if (refusal.data?.lootType === 0) {
    if (refusal.data?.error !== 0) fail(`second loot of the emptied corpse should be LootError 0 (didn't kill); got ${JSON.stringify(refusal.data)}`);
    log(`second loot of the emptied corpse refused as expected: ${JSON.stringify(refusal.data)}`);
  } else {
    log(`loot refusal not exercised: the corpse still showed ${refusal.data?.items?.length ?? "?"} slot(s); releasing`);
    await action("loot_release", { guid: target.guid });
    await waitFor((e) => e.opcode === "SMSG_LOOT_RELEASE_RESPONSE", REPLY_TIMEOUT_MS, "second loot release", refuseMark);
  }
  // What the cleared bag makes readable: N free slots before the kill, and
  // what the loot occupied. Logged, not asserted — a money-only loot is a
  // legitimate outcome and must not fail the smoke.
  await Bun.sleep(300);
  log(`looted: items=${lootEvt.data.items?.length ?? 0} gold=${lootEvt.data.gold ?? 0}; backpack now ${BACKPACK_SIZE - backpack().length} free slots`);

  // 5. Logout. The character is not deleted: it is the fixture, and the next
  //    run's apply.ts rewrites its rows.
  await endSession();
  log("logged out");
  ws.close();

  const secs = (Date.now() - startedAt) / 1000;
  log(`stats: ${events.length} events in ${secs.toFixed(1)}s`);
  log("PASS: vineyard fixture at 7/8 -> one kobold — attack stream -> kill credit 8/8 and objective complete -> kill record -> loot round trip -> logout");
  process.exit(0);
}

main().catch(failed);
