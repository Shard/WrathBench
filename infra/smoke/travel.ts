/**
 * Navigation gate: a fresh Dwarf walks Coldridge
 * Valley -> Coldridge Pass tunnel -> Kharanos -> Ironforge -> Tinker Town,
 * enters the Deeprun Tram portal, boards a tram car, rides it to the Stormwind
 * end, steps off, and takes the exit portal into Stormwind. Every leg must end
 * in a *typed* success — `arrived`, or `transferred` onto the expected map —
 * and the script exits 0 only when all of them do. No z-ladder, no midpoint
 * subdivision, no sleeping to "let a teleport land": the module owns pathing
 * detail (mesh z, subdivision, areatriggers, transport offsets) and the SDK
 * waits on server postconditions (`waitForTransfer`, `WB_RIDE_PROGRESS`,
 * `WB_TRANSPORT_PROGRESS`).
 *
 * Between leg1 and leg2 (leg1b, load-bearing): the character
 * walks into AreaTrigger.dbc 710 at the Kharanos crossroads and keeps moving
 * inside it for >= 5s; exactly one WB_AREATRIGGER for id 710 must appear.
 * Fails against a pre-56 module, which re-fires every 1.5s.
 *
 * Per ride (IF -> SW) the gate asserts, in order:
 *   leg 3  `transferred` to map 369 within 10y of (69.25, 10.26) with at least
 *          one WB_AREATRIGGER on the stream;
 *   leg 4  a car in view flips to `docked` (WB_TRANSPORT_PROGRESS) *before*
 *          boarding succeeds; `arrived` with onTransport.entry in 176080..176085
 *          within BOARDING_BOUND_MS (one tram period and a little, below) of
 *          the walk to the platform edge; the module's audit for this session
 *          holds a `move_transport_leg` with boarding:true, when the audit
 *          directory is readable here (the quickstart's runner mounts data/;
 *          the cluster's runner pod does not mount the worldserver's logs, and
 *          the check is skipped there with a line saying so); only cars docked
 *          on the boarding lane are tried (the other track is 60y away across
 *          the pit). Attempts alternate moveTo(point) and moveTo(car.guid).
 *   leg 5  WB_RIDE_PROGRESS y rises monotonically to > 2400 and the ride
 *          (departure to standstill) takes 50..70s — the upper bound so a car
 *          that rode back is not a pass;
 *   leg 6  disembark `arrived` with onTransport absent, then `transferred` to
 *          map 0 within 10y of (-8364.6, 536.0).
 * Rides after the first return SW -> IF by the same tram (logged, lightly
 * checked) so the gated direction repeats from the Tinker Town portal mouth.
 *
 * Waypoints are hardcoded from spawn-table landmarks and the areatrigger /
 * transport DBC rows (harness tooling, not an agent run; the observation
 * contract does not apply to this script). Hops stay under the module's 250y
 * `move_to` cap.
 *
 * Needs a module that serves WB_TRANSPORT_PROGRESS and gameobject names
 * (built to :next 2026-08-23): it cannot pass against a worldserver older than
 * that, and leg 4's failure says so when no transport report arrived at all.
 * The module reports a car only within the map's view range of the
 * character (100y here) or carrying it, so a car is heard as it pulls in.
 *
 * Two starts:
 *
 *   --from tram-ironforge  the fast one, and the gate's. A persistent fixture
 *     character (default `Smoketram` on MODULE_ACCOUNT, never deleted) is
 *     placed by `infra/fixtures/apply.ts` — level 10, 1g, logged out, standing
 *     on map 0 at the Tinker Town tram portal mouth — and the run starts at
 *     the leg-3 portal step. Legs 1, 1b and 2 are skipped entirely. One ride
 *     is then the wait for the boarding lane's car (anything up to one tram
 *     period, 143s) plus the ~59s crossing. The fixture wait is on top of
 *     that, and lands hardest on back-to-back runs:
 *     apply.ts waits for `characters.online=0`, and the core holds a
 *     logged-out session for up to ~60s (measured 66s, see kill-credit.ts).
 *   --from coldridge, or no --from  the legacy full walk: a fresh throwaway
 *     Dwarf from the Coldridge Valley spawn through legs 1, 1b and 2 first,
 *     deleted at the end. ~2 minutes before the tram legs even begin, and it
 *     has never yet survived them (the level-1 tunnel walk is where the
 *     2026-08-23 gate died).
 *
 * On the fixture path nothing is deleted: the character is the fixture, and
 * `apply.ts` rewrites its rows on every run. The session is still closed with
 * DELETE /session at the end, as on the legacy path.
 *
 * Run (this is N1 of the navigation plan). The module's HTTP port is not
 * published to the host, so the smoke runs inside the runner container:
 *
 *   bun wb smoke travel --from tram-ironforge --rides 3
 *   bun wb --local smoke travel --from tram-ironforge --rides 3   # the quickstart
 *
 * — that is, `bun infra/smoke/travel.ts --from tram-ironforge --rides 3` as
 * seen from inside that container. Nothing is added: MODULE_ACCOUNT defaults to
 * PROBE and the four WRATHBENCH_DB_* vars the direct-bun branch below hands to
 * `infra/fixtures/apply.ts` are on the runner (the chart's dbEnv, compose.yml's *wb-db
 * anchor). That branch assumes it can reach MySQL from the runner image. How the fixture is applied is chosen by
 * the environment; see `fixturesCmd()` in lib/fixture.ts. The legacy walk is
 * the same command without `--from` (and needs no DB env at all).
 */

import { readdir } from "node:fs/promises";
import { probeName } from "./lib/name";
import { connect, type MovePoint, type MoveResult, type UnitView } from "@wrathbench/sdk";
import { applyScenario, ensureFixtureCharacter, type FixtureContext } from "./lib/fixture";
import { MODULE_SECRET } from "./lib/auth";
import { moduleBase } from "./lib/module";
import { smokeToken } from "./lib/session";

