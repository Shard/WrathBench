/**
 * Probe for the two melee swing errors the module forwards:
 * `SMSG_ATTACKSWING_NOTINRANGE` and `SMSG_ATTACKSWING_BADFACING`
 * (module/PROTOCOL.md, "Swing errors").
 *
 * It FAILS against any worldserver built before the tap: both opcodes fall to
 * the drop census and the waits below time out. Run it only after the image
 * is deployed: it is the gate for that build.
 *
 * What it proves, in the order the core's latch (`m_swingErrorMsg`,
 * `Player::Update`) makes necessary:
 *
 *   1. Fresh login, so the latch is clear. Arm auto-attack at a Kobold Vermin
 *      well beyond melee range: `SMSG_ATTACKSTART`, then exactly ONE
 *      `SMSG_ATTACKSWING_NOTINRANGE` although the core refuses the swing every
 *      100 ms for the whole hold. No `SMSG_ATTACKSTOP`: melee stays armed.
 *   2. Stop, and arm again out of range: NOTHING. The latch survives
 *      `attack_stop`, so silence does not mean "in range" — the property
 *      PROTOCOL.md and CONTRACTS.md tell a consumer to respect.
 *   3. Stop, walk to 3.5y from the kobold (inside melee range, outside the 2y
 *      boundary radius where the core skips the facing check), turn the back
 *      to it, arm: exactly ONE `SMSG_ATTACKSWING_BADFACING`.
 *
 * Both events must carry an empty payload: the packets are bodiless and the
 * module adds nothing.
 *
 * A player's `CMSG_ATTACKSWING` does not engage the creature (`Unit::Attack`
 * engages only for creature attackers), so the kobold stays where it is until
 * a swing lands — and none is meant to. Kobolds wander, though, so step 3
 * re-measures after the walk and retries when the kobold has moved out of the
 * band or a swing landed after all; a contaminated hold is retried, never
 * accepted.
 *
 * Arc: throwaway Human Warrior placed by `vineyard-kill-credit` (level 1 at
 * the Northshire vineyard edge, Kobold Vermin in view) -> login -> steps 1-3
 * -> logout and delete.
 *
 * Run from inside the network:
 *   docker compose -f infra/compose.yml exec runner bun infra/smoke/swing-errors.ts
 */

import { connect, isEvent, type UnitView, type WrathClient } from "../../sdk/src/index";
import { applyScenario, deleteFixtureCharacters, ensureFixtureCharacter, type FixtureContext } from "./lib/fixture";
import { probeName } from "./lib/name";
import { authHeaders, MODULE_SECRET } from "./lib/auth";
import { moduleBase } from "./lib/module";

const BASE = moduleBase();
const ACCOUNT = process.env.MODULE_ACCOUNT ?? "PROBE";
const TOKEN = `smoke-swing-errors-${crypto.randomUUID()}`;
const CHARACTER = probeName("Bs");
const SCENARIO = "vineyard-kill-credit";
const KOBOLD_VERMIN = 6;

const NOT_IN_RANGE = "SMSG_ATTACKSWING_NOTINRANGE";
const BAD_FACING = "SMSG_ATTACKSWING_BADFACING";

/**
 * Melee range is at least NOMINAL_MELEE_RANGE (5y, centre to centre); a
 * wandering kobold walks 2.5y/s. From 12y it cannot be in range inside the
 * hold, so one error in step 1 means one error.
 */
const FAR_MIN_Y = 12;
/** Inside melee range (>= 5y) and outside the boundary radius (max(bounding radius, 2y)). */
const STAND_Y = 3.5;
const BAND_MIN_Y = 2.6;
const BAND_MAX_Y = 4.4;
/** ~25 refused swings at the core's 100 ms retry: an unlatched tap would flood this. */
const HOLD_MS = 2_500;
const REPLY_MS = 5_000;
const FACING_ATTEMPTS = 5;

const started = Date.now();
const log = (m: string) => console.log(`[swing-errors +${((Date.now() - started) / 1000).toFixed(1).padStart(5)}s] ${m}`);
function fail(m: string): never {
  throw new Error(m);
}

