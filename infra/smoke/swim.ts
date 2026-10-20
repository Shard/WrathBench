/**
 * Swimming, as a client swims: a character crosses the open sea north of
 * Menethil Harbor and back, and a second character on the shore watches it
 * go in and come out (module/PROTOCOL.md, `move_to`, "Swimming").
 *
 * The route (infra/fixtures/scenarios.ts `SWIM_SHORE`, read off the server
 * data's terrain and liquid grid): from the shore into the sea, three legs out
 * along it to about (-3040, -721), three legs back to the shore. The sea is 8
 * to 35 yards deep from x -3590 outward, so all but the first and last few
 * yards are swum, about 250 seconds of it: longer than the 180s breath timer
 * (WaterBreath.Timer), so a body sent deeper than its own height would run
 * out of breath and take drowning damage before the end.
 *
 * Asserts, and exits 1 on any miss:
 *   1. the swim flag: the observer receives the swimmer's MSG_MOVE_START_SWIM
 *      on the way in, carrying MOVEMENTFLAG_SWIMMING, and its MSG_MOVE_STOP_SWIM
 *      on the way out, without it. These are the swimmer's own packets as
 *      the server accepted and relayed them, the same any client nearby sees;
 *   2. the pace: on each all-water leg (the four between the first and the
 *      last) the swimmer's own progress points advance at 4.0-5.5 y/s, the
 *      4.72 y/s base swim speed and not the 7 y/s run speed (a fixture
 *      character carries no speed aura);
 *   3. no breath or drowning damage: every progress point of the all-water
 *      legs sits 1.0-2.0 yards under the sea's surface (in the water, not on
 *      it, and short of the 2.03 a human's collision height puts the breath
 *      timer at), and the swimmer's health at the end is what it was at the
 *      start, alive.
 * Every leg must also arrive.
 *
 * An operator smoke, never a startup or deploy smoke (it takes about six
 * minutes): run it on demand once a release carries the module, on two
 * accounts because the module holds one session per account.
 *
 *   bun wb smoke swim
 *   bun wb --local smoke swim   # the quickstart
 *
 * MODULE_ACCOUNT (default PROBE) swims, as in every module smoke. The
 * observer is MODULE_ACCOUNT_OBSERVER, default SMOKE3: on the module's
 * allowlist and on neither the preflight gate's accounts (SMOKE, SMOKE2) nor
 * the deploy smokes', and not death-recovery's priest (SMOKE4), so a
 * six-minute watch never collides with the gate. A busy observer account is
 * a FAIL line within seconds naming the account and the variable to set,
 * never a long wait and never a takeover of the other session.
 * SMOKE_CHARACTER / SMOKE_CHARACTER2 name the fixture characters.
 * Coordinates are harness tooling's, not an agent run's (the observation
 * contract does not apply to this script).
 */

import { connect, type MovePoint, type MoveResultData, type StreamEvent, type WrathClient } from "../../sdk/src/index";
import { SCENARIOS, SWIM_SEA_LEVEL, SWIM_SHORE, type ScenarioName } from "../fixtures/scenarios";
import { accountFixtureName, applyScenario, characterNames, ensureFixtureCharacter, type FixtureContext } from "./lib/fixture";
import { authHeaders, MODULE_SECRET } from "./lib/auth";
import { moduleBase } from "./lib/module";

const BASE = moduleBase();
const SWIMMER_ACCOUNT = process.env.MODULE_ACCOUNT ?? "PROBE";
const OBSERVER_ACCOUNT = process.env.MODULE_ACCOUNT_OBSERVER ?? "SMOKE3";
const SWIMMER = process.env.SMOKE_CHARACTER ?? accountFixtureName("Sw", SWIMMER_ACCOUNT);
const OBSERVER = process.env.SMOKE_CHARACTER2 ?? accountFixtureName("Sx", OBSERVER_ACCOUNT);
const RUN = crypto.randomUUID();

const MOVEMENTFLAG_SWIMMING = 0x00200000;
// A leg's verdict: 224y at 4.72 y/s is 47s; the SDK's own default leaves slack.
const MOVE_TIMEOUT_MS = 135_000;
const SWIM_PACE_MIN = 4.0;
const SWIM_PACE_MAX = 5.5;
// Under the surface, and short of a human's collision height (2.03128,
// DEFAULT_COLLISION_HEIGHT), past which the server runs the breath timer.
const SWIM_DEPTH_MIN = 1.0;
const SWIM_DEPTH_MAX = 2.0;