const BASE = moduleBase();
// Long-lived probe sessions use the PROBE account, never RUNNER: the module
// allows one live session per account and RUNNER belongs to the runner track.
const ACCOUNT = process.env.MODULE_ACCOUNT ?? "PROBE";
// Session tokens must be at least 32 characters (POST /session rejects
// shorter ones with weak_token); randomUUID keeps them unguessable too.
const TOKEN = smokeToken("travel");
// The module's per-session audit (WrathBench.AuditDir, one
// `<token>.<YYYY-MM-DD>.jsonl` per UTC day; wrath-mcp/module/PROTOCOL.md "Audit log"),
// as the runner container sees the repo mount. Leg 4 reads it for the
// `move_transport_leg` boarding record when it is there (not in the cluster's
// runner pod).
const AUDIT_DIR = process.env.WRATHBENCH_AUDIT_DIR ?? "/wrathbench/data/logs/wrathbench";

const flag = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const RIDES = (() => {
  const raw = flag("--rides");
  const n = raw === undefined ? 1 : Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--rides wants a positive integer, got ${raw}`);
  return n;
})();

/**
 * `--from tram-ironforge` starts from the scenario fixture; `--from coldridge`
 * (or no flag at all) is the legacy walk from the Coldridge Valley spawn.
 * Only these two are meaningful today, and an unknown one is a typo, not a
 * silent fall back to the two-minute walk.
 */
const FROM = (() => {
  const v = flag("--from");
  if (v === undefined || v === "coldridge") return undefined;
  if (v !== "tram-ironforge") throw new Error(`--from wants "tram-ironforge" or "coldridge", got ${JSON.stringify(v)}`);
  return v;
})();

// Fixture runs use a fixed, persistent name so the placed rows survive between
// runs; the legacy walk keeps its throwaway name, which it deletes at the end.
const CHARACTER = FROM
  ? (flag("--character") ?? "Smoketram")
  : probeName("Tr");

const started = Date.now();
const log = (m: string) =>
  console.log(`[travel +${((Date.now() - started) / 1000).toFixed(1).padStart(6)}s] ${m}`);

const dist2d = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y);
const fmt = (p: { x: number; y: number; z: number }) =>
  `(${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)})`;
const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

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
      // Tunnel corridor, from `creature` spawn rows on map 0 between the two
      // mouths (verified 2026-08-23): a straight interpolated midpoint is off
      // the mesh because the pass bends west. Every hop below is < 250y.
      { name: "tunnel bend west (Ragged Young Wolf)", x: -6144.1, y: 268.4, z: 393.6 },
      { name: "tunnel mid (Rockjaw Raider)", x: -6137.6, y: 122.9, z: 420.8 },
      { name: "tunnel north bend (Rockjaw Raider)", x: -6111.4, y: 48.0, z: 412.9 },
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
      // Was (-5120, -680, 435), a straight-line interpolation 16y in the air:
      // the module's route there ended path_incomplete at this point on the
      // road, z 419.0, which is the waypoint now.
      { name: "entrance road (mesh end under the old interpolation)", x: -5121.1, y: -682.7, z: 419.0 },
      // Was (-5030, -810, 470), 25y under the floor the spawn rows there
      // stand on (z 495): an Ironforge Reveler's spawn, 3y from it.
      { name: "entrance hall (Ironforge Reveler)", x: -5029.1, y: -813.1, z: 495.3 },
      { name: "the Commons (Lieutenant Rotimer)", x: -4903.0, y: -968.2, z: 501.5 },
      { name: "Tinker Town (Emissary Jademoon)", x: -4818.9, y: -1176.4, z: 502.3 },
      { name: "tram portal mouth (areatrigger 2166 arrival)", x: -4839.0, y: -1318.5, z: 501.9 },
    ],
  },
];

// AreaTrigger.dbc / areatrigger_teleport rows (world DB, verified 2026-08-23):
//   2175  map 0   (-4840.26, -1330.46, 508.17) r10  -> map 369 (69.25, 10.26, -4.30)    IF -> tram
//   2171  map 369 (80.16, 2490.88, -1.86)      r10  -> map 0   (-8364.57, 535.98, 91.80) tram -> SW
//   2173  map 0   (-8346.46, 514.03, 96.60)    r10  -> map 369 (68.30, 2490.91, -4.30)  SW -> tram
//   2166  map 369 (76.03, 10.50, -4.30) box 9.4x19x20.6 -> map 0 (-4838.95, -1318.46, 501.87) tram -> IF
const TRAM_MAP = 369;
// Areatrigger 2175 is centred at (-4840.26, -1330.46, 508.17) r10, six yards above the
// floor; the mesh ends at (-4842.7, -1329.3), inside the radius. Target the mesh end.
const IF_PORTAL = { x: -4842.7, y: -1329.3, z: 502.0 };
const TRAM_IF_PLATFORM = { map: TRAM_MAP, x: 69.25, y: 10.26, z: -4.3 };
const SW_PORTAL = { x: 78.5, y: 2490.9, z: -4.3 };
const SW_ARRIVAL = { map: 0, x: -8364.57, y: 535.98, z: 91.8 };
const SW_ENTRANCE = { x: -8346.5, y: 514.0, z: 96.6 };
const TRAM_SW_PLATFORM = { map: TRAM_MAP, x: 68.3, y: 2490.9, z: -4.3 };
const IF_EXIT = { x: 76.0, y: 10.5, z: -4.3 };
const IF_ARRIVAL = { map: 0, x: -4838.95, y: -1318.46, z: 501.9 };

// Deeprun Tram cars (gameobject_template type 11 "Subway", displayId 3831,
// map 369): two trains of three cars, one per lane, each shuttling on its
// own lane. Lane A (entries 176080/176081/176085) spawns at x≈4.5, y≈28/8/-11
// at the IF end; lane B (176082/176083/176084) at x≈-45.4, y≈2473–2512 at
// the SW end. The platform floor is z≈-4.3; the car floor matches. The cars
// are observable: `units()` names them, goType "transport", and `docked`
// flips with the DBC clock.
//
// The timing, from TransportAnimation.dbc (rows for these six entries) and
// the core: every car's period is 143333 ms, and every car's clock starts at
// 0 when the map creates it and always advances (StaticTransport::Update; a
// transport is always on the map's update list), so the six share one
// clock. Lane A dwells at the IF end from 129.3–130.3s of it to 0.0–0.9s
// past the wrap (13.0–14.9s), crosses in ~58.6s, and dwells at the SW end
// from 58.6–59.5s to 70.7–71.7s (11.2–13.0s). Lane B runs the same frames
// mirrored, so it is at the IF end while lane A is at the SW end: a car
// docks at each end every ~72s, alternating lanes. This smoke boards only
// its own lane (waitForDockedCar), so its car docks at this end once per
// period, and the leg can start just after it left: up to ~130s of waiting,
// then a boarding walk of a few seconds inside a 13s dwell. The bound is
// one period and 10s.
const TRAM_CARS = new Set([176080, 176081, 176082, 176083, 176084, 176085]);
const TRAM_PERIOD_MS = 143_333;
const IF_BOARDING_POINTS: MovePoint[] = [
  { x: 4.5, y: 8.4, z: -4.3 }, // lane A, middle car's home slot
  { x: -45.4, y: 10.0, z: -4.3 }, // lane B, where its middle car parks at the IF end
];
const SW_BOARDING_POINTS: MovePoint[] = [
  { x: -45.4, y: 2492.0, z: -4.3 },
  { x: 4.5, y: 2490.0, z: -4.3 },
];
const SW_END_Y = 2400; // the ride has reached the Stormwind end once y is past this
const IF_END_Y = 100; // and the Ironforge end once y is below this
const BOARDING_BOUND_MS = TRAM_PERIOD_MS + 10_000; // the boarding lane's car docks at this end once a period
const RIDE_MIN_MS = 50_000;
const RIDE_MAX_MS = 70_000;

/** One direction of the tram, so the gated run and the return share code. */
interface Direction {
  name: string;
  entry: { name: string; target: MovePoint; expectAt: { map: number; x: number; y: number; z: number } };
  platformEdge: Waypoint;
  boardingPoints: MovePoint[];
  /** A car is "at this end" when its y satisfies this. */
  atThisEnd: (y: number) => boolean;
  /** The ride is over once y satisfies this and the car stands still. */
  atFarEnd: (y: number) => boolean;
  /** Which way y runs during the ride: +1 toward Stormwind, -1 toward Ironforge. */
  forward: 1 | -1;
  farPlatform: Waypoint;
  exit: { name: string; target: MovePoint; expectAt: { map: number; x: number; y: number; z: number } };
}
const IF_TO_SW: Direction = {
  name: "IF -> SW",
  entry: { name: "IF portal (areatrigger 2175)", target: IF_PORTAL, expectAt: TRAM_IF_PLATFORM },
  platformEdge: { name: "platform edge by lane A", x: 16.0, y: 8.4, z: -4.3 },
  boardingPoints: IF_BOARDING_POINTS,
  atThisEnd: (y) => y < IF_END_Y,
  atFarEnd: (y) => y > SW_END_Y,
  forward: 1,
  farPlatform: { name: "SW platform (areatrigger 2173 arrival)", ...TRAM_SW_PLATFORM },
  exit: { name: "SW exit portal (areatrigger 2171)", target: SW_PORTAL, expectAt: SW_ARRIVAL },
};
const SW_TO_IF: Direction = {
  name: "SW -> IF (return)",
  entry: { name: "SW entrance portal (areatrigger 2173)", target: SW_ENTRANCE, expectAt: TRAM_SW_PLATFORM },
  platformEdge: { name: "platform edge by lane B", x: -33.0, y: 2492.0, z: -4.3 },
  boardingPoints: SW_BOARDING_POINTS,
  atThisEnd: (y) => y > SW_END_Y,
  atFarEnd: (y) => y < IF_END_Y,
  forward: -1,
  farPlatform: { name: "IF platform (areatrigger 2175 arrival)", ...TRAM_IF_PLATFORM },
  exit: { name: "IF exit portal (areatrigger 2166 box)", target: IF_EXIT, expectAt: IF_ARRIVAL },
};

interface HopLog {
  ride: number;
  leg: string;
  hop: string;
  target: MovePoint | string;
  status: string;
  position: { x: number; y: number; z: number; map?: number };
  onTransport?: number;
  ms: number;
  ok: boolean;
}
const hopLogs: HopLog[] = [];
const opcodesSeen = new Map<string, number>();
/** WB_AREATRIGGER count per trigger id: the linger leg's evidence. */
const triggerHits = new Map<number, number>();
/** Per-car `docked` as last reported, and when it flipped: the leg-4 evidence. */
const dockedAt = new Map<string, { docked: boolean; y: number; ts: number }>();
let transportReports = 0;

const client = await connect({ baseUrl: BASE, token: TOKEN, secret: MODULE_SECRET });
client.events.onAny((e: any) => {
  const op = e?.opcode ?? "?";
  opcodesSeen.set(op, (opcodesSeen.get(op) ?? 0) + 1);
  if (op === "WB_AREATRIGGER" && typeof e?.data?.triggerId === "number") {
    triggerHits.set(e.data.triggerId, (triggerHits.get(e.data.triggerId) ?? 0) + 1);
  }
  if (op === "WB_TRANSPORT_PROGRESS" && e.data?.inRange === false) {
    // The car's last report as it leaves view range: no `docked` after it.
    dockedAt.delete(e.data.guid);
    log(`  transport ${e.data.guid} entry ${e.data.entry} left view range at ${fmt(e.data.pos)}`);
  }
  if (op === "WB_TRANSPORT_PROGRESS" && e.data && typeof e.data.docked === "boolean") {
    transportReports++;
    const prev = dockedAt.get(e.data.guid);
    if (!prev || prev.docked !== e.data.docked) {
      dockedAt.set(e.data.guid, { docked: e.data.docked, y: e.data.pos.y, ts: Date.now() });
      log(`  transport ${e.data.guid} entry ${e.data.entry} ${e.data.docked ? "DOCKED" : "moving"} at ${fmt(e.data.pos)} (${Math.round(e.data.progressMs / 1000)}/${Math.round((e.data.periodMs ?? 0) / 1000)}s)`);
    }
  }
});

const selfPos = () => client.state.self.position?.value;
let currentRide = 0;

class LegFailure extends Error {}

async function tryMove(leg: string, name: string, target: MovePoint | string, timeout = 90_000): Promise<MoveResult> {
  const t0 = Date.now();
  const r = await client.moveTo(target, { timeout });
  const ms = Date.now() - t0;
  const here = selfPos();
  // `unknown_target` (a guid nothing in view answers to) carries no position.
  const pos = r.position ?? here ?? { x: NaN, y: NaN, z: NaN };
  const tgt = typeof target === "string" ? `guid ${target}` : fmt(target);
  log(
    `  move_to ${tgt} -> ${r.status} at ${fmt(pos)} ` +
      `(${typeof target === "string" ? "" : `${dist2d(pos, target).toFixed(1)}y short, `}${secs(ms)})` +
      (r.ok && r.status === "arrived" && r.meshZ !== undefined ? ` meshZ=${r.meshZ.toFixed(1)}` : "") +
      (r.ok && r.status === "arrived" && r.onTransport ? ` onTransport=${r.onTransport.entry}` : "") +
      (r.ok && r.status === "transferred" ? ` -> map ${r.to.map} ${fmt(r.to)}` : "") +
      (!r.ok && r.hint ? `\n    hint: ${r.hint}` : ""),
  );
  hopLogs.push({
    ride: currentRide,
    leg,
    hop: name,
    target,
    status: r.status,
    position: { x: pos.x, y: pos.y, z: pos.z, map: here?.map },
    ...(r.ok && r.status === "arrived" && r.onTransport ? { onTransport: r.onTransport.entry } : {}),
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
  throw new LegFailure(`${leg}: hop "${wp.name}" ended ${r.status} at ${fmt(r.position ?? { x: NaN, y: NaN, z: NaN })}`);
}

/** A portal hop: only `transferred` onto `expectMap` near `expectAt` is success. */
async function portal(leg: string, name: string, target: MovePoint, expectMap: number, expectAt: MovePoint): Promise<void> {
  log(`portal -> ${name} ${fmt(target)}`);
  const triggersBefore = opcodesSeen.get("WB_AREATRIGGER") ?? 0;
  const r = await tryMove(leg, name, target, 60_000);
  if (!(r.ok && r.status === "transferred")) {
    throw new LegFailure(`${leg}: portal "${name}" ended ${r.status} at ${fmt(r.position ?? { x: NaN, y: NaN, z: NaN })}${!r.ok && r.hint ? ` (${r.hint})` : ""}`);
  }
  if (r.to.map !== expectMap) throw new LegFailure(`${leg}: portal "${name}" transferred to map ${r.to.map}, expected ${expectMap}`);
  if (dist2d(r.to, expectAt) > 10) throw new LegFailure(`${leg}: arrival ${fmt(r.to)} is ${dist2d(r.to, expectAt).toFixed(0)}y from the expected ${fmt(expectAt)}`);
  const now = selfPos();
  if (!now || now.map !== expectMap) throw new LegFailure(`${leg}: state.self.position.map is ${now?.map}, expected ${expectMap} after the transfer`);
  const triggers = (opcodesSeen.get("WB_AREATRIGGER") ?? 0) - triggersBefore;
  if (triggers < 1) throw new LegFailure(`${leg}: transferred without a WB_AREATRIGGER on the stream for this portal`);
  log(`  transferred: map ${r.to.map} ${fmt(r.to)}; WB_AREATRIGGER seen ${triggers}x for this portal`);
}

// AreaTrigger.dbc 710: map 0 (-5601.5, -530.7, 395.5) r35, centred on the
// Kharanos crossroads. No world-DB row acts on it (not in
// areatrigger_teleport / _tavern / _involvedrelation / _scripts, verified
// 2026-08-23), so the server ignores the CMSG_AREATRIGGER and the character
// stays inside; it is the volume nav-probe c4 re-fired in every 1.5s.
const LINGER_TRIGGER = { id: 710, x: -5601.5, y: -530.7, z: 395.5, r: 35 };
const LINGER_MS = 5_000;
// Where the linger walks, inside the volume on the crossroads' west side,
// read off the mmaps with Detour at the core's limits: from where leg1 ends
// (41.6y from the centre, outside it) the entry is 36y in a straight line and
// a 38y walk with no step the drop guard refuses, and the two inner points
// are 6-10y straight walks from it and between each other, 24y from the
// centre. The centre itself is on a raised step: the core's route there is
// 119y round the crossroads and ends climbing it 1.9y short, which the guard
// refuses as `drop` (live on harness-0.5-1393; offline, the module before
// #261 refuses it the same way).
const LINGER_ENTRY = { x: -5617.5, y: -525.7, z: 403.7 };
const LINGER_INNER = [
  { x: -5625.5, y: -531.7, z: 405.6 },
  { x: -5625.5, y: -525.7, z: 404.4 },
] as const;

/**
 * Linger leg: crossing into a DBC volume sends
 * CMSG_AREATRIGGER exactly once, as a client does; standing and walking
 * inside it for >= 5s must not re-fire. Walks in to LINGER_ENTRY, then two
 * short hops that stay well inside the radius while the clock passes LINGER_MS, and
 * asserts exactly one WB_AREATRIGGER for this id in that window.
 */
async function lingerInTrigger(leg: string): Promise<void> {
  const t = LINGER_TRIGGER;
  const before = triggerHits.get(t.id) ?? 0;
  const t0 = Date.now();
  await hop(leg, { name: `inside ${t.id} (entry)`, ...LINGER_ENTRY });
  const firstHits = (triggerHits.get(t.id) ?? 0) - before;
  if (firstHits !== 1) throw new LegFailure(`${leg}: entering trigger ${t.id} produced ${firstHits} WB_AREATRIGGER, expected exactly 1`);
  // Keep moving inside the volume (the module only tests triggers while a
  // move is in progress) until LINGER_MS has passed since the entry.
  const inner: Waypoint[] = LINGER_INNER.map((p, n) => ({ name: `inside ${t.id} (inner ${n + 1})`, ...p }));
  let i = 0;
  while (Date.now() - t0 < LINGER_MS) {
    await hop(leg, inner[i++ % inner.length]!);
    const here = selfPos();
    if (here && dist2d(here, t) > t.r - 5) throw new LegFailure(`${leg}: wandered to ${dist2d(here, t).toFixed(0)}y from the trigger centre (radius ${t.r})`);
    await Bun.sleep(1_000);
  }
  const hits = (triggerHits.get(t.id) ?? 0) - before;
  if (hits !== 1) throw new LegFailure(`${leg}: ${hits} WB_AREATRIGGER for trigger ${t.id} over ${secs(Date.now() - t0)} inside its volume, expected exactly 1`);
  log(`  lingered ${secs(Date.now() - t0)} inside trigger ${t.id}: WB_AREATRIGGER seen exactly once`);
}

/** The tram cars `units()` can see right now, with their reported state. */
function carsInView(): UnitView[] {
  return client.state.units({ type: "gameObject" }).filter((u) => u.entry !== undefined && TRAM_CARS.has(u.entry));
}

/** Wait for the next WB_TRANSPORT_PROGRESS that says a car is docked at this end. */
async function waitForDockedCar(dir: Direction, deadline: number): Promise<UnitView | undefined> {
  // Only the boarding lane: the other track's car is "at this end" too, 60y
  // away across the pit, and every attempt at it is an honest drop /
  // path_incomplete (12 wasted attempts on 2026-08-23).
  const lane = dir.boardingPoints[0]!;
  const onLane = (c: { x?: number; y?: number }) => c.x !== undefined && c.y !== undefined && dir.atThisEnd(c.y) && Math.abs(c.x - lane.x) <= 15;
  const already = carsInView().find((c) => c.docked === true && onLane(c));
  if (already) return already;
  try {
    const ev = await client.events.waitFor(
      (e) => {
        if (e.opcode !== "WB_TRANSPORT_PROGRESS") return false;
        const d = e.data as { entry: number; docked?: boolean; pos: { x: number; y: number } };
        return TRAM_CARS.has(d.entry) && d.docked === true && onLane(d.pos);
      },
      { timeout: Math.max(1, deadline - Date.now()), includeBuffered: false, description: "a tram car docked at this end" },
    );
    const guid = (ev.data as { guid: string }).guid;
    return carsInView().find((c) => c.guid === guid);
  } catch {
    return undefined;
  }
}

interface Boarded {
  entry: number;
  guid: string;
  at: MovePoint;
  attempts: number;
  waitedMs: number;
  dockedBeforeBoarding: boolean;
  variant: "point" | "guid";
}

/**
 * Board a tram car. Every attempt waits for a car's WB_TRANSPORT_PROGRESS
 * to say docked at this end — never a sleep — and alternates
 * moveTo(car position) with moveTo(car.guid). Bounded by BOARDING_BOUND_MS.
 */
async function board(leg: string, dir: Direction, firstVariant: "point" | "guid"): Promise<Boarded> {
  const t0 = Date.now();
  const deadline = t0 + BOARDING_BOUND_MS;
  let attempts = 0;

  const check = (r: MoveResult, car: UnitView | undefined, variant: "point" | "guid"): Boarded | undefined => {
    if (r.ok && r.status === "arrived" && r.onTransport) {
      if (!TRAM_CARS.has(r.onTransport.entry)) throw new LegFailure(`${leg}: aboard an unexpected transport entry ${r.onTransport.entry}`);
      const seen = dockedAt.get(r.onTransport.guid);
      return {
        entry: r.onTransport.entry,
        guid: r.onTransport.guid,
        at: r.position,
        attempts,
        waitedMs: Date.now() - t0,
        dockedBeforeBoarding: seen?.docked === true,
        variant,
      };
    }
    if (r.ok && r.status === "arrived") {
      if (car) throw new LegFailure(`${leg}: \`arrived\` at ${fmt(r.position)} with no transport under the character while ${car.name ?? car.guid} was docked`);
      return undefined;
    }
    if (r.ok && r.status === "transferred") throw new LegFailure(`${leg}: boarding attempt was transferred to map ${r.to.map}`);
    return undefined;
  };

  // No no-car probe: the mesh has a gradual route down onto the rail bed
  // (a player can take it too), so "refuses the rail bed" is not a claim the
  // world supports, and the walk costs 45s of the bound (2026-08-23).
  while (Date.now() < deadline) {
    const car = await waitForDockedCar(dir, deadline);
    if (!car || car.x === undefined || car.y === undefined || car.z === undefined) break;
    attempts++;
    const variant: "point" | "guid" = (attempts + (firstVariant === "guid" ? 1 : 0)) % 2 === 0 ? "guid" : "point";
    log(`board attempt ${attempts} (${variant}): ${car.name ?? "?"} entry ${car.entry} guid ${car.guid} docked at ${fmt({ x: car.x, y: car.y, z: car.z })}`);
    const target: MovePoint | string = variant === "guid" ? car.guid : { x: car.x, y: car.y, z: -4.3 };
    const done = check(await tryMove(leg, `board attempt ${attempts} (${variant})`, target, 30_000), car, variant);
    if (done) return done;
    // Typed failure with a car docked: try the other variant on the next
    // report, which arrives within a second while the car is still there.
    await client.events.waitFor((e) => e.opcode === "WB_TRANSPORT_PROGRESS", {
      timeout: Math.max(1, Math.min(3_000, deadline - Date.now())),
      includeBuffered: false,
    }).catch(() => {});
  }
  const silent = transportReports === 0 ? "; no WB_TRANSPORT_PROGRESS for any car all along — no car came within view range, or this worldserver does not serve transport state" : "";
  throw new LegFailure(`${leg}: not aboard within ${secs(BOARDING_BOUND_MS)} (${attempts} attempts)${silent}`);
}

