/**
 * Exploratory probe: long-distance travel via chained `move_to` hops (PHASE-0
 * follow-up 18). A fresh Dwarf walks Coldridge Valley -> Coldridge Pass tunnel
 * -> Kharanos -> Ironforge gates -> Tinker Town, then tries to enter the
 * Deeprun Tram. The deliverable is the findings, not a green PASS: every hop
 * logs its target, WB_MOVE_RESULT status, server-confirmed position, and
 * wall-clock, and failed hops are retried with adjusted z and midpoint
 * subdivision so the *shape* of each failure is on the record.
 *
 * Waypoints are hardcoded from spawn-table landmarks (harness tooling, not an
 * agent run; the observation contract does not apply to this script).
 *
 * Expected leg-3 outcome, worth stating up front: the module has no
 * CMSG_AREATRIGGER dispatch and no raw-opcode escape hatch, so the areatrigger
 * teleport at the tram entrance (trigger 2175 -> map 369) should never fire.
 * This probe walks into the portal tunnel and documents exactly what the
 * character experiences instead.
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
const CHARACTER = "Tr" + Date.now().toString(26).replace(/[0-9]/g, (d) => "ghijklmnop"[+d]).slice(-8);

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
// arrival point for the tram portal mouth. Hops are kept under the module's
// 250y `move_to` cap (WbManager.cpp:771).
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
      { name: "tram portal mouth (areatrigger arrival)", x: -4839.0, y: -1318.5, z: 501.9 },
    ],
  },
];

// Where areatrigger 2175 would put us if it ever fired.
const TRAM_IF_PLATFORM = { map: 369, x: 69.25, y: 10.26, z: -4.3 };

interface HopLog {
  leg: string;
  hop: string;
  target: MovePoint;
  attempts: {
    target: MovePoint;
    status: string;
    position: { x: number; y: number; z: number };
    ms: number;
  }[];
  arrived: boolean;
  totalMs: number;
}
const hopLogs: HopLog[] = [];
const opcodesSeen = new Map<string, number>();

const client = await connect({ baseUrl: BASE, token: TOKEN });
client.events.onAny((e: any) => {
  const op = e?.opcode ?? "?";
  opcodesSeen.set(op, (opcodesSeen.get(op) ?? 0) + 1);
});

const selfPos = () => client.state.self.position?.value;

async function tryMove(target: MovePoint, timeout = 90_000): Promise<MoveResult> {
  const t0 = Date.now();
  const r = await client.moveTo(target, { timeout });
  const ms = Date.now() - t0;
  log(
    `  move_to ${fmt(target)} -> ${r.status} at ${fmt(r.position)} ` +
      `(${dist2d(r.position, target).toFixed(1)}y short, ${(ms / 1000).toFixed(1)}s)`,
  );
  return r;
}

/**
 * One hop with the recovery ladder an agent would need: retry no_path with
 * adjusted z (the mesh poly search rejects targets vertically far from a
 * poly), retry interrupted/timeout once from wherever we ended up, and on
 * persistent failure subdivide with a midpoint (depth 1).
 */