type Vec = { x: number; y: number; z: number };
type Leg = { name: string; to: MovePoint; allWater: boolean };

const sea = (x: number, y: number): MovePoint => ({ x, y, z: SWIM_SEA_LEVEL });
const LEGS: Leg[] = [
  { name: "in", to: sea(-3480, -800), allWater: false },
  { name: "out 1", to: sea(-3260, -760), allWater: true },
  { name: "out 2", to: sea(-3040, -721), allWater: true },
  { name: "back 1", to: sea(-3260, -760), allWater: true },
  { name: "back 2", to: sea(-3480, -800), allWater: true },
  { name: "ashore", to: { ...SWIM_SHORE }, allWater: false },
];

const started = Date.now();
const log = (m: string): void => console.log(`[swim +${((Date.now() - started) / 1000).toFixed(1).padStart(6)}s] ${m}`);
const fmt = (p: Vec): string => `(${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(2)})`;

class SmokeFailed extends Error {}
function fail(m: string): never {
  throw new SmokeFailed(m);
}

async function createSessionWithBackoff(client: WrathClient, account: string, character: string): Promise<void> {
  // Another probe may hold the account; wait it out (up to 20min).
  const deadline = Date.now() + 20 * 60_000;
  for (;;) {
    try {
      await client.createSession({ account, character, race: 1, class: 1 });
      return;
    } catch (e) {
      const msg = String(e instanceof Error ? e.message : e);
      if (/char_create_failed_code_53/.test(msg)) {
        fail(`${account} is at the realm's ten-character cap, so ${character} cannot be created; delete a spare character or name an existing one`);
      }
      if (!/account_in_use|token_in_use|in use/i.test(msg) || Date.now() > deadline) throw e;
      log(`  ${account} busy (${msg.slice(0, 80)}); retrying in 60s`);
      await Bun.sleep(60_000);
    }
  }
}

const observerBusyHint =
  " — the observer needs an account nothing else is logged into; set MODULE_ACCOUNT_OBSERVER to a free SMOKE account on the module's allowlist";

// The observer's login, as death-recovery's priest's. POST /session never
// answers account_in_use — it takes the account over from whatever holds it —
// so a busy account is caught first by POST /characters, the read-only call
// that does answer account_in_use (characterNames: one short retry, then a
// FAIL), and only a free one is logged into.
async function observerLogin(client: WrathClient, ctx: FixtureContext): Promise<void> {
  await characterNames(ctx);
  try {
    await client.createSession({ account: OBSERVER_ACCOUNT, character: OBSERVER, race: 1, class: 1 });
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "token_in_use" || code === "timeout") {
      fail(`observer account ${OBSERVER_ACCOUNT} did not come free for the login (${code})${observerBusyHint}`);
    }
    if (code === "unknown_account" || code === "account_not_permitted") {
      fail(`observer account ${OBSERVER_ACCOUNT} is not usable (${code}): it must exist (bun wb accounts ensure ${OBSERVER_ACCOUNT}) and be on worldserver.accounts`);
    }
    throw e;
  }
}

function fixtureCtx(account: string, character: string, tag: string): FixtureContext {
  const observer = tag === "obs";
  const ctx: FixtureContext = {
    base: BASE,
    account,
    character,
    token: `smoke-swim-${tag}-${RUN}`,
    log,
    fail: observer ? (msg: string) => fail(`observer account ${OBSERVER_ACCOUNT}: ${msg}${observerBusyHint}`) : fail,
    // The observer's account is meant to be free: one short retry, then a
    // FAIL, since a busy one is a misconfiguration to report, not something
    // to wait out.
    ...(observer ? { contendedDeadlineMs: 5_000, contendedRetryMs: 5_000 } : {}),
    createAndLogout: async () => {
      const client = await connect({ baseUrl: BASE, token: `smoke-swim-${tag}-${RUN}-create`, secret: MODULE_SECRET });
      try {
        if (observer) await observerLogin(client, ctx);
        else await createSessionWithBackoff(client, account, character);
        await client.logout();
      } finally {
        client.close();
      }
    },
  };
  return ctx;
}