/**
 * The module's audit rows for this session with the given op, read across the
 * session's files in order: a legacy undated `<token>.jsonl` first, should one
 * remain, then the day files ascending (a session that crosses midnight UTC
 * has two). Undefined when the directory is not readable from here.
 */
async function auditRows(op: string): Promise<Record<string, unknown>[] | undefined> {
  const stem = TOKEN.replace(/[^A-Za-z0-9_-]/g, "_");
  let names: string[];
  try {
    names = await readdir(AUDIT_DIR);
  } catch {
    return undefined;
  }
  const files = names.filter((n) => n.startsWith(stem) && /^(\.\d{4}-\d{2}-\d{2})?\.jsonl$/.test(n.slice(stem.length))).sort();
  if (files.length === 0) throw new LegFailure(`no audit file for this session under ${AUDIT_DIR} (set WRATHBENCH_AUDIT_DIR)`);
  const rows: Record<string, unknown>[] = [];
  for (const name of files) {
    for (const line of (await Bun.file(`${AUDIT_DIR}/${name}`).text()).split("\n")) {
      if (!line) continue;
      const row = JSON.parse(line) as { kind: string; payload: Record<string, unknown> };
      if (row.kind === "action" && row.payload?.op === op) rows.push(row.payload);
    }
  }
  return rows;
}

