/**
 * Probe for the navigation status vocabulary.
 *
 * End to end against a booted worldserver, from inside the container network:
 * session in world (Human in Northshire) -> a `move_to` whose z is 5y above
 * the ground arrives and reports `meshZ` (the mesh owns z) -> a `move_to`
 * whose z is 5y UNDER the ground arrives on the ground with `meshZ`, never a
 * `drop` and never a position below the terrain -> a `move_to`
 * whose z is 100y above the ground (far outside the navmesh's vertical poly
 * search) still arrives, with `meshZ` at the ground: the module's ground-z
 * fallback (part 3) -> a `move_to` to a nearby NPC's position
 * with its `guid` arrives -> a candidate point with no walkable ground is
 * `target_off_mesh`, nothing moved -> a 300y request is `too_far` -> a
 * zero-length `move_to` (still at HOME) arrives -> a plain walk still arrives
 * with no `meshZ` -> (optional leg) a route off a ledge is `drop`, nothing
 * moved -> logout. No dependencies; Bun built-ins only.
 *
 * Steps 3–3b are new with the harness-0.4 module and FAIL
 * against an older one: a pre-46 module answers z+100 with `target_off_mesh`.
 *
 * The `drop` leg (5b) is OPTIONAL and labelled as such: it needs a ledge the
 * mesh connects by a cliff-steep segment, and no such point has been verified
 * reachable from Northshire in this probe's budget (the one that earned the
 * status is Deeprun's walkway on map 369, nav-probe c4). Pin one with
 * NAV_LEDGE="x,y,z" (a point ~5-10y beyond a ledge lip, on the lower level)
 * and the leg asserts `drop` with reachedPos on this level and no z change;
 * unpinned it tries the candidate list below and reports which, if any,
 * produced `drop`, failing only when a candidate is walked down a ledge (an
 * `arrived` whose server z is >3y below the z it started from over a short
 * walk — the exact c4 defect).
 *
 * Two more OPTIONAL legs, pinned with NAV_MESH_Z (`kharanos`, `sneed`, or
 * both, comma-separated), check that the drop guard judges a route at the
 * right z (wrath-mcp/module/PROTOCOL.md, `drop` and `arrived`). Unpinned
 * they cost nothing: no fixture, no logout hold. Each runs after the logout
 * below, places this run's character with a fixture scenario (so it needs
 * the fixtures tool: inside the runner, or the quickstart's compose) and logs
 * in again:
 *   - `kharanos`: from the Thunderbrew Distillery floor (scenario
 *     nav-kharanos-floor) down the cellar's switchback stairs to Jarven
 *     Thunderbrew must arrive. The core settled the stair point under the
 *     landing onto the landing, and the step after it was refused as a 5.1y
 *     fall onto a foot "under" the landing, forced or not.
 *   - `sneed`: from the Moonbrook staging spot (scenario moonbrook-mine)
 *     through trigger 78 into the Deadmines, a walk to (-178, -418, 56), then
 *     to (-240.8, -489.9, 55.3), 4.8y over the corridor floor. The core settled
 *     that end on a surface 1.4y under the request and the last segment read
 *     as a 5.4y climb. The leg is VERDICT-ONLY: the move to the corridor is
 *     dispatched, not `drop`, with `meshZ` at the floor (about 50.5) and a
 *     route of about SNEED_PATH_YARDS, and is walked once; how that walk ends
 *     is printed and never asserted. The Defias on the route attack the
 *     level-80 character and it does not survive them: both walks' paths run
 *     within 1y of standing spawns and Rhahk'Zor's patrol, a dungeon's
 *     creatures never leash, and the train killed it (9.5k health to 0 in
 *     about 45 s) on harness-1.0-41 and 1.0-49 alike, so arrival in the
 *     corridor is not something a smoke character can show without a GM's
 *     hand (gear, an instance bind), which the smoke does not use. The walk
 *     to the leg's start must still arrive, since the verdict is judged from
 *     there: a stun or a knock ends it `stunned` or `interrupted`, so it is
 *     re-issued from where it stopped, as a player would, up to
 *     MESH_WALK_TRIES times, and a death on it fails the leg as a death.
 * `bun wb smoke` does not carry the variable into the runner pod, so pin the
 * legs there with
 * `kubectl -n wrathbench exec deploy/wrathbench-runner -- env
 * MODULE_ACCOUNT=<a smoke account> NAV_MESH_Z=kharanos,sneed bun
 * infra/smoke/module-navigation.ts`: MODULE_ACCOUNT is what `bun wb smoke`
 * would inject, and the default PROBE may hold no room for the character.
 *
 * Not staged here, deliberately: `no_mesh` needs an unmapped map, and
 * `path_incomplete` / `start_off_mesh` need specific terrain (a transport
 * deck, a mesh gap) that Northshire does not offer on demand. Those two are
 * exercised by the travel gate (infra/smoke/travel.ts) where the tram
 * provides the deck. `WB_AREATRIGGER` is also the gate's: no DBC trigger lies
 * within 400y of either starter zone.
 *
 * Preflight-gate ready (2026-08-23): reads MODULE_ACCOUNT
 * the way the supervisor's spawnSmoke injects it, deletes last run's character
 * through the real CMSG_CHAR_DELETE path before creating this run's (the same
 * pattern as quest-accept-status.ts / kill-credit.ts), and only logs out at
 * the end — a disconnected character lingers 60s in the core's
 * WorldSession::expireTime, during which a delete is silently ignored, so a
 * re-run inside that minute waits it out (lib/transient.ts,
 * `deleteThroughLinger`): about 70 s before the first move.
 *
 * Every walk that must arrive is walked once more, announced with RETRY:, when
 * it ends `interrupted` with the character alive and the server having carried
 * it MOVE_ACCEPTED_YARDS or more (lib/transient.ts, `moveRetryReason` with a
 * start): a world tick stall of about 3 s stops the walker's heartbeats and
 * trips its 15y drift check mid-walk (harness-1.0-49, the after-failure walk to
 * the courtyard, 10.6y in). One that never left its start stays a failure.
 *
 * Run standalone (defaults to the PROBE account):
 *   bun wb smoke module-navigation
 *   bun wb --local smoke module-navigation   # the quickstart
 *
 * Override the target with MODULE_HOST / MODULE_PORT (default worldserver:8086)
 * and the login account with MODULE_ACCOUNT (default PROBE).
 */

