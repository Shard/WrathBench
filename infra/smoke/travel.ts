/**
 * Navigation gate (FOLLOW-UPS item 38 N1): a fresh Dwarf walks Coldridge
 * Valley -> Coldridge Pass tunnel -> Kharanos -> Ironforge -> Tinker Town,
 * enters the Deeprun Tram portal, boards a tram car, rides it to the Stormwind
 * end, steps off, and takes the exit portal into Stormwind. Every leg must end
 * in a *typed* success — `arrived`, or `transferred` onto the expected map —
 * and the script exits 0 only when all of them do. No z-ladder, no midpoint
 * subdivision, no sleeping to "let a teleport land": the module owns pathing
 * detail (mesh z, subdivision, areatriggers, transport offsets) and the SDK
 * waits on server postconditions (`waitForTransfer`, `WB_RIDE_PROGRESS`).
 *
 * Waypoints are hardcoded from spawn-table landmarks and the areatrigger /
 * transport DBC rows (harness tooling, not an agent run; the observation
 * contract does not apply to this script). Hops stay under the module's 250y
 * `move_to` cap.
 *
 * Run:
 *   docker compose -f infra/compose.yml exec runner bun infra/smoke/travel.ts
 */

import { connect, type MovePoint, type MoveResult } from "../../sdk/src/index";

const BASE = `http://${process.env.MODULE_HOST ?? "worldserver"}:${process.env.MODULE_PORT ?? "8086"}`;
// Long-lived probe sessions use the PROBE account, never RUNNER: the module
// allows one live session per account and RUNNER belongs to the runner track.
const ACCOUNT = process.env.MODULE_ACCOUNT ?? "PROBE";
// Session tokens must be at least 32 characters (POST /session rejects
// shorter ones with weak_token); randomUUID keeps them unguessable too.
const TOKEN = `smoke-travel-${crypto.randomUUID()}`;
const CHARACTER = "Tr" + Date.now().toString(26).replace(/[0-9]/g, (d) => "ghijklmnop"[+d] ?? "g").slice(-8);

const started = Date.now();
const log = (m: string) =>
  console.log(`[travel +${((Date.now() - started) / 1000).toFixed(1).padStart(6)}s] ${m}`);

const dist2d = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y);
const fmt = (p: { x: number; y: number; z: number }) =>
  `(${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)})`;

interface Waypoint extends MovePoint {
  name: string;
}

// Landmarks are creature spawn coordinates from the world DB (things that
// demonstrably stand on the walkable mesh), plus the areatrigger_teleport
// arrival point for the tram portal mouth.
const LEGS: { name: string; waypoints: Waypoint[] }[] = [
  {
    name: "leg1: Coldridge Valley -> tunnel -> Kharanos",
    waypoints: [
      { name: "valley road (Coldridge Mountaineer)", x: -6115.1, y: 372.3, z: 395.6 },
      { name: "tunnel south mouth (Wren Darkspring)", x: -6049.4, y: 383.6, z: 399.0 },
      { name: "tunnel interior (interpolated)", x: -6055.0, y: 210.0, z: 403.0 },
      { name: "tunnel north exit (Battlemaster)", x: -6033.9, y: 47.5, z: 406.4 },
      { name: "road east of tunnel (Mountaineer)", x: -5907.9, y: 27.7, z: 367.4 },
      { name: "road descent (Crag Boar)", x: -5774.2, y: -142.6, z: 354.2 },
      { name: "road south bend (Crag Boar)", x: -5742.8, y: -283.6, z: 358.3 },
      { name: "Kharanos approach (Mountaineer)", x: -5683.3, y: -482.6, z: 395.9 },
      { name: "Kharanos crossroads (Mountaineer)", x: -5610.7, y: -490.1, z: 397.5 },
    ],
  },
  {
    name: "leg2: Kharanos -> Ironforge gates -> Tinker Town tram entrance",
    waypoints: [
      { name: "road NE of Kharanos (Mountaineer)", x: -5550.9, y: -462.2, z: 407.7 },
      { name: "road (Mountaineer)", x: -5449.4, y: -509.0, z: 397.4 },
      { name: "gates approach (Mountaineer)", x: -5267.9, y: -513.3, z: 388.7 },
      { name: "gate mouth (interpolated)", x: -5185.0, y: -585.0, z: 398.0 },
      { name: "entrance hall mid 1 (interpolated)", x: -5120.0, y: -680.0, z: 435.0 },
      { name: "entrance hall mid 2 (interpolated)", x: -5030.0, y: -810.0, z: 470.0 },
      { name: "the Commons (Lieutenant Rotimer)", x: -4903.0, y: -968.2, z: 501.5 },
      { name: "Tinker Town (Emissary Jademoon)", x: -4818.9, y: -1176.4, z: 502.3 },
      { name: "tram portal mouth (areatrigger 2166 arrival)", x: -4839.0, y: -1318.5, z: 501.9 },
    ],
  },
];