interface Ride {
  departedAfterMs: number;
  durationMs: number;
  parked: MovePoint;
  samples: number;
}

/**
 * Ride until the car has reached the far end and stopped. WB_RIDE_PROGRESS y
 * must move monotonically toward the far end (0.5y slack for the float
 * position the server carries); the duration is measured from departure (the
 * first sample more than 1y from the boarding y) to the first stable sample
 * past the far end.
 */
async function ride(leg: string, dir: Direction, boardedAt: MovePoint): Promise<Ride> {
  log("riding: waiting for WB_RIDE_PROGRESS to pass the far end");
  const t0 = Date.now();
  let last: { x: number; y: number; z: number } | undefined;
  let stable = 0;
  let departedAt: number | undefined;
  let samples = 0;
  const forward = dir.forward;
  const deadline = t0 + 180_000;
  while (Date.now() < deadline) {
    const ev = await client.events.waitFor((e) => e.opcode === "WB_RIDE_PROGRESS", {
      timeout: Math.max(1, deadline - Date.now()),
      includeBuffered: false,
      description: "WB_RIDE_PROGRESS while riding the tram",
    });
    const pos = (ev.data as { pos: { x: number; y: number; z: number } }).pos;
    samples++;
    if (last && (pos.y - last.y) * forward < -0.5) {
      throw new LegFailure(`${leg}: y went the wrong way, ${last.y.toFixed(1)} -> ${pos.y.toFixed(1)} (a rode-back, or the wrong train)`);
    }
    if (departedAt === undefined && Math.abs(pos.y - boardedAt.y) > 1) {
      departedAt = Date.now();
      log(`  departed after ${secs(departedAt - t0)} aboard`);
    }
    if (last && dist2d(pos, last) < 0.1) stable++;
    else stable = 0;
    last = pos;
    if (dir.atFarEnd(pos.y) && stable >= 2) {
      const durationMs = Date.now() - (departedAt ?? t0);
      log(`  ride over: car stopped at ${fmt(pos)} after ${secs(durationMs)} (${samples} samples)`);
      return { departedAfterMs: (departedAt ?? t0) - t0, durationMs, parked: pos, samples };
    }
  }
  throw new LegFailure(`${leg}: the ride did not reach the far end within 180s (last ${last ? fmt(last) : "?"})`);
}

