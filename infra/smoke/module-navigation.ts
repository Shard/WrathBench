/**
 * Probe for the navigation status vocabulary (FOLLOW-UPS item 38 N1).
 *
 * End to end against a booted worldserver, from inside the compose network:
 * session in world (Human in Northshire) -> a `move_to` whose z is 5y above
 * the ground arrives and reports `meshZ` (the mesh owns z) -> a `move_to`
 * whose z is 100y above the ground (far outside the navmesh's vertical poly
 * search) still arrives, with `meshZ` at the ground: the module's ground-z
 * fallback (FOLLOW-UPS 46 part 3) -> a `move_to` to a nearby NPC's position
 * with its `guid` arrives -> a candidate point with no walkable ground is
 * `target_off_mesh`, nothing moved -> a 300y request is `too_far` -> a
 * zero-length `move_to` (still at HOME) arrives -> a plain walk still arrives
 * with no `meshZ` -> (optional leg) a route off a ledge is `drop`, nothing
 * moved -> logout. No dependencies; Bun built-ins only.
 *
 * Steps 3–3b are new with the harness-0.4 module (FOLLOW-UPS 46) and FAIL
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
 * Not staged here, deliberately: `no_mesh` needs an unmapped map, and
 * `path_incomplete` / `start_off_mesh` need specific terrain (a transport
 * deck, a mesh gap) that Northshire does not offer on demand. Those two are
 * exercised by the travel gate (infra/smoke/travel.ts) where the tram
 * provides the deck. `WB_AREATRIGGER` is also the gate's: no DBC trigger lies
 * within 400y of either starter zone.
 *
 * Preflight-gate ready (ADR-0023 amendment, 2026-08-23): reads MODULE_ACCOUNT
 * the way the supervisor's spawnSmoke injects it, deletes last run's character
 * through the real CMSG_CHAR_DELETE path before creating this run's (the same
 * pattern as quest-accept-status.ts / kill-credit.ts), and only logs out at
 * the end — a disconnected character lingers 60s in the core's
 * WorldSession::expireTime, during which a delete is silently ignored.
 *
 * Run standalone (defaults to the PROBE account):
 *   docker compose -f infra/compose.yml exec runner bun infra/smoke/module-navigation.ts
 *
 * Override the target with MODULE_HOST / MODULE_PORT (default worldserver:8086)
 * and the login account with MODULE_ACCOUNT (default PROBE).
 */

const HOST = process.env.MODULE_HOST ?? "worldserver";
const PORT = process.env.MODULE_PORT ?? "8086";
const BASE = `http://${HOST}:${PORT}`;
const WS = `ws://${HOST}:${PORT}`;

// Session tokens must be at least 32 characters (POST /session rejects
// shorter ones with weak_token); randomUUID keeps them unguessable too.
const TOKEN = `probe-nav-${crypto.randomUUID()}`;
// Fixed name, deleted at the START of every run and only logged out at the
// end (see deletePreviousCharacter below). One name per script, so the
// leftover is always exactly one.
const CHARACTER = "Smokenav";
const ACCOUNT = process.env.MODULE_ACCOUNT ?? "PROBE";

function log(msg: string) {
  console.log(`[nav] ${msg}`);
}
function fail(msg: string): never {
  console.error(`[nav] FAIL: ${msg}`);
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
  } catch {
    /* ignore non-JSON */
  }
  return { status: res.status, json };
}

const events: any[] = [];