const health = await fetch(`${BASE}/health`, { headers: authHeaders() }).then((r) => r.json() as Promise<any>);
if (!health?.ok) fail(`health not ok: ${JSON.stringify(health)}`);
log(`health ok: build=${health.build ?? "?"}, character=${CHARACTER} on ${ACCOUNT}`);

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
    const c = await connect({ baseUrl: BASE, token: `${TOKEN}-create`, secret: MODULE_SECRET });
    try {
      await c.createSession({ account: ACCOUNT, character: CHARACTER, race: 1, class: 1 });
      await c.logout();
    } finally {
      c.close();
    }
  },
};

/** Everything swing-related the stream said, in order, from one handler set. */
type Seen = { seq: number; kind: "notInRange" | "badFacing" | "ownSwing" | "ownStart" | "ownStop"; data: unknown };

function watch(client: WrathClient): Seen[] {
  const seen: Seen[] = [];
  const me = () => client.state.self.guid;
  client.events.on(NOT_IN_RANGE, (e) => seen.push({ seq: e.seq, kind: "notInRange", data: e.data }));
  client.events.on(BAD_FACING, (e) => seen.push({ seq: e.seq, kind: "badFacing", data: e.data }));
  client.events.on("SMSG_ATTACKERSTATEUPDATE", (e) => {
    if ((e.data as any).attackerGuid === me()) seen.push({ seq: e.seq, kind: "ownSwing", data: e.data });
  });
  client.events.on("SMSG_ATTACKSTART", (e) => {
    if ((e.data as any).attackerGuid === me()) seen.push({ seq: e.seq, kind: "ownStart", data: e.data });
  });
  client.events.on("SMSG_ATTACKSTOP", (e) => {
    if ((e.data as any).attackerGuid === me()) seen.push({ seq: e.seq, kind: "ownStop", data: e.data });
  });
  return seen;
}

const lastSeq = (client: WrathClient): number => client.events.recent(1)[0]?.seq ?? -1;
const since = (seen: Seen[], seq: number, kind: Seen["kind"]): Seen[] => seen.filter((s) => s.seq > seq && s.kind === kind);

async function until(what: string, ms: number, done: () => boolean): Promise<void> {
  const by = Date.now() + ms;
  while (!done()) {
    if (Date.now() > by) fail(`timed out after ${ms}ms waiting for ${what}`);
    await Bun.sleep(50);
  }
}

function vermin(client: WrathClient): UnitView[] {
  return client.state.units({ entry: KOBOLD_VERMIN, alive: true }).filter((u) => u.distance !== undefined && u.x !== undefined && u.y !== undefined);
}

function unit(client: WrathClient, guid: string): UnitView | undefined {
  return client.state.units({ entry: KOBOLD_VERMIN }).find((u) => u.guid === guid);
}

/** Arm auto-attack and wait for the server's own SMSG_ATTACKSTART; a stop instead is a refused target. */
async function arm(client: WrathClient, seen: Seen[], guid: string): Promise<number> {
  const from = lastSeq(client);
  const sent = await client.attackStart(guid);
  if (!sent.ok) fail(`attackStart sent nothing: ${JSON.stringify(sent)}`);
  await until("SMSG_ATTACKSTART for our own attack", REPLY_MS, () => {
    if (since(seen, from, "ownStop").length > 0) fail("the server answered attack_start with SMSG_ATTACKSTOP: the target is not attackable");
    return since(seen, from, "ownStart").length > 0;
  });
  return from;
}

/**
 * Disarm and give the server's SMSG_ATTACKSTOP time to arrive, so the next arm
 * starts from a known state. Not asserted: `Unit::AttackStop` answers nothing
 * when the attack already ended on its own (the victim died or despawned).
 */
async function disarm(client: WrathClient, seen: Seen[]): Promise<void> {
  const from = lastSeq(client);
  await client.attackStop();
  const by = Date.now() + 2_000;
  while (Date.now() < by && since(seen, from, "ownStop").length === 0) await Bun.sleep(50);
}