interface RideReport {
  ride: number;
  direction: string;
  legMs: Record<string, number>;
  boarding?: Boarded;
  rideMs?: number;
}
const rideReports: RideReport[] = [];

/** One full crossing: portal in, board, ride, disembark, portal out. `gated` applies the N1 assertions. */
async function crossing(rideNo: number, dir: Direction, gated: boolean): Promise<void> {
  const report: RideReport = { ride: rideNo, direction: dir.name, legMs: {} };
  rideReports.push(report);
  const timed = async (name: string, fn: () => Promise<void>) => {
    log(`=== ride ${rideNo} ${name} ===`);
    const t0 = Date.now();
    await fn();
    report.legMs[name] = Date.now() - t0;
    log(`=== ride ${rideNo} ${name}: ${secs(Date.now() - t0)} ===`);
  };

  await timed("leg3: entry portal", async () => {
    await portal(`leg3 (${dir.name})`, dir.entry.name, dir.entry.target, dir.entry.expectAt.map, dir.entry.expectAt);
  });

  let boarded!: Boarded;
  await timed("leg4: board", async () => {
    const leg = `leg4 (${dir.name})`;
    // From the portal arrival to the lane: an ordinary mesh walk first, so the
    // boarding leg itself is a short straight line onto the car.
    await hop(leg, dir.platformEdge);
    // No early "does this worldserver report transports" check: the module
    // reports a car only within view range of the character, and the tunnel
    // is ~2470y long, so a platform with no car near it hears nothing until
    // one pulls in. board() says so when its whole bound passes in silence.
    // A car with no report yet (docked undefined) is out of view range and
    // its position is the one the login's create block gave, not where it is.
    const cars = carsInView();
    const reported = cars.filter((c) => c.docked !== undefined);
    log(
      `  cars in view range: ${reported.map((c) => `${c.name ?? "?"}#${c.entry} ${c.goType ?? "?"} docked=${c.docked} at ${fmt({ x: c.x ?? NaN, y: c.y ?? NaN, z: c.z ?? NaN })}`).join("; ") || "none"}` +
        `; ${cars.length - reported.length} more known, out of range`,
    );
    boarded = await board(leg, dir, rideNo % 2 === 0 ? "guid" : "point");
    report.boarding = boarded;
    log(`  aboard ${boarded.entry} (guid ${boarded.guid}) at ${fmt(boarded.at)} via ${boarded.variant}: ${boarded.attempts} attempts, waited ${secs(boarded.waitedMs)}, docked observed before boarding: ${boarded.dockedBeforeBoarding}`);
    if (gated) {
      if (boarded.waitedMs > BOARDING_BOUND_MS) throw new LegFailure(`${leg}: boarding took ${secs(boarded.waitedMs)}, bound is ${secs(BOARDING_BOUND_MS)}`);
      if (!boarded.dockedBeforeBoarding) throw new LegFailure(`${leg}: the car was not observed docked (WB_TRANSPORT_PROGRESS) before boarding succeeded`);
      const named = cars.find((c) => c.guid === boarded.guid) ?? carsInView().find((c) => c.guid === boarded.guid);
      if (named?.goType !== "transport") throw new LegFailure(`${leg}: the boarded car's goType is ${named?.goType}, expected "transport"`);
      if (named?.name === undefined) throw new LegFailure(`${leg}: the boarded car has no name in units() (SMSG_GAMEOBJECT_QUERY_RESPONSE missing)`);
      const legs = await auditRows("move_transport_leg");
      if (legs === undefined) {
        log(`  audit: ${AUDIT_DIR} not readable here, the move_transport_leg check is skipped (set WRATHBENCH_AUDIT_DIR where it is mounted)`);
      } else {
        if (!legs.some((p) => p.boarding === true)) throw new LegFailure(`${leg}: no move_transport_leg audit with boarding:true for this session (${legs.length} transport legs audited)`);
        log(`  audit: ${legs.length} move_transport_leg rows, boarding:true present`);
      }
    }
  });

  let parked!: MovePoint;
  await timed("leg5: ride", async () => {
    const leg = `leg5 (${dir.name})`;
    const r = await ride(leg, dir, boarded.at);
    parked = r.parked;
    report.rideMs = r.durationMs;
    const now = selfPos();
    if (!now || now.map !== TRAM_MAP || !dir.atFarEnd(now.y)) throw new LegFailure(`${leg}: state.self.position ${now ? fmt(now) : "?"} is not at the far end`);
    if (gated && (r.durationMs < RIDE_MIN_MS || r.durationMs > RIDE_MAX_MS)) {
      throw new LegFailure(`${leg}: ride took ${secs(r.durationMs)}, expected ${secs(RIDE_MIN_MS)}..${secs(RIDE_MAX_MS)}`);
    }
  });

  await timed("leg6: disembark + exit portal", async () => {
    const leg = `leg6 (${dir.name})`;
    let off: MoveResult | undefined;
    for (const dx of [12, -12]) {
      const r = await tryMove(leg, `step off onto the platform (dx ${dx})`, { x: parked.x + dx, y: parked.y, z: -4.3 }, 30_000);
      if (r.ok && r.status === "arrived" && !r.onTransport) { off = r; break; }
      if (r.ok && r.status === "arrived") throw new LegFailure(`${leg}: still aboard ${r.onTransport!.entry} after stepping off`);
    }
    if (!off) throw new LegFailure(`${leg}: could not step off the car onto the platform`);
    await hop(leg, dir.farPlatform);
    await portal(leg, dir.exit.name, dir.exit.target, dir.exit.expectAt.map, dir.exit.expectAt);
  });
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

/**
 * The fixture boot — enumerate, create if missing, place the scenario — lives
 * in lib/fixture.ts, shared with kill-credit.ts. This probe is long-running
 * and single-purpose, so it keeps the generous contended-account budget
 * (20 minutes, retried each minute) the fixture path has always had here.
 */
const fixtureCtx: FixtureContext = {
  base: BASE,
  account: ACCOUNT,
  character: CHARACTER,
  token: TOKEN,
  log,
  fail: (m) => {
    throw new LegFailure(m);
  },
  createAndLogout: async () => {
    await createSessionWithBackoff();
    await client.logout();
  },
};

/**
 * The fixture's postcondition, checked in world rather than trusted: level and
 * position land from the login handshake (SMSG_LOGIN_VERIFY_WORLD, the char
 * enum), so give them a few seconds to arrive before asserting.
 */
async function assertFixtureStart(): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const pos = selfPos();
    const level = client.state.self.level?.value;
    if (pos && level !== undefined) {
      if (level < 10) throw new LegFailure(`fixture start: ${CHARACTER} is level ${level}, expected >= 10 — did apply.ts write this character?`);
      if (pos.map !== 0) throw new LegFailure(`fixture start: on map ${pos.map} at ${fmt(pos)}, expected map 0 at the Tinker Town portal mouth`);
      const d = dist2d(pos, IF_ARRIVAL);
      if (d > 10) throw new LegFailure(`fixture start: ${fmt(pos)} is ${d.toFixed(1)}y from the portal mouth ${fmt(IF_ARRIVAL)}, expected within 10y`);
      log(`fixture start ok: level ${level} on map 0 at ${fmt(pos)}, ${d.toFixed(1)}y from the portal mouth`);
      return;
    }
    if (Date.now() > deadline) {
      throw new LegFailure(`fixture start: state.self reported no ${pos ? "level" : "position"} within 15s (position ${pos ? fmt(pos) : "?"}, level ${level ?? "?"})`);
    }
    await Bun.sleep(250);
  }
}