// AreaTrigger.dbc / areatrigger_teleport rows (world DB, verified 2026-08-22):
//   2175  map 0   (-4840.26, -1330.46, 508.17) r10 -> map 369 (69.25, 10.26, -4.30)   IF -> tram
//   2171  map 369 (80.16, 2490.88, -1.86)      r10 -> map 0   (-8364.57, 535.98, 91.80) tram -> SW
const IF_PORTAL = { x: -4840.3, y: -1330.5, z: 502.0 };
const TRAM_MAP = 369;
const TRAM_IF_PLATFORM = { map: TRAM_MAP, x: 69.25, y: 10.26, z: -4.3 };
const SW_PORTAL = { x: 78.5, y: 2490.9, z: -4.3 };
const SW_ARRIVAL = { map: 0, x: -8364.57, y: 535.98, z: 91.8 };

// Deeprun Tram cars (gameobject_template type 11, displayId 3831, map 369;
// `gameobject` spawn rows verified 2026-08-22): two trains of three cars, one
// per lane. Lane A (entries 176080/176081/176085) spawns at x≈4.5, y≈28/8/-11;
// lane B (176082/176083/176084) at x≈-45.4 at the Stormwind end. Each train
// runs the full IF<->SW round trip (TransportAnimation.dbc period 143.3s,
// ~54s per direction). The platform floor is z≈-4.3; the car floor matches.
const TRAM_CARS = new Set([176080, 176081, 176082, 176083, 176084, 176085]);
const BOARDING_POINTS: MovePoint[] = [
  { x: 4.5, y: 8.4, z: -4.3 }, // lane A, middle car's home slot
  { x: -45.4, y: 10.0, z: -4.3 }, // lane B, where its middle car parks at the IF end
];
const SW_END_Y = 2400; // the ride has reached the Stormwind end once y is past this

interface HopLog {
  leg: string;
  hop: string;
  target: MovePoint;
  status: string;
  position: { x: number; y: number; z: number; map?: number };
  ms: number;
  ok: boolean;
}
const hopLogs: HopLog[] = [];
const opcodesSeen = new Map<string, number>();

const client = await connect({ baseUrl: BASE, token: TOKEN });
client.events.onAny((e: any) => {
  const op = e?.opcode ?? "?";
  opcodesSeen.set(op, (opcodesSeen.get(op) ?? 0) + 1);
});

const selfPos = () => client.state.self.position?.value;

class LegFailure extends Error {}

async function tryMove(leg: string, name: string, target: MovePoint, timeout = 90_000): Promise<MoveResult> {
  const t0 = Date.now();
  const r = await client.moveTo(target, { timeout });
  const ms = Date.now() - t0;
  const here = selfPos();
  log(
    `  move_to ${fmt(target)} -> ${r.status} at ${fmt(r.position)} ` +
      `(${dist2d(r.position, target).toFixed(1)}y short, ${(ms / 1000).toFixed(1)}s)` +
      (r.ok && r.status === "arrived" && r.meshZ !== undefined ? ` meshZ=${r.meshZ.toFixed(1)}` : "") +
      (r.ok && r.status === "arrived" && r.onTransport ? ` onTransport=${r.onTransport.entry}` : "") +
      (r.ok && r.status === "transferred" ? ` -> map ${r.to.map} ${fmt(r.to)}` : "") +
      (!r.ok && r.hint ? `\n    hint: ${r.hint}` : ""),
  );
  hopLogs.push({
    leg,
    hop: name,
    target,
    status: r.status,
    position: { x: r.position.x, y: r.position.y, z: r.position.z, map: here?.map },
    ms,
    ok: r.ok,
  });
  return r;
}

/** A walking hop: only `arrived` within 8y is success. Anything else is a typed failure. */
async function hop(leg: string, wp: Waypoint): Promise<void> {
  const here = selfPos();
  log(`hop -> ${wp.name} ${fmt(wp)}${here ? ` (${dist2d(here, wp).toFixed(0)}y away)` : ""}`);
  const r = await tryMove(leg, wp.name, wp);
  if (r.ok && r.status === "arrived" && dist2d(r.position, wp) < 8) return;
  throw new LegFailure(`${leg}: hop "${wp.name}" ended ${r.status} at ${fmt(r.position)}`);
}