function openEvents(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS}/events?token=${encodeURIComponent(TOKEN)}`);
    ws.addEventListener("open", () => resolve(ws));
    ws.addEventListener("error", (e) => reject(new Error(`ws error: ${String(e)}`)));
    ws.addEventListener("message", (ev) => {
      try {
        events.push(JSON.parse(String(ev.data)));
      } catch {
        log(`event <- (unparseable) ${String(ev.data)}`);
      }
    });
  });
}

async function waitFor(pred: (e: any) => boolean, timeoutMs: number, what: string): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = events.find(pred);
    if (hit) return hit;
    if (Date.now() > deadline) fail(`timed out waiting for ${what}`);
    await Bun.sleep(100);
  }
}

const dist2d = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

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

/** Issue move_to and return the terminal WB_MOVE_RESULT data for it. */
async function move(target: { x: number; y: number; z: number; guid?: string }, timeoutMs = 60000): Promise<any> {
  const ack = await req("POST", "/action", { token: TOKEN, action: "move_to", ...target });
  if (ack.status !== 200 || !ack.json?.ok) fail(`move_to refused: ${ack.status} ${JSON.stringify(ack.json)}`);
  const result = await waitFor(
    (e) => e.opcode === "WB_MOVE_RESULT" && e.data?.moveId === ack.json.moveId,
    timeoutMs,
    `WB_MOVE_RESULT for moveId ${ack.json.moveId}`,
  );
  log(
    `move_to (${target.x.toFixed(1)}, ${target.y.toFixed(1)}, ${target.z.toFixed(1)}) -> ${result.data.status}` +
      (result.data.meshZ !== undefined ? ` meshZ=${result.data.meshZ.toFixed(1)}` : "") +
      (result.data.reachedPos ? ` reachedPos=${JSON.stringify(result.data.reachedPos)}` : "") +
      (result.data.dz !== undefined ? ` dz=${result.data.dz}` : ""),
  );
  return result.data;
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
  log(`in world at (${here.x.toFixed(1)}, ${here.y.toFixed(1)}, ${here.z.toFixed(1)}) map ${verify.data.map}`);

  // Two walkable landmarks ~37m apart (human start, abbey courtyard). A reused
  // character may be anywhere; walk home first so the legs below are fixed.
  const HOME = { x: -8949.95, y: -132.49, z: 83.53 };
  const COURTYARD = { x: -8913.2, y: -137.6, z: 80.9 };
  if (dist2d(here, HOME) > 10) {
    const home = await move(HOME, 120000);
    if (home.status !== "arrived") fail(`walk-home result ${JSON.stringify(home)}`);
    here = home.pos;
  }

  // 2. Wrong z, right x/y: the mesh owns z, within the navmesh's own vertical
  //    poly search. The module sets no extents of its own — it takes
  //    PathGenerator's default box — so the usable slack is single-digit
  //    yards, not the tens this probe once assumed. Measured at this exact
  //    point on 2026-08-23: +2 and +5 arrive with meshZ, +10 and +30 are
  //    target_off_mesh (+15/+20 come back path_incomplete off a nearby roof
  //    poly). See FOLLOW-UPS.
  const high = await move({ x: COURTYARD.x, y: COURTYARD.y, z: COURTYARD.z + 5 });
  if (high.status !== "arrived") fail(`z+5 request should arrive (mesh resolves z), got ${JSON.stringify(high)}`);
  if (dist2d(high.pos, COURTYARD) > 4) fail(`z+5 arrived ${dist2d(high.pos, COURTYARD).toFixed(1)}m from target`);
  if (typeof high.meshZ !== "number") fail(`z+5 arrival carries no meshZ: ${JSON.stringify(high)}`);
  // endpointOk is 2D only, so this is what keeps a rooftop poly from passing.
  if (Math.abs(high.meshZ - COURTYARD.z) > 3) fail(`meshZ ${high.meshZ} is not the courtyard ground (${COURTYARD.z})`);
  log(`PASS z+5 -> arrived with meshZ ${high.meshZ.toFixed(1)} (requested ${(COURTYARD.z + 5).toFixed(1)})`);

  // 3. Far outside the poly search box (±50y vertically): no polygon under the
  //    request's z. Until harness-0.4 this was target_off_mesh; the module now
  //    resolves the ground height at x,y after that verdict (the z-ladder in
  //    front of the cause ladder, FOLLOW-UPS 46 part 3: terrain a client has
  //    too) and walks there, reporting meshZ relative to the z asked for.
  const sky = await move({ x: HOME.x, y: HOME.y, z: HOME.z + 100 });
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
  const toNpc = await move({ x: npc.pos.x, y: npc.pos.y, z: npc.pos.z, guid: npc.guid });
  if (toNpc.status !== "arrived") fail(`move_to with guid ${npc.guid} should arrive, got ${JSON.stringify(toNpc)}`);
  if (dist2d(toNpc.pos, npc.pos) > 4) fail(`guid move arrived ${dist2d(toNpc.pos, npc.pos).toFixed(1)}m from the unit`);
  log(`PASS unit target (guid ${npc.guid}) -> arrived`);

  // 3b. A true off-mesh target still says so. Candidate: 12/12
  //     target_off_mesh in the 2026-08-22 trajectories from this valley. If
  //     it ARRIVES on the new module, the candidate's ground is walkable after
  //     all and the point must be replaced with one that is not (steep valley
  //     wall, inside a wall) — that is a probe defect, not a module one.
  const OFF_MESH = { x: -8897, y: 100, z: 98 };
  const walkBack = await move(HOME);
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
  const hop = await move(COURTYARD);
  if (hop.status !== "arrived") fail(`walk to the courtyard after too_far should arrive, got ${JSON.stringify(hop)}`);
  const back = await move(HOME);
  if (back.status !== "arrived") fail(`walk back should arrive, got ${JSON.stringify(back)}`);
  if (back.meshZ !== undefined) fail(`plain arrival should not carry meshZ: ${JSON.stringify(back)}`);
  log("PASS plain walk after the failures -> arrived, no meshZ");

  // 5b. OPTIONAL LEG — a route that steps off a ledge is `drop` (ADR-0027
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
    const stand = await move(HOME);
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
  const home2 = await move(HOME);
  if (home2.status !== "arrived") fail(`walk home after the ledge leg: ${JSON.stringify(home2)}`);

  // 6. Every status on the record is in the documented vocabulary.
  const VOCAB = new Set([
    "arrived", "too_far", "no_mesh", "target_off_mesh", "start_off_mesh", "path_incomplete",
    "drop", "transferred", "teleported", "interrupted", "stopped", "superseded",
  ]);
  const seen = new Set(events.filter((e) => e.opcode === "WB_MOVE_RESULT").map((e) => e.data?.status));
  for (const s of seen) if (!VOCAB.has(s)) fail(`undocumented move status on the stream: ${s}`);
  if (seen.has("no_path")) fail("undifferentiated no_path is still emitted");
  log(`statuses seen: ${[...seen].join(", ")}`);

  // 7. Logout.
  const del = await req("DELETE", "/session", { token: TOKEN });
  if (del.status !== 200 || !del.json?.ok) fail(`session delete failed: ${del.status} ${JSON.stringify(del.json)}`);
  ws.close();

  log(`PASS: meshZ arrival -> ground-z fallback -> unit target -> target_off_mesh -> too_far -> plain arrival -> drop leg ${dropSeen ? "PASS" : "optional/skipped"}; vocabulary clean`);
  process.exit(0);
}

main().catch((e) => fail(String(e?.stack ?? e)));