import { DEADMINES_ENTRANCE_TRIGGER, NAV_KHARANOS_JARVEN, SCENARIOS } from "../fixtures/scenarios";
import { authHeaders } from "./lib/auth";
import { failOnce } from "./lib/fail";
import { applyScenario, type FixtureContext } from "./lib/fixture";
import { moduleBase, moduleWsBase, moduleRequest } from "./lib/module";
import { smokeSubToken, smokeToken } from "./lib/session";
import { moveRetryReason, RETRY_MARK, selfHealth } from "./lib/transient";
import { taggedLog } from "./lib/report";
import { openEventStream, waitForEvent } from "./lib/events";
import { deletePreviousThroughLinger } from "./lib/character";
import { dist2d } from "./lib/geo";

const BASE = moduleBase();
const WS = moduleWsBase();

// Session tokens must be at least 32 characters (POST /session rejects
// shorter ones with weak_token); randomUUID keeps them unguessable too.
const TOKEN = smokeToken("module-navigation");
// Fixed name, deleted at the START of every run and only logged out at the
// end (see deletePreviousCharacter below). One name per script, so the
// leftover is always exactly one.
const CHARACTER = "Smokenav";
const ACCOUNT = process.env.MODULE_ACCOUNT ?? "PROBE";

const log = taggedLog("nav");
// Best-effort session cleanup so a failed run does not leave the account
// blocked for the next one (lib/fail.ts: once, awaited, then the exit). The
// session logged in now: the main legs', or an optional leg's own.
let liveToken = TOKEN;
const { fail: failNow, failed } = failOnce({
  prefix: () => "[nav] FAIL",
  cleanup: () => fetch(`${BASE}/session`, { method: "DELETE", headers: authHeaders(), body: JSON.stringify({ token: liveToken }) }),
  cleanupMs: 3000,
});
function fail(msg: string): never {
  return failNow(msg);
}

const req = moduleRequest(BASE);

const events: any[] = [];

type Vec = { x: number; y: number; z: number };
/**
 * A logged-in session's token, the events its socket has seen, and where the
 * server last put the character (login, then each move's answer): the main
 * legs' unless a leg opens its own.
 */
type Leg = { token: string; events: any[]; at?: Vec };
const MAIN: Leg = { token: TOKEN, events };

function openEvents(leg: Leg = MAIN): Promise<WebSocket> {
  return openEventStream(
    WS,
    leg.token,
    (e) => {
      leg.events.push(e);
    },
    (raw) => log(`event <- (unparseable) ${raw}`),
  );
}