/** A portal hop: only `transferred` onto `expectMap` near `expectAt` is success. */
async function portal(leg: string, name: string, target: MovePoint, expectMap: number, expectAt: MovePoint): Promise<void> {
  log(`portal -> ${name} ${fmt(target)}`);
  const r = await tryMove(leg, name, target, 60_000);
  if (!(r.ok && r.status === "transferred")) {
    throw new LegFailure(`${leg}: portal "${name}" ended ${r.status} at ${fmt(r.position)}${!r.ok && r.hint ? ` (${r.hint})` : ""}`);
  }
  if (r.to.map !== expectMap) throw new LegFailure(`${leg}: portal "${name}" transferred to map ${r.to.map}, expected ${expectMap}`);
  if (dist2d(r.to, expectAt) > 10) throw new LegFailure(`${leg}: arrival ${fmt(r.to)} is ${dist2d(r.to, expectAt).toFixed(0)}y from the expected ${fmt(expectAt)}`);
  const now = selfPos();
  if (!now || now.map !== expectMap) throw new LegFailure(`${leg}: state.self.position.map is ${now?.map}, expected ${expectMap} after the transfer`);
  const triggers = opcodesSeen.get("WB_AREATRIGGER") ?? 0;
  log(`  transferred: map ${r.to.map} ${fmt(r.to)}; WB_AREATRIGGER seen ${triggers}x so far`);
}

/**
 * Board a tram car: `move_to` a boarding point on each lane in turn until one
 * arrives `onTransport`. A point with no car on it answers `target_off_mesh`
 * (the rail bed is not walkable mesh) or a plain `arrived` on the rails if it
 * is; either just means "no car here yet", and the next attempt follows the
 * next `WB_MOVE_RESULT`, never a sleep. Bounded by one full round trip plus
 * dwell (~3.5 min).
 */
async function board(leg: string): Promise<{ entry: number; at: MovePoint }> {
  const deadline = Date.now() + 210_000;
  let attempt = 0;
  while (Date.now() < deadline) {
    const point = BOARDING_POINTS[attempt++ % BOARDING_POINTS.length]!;
    const r = await tryMove(leg, `board attempt ${attempt}`, point, 30_000);
    if (r.ok && r.status === "arrived" && r.onTransport) {
      if (!TRAM_CARS.has(r.onTransport.entry)) throw new LegFailure(`${leg}: aboard an unexpected transport entry ${r.onTransport.entry}`);
      return { entry: r.onTransport.entry, at: r.position };
    }
    if (r.ok && r.status === "transferred") throw new LegFailure(`${leg}: boarding attempt was transferred to map ${r.to.map}`);
    // No car on that point yet. A transport's approach is not on the event
    // stream (the server animates GO transports client-side, sending no
    // movement), so the only observable is the next boarding verdict: pace
    // the attempts at one per few seconds and alternate lanes.
    await Bun.sleep(3_000);
  }
  throw new LegFailure(`${leg}: no tram car arrived at either boarding point within 210s`);
}

/** Ride until the car has reached the Stormwind end and stopped moving. */
async function ride(leg: string): Promise<MovePoint> {
  log("riding: waiting for WB_RIDE_PROGRESS to pass the Stormwind end");
  let last: { x: number; y: number; z: number } | undefined;
  let stable = 0;
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const ev = await client.events.waitFor((e) => e.opcode === "WB_RIDE_PROGRESS", {
      timeout: Math.max(1, deadline - Date.now()),
      includeBuffered: false,
      description: "WB_RIDE_PROGRESS while riding the tram",
    });
    const pos = (ev.data as { pos: { x: number; y: number; z: number } }).pos;
    if (last && dist2d(pos, last) < 0.1) stable++;
    else stable = 0;
    last = pos;
    if (pos.y > SW_END_Y && stable >= 2) {
      log(`  ride over: car stopped at ${fmt(pos)}`);
      return pos;
    }
  }
  throw new LegFailure(`${leg}: the ride did not reach the Stormwind end within 180s (last ${last ? fmt(last) : "?"})`);
}

async function createSessionWithBackoff(): Promise<void> {
  // Another probe may hold the single PROBE session; wait it out (up to 20min).
  const deadline = Date.now() + 20 * 60_000;
  for (;;) {
    try {
      await client.createSession({ account: ACCOUNT, character: CHARACTER, race: 3, class: 1 });
      return;
    } catch (e) {
      const msg = String(e instanceof Error ? e.message : e);
      if (!/account_in_use|token_in_use|in use/i.test(msg) || Date.now() > deadline) throw e;
      log(`account busy (${msg.slice(0, 80)}); retrying in 60s`);
      await Bun.sleep(60_000);
    }
  }
}