let exitCode = 0;
const legTimes: [string, number][] = [];
try {
  if (FROM) {
    log(`--from ${FROM}: fixture character ${CHARACTER} on ${ACCOUNT}, legs 1-2 skipped`);
    await ensureFixtureCharacter(fixtureCtx);
    await applyScenario(fixtureCtx, FROM);
    await createSessionWithBackoff();
    const spawn = selfPos();
    log(`in world as ${CHARACTER} at ${spawn ? fmt(spawn) : "?"} map ${spawn?.map}; ${RIDES} gated ride(s)`);
    await assertFixtureStart();
  } else {
    await createSessionWithBackoff();
    const spawn = selfPos();
    log(`in world as ${CHARACTER} (Dwarf Warrior) at ${spawn ? fmt(spawn) : "?"} map ${spawn?.map}; ${RIDES} gated ride(s)`);

    for (const leg of LEGS) {
      log(`=== ${leg.name} ===`);
      const legStart = Date.now();
      for (const wp of leg.waypoints) await hop(leg.name, wp);
      legTimes.push([leg.name, Date.now() - legStart]);
      log(`=== ${leg.name}: complete in ${((Date.now() - legStart) / 1000).toFixed(0)}s ===`);
      if (leg.name.startsWith("leg1:")) {
        // Kharanos is where leg1 ends and trigger 710 sits: linger there
        // before leg2 walks on.
        const name = "leg1b: linger in areatrigger 710";
        log(`=== ${name} ===`);
        const t0 = Date.now();
        await lingerInTrigger(name);
        legTimes.push([name, Date.now() - t0]);
      }
    }
  }

  for (let n = 1; n <= RIDES; n++) {
    currentRide = n;
    await crossing(n, IF_TO_SW, true);
    const end = selfPos();
    log(`RIDE ${n} PASS: ${CHARACTER} is in Stormwind at ${end ? fmt(end) : "?"} map ${end?.map}`);
    if (n < RIDES) {
      // Back to the Tinker Town portal mouth by tram, so the next gated ride
      // starts where this one did. Checked for typed success only.
      await crossing(n, SW_TO_IF, false);
    }
  }
  log(`GATE PASS: ${RIDES} ride(s) IF -> SW with typed success on every leg`);
} catch (e) {
  if (e instanceof LegFailure) log(`GATE FAIL: ${e.message}`);
  else log(`UNEXPECTED FAILURE: ${String(e instanceof Error ? (e.stack ?? e.message) : e)}`);
  exitCode = 1;
} finally {
  // Findings dump: every hop, machine-readable, before cleanup can fail.
  console.log("=== hop log (JSONL) ===");
  for (const h of hopLogs) console.log(JSON.stringify(h));
  for (const [leg, ms] of legTimes) log(`${leg}: ${(ms / 1000).toFixed(0)}s`);
  for (const r of rideReports) {
    const legs = Object.entries(r.legMs).map(([k, v]) => `${k} ${secs(v)}`).join(", ");
    const b = r.boarding;
    log(
      `ride ${r.ride} ${r.direction}: ${legs || "(no leg completed)"}` +
        (b ? `; boarding: ${b.attempts} attempts, waited ${secs(b.waitedMs)}, via ${b.variant}, entry ${b.entry}, docked-before ${b.dockedBeforeBoarding}` : "; boarding: not reached") +
        (r.rideMs !== undefined ? `; ride ${secs(r.rideMs)}` : "; ride: not completed"),
    );
  }
  const statuses = new Map<string, number>();
  for (const h of hopLogs) statuses.set(h.status, (statuses.get(h.status) ?? 0) + 1);
  log(`move statuses: ${[...statuses].map(([k, v]) => `${k}:${v}`).join(" ")}`);
  if (statuses.has("no_path")) log("WARNING: undifferentiated no_path was emitted");
  log(`opcodes seen: ${[...opcodesSeen].map(([k, v]) => `${k}:${v}`).join(" ")}`);

  await client.logout().catch(() => {});
  if (FROM) {
    // The fixture character is the fixture: it is never deleted, and the next
    // run's apply.ts rewrites its rows in place.
    log(`cleanup: session closed; ${CHARACTER} kept on ${ACCOUNT} (fixture character)`);
  } else {
    const gone = await client
      .deleteCharacter(CHARACTER, { account: ACCOUNT, initialDelayMs: 3000 })
      .catch((e: unknown) => String(e));
    log(`cleanup: ${CHARACTER} ${typeof gone === "string" ? gone : "deleted"}`);
  }
  client.close();
  process.exit(exitCode); // open WebSockets hold the event loop
}