function waitFor(pred: (e: any) => boolean, timeoutMs: number, what: string, leg: Leg = MAIN): Promise<any> {
  return waitForEvent(leg.events, pred, timeoutMs, what, fail);
}

function deletePreviousCharacter(): Promise<void> {
  return deletePreviousThroughLinger({ request: req, token: TOKEN, account: ACCOUNT, character: CHARACTER, log, fail });
}

/** Issue move_to and return the terminal WB_MOVE_RESULT data for it. */
async function move(target: { x: number; y: number; z: number; guid?: string }, timeoutMs = 60000, leg: Leg = MAIN): Promise<any> {
  const ack = await req("POST", "/action", { token: leg.token, action: "move_to", ...target });
  if (ack.status !== 200 || !ack.json?.ok) fail(`move_to refused: ${ack.status} ${JSON.stringify(ack.json)}`);
  const result = await waitFor(
    (e) => e.opcode === "WB_MOVE_RESULT" && e.data?.moveId === ack.json.moveId,
    timeoutMs,
    `WB_MOVE_RESULT for moveId ${ack.json.moveId}`,
    leg,
  );
  log(
    `move_to (${target.x.toFixed(1)}, ${target.y.toFixed(1)}, ${target.z.toFixed(1)}) -> ${result.data.status}` +
      (result.data.meshZ !== undefined ? ` meshZ=${result.data.meshZ.toFixed(1)}` : "") +
      (result.data.reachedPos ? ` reachedPos=${JSON.stringify(result.data.reachedPos)}` : "") +
      (result.data.dz !== undefined ? ` dz=${result.data.dz}` : ""),
  );
  if (result.data.pos) leg.at = result.data.pos;
  return result.data;
}

/**
 * A walk that must arrive: `move`, and once more from where it stopped when
 * `moveRetryReason` says the stop was the world thread's and not the walk's
 * (alive, mid-walk; header). Its caller asserts on the last answer as before.
 */
async function arrive(target: Vec & { guid?: string }, what: string, timeoutMs = 60000, leg: Leg = MAIN): Promise<any> {
  const from = leg.at;
  const r = await move(target, timeoutMs, leg);
  const why = moveRetryReason(r, { alive: selfHealth(leg.events) !== 0, inSession: true, target, from });
  if (why === undefined) return r;
  log(`${RETRY_MARK} ${what} ${why}`);
  return move(target, timeoutMs, leg);
}