async function placeAndLogin(account: string, character: string, tag: string, scenario: ScenarioName): Promise<WrathClient> {
  const ctx = fixtureCtx(account, character, tag);
  await ensureFixtureCharacter(ctx);
  await applyScenario(ctx, scenario);
  const client = await connect({ baseUrl: BASE, token: `smoke-swim-${tag}-${RUN}-play`, secret: MODULE_SECRET });
  if (tag === "obs") await observerLogin(client, ctx);
  else await createSessionWithBackoff(client, account, character);
  const want = SCENARIOS[scenario].position;
  const deadline = Date.now() + 10_000;
  for (;;) {
    const at = client.state.self.position?.value;
    if (at !== undefined) {
      const off = Math.hypot(at.x - want.x, at.y - want.y, at.z - want.z);
      if (at.map !== want.map || off > 3) {
        fail(`${character}: fixture did not land: map ${at.map} ${fmt(at)}, ${off.toFixed(1)}y from ${fmt(want)} on map ${want.map}`);
      }
      return client;
    }
    if (Date.now() > deadline) fail(`${character}: no self position observed after login`);
    await Bun.sleep(100);
  }
}

function health(client: WrathClient): { current: number; max: number } | undefined {
  return client.state.self.health?.value;
}

/** One leg: a raw `move_to`, its progress points and its verdict. */
async function walk(client: WrathClient, leg: Leg): Promise<{ data: MoveResultData; progress: { pos: Vec; ts: number }[] }> {
  const progress: { pos: Vec; ts: number }[] = [];
  let moveId = -1;
  const off = client.events.on("WB_MOVE_PROGRESS", (e: StreamEvent) => {
    const d = e.data as { moveId?: number; pos?: Vec } | undefined;
    if (d?.moveId === moveId && d.pos) progress.push({ pos: d.pos, ts: e.ts });
  });
  try {
    const ack = await client.moveToAsync(leg.to);
    moveId = ack.moveId;
    const ev = await client.events.waitFor(
      (e) => e.opcode === "WB_MOVE_RESULT" && (e.data as { moveId?: number } | undefined)?.moveId === ack.moveId,
      { timeout: MOVE_TIMEOUT_MS, description: `WB_MOVE_RESULT for the ${leg.name} leg (moveId ${ack.moveId})` },
    );
    return { data: ev.data as MoveResultData, progress };
  } finally {
    off();
  }
}

const health0 = await fetch(`${BASE}/health`, { headers: authHeaders() }).then((r) => r.json() as Promise<{ ok?: boolean; build?: string }>);
if (health0.ok !== true) {
  console.log(`FAIL: module health not ok: ${JSON.stringify(health0)}`);
  process.exit(1);
}
log(`health ok: build=${health0.build ?? "?"}; ${SWIMMER} on ${SWIMMER_ACCOUNT} swims, ${OBSERVER} on ${OBSERVER_ACCOUNT} watches`);