function assertBodiless(event: Seen, opcode: string): void {
  if (JSON.stringify(event.data) !== "{}") fail(`${opcode} carried ${JSON.stringify(event.data)}; the packet is bodiless and the event must be {}`);
}

let session: WrathClient | undefined;
try {
  await ensureFixtureCharacter(fixtureCtx);
  await applyScenario(fixtureCtx, SCENARIO);
  const client = await connect({ baseUrl: BASE, token: TOKEN, secret: MODULE_SECRET });
  session = client;
  const seen = watch(client);
  await client.createSession({ account: ACCOUNT, character: CHARACTER, race: 1, class: 1 });
  log(`in world as ${CHARACTER}, guid ${client.state.self.guid}`);
  await client.waitForNearby((o) => o.entry?.value === KOBOLD_VERMIN, { timeout: 15_000 });
  await Bun.sleep(1500); // the rest of the create blocks around the vineyard edge

  // 1. Out of range, on a clear latch: one error, however long the swing is refused.
  const far = vermin(client).find((u) => (u.distance ?? 0) >= FAR_MIN_Y) ?? fail(`no live Kobold Vermin at ${FAR_MIN_Y}y or more in view: ${JSON.stringify(vermin(client).map((u) => u.distance))}`);
  log(`step 1: arming at kobold ${far.guid}, ${far.distance?.toFixed(1)}y away`);
  await client.setTarget(far.guid);
  const armed1 = await arm(client, seen, far.guid);
  await until(`${NOT_IN_RANGE} (is this worldserver built with the swing-error tap?)`, REPLY_MS, () => since(seen, armed1, "notInRange").length > 0);
  await Bun.sleep(HOLD_MS);
  const range1 = since(seen, armed1, "notInRange");
  if (since(seen, armed1, "ownSwing").length > 0) fail("a swing landed during the out-of-range hold: the kobold walked into range, rerun");
  if (since(seen, armed1, "badFacing").length > 0) fail(`${BAD_FACING} during the out-of-range hold: the kobold walked into range, rerun`);
  if (range1.length !== 1) fail(`${range1.length} ${NOT_IN_RANGE} events in ${HOLD_MS}ms out of range, expected exactly 1 (the core latches it)`);
  assertBodiless(range1[0]!, NOT_IN_RANGE);
  if (since(seen, armed1, "ownStop").length > 0) fail("SMSG_ATTACKSTOP followed the range error; the core keeps melee armed");
  log(`PASS out of range: one ${NOT_IN_RANGE} at seq ${range1[0]!.seq}, payload {}, attack still armed`);

  // 2. The latch survives attack_stop: a second out-of-range attack says nothing.
  await disarm(client, seen);
  const farAgain = vermin(client).find((u) => (u.distance ?? 0) >= FAR_MIN_Y) ?? fail(`no live Kobold Vermin at ${FAR_MIN_Y}y or more in view for the second arm`);
  const armed2 = await arm(client, seen, farAgain.guid);
  await Bun.sleep(HOLD_MS);
  if (since(seen, armed2, "ownSwing").length > 0) fail("a swing landed during the second out-of-range hold: the kobold walked into range, rerun");
  const range2 = since(seen, armed2, "notInRange");
  if (range2.length !== 0) fail(`${range2.length} ${NOT_IN_RANGE} events on the second out-of-range arm, expected none: the latch should still hold from step 1`);
  log(`PASS latch: re-armed out of range at kobold ${farAgain.guid} and the stream stayed silent`);
  await disarm(client, seen);

  // 3. In range with the back turned: one facing error.
  let facing: Seen | undefined;
  // A kobold we hit by accident is now fighting us and will not hold still.
  const engaged = new Set<string>();
  for (let attempt = 1; attempt <= FACING_ATTEMPTS && facing === undefined; attempt++) {
    const target = vermin(client).find((u) => !engaged.has(u.guid)) ?? fail("no live, unengaged Kobold Vermin in view for the facing step");
    const self = client.state.self.position?.value ?? fail("own position unobserved");
    const dx = self.x - target.x!;
    const dy = self.y - target.y!;
    const d = Math.hypot(dx, dy);
    if (d < 0.1) fail("standing on top of the kobold; cannot pick a side to stand on");
    // A point STAND_Y from the kobold on the line back toward us.
    const stand = { x: target.x! + (dx / d) * STAND_Y, y: target.y! + (dy / d) * STAND_Y, z: target.z ?? self.z };
    const moved = await client.moveTo(stand, { timeout: 30_000 });
    if (!moved.ok) fail(`moveTo the standing point failed: ${JSON.stringify(moved)}`);
    await Bun.sleep(300);
    const now = unit(client, target.guid);
    const here = client.state.self.position?.value ?? fail("own position unobserved after the walk");
    if (now?.x === undefined || now.y === undefined || now.dead === true) {
      log(`  attempt ${attempt}: the kobold is gone, picking again`);
      continue;
    }
    const gap = Math.hypot(here.x - now.x, here.y - now.y);
    if (gap < BAND_MIN_Y || gap > BAND_MAX_Y) {
      log(`  attempt ${attempt}: the kobold wandered (${gap.toFixed(1)}y, want ${BAND_MIN_Y}-${BAND_MAX_Y}y), walking again`);
      continue;
    }
    // Directly away from it: 180 degrees off, far outside the 120 degree front arc.
    const away = (Math.atan2(here.y - now.y, here.x - now.x) + 2 * Math.PI) % (2 * Math.PI);
    await client.face(away);
    await Bun.sleep(300); // let the server apply the facing before the first swing check
    log(`  attempt ${attempt}: ${gap.toFixed(1)}y from kobold ${target.guid}, facing ${away.toFixed(2)} (away), arming`);
    await client.setTarget(target.guid);
    const armed3 = await arm(client, seen, target.guid);
    const by = Date.now() + REPLY_MS;
    while (Date.now() < by && since(seen, armed3, "badFacing").length === 0 && since(seen, armed3, "ownSwing").length === 0) await Bun.sleep(50);
    await Bun.sleep(HOLD_MS);
    const facings = since(seen, armed3, "badFacing");
    const swung = since(seen, armed3, "ownSwing").length > 0;
    const contaminated = swung || since(seen, armed3, "notInRange").length > 0;
    await disarm(client, seen);
    if (swung) engaged.add(target.guid);
    if (contaminated) {
      // The kobold moved under us: a swing landed (which clears the latch) or
      // it left range (a legitimate new range error). Neither is this step.
      log(`  attempt ${attempt}: the kobold moved during the hold (swing landed or range error), retrying`);
      continue;
    }
    if (facings.length === 0) {
      log(`  attempt ${attempt}: no ${BAD_FACING} within ${REPLY_MS + HOLD_MS}ms and no swing either, retrying`);
      continue;
    }
    if (facings.length !== 1) fail(`${facings.length} ${BAD_FACING} events in one clean hold, expected exactly 1 (the core latches it)`);
    assertBodiless(facings[0]!, BAD_FACING);
    facing = facings[0];
  }
  if (facing === undefined) fail(`never observed ${BAD_FACING} in ${FACING_ATTEMPTS} attempts (is this worldserver built with the swing-error tap?)`);
  log(`PASS facing away: one ${BAD_FACING} at seq ${facing.seq}, payload {}`);

  // Both must be typed events to this SDK revision, not UnknownEvent passthroughs.
  for (const opcode of [NOT_IN_RANGE, BAD_FACING] as const) {
    const ev = client.events.recent().find((e) => e.opcode === opcode);
    if (ev !== undefined && !isEvent(ev, opcode)) fail(`${opcode} did not decode against the SDK schema: ${JSON.stringify(ev)}`);
  }
  console.log(`PASS: swing-errors (${((Date.now() - started) / 1000).toFixed(1)}s)`);
} catch (e) {
  console.log(`FAIL: ${String(e instanceof Error ? (e.stack ?? e.message) : e)}`);
  process.exitCode = 1;
} finally {
  await session?.attackStop().catch(() => {});
  await session?.logout().catch(() => {});
  session?.close();
  await deleteFixtureCharacters(fixtureCtx, [CHARACTER]);
}