async function main() {
  const health = await req("GET", "/health");
  if (health.status !== 200 || !health.json?.ok) fail(`health not ok: ${JSON.stringify(health)}`);
  log(`health ok: build=${health.json.build ?? "?"}, character=${CHARACTER}`);

  // 0. Delete last run's character through the real CMSG_CHAR_DELETE path
  //    (see deletePreviousCharacter for why this runs first, not last).
  await deletePreviousCharacter();

  const ws = await openEvents();
  await Bun.sleep(200);

  // 1. Session in world.
  const session = await req("POST", "/session", { token: TOKEN, account: ACCOUNT, character: CHARACTER, race: 1, class: 1 });
  if (session.status !== 200 || !session.json?.ok || !session.json?.inWorld) {
    fail(`session create failed: ${session.status} ${JSON.stringify(session.json)}`);
  }
  const verify = await waitFor((e) => e.opcode === "SMSG_LOGIN_VERIFY_WORLD", 5000, "SMSG_LOGIN_VERIFY_WORLD");
  let here = { x: verify.data.x, y: verify.data.y, z: verify.data.z };
  MAIN.at = here;
  log(`in world at (${here.x.toFixed(1)}, ${here.y.toFixed(1)}, ${here.z.toFixed(1)}) map ${verify.data.map}`);

  // Two walkable landmarks ~37m apart (human start, abbey courtyard). A reused
  // character may be anywhere; walk home first so the legs below are fixed.
  const HOME = { x: -8949.95, y: -132.49, z: 83.53 };
  const COURTYARD = { x: -8913.2, y: -137.6, z: 80.9 };
  if (dist2d(here, HOME) > 10) {
    const home = await arrive(HOME, "the walk home", 120000);
    if (home.status !== "arrived") fail(`walk-home result ${JSON.stringify(home)}`);
    here = home.pos;
  }

  // 2. Wrong z, right x/y: the mesh owns z, within the navmesh's own vertical
  //    poly search. The module sets no extents of its own — it takes
  //    PathGenerator's default box — so the usable slack is single-digit
  //    yards, not the tens this probe once assumed. Measured at this exact
  //    point on 2026-08-23: +2 and +5 arrive with meshZ, +10 and +30 are
  //    target_off_mesh (+15/+20 come back path_incomplete off a nearby roof
  //    poly).
  const high = await arrive({ x: COURTYARD.x, y: COURTYARD.y, z: COURTYARD.z + 5 }, "the z+5 walk");
  if (high.status !== "arrived") fail(`z+5 request should arrive (mesh resolves z), got ${JSON.stringify(high)}`);
  if (dist2d(high.pos, COURTYARD) > 4) fail(`z+5 arrived ${dist2d(high.pos, COURTYARD).toFixed(1)}m from target`);
  if (typeof high.meshZ !== "number") fail(`z+5 arrival carries no meshZ: ${JSON.stringify(high)}`);
  // endpointOk is 2D only, so this is what keeps a rooftop poly from passing.
  if (Math.abs(high.meshZ - COURTYARD.z) > 3) fail(`meshZ ${high.meshZ} is not the courtyard ground (${COURTYARD.z})`);
  log(`PASS z+5 -> arrived with meshZ ${high.meshZ.toFixed(1)} (requested ${(COURTYARD.z + 5).toFixed(1)})`);

  // 2a. Wrong z the other way: 5y UNDER the ground. The core's path
  //     normalization looks down from 2y above the requested point, so from
  //     inside the terrain it finds no surface (or a buried floor) and keeps
  //     the guessed z; the walk then ends inside the hill, or the last segment
  //     is a `drop` the SDK takes on its own (Dun Algaz, 2026-10-11: 67 such
  //     landings in one run). The module now ends the walk at the mesh's own
  //     height: `arrived`, `meshZ` at the ground, and the server's position
  //     on it — never a `drop`, never a z below the ground.
  const back2 = await arrive(HOME, "the walk home before the under-ground leg");
  if (back2.status !== "arrived") fail(`walk home before the under-ground leg: ${JSON.stringify(back2)}`);
  const low = await arrive({ x: COURTYARD.x, y: COURTYARD.y, z: COURTYARD.z - 5 }, "the z-5 walk");
  if (low.status !== "arrived") fail(`z-5 request should arrive on the ground (endpoint lifted to the mesh), got ${JSON.stringify(low)}`);
  if (dist2d(low.pos, COURTYARD) > 4) fail(`z-5 arrived ${dist2d(low.pos, COURTYARD).toFixed(1)}m from target`);
  if (typeof low.meshZ !== "number" || Math.abs(low.meshZ - COURTYARD.z) > 3) fail(`z-5 arrival should carry the ground meshZ (~${COURTYARD.z}): ${JSON.stringify(low)}`);
  if (low.pos.z < COURTYARD.z - 1.5) fail(`z-5 arrival left the character under the ground: server z ${low.pos.z} vs ground ${COURTYARD.z}`);
  log(`PASS z-5 -> arrived on the ground, meshZ ${low.meshZ.toFixed(1)}, server z ${low.pos.z.toFixed(1)}`);

  // 3. Far outside the poly search box (±50y vertically): no polygon under the
  //    request's z. Until harness-0.4 this was target_off_mesh; the module now
  //    resolves the ground height at x,y after that verdict (the z-ladder in
  //    front of the cause ladder (part 3): terrain a client has
  //    too) and walks there, reporting meshZ relative to the z asked for.
  const sky = await arrive({ x: HOME.x, y: HOME.y, z: HOME.z + 100 }, "the z+100 walk");
  if (sky.status !== "arrived") fail(`z+100 request should arrive on the ground-z fallback, got ${JSON.stringify(sky)}`);
  if (dist2d(sky.pos, HOME) > 4) fail(`z+100 arrived ${dist2d(sky.pos, HOME).toFixed(1)}m from target`);
  if (typeof sky.meshZ !== "number" || Math.abs(sky.meshZ - HOME.z) > 3) fail(`z+100 arrival should carry the ground meshZ (~${HOME.z}): ${JSON.stringify(sky)}`);
  log(`PASS z+100 -> arrived on the ground-z fallback, meshZ ${sky.meshZ.toFixed(1)}`);

  // 3a. A unit target: the guid rides along as the planning hint and the
  //     module resolves z to the ground under the NPC before pathing. The
  //     starter NPCs stand on flat ground, so the assertion here is only that
  //     the param is accepted and the move arrives; the sloped-NPC case that
  //     earned the repair ("Ironforge Mountaineer", nav-probe c3/c4) is Dun
  //     Morogh's and not reachable from here.
  const npc = events
    .filter((e) => e.opcode === "SMSG_UPDATE_OBJECT")
    .flatMap((e) => e.data?.objects ?? [])
    .filter((o: any) => o.update === "create" && o.objectType === "unit" && !o.self && o.pos)
    .map((o: any) => ({ guid: o.guid as string, pos: o.pos as { x: number; y: number; z: number } }))
    .filter((u) => dist2d(u.pos, HOME) < 60)
    .sort((a, b) => dist2d(a.pos, HOME) - dist2d(b.pos, HOME))[0];
  if (!npc) fail("no unit in view within 60y of the start to use as a guid target");
  const toNpc = await arrive({ x: npc.pos.x, y: npc.pos.y, z: npc.pos.z, guid: npc.guid }, "the walk to the unit");
  if (toNpc.status !== "arrived") fail(`move_to with guid ${npc.guid} should arrive, got ${JSON.stringify(toNpc)}`);
  if (dist2d(toNpc.pos, npc.pos) > 4) fail(`guid move arrived ${dist2d(toNpc.pos, npc.pos).toFixed(1)}m from the unit`);
  log(`PASS unit target (guid ${npc.guid}) -> arrived`);

  // 3b. A true off-mesh target still says so. Candidate: 12/12
  //     target_off_mesh in the 2026-08-22 trajectories from this valley. If
  //     it ARRIVES on the new module, the candidate's ground is walkable after
  //     all and the point must be replaced with one that is not (steep valley
  //     wall, inside a wall) — that is a probe defect, not a module one.
  const OFF_MESH = { x: -8897, y: 100, z: 98 };
  const walkBack = await arrive(HOME, "the walk back to HOME before the off-mesh probe");
  if (walkBack.status !== "arrived") fail(`walk back to HOME before the off-mesh probe: ${JSON.stringify(walkBack)}`);
  const before = { ...walkBack.pos };
  const off = await move(OFF_MESH);
  if (off.status !== "target_off_mesh") {
    fail(`off-mesh candidate (${OFF_MESH.x}, ${OFF_MESH.y}) should be target_off_mesh, got ${JSON.stringify(off)}` +
      (off.status === "arrived" ? " — the candidate has walkable ground; replace it in this probe" : ""));
  }
  if (dist2d(off.pos, before) > 1) fail(`target_off_mesh moved the character: ${JSON.stringify(off.pos)}`);
  log("PASS off-mesh candidate -> target_off_mesh, nothing moved");

  // 4. Beyond the single-move cap.
  const far = await move({ x: HOME.x + 300, y: HOME.y, z: HOME.z });
  if (far.status !== "too_far") fail(`300y request should be too_far, got ${JSON.stringify(far)}`);
  log("PASS 300y -> too_far");

  // 5. ORDERING NOTE: nothing since the walk back in 3b has moved the
  //    character (3b and 4 are planning failures), so this `move_to(HOME)`
  //    is a ZERO-LENGTH request — the mesh answers [here, here] and the
  //    mover must still send its MSG_MOVE_STOP and report `arrived`. On the
  //    harness-0.4 module (a97c3c8) this hung forever with no WB_MOVE_RESULT
  //    (TickMover never consumed a zero-length segment); keep this step
  //    directly after the two failures so that regression stays pinned.
  const still = await move(HOME, 20000);
  if (still.status !== "arrived") fail(`zero-length walk should arrive, got ${JSON.stringify(still)}`);
  if (still.meshZ !== undefined) fail(`zero-length arrival should not carry meshZ: ${JSON.stringify(still)}`);
  log("PASS zero-length walk after too_far -> arrived");

  // 5a. And a real walk after the failures: the too_far / target_off_mesh
  //     branches send a client's MSG_MOVE_STOP when the server still has the
  //     character flagged moving (a97c3c8 part 4); a following run must be
  //     accepted as normal. HOME is the landmark proven to carry no meshZ.
  const hop = await arrive(COURTYARD, "the walk to the courtyard after too_far");
  if (hop.status !== "arrived") fail(`walk to the courtyard after too_far should arrive, got ${JSON.stringify(hop)}`);
  const back = await arrive(HOME, "the walk back");
  if (back.status !== "arrived") fail(`walk back should arrive, got ${JSON.stringify(back)}`);
  if (back.meshZ !== undefined) fail(`plain arrival should not carry meshZ: ${JSON.stringify(back)}`);
  log("PASS plain walk after the failures -> arrived, no meshZ");

  // 5b. OPTIONAL LEG — a route that steps off a ledge is `drop` (typed-cause
  //     amendment 2026-08-23, nav-probe c4). The guard is |dz| > 2.0y and
  //     |dz| > 1.2x the segment's 2D length. Candidates are points a few yards
  //     past a lip near the abbey (UNVERIFIED: none has been confirmed to
  //     draw a drop segment from the mesh; pin NAV_LEDGE to make this leg
  //     load-bearing). A hard failure here is only ever the c4 shape: the
  //     character was walked down a ledge and told `arrived`.
  const pinned = process.env.NAV_LEDGE?.split(",").map(Number);
  const LEDGE_CANDIDATES: { x: number; y: number; z: number }[] =
    pinned && pinned.length === 3 && pinned.every(Number.isFinite)
      ? [{ x: pinned[0]!, y: pinned[1]!, z: pinned[2]! }]
      : [
          // Below the abbey's east retaining wall, from the courtyard's level.
          { x: -8888.0, y: -160.0, z: 76.0 },
          // The drop from the road's shoulder toward the vineyard stream.
          { x: -8990.0, y: -170.0, z: 77.0 },
        ];
  let dropSeen: string | undefined;
  for (const cand of LEDGE_CANDIDATES) {
    const stand = await arrive(HOME, "the walk home before the ledge candidate");
    if (stand.status !== "arrived") fail(`walk home before the ledge candidate: ${JSON.stringify(stand)}`);
    const from = { ...stand.pos };
    const r = await move(cand, 30000);
    if (r.status === "drop") {
      if (!r.reachedPos) fail(`drop carries no reachedPos: ${JSON.stringify(r)}`);
      if (typeof r.dz !== "number" || Math.abs(r.dz) <= 2) fail(`drop dz should exceed 2y: ${JSON.stringify(r)}`);
      if (Math.abs(r.reachedPos.z - from.z) > 3) fail(`drop's reachedPos is not on the character's level: ${JSON.stringify(r)}`);
      if (Math.abs(r.pos.z - from.z) > 0.5 || dist2d(r.pos, from) > 1) fail(`drop moved the character: ${JSON.stringify(r.pos)} from ${JSON.stringify(from)}`);
      if (!r.target || dist2d(r.target, cand) > 0.01) fail(`drop should echo the requested target: ${JSON.stringify(r)}`);
      dropSeen = `(${cand.x}, ${cand.y}, ${cand.z}) dz ${r.dz.toFixed(2)} edge (${r.reachedPos.x.toFixed(1)}, ${r.reachedPos.y.toFixed(1)})`;
      log(`PASS ledge candidate -> drop ${dropSeen}, nothing moved`);
      break;
    }
    if (r.status === "arrived" && from.z - r.pos.z > 3 && dist2d(from, cand) < 40) {
      fail(`ledge candidate (${cand.x}, ${cand.y}) was WALKED DOWN ${(from.z - r.pos.z).toFixed(1)}y and reported arrived — the nav-probe c4 defect; ${JSON.stringify(r)}`);
    }
    log(`optional ledge candidate (${cand.x}, ${cand.y}) -> ${r.status}${r.meshZ !== undefined ? ` meshZ ${r.meshZ.toFixed(1)}` : ""} (not a drop; candidate not load-bearing)`);
  }
  if (!dropSeen) log(pinned ? "FAIL-SOFT optional leg: pinned NAV_LEDGE did not produce drop" : "optional leg: no candidate produced drop; pin NAV_LEDGE=x,y,z once a ledge is known");
  if (pinned && !dropSeen) fail("NAV_LEDGE was pinned, so the drop leg is load-bearing and it did not produce drop");
  const home2 = await arrive(HOME, "the walk home after the ledge leg");
  if (home2.status !== "arrived") fail(`walk home after the ledge leg: ${JSON.stringify(home2)}`);

  // 6. Every status on the record is in the documented vocabulary.
  const VOCAB = new Set([
    "arrived", "too_far", "no_mesh", "target_off_mesh", "start_off_mesh", "path_incomplete",
    "drop", "transferred", "teleported", "interrupted", "stopped", "superseded", "rooted",
  ]);
  const seen = new Set(events.filter((e) => e.opcode === "WB_MOVE_RESULT").map((e) => e.data?.status));
  for (const s of seen) if (!VOCAB.has(s)) fail(`undocumented move status on the stream: ${s}`);
  if (seen.has("no_path")) fail("undifferentiated no_path is still emitted");
  log(`statuses seen: ${[...seen].join(", ")}`);

  // 7. Logout.
  const del = await req("DELETE", "/session", { token: TOKEN });
  if (del.status !== 200 || !del.json?.ok) fail(`session delete failed: ${del.status} ${JSON.stringify(del.json)}`);
  ws.close();

  // 8. OPTIONAL LEGS — the guard judges a route at the right z (header).
  const meshLegs = await meshZLegs();

  log(`PASS: meshZ arrival -> ground-z fallback -> unit target -> target_off_mesh -> too_far -> plain arrival -> drop leg ${dropSeen ? "PASS" : "optional/skipped"}; vocabulary clean; mesh-z legs ${meshLegs.length ? meshLegs.join(", ") + " PASS" : "optional/skipped"}`);
  process.exit(0);
}