const problems: string[] = [];
const notes: string[] = [];
let swimmer: WrathClient | undefined;
let observer: WrathClient | undefined;
try {
  observer = await placeAndLogin(OBSERVER_ACCOUNT, OBSERVER, "obs", "swim-menethil-observer");
  swimmer = await placeAndLogin(SWIMMER_ACCOUNT, SWIMMER, "swim", "swim-menethil-shore");
  const swimmerGuid = String(swimmer.state.self.guid ?? fail("swimmer has no guid after login"));
  log(`both in world at the shore; swimmer ${fmt(swimmer.state.self.position!.value)}`);

  // Everything the observer is told about the swimmer's movement.
  const seen: { opcode: string; flags: number; pos: Vec }[] = [];
  observer.events.onAny((e) => {
    if (!e.opcode.startsWith("MSG_MOVE")) return;
    const d = e.data as { guid?: unknown; flags?: number; pos?: Vec } | undefined;
    if (d === undefined || String(d.guid) !== swimmerGuid || d.flags === undefined || d.pos === undefined) return;
    seen.push({ opcode: e.opcode, flags: d.flags, pos: d.pos });
  });

  await Bun.sleep(2000); // let the swimmer's own health and the observer's view settle
  const hp0 = health(swimmer) ?? fail("swimmer's health not observed after login");
  log(`swimmer health ${hp0.current}/${hp0.max}`);

  for (const leg of LEGS) {
    const { data, progress } = await walk(swimmer, leg);
    const legStart = progress[0];
    const legEnd = progress[progress.length - 1];
    let pace = "";
    if (data.status !== "arrived") problems.push(`${leg.name}: ended ${data.status} at ${fmt(data.pos)}, not arrived`);
    if (leg.allWater) {
      if (legStart === undefined || legEnd === undefined || legEnd.ts - legStart.ts < 5000) {
        problems.push(`${leg.name}: too few progress points (${progress.length}) to judge the pace`);
      } else {
        let yards = 0;
        for (let i = 1; i < progress.length; i++) {
          const a = progress[i - 1]!.pos;
          const b = progress[i]!.pos;
          yards += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
        }
        const ys = yards / ((legEnd.ts - legStart.ts) / 1000);
        pace = `, ${ys.toFixed(2)} y/s over ${yards.toFixed(0)}y`;
        if (ys < SWIM_PACE_MIN || ys > SWIM_PACE_MAX) {
          problems.push(`${leg.name}: paced ${ys.toFixed(2)} y/s, outside ${SWIM_PACE_MIN}-${SWIM_PACE_MAX} (base swim 4.72, run 7)`);
        }
      }
      const depths = progress.map((p) => SWIM_SEA_LEVEL - p.pos.z);
      const shallow = depths.filter((d) => d < SWIM_DEPTH_MIN).length;
      const deep = depths.filter((d) => d > SWIM_DEPTH_MAX).length;
      if (depths.length > 0) pace += `, ${Math.min(...depths).toFixed(2)}-${Math.max(...depths).toFixed(2)}y under the surface`;
      if (shallow > 0) problems.push(`${leg.name}: ${shallow} of ${depths.length} progress points within ${SWIM_DEPTH_MIN}y of the surface (on the water, not in it)`);
      if (deep > 0) problems.push(`${leg.name}: ${deep} of ${depths.length} progress points deeper than ${SWIM_DEPTH_MAX}y (breath timer territory)`);
    }
    log(`  ${leg.name} -> ${fmt(leg.to as Vec)}: ${data.status} at ${fmt(data.pos)}${data.pathLength !== undefined ? `, route ${data.pathLength.toFixed(0)}y` : ""}${pace}`);
  }

  await Bun.sleep(3000); // the regen tick and any late damage land before the reading
  const hp1 = health(swimmer) ?? fail("swimmer's health not observed at the end");
  log(`swimmer health ${hp1.current}/${hp1.max}`);
  if (hp1.current <= 0) problems.push("the swimmer is dead");
  else if (hp1.current < hp0.current) problems.push(`the swimmer lost health in the water: ${hp0.current} -> ${hp1.current}`);

  const starts = seen.filter((m) => m.opcode === "MSG_MOVE_START_SWIM");
  const stops = seen.filter((m) => m.opcode === "MSG_MOVE_STOP_SWIM");
  const swimmingBeats = seen.filter((m) => m.opcode === "MSG_MOVE_HEARTBEAT" && (m.flags & MOVEMENTFLAG_SWIMMING) !== 0).length;
  notes.push(
    `observer saw ${seen.length} of the swimmer's movement packets: ${starts.length} MSG_MOVE_START_SWIM, ${stops.length} MSG_MOVE_STOP_SWIM, ${swimmingBeats} heartbeats flagged swimming`,
  );
  if (starts.length === 0) problems.push("the observer never saw the swimmer's MSG_MOVE_START_SWIM");
  else if (starts.some((m) => (m.flags & MOVEMENTFLAG_SWIMMING) === 0)) problems.push("a relayed MSG_MOVE_START_SWIM lacks MOVEMENTFLAG_SWIMMING");
  if (stops.length === 0) problems.push("the observer never saw the swimmer's MSG_MOVE_STOP_SWIM");
  else if (stops.some((m) => (m.flags & MOVEMENTFLAG_SWIMMING) !== 0)) problems.push("a relayed MSG_MOVE_STOP_SWIM still carries MOVEMENTFLAG_SWIMMING");
  for (const m of [...starts, ...stops]) notes.push(`  ${m.opcode} flags 0x${m.flags.toString(16)} at ${fmt(m.pos)}`);
} catch (e) {
  problems.push(e instanceof Error ? e.message : String(e));
} finally {
  for (const c of [swimmer, observer]) {
    if (c === undefined) continue;
    await c.logout().catch(() => {});
    c.close();
  }
}

for (const n of notes) console.log(n);
const elapsed = ((Date.now() - started) / 1000).toFixed(1);
if (problems.length > 0) {
  for (const p of problems) console.log(`FAIL: ${p}`);
  console.log(`build=${health0.build ?? "?"} (${elapsed}s)`);
  process.exitCode = 1;
} else {
  console.log(`PASS: swim (build=${health0.build ?? "?"}, ${elapsed}s)`);
}