async function hop(leg: string, wp: Waypoint, depth = 0): Promise<boolean> {
  const t0 = Date.now();
  const entry: HopLog = { leg, hop: wp.name, target: { x: wp.x, y: wp.y, z: wp.z }, attempts: [], arrived: false, totalMs: 0 };
  if (depth === 0) hopLogs.push(entry);
  const record = (target: MovePoint, r: MoveResult, ms: number) =>
    entry.attempts.push({ target, status: r.status, position: { x: r.position.x, y: r.position.y, z: r.position.z }, ms });

  const zLadder = [0, 4, -4, 10, -10, 20, -20, 40, -40];
  let interruptedRetries = 2;
  for (let i = 0; i < zLadder.length; i++) {
    const target = { x: wp.x, y: wp.y, z: wp.z + zLadder[i]! };
    const a0 = Date.now();
    const r = await tryMove(target);
    record(target, r, Date.now() - a0);
    if (r.status === "arrived" && dist2d(r.position, wp) < 8) {
      entry.arrived = true;
      entry.totalMs = Date.now() - t0;
      return true;
    }
    if (r.status === "no_path") {
      if (i + 1 < zLadder.length) log(`  no_path; retrying with z ${wp.z + zLadder[i + 1]!}`);
      continue;
    }
    if ((r.status === "interrupted" || r.status === "timeout" || r.status === "stuck") && interruptedRetries-- > 0) {
      log(`  ${r.status}; retrying same target from current position`);
      i--; // do not advance the z ladder for a transient failure
      await Bun.sleep(1500);
      continue;
    }
    break; // arrived-but-short, or an unknown status: fall through to subdivide
  }

  if (depth < 1) {
    const here = selfPos();
    if (here) {
      const mid: Waypoint = {
        name: `${wp.name} [midpoint]`,
        x: (here.x + wp.x) / 2,
        y: (here.y + wp.y) / 2,
        z: (here.z + wp.z) / 2,
      };
      if (dist2d(here, wp) > 30) {
        log(`  subdividing: midpoint ${fmt(mid)}`);
        if (await hop(leg, mid, depth + 1)) {
          const ok = await hop(leg, wp, depth + 1);
          entry.arrived = ok;
          entry.totalMs = Date.now() - t0;
          return ok;
        }
      }
    }
  }
  entry.totalMs = Date.now() - t0;
  log(`  HOP FAILED: ${wp.name} after ${entry.attempts.length} attempts`);
  return false;
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
try {
  await createSessionWithBackoff();
  const spawn = selfPos();
  log(`in world as ${CHARACTER} (Dwarf Warrior) at ${spawn ? fmt(spawn) : "?"} map ${spawn?.map}`);

  let aborted = false;
  for (const leg of LEGS) {
    if (aborted) break;
    log(`=== ${leg.name} ===`);
    const legStart = Date.now();
    for (const wp of leg.waypoints) {
      const here = selfPos();
      log(`hop -> ${wp.name} ${fmt(wp)}${here ? ` (${dist2d(here, wp).toFixed(0)}y away)` : ""}`);
      if (!(await hop(leg.name, wp))) {
        log(`LEG STALLED at "${wp.name}" — continuing to report, aborting remaining legs`);
        aborted = true;
        break;
      }
    }
    log(`=== ${leg.name}: ${aborted ? "STALLED" : "complete"} in ${((Date.now() - legStart) / 1000).toFixed(0)}s ===`);
  }

  // Leg 3: creep into the tram portal tunnel and watch for a world transfer.
  if (!aborted) {
    log("=== leg3: Deeprun Tram entry attempt ===");
    const before = new Map(opcodesSeen);
    let transferred = false;
    for (let dy = 8; dy <= 88 && !transferred; dy += 8) {
      const here = selfPos()!;
      const target = { x: -4839.0, y: -1318.5 - dy, z: 501.9 };
      const r = await tryMove(target, 30_000);
      hopLogs.push({
        leg: "leg3: tram portal creep",
        hop: `portal creep y=${target.y.toFixed(0)}`,
        target,
        attempts: [{ target, status: r.status, position: { x: r.position.x, y: r.position.y, z: r.position.z }, ms: 0 }],
        arrived: r.status === "arrived",
        totalMs: 0,
      });
      await Bun.sleep(1500); // give a server-side teleport (if any) time to land
      const now = selfPos();
      if (now && (now.map === TRAM_IF_PLATFORM.map || dist2d(now, TRAM_IF_PLATFORM) < 100)) {
        log(`WORLD TRANSFER OBSERVED: now at ${fmt(now)} map ${now.map}`);
        transferred = true;
        break;
      }
      const newOps = [...opcodesSeen].filter(([op, n]) => (before.get(op) ?? 0) < n).map(([op]) => op);
      log(`  after creep to y=${target.y.toFixed(0)}: pos ${now ? fmt(now) : "?"} map ${now?.map}; opcodes since portal: ${newOps.join(",") || "none"}`);
      if (r.status !== "arrived" && dist2d(r.position, { x: here.x, y: here.y }) < 2) {
        log("  no forward progress into the portal tunnel; stopping the creep");
        break;
      }
    }
    if (!transferred) {
      log("leg3 result: never transferred to map 369 — the areatrigger teleport did not fire (module sends no CMSG_AREATRIGGER)");
    }
  }
} catch (e) {
  log(`UNEXPECTED FAILURE: ${String(e instanceof Error ? (e.stack ?? e.message) : e)}`);
  exitCode = 1;
} finally {
  // Findings dump: every hop, machine-readable, before cleanup can fail.
  console.log("=== hop log (JSONL) ===");
  for (const h of hopLogs) console.log(JSON.stringify(h));
  const legs = [...new Set(hopLogs.map((h) => h.leg))];
  for (const leg of legs) {
    const hops = hopLogs.filter((h) => h.leg === leg);
    const failed = hops.filter((h) => !h.arrived);
    const retried = hops.filter((h) => h.arrived && h.attempts.length > 1);
    log(
      `${leg}: ${hops.length - failed.length}/${hops.length} hops arrived` +
        (retried.length ? `, ${retried.length} needed retries` : "") +
        (failed.length ? `, failed: ${failed.map((h) => h.hop).join("; ")}` : ""),
    );
  }
  log(`opcodes seen: ${[...opcodesSeen].map(([k, v]) => `${k}:${v}`).join(" ")}`);

  await client.logout().catch(() => {});
  const gone = await client
    .deleteCharacter(CHARACTER, { account: ACCOUNT, initialDelayMs: 3000 })
    .catch((e: unknown) => String(e));
  log(`cleanup: ${CHARACTER} ${typeof gone === "string" ? gone : "deleted"}`);
  client.close();
  process.exit(exitCode); // open WebSockets hold the event loop
}