const MESH_LEGS = ["kharanos", "sneed"] as const;
type MeshLeg = (typeof MESH_LEGS)[number];
/** The Deadmines leg: where its walk starts, inside the instance, and the request 4.8y over the corridor floor. */
const SNEED_FROM = { x: -178, y: -418, z: 56 };
const SNEED_TO = { x: -240.8, y: -489.9, z: 55.3 };
const SNEED_FLOOR_Z = 50.5;
/** The route the module plans from the leg's start to the corridor request: 134.9y on harness-1.0-41 and 1.0-49 alike. */
const SNEED_PATH_YARDS = 134.9;
/** How many times the walk to the Deadmines leg's start is issued before a stop that is not the route's (`stunned`, `interrupted`, `rooted`) fails it. */
const MESH_WALK_TRIES = 5;
const WALK_STOPS = new Set(["stunned", "interrupted", "rooted"]);

/**
 * A walk a fight may stop: re-issued from where it stopped, after a pause a
 * stun wears off in, until it ends any other way or the tries run out.
 * Returns the last answer. A death ends it at once, named as one: a corpse is
 * rooted, and every walk after it would be refused `rooted` (header).
 */
async function walkThrough(target: Vec, leg: Leg, what: string): Promise<any> {
  const died = (r: any, walks: number) => {
    if (selfHealth(leg.events) !== 0) return;
    const at = r.pos ? ` at (${r.pos.x.toFixed(1)}, ${r.pos.y.toFixed(1)}, ${r.pos.z.toFixed(1)})` : "";
    fail(`${what}: the character died${at} (health 0) on walk ${walks}, which ended ${r.status}: the trash on the route killed it, so the walk cannot arrive — not a navigation verdict`);
  };
  let last = await move(target, 120000, leg);
  let walks = 1;
  for (; WALK_STOPS.has(last.status) && walks < MESH_WALK_TRIES; ++walks) {
    log(`  ${what}: ${last.status} at (${last.pos.x.toFixed(1)}, ${last.pos.y.toFixed(1)}), health ${selfHealth(leg.events) ?? "?"}; walking on (${walks + 1}/${MESH_WALK_TRIES})`);
    await Bun.sleep(4000);
    died(last, walks);
    last = await move(target, 120000, leg);
  }
  if (last.status !== "arrived") died(last, walks);
  return last;
}