let exitCode = 0;
const legTimes: [string, number][] = [];
try {
  await createSessionWithBackoff();
  const spawn = selfPos();
  log(`in world as ${CHARACTER} (Dwarf Warrior) at ${spawn ? fmt(spawn) : "?"} map ${spawn?.map}`);

  for (const leg of LEGS) {
    log(`=== ${leg.name} ===`);
    const legStart = Date.now();
    for (const wp of leg.waypoints) await hop(leg.name, wp);
    legTimes.push([leg.name, Date.now() - legStart]);
    log(`=== ${leg.name}: complete in ${((Date.now() - legStart) / 1000).toFixed(0)}s ===`);
  }

  // Leg 3: the portal into the tram (areatrigger 2175 fires on entry).
  {
    const name = "leg3: Ironforge tram portal";
    log(`=== ${name} ===`);
    const t0 = Date.now();
    await portal(name, "IF portal (areatrigger 2175)", IF_PORTAL, TRAM_MAP, TRAM_IF_PLATFORM);
    if ((opcodesSeen.get("WB_AREATRIGGER") ?? 0) < 1) throw new LegFailure(`${name}: transferred without a WB_AREATRIGGER on the stream`);
    legTimes.push([name, Date.now() - t0]);
  }

  // Leg 4: board a car.
  let boarded: { entry: number; at: MovePoint };
  {
    const name = "leg4: board the tram";
    log(`=== ${name} ===`);
    const t0 = Date.now();
    // From the portal arrival to the lane: an ordinary mesh walk first, so the
    // boarding leg itself is a short straight line onto the car.
    await hop(name, { name: "platform edge by lane A", x: 16.0, y: 8.4, z: -4.3 });
    boarded = await board(name);
    log(`  aboard car ${boarded.entry} at ${fmt(boarded.at)}`);
    legTimes.push([name, Date.now() - t0]);
  }

  // Leg 5: ride to the Stormwind end.
  let parked: MovePoint;
  {
    const name = "leg5: ride IF -> SW";
    log(`=== ${name} ===`);
    const t0 = Date.now();
    parked = await ride(name);
    const now = selfPos();
    if (!now || now.map !== TRAM_MAP || now.y < SW_END_Y) throw new LegFailure(`${name}: state.self.position ${now ? fmt(now) : "?"} is not at the SW end`);
    legTimes.push([name, Date.now() - t0]);
  }

  // Leg 6: step off, walk to the exit portal (areatrigger 2171), arrive in Stormwind.
  {
    const name = "leg6: disembark -> Stormwind portal";
    log(`=== ${name} ===`);
    const t0 = Date.now();
    const off = { x: parked.x + 12, y: parked.y, z: -4.3 };
    const r = await tryMove(name, "step off onto the platform", off, 30_000);
    if (!(r.ok && r.status === "arrived")) throw new LegFailure(`${name}: disembark ended ${r.status}${!r.ok && r.hint ? ` (${r.hint})` : ""}`);
    if (r.onTransport) throw new LegFailure(`${name}: still aboard ${r.onTransport.entry} after stepping off`);
    await hop(name, { name: "SW platform (areatrigger 2173 arrival)", x: 68.3, y: 2490.9, z: -4.3 });
    await portal(name, "SW exit portal (areatrigger 2171)", SW_PORTAL, SW_ARRIVAL.map, SW_ARRIVAL);
    legTimes.push([name, Date.now() - t0]);
  }

  const end = selfPos();
  log(`GATE PASS: ${CHARACTER} is in Stormwind at ${end ? fmt(end) : "?"} map ${end?.map}`);
} catch (e) {
  if (e instanceof LegFailure) log(`GATE FAIL: ${e.message}`);
  else log(`UNEXPECTED FAILURE: ${String(e instanceof Error ? (e.stack ?? e.message) : e)}`);
  exitCode = 1;
} finally {
  // Findings dump: every hop, machine-readable, before cleanup can fail.
  console.log("=== hop log (JSONL) ===");
  for (const h of hopLogs) console.log(JSON.stringify(h));
  for (const [leg, ms] of legTimes) log(`${leg}: ${(ms / 1000).toFixed(0)}s`);
  const statuses = new Map<string, number>();
  for (const h of hopLogs) statuses.set(h.status, (statuses.get(h.status) ?? 0) + 1);
  log(`move statuses: ${[...statuses].map(([k, v]) => `${k}:${v}`).join(" ")}`);
  if (statuses.has("no_path")) log("WARNING: undifferentiated no_path was emitted");
  log(`opcodes seen: ${[...opcodesSeen].map(([k, v]) => `${k}:${v}`).join(" ")}`);

  await client.logout().catch(() => {});
  const gone = await client
    .deleteCharacter(CHARACTER, { account: ACCOUNT, initialDelayMs: 3000 })
    .catch((e: unknown) => String(e));
  log(`cleanup: ${CHARACTER} ${typeof gone === "string" ? gone : "deleted"}`);
  client.close();
  process.exit(exitCode); // open WebSockets hold the event loop
}