/**
 * The legs NAV_MESH_Z pins, run in order on this run's character, now logged
 * out: a fixture scenario places it, a session of the leg's own logs it in,
 * the leg's moves run, and it logs out again. Returns the legs that passed
 * (every pinned one, or the run has failed).
 */
async function meshZLegs(): Promise<MeshLeg[]> {
  const pinned = (process.env.NAV_MESH_Z ?? "").split(",").map((l) => l.trim().toLowerCase()).filter(Boolean);
  for (const l of pinned) if (!(MESH_LEGS as readonly string[]).includes(l)) fail(`NAV_MESH_Z names ${l}; the legs are ${MESH_LEGS.join(", ")}`);
  if (pinned.length === 0) {
    log(`optional mesh-z legs: not pinned; NAV_MESH_Z=${MESH_LEGS.join(",")} runs them`);
    return [];
  }
  const fixture: FixtureContext = {
    base: BASE,
    account: ACCOUNT,
    character: CHARACTER,
    token: smokeSubToken(TOKEN, "fixture"),
    log,
    fail,
    createAndLogout: async () => fail(`${CHARACTER} should exist: this run created it`),
  };
  const passed: MeshLeg[] = [];
  for (const name of pinned as MeshLeg[]) {
    const scenario = name === "kharanos" ? "nav-kharanos-floor" : "moonbrook-mine";
    await applyScenario(fixture, scenario);
    const leg: Leg = { token: smokeSubToken(TOKEN, `mesh-${name}`), events: [] };
    liveToken = leg.token;
    const legWs = await openEvents(leg);
    await Bun.sleep(200);
    const session = await req("POST", "/session", { token: leg.token, account: ACCOUNT, character: CHARACTER, race: 1, class: 1 });
    if (session.status !== 200 || !session.json?.inWorld) fail(`${name}: session failed: ${session.status} ${JSON.stringify(session.json)}`);
    const at = (await waitFor((e) => e.opcode === "SMSG_LOGIN_VERIFY_WORLD", 5000, "SMSG_LOGIN_VERIFY_WORLD", leg)).data;
    const want = SCENARIOS[scenario].position;
    if (at.map !== want.map || dist2d(at, want) > 8) fail(`${name}: scenario ${scenario} did not land: map ${at.map} (${at.x}, ${at.y}, ${at.z})`);
    leg.at = { x: at.x, y: at.y, z: at.z };
    if (name === "kharanos") {
      const r = await arrive(NAV_KHARANOS_JARVEN, "kharanos: the walk down the cellar stairs", 60000, leg);
      if (r.status !== "arrived") fail(`kharanos: the walk down the cellar stairs to Jarven should arrive, got ${JSON.stringify(r)}`);
      if (dist2d(r.pos, NAV_KHARANOS_JARVEN) > 4) fail(`kharanos: arrived ${dist2d(r.pos, NAV_KHARANOS_JARVEN).toFixed(1)}y from Jarven`);
      if (Math.abs(r.pos.z - NAV_KHARANOS_JARVEN.z) > 2) fail(`kharanos: arrived off the cellar floor: server z ${r.pos.z} vs ${NAV_KHARANOS_JARVEN.z}`);
      log(`PASS mesh-z kharanos -> arrived in the cellar at z ${r.pos.z.toFixed(1)}`);
    } else {
      // Into the Deadmines as deadmines-entry goes: one move of trigger 78's
      // centre is a transfer onto map 36. Then the walk to the leg's start.
      const { x, y, z } = DEADMINES_ENTRANCE_TRIGGER;
      const inbound = await move({ x, y, z }, 60000, leg);
      if (inbound.status !== "transferred") fail(`sneed: the move to trigger 78 should transfer onto map 36, got ${JSON.stringify(inbound)}`);
      await waitFor((e) => e.opcode === "SMSG_NEW_WORLD" && e.data?.map === 36, 20000, "SMSG_NEW_WORLD onto map 36", leg);
      await Bun.sleep(1500);
      const from = await walkThrough(SNEED_FROM, leg, "sneed: the walk to the leg's start");
      if (from.status !== "arrived") fail(`sneed: the walk to the leg's start ${JSON.stringify(SNEED_FROM)} should arrive within ${MESH_WALK_TRIES} tries, got ${JSON.stringify(from)}`);
      // The guard's verdict, the leg's whole assertion: dispatched, to the floor, on the route it always plans.
      const r = await move(SNEED_TO, 120000, leg);
      if (r.status === "drop" || r.pathLength === undefined) fail(`sneed: the move 4.8y over the corridor floor should be dispatched, not refused: ${JSON.stringify(r)}`);
      if (typeof r.meshZ !== "number" || Math.abs(r.meshZ - SNEED_FLOOR_Z) > 1.5) fail(`sneed: the move should resolve to the floor, meshZ ~${SNEED_FLOOR_Z}: ${JSON.stringify(r)}`);
      if (Math.abs(r.pathLength - SNEED_PATH_YARDS) > 10) fail(`sneed: the route to the corridor should be about ${SNEED_PATH_YARDS}y, got ${r.pathLength.toFixed(1)}y: ${JSON.stringify(r)}`);
      log(`PASS mesh-z sneed verdict -> dispatched to meshZ ${r.meshZ.toFixed(1)}, path ${r.pathLength.toFixed(1)}y`);
      // How the one walk ended, as information only (header).
      const hp = selfHealth(leg.events);
      log(
        `  sneed: the walk ended ${r.status}${r.pos ? ` at (${r.pos.x.toFixed(1)}, ${r.pos.y.toFixed(1)}, ${r.pos.z.toFixed(1)})` : ""}, health ${hp ?? "?"}` +
          (r.status === "arrived" ? "" : "; arrival not asserted: Deadmines trash on the route kills a smoke character"),
      );
    }
    const out = await req("DELETE", "/session", { token: leg.token });
    if (out.status !== 200 || !out.json?.ok) fail(`${name}: session delete failed: ${out.status} ${JSON.stringify(out.json)}`);
    legWs.close();
    passed.push(name);
  }
  return passed;
}

main().catch(failed);
